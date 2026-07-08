// @ts-check
// Today session controller: finish/reopen and the public compatibility facade.

type TodaySessionDeps = ClientTodaySessionControllerDeps;
type TodaySessionSurfaceOptions = ClientTodaySessionSurfaceOptions;

(() => {
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

  function wireFinishControls(session: Record<string, unknown>, deps: TodaySessionDeps): void {
    const finishBtn = deps.root.querySelector<HTMLButtonElement>("#finishBtn");
    if (finishBtn && !finishBtn.dataset.wired) {
      finishBtn.dataset.wired = "1";
      finishBtn.addEventListener("click", async () => {
        finishBtn.disabled = true;
        const notes = deps.root.querySelector<HTMLInputElement | HTMLTextAreaElement>("#sessNotes")?.value.trim() || "";
        let result: Record<string, unknown>;
        try {
          result = CairnTodaySessionSetModel.responseRecord(await deps.api(`/sessions/${CairnTodaySessionSetModel.sessionPathId(session)}/finish`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notes }),
          }));
        } catch {
          finishBtn.disabled = false;
          (globalThis as { outboxEnqueue?: (kind: string, path: string, body: unknown) => unknown }).outboxEnqueue?.(
            "finish",
            `/sessions/${CairnTodaySessionSetModel.sessionPathId(session)}/finish`,
            { notes },
          );
          deps.toast("Finish saved — will sync when you're back online");
          return;
        }
        if (!result || result.error || result.ok === false || result.id == null) {
          finishBtn.disabled = false;
          deps.toast(result && result.error ? String(result.error) : "Couldn't finish that session");
          return;
        }

        const summary = CairnTodaySessionSetModel.responseRecord(result.summary);
        CairnTodaySessionSetModel.cacheSessionTruth(deps, result);
        deps.state.planReveal = null;
        deps.state.brief = finishedBrief(deps.state.logDate, summary);
        deps.invalidate("stats");
        deps.invalidate("history:sessions");
        deps.stopRest();

        const settle = () => {
          if (deps.state.tab !== "today" && deps.state.tab !== "session") return;
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
        reopenBtn.disabled = true;
        let result: Record<string, unknown> | null = null;
        try {
          result = CairnTodaySessionSetModel.responseRecord(
            await deps.api(`/sessions/${CairnTodaySessionSetModel.sessionPathId(session)}/reopen`, { method: "POST" }),
          );
        } catch {}
        deps.state.brief = null;
        if (result && result.id != null) CairnTodaySessionSetModel.cacheSessionTruth(deps, result);
        else deps.invalidate("today:session:" + deps.state.logDate);
        deps.invalidate("history:sessions");
        deps.state.planReveal = { date: deps.state.logDate, on: true };
        deps.withViewTransition(() => Promise.resolve(deps.renderToday()).then(() => deps.viewEnter()));
      });
    }

    deps.root.querySelector("#toHistoryBtn")?.addEventListener("click", () => deps.activateTab("progress"));
  }

  function wireSessionSurface(options: TodaySessionSurfaceOptions, deps: TodaySessionDeps): void {
    const session = CairnTodaySessionSetModel.responseRecord(options.session);
    CairnTodaySessionSetActions.wireDeletes(deps);
    CairnTodaySessionSkip.wireSkips(deps);
    wireFinishControls(session, deps);
    deps.root.querySelectorAll(".ex .logrow").forEach((row) => CairnTodaySessionSetActions.wireLogRow(row, deps));
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
