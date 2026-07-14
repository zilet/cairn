import { db, todayISO } from "../db.js";
import type { ProposedExpectation } from "../brain/expectation-contract.js";
import { emitBrainEvent } from "../brainEvents.js";
import { emitEnrichTransition } from "../enrichBus.js";
import { recordDecision } from "./brain-decisions.js";
import { estimateExpenditure } from "./expenditure.js";
import { newestHealthDocDate } from "./health.js";
import { computeGoalCheck } from "./profile.js";
import {
  assertMealAllergenSafe,
  assertPlanAllergenSafe,
  assertRecipeAllergenSafe,
  assessMealPlanAdequacy,
  clampNutritionFloors,
} from "./nutrition-safety.js";
import { getSettings } from "./settings.js";
import { localDateISO, chatHistoryTimeLabel } from "./shared.js";
import { bumpFoodDataVersion } from "./training-cache.js";

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

function hydrateNutritionTarget(row: any, referenceDate = localDateISO()): AcceptedNutritionTarget | null {
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
  metric: "weight_trend_lb_wk" | "intake_to_weight_response" = "intake_to_weight_response"
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
  return {
    basis,
    expectation: {
      metric_key: metric,
      subject_key: null,
      direction: "within_band",
      baseline: { target_kcal: targetKcal, basis },
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
        metric === "intake_to_weight_response" ? "nutrition-intake-response-v1" : "nutrition-weight-v1",
    },
  };
}

function recordNutritionTargetDecision(saved: AcceptedNutritionTarget): void {
  try {
    const response =
      saved.target_kcal != null ? nutritionTrendExpectation(saved.target_kcal, saved.effective_date) : null;
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
      response ? [response.expectation] : []
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
  const now = maxUpstreamNutritionSource();
  if (!stamped || !now || now <= stamped) return { stale: false, reason: null, source_ts: stamped };
  return {
    stale: true,
    reason:
      "A newer lab, health directive, weigh-in, or nutrition target has landed since this plan was drafted — worth re-drafting so meals reflect it.",
    source_ts: stamped,
  };
}

export type MealPlanPersistenceCheck =
  | { ok: true; parsed: any; adequacy_checked: boolean }
  | { ok: false; error: string; parsed: any; adequacy_checked: boolean };

const MEAL_PLAN_TARGET_TOLERANCE_KCAL = 100;

// This is the authoritative write/autonomy gate. Goal math already fuses the
// current expenditure estimate and canonical bodyweight. An accepted adaptive
// target is the coordinated reviewed number, not something a later volatile
// formula may silently raise. Thin profiles still receive the absolute 1500-kcal
// floor and the plan's own positive protein target remains authoritative.
export function validateMealPlanForPersistence(parsed: any): MealPlanPersistenceCheck {
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
  const floored =
    parsed && typeof parsed === "object"
      ? clampNutritionFloors(parsed, { kcal: "daily_kcal", protein: "daily_protein_g" }, floorGoal)
      : parsed;
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
    };
  }
  const adequacy = assessMealPlanAdequacy(floored);
  if (!adequacy.ok) return { ok: false, error: adequacy.error, parsed: floored, adequacy_checked: true };
  if (!adequacy.checked) {
    return {
      ok: false,
      error: "Meal plan rejected: a current plan requires 5 to 7 complete days with meal calorie and protein totals.",
      parsed: floored,
      adequacy_checked: false,
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
      };
    }
  }
  return { ok: true, parsed: floored, adequacy_checked: adequacy.checked };
}

export function createMealPlan(agent: string, raw: string, parsed: any) {
  // Stamp the max upstream source at draft time so freshness can later tell whether a
  // newer lipid/health directive has outrun this plan.
  const check = validateMealPlanForPersistence(parsed);
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
  return plan?.id ? { ...plan, autonomy: mealPlanAutonomy(Number(plan.id)) } : plan;
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
    if (adequacy.ok && adequacy.checked) return withMealPlanAutonomy(plan);
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
    practicality: parsed.practicality && typeof parsed.practicality === "object" ? parsed.practicality : null,
    nutrition_pattern:
      parsed.nutrition_pattern && typeof parsed.nutrition_pattern === "object" ? parsed.nutrition_pattern : null,
    today: pick(today, "today"),
    tomorrow: pick(addDaysISO(today, 1), "tomorrow"),
    stale: freshness.stale,
    stale_reason: freshness.reason,
  };
}

