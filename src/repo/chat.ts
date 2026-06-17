import crypto from "node:crypto";
import { db } from "../db.js";
import { addMemory } from "./memory.js";

// ---------- chat ----------
function hydrateChat(row: any) {
  if (!row) return row;
  let meta: any = null;
  try { meta = row.meta ? JSON.parse(row.meta) : null; } catch { meta = null; }
  // A draft's apply button is rendered from this meta on every load, but the
  // proposal lives on independently — once applied (here or from the proposals
  // list) the chat message must reflect that, not keep offering "Apply". Stamp
  // each draft with its CURRENT proposal status so the UI can show it applied.
  if (meta?.drafts?.length) {
    for (const d of meta.drafts) {
      if (d?.id == null) continue;
      const p = db.prepare(`SELECT status FROM plan_proposals WHERE id = ?`).get(d.id) as any;
      d.status = p?.status ?? "missing"; // 'missing' = proposal was deleted/never persisted
    }
  }
  return { ...row, meta };
}

export function addChatMessage(role: string, content: string, agent?: string | null, meta?: any) {
  const info = db
    .prepare(`INSERT INTO chat_messages (role, content, agent, meta) VALUES (?, ?, ?, ?)`)
    .run(role, content, agent ?? null, meta ? JSON.stringify(meta) : null);
  return hydrateChat(db.prepare(`SELECT * FROM chat_messages WHERE id = ?`).get(info.lastInsertRowid));
}

// One chat message by id, hydrated (drafts stamped with current proposal status).
// Used by the chat-turn SSE snapshot to deliver a finished turn's assistant row.
export function getChatMessage(id: number) {
  return hydrateChat(db.prepare(`SELECT * FROM chat_messages WHERE id = ?`).get(id));
}

// The live conversation: archived turns are excluded (they stay in the DB and
// in /api/export, but a "fresh start" or clear removes them from view).
export function listChatMessages(limit = 50) {
  const rows = db.prepare(`SELECT * FROM chat_messages WHERE archived_at IS NULL ORDER BY id DESC LIMIT ?`).all(limit) as any[];
  return rows.reverse().map(hydrateChat);
}

// "Fresh start" / clear both archive rather than delete: chat turns are part of
// the athlete's history and exports, so nothing is ever hard-deleted anymore.
export function archiveChat() {
  return { archived: db.prepare(`UPDATE chat_messages SET archived_at = datetime('now') WHERE archived_at IS NULL`).run().changes };
}

// Kept for the existing DELETE /api/chat surface; same archive semantics,
// same `{ cleared }` response shape callers already expect.
export function clearChat() {
  return { cleared: archiveChat().archived };
}

// Persist the durable facts an agent distilled out of a conversation being
// archived (chat reset). Type-coerced and clamped before write; addMemory
// dedupes exact repeats, so re-distilling the same fact is a no-op.
export function saveDistilledMemories(parsed: any) {
  const KINDS = new Set(["observation", "preference", "constraint", "decision", "injury", "milestone"]);
  const items = Array.isArray(parsed?.memories) ? parsed.memories : [];
  let saved = 0;
  for (const m of items.slice(0, 12)) {
    const content = (m?.content ?? "").toString().trim().slice(0, 300);
    if (!content) continue;
    const kind = KINDS.has(String(m?.kind)) ? String(m.kind) : "observation";
    addMemory(content, kind, "chat-distill");
    saved++;
  }
  return saved;
}

// Live conversation up to (and excluding) a given message id. The chat worker
// builds each turn's prompt from only what PRECEDED its user message, so a
// follow-up queued while the coach was still thinking can't leak backward into
// an earlier turn's context (turns drain serially, newest-queued last).
export function listChatMessagesBefore(beforeId: number, limit = 20) {
  const rows = db
    .prepare(`SELECT * FROM chat_messages WHERE archived_at IS NULL AND id < ? ORDER BY id DESC LIMIT ?`)
    .all(beforeId, limit) as any[];
  return rows.reverse().map(hydrateChat);
}

