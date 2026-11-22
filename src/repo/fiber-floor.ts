// The ONE fiber rule. Every read that names a daily fiber number (the day's food guides,
// the multi-week nutrition progress reference, the meal-plan floor's base) reads it here,
// so the card, the progress read and the planner cannot say three different numbers.
//
// The rule: 14 g per 1,000 kcal of the day's energy target, and never under 30 g.
//   - 14 g / 1,000 kcal is the Adequate Intake basis of the National Academies (IOM)
//     "Dietary Reference Intakes for Energy, Carbohydrate, Fiber, Fat, Fatty Acids,
//     Cholesterol, Protein, and Amino Acids" (2002/2005), restated by the Dietary
//     Guidelines for Americans 2020-2025.
//   - 30 g is the longevity floor Cairn already held (MEAL_PLAN_FIBER_FLOOR_G): the
//     WHO-commissioned meta-analyses (Reynolds et al., "Carbohydrate quality and human
//     health", Lancet 2019) found the lowest risk from about 25-29 g a day upward.
// So on a cut's smaller target the floor stays 30 g; a bigger target scales it up.
import { MEAL_PLAN_FIBER_FLOOR_G } from "./nutrition-safety.js";

/** The fixed floor no day goes under (the meal-plan floor, one constant). */
export const FIBER_FLOOR_G = MEAL_PLAN_FIBER_FLOOR_G;
/** The energy-scaled part of the rule: grams of fiber per 1,000 kcal of the target. */
export const FIBER_G_PER_1000_KCAL = 14;

/** The day's fiber floor in whole grams for an energy target; the fixed floor without one. */
export function fiberFloorG(targetKcal?: number | null): number {
  const kcal = Number(targetKcal);
  const scaled = Number.isFinite(kcal) && kcal > 0 ? Math.round((kcal / 1000) * FIBER_G_PER_1000_KCAL) : 0;
  return Math.max(FIBER_FLOOR_G, scaled);
}
