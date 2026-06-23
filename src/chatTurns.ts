import { createProgressBus, createSerialRunner } from "./jobRunner.js";
import * as repo from "./repo.js";
import { buildChatPrompt, parseChatReply } from "./prompt.js";
import { runAgent, runAgentStreaming, agentSupportsStream, INTERACTIVE_TIMEOUT_MS } from "./agents.js";
import { createChatStreamFilter, type LiveReplyEvent } from "./chatStreamFilter.js";

// Background, in-process chat-turn engine — the durable counterpart to the
// enrichment queue. A chat turn is no longer a blocking request/response: the
// API persists the user message + a `chat_turns` row and hands the id here. This
// SERIAL worker (one CLI agent at a time, like enrich.ts) drains the queue,
// runs the coaching agent, applies the safe actions, writes the assistant
// chat_messages row, and links it back — emitting live progress on an event bus
// the SSE endpoint forwards. Because the turn lives in SQLite, a follow-up queued
// while the coach is thinking, or a turn interrupted by a tab switch / reload /
// restart, survives (the PWA rebuilds the in-flight thread from listActiveChatTurns).
//
// Degrades exactly like the rest of the loop: no enabled agent → the turn fails
// with a calm note (persisted as an assistant message), nothing throws.

// ---------- progress bus ----------
// One emitter, one event name per turn ("turn:<id>"). The SSE handler subscribes
// for the turn it's streaming; the worker emits a payload on every phase change
// and on the terminal transition. Late subscribers get the current state from a
// snapshot the SSE handler reads directly (repo.getChatTurn) — the bus is purely
// for live pushes.
export type TurnEvent =
  | { type: "phase"; turn: any }
  | LiveReplyEvent
  | { type: "done"; turn: any; message: any }
  | { type: "error"; turn: any; message: any }
  | { type: "canceled"; turn: any };

const turnBus = createProgressBus<TurnEvent>("turn");
function emit(id: number, payload: TurnEvent): void { turnBus.emit(id, payload); }
export function onTurnEvent(id: number, listener: (e: TurnEvent) => void): () => void {
  return turnBus.on(id, listener);
}

// ---------- serial queue ----------
// Live AbortControllers keyed by turn id, so a Stop can SIGKILL the running CLI.
// processChatTurn releases its own controller in a finally; the runner backstop
// below only records a failure that escaped processChatTurn's own handling.
const controllers = new Map<number, AbortController>();

const runner = createSerialRunner(processChatTurn, (id, e) => {
  // A failing turn must never break the loop. processChatTurn already persists its
  // own failure; this is the last-resort backstop.
  try {
    const cur = repo.getChatTurn(id) as any;
    if (cur && (cur.status === "queued" || cur.status === "running")) {
      const assistant = repo.addChatMessage("assistant", `Something went wrong: ${e?.message ?? e}`, null, { error: true });
      const failed = repo.failChatTurn(id, e?.message ?? String(e), (assistant as any).id);
      emit(id, { type: "error", turn: failed, message: assistant });
    }
  } catch { /* ignore */ }
  console.error(`[chat] turn#${id} failed: ${e?.message ?? e}`);
});

export function enqueueChatTurn(id: number): void {
  runner.enqueue(id);
}

