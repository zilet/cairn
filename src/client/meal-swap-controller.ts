// @ts-check
// Plan -> Meals row interactions: log planned meals, swap/reorder rows, and reconnect durable swap jobs.

type MealSwapControllerRecord = Record<string, unknown>;
type MealSwapControllerPlan = import("../contracts/client-api.js").ClientMealPlan & {
  id: number | string;
  parsed?: MealSwapControllerParsed;
};
type MealSwapControllerParsed = MealSwapControllerRecord & {
  days?: MealSwapControllerDay[];
};
type MealSwapControllerDay = MealSwapControllerRecord & {
  day?: unknown;
  meals?: MealSwapControllerMeal[];
};
type MealSwapControllerMeal = MealSwapControllerRecord & {
  name?: unknown;
  meal?: unknown;
  items?: unknown;
  kcal?: unknown;
  protein_g?: unknown;
  carbs_g?: unknown;
  fat_g?: unknown;
  recipe?: unknown;
};
type MealSwapControllerContext = { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null;
type MealSwapControllerOpOptions = ClientAgentOpHandlers & {
  path: string;
  anchor: string;
  caption: string;
  guard: () => boolean;
  isFail: (result: unknown) => boolean;
  render: (result: unknown) => void;
  onFail: (error?: unknown) => void;
};
type MealSwapControllerBusyElement<T extends Element = HTMLElement> = T & { _busyRestore?: () => void };

function mealSwapControllerRecord(value: unknown): MealSwapControllerRecord {
  return value && typeof value === "object" ? value as MealSwapControllerRecord : {};
}

function mealSwapControllerRows<T extends MealSwapControllerRecord = MealSwapControllerRecord>(value: unknown): T[] {
  return Array.isArray(value)
    ? value.filter((row): row is T => !!row && typeof row === "object")
    : [];
}

function mealSwapControllerPlan(value: unknown): MealSwapControllerPlan {
  return mealSwapControllerRecord(value) as MealSwapControllerPlan;
}

function mealSwapControllerPlans(value: unknown): MealSwapControllerPlan[] {
  return mealSwapControllerRows<MealSwapControllerPlan>(value);
}

function mealSwapControllerParsed(value: unknown): MealSwapControllerParsed {
  return mealSwapControllerRecord(value) as MealSwapControllerParsed;
}

function mealSwapControllerDays(plan: MealSwapControllerPlan): MealSwapControllerDay[] {
  const parsed = mealSwapControllerParsed(plan.parsed);
  return Array.isArray(parsed.days) ? parsed.days : [];
}

function mealSwapControllerErrorMessage(value: unknown): string | undefined {
  const error = mealSwapControllerRecord(value).error;
  return typeof error === "string" ? error : undefined;
}

function mealSwapControllerHtmlElement<T extends HTMLElement = HTMLElement>(value: Element | null | undefined): T | null {
  return value instanceof HTMLElement ? value as T : null;
}

function mealSwapControllerButtonElement(value: Element | null | undefined): HTMLButtonElement | null {
  return value instanceof HTMLButtonElement ? value : null;
}

function mealSwapControllerRestoreBusy(value: Element | null | undefined): void {
  (value as MealSwapControllerBusyElement | null | undefined)?._busyRestore?.();
}

function mealSwapControllerEventElement(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
}

function mealSwapControllerCacheKey(): string {
  return typeof MEALS_KEY === "string" && MEALS_KEY ? MEALS_KEY : "meals:plans";
}

function rerenderMealDay(
  current: MealSwapControllerPlan,
  dayIndex: number,
  ctx: MealSwapControllerContext,
  settleMealIndex: number | null = null,
): void {
  const section = view.querySelector<HTMLElement>(`.mealday[data-mday="${dayIndex}"]`);
  const day = mealSwapControllerDays(current)[dayIndex];
  if (!section || !day) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = CairnMealPlan.mealDayHtml(day, dayIndex, ctx || {});
  const fresh = mealSwapControllerHtmlElement(tmp.firstElementChild);
  if (!fresh) return;
  fresh.classList.remove("reveal");
  section.replaceWith(fresh);
  wireMealRows(fresh, current, ctx);
  runCountUps(fresh);
  if (settleMealIndex != null) fresh.querySelector(`.meal-row[data-mi="${settleMealIndex}"]`)?.classList.add("meal-settled");
}

async function submitMealSwap(
  current: MealSwapControllerPlan,
  ctx: MealSwapControllerContext,
  dayIndex: number,
  mealIndex: number,
  panel: HTMLElement,
): Promise<void> {
  const day = mealSwapControllerDays(current)[dayIndex];
  if (!day) return;
  const row = mealSwapControllerHtmlElement(panel.previousElementSibling);
  if (row && row.classList.contains("meal-busy")) { toast("A swap is already running"); return; }
  const hint = panel.querySelector<HTMLInputElement>(".meal-swap-hint")?.value.trim() || "";
  const go = panel.querySelector(".meal-swap-go");
  if (row) {
    row.classList.add("meal-busy");
    row.querySelector(".meal-cap")?.remove();
    row.insertAdjacentHTML("beforeend", CairnUi.jobCaptionHtml({ className: "meal-cap job-cap" }));
  }
  panel.classList.add("meal-swap-busy");
  btnBusy(go, "Asking the coach…", { ghost: true });
  panel.querySelectorAll("button,input").forEach((el) => {
    if (el !== go && (el instanceof HTMLButtonElement || el instanceof HTMLInputElement)) el.disabled = true;
  });

  const body = hint ? { day: day.day, meal_index: mealIndex, hint } : { day: day.day, meal_index: mealIndex };
  await runOp("meal_swap", { id: current.id, ...body }, mealSwapOpOpts(current, ctx, dayIndex, mealIndex));
}

function mealSwapOpOpts(
  current: MealSwapControllerPlan,
  ctx: MealSwapControllerContext,
  dayIndex: number,
  mealIndex: number,
): MealSwapControllerOpOptions {
  const rowSel = `.mealday[data-mday="${dayIndex}"] .meal-row[data-mi="${mealIndex}"]`;
  return {
    path: `/meal-plans/${current.id}/swap`,
    anchor: rowSel,
    caption: "meal_swap",
    guard: () => !view.querySelector(rowSel)?.isConnected,
    isFail: (result: unknown) => {
      const row = mealSwapControllerRecord(result);
      const plan = mealSwapControllerPlan(row.plan);
      return row.ok !== true || !(plan.parsed || row.meal);
    },
    render: (result: unknown) => {
      const row = mealSwapControllerRecord(result);
      const plan = mealSwapControllerPlan(row.plan);
      if (plan.parsed) current.parsed = mealSwapControllerParsed(plan.parsed);
      else {
        const day = mealSwapControllerDays(current)[dayIndex];
        if (day?.meals) day.meals[mealIndex] = mealSwapControllerRecord(row.meal) as MealSwapControllerMeal;
      }
      swrInvalidate(mealSwapControllerCacheKey());
      rerenderMealDay(current, dayIndex, ctx, mealIndex);
      toast("Meal swapped");
    },
    onFail: () => {
      const row = view.querySelector<HTMLElement>(rowSel);
      if (row) { row.classList.remove("meal-busy"); row.querySelector(".meal-cap")?.remove(); }
      const panel = mealSwapControllerHtmlElement(row?.nextElementSibling);
      if (panel && panel.classList.contains("meal-swap")) {
        panel.classList.remove("meal-swap-busy");
        panel.querySelectorAll("button,input").forEach((el) => {
          if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) el.disabled = false;
        });
        const go = panel.querySelector(".meal-swap-go");
        mealSwapControllerRestoreBusy(go);
      }
      toast("Coach couldn't draft a swap — try again");
    },
  };
}

