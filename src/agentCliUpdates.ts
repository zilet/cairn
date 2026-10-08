import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_ENV_DENYLIST, buildAgentSpawnOptions } from "./agentExecution.js";
import { commandPresent, invalidateAgentConfigured, loadAgents } from "./agents.js";
import { log } from "./log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_SCRIPT = path.join(__dirname, "..", "scripts", "update-agent-clis.sh");
const DEFAULT_SCRIPT = "/usr/local/bin/cairn-update-agent-clis";
const MAX_TAIL = 24_000;

type UpdateStatus = "idle" | "running" | "succeeded" | "failed";

/**
 * Why an install failed, as the installer itself classified it (scripts/install-agent-cli.mjs
 * prints one `CAIRN_INSTALL_FAILURE {…}` line). `reason` is the code a client branches on;
 * `message` leads with plain words and is safe to show as a headline.
 */
export type AgentCliFailureReason =
  | "disk_full"
  | "out_of_memory"
  | "not_runnable"
  | "integrity"
  | "download_failed"
  | "unsupported"
  | "failed";
export interface AgentCliFailure {
  agent: string | null;
  reason: AgentCliFailureReason;
  message: string;
  free_mb: number | null;
  need_mb: number | null;
}

/** Where a running install/remove stands, as the installer reported it (never a percentage). */
export type AgentCliPhase = "starting" | "checking_disk" | "downloading" | "verifying" | "removing";
const PHASES = new Set<string>(["checking_disk", "downloading", "verifying", "removing"]);
const PHASE_PREFIX = "CAIRN_PHASE ";

/** The installer's newest `CAIRN_PHASE <name>` stdout line; `starting` until it prints one. */
export function parseInstallPhase(stdout: string): AgentCliPhase {
  const lines = String(stdout || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith(PHASE_PREFIX)) continue;
    const name = lines[i].slice(PHASE_PREFIX.length).trim();
    if (PHASES.has(name)) return name as AgentCliPhase;
  }
  return "starting";
}

export interface AgentCliUpdateState {
  status: UpdateStatus;
  /** install / update / remove — what this run was asked to do. */
  action: "install" | "remove";
  agents: string[];
  reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error: string | null;
  failure: AgentCliFailure | null;
  /** Only while `status` is running. */
  phase: AgentCliPhase | null;
  /** Seconds since start, measured by the server's clock (null unless running). */
  elapsed_sec: number | null;
  stdout_tail: string;
  stderr_tail: string;
}

const FAILURE_PREFIX = "CAIRN_INSTALL_FAILURE ";
const FAILURE_REASONS = new Set<AgentCliFailureReason>([
  "disk_full",
  "out_of_memory",
  "not_runnable",
  "integrity",
  "download_failed",
  "unsupported",
  "failed",
]);

/** The installer's own classified failure, read from its stderr (the last one wins). */
export function parseInstallFailure(stderr: string): AgentCliFailure | null {
  const lines = String(stderr || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith(FAILURE_PREFIX));
  const last = lines.at(-1);
  if (!last) return null;
  try {
    const raw = JSON.parse(last.slice(FAILURE_PREFIX.length));
    const reason = FAILURE_REASONS.has(raw?.reason) ? (raw.reason as AgentCliFailureReason) : "failed";
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      agent: typeof raw?.agent === "string" ? raw.agent : null,
      reason,
      message: String(raw?.message || "").slice(0, 600),
      free_mb: num(raw?.free_mb),
      need_mb: num(raw?.need_mb),
    };
  } catch {
    return null;
  }
}

