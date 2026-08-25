// @ts-check
// Today session skip/restore and off-plan removal helpers.

type TodaySessionSkipPendingOffPlan = { name: string; mode?: string | null };
type TodaySessionSkipState = {
  tab?: string;
  logDate: string;
  sessionIdsByDate?: Record<string, string>;
  pendingOffPlan?: Record<string, TodaySessionSkipPendingOffPlan[]>;
};

type TodaySessionSkipStatusApi = {
  skipNameHtml(name: unknown): string;
};

type TodaySessionSkipDeps = {
  root: HTMLElement;
  state: TodaySessionSkipState;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  invalidate(key: string): void;
  renderToday(opts?: Record<string, unknown>): unknown;
  toast(message: string, options?: { action?: string; onAction?: () => void }): void;
  collapseEl(el: Element, done?: () => void): void;
  expandEl(el: Element): void;
  sessionStatus: TodaySessionSkipStatusApi;
};

type TodaySessionSkipOutboxGlobals = {
  runSessionMutation?: (
    input: {
      date: string;
      kind: string;
      path: string;
      body: unknown;
      method?: "POST" | "DELETE";
      identity?: { sessionId?: unknown; dailySessionId?: unknown };
    },
    send: (idempotencyKey: string) => Promise<unknown>,
  ) => Promise<{
    status: "sent" | "queued" | "blocked" | "storage_error" | "failed";
    value?: unknown;
    reason?: unknown;
    item?: { depends_on?: unknown };
  }>;
};

