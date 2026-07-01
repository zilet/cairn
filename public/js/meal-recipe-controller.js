(() => {
// @ts-check
// Plan -> Meals recipe sheet lifecycle and durable recipe-job reconnection.
function mealRecipeControllerRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function mealRecipeControllerRows(value) {
    return Array.isArray(value)
        ? value.filter((row) => !!row && typeof row === "object")
        : [];
}
function mealRecipeControllerPlan(value) {
    return mealRecipeControllerRecord(value);
}
function mealRecipeControllerPlans(value) {
    return mealRecipeControllerRows(value);
}
function mealRecipeControllerParsed(value) {
    return mealRecipeControllerRecord(value);
}
function mealRecipeControllerDays(plan) {
    const parsed = mealRecipeControllerParsed(plan.parsed);
    return Array.isArray(parsed.days) ? parsed.days : [];
}
function mealRecipeControllerCacheKey() {
    return typeof MEALS_KEY === "string" && MEALS_KEY ? MEALS_KEY : "meals:plans";
}
function mealRecipeControllerWrapSelector(key) {
    return `.sheet[data-key="${String(key || "")}"] [data-recipe]`;
}
function mealRecipeControllerRecipeCtaHtml() {
    return CairnMealRecipe.ctaHtml();
}
function mealRecipeControllerRecipeHtml(recipe) {
    return CairnMealRecipe.recipeHtml(recipe);
}
function mealRecipeControllerLoadingHtml() {
    return CairnMealRecipe.loadingHtml();
}
function closeMealSheet(instant = false) {
    const sheet = document.querySelector(".sheet");
    if (!sheet)
        return;
    document.body.classList.remove("sheet-open");
    if (instant || reducedMotion()) {
        sheet.remove();
        return;
    }
    sheet.classList.remove("sheet-in");
    setTimeout(() => sheet.remove(), 360);
}
function openMealSheet(current, dayIndex, mealIndex) {
    closeMealSheet(true);
    const day = mealRecipeControllerDays(current)[dayIndex];
    const meal = day?.meals?.[mealIndex];
    if (!meal)
        return;
    const dayLabel = String(day.day || `Day ${dayIndex + 1}`);
    const items = Array.isArray(meal.items) ? meal.items.join(", ") : meal.items || "";
    const artQuery = `${meal.name || meal.meal || ""} ${items}`.trim();
    const macros = [
        ["P", meal.protein_g],
        ["C", meal.carbs_g],
        ["F", meal.fat_g],
    ]
        .filter(([label, value]) => value != null && value !== "" && (label === "P" || Number(value) > 0))
        .map(([label, value]) => CairnUi.sheetChipHtml({ label: `${label} ${value}g` }))
        .join("");
    const kcal = meal.kcal
        ? CairnUi.sheetChipHtml({ className: "sheet-chip sheet-chip-kcal", value: meal.kcal, label: "cal" })
        : "";
    const sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.dataset.key = `${current.id}:${dayIndex}:${mealIndex}`;
    sheet.innerHTML = `
    <div class="sheet-card" role="dialog" aria-modal="true" aria-label="${escAttr(meal.name || meal.meal || "Meal")}">
      <div class="sheet-grab" aria-hidden="true"></div>
      <button class="sheet-x" aria-label="Close">✕</button>
      <div class="sheet-scroll">
        <div class="sheet-hero">${artImg("food", artQuery, "artile-xl sheet-art", art("food", artQuery))}</div>
        <div class="sheet-kicker lbl">${escHtml(dayLabel)}</div>
        <h2 class="sheet-title">${escHtml(meal.name || meal.meal || "Meal")}</h2>
        ${items ? `<div class="sheet-items">${escHtml(items)}</div>` : ""}
        ${kcal || macros ? `<div class="sheet-macros">${kcal}${macros}</div>` : ""}
        <div class="sheet-recipe" data-recipe>${meal.recipe ? mealRecipeControllerRecipeHtml(meal.recipe) : mealRecipeControllerRecipeCtaHtml()}</div>
      </div>
    </div>`;
    document.body.appendChild(sheet);
    document.body.classList.add("sheet-open");
    requestAnimationFrame(() => sheet.classList.add("sheet-in"));
    sheet.addEventListener("click", (event) => {
        if (event.target === sheet)
            closeMealSheet();
    });
    sheet.querySelector(".sheet-x")?.addEventListener("click", () => closeMealSheet());
    wireRecipeCta(sheet, current, dayLabel, dayIndex, mealIndex);
}
function wireRecipeCta(sheet, current, dayLabel, dayIndex, mealIndex) {
    const button = sheet.querySelector("[data-getrecipe]");
    if (!button)
        return;
    button.addEventListener("click", () => {
        const key = sheet.dataset.key;
        const wrap = document.querySelector(mealRecipeControllerWrapSelector(key));
        if (!wrap || wrap.querySelector(".job-cap")) {
            if (wrap?.querySelector(".job-cap"))
                toast("A recipe is already being written");
            return;
        }
        wrap.innerHTML = mealRecipeControllerLoadingHtml();
        runOp("recipe", { id: current.id, day: dayLabel, meal_index: mealIndex }, recipeOpOpts(current, dayLabel, dayIndex, mealIndex, key));
    });
}
function recipeOpOpts(current, dayLabel, dayIndex, mealIndex, key) {
    const wrapSelector = mealRecipeControllerWrapSelector(key);
    return {
        path: `/meal-plans/${current.id}/recipe`,
        anchor: wrapSelector,
        caption: "recipe",
        guard: () => !document.querySelector(wrapSelector)?.isConnected,
        isFail: (result) => {
            const row = mealRecipeControllerRecord(result);
            return row.ok !== true || !row.recipe;
        },
        render: (result) => {
            const row = mealRecipeControllerRecord(result);
            const plan = mealRecipeControllerPlan(row.plan);
            if (plan.parsed)
                current.parsed = mealRecipeControllerParsed(plan.parsed);
            else {
                const meal = mealRecipeControllerDays(current)[dayIndex]?.meals?.[mealIndex];
                if (meal)
                    meal.recipe = row.recipe;
            }
            if (!row.cached)
                swrInvalidate(mealRecipeControllerCacheKey());
            const live = document.querySelector(wrapSelector);
            if (live) {
                live.innerHTML = mealRecipeControllerRecipeHtml(row.recipe);
                live.classList.add("meal-settled");
            }
        },
        onFail: () => {
            const wrap = document.querySelector(wrapSelector);
            if (wrap) {
                const liveSheet = wrap.closest(".sheet");
                wrap.innerHTML = mealRecipeControllerRecipeCtaHtml();
                if (liveSheet instanceof HTMLElement)
                    wireRecipeCta(liveSheet, current, dayLabel, dayIndex, mealIndex);
            }
            toast("Coach couldn't write the recipe — try again");
        },
    };
}
function reconnectRecipe(job) {
    const input = mealRecipeControllerRecord(mealRecipeControllerRecord(job).input);
    const planId = Number(input.id);
    const dayLabel = String(input.day ?? "");
    const mealIndex = Number(input.meal_index);
    const cached = mealRecipeControllerPlans(peekCached(mealRecipeControllerCacheKey())?.data || []);
    const current = cached.find((plan) => Number(plan.id) === planId);
    if (!current || !mealRecipeControllerDays(current).length)
        return null;
    const dayIndex = mealRecipeControllerDays(current).findIndex((day) => String(day?.day ?? "").trim().toLowerCase() === dayLabel.trim().toLowerCase());
    if (dayIndex < 0 || !Number.isFinite(mealIndex))
        return null;
    const key = `${planId}:${dayIndex}:${mealIndex}`;
    const wrap = document.querySelector(mealRecipeControllerWrapSelector(key));
    if (!wrap)
        return null;
    wrap.innerHTML = mealRecipeControllerLoadingHtml();
    const options = recipeOpOpts(current, dayLabel, dayIndex, mealIndex, key);
    let stop = () => { };
    const caption = wrap.querySelector(".job-cap");
    if (caption)
        stop = thinkingCaption(caption, options.caption);
    const host = document.querySelector(options.anchor);
    if (host && !reducedMotion())
        host.classList.add("is-thinking");
    const clear = () => {
        stop();
        const liveHost = document.querySelector(options.anchor);
        if (liveHost) {
            liveHost.classList.remove("is-thinking", "is-thinking--determinate");
            liveHost.style.removeProperty("--frac");
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
const CAIRN_MEAL_RECIPE_CONTROLLER = {
    closeMealSheet,
    openMealSheet,
    recipeOpOpts,
    reconnectRecipe,
};
Object.assign(globalThis, {
    CairnMealRecipeController: CAIRN_MEAL_RECIPE_CONTROLLER,
    closeMealSheet,
    reconnectRecipe,
});
if (typeof window !== "undefined") {
    window.CairnMealRecipeController = CAIRN_MEAL_RECIPE_CONTROLLER;
}
})();
