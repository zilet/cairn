import * as repo from "./repo.js";
import { runAgentWithFallback, setAgentRunSink } from "./agents.js";
import { buildCoachPrompt } from "./prompt.js";
import { draftMealPlan, evolveProgram, generateInsight, nutritionCheckin, synthesizeHealth } from "./coachOps.js";
import { precomputeDayRead, localToday, warmToday } from "./dayread.js";
import { checkForUpdate } from "./updateCheck.js";
import {
  evaluateMatureExpectations,
  queueExpectationRevisions,
  releaseStaleExpectationFollowups,
  surfaceExpectationMisses,
} from "./brainEvaluator.js";
import {
  adoptOrphanedDrafts,
  applyDueAnnouncedDecisions,
  applyProposalWithAutonomy,
  buildRunPlanWithAutonomy,
} from "./domain/brain/autonomy-service.js";
import { lastAppliedRunPlanDate } from "./repo/sessions.js";
import { enqueueAgentJob } from "./agentJobs.js";
import { recordAsyncFailure, recordSchedulerFailure } from "./diagnostics.js";
import { runWithTimeZone } from "./tz.js";
import { addDaysISO, nowContext } from "./repo/shared.js";
import { runUnderfuelingControlLoop } from "./domain/brain/underfueling-service.js";
import {
  MEAL_REFRESH_INSTRUCTION_KEY,
  MEAL_REFRESH_REQUEST_KEY,
  mealRefreshRetryDue,
  runOwnedMealRefreshAttempt,
} from "./repo/meal-refresh-retry.js";
import { isPlanProposalResult } from "./agent-contracts.js";
import { createHash } from "node:crypto";
// Stream 2 (self-updating memory): quiet nightly memory housekeeping + outcome
// reconciliation. Lazy-imported in the tick so this module stays decoupled.

// Weekly expert-team review + quiet proactivity. Configured in Settings (persisted in
// the DB, editable from the PWA at runtime — no restart needed): coach_day
// (0=Sun..6=Sat), coach_hour (the last-seen device timezone). When the slot arrives it drafts
// ONE proposal using the configured agent rotation (round-robin / random /
// priority, with fallthrough). In lead mode it routes through the same bounded,
// reversible autonomy ledger as every other adaptation; review mode still parks it.
//
// The weekly coach draft is MISS-TOLERANT: rather than firing only on exact
// hour equality (which silently skips the week if the process was asleep at that
// minute), it fires when the most recent scheduled slot has passed and it hasn't
// completed that slot yet. Durable per-operation ownership retries transient
// failure with bounded backoff and recovers expired leases after restart; legacy
// app_state stamps remain a compatibility read.
//
// Proactivity (gated behind settings.proactive_enabled, default on) is PULL,
// NEVER push: it only STORES a waiting read (a quiet nightly insight, a weekly
// read, a drifted-nutrition draft) — no notification, no nag ever fires.
//
// First-run defaults seed from COACH_AGENT/COACH_DAY/COACH_HOUR env vars so
// existing deployments keep working until you change anything in Settings.
//
// Also hosts the Garmin auto-sync (boot + ~6h cadence, only when configured).

const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAY_INDEX: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

// Calendar stamp of the most recent scheduled weekly slot in `tz`. This is
// intentionally wall-clock math, not Date#getHours/getDay: those getters always
// use the host process timezone and were the reason a Pi could run a New York
// athlete's work at the wrong hour. Date-only subtraction is DST-safe here.
export function weeklySlotStamp(now: Date, day: number, hour: number, tz?: string): string {
  const local = nowContext(now, tz);
  const localDay = WEEKDAY_INDEX[local.weekday] ?? 0;
  const targetDay = Math.max(0, Math.min(6, Math.trunc(Number(day) || 0)));
  const targetHour = Math.max(0, Math.min(23, Math.trunc(Number(hour) || 0)));
  let back = (localDay - targetDay + 7) % 7;
  if (back === 0 && local.hour < targetHour) back = 7;
  return addDaysISO(local.date, -back) ?? local.date;
}

export function brainRevisionSlotStamp(month: string, phaseSig: string, regressionSig: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ month, phase: phaseSig, regression: regressionSig }))
    .digest("hex");
}

// True when the weekly slot's most recent occurrence has passed and durable
// scheduler ownership says it can be claimed. Legacy app_state stamps remain a
// compatibility read only; new work is acknowledged after success/no-op, never
// before an agent or deterministic operation actually completes.
function weeklySlotDue(now: Date, day: number, hour: number, stateKey: string): boolean {
  const slotStamp = weeklySlotStamp(now, day, hour);
  if (repo.getAppState(stateKey) === slotStamp) return false; // already ran for this slot
  return repo.schedulerOperationDue(stateKey, slotStamp, now);
}

function dailySlotDue(now: Date, stateKey: string): boolean {
  const slotStamp = localToday(now);
  if (repo.getAppState(stateKey) === slotStamp) return false;
  return repo.schedulerOperationDue(stateKey, slotStamp, now);
}

// Initial insight scheduling is small-hours-only; once today's row exists, its
// persisted retry/expired-lease state stays pollable for the rest of the day.
// Crucially, the after-hours read does not create a new row by itself.
export function dailyWindowOperationDue(now: Date, hour: number, stateKey: string): boolean {
  const slotStamp = localToday(now);
  if (repo.getAppState(stateKey) === slotStamp) return false;
  const existing = repo.getSchedulerOperation(stateKey, slotStamp);
  if (existing) return repo.schedulerOperationDue(stateKey, slotStamp, now);
  return nowContext(now).hour === hour && repo.schedulerOperationDue(stateKey, slotStamp, now);
}

// The small-hours hour the quiet nightly memory/learning pass prefers — an hour
// before the Brief precompute so the agent isn't double-booked.
const MEMORY_HOUR = (() => {
  const h = Number(process.env.MEMORY_MAINT_HOUR);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 3; // default 3am local
})();
export const MEMORY_MAINT_STATE_KEY = "memory_maint_last_date";

// The nightly learning pass PREFERS MEMORY_HOUR but is owned by the DAY, not by the
// minute the process happened to be alive for. It used to gate on `hour === MEMORY_HOUR`
// with the last-run date held in process memory only, so a restart across the memory
// hour silently dropped a whole day of learning — suggestion reconciliation, expectation
// evaluation, miss follow-ups, step-back drafting, and every model rebuild. An hour FLOOR
// over the same durable daily slot the other daily jobs use means a missed hour is caught
// up on the next tick past it instead of waiting a full day.
export function memoryMaintenanceDue(now: Date): boolean {
  if (nowContext(now).hour < MEMORY_HOUR) return false;
  return dailySlotDue(now, MEMORY_MAINT_STATE_KEY);
}

// A database that has never run a scheduler owes no catch-up: without this, a
// fresh install (or a reset) booted after the memory hour would run the whole
// nightly learning pass — agentic consolidation included — within a minute of
// first paint. Acknowledging today makes the first pass wait for the next
// memory hour, as it always did. An upgraded database has scheduler history,
// so a genuinely missed hour still catches up.
export function seedMemorySlotOnFreshInstall(now = new Date()) {
  if (repo.getAppState(MEMORY_MAINT_STATE_KEY)) return;
  if (repo.hasSchedulerHistory()) return;
  repo.setAppState(MEMORY_MAINT_STATE_KEY, localToday(now));
}

export function acceptsWeeklyCoachProposal(parsed: unknown): boolean {
  return isPlanProposalResult(parsed);
}

function schedulerTerminal(status: repo.SchedulerOperationStatus): boolean {
  return status === "succeeded" || status === "no_op";
}

