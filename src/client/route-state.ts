// ==== route-state.js ====
// Stable, dependency-free route parsing for deep-linkable PWA screens.
// This file is intentionally pure: it does not mutate app state or navigate.
// 10-boot owns activation; this helper owns the URL contract it can consume.
//
// Two grammars parse; one is written.
// - v2 (canonical): /app/<home>/<section>[/<nested>]?date&id&session, where the
//   home is a tab-bar button (today, train, horizon, ask, you), plus the HOME-FREE
//   object pages (/app/day/<date>): a page is read under whichever tab opened it
//   (state.drillFrom, drill-controller.ts), so its URL names no home. routeToUrl only
//   ever writes this form. The old day URLs (/app/<home>/day?date=, /app/day?date=,
//   /app/today?date=) stay aliases: they parse, carry their home, and are rewritten.
// - v1 (legacy): /app/<view>/<section>, a bare /<view>/<section>, or /?tab=<view>.
//   Every one maps onto its v2 home and is flagged `legacy`, so the shell rewrites
//   the address bar in place (replaceState) and an old bookmark keeps working.
// A parsed route is always VIEW-keyed (`tab` is what renders), plus its `home`.
// @ts-check
type CairnRoute = import("../contracts/client.js").ClientRoute;
type CairnRoutesApi = import("../contracts/client.js").ClientRoutesApi;
type ClientRouteDefinitions = import("../contracts/client-routes.js").ClientRouteDefinitions;
type CairnRouteHome = import("../contracts/client-routes.js").ClientHomeName;
type CairnRouteView = import("../contracts/client-routes.js").ClientTabName;
type CairnRouteRoot = typeof globalThis & { CairnRoutes?: CairnRoutesApi };

