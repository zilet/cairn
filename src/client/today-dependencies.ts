// @ts-check
// Today screen dependency factories: keep the screen focused on orchestration
// while this module assembles controller adapters for the classic-script modules.

function makeTodayDependencies(input: ClientTodayDependenciesContextInput): ClientTodayDependenciesContext {
  const deps: ClientTodayDependenciesContext = {
    sideLoaders() {
      return {
        root: input.root,
        state: input.state,
        api: input.api,
        activateTab: input.activateTab,
        runCountUps: input.runCountUps,
        escapeHtml: input.escapeHtml,
        localISO: input.localISO,
        stagger: input.stagger,
      };
    },

    planSurface() {
      return {
        escapeHtml: input.escapeHtml,
        escapeAttr: input.escapeAttr,
        stagger: input.stagger,
        cardioLabel: input.cardioLabel,
        cardioPrescription: input.cardioPrescription,
        rxMoveCount: input.rxMoveCount,
        setsTonnage: input.setsTonnage,
        lastSetLineText: (lastSet: unknown) => CairnTodaySessionSetModel.lastSetLineText(lastSet, { fmtDur: input.fmtDur }),
      };
    },

    planSurfaceRenderer() {
      return {
        planSurface: CairnTodayPlanSurface,
        planSurfaceDeps: deps.planSurface,
        isCardioItem: input.isCardioItem,
        cardioLabel: input.cardioLabel,
        cardioPlanCard: input.cardioPlanCard,
        exCard: input.exCard,
        garminSessionCard: input.garminSessionCard,
        sessionDoneCard: input.sessionDoneCard,
        skipLineHtml: (labels: string[]) => CairnTodaySessionStatus.skipLineHtml(labels),
      };
    },

    mainShell() {
      return {
        escapeHtml: input.escapeHtml,
      };
    },

    brief() {
      return {
        root: input.root,
        state: input.state,
        api: input.api,
        storeCached: input.storeCached,
        invalidate: input.invalidate,
        renderToday: input.renderToday,
        withViewTransition: input.withViewTransition,
        runOp: input.runOp,
        runCountUps: input.runCountUps,
        reducedMotion: input.reducedMotion,
        collapseEl: input.collapseEl,
        activateTab: input.activateTab,
        toast: input.toast,
        localISO: input.localISO,
        escapeHtml: input.escapeHtml,
        loadTrainingProvenance: input.loadTrainingProvenance,
        revealPlanThen: input.revealPlanThen,
        revealSessionComposer: input.revealSessionComposer,
        askForSession: input.askForSession,
      };
    },

    sessionSuggest() {
      return {
        root: input.root,
        state: input.state,
        api: input.api,
        storeCached: input.storeCached,
        invalidate: input.invalidate,
        openSession: (date?: string | null, options?: Record<string, unknown>) => openSession(date, options),
        runOp: input.runOp,
        thinkingCaption: input.thinkingCaption,
        runCountUps: input.runCountUps,
        collapseEl: input.collapseEl,
        reducedMotion: input.reducedMotion,
        toast: input.toast,
      };
    },

    rail() {
      return {
        root: input.root,
        state: input.state,
        api: input.api,
        activateTab: input.activateTab,
        gotoChatWith: input.gotoChatWith,
        collapseEl: input.collapseEl,
        loadTodayReads: input.loadTodayReads,
        runCountUps: input.runCountUps,
        escapeHtml: input.escapeHtml,
        toast: input.toast,
        invalidate: input.invalidate,
        refreshToday: input.renderToday,
      };
    },

    dataLoad() {
      return {
        root: input.root,
        state: input.state,
        api: input.api,
        cachedApi: input.cachedApi,
        peekCached: input.peekCached,
        storeCached: input.storeCached,
        localISO: input.localISO,
        todaySkeleton: input.todaySkeleton,
        setTodayHeaderTitle: input.setTodayHeaderTitle,
        nextPollToken: input.nextPollToken,
      };
    },

    dataRefresh() {
      return {
        root: input.root,
        state: input.state,
        isCurrentPoll: input.isCurrentPoll,
        renderToday: input.renderToday,
      };
    },

    planSession(session: unknown, isToday: boolean) {
      return {
        state: input.state,
        session,
        isToday,
        api: input.api,
        cachedApi: input.cachedApi,
        peekCached: input.peekCached,
        suggestedPlanDayNumber: input.suggestedPlanDayNumber,
        isCardioItem: input.isCardioItem,
        cardioLabel: input.cardioLabel,
        cardioEffortMatches: input.cardioEffortMatches,
      };
    },

    postRender(renderInput: ClientTodayDependenciesPostRenderInput) {
      return {
        root: input.root,
        state: input.state,
        read: renderInput.read,
        isToday: renderInput.isToday,
        showPlan: renderInput.showPlan,
        soft: renderInput.soft,
        conductorLeads: renderInput.conductorLeads,
        deferRail: renderInput.deferRail,
        agenda: renderInput.agenda,
        agendaGeneric: renderInput.agendaGeneric,
        updateHeaderCondense: input.updateHeaderCondense,
        runCountUps: input.runCountUps,
        reducedMotion: input.reducedMotion,
        wireCardioSync: input.wireCardioSync,
        renderToday: input.renderToday,
        applyDayProgression: input.applyDayProgression,
        wireBrief: input.wireBrief,
        upgradeBriefInPlace: input.upgradeBriefInPlace,
        loadTrainingProvenance: input.loadTrainingProvenance,
        loadTableHint: input.loadTableHint,
        setupWeightChip: input.setupWeightChip,
        loadFrequentFoods: input.loadFrequentFoods,
        loadContextBanner: input.loadContextBanner,
        loadHealthFocusBanner: input.loadHealthFocusBanner,
        loadWearable: input.loadWearable,
        loadCheckin: input.loadCheckin,
        loadTagChips: input.loadTagChips,
        runAgendaRail: CairnTodayRailController.runAgendaRail,
        runFallbackRail: CairnTodayRailController.runFallbackRail,
        todayRailDeps: deps.rail,
        activateTab: input.activateTab,
        withViewTransition: input.withViewTransition,
        viewEnter: input.viewEnter,
        localISO: input.localISO,
        toast: input.toast,
      };
    },

    session() {
      return {
        root: input.root,
        state: input.state,
        api: input.api,
        storeCached: input.storeCached,
        invalidate: input.invalidate,
        invalidateTodayProgression: input.invalidateTodayProgression,
        scheduleRxRefresh: input.scheduleRxRefresh,
        renderToday: input.renderToday,
        activateTab: input.activateTab,
        withViewTransition: input.withViewTransition,
        viewEnter: input.viewEnter,
        reducedMotion: input.reducedMotion,
        startRest: input.startRest,
        stopRest: input.stopRest,
        toast: input.toast,
        parseDur: input.parseDur,
        fmtDur: input.fmtDur,
        collapseEl: input.collapseEl,
        expandEl: input.expandEl,
        localISO: input.localISO,
        sessionStatus: CairnTodaySessionStatus,
      };
    },

    progression() {
      return {
        state: input.state,
        root: input.root,
        cachedApi: input.cachedApi,
        invalidate: input.invalidate,
        exRxLineHtml: input.exRxLineHtml,
        moveCount: input.rxMoveCount,
        loadProgramAdjustmentsBanner: () => CairnTodayRailController.loadProgramAdjustmentsBanner(deps.rail()),
      };
    },

    addExercise() {
      return {
        root: input.root,
        state: input.state,
        api: input.api,
        postExerciseMode: input.postExerciseMode,
        exCard: input.exCard,
        wireGuides: input.wireGuides,
        wireLogRow: input.wireLogRow,
        wireSkips: input.wireSkips,
        toast: input.toast,
        escapeHtml: input.escapeHtml,
        escapeAttr: input.escapeAttr,
        parseDur: input.parseDur,
      };
    },
  };

  return deps;
}

const CAIRN_TODAY_DEPENDENCIES: ClientTodayDependenciesApi = {
  context: makeTodayDependencies,
};

Object.assign(globalThis, { CairnTodayDependencies: CAIRN_TODAY_DEPENDENCIES });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnTodayDependencies: CAIRN_TODAY_DEPENDENCIES });
}