export function listMealPlans(limit = 10) {
  const decorate = (plan: any) => {
    // Additive freshness flag so the PWA can show a quiet "worth re-drafting" chip on
    // a live plan that a newer lab/directive has outrun. Only meaningful for a live
    // (draft/accepted) plan; a discarded one is history.
    if (plan.status === "draft" || plan.status === "accepted") {
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
        evaluator_version: response?.expectation.evaluator_version ?? null,
      },
      response ? [response.expectation] : []
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
  const accepted = setMealPlanStatus(id, "accepted", opts);
  if (accepted)
    emitBrainEvent({
      kind: "meal_plan_changed",
      domain: "nutrition",
      date: localDateISO(),
      entity_id: id,
      material: true,
    });
  return accepted;
}

export function getMealPlan(id: number) {
  const row = db.prepare(`SELECT * FROM meal_plans WHERE id = ?`).get(id);
  return row ? withMealPlanAutonomy(hydrate(row)) : null;
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
  return {
    name: capStr(m?.name),
    items: capStr(m?.items),
    kcal: clampNum(m?.kcal, 3000),
    protein_g: clampNum(m?.protein_g, 500),
    carbs_g: clampNum(m?.carbs_g, 500),
    fat_g: clampNum(m?.fat_g, 500),
  };
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
  return updated;
}

// Swap one meal in place (agentic "swap this meal"). Returns { plan, meal }
// with the coerced/clamped meal actually written, or null when the plan/day/
// index can't be found.
export function swapMealInPlan(id: number, day: string, mealIndex: number, meal: any) {
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
  target.meals[idx] = clean;
  const check = validateMealPlanForPersistence(plan.parsed);
  if (!check.ok) throw new Error(check.error);
  db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(check.parsed), id);
  emitBrainEvent({
    kind: "meal_plan_changed",
    domain: "nutrition",
    date: localDateISO(),
    entity_id: id,
    subject_key: `${target.day}:${idx}`,
  });
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
  const clean = coerceRecipe(recipe);
  if (!clean) return null;
  assertRecipeAllergenSafe(
    clean,
    athleteAllergies(),
    `${capStr(target.day, 40) || "meal plan"} meal ${idx + 1} recipe`
  );
  target.meals[idx] = {
    ...(target.meals[idx] && typeof target.meals[idx] === "object" ? target.meals[idx] : {}),
    recipe: clean,
  };
  db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(plan.parsed), planId);
  emitBrainEvent({
    kind: "meal_plan_changed",
    domain: "nutrition",
    date: localDateISO(),
    entity_id: planId,
    subject_key: `${target.day}:${idx}:recipe`,
  });
  return { plan: getMealPlan(planId), recipe: clean };
}

// ---------- food notes ----------
export function addFoodNote(meal: string, raw: string, parsed: any, imagePath?: string) {
  // Free-text food notes (non-empty raw) get queued for background enrichment —
  // only when enabled, else recorded 'skipped' directly (see addActivity).
  const fromText = !!(raw && String(raw).trim());
  const status = fromText ? (getSettings().enrich_enabled ? "pending" : "skipped") : null;
  // Stamp the LOCAL calendar day (device-zone aware) the meal belongs to, so an
  // evening log counts toward the right day; created_at stays the UTC instant.
  const info = db
    .prepare(
      `INSERT INTO food_notes (date, meal, raw_output, parsed_json, image_path, enrichment_status) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(localDateISO(), meal || "meal", raw || "", parsed ? JSON.stringify(parsed) : null, imagePath ?? null, status);
  const row = hydrate(db.prepare(`SELECT * FROM food_notes WHERE id = ?`).get(info.lastInsertRowid));
  bumpFoodDataVersion(); // a new food entry moves the intake average → expenditure read
  emitBrainEvent({ kind: "food_logged", domain: "nutrition", date: row.date || localDateISO(), entity_id: row.id });
  // Lazy import to avoid a circular dependency (enrich.ts imports repo.ts).
  if (status === "pending") {
    import("../enrich.js").then((m) => m.enqueueEnrich("food", row.id)).catch(() => {});
  }
  return row;
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
  return { deleted: true, id };
}

// Overwrite the parsed_json blob with the enricher's structured estimate.
export function updateFoodNoteParsed(id: number, parsed: any) {
  db.prepare(`UPDATE food_notes SET parsed_json = ? WHERE id = ?`).run(parsed ? JSON.stringify(parsed) : null, id);
  bumpFoodDataVersion(); // enrichment can revise kcal in place (backstop can't see it)
  const updated = getFoodNote(id);
  if (updated)
    emitBrainEvent({
      kind: "food_corrected",
      domain: "nutrition",
      date: updated.date || localDateISO(),
      entity_id: id,
    });
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

  const totals = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
  const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const entries = rows.map((r) => {
    const p = r.parsed || {};
    totals.kcal += num(p.kcal);
    totals.protein_g += num(p.protein_g);
    totals.carbs_g += num(p.carbs_g);
    totals.fat_g += num(p.fat_g);
    totals.fiber_g += num(p.fiber_g);
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
      logged_at: chatHistoryTimeLabel(r.created_at), // local "1:15 PM" so the coach can reference WHEN it was eaten
    };
  });
  for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = Math.round(totals[k]);

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
      remaining = { kcal: target.kcal - totals.kcal, protein_g: target.protein_g - totals.protein_g };
    }
  } catch {
    /* profile incomplete → descriptive-only */
  }

  return { date: d, totals, entries, count: entries.length, target, remaining };
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
  bumpFoodDataVersion(); // an in-place kcal correction the SQL backstop can't see
  const updated = getFoodNote(id);
  // A manual edit stamps enrichment_status 'done' OUTSIDE the queue/setter, so emit
  // here too — a still-open SSE watcher (Fuel card) must see the row settle.
  emitEnrichTransition("food", id, updated);
  emitBrainEvent({ kind: "food_corrected", domain: "nutrition", date: updated.date || localDateISO(), entity_id: id });
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
