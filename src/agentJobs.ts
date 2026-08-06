import { createProgressBus, createSerialRunner } from "./jobRunner.js";
import { isAgentJobKind } from "./agentJobKinds.js";
import * as repo from "./repo.js";
import {
  suggestSession,
  composeDailySession,
  draftCoachProposal,
  evolveProgram,
  composeWeek,
  draftMealPlan,
  swapMealAgentic,
  generateRecipe,
  nutritionCheckin,
  generateInsight,
  runHealthReview,
  synthesizeHealth,
  distillChat,
  weekAheadRead,
  reconcileMarkers,
  runResearch,
  reconcileExercises,
  consolidateMemory,
  growAboutMe,
  onboardFromText,
} from "./coachOps.js";
import { readToday } from "./domain/brain/day-read-use-case.js";
import { runCaseConference } from "./domain/brain/case-conference.js";
import { applyProposalWithAutonomy } from "./domain/brain/autonomy-service.js";
import type { SpecialistDomain } from "./brain/specialist-contract.js";
import { normalizeStrictCaseConferenceDecision } from "./brain/case-conference-contract.js";
import { diagnosticErrorName, recordAsyncFailure } from "./diagnostics.js";
import { addDaysISO, localDateISO } from "./repo/shared.js";
import { runUnderfuelingControlLoop } from "./domain/brain/underfueling-service.js";

// Durable, in-process agent-job engine — the GENERALIZATION of chatTurns.ts for
// the other blocking agentic ops. An op is no longer a request held open for
// 90–300s on a CLI subprocess: the API persists an `agent_jobs` row (status
// 'queued') and hands the id here. This SERIAL worker (one CLI agent at a time,
// like enrich.ts / chatTurns.ts) drains the queue, runs the existing coachOp,
// records a thin pointer to the already-persisted result row + the contract body,
// and emits live progress on an event bus the SSE endpoint forwards. Because the
// job lives in SQLite, an op interrupted by a tab switch / reload / restart
// survives (the PWA rebuilds in-flight + queued jobs from listActiveAgentJobs).
//
// Degrades exactly like the rest of the loop: no enabled agent → the coachOp
// returns its designed ok:false, recorded as the job's `done` result (NOT an
// error — ok:false is a valid outcome the client renders); a real throw → the
// job is marked 'error', nothing escapes the drain loop.

// ---------- progress bus ----------
// One emitter, one event name per job ("job:<id>"). The SSE handler subscribes
// for the job it's streaming; the worker emits on every phase change and on the
// terminal transition. Progress is phase captions (optionally with a determinate
// `frac`), PLUS — for the four prose-bearing ops (health synthesis, session-suggest,
// nutrition check-in, weekly read) — live `delta` events carrying the athlete-facing
// prose token by token, so it paints into the waiting card. Deltas are EPHEMERAL:
// bus-only, never persisted to the agent_jobs row (a reconnecting client rebuilds
// state from the row + gets the final result on `done`).
export type JobEvent =
  | { type: "phase"; job: any }
  | { type: "delta"; delta: string }
  | { type: "done"; job: any; result: any }
  | { type: "error"; job: any; message: string }
  | { type: "canceled"; job: any };

const jobBus = createProgressBus<JobEvent>("job");
function emit(id: number, payload: JobEvent): void {
  jobBus.emit(id, payload);
}
export function onJobEvent(id: number, listener: (e: JobEvent) => void): () => void {
  return jobBus.on(id, listener);
}

// The job kinds whose coachOp writes athlete-facing prose worth streaming. Only these
// wire an `onDelta` hook into the op; every other kind runs prose-free (or is
// JSON-only) and streams nothing. Exported (with the predicate) so the wiring is
// unit-testable and stays in lockstep with the reshaped prompts in prompt.ts.
export const STREAM_DELTA_KINDS = new Set([
  "health_synthesis",
  "session_suggest",
  "session_compose",
  "nutrition_checkin",
  "weekly_read",
]);
export function jobStreamsDeltas(kind: string): boolean {
  return STREAM_DELTA_KINDS.has(kind);
}

