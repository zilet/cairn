// Typed shell-router bridge for 10-boot.js. The lower-level URL parser lives in
// route-state.ts; this module owns applying parsed routes to app state and turning
// current state back into a canonical browser URL.
type AppRoute = import("../../contracts/client.js").ClientRoute;
type AppRouteDefinitions = import("../../contracts/client-routes.js").ClientRouteDefinitions;
type AppRoutesApi = import("../../contracts/client.js").ClientRoutesApi;

type RouteItem = string | readonly [string, unknown];
type RouteItems = ReadonlyArray<RouteItem>;
type RouteMode = "push" | "replace";

/** What a day page's history entry remembers (drill-controller.ts): the opener's home, and whether the opener sits behind it. */
type DrillHistoryState = { from?: unknown; drill?: unknown } | null | undefined;

type ApplyRouteOptions = {
  state: ClientAppState;
  /** The entry's own history.state: a reload or Back into a day page keeps its opener. */
  historyState?: DrillHistoryState;
  routeApi?: AppRoutesApi | null;
  planSections: RouteItems;
  progressSections: RouteItems;
  standSections: RouteItems;
  meSections: RouteItems;
  healthSections: RouteItems;
  settingsSections: RouteItems;
};

type CurrentRouteOptions = {
  state: ClientAppState;
  planSections: RouteItems;
  progressSections: RouteItems;
  standSections: RouteItems;
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
  /** Extra history.state for the entry (a day page's opener). */
  historyState?: Record<string, unknown> | null;
};

type AppRouterRoot = typeof globalThis & { CairnAppRouter?: ClientAppRouterApi };