async function processChatTurn(id: number): Promise<void> {
  const turn = repo.getChatTurn(id) as any;
  if (!turn || turn.status !== "queued") return; // canceled while queued, or already handled

  repo.markChatTurnRunning(id);
  emit(id, { type: "phase", turn: repo.getChatTurn(id) });

  // Build history from only what PRECEDED this turn's user message, so a follow-up
  // queued earlier in this same drain can't leak forward into an earlier turn's
  // prompt. buildChatPrompt slots turn.message into its own ATHLETE'S MESSAGE line.
  const beforeId = turn.user_message_id ?? Number.MAX_SAFE_INTEGER;
  const history = repo.listChatMessagesBefore(beforeId, 20).map((m: any) => ({
    role: m.role,
    content: m.content + (m.meta?.image ? " [photo attached]" : ""),
  }));
  const prompt = buildChatPrompt(
    history,
    turn.message || "(no text — see the attached photo)",
    turn.image_path || undefined,
  );

  const controller = new AbortController();
  controllers.set(id, controller);

  try {
    const { agent, raw } = await runChatCompletion(id, turn, prompt, controller.signal);
    const { reply: replyText, actions } = parseChatReply(raw);
    const reply = replyText || "(no reply)";

    repo.setChatTurnPhase(id, "applying");
    emit(id, { type: "phase", turn: repo.getChatTurn(id) });

    // A photo attached this turn becomes a food note WITH its image_path set — the
    // entry saves instantly, then a background VISION enrichment estimates the
    // plate's macros and upgrades it in place (the food-note poll/upgrade the PWA
    // already runs). This is the dedicated photo→macros capture path, decoupled
    // from whether the *chat* agent is itself vision-capable / streamed the reply.
    // When the chat agent DID see the photo and produced a log_food estimate, we
    // seed that note with it (so the instant entry already carries a first pass)
    // and skip the normal log_food application so the photo never double-logs.
    const photoFood = turn.image_path ? logPhotoFood(actions, turn) : null;

    const { applied, drafts } = applyChatActions(
      { actions },
      { agent, imagePath: turn.image_path, message: turn.message, skipLogFood: !!photoFood },
    );
    if (photoFood) applied.unshift({ type: "log_food", result: photoFood });
    const meta = {
      applied,
      drafts: drafts.map((d) => ({ id: d.id, kind: d.parsed?.days ? "restructure" : "plan_update", summary: d.parsed?.summary })),
    };
    const assistant = repo.addChatMessage("assistant", reply, agent, meta);
    const finished = repo.finishChatTurn(id, { reply, chosen_agent: agent, assistant_message_id: (assistant as any).id, meta });
    emit(id, { type: "done", turn: finished, message: assistant });
  } catch (e: any) {
    // Canceled mid-run: cancelTurn already flipped status + emitted the event.
    const cur = repo.getChatTurn(id) as any;
    if (cur?.status === "canceled" || controller.signal.aborted) return;
    const assistant = repo.addChatMessage("assistant", `Couldn't reach a coaching agent: ${e?.message ?? e}`, null, { error: true });
    const failed = repo.failChatTurn(id, e?.message ?? String(e), (assistant as any).id);
    emit(id, { type: "error", turn: failed, message: assistant });
  } finally {
    controllers.delete(id);
  }
}

// Create a food note for a photo turn, with image_path set, and enqueue the
// background VISION enrichment that estimates the plate's macros. The note saves
// INSTANTLY (the PWA shows it at once); the enrichment refines it in place. When
// the chat agent itself saw the photo and produced a log_food action, its estimate
// seeds the note's parsed blob so the instant entry already carries a first pass
// (the vision enrichment then confirms/refines and stamps from_photo). Returns the
// created note, or null if nothing was created (no image_path on the turn).
//
// Lazy import of enrich.js mirrors repo.addFoodNote: enrich.ts imports chatTurns
// is not a cycle today, but the lazy import keeps the queue trigger uniform with
// the rest of the loop and side-steps any future ordering surprise.
function logPhotoFood(actions: any[], turn: any) {
  if (!turn.image_path) return null;
  // Pull out any log_food the agent emitted (it saw the photo) to seed the note.
  const lf = (Array.isArray(actions) ? actions : []).find((a) => a?.type === "log_food");
  const message = (turn.message ?? "").toString();
  const parsedNote: Record<string, any> = {
    summary: (lf?.summary ?? lf?.name ?? (message.trim() || "meal")).toString(),
    items: Array.isArray(lf?.items) ? lf.items : undefined,
    kcal: lf?.kcal ?? null,
    protein_g: lf?.protein_g ?? null,
    carbs_g: lf?.carbs_g ?? null,
    fat_g: lf?.fat_g ?? null,
    fiber_g: lf?.fiber_g ?? null,
    notes: lf?.notes ?? null,
  };
  // raw="" so addFoodNote does NOT queue the TEXT enricher (that would overwrite the
  // vision estimate). We enqueue the dedicated food_photo job explicitly below.
  const meal = (lf?.meal ?? "meal").toString();
  let note: any = null;
  try {
    note = repo.addFoodNote(meal, "", parsedNote, turn.image_path);
  } catch (e: any) {
    console.error(`[chat] turn#${turn.id}: failed to create photo food note: ${e?.message ?? e}`);
    return null;
  }
  // Mark the note pending + enqueue the vision job — unless enrichment is off, in
  // which case the as-logged note (with the chat agent's first-pass estimate, if
  // any) simply stands, no background refine.
  try {
    if (repo.getSettings().enrich_enabled) {
      repo.setFoodNoteEnrichStatus(note.id, "pending");
      import("./enrich.js").then((m) => m.enqueueEnrich("food_photo", note.id)).catch(() => {});
    }
  } catch { /* settings unreadable → leave the note as-is */ }
  return note;
}

