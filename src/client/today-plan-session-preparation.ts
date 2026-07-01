// @ts-check
// Today plan/session preparation: selected day, skips, cardio matches, last-set
// prefill, pending off-plan cards, and adaptive prescriptions.

type TodayPlanSessionPrepCachedApiOptions<T> = { key?: string; freshFor?: number; onUpgrade?: (data: T, meta: { changed: boolean }) => void };
type TodayPlanSessionPrepSwrPeek<T> = { data: T; fresh: boolean };
type TodayPlanSessionPrepPlanItem = import("../contracts/client.js").ClientPlanItem & {
  fromPlan?: boolean;
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_zone?: string | null;
};
type TodayPlanSessionPrepPlanDay = {
  id?: number;
  day_number: number;
  name?: string;
  focus?: string | null;
  items?: TodayPlanSessionPrepPlanItem[] | null;
  [key: string]: unknown;
};
type TodayPlanSessionPrepLoggedSet = import("../contracts/client.js").ClientLoggedSet & {
  exercise: string;
  set_number?: number | null;
  duration_sec?: number | null;
};
type TodayPlanSessionPrepSession = import("../contracts/client.js").ClientTrainingSession & {
  plan_day_id?: number | null;
  skips?: unknown[];
  sets?: TodayPlanSessionPrepLoggedSet[] | null;
};
type TodayPlanSessionPrepCardioEffort = import("../contracts/client.js").ClientCardioEffort;
type TodayPlanSessionPrepPrescription = import("../contracts/client.js").ClientPrescription & {
  exercise?: string | null;
};
type TodayPlanSessionPrepPendingOffPlan = { name: string; mode?: string | null };
type TodayPlanSessionPrepPrefill = { weight: unknown; reps: unknown; rir: unknown; duration_sec?: unknown };
type TodayPlanSessionPrepState = {
  logDate: string;
  day: number | null;
  dayPicked?: boolean;
  plan: TodayPlanSessionPrepPlanDay[];
  planReveal?: { date: string; on: boolean; blank?: boolean } | null;
  pendingOffPlan?: Record<string, TodayPlanSessionPrepPendingOffPlan[]>;
};
type TodayPlanSessionPrepDeps = {
  state: TodayPlanSessionPrepState;
  session: TodayPlanSessionPrepSession | null | undefined;
  isToday: boolean;
  api(path: string): Promise<unknown>;
  cachedApi(path: string, opts?: TodayPlanSessionPrepCachedApiOptions<unknown>): Promise<unknown>;
  peekCached<T = unknown>(key: string, freshFor?: number): TodayPlanSessionPrepSwrPeek<T> | null;
  suggestedPlanDayNumber(session: TodayPlanSessionPrepSession | null | undefined, isToday: boolean): Promise<number>;
  isCardioItem(item: TodayPlanSessionPrepPlanItem): boolean;
  cardioLabel(item: TodayPlanSessionPrepPlanItem): string;
  cardioEffortMatches(item: TodayPlanSessionPrepPlanItem, effort: TodayPlanSessionPrepCardioEffort | null | undefined): boolean;
};
type TodayPlanSessionPrepResult = {
  revealBlank: boolean;
  day: TodayPlanSessionPrepPlanDay;
  loggedByEx: Record<string, TodayPlanSessionPrepLoggedSet[]>;
  planNames: Set<string>;
  allCardio: TodayPlanSessionPrepPlanItem[];
  cardioEfforts: TodayPlanSessionPrepCardioEffort[];
  todaySettings: unknown;
  matchedCardio: Map<TodayPlanSessionPrepPlanItem, TodayPlanSessionPrepCardioEffort>;
  activeItems: TodayPlanSessionPrepPlanItem[];
  skippedItems: TodayPlanSessionPrepPlanItem[];
  cardioItems: TodayPlanSessionPrepPlanItem[];
  strengthItems: TodayPlanSessionPrepPlanItem[];
  planEx: string[];
  offPlanEx: string[];
  pendingOffPlan: TodayPlanSessionPrepPendingOffPlan[];
  lastSets: Record<string, Record<string, unknown> | null>;
  rxByEx: Record<string, TodayPlanSessionPrepPrescription | null | undefined>;
  rxFor(name: unknown): TodayPlanSessionPrepPrescription | null;
  prefillFor(item: TodayPlanSessionPrepPlanItem): TodayPlanSessionPrepPrefill;
  exDone: number;
  exTotal: number;
  hasSyncedCardioToday: boolean;
  isRunDay: boolean;
  expectingRun: boolean;
};
type TodayPlanSessionPreparationApi = {
  groupLoggedSets(session: TodayPlanSessionPrepSession | null | undefined): Record<string, TodayPlanSessionPrepLoggedSet[]>;
  matchCardioEfforts(
    items: TodayPlanSessionPrepPlanItem[],
    efforts: TodayPlanSessionPrepCardioEffort[],
    matches: TodayPlanSessionPrepDeps["cardioEffortMatches"],
  ): Map<TodayPlanSessionPrepPlanItem, TodayPlanSessionPrepCardioEffort>;
  preparePlanSession(deps: TodayPlanSessionPrepDeps): Promise<TodayPlanSessionPrepResult>;
};