// Push one live prose chunk onto a job's bus (the onDelta target for the streaming
// kinds). Kept exported + thin so the delta path is exercisable via onJobEvent in tests.
export function emitJobDelta(id: number, delta: string): void {
  if (delta) emit(id, { type: "delta", delta });
}

export interface BrainReviewActionDeps {
  nutritionCheckin?: typeof nutritionCheckin;
  generateInsight?: typeof generateInsight;
  applyProposalWithAutonomy?: typeof applyProposalWithAutonomy;
  buildProgressionProposal?: typeof repo.buildProgressionProposal;
  runUnderfuelingControlLoop?: typeof runUnderfuelingControlLoop;
}

function nutritionReviewDue(event: any): { due: boolean; reasons: string[] } {
  if (!["session_feedback", "weight_logged"].includes(String(event?.kind))) return { due: false, reasons: [] };
  const today = localDateISO();
  const last = String(repo.getAppState("nutrition_signal_recheck_last_date") ?? "");
  if (last && last >= String(addDaysISO(today, -6) ?? today)) return { due: false, reasons: [] };
  const goal: any = repo.computeGoalCheck();
  if (!goal?.ok || goal.goal_mode !== "lose") return { due: false, reasons: [] };
  const trend = Number(goal.trend_lb_wk);
  const ideal = Number(goal.leanness_rate?.lean_ideal_rate_lb);
  const program: any = repo.getProgramState();
  const reasons: string[] = [];
  if (Number.isFinite(trend) && Number.isFinite(ideal) && trend < -(ideal * 1.1))
    reasons.push("weight trend is faster than the lean-ideal pace");
  if (program?.hybrid?.fuel?.risk === "high") reasons.push("hybrid fuel risk is high");
  if (event?.material === true && event?.kind === "session_feedback")
    reasons.push("session performance fatigue was reported");
  return { due: reasons.length >= 2 || (event?.kind === "session_feedback" && reasons.length >= 1), reasons };
}

async function runSignalNutritionReview(
  event: any,
  agent: string | undefined,
  hooks: any,
  deps: BrainReviewActionDeps
) {
  const due = nutritionReviewDue(event);
  if (!due.due) return null;
  const checkin = await (deps.nutritionCheckin ?? nutritionCheckin)(agent, undefined, hooks, { initiated: "auto" });
  repo.setAppState("nutrition_signal_recheck_last_date", localDateISO());
  const proposalId = Number(checkin?.proposal?.id);
  if (!checkin?.change || !Number.isFinite(proposalId) || proposalId <= 0) {
    return { ...checkin, action: "nutrition_signal_recheck", reasons: due.reasons };
  }
  // nutritionCheckin owns propose -> autonomy exactly once. Re-applying here used
  // to create a second ledger row for the same proposal.
  return { ...checkin, action: "nutrition_signal_recheck", reasons: due.reasons };
}

/**
 * Execute the small set of signal-boundary actions that are safe without another
 * user decision. Training progression is deterministic and runs only after a
 * finished session. A material food correction may refresh nutrition, but its
 * target still goes through autonomy policy and waits for the next food-day
 * boundary. Every other event stays a quiet pull-only insight.
 */