(() => {
  function surfaceStillCurrent(deps: TodaySessionSkipDeps, date: string, tab: string | undefined): boolean {
    return deps.state.logDate === date && deps.state.tab === tab;
  }

  function responseRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  function skipOutboxGlobals(): TodaySessionSkipOutboxGlobals {
    return globalThis as TodaySessionSkipOutboxGlobals;
  }

  function prepareBarrierMessage(reason: unknown, action: "skip" | "restore"): string {
    if (reason === "other_tab") {
      return `This session is being prepared in another tab or view — refresh before ${action === "skip" ? "skipping" : "restoring"}.`;
    }
    return `This saved session needs attention before exercises can be ${action === "skip" ? "skipped" : "restored"}.`;
  }

  async function runSkipMutation(
    kind: "skip" | "restore",
    method: "POST" | "DELETE",
    body: Record<string, unknown>,
    date: string,
    deps: TodaySessionSkipDeps,
  ): Promise<{
    status: "sent" | "queued" | "blocked" | "storage_error" | "failed";
    value?: unknown;
    reason?: unknown;
    item?: { depends_on?: unknown };
  }> {
    const globals = skipOutboxGlobals();
    if (typeof globals.runSessionMutation !== "function") return { status: "failed" };
    return globals.runSessionMutation({
      date,
      kind,
      path: "/sessions/skip",
      body,
      method,
      identity: { sessionId: deps.state.sessionIdsByDate?.[date] },
    }, (idempotencyKey) => deps.api("/sessions/skip", {
      method,
      headers: { "Content-Type": "application/json", "X-Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    }));
  }

  function addSkipName(name: string, deps: TodaySessionSkipDeps): void {
    const line = deps.root.querySelector("#skipLine");
    const names = line?.querySelector(".skipline-names");
    if (!line || !names) return;
    const dup = [...names.querySelectorAll<HTMLElement>("[data-unskip]")]
      .some((button) => decodeURIComponent(button.dataset.unskip || "").toLowerCase() === name.toLowerCase());
    if (!dup) {
      const tpl = document.createElement("template");
      tpl.innerHTML = deps.sessionStatus.skipNameHtml(name).trim();
      const el = tpl.content.firstElementChild as HTMLElement | null;
      if (!el) return;
      el.classList.add("chip-in");
      names.appendChild(el);
    }
    line.classList.remove("skipline-empty");
  }

  // Lift this lift's name(s) off the skip line and hand back the undo. Keeping the
  // ORIGINAL nodes (rather than re-rendering them) is what lets a refused restore
  // put the line back exactly as it was, down to the element the athlete tapped.
  function detachSkipNames(name: string, deps: TodaySessionSkipDeps): () => void {
    const line = deps.root.querySelector("#skipLine");
    if (!line) return () => {};
    const detached = [...line.querySelectorAll<HTMLElement>("[data-unskip]")]
      .filter((button) => decodeURIComponent(button.dataset.unskip || "").toLowerCase() === name.toLowerCase())
      .map((node) => ({ node, parent: node.parentElement, anchor: node.nextElementSibling }));
    for (const { node } of detached) node.remove();
    if (!line.querySelector("[data-unskip]")) line.classList.add("skipline-empty");
    return () => {
      for (const { node, parent, anchor } of detached) {
        if (!parent) continue;
        if (anchor && anchor.parentElement === parent) parent.insertBefore(node, anchor);
        else parent.appendChild(node);
      }
      if (line.querySelector("[data-unskip]")) line.classList.remove("skipline-empty");
    };
  }

  function removeSkipName(name: string, deps: TodaySessionSkipDeps): void {
    detachSkipNames(name, deps);
  }

  // A skip is recorded against the LIFT, by name — the server has no notion of a
  // per-card skip. A peak day renders that one lift twice (top single, back-off
  // block), so both cards have to leave together or the surface would keep offering
  // work the server has already recorded as skipped. One card per exercise returns
  // just itself.
  function siblingCards(card: HTMLElement, deps: TodaySessionSkipDeps): HTMLElement[] {
    const name = (card.dataset.card || "").toLowerCase();
    if (!name) return [card];
    const all = [...deps.root.querySelectorAll<HTMLElement>(".ex[data-card]")]
      .filter((el) => (el.dataset.card || "").toLowerCase() === name);
    return all.length ? all : [card];
  }

  // The athlete-facing message for a skip/restore that did NOT take, or null when
  // it did. A queued write took: it is durably held and will replay.
  function skipFailureMessage(
    mutation: { status: string; value?: unknown; reason?: unknown },
    action: "skip" | "restore",
    date: string,
  ): string | null {
    const refused = action === "skip" ? "Couldn't skip — try again" : "Couldn't restore — try again";
    if (mutation.status === "sent") {
      const result = responseRecord(mutation.value);
      const responseDateMatches = result.date == null || String(result.date) === date;
      if (action === "skip" && (result.ok !== true || !responseDateMatches)) {
        return result.error ? "Sets already logged — delete them first" : refused;
      }
      if (action === "restore" && (result.ok === false || result.error)) return refused;
      return null;
    }
    if (mutation.status === "queued") return null;
    if (mutation.status === "blocked") return prepareBarrierMessage(mutation.reason, action);
    if (mutation.status === "storage_error") {
      return action === "skip"
        ? "Couldn’t save that skip on this device — free storage and try again."
        : "Couldn’t save that restore on this device — free storage and try again.";
    }
    return refused;
  }

  // Cards leave the surface on the tap, so an Undo tapped in the same breath can
  // outrun the skip it undoes. The restore waits on the skip's own promise rather
  // than letting a DELETE and a POST for one lift race to the server. Outcomes
  // stay readable after the promise settles so a refused skip's Undo can no-op
  // instead of DELETEing a skip that never existed.
  type SkipMutationResult = Awaited<ReturnType<typeof runSkipMutation>>;
  const pendingSkips = new Map<string, Promise<SkipMutationResult>>();
  const skipOutcomes = new Map<string, SkipMutationResult>();

  function pendingSkipKey(date: string, exercise: string): string {
    return `${date}|${exercise.toLowerCase()}`;
  }

  function removeCards(cards: HTMLElement[], exercise: string, deps: TodaySessionSkipDeps, guard: () => boolean): void {
    let outstanding = cards.length;
    for (const el of cards) {
      deps.collapseEl(el, () => {
        if (!guard()) return;
        el.remove();
        if (--outstanding > 0) return;
        addSkipName(exercise, deps);
      });
    }
  }

  // The DOM half of an undo, shared by the Undo action and by a skip that the
  // server refused. Returns false when the cards can't be put back by surgery
  // (their anchor is gone with the surface), which is the caller's cue to repaint.
  function restoreCards(
    cards: HTMLElement[],
    anchor: Element | null,
    exercise: string,
    deps: TodaySessionSkipDeps,
  ): boolean {
    removeSkipName(exercise, deps);
    const detached = cards.filter((el) => !el.isConnected);
    if (detached.length) {
      const before = anchor && anchor.isConnected ? anchor : deps.root.querySelector(".addex");
      if (!before || !before.parentNode) return false;
      for (const el of detached) before.parentNode.insertBefore(el, before);
    }
    for (const el of cards) deps.expandEl(el);
    return true;
  }

  // OPTIMISTIC: "not today" is the athlete's own decision, so the card collapses on
  // the tap and the write follows. The one thing the server can refuse — sets are
  // already logged against the lift — puts the card straight back, which is the
  // same restore the Undo toast performs.
  async function skipFromCard(
    card: HTMLElement | null,
    exercise: string,
    deps: TodaySessionSkipDeps,
    actionDate: string,
    actionTab: string | undefined,
  ): Promise<void> {
    if (!card) return;
    const cards = siblingCards(card, deps);
    const anchor = cards[cards.length - 1].nextElementSibling;
    const guard = () => surfaceStillCurrent(deps, actionDate, actionTab);
    removeCards(cards, exercise, deps, guard);
    // Undo rides on BOTH toasts: a queued skip is still a skip the athlete may want
    // back, and dropping the affordance when the network is down is exactly the
    // wrong time to drop it.
    const undo = {
      action: "Undo",
      onAction: () => { void undoSkip(cards, anchor, exercise, deps, actionDate, actionTab); },
    };
    deps.toast(`${exercise} skipped today`, undo);

    const key = pendingSkipKey(actionDate, exercise);
    const inFlight = runSkipMutation("skip", "POST", { date: actionDate, exercise }, actionDate, deps);
    pendingSkips.set(key, inFlight.catch(() => ({ status: "failed" as const })));
    let mutation: SkipMutationResult = { status: "failed" };
    try {
      mutation = await inFlight;
    } catch {
      mutation = { status: "failed" };
    } finally {
      skipOutcomes.set(key, mutation);
      Promise.resolve().then(() => {
        if (pendingSkips.get(key)) pendingSkips.delete(key);
      });
    }

    const failure = skipFailureMessage(mutation, "skip", actionDate);
    if (failure) {
      if (!restoreCards(cards, anchor, exercise, deps) && guard()) void deps.renderToday();
      if (guard()) deps.toast(failure);
      return;
    }
    if (mutation.status === "sent") {
      CairnTodaySessionSetModel.rememberMutationSessionId(deps, actionDate, responseRecord(mutation.value));
    }
    if (!guard()) return;
    if (mutation.status === "queued") {
      deps.toast(`${exercise} skip saved — will sync`, undo);
      return;
    }
    deps.invalidate("today:session:" + actionDate);
    if (deps.state.tab === "today") void deps.renderToday({ soft: true });
  }

  async function undoSkip(
    cards: HTMLElement[],
    anchor: Element | null,
    exercise: string,
    deps: TodaySessionSkipDeps,
    actionDate: string,
    actionTab: string | undefined,
  ): Promise<void> {
    if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
    const guard = () => surfaceStillCurrent(deps, actionDate, actionTab);
    // The cards come back first, for the same reason they left first.
    const restored = restoreCards(cards, anchor, exercise, deps);

    const key = pendingSkipKey(actionDate, exercise);
    const pending = pendingSkips.get(key);
    const skipMutation = pending ? await pending : skipOutcomes.get(key);
    if (skipMutation && skipFailureMessage(skipMutation, "skip", actionDate)) {
      // The skip never landed. The card is already back (this restore, or the
      // skip's own failure branch). A DELETE would 404 and then collapse it again.
      return;
    }
    skipOutcomes.delete(key);
    const mutation = await runSkipMutation("restore", "DELETE", { date: actionDate, exercise }, actionDate, deps);
    const failure = skipFailureMessage(mutation, "restore", actionDate);
    if (failure) {
      if (restored) removeCards(cards, exercise, deps, guard);
      if (guard()) deps.toast(failure);
      return;
    }
    if (!guard()) return;
    if (mutation.status !== "queued") deps.invalidate("today:session:" + actionDate);
    // Surgery couldn't seat the cards (their anchor left with the surface) — a
    // repaint is the only way back.
    if (!restored) {
      void deps.renderToday({ soft: true });
      return;
    }
    if (mutation.status === "queued") deps.toast(`${exercise} restore saved — will sync`);
  }

  function removeOffPlanCard(card: HTMLElement | null, deps: TodaySessionSkipDeps): void {
    if (!card) return;
    const name = card.dataset.card;
    const pending = deps.state.pendingOffPlan?.[deps.state.logDate];
    if (name && pending) {
      deps.state.pendingOffPlan![deps.state.logDate] = pending.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
    }
    deps.collapseEl(card, () => card.remove());
  }

  function wireSkips(deps: TodaySessionSkipDeps): void {
    const surfaceDate = deps.state.logDate;
    const surfaceTab = deps.state.tab;
    deps.root.querySelectorAll<HTMLElement>(".ex-skip").forEach((button) => {
      if (button.dataset.wired) return;
      button.dataset.wired = "1";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!surfaceStillCurrent(deps, surfaceDate, surfaceTab)) return;
        const card = button.closest<HTMLElement>(".ex");
        if (button.hasAttribute("data-remove-card")) {
          removeOffPlanCard(card, deps);
          return;
        }
        void skipFromCard(card, decodeURIComponent(button.dataset.skip || ""), deps, surfaceDate, surfaceTab);
      });
    });

    const line = deps.root.querySelector<HTMLElement>("#skipLine");
    if (line && !line.dataset.wired) {
      line.dataset.wired = "1";
      line.addEventListener("click", async (event) => {
        if (!surfaceStillCurrent(deps, surfaceDate, surfaceTab)) return;
        const button = (event.target as Element | null)?.closest<HTMLElement>("[data-unskip]");
        if (!button) return;
        const exercise = decodeURIComponent(button.dataset.unskip || "");
        // The name leaves the skip line on the tap; only the card itself has to
        // wait, and it can't be put back by surgery — nothing rendered it while
        // the lift was skipped, so there is no node to re-seat. A SOFT repaint
        // brings it back without the entrance stagger or a scroll jump.
        const putBack = detachSkipNames(exercise, deps);
        deps.toast(`${exercise} is back on`);
        const mutation = await runSkipMutation("restore", "DELETE", { date: surfaceDate, exercise }, surfaceDate, deps);
        const failure = skipFailureMessage(mutation, "restore", surfaceDate);
        if (failure) {
          if (surfaceStillCurrent(deps, surfaceDate, surfaceTab)) {
            putBack();
            deps.toast(failure);
          }
          return;
        }
        if (!surfaceStillCurrent(deps, surfaceDate, surfaceTab)) return;
        if (mutation.status === "queued") {
          deps.toast(`${exercise} restore saved — will sync`);
          return;
        }
        deps.invalidate("today:session:" + surfaceDate);
        void deps.renderToday({ soft: true });
      });
    }
  }

  const CAIRN_TODAY_SESSION_SKIP = {
    wireSkips,
  };

  Object.assign(globalThis, { CairnTodaySessionSkip: CAIRN_TODAY_SESSION_SKIP });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionSkip = CAIRN_TODAY_SESSION_SKIP;
  }
})();
