// ==== 06-coach-meals.js ====
type CoachMealPlan = import("../contracts/client-api.js").ClientMealPlan;

// SWR cache keys for the meal-plan journal. Drafts/swaps/reorders/recipes mutate the
// plan server-side, so writes invalidate MEALS_KEY; MEALS_SETTINGS_KEY caches /settings
// for the verbatim meal_prefs that ride along. Defined here, EAGER: Fuel and the tab
// switcher name them before the lazy meals bundle (the planner itself) has loaded.
var MEALS_KEY = "meals:plans";
var MEALS_SETTINGS_KEY = "meals:settings";

// ---------- Changes (Ask → Changes) ----------
// renderCoach and its screen live in the lazy ask bundle (coach-changes-screen.ts),
// entered through the dispatcher's lazy("ask") and the segment deps' withLatestRender.
// Its two manual-review controls stay here, beside the meal keys they invalidate.
function instructionValue(): string {
  const preset = $<HTMLSelectElement>("#presetsel")?.value || "";
  if (preset === "custom") return $<HTMLTextAreaElement>("#custominstr")?.value.trim() || "";
  return preset;
}

// ---------- meal plans ----------
// Planner operations/reconnectors live in /js/meal-planner-controller.js (the lazy
// "meals" bundle, reached through withBundle);
// proposal orchestration lives in /js/coach-proposal-controller.js. This screen
// owns only the visible Coach/Plan routing and paint sequence.
function runMealPlan(): void {
  const agent = $<HTMLSelectElement>("#agentsel")?.value || "auto";
  const instruction = instructionValue();
  void withBundle("meals", () => CairnMealPlannerController.runCoachMealPlan(agent, instruction));
}

// Changes' meal-plan history, painted by the lazy meals bundle while Changes is on view.
function renderCoachMealPlans(plans: unknown, current: () => boolean): unknown {
  return withBundle("meals", () => {
    if (current()) CairnMealPlannerController.renderMealPlans(plans);
  });
}

// ---------- Plan → Food: the Fuel surface ----------
// Today so far (protein first, energy, fiber — numbers with units, never a score),
// the "Log food" composer, the day's meals as editable meal cards, three ideas from
// the athlete's own staples, and the adaptive energy read. A composition only: the
// shell paints synchronously, then each component mounts into its own slot. Logging
// here never leaves the screen — the composer hands back the rows it logged and the
// slots that read the day refresh. "This week's menu" (today's planned meals, from the
// lazy meals bundle) sits above the day's journal and opens the week menu; past weeks
// are kept as history in a fold at the foot.
let fuelTeardowns: Array<() => void> = [];
// The mounted menu card, so a meal-plan write (a draft that landed, Keep, Undo) can
// refresh it in place without repainting Fuel.
let fuelMenuCard: { slot: Element; handle: { refresh(): Promise<void> } } | null = null;
// Cross-screen hand-offs for the next paint: where the week menu opens (today's day or
// its top), and whether Fuel opens with its history fold open.
let mealMenuFocusNext: "today" | "week" = "week";
let fuelHistoryNext = false;

function mountFuelSurface(token: number, date: string, today: string): void {
  for (const teardown of fuelTeardowns) teardown();
  const slot = (id: string): Element | null => view.querySelector(`#${id}`);
  const deps = CairnFuelDeps;
  const todaySlot = slot("dayFuelSlot");
  const fuelToday = todaySlot ? CairnFuelTodayController.mount(todaySlot, deps.today(date, today)) : null;
  let ideas: ClientFuelRefreshHandle | null = null;
  const afterChange = (): void => {
    swrInvalidate("progress:intake");
    swrInvalidate("progress:energy");
    void fuelToday?.refresh();
    void ideas?.refresh();
  };
  const mealsSlot = slot("fuelMealsSlot");
  const meals = mealsSlot
    ? CairnFuelMealsController.mount(mealsSlot, deps.meals(date, today, token, afterChange))
    : null;
  const logSlot = slot("fuelLogSlot");
  const onLogged = (): void => {
    void meals?.refresh();
    afterChange();
  };
  const log = logSlot ? CairnFuelLogController.mount(logSlot, deps.log(onLogged)) : null;
  const ideasSlot = slot("fuelIdeasSlot");
  ideas = ideasSlot
    ? CairnIdeaCardController.mount(
        ideasSlot,
        deps.ideas(date, (prefill) => log?.open(prefill))
      )
    : null;
  fuelTeardowns = [fuelToday, meals, log, ideas].filter((t): t is NonNullable<typeof t> => !!t);
}

