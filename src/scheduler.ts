import * as repo from "./repo.js";
import { runAgentWithFallback, setAgentRunSink } from "./agents.js";
import { buildCoachPrompt } from "./prompt.js";
import { draftMealPlan, evolveProgram, generateInsight, nutritionCheckin, synthesizeHealth } from "./coachOps.js";
import { precomputeDayRead, localToday, warmToday } from "./dayread.js";
import { checkForUpdate } from "./updateCheck.js";
import { evaluateMatureExpectations } from "./brainEvaluator.js";
import { applyDueAnnouncedDecisions, applyProposalWithAutonomy } from "./domain/brain/autonomy-service.js";
import { enqueueAgentJob } from "./agentJobs.js";
import { recordAsyncFailure, recordSchedulerFailure } from "./diagnostics.js";
// Stream 2 (self-updating memory): quiet nightly memory housekeeping + outcome
// reconciliation. Lazy-imported in the tick so this module stays decoupled.

// Weekly expert-team review + quiet proactivity. Configured in Settings (persisted in
// the DB, editable from the PWA at runtime — no restart needed): coach_enabled,
// coach_day (0=Sun..6=Sat), coach_hour (local). When the slot arrives it drafts
// ONE proposal using the configured agent rotation (round-robin / random /
// priority, with fallthrough). In lead mode it routes through the same bounded,
// reversible autonomy ledger as every other adaptation; review mode still parks it.
//
// The weekly coach draft is MISS-TOLERANT: rather than firing only on exact
// hour equality (which silently skips the week if the process was asleep at that
// minute), it fires when the most recent scheduled slot has passed and it hasn't
// run for that slot yet — tracked via a persisted last-run stamp (app_state), so
// a missed slot still drafts once when the server comes back.
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

// The most recent past (or current) occurrence of weekday `day` at hour `hour`,
// as a local Date. Used for miss-tolerant weekly slots: if `now >= slot` and we
// haven't run for that slot's date, the slot is due.
function lastScheduledSlot(now: Date, day: number, hour: number): Date {
  const slot = new Date(now);
  slot.setHours(hour, 0, 0, 0);
  // Walk back to the target weekday (0..6). If today IS the day but the hour
  // hasn't arrived yet, this still lands today and the now>=slot guard defers it.
  let back = (now.getDay() - day + 7) % 7;
  // If it's the right weekday but before the hour, the most recent occurrence was
  // a week ago.
  if (back === 0 && now.getTime() < slot.getTime()) back = 7;
  slot.setTime(slot.getTime() - back * DAY_MS);
  return slot;
}

// True when the weekly slot's most recent occurrence has passed and the persisted
// last-run stamp doesn't already cover it. Records the stamp as a side effect
// when it returns true (so it fires once per slot, restart-tolerant).
function weeklySlotDue(now: Date, day: number, hour: number, stateKey: string): boolean {
  const slot = lastScheduledSlot(now, day, hour);
  if (now.getTime() < slot.getTime()) return false; // the slot hasn't arrived yet
  const slotStamp = localToday(slot);
  if (repo.getAppState(stateKey) === slotStamp) return false; // already ran for this slot
  repo.setAppState(stateKey, slotStamp);
  return true;
}

// Whole-day gap between two YYYY-MM-DD stamps (both produced by localToday). Used
// to enforce a calm minimum spacing between data-triggered evolution drafts.
function daysBetweenStamps(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / DAY_MS) : Number.POSITIVE_INFINITY;
}

