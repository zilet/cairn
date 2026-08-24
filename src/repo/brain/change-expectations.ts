import { db } from "../../db.js";
import {
  type ProposedExpectation,
  normalizeProposedExpectation,
} from "../../brain/expectation-contract.js";
import { addDaysISO } from "../shared.js";
import { verifiedStrengthAnchor } from "../calibration.js";

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
// How long the "did this change land badly on the person" predictions run for. Named
// because the joint-pain target has to be expressed in the SAME units as the window it
// is checked over — see painTargetForWindow below.
const FEEDBACK_WINDOW_DAYS = 14;

/**
 * The baseline pain-session COUNT, rescaled from the lookback to the evaluation
 * window. The counts are raw occurrences, not rates, so comparing a 28-day baseline
 * against a 14-day window handed the guard twice the room it was written to allow: an
 * athlete with four sore sessions a month could report four in a fortnight — a real
 * doubling — and still come back `aligned`.
 *
 * Rounding is deliberately generous (`Math.round`, so a single baseline occurrence
 * still permits one). That preserves the floor the guard exists for: pain that was
 * ALREADY being reported is not this change's fault, and a change must never be
 * convicted for the athlete's pre-existing picture.
 */
function painTargetForWindow(painSessions: number, windowDays = FEEDBACK_WINDOW_DAYS): number {
  const scaled = Math.max(0, painSessions) * (windowDays / LOOKBACK_DAYS);
  return Math.max(0, Math.round(scaled));
}

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
  const windowEnd = addDaysISO(asOf, FEEDBACK_WINDOW_DAYS) ?? asOf;
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
      // falsifiable claim is that it does not become more FREQUENT — which means the
      // baseline count has to be expressed over this window's length, not the
      // lookback's.
      target: { max: painTargetForWindow(baseline.pain_sessions) },
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
  /**
   * Where the baseline number came from. Optional so every existing construction
   * site stays valid; absent reads as "estimated", which is what it was.
   */
  baseline_basis?: "verified_top_set" | "estimated";
  /** The day a heavy set stood behind the baseline, when one did. */
  verified_on?: string | null;
}