// Produce the raw assistant text for a turn, streaming when possible.
//
// The first agent in the (explicit or rotation) order STREAMS if it's capable
// (claude/grok) — emitting live `delta` events, sentinel-aware so the trailing
// actions JSON never reaches the bubble. Any failure (or a non-streaming first
// agent) falls back to a one-shot rotation. Chat's success criterion is NON-EMPTY
// TEXT — not parseable JSON — so it deliberately does NOT reuse the JSON-centric
// runAgentWithFallback (a pure-prose reply has no JSON and would be judged a
// failure there). Returns { agent, raw }; throws on abort or all-agents-failed.
async function runChatCompletion(
  id: number,
  turn: any,
  prompt: string,
  signal: AbortSignal,
): Promise<{ agent: string; raw: string }> {
  // Per-task routing: a "chat → claude" pin resolves an "auto"/blank turn to that
  // one enabled agent; an explicit turn.agent or an unrouted turn is unchanged.
  const chosen = repo.resolveAgentForTask("chat", turn.agent);
  const order: string[] = chosen && chosen !== "auto" ? [chosen] : repo.pickAgentOrder();
  if (!order.length) throw new Error("No agents enabled — turn one on in Settings.");

  // ---- streaming attempt on the first agent (live tokens) ----
  if (agentSupportsStream(order[0])) {
    const name = order[0];
    const started = Date.now();
    const stream = createChatStreamFilter((e) => emit(id, e));
    try {
      const res = await runAgentStreaming(name, prompt, {
        signal,
        timeoutMs: INTERACTIVE_TIMEOUT_MS,
        onProgress: stream.progress,
        onDelta: stream.push,
      });
      stream.finish();
      const raw = (res.raw ?? "").toString();
      try { repo.recordAgentRun({ op: "chat", agent: name, ok: !!raw.trim(), parsed: !!raw.trim(), latency_ms: Date.now() - started, tried_json: false }); } catch { /* telemetry never breaks the loop */ }
      if (raw.trim()) return { agent: name, raw };
    } catch (e: any) {
      if (signal.aborted) throw e; // Stop — propagate to the cancel path
      try { repo.recordAgentRun({ op: "chat", agent: name, ok: false, parsed: false, latency_ms: Date.now() - started, tried_json: false }); } catch { /* ignore */ }
      // streaming transport failed — fall through to the one-shot rotation
    }
    // Nothing usable streamed: clear any partial bubble before the one-shot retry,
    // then caption the retry so the reset doesn't wipe the visible progress line.
    stream.reset();
    stream.progress("Trying another route…");
  }

  // ---- one-shot rotation (text-based success criterion) ----
  let lastErr: any = null;
  for (const name of order) {
    if (signal.aborted) throw new Error("canceled");
    const started = Date.now();
    try {
      emit(id, { type: "progress", text: "Asking the coach…" });
      const res = await runAgent(name, prompt, { signal, timeoutMs: INTERACTIVE_TIMEOUT_MS });
      const raw = (res.raw ?? "").toString();
      const ok = !!raw.trim();
      try { repo.recordAgentRun({ op: "chat", agent: name, ok, parsed: !!res.parsed, latency_ms: Date.now() - started, tried_json: false }); } catch { /* ignore */ }
      if (ok) return { agent: name, raw };
      lastErr = new Error(`${name}: empty reply`);
    } catch (e: any) {
      if (signal.aborted) throw e;
      lastErr = e;
      try { repo.recordAgentRun({ op: "chat", agent: name, ok: false, parsed: false, latency_ms: Date.now() - started, tried_json: false }); } catch { /* ignore */ }
    }
  }
  throw lastErr || new Error("All agents failed to produce a reply");
}

