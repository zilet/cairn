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
  factoryName: string;
};

(() => {
const APP_JOB_RECONNECTORS: AppJobReconnectEntry[] = [
  { kind: "session_suggest", factoryName: "reconnectSessionSuggest" },
  { kind: "meal_plan", factoryName: "reconnectMealPlan" },
  { kind: "meal_swap", factoryName: "reconnectMealSwap" },
  { kind: "recipe", factoryName: "reconnectRecipe" },
  { kind: "day_read_override", factoryName: "reconnectDayReadOverride" },
  { kind: "nutrition_checkin", factoryName: "reconnectNutritionCheckin" },
  { kind: "insight", factoryName: "reconnectInsight" },
  { kind: "proposal", factoryName: "reconnectProposal" },
];

function registerAppJobReconnectors(): void {
  const root = globalThis as Record<string, unknown>;
  const register = root.registerJobReconnector;
  if (typeof register !== "function") return;
  for (const { kind, factoryName } of APP_JOB_RECONNECTORS) {
    const factory = root[factoryName];
    if (typeof factory === "function") register(kind, factory as AppJobReconnectFactory);
  }
}

Object.assign(globalThis, { registerAppJobReconnectors });

if (typeof window !== "undefined") {
  window.registerAppJobReconnectors = registerAppJobReconnectors;
}
})();
