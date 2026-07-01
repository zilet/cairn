// @ts-check
// Plan -> Meals planner operations: prefs, draft jobs, swap/reorder, and reconnect.

type MealPlannerControllerRecord = Record<string, unknown>;
type MealPlannerControllerPlan = import("../contracts/client-api.js").ClientMealPlan & {
  id: number | string;
};
type MealPlannerControllerProposalResult = import("../contracts/client-api.js").ClientProposalResult & {
  plan?: MealPlannerControllerPlan;
  verified?: { checked?: unknown } & MealPlannerControllerRecord;
};
type MealPlannerControllerContext = { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null;
type MealPlannerControllerOpOptions = ClientAgentOpHandlers & {
  path: string;
  anchor: string;
  caption: string;
  guard: () => boolean;
  isFail: (result: unknown) => boolean;
  render: (result: unknown) => unknown;
  onFail: (error?: unknown) => unknown;
};
type MealPlannerControllerBusyElement<T extends Element = HTMLElement> = T & { _busyRestore?: () => void };

// SWR cache keys for the meals journal. Drafts/swaps/reorders/recipes mutate the
// plan server-side or in memory, so writes invalidate MEALS_KEY. MEALS_SETTINGS_KEY
// caches /settings for the verbatim meal_prefs that ride along into the journal.
var MEALS_KEY = "meals:plans";
var MEALS_SETTINGS_KEY = "meals:settings";

const mealPlannerVerifiedByPlan = new Map<string | number, unknown>();

function mealPlannerRecord(value: unknown): MealPlannerControllerRecord {
  return value && typeof value === "object" ? value as MealPlannerControllerRecord : {};
}

function mealPlannerErrorMessage(value: unknown): string | undefined {
  const error = mealPlannerRecord(value).error;
  return typeof error === "string" ? error : undefined;
}

function mealPlannerRestoreBusy(value: Element | null | undefined): void {
  (value as MealPlannerControllerBusyElement | null | undefined)?._busyRestore?.();
}

function mealDraftFailLine(err: unknown): string {
  if (mealPlannerRecord(err).agent_status === "unconfigured") return "Drafting a plan needs a coaching agent — connect one in Settings.";
  if (err) return "The coach replied but didn't return a plan — try again.";
  return "Couldn't reach the coach — check your connection.";
}

function rememberVerified(r: unknown): void {
  const row = mealPlannerRecord(r) as MealPlannerControllerProposalResult;
  if (row.ok && row.plan && row.plan.id != null && row.verified && row.verified.checked) {
    mealPlannerVerifiedByPlan.set(row.plan.id, row.verified);
  }
}

function verifiedForPlan(id: unknown): unknown {
  return id == null ? null : mealPlannerVerifiedByPlan.get(id as string | number) || null;
}

function runCoachMealPlan(agent: string, instruction: string): void {
  const status = $("#mealstatus");
  const btn = $("#mealbtn");
  if (btn) btnBusy(btn, "Drafting…");
  if (status) status.innerHTML = CairnUi.jobCaptionHtml();
  runOp("meal_plan", { agent, instruction }, coachMealPlanOpOpts());
}

function coachMealPlanOpOpts(): MealPlannerControllerOpOptions {
  return {
    path: "/coach/mealplan",
    anchor: "#mealstatus",
    caption: "meal_plan",
    guard: () => !$("#mealstatus")?.isConnected,
    isFail: (r: unknown) => {
      const row = mealPlannerRecord(r);
      return row.ok !== true || !row.plan;
    },
    render: async (r: unknown) => {
      rememberVerified(r);
      const status = $("#mealstatus");
      if (status) status.textContent = "Meal plan ready.";
      const btn = $("#mealbtn");
      mealPlannerRestoreBusy(btn);
      swrInvalidate(MEALS_KEY);
      try { renderMealPlans(await api("/mealplans?limit=8")); } catch {}
    },
    onFail: (err?: unknown) => {
      const status = $("#mealstatus");
      if (status) status.textContent = mealDraftFailLine(err);
      const btn = $("#mealbtn");
      mealPlannerRestoreBusy(btn);
    },
  };
}

function renderMealPlans(plans: unknown, sel = "#meallist", refresh: (() => unknown) | null = null): void {
  const wrap = $(sel);
  if (!wrap) return;
  wrap.innerHTML = CairnMealPlan.mealPlanListHtml(plans);

  wrap.querySelectorAll<HTMLElement>("[data-accept]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/mealplans/${b.dataset.accept}/accept`, { method: "POST" });
      toast("Meal plan accepted");
      swrInvalidate(MEALS_KEY);
      if (refresh) refresh(); else renderMealPlans(await api("/mealplans?limit=8"), sel);
    })
  );
  wrap.querySelectorAll<HTMLElement>("[data-discard]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/mealplans/${b.dataset.discard}/discard`, { method: "POST" });
      toast("Discarded");
      swrInvalidate(MEALS_KEY);
      if (refresh) refresh(); else renderMealPlans(await api("/mealplans?limit=8"), sel);
    })
  );
}