let current: Promise<void> | null = null;
let state: AgentCliUpdateState = {
  status: "idle",
  action: "install",
  agents: [],
  reason: null,
  started_at: null,
  finished_at: null,
  exit_code: null,
  error: null,
  failure: null,
  phase: null,
  elapsed_sec: null,
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
  const running = state.status === "running";
  const started = state.started_at ? Date.parse(state.started_at) : Number.NaN;
  return {
    ...state,
    agents: [...state.agents],
    failure: state.failure ? { ...state.failure } : null,
    phase: running ? parseInstallPhase(state.stdout_tail) : null,
    elapsed_sec: running && Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : null,
  };
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
    action: "install",
    agents,
    reason,
    started_at: now,
    finished_at: now,
    exit_code: status === "succeeded" ? 0 : null,
    error,
    failure: null,
    phase: null,
    elapsed_sec: null,
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

/** Remove one provider's CLI from the tools volume (its sign-in in HOME is kept). */
export function startAgentCliRemove(agent: string, reason = "manual"): AgentCliUpdateState {
  if (current) return getAgentCliUpdateStatus();
  const agents = normalizedAgents([agent]);
  if (!agents.length) return immediate("failed", [], reason, `Agent ${agent} is not installable.`);
  return startAgentCliUpdates(agents, reason, "remove");
}

function startAgentCliUpdates(
  requested: string[],
  reason: string,
  action: "install" | "remove" = "install"
): AgentCliUpdateState {
  if (current) return getAgentCliUpdateStatus();

  const agents = normalizedAgents(requested);
  if (!agents.length) return immediate("failed", [], reason, "No installable agent CLIs were selected.");

  const script = updateScriptPath();
  state = {
    status: "running",
    action,
    agents,
    reason,
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    error: null,
    failure: null,
    phase: null,
    elapsed_sec: null,
    stdout_tail: "",
    stderr_tail: "",
  };

  current = new Promise((resolve) => {
    const spawnOptions = buildAgentSpawnOptions({ kind: "update" });
    spawnOptions.env = {
      ...spawnOptions.env,
      CAIRN_AGENT_CLI_MANIFEST: path.join(__dirname, "..", "agents.json"),
    };
    log.info(`[agent-clis] ${action} started`, { agents, reason });
    const child = spawn(script, action === "remove" ? ["--remove", ...agents] : agents, spawnOptions);

    child.stdout.on("data", (chunk) => {
      state.stdout_tail = appendTail(state.stdout_tail, chunk);
    });
    child.stderr.on("data", (chunk) => {
      state.stderr_tail = appendTail(state.stderr_tail, chunk);
    });
    child.on("error", (err) => {
      state.status = "failed";
      state.error = err.message;
      log.warn(`[agent-clis] ${action} could not start`, { agents, error: err.message });
      state.finished_at = new Date().toISOString();
      current = null;
      resolve();
    });
    child.on("close", (code) => {
      state.status = code === 0 ? "succeeded" : "failed";
      state.exit_code = code;
      if (code !== 0) {
        state.failure = parseInstallFailure(state.stderr_tail);
        if (!state.error) {
          const tail = state.stderr_tail
            .trim()
            .split(/\r?\n/)
            .filter((line) => line && !line.startsWith(FAILURE_PREFIX))
            .at(-1);
          state.error = state.failure?.message || tail || `installer exited with status ${code}`;
        }
        // The headline reason, the disk it saw — never the CLI's own output.
        log.warn(`[agent-clis] ${action} failed`, {
          agents,
          reason: state.failure?.reason ?? "failed",
          free_mb: state.failure?.free_mb ?? null,
          need_mb: state.failure?.need_mb ?? null,
          exit_code: code,
        });
      } else {
        log.info(`[agent-clis] ${action} succeeded`, { agents });
      }
      state.finished_at = new Date().toISOString();
      current = null;
      // A successful update may have changed installed versions / model catalogs —
      // drop the cached version/model reads so the Settings cards refresh without a
      // server restart.
      // Either way the installed set may have changed (a failed install removes a CLI
      // that would not start), so drop the cached presence/version reads.
      for (const agent of agents) invalidateAgentConfigured(agent);
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
    log.info(`[agent-clis] auto-update starting; interval=${intervalHours}h`);
    startInstalledAgentCliUpdate("auto");
  };

  const initial = setTimeout(run, 10_000);
  initial.unref?.();
  const interval = setInterval(run, intervalHours * 60 * 60 * 1000);
  interval.unref?.();
}