// Isolate every operation so one provider outage never suppresses its siblings.
// Effect-producing tasks still rely on their existing proposal/decision/dedup
// ledgers; this wrapper provides at-least-once retry ownership, not a false claim
// of exactly-once execution across a process crash after the effect commits.
async function runScheduled<T>(
  operation: string,
  slotStamp: string,
  legacyStateKey: string,
  task: () => Promise<repo.SchedulerTaskCompletion<T>> | repo.SchedulerTaskCompletion<T>
): Promise<repo.SchedulerRunResult<T> | null> {
  try {
    const result = await repo.runSchedulerOperation(operation, slotStamp, task);
    if (schedulerTerminal(result.status)) repo.setAppState(legacyStateKey, slotStamp);
    if (result.attempted && result.error) {
      recordSchedulerFailure(operation, new Error(result.error));
      console.error(`[scheduler] ${operation} ${result.status}: ${result.error}`);
    }
    return result;
  } catch (error: any) {
    recordSchedulerFailure(operation, error);
    console.error(`[scheduler] ${operation} ownership failed: ${error?.message ?? error}`);
    return null;
  }
}

// Whole-day gap between two YYYY-MM-DD stamps (both produced by localToday). Used
// to enforce a calm minimum spacing between data-triggered evolution drafts.
function daysBetweenStamps(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / DAY_MS) : Number.POSITIVE_INFINITY;
}

// ---- Weekly run-plan apply (Monday) ----
// The applied plan's cardio rows are the only endurance prescription the Plan
// screen and run-compliance can see — and NOTHING ever rebuilt them. The only
// writers were the manual Apply button and the apply_run_plan MCP tool, so a run
// plan applied once kept prescribing that week's mileage forever while the live
// weekly mix moved on ("9.1 of 7.3 km this week", from a plan weeks out of date).
//
// This is the missing cadence: one bounded, reversible volume step at the natural
// boundary of a training week. Autonomy is NOT re-implemented here —
// buildRunPlanWithAutonomy hands the proposal to the same policy layer as every
// other adaptation, which owns the tier, the announcement, the decision ledger and
// the one-tap Undo. A week that already has an applied run plan is a calm no-op,
// as is an athlete the deterministic engine declines to prescribe runs for.
export const RUN_PLAN_APPLY_STATE_KEY = "run_plan_apply_last_slot";
export const RUN_PLAN_APPLY_DAY = 1; // Monday

// The gate, exported so the ownership test drives the real one: bg ops off means
// the cadence is off, and the Monday slot is miss-tolerant like every other.
export function runPlanApplyDue(
  now: Date,
  settings: { bg_ops_enabled: boolean; coach_hour: number }
): boolean {
  if (!settings.bg_ops_enabled) return false;
  return weeklySlotDue(now, RUN_PLAN_APPLY_DAY, settings.coach_hour, RUN_PLAN_APPLY_STATE_KEY);
}

export function runPlanAppliedSince(weekStartISO: string): boolean {
  const applied = lastAppliedRunPlanDate();
  return !!applied && applied >= weekStartISO;
}

// The exact body the Monday tick runs, exported so the ownership test drives the
// real decision rather than a restatement of it.
export function weeklyRunPlanApplyTask(weekStartISO: string): repo.SchedulerTaskCompletion<unknown> {
  // The machine only starts LEADING run weeks once the athlete has applied one
  // auto-built run plan through the explicit propose/apply flow. Until that has
  // happened the cardio rows on the plan are hand-authored — exactly what the
  // athlete asked for, and never stale (see appliedRunPlanCoversWeek in
  // repo/sessions.ts) — so there is nothing here to refresh, and under the default
  // "lead" posture this tick would otherwise quiet-apply a machine week straight
  // over the athlete's own. Handing over the run week stays an explicit act.
  if (lastAppliedRunPlanDate() === null) {
    console.log(`[proactive] no auto run plan has ever been applied — the run week is the athlete's (calm no-op).`);
    return { outcome: "no_op" };
  }
  if (runPlanAppliedSince(weekStartISO)) {
    console.log(`[proactive] this week's run plan is already applied (calm no-op).`);
    return { outcome: "no_op" };
  }
  const result = buildRunPlanWithAutonomy(weekStartISO);
  if (!result.ok) {
    // A designed ok:false — no running history / goal to shape a week from.
    console.log(`[proactive] no run week to prescribe (calm no-op).`);
    return { outcome: "no_op" };
  }
  const autonomy: any = result.autonomy;
  console.log(
    autonomy?.pending || autonomy?.announced
      ? `[proactive] scheduled this week's run plan for its natural boundary.`
      : autonomy?.tier === "quiet_apply"
        ? `[proactive] applied this week's run plan.`
        : `[proactive] this week's run plan is review-only under the configured posture.`
  );
  return { outcome: "succeeded", value: result };
}

