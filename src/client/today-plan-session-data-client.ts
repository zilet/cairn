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
  // Present on the Today/Session deps; when absent the batch path is skipped and
  // each name falls back to its own cachedApi read.
  storeCached?(key: string, data: unknown): void;
  isCardioItem(item: TodayPlanSessionDataPlanItem): boolean;
  // Primed by the /today aggregate earlier in THIS render (today-data-loader):
  // these SWR keys already hold this render's server truth, so asking for them
  // again would be one round trip per exercise for an answer we have.
  primedLastSets?: string[];
  primedProgressionDay?: number | null;
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
    deps: Pick<TodayPlanSessionDataDeps, "cachedApi" | "peekCached" | "primedProgressionDay">,
  ): Promise<Record<string, TodayPlanSessionDataPrescription | null | undefined>>;
  loadCardioContext(
    dayItems: TodayPlanSessionDataPlanItem[],
    isToday: boolean,
    deps: TodayPlanSessionDataDeps,
  ): Promise<TodayPlanSessionCardioContext>;
};

(() => {
  // Mirrors MAX_BATCH_LAST_SETS in src/routes/training-log.ts — the number of
  // names GET /last-sets will answer in one request. The client bundle cannot
  // import from the server, so this is a hand-mirrored constant; the batch is
  // chunked at it rather than truncated by the route.
  const LAST_SETS_REQUEST_LIMIT = 32;

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
    const primed = new Set(deps.primedLastSets || []);
    // ONE request for however many names are still open, instead of one per
    // exercise in the wave that blocks first paint. A single name keeps the
    // plain /last-set path (same SWR key, same cheap answer).
    const fetchMany = async (batch: string[]): Promise<Record<string, Record<string, unknown> | null>> => {
      const out: Record<string, Record<string, unknown> | null> = {};
      if (!batch.length) return out;
      if (batch.length === 1 || !deps.storeCached) {
        await Promise.all(batch.map(async (name) => {
          const key = "last-set:" + name;
          try {
            out[name] = await deps.cachedApi("/last-set?exercise=" + encodeURIComponent(name), { key }) as
              | Record<string, unknown>
              | null;
          } catch {
            out[name] = null;
          }
        }));
        return out;
      }
      // GET /last-sets answers at most MAX_BATCH_LAST_SETS names per request
      // (src/routes/training-log.ts) and silently drops the tail. Ask in chunks
      // that size, and pin ONLY the names the response actually answered — a
      // name the server never spoke about is unknown, not "no last set", and
      // caching a false null under its SWR key would pin that lie for the render.
      for (let i = 0; i < batch.length; i += LAST_SETS_REQUEST_LIMIT) {
        const chunk = batch.slice(i, i + LAST_SETS_REQUEST_LIMIT);
        const rows = await deps.api("/last-sets?exercises=" + chunk.map(encodeURIComponent).join(",")) as
          | Record<string, Record<string, unknown> | null>
          | null;
        for (const name of chunk) {
          if (!rows || typeof rows !== "object" || !(name in rows)) continue;
          out[name] = rows[name] ?? null;
          // Write through to the per-exercise key every other reader still uses.
          deps.storeCached("last-set:" + name, out[name]);
        }
      }
      return out;
    };

    const warmNames: string[] = [];
    const coldNames: string[] = [];
    for (const name of needLast) {
      const key = "last-set:" + name;
      // Covered by this render's aggregate: read the key it just primed and ask
      // nothing. An off-plan name the aggregate did not carry still falls through.
      if (primed.has(name)) {
        const primedPeek = deps.peekCached<Record<string, unknown> | null>(key);
        lastSets[name] = primedPeek ? primedPeek.data : null;
        continue;
      }
      const peek = deps.peekCached<Record<string, unknown> | null>(key);
      if (peek) {
        lastSets[name] = peek.data;
        warmNames.push(name);
      } else {
        coldNames.push(name);
      }
    }
    // A warm name already painted from cache; its refresh rides in the background
    // exactly as before, just as one request rather than one per name.
    if (warmNames.length) fetchMany(warmNames).catch(() => {});
    if (coldNames.length) {
      try {
        Object.assign(lastSets, await fetchMany(coldNames));
      } catch {
        for (const name of coldNames) if (!(name in lastSets)) lastSets[name] = null;
      }
    }
    return lastSets;
  }

  async function loadPrescriptions(
    day: number | null,
    planEx: string[],
    deps: Pick<TodayPlanSessionDataDeps, "cachedApi" | "peekCached" | "primedProgressionDay">,
  ): Promise<Record<string, TodayPlanSessionDataPrescription | null | undefined>> {
    const rxByEx: Record<string, TodayPlanSessionDataPrescription | null | undefined> = {};
    if (day == null || !planEx.length) return rxByEx;
    const key = `program:progression:${day}`;
    try {
      // Same day the aggregate primed this render: its rows ARE the answer.
      const primedPeek = deps.primedProgressionDay === day && deps.peekCached ? deps.peekCached(key) : null;
      const list = (primedPeek
        ? primedPeek.data
        : await deps.cachedApi("/program/progression?day=" + encodeURIComponent(day), {
          key,
          freshFor: 15000,
        })) as unknown[];
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
