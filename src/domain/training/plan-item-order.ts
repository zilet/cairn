// PLAN ITEM EFFECT-ORDER — compounds before accessories before finishers before cardio.
//
// Session order for maximum effect is a coaching fact, not a preference: heavy
// compounds while fresh, isolation after, core last among strength, cardio after
// the lifts on a mixed day. The athlete can still ↑↓ in the editor; this module
// is the deterministic ladder used when composing/restructuring a week and when
// the Plan gallery offers "Order for effect".
//
// Pure + stable: same inputs → same order; peers in one tier keep their relative
// order (athlete swaps among equals aren't scrambled). Never scores anything.
//
// TIERS ONLY. An earlier draft broke ties inside a tier by loading tool (barbell
// before machine before dumbbell). Read against a real plan that was noise: the
// tool is inferred from the NAME, unknown names default to dumbbell, so a
// chest-supported row leapfrogged a dumbbell bench and a Pendlay row overtook
// pull-ups. Two primaries are peers; the athlete's order among peers stands.

import { classifyPattern, type MovementPattern } from "../../repo/exercise-variations.js";

export type OrderablePlanItem = {
  kind?: string | null;
  exercise?: string | null;
  note?: string | null;
  muscle_group?: string | null;
};

/** Effect tiers — lower sorts earlier. */
export const PLAN_ITEM_EFFECT_TIER = {
  /** Mobility / activation prep — the few minutes BEFORE the first compound. */
  prep: 0,
  primary: 1,
  secondary: 2,
  isolation: 3,
  core: 4,
  cardio: 5,
} as const;

// A prep drill is named as one, or its note says so ("Mobility prep, not working
// volume"). It is never a working set, so it is never demoted behind the compounds
// it exists to warm up.
const PREP_NAME =
  /\b(?:rocker|mobility|activation|warm[- ]?up|stretch|prep|90\/90|hip switch|foam roll|pull[- ]?aparts?|openers?)\b/i;
const PREP_NOTE =
  /\b(?:mobility|activation|warm[- ]?up)\s+(?:prep|drill|work|set)|\bnot working volume\b|\bprep,? not\b/i;

function isPrep(item: OrderablePlanItem): boolean {
  if (isCardio(item)) return false;
  if (PREP_NAME.test(String(item.exercise ?? ""))) return true;
  return PREP_NOTE.test(String(item.note ?? ""));
}

const PRIMARY = new Set<MovementPattern>([
  "squat",
  "hinge",
  "horizontal-push",
  "vertical-push",
  "horizontal-pull",
  "vertical-pull",
  "lunge",
]);

const SECONDARY = new Set<MovementPattern>(["hip-extension", "carry"]);

const ISOLATION = new Set<MovementPattern>([
  "curl",
  "triceps",
  "lateral-raise",
  "rear-delt",
  "calf",
  "abduction",
  "shrug",
  "tibialis",
]);

function isCardio(item: OrderablePlanItem): boolean {
  return String(item?.kind ?? "").toLowerCase() === "cardio";
}

function itemName(item: OrderablePlanItem): string {
  if (isCardio(item)) {
    const note = String(item.note ?? "").trim();
    if (note) return note;
  }
  return String(item.exercise ?? "").trim();
}

/** Tier for one item. Cardio always last; unclassified strength sits with isolation. */
export function planItemEffectTier(item: OrderablePlanItem): number {
  if (isCardio(item)) return PLAN_ITEM_EFFECT_TIER.cardio;
  if (isPrep(item)) return PLAN_ITEM_EFFECT_TIER.prep;
  const pattern = classifyPattern(itemName(item), item.muscle_group ?? undefined);
  if (!pattern) return PLAN_ITEM_EFFECT_TIER.isolation;
  if (PRIMARY.has(pattern)) return PLAN_ITEM_EFFECT_TIER.primary;
  if (SECONDARY.has(pattern)) return PLAN_ITEM_EFFECT_TIER.secondary;
  if (pattern === "core") return PLAN_ITEM_EFFECT_TIER.core;
  if (ISOLATION.has(pattern)) return PLAN_ITEM_EFFECT_TIER.isolation;
  return PLAN_ITEM_EFFECT_TIER.isolation;
}

/**
 * Stable sort into effect order. Returns a new array; does not mutate input.
 * Tier decides; peers in one tier keep their original relative order.
 */
export function orderPlanItemsForEffect<T extends OrderablePlanItem>(items: readonly T[]): T[] {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item, index) => ({ item, index, tier: planItemEffectTier(item) }))
    .sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.index - b.index))
    .map((row) => row.item);
}

/** True when stored order differs from effect order (same items, different sequence). */
export function planItemsOutOfOrder(items: readonly OrderablePlanItem[]): boolean {
  const list = Array.isArray(items) ? items : [];
  if (list.length < 2) return false;
  const ordered = orderPlanItemsForEffect(list);
  for (let i = 0; i < list.length; i++) {
    if (list[i] !== ordered[i]) return true;
  }
  return false;
}

/** Map each day's items into effect order — used by agentic full-plan applies. */
export function orderPlanDaysForEffect<T extends { items?: readonly OrderablePlanItem[] | null | undefined }>(
  days: readonly T[]
): T[] {
  // Preserve the caller's day shape (PlanItemInput[] etc.); we only reorder.
  return (Array.isArray(days) ? days : []).map((day) => ({
    ...day,
    items: orderPlanItemsForEffect(Array.isArray(day.items) ? [...day.items] : []),
  })) as T[];
}
