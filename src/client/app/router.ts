// Typed shell-router bridge for 10-boot.js. The lower-level URL parser lives in
// route-state.ts; this module owns applying parsed routes to app state and turning
// current state back into a canonical browser URL.
type AppRoute = import("../../contracts/client.js").ClientRoute;
type AppRouteDefinitions = import("../../contracts/client-routes.js").ClientRouteDefinitions;
type AppRoutesApi = import("../../contracts/client.js").ClientRoutesApi;

type RouteItem = string | readonly [string, unknown];
type RouteItems = ReadonlyArray<RouteItem>;
type RouteMode = "push" | "replace";

type ApplyRouteOptions = {
  state: ClientAppState;
  routeApi?: AppRoutesApi | null;
  planSections: RouteItems;
  progressSections: RouteItems;
  meSections: RouteItems;
  healthSections: RouteItems;
  settingsSections: RouteItems;
};

type CurrentRouteOptions = {
  state: ClientAppState;
  planSections: RouteItems;
  progressSections: RouteItems;
  meSections: RouteItems;
  healthSections: RouteItems;
  settingsSections: RouteItems;
  defaultProgressSection: string | null;
};

type SyncRouteOptions = {
  mode?: RouteMode;
  routes?: AppRoutesApi | null;
  route: Partial<AppRoute>;
  location: Pick<Location, "pathname" | "search">;
  history?: Pick<History, "pushState" | "replaceState"> | null;
};

type AppRouterRoot = typeof globalThis & { CairnAppRouter?: ClientAppRouterApi };

// @ts-check
{
  function routeDefinitions(): AppRouteDefinitions | null {
    const root = (typeof window !== "undefined" ? window : globalThis) as AppRouterRoot & { CairnRoutes?: AppRoutesApi };
    return root.CairnRoutes?.routeDefinitions || null;
  }

  const ROUTE_TABS: ClientTabName[] = [...(routeDefinitions()?.tabs || ["today"])];

  function itemKey(item: RouteItem): string {
    return String(Array.isArray(item) ? item[0] : item);
  }

  function routeKey(key: unknown, items: RouteItems, fallback: string | null = null): string | null {
    const s = String(key || "");
    return (items || []).some((item) => itemKey(item) === s) ? s : fallback;
  }

  function tabKey(tab: unknown): ClientTabName {
    const s = String(tab || "");
    return ROUTE_TABS.includes(s as ClientTabName) ? s as ClientTabName : "today";
  }

  function applyRouteState(route: AppRoute | null | undefined, options: ApplyRouteOptions): ClientTabName {
    if (!route) return "today";
    const { state } = options;
    if (route.date) state.logDate = route.date;
    const tab = tabKey(route.tab);

    if (tab === "plan") {
      const section = routeKey(route.section, options.routeApi?.planSections || options.planSections, "edit") as ClientPlanSection;
      state.planSeg = section;
      state.planJump = section === "edit" ? null : section;
    } else if (tab === "progress") {
      state.progressSeg = routeKey(route.section, options.progressSections, state.progressSeg || null) as ClientProgressSection | undefined;
    } else if (tab === "me") {
      state.meSeg = routeKey(route.section, options.meSections, "standing") as ClientMeSection;
      if (state.meSeg === "health") {
        state.healthSeg = routeKey(route.healthSection, options.healthSections, "read") as ClientHealthSection;
        state.healthSegPicked = true;
        state.pendingHealthDocId = route.id || null;
      }
    } else if (tab === "settings") {
      state.setSeg = routeKey(route.section, options.settingsSections, state.setSeg || "agents") as ClientSettingsSection;
    } else if (tab === "chat") {
      state.pendingChatSession = route.session || null;
    }

    return tab;
  }

  function currentRouteState(options: CurrentRouteOptions): Partial<AppRoute> {
    const { state } = options;
    const tab = tabKey(state.tab);
    const route: Partial<AppRoute> = { tab };
    if (tab === "today") {
      if (state.logDate) route.date = state.logDate;
    } else if (tab === "session") {
      if (state.logDate) route.date = state.logDate;
    } else if (tab === "plan") {
      const section = routeKey(state.planJump || state.planSeg, options.planSections, "edit");
      route.section = section as AppRoute["section"];
      if (section === "food" && state.logDate) route.date = state.logDate;
    } else if (tab === "progress") {
      route.section = routeKey(state.progressSeg || options.defaultProgressSection, options.progressSections, options.defaultProgressSection) as AppRoute["section"];
    } else if (tab === "me") {
      route.section = routeKey(state.meSeg, options.meSections, "standing") as AppRoute["section"];
      if (route.section === "health") {
        route.healthSection = routeKey(state.healthSeg, options.healthSections, "read") as AppRoute["healthSection"];
        if (state.pendingHealthDocId) route.id = state.pendingHealthDocId;
      }
    } else if (tab === "settings") {
      route.section = routeKey(state.setSeg, options.settingsSections, "agents") as AppRoute["section"];
    } else if (tab === "chat" && state.pendingChatSession) {
      route.session = state.pendingChatSession;
    }
    return route;
  }

  function syncRouteFromState(options: SyncRouteOptions): string | null {
    const routes = options.routes;
    const history = options.history;
    if (!routes || !history?.pushState) return null;
    const next = routes.routeToUrl(options.route);
    const current = `${options.location.pathname}${options.location.search}`;
    if (next === current) return null;
    const mode = options.mode === "replace" ? "replace" : "push";
    history[mode === "replace" ? "replaceState" : "pushState"]({ cairn: true }, "", next);
    return next;
  }

  const api: ClientAppRouterApi = {
    ROUTE_TABS,
    routeKey,
    applyRouteState,
    currentRouteState,
    syncRouteFromState,
  };

  ((typeof window !== "undefined" ? window : globalThis) as AppRouterRoot).CairnAppRouter = api;
}
