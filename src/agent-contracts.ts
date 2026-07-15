// Pure semantic acceptance contracts for agent-produced intelligence.
//
// Parsing JSON only proves syntax. These predicates define the smallest useful
// shape each operation must produce before the shared rotation may stop. They do
// not coerce, persist, or apply anything; domain safety clamps still run after
// acceptance. Keeping them pure makes the fallback boundary deterministic and
// directly testable across one-shot and streaming agent paths.

import { assessMealPlanAdequacy } from "./repo/nutrition-safety.js";

type JsonObject = Record<string, any>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function text(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value: unknown): boolean {
  return Number.isFinite(Number(value));
}

function positive(value: unknown): boolean {
  return finite(value) && Number(value) > 0;
}

export function isSessionSuggestionResult(value: unknown): boolean {
  const p = object(value);
  if (!p || !text(p.name) || !text(p.why) || !Array.isArray(p.items) || !p.items.length) return false;
  return p.items.every((raw: unknown) => {
    const item = object(raw);
    if (!item || !text(item.exercise)) return false;
    if (item.kind === "cardio") return positive(item.target_duration_min) || positive(item.target_distance_km);
    return positive(item.sets);
  });
}

export function isPlanProposalResult(value: unknown): boolean {
  const p = object(value);
  if (!p || !text(p.summary)) return false;
  const hasChanges = Array.isArray(p.changes);
  const hasCardio = Array.isArray(p.cardio);
  const hasDays = Array.isArray(p.days);
  if (!hasChanges && !hasCardio && !hasDays) return false;

  const changesOk = !hasChanges || p.changes.every((raw: unknown) => {
    const change = object(raw);
    if (!change || !Number.isInteger(Number(change.day_number))) return false;
    const swap = object(change.swap);
    return text(change.exercise) || !!(swap && text(swap.from) && text(swap.to));
  });
  const cardioOk = !hasCardio || p.cardio.every((raw: unknown) => {
    const item = object(raw);
    return !!item && Number.isInteger(Number(item.day_number)) && text(item.label);
  });
  const daysOk = !hasDays || (p.days.length > 0 && p.days.every((raw: unknown) => {
    const day = object(raw);
    return !!day && Number.isInteger(Number(day.day_number)) && text(day.name) && Array.isArray(day.items) && day.items.length > 0;
  }));
  return changesOk && cardioOk && daysOk;
}

export function hasPlanProposalActions(value: unknown): boolean {
  const p = object(value);
  return !!p && [p.changes, p.cardio, p.days].some((items) => Array.isArray(items) && items.length > 0);
}

export function isExerciseExplanationResult(value: unknown): boolean {
  const root = object(value);
  const p = object(root?.explanation) ?? root;
  return !!p && text(p.setup) && text(p.move) && text(p.feel);
}

const WEEK_KINDS = new Set(["lift", "run", "mixed", "rest"]);

export function isWeekAheadResult(value: unknown): boolean {
  const p = object(value);
  if (!p || !Array.isArray(p.days) || p.days.length < 3 || p.days.length > 7 || !text(p.summary)) return false;
  return p.days.every((raw: unknown) => {
    const day = object(raw);
    return !!day && WEEK_KINDS.has(String(day.kind)) && text(day.label);
  });
}

export function isMealPlanStructureResult(value: unknown): boolean {
  const p = object(value);
  if (
    !p ||
    !positive(p.daily_kcal) ||
    !positive(p.daily_protein_g) ||
    !positive(p.daily_fiber_g) ||
    !Array.isArray(p.days)
  )
    return false;
  if (p.days.length < 5 || p.days.length > 7) return false;
  return p.days.every((rawDay: unknown) => {
    const day = object(rawDay);
    if (!day || !text(day.day) || !Array.isArray(day.meals) || !day.meals.length) return false;
    return day.meals.every((rawMeal: unknown) => {
      const meal = object(rawMeal);
      return (
        !!meal &&
        text(meal.name) &&
        positive(meal.kcal) &&
        finite(meal.protein_g) &&
        Number(meal.protein_g) >= 0 &&
        finite(meal.fiber_g) &&
        Number(meal.fiber_g) >= 0
      );
    });
  });
}

export function isMealPlanResult(value: unknown): boolean {
  return isMealPlanStructureResult(value) && assessMealPlanAdequacy(value).ok;
}

export function isNutritionCheckinResult(value: unknown): boolean {
  const p = object(value);
  if (!p || typeof p.change !== "boolean" || !text(p.summary)) return false;
  if (!p.change) return true;
  const nutrition = object(p.nutrition);
  return !!nutrition && positive(nutrition.target_kcal) && positive(nutrition.protein_g);
}

export function isMealSwapResult(value: unknown): boolean {
  const p = object(value);
  return (
    !!p &&
    text(p.name) &&
    positive(p.kcal) &&
    finite(p.protein_g) &&
    Number(p.protein_g) >= 0 &&
    finite(p.fiber_g) &&
    Number(p.fiber_g) >= 0
  );
}

export function isRecipeResult(value: unknown): boolean {
  const p = object(value);
  if (!p) return false;
  const ingredients = Array.isArray(p.ingredients) ? p.ingredients : [];
  const steps = Array.isArray(p.steps) ? p.steps : [];
  return ingredients.some((x: unknown) => text(object(x)?.item)) || steps.some(text);
}

export function isHealthReviewResult(value: unknown): boolean {
  const p = object(value);
  if (!p) return false;
  const focus = Array.isArray(p.focus) && p.focus.some((x: unknown) => text(object(x)?.title));
  const watchlist = Array.isArray(p.watchlist) && p.watchlist.some((x: unknown) => text(object(x)?.marker));
  return text(p.headline) || focus || watchlist;
}

export function isHealthSynthesisResult(value: unknown): boolean {
  const root = object(value);
  const p = object(root?.synthesis) ?? root;
  return !!p && p.found !== false && (text(p.headline) || text(p.story));
}

export function isInsightResult(value: unknown): boolean {
  const p = object(value);
  if (!p || typeof p.found !== "boolean") return false;
  return p.found === false || text(p.text);
}

export function isReconciliationResult(value: unknown): boolean {
  const p = object(value);
  return !!p && Array.isArray(p.groups);
}

export function isReactionNarrativeResult(value: unknown): boolean {
  return text(object(value)?.narrative);
}

export function isVerifyResult(value: unknown, validateDraft: (draft: unknown) => boolean): boolean {
  const p = object(value);
  if (!p || typeof p.ok !== "boolean" || !Array.isArray(p.violations)) return false;
  if (p.ok) return p.violations.length === 0 && (p.fixed_draft == null);
  return p.violations.some(text) && !!object(p.fixed_draft) && validateDraft(p.fixed_draft);
}