// ---------- chat turns (durable outbox + worker job state) ----------
// A chat turn is the unit the serial worker (src/chatTurns.ts) drains. Persisting
// it (not just holding the request open) is what makes a queued follow-up — or a
// turn interrupted by a tab switch / reload / restart — survive: the PWA rebuilds
// the in-flight + queued thread from listActiveChatTurns() on every (re)load.
function hydrateChatTurn(row: any) {
  if (!row) return row;
  let meta: any = null;
  try { meta = row.meta ? JSON.parse(row.meta) : null; } catch { meta = null; }
  // Stamp each draft with its CURRENT proposal status (mirrors hydrateChat) so a
  // turn snapshot reflects an applied/missing proposal, never a stale "Apply".
  if (meta?.drafts?.length) {
    for (const d of meta.drafts) {
      if (d?.id == null) continue;
      const p = db.prepare(`SELECT status FROM plan_proposals WHERE id = ?`).get(d.id) as any;
      d.status = p?.status ?? "missing";
    }
  }
  return { ...row, meta };
}

export function createChatTurn(t: {
  message?: string | null;
  image_path?: string | null;
  image_url?: string | null;
  agent?: string | null;
  user_message_id?: number | null;
}) {
  const info = db
    .prepare(`INSERT INTO chat_turns (status, phase, message, image_path, image_url, agent, user_message_id)
              VALUES ('queued', 'queued', ?, ?, ?, ?, ?)`)
    .run(t.message ?? null, t.image_path ?? null, t.image_url ?? null, t.agent ?? null, t.user_message_id ?? null);
  return getChatTurn(Number(info.lastInsertRowid));
}

export function getChatTurn(id: number) {
  return hydrateChatTurn(db.prepare(`SELECT * FROM chat_turns WHERE id = ?`).get(id));
}

// Active = not yet terminal, oldest-first. The worker drains in this order and
// the PWA reconstructs the live in-flight + queued thread from it.
export function listActiveChatTurns() {
  const rows = db
    .prepare(`SELECT * FROM chat_turns WHERE status IN ('queued','running') ORDER BY id ASC`)
    .all() as any[];
  return rows.map(hydrateChatTurn);
}

// queued → running (guarded so a canceled-while-queued turn is never picked up).
export function markChatTurnRunning(id: number) {
  db.prepare(`UPDATE chat_turns SET status='running', phase='running', started_at=datetime('now')
              WHERE id=? AND status='queued'`).run(id);
  return getChatTurn(id);
}

export function setChatTurnPhase(id: number, phase: string) {
  db.prepare(`UPDATE chat_turns SET phase=? WHERE id=? AND status='running'`).run(phase, id);
  return getChatTurn(id);
}

export function finishChatTurn(
  id: number,
  fields: { reply: string; chosen_agent?: string | null; assistant_message_id?: number | null; meta?: any }
) {
  db.prepare(`UPDATE chat_turns
                 SET status='done', phase='done', finished_at=datetime('now'),
                     reply=?, chosen_agent=?, assistant_message_id=?, meta=?
               WHERE id=?`)
    .run(
      (fields.reply ?? "").toString(),
      fields.chosen_agent ?? null,
      fields.assistant_message_id ?? null,
      fields.meta ? JSON.stringify(fields.meta) : null,
      id,
    );
  return getChatTurn(id);
}

export function failChatTurn(id: number, error: string, assistantMessageId?: number | null) {
  db.prepare(`UPDATE chat_turns
                 SET status='error', phase='error', finished_at=datetime('now'), error=?, assistant_message_id=?
               WHERE id=?`)
    .run((error ?? "").toString().slice(0, 1000), assistantMessageId ?? null, id);
  return getChatTurn(id);
}

// User-requested Stop. A queued turn just drops; a running turn is flipped here
// AND its live subprocess aborted by the worker (it polls status / holds the
// AbortController). Returns the turn, or null if it was already terminal.
export function cancelChatTurn(id: number) {
  const row = getChatTurn(id) as any;
  if (!row || !["queued", "running"].includes(row.status)) return null;
  db.prepare(`UPDATE chat_turns SET status='canceled', phase='canceled', finished_at=datetime('now') WHERE id=?`).run(id);
  return getChatTurn(id);
}

// Crash recovery (boot): a 'running' turn was interrupted mid-flight — its actions
// may have PARTIALLY applied, so re-running risks duplicate logs/proposals; mark
// it 'error' and drop a calm note into the thread so the orphaned question isn't
// silent. A 'queued' turn never started → safe to re-enqueue. Returns the queued
// ids for the worker to re-drain.
export function recoverChatTurns(): { requeue: number[]; interrupted: number } {
  const interrupted = db.prepare(`SELECT id FROM chat_turns WHERE status='running'`).all() as any[];
  for (const r of interrupted) {
    let amid: number | null = null;
    try {
      const msg = addChatMessage(
        "assistant",
        "That turn was interrupted by a restart — ask again if you still need it.",
        null,
        { error: true },
      );
      amid = (msg as any)?.id ?? null;
    } catch { /* never block recovery on the note */ }
    failChatTurn(r.id, "interrupted by a restart", amid);
  }
  const queued = db.prepare(`SELECT id FROM chat_turns WHERE status='queued' ORDER BY id ASC`).all() as any[];
  return { requeue: queued.map((r) => r.id), interrupted: interrupted.length };
}

