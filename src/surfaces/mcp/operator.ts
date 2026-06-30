import { z } from "zod";
import { AGENT_JOB_KINDS } from "../../agentJobKinds.js";
import { agentInfoOp, agentModelsOp } from "../../coachOps.js";
import {
  getAgentConfig,
  getAgentStats,
  getArtStats,
  getSettings,
  listRoutableTasks,
  ROUTABLE_TASKS,
  setSettings,
} from "../../domain/operator/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

const ROUTABLE_TASK_LIST = ROUTABLE_TASKS.join(", ");
const AGENT_JOB_KIND_LIST = AGENT_JOB_KINDS.join(", ");

export function registerOperatorTools(server: McpToolRegistrar) {
  server.tool(
    "list_agents",
    "List the configured coaching agents (claude, codex, stub, ...) with their enabled state, order, whether the CLI binary is present, the tri-state login/connected probe (configured: true|false|null), installed version, and whether each declares an interactive login / a model catalog. usable rolls these up (only a KNOWN logged-out agent — configured:false — is excluded from the rotation).",
    {},
    async () => asText(getAgentConfig())
  );

  server.tool(
    "get_agent_info",
    "Read-only 'what's running' for one coaching CLI: installed version and (best-effort) the model it would use. Cheap subprocess probe — no coaching/paid call, no model pinning. ok:false for an unknown agent.",
    { name: z.string().describe("agent name from list_agents (claude, codex, grok, antigravity, ...)") },
    async ({ name }) => asText(agentInfoOp(name))
  );

  server.tool(
    "list_agent_models",
    "List the models a CLI exposes (grok/antigravity declare a catalog). Informational only — no pinning. Returns an empty list for a CLI with no catalog (claude/codex), ok:false for an unknown agent.",
    { name: z.string().describe("agent name from list_agents") },
    async ({ name }) => asText(agentModelsOp(name))
  );

  server.tool("get_settings",
    "Get app settings: agent selection strategy (round_robin/random/priority), agent order, disabled agents, per-task route metadata, the weekly auto-coach schedule, and Garmin sync status (garmin_last_sync_at/garmin_last_sync_status). Includes the merged agent list.",
    {},
    async () => asText({ settings: getSettings(), agents: getAgentConfig(), route_tasks: listRoutableTasks() }));

  server.tool("set_settings",
    "Update app settings (any subset). agent_strategy: round_robin|random|priority. agent_order / disabled_agents: arrays of agent names. agent_routes is an optional per-task agent map using the server-owned route metadata returned by get_settings. coach_enabled/coach_day(0-6)/coach_hour(0-23) control the weekly auto-draft.",
    {
      agent_strategy: z.enum(["round_robin", "random", "priority"]).optional(),
      agent_order: z.array(z.string()).optional(),
      disabled_agents: z.array(z.string()).optional(),
      agent_routes: z.record(z.string(), z.string()).optional().describe(`optional per-task agent routing: a map { task -> agent } pinning one of these tasks to a specific agent: ${ROUTABLE_TASK_LIST}. Unknown tasks or unknown/disabled agents are dropped; {} or omitted = no routing (Auto rotates as before).`),
      coach_enabled: z.boolean().optional(),
      coach_day: z.number().int().optional(),
      coach_hour: z.number().int().optional(),
      enrich_enabled: z.boolean().optional(),
      proactive_enabled: z.boolean().optional().describe("quiet proactivity on/off: nightly insight + weekly read + weekly nutrition check-in precompute (pull-never-push — only stores a waiting read, never notifies)"),
      art_enabled: z.boolean().optional().describe("generated artwork on/off (needs a Gemini key to do anything)"),
      meal_prefs: z.string().optional().describe("free-text meal/schedule preferences the meal-plan coach always sees (e.g. 'I train fasted first thing most mornings')"),
      gemini_api_key: z.string().optional().describe("optional saved Gemini key; overrides GOOGLE_AI_KEY/GEMINI_API_KEY when non-empty"),
      garmin_username: z.string().optional().describe("optional saved Garmin email; overrides GARMIN_USERNAME when non-empty"),
      garmin_password: z.string().optional().describe("optional saved Garmin password; overrides GARMIN_PASSWORD when non-empty"),
      clear_gemini_api_key: z.boolean().optional().describe("clear the saved Gemini key; env fallback still applies"),
      clear_garmin_password: z.boolean().optional().describe("clear the saved Garmin password; env fallback still applies"),
      research_enabled: z.boolean().optional().describe("host-side evidence research on/off (default OFF; off ⇒ deterministic, no network — used to ground & verify health-review citations)"),
      bg_ops_enabled: z.boolean().optional().describe(`run the heavy agentic ops as durable background jobs (default on); job kinds are: ${AGENT_JOB_KIND_LIST}; off ⇒ legacy inline blocking behavior where supported`),
    },
    async (p) => asText({ settings: setSettings(p), agents: getAgentConfig(), route_tasks: listRoutableTasks() }));

  server.tool("get_art_stats",
    "Get generated-artwork spend telemetry: estimated Gemini cost (USD) since artwork was last enabled plus all-time, images generated, generations avoided via semantic reuse (and the estimated savings), and cache size.",
    {},
    async () => asText(getArtStats()));

  server.tool("get_agent_stats",
    "Get agent-run telemetry for the coaching loop: total runs, overall ok-rate, per-agent reliability (ok/fail) + median latency, and the most recent attempts. An operator/health view of which CLI backends are working — NOT a user-facing score. Optional recent (last N attempts, default 25) and days (window the roll-up).",
    { recent: z.number().int().optional(), days: z.number().int().optional() },
    async ({ recent, days }) => asText(getAgentStats({ recent, days })));
}
