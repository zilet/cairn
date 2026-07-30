import crypto from "node:crypto";
import { db, todayISO } from "../db.js";
import type { ProposedExpectation } from "../brain/expectation-contract.js";
import { emitBrainEvent as queueBrainEvent } from "../brainEvents.js";
import { emitEnrichTransition } from "../enrichBus.js";
import { recordDecision } from "./brain-decisions.js";
import { markerInterventionRecording } from "./marker-response.js";
import { invalidateDayRead } from "./day-read.js";
import { estimateExpenditure } from "./expenditure.js";
import { newestHealthDocDate } from "./health.js";
import { computeGoalCheck, recompositionStageAt } from "./profile.js";
import {
  assertMealDietarySafe,
  assertMealAllergenSafe,
  assertPlanDietarySafe,
  assertPlanAllergenSafe,
  assertRecipeDietarySafe,
  assertRecipeAllergenSafe,
  assessMealPlanAdequacy,
  canonicalAllergyKeys,
  clampNutritionFloors,
  MEAL_PLAN_FIBER_FLOOR_G,
} from "./nutrition-safety.js";
import { getSettings } from "./settings.js";
import { completedIntakeRange } from "./intake-window.js";
import { canonicalHardDietKeys, mealPlanHardDietKeys, stampInstructionHardDiets } from "./dietary-constraints.js";
import {
  localDateISO,
  chatHistoryTimeLabel,
  daysBetweenISO,
  normalizeWallClock,
  clockLabel,
  mealLabelForTime,
  approxTimeForMealLabel,
} from "./shared.js";
import { afterSqliteCommit, withSqliteSavepoint } from "./sqlite-savepoint.js";
import { bumpFoodDataVersion } from "./training-cache.js";
import { nutritionRelevantDirectives } from "./nutrition-progress.js";

// ---------- accepted nutrition targets (adaptive-nutrition loop OUTPUT) ----------
// Persist an accepted target so the fuel card / goal math / next check-in read the
// ACCEPTED number, not a re-derived formula each time. History is kept; the active
// target is the newest row effective on/before the given date.
export interface AcceptedNutritionTarget {
  id: number;
  effective_date: string;
  target_kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  source: string | null;
  note: string | null;
  created_at?: string | null;
  age_days?: number;
  freshness?: "fresh" | "review_due" | "explicit";
  review_due?: boolean;
}

const ADAPTIVE_TARGET_REVIEW_DAYS = 42;

function emitBrainEvent(value: unknown): void {
  afterSqliteCommit(() => queueBrainEvent(value));
}

export function hydrateNutritionTarget(row: any, referenceDate = localDateISO()): AcceptedNutritionTarget | null {
  if (!row) return null;
  const source = String(row.source ?? "");
  const explicit = ["manual", "direct", "user", "chat"].includes(source);
  const ageDays = Math.max(
    0,
    Math.round((Date.parse(`${referenceDate}T00:00:00Z`) - Date.parse(`${row.effective_date}T00:00:00Z`)) / 86_400_000)
  );
  const reviewDue = !explicit && Number.isFinite(ageDays) && ageDays > ADAPTIVE_TARGET_REVIEW_DAYS;
  return {
    id: row.id,
    effective_date: row.effective_date,
    target_kcal: row.target_kcal,
    protein_g: row.protein_g,
    carbs_g: row.carbs_g,
    fat_g: row.fat_g,
    source: row.source,
    note: row.note,
    created_at: row.created_at ?? null,
    age_days: Number.isFinite(ageDays) ? ageDays : 0,
    freshness: explicit ? "explicit" : reviewDue ? "review_due" : "fresh",
    review_due: reviewDue,
  };
}

function nutritionTrendExpectation(
  targetKcal: number,
  effectiveDate: string,
  metric: "weight_trend_lb_wk" | "intake_to_weight_response" = "intake_to_weight_response",
  opts: { targetDeltaKcal?: number | null } = {}
): { expectation: ProposedExpectation; basis: string } {
  let expectedTrend = 0;
  let tolerance = 0.75;
  let basis = "cold_start_broad_band";
  try {
    const estimate = estimateExpenditure(21);
    if ((estimate.confidence === "medium" || estimate.confidence === "high") && estimate.tdee != null) {
      expectedTrend = ((targetKcal - estimate.tdee) * 7) / 3_500;
      tolerance = 0.35;
      basis = "measured_expenditure";
    } else {
      const goal = computeGoalCheck();
      if (goal?.ok) {
        const rate = Number(goal.recommended?.weekly_rate_lb) || 0;
        expectedTrend = goal.goal_mode === "lose" ? -rate : goal.goal_mode === "gain" ? rate : 0;
        tolerance = 0.5;
        basis = "goal_formula";
      }
    }
  } catch {
    // A cold start still gets a falsifiable, deliberately broad expectation.
    // Minimum-data rules make it inconclusive until enough logs arrive.
  }
  const stage = recompositionStageAt(effectiveDate).kind;
  return {
    basis,
    expectation: {
      metric_key: metric,
      subject_key: null,
      direction: "within_band",
      baseline: {
        target_kcal: targetKcal,
        target_delta_kcal: Number.isFinite(Number(opts.targetDeltaKcal))
          ? Math.round(Number(opts.targetDeltaKcal))
          : null,
        predicted_trend_lb_wk: Math.round(expectedTrend * 100) / 100,
        recomposition_stage: stage,
        basis,
      },
      target: {
        min: Math.round((expectedTrend - tolerance) * 100) / 100,
        max: Math.round((expectedTrend + tolerance) * 100) / 100,
      },
      window_start: effectiveDate,
      window_end: addDaysISO(effectiveDate, 28),
      minimum_data: metric === "intake_to_weight_response" ? { weigh_ins: 6, intake_days: 10 } : { weigh_ins: 6 },
      confounder_policy: "exclude_context_events",
      confidence: "tentative",
      evaluator: metric === "intake_to_weight_response" ? "intake_response" : "weight_trend",
      evaluator_version:
        metric === "intake_to_weight_response" ? "nutrition-intake-response-v2" : "nutrition-weight-v2",
    },
  };
}

// ---------- the composition half of a nutrition-target change ----------
// The weight lever answers "did the scale move as predicted"; it cannot tell a lost
// pound of fat from a lost pound of lean mass. Waist tape can, and the evaluator for
// `body_measurement_direction` has been registered (brain/evaluators.ts) with nothing
// ever writing it — so the reaction model's body-measurement branch, which is already
// built to stage composition evidence per recomposition phase, could never fire.
//
// THE HONESTY RULE governs whether the prediction is written at all: a prediction is
// only made when the evidence that could FALSIFY it is already being logged. Tape is
// rare — most target changes will correctly write nothing here, and that silence is
// the feature. Two readings in the trailing 60 days is the evidence that tape is
// flowing at all; the expectation then asks for that same cadence to continue, since
// `minimum_data` requires TWO readings inside its own 56-day window before the
// prediction is allowed to mature into a verdict.
const WAIST_FLOW_WINDOW_DAYS = 60;
const WAIST_FLOW_MIN_READINGS = 2;
// Home tape measurement varies by roughly a quarter-inch between honest readings of an
// unchanged waist. The band is deliberately wider than that noise, so "not increasing"
// means a real increase, never a re-measure.
const WAIST_TAPE_NOISE_IN = 0.5;
// Eight weeks, not the weight lever's four: tape moves on a slower clock and is logged
// far less often, so a four-week window would mature into `inconclusive` most times.
const WAIST_WINDOW_DAYS = 56;
// Below this the target isn't asking the body to lose anything, so "the waist should
// not increase" is not a claim the change actually makes.
const CUT_TREND_FLOOR_LB_WK = -0.15;

// The latest waist reading, but ONLY when tape is genuinely flowing. Null (write no
// prediction) whenever it is not.
function flowingWaistTape(effectiveDate: string): { value: number; date: string } | null {
  try {
    const since = addDaysISO(effectiveDate, -WAIST_FLOW_WINDOW_DAYS);
    const rows = db
      .prepare(
        `SELECT date, waist_in AS value FROM body_measurements
          WHERE date BETWEEN ? AND ? AND waist_in IS NOT NULL
          ORDER BY date DESC, id DESC LIMIT 20`
      )
      .all(since, effectiveDate) as Array<{ date: string; value: number }>;
    if (rows.length < WAIST_FLOW_MIN_READINGS) return null;
    const value = Number(rows[0]?.value);
    if (!Number.isFinite(value) || value <= 0) return null;
    return { value, date: String(rows[0].date) };
  } catch {
    // No tape table on an older ladder position is simply "no evidence flowing".
    return null;
  }
}

// The composition expectation attached to a nutrition-target change, or null.
//
// Shaped to what `bodyMeasurementObservation` really computes: it reports the LATEST
// reading as `actual.value` and counts rows as `measurements`, so the falsifiable claim
// is an absolute ceiling on the waist (`at_most` + `target.max`), not an invented rate.
// `recomposition_stage` rides in `baseline` because that is where reaction-model's
// `outcomeStage` reads it from — without it the learning would pool a mid-cut outcome
// with a lean-gain one.
//
// DELIBERATELY CUT-ONLY. A deficit makes one unambiguous composition claim: the waist
// should not go up. A surplus does not — some waist gain is expected in a lean gain and
// nothing here knows how much, so predicting a ceiling would be inventing a number the
// evidence cannot settle. Maintenance is the same story in miniature. Both correctly
// write nothing.
function bodyMeasurementExpectation(
  effectiveDate: string,
  predictedTrendLbWk: number | null,
  stage: string | null
): ProposedExpectation | null {
  if (predictedTrendLbWk == null || !Number.isFinite(predictedTrendLbWk)) return null;
  if (predictedTrendLbWk > CUT_TREND_FLOOR_LB_WK) return null;
  const tape = flowingWaistTape(effectiveDate);
  if (!tape) return null;
  const round1 = (value: number) => Math.round(value * 10) / 10;
  return {
    metric_key: "body_measurement_direction",
    subject_key: "waist_in",
    direction: "at_most",
    baseline: {
      value: round1(tape.value),
      baseline_date: tape.date,
      recomposition_stage: stage ?? "unknown",
      predicted_trend_lb_wk: predictedTrendLbWk,
    },
    target: { max: round1(tape.value + WAIST_TAPE_NOISE_IN) },
    window_start: effectiveDate,
    window_end: addDaysISO(effectiveDate, WAIST_WINDOW_DAYS),
    minimum_data: { measurements: WAIST_FLOW_MIN_READINGS },
    confounder_policy: "exclude_context_events",
    confidence: "tentative",
    evaluator: "body_measurement_direction",
    evaluator_version: "nutrition-body-measurement-v1",
  };
}

function previousNutritionTargetKcal(saved: AcceptedNutritionTarget): number | null {
  const row = db
    .prepare(
      `SELECT target_kcal FROM nutrition_targets
        WHERE id <> ? AND effective_date <= ? AND target_kcal IS NOT NULL
        ORDER BY effective_date DESC, id DESC LIMIT 1`
    )
    .get(saved.id, saved.effective_date) as any;
  const value = Number(row?.target_kcal);
  return Number.isFinite(value) ? value : null;
}

