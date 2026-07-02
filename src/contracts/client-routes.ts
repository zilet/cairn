export const CLIENT_ROUTE_DEFINITIONS = {
  appBasePath: "/app",
  defaults: {
    tab: "today",
    planSection: "edit",
    meSection: "standing",
    healthSection: "read",
    settingsSection: "agents",
  },
  tabs: ["today", "session", "plan", "progress", "chat", "me", "settings"],
  sections: {
    plan: ["edit", "endurance", "food", "meals", "coach"],
    progress: ["trend", "volume", "endurance", "weight", "measurements", "calendar", "sessions", "program", "energy"],
    me: ["standing", "profile", "memory", "health", "life", "family"],
    health: ["read", "markers", "records", "share", "learned"],
    settings: ["agents", "sources", "automation", "data"],
  },
} as const;

export type ClientRouteDefinitions = typeof CLIENT_ROUTE_DEFINITIONS;
export type ClientTabName = ClientRouteDefinitions["tabs"][number];
export type ClientPlanSection = ClientRouteDefinitions["sections"]["plan"][number];
export type ClientProgressSection = ClientRouteDefinitions["sections"]["progress"][number];
export type ClientMeSection = ClientRouteDefinitions["sections"]["me"][number];
export type ClientHealthSection = ClientRouteDefinitions["sections"]["health"][number];
export type ClientSettingsSection = ClientRouteDefinitions["sections"]["settings"][number];
export type ClientRouteSection =
  | ClientPlanSection
  | ClientProgressSection
  | ClientMeSection
  | ClientSettingsSection;
