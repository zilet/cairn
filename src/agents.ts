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

// Scan from `start` for the FIRST complete, balanced top-level {…} object,
// respecting string literals and escapes so a `}` inside a string doesn't close
// the object early. Returns {json, lastClose} where lastClose is the index of the
// last balanced-to-zero `}` seen even if the object never fully closed (so a
// truncated reply can still be salvaged by trimming to it).
function scanBalanced(text: string, start: number): { json: string | null; lastClose: number } {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastClose = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { json: text.slice(start, i + 1), lastClose: i };
      if (depth < 0) break; // unbalanced close before any open — bail
      lastClose = i;        // a balanced inner close; remember for truncation salvage
    }
  }
  return { json: null, lastClose };
}

// Pull the FIRST complete top-level JSON object out of a CLI's stdout. Tries a
// ```json fenced block first, then a balanced-brace scan of the raw text. If no
// object ever closes (a truncated reply), salvages by trimming to the last
// balanced `}` — this recovers correct-but-cut-off responses that the old naive
// first-{…}-last-} slice silently lost.
export function extractJson(text: string): any | null {
  const candidates: string[] = [];

  // 1. Fenced block — scan inside it for a balanced object (the fence may wrap
  //    prose around the JSON, or the closing ``` may be missing on truncation).
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const body = fence[1];
    const open = body.indexOf("{");
    if (open !== -1) {
      const { json, lastClose } = scanBalanced(body, open);
      if (json) candidates.push(json);
      else if (lastClose > open) candidates.push(body.slice(open, lastClose + 1)); // truncation salvage
    }
    candidates.push(body); // last resort: the whole fenced body
  }

  // 2. Raw text — first balanced top-level object, with truncation salvage.
  const open = text.indexOf("{");
  if (open !== -1) {
    const { json, lastClose } = scanBalanced(text, open);
    if (json) candidates.push(json);
    else if (lastClose > open) candidates.push(text.slice(open, lastClose + 1)); // trim to last balanced }

    // 3. Legacy fallback: greedy first-{ … last-} slice (the rare case where the
    //    object opens inside a quoted span the scanner correctly skipped).
    const last = text.lastIndexOf("}");
    if (last > open) candidates.push(text.slice(open, last + 1));
  }

  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object") return v;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

export interface RunOpts {
  timeoutMs?: number;
}

// Interactive callers (day-read, session-suggest, chat) pass the short timeout so
// the request path never hangs on a wedged CLI; background callers (scheduler,
// review, enrichment) keep the long default. Exported so call sites name them.
export const DEFAULT_TIMEOUT_MS = 300_000;
export const INTERACTIVE_TIMEOUT_MS = 90_000;

// ---------- circuit breaker ----------
// A self-contained, in-memory, decaying failure map. An agent that just failed
// repeatedly is "open" and skipped (when another agent can be tried) or probed
// on a short leash (when it's the only option) until its failures decay. Cheap
// and process-local — it resets on restart (a fresh boot deserves a fresh chance
// at every agent). Never persisted, never surfaced to the user.
const BREAKER_THRESHOLD = 3;             // fails (within the decay window) before the breaker opens
const BREAKER_OPEN_MS = 2 * 60_000;      // skip a tripped agent for this long
const BREAKER_DECAY_MS = 5 * 60_000;     // a failure fully decays after this much quiet
const BREAKER_PROBE_TIMEOUT_MS = 20_000; // short leash when a tripped agent is the only option

interface BreakerState { fails: number; lastFailAt: number; openUntil: number; }
const breaker = new Map<string, BreakerState>();

function breakerGet(name: string): BreakerState {
  let b = breaker.get(name);
  if (!b) { b = { fails: 0, lastFailAt: 0, openUntil: 0 }; breaker.set(name, b); }
  // Decay: drop a stale failure count so a long-ago blip doesn't keep it open.
  if (b.fails > 0 && Date.now() - b.lastFailAt > BREAKER_DECAY_MS) { b.fails = 0; b.openUntil = 0; }
  return b;
}

function breakerNoteFail(name: string) {
  const b = breakerGet(name);
  b.fails++;
  b.lastFailAt = Date.now();
  if (b.fails >= BREAKER_THRESHOLD) b.openUntil = Date.now() + BREAKER_OPEN_MS;
}

function breakerNoteSuccess(name: string) {
  breaker.set(name, { fails: 0, lastFailAt: 0, openUntil: 0 });
}

// "open" = recently tripped and still inside its open window.
function breakerIsOpen(name: string): boolean {
  return breakerGet(name).openUntil > Date.now();
}

