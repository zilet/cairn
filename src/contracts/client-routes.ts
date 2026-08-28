export const CLIENT_ROUTE_DEFINITIONS = {
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
    // "domain" is the one section that carries a payload: the opened marker-domain
    // key rides in ?id= (exactly as "records" carries a document id), so browser
    // Back out of a domain drill-in returns to the Stand overview instead of
    // leaving Stand entirely.
    stand: ["records", "share", "learned", "connections", "markers", "body", "recovery", "supplements", "age", "checkup", "domain"],
    me: ["standing", "profile", "memory", "health", "life", "family"],
    health: ["read", "markers", "records", "share", "learned"],
    settings: ["you", "agents", "system", "sources", "automation", "data"],
  },
} as const;

export type ClientRouteDefinitions = typeof CLIENT_ROUTE_DEFINITIONS;
export type ClientTabName = ClientRouteDefinitions["tabs"][number];
export type ClientPlanSection = ClientRouteDefinitions["sections"]["plan"][number];
export type ClientProgressSection = ClientRouteDefinitions["sections"]["progress"][number];
export type ClientStandSection = ClientRouteDefinitions["sections"]["stand"][number];
export type ClientMeSection = ClientRouteDefinitions["sections"]["me"][number];
export type ClientHealthSection = ClientRouteDefinitions["sections"]["health"][number];
export type ClientSettingsSection = ClientRouteDefinitions["sections"]["settings"][number];
export type ClientRouteSection =
  | ClientPlanSection
  | ClientProgressSection
  | ClientStandSection
  | ClientMeSection
  | ClientSettingsSection;
