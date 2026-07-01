(() => {
// @ts-check
// Meal swap payload/result normalization helpers for Plan -> Meals.
(() => {
    function mealSwapDataRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function mealSwapDataRows(value) {
        return Array.isArray(value)
            ? value.filter((row) => !!row && typeof row === "object")
            : [];
    }
    function mealSwapDataPlan(value) {
        return mealSwapDataRecord(value);
    }
    function mealSwapDataPlans(value) {
        return mealSwapDataRows(value);
    }
    function mealSwapDataParsed(value) {
        return mealSwapDataRecord(value);
    }
    function mealSwapDataDays(plan) {
        const parsed = mealSwapDataParsed(plan.parsed);
        return Array.isArray(parsed.days) ? parsed.days : [];
    }
    function mealSwapDataErrorMessage(value) {
        const error = mealSwapDataRecord(value).error;
        return typeof error === "string" ? error : undefined;
    }
    function mealSwapDataCacheKey() {
        return typeof MEALS_KEY === "string" && MEALS_KEY ? MEALS_KEY : "meals:plans";
    }
    const CAIRN_MEAL_SWAP_DATA = {
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
})();
