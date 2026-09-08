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

  // ME_SEG / HEALTH_SEG are defined by the LAZY me-health bundle, so on a cold
  // /app deep link they may not exist yet — and route state is resolved at boot,
  // before any navigation has loaded that bundle. CairnRoutes carries the same
  // section keys from CLIENT_ROUTE_DEFINITIONS and is always in the shell, so it
  // is both the eager answer and the more complete one (route matching needs the
  // keys, never the segment labels).
  function lazySections(name: "ME_SEG" | "HEALTH_SEG"): ReadonlyArray<RouteSyncItem> {
    const value = (globalThis as Record<string, unknown>)[name];
    return Array.isArray(value) ? (value as ReadonlyArray<RouteSyncItem>) : [];
  }

  function routeSyncMeSections(): ReadonlyArray<RouteSyncItem> {
    return routeSyncApi()?.meSections || lazySections("ME_SEG");
  }

  function routeSyncHealthSections(): ReadonlyArray<RouteSyncItem> {
    return routeSyncApi()?.healthSections || lazySections("HEALTH_SEG");
  }

  function routeSyncApply(route: RouteSyncRoute | null | undefined): ClientTabName {
    return window.CairnAppRouter.applyRouteState(route, {
      state,
      routeApi: routeSyncApi(),
      planSections: planSeg(),
      progressSections: PROGRESS_SEG,
      standSections: routeSyncStandSections(),
      meSections: routeSyncMeSections(),
      healthSections: routeSyncHealthSections(),
      settingsSections: SET_SEG,
    });
  }

  function routeSyncCurrent(): Partial<RouteSyncRoute> {
    return window.CairnAppRouter.currentRouteState({
      state,
      // Canonical URL state reads the complete route definition rather than the
      // VISIBLE bar: planSeg() hides Endurance for a strength athlete, and a
      // section the bar happens not to show must still keep its own URL instead
      // of being rewritten to Training during the next state sync.
      planSections: routeSyncApi()?.planSections || planSeg(),
      progressSections: PROGRESS_SEG,
      standSections: routeSyncStandSections(),
      meSections: routeSyncMeSections(),
      healthSections: routeSyncHealthSections(),
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
