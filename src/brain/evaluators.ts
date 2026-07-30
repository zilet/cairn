import { db } from "../db.js";
import type { BrainDecision } from "./decision-contract.js";
import type { BrainEvaluation, BrainEvaluationVerdict } from "./evaluation-contract.js";
import { BRAIN_METRIC_KEYS, type BrainExpectation, type BrainMetricKey } from "./expectation-contract.js";
import { isoDate, type JsonObject } from "./contract-utils.js";
import {
  READ_ADHERENCE_MEASURES,
  dayTrainingTruth,
  isPredictiveDayReadKind,
  readAdherenceOutcome,
} from "../repo/brain/read-adherence.js";
import { completedIntakeRange } from "../repo/intake-window.js";
import { mealPlanAdherence } from "../repo/nutrition.js";
import { canonicalEnduranceSport } from "../repo/endurance-sports.js";
import { lsqSlopePerDay } from "../repo/health.js";
import { addDaysISO } from "../repo/shared.js";
import { robustWeightEvidence } from "../repo/weight-evidence.js";

export const MATURITY_EVALUATOR_VERSION = "brain-maturity-v1";

export interface MetricObservation {
  actual: JsonObject | null;
  evidence_keys: string[];
  counts: Record<string, number>;
  issues: string[];
}

export interface EvaluatorContext {
  expectation: BrainExpectation;
  decision: BrainDecision;
  as_of: string;
}