// ---------- durable agent jobs (the generalized chat-turn spine) ----------
// One agent_jobs row tracks status/phase for a backgrounded agentic op. On done
// the worker records a thin pointer to the ALREADY-persisted result row
// (ref_table / ref_id) plus a thin result_json snapshot (the exact body the
// synchronous endpoint returned), never duplicating the heavy payload. Mirrors
// the chat-turn CRUD above.

// Resolve a job row's ref pointer to the live result. A `done` job carries the
// snapshot the sync endpoint returned in result_json; if it also points at a row
// (ref_table / ref_id) we return the snapshot as-is (it IS the contract body) —
// the pointer is there for provenance / future re-hydration, never overwriting
// the wire shape the client renders against.
function hydrateAgentJob(row: any): any {
  if (!row) return null;
  let input: any = null;
  try { input = row.input_json ? JSON.parse(row.input_json) : null; } catch { input = null; }
  let result: any = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { result = null; }
  let meta: any = null;
  try { meta = row.meta ? JSON.parse(row.meta) : null; } catch { meta = null; }
  const out: any = { ...row, input, meta };
  delete out.input_json;
  delete out.result_json;
  // chat_distill carries the full pre-archive conversation in input_json so the
  // worker can distill it — the CLIENT never needs it, so don't echo that blob
  // back through the active-jobs list or the SSE snapshot. The worker reads the
  // untrimmed history via getAgentJobRawInput().
  if (out.input && out.input.history) delete out.input.history;
  // The hydrated `result` is only present on a terminal job (done carries the
  // contract body; error/canceled carry whatever was recorded, usually null).
  if (result !== null) out.result = result;
  return out;
}

export function createAgentJob(j: {
  kind: string;
  input?: any;
  agent?: string | null;
  phase?: string | null;
}) {
  const info = db
    .prepare(`INSERT INTO agent_jobs (status, kind, phase, input_json, agent)
              VALUES ('queued', ?, ?, ?, ?)`)
    .run(
      String(j.kind),
      j.phase ?? "queued",
      j.input != null ? JSON.stringify(j.input) : null,
      j.agent ?? null,
    );
  return getAgentJob(Number(info.lastInsertRowid));
}

export function getAgentJob(id: number) {
  return hydrateAgentJob(db.prepare(`SELECT * FROM agent_jobs WHERE id = ?`).get(id));
}

// The worker's full, un-sanitized input — hydrateAgentJob strips heavy
// client-irrelevant fields (chat_distill's `history`), so the worker reads the
// raw input_json here instead. Internal use only.
export function getAgentJobRawInput(id: number): any {
  const row = db.prepare(`SELECT input_json FROM agent_jobs WHERE id = ?`).get(id) as any;
  if (!row || !row.input_json) return null;
  try { return JSON.parse(row.input_json); } catch { return null; }
}

// Active = not yet terminal, oldest-first — the worker drains in this order and
// the PWA reconstructs the live in-flight + queued jobs from it on (re)load.
export function listActiveAgentJobs() {
  const rows = db
    .prepare(`SELECT * FROM agent_jobs WHERE status IN ('queued','running') ORDER BY id ASC`)
    .all() as any[];
  return rows.map(hydrateAgentJob);
}

// queued → running (guarded so a canceled-while-queued job is never picked up).
export function markAgentJobRunning(id: number) {
  db.prepare(`UPDATE agent_jobs SET status='running', phase='running', started_at=datetime('now')
              WHERE id=? AND status='queued'`).run(id);
  return getAgentJob(id);
}

// Update the live progress phase (+ optional determinate meta) of a running job.
export function setAgentJobPhase(id: number, phase: string, meta?: any) {
  if (meta !== undefined) {
    db.prepare(`UPDATE agent_jobs SET phase=?, meta=? WHERE id=? AND status='running'`)
      .run(phase, meta != null ? JSON.stringify(meta) : null, id);
  } else {
    db.prepare(`UPDATE agent_jobs SET phase=? WHERE id=? AND status='running'`).run(phase, id);
  }
  return getAgentJob(id);
}

