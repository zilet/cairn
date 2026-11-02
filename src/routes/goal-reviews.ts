// "Behind you" — the finished-goal reviews (src/repo/goal-reviews.ts,
// src/coachOps/goal-review.ts). Two reads Horizon › Season uses, and the one way to ask
// for a review now instead of waiting for the night: POST queues the durable
// `goal_review` job for a row not yet frozen, and refuses a frozen (or still-waiting)
// one with the designed {ok:false, error, tried} at 200. A single lookup is 200 + null
// on absence (the PWA's api() helper resolves to the body regardless of status).
import { Router } from "express";
import { enqueueAgentJob } from "../agentJobs.js";
import { goalReviewQueueRefusal } from "../coachOps/goal-review.js";
import { createAgentJob, listActiveAgentJobs } from "../domain/person/index.js";
import { getGoalReview, listGoalReviews } from "../repo/goal-reviews.js";

export const goalReviewsRouter = Router();

goalReviewsRouter.get("/goal-reviews", (_req, res) => {
  res.json(listGoalReviews());
});

goalReviewsRouter.get("/goal-reviews/:id", (req, res) => {
  res.json(getGoalReview(Number(req.params.id)));
});

/** Queue (or join) the one review for a row; shared with MCP review_goal. */
export function queueGoalReviewJob(
  id: number,
  agent?: string | null
): { ok: true; job: unknown } | { ok: false; error: string; tried: never[] } {
  const refusal = goalReviewQueueRefusal(id);
  if (refusal) return { ok: false, error: refusal, tried: [] };
  const live = (listActiveAgentJobs() as any[]).find(
    (job) => job?.kind === "goal_review" && Number(job?.input?.id) === Number(id)
  );
  if (live) return { ok: true, job: live };
  const job = createAgentJob({ kind: "goal_review", input: { id: Number(id) }, agent: agent ?? null }) as any;
  enqueueAgentJob(Number(job.id));
  return { ok: true, job };
}

goalReviewsRouter.post("/goal-reviews/:id/review", (req, res) => {
  const agent = req.body?.agent != null ? String(req.body.agent) : null;
  res.json(queueGoalReviewJob(Number(req.params.id), agent));
});
