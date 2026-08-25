// The ONE source of truth for the client-telemetry route vocabulary.
//
// Browser diagnostics record only a route FAMILY (`/api/<first-segment>`) —
// never an id, never a query string. Two places consume that vocabulary: the
// browser reporter (`src/client/client-diagnostics.ts`) and the ingest
// validator (`src/repo/diagnostics.ts`). They used to keep two hand-maintained
// copies, which drifted: the client knew `training-agenda` and the server did
// not, so any batch containing it was rejected WHOLE (400) and the client shed
// unrelated queued events with it.
//
// The client build (`scripts/build-client.mjs`) transpiles each client module
// in isolation — no imports, no bundler — so the browser copy is a literal
// MIRROR of `DIAGNOSTIC_ROUTE_FAMILIES` inside `client-diagnostics.ts`, held
// identical by `test/diagnosticRouteFamilies.test.js`. Add a family HERE first,
// then mirror it there; the test fails if the two ever diverge again.

export const DIAGNOSTIC_ROUTE_FAMILIES = [
  "activities", "agent", "agent-clis", "agent-jobs", "agent-stats", "agents", "apple-health", "art",
  "blood-pressure", "body-metrics", "bodyweight", "brain", "brain-diagnostics", "calendar", "calibration",
  "cardio", "chat", "chat-images", "checkins", "coach", "coaching-focus", "context-effect",
  "context-events", "dexa-targeting", "diagnostics", "directives", "endurance-goal", "endurance-prs",
  "evidence", "exercise", "exercises", "export", "family", "food-notes", "frequent-foods", "garmin",
  "goal", "goal-checkin", "guidelines", "health", "health-docs", "health-export", "health-metrics",
  "health-report", "injury-impacts", "insights", "journey", "last-set", "learned-timeline", "learnings",
  "markers", "meal-plans", "mealplans", "memory", "muscle-load", "muscle-trajectory", "next-step",
  "nutrition", "onboard", "performance", "plan", "profile", "program", "program-state", "progress",
  "proposals", "reaction-model", "ready", "recent-training", "recovery", "research", "reset",
  "run-compliance", "run-plan", "run-zones", "search", "session-primer", "session-suggest", "sessions",
  "sets", "settings", "since-last", "stats", "strength-journey", "suggestions", "supplements",
  "symptom-links", "team-week", "telemetry", "test-week", "today", "today-agenda", "today-plan-day",
  "today-read", "training-agenda", "training-symptoms", "trajectory", "turns", "update-check",
  "update-status", "version", "volume", "week-ahead", "week-wins", "whole-person-trajectory",
] as const;

export const DIAGNOSTIC_ROUTE_FAMILY_SET: ReadonlySet<string> = new Set<string>(DIAGNOSTIC_ROUTE_FAMILIES);

/**
 * A route family NOT yet in the allowlist is still recorded, but only in a
 * hard-bounded shape: lowercase letters, digits and hyphens, at most 40 chars.
 * A brand-new endpoint is therefore never invisible in telemetry (the old
 * behavior recorded it as literally "none"), and the value can still carry no
 * id, no query, no free text.
 */
export const DIAGNOSTIC_ROUTE_SEGMENT = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `<segment>` → the recordable family name, or null when it cannot be bounded. */
export function boundedDiagnosticRouteFamily(value: unknown): string | null {
  const segment = String(value ?? "").trim().toLowerCase();
  if (DIAGNOSTIC_ROUTE_FAMILY_SET.has(segment)) return segment;
  return DIAGNOSTIC_ROUTE_SEGMENT.test(segment) ? segment : null;
}
