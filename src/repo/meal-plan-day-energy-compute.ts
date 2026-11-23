// The server's own per-day split for a weekly meal plan (see meal-plan-day-energy.ts for
// the contract). Kept apart from the pure half so the persistence gate in nutrition.ts can
// read a stored split without importing the training reads this computation needs.
import { cutIntakeFloorAt } from "./cut-target.js";
import { dayEnergyTarget } from "./day-energy.js";
import { type MealPlanDayEnergy, mealPlanWeekDates, shapeMealPlanDayEnergy } from "./meal-plan-day-energy.js";
import { mealPlanFloorReference } from "./nutrition.js";
import { ABSOLUTE_KCAL_FLOOR } from "./nutrition-safety.js";
import { localDateISO } from "./shared.js";
import { addDaysISO, mondayOf } from "../lib/dates.js";

/**
 * The lowest number a plan day may carry: the absolute calorie floor, raised to a running
 * cut's own intake floor (cut-target.ts `cutIntakeFloorAt`, measured maintenance less the
 * largest deficit the cut would ever prescribe) when there is one.
 */
export function mealPlanDayFloor(asOf: string = localDateISO()): number {
  let cut: number | null = null;
  try {
    cut = cutIntakeFloorAt(asOf);
  } catch {
    cut = null;
  }
  return Math.max(ABSOLUTE_KCAL_FLOOR, Number.isFinite(Number(cut)) ? Number(cut) : 0);
}

/**
 * The split for a plan drafted on `draftDate` (default today) around the accepted weekly
 * `average`. Null when nothing moves — the plan is then planned and checked flat. Never
 * throws.
 */
export function computeMealPlanDayEnergy(opts: {
  average: number | null | undefined;
  draftDate?: string;
  today?: string;
}): MealPlanDayEnergy | null {
  try {
    const average = Math.round(Number(opts.average));
    if (!Number.isFinite(average) || average <= ABSOLUTE_KCAL_FLOOR) return null;
    const today = opts.today || localDateISO();
    const dates = mealPlanWeekDates(opts.draftDate || today);
    if (dates.length !== 7) return null;
    const days = dates.map((date) => {
      const day = dayEnergyTarget(date, average, { today });
      return { date, kcal: day.kcal, work: day.work };
    });
    // Each day is that date's own number (the one Intake shows); a window straddling two
    // weeks settles on the week not yet opened first, whose numbers are still provisional.
    return shapeMealPlanDayEnergy({
      from: dates[0],
      average,
      floor: mealPlanDayFloor(today),
      days,
      settleFirstFrom: addDaysISO(mondayOf(today), 7),
    });
  } catch {
    return null;
  }
}

/**
 * The split a meal plan drafted now would carry, around the coordinated weekly target the
 * persistence gate holds the plan's headline to (`mealPlanFloorReference`). No coordinated
 * target means no split: the plan is planned flat. Computed ONCE per draft by the drafting
 * op and handed to both the prompt and the stored plan, so the numbers the model was shown
 * are the numbers it is checked against.
 */
export function draftMealPlanDayEnergy(opts: { today?: string } = {}): MealPlanDayEnergy | null {
  let average = Number.NaN;
  try {
    average = Number(mealPlanFloorReference().coordinatedTarget);
  } catch {
    average = Number.NaN;
  }
  return computeMealPlanDayEnergy({ average, today: opts.today });
}
