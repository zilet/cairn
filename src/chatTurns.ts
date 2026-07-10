import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createProgressBus, createSerialRunner } from "./jobRunner.js";
import * as repo from "./repo.js";
import { UPLOADS_DIR } from "./uploadPaths.js";
import { buildChatPrompt, parseChatReply } from "./prompt.js";
import { chatHistoryTimeLabel } from "./repo/shared.js";
import { runWithTimeZone } from "./tz.js";
import {
  runAgent,
  runAgentStreaming,
  agentSupportsStream,
  INTERACTIVE_TIMEOUT_MS,
  type AgentResult,
} from "./agents.js";
import { createChatStreamFilter, type LiveReplyEvent } from "./chatStreamFilter.js";
import type { MemoryKind } from "./repo/memory.js";
import { normalizeChatActions, type ChatAction, type ChatActionType, type LogFoodAction } from "./chatActions.js";
import { applyProposalWithAutonomy, revertDecision } from "./domain/brain/autonomy-service.js";
import { diagnosticErrorName, recordAsyncFailure } from "./diagnostics.js";

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

// Live streaming filters keyed by turn id, so the SSE snapshot (and the poll
// fallback) can hand a reconnecting client the reply prose streamed so far. iOS
// standalone kills the EventSource on backgrounding; without this, the reconnect
// snapshot carried no partial text and the bubble came back hollow. Set while a
// turn streams, cleared when the turn goes terminal (processChatTurnInner finally).
const streamFilters = new Map<number, ReturnType<typeof createChatStreamFilter>>();
export function getTurnPartialReply(id: number): string {
  try { return streamFilters.get(id)?.reply() ?? ""; } catch { return ""; }
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
      const assistant = repo.addChatMessage("assistant", "Something went wrong while finishing that turn.", null, { error: true });
      const failed = repo.failChatTurn(id, e?.message ?? String(e), (assistant as any).id);
      emit(id, { type: "error", turn: failed, message: assistant });
    }
  } catch { /* ignore */ }
  recordAsyncFailure("chat_turns", "runner_backstop", e);
  console.error(`[chat] turn#${id} failed (${diagnosticErrorName(e)})`);
});

export function enqueueChatTurn(id: number): void {
  runner.enqueue(id);
}

async function processChatTurn(id: number): Promise<void> {
  const turn = repo.getChatTurn(id) as any;
  if (!turn || turn.status !== "queued") return; // canceled while queued, or already handled
  // Re-establish the device timezone captured at enqueue — the worker drains
  // AFTER the request returned, so X-Cairn-TZ is no longer in scope. With it,
  // "now", the chat-history time labels, and any day-keyed log this turn writes
  // (log_food / log_activity) all frame in the athlete's actual zone.
  await runWithTimeZone(turn.tz, () => processChatTurnInner(id, turn));
}

