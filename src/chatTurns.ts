import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "./db.js";
import { createProgressBus, createSerialRunner } from "./jobRunner.js";
import * as repo from "./repo.js";
import { UPLOADS_DIR } from "./uploadPaths.js";
import { buildChatPrompt, parseChatEscalationRequest, parseChatReply, CHAT_REPLY_SENTINEL } from "./prompt.js";
import {
  coachReadToolList,
  COACH_READ_MAX_ROUNDS,
  COACH_READ_ORDINARY_MAX_CALLS,
  COACH_READ_ORDINARY_MAX_BYTES,
  type CompletedCoachRead,
} from "./runChosen.js";
import { executeCoachReadTool } from "./brain/read-tool-runtime.js";
import {
  isCoachReadQueryTurn,
  normalizeCoachReadQueryTurn,
  type CoachReadQueryTurn,
} from "./brain/query-loop-contract.js";
import type { CoachReadToolRequest, CoachReadToolResult } from "./brain/read-tools.js";
import type { CoachReadToolExecutionContext } from "./brain/read-tool-runtime.js";
import { addDaysISO, chatHistoryTimeLabel, localDateISO, nowContext, parseDbTime } from "./repo/shared.js";
import {
  mergeStoredRun,
  resolveRunIndex,
  runLabelKey,
  runNumber,
  storedRunsFromItems,
  type RunEditPatch,
  type StoredRun,
} from "./repo/run-edit.js";
import { runWithTimeZone } from "./tz.js";
import {
  availabilityHolds,
  classifyAgentFailure,
  classifyLimitBannerText,
  isAuthFailureText,
  parseStreamRateLimitEvent,
  type AgentFailure,
} from "./agentAvailability.js";
import {
  runAgent,
  runAgentStreaming,
  agentSupportsStream,
  extractJson,
  interactiveTimeoutFor,
  loadAgents,
  resolveAgentExecutionProfile,
  type AgentDef,
  type AgentResult,
} from "./agents.js";
import { createChatStreamFilter, type LiveReplyEvent } from "./chatStreamFilter.js";
import type { MemoryKind } from "./repo/memory.js";
import {
  chatCheckinDate,
  normalizeChatActions,
  normalizeRunZoneKey,
  type ChatAction,
  type ChatActionType,
  type LogFoodAction,
  type RunPrescriptionKind,
  type RunZoneKey,
  type SetRunAction,
} from "./chatActions.js";
import { normalizeFoodCaptureParsed } from "./foodCapture.js";
import { pickDayVariant } from "./repo/brain/day-read-rules.js";
import { applyProposalWithAutonomy, revertDecision } from "./domain/brain/autonomy-service.js";
import { diagnosticErrorName, recordAsyncFailure } from "./diagnostics.js";
import {
  chatMessageRequestsCoaching,
  resolveChatProfile,
  type ChatLane,
  type ChatRoutingDecision,
  type ResolvedChatProfile,
} from "./chatRouting.js";

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
  | { type: "routing"; routing: ChatRoutingDecision }
  | LiveReplyEvent
  | { type: "done"; turn: any; message: any }
  | { type: "error"; turn: any; message: any }
  | { type: "canceled"; turn: any };

const turnBus = createProgressBus<TurnEvent>("turn");
function emit(id: number, payload: TurnEvent): void {
  turnBus.emit(id, payload);
}
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
  try {
    return streamFilters.get(id)?.reply() ?? "";
  } catch {
    return "";
  }
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
      const assistant = repo.addChatMessage("assistant", "Something went wrong while finishing that turn.", null, {
        error: true,
      });
      const failed = repo.failChatTurn(id, e?.message ?? String(e), (assistant as any).id);
      emit(id, { type: "error", turn: failed, message: assistant });
    }
  } catch {
    /* ignore */
  }
  recordAsyncFailure("chat_turns", "runner_backstop", e);
  console.error(`[chat] turn#${id} failed (${diagnosticErrorName(e)})`);
});

export function enqueueChatTurn(id: number): void {
  runner.enqueue(id);
}

const INSTANT_FOOD_ALLOWED_REASONS = new Set(["explicit_food_log", "photo_food_default", "explicit_fast_request"]);
const QUESTION_LEAD_RE = /^(?:what|why|how|when|where|who|which|did|does|do|is|are|was|were|should|could|would|can)\b/i;

// Does this message place the meal in TIME at all? Deliberately a coarse "is there
// a when here", NOT a parser — the actual resolution of "last night" into a date and
// an hour is the agent's job, over DATA.now, one layer down. All this decides is
// which lane gets the sentence.
//
// It has to exist because the instant-capture lane runs with NO agent: it is a
// receipt path that stamps the note with today and no time. That is exactly right
// for "just had a protein shake" and exactly wrong for "I had a late dinner last
// night around 9", which the bypass would have silently filed under today. So any
// temporal reference disqualifies the bypass and the turn goes to the full lane,
// where the model reads the whole sentence and resolves the day and the hour.
// Erring toward the full lane is cheap (one ordinary chat turn); erring the other
// way writes the wrong day into the athlete's log.
const MENTIONS_WHEN_RE = new RegExp(
  [
    // named days and relative days
    String.raw`\b(?:yesterday|last\s+night|tonight|this\s+morning|this\s+afternoon|this\s+evening|earlier|later)\b`,
    String.raw`\b(?:last|past|previous)\s+(?:night|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)\b`,
    String.raw`\b(?:on\s+)?(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\b`,
    // elapsed time ("a couple hours ago", "20 min ago")
    String.raw`\b(?:\d+|a|an|a\s+couple(?:\s+of)?|a\s+few|several)\s+(?:min(?:ute)?s?|hours?|hrs?|days?)\s+ago\b`,
    // explicit clock times ("at 8", "around 9pm", "8:30")
    String.raw`\b(?:at|around|about|near|by|before|after|since)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|o'?clock)?\b`,
    String.raw`\b\d{1,2}:\d{2}\s*(?:am|pm)?\b`,
    String.raw`\b\d{1,2}\s*(?:am|pm)\b`,
    // an explicit calendar date
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
  ].join("|"),
  "i"
);

export function mentionsWhen(message: string | null | undefined): boolean {
  return MENTIONS_WHEN_RE.test(String(message ?? ""));
}

export function isInstantFoodCaptureDecision(
  decision: ChatRoutingDecision | null | undefined,
  message: string | null | undefined
): boolean {
  if (!decision || decision.lane !== "capture") return false;
  const reasons = decision.reason_codes;
  // A bare photo is cheap to classify in the capture lane, but it is not consent
  // to log food. The receipt-only bypass requires explicit food-log language.
  if (!reasons.includes("explicit_food_log")) return false;
  if (reasons.some((reason) => !INSTANT_FOOD_ALLOWED_REASONS.has(reason))) return false;
  const text = String(message ?? "").trim();
  if (chatMessageRequestsCoaching(text)) return false;
  if (text && (text.includes("?") || QUESTION_LEAD_RE.test(text))) return false;
  // A meal placed in time is a remembering, not a receipt — let the agent read it.
  if (mentionsWhen(text)) return false;
  return true;
}

export function inferCaptureMeal(message: string | null | undefined, hour = nowContext().hour): string {
  const text = String(message ?? "");
  for (const meal of ["breakfast", "lunch", "dinner", "snack"] as const) {
    if (new RegExp(`\\b${meal}\\b`, "i").test(text)) return meal;
  }
  const h = Number(hour);
  if (h < 11) return "breakfast";
  if (h < 15) return "lunch";
  if (h < 18) return "snack";
  return "dinner";
}

