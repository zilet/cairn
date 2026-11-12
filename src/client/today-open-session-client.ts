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
  prepare(body: { date: string; expected_active_id: number }): Promise<OpenSessionPrepared>;
  enter(date: string, response: Record<string, unknown> | null): void;
  say(message: string): void;
  refresh(): unknown;
};
type DiscardDeps = {
  api?(path: string, init: Record<string, unknown>): Promise<unknown>;
  say(message: string): void;
  done(): unknown;
};
type AdoptOptions = {
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

  function cached(date: string): OpenSessionRead | null {
    if (typeof peekCached !== "function") return null;
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

  /** The date's open session read fresh from the network (never the SWR cache); throws when unreachable. */
  async function freshOpen(date: string): Promise<OpenSessionRead | null> {
    const today = record(await globalApi(`/today?date=${encodeURIComponent(date)}`, {}));
    if (!today || !Array.isArray(today.plan)) throw new Error("no aggregate");
    const open = record(today.open_session);
    const read = open && Number(open.daily_session_id) > 0 ? (open as unknown as OpenSessionRead) : null;
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
    if (!(id > 0)) return arrived(null);
    const asserted = await deps.prepare({ date, expected_active_id: id });
    if (!asserted.current) return false;
    const response = asserted.ok ? record(asserted.value) : null;
    const daily = record(response?.daily_session);
    const session = record(response?.session);
    if (response?.ok === true && daily && session && Number(daily.id) === id) {
      return arrived({ ...response, session: { ...session, daily_session: daily } });
    }
    // Changed again between the conflict and the open: follow the new owner.
    const next = ownerOf(response);
    if (hops < 2 && next && Number(next.daily_session_id) !== id) return openOwned(date, next, deps, true, hops + 1);
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
    forget(date);
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
  ): Promise<boolean | null> {
    if (options.session || options.dayNumber != null) return null;
    const replacing = options.replace === true || options.trainAnyway === true;
    let found = cached(date);
    if (replacing || options.preview) {
      try {
        found = await freshOpen(date);
      } catch {
        /* unreachable: the cached one, if any, stands */
      }
    }
    if (!found || (replacing && !found.chosen && !found.started)) return null;
    return open(asOwner(found), replacing);
  }

  /** The quiet "Discard this session" door exists only for a session nothing has been done on. */
  const canDiscard = (open: OpenSessionRead | null | undefined): boolean => !!open && open.started === false;

  /** Drop an unstarted session so the day is free again. True once it is gone. */
  async function discard(date: string, id: number, deps: DiscardDeps): Promise<boolean> {
    let response: Record<string, unknown> | null = null;
    try {
      response = record(
        await (deps.api || globalApi)("/daily-session/discard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date, expected_active_id: id }),
          acceptErrorBody: true,
        }),
      );
    } catch {
      response = null;
    }
    if (response?.ok === true || response?.code === "daily_session_missing") {
      forget(date);
      await deps.done();
      return true;
    }
    deps.say(
      response?.code === "daily_session_locked"
        ? "This session already has work logged, so it stays. Nothing you logged is lost."
        : "Couldn't discard this session. Try again in a moment.",
    );
    return false;
  }

  function wireDiscard(root: ParentNode, deps: DiscardDeps): void {
    const button = root.querySelector<HTMLButtonElement>("#sessDiscard");
    if (!button || button.dataset.wired) return;
    button.dataset.wired = "1";
    button.addEventListener("click", () => {
      if (button.disabled) return;
      button.disabled = true;
      void discard(String(button.dataset.date || ""), Number(button.dataset.id), deps).then((gone) => {
        if (!gone) button.disabled = false;
      });
    });
  }

  /** The quiet door itself, drawn under the session by the shell (session-snapshot-client.ts). */
  function discardHtml(date: string, open: OpenSessionRead | null | undefined): string {
    return canDiscard(open) && Number(open!.daily_session_id) > 0
      ? `<div class="sess-discard-row"><button class="linkbtn sess-discard" id="sessDiscard" type="button" data-date="${escAttr(date)}" data-id="${escAttr(open!.daily_session_id)}">Discard this session</button></div>`
      : "";
  }

  // A session minted by LOOKING at a past day ("Log a session to this day") is a door, not
  // work: leaving the Session destination with nothing logged drops it so the day is free
  // again. The server decides "nothing logged" (a started session answers `locked` and
  // stays), so this never needs a fresh read — and it never says a word about it.
  let pastDay = "";

  const markPastDay = (date: string): void => {
    pastDay = date;
  };

  async function leavePastDay(): Promise<void> {
    const date = pastDay;
    pastDay = "";
    if (!date || typeof peekCached !== "function") return;
    const daily = record(peekCached<unknown>(`today:daily-session:${date}`)?.data);
    const session = record(peekCached<unknown>(`today:session:${date}`)?.data);
    const id = Number((daily || record(session?.daily_session))?.id);
    if (id > 0) await discard(date, id, { say: () => {}, done: () => {} });
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
    freshOpen,
    openOwned,
    recover,
    resolveConflict,
    adopt,
    canDiscard,
    discard,
    wireDiscard,
    discardHtml,
    tradeOpensSession,
    markPastDay,
    leavePastDay,
  };
  Object.assign(globalThis, { CairnTodayOpenSession: CAIRN_TODAY_OPEN_SESSION });
})();
