import { z } from "zod";
import { sessionPrimer } from "../../repo.js";
import { asText, type McpToolRegistrar } from "./shared.js";
import { queueMcpAgentJob } from "./background.js";

export function registerDayCoachTools(server: McpToolRegistrar) {
  server.tool(
    "get_day_read",
    "Queue a durable read of what KIND of day today should be — train, easy, or rest — as a calm suggestion. Returns a job immediately; poll get_agent_job for the final read. override reshapes it ('rough night' / 'short on time' / 'I want to train anyway').",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      override: z.string().optional().describe("free-text steer, e.g. 'rough night', 'short on time', 'train anyway'"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
    },
    async ({ date, override, agent }) => asText(queueMcpAgentJob("day_read_override", { date, override }, agent))
  );

  server.tool(
    "suggest_session",
    "Queue one session suggestion for today, honoring time, equipment, focus, injury, and the day read. Returns a job immediately; poll get_agent_job. The result is for review and is not applied as the plan.",
    {
      minutes: z.number().int().optional().describe("time budget in minutes (compresses the session)"),
      equipment: z.string().optional().describe("equipment available, e.g. 'dumbbells only' / 'hotel gym'"),
      focus: z.string().optional().describe("muscle/quality focus, e.g. 'lower body'"),
      constraints: z.string().optional().describe("anything to work around, e.g. 'sore left shoulder'"),
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
    },
    async ({ minutes, equipment, focus, constraints, date, agent }) =>
      asText(queueMcpAgentJob("session_suggest", { minutes, equipment, focus, constraints, date }, agent))
  );

  server.tool(
    "get_session_primer",
    "Read the calm, deterministic pre-session primer for a day — why today's session is what it is (from the Brief), what changed since last time, what to watch, and what's deliberately fresh. Returns immediately (no agent). null when there's nothing worth saying beyond the Brief.",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      day: z.number().int().optional().describe("explicit plan-day number to prime; omit to use the adaptive pick"),
    },
    async ({ date, day }) =>
      asText(sessionPrimer(date, { dayNumber: day != null && Number.isFinite(day) ? day : null }))
  );

  server.tool(
    "get_week_ahead",
    "Queue a calm sketch of the next several days — lift / run / mixed / rest — honoring injuries, recovery, and health directives. Returns a job immediately; poll get_agent_job. It remains a suggestion, never a fixed schedule.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation") },
    async ({ agent }) => asText(queueMcpAgentJob("week_ahead", {}, agent))
  );
}