function recordNutritionTargetDecision(saved: AcceptedNutritionTarget): void {
  try {
    const previousKcal = previousNutritionTargetKcal(saved);
    const response =
      saved.target_kcal != null
        ? nutritionTrendExpectation(saved.target_kcal, saved.effective_date, "intake_to_weight_response", {
            targetDeltaKcal: previousKcal == null ? null : saved.target_kcal - previousKcal,
          })
        : null;
    const stage = response?.expectation.baseline?.recomposition_stage ?? null;
    // The composition half of the same change, when — and only when — tape is flowing.
    const predictedTrend = Number(response?.expectation.baseline?.predicted_trend_lb_wk);
    const body = response
      ? bodyMeasurementExpectation(
          saved.effective_date,
          Number.isFinite(predictedTrend) ? predictedTrend : null,
          stage == null ? null : String(stage)
        )
      : null;
    recordDecision(
      {
        effective_date: saved.effective_date,
        kind: "nutrition_target",
        domain: "nutrition",
        summary: "Nutrition target updated.",
        rationale: saved.note,
        source: saved.source || "direct",
        source_ref_type: "nutrition_target",
        source_ref_key: String(saved.id),
        status: "applied",
        autonomy_tier: "ask",
        risk_class: "low",
        reversible: false,
        input_fingerprint: null,
        context: {
          expectation_basis: response?.basis ?? "protein_only_no_supported_evaluator",
          recomposition_stage: stage,
        },
        action: {
          target_kcal: saved.target_kcal,
          protein_g: saved.protein_g,
          carbs_g: saved.carbs_g,
          fat_g: saved.fat_g,
        },
        specialist: null,
        applied_at: new Date().toISOString(),
        reverted_at: null,
        superseded_by: null,
        evaluator_version: response?.expectation.evaluator_version ?? null,
      },
      [response?.expectation, body].filter((item): item is ProposedExpectation => !!item)
    );
  } catch {
    // The durable target is authoritative; accountability telemetry is fail-soft.
  }
}

export function setNutritionTarget(
  input: {
    target_kcal?: number | null;
    protein_g?: number | null;
    carbs_g?: number | null;
    fat_g?: number | null;
    source?: string | null;
    note?: string | null;
    effective_date?: string | null;
  },
  opts: { recordDecision?: boolean; preserveReviewedKcal?: boolean } = {}
): AcceptedNutritionTarget | null {
  let goal: any = null;
  try {
    goal = computeGoalCheck();
  } catch {
    goal = null;
  }
  const safeInput = clampNutritionFloors(input, { kcal: "target_kcal", protein: "protein_g" }, goal);
  // A proposal already crossed the personalized/safety boundary at creation.
  // Re-running volatile expenditure math at apply time would silently change
  // the reviewed action. Preserve that reviewed kcal (absolute floor remains),
  // while the current protein safety floor still applies.
  if (opts.preserveReviewedKcal) {
    const reviewed = Number(input.target_kcal);
    if (Number.isFinite(reviewed)) safeInput.target_kcal = Math.max(1500, Math.round(reviewed));
  }
  const eff =
    safeInput.effective_date && /^\d{4}-\d{2}-\d{2}$/.test(safeInput.effective_date)
      ? safeInput.effective_date
      : localDateISO();
  const int = (v: any, max: number): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : null;
  };
  const kcal = int(safeInput.target_kcal, 10000);
  const protein = int(safeInput.protein_g, 500);
  // Nothing usable → don't persist an empty target row.
  if (kcal == null && protein == null) return null;
  const info = db
    .prepare(
      `INSERT INTO nutrition_targets (effective_date, target_kcal, protein_g, carbs_g, fat_g, source, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      eff,
      kcal,
      protein,
      int(safeInput.carbs_g, 2000),
      int(safeInput.fat_g, 1000),
      safeInput.source ? String(safeInput.source).slice(0, 40) : null,
      safeInput.note ? capStr(safeInput.note, 300) : null
    );
  const saved = getNutritionTarget(Number(info.lastInsertRowid));
  if (saved) {
    if (opts.recordDecision !== false) recordNutritionTargetDecision(saved);
    emitBrainEvent({ kind: "nutrition_target_changed", domain: "nutrition", date: eff, entity_id: saved.id });
  }
  return saved;
}

export function getNutritionTarget(id: number): AcceptedNutritionTarget | null {
  const row = db.prepare(`SELECT * FROM nutrition_targets WHERE id = ?`).get(id) as any;
  return hydrateNutritionTarget(row);
}

export function deleteNutritionTarget(id: number): boolean {
  const numeric = Math.trunc(Number(id));
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  const changed = Number(db.prepare(`DELETE FROM nutrition_targets WHERE id = ?`).run(numeric).changes) > 0;
  if (changed)
    emitBrainEvent({ kind: "nutrition_target_changed", domain: "nutrition", date: localDateISO(), entity_id: numeric });
  return changed;
}

// The active accepted target: the newest row effective on/before `date` (today).
// Null when nothing has been accepted yet → callers fall back to the formula.
export function getActiveNutritionTarget(date?: string): AcceptedNutritionTarget | null {
  const target = getLatestNutritionTarget(date);
  return target?.review_due ? null : target;
}

// Latest historical target, including an adaptive target whose six-week review
// window elapsed. Goal/prompt code uses this to explain why formula fallback is
// active without allowing stale automation to control intake indefinitely.
export function getLatestNutritionTarget(date?: string): AcceptedNutritionTarget | null {
  const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDateISO();
  const row = db
    .prepare(`SELECT * FROM nutrition_targets WHERE effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 1`)
    .get(d) as any;
  const target = hydrateNutritionTarget(row, d);
  return target;
}

// ---------- meal plans ----------
// The newest upstream source (a health directive / lab / weigh-in) a nutrition
// artifact should reflect. Stamped onto a meal plan at draft time; if the CURRENT max
// later exceeds the stamp, the plan is "outrun" (worth re-drafting). Mirrors the
// health-synthesis staleness pattern (source_doc_at vs newestHealthDocDate). Null-safe.
export function maxUpstreamNutritionSource(): string | null {
  const cands: string[] = [];
  try {
    const d = db
      .prepare(
        `SELECT MAX(trigger_date) AS d FROM health_directives WHERE status = 'active' AND (domain = 'nutrition' OR domain = 'watch')`
      )
      .get() as any;
    if (d?.d) cands.push(String(d.d).slice(0, 10));
  } catch {
    /* table may lag on an old DB */
  }
  try {
    const doc = newestHealthDocDate();
    if (doc) cands.push(String(doc).slice(0, 10));
  } catch {
    /* ignore */
  }
  try {
    const w = db.prepare(`SELECT MAX(date) AS d FROM bodyweight_log`).get() as any;
    if (w?.d) cands.push(String(w.d).slice(0, 10));
  } catch {
    /* ignore */
  }
  try {
    const target = db.prepare(`SELECT MAX(effective_date) AS d FROM nutrition_targets`).get() as any;
    if (target?.d) cands.push(String(target.d).slice(0, 10));
  } catch {
    /* ignore */
  }
  return cands.length ? cands.sort().at(-1)! : null;
}

// SQLite `datetime('now')` timestamps are "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker).
function parseNutritionSqliteTs(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!raw) return Number.NaN;
  return Date.parse(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
}

// Same-day boundary guard: the day-granular compare below misses a nutrition/watch
// directive derived intra-day AFTER this plan was drafted (both share the plan's
// date, so `now <= stamped` reads not-stale). Fall to a finer instant comparison for
// exactly that case — a directive whose creation instant postdates the plan's.
function newerNutritionDirectiveThanPlan(plan: any): boolean {
  const planMs = parseNutritionSqliteTs(plan?.created_at);
  if (!Number.isFinite(planMs)) return false;
  try {
    const row = db
      .prepare(
        `SELECT MAX(created_at) AS c FROM health_directives
          WHERE status = 'active' AND (domain = 'nutrition' OR domain = 'watch')`
      )
      .get() as any;
    const dirMs = parseNutritionSqliteTs(row?.c);
    return Number.isFinite(dirMs) && dirMs > planMs;
  } catch {
    return false;
  }
}

// A stable athlete generates no newer upstream signal for months, so the upstream
// checks below never fire — a plan can go quietly stale from calendar age alone with
// nothing to compare it against. 21 days is a full three-week cycle past the weekly
// cadence this plan was drafted for.
const MEAL_PLAN_CALENDAR_STALE_DAYS = 21;

// Pure calendar age since the plan's own week (fallback: created_at day), independent
// of any upstream-source comparison. Null when there is nothing to date it by.
function mealPlanCalendarAgeDays(plan: any): number | null {
  const stamped = plan?.week_of
    ? String(plan.week_of).slice(0, 10)
    : plan?.created_at
      ? String(plan.created_at).slice(0, 10)
      : null;
  if (!stamped) return null;
  return daysBetweenISO(localDateISO(), stamped);
}

// Is a drafted/accepted meal plan outrun by newer upstream data since it was stamped?
// Compares the plan's stamped source_ts (fallback: its created_at day) against the
// current max upstream source. Quiet by default: stale:false when there's nothing
// newer or nothing to compare.
export function mealPlanFreshness(plan: any): { stale: boolean; reason: string | null; source_ts: string | null } {
  const parsed = plan?.parsed && typeof plan.parsed === "object" ? plan.parsed : null;
  const stamped = parsed?.source_ts
    ? String(parsed.source_ts).slice(0, 10)
    : plan?.created_at
      ? String(plan.created_at).slice(0, 10)
      : null;
  if (!stamped) return { stale: false, reason: null, source_ts: stamped };
  const reason =
    "A newer lab, health directive, weigh-in, or nutrition target has landed since this plan was drafted — worth re-drafting so meals reflect it.";
  const now = maxUpstreamNutritionSource();
  if (now && now > stamped) return { stale: true, reason, source_ts: stamped };
  // A directive sharing the plan's date but written later (same-day boundary) still
  // makes the plan stale — the day-granular compare above can't see intra-day order.
  if (newerNutritionDirectiveThanPlan(plan)) return { stale: true, reason, source_ts: stamped };
  // Nothing newer has landed, but the plan itself may simply be old. This never
  // implies the athlete did anything wrong — it is a calendar fact, not adherence.
  const ageDays = mealPlanCalendarAgeDays(plan);
  if (ageDays != null && ageDays > MEAL_PLAN_CALENDAR_STALE_DAYS) {
    return {
      stale: true,
      reason: `This plan was drafted ${ageDays} days ago — worth a fresh look even though nothing newer has landed since.`,
      source_ts: stamped,
    };
  }
  return { stale: false, reason: null, source_ts: stamped };
}

// Deterministic marker -> nutrient-concern mapping, small and fixed on purpose:
// only the markers whose canonical nutrition directive (propagation-data.ts's
// OPTIMAL_ZONES derive table) explicitly names saturated fat or added sugar as
// the dietary lever. There is no sodium entry: the drafting prompt is deliberately
// forbidden from inventing precise sodium amounts without a label/source, so a
// meal plan's own nutrition_pattern never carries a sodium read at all — a
// sodium-relevant directive (e.g. a blood-pressure DASH directive) has nothing on
// the plan side to cross-check, so it never produces a warning here. That is
// honest silence, not a gap.
const SATURATED_FAT_OR_ADDED_SUGAR_DIRECTIVE_MARKERS = new Set([
  "ApoB",
  "LDL-C",
  "Non-HDL-C",
  "Total cholesterol",
  "Triglycerides",
  "HbA1c",
]);

// Non-blocking, informational cross-check between an active nutrition-relevant
// directive and the plan's OWN coarse quality read. Saturated fat and added sugar
// share one combined band on a meal plan (nutrition_pattern.saturated_fat_added_sugar),
// so this can't say which of the two is driving the "watch" reading — the warning
// names both. Never medical advice, never a gate: it flows into validation_warnings
// alongside the fiber/dietary ones and never affects the `ok` verdict.
function mealPlanDirectiveWarnings(parsed: any): string[] {
  const band = String(parsed?.nutrition_pattern?.saturated_fat_added_sugar ?? "").toLowerCase();
  if (band !== "watch") return [];
  const flagged = nutritionRelevantDirectives().find((directive: any) =>
    SATURATED_FAT_OR_ADDED_SUGAR_DIRECTIVE_MARKERS.has(String(directive?.marker ?? ""))
  );
  if (!flagged) return [];
  return [
    `An active nutrition directive for ${flagged.marker} favors less saturated fat/added sugar, and this plan's own saturated-fat/added-sugar pattern currently reads as a watch item — worth a look, not a rule.`,
  ];
}

