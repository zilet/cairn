import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { connectedBrainRouter } from "./routes/connected-brain.js";
import { dayCoachRouter } from "./routes/day-coach.js";
import { healthDocsRouter } from "./routes/health-docs.js";
import { todayRouter } from "./routes/today.js";
import { todaySideRouter } from "./routes/today-side.js";
import { chatRouter } from "./routes/chat.js";
import { agentJobsRouter } from "./routes/agent-jobs.js";
import { systemRouter } from "./routes/system.js";
import { personRouter } from "./routes/person.js";
import { artRouter } from "./routes/art.js";
import { operatorRouter } from "./routes/operator.js";
import { garminRouter } from "./routes/garmin.js";
import { exportsRouter } from "./routes/exports.js";
import { healthMetricsRouter } from "./routes/health-metrics.js";
import { nutritionRouter } from "./routes/nutrition.js";
import { planExercisesRouter } from "./routes/plan-exercises.js";
import { programRouter } from "./routes/program.js";
import { memoryLearningRouter } from "./routes/memory-learning.js";
import { personContextRouter } from "./routes/person-context.js";
import { trainingLogRouter } from "./routes/training-log.js";
import { bodyMetricsRouter } from "./routes/body-metrics.js";
import { journeyRouter } from "./routes/journey.js";
import { appleHealthRouter } from "./routes/apple-health.js";
import { diagnosticErrorName, diagnosticStackFrames, recordUnexpectedApiError, requestId } from "./diagnostics.js";
import { telemetryRequestPathLabel } from "./telemetry-privacy.js";
import { log } from "./log.js";
import { registerMountedApiRouteFamilies } from "./repo/diagnostics.js";
import { idempotencyGuard } from "./idempotency.js";
import { assertNoDuplicateApiRoutes, type ApiMount } from "./route-audit.js";

export const api = Router();

// Honor X-Idempotency-Key before any router runs, so an offline-outbox replay of a
// mutating write returns the original response instead of applying it twice. No-op
// when the header is absent (every non-outbox request).
api.use(idempotencyGuard);

// The mount table, in mount order. It is a TABLE rather than twenty api.use() calls
// so the same list can be audited: assertNoDuplicateApiRoutes below reads every
// (method, path) back off these routers and throws at module load when two of them
// claim the same endpoint — with ~20 routers mounted at "/", a path defined twice is
// silently shadowed by whichever router mounted first, and Express says nothing.
const API_MOUNTS: ApiMount[] = [
  { name: "today", prefix: "/", router: todayRouter },
  { name: "today-side", prefix: "/", router: todaySideRouter },
  { name: "day-coach", prefix: "/", router: dayCoachRouter },
  { name: "connected-brain", prefix: "/", router: connectedBrainRouter },
  { name: "system", prefix: "/", router: systemRouter },
  { name: "person", prefix: "/", router: personRouter },
  { name: "art", prefix: "/", router: artRouter },
  { name: "operator", prefix: "/", router: operatorRouter },
  { name: "garmin", prefix: "/", router: garminRouter },
  { name: "exports", prefix: "/", router: exportsRouter },
  { name: "health-metrics", prefix: "/", router: healthMetricsRouter },
  { name: "nutrition", prefix: "/", router: nutritionRouter },
  { name: "plan-exercises", prefix: "/", router: planExercisesRouter },
  { name: "program", prefix: "/", router: programRouter },
  { name: "memory-learning", prefix: "/", router: memoryLearningRouter },
  { name: "person-context", prefix: "/", router: personContextRouter },
  { name: "training-log", prefix: "/", router: trainingLogRouter },
  { name: "body-metrics", prefix: "/", router: bodyMetricsRouter },
  { name: "journey", prefix: "/", router: journeyRouter },
  { name: "apple-health", prefix: "/", router: appleHealthRouter },
  { name: "chat", prefix: "/chat", router: chatRouter },
  { name: "agent-jobs", prefix: "/agent-jobs", router: agentJobsRouter },
  { name: "health-docs", prefix: "/health-docs", router: healthDocsRouter },
];

for (const mount of API_MOUNTS) api.use(mount.prefix, mount.router);

// Boot-time contract, not a test-only nicety: a shadowed endpoint reads as live code
// and fails only in production, so this throws before the server can serve anything.
assertNoDuplicateApiRoutes(API_MOUNTS);

