import type { BrainEvaluation } from "../../brain/evaluation-contract.js";
import type { BrainMetricKey } from "../../brain/expectation-contract.js";
import {
  getBrainDecision,
  getBrainExpectation,
  getBrainRollback,
  patchBrainDecision,
} from "../../repo/brain-decisions.js";
import {
  type AttentionDomain,
  type AttentionScheduleEntry,
  EXPECTATION_FOLLOWUP_SOURCE,
  getAttentionSchedule,
  listAttentionBySource,
  upsertAttentionSchedule,
} from "../../repo/attention.js";
import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import { createProposal, setProposalStatus } from "../../repo/profile.js";
import { getPlan } from "../../repo/plan.js";
import { addDaysISO, clipText, localDateISO } from "../../repo/shared.js";
import { applyProposalWithAutonomy } from "./autonomy-service.js";

// A change that demonstrably missed its prediction used to stay applied forever
// with nobody told. This turns that one fact into ONE quiet in-app note, filed on
// the attention schedule the rest of the app already reads.
//
// Deliberately narrow:
//   • Nothing is reverted. Autonomy is server policy, and a missed prediction is
//     information, not a mandate — the athlete drives.
//   • Nothing is pushed. The note waits in-app exactly like every other insight.
//   • One note per CHANGE, not per prediction. A decision whose several
//     expectations all miss is still one story, and the signal key is the dedupe:
//     once written (even after it goes quiet) that decision never speaks again.
//   • It goes quiet on its own. Standing follow-ups are released after
//     FOLLOWUP_STANDING_DAYS, or the moment the change behind them is no longer
//     the one in force, so a note can never become a permanent resident.

// How long one note is allowed to stand before it goes quiet by itself.
const FOLLOWUP_STANDING_DAYS = 21;

// The metrics that describe the EFFECT of a change the coach made. day_read_adherence
// is deliberately absent: it is the daily heartbeat of whether a morning read was
// followed, and a diverged day is the athlete's call, never a failed change.
const CHANGE_EFFECT_METRICS = new Set<BrainMetricKey>([
  "weight_trend_lb_wk",
  "intake_to_weight_response",
  "exercise_target_completion",
  "exercise_est_1rm_trend",
  "session_performance_feedback",
  "joint_pain_or_soreness",
  "plan_day_adherence",
  "run_volume_adherence",
  "vo2max_trend",
]);

const FOLLOWUP_DOMAINS = new Set(["training", "recovery", "nutrition"]);

const RUNNING_METRICS = new Set<BrainMetricKey>(["run_volume_adherence", "vo2max_trend"]);

// One phrasing per rule printed verbatim for weeks is what makes an app feel
// robotic, so this is a variant set rotated by date + decision, never a literal.
// Every line is a suggestion in the athlete's own register: no score, no verdict,
// no "you must".
const MISS_VARIANTS = [
  "that change hasn't done what we hoped — worth a look when you have a minute",
  "that adjustment hasn't landed the way we expected; worth revisiting together",
  "what we changed hasn't shown up the way we thought it would — it might be worth another look",
  "that one hasn't played out the way we expected. No rush, but it's worth a second look",
  "we expected more from that change than what's turned up so far — worth talking through",
] as const;

// An AEROBIC miss gets its own complete sentences rather than the `${summary} — …`
// composition. The decision's summary describes what the team changed, and that is
// usually strength work ("A 6-week strength block is running"); pinning a missed
// aerobic expectation to it tells the athlete something untrue, because the block was
// never the promise about their aerobic base. Same calm register, same rules: no
// score, no verdict, no "you must".
const AEROBIC_MISS_VARIANTS = [
  "the aerobic base under this block hasn't come along the way we hoped — worth a look when you have a minute",
  "the running base underneath this training hasn't moved the way we expected; worth revisiting together",
  "the aerobic side of this stretch hasn't turned up the way we thought it would — it might be worth another look",
  "we expected more from the endurance base under the current work than what's turned up so far — worth talking through",
] as const;

const RELEASE_CONDITION =
  "It goes quiet on its own once it has had its say, or as soon as the change behind it is no longer the one in force.";

