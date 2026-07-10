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
import { recordUnexpectedApiError, requestId } from "./diagnostics.js";

export const api = Router();

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
api.use("/chat", chatRouter);
api.use("/agent-jobs", agentJobsRouter);

api.use("/health-docs", healthDocsRouter);

// Global JSON error handler — registered LAST so any uncaught route error
// returns JSON, not Express's default HTML error page (the PWA's api() helper
// calls r.json() and would break on HTML).
export function apiErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  recordUnexpectedApiError(err, req);
  console.error(`[api] request ${requestId(req) || "unknown"} failed`);
  res.status(500).json({ error: "internal error", request_id: requestId(req) || null });
}

api.use(apiErrorHandler);
