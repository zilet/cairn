import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_SCRIPT = path.join(__dirname, "..", "scripts", "update-agent-clis.sh");
const DEFAULT_SCRIPT = "/usr/local/bin/cairn-update-agent-clis";
const MAX_TAIL = 24_000;

type UpdateStatus = "idle" | "running" | "succeeded" | "failed";

export interface AgentCliUpdateState {
  status: UpdateStatus;
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
  reason: null,
  started_at: null,
  finished_at: null,
  exit_code: null,
  error: null,
  stdout_tail: "",
  stderr_tail: "",
};

function appendTail(existing: string, chunk: Buffer): string {
  const next = existing + chunk.toString();
  return next.length > MAX_TAIL ? next.slice(next.length - MAX_TAIL) : next;
}

function updateScriptPath(): string {
  const configured = process.env.AGENT_CLI_UPDATE_SCRIPT;
  if (configured && fs.existsSync(configured)) return configured;
  if (fs.existsSync(DEFAULT_SCRIPT)) return DEFAULT_SCRIPT;
  return LOCAL_SCRIPT;
}

export function getAgentCliUpdateStatus(): AgentCliUpdateState {
  return { ...state };
}

export function startAgentCliUpdate(reason = "manual"): AgentCliUpdateState {
  if (current) return getAgentCliUpdateStatus();

  const script = updateScriptPath();
  state = {
    status: "running",
    reason,
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    error: null,
    stdout_tail: "",
    stderr_tail: "",
  };

  current = new Promise((resolve) => {
    const child = spawn(script, [], { env: process.env });

    child.stdout.on("data", (chunk) => { state.stdout_tail = appendTail(state.stdout_tail, chunk); });
    child.stderr.on("data", (chunk) => { state.stderr_tail = appendTail(state.stderr_tail, chunk); });
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
      state.finished_at = new Date().toISOString();
      current = null;
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
    startAgentCliUpdate("auto");
  };

  const initial = setTimeout(run, 10_000);
  initial.unref?.();
  const interval = setInterval(run, intervalHours * 60 * 60 * 1000);
  interval.unref?.();
}