/**
 * Which of the applied lifts can carry an est-1RM prediction at all: a known,
 * non-timed movement with enough loaded history behind it to have a baseline.
 * Anything else is filtered out silently — this is a data-presence gate, not a
 * judgement about the lift.
 *
 * The baseline PREFERS a fresh verified top set over the Epley best. The
 * prediction written below is "this load step should hold", and it is only worth
 * writing against a number the athlete has actually stood under: an Epley
 * estimate extrapolated from sets of five is a ceiling nobody has tested, and a
 * plan that progresses off it writes a hold expectation that can miss forever —
 * easing the step, teaching the ledger a false lesson about the lift, and
 * shrinking the program on evidence that was never real. When a heavy set has
 * confirmed the estimate recently, that is the number the claim is made against.
 * See verifiedStrengthAnchor for why this holds even when the verified number is
 * LOWER than the running estimate.
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
    const estimated = recentEst1rm(Number(row.id), asOf);
    // No loaded history at all means nothing to predict about, whatever the
    // calibration ladder remembers — the data-presence gate is unchanged.
    if (estimated == null) continue;
    const verified = attemptedAnchor(String(row.name), asOf);
    out.push({
      exercise: String(row.name),
      exercise_id: Number(row.id),
      baseline_est_1rm: verified ? rounded(verified.est_1rm, 1) : estimated,
      baseline_basis: verified ? "verified_top_set" : "estimated",
      verified_on: verified?.anchored_on ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// The calibration ladder is an enhancement to this writer, never a dependency of
// it: a DB without the ledger's tables, or an unreadable one, must still be able
// to write the estimated-baseline expectation it always wrote.
function attemptedAnchor(exerciseName: string, asOf: string): { est_1rm: number; anchored_on: string } | null {
  try {
    return verifiedStrengthAnchor(exerciseName, asOf);
  } catch {
    return null;
  }
}

/**
 * "This load step should hold" — over 21 days (long enough for est-1RM to
 * actually move on a lift trained once or twice a week), the best estimate
 * should not fall meaningfully below where it stood when the step was made.
 * A 3% floor absorbs ordinary day-to-day variation; a real regression below it
 * is the signal that the progression outran the athlete.
 *
 * `baseline.basis` and `baseline.verified_on` travel with the claim so the
 * evaluator can tell, months later, whether the number it is judging against was
 * ever confirmed by a heavy set — see exerciseEst1rmObservation.
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
    baseline: {
      est_1rm: subject.baseline_est_1rm,
      lookback_days: LOOKBACK_DAYS,
      basis: subject.baseline_basis ?? "estimated",
      verified_on: subject.verified_on ?? null,
    },
    target: { value: rounded(subject.baseline_est_1rm * 0.97, 1) },
    window_start: asOf,
    window_end: windowEnd,
    minimum_data: { exposures: 3 },
    confounder_policy: "require_exposure",
    confidence: "tentative",
    evaluator: "exercise_est_1rm",
    evaluator_version: "lift-progression-hold-v2",
  }));
}

export interface HrvBaseline {
  nights: number;
  average_ms: number | null;
}

/**
 * The athlete's own overnight HRV level before a change. Merged the same way the
 * evaluator merges its nights — a source-agnostic `daily_metrics` row per date, with
 * any non-null Garmin value winning — so the two read the same picture.
 *
 * Read ONLY to size the guard's tolerance (see buildHrvGuardExpectation). It is not a
 * comparison baseline: nothing downstream measures the window against this number.
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
 * producing overnight HRV.
 *
 * WHAT IS ACTUALLY CHECKED: the `recovery_delta` evaluator compares the FIRST half of
 * this window's nights against the SECOND half of the same window, and asks whether
 * that within-window drift stayed at or above `target.value`. It never reads the
 * 28-day baseline below — nothing here is measured against the athlete's prior level.
 * So the falsifiable claim is "stepping weekly volume up should not send HRV drifting
 * downward across the weeks that follow", not "HRV should stay near where it was".
 *
 * The baseline is used for ONE thing, and it is a heuristic: SIZING that tolerance. A
 * tenth of the athlete's own average is a personal way to say "a meaningful drop for
 * this person" rather than a fixed millisecond figure that means different things at
 * 40 ms and 120 ms — with an absolute 2 ms floor so a very low HRV cannot produce a
 * tolerance too tight to be real. Change the sizing here freely; changing what is
 * compared means changing the evaluator.
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

export interface SleepBaseline {
  nights: number;
  average_min: number | null;
}

/**
 * The athlete's own overnight SLEEP level before a change, merged exactly the way
 * hrvBaseline merges its nights (one row per date, a non-null Garmin value winning)
 * so the baseline and the evaluator read the same picture.
 *
 * A wearable is OPTIONAL here too: no nights means no baseline, which means no
 * expectation. A watchless athlete is never judged for silence.
 */
export function sleepBaseline(asOf: string, lookbackDays = LOOKBACK_DAYS): SleepBaseline {
  const end = addDaysISO(asOf, -1) ?? asOf;
  const start = addDaysISO(asOf, -Math.max(1, Math.trunc(lookbackDays))) ?? asOf;
  const byDate = new Map<string, number>();
  for (const table of ["daily_metrics", "garmin_daily_metrics"]) {
    const rows = db
      .prepare(
        `SELECT date, sleep_min FROM ${table} WHERE date BETWEEN ? AND ? AND sleep_min IS NOT NULL ORDER BY date LIMIT 500`
      )
      .all(start, end) as Array<{ date: string; sleep_min: number }>;
    for (const row of rows) {
      const value = Number(row.sleep_min);
      if (Number.isFinite(value) && value > 0) byDate.set(String(row.date), value);
    }
  }
  const values = [...byDate.values()];
  return {
    nights: values.length,
    average_min: values.length ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length, 1) : null,
  };
}

/**
 * The SLEEP half of the endurance-load recovery guard — the third reading of the same
 * question the resting-HR and HRV guards ask, and the one that closes the
 * `sleep_duration_delta` metric's loop. The evaluator for it has been registered since
 * the metric family was written and NO site ever created an expectation against it, so
 * a declared lever sat inert: the model could never learn what a volume raise costs
 * this athlete's sleep.
 *
 * WHAT IS ACTUALLY CHECKED is the same within-window drift read as its two siblings:
 * `recovery_delta` compares the first half of the window's nights against the second
 * half and asks whether the drift stayed at or above `target.value`. The claim is
 * "stepping weekly volume up should not send nightly sleep drifting downward across the
 * weeks that follow" — never "sleep should return to some prior level".
 *
 * The baseline sizes the tolerance and nothing else. A twentieth of the athlete's own
 * average is a personal way to say "a meaningful loss of sleep for this person", with a
 * 20-minute absolute floor so a short sleeper cannot end up with a tolerance inside
 * ordinary night-to-night noise. Deliberately more forgiving in relative terms than the
 * HRV guard's tenth: sleep duration is behavioral as much as physiological, and this
 * prediction must not read an ordinary late week as a training failure.
 */