function wireMealPrefs(): void {
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
      if (mealPlannerErrorMessage(r)) { toast("Couldn't save preferences"); return false; }
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

function draftWeeklyMeals(): void {
  const draftBtn = view.querySelector("#mealDraftBtn");
  const status = view.querySelector("#mealDraftStatus");
  if (!status) return;
  if (draftBtn) btnBusy(draftBtn, "Drafting…", { ghost: true });
  status.innerHTML = CairnUi.jobCaptionHtml();
  runOp("meal_plan", { agent: "auto" }, mealPlanDraftOpOpts());
}

function mealPlanDraftOpOpts(): MealPlannerControllerOpOptions {
  return {
    path: "/coach/mealplan",
    anchor: "#mealDraftStatus",
    caption: "meal_plan",
    guard: () => !view.querySelector("#mealDraftStatus")?.isConnected,
    isFail: (r: unknown) => {
      const row = mealPlannerRecord(r);
      return row.ok !== true || !row.plan;
    },
    render: (r: unknown) => {
      rememberVerified(r);
      toast("Meal plan drafted");
      swrInvalidate(MEALS_KEY);
      renderMeals();
    },
    onFail: (err?: unknown) => {
      const s = view.querySelector("#mealDraftStatus");
      if (s) s.textContent = mealDraftFailLine(err);
      const b = view.querySelector("#mealDraftBtn");
      mealPlannerRestoreBusy(b);
    },
  };
}

function reconnectStatusHost(
  o: MealPlannerControllerOpOptions,
  statusSel: string,
  btnSel: string | null,
  ghost: boolean,
): ClientAgentOpHandlers | null {
  const status = view.querySelector<HTMLElement>(statusSel);
  if (!status) return null;
  const btn = btnSel ? view.querySelector(btnSel) : null;
  if (btn) btnBusy(btn, "Drafting…", { ghost });
  status.innerHTML = CairnUi.jobCaptionHtml();
  let stop = () => {};
  const capEl = status.querySelector(".job-cap");
  if (capEl) stop = thinkingCaption(capEl, o.caption);
  if (!reducedMotion()) status.classList.add("is-thinking");
  const clear = () => {
    stop();
    const s = view.querySelector<HTMLElement>(statusSel);
    if (s) {
      s.classList.remove("is-thinking", "is-thinking--determinate");
      s.style.removeProperty("--frac");
    }
  };
  return {
    guard: o.guard,
    onDone: (result) => { clear(); if (o.isFail(result)) o.onFail(result); else o.render(result); },
    onError: () => { clear(); o.onFail(null); },
    onCanceled: () => { clear(); o.onFail(null); },
  };
}

function reconnectMealPlan(): ClientAgentOpHandlers | null {
  if (view.querySelector("#mealDraftStatus")) {
    return reconnectStatusHost(mealPlanDraftOpOpts(), "#mealDraftStatus", "#mealDraftBtn", true);
  }
  if (view.querySelector("#mealstatus")) {
    return reconnectStatusHost(coachMealPlanOpOpts(), "#mealstatus", "#mealbtn", false);
  }
  return null;
}

function wireShoppingChips(currentPlan: MealPlannerControllerPlan): void {
  view.querySelectorAll<HTMLElement>("[data-shop]").forEach((c) =>
    c.addEventListener("click", () => {
      c.classList.toggle("chip-done");
      const done = [...view.querySelectorAll<HTMLElement>("[data-shop].chip-done")].map((el) => Number(el.dataset.shop));
      localStorage.setItem(`shop:${currentPlan.id}`, JSON.stringify(done));
    })
  );
}

function wireMealPlannerBody(currentPlan: MealPlannerControllerPlan | null, ctx: MealPlannerControllerContext): void {
  wireMealPrefs();
  if (currentPlan) {
    CairnMealSwapController.wireMealRows(view, currentPlan, ctx);
    wireShoppingChips(currentPlan);
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
  if (draftBtn) draftBtn.addEventListener("click", () => draftWeeklyMeals());
}

const CAIRN_MEAL_PLANNER_CONTROLLER = {
  draftWeeklyMeals,
  reconnectMealPlan,
  reconnectStatusHost,
  renderMealPlans,
  runCoachMealPlan,
  verifiedForPlan,
  wireMealPlannerBody,
};

Object.assign(globalThis, {
  MEALS_KEY,
  MEALS_SETTINGS_KEY,
  CairnMealPlannerController: CAIRN_MEAL_PLANNER_CONTROLLER,
  reconnectMealPlan,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnMealPlannerController: CAIRN_MEAL_PLANNER_CONTROLLER,
  });
}