export interface MetricEvaluator {
  metric_key: BrainMetricKey;
  evaluator: BrainExpectation["evaluator"];
  version: string;
  observe(context: EvaluatorContext): MetricObservation;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function numberFrom(value: JsonObject | null, keys: string[]): number | null {
  for (const key of keys) {
    const number = finite(value?.[key]);
    if (number != null) return number;
  }
  return null;
}

function stableEvidence(
  table: string,
  rows: Array<{ id?: unknown; date?: unknown }>,
  start: string,
  end: string
): string[] {
  if (!rows.length) return [];
  const first = rows[0];
  const last = rows[rows.length - 1];
  return [`${table}:${start}..${end}:n=${rows.length}:ids=${String(first.id ?? "-")}-${String(last.id ?? "-")}`];
}

function windowEnd(context: EvaluatorContext): string {
  return context.expectation.confounder_policy === "next_draw" ? context.as_of : context.expectation.window_end;
}

function closedThrough(context: EvaluatorContext): string {
  return addDaysISO(context.as_of, -1) ?? context.as_of;
}

function intakeForExpectation(context: EvaluatorContext, end = windowEnd(context)) {
  return completedIntakeRange(context.expectation.window_start, end, closedThrough(context));
}

function predictionFields(expectation: BrainExpectation, observedTrend: number | null): JsonObject {
  const explicit = numberFrom(expectation.baseline, ["predicted_trend_lb_wk"]);
  const min = numberFrom(expectation.target, ["min", "minimum", "min_value"]);
  const max = numberFrom(expectation.target, ["max", "maximum", "max_value"]);
  const predicted = explicit ?? (min != null && max != null ? rounded((min + max) / 2) : null);
  return {
    predicted_trend_lb_wk: predicted,
    observed_trend_lb_wk: observedTrend,
    trend_residual_lb_wk:
      predicted == null || observedTrend == null ? null : rounded(observedTrend - predicted),
    recomposition_stage: String(expectation.baseline?.recomposition_stage ?? "unknown"),
    target_delta_kcal: numberFrom(expectation.baseline, ["target_delta_kcal"]),
  };
}

function weightObservation(context: EvaluatorContext): MetricObservation {
  const { expectation } = context;
  const end = windowEnd(context);
  const weight = robustWeightEvidence(expectation.window_start, end);
  const intake = intakeForExpectation(context, end);
  const slope = weight.trend_lb_wk;
  const first = weight.points[0];
  const last = weight.points.at(-1);
  return {
    actual:
      slope == null
        ? null
        : {
            value: slope,
            trend_lb_wk: slope,
            ...predictionFields(expectation, slope),
            first_weight_lb: first ? rounded(first.weight_lb, 1) : null,
            last_weight_lb: last ? rounded(last.weight_lb, 1) : null,
            weigh_ins: weight.weigh_ins,
            raw_weigh_ins: weight.raw_points,
            span_days: weight.span_days,
            credible_intake_days: intake.credible_days,
            partial_intake_days: intake.partial_days,
            intake_calendar_days: intake.calendar_days,
            terminal_weight_shock: weight.terminal_shock,
            terminal_weight_shock_date: weight.terminal_shock_date,
            weight_level_shift: weight.level_shift,
          },
    evidence_keys: weight.evidence_keys,
    counts: {
      weigh_ins: weight.weigh_ins,
      intake_days: intake.credible_days,
      partial_intake_days: intake.partial_days,
      data_points: weight.weigh_ins,
      span_days: weight.span_days,
    },
    issues: [
      ...(slope == null ? ["Weight data did not cover enough distinct days for a stable trend."] : []),
      ...(weight.terminal_shock
        ? ["The terminal scale change is unconfirmed and cannot support a decisive nutrition outcome."]
        : []),
    ],
  };
}

// Did they eat the plan? The intake→weight metric asks whether the CALORIE TARGET
// produced the weight response it predicted, and that question is only answerable
// while the target is what was actually eaten. Without this read the evaluator had
// one explanation for every miss — the target is wrong — so a window the athlete
// simply ate around came back a clean `not_aligned` and eased a target that was fine.
//
// Deliberately asymmetric, in the athlete's favour and the truth's:
//   • No live meal plan → NO confounder. There is no plan to have diverged from, and
//     inventing one would make every plan-less athlete permanently inconclusive.
//   • Clearly diverged, or too thin to read → confounded. Both are "this window
//     cannot attribute the weight response to the target", which is a different
//     statement from "the target is wrong" and must not be collapsed into it.
//   • Following the plan is NOT evidence of anything and adds nothing — a followed
//     window simply leaves the comparison to run as before.
// Adherence never decides the verdict's direction. It can only take the decisive
// verdict away, which is exactly what a confounder is for.
function mealPlanAdherenceIssues(windowStart: string, windowEnd_: string): string[] {
  let adherence: ReturnType<typeof mealPlanAdherence> | null = null;
  try {
    adherence = mealPlanAdherence(windowStart, windowEnd_);
  } catch {
    return []; // an unreadable plan is never itself a confounder
  }
  if (!adherence || adherence.plan_id == null) return [];
  if (adherence.clearly_diverged) {
    return [
      "Logged intake diverged from the live meal plan on most readable days in this window, so the weight response cannot be attributed to the calorie target.",
    ];
  }
  if (adherence.confidence === "none" || adherence.confidence === "low") {
    return [
      "Too few days in this window carried enough logged detail to tell whether the meal plan was followed, so the weight response cannot be attributed to the calorie target.",
    ];
  }
  return [];
}

function intakeObservation(context: EvaluatorContext): MetricObservation {
  const { expectation } = context;
  const end = windowEnd(context);
  const intake = intakeForExpectation(context, end);
  const credible = intake.days.filter((day) => day.credible);
  const values = credible.map((day) => day.kcal);
  const intakeAverage = values.length ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  const weights = weightObservation(context);
  const trend = finite(weights.actual?.trend_lb_wk);
  const baselineIntake = numberFrom(expectation.baseline, ["intake_avg_kcal", "target_kcal", "value"]);
  return {
    actual:
      intakeAverage == null || trend == null
        ? null
        : {
            value: trend,
            trend_lb_wk: trend,
            ...predictionFields(expectation, trend),
            intake_avg_kcal: intakeAverage,
            intake_delta_kcal: baselineIntake == null ? 0 : rounded(intakeAverage - baselineIntake),
            intake_days: values.length,
            credible_intake_days: intake.credible_days,
            partial_intake_days: intake.partial_days,
            missing_intake_days: intake.missing_days,
            intake_calendar_days: intake.calendar_days,
            weigh_ins: weights.counts.weigh_ins ?? 0,
          },
    evidence_keys: [...intake.evidence_keys, ...weights.evidence_keys],
    counts: {
      intake_days: intake.credible_days,
      partial_intake_days: intake.partial_days,
      weigh_ins: weights.counts.weigh_ins ?? 0,
      data_points: Math.min(values.length, weights.counts.weigh_ins ?? 0),
      span_days: weights.counts.span_days ?? 0,
    },
    issues: [
      ...(values.length ? [] : ["There were no credible completed intake days in the evaluation window."]),
      ...weights.issues,
      ...mealPlanAdherenceIssues(expectation.window_start, end),
    ],
  };
}

function exerciseId(subject: string | null): number | null {
  if (!subject) return null;
  const numeric = Number(subject);
  const row =
    Number.isInteger(numeric) && numeric > 0
      ? (db.prepare(`SELECT id FROM exercises WHERE id = ?`).get(numeric) as { id: number } | undefined)
      : (db.prepare(`SELECT id FROM exercises WHERE lower(name) = lower(?)`).get(subject) as
          | { id: number }
          | undefined);
  return row?.id ?? null;
}

interface ExerciseSetRow {
  id: number;
  session_id: number;
  date: string;
  weight: number | null;
  reps: number | null;
  duration_sec: number | null;
}

function exerciseSets(context: EvaluatorContext): { rows: ExerciseSetRow[]; issue: string | null } {
  const id = exerciseId(context.expectation.subject_key);
  if (id == null) return { rows: [], issue: "The expected exercise could not be matched to a known movement." };
  const rows = db
    .prepare(
      `SELECT ls.id, ls.session_id, s.date, ls.weight, ls.reps, ls.duration_sec
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id = ? AND s.date BETWEEN ? AND ?
      ORDER BY s.date, s.id, ls.set_number LIMIT 1000`
    )
    .all(id, context.expectation.window_start, windowEnd(context)) as unknown as ExerciseSetRow[];
  return { rows, issue: null };
}

function exerciseCompletionObservation(context: EvaluatorContext): MetricObservation {
  const { expectation } = context;
  const read = exerciseSets(context);
  const bySession = new Map<number, ExerciseSetRow[]>();
  for (const row of read.rows) bySession.set(row.session_id, [...(bySession.get(row.session_id) ?? []), row]);
  const requiredSets = numberFrom(expectation.target, ["sets", "target_sets"]);
  const requiredReps = numberFrom(expectation.target, ["reps", "rep_low", "target_reps"]);
  const requiredWeight = numberFrom(expectation.target, ["weight", "target_weight"]);
  const requiredSeconds = numberFrom(expectation.target, ["duration_sec", "target_seconds"]);
  let completed = 0;
  for (const rows of bySession.values()) {
    const setCountOk = requiredSets == null || rows.length >= requiredSets;
    const repsOk =
      requiredReps == null || rows.some((row) => finite(row.reps) != null && Number(row.reps) >= requiredReps);
    const weightOk =
      requiredWeight == null || rows.some((row) => finite(row.weight) != null && Number(row.weight) >= requiredWeight);
    const secondsOk =
      requiredSeconds == null ||
      rows.some((row) => finite(row.duration_sec) != null && Number(row.duration_sec) >= requiredSeconds);
    if (setCountOk && repsOk && weightOk && secondsOk) completed++;
  }
  const exposures = bySession.size;
  const completionRate = exposures ? rounded(completed / exposures) : 0;
  return {
    actual: { value: completionRate, completion_rate: completionRate, exposures, completed_exposures: completed },
    evidence_keys: stableEvidence("logged_sets", read.rows, expectation.window_start, windowEnd(context)),
    counts: { exposures, sessions: exposures, data_points: read.rows.length },
    issues: [
      ...(read.issue ? [read.issue] : []),
      ...(exposures ? [] : ["The affected movement was not exposed during the evaluation window."]),
    ],
  };
}

function exerciseEst1rmObservation(context: EvaluatorContext): MetricObservation {
  const { expectation } = context;
  const read = exerciseSets(context);
  const bestByDate = new Map<string, number>();
  for (const row of read.rows) {
    const weight = finite(row.weight);
    const reps = finite(row.reps);
    if (weight == null || reps == null || weight <= 0 || reps <= 0) continue;
    const estimate = weight * (1 + reps / 30);
    bestByDate.set(row.date, Math.max(bestByDate.get(row.date) ?? 0, estimate));
  }
  const points = [...bestByDate.entries()].map(([date, value]) => ({ date, value }));
  const first = points[0]?.value ?? null;
  const last = points.at(-1)?.value ?? null;
  const delta = first != null && last != null ? rounded(last - first) : null;
  return {
    actual:
      delta == null
        ? null
        : {
            value: rounded(last!),
            delta,
            first_est_1rm: rounded(first!),
            last_est_1rm: rounded(last!),
            exposures: points.length,
          },
    evidence_keys: stableEvidence("logged_sets", read.rows, expectation.window_start, windowEnd(context)),
    counts: { exposures: points.length, data_points: points.length },
    issues: [
      ...(read.issue ? [read.issue] : []),
      ...(points.length < 2 ? ["At least two comparable loaded exercise exposures are needed."] : []),
    ],
  };
}

interface SessionFeedbackRow {
  id: number;
  date: string;
  performance: number | null;
  soreness: number | null;
  joint_pain: string | null;
}

function sessionFeedbackRows(context: EvaluatorContext): SessionFeedbackRow[] {
  const id = exerciseId(context.expectation.subject_key);
  if (id == null) {
    return db
      .prepare(
        `SELECT s.id, s.date, s.performance, s.soreness, s.joint_pain
         FROM sessions s WHERE s.date BETWEEN ? AND ?
        ORDER BY s.date, s.id LIMIT 500`
      )
      .all(context.expectation.window_start, windowEnd(context)) as unknown as SessionFeedbackRow[];
  }
  return db
    .prepare(
      `SELECT s.id, s.date, s.performance, s.soreness, s.joint_pain
       FROM sessions s WHERE s.date BETWEEN ? AND ?
        AND EXISTS (SELECT 1 FROM logged_sets ls WHERE ls.session_id = s.id AND ls.exercise_id = ?)
      ORDER BY s.date, s.id LIMIT 500`
    )
    .all(context.expectation.window_start, windowEnd(context), id) as unknown as SessionFeedbackRow[];
}

function performanceObservation(context: EvaluatorContext): MetricObservation {
  const rows = sessionFeedbackRows(context).filter((row) => finite(row.performance) != null);
  const ratings = rows.map((row) => Number(row.performance));
  const average = ratings.length ? rounded(ratings.reduce((sum, value) => sum + value, 0) / ratings.length) : null;
  const half = Math.max(1, Math.floor(ratings.length / 2));
  const first = ratings.slice(0, half);
  const last = ratings.slice(-half);
  const delta =
    ratings.length >= 2
      ? rounded(
          last.reduce((sum, value) => sum + value, 0) / last.length -
            first.reduce((sum, value) => sum + value, 0) / first.length
        )
      : null;
  return {
    actual:
      average == null ? null : { value: average, average_rating: average, delta: delta ?? 0, exposures: rows.length },
    evidence_keys: stableEvidence("sessions", rows, context.expectation.window_start, windowEnd(context)),
    counts: { exposures: rows.length, sessions: rows.length, data_points: rows.length },
    issues: rows.length ? [] : ["No session performance feedback was recorded in the evaluation window."],
  };
}

function symptomObservation(context: EvaluatorContext): MetricObservation {
  const allRows = sessionFeedbackRows(context);
  const rows = allRows.filter((row) => row.soreness != null || !!row.joint_pain);
  const painReports = allRows.filter((row) => !!String(row.joint_pain ?? "").trim()).length;
  const soreness = rows.map((row) => finite(row.soreness)).filter((value): value is number => value != null);
  const average = soreness.length ? rounded(soreness.reduce((sum, value) => sum + value, 0) / soreness.length) : null;
  return {
    actual: {
      value: painReports,
      occurrences: painReports,
      joint_pain_reports: painReports,
      average_soreness: average ?? 0,
      exposures: allRows.length,
    },
    evidence_keys: stableEvidence("sessions", allRows, context.expectation.window_start, windowEnd(context)),
    counts: {
      exposures: allRows.length,
      sessions: allRows.length,
      feedback_entries: rows.length,
      data_points: rows.length,
    },
    issues: allRows.length ? [] : ["The affected movement or session was not exposed during the evaluation window."],
  };
}

function planAdherenceObservation(context: EvaluatorContext): MetricObservation {
  const rows = db
    .prepare(
      `SELECT id, date, plan_day_id, finished_at FROM sessions
      WHERE date BETWEEN ? AND ? ORDER BY date, id LIMIT 500`
    )
    .all(context.expectation.window_start, windowEnd(context)) as Array<{
    id: number;
    date: string;
    plan_day_id: number | null;
    finished_at: string | null;
  }>;
  const plannedRows = rows.filter((row) => row.plan_day_id != null);
  const completed = plannedRows.filter((row) => row.finished_at != null).length;
  const expected = numberFrom(context.expectation.target, ["planned_sessions", "planned_days", "required"]);
  const denominator = expected ?? plannedRows.length;
  const rate = denominator > 0 ? rounded(Math.min(1, completed / denominator)) : 0;
  return {
    actual: { value: rate, completion_rate: rate, planned_sessions: denominator, completed_sessions: completed },
    evidence_keys: stableEvidence("sessions", rows, context.expectation.window_start, windowEnd(context)),
    counts: { planned_days: denominator, sessions: completed, data_points: rows.length },
    issues: [
      ...(denominator > 0 ? [] : ["No planned session exposure was available for this window."]),
      ...(rows.length ? [] : ["No sessions were logged during the evaluation window."]),
    ],
  };
}

// Was the MORNING READ followed? The one same-day metric in the registry, and the
// only one that can mature overnight.
//
// The observed day is the expectation's `subject_key` (the read's own date), NOT
// the window span: the window deliberately ends a day later so the expectation
// cannot conclude while the day is still open, and observing that whole span
// would count tomorrow's training against today's read.
//
// Deliberate asymmetries:
//   • Absence IS evidence here. A followed rest day has no rows at all, so the
//     closed-day summary line below is the evidence key — without it the contract
//     would force every honest "they rested" to inconclusive.
//   • An `easy` read against work that could not be graded stays INCONCLUSIVE.
//     Presence without a grade cannot answer "did it stay easy?", and guessing
//     against the athlete is exactly what this metric must never do.
//   • Adherence is a COUNT of followed/diverged days, never a rate and never a
//     grade. It informs; it changes no threshold.
function dayReadAdherenceObservation(context: EvaluatorContext): MetricObservation {
  const { expectation } = context;
  const readDate = isoDate(expectation.subject_key) ?? expectation.window_start;
  const readKind = String(expectation.baseline?.read_kind ?? "");
  if (!isPredictiveDayReadKind(readKind)) {
    return {
      actual: null,
      evidence_keys: [],
      counts: { closed_days: 0, data_points: 0 },
      issues: ["The stored read kind does not make a prediction that can be checked."],
    };
  }
  // The day must be CLOSED before its log can be read as a decision about it.
  const closed = context.as_of > readDate;
  if (!closed) {
    return {
      actual: null,
      evidence_keys: [],
      counts: { closed_days: 0, data_points: 0 },
      issues: ["The day had not closed yet, so what was logged on it is still incomplete."],
    };
  }
  const truth = dayTrainingTruth(readDate);
  const outcome = readAdherenceOutcome(readKind, truth);
  const diverged = outcome === "diverged" ? 1 : 0;
  const actual: JsonObject = {
    // `value` serves the `at_least` train comparison; `occurrences` serves the
    // `avoid` rest/easy one (compareExpectation reads occurrences first there).
    value: readKind === "train" ? (truth.trained ? 1 : 0) : diverged,
    occurrences: diverged,
    read_kind: readKind,
    // The exact test applied, in plain words, stored ON the verdict so a followed
    // `train` day can never be read back later as a hard one.
    measures: READ_ADHERENCE_MEASURES[readKind],
    followed: outcome === "followed",
    trained: truth.trained,
    load: truth.load,
    logged_sets: truth.sets,
    logged_activities: truth.activities,
    real_activities: truth.real_activities,
    read_date: readDate,
  };
  return {
    actual,
    // One deterministic, reproducible line about the closed day — true whether or
    // not anything was logged, which is what lets a followed rest day conclude.
    evidence_keys: [
      `day_read_adherence:${readDate}:read=${readKind}:sets=${truth.sets}:activities=${truth.real_activities}/${truth.activities}:load=${truth.load}`,
    ],
    counts: {
      closed_days: 1,
      data_points: 1,
      sessions: truth.sets > 0 ? 1 : 0,
      exposures: truth.trained ? 1 : 0,
    },
    issues:
      outcome === "unclear"
        ? ["Work was logged that could not be graded, so whether the day stayed easy can't be read."]
        : [],
  };
}

// Prescribed vs actually-run weekly km over the plan window. The expected window
// distance is stored on the expectation target at apply time; the actual is summed
// from RUN activities in the window (a ride/hike can never satisfy a run
// prescription). ZERO run outings → no evidence rows → inconclusive by contract.
//
// Athlete-favouring asymmetry: a MISS can never be declared while a run was logged
// WITHOUT a distance, but a PASS can. A distance-less run is presence without
// measurement — never evidence of a shortfall. So the MEASURED km alone must clear the
// bar for a clean pass (unmeasured presence irrelevant); if the measured total falls
// short AND any distance-less run exists, the shortfall is unverifiable → inconclusive;
// only when EVERY counted outing carries a distance and the total still falls short is
// it a real not_aligned.
function runVolumeAdherenceObservation(context: EvaluatorContext): MetricObservation {
  const { expectation } = context;
  const end = windowEnd(context);
  const rows = db
    .prepare(
      `SELECT id, date, type, distance_km FROM activities
      WHERE date BETWEEN ? AND ? ORDER BY date, id LIMIT 500`
    )
    .all(expectation.window_start, end) as Array<{
    id: number;
    date: string;
    type: string;
    distance_km: number | null;
  }>;
  const runRows = rows.filter((row) => canonicalEnduranceSport(row.type).key === "run");
  // Only distance-carrying outings can measure adherence; the rest are unmeasured.
  const measuredRows = runRows.filter((row) => {
    const km = finite(row.distance_km);
    return km != null && km > 0;
  });
  const unmeasuredOutings = runRows.length - measuredRows.length;
  let actualKm = 0;
  for (const row of measuredRows) actualKm += Number(row.distance_km);
  actualKm = rounded(actualKm, 1);
  const expectedKm = numberFrom(expectation.target, ["expected_km", "prescribed_km"]) ?? 0;
  const completionRate = expectedKm > 0 ? rounded(actualKm / expectedKm) : 0;
  // The completion bar (matches compareExpectation's 'complete' reading of the target).
  const bar = numberFrom(expectation.target, ["rate", "value", "target"]) ?? 1;
  const measuredClearsBar = expectedKm > 0 && completionRate >= bar;
  // A shortfall a distance-less outing makes impossible to verify → inconclusive.
  const unverifiableShortfall = expectedKm > 0 && !measuredClearsBar && unmeasuredOutings > 0;
  return {
    actual:
      expectedKm > 0
        ? {
            value: completionRate,
            completion_rate: completionRate,
            actual_km: actualKm,
            expected_km: rounded(expectedKm, 1),
            outings: runRows.length,
            measured_outings: measuredRows.length,
            unmeasured_outings: unmeasuredOutings,
          }
        : null,
    // Evidence is the measured runs — the only outings that can support a km verdict.
    evidence_keys: stableEvidence("activities", measuredRows, expectation.window_start, end),
    counts: { outings: runRows.length, data_points: runRows.length },
    issues: [
      ...(expectedKm > 0 ? [] : ["No prescribed running distance was stored to compare against."]),
      ...(runRows.length ? [] : ["No running was logged in the evaluation window."]),
      ...(unverifiableShortfall
        ? ["Runs were logged without distance — adherence can't be verified against the prescribed km."]
        : []),
    ],
  };
}

// VO2max trend over the window — the slow-moving aerobic-fitness read. VO2max only
// updates on hard/long efforts, so it is deliberately gated hard: fewer than 4
// readings OR a span under 21 days stays inconclusive (a slope off 2–3 noisy dots
// is meaningless). Readings are merged across the Garmin daily/activity feeds and the
// source-agnostic daily_metrics table, one (max) per date.
function vo2maxTrendObservation(context: EvaluatorContext): MetricObservation {
  const { expectation } = context;
  const end = windowEnd(context);
  const daily = db
    .prepare(
      `SELECT date, vo2max FROM garmin_daily_metrics
      WHERE date BETWEEN ? AND ? AND vo2max IS NOT NULL ORDER BY date LIMIT 500`
    )
    .all(expectation.window_start, end) as Array<{ date: string; vo2max: number }>;
  const acts = db
    .prepare(
      `SELECT date, vo2max FROM garmin_activities
      WHERE date BETWEEN ? AND ? AND vo2max IS NOT NULL ORDER BY date LIMIT 500`
    )
    .all(expectation.window_start, end) as Array<{ date: string; vo2max: number }>;
  const other = db
    .prepare(
      `SELECT date, vo2max FROM daily_metrics
      WHERE date BETWEEN ? AND ? AND vo2max IS NOT NULL ORDER BY date LIMIT 500`
    )
    .all(expectation.window_start, end) as Array<{ date: string; vo2max: number }>;
  const byDate = new Map<string, number>();
  for (const row of [...daily, ...acts, ...other]) {
    const value = finite(row.vo2max);
    if (value == null || value <= 0) continue;
    byDate.set(String(row.date), Math.max(byDate.get(String(row.date)) ?? 0, value));
  }
  const points = [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const spanDays =
    points.length >= 2
      ? Math.round(
          (Date.parse(points[points.length - 1].date + "T00:00:00Z") - Date.parse(points[0].date + "T00:00:00Z")) /
            864e5
        )
      : 0;
  const enough = points.length >= 4 && spanDays >= 21;
  const slope = enough ? lsqSlopePerDay(points) : null;
  const first = points[0]?.value ?? null;
  const last = points.at(-1)?.value ?? null;
  const delta = enough && first != null && last != null ? rounded(last - first, 2) : null;
  const evidenceRows = points.map((point) => ({ id: point.date, date: point.date }));
  return {
    actual:
      enough && slope != null
        ? {
            value: rounded(slope * 7, 3), // per-week slope — the readable trend
            delta,
            slope_per_day: rounded(slope, 4),
            first_vo2max: rounded(first!, 1),
            last_vo2max: rounded(last!, 1),
            readings: points.length,
            span_days: spanDays,
          }
        : null,
    evidence_keys: enough ? stableEvidence("garmin_daily_metrics", evidenceRows, expectation.window_start, end) : [],
    counts: { readings: points.length, data_points: points.length, span_days: spanDays },
    issues: enough ? [] : ["VO2max needs at least 4 readings spanning 3+ weeks to read a trend."],
  };
}

function recoveryRows(start: string, end: string): Array<Record<string, unknown>> {
  const other = db
    .prepare(
      `SELECT id, date, sleep_min, resting_hr, hrv_ms, updated_at FROM daily_metrics
      WHERE date BETWEEN ? AND ? ORDER BY date, updated_at, id LIMIT 500`
    )
    .all(start, end) as Array<Record<string, unknown>>;
  const garmin = db
    .prepare(
      `SELECT id, date, sleep_min, resting_hr, hrv_ms, synced_at FROM garmin_daily_metrics
      WHERE date BETWEEN ? AND ? ORDER BY date, id LIMIT 500`
    )
    .all(start, end) as Array<Record<string, unknown>>;
  const byDate = new Map<string, Record<string, unknown>>();
  for (const row of other) byDate.set(String(row.date), row);
  for (const row of garmin) {
    const previous = byDate.get(String(row.date)) ?? {};
    byDate.set(String(row.date), {
      ...previous,
      ...Object.fromEntries(Object.entries(row).filter(([, value]) => value != null)),
      source: "garmin",
    });
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function recoveryObservation(context: EvaluatorContext): MetricObservation {
  const { expectation } = context;
  const rows = recoveryRows(expectation.window_start, windowEnd(context));
  const column =
    expectation.metric_key === "recovery_hrv_delta"
      ? "hrv_ms"
      : expectation.metric_key === "recovery_rhr_delta"
        ? "resting_hr"
        : "sleep_min";
  const usable = rows.filter((row) => finite(row[column]) != null);
  const values = usable.map((row) => Number(row[column]));
  const half = Math.max(1, Math.floor(values.length / 2));
  const first = values.slice(0, half);
  const last = values.slice(-half);
  const firstAverage = first.length ? first.reduce((sum, value) => sum + value, 0) / first.length : null;
  const lastAverage = last.length ? last.reduce((sum, value) => sum + value, 0) / last.length : null;
  const delta =
    firstAverage != null && lastAverage != null && values.length >= 2 ? rounded(lastAverage - firstAverage) : null;
  return {
    actual:
      delta == null
        ? null
        : {
            value: delta,
            delta,
            baseline_average: rounded(firstAverage!),
            outcome_average: rounded(lastAverage!),
            nights: usable.length,
            metric: column,
          },
    evidence_keys: stableEvidence("daily_metrics", usable, expectation.window_start, windowEnd(context)),
    counts: { nights: usable.length, data_points: usable.length },
    issues: delta == null ? ["Recovery data did not contain enough comparable nights."] : [],
  };
}

function normalizeName(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function markerObservation(context: EvaluatorContext): MetricObservation {
  const { expectation } = context;
  const wanted = normalizeName(expectation.subject_key);
  if (!wanted)
    return { actual: null, evidence_keys: [], counts: { draws: 0 }, issues: ["A marker subject is required."] };
  const rows = db
    .prepare(
      `SELECT id, doc_date AS date, parsed_json FROM health_documents
      WHERE doc_date BETWEEN ? AND ? AND parsed_json IS NOT NULL
      ORDER BY doc_date, id LIMIT 200`
    )
    .all(expectation.window_start, windowEnd(context)) as Array<{ id: number; date: string; parsed_json: string }>;
  const readings: Array<{ id: number; date: string; value: number; unit: string }> = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.parsed_json);
      for (const marker of Array.isArray(parsed?.markers) ? parsed.markers.slice(0, 300) : []) {
        const name = normalizeName(marker?.name ?? marker?.marker ?? marker?.key);
        const value = finite(marker?.value);
        if (name === wanted && value != null) {
          readings.push({ id: row.id, date: row.date, value, unit: String(marker?.unit ?? "").trim() });
        }
      }
    } catch {
      // Invalid historical documents are not evaluation evidence.
    }
  }
  const units = new Set(readings.map((row) => row.unit.toLowerCase()).filter(Boolean));
  const storedBaseline = numberFrom(expectation.baseline, ["value", "baseline_value", "latest_value"]);
  const first = readings[0];
  const last = readings.at(-1);
  const baselineValue = storedBaseline ?? (readings.length >= 2 ? (first?.value ?? null) : null);
  const delta = baselineValue != null && last ? rounded(last.value - baselineValue, 3) : null;
  return {
    actual: last
      ? {
          value: last.value,
          delta: delta ?? 0,
          baseline_value: baselineValue ?? last.value,
          latest_value: last.value,
          unit: last.unit,
          draws: readings.length,
        }
      : null,
    evidence_keys: stableEvidence("health_documents", readings, expectation.window_start, windowEnd(context)),
    counts: { draws: readings.length, data_points: readings.length },
    issues: [
      ...(units.size > 1 ? ["Marker readings used incompatible units."] : []),
      ...(delta == null ? ["A comparable follow-up marker draw was not available."] : []),
    ],
  };
}

const BODY_SITES = new Set([
  "waist_in",
  "hip_in",
  "chest_in",
  "shoulder_in",
  "neck_in",
  "thigh_in",
  "upper_arm_in",
  "calf_in",
  "forearm_in",
]);

function bodyMeasurementObservation(context: EvaluatorContext): MetricObservation {
  const { expectation } = context;
  const site = String(expectation.subject_key ?? "")
    .trim()
    .toLowerCase();
  if (!BODY_SITES.has(site)) {
    return {
      actual: null,
      evidence_keys: [],
      counts: { measurements: 0 },
      issues: ["A supported body-measurement site is required."],
    };
  }
  const rows = db
    .prepare(
      `SELECT id, date, ${site} AS value FROM body_measurements
      WHERE date BETWEEN ? AND ? AND ${site} IS NOT NULL
      ORDER BY date, id LIMIT 500`
    )
    .all(expectation.window_start, windowEnd(context)) as Array<{ id: number; date: string; value: number }>;
  const first = rows[0];
  const last = rows.at(-1);
  const storedBaseline = numberFrom(expectation.baseline, ["value", "baseline_value", "latest_value"]);
  const baselineValue = storedBaseline ?? (rows.length >= 2 ? Number(first?.value) : null);
  const delta = baselineValue != null && last ? rounded(Number(last.value) - baselineValue) : null;
  return {
    actual: last
      ? {
          value: Number(last.value),
          delta: delta ?? 0,
          baseline_value: baselineValue ?? Number(last.value),
          latest_value: Number(last.value),
          measurements: rows.length,
          site,
        }
      : null,
    evidence_keys: stableEvidence("body_measurements", rows, expectation.window_start, windowEnd(context)),
    counts: { measurements: rows.length, data_points: rows.length },
    issues: delta == null ? ["A comparable follow-up measurement was not available."] : [],
  };
}

function entry(
  metric_key: BrainMetricKey,
  evaluator: BrainExpectation["evaluator"],
  observe: MetricEvaluator["observe"]
): MetricEvaluator {
  return Object.freeze({ metric_key, evaluator, version: `${MATURITY_EVALUATOR_VERSION}/${evaluator}`, observe });
}

export const EVALUATOR_REGISTRY: Readonly<Record<BrainMetricKey, MetricEvaluator>> = Object.freeze({
  weight_trend_lb_wk: entry("weight_trend_lb_wk", "weight_trend", weightObservation),
  intake_to_weight_response: entry("intake_to_weight_response", "intake_response", intakeObservation),
  exercise_target_completion: entry("exercise_target_completion", "exercise_completion", exerciseCompletionObservation),
  exercise_est_1rm_trend: entry("exercise_est_1rm_trend", "exercise_est_1rm", exerciseEst1rmObservation),
  session_performance_feedback: entry("session_performance_feedback", "session_feedback", performanceObservation),
  joint_pain_or_soreness: entry("joint_pain_or_soreness", "symptom_load", symptomObservation),
  plan_day_adherence: entry("plan_day_adherence", "plan_adherence", planAdherenceObservation),
  day_read_adherence: entry("day_read_adherence", "day_read_adherence", dayReadAdherenceObservation),
  run_volume_adherence: entry("run_volume_adherence", "run_volume_adherence", runVolumeAdherenceObservation),
  vo2max_trend: entry("vo2max_trend", "vo2max_trend", vo2maxTrendObservation),
  recovery_hrv_delta: entry("recovery_hrv_delta", "recovery_delta", recoveryObservation),
  recovery_rhr_delta: entry("recovery_rhr_delta", "recovery_delta", recoveryObservation),
  sleep_duration_delta: entry("sleep_duration_delta", "recovery_delta", recoveryObservation),
  marker_direction: entry("marker_direction", "marker_direction", markerObservation),
  body_measurement_direction: entry(
    "body_measurement_direction",
    "body_measurement_direction",
    bodyMeasurementObservation
  ),
});

if (Object.keys(EVALUATOR_REGISTRY).length !== BRAIN_METRIC_KEYS.length) {
  throw new Error("brain evaluator registry does not cover every known metric key");
}

const RATING_TARGETS: Record<string, number> = {
  poor: 1,
  below_expected: 2,
  okay: 3,
  okay_or_better: 3,
  good: 4,
  strong: 5,
};

function targetNumber(target: JsonObject, keys: string[]): number | null {
  const direct = numberFrom(target, keys);
  if (direct != null) return direct;
  const rating = typeof target.rating === "string" ? RATING_TARGETS[target.rating] : null;
  return rating ?? null;
}

function compareExpectation(expectation: BrainExpectation, actual: JsonObject): boolean | null {
  const value = numberFrom(actual, ["value", "delta", "completion_rate"]);
  const delta =
    numberFrom(actual, ["delta"]) ??
    (value != null && numberFrom(expectation.baseline, ["value"]) != null
      ? value - numberFrom(expectation.baseline, ["value"])!
      : null);
  const min = targetNumber(expectation.target, ["min", "minimum", "min_value", "min_rate", "min_delta"]);
  const max = targetNumber(expectation.target, ["max", "maximum", "max_value", "max_delta"]);
  const target = targetNumber(expectation.target, ["value", "target", "target_value", "rate", "rating"]);
  const tolerance = targetNumber(expectation.target, ["tolerance", "tolerance_abs"]);
  switch (expectation.direction) {
    case "within_band":
      return value == null || min == null || max == null ? null : value >= min && value <= max;
    case "at_least": {
      const threshold = target ?? min;
      return value == null || threshold == null ? null : value >= threshold;
    }
    case "at_most": {
      const threshold = target ?? max;
      return value == null || threshold == null ? null : value <= threshold;
    }
    case "increase": {
      const threshold = target ?? min;
      if (value != null && threshold != null) return value >= threshold;
      return delta == null ? null : delta > 0;
    }
    case "decrease": {
      const threshold = target ?? max;
      if (value != null && threshold != null) return value <= threshold;
      return delta == null ? null : delta < 0;
    }
    case "maintain": {
      if (
        typeof expectation.target.rating === "string" &&
        expectation.target.rating.endsWith("_or_better") &&
        value != null &&
        target != null
      ) {
        return value >= target;
      }
      if (
        typeof expectation.target.rating === "string" &&
        expectation.target.rating.endsWith("_or_lower") &&
        value != null &&
        target != null
      ) {
        return value <= target;
      }
      if (value != null && min != null && max != null) return value >= min && value <= max;
      if (value != null && target != null && tolerance != null) return Math.abs(value - target) <= tolerance;
      return delta != null && tolerance != null ? Math.abs(delta) <= tolerance : null;
    }
    case "complete": {
      const rate = numberFrom(actual, ["completion_rate", "value"]);
      return rate == null ? null : rate >= (target ?? min ?? 1);
    }
    case "avoid": {
      const occurrences = numberFrom(actual, ["occurrences", "joint_pain_reports", "value"]);
      return occurrences == null ? null : occurrences <= (max ?? target ?? 0);
    }
  }
}

const MINIMUM_ALIASES: Record<string, string> = {
  weigh_in_days: "weigh_ins",
  intake_logged_days: "intake_days",
  exposure_count: "exposures",
  session_count: "sessions",
  measurement_count: "measurements",
  nights_logged: "nights",
  marker_draws: "draws",
};

export function minimumDataIssues(expectation: BrainExpectation, observation: MetricObservation): string[] {
  if (!expectation.minimum_data) return [];
  const issues: string[] = [];
  for (const [rawKey, rawRequired] of Object.entries(expectation.minimum_data)) {
    const required = finite(rawRequired);
    if (required == null) continue;
    const key = MINIMUM_ALIASES[rawKey] ?? rawKey;
    const actual = observation.counts[key];
    if (actual == null) {
      issues.push(`Minimum-data rule '${rawKey}' is not supported by this evaluator.`);
    } else if (actual < required) {
      issues.push(`Only ${actual} ${rawKey.replaceAll("_", " ")} were available; ${required} were required.`);
    }
  }
  return issues;
}

export function evaluateMetricObservation(
  expectation: BrainExpectation,
  observation: MetricObservation,
  confounders: string[] = [],
  evaluatorVersion = EVALUATOR_REGISTRY[expectation.metric_key].version
): Omit<BrainEvaluation, "id" | "evaluated_at"> {
  const allConfounders = [
    ...new Set([...confounders, ...observation.issues, ...minimumDataIssues(expectation, observation)]),
  ];
  let verdict: BrainEvaluationVerdict = "inconclusive";
  let explanation = "The available window does not support a clean conclusion yet.";
  if (!allConfounders.length && observation.actual) {
    const aligned = compareExpectation(expectation, observation.actual);
    if (aligned == null) {
      allConfounders.push("The stored target could not be compared deterministically without guessing.");
    } else if (observation.evidence_keys.length === 0) {
      // The evaluation contract refuses a decisive verdict without evidence, so
      // an evidence-free comparison must stay inconclusive rather than throw at insert.
      allConfounders.push("No supporting evidence rows existed in the evaluation window.");
    } else {
      verdict = aligned ? "aligned" : "not_aligned";
      explanation = aligned
        ? "The observed result landed within the expectation after enough comparable data was available."
        : "The observed result did not land within the expectation after enough comparable data was available.";
    }
  }
  return {
    expectation_id: expectation.id!,
    verdict,
    actual: observation.actual,
    evidence_keys: verdict === "aligned" || verdict === "not_aligned" ? observation.evidence_keys : [],
    confounders: allConfounders,
    explanation,
    evaluator_version: evaluatorVersion,
  };
}

export function observeExpectation(context: EvaluatorContext): MetricObservation {
  const evaluator = EVALUATOR_REGISTRY[context.expectation.metric_key];
  if (evaluator.evaluator !== context.expectation.evaluator) {
    return {
      actual: null,
      evidence_keys: [],
      counts: {},
      issues: ["The expectation evaluator does not match the registered metric evaluator."],
    };
  }
  return evaluator.observe(context);
}
