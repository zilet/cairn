import { z } from "zod";
import { AGENT_JOB_KINDS } from "../../agentJobKinds.js";
import { agentInfoOp, agentModelsOp } from "../../coachOps.js";
import {
  getAgentConfig,
  getAgentStats,
  getBrainDiagnostics,
  getArtStats,
  getSettings,
  listRoutableTasks,
  ROUTABLE_TASKS,
  setSettings,
} from "../../domain/operator/index.js";
import { getAgentJob, listActiveAgentJobs } from "../../domain/person/index.js";
import { cancelAgentJob } from "../../agentJobs.js";
import { asText, type McpToolRegistrar } from "./shared.js";
import { getDiagnostics } from "../../repo/diagnostics.js";
import { getAgentCliUpdateStatus, startAgentCliUpdate, startInstalledAgentCliUpdate } from "../../agentCliUpdates.js";

const ROUTABLE_TASK_LIST = ROUTABLE_TASKS.join(", ");
const AGENT_JOB_KIND_LIST = AGENT_JOB_KINDS.join(", ");

export function registerOperatorTools(server: McpToolRegistrar) {
  server.tool(
    "list_agents",
    "List coaching agents with enabled/order state, CLI presence, lazy-install availability, the tri-state login probe (configured: true|false|null), installed version, and login/model-catalog capabilities. usable rolls these up; missing or known-logged-out tools stay out of rotation.",
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

  server.tool(
    "get_agent_cli_install_status",
    "Get the current one-at-a-time coaching-CLI install/update status. Installer output is bounded and secret-redacted.",
    {},
    async () => asText(getAgentCliUpdateStatus())
  );

  server.tool(
    "install_agent_cli",
    "Install or update one supported coaching CLI into the persistent, regenerable Cairn tools volume. Package names, versions, URLs, and checksums come only from Cairn's bundled allowlist; the caller selects an agent name, never a command.",
    { agent: z.enum(["claude", "codex", "antigravity", "grok"]) },
    async ({ agent }) => asText(startAgentCliUpdate(agent, "mcp"))
  );

  server.tool(
    "update_installed_agent_clis",
    "Update only coaching CLIs already installed by this Cairn instance. Missing providers remain uninstalled.",
    {},
    async () => asText(startInstalledAgentCliUpdate("mcp"))
  );

  server.tool(
    "get_settings",
    "Get app settings: agent selection strategy (round_robin/random/priority), agent order, disabled agents, per-task route metadata, the timezone-aware weekly background-review cadence, and Garmin sync status (garmin_last_sync_at/garmin_last_sync_status). Includes the merged agent list.",
    {},
    async () => asText({ settings: getSettings(), agents: getAgentConfig(), route_tasks: listRoutableTasks() })
  );

  server.tool(
    "set_settings",
    "Update app settings (any subset). agent_strategy: round_robin|random|priority. agent_order / disabled_agents: arrays of agent names. agent_routes is an optional per-task agent map using the server-owned route metadata returned by get_settings. coach_day(0-6)/coach_hour(0-23) control the weekly background-review cadence in the last timezone reported by the PWA. coach_enabled is retained only for legacy clients; normal background coaching does not require this opt-in.",
    {
      agent_strategy: z.enum(["round_robin", "random", "priority"]).optional(),
      agent_order: z.array(z.string()).optional(),
      disabled_agents: z.array(z.string()).optional(),
      agent_routes: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          `optional per-task agent routing: a map { task -> agent } pinning one of these tasks to a specific agent: ${ROUTABLE_TASK_LIST}. Unknown tasks or unknown/disabled agents are dropped; {} or omitted = no routing (Auto rotates as before).`
        ),
      coach_enabled: z.boolean().optional().describe("legacy weekly-draft compatibility flag; normal background coaching does not require it"),
      coach_day: z.number().int().optional(),
      coach_hour: z.number().int().optional(),
      enrich_enabled: z.boolean().optional(),
      proactive_enabled: z
        .boolean()
        .optional()
        .describe(
          "quiet proactivity on/off: nightly insight + weekly read + weekly nutrition check-in precompute (pull-never-push — only stores a waiting read, never notifies)"
        ),
      art_enabled: z.boolean().optional().describe("generated artwork on/off (needs a Gemini key to do anything)"),
      meal_prefs: z
        .string()
        .optional()
        .describe(
          "free-text meal/schedule preferences the meal-plan coach always sees (e.g. 'I train fasted first thing most mornings')"
        ),
      gemini_api_key: z
        .string()
        .optional()
        .describe("optional saved Gemini key; overrides GOOGLE_AI_KEY/GEMINI_API_KEY when non-empty"),
      garmin_username: z
        .string()
        .optional()
        .describe("optional saved Garmin email; overrides GARMIN_USERNAME when non-empty"),
      garmin_password: z
        .string()
        .optional()
        .describe("optional saved Garmin password; overrides GARMIN_PASSWORD when non-empty"),
      garmin_export_strength: z
        .boolean()
        .optional()
        .describe(
          "send finished Cairn strength sessions back to Garmin as that day's exercise sets (default ON). Garmin stays the input for runs/sleep/recovery either way, and a day Garmin logged itself is never overwritten."
        ),
      clear_gemini_api_key: z.boolean().optional().describe("clear the saved Gemini key; env fallback still applies"),
      clear_garmin_password: z
        .boolean()
        .optional()
        .describe("clear the saved Garmin password; env fallback still applies"),
      research_enabled: z
        .boolean()
        .optional()
        .describe(
          "host-side evidence research on/off (default OFF; off ⇒ deterministic, no network — used to ground & verify health-review citations)"
        ),
      bg_ops_enabled: z
        .boolean()
        .optional()
        .describe(
          `legacy compatibility flag retained in settings; heavy agentic ops always use durable jobs so no user-facing request blocks. Job kinds: ${AGENT_JOB_KIND_LIST}`
        ),
    },
    async (p) => asText({ settings: setSettings(p), agents: getAgentConfig(), route_tasks: listRoutableTasks() })
  );

  server.tool(
    "get_art_stats",
    "Get generated-artwork spend telemetry: estimated Gemini cost (USD) since artwork was last enabled plus all-time, images generated, generations avoided via semantic reuse (and the estimated savings), and cache size. Also returns `health`: when art last rendered, failures in the last 7 days, the last upstream error code, and whether the circuit breaker has paused generation.",
    {},
    async () => asText(getArtStats())
  );

  server.tool(
    "get_agent_stats",
    "Get current-build agent-run telemetry for the coaching loop: build id, total runs, overall ok-rate, per-agent reliability (ok/fail) + median latency, and recent attempts. Older/unknown builds remain separate. An operator/health view — NOT a user-facing score. Optional recent and days bound the read.",
    { recent: z.number().int().optional(), days: z.number().int().optional() },
    async ({ recent, days }) => asText(getAgentStats({ recent, days }))
  );

  server.tool(
    "get_brain_diagnostics",
    "Operator-only bounded diagnostics for recent accountable decisions and sanitized coach read-tool calls. No raw prompts, secrets, files, chain-of-thought, or hidden scores.",
    { limit: z.number().int().min(1).max(100).optional() },
    async ({ limit }) => asText(getBrainDiagnostics(limit))
  );

  server.tool(
    "get_diagnostics",
    "Get bounded local diagnostics: preserved release-scoped history plus a marked current-build issue/recent/slow subset, product API/MCP throughput and approximate p50/p95 latency, separately counted internal telemetry, and storage caps. SSE lifetime is excluded. Never includes prompts, bodies, credentials, health values, or raw agent output.",
    { recent: z.number().int().min(1).max(200).optional(), days: z.number().int().min(1).max(30).optional() },
    async ({ recent, days }) => asText(getDiagnostics({ recent, days }))
  );

  server.tool(
    "list_active_agent_jobs",
    "List durable queued/running coaching jobs. Agentic MCP tools return immediately with one of these jobs instead of blocking the request.",
    {},
    async () => asText({ jobs: listActiveAgentJobs() })
  );

  server.tool(
    "get_agent_job",
    "Read one durable coaching job, including its terminal result or calm error when complete.",
    { id: z.number().int().positive() },
    async ({ id }) => asText(getAgentJob(id) ?? { error: "not found", id })
  );

  server.tool(
    "cancel_agent_job",
    "Stop a queued or running coaching job. Safe no-op after it is already terminal.",
    { id: z.number().int().positive() },
    async ({ id }) => asText(cancelAgentJob(id) ?? getAgentJob(id) ?? { error: "not found", id })
  );
}
