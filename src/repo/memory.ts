import { db } from "../db.js";
import { localDateISO } from "./shared.js";
import { getSessionByDate, getWeeklyStats, sessionSummary } from "./sessions.js";

// ---------- memory (self-updating) ----------
// Memory is no longer a flat append-only log. A row can be RE-OBSERVED (its
// content refreshed, confidence bumped), SUPERSEDED by a newer row (marked, never
// hard-deleted — same discipline as chat archiving), and stamped when last
// surfaced to the coach. The conflict-aware update path generalizes the v26
// directive-feedback pattern (a new observation either reinforces or replaces a
// prior one) to free-text memory.


// Normalize for a forgiving similarity check (lowercase, drop punctuation,
// collapse whitespace) — shared by memory dedup and insight dedup. A handful of
// generic words are dropped (via memTokens) so "prefers training in the morning"
// and "trains mornings" overlap on the load-bearing tokens, not on filler.
const MEM_STOPWORDS = new Set("the a an and or to of in on for is are i im my me you your he she they it that this with at as be been being do does prefer prefers like likes".split(" "));
export function memNorm(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
function memTokens(s: string): Set<string> {
  return new Set(memNorm(s).split(" ").filter((w) => w && !MEM_STOPWORDS.has(w)));
}
// Jaccard word-overlap between two token sets (0..1). Shared by the memory
// near-dup fold (stopword-trimmed tokens) and the insight dedup guard.
export function jaccard(A: Set<string>, B: Set<string>): number {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}
// Jaccard word-overlap between two memory contents (0..1), stopword-trimmed.
function memOverlap(a: string, b: string): number {
  return jaccard(memTokens(a), memTokens(b));
}

// Add a durable memory. Three-tier dedup, strongest-first:
//   1. exact (case-insensitive) repeat → return the existing row, bump confidence
//   2. near-duplicate of a recent SAME-KIND live row (≥ MEM_DUP_THRESHOLD overlap)
//      → fold into it: refresh content to the longer/newer phrasing, advance
//        updated_at, raise confidence. We update in place instead of accumulating
//        near-identical noise — the headline self-updating behavior.
//   3. otherwise → insert a fresh row.
// Superseded rows are excluded from the near-dup comparison (they're history).
const MEM_DUP_THRESHOLD = 0.6;
export function addMemory(content: string, kind = "observation", source = "user") {
  const trimmed = (content ?? "").toString().trim();
  if (!trimmed) {
    // Nothing to remember — return the most recent live row as a harmless no-op
    // value so callers that read `.id` don't crash (matches prior truthy return).
    return db.prepare(`SELECT * FROM memory WHERE superseded_by IS NULL ORDER BY id DESC LIMIT 1`).get() ?? null;
  }
  // 1. exact repeat (any kind) — reinforce, never duplicate.
  const exact = db.prepare(`SELECT * FROM memory WHERE content = ? COLLATE NOCASE AND superseded_by IS NULL`).get(trimmed) as any;
  if (exact) {
    db.prepare(`UPDATE memory SET updated_at = datetime('now'), confidence = MIN(5, COALESCE(confidence,1) + 0.5) WHERE id = ?`).run(exact.id);
    return getMemory(exact.id);
  }
  // 2. semantic near-duplicate among recent same-kind live rows.
  const recent = db.prepare(
    `SELECT * FROM memory WHERE superseded_by IS NULL AND kind = ? ORDER BY id DESC LIMIT 60`
  ).all(kind) as any[];
  let best: any = null, bestScore = 0;
  for (const r of recent) {
    const score = memOverlap(trimmed, String(r.content ?? ""));
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (best && bestScore >= MEM_DUP_THRESHOLD) {
    // Fold in: keep the richer phrasing (longer wins, ties keep the new one),
    // advance updated_at, raise confidence. No new row.
    const keep = trimmed.length > String(best.content ?? "").length ? trimmed : String(best.content);
    db.prepare(`UPDATE memory SET content = ?, updated_at = datetime('now'), confidence = MIN(5, COALESCE(confidence,1) + 0.5) WHERE id = ?`).run(keep, best.id);
    return getMemory(best.id);
  }
  // 3. genuinely new fact.
  const info = db.prepare(`INSERT INTO memory (kind, content, source, confidence) VALUES (?, ?, ?, 1)`).run(kind, trimmed, source);
  return db.prepare(`SELECT * FROM memory WHERE id = ?`).get(info.lastInsertRowid);
}

// List memory, newest first. Superseded rows are HIDDEN by default (they're
// history kept for the curation UI / export, never surfaced to the coach);
// pass includeSuperseded for the full curate-able list.
export function listMemory(limit = 50, opts: { includeSuperseded?: boolean } = {}) {
  limit = Math.max(1, Math.min(500, Number(limit) || 50)); // clamp caller-supplied limit
  const where = opts.includeSuperseded ? "" : "WHERE superseded_by IS NULL";
  return db.prepare(`SELECT * FROM memory ${where} ORDER BY id DESC LIMIT ?`).all(limit);
}

export function getMemory(id: number) {
  return db.prepare(`SELECT * FROM memory WHERE id = ?`).get(id) ?? null;
}

export function updateMemory(id: number, patch: { content?: string; kind?: string; confidence?: number }) {
  const cur = getMemory(id) as any;
  if (!cur) return null;
  const conf = Number.isFinite(patch.confidence as number) ? Math.min(5, Math.max(0, Number(patch.confidence))) : cur.confidence;
  db.prepare(`UPDATE memory SET content = ?, kind = ?, confidence = ?, updated_at = datetime('now') WHERE id = ?`).run(
    patch.content != null ? String(patch.content).trim() : cur.content,
    patch.kind ?? cur.kind,
    conf,
    id
  );
  return getMemory(id);
}

// Mark a memory superseded by another row (we MARK, never destroy — the old fact
// stays in the DB and exports for an audit trail, just hidden from live reads).
// If replacementContent is given, a new row is created first and the old one
// points at it; otherwise the caller passes an existing replacementId.
export function supersedeMemory(id: number, replacement?: { content?: string; kind?: string; replacementId?: number; reason?: string }) {
  const cur = getMemory(id) as any;
  if (!cur) return null;
  let newId = replacement?.replacementId ?? null;
  let newRow: any = null;
  const content = replacement?.content ? String(replacement.content).trim() : "";
  if (!newId && content) {
    // addMemory may itself fold the replacement into an existing live row; use
    // whatever id it lands on as the supersedor (and never point a row at itself).
    newRow = addMemory(content, replacement?.kind ?? cur.kind, "supersede") as any;
    newId = newRow?.id ?? null;
  } else if (newId) {
    newRow = getMemory(newId);
  }
  if (newId && newId === id) newId = null; // a fold-into-self is just an update, not a supersession
  db.prepare(`UPDATE memory SET superseded_by = ?, updated_at = datetime('now') WHERE id = ?`).run(newId, id);
  return { superseded: getMemory(id), replacement: newRow };
}

export function deleteMemory(id: number) {
  return { deleted: db.prepare(`DELETE FROM memory WHERE id = ?`).run(id).changes };
}

// Stamp a set of memory ids as just-surfaced-to-the-coach (recency-of-reference,
// distinct from created_at/updated_at). Bounded and best-effort.
function touchMemoryReferenced(ids: number[]) {
  if (!ids?.length) return;
  const stmt = db.prepare(`UPDATE memory SET last_referenced_at = datetime('now') WHERE id = ?`);
  for (const id of ids.slice(0, 60)) { try { stmt.run(id); } catch { /* best effort */ } }
}

// Ranked retrieval for the coaching context. Instead of a raw recency dump, this
// ALWAYS includes the load-bearing kinds (constraint/injury/preference/decision/
// milestone/goal) — the durable person-model — PLUS the most recent observations,
// excludes superseded rows, and is bounded. Surfacing a memory stamps its
// last_referenced_at so the consolidation pass can tell live facts from stale ones.
export function memoryForCoach(limit = 40): any[] {
  const loadBearing = db.prepare(
    `SELECT * FROM memory
     WHERE superseded_by IS NULL AND kind IN ('constraint','injury','preference','decision','milestone','goal')
     ORDER BY COALESCE(confidence,1) DESC, COALESCE(updated_at, created_at) DESC, id DESC
     LIMIT ?`
  ).all(Math.max(8, Math.floor(limit * 0.7))) as any[];
  const seen = new Set(loadBearing.map((r) => r.id));
  const recent = db.prepare(
    `SELECT * FROM memory WHERE superseded_by IS NULL ORDER BY id DESC LIMIT ?`
  ).all(limit) as any[];
  const merged: any[] = [...loadBearing];
  for (const r of recent) {
    if (merged.length >= limit) break;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  const out = merged.slice(0, limit);
  touchMemoryReferenced(out.map((r) => r.id));
  return out;
}

// ---------- outcome learning (suggestions → actuals) ----------
// Record what a producer (the Brief / session-suggest / nutrition check-in)
// PROPOSED, so a quiet reconciliation pass can later compare it to what actually
// happened and learn the athlete's tendencies. Suggestion-not-a-gate: this never
// gates a future suggestion, it only seasons the coach context with learnings.
export type SuggestionKind = "day_read" | "session_suggest" | "nutrition_checkin";

export function recordSuggestion(kind: SuggestionKind, date: string | null, payload: any) {
  try {
    const info = db.prepare(
      `INSERT INTO suggestions (kind, date, payload_json) VALUES (?, ?, ?)`
    ).run(kind, date ?? null, payload != null ? JSON.stringify(payload).slice(0, 8000) : null);
    return db.prepare(`SELECT * FROM suggestions WHERE id = ?`).get(info.lastInsertRowid);
  } catch {
    return null; // recording an outcome is never allowed to break the producer
  }
}

function hydrateSuggestion(r: any) {
  if (!r) return null;
  let payload: any = null, outcome: any = null;
  try { payload = r.payload_json ? JSON.parse(r.payload_json) : null; } catch {}
  try { outcome = r.outcome_json ? JSON.parse(r.outcome_json) : null; } catch {}
  return { ...r, payload, outcome };
}

export function listSuggestions(limit = 50) {
  limit = Math.max(1, Math.min(500, Number(limit) || 50)); // clamp caller-supplied limit
  return (db.prepare(`SELECT * FROM suggestions ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(hydrateSuggestion);
}

// Durable learnings drawn from reconciliation are stored as memory rows of kind
// 'learning' (source 'outcome-learning'); surfaced to the coach via getCoachContext.
export function recentLearnings(limit = 6): { content: string; updated_at?: string }[] {
  return (db.prepare(
    `SELECT content, COALESCE(updated_at, created_at) AS updated_at FROM memory
     WHERE kind = 'learning' AND superseded_by IS NULL
     ORDER BY id DESC LIMIT ?`
  ).all(limit) as any[]).map((r) => ({ content: String(r.content), updated_at: r.updated_at }));
}

// Surface the outcome-learning store as a quiet "What Cairn has noticed" read (F2).
// Same rows recentLearnings feeds the coach, but with the id + a stamp the UI can
// show — gentle observations drawn from suggestion → actual reconciliation, never
// a score or a gate. Live (non-superseded) learnings only, newest-first. Returns
// { learnings:[{id, content, noticed_at}] } so the panel is a thin projection.
export interface OutcomeLearning { id: number; content: string; noticed_at: string | null }
export function getOutcomeLearnings(limit = 12): { learnings: OutcomeLearning[] } {
  const n = Math.max(1, Math.min(50, Number(limit) || 12));
  let learnings: OutcomeLearning[] = [];
  try {
    learnings = (db.prepare(
      `SELECT id, content, COALESCE(updated_at, created_at) AS noticed_at FROM memory
       WHERE kind = 'learning' AND superseded_by IS NULL
       ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ?`
    ).all(n) as any[]).map((r) => ({
      id: Number(r.id),
      content: String(r.content),
      noticed_at: r.noticed_at ? String(r.noticed_at) : null,
    }));
  } catch { /* memory table absent on a very old DB — empty */ }
  return { learnings };
}

// Reconcile suggestions whose date has passed and that aren't reconciled yet:
// compare suggestion → actual and, where there's a genuine, plain-language lesson,
// write ONE durable 'learning' memory. Deterministic & calm — no agent needed, no
// numeric scores surfaced, never a gate. Bounded per pass.
export function reconcileSuggestions(opts: { maxPerPass?: number } = {}): { reconciled: number; learnings: number } {
  const today = localDateISO();
  const max = Math.max(1, Math.min(40, opts.maxPerPass ?? 20));
  // Only reconcile suggestions whose target date is strictly in the past (so the
  // day's logging is settled) — never today's open suggestion.
  const rows = (db.prepare(
    `SELECT * FROM suggestions
     WHERE reconciled_at IS NULL AND date IS NOT NULL AND date < ?
     ORDER BY id ASC LIMIT ?`
  ).all(today, max) as any[]).map(hydrateSuggestion);
  let learnings = 0;
  for (const s of rows) {
    let outcome: any = null;
    let lesson: string | null = null;
    try {
      const r = reconcileOneSuggestion(s);
      outcome = r.outcome;
      lesson = r.lesson;
    } catch { outcome = { error: true }; }
    if (lesson) {
      // A learning is durable & curatable like any memory (it can be edited or
      // superseded by a later, contradicting learning).
      addMemory(lesson, "learning", "outcome-learning");
      learnings++;
    }
    db.prepare(`UPDATE suggestions SET outcome_json = ?, reconciled_at = datetime('now') WHERE id = ?`)
      .run(outcome != null ? JSON.stringify(outcome).slice(0, 8000) : null, s.id);
  }
  return { reconciled: rows.length, learnings };
}

// Compare ONE suggestion to what actually happened. Returns the recorded outcome
// blob plus an optional one-line lesson (null = nothing worth remembering — the
// calm, common answer). All comparisons are best-effort and null-safe.
function reconcileOneSuggestion(s: any): { outcome: any; lesson: string | null } {
  const date = String(s.date);
  const p = s.payload || {};
  if (s.kind === "day_read") {
    const sess = getSessionByDate(date) as any;
    const summary = sess ? sessionSummary(sess.id) : null;
    const trained = !!(summary && summary.sets > 0);
    const fb = sess ? { soreness: sess.soreness, performance: sess.performance, joint_pain: sess.joint_pain } : null;
    const outcome = { read_kind: p.kind ?? null, trained, sets: summary?.sets ?? 0, feedback: fb };
    // The interesting cross-grain case: the Brief protected rest, the athlete
    // trained anyway, and it went fine → they tolerate higher frequency than the
    // read assumed. Suggestion-not-a-gate, learned not enforced.
    if (p.kind === "rest" && trained) {
      // performance feedback is optional 1-tap (1-5). Only an EXPLICIT low score
      // (≤2) flips this to "the rest read was right"; null/absent means we don't
      // know it went badly, so the default learning is the higher-frequency one.
      const felt = fb?.performance == null ? null : Number(fb.performance);
      if (felt != null && Number.isFinite(felt) && felt <= 2) {
        return { outcome, lesson: `Suggested rest on ${date}; trained anyway and felt flat afterward — the earned-rest read was probably right.` };
      }
      return { outcome, lesson: `Suggested a rest day on ${date} but trained anyway and it went fine — tolerates higher training frequency than a 3-hard-days rule assumes.` };
    }
    if (p.kind === "train" && !trained) {
      return { outcome, lesson: null }; // a planned-but-skipped day is normal life, not a lesson
    }
    return { outcome, lesson: null };
  }
  if (s.kind === "session_suggest") {
    const sess = getSessionByDate(date) as any;
    const summary = sess ? sessionSummary(sess.id) : null;
    const suggestedMin = Number(p.est_minutes ?? p.minutes);
    const outcome = { suggested_minutes: Number.isFinite(suggestedMin) ? suggestedMin : null, trained: !!(summary && summary.sets > 0), sets: summary?.sets ?? 0, actual_minutes: sess?.duration_min ?? null };
    // Reserved for a future minutes-drift lesson; calm by default.
    return { outcome, lesson: null };
  }
  if (s.kind === "nutrition_checkin") {
    // Did the bodyweight trend move the way the check-in expected? Reuse the
    // existing weekly trend slope rather than recomputing.
    const stats = getWeeklyStats() as any;
    const trend = Number(stats?.trend_lb_wk);
    const expected = String(p.direction ?? (Number(p.target_kcal) && p.tdee && Number(p.target_kcal) < Number(p.tdee) ? "down" : ""));
    const outcome = { proposed_target_kcal: p.target_kcal ?? null, expected_direction: expected || null, trend_lb_wk: Number.isFinite(trend) ? trend : null };
    if (expected === "down" && Number.isFinite(trend) && trend > 0.2) {
      return { outcome, lesson: `Nutrition check-in on ${date} aimed for a deficit but bodyweight has drifted up since — the intake estimate may run low; lean toward the higher TDEE next time.` };
    }
    return { outcome, lesson: null };
  }
  return { outcome: null, lesson: null };
}

