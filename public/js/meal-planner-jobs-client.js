(() => {
// @ts-check
// Plan -> Meals planner job/cache state: draft ops, verification memory, reconnect.
// SWR cache keys for the meals journal. Drafts/swaps/reorders/recipes mutate the
// plan server-side or in memory, so writes invalidate MEALS_KEY. MEALS_SETTINGS_KEY
// caches /settings for the verbatim meal_prefs that ride along into the journal.
var MEALS_KEY = "meals:plans";
var MEALS_SETTINGS_KEY = "meals:settings";
const mealPlannerJobVerifiedByPlan = new Map();
function mealPlannerJobRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function mealPlannerJobErrorMessage(value) {
    const error = mealPlannerJobRecord(value).error;
    return typeof error === "string" ? error : undefined;
}
function mealPlannerJobRestoreBusy(value) {
    value?._busyRestore?.();
}
function mealPlannerDraftFailLine(err) {
    if (mealPlannerJobRecord(err).agent_status === "unconfigured")
        return "Drafting a plan needs a coaching agent — connect one in Settings.";
    if (err)
        return "The coach replied but didn't return a plan — try again.";
    return "Couldn't reach the coach — check your connection.";
}
function mealPlannerRememberVerified(r) {
    const row = mealPlannerJobRecord(r);
    if (row.ok && row.plan && row.plan.id != null && row.verified && row.verified.checked) {
        mealPlannerJobVerifiedByPlan.set(row.plan.id, row.verified);
    }
}
function mealPlannerVerifiedForPlan(id) {
    return id == null ? null : mealPlannerJobVerifiedByPlan.get(id) || null;
}
function mealPlannerCacheKey() {
    return MEALS_KEY;
}
function mealPlannerSettingsCacheKey() {
    return MEALS_SETTINGS_KEY;
}
function mealPlannerJobRunCoachMealPlan(agent, instruction) {
    const status = $("#mealstatus");
    const btn = $("#mealbtn");
    if (btn)
        btnBusy(btn, "Drafting…");
    if (status)
        status.innerHTML = CairnUi.jobCaptionHtml();
    runOp("meal_plan", { agent, instruction }, mealPlannerJobCoachMealPlanOpOpts());
}
function mealPlannerJobCoachMealPlanOpOpts() {
    return {
        path: "/coach/mealplan",
        anchor: "#mealstatus",
        caption: "meal_plan",
        guard: () => !$("#mealstatus")?.isConnected,
        isFail: (r) => {
            const row = mealPlannerJobRecord(r);
            return row.ok !== true || !row.plan;
        },
        render: async (r) => {
            mealPlannerRememberVerified(r);
            const status = $("#mealstatus");
            if (status)
                status.textContent = "Meal plan ready.";
            const btn = $("#mealbtn");
            mealPlannerJobRestoreBusy(btn);
            swrInvalidate(MEALS_KEY);
            try {
                CairnMealPlannerController.renderMealPlans(await api("/mealplans?limit=8"));
            }
            catch { }
        },
        onFail: (err) => {
            const status = $("#mealstatus");
            if (status)
                status.textContent = mealPlannerDraftFailLine(err);
            const btn = $("#mealbtn");
            mealPlannerJobRestoreBusy(btn);
        },
    };
}
function mealPlannerJobDraftWeeklyMeals() {
    const draftBtn = view.querySelector("#mealDraftBtn");
    const status = view.querySelector("#mealDraftStatus");
    if (!status)
        return;
    if (draftBtn)
        btnBusy(draftBtn, "Drafting…", { ghost: true });
    status.innerHTML = CairnUi.jobCaptionHtml();
    runOp("meal_plan", { agent: "auto" }, mealPlannerJobMealPlanDraftOpOpts());
}
function mealPlannerJobMealPlanDraftOpOpts() {
    return {
        path: "/coach/mealplan",
        anchor: "#mealDraftStatus",
        caption: "meal_plan",
        guard: () => !view.querySelector("#mealDraftStatus")?.isConnected,
        isFail: (r) => {
            const row = mealPlannerJobRecord(r);
            return row.ok !== true || !row.plan;
        },
        render: (r) => {
            mealPlannerRememberVerified(r);
            toast("Meal plan drafted");
            swrInvalidate(MEALS_KEY);
            renderMeals();
        },
        onFail: (err) => {
            const s = view.querySelector("#mealDraftStatus");
            if (s)
                s.textContent = mealPlannerDraftFailLine(err);
            const b = view.querySelector("#mealDraftBtn");
            mealPlannerJobRestoreBusy(b);
        },
    };
}
function mealPlannerJobReconnectStatusHost(o, statusSel, btnSel, ghost) {
    const status = view.querySelector(statusSel);
    if (!status)
        return null;
    const btn = btnSel ? view.querySelector(btnSel) : null;
    if (btn)
        btnBusy(btn, "Drafting…", { ghost });
    status.innerHTML = CairnUi.jobCaptionHtml();
    let stop = () => { };
    const capEl = status.querySelector(".job-cap");
    if (capEl)
        stop = thinkingCaption(capEl, o.caption);
    if (!reducedMotion())
        status.classList.add("is-thinking");
    const clear = () => {
        stop();
        const s = view.querySelector(statusSel);
        if (s) {
            s.classList.remove("is-thinking", "is-thinking--determinate");
            s.style.removeProperty("--frac");
        }
    };
    return {
        guard: o.guard,
        onDone: (result) => { clear(); if (o.isFail(result))
            o.onFail(result);
        else
            o.render(result); },
        onError: () => { clear(); o.onFail(null); },
        onCanceled: () => { clear(); o.onFail(null); },
    };
}
function mealPlannerJobReconnectMealPlan() {
    if (view.querySelector("#mealDraftStatus")) {
        return mealPlannerJobReconnectStatusHost(mealPlannerJobMealPlanDraftOpOpts(), "#mealDraftStatus", "#mealDraftBtn", true);
    }
    if (view.querySelector("#mealstatus")) {
        return mealPlannerJobReconnectStatusHost(mealPlannerJobCoachMealPlanOpOpts(), "#mealstatus", "#mealbtn", false);
    }
    return null;
}
const CAIRN_MEAL_PLANNER_JOBS = {
    cacheKey: mealPlannerCacheKey,
    coachMealPlanOpOpts: mealPlannerJobCoachMealPlanOpOpts,
    draftFailLine: mealPlannerDraftFailLine,
    draftWeeklyMeals: mealPlannerJobDraftWeeklyMeals,
    errorMessage: mealPlannerJobErrorMessage,
    mealPlanDraftOpOpts: mealPlannerJobMealPlanDraftOpOpts,
    reconnectMealPlan: mealPlannerJobReconnectMealPlan,
    reconnectStatusHost: mealPlannerJobReconnectStatusHost,
    rememberVerified: mealPlannerRememberVerified,
    restoreBusy: mealPlannerJobRestoreBusy,
    runCoachMealPlan: mealPlannerJobRunCoachMealPlan,
    settingsCacheKey: mealPlannerSettingsCacheKey,
    verifiedForPlan: mealPlannerVerifiedForPlan,
};
Object.assign(globalThis, {
    MEALS_KEY,
    MEALS_SETTINGS_KEY,
    CairnMealPlannerJobs: CAIRN_MEAL_PLANNER_JOBS,
    reconnectMealPlan: mealPlannerJobReconnectMealPlan,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnMealPlannerJobs: CAIRN_MEAL_PLANNER_JOBS,
    });
}
})();
