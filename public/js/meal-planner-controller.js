(() => {
// @ts-check
// Plan -> Meals compatibility facade. Runtime ownership lives in focused helpers.
function draftWeeklyMeals() {
    CairnMealPlannerJobs.draftWeeklyMeals();
}
function reconnectMealPlan(job) {
    return CairnMealPlannerJobs.reconnectMealPlan(job);
}
function reconnectStatusHost(options, statusSelector, buttonSelector, ghost) {
    return CairnMealPlannerJobs.reconnectStatusHost(options, statusSelector, buttonSelector, ghost);
}
function renderMealPlans(plans, selector = "#meallist", refresh = null) {
    CairnMealPlannerActions.renderMealPlans(plans, selector, refresh);
}
function runCoachMealPlan(agent, instruction) {
    CairnMealPlannerJobs.runCoachMealPlan(agent, instruction);
}
function verifiedForPlan(id) {
    return CairnMealPlannerJobs.verifiedForPlan(id);
}
function wireMealPlannerBody(currentPlan, ctx) {
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
})();
