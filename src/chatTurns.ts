import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "./db.js";
import { createProgressBus, createSerialRunner } from "./jobRunner.js";
import * as repo from "./repo.js";
import { UPLOADS_DIR } from "./uploadPaths.js";
import { buildChatPrompt, parseChatEscalationRequest, parseChatReply, CHAT_REPLY_SENTINEL } from "./prompt.js";
import { extractChatHttpUrls, fetchChatLinkedPages, type ChatLinkedPage } from "./chatLinks.js";
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
  loadAgents,
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
// The re-ask lookup that used to live here moved beside the hand-off it guards, in
// src/domain/brain/structure-request.ts — both doors (chat and the Plan tab) have to
// resolve to the ONE standing flag, so one module owns both.
import { describeLandingDay, requestStructureRedraw } from "./domain/brain/structure-request.js";
import { enqueueAgentJob } from "./agentJobs.js";
import { diagnosticErrorName, recordAsyncFailure } from "./diagnostics.js";
import { resolveChatProfile, type ChatLane, type ChatRoutingDecision } from "./chatRouting.js";
import { log } from "./log.js";
import {
  carriesPlanApplyAffirmation,
  hasExplicitGoalIntentInContext,
  hasExplicitPlanEditIntent,
  hasExplicitPlanEditIntentInContext,
  hasExplicitRunEditIntent,
  hasExplicitStrengthObjectiveIntent,
  hasExplicitSymptomReportIntent,
  hasExplicitSymptomResolveIntent,
  hasSelfContainedPlanEditIntent,
  isFoodOnlyTurn,
  isInstantFoodCaptureDecision,
  isLeadingQuestion,
} from "./chat-intent.js";
import {
  describeRun,
  recordOrNull,
  reconcileChatPlanReply,
  reconcileChatRevertReply,
  reconcileChatRunReply,
  reconcileGoalIdentityReply,
  reconcileStrengthObjectiveReply,
  reconcileTrainingStructureReply,
} from "./chat-reconcile.js";
import {
  buildChatProviderOrder,
  chatExecutionAttemptKey,
  chatTurnTimeoutMs,
  cleanCliLine,
  orderChatProvidersByAvailability,
  resolveRuntimeChatProfile,
  type RuntimeChatProfile,
} from "./chat-routing-runtime.js";

// The intent gates, reply reconcilers and provider/profile runtime now live in their own
// modules. They are re-exported here so every existing importer, route and test keeps
// resolving them from "./chatTurns.js".
export {
  carriesPlanApplyAffirmation,
  draftsSessionPrescription,
  hasExplicitGoalIntent,
  hasExplicitGoalIntentInContext,
  hasExplicitPlanEditIntent,
  hasExplicitPlanEditIntentInContext,
  hasExplicitRunEditIntent,
  hasExplicitStrengthObjectiveIntent,
  hasExplicitSymptomReportIntent,
  hasExplicitSymptomResolveIntent,
  hasSelfContainedPlanEditIntent,
  isFoodOnlyTurn,
  isInstantFoodCaptureDecision,
  isLeadingQuestion,
  mentionsWhen,
  readsAsSessionProposal,
  shouldCreatePhotoFoodPlaceholder,
} from "./chat-intent.js";
export {
  DECISION_REVERT_FAILED_VARIANTS,
  DECISION_REVERT_NOT_AUTHORIZED_VARIANTS,
  describeRun,
  GOAL_NONE_SAVED_VARIANTS,
  GOAL_NOT_SAVED_VARIANTS,
  PLAN_NO_CHANGE_APPENDED_VARIANTS,
  PLAN_NOT_LIVE_VARIANTS,
  PLAN_NOT_SAVED_VARIANTS,
  PLAN_SCHEDULED_LANDS_TODAY_VARIANTS,
  PLAN_SCHEDULED_NOT_LIVE_VARIANTS,
  PLAN_TODAY_SCOPED_NOT_APPLIED_VARIANTS,
  PLAN_UNTOUCHED_BY_QUESTION_VARIANTS,
  PLAN_WRITE_UNVERIFIED_VARIANTS,
  reconcileChatPlanReply,
  reconcileChatRevertReply,
  reconcileChatRunReply,
  reconcileGoalIdentityReply,
  reconcileStrengthObjectiveReply,
  reconcileTrainingStructureReply,
  RESTRUCTURE_DRAFT_VARIANTS,
  RESTRUCTURE_HELD_FOR_REVIEW_VARIANTS,
  RESTRUCTURE_NOT_SCHEDULED_VARIANTS,
  RUN_HELD_FOR_REVIEW_VARIANTS,
  RUN_NOT_LIVE_VARIANTS,
  RUN_NOT_SAVED_VARIANTS,
  STRENGTH_OBJECTIVE_NONE_SAVED_VARIANTS,
  STRENGTH_OBJECTIVE_NOT_SAVED_VARIANTS,
  STRENGTH_OBJECTIVE_UNVERIFIED_VARIANTS,
  TRAINING_STRUCTURE_NOT_FLAGGED_VARIANTS,
  TRAINING_STRUCTURE_UNVERIFIED_VARIANTS,
} from "./chat-reconcile.js";
export {
  buildChatProviderOrder,
  chatExecutionAttemptKey,
  chatTurnTimeoutMs,
  orderChatProvidersByAvailability,
  resolveRuntimeChatProfile,
} from "./chat-routing-runtime.js";

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
  log.error(`[chat] turn#${id} failed (${diagnosticErrorName(e)})`);
});