export function buildSleepGuardExpectation(
  asOf: string,
  windowDays: number,
  context: { prior_weekly_km: number; new_weekly_km: number },
  baseline = sleepBaseline(asOf)
): ProposedExpectation | null {
  if (baseline.nights < 6 || baseline.average_min == null) return null;
  const windowEnd = addDaysISO(asOf, Math.max(1, Math.trunc(windowDays)));
  if (!windowEnd) return null;
  return {
    metric_key: "sleep_duration_delta",
    subject_key: null,
    direction: "at_least",
    baseline: {
      sleep_avg_min: baseline.average_min,
      nights: baseline.nights,
      prior_weekly_km: context.prior_weekly_km,
      new_weekly_km: context.new_weekly_km,
    },
    target: { value: rounded(-Math.max(20, baseline.average_min * 0.05), 1) },
    window_start: asOf,
    window_end: windowEnd,
    minimum_data: { nights: 6 },
    confounder_policy: "exclude_context_events",
    confidence: "tentative",
    evaluator: "recovery_delta",
    evaluator_version: "run-recovery-sleep-guard-v1",
  };
}

// ---------------------------------------------------------------------------
// The LONG-HORIZON aerobic read.
//
// Every other prediction in this file rides a change that can be rechecked in one to
// four weeks. VO2max cannot: the evaluator needs at least 4 readings spanning 21 days
// INSIDE the window before it will say anything at all, and a watch only re-estimates
// VO2max on hard or long efforts. An eight-week window is the shortest one an ordinary
// training month can actually fill.
//
// That length is also what makes this expectation fragile, and the two guards below are
// what keep it from rotting:
//
//   • FLOWING DATA. A wearable is optional in this app. An athlete whose watch never
//     reports VO2max must collect nothing — absence of a signal is neutral, never a
//     miss, and an expectation that can only ever mature inconclusive is ledger rot.
//
//   • ONE LIVE WINDOW. `overlappingDecisionConfounders` (evaluation-service) flags any
//     OTHER decision carrying the same metric + subject over an overlapping window, and
//     a single confounder forces `inconclusive`. That check is unconditional —
//     `confounder_policy` does not gate it — so two overlapping aerobic windows would
//     annihilate each other. The only remedy is to never write the second one, which is
//     what hasLiveAerobicTrendWindow enforces. It also gives the expectation its
//     cadence: it re-arms when the previous window closes, not on whatever schedule its
//     host decision happens to run on.
//
// The claim itself is deliberately a FLOOR, not a promise of improvement: "the training
// as it currently stands should not let aerobic fitness drift downward." A flat VO2max
// over two months is a perfectly good outcome and reads aligned. It carries no modifier
// anywhere — fitness trending up is an OUTCOME, not headroom-per-decision, and nothing
// in the reaction model may turn it into a bigger training step.
export const AEROBIC_TREND_WINDOW_DAYS = 56;
// Mirrors the evaluator's own refusal to read a slope off less than this.
export const AEROBIC_TREND_MIN_READINGS = 4;
export const AEROBIC_TREND_MIN_SPAN_DAYS = 21;
// How much recent signal counts as "the watch is actually reporting this".
const AEROBIC_TREND_RECENT_LOOKBACK_DAYS = 28;
const AEROBIC_TREND_MIN_RECENT_READINGS = 3;
// The per-WEEK slope floor the evaluator compares against (its `actual.value` is
// slope × 7). About half a point of VO2max lost across the whole eight weeks — inside
// the noise of consumer estimates, so only a real downward drift falls through it.
const AEROBIC_TREND_WEEKLY_SLOPE_FLOOR = -0.05;

/**
 * How many distinct days carried a VO2max reading in the trailing lookback, merged
 * across the same three feeds the evaluator reads (one value per date).
 */
