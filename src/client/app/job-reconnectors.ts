// @ts-check
// Ordered app-level agent-job reconnector registration. The factories live on
// their owning screens; this module only preserves boot order.

type AppJobReconnectKind =
  | "session_suggest"
  | "meal_plan"
  | "meal_swap"
  | "recipe"
  | "day_read_override"
  | "nutrition_checkin"
  | "insight"
  | "proposal";
type AppJobReconnectFactory = (job?: unknown) => unknown;
type AppJobReconnectEntry = {
  kind: AppJobReconnectKind;
  factory: AppJobReconnectFactory;
};

const APP_JOB_RECONNECTORS: AppJobReconnectEntry[] = [
  { kind: "session_suggest", factory: reconnectSessionSuggest },
  { kind: "meal_plan", factory: reconnectMealPlan },
  { kind: "meal_swap", factory: reconnectMealSwap },
  { kind: "recipe", factory: reconnectRecipe },
  { kind: "day_read_override", factory: reconnectDayReadOverride },
  { kind: "nutrition_checkin", factory: reconnectNutritionCheckin },
  { kind: "insight", factory: reconnectInsight },
  { kind: "proposal", factory: reconnectProposal },
];

function registerAppJobReconnectors(): void {
  for (const { kind, factory } of APP_JOB_RECONNECTORS) {
    registerJobReconnector(kind, factory);
  }
}

Object.assign(globalThis, { registerAppJobReconnectors });

if (typeof window !== "undefined") {
  window.registerAppJobReconnectors = registerAppJobReconnectors;
}
