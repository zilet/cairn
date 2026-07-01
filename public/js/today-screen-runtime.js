(() => {
// @ts-check
// Today screen runtime adapters: typed wrappers around globals and controller
// namespaces so 03-today.js can stay focused on render orchestration.
{
    function todayScreenRuntimeApi(path, opts) {
        return api(path, opts);
    }
    function todayScreenRuntimeCachedApi(path, opts) {
        return cachedApi(path, opts);
    }
    function todayScreenRuntimePeekCached(key, freshFor) {
        return peekCached(key, freshFor);
    }
    function todayScreenRuntimeMicGlyph() {
        const globals = globalThis;
        return String(globals.MIC_GLYPH || globals.CairnCaptureVoice?.micGlyph || "");
    }
    function createTodayScreenRuntime(input) {
        let depsCache = null;
        let compatibilityBridge = null;
        const bridge = () => {
            if (!compatibilityBridge) {
                compatibilityBridge = CairnTodayCompatibilityBridges.create({
                    api: todayScreenRuntimeApi,
                    dependencies: deps,
                });
            }
            return compatibilityBridge;
        };
        function deps() {
            if (!depsCache) {
                depsCache = CairnTodayDependencies.context({
                    root: input.root,
                    state: input.state,
                    api: todayScreenRuntimeApi,
                    cachedApi: todayScreenRuntimeCachedApi,
                    peekCached: todayScreenRuntimePeekCached,
                    invalidate: swrInvalidate,
                    renderToday: input.renderToday,
                    withViewTransition,
                    runOp,
                    runCountUps,
                    reducedMotion,
                    collapseEl,
                    expandEl,
                    activateTab,
                    toast,
                    localISO,
                    escapeHtml: escHtml,
                    escapeAttr: escAttr,
                    stagger,
                    micGlyph: todayScreenRuntimeMicGlyph,
                    cardioLabel,
                    cardioPrescription,
                    isCardioItem,
                    cardioPlanCard: cardioPlanCard,
                    cardioEffortMatches: cardioEffortMatches,
                    exCard: exerciseCard,
                    garminSessionCard: (value) => bridge().garminSessionCard(value),
                    sessionDoneCard: (session, day, options) => bridge().sessionDoneCard(session, day, options),
                    setsTonnage,
                    rxMoveCount,
                    exRxLineHtml,
                    loadTrainingProvenance,
                    revealPlanThen,
                    revealSessionComposer: () => bridge().revealSessionComposer(),
                    askForSession: (opts) => bridge().askForSession(opts),
                    thinkingCaption,
                    appendOffPlanCard: (name, mode) => bridge().appendOffPlanCard(name, mode),
                    gotoChatWith,
                    loadTodayReads,
                    todaySkeleton,
                    setTodayHeaderTitle,
                    nextPollToken: () => ++pollToken,
                    isCurrentPoll: (token) => token === pollToken,
                    suggestedPlanDayNumber,
                    updateHeaderCondense,
                    quickLog,
                    wireCardioSync,
                    applyDayProgression,
                    wireBrief: (read, options) => bridge().wireBrief(read, options),
                    upgradeBriefInPlace,
                    loadTableHint: () => bridge().loadTableHint(),
                    setupWeightChip,
                    setupVoiceCapture,
                    loadFrequentFoods,
                    loadContextBanner: () => bridge().loadContextBanner(),
                    loadHealthFocusBanner: () => bridge().loadHealthFocusBanner(),
                    loadWearable: (isToday) => bridge().loadWearable(isToday),
                    loadCheckin,
                    loadDraftProposals: () => bridge().loadDraftProposals(),
                    setFocus,
                    viewEnter,
                    invalidateTodayProgression: () => bridge().invalidateTodayProgression(),
                    scheduleRxRefresh: () => bridge().scheduleRxRefresh(),
                    startRest,
                    stopRest,
                    parseDur,
                    fmtDur,
                    postExerciseMode,
                    wireGuides,
                    wireLogRow: (row) => bridge().wireLogRow(row),
                    wireSkips: () => bridge().wireSkips(),
                });
            }
            return depsCache;
        }
        function postExerciseMode(name, mode) {
            return bridge().postExerciseMode(name, mode);
        }
        function reconnectSessionSuggest(job) {
            return bridge().reconnectSessionSuggest(job);
        }
        function reconnectDayReadOverride(job) {
            return bridge().reconnectDayReadOverride(job);
        }
        function exRxLineHtml(rx) {
            return CairnTodayTraining.exRxLineHtml(rx);
        }
        function rxMoveCount(rxByEx) {
            return CairnTodayTraining.rxMoveCount(rxByEx);
        }
        async function applyDayProgression(button, day) {
            if (day == null)
                return;
            const restore = btnBusy(button, "Drafting…");
            let response = null;
            try {
                response = await todayScreenRuntimeApi("/program/progression/apply", {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ day }),
                });
            }
            catch {
                restore();
                toast("Couldn't draft that — check your connection.");
                return;
            }
            if (!response || response.ok === false) {
                restore();
                toast("Couldn't draft that just now — try again in a bit.");
                return;
            }
            swrInvalidate("plan:coach");
            swrInvalidate("plan:proposals");
            toast("Drafted — review it in your Plan");
            input.state.planJump = "coach";
            activateTab("plan");
        }
        function exerciseCard(item, logged, prefill, revealIdx, rx) {
            return CairnTodayCards.exerciseCardHtml(item, logged, prefill, revealIdx, rx, {
                day: input.state.day,
                exModes: input.state.exModes,
            });
        }
        function cardioPlanCard(item, revealIdx, done, syncLine) {
            return CairnTodayCards.cardioPlanCardHtml(item, revealIdx, done, syncLine);
        }
        function cardioEffortMatches(item, effort) {
            return CairnTodayCards.cardioEffortMatches(item, effort);
        }
        function suggestedPlanDayNumber(session, isToday) {
            return CairnTodayPlanSelection.suggestedPlanDayNumber(session, isToday, {
                state: input.state,
                api: todayScreenRuntimeApi,
            });
        }
        function loadBrief(date, override, opts = {}) {
            return CairnTodayBriefController.loadBrief(date, override, bridge().briefDeps(), opts);
        }
        async function upgradeBriefInPlace(date, isToday) {
            await CairnTodayBriefController.upgradeBriefInPlace(date, isToday, bridge().briefDeps());
        }
        async function reshapeToday() {
            await CairnTodayBriefController.reshapeToday(bridge().briefDeps());
        }
        function briefHtml(read, options) {
            return CairnTodayBriefController.briefHtml(read, options, bridge().briefDeps());
        }
        function focusEngaged(date, options) {
            return CairnTodayBriefController.focusEngaged(date, options, bridge().briefDeps());
        }
        function setFocus(date, on) {
            CairnTodayBriefController.setFocus(date, on, bridge().briefDeps());
        }
        function focusBarHtml(read, day, options) {
            return CairnTodayBriefController.focusBarHtml(read, day, options);
        }
        function briefSignalsText(read) {
            return CairnTodayBriefController.briefSignalsText(read);
        }
        function revealPlanThen(after, opts = {}) {
            if (input.root.querySelector(".addex")) {
                after && after();
                return;
            }
            input.state.planReveal = { date: input.state.logDate, on: true, blank: !!opts.blank };
            Promise.resolve(input.renderToday()).then(() => { after && after(); });
        }
        return {
            api: todayScreenRuntimeApi,
            cachedApi: todayScreenRuntimeCachedApi,
            peekCached: todayScreenRuntimePeekCached,
            deps,
            planSurfaceRendererDeps: () => deps().planSurfaceRenderer(),
            mainShellDeps: () => deps().mainShell(),
            briefDeps: () => bridge().briefDeps(),
            sessionDeps: () => bridge().sessionDeps(),
            postExerciseMode,
            reconnectSessionSuggest,
            revealSessionComposer: () => bridge().revealSessionComposer(),
            askForSession: (opts) => bridge().askForSession(opts),
            sessionDoneCard: (session, day, options) => bridge().sessionDoneCard(session, day, options),
            wireLogRow: (row) => bridge().wireLogRow(row),
            wireSkips: () => bridge().wireSkips(),
            wireBrief: (read, options) => bridge().wireBrief(read, options),
            reconnectDayReadOverride,
            scheduleRxRefresh: () => bridge().scheduleRxRefresh(),
            invalidateTodayProgression: () => bridge().invalidateTodayProgression(),
            refreshAdaptedRx: () => bridge().refreshAdaptedRx(),
            setupAddExercise: () => bridge().setupAddExercise(),
            appendOffPlanCard: (name, mode) => bridge().appendOffPlanCard(name, mode),
            garminSessionCard: (value) => bridge().garminSessionCard(value),
            loadWearable: (isToday) => bridge().loadWearable(isToday),
            loadTableHint: () => bridge().loadTableHint(),
            loadContextBanner: () => bridge().loadContextBanner(),
            loadDraftProposals: () => bridge().loadDraftProposals(),
            loadHealthFocusBanner: () => bridge().loadHealthFocusBanner(),
            exRxLineHtml,
            rxMoveCount,
            applyDayProgression,
            exerciseCard,
            cardioPlanCard,
            cardioEffortMatches,
            suggestedPlanDayNumber,
            loadBrief,
            upgradeBriefInPlace,
            reshapeToday,
            briefHtml,
            focusEngaged,
            setFocus,
            focusBarHtml,
            briefSignalsText,
            revealPlanThen,
        };
    }
    const CAIRN_TODAY_SCREEN_RUNTIME = {
        micGlyph: todayScreenRuntimeMicGlyph,
        create: createTodayScreenRuntime,
    };
    Object.assign(globalThis, { CairnTodayScreenRuntime: CAIRN_TODAY_SCREEN_RUNTIME });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayScreenRuntime: CAIRN_TODAY_SCREEN_RUNTIME });
    }
}
})();
