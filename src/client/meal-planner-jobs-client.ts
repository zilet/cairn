// @ts-check
// Plan -> Meals planner job/cache state: draft ops, verification memory, reconnect.

type MealPlannerJobRecord = Record<string, unknown>;
type MealPlannerJobPlan = import("../contracts/client-api.js").ClientMealPlan & {
  id: number | string;
};
type MealPlannerJobProposalResult = import("../contracts/client-api.js").ClientProposalResult & {
  plan?: MealPlannerJobPlan;
  verified?: { checked?: unknown } & MealPlannerJobRecord;
};
type MealPlannerJobOpOptions = ClientAgentOpHandlers & {
  path: string;
  anchor: string;
  caption: string;
  guard: () => boolean;
  isFail: (result: unknown) => boolean;
  render: (result: unknown) => unknown;
  onFail: (error?: unknown) => unknown;
};
type MealPlannerJobBusyElement<T extends Element = HTMLElement> = T & { _busyRestore?: () => void };

// SWR cache keys for the meals journal. Drafts/swaps/reorders/recipes mutate the
// plan server-side or in memory, so writes invalidate MEALS_KEY. MEALS_SETTINGS_KEY
// caches /settings for the verbatim meal_prefs that ride along into the journal.
var MEALS_KEY = "meals:plans";
var MEALS_SETTINGS_KEY = "meals:settings";

const mealPlannerJobVerifiedByPlan = new Map<string | number, unknown>();

function mealPlannerJobRecord(value: unknown): MealPlannerJobRecord {
  return value && typeof value === "object" ? (value as MealPlannerJobRecord) : {};
}

function mealPlannerJobErrorMessage(value: unknown): string | undefined {
  const error = mealPlannerJobRecord(value).error;
  return typeof error === "string" ? error : undefined;
}

function mealPlannerJobRestoreBusy(value: Element | null | undefined): void {
  (value as MealPlannerJobBusyElement | null | undefined)?._busyRestore?.();
}

function mealPlannerDraftFailLine(err: unknown): string {
  if (mealPlannerJobRecord(err).agent_status === "unconfigured")
    return "Drafting a plan needs a coaching agent — connect one in Settings.";
  if (err) return "The coach replied but didn't return a plan — try again.";
  return "Couldn't reach the coach — check your connection.";
}

function mealPlannerRememberVerified(r: unknown): void {
  const row = mealPlannerJobRecord(r) as MealPlannerJobProposalResult;
  if (row.ok && row.plan && row.plan.id != null && row.verified && row.verified.checked) {
    mealPlannerJobVerifiedByPlan.set(row.plan.id, row.verified);
  }
}

function mealPlannerVerifiedForPlan(id: unknown): unknown {
  return id == null ? null : mealPlannerJobVerifiedByPlan.get(id as string | number) || null;
}

function mealPlannerCacheKey(): string {
  return MEALS_KEY;
}

function mealPlannerSettingsCacheKey(): string {
  return MEALS_SETTINGS_KEY;
}

function mealPlannerJobRunCoachMealPlan(agent: string, instruction: string): void {
  const status = $("#mealstatus");
  const btn = $("#mealbtn");
  if (btn) btnBusy(btn, "Drafting…");
  if (status) status.innerHTML = CairnUi.jobCaptionHtml();
  runOp("meal_plan", { agent, instruction }, mealPlannerJobCoachMealPlanOpOpts());
}

function mealPlannerJobCoachMealPlanOpOpts(): MealPlannerJobOpOptions {
  return {
    path: "/coach/mealplan",
    anchor: "#mealstatus",
    caption: "meal_plan",
    guard: () => !$("#mealstatus")?.isConnected,
    isFail: (r: unknown) => {
      const row = mealPlannerJobRecord(r);
      return row.ok !== true || !row.plan;
    },
    render: async (r: unknown) => {
      mealPlannerRememberVerified(r);
      const status = $("#mealstatus");
      const autonomy = mealPlannerJobRecord(mealPlannerJobRecord(r).autonomy);
      if (status)
        status.textContent =
          autonomy.announced || autonomy.pending
            ? "Meal plan ready — it will become current at the next food-day boundary."
            : "Meal plan ready.";
      const btn = $("#mealbtn");
      mealPlannerJobRestoreBusy(btn);
      swrInvalidate(MEALS_KEY);
      try {
        CairnMealPlannerController.renderMealPlans(await api("/mealplans?limit=8"));
      } catch {}
    },
    onFail: (err?: unknown) => {
      const status = $("#mealstatus");
      if (status) status.textContent = mealPlannerDraftFailLine(err);
      const btn = $("#mealbtn");
      mealPlannerJobRestoreBusy(btn);
    },
  };
}

