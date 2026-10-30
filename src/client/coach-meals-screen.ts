// ==== 06-coach-meals.js ====
type CoachMealPlan = import("../contracts/client-api.js").ClientMealPlan;

// SWR cache keys for the meal-plan journal. Drafts/swaps/reorders/recipes mutate the
// plan server-side, so writes invalidate MEALS_KEY; MEALS_SETTINGS_KEY caches /settings
// for the verbatim meal_prefs that ride along. Defined here, EAGER: the tab switcher
// names them before the lazy meals bundle (the planner itself) has loaded.
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

// ---------- Today's food lives on Train › Intake ----------
// The Fuel view folded into Intake (intake-screen.ts, the lazy fuel bundle): today so
// far, the meals, one idea and the composer. What stays here is the week menu and the
// meal-plan journal it keeps.

// A meal-plan action (keep, discard, Hold/Undo, a draft that landed, a discarded prefs
// edit) repaints the week menu IN PLACE while it is on screen, and its "Earlier meal
// plans" fold once opened; anywhere else it only invalidates, so the athlete is never
// pulled away.
function repaintMealHistory(): Promise<unknown> {
  swrInvalidate(MEALS_KEY);
  const token = pollToken;
  const repaints: Promise<unknown>[] = [];
  if (view.querySelector("#mealMenuSlot")) repaints.push(paintMealMenu(token));
  if (view.querySelector<HTMLElement>("#fuelHistory")?.dataset.painted) repaints.push(paintMealHistory(token));
  return Promise.all(repaints);
}

// Plan → Meals is the week menu (/app/today/menu; the v1 /app/plan/meals redirects
// here): the current week's days and meals with swap, recipe and log, the shopping
// list, the ask for a fresh week, and the past weeks in its "Earlier meal plans" fold.
// It opens from Train › Intake's "This week's menu" row (and Today, the coaching focus,
// Energy) and steps back to whoever opened it; a cold link steps back to Intake. The
// planner itself is the lazy meals bundle's.
function renderMeals(): Promise<unknown> {
  state.planSeg = "meals";
  const token = ++pollToken;
  // The page's name rides the Today home's eyebrow; the heading that
  // takes focus on arrival says it once more for assistive tech only.
  CairnUiHeader.setEyebrowTitle(headerTitle, "This week's menu");
  // The route renders once the meals bundle has landed (lazy("meals", …)); the page
  // frame is that bundle's, so the eager screen carries only the wiring.
  return Promise.resolve(
    withBundle("meals", () => {
      if (token !== pollToken) return;
      view.innerHTML = CairnMealJournal.menuPageHtml();
      const opened = mealMenuOpenedInApp();
      const back = view.querySelector<HTMLElement>("[data-mmenu-back]");
      if (back) {
        back.textContent = opened ? "‹ Back" : "‹ Intake";
        back.addEventListener("click", () => (mealMenuOpenedInApp() ? history.back() : openIntake()));
      }
      const fold = view.querySelector<HTMLDetailsElement>("#fuelHistory");
      fold?.addEventListener("toggle", () => {
        if (fold.open && !fold.dataset.painted) void paintMealHistory(token);
      });
      const slot = view.querySelector<HTMLElement>("#mealMenuSlot");
      return slot && CairnMealJournal.paintMenu(token, slot, peekCached<CoachMealPlan[]>(MEALS_KEY));
    })
  );
}

// The menu's own history entry carries `back: 1` when an in-app tap pushed it
// (route-sync.ts); a cold link or a reload of one never does.
function mealMenuOpenedInApp(): boolean {
  try {
    const entry = (typeof history !== "undefined" ? history.state : null) as { cairn?: boolean; back?: number } | null;
    return !!entry && entry.cairn === true && entry.back === 1 && history.length > 1;
  } catch {
    return false;
  }
}

function paintMealMenu(token: number): Promise<unknown> {
  const slot = view.querySelector<HTMLElement>("#mealMenuSlot");
  if (!slot) return Promise.resolve();
  const peek = peekCached<CoachMealPlan[]>(MEALS_KEY);
  return Promise.resolve(withBundle("meals", () => CairnMealJournal.paintMenu(token, slot, peek)));
}

// Past weeks, inside the week menu's fold (render helpers in /js/meal-plan-client.js):
// painted on its first open, instantly from a warm peek and upgraded on change.
function paintMealHistory(token: number): Promise<unknown> {
  const fold = view.querySelector<HTMLElement>("#fuelHistory");
  const slot = view.querySelector<HTMLElement>("#fuelHistorySlot");
  if (!fold || !slot) return Promise.resolve();
  fold.dataset.painted = "1";
  const peek = peekCached<CoachMealPlan[]>(MEALS_KEY);
  if (!peek) slot.innerHTML = skelLines(3);
  return Promise.resolve(withBundle("meals", () => CairnMealJournal.paintHistory(token, slot, peek)));
}

Object.assign(globalThis, {
  MEALS_KEY,
  MEALS_SETTINGS_KEY,
  renderCoachMealPlans,
  renderMeals,
  repaintMealHistory,
  runMealPlan,
});