export function completeInstantFoodCapture(id: number, rawMessage?: string) {
  const turn = repo.getChatTurn(id) as any;
  if (!turn) return null;
  if (turn.assistant_message_id) {
    return { turn, message: repo.getChatMessage(Number(turn.assistant_message_id)), note: null };
  }
  if (!isInstantFoodCaptureDecision(turn.routing, turn.message)) return null;
  const photo = turn.routing.reason_codes.includes("photo_food_default") && !!turn.image_path;
  const exactText = String(rawMessage ?? turn.message ?? "");
  const meal = inferCaptureMeal(turn.message);
  const summary = (String(turn.message ?? "").trim() || "Photo meal awaiting estimate").slice(0, 200);
  const note = repo.addChatCaptureFoodNote({
    turn_id: id,
    meal,
    raw: photo ? "" : exactText,
    parsed: { summary },
    image_path: photo ? turn.image_path : null,
    kind: photo ? "photo" : "text",
  }) as any;
  const routing = (repo.getChatTurn(id) as any)?.routing ?? turn.routing;
  const result = { id: note.id, meal: note.meal, enrichment_status: note.enrichment_status ?? null };
  const meta = {
    applied: [{ type: "log_food", result }],
    drafts: [],
    routing,
    instant_capture: true,
  };
  const reply = photo
    ? `Logged your ${meal}. I’ll refine the photo estimate in the background.`
    : `Logged your ${meal}. I’ll fill in the nutrition details in the background.`;
  const finished = repo.finishInstantCaptureChatTurn(id, { reply, meta }) as any;
  if (finished?.turn && finished?.message) emit(id, { type: "done", turn: finished.turn, message: finished.message });
  return { ...finished, note };
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
  if (isInstantFoodCaptureDecision(turn.routing, turn.message)) {
    completeInstantFoodCapture(id, turn.message ?? "");
    return;
  }
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
  const controller = new AbortController();
  controllers.set(id, controller);

  try {
    const { agent, raw, attempts } = await runChatCompletion(id, turn, history, controller.signal);
    const { reply: replyText, actions } = parseChatReply(raw);
    // Clearing a hold is a claim that the provider ANSWERED, so it waits for the
    // reply to actually come out of the raw output. A run that returned only a
    // limit banner never gets here (it classifies as a failure), and a run whose
    // output carried no reply at all is not evidence of health either.
    if (replyText) clearChatAvailability(agent);
    const proposedReply = replyText || "(no reply)";

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

    const { applied, drafts, labConfirms, refusedReverts } = applyChatActions(
      { actions },
      {
        agent,
        imagePath: turn.image_path,
        message: turn.message,
        skipLogFood: !!photoFood,
        turnId: id,
        userMessageId: beforeId,
      }
    );
    if (photoFood) applied.unshift({ type: "log_food", result: photoFood });
    const planReply = reconcileChatPlanReply(proposedReply, turn.message, applied, drafts);
    const runReply = reconcileChatRunReply(planReply, turn.message, applied);
    const objectiveReply = reconcileStrengthObjectiveReply(runReply, turn.message, applied);
    const reply = reconcileChatRevertReply(objectiveReply, applied, refusedReverts, proposedReply);
    const failedAttempts = attempts.filter((a) => !a.ok);
    const meta: {
      applied: typeof applied;
      drafts: unknown[];
      lab_confirms?: typeof labConfirms;
      agent_attempts?: ChatAgentAttempt[];
      clinical_lineage?: ClinicalConversationLineage;
      routing?: ChatRoutingDecision;
    } = {
      applied,
      drafts: drafts.map(proposalMeta),
    };
    const finalRouting = repo.getChatTurnRouting(id);
    if (finalRouting) meta.routing = finalRouting;
    // A substantial pasted lab awaits one-tap confirmation before it writes to Health.
    if (labConfirms.length) meta.lab_confirms = labConfirms;
    if (failedAttempts.length) meta.agent_attempts = attempts;
    const directTurnClinical = clinicalPlanProvenance({
      message: turn.message,
      action: {},
      imagePath: turn.image_path,
      imageAloneIsClinical: false,
    });
    const clinicalLineage = clinicalLineageForTurn(applied, id, directTurnClinical);
    if (clinicalLineage) meta.clinical_lineage = clinicalLineage;
    const assistant = repo.addChatMessage("assistant", reply, agent, meta);
    const finished = repo.finishChatTurn(id, {
      reply,
      chosen_agent: agent,
      assistant_message_id: (assistant as any).id,
      meta,
    });
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
const PHOTO_FOOD_HINT_RE =
  /\b(food|meal|breakfast|lunch|dinner|snack|plate|bowl|ate|eating|calor(?:y|ies)|macro|protein|carb|fat|fiber|weigh(?:ed)?|grams?|oz|serving|portion|recipe|restaurant|label|packag(?:e|ing)|menu)\b/i;
const PHOTO_NON_FOOD_HINT_RE =
  /\b(physique|body|mirror|pose|form|equipment|bike|run|shoe|injur(?:y|ed)?|pain|dexa|scan|lab|blood|chart|screenshot)\b/i;

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// Three-state passthrough for a field where "say nothing" and "say it is nothing"
// are different instructions: undefined leaves a stored value alone, an explicit
// null unstates it, and a string sets it. stringOrUndefined would flatten the
// middle case into the first and silently drop the correction.
function stringOrNullOrUndefined(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function memoryKind(value: unknown): MemoryKind | undefined {
  return typeof value === "string" && value.trim() ? (value as MemoryKind) : undefined;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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
  if (!s) return false; // a bare photo must be identified by vision before any food write
  if (PHOTO_FOOD_HINT_RE.test(s)) return true;
  if (PHOTO_NON_FOOD_HINT_RE.test(s)) return false;
  return false;
}

// A meal is useful recovery/fuel context, but it is not by itself evidence that a
// lift should change. This backstop prevents an overreaching chat model from
// turning a food capture into a surprise training intervention. If the athlete
// also reports a training, recovery, pain, or life signal, the targeted coaching
// path remains available.
const FOOD_TURN_RE =
  /\b(food|meal|breakfast|lunch|dinner|snack|plate|bowl|salad|chicken|restaurant|cafe|café|ate|eating|calor(?:y|ies)|macro|protein|carb|fat|fiber|portion|recipe|menu)\b/i;
const TRAINING_SIGNAL_RE =
  /\b(workout|train(?:ing|ed)?|lift(?:ing|ed)?|session|exercise|bench|squat|deadlift|press|row|run|ride|cycle|pain|sore|soreness|injur(?:y|ed)|recovery|sleep|hrv|fatigue|travel|trip|ill|sick)\b/i;
export function isFoodOnlyTurn(message: string | null | undefined, imagePath?: string | null): boolean {
  const text = String(message ?? "");
  return (Boolean(imagePath) || FOOD_TURN_RE.test(text)) && !TRAINING_SIGNAL_RE.test(text);
}

type ClinicalPlanSignal = {
  label: string;
  pattern: RegExp;
};

const CLINICAL_PLAN_SIGNALS: readonly ClinicalPlanSignal[] = [
  { label: "imaging", pattern: /\b(?:mri|magnetic resonance|imaging|radiolog(?:y|ist|ical))\b/i },
  { label: "ct", pattern: /\b(?:ct (?:scan|study|report)|computed tomography)\b/i },
  { label: "xray", pattern: /\b(?:x[- ]?ray|radiograph)\b/i },
  { label: "ultrasound", pattern: /\b(?:ultrasound|sonogram)\b/i },
  { label: "scoliosis", pattern: /\bscoliosis\b/i },
  { label: "injury", pattern: /\b(?:injur(?:y|ies|ed)|return[- ]to[- ]play)\b/i },
  {
    label: "rehab",
    pattern: /\b(?:rehab(?:ilitation)?|physical therap(?:y|ist)|physiotherap(?:y|ist)|post[- ]?op(?:erative)?)\b/i,
  },
  {
    label: "clinician",
    pattern:
      /\b(?:clinician|physician|doctor|orthop(?:edic|aedist|edist)|medical (?:finding|advice)|diagnos(?:is|ed)|prescribed)\b/i,
  },
  {
    label: "clinical_finding",
    pattern:
      /\b(?:fracture|torn? (?:muscle|tendon|ligament)|herniated disc|disc (?:bulge|protrusion)|stenosis|lesion|impingement)\b/i,
  },
];

const CLINICAL_STUDY_REFERENCE_KEY_RE =
  /(?:^|_)(?:imaging|radiology|study|scan|xray|x_ray|mri|ct|ultrasound|health_document|source_document|clinical_finding|diagnosis)(?:_|$)/i;

export type ClinicalPlanProvenance = {
  server_owned: true;
  source: "chat_clinical_detection" | "chat_clinical_lineage";
  detected_from: Array<
    | "user_message"
    | "action_rationale_or_constraints"
    | "study_reference"
    | "attached_chat_image"
    | "conversation_lineage"
  >;
  signals: string[];
  study_reference_paths: string[];
  attached_image: boolean;
  lineage?: { turn_id: number; proposal_id: number | null; decision_id: number | null };
};

export type ClinicalConversationLineage = {
  server_owned: true;
  source: "chat_clinical_lineage";
  turn_id: number;
  proposal_id: number | null;
  decision_id: number | null;
  provenance: ClinicalPlanProvenance;
};

function clinicalTextSignals(text: string): string[] {
  return CLINICAL_PLAN_SIGNALS.filter((signal) => signal.pattern.test(text)).map((signal) => signal.label);
}

function actionClinicalEvidence(action: unknown): { text: string; referencePaths: string[] } {
  const strings: string[] = [];
  const referencePaths: string[] = [];
  const visit = (value: unknown, pathParts: string[], depth: number): void => {
    if (depth > 6 || strings.length >= 200) return;
    if (typeof value === "string") {
      strings.push(value.slice(0, 2_000));
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 100).forEach((entry, index) => visit(entry, [...pathParts, String(index)], depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      const nextPath = [...pathParts, key];
      if (CLINICAL_STUDY_REFERENCE_KEY_RE.test(key) && entry != null && entry !== "") {
        referencePaths.push(nextPath.join(".").slice(0, 160));
      }
      visit(entry, nextPath, depth + 1);
    }
  };
  visit(action, [], 0);
  return { text: strings.join("\n"), referencePaths: [...new Set(referencePaths)].slice(0, 20) };
}

// Server-owned clinical classification for chat plan actions. The model cannot
// opt out with a boolean: we inspect the athlete's words, action rationale and
// constraints, and any study/document reference fields. Plan-action callers treat
// an attached ad-hoc image as sufficient provenance so an unverified picture cannot
// quietly rewrite training; prose-only turn persistence disables that image-only rule.
export function clinicalPlanProvenance(input: {
  message?: string | null;
  action: unknown;
  imagePath?: string | null;
  imageAloneIsClinical?: boolean;
}): ClinicalPlanProvenance | null {
  const messageSignals = clinicalTextSignals(String(input.message ?? ""));
  const actionEvidence = actionClinicalEvidence(input.action);
  const actionSignals = clinicalTextSignals(actionEvidence.text);
  const signals = [...new Set([...messageSignals, ...actionSignals])];
  const imageAloneIsClinical = input.imageAloneIsClinical !== false;
  if (!signals.length && !actionEvidence.referencePaths.length && !(input.imagePath && imageAloneIsClinical))
    return null;

  const detectedFrom: ClinicalPlanProvenance["detected_from"] = [];
  if (messageSignals.length) detectedFrom.push("user_message");
  if (actionSignals.length) detectedFrom.push("action_rationale_or_constraints");
  if (actionEvidence.referencePaths.length) detectedFrom.push("study_reference");
  if (input.imagePath) detectedFrom.push("attached_chat_image");
  return {
    server_owned: true,
    source: "chat_clinical_detection",
    detected_from: detectedFrom,
    signals,
    study_reference_paths: actionEvidence.referencePaths,
    attached_image: Boolean(input.imagePath),
  };
}

export function clinicalLineageForTurn(
  applied: Array<{ type: ChatActionType; result?: unknown; error?: string }>,
  turnId: number,
  directTurnClinical: ClinicalPlanProvenance | null = null
): ClinicalConversationLineage | null {
  for (let index = applied.length - 1; index >= 0; index--) {
    const result = recordOrNull(applied[index]?.result);
    const decision = recordOrNull(result?.decision);
    const context = recordOrNull(decision?.context);
    const provenance = recordOrNull(context?.clinical_provenance) as ClinicalPlanProvenance | null;
    const proposalId = Number(result?.proposal_id);
    const decisionId = Number(decision?.id);
    if (
      result?.tier === "clinician" &&
      result?.review_required === true &&
      provenance?.server_owned === true &&
      Number.isInteger(proposalId) &&
      proposalId > 0 &&
      Number.isInteger(decisionId) &&
      decisionId > 0
    ) {
      return {
        server_owned: true,
        source: "chat_clinical_lineage",
        turn_id: turnId,
        proposal_id: proposalId,
        decision_id: decisionId,
        provenance,
      };
    }
  }
  if (!directTurnClinical) return null;
  return {
    server_owned: true,
    source: "chat_clinical_lineage",
    turn_id: turnId,
    proposal_id: null,
    decision_id: null,
    provenance: directTurnClinical,
  };
}

const CLINICAL_LINEAGE_MAX_AGE_MS = 45 * 60_000;
const CLINICAL_LINEAGE_REFERENCE_RE =
  /\b(?:yes|yeah|yep|ok(?:ay)?|sure|sounds good|go ahead|proceed|do it|please do|the (?:change|exercise|movement|variation)|as discussed|you (?:mentioned|suggested|recommended)|we discussed|same (?:change|exercise|movement|variation))\b|\b(?:that|this|those|these)\s+(?:change|exercise|movement|variation|one|plan)\b|\b(?:apply|make|add|change|adjust|use)\s+(?:that|this|it)\b/i;
const CLINICAL_LINEAGE_TOPIC_CHANGE_RE =
  /\b(?:different|new|unrelated) topic\b|\b(?:separately|moving on|change of subject|unrelated to (?:that|this|the (?:mri|scan|injury|rehab)))\b/i;
const INDEPENDENT_TRAINING_SUBJECT_RE =
  /\b(?:bench(?: press)?|squat|deadlift|press|row|pull[- ]?up|run|ride|cycle|cardio|workout|session|sets?|reps?|load|weight)\b/i;
const INDEPENDENT_TRAINING_SIGNAL_RE =
  /\b(?:felt|feels?|was|were|seems?|hit|completed|finished|managed|performed)\b.{0,50}\b(?:easy|easier|hard|harder|crisp|smooth|heavy|light|pain[- ]?free|reps?|sets?|rir|rpe)\b|\b(?:increase|decrease|progress|bump|reduce|add|remove|swap|replace)\b.{0,50}\b(?:load|weight|sets?|reps?|exercise|movement)\b|\b(?:\d+(?:\.\d+)?\s*(?:sets?|reps?)|rir\s*\d+|rpe\s*\d+)\b/i;
const INDEPENDENT_PLAN_REQUEST_RE =
  /\b(?:increase|decrease|bump|reduce|raise|lower|progress|set)\b.{0,60}\b(?:bench(?: press)?|squat|deadlift|press|row|pull[- ]?up|run|ride|load|weight|sets?|reps?)\b/i;

// A plan action immediately after clinical context inherits by default. Break the
// lineage only when the athlete clearly opens a different topic/request, or gives
// a self-contained new performance signal. Anaphoric language ("that exercise",
// "do it") always wins because it explicitly links back to the prior turn.
function explicitlyBreaksClinicalLineage(message: string): boolean {
  if (CLINICAL_LINEAGE_REFERENCE_RE.test(message)) return false;
  if (CLINICAL_LINEAGE_TOPIC_CHANGE_RE.test(message)) return true;
  if (INDEPENDENT_TRAINING_SUBJECT_RE.test(message) && INDEPENDENT_TRAINING_SIGNAL_RE.test(message)) return true;
  return INDEPENDENT_PLAN_REQUEST_RE.test(message);
}

function inheritedClinicalLineage(input: {
  turnId?: number | null;
  userMessageId?: number | null;
  message?: string | null;
}): ClinicalPlanProvenance | null {
  const turnId = Number(input.turnId);
  const userMessageId = Number(input.userMessageId);
  const message = String(input.message ?? "").trim();
  if (
    !Number.isInteger(turnId) ||
    turnId <= 0 ||
    !Number.isInteger(userMessageId) ||
    userMessageId <= 0 ||
    explicitlyBreaksClinicalLineage(message)
  )
    return null;

  const row = db
    .prepare(
      `SELECT prior.id, prior.status, prior.finished_at, prior.meta,
              prior.assistant_message_id, prior_assistant.archived_at AS assistant_archived_at
         FROM chat_turns prior
         LEFT JOIN chat_messages prior_assistant
           ON prior_assistant.id = prior.assistant_message_id
         JOIN chat_messages current_user
           ON current_user.id = ?
          AND current_user.archived_at IS NULL
        WHERE prior.id < ?
        ORDER BY prior.id DESC LIMIT 1`
    )
    .get(userMessageId, turnId) as any;
  const finishedAt = parseDbTime(row?.finished_at)?.getTime() ?? Number.NaN;
  if (
    !row ||
    row.status !== "done" ||
    row.assistant_message_id == null ||
    row.assistant_archived_at != null ||
    !Number.isFinite(finishedAt) ||
    Date.now() - finishedAt > CLINICAL_LINEAGE_MAX_AGE_MS
  )
    return null;

  let meta: any = null;
  try {
    meta = row.meta ? JSON.parse(row.meta) : null;
  } catch {
    return null;
  }
  const lineage = recordOrNull(meta?.clinical_lineage);
  const provenance = recordOrNull(lineage?.provenance) as ClinicalPlanProvenance | null;
  if (
    lineage?.server_owned !== true ||
    lineage?.source !== "chat_clinical_lineage" ||
    Number(lineage.turn_id) !== Number(row.id) ||
    provenance?.server_owned !== true
  )
    return null;

  const proposalId = lineage.proposal_id == null ? null : Number(lineage.proposal_id);
  const decisionId = lineage.decision_id == null ? null : Number(lineage.decision_id);
  if ((proposalId == null) !== (decisionId == null)) return null;
  if (proposalId != null && decisionId != null) {
    const proposal = repo.getProposal(proposalId) as any;
    const decision = repo.getBrainDecision(decisionId) as any;
    if (
      proposal?.status !== "draft" ||
      decision?.status !== "review" ||
      decision?.autonomy_tier !== "clinician" ||
      decision?.source_ref_type !== "plan_proposal" ||
      String(decision?.source_ref_key ?? "") !== String(proposalId)
    )
      return null;
  }

  return {
    server_owned: true,
    source: "chat_clinical_lineage",
    detected_from: ["conversation_lineage"],
    signals: Array.isArray(provenance.signals) ? provenance.signals.slice(0, 20).map(String) : [],
    study_reference_paths: Array.isArray(provenance.study_reference_paths)
      ? provenance.study_reference_paths.slice(0, 20).map(String)
      : [],
    attached_image: provenance.attached_image === true,
    lineage: { turn_id: Number(row.id), proposal_id: proposalId, decision_id: decisionId },
  };
}

const GOAL_IDENTITY_FIELDS = new Set([
  "goal_weight_lb",
  "goal_bodyfat_pct",
  "goal_date",
  "goal_mode",
  "primary_discipline",
  "endurance_sport",
  "endurance_goal",
  "training_intent",
]);

// Identity-level goals must come from an explicit athlete statement, never from
// a coach inference or an answer to a "what should my goal be?" question.
export function hasExplicitGoalIntent(message: string | null | undefined): boolean {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (
    /\b(?:what|which)\b.{0,30}\b(?:goals?|targets?|priorities)\b|\b(?:should|could|would)\s+i\b.{0,30}\b(?:goals?|targets?|weigh|train|run|race)\b/i.test(
      text
    )
  )
    return false;
  return (
    /\bmy\s+(?:new\s+)?(?:goal|goals|priorities)\s+(?:is|are|will be)\b/i.test(text) ||
    /\b(?:set|change|update)\s+(?:my\s+)?(?:goals?|targets?|priorities|discipline)\b/i.test(text) ||
    /\bi\s+(?:want|plan|aim|intend|am going)\s+to\b.{0,80}\b(?:weigh|lose|gain|maintain|run|race|train|lift|cycle|ride|swim|complete|finish)\b/i.test(
      text
    ) ||
    /\b(?:train(?:ing)?\s+for|signed?\s+up\s+for|keep\s+me\b.{0,40}\bready)\b/i.test(text)
  );
}

// Strength objectives are narrower than general profile/race goals: one named lift
// plus a chosen return-to-best or numeric destination. Exploratory "what should I"
// questions and broad comeback talk never create durable state.
export function hasExplicitStrengthObjectiveIntent(message: string | null | undefined): boolean {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (
    /\b(?:what|which|how (?:much|heavy))\b.{0,45}\b(?:goal|target|lift|bench|squat|deadlift|press)\b|\b(?:should|could|would)\s+i\b/i.test(
      text
    )
  )
    return false;
  const namedLift =
    /\b(?:bench(?: press)?|squat|deadlift|overhead press|ohp|barbell press|dumbbell press|db press|row|pull[- ]?up)\b/i.test(
      text
    );
  if (!namedLift) return false;
  return (
    /\b(?:set|change|update)\s+(?:my\s+)?(?:strength\s+)?(?:goal|target|objective)\b/i.test(text) ||
    /\b(?:set|change|update)\s+(?:my\s+)?(?:bench(?: press)?|squat|deadlift|overhead press|ohp|barbell press|dumbbell press|db press|row|pull[- ]?up)\s+(?:goal|target|objective)\b/i.test(
      text
    ) ||
    /\b(?:my\s+(?:strength\s+)?goal\s+is|i\s+(?:want|aim|plan|intend)\s+to)\b.{0,100}\b(?:return|get back|build|reach|hit)\b/i.test(
      text
    ) ||
    /\b(?:return|get back)\b.{0,80}\b(?:personal best|\bpb\b|\bpr\b|old max|previous max)\b/i.test(text) ||
    /\bi\s+(?:want|aim|plan|intend)\s+to\b.{0,120}\bback\s+to\s+(?:my\s+)?(?:personal best|\bpb\b|\bpr\b|old max|previous max)\b/i.test(
      text
    )
  );
}

// A question is a conversation, not an authorization. The coach may still PROPOSE the
// change; it just doesn't carry the athlete's own word with it, so autonomy policy
// decides on its ordinary terms instead of on `explicit_user_request`.
//
// ONE guard for every training-edit gate below. It used to sit on the run gate alone,
// which meant the identical sentence ("Can you make tomorrow's run 8k?") quiet-applied
// through plan_update and held through set_run. Where the two gates disagreed, the
// conservative reading is the one that survives.
// `will` belongs here for the same reason `would` does: the revert gate's own
// per-sentence strip already treats "will you " as the same politeness wrapper as
// "can|could|would you ", so leaving it out of this alternation made one modal flip
// the outcome — "Would you undo that?" was conversation while "Will you undo that?"
// was a veto. Adding it also makes "Will you make tomorrow's run 8k?" a question to
// the plan/run edit gates, which is the point: one reading for one sentence form.
function isLeadingQuestion(text: string): boolean {
  return /^(?:should|could|would|will|can|what|how|why|is|do|does)\b/i.test(text) && /\?\s*$/.test(text);
}

export function hasExplicitPlanEditIntent(message: string | null | undefined): boolean {
  const text = String(message ?? "")
    .replace(/[‘’]/g, "'")
    .trim();
  if (!text) return false;
  if (isLeadingQuestion(text)) return false;
  const verb =
    /\b(adjust|update|change|edit|fix|make|move|restructure|reshape|rebuild|switch|optimi[sz]e|remove|delete|drop|skip|replace|swap|add)\b/i;
  const object =
    /\b(plan|program|split|session|workout|today['’]?s|today|tonight|exercise|movement|sets?|reps?|bench|press|squat|deadlift|row|run|ride|cardio|lift)\b/i;
  return verb.test(text) && object.test(text);
}

// A run prescription is durable training state, so the athlete's own words are what
// authorize writing it directly (explicit_user_request).
export function hasExplicitRunEditIntent(message: string | null | undefined): boolean {
  const text = String(message ?? "")
    .replace(/[‘’]/g, "'")
    .trim();
  if (!text) return false;
  if (isLeadingQuestion(text)) return false;
  const verb =
    /\b(?:make|set|change|adjust|update|move|drop|cut|shorten|lengthen|extend|bump|raise|lower|swap|replace|add|turn|keep)\b/i;
  const object =
    /\b(?:runs?|running|jog|jogging|mileage|tempo|intervals?|long run|easy run|quality run|threshold|shakeout)\b/i;
  return verb.test(text) && object.test(text);
}

// A symptom record is a bounded factual capture, but still durable health-adjacent
// state. The model may only write it when the athlete independently asks Cairn to
// record it; merely mentioning pain or asking a question is not mutation authority.
export function hasExplicitSymptomReportIntent(message: string | null | undefined): boolean {
  const text = String(message ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  const write = /\b(?:log|record|note|track|save|add|report)\b/i;
  const symptom = /\b(?:pain|painful|ache|aching|aches|hurt|hurts|sore|soreness|discomfort|niggle)\b/i;
  const resolvedOrNegated =
    /\b(?:resolved|pain[- ]free|no longer (?:hurts?|aching|aches|sore|painful)|not (?:in pain|hurting|aching|sore|painful)|(?:does(?:n't|nt| not)|did(?:n't|nt| not)) (?:hurt|ache)|(?:is(?:n't|nt| not)|was(?:n't|nt| not)) (?:hurting|aching|sore|painful)|(?:pain|ache|aching|soreness|discomfort|niggle) (?:(?:is|has|feels?) (?:gone|resolved|cleared)|(?:went|has gone) away)|no (?:pain|ache|aching|soreness|discomfort|niggle))\b/i;
  const negatedWrite =
    /\b(?:do not|don't|dont|never|stop|avoid)\b[\s\S]{0,32}\b(?:log|record|note|track|save|add|report)\b/i;
  return write.test(text) && symptom.test(text) && !resolvedOrNegated.test(text) && !negatedWrite.test(text);
}

// Closing a pain note is the athlete's call, not the coach's read. The model may
// only close one when they say so in this turn — a good session, a week of silence,
// or a question about how it's going is never authority to close the record.
export function hasExplicitSymptomResolveIntent(message: string | null | undefined): boolean {
  const text = String(message ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (/\?\s*$/.test(text)) return false;
  const subject =
    /\b(?:pain|painful|ache|aching|aches|hurt|hurts|hurting|sore|soreness|discomfort|niggle|symptom|injury|knee|knees|shoulder|shoulders|elbow|elbows|wrist|hip|hips|groin|glute|back|lumbar|ankle|ankles|achilles|calf|calves|shin|foot|feet|forearm|note)\b/i;
  const closeCommand =
    /\b(?:close|resolve|clear)\b|\bmark(?:\s+(?:it|that|them))?\s+(?:as\s+)?(?:resolved|healed|better|fine|done)\b/i;
  const healed =
    /\b(?:healed|all better|resolved|pain[- ]free|no longer (?:hurts?|hurting|aching|sore|painful|bothering)|(?:is|has|are) (?:gone|cleared)|cleared up|went away|no (?:more )?(?:pain|ache|aching|soreness|discomfort|niggle))\b/i;
  const negated = /\b(?:do not|don't|dont|never|not|stop)\b[\s\S]{0,24}\b(?:close|resolve|clear|mark)\b/i;
  if (negated.test(text)) return false;
  return subject.test(text) && (closeCommand.test(text) || healed.test(text));
}

function decisionReferences(text: string): number[] {
  return [...text.matchAll(/\bdecision\s*(?:#\s*|id\s*)?(\d+)\b/gi)]
    .map((match) => Number(match[1]))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function decisionCanReplaceCurrentPlan(decisionId: number, phrase: string): boolean {
  const decision = repo.getBrainDecision(decisionId) as any;
  if (!decision) return false;
  const kind = String(decision.kind ?? "");
  if (/\bmeal\s+plan\b/i.test(phrase)) return kind === "meal_plan";
  if (/\b(?:training|workout)\s+plan\b|\b(?:split|program)\b/i.test(phrase)) return kind === "training_structure";
  return kind === "training_structure" || kind === "meal_plan";
}

// A model-emitted revert_decision is only a proposal until the athlete's own
// message independently authorizes it. The model may select an id, but it cannot
// turn a discussion/explanation request into a veto. Keep this deliberately
// deterministic and narrower than ordinary intent classification: a direct
// command wins; hypotheticals, feature questions, and broad negative sentiment do
// not mutate state.
//
// This gate SHARES `isLeadingQuestion` with the plan/run edit gates above. It
// predates that guard and used to strip "can you " per sentence with nothing above
// it, so "Can you undo that?" — the identical politeness-question form the edit
// gates read as conversation — carried the athlete's veto. The per-sentence
// stripping still stands for the non-question form ("Can you undo that", no
// question mark), exactly as "Can you make tomorrow's run 8k" still reads as a
// command to hasExplicitRunEditIntent. `isLeadingQuestion` tests the WHOLE trimmed
// message, so a message that merely ends in a question still authorizes when it
// does not open as one ("That made it worse. Can you undo it?").
export function hasExplicitDecisionRevertIntent(
  message: string | null | undefined,
  decisionId?: number | null
): boolean {
  const text = String(message ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (isLeadingQuestion(text)) return false;

  const id = Number(decisionId);
  const refs = decisionReferences(text);
  // An explicit id is authoritative. Never let the agent redirect a command
  // naming one decision onto another decision's action.
  if (Number.isInteger(id) && id > 0 && refs.length && refs.some((ref) => ref !== id)) return false;

  const sentences = text
    .split(/[.!?;]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    let command = sentence.toLowerCase();
    command = command.replace(/^please\s+/, "");
    command = command.replace(/^(?:can|could|would|will)\s+you\s+/, "");
    command = command.replace(/^i\s+(?:want|need|would like|would prefer)\s+(?:you\s+)?to\s+/, "");
    command = command.replace(/^i\s+want\s+you\s+to\s+/, "");
    if (/\b(?:if|whether)\b/.test(command)) continue;

    // "Undo is available" and "revert would..." describe the feature; an
    // imperative/request beginning with the same verb is an athlete command.
    if (
      /^(?:undo|revert)\b/.test(command) &&
      !/^(?:undo|revert)\s+(?:is|means|can|would|could|should|might|sounds|seems|appears|button|option|feature)\b/.test(
        command
      )
    )
      return true;
    if (/^(?:put|roll)\s+(?:it|this|that|the\s+.{1,80})\s+back\b/.test(command)) return true;

    // Cancel/stop are intentionally object-bound. "Stop" in a health or workout
    // conversation is otherwise far too broad. A pronoun is accepted only when
    // the athlete's message itself names the exact decision id.
    if (/^(?:cancel|stop)\s+(?:it)\b/.test(command) && refs.length && refs.every((ref) => ref === id)) return true;
    if (
      /^(?:cancel|stop)\s+(?:decision\s*(?:#\s*|id\s*)?\d+|(?:this|that|the)\s+(?:(?:specific|scheduled|upcoming|announced|planned|meal|training|workout)\s+){0,5}(?:change|decision|update|refresh|plan|program|split))\b/.test(
        command
      )
    )
      return true;

    const keepCurrent =
      /^(?:keep|leave)\s+(?:my|the)\s+(?:current|existing)\s+(?:meal\s+plan|training\s+plan|workout\s+plan|plan|split|program)(?:\s+(?:alone|unchanged|as\s+is))?\b/.exec(
        command
      ) ??
      /^(?:stick|stay)\s+with\s+(?:my|the)\s+(?:current|existing)\s+(?:meal\s+plan|training\s+plan|workout\s+plan|plan|split|program)\b/.exec(
        command
      ) ??
      /^(?:do\s+not|don't)\s+(?:replace|change|switch)\s+(?:my|the)\s+(?:current|existing)\s+(?:meal\s+plan|training\s+plan|workout\s+plan|plan|split|program)\b/.exec(
        command
      );
    if (keepCurrent && Number.isInteger(id) && id > 0 && decisionCanReplaceCurrentPlan(id, keepCurrent[0])) return true;
  }
  return false;
}

function todayPlanUpdateChanges(message: string | null | undefined, changes: unknown[]): unknown[] {
  const text = String(message ?? "").trim();
  if (!hasExplicitPlanEditIntent(text) || !/\b(?:today(?:['’]s)?|tonight)\b/i.test(text)) return changes;
  // A named future/day target is an explicit athlete override, not an implicit
  // "today" reference. Keep it authoritative even if the sentence also compares
  // it with today (for example, "leave today alone; change day 3").
  if (
    /\b(?:tomorrow|later\s+this\s+week|next\s+(?:session|workout|week|push|pull|legs?|lower|upper|full(?:[- ]body)?|run|ride|cardio)|day\s*(?:number\s*)?\d+|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
      text
    )
  )
    return changes;
  const rows = changes.filter(
    (change): change is Record<string, unknown> => !!change && typeof change === "object" && !Array.isArray(change)
  );
  if (!rows.length || rows.length !== changes.length) return changes;
  const namedDays = new Set(rows.map((change) => Number(change.day_number)).filter((day) => Number.isFinite(day)));
  // Multi-day actions are structural work. Do not silently collapse them onto one
  // session just because the prose happened to mention today.
  if (namedDays.size > 1) return changes;
  const selected = repo.selectedPlanDayForDate(localDateISO());
  if (!selected) return changes;
  return rows.map((change) => ({ ...change, day_number: selected.day_number }));
}

function planItemMatch(items: any[], name: unknown): any | null {
  const value = String(name ?? "").trim();
  if (!value) return null;
  const normalized = repo.normalizeExerciseName(value);
  const key = repo.normalizedExerciseKey(value);
  return (
    items.find((item) => repo.normalizeExerciseName(String(item?.exercise ?? "")) === normalized) ??
    items.find((item) => repo.normalizedExerciseKey(String(item?.exercise ?? "")) === key) ??
    null
  );
}

function samePlanPrescriptionField(field: string, actualValue: unknown, expectedValue: unknown): boolean {
  const actual = actualValue ?? null;
  const expected = expectedValue ?? null;
  if (field === "mode") return String(actual) === String(expected);
  if (actual === null || expected === null) return actual === expected;
  return Number(actual) === Number(expected);
}

function verifyPlanUpdateReadback(changes: unknown[], result: any): any {
  const rows = changes.filter(
    (change): change is Record<string, unknown> => !!change && typeof change === "object" && !Array.isArray(change)
  );
  const dayNumbers = [
    ...new Set(rows.map((change) => Number(change.day_number)).filter((day) => Number.isFinite(day))),
  ];
  const days = dayNumbers.map((day) => repo.getPlanDay(day)).filter(Boolean);
  const byDay = new Map(days.map((day: any) => [Number(day.day_number), day]));
  const clamped = Array.isArray(result?.clamped) ? result.clamped : [];
  const receipts = [
    ...(Array.isArray(result?.applied) ? result.applied : []),
    ...(Array.isArray(result?.added) ? result.added : []),
  ];
  const checks = rows.map((change) => {
    const day = byDay.get(Number(change.day_number)) as any;
    const items = Array.isArray(day?.items) ? day.items : [];
    const remove = change.remove === true || Number(change.sets) === 0;
    if (change.swap && typeof change.swap === "object") {
      const swap = change.swap as Record<string, unknown>;
      const receipt = receipts.find(
        (entry: any) =>
          entry?.action === "swapped" &&
          Number(entry?.day) === Number(change.day_number) &&
          (repo.normalizeExerciseName(String(entry?.swap?.to ?? "")) ===
            repo.normalizeExerciseName(String(swap.to ?? "")) ||
            repo.normalizedExerciseKey(String(entry?.exercise ?? "")) ===
              repo.normalizedExerciseKey(String(swap.to ?? "")))
      );
      // The request may use a persisted alias ("flat bench") whose normalized
      // text intentionally differs from the stored exercise ("Barbell Bench
      // Press"). The apply receipt is the authority for both canonical identities;
      // verify those against the stored day rather than reinterpreting raw aliases.
      const from = planItemMatch(items, receipt?.from ?? swap.from);
      const to = planItemMatch(items, receipt?.exercise ?? swap.to);
      const fields = ["sets", "rep_low", "rep_high", "target_weight", "target_seconds", "mode"] as const;
      const mismatches =
        !receipt || !to
          ? fields
          : fields.filter((field) => {
              const expected = receipt[field] ?? null;
              const actual = to[field] ?? null;
              return !samePlanPrescriptionField(field, actual, expected);
            });
      return {
        day_number: Number(change.day_number),
        kind: "swap",
        ok: !from && !!to && !!receipt && mismatches.length === 0,
        from: swap.from,
        to: swap.to,
        mismatches,
      };
    }
    const item = planItemMatch(items, change.exercise);
    if (remove) return { day_number: Number(change.day_number), kind: "remove", ok: !item, exercise: change.exercise };
    if (!item) return { day_number: Number(change.day_number), kind: "upsert", ok: false, exercise: change.exercise };
    const receipt = receipts.find(
      (entry: any) =>
        Number(entry?.day) === Number(change.day_number) &&
        repo.normalizedExerciseKey(entry?.exercise) === repo.normalizedExerciseKey(item.exercise)
    );
    const fields = ["sets", "rep_low", "rep_high", "target_weight", "target_seconds", "mode"] as const;
    const mismatches: string[] = [];
    for (const field of fields) {
      if (receipt && Object.hasOwn(receipt, field)) {
        const expected = receipt[field] ?? null;
        const actual = item[field] ?? null;
        if (!samePlanPrescriptionField(field, actual, expected)) mismatches.push(field);
        continue;
      }
      if (change[field] == null) continue;
      const clamp = clamped.find(
        (entry: any) =>
          entry?.field === field &&
          repo.normalizedExerciseKey(entry?.exercise) === repo.normalizedExerciseKey(item.exercise)
      );
      const expected = clamp ? Number(clamp.applied) : Number(change[field]);
      if (field === "mode" ? String(item[field]) !== String(change[field]) : Number(item[field]) !== expected)
        mismatches.push(field);
    }
    return {
      day_number: Number(change.day_number),
      kind: "upsert",
      ok: mismatches.length === 0,
      exercise: item.exercise,
      mismatches,
    };
  });
  return {
    ok: checks.length > 0 && checks.every((check) => check.ok),
    checks,
    days: days.map((day: any) => ({
      day_number: day.day_number,
      name: day.name,
      items: (day.items ?? []).map((item: any) => ({
        exercise: item.exercise,
        sets: item.sets,
        rep_low: item.rep_low,
        rep_high: item.rep_high,
        target_weight: item.target_weight,
        target_seconds: item.target_seconds,
        mode: item.mode,
      })),
    })),
  };
}

// One verdict over both halves of a mixed plan_update: the strength readback and the
// run readback. An edit that produced NEITHER a strength check nor a run check has
// verified nothing and says so (this is the guard the old `checks.length > 0` gave).
function mergeRunVerification(
  strengthVerification: { ok: boolean; checks: unknown[]; days: any[] },
  runs: RunEditPlan,
  strengthBefore: Map<number, number>
): { ok: boolean; checks: unknown[]; days: any[]; runs: RunReadbackCheck[]; errors?: string[] } {
  const runChecks = runs.expected.map((entry) =>
    verifyRunReadback(entry.day_number, entry.run, strengthBefore.get(entry.day_number) ?? null)
  );
  const days = [
    ...strengthVerification.days,
    ...runChecks
      .filter((check) => !strengthVerification.days.some((day: any) => Number(day?.day_number) === check.day_number))
      .map((check) => ({ day_number: check.day_number, runs: [check.run].filter(Boolean) })),
  ];
  return {
    ok:
      strengthVerification.ok &&
      runs.errors.length === 0 &&
      runChecks.every((check) => check.ok) &&
      strengthVerification.checks.length + runChecks.length > 0,
    checks: strengthVerification.checks,
    days,
    runs: runChecks,
    ...(runs.errors.length ? { errors: runs.errors } : {}),
  };
}

function applyBackgroundPlanUpdate(
  agent: string,
  summary: unknown,
  changes: unknown[],
  explicitUserRequest: boolean,
  clinicalProvenance: ClinicalPlanProvenance | null
): unknown {
  // An endurance-shaped change is a RUN, and runs have their own writer. Splitting
  // it out here is what keeps the receipt honest: left among the strength changes an
  // un-kinded run becomes a fabricated lifting movement, which then reads back intact.
  const split = splitPlanChangesForRuns(changes);
  // Nothing left to write and a refusal to explain — say it here rather than build an
  // empty proposal for the apply path to reject in its own, less honest words.
  // `cardio_edits` is one entry per SUCCESSFUL edit, where `cardio` is the whole day
  // and is non-empty as soon as a day was read — even when every edit for it failed.
  // Asking the edits is what keeps a wholly-refused turn from writing a no-op day over
  // its own refusal.
  if (split.runs.errors.length && !split.strength.length && !split.runs.cardio_edits.length) {
    return {
      ok: false,
      background: !explicitUserRequest,
      explicit_user_request: explicitUserRequest,
      persisted: false,
      committed: false,
      verified: false,
      error: split.runs.errors[0],
      verification: { ok: false, checks: [], days: [], runs: [], errors: split.runs.errors },
    };
  }
  const strengthBefore = new Map<number, number>();
  for (const entry of split.runs.expected) {
    if (!strengthBefore.has(entry.day_number))
      strengthBefore.set(entry.day_number, strengthItemCount(entry.day_number));
  }
  const proposal = repo.createProposal(agent, "background: chat signal", "", {
    summary: String(summary ?? "Plan adjusted from a new coaching signal.").slice(0, 500),
    changes: split.strength,
    // The EDIT, not a snapshot of the day. Autonomy decides when this proposal lands —
    // quiet_apply is only what it asks for, and announce/review modes leave it waiting —
    // so the day it was built against may not be the day it is written to. Each marked
    // entry is re-folded onto the day's rows as they stand at the write, so a run edited
    // while this waited survives. Several changes in one turn travel as several marked
    // entries; the apply path re-reads each day once and folds them in order.
    ...(split.runs.cardio_edits.length ? { cardio: split.runs.cardio_edits } : {}),
    ...(clinicalProvenance ? { clinical_provenance: clinicalProvenance } : {}),
  });
  // Route every background adjustment through the ONE autonomy policy. Lead mode
  // may quietly apply a small reversible change; announce/review modes leave it
  // waiting. The shared proposal path still owns all server-side clamps.
  const result = applyProposalWithAutonomy((proposal as any).id, {
    requested_tier: "quiet_apply",
    explicit_user_request: explicitUserRequest,
    clinical: Boolean(clinicalProvenance),
    clinical_provenance: clinicalProvenance ?? undefined,
  }) as any;
  const stored = repo.getProposal((proposal as any).id) as any;
  const persisted = stored?.status === "applied";
  const verification = persisted
    ? mergeRunVerification(
        split.strength.length ? verifyPlanUpdateReadback(split.strength, result) : { ok: true, checks: [], days: [] },
        split.runs,
        strengthBefore
      )
    : { ok: false, proposal_status: stored?.status ?? null, checks: [], days: [], runs: [] };
  return {
    background: !explicitUserRequest,
    explicit_user_request: explicitUserRequest,
    proposal_id: (proposal as any).id,
    ...result,
    persisted,
    committed: persisted,
    verified: verification.ok,
    verification,
  };
}

function routeChatPlanRestructure(
  agent: string,
  summary: unknown,
  days: unknown[],
  clinicalProvenance: ClinicalPlanProvenance | null
): unknown {
  const proposal = repo.createProposal(agent, "chat: restructure", "", {
    summary: String(
      summary ?? "Restructure the training week around the athlete's current goals and constraints."
    ).slice(0, 500),
    days,
    ...(clinicalProvenance ? { clinical_provenance: clinicalProvenance } : {}),
  });
  const result = applyProposalWithAutonomy((proposal as any).id, {
    requested_tier: "announce",
    explicit_user_request: true,
    clinical: Boolean(clinicalProvenance),
    clinical_provenance: clinicalProvenance ?? undefined,
  }) as any;
  const stored = repo.getProposal((proposal as any).id) as any;
  const status = String(result?.decision?.status ?? stored?.autonomy?.status ?? "");
  return {
    background: false,
    explicit_user_request: true,
    proposal_id: (proposal as any).id,
    ...result,
    persisted: stored?.status === "applied",
    committed: stored?.status === "applied",
    scheduled: status === "pending" || status === "announced",
    review_required: status === "review" || result?.review_required === true,
  };
}

// ---------- run prescriptions ----------
// The plan's cardio rows are the only endurance prescription Today, the Plan screen
// and run-compliance can see, and applyProposal's `cardio[]` → setWeeklyRuns is their
// ONE writer — the same one the Monday tick and the run-plan proposal go through.
// Everything below BUILDS a payload for that writer and reads the result back; it
// never touches plan_items itself.
//
// What used to go wrong is narrower than it sounds: a change carrying `kind:'cardio'`
// has routed to setWeeklyRuns for some time (applyProposalUnit lifts it out of
// changes[]). It was a change with NO kind — "make tomorrow's run 8k" arriving as
// {exercise:"Easy run", target_distance_km:8} — that reached applyPlanChange, which
// sees strength items only, and so added a 3×8–12 LIFTING movement called "Easy run"
// beside the untouched 5 km cardio row, which then read back intact and reported
// "Saved and verified".

// One requested change to ONE run. set_run carries exactly one; a plan_update whose
// changes[] turn out to be endurance-shaped is translated into these.
interface RunEdit {
  day_number: number;
  kind: RunPrescriptionKind | null;
  label: string | null;
  match_label: string | null;
  distance_km: number | null;
  duration_min: number | null;
  zone: RunZoneKey | null;
  reason?: unknown;
}

function planDayItems(dayNumber: number): any[] {
  const day = repo.getPlanDay(dayNumber) as any;
  return Array.isArray(day?.items) ? day.items : [];
}

function storedRunsForDay(dayNumber: number): StoredRun[] {
  return storedRunsFromItems(planDayItems(dayNumber));
}

function strengthItemCount(dayNumber: number): number {
  return planDayItems(dayNumber).filter((item: any) => String(item?.kind ?? "") !== "cardio").length;
}

// The athlete's OWN band, from the personal HR model (hr-model.ts). When that model
// has not seen enough running to speak, the prescription carries the bare zone key —
// never the age/Karvonen population band, which would be a formula wearing a
// personal label.
export function runZoneTag(zone: RunZoneKey | null | undefined): string | null {
  if (!zone) return null;
  try {
    const model = repo.getHrModel();
    if (model?.zones && model.confidence !== "insufficient") return repo.hrZoneLabel(zone, model);
  } catch {
    /* no model → the bare key below */
  }
  return zone.toUpperCase();
}

// The edit, resolved to what would be STORED: the zone rendered to the athlete's own
// band, the kind kept as the word that finds the run. This is the shape the apply path
// re-folds, so nothing model-supplied is re-interpreted a second time.
function runEditPatch(edit: RunEdit): RunEditPatch {
  return {
    kind: edit.kind,
    label: edit.label,
    match_label: edit.match_label,
    distance_km: edit.distance_km,
    duration_min: edit.duration_min,
    zone_tag: runZoneTag(edit.zone),
  };
}

// A day with several runs that the request didn't name is ambiguous, and an ambiguous
// run edit is refused rather than guessed at.
function resolveRunTarget(
  runs: StoredRun[],
  edit: RunEdit,
  patch: RunEditPatch
): { index: number } | { error: string } {
  const index = resolveRunIndex(runs, patch);
  if (index == null) {
    return { error: `day ${edit.day_number} carries ${runs.length} runs and the request didn't say which one` };
  }
  return { index };
}

function cardioPayloadEntry(dayNumber: number, run: StoredRun, reason?: unknown): Record<string, unknown> {
  return {
    day_number: dayNumber,
    kind: "cardio",
    label: run.label,
    target_distance_km: run.target_distance_km,
    target_duration_min: run.target_duration_min,
    target_zone: run.target_zone,
    interval: run.interval ?? null,
    day_name: run.label,
    focus: "Endurance",
    ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim().slice(0, 500) } : {}),
  };
}

// The same row, MARKED as an edit and carrying the edit that produced it. The merged
// values stay on the entry so anything previewing the proposal reads what was asked
// for; `cardio_edit` tells the apply path to re-fold `edit` onto the day's rows as they
// stand THEN, instead of writing this copy over whatever arrived in the meantime.
function cardioEditPayloadEntry(
  dayNumber: number,
  run: StoredRun,
  patch: RunEditPatch,
  reason?: unknown
): Record<string, unknown> {
  return {
    ...cardioPayloadEntry(dayNumber, run, reason),
    cardio_edit: true,
    edit: { ...patch },
  };
}

export interface RunEditPlan {
  cardio: Record<string, unknown>[];
  // The same edits expressed as MARKED payload entries — one per edit, carrying the
  // edit itself rather than a snapshot of the day. See `cardioEditPayloadEntry`.
  cardio_edits: Record<string, unknown>[];
  // What each edit expects to find in the store afterwards — the input to the readback.
  expected: { day_number: number; run: StoredRun }[];
  errors: string[];
}

// Fold every run edit onto the day's CURRENT cardio rows and emit the full per-day
// cardio list. setWeeklyRuns replaces a day's cardio wholesale, so the untouched runs
// have to travel with the edited one or they'd be dropped — that is also how the zone
// of an unrelated run survives a distance-only change.
//
// That wholesale list is a snapshot of the day AS IT IS NOW, which is only the truth if
// the payload is written immediately. `cardio_edits` is the same work expressed as the
// edit, for a proposal that may not land until a later boundary.
export function planRunEdits(edits: RunEdit[]): RunEditPlan {
  const byDay = new Map<number, StoredRun[]>();
  // day → (row index → the edit's stated reason), so the ledger's provenance is
  // attached to the row it actually explains.
  const touched = new Map<number, Map<number, unknown>>();
  const expected: { day_number: number; run: StoredRun }[] = [];
  const cardioEdits: Record<string, unknown>[] = [];
  const errors: string[] = [];
  for (const edit of edits) {
    const dayNumber = Math.trunc(Number(edit.day_number));
    if (!Number.isFinite(dayNumber) || dayNumber < 1) {
      errors.push("a run edit named no plan day");
      continue;
    }
    // setWeeklyRuns would CREATE a missing day. Adding a training day is structural
    // work, and a day number the model invented must never quietly become one — chat
    // edits the week that exists.
    if (!byDay.has(dayNumber) && !repo.getPlanDay(dayNumber)) {
      errors.push(`there is no day ${dayNumber} in the plan to change`);
      continue;
    }
    if (!byDay.has(dayNumber)) byDay.set(dayNumber, storedRunsForDay(dayNumber));
    if (!touched.has(dayNumber)) touched.set(dayNumber, new Map());
    const runs = byDay.get(dayNumber) as StoredRun[];
    const patch = runEditPatch({ ...edit, day_number: dayNumber });
    const target = resolveRunTarget(runs, { ...edit, day_number: dayNumber }, patch);
    if ("error" in target) {
      errors.push(target.error);
      continue;
    }
    const merged = mergeStoredRun(target.index >= 0 ? runs[target.index] : null, patch);
    const index = target.index >= 0 ? target.index : runs.length;
    runs[index] = merged;
    touched.get(dayNumber)?.set(index, edit.reason);
    cardioEdits.push(cardioEditPayloadEntry(dayNumber, merged, patch, edit.reason));
    // A later edit to the same row supersedes the earlier expectation.
    const priorExpectation = expected.findIndex(
      (entry) => entry.day_number === dayNumber && runLabelKey(entry.run.label) === runLabelKey(merged.label)
    );
    if (priorExpectation >= 0) expected.splice(priorExpectation, 1);
    expected.push({ day_number: dayNumber, run: merged });
  }
  const cardio: Record<string, unknown>[] = [];
  for (const [dayNumber, runs] of byDay) {
    const edited = touched.get(dayNumber) ?? new Map<number, unknown>();
    runs.forEach((run, index) => cardio.push(cardioPayloadEntry(dayNumber, run, edited.get(index))));
  }
  return { cardio, cardio_edits: cardioEdits, expected, errors };
}

export interface RunReadbackCheck {
  ok: boolean;
  day_number: number;
  mismatches: string[];
  run: StoredRun | null;
  strength_items: number;
}

// The honest readback: re-read the stored day through the SAME reader the Today and
// Plan surfaces use, and compare what is actually there against what was asked for.
// A run that did not land, landed with a different dose, or cost the day its lifting
// work reports a mismatch — the apply receipt is never the evidence.
export function verifyRunReadback(
  dayNumber: number,
  expected: StoredRun,
  strengthBefore: number | null = null
): RunReadbackCheck {
  const runs = storedRunsForDay(dayNumber);
  const stored = runs.find((run) => runLabelKey(run.label) === runLabelKey(expected.label)) ?? null;
  const mismatches: string[] = [];
  if (!stored) mismatches.push("run");
  else {
    if (stored.target_distance_km !== expected.target_distance_km) mismatches.push("distance_km");
    if (stored.target_duration_min !== expected.target_duration_min) mismatches.push("duration_min");
    if ((stored.target_zone ?? null) !== (expected.target_zone ?? null)) mismatches.push("zone");
  }
  const strengthItems = strengthItemCount(dayNumber);
  if (strengthBefore != null && strengthItems !== strengthBefore) mismatches.push("strength_work");
  return { ok: mismatches.length === 0, day_number: dayNumber, mismatches, run: stored, strength_items: strengthItems };
}

export function describeRun(run: StoredRun | null | undefined): string {
  if (!run) return "that run";
  const trim = (value: number) => String(Math.round(value * 100) / 100);
  const dose =
    run.target_distance_km != null
      ? `${trim(run.target_distance_km)} km`
      : run.target_duration_min != null
        ? `${trim(run.target_duration_min)} min`
        : null;
  return [run.label, dose, run.target_zone].filter(Boolean).join(" · ");
}

function runEditFromAction(action: SetRunAction): RunEdit {
  return {
    day_number: Number(action.day_number),
    kind: action.kind ?? null,
    label: typeof action.label === "string" && action.label.trim() ? action.label.trim() : null,
    match_label: typeof action.match_label === "string" && action.match_label.trim() ? action.match_label.trim() : null,
    distance_km: runNumber(action.distance_km),
    duration_min: runNumber(action.duration_min),
    zone: action.zone ?? null,
    reason: action.reason,
  };
}

function mondayOfISO(dateISO: string): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// A run's day_number is a Monday-anchored slot in THIS week (the same anchoring
// weeklyRunPlan uses), so a slot whose date has already gone by is not a plan to edit —
// it is the record of what the week prescribed, and what run-compliance reads back
// against. Rewriting it would quietly change what the athlete was asked to do.
// A slot past Sunday belongs to no week here and is left to the existence check.
function pastWeekSlotRefusal(dayNumber: number): string | null {
  if (!Number.isFinite(dayNumber) || dayNumber < 1 || dayNumber > 7) return null;
  const today = localDateISO();
  const date = addDaysISO(mondayOfISO(today), dayNumber - 1);
  if (!date || date >= today) return null;
  return `day ${dayNumber} already went by this week, and rewriting it would change what your plan says you were prescribed`;
}

// A single run the athlete asked for in chat is a bounded, reversible write, so it
// goes through the ONE autonomy policy exactly as a bounded plan_update does: their
// word is the authorization (explicit_user_request), and the policy still owns the
// tier, the ledger row and the one-tap Undo. Restructuring a week never comes here.
function applyChatRunPrescription(agent: string, action: SetRunAction, explicitUserRequest: boolean): unknown {
  const dayNumber = Math.trunc(Number(action.day_number));
  const refused = pastWeekSlotRefusal(dayNumber);
  const built = refused ? null : planRunEdits([runEditFromAction(action)]);
  if (!built || built.errors.length || !built.expected.length) {
    return {
      ok: false,
      verified: false,
      persisted: false,
      committed: false,
      error: refused ?? built?.errors[0] ?? "that run edit named nothing to change",
      verification: { ok: false, day_number: dayNumber, mismatches: ["not_applied"], run: null, strength_items: 0 },
    };
  }
  const expected = built.expected[0];
  const strengthBefore = strengthItemCount(dayNumber);
  const proposal = repo.createProposal(agent, "chat: run prescription", "", {
    summary: `Day ${expected.day_number} run — ${describeRun(expected.run)}`.slice(0, 500),
    // The EDIT, not a snapshot of the day: this proposal may be held or scheduled, and
    // the day's other runs must be read at the moment it actually lands.
    cardio: built.cardio_edits,
  });
  const result = applyProposalWithAutonomy((proposal as any).id, {
    requested_tier: "quiet_apply",
    explicit_user_request: explicitUserRequest,
  }) as any;
  const stored = repo.getProposal((proposal as any).id) as any;
  const persisted = stored?.status === "applied";
  const status = String(result?.decision?.status ?? stored?.autonomy?.status ?? "");
  const verification: RunReadbackCheck = persisted
    ? verifyRunReadback(expected.day_number, expected.run, strengthBefore)
    : {
        ok: false,
        day_number: expected.day_number,
        mismatches: ["not_applied"],
        run: null,
        strength_items: strengthBefore,
      };
  return {
    explicit_user_request: explicitUserRequest,
    proposal_id: (proposal as any).id,
    ...result,
    persisted,
    committed: persisted,
    scheduled: status === "pending" || status === "announced",
    review_required: status === "review" || result?.review_required === true,
    verified: verification.ok,
    verification,
  };
}

// A plan_update change that carries an endurance prescription is a RUN, whatever the
// model called it. Routing it to the run writer is what keeps the readback honest:
// left in changes[] it becomes a fabricated lifting movement that then verifies.
function isEnduranceChange(change: Record<string, unknown>): boolean {
  // Ask about a REMOVAL first. A cardio removal routed into the run writer became a
  // merge — the run was rewritten with the fields the change happened to carry and
  // then read back as verified, so "take the run off Thursday" reported success over
  // an untouched run.
  if (change.swap || change.remove === true) return false;
  if (String(change.kind ?? "").toLowerCase() === "cardio") return true;
  return (
    change.target_distance_km != null ||
    change.target_duration_min != null ||
    change.target_zone != null ||
    change.interval != null
  );
}

function runEditFromPlanChange(change: Record<string, unknown>): RunEdit {
  const label =
    typeof change.label === "string" && change.label.trim()
      ? change.label.trim()
      : typeof change.exercise === "string" && change.exercise.trim()
        ? change.exercise.trim()
        : null;
  return {
    day_number: Number(change.day_number),
    kind: null,
    label,
    match_label: label,
    distance_km: runNumber(change.target_distance_km),
    duration_min: runNumber(change.target_duration_min),
    zone: normalizeRunZoneKey(change.target_zone),
    reason: change.reason,
  };
}

export interface SplitPlanChanges {
  strength: Record<string, unknown>[];
  runs: RunEditPlan;
}

// Taking a run OFF a day has no writer on either side of the split: setWeeklyRuns
// composes a day's runs from the list it is handed (it can rewrite, not delete a named
// one), and applyPlanChange's remove path deliberately reads loaded movements only. So
// say that plainly rather than letting the request become a quiet no-op.
function isCardioRemoval(change: Record<string, unknown>): boolean {
  return change.remove === true && String(change.kind ?? "").toLowerCase() === "cardio";
}

// A capability refusal an athlete can walk into every week, so it rotates like any
// other repeating athlete-facing sentence (see CHAT_REFUSAL_VARIANTS below). Every
// phrasing names the Plan screen — that is the part the athlete has to act on.
export const CARDIO_REMOVAL_REFUSAL_VARIANTS: ReadonlyArray<(where: string) => string> = [
  (where) => `taking a run${where} off the week isn't something chat can do yet; the Plan screen owns removing a run`,
  (where) => `chat can't take a run${where} off the week yet — removing a run is the Plan screen's job`,
  (where) => `removing a run${where} isn't something I can do from chat yet; the Plan screen is where a run comes off`,
  (where) => `I can't lift a run${where} out of the week from here yet — use the Plan screen to remove a run`,
] as const;

function cardioRemovalRefusal(change: Record<string, unknown>): string {
  const day = Math.trunc(Number(change.day_number));
  const where = Number.isFinite(day) && day >= 1 ? ` from day ${day}` : "";
  return pickDayVariant(CARDIO_REMOVAL_REFUSAL_VARIANTS, localDateISO(), "chat-cardio-removal")(where);
}

export function splitPlanChangesForRuns(changes: unknown[]): SplitPlanChanges {
  const rows = changes.filter(
    (change): change is Record<string, unknown> => !!change && typeof change === "object" && !Array.isArray(change)
  );
  const removals = rows.filter(isCardioRemoval);
  const rest = rows.filter((change) => !isCardioRemoval(change));
  const enduranceRows = rest.filter(isEnduranceChange);
  const strength = rest.filter((change) => !isEnduranceChange(change));
  const runs = planRunEdits(enduranceRows.map(runEditFromPlanChange));
  for (const change of removals) runs.errors.push(cardioRemovalRefusal(change));
  return { strength, runs };
}

function replyClaimsPlanSuccess(reply: string): boolean {
  return /\b(?:i(?:['’]ve| have)?\s+(?:now\s+)?(?:updated|adjusted|saved|applied|pushed|changed|removed|added)|(?:updated|adjusted|saved|applied|pushed|changed)\s+(?:your|today['’]?s|the)\s+(?:live\s+)?(?:plan|program|session|workout)|(?:plan|program|session|workout)\s+is\s+(?:now\s+)?(?:updated|saved|live))\b/i.test(
    reply
  );
}

// ── CHAT_REFUSAL_VARIANTS ────────────────────────────────────────────────────
// The reconcilers below are the athlete-facing truth about what did NOT happen,
// and their inputs are deterministic: the same guard, the same review posture, the
// same off-contract model response produces the same branch. A single literal there
// prints the identical sentence in the chat bubble every time the athlete walks into
// it — the same failure the day read had before its prose became a variant set
// (`src/repo/brain/day-read-rules.ts`). Add a PHRASING to a set here; never add a
// literal at the call site.
//
// Every set carries a stable invariant phrase — "your current plan is unchanged",
// "held for review", "this week's runs are unchanged", "your existing objective is
// unchanged" — because the thing that must survive rotation is the FACT, not the
// wording. Index 0 is the canonical phrasing. Keys are per-site so two sets never
// rotate in lockstep.
export const RESTRUCTURE_HELD_FOR_REVIEW_VARIANTS = [
  "That structural plan change is held for review under the current policy; it is not live yet.",
  "That reshape is held for review, so your week is still exactly as it was.",
  "That structural plan change sits held for review for now; nothing about your week has moved.",
  "A change to the shape of your week is held for review under your current setting, so it isn't live.",
] as const;

export const RESTRUCTURE_NOT_SCHEDULED_VARIANTS: ReadonlyArray<(reason: string) => string> = [
  (reason) => `That structural plan change was not scheduled, so your current plan is unchanged: ${reason}`,
  (reason) => `Nothing went on the calendar from that reshape — your current plan is unchanged: ${reason}`,
  (reason) => `The structural change never got a date, so your current plan is unchanged: ${reason}`,
  (reason) => `That reshape didn't take, and your current plan is unchanged: ${reason}`,
] as const;

export const RESTRUCTURE_DRAFT_VARIANTS = [
  "That structural plan change is a draft for review; it is not live yet.",
  "What came back is a draft for review rather than a live change — your week is untouched.",
  "That reshape landed as a draft for review, so nothing has moved on your plan.",
  "It's a draft for review at this point; the structural change isn't live.",
] as const;

export const PLAN_NOT_SAVED_VARIANTS = [
  "I didn't save a plan change from that response, so your current plan is unchanged.",
  "Nothing from that response reached the plan — your current plan is unchanged.",
  "No plan write came out of that, so your current plan is unchanged.",
  "I stopped short of writing anything there; your current plan is unchanged.",
] as const;

export const PLAN_NO_CHANGE_APPENDED_VARIANTS = [
  "No plan change was saved from this response.",
  "For the record: no plan change was saved from this response.",
  "To be clear, no plan change was saved here.",
  "Nothing landed on the plan — no plan change was saved from this response.",
] as const;

export const PLAN_UNTOUCHED_BY_QUESTION_VARIANTS = [
  "I haven't changed or scheduled your plan from that question; your current training split is unchanged.",
  "That was a question, not a change — your current training split is unchanged.",
  "Nothing was written or put on the calendar from that question; your current training split is unchanged.",
  "I answered rather than acted there, so your current training split is unchanged.",
] as const;

export const PLAN_WRITE_UNVERIFIED_VARIANTS = [
  "The plan write completed, but I couldn't verify the full stored prescription. Reopen Today before training; I won't claim the displayed plan is confirmed.",
  "The write went through, but I couldn't read the whole stored prescription back. Reopen Today before training rather than taking my word for it.",
  "That change was written, though the full stored prescription didn't confirm. Reopen Today before training — I'd rather you see the real thing.",
  "The plan write landed but didn't fully confirm on readback. Reopen Today before training; I won't call the displayed plan confirmed.",
] as const;

export const PLAN_NOT_LIVE_VARIANTS: ReadonlyArray<(reason: string) => string> = [
  (reason) => `That plan change is not live. Your current plan is unchanged: ${reason}`,
  (reason) => `That one didn't land — it is not live, and your current plan is unchanged: ${reason}`,
  (reason) => `To be straight with you: that change is not live, so your current plan is unchanged: ${reason}`,
  (reason) => `Your current plan is unchanged, because that change is not live: ${reason}`,
] as const;

export const RUN_NOT_SAVED_VARIANTS = [
  "I didn't save a run change from that response, so this week's runs are unchanged.",
  "Nothing from that response reached your running — this week's runs are unchanged.",
  "No run write came out of that, so this week's runs are unchanged.",
  "I stopped short of writing a run there; this week's runs are unchanged.",
] as const;

export const RUN_HELD_FOR_REVIEW_VARIANTS = [
  "That run change is held for review under the current policy; it is not live yet.",
  "That run change is held for review, so it isn't live yet.",
  "Your review setting keeps that run change held for review rather than live.",
  "The run edit is held for review for now; nothing has moved on the week.",
] as const;

export const RUN_NOT_LIVE_VARIANTS: ReadonlyArray<(reason: string) => string> = [
  (reason) => `That run change is not live, so this week's runs are unchanged: ${reason}.`,
  (reason) => `That run change didn't land, so this week's runs are unchanged: ${reason}.`,
  (reason) => `This week's runs are unchanged — the run change is not live: ${reason}.`,
  (reason) => `Nothing moved on the running side; this week's runs are unchanged: ${reason}.`,
] as const;

export const STRENGTH_OBJECTIVE_NOT_SAVED_VARIANTS = [
  "I didn't save a strength objective from that response, so your existing objective is unchanged.",
  "No strength objective came out of that response — your existing objective is unchanged.",
  "Nothing was written to your strength goals there, so your existing objective is unchanged.",
  "I stopped short of saving an objective from that; your existing objective is unchanged.",
] as const;

export const STRENGTH_OBJECTIVE_NONE_SAVED_VARIANTS = [
  "No strength objective was saved from this response.",
  "For the record: no strength objective was saved from this response.",
  "To be clear, no strength objective was saved here.",
  "Nothing landed on your strength goals — no strength objective was saved.",
] as const;

export const DECISION_REVERT_NOT_AUTHORIZED_VARIANTS: ReadonlyArray<(how: string) => string> = [
  (how) =>
    `I read that as a question rather than a go-ahead, so nothing was reverted. Say “${how}” and I'll roll it back.`,
  (how) =>
    `To be straight with you: nothing was reverted, and that decision is still standing. “${how}” is the word that puts it back.`,
  (how) => `Nothing was reverted here — I wait for the direct ask on an Undo. Say “${how}” and it goes back.`,
  (how) => `That one is still live: nothing was reverted. When you want it undone for real, say “${how}”.`,
] as const;

export const DECISION_REVERT_FAILED_VARIANTS: ReadonlyArray<(reason: string) => string> = [
  (reason) => `The Undo didn't go through, so nothing was reverted: ${reason}.`,
  (reason) => `That rollback didn't land — nothing was reverted: ${reason}.`,
  (reason) => `Nothing was reverted; the Undo couldn't complete: ${reason}.`,
  (reason) => `I couldn't put that one back, so nothing was reverted: ${reason}.`,
] as const;

export const STRENGTH_OBJECTIVE_UNVERIFIED_VARIANTS: ReadonlyArray<(reason: string) => string> = [
  (reason) => `I couldn't verify that strength objective, so I won't claim it was saved: ${reason}.`,
  (reason) => `That strength objective didn't read back cleanly, so I won't claim it was saved: ${reason}.`,
  (reason) =>
    `I couldn't match that strength objective against what's stored, so I won't claim it was saved: ${reason}.`,
  (reason) => `That objective isn't confirmed on my side, so I won't claim it was saved: ${reason}.`,
] as const;

// ── the appended-receipt shape ───────────────────────────────────────────────
// A reconciler that keeps the model's prose puts its receipt UNDER it, and the last
// reconciler in the chain (reconcileChatRevertReply) has to take that reply apart
// again to drop a false sentence without dropping the receipts below it. Join and
// split are therefore one contract: every append goes through `appendReceipt`, every
// split through `splitAppendedReceipts`, and neither may hand-roll the separator.
// When these two drifted apart the split silently stopped matching and a verified
// plan receipt vanished from the bubble for a change that had really landed.
const RECEIPT_JOIN = "\n\n";

function appendReceipt(reply: string, receipt: string): string {
  return `${reply.trim()}${RECEIPT_JOIN}${receipt}`.trim();
}

// The inverse. `null` means this reply was not built by appendReceipt from that head
// — an earlier reconciler replaced the prose outright — and the caller must not treat
// any part of it as a receipt it can keep.
function splitAppendedReceipts(reply: string, head: string): { head: string; receipts: string } | null {
  const prose = head.trim();
  const body = reply.trim();
  if (!prose || !body.startsWith(prose)) return null;
  const rest = body.slice(prose.length);
  if (!rest) return { head: prose, receipts: "" };
  if (!rest.startsWith(RECEIPT_JOIN)) return null;
  return { head: prose, receipts: rest.slice(RECEIPT_JOIN.length).trim() };
}

export function reconcileChatPlanReply(
  reply: string,
  message: string | null | undefined,
  applied: Array<{ type: ChatActionType; result?: unknown; error?: string }>,
  drafts: unknown[]
): string {
  const explicit = hasExplicitPlanEditIntent(message);
  const today = localDateISO();
  const restructureEntries = applied.filter((entry) => entry.type === "plan_restructure");
  const planEntries = applied.filter((entry) => entry.type === "plan_update");
  const restructureDraft = drafts.some((draft: any) => Array.isArray(draft?.parsed?.days));

  if (restructureEntries.length) {
    const result = recordOrNull(restructureEntries[0].result) ?? {};
    const decision = recordOrNull(result.decision);
    const status = String(decision?.status ?? "");
    if (result.scheduled === true || status === "announced" || status === "pending") {
      const boundary = String(result.effective_date ?? decision?.effective_date ?? "the next training boundary");
      const receipt = `Scheduled for ${boundary}; Cairn will adapt the structural plan automatically. Use Discuss with coach on Today to work through it, or say Undo before it lands.`;
      return replyClaimsPlanSuccess(reply) ? receipt : appendReceipt(reply, receipt);
    }
    if (result.review_required === true || status === "review") {
      const receipt = pickDayVariant(RESTRUCTURE_HELD_FOR_REVIEW_VARIANTS, today, "chat-restructure-held");
      return replyClaimsPlanSuccess(reply) ? receipt : appendReceipt(reply, receipt);
    }
    if (result.persisted === true || status === "applied") {
      return "The structural plan change is live and recorded with its Undo history.";
    }
    const reason = String(result.error ?? restructureEntries[0].error ?? "the server could not own the change");
    return pickDayVariant(RESTRUCTURE_NOT_SCHEDULED_VARIANTS, today, "chat-restructure-not-scheduled")(reason);
  }

  if (!planEntries.length) {
    // A run edit IS this turn's plan change; reconcileChatRunReply owns its receipt.
    // Without this the athlete would read "No plan change was saved" directly above
    // the verified run receipt.
    if (applied.some((entry) => entry.type === "set_run")) return reply;
    if (restructureDraft && (explicit || replyClaimsPlanSuccess(reply))) {
      return pickDayVariant(RESTRUCTURE_DRAFT_VARIANTS, today, "chat-restructure-draft");
    }
    if (explicit && replyClaimsPlanSuccess(reply)) {
      return pickDayVariant(PLAN_NOT_SAVED_VARIANTS, today, "chat-plan-not-saved");
    }
    if (explicit) {
      const note = pickDayVariant(PLAN_NO_CHANGE_APPENDED_VARIANTS, today, "chat-plan-no-change-note");
      return appendReceipt(reply, note);
    }
    if (replyClaimsPlanSuccess(reply)) {
      return pickDayVariant(PLAN_UNTOUCHED_BY_QUESTION_VARIANTS, today, "chat-plan-question-no-op");
    }
    return reply;
  }

  const results = planEntries.map((entry) => recordOrNull(entry.result) ?? {});
  const verifiedResults = results.filter((result) => result.ok === true && result.verified === true);
  const verified = results.length > 0 && verifiedResults.length === results.length;
  if (verified) {
    if (!explicit && !replyClaimsPlanSuccess(reply)) return reply;
    const days = [
      ...new Set(
        results.flatMap((result: any) =>
          Array.isArray(result.verification?.days)
            ? result.verification.days.map((day: any) => Number(day?.day_number)).filter(Number.isFinite)
            : []
        )
      ),
    ];
    const receipt = `Saved and verified${days.length ? ` plan day${days.length > 1 ? "s" : ""} ${days.join(", ")}` : " the plan change"}.`;
    const adjustments = results.flatMap((result: any) => (Array.isArray(result.clamped) ? result.clamped : []));
    const clampReceipt = adjustments.length
      ? ` Adjusted ${adjustments
          .slice(0, 3)
          .map(
            (entry: any) =>
              `${String(entry.field).replaceAll("_", " ")} from ${entry.requested} to ${entry.applied == null ? "no prescribed load" : entry.applied}`
          )
          .join("; ")} to supported safe bounds.`
      : "";
    return appendReceipt(reply, `${receipt}${clampReceipt}`);
  }

  // Although the chat contract asks the model for one atomic plan_update, remain
  // truthful when an off-contract response emits several. Each proposal is atomic,
  // but a later one may commit after an earlier one failed. Never collapse that
  // mixed outcome into "your plan is unchanged" (the exact failure that makes the
  // live Today screen and coach prose disagree).
  if (verifiedResults.length) {
    repo.invalidateDayRead();
    const days = [
      ...new Set(
        verifiedResults.flatMap((result: any) =>
          Array.isArray(result.verification?.days)
            ? result.verification.days.map((day: any) => Number(day?.day_number)).filter(Number.isFinite)
            : []
        )
      ),
    ];
    const failed = results.filter((result) => !(result.ok === true && result.verified === true));
    const firstFailed = failed[0] as any;
    const failedEntry = planEntries[results.indexOf(firstFailed)];
    const reason =
      Array.isArray(firstFailed?.reasons) && firstFailed.reasons.length
        ? String(firstFailed.reasons[0])
        : String(firstFailed?.error ?? failedEntry?.error ?? "that part did not verify against the stored plan");
    return `Part of that request is live: saved and verified${days.length ? ` plan day${days.length > 1 ? "s" : ""} ${days.join(", ")}` : " the successful plan change"}. Another requested plan change was not saved: ${reason} The stored plan reflects only the verified change${verifiedResults.length > 1 ? "s" : ""}.`;
  }

  const first = results[0] as any;
  const reason =
    Array.isArray(first?.reasons) && first.reasons.length
      ? String(first.reasons[0])
      : String(first?.error ?? planEntries[0]?.error ?? "the stored plan did not verify the requested final state");
  // Do not retain model prose that claimed a write succeeded. The server receipt is
  // authoritative and is what gets persisted/displayed after the streamed draft.
  if (first?.ok === true && (Array.isArray(first?.applied) || first?.restructured === true)) {
    return pickDayVariant(PLAN_WRITE_UNVERIFIED_VARIANTS, today, "chat-plan-write-unverified");
  }
  if (explicit || replyClaimsPlanSuccess(reply)) {
    return pickDayVariant(PLAN_NOT_LIVE_VARIANTS, today, "chat-plan-not-live")(reason);
  }
  return reply;
}

function replyClaimsRunSuccess(reply: string): boolean {
  if (!/\b(?:runs?|running|mileage|tempo|intervals?)\b/i.test(reply)) return false;
  return /\b(?:i(?:['’]ve| have)?\s+(?:now\s+)?(?:set|saved|updated|changed|adjusted|moved|shortened|lengthened|scheduled|swapped|added)|(?:is|are)\s+(?:now\s+)?(?:set|saved|updated|changed|on\s+the\s+plan|live|scheduled))\b/i.test(
    reply
  );
}

// The run counterpart to reconcileChatPlanReply: whatever the model said it would do,
// the athlete-facing receipt is composed from the stored run READ BACK after the
// apply. A run that did not land — refused as ambiguous, held for review, or verified
// against the store and found missing — says so in plain words.
export function reconcileChatRunReply(
  reply: string,
  message: string | null | undefined,
  applied: Array<{ type: ChatActionType; result?: unknown; error?: string }>
): string {
  const today = localDateISO();
  const entries = applied.filter((entry) => entry.type === "set_run");
  if (!entries.length) {
    if (hasExplicitRunEditIntent(message) && replyClaimsRunSuccess(reply)) {
      return pickDayVariant(RUN_NOT_SAVED_VARIANTS, today, "chat-run-not-saved");
    }
    return reply;
  }
  const results = entries.map((entry) => recordOrNull(entry.result) ?? {});
  const verified = results.filter((result) => result.verified === true);
  const scheduled = results.filter((result) => result.verified !== true && result.scheduled === true);
  const held = results.filter(
    (result) => result.verified !== true && result.scheduled !== true && result.review_required === true
  );
  const failed = results.filter(
    (result) => result.verified !== true && result.scheduled !== true && result.review_required !== true
  );

  const lines: string[] = [];
  if (verified.length) {
    const receipts = verified.map((result: any) => {
      const check = recordOrNull(result.verification) as any;
      return `day ${check?.day_number}: ${describeRun(check?.run)}`;
    });
    lines.push(
      `Saved and verified — ${receipts.join("; ")}. Your lifting on ${verified.length > 1 ? "those days" : "that day"} is untouched.`
    );
  }
  for (const result of scheduled) {
    const decision = recordOrNull((result as any).decision);
    const boundary = String((result as any).effective_date ?? decision?.effective_date ?? "the next training boundary");
    lines.push(
      `That run change is scheduled for ${boundary}; say Undo before it lands if you'd rather keep this week as it is.`
    );
  }
  if (held.length) {
    lines.push(pickDayVariant(RUN_HELD_FOR_REVIEW_VARIANTS, today, "chat-run-held"));
  }
  for (const result of failed) {
    const check = recordOrNull((result as any).verification) as any;
    const mismatches = Array.isArray(check?.mismatches) ? check.mismatches : [];
    const reason = String(
      (result as any).error ??
        (mismatches.length && !mismatches.includes("not_applied")
          ? `the stored run doesn't match what you asked for (${mismatches.join(", ")})`
          : "the run write did not land")
    );
    lines.push(pickDayVariant(RUN_NOT_LIVE_VARIANTS, today, "chat-run-not-live")(reason));
  }
  const receipt = lines.join(" ");
  // Model prose that claimed the write already happened is replaced, not decorated —
  // the server receipt is the only truthful account of what is stored.
  if (!verified.length && replyClaimsRunSuccess(reply)) return receipt;
  return appendReceipt(reply, receipt);
}

export function reconcileStrengthObjectiveReply(
  reply: string,
  message: string | null | undefined,
  applied: Array<{ type: ChatActionType; result?: unknown; error?: string }>
): string {
  if (!hasExplicitStrengthObjectiveIntent(message)) return reply;
  const today = localDateISO();
  const entries = applied.filter((entry) => entry.type === "set_strength_objective");
  if (!entries.length) {
    if (
      /\b(?:i(?:['’]ve| have)?\s+(?:saved|set|updated|created)|(?:strength\s+)?(?:goal|target|objective)\s+is\s+(?:now\s+)?(?:saved|set|active|live))\b/i.test(
        reply
      )
    ) {
      return pickDayVariant(STRENGTH_OBJECTIVE_NOT_SAVED_VARIANTS, today, "chat-objective-not-saved");
    }
    const note = pickDayVariant(STRENGTH_OBJECTIVE_NONE_SAVED_VARIANTS, today, "chat-objective-none-saved");
    return appendReceipt(reply, note);
  }
  const results = entries.map((entry) => recordOrNull(entry.result) ?? {});
  const verified = results.length > 0 && results.every((result) => result.ok === true && result.verified === true);
  if (!verified) {
    const reason = String(entries.find((entry) => entry.error)?.error ?? "the stored objective did not verify");
    return pickDayVariant(STRENGTH_OBJECTIVE_UNVERIFIED_VARIANTS, today, "chat-objective-unverified")(reason);
  }
  const objective = results.at(-1)?.objective as any;
  const exercise = String(objective?.exercise ?? "the anchor lift");
  const target = Number(objective?.target_est_1rm);
  const receipt = Number.isFinite(target)
    ? `Strength objective saved and verified: ${exercise} to ${target} lb estimated 1RM.`
    : `Strength objective saved and verified: ${exercise}.`;
  return appendReceipt(reply, receipt);
}

// Prose claiming the Undo already happened. Subject-anchored on purpose, exactly as
// replyClaimsRunSuccess is topic-anchored: an honest sentence ("nothing was reverted",
// "I couldn't put that back") shares every verb with the false claim and differs only
// in who is doing what, so a bare verb match would correct the truthful reply too.
function replyClaimsRevertSuccess(reply: string): boolean {
  return /\b(?:i(?:['’]ve| have)?\s+(?:now\s+|already\s+)?(?:reverted|undone|undid|restored|cancell?ed|rolled\s+(?:it|that|this|them|the\s+\S+|your\s+\S+)\s+back|put\s+(?:it|that|this|them|the\s+\S+|your\s+\S+)\s+back)|(?:it|that|this|the\s+(?:change|decision|update|plan|split|program)|your\s+(?:plan|split|program))(?:['’]s)?\s+(?:has\s+been|have\s+been|been|is|was|are|were)\s+(?:now\s+)?(?:reverted|rolled\s+back|undone|cancell?ed|put\s+back|restored))\b/i.test(
    reply
  );
}

// The Undo counterpart to reconcileChatPlanReply / reconcileChatRunReply. A
// revert_decision the athlete never authorized (the shared question guard) leaves no
// trace in `applied` — a refused action is not an applied one, and `applied` is the
// chat bubble's own receipt ledger — so the refused decision ids ride their own
// channel out of applyChatActions. Either way the decision is still live, so the false
// sentence never survives — the same rule reconcileChatRunReply applies to a run write
// that did not land, for the same reason: leaving it at the top of the bubble makes
// the server's account argue with itself. A reply that never claimed the Undo happened
// is returned untouched.
//
// This reconciler runs LAST, so what it reads is rarely what the model wrote: one
// bubble can claim both a plan/run change and an Undo, and the earlier reconcilers
// either REPLACE the whole prose (their write did not land) or APPEND a receipt under
// it (their write did). Both shapes used to lose something.
//
//   - Replaced: the revert claim went with the discarded prose, and a claim-only guard
//     reading the rewritten text then said nothing about a decision the athlete asked
//     to undo and that is still live. So the claim is judged against the ORIGINAL model
//     reply, and the correction is APPENDED under the receipt — that receipt is
//     truthful and must not be thrown away.
//   - Appended: the reply is the model's prose followed by receipts, so replacing the
//     whole thing deleted a verified plan/objective receipt along with the false
//     sentence — the athlete's bench really did change and the bubble no longer said
//     so. Every append goes through `appendReceipt`, so `splitAppendedReceipts` can
//     take the same reply apart on the same shape: the correction takes the top and
//     the receipts keep their place below it.
//
// Both arms therefore keep every truthful receipt and drop only the false claim.
export function reconcileChatRevertReply(
  reply: string,
  applied: Array<{ type: ChatActionType; result?: unknown; error?: string }>,
  refusedReverts: readonly number[],
  proposedReply: string
): string {
  const today = localDateISO();
  const failed = applied.filter(
    (entry) => entry.type === "revert_decision" && (recordOrNull(entry.result)?.ok !== true || !!entry.error)
  );
  // Nothing to correct: a true claim about a revert that really applied passes through.
  if (!failed.length && !refusedReverts.length) return reply;
  const claimsNow = replyClaimsRevertSuccess(reply);
  // Judged on the model's own words, not on the data alone: a reply that never claimed
  // the Undo happened stays untouched, deliberately.
  if (!claimsNow && !replyClaimsRevertSuccess(proposedReply)) return reply;
  let correction: string;
  if (failed.length) {
    const reason = String(
      recordOrNull(failed[0].result)?.error ?? failed[0].error ?? "the decision could not be rolled back"
    );
    correction = pickDayVariant(DECISION_REVERT_FAILED_VARIANTS, today, "chat-revert-failed")(reason);
  } else {
    const id = refusedReverts.find((value) => Number.isInteger(value) && value > 0);
    const how = id ? `undo decision ${id}` : "undo that decision";
    correction = pickDayVariant(DECISION_REVERT_NOT_AUTHORIZED_VARIANTS, today, "chat-revert-not-authorized")(how);
  }
  if (!claimsNow) return appendReceipt(reply, correction);
  return withoutLeadingProse(reply, proposedReply, correction);
}

// The claim is still standing, so the model's prose is still the head of the reply and
// anything appendReceipt put after it is a receipt to keep. Swap the head for the
// correction and re-append the rest. No receipts — or a reply this head did not build
// (no receipt variant reads as a revert claim, so a standing claim means the prose
// survived and that cannot happen today) — collapses to a plain replace.
function withoutLeadingProse(reply: string, proposedReply: string, correction: string): string {
  const split = splitAppendedReceipts(reply, proposedReply);
  if (!split?.receipts) return correction;
  return appendReceipt(correction, split.receipts);
}

function logPhotoFood(actions: ChatAction[], turn: any): { id: number; [key: string]: unknown } | null {
  if (!turn.image_path) return null;
  // Pull out any log_food the agent emitted (it saw the photo) to seed the note.
  const lf = actions.find((a): a is LogFoodAction => a.type === "log_food");
  // Vision/classification may decide that a bare or ambiguous photo is not food.
  // Only a structured log_food action authorizes a photo-backed food-note write.
  if (!lf) return null;
  const message = (turn.message ?? "").toString();
  // Same shared coercion as the text lane, with the basis that is actually true
  // here: this estimate came from LOOKING AT A PICTURE. The vision enrichment
  // refines it in place afterwards and re-stamps the same provenance.
  const parsedNote: Record<string, unknown> = normalizeFoodCaptureParsed(lf, {
    summary: (lf?.summary ?? lf?.name ?? (message.trim() || "Photo meal")).toString(),
    fallbackBasis: "photo",
  });
  // raw="" so addFoodNote does NOT queue the TEXT enricher (that would overwrite the
  // vision estimate). We enqueue the dedicated food_photo job explicitly below.
  // A photo of last night's plate is still last night's meal, so the agent's resolved
  // date/time rides along exactly as it does on the text path — and `lenient` for the
  // same reason: a misread clock must never cost the athlete the plate they captured.
  const meal = (lf?.meal ?? "meal").toString();
  let note: { id: number; [key: string]: unknown } | null = null;
  try {
    const created = repo.addFoodNote(meal, "", parsedNote, turn.image_path, {
      date: stringOrUndefined(lf?.date),
      eaten_at: stringOrUndefined(lf?.eaten_at),
      lenient: true,
    });
    const row = recordOrNull(created);
    note = row && typeof row.id === "number" ? (row as { id: number; [key: string]: unknown }) : null;
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
  } catch {
    /* settings unreadable → leave the note as-is */
  }
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
  lane?: ChatLane | null;
  policy_version?: string | null;
  reason_codes?: string[];
  requested_model?: string | null;
  requested_reasoning?: string | null;
  effective_reasoning?: string | null;
  streaming?: boolean;
  ttft_ms?: number | null;
  chat_turn_id?: number;
  attempt_index?: number;
  escalation_source?: ChatLane | null;
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
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0]
      ?.slice(0, 220) || ""
  );
}

function displayAgent(name: string | null | undefined): string {
  const s = String(name || "agent").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Agent";
}

/** Record a chat-path provider hold. Failure-safe — telemetry never kills a turn. */
function noteChatAvailability(agent: string, failure: AgentFailure): void {
  try {
    repo.noteAgentFailure(agent, failure, "chat");
  } catch {
    /* availability is advisory; a write failure must not fail the turn */
  }
}

/** A completed reply is proof the provider answers — drop any stale hold. */
function clearChatAvailability(agent: string): void {
  try {
    repo.clearAgentAvailability(agent);
  } catch {
    /* advisory */
  }
}

export function classifyChatAgentResult(agent: string, result: AgentResult): ChatAgentAttempt | null {
  const raw = String(result.raw || "");
  const stderr = String(result.stderr || "");
  const usage = {
    exit_code: result.code,
    model: result.usage?.model ?? null,
    input_tokens: result.usage?.input_tokens ?? null,
    output_tokens: result.usage?.output_tokens ?? null,
  };
  // Availability is read ONLY when the run did not produce a reply (or the CLI
  // emitted its machine-readable rate-limit event). A real coaching answer that
  // happens to contain the words "rate limit" is a reply, not a failure — the
  // same reason the auth rule has always carried its infra-sized guard.
  const suspect = result.code !== 0 || !raw.trim() || !!parseStreamRateLimitEvent(`${raw}\n${stderr}`);
  let failure = suspect ? classifyAgentFailure(agent, { code: result.code, raw, stderr }, new Date()) : null;
  // A clean-exit LIMIT banner is the same shape of problem as a clean-exit login
  // banner, and several CLIs print exactly that: "You've hit your weekly limit ·
  // resets 8am" on stdout, exit 0. `suspect` is false for that run, so the banner
  // became the chat bubble AND the turn cleared the provider's hold. Read the
  // limit/payment arms unconditionally, behind the same infra-sized guard the auth
  // rule uses — never the broad rate arms, whose words live in coaching prose.
  if (!failure) failure = classifyLimitBannerText(raw, stderr, new Date());
  // A clean-exit login banner has always been caught here, and still is: the auth
  // rule carries its own infra-sized guard, so a long reply that merely mentions
  // signing in stays a reply.
  if (!failure && isAuthFailureText(raw, stderr)) {
    failure = { state: "auth_required", window: null, resets_at: null, detail: "Not connected" };
  }
  if (failure && (availabilityHolds(failure.state) || failure.state === "permission_denied")) {
    // A limited/unpaid/signed-out provider is durable news: recording it here is
    // what lets the NEXT chat turn route around it before spawning anything.
    if (availabilityHolds(failure.state)) noteChatAvailability(agent, failure);
    return {
      agent,
      ok: false,
      status: failure.state,
      error_class: failure.state,
      error_message: failure.detail,
      ...usage,
    };
  }
  if (result.code !== 0) {
    return {
      agent,
      ok: false,
      status: "error",
      error_class: "process_exit",
      error_message: "Agent process exited",
      ...usage,
    };
  }
  if (!raw.trim()) {
    return {
      agent,
      ok: false,
      status: "empty_reply",
      error_class: "empty_reply",
      error_message: "Agent returned no reply",
      ...usage,
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
      lane: attempt.lane ?? null,
      policy_version: attempt.policy_version ?? null,
      reason_codes: attempt.reason_codes ?? [],
      requested_model: attempt.requested_model ?? null,
      requested_reasoning: attempt.requested_reasoning ?? null,
      effective_reasoning: attempt.effective_reasoning ?? null,
      streaming: attempt.streaming ?? false,
      ttft_ms: attempt.ttft_ms ?? null,
      chat_turn_id: attempt.chat_turn_id ?? null,
      attempt_index: attempt.attempt_index ?? null,
      escalation_source: attempt.escalation_source ?? null,
    });
  } catch {
    /* telemetry never breaks the loop */
  }
}

function summarizeChatAttempts(attempts: ChatAgentAttempt[]): string {
  const failed = attempts.filter((a) => !a.ok);
  if (!failed.length) return "All agents failed to produce a reply";
  return failed
    .slice(-4)
    .map((a) => `${displayAgent(a.agent)}: ${a.error_message || a.error_class || a.status}`)
    .join("; ");
}

function chatFailureReply(e: any): {
  content: string;
  agent: string | null;
  meta: Record<string, unknown>;
  error: string;
} {
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

export function buildChatProviderOrder(
  chosen: string | null | undefined,
  autoOrder: string[],
  options: {
    preferWeb?: boolean;
    preserveSelectedFirst?: boolean;
    definitions?: Record<string, Pick<AgentDef, "web_access"> | undefined>;
  } = {}
): string[] {
  const selected = String(chosen ?? "").trim();
  const base = [...new Set([...(selected && selected !== "auto" ? [selected] : []), ...autoOrder.filter(Boolean)])];
  if (!options.preferWeb) return base;
  const web = base.filter((name) => options.definitions?.[name]?.web_access === true);
  if (!web.length) return base;
  if (options.preserveSelectedFirst && selected && selected !== "auto") {
    return [...new Set([selected, ...web, ...base])];
  }
  return [...web, ...base.filter((name) => !web.includes(name))];
}

/** Healthy providers first; anything under a live availability hold goes last. */
export function orderChatProvidersByAvailability(order: string[], now: Date = new Date()): string[] {
  if (order.length < 2) return order;
  const heldNames = new Set<string>();
  for (const name of order) {
    try {
      if (repo.getAgentAvailability(name, now)) heldNames.add(name);
    } catch {
      /* availability is advisory — an unreadable hold never reorders anything */
    }
  }
  if (!heldNames.size) return order;
  return [...order.filter((n) => !heldNames.has(n)), ...order.filter((n) => heldNames.has(n))];
}

type RuntimeChatProfile = {
  requested: ResolvedChatProfile | null;
  effective: ResolvedChatProfile | null;
  execution: ResolvedChatProfile | null;
  unsupported: string | null;
};

export function resolveRuntimeChatProfile(
  definition: AgentDef | undefined,
  requested: ResolvedChatProfile | null,
  explicitlyBound = false
): RuntimeChatProfile {
  if (!requested) return { requested: null, effective: null, execution: null, unsupported: null };
  try {
    if (!definition) throw new Error("Unknown agent");
    const resolved = resolveAgentExecutionProfile(definition, requested);
    const effective = {
      ...(resolved.effective.model ? { model: resolved.effective.model } : {}),
      reasoning: resolved.effective.reasoning ?? requested.reasoning,
    };
    return {
      requested,
      effective,
      // Pass only capability-validated values. In particular, a legacy custom
      // provider with no profile flags runs with its own defaults.
      execution: Object.keys(resolved.effective).length ? effective : null,
      unsupported: null,
    };
  } catch (error: any) {
    return {
      requested,
      effective: null,
      execution: null,
      unsupported: explicitlyBound ? cleanCliLine(error?.message ?? error) || "Execution profile unsupported" : null,
    };
  }
}

// The leash for one chat attempt, scaled by how much thinking this turn asked for.
// A deep-lane turn runs at high effort, which a flat 90s cap can kill mid-think —
// the run then reads as a failed agent and the rotation hands a deep question to
// someone else mid-thought, which is the same silent fallthrough the job ops had.
// Waiting is the better failure mode here: chat STREAMS (the athlete watches tokens
// land, so a long turn is visibly working), every pending bubble carries a Stop, the
// turn is durable in SQLite across a reload, and a genuinely dead CLI fails at spawn
// rather than at the 90s mark. Chat's lane profile stays authoritative for
// model/effort — that is why this reads the resolved profile rather than the task
// table, where `chat` deliberately has no entry; only the timeout follows it.
// Falls back to the REQUESTED effort when `execution` is null (a provider that takes
// no profile flags, or a binding it rejected): we could not pin the effort, but the
// question was still a deep one, so the leash tracks the ambition of the turn.
export function chatTurnTimeoutMs(profile: Pick<RuntimeChatProfile, "execution" | "requested">): number {
  return interactiveTimeoutFor(profile.execution?.reasoning ?? profile.requested?.reasoning);
}

export function chatExecutionAttemptKey(
  lane: ChatLane | null,
  agent: string,
  profile: Pick<RuntimeChatProfile, "effective">
): string {
  return `${lane ?? "legacy"}\0${agent}\0${profile.effective?.model ?? ""}\0${profile.effective?.reasoning ?? "default"}`;
}

// ---------- bounded coach reads for chat ----------
// Depth-on-demand for the conversational loop: before writing its prose reply, the
// chat agent may request bounded, server-owned reads. A read request is BARE JSON with
// NO reply marker, so the chat stream gate shows nothing for it — the read rounds are
// invisible and only the final reply streams. Budget mirrors the ordinary job loop (6
// calls / 3 rounds / 256 KB). Framing is prose-first (the reply comes back through the
// output contract, not a "final JSON"), so chat renders its own contract over the shared
// closed read catalog rather than the job loop's coachReadContract.
const CHAT_READ_MAX_CALLS = COACH_READ_ORDINARY_MAX_CALLS;

export type ChatReadState = {
  rounds: number;
  calls: number;
  bytes: number;
  completed: CompletedCoachRead[];
};

export function newChatReadState(): ChatReadState {
  return { rounds: 0, calls: 0, bytes: 0, completed: [] };
}

function chatReadContract(maxCalls: number): string {
  return `\n\n=== OPTIONAL: LOOK SOMETHING UP FIRST ===
The DATA above is your authoritative baseline. Use a read ONLY when a specific unanswered question about the athlete's own history would materially change your reply. Do not fish — reply directly when DATA already answers it.
To look something up, return ONLY this JSON object this turn — no reply marker, no prose, nothing else:
{"kind":"coach_read","requests":[{"tool":"read_training_window","args":{"end_date":null,"weeks":6}}]}
The server runs the reads and calls you again with the verified results; THEN write your normal reply using the OUTPUT CONTRACT above (the reply marker, then prose). Otherwise, just reply now.
At most ${maxCalls} reads across at most ${COACH_READ_MAX_ROUNDS} rounds. Never request SQL, files, exports, settings, secrets, writes, or another agent/job.
Available reads (the server validates every name and argument against this catalog):
${JSON.stringify(coachReadToolList())}`;
}

function chatReadResultsBlock(completed: CompletedCoachRead[], callsRemaining: number): string {
  return `\n\n=== VERIFIED COACH READ RESULTS ===
These server-produced results answer only the requests shown. Treat truncation explicitly; do not infer unavailable raw data.
${JSON.stringify(completed)}
Reads remaining: ${callsRemaining}. Now write your normal reply using the OUTPUT CONTRACT above, unless one more specific read is truly necessary.`;
}

// The suffix appended to the chat prompt for a given read state. When reads are
// exhausted (budget spent), the contract is dropped entirely so the agent simply replies.
export function chatReadPromptSuffix(state: ChatReadState, exhausted: boolean): string {
  if (exhausted) return "";
  const contract = chatReadContract(CHAT_READ_MAX_CALLS);
  if (!state.completed.length) return contract;
  return `${contract}${chatReadResultsBlock(state.completed, CHAT_READ_MAX_CALLS - state.calls)}`;
}

// A completed agent turn that is a bounded-read PROTOCOL turn (not the reply). A reply
// marker anywhere means the agent chose to answer, so it is never a protocol turn even
// if it also contains stray JSON. Otherwise a well-formed coach_read object is the request.
// Classify a completed turn into: a valid bounded-read request, a coach_read-SHAPED
// turn whose normalization FAILED (an unknown tool, out-of-bounds arg, or empty
// requests), or neither. The distinction matters: a malformed coach_read turn is raw
// protocol JSON with no reply marker — it must NOT be accepted as the coach's reply
// (that would leak the JSON into the bubble). It mirrors the job loop's handling
// (`runChosen.ts` snapshotOnly): drop the read contract and re-ask the same agent for
// a plain reply, rather than persisting the protocol JSON as prose.
export type ChatReadTurnClass =
  | { kind: "query"; query: CoachReadQueryTurn }
  | { kind: "malformed" }
  | { kind: "none" };

export function classifyChatReadTurn(raw: string): ChatReadTurnClass {
  const text = String(raw ?? "");
  if (text.includes(CHAT_REPLY_SENTINEL)) return { kind: "none" };
  const parsed = extractJson(text);
  if (!isCoachReadQueryTurn(parsed)) return { kind: "none" };
  const query = normalizeCoachReadQueryTurn(parsed);
  return query ? { kind: "query", query } : { kind: "malformed" };
}

export function detectChatReadRequest(raw: string): CoachReadQueryTurn | null {
  const cls = classifyChatReadTurn(raw);
  return cls.kind === "query" ? cls.query : null;
}

// Execute one validated read round into the shared state. Returns "stop" when the round
// would exceed the round/call/byte budget (the caller then drops the contract and forces
// a reply); "ok" when the round's reads all landed within budget. A caller AbortSignal is
// authoritative — it throws "canceled" mid-round, never a partial retry.
export async function runChatReadRound(
  state: ChatReadState,
  query: CoachReadQueryTurn,
  ctx: {
    runId: string;
    signal: AbortSignal;
    execute?: (
      request: CoachReadToolRequest,
      context: CoachReadToolExecutionContext
    ) => CoachReadToolResult | Promise<CoachReadToolResult>;
  }
): Promise<"ok" | "stop"> {
  if (state.rounds >= COACH_READ_MAX_ROUNDS || state.calls + query.requests.length > CHAT_READ_MAX_CALLS) return "stop";
  const execute = ctx.execute ?? executeCoachReadTool;
  state.rounds++;
  for (const request of query.requests) {
    if (ctx.signal.aborted) throw new Error("canceled");
    const result = await execute(request, { run_id: ctx.runId, op: "chat" });
    state.calls++;
    const item = { request, result };
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (state.bytes + itemBytes > COACH_READ_ORDINARY_MAX_BYTES) return "stop";
    state.bytes += itemBytes;
    state.completed.push(item);
  }
  return "ok";
}

// Injectable execution seam so the read-augmented completion loop is testable offline
// (no CLI/network): production callers omit `deps` and get the real runners + executor.
export interface ChatCompletionDeps {
  runAgent?: typeof runAgent;
  runAgentStreaming?: typeof runAgentStreaming;
  supportsStream?: (name: string) => boolean;
  executeCoachRead?: (
    request: CoachReadToolRequest,
    context: CoachReadToolExecutionContext
  ) => CoachReadToolResult | Promise<CoachReadToolResult>;
}

export async function runChatCompletion(
  id: number,
  turn: any,
  history: { role: string; content: string; at?: string }[],
  signal: AbortSignal,
  deps: ChatCompletionDeps = {}
): Promise<{ agent: string; raw: string; attempts: ChatAgentAttempt[] }> {
  const runAgentDep = deps.runAgent ?? runAgent;
  const runStreamingDep = deps.runAgentStreaming ?? runAgentStreaming;
  const supportsStream = deps.supportsStream ?? agentSupportsStream;
  const executeCoachRead = deps.executeCoachRead ?? executeCoachReadTool;
  const readRunId = crypto.randomUUID();
  const readState = newChatReadState();
  let readExhausted = false;
  const readPhase = (text: string): void => emit(id, { type: "progress", text });
  // Per-task routing: a "chat → claude" pin resolves an "auto"/blank turn to that
  // agent first; runtime failure still falls through to the other usable auto
  // providers without weakening the selected lane.
  const chosen = repo.resolveAgentForTask("chat", turn.agent);
  const definitions = loadAgents();
  const attempts: ChatAgentAttempt[] = [];
  let decision: ChatRoutingDecision | null = turn.routing ?? null;
  const baseOrder = buildChatProviderOrder(chosen, repo.pickAgentOrder(), {
    preferWeb: decision?.reason_codes.includes("current_research") === true,
    // A named provider is an explicit athlete choice. A Settings route pin is
    // still eligible as fallback, but current research starts with an enabled
    // web-capable provider whenever the turn itself was auto-routed.
    preserveSelectedFirst: Boolean(turn.agent && turn.agent !== "auto"),
    definitions,
  });
  // A provider that just told us it is out of quota / credit / signed out moves
  // BEHIND the healthy ones, so the streaming primary and the rotation both skip
  // it without spawning. It is still in the list: if every healthy provider
  // fails, it becomes the only remaining option and gets probed — a hold is a
  // prediction, never an exclusion.
  const order = orderChatProvidersByAvailability(baseOrder);
  if (!order.length) throw new Error("No agents enabled — turn one on in Settings.");
  const adaptive = !!decision;
  const bindings = adaptive ? repo.getSettings().chat_profile_bindings : {};
  const seen = new Set<string>();
  let attemptIndex = 0;
  let escalationSource: ChatLane | null = null;
  let lastErr: any = null;
  let lanePasses = 0;
  const unsupportedSeen = new Set<string>();

  const profileFor = (name: string): RuntimeChatProfile => {
    if (!decision) return resolveRuntimeChatProfile(definitions[name], null);
    const requested = resolveChatProfile(decision.lane, name, bindings);
    const explicitlyBound = Boolean((bindings as any)?.[name]?.[decision.lane]);
    return resolveRuntimeChatProfile(definitions[name], requested, explicitlyBound);
  };
  const decorate = (
    attempt: ChatAgentAttempt,
    profile: ReturnType<typeof profileFor>,
    streaming: boolean,
    ttft: number | null
  ): ChatAgentAttempt => ({
    ...attempt,
    lane: decision?.lane ?? null,
    policy_version: decision?.policy_version ?? null,
    reason_codes: decision?.reason_codes ?? [],
    requested_model: profile.requested?.model ?? null,
    requested_reasoning: profile.requested?.reasoning ?? null,
    effective_reasoning: profile.effective?.reasoning ?? null,
    streaming,
    ttft_ms: ttft,
    chat_turn_id: id,
    attempt_index: ++attemptIndex,
    escalation_source: escalationSource,
  });
  const noteUnsupportedProfile = (name: string, profile: RuntimeChatProfile): void => {
    if (!profile.unsupported) return;
    const key = `${decision?.lane ?? "legacy"}\0${name}\0${profile.requested?.model ?? ""}\0${profile.requested?.reasoning ?? ""}`;
    if (unsupportedSeen.has(key)) return;
    unsupportedSeen.add(key);
    const started = Date.now();
    const attempt = decorate(
      {
        agent: name,
        ok: false,
        status: "profile_unsupported",
        error_class: "profile_unsupported",
        error_message: profile.unsupported,
      },
      profile,
      false,
      null
    );
    recordChatAttempt(attempt, started, false, false);
    attempts.push(attempt);
    emit(id, { type: "progress", text: `Using ${displayAgent(name)} defaults…` });
  };
  const escalate = (raw: string, lane: ChatLane, stream?: ReturnType<typeof createChatStreamFilter>): boolean => {
    const target = parseChatEscalationRequest(raw, lane);
    if (!target || !decision) return false;
    const updated = repo.escalateChatTurnRouting(id, target) as any;
    decision = updated?.routing ?? decision;
    stream?.reset();
    if (!stream) emit(id, { type: "reset" });
    emit(id, { type: "routing", routing: decision as ChatRoutingDecision });
    escalationSource = lane;
    return true;
  };

  laneLoop: while (true) {
    if (signal.aborted) throw new Error("canceled");
    lanePasses++;
    if (lanePasses > 3) throw new ChatCompletionError(attempts, "Adaptive routing exceeded the bounded lane count");
    const lane = decision?.lane ?? null;
    const prompt = buildChatPrompt(
      history,
      turn.message || "(no text — see the attached photo)",
      turn.image_path || undefined,
      lane ? { lane } : {}
    );

    // Streaming first, exactly once for an equivalent provider/profile tuple. The
    // stream-capable primary may first request bounded reads (bare JSON, no reply marker
    // → the gate shows nothing) across up to a few rounds, then stream the reply. Read
    // follow-ups re-stream the SAME agent, so they are gated by `seen` only ONCE.
    const first = order[0];
    const firstProfile = profileFor(first);
    noteUnsupportedProfile(first, firstProfile);
    const firstKey = chatExecutionAttemptKey(lane, first, firstProfile);
    if (!seen.has(firstKey) && supportsStream(first)) {
      seen.add(firstKey);
      // Inner loop: re-run the SAME first agent for each read follow-up, then stream the reply.
      while (true) {
        const streamPrompt = `${prompt}${chatReadPromptSuffix(readState, readExhausted)}`;
        const started = Date.now();
        let ttft: number | null = null;
        const stream = createChatStreamFilter((event) => {
          if (event.type === "delta" && event.text && ttft == null) ttft = Date.now() - started;
          emit(id, event);
        });
        streamFilters.set(id, stream);
        try {
          const res = await runStreamingDep(first, streamPrompt, {
            signal,
            timeoutMs: chatTurnTimeoutMs(firstProfile),
            ...(firstProfile.execution ?? {}),
            onProgress: stream.progress,
            onDelta: stream.push,
          });
          stream.finish();
          const raw = String(res.raw ?? "");
          if (lane && parseChatEscalationRequest(raw, lane)) {
            const attempt = decorate(
              { agent: first, ok: true, status: "escalated", exit_code: res.code, model: res.usage?.model ?? null },
              firstProfile,
              true,
              ttft
            );
            attempt.escalation_source = lane;
            recordChatAttempt(attempt, started, true, false);
            attempts.push(attempt);
            escalate(raw, lane, stream);
            continue laneLoop;
          }
          const readTurn = readExhausted ? ({ kind: "none" } as ChatReadTurnClass) : classifyChatReadTurn(raw);
          if (readTurn.kind === "query") {
            const attempt = decorate(
              { agent: first, ok: true, status: "reading_data", exit_code: res.code, model: res.usage?.model ?? null },
              firstProfile,
              true,
              ttft
            );
            recordChatAttempt(attempt, started, true, false);
            attempts.push(attempt);
            const outcome = await runChatReadRound(readState, readTurn.query, {
              runId: readRunId,
              signal,
              execute: executeCoachRead,
            });
            stream.reset(); // the protocol turn streamed nothing (no reply marker) — clear the bubble
            readPhase("Reviewing your history…");
            if (outcome === "stop") readExhausted = true;
            continue; // re-stream the same agent with the verified results (or, if exhausted, plain)
          }
          if (readTurn.kind === "malformed") {
            // A coach_read-shaped turn that failed normalization must never be accepted
            // as the reply (raw protocol JSON would leak into the bubble). Drop the read
            // contract and re-stream the SAME agent once for a plain reply. Bounded:
            // readExhausted stops the next pass from detecting a read at all.
            const attempt = decorate(
              { agent: first, ok: true, status: "read_malformed", exit_code: res.code, model: res.usage?.model ?? null },
              firstProfile,
              true,
              ttft
            );
            recordChatAttempt(attempt, started, true, false);
            attempts.push(attempt);
            stream.reset(); // the malformed protocol JSON never earns the bubble
            readExhausted = true;
            readPhase("Reviewing your history…");
            continue;
          }
          const classified = classifyChatAgentResult(first, res);
          const attempt = decorate(
            classified ?? {
              agent: first,
              ok: true,
              status: "ok",
              exit_code: res.code,
              model: res.usage?.model ?? null,
              input_tokens: res.usage?.input_tokens ?? null,
              output_tokens: res.usage?.output_tokens ?? null,
            },
            firstProfile,
            true,
            ttft
          );
          recordChatAttempt(attempt, started, !classified, false);
          attempts.push(attempt);
          if (!classified) return { agent: first, raw, attempts };
        } catch (e: any) {
          if (signal.aborted) throw e;
          const attempt = decorate(classifyChatException(first, e), firstProfile, true, ttft);
          recordChatAttempt(attempt, started, false, false);
          attempts.push(attempt);
          lastErr = e;
        }
        stream.reset();
        stream.progress("Trying another route…");
        break; // streaming produced no reply → fall to the rotation
      }
    }

    for (const name of order) {
      if (signal.aborted) throw new Error("canceled");
      const profile = profileFor(name);
      noteUnsupportedProfile(name, profile);
      const key = chatExecutionAttemptKey(lane, name, profile);
      if (seen.has(key)) continue;
      seen.add(key);
      // A non-streaming provider can request reads too; a read follow-up re-runs the
      // SAME agent (inner loop) without re-consulting `seen`.
      // Inner loop: re-run the SAME agent for each read follow-up, then take its reply.
      while (true) {
        const runPrompt = `${prompt}${chatReadPromptSuffix(readState, readExhausted)}`;
        const started = Date.now();
        try {
          emit(id, { type: "progress", text: "Asking the coach…" });
          let res = await runAgentDep(name, runPrompt, {
            signal,
            timeoutMs: chatTurnTimeoutMs(profile),
            ...(profile.execution ?? {}),
          });
          let raw = String(res.raw ?? "");
          let retriedEmpty = false;
          if (!raw.trim() && res.code === 0 && !signal.aborted) {
            retriedEmpty = true;
            res = await runAgentDep(name, runPrompt + EMPTY_CHAT_RETRY_SUFFIX, {
              signal,
              timeoutMs: chatTurnTimeoutMs(profile),
              ...(profile.execution ?? {}),
            });
            raw = String(res.raw ?? "");
          }
          if (lane && parseChatEscalationRequest(raw, lane)) {
            const attempt = decorate(
              { agent: name, ok: true, status: "escalated", exit_code: res.code, model: res.usage?.model ?? null },
              profile,
              false,
              null
            );
            attempt.escalation_source = lane;
            recordChatAttempt(attempt, started, true, retriedEmpty);
            attempts.push(attempt);
            escalate(raw, lane);
            continue laneLoop;
          }
          const readTurn = readExhausted ? ({ kind: "none" } as ChatReadTurnClass) : classifyChatReadTurn(raw);
          if (readTurn.kind === "query") {
            const attempt = decorate(
              { agent: name, ok: true, status: "reading_data", exit_code: res.code, model: res.usage?.model ?? null },
              profile,
              false,
              null
            );
            recordChatAttempt(attempt, started, true, retriedEmpty);
            attempts.push(attempt);
            const outcome = await runChatReadRound(readState, readTurn.query, {
              runId: readRunId,
              signal,
              execute: executeCoachRead,
            });
            readPhase("Reviewing your history…");
            if (outcome === "stop") readExhausted = true;
            continue; // re-run the same agent with the verified results
          }
          if (readTurn.kind === "malformed") {
            // A coach_read-shaped turn that failed normalization must never be accepted
            // as the reply. Drop the read contract and re-run the SAME agent once for a
            // plain reply. Bounded: readExhausted stops the next pass detecting a read.
            const attempt = decorate(
              { agent: name, ok: true, status: "read_malformed", exit_code: res.code, model: res.usage?.model ?? null },
              profile,
              false,
              null
            );
            recordChatAttempt(attempt, started, true, retriedEmpty);
            attempts.push(attempt);
            readExhausted = true;
            readPhase("Reviewing your history…");
            continue;
          }
          const classified = classifyChatAgentResult(name, res);
          const attempt = decorate(
            classified ?? {
              agent: name,
              ok: true,
              status: "ok",
              exit_code: res.code,
              model: res.usage?.model ?? null,
              input_tokens: res.usage?.input_tokens ?? null,
              output_tokens: res.usage?.output_tokens ?? null,
            },
            profile,
            false,
            null
          );
          recordChatAttempt(attempt, started, !classified, retriedEmpty);
          attempts.push(attempt);
          if (!classified) return { agent: name, raw, attempts };
          lastErr = new Error(`${name}: ${classified.error_message || classified.error_class || classified.status}`);
        } catch (e: any) {
          if (signal.aborted) throw e;
          lastErr = e;
          const attempt = decorate(classifyChatException(name, e), profile, false, null);
          recordChatAttempt(attempt, started, false, false);
          attempts.push(attempt);
        }
        break;
      }
    }
    throw new ChatCompletionError(attempts, lastErr?.message || "No distinct execution profile remained");
  }
}

// User-requested Stop. Flips the turn state first (so the worker's catch knows
// not to write an error reply), then aborts any live subprocess, then emits the
// terminal event. No-op if the turn already finished. Returns the turn or null.
export function cancelTurn(id: number) {
  const turn = repo.cancelChatTurn(id);
  if (!turn) return null;
  try {
    controllers.get(id)?.abort();
  } catch {
    /* not running */
  }
  emit(id, { type: "canceled", turn });
  return turn;
}

// Shutdown helper: abort every live chat subprocess so a redeploy/SIGTERM stops
// cleanly instead of orphaning CLIs. Durable recovery (recoverChatTurns) still
// re-handles any interrupted 'running' row on the next boot.
export function abortAllTurns() {
  for (const c of controllers.values()) {
    try {
      c.abort();
    } catch {
      /* not running */
    }
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
  try {
    estimate = repo.estimateMarkerCandidates(String(text ?? ""));
  } catch {
    estimate = 0;
  }
  return estimate >= CHAT_LAB_CONFIRM_MIN || agentMarkerCount >= CHAT_LAB_CONFIRM_MIN;
}

export interface LabConfirmDraft {
  id: number;
  marker_estimate: number;
  summary: string | null;
  kind: string | null;
}

// Persist a substantial pasted lab as a pending_confirm health document and return the
// meta descriptor the chat surface renders a one-tap Confirm from. The raw text lands on
// disk (mirroring the Health tab's paste), and the chat agent's inline markers are stashed
// under parsed.pending_markers — a NON-leaking key (getMarkerHistory reads parsed.markers)
// used only as the graceful-degrade fallback when confirm can't reach a transcriber.
// Returns null on a write failure so the caller can fall back to the immediate apply.
function persistPendingLabDraft(
  a: { markers?: unknown; summary?: unknown; doc_date?: unknown; kind?: string },
  message: string,
  estimate: number
): LabConfirmDraft | null {
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
  ctx: {
    agent: string;
    imagePath?: string | null;
    message?: string | null;
    skipLogFood?: boolean;
    turnId?: number | null;
    userMessageId?: number | null;
  }
): {
  applied: Array<{ type: ChatActionType; result?: unknown; error?: string }>;
  drafts: unknown[];
  labConfirms: LabConfirmDraft[];
  refusedReverts: number[];
} {
  const applied: Array<{ type: ChatActionType; result?: unknown; error?: string }> = [];
  const drafts: unknown[] = [];
  const labConfirms: LabConfirmDraft[] = [];
  // Ids of revert_decision actions the gate refused. They deliberately stay OUT of
  // `applied` (which the PWA renders as the turn's applied-action chips and the tests
  // read as "nothing was applied"); reconcileChatRevertReply is their only consumer.
  const refusedReverts: number[] = [];
  const message = ctx.message ?? "";
  const foodOnly = isFoodOnlyTurn(message, ctx.imagePath);
  const explicitGoalIntent = !foodOnly && hasExplicitGoalIntent(message);
  const explicitStrengthObjectiveIntent = !foodOnly && hasExplicitStrengthObjectiveIntent(message);
  const inheritedClinical = inheritedClinicalLineage({
    turnId: ctx.turnId,
    userMessageId: ctx.userMessageId,
    message,
  });
  const actions = normalizeChatActions(Array.isArray(parsed) ? parsed : parsed?.actions);
  let runActionsApplied = 0;
  for (const a of actions) {
    try {
      switch (a.type) {
        case "log_activity":
          applied.push({ type: a.type, result: repo.addActivity({ text: a.text, date: a.date, notes: a.notes }) });
          break;
        case "log_set":
          applied.push({ type: a.type, result: repo.logSetByName(repo.resolveImplicitPlanDay(a)) });
          break;
        case "set_profile": {
          const { type, ...patch } = a;
          if (!explicitGoalIntent) {
            for (const field of GOAL_IDENTITY_FIELDS) delete patch[field];
          }
          if (Object.keys(patch).length) applied.push({ type: a.type, result: repo.setProfile(patch) });
          break;
        }
        case "set_training_intent": {
          if (!explicitGoalIntent) break;
          const { type, ...trainingIntent } = a;
          const normalizedIntent = repo.normalizeTrainingIntent(trainingIntent);
          if (!normalizedIntent) break;
          applied.push({ type: a.type, result: repo.setProfile({ training_intent: normalizedIntent }) });
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
        case "set_strength_objective": {
          if (!explicitStrengthObjectiveIntent) break;
          const objective = repo.setStrengthObjective({
            exercise: a.exercise,
            target_kind: a.target_kind,
            target_est_1rm: a.target_est_1rm,
          });
          // Server-owned readback of the exact immutable row. Creation may close
          // an already-reached target atomically; later verified exact-lift sets
          // durably close an active target.
          const stored = repo.getStrengthObjective(objective.id);
          const verified =
            !!stored &&
            stored.id === objective.id &&
            stored.exercise_key === objective.exercise_key &&
            stored.target_kind === objective.target_kind &&
            Number(stored.target_est_1rm) === Number(objective.target_est_1rm) &&
            (stored.status === "active" || stored.status === "completed");
          applied.push({
            type: a.type,
            result: { ok: verified, verified, objective: stored, journey: verified ? repo.getStrengthJourney() : null },
          });
          break;
        }
        case "add_memory":
          applied.push({ type: a.type, result: repo.addMemory(a.content, memoryKind(a.kind), "chat") });
          break;
        case "update_memory":
          // A fact CHANGED: edit the existing memory row in place (self-updating
          // memory — the agent saw the row id in DATA.memory and is correcting it).
          applied.push({
            type: a.type,
            result: repo.updateMemory(Number(a.id), { content: a.content, kind: memoryKind(a.kind) }) ?? {
              error: "not found",
              id: a.id,
            },
          });
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
          //
          // Through the SHARED food-capture coercion (src/foodCapture.ts), the same
          // one the two enrichment paths run: bands and provenance are enum-checked,
          // macros are clamped instead of stored as whatever the model typed, and an
          // absent meal total is built up from the ingredient rows. Chat is ~two
          // thirds of all logging, so this is where nutrition_pattern actually
          // reaches the bloodwork-correlation machinery.
          //
          // The basis FALLBACK is the honest default for this lane: the athlete's
          // sentence rarely states a weight, so an unlabeled estimate is
          // estimated_from_foods, never user_report. The model overrides it when
          // they did state one.
          const parsedNote = normalizeFoodCaptureParsed(a, {
            summary: (a.summary ?? a.name ?? message ?? "meal").toString(),
            fallbackBasis: "estimated_from_foods",
          });
          applied.push({
            type: a.type,
            // `lenient` throughout this lane: the model resolved when the meal
            // happened out of the sentence, so a date it guessed wrong degrades to
            // today and the food is still logged. Never lose a meal over a clock.
            // The meal SLOT is left to addFoodNote, which names an unstated label
            // from the stated time — one implementation, so REST and MCP get it too.
            result: repo.addFoodNote(String(a.meal || "meal"), "", parsedNote, ctx.imagePath ?? undefined, {
              date: stringOrUndefined(a.date),
              eaten_at: stringOrUndefined(a.eaten_at),
              lenient: true,
            }),
          });
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
            // Undefined leaves the stored day/time alone — "that was last night"
            // moves it; correcting only a macro must not restamp the clock.
            date: stringOrUndefined(a.date),
            // An explicit null has to survive as null: updateFoodNote reads it as
            // "unstate the time" ("I don't actually recall when"), and collapsing it
            // to undefined here would quietly make that correction unreachable from
            // chat even though the repo supports it and the action contract offers it.
            eaten_at: stringOrNullOrUndefined(a.eaten_at),
            lenient: true,
          });
          applied.push({ type: a.type, result: result ?? { error: "not found", id: a.id } });
          break;
        }
        case "log_weight":
          applied.push({ type: a.type, result: repo.logWeight(a.weight_lb, stringOrUndefined(a.date), stringOrUndefined(a.note)) });
          break;
        case "log_health": {
          // Defense in depth: normalizeChatActions already rejects the imaging kind
          // and aliases such as MRI/X-ray. Never let a future direct caller bypass
          // the first-class Records imaging workflow through this marker path.
          if (a.kind === "imaging") break;
          // Lab/DEXA results reported in chat. Markers feed the trend view.
          const parsedDocObject =
            a.parsed && typeof a.parsed === "object" ? (a.parsed as Record<string, unknown>) : null;
          const markers = Array.isArray(a.markers)
            ? a.markers
            : parsedDocObject && Array.isArray(parsedDocObject.markers)
              ? parsedDocObject.markers
              : [];
          // A SUBSTANTIAL pasted panel is a big write → propose→apply: persist a
          // pending_confirm draft (raw text on disk, no markers committed yet) the user
          // confirms, which then transcribes it through the completeness-first, Claude-
          // first health ingest. A small inline mention still applies immediately below.
          const estimate = (() => {
            try {
              return repo.estimateMarkerCandidates(message);
            } catch {
              return 0;
            }
          })();
          if (isSubstantialLabPaste(message, markers.length)) {
            const draft = persistPendingLabDraft(a, message, estimate);
            if (draft) {
              labConfirms.push(draft);
              break;
            }
            // couldn't persist (fs error) → fall through to the immediate apply
          }
          const parsedDoc = parsedDocObject ? parsedDocObject : markers.length ? { markers } : null;
          applied.push({
            type: a.type,
            result: repo.addHealthDocument({
              kind: a.kind,
              doc_date: stringOrNull(a.doc_date),
              summary: stringOrNull(a.summary),
              parsed_json: parsedDoc,
              enrichment_status: "done",
            }),
          });
          // New markers from chat → refresh the deterministic markers→directives
          // propagation (idempotent), mirroring the enrichment path.
          try {
            repo.deriveDirectives();
          } catch {
            /* never fail the chat action */
          }
          break;
        }
        case "add_context_event":
          // A just-mentioned event (a late concert, travel, illness) shapes TODAY via
          // the active-context effect; addContextEvent busts the cached Brief at the
          // repo layer now (so EVERY surface reacts, not just chat).
          applied.push({
            type: a.type,
            result: repo.addContextEvent({
              kind: a.kind,
              title: stringOrUndefined(a.title),
              detail: stringOrUndefined(a.detail),
              start_date: stringOrUndefined(a.start_date),
              end_date: stringOrUndefined(a.end_date),
              meta: a.meta,
            }),
          });
          break;
        case "resolve_context_event":
          // Confirmed healed / over → close it (keeps the record); resolveContextEvent
          // busts the Brief at the repo layer.
          applied.push({
            type: a.type,
            result: repo.resolveContextEvent(Number(a.id), stringOrUndefined(a.date)) ?? {
              error: "not found",
              id: a.id,
            },
          });
          break;
        case "log_context_tag": {
          // Cheap, athlete-volunteered life context (travel/drinks/rough sleep/work
          // crunch/feeling off) — evidence for the insight generator and the
          // confounder machinery, never advice. Idempotent ADD only: a conversational
          // re-mention must never silently untag (that's the one-tap chip's job, a
          // deliberate second tap — chat has no equivalent deliberate "remove" signal).
          const day = stringOrUndefined(a.date);
          const results = (Array.isArray(a.tags) ? a.tags : []).map((tag) => {
            try {
              return { tag, result: repo.ensureContextTag(String(tag), day) };
            } catch (e) {
              return { tag, error: String((e as Error)?.message || e) };
            }
          });
          applied.push({ type: a.type, result: results });
          break;
        }
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
        case "report_training_symptom":
          if (!hasExplicitSymptomReportIntent(message)) break;
          applied.push({
            type: a.type,
            result: repo.reportTrainingSymptom({
              area_text: a.area_text,
              // The athlete's MESSAGE is the record; area_text is the label the
              // model pulled out of it. Storing only the label is what used to lose
              // everything after the first clause.
              report_text: message,
              report_source_kind: "chat",
              onset_on: stringOrUndefined(a.onset_on),
              source_kind: "chat_explicit",
            }),
          });
          break;
        case "resolve_training_symptom":
          // Parity with the surfaces and MCP: chat could open a pain note but never
          // close one, so the only way out of the loop was to open the app.
          if (!hasExplicitSymptomResolveIntent(message)) break;
          applied.push({
            type: a.type,
            result: repo.resolveTrainingSymptomByArea(a.area_text, stringOrUndefined(a.on)) ?? {
              error: "no open pain note matches that area",
              area_text: a.area_text,
            },
          });
          break;
        case "log_checkin":
          applied.push({
            type: a.type,
            result: repo.addCheckin(chatCheckinDate(a.date, localDateISO()) ?? "", {
              energy: a.energy,
              sleep_feel: a.sleep_feel,
              soreness: a.soreness,
              mood: a.mood,
              note: a.note == null ? null : String(a.note),
              source_kind: "chat",
              capture_note_symptom: hasExplicitSymptomReportIntent(message),
            }),
          });
          break;
        case "plan_update":
          // Text-only food turns still cannot trigger plan edits. An attached
          // image action is allowed to reach autonomy only because the server
          // classifies that attachment as clinical and guarantees a review hold.
          if (foodOnly && !ctx.imagePath) break;
          {
            const clinicalProvenance =
              clinicalPlanProvenance({ message, action: a, imagePath: ctx.imagePath }) ?? inheritedClinical;
            applied.push({
              type: a.type,
              result: applyBackgroundPlanUpdate(
                ctx.agent,
                a.summary,
                todayPlanUpdateChanges(message, a.changes),
                hasExplicitPlanEditIntent(message),
                clinicalProvenance
              ),
            });
          }
          break;
        case "set_run": {
          // Same food-turn boundary as plan_update: a meal log never edits training.
          if (foodOnly && !ctx.imagePath) break;
          // ONE run per turn. A week of runs is a restructure — it belongs to the
          // run-plan proposal the athlete accepts, not to a burst of chat writes.
          if (runActionsApplied >= 1) {
            applied.push({
              type: a.type,
              result: {
                ok: false,
                verified: false,
                persisted: false,
                committed: false,
                error: "only one run is adjusted per turn; a whole week of runs goes through the run plan",
              },
            });
            break;
          }
          runActionsApplied += 1;
          applied.push({
            type: a.type,
            result: applyChatRunPrescription(ctx.agent, a, hasExplicitRunEditIntent(message)),
          });
          break;
        }
        case "plan_restructure":
          if (foodOnly || !hasExplicitPlanEditIntent(message)) break;
          applied.push({
            type: a.type,
            result: routeChatPlanRestructure(
              ctx.agent,
              a.summary,
              a.days,
              clinicalPlanProvenance({ message, action: a, imagePath: ctx.imagePath }) ?? inheritedClinical
            ),
          });
          break;
        case "revert_decision":
          if (!hasExplicitDecisionRevertIntent(message, Number(a.id))) {
            refusedReverts.push(Number(a.id));
            break;
          }
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
  return { applied, drafts, labConfirms, refusedReverts };
}
