// @ts-check
// Plan -> Meals planner DOM actions: history actions, prefs, shopping, body wiring.

type MealPlannerActionsPlan = import("../contracts/client-api.js").ClientMealPlan & {
  id: number | string;
};
type MealPlannerActionsContext = { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null;

function mealPlannerActionsRenderMealPlans(plans: unknown, sel = "#meallist", refresh: (() => unknown) | null = null): void {
  const wrap = $(sel);
  if (!wrap) return;
  wrap.innerHTML = CairnMealPlan.mealPlanListHtml(plans);

  wrap.querySelectorAll<HTMLElement>("[data-accept]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/mealplans/${b.dataset.accept}/accept`, { method: "POST" });
      toast("Meal plan accepted");
      swrInvalidate(MEALS_KEY);
      if (refresh) refresh(); else mealPlannerActionsRenderMealPlans(await api("/mealplans?limit=8"), sel);
    })
  );
  wrap.querySelectorAll<HTMLElement>("[data-discard]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/mealplans/${b.dataset.discard}/discard`, { method: "POST" });
      toast("Discarded");
      swrInvalidate(MEALS_KEY);
      if (refresh) refresh(); else mealPlannerActionsRenderMealPlans(await api("/mealplans?limit=8"), sel);
    })
  );
}

function mealPlannerActionsWireMealPrefs(): void {
  const card = view.querySelector<HTMLElement>("#mealPrefs");
  if (!card) return;
  const head = card.querySelector<HTMLElement>("#mealPrefsToggle");
  const bodyEl = card.querySelector<HTMLElement>(".mealprefs-body");
  const ta = card.querySelector<HTMLTextAreaElement>("#mealPrefsText");
  if (!head || !bodyEl || !ta) return;
  head.addEventListener("click", () => {
    const open = bodyEl.hidden === true;
    bodyEl.hidden = !open;
    card.classList.toggle("open", open);
    head.setAttribute("aria-expanded", String(open));
    if (open) ta.focus();
  });
  const bar = mountSaveBar({
    sentinel: card,
    fields: bodyEl,
    onSave: async () => {
      const r = await api("/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meal_prefs: ta.value.trim() }),
      });
      if (CairnMealPlannerJobs.errorMessage(r)) { toast("Couldn't save preferences"); return false; }
      const v = ta.value.trim();
      const prev = card.querySelector<HTMLElement>(".mealprefs-preview");
      if (prev) {
        prev.textContent = v || CairnMealPlan.MEAL_PREFS_PLACEHOLDER;
        prev.classList.toggle("mealprefs-placeholder", !v);
      }
      bodyEl.hidden = true;
      card.classList.remove("open");
      head.setAttribute("aria-expanded", "false");
      return true;
    },
    onDiscard: () => renderMeals(),
  });
  card.querySelectorAll<HTMLElement>("[data-pref]").forEach((c) =>
    c.addEventListener("click", () => {
      const t = c.dataset.pref;
      if (!t) return;
      const cur = ta.value.trim();
      if (cur.toLowerCase().includes(t.toLowerCase())) return;
      ta.value = cur ? cur.replace(/[.;,]\s*$/, "") + ". " + t : t;
      bar.markDirty();
      ta.focus();
    })
  );
}

function mealPlannerActionsWireShoppingChips(currentPlan: MealPlannerActionsPlan): void {
  view.querySelectorAll<HTMLElement>("[data-shop]").forEach((c) =>
    c.addEventListener("click", () => {
      c.classList.toggle("chip-done");
      const done = [...view.querySelectorAll<HTMLElement>("[data-shop].chip-done")].map((el) => Number(el.dataset.shop));
      localStorage.setItem(`shop:${currentPlan.id}`, JSON.stringify(done));
    })
  );
}

function mealPlannerActionsWireMealPlannerBody(currentPlan: MealPlannerActionsPlan | null, ctx: MealPlannerActionsContext): void {
  mealPlannerActionsWireMealPrefs();
  if (currentPlan) {
    CairnMealSwapController.wireMealRows(view, currentPlan, ctx);
    mealPlannerActionsWireShoppingChips(currentPlan);
  }

  const keep = view.querySelector<HTMLElement>("[data-mkeep]");
  if (keep) keep.addEventListener("click", async () => {
    await api(`/mealplans/${keep.dataset.mkeep}/accept`, { method: "POST" });
    toast("Meal plan kept");
    renderMeals();
  });
  const disc = view.querySelector<HTMLElement>("[data-mdiscard]");
  if (disc) disc.addEventListener("click", async () => {
    await api(`/mealplans/${disc.dataset.mdiscard}/discard`, { method: "POST" });
    toast("Discarded");
    renderMeals();
  });

  const draftBtn = view.querySelector("#mealDraftBtn");
  if (draftBtn) draftBtn.addEventListener("click", () => CairnMealPlannerJobs.draftWeeklyMeals());
}

const CAIRN_MEAL_PLANNER_ACTIONS = {
  renderMealPlans: mealPlannerActionsRenderMealPlans,
  wireMealPlannerBody: mealPlannerActionsWireMealPlannerBody,
  wireMealPrefs: mealPlannerActionsWireMealPrefs,
  wireShoppingChips: mealPlannerActionsWireShoppingChips,
};

Object.assign(globalThis, {
  CairnMealPlannerActions: CAIRN_MEAL_PLANNER_ACTIONS,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnMealPlannerActions: CAIRN_MEAL_PLANNER_ACTIONS,
  });
}
