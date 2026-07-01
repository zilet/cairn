// @ts-check
// Plan -> Meals planner operations: prefs, draft jobs, swap/reorder, and reconnect.

type MealPlannerControllerRecord = Record<string, unknown>;
type MealPlannerControllerPlan = import("../contracts/client-api.js").ClientMealPlan & {
  id: number | string;
  parsed?: MealPlannerControllerParsed;
};
type MealPlannerControllerProposalResult = import("../contracts/client-api.js").ClientProposalResult & {
  plan?: MealPlannerControllerPlan;
  verified?: { checked?: unknown } & MealPlannerControllerRecord;
};
type MealPlannerControllerParsed = MealPlannerControllerRecord & {
  days?: MealPlannerControllerDay[];
  daily_kcal?: unknown;
};
type MealPlannerControllerDay = MealPlannerControllerRecord & {
  day?: unknown;
  meals?: MealPlannerControllerMeal[];
};
type MealPlannerControllerMeal = MealPlannerControllerRecord & {
  name?: unknown;
  meal?: unknown;
  items?: unknown;
  kcal?: unknown;
  protein_g?: unknown;
  carbs_g?: unknown;
  fat_g?: unknown;
  recipe?: unknown;
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

function mealPlannerRows<T extends MealPlannerControllerRecord = MealPlannerControllerRecord>(value: unknown): T[] {
  return Array.isArray(value)
    ? value.filter((row): row is T => !!row && typeof row === "object")
    : [];
}

function mealPlannerPlans(value: unknown): MealPlannerControllerPlan[] {
  return mealPlannerRows<MealPlannerControllerPlan>(value);
}

function mealPlannerPlan(value: unknown): MealPlannerControllerPlan {
  return mealPlannerRecord(value) as MealPlannerControllerPlan;
}

function mealPlannerParsed(value: unknown): MealPlannerControllerParsed {
  return mealPlannerRecord(value) as MealPlannerControllerParsed;
}

function mealPlannerDays(plan: MealPlannerControllerPlan): MealPlannerControllerDay[] {
  const parsed = mealPlannerParsed(plan.parsed);
  return Array.isArray(parsed.days) ? parsed.days : [];
}

function mealPlannerErrorMessage(value: unknown): string | undefined {
  const error = mealPlannerRecord(value).error;
  return typeof error === "string" ? error : undefined;
}

function mealPlannerHtmlElement<T extends HTMLElement = HTMLElement>(value: Element | null | undefined): T | null {
  return value instanceof HTMLElement ? value as T : null;
}

function mealPlannerButtonElement(value: Element | null | undefined): HTMLButtonElement | null {
  return value instanceof HTMLButtonElement ? value : null;
}

function mealPlannerRestoreBusy(value: Element | null | undefined): void {
  (value as MealPlannerControllerBusyElement | null | undefined)?._busyRestore?.();
}

function mealPlannerEventElement(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
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

function rerenderMealDay(
  current: MealPlannerControllerPlan,
  di: number,
  ctx: MealPlannerControllerContext,
  settleMi: number | null = null,
): void {
  const sec = view.querySelector<HTMLElement>(`.mealday[data-mday="${di}"]`);
  const d = mealPlannerDays(current)[di];
  if (!sec || !d) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = CairnMealPlan.mealDayHtml(d, di, ctx || {});
  const fresh = mealPlannerHtmlElement(tmp.firstElementChild);
  if (!fresh) return;
  fresh.classList.remove("reveal");
  sec.replaceWith(fresh);
  wireMealRows(fresh, current, ctx);
  runCountUps(fresh);
  if (settleMi != null) fresh.querySelector(`.meal-row[data-mi="${settleMi}"]`)?.classList.add("meal-settled");
}

async function submitMealSwap(
  current: MealPlannerControllerPlan,
  ctx: MealPlannerControllerContext,
  di: number,
  mi: number,
  panel: HTMLElement,
): Promise<void> {
  const day = mealPlannerDays(current)[di];
  if (!day) return;
  const row = mealPlannerHtmlElement(panel.previousElementSibling);
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

  const body = hint ? { day: day.day, meal_index: mi, hint } : { day: day.day, meal_index: mi };
  await runOp("meal_swap", { id: current.id, ...body }, mealSwapOpOpts(current, ctx, di, mi));
}

function mealSwapOpOpts(
  current: MealPlannerControllerPlan,
  ctx: MealPlannerControllerContext,
  di: number,
  mi: number,
): MealPlannerControllerOpOptions {
  const rowSel = `.mealday[data-mday="${di}"] .meal-row[data-mi="${mi}"]`;
  return {
    path: `/meal-plans/${current.id}/swap`,
    anchor: rowSel,
    caption: "meal_swap",
    guard: () => !view.querySelector(rowSel)?.isConnected,
    isFail: (r: unknown) => {
      const row = mealPlannerRecord(r);
      const plan = mealPlannerPlan(row.plan);
      return row.ok !== true || !(plan.parsed || row.meal);
    },
    render: (r: unknown) => {
      const row = mealPlannerRecord(r);
      const plan = mealPlannerPlan(row.plan);
      if (plan.parsed) current.parsed = mealPlannerParsed(plan.parsed);
      else {
        const d = mealPlannerDays(current)[di];
        if (d?.meals) d.meals[mi] = mealPlannerRecord(row.meal) as MealPlannerControllerMeal;
      }
      swrInvalidate(MEALS_KEY);
      rerenderMealDay(current, di, ctx, mi);
      toast("Meal swapped");
    },
    onFail: () => {
      const row = view.querySelector<HTMLElement>(rowSel);
      if (row) { row.classList.remove("meal-busy"); row.querySelector(".meal-cap")?.remove(); }
      const panel = mealPlannerHtmlElement(row?.nextElementSibling);
      if (panel && panel.classList.contains("meal-swap")) {
        panel.classList.remove("meal-swap-busy");
        panel.querySelectorAll("button,input").forEach((el) => {
          if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) el.disabled = false;
        });
        const go = panel.querySelector(".meal-swap-go");
        mealPlannerRestoreBusy(go);
      }
      toast("Coach couldn't draft a swap — try again");
    },
  };
}

function reconnectMealSwap(job?: unknown): ClientAgentOpHandlers | null {
  const input = mealPlannerRecord(mealPlannerRecord(job).input);
  const planId = Number(input.id);
  const cached = mealPlannerPlans(peekCached<MealPlannerControllerPlan[]>(MEALS_KEY)?.data || []);
  const current = cached.find((p) => Number(p.id) === planId);
  if (!current || !mealPlannerDays(current).length) return null;
  const di = mealPlannerDays(current).findIndex(
    (d) => String(d?.day ?? "").trim().toLowerCase() === String(input.day ?? "").trim().toLowerCase()
  );
  const mi = Number(input.meal_index);
  if (di < 0 || !Number.isFinite(mi)) return null;
  const ctx = CairnMealPlan.mealsCtxFor(current);
  const rowSel = `.mealday[data-mday="${di}"] .meal-row[data-mi="${mi}"]`;
  const row = view.querySelector<HTMLElement>(rowSel);
  if (!row) return null;
  row.classList.add("meal-busy");
  row.querySelector(".meal-cap")?.remove();
  row.insertAdjacentHTML("beforeend", CairnUi.jobCaptionHtml({ className: "meal-cap job-cap" }));
  const o = mealSwapOpOpts(current, ctx, di, mi);
  let stop = () => {};
  const capEl = row.querySelector(".job-cap");
  if (capEl) stop = thinkingCaption(capEl, o.caption);
  if (!reducedMotion()) row.classList.add("is-thinking");
  const clear = () => {
    stop();
    const r = view.querySelector<HTMLElement>(rowSel);
    if (r) {
      r.classList.remove("is-thinking", "is-thinking--determinate");
      r.style.removeProperty("--frac");
    }
  };
  return {
    guard: o.guard,
    onDone: (result) => { clear(); if (o.isFail(result)) o.onFail(result); else o.render(result); },
    onError: () => { clear(); o.onFail(null); },
    onCanceled: () => { clear(); o.onFail(null); },
  };
}

async function moveMealRow(
  current: MealPlannerControllerPlan,
  ctx: MealPlannerControllerContext,
  di: number,
  mi: number,
  dir: number,
): Promise<void> {
  const days = mealPlannerDays(current);
  const meals = days[di]?.meals;
  const j = mi + dir;
  if (!meals || mi < 0 || mi >= meals.length || j < 0 || j >= meals.length) return;
  const token = pollToken;
  [meals[mi], meals[j]] = [meals[j], meals[mi]];
  rerenderMealDay(current, di, ctx, j);
  try {
    const r = await api(`/meal-plans/${current.id}/days`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days }),
    });
    if (mealPlannerErrorMessage(r)) throw new Error(mealPlannerErrorMessage(r));
    swrInvalidate(MEALS_KEY);
  } catch {
    [meals[mi], meals[j]] = [meals[j], meals[mi]];
    if (token === pollToken) {
      rerenderMealDay(current, di, ctx);
      toast("Couldn't save order — reverted");
    }
  }
}