export function startScheduler() {
  const heartbeatTick = () => repo.setAppState("scheduler_heartbeat", new Date().toISOString());
  // Synchronous first stamp makes readiness meaningful immediately after start.
  heartbeatTick();
  // Wire agent-run telemetry: agents.ts can't import repo.ts (circular), so it
  // emits through a registered sink. recordAgentRun is itself failure-safe.
  setAgentRunSink((r) => repo.recordAgentRun(r));

  // Announced structural changes land only when their stated natural boundary
  // arrives. This is deterministic, fast, and idempotent; it never calls an
  // agent and every applied change already carries an exact undo snapshot.
  let boundaryApplyDate = "";
  const boundaryApplyTick = () => {
    const today = localToday();
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
        },
      }) as any;
      enqueueAgentJob(Number(job.id));
      console.log(
        `[brain] queued a whole-person revision conference (${regressionDue ? "regression" : phaseDue ? "phase" : "monthly"}).`
      );
    } catch (e: any) {
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
    coachBusy = true;
    try {
      const prompt = buildCoachPrompt("Weekly automatic review.");
      const { agent, result } = await runAgentWithFallback(repo.pickAgentOrder(), prompt, { op: "coach_draft" });
      const proposal = repo.createProposal(agent, "auto: weekly review", result.raw, result.parsed);
      const autonomy = result.parsed
        ? applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "quiet_apply" })
        : null;
      console.log(
        autonomy?.pending || autonomy?.announced
          ? `Auto-coach scheduled a proposal via ${agent} for its natural boundary.`
          : autonomy?.tier === "quiet_apply"
            ? `Auto-coach applied a bounded proposal via ${agent}.`
            : `Auto-coach stored a review-only proposal via ${agent} (parsed=${!!result.parsed}).`
      );
    } catch (e: any) {
      recordSchedulerFailure("weekly_coach_draft", e);
      console.error(`Auto-coach failed: ${e.message}`);
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
    const insightDue = now.getHours() === PRECOMPUTE_HOUR && repo.getAppState("insight_last_date") !== localToday(now);
    // (b) Weekly read — on the configured coach day/hour (miss-tolerant). A
    //     standing "how the week went + the one change", stored as a weekly_read
    //     insight. Reuses the coach slot so it lands on the same cadence.
    const weeklyDue = weeklySlotDue(now, s.coach_day, s.coach_hour, "weekly_read_last_slot");
    // (c) Weekly nutrition check-in — on the coach day/hour too (miss-tolerant).
    //     Drafts a nutrition_target proposal ONLY on meaningful drift; the calm,
    //     common answer is change:false (no draft).
    const nutritionDue = weeklySlotDue(now, s.coach_day, s.coach_hour, "nutrition_checkin_last_slot");
    // (c2) Weekly meals — rebuilt from the same whole-person context and activated at
    //      tomorrow's food-day boundary. If nutrition also moves, the pending target
    //      is threaded into the instruction so the two specialists stay coordinated.
    const mealRefreshRequest = repo.getAppState("meal_plan_refresh_requested");
    const mealRefreshDue =
      !!mealRefreshRequest &&
      mealRefreshRequest <= localToday(now) &&
      repo.getAppState("meal_plan_refresh_attempt_for") !== mealRefreshRequest;
    const mealPlanDue = weeklySlotDue(now, s.coach_day, s.coach_hour, "meal_plan_refresh_last_slot") || mealRefreshDue;
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
    const triggerCheckDue = !evolutionDue && repo.getAppState("program_evolution_trigger_date") !== localToday(now);
    // (f) Keep the TRAINING BENCHMARK attention (K5) fresh — a cheap, deterministic,
    //     no-agent pass (≤1×/day) that writes each tracked lift's + the test-week's
    //     re-test cadence onto the shared attention engine. This is what lets
    //     testWeekDue / the benchmark reads DEFER to the tier machine (active on a
    //     plateau/block checkpoint, released on clean progress) instead of a fixed
    //     interval — rule 2a. Without this pass the entries never exist and the reads
    //     fall back to the legacy cadence.
    const benchmarkAttnDue = repo.getAppState("benchmark_attention_date") !== localToday(now);
    // (g) LEAD-MODE recovery auto-draft (≤1×/day). When the conductor's lead is the
    //     recovery-deload ASK (due, not running, nothing drafted) and the athlete has
    //     chosen lead posture, the coach drafts the recovery week ITSELF — the draft
    //     rides the exact one-tap path (evolveProgram → autonomy → announce → lands
    //     at the week boundary, Undo from Plan). This is the mechanism behind the
    //     conductor's "your coach sets this up automatically" line.
    const recoveryAutoDue = repo.getAppState("recovery_auto_draft_date") !== localToday(now);

    if (
      !insightDue &&
      !weeklyDue &&
      !nutritionDue &&
      !mealPlanDue &&
      !evolutionDue &&
      !blockAdvanceDue &&
      !triggerCheckDue &&
      !benchmarkAttnDue &&
      !recoveryAutoDue
    )
      return;
    proactiveBusy = true;
    try {
      if (benchmarkAttnDue) {
        // Stamp first (cheap deterministic read; runs ≤1×/day). Only for a training
        // athlete with a plan — nothing to benchmark otherwise.
        repo.setAppState("benchmark_attention_date", localToday(now));
        try {
          const hasPlan = (repo.getPlan() as any[]).some((d) => Array.isArray(d.items) && d.items.length);
          if (hasPlan) {
            const entries = repo.refreshTrainingBenchmarkAttention();
            console.log(`[proactive] refreshed training benchmark attention (${entries.length} signal(s)).`);
          }
        } catch (e: any) {
          recordSchedulerFailure("benchmark_attention_refresh", e);
          console.error(`[proactive] benchmark attention refresh failed: ${e?.message ?? e}`);
        }
      }
      if (blockAdvanceDue) {
        try {
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
          }
        } catch (e: any) {
          recordSchedulerFailure("training_block_advance", e);
          console.error(`[proactive] block advance failed: ${e?.message ?? e}`);
        }
      }
      if (insightDue) {
        repo.setAppState("insight_last_date", localToday(now));
        try {
          // Warm the ai_cache with a 12h freshness so the morning open is a
          // guaranteed instant hit (no agent wait on the request path), like the
          // nightly Brief precompute → saveDayRead.
          const r = await generateInsight("auto", "connection", undefined, { freshForMs: 12 * 60 * 60 * 1000 });
          console.log(
            r.ok ? `[proactive] stored a quiet insight.` : `[proactive] no genuine insight tonight (calm no-op).`
          );
        } catch (e: any) {
          recordSchedulerFailure("quiet_insight", e);
          console.error(`[proactive] insight pass failed: ${e?.message ?? e}`);
        }
      }
      if (weeklyDue) {
        try {
          const r = await generateInsight("auto", "weekly_read", undefined, { freshForMs: 12 * 60 * 60 * 1000 });
          console.log(
            r.ok ? `[proactive] stored the weekly read.` : `[proactive] no weekly read this week (calm no-op).`
          );
        } catch (e: any) {
          recordSchedulerFailure("weekly_read", e);
          console.error(`[proactive] weekly read failed: ${e?.message ?? e}`);
        }
        // Refresh the whole-picture health synthesis weekly too, so it absorbs
        // training/recovery drift (new labs already refresh it immediately via the
        // enrich review pass). Pull artifact — cached, never pushed.
        try {
          const r = await synthesizeHealth("auto");
          console.log(
            r.ok ? `[proactive] refreshed the health synthesis.` : `[proactive] health synthesis steady (calm no-op).`
          );
        } catch (e: any) {
          recordSchedulerFailure("health_synthesis", e);
          console.error(`[proactive] health synthesis failed: ${e?.message ?? e}`);
        }
      }
      let mealPlanInstruction =
        "Refresh the upcoming week of meals against the athlete's current training, recovery, health directives, preferences, schedule, and accepted nutrition target.";
      if (nutritionDue) {
        try {
          const r: any = await nutritionCheckin("auto");
          const autonomy: any = r.autonomy;
          if (r.ok && r.change && r.proposal?.id) {
            const target = r.proposal?.parsed?.nutrition;
            if (Number.isFinite(Number(target?.target_kcal))) {
              mealPlanInstruction =
                `Refresh the upcoming week of meals around the coordinated nutrition target that takes effect next: ` +
                `${Math.round(Number(target.target_kcal))} kcal, ` +
                `${Math.round(Number(target.protein_g) || 0)} g protein, ` +
                `${Math.round(Number(target.carbs_g) || 0)} g carbs, and ` +
                `${Math.round(Number(target.fat_g) || 0)} g fat. Keep it aligned with training, recovery, health directives, preferences, and schedule.`;
            }
          }
          console.log(
            r.ok && r.change
              ? autonomy?.pending || autonomy?.announced
                ? `[proactive] scheduled an adaptive nutrition change for its natural boundary.`
                : autonomy?.tier === "quiet_apply"
                  ? `[proactive] applied a bounded adaptive nutrition change.`
                  : `[proactive] nutrition change is review-only under the configured posture.`
              : r.ok
                ? `[proactive] nutrition steady — no change (calm no-op).`
                : `[proactive] nutrition check-in unavailable (calm no-op).`
          );
        } catch (e: any) {
          recordSchedulerFailure("nutrition_checkin", e);
          console.error(`[proactive] nutrition check-in failed: ${e?.message ?? e}`);
        }
      }
      if (mealPlanDue) {
        if (mealRefreshDue) repo.setAppState("meal_plan_refresh_attempt_for", mealRefreshRequest);
        try {
          const r: any = await draftMealPlan("auto", mealPlanInstruction, undefined, {
            coordinated_update: nutritionDue || mealRefreshDue,
          });
          if (r.ok && mealRefreshDue) repo.setAppState("meal_plan_refresh_requested", "");
          console.log(
            r.ok && (r.autonomy?.announced || r.autonomy?.pending)
              ? `[proactive] prepared the next meal plan; it lands at tomorrow's food-day boundary.`
              : r.ok
                ? `[proactive] prepared the next meal plan under the configured review posture.`
                : `[proactive] meal-plan refresh unavailable (calm no-op).`
          );
        } catch (e: any) {
          recordSchedulerFailure("meal_plan_refresh", e);
          console.error(`[proactive] meal-plan refresh failed: ${e?.message ?? e}`);
        }
      }
      if (evolutionDue) {
        try {
          // Nothing to evolve for a brand-new user with no plan — skip the agent call.
          const hasPlan = (repo.getPlan() as any[]).some((d) => Array.isArray(d.items) && d.items.length);
          if (!hasPlan) {
            console.log(`[proactive] no plan to evolve yet (calm no-op).`);
          } else {
            const r: any = await evolveProgram("auto", repo.AUTO_EVOLUTION_INSTRUCTION);
            // A successful fresh draft retires the prior unreviewed auto one (no pile-up).
            if (r.ok && r.proposal?.id) {
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
              r.ok && (r.autonomy?.pending || r.autonomy?.announced)
                ? `[proactive] scheduled a plan evolution for its natural boundary.`
                : r.ok && r.autonomy?.tier === "quiet_apply"
                  ? `[proactive] applied a bounded plan evolution.`
                  : r.ok
                    ? `[proactive] plan evolution is review-only under the configured posture.`
                    : `[proactive] plan evolution unavailable (calm no-op).`
            );
          }
        } catch (e: any) {
          recordSchedulerFailure("program_evolution", e);
          console.error(`[proactive] plan evolution failed: ${e?.message ?? e}`);
        }
      }
      if (recoveryAutoDue) {
        // Stamp first (≤1×/day even when nothing drafts) so it can't re-run every tick.
        repo.setAppState("recovery_auto_draft_date", localToday(now));
        try {
          const focus: any = repo.getCoachingFocus();
          const draft = repo.shouldAutoDraftRecoveryWeek({
            lead_mode: s.lead_mode,
            focus_lead_domain: focus?.available ? focus?.lead?.domain : null,
            recovery_active: focus?.lead?.recovery_active,
            status: repo.recoveryWeekStatus(),
          });
          if (draft) {
            const r: any = await evolveProgram("auto", repo.RECOVERY_WEEK_INSTRUCTION);
            console.log(
              r.ok
                ? `[proactive] lead mode: auto-drafted the recovery week (lands at the boundary; Undo from Plan).`
                : `[proactive] recovery auto-draft unavailable (calm no-op).`
            );
          }
        } catch (e: any) {
          recordSchedulerFailure("recovery_auto_draft", e);
          console.error(`[proactive] recovery auto-draft failed: ${e?.message ?? e}`);
        }
      }
      if (triggerCheckDue) {
        // Stamp the daily check first (cheap deterministic read; runs ≤1×/day even
        // if no draft results) so it can't re-run every 60s tick.
        repo.setAppState("program_evolution_trigger_date", localToday(now));
        try {
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
            if (r.ok && r.proposal?.id) {
              // Shares the weekly draft's single-slot dedup AND records the condition
              // it covered + resets the cooldown clock.
              repo.supersedeAutoEvolutionDrafts(r.proposal.id);
              repo.setAppState("program_evolution_trigger_sig", trig.signature);
              repo.setAppState("program_evolution_last_draft_date", localToday(now));
            }
            console.log(
              r.ok && (r.autonomy?.pending || r.autonomy?.announced)
                ? `[proactive] data-triggered plan evolution scheduled (${trig.reasons.length} reason(s)).`
                : r.ok && r.autonomy?.tier === "quiet_apply"
                  ? `[proactive] data-triggered plan evolution applied (${trig.reasons.length} reason(s)).`
                  : r.ok
                    ? `[proactive] data-triggered plan evolution is review-only under the configured posture.`
                    : `[proactive] data-triggered evolution unavailable (calm no-op).`
            );
          } else if (trig.due) {
            console.log(`[proactive] training shifted but already drafted / within cooldown (calm no-op).`);
          }
        } catch (e: any) {
          recordSchedulerFailure("program_evolution_trigger", e);
          console.error(`[proactive] evolution trigger failed: ${e?.message ?? e}`);
        }
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
    if (now.getHours() !== PRECOMPUTE_HOUR) return;
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

  // Stream 2 — quiet nightly memory housekeeping (runs once per day at MEMORY_HOUR,
  // default 3am local, an hour before the Brief precompute so the agent isn't
  // double-booked). Each pass: reconcile passed suggestions → durable learnings
  // (deterministic, always), then consolidate the memory store and grow about_me
  // (agentic, best-effort — a failed agent is a calm no-op). NEVER notifies; this
  // is pure background curation the user never has to think about.
  const MEMORY_HOUR = (() => {
    const h = Number(process.env.MEMORY_MAINT_HOUR);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 3; // default 3am local
  })();
  let lastMemoryDate = "";
  let memoryBusy = false;
  const memoryTick = async () => {
    if (memoryBusy) return;
    const now = new Date();
    if (now.getHours() !== MEMORY_HOUR) return;
    const stamp = localToday(now);
    if (stamp === lastMemoryDate) return; // already ran today
    lastMemoryDate = stamp;
    memoryBusy = true;
    try {
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
        const x: any = await reconcileExercises("auto");
        if (x.ok && x.applied)
          console.log(`[memory] tidied exercise names: ${x.applied} alias(es) across ${x.aligned} movement(s).`);
      } catch (e: any) {
        recordSchedulerFailure("exercise_reconciliation", e);
        console.error(`[memory] nightly exercise tidy failed: ${e?.message ?? e}`);
      }
    } finally {
      memoryBusy = false;
    }
  };

  // ---- Self-hosted update check (pull-never-push). Once per day at most, gated
  //      on settings.update_check_enabled. Reaches the GitHub Releases API and
  //      STORES the result in app_state; nothing notifies — the Settings → Data
  //      card reads it. Stamp-first so a persistent-offline box checks at most
  //      once/day instead of hammering every minute; a transient failure just
  //      waits for tomorrow (the manual "Check now" button covers an immediate
  //      retry, and getUpdateStatus still serves the last good cache). ----
  let updateCheckBusy = false;
  const updateCheckTick = async () => {
    if (updateCheckBusy) return;
    if (!repo.getSettings().update_check_enabled) return;
    const today = localToday();
    if (repo.getAppState("update_check_last_date") === today) return; // already checked today
    updateCheckBusy = true;
    repo.setAppState("update_check_last_date", today); // stamp first → at most one check/day
    try {
      const r = await checkForUpdate();
      if (r.error) console.log(`[update] check unavailable (calm no-op): ${r.error}`);
      else if (r.update_available)
        console.log(`[update] a newer Cairn is available: ${r.latest} (running ${r.current}) — see Settings → Data.`);
      else console.log(`[update] up to date (${r.current}).`);
    } catch (e: any) {
      recordSchedulerFailure("update_check", e);
      console.error(`[update] check error: ${e?.message ?? e}`);
    } finally {
      updateCheckBusy = false;
    }
  };

  const s = repo.getSettings(); // also lazily creates the row (seeding env defaults)
  console.log(
    s.coach_enabled
      ? `Auto-coach enabled: day=${s.coach_day}, hour=${s.coach_hour}, strategy=${s.agent_strategy}.`
      : "Auto-coach disabled (enable it in Settings)."
  );
  console.log(
    s.proactive_enabled
      ? "Quiet proactivity enabled (insights wait in-app; never pushed)."
      : "Quiet proactivity disabled (enable it in Settings)."
  );
  setInterval(tick, 60_000); // check every minute
  setInterval(boundaryApplyTick, 60_000);
  setInterval(revisionTick, 60_000);
  setInterval(proactiveTick, 60_000);
  setInterval(garminTick, 60_000);
  setInterval(precomputeTick, 60_000);
  setInterval(memoryTick, 60_000); // Stream 2: nightly memory maintenance
  setInterval(updateCheckTick, 60_000); // self-hosted update check (≤ once/day)
  setInterval(heartbeatTick, 60_000); // readiness evidence; no agent/provider dependency
  setTimeout(garminTick, 45_000); // the boot-time pass; later passes ride the minute tick
  setTimeout(updateCheckTick, 30_000); // first update check shortly after boot (then daily)
  setTimeout(boundaryApplyTick, 5_000);
  setTimeout(revisionTick, 15_000);

  // Boot warm: if today's read isn't cached yet (e.g. a mid-day restart), compute
  // it in the background so the very next open is instant too. Safe no-op when an
  // agent is unreachable — it caches the deterministic floor.
  setTimeout(() => {
    const today = warmToday();
    if (!repo.getCachedDayRead(today)) {
      precomputeDayRead(today)
        .then(() => console.log(`[brief] warmed today's day-read for ${today}.`))
        .catch((error) => recordSchedulerFailure("day_read_boot_warm", error));
    }
  }, 15_000);
}
