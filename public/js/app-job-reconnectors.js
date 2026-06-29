// @ts-check
// Ordered app-level agent-job reconnector registration. The factories live on
// their owning screens; this module only preserves boot order.
const APP_JOB_RECONNECTORS = [
    { kind: "session_suggest", factory: reconnectSessionSuggest },
    { kind: "meal_plan", factory: reconnectMealPlan },
    { kind: "meal_swap", factory: reconnectMealSwap },
    { kind: "recipe", factory: reconnectRecipe },
    { kind: "day_read_override", factory: reconnectDayReadOverride },
    { kind: "nutrition_checkin", factory: reconnectNutritionCheckin },
    { kind: "insight", factory: reconnectInsight },
    { kind: "proposal", factory: reconnectProposal },
];
function registerAppJobReconnectors() {
    for (const { kind, factory } of APP_JOB_RECONNECTORS) {
        registerJobReconnector(kind, factory);
    }
}
Object.assign(globalThis, { registerAppJobReconnectors });
if (typeof window !== "undefined") {
    window.registerAppJobReconnectors = registerAppJobReconnectors;
}
