// @ts-check
// Plan -> Meals row event wiring for log, swap, reorder, and recipe-sheet actions.

type MealSwapRowActionsPlan = ClientMealSwapPlan;
type MealSwapRowActionsContext = { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null;
type MealSwapRowActionsDeps = {
  data: ClientMealSwapData;
  mealPlan: Pick<Window["CairnMealPlan"], "mealSlotFor">;
  recipeController: Pick<Window["CairnMealRecipeController"], "openMealSheet">;
  api: typeof api;
  toast: typeof toast;
  submitMealSwap(
    current: MealSwapRowActionsPlan,
    ctx: MealSwapRowActionsContext,
    dayIndex: number,
    mealIndex: number,
    panel: HTMLElement,
  ): Promise<void>;
  moveMealRow(
    current: MealSwapRowActionsPlan,
    ctx: MealSwapRowActionsContext,
    dayIndex: number,
    mealIndex: number,
    direction: number,
  ): Promise<void>;
};
type MealSwapRowActionsControllerApi = {
  wireMealRows(
    scope: ParentNode,
    current: MealSwapRowActionsPlan,
    ctx: MealSwapRowActionsContext,
    deps: MealSwapRowActionsDeps,
  ): void;
};

function mealSwapRowActionsHtmlElement<T extends HTMLElement = HTMLElement>(value: Element | null | undefined): T | null {
  return value instanceof HTMLElement ? value as T : null;
}

function mealSwapRowActionsButtonElement(value: Element | null | undefined): HTMLButtonElement | null {
  return value instanceof HTMLButtonElement ? value : null;
}

function mealSwapRowActionsEventElement(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
}

function mealSwapRowActionsWireMealLog(button: HTMLElement, deps: MealSwapRowActionsDeps): void {
  button.addEventListener("click", async () => {
    let payload: ClientMealSwapRecord;
    try { payload = deps.data.record(JSON.parse(button.dataset.mlog || "{}")); } catch { return; }
    const htmlButton = mealSwapRowActionsButtonElement(button);
    if (htmlButton) htmlButton.disabled = true;
    const generic = /^(breakfast|lunch|dinner|snack|pre[- ]?workout|post[- ]?workout)$/i.test(String(payload.name || "").trim());
    const title = generic && payload.items ? payload.items : (payload.name || payload.items || "Planned meal");
    // Read remaining kcal BEFORE the log lands — the fit line answers "did this
    // fit the budget I had left", not the post-log remainder.
    const remainingBefore = await CairnMealFuelContext.remainingFuelKcal();
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
      const fit = CairnMealFuelContext.mealFuelFitLine(payload.kcal, remainingBefore);
      deps.toast(fit ? `${payload.name || "Meal"} logged — ${fit}` : `${payload.name || "Meal"} logged`);
    } catch {
      if (htmlButton) htmlButton.disabled = false;
      deps.toast("Couldn't log meal");
    }
  });
}

function mealSwapRowActionsWireSwapToggle(button: HTMLElement): void {
  button.addEventListener("click", () => {
    const row = mealSwapRowActionsHtmlElement(button.closest(".meal-row"));
    const panel = mealSwapRowActionsHtmlElement(row?.nextElementSibling);
    if (!row || !panel || !panel.classList.contains("meal-swap") || row.classList.contains("meal-busy")) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      panel.querySelector<HTMLInputElement>(".meal-swap-hint")?.focus();
      CairnMealFuelContext.loadMealFuelLine(panel);
    }
  });
}

function mealSwapRowActionsWireCancel(button: HTMLElement): void {
  button.addEventListener("click", () => {
    const panel = mealSwapRowActionsHtmlElement(button.closest(".meal-swap"));
    if (panel) panel.hidden = true;
  });
}