export function enqueueChatTurn(id: number): void {
  runner.enqueue(id);
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

    const { applied, drafts, labConfirms, refusedReverts, droppedGoalFields, appliedGoalPatch, explicitPlanEdit } =
      applyChatActions(
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
    // The SAME reading the apply path used. Reconciling on a second, per-message-only
    // reading is how a go-ahead that really did authorize a change still read as a
    // question to the receipt.
    const planReply = reconcileChatPlanReply(proposedReply, turn.message, applied, drafts, explicitPlanEdit);
    const runReply = reconcileChatRunReply(planReply, turn.message, applied);
    const objectiveReply = reconcileStrengthObjectiveReply(runReply, turn.message, applied);
    const goalReply = reconcileGoalIdentityReply(objectiveReply, droppedGoalFields, appliedGoalPatch);
    const structureReply = reconcileTrainingStructureReply(goalReply, applied);
    const reply = reconcileChatRevertReply(structureReply, applied, refusedReverts, proposedReply);
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

function proposalMeta(draft: unknown): { id: unknown; kind: "restructure" | "plan_update"; summary: unknown } {
  const row = recordOrNull(draft) ?? {};
  const parsed = recordOrNull(row.parsed);
  return {
    id: row.id,
    kind: parsed && Array.isArray(parsed.days) ? "restructure" : "plan_update",
    summary: parsed?.summary,
  };
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

// The athlete's own recent, still-live messages — the negotiation window above.
// Current message excluded (it is the one being judged).
const GOAL_CONTEXT_LOOKBACK_MESSAGES = 8;
// Only the immediately preceding coach message matters for a go-ahead, but the live
// log interleaves roles, so read a few rows to be sure of finding it.
const PRIOR_ASSISTANT_LOOKBACK_MESSAGES = 6;
function recentAthleteStatements(excludeMessageId?: number | null): string[] {
  try {
    const rows = repo.listChatMessages(GOAL_CONTEXT_LOOKBACK_MESSAGES * 3) as any[];
    return rows
      .filter(
        (r) => r?.role === "user" && (excludeMessageId == null || Number(r.id) !== Number(excludeMessageId))
      )
      .slice(-GOAL_CONTEXT_LOOKBACK_MESSAGES)
      .map((r) => String(r.content ?? ""));
  } catch {
    return [];
  }
}

// The coach's immediately preceding message in the LIVE thread, and whether that same
// turn stored a plan draft. Both are SERVER records, which is the whole point: what
// turns a bare "ok" into an instruction is the shape of what the athlete is agreeing
// to, never the model's own claim about it. Read only when the message needs it.
function priorAssistantContext(excludeMessageId?: number | null): { message: string; drafted: boolean } {
  try {
    const before = excludeMessageId == null ? Number.MAX_SAFE_INTEGER : Number(excludeMessageId);
    const rows = repo.listChatMessagesBefore(before, PRIOR_ASSISTANT_LOOKBACK_MESSAGES) as any[];
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      if (row?.role !== "assistant") continue;
      const meta = recordOrNull(row.meta);
      const drafts = Array.isArray(meta?.drafts) ? meta.drafts : [];
      const applied = Array.isArray(meta?.applied) ? meta.applied : [];
      return {
        message: String(row.content ?? ""),
        drafted:
          drafts.length > 0 ||
          applied.some(
            (entry: unknown) =>
              String(recordOrNull(entry)?.type ?? "") === "plan_update" &&
              Number(recordOrNull(recordOrNull(entry)?.result)?.proposal_id) > 0
          ),
      };
    }
  } catch {
    /* an unreadable history is simply no context, never an authorization */
  }
  return { message: "", drafted: false };
}

// A training-STRUCTURE request is the athlete asking for a different shape of
// training. Chat cannot restructure a plan, so the action only records an ask-tier
// decision for them to confirm — nothing mutates — and the gate is deliberately
// permissive: the model reads the sentence, and the one thing the server refuses is
// the reading every other training gate here already refuses, a leading question
// ("Should I train all six lifts?"), which is a conversation and not an ask.
export function flagTrainingStructureAuthorized(message: string | null | undefined): boolean {
  const text = String(message ?? "")
    .replace(/[‘’]/g, "'")
    .trim();
  if (!text) return false;
  return !isLeadingQuestion(text);
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

// "This is about TODAY." The wording the athlete uses when the change is only worth
// making while the day it was reasoned about is still the day: the named day, the part
// of it, or the fact that they are walking into the gym as they type.
const PLAN_TODAY_SCOPE_RE =
  /\b(?:today(?:['’]s)?|tonight|this\s+(?:morning|afternoon|evening)|right\s+now)\b|\b(?:heading|going|on\s+my\s+way|off)\b[^.!?]{0,40}\b(?:gym|train|training|lift|session|workout)\b|\bat\s+the\s+gym\b|\babout\s+to\s+(?:train|lift|start)\b/i;
// A named future/day target is an explicit athlete override, not an implicit "today"
// reference. Keep it authoritative even if the sentence also compares it with today
// (for example, "leave today alone; change day 3").
const PLAN_NAMED_OTHER_DAY_RE =
  /\b(?:tomorrow|later\s+this\s+week|next\s+(?:session|workout|week|push|pull|legs?|lower|upper|full(?:[- ]body)?|run|ride|cardio)|day\s*(?:number\s*)?\d+|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

// Does this instruction belong to today and nowhere else? The ONE reading both the
// day-scoping of the changes below and the autonomy hand-off use, so a sentence can
// never be re-aimed at a day it was not read as naming.
function planUpdateTargetsToday(message: string | null | undefined, explicit: boolean): boolean {
  const text = String(message ?? "").trim();
  if (!explicit || !PLAN_TODAY_SCOPE_RE.test(text)) return false;
  return !PLAN_NAMED_OTHER_DAY_RE.test(text);
}

function todayPlanUpdateChanges(message: string | null | undefined, changes: unknown[], explicit: boolean): unknown[] {
  const text = String(message ?? "").trim();
  if (!planUpdateTargetsToday(text, explicit)) return changes;
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

// The plan days one turn's changes name. Used only to decide whether TODAY's prepared
// session is one of them; an unnamed/malformed day contributes nothing.
function planChangeDayNumbers(changes: unknown[]): number[] {
  const days = new Set<number>();
  for (const change of changes) {
    const day = Number((change as Record<string, unknown> | null)?.day_number);
    if (Number.isInteger(day) && day > 0) days.add(day);
  }
  return [...days];
}

function applyBackgroundPlanUpdate(
  agent: string,
  summary: unknown,
  changes: unknown[],
  explicitUserRequest: boolean,
  clinicalProvenance: ClinicalPlanProvenance | null,
  todayScoped = false
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
    today_scoped: todayScoped,
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
  // The plan is the template; the composition is the session the athlete is HOLDING.
  // Writing one without re-taking the other is what let a confirmed change sit on the
  // plan all day while Today kept showing the movements it replaced.
  if (persisted) {
    try {
      repo.refreshPreparedDayForPlanChange({ date: localDateISO(), day_numbers: planChangeDayNumbers(changes) });
    } catch (err) {
      recordAsyncFailure("chat_turns", "refresh_prepared_day", err);
    }
  }
  // WHAT HAPPENED, in the words the receipt needs. `applied` is the only "it is live"
  // signal; everything else is a wait, and a wait the athlete is never told about is
  // the bug this closes. `scheduled` mirrors routeChatPlanRestructure's own field.
  const decisionStatus = String(result?.decision?.status ?? stored?.autonomy?.status ?? "");
  const scheduled =
    result?.ok === true &&
    result?.applied !== true &&
    result?.held_reason !== "today_scoped" &&
    (decisionStatus === "announced" || decisionStatus === "pending");
  const effectiveDate = typeof result?.effective_date === "string" ? result.effective_date : null;
  return {
    background: !explicitUserRequest,
    explicit_user_request: explicitUserRequest,
    today_scoped: todayScoped,
    proposal_id: (proposal as any).id,
    ...result,
    scheduled,
    ...(scheduled && effectiveDate ? { landing_label: describeLandingDay(effectiveDate, localDateISO()) } : {}),
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
    log.error(`[chat] turn#${turn.id}: failed to create photo food note: ${message}`);
    return null;
  }
  if (!note) return null;
  // Mark the note pending + enqueue the vision job — unless enrichment is off, in
  // which case the as-logged note (with the chat agent's first-pass estimate, if
  // any) simply stands, no background refine.
  try {
    if (repo.getSettings().enrich_enabled) {
      repo.setFoodNoteEnrichStatus(note.id, "pending");
      // The athlete is in chat waiting on this read; it goes ahead of background
      // housekeeping (Garmin catch-up, exercise canonicalization) in the serial queue.
      import("./enrich.js").then((m) => m.enqueueEnrich("food_photo", note.id, { front: true })).catch(() => {});
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
export type ChatReadTurnClass = { kind: "query"; query: CoachReadQueryTurn } | { kind: "malformed" } | { kind: "none" };

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
  /** Offline tests inject this so a fixture URL never hits the network. */
  fetchLinkedPages?: typeof fetchChatLinkedPages;
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
  const fetchLinkedPages = deps.fetchLinkedPages ?? fetchChatLinkedPages;
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
  const wantsWeb = decision?.reason_codes.includes("current_research") === true;
  // The CLI's own tools stay off for a coaching turn (the DATA block is the whole
  // picture, and an autonomous CLI otherwise explores its cwd until the timeout);
  // only a current-research turn is allowed to reach for live web search.
  const chatTools: "none" | "provider" = wantsWeb ? "provider" : "none";
  const baseOrder = buildChatProviderOrder(chosen, repo.pickAgentOrder(), {
    preferWeb: wantsWeb,
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

  // Same pattern as listing a health-export folder: fetch pasted URLs HERE so a
  // headless CLI never reaches for curl (agy auto-denies `command` and exits
  // empty). Capture stays receipt-fast and skips the network.
  let linkedPages: ChatLinkedPage[] = [];
  const urls = (decision?.lane ?? "coach") === "capture" ? [] : extractChatHttpUrls(String(turn.message ?? ""));
  if (urls.length) {
    emit(id, { type: "progress", text: "Reading the link you sent…" });
    linkedPages = await fetchLinkedPages(urls, { signal });
  }

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
      {
        ...(lane ? { lane } : {}),
        ...(linkedPages.length ? { linkedPages } : {}),
      }
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
            tools: chatTools,
            // The athlete is watching this stream: it takes the spawn cap's reserved
            // interactive permit rather than queueing behind batch lanes.
            priority: "interactive",
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
              {
                agent: first,
                ok: true,
                status: "read_malformed",
                exit_code: res.code,
                model: res.usage?.model ?? null,
              },
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
            tools: chatTools,
            priority: "interactive",
            ...(profile.execution ?? {}),
          });
          let raw = String(res.raw ?? "");
          let retriedEmpty = false;
          if (!raw.trim() && res.code === 0 && !signal.aborted) {
            retriedEmpty = true;
            res = await runAgentDep(name, runPrompt + EMPTY_CHAT_RETRY_SUFFIX, {
              signal,
              timeoutMs: chatTurnTimeoutMs(profile),
              tools: chatTools,
              priority: "interactive",
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
    log.info(`[chat] recovered ${requeue.length} queued + ${interrupted} interrupted turn(s).`);
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
    log.error(`[chat] failed to persist pending lab draft: ${e instanceof Error ? e.message : String(e)}`);
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
    // Test seam: the athlete's own recent messages for the goal-negotiation
    // carry-forward. Omitted in the real flow, where they are read from the live
    // (unarchived) chat log excluding the current message.
    recentAthleteMessages?: readonly string[];
    // Test seam: the coach's immediately preceding message and whether that turn
    // drafted a plan, for the go-ahead carry-forward. Omitted in the real flow, where
    // both are read from the live chat log (priorAssistantContext).
    priorAssistant?: { message?: string | null; drafted?: boolean };
    // Test seam: how a structure request's build job is handed to the agent-job
    // runner. Omitted in the real flow, where it is enqueueAgentJob.
    enqueueJob?: (id: number) => void;
  }
): {
  applied: Array<{ type: ChatActionType; result?: unknown; error?: string }>;
  drafts: unknown[];
  labConfirms: LabConfirmDraft[];
  refusedReverts: number[];
  droppedGoalFields: string[];
  appliedGoalPatch: Record<string, unknown> | null;
  /** Did the athlete's own words (or their go-ahead to a drafted session) ask for this? */
  explicitPlanEdit: boolean;
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
  const explicitGoalIntent =
    !foodOnly &&
    hasExplicitGoalIntentInContext(
      message,
      ctx.recentAthleteMessages ?? recentAthleteStatements(ctx.userMessageId)
    );
  // Goal-identity writes the gate DROPPED (so the reply can say so instead of the
  // prose claiming a lock over nothing) and the goal fields that APPLIED (receipt).
  const droppedGoalFields: string[] = [];
  let appliedGoalPatch: Record<string, unknown> | null = null;
  const explicitStrengthObjectiveIntent = !foodOnly && hasExplicitStrengthObjectiveIntent(message);
  // ONE reading of this sentence for the whole turn. A message that names its own
  // instruction ("apply it to my program for today") never touches the chat log; a bare
  // go-ahead ("apply it", "go ahead") reads the coach's previous message to find out what
  // it is agreeing to, and grants nothing unless that message PROPOSED a session.
  const explicitPlanEdit = ((): boolean => {
    if (hasSelfContainedPlanEditIntent(message)) return true;
    if (!carriesPlanApplyAffirmation(message)) return false;
    const prior = ctx.priorAssistant ?? priorAssistantContext(ctx.userMessageId);
    return hasExplicitPlanEditIntentInContext(message, prior.message ?? "", prior.drafted === true);
  })();
  // Scoped to today in the athlete's own words: this change happens today or not at all.
  const planUpdateTodayScoped = planUpdateTargetsToday(message, explicitPlanEdit);
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
          applied.push({
            type: a.type,
            result: repo.logSetByName(repo.resolveImplicitPlanDay(a), { enrich: true }),
          });
          break;
        case "set_profile": {
          const { type, ...patch } = a;
          const goalFieldsRequested = [...GOAL_IDENTITY_FIELDS].filter((field) => field in patch);
          if (!explicitGoalIntent) {
            for (const field of GOAL_IDENTITY_FIELDS) delete patch[field];
            droppedGoalFields.push(...goalFieldsRequested);
          } else if (goalFieldsRequested.length) {
            appliedGoalPatch = Object.fromEntries(goalFieldsRequested.map((field) => [field, patch[field]]));
          }
          if (Object.keys(patch).length) applied.push({ type: a.type, result: repo.setProfile(patch) });
          break;
        }
        case "set_training_intent": {
          if (!explicitGoalIntent) {
            droppedGoalFields.push("training_intent");
            break;
          }
          const { type, ...trainingIntent } = a;
          const normalizedIntent = repo.normalizeTrainingIntent(trainingIntent);
          if (!normalizedIntent) break;
          applied.push({ type: a.type, result: repo.setProfile({ training_intent: normalizedIntent }) });
          break;
        }
        case "set_endurance_goal": {
          if (!explicitGoalIntent) {
            droppedGoalFields.push("endurance_goal");
            break;
          }
          // The endurance OBJECTIVE — applied through setProfile's endurance_goal
          // path (normalized/validated there). The action's own fields ARE the goal.
          const { type, ...goal } = a;
          applied.push({ type: a.type, result: repo.setProfile({ endurance_goal: goal }) });
          break;
        }
        case "set_endurance_schedule": {
          const schedule = repo.normalizeEnduranceSchedule({ days: a.days, note: a.note, source: "chat" });
          if (!schedule) {
            applied.push({ type: a.type, error: "invalid endurance_schedule" });
            break;
          }
          applied.push({ type: a.type, result: repo.setProfile({ endurance_schedule: schedule }) });
          break;
        }
        case "set_strength_schedule": {
          const schedule = repo.normalizeStrengthSchedule({ days: a.days, note: a.note, source: "chat" });
          if (!schedule) {
            applied.push({ type: a.type, error: "invalid strength_schedule" });
            break;
          }
          applied.push({ type: a.type, result: repo.setProfile({ strength_schedule: schedule }) });
          break;
        }
        case "set_movement_considerations": {
          // The action is the full list the athlete now holds; [] clears it.
          applied.push({ type: a.type, result: repo.setProfile({ movement_considerations: { items: a.items } }) });
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
          applied.push({
            type: a.type,
            result: repo.logWeight(a.weight_lb, stringOrUndefined(a.date), stringOrUndefined(a.note)),
          });
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
        case "flag_training_structure": {
          // THE PROMISE HAS TO LEAVE A TRACE. A reply that says "I'll flag it to your
          // coach lane" and writes nothing is the bug this closes. The durable artifact
          // is an ask-tier `training_structure` decision holding the athlete's own
          // sentence as its rationale, and the athlete's words go to the program-evolution
          // op as a background job; the ONE autonomy policy decides how the built week
          // lands. `requestStructureRedraw` owns all of that, because the Plan tab offers
          // the same door and a request typed there must resolve to the SAME standing
          // flag as the same words said here.
          if (!flagTrainingStructureAuthorized(message)) break;
          applied.push({
            type: a.type,
            result: requestStructureRedraw({
              request: a.request,
              summary: typeof a.summary === "string" ? a.summary : null,
              source: "chat",
              agent: ctx.agent ?? null,
              chat_turn_id: ctx.turnId ?? null,
              enqueue: ctx.enqueueJob ?? enqueueAgentJob,
            }),
          });
          break;
        }
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
                todayPlanUpdateChanges(message, a.changes, explicitPlanEdit),
                explicitPlanEdit,
                clinicalProvenance,
                planUpdateTodayScoped
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
  return { applied, drafts, labConfirms, refusedReverts, droppedGoalFields, appliedGoalPatch, explicitPlanEdit };
}