export function finishAgentJob(
  id: number,
  fields: { result?: any; chosen_agent?: string | null; ref_table?: string | null; ref_id?: number | null; cache_key?: string | null }
) {
  db.prepare(`UPDATE agent_jobs
                 SET status='done', phase='done', finished_at=datetime('now'),
                     result_json=?, chosen_agent=?, ref_table=?, ref_id=?, cache_key=?
               WHERE id=?`)
    .run(
      fields.result !== undefined ? JSON.stringify(fields.result) : null,
      fields.chosen_agent ?? null,
      fields.ref_table ?? null,
      fields.ref_id ?? null,
      fields.cache_key ?? null,
      id,
    );
  return getAgentJob(id);
}

export function failAgentJob(id: number, error: string) {
  db.prepare(`UPDATE agent_jobs
                 SET status='error', phase='error', finished_at=datetime('now'), error=?
               WHERE id=?`)
    .run((error ?? "").toString().slice(0, 1000), id);
  return getAgentJob(id);
}

// User-requested Stop. A queued job just drops; a running job is flipped here AND
// its live subprocess aborted by the worker (which holds the AbortController).
// Returns the job, or null if it was already terminal.
export function cancelAgentJob(id: number) {
  const row = getAgentJob(id) as any;
  if (!row || !["queued", "running"].includes(row.status)) return null;
  db.prepare(`UPDATE agent_jobs SET status='canceled', phase='canceled', finished_at=datetime('now') WHERE id=?`).run(id);
  return getAgentJob(id);
}

// Crash recovery (boot): a 'running' job was interrupted mid-flight — its coachOp
// may have PARTIALLY persisted a draft, so re-running risks a duplicate; mark it
// 'error'. A 'queued' job never started → safe to re-enqueue. Returns the queued
// ids for the worker to re-drain. Mirrors recoverChatTurns.
export function recoverAgentJobs(): { requeue: number[]; interrupted: number } {
  // Retention: terminal job rows are pure telemetry once read — prune anything
  // finished >30 days ago so agent_jobs never grows unbounded (mirrors the
  // ai_cache 30-day discipline; the rows are ephemeral + regenerable).
  db.prepare(`DELETE FROM agent_jobs WHERE status IN ('done','error','canceled')
                AND finished_at IS NOT NULL AND finished_at < datetime('now','-30 days')`).run();
  const interrupted = db.prepare(`SELECT id FROM agent_jobs WHERE status='running'`).all() as any[];
  for (const r of interrupted) failAgentJob(r.id, "interrupted by a restart");
  const queued = db.prepare(`SELECT id FROM agent_jobs WHERE status='queued' ORDER BY id ASC`).all() as any[];
  return { requeue: queued.map((r) => r.id), interrupted: interrupted.length };
}

// ---------- AI result cache (serve-stale-then-revalidate) ----------
// A stable fingerprint over an idempotent op's normalized inputs (+ a coarse
// context stamp) keyed to the parsed result it produced. sha1 like art.ts's
// cacheKey; key inputs are JSON-canonicalized so equal inputs always fingerprint
// the same. Regenerable — safe to drop.
export function fingerprint(parts: any): string {
  const canonical = (v: any): any => {
    if (v == null) return null;
    if (Array.isArray(v)) return v.map(canonical);
    if (typeof v === "object") {
      const out: any = {};
      for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
      return out;
    }
    return v;
  };
  return crypto.createHash("sha1").update(JSON.stringify(canonical(parts))).digest("hex");
}

export interface AiCacheHit {
  result: any;
  chosen_agent: string | null;
  ref_table: string | null;
  ref_id: number | null;
  computed_at: string;
  stale: boolean;        // true → still served, but a fresh compute should run in the background
}

export function getAiCache(kind: string, cacheKey: string): AiCacheHit | null {
  const row = db.prepare(`SELECT * FROM ai_cache WHERE kind = ? AND cache_key = ?`).get(kind, cacheKey) as any;
  if (!row) return null;
  let result: any = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { result = null; }
  if (result == null) return null;
  // Stale boundary: stale_after is a UTC "now"-comparable stamp; past it the hit
  // is still served (instant) but flagged so the caller can revalidate.
  const staleRow = db.prepare(`SELECT (stale_after IS NOT NULL AND stale_after < datetime('now')) AS stale FROM ai_cache WHERE kind=? AND cache_key=?`).get(kind, cacheKey) as any;
  return {
    result,
    chosen_agent: row.chosen_agent ?? null,
    ref_table: row.ref_table ?? null,
    ref_id: row.ref_id ?? null,
    computed_at: row.computed_at,
    stale: !!staleRow?.stale,
  };
}

