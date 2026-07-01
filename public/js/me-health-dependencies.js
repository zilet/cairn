(() => {
// @ts-check
// Me Health public dependency namespace and input/context helpers.
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
const CAIRN_ME_HEALTH_DEPENDENCIES = {
    context: makeMeHealthDependenciesContext,
    inputValue: healthInputValue,
    numberValue: healthNumberValue,
    textAreaValue: healthTextAreaValue,
    profile: (ctx) => CairnMeHealthControllerDeps.profile(ctx, {
        inputValue: healthInputValue,
        numberValue: healthNumberValue,
        textAreaValue: healthTextAreaValue,
    }),
    log: (ctx) => CairnMeHealthControllerDeps.log(ctx),
    memory: (ctx) => CairnMeHealthControllerDeps.memory(ctx),
    read: (ctx) => CairnMeHealthControllerDeps.read(ctx),
    picture: (ctx) => CairnMeHealthControllerDeps.picture(ctx),
    markers: (ctx) => CairnMeHealthControllerDeps.markers(ctx),
    tabs: (ctx) => CairnMeHealthControllerDeps.tabs(ctx),
    standing: (ctx) => CairnMeHealthControllerDeps.standing(ctx),
};
Object.assign(globalThis, { CairnMeHealthDependencies: CAIRN_ME_HEALTH_DEPENDENCIES });
if (typeof window !== "undefined") {
    Object.assign(window, { CairnMeHealthDependencies: CAIRN_ME_HEALTH_DEPENDENCIES });
}
})();
