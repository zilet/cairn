(() => {
// @ts-check
// Today runtime dependency assembly. The screen runtime owns the public facade;
// this module owns the large global-adapter map required by Today controllers.
{
    function createTodayScreenRuntimeDependencies(input) {
        const bridge = input.bridge;
        return CairnTodayDependencies.context({
            root: input.root,
            state: input.state,
            api: input.api,
            cachedApi: input.cachedApi,
            peekCached: input.peekCached,
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
            micGlyph: input.micGlyph,
            cardioLabel,
            cardioPrescription,
            isCardioItem,
            cardioPlanCard: input.cardioPlanCard,
            cardioEffortMatches: input.cardioEffortMatches,
            exCard: input.exerciseCard,
            garminSessionCard: (value) => bridge().garminSessionCard(value),
            sessionDoneCard: (session, day, options) => bridge().sessionDoneCard(session, day, options),
            setsTonnage,
            rxMoveCount: input.rxMoveCount,
            exRxLineHtml: input.exRxLineHtml,
            loadTrainingProvenance,
            revealPlanThen: input.revealPlanThen,
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
            suggestedPlanDayNumber: input.suggestedPlanDayNumber,
            updateHeaderCondense,
            quickLog,
            wireCardioSync,
            applyDayProgression: input.applyDayProgression,
            wireBrief: (read, options) => bridge().wireBrief(read, options),
            upgradeBriefInPlace: input.upgradeBriefInPlace,
            loadTableHint: () => bridge().loadTableHint(),
            setupWeightChip,
            setupVoiceCapture,
            loadFrequentFoods,
            loadContextBanner: () => bridge().loadContextBanner(),
            loadHealthFocusBanner: () => bridge().loadHealthFocusBanner(),
            loadWearable: (isToday) => bridge().loadWearable(isToday),
            loadCheckin,
            loadDraftProposals: () => bridge().loadDraftProposals(),
            viewEnter,
            invalidateTodayProgression: () => bridge().invalidateTodayProgression(),
            scheduleRxRefresh: () => bridge().scheduleRxRefresh(),
            startRest,
            stopRest,
            parseDur,
            fmtDur,
            postExerciseMode: input.postExerciseMode,
            wireGuides,
            wireLogRow: (row) => bridge().wireLogRow(row),
            wireSkips: () => bridge().wireSkips(),
        });
    }
    const CAIRN_TODAY_SCREEN_RUNTIME_DEPS = {
        create: createTodayScreenRuntimeDependencies,
    };
    Object.assign(globalThis, { CairnTodayScreenRuntimeDeps: CAIRN_TODAY_SCREEN_RUNTIME_DEPS });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayScreenRuntimeDeps: CAIRN_TODAY_SCREEN_RUNTIME_DEPS });
    }
}
})();
