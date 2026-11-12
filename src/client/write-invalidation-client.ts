// @ts-check
// ONE table from a write to the client caches it makes stale.
//
// A write that lands somewhere other than the surface the athlete is looking at —
// a chat turn applying `log_food` in the background, an Undo in Changes, a finished
// session — used to drop only the one key its own call site remembered (usually
// "plan"), so Fuel, Train and the Brief kept painting their last-known read of a
// day that had already changed. Freshness beats speed: every write here names every
// cache layer it touches, and the chat table is held complete by a test against the
// server's own CHAT_ACTION_TYPES (test/clientWriteInvalidation.test.js).
//
// A target is one of:
//   - an SWR key (`"plan"`, exact) or prefix (`"today:aggregate:"`, trailing ":"),
//     dropped through swrInvalidate (swr-cache.ts);
//   - `"@<name>"`, a named snapshot a surface keeps outside the SWR cache (the Train
//     overview's, the endurance view's, the Brief's in-memory read). A surface
//     registers how to clear its own with `register(name, clear)`; an unregistered
//     name (its bundle not loaded yet) has nothing to clear.
// Every invalidation also clears api()'s own micro/stale tier (apiInvalidate), since
// a chat turn's write happened on the server long after the POST that started it.

type WriteInvalidationRoot = typeof globalThis & {
  swrInvalidate?: (keyOrPrefix: string) => void;
  apiInvalidate?: () => void;
  api?: (path: string) => Promise<unknown>;
  state?: { brief?: unknown; plan?: unknown[] };
};

type WriteInvalidationApi = {
  CHAT_ACTION_TARGETS: Readonly<Record<string, readonly string[]>>;
  WRITE_TARGETS: Readonly<Record<string, readonly string[]>>;
  targetsForChatAction(type: unknown): readonly string[];
  targetsForWrite(name: string): readonly string[];
  invalidate(targets: readonly string[], opts?: { keep?: readonly string[] }): string[];
  invalidateChatApplied(applied: unknown): string[];
  invalidateWrite(name: string, opts?: { keep?: readonly string[] }): string[];
  register(name: string, clear: () => void): void;
  trackTurn(turn: unknown, opts?: { owned?: boolean }): void;
  releaseTurn(turn: unknown): void;
  settleTurn(turn: unknown): string[];
  resumeTurns(): void;
  watchedTurns(): number[];
};