export type MealPlanPersistenceCheck =
  | { ok: true; parsed: any; adequacy_checked: boolean; fiber_checked: boolean }
  | { ok: false; error: string; parsed: any; adequacy_checked: boolean; fiber_checked: boolean };

const MEAL_PLAN_TARGET_TOLERANCE_KCAL = 100;

function normalizeMealPlanFiber(parsed: any): any {
  if (!parsed || typeof parsed !== "object") return parsed;
  const days = Array.isArray(parsed.days) ? parsed.days : [];
  const meals = days.flatMap((day: any) => (Array.isArray(day?.meals) ? day.meals : []));
  const fullyTracked =
    meals.length > 0 &&
    meals.every((meal: any) => {
      if (meal?.fiber_g == null || meal.fiber_g === "") return false;
      const value = Number(meal.fiber_g);
      return Number.isFinite(value) && value >= 0;
    });
  // A legacy target or a few estimated meals do not make the whole week
  // fiber-tracked. Preserve that partial state so validation can label it
  // unknown instead of manufacturing zeroes for missing values.
  if (!fullyTracked) return parsed;
  const daily = Number(parsed.daily_fiber_g);
  return {
    ...parsed,
    daily_fiber_g: Math.min(
      100,
      Math.max(MEAL_PLAN_FIBER_FLOOR_G, Number.isFinite(daily) ? Math.round(daily) : MEAL_PLAN_FIBER_FLOOR_G)
    ),
    days: days.map((day: any) => ({
      ...(day && typeof day === "object" ? day : {}),
      meals: (Array.isArray(day?.meals) ? day.meals : []).map((meal: any) => {
        const fiber = Number(meal?.fiber_g);
        return {
          ...(meal && typeof meal === "object" ? meal : {}),
          fiber_g: Number.isFinite(fiber) ? Math.min(100, Math.max(0, Math.round(fiber))) : 0,
        };
      }),
    })),
  };
}

function athleteDietaryDeclarations(instruction?: unknown, parsed?: any) {
  let restrictions: string | null = null;
  try {
    const row = db.prepare(`SELECT dietary_restrictions FROM profile WHERE id = 1`).get() as any;
    restrictions = row?.dietary_restrictions == null ? null : String(row.dietary_restrictions);
  } catch {
    restrictions = null;
  }
  let mealPrefs: string | null = null;
  try {
    mealPrefs = getSettings().meal_prefs || null;
  } catch {
    mealPrefs = null;
  }
  return { restrictions, mealPrefs, instruction, hardDietKeys: mealPlanHardDietKeys(parsed) };
}

export interface MealPlanConstraintSnapshot {
  version: 1;
  fingerprint: string;
  sources: {
    profile_allergies: string[];
    profile_hard_diets: string[];
    settings_hard_diets: string[];
    plan_hard_diets: string[];
  };
}

export interface MealPlanConstraintState {
  status: "current" | "refresh_needed";
  fingerprint: string;
  planned_for_fingerprint: string | null;
  changed_since_planned: boolean;
  legacy_unstamped: boolean;
  reason: string | null;
  conflicts: Array<{ kind: "allergy" | "dietary"; detail: string }>;
  warnings: string[];
}

// The fingerprint covers only HARD, authoritative constraints. Soft/negated
// preferences intentionally do not churn a current plan. Plan-scoped keys stay
// in the snapshot so a one-week instruction remains enforceable on later reads.
export function mealPlanConstraintSnapshot(parsed?: any): MealPlanConstraintSnapshot {
  const dietary = athleteDietaryDeclarations(undefined, parsed);
  const sources = {
    profile_allergies: canonicalAllergyKeys(athleteAllergies()),
    profile_hard_diets: canonicalHardDietKeys(dietary.restrictions, "authoritative"),
    settings_hard_diets: canonicalHardDietKeys(dietary.mealPrefs, "meal_prefs"),
    plan_hard_diets: mealPlanHardDietKeys(parsed),
  };
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(sources)).digest("hex").slice(0, 20);
  return { version: 1, fingerprint, sources };
}

function constraintConflict(
  kind: "allergy" | "dietary",
  error: unknown
): { kind: "allergy" | "dietary"; detail: string } {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return {
    kind,
    detail:
      raw
        .replace(/^.*? rejected:\s*/i, "")
        .trim()
        .slice(0, 300) || "The current plan conflicts with a hard food constraint.",
  };
}

function assessMealPlanConstraints(parsed: any): {
  snapshot: MealPlanConstraintSnapshot;
  state: MealPlanConstraintState;
} {
  const snapshot = mealPlanConstraintSnapshot(parsed);
  const prior = parsed?.constraint_provenance;
  const plannedFor = typeof prior?.planned_for_fingerprint === "string" ? prior.planned_for_fingerprint : null;
  const conflicts: MealPlanConstraintState["conflicts"] = [];
  const warnings: string[] = [];
  try {
    assertPlanAllergenSafe(parsed, athleteAllergies());
  } catch (error) {
    conflicts.push(constraintConflict("allergy", error));
  }
  try {
    warnings.push(...assertPlanDietarySafe(parsed, athleteDietaryDeclarations(undefined, parsed)));
  } catch (error) {
    conflicts.push(constraintConflict("dietary", error));
  }
  const status = conflicts.length ? "refresh_needed" : "current";
  return {
    snapshot,
    state: {
      status,
      fingerprint: snapshot.fingerprint,
      planned_for_fingerprint: plannedFor,
      changed_since_planned: plannedFor == null || plannedFor !== snapshot.fingerprint,
      legacy_unstamped: plannedFor == null,
      reason: conflicts.length
        ? "Your saved allergy or dietary constraints no longer match this meal plan. Refresh the plan before using its meals or shopping list."
        : null,
      conflicts,
      warnings: [...new Set(warnings)].slice(0, 8),
    },
  };
}

function stampMealPlanConstraintWrite(parsed: any): any {
  if (!parsed || typeof parsed !== "object") return parsed;
  const assessed = assessMealPlanConstraints(parsed);
  if (assessed.state.conflicts.length) throw new Error(`Meal plan rejected: ${assessed.state.conflicts[0].detail}`);
  const state: MealPlanConstraintState = {
    ...assessed.state,
    planned_for_fingerprint: assessed.snapshot.fingerprint,
    changed_since_planned: false,
    legacy_unstamped: false,
  };
  return {
    ...parsed,
    constraint_provenance: {
      version: 1,
      planned_for_fingerprint: assessed.snapshot.fingerprint,
      planned_for_sources: assessed.snapshot.sources,
      current: assessed.snapshot,
    },
    constraint_state: state,
    quality_validation: {
      ...(parsed.quality_validation && typeof parsed.quality_validation === "object" ? parsed.quality_validation : {}),
      constraint_freshness: state,
    },
  };
}

function refreshMealPlanConstraintState(plan: any): any {
  if (!plan?.id || !plan.parsed || typeof plan.parsed !== "object") return plan;
  const assessed = assessMealPlanConstraints(plan.parsed);
  const prior = plan.parsed.constraint_provenance;
  const parsed = {
    ...plan.parsed,
    constraint_provenance: {
      version: 1,
      planned_for_fingerprint:
        typeof prior?.planned_for_fingerprint === "string" ? prior.planned_for_fingerprint : null,
      planned_for_sources: prior?.planned_for_sources ?? null,
      current: assessed.snapshot,
    },
    constraint_state: assessed.state,
    quality_validation: {
      ...(plan.parsed.quality_validation && typeof plan.parsed.quality_validation === "object"
        ? plan.parsed.quality_validation
        : {}),
      constraint_freshness: assessed.state,
    },
  };
  if (JSON.stringify(parsed) !== JSON.stringify(plan.parsed)) {
    db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(parsed), Number(plan.id));
  }
  return { ...plan, parsed, constraint_state: assessed.state };
}

// This is the authoritative write/autonomy gate. Goal math already fuses the
// current expenditure estimate and canonical bodyweight. An accepted adaptive
// target is the coordinated reviewed number, not something a later volatile
// formula may silently raise. Thin profiles still receive the absolute 1500-kcal
// floor and the plan's own positive protein target remains authoritative.
export function validateMealPlanForPersistence(
  parsed: any,
  opts: { dietary_instruction?: unknown } = {}
): MealPlanPersistenceCheck {
  let goal: any = null;
  try {
    goal = computeGoalCheck();
  } catch {
    goal = null;
  }
  const recommended = goal?.ok && goal.recommended ? { ...goal.recommended } : {};
  const effective = goal?.ok ? goal.effective_target : null;
  const coordinatedTarget = Number(effective?.target_kcal);
  if (effective?.target_kcal != null) {
    recommended.target_intake_kcal = Number(effective.target_kcal) || Number(recommended.target_intake_kcal) || 0;
  }
  if (effective?.protein_g != null) {
    recommended.protein_g = Math.max(Number(recommended.protein_g) || 0, Number(effective.protein_g) || 0);
  }
  const floorGoal = goal?.ok ? { ...goal, recommended } : goal;
  const floored = normalizeMealPlanFiber(
    parsed && typeof parsed === "object"
      ? clampNutritionFloors(parsed, { kcal: "daily_kcal", protein: "daily_protein_g" }, floorGoal)
      : parsed
  );
  const headline = Number(floored?.daily_kcal);
  if (
    Number.isFinite(coordinatedTarget) &&
    coordinatedTarget > 0 &&
    Number.isFinite(headline) &&
    Math.abs(headline - coordinatedTarget) > MEAL_PLAN_TARGET_TOLERANCE_KCAL
  ) {
    return {
      ok: false,
      error: `Meal plan rejected: the ${Math.round(headline)} kcal headline is outside the ±${MEAL_PLAN_TARGET_TOLERANCE_KCAL} kcal rounding tolerance around the coordinated ${Math.round(coordinatedTarget)} kcal target; re-draft or explicitly review the nutrition target first.`,
      parsed: floored,
      adequacy_checked: false,
      fiber_checked: false,
    };
  }
  const adequacy = assessMealPlanAdequacy(floored);
  if (!adequacy.ok)
    return {
      ok: false,
      error: adequacy.error,
      parsed: floored,
      adequacy_checked: true,
      fiber_checked: adequacy.fiber_checked,
    };
  if (!adequacy.checked) {
    return {
      ok: false,
      error: "Meal plan rejected: a current plan requires 5 to 7 complete days with meal calorie and protein totals.",
      parsed: floored,
      adequacy_checked: false,
      fiber_checked: false,
    };
  }
  if (Number.isFinite(coordinatedTarget) && coordinatedTarget > 0) {
    const mismatch = adequacy.days.find(
      (day) => Math.abs(day.kcal - coordinatedTarget) > MEAL_PLAN_TARGET_TOLERANCE_KCAL
    );
    if (mismatch) {
      return {
        ok: false,
        error: `Meal plan rejected: ${mismatch.day} totals ${mismatch.kcal} kcal, outside the ±${MEAL_PLAN_TARGET_TOLERANCE_KCAL} kcal rounding tolerance around the coordinated ${Math.round(coordinatedTarget)} kcal target.`,
        parsed: floored,
        adequacy_checked: true,
        fiber_checked: adequacy.fiber_checked,
      };
    }
  }
  const dietWarnings = assertPlanDietarySafe(floored, athleteDietaryDeclarations(opts.dietary_instruction, floored));
  const validationWarnings = [
    ...(!adequacy.fiber_checked
      ? [
          "Fiber could not be deterministically verified because this legacy plan does not have complete per-meal fiber estimates; re-draft before treating its fiber pattern as adequate.",
        ]
      : []),
    ...dietWarnings,
    ...mealPlanDirectiveWarnings(floored),
  ];
  const qualityValidated = stampMealPlanConstraintWrite({
    ...floored,
    quality_validation: {
      fiber: adequacy.fiber_checked
        ? {
            status: "verified",
            target_daily_g: Math.max(MEAL_PLAN_FIBER_FLOOR_G, Number(floored.daily_fiber_g) || 0),
            average_daily_g:
              Math.round(
                (adequacy.days.reduce((sum, day) => sum + Number(day.fiber_g), 0) / Math.max(1, adequacy.days.length)) *
                  10
              ) / 10,
            minimum_day_g: Math.min(...adequacy.days.map((day) => Number(day.fiber_g))),
          }
        : { status: "unknown" },
      dietary_constraints: dietWarnings.length
        ? { status: "partial", warnings: dietWarnings }
        : { status: "screened_from_labels" },
    },
    validation_warnings: validationWarnings,
  });
  return {
    ok: true,
    parsed: qualityValidated,
    adequacy_checked: adequacy.checked,
    fiber_checked: adequacy.fiber_checked,
  };
}

