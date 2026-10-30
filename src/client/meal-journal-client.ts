// @ts-check
// The meal-plan journal (lazy "meals" bundle), painted into two places the eager screen
// (coach-meals-screen.ts) owns and reaches through withBundle("meals"):
//   - the week menu (/app/today/menu): the current plan's days and meals with swap,
//     recipe, log and reorder, the shopping list, planning preferences, the Hold/Undo on
//     a meal decision, and the ask for a fresh week;
//   - the week menu's "Earlier meal plans" fold: every OTHER week (earlier, set aside, a
//     draft not offered).

type MealJournalPeek = SwrPeek<import("../contracts/client-api.js").ClientMealPlan[]> | null;

(() => {
  // Hold (a change still waiting) and Undo (one that landed) both go through the
  // durable decision rollback. A later accepted plan intentionally wins over an
  // older rollback: the response confirms the decision was reverted, not that its
  // prior plan became current, so the Undo confirmation stays truthful under that race.
  function wireMealDecisionActions(host: Element): void {
    const after = async (): Promise<void> => {
      swrInvalidate(MEALS_KEY);
      await repaintMealHistory();
    };
    CairnDecisionUndoController.mount(
      host,
      { api, toast },
      {
        "meal-decision-hold": {
          reason: "hold on — keep my current meal plan",
          success: "Held — your current meals stay",
          stale: "That meal change can no longer be held.",
          failed: "Could not hold that meal change",
          after,
        },
        "meal-decision-undo": {
          reason: "undo from the meal plan",
          success: "Undo recorded — showing your current meals",
          stale: "That meal change can no longer be undone.",
          failed: "Could not undo that meal change",
          after,
        },
      },
      "meal-decision"
    );
  }

  // The week menu.
  function paintMealMenu(token: number, slot: HTMLElement, peek: MealJournalPeek): Promise<unknown> {
    let mealPrefs = String(
      peekCached<import("../contracts/client-api.js").ClientSettingsResponse>(MEALS_SETTINGS_KEY)?.data?.settings
        ?.meal_prefs || ""
    );
    cachedApi("/settings", {
      key: MEALS_SETTINGS_KEY,
      onUpgrade: (data) => {
        mealPrefs = String(data.settings?.meal_prefs || "");
      },
    }).catch(() => {});
    return paintSWR({
      key: MEALS_KEY,
      path: "/mealplans?limit=12",
      peek,
      token,
      tab: "plan",
      render: (plansRes) => {
        if (!slot.isConnected) return;
        paintMenuBody(slot, plansRes || [], mealPrefs);
      },
    });
  }

  // The week menu's history fold: the weeks that are not the current menu.
  function paintMealHistory(token: number, slot: HTMLElement, peek: MealJournalPeek): Promise<unknown> {
    return paintSWR({
      key: MEALS_KEY,
      path: "/mealplans?limit=12",
      peek,
      token,
      tab: "plan",
      render: (plansRes) => {
        if (slot.isConnected) paintHistoryBody(slot, plansRes || []);
      },
    });
  }

  type MealJournalRow = Record<string, unknown> & { id?: unknown; status?: unknown; autonomy?: { status?: unknown } };

  // One reading of the plan list for both places: the CURRENT week (a kept week, else
  // the newest adequate draft), a week scheduled to become current, a fresh week (an
  // adequate draft asked for AFTER the kept week — it waits on the menu for a yes), and
  // the past: settled weeks plus every draft the menu does not offer (an older one, an
  // inadequate one, or any other draft beside a draft that is itself current).
  function mealJournalWeeks(plans: unknown) {
    const rows: MealJournalRow[] = Array.isArray(plans)
      ? plans.filter((plan): plan is MealJournalRow => !!plan && typeof plan === "object")
      : [];
    const current = CairnMealPlan.currentMealPlan(rows);
    const isCurrent = (row: MealJournalRow): boolean => !!current && row.id === current.id;
    const upcoming =
      rows.find((row) => row.status === "draft" && ["announced", "pending"].includes(String(row.autonomy?.status))) || null;
    const kept = !!current && current.status !== "draft";
    const fresh = (row: MealJournalRow): boolean =>
      kept && Number(row.id) > Number(current?.id) && CairnMealPlan.mealPlanIsAdequate(row);
    const others = rows.filter((row) => !isCurrent(row) && row !== upcoming);
    return {
      current,
      upcoming,
      drafts: others.filter((row) => row.status === "draft" && fresh(row)),
      past: others.filter((row) => row.status !== "draft" || !fresh(row)),
    };
  }

  function paintHistoryBody(slot: HTMLElement, plans: unknown): void {
    const { past } = mealJournalWeeks(plans);
    if (!past.length) {
      slot.innerHTML = `<p class="sess-line mp-muted fuel-history-none">Earlier weeks you keep or set aside wait here.</p>`;
      return;
    }
    slot.innerHTML = `<div id="mealHist"></div>`;
    CairnMealPlannerController.renderMealPlans(past, "#mealHist", () => repaintMealHistory());
  }

  // Build + wire the week menu from a plans list (+ verbatim meal prefs) into its slot.
  // Called on a warm peek and again on a changed revalidate; the inner wiring re-queries
  // the freshly written DOM each time.
  function paintMenuBody(slot: HTMLElement, plans: unknown, mealPrefs: string): void {
    const { current, upcoming, drafts } = mealJournalWeeks(plans);
    const currentPlan =
      current && (typeof current.id === "string" || typeof current.id === "number")
        ? (current as Record<string, unknown> & { id: string | number })
        : null;
    let shopChecked = new Set<unknown>();
    try {
      if (currentPlan) shopChecked = new Set(JSON.parse(localStorage.getItem(`shop:${currentPlan.id}`) || "[]"));
    } catch {
      /* a ticked shopping list is a convenience */
    }
    const painted = CairnMealPlan.mealPlannerBodyHtml(current, mealPrefs, {
      checkedShopping: shopChecked,
      verified: currentPlan ? CairnMealPlannerController.verifiedForPlan(currentPlan.id) : null,
      upcoming,
    });
    slot.innerHTML =
      painted.html +
      (drafts.length ? `<h2 class="lbl mmenu-drafts-h">A fresh week to look over</h2><div id="mealDrafts"></div>` : "");
    runCountUps(slot);
    if (drafts.length) CairnMealPlannerController.renderMealPlans(drafts, "#mealDrafts", () => repaintMealHistory());
    CairnMealPlannerController.wireMealPlannerBody(currentPlan, painted.context);
    wireMealDecisionActions(slot);
    if (currentPlan) loadMealProvenance();
  }

  // The week menu's page frame (the route renders only once this bundle has landed, so
  // the frame and its copy ride here rather than in the eager Fuel screen).
  function menuPageHtml(): string {
    // It opens from Train › Intake's "This week's menu" row, so it steps back there; the
    // past weeks wait in a fold at its foot, painted on first open.
    return `<section class="mmenu-page" id="mealMenu">
      <button class="home-back linkbtn linkbtn-plain" type="button" data-mmenu-back>‹ Intake</button>
      <h1 class="sr-only">This week's menu</h1>
      <p class="mmenu-page-lede">Ideas from the team for the week, built around your training. Swap a meal, open its recipe, or log it when you eat it.</p>
      <div id="mealMenuSlot" class="mmenu-page-body">${skelLines(3)}</div>
      <details class="mp-history fuel-history" id="fuelHistory">
        <summary class="lbl">Earlier meal plans</summary>
        <div id="fuelHistorySlot" class="fuel-history-body"></div>
      </details>
    </section>`;
  }

  const CAIRN_MEAL_JOURNAL: Window["CairnMealJournal"] = {
    menuPageHtml,
    paintMenu: paintMealMenu,
    paintHistory: paintMealHistory,
    weeks: mealJournalWeeks,
  };

  Object.assign(globalThis, { CairnMealJournal: CAIRN_MEAL_JOURNAL });
})();