export async function executeBrainReviewAction(
  input: any,
  agent: string | undefined,
  hooks?: any,
  deps: BrainReviewActionDeps = {}
): Promise<any> {
  const event = input?.event;
  const insight = deps.generateInsight ?? generateInsight;
  const applyAutonomously = deps.applyProposalWithAutonomy ?? applyProposalWithAutonomy;

  if (
    ["fueling_feedback", "session_feedback", "weight_logged", "food_corrected"].includes(String(event?.kind)) &&
    event?.clinical !== true
  ) {
    const controlled = (deps.runUnderfuelingControlLoop ?? runUnderfuelingControlLoop)(localDateISO());
    const controlOwnsBoundary = ["execution_gap", "prescription_strain", "persistent_strain", "settling"].includes(
      String(controlled.read?.state ?? "")
    );
    if (event?.kind === "fueling_feedback" || controlled.action !== "none" || controlOwnsBoundary) {
      return { ...controlled, action: controlled.action, source: "underfueling_control" };
    }
  }

  if (event?.kind === "session_finished" && event?.domain === "training" && event?.clinical !== true) {
    const sessionId = Number(event.entity_id);
    const session = Number.isFinite(sessionId) && sessionId > 0 ? (repo.getSessionDetail(sessionId) as any) : null;
    if (!session?.finished_at || !session?.plan_day_id) return insight(agent, "connection", hooks);
    const day = (repo.getPlan() as any[]).find((item) => Number(item.id) === Number(session.plan_day_id));
    if (!day)
      return {
        ok: true,
        change: false,
        action: "training_progression",
        summary: "The finished session did not map to a current plan day.",
      };
    hooks?.onPhase?.("updating the next session from what you earned");
    const built = (deps.buildProgressionProposal ?? repo.buildProgressionProposal)(Number(day.day_number), {
      forNextSession: true,
    });
    if (!built.ok) return { ok: true, change: false, action: "training_progression", summary: built.error };
    const autonomy = applyAutonomously(Number(built.proposal.id), { requested_tier: "quiet_apply" });
    return { ok: true, change: true, action: "training_progression", proposal: built.proposal, autonomy };
  }

  if (
    event?.kind === "food_corrected" &&
    event?.domain === "nutrition" &&
    event?.material === true &&
    event?.clinical !== true
  ) {
    hooks?.onPhase?.("rechecking the next nutrition target");
    const checkin = await (deps.nutritionCheckin ?? nutritionCheckin)(agent, undefined, hooks, { initiated: "auto" });
    const proposalId = Number(checkin?.proposal?.id);
    if (!checkin?.change || !Number.isFinite(proposalId) || proposalId <= 0) {
      return { ...checkin, action: "nutrition_recheck" };
    }
    // nutritionCheckin already routed this proposal through autonomy. Preserve its
    // returned decision instead of invoking the same transition a second time.
    return { ...checkin, action: "nutrition_recheck" };
  }

  const signalNutrition = await runSignalNutritionReview(event, agent, hooks, deps);
  if (signalNutrition) return signalNutrition;

  return insight(agent, "connection", hooks);
}

const CONFERENCE_SUCCESS_STATE_KEYS = new Set([
  "brain_revision_last_month",
  "brain_revision_phase_sig",
  "brain_revision_regression_sig",
]);
const CONFERENCE_SCHEDULER_OPERATION = "brain_revision_conference";
const CONFERENCE_RETRY_MAX_ATTEMPTS = 3;
const CONFERENCE_RETRY_BACKOFF_MS = [12 * 60 * 60_000, 36 * 60 * 60_000];

function conferenceSchedulerClaim(input: any): repo.SchedulerOperationClaim | null {
  const raw = input?.scheduler_operation;
  if (!raw || raw.operation !== CONFERENCE_SCHEDULER_OPERATION) return null;
  const slot = String(raw.slot_stamp ?? "");
  const token = String(raw.claim_token ?? "");
  const attempts = Math.trunc(Number(raw.attempts));
  if (!/^[a-f0-9]{64}$/.test(slot) || !token || !Number.isInteger(attempts) || attempts < 1) return null;
  return {
    operation: CONFERENCE_SCHEDULER_OPERATION,
    slot_stamp: slot,
    claim_token: token,
    attempts,
  } as repo.SchedulerOperationClaim;
}

