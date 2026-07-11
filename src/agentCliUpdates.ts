import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_ENV_DENYLIST, buildAgentSpawnOptions } from "./agentExecution.js";
import { commandPresent, invalidateAgentConfigured, loadAgents } from "./agents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_SCRIPT = path.join(__dirname, "..", "scripts", "update-agent-clis.sh");
const DEFAULT_SCRIPT = "/usr/local/bin/cairn-update-agent-clis";
const MAX_TAIL = 24_000;

type UpdateStatus = "idle" | "running" | "succeeded" | "failed";

export interface AgentCliUpdateState {
  status: UpdateStatus;
  agents: string[];
  reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error: string | null;
  stdout_tail: string;
  stderr_tail: string;
}

let current: Promise<void> | null = null;
let state: AgentCliUpdateState = {
  status: "idle",
  agents: [],
  reason: null,
  started_at: null,
  finished_at: null,
  exit_code: null,
  error: null,
  stdout_tail: "",
  stderr_tail: "",
};

function redactSecrets(text: string): string {
  let out = text;
  for (const key of AGENT_ENV_DENYLIST) {
    const value = process.env[key];
    if (!value || value.length < 4) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
}

function appendTail(existing: string, chunk: Buffer): string {
  const next = redactSecrets(existing + chunk.toString());
  return next.length > MAX_TAIL ? next.slice(next.length - MAX_TAIL) : next;
}

function updateScriptPath(): string {
  const configured = process.env.AGENT_CLI_UPDATE_SCRIPT;
  if (configured && fs.existsSync(configured)) return path.resolve(configured);
  if (fs.existsSync(DEFAULT_SCRIPT)) return DEFAULT_SCRIPT;
  return LOCAL_SCRIPT;
}

export function getAgentCliUpdateStatus(): AgentCliUpdateState {
  return { ...state, agents: [...state.agents] };
}

export function installableAgentNames(): string[] {
  return Object.entries(loadAgents())
    .filter(([, def]) => !!def.install)
    .map(([name]) => name);
}

export function installedAgentCliNames(): string[] {
  return Object.entries(loadAgents())
    .filter(([, def]) => !!def.install && commandPresent(def.command))
    .map(([name]) => name);
}

function normalizedAgents(names: string[]): string[] {
  const allowed = new Set(installableAgentNames());
  return [...new Set(names.map((name) => String(name || "").trim()).filter((name) => allowed.has(name)))];
}

function immediate(status: UpdateStatus, agents: string[], reason: string, error: string | null): AgentCliUpdateState {
  const now = new Date().toISOString();
  state = {
    status,
    agents,
    reason,
    started_at: now,
    finished_at: now,
    exit_code: status === "succeeded" ? 0 : null,
    error,
    stdout_tail: status === "succeeded" ? "No installed agent CLIs to update.\n" : "",
    stderr_tail: "",
  };
  return getAgentCliUpdateStatus();
}

export function startAgentCliUpdate(agent: string, reason = "manual"): AgentCliUpdateState {
  if (current) return getAgentCliUpdateStatus();
  const agents = normalizedAgents([agent]);
  if (!agents.length) return immediate("failed", [], reason, `Agent ${agent} is not installable.`);
  return startAgentCliUpdates(agents, reason);
}

export function startInstalledAgentCliUpdate(reason = "manual"): AgentCliUpdateState {
  if (current) return getAgentCliUpdateStatus();
  const agents = installedAgentCliNames();
  if (!agents.length) return immediate("succeeded", [], reason, null);
  return startAgentCliUpdates(agents, reason);
}

function startAgentCliUpdates(requested: string[], reason: string): AgentCliUpdateState {
  if (current) return getAgentCliUpdateStatus();

  const agents = normalizedAgents(requested);
  if (!agents.length) return immediate("failed", [], reason, "No installable agent CLIs were selected.");

  const script = updateScriptPath();
  state = {
    status: "running",
    agents,
    reason,
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    error: null,
    stdout_tail: "",
    stderr_tail: "",
  };

  current = new Promise((resolve) => {
    const spawnOptions = buildAgentSpawnOptions({ kind: "update" });
    spawnOptions.env = {
      ...spawnOptions.env,
      CAIRN_AGENT_CLI_MANIFEST: path.join(__dirname, "..", "agents.json"),
    };
    const child = spawn(script, agents, spawnOptions);

    child.stdout.on("data", (chunk) => {
      state.stdout_tail = appendTail(state.stdout_tail, chunk);
    });
    child.stderr.on("data", (chunk) => {
      state.stderr_tail = appendTail(state.stderr_tail, chunk);
    });
    child.on("error", (err) => {
      state.status = "failed";
      state.error = err.message;
      state.finished_at = new Date().toISOString();
      current = null;
      resolve();
    });
    child.on("close", (code) => {
      state.status = code === 0 ? "succeeded" : "failed";
      state.exit_code = code;
      if (code !== 0 && !state.error) {
        const tail = state.stderr_tail.trim().split(/\r?\n/).filter(Boolean).at(-1);
        state.error = tail || `installer exited with status ${code}`;
      }
      state.finished_at = new Date().toISOString();
      current = null;
      // A successful update may have changed installed versions / model catalogs —
      // drop the cached version/model reads so the Settings cards refresh without a
      // server restart.
      if (code === 0) {
        for (const agent of agents) invalidateAgentConfigured(agent);
      }
      resolve();
    });
  });

  current.catch(() => {});
  return getAgentCliUpdateStatus();
}

export function maybeScheduleAgentCliAutoUpdate() {
  if (!["1", "true", "yes"].includes(String(process.env.AGENT_CLI_AUTO_UPDATE || "").toLowerCase())) return;

  const intervalHours = Math.max(1, Number(process.env.AGENT_CLI_AUTO_UPDATE_INTERVAL_HOURS || 168));
  const run = () => {
    console.log(`[agent-clis] auto-update starting; interval=${intervalHours}h`);
    startInstalledAgentCliUpdate("auto");
  };

  const initial = setTimeout(run, 10_000);
  initial.unref?.();
  const interval = setInterval(run, intervalHours * 60 * 60 * 1000);
  interval.unref?.();
}
