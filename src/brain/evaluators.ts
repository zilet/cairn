import { db } from "../db.js";
import type { BrainDecision } from "./decision-contract.js";
import type { BrainEvaluation, BrainEvaluationVerdict } from "./evaluation-contract.js";
import {
  BRAIN_METRIC_KEYS,
  canonicalMinimumDataKey,
  type BrainExpectation,
  type BrainMetricKey,
} from "./expectation-contract.js";
import { isoDate, type JsonObject } from "./contract-utils.js";
import {
  DAY_READ_ADHERENCE_EVALUATOR_VERSION,
  DAY_READ_JUDGED_ERA,
  READ_ADHERENCE_MEASURES,
  dayTrainingTruth,
  harmVerdictOnDay,
  isPredictiveDayReadKind,
  readAdherenceOutcome,
} from "../repo/brain/read-adherence.js";
import {
  DAY_READ_CALL_EXPLANATION,
  DAY_READ_CALL_MEASURES,
  dayReadCall,
  dayReadCallNeedsHarm,
  dayReadCallWasOff,
} from "../repo/brain/day-read-call.js";
import { completedIntakeRange } from "../repo/intake-window.js";
import { mealPlanAdherence } from "../repo/nutrition.js";
import { canonicalEnduranceSport } from "../repo/endurance-sports.js";
import { withoutShadowActivities } from "../repo/activity-shadow.js";
import { dailySiteSeries } from "../repo/measurement-series.js";
import { lsqSlopePerDay } from "../repo/health.js";
import { addDaysISO } from "../repo/shared.js";
import { robustWeightEvidence } from "../repo/weight-evidence.js";
import { verifiedTopSetInWindow } from "../repo/calibration.js";
import { normalizedExerciseKey, resolveExerciseName } from "../repo/exercise-canon.js";
import { getBrainRollback } from "../repo/brain-decisions.js";
import { coerceFinite as finite } from "../lib/numbers.js";
import { INCONCLUSIVE_REASON_TEXT } from "./inconclusive-reasons.js";
import { attributePain, statedPainOccasions } from "../repo/brain/pain-reports.js";

export const MATURITY_EVALUATOR_VERSION = "brain-maturity-v1";

export interface MetricObservation {
  actual: JsonObject | null;
  evidence_keys: string[];
  counts: Record<string, number>;
  issues: string[];
  // Optional plain-words explanation for a CONCLUSIVE verdict, replacing the generic
  // "landed / did not land within the expectation" line. Only a metric whose verdict
  // is rendered back to the athlete needs one (day_read_adherence).
  verdict_explanation?: string;
  // The evaluator's OWN comparison, for a metric whose stored target cannot be read by
  // the generic compareExpectation without losing what it says (a prescription to
  // complete N times, an agent-authored est-1RM floor). `aligned: null` is "this
  // target cannot be judged as a pass" and its `reason` becomes a confounder — never a
  // silent fallback to the generic reading, which is what made those targets vacuous.
  comparison?: { aligned: boolean | null; reason?: string };
}

// One stretch of days a material context event (a trip, an injury, an athlete tag)
// covered inside the window. For the EXPOSURE-scoped metrics the evaluation service
// hands these to the evaluator instead of confounding the whole window: an exposure
// dated inside one is set aside, every other exposure still counts.
export interface ContextExclusion {
  label: string;
  start: string;
  end: string;
}

export interface EvaluatorContext {
  expectation: BrainExpectation;
  decision: BrainDecision;
  as_of: string;
  context_exclusions?: ContextExclusion[];
}