function completeCaseConferenceResult(input: any, result: any): boolean {
  if (
    result?.ok !== true ||
    result?.degraded === true ||
    normalizeStrictCaseConferenceDecision(result?.decision) === null ||
    !Array.isArray(result?.opinions) ||
    !Array.isArray(result?.unavailable) ||
    result.unavailable.length > 0 ||
    !Array.isArray(result?.unresolved_conflicts) ||
    result.unresolved_conflicts.length > 0
  )
    return false;
  const requested = [
    ...new Set<string>(
      (Array.isArray(input.domains) ? input.domains : [])
        .map(String)
        .filter((domain: string) => ["training", "nutrition", "health", "recovery", "lifestyle"].includes(domain))
    ),
  ];
  const delivered = new Set(
    result.opinions
      .map((opinion: any) => String(opinion?.domain ?? ""))
      .filter((domain: string) => requested.includes(domain))
  );
  return requested.length > 0 && delivered.size === requested.length;
}

export function failCaseConferenceSchedulerOperation(input: any, error: unknown): boolean {
  const claim = conferenceSchedulerClaim(input);
  if (!claim) return false;
  return !!repo.failSchedulerOperation(claim, error, {
    maxAttempts: CONFERENCE_RETRY_MAX_ATTEMPTS,
    backoffMs: CONFERENCE_RETRY_BACKOFF_MS,
  });
}

/** Stamp scheduler success only after a conference returned a valid result. */
export function applyCaseConferenceSchedulerSuccess(input: any, result: any): boolean {
  if (!completeCaseConferenceResult(input, result)) {
    const missing = Array.isArray(result?.unavailable) ? result.unavailable.join(",") : "unknown";
    failCaseConferenceSchedulerOperation(input, new Error(`case conference incomplete; unavailable=${missing}`));
    return false;
  }
  if (!input?.scheduler_success || typeof input.scheduler_success !== "object") return false;
  const claim = conferenceSchedulerClaim(input);
  if (claim && !repo.completeSchedulerOperation(claim, "succeeded")) return false;
  let stamped = false;
  for (const [key, raw] of Object.entries(input.scheduler_success)) {
    if (!CONFERENCE_SUCCESS_STATE_KEYS.has(key) || typeof raw !== "string") continue;
    repo.setAppState(key, raw.slice(0, 2_000));
    stamped = true;
  }
  return stamped;
}

// ---------- serial queue ----------
// Live AbortControllers keyed by job id, so a Stop can SIGKILL the running CLI.
// processAgentJob releases its own controller in a finally; the runner backstop
// below only records a failure that escaped processAgentJob's own handling.
const controllers = new Map<number, AbortController>();

const runner = createSerialRunner(processAgentJob, (id, e) => {
  // A failing job must never break the loop. processAgentJob already persists its
  // own failure; this is the last-resort backstop.
  try {
    const cur = repo.getAgentJob(id) as any;
    if (cur && (cur.status === "queued" || cur.status === "running")) {
      const failed = repo.failAgentJob(id, e?.message ?? String(e));
      emit(id, { type: "error", job: failed, message: "Background job failed" });
    }
  } catch {
    /* ignore */
  }
  recordAsyncFailure("agent_jobs", "runner_backstop", e);
  console.error(`[jobs] job#${id} failed (${diagnosticErrorName(e)})`);
});

export function enqueueAgentJob(id: number): void {
  runner.enqueue(id);
}

