// @ts-check
// Today data loader: cache peeks, cold skeleton paint, primary data fetch, and
// soft SWR refresh gating. Rendering stays in today-screen.

type TodayDataCachedApiOptions<T> = {
  key?: string;
  freshFor?: number;
  onUpgrade?: (data: T, meta: { changed: boolean }) => void;
  project?: (data: T) => T;
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
  // Added by the fan-in: the same payloads /last-set, /program/progression,
  // /strength-journey, /today-agenda and /coaching-focus return, so one open no
  // longer pays a round trip each for them. Optional — an older server (or a
  // response shaped by a future change) simply leaves the client on its
  // individual fetches.
  last_sets?: Record<string, unknown> | null;
  progression_day?: number | null;
  progression?: unknown;
  strength_journey?: unknown;
  agenda?: unknown;
  coaching_focus?: unknown;
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
  // True only when the aggregate answered from the NETWORK in this render. The
  // agenda and the conductor focus are per-render reads by design, so a cached
  // aggregate must never stand in for them: without this flag the screen keeps
  // its own fetches.
  aggregateFresh: boolean;
  agenda: unknown;
  coachingFocus: unknown;
  // Exercise names whose `last-set:<name>` key this render primed from a fresh
  // aggregate, and the plan day whose `program:progression:<day>` it primed.
  primedLastSets: string[];
  primedProgressionDay: number | null;
  // undefined = not covered this render; the prep wave keeps its own fetch.
  strengthJourney?: unknown;
  revalidations: Array<Promise<unknown>>;
  changed(): boolean;
};
type TodayDataLoaderApi = {
  load(opts: { soft?: unknown } | null | undefined, deps: TodayDataLoadDeps): Promise<TodayDataLoadResult>;
  scheduleSoftRepaint(result: TodayDataLoadResult, deps: TodayDataRefreshDeps): void;
  aggregatePath(date: string, tab: string | undefined): string;
};
(() => {
  // Same "did this payload actually change?" test the SWR layer uses: these are
  // small API bodies we already serialize. A value that will not serialize is
  // treated as its own, never-equal identity.
  let unstable = 0;
  function stableJson(value: unknown): string {
    if (value === undefined) return "~absent";
    try {
      return JSON.stringify(value) ?? "~undefined";
    } catch {
      return "~unstable:" + ++unstable;
    }
  }

  // The Today tab asks for the widened aggregate (`surface=today`) and the Session
  // destination for its own (`surface=session`): the `responses` carry every other GET
  // that open makes and prime the request layer (today-prefetch primeFanIn / apiPrime).
  function todayAggregatePath(date: string, tab: string | undefined): string {
    const surface = tab === "today" ? "&surface=today" : tab === "session" ? "&surface=session" : "";
    return "/today?date=" + encodeURIComponent(date) + surface;
  }

  // The fan-in half never reaches the SWR tiers: it holds health reads (directives,
  // recovery) that stay off disk, and it is only ever current for the render that
  // asked. What is remembered is the aggregate proper.
  function withoutResponses<T>(value: T): T {
    if (!value || typeof value !== "object" || !("responses" in (value as object))) return value;
    const { responses: _responses, ...rest } = value as T & { responses?: unknown };
    return rest as T;
  }

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
    const aggregatePath = todayAggregatePath(deps.state.logDate, deps.state.tab);
    const sliceOf = (value: TodayDataAggregate) => [
      { key: "plan", data: value.plan },
      { key: sessKey, data: value.session },
      { key: "stats", data: value.stats },
      { key: "profile", data: value.profile },
      { key: "exercises", data: value.exercises },
    ];
    const primedLastSets: string[] = [];
    let primedProgressionDay: number | null = null;
    // The aggregate carries the prep-wave payloads too. Prime their EXISTING keys
    // (`last-set:<name>`, `program:progression:<day>`) so every other reader —
    // the session surface, a later soft repaint — keeps working unchanged, and
    // report which names this render covered so the prep wave can skip them.
    const primePrepSlices = (value: TodayDataAggregate, fillOnly: boolean) => {
      const lastSets = value.last_sets;
      if (lastSets && typeof lastSets === "object") {
        for (const name of Object.keys(lastSets)) {
          const key = "last-set:" + name;
          // On the background path only FILL a hole: a set logged while the
          // request was in flight already wrote the newer truth into this key.
          if (fillOnly && deps.peekCached(key)) continue;
          deps.storeCached(key, (lastSets as Record<string, unknown>)[name]);
          if (!fillOnly) primedLastSets.push(name);
        }
      }
      const day = value.progression_day;
      if (typeof day === "number" && Number.isFinite(day) && Array.isArray(value.progression)) {
        const key = "program:progression:" + day;
        if (!fillOnly || !deps.peekCached(key)) {
          deps.storeCached(key, value.progression);
          if (!fillOnly) primedProgressionDay = day;
        }
      }
    };

    // Intentional: a cold skeleton wipe happens before captureExDrafts in renderToday.
    // Only an EMPTY host takes it: a Session surface on screen (.sess-dest) is
    // repainted in place once the reads land. Wiping it here blanked the whole
    // workout for as long as a slow network took — every set's sync goes cold.
    if (!warm && !deps.root.querySelector(".today-wrap, .sess-dest")) deps.root.innerHTML = deps.todaySkeleton();

    const isToday = deps.state.logDate === deps.localISO();
    const aggregateKey = "today:aggregate:" + deps.state.logDate;
    let aggregate: TodayDataAggregate | null = null;
    let aggregateFresh = false;
    if (!warm) {
      try {
        const value = await deps.cachedApi(aggregatePath, {
          key: aggregateKey,
          project: withoutResponses,
          onUpgrade: () => {
            aggregateFresh = true;
          },
        });
        if (isTodayAggregate(value)) {
          aggregate = value;
          // Re-check each slice now: a preparation mutation may have primed a
          // newer session while the aggregate GET was in flight.
          for (const slice of sliceOf(value)) {
            if (aggregateFresh || !deps.peekCached(slice.key)) deps.storeCached(slice.key, slice.data);
          }
          primePrepSlices(value, !aggregateFresh);
        }
      } catch {
        aggregate = null;
      }
    } else {
      // WARM: the five slices all peeked, so nothing blocks the paint — but the
      // background refresh is still ONE aggregate, not five separate GETs. It
      // resolves after this render, so its agenda/prep payloads only fill holes;
      // a slice is written (and a soft repaint earned) only when this key has not
      // moved under us while the request was in flight.
      // Read the SAME source the compare below reads (peekCached), not `peeks` —
      // `peeks.plan` may be a synthetic peek built off deps.state.plan, which can
      // be stale relative to the cache. Baselining off state here would make the
      // compare below see a mismatch that was never a genuine in-flight write and
      // silently drop a fresh aggregate slice.
      const before = new Map<string, string>();
      for (const key of ["plan", sessKey, "stats", "profile", "exercises"]) {
        const peek = deps.peekCached(key);
        before.set(key, stableJson(peek ? peek.data : undefined));
      }
      revalidations.push(
        deps.cachedApi(aggregatePath, {
          key: aggregateKey,
          project: withoutResponses,
          onUpgrade: (data) => {
            if (!isTodayAggregate(data)) return;
            for (const slice of sliceOf(data)) {
              const current = deps.peekCached(slice.key);
              const currentJson = stableJson(current ? current.data : undefined);
              // Someone newer (a logged set, a mutation write) owns this key now.
              if (currentJson !== before.get(slice.key)) continue;
              const nextJson = stableJson(slice.data);
              if (nextJson === currentJson) continue;
              deps.storeCached(slice.key, slice.data);
              anyChanged = true;
            }
            primePrepSlices(data, true);
          },
        }).catch(() => {}),
      );
    }
    const useFreshAggregate = !!aggregate && aggregateFresh;
    const latestSessionPeek = deps.peekCached(sessKey);

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
      : latestSessionPeek
      ? Promise.resolve(latestSessionPeek.data)
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
    // Only when the aggregate was tried and could not answer. A warm open already
    // revalidates through the one aggregate above.
    if (!warm && !aggregate) {
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
      aggregateFresh: useFreshAggregate,
      agenda: useFreshAggregate ? aggregate!.agenda ?? null : null,
      coachingFocus: useFreshAggregate ? aggregate!.coaching_focus ?? null : null,
      primedLastSets,
      primedProgressionDay,
      strengthJourney: useFreshAggregate ? aggregate!.strength_journey : undefined,
      revalidations,
      changed: () => anyChanged,
    };
  }

  // The athlete's hands on the screen. A background repaint that lands while they
  // are mid-tap rebuilds the node under the finger, so the refresh waits until they
  // have been still for a beat (it is only news, never urgent). Tracked once, from
  // the first scheduled refresh, with a passive capture listener.
  const HANDS_OFF_MS = 1800;
  const HANDS_OFF_MAX_WAIT_MS = 12000;
  let lastTouchAt = 0;
  let touchWatch = false;
  function watchTouches(): void {
    if (touchWatch || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    touchWatch = true;
    const mark = () => {
      lastTouchAt = Date.now();
    };
    document.addEventListener("pointerdown", mark, { capture: true, passive: true });
    document.addEventListener("keydown", mark, { capture: true, passive: true });
  }
  function handsOnFor(now: number): number {
    return lastTouchAt ? Math.max(0, HANDS_OFF_MS - (now - lastTouchAt)) : 0;
  }

  function scheduleSoftRepaint(result: TodayDataLoadResult, deps: TodayDataRefreshDeps): void {
    if (!result.revalidations.length) return;
    watchTouches();
    const startedAt = Date.now();
    const attempt = () => {
      if (!result.changed()) return;
      if (!deps.isCurrentPoll(result.token) || deps.state.tab !== "today") return;
      const active = document.activeElement;
      if (active && (
        active.closest?.(".ex") ||
        active.closest?.(".addex") ||
        active.closest?.(".wt-inline") ||
        active.closest?.(".checkin-form")
      )) return;
      if (deps.root.querySelector(".brief.is-thinking")) return;
      const wait = handsOnFor(Date.now());
      if (wait > 0 && Date.now() - startedAt < HANDS_OFF_MAX_WAIT_MS && typeof setTimeout === "function") {
        setTimeout(attempt, wait);
        return;
      }
      deps.renderToday({ soft: true });
    };
    Promise.all(result.revalidations).then(attempt);
  }

  const CAIRN_TODAY_DATA_LOADER: TodayDataLoaderApi = {
    load: loadInner,
    scheduleSoftRepaint,
    aggregatePath: todayAggregatePath,
  };

  Object.assign(globalThis, { CairnTodayDataLoader: CAIRN_TODAY_DATA_LOADER });
  if (typeof window !== "undefined") Object.assign(window, { CairnTodayDataLoader: CAIRN_TODAY_DATA_LOADER });
})();
