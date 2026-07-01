import { z } from "zod";
import { suggestSession, weekAheadRead } from "../../coachOps.js";
import { readToday } from "../../domain/brain/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerDayCoachTools(server: McpToolRegistrar) {
  server.tool(
    "get_day_read",
    "Read what KIND of day today should be — train, easy, or rest — as a calm SUGGESTION (never a verdict, never a score). Synthesizes recent training, recovery, check-ins and life context. The agentic read writes the human sentence; if no agent is reachable it falls back to a deterministic floor. override reshapes the read ('rough night' / 'short on time' / 'I want to train anyway').",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      override: z.string().optional().describe("free-text steer, e.g. 'rough night', 'short on time', 'train anyway'"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
    },
    async ({ date, override, agent }) => asText(await readToday({ date, override, agent, recordOutcome: true }))
  );

  server.tool(
    "suggest_session",
    "Build ONE session for today on demand, honoring constraints (time budget, equipment, focus, an injury) and the day read. Returns a SUGGESTION for review — it is NOT saved or applied as the plan. ok:false is the designed failure signal when the agent returns nothing usable.",
    {
      minutes: z.number().int().optional().describe("time budget in minutes (compresses the session)"),
      equipment: z.string().optional().describe("equipment available, e.g. 'dumbbells only' / 'hotel gym'"),
      focus: z.string().optional().describe("muscle/quality focus, e.g. 'lower body'"),
      constraints: z.string().optional().describe("anything to work around, e.g. 'sore left shoulder'"),
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
    },
    async ({ minutes, equipment, focus, constraints, date, agent }) =>
      asText(await suggestSession(agent, { minutes, equipment, focus, constraints, date }))
  );

  server.tool(
    "get_week_ahead",
    "Sketch the SHAPE of the next several days — lift / run / mixed / rest — as a calm SUGGESTION to reshape, never a fixed schedule. Balances the lifting split with easy aerobic base work, honoring injuries, recovery and training health-directives. Agentic with a deterministic plan-rotation floor, so it always returns a usable shape; cached per day+plan+goal.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation") },
    async ({ agent }) => asText(await weekAheadRead(agent))
  );
}