export function createMealPlan(agent: string, raw: string, parsed: any, opts: { dietary_instruction?: unknown } = {}) {
  // Stamp the max upstream source at draft time so freshness can later tell whether a
  // newer lipid/health directive has outrun this plan.
  const scoped = stampInstructionHardDiets(parsed, opts.dietary_instruction);
  const check = validateMealPlanForPersistence(scoped, opts);
  if (!check.ok) throw new Error(check.error);
  const floored = check.parsed;
  assertPlanAllergenSafe(floored, athleteAllergies());
  const stamped =
    floored && typeof floored === "object" ? { ...floored, source_ts: maxUpstreamNutritionSource() } : floored;
  const info = db
    .prepare(`INSERT INTO meal_plans (week_of, agent, raw_output, parsed_json) VALUES (?, ?, ?, ?)`)
    .run(todayISO(), agent, raw || "", stamped ? JSON.stringify(stamped) : null);
  return getMealPlan(Number(info.lastInsertRowid));
}

function mealPlanAutonomy(planId: number): any | null {
  const row = db
    .prepare(
      `SELECT id, status, autonomy_tier, effective_date, summary, rationale, reversible, applied_at
       FROM brain_decisions
       WHERE kind = 'meal_plan' AND source_ref_type = 'meal_plan' AND source_ref_key = ?
         AND status IN ('announced','pending','applied')
       ORDER BY id DESC LIMIT 1`
    )
    .get(String(planId)) as any;
  return row
    ? {
        id: Number(row.id),
        status: String(row.status),
        tier: String(row.autonomy_tier),
        effective_date: row.effective_date == null ? null : String(row.effective_date),
        summary: row.summary == null ? null : String(row.summary),
        rationale: row.rationale == null ? null : String(row.rationale),
        reversible: Number(row.reversible) === 1,
        applied_at: row.applied_at == null ? null : String(row.applied_at),
      }
    : null;
}

function withMealPlanAutonomy(plan: any): any {
  return plan?.id
    ? {
        ...plan,
        autonomy: mealPlanAutonomy(Number(plan.id)),
        constraint_state: plan?.parsed?.constraint_state ?? null,
      }
    : plan;
}

// The current meal plan prefers one that has actually landed. An announced draft is
// an upcoming week, not today's menu; it must not silently replace the accepted plan
// before its natural boundary. With no accepted history, a draft remains a useful
// preview/fallback for a new installation.
export function currentMealPlan() {
  const rows = db
    .prepare(
      `SELECT * FROM meal_plans
       WHERE status NOT IN ('discarded', 'superseded')
       ORDER BY CASE WHEN status IN ('accepted','applied','kept') THEN 0 ELSE 1 END, id DESC
       LIMIT 100`
    )
    .all() as any[];
  for (const row of rows) {
    const plan = hydrate(row);
    const adequacy = assessMealPlanAdequacy(plan?.parsed);
    // Historical partial rows remain available through explicit get/list/history,
    // but an unchecked or mismatched artifact is never the canonical current plan.
    if (adequacy.ok && adequacy.checked) return refreshMealPlanConstraintState(withMealPlanAutonomy(plan));
  }
  return null;
}

const WEEKDAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function weekdayAbbr(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? WEEKDAY_ABBR[new Date(t).getUTCDay()] : "";
}
function addDaysISO(iso: string, n: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + n * 864e5).toISOString().slice(0, 10) : iso;
}

// A BOUNDED view of the current meal plan for the coach brain: today's + tomorrow's
// meals + the daily targets + a freshness flag. So chat / the day-read / insights can
// reference the ACTUAL planned food ("you've got salmon planned tonight") instead of
// being blind to it. Null when there's no live plan. Deterministic, no scores.
export function mealPlanForCoach() {
  const plan = currentMealPlan();
  if (!plan || !plan.parsed) return null;
  const parsed = plan.parsed;
  const constraintState = plan.constraint_state ?? parsed.constraint_state ?? null;
  if (constraintState?.status === "refresh_needed") {
    return {
      id: plan.id,
      status: plan.status,
      week_of: plan.week_of,
      constraint_state: constraintState,
      refresh_needed: true,
      today: null,
      tomorrow: null,
    };
  }
  const days = Array.isArray(parsed.days) ? parsed.days : [];
  const today = localDateISO();
  const pick = (iso: string, label: string) => {
    const abbr = weekdayAbbr(iso);
    const d = days.find((x: any) =>
      String(x?.day ?? "")
        .trim()
        .toLowerCase()
        .startsWith(abbr)
    );
    if (!d) return null;
    const meals = (Array.isArray(d.meals) ? d.meals : []).slice(0, 6).map((m: any) => ({
      name: capStr(m?.name, 80),
      kcal: m?.kcal ?? null,
      protein_g: m?.protein_g ?? null,
      fiber_g: m?.fiber_g ?? null,
    }));
    return { label, day: String(d.day ?? "").trim(), note: d?.note ? capStr(d.note, 200) : null, meals };
  };
  const freshness = mealPlanFreshness(plan);
  return {
    id: plan.id,
    status: plan.status,
    week_of: plan.week_of,
    daily_kcal: parsed.daily_kcal ?? null,
    daily_protein_g: parsed.daily_protein_g ?? null,
    daily_fiber_g: parsed.daily_fiber_g ?? null,
    quality_validation:
      parsed.quality_validation && typeof parsed.quality_validation === "object" ? parsed.quality_validation : null,
    validation_warnings: Array.isArray(parsed.validation_warnings) ? parsed.validation_warnings.slice(0, 8) : [],
    practicality: parsed.practicality && typeof parsed.practicality === "object" ? parsed.practicality : null,
    nutrition_pattern:
      parsed.nutrition_pattern && typeof parsed.nutrition_pattern === "object" ? parsed.nutrition_pattern : null,
    today: pick(today, "today"),
    tomorrow: pick(addDaysISO(today, 1), "tomorrow"),
    stale: freshness.stale,
    stale_reason: freshness.reason,
    constraint_state: constraintState,
    refresh_needed: false,
  };
}

// ---------- meal-plan adherence (the missing confounder) ----------
// Nothing anywhere compared the accepted meal plan with what was actually logged, so
// when a weight expectation missed, the intake evaluator had exactly one explanation
// available — the calorie target was wrong — and eased it. "They didn't eat the plan"
// was not a hypothesis the machinery could hold.
//
// This is the deterministic read that makes it one. It is COARSE on purpose: a
// persisted plan is validated to keep every day inside a tight tolerance of its
// headline `daily_kcal`/`daily_protein_g` (validateMealPlanForPersistence), so those
// two numbers ARE the plan's daily band and no weekday matching is needed to compare
// against them.
//
// ADHERENCE-NEUTRAL, like every nutrition read here. It classifies days and lowers
// CONFIDENCE when the logging is thin; it never scores, never blames, and its prose
// is machine register (an evaluator confounder and coach context, not something an
// athlete is shown). A day nobody logged is counted as unlogged and left alone — it
// is not a diverged day, and it is certainly not a zero-calorie one.
export type MealPlanAdherenceClass = "followed" | "diverged" | "too_thin";
export type MealPlanAdherenceConfidence = "none" | "low" | "moderate" | "high";

export interface MealPlanAdherenceDay {
  date: string;
  kcal: number;
  protein_g: number | null;
  classification: MealPlanAdherenceClass;
}

export interface MealPlanAdherenceResult {
  plan_id: number | null;
  window_start: string;
  window_end: string;
  daily_kcal: number | null;
  daily_protein_g: number | null;
  calendar_days: number;
  logged_days: number;
  readable_days: number;
  followed_days: number;
  diverged_days: number;
  too_thin_days: number;
  unlogged_days: number;
  confidence: MealPlanAdherenceConfidence;
  clearly_diverged: boolean;
  days: MealPlanAdherenceDay[];
  summary: string;
}

// The band a logged day has to land in to read as following the plan. Percentage-led
// so it scales with the target, with an absolute floor because ±15% of a 1,800 kcal
// day is 270 kcal and a single mis-estimated restaurant meal is worth about that.
const ADHERENCE_KCAL_TOLERANCE_FRACTION = 0.15;
const ADHERENCE_MIN_KCAL_TOLERANCE = 250;
// Protein is read as a FLOOR, never a band: a day that beat the protein target has
// not diverged from a plan built around hitting it.
const ADHERENCE_PROTEIN_FLOOR_FRACTION = 0.8;
// Confidence steps, as the share of the window's calendar days that were readable.
const ADHERENCE_LOW_COVERAGE = 0.4;
const ADHERENCE_HIGH_COVERAGE = 0.7;
const ADHERENCE_MIN_READABLE_DAYS = 4;
// A run of days pointing the same way, not one takeout night.
const ADHERENCE_CLEAR_DIVERGENCE_DAYS = 3;

// Logged protein per day, keyed exactly the way completedIntakeRange keys calories
// (COALESCE(date, substr(created_at,1,10))), so the two reads describe the same days.
// completedIntakeRange owns the calorie total and the credibility call; this only
// adds the one macro it does not carry.
function loggedProteinByDay(since: string, through: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT COALESCE(date, substr(created_at, 1, 10)) AS day, parsed_json
         FROM food_notes
        WHERE COALESCE(date, substr(created_at, 1, 10)) >= ?
          AND COALESCE(date, substr(created_at, 1, 10)) <= ?`
    )
    .all(since, through) as any[];
  const byDay = new Map<string, number>();
  for (const row of rows) {
    let parsed: any = null;
    try {
      parsed = row.parsed_json ? JSON.parse(String(row.parsed_json)) : null;
    } catch {
      parsed = null;
    }
    const protein = Number(parsed?.protein_g);
    const date = String(row.day ?? "").slice(0, 10);
    if (!date || !Number.isFinite(protein) || protein <= 0) continue;
    byDay.set(date, (byDay.get(date) ?? 0) + protein);
  }
  return byDay;
}

function adherenceConfidence(readable: number, calendarDays: number): MealPlanAdherenceConfidence {
  if (readable <= 0) return "none";
  const coverage = calendarDays > 0 ? readable / calendarDays : 0;
  if (readable < ADHERENCE_MIN_READABLE_DAYS || coverage < ADHERENCE_LOW_COVERAGE) return "low";
  if (coverage < ADHERENCE_HIGH_COVERAGE) return "moderate";
  return "high";
}

// The plan a past window has to be judged against is the one that was LIVE THEN, not
// whatever is live now. A re-draft after the window closed would otherwise become the
// yardstick for days the athlete ate against a different target — which reads as a
// divergence they never made, and (through mealPlanAdherenceIssues) confounds the
// intake evaluation that window exists to answer. Newest landed plan created on or
// before the window's last day wins; with no plan that old, the current one is the only
// answer available and is used exactly as before.
function mealPlanInForceAt(windowEnd: string): any | null {
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT * FROM meal_plans
          WHERE status IN ('accepted', 'applied', 'kept') AND date(created_at) <= date(?)
          ORDER BY id DESC LIMIT 50`
      )
      .all(windowEnd) as any[];
  } catch {
    rows = [];
  }
  for (const row of rows) {
    const plan = hydrate(row);
    const adequacy = assessMealPlanAdequacy(plan?.parsed);
    // Same gate currentMealPlan applies: an unchecked or mismatched artifact is never
    // the plan anything is measured against.
    if (adequacy.ok && adequacy.checked) return plan;
  }
  return null;
}

