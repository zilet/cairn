(() => {
// @ts-check
// Me Health dependency factories: keep the screen focused on route/public
// compatibility while this module assembles controller dependencies.
function healthInput(selector, root = document) {
    return root.querySelector(selector);
}
function healthInputValue(selector, root = document) {
    return healthInput(selector, root)?.value ?? "";
}
function healthNumberValue(selector, root = document) {
    const raw = healthInputValue(selector, root);
    if (!raw)
        return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}
function healthTextAreaValue(selector, root = document) {
    return root.querySelector(selector)?.value ?? "";
}
let healthReadSpy = null;
function makeMeHealthDependenciesContext(input) {
    return {
        root: input.root,
        state: input.state,
        segments: input.segments,
        handlers: input.handlers,
        document: input.document,
        headerTitle: input.headerTitle,
        api: input.api,
        cachedApi: input.cachedApi,
        peekCached: input.peekCached,
        markRefreshing: input.markRefreshing,
        swrInvalidate: input.swrInvalidate,
        runOp: input.runOp,
        toast: input.toast,
        armDelete: input.armDelete,
        activateTab: input.activateTab,
        escapeAttr: input.escapeAttr,
        escapeHtml: input.escapeHtml,
        invalidatePoll: input.invalidatePoll,
        mountSaveBar: input.mountSaveBar,
        primaryDiscipline: input.primaryDiscipline,
        renderMe: input.renderMe,
        renderProfile: input.renderProfile,
        segBar: input.segBar,
        segSkeleton: input.segSkeleton,
        setDiscipline: input.setDiscipline,
        setEnduranceGoalSet: input.setEnduranceGoalSet,
        skeletonSwap: input.skeletonSwap,
        wireSeg: input.wireSeg,
        fitSeg: input.fitSeg,
        syncRouteFromState: input.syncRouteFromState,
        withViewTransition: input.withViewTransition,
        select: input.select,
        relTime: input.relTime,
        relAge: input.relAge,
        stagger: input.stagger,
        reducedMotion: input.reducedMotion,
        pollToken: input.pollToken,
        switchHealthSeg: input.switchHealthSeg,
        onHealthReadView: input.onHealthReadView,
        loadHealthPicture: input.loadHealthPicture,
        paintHealthPicture: input.paintHealthPicture,
        healthDocsKnownEmpty: input.healthDocsKnownEmpty,
        paintRead: input.paintRead,
        paintMarkers: input.paintMarkers,
        paintRecords: input.paintRecords,
        paintShare: input.paintShare,
        paintLearned: input.paintLearned,
        activityEntryHtml: input.activityEntryHtml,
        openFoodDetail: input.openFoodDetail,
        loadDexaTargeting: input.loadDexaTargeting,
        storage: input.storage,
    };
}
function makeMeProfileDeps(ctx) {
    return {
        root: ctx.root,
        state: ctx.state,
        segments: ctx.segments,
        handlers: ctx.handlers,
        headerTitle: ctx.headerTitle,
        api: ctx.api,
        activateTab: ctx.activateTab,
        escapeAttr: ctx.escapeAttr,
        escapeHtml: ctx.escapeHtml,
        inputValue: healthInputValue,
        invalidatePoll: ctx.invalidatePoll,
        mountSaveBar: ctx.mountSaveBar,
        numberValue: healthNumberValue,
        primaryDiscipline: ctx.primaryDiscipline,
        renderMe: ctx.renderMe,
        renderProfile: ctx.renderProfile,
        segBar: ctx.segBar,
        segSkeleton: ctx.segSkeleton,
        setDiscipline: ctx.setDiscipline,
        setEnduranceGoalSet: ctx.setEnduranceGoalSet,
        skeletonSwap: ctx.skeletonSwap,
        swrInvalidate: ctx.swrInvalidate,
        textAreaValue: healthTextAreaValue,
        toast: ctx.toast,
        wireSeg: ctx.wireSeg,
        select: ctx.select,
    };
}
function makeMeHealthLogDeps(ctx) {
    return {
        state: ctx.state,
        select: ctx.select,
        noteEntryHtml: (note, index) => CairnFoodNote.noteEntryHtml(note, index),
        activityEntryHtml: ctx.activityEntryHtml,
        openFoodDetail: ctx.openFoodDetail,
    };
}
function makeMeMemoryDeps(ctx) {
    return {
        view: ctx.root,
        state: ctx.state,
        segments: ctx.segments,
        handlers: ctx.handlers,
        headerTitle: ctx.headerTitle,
        api: ctx.api,
        armDelete: ctx.armDelete,
        escapeAttr: ctx.escapeAttr,
        invalidatePoll: ctx.invalidatePoll,
        segBar: ctx.segBar,
        toast: ctx.toast,
        wireSeg: ctx.wireSeg,
    };
}
function makeHealthReadDeps(ctx) {
    return {
        root: ctx.root,
        state: ctx.state,
        api: ctx.api,
        cachedApi: ctx.cachedApi,
        peekCached: ctx.peekCached,
        markRefreshing: ctx.markRefreshing,
        swrInvalidate: ctx.swrInvalidate,
        runOp: ctx.runOp,
        toast: ctx.toast,
        pollToken: ctx.pollToken,
        select: ctx.select,
        escapeAttr: ctx.escapeAttr,
        escapeHtml: ctx.escapeHtml,
        relTime: ctx.relTime,
        stagger: ctx.stagger,
        reducedMotion: ctx.reducedMotion,
        switchHealthSeg: ctx.switchHealthSeg,
        isHealthReviewRunning: () => CairnHealthPictureController.isHealthReviewRunning(),
        loadHealthPicture: ctx.loadHealthPicture,
        paintHealthPicture: ctx.paintHealthPicture,
        setReadSpy: (spy) => { healthReadSpy = spy; },
        teardownReadSpy: () => {
            if (healthReadSpy) {
                healthReadSpy.disconnect();
                healthReadSpy = null;
            }
        },
    };
}
function makeHealthPictureDeps(ctx) {
    return {
        root: ctx.root,
        state: ctx.state,
        api: ctx.api,
        toast: ctx.toast,
        switchHealthSeg: ctx.switchHealthSeg,
        onHealthReadView: ctx.onHealthReadView,
        pollToken: ctx.pollToken,
        escapeHtml: ctx.escapeHtml,
        storage: ctx.storage,
    };
}
function makeHealthMarkersDeps(ctx) {
    return {
        root: ctx.root,
        cachedApi: ctx.cachedApi,
        peekCached: ctx.peekCached,
        markRefreshing: ctx.markRefreshing,
        pollToken: ctx.pollToken,
        relAge: ctx.relAge,
        select: ctx.select,
        stagger: ctx.stagger,
        switchHealthSeg: ctx.switchHealthSeg,
        escapeHtml: ctx.escapeHtml,
    };
}
function makeMeHealthTabsDeps(ctx) {
    return {
        root: ctx.root,
        state: ctx.state,
        segments: ctx.segments,
        handlers: ctx.handlers,
        headerTitle: ctx.headerTitle,
        segBar: ctx.segBar,
        wireSeg: ctx.wireSeg,
        fitSeg: ctx.fitSeg,
        syncRouteFromState: ctx.syncRouteFromState,
        withViewTransition: ctx.withViewTransition,
        select: ctx.select,
        healthDocsKnownEmpty: ctx.healthDocsKnownEmpty,
        invalidatePoll: ctx.invalidatePoll,
        paintRead: ctx.paintRead,
        paintMarkers: ctx.paintMarkers,
        paintRecords: ctx.paintRecords,
        paintShare: ctx.paintShare,
        paintLearned: ctx.paintLearned,
    };
}
function makeHealthStandingDeps(ctx) {
    return {
        root: ctx.root,
        document: ctx.document,
        state: ctx.state,
        api: ctx.api,
        swrInvalidate: ctx.swrInvalidate,
        toast: ctx.toast,
        activateTab: ctx.activateTab,
        pollToken: ctx.pollToken,
        select: ctx.select,
        escapeAttr: ctx.escapeAttr,
        loadDexaTargeting: ctx.loadDexaTargeting,
    };
}
const CAIRN_ME_HEALTH_DEPENDENCIES = {
    context: makeMeHealthDependenciesContext,
    inputValue: healthInputValue,
    numberValue: healthNumberValue,
    textAreaValue: healthTextAreaValue,
    profile: makeMeProfileDeps,
    log: makeMeHealthLogDeps,
    memory: makeMeMemoryDeps,
    read: makeHealthReadDeps,
    picture: makeHealthPictureDeps,
    markers: makeHealthMarkersDeps,
    tabs: makeMeHealthTabsDeps,
    standing: makeHealthStandingDeps,
};
Object.assign(globalThis, { CairnMeHealthDependencies: CAIRN_ME_HEALTH_DEPENDENCIES });
if (typeof window !== "undefined") {
    Object.assign(window, { CairnMeHealthDependencies: CAIRN_ME_HEALTH_DEPENDENCIES });
}
})();