{
  // The tables live in write-invalidation-targets.ts (loaded first).
  const { CHAT_ACTION_TARGETS, WRITE_TARGETS } = (globalThis as typeof globalThis & {
    CairnWriteInvalidationTargets: WriteInvalidationTargetsApi;
  }).CairnWriteInvalidationTargets;

  const snapshots = new Map<string, () => void>();

  function register(name: string, clear: () => void): void {
    if (name && typeof clear === "function") snapshots.set(name.replace(/^@/, ""), clear);
  }

  // The Brief: its in-memory read AND the last-known copy the fast path paints from
  // localStorage (today-brief-controller.ts BRIEF_LS_KEY) — clearing only the first
  // let a pre-write Brief paint instantly on the next open.
  const BRIEF_LS_KEY = "cairn.brief.v1";
  register("brief", () => {
    const root = globalThis as WriteInvalidationRoot;
    if (root.state && typeof root.state === "object") root.state.brief = null;
    try {
      localStorage.removeItem(BRIEF_LS_KEY);
    } catch {}
  });
  // The plan Today holds in memory: an empty list is "reload it", the same reset a
  // chat plan_update has always made.
  register("plan", () => {
    const root = globalThis as WriteInvalidationRoot;
    if (root.state && typeof root.state === "object") root.state.plan = [];
  });

  function targetsForChatAction(type: unknown): readonly string[] {
    return typeof type === "string" && Object.hasOwn(CHAT_ACTION_TARGETS, type)
      ? CHAT_ACTION_TARGETS[type]
      : [];
  }

  function targetsForWrite(name: string): readonly string[] {
    return Object.hasOwn(WRITE_TARGETS, name) ? WRITE_TARGETS[name] : [];
  }

  function invalidate(targets: readonly string[], opts: { keep?: readonly string[] } = {}): string[] {
    const root = globalThis as WriteInvalidationRoot;
    const keep = new Set(opts.keep || []);
    const done: string[] = [];
    for (const target of new Set(targets)) {
      if (!target || keep.has(target)) continue;
      if (target.startsWith("@")) {
        const clear = snapshots.get(target.slice(1));
        try {
          clear?.();
        } catch {}
      } else {
        try {
          root.swrInvalidate?.(target);
        } catch {}
      }
      done.push(target);
    }
    if (done.length) {
      try {
        root.apiInvalidate?.();
      } catch {}
    }
    return done;
  }

  // meta.applied of a finished chat turn: [{ type, result?, error? }]. Every entry
  // is honoured, a failed one included — an action can commit and still report an
  // error on its read-back, and a needless refetch costs one GET.
  function invalidateChatApplied(applied: unknown): string[] {
    if (!Array.isArray(applied)) return [];
    const targets: string[] = [];
    for (const entry of applied) {
      const type = entry && typeof entry === "object" ? (entry as { type?: unknown }).type : null;
      targets.push(...targetsForChatAction(type));
    }
    return targets.length ? invalidate(targets) : [];
  }

  function invalidateWrite(name: string, opts: { keep?: readonly string[] } = {}): string[] {
    return invalidate(targetsForWrite(name), opts);
  }

  // ---- following a chat turn to the writes it applies ----
  // A turn applies its actions on the server long after the POST that queued it —
  // 10-60 s for an agent turn. Whoever is showing the turn (Chat's monitor, the Fuel
  // composer) OWNS it and settles it on completion. The moment nobody does — the
  // athlete sent "had 2 eggs and toast" and walked to Today, or left Fuel mid-log —
  // this follows it by a light poll and settles it here, so its writes still retire
  // every cache they made stale. Remembered across reloads (localStorage), so a turn
  // that finished while the app was closed is settled on the next open.
  const TURN_WATCH_LS = "cairn.turnwatch.v1";
  const TURN_WATCH_POLL_MS = 3000;
  const TURN_WATCH_MAX_AGE_MS = 15 * 60 * 1000;
  const TURN_WATCH_MAX = 20;
  const TURN_TERMINAL = new Set(["done", "error", "canceled"]);
  const watched = new Map<number, number>(); // turn id -> first seen (ms)
  const owned = new Set<number>();
  const settled = new Set<number>();
  let watchTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let watchTicking = false;
  let watchResumed = false;

  function turnIdOf(turn: unknown): number | null {
    const raw = turn && typeof turn === "object" ? (turn as { id?: unknown }).id : turn;
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  function persistWatched(): void {
    try {
      if (watched.size) localStorage.setItem(TURN_WATCH_LS, JSON.stringify([...watched]));
      else localStorage.removeItem(TURN_WATCH_LS);
    } catch {}
  }

  function loadWatched(): void {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(TURN_WATCH_LS) || "[]");
      if (!Array.isArray(stored)) return;
      for (const entry of stored) {
        const [id, since] = Array.isArray(entry) ? entry : [];
        const n = turnIdOf(id);
        if (n != null && !watched.has(n) && !settled.has(n)) watched.set(n, Number(since) || Date.now());
      }
    } catch {}
  }

  function scheduleWatch(delay = TURN_WATCH_POLL_MS): void {
    if (watchTimer || watchTicking || typeof setTimeout !== "function") return;
    if (![...watched.keys()].some((id) => !owned.has(id))) return;
    watchTimer = setTimeout(() => {
      watchTimer = 0;
      void watchTick();
    }, delay);
  }

  async function watchTick(): Promise<void> {
    const root = globalThis as WriteInvalidationRoot;
    if (watchTicking || typeof root.api !== "function") return;
    watchTicking = true;
    try {
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      for (const [id, since] of [...watched]) {
        if (owned.has(id) || hidden) continue;
        if (Date.now() - since > TURN_WATCH_MAX_AGE_MS) {
          watched.delete(id);
          continue;
        }
        let row: unknown;
        try {
          row = await root.api(`/chat/turns/${id}`);
        } catch {
          continue; // offline or a dropped poll: try again next tick
        }
        if (owned.has(id) || !watched.has(id)) continue; // claimed or settled meanwhile
        if (row === null) {
          watched.delete(id); // the server no longer knows the turn
          continue;
        }
        const status = row && typeof row === "object" ? String((row as { status?: unknown }).status || "") : "";
        if (TURN_TERMINAL.has(status)) settleTurn(row);
      }
      persistWatched();
    } finally {
      watchTicking = false;
    }
    scheduleWatch();
  }

  // A turn that may write. `owned` = a surface on screen is following it and will
  // settle (or release) it itself.
  function trackTurn(turn: unknown, opts: { owned?: boolean } = {}): void {
    const id = turnIdOf(turn);
    if (id == null || settled.has(id)) return;
    if (opts.owned) owned.add(id);
    if (!watched.has(id)) {
      watched.set(id, Date.now());
      while (watched.size > TURN_WATCH_MAX) watched.delete(watched.keys().next().value as number);
      persistWatched();
    }
    scheduleWatch();
  }

  // The surface that owned it stopped following (left the screen, gave up waiting):
  // the poll here takes over.
  function releaseTurn(turn: unknown): void {
    const id = turnIdOf(turn);
    if (id == null) return;
    owned.delete(id);
    scheduleWatch();
  }

  // A finished turn (a GET /chat/turns/:id row, or its SSE twin): every action it
  // applied retires its caches, exactly once per turn whoever sees it finish first.
  function settleTurn(turn: unknown): string[] {
    const id = turnIdOf(turn);
    if (id != null) {
      const alreadySettled = settled.has(id);
      settled.add(id);
      owned.delete(id);
      if (watched.delete(id)) persistWatched();
      if (alreadySettled) return [];
    }
    const meta = turn && typeof turn === "object" ? (turn as { meta?: unknown }).meta : null;
    const applied = meta && typeof meta === "object" ? (meta as { applied?: unknown }).applied : null;
    return invalidateChatApplied(applied);
  }

  // Boot: pick up turns a previous page left unfinished, and look again whenever
  // the app comes back to the foreground.
  function resumeTurns(): void {
    loadWatched();
    if (!watchResumed) {
      watchResumed = true;
      try {
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState !== "visible") return;
          if (watchTimer) {
            clearTimeout(watchTimer);
            watchTimer = 0;
          }
          scheduleWatch(0);
        });
      } catch {}
    }
    scheduleWatch(0);
  }

  function watchedTurns(): number[] {
    return [...watched.keys()];
  }

  const CAIRN_WRITE_INVALIDATION: WriteInvalidationApi = {
    CHAT_ACTION_TARGETS,
    WRITE_TARGETS,
    targetsForChatAction,
    targetsForWrite,
    invalidate,
    invalidateChatApplied,
    invalidateWrite,
    register,
    trackTurn,
    releaseTurn,
    settleTurn,
    resumeTurns,
    watchedTurns,
  };

  Object.assign(globalThis, { CairnWriteInvalidation: CAIRN_WRITE_INVALIDATION });
}
