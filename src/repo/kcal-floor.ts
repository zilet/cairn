// The universal calorie floor, in a leaf module of its own so a module that
// nutrition-safety.ts itself imports (meal-plan-day-energy.ts) can read it without an
// import cycle. nutrition-safety.ts re-exports it; import it from there as before.
export const ABSOLUTE_KCAL_FLOOR = 1500;