export interface MetricEvaluator {
  metric_key: BrainMetricKey;
  evaluator: BrainExpectation["evaluator"];
  version: string;
  observe(context: EvaluatorContext): MetricObservation;
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
    trend_residual_lb_wk: predicted == null || observedTrend == null ? null : rounded(observedTrend - predicted),
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

// The movement an expectation is about, resolved through the ONE exercise-identity
// ladder (exact → alias hop → key → unique expanded key) every other lift fact uses.
// A raw `lower(name)` match here left every expectation written under an alias
// spelling ("Incline DB Press", "Lateral Raise", "DB Bench Press") permanently
// "could not be matched", while the lift was being logged under its stored name the
// whole time. A catalog that still holds a same-key duplicate (a plural, a "timed"
// suffix) contributes both rows' history — the same fold the lift ledger reads by.
function exerciseIds(subject: string | null): number[] {
  if (!subject) return [];
  const numeric = Number(subject);
  if (Number.isInteger(numeric) && numeric > 0) {
    const row = db.prepare(`SELECT id FROM exercises WHERE id = ?`).get(numeric) as { id: number } | undefined;
    return row ? [Number(row.id)] : [];
  }
  const resolved = resolveExerciseName(subject);
  if (resolved.exercise_id == null) return [];
  const key = normalizedExerciseKey(resolved.canonical);
  const ids = new Set<number>([resolved.exercise_id]);
  if (key) {
    for (const row of db.prepare(`SELECT id, name FROM exercises`).all() as Array<{ id: number; name: string }>) {
      if (normalizedExerciseKey(String(row.name)) === key) ids.add(Number(row.id));
    }
  }
  return [...ids];
}

interface ExerciseSetRow {
  id: number;
  session_id: number;
  date: string;
  weight: number | null;
  reps: number | null;
  duration_sec: number | null;
  /** When the work was done: the session's finish, else the set's own write. */
  done_at: string | null;
}

// An SQLite `datetime('now')` stamp ("YYYY-MM-DD HH:MM:SS", UTC) or an ISO instant.
function stampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.includes("T") ? value : `${value.trim().replace(" ", "T")}Z`;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

// WORK DONE BEFORE THE CHANGE IS NOT A TEST OF IT.
//
// An expectation's window opens on the decision's own date, and most training changes
// are applied the moment a session FINISHES — the session that earned the step is
// logged a second before the step exists. Counting it handed every completion and
// est-1RM verdict one free exposure: the very sets the change was derived from,
// graded against the change. A catch-up to "your real working weight" then completed
// itself by construction, and a hold claim's best estimate could be the triggering
// session's own number. So work finished at or before the change landed is set aside
// (and counted on the verdict); a row with no usable stamp is kept, since its date is
// already inside the window.
function afterTheChange<T extends { done_at?: string | null; session_id?: number; id?: number }>(
  context: EvaluatorContext,
  rows: T[]
): { rows: T[]; pre_change_exposures: number } {
  const landed = stampMs(context.decision?.applied_at) ?? stampMs(context.decision?.created_at);
  if (landed == null) return { rows, pre_change_exposures: 0 };
  const kept: T[] = [];
  const before = new Set<string>();
  for (const row of rows) {
    const done = stampMs(row.done_at);
    if (done != null && done <= landed) before.add(String(row.session_id ?? row.id));
    else kept.push(row);
  }
  return { rows: kept, pre_change_exposures: before.size };
}

// Which context event, if any, covers this date. First match wins; the label is only
// provenance.
function exclusionFor(context: EvaluatorContext, date: string): ContextExclusion | null {
  for (const range of context.context_exclusions ?? []) {
    if (date >= range.start && date <= range.end) return range;
  }
  return null;
}

interface ContextFiltered<T> {
  rows: T[];
  /** Distinct exposures (sessions) set aside because a context event covered their date. */
  excluded_exposures: number;
  excluded_by: string[];
  /** Distinct exposures finished before the change landed (see afterTheChange). */
  pre_change_exposures: number;
}

// The two exposure filters every exposure-scoped evaluator applies, in order: work
// done before the change is not about it, and work inside a context event is not
// clean evidence of it.
function withoutContextDays<T extends { date: string; done_at?: string | null; session_id?: number; id?: number }>(
  context: EvaluatorContext,
  allRows: T[]
): ContextFiltered<T> {
  const after = afterTheChange(context, allRows);
  const rows = after.rows;
  const pre_change_exposures = after.pre_change_exposures;
  if (!context.context_exclusions?.length)
    return { rows, excluded_exposures: 0, excluded_by: [], pre_change_exposures };
  const kept: T[] = [];
  const excludedSessions = new Set<string>();
  const labels = new Set<string>();
  for (const row of rows) {
    const range = exclusionFor(context, String(row.date));
    if (!range) {
      kept.push(row);
      continue;
    }
    excludedSessions.add(String(row.session_id ?? row.id ?? row.date));
    labels.add(range.label);
  }
  return {
    rows: kept,
    excluded_exposures: excludedSessions.size,
    excluded_by: [...labels].slice(0, 6),
    pre_change_exposures,
  };
}

// Exclusion provenance on the verdict itself, plus the one issue that names the case
// where nothing was left: an athlete who only trained the lift on a trip has given
// no clean exposure, which is a different statement from "never trained it".
function exclusionFields(filtered: {
  excluded_exposures: number;
  excluded_by: string[];
  pre_change_exposures: number;
}): JsonObject {
  return {
    ...(filtered.excluded_exposures
      ? { context_excluded_exposures: filtered.excluded_exposures, context_excluded_by: filtered.excluded_by }
      : {}),
    ...(filtered.pre_change_exposures ? { pre_change_exposures: filtered.pre_change_exposures } : {}),
  };
}

function exclusionIssues(filtered: { rows: unknown[]; excluded_exposures: number; excluded_by: string[] }): string[] {
  return filtered.excluded_exposures && !filtered.rows.length
    ? [`${INCONCLUSIVE_REASON_TEXT.context_excluded_all} (${filtered.excluded_by.join(", ")})`]
    : [];
}

function exerciseSets(
  context: EvaluatorContext
): ContextFiltered<ExerciseSetRow> & { issue: string | null; ids: number[] } {
  const ids = exerciseIds(context.expectation.subject_key);
  if (!ids.length)
    return {
      rows: [],
      excluded_exposures: 0,
      excluded_by: [],
      pre_change_exposures: 0,
      ids,
      issue: "The expected exercise could not be matched to a known movement.",
    };
  const rows = db
    .prepare(
      `SELECT ls.id, ls.session_id, s.date, ls.weight, ls.reps, ls.duration_sec,
              COALESCE(s.finished_at, ls.created_at) AS done_at
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id IN (${ids.map(() => "?").join(", ")}) AND s.date BETWEEN ? AND ?
      ORDER BY s.date, s.id, ls.set_number LIMIT 1000`
    )
    .all(...ids, context.expectation.window_start, windowEnd(context)) as unknown as ExerciseSetRow[];
  return { ...withoutContextDays(context, rows), ids, issue: null };
}

// ---- what "completing the prescription" is measured against ------------------
//
// A completion expectation asks whether the athlete could do the work the change
// prescribed. The plan-proposal writer stores only `{ exposures: 2 }` as its target, so
// the old evaluator — which looked for sets/reps/weight on the TARGET alone — found no
// requirement at all and counted every exposure as complete: any session that merely
// touched the lift was a "pass". That verdict would have been vacuous, and only the
// blanket context confounder kept it from ever being written.
//
// The prescription is never guessed. It is read, field by field, from three sources
// in rising precedence:
//   1. the decision's own AFTER-snapshot (brain_rollbacks, v2) — the full plan item as
//      it stood once the change landed, which carries the fields a change left alone
//      (a load step records `sets: null` because it did not move them);
//   2. the decision's `action.changes[]` entry for the lift (its non-null fields);
//   3. explicit fields on the expectation's own target (an agent-authored target).
// No reps, no load and no time anywhere → there is nothing to complete, and the
// verdict says so (inconclusive), rather than passing an empty bar.
interface Prescription {
  sets: number | null;
  rep_low: number | null;
  weight: number | null;
  seconds: number | null;
  source: string[];
}

function sameLift(name: unknown, ids: number[], subject: string | null): boolean {
  const text = String(name ?? "").trim();
  if (!text) return false;
  const resolved = resolveExerciseName(text);
  if (resolved.exercise_id != null && ids.includes(resolved.exercise_id)) return true;
  return !!subject && normalizedExerciseKey(text) === normalizedExerciseKey(subject);
}

function liftChange(context: EvaluatorContext, ids: number[]): any | null {
  const action = (context.decision?.action ?? {}) as any;
  return (
    (Array.isArray(action.changes) ? action.changes : []).find((entry: any) =>
      sameLift(entry?.exercise, ids, context.expectation.subject_key)
    ) ?? null
  );
}

// The lift's plan item in the decision's before/after snapshot, on the change's own
// day when the change names one.
function liftSnapshotItem(context: EvaluatorContext, ids: number[], side: "before" | "after"): any | null {
  try {
    const rollback = context.decision?.id ? getBrainRollback(Number(context.decision.id)) : null;
    const days =
      rollback?.kind === "training_plan" && Array.isArray(rollback.payload?.[side]) ? rollback.payload[side] : [];
    const dayNumber = finite(liftChange(context, ids)?.day_number);
    for (const day of dayNumber == null ? days : days.filter((d: any) => Number(d?.day_number) === dayNumber)) {
      const item = (Array.isArray(day?.items) ? day.items : []).find((entry: any) =>
        sameLift(entry?.exercise, ids, context.expectation.subject_key)
      );
      if (item) return item;
    }
  } catch {
    // A missing or unreadable snapshot is silence, never a requirement.
  }
  return null;
}

const PRESCRIPTION_FIELDS = ["sets", "rep_low", "rep_high", "target_weight", "target_seconds"] as const;

function samePrescriptionValue(a: unknown, b: unknown): boolean {
  const left = finite(a);
  const right = finite(b);
  return left == null || right == null ? left == null && right == null : left === right;
}

/**
 * Did this decision actually MOVE the lift's prescription? `false` only when the
 * decision's own record PROVES nothing moved — its before/after snapshot items agree on
 * every prescription field, or its change entry's `before` matches what it wrote. A
 * change the record cannot settle answers `null` and is judged as before.
 *
 * It matters because both exercise metrics are CHANGE-EFFECT claims (the follow-up
 * note says "that change hasn't landed"; the lift ledger files the verdict against the
 * lift's progression). A plan proposal lists every item it touched — including ones it
 * re-wrote to the same numbers — and a verdict about one of those is a verdict about a
 * change that never happened.
 */
function changeMovedLift(context: EvaluatorContext, ids: number[]): boolean | null {
  const before = liftSnapshotItem(context, ids, "before");
  const after = liftSnapshotItem(context, ids, "after");
  if (before && after) return PRESCRIPTION_FIELDS.some((field) => !samePrescriptionValue(before[field], after[field]));
  const change = liftChange(context, ids);
  const prior = change?.before;
  if (change && prior && typeof prior === "object") {
    // In a change entry a null field means "left alone", so only a written value can move.
    return PRESCRIPTION_FIELDS.some(
      (field) => change[field] != null && !samePrescriptionValue(change[field], prior[field])
    );
  }
  return null;
}

function prescriptionFor(context: EvaluatorContext, ids: number[]): Prescription {
  const { expectation } = context;
  const out: Prescription = { sets: null, rep_low: null, weight: null, seconds: null, source: [] };
  const take = (
    item: any,
    source: string,
    keys: { sets: string[]; reps: string[]; weight: string[]; seconds: string[] }
  ) => {
    if (!item || typeof item !== "object") return;
    const pick = (names: string[]) => {
      for (const name of names) {
        const value = finite(item[name]);
        if (value != null) return value;
      }
      return null;
    };
    const sets = pick(keys.sets);
    const reps = pick(keys.reps);
    const weight = pick(keys.weight);
    const seconds = pick(keys.seconds);
    if (sets == null && reps == null && weight == null && seconds == null) return;
    if (sets != null) out.sets = sets;
    if (reps != null) out.rep_low = reps;
    if (weight != null) out.weight = weight;
    if (seconds != null) out.seconds = seconds;
    out.source.push(source);
  };
  const planKeys = {
    sets: ["sets"],
    reps: ["rep_low"],
    weight: ["target_weight"],
    seconds: ["target_seconds"],
  };
  const change = liftChange(context, ids);
  take(liftSnapshotItem(context, ids, "after"), "decision_after_snapshot", planKeys);
  take(change, "decision_change", planKeys);
  // Agent-authored targets name the floor they will accept (`floor_sets`, `min_sets`)
  // beside the written set count; the writer's own stated minimum is what it asked.
  take(expectation.target, "expectation_target", {
    sets: ["floor_sets", "min_sets", "sets", "target_sets"],
    reps: ["rep_low", "reps_low", "reps", "target_reps"],
    weight: ["weight", "target_weight", "weight_lb"],
    seconds: ["duration_sec", "target_seconds"],
  });
  return out;
}

// Logged loads round-trip through unit conversion (a kg plate logged in lb, a Garmin
// import) — 1% or half a pound, whichever is larger, absorbs that rounding and nothing
// more: it is well under one plate step on any implement.
function loadMet(logged: number | null, required: number): boolean {
  if (logged == null) return false;
  return logged >= required - Math.max(0.5, Math.abs(required) * 0.01);
}

function setMeetsPrescription(row: ExerciseSetRow, rx: Prescription): boolean {
  const reps = finite(row.reps);
  const seconds = finite(row.duration_sec);
  // A 0 (or absent) load target is bodyweight work: no load criterion. A NEGATIVE
  // target is an assist, and "at least" still reads correctly on the signed number —
  // -25 is less assistance than -30 — with an unloaded set (null) read as no assist at
  // all, which is harder than any assisted target.
  const weight = finite(row.weight) ?? (rx.weight != null && rx.weight < 0 ? 0 : null);
  if (rx.rep_low != null && rx.rep_low > 0 && (reps == null || reps < rx.rep_low)) return false;
  if (rx.weight != null && rx.weight !== 0 && !loadMet(weight, rx.weight)) return false;
  if (rx.seconds != null && rx.seconds > 0 && (seconds == null || seconds < rx.seconds)) return false;
  return true;
}

function exerciseCompletionObservation(context: EvaluatorContext): MetricObservation {
  const { expectation } = context;
  const read = exerciseSets(context);
  const bySession = new Map<number, ExerciseSetRow[]>();
  for (const row of read.rows) bySession.set(row.session_id, [...(bySession.get(row.session_id) ?? []), row]);
  const rx = prescriptionFor(context, read.ids);
  const hasRequirement =
    (rx.rep_low != null && rx.rep_low > 0) ||
    (rx.weight != null && rx.weight !== 0) ||
    (rx.seconds != null && rx.seconds > 0);
  // A session completes the prescription when it logged at least the prescribed number
  // of sets that EACH met the reps/load/time — one heavy single beside two light sets
  // is not three working sets at the target. RIR is never required: its absence is not
  // weakness (progression-voice.ts).
  const requiredSets = Math.max(1, Math.round(rx.sets ?? 1));
  let completed = 0;
  for (const rows of bySession.values()) {
    if (rows.filter((row) => setMeetsPrescription(row, rx)).length >= requiredSets) completed++;
  }
  const exposures = bySession.size;
  const completionRate = exposures ? rounded(completed / exposures) : 0;
  // `{ exposures: N }` (or `sessions: N`) is the writer's own claim: the new
  // prescription is met in at least N sessions of the window. Read literally — N
  // completions, not "every exposure" — so one off day among four does not turn a
  // change that is working into a miss, and two exposures that both fell short do.
  // A target that names a rate instead keeps the generic completion-rate reading.
  const requiredCompletions = finite(expectation.target?.exposures) ?? finite(expectation.target?.sessions);
  const comparison: MetricObservation["comparison"] =
    hasRequirement && requiredCompletions != null && requiredCompletions > 0
      ? { aligned: completed >= requiredCompletions }
      : undefined;
  return {
    actual: {
      value: completionRate,
      completion_rate: completionRate,
      exposures,
      completed_exposures: completed,
      required_completions: requiredCompletions ?? null,
      prescription: {
        sets: rx.sets,
        rep_low: rx.rep_low,
        target_weight: rx.weight,
        target_seconds: rx.seconds,
        source: rx.source.join("+") || "none",
      },
      ...exclusionFields(read),
    },
    evidence_keys: stableEvidence("logged_sets", read.rows, expectation.window_start, windowEnd(context)),
    counts: {
      exposures,
      sessions: exposures,
      data_points: read.rows.length,
      context_excluded_exposures: read.excluded_exposures,
    },
    issues: [
      ...(read.issue ? [read.issue] : []),
      ...(exposures || read.excluded_exposures
        ? []
        : ["The affected movement was not exposed during the evaluation window."]),
      ...exclusionIssues(read),
      ...(read.issue || hasRequirement ? [] : [INCONCLUSIVE_REASON_TEXT.no_prescription]),
      ...(read.ids.length && changeMovedLift(context, read.ids) === false ? [INCONCLUSIVE_REASON_TEXT.no_change] : []),
    ],
    ...(comparison ? { comparison } : {}),
  };
}

interface Est1rmVerification {
  verified: boolean;
  verified_on: string | null;
  /** Which side confirmed it: the baseline it was written against, or the window itself. */
  basis: "baseline" | "window" | "none";
}

/**
 * Was the number this window is being judged against ever confirmed by a heavy set?
 *
 * Two ways it can be. The baseline itself may have been rebased onto a verified
 * top set when the expectation was written (`baseline.basis`), or a verifying set
 * may have landed INSIDE the window, which re-anchors the estimate mid-flight.
 * Either one means the comparison is against a load the athlete has actually
 * stood under rather than a formula measured against itself.
 */
function est1rmVerification(context: EvaluatorContext): Est1rmVerification {
  const { expectation } = context;
  if (String(expectation.baseline?.basis ?? "") === "verified_top_set") {
    return { verified: true, verified_on: isoDate(expectation.baseline?.verified_on), basis: "baseline" };
  }
  const subject = String(expectation.subject_key ?? "").trim();
  if (subject) {
    try {
      const inWindow = verifiedTopSetInWindow(subject, expectation.window_start, windowEnd(context));
      if (inWindow) return { verified: true, verified_on: inWindow.date, basis: "window" };
    } catch {
      // The calibration ladder is evidence when it is readable and silence when it
      // is not. An unreadable ledger is never itself a reason to distrust a window.
    }
  }
  return { verified: false, verified_on: null, basis: "none" };
}

// AGENT-AUTHORED est-1RM targets. The lift-progression writer stores `{ value: x }`,
// which compareExpectation reads directly; a case conference writes its floor in its
// own words — `est_1rm_lb`, `min_est_1rm_lb`, `est_1rm_min` — which the generic
// comparison could never find, so every such claim fell to "could not be compared".
// This is spelling tolerance over a CLOSED list, never inference:
//   • a floor alias is "the window's best estimate should be at least this";
//   • a bare `est_1rm_lb` is a floor only under at_least/increase — under `maintain`
//     it could mean "stay near", which has no tolerance to read, so it stays unjudged;
//   • any OTHER criterion the target names (a trend, a status, "no grinding reps") is
//     one this evaluator cannot check, so it can still FAIL the target (a missed floor
//     fails it whatever else was asked) but can never PASS it.
const EST1RM_STANDARD_KEYS = ["value", "target", "target_value", "min", "minimum", "min_value", "max", "maximum"];
const EST1RM_FLOOR_ALIASES = ["est_1rm_lb_at_least", "min_est_1rm_lb", "est_1rm_lb_min", "est_1rm_min"];
// Prose and provenance fields an agent writes beside its number. They describe the
// claim; they are not part of it.
const EST1RM_ANNOTATION_KEYS = new Set([
  "note",
  "meaning",
  "basis",
  "floor_basis",
  "step_earned_if",
  "earns_next_load_lb",
  "earns_next_step",
  "tolerance_lb",
]);

function est1rmAliasComparison(expectation: BrainExpectation, best: number | null): MetricObservation["comparison"] {
  const target = expectation.target ?? {};
  if (EST1RM_STANDARD_KEYS.some((key) => finite(target[key]) != null)) return undefined;
  const floorKey =
    EST1RM_FLOOR_ALIASES.find((key) => finite(target[key]) != null) ??
    (["at_least", "increase"].includes(expectation.direction) && finite(target.est_1rm_lb) != null
      ? "est_1rm_lb"
      : null);
  if (!floorKey || best == null) return undefined;
  const floor = Number(finite(target[floorKey]));
  const unchecked = Object.keys(target).filter(
    (key) =>
      key !== floorKey &&
      !EST1RM_FLOOR_ALIASES.includes(key) &&
      key !== "est_1rm_lb" &&
      !EST1RM_ANNOTATION_KEYS.has(key)
  );
  if (best < floor) return { aligned: false };
  if (unchecked.length) {
    return {
      aligned: null,
      reason: `${INCONCLUSIVE_REASON_TEXT.unchecked_criteria} (${unchecked.slice(0, 4).join(", ")})`,
    };
  }
  return { aligned: true };
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
  // The claim being checked is "this load step should HOLD" — did the lift's estimate
  // stay at or above where it stood when the step was made. That is a question about
  // the window's best exposure, not about its last one. Reading `points.at(-1)` made a
  // planned deload landing as the final session of the window look like a regression:
  // an easy last day flipped the verdict to not_aligned, which both eased the
  // progression step and filed a "that change hasn't landed" note about a change that
  // had in fact worked. `last_est_1rm` is kept beside it as provenance.
  const best = points.length ? Math.max(...points.map((point) => point.value)) : null;
  const delta = first != null && best != null ? rounded(best - first) : null;
  // WHAT VERIFICATION CHANGES HERE, AND WHAT IT DELIBERATELY DOES NOT.
  //
  // It does not move the verdict. The tempting version of this — letting a
  // marginal miss off an unverified baseline stay inconclusive — is wrong twice
  // over. The hold expectation's target is ALREADY `baseline * 0.97`: the 3%
  // Epley-noise allowance has been subtracted once, at write time, and
  // subtracting a second one here would quietly double the tolerance the writer
  // chose and turn a real regression into silence. And the caution it was
  // reaching for already exists in the right place — `estimateConfidenceFor`
  // hands the same fact to the progression DECISION, which prefers
  // hold-plus-test over an automatic deload on an unverified lift. Spending one
  // pattern on two levers is the double-count this module refuses elsewhere.
  //
  // So the root fix lives at write time (buildLiftProgressionExpectations rebases
  // the baseline onto a verified top set when one exists, so the claim is made
  // against a number the athlete actually stood under), and what belongs HERE is
  // provenance: the verdict records whether it was measured against a confirmed
  // number, and a confirming set is carried as an evidence row in its own right —
  // the single strongest piece of evidence behind any claim about a lift's
  // ceiling, and the thing that makes a stored evaluation still readable years
  // later as "this was measured" rather than "this was extrapolated".
  const verification = est1rmVerification(context);
  const comparison = est1rmAliasComparison(expectation, best);

  return {
    actual:
      delta == null
        ? null
        : {
            value: rounded(best!),
            delta,
            first_est_1rm: rounded(first!),
            best_est_1rm: rounded(best!),
            last_est_1rm: rounded(last!),
            exposures: points.length,
            // Provenance on the verdict itself, so a stored evaluation can still be
            // read back years later as "this was measured against a confirmed
            // number" or "this was formula against formula".
            estimate_verified: verification.verified,
            estimate_verified_on: verification.verified_on,
            estimate_basis: verification.basis,
            ...exclusionFields(read),
          },
    evidence_keys: [
      ...stableEvidence("logged_sets", read.rows, expectation.window_start, windowEnd(context)),
      // The heavy set is evidence in its own right — the single strongest row
      // behind a verdict about a lift's ceiling.
      ...(verification.verified && verification.verified_on
        ? [`calibration_events:strength_topset:${expectation.subject_key ?? "-"}:${verification.verified_on}`]
        : []),
    ],
    counts: {
      exposures: points.length,
      data_points: points.length,
      verified_exposures: verification.verified ? 1 : 0,
      context_excluded_exposures: read.excluded_exposures,
    },
    issues: [
      ...(read.issue ? [read.issue] : []),
      ...(points.length < 2 ? ["At least two comparable loaded exercise exposures are needed."] : []),
      ...exclusionIssues(read),
      ...(read.ids.length && changeMovedLift(context, read.ids) === false ? [INCONCLUSIVE_REASON_TEXT.no_change] : []),
    ],
    ...(comparison ? { comparison } : {}),
  };
}

interface SessionFeedbackRow {
  id: number;
  date: string;
  done_at: string | null;
  performance: number | null;
  soreness: number | null;
  joint_pain: string | null;
}

// Sessions a session-level safety floor reads, with the days a material context event
// covered set aside (see ContextExclusion) — a trip's hotel-gym session or a session
// inside an injury says nothing clean about whether the CHANGE moved how training
// felt, but every session outside it still does.
function sessionFeedbackRows(context: EvaluatorContext): ContextFiltered<SessionFeedbackRow> {
  const ids = exerciseIds(context.expectation.subject_key);
  if (!ids.length) {
    const rows = db
      .prepare(
        `SELECT s.id, s.date, s.performance, s.soreness, s.joint_pain, COALESCE(s.finished_at, s.created_at) AS done_at
         FROM sessions s WHERE s.date BETWEEN ? AND ?
        ORDER BY s.date, s.id LIMIT 500`
      )
      .all(context.expectation.window_start, windowEnd(context)) as unknown as SessionFeedbackRow[];
    return withoutContextDays(context, rows);
  }
  const rows = db
    .prepare(
      `SELECT s.id, s.date, s.performance, s.soreness, s.joint_pain, COALESCE(s.finished_at, s.created_at) AS done_at
       FROM sessions s WHERE s.date BETWEEN ? AND ?
        AND EXISTS (SELECT 1 FROM logged_sets ls WHERE ls.session_id = s.id
                     AND ls.exercise_id IN (${ids.map(() => "?").join(", ")}))
      ORDER BY s.date, s.id LIMIT 500`
    )
    .all(context.expectation.window_start, windowEnd(context), ...ids) as unknown as SessionFeedbackRow[];
  return withoutContextDays(context, rows);
}

function performanceObservation(context: EvaluatorContext): MetricObservation {
  const read = sessionFeedbackRows(context);
  const rows = read.rows.filter((row) => finite(row.performance) != null);
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
      average == null
        ? null
        : {
            value: average,
            average_rating: average,
            delta: delta ?? 0,
            exposures: rows.length,
            ...exclusionFields(read),
          },
    evidence_keys: stableEvidence("sessions", rows, context.expectation.window_start, windowEnd(context)),
    counts: {
      exposures: rows.length,
      sessions: rows.length,
      data_points: rows.length,
      context_excluded_exposures: read.excluded_exposures,
    },
    issues: [
      ...(rows.length ? [] : ["No session performance feedback was recorded in the evaluation window."]),
      ...exclusionIssues(read),
    ],
  };
}