(() => {
  function recordValue(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  function planItems(day: TodayPlanSessionPrepPlanDay | null | undefined): TodayPlanSessionPrepPlanItem[] {
    return Array.isArray(day?.items) ? day.items : [];
  }

  function groupLoggedSets(session: TodayPlanSessionPrepSession | null | undefined): Record<string, TodayPlanSessionPrepLoggedSet[]> {
    const loggedByEx: Record<string, TodayPlanSessionPrepLoggedSet[]> = {};
    if (session) {
      for (const set of session.sets || []) {
        if (!set?.exercise) continue;
        (loggedByEx[set.exercise] ??= []).push(set);
      }
    }
    for (const key of Object.keys(loggedByEx)) {
      loggedByEx[key].sort((a, b) => (a.set_number ?? 0) - (b.set_number ?? 0));
    }
    return loggedByEx;
  }

  function selectedPlanDay(state: TodayPlanSessionPrepState, revealBlank: boolean): TodayPlanSessionPrepPlanDay {
    if (revealBlank && state.day === null) return { day_number: 0, name: "", items: [] };
    return state.plan.find((day) => day.day_number === state.day) || state.plan[0] || { day_number: 0, name: "", items: [] };
  }

  function matchCardioEfforts(
    items: TodayPlanSessionPrepPlanItem[],
    efforts: TodayPlanSessionPrepCardioEffort[],
    matches: TodayPlanSessionPrepDeps["cardioEffortMatches"],
  ): Map<TodayPlanSessionPrepPlanItem, TodayPlanSessionPrepCardioEffort> {
    const matched = new Map<TodayPlanSessionPrepPlanItem, TodayPlanSessionPrepCardioEffort>();
    if (!items.length || !efforts.length) return matched;
    const pool = [...efforts];
    for (const item of items) {
      const index = pool.findIndex((effort) => matches(item, effort));
      if (index >= 0) matched.set(item, pool.splice(index, 1)[0]);
    }
    return matched;
  }

  function pendingForDate(deps: TodayPlanSessionPrepDeps, planNames: Set<string>, loggedByEx: Record<string, TodayPlanSessionPrepLoggedSet[]>) {
    const planLower = new Set([...planNames].map((name) => name.toLowerCase()));
    const loggedLower = new Set(Object.keys(loggedByEx).map((name) => name.toLowerCase()));
    const pending = deps.state.pendingOffPlan?.[deps.state.logDate] ?? [];
    const kept = pending.filter((item) =>
      item && item.name && !planLower.has(item.name.toLowerCase()) && !loggedLower.has(item.name.toLowerCase())
    );
    if (deps.state.pendingOffPlan && deps.state.pendingOffPlan[deps.state.logDate]) deps.state.pendingOffPlan[deps.state.logDate] = kept;
    return kept;
  }

  async function loadLastSets(
    names: string[],
    loggedByEx: Record<string, TodayPlanSessionPrepLoggedSet[]>,
    deps: TodayPlanSessionPrepDeps,
  ): Promise<Record<string, Record<string, unknown> | null>> {
    const needLast = [...new Set(names)].filter((name) => !(loggedByEx[name] && loggedByEx[name].length));
    const lastSets: Record<string, Record<string, unknown> | null> = {};
    await Promise.all(needLast.map(async (name) => {
      const key = "last-set:" + name;
      const peek = deps.peekCached<Record<string, unknown> | null>(key);
      if (peek) {
        lastSets[name] = peek.data;
        deps.cachedApi("/last-set?exercise=" + encodeURIComponent(name), { key }).catch(() => {});
        return;
      }
      try {
        lastSets[name] = await deps.cachedApi("/last-set?exercise=" + encodeURIComponent(name), { key }) as Record<string, unknown> | null;
      } catch {
        lastSets[name] = null;
      }
    }));
    return lastSets;
  }

  async function loadPrescriptions(day: number | null, planEx: string[], deps: TodayPlanSessionPrepDeps) {
    const rxByEx: Record<string, TodayPlanSessionPrepPrescription | null | undefined> = {};
    if (day == null || !planEx.length) return rxByEx;
    try {
      const list = await deps.cachedApi("/program/progression?day=" + encodeURIComponent(day), {
        key: `program:progression:${day}`,
        freshFor: 15000,
      }) as unknown[];
      if (Array.isArray(list)) {
        for (const raw of list) {
          const rx = recordValue(raw) as unknown as TodayPlanSessionPrepPrescription;
          if (rx.exercise) rxByEx[String(rx.exercise).toLowerCase()] = rx;
        }
      }
    } catch {}
    return rxByEx;
  }

  async function loadCardioContext(
    dayItems: TodayPlanSessionPrepPlanItem[],
    isToday: boolean,
    deps: TodayPlanSessionPrepDeps,
  ): Promise<{ allCardio: TodayPlanSessionPrepPlanItem[]; cardioEfforts: TodayPlanSessionPrepCardioEffort[]; todaySettings: unknown }> {
    const allCardio = dayItems.filter(deps.isCardioItem);
    const strengthPlanned = dayItems.some((item) => !deps.isCardioItem(item) && item.exercise);
    const couldHaveRun = allCardio.length > 0 || (isToday && !strengthPlanned);
    let cardioEfforts: TodayPlanSessionPrepCardioEffort[] = [];
    let todaySettings: unknown = null;
    if (couldHaveRun) {
      [cardioEfforts, todaySettings] = await Promise.all([
        deps.api("/cardio?date=" + deps.state.logDate).catch(() => []),
        deps.api("/settings").then((result) => recordValue(result).settings || null).catch(() => null),
      ]) as [TodayPlanSessionPrepCardioEffort[], unknown];
      cardioEfforts = Array.isArray(cardioEfforts) ? cardioEfforts : [];
    }
    return { allCardio, cardioEfforts, todaySettings };
  }

  async function preparePlanSession(deps: TodayPlanSessionPrepDeps): Promise<TodayPlanSessionPrepResult> {
    const loggedByEx = groupLoggedSets(deps.session);
    const revealBlank = !!(deps.state.planReveal && deps.state.planReveal.date === deps.state.logDate && deps.state.planReveal.on && deps.state.planReveal.blank);
    const hasSelectedDay = deps.state.plan.some((day) => day.day_number === deps.state.day);
    if (revealBlank && !deps.state.dayPicked) {
      deps.state.day = null;
    } else if (!deps.state.dayPicked || deps.state.day === null || !hasSelectedDay) {
      deps.state.day = await deps.suggestedPlanDayNumber(deps.session, deps.isToday);
      deps.state.dayPicked = false;
    }

    const day = selectedPlanDay(deps.state, revealBlank);
    const items = planItems(day);
    const planNames = new Set(items.filter((item) => !deps.isCardioItem(item) && item.exercise).map((item) => String(item.exercise)));
    const { allCardio, cardioEfforts, todaySettings } = await loadCardioContext(items, deps.isToday, deps);
    const matchedCardio = matchCardioEfforts(allCardio, cardioEfforts, deps.cardioEffortMatches);
    const skippedSet = new Set(((deps.session && deps.session.skips) || []).map((name) => String(name).toLowerCase()));
    const isSkipped = (item: TodayPlanSessionPrepPlanItem) =>
      deps.isCardioItem(item)
        ? skippedSet.has(deps.cardioLabel(item).toLowerCase()) && !matchedCardio.has(item)
        : !!item.exercise && skippedSet.has(String(item.exercise).toLowerCase()) && !(loggedByEx[String(item.exercise)] || []).length;
    const activeItems = items.filter((item) => !isSkipped(item));
    const skippedItems = items.filter(isSkipped);
    const cardioItems = activeItems.filter(deps.isCardioItem);
    const strengthItems = activeItems.filter((item) => !deps.isCardioItem(item));
    const planEx = activeItems.filter((item) => !deps.isCardioItem(item) && item.exercise).map((item) => String(item.exercise));
    const offPlanEx = Object.keys(loggedByEx).filter((name) => !planNames.has(name));
    const pendingOffPlan = pendingForDate(deps, planNames, loggedByEx);
    const lastSets = await loadLastSets([...planEx, ...pendingOffPlan.map((item) => item.name)], loggedByEx, deps);
    const rxByEx = await loadPrescriptions(deps.state.day, planEx, deps);
    const rxFor = (name: unknown) => (name ? rxByEx[String(name).toLowerCase()] || null : null);
    const prefillFor = (item: TodayPlanSessionPrepPlanItem): TodayPlanSessionPrepPrefill => {
      const exercise = String(item.exercise || "");
      const logged = loggedByEx[exercise] || [];
      if (logged.length) {
        const set = logged[logged.length - 1];
        return { weight: set.weight, reps: set.reps, rir: set.rir, duration_sec: set.duration_sec ?? null };
      }
      const last = lastSets[exercise];
      if (last) return { weight: last.weight, reps: last.reps, rir: last.rir, duration_sec: last.duration_sec ?? null };
      return { weight: item.target_weight ?? null, reps: item.rep_low ?? null, rir: null, duration_sec: item.target_seconds ?? null };
    };
    const exDone = strengthItems.filter((item) => (loggedByEx[String(item.exercise)] || []).length).length;
    const exTotal = strengthItems.length;
    const hasSyncedCardioToday = cardioEfforts.length > 0;
    const isRunDay = (cardioItems.length > 0 || hasSyncedCardioToday) && exTotal === 0;
    const expectingRun = deps.isToday && cardioItems.length > 0 && !cardioItems.some((item) => matchedCardio.has(item));

    return {
      revealBlank,
      day,
      loggedByEx,
      planNames,
      allCardio,
      cardioEfforts,
      todaySettings,
      matchedCardio,
      activeItems,
      skippedItems,
      cardioItems,
      strengthItems,
      planEx,
      offPlanEx,
      pendingOffPlan,
      lastSets,
      rxByEx,
      rxFor,
      prefillFor,
      exDone,
      exTotal,
      hasSyncedCardioToday,
      isRunDay,
      expectingRun,
    };
  }

  const CAIRN_TODAY_PLAN_SESSION_PREPARATION: TodayPlanSessionPreparationApi = {
    groupLoggedSets,
    matchCardioEfforts,
    preparePlanSession,
  };

  Object.assign(globalThis, { CairnTodayPlanSessionPreparation: CAIRN_TODAY_PLAN_SESSION_PREPARATION });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayPlanSessionPreparation: CAIRN_TODAY_PLAN_SESSION_PREPARATION });
  }
})();