// The note is composed as `${subject} — ${variant}.`, so a summary that already ends
// in a period would print "…is running. — that change hasn't…". Decision summaries are
// written as complete sentences; the composed line supplies its own terminal period.
// Stripped BEFORE the clip, so a summary long enough to be clipped still keeps the
// ellipsis clipText added rather than having it read as the sentence's own period.
function noteSubject(summary: string): string {
  return clipText(
    String(summary ?? "")
      .trim()
      .replace(/\s*\.+$/, ""),
    90,
    { ellipsis: "..." }
  );
}

function attentionDomain(domain: string, metricKey: BrainMetricKey): AttentionDomain {
  if (RUNNING_METRICS.has(metricKey)) return "running";
  if (domain === "nutrition") return "nutrition";
  if (domain === "recovery") return "recovery";
  return "training";
}

function followupSignalKey(domain: AttentionDomain, decisionId: number): string {
  return `${domain}:change-check:d${decisionId}`;
}

/**
 * Turn this run's `not_aligned` verdicts into calm in-app notes. Returns the
 * entries actually written — an already-noted change, a still-aligned one, and a
 * health/lab metric all return nothing.
 */
export function surfaceExpectationMisses(
  evaluations: readonly BrainEvaluation[],
  asOf = localDateISO()
): AttentionScheduleEntry[] {
  const written: AttentionScheduleEntry[] = [];
  const handled = new Set<string>();
  for (const evaluation of evaluations) {
    if (evaluation.verdict !== "not_aligned") continue;
    try {
      const expectation = getBrainExpectation(Number(evaluation.expectation_id));
      if (!expectation || !CHANGE_EFFECT_METRICS.has(expectation.metric_key)) continue;
      const decision = getBrainDecision(expectation.decision_id);
      if (!decision?.id || !FOLLOWUP_DOMAINS.has(decision.domain)) continue;
      // Only a change that actually LANDED can have missed. A held or advisory
      // record has nothing in force to look at.
      if (decision.status !== "applied" && decision.status !== "announced") continue;
      const domain = attentionDomain(decision.domain, expectation.metric_key);
      const signalKey = followupSignalKey(domain, decision.id);
      // The dedupe that makes this nag exactly once: an existing row — active or
      // long since released — means this change has already had its note.
      if (handled.has(signalKey) || getAttentionSchedule(signalKey)) continue;
      handled.add(signalKey);
      // An aerobic expectation is never about the change's own words — see
      // AEROBIC_MISS_VARIANTS. Everything else keeps the decision's summary, which is
      // the honest subject of its own miss.
      const aerobic = RUNNING_METRICS.has(expectation.metric_key);
      const variant = pickDayVariant(
        aerobic ? AEROBIC_MISS_VARIANTS : MISS_VARIANTS,
        asOf,
        `change-check:${decision.id}`
      );
      const summary = aerobic ? "" : noteSubject(decision.summary);
      written.push(
        upsertAttentionSchedule({
          signal_key: signalKey,
          domain,
          tier: "active",
          // Due at the END of its standing window, not the day it is written. The one
          // athlete-facing reader (team-week's `watching`) shows an entry whose
          // `next_due` falls between today and three weeks out, so a due date of `asOf`
          // was readable for exactly one day — and the signal-key dedupe then silenced
          // that change forever. Dated forward, the note stands for the whole window and
          // expires exactly when releaseStaleExpectationFollowups retires it below.
          // The trade: a forward due date keeps it out of listDueAttention's due-NOW
          // coach feed for the same 21 days, which costs nothing — the conductor already
          // filters these follow-ups out of that feed, and the athlete is the audience.
          next_due: addDaysISO(asOf, FOLLOWUP_STANDING_DAYS) ?? asOf,
          last_checked: asOf,
          reason: summary ? `${summary} — ${variant}.` : `${variant.charAt(0).toUpperCase()}${variant.slice(1)}.`,
          release_condition: RELEASE_CONDITION,
          source: EXPECTATION_FOLLOWUP_SOURCE,
          state: {
            clean_checks: 0,
            confirming_checks: 0,
            surveillance_checks: 0,
            surveillance_interval_days: FOLLOWUP_STANDING_DAYS,
            last_event: "intervention_changed",
          },
        })
      );
    } catch {
      // One malformed historical row must never stop the nightly pass.
    }
  }
  return written;
}