(function initCairnRoutes(root: CairnRouteRoot) {
  const CLIENT_ROUTE_DEFINITIONS = {
    appBasePath: "/app",
    defaults: {
      tab: "today",
      home: "today",
      planSection: "edit",
      meSection: "profile",
      healthSection: "read",
      // Settings opens on Sources: the "You" slice it used to open on is the You
      // home's own landing now.
      settingsSection: "sources",
    },
    homes: ["today", "train", "horizon", "ask", "you"],
    // The view a home opens on when its tab-bar button is tapped.
    homeViews: {
      today: "today",
      train: "progress",
      horizon: "horizon",
      ask: "chat",
      you: "you",
    },
    // The home each view lives under. Plan is resolved per section by planHomes.
    viewHomes: {
      today: "today",
      session: "today",
      // Any day that is not today, read-only: a past day's record, a future day's preview.
      day: "today",
      progress: "train",
      plan: "train",
      horizon: "horizon",
      chat: "ask",
      stand: "you",
      me: "you",
      settings: "you",
      you: "you",
    },
    planHomes: {
      edit: "train",
      endurance: "horizon",
      food: "today",
      meals: "today",
      coach: "ask",
    },
    tabs: ["today", "session", "stand", "plan", "progress", "chat", "me", "settings", "horizon", "you", "day"],
    sections: {
      plan: ["edit", "endurance", "food", "meals", "coach"],
      progress: ["overview", "trend", "volume", "endurance", "weight", "measurements", "calendar", "sessions", "program", "intake", "energy"],
      // Health (the Stand view) is every health tool as a first-class sub-view of
      // You. "me" health sections survive only as parse targets that redirect here.
      stand: ["records", "share", "learned", "connections", "markers", "body", "recovery", "supplements", "age", "checkup", "domain"],
      me: ["standing", "profile", "memory", "health", "life", "family"],
      health: ["read", "markers", "records", "share", "learned"],
      settings: ["sources", "automation", "data", "agents", "devices", "system"],
      horizon: ["goal"],
      // "stone" carries the stone key in ?id= (strength, endurance, fuel, ...).
      you: ["stone"],
    },
  } as const satisfies ClientRouteDefinitions;
  const DEFS = CLIENT_ROUTE_DEFINITIONS;
  const APP_PATH_SEGMENT = cleanSegment(DEFS.appBasePath);
  const VALID_TABS = new Set<string>(DEFS.tabs);
  const HOMES = new Set<string>(DEFS.homes);
  const PLAN_SECTIONS = new Set<string>(DEFS.sections.plan);
  const PROGRESS_SECTIONS = new Set<string>(DEFS.sections.progress);
  const STAND_SECTIONS = new Set<string>(DEFS.sections.stand);
  const HEALTH_SECTIONS = new Set<string>(DEFS.sections.health);
  const SETTINGS_SECTIONS = new Set<string>(DEFS.sections.settings);
  const HORIZON_SECTIONS = new Set<string>(DEFS.sections.horizon);
  const YOU_SECTIONS = new Set<string>(DEFS.sections.you);
  // The About-you sections that sit directly under /app/you/<x>. "standing" and
  // "health" are v1 redirects into Health, never v2 slugs.
  const ABOUT_YOU_SECTIONS = new Set<string>(["profile", "life", "family", "memory"]);

  // Legacy me/standing + me/health/* deep links land in Health, where every
  // health surface lives first-class. `read` is the overview itself.
  const LEGACY_HEALTH_TO_STAND: Record<string, string | null> = {
    read: null,
    markers: "markers",
    records: "records",
    share: "share",
    learned: "learned",
  };

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

  // A home key opens its landing view; a view key is itself; anything else is Today.
  function viewFor(name: unknown): CairnRouteView {
    const key = cleanSegment(name);
    if (VALID_TABS.has(key)) return key as CairnRouteView;
    if (HOMES.has(key)) return DEFS.homeViews[key as CairnRouteHome] as CairnRouteView;
    return DEFS.defaults.tab;
  }

  // Which tab-bar button a view lights. Plan is the one view split across homes.
  function homeOf(view: unknown, section?: unknown): CairnRouteHome {
    const v = viewFor(view);
    // A day page is read under the home that opened it (state.drillFrom, or an old
    // /app/train/day alias's home), so the lit tab and the "‹ Train" back link name
    // the same place. Today is its default (a cold /app/day/<date>).
    if (v === "day") {
      const home = cleanSegment(section);
      return (HOMES.has(home) ? home : DEFS.viewHomes.day) as CairnRouteHome;
    }
    if (v === "plan") {
      const s = oneOf(section, PLAN_SECTIONS, DEFS.defaults.planSection) || DEFS.defaults.planSection;
      return DEFS.planHomes[s as keyof typeof DEFS.planHomes] as CairnRouteHome;
    }
    return (DEFS.viewHomes[v] || DEFS.defaults.home) as CairnRouteHome;
  }

  type RouteTarget = { tab: CairnRouteView; section: string | null };

  function target(tab: CairnRouteView, section: string | null = null): RouteTarget {
    return { tab, section };
  }

  // The canonical v2 grammar: /app/<home>/<section>[/<nested>].
  function parseV2(home: string, section: string, nested: string, id: string | null): RouteTarget {
    // Any home can hold a day's view: the section carries that home unless it is Today's own.
    if (section === "day") return target("day", home === "today" ? null : home);
    if (home === "today") {
      if (section === "session") return target("session");
      if (section === "day") return target("day");
      if (section === "fuel") return target("plan", "food");
      // The week menu (Plan view, meals section); v1's /app/plan/meals lands here.
      if (section === "menu") return target("plan", "meals");
      return target("today");
    }
    if (home === "train") {
      if (section === "plan") return target("plan", "edit");
      return target("progress", oneOf(section, PROGRESS_SECTIONS, null));
    }
    if (home === "horizon") {
      if (section === "race") return target("plan", "endurance");
      return target("horizon", oneOf(section, HORIZON_SECTIONS, null));
    }
    if (home === "ask") {
      if (section === "changes") return target("plan", "coach");
      return target("chat");
    }
    // you
    if (section === "health") return target("stand");
    if (section === "settings") return target("settings", oneOf(nested, SETTINGS_SECTIONS, null));
    if (ABOUT_YOU_SECTIONS.has(section)) return target("me", section);
    if (section === "domain") return id ? target("stand", "domain") : target("stand");
    if (STAND_SECTIONS.has(section)) return target("stand", section);
    if (YOU_SECTIONS.has(section)) return target("you", section);
    return target("you");
  }

  // The v1 grammar: /app/<view>/<section>[/<nested>], mapped onto the same views.
  function parseV1(
    tab: string,
    section: string,
    nested: string,
    params: URLSearchParams,
    id: string | null
  ): RouteTarget {
    if (tab === "plan") {
      const s = oneOf(section, PLAN_SECTIONS, null) || oneOf(firstParam(params, "jump"), PLAN_SECTIONS, null);
      return target("plan", s || DEFS.defaults.planSection);
    }
    if (tab === "progress") return target("progress", oneOf(section, PROGRESS_SECTIONS, null));
    if (tab === "stand") {
      const s = oneOf(section, STAND_SECTIONS, null);
      if (s === "domain" && !id) return target("stand");
      return target("stand", s);
    }
    if (tab === "me") {
      if (section === "standing") return target("stand", "age");
      if (section === "health") {
        const h =
          oneOf(nested, HEALTH_SECTIONS, null) ||
          oneOf(firstParam(params, "health"), HEALTH_SECTIONS, DEFS.defaults.healthSection) ||
          DEFS.defaults.healthSection;
        return target("stand", LEGACY_HEALTH_TO_STAND[h] ?? null);
      }
      return target("me", oneOf(section, ABOUT_YOU_SECTIONS, null) || DEFS.defaults.meSection);
    }
    if (tab === "settings") {
      // The old Settings landing (and its "You" slice) IS the You home now.
      const s = oneOf(section, SETTINGS_SECTIONS, null);
      return s ? target("settings", s) : target("you");
    }
    if (tab === "session" || tab === "chat" || tab === "day") return target(tab);
    if (tab === "horizon" || tab === "you") return parseV2(tab, section, nested, id);
    return target("today");
  }

  function parseRoute(input: string | URL): CairnRoute {
    const url = toUrl(input);
    const params = url.searchParams;
    const parts = url.pathname.split("/").filter(Boolean).map(cleanSegment);
    const id = firstParam(params, "id");

    // Which segments name the destination. /app/<x>/..., a bare /<x>/..., or ?tab=<x>.
    let segs: string[];
    if (parts[0] === APP_PATH_SEGMENT) segs = parts.slice(1);
    else if (VALID_TABS.has(parts[0]) || HOMES.has(parts[0])) segs = parts;
    else segs = [cleanSegment(firstParam(params, "tab"))];
    const [first = "", section = "", nested = ""] = segs;
    // The home-free day page: /app/day/<date> (also /app/day?date=, written over).
    const dayPage = first === "day";

    // "today" is both a v1 view and a v2 home, and the v2 grammar is a superset of
    // what v1 Today ever carried, so it parses as v2. "horizon" and "you" were
    // never v1 views.
    const dest = dayPage
      ? target("day")
      : HOMES.has(first)
      ? parseV2(first, section, nested, id)
      : VALID_TABS.has(first)
        ? parseV1(first, section, nested, params, id)
        : target("today");

    const route: CairnRoute = {
      home: homeOf(dest.tab, dest.section),
      tab: dest.tab,
      section: dest.section as CairnRoute["section"],
      healthSection: null,
      date: validDate(firstParam(params, "date")) || (dayPage ? validDate(section) : null),
      id,
      session: firstParam(params, "session"),
      jump: null,
      legacy: false,
    };
    // Anything not already in canonical form is rewritten in place by the shell.
    // Unrelated query params (?source=shortcut) are not a reason to rewrite.
    const canonicalPath = routeToUrl(route).split("?")[0];
    // Today never carries a date (v2 wave 7): an old /app/today?date=<day> link is
    // rewritten to that day's own page (/app/day/<date>), or to plain Today.
    route.legacy =
      url.pathname !== canonicalPath ||
      params.has("tab") ||
      params.has("jump") ||
      params.has("health") ||
      (dest.tab === "today" && route.date != null);
    return route;
  }

  function addParam(params: URLSearchParams, key: string, value: unknown) {
    if (value != null && String(value).trim() !== "") params.set(key, String(value));
  }

  // The v2 path for a view-keyed route. Accepts a home key as `tab` too.
  function pathFor(r: Partial<CairnRoute>): string {
    const base = DEFS.appBasePath;
    const tab = viewFor(r.tab);
    const section = cleanSegment(r.section);
    switch (tab) {
      case "session":
        return `${base}/today/session`;
      case "day": {
        const date = validDate(r.date);
        return date ? `${base}/day/${date}` : `${base}/day`;
      }
      case "plan": {
        const s =
          oneOf(section, PLAN_SECTIONS, null) || oneOf(r.jump, PLAN_SECTIONS, null) || DEFS.defaults.planSection;
        if (s === "endurance") return `${base}/horizon/race`;
        if (s === "food") return `${base}/today/fuel`;
        if (s === "meals") return `${base}/today/menu`;
        if (s === "coach") return `${base}/ask/changes`;
        return `${base}/train/plan`;
      }
      case "progress": {
        const s = oneOf(section, PROGRESS_SECTIONS, null);
        return s ? `${base}/train/${s}` : `${base}/train`;
      }
      case "horizon": {
        const s = oneOf(section, HORIZON_SECTIONS, null);
        return s ? `${base}/horizon/${s}` : `${base}/horizon`;
      }
      case "chat":
        return `${base}/ask`;
      case "stand": {
        const s = oneOf(section, STAND_SECTIONS, null);
        if (!s || (s === "domain" && !r.id)) return `${base}/you/health`;
        return `${base}/you/${s}`;
      }
      case "me": {
        if (section === "standing") return `${base}/you/age`;
        if (section === "health") {
          const h = oneOf(r.healthSection, HEALTH_SECTIONS, null) || DEFS.defaults.healthSection;
          const s = LEGACY_HEALTH_TO_STAND[h] ?? null;
          return s ? `${base}/you/${s}` : `${base}/you/health`;
        }
        return `${base}/you/${oneOf(section, ABOUT_YOU_SECTIONS, null) || DEFS.defaults.meSection}`;
      }
      case "settings": {
        if (section === "you") return `${base}/you`;
        const s = oneOf(section, SETTINGS_SECTIONS, null);
        return s ? `${base}/you/settings/${s}` : `${base}/you/settings`;
      }
      case "you": {
        const s = oneOf(section, YOU_SECTIONS, null);
        return s ? `${base}/you/${s}` : `${base}/you`;
      }
      default:
        return `${base}/today`;
    }
  }

  function routeToUrl(route: Partial<CairnRoute> | null | undefined): string {
    const r = route || {};
    const path = pathFor(r);
    const params = new URLSearchParams();
    // A day page carries its date in the path; every other view in ?date=.
    if (viewFor(r.tab) !== "day") addParam(params, "date", validDate(r.date));
    addParam(params, "id", r.id);
    addParam(params, "session", r.session);
    const q = params.toString();
    return q ? `${path}?${q}` : path;
  }

  root.CairnRoutes = {
    parseRoute,
    routeToUrl,
    homeOf,
    viewFor,
    routeDefinitions: CLIENT_ROUTE_DEFINITIONS,
    homes: [...DEFS.homes],
    validTabs: [...DEFS.tabs],
    planSections: [...DEFS.sections.plan],
    progressSections: [...DEFS.sections.progress],
    standSections: [...DEFS.sections.stand],
    meSections: [...DEFS.sections.me],
    healthSections: [...DEFS.sections.health],
    settingsSections: [...DEFS.sections.settings],
    horizonSections: [...DEFS.sections.horizon],
    youSections: [...DEFS.sections.you],
  };
})((typeof window !== "undefined" ? window : globalThis) as CairnRouteRoot);
