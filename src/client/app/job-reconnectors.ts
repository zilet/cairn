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
  | "proposal"
  | "health_review"
  | "health_dedupe_check";
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
  { kind: "health_review", factoryName: "reconnectHealthReview" },
  { kind: "health_dedupe_check", factoryName: "reconnectHealthDedupeCheck" },
];

// Factories registered so far. A lazy bundle re-runs this pass when it lands; the
// count of NEW registrations tells the loader whether a reconnect sweep can find
// anything it could not before.
const registeredFactories = new Map<AppJobReconnectKind, unknown>();

/** Register every reconnector whose factory now exists; returns how many are new. */
function registerAppJobReconnectors(): number {
  const root = globalThis as Record<string, unknown>;
  const register = root.registerJobReconnector;
  if (typeof register !== "function") return 0;
  let added = 0;
  for (const { kind, factoryName } of APP_JOB_RECONNECTORS) {
    const factory = root[factoryName];
    if (typeof factory !== "function") continue;
    register(kind, factory as AppJobReconnectFactory);
    if (registeredFactories.get(kind) !== factory) added += 1;
    registeredFactories.set(kind, factory);
  }
  return added;
}

Object.assign(globalThis, { registerAppJobReconnectors });

if (typeof window !== "undefined") {
  window.registerAppJobReconnectors = registerAppJobReconnectors;
}
})();