async function processAgentJob(id: number): Promise<void> {
  const job = repo.getAgentJob(id) as any;
  if (!job || job.status !== "queued") return; // canceled while queued, or already handled

  repo.markAgentJobRunning(id);
  emit(id, { type: "phase", job: repo.getAgentJob(id) });

  const controller = new AbortController();
  controllers.set(id, controller);

  const onPhase = (phase: string, meta?: any) => {
    if (controller.signal.aborted) return;
    repo.setAgentJobPhase(id, phase, meta);
    emit(id, { type: "phase", job: repo.getAgentJob(id) });
  };
  // Prose-bearing kinds stream their reading into the card token by token; every other
  // kind leaves onDelta undefined, so its op runs prose-free exactly as before.
  const onDelta = jobStreamsDeltas(job.kind)
    ? (delta: string) => {
        if (!controller.signal.aborted) emitJobDelta(id, delta);
      }
    : undefined;
  const hooks = { signal: controller.signal, onPhase, onDelta };
  const input = job.input ?? {};
  const agent: string | undefined = job.agent ?? input.agent ?? undefined;

  try {
    if (!isAgentJobKind(job.kind)) throw new Error(`unknown job kind: ${job.kind}`);

    // Each kind runs the existing coachOp threading the hooks. The op's RETURN
    // VALUE is the contract body — byte-for-byte what the sync endpoint returned
    // before this change — so the client's done-handler reuses its old rendering.
    let result: any;
    let ref: { ref_table?: string | null; ref_id?: number | null } = {};
    let chosen: string | null = null;

    switch (job.kind) {
      case "session_suggest": {
        result = await suggestSession(
          agent,
          {
            minutes: input.minutes != null ? Number(input.minutes) : undefined,
            equipment: input.equipment != null ? String(input.equipment) : undefined,
            focus: input.focus != null ? String(input.focus) : undefined,
            constraints: input.constraints != null ? String(input.constraints) : undefined,
            date: input.date != null ? String(input.date) : undefined,
          },
          hooks
        );
        chosen = result?.agent ?? null;
        break;
      }
      case "session_compose": {
        result = await composeDailySession(
          agent,
          {
            date: input.date != null ? String(input.date) : undefined,
            minutes: input.minutes != null ? Number(input.minutes) : undefined,
            equipment: input.equipment != null ? String(input.equipment) : undefined,
            override: input.override != null ? String(input.override) : undefined,
            train_anyway: input.train_anyway === true,
          },
          hooks
        );
        chosen = result?.agent ?? null;
        break;
      }
      case "proposal": {
        result = await draftCoachProposal(
          agent,
          input.instruction != null ? String(input.instruction) : undefined,
          hooks
        );
        chosen = result?.agent ?? null;
        if (result?.proposal?.id) ref = { ref_table: "plan_proposals", ref_id: result.proposal.id };
        break;
      }
      case "evolve_program": {
        result = await evolveProgram(agent, input.instruction != null ? String(input.instruction) : undefined, hooks);
        chosen = result?.agent ?? null;
        if (result?.proposal?.id) ref = { ref_table: "plan_proposals", ref_id: result.proposal.id };
        break;
      }
      case "compose_week": {
        result = await composeWeek(agent, input.instruction != null ? String(input.instruction) : undefined, hooks);
        chosen = result?.agent ?? null;
        if (result?.proposal?.id) ref = { ref_table: "plan_proposals", ref_id: result.proposal.id };
        break;
      }
      case "meal_plan": {
        result = await draftMealPlan(agent, input.instruction, hooks);
        chosen = result?.agent ?? null;
        ref = { ref_table: "meal_plans", ref_id: result?.plan?.id ?? null };
        break;
      }
      case "meal_swap": {
        // The plan must be resolved here (the API only did a pre-check before
        // enqueue) so a long queue still swaps against the current plan state.
        const plan = repo.getMealPlan(Number(input.id));
        if (!plan) {
          result = { ok: false, error: "not found" };
          break;
        }
        result = await swapMealAgentic(
          agent,
          {
            plan,
            id: Number(input.id),
            day: String(input.day ?? ""),
            mealIndex: Number(input.meal_index),
            hint: input.hint,
          },
          hooks
        );
        chosen = result?.agent ?? null;
        ref = { ref_table: "meal_plans", ref_id: Number(input.id) };
        break;
      }
      case "recipe": {
        const plan = repo.getMealPlan(Number(input.id));
        if (!plan) {
          result = { ok: false, error: "not found" };
          break;
        }
        result = await generateRecipe(
          agent,
          {
            plan,
            id: Number(input.id),
            day: String(input.day ?? ""),
            mealIndex: Number(input.meal_index),
          },
          hooks
        );
        chosen = result?.agent ?? null;
        ref = { ref_table: "meal_plans", ref_id: Number(input.id) };
        break;
      }
      case "nutrition_checkin": {
        result = await nutritionCheckin(agent, input.window != null ? Number(input.window) : undefined, hooks);
        chosen = result?.agent ?? null;
        if (result?.proposal?.id) ref = { ref_table: "plan_proposals", ref_id: result.proposal.id };
        break;
      }
      case "insight":
      case "weekly_read": {
        result = await generateInsight(agent, job.kind === "weekly_read" ? "weekly_read" : "connection", hooks);
        chosen = result?.agent ?? null;
        if (result?.insight?.id) ref = { ref_table: "insights", ref_id: result.insight.id };
        break;
      }
      case "brain_review": {
        result = await executeBrainReviewAction(input, agent, hooks);
        chosen = result?.agent ?? null;
        if (result?.proposal?.id) ref = { ref_table: "plan_proposals", ref_id: result.proposal.id };
        else if (result?.insight?.id) ref = { ref_table: "insights", ref_id: result.insight.id };
        break;
      }
      case "case_conference": {
        // The conference itself owns persistence. Advice-only output is held for
        // review; a typed plan revision becomes a real proposal and runs through
        // the shared autonomy/clamp/rollback path before this job can finish.
        const domains: SpecialistDomain[] = Array.isArray(input.domains)
          ? input.domains
              .map(String)
              .filter((domain: string): domain is SpecialistDomain =>
                ["training", "nutrition", "health", "recovery", "lifestyle"].includes(domain)
              )
          : [];
        result = await runCaseConference(
          agent,
          {
            question: String(input.question ?? "Review the current whole-person plan at this phase boundary."),
            domains,
            trajectory: input.trajectory,
            optimizes: Array.isArray(input.optimizes) ? input.optimizes.map(String) : undefined,
            parks: Array.isArray(input.parks) ? input.parks.map(String) : undefined,
          },
          { jobId: id, signal: controller.signal }
        );
        if (result?.proposal_id) ref = { ref_table: "plan_proposals", ref_id: Number(result.proposal_id) };
        break;
      }
      case "week_ahead": {
        result = await weekAheadRead(agent, hooks);
        chosen = result?.agent ?? null;
        break;
      }
      case "marker_reconcile": {
        result = await reconcileMarkers(agent, hooks);
        chosen = result?.agent ?? null;
        break;
      }
      case "evidence_research": {
        result = await runResearch(String(input.question ?? ""), {
          markers: Array.isArray(input.markers) ? input.markers.map(String) : undefined,
          agent,
          force: input.force === true,
        });
        chosen = result?.agent ?? null;
        break;
      }
      case "exercise_reconcile": {
        // User-initiated (MCP reconcile_exercise_names / the PWA "Tidy" button) — may
        // override a clearly-wrong non-null group, since the user asked for the cleanup.
        result = await reconcileExercises(agent, hooks, { authoritativeGroups: true });
        chosen = result?.agent ?? null;
        break;
      }
      case "memory_consolidate": {
        onPhase("tidying what I remember");
        result = await consolidateMemory(agent);
        chosen = result?.agent ?? null;
        break;
      }
      case "about_me_grow": {
        onPhase("updating the person model");
        result = await growAboutMe(agent);
        chosen = result?.agent ?? null;
        break;
      }
      case "onboard": {
        result = await onboardFromText(agent, String(input.text ?? ""), hooks);
        break;
      }
      case "health_review": {
        result = await runHealthReview(agent, hooks);
        chosen = result?.agent ?? null;
        if (result?.review?.id) ref = { ref_table: "health_reviews", ref_id: result.review.id };
        break;
      }
      case "health_synthesis": {
        result = await synthesizeHealth(agent, hooks);
        chosen = result?.agent ?? null;
        break;
      }
      case "day_read_override": {
        const date = input.date != null ? String(input.date) : undefined;
        const override = input.override != null ? String(input.override) : undefined;
        onPhase("rereading your day");
        // The `done` result MUST be byte-for-byte what GET /api/today-read?override=
        // returns, so the PWA reuses its Brief-from-read render unchanged.
        result = await readToday({ date, override, agent, recordOutcome: true });
        chosen = result?.agent ?? null;
        ref = { ref_table: "day_reads", ref_id: null };
        break;
      }
      case "chat_distill": {
        // The conversation was archived BEFORE this job was enqueued; the
        // pre-archive history rides in input_json so the distill still sees it.
        // Read it RAW — the hydrated `input` strips `history` from client echoes.
        const hist = repo.getAgentJobRawInput(id)?.history;
        result = await distillChat(agent, Array.isArray(hist) ? hist : [], hooks);
        break;
      }
      default:
        throw new Error(`unknown job kind: ${job.kind}`);
    }

    // Canceled mid-run: cancelAgentJob already flipped status + emitted the event.
    const cur = repo.getAgentJob(id) as any;
    if (cur?.status === "canceled" || controller.signal.aborted) return;

    const finished = repo.finishAgentJob(id, {
      result,
      chosen_agent: chosen,
      ref_table: ref.ref_table ?? null,
      ref_id: ref.ref_id ?? null,
    });
    if (job.kind === "case_conference" && finished?.status === "done") {
      applyCaseConferenceSchedulerSuccess(input, result);
    }
    emit(id, { type: "done", job: finished, result });
  } catch (e: any) {
    const cur = repo.getAgentJob(id) as any;
    if (cur?.status === "canceled" || controller.signal.aborted) return; // Stop, not a failure
    if (job.kind === "case_conference") failCaseConferenceSchedulerOperation(input, e);
    const failed = repo.failAgentJob(id, e?.message ?? String(e));
    recordAsyncFailure("agent_jobs", job.kind, e);
    emit(id, { type: "error", job: failed, message: "Background job failed" });
  } finally {
    controllers.delete(id);
  }
}

