// The PWA's URL contract. Two layers, on purpose:
//
// - VIEWS (`tabs`) are what renders: `state.tab` holds one, `body[data-tab]`
//   carries it, and every renderer and `activateTab(...)` call site speaks it.
// - HOMES (`homes`) are the five tab-bar buttons: Today, Train, Horizon, Ask, You.
//   Only the shell knows about them. A view lives under one home (`viewHomes`),
//   except the Plan view, whose home depends on its section (`planHomes`): the
//   editor is Train's, the race view Horizon's, Fuel Today's and Changes Ask's.
//
// The canonical URL is `/app/<home>/<section>` (src/client/route-state.ts builds
// and parses it). Every v1 `/app/<view>/<section>` URL still parses and is
// rewritten to its v2 form in place (replaceState), so no old link breaks.
// src/client/route-state.ts mirrors this object verbatim; test/routeState.test.js
// holds the two together and pins the v1 -> v2 redirect table.
export const CLIENT_ROUTE_DEFINITIONS = {
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
    // "domain" is the one section that carries a payload: the opened marker-domain
    // key rides in ?id= (exactly as "records" carries a document id), so browser
    // Back out of a domain drill-in returns to the Health overview instead of
    // leaving it entirely.
    stand: ["records", "share", "learned", "connections", "markers", "body", "recovery", "supplements", "age", "checkup", "domain"],
    me: ["standing", "profile", "memory", "health", "life", "family"],
    health: ["read", "markers", "records", "share", "learned"],
    settings: ["sources", "automation", "data", "agents", "devices", "system"],
    horizon: ["goal"],
    // "stone" carries the stone key in ?id= (strength, endurance, fuel, ...).
    you: ["stone"],
  },
} as const;

export type ClientRouteDefinitions = typeof CLIENT_ROUTE_DEFINITIONS;
export type ClientTabName = ClientRouteDefinitions["tabs"][number];
export type ClientHomeName = ClientRouteDefinitions["homes"][number];
export type ClientPlanSection = ClientRouteDefinitions["sections"]["plan"][number];
export type ClientProgressSection = ClientRouteDefinitions["sections"]["progress"][number];
export type ClientStandSection = ClientRouteDefinitions["sections"]["stand"][number];
export type ClientMeSection = ClientRouteDefinitions["sections"]["me"][number];
export type ClientHealthSection = ClientRouteDefinitions["sections"]["health"][number];
// The old "you" Settings slice is gone: the You home's landing is that list now, and
// /app/settings/you is only a v1 URL that redirects to /app/you.
export type ClientSettingsSection = ClientRouteDefinitions["sections"]["settings"][number];
export type ClientHorizonSection = ClientRouteDefinitions["sections"]["horizon"][number];
export type ClientYouSection = ClientRouteDefinitions["sections"]["you"][number];
export type ClientRouteSection =
  | ClientPlanSection
  | ClientProgressSection
  | ClientStandSection
  | ClientMeSection
  | ClientSettingsSection
  | ClientHorizonSection
  | ClientYouSection
  // The day view's section is the home it was opened under (/app/train/day).
  | ClientHomeName;
