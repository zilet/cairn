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
  function lazySections(name: "ME_SEG" | "HEALTH_SEG" | "SET_SEG"): ReadonlyArray<RouteSyncItem> {
    const value = (globalThis as Record<string, unknown>)[name];
    return Array.isArray(value) ? (value as ReadonlyArray<RouteSyncItem>) : [];
  }

  function routeSyncMeSections(): ReadonlyArray<RouteSyncItem> {
    return routeSyncApi()?.meSections || lazySections("ME_SEG");
  }

  function routeSyncHealthSections(): ReadonlyArray<RouteSyncItem> {
    return routeSyncApi()?.healthSections || lazySections("HEALTH_SEG");
  }

  // Route matching reads the complete section keys (route-state DEFS), never a
  // visible bar: a section a bar happens not to show must keep its own URL.
  // SET_SEG is defined by the LAZY settings bundle; CairnRoutes carries the same
  // keys and is always in the shell (a cold /app/you/settings/data deep link is
  // resolved at boot, before that bundle loads).
  function routeSyncSettingsSections(): ReadonlyArray<RouteSyncItem> {
    return routeSyncApi()?.settingsSections || lazySections("SET_SEG");
  }

  function routeSyncPlanSections(): ReadonlyArray<RouteSyncItem> {
    return routeSyncApi()?.planSections || [];
  }

  function routeSyncApply(route: RouteSyncRoute | null | undefined): ClientTabName {
    return window.CairnAppRouter.applyRouteState(route, {
      state,
      historyState: typeof history !== "undefined" ? history.state : null,
      routeApi: routeSyncApi(),
      planSections: routeSyncPlanSections(),
      progressSections: PROGRESS_SEG,
      standSections: routeSyncStandSections(),
      meSections: routeSyncMeSections(),
      healthSections: routeSyncHealthSections(),
      settingsSections: routeSyncSettingsSections(),
    });
  }

  function routeSyncCurrent(): Partial<RouteSyncRoute> {
    return window.CairnAppRouter.currentRouteState({
      state,
      planSections: routeSyncPlanSections(),
      progressSections: PROGRESS_SEG,
      standSections: routeSyncStandSections(),
      meSections: routeSyncMeSections(),
      healthSections: routeSyncHealthSections(),
      settingsSections: routeSyncSettingsSections(),
      defaultProgressSection: defaultProgressSeg(),
    });
  }

  function routeSyncFromState(mode: RouteSyncMode = "push"): void {
    // A section change inside a view can move it to another home (Plan's race view
    // is Horizon's, its Fuel is Today's), so the lit tab follows every URL sync.
    if (typeof highlightHome === "function") highlightHome(state.tab);
    window.CairnAppRouter.syncRouteFromState({
      mode,
      routes: routeSyncApi(),
      route: routeSyncCurrent(),
      location,
      history,
      // A day page remembers its opener in its own entry (drill-controller.ts).
      historyState: state.tab === "day" ? { from: state.drillFrom || null, drill: state.drillBack ? 1 : 0 } : null,
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