export function recentVo2maxReadings(asOf: string, lookbackDays = AEROBIC_TREND_RECENT_LOOKBACK_DAYS): number {
  const end = addDaysISO(asOf, -1) ?? asOf;
  const start = addDaysISO(asOf, -Math.max(1, Math.trunc(lookbackDays))) ?? asOf;
  const dates = new Set<string>();
  for (const table of ["garmin_daily_metrics", "garmin_activities", "daily_metrics"]) {
    let rows: Array<{ date: string; vo2max: number | null }> = [];
    try {
      rows = db
        .prepare(
          `SELECT date, vo2max FROM ${table} WHERE date BETWEEN ? AND ? AND vo2max IS NOT NULL ORDER BY date LIMIT 500`
        )
        .all(start, end) as Array<{ date: string; vo2max: number | null }>;
    } catch {
      // An imported or partial database may not carry every feed. A missing table is
      // simply no readings from it, never a reason to refuse the whole read.
      rows = [];
    }
    for (const row of rows) {
      const value = Number(row.vo2max);
      if (Number.isFinite(value) && value > 0) dates.add(String(row.date));
    }
  }
  return dates.size;
}

/**
 * Is an aerobic-trend window already standing over any part of [start, end]?
 *
 * Deliberately WIDER than the confounder query it exists to stay clear of: any
 * expectation whose decision has not reached a terminal status counts, not only the
 * applied/announced ones the confounder check sees. Skipping a cycle costs nothing;
 * writing a second window costs both of them their verdict.
 */
export function hasLiveAerobicTrendWindow(windowStart: string, windowEnd: string): boolean {
  try {
    return !!db
      .prepare(
        `SELECT 1 FROM brain_expectations expectation
           JOIN brain_decisions decision ON decision.id = expectation.decision_id
          WHERE expectation.metric_key = 'vo2max_trend'
            AND expectation.window_start <= ?
            AND expectation.window_end >= ?
            AND decision.superseded_by IS NULL
            AND decision.status NOT IN ('rejected', 'reverted', 'superseded', 'canceled')
          LIMIT 1`
      )
      .get(windowEnd, windowStart);
  } catch {
    // No ledger tables to read means nothing can be confounded — but it also means this
    // guard cannot do its job, so it fails CLOSED and no window is opened.
    return true;
  }
}

/**
 * The eight-week "aerobic fitness should not drift down" expectation, or null when the
 * athlete isn't producing VO2max readings or a window is already standing.
 *
 * Belongs on a decision whose lifetime outlives the window — a canceled or superseded
 * decision takes its expectations down with it (`evaluateExpectation` writes a
 * `canceled` verdict), which is exactly the rot this window is long enough to attract.
 */
export function buildAerobicTrendExpectation(
  asOf: string,
  opts: { windowDays?: number; recentReadings?: number } = {}
): ProposedExpectation | null {
  const windowDays = Math.max(AEROBIC_TREND_MIN_SPAN_DAYS, Math.trunc(opts.windowDays ?? AEROBIC_TREND_WINDOW_DAYS));
  const windowEnd = addDaysISO(asOf, windowDays);
  if (!windowEnd) return null;
  const recentReadings = opts.recentReadings ?? recentVo2maxReadings(asOf);
  if (recentReadings < AEROBIC_TREND_MIN_RECENT_READINGS) return null;
  if (hasLiveAerobicTrendWindow(asOf, windowEnd)) return null;
  return {
    metric_key: "vo2max_trend",
    subject_key: null,
    direction: "at_least",
    baseline: { recent_readings: recentReadings, lookback_days: AEROBIC_TREND_RECENT_LOOKBACK_DAYS },
    target: { value: AEROBIC_TREND_WEEKLY_SLOPE_FLOOR },
    window_start: asOf,
    window_end: windowEnd,
    minimum_data: { readings: AEROBIC_TREND_MIN_READINGS, span_days: AEROBIC_TREND_MIN_SPAN_DAYS },
    // A trip, an illness or an injury genuinely does own an eight-week aerobic trend,
    // and saying so is more honest than convicting the programming for it.
    confounder_policy: "exclude_context_events",
    confidence: "tentative",
    evaluator: "vo2max_trend",
    evaluator_version: "aerobic-trend-hold-v1",
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
