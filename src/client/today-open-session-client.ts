// @ts-check
// Today's open session, client side. The server answers ONE question about a date —
// "is there a session the athlete can start or continue, and what is it called?"
// (`open_session` on the Today aggregate, src/repo/open-session.ts). Every surface that
// offers the session prints that answer's `label` and decides liveness from it; none of
// them guess from a session row or a local set count.
//
// The rules around it live here so today-screen.ts only wires them, and so EVERY caller
// of `openSession` (the Brief, the hero, Train, a day record, the plan editor, a chat
// receipt) gets them: no tap ever ends on a toast with nowhere to go.
//   - `adopt`: before a request that would make or replace a session, an open one the
//     athlete chose or started is opened instead (stale local state never causes a conflict);
//   - `resolveConflict`: a 409 that names its owner opens the owner; one that does not
//     (or a missing/unreachable session) re-reads today from the network and opens
//     what is there, else repaints so the screen says the truth;
//   - the athlete is never shown raw server text.

type OpenSessionRead = import("../contracts/client-api.js").ClientOpenSession;
type OpenSessionOwner = import("../contracts/client-api.js").ClientDailySessionOwner;
type OpenSessionPrepared = { current: boolean; ok: boolean; value?: unknown; error?: unknown };
type OpenOwnedDeps = {
  prepare(body: { date: string; expected_active_id?: number }): Promise<OpenSessionPrepared>;
  enter(date: string, response: Record<string, unknown> | null): void;
  say(message: string): void;
  refresh(): unknown;
};
/** What the Today screen lends this module: where a prepare goes, how a session is entered, what is said. */
type OpenHost = {
  api(path: string, init: Record<string, unknown>): Promise<unknown>;
  run(date: string, task: () => Promise<unknown>): Promise<OpenSessionPrepared>;
  enter(date: string, response: Record<string, unknown> | null): void;
  busy(trigger: HTMLElement | null | undefined, on: boolean, message?: string): void;
  announce(message: string): void;
  toast(message: string): void;
  refresh(): unknown;
  resetPick(): void;
};
type DiscardDeps = {
  api?(path: string, init: Record<string, unknown>): Promise<unknown>;
  say(message: string): void;
  done(): unknown;
};
type AdoptOptions = {
  source?: string;
  agentJobId?: unknown;
  session?: unknown;
  dayNumber?: number | null;
  replace?: boolean;
  trainAnyway?: boolean;
  preview?: unknown;
};