export function saveAiCache(
  kind: string,
  cacheKey: string,
  fields: { result: any; chosen_agent?: string | null; ref_table?: string | null; ref_id?: number | null; freshForMs?: number }
): void {
  if (!kind || !cacheKey || fields.result == null) return;
  const freshForMs = Number.isFinite(fields.freshForMs as number) ? (fields.freshForMs as number) : 6 * 60 * 60 * 1000;
  const staleAfter = new Date(Date.now() + freshForMs).toISOString().slice(0, 19).replace("T", " ");
  db.prepare(
    `INSERT INTO ai_cache (kind, cache_key, ref_table, ref_id, result_json, chosen_agent, computed_at, stale_after)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(kind, cache_key) DO UPDATE SET
       ref_table=excluded.ref_table, ref_id=excluded.ref_id, result_json=excluded.result_json,
       chosen_agent=excluded.chosen_agent, computed_at=excluded.computed_at, stale_after=excluded.stale_after`
  ).run(
    kind, cacheKey, fields.ref_table ?? null, fields.ref_id ?? null,
    JSON.stringify(fields.result), fields.chosen_agent ?? null, staleAfter,
  );
  // Keep the cache bounded — old rows are never served past their staleness.
  try { db.prepare(`DELETE FROM ai_cache WHERE computed_at < datetime('now','-30 days')`).run(); } catch {}
}

// ---------- chat history (read-only browse + search over archived turns) ----------
// Each "fresh start" stamps the live turns with one shared archived_at, so a
// past conversation IS the set of rows sharing an archived_at. Group them into
// browsable sessions, newest first, each with a one-line preview.
export function listArchivedSessions(limit = 50) {
  const rows = db.prepare(`
    SELECT m.archived_at,
           COUNT(*)          AS count,
           MIN(m.created_at) AS started_at,
           MAX(m.created_at) AS ended_at,
           (SELECT content FROM chat_messages p
             WHERE p.archived_at = m.archived_at AND p.role = 'user'
               AND p.content <> '' AND p.content <> '(photo)'
             ORDER BY p.id ASC LIMIT 1) AS preview
    FROM chat_messages m
    WHERE m.archived_at IS NOT NULL
    GROUP BY m.archived_at
    ORDER BY m.archived_at DESC
    LIMIT ?`).all(Math.min(200, Math.max(1, limit))) as any[];
  return rows.map((r) => ({
    archived_at: r.archived_at, count: r.count, started_at: r.started_at, ended_at: r.ended_at,
    preview: (r.preview ?? "").toString().replace(/\s+/g, " ").trim().slice(0, 120),
  }));
}

// One archived conversation, chronological, hydrated like the live list.
export function getArchivedConversation(archivedAt: string) {
  const rows = db.prepare(`SELECT * FROM chat_messages WHERE archived_at = ? ORDER BY id ASC`).all(archivedAt) as any[];
  return rows.map(hydrateChat);
}

// Keyword search across the whole history (live + archived). Each hit carries
// its session key (archived_at, or null for the live thread) and a short
// snippet centered on the match, so the UI can jump straight to the source.
export function searchChatMessages(q: string, limit = 40) {
  const query = (q ?? "").toString().trim();
  if (!query) return [];
  const like = "%" + query.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const rows = db.prepare(`
    SELECT * FROM chat_messages
    WHERE content LIKE ? ESCAPE '\\'
    ORDER BY id DESC LIMIT ?`).all(like, Math.min(200, Math.max(1, limit))) as any[];
  const lower = query.toLowerCase();
  return rows.map((r) => {
    const m = hydrateChat(r);
    const content = (m.content ?? "").toString();
    const idx = content.toLowerCase().indexOf(lower);
    let snippet = content.replace(/\s+/g, " ").trim();
    if (idx > 60) snippet = "…" + content.slice(Math.max(0, idx - 40)).replace(/\s+/g, " ").trim();
    return { id: m.id, role: m.role, created_at: m.created_at, archived_at: m.archived_at ?? null, snippet: snippet.slice(0, 160) };
  });
}