export function mealPlanAdherence(windowStart: string, windowEnd: string): MealPlanAdherenceResult {
  const empty = (summary: string, planId: number | null = null): MealPlanAdherenceResult => ({
    plan_id: planId,
    window_start: windowStart,
    window_end: windowEnd,
    daily_kcal: null,
    daily_protein_g: null,
    calendar_days: 0,
    logged_days: 0,
    readable_days: 0,
    followed_days: 0,
    diverged_days: 0,
    too_thin_days: 0,
    unlogged_days: 0,
    confidence: "none",
    clearly_diverged: false,
    days: [],
    summary,
  });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(windowStart)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(windowEnd))) {
    return empty("The adherence window was not a pair of calendar dates.");
  }
  let plan: any = null;
  try {
    plan = mealPlanInForceAt(windowEnd) ?? currentMealPlan();
  } catch {
    plan = null;
  }
  const targetKcal = Number(plan?.parsed?.daily_kcal);
  const targetProtein = Number(plan?.parsed?.daily_protein_g);
  if (!plan || !Number.isFinite(targetKcal) || targetKcal <= 0) {
    // No live plan means there is nothing to have followed — an absence, not a miss.
    // `plan_id` stays NULL even when a plan row exists but carries no headline
    // daily_kcal: the id is how callers ask "was there a target to diverge from?", and
    // a legacy plan without one has no answerable target. Handing back its id made
    // every intake window it touched permanently confounded (evaluators.ts bails only
    // on a null plan_id), which silently froze the nutrition_step modifier.
    return empty("No live meal plan with a daily calorie target covered this window.");
  }

  let intake: ReturnType<typeof completedIntakeRange>;
  try {
    intake = completedIntakeRange(windowStart, windowEnd);
  } catch {
    return empty("Logged intake could not be read for this window.", plan.id ?? null);
  }
  const proteinByDay = loggedProteinByDay(windowStart, intake.through);
  const kcalTolerance = Math.max(ADHERENCE_MIN_KCAL_TOLERANCE, Math.round(targetKcal * ADHERENCE_KCAL_TOLERANCE_FRACTION));
  const proteinFloor =
    Number.isFinite(targetProtein) && targetProtein > 0 ? targetProtein * ADHERENCE_PROTEIN_FLOOR_FRACTION : null;

  const days: MealPlanAdherenceDay[] = intake.days.map((day) => {
    const protein = proteinByDay.get(day.date) ?? null;
    if (!day.credible) {
      // Too little logged to say anything about the day — explicitly NOT a divergence.
      return { date: day.date, kcal: day.kcal, protein_g: protein, classification: "too_thin" as const };
    }
    const kcalInBand = Math.abs(day.kcal - targetKcal) <= kcalTolerance;
    // A day whose protein was never estimated cannot fail the protein floor; the
    // calorie band decides it alone.
    const proteinOk = proteinFloor == null || protein == null ? true : protein >= proteinFloor;
    return {
      date: day.date,
      kcal: day.kcal,
      protein_g: protein,
      classification: kcalInBand && proteinOk ? ("followed" as const) : ("diverged" as const),
    };
  });

  const followed = days.filter((d) => d.classification === "followed").length;
  const diverged = days.filter((d) => d.classification === "diverged").length;
  const tooThin = days.filter((d) => d.classification === "too_thin").length;
  const readable = followed + diverged;
  const confidence = adherenceConfidence(readable, intake.calendar_days);
  const clearlyDiverged = diverged >= ADHERENCE_CLEAR_DIVERGENCE_DAYS && diverged > followed;
  const summary =
    readable > 0
      ? `Logged intake sat inside the plan's daily bands on ${followed} of ${readable} readable days (target ${Math.round(targetKcal)} kcal${proteinFloor != null ? `, ${Math.round(targetProtein)} g protein` : ""}); ${tooThin} day(s) carried too little detail to read and ${intake.missing_days} of ${intake.calendar_days} day(s) carried no food log. Adherence confidence: ${confidence}.`
      : `No day in this window carried enough logged detail to compare against the plan's daily bands; ${intake.missing_days} of ${intake.calendar_days} day(s) carried no food log. Adherence confidence: ${confidence}.`;

  return {
    plan_id: plan.id ?? null,
    window_start: windowStart,
    window_end: intake.through,
    daily_kcal: Math.round(targetKcal),
    daily_protein_g: Number.isFinite(targetProtein) && targetProtein > 0 ? Math.round(targetProtein) : null,
    calendar_days: intake.calendar_days,
    logged_days: days.length,
    readable_days: readable,
    followed_days: followed,
    diverged_days: diverged,
    too_thin_days: tooThin,
    unlogged_days: intake.missing_days,
    confidence,
    clearly_diverged: clearlyDiverged,
    days,
    summary,
  };
}