// The mounts that carry a PREFIX. A prefixed mount contributes exactly one route
// family — its own prefix — and Express keeps the mount path inside a closure, so it
// is the one part of the map that cannot be read back off the router.
const PREFIXED_MOUNTS = API_MOUNTS.filter((mount) => mount.prefix !== "/").map((mount) =>
  mount.prefix.replace(/^\//, "")
);

/**
 * The route families THIS build serves: the first path segment of every route the
 * root-mounted routers define, plus the prefixed mounts above.
 *
 * Why it exists: client telemetry records a route FAMILY into a durable table, and
 * the string comes from the browser. The shared allowlist covers the families the
 * client knows; this covers the ones this build actually mounts, so a brand-new
 * endpoint is visible in telemetry the day it ships while an invented segment files
 * under "unknown" instead of minting a row of its own.
 */
function mountedApiRouteFamilies(): string[] {
  const families = new Set<string>();
  const add = (value: unknown): void => {
    const segment = String(value ?? "").split("/").filter(Boolean)[0];
    if (segment && !segment.startsWith(":") && !segment.includes("*")) families.add(segment.toLowerCase());
  };
  const walkRoutes = (stack: any[]): void => {
    for (const layer of stack ?? []) {
      const paths = layer?.route?.path;
      if (paths != null) {
        for (const path of Array.isArray(paths) ? paths : [paths]) add(path);
        continue;
      }
      if (Array.isArray(layer?.handle?.stack)) walkRoutes(layer.handle.stack);
    }
  };
  // `slash` is Express's own marker for a router mounted at "/" — the routers whose
  // route paths ARE the family names. Anything else is prefixed and named above.
  for (const layer of (api as any).stack ?? []) {
    if (layer?.slash === true && Array.isArray(layer?.handle?.stack)) walkRoutes(layer.handle.stack);
  }
  // A future Express could drop `slash` and leave this empty. Registering nothing is
  // the safe degradation (the shape bound stands alone, i.e. today's behavior); the
  // route-family test is what catches it rather than a silent telemetry blind spot.
  return families.size ? [...families, ...PREFIXED_MOUNTS] : [];
}

registerMountedApiRouteFamilies(mountedApiRouteFamilies());

/**
 * A client's own malformed request, surfaced by body-parser before any route ran.
 * Express 5 + body-parser set `type` and a 4xx `status`; anything else is ours.
 * Returning 500 for these would file an operator alert for a caller's typo.
 */
function clientRequestFault(err: unknown): { status: number; message: string } | null {
  const type = (err as any)?.type;
  const status = Number((err as any)?.status ?? (err as any)?.statusCode);
  if (type === "entity.too.large") return { status: 413, message: "request body too large" };
  if (type === "entity.parse.failed") return { status: 400, message: "invalid JSON body" };
  if (type === "encoding.unsupported") return { status: 415, message: "unsupported content encoding" };
  if (Number.isFinite(status) && status >= 400 && status < 500) return { status, message: "bad request" };
  return null;
}

// Global JSON error handler — registered LAST so any uncaught route error
// returns JSON, not Express's default HTML error page (the PWA's api() helper
// calls r.json() and would break on HTML). server.ts registers it a second time
// at the app level, because body parsing runs BEFORE this router is reached and
// its errors would otherwise fall through to Express's HTML page.
export function apiErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  // Half-written response (a stream, a partially flushed body): only Express's own
  // finalhandler can close the socket correctly from here.
  if (res.headersSent) return next(err);

  const id = requestId(req) || "unknown";
  const client = clientRequestFault(err);
  if (client) {
    // Not a defect — the request-finish hook in diagnostics.ts records the 4xx.
    log.warn(`[api] request ${id} rejected (${diagnosticErrorName(err)})`, {
      method: req.method,
      path: telemetryRequestPathLabel(req.originalUrl),
      status: client.status,
    });
    res.status(client.status).json({ ok: false, error: client.message, request_id: requestId(req) || null });
    return;
  }

  recordUnexpectedApiError(err, req);
  // The raw message and the raw stack can carry athlete text, so neither is logged:
  // the error NAME plus the scrubbed frames are the operator-useful, private-safe
  // pair, and the request id ties the line to the durable diagnostic row.
  log.error(`[api] request ${id} failed (${diagnosticErrorName(err)})`, {
    method: req.method,
    path: telemetryRequestPathLabel(req.originalUrl),
    stack: diagnosticStackFrames(err) ?? undefined,
  });
  res.status(500).json({ ok: false, error: "internal error", request_id: requestId(req) || null });
}

api.use(apiErrorHandler);
