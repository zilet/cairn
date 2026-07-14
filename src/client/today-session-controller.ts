// @ts-check
// Today session controller: finish/reopen and the public compatibility facade.

type TodaySessionDeps = ClientTodaySessionControllerDeps;
type TodaySessionSurfaceOptions = ClientTodaySessionSurfaceOptions;

(() => {
  // Bound the finish POST. api() only arms its safety timeout for GETs, so on a
  // flaky radio a hung finish would otherwise leave the button disabled forever.
  const FINISH_TIMEOUT_MS = 15000;

  // A session note is drafted locally (keyed by log date — one session per date)
  // so it survives a reload before the workout is finished. Mirrors the chat-draft
  // pattern; every access is wrapped so a missing/disabled localStorage is a no-op.
  const SESSION_NOTES_DRAFT_PREFIX = "cairn.sessnotes.";
  function sessionNotesDraftKey(date: string): string {
    return SESSION_NOTES_DRAFT_PREFIX + date;
  }
  function saveSessionNotesDraft(date: string, value: string): void {
    try {
      const key = sessionNotesDraftKey(date);
      if (value && value.trim()) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {}
  }
  function loadSessionNotesDraft(date: string): string {
    try {
      return localStorage.getItem(sessionNotesDraftKey(date)) || "";
    } catch {
      return "";
    }
  }
  function clearSessionNotesDraft(date: string): void {
    try {
      localStorage.removeItem(sessionNotesDraftKey(date));
    } catch {}
  }

  function surfaceStillCurrent(deps: TodaySessionDeps, date: string, tab: string | undefined): boolean {
    return deps.state.logDate === date && deps.state.tab === tab;
  }

  // Restore a locally-drafted note into an EMPTY session-notes input (a
  // server-provided note, rendered into value=, wins — the draft only fills a
  // blank) and persist edits as the athlete types, so a reload never loses the note.
  function wireSessionNotesDraft(deps: TodaySessionDeps, date: string): void {
    const notesEl = deps.root.querySelector<HTMLInputElement | HTMLTextAreaElement>("#sessNotes");
    if (!notesEl || notesEl.dataset.wired) return;
    notesEl.dataset.wired = "1";
    if (!notesEl.value.trim()) {
      const draft = loadSessionNotesDraft(date);
      if (draft) notesEl.value = draft;
    }
    notesEl.addEventListener("input", () => saveSessionNotesDraft(date, notesEl.value));
  }

  function finishedBrief(date: string, summary: Record<string, unknown>): Record<string, unknown> {
    const setCount = Number(summary.sets || 0);
    return {
      date,
      override: "",
      read: {
        kind: "done",
        headline: "You're done for today.",
        why: setCount > 0
          ? `${setCount} set${setCount === 1 ? "" : "s"} logged. Your workout analysis is ready below.`
          : "Your workout is complete. The analysis is ready below.",
        focus: null,
        est_minutes: null,
        signals: { logged_today: { sets: setCount } },
        source: "local-finish",
      },
    };
  }

  // Resolve only a validated, real DB session ID. The normal focused-screen path
  // gets it from the first set/skip response via rememberMutationSessionId(). The read is
  // a recovery path for a set that was replayed from the offline outbox, another
  // surface creating the session, or an older server response without session_id.
  async function recoverSessionPathId(
    deps: TodaySessionDeps,
    date: string,
    tab: string | undefined,
  ): Promise<string | null> {
    let fresh: Record<string, unknown>;
    try {
      fresh = CairnTodaySessionSetModel.responseRecord(
        await deps.api("/sessions?date=" + encodeURIComponent(date)),
      );
    } catch {
      return null;
    }
    const id = CairnTodaySessionSetModel.rememberFullSessionId(deps, date, fresh);
    if (!id) return null;
    if (!surfaceStillCurrent(deps, date, tab)) return null;
    if (!CairnTodaySessionSetModel.cacheSessionTruth(deps, date, fresh)) return null;
    return encodeURIComponent(id);
  }

  function wireFinishControls(
    session: Record<string, unknown>,
    deps: TodaySessionDeps,
    surfaceDate: string,
    surfaceTab: string | undefined,
  ): void {
    const finishBtn = deps.root.querySelector<HTMLButtonElement>("#finishBtn");
    if (finishBtn && !finishBtn.dataset.wired) {
      finishBtn.dataset.wired = "1";
      finishBtn.addEventListener("click", async () => {
        if (!surfaceStillCurrent(deps, surfaceDate, surfaceTab)) return;
        const actionDate = surfaceDate;
        const actionTab = surfaceTab;
        finishBtn.disabled = true;
        const notes = deps.root.querySelector<HTMLInputElement | HTMLTextAreaElement>("#sessNotes")?.value.trim() || "";
        // The action may need an async ID recovery; persist the note under the
        // action's date before yielding so a navigation can never strand it.
        saveSessionNotesDraft(actionDate, notes);
        const sessionId = CairnTodaySessionSetModel.sessionPathId(session, deps, actionDate)
          || await recoverSessionPathId(deps, actionDate, actionTab);
        if (!sessionId) {
          if (surfaceStillCurrent(deps, actionDate, actionTab)) {
            finishBtn.disabled = false;
            deps.toast("Session isn't ready yet — your note is saved");
          }
          return;
        }
        if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
        const finishPath = `/sessions/${sessionId}/finish`;
        // Scope a ~15s AbortController to THIS call (guarded for environments
        // without AbortController, mirroring api-client's own guard) so a hang
        // takes the same offline path a thrown fetch already does. Finish replay
        // is safe: finishSession is an idempotent UPDATE — unlike a set-log, which
        // we never auto-time-out, since a timed-out-but-landed set could duplicate.
        const finishOpts: RequestInit & { headers?: Record<string, string> } = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes }),
        };
        let finishTimer: ReturnType<typeof setTimeout> | null = null;
        if (typeof AbortController === "function") {
          const controller = new AbortController();
          finishOpts.signal = controller.signal;
          if (typeof setTimeout === "function") finishTimer = setTimeout(() => controller.abort(), FINISH_TIMEOUT_MS);
        }
        let result: Record<string, unknown>;
        try {
          result = CairnTodaySessionSetModel.responseRecord(await deps.api(finishPath, finishOpts));
        } catch (error) {
          const classify = (globalThis as {
            CairnApiCache?: { isTransientApiFailure?: (value: unknown) => boolean };
          }).CairnApiCache?.isTransientApiFailure;
          if (typeof classify === "function" && !classify(error)) {
            if (surfaceStillCurrent(deps, actionDate, actionTab)) {
              finishBtn.disabled = false;
              deps.toast("Couldn't finish that session");
            }
            return;
          }
          (globalThis as { outboxEnqueue?: (kind: string, path: string, body: unknown) => unknown }).outboxEnqueue?.(
            "finish",
            finishPath,
            { notes },
          );
          clearSessionNotesDraft(actionDate); // the note is safe in the outbox now
          if (surfaceStillCurrent(deps, actionDate, actionTab)) {
            finishBtn.disabled = false;
            deps.toast("Finish saved — will sync when you're back online");
          }
          return;
        } finally {
          if (finishTimer != null && typeof clearTimeout === "function") clearTimeout(finishTimer);
        }
        const responseDateMatches = result.date == null || String(result.date) === actionDate;
        const responseIdMatches = String(result.id ?? "") === decodeURIComponent(sessionId);
        if (!result || result.error || result.ok === false || !responseDateMatches || !responseIdMatches) {
          if (surfaceStillCurrent(deps, actionDate, actionTab)) {
            finishBtn.disabled = false;
            deps.toast(result && result.error ? String(result.error) : "Couldn't finish that session");
          }
          return;
        }
        clearSessionNotesDraft(actionDate); // finished cleanly — the draft has done its job
        if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;

        const summary = CairnTodaySessionSetModel.responseRecord(result.summary);
        if (!CairnTodaySessionSetModel.cacheSessionTruth(deps, actionDate, result)) return;
        deps.state.planReveal = null;
        deps.state.brief = finishedBrief(actionDate, summary);
        deps.invalidate("stats");
        deps.invalidate("history:sessions");
        deps.stopRest();

        const settle = () => {
          if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
          deps.toast(`Done · ${Number(summary.sets || 0)} sets · ${Number(summary.tonnage || 0).toLocaleString()} lb`);
          deps.renderToday();
        };
        const surface = deps.root.querySelector<HTMLElement>(".plansurface");
        if (surface && !deps.reducedMotion()) {
          surface.classList.add("slide-out");
          setTimeout(settle, 300);
        } else {
          settle();
        }
      });
    }

    const reopenBtn = deps.root.querySelector<HTMLButtonElement>("#reopenBtn");
    if (reopenBtn && !reopenBtn.dataset.wired) {
      reopenBtn.dataset.wired = "1";
      reopenBtn.addEventListener("click", async () => {
        if (!surfaceStillCurrent(deps, surfaceDate, surfaceTab)) return;
        const actionDate = surfaceDate;
        const actionTab = surfaceTab;
        reopenBtn.disabled = true;
        const sessionId = CairnTodaySessionSetModel.sessionPathId(session, deps, actionDate)
          || await recoverSessionPathId(deps, actionDate, actionTab);
        if (!sessionId) {
          if (surfaceStillCurrent(deps, actionDate, actionTab)) {
            reopenBtn.disabled = false;
            deps.toast("Couldn't reopen that session");
          }
          return;
        }
        if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
        let result: Record<string, unknown> | null = null;
        try {
          result = CairnTodaySessionSetModel.responseRecord(
            await deps.api(`/sessions/${sessionId}/reopen`, { method: "POST" }),
          );
        } catch {
          if (surfaceStillCurrent(deps, actionDate, actionTab)) {
            reopenBtn.disabled = false;
            deps.toast("Couldn't reopen that session");
          }
          return;
        }
        const responseDateMatches = result?.date == null || String(result.date) === actionDate;
        const responseIdMatches = String(result?.id ?? "") === decodeURIComponent(sessionId);
        if (!result || result.error || result.ok === false || !responseDateMatches || !responseIdMatches) {
          if (surfaceStillCurrent(deps, actionDate, actionTab)) {
            reopenBtn.disabled = false;
            deps.toast(result && result.error ? String(result.error) : "Couldn't reopen that session");
          }
          return;
        }
        if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
        deps.state.brief = null;
        if (!CairnTodaySessionSetModel.cacheSessionTruth(deps, actionDate, result)) return;
        deps.invalidate("history:sessions");
        deps.state.planReveal = { date: actionDate, on: true };
        deps.withViewTransition(() => Promise.resolve(deps.renderToday()).then(() => deps.viewEnter()));
      });
    }

    deps.root.querySelector("#toHistoryBtn")?.addEventListener("click", () => deps.activateTab("progress"));
  }

  function wireSessionSurface(options: TodaySessionSurfaceOptions, deps: TodaySessionDeps): void {
    const session = CairnTodaySessionSetModel.responseRecord(options.session);
    const surfaceDate = deps.state.logDate;
    const surfaceTab = deps.state.tab;
    CairnTodaySessionSetModel.rememberFullSessionId(deps, surfaceDate, session);
    CairnTodaySessionSetActions.wireDeletes(deps);
    CairnTodaySessionSkip.wireSkips(deps);
    wireFinishControls(session, deps, surfaceDate, surfaceTab);
    wireSessionNotesDraft(deps, surfaceDate);
    const lastSets = options.lastSets || {};
    deps.root.querySelectorAll<HTMLElement>(".ex .logrow").forEach((row) => {
      CairnTodaySessionSetActions.wireLogRow(row, deps);
      const exercise = decodeURIComponent(row.dataset.ex || "");
      CairnTodaySessionSetModel.wireLastSetLine(row, lastSets[exercise] ?? null, deps);
    });
    if (options.hasLoggedSets) CairnTodaySessionFeedback.renderFeedback(deps.root.querySelector("#feedbackSlot"), session, deps);
  }

  const CAIRN_TODAY_SESSION_CONTROLLER = {
    renderFeedback: CairnTodaySessionFeedback.renderFeedback,
    wireDeletes: CairnTodaySessionSetActions.wireDeletes,
    wireLogRow: CairnTodaySessionSetActions.wireLogRow,
    wireSessionSurface,
    wireSkips: CairnTodaySessionSkip.wireSkips,
  };

  Object.assign(globalThis, { CairnTodaySessionController: CAIRN_TODAY_SESSION_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionController = CAIRN_TODAY_SESSION_CONTROLLER;
  }
})();