/**
 * Retire standing follow-up notes. A note goes quiet after it has stood for
 * FOLLOWUP_STANDING_DAYS, and immediately if the change it is about has since
 * been undone or replaced — there is nothing left to look at either way. The row
 * itself is kept (released, so no surface reads it) because it is also the
 * dedupe record that stops the same change speaking twice.
 */
export function releaseStaleExpectationFollowups(asOf = localDateISO()): number {
  const cutoff = addDaysISO(asOf, -FOLLOWUP_STANDING_DAYS) ?? asOf;
  let released = 0;
  for (const entry of listAttentionBySource(EXPECTATION_FOLLOWUP_SOURCE, { limit: 200 })) {
    try {
      const decisionId = Number(entry.signal_key.split(":d").pop());
      const decision = Number.isInteger(decisionId) && decisionId > 0 ? getBrainDecision(decisionId) : null;
      const changeGone = !decision || (decision.status !== "applied" && decision.status !== "announced");
      if (!changeGone && entry.last_checked > cutoff) continue;
      upsertAttentionSchedule({ ...entry, tier: "released", next_due: null });
      released++;
    } catch {
      // Retirement is bookkeeping; it must never sink the pass.
    }
  }
  return released;
}

// ---------------------------------------------------------------------------
// The actuation arm: a change that demonstrably failed its own prediction
// queues a real step-back through the system's own propose -> apply machinery.
//
// The note above is the VISIBILITY arm and stays exactly as it is. This is the
// second half: for the narrow class of misses that say "the change itself made
// the work worse", the coach does not merely mention it — it drafts the reverse
// change and hands it to the autonomy layer.
//
// Every constitutional line is deliberate here:
//   • Deterministic. No agent is called. This is server-policy actuation, so
//     there is no model discretion to launder — the reverse of a change the
//     ledger already recorded is arithmetic, not judgement.
//   • It NEVER applies itself. The draft goes through applyProposalWithAutonomy
//     exactly like every other change, so decideAutonomyTier owns the posture and
//     lead_mode still governs. There is no bypass, and a step-back gets no
//     special standing: it consumes the same surprise budget and passes the same
//     freshness gate as anything else. If policy says review, it waits.
//   • It never guesses. The prior prescription comes from the decision's OWN
//     before-snapshot (brain_rollbacks), field-scoped exactly the way Undo's
//     three-way restore is. A target the athlete has since moved is left alone —
//     reality moved on, and overwriting it would be the coach talking over them.
//   • One attempt per failed change, EVER, recorded on that change either way,
//     so a skip is as readable in the decision trail as a queued revision.
//   • A step-back that itself misses spawns nothing. The note surfaces and a
//     human takes it from there; a machine arguing with itself is not coaching.

// Only the change-EFFECT guards qualify. A miss here says the work got worse
// under the change, which is the one thing a step-back actually answers.
// Deliberately excluded: every adherence/completion metric (and day_read_adherence
// above all), where a miss says the athlete did something different — behaviour
// is theirs, and walking their plan back because they trained differently would
// be a punishment, not coaching.
const REVISABLE_METRICS = new Set<BrainMetricKey>([
  "session_performance_feedback",
  "joint_pain_or_soreness",
  "exercise_est_1rm_trend",
]);

// The prescription fields a bounded target change can move, and the only ones a
// step-back restores. Structural fields (kind, mode, superset_group) are not
// bounded target edits and are never reconstructed here.
const STEP_BACK_FIELDS = ["target_weight", "target_seconds", "sets", "rep_low", "rep_high"] as const;
type StepBackField = (typeof STEP_BACK_FIELDS)[number];

// The proposal agent a step-back is filed under. applyProposal copies it onto the
// decision's `source`, which is what makes a step-back self-identifying even when
// no context stamp survived.
const REVISION_STEP_BACK_AGENT = "revision-step-back";

// Athlete-facing, one variant set rather than one literal — same rule the day read
// lives by. Calm register: no score, no verdict, no "you must", and none of the
// engineering vocabulary the reading grammar rejects.
const STEP_BACK_VARIANTS = [
  "putting {what} back where it was — that last step up hasn't sat well",
  "easing {what} back to the earlier prescription while that last step settles",
  // Every line reads {what} as a NOUN PHRASE only — never as a subject the verb has
  // to agree with — because describeTargets legitimately returns "3 lifts".
  "stepping {what} back to where it was; the change hasn't shown up in how the work feels",
  "walking {what} back one step, so we build again from ground that held",
  "returning {what} to the earlier prescription — that step hasn't earned its place yet",
] as const;

