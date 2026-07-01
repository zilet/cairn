// @ts-check
// Plan -> Meals compatibility facade. Runtime ownership lives in focused helpers.

type MealPlannerControllerPlan = import("../contracts/client-api.js").ClientMealPlan & {
  id: number | string;
};
type MealPlannerControllerContext = { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null;
type MealPlannerControllerOpOptions = ClientAgentOpHandlers & {
  path: string;
  anchor: string;
  caption: string;
  guard: () => boolean;
  isFail: (result: unknown) => boolean;
  render: (result: unknown) => unknown;
  onFail: (error?: unknown) => unknown;
};

function draftWeeklyMeals(): void {
  CairnMealPlannerJobs.draftWeeklyMeals();
}

function reconnectMealPlan(job?: unknown): ClientAgentOpHandlers | null {
  return CairnMealPlannerJobs.reconnectMealPlan(job);
}

function reconnectStatusHost(
  options: MealPlannerControllerOpOptions,
  statusSelector: string,
  buttonSelector: string | null,
  ghost: boolean,
): ClientAgentOpHandlers | null {
  return CairnMealPlannerJobs.reconnectStatusHost(options, statusSelector, buttonSelector, ghost);
}

function renderMealPlans(plans: unknown, selector = "#meallist", refresh: (() => unknown) | null = null): void {
  CairnMealPlannerActions.renderMealPlans(plans, selector, refresh);
}

function runCoachMealPlan(agent: string, instruction: string): void {
  CairnMealPlannerJobs.runCoachMealPlan(agent, instruction);
}

function verifiedForPlan(id: unknown): unknown {
  return CairnMealPlannerJobs.verifiedForPlan(id);
}

function wireMealPlannerBody(currentPlan: MealPlannerControllerPlan | null, ctx: MealPlannerControllerContext): void {
  CairnMealPlannerActions.wireMealPlannerBody(currentPlan, ctx);
}

const CAIRN_MEAL_PLANNER_CONTROLLER = {
  draftWeeklyMeals,
  reconnectMealPlan,
  reconnectStatusHost,
  renderMealPlans,
  runCoachMealPlan,
  verifiedForPlan,
  wireMealPlannerBody,
};

Object.assign(globalThis, {
  CairnMealPlannerController: CAIRN_MEAL_PLANNER_CONTROLLER,
  reconnectMealPlan,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnMealPlannerController: CAIRN_MEAL_PLANNER_CONTROLLER,
  });
}