function reconnectMealSwap(job?: unknown): ClientAgentOpHandlers | null {
  const input = mealSwapControllerRecord(mealSwapControllerRecord(job).input);
  const planId = Number(input.id);
  const cached = mealSwapControllerPlans(peekCached<MealSwapControllerPlan[]>(mealSwapControllerCacheKey())?.data || []);
  const current = cached.find((plan) => Number(plan.id) === planId);
  if (!current || !mealSwapControllerDays(current).length) return null;
  const dayIndex = mealSwapControllerDays(current).findIndex(
    (day) => String(day?.day ?? "").trim().toLowerCase() === String(input.day ?? "").trim().toLowerCase()
  );
  const mealIndex = Number(input.meal_index);
  if (dayIndex < 0 || !Number.isFinite(mealIndex)) return null;
  const ctx = CairnMealPlan.mealsCtxFor(current);
  const rowSel = `.mealday[data-mday="${dayIndex}"] .meal-row[data-mi="${mealIndex}"]`;
  const row = view.querySelector<HTMLElement>(rowSel);
  if (!row) return null;
  row.classList.add("meal-busy");
  row.querySelector(".meal-cap")?.remove();
  row.insertAdjacentHTML("beforeend", CairnUi.jobCaptionHtml({ className: "meal-cap job-cap" }));
  const options = mealSwapOpOpts(current, ctx, dayIndex, mealIndex);
  let stop = () => {};
  const capEl = row.querySelector(".job-cap");
  if (capEl) stop = thinkingCaption(capEl, options.caption);
  if (!reducedMotion()) row.classList.add("is-thinking");
  const clear = () => {
    stop();
    const liveRow = view.querySelector<HTMLElement>(rowSel);
    if (liveRow) {
      liveRow.classList.remove("is-thinking", "is-thinking--determinate");
      liveRow.style.removeProperty("--frac");
    }
  };
  return {
    guard: options.guard,
    onDone: (result) => {
      clear();
      if (options.isFail(result)) options.onFail(result);
      else options.render(result);
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

async function moveMealRow(
  current: MealSwapControllerPlan,
  ctx: MealSwapControllerContext,
  dayIndex: number,
  mealIndex: number,
  direction: number,
): Promise<void> {
  const days = mealSwapControllerDays(current);
  const meals = days[dayIndex]?.meals;
  const nextIndex = mealIndex + direction;
  if (!meals || mealIndex < 0 || mealIndex >= meals.length || nextIndex < 0 || nextIndex >= meals.length) return;
  const token = pollToken;
  [meals[mealIndex], meals[nextIndex]] = [meals[nextIndex], meals[mealIndex]];
  rerenderMealDay(current, dayIndex, ctx, nextIndex);
  try {
    const result = await api(`/meal-plans/${current.id}/days`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days }),
    });
    if (mealSwapControllerErrorMessage(result)) throw new Error(mealSwapControllerErrorMessage(result));
    swrInvalidate(mealSwapControllerCacheKey());
  } catch {
    [meals[mealIndex], meals[nextIndex]] = [meals[nextIndex], meals[mealIndex]];
    if (token === pollToken) {
      rerenderMealDay(current, dayIndex, ctx);
      toast("Couldn't save order — reverted");
    }
  }
}