// User-requested Stop. Flips the job state first (so the worker's catch knows not
// to write an error), then aborts any live subprocess, then emits the terminal
// event. No-op if the job already finished. Returns the job or null.
export function cancelAgentJob(id: number) {
  const job = repo.cancelAgentJob(id);
  if (!job) return null;
  try {
    controllers.get(id)?.abort();
  } catch {
    /* not running */
  }
  emit(id, { type: "canceled", job });
  return job;
}

// Shutdown helper: abort every live agent-job subprocess (see chatTurns.abortAllTurns).
export function abortAllJobs() {
  for (const c of controllers.values()) {
    try {
      c.abort();
    } catch {
      /* not running */
    }
  }
}

// Crash recovery (boot): mark interrupted 'running' jobs errored (their coachOp
// may have partially persisted a draft — re-running risks duplicates) and
// re-enqueue the 'queued' ones that never started. Mirrors recoverChatTurns.
export function recoverAgentJobs(): { requeued: number; interrupted: number } {
  const { requeue, interrupted } = repo.recoverAgentJobs();
  if (interrupted) recordAsyncFailure("agent_jobs", "restart_interruption", new Error("interrupted"));
  for (const id of requeue) enqueueAgentJob(id);
  if (requeue.length || interrupted) {
    console.log(`[jobs] recovered ${requeue.length} queued + ${interrupted} interrupted job(s).`);
  }
  return { requeued: requeue.length, interrupted };
}

// Re-export so the scheduler / boot can stamp the local date consistently.
export { localToday } from "./dayread.js";
