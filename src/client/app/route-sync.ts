type RouteSyncRoute = import("../../contracts/client.js").ClientRoute;
type RouteSyncRoutesApi = import("../../contracts/client.js").ClientRoutesApi;
type RouteSyncItem = string | readonly [string, unknown];
type RouteSyncMode = "push" | "replace";

// @ts-check
{
  function routeSyncKey(
    key: unknown,
    items: ReadonlyArray<RouteSyncItem>,
    fallback: string | null = null
  ): string | null {
    return window.CairnAppRouter.routeKey(key, items, fallback);
  }

  function routeSyncApi(): RouteSyncRoutesApi | null {
    return window.CairnRoutes &&
      typeof window.CairnRoutes.parseRoute === "function" &&
      typeof window.CairnRoutes.routeToUrl === "function"
      ? window.CairnRoutes
      : null;
  }

  function routeSyncStandSections(): ReadonlyArray<RouteSyncItem> {
    return routeSyncApi()?.standSections || [];
  }

  function routeSyncApply(route: RouteSyncRoute | null | undefined): ClientTabName {
    return window.CairnAppRouter.applyRouteState(route, {
      state,
      routeApi: routeSyncApi(),
      planSections: planSeg(),
      progressSections: PROGRESS_SEG,
      standSections: routeSyncStandSections(),
      meSections: ME_SEG,
      healthSections: HEALTH_SEG,
      settingsSections: SET_SEG,
    });
  }

  function routeSyncCurrent(): Partial<RouteSyncRoute> {
    return window.CairnAppRouter.currentRouteState({
      state,
      // The visible Plan bar intentionally omits the internal Changes route.
      // Canonical URL state still needs the complete route definition so a
      // genuine review-required change can remain at /app/plan/coach instead
      // of being rewritten to Training during the next state sync.
      planSections: routeSyncApi()?.planSections || planSeg(),
      progressSections: PROGRESS_SEG,
      standSections: routeSyncStandSections(),
      meSections: ME_SEG,
      healthSections: HEALTH_SEG,
      settingsSections: SET_SEG,
      defaultProgressSection: defaultProgressSeg(),
    });
  }

  function routeSyncFromState(mode: RouteSyncMode = "push"): void {
    window.CairnAppRouter.syncRouteFromState({
      mode,
      routes: routeSyncApi(),
      route: routeSyncCurrent(),
      location,
      history,
    });
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