function wireMealRows(scope: ParentNode, current: MealSwapControllerPlan, ctx: MealSwapControllerContext): void {
  scope.querySelectorAll<HTMLElement>("[data-mlog]").forEach((button) =>
    button.addEventListener("click", async () => {
      let payload: MealSwapControllerRecord;
      try { payload = mealSwapControllerRecord(JSON.parse(button.dataset.mlog || "{}")); } catch { return; }
      const htmlButton = mealSwapControllerButtonElement(button);
      if (htmlButton) htmlButton.disabled = true;
      const generic = /^(breakfast|lunch|dinner|snack|pre[- ]?workout|post[- ]?workout)$/i.test(String(payload.name || "").trim());
      const title = generic && payload.items ? payload.items : (payload.name || payload.items || "Planned meal");
      try {
        await api("/food-notes", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            meal: CairnMealPlan.mealSlotFor(payload.name, payload.i),
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
        toast(`${payload.name || "Meal"} logged`);
      } catch {
        if (htmlButton) htmlButton.disabled = false;
        toast("Couldn't log meal");
      }
    })
  );

  scope.querySelectorAll<HTMLElement>("[data-mswap]").forEach((button) =>
    button.addEventListener("click", () => {
      const row = mealSwapControllerHtmlElement(button.closest(".meal-row"));
      const panel = mealSwapControllerHtmlElement(row?.nextElementSibling);
      if (!row || !panel || !panel.classList.contains("meal-swap") || row.classList.contains("meal-busy")) return;
      panel.hidden = !panel.hidden;
      if (!panel.hidden) panel.querySelector<HTMLInputElement>(".meal-swap-hint")?.focus();
    })
  );
  scope.querySelectorAll<HTMLElement>(".meal-swap-cancel").forEach((button) =>
    button.addEventListener("click", () => {
      const panel = mealSwapControllerHtmlElement(button.closest(".meal-swap"));
      if (panel) panel.hidden = true;
    })
  );
  scope.querySelectorAll<HTMLElement>(".hintchip").forEach((chip) =>
    chip.addEventListener("click", () => {
      const panel = mealSwapControllerHtmlElement(chip.closest(".meal-swap"));
      const input = panel?.querySelector<HTMLInputElement>(".meal-swap-hint");
      if (!panel || !input) return;
      const on = chip.classList.contains("on");
      panel.querySelectorAll<HTMLElement>(".hintchip").forEach((other) => other.classList.remove("on"));
      chip.classList.toggle("on", !on);
      input.value = on ? "" : chip.dataset.hint || "";
    })
  );
  scope.querySelectorAll<HTMLInputElement>(".meal-swap-hint").forEach((input) =>
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.closest(".meal-swap")?.querySelector<HTMLElement>(".meal-swap-go")?.click();
      }
    })
  );
  scope.querySelectorAll<HTMLElement>(".meal-swap-go").forEach((button) =>
    button.addEventListener("click", () => {
      const panel = mealSwapControllerHtmlElement(button.closest(".meal-swap"));
      if (!panel) return;
      submitMealSwap(current, ctx, Number(panel.dataset.di), Number(panel.dataset.mi), panel);
    })
  );

  scope.querySelectorAll<HTMLElement>(".meal-mv").forEach((button) =>
    button.addEventListener("click", () => {
      const row = mealSwapControllerHtmlElement(button.closest(".meal-row"));
      if (!row || row.classList.contains("meal-busy")) return;
      moveMealRow(current, ctx, Number(row.dataset.di), Number(row.dataset.mi), Number(button.dataset.mv));
    })
  );

  scope.querySelectorAll<HTMLElement>(".meal-row[data-di]").forEach((row) =>
    row.addEventListener("click", (event) => {
      if (mealSwapControllerEventElement(event)?.closest("button, input, a, .meal-swap")) return;
      if (row.classList.contains("meal-busy")) return;
      CairnMealRecipeController.openMealSheet(current, Number(row.dataset.di), Number(row.dataset.mi));
    })
  );
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