export function listMealPlans(limit = 10) {
  const decorate = (plan: any) => {
    // Additive freshness flag so the PWA can show a quiet "worth re-drafting" chip on
    // a live plan that a newer lab/directive has outrun. Only meaningful for a live
    // (draft/accepted) plan; a discarded one is history.
    plan = refreshMealPlanConstraintState(plan);
    if (plan.status === "draft" || plan.status === "accepted" || plan.status === "applied" || plan.status === "kept") {
      const f = mealPlanFreshness(plan);
      return { ...plan, stale: f.stale, stale_reason: f.reason };
    }
    return plan;
  };
  const plans = (db.prepare(`SELECT * FROM meal_plans ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map((row) =>
    decorate(withMealPlanAutonomy(hydrate(row)))
  );
  // The list is a bounded history feed, but every planner consumer also relies on
  // it to paint the CURRENT week. A run of newer discarded/superseded/review rows
  // must never push the accepted plan outside the payload and make a draft look
  // current. Preserve the requested history window, then append the one canonical
  // current row when it is not already present (at most limit + 1 records).
  const current = currentMealPlan() as any;
  if (current?.id && !plans.some((plan) => Number(plan.id) === Number(current.id))) plans.push(decorate(current));
  return plans;
}

function recordMealPlanStatusDecision(plan: any, transition: string): void {
  if (!plan?.id || !["accepted", "applied", "discarded", "superseded"].includes(transition)) return;
  try {
    const accepted = transition === "accepted" || transition === "applied";
    const explicitKcal = Number(plan.parsed?.daily_kcal);
    const dayKcal = (Array.isArray(plan.parsed?.days) ? plan.parsed.days : [])
      .map((day: any) =>
        (Array.isArray(day?.meals) ? day.meals : []).reduce(
          (sum: number, meal: any) => sum + (Number(meal?.kcal) || 0),
          0
        )
      )
      .filter((value: number) => value > 0);
    const kcal =
      Number.isFinite(explicitKcal) && explicitKcal > 0
        ? explicitKcal
        : dayKcal.length
          ? Math.round(dayKcal.reduce((sum: number, value: number) => sum + value, 0) / dayKcal.length)
          : Number.NaN;
    const response =
      accepted && Number.isFinite(kcal) && kcal > 0 ? nutritionTrendExpectation(kcal, localDateISO()) : null;
    // Close the lab loop for meals: an accepted plan applied while a nutrition marker-directive
    // is active anchors a falsifiable "<marker> should move toward optimal" expectation to THIS
    // meal plan (the primary driver). Best-effort; null when there's nothing to anchor.
    const markerRecording = accepted ? markerInterventionRecording("nutrition", localDateISO(), "meal_plan") : null;
    const expectations = [
      ...(response ? [response.expectation] : []),
      // A same-draw repeat suppresses the expectation (null) but still records meta below.
      ...(markerRecording?.expectation ? [markerRecording.expectation] : []),
    ];
    const days = Array.isArray(plan.parsed?.days) ? plan.parsed.days : [];
    recordDecision(
      {
        effective_date: localDateISO(),
        kind: "meal_plan",
        domain: "nutrition",
        summary: accepted
          ? String(plan.parsed?.summary ?? "Meal plan accepted.").slice(0, 300)
          : transition === "superseded"
            ? "Meal plan superseded by a newer accepted plan."
            : "Meal plan declined.",
        rationale: accepted
          ? String(plan.parsed?.rationale ?? plan.parsed?.notes ?? "Accepted as the current meal plan.").slice(0, 1_500)
          : null,
        source: plan.agent || "meal_plan",
        source_ref_type: "meal_plan",
        source_ref_key: String(plan.id),
        status: accepted ? "applied" : transition === "superseded" ? "superseded" : "rejected",
        autonomy_tier: "ask",
        risk_class: "low",
        // Meal-plan acceptance has no persisted before-snapshot. Manual swaps and
        // edits also remain ordinary direct writes, never fictional auto-undo.
        reversible: false,
        input_fingerprint: null,
        context: {
          transition,
          week_of: plan.week_of ?? null,
          expectation_basis: response?.basis ?? (accepted ? "daily_kcal_unavailable" : null),
          recomposition_stage: response?.expectation.baseline?.recomposition_stage ?? null,
          ...(markerRecording ? { marker_anchor: markerRecording.meta } : {}),
        },
        action: {
          meal_plan_id: plan.id,
          transition,
          daily_kcal: Number.isFinite(kcal) ? kcal : null,
          daily_protein_g: Number(plan.parsed?.daily_protein_g) || null,
          planned_days: days.length,
        },
        specialist: null,
        applied_at: accepted ? new Date().toISOString() : null,
        reverted_at: null,
        superseded_by: null,
        evaluator_version:
          response?.expectation.evaluator_version ?? markerRecording?.expectation?.evaluator_version ?? null,
      },
      expectations
    );
  } catch {
    // Meal-plan status is authoritative; accountability telemetry is fail-soft.
  }
}

export function setMealPlanStatus(id: number, status: string, opts: { recordDecision?: boolean } = {}) {
  if (["draft", "accepted", "applied", "kept"].includes(status)) {
    const existing = getMealPlan(id);
    if (!existing) return null;
    const check = validateMealPlanForPersistence(existing.parsed);
    if (!check.ok) throw new Error(check.error);
    if (JSON.stringify(check.parsed) !== JSON.stringify(existing.parsed)) {
      db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(check.parsed), id);
    }
  }
  db.prepare(`UPDATE meal_plans SET status = ? WHERE id = ?`).run(status, id);
  const plan = withMealPlanAutonomy(hydrate(db.prepare(`SELECT * FROM meal_plans WHERE id = ?`).get(id)));
  if (plan && opts.recordDecision !== false) recordMealPlanStatusDecision(plan, status);
  return plan;
}

// Accepting a meal plan retires the OTHER open meal-plan drafts — they were
// alternative weeks, so once one is kept the rest are stale. Marked 'superseded'
// (the system retiring them), distinct from a user 'discarded'.
export function acceptMealPlan(id: number, opts: { recordDecision?: boolean } = {}) {
  const accepted = withSqliteSavepoint(`accept_meal_plan_${Math.trunc(Number(id))}`, () => {
    const plan = getMealPlan(id);
    if (!plan) return null;
    const check = validateMealPlanForPersistence(plan.parsed);
    if (!check.ok) throw new Error(check.error);
    const safeParsed = check.parsed;
    assertPlanAllergenSafe(safeParsed, athleteAllergies());
    if (safeParsed && JSON.stringify(safeParsed) !== JSON.stringify(plan.parsed)) {
      db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(safeParsed), id);
    }
    const siblings = db
      .prepare(`SELECT * FROM meal_plans WHERE status IN ('draft','accepted','applied','kept') AND id != ?`)
      .all(id)
      .map(hydrate)
      .filter(Boolean);
    db.prepare(
      `UPDATE meal_plans SET status = 'superseded'
       WHERE status IN ('draft','accepted','applied','kept') AND id != ?`
    ).run(id);
    if (opts.recordDecision !== false) {
      for (const sibling of siblings) recordMealPlanStatusDecision({ ...sibling, status: "superseded" }, "superseded");
    }
    return setMealPlanStatus(id, "accepted", opts);
  });
  if (accepted) {
    emitBrainEvent({
      kind: "meal_plan_changed",
      domain: "nutrition",
      date: localDateISO(),
      entity_id: id,
      material: true,
    });
    // Accepting a plan changes what today's fuel plan actually is — the cached
    // Brief must recompute against it, same as a plan/training restructure does.
    invalidateDayRead();
  }
  return accepted;
}

// Undo for an autonomously accepted week is intentionally narrower than ordinary
// acceptance: retire only the plan owned by that decision and restore its exact
// predecessor. Newer drafts/announcements are independent future options and stay
// untouched instead of being swept as sibling alternatives.
export function restoreMealPlanAfterUndo(
  appliedId: number,
  previousId: number | null
): { applied: any; previous: any | null } | null {
  const restored = withSqliteSavepoint(`restore_meal_plan_${Math.trunc(Number(appliedId))}`, () => {
    const applied = getMealPlan(appliedId);
    if (!applied) return null;
    const previous = previousId != null && previousId > 0 ? getMealPlan(previousId) : null;
    setMealPlanStatus(appliedId, "superseded", { recordDecision: false });
    if (previous) setMealPlanStatus(previous.id, "accepted", { recordDecision: false });
    return { applied: getMealPlan(appliedId), previous: previous ? getMealPlan(previous.id) : null };
  });
  if (restored) {
    emitBrainEvent({
      kind: "meal_plan_changed",
      domain: "nutrition",
      date: localDateISO(),
      entity_id: restored.previous?.id ?? appliedId,
      material: true,
    });
    // The undo restores a different plan as current — same reasoning as acceptMealPlan.
    invalidateDayRead();
  }
  return restored;
}

export function getMealPlan(id: number) {
  const row = db.prepare(`SELECT * FROM meal_plans WHERE id = ?`).get(id);
  // Singular reads are just as authoritative as current/list. Re-run the same
  // canonical constraint-freshness assessment so a profile allergy or dietary
  // change cannot leave REST/MCP callers holding the stale status embedded when
  // the plan was written. This decorates the existing ledger row in place; it
  // never changes plan status or selects/supersedes history.
  return row ? refreshMealPlanConstraintState(withMealPlanAutonomy(hydrate(row))) : null;
}

// Agent (and PWA) supplied meal objects are coerced/clamped before write —
// numbers via Number() with sane ceilings, strings capped to keep parsed_json honest.
function clampNum(v: any, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(max, Math.round(n));
}

// Length guard for stored human-facing text. When it has to truncate it breaks on
// a word boundary and adds an ellipsis (never a mid-word cut like "…bloodwork pane"),
// and the result still fits within `max`.
export function capStr(v: any, max = 300): string {
  const s = String(v ?? "").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  const head = (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.!?-]+$/, "");
  return head + "…";
}

export function coerceMeal(m: any) {
  const meal: any = {
    name: capStr(m?.name),
    items: capStr(m?.items),
    kcal: clampNum(m?.kcal, 3000),
    protein_g: clampNum(m?.protein_g, 500),
    carbs_g: clampNum(m?.carbs_g, 500),
    fat_g: clampNum(m?.fat_g, 500),
  };
  // Fiber was introduced after meal plans already existed. Preserve omission
  // as unknown; Number(undefined) -> NaN -> 0 would falsely claim a measured
  // zero and make harmless legacy edits fail the modern quality gate.
  if (m?.fiber_g != null && m.fiber_g !== "") meal.fiber_g = clampNum(m.fiber_g, 100);
  return meal;
}

function athleteAllergies(): string | null {
  try {
    const row = db.prepare(`SELECT allergies FROM profile WHERE id = 1`).get() as any;
    return row?.allergies == null ? null : String(row.allergies);
  } catch {
    return null;
  }
}

// Replace the days array inside a meal plan's parsed_json — used for manual
// reordering/editing of meals. PRESERVES every other key the agent emitted
// (daily_kcal, shopping, notes, ...). Returns the hydrated updated row, or
// null on unknown id / invalid days.
export function updateMealPlanDays(id: number, days: any) {
  const plan = getMealPlan(id);
  if (!plan) return null;
  if (!Array.isArray(days)) throw new Error("days must be an array");
  const cleanDays = days.map((d: any) => ({
    ...(d && typeof d === "object" ? d : {}),
    day: capStr(d?.day, 40),
    ...(d?.note !== undefined && d?.note !== null ? { note: capStr(d.note) } : {}),
    // Carry a cached recipe through reorders/edits (re-clamped) — coerceMeal
    // alone would silently drop it. Swaps still drop it on purpose: a new
    // meal needs a new recipe.
    meals: (Array.isArray(d?.meals) ? d.meals : []).map((m: any) => {
      const recipe = m?.recipe ? coerceRecipe(m.recipe) : null;
      return recipe ? { ...coerceMeal(m), recipe } : coerceMeal(m);
    }),
  }));
  assertPlanAllergenSafe({ days: cleanDays }, athleteAllergies());
  const parsed = { ...(plan.parsed && typeof plan.parsed === "object" ? plan.parsed : {}), days: cleanDays };
  const check = validateMealPlanForPersistence(parsed);
  if (!check.ok) throw new Error(check.error);
  db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(check.parsed), id);
  const updated = getMealPlan(id);
  emitBrainEvent({ kind: "meal_plan_changed", domain: "nutrition", date: localDateISO(), entity_id: id });
  // Reordering/editing days changes what the plan actually says to eat.
  invalidateDayRead();
  return updated;
}

// Swap one meal in place (agentic "swap this meal"). Returns { plan, meal }
// with the coerced/clamped meal actually written, or null when the plan/day/
// index can't be found.
export function swapMealInPlan(
  id: number,
  day: string,
  mealIndex: number,
  meal: any,
  opts: { dietary_instruction?: unknown } = {}
) {
  const plan = getMealPlan(id);
  if (!plan || !plan.parsed || !Array.isArray(plan.parsed.days)) return null;
  const dayKey = String(day ?? "")
    .trim()
    .toLowerCase();
  const target = plan.parsed.days.find(
    (d: any) =>
      String(d?.day ?? "")
        .trim()
        .toLowerCase() === dayKey
  );
  if (!target || !Array.isArray(target.meals)) return null;
  const idx = Number(mealIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= target.meals.length) return null;
  const clean = coerceMeal(meal);
  assertMealAllergenSafe(clean, athleteAllergies(), `${capStr(target.day, 40) || "meal plan"} meal ${idx + 1}`);
  assertMealDietarySafe(
    clean,
    athleteDietaryDeclarations(opts.dietary_instruction, plan.parsed),
    `${capStr(target.day, 40) || "meal plan"} meal ${idx + 1}`
  );
  target.meals[idx] = clean;
  const check = validateMealPlanForPersistence(plan.parsed, opts);
  if (!check.ok) throw new Error(check.error);
  db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(check.parsed), id);
  emitBrainEvent({
    kind: "meal_plan_changed",
    domain: "nutrition",
    date: localDateISO(),
    entity_id: id,
    subject_key: `${target.day}:${idx}`,
  });
  // A swapped meal is a real content change to the plan.
  invalidateDayRead();
  return { plan: getMealPlan(id), meal: clean };
}

// Agent-provided recipes are coerced/clamped before write, same discipline as
// coerceMeal. Returns null when nothing usable remains (no steps AND no
// ingredients after coercion).
export function coerceRecipe(r: any) {
  if (!r || typeof r !== "object") return null;
  const strList = (v: any, maxItems: number, maxLen: number): string[] =>
    (Array.isArray(v) ? v : [])
      .filter((s: any) => typeof s === "string" && s.trim())
      .slice(0, maxItems)
      .map((s: string) => s.trim().slice(0, maxLen));
  const timeMin = Number(r.time_min);
  const servings = Number(r.servings);
  const ingredients = (Array.isArray(r.ingredients) ? r.ingredients : [])
    .filter((i: any) => i && typeof i === "object" && typeof i.item === "string" && i.item.trim())
    .slice(0, 20)
    .map((i: any) => ({ item: capStr(i.item, 120), qty: capStr(i.qty, 40) }));
  const steps = strList(r.steps, 15, 300);
  const tips = strList(r.tips, 6, 200);
  if (!steps.length && !ingredients.length) return null;
  return {
    summary: capStr(r.summary, 400),
    time_min: Number.isFinite(timeMin) ? Math.min(240, Math.max(0, Math.round(timeMin))) : 0,
    servings: Number.isFinite(servings) ? Math.min(8, Math.max(1, Math.round(servings))) : 1,
    ingredients,
    steps,
    tips,
  };
}

// Cache an agent-written recipe on one planned meal, under
// parsed.days[day].meals[mealIndex].recipe. Day matches case-insensitively
// like swapMealInPlan; every other parsed_json key is preserved. Returns
// { plan, recipe } or null when plan/day/meal is missing or the recipe is
// unusable after coercion.
export function setMealRecipe(planId: number, day: string, mealIndex: number, recipe: any) {
  const plan = getMealPlan(planId);
  if (!plan || !plan.parsed || !Array.isArray(plan.parsed.days)) return null;
  const safety = validateMealPlanForPersistence(plan.parsed);
  if (!safety.ok) throw new Error(safety.error);
  // Work from the revalidated/stamped object, not the pre-check blob. This
  // makes a compatible constraint change part of the recipe edit provenance.
  const parsed = safety.parsed;
  const dayKey = String(day ?? "")
    .trim()
    .toLowerCase();
  const target = parsed.days.find(
    (d: any) =>
      String(d?.day ?? "")
        .trim()
        .toLowerCase() === dayKey
  );
  if (!target || !Array.isArray(target.meals)) return null;
  const idx = Number(mealIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= target.meals.length) return null;
  const clean = coerceRecipe(recipe);
  if (!clean) return null;
  assertRecipeAllergenSafe(
    clean,
    athleteAllergies(),
    `${capStr(target.day, 40) || "meal plan"} meal ${idx + 1} recipe`
  );
  assertRecipeDietarySafe(
    clean,
    athleteDietaryDeclarations(undefined, parsed),
    `${capStr(target.day, 40) || "meal plan"} meal ${idx + 1} recipe`
  );
  target.meals[idx] = {
    ...(target.meals[idx] && typeof target.meals[idx] === "object" ? target.meals[idx] : {}),
    recipe: clean,
  };
  db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(parsed), planId);
  emitBrainEvent({
    kind: "meal_plan_changed",
    domain: "nutrition",
    date: localDateISO(),
    entity_id: planId,
    subject_key: `${target.day}:${idx}:recipe`,
  });
  // Deliberately no invalidateDayRead here — caching a recipe doesn't change
  // what/how much the plan says to eat, so today's Brief has nothing to redo.
  return { plan: getMealPlan(planId), recipe: clean };
}

// ---------- food notes ----------

// How far back a food note may be backdated. Backdating is the whole point ("I
// remembered what I ate last night"), so the bound only has to rule out a
// mistyped year: a year covers any realistic catch-up or import, and is far past
// the horizon of every read that consumes intake (the trailing averages behind
// the fuel and expenditure model look back weeks, not years).
const MAX_FOOD_BACKDATE_DAYS = 365;

// The placeholders the CODE supplies when nobody actually named a meal — this
// module's own `meal || "meal"` default and `String(a.meal || "meal")` in the chat
// action lane. Treating them as UNSTATED is what lets a time fill in a label
// without ever overwriting one a person chose.
const GENERIC_MEAL_LABELS = new Set(["", "meal", "food"]);

// When a meal happened, as the athlete stated it. Both optional: today with no
// time is the ordinary case and must stay free of ceremony.
export interface FoodNoteWhen {
  // LOCAL calendar day the meal belongs to (YYYY-MM-DD). Defaults to today.
  date?: string;
  // LOCAL wall-clock time it was eaten ("HH:MM", 24-hour). No default — absence
  // is a first-class answer and nothing downstream requires one.
  eaten_at?: string;
  // Policy, not data: what to do with a value this layer cannot honestly store.
  // DEFAULT drops it back to today / no time and warns, because most callers are
  // model-driven — "when" is resolved out of a whole sentence, and a guessed
  // timestamp must never cost the athlete the food entry itself. Pass false to
  // REJECT instead (RangeError); the REST routes do, since a person typing a date
  // into a form deserves to be told rather than quietly filed on the wrong day.
  lenient?: boolean;
}

// Why a stated date cannot be stored, or null when it can. Split out so the strict
// and lenient paths apply the exact same rules and differ only in what they DO
// about a failure — those two must never drift into disagreeing about what's valid.
const FOOD_NOTE_TIME_PROBLEM = "food note eaten_at must be a 24-hour local time (HH:MM)";
function foodNoteDateProblem(value: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "food note date must be YYYY-MM-DD";
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return "food note date must be a real calendar date";
  }
  // You cannot have eaten tomorrow. Compared against the LOCAL day (device zone
  // via localDateISO), never a bare UTC date, so a late-evening log abroad is not
  // mistaken for the future.
  if (value > today) return "food note date cannot be in the future";
  const age = daysBetweenISO(today, value);
  if (age != null && age > MAX_FOOD_BACKDATE_DAYS) {
    return `food note date cannot be more than ${MAX_FOOD_BACKDATE_DAYS} days ago`;
  }
  return null;
}

// Trust boundary for the "when" of a food note, shared by REST, MCP and chat.
function canonicalFoodNoteWhen(opts: FoodNoteWhen | undefined): {
  date: string;
  eaten_at: string | null;
} {
  // One read of the local day for the whole resolution, so a call that straddles
  // midnight can't validate against one day and stamp against the next.
  const today = localDateISO();
  const lenient = opts?.lenient !== false;
  // Lenient records the problem and leaves the caller on the default it would have
  // used before any of this existed; strict throws.
  const refuse = (problem: string): void => {
    if (!lenient) throw new RangeError(problem);
    console.warn(`[food] ignoring a stated time — ${problem}`);
  };

  let date = today;
  const rawDate = opts?.date;
  if (rawDate !== undefined && rawDate !== null && rawDate !== "") {
    const value = String(rawDate).trim();
    const problem = foodNoteDateProblem(value, today);
    if (problem) refuse(problem);
    else date = value;
  }

  let eaten_at: string | null = null;
  const rawTime = opts?.eaten_at;
  if (rawTime !== undefined && rawTime !== null && rawTime !== "") {
    const normalized = normalizeWallClock(rawTime);
    if (!normalized) refuse(FOOD_NOTE_TIME_PROBLEM);
    else eaten_at = normalized;
  }
  return { date, eaten_at };
}

// Resolve the meal label and the stored time together, so the two can never
// disagree. A label the athlete (or an agent speaking for them) actually stated
// ALWAYS wins — the windows in shared.ts only fill a blank.
//
// ONE direction of inference happens here, and only one: a stated time can name an
// unnamed meal. That is honest because a label is a CATEGORY, not a measurement —
// 21:00 genuinely is dinner. The inverse is deliberately NOT done: a stated label
// must never be turned into a stored clock time, because `eaten_at` is rendered
// straight to the athlete, so a derived "12:30" from the word "lunch" would appear
// on screen as a minute they never said and would be indistinguishable — to the UI,
// to the coach, to the brain correlating intake against bloodwork — from one they
// did. A meal whose time is genuinely unknown keeps eaten_at NULL. getDayIntake
// still places it sensibly in the day by using the label's representative hour as a
// read-time SORT key, which is never stored and never shown.
function resolveFoodNoteWhen(
  meal: string,
  opts: FoodNoteWhen | undefined
): { meal: string; date: string; eaten_at: string | null } {
  const { date, eaten_at: statedTime } = canonicalFoodNoteWhen(opts);
  const statedLabel = String(meal ?? "").trim();
  const hasStatedLabel = !GENERIC_MEAL_LABELS.has(statedLabel.toLowerCase());

  const label = hasStatedLabel ? statedLabel : ((statedTime ? mealLabelForTime(statedTime) : null) ?? "meal");
  return { meal: label, date, eaten_at: statedTime };
}

function insertFoodNote(
  meal: string,
  raw: string,
  parsed: any,
  imagePath: string | undefined,
  status: string | null,
  opts?: FoodNoteWhen
) {
  // Stamp the LOCAL calendar day (device-zone aware) the meal belongs to, so an
  // evening log counts toward the right day and a backdated one lands on the day
  // it was eaten. created_at stays the UTC instant of the WRITE — for a backdated
  // note that is emphatically not when the meal happened, which is what `date` and
  // `eaten_at` are for.
  const when = resolveFoodNoteWhen(meal, opts);
  const info = db
    .prepare(
      `INSERT INTO food_notes (date, eaten_at, meal, raw_output, parsed_json, image_path, enrichment_status) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      when.date,
      when.eaten_at,
      when.meal,
      raw || "",
      parsed ? JSON.stringify(parsed) : null,
      imagePath ?? null,
      status
    );
  return hydrate(db.prepare(`SELECT * FROM food_notes WHERE id = ?`).get(info.lastInsertRowid));
}

// Bust the cached Brief for a food entry's local day, and — when that day isn't
// today — today's cache too, since a past-day intake change still feeds the
// trailing-average expenditure/fuel reads that shape today's Brief. Mirrors
// setFuelingFeedback's date-vs-today pattern in fueling.ts.
function invalidateDayReadForDate(d: string): void {
  invalidateDayRead(d);
  if (d !== localDateISO()) invalidateDayRead();
}

function scheduleFoodNoteEffects(row: any, enrichKind: "food" | "food_photo" | null): void {
  afterSqliteCommit(() => {
    bumpFoodDataVersion(); // a new food entry moves the intake average → expenditure read
    const d = row.date || localDateISO();
    queueBrainEvent({ kind: "food_logged", domain: "nutrition", date: d, entity_id: row.id });
    // A new food entry can change what today's Brief should say (fuel target,
    // "already logged" reads).
    invalidateDayReadForDate(d);
    // Lazy import to avoid a circular dependency (enrich.ts imports repo.ts).
    if (enrichKind) import("../enrich.js").then((m) => m.enqueueEnrich(enrichKind, row.id)).catch(() => {});
  });
}

// `opts` is a trailing options object so every existing positional caller keeps
// working untouched: omit it and this behaves exactly as it always did (today, no
// time). Throws RangeError on a date/time it can't honestly store.
export function addFoodNote(meal: string, raw: string, parsed: any, imagePath?: string, opts?: FoodNoteWhen) {
  // Free-text food notes (non-empty raw) get queued for background enrichment —
  // only when enabled, else recorded 'skipped' directly (see addActivity).
  const fromText = !!(raw && String(raw).trim());
  const status = fromText ? (getSettings().enrich_enabled ? "pending" : "skipped") : null;
  const row = insertFoodNote(meal, raw, parsed, imagePath, status, opts);
  scheduleFoodNoteEffects(row, status === "pending" ? "food" : null);
  return row;
}

// Atomic, idempotent food capture for durable chat turns. The chat-turn link and
// food_notes insert share one savepoint, so a crash/recovery replay returns the
// linked row instead of creating a second meal. Text uses the athlete's exact
// utterance and the ordinary text enricher; photos use the dedicated vision job.
export function addChatCaptureFoodNote(input: {
  turn_id: number;
  meal: string;
  raw: string;
  parsed: any;
  image_path?: string | null;
  kind: "text" | "photo";
  // "I forgot to log last night's dinner" said in chat — same trust boundary and
  // same defaults as addFoodNote; omitted means today with no stated time.
  date?: string;
  eaten_at?: string;
}) {
  const turnId = Number(input.turn_id);
  if (!Number.isSafeInteger(turnId) || turnId <= 0) throw new Error("invalid chat turn id");
  // Always lenient: this lane exists only for values a MODEL resolved out of a
  // sentence. A date it guessed badly degrades to today and the meal is still
  // captured — losing the food because the timestamp was wrong would be a far
  // worse failure than filing it on the day it was mentioned.
  const when: FoodNoteWhen = { date: input.date, eaten_at: input.eaten_at, lenient: true };
  return withSqliteSavepoint(`chat_food_capture_${turnId}`, () => {
    const turn = db.prepare(`SELECT status, capture_food_note_id FROM chat_turns WHERE id = ?`).get(turnId) as any;
    if (!turn) throw new Error("chat turn not found");
    if (turn.capture_food_note_id != null) {
      const existing = getFoodNote(Number(turn.capture_food_note_id));
      if (!existing) throw new Error("linked capture food note not found");
      return existing;
    }
    if (!["queued", "running"].includes(String(turn.status))) throw new Error("chat turn is already terminal");

    const enrichEnabled = getSettings().enrich_enabled;
    const status = input.kind === "photo" ? (enrichEnabled ? "pending" : null) : enrichEnabled ? "pending" : "skipped";
    const raw = input.kind === "photo" ? "" : String(input.raw ?? "");
    const row = insertFoodNote(input.meal, raw, input.parsed, input.image_path ?? undefined, status, when);
    const linked = db
      .prepare(`UPDATE chat_turns SET capture_food_note_id = ?
                  WHERE id = ? AND capture_food_note_id IS NULL AND status IN ('queued','running')`)
      .run(row.id, turnId);
    if (Number(linked.changes) !== 1) throw new Error("chat food capture link was not written");
    scheduleFoodNoteEffects(row, status === "pending" ? (input.kind === "photo" ? "food_photo" : "food") : null);
    return row;
  });
}

export function listFoodNotes(limit = 20) {
  return (db.prepare(`SELECT * FROM food_notes ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(hydrate);
}

export function getFoodNote(id: number) {
  return hydrate(db.prepare(`SELECT * FROM food_notes WHERE id = ?`).get(id));
}

export function deleteFoodNote(id: number) {
  const row = getFoodNote(id);
  if (!row) return { deleted: false, id };
  db.prepare(`DELETE FROM food_notes WHERE id = ?`).run(id);
  bumpFoodDataVersion();
  invalidateDayReadForDate(row.date || localDateISO());
  return { deleted: true, id };
}

// Overwrite the parsed_json blob with the enricher's structured estimate.
export function updateFoodNoteParsed(id: number, parsed: any) {
  db.prepare(`UPDATE food_notes SET parsed_json = ? WHERE id = ?`).run(parsed ? JSON.stringify(parsed) : null, id);
  bumpFoodDataVersion(); // enrichment can revise kcal in place (backstop can't see it)
  const updated = getFoodNote(id);
  if (updated) {
    const d = updated.date || localDateISO();
    emitBrainEvent({
      kind: "food_corrected",
      domain: "nutrition",
      date: d,
      entity_id: id,
    });
    invalidateDayReadForDate(d);
  }
  return updated;
}

export function setFoodNoteEnrichStatus(id: number, status: string) {
  db.prepare(`UPDATE food_notes SET enrichment_status = ? WHERE id = ?`).run(status, id);
  const row = getFoodNote(id);
  emitEnrichTransition("food", id, row); // wake any SSE watcher on this row
  return row;
}

// ---------- daily intake review (v41) ----------
// A calm review of ONE day's logged food: the entries (each editable/deletable),
// the running totals, and — only when a real target exists (a loss/gain goal, or
// the maintenance anchor) — a gentle "remaining". Never a score; "remaining",
// never "consumed". The day boundary is the stamped LOCAL calendar day; the
// created_at fallback only keeps legacy rows readable.
export function getDayIntake(date?: string) {
  const d = date || localDateISO();
  // Key by the stamped LOCAL day; COALESCE to the legacy UTC-date-of-created_at
  // guards any pre-migration row that somehow lacks a stamped date.
  const rows = (
    db
      .prepare(`SELECT * FROM food_notes WHERE COALESCE(date, substr(created_at,1,10)) = ? ORDER BY id ASC`)
      .all(d) as any[]
  ).map(hydrate);

  const nutrientKeys = ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const;
  // Compatibility contract: totals/remaining stay numeric, with missing values
  // contributing zero exactly as before. The additive `known` map is the honest
  // detail new consumers use to distinguish a complete sum from a partial one.
  const totals: Record<(typeof nutrientKeys)[number], number> = {
    kcal: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
    fiber_g: 0,
  };
  const known = Object.fromEntries(nutrientKeys.map((key) => [key, false])) as Record<
    (typeof nutrientKeys)[number],
    boolean
  >;
  const entries = rows.map((r) => {
    const p = r.parsed || {};
    return {
      id: r.id,
      meal: r.meal,
      summary: String(p.summary ?? r.raw_output ?? "").trim() || "Food",
      kcal: p.kcal ?? null,
      protein_g: p.protein_g ?? null,
      carbs_g: p.carbs_g ?? null,
      fat_g: p.fat_g ?? null,
      fiber_g: p.fiber_g ?? null,
      nutrition_pattern: p.nutrition_pattern ?? null,
      enrichment_status: r.enrichment_status ?? null,
      created_at: r.created_at,
      // The clock a PERSON sees, local "1:15 PM". Prefers the stated eating time:
      // for a backdated entry created_at is when the meal was REMEMBERED, so
      // showing this morning's capture time against last night's dinner would be
      // flatly wrong. With no stated time this is exactly what it always was — the
      // write-time label — so an unstated time changes nothing.
      logged_at: clockLabel(r.eaten_at) || chatHistoryTimeLabel(r.created_at),
      // The raw local "HH:MM" the athlete said they ate, when they said one. Null
      // is the common case and means exactly that: unstated, not midnight. It is
      // also how a reader tells which clock `logged_at` is showing.
      eaten_at: r.eaten_at ?? null,
    };
  });

  // Read the day in the order things were EATEN, not the order they were typed.
  // The moment notes can be backdated, insertion order stops describing a day at
  // all: last night's dinner, remembered over this morning's coffee, would sort
  // after today's breakfast, and the day would read back as the sequence in which
  // the athlete happened to remember things.
  //
  // Three tiers, ALL computed here at read time and none of them ever written back
  // to the row or shown:
  //   1. the stated `eaten_at` — the only tier that is a recorded fact;
  //   2. the meal label's representative hour, for a named meal with no time —
  //      good enough to place "breakfast" before "dinner", never good enough to
  //      store or display as a time the athlete gave;
  //   3. the last placeable entry's position, so a run of unplaceable rows ("meal",
  //      "snack", a custom label) simply stays where it was logged instead of being
  //      swept to one end. A day where nothing is placeable keeps its exact
  //      previous order.
  // Row id is the final tiebreak, so ties resolve to insertion order and the whole
  // ordering is deterministic — no clock is read here.
  const minuteOfDay = (hhmm: unknown): number | null => {
    const t = normalizeWallClock(hhmm);
    return t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null;
  };
  const placement = new Map<number, number>();
  let carried = -1; // below every real minute, so leading unplaceable rows stay first
  for (const entry of entries) {
    // `entries` is still in id order here, which is what makes the carry meaningful.
    const placed = minuteOfDay(entry.eaten_at) ?? minuteOfDay(approxTimeForMealLabel(entry.meal));
    if (placed != null) carried = placed;
    placement.set(entry.id, placed ?? carried);
  }
  entries.sort((a, b) => (placement.get(a.id) ?? -1) - (placement.get(b.id) ?? -1) || a.id - b.id);

  for (const key of nutrientKeys) {
    const values = entries.map((entry) => entry[key]);
    totals[key] = Math.round(
      values.reduce((sum, value) => sum + (value != null && Number.isFinite(Number(value)) ? Number(value) : 0), 0)
    );
    known[key] = entries.length > 0 && values.every((value) => value != null && Number.isFinite(Number(value)));
  }

  // Target framing: a gentle target/remaining ONLY when the profile is complete
  // enough to derive one. Incomplete profile → descriptive-only (target null).
  let target: { kcal: number; protein_g: number; mode: string; source: string } | null = null;
  let remaining: { kcal: number; protein_g: number } | null = null;
  try {
    const goal: any = computeGoalCheck();
    // Prefer the ACCEPTED target (effective_target) — the persisted output of the
    // adaptive-nutrition loop — over the re-derived formula, so the fuel card shows
    // the number the athlete actually accepted. Falls back to the formula.
    const eff = goal?.effective_target;
    const tk = Number(eff?.target_kcal ?? goal?.recommended?.target_intake_kcal);
    if (goal?.ok && Number.isFinite(tk)) {
      target = {
        kcal: Math.round(tk),
        protein_g: Math.round(Number(eff?.protein_g ?? goal.recommended?.protein_g) || 0),
        mode: String(goal.goal_mode || "maintain"),
        source: String(eff?.source ?? "formula"),
      };
      remaining = {
        kcal: target.kcal - totals.kcal,
        protein_g: target.protein_g - totals.protein_g,
      };
    }
  } catch {
    /* profile incomplete → descriptive-only */
  }

  return { date: d, totals, known, entries, count: entries.length, target, remaining };
}

// Manual correction of a logged food note (fix a macro, rename it, change the meal
// slot, or just "I changed my mind"). Coerced/clamped at the trust boundary like
// coerceMeal, merged over the existing parsed blob. STAMPS enrichment_status
// terminal ('done') so a still-queued background enricher can't later clobber the
// correction — a manual edit is authoritative (mirrors updateTarget's manual path).
// Returns the hydrated row, or null on unknown id.
export function updateFoodNote(id: number, fields: any) {
  const row = getFoodNote(id);
  if (!row) return null;
  const f = fields && typeof fields === "object" ? fields : {};
  const parsed: any = { ...(row.parsed && typeof row.parsed === "object" ? row.parsed : {}) };

  const numField = (key: string, max: number) => {
    if (f[key] === undefined) return;
    if (f[key] === null || f[key] === "") {
      parsed[key] = null;
      return;
    }
    const n = Number(f[key]);
    parsed[key] = Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : null;
  };
  if (f.summary !== undefined) parsed.summary = capStr(f.summary, 200);
  if (f.items !== undefined) {
    parsed.items = Array.isArray(f.items)
      ? f.items
          .slice(0, 30)
          .map((s: any) => capStr(s, 80))
          .filter(Boolean)
      : capStr(f.items, 300);
  }
  if (f.notes !== undefined) parsed.notes = f.notes == null ? null : capStr(f.notes, 500);
  numField("kcal", 5000);
  numField("protein_g", 500);
  numField("carbs_g", 1000);
  numField("fat_g", 500);
  numField("fiber_g", 200);

  db.prepare(`UPDATE food_notes SET parsed_json = ?, enrichment_status = 'done' WHERE id = ?`).run(
    JSON.stringify(parsed),
    id
  );
  if (f.meal !== undefined && f.meal !== null && String(f.meal).trim()) {
    db.prepare(`UPDATE food_notes SET meal = ? WHERE id = ?`).run(String(f.meal).trim().slice(0, 40), id);
  }

  // Correcting WHEN it happened — "that was last night's dinner, not this
  // morning's". Each field moves ONLY when the caller actually sent it, so fixing a
  // macro never restamps the clock, and an untouched year-old row is never
  // re-validated against the backdate bound just because someone edited its kcal.
  // A stated time never re-infers the meal label either: the row already carries a
  // label, and silently relabeling it here would overwrite what someone chose.
  const previousDate = String(row.date || localDateISO());
  const previousTime: string | null = row.eaten_at ?? null;
  const lenient = f.lenient !== false; // see FoodNoteWhen.lenient — REST opts out
  const today = localDateISO();
  let nextDate = previousDate;
  let nextTime = previousTime;
  if (f.date !== undefined) {
    // A blank/null date is "no change", not "unstate": every entry belongs to some
    // day, so there is nothing to fall back to.
    const value = f.date == null ? "" : String(f.date).trim();
    if (value) {
      const problem = foodNoteDateProblem(value, today);
      if (!problem) nextDate = value;
      else if (!lenient) throw new RangeError(problem);
      else console.warn(`[food] note#${id}: keeping ${previousDate} — ${problem}`);
    }
  }
  if (f.eaten_at !== undefined) {
    const value = f.eaten_at == null ? "" : String(f.eaten_at).trim();
    // An explicit blank UNSTATES the time — "I don't actually recall when".
    if (!value) nextTime = null;
    else {
      const normalized = normalizeWallClock(value);
      if (normalized) nextTime = normalized;
      else if (!lenient) throw new RangeError(FOOD_NOTE_TIME_PROBLEM);
      else console.warn(`[food] note#${id}: keeping the stored time — ${FOOD_NOTE_TIME_PROBLEM}`);
    }
  }
  if (nextDate !== previousDate || nextTime !== previousTime) {
    db.prepare(`UPDATE food_notes SET date = ?, eaten_at = ? WHERE id = ?`).run(nextDate, nextTime, id);
  }

  bumpFoodDataVersion(); // an in-place kcal correction the SQL backstop can't see
  const updated = getFoodNote(id);
  // A manual edit stamps enrichment_status 'done' OUTSIDE the queue/setter, so emit
  // here too — a still-open SSE watcher (Fuel card) must see the row settle.
  emitEnrichTransition("food", id, updated);
  const d = updated.date || localDateISO();
  emitBrainEvent({ kind: "food_corrected", domain: "nutrition", date: d, entity_id: id });
  invalidateDayReadForDate(d);
  // A day MOVE changes two days, not one: the day it landed on gained the intake
  // and the day it left no longer has it. invalidateDayReadForDate only knows about
  // an entry's CURRENT day (plus today), so the vacated day would otherwise keep
  // serving a Brief built on food that has since moved elsewhere.
  if (previousDate !== d) {
    emitBrainEvent({ kind: "food_corrected", domain: "nutrition", date: previousDate, entity_id: id });
    invalidateDayReadForDate(previousDate);
  }
  return updated;
}

export function hydrate(row: any) {
  if (!row) return row;
  let parsed: any = null;
  try {
    parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null;
  } catch {
    parsed = null;
  }
  return { ...row, parsed };
}
