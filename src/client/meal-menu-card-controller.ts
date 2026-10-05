// @ts-check
// Mounts "This week's menu" into Fuel's #fuelMenuSlot (lazy "meals" bundle; Fuel, which
// is eager, reaches it through withBundle). It reads the meal-plan journal's own SWR key,
// so the card, the week menu and the history fold share one cache: a warm peek paints at
// once and a revalidate repaints only on change. "See the week" (or a meal) opens the
// week menu; the empty card's ask drafts a week through the existing meal_plan job.

type MealMenuCardControllerDeps = {
  /** Still the Fuel paint that mounted this card (render generation + slot attached). */
  isCurrent(): boolean;
  /** Open the week menu, scrolled to today's meals or at its top. */
  openMenu(focus: "today" | "week"): void;
};

type MealMenuCardHandle = (() => void) & {
  refresh(): Promise<void>;
  /** The card's first real paint (or its offline step-aside); never rejects. */
  ready: Promise<void>;
};

(() => {
  // The same path Fuel's first paint asks (and its fan-in primes, fuel-deps.ts).
  const PLANS_PATH = "/mealplans?limit=12";

  function mountMealMenuCard(host: HTMLElement, deps: MealMenuCardControllerDeps): MealMenuCardHandle {
    let shown: unknown;
    const live = (): boolean => host.isConnected && deps.isCurrent();
    const paint = (plans: unknown): void => {
      if (!live()) return;
      shown = plans;
      host.innerHTML = CairnMealMenuCard.cardHtml(CairnMealMenuCard.model(plans));
    };

    const load = async (): Promise<void> => {
      const peek = peekCached<import("../contracts/client-api.js").ClientMealPlan[]>(MEALS_KEY);
      if (peek) paint(peek.data);
      else if (shown === undefined && live()) host.innerHTML = CairnMealMenuCard.skeletonHtml();
      let changed = !peek;
      try {
        const plans = await cachedApi(PLANS_PATH, {
          key: MEALS_KEY,
          onUpgrade: (_data, info) => {
            changed = changed || info.changed;
          },
        });
        if (changed || shown === undefined) paint(plans);
      } catch {
        // Offline with nothing cached: the card steps aside rather than claim an empty week.
        if (shown === undefined && live()) host.innerHTML = "";
      }
    };

    const teardown = CairnUiActions.mount(host, "mmenu", ({ delegate }) => {
      delegate("click", {
        "mmenu-open": (el) => deps.openMenu(el.dataset.mmenuOpen === "today" ? "today" : "week"),
        "mmenu-draft": () => CairnMealPlannerJobs.draftWeeklyMeals(),
      });
    });
    return Object.assign(teardown, { refresh: load, ready: load() });
  }

  const CAIRN_MEAL_MENU_CARD_CONTROLLER = { mount: mountMealMenuCard };

  Object.assign(globalThis, { CairnMealMenuCardController: CAIRN_MEAL_MENU_CARD_CONTROLLER });
})();
