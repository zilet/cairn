import { z } from "zod";
import { getGoalReview, listGoalReviews } from "../../repo/goal-reviews.js";
import { goalReviewQueueRefusal } from "../../coachOps/goal-review.js";
import { listActiveAgentJobs } from "../../domain/person/index.js";
import { queueMcpAgentJob } from "./background.js";
import { asText, type McpToolRegistrar } from "./shared.js";

// The REST twin is routes/goal-reviews.ts queueGoalReviewJob: refuse a frozen or
// still-waiting row, join a job already queued for it, else queue one.
function queueGoalReview(id: number, agent?: string | null) {
  const refusal = goalReviewQueueRefusal(id);
  if (refusal) return { ok: false as const, error: refusal, tried: [] };
  const live = (listActiveAgentJobs() as any[]).find(
    (job) => job?.kind === "goal_review" && Number(job?.input?.id) === Number(id)
  );
  if (live) return { ok: true as const, queued: true as const, job: live };
  return queueMcpAgentJob("goal_review", { id: Number(id) }, agent);
}

// "Behind you": the finished-goal reviews — mirrors GET /api/goal-reviews,
// GET /api/goal-reviews/:id and POST /api/goal-reviews/:id/review.
export function registerGoalReviewTools(server: McpToolRegistrar) {
  server.tool(
    "list_goal_reviews",
    "List every FINISHED goal (a race run, a strength objective completed, a goal weight reached), newest first: title, date, the result as a measure in the athlete's units, the status (waiting = a race still in its recovery days; pending = not yet looked back on; ready = reviewed and frozen; failed = retried on a later night) and the one line (the review's headline once written). Read-only. No grades, no comparison against the target.",
    {},
    async () => asText(listGoalReviews())
  );

  server.tool(
    "get_goal_review",
    "Read one finished goal's review in full: the frozen look-back (headline, story, lessons, carry-forward), a race build's weekly volume bars, plain fact lines, and any build levers it adopted for the next race build with their reasons and Undo decision id. Returns null when no such review exists.",
    { id: z.number().int().describe("goal review id from list_goal_reviews") },
    async ({ id }) => asText(getGoalReview(id))
  );

  server.tool(
    "review_goal",
    "Queue the one look-back for a finished goal not yet reviewed (pending or failed) instead of waiting for the nightly pass. Returns a job immediately; poll get_agent_job. A frozen review is never rewritten, and a race still in its recovery days is refused until they are done ({ok:false, error}).",
    {
      id: z.number().int().describe("goal review id from list_goal_reviews"),
      agent: z.string().optional().describe("agent name from list_agents; omit/'auto' for the rotation"),
    },
    async ({ id, agent }) => asText(queueGoalReview(id, agent))
  );
}
