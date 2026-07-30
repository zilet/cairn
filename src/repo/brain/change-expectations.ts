import { db } from "../../db.js";
import {
  type ProposedExpectation,
  normalizeProposedExpectation,
} from "../../brain/expectation-contract.js";
import { addDaysISO } from "../shared.js";

// The "did this change actually help?" writers.
//
// A training change that is APPLIED gets a small set of falsifiable predictions
// attached to its ledger decision, so the nightly maturity pass can later answer
// whether the athlete's own experience of training moved the way the change
// promised. Every writer here obeys ONE rule: a prediction is written only when
// the evidence that could falsify it is ALREADY being produced. A signal the
// athlete does not log (session ratings, joint-pain notes, a loaded lift with
// real weight × reps) yields no expectation at all — an expectation that can
// never mature is ledger rot, and absence of a signal is neutral, never a miss.
//
// Everything below is deliberately BASELINE-RELATIVE rather than absolute. The
// question is "did this change make things worse than they already were", not
// "is the athlete good enough" — there are no scores here, and a picture that
// was already sore or already flat is not held against the athlete.

const LOOKBACK_DAYS = 28;

function rounded(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export interface SessionFeedbackBaseline {
  /** Sessions in the lookback carrying a 1-5 `performance` rating. */
  rated_sessions: number;
  /** Mean of those ratings, or null when nothing was rated. */
  average_rating: number | null;
  /** Sessions carrying ANY autoregulation feedback (soreness or a joint-pain note). */
  feedback_sessions: number;
  /** Sessions whose joint-pain note was non-empty — the level pain is already at. */
  pain_sessions: number;
}

/**
 * What the athlete's own feedback looked like BEFORE a change lands. Read over
 * the trailing window that ends the day before `asOf`, so the decision day
 * itself (which may already carry the new work) never leaks into its own
 * baseline.
 */
export function sessionFeedbackBaseline(asOf: string, lookbackDays = LOOKBACK_DAYS): SessionFeedbackBaseline {
  const end = addDaysISO(asOf, -1) ?? asOf;
  const start = addDaysISO(asOf, -Math.max(1, Math.trunc(lookbackDays))) ?? asOf;
  const rows = db
    .prepare(
      `SELECT performance, soreness, joint_pain FROM sessions
       WHERE date BETWEEN ? AND ? ORDER BY date, id LIMIT 500`
    )
    .all(start, end) as Array<{ performance: number | null; soreness: number | null; joint_pain: string | null }>;
  const ratings = rows
    .map((row) => Number(row.performance))
    .filter((value) => Number.isFinite(value) && value > 0);
  // `Number(null)` is 0 and 0 is finite, so the null check is load-bearing: without
  // it every unrated session would read as logged feedback and an athlete who never
  // fills these in would collect predictions that can only come back inconclusive.
  const feedbackSessions = rows.filter(
    (row) =>
      (row.soreness != null && Number.isFinite(Number(row.soreness))) || !!String(row.joint_pain ?? "").trim()
  ).length;
  const painSessions = rows.filter((row) => !!String(row.joint_pain ?? "").trim()).length;
  return {
    rated_sessions: ratings.length,
    average_rating: ratings.length ? rounded(ratings.reduce((sum, value) => sum + value, 0) / ratings.length) : null,
    feedback_sessions: feedbackSessions,
    pain_sessions: painSessions,
  };
}

/**
 * The two "how did this land on the person" predictions for an applied training
 * change, over a 14-day window:
 *
 *   • session_performance_feedback — how sessions RATE should not slide below
 *     where it already sat (half a point of tolerance, because a 1-5 rating is
 *     coarse and a single flat day is not a trend).
 *   • joint_pain_or_soreness — joint-pain notes should appear no more often
 *     than they already did.
 *
 * Both are written only when the athlete is ALREADY logging the signal, so a
 * quiet logger neither collects vacuous "aligned" rows nor gets a prediction
 * that can only ever come back inconclusive.
 */
export function buildTrainingFeedbackExpectations(
  asOf: string,
  baseline = sessionFeedbackBaseline(asOf)
): ProposedExpectation[] {
  const windowEnd = addDaysISO(asOf, 14) ?? asOf;
  const out: ProposedExpectation[] = [];
  if (baseline.rated_sessions >= 2 && baseline.average_rating != null) {
    out.push({
      metric_key: "session_performance_feedback",
      subject_key: null,
      direction: "at_least",
      baseline: {
        average_rating: baseline.average_rating,
        rated_sessions: baseline.rated_sessions,
        lookback_days: LOOKBACK_DAYS,
      },
      // Half a point of slack under the trailing average: the prediction is
      // "not materially worse than before", never "keep scoring highly".
      target: { value: rounded(Math.max(1, baseline.average_rating - 0.5)) },
      window_start: asOf,
      window_end: windowEnd,
      minimum_data: { sessions: 2 },
      confounder_policy: "exclude_context_events",
      confidence: "tentative",
      evaluator: "session_feedback",
      evaluator_version: "session-feedback-guard-v1",
    });
  }
  if (baseline.feedback_sessions >= 2) {
    out.push({
      metric_key: "joint_pain_or_soreness",
      subject_key: null,
      direction: "avoid",
      baseline: {
        pain_sessions: baseline.pain_sessions,
        feedback_sessions: baseline.feedback_sessions,
        lookback_days: LOOKBACK_DAYS,
      },
      // Pain that was ALREADY being reported is not this change's fault. The
      // falsifiable claim is that it does not become more frequent.
      target: { max: baseline.pain_sessions },
      window_start: asOf,
      window_end: windowEnd,
      minimum_data: { feedback_entries: 2 },
      confounder_policy: "exclude_context_events",
      confidence: "tentative",
      evaluator: "symptom_load",
      evaluator_version: "symptom-load-guard-v1",
    });
  }
  return out;
}

/**
 * Best Epley est-1RM for one lift over the trailing window, or null when the
 * lift has no LOADED history to estimate from.
 *
 * Weight encoding is honored exactly: a negative weight is assisted work and a
 * null weight is bodyweight, and neither can carry a one-rep-max estimate, so
 * both are skipped rather than read as load. A timed movement has no reps at
 * all and is rejected outright by the caller.
 */
export function recentEst1rm(exerciseId: number, asOf: string, lookbackDays = LOOKBACK_DAYS): number | null {
  const end = addDaysISO(asOf, -1) ?? asOf;
  const start = addDaysISO(asOf, -Math.max(1, Math.trunc(lookbackDays))) ?? asOf;
  const rows = db
    .prepare(
      `SELECT ls.weight, ls.reps FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
       WHERE ls.exercise_id = ? AND s.date BETWEEN ? AND ? LIMIT 1000`
    )
    .all(exerciseId, start, end) as Array<{ weight: number | null; reps: number | null }>;
  let best = 0;
  for (const row of rows) {
    const weight = Number(row.weight);
    const reps = Number(row.reps);
    if (!Number.isFinite(weight) || !Number.isFinite(reps) || weight <= 0 || reps <= 0) continue;
    best = Math.max(best, weight * (1 + reps / 30));
  }
  return best > 0 ? rounded(best, 1) : null;
}

export interface LiftProgressionSubject {
  exercise: string;
  exercise_id: number;
  baseline_est_1rm: number;
}

/**
 * Which of the applied lifts can carry an est-1RM prediction at all: a known,
 * non-timed movement with enough loaded history behind it to have a baseline.
 * Anything else is filtered out silently — this is a data-presence gate, not a
 * judgement about the lift.
 */
export function liftProgressionSubjects(exercises: string[], asOf: string, limit = 3): LiftProgressionSubject[] {
  const out: LiftProgressionSubject[] = [];
  const seen = new Set<string>();
  for (const name of exercises) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const row = db.prepare(`SELECT id, name, mode FROM exercises WHERE name = ? COLLATE NOCASE`).get(name) as
      | { id: number; name: string; mode: string | null }
      | undefined;
    if (!row || String(row.mode ?? "reps") === "timed") continue;
    const baseline = recentEst1rm(Number(row.id), asOf);
    if (baseline == null) continue;
    out.push({ exercise: String(row.name), exercise_id: Number(row.id), baseline_est_1rm: baseline });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * "This load step should hold" — over 21 days (long enough for est-1RM to
 * actually move on a lift trained once or twice a week), the best estimate
 * should not fall meaningfully below where it stood when the step was made.
 * A 3% floor absorbs ordinary day-to-day variation; a real regression below it
 * is the signal that the progression outran the athlete.
 */
export function buildLiftProgressionExpectations(
  subjects: LiftProgressionSubject[],
  asOf: string
): ProposedExpectation[] {
  const windowEnd = addDaysISO(asOf, 21) ?? asOf;
  return subjects.map((subject) => ({
    metric_key: "exercise_est_1rm_trend",
    subject_key: subject.exercise,
    direction: "at_least",
    baseline: { est_1rm: subject.baseline_est_1rm, lookback_days: LOOKBACK_DAYS },
    target: { value: rounded(subject.baseline_est_1rm * 0.97, 1) },
    window_start: asOf,
    window_end: windowEnd,
    minimum_data: { exposures: 3 },
    confounder_policy: "require_exposure",
    confidence: "tentative",
    evaluator: "exercise_est_1rm",
    evaluator_version: "lift-progression-hold-v1",
  }));
}

export interface HrvBaseline {
  nights: number;
  average_ms: number | null;
}

/**
 * The athlete's own overnight HRV level before a change. Merged the same way the
 * evaluator merges it — a source-agnostic `daily_metrics` row per date, with any
 * non-null Garmin value winning — so the baseline and the outcome are read off
 * the same picture.
 *
 * A wearable is OPTIONAL in this app. No nights means no baseline, which means
 * no expectation: absence of a watch must be neutral, never a miss.
 */
export function hrvBaseline(asOf: string, lookbackDays = LOOKBACK_DAYS): HrvBaseline {
  const end = addDaysISO(asOf, -1) ?? asOf;
  const start = addDaysISO(asOf, -Math.max(1, Math.trunc(lookbackDays))) ?? asOf;
  const byDate = new Map<string, number>();
  for (const table of ["daily_metrics", "garmin_daily_metrics"]) {
    const rows = db
      .prepare(
        `SELECT date, hrv_ms FROM ${table} WHERE date BETWEEN ? AND ? AND hrv_ms IS NOT NULL ORDER BY date LIMIT 500`
      )
      .all(start, end) as Array<{ date: string; hrv_ms: number }>;
    for (const row of rows) {
      const value = Number(row.hrv_ms);
      if (Number.isFinite(value) && value > 0) byDate.set(String(row.date), value);
    }
  }
  const values = [...byDate.values()];
  return {
    nights: values.length,
    average_ms: values.length ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length, 1) : null,
  };
}

/**
 * The HRV half of the endurance-load recovery guard, written beside the existing
 * resting-HR one when — and only when — the athlete's watch has actually been
 * producing overnight HRV. The claim is bounded and personal: stepping weekly
 * volume up should not cost more than a tenth of the athlete's own HRV level.
 */
export function buildHrvGuardExpectation(
  asOf: string,
  windowDays: number,
  context: { prior_weekly_km: number; new_weekly_km: number },
  baseline = hrvBaseline(asOf)
): ProposedExpectation | null {
  if (baseline.nights < 6 || baseline.average_ms == null) return null;
  const windowEnd = addDaysISO(asOf, Math.max(1, Math.trunc(windowDays)));
  if (!windowEnd) return null;
  return {
    metric_key: "recovery_hrv_delta",
    subject_key: null,
    direction: "at_least",
    baseline: {
      hrv_avg_ms: baseline.average_ms,
      nights: baseline.nights,
      prior_weekly_km: context.prior_weekly_km,
      new_weekly_km: context.new_weekly_km,
    },
    target: { value: rounded(-Math.max(2, baseline.average_ms * 0.1), 1) },
    window_start: asOf,
    window_end: windowEnd,
    minimum_data: { nights: 6 },
    confounder_policy: "exclude_context_events",
    confidence: "tentative",
    evaluator: "recovery_delta",
    evaluator_version: "run-recovery-hrv-guard-v1",
  };
}

export const MAX_DEFERRED_EXPECTATIONS = 6;

/**
 * A conference recommendation that was HELD carries its predictions in cold
 * storage on the held decision, because predicting the effect of a change that
 * did not happen is not a check — it is a fabricated verdict waiting to be
 * written. `rebaseDeferredExpectations` thaws them onto the decision that
 * finally applies the proposal, sliding each window forward so it starts on the
 * apply date and keeps its original length.
 */
export function rebaseDeferredExpectations(value: unknown, asOf: string): ProposedExpectation[] {
  if (!Array.isArray(value)) return [];
  const out: ProposedExpectation[] = [];
  for (const raw of value.slice(0, MAX_DEFERRED_EXPECTATIONS)) {
    const proposed = normalizeProposedExpectation(raw);
    if (!proposed) continue;
    const span = Math.max(
      1,
      Math.round(
        (Date.parse(`${proposed.window_end}T00:00:00Z`) - Date.parse(`${proposed.window_start}T00:00:00Z`)) / 864e5
      )
    );
    const windowEnd = addDaysISO(asOf, span);
    if (!windowEnd) continue;
    const rebased = normalizeProposedExpectation({ ...proposed, window_start: asOf, window_end: windowEnd });
    if (rebased) out.push(rebased);
  }
  return out;
}
