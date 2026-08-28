// ==== route-state.js ====
// Stable, dependency-free route parsing for deep-linkable PWA screens.
// This file is intentionally pure: it does not mutate app state or navigate.
// 10-boot owns activation; this helper owns the URL contract it can consume.
// @ts-check
type CairnRoute = import("../contracts/client.js").ClientRoute;
type CairnRoutesApi = import("../contracts/client.js").ClientRoutesApi;
type ClientRouteDefinitions = import("../contracts/client-routes.js").ClientRouteDefinitions;
type CairnRouteRoot = typeof globalThis & { CairnRoutes?: CairnRoutesApi };

(function initCairnRoutes(root: CairnRouteRoot) {
  const CLIENT_ROUTE_DEFINITIONS = {
    appBasePath: "/app",
    defaults: {
      tab: "today",
      planSection: "edit",
      meSection: "profile",
      healthSection: "read",
      settingsSection: "agents",
    },
    tabs: ["today", "session", "stand", "plan", "progress", "chat", "me", "settings"],
    sections: {
      plan: ["edit", "endurance", "food", "meals", "coach"],
      progress: ["overview", "trend", "volume", "endurance", "weight", "measurements", "calendar", "sessions", "program", "intake", "energy"],
      // Stand is the health home: every health tool is a first-class Stand sub-view.
      // "me" health sections survive only as parse targets that redirect into Stand.
      stand: ["records", "share", "learned", "connections", "markers", "body", "recovery", "supplements", "age", "checkup", "domain"],
      me: ["standing", "profile", "memory", "health", "life", "family"],
      health: ["read", "markers", "records", "share", "learned"],
      settings: ["you", "agents", "system", "sources", "automation", "data"],
    },
  } as const satisfies ClientRouteDefinitions;
  const APP_PATH_SEGMENT = cleanSegment(CLIENT_ROUTE_DEFINITIONS.appBasePath);
  const VALID_TABS = new Set<string>(CLIENT_ROUTE_DEFINITIONS.tabs);
  const PLAN_SECTIONS = new Set<string>(CLIENT_ROUTE_DEFINITIONS.sections.plan);
  const PROGRESS_SECTIONS = new Set<string>(CLIENT_ROUTE_DEFINITIONS.sections.progress);
  const STAND_SECTIONS = new Set<string>(CLIENT_ROUTE_DEFINITIONS.sections.stand);
  const ME_SECTIONS = new Set<string>(CLIENT_ROUTE_DEFINITIONS.sections.me);
  const HEALTH_SECTIONS = new Set<string>(CLIENT_ROUTE_DEFINITIONS.sections.health);
  const SETTINGS_SECTIONS = new Set<string>(CLIENT_ROUTE_DEFINITIONS.sections.settings);

  function cleanSegment(v: unknown): string {
    return String(v || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "");
  }

  function firstParam(params: URLSearchParams, key: string): string | null {
    const v = params.get(key);
    return v == null || v === "" ? null : v;
  }

  function validDate(v: unknown): string | null {
    const s = String(v || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }

  function oneOf(value: unknown, allowed: Set<string>, fallback: string | null = null): string | null {
    const v = cleanSegment(value);
    return allowed.has(v) ? v : fallback;
  }

  function toUrl(input: string | URL): URL {
    try {
      if (input instanceof URL) return input;
      return new URL(String(input || "/"), "http://cairn.local");
    } catch {
      return new URL("/", "http://cairn.local");
    }
  }

  function parseRoute(input: string | URL): CairnRoute {
    const url = toUrl(input);
    const params = url.searchParams;
    const parts = url.pathname.split("/").filter(Boolean).map(cleanSegment);
    let tab: CairnRoute["tab"] = CLIENT_ROUTE_DEFINITIONS.defaults.tab;
    let section: CairnRoute["section"] = null;
    let healthSection: CairnRoute["healthSection"] = null;

    if (parts[0] === APP_PATH_SEGMENT) {
      tab = (
        oneOf(parts[1], VALID_TABS, CLIENT_ROUTE_DEFINITIONS.defaults.tab) ||
        CLIENT_ROUTE_DEFINITIONS.defaults.tab
      ) as CairnRoute["tab"];
    } else if (VALID_TABS.has(parts[0])) {
      tab = parts[0] as CairnRoute["tab"];
    } else {
      tab = (
        oneOf(firstParam(params, "tab"), VALID_TABS, CLIENT_ROUTE_DEFINITIONS.defaults.tab) ||
        CLIENT_ROUTE_DEFINITIONS.defaults.tab
      ) as CairnRoute["tab"];
    }

    const route: CairnRoute = {
      tab,
      section: null,
      healthSection: null,
      date: validDate(firstParam(params, "date")),
      id: firstParam(params, "id"),
      session: firstParam(params, "session"),
      jump: firstParam(params, "jump"),
    };

    const sectionPart = parts[0] === APP_PATH_SEGMENT ? parts[2] : parts[1];
    const nestedPart = parts[0] === APP_PATH_SEGMENT ? parts[3] : parts[2];

    if (tab === "plan") {
      section = (
        oneOf(sectionPart, PLAN_SECTIONS, null) ||
        oneOf(route.jump, PLAN_SECTIONS, null)
      ) as CairnRoute["section"];
    } else if (tab === "progress") {
      section = oneOf(sectionPart, PROGRESS_SECTIONS, null) as CairnRoute["section"];
    } else if (tab === "stand") {
      section = oneOf(sectionPart, STAND_SECTIONS, null) as CairnRoute["section"];
    } else if (tab === "me") {
      section = oneOf(sectionPart, ME_SECTIONS, CLIENT_ROUTE_DEFINITIONS.defaults.meSection) as CairnRoute["section"];
      if (section === "health") {
        healthSection = (
          oneOf(nestedPart, HEALTH_SECTIONS, null) ||
          oneOf(firstParam(params, "health"), HEALTH_SECTIONS, CLIENT_ROUTE_DEFINITIONS.defaults.healthSection)
        ) as CairnRoute["healthSection"];
      }
    } else if (tab === "settings") {
      section = oneOf(sectionPart, SETTINGS_SECTIONS, null) as CairnRoute["section"];
    }

    route.section = section;
    route.healthSection = healthSection;
    return route;
  }

  function addParam(params: URLSearchParams, key: string, value: unknown) {
    if (value != null && String(value).trim() !== "") params.set(key, String(value));
  }

  function routeToUrl(route: Partial<CairnRoute> | null | undefined): string {
    const r = route || {};
    const tab = (
      oneOf(r.tab, VALID_TABS, CLIENT_ROUTE_DEFINITIONS.defaults.tab) ||
      CLIENT_ROUTE_DEFINITIONS.defaults.tab
    ) as CairnRoute["tab"];
    const params = new URLSearchParams();
    let path = `${CLIENT_ROUTE_DEFINITIONS.appBasePath}/${tab}`;

    if (tab === "plan") {
      const section = oneOf(r.section, PLAN_SECTIONS, null);
      if (section) path += `/${section}`;
    } else if (tab === "progress") {
      const section = oneOf(r.section, PROGRESS_SECTIONS, null);
      if (section) path += `/${section}`;
    } else if (tab === "stand") {
      const section = oneOf(r.section, STAND_SECTIONS, null);
      if (section) path += `/${section}`;
    } else if (tab === "me") {
      const section = oneOf(r.section, ME_SECTIONS, null);
      if (section) path += `/${section}`;
      if (section === "health") {
        const h = oneOf(r.healthSection, HEALTH_SECTIONS, null);
        if (h) path += `/${h}`;
      }
    } else if (tab === "settings") {
      const section = oneOf(r.section, SETTINGS_SECTIONS, null);
      if (section) path += `/${section}`;
    }

    addParam(params, "date", validDate(r.date));
    addParam(params, "id", r.id);
    addParam(params, "session", r.session);
    addParam(params, "jump", oneOf(r.jump, PLAN_SECTIONS, null));

    const q = params.toString();
    return q ? `${path}?${q}` : path;
  }

  root.CairnRoutes = {
    parseRoute,
    routeToUrl,
    routeDefinitions: CLIENT_ROUTE_DEFINITIONS,
    validTabs: [...CLIENT_ROUTE_DEFINITIONS.tabs],
    planSections: [...CLIENT_ROUTE_DEFINITIONS.sections.plan],
    progressSections: [...CLIENT_ROUTE_DEFINITIONS.sections.progress],
    standSections: [...CLIENT_ROUTE_DEFINITIONS.sections.stand],
    meSections: [...CLIENT_ROUTE_DEFINITIONS.sections.me],
    healthSections: [...CLIENT_ROUTE_DEFINITIONS.sections.health],
    settingsSections: [...CLIENT_ROUTE_DEFINITIONS.sections.settings],
  };
})((typeof window !== "undefined" ? window : globalThis) as CairnRouteRoot);
