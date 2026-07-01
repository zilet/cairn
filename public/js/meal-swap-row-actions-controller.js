(() => {
// @ts-check
// Plan -> Meals row event wiring for log, swap, reorder, and recipe-sheet actions.
function mealSwapRowActionsHtmlElement(value) {
    return value instanceof HTMLElement ? value : null;
}
function mealSwapRowActionsButtonElement(value) {
    return value instanceof HTMLButtonElement ? value : null;
}
function mealSwapRowActionsEventElement(event) {
    return event.target instanceof Element ? event.target : null;
}
function mealSwapRowActionsWireMealLog(button, deps) {
    button.addEventListener("click", async () => {
        let payload;
        try {
            payload = deps.data.record(JSON.parse(button.dataset.mlog || "{}"));
        }
        catch {
            return;
        }
        const htmlButton = mealSwapRowActionsButtonElement(button);
        if (htmlButton)
            htmlButton.disabled = true;
        const generic = /^(breakfast|lunch|dinner|snack|pre[- ]?workout|post[- ]?workout)$/i.test(String(payload.name || "").trim());
        const title = generic && payload.items ? payload.items : (payload.name || payload.items || "Planned meal");
        try {
            await deps.api("/food-notes", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    meal: deps.mealPlan.mealSlotFor(payload.name, payload.i),
                    raw: "",
                    parsed: {
                        summary: title,
                        items: payload.items || "",
                        kcal: payload.kcal,
                        protein_g: payload.protein_g,
                        carbs_g: payload.carbs_g,
                        fat_g: payload.fat_g,
                    },
                }),
            });
            button.textContent = "✓ Logged";
            button.classList.add("meal-log-done");
            deps.toast(`${payload.name || "Meal"} logged`);
        }
        catch {
            if (htmlButton)
                htmlButton.disabled = false;
            deps.toast("Couldn't log meal");
        }
    });
}
function mealSwapRowActionsWireSwapToggle(button) {
    button.addEventListener("click", () => {
        const row = mealSwapRowActionsHtmlElement(button.closest(".meal-row"));
        const panel = mealSwapRowActionsHtmlElement(row?.nextElementSibling);
        if (!row || !panel || !panel.classList.contains("meal-swap") || row.classList.contains("meal-busy"))
            return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden)
            panel.querySelector(".meal-swap-hint")?.focus();
    });
}
function mealSwapRowActionsWireCancel(button) {
    button.addEventListener("click", () => {
        const panel = mealSwapRowActionsHtmlElement(button.closest(".meal-swap"));
        if (panel)
            panel.hidden = true;
    });
}
function mealSwapRowActionsWireHintChip(chip) {
    chip.addEventListener("click", () => {
        const panel = mealSwapRowActionsHtmlElement(chip.closest(".meal-swap"));
        const input = panel?.querySelector(".meal-swap-hint");
        if (!panel || !input)
            return;
        const on = chip.classList.contains("on");
        panel.querySelectorAll(".hintchip").forEach((other) => other.classList.remove("on"));
        chip.classList.toggle("on", !on);
        input.value = on ? "" : chip.dataset.hint || "";
    });
}
function mealSwapRowActionsWireHintEnter(input) {
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            input.closest(".meal-swap")?.querySelector(".meal-swap-go")?.click();
        }
    });
}
function mealSwapRowActionsWireSwapGo(button, current, ctx, deps) {
    button.addEventListener("click", () => {
        const panel = mealSwapRowActionsHtmlElement(button.closest(".meal-swap"));
        if (!panel)
            return;
        deps.submitMealSwap(current, ctx, Number(panel.dataset.di), Number(panel.dataset.mi), panel);
    });
}
function mealSwapRowActionsWireMove(button, current, ctx, deps) {
    button.addEventListener("click", () => {
        const row = mealSwapRowActionsHtmlElement(button.closest(".meal-row"));
        if (!row || row.classList.contains("meal-busy"))
            return;
        deps.moveMealRow(current, ctx, Number(row.dataset.di), Number(row.dataset.mi), Number(button.dataset.mv));
    });
}
function mealSwapRowActionsWireOpenSheet(row, current, deps) {
    row.addEventListener("click", (event) => {
        if (mealSwapRowActionsEventElement(event)?.closest("button, input, a, .meal-swap"))
            return;
        if (row.classList.contains("meal-busy"))
            return;
        deps.recipeController.openMealSheet(current, Number(row.dataset.di), Number(row.dataset.mi));
    });
}
function mealSwapRowActionsWireMealRows(scope, current, ctx, deps) {
    scope.querySelectorAll("[data-mlog]").forEach((button) => mealSwapRowActionsWireMealLog(button, deps));
    scope.querySelectorAll("[data-mswap]").forEach(mealSwapRowActionsWireSwapToggle);
    scope.querySelectorAll(".meal-swap-cancel").forEach(mealSwapRowActionsWireCancel);
    scope.querySelectorAll(".hintchip").forEach(mealSwapRowActionsWireHintChip);
    scope.querySelectorAll(".meal-swap-hint").forEach(mealSwapRowActionsWireHintEnter);
    scope.querySelectorAll(".meal-swap-go").forEach((button) => mealSwapRowActionsWireSwapGo(button, current, ctx, deps));
    scope.querySelectorAll(".meal-mv").forEach((button) => mealSwapRowActionsWireMove(button, current, ctx, deps));
    scope.querySelectorAll(".meal-row[data-di]").forEach((row) => mealSwapRowActionsWireOpenSheet(row, current, deps));
}
const CAIRN_MEAL_SWAP_ROW_ACTIONS_CONTROLLER = {
    wireMealRows: mealSwapRowActionsWireMealRows,
};
Object.assign(globalThis, { CairnMealSwapRowActionsController: CAIRN_MEAL_SWAP_ROW_ACTIONS_CONTROLLER });
})();
