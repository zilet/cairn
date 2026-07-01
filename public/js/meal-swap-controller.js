(() => {
// @ts-check
// Plan -> Meals row interactions: log planned meals, swap/reorder rows, and reconnect durable swap jobs.
function mealSwapControllerHtmlElement(value) {
    return value instanceof HTMLElement ? value : null;
}
function mealSwapControllerRestoreBusy(value) {
    value?._busyRestore?.();
}
function rerenderMealDay(current, dayIndex, ctx, settleMealIndex = null) {
    const section = view.querySelector(`.mealday[data-mday="${dayIndex}"]`);
    const day = CairnMealSwapData.days(current)[dayIndex];
    if (!section || !day)
        return;
    const tmp = document.createElement("div");
    tmp.innerHTML = CairnMealPlan.mealDayHtml(day, dayIndex, ctx || {});
    const fresh = mealSwapControllerHtmlElement(tmp.firstElementChild);
    if (!fresh)
        return;
    fresh.classList.remove("reveal");
    section.replaceWith(fresh);
    wireMealRows(fresh, current, ctx);
    runCountUps(fresh);
    if (settleMealIndex != null)
        fresh.querySelector(`.meal-row[data-mi="${settleMealIndex}"]`)?.classList.add("meal-settled");
}
async function submitMealSwap(current, ctx, dayIndex, mealIndex, panel) {
    const day = CairnMealSwapData.days(current)[dayIndex];
    if (!day)
        return;
    const row = mealSwapControllerHtmlElement(panel.previousElementSibling);
    if (row && row.classList.contains("meal-busy")) {
        toast("A swap is already running");
        return;
    }
    const hint = panel.querySelector(".meal-swap-hint")?.value.trim() || "";
    const go = panel.querySelector(".meal-swap-go");
    if (row) {
        row.classList.add("meal-busy");
        row.querySelector(".meal-cap")?.remove();
        row.insertAdjacentHTML("beforeend", CairnUi.jobCaptionHtml({ className: "meal-cap job-cap" }));
    }
    panel.classList.add("meal-swap-busy");
    btnBusy(go, "Asking the coach…", { ghost: true });
    panel.querySelectorAll("button,input").forEach((el) => {
        if (el !== go && (el instanceof HTMLButtonElement || el instanceof HTMLInputElement))
            el.disabled = true;
    });
    const body = hint ? { day: day.day, meal_index: mealIndex, hint } : { day: day.day, meal_index: mealIndex };
    await runOp("meal_swap", { id: current.id, ...body }, mealSwapOpOpts(current, ctx, dayIndex, mealIndex));
}
function mealSwapOpOpts(current, ctx, dayIndex, mealIndex) {
    const rowSel = `.mealday[data-mday="${dayIndex}"] .meal-row[data-mi="${mealIndex}"]`;
    return {
        path: `/meal-plans/${current.id}/swap`,
        anchor: rowSel,
        caption: "meal_swap",
        guard: () => !view.querySelector(rowSel)?.isConnected,
        isFail: (result) => {
            const row = CairnMealSwapData.record(result);
            const plan = CairnMealSwapData.plan(row.plan);
            return row.ok !== true || !(plan.parsed || row.meal);
        },
        render: (result) => {
            const row = CairnMealSwapData.record(result);
            const plan = CairnMealSwapData.plan(row.plan);
            if (plan.parsed)
                current.parsed = CairnMealSwapData.parsed(plan.parsed);
            else {
                const day = CairnMealSwapData.days(current)[dayIndex];
                if (day?.meals)
                    day.meals[mealIndex] = CairnMealSwapData.record(row.meal);
            }
            swrInvalidate(CairnMealSwapData.cacheKey());
            rerenderMealDay(current, dayIndex, ctx, mealIndex);
            toast("Meal swapped");
        },
        onFail: () => {
            const row = view.querySelector(rowSel);
            if (row) {
                row.classList.remove("meal-busy");
                row.querySelector(".meal-cap")?.remove();
            }
            const panel = mealSwapControllerHtmlElement(row?.nextElementSibling);
            if (panel && panel.classList.contains("meal-swap")) {
                panel.classList.remove("meal-swap-busy");
                panel.querySelectorAll("button,input").forEach((el) => {
                    if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement)
                        el.disabled = false;
                });
                const go = panel.querySelector(".meal-swap-go");
                mealSwapControllerRestoreBusy(go);
            }
            toast("Coach couldn't draft a swap — try again");
        },
    };
}
function reconnectMealSwap(job) {
    const input = CairnMealSwapData.record(CairnMealSwapData.record(job).input);
    const planId = Number(input.id);
    const cached = CairnMealSwapData.plans(peekCached(CairnMealSwapData.cacheKey())?.data || []);
    const current = cached.find((plan) => Number(plan.id) === planId);
    if (!current || !CairnMealSwapData.days(current).length)
        return null;
    const dayIndex = CairnMealSwapData.days(current).findIndex((day) => String(day?.day ?? "").trim().toLowerCase() === String(input.day ?? "").trim().toLowerCase());
    const mealIndex = Number(input.meal_index);
    if (dayIndex < 0 || !Number.isFinite(mealIndex))
        return null;
    const ctx = CairnMealPlan.mealsCtxFor(current);
    const rowSel = `.mealday[data-mday="${dayIndex}"] .meal-row[data-mi="${mealIndex}"]`;
    const row = view.querySelector(rowSel);
    if (!row)
        return null;
    row.classList.add("meal-busy");
    row.querySelector(".meal-cap")?.remove();
    row.insertAdjacentHTML("beforeend", CairnUi.jobCaptionHtml({ className: "meal-cap job-cap" }));
    const options = mealSwapOpOpts(current, ctx, dayIndex, mealIndex);
    let stop = () => { };
    const capEl = row.querySelector(".job-cap");
    if (capEl)
        stop = thinkingCaption(capEl, options.caption);
    if (!reducedMotion())
        row.classList.add("is-thinking");
    const clear = () => {
        stop();
        const liveRow = view.querySelector(rowSel);
        if (liveRow) {
            liveRow.classList.remove("is-thinking", "is-thinking--determinate");
            liveRow.style.removeProperty("--frac");
        }
    };
    return {
        guard: options.guard,
        onDone: (result) => {
            clear();
            if (options.isFail(result))
                options.onFail(result);
            else
                options.render(result);
        },
        onError: () => {
            clear();
            options.onFail(null);
        },
        onCanceled: () => {
            clear();
            options.onFail(null);
        },
    };
}
async function moveMealRow(current, ctx, dayIndex, mealIndex, direction) {
    const days = CairnMealSwapData.days(current);
    const meals = days[dayIndex]?.meals;
    const nextIndex = mealIndex + direction;
    if (!meals || mealIndex < 0 || mealIndex >= meals.length || nextIndex < 0 || nextIndex >= meals.length)
        return;
    const token = pollToken;
    [meals[mealIndex], meals[nextIndex]] = [meals[nextIndex], meals[mealIndex]];
    rerenderMealDay(current, dayIndex, ctx, nextIndex);
    try {
        const result = await api(`/meal-plans/${current.id}/days`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ days }),
        });
        if (CairnMealSwapData.errorMessage(result))
            throw new Error(CairnMealSwapData.errorMessage(result));
        swrInvalidate(CairnMealSwapData.cacheKey());
    }
    catch {
        [meals[mealIndex], meals[nextIndex]] = [meals[nextIndex], meals[mealIndex]];
        if (token === pollToken) {
            rerenderMealDay(current, dayIndex, ctx);
            toast("Couldn't save order — reverted");
        }
    }
}
function wireMealRows(scope, current, ctx) {
    const rowActions = globalThis.CairnMealSwapRowActionsController;
    rowActions?.wireMealRows(scope, current, ctx, {
        data: CairnMealSwapData,
        mealPlan: CairnMealPlan,
        recipeController: CairnMealRecipeController,
        api,
        toast,
        submitMealSwap,
        moveMealRow,
    });
}
const CAIRN_MEAL_SWAP_CONTROLLER = {
    mealSwapOpOpts,
    moveMealRow,
    reconnectMealSwap,
    submitMealSwap,
    wireMealRows,
};
Object.assign(globalThis, {
    CairnMealSwapController: CAIRN_MEAL_SWAP_CONTROLLER,
    reconnectMealSwap,
});
if (typeof window !== "undefined") {
    window.CairnMealSwapController = CAIRN_MEAL_SWAP_CONTROLLER;
}
})();