// What a pain guard's target may say, as a COUNT of stated pain occasions. The guard
// writer stores `{ max: N }`; an agent-authored guard often says something a report
// count cannot measure — a severity ("max_level: mild"), a soreness scale ("unit:
// scale_1_to_5"), a condition ("flank_pain_on_squat_session: none"). The generic
// comparison used to read whatever number it found there as a report count, so a
// 1-5 soreness ceiling of 2 passed a window with a real pain report in it, and "no
// progression beyond mild" failed on a report nobody had graded. Any key outside this
// closed vocabulary makes the target unjudgeable by this evaluator — both ways.
const PAIN_COUNT_KEYS = ["max", "maximum", "max_value"];
const PAIN_COUNT_ALIASES = [
  "joint_pain_episodes",
  "pain_days",
  "tolerable_pain_days",
  "pain_sessions",
  "pain_reports",
  "max_pain_reports",
  "occurrences",
  "max_occurrences",
];
const PAIN_ANNOTATION_KEYS = new Set(["meaning", "note", "basis"]);
const TARGET_UNCOMPARABLE = "The stored target could not be compared deterministically without guessing.";

function painGuardThreshold(expectation: BrainExpectation): number | null {
  if (!["avoid", "at_most"].includes(expectation.direction)) return null;
  const target = expectation.target ?? {};
  const countKeys = [
    ...PAIN_COUNT_KEYS,
    ...(expectation.direction === "avoid" ? ["value", "target"] : []),
    ...PAIN_COUNT_ALIASES,
  ];
  if (Object.keys(target).some((key) => !countKeys.includes(key) && !PAIN_ANNOTATION_KEYS.has(key))) return null;
  for (const key of countKeys) {
    const value = finite(target[key]);
    if (value != null) return value;
  }
  // `avoid` with no number is "none at all" — compareExpectation's own default.
  return expectation.direction === "avoid" ? 0 : null;
}

