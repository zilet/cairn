import { createProgressBus, createSerialRunner } from "./jobRunner.js";
import * as repo from "./repo.js";
import { buildChatPrompt, parseChatReply, CHAT_ACTION_SENTINEL, CHAT_REPLY_SENTINEL } from "./prompt.js";
import { runAgent, runAgentStreaming, agentSupportsStream, INTERACTIVE_TIMEOUT_MS } from "./agents.js";

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
  | { type: "delta"; text: string }   // a live chunk of the streaming reply prose
  | { type: "reset" }                  // streaming attempt fell back — clear the partial bubble
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

    const { applied, drafts } = applyChatActions({ actions }, { agent, imagePath: turn.image_path, message: turn.message });
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
    // Emit only the prose: hold back a possible partial sentinel mid-stream, and
    // stop the moment the ===CAIRN_ACTIONS=== block begins (that JSON is internal).
    let acc = "";
    let emitted = 0;
    // Reply-marker aware: stream live from the start, but the moment the reply-start
    // marker arrives, clear whatever tool-step narration streamed before it (a `reset`)
    // and continue from the clean athlete-facing reply. Always holds back a forming
    // sentinel at the tail so a half-marker never flashes. The final reply is re-parsed
    // (and narration-stripped) on `done` regardless, so the persisted message is clean.
    let replyAt = -1;
    const TAIL = Math.max(CHAT_ACTION_SENTINEL.length, CHAT_REPLY_SENTINEL.length) - 1;
    const flush = (final: boolean) => {
      if (replyAt === -1) {
        const r = acc.indexOf(CHAT_REPLY_SENTINEL);
        if (r !== -1) {
          replyAt = r + CHAT_REPLY_SENTINEL.length;
          if (emitted > 0) emit(id, { type: "reset" }); // wipe any narration shown before the marker
          emitted = replyAt;
        }
      }
      const cut = acc.indexOf(CHAT_ACTION_SENTINEL, replyAt === -1 ? 0 : replyAt);
      let safeEnd: number;
      if (cut !== -1) safeEnd = cut;
      else if (final) safeEnd = acc.length;
      else safeEnd = Math.max(emitted, acc.length - TAIL);
      if (safeEnd > emitted) {
        emit(id, { type: "delta", text: acc.slice(emitted, safeEnd) });
        emitted = safeEnd;
      }
    };
    try {
      const res = await runAgentStreaming(name, prompt, {
        signal,
        timeoutMs: INTERACTIVE_TIMEOUT_MS,
        onDelta: (piece) => { acc += piece; flush(false); },
      });
      flush(true);
      const raw = (res.raw ?? "").toString();
      try { repo.recordAgentRun({ op: "chat", agent: name, ok: !!raw.trim(), parsed: !!raw.trim(), latency_ms: Date.now() - started, tried_json: false }); } catch { /* telemetry never breaks the loop */ }
      if (raw.trim()) return { agent: name, raw };
    } catch (e: any) {
      if (signal.aborted) throw e; // Stop — propagate to the cancel path
      try { repo.recordAgentRun({ op: "chat", agent: name, ok: false, parsed: false, latency_ms: Date.now() - started, tried_json: false }); } catch { /* ignore */ }
      // streaming transport failed — fall through to the one-shot rotation
    }
    // Nothing usable streamed: clear any partial bubble before the one-shot retry.
    emit(id, { type: "reset" });
  }

  // ---- one-shot rotation (text-based success criterion) ----
  let lastErr: any = null;
  for (const name of order) {
    if (signal.aborted) throw new Error("canceled");
    const started = Date.now();
    try {
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
  ctx: { agent: string; imagePath?: string | null; message?: string | null },
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
