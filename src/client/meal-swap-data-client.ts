// @ts-check
// Meal swap payload/result normalization helpers for Plan -> Meals.

(() => {
function mealSwapDataRecord(value: unknown): ClientMealSwapRecord {
  return value && typeof value === "object" ? value as ClientMealSwapRecord : {};
}

function mealSwapDataRows<T extends ClientMealSwapRecord = ClientMealSwapRecord>(value: unknown): T[] {
  return Array.isArray(value)
    ? value.filter((row): row is T => !!row && typeof row === "object")
    : [];
}

function mealSwapDataPlan(value: unknown): ClientMealSwapPlan {
  return mealSwapDataRecord(value) as ClientMealSwapPlan;
}

function mealSwapDataPlans(value: unknown): ClientMealSwapPlan[] {
  return mealSwapDataRows<ClientMealSwapPlan>(value);
}

function mealSwapDataParsed(value: unknown): ClientMealSwapParsed {
  return mealSwapDataRecord(value) as ClientMealSwapParsed;
}

function mealSwapDataDays(plan: { parsed?: unknown }): ClientMealSwapDay[] {
  const parsed = mealSwapDataParsed(plan.parsed);
  return Array.isArray(parsed.days) ? parsed.days : [];
}

function mealSwapDataErrorMessage(value: unknown): string | undefined {
  const error = mealSwapDataRecord(value).error;
  return typeof error === "string" ? error : undefined;
}

function mealSwapDataCacheKey(): string {
  return typeof MEALS_KEY === "string" && MEALS_KEY ? MEALS_KEY : "meals:plans";
}

const CAIRN_MEAL_SWAP_DATA: ClientMealSwapData = {
  record: mealSwapDataRecord,
  rows: mealSwapDataRows,
  plan: mealSwapDataPlan,
  plans: mealSwapDataPlans,
  parsed: mealSwapDataParsed,
  days: mealSwapDataDays,
  errorMessage: mealSwapDataErrorMessage,
  cacheKey: mealSwapDataCacheKey,
};

Object.assign(globalThis, { CairnMealSwapData: CAIRN_MEAL_SWAP_DATA });

if (typeof window !== "undefined") {
  window.CairnMealSwapData = CAIRN_MEAL_SWAP_DATA;
}
})();