// "Joint pain does not become more frequent." The OUTCOME is a stated pain — read
// from where pain is reported now (statedPainOccasions: the verbatim reports plus the
// legacy session box), never from the retired box alone, which made every window read
// as pain-free. Three deliberate rules:
//   • A context event never sets a pain report aside. An injury overlapping the window
//     is not a confounder of a pain guard — it IS the outcome — and the old window-level
//     rule silenced exactly the windows where pain happened, so the guard could only
//     ever pass. Context still sets aside SESSIONS (the exposure floor), as for every
//     exposure-scoped metric.
//   • A report made before the change landed is not about it.
//   • A pain the evaluator cannot place against the subject (attributePain → unknown)
//     can still FAIL the claim when the attributable count is already over the bar, but
//     can never let it PASS: "no pain here" is not readable beside a pain we can't place.
function symptomObservation(context: EvaluatorContext): MetricObservation {
  const { expectation } = context;
  const read = sessionFeedbackRows(context);
  const allRows = read.rows;
  const ids = exerciseIds(expectation.subject_key);
  const exercise = ids.length
    ? ((db.prepare(`SELECT name, muscle_group FROM exercises WHERE id = ?`).get(ids[0]) as
        | { name: string; muscle_group: string | null }
        | undefined) ?? null)
    : null;
  const subject = {
    exercise: exercise ? { name: String(exercise.name), muscle_group: exercise.muscle_group ?? null } : null,
    area: exercise ? null : (expectation.subject_key ?? "").trim() || null,
  };
  const landed = stampMs(context.decision?.applied_at) ?? stampMs(context.decision?.created_at);
  const occasions = statedPainOccasions(expectation.window_start, windowEnd(context)).filter((occasion) => {
    const said = stampMs(occasion.reported_at);
    return landed == null || said == null || said > landed;
  });
  const attributed = occasions.filter((occasion) => attributePain(occasion, subject) === "attributed");
  const unplaced = occasions.filter((occasion) => attributePain(occasion, subject) === "unknown");
  const painReports = attributed.length;
  const rows = allRows.filter((row) => row.soreness != null || !!row.joint_pain);
  const soreness = rows.map((row) => finite(row.soreness)).filter((value): value is number => value != null);
  const average = soreness.length ? rounded(soreness.reduce((sum, value) => sum + value, 0) / soreness.length) : null;
  const sessionIds = new Set(rows.map((row) => Number(row.id)));
  // A stated pain is feedback in its own right; one not already on a counted session adds an entry.
  const feedbackEntries =
    rows.length + attributed.filter((o) => o.session_id == null || !sessionIds.has(o.session_id)).length;
  const threshold = painGuardThreshold(expectation);
  const comparison: MetricObservation["comparison"] =
    threshold == null
      ? { aligned: null, reason: TARGET_UNCOMPARABLE }
      : painReports > threshold
        ? { aligned: false }
        : unplaced.length
          ? {
              aligned: null,
              reason: `${INCONCLUSIVE_REASON_TEXT.unplaced_pain} (${unplaced
                .map((o) => o.date)
                .slice(0, 4)
                .join(", ")})`,
            }
          : { aligned: true };
  return {
    actual: {
      value: painReports,
      occurrences: painReports,
      joint_pain_reports: painReports,
      unplaced_pain_reports: unplaced.length,
      average_soreness: average ?? 0,
      exposures: allRows.length,
      ...exclusionFields(read),
    },
    evidence_keys: [
      ...stableEvidence("sessions", allRows, expectation.window_start, windowEnd(context)),
      ...(attributed.length
        ? [`symptom_reports:${expectation.window_start}..${windowEnd(context)}:pain_occasions=${attributed.length}`]
        : []),
    ],
    counts: {
      exposures: allRows.length,
      sessions: allRows.length,
      feedback_entries: feedbackEntries,
      data_points: feedbackEntries,
      context_excluded_exposures: read.excluded_exposures,
    },
    issues: [
      ...(allRows.length || read.excluded_exposures
        ? []
        : ["The affected movement or session was not exposed during the evaluation window."]),
      ...exclusionIssues(read),
    ],
    ...(comparison ? { comparison } : {}),
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

// Did the MORNING READ's call hold? The one same-day metric in the registry, and the
// only one that can mature overnight.
//
// The verdict judges the READ, never the athlete (dayReadCall, day-read-call.ts):
// `aligned` when the call held — followed, or a quiet read trained through that the
// harm test says the day did need — and `not_aligned` only when the read was off: more
// cautious than a day that went fine (calibration evidence the softening ladders act
// on), or a train read on a day the athlete kept quiet. The behavioural fact (followed
// / diverged) still rides on `actual.followed` for the rolling counts.
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
//   • A train read is held by ANY logged training. A session shaped live — other
//     exercises, other loads, extra or fewer sets, a skipped slot — is the athlete
//     working with the read, never a miss of it.
//   • Adherence is a COUNT of days, never a rate and never a grade.
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
  // The morning read's own signals ride in: they say whether that morning's run engine
  // had already eased a stated quality session (the own-dose read, dayTrainingTruth).
  const morningSignals = (context.decision?.context as Record<string, unknown> | null | undefined)?.signals as unknown;
  const truth = dayTrainingTruth(readDate, {
    morningSignals:
      morningSignals && typeof morningSignals === "object" ? (morningSignals as Record<string, unknown>) : null,
  });
  const outcome = readAdherenceOutcome(readKind, truth);
  // The SAME harm verdict the softening ladders read, so the verdict and the ladders
  // cannot disagree about which quiet mornings were trained through harmlessly — and
  // an UNMEASURED day is `unknown` there and `unclear` here, never "no harm".
  const harmVerdict = dayReadCallNeedsHarm(readKind, outcome) ? harmVerdictOnDay(readDate) : null;
  const harm = harmVerdict?.evidence ?? null;
  const call = dayReadCall(readKind, outcome, harm, harmVerdict?.status === "unknown");
  const readOff = dayReadCallWasOff(call) ? 1 : 0;
  const actual: JsonObject = {
    // `value` serves the `at_least` train comparison; `occurrences` serves the
    // `avoid` rest/easy one (compareExpectation reads occurrences first there) and
    // counts the READ being more cautious than the day needed — not the athlete
    // training through it, which a cost afterwards can vindicate.
    value: readKind === "train" ? (truth.trained ? 1 : 0) : readOff,
    occurrences: readOff,
    read_kind: readKind,
    // What the verdict measures (the read's call), and the behavioural test beside it,
    // both in plain words and stored ON the verdict so a followed `train` day can never
    // be read back later as a hard one, nor a harmless day past a quiet read as a miss.
    measures: DAY_READ_CALL_MEASURES[readKind],
    behaviour_measures: READ_ADHERENCE_MEASURES[readKind],
    followed: outcome === "followed",
    read_call: call,
    // Machine register — which harm arm fired, if any. Only asked for a quiet read the
    // day went past; null everywhere else.
    harm_kind: harm?.kind ?? null,
    harm_detail: harm?.detail ?? null,
    // harm / clean / unknown, and which morning answered (24h / 48h / same_day) — null
    // when the harm test was not asked.
    harm_status: harmVerdict?.status ?? null,
    harm_window: harmVerdict?.window ?? null,
    // The stated week's own dose that kept a loading day inside an easy read (ownDoseOn).
    own_dose: truth.own_dose ? truth.own_dose.kinds : null,
    // Which era of this metric wrote the verdict (read-adherence.ts) — legacy v1 rows
    // judged behaviour and carry neither field.
    evaluator_era: DAY_READ_JUDGED_ERA,
    day_read_evaluator: DAY_READ_ADHERENCE_EVALUATOR_VERSION,
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
      `day_read_adherence:${readDate}:read=${readKind}:sets=${truth.sets}:activities=${truth.real_activities}/${truth.activities}:load=${truth.load}:call=${call}`,
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
        : call === "unclear"
          ? ["Nothing after the day showed how the body took it, so whether the read was too cautious can't be read."]
          : [],
    ...(call !== "unclear" ? { verdict_explanation: DAY_READ_CALL_EXPLANATION[call] } : {}),
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
  const rawRows = db
    .prepare(
      `SELECT id, date, type, source, external_id, distance_km FROM activities
      WHERE date BETWEEN ? AND ? ORDER BY date, id LIMIT 500`
    )
    .all(expectation.window_start, end) as Array<{
    id: number;
    date: string;
    type: string;
    source: string | null;
    external_id: string | null;
    distance_km: number | null;
  }>;
  // A hand-logged shadow of a synced run is one outing, not two, toward the week's
  // measured mileage.
  const rows = withoutShadowActivities(rawRows);
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
  // UNCAPPED on purpose — unlike the session-count rates above, which clamp at 1
  // because you cannot complete more sessions than were planned. Mileage you can:
  // running 9.1 km against a prescribed 4.9 reads 1.86, and that overshoot is the
  // single clearest signal the prescription sat under the athlete's capacity. Clamped
  // to 1 it would be indistinguishable from a week that landed exactly on target, and
  // the learning model downstream (reaction-model's run-volume acceleration) would
  // have nothing to read. The verdict bar is unchanged either way — compareExpectation
  // only asks whether the rate cleared the target.
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
      `SELECT id, date, sleep_min, resting_hr, hrv_ms, updated_at FROM garmin_daily_metrics
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
  // `baseline_average` is the FIRST HALF OF THIS WINDOW, not the expectation's own
  // pre-change baseline — this evaluator is a within-window drift read and never opens
  // `expectation.baseline`. The writers that size their tolerance off a trailing
  // average (buildHrvGuardExpectation) say so in their own docs; the name here is kept
  // because it is the shape stored on every historical evaluation row.
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
  // One reading per day (dailySiteSeries): a same-day re-tape supersedes the earlier value.
  const rows = dailySiteSeries(site, { since: expectation.window_start, through: windowEnd(context) }).slice(0, 500);
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
  // The judge-the-read era carries its own version on the evaluation row
  // (read-adherence.ts DAY_READ_ADHERENCE_EVALUATOR_VERSION), so a v2 verdict is told
  // from a legacy behavioural one by the column alone.
  day_read_adherence: Object.freeze({
    ...entry("day_read_adherence", "day_read_adherence", dayReadAdherenceObservation),
    version: `${MATURITY_EVALUATOR_VERSION}/day_read_adherence@${DAY_READ_ADHERENCE_EVALUATOR_VERSION}`,
  }),
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

// A minimum-data rule this evaluator can genuinely check, and one it cannot.
//
// A SHORTFALL is a real confounder: the window did not hold the evidence the
// expectation asked for, so no verdict off it would be honest. An UNRECOGNIZED rule is
// not — it is a rule that was never applied to anything, and treating it as a
// confounder silenced 21 live expectations permanently, on key names no evaluator has
// ever emitted. Write-time normalization (normalizeMinimumData in
// expectation-contract.ts) drops those before they are stored; anything already on
// disk degrades to an ignored note here instead of a reason to distrust the data.
export function minimumDataIssues(expectation: BrainExpectation, observation: MetricObservation): string[] {
  if (!expectation.minimum_data) return [];
  const issues: string[] = [];
  for (const [rawKey, rawRequired] of Object.entries(expectation.minimum_data)) {
    const required = finite(rawRequired);
    if (required == null) continue;
    const key = canonicalMinimumDataKey(rawKey);
    if (key == null) continue;
    const actual = observation.counts[key];
    if (actual == null) continue;
    if (actual < required) {
      issues.push(`Only ${actual} ${key.replaceAll("_", " ")} were available; ${required} were required.`);
    }
  }
  return issues;
}

// The rules that were skipped, named — so an ignored rule still shows up on the
// verdict it did not get to shape.
export function ignoredMinimumDataRules(expectation: BrainExpectation, observation: MetricObservation): string[] {
  if (!expectation.minimum_data) return [];
  const ignored: string[] = [];
  for (const rawKey of Object.keys(expectation.minimum_data)) {
    const key = canonicalMinimumDataKey(rawKey);
    if (key == null || observation.counts[key] == null) ignored.push(String(rawKey).slice(0, 60));
  }
  return [...new Set(ignored)];
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
    const aligned = observation.comparison
      ? observation.comparison.aligned
      : compareExpectation(expectation, observation.actual);
    if (aligned == null) {
      allConfounders.push(
        observation.comparison?.reason ?? "The stored target could not be compared deterministically without guessing."
      );
    } else if (observation.evidence_keys.length === 0) {
      // The evaluation contract refuses a decisive verdict without evidence, so
      // an evidence-free comparison must stay inconclusive rather than throw at insert.
      allConfounders.push("No supporting evidence rows existed in the evaluation window.");
    } else {
      verdict = aligned ? "aligned" : "not_aligned";
      explanation =
        observation.verdict_explanation ??
        (aligned
          ? "The observed result landed within the expectation after enough comparable data was available."
          : "The observed result did not land within the expectation after enough comparable data was available.");
    }
  }
  const ignored = ignoredMinimumDataRules(expectation, observation);
  if (ignored.length) {
    explanation = `${explanation} Ignored unsupported minimum-data rule${ignored.length > 1 ? "s" : ""}: ${ignored.join(", ")}.`;
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
