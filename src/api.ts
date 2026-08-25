import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { connectedBrainRouter } from "./routes/connected-brain.js";
import { dayCoachRouter } from "./routes/day-coach.js";
import { healthDocsRouter } from "./routes/health-docs.js";
import { todayRouter } from "./routes/today.js";
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
import { diagnosticErrorName, recordUnexpectedApiError, requestId } from "./diagnostics.js";
import { registerMountedApiRouteFamilies } from "./repo/diagnostics.js";
import { idempotencyGuard } from "./idempotency.js";

export const api = Router();

// Honor X-Idempotency-Key before any router runs, so an offline-outbox replay of a
// mutating write returns the original response instead of applying it twice. No-op
// when the header is absent (every non-outbox request).
api.use(idempotencyGuard);

api.use("/", todayRouter);
api.use("/", dayCoachRouter);
api.use("/", connectedBrainRouter);
api.use("/", systemRouter);
api.use("/", personRouter);
api.use("/", artRouter);
api.use("/", operatorRouter);
api.use("/", garminRouter);
api.use("/", exportsRouter);
api.use("/", healthMetricsRouter);
api.use("/", nutritionRouter);
api.use("/", planExercisesRouter);
api.use("/", programRouter);
api.use("/", memoryLearningRouter);
api.use("/", personContextRouter);
api.use("/", trainingLogRouter);
api.use("/", bodyMetricsRouter);
api.use("/", journeyRouter);
api.use("/", appleHealthRouter);
api.use("/chat", chatRouter);
api.use("/agent-jobs", agentJobsRouter);

api.use("/health-docs", healthDocsRouter);

// The three mounts above that carry a PREFIX. A prefixed mount contributes exactly
// one route family — its own prefix — and Express keeps the mount path inside a
// closure, so it is the one part of the map that cannot be read back off the router.
const PREFIXED_MOUNTS = ["chat", "agent-jobs", "health-docs"];

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

// Global JSON error handler — registered LAST so any uncaught route error
// returns JSON, not Express's default HTML error page (the PWA's api() helper
// calls r.json() and would break on HTML).
export function apiErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  recordUnexpectedApiError(err, req);
  console.error(`[api] request ${requestId(req) || "unknown"} failed (${diagnosticErrorName(err)})`);
  res.status(500).json({ error: "internal error", request_id: requestId(req) || null });
}

api.use(apiErrorHandler);