async function processChatTurnInner(id: number, turn: any): Promise<void> {
  repo.markChatTurnRunning(id);
  emit(id, { type: "phase", turn: repo.getChatTurn(id) });

  // Build history from only what PRECEDED this turn's user message, so a follow-up
  // queued earlier in this same drain can't leak forward into an earlier turn's
  // prompt. buildChatPrompt slots turn.message into its own ATHLETE'S MESSAGE line.
  const beforeId = turn.user_message_id ?? Number.MAX_SAFE_INTEGER;
  // Stamp each prior turn with a short relative time label ("this morning" reads
  // as "8:12 AM", a past day as "yesterday 9:40 PM") so the agent can tell a stale
  // thread from a fresh one — otherwise the history is timestamp-less and it
  // re-asks about things already covered hours ago.
  const history = repo.listChatMessagesBefore(beforeId, 20).map((m: any) => ({
    role: m.role,
    content: m.content + (m.meta?.image ? " [photo attached]" : ""),
    at: chatHistoryTimeLabel(m.created_at),
  }));
  const prompt = buildChatPrompt(
    history,
    turn.message || "(no text — see the attached photo)",
    turn.image_path || undefined,
  );

  const controller = new AbortController();
  controllers.set(id, controller);

  try {
    const { agent, raw, attempts } = await runChatCompletion(id, turn, prompt, controller.signal);
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

    const { applied, drafts, labConfirms } = applyChatActions(
      { actions },
      { agent, imagePath: turn.image_path, message: turn.message, skipLogFood: !!photoFood },
    );
    if (photoFood) applied.unshift({ type: "log_food", result: photoFood });
    const failedAttempts = attempts.filter((a) => !a.ok);
    const meta: {
      applied: typeof applied;
      drafts: unknown[];
      lab_confirms?: typeof labConfirms;
      agent_attempts?: ChatAgentAttempt[];
    } = {
      applied,
      drafts: drafts.map(proposalMeta),
    };
    // A substantial pasted lab awaits one-tap confirmation before it writes to Health.
    if (labConfirms.length) meta.lab_confirms = labConfirms;
    if (failedAttempts.length) meta.agent_attempts = attempts;
    const assistant = repo.addChatMessage("assistant", reply, agent, meta);
    const finished = repo.finishChatTurn(id, { reply, chosen_agent: agent, assistant_message_id: (assistant as any).id, meta });
    emit(id, { type: "done", turn: finished, message: assistant });
  } catch (e: any) {
    // Canceled mid-run: cancelTurn already flipped status + emitted the event.
    const cur = repo.getChatTurn(id) as any;
    if (cur?.status === "canceled" || controller.signal.aborted) return;
    const failure = chatFailureReply(e);
    const assistant = repo.addChatMessage("assistant", failure.content, failure.agent, failure.meta);
    const failed = repo.failChatTurn(id, failure.error, (assistant as any).id);
    recordAsyncFailure("chat_turns", "completion", e);
    emit(id, { type: "error", turn: failed, message: assistant });
  } finally {
    controllers.delete(id);
    streamFilters.delete(id);
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
const PHOTO_FOOD_HINT_RE = /\b(food|meal|breakfast|lunch|dinner|snack|plate|bowl|ate|eating|calor(?:y|ies)|macro|protein|carb|fat|fiber|weigh(?:ed)?|grams?|oz|serving|portion|recipe|restaurant|label|packag(?:e|ing)|menu)\b/i;
const PHOTO_NON_FOOD_HINT_RE = /\b(physique|body|mirror|pose|form|equipment|bike|run|shoe|injur(?:y|ed)?|pain|dexa|scan|lab|blood|chart|screenshot)\b/i;

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function memoryKind(value: unknown): MemoryKind | undefined {
  return typeof value === "string" && value.trim() ? value as MemoryKind : undefined;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function proposalMeta(draft: unknown): { id: unknown; kind: "restructure" | "plan_update"; summary: unknown } {
  const row = recordOrNull(draft) ?? {};
  const parsed = recordOrNull(row.parsed);
  return {
    id: row.id,
    kind: parsed && Array.isArray(parsed.days) ? "restructure" : "plan_update",
    summary: parsed?.summary,
  };
}

export function shouldCreatePhotoFoodPlaceholder(message: string | null | undefined): boolean {
  const s = (message ?? "").toString().trim();
  if (!s) return true; // photo-only in Chat means "estimate/log this plate" by default
  if (PHOTO_FOOD_HINT_RE.test(s)) return true;
  if (PHOTO_NON_FOOD_HINT_RE.test(s)) return false;
  return false;
}

// A meal is useful recovery/fuel context, but it is not by itself evidence that a
// lift should change. This backstop prevents an overreaching chat model from
// turning a food capture into a surprise training intervention. If the athlete
// also reports a training, recovery, pain, or life signal, the targeted coaching
// path remains available.
const FOOD_TURN_RE = /\b(food|meal|breakfast|lunch|dinner|snack|plate|bowl|salad|chicken|restaurant|cafe|café|ate|eating|calor(?:y|ies)|macro|protein|carb|fat|fiber|portion|recipe|menu)\b/i;
const TRAINING_SIGNAL_RE = /\b(workout|train(?:ing|ed)?|lift(?:ing|ed)?|session|exercise|bench|squat|deadlift|press|row|run|ride|cycle|pain|sore|soreness|injur(?:y|ed)|recovery|sleep|hrv|fatigue|travel|trip|ill|sick)\b/i;
export function isFoodOnlyTurn(message: string | null | undefined, imagePath?: string | null): boolean {
  const text = String(message ?? "");
  return (Boolean(imagePath) || FOOD_TURN_RE.test(text)) && !TRAINING_SIGNAL_RE.test(text);
}

const GOAL_IDENTITY_FIELDS = new Set([
  "goal_weight_lb",
  "goal_bodyfat_pct",
  "goal_date",
  "goal_mode",
  "primary_discipline",
  "endurance_sport",
  "endurance_goal",
]);

// Identity-level goals must come from an explicit athlete statement, never from
// a coach inference or an answer to a "what should my goal be?" question.
export function hasExplicitGoalIntent(message: string | null | undefined): boolean {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (/\b(?:what|which)\b.{0,30}\b(?:goal|target)\b|\b(?:should|could|would)\s+i\b.{0,30}\b(?:goal|target|weigh|train|run|race)\b/i.test(text))
    return false;
  return (
    /\bmy\s+(?:new\s+)?goal\s+(?:is|will be)\b/i.test(text) ||
    /\b(?:set|change|update)\s+(?:my\s+)?(?:goal|target|discipline)\b/i.test(text) ||
    /\bi\s+(?:want|plan|aim|intend|am going)\s+to\b.{0,80}\b(?:weigh|lose|gain|maintain|run|race|train|lift|cycle|ride|swim|complete|finish)\b/i.test(text) ||
    /\b(?:train(?:ing)?\s+for|signed?\s+up\s+for|keep\s+me\b.{0,40}\bready)\b/i.test(text)
  );
}

function applyBackgroundPlanUpdate(agent: string, summary: unknown, changes: unknown[]): unknown {
  const proposal = repo.createProposal(agent, "background: chat signal", "", {
    summary: String(summary ?? "Plan adjusted from a new coaching signal.").slice(0, 500),
    changes,
  });
  // Route every background adjustment through the ONE autonomy policy. Lead mode
  // may quietly apply a small reversible change; announce/review modes leave it
  // waiting. The shared proposal path still owns all server-side clamps.
  const result = applyProposalWithAutonomy((proposal as any).id, { requested_tier: "quiet_apply" }) as any;
  return { background: true, proposal_id: (proposal as any).id, ...result };
}

function logPhotoFood(actions: ChatAction[], turn: any): { id: number; [key: string]: unknown } | null {
  if (!turn.image_path) return null;
  // Pull out any log_food the agent emitted (it saw the photo) to seed the note.
  const lf = actions.find((a): a is LogFoodAction => a.type === "log_food");
  const message = (turn.message ?? "").toString();
  if (!lf && !shouldCreatePhotoFoodPlaceholder(message)) return null;
  const parsedNote: Record<string, unknown> = {
    summary: (lf?.summary ?? lf?.name ?? (message.trim() || "Photo meal")).toString(),
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
  let note: { id: number; [key: string]: unknown } | null = null;
  try {
    const created = repo.addFoodNote(meal, "", parsedNote, turn.image_path);
    const row = recordOrNull(created);
    note = row && typeof row.id === "number" ? row as { id: number; [key: string]: unknown } : null;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[chat] turn#${turn.id}: failed to create photo food note: ${message}`);
    return null;
  }
  if (!note) return null;
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
const EMPTY_CHAT_RETRY_SUFFIX =
  "\n\nYour previous attempt exited without any assistant text. " +
  "Try once more now. Follow the same Cairn reply contract and produce the athlete-facing reply.";

export type ChatAgentAttempt = {
  agent: string;
  ok: boolean;
  status: string;
  error_class?: string | null;
  error_message?: string | null;
  latency_ms?: number | null;
  exit_code?: number | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
};

class ChatCompletionError extends Error {
  attempts: ChatAgentAttempt[];
  lastAgent: string | null;

  constructor(attempts: ChatAgentAttempt[], message?: string) {
    super(message || summarizeChatAttempts(attempts));
    this.name = "ChatCompletionError";
    this.attempts = attempts;
    this.lastAgent = attempts.length ? attempts[attempts.length - 1].agent : null;
  }
}

function cleanCliLine(value: unknown): string {
  const text = String(value ?? "")
    .replace(/\u2022/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]?.slice(0, 220) || "";
}

function displayAgent(name: string | null | undefined): string {
  const s = String(name || "agent").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Agent";
}

export function classifyChatAgentResult(agent: string, result: AgentResult): ChatAgentAttempt | null {
  const raw = String(result.raw || "");
  const stderr = String(result.stderr || "");
  const combined = `${raw}\n${stderr}`;
  const infraSized = combined.trim().length <= 800;
  const lower = combined.toLowerCase();
  const authLike =
    /\bnot logged in\b/.test(lower) ||
    /\blogged out\b/.test(lower) ||
    /\bplease (run )?\/?(log|sign)in\b/.test(lower) ||
    /\b(run|use) .{0,24}\/?(log|sign)in\b/.test(lower) ||
    /\bauth(entication|orization)? (required|failed|error)\b/.test(lower) ||
    /\bunauthenticated\b/.test(lower) ||
    /\bapi key\b.{0,40}\b(missing|required|invalid)\b/.test(lower) ||
    /\b(missing|required|invalid)\b.{0,40}\bapi key\b/.test(lower);
  if (authLike && infraSized) {
    return {
      agent,
      ok: false,
      status: "auth_required",
      error_class: "auth_required",
      error_message: "Not connected",
      exit_code: result.code,
      model: result.usage?.model ?? null,
      input_tokens: result.usage?.input_tokens ?? null,
      output_tokens: result.usage?.output_tokens ?? null,
    };
  }
  if (result.code !== 0) {
    return {
      agent,
      ok: false,
      status: "error",
      error_class: "process_exit",
      error_message: "Agent process exited",
      exit_code: result.code,
      model: result.usage?.model ?? null,
      input_tokens: result.usage?.input_tokens ?? null,
      output_tokens: result.usage?.output_tokens ?? null,
    };
  }
  if (!raw.trim()) {
    return {
      agent,
      ok: false,
      status: "empty_reply",
      error_class: "empty_reply",
      error_message: "Agent returned no reply",
      exit_code: result.code,
      model: result.usage?.model ?? null,
      input_tokens: result.usage?.input_tokens ?? null,
      output_tokens: result.usage?.output_tokens ?? null,
    };
  }
  return null;
}

function classifyChatException(agent: string, e: any): ChatAgentAttempt {
  const message = cleanCliLine(e?.message ?? e);
  return {
    agent,
    ok: false,
    status: /timed out/i.test(message) ? "timeout" : "error",
    error_class: /timed out/i.test(message) ? "timeout" : "process_error",
    error_message: /timed out/i.test(message) ? "Agent timed out" : "Agent process failed",
  };
}

function recordChatAttempt(attempt: ChatAgentAttempt, started: number, parsed: boolean, triedJson: boolean): void {
  attempt.latency_ms = Date.now() - started;
  try {
    repo.recordAgentRun({
      op: "chat",
      agent: attempt.agent,
      ok: attempt.ok,
      parsed,
      latency_ms: attempt.latency_ms,
      tried_json: triedJson,
      status: attempt.status,
      error_class: attempt.error_class ?? null,
      error_message: attempt.error_message ?? null,
      exit_code: attempt.exit_code ?? null,
      model: attempt.model ?? null,
      input_tokens: attempt.input_tokens ?? null,
      output_tokens: attempt.output_tokens ?? null,
    });
  } catch { /* telemetry never breaks the loop */ }
}

function summarizeChatAttempts(attempts: ChatAgentAttempt[]): string {
  const failed = attempts.filter((a) => !a.ok);
  if (!failed.length) return "All agents failed to produce a reply";
  return failed
    .slice(-4)
    .map((a) => `${displayAgent(a.agent)}: ${a.error_message || a.error_class || a.status}`)
    .join("; ");
}

function chatFailureReply(e: any): { content: string; agent: string | null; meta: Record<string, unknown>; error: string } {
  if (e instanceof ChatCompletionError) {
    const attempts = e.attempts.filter((a) => !a.ok);
    const first = attempts.length === 1 ? attempts[0] : null;
    const content = first
      ? `Couldn't reach ${displayAgent(first.agent)} CLI: ${first.error_message || first.error_class || first.status}. Check Settings → Agents.`
      : `Couldn't reach a coaching agent. Tried ${summarizeChatAttempts(attempts)}. Check Settings → Agents.`;
    return {
      content,
      agent: first?.agent ?? e.lastAgent,
      meta: { error: true, agent_attempts: e.attempts },
      error: summarizeChatAttempts(attempts),
    };
  }
  const message = cleanCliLine(e?.message ?? e) || "Unknown error";
  return {
    content: `Couldn't reach a coaching agent: ${message}`,
    agent: null,
    meta: { error: true },
    error: message,
  };
}

async function runChatCompletion(
  id: number,
  turn: any,
  prompt: string,
  signal: AbortSignal,
): Promise<{ agent: string; raw: string; attempts: ChatAgentAttempt[] }> {
  // Per-task routing: a "chat → claude" pin resolves an "auto"/blank turn to that
  // one enabled agent; an explicit turn.agent or an unrouted turn is unchanged.
  const chosen = repo.resolveAgentForTask("chat", turn.agent);
  const order: string[] = chosen && chosen !== "auto" ? [chosen] : repo.pickAgentOrder();
  if (!order.length) throw new Error("No agents enabled — turn one on in Settings.");
  const attempts: ChatAgentAttempt[] = [];

  // ---- streaming attempt on the first agent (live tokens) ----
  if (agentSupportsStream(order[0])) {
    const name = order[0];
    const started = Date.now();
    const stream = createChatStreamFilter((e) => emit(id, e));
    streamFilters.set(id, stream); // exposed to the SSE snapshot / poll fallback
    try {
      const res = await runAgentStreaming(name, prompt, {
        signal,
        timeoutMs: INTERACTIVE_TIMEOUT_MS,
        onProgress: stream.progress,
        onDelta: stream.push,
      });
      stream.finish();
      const raw = (res.raw ?? "").toString();
      const failure = classifyChatAgentResult(name, res);
      if (!failure) {
        const attempt: ChatAgentAttempt = {
          agent: name,
          ok: true,
          status: "ok",
          exit_code: res.code,
          model: res.usage?.model ?? null,
          input_tokens: res.usage?.input_tokens ?? null,
          output_tokens: res.usage?.output_tokens ?? null,
        };
        recordChatAttempt(attempt, started, true, false);
        attempts.push(attempt);
        return { agent: name, raw, attempts };
      }
      recordChatAttempt(failure, started, false, false);
      attempts.push(failure);
    } catch (e: any) {
      if (signal.aborted) throw e; // Stop — propagate to the cancel path
      const failure = classifyChatException(name, e);
      recordChatAttempt(failure, started, false, false);
      attempts.push(failure);
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
    if (attempts.some((a) => a.agent === name && a.status === "auth_required")) {
      lastErr = new Error(`${name}: auth required`);
      continue;
    }
    const started = Date.now();
    try {
      emit(id, { type: "progress", text: "Asking the coach…" });
      let res = await runAgent(name, prompt, { signal, timeoutMs: INTERACTIVE_TIMEOUT_MS });
      let raw = (res.raw ?? "").toString();
      let retriedEmpty = false;
      if (!raw.trim() && res.code === 0 && !signal.aborted) {
        retriedEmpty = true;
        emit(id, { type: "progress", text: "Trying the coach again…" });
        res = await runAgent(name, prompt + EMPTY_CHAT_RETRY_SUFFIX, { signal, timeoutMs: INTERACTIVE_TIMEOUT_MS });
        raw = (res.raw ?? "").toString();
      }
      const failure = classifyChatAgentResult(name, res);
      if (!failure) {
        const attempt: ChatAgentAttempt = {
          agent: name,
          ok: true,
          status: "ok",
          exit_code: res.code,
          model: res.usage?.model ?? null,
          input_tokens: res.usage?.input_tokens ?? null,
          output_tokens: res.usage?.output_tokens ?? null,
        };
        recordChatAttempt(attempt, started, true, retriedEmpty);
        attempts.push(attempt);
        return { agent: name, raw, attempts };
      }
      recordChatAttempt(failure, started, false, retriedEmpty);
      attempts.push(failure);
      lastErr = new Error(`${name}: ${failure.error_message || failure.error_class || failure.status}`);
    } catch (e: any) {
      if (signal.aborted) throw e;
      lastErr = e;
      const failure = classifyChatException(name, e);
      recordChatAttempt(failure, started, false, false);
      attempts.push(failure);
    }
  }
  throw new ChatCompletionError(attempts, lastErr?.message);
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

// ---------- pasted-lab confirm draft (propose→apply for a bulk lab paste) ----------
// A big pasted lab panel is a substantial write, so it follows the propose→apply idiom
// instead of the immediate-apply safe path: it's persisted as a pending_confirm health
// document (its raw text on disk, NO markers extracted yet, so it never leaks into the
// marker history) that the user CONFIRMS in chat. Confirming routes it through the
// completeness-first, Claude-first health ingest (enrich.ts → pickHealthAgentOrder) —
// the same reliable transcription the Health tab's paste box uses. A small inline
// mention ("my ldl was 90") stays on the immediate path.
//
// Threshold: reuse repo.estimateMarkerCandidates over the raw message (a bulk value-
// per-line export), OR the count of markers the chat agent already extracted (covers a
// one-line-per-marker / inline paste the line estimate misses). Either clearing the bar
// makes it a draft.
export const CHAT_LAB_CONFIRM_MIN = 8;
export function isSubstantialLabPaste(text: string | null | undefined, agentMarkerCount = 0): boolean {
  let estimate = 0;
  try { estimate = repo.estimateMarkerCandidates(String(text ?? "")); } catch { estimate = 0; }
  return estimate >= CHAT_LAB_CONFIRM_MIN || agentMarkerCount >= CHAT_LAB_CONFIRM_MIN;
}

export interface LabConfirmDraft { id: number; marker_estimate: number; summary: string | null; kind: string | null; }

// Persist a substantial pasted lab as a pending_confirm health document and return the
// meta descriptor the chat surface renders a one-tap Confirm from. The raw text lands on
// disk (mirroring the Health tab's paste), and the chat agent's inline markers are stashed
// under parsed.pending_markers — a NON-leaking key (getMarkerHistory reads parsed.markers)
// used only as the graceful-degrade fallback when confirm can't reach a transcriber.
// Returns null on a write failure so the caller can fall back to the immediate apply.
function persistPendingLabDraft(a: { markers?: unknown; summary?: unknown; doc_date?: unknown; kind?: string }, message: string, estimate: number): LabConfirmDraft | null {
  const text = String(message ?? "");
  const markers = Array.isArray(a?.markers) ? a.markers : [];
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const name = `${crypto.randomUUID()}.txt`;
    const filePath = path.join(UPLOADS_DIR, name);
    fs.writeFileSync(filePath, Buffer.from(text.slice(0, 400000), "utf8"));
    const summary = stringOrNull(a?.summary);
    const pending: Record<string, unknown> = {};
    if (markers.length) pending.pending_markers = markers;
    if (summary) pending.pending_summary = summary;
    const doc = repo.addHealthDocument({
      kind: (a?.kind ?? "other") as string,
      doc_date: stringOrNull(a?.doc_date),
      original_name: "Pasted results (chat)",
      mime: "text/plain",
      file_path: filePath,
      parsed_json: Object.keys(pending).length ? pending : null,
      summary,
      enrichment_status: "pending_confirm",
    }) as { id?: unknown; kind?: unknown } | null;
    if (!doc || typeof doc.id !== "number") return null;
    return {
      id: doc.id,
      marker_estimate: Math.max(estimate, markers.length),
      summary,
      kind: typeof doc.kind === "string" ? doc.kind : ((a?.kind as string) ?? null),
    };
  } catch (e: unknown) {
    console.error(`[chat] failed to persist pending lab draft: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ---------- action application ----------
// Lifted verbatim from the old inline POST /api/chat handler so the worker is the
// single place chat actions are applied. Safe actions apply immediately; plan
// changes become DRAFT proposals (returned for the caller to summarize into meta).
// A SUBSTANTIAL pasted lab becomes a pending_confirm DRAFT the user confirms before it
// writes to Health records (see persistPendingLabDraft). Each action is independently
// guarded — one bad action records its error and the rest still apply.
export function applyChatActions(
  parsed: { actions?: unknown } | ChatAction[] | null | undefined,
  ctx: { agent: string; imagePath?: string | null; message?: string | null; skipLogFood?: boolean },
): { applied: Array<{ type: ChatActionType; result?: unknown; error?: string }>; drafts: unknown[]; labConfirms: LabConfirmDraft[] } {
  const applied: Array<{ type: ChatActionType; result?: unknown; error?: string }> = [];
  const drafts: unknown[] = [];
  const labConfirms: LabConfirmDraft[] = [];
  const message = ctx.message ?? "";
  const foodOnly = isFoodOnlyTurn(message, ctx.imagePath);
  const explicitGoalIntent = !foodOnly && hasExplicitGoalIntent(message);
  const actions = normalizeChatActions(Array.isArray(parsed) ? parsed : parsed?.actions);
  for (const a of actions) {
    try {
      switch (a.type) {
        case "log_activity":
          applied.push({ type: a.type, result: repo.addActivity({ text: a.text, date: a.date, notes: a.notes }) });
          break;
        case "log_set":
          applied.push({ type: a.type, result: repo.logSetByName(a) });
          break;
        case "set_profile": {
          const { type, ...patch } = a;
          if (!explicitGoalIntent) {
            for (const field of GOAL_IDENTITY_FIELDS) delete patch[field];
          }
          if (Object.keys(patch).length)
            applied.push({ type: a.type, result: repo.setProfile(patch) });
          break;
        }
        case "set_endurance_goal": {
          if (!explicitGoalIntent) break;
          // The endurance OBJECTIVE — applied through setProfile's endurance_goal
          // path (normalized/validated there). The action's own fields ARE the goal.
          const { type, ...goal } = a;
          applied.push({ type: a.type, result: repo.setProfile({ endurance_goal: goal }) });
          break;
        }
        case "add_memory":
          applied.push({ type: a.type, result: repo.addMemory(a.content, memoryKind(a.kind), "chat") });
          break;
        case "update_memory":
          // A fact CHANGED: edit the existing memory row in place (self-updating
          // memory — the agent saw the row id in DATA.memory and is correcting it).
          applied.push({ type: a.type, result: repo.updateMemory(Number(a.id), { content: a.content, kind: memoryKind(a.kind) }) ?? { error: "not found", id: a.id } });
          break;
        case "supersede_memory":
          // A fact was CONTRADICTED/REPLACED: mark the old row superseded (never
          // hard-deleted), optionally with a replacement.
          applied.push({
            type: a.type,
            result: repo.supersedeMemory(Number(a.id), {
              content: stringOrUndefined(a.replacement),
              reason: stringOrUndefined(a.reason),
            }) ?? { error: "not found", id: a.id },
          });
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
          applied.push({ type: a.type, result: repo.addFoodNote(String(a.meal || "meal"), "", parsedNote, ctx.imagePath ?? undefined) });
          break;
        }
        case "update_food_note": {
          const result = repo.updateFoodNote(Number(a.id), {
            meal: a.meal,
            summary: a.summary,
            items: a.items,
            notes: a.notes,
            kcal: a.kcal,
            protein_g: a.protein_g,
            carbs_g: a.carbs_g,
            fat_g: a.fat_g,
            fiber_g: a.fiber_g,
          });
          applied.push({ type: a.type, result: result ?? { error: "not found", id: a.id } });
          break;
        }
        case "log_health": {
          // Lab/DEXA results reported in chat. Markers feed the trend view.
          const parsedDocObject = a.parsed && typeof a.parsed === "object"
            ? a.parsed as Record<string, unknown>
            : null;
          const markers = Array.isArray(a.markers)
            ? a.markers
            : (parsedDocObject && Array.isArray(parsedDocObject.markers) ? parsedDocObject.markers : []);
          // A SUBSTANTIAL pasted panel is a big write → propose→apply: persist a
          // pending_confirm draft (raw text on disk, no markers committed yet) the user
          // confirms, which then transcribes it through the completeness-first, Claude-
          // first health ingest. A small inline mention still applies immediately below.
          const estimate = (() => { try { return repo.estimateMarkerCandidates(message); } catch { return 0; } })();
          if (isSubstantialLabPaste(message, markers.length)) {
            const draft = persistPendingLabDraft(a, message, estimate);
            if (draft) { labConfirms.push(draft); break; }
            // couldn't persist (fs error) → fall through to the immediate apply
          }
          const parsedDoc = parsedDocObject
            ? parsedDocObject
            : (markers.length ? { markers } : null);
          applied.push({ type: a.type, result: repo.addHealthDocument({
            kind: a.kind,
            doc_date: stringOrNull(a.doc_date),
            summary: stringOrNull(a.summary),
            parsed_json: parsedDoc,
            enrichment_status: "done",
          }) });
          // New markers from chat → refresh the deterministic markers→directives
          // propagation (idempotent), mirroring the enrichment path.
          try { repo.deriveDirectives(); } catch { /* never fail the chat action */ }
          break;
        }
        case "add_context_event":
          // A just-mentioned event (a late concert, travel, illness) shapes TODAY via
          // the active-context effect; addContextEvent busts the cached Brief at the
          // repo layer now (so EVERY surface reacts, not just chat).
          applied.push({ type: a.type, result: repo.addContextEvent({
            kind: a.kind,
            title: stringOrUndefined(a.title),
            detail: stringOrUndefined(a.detail),
            start_date: stringOrUndefined(a.start_date),
            end_date: stringOrUndefined(a.end_date),
            meta: a.meta,
          }) });
          break;
        case "resolve_context_event":
          // Confirmed healed / over → close it (keeps the record); resolveContextEvent
          // busts the Brief at the repo layer.
          applied.push({ type: a.type, result: repo.resolveContextEvent(Number(a.id), stringOrUndefined(a.date)) ?? { error: "not found", id: a.id } });
          break;
        case "log_supplement": {
          // Supplement UNDERSTANDING (not a daily log): the athlete mentioned what
          // they take. Prefer the agent's already-structured items (long tail); fall
          // back to deterministic free-text understanding (the KB approximates).
          if (Array.isArray(a.items) && a.items.length) {
            applied.push({ type: a.type, result: a.items.map((it) => repo.addSupplement(it)) });
          } else {
            applied.push({ type: a.type, result: repo.understandSupplements(String(a.text ?? a.summary ?? message)) });
          }
          break;
        }
        case "log_measurement":
          // At-home body measurements ("waist 34, chest 42, arms 15") apply immediately —
          // a safe capture like log_food; returns the row + fresh indicators.
          applied.push({ type: a.type, result: repo.applyMeasurementAction(a) });
          break;
        case "plan_update":
          if (foodOnly) break;
          applied.push({ type: a.type, result: applyBackgroundPlanUpdate(ctx.agent, a.summary, a.changes) });
          break;
        case "plan_restructure":
          if (foodOnly) break;
          drafts.push(repo.createProposal(ctx.agent, "chat: restructure", "", { summary: a.summary, days: a.days }));
          break;
        case "revert_decision":
          applied.push({
            type: a.type,
            result: revertDecision(Number(a.id), stringOrUndefined(a.reason) ?? "user veto"),
          });
          break;
        default: {
          const _exhaustive: never = a;
          void _exhaustive;
        }
      }
    } catch (e: unknown) {
      applied.push({ type: a.type, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { applied, drafts, labConfirms };
}
