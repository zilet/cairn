// @ts-check
// Today plan/session data loading: cache-aware last sets, adaptive
// prescriptions, and cardio context for the pure session preparer.

type TodayPlanSessionDataCachedApiOptions<T> = { key?: string; freshFor?: number; onUpgrade?: (data: T, meta: { changed: boolean }) => void };
type TodayPlanSessionDataSwrPeek<T> = { data: T; fresh: boolean };
type TodayPlanSessionDataPlanItem = import("../contracts/client.js").ClientPlanItem & {
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_zone?: string | null;
};
type TodayPlanSessionDataLoggedSet = import("../contracts/client.js").ClientLoggedSet & {
  exercise: string;
  set_number?: number | null;
  duration_sec?: number | null;
};
type TodayPlanSessionDataCardioEffort = import("../contracts/client.js").ClientCardioEffort;
type TodayPlanSessionDataPrescription = import("../contracts/client.js").ClientPrescription & {
  exercise?: string | null;
};
type TodayPlanSessionDataDeps = {
  state: { logDate: string };
  api(path: string): Promise<unknown>;
  cachedApi(path: string, opts?: TodayPlanSessionDataCachedApiOptions<unknown>): Promise<unknown>;
  peekCached<T = unknown>(key: string, freshFor?: number): TodayPlanSessionDataSwrPeek<T> | null;
  isCardioItem(item: TodayPlanSessionDataPlanItem): boolean;
};
type TodayPlanSessionCardioContext = {
  allCardio: TodayPlanSessionDataPlanItem[];
  cardioEfforts: TodayPlanSessionDataCardioEffort[];
  todaySettings: unknown;
};
type TodayPlanSessionDataApi = {
  loadLastSets(
    names: string[],
    loggedByEx: Record<string, TodayPlanSessionDataLoggedSet[]>,
    deps: TodayPlanSessionDataDeps,
  ): Promise<Record<string, Record<string, unknown> | null>>;
  loadPrescriptions(
    day: number | null,
    planEx: string[],
    deps: Pick<TodayPlanSessionDataDeps, "cachedApi">,
  ): Promise<Record<string, TodayPlanSessionDataPrescription | null | undefined>>;
  loadCardioContext(
    dayItems: TodayPlanSessionDataPlanItem[],
    isToday: boolean,
    deps: TodayPlanSessionDataDeps,
  ): Promise<TodayPlanSessionCardioContext>;
};

(() => {
  function recordValue(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  async function loadLastSets(
    names: string[],
    loggedByEx: Record<string, TodayPlanSessionDataLoggedSet[]>,
    deps: TodayPlanSessionDataDeps,
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

  async function loadPrescriptions(
    day: number | null,
    planEx: string[],
    deps: Pick<TodayPlanSessionDataDeps, "cachedApi">,
  ): Promise<Record<string, TodayPlanSessionDataPrescription | null | undefined>> {
    const rxByEx: Record<string, TodayPlanSessionDataPrescription | null | undefined> = {};
    if (day == null || !planEx.length) return rxByEx;
    try {
      const list = await deps.cachedApi("/program/progression?day=" + encodeURIComponent(day), {
        key: `program:progression:${day}`,
        freshFor: 15000,
      }) as unknown[];
      if (Array.isArray(list)) {
        for (const raw of list) {
          const rx = recordValue(raw) as unknown as TodayPlanSessionDataPrescription;
          if (rx.exercise) rxByEx[String(rx.exercise).toLowerCase()] = rx;
        }
      }
    } catch {}
    return rxByEx;
  }

  async function loadCardioContext(
    dayItems: TodayPlanSessionDataPlanItem[],
    isToday: boolean,
    deps: TodayPlanSessionDataDeps,
  ): Promise<TodayPlanSessionCardioContext> {
    const allCardio = dayItems.filter(deps.isCardioItem);
    const strengthPlanned = dayItems.some((item) => !deps.isCardioItem(item) && item.exercise);
    const couldHaveRun = allCardio.length > 0 || (isToday && !strengthPlanned);
    let cardioEfforts: TodayPlanSessionDataCardioEffort[] = [];
    let todaySettings: unknown = null;
    if (couldHaveRun) {
      [cardioEfforts, todaySettings] = await Promise.all([
        deps.api("/cardio?date=" + deps.state.logDate).catch(() => []),
        deps.api("/settings").then((result) => recordValue(result).settings || null).catch(() => null),
      ]) as [TodayPlanSessionDataCardioEffort[], unknown];
      cardioEfforts = Array.isArray(cardioEfforts) ? cardioEfforts : [];
    }
    return { allCardio, cardioEfforts, todaySettings };
  }

  const CAIRN_TODAY_PLAN_SESSION_DATA: TodayPlanSessionDataApi = {
    loadLastSets,
    loadPrescriptions,
    loadCardioContext,
  };

  Object.assign(globalThis, { CairnTodayPlanSessionData: CAIRN_TODAY_PLAN_SESSION_DATA });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayPlanSessionData: CAIRN_TODAY_PLAN_SESSION_DATA });
  }
})();