// @ts-check
{
  function routeDefinitions(): AppRouteDefinitions | null {
    const root = (typeof window !== "undefined" ? window : globalThis) as AppRouterRoot & { CairnRoutes?: AppRoutesApi };
    return root.CairnRoutes?.routeDefinitions || null;
  }

  const ROUTE_TABS: ClientTabName[] = [...(routeDefinitions()?.tabs || ["today"])];

  // ONE default for the Settings landing section, read from the route definitions
  // (src/contracts/client-routes.ts, mirrored in route-state.ts) rather than
  // repeated as a literal here. Settings opens on Sources: its old "You" slice is
  // the You home's own landing now.
  function defaultSettingsSection(): ClientSettingsSection {
    return (routeDefinitions()?.defaults.settingsSection || "sources") as ClientSettingsSection;
  }

  // "Today" is a moving target, not a bookmark. Pinning it as an absolute ?date=
  // means the next launch restores a date that has since become yesterday, and the
  // header then reads "Yesterday" on a fresh open. Only a deliberately chosen other
  // day belongs in the URL.
  function localToday(): string | null {
    const root = (typeof window !== "undefined" ? window : globalThis) as AppRouterRoot & {
      localISO?: (d?: Date) => string;
    };
    return typeof root.localISO === "function" ? root.localISO() : null;
  }

  function isLocalToday(date: unknown): boolean {
    const today = localToday();
    return today !== null && String(date || "") === today;
  }

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

  // Legacy me/standing + me/health/* routes redirect into Health (the Stand view),
  // where every health surface lives first-class. parseRoute already maps a v1
  // URL there; this covers a route object built in code with the old shape.
  const LEGACY_HEALTH_TO_STAND: Record<string, string | null> = {
    read: null, // the overview IS the read
    markers: "markers",
    records: "records",
    share: "share",
    learned: "learned",
  };

  // The home a day page is read under: the tab that opened it (null = Today, its default).
  const DAY_HOMES = new Set<string>(["today", "train", "horizon", "ask", "you"]);
  function dayHomeOf(section: unknown): ClientHomeName | null {
    const s = String(section || "");
    return DAY_HOMES.has(s) ? (s as ClientHomeName) : null;
  }

  function applyRouteState(route: AppRoute | null | undefined, options: ApplyRouteOptions): ClientTabName {
    if (!route) return "today";
    const { state } = options;
    const requested = tabKey(route.tab);
    // Today is Home: it only ever renders today. Another day is its own read-only
    // destination (the "day" view) — so an old /app/today?date=<day> link opens that
    // day's record or preview, never Today wearing another date, and a day link that
    // names today IS Today.
    const today = localToday();
    const dayWanted = requested === "day" || (requested === "today" && !!route.date && !isLocalToday(route.date));
    const tab: ClientTabName =
      dayWanted && route.date && !isLocalToday(route.date) ? "day" : requested === "day" ? "today" : requested;
    if (tab === "day") {
      state.dayDate = route.date;
      // The page is home-free (/app/day/<date>): the opener rides in the entry's
      // history.state, so a reload or a Back into it keeps the tab that opened it lit.
      // An old alias (/app/train/day?date=) names its home in the path instead.
      const alias = dayHomeOf(requested === "day" ? route.section : null);
      const hs = options.historyState;
      state.drillFrom = alias || dayHomeOf(hs?.from);
      state.drillBack = !alias && hs?.drill === 1;
      return tab;
    }
    if (tab === "today") {
      // Re-measure, and drop the pick it belonged to: leaving logDate on the day we
      // came from would paint Today as another day.
      if (today) {
        state.logDate = today;
        state.dayPicked = false;
        state.dayPickedOn = null;
      }
    } else if (route.date) {
      state.logDate = route.date;
    }

    if (tab === "plan") {
      const section = routeKey(route.section, options.routeApi?.planSections || options.planSections, "edit") as ClientPlanSection;
      state.planSeg = section;
      state.planJump = section === "edit" ? null : section;
    } else if (tab === "progress") {
      state.progressSeg = routeKey(route.section, options.progressSections, state.progressSeg || null) as ClientProgressSection | undefined;
    } else if (tab === "stand") {
      state.standSeg = routeKey(route.section, options.standSections, null) as ClientStandSection | null;
      if (state.standSeg === "records") state.pendingHealthDocId = route.id || null;
      // The domain drill-in carries WHICH domain in ?id=. A domain URL with no key
      // is not an error — Stand falls back to the overview rather than crashing.
      if (state.standSeg === "domain") state.standDomain = route.id || null;
    } else if (tab === "me") {
      // Match the RAW section for the legacy redirects — "standing"/"health" are
      // no longer Me seg-bar entries, so routeKey would fall back to profile.
      const rawSection = String(route.section || "");
      if (rawSection === "standing") {
        state.standSeg = "age";
        return "stand";
      }
      if (rawSection === "health") {
        const healthSection = routeKey(route.healthSection, options.healthSections, "read") as ClientHealthSection;
        state.standSeg = (LEGACY_HEALTH_TO_STAND[healthSection] ?? null) as ClientStandSection | null;
        if (state.standSeg === "records") state.pendingHealthDocId = route.id || null;
        return "stand";
      }
      state.meSeg = routeKey(route.section, options.meSections, "profile") as ClientMeSection;
    } else if (tab === "settings") {
      state.setSeg = routeKey(route.section, options.settingsSections, state.setSeg || defaultSettingsSection()) as ClientSettingsSection;
    } else if (tab === "chat") {
      state.pendingChatSession = route.session || null;
    } else if (tab === "horizon") {
      state.horizonSeg = (String(route.section || "") === "goal" ? "goal" : null) as ClientHorizonSection | null;
    } else if (tab === "you") {
      // A stone detail carries WHICH stone in ?id=; without one it is the landing.
      const stone = String(route.section || "") === "stone" && route.id ? route.id : null;
      state.youSeg = stone ? "stone" : null;
      state.youStone = stone;
    }

    return tab;
  }

  function currentRouteState(options: CurrentRouteOptions): Partial<AppRoute> {
    const { state } = options;
    const tab = tabKey(state.tab);
    const route: Partial<AppRoute> = { tab };
    if (tab === "today") {
      // Today never carries a date: it is always today.
    } else if (tab === "day") {
      if (state.dayDate) route.date = state.dayDate;
    } else if (tab === "session") {
      if (state.logDate) route.date = state.logDate;
    } else if (tab === "plan") {
      const section = routeKey(state.planJump || state.planSeg, options.planSections, "edit");
      route.section = section as AppRoute["section"];
      if (section === "food" && state.logDate && !isLocalToday(state.logDate)) route.date = state.logDate;
    } else if (tab === "progress") {
      route.section = routeKey(state.progressSeg || options.defaultProgressSection, options.progressSections, options.defaultProgressSection) as AppRoute["section"];
    } else if (tab === "stand") {
      route.section = routeKey(state.standSeg, options.standSections, null) as AppRoute["section"];
      if (route.section === "records" && state.pendingHealthDocId) route.id = state.pendingHealthDocId;
      if (route.section === "domain" && state.standDomain) route.id = state.standDomain;
    } else if (tab === "me") {
      route.section = routeKey(state.meSeg, options.meSections, "profile") as AppRoute["section"];
    } else if (tab === "settings") {
      route.section = routeKey(state.setSeg, options.settingsSections, defaultSettingsSection()) as AppRoute["section"];
    } else if (tab === "chat" && state.pendingChatSession) {
      route.session = state.pendingChatSession;
    } else if (tab === "horizon") {
      route.section = (state.horizonSeg || null) as AppRoute["section"];
    } else if (tab === "you" && state.youSeg === "stone" && state.youStone) {
      route.section = "stone";
      route.id = state.youStone;
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
    history[mode === "replace" ? "replaceState" : "pushState"]({ ...(options.historyState || {}), cairn: true }, "", next);
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