// A terse re-prompt suffix used for the one-shot JSON-repair retry: an agent that
// RAN but emitted unparseable output is re-asked once for ONLY the JSON object
// before we fall through to the next agent. Recovers chatty-but-correct models.
const JSON_REPAIR_SUFFIX =
  "\n\nYour previous reply was not a single valid JSON object. " +
  "Re-emit ONLY the JSON object, nothing else — no prose, no markdown fences.";

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

// ---------- telemetry sink ----------
// repo.ts imports agents.ts, so agents.ts can't statically import repo.ts back
// (circular). The scheduler/server registers a sink at boot; until then writes
// are dropped. The sink is wrapped so a telemetry failure NEVER escapes into the
// agent loop — one bad write must not fail a coaching run.
export interface AgentRunRecord {
  op: string;
  agent: string;
  ok: boolean;
  parsed: boolean;
  latency_ms: number;
  tried_json: boolean; // whether the one-shot JSON-repair retry was used
}
type AgentRunSink = (r: AgentRunRecord) => void;
let agentRunSink: AgentRunSink | null = null;
export function setAgentRunSink(sink: AgentRunSink | null) { agentRunSink = sink; }
function emitAgentRun(r: AgentRunRecord) {
  if (!agentRunSink) return;
  try { agentRunSink(r); } catch { /* telemetry never breaks the loop */ }
}

// Try each agent in `order` until one returns a usable (JSON-parseable) result.
// Powers "auto" agent selection: a dead login or timeout falls through to the
// next. Hardened: a circuit-broken agent is skipped while others remain (probed
// on a short leash when it's the only option left); an agent that RAN but didn't
// parse gets ONE JSON-repair retry before we move on. Every attempt is recorded
// to the telemetry sink (failure-safe). `op` labels the run for agent-stats.
export async function runAgentWithFallback(
  order: string[],
  prompt: string,
  opts: (RunOpts & { op?: string }) | number = {}
): Promise<FallbackResult> {
  if (!order.length) throw new Error("No agents enabled — turn one on in Settings.");
  // Back-compat: older call sites (enrich.ts) pass a bare timeout number.
  const o: RunOpts & { op?: string } = typeof opts === "number" ? { timeoutMs: opts } : opts;
  const baseTimeout = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const op = o.op ?? "auto";
  const tried: { agent: string; error: string }[] = [];

  // Prefer agents whose breaker is closed; tripped ones go to the back so they're
  // only probed when nothing healthier is available.
  const healthy = order.filter((n) => !breakerIsOpen(n));
  const tripped = order.filter((n) => breakerIsOpen(n));
  const sequence = [...healthy, ...tripped];

  for (let i = 0; i < sequence.length; i++) {
    const name = sequence[i];
    const isProbe = breakerIsOpen(name);
    // A tripped agent is probed only on a short leash; if healthier agents exist
    // and this one is tripped, it's already at the back of the line.
    const timeoutMs = isProbe ? Math.min(baseTimeout, BREAKER_PROBE_TIMEOUT_MS) : baseTimeout;
    const started = Date.now();
    let triedJson = false;
    try {
      let result = await runAgent(name, prompt, { timeoutMs });
      // One-shot JSON-repair retry: it ran but emitted nothing parseable.
      if (!result.parsed) {
        triedJson = true;
        try {
          result = await runAgent(name, prompt + JSON_REPAIR_SUFFIX, { timeoutMs });
        } catch { /* keep the first (unparsed) result; fall through below */ }
      }
      if (result.parsed) {
        breakerNoteSuccess(name);
        emitAgentRun({ op, agent: name, ok: true, parsed: true, latency_ms: Date.now() - started, tried_json: triedJson });
        return { agent: name, result, tried };
      }
      breakerNoteFail(name);
      emitAgentRun({ op, agent: name, ok: false, parsed: false, latency_ms: Date.now() - started, tried_json: triedJson });
      tried.push({ agent: name, error: `ran but returned no valid JSON (exit ${result.code})` });
    } catch (e: any) {
      breakerNoteFail(name);
      emitAgentRun({ op, agent: name, ok: false, parsed: false, latency_ms: Date.now() - started, tried_json: triedJson });
      tried.push({ agent: name, error: e.message });
    }
  }
  throw new Error(`All ${order.length} agent(s) failed: ${tried.map((t) => `${t.agent}: ${t.error}`).join("; ")}`);
}

export function runAgent(name: string, prompt: string, opts: RunOpts | number = {}): Promise<AgentResult> {
  // Back-compat: older call sites pass a bare timeout number.
  const timeoutMs = typeof opts === "number" ? opts : (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return runAgentImpl(name, prompt, timeoutMs);
}

function runAgentImpl(name: string, prompt: string, timeoutMs: number): Promise<AgentResult> {
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
