// @ts-check
// Today data loader: cache peeks, cold skeleton paint, primary data fetch, and
// soft SWR refresh gating. Rendering stays in today-screen.

type TodayDataCachedApiOptions<T> = {
  key?: string;
  freshFor?: number;
  onUpgrade?: (data: T, meta: { changed: boolean }) => void;
};
type TodayDataSwrPeek<T> = { data: T; fresh: boolean };
type TodayDataState = {
  logDate: string;
  plan: unknown[];
  tab?: string;
};
type TodayDataAggregate = {
  date?: string;
  plan: unknown[];
  session: unknown;
  stats: unknown;
  profile: unknown;
  exercises: unknown[];
};
type TodayDataLoadDeps = {
  root: HTMLElement;
  state: TodayDataState;
  api(path: string): Promise<unknown>;
  cachedApi(path: string, opts?: TodayDataCachedApiOptions<unknown>): Promise<unknown>;
  peekCached<T = unknown>(key: string, freshFor?: number): TodayDataSwrPeek<T> | null;
  storeCached(key: string, data: unknown): void;
  localISO(date?: Date): string;
  todaySkeleton(): string;
  setTodayHeaderTitle(): void;
  nextPollToken(): number;
};
type TodayDataRefreshDeps = {
  root: HTMLElement;
  state: TodayDataState;
  isCurrentPoll(token: number): boolean;
  renderToday(opts?: { soft?: boolean }): unknown;
};
type TodayDataLoadResult = {
  soft: boolean;
  token: number;
  isToday: boolean;
  session: unknown;
  stats: unknown;
  profile: unknown;
  exercises: unknown;
  revalidations: Array<Promise<unknown>>;
  changed(): boolean;
};
type TodayDataLoaderApi = {
  load(opts: { soft?: unknown } | null | undefined, deps: TodayDataLoadDeps): Promise<TodayDataLoadResult>;
  scheduleSoftRepaint(result: TodayDataLoadResult, deps: TodayDataRefreshDeps): void;
};