function renderFoodJournal(options: { history?: boolean } = {}): Promise<unknown> {
  if (fuelHistoryNext) options = { ...options, history: true };
  fuelHistoryNext = false;
  state.planSeg = "food";
  const token = ++pollToken;
  const today = localISO();
  const date = state.logDate || today;
  CairnUiHeader.setEyebrowTitle(headerTitle, `Fuel · ${CairnUiHeader.shortDate(date)}`); // the Today home's eyebrow
  // Logging and ideas are about the rest of TODAY; another day is read and corrected only.
  const isToday = date === today;
  const primed = CairnFuelDeps.firstPaint(date, isToday); // cold: the slots' reads first, then ONE write
  if (!primed) return paintFoodJournal(token, date, today, isToday, options);
  view.innerHTML = `${homeBackHtml("today", "Today")}<section class="meal-energy food-journal fuel" aria-busy="true"><div class="fuel-slot">${CairnFuelToday.skeletonHtml()}</div></section>`;
  wireHomeBack(view);
  return primed.then(() => (token === pollToken && state.tab === "plan" && state.planSeg === "food" ? paintFoodJournal(token, date, today, isToday, options) : undefined));
}

function paintFoodJournal(token: number, date: string, today: string, isToday: boolean, options: { history?: boolean }): Promise<unknown> {
  // Fuel opens from Today (its Fuel card), so it steps back there.
  view.innerHTML =
    homeBackHtml("today", "Today") +
    `<section class="meal-energy food-journal fuel" id="mealEnergy">
      <div id="dayFuelSlot" class="fuel-slot"></div>
      ${isToday ? `<div id="fuelLogSlot" class="fuel-slot"></div>` : ""}
      <div id="fuelMealsSlot" class="fuel-slot"></div>
      ${isToday ? `<div id="fuelMenuSlot" class="fuel-slot"></div>` : ""}
      ${isToday ? `<div id="fuelIdeasSlot" class="fuel-slot"></div>` : ""}
      <div id="energyCard">${loadingState("Reading your trend…")}</div>
      <div id="energyHero"></div>
      <div id="checkinResult" class="checkin-result"></div>
      <details class="mp-history fuel-history" id="fuelHistory"${options.history ? " open" : ""}>
        <summary class="lbl">Earlier meal plans</summary>
        <div id="fuelHistorySlot" class="fuel-history-body"></div>
      </details>
    </section>`;
  wireHomeBack(view);
  mountFuelSurface(token, date, today);
  mountFuelMenu(token);
  loadMealsEnergy(token);
  const fold = view.querySelector<HTMLDetailsElement>("#fuelHistory");
  fold?.addEventListener("toggle", () => {
    if (fold.open && !fold.dataset.painted) void paintMealHistory(token);
  });
  if (!options.history) return Promise.resolve();
  fold?.scrollIntoView?.({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
  return paintMealHistory(token);
}

function rerenderFoodSurface(): void {
  renderFoodJournal({ history: !!view.querySelector("#fuelHistory[open]") });
}

// "This week's menu" on Fuel. The card lives in the lazy meals bundle; a placeholder of
// its shape holds the slot so nothing below jumps when it lands. It never delays the
// eager slots above and below it.
function mountFuelMenu(token: number): void {
  const slot = view.querySelector<HTMLElement>("#fuelMenuSlot");
  if (!slot) return;
  slot.innerHTML = `<div class="mmenu mmenu-skel" aria-hidden="true">${skelLines(2)}</div>`;
  Promise.resolve(
    withBundle("meals", () => {
      if (token !== pollToken || !slot.isConnected) return;
      const handle = CairnMealMenuCardController.mount(slot, {
        isCurrent: () => token === pollToken && slot.isConnected,
        openMenu: (focus) => openMealMenu(focus),
      });
      fuelMenuCard = { slot, handle };
      fuelTeardowns.push(handle);
      // The meals bundle's owed reconnect sweep waits for the card's first real paint, so
      // a week still drafting reattaches to its status host, not to the skeleton.
      return handle.ready;
    })
  ).catch(() => {
    if (slot.isConnected) slot.innerHTML = "";
  });
}

function openMealMenu(focus: "today" | "week" = "week"): void {
  mealMenuFocusNext = focus;
  state.planJump = "meals";
  activateTab("plan");
}

function openFuel(withHistory = false): void {
  fuelHistoryNext = withHistory;
  state.planJump = "food";
  activateTab("plan");
}

// A meal-plan action (keep, discard, Hold/Undo, a draft that landed, a discarded prefs
// edit) repaints what shows the plans IN PLACE: the week menu on its screen; on Fuel
// the menu card and, once opened, the history fold. Fuel's other slots keep their
// mounts, so a meal card mid-edit keeps its unsaved grams, the Log composer keeps its
// attached photo, and the page stays where the athlete scrolled it.
function repaintMealHistory(): Promise<unknown> {
  swrInvalidate(MEALS_KEY);
  const token = pollToken;
  if (view.querySelector("#mealMenuSlot")) return paintMealMenu(token, "week");
  const repaints: Promise<unknown>[] = [];
  if (fuelMenuCard?.slot.isConnected) repaints.push(fuelMenuCard.handle.refresh());
  if (view.querySelector<HTMLElement>("#fuelHistory")?.dataset.painted) repaints.push(paintMealHistory(token));
  return Promise.all(repaints);
}

// Plan → Meals is the week menu (/app/today/menu; the v1 /app/plan/meals redirects
// here): the current week's days and meals with swap, recipe and log, the shopping
// list, and the ask for a fresh week. It opens from Fuel's card and Train → Fuel, and
// steps back to Fuel. The planner itself is the lazy meals bundle's.
function renderMeals(): Promise<unknown> {
  state.planSeg = "meals";
  const token = ++pollToken;
  const focus = mealMenuFocusNext;
  mealMenuFocusNext = "week";
  // The page's name rides the Today home's eyebrow (as Fuel's does); the heading that
  // takes focus on arrival says it once more for assistive tech only.
  CairnUiHeader.setEyebrowTitle(headerTitle, "This week's menu");
  // The route renders once the meals bundle has landed (lazy("meals", …)); the page
  // frame is that bundle's, so the eager screen carries only the wiring.
  return Promise.resolve(
    withBundle("meals", () => {
      if (token !== pollToken) return;
      view.innerHTML = CairnMealJournal.menuPageHtml();
      view.querySelector("[data-mmenu-back]")?.addEventListener("click", () => openFuel());
      view.querySelector("[data-mmenu-history]")?.addEventListener("click", () => openFuel(true));
      const slot = view.querySelector<HTMLElement>("#mealMenuSlot");
      return slot && CairnMealJournal.paintMenu(token, slot, peekCached<CoachMealPlan[]>(MEALS_KEY), focus);
    })
  );
}

function paintMealMenu(token: number, focus: "today" | "week"): Promise<unknown> {
  const slot = view.querySelector<HTMLElement>("#mealMenuSlot");
  if (!slot) return Promise.resolve();
  const peek = peekCached<CoachMealPlan[]>(MEALS_KEY);
  return Promise.resolve(withBundle("meals", () => CairnMealJournal.paintMenu(token, slot, peek, focus)));
}

// Past weeks, inside Fuel's fold (render helpers in /js/meal-plan-client.js): painted
// instantly from a warm peek and upgraded on change.
function paintMealHistory(token: number): Promise<unknown> {
  const fold = view.querySelector<HTMLElement>("#fuelHistory");
  const slot = view.querySelector<HTMLElement>("#fuelHistorySlot");
  if (!fold || !slot) return Promise.resolve();
  fold.dataset.painted = "1";
  const peek = peekCached<CoachMealPlan[]>(MEALS_KEY);
  if (!peek) slot.innerHTML = skelLines(3);
  // The history renders from the lazy meals bundle; the fold is closed on arrival
  // unless the week menu's "Earlier meal plans" opened it.
  return Promise.resolve(withBundle("meals", () => CairnMealJournal.paintHistory(token, slot, peek)));
}

// SWR over the derived expenditure (key shared with the old Energy view), painted
// into whichever nutrition surface owns #energyHero/#energyCard. A warm re-entry
// paints instantly, then revalidates. Bails if the slot's gone.
function loadMealsEnergy(token: number): void {
  if (!view.querySelector("#energyCard")) return;
  const peek = peekCached("progress:energy");
  const paint = (exp: unknown) => {
    if (token !== pollToken || !view.querySelector("#energyCard")) return;
    paintEnergyBody(exp);
  };
  if (peek) {
    paint(peek.data);
    if (!peek.fresh) markRefreshing(true);
  }
  cachedApi("/nutrition/expenditure?window=21", {
    key: "progress:energy",
    onUpgrade: (exp, { changed }) => {
      if (peek && !peek.fresh) markRefreshing(false);
      if (changed || !peek) paint(exp);
    },
  }).catch(() => {
    if (peek && !peek.fresh) markRefreshing(false);
  });
}

Object.assign(globalThis, {
  MEALS_KEY,
  MEALS_SETTINGS_KEY,
  renderCoachMealPlans,
  renderFoodJournal,
  renderMeals,
  repaintMealHistory,
  rerenderFoodSurface,
  runMealPlan,
});
