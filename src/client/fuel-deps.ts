// @ts-check
// Fuel — the deps factories (docs/DESIGN.md "Component architecture": dependencies
// come in through `deps`). Plan → Food (coach-meals-screen.ts renderFoodJournal)
// builds each Fuel component's deps here from the shell's shared primitives, so the
// components themselves never reach for a global and a test can hand them fakes.
{
  function swr(): ClientFuelSwrDeps {
    return {
      peekCached: (key) => peekCached(key),
      cachedApi: (path, options) => cachedApi(path, options),
      swrInvalidate: (key) => swrInvalidate(key),
      reducedMotion: () => reducedMotion(),
      markRefreshing: (on) => markRefreshing(on),
    };
  }

  const hour = (): number => new Date().getHours();

  /** The unsent "Log food" draft, per viewer; every storage access is guarded. */
  function draft(): { load(): string; save(value: string): void } {
    const KEY = "cairn.fuelLogDraft";
    return {
      load: () => {
        try {
          return localStorage.getItem(KEY) || "";
        } catch {
          return "";
        }
      },
      save: (value) => {
        try {
          if (value) localStorage.setItem(KEY, value);
          else localStorage.removeItem(KEY);
        } catch {
          /* a draft is a convenience */
        }
      },
    };
  }

  /**
   * The composer's idempotency envelope, per viewer: a send writes its request_id
   * and text here before the draft clears, so a reload or a killed app mid-send
   * replays the SAME request (the server answers it once) instead of the athlete
   * retyping and logging the meal twice. Text only — never image bytes — and it
   * expires with the composer's own window. Every storage access is guarded.
   */
  function retryStore(): NonNullable<FoodComposerDeps["retryStore"]> {
    const KEY = "cairn.fuelLogRetry.v1";
    const clearRetry = (): void => {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* a retry envelope is a convenience */
      }
    };
    const valid = (value: unknown): FoodComposerRetryEnvelope | null => {
      const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const requestId = String(v.requestId ?? "")
        .trim()
        .slice(0, 160);
      const text = String(v.text ?? "").slice(0, 12_000);
      const expiresAt = Number(v.expiresAt);
      const hasImage = v.hasImage === true;
      if (!requestId || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || (!text && !hasImage)) return null;
      return { requestId, text, hasImage, expiresAt };
    };
    return {
      loadRetry: () => {
        try {
          const raw = localStorage.getItem(KEY);
          const retry = raw ? valid(JSON.parse(raw)) : null;
          if (raw && !retry) clearRetry();
          return retry;
        } catch {
          clearRetry();
          return null;
        }
      },
      saveRetry: (value) => {
        const retry = valid(value);
        if (!retry) return clearRetry();
        try {
          localStorage.setItem(KEY, JSON.stringify(retry));
        } catch {
          /* a retry envelope is a convenience */
        }
      },
      clearRetry,
    };
  }

  function today(date: string, todayIso: string): ClientFuelTodayDeps {
    return { ...swr(), date, today: todayIso, runCountUps: (scope) => runCountUps(scope) };
  }

  function meals(date: string, todayIso: string, token: number, onChanged: () => void): ClientFuelMealsDeps {
    return {
      ...swr(),
      date,
      today: todayIso,
      api: (path, init) => api(path, init),
      toast: (message) => toast(message),
      expandEl: (el) => expandEl(el),
      collapseEl: (el, done) => collapseEl(el, done),
      armDelete: (btn, onConfirm, options) => armDelete(btn, onConfirm, options),
      // SSE-first, poll fallback (pollEnrichment); its own stale-tab guard means the
      // settle never fires into a surface the athlete has left. The watch ends ONCE:
      // on the settling update, or when the watcher resolves without one (the poll
      // fallback caps out while an agent is still estimating), so the meals slot
      // re-reads and can watch again rather than sitting on "estimating…".
      watchEnrichment: (id, settled) => {
        let done = false;
        const end = (): void => {
          if (done) return;
          done = true;
          settled();
        };
        void pollEnrichment("/food-notes", id, {
          tab: "plan",
          token,
          onUpdate: (row) => {
            if (!enrichmentActive(row.enrichment_status)) end();
          },
        })
          .catch(() => null)
          .then(end);
      },
      onChanged,
    };
  }

  function log(onLogged: (logged: FoodComposerLogged) => void): ClientFuelLogDeps {
    return {
      mountComposer: (host, deps) => CairnFoodComposer.mount(host, deps),
      api: (path, init) => api(path, init),
      toast: (message) => toast(message),
      reducedMotion: () => reducedMotion(),
      hour,
      draft: draft(),
      retryStore: retryStore(),
      onLogged,
    };
  }

  function ideas(date: string, onStart: ClientIdeaCardDeps["onStart"]): ClientIdeaCardDeps {
    return {
      ...swr(),
      date,
      api: (path, init) => api(path, init),
      hour,
      skeleton: () => skelLines(2),
      onStart,
    };
  }

  // The week-menu card's read (meal-menu-card-controller.ts, under MEALS_KEY).
  const MENU_PATH = "/mealplans?limit=12";

  // The reads behind Fuel's top slots, as [path, SWR key]: the day, the intake band,
  // and on today's Fuel the ideas for this hour and the meal-plan journal the week-menu
  // card reads.
  function slotReads(date: string, isToday: boolean, h: number): Array<[string, string]> {
    const T = CairnFuelTodayController;
    const I = CairnIdeaCardController;
    const reads: Array<[string, string]> = [
      [T.dayPath(date), T.dayKey(date)],
      [T.bandPath(date), T.bandKey(date)],
    ];
    if (isToday) reads.push([I.path(date, h), I.key(date)], [MENU_PATH, MEALS_KEY]);
    return reads;
  }

  // Today's Fuel asks those reads in ONE request: /train-home?view=fuel
  // (routes/screen-responses.ts) carries each body keyed by the path its slot asks
  // with, and primes the request layer (apiPrime) — every slot keeps asking for its
  // own path and gets its answer without a trip, cold or revalidating a warm peek. A
  // read the fan-in came back without asks for itself, and any write clears the
  // primes. Skipped when every read would be served from a peek without asking, and
  // asked once per open: a repaint inside a few seconds rides the first.
  const SERVE_FRESH_MS = 3000; // cachedApi's serveFreshFor: younger peeks never ask
  const FAN_IN_REUSE_MS = 3000;
  let lastFanIn: { key: string; at: number } | null = null;
  function primeFanIn(date: string, reads: Array<[string, string]>, h: number): void {
    try {
      if (reads.every(([, key]) => !!peekCached(key, SERVE_FRESH_MS)?.fresh)) return;
      const path = `/train-home?view=fuel&date=${encodeURIComponent(date)}&hour=${h}`;
      const key = `${path} ${typeof apiWriteGeneration === "function" ? apiWriteGeneration() : 0}`;
      if (lastFanIn && lastFanIn.key === key && Date.now() - lastFanIn.at < FAN_IN_REUSE_MS) return;
      lastFanIn = { key, at: Date.now() };
      apiPrime(
        reads.map(([read]) => read),
        api(path as "/train-home").then((value) => (value as { responses?: unknown } | null)?.responses ?? null)
      );
    } catch {
      /* every slot simply asks for its own path */
    }
  }

  // Each slot used to paint its own skeleton and fill in on its own answer, and every
  // answer pushed the slots under it down (the meals list and the day card both grow,
  // and the week-menu card lands far taller than its placeholder). On a cold open the
  // reads are asked together up front, through the SAME cache keys the slots read —
  // with the lazy meals bundle the menu card renders from — and the surface is written
  // once they have answered, so every slot (the menu card too) paints from its warm
  // peek in one frame. Bounded: a slow read fills in when it lands. Returns null when
  // every read is already warm (paint at once).
  const FIRST_PAINT_WAIT_MS = 1500;
  function firstPaint(date: string, isToday: boolean): Promise<void> | null {
    const h = hour();
    const reads = slotReads(date, isToday, h);
    if (isToday) primeFanIn(date, reads, h);
    if (reads.every(([, key]) => !!peekCached(key))) return null;
    const pending: Promise<unknown>[] = reads.map(([path, key]) => cachedApi(path, { key }));
    if (isToday && typeof ensureBundle === "function") pending.push(ensureBundle("meals"));
    for (const read of pending) read.catch(() => {});
    return settledWithin(pending, FIRST_PAINT_WAIT_MS);
  }

  const CAIRN_FUEL_DEPS = { draft, retryStore, today, meals, log, ideas, firstPaint };

  Object.assign(globalThis, { CairnFuelDeps: CAIRN_FUEL_DEPS });
}