// User-requested Stop. Flips the turn state first (so the worker's catch knows
// not to write an error reply), then aborts any live subprocess, then emits the
// terminal event. No-op if the turn already finished. Returns the turn or null.
export function cancelTurn(id: number) {
  const turn = repo.cancelChatTurn(id);
  if (!turn) return null;
  try { controllers.get(id)?.abort(); } catch { /* not running */ }
  emit(id, { type: "canceled", turn });
  return turn;
}

// Shutdown helper: abort every live chat subprocess so a redeploy/SIGTERM stops
// cleanly instead of orphaning CLIs. Durable recovery (recoverChatTurns) still
// re-handles any interrupted 'running' row on the next boot.
export function abortAllTurns() {
  for (const c of controllers.values()) {
    try { c.abort(); } catch { /* not running */ }
  }
}

// Crash recovery (boot): mark interrupted 'running' turns errored (their actions
// may have partially applied — re-running risks duplicates) and re-enqueue the
// 'queued' ones that never started. Mirrors recoverPendingEnrich.
export function recoverChatTurns(): { requeued: number; interrupted: number } {
  const { requeue, interrupted } = repo.recoverChatTurns();
  for (const id of requeue) enqueueChatTurn(id);
  if (requeue.length || interrupted) {
    console.log(`[chat] recovered ${requeue.length} queued + ${interrupted} interrupted turn(s).`);
  }
  return { requeued: requeue.length, interrupted };
}

