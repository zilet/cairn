import { z } from "zod";
import {
  acknowledgeTodayAgendaCandidate,
  learnedTimeline,
  listVisibleInsights,
  teamWeekRead,
  todayAgenda,
  updateInsight,
} from "../../domain/brain/index.js";
import { allGuidelines, guidelineFor } from "../../domain/health/index.js";
import { addMemory } from "../../domain/person/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";
import { queueMcpAgentJob } from "./background.js";

export function registerDailyDriverTools(server: McpToolRegistrar) {
  server.tool(
    "get_today_agenda",
    "The Today salience arbiter (Era 2): ONE deterministic ranking + budget pass over the whole Today surface → { hero, primary[], more[], total }, so only the 1-2 things that matter most today surface inline and the rest collapse behind 'more'. Internal priorities never cross to the user (no scores). Pass `date` (YYYY-MM-DD; defaults to today).",
    { date: z.string().optional() },
    // Read-only w.r.t. the surprise budget: an agent's tool call must never spend
    // the day's introduction allowance on a card no human saw.
    async ({ date }) => asText(todayAgenda(date, { markIntroduced: false }))
  );

  server.tool(
    "ack_today_agenda",
    "Presentation acknowledgement for a Today-agenda attention item (currently 'health-focus'): retires the current semantic revision from Today WITHOUT resolving or dismissing the underlying health directives — they keep shaping meals/training. Materially new evidence creates a new revision and may surface again. Mirrors POST /api/today-agenda/ack.",
    {
      id: z.string().describe("agenda candidate id, e.g. 'health-focus'"),
      revision: z
        .string()
        .optional()
        .describe("the revision shown to the user; omitted = acknowledge whatever is current"),
    },
    async ({ id, revision }) => asText(acknowledgeTodayAgendaCandidate(id, revision ?? null))
  );

  server.tool(
    "get_team_week",
    "The team's-week digest: a calm, deterministic read over the last 7 days of what your expert team DID (applied/announced ledger decisions, with the specialist voice when stored), what it FLAGGED for you, what it's WATCHING, how earlier calls LANDED (in words), and the connections it surfaced. Pull-only; words, never scores. Read-only here — it never drains the insight backlog (the app's weekly card does that).",
    {},
    async () => asText(teamWeekRead({ drainBacklog: false }))
  );

  server.tool(
    "get_learned_timeline",
    "A calm, pull-only read of what Cairn has understood about you and the changes it's made — load-bearing memories, outcome learnings, connected-brain directives, and applied plan changes. Newest-first, bounded. Explains, never grades; no scores.",
    { limit: z.number().int().positive().max(200).optional() },
    async ({ limit }) => asText(learnedTimeline({ limit }))
  );

  server.tool(
    "get_guidelines",
    "Trusted clinical-guideline statements (offline, recognized bodies — AHA/ACC, Endocrine Society, KDIGO…) for a marker/topic, or the whole pack. Grounds the connected brain's directive notes with a citation even with research disabled. INFORMATIONAL, not medical advice.",
    { marker: z.string().optional() },
    async ({ marker }) =>
      asText(marker && marker.trim() ? { marker, guideline: guidelineFor(marker) } : { guidelines: allGuidelines() })
  );

  server.tool(
    "list_insights",
    "List the live stream of quiet cross-domain insights (new + seen, most recent first). The Brief surfaces ONE at a time when the app is opened; dismissed insights are hidden here but remain in the DB/exports. Never pushed.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listVisibleInsights(limit ?? 20))
  );

  server.tool(
    "generate_insight",
    "Queue one durable whole-picture pass for a genuine connection or weekly read. Returns a job immediately; poll get_agent_job. A valid insight is deduped and waits in-app without a notification. Informational, not medical advice.",
    {
      kind: z
        .enum(["connection", "weekly_read"])
        .optional()
        .describe(
          "'connection' (default) = one cross-domain link; 'weekly_read' = the standing how-the-week-went read"
        ),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
    },
    async ({ kind, agent }) => asText(queueMcpAgentJob(kind === "weekly_read" ? "weekly_read" : "insight", {}, agent))
  );

  server.tool(
    "update_insight",
    "Mark an insight seen/dismissed and/or record thumbs feedback (up|down) by id. On feedback:'up' the insight text is ALSO written to memory so the relationship learns which connections land.",
    {
      id: z.number().int(),
      status: z.enum(["new", "seen", "dismissed"]).optional(),
      feedback: z.enum(["up", "down"]).optional(),
    },
    async ({ id, status, feedback }) => {
      const updated = updateInsight(id, { status, feedback }) as any;
      if (!updated) return asText({ error: "not found", id });
      if (feedback === "up") {
        const text = String(updated.text ?? "").trim();
        if (text) addMemory(text, "insight", "insight-feedback");
      }
      return asText(updated);
    }
  );
}
