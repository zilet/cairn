// The one step every day-energy number moves in (repo/day-energy.ts), in a module of its
// own so the pure meal-plan split (repo/meal-plan-day-energy.ts) can settle its window in
// the same fifties without importing the training reads day-energy needs.

/** Every shift, plan and outcome, is a multiple of this: the costs are too rough to say a day to the ten. */
export const DAY_SHIFT_STEP_KCAL = 50;

/** `n` said in the step (`|| 0` folds a rounded -0 into 0). */
export const inSteps = (n: number): number => Math.round(n / DAY_SHIFT_STEP_KCAL) * DAY_SHIFT_STEP_KCAL || 0;