function mealPlannerJobDraftWeeklyMeals(): void {
  const draftBtn = view.querySelector("#mealDraftBtn");
  const status = view.querySelector("#mealDraftStatus");
  if (!status) return;
  if (draftBtn) btnBusy(draftBtn, "Drafting…", { ghost: true });
  status.innerHTML = CairnUi.jobCaptionHtml();
  runOp("meal_plan", { agent: "auto" }, mealPlannerJobMealPlanDraftOpOpts());
}

function mealPlannerJobMealPlanDraftOpOpts(): MealPlannerJobOpOptions {
  return {
    path: "/coach/mealplan",
    anchor: "#mealDraftStatus",
    caption: "meal_plan",
    guard: () => !view.querySelector("#mealDraftStatus")?.isConnected,
    isFail: (r: unknown) => {
      const row = mealPlannerJobRecord(r);
      return row.ok !== true || !row.plan;
    },
    render: (r: unknown) => {
      mealPlannerRememberVerified(r);
      const autonomy = mealPlannerJobRecord(mealPlannerJobRecord(r).autonomy);
      toast(
        autonomy.announced || autonomy.pending ? "Meals refreshed — the next plan is scheduled" : "Meal plan ready"
      );
      swrInvalidate(MEALS_KEY);
      renderMeals();
    },
    onFail: (err?: unknown) => {
      const s = view.querySelector("#mealDraftStatus");
      if (s) s.textContent = mealPlannerDraftFailLine(err);
      const b = view.querySelector("#mealDraftBtn");
      mealPlannerJobRestoreBusy(b);
    },
  };
}

function mealPlannerJobReconnectStatusHost(
  o: MealPlannerJobOpOptions,
  statusSel: string,
  btnSel: string | null,
  ghost: boolean
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
    onDone: (result) => {
      clear();
      if (o.isFail(result)) o.onFail(result);
      else o.render(result);
    },
    onError: () => {
      clear();
      o.onFail(null);
    },
    onCanceled: () => {
      clear();
      o.onFail(null);
    },
  };
}

function mealPlannerJobReconnectMealPlan(): ClientAgentOpHandlers | null {
  if (view.querySelector("#mealDraftStatus")) {
    return mealPlannerJobReconnectStatusHost(
      mealPlannerJobMealPlanDraftOpOpts(),
      "#mealDraftStatus",
      "#mealDraftBtn",
      true
    );
  }
  if (view.querySelector("#mealstatus")) {
    return mealPlannerJobReconnectStatusHost(mealPlannerJobCoachMealPlanOpOpts(), "#mealstatus", "#mealbtn", false);
  }
  return null;
}

const CAIRN_MEAL_PLANNER_JOBS = {
  cacheKey: mealPlannerCacheKey,
  coachMealPlanOpOpts: mealPlannerJobCoachMealPlanOpOpts,
  draftFailLine: mealPlannerDraftFailLine,
  draftWeeklyMeals: mealPlannerJobDraftWeeklyMeals,
  errorMessage: mealPlannerJobErrorMessage,
  mealPlanDraftOpOpts: mealPlannerJobMealPlanDraftOpOpts,
  reconnectMealPlan: mealPlannerJobReconnectMealPlan,
  reconnectStatusHost: mealPlannerJobReconnectStatusHost,
  rememberVerified: mealPlannerRememberVerified,
  restoreBusy: mealPlannerJobRestoreBusy,
  runCoachMealPlan: mealPlannerJobRunCoachMealPlan,
  settingsCacheKey: mealPlannerSettingsCacheKey,
  verifiedForPlan: mealPlannerVerifiedForPlan,
};

Object.assign(globalThis, {
  MEALS_KEY,
  MEALS_SETTINGS_KEY,
  CairnMealPlannerJobs: CAIRN_MEAL_PLANNER_JOBS,
  reconnectMealPlan: mealPlannerJobReconnectMealPlan,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnMealPlannerJobs: CAIRN_MEAL_PLANNER_JOBS,
  });
}
