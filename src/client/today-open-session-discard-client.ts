// @ts-check
// Today's open session, part 2: the quiet "Discard this session" door, and the past-day session
// that looking at a day must never leave behind. Extends CairnTodayOpenSession
// (today-open-session-client.ts, loaded first) so every caller keeps the one global.

(() => {
  const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

  const globalApi = (path: string, init: Record<string, unknown>): Promise<unknown> =>
    (globalThis as unknown as { api(p: string, i: unknown): Promise<unknown> }).api(path, init);

  const forget = (date: string): void => CairnTodayOpenSession.forget(date);

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

  // Back on Today after a discard the button that held focus is gone: focus lands on Today itself,
  // so a keyboard or screen-reader user starts at the top of the screen, not at the document's end.
  function focusToday(): void {
    setTimeout(() => {
      const top = document.querySelector<HTMLElement>(".today-wrap");
      if (!top) return;
      if (!top.hasAttribute("tabindex")) top.setAttribute("tabindex", "-1");
      top.focus({ preventScroll: true });
    }, 350);
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
        else focusToday();
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

  // Marked only when THIS tap minted the session (`minted`): one that already existed — the day's
  // own record, an authored session — is never the door's to drop.
  const markPastDay = (date: string, minted = false): void => {
    pastDay = minted ? date : "";
  };

  /** A write still queued for the date (a set logged offline) must reach the server before a discard could. */
  function outboxHolds(date: string): boolean {
    const rows = (globalThis as { CairnOutbox?: { list?(): Array<Record<string, unknown>> } }).CairnOutbox?.list?.() || [];
    return rows.some((item) => item.session_date === date || record(item.body)?.date === date);
  }

  async function leavePastDay(): Promise<void> {
    const date = pastDay;
    pastDay = "";
    if (!date || typeof peekCached !== "function" || outboxHolds(date)) return;
    const daily = record(peekCached<unknown>(`today:daily-session:${date}`)?.data);
    const session = record(peekCached<unknown>(`today:session:${date}`)?.data);
    const id = Number((daily || record(session?.daily_session))?.id);
    if (id > 0) await discard(date, id, { say: () => {}, done: () => {} });
  }

  Object.assign(CairnTodayOpenSession, { canDiscard, discard, wireDiscard, discardHtml, markPastDay, leavePastDay });
})();