(() => {
  const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

  const globalApi = (path: string, init: Record<string, unknown>): Promise<unknown> =>
    (globalThis as unknown as { api(p: string, i: unknown): Promise<unknown> }).api(path, init);

  /** The SWR key the Today loader fills from each aggregate (never a hand-written value). */
  const key = (date: string): string => `today:open:${date}`;

  // Freshness of the open key: it is only as good as the Today aggregate it rode in on. Every
  // write on this device drops that aggregate (write-invalidation), so while the aggregate is
  // gone the key may name a session that has since moved on and is never asserted by id.
  function cached(date: string): OpenSessionRead | null {
    if (typeof peekCached !== "function" || !peekCached<unknown>(`today:aggregate:${date}`)) return null;
    const row = record(peekCached<unknown>(key(date))?.data);
    return row && Number(row.daily_session_id) > 0 ? (row as unknown as OpenSessionRead) : null;
  }

  /** The owner a daily-session conflict (409) carries. A legacy session row has no composition id. */
  function ownerOf(response: unknown): OpenSessionOwner | null {
    const owner = record(record(response)?.owner);
    return owner && Number(owner.session_id) > 0 ? (owner as unknown as OpenSessionOwner) : null;
  }

  const CONFLICTS = new Set([
    "daily_session_active_changed",
    "daily_session_locked",
    "daily_session_changed",
    "daily_session_missing",
  ]);
  const isConflict = (response: unknown): boolean => CONFLICTS.has(String(record(response)?.code ?? ""));

  /** A name a sentence can use ("Pull"; the empty Open session is "Your session"). */
  const nameOf = (title: unknown): string => {
    const t = String(title ?? "").trim();
    return !t || /^open session$/i.test(t) ? "Your session" : t;
  };

  function asOwner(open: OpenSessionRead): OpenSessionOwner {
    return {
      daily_session_id: open.daily_session_id,
      session_id: open.session_id,
      source: open.source,
      title: open.title,
      set_count: open.set_count,
      started: open.started,
    };
  }

  function forget(date: string): void {
    swrSet(key(date), null);
    for (const prefix of ["today:session:", "today:daily-session:", "today:aggregate:"]) swrInvalidate(prefix + date);
    swrInvalidate("history:sessions");
  }

  /**
   * Remember an open session the app itself just made or opened, before the next Today
   * aggregate says it: the Discard door and the Start/Continue label need it at once. The
   * aggregate replaces it on its next answer.
   */
  function remember(date: string, daily: unknown, session: unknown): void {
    const d = record(daily);
    const s = record(session);
    const id = Number(d?.id);
    if (!(id > 0)) return;
    const started = Array.isArray(s?.sets) && (s!.sets as unknown[]).length > 0;
    const title = String(d?.title || s?.title || "").trim();
    const source = String(d?.source || "");
    swrSet(key(date), {
      daily_session_id: id,
      session_id: Number(s?.id ?? d?.session_id) || 0,
      source,
      plan_day_id: d?.plan_day_id ?? null,
      title,
      set_count: started ? (s!.sets as unknown[]).length : 0,
      started,
      chosen: source === "athlete_override" || source === "manual_plan",
      action: started ? "continue" : "start",
      label: `${started ? "Continue" : "Start"} ${title && !/^open session$/i.test(title) ? title : "your session"}`,
    });
  }

  /**
   * A session row holding logged sets with no composition (sets from chat, MCP or a
   * hand-typed log) has no `open_session` on the aggregate, yet it is exactly what the
   * athlete should be able to continue. The server adopts it on a plain open prepare, so
   * the read is built here from the aggregate's own `session` and `strength_line`; its
   * `daily_session_id` is 0 (no composition to assert), so no one ever asserts it by id.
   * A watch-owned day stays inbound-only and never reads as ours to continue.
   */
  function legacyOpen(today: Record<string, unknown> | null | undefined): OpenSessionRead | null {
    const session = record(today?.session);
    if (!session || Number(session.id) <= 0 || session.finished_at || session.garmin) return null;
    const sets = Array.isArray(session.sets) ? session.sets.length : 0;
    if (!sets) return null;
    const title = String(record(today?.strength_line)?.title || session.title || "").trim();
    return {
      daily_session_id: 0,
      session_id: Number(session.id),
      source: "athlete_override",
      plan_day_id: null,
      title,
      set_count: sets,
      started: true,
      chosen: true,
      action: "continue",
      label: title ? `Continue ${title}` : "Continue your session",
    };
  }

  /** The date's open session read fresh from the network (never the SWR cache); throws when unreachable. */
  async function freshOpen(date: string): Promise<OpenSessionRead | null> {
    const today = record(await globalApi(`/today?date=${encodeURIComponent(date)}`, {}));
    if (!today || !Array.isArray(today.plan)) throw new Error("no aggregate");
    const open = record(today.open_session);
    const read = open && Number(open.daily_session_id) > 0 ? (open as unknown as OpenSessionRead) : legacyOpen(today);
    swrSet(key(date), read);
    return read;
  }

  /**
   * The Brief's read for a day the athlete chose to train on a quiet read: the session is
   * the day, so the rest/easy read is no headline. It survives only as the strength
   * line's caveat (server-worded), which the train-shaped Brief prints.
   */
  function briefRead<T extends { kind?: unknown } | null | undefined>(read: T, open: OpenSessionRead | null | undefined): T {
    if (!read || !open?.chosen || (read.kind !== "rest" && read.kind !== "easy")) return read;
    return { ...read, kind: "train", headline: open.title, why: "", focus: null } as T;
  }

  /**
   * Open the session the server says owns `date`: the assertion path by its id (a legacy
   * session row with no composition just opens by date). `announce` says, once and in plain
   * words, that it was already there. Anything that goes wrong re-reads today (`recover`).
   */
  async function openOwned(
    date: string,
    owner: OpenSessionOwner,
    deps: OpenOwnedDeps,
    announce = false,
    hops = 0,
  ): Promise<boolean> {
    const id = Number(owner.daily_session_id);
    const arrived = (response: Record<string, unknown> | null): boolean => {
      if (response) remember(date, response.daily_session, response.session);
      deps.enter(date, response);
      if (announce) deps.say(`${nameOf(owner.title)} is already open — here it is.`);
      return true;
    };
    // A session row with no composition is adopted by the PLAIN prepare (no replace, no
    // fingerprint, no id): it binds a composition to the row and answers with it.
    const asserted = await deps.prepare(id > 0 ? { date, expected_active_id: id } : { date });
    if (!asserted.current) return false;
    const response = asserted.ok ? record(asserted.value) : null;
    const daily = record(response?.daily_session);
    const session = record(response?.session);
    if (response?.ok === true && daily && session && (id > 0 ? Number(daily.id) === id : Number(daily.id) > 0)) {
      return arrived({ ...response, session: { ...session, daily_session: daily } });
    }
    // Changed again between the conflict and the open: follow the new owner.
    const next = ownerOf(response);
    if (hops < 2 && next && (id > 0 ? Number(next.daily_session_id) !== id : Number(next.daily_session_id) > 0)) return openOwned(date, next, deps, true, hops + 1);
    return recover(date, deps, hops + 1);
  }

  /** Nothing named an owner (or it vanished): ask the server what is open now, and open it. */
  async function recover(date: string, deps: OpenOwnedDeps, hops = 0): Promise<boolean> {
    let open: OpenSessionRead | null | undefined;
    try {
      open = await freshOpen(date);
    } catch {
      open = undefined;
    }
    if (open && hops < 3) return openOwned(date, asOwner(open), deps, true, hops + 1);
    // Forget only what the server has just contradicted; unreachable, nothing was learned, and the
    // saved copy (a staged offline session included) is what the repaint should show.
    if (open !== undefined) forget(date);
    deps.say(open === undefined ? "Couldn't reach Cairn just now — here's what's saved." : "Today moved on — here's where things stand.");
    void deps.refresh();
    return false;
  }

  /** A refused prepare: the owner it names opens; any other session conflict re-reads today. Null = not a conflict. */
  function resolveConflict(date: string, response: unknown, deps: OpenOwnedDeps): Promise<boolean> | null {
    const owner = ownerOf(response);
    if (owner && record(response)?.ok === false) return openOwned(date, owner, deps, true);
    return isConflict(response) ? recover(date, deps) : null;
  }

  /**
   * Every refusal of a prepare ends somewhere true and frees the tap: an owner opens, a session
   * conflict re-reads today, and anything else (a stale preview included) says one plain
   * sentence and repaints. Never null, never a button left reading "Confirming...".
   */
  function settle(date: string, response: unknown, deps: OpenOwnedDeps): Promise<boolean> {
    const resolved = resolveConflict(date, response, deps);
    if (resolved) return resolved;
    deps.say(
      record(response)?.code === "daily_session_preview_stale"
        ? "Today's suggestion just changed — here is the latest."
        : "That session couldn't be opened just now. Try again in a moment.",
    );
    void deps.refresh();
    return Promise.resolve(false);
  }

  /** The deps every open path shares, built over the screen's host (see `OpenHost`). */
  function depsFor(host: OpenHost, date: string, trigger: HTMLElement | null): OpenOwnedDeps {
    return {
      prepare: (body) =>
        host.run(date, () =>
          host.api("/daily-session/prepare", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            acceptErrorBody: true,
          }),
        ),
      // An owner replaces whatever the screen had picked: a stale manual pick never shapes it.
      enter: (d, response) => {
        host.busy(trigger, false);
        host.resetPick();
        host.enter(d, response);
      },
      say: (message) => {
        host.busy(trigger, false, message);
        host.announce(message);
        host.toast(message);
      },
      refresh: () => host.refresh(),
    };
  }

  /**
   * Before a request that would make or replace the date's session: when the athlete's open
   * session is already there — a cached one, or (for a replace / reviewed-preview request)
   * one read fresh — and replacing it would discard something they chose or started, open it
   * instead. Null = nothing to adopt, send the request. A pick of a specific plan day or a
   * built session is a deliberate change and always goes through.
   */
  async function adopt(
    date: string,
    options: AdoptOptions,
    open: (owner: OpenSessionOwner, announce: boolean) => Promise<boolean>,
    pending?: (on: boolean) => void,
  ): Promise<boolean | null> {
    // Only an UNSPECIFIC start (a plain open, Train anyway, the Brief's start) may be redirected.
    // Anything that names what it wants — an agent job, a plan day, an authored session, a manual
    // pick — is a deliberate change: the server decides (it refuses only a STARTED owner).
    if (options.session || options.dayNumber != null || options.agentJobId != null || options.source === "manual_plan")
      return null;
    const replacing = options.replace === true || options.trainAnyway === true;
    let found = cached(date);
    if (replacing || options.preview) {
      pending?.(true);
      try {
        found = await freshOpen(date);
      } catch {
        /* unreachable: the cached one, if any, stands */
      } finally {
        pending?.(false);
      }
    }
    if (!found || (replacing && !found.chosen && !found.started)) return null;
    return open(asOwner(found), replacing);
  }

  /** The rest trade's answer: a train-anyway reply goes straight to the session. */
  const tradeOpensSession = (result: unknown): boolean => record(result)?.train_anyway === true;

  const CAIRN_TODAY_OPEN_SESSION = {
    key,
    cached,
    ownerOf,
    isConflict,
    briefRead,
    remember,
    forget,
    freshOpen,
    legacyOpen,
    openOwned,
    recover,
    resolveConflict,
    settle,
    depsFor,
    adopt,
    tradeOpensSession,
  };
  Object.assign(globalThis, { CairnTodayOpenSession: CAIRN_TODAY_OPEN_SESSION });
})();
