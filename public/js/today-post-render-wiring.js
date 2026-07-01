(() => {
// @ts-check
// Today post-render DOM wiring: quick capture, cardio/apply/focus/date controls,
// and non-focus side loader dispatch after the Today HTML swap.
(() => {
    function wirePostRender(deps) {
        deps.updateHeaderCondense();
        deps.runCountUps(deps.root, { snap: deps.soft });
        const quickLogButton = deps.root.querySelector("#qlBtn");
        const quickLogInput = deps.root.querySelector("#qlInput");
        quickLogButton?.addEventListener("click", () => deps.quickLog());
        quickLogInput?.addEventListener("keydown", (event) => {
            if (event.key === "Enter")
                deps.quickLog();
        });
        deps.root.querySelectorAll("[data-cardio-log]").forEach((button) => button.addEventListener("click", () => {
            const input = deps.root.querySelector("#qlInput");
            if (!input)
                return;
            input.value = button.dataset.cardioLog || "";
            input.focus();
            try {
                input.setSelectionRange(input.value.length, input.value.length);
            }
            catch { }
            input.scrollIntoView({ behavior: deps.reducedMotion() ? "auto" : "smooth", block: "center" });
        }));
        deps.wireCardioSync(deps.root, () => deps.renderToday({ soft: true }));
        const applyButton = deps.root.querySelector("#rxApplyBtn");
        applyButton?.addEventListener("click", () => {
            const day = Number(applyButton.dataset.rxDay);
            deps.applyDayProgression(applyButton, Number.isFinite(day) ? day : deps.state.day);
        });
        deps.wireBrief(deps.read, { isToday: deps.isToday });
        if (deps.read?._provisional)
            deps.upgradeBriefInPlace(deps.state.logDate, deps.isToday);
        if (!deps.focus && deps.showPlan)
            deps.loadTrainingProvenance(deps.isToday);
        deps.loadTableHint();
        if (!deps.focus) {
            deps.setupWeightChip();
            deps.setupVoiceCapture();
            deps.loadFrequentFoods();
            deps.loadContextBanner();
            if (!deps.conductorLeads)
                deps.loadHealthFocusBanner();
            deps.loadWearable(deps.isToday);
            if (deps.isToday) {
                deps.loadCheckin();
                deps.loadDraftProposals();
            }
            if (deps.agenda) {
                deps.runAgendaRail(deps.agenda, deps.agendaGeneric, deps.todayRailDeps());
            }
            else {
                deps.runFallbackRail(deps.isToday, deps.todayRailDeps());
            }
            deps.root.querySelector("#goalLine")?.addEventListener("click", () => deps.activateTab("progress"));
        }
        const focusEnterButton = deps.root.querySelector("#focusEnter");
        focusEnterButton?.addEventListener("click", () => {
            deps.setFocus(deps.state.logDate, true);
            deps.withViewTransition(() => Promise.resolve(deps.renderToday()).then(deps.viewEnter));
        });
        const focusExitButton = deps.root.querySelector("#focusExit");
        focusExitButton?.addEventListener("click", () => {
            deps.setFocus(deps.state.logDate, false);
            deps.withViewTransition(() => Promise.resolve(deps.renderToday()).then(deps.viewEnter));
        });
        deps.root.querySelector("#paceOffer")?.addEventListener("click", () => {
            deps.state.chatPrefill = deps.todayCompass.paceOffer?.ask || "";
            deps.activateTab("chat");
        });
        deps.root.querySelector("#backToday")?.addEventListener("click", () => {
            deps.state.logDate = deps.localISO();
            deps.state.day = null;
            deps.state.dayPicked = false;
            deps.renderToday();
        });
        deps.root.querySelectorAll(".daybtn").forEach((button) => button.addEventListener("click", () => {
            deps.state.day = Number(button.dataset.day);
            deps.state.dayPicked = true;
            deps.renderToday();
        }));
    }
    const CAIRN_TODAY_POST_RENDER_WIRING = {
        wirePostRender,
    };
    Object.assign(globalThis, { CairnTodayPostRenderWiring: CAIRN_TODAY_POST_RENDER_WIRING });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayPostRenderWiring: CAIRN_TODAY_POST_RENDER_WIRING });
    }
})();
})();
