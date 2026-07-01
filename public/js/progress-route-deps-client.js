(() => {
// @ts-check
// Shared dependency builders for Progress route controllers.
function progressRouteNextToken() {
    return ++pollToken;
}
function progressRouteIsCurrent(token) {
    return token === pollToken;
}
function progressRouteSegmentHtml(active) {
    return segBar(active, PROGRESS_SEG);
}
function progressRouteSkeletonHtml(active, cards) {
    return segSkeleton(active, PROGRESS_SEG, cards);
}
function progressRouteWireSegments() {
    wireSeg(PROGRESS_HANDLERS);
}
function progressEnduranceRouteDeps(renderSelf) {
    return {
        view,
        headerTitle,
        state,
        api,
        nextToken: progressRouteNextToken,
        isCurrent: progressRouteIsCurrent,
        segmentHtml: progressRouteSegmentHtml,
        wireSegments: progressRouteWireSegments,
        loading: loadingState,
        empty: emptyStateHtml,
        hero: progressHero,
        art,
        runCountUps,
        renderSelf,
    };
}
function progressProgramRouteDeps(renderSelf) {
    return {
        view,
        headerTitle,
        state,
        api,
        runOp,
        nextToken: progressRouteNextToken,
        isCurrent: progressRouteIsCurrent,
        peekCached,
        paintSWR: paintSWR,
        segmentHtml: progressRouteSegmentHtml,
        skeletonHtml: progressRouteSkeletonHtml,
        wireSegments: progressRouteWireSegments,
        hero: progressHero,
        empty: emptyStateHtml,
        art,
        busy: btnBusy,
        toast,
        invalidate: swrInvalidate,
        runCountUps,
        renderSelf,
    };
}
const CAIRN_PROGRESS_ROUTE_DEPS = {
    endurance: progressEnduranceRouteDeps,
    program: progressProgramRouteDeps,
};
Object.assign(globalThis, { CairnProgressRouteDeps: CAIRN_PROGRESS_ROUTE_DEPS });
if (typeof window !== "undefined") {
    window.CairnProgressRouteDeps = CAIRN_PROGRESS_ROUTE_DEPS;
}
})();
