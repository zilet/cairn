// @ts-check
{
    function routeSyncKey(key, items, fallback = null) {
        return window.CairnAppRouter.routeKey(key, items, fallback);
    }
    function routeSyncApi() {
        return window.CairnRoutes && typeof window.CairnRoutes.parseRoute === "function" && typeof window.CairnRoutes.routeToUrl === "function"
            ? window.CairnRoutes
            : null;
    }
    function routeSyncApply(route) {
        return window.CairnAppRouter.applyRouteState(route, {
            state,
            routeApi: routeSyncApi(),
            planSections: planSeg(),
            progressSections: PROGRESS_SEG,
            meSections: ME_SEG,
            healthSections: HEALTH_SEG,
            settingsSections: SET_SEG,
        });
    }
    function routeSyncCurrent() {
        return window.CairnAppRouter.currentRouteState({
            state,
            planSections: planSeg(),
            progressSections: PROGRESS_SEG,
            meSections: ME_SEG,
            healthSections: HEALTH_SEG,
            settingsSections: SET_SEG,
            defaultProgressSection: defaultProgressSeg(),
        });
    }
    function routeSyncFromState(mode = "push") {
        window.CairnAppRouter.syncRouteFromState({ mode, routes: routeSyncApi(), route: routeSyncCurrent(), location, history });
    }
    Object.assign(globalThis, {
        applyRouteState: routeSyncApply,
        currentRouteState: routeSyncCurrent,
        routeApi: routeSyncApi,
        routeKey: routeSyncKey,
        syncRouteFromState: routeSyncFromState,
    });
    if (typeof window !== "undefined") {
        Object.assign(window, {
            applyRouteState: routeSyncApply,
            currentRouteState: routeSyncCurrent,
            routeApi: routeSyncApi,
            routeKey: routeSyncKey,
            syncRouteFromState: routeSyncFromState,
        });
    }
}