(() => {
  function isTodayAggregate(value: unknown): value is TodayDataAggregate {
    if (!value || typeof value !== "object") return false;
    const row = value as Partial<TodayDataAggregate>;
    return Array.isArray(row.plan) && "session" in row && "stats" in row && "profile" in row && Array.isArray(row.exercises);
  }

  async function loadInner(
    opts: { soft?: unknown } | null | undefined,
    deps: TodayDataLoadDeps,
  ): Promise<TodayDataLoadResult> {
    const soft = !!opts?.soft;
    const token = deps.nextPollToken();
    if (!deps.state.logDate) deps.state.logDate = deps.localISO();
    deps.setTodayHeaderTitle();

    const sessKey = "today:session:" + deps.state.logDate;
    const peeks = {
      plan: deps.state.plan.length ? { data: deps.state.plan, fresh: true } : deps.peekCached("plan"),
      session: deps.peekCached(sessKey),
      stats: deps.peekCached("stats"),
      profile: deps.peekCached("profile"),
      exercises: deps.peekCached("exercises"),
    };
    const warm = Object.values(peeks).every(Boolean);
    let anyChanged = false;
    const revalidations: Array<Promise<unknown>> = [];
    const revalidate = (path: string, key: string) => {
      revalidations.push(
        deps.cachedApi(path, {
          key,
          onUpgrade: (_data, { changed }) => {
            if (changed) anyChanged = true;
          },
        }).catch(() => {}),
      );
    };

    if (!warm && !deps.root.querySelector(".today-wrap")) deps.root.innerHTML = deps.todaySkeleton();

    const isToday = deps.state.logDate === deps.localISO();
    const aggregateKey = "today:aggregate:" + deps.state.logDate;
    let aggregate: TodayDataAggregate | null = null;
    let aggregateFresh = false;
    if (!warm) {
      try {
        const value = await deps.cachedApi("/today?date=" + encodeURIComponent(deps.state.logDate), {
          key: aggregateKey,
          onUpgrade: () => {
            aggregateFresh = true;
          },
        });
        if (isTodayAggregate(value)) {
          aggregate = value;
          if (aggregateFresh || !peeks.plan) deps.storeCached("plan", value.plan);
          if (aggregateFresh || !peeks.session) deps.storeCached(sessKey, value.session);
          if (aggregateFresh || !peeks.stats) deps.storeCached("stats", value.stats);
          if (aggregateFresh || !peeks.profile) deps.storeCached("profile", value.profile);
          if (aggregateFresh || !peeks.exercises) deps.storeCached("exercises", value.exercises);
        }
      } catch {
        aggregate = null;
      }
    }
    const useFreshAggregate = !!aggregate && aggregateFresh;

    const planPromise = useFreshAggregate
      ? Promise.resolve(aggregate!.plan)
      : deps.state.plan.length
      ? Promise.resolve(deps.state.plan)
      : peeks.plan
        ? Promise.resolve(peeks.plan.data)
        : aggregate
          ? Promise.resolve(aggregate.plan)
          : deps.api("/plan");
    const sessionPromise = useFreshAggregate
      ? Promise.resolve(aggregate!.session)
      : peeks.session
      ? Promise.resolve(peeks.session.data)
      : aggregate
        ? Promise.resolve(aggregate.session)
        : deps.api("/sessions?date=" + deps.state.logDate);
    const statsPromise = useFreshAggregate
      ? Promise.resolve(aggregate!.stats)
      : peeks.stats
      ? Promise.resolve(peeks.stats.data)
      : aggregate
        ? Promise.resolve(aggregate.stats)
        : deps.api("/stats");
    const profilePromise = useFreshAggregate
      ? Promise.resolve(aggregate!.profile)
      : peeks.profile
      ? Promise.resolve(peeks.profile.data)
      : aggregate
        ? Promise.resolve(aggregate.profile)
        : deps.api("/profile").catch(() => null);
    const exercisesPromise = useFreshAggregate
      ? Promise.resolve(aggregate!.exercises)
      : peeks.exercises
      ? Promise.resolve(peeks.exercises.data)
      : aggregate
        ? Promise.resolve(aggregate.exercises)
        : deps.api("/exercises").catch(() => []);

    const [plan, session, stats, profile, exercises] = await Promise.all([
      planPromise,
      sessionPromise,
      statsPromise,
      profilePromise,
      exercisesPromise,
    ]);
    if (useFreshAggregate || !deps.state.plan.length) deps.state.plan = plan as unknown[];
    if (!aggregate) {
      revalidate("/plan", "plan");
      revalidate("/sessions?date=" + deps.state.logDate, sessKey);
      revalidate("/stats", "stats");
      revalidate("/profile", "profile");
      revalidate("/exercises", "exercises");
    }

    return {
      soft,
      token,
      isToday,
      session,
      stats,
      profile,
      exercises,
      revalidations,
      changed: () => anyChanged,
    };
  }

  function scheduleSoftRepaint(result: TodayDataLoadResult, deps: TodayDataRefreshDeps): void {
    if (!result.revalidations.length) return;
    Promise.all(result.revalidations).then(() => {
      if (!result.changed()) return;
      if (!deps.isCurrentPoll(result.token) || deps.state.tab !== "today") return;
      const active = document.activeElement;
      if (active && (
        active.closest?.(".ex") ||
        active.closest?.(".quicklog") ||
        active.closest?.(".addex") ||
        active.closest?.(".wt-inline")
      )) return;
      if (deps.root.querySelector(".brief.is-thinking")) return;
      deps.renderToday({ soft: true });
    });
  }

  const CAIRN_TODAY_DATA_LOADER: TodayDataLoaderApi = {
    load: loadInner,
    scheduleSoftRepaint,
  };

  Object.assign(globalThis, { CairnTodayDataLoader: CAIRN_TODAY_DATA_LOADER });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayDataLoader: CAIRN_TODAY_DATA_LOADER });
  }
})();
