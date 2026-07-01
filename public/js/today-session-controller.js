(() => {
// @ts-check
// Today session controller: finish/reopen and the public compatibility facade.
(() => {
    function wireFinishControls(session, deps) {
        const finishBtn = deps.root.querySelector("#finishBtn");
        if (finishBtn && !finishBtn.dataset.wired) {
            finishBtn.dataset.wired = "1";
            finishBtn.addEventListener("click", async () => {
                finishBtn.disabled = true;
                const notes = deps.root.querySelector("#sessNotes")?.value.trim() || "";
                let result;
                try {
                    result = CairnTodaySessionSetModel.responseRecord(await deps.api(`/sessions/${CairnTodaySessionSetModel.sessionPathId(session)}/finish`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ notes }),
                    }));
                }
                catch {
                    finishBtn.disabled = false;
                    deps.toast("Couldn't finish — check your connection");
                    return;
                }
                const summary = CairnTodaySessionSetModel.responseRecord(result.summary);
                deps.state.brief = null;
                CairnTodaySessionSetModel.invalidateSessionTruth(deps);
                deps.invalidate("stats");
                deps.stopRest();
                const settle = () => {
                    if (deps.state.tab !== "today")
                        return;
                    deps.toast(`Done · ${Number(summary.sets || 0)} sets · ${Number(summary.tonnage || 0).toLocaleString()} lb`);
                    deps.renderToday();
                };
                const surface = deps.root.querySelector(".plansurface");
                if (surface && !deps.reducedMotion()) {
                    surface.classList.add("slide-out");
                    setTimeout(settle, 300);
                }
                else {
                    settle();
                }
            });
        }
        const reopenBtn = deps.root.querySelector("#reopenBtn");
        if (reopenBtn && !reopenBtn.dataset.wired) {
            reopenBtn.dataset.wired = "1";
            reopenBtn.addEventListener("click", async () => {
                reopenBtn.disabled = true;
                try {
                    await deps.api(`/sessions/${CairnTodaySessionSetModel.sessionPathId(session)}/reopen`, { method: "POST" });
                }
                catch { }
                deps.state.brief = null;
                CairnTodaySessionSetModel.invalidateSessionTruth(deps);
                deps.state.planReveal = { date: deps.state.logDate, on: true };
                deps.withViewTransition(() => Promise.resolve(deps.renderToday()).then(() => deps.viewEnter()));
            });
        }
        deps.root.querySelector("#toHistoryBtn")?.addEventListener("click", () => deps.activateTab("progress"));
    }
    function wireSessionSurface(options, deps) {
        const session = CairnTodaySessionSetModel.responseRecord(options.session);
        CairnTodaySessionSetActions.wireDeletes(deps);
        CairnTodaySessionSkip.wireSkips(deps);
        wireFinishControls(session, deps);
        deps.root.querySelectorAll(".ex .logrow").forEach((row) => CairnTodaySessionSetActions.wireLogRow(row, deps));
        if (options.hasLoggedSets)
            CairnTodaySessionFeedback.renderFeedback(deps.root.querySelector("#feedbackSlot"), session, deps);
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
})();
