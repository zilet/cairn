// @ts-check
// Today's per-render request helpers, split out of today-data-loader.ts: the one-shot
// GET prefetch the render starts before its slots mount, the hand-over of the
// responses index.html's early fetch already has on the wire, and the /today fan-in
// that primes the request layer for everything else a Today open asks for.

// The per-render GET prefetch (see CairnTodayPrefetch below). Consumers reach it
// through globalThis at call time, never at load time.
type TodayPrefetchApi = {
  reset(): void;
  prefetch(path: string, start: () => Promise<unknown>): Promise<unknown>;
  take(path: string): Promise<unknown> | undefined;
  get(path: string, fetcher: (path: string) => Promise<unknown>): Promise<unknown>;
  // The response index.html's early fetch already has on the wire for this API
  // path (without the /api prefix), handed over exactly once; undefined otherwise.
  takeEarly?(path: string): Promise<Response> | undefined;
  // Prime the request layer from the widened /today aggregate for this render
  // (`surface` "today", the default, or "session" for the Session destination).
  primeFanIn?(date: string, deps: TodayFanInDeps, surface?: "today" | "session"): void;
};
type TodayFanInDeps = {
  api(path: string): Promise<unknown>;
  localISO(date?: Date): string;
};

(() => {
  // ---- the per-render GET prefetch ----------------------------------------------
  // Today's panels each fetch their own data once their slot is on screen, and the
  // slots only exist after the first paint (which waits on the session preview) or
  // after the agenda decides the rail. That made independent reads queue behind
  // unrelated ones in serial waves. The render now STARTS those GETs as soon as it
  // knows they will be asked for, and the loader that later asks takes the promise
  // already in flight instead of starting a second request.
  //
  // One-shot and render-scoped: each path is handed out AT MOST ONCE, renderToday
  // resets the registry at its start, and an entry older than PREFETCH_TTL_MS is
  // dropped rather than served — a later draw of the same panel is a deliberate
  // refresh and always fetches. A path nobody prefetched falls straight through to
  // the loader's own fetch, so every caller outside Today keeps working untouched.
  // The TTL only has to outlast one render's first paint on a slow host; an entry
  // that ages out costs a second request, never a wrong answer.
  const PREFETCH_TTL_MS = 15000;
  let prefetched = new Map<string, { at: number; promise: Promise<unknown> }>();

  function prefetchNow(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  }

  function resetPrefetch(): void {
    prefetched = new Map();
  }

  function prefetch(path: string, start: () => Promise<unknown>): Promise<unknown> {
    const existing = prefetched.get(path);
    if (existing && prefetchNow() - existing.at <= PREFETCH_TTL_MS) return existing.promise;
    let promise: Promise<unknown>;
    try {
      promise = Promise.resolve(start());
    } catch (error) {
      promise = Promise.reject(error);
    }
    // Nobody may ever take it (the render moved on): never an unhandled rejection.
    promise.catch(() => {});
    prefetched.set(path, { at: prefetchNow(), promise });
    return promise;
  }

  function take(path: string): Promise<unknown> | undefined {
    const entry = prefetched.get(path);
    if (!entry) return undefined;
    prefetched.delete(path);
    if (prefetchNow() - entry.at > PREFETCH_TTL_MS) return undefined;
    return entry.promise;
  }

  function prefetchedGet(path: string, fetcher: (path: string) => Promise<unknown>): Promise<unknown> {
    return take(path) ?? fetcher(path);
  }

  // ---- the early fetch (index.html) ----------------------------------------------
  // index.html starts Today's paint-critical GETs (the aggregate, the Brief's read,
  // the session preview) before the bundles have even parsed, with the same token
  // and zone headers api() sends, and parks each Response under its API path in
  // `window.__cairnEarly`. api() asks here before it fetches: each response is handed
  // over ONCE, only while young, and only for the exact path it was asked for — so a
  // later render, another date or an override always goes to the network.
  const EARLY_TTL_MS = 15000;
  const PRIME_REUSE_MS = 3000;

  function takeEarly(path: string): Promise<Response> | undefined {
    try {
      const table = (globalThis as { __cairnEarly?: Record<string, { at?: unknown; res?: unknown } | undefined> })
        .__cairnEarly;
      const entry = table ? table[path] : undefined;
      if (!table || !entry) return undefined;
      delete table[path];
      const at = Number(entry.at);
      if (!Number.isFinite(at) || Date.now() - at > EARLY_TTL_MS) return undefined;
      const res = entry.res as Promise<Response | null> | undefined;
      // index.html's catch resolves null, which only a rejected fetch() produces: that is
      // a network failure (api-reach.ts), never a cue to ask again.
      if (!res || typeof (res as Promise<unknown>).then !== "function") return undefined;
      return res.then((r) => r || Promise.reject(new TypeError("offline")));
    } catch {
      return undefined;
    }
  }

  // ---- one trip for the whole open ------------------------------------------------
  // `/today?surface=today` carries, in `responses`, the body of every other GET a
  // Today open makes — the plan-day pick, the run line's agenda, the side panels, the
  // tag chips, the directives, the Changes line, the agenda and conductor,
  // and the rail cards the agenda names (src/routes/today-responses.ts). Priming the
  // request layer with it (apiPrime, api-core.ts) lets every loader keep asking for
  // its own path and simply get its answer without a round trip; a path the fan-in
  // came back without falls through to its own request, and any write clears every
  // prime. When THIS page primed the same date seconds ago (a soft repaint), those
  // primes still stand, so nothing is asked again — a fresh page load always primes.
  // The Session destination primes the same way from `/today?surface=session`: the
  // header's strength line, the plan-day pick, the anchor journey, the day's symptom
  // rows — and, once it lands, the picked day's prescriptions and primer.
  let lastPrime: { key: string; at: number } | null = null;
  function primeFanIn(date: string, deps: TodayFanInDeps, surface: "today" | "session" = "today"): void {
    try {
      const key = date + surface;
      if (lastPrime && lastPrime.key === key && Date.now() - lastPrime.at < PRIME_REUSE_MS) return;
      lastPrime = { key, at: Date.now() };
      const q = encodeURIComponent;
      const paths = [`/today-plan-day?date=${q(date)}`, "/strength-journey", "/settings", "/profile"];
      if (surface === "session") {
        paths.push(`/today-strength-line?date=${q(date)}`, `/training-symptoms?on=${q(date)}&include_resolved=1`);
      } else {
        paths.push(`/today-agenda?date=${q(date)}`, "/coaching-focus", `/today-side?date=${q(date)}`, "/context-tags/vocab",
          `/context-tags?date=${q(deps.localISO())}`, "/directives", "/brain/changes",
          `/today-path?date=${q(date)}`, `/today-digest?date=${q(date)}`);
        if (date === deps.localISO()) {
          paths.push(`/training-agenda?date=${q(date)}`, "/plan/week", "/recovery/baseline", `/nutrition/day?date=${q(date)}`);
          // The Fuel glance's ideas, asked for the device's hour exactly as the glance spells
          // them (today-fuel-glance-client.ts); a fan-in framed in another hour leaves it out.
          paths.push(`/fuel/ideas?date=${q(date)}&hour=${new Date().getHours()}`);
        }
      }
      const aggregate = deps.api(CairnTodayDataLoader.aggregatePath(date, surface));
      apiPrime(paths, aggregate.then((value) => (value as { responses?: unknown } | null)?.responses ?? null));
    } catch {
      /* every loader simply asks for its own path */
    }
  }

  const CAIRN_TODAY_PREFETCH: TodayPrefetchApi = {
    reset: resetPrefetch,
    prefetch,
    take,
    get: prefetchedGet,
    takeEarly,
    primeFanIn,
  };

  Object.assign(globalThis, { CairnTodayPrefetch: CAIRN_TODAY_PREFETCH });
  if (typeof window !== "undefined") Object.assign(window, { CairnTodayPrefetch: CAIRN_TODAY_PREFETCH });

})();