function wireMealRows(scope: ParentNode, current: MealPlannerControllerPlan, ctx: MealPlannerControllerContext): void {
  scope.querySelectorAll<HTMLElement>("[data-mlog]").forEach((b) =>
    b.addEventListener("click", async () => {
      let x: MealPlannerControllerRecord;
      try { x = mealPlannerRecord(JSON.parse(b.dataset.mlog || "{}")); } catch { return; }
      const btn = mealPlannerButtonElement(b);
      if (btn) btn.disabled = true;
      const generic = /^(breakfast|lunch|dinner|snack|pre[- ]?workout|post[- ]?workout)$/i.test(String(x.name || "").trim());
      const title = generic && x.items ? x.items : (x.name || x.items || "Planned meal");
      try {
        await api("/food-notes", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            meal: CairnMealPlan.mealSlotFor(x.name, x.i),
            raw: "",
            parsed: {
              summary: title,
              items: x.items || "",
              kcal: x.kcal,
              protein_g: x.protein_g,
              carbs_g: x.carbs_g,
              fat_g: x.fat_g,
            },
          }),
        });
        b.textContent = "✓ Logged";
        b.classList.add("meal-log-done");
        toast(`${x.name || "Meal"} logged`);
      } catch {
        if (btn) btn.disabled = false;
        toast("Couldn't log meal");
      }
    })
  );

  scope.querySelectorAll<HTMLElement>("[data-mswap]").forEach((b) =>
    b.addEventListener("click", () => {
      const row = mealPlannerHtmlElement(b.closest(".meal-row"));
      const panel = mealPlannerHtmlElement(row?.nextElementSibling);
      if (!row || !panel || !panel.classList.contains("meal-swap") || row.classList.contains("meal-busy")) return;
      panel.hidden = !panel.hidden;
      if (!panel.hidden) panel.querySelector<HTMLInputElement>(".meal-swap-hint")?.focus();
    })
  );
  scope.querySelectorAll<HTMLElement>(".meal-swap-cancel").forEach((b) =>
    b.addEventListener("click", () => {
      const panel = mealPlannerHtmlElement(b.closest(".meal-swap"));
      if (panel) panel.hidden = true;
    })
  );
  scope.querySelectorAll<HTMLElement>(".hintchip").forEach((c) =>
    c.addEventListener("click", () => {
      const panel = mealPlannerHtmlElement(c.closest(".meal-swap"));
      const input = panel?.querySelector<HTMLInputElement>(".meal-swap-hint");
      if (!panel || !input) return;
      const on = c.classList.contains("on");
      panel.querySelectorAll<HTMLElement>(".hintchip").forEach((x) => x.classList.remove("on"));
      c.classList.toggle("on", !on);
      input.value = on ? "" : c.dataset.hint || "";
    })
  );
  scope.querySelectorAll<HTMLInputElement>(".meal-swap-hint").forEach((i) =>
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        i.closest(".meal-swap")?.querySelector<HTMLElement>(".meal-swap-go")?.click();
      }
    })
  );
  scope.querySelectorAll<HTMLElement>(".meal-swap-go").forEach((b) =>
    b.addEventListener("click", () => {
      const panel = mealPlannerHtmlElement(b.closest(".meal-swap"));
      if (!panel) return;
      submitMealSwap(current, ctx, Number(panel.dataset.di), Number(panel.dataset.mi), panel);
    })
  );

  scope.querySelectorAll<HTMLElement>(".meal-mv").forEach((b) =>
    b.addEventListener("click", () => {
      const row = mealPlannerHtmlElement(b.closest(".meal-row"));
      if (!row || row.classList.contains("meal-busy")) return;
      moveMealRow(current, ctx, Number(row.dataset.di), Number(row.dataset.mi), Number(b.dataset.mv));
    })
  );

  scope.querySelectorAll<HTMLElement>(".meal-row[data-di]").forEach((row) =>
    row.addEventListener("click", (e) => {
      if (mealPlannerEventElement(e)?.closest("button, input, a, .meal-swap")) return;
      if (row.classList.contains("meal-busy")) return;
      CairnMealRecipeController.openMealSheet(current, Number(row.dataset.di), Number(row.dataset.mi));
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
    wireMealRows(view, currentPlan, ctx);
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
  reconnectMealSwap,
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
  reconnectMealSwap,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnMealPlannerController: CAIRN_MEAL_PLANNER_CONTROLLER,
  });
}
