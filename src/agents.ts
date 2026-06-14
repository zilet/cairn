import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.AGENTS_CONFIG || path.join(__dirname, "..", "agents.json");

// Agent CLIs run with the data dir as cwd so headless runs can read uploaded
// files (chat photos, health docs) without a permission grant: claude -p
// auto-denies reads outside its working directory, and in Docker uploads live
// in /data while the app runs from /app.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");

export interface AgentDef {
  command: string;
  args: string[];                 // "{prompt}" is substituted with the full prompt
  input?: "arg" | "stdin";        // how the prompt reaches the CLI (default: arg)
  description?: string;
  env_required?: string[];        // env vars that indicate this agent is usable
}

export function loadAgents(): Record<string, AgentDef> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function listAgents() {
  return Object.entries(loadAgents()).map(([name, def]) => ({
    name,
    description: def.description || "",
    env_required: def.env_required || [],
    // usable if no env requirement (subscription/cred-based) OR the env var is present
    env_ok: !def.env_required?.length || def.env_required.every((k) => !!process.env[k]),
  }));
}

export function extractJson(text: string): any | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* next */
    }
  }
  return null;
}

export interface AgentResult {
  code: number | null;
  raw: string;
  stderr: string;
  parsed: any | null;
}

export interface FallbackResult {
  agent: string;          // the agent that actually produced the output
  result: AgentResult;
  tried: { agent: string; error: string }[]; // agents attempted before this one that failed
}

// Try each agent in `order` until one returns a usable (JSON-parseable) result.
// Powers "auto" agent selection: a dead login or timeout falls through to the next.
export async function runAgentWithFallback(
  order: string[],
  prompt: string,
  timeoutMs = 300000
): Promise<FallbackResult> {
  if (!order.length) throw new Error("No agents enabled — turn one on in Settings.");
  const tried: { agent: string; error: string }[] = [];
  for (const name of order) {
    try {
      const result = await runAgent(name, prompt, timeoutMs);
      if (result.parsed) return { agent: name, result, tried };
      tried.push({ agent: name, error: `ran but returned no valid JSON (exit ${result.code})` });
    } catch (e: any) {
      tried.push({ agent: name, error: e.message });
    }
  }
  throw new Error(`All ${order.length} agent(s) failed: ${tried.map((t) => `${t.agent}: ${t.error}`).join("; ")}`);
}

export function runAgent(name: string, prompt: string, timeoutMs = 300000): Promise<AgentResult> {
  const def = loadAgents()[name];
  if (!def) return Promise.reject(new Error(`Unknown agent "${name}"`));

  const useStdin = def.input === "stdin";
  const args = def.args.map((a) => (useStdin ? a : a.replaceAll("{prompt}", prompt)));

  // Cap accumulated output so a runaway/verbose CLI can't balloon RSS on a small
  // host (e.g. the Pi), especially during a multi-job enrichment queue drain.
  const MAX_OUT = 4 * 1024 * 1024; // 4 MB — far beyond any real JSON proposal.

  return new Promise((resolve, reject) => {
    const child = spawn(def.command, args, {
      env: process.env,
      cwd: fs.existsSync(DATA_DIR) ? DATA_DIR : undefined,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent "${name}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => { if (out.length < MAX_OUT) out += d.toString(); });
    child.stderr.on("data", (d) => { if (err.length < MAX_OUT) err += d.toString(); });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to launch "${def.command}": ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, raw: out, stderr: err, parsed: extractJson(out) });
    });

    if (useStdin) child.stdin.write(prompt);
    child.stdin.end();
  });
}