interface StepBackChange {
  day_number: number;
  exercise: string;
  reason: string;
  target_weight?: number;
  target_seconds?: number;
  sets?: number;
  rep_low?: number;
  rep_high?: number;
}

export interface RevisionOutcome {
  decision_id: number;
  expectation_id: number;
  metric_key: BrainMetricKey;
  /** The evaluation date this attempt was made on. */
  at: string;
  status: "queued" | "skipped";
  /** Machine register, recorded on the failed decision so a skip is inspectable. */
  reason?: string;
  proposal_id?: number;
  revision_decision_id?: number | null;
  tier?: string | null;
}

function asNullable(value: unknown): unknown {
  return value === undefined ? null : value;
}

// Numeric-aware equality: a prescription round-trips through SQLite and JSON, so
// 115 and 115.0 are the same target and must not read as "the athlete moved it".
function sameTargetValue(a: unknown, b: unknown): boolean {
  const left = asNullable(a);
  const right = asNullable(b);
  if (left === null || right === null) return left === right;
  const ln = Number(left);
  const rn = Number(right);
  if (Number.isFinite(ln) && Number.isFinite(rn)) return ln === rn;
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameExercise(a: unknown, b: unknown): boolean {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

function findSnapshotItem(snapshot: unknown, dayNumber: number, exercise: string): any | null {
  if (!Array.isArray(snapshot)) return null;
  const day = snapshot.find((entry: any) => Number(entry?.day_number) === Number(dayNumber));
  const items = Array.isArray(day?.items) ? day.items : [];
  return items.find((item: any) => sameExercise(item?.exercise, exercise)) ?? null;
}

function currentPlanSnapshot(): any[] {
  try {
    return getPlan() as any[];
  } catch {
    return [];
  }
}

/**
 * Rebuild the prescription this decision replaced, for exactly the targets it
 * touched. Returns the changes to make, or the machine reason nothing can be
 * rebuilt — never a guess.
 */
function reconstructStepBack(decision: any, asOf: string): { changes: StepBackChange[] } | { reason: string } {
  const action = (decision?.action ?? {}) as any;
  // A restructure or a rotation is not a bounded target step. Reversing either
  // means reasoning about a plan shape rather than a number, and a wrong guess
  // there rewrites the athlete's week.
  if (Array.isArray(action.days) && action.days.length) return { reason: "the change was a plan restructure, not a bounded target step" };
  if (Array.isArray(action.swaps) && action.swaps.length) return { reason: "the change rotated a movement, which has no one-step-back target" };

  const rollback = getBrainRollback(Number(decision.id));
  if (!rollback || rollback.kind !== "training_plan") return { reason: "no training before-snapshot was stored for this change" };
  const payload = rollback.payload as any;
  if (payload?.version !== 2 || !Array.isArray(payload.before) || !Array.isArray(payload.after)) {
    return { reason: "the stored before-snapshot predates the three-way format and cannot be field-scoped" };
  }

  const touched = (Array.isArray(action.changes) ? action.changes : []).filter(
    (entry: any) => Number.isFinite(Number(entry?.day_number)) && String(entry?.exercise ?? "").trim()
  );
  if (!touched.length) return { reason: "the change recorded no affected prescriptions" };

  const current = currentPlanSnapshot();
  const changes: StepBackChange[] = [];
  const stale: string[] = [];
  for (const entry of touched) {
    const dayNumber = Number(entry.day_number);
    const exercise = String(entry.exercise).trim();
    const before = findSnapshotItem(payload.before, dayNumber, exercise);
    const after = findSnapshotItem(payload.after, dayNumber, exercise);
    const now = findSnapshotItem(current, dayNumber, exercise);
    // Gone from the plan entirely — re-adding a movement the athlete removed is a
    // structural decision, not a step back.
    if (!before || !after || !now) {
      stale.push(`${exercise} (day ${dayNumber}) is no longer the prescription this change altered`);
      continue;
    }
    const restore: Partial<Record<StepBackField, number>> = {};
    let blocked: string | null = null;
    for (const field of STEP_BACK_FIELDS) {
      // The decision did not move this field, so there is nothing to put back.
      if (sameTargetValue(before[field], after[field])) continue;
      // Reality moved on: a manual edit or a newer change owns this target now.
      // The same compare-and-set Undo uses, so the two can never disagree.
      if (!sameTargetValue(now[field], after[field])) {
        blocked = `${exercise} (day ${dayNumber}) has moved since the change; the athlete's own edit stands`;
        break;
      }
      const prior = asNullable(before[field]);
      // A prior value of null is a real prescription (bodyweight, or untimed) but
      // it cannot be expressed through the plan-change contract, where null means
      // "leave alone". Restoring it would silently no-op, so it is skipped, not faked.
      if (prior === null) {
        blocked = `${exercise} (day ${dayNumber}) previously carried no ${field}, which a change cannot restore`;
        break;
      }
      const value = Number(prior);
      if (!Number.isFinite(value)) {
        blocked = `${exercise} (day ${dayNumber}) has an unreadable earlier ${field}`;
        break;
      }
      restore[field] = value;
    }
    if (blocked) {
      stale.push(blocked);
      continue;
    }
    const fields = Object.keys(restore) as StepBackField[];
    if (!fields.length) continue;
    changes.push({
      day_number: dayNumber,
      exercise,
      reason: `Back to the prescription in force before ${decision.effective_date ?? asOf}, which this change replaced.`,
      ...restore,
    });
  }

  if (!changes.length) {
    return { reason: stale.length ? stale.join("; ") : "nothing this change moved is still restorable" };
  }
  return { changes };
}

function describeTargets(changes: readonly StepBackChange[]): string {
  const names = [...new Set(changes.map((change) => change.exercise))];
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} lifts`;
}

/** Record the attempt on the failed change itself, so the trail explains every outcome. */
function markRevisionAttempt(decision: any, outcome: RevisionOutcome): void {
  try {
    patchBrainDecision(Number(decision.id), {
      context: {
        ...((decision.context as Record<string, unknown>) ?? {}),
        revision: {
          status: outcome.status,
          reason: outcome.reason ?? null,
          proposal_id: outcome.proposal_id ?? null,
          decision_id: outcome.revision_decision_id ?? null,
          tier: outcome.tier ?? null,
          metric_key: outcome.metric_key,
          expectation_id: outcome.expectation_id,
          at: outcome.at,
        },
      },
    });
  } catch {
    // The marker is the dedupe AND the trail, but a failed patch must never sink
    // the nightly pass; the worst case is one retried attempt tomorrow.
  }
}

/**
 * Turn this run's `not_aligned` verdicts on change-effect guards into DRAFT
 * step-back proposals routed through the autonomy layer. Returns one outcome per
 * failed change considered — queued or skipped with its reason. An already-
 * considered change, a behavioural miss, a health/lab metric and a step-back's own
 * failure all return nothing.
 */
export function queueExpectationRevisions(
  evaluations: readonly BrainEvaluation[],
  asOf = localDateISO()
): RevisionOutcome[] {
  const outcomes: RevisionOutcome[] = [];
  const handled = new Set<number>();
  for (const evaluation of evaluations) {
    if (evaluation.verdict !== "not_aligned") continue;
    try {
      const expectation = getBrainExpectation(Number(evaluation.expectation_id));
      if (!expectation || !REVISABLE_METRICS.has(expectation.metric_key)) continue;
      const decision = getBrainDecision(expectation.decision_id);
      if (!decision?.id || decision.domain !== "training") continue;
      // Only a change actually IN FORCE can be stepped back. An announced or held
      // change has not landed, so there is nothing in the plan to walk back.
      if (decision.status !== "applied") continue;
      if (handled.has(decision.id)) continue;
      handled.add(decision.id);

      const context = (decision.context ?? {}) as Record<string, any>;
      // One attempt per failed change, ever — queued or skipped. A skip reason that
      // was true last night ("the athlete has moved this target") only gets truer.
      if (context.revision) continue;

      const base = {
        decision_id: decision.id,
        expectation_id: Number(expectation.id),
        metric_key: expectation.metric_key,
        at: asOf,
      };

      // A step-back that misses its own prediction surfaces the note and stops.
      // Revising a revision is a machine arguing with itself; a human decides next.
      //
      // Two belts, because the provenance stamp is not guaranteed. The context key
      // rides in on the autonomy path (patched below) and now on every apply path
      // (the proposal payload carries it). `source` is the belt that needs no
      // stamping at all: applyProposal copies the proposal's agent onto the decision
      // on EVERY path, so a step-back held for review and applied by hand days later
      // is still recognisable as one.
      if (context.revises_decision_id != null || decision.source === REVISION_STEP_BACK_AGENT) {
        const outcome: RevisionOutcome = { ...base, status: "skipped", reason: "this change was itself a step back; a human takes it from here" };
        markRevisionAttempt(decision, outcome);
        outcomes.push(outcome);
        continue;
      }

      const rebuilt = reconstructStepBack(decision, asOf);
      if ("reason" in rebuilt) {
        const outcome: RevisionOutcome = { ...base, status: "skipped", reason: rebuilt.reason };
        markRevisionAttempt(decision, outcome);
        outcomes.push(outcome);
        continue;
      }

      const what = describeTargets(rebuilt.changes);
      const variant = pickDayVariant(STEP_BACK_VARIANTS, asOf, `step-back:${decision.id}`);
      const spoken = variant.replace("{what}", what);
      const proposal = createProposal(
        REVISION_STEP_BACK_AGENT,
        `step back after ${expectation.metric_key} missed on change ${decision.id}`,
        "",
        {
          summary: clipText(`${spoken.charAt(0).toUpperCase()}${spoken.slice(1)}.`, 280, { ellipsis: "..." }),
          // Provenance travels WITH the draft, so it reaches the decision no matter
          // which path applies it — the autonomy layer below, or the athlete tapping
          // apply on a proposal that was held for review.
          revises_decision_id: decision.id,
          revises_expectation_id: Number(expectation.id),
          // Machine register — it names the failed prediction precisely, which the
          // athlete-facing summary above deliberately never does.
          rationale:
            `Server-policy step back. Change #${decision.id} ("${clipText(decision.summary, 120, { ellipsis: "..." })}") ` +
            `missed its ${expectation.metric_key} expectation #${expectation.id} (evaluated ${asOf}). ` +
            `Restoring the prescription recorded in that change's own before-snapshot for ${rebuilt.changes.length} target(s).`,
          changes: rebuilt.changes,
        }
      );

      // THE constitutional line: the same entry every other change uses. A bounded,
      // reversible target restore is eligible for quiet_apply, but decideAutonomyTier
      // owns that call — requested_tier only ever clamps tighter, never looser.
      const autonomy = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "quiet_apply" });
      if (!autonomy || autonomy.ok === false) {
        // Nothing landed and nothing is waiting — do not leave a dangling draft.
        try {
          setProposalStatus(Number(proposal.id), "discarded");
        } catch {}
        const outcome: RevisionOutcome = {
          ...base,
          status: "skipped",
          reason: `the step back could not be routed: ${String(autonomy?.error ?? "unknown")}`,
        };
        markRevisionAttempt(decision, outcome);
        outcomes.push(outcome);
        continue;
      }

      // Chain the provenance both ways, so Undo and the decision trail can walk
      // from the failed change to its revision and back.
      const revisionDecision = (autonomy as any).decision ?? null;
      if (revisionDecision?.id) {
        try {
          patchBrainDecision(Number(revisionDecision.id), {
            context: {
              ...((revisionDecision.context as Record<string, unknown>) ?? {}),
              revises_decision_id: decision.id,
              revises_expectation_id: Number(expectation.id),
              revision_step_back: true,
            },
          });
        } catch {
          // Provenance is bookkeeping; the change itself is already accountable.
        }
      }

      const outcome: RevisionOutcome = {
        ...base,
        status: "queued",
        proposal_id: Number(proposal.id),
        revision_decision_id: revisionDecision?.id ?? null,
        tier: (autonomy as any).tier ?? null,
      };
      markRevisionAttempt(decision, outcome);
      outcomes.push(outcome);
    } catch {
      // One malformed historical row must never stop the nightly pass.
    }
  }
  return outcomes;
}