export function startScheduler() {
  const heartbeatTick = () => repo.setAppState("scheduler_heartbeat", new Date().toISOString());
  // Synchronous first stamp makes readiness meaningful immediately after start.
  heartbeatTick();
  seedMemorySlotOnFreshInstall();
  // Wire agent-run telemetry: agents.ts can't import repo.ts (circular), so it
  // emits through a registered sink. recordAgentRun is itself failure-safe.
  setAgentRunSink((r) => repo.recordAgentRun(r));

  // Announced structural changes land only when their stated natural boundary
  // arrives. This is deterministic, fast, and idempotent; it never calls an
  // agent and every applied change already carries an exact undo snapshot.
  let boundaryApplyDate = "";
  const boundaryApplyTick = () => {
    const today = localToday();
    // Adopt orphaned drafts on EVERY tick, ahead of the once-a-day gate below: the
    // sweep is deterministic, agent-free, and idempotent (an adopted draft gains a
    // ledger row and is skipped thereafter), so a bounded change that was parked as
    // a bare draft (demoted by a since-fixed policy, or proposed in a since-elapsed
    // budget week) flips to its scheduled state within a minute — not at the next
    // calendar-day boundary pass. Isolated so a failure here never blocks the
    // boundary application below.
    try {
      const orphans = adoptOrphanedDrafts();
      if (orphans.adopted)
        console.log(`[brain] adopted ${orphans.adopted} orphaned draft(s) into the autonomy ledger.`);
    } catch (e: any) {
      recordSchedulerFailure("adopt_orphaned_drafts", e);
      console.error(`[brain] orphaned-draft adoption failed: ${e?.message ?? e}`);
    }
    if (boundaryApplyDate === today) return;
    boundaryApplyDate = today;
    try {
      const result = applyDueAnnouncedDecisions(today);
      if (result.applied.length)
        console.log(`[brain] applied ${result.applied.length} announced change(s) at their natural boundary.`);
      if (result.failed.length) {
        recordAsyncFailure("apply", "announced_boundary", new Error("one or more changes need review"));
        console.error(
          `[brain] ${result.failed.length} announced change(s) could not be applied; they remain reviewable.`
        );
      }
    } catch (e: any) {
      // Keep today's stamp: per-decision failures are isolated inside
      // applyDueAnnouncedDecisions, so a pass-level throw is an anomaly —
      // retrying it every 60s would just repeat the same failure all day.
      recordSchedulerFailure("announced_change_boundary", e);
      console.error(`[brain] announced-change boundary pass failed: ${e?.message ?? e}`);
    }
  };

  // Standing whole-person revision: once per month, at a detected phase change,
  // or when a non-parked domain regresses. Persist the conference as a durable
  // job; the request path never waits and a restart can recover it.
  let revisionBusy = false;
  const revisionTick = () => {
    if (revisionBusy) return;
    const today = localToday();
    if (repo.getAppState("brain_revision_check_date") === today) return;
    revisionBusy = true;
    // This is an attempt stamp, not a success stamp: it prevents an unavailable
    // specialist pool from being retried every minute. Successful phase/month
    // signatures are written by the completed case-conference job only.
    repo.setAppState("brain_revision_check_date", today);
    let revisionClaim: repo.SchedulerOperationClaim | null = null;
    try {
      const trajectory = repo.wholePersonTrajectory({ end: today, days: 56 });
      const month = today.slice(0, 7);
      const phaseSig = JSON.stringify(trajectory.phase);
      const regressionSig = trajectory.unexplained_worse.slice().sort().join("|");
      const monthlyDue = repo.getAppState("brain_revision_last_month") !== month;
      const previousPhase = repo.getAppState("brain_revision_phase_sig");
      const phaseDue = !!previousPhase && previousPhase !== phaseSig;
      const previousRegression = repo.getAppState("brain_revision_regression_sig");
      const regressionDue = !!regressionSig && regressionSig !== previousRegression;
      if (!monthlyDue && !phaseDue && !regressionDue) return;
      const revisionSlot = brainRevisionSlotStamp(month, phaseSig, regressionSig);
      if (!repo.schedulerOperationDue("brain_revision_conference", revisionSlot)) return;
      const revisionClaimResult = repo.claimSchedulerOperationWithStatus("brain_revision_conference", revisionSlot, {
        maxAttempts: 3,
        leaseMs: 6 * 60 * 60_000,
      });
      revisionClaim = revisionClaimResult.claim;
      if (revisionClaimResult.terminalized_expired_lease) {
        const terminalError = new Error(
          revisionClaimResult.operation.last_error || "revision conference lease exhausted"
        );
        recordSchedulerFailure("brain_revision_conference", terminalError);
        console.error(`[brain] revision conference exhausted after an expired final lease.`);
      }
      if (!revisionClaim) return;
      const reason = regressionDue
        ? `Unexplained regression requires a revision: ${trajectory.unexplained_worse.join(", ")}.`
        : phaseDue
          ? "The training or goal phase changed."
          : "Standing monthly whole-person review.";
      const job = repo.createAgentJob({
        kind: "case_conference",
        agent: null,
        input: {
          question: `${reason} Reconcile the next bounded revision against the standing objective: everything better. ${trajectory.line}`,
          domains: ["training", "nutrition", "health", "recovery", "lifestyle"],
          trajectory,
          optimizes: trajectory.phase.optimizes,
          parks: trajectory.phase.parks,
          scheduler_success: {
            brain_revision_last_month: month,
            brain_revision_phase_sig: phaseSig,
            brain_revision_regression_sig: regressionSig,
          },
          scheduler_operation: {
            operation: revisionClaim.operation,
            slot_stamp: revisionClaim.slot_stamp,
            claim_token: revisionClaim.claim_token,
            attempts: revisionClaim.attempts,
          },
        },
      }) as any;
      enqueueAgentJob(Number(job.id));
      console.log(
        `[brain] queued a whole-person revision conference (${regressionDue ? "regression" : phaseDue ? "phase" : "monthly"}).`
      );
    } catch (e: any) {
      if (revisionClaim) {
        repo.failSchedulerOperation(revisionClaim, e, {
          maxAttempts: 3,
          backoffMs: [12 * 60 * 60_000, 36 * 60 * 60_000],
        });
      }
      repo.setAppState("brain_revision_check_date", "");
      recordSchedulerFailure("brain_revision_check", e);
      console.error(`[brain] revision conference check failed: ${e?.message ?? e}`);
    } finally {
      revisionBusy = false;
    }
  };

  // The small-hours hour the nightly Brief precompute + quiet insight run at.
  // Declared up front so both the proactive tick and the precompute tick share it.
  const PRECOMPUTE_HOUR = (() => {
    const h = Number(process.env.DAYREAD_PRECOMPUTE_HOUR);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 4; // default 4am local
  })();

  // ---- Weekly coach draft (miss-tolerant) ----
  let coachBusy = false;
  const tick = async () => {
    if (coachBusy) return;
    const s = repo.getSettings();
    if (!s.coach_enabled) return;
    // The proactive evolution pass below is the richer whole-team review. Do not
    // create a second legacy draft for the same weekly slot.
    if (s.proactive_enabled) return;
    const now = new Date();
    if (!weeklySlotDue(now, s.coach_day, s.coach_hour, "coach_last_slot")) return;
    const slot = weeklySlotStamp(now, s.coach_day, s.coach_hour);
    coachBusy = true;
    try {
      await runScheduled("coach_last_slot", slot, "coach_last_slot", async () => {
        const prompt = buildCoachPrompt("Weekly automatic review.");
        // Same "proposal" task the interactive draftCoachProposal/evolveProgram ops
        // route through (see runChosen.ts taskForOp) — an agent_routes.proposal pin
        // applies here too, even though this legacy tick bypasses runChosen.
        const { agent, result } = await runAgentWithFallback(repo.pickAgentOrderForTask("proposal"), prompt, {
          op: "coach_draft",
          // …and the same server-owned execution profile (deep model, xhigh effort):
          // a structural plan change is the most consequential thing Cairn drafts.
          profile: repo.executionProfileForOp("coach_draft"),
          acceptParsed: acceptsWeeklyCoachProposal,
        });
        const proposal = repo.createProposal(agent, "auto: weekly review", result.raw, result.parsed);
        const autonomy = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "quiet_apply" });
        console.log(
          autonomy?.pending || autonomy?.announced
            ? `Auto-coach scheduled a proposal via ${agent} for its natural boundary.`
            : autonomy?.tier === "quiet_apply"
              ? `Auto-coach applied a bounded proposal via ${agent}.`
              : `Auto-coach stored a review-only proposal via ${agent}.`
        );
        return { outcome: "succeeded", value: { proposal, autonomy } };
      });
    } finally {
      coachBusy = false;
    }
  };

  // ---- Quiet proactivity (pull-never-push): the expert team reads continuously;
  //      bounded changes land through the autonomy ledger, never an Apply ritual. ----
  let proactiveBusy = false;
  const proactiveTick = async () => {
    if (proactiveBusy) return;
    const s = repo.getSettings();
    if (!s.proactive_enabled) return;
    const now = new Date();

    // (a) Nightly quiet insight — once per day, in the small hours alongside the
    //     Brief precompute. generateInsight emits ONE genuine connection or
    //     ok:false (dedup-guarded); a near-repeat / nothing-real is a calm no-op.
    const insightDue = dailyWindowOperationDue(now, PRECOMPUTE_HOUR, "insight_last_date");
    // (b) Weekly read — on the configured coach day/hour (miss-tolerant). A
    //     standing "how the week went + the one change", stored as a weekly_read
    //     insight. Reuses the coach slot so it lands on the same cadence.
    const weeklyDue = weeklySlotDue(now, s.coach_day, s.coach_hour, "weekly_read_last_slot");
    const weeklyHealthDue = weeklySlotDue(now, s.coach_day, s.coach_hour, "weekly_health_synthesis_last_slot");
    // (c) Weekly nutrition check-in — on the coach day/hour too (miss-tolerant).
    //     Drafts a nutrition_target proposal ONLY on meaningful drift; the calm,
    //     common answer is change:false (no draft).
    const nutritionDue = weeklySlotDue(now, s.coach_day, s.coach_hour, "nutrition_checkin_last_slot");
    // (c2) Weekly meals — rebuilt from the same whole-person context and activated at
    //      tomorrow's food-day boundary. If nutrition also moves, the pending target
    //      is threaded into the instruction so the two specialists stay coordinated.
    const mealRefreshRequest = repo.getAppState(MEAL_REFRESH_REQUEST_KEY);
    const mealRefreshDue = mealRefreshRetryDue(mealRefreshRequest, now, localToday(now));
    const weeklyMealPlanDue =
      !mealRefreshRequest && weeklySlotDue(now, s.coach_day, s.coach_hour, "meal_plan_refresh_last_slot");
    // An owned protective reshape has priority. While its retry backoff is
    // active, the ordinary weekly cadence must not bypass the owner or duplicate
    // the pending work.
    const mealPlanDue = mealRefreshDue || (weeklyMealPlanDue && !mealRefreshRequest);
    // (d) Weekly plan EVOLUTION — the continuous-coach cadence (miss-tolerant). Drafts
    //     a plan-evolution proposal (progress what's working, deload/rotate what's
    //     stalled, ground targets in logged reality, rebalance toward weak points) and
    //     leaves it WAITING for review — pull, never push. Only when there's a plan to
    //     evolve; a fresh weekly draft retires the prior unreviewed auto one (no pile-up).
    const evolutionDue = weeklySlotDue(now, s.coach_day, s.coach_hour, "program_evolution_last_slot");
    // (e') Keep PERIODIZATION LIVE (miss-tolerant, on the coach slot): ensure ONE
    //      active block exists for a training athlete, and advance an established
    //      block a week on cadence so its phase actually moves accumulation →
    //      intensification → deload/realization (the block model was cosmetic before —
    //      nothing ever advanced the week). Deterministic, no agent.
    const blockAdvanceDue = weeklySlotDue(now, s.coach_day, s.coach_hour, "block_advance_last_slot");
    // (e) Data-TRIGGERED plan evolution — the reactive half of "both". Checked at
    //     most once/day (cheap deterministic read); skipped on a tick where the
    //     weekly slot is already drafting (that path owns this evolution). The
    //     firing decision (signature changed + cooldown) is made inside the block.
    const triggerCheckDue = !evolutionDue && dailySlotDue(now, "program_evolution_trigger_date");
    // (f) Keep the TRAINING BENCHMARK attention (K5) fresh — a cheap, deterministic,
    //     no-agent pass (≤1×/day) that writes each tracked lift's + the test-week's
    //     re-test cadence onto the shared attention engine. This is what lets
    //     testWeekDue / the benchmark reads DEFER to the tier machine (active on a
    //     plateau/block checkpoint, released on clean progress) instead of a fixed
    //     interval — rule 2a. Without this pass the entries never exist and the reads
    //     fall back to the legacy cadence.
    const benchmarkAttnDue = dailySlotDue(now, "benchmark_attention_date");
    // (f2) Keep the LAB/MARKER attention (the doctor-loop half of K5) fresh — the
    //      counterpart of the training-benchmark pass. A cheap, deterministic,
    //      no-agent refresh (≤1×/day) that re-runs refreshDoctorLoopAttention() so
    //      each marker's recheck cadence advances (a released signal reactivates on a
    //      fresh off-optimal reading; a clean one converges to quiet) WITHOUT anyone
    //      opening the doctor-loop / next-checkup endpoint. The next-checkup read then
    //      reflects the same persisted attention state on the very next open.
    const checkupAttnDue = dailySlotDue(now, "checkup_attention_date");
    // (g) LEAD-MODE recovery auto-draft (≤1×/day). When the conductor's lead is the
    //     recovery-deload ASK (due, not running, nothing drafted) and the athlete has
    //     chosen lead posture, the coach drafts the recovery week ITSELF — the draft
    //     rides the exact one-tap path (evolveProgram → autonomy → announce → lands
    //     at the week boundary, Undo from Plan). This is the mechanism behind the
    //     conductor's "your coach sets this up automatically" line.
    const recoveryAutoDue = dailySlotDue(now, "recovery_auto_draft_date");
    // The fuel-protection read is deterministic and cheap enough for one daily
    // pass. It normally holds; only multi-channel agreement schedules a bounded
    // target/meal/recovery action through the existing autonomy ledger.
    const underfuelDue = dailySlotDue(now, "underfuel_control_last_date");

    if (
      !insightDue &&
      !weeklyDue &&
      !weeklyHealthDue &&
      !nutritionDue &&
      !mealPlanDue &&
      !evolutionDue &&
      !blockAdvanceDue &&
      !triggerCheckDue &&
      !benchmarkAttnDue &&
      !checkupAttnDue &&
      !recoveryAutoDue &&
      !underfuelDue
    )
      return;
    proactiveBusy = true;
    try {
      if (underfuelDue) {
        await runScheduled("underfuel_control_last_date", localToday(now), "underfuel_control_last_date", () => {
          const result = runUnderfuelingControlLoop(localToday(now));
          if (result.action !== "none") console.log(`[proactive] fuel-protection loop scheduled ${result.action}.`);
          return { outcome: result.action === "none" ? "no_op" : "succeeded", value: result };
        });
      }
      if (benchmarkAttnDue) {
        await runScheduled("benchmark_attention_date", localToday(now), "benchmark_attention_date", () => {
          const hasPlan = (repo.getPlan() as any[]).some((d) => Array.isArray(d.items) && d.items.length);
          if (hasPlan) {
            const entries = repo.refreshTrainingBenchmarkAttention();
            console.log(`[proactive] refreshed training benchmark attention (${entries.length} signal(s)).`);
            return { outcome: "succeeded", value: entries };
          }
          return { outcome: "no_op" };
        });
      }
      if (checkupAttnDue) {
        await runScheduled("checkup_attention_date", localToday(now), "checkup_attention_date", () => {
          // Only when there are markers on file — a fresh user with no labs has
          // nothing to schedule a recheck for (calm no-op, no churn).
          const hasMarkers = ((repo.getMarkerHistory() as any).markers || []).length > 0;
          if (hasMarkers) {
            const entries = repo.refreshDoctorLoopAttention();
            console.log(`[proactive] refreshed lab/marker recheck attention (${entries.length} signal(s)).`);
            return { outcome: "succeeded", value: entries };
          }
          return { outcome: "no_op" };
        });
      }
      if (blockAdvanceDue) {
        const blockSlot = weeklySlotStamp(now, s.coach_day, s.coach_hour);
        await runScheduled("block_advance_last_slot", blockSlot, "block_advance_last_slot", () => {
          const hasPlan = (repo.getPlan() as any[]).some((d) => Array.isArray(d.items) && d.items.length);
          if (hasPlan) {
            // Auto-create a sensible block when none is running (idempotent — never
            // resets one the athlete is mid-way through), then advance it a week —
            // but NOT a block that was only just created this slot (give it its week).
            const block = repo.ensureActiveBlock();
            const startedStamp = String(block.started_at || "").slice(0, 10);
            const ageDays = startedStamp ? daysBetweenStamps(startedStamp, localToday(now)) : 0;
            if (ageDays >= 6) {
              const advanced = repo.advanceBlockWeek();
              console.log(
                advanced
                  ? `[proactive] advanced the training block to ${advanced.phase} (week ${advanced.week_index} of ${advanced.total_weeks}).`
                  : `[proactive] no block to advance (calm no-op).`
              );
            } else {
              console.log(`[proactive] ensured an active training block (${block.focus}, week ${block.week_index}).`);
            }
            return { outcome: "succeeded", value: block };
          }
          return { outcome: "no_op" };
        });
      }
      if (insightDue) {
        await runScheduled("insight_last_date", localToday(now), "insight_last_date", async () => {
          // Warm the ai_cache with a 12h freshness so the morning open is a
          // guaranteed instant hit (no agent wait on the request path), like the
          // nightly Brief precompute → saveDayRead.
          const r = await generateInsight("auto", "connection", undefined, { freshForMs: 12 * 60 * 60 * 1000 });
          if (!r.ok && r.agent_status !== "ok") throw new Error(String(r.error || "insight provider unavailable"));
          console.log(
            r.ok ? `[proactive] stored a quiet insight.` : `[proactive] no genuine insight tonight (calm no-op).`
          );
          return { outcome: r.ok ? "succeeded" : "no_op", value: r };
        });
      }
      if (weeklyDue) {
        const weeklySlot = weeklySlotStamp(now, s.coach_day, s.coach_hour);
        await runScheduled("weekly_read_last_slot", weeklySlot, "weekly_read_last_slot", async () => {
          const r = await generateInsight("auto", "weekly_read", undefined, { freshForMs: 12 * 60 * 60 * 1000 });
          if (!r.ok && r.agent_status !== "ok") throw new Error(String(r.error || "weekly read provider unavailable"));
          console.log(
            r.ok ? `[proactive] stored the weekly read.` : `[proactive] no weekly read this week (calm no-op).`
          );
          return { outcome: r.ok ? "succeeded" : "no_op", value: r };
        });
      }
      if (weeklyHealthDue) {
        // Refresh the whole-picture health synthesis weekly too, so it absorbs
        // training/recovery drift (new labs already refresh it immediately via the
        // enrich review pass). Pull artifact — cached, never pushed.
        const weeklySlot = weeklySlotStamp(now, s.coach_day, s.coach_hour);
        await runScheduled(
          "weekly_health_synthesis_last_slot",
          weeklySlot,
          "weekly_health_synthesis_last_slot",
          async () => {
            const r = await synthesizeHealth("auto");
            if (!r.ok) throw new Error("health synthesis provider unavailable");
            console.log(`[proactive] refreshed the health synthesis.`);
            return { outcome: "succeeded", value: r };
          }
        );
      }
      let mealPlanInstruction =
        "Refresh the upcoming week of meals against the athlete's current training, recovery, health directives, preferences, schedule, and accepted nutrition target.";
      let nutritionChanged = false;
      if (mealRefreshDue) {
        const protectiveInstruction = repo.getAppState(MEAL_REFRESH_INSTRUCTION_KEY);
        if (protectiveInstruction) mealPlanInstruction = protectiveInstruction;
      }
      if (nutritionDue) {
        const weeklySlot = weeklySlotStamp(now, s.coach_day, s.coach_hour);
        const nutritionRun = await runScheduled(
          "nutrition_checkin_last_slot",
          weeklySlot,
          "nutrition_checkin_last_slot",
          async () => {
            const r: any = await nutritionCheckin("auto", undefined, undefined, { initiated: "auto" });
            if (!r.ok) throw new Error(String(r.error || "nutrition check-in provider unavailable"));
            const autonomy: any = r.autonomy;
            console.log(
              r.change
                ? autonomy?.pending || autonomy?.announced
                  ? `[proactive] scheduled an adaptive nutrition change for its natural boundary.`
                  : autonomy?.tier === "quiet_apply"
                    ? `[proactive] applied a bounded adaptive nutrition change.`
                    : `[proactive] nutrition change is review-only under the configured posture.`
                : `[proactive] nutrition steady — no change (calm no-op).`
            );
            return { outcome: r.change ? "succeeded" : "no_op", value: r };
          }
        );
        const nutritionResult: any = nutritionRun?.value;
        nutritionChanged = nutritionResult?.ok === true && nutritionResult.change === true;
        if (nutritionResult?.ok && nutritionResult.change && nutritionResult.proposal?.id) {
          const target = nutritionResult.proposal?.parsed?.nutrition;
          if (Number.isFinite(Number(target?.target_kcal))) {
            mealPlanInstruction =
              `Refresh the upcoming week of meals around the coordinated nutrition target that takes effect next: ` +
              `${Math.round(Number(target.target_kcal))} kcal, ` +
              `${Math.round(Number(target.protein_g) || 0)} g protein, ` +
              `${Math.round(Number(target.carbs_g) || 0)} g carbs, and ` +
              `${Math.round(Number(target.fat_g) || 0)} g fat. Keep it aligned with training, recovery, health directives, preferences, and schedule.`;
          }
        }
      }
      if (mealPlanDue) {
        if (mealRefreshDue && mealRefreshRequest) {
          try {
            const attempt = await runOwnedMealRefreshAttempt(
              mealRefreshRequest,
              () => draftMealPlan("auto", mealPlanInstruction, undefined, { coordinated_update: true }),
              { today: localToday(now) }
            );
            const r: any = attempt.result ?? { ok: false, error: attempt.error };
            if (attempt.ok) {
              // The owned protective reshape fulfills this week's ordinary meal
              // refresh too; acknowledging that slot prevents a second plan from
              // being drafted on the next minute after ownership clears.
              const weeklySlot = weeklySlotStamp(now, s.coach_day, s.coach_hour);
              repo.supersedeSchedulerOperation("meal_plan_refresh_last_slot", weeklySlot);
              repo.setAppState("meal_plan_refresh_last_slot", weeklySlot);
            }
            console.log(
              r.ok && (r.autonomy?.announced || r.autonomy?.pending)
                ? `[proactive] prepared the owned meal reshape; it lands at tomorrow's food-day boundary.`
                : r.ok
                  ? `[proactive] prepared the owned meal reshape under the configured review posture.`
                  : `[proactive] owned meal reshape remains queued for retry.`
            );
          } catch (e: any) {
            recordSchedulerFailure("meal_plan_refresh_owned", e);
            console.error(`[proactive] owned meal reshape failed: ${e?.message ?? e}`);
          }
        } else {
          const weeklySlot = weeklySlotStamp(now, s.coach_day, s.coach_hour);
          await runScheduled("meal_plan_refresh_last_slot", weeklySlot, "meal_plan_refresh_last_slot", async () => {
            const r: any = await draftMealPlan("auto", mealPlanInstruction, undefined, {
              coordinated_update: nutritionChanged,
            });
            if (!r.ok) throw new Error(String(r.error || "meal-plan provider unavailable"));
            console.log(
              r.autonomy?.announced || r.autonomy?.pending
                ? `[proactive] prepared the next meal plan; it lands at tomorrow's food-day boundary.`
                : `[proactive] prepared the next meal plan under the configured review posture.`
            );
            return { outcome: "succeeded", value: r };
          });
        }
      }
      if (evolutionDue) {
        const weeklySlot = weeklySlotStamp(now, s.coach_day, s.coach_hour);
        await runScheduled("program_evolution_last_slot", weeklySlot, "program_evolution_last_slot", async () => {
          // Nothing to evolve for a brand-new user with no plan — skip the agent call.
          //
          // And the scheduler deliberately does NOT compose one either, now that
          // composeWeek (src/coachOps.ts) can write a first week from nothing. That is
          // a DECISION, not a gap: a first week is the athlete's whole training shape,
          // and arriving with one they never asked for is exactly the push the
          // constitution rules out (VISION.md — pull-never-push, suggestion-not-a-gate).
          // They ask for it from the Plan tab's empty state, which enqueues the same
          // compose_week job; the draft then travels the ordinary review path. So this
          // stays a calm no-op forever, and the blank slate is answered on request.
          const hasPlan = (repo.getPlan() as any[]).some((d) => Array.isArray(d.items) && d.items.length);
          if (!hasPlan) {
            console.log(`[proactive] no plan to evolve yet (calm no-op).`);
            return { outcome: "no_op" };
          } else {
            const r: any = await evolveProgram("auto", repo.AUTO_EVOLUTION_INSTRUCTION);
            if (!r.ok) throw new Error(String(r.error || "program evolution provider unavailable"));
            // A successful fresh draft retires the prior unreviewed auto one (no pile-up).
            if (r.proposal?.id) {
              repo.supersedeAutoEvolutionDrafts(r.proposal.id);
              // Coordinate with the data-triggered path: the weekly draft has just
              // addressed whatever the data currently says, so reset the trigger's
              // cooldown + remember the condition it covered (the trigger only fires
              // again on a NEW shift, never a day after this for the same one).
              try {
                const trig = repo.programEvolutionTrigger();
                repo.setAppState("program_evolution_last_draft_date", localToday(now));
                repo.setAppState("program_evolution_trigger_sig", trig.signature);
              } catch {
                /* trigger read unavailable → leave stamps as-is */
              }
            }
            console.log(
              r.autonomy?.pending || r.autonomy?.announced
                ? `[proactive] scheduled a plan evolution for its natural boundary.`
                : r.autonomy?.tier === "quiet_apply"
                  ? `[proactive] applied a bounded plan evolution.`
                  : `[proactive] plan evolution is review-only under the configured posture.`
            );
            return { outcome: "succeeded", value: r };
          }
        });
      }
      if (recoveryAutoDue) {
        await runScheduled("recovery_auto_draft_date", localToday(now), "recovery_auto_draft_date", async () => {
          const focus: any = repo.getCoachingFocus();
          const draft = repo.shouldAutoDraftRecoveryWeek({
            lead_mode: s.lead_mode,
            focus_lead_domain: focus?.available ? focus?.lead?.domain : null,
            recovery_active: focus?.lead?.recovery_active,
            status: repo.recoveryWeekStatus(),
          });
          if (draft) {
            const r: any = await evolveProgram("auto", repo.RECOVERY_WEEK_INSTRUCTION);
            if (!r.ok) throw new Error(String(r.error || "recovery auto-draft provider unavailable"));
            console.log(
              `[proactive] lead mode: auto-drafted the recovery week (lands at the boundary; Undo from Plan).`
            );
            return { outcome: "succeeded", value: r };
          }
          return { outcome: "no_op" };
        });
      }
      if (triggerCheckDue) {
        await runScheduled(
          "program_evolution_trigger_date",
          localToday(now),
          "program_evolution_trigger_date",
          async () => {
            const hasPlan = (repo.getPlan() as any[]).some((d) => Array.isArray(d.items) && d.items.length);
            const trig = hasPlan
              ? repo.programEvolutionTrigger()
              : { due: false, reasons: [] as string[], signature: "" };
            // Fire ONLY on a genuine shift: the condition signature changed since the
            // last auto-evolution draft (a standing weak point drafts once, not daily)
            // AND a calm minimum spacing has elapsed (never two drafts within 5 days).
            const MIN_GAP_DAYS = 5;
            const lastSig = repo.getAppState("program_evolution_trigger_sig");
            const lastDraft = repo.getAppState("program_evolution_last_draft_date");
            const gapOk = !lastDraft || daysBetweenStamps(lastDraft, localToday(now)) >= MIN_GAP_DAYS;
            const sigChanged = !!trig.signature && trig.signature !== lastSig;
            if (trig.due && sigChanged && gapOk) {
              const task = `The athlete's logged training data has materially shifted: ${trig.reasons.join(" ")} Evolve the plan to address this NOW — rotate a close variation into what has stalled (don't just add load), build toward the under-trained groups (core / grip / a lagging pattern), and keep it fresh. Prefer 1-3 focused, well-justified changes. Explain each in plain words.`;
              const r: any = await evolveProgram("auto", repo.AUTO_EVOLUTION_INSTRUCTION, undefined, { task });
              if (!r.ok) throw new Error(String(r.error || "triggered evolution provider unavailable"));
              if (r.proposal?.id) {
                // Shares the weekly draft's single-slot dedup AND records the condition
                // it covered + resets the cooldown clock.
                repo.supersedeAutoEvolutionDrafts(r.proposal.id);
                repo.setAppState("program_evolution_trigger_sig", trig.signature);
                repo.setAppState("program_evolution_last_draft_date", localToday(now));
              }
              console.log(
                r.autonomy?.pending || r.autonomy?.announced
                  ? `[proactive] data-triggered plan evolution scheduled (${trig.reasons.length} reason(s)).`
                  : r.autonomy?.tier === "quiet_apply"
                    ? `[proactive] data-triggered plan evolution applied (${trig.reasons.length} reason(s)).`
                    : `[proactive] data-triggered plan evolution is review-only under the configured posture.`
              );
              return { outcome: "succeeded", value: r };
            } else if (trig.due) {
              console.log(`[proactive] training shifted but already drafted / within cooldown (calm no-op).`);
            }
            return { outcome: "no_op" };
          }
        );
      }
    } finally {
      proactiveBusy = false;
    }
  };

  // Garmin auto-sync: first attempt ~45s after boot, then roughly every 6 hours.
  // Configuration (saved/env credentials or exported token files) is re-checked
  // on every pass — same live-settings pattern as the coach tick — so saving
  // Garmin credentials in Settings starts syncing within a minute, no restart.
  // The 6h clock only advances when a sync actually runs; unconfigured passes
  // are a cheap settings read + two fs.existsSync calls.
  const GARMIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
  let garminDueAt = Date.now() + 44_000; // gate opens just before the 45s boot pass fires
  let garminBusy = false;
  const garminTick = async () => {
    if (garminBusy || Date.now() < garminDueAt) return;
    try {
      const { isGarminConfigured, syncGarmin } = await import("./garmin.js");
      if (!isGarminConfigured()) return;
      garminBusy = true;
      garminDueAt = Date.now() + GARMIN_INTERVAL_MS;
      const r = await syncGarmin(); // records garmin_last_sync_at/status itself
      if (r.ok) console.log(`[garmin] auto-sync ok: ${r.activities} activities, ${r.daily_metrics} daily metric days.`);
      else {
        recordSchedulerFailure("garmin_auto_sync", new Error(String(r.error || "sync failed")));
        console.error(`[garmin] auto-sync failed: ${r.error}`);
      }
    } catch (e: any) {
      recordSchedulerFailure("garmin_auto_sync", e);
      console.error(`[garmin] auto-sync error: ${e?.message ?? e}`);
    } finally {
      garminBusy = false;
    }
  };

  // Nightly Brief precompute: once per day in the small hours, compute & cache
  // today's canonical day-read so the morning open is instant (no agent wait on
  // the request path). Runs against the configured rotation; a failed compute
  // still caches the deterministic floor. PRECOMPUTE_HOUR is declared up top.
  let lastPrecomputeDate = "";
  let precomputeBusy = false;
  const precomputeTick = async () => {
    if (precomputeBusy) return;
    const now = new Date();
    if (nowContext(now).hour !== PRECOMPUTE_HOUR) return;
    // Warm the DEVICE's calendar date (recorded client zone), not the server's, so
    // a traveling owner's morning open still lands on a cached read.
    const stamp = warmToday(now);
    if (stamp === lastPrecomputeDate) return; // already ran this day
    lastPrecomputeDate = stamp;
    precomputeBusy = true;
    try {
      await precomputeDayRead(stamp);
      console.log(`[brief] precomputed today's day-read for ${stamp}.`);
    } catch (e: any) {
      recordSchedulerFailure("day_read_precompute", e);
      console.error(`[brief] nightly precompute failed: ${e?.message ?? e}`);
    } finally {
      precomputeBusy = false;
    }
  };

  // Stream 2 — quiet nightly memory housekeeping (once per day, at or after
  // MEMORY_HOUR; see memoryMaintenanceDue for the durable ownership). Each pass:
  // reconcile passed suggestions → durable learnings (deterministic, always), then
  // consolidate the memory store and grow about_me (agentic, best-effort — a failed
  // agent is a calm no-op). NEVER notifies; this is pure background curation the
  // user never has to think about.
  let memoryBusy = false;
  const memoryTick = async () => {
    if (memoryBusy) return;
    const now = new Date();
    if (!memoryMaintenanceDue(now)) return;
    const stamp = localToday(now);
    memoryBusy = true;
    try {
      await runScheduled(MEMORY_MAINT_STATE_KEY, stamp, MEMORY_MAINT_STATE_KEY, async () => {
        // 1. Deterministic outcome reconciliation — no agent, never fails the pass.
        try {
          const rec = repo.reconcileSuggestions();
          if (rec.learnings > 0)
            console.log(`[memory] reconciled ${rec.reconciled} suggestions → ${rec.learnings} learnings.`);
        } catch (e: any) {
          recordSchedulerFailure("memory_reconcile", e);
          console.error(`[memory] reconcile failed: ${e?.message ?? e}`);
        }
        // 1a. Mature generalized expectations before rebuilding the response model,
        // so the same nightly pass can learn from any newly authoritative verdict.
        try {
          const evaluated = evaluateMatureExpectations(stamp, { limit: 200 });
          if (evaluated.evaluated > 0) {
            console.log(`[brain] evaluated ${evaluated.evaluated}/${evaluated.scanned} matured expectation(s).`);
          }
          // A change that missed its prediction used to stay applied forever with
          // nobody told. File ONE quiet in-app note per such change on the
          // attention schedule, and retire the notes that have had their say.
          // Nothing is reverted and nothing is pushed — it waits to be read.
          const noted = surfaceExpectationMisses(evaluated.evaluations, stamp);
          const quieted = releaseStaleExpectationFollowups(stamp);
          if (noted.length || quieted) {
            console.log(`[brain] change follow-ups: ${noted.length} noted, ${quieted} released.`);
          }
          // …and the second half of the same fact: where the miss says the CHANGE
          // made the work worse, draft the step back and hand it to the autonomy
          // layer. Same evaluation set as the note above, so the two can never
          // disagree about which changes failed. Nothing is applied here — policy
          // decides whether the draft lands quietly, announces, or waits for review.
          const revisions = queueExpectationRevisions(evaluated.evaluations, stamp);
          const queued = revisions.filter((entry: { status: string }) => entry.status === "queued");
          if (revisions.length) {
            console.log(
              `[brain] step-backs: ${queued.length} queued (${queued.map((entry: { tier?: string | null }) => entry.tier ?? "?").join(", ") || "-"}), ` +
                `${revisions.length - queued.length} skipped.`
            );
          }
        } catch (e: any) {
          recordSchedulerFailure("maturity_evaluation", e);
          console.error(`[brain] maturity evaluation failed: ${e?.message ?? e}`);
        }
        // 1b. Rebuild the PERSONAL-RESPONSE model (deterministic) from the freshly
        //     reconciled history + latest logs — cache it + promote the load-bearing
        //     patterns into memory so the coach voice personalizes. Pull, never push.
        try {
          repo.saveReactionModel();
        } catch (e: any) {
          recordSchedulerFailure("reaction_model_rebuild", e);
          console.error(`[memory] reaction-model rebuild failed: ${e?.message ?? e}`);
        }
        // 1b′. Rebuild the FELT-SIGNALS model (deterministic) — what the athlete's own
        //      subjective steers / check-ins / fueling reads reveal — and cache it so
        //      getCoachContext + the Brief read it cheaply. Pull, never push; sparse
        //      data yields nothing. Isolated so it never sinks the nightly pass.
        try {
          repo.saveFeltSignals();
        } catch (e: any) {
          recordSchedulerFailure("felt_signals_rebuild", e);
          console.error(`[memory] felt-signals rebuild failed: ${e?.message ?? e}`);
        }
        // 1b″. Rebuild the LEARNED CROSS-DOMAIN models (deterministic) — endurance→
        //      strength interference + short-sleep→fueling — and cache them so
        //      getCoachContext + the Brief read them cheaply. Pull, never push; sparse
        //      data yields nothing. Isolated so it never sinks the nightly pass.
        try {
          repo.saveLearnedModels();
        } catch (e: any) {
          recordSchedulerFailure("learned_models_rebuild", e);
          console.error(`[memory] learned-models rebuild failed: ${e?.message ?? e}`);
        }
        // 1c. Write the plain-language NARRATIVE over the freshly rebuilt patterns
        //     (agentic, best-effort). A quiet/failed agent leaves the prior narrative,
        //     and an emptied model already cleared it in saveReactionModel. Pull, never push.
        try {
          const { refreshReactionNarrative } = await import("./coachOps.js");
          const rn: any = await refreshReactionNarrative("auto");
          if (rn.ok && rn.narrative) console.log(`[memory] refreshed the reaction-model narrative.`);
        } catch (e: any) {
          recordSchedulerFailure("reaction_narrative_refresh", e);
          console.error(`[memory] reaction-model narrative refresh failed: ${e?.message ?? e}`);
        }
        // 2. Agentic consolidation + about-me growth — best-effort, lazy-imported.
        try {
          const { consolidateMemory, growAboutMe } = await import("./coachOps.js");
          const c = await consolidateMemory("auto");
          if (c.ok && (c.merged || c.superseded || c.promoted))
            console.log(`[memory] consolidated: ${c.merged} merged, ${c.superseded} superseded, ${c.promoted} promoted.`);
          const g = await growAboutMe("auto");
          if (g.ok && (g as any).changed) console.log(`[memory] grew about_me from memory.`);
        } catch (e: any) {
          recordSchedulerFailure("memory_consolidation", e);
          console.error(`[memory] nightly consolidation failed: ${e?.message ?? e}`);
        }
        // 3. Agentic exercise-name tidy — best-effort, pull-never-push. Messy /
        //    duplicate movement titles self-align over time so the volume +
        //    progression read stays clean (never touches logged numbers).
        try {
          const { reconcileExercises } = await import("./coachOps.js");
          // Nightly, background: fill only empty groups — never override a group the
          // athlete may have set (that override is reserved for the user-initiated "Tidy").
          const x: any = await reconcileExercises("auto", undefined, { authoritativeGroups: false });
          if (x.ok && x.applied)
            console.log(`[memory] tidied exercise names: ${x.applied} alias(es) across ${x.aligned} movement(s).`);
        } catch (e: any) {
          recordSchedulerFailure("exercise_reconciliation", e);
          console.error(`[memory] nightly exercise tidy failed: ${e?.message ?? e}`);
        }
        // Every step above isolates its own failure, so reaching here means the pass
        // ran. Acknowledging the day is what makes the next tick skip it — and what a
        // process restarted later today reads instead of running it all again.
        return { outcome: "succeeded" as const };
      });
    } finally {
      memoryBusy = false;
    }
  };

  // ---- Self-hosted update check (pull-never-push). Once per day at most, gated
  //      on settings.update_check_enabled. Reaches the GitHub Releases API and
  //      STORES the result in app_state; nothing notifies — the Settings → Data
  //      card reads it. Provider failures use the same bounded durable retry
  //      contract as coaching work; a legitimate successful check acknowledges
  //      the day while the last good cache remains available throughout. ----
  let updateCheckBusy = false;
  const updateCheckTick = async () => {
    if (updateCheckBusy) return;
    if (!repo.getSettings().update_check_enabled) return;
    const today = localToday();
    const now = new Date();
    if (!dailySlotDue(now, "update_check_last_date")) return;
    updateCheckBusy = true;
    try {
      await runScheduled("update_check_last_date", today, "update_check_last_date", async () => {
        const r = await checkForUpdate();
        if (r.error) throw new Error(String(r.error));
        if (r.update_available)
          console.log(`[update] a newer Cairn is available: ${r.latest} (running ${r.current}) — see Settings → Data.`);
        else console.log(`[update] up to date (${r.current}).`);
        return { outcome: "succeeded", value: r };
      });
    } finally {
      updateCheckBusy = false;
    }
  };

  // ---- Connected-brain propagation (labs → nutrition / training / watch). ----
  //      deriveDirectives() is diff-based, idempotent and feedback-suppressing, and folds a
  //      coarse monthly reading-AGE bucket into its signature — so the PASSAGE OF TIME alone
  //      moves a directive (an aging finding picks up its age note, then softens to
  //      uncertain past a year). Nothing ever ran it on a timer, though: it only fired when
  //      a lab landed or someone hit /api/directives/derive, so on a quiet month the
  //      propagation engine was dormant and directives aged silently.
  //
  //      Deliberately its OWN tick and NOT a step inside proactiveTick: this is
  //      deterministic, spawns no agent and pushes nothing, so the connected brain must not
  //      be tied to the settings.proactive_enabled toggle.
  //
  //      The daily slot flips at LOCAL MIDNIGHT — hours before PRECOMPUTE_HOUR — so the
  //      nightly Brief precompute warms against fresh directives, instead of a derive
  //      invalidating the cached read moments after it was computed.
  let propagationBusy = false;
  const propagationTick = async () => {
    if (propagationBusy) return;
    const now = new Date();
    if (!dailySlotDue(now, "directive_derive_date")) return;
    propagationBusy = true;
    try {
      await runScheduled("directive_derive_date", localToday(now), "directive_derive_date", () => {
        // No markers on file → nothing to propagate. Calm no-op (mirrors the
        // checkup-attention guard), and it still acknowledges the day.
        const hasMarkers = ((repo.getMarkerHistory() as any).markers || []).length > 0;
        if (!hasMarkers) return { outcome: "no_op" };
        const out = repo.deriveDirectives();
        // Log only when something actually moved — an unchanged pass is the common case
        // and must stay silent.
        if (out.derived > 0) console.log(`[brain] re-derived the connected brain (${out.derived} directive(s) moved).`);
        return { outcome: "succeeded", value: out };
      });
    } finally {
      propagationBusy = false;
    }
  };

  // ---- The personal HR model (observed max, threshold, zone bands). ----
  //      Derived, never a population formula, and a pure function of logged
  //      activity plus the calibration ledger — so it is re-derived on a daily
  //      slot for exactly the reason directives are: the PASSAGE OF TIME alone
  //      moves it. A field test ages out of its 120-day window; the 183-day
  //      observation window slides off an old peak; a resting-HR reading goes
  //      stale and stops counting. Nothing here spawns an agent or pushes
  //      anything, so like the propagation tick it is independent of the
  //      proactive toggle. The sync path re-derives too (fresh runs land there
  //      first); this is the floor that runs on a week with no sync at all.
  let hrModelBusy = false;
  const hrModelTick = async () => {
    if (hrModelBusy) return;
    const now = new Date();
    if (!dailySlotDue(now, "hr_model_derive_date")) return;
    hrModelBusy = true;
    try {
      await runScheduled("hr_model_derive_date", localToday(now), "hr_model_derive_date", () => {
        const model = repo.deriveHrModel(localToday(now));
        // A model with nothing to read is a calm no-op — an athlete who logs no
        // heart rate is not a failure, and the day is still acknowledged.
        if (model.confidence === "insufficient") return { outcome: "no_op" };
        return { outcome: "succeeded", value: model };
      });
    } finally {
      hrModelBusy = false;
    }
  };

  // Its OWN tick, deliberately not a step inside proactiveTick: keeping the
  // endurance week current is deterministic and spawns no agent, so it must not
  // ride the settings.proactive_enabled toggle. Miss-tolerant like every other
  // weekly slot — a process asleep on Monday morning catches up on the next tick.
  let runPlanApplyBusy = false;
  const runPlanApplyTick = async () => {
    if (runPlanApplyBusy) return;
    const settings = repo.getSettings();
    const now = new Date();
    if (!runPlanApplyDue(now, settings)) return;
    const slot = weeklySlotStamp(now, RUN_PLAN_APPLY_DAY, settings.coach_hour);
    runPlanApplyBusy = true;
    try {
      await runScheduled(RUN_PLAN_APPLY_STATE_KEY, slot, RUN_PLAN_APPLY_STATE_KEY, () =>
        weeklyRunPlanApplyTask(slot)
      );
    } finally {
      runPlanApplyBusy = false;
    }
  };

  const s = repo.getSettings(); // also lazily creates the row (seeding env defaults)
  const schedulerZone = repo.recordedClientTimeZone() ?? "server local time until a device reports its zone";
  console.log(
    `Background coaching cadence: day=${s.coach_day}, hour=${s.coach_hour}, timezone=${schedulerZone}, strategy=${s.agent_strategy}.`
  );
  console.log(
    s.proactive_enabled
      ? "Quiet proactivity enabled (insights wait in-app; never pushed)."
      : "Quiet proactivity disabled (enable it in Settings)."
  );
  // Scheduler work has no request header, so re-establish the most recently
  // observed PWA timezone for every pass. The lookup happens per tick: travel or
  // daylight-saving changes take effect without a restart.
  const inOwnerTimeZone =
    <T>(fn: () => T) =>
    () =>
      runWithTimeZone(repo.recordedClientTimeZone(), fn);
  setInterval(inOwnerTimeZone(tick), 60_000); // check every minute
  setInterval(inOwnerTimeZone(boundaryApplyTick), 60_000);
  setInterval(inOwnerTimeZone(revisionTick), 60_000);
  setInterval(inOwnerTimeZone(proactiveTick), 60_000);
  setInterval(inOwnerTimeZone(garminTick), 60_000);
  setInterval(inOwnerTimeZone(precomputeTick), 60_000);
  setInterval(inOwnerTimeZone(memoryTick), 60_000); // Stream 2: nightly memory maintenance
  setInterval(inOwnerTimeZone(updateCheckTick), 60_000); // self-hosted update check (≤ once/day)
  setInterval(inOwnerTimeZone(propagationTick), 60_000); // connected-brain re-derivation (≤ once/day)
  setInterval(inOwnerTimeZone(hrModelTick), 60_000); // personal HR model re-derivation (≤ once/day)
  setInterval(inOwnerTimeZone(runPlanApplyTick), 60_000); // keep the applied run week current (Mondays)
  setInterval(heartbeatTick, 60_000); // readiness evidence; no agent/provider dependency
  setTimeout(inOwnerTimeZone(garminTick), 45_000); // the boot-time pass; later passes ride the minute tick
  setTimeout(inOwnerTimeZone(updateCheckTick), 30_000); // first update check shortly after boot (then daily)
  setTimeout(inOwnerTimeZone(propagationTick), 20_000); // catch up a day the process slept through
  setTimeout(inOwnerTimeZone(hrModelTick), 25_000); // same catch-up for the HR model
  setTimeout(inOwnerTimeZone(runPlanApplyTick), 25_000); // catch up a Monday the process slept through
  setTimeout(inOwnerTimeZone(boundaryApplyTick), 5_000);
  setTimeout(inOwnerTimeZone(revisionTick), 15_000);

  // Boot warm: if today's read isn't cached yet (e.g. a mid-day restart), compute
  // it in the background so the very next open is instant too. Safe no-op when an
  // agent is unreachable — it caches the deterministic floor.
  setTimeout(
    inOwnerTimeZone(() => {
      const today = warmToday();
      if (!repo.getCachedDayRead(today)) {
        precomputeDayRead(today)
          .then(() => console.log(`[brief] warmed today's day-read for ${today}.`))
          .catch((error) => recordSchedulerFailure("day_read_boot_warm", error));
      }
    }),
    15_000
  );
}