function mealSwapRowActionsWireHintChip(chip: HTMLElement): void {
  chip.addEventListener("click", () => {
    const panel = mealSwapRowActionsHtmlElement(chip.closest(".meal-swap"));
    const input = panel?.querySelector<HTMLInputElement>(".meal-swap-hint");
    if (!panel || !input) return;
    const on = chip.classList.contains("on");
    panel.querySelectorAll<HTMLElement>(".hintchip").forEach((other) => other.classList.remove("on"));
    chip.classList.toggle("on", !on);
    input.value = on ? "" : chip.dataset.hint || "";
  });
}

function mealSwapRowActionsWireHintEnter(input: HTMLInputElement): void {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.closest(".meal-swap")?.querySelector<HTMLElement>(".meal-swap-go")?.click();
    }
  });
}

function mealSwapRowActionsWireSwapGo(
  button: HTMLElement,
  current: MealSwapRowActionsPlan,
  ctx: MealSwapRowActionsContext,
  deps: MealSwapRowActionsDeps,
): void {
  button.addEventListener("click", () => {
    const panel = mealSwapRowActionsHtmlElement(button.closest(".meal-swap"));
    if (!panel) return;
    deps.submitMealSwap(current, ctx, Number(panel.dataset.di), Number(panel.dataset.mi), panel);
  });
}

function mealSwapRowActionsWireMove(
  button: HTMLElement,
  current: MealSwapRowActionsPlan,
  ctx: MealSwapRowActionsContext,
  deps: MealSwapRowActionsDeps,
): void {
  button.addEventListener("click", () => {
    const row = mealSwapRowActionsHtmlElement(button.closest(".meal-row"));
    if (!row || row.classList.contains("meal-busy")) return;
    deps.moveMealRow(current, ctx, Number(row.dataset.di), Number(row.dataset.mi), Number(button.dataset.mv));
  });
}

function mealSwapRowActionsWireOpenSheet(row: HTMLElement, current: MealSwapRowActionsPlan, deps: MealSwapRowActionsDeps): void {
  row.addEventListener("click", (event) => {
    if (mealSwapRowActionsEventElement(event)?.closest("button, input, a, .meal-swap")) return;
    if (row.classList.contains("meal-busy")) return;
    deps.recipeController.openMealSheet(current, Number(row.dataset.di), Number(row.dataset.mi));
  });
}

function mealSwapRowActionsWireMealRows(
  scope: ParentNode,
  current: MealSwapRowActionsPlan,
  ctx: MealSwapRowActionsContext,
  deps: MealSwapRowActionsDeps,
): void {
  scope.querySelectorAll<HTMLElement>("[data-mlog]").forEach((button) => mealSwapRowActionsWireMealLog(button, deps));
  scope.querySelectorAll<HTMLElement>("[data-mswap]").forEach(mealSwapRowActionsWireSwapToggle);
  scope.querySelectorAll<HTMLElement>(".meal-swap-cancel").forEach(mealSwapRowActionsWireCancel);
  scope.querySelectorAll<HTMLElement>(".hintchip").forEach(mealSwapRowActionsWireHintChip);
  scope.querySelectorAll<HTMLInputElement>(".meal-swap-hint").forEach(mealSwapRowActionsWireHintEnter);
  scope.querySelectorAll<HTMLElement>(".meal-swap-go").forEach((button) => mealSwapRowActionsWireSwapGo(button, current, ctx, deps));
  scope.querySelectorAll<HTMLElement>(".meal-mv").forEach((button) => mealSwapRowActionsWireMove(button, current, ctx, deps));
  scope.querySelectorAll<HTMLElement>(".meal-row[data-di]").forEach((row) => mealSwapRowActionsWireOpenSheet(row, current, deps));
}

const CAIRN_MEAL_SWAP_ROW_ACTIONS_CONTROLLER: MealSwapRowActionsControllerApi = {
  wireMealRows: mealSwapRowActionsWireMealRows,
};

Object.assign(globalThis, { CairnMealSwapRowActionsController: CAIRN_MEAL_SWAP_ROW_ACTIONS_CONTROLLER });