// ---------- action application ----------
// Lifted verbatim from the old inline POST /api/chat handler so the worker is the
// single place chat actions are applied. Safe actions apply immediately; plan
// changes become DRAFT proposals (returned for the caller to summarize into meta).
// Each action is independently guarded — one bad action records its error and the
// rest still apply.
export function applyChatActions(
  parsed: any,
  ctx: { agent: string; imagePath?: string | null; message?: string | null; skipLogFood?: boolean },
): { applied: any[]; drafts: any[] } {
  const applied: any[] = [];
  const drafts: any[] = [];
  const message = ctx.message ?? "";
  for (const a of Array.isArray(parsed?.actions) ? parsed.actions : []) {
    try {
      switch (a.type) {
        case "log_activity":
          applied.push({ type: a.type, result: repo.addActivity({ text: a.text, date: a.date, notes: a.notes }) });
          break;
        case "log_set":
          applied.push({ type: a.type, result: repo.logSetByName(a) });
          break;
        case "set_profile":
          applied.push({ type: a.type, result: repo.setProfile(a) });
          break;
        case "set_endurance_goal": {
          // The endurance OBJECTIVE — applied through setProfile's endurance_goal
          // path (normalized/validated there). The action's own fields ARE the goal.
          const { type, ...goal } = a;
          applied.push({ type: a.type, result: repo.setProfile({ endurance_goal: goal }) });
          break;
        }
        case "add_memory":
          applied.push({ type: a.type, result: repo.addMemory(a.content, a.kind, "chat") });
          break;
        case "update_memory":
          // A fact CHANGED: edit the existing memory row in place (self-updating
          // memory — the agent saw the row id in DATA.memory and is correcting it).
          applied.push({ type: a.type, result: repo.updateMemory(Number(a.id), { content: a.content, kind: a.kind }) ?? { error: "not found", id: a.id } });
          break;
        case "supersede_memory":
          // A fact was CONTRADICTED/REPLACED: mark the old row superseded (never
          // hard-deleted), optionally with a replacement.
          applied.push({ type: a.type, result: repo.supersedeMemory(Number(a.id), { content: a.replacement, reason: a.reason }) ?? { error: "not found", id: a.id } });
          break;
        case "log_food": {
          // A photo turn already created the food note via logPhotoFood (with the
          // image_path + a background vision enrichment), and seeded it from THIS
          // same log_food estimate — applying it again here would double-log the
          // plate, so skip it. A text-only log_food (no photo) applies as before.
          if (ctx.skipLogFood) break;
          // The chat agent already produced the structured estimate (it saw the
          // photo), so store it directly with raw="" — a non-empty raw would queue
          // text-only background enrichment that overwrites this parse.
          const parsedNote = {
            summary: (a.summary ?? a.name ?? message ?? "meal").toString(),
            items: Array.isArray(a.items) ? a.items : undefined,
            ingredients: Array.isArray(a.ingredients) ? a.ingredients : undefined,
            kcal: a.kcal ?? null,
            protein_g: a.protein_g ?? null,
            carbs_g: a.carbs_g ?? null,
            fat_g: a.fat_g ?? null,
            fiber_g: a.fiber_g ?? null,
            notes: a.notes ?? null,
          };
          applied.push({ type: a.type, result: repo.addFoodNote(a.meal || "meal", "", parsedNote, ctx.imagePath ?? undefined) });
          break;
        }
        case "log_health": {
          // Lab/DEXA results reported in chat → a 'done' health record (no binary),
          // mirroring the MCP add_health_record path. Markers feed the trend view.
          const markers = Array.isArray(a.markers)
            ? a.markers
            : (a.parsed && Array.isArray(a.parsed.markers) ? a.parsed.markers : []);
          const parsedDoc = a.parsed && typeof a.parsed === "object"
            ? a.parsed
            : (markers.length ? { markers } : null);
          applied.push({ type: a.type, result: repo.addHealthDocument({
            kind: a.kind,
            doc_date: a.doc_date ?? null,
            summary: a.summary ?? null,
            parsed_json: parsedDoc,
            enrichment_status: "done",
          }) });
          // New markers from chat → refresh the deterministic markers→directives
          // propagation (idempotent), mirroring the enrichment path.
          try { repo.deriveDirectives(); } catch { /* never fail the chat action */ }
          break;
        }
        case "add_context_event":
          applied.push({ type: a.type, result: repo.addContextEvent({
            kind: a.kind, title: a.title, detail: a.detail,
            start_date: a.start_date, end_date: a.end_date, meta: a.meta,
          }) });
          break;
        case "log_supplement": {
          // Supplement UNDERSTANDING (not a daily log): the athlete mentioned what
          // they take. Prefer the agent's already-structured items (long tail); fall
          // back to deterministic free-text understanding (the KB approximates).
          if (Array.isArray(a.items) && a.items.length) {
            applied.push({ type: a.type, result: a.items.map((it: any) => repo.addSupplement(it)) });
          } else {
            applied.push({ type: a.type, result: repo.understandSupplements(a.text ?? a.summary ?? message) });
          }
          break;
        }
        case "plan_update":
          drafts.push(repo.createProposal(ctx.agent, "chat: plan update", "", { summary: a.summary, changes: a.changes }));
          break;
        case "plan_restructure":
          drafts.push(repo.createProposal(ctx.agent, "chat: restructure", "", { summary: a.summary, days: a.days }));
          break;
        default:
          break;
      }
    } catch (e: any) {
      applied.push({ type: a.type, error: e.message });
    }
  }
  return { applied, drafts };
}
