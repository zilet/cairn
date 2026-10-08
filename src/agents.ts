import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { agentCliPath, agentDataDir, buildAgentSpawnOptions, promptReferencesDataDir } from "./agentExecution.js";
import type { JsonSchema } from "./json-schema.js";
import { telemetryModelName } from "./telemetry-privacy.js";
import { ensureAntigravityHeadlessPermissions } from "./antigravityPermissions.js";
import {
  availabilityHolds,
  availabilityReason,
  classifyAgentFailure,
  resourceFailure,
  type AgentAvailabilityState,
  type AgentFailure,
} from "./agentAvailability.js";
import { AgentBusyError, isAgentBusyError } from "./agent-busy.js";
import { log } from "./log.js";
import { resetContractRejection, takeContractRejection } from "./contractRejection.js";
import { bumpAgentStateGeneration } from "./repo/agent-state-generation.js";
import { failureTail, structuredErrorText } from "./agentFailureTail.js";
import { clearRefusedPins, noteRefusedPin, pinsAfterRefusals, type PinField } from "./agentModelPins.js";
export { AGENT_ENV_DENYLIST, agentCliPath, agentExecutionCwd, buildAgentSpawnOptions, promptReferencesDataDir, sanitizeAgentEnv } from "./agentExecution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolved per call, not captured at import: the manifest path is an override knob,
// and binding it to module-load order makes it depend on which module imported this
// one first (a test that points AGENTS_CONFIG at a fixture would silently get the
// bundled manifest). Production sets it before boot either way.
function configPath(): string {
  return process.env.AGENTS_CONFIG || path.join(__dirname, "..", "agents.json");
}

// Opt-in stderr surfacing. By default a failed/unparseable agent run is quiet —
// the loop just falls through to the next agent — which hides the actual cause
// (e.g. "claude: not logged in") from a self-hoster. Set CAIRN_DEBUG (or DEBUG)
// to print the captured stderr so the first-run failure is diagnosable. Truncated
// so a verbose CLI can't flood the log.
const AGENT_DEBUG = !!(process.env.CAIRN_DEBUG || process.env.DEBUG);
function debugAgentStderr(name: string, code: number | null, stderr: string) {
  if (!AGENT_DEBUG) return;
  const s = (stderr || "").trim();
  if (!s) return;
  log.error(`[agent:${name}] exit ${code} stderr:\n${s.slice(0, 4000)}`);
}

export type ReasoningLevel = "low" | "medium" | "high" | "xhigh" | "max";

// Cairn's provider-NEUTRAL model classes. An operation asks for a class ("this is
// cheap structuring" vs "this is the hard read"). By default a class names NO model:
// every CLI runs on whatever model its account's plan gives it. Only when the person
// binds a class to a model for a provider (settings.model_class_bindings, Settings ->
// Agents "Everyday" / "Deep work") does that provider get a --model for it. Nothing
// in src/ names a concrete model, so an Anthropic alias never reaches another CLI.
export const MODEL_CLASSES = ["fast", "deep"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

export interface AgentCapabilities {
  /** This CLI accepts a per-run model pin through model_flag. */
  model?: boolean;
  /** Provider-supported reasoning levels, ordered from least to most effort. */
  reasoning?: ReasoningLevel[];
  /** The offline stub intentionally ignores execution profiles for smoke tests. */
  execution_profile_noop?: boolean;
}

/**
 * Declarative enforced-structured-output support. Cairn's JSON contract is otherwise
 * only REQUESTED in prose and RECOVERED by scraping stdout (extractJson); a CLI that
 * declares this can be made to emit conforming JSON by construction instead.
 *
 * Purely config: which providers have it, under which flag, and in which argument
 * form all live in agents.json, so gaining or losing the feature is a config edit.
 * A provider that declares nothing silently keeps the prose-contract path.
 */
export interface AgentStructuredOutput {
  /** Flag template expanded at the {schema_args} slot; carries {schema} or {schema_file}. */
  flag: string[];
  /** "inline" substitutes the serialized schema; "file" writes a temp file and substitutes its path. */
  arg: "inline" | "file";
  /**
   * Set when enabling the flag also changes the CLI's stdout into a JSON ENVELOPE
   * around the payload (grok's --json-schema implies --output-format json). Without
   * this, the first `{` on stdout is the envelope, and the operation would receive a
   * telemetry object instead of its contract.
   */
  envelope?: { structured_key: string; text_key?: string };
}

/**
 * A provider-neutral execution request: what KIND of model and how much effort.
 * Resolved against one agent's declared capabilities by resolveAgentProfileForClass.
 */
export interface AbstractExecutionProfile {
  model_class?: ModelClass;
  reasoning?: ReasoningLevel;
  /** A raw provider model name (user override) — wins over model_class when set. */
  model?: string;
}

export interface AgentDef {
  command: string;
  args: string[];                 // "{prompt}" is substituted with the full prompt
  input?: "arg" | "stdin";        // how the prompt reaches the CLI (default: arg)
  description?: string;
  // Plain first-run copy for the provider tile: the name a person knows it by and the
  // plan they already pay for. Display only — a definition without them is still a
  // working agent, just not offered as a provider tile (the offline stub).
  label?: string;
  plan?: string;
  env_required?: string[];        // env vars that indicate this agent is usable
  web_access?: boolean;           // declares this CLI can browse the live web (drives research routing)
  // Declarative login / connected-state fields (Agent Connect). Every argv array is
  // APPENDED to `command` (like `args`). None of these change how a coaching run is
  // built — they drive the login flow, the connected-state probe, and read-only
  // model visibility only. `command`/`args`/`input`/`stream` stay exactly as before.
  login?: string[] | null;        // argv to start the interactive login flow (run by the PTY bridge, Stream A)
  status_check?: string[] | null; // argv for a non-interactive login probe; its STDOUT is parsed (NEVER the exit code) — see agentConfigured
  auth_state?: string[] | null; // HOME-relative FILES only a completed login writes — the fallback "logged in" evidence when the status probe cannot answer
  models_list?: string[] | null; // argv that prints the available models (grok/agy); null ⇒ no model catalog
  model_flag?: string[] | null; // ["--model","{model}"] — expanded only at an explicit {model_args} slot
  // The curated model ALIASES Settings offers for this provider's class bindings, e.g.
  // ["sonnet","opus"]. Offered, never applied: with nothing chosen the CLI keeps its own
  // default. Aliases only, never dated ids, so a new generation ships without a code
  // change. A CLI that also declares `models_list` offers its live catalog first.
  model_choices?: string[];
  // How `models_list` prints its catalog: one model per line (default) or codex's JSON
  // ({models:[{slug, visibility}]}).
  models_format?: "lines" | "codex_json";
  capabilities?: AgentCapabilities;
  // Enforced structured output, expanded only at an explicit {schema_args} slot and
  // only when the caller supplied RunOpts.schema. Absent ⇒ this CLI can't enforce a
  // schema, and the run degrades to the prose contract + extractJson.
  structured_output?: AgentStructuredOutput | null;
  reasoning_flag?: string[] | null; // e.g. ["--effort","{reasoning}"] at {reasoning_args}
  // Optional headless token-streaming. When present, the chat path can run the CLI
  // in its NDJSON streaming mode (separate args) and render the reply live. `format`
  // selects the per-CLI event adapter (see streamDelta). Absent → one-shot only.
  stream?: { format: "claude" | "grok"; args: string[] };
  // Args expanded only when a prompt references DATA_DIR (uploads / extracted
  // health docs). This keeps normal chats isolated while giving file-aware CLIs
  // explicit read access to the uploaded file tree.
  file_access_args?: string[];
  // Args repeated for every uploaded image path found in a DATA_DIR prompt.
  // Codex supports `--image <file>`, which is more reliable than asking it to
  // discover a JPEG through shell tools inside its own sandbox.
  image_args?: string[];
  // How an oversized prompt is delivered so it never lands in argv. Linux
  // MAX_ARG_STRLEN is 32 * PAGE_SIZE (512 KiB on a 16K-page Pi 5, 128 KiB on
  // 4K-page hosts). Small prompts still inline at `{prompt}`.
  //   stdin       — omit `{prompt}`, keep a boolean `-p`/`--print`, write stdin (claude)
  //   stdin_plain — omit `{prompt}` and its value-taking `-p`, write stdin (agy)
  //   stdin_dash  — replace `{prompt}` with `-`, write stdin (codex)
  //   file        — omit `{prompt}` and its value-taking `-p`, pass `args` with `{prompt_file}` (grok)
  large_prompt?: {
    via: "stdin" | "stdin_plain" | "stdin_dash" | "file";
    args?: string[];
  };
  // Optional, server-owned lazy-install contract. The browser can select only an
  // agent name; package names, versions, URLs and checksums always come from this
  // bundled manifest. Installed files live under the persistent app HOME.
  install?:
    | { method: "npm"; package: string; version: string; args?: string[] }
    | { method: "script"; url: string; sha256: string; update_args?: string[] }
    | {
        // Versioned vendor builds pinned per host (`linux-x64`, `darwin-arm64`, …), with
        // the vendor's own installer `script` as the fallback for a pruned/unpinned build.
        // Validated and run by scripts/install-agent-cli.mjs.
        method: "binary";
        version: string;
        artifacts: Record<string, { url: string; sha256?: string; sha512?: string; archive?: "none" | "gz" | "tar.gz"; entry?: string }>;
        script?: string;
        update_args?: string[];
      };
}

export function loadAgents(): Record<string, AgentDef> {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

export function listAgents() {
  return Object.entries(loadAgents()).map(([name, def]) => ({
    name,
    description: def.description || "",
    label: typeof def.label === "string" && def.label.trim() ? def.label.trim() : null,
    plan: typeof def.plan === "string" && def.plan.trim() ? def.plan.trim() : null,
    env_required: def.env_required || [],
    // whether this CLI declares live web access (drives web-capable-first research routing)
    web_access: def.web_access === true,
    // usable if no env requirement (subscription/cred-based) OR the env var is present
    env_ok: !def.env_required?.length || def.env_required.every((k) => !!process.env[k]),
    // whether the agent's CLI binary is actually installed/on PATH (cached probe)
    present: commandPresent(def.command),
    // tri-state login/connected probe (true logged-in / false logged-out / null
    // undetectable). Only `false` excludes from the rotation — see agentConfigured.
    configured: agentConfigured(name),
    // provider usage buckets read by the status probe (agy's /quota today); [] elsewhere
    quota: agentQuota(name),
    // whether this agent declares an interactive login flow / a model catalog —
    // pure config reads, surfaced so the UI can render the right affordances.
    can_login: def.login != null,
    models_list: def.models_list != null,
    // The curated aliases offered for this provider's Everyday / Deep work model.
    model_choices: agentModelChoices(def),
    capabilities: normalizedAgentCapabilities(def),
    installable: !!def.install,
    install_method: def.install?.method ?? null,
    install_version: def.install?.method === "npm" ? def.install.version : null,
  }));
}

// ---------- CLI-presence probe (the #1 first-run guard) ----------
// A fresh install with no coaching CLI installed must NOT serve fake coaching.
// `pickAgentOrder()` filters to agents whose binary is actually present, so an
// agent that can't even spawn is never tried (which would otherwise look like a
// "failed run" rather than "not configured"). The probe is a `<cmd> --version`
// spawn — succeeds (any exit code) if the binary launched, fails with ENOENT if
// it isn't on PATH — falling back to a PATH/absolute-path lookup. It is cached
// PER COMMAND for the lifetime of the process (a restart re-probes), so a normal
// request never pays for it; only the first lookup of each distinct command does.
const presenceCache = new Map<string, boolean>();

function lookupOnPath(cmd: string, sourceEnv: NodeJS.ProcessEnv = process.env): boolean {
  // Absolute / relative path → just stat it.
  if (cmd.includes("/")) {
    try { return fs.existsSync(cmd); } catch { return false; }
  }
  const PATH = agentCliPath(sourceEnv);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { if (fs.existsSync(path.join(dir, cmd + ext))) return true; } catch { /* keep scanning */ }
    }
  }
  return false;
}

export function commandPresent(cmd: string): boolean {
  if (!cmd) return false;
  const cached = presenceCache.get(cmd);
  if (cached !== undefined) return cached;
  let present = false;
  try {
    // A quick `--version` spawn: ENOENT (no such binary) surfaces as r.error,
    // any actual launch (even a non-zero exit) means the binary exists. 4s is
    // ample for a CLI version print; a wedge just reports "not present" (safe).
    const r = spawnSync(cmd, ["--version"], {
      ...buildAgentSpawnOptions({ kind: "probe" }),
      stdio: "ignore",
      timeout: 4000,
    });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      // ENOENT = not installed. A timeout/other error → fall back to a PATH scan
      // rather than wrongly declaring a slow-but-present binary absent.
      present = code === "ENOENT" ? false : lookupOnPath(cmd);
    } else {
      present = true;
    }
  } catch {
    present = lookupOnPath(cmd);
  }
  presenceCache.set(cmd, present);
  bumpAgentStateGeneration();
  return present;
}

// ---------- connected-state probe (rotation eligibility) ----------
// An installed-but-not-logged-in CLI must NOT enter the auto-rotation: it would
// only fail and look like a "broken run" instead of "not connected". This probe
// returns a TRI-STATE — true (logged in) / false (logged out) / null (can't tell)
// — and the usability filter excludes ONLY `false`, never `null` (a working agent
// must never be false-negatived out of the rotation).
//
// CRITICAL: the CLIs exit 0 whether logged in or out, so we NEVER trust the exit
// code — we parse STDOUT per each CLI's signal. Cached per process like the
// presence probe (a restart re-probes); a normal request never pays for it.
const configuredCache = new Map<string, boolean | null>();

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

// Fallback evidence when the status probe cannot answer: any of the agent's
// HOME-relative auth_state files exists. Each must be something only a completed
// login writes (claude's ~/.claude/.credentials.json, codex's ~/.codex/auth.json) —
// never a config dir or file any run of the CLI creates, the probe itself included.
function authStatePresent(def: AgentDef): boolean {
  const home = homeDir();
  if (!home || !Array.isArray(def.auth_state) || !def.auth_state.length) return false;
  return def.auth_state.some((rel) => {
    try { return fs.existsSync(path.join(home, rel)); } catch { return false; }
  });
}

// Interpret a status_check's STDOUT into the tri-state. Per-CLI, verified against
// the live image (exit code is unreliable for all of them — parse stdout):
//   - claude  `auth status`  → JSON with { loggedIn: bool }
//   - codex   `login status` → "Not logged in" when logged out, else a logged-in banner
// A shape we don't recognize / a parse failure ⇒ null (undetectable, don't exclude).
export function parseStatusOutput(name: string, stdout: string): boolean | null {
  const s = (stdout || "").trim();
  if (!s) return null;
  if (name === "claude") {
    try {
      const v = JSON.parse(s);
      if (v && typeof v.loggedIn === "boolean") return v.loggedIn;
    } catch { /* not JSON — fall through to the generic heuristic */ }
    // Tolerate a non-JSON banner: an explicit "not logged in" reads as false.
    if (/not logged in/i.test(s)) return false;
    return null;
  }
  if (name === "codex") {
    if (/not logged in/i.test(s)) return false;
    // Require a POSITIVE logged-in signal ("Logged in using ChatGPT", an account /
    // email banner). An error or unknown banner must fall through to null
    // (undetectable) — never be misread as logged-in, which would keep a broken
    // agent in the rotation. ("not logged in" is matched first, above.)
    if (/logged in|account|email/i.test(s)) return true;
    return null;
  }
  if (name === "antigravity") {
    // `agy -p /quota --output-format json` (verified on 1.1.24): a print-mode slash
    // command answered locally by the CLI — no agent turn, no quota spent — whose
    // envelope carries the usage buckets. Buckets present ⇒ the account is signed in.
    if (parseAgyQuota(s).length) return true;
    if (/not (logged|signed) in|sign in|log in|unauthenticated|authentication/i.test(s)) return false;
    return null;
  }
  if (name === "grok") {
    // grok 1.0.46 (verified 2026-10-07, and live on a Railway container): signed OUT,
    // `grok models` exits 0 and prints "You are not authenticated." ABOVE the default
    // model and "Available models:" — so the refusal is read first, as a definite no.
    if (/not authenticated|not (logged|signed) in/i.test(s)) return false;
    if (/available models|you are using xai_api_key/i.test(s)) return true;
    return null;
  }
  // Generic fallback for any future status_check: an explicit "not logged in".
  if (/not logged in|logged out|please (log|sign) in/i.test(s)) return false;
  return null;
}

/** One provider usage bucket as agy reports it — group + window + how much is left. */
export interface AgentQuotaBucket {
  group: string;
  window: "weekly" | "5h" | string;
  remaining_fraction: number;
  reset_time: string | null;
}

/**
 * Read agy's `/quota` print-mode envelope into flat buckets. Tolerant by design: the
 * shape was verified live on 1.1.24 ({command:{name:"usage",data:{groups:[{name,
 * buckets:[{window,remaining_fraction,reset_time}]}]}}}); anything else yields [].
 */
export function parseAgyQuota(stdout: string): AgentQuotaBucket[] {
  const text = (stdout || "").trim();
  const start = text.indexOf("{");
  if (start === -1) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return [];
  }
  const groups = parsed?.command?.data?.groups;
  if (!Array.isArray(groups)) return [];
  const out: AgentQuotaBucket[] = [];
  for (const g of groups) {
    const buckets = Array.isArray(g?.buckets) ? g.buckets : [];
    for (const b of buckets) {
      const fraction = Number(b?.remaining_fraction);
      if (!Number.isFinite(fraction)) continue;
      out.push({
        group: String(g?.name ?? ""),
        window: String(b?.window ?? ""),
        remaining_fraction: Math.max(0, Math.min(1, fraction)),
        reset_time: typeof b?.reset_time === "string" ? b.reset_time : null,
      });
    }
  }
  return out;
}

// The last quota read a status probe produced, per agent — surfaced on the Settings
// card so "Connected" can also say how much of the week is left. Refreshed with the
// login verdict (same cache lifetime, same invalidation).
const quotaCache = new Map<string, AgentQuotaBucket[]>();

export function agentQuota(name: string): AgentQuotaBucket[] {
  return quotaCache.get(name) ?? [];
}

// How long one status probe may take. A cold `claude`/`codex` launch on a small
// container (first run after a deploy, a 512 MB Railway box) routinely takes longer
// than the 5 s this used to allow, and a timed-out probe used to read as "can't tell"
// — which every surface then treated as signed in.
export const STATUS_PROBE_TIMEOUT_MS = 20_000;
// A probe that TIMED OUT is not an answer: its null is remembered only this long, so
// a later read asks again instead of believing "can't tell" until the next restart.
const STATUS_PROBE_TIMEOUT_RETRY_MS = 5 * 60_000;

// An agent may declare a shorter leash (agents.json `status_timeout_ms`): agy signed
// out answers "Authentication required" within a second and then WAITS 60s for a
// pasted code, so its probe is cut short and read as the no it already printed —
// rather than blocking the boot probe for the full 20 s.
function statusProbeTimeoutMs(def: AgentDef): number {
  const own = Number((def as { status_timeout_ms?: unknown }).status_timeout_ms);
  return Number.isFinite(own) && own >= 1000 ? Math.min(own, STATUS_PROBE_TIMEOUT_MS) : STATUS_PROBE_TIMEOUT_MS;
}

// One log line per agent per CHANGE of login verdict (not per read), so `railway logs`
// shows when a provider flipped signed in / out / unreadable without flooding.
const loggedVerdict = new Map<string, string>();
function logConfiguredVerdict(name: string, verdict: boolean | null, timedOut: boolean): void {
  const key = `${verdict}:${timedOut}`;
  if (loggedVerdict.get(name) === key) return;
  loggedVerdict.set(name, key);
  const fields = { agent: name, signed_in: verdict, timed_out: timedOut };
  if (verdict === false) log.warn("[agents] login status: signed out", fields);
  else log.info(`[agents] login status: ${verdict === true ? "signed in" : "unreadable"}`, fields);
}
const configuredRetryAt = new Map<string, number>();

export type StatusProbeRun = {
  error?: (Error & { code?: string }) | undefined;
  stdout?: string | null;
  stderr?: string | null;
};

function probeTimedOut(r: StatusProbeRun): boolean {
  const code = r.error?.code;
  return code === "ETIMEDOUT" || /timed? ?out/i.test(String(r.error?.message ?? ""));
}

// Read one finished status_check run into the tri-state (null: it could not be read).
export function readStatusProbe(name: string, r: StatusProbeRun): boolean | null {
  if (r.error) {
    // A spawn error (ENOENT) tells us nothing. A KILLED probe (timeout) may already
    // have said "signed out": agy 1.3.1 signed out prints "Authentication required.
    // Please visit the URL…" at once and then waits 60s for a pasted code. Only that
    // NO is taken from a partial run — a cut-off "yes" is never trusted.
    const partial = `${r.stdout || ""}\n${r.stderr || ""}`;
    if (!partial.trim()) return null;
    return parseStatusOutput(name, partial) === false ? false : null;
  }
  // claude emits its JSON on stdout — parse THAT alone first so a stderr notice
  // (update banner, deprecation warning) can't corrupt the JSON parse. Fall back
  // to the combined stream only for the plain-text heuristics.
  let verdict = parseStatusOutput(name, r.stdout || "");
  if (verdict === null) verdict = parseStatusOutput(name, (r.stdout || "") + "\n" + (r.stderr || ""));
  const quota = parseAgyQuota(r.stdout || "");
  if (quota.length) quotaCache.set(name, quota);
  else quotaCache.delete(name);
  return verdict;
}

// The verdict when the status probe itself could not answer: grok's env key, then the
// agent's auth_state evidence. Absence is null (NOT false — many CLIs create their
// config dir before login, so absence is only weak evidence and never excludes).
function fallbackConfigured(name: string, def: AgentDef): boolean | null {
  // grok has no status command. The HEADLESS path needs XAI_API_KEY; the in-app
  // `grok login --device-auth` flow instead writes ~/.grok/auth.json. So an env key is
  // a definite yes, but its absence is NOT a no — the auth_state check below lets a
  // Connect login flip Installed → Connected.
  if (name === "grok" && process.env.XAI_API_KEY) return true;
  // auth_state names files only a completed login writes (never a dir any run of the
  // CLI creates — the status probe itself would satisfy that).
  if (authStatePresent(def)) return true;
  return null;
}

function probeConfigured(name: string, def: AgentDef): { verdict: boolean | null; timedOut: boolean } {
  let timedOut = false;
  // 1. A status_check is the strongest signal — run it and parse stdout.
  if (Array.isArray(def.status_check) && def.status_check.length) {
    // Don't even spawn if the binary isn't installed (and don't false-negative —
    // an absent binary is "present:false" territory, not "logged out").
    if (!commandPresent(def.command)) return { verdict: null, timedOut: false };
    try {
      const r = spawnSync(def.command, def.status_check, {
        ...buildAgentSpawnOptions({ kind: "status", restoreEnvKeys: def.env_required || [] }),
        timeout: statusProbeTimeoutMs(def),
        encoding: "utf8",
      });
      timedOut = probeTimedOut(r as StatusProbeRun);
      const verdict = readStatusProbe(name, r as StatusProbeRun);
      if (verdict !== null) return { verdict, timedOut: false };
      // status_check ran but we couldn't read it — fall through to the evidence.
    } catch { /* fall through to the fallback signals */ }
  }
  return { verdict: fallbackConfigured(name, def), timedOut };
}

// Public tri-state: true logged-in / false logged-out / null undetectable.
export function agentConfigured(name: string): boolean | null {
  const retryAt = configuredRetryAt.get(name);
  if (retryAt !== undefined && Date.now() >= retryAt) {
    configuredRetryAt.delete(name);
    configuredCache.delete(name);
  }
  if (configuredCache.has(name)) return configuredCache.get(name) ?? null;
  const def = loadAgents()[name];
  let verdict: boolean | null = null;
  if (def) {
    try {
      const probe = probeConfigured(name, def);
      verdict = probe.verdict;
      if (probe.timedOut && verdict === null) {
        log.warn("[agents] login status probe timed out; will ask again", {
          agent: name,
          timeout_ms: STATUS_PROBE_TIMEOUT_MS,
        });
        configuredRetryAt.set(name, Date.now() + STATUS_PROBE_TIMEOUT_RETRY_MS);
      }
    } catch { verdict = null; }
  }
  configuredCache.set(name, verdict);
  bumpAgentStateGeneration();
  logConfiguredVerdict(name, verdict, configuredRetryAt.has(name));
  return verdict;
}

/**
 * Re-ask one agent's login state NOW, off the event loop (an async spawn, not the
 * boot-time spawnSync), and remember the answer. A failed run whose own words were not
 * recognisable asks this to tell "signed out" from every other failure.
 */
export function reprobeAgentConfigured(name: string): Promise<boolean | null> {
  const def = loadAgents()[name];
  if (!def) return Promise.resolve(null);
  const remember = (verdict: boolean | null, timedOut = false): boolean | null => {
    configuredRetryAt.delete(name);
    configuredCache.set(name, verdict);
    bumpAgentStateGeneration();
    logConfiguredVerdict(name, verdict, timedOut);
    return verdict;
  };
  if (!Array.isArray(def.status_check) || !def.status_check.length || !commandPresent(def.command)) {
    return Promise.resolve(remember(fallbackConfigured(name, def)));
  }
  return new Promise((resolve) => {
    try {
      execFile(
        def.command,
        def.status_check as string[],
        {
          ...buildAgentSpawnOptions({ kind: "status", restoreEnvKeys: def.env_required || [] }),
          timeout: statusProbeTimeoutMs(def),
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          // execFile reports a non-zero exit as an error too; the exit code is never the
          // signal (see above), so only a spawn failure or a kill counts as "no answer".
          const spawnFailed = !!error && (typeof (error as any).code === "string" || !!(error as any).killed);
          const run: StatusProbeRun = { error: spawnFailed ? (error as any) : undefined, stdout, stderr };
          const verdict = readStatusProbe(name, run);
          resolve(remember(verdict !== null ? verdict : fallbackConfigured(name, def), !!(error as any)?.killed));
        }
      );
    } catch {
      resolve(remember(fallbackConfigured(name, def)));
    }
  });
}

/** A real round trip through this agent just answered: that is a positive sign-in. */
export function recordAgentAnswered(name: string): void {
  configuredRetryAt.delete(name);
  configuredCache.set(name, true);
  bumpAgentStateGeneration();
}

// Drop the cached login verdict AND the derived version/model read-caches, so the
// next probe re-reads everything. Called after an in-app login completes (the
// boot-time probe ran before the auth state existed — without this the card stays
// "Installed" until restart) and after a CLI update (so a new version / model list
// shows without a restart).
export function invalidateAgentConfigured(name?: string): void {
  bumpAgentStateGeneration();
  _codexModel = undefined; // codex model is read from ~/.codex/config.toml
  // A completed login is exactly the event a persisted auth hold was waiting for
  // — drop it here rather than making the person wait out the re-probe leash.
  for (const agent of name ? [name] : Object.keys(loadAgents())) availabilityClear(agent);
  // A new login or CLI may mean a new plan or a newer alias table: re-try refused pins.
  clearRefusedPins(name);
  // A catalog read in flight was taken from the CLI as it was before this change.
  modelsEpoch++;
  if (name) {
    configuredCache.delete(name);
    configuredRetryAt.delete(name);
    quotaCache.delete(name);
    modelsRawCache.delete(name);
    modelsCache.delete(name);
    const cmd = loadAgents()[name]?.command;
    if (cmd) {
      presenceCache.delete(cmd);
      versionCache.delete(cmd);
    }
  } else {
    presenceCache.clear();
    configuredCache.clear();
    configuredRetryAt.clear();
    quotaCache.clear();
    modelsRawCache.clear();
    modelsCache.clear();
    versionCache.clear();
  }
}

// Fill the per-process probe caches (presence, login verdict, version) at boot
// rather than inside whichever request first asks for the agent rotation. Each
// probe is a `--version`-class spawn; lazily they all landed together on the
// first `GET /today-read` after a restart, so the first Brief after every deploy
// waited on four CLI launches (seconds on a Pi). Nothing about the caches or the
// probes changes — only WHEN they fill; every one stays available on demand, and
// `invalidateAgentConfigured` still forces a re-probe after a login or an update.
// One PROBE per macrotask, not one agent: presence, login and version are three separate
// `spawnSync` calls, and running an agent's three inside one tick put three synchronous
// CLI launches in a single macrotask — on a Pi that is seconds of blocked event loop,
// which is exactly what a warm-up must not do. Split onto their own ticks, no macrotask
// holds more than one spawn. Entirely best-effort: a failed probe just leaves that cache
// cold for the lazy path to fill exactly as it did before.
export function warmAgentProbes(): void {
  // The one read OUTSIDE the per-agent try, and the boot path runs it inside
  // app.listen — so an agents.json that parses to null (or fails to parse at all)
  // took the whole server down over a warm-up that is best-effort by design. No
  // agents to warm is a cold cache, exactly what the lazy path already handles.
  let names: string[] = [];
  try {
    names = Object.keys(loadAgents() ?? {});
  } catch {
    return;
  }
  // One probe per macrotask: presence, login and version each spawn a process,
  // and three spawnSyncs in one tick blocked the event loop for over a second
  // on a Pi right after the server started listening.
  const probes: Array<() => void> = [];
  for (const name of names) {
    probes.push(() => {
      const cmd = loadAgents()[name]?.command;
      if (cmd) commandPresent(cmd);
    });
    probes.push(() => agentConfigured(name));
    probes.push(() => agentVersion(name));
  }
  const step = (index: number): void => {
    if (index >= probes.length) return;
    try {
      probes[index]();
    } catch {
      /* best effort */
    }
    setImmediate(() => step(index + 1));
  };
  setImmediate(() => step(0));
}

// ---------- version / model visibility (read-only) ----------
// A cheap `<cmd> --version`, cached per command like the presence probe. Strips
// the print to the first clean version-looking token so a chatty banner doesn't
// leak into the UI. null when the binary isn't present or prints nothing usable.
const versionCache = new Map<string, string | null>();

function cleanVersion(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  // Prefer a semver-ish token (e.g. "1.2.3", "0.2.54", "2.38.1") anywhere in the
  // first line; else the first whitespace-trimmed line, capped so a verbose banner
  // can't flood the card.
  const firstLine = s.split(/\r?\n/)[0].trim();
  const m = firstLine.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
  if (m) return m[0];
  return firstLine.slice(0, 60) || null;
}

export function agentVersion(name: string): string | null {
  const def = loadAgents()[name];
  if (!def) return null;
  const cmd = def.command;
  if (versionCache.has(cmd)) return versionCache.get(cmd) ?? null;
  let version: string | null = null;
  if (commandPresent(cmd)) {
    try {
      const r = spawnSync(cmd, ["--version"], {
        ...buildAgentSpawnOptions({ kind: "version", restoreEnvKeys: def.env_required || [] }),
        timeout: 5000,
        encoding: "utf8",
      });
      if (!r.error) version = cleanVersion((r.stdout || "") + (r.stderr || ""));
    } catch { version = null; }
  }
  versionCache.set(cmd, version);
  return version;
}

// Best-effort "what's running" probe for the Settings info line. `version` is
// reliable; `model_current` is BEST-EFFORT (no cheap universal signal exists yet
// — null is acceptable and the UI degrades to "—"); `update_available` is left
// null for now (no per-CLI registry lookup this batch).
export function agentInfo(name: string): { version: string | null; model_current: string | null; update_available: boolean | null } {
  return {
    version: agentVersion(name),
    model_current: agentModelCurrent(name),
    update_available: null,
  };
}

// Best-effort current default model. There's no cheap universal way to read the
// model a CLI would use on the next run without making a (possibly paid) call, so
// this is intentionally conservative: only return something when a CLI exposes it
// for free, else null (the UI shows "—"). Never makes a coaching/paid call.
function agentModelCurrent(name: string): string | null {
  // codex's catalog (JSON) names no default, but its CURRENT model is pinned in
  // ~/.codex/config.toml (`model = "…"`) — a free, local, read-only lookup (never a
  // coaching/paid call). null when unpinned ⇒ the UI shows "—".
  if (name === "codex") return readCodexConfigModel();
  // The catalog listing exposes the default for free: `grok models` (and similarly
  // `agy models`) prints a "Default model: <id>" line above the catalog. Read THAT —
  // never a coaching/paid call. null when no such line exists ⇒ the UI shows "—".
  return parseDefaultModel(rawModelsOutput(name));
}

// Read codex's pinned model from ~/.codex/config.toml. codex's catalog JSON carries
// no "default" marker, so this config read is its only free, non-interactive current-
// model signal. Cached per process; null when the file or key is absent.
let _codexModel: string | null | undefined;
function readCodexConfigModel(): string | null {
  if (_codexModel !== undefined) return _codexModel;
  _codexModel = null;
  try {
    const home = homeDir();
    if (home) _codexModel = parseTomlModel(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"));
  } catch {
    _codexModel = null;
  }
  return _codexModel;
}

// Pure: pull the ROOT-table `model = "…"` out of a TOML string. Stops at the first
// [section] header so a nested `model` key (e.g. [tui.model_availability_nux]) can't
// match, and the `model\s*=` anchor skips `model_reasoning_effort`. null when absent.
export function parseTomlModel(raw: string): string | null {
  if (!raw) return null;
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (line.startsWith("[")) break; // entered a sub-table — root `model` only
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^model\s*=\s*(.+)$/);
    if (m) {
      const v = m[1].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "").trim();
      if (v && v.length <= 80) return v;
    }
  }
  return null;
}

// Pure: pull the "Default model: <id>" / "Current model: <id>" line out of a
// `models` listing (grok/agy print it above the catalog). null when absent.
export function parseDefaultModel(raw: string): string | null {
  if (!raw) return null;
  for (const lineRaw of raw.split(/\r?\n/)) {
    const m = lineRaw.trim().match(/^(?:default|current)\s+model\s*[:=]?\s*(.+)$/i);
    if (m) {
      const v = m[1].trim().replace(/\s*\((?:current|default)\)\s*$/i, "").trim();
      if (v && v.length <= 80) return v;
    }
  }
  return null;
}

// Run a CLI's `models_list` command ONCE and cache its raw stdout+stderr, so the
// catalog (listAgentModels) and the "Default model:" read (agentModelCurrent) share
// a single spawn. "" when the CLI has no catalog / isn't present / fails.
const modelsRawCache = new Map<string, string>();

function rawModelsOutput(name: string): string {
  const def = loadAgents()[name];
  if (!def || !Array.isArray(def.models_list) || !def.models_list.length) return "";
  if (modelsRawCache.has(name)) return modelsRawCache.get(name) ?? "";
  let raw = "";
  if (commandPresent(def.command)) {
    try {
      const r = spawnSync(def.command, def.models_list, {
        ...buildAgentSpawnOptions({ kind: "models", restoreEnvKeys: def.env_required || [] }),
        timeout: 8000,
        encoding: "utf8",
        // codex's JSON catalog runs ~650 KB, close to spawnSync's 1 MB default.
        maxBuffer: 16 * 1024 * 1024,
      });
      if (!r.error) raw = `${r.stdout || ""}\n${r.stderr || ""}`;
    } catch { raw = ""; }
  }
  modelsRawCache.set(name, raw);
  return raw;
}

// Read a CLI's model catalog (grok/agy/codex declare `models_list`). Returns a clean
// string[], or [] for a CLI with no catalog / on any failure. It feeds the Settings ->
// Agents model dropdowns (ahead of the curated `model_choices`), so a CLI release that
// adds a model shows up without a Cairn change; invalidateAgentConfigured drops it on
// every install / update / remove / sign-in.
const modelsCache = new Map<string, string[]>();

export function listAgentModels(name: string): string[] {
  const def = loadAgents()[name];
  if (!def || !Array.isArray(def.models_list) || !def.models_list.length) return [];
  if (modelsCache.has(name)) return modelsCache.get(name) ?? [];
  const models = parseModelsOutput(rawModelsOutput(name), def.models_format);
  modelsCache.set(name, models);
  return models;
}

// The same catalog read WITHOUT blocking the event loop: the Settings model dropdowns
// fetch it on every first visit, and a spawnSync there would stall every request for
// up to the probe's 8s. Shares the caches above; concurrent callers share one spawn,
// and a read that was in flight when the CLI changed (invalidateAgentConfigured) is
// returned to its caller but never cached.
const modelsInflight = new Map<string, Promise<string>>();
let modelsEpoch = 0;

function rawModelsOutputAsync(name: string): Promise<string> {
  const def = loadAgents()[name];
  if (!def || !Array.isArray(def.models_list) || !def.models_list.length) return Promise.resolve("");
  if (modelsRawCache.has(name)) return Promise.resolve(modelsRawCache.get(name) ?? "");
  const pending = modelsInflight.get(name);
  if (pending) return pending;
  const epoch = modelsEpoch;
  const run = new Promise<string>((resolve) => {
    if (!commandPresent(def.command)) return resolve("");
    try {
      execFile(
        def.command,
        def.models_list as string[],
        {
          ...buildAgentSpawnOptions({ kind: "models", restoreEnvKeys: def.env_required || [] }),
          timeout: 8000,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          // Same reading as the sync probe: only a spawn failure or a kill is "no catalog";
          // a non-zero exit still printed whatever it printed.
          const spawnFailed = !!error && (typeof (error as any).code === "string" || !!(error as any).killed);
          resolve(spawnFailed ? "" : `${stdout || ""}\n${stderr || ""}`);
        }
      );
    } catch {
      resolve("");
    }
  }).then((raw) => {
    modelsInflight.delete(name);
    if (epoch === modelsEpoch) modelsRawCache.set(name, raw);
    return raw;
  });
  modelsInflight.set(name, run);
  return run;
}

/** listAgentModels without blocking: what the REST/MCP catalog endpoints serve. */
export async function listAgentModelsAsync(name: string): Promise<string[]> {
  const def = loadAgents()[name];
  if (!def || !Array.isArray(def.models_list) || !def.models_list.length) return [];
  if (modelsCache.has(name)) return modelsCache.get(name) ?? [];
  const epoch = modelsEpoch;
  const models = parseModelsOutput(await rawModelsOutputAsync(name), def.models_format);
  if (epoch === modelsEpoch) modelsCache.set(name, models);
  return models;
}

/** The catalog already read this process, WITHOUT spawning anything; null when not read yet. */
export function cachedAgentModels(name: string): string[] | null {
  return modelsCache.get(name) ?? null;
}

/** The curated aliases agents.json offers for a provider's class bindings (cleaned, capped). */
export function agentModelChoices(def: AgentDef | undefined): string[] {
  if (!def || !Array.isArray(def.model_choices)) return [];
  const out: string[] = [];
  for (const raw of def.model_choices) {
    const v = typeof raw === "string" ? raw.trim() : "";
    if (v && v.length <= 80 && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 20);
}

// codex prints its catalog as one JSON object: {models:[{slug, visibility, …}]}. Only
// listed (visibility != "hide") slugs are offered; [] when no such object is found.
function parseCodexModelsJson(raw: string): string[] {
  const start = (raw || "").indexOf("{");
  if (start < 0) return [];
  const { json } = scanBalanced(raw, start);
  if (!json) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const m of Array.isArray(parsed?.models) ? parsed.models : []) {
    const slug = typeof m?.slug === "string" ? m.slug.trim() : "";
    if (!slug || slug.length > 80 || m?.visibility === "hide" || out.includes(slug)) continue;
    out.push(slug);
    if (out.length >= 50) break;
  }
  return out;
}

// Parse a `models` listing into clean entries. CLIs print one model per line
// (sometimes with a leading bullet/marker, a trailing " (current)" note, or a
// status/banner line first); keep the model entries, drop empties/headers/banners
// and the log noise a CLI writes to stderr (glog "I1008 08:21:36…" lines, ANSI-coloured
// tracing, "ERROR:"/"WARNING:" lines). Conservative + capped. The entries are only
// ever OFFERED in Settings, so a stray banner line is cosmetic, not load-bearing.
export function parseModelsOutput(raw: string, format: AgentDef["models_format"] = "lines"): string[] {
  if (format === "codex_json") return parseCodexModelsJson(raw);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const lineRaw of (raw || "").split(/\r?\n/)) {
    let line = lineRaw.trim();
    if (!line) continue;
    // Log noise, never a model: ANSI escapes, glog-style records, error/warning lines.
    if (line.includes("\u001b[")) continue;
    if (/^[IWEF]\d{4} \d{2}:\d{2}:\d{2}/.test(line)) continue;
    if (/^(error|warning|warn|fatal|panic)\b[:\s]/i.test(line)) continue;
    // Drop a common leading list marker ("- ", "* ", "• ", "› ", "→ ").
    line = line.replace(/^[-*•›→]\s+/, "").trim();
    // Skip obvious header / status / banner noise (the grok/agy listings prepend a
    // "You are logged in…" / "Default model: …" line before the catalog).
    if (/^(available models|models?:|usage:|select|choose|default model|current model|you are (logged|signed) in)\b/i.test(line)) continue;
    // A prose sentence (ends with a period, has interior spaces) is a banner, not a
    // model id — model ids don't end in a period.
    if (/[.!?]$/.test(line) && /\s/.test(line)) continue;
    // Take the first column as the model entry (keep a friendly label intact, e.g.
    // "Gemini 3.5 Flash (Medium)"; only split on a 2+-space / tab column gutter).
    const token = line.split(/\s{2,}|\t/)[0].trim().replace(/\s*\((?:current|default)\)\s*$/i, "").trim();
    if (!token || token.length > 80) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 50) break;
  }
  return out;
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

// CLIs leak C0 controls and a UTF-8 BOM onto stdout (progress spinners, a Windows
// pipe). JSON.parse rejects unescaped C0 even BETWEEN tokens, so a perfectly good
// payload after a spinner dies as invalid_json. Tabs/LF/CR stay — they are JSON
// whitespace. Characters inside strings that needed to be escaped were already
// invalid JSON, so stripping them cannot accept bad JSON, only find good JSON.
function normalizeAgentStdout(text: string): string {
  let s = String(text ?? "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    out += s[i];
  }
  return out;
}

// A JSON object is `{` + ws + (`"` of the first key, or `}` of `{}`). `{kind}` or
// `{1800-2000}` in narration is a complete brace span that JSON.parse rejects;
// treating it as "the" object blanked the real payload that followed.
function indexOfPlausibleObjectStart(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) return -1;
    let j = open + 1;
    while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) j++;
    const ch = text[j];
    if (ch === '"' || ch === "}") return open;
    i = open + 1;
  }
  return -1;
}

function collectFencedBodies(text: string): string[] {
  const bodies: string[] = [];
  const re = /```(?:json[a-z]*)?[ \t]*\r?\n?([\s\S]*?)```/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    bodies.push(m[1]);
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  const unclosed = tail.match(/```(?:json[a-z]*)?[ \t]*\r?\n?([\s\S]*)$/i);
  if (unclosed) bodies.push(unclosed[1]);
  return bodies;
}

function pushObjectCandidates(candidates: string[], text: string): void {
  let from = 0;
  let firstPlausible = -1;
  while (from < text.length) {
    const open = indexOfPlausibleObjectStart(text, from);
    if (open === -1) break;
    if (firstPlausible === -1) firstPlausible = open;
    const { json, lastClose } = scanBalanced(text, open);
    if (json) {
      candidates.push(json);
      from = open + json.length;
    } else {
      // Truncated / never closed. Salvage is a last-ditch parse of THIS span, not
      // a license to return a nested inner object as the payload.
      if (lastClose > open) candidates.push(text.slice(open, lastClose + 1));
      break;
    }
  }
  if (firstPlausible !== -1) {
    const last = text.lastIndexOf("}");
    if (last > firstPlausible) candidates.push(text.slice(firstPlausible, last + 1));
  }
}

function parseJsonObject(candidate: string): any | null {
  try {
    const v = JSON.parse(candidate);
    if (v && typeof v === "object") return v;
  } catch {
    /* not JSON */
  }
  return null;
}

// Pull the FIRST complete top-level JSON object out of a CLI's stdout. Tries
// fenced ```json blocks first (closed, then an unclosed opener — truncation
// often eats the closing fence), then a balanced-brace scan of the raw text
// that SKIPS narration braces (`{kind}`, `{1800-2000}`) rather than anchoring
// on them. If no object ever closes, salvages by trimming to the last balanced
// `}`. Never "repairs" invalid JSON (trailing commas, unquoted keys).
export function extractJson(text: string): any | null {
  const normalized = normalizeAgentStdout(text);
  const candidates: string[] = [];

  for (const body of collectFencedBodies(normalized)) {
    pushObjectCandidates(candidates, body);
    if (body.trim()) candidates.push(body);
  }
  pushObjectCandidates(candidates, normalized);

  for (const c of candidates) {
    const v = parseJsonObject(c);
    if (v) return v;
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function firstTokenCount(obj: any, keys: string[]): number | null {
  for (const key of keys) {
    const n = numberOrNull(obj?.[key]);
    if (n != null) return n;
  }
  return null;
}

function usageEnvelope(obj: any): { usage: any; model: unknown } | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  // Only provider/CLI protocol envelopes are telemetry. A coaching result is
  // arbitrary business JSON and root fields such as model/input_tokens may be
  // user-authored domain data, even when they happen to look provider-shaped.
  if (obj.type === "result" && typeof obj.subtype === "string" && obj.usage && typeof obj.usage === "object")
    return { usage: obj.usage, model: obj.model ?? obj.usage.model };
  if (obj.type === "message_start" && obj.message && typeof obj.message === "object")
    return { usage: obj.message.usage, model: obj.message.model };
  if (obj.type === "message_delta" && obj.usage && typeof obj.usage === "object")
    return { usage: obj.usage, model: obj.model ?? obj.usage.model };
  if (obj.type === "turn.completed" && obj.usage && typeof obj.usage === "object")
    return { usage: obj.usage, model: obj.model ?? obj.usage.model };
  if (obj.type === "response.completed" && obj.response && typeof obj.response === "object")
    return { usage: obj.response.usage, model: obj.response.model };
  if (obj.type === "usage" && obj.data && typeof obj.data === "object")
    return { usage: obj.data, model: obj.data.model };
  return null;
}

function usageFromObject(obj: any): AgentUsage {
  const envelope = usageEnvelope(obj);
  if (!envelope?.usage || typeof envelope.usage !== "object") return {};
  const usage = envelope.usage;
  const input = firstTokenCount(usage, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
    "promptTokenCount",
    "inputTokenCount",
  ]);
  const output = firstTokenCount(usage, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "candidatesTokenCount",
    "outputTokenCount",
  ]);
  const model = telemetryModelName(envelope.model) ?? telemetryModelName(usage.model) ?? telemetryModelName(usage.model_name);
  return { model, input_tokens: input, output_tokens: output };
}

function mergeUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    model: a.model ?? b.model ?? null,
    input_tokens: a.input_tokens ?? b.input_tokens ?? null,
    output_tokens: a.output_tokens ?? b.output_tokens ?? null,
  };
}

export function extractAgentUsage(text: string): AgentUsage {
  let usage: AgentUsage = {};
  const parsed = extractJson(text);
  if (parsed) usage = mergeUsage(usage, usageFromObject(parsed));
  for (const line of String(text || "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{") || !s.endsWith("}")) continue;
    try {
      usage = mergeUsage(usage, usageFromObject(JSON.parse(s)));
    } catch {
      /* ignore non-JSON lines */
    }
  }
  return usage;
}

export interface RunOpts {
  timeoutMs?: number;
  signal?: AbortSignal;   // abort to kill the live subprocess mid-run (chat-turn Stop)
  // What the CLI's OWN tools are for on this run. "none" (the default) prepends
  // NO_TOOLS_PREAMBLE so an autonomous CLI answers from the prompt instead of
  // exploring its cwd; "provider" leaves the prompt alone for the one op that needs
  // live tools (cited web research). A prompt that hands the CLI uploaded files is
  // always left alone — see applyToolPolicy.
  tools?: "none" | "provider";
  // Custom JSON extractor applied to the CLI's stdout instead of the default
  // extractJson. Needed by the prose-first (reply-marked) op contracts: their prose
  // may legitimately contain a stray `{`, which anchors extractJson's first-brace
  // scan on a non-JSON span and blanks the parse — the marker-aware extractor
  // (prompt/shared.ts extractMarkedJson) slices past the markers first. Threaded as
  // an option because prompt/shared.ts imports from THIS module (a direct import
  // here would be a cycle).
  extract?: (text: string) => any | null;
  // Optional operation-level acceptance check. Parsing JSON is only the syntax
  // boundary; callers such as the Today Brief also have a semantic contract
  // (kind/why/etc.). When supplied, a parseable response that fails this check
  // gets one contract-repair retry and then falls through to the next agent.
  acceptParsed?: (parsed: any) => boolean;
  // Capability-scoped CLI arguments supplied by the caller for this run only
  // (for example Claude's --mcp-config pointing at the loopback read-only coach
  // adapter). Expanded only at an explicit {mcp_config_args} slot.
  mcpConfigArgs?: string[];
  /** Optional per-run model pin. Only agents with a {model_args} slot consume it. */
  model?: string;
  /** Provider-neutral reasoning effort; a level above the provider's max maps down. */
  reasoning?: ReasoningLevel;
  // Lazily resolves this run's execution profile FOR THE AGENT ACTUALLY CHOSEN, so a
  // rotation can hand each provider its own model name. Consulted per field: an
  // explicit `model`/`reasoning` above always wins, and a resolver that returns
  // nothing leaves the CLI on its own defaults. Threaded as a callback because the
  // policy lives in repo/settings.ts, which imports THIS module (a direct import
  // here would be a cycle).
  profile?: AgentProfileResolver;
  // The operation's JSON contract as a JSON Schema. Handed to any agent that DECLARES
  // structured_output so its output conforms by construction; silently ignored by one
  // that doesn't, which keeps the rotation's mixed-capability fallback working. Supply
  // the same object the op's acceptance predicate checks (src/agent-contracts.ts) —
  // never a second hand-written description of the shape.
  schema?: JsonSchema;
  // Who is waiting on this run, for the spawn cap below. "interactive" means a person
  // is sitting in front of the surface this answers (a chat turn, an athlete's own new
  // read): it jumps the spawn queue ahead of background work and may use the one permit
  // reserved above the cap. Defaults to "background" — batch lanes (jobs, enrichment,
  // the scheduler's warms) must never claim the reserved permit.
  priority?: AgentPriority;
  // A short label for WHICH operation/lane this run serves (e.g. "day_read",
  // "chat:coach"). Only ever a log field — it names the failing op in the one warn
  // line a failed attempt writes; it never changes how the CLI runs.
  op?: string;
}

/** Whether a person is waiting on this run. See the spawn cap below. */
export type AgentPriority = "interactive" | "background";

export type AgentProfileResolver = (agent: string) => { model?: string; reasoning?: ReasoningLevel } | null | undefined;

/** Whether this agent can have a JSON contract ENFORCED rather than merely requested. */
export function agentSupportsStructuredOutput(name: string, def?: AgentDef): boolean {
  return !!resolveStructuredOutput(def ?? loadAgents()[name]);
}

/**
 * The usable structured-output declaration for an agent, or null. Deliberately strict:
 * a half-written declaration degrades to the prose contract instead of producing an
 * argv with an unsubstituted placeholder in it.
 */
function resolveStructuredOutput(def: AgentDef | undefined): AgentStructuredOutput | null {
  const declared = def?.structured_output;
  if (!declared || !Array.isArray(declared.flag) || !declared.flag.length) return null;
  if (declared.arg !== "inline" && declared.arg !== "file") return null;
  return declared;
}

/**
 * Unwrap a CLI that answers with an envelope AROUND the schema-conforming payload.
 * Prefers the declared structured field, then re-parses the declared text field (which
 * carries the same payload as a string). Returns null rather than the envelope itself:
 * handing the operation a telemetry object would read as a contract miss with no
 * repair, whereas null is the ordinary "no valid JSON" signal the ladder already
 * recovers from.
 */
function looksLikeStructuredEnvelope(
  rec: Record<string, unknown>,
  envelope: NonNullable<AgentStructuredOutput["envelope"]>
): boolean {
  if (envelope.structured_key in rec) return true;
  // grok: {text, thought, usage, structuredOutput}; agy: conversation_id + status + duration_seconds.
  // An insight payload also has a `text` field, so text_key alone is NOT an envelope signal.
  if ("thought" in rec && "usage" in rec) return true;
  if ("conversation_id" in rec && "status" in rec && "duration_seconds" in rec) return true;
  return false;
}

function unwrapStructuredEnvelope(parsed: unknown, envelope: NonNullable<AgentStructuredOutput["envelope"]>): any | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const direct = rec[envelope.structured_key];
  if (direct && typeof direct === "object") return direct;
  if (typeof direct === "string") {
    const inner = extractJson(direct);
    if (inner && typeof inner === "object") return inner;
  }
  const textKey = envelope.text_key;
  const text = textKey ? rec[textKey] : undefined;
  if (typeof text === "string") {
    const inner = extractJson(text);
    if (inner && typeof inner === "object") return inner;
  }
  // The flag was placed but the CLI still emitted the contract directly (older grok,
  // a truncated envelope, a payload whose `text` field is athlete-facing prose).
  // Handing the operation a telemetry envelope would be a contract miss; handing it
  // the domain object is success. Returning null here was a systematic invalid_json:
  // insight's own `text` field collides with grok's text_key, so extractJson on the
  // prose failed and the whole payload was discarded.
  if (looksLikeStructuredEnvelope(rec, envelope)) return null;
  return rec;
}

const REASONING_LEVELS: readonly ReasoningLevel[] = ["low", "medium", "high", "xhigh", "max"];

export interface ResolvedAgentExecutionProfile {
  requested: { model?: string; reasoning?: ReasoningLevel };
  effective: { model?: string; reasoning?: ReasoningLevel };
  adjustments: string[];
  noop: boolean;
}

/** Pure config normalization used by runtime callers before choosing a profile. */
export function normalizedAgentCapabilities(def: AgentDef): Required<AgentCapabilities> {
  const declared = def.capabilities;
  const reasoning = Array.isArray(declared?.reasoning)
    ? declared.reasoning.filter((value): value is ReasoningLevel => REASONING_LEVELS.includes(value))
    : [];
  return {
    // model_flag inference preserves compatibility with third-party agents.json files.
    model: declared?.model === true || (!declared && Array.isArray(def.model_flag)),
    reasoning,
    execution_profile_noop: declared?.execution_profile_noop === true,
  };
}

/**
 * Pure provider-neutral profile resolution. Requested data is either represented
 * in `effective`, reported as an explicit stub no-op, or rejected — never silently
 * discarded. Providers that top out at high deterministically map xhigh to high.
 */
export function resolveAgentExecutionProfile(
  def: AgentDef,
  requested: Pick<RunOpts, "model" | "reasoning">
): ResolvedAgentExecutionProfile {
  const model = typeof requested.model === "string" ? requested.model.trim() : undefined;
  const reasoning = requested.reasoning;
  if (reasoning !== undefined && !REASONING_LEVELS.includes(reasoning)) {
    throw new Error(`Unsupported reasoning level "${String(reasoning)}"`);
  }
  const profile: ResolvedAgentExecutionProfile = {
    requested: { ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) },
    effective: {},
    adjustments: [],
    noop: false,
  };
  if (!model && !reasoning) return profile;

  const capabilities = normalizedAgentCapabilities(def);
  if (capabilities.execution_profile_noop) {
    profile.noop = true;
    profile.adjustments.push("execution profile intentionally ignored by offline stub");
    return profile;
  }
  if (model) {
    if (!capabilities.model || !Array.isArray(def.model_flag)) {
      throw new Error("Agent does not support a per-run model profile");
    }
    profile.effective.model = model;
  }
  if (reasoning) {
    if (!Array.isArray(def.reasoning_flag) || !capabilities.reasoning.length) {
      throw new Error("Agent does not support a per-run reasoning profile");
    }
    const supported = highestSupportedReasoning(capabilities.reasoning, reasoning);
    if (!supported) throw new Error(`Agent does not support reasoning level "${reasoning}"`);
    profile.effective.reasoning = supported;
    if (supported !== reasoning) {
      profile.adjustments.push(`reasoning ${reasoning} mapped to provider maximum ${supported}`);
    }
  }
  return profile;
}

/**
 * The highest level this provider declares that is no stronger than `requested`
 * (levels are ordered least→most effort in REASONING_LEVELS). This is what makes
 * a request degrade instead of failing: asking a three-level CLI for xhigh/max
 * lands on its own ceiling. null only when the provider declares nothing at or
 * below the request, which callers treat as "this agent can't take a profile".
 */
function highestSupportedReasoning(
  supported: readonly ReasoningLevel[],
  requested: ReasoningLevel
): ReasoningLevel | null {
  const ceiling = REASONING_LEVELS.indexOf(requested);
  let best: ReasoningLevel | null = null;
  let bestRank = -1;
  for (const level of supported) {
    const rank = REASONING_LEVELS.indexOf(level);
    if (rank < 0 || rank > ceiling || rank <= bestRank) continue;
    best = level;
    bestRank = rank;
  }
  return best;
}

/**
 * Pure: turn Cairn's provider-neutral request into the concrete `{model, reasoning}`
 * THIS agent can actually take. Never throws and never invents a value — a class the
 * person has not bound, an agent with no model flag, or no reasoning support simply
 * gets that field omitted and runs on its own default. The offline stub always resolves
 * to nothing (it ignores execution profiles by contract).
 */
export function resolveAgentProfileForClass(
  def: AgentDef | undefined,
  want: AbstractExecutionProfile | undefined,
  // The person's own class -> model choice for THIS provider (settings.model_class_bindings).
  // Absent (the default) means no --model at all: the CLI runs its own default model.
  classModels?: Partial<Record<ModelClass, string>> | null
): { model?: string; reasoning?: ReasoningLevel } {
  if (!def || !want) return {};
  const capabilities = normalizedAgentCapabilities(def);
  if (capabilities.execution_profile_noop) return {};
  const out: { model?: string; reasoning?: ReasoningLevel } = {};
  if (capabilities.model && Array.isArray(def.model_flag)) {
    const model = String(want.model ?? (want.model_class ? classModels?.[want.model_class] : "") ?? "").trim();
    if (model) out.model = model;
  }
  if (want.reasoning && Array.isArray(def.reasoning_flag) && capabilities.reasoning.length) {
    const reasoning = highestSupportedReasoning(capabilities.reasoning, want.reasoning);
    if (reasoning) out.reasoning = reasoning;
  }
  return out;
}

// Fold a caller-supplied profile resolver into this run's opts. An explicit
// model/reasoning always wins per field; a throwing or absent resolver is simply
// no profile (a policy lookup must never break a coaching run).
function withResolvedProfile(
  name: string,
  opts: Pick<RunOpts, "model" | "reasoning" | "profile">
): { model?: string; reasoning?: ReasoningLevel } {
  if (!opts.profile || (opts.model && opts.reasoning)) return { model: opts.model, reasoning: opts.reasoning };
  let resolved: { model?: string; reasoning?: ReasoningLevel } | null | undefined;
  try {
    resolved = opts.profile(name);
  } catch {
    resolved = undefined;
  }
  return { model: opts.model ?? resolved?.model, reasoning: opts.reasoning ?? resolved?.reasoning };
}

const UPLOAD_IMAGE_RE = /\.(?:jpe?g|png|webp|gif|heic|heif)$/i;

function extractPromptImagePaths(prompt: string, sourceEnv: NodeJS.ProcessEnv = process.env): string[] {
  const dataDir = path.resolve(agentDataDir(sourceEnv));
  if (!promptReferencesDataDir(prompt, sourceEnv)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const escaped = dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped.replace(/\\\//g, "/")}/[^\\s"'<>),]+`, "g");
  for (const m of prompt.matchAll(re)) {
    const raw = m[0].replace(/[.,;:]+$/, "");
    if (!UPLOAD_IMAGE_RE.test(raw)) continue;
    try {
      const p = path.resolve(raw);
      if (!p.startsWith(dataDir + path.sep) || seen.has(p) || !fs.existsSync(p)) continue;
      seen.add(p);
      out.push(p);
    } catch {
      /* ignore malformed paths */
    }
  }
  if (prompt.includes("CAIRN_AGENT_DATA_FILES:")) {
    const relativeRe = /"relative_path":"(uploads\/[a-zA-Z0-9._-]+)"/g;
    for (const match of prompt.matchAll(relativeRe)) {
      try {
        const p = path.resolve(dataDir, match[1]);
        if (!p.startsWith(dataDir + path.sep) || seen.has(p) || !UPLOAD_IMAGE_RE.test(p) || !fs.existsSync(p)) continue;
        seen.add(p);
        out.push(p);
      } catch {
        /* ignore malformed relative upload paths */
      }
    }
  }
  return out.slice(0, 8);
}

// Linux MAX_ARG_STRLEN is 32 * PAGE_SIZE. A 16K-page Pi 5 caps a single argv
// entry at 512 KiB; 4K-page hosts cap it at 128 KiB. Stay under the 4K floor so
// a chat DATA block can never E2BIG at spawn, on any host we ship.
export const MAX_SAFE_AGENT_ARG_BYTES = 96 * 1024;

export function promptExceedsArgvLimit(prompt: string, extraBytes = 0): boolean {
  return Buffer.byteLength(prompt, "utf8") + extraBytes > MAX_SAFE_AGENT_ARG_BYTES;
}

const PROMPT_VALUE_FLAGS = new Set(["-p", "--print", "--prompt", "--single"]);

function popPromptValueFlag(out: string[]): void {
  const last = out[out.length - 1];
  if (last && PROMPT_VALUE_FLAGS.has(last)) out.pop();
}

export type AgentPromptVia = "arg" | "stdin" | "stdin_plain" | "stdin_dash" | "file";

export interface AgentLaunch {
  args: string[];
  stdin: string | null;
  promptDir: string | null;
  via: AgentPromptVia;
}

function inferLargePromptVia(def: AgentDef): Exclude<AgentPromptVia, "arg"> {
  const declared = def.large_prompt?.via;
  if (declared) return declared;
  if (def.command === "agy") return "stdin_plain";
  if (def.command === "grok") return "file";
  if (def.command === "codex") return "stdin_dash";
  if (def.input === "stdin") return "stdin";
  return "stdin";
}

function expandAgentArgs(
  def: AgentDef,
  args: string[],
  prompt: string,
  promptSlot: "inline" | "omit" | "dash",
  mcpConfigArgs: string[] = [],
  requestedProfile: Pick<RunOpts, "model" | "reasoning"> = {},
  structuredArgs: string[] = [],
  extra: { dropPromptFlag?: boolean; promptFile?: string; extraArgs?: string[] } = {}
): string[] {
  const profile = resolveAgentExecutionProfile(def, requestedProfile).effective;
  const dataDir = path.resolve(agentDataDir(process.env));
  const needsFileAccess = promptReferencesDataDir(prompt);
  const images = needsFileAccess ? extractPromptImagePaths(prompt) : [];
  const replaceCommon = (s: string, image?: string) => {
    let out = s.replaceAll("{data_dir}", dataDir).replaceAll("{image}", image ?? "");
    if (promptSlot === "inline") out = out.replaceAll("{prompt}", prompt);
    return out;
  };
  const out: string[] = [];
  let expandedModel = false;
  let expandedReasoning = false;
  for (const arg of args) {
    if (arg === "{file_access_args}") {
      if (needsFileAccess) out.push(...(def.file_access_args || []).map((x) => replaceCommon(x)));
      continue;
    }
    if (arg === "{image_args}") {
      if (images.length && Array.isArray(def.image_args)) {
        for (const image of images) out.push(...def.image_args.map((x) => replaceCommon(x, image)));
      }
      continue;
    }
    if (arg === "{mcp_config_args}") {
      out.push(...mcpConfigArgs.filter((value) => typeof value === "string" && value.length > 0));
      continue;
    }
    if (arg === "{schema_args}") {
      out.push(...structuredArgs);
      continue;
    }
    if (arg === "{model_args}") {
      expandedModel = true;
      const chosen = profile.model;
      if (chosen && Array.isArray(def.model_flag)) {
        out.push(...def.model_flag.map((value) => replaceCommon(value).replaceAll("{model}", chosen)));
      }
      continue;
    }
    if (arg === "{reasoning_args}") {
      expandedReasoning = true;
      const chosen = profile.reasoning;
      if (chosen && Array.isArray(def.reasoning_flag)) {
        out.push(...def.reasoning_flag.map((value) => replaceCommon(value).replaceAll("{reasoning}", chosen)));
      }
      continue;
    }
    if (arg === "{prompt}") {
      if (promptSlot === "omit") {
        if (extra.dropPromptFlag) popPromptValueFlag(out);
        continue;
      }
      if (promptSlot === "dash") {
        out.push("-");
        continue;
      }
      out.push(prompt);
      continue;
    }
    const expanded = replaceCommon(arg);
    if (expanded !== "") out.push(expanded);
  }
  if (extra.promptFile) {
    const fileArgs = Array.isArray(def.large_prompt?.args) && def.large_prompt.args.length
      ? def.large_prompt.args
      : ["--prompt-file", "{prompt_file}"];
    out.push(...fileArgs.map((value) => value.replaceAll("{prompt_file}", extra.promptFile!)));
  }
  if (extra.extraArgs?.length) {
    for (let i = 0; i < extra.extraArgs.length; ) {
      const flag = extra.extraArgs[i];
      const val = extra.extraArgs[i + 1];
      if (val !== undefined && flag.startsWith("-")) {
        const at = out.lastIndexOf(flag);
        if (at >= 0 && at + 1 < out.length) out[at + 1] = val;
        else out.push(flag, val);
        i += 2;
        continue;
      }
      out.push(flag);
      i += 1;
    }
  }
  if (profile.model && !expandedModel) throw new Error("Agent argv template has no {model_args} slot");
  if (profile.reasoning && !expandedReasoning) throw new Error("Agent argv template has no {reasoning_args} slot");
  return out;
}

export function buildAgentLaunch(
  def: AgentDef,
  templateArgs: string[],
  prompt: string,
  opts: {
    mcpConfigArgs?: string[];
    model?: string;
    reasoning?: ReasoningLevel;
    structuredArgs?: string[];
    forceLarge?: boolean;
  } = {}
): AgentLaunch {
  const profile = { model: opts.model, reasoning: opts.reasoning };
  const configuredStdin = def.input === "stdin";
  const oversized = opts.forceLarge || promptExceedsArgvLimit(prompt);
  let via: AgentPromptVia = "arg";
  if (configuredStdin) via = "stdin";
  else if (oversized) via = inferLargePromptVia(def);

  let promptDir: string | null = null;
  let promptFile: string | undefined;
  let stdin: string | null = null;
  let promptSlot: "inline" | "omit" | "dash" = "inline";
  let dropPromptFlag = false;
  const extraArgs: string[] = [];

  if (via === "file") {
    promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-prompt-"));
    promptFile = path.join(promptDir, "prompt.txt");
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    promptSlot = "omit";
    dropPromptFlag = true;
  } else if (via === "stdin" || via === "stdin_plain") {
    stdin = prompt;
    promptSlot = "omit";
    dropPromptFlag = via === "stdin_plain";
    if (via === "stdin_plain") extraArgs.push("--input-format", "text");
  } else if (via === "stdin_dash") {
    stdin = prompt;
    promptSlot = "dash";
  }

  const args = expandAgentArgs(
    def,
    templateArgs,
    prompt,
    promptSlot,
    opts.mcpConfigArgs,
    profile,
    opts.structuredArgs,
    { dropPromptFlag, promptFile, extraArgs }
  );
  return { args, stdin, promptDir, via };
}

function removePromptDir(promptDir: string | null): void {
  if (!promptDir) return;
  try { fs.rmSync(promptDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function pipeAgentStdin(child: ChildProcessWithoutNullStreams, text: string | null): void {
  child.stdin.on("error", () => { /* EPIPE after a fast CLI exit must not crash the host */ });
  if (text == null) {
    child.stdin.end();
    return;
  }
  // A 500 KB chat prompt exceeds the Pi's pipe buffer (16 × 16K pages). Returning
  // false means the kernel is full; wait for drain before closing or the CLI sees EOF
  // on a truncated prompt and exits empty.
  const ok = child.stdin.write(text);
  if (ok) child.stdin.end();
  else child.stdin.once("drain", () => child.stdin.end());
}

function spawnAgentChild(
  command: string,
  args: string[],
  options: ReturnType<typeof buildAgentSpawnOptions>
): ChildProcessWithoutNullStreams {
  try {
    return spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    const err = new Error(`failed to launch "${command}": ${e.message}`);
    (err as any).code = e.code;
    throw err;
  }
}

// Interactive callers (day-read, session-suggest, chat) pass the short timeout so
// the request path never hangs on a wedged CLI; background callers (scheduler,
// review, enrichment) keep the long default. Exported so call sites name them.
export const DEFAULT_TIMEOUT_MS = 300_000;
// The FLOOR of the interactive ladder below, not a leash to pass directly: every
// interactive call site now derives its timeout from the effort the op asked for
// (repo/settings.ts `interactiveTimeoutForOp`, chatTurns.ts `chatTurnTimeoutMs`),
// because a flat 90s cap kills a high-effort run mid-think and the rotation reads
// that as a failed agent. Reach for `interactiveTimeoutFor` instead.
export const INTERACTIVE_TIMEOUT_MS = 90_000;

// A 90s leash is right for a deliberately cheap op, but it silently truncates a
// deliberately expensive one: the run is killed mid-think and the rotation falls
// through to the next agent as if it had failed. So the leash scales with the
// effort the op actually asked for — same short cap at low effort, real headroom
// where we chose to buy thinking. Never exceeds DEFAULT_TIMEOUT_MS.
const INTERACTIVE_TIMEOUT_BY_REASONING: Record<ReasoningLevel, number> = {
  low: INTERACTIVE_TIMEOUT_MS,
  medium: 150_000,
  high: 240_000,
  xhigh: DEFAULT_TIMEOUT_MS,
  max: DEFAULT_TIMEOUT_MS,
};

export function interactiveTimeoutFor(reasoning?: ReasoningLevel | null): number {
  if (!reasoning) return INTERACTIVE_TIMEOUT_MS;
  return INTERACTIVE_TIMEOUT_BY_REASONING[reasoning] ?? INTERACTIVE_TIMEOUT_MS;
}

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

const CONTRACT_REPAIR_SUFFIX =
  "\n\nYour previous JSON did not satisfy the exact response contract requested above. " +
  "Re-emit ONLY one JSON object matching that contract exactly — no prose, no markdown fences.";

// Sets `lastContractRejection` on a refusal: the predicate's own noted code when it
// names one, else a generic slug. Read it right after the call that failed.
let lastContractRejection: string | null = null;
function acceptsParsed(result: AgentResult, acceptParsed?: (parsed: any) => boolean): boolean {
  lastContractRejection = null;
  if (!result.parsed) {
    lastContractRejection = "no_json";
    return false;
  }
  if (!acceptParsed) return true;
  resetContractRejection();
  try {
    if (acceptParsed(result.parsed) === true) {
      resetContractRejection();
      return true;
    }
    lastContractRejection = takeContractRejection() ?? "accept_parsed_false";
  } catch {
    resetContractRejection();
    lastContractRejection = "accept_parsed_threw";
  }
  return false;
}

export interface AgentUsage {
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

export interface AgentResult {
  code: number | null;
  // Set when the CLI was killed by a signal Cairn did NOT send (Cairn's own timeout and
  // Stop reject before a result exists) — a SIGKILL here is the OOM killer.
  signal?: NodeJS.Signals | null;
  raw: string;
  stderr: string;
  parsed: any | null;
  usage?: AgentUsage;
  // Failed runs only (non-zero exit, a signal, or nothing printed). `error_text` is the
  // error the CLI reported inside its structured stdout — unredacted, bounded, read by
  // the failure classifiers only, never logged or stored. `failure_tail` is the short
  // redacted single line that IS logged and kept on the agent_runs row.
  error_text?: string | null;
  failure_tail?: string | null;
  // Set when a pinned model/effort was refused (now or remembered) and this result ran
  // on the CLI's own default for it (runWithModelAccessFallback).
  pin_dropped?: PinField[] | null;
}

/** What a skipped/failed candidate told us, when it told us anything durable. */
export interface AgentTriedAvailability {
  state: AgentAvailabilityState;
  resets_at: string | null;
  hold_until: string | null;
  detail: string | null;
}

export interface AgentTriedEntry {
  agent: string;
  error: string;
  /** Present when the agent was held (or newly observed) as unavailable. */
  availability?: AgentTriedAvailability;
}

export interface FallbackResult {
  agent: string;          // the agent that actually produced the output
  result: AgentResult;
  tried: AgentTriedEntry[]; // agents attempted before this one that failed
}

// Structured terminal failure for an exhausted rotation. Callers that degrade
// to a deterministic/cached result need the attempted-agent ledger without
// parsing a human error string. Abort errors deliberately remain ordinary errors
// so a user Stop is never mistaken for an availability failure.
export class AgentFallbackError extends Error {
  readonly order: string[];
  readonly tried: AgentTriedEntry[];

  constructor(order: string[], tried: AgentTriedEntry[], message?: string) {
    super(
      message ??
        `All ${order.length} agent(s) failed: ${tried.map((t) => `${t.agent}: ${t.error}`).join("; ")}`
    );
    this.name = "AgentFallbackError";
    this.order = [...order];
    this.tried = tried.map((t) => ({ ...t }));
  }
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
  status?: string | null;
  error_class?: string | null;
  error_message?: string | null;
  exit_code?: number | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  // Short machine slug for WHICH contract check refused the reply (never prose).
  reject_reason?: string | null;
  // The redacted tail of a failed run's output (agentFailureTail.ts). Local-only row.
  failure_tail?: string | null;
}
type AgentRunSink = (r: AgentRunRecord) => void;
let agentRunSink: AgentRunSink | null = null;
export function setAgentRunSink(sink: AgentRunSink | null) { agentRunSink = sink; }
function emitAgentRun(r: AgentRunRecord) {
  if (!agentRunSink) return;
  try { agentRunSink(r); } catch { /* telemetry never breaks the loop */ }
}

// ---------- availability sink ----------
// Same shape as the run sink and for the same reason (no repo import here). The
// DEFAULT never holds anything, so any caller that runs the rotation without a
// registered sink (tests, a bare script) behaves exactly as it did before.
export interface AgentAvailabilityHold {
  state: AgentAvailabilityState;
  detail: string | null;
  hold_until: string | null;
  resets_at: string | null;
}
export interface AgentAvailabilitySink {
  held(name: string, now: Date): AgentAvailabilityHold | null;
  noteFailure(name: string, failure: AgentFailure, op: string): void;
  clear(name: string): void;
}
const NO_AVAILABILITY: AgentAvailabilitySink = { held: () => null, noteFailure: () => {}, clear: () => {} };
let availabilitySink: AgentAvailabilitySink = NO_AVAILABILITY;
export function setAgentAvailabilitySink(sink: AgentAvailabilitySink | null) {
  availabilitySink = sink ?? NO_AVAILABILITY;
}
function availabilityHeld(name: string, now: Date): AgentAvailabilityHold | null {
  try { return availabilitySink.held(name, now); } catch { return null; }
}
function availabilityNote(name: string, failure: AgentFailure, op: string): void {
  try { availabilitySink.noteFailure(name, failure, op); } catch { /* never breaks the loop */ }
}
function availabilityClear(name: string): void {
  try { availabilitySink.clear(name); } catch { /* never breaks the loop */ }
}

// ---------- diagnostic sink ----------
// ONE warning when a whole rotation comes back empty, so an exhausted set of
// providers stops being swallowed silently by callers that degrade to a
// deterministic result. Taxonomy words only — raw CLI output is never a
// telemetry input (src/telemetry-privacy.ts).
export interface AgentDiagnosticEvent {
  source: "agent";
  kind: string;
  level: "warning" | "error";
  operation: string;
  fingerprint: string;
  message: string;
}
type AgentDiagnosticSink = (e: AgentDiagnosticEvent) => void;
let agentDiagnosticSink: AgentDiagnosticSink | null = null;
export function setAgentDiagnosticSink(sink: AgentDiagnosticSink | null) { agentDiagnosticSink = sink; }
function emitAgentDiagnostic(e: AgentDiagnosticEvent) {
  if (!agentDiagnosticSink) return;
  try { agentDiagnosticSink(e); } catch { /* telemetry never breaks the loop */ }
}

/** The state most of the rotation reported — what the one warning is ABOUT. */
export function dominantTriedState(tried: AgentTriedEntry[]): AgentAvailabilityState {
  const counts = new Map<AgentAvailabilityState, number>();
  for (const t of tried) {
    if (!t.availability) continue;
    counts.set(t.availability.state, (counts.get(t.availability.state) ?? 0) + 1);
  }
  let best: AgentAvailabilityState = "invalid_output";
  let bestN = 0;
  for (const [state, n] of counts) if (n > bestN) { best = state; bestN = n; }
  return best;
}

// Try each agent in `order` until one returns a usable result: JSON-parseable,
// and (when the operation supplies `acceptParsed`) semantically valid too.
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
  if (!order.length) {
    throw new AgentFallbackError([], [], "No agents enabled — turn one on in Settings.");
  }
  // Back-compat: older call sites (enrich.ts) pass a bare timeout number.
  const o: RunOpts & { op?: string } = typeof opts === "number" ? { timeoutMs: opts } : opts;
  const baseTimeout = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const op = o.op ?? "auto";
  const signal = o.signal;
  const tried: AgentTriedEntry[] = [];
  const startedAt = new Date();

  // Availability first, breaker second. A HELD provider (out of quota, out of
  // credit, throttled, signed out) is not spawned at all while any other
  // candidate remains — re-asking a rate-limited CLI costs seconds of this op's
  // timeout and cannot succeed. But a hold is a PREDICTION: if every other
  // candidate fails, the held ones become the only remaining option and are
  // probed anyway, which is how a wrong hold self-corrects.
  const holds = new Map<string, AgentAvailabilityHold | null>();
  for (const n of order) holds.set(n, availabilityHeld(n, startedAt));
  const isHeld = (n: string) => !!holds.get(n);
  const healthy = order.filter((n) => !isHeld(n) && !breakerIsOpen(n));
  const trippedOnly = order.filter((n) => !isHeld(n) && breakerIsOpen(n));
  const heldAgents = order.filter(isHeld);

  const attempt = async (name: string): Promise<FallbackResult | null> => {
    if (signal?.aborted) throw new Error("canceled");
    const isProbe = breakerIsOpen(name) || isHeld(name);
    // A tripped/held agent is probed only on a short leash.
    const timeoutMs = isProbe ? Math.min(baseTimeout, BREAKER_PROBE_TIMEOUT_MS) : baseTimeout;
    const started = Date.now();
    let triedJson = false;
    try {
      let result = await runAgent(name, prompt, {
        timeoutMs,
        signal,
        extract: o.extract,
        mcpConfigArgs: o.mcpConfigArgs,
        model: o.model,
        reasoning: o.reasoning,
        profile: o.profile,
        tools: o.tools,
        priority: o.priority,
        op,
        // Kept on for the repair retry too: an agent that can enforce the contract is
        // exactly the one that should not be asked to re-derive it from prose. Agents
        // later in the rotation that can't enforce it simply ignore it.
        schema: o.schema,
      });
      const parsedBeforeRepair = !!result.parsed;
      const acceptedBeforeRepair = acceptsParsed(result, o.acceptParsed);
      // Why the output is missing decides whether a retry is worth anything. A
      // provider that said "weekly limit" / "402" / "not logged in" / "permission
      // denied" will say it again — re-asking it for "only the JSON" is pure
      // waste. Only a chatty-but-willing model earns the one-shot repair.
      const failure = acceptedBeforeRepair ? null : classifyAgentFailure(name, result, new Date());
      const wasteful =
        !!failure &&
        (availabilityHolds(failure.state) || failure.state === "permission_denied" || failure.state === "out_of_memory");
      // Under ENFORCED structured output the first run was already constrained, so an
      // unparseable reply means truncation or a CLI error — re-asking for "only the
      // JSON" cannot fix it and costs a full extra spawn. The CONTRACT repair still
      // applies: a schema-valid payload can fail acceptParsed semantically.
      const structured = !!o.schema && agentSupportsStructuredOutput(name);
      const worthRepair = parsedBeforeRepair || !structured;
      if (!acceptedBeforeRepair && !wasteful && worthRepair && !signal?.aborted) {
        triedJson = true;
        try {
          result = await runAgent(name, prompt + (parsedBeforeRepair ? CONTRACT_REPAIR_SUFFIX : JSON_REPAIR_SUFFIX), {
            timeoutMs,
            signal,
            extract: o.extract,
            mcpConfigArgs: o.mcpConfigArgs,
            model: o.model,
            reasoning: o.reasoning,
            profile: o.profile,
            tools: o.tools,
            priority: o.priority,
            op,
            schema: o.schema,
          });
        } catch {
          /* keep the first (unparsed) result; fall through below */
        }
      }
      if (acceptsParsed(result, o.acceptParsed)) {
        breakerNoteSuccess(name);
        // A success is proof the provider answers — any hold on it is stale.
        availabilityClear(name);
        holds.set(name, null);
        emitAgentRun({
          op,
          agent: name,
          ok: true,
          parsed: true,
          latency_ms: Date.now() - started,
          tried_json: triedJson,
          status: "ok",
          exit_code: result.code,
          model: result.usage?.model ?? null,
          input_tokens: result.usage?.input_tokens ?? null,
          output_tokens: result.usage?.output_tokens ?? null,
        });
        return { agent: name, result, tried };
      }
      breakerNoteFail(name);
      const rejectReason = lastContractRejection;
      const parsed = !!result.parsed;
      // A second run after the repair can fail for a NEW reason; re-read it.
      const finalFailure = triedJson ? classifyAgentFailure(name, result, new Date()) : failure;
      // Parseable-but-off-contract stays `invalid_contract`; plain unparseable
      // output stays `invalid_json`. Everything else now carries its real cause.
      const errorClass = parsed
        ? "invalid_contract"
        : finalFailure && finalFailure.state !== "invalid_output"
          ? finalFailure.state
          : "invalid_json";
      const error = parsed
        ? `ran but returned JSON outside the requested contract (exit ${result.code})`
        : finalFailure && finalFailure.state !== "invalid_output"
          ? availabilityReason(finalFailure)
          : `ran but returned no valid JSON (exit ${result.code})`;
      emitAgentRun({
        op,
        agent: name,
        ok: false,
        parsed,
        latency_ms: Date.now() - started,
        tried_json: triedJson,
        status: errorClass === "invalid_contract" || errorClass === "invalid_json" ? "invalid_output" : errorClass,
        error_class: errorClass,
        error_message: error,
        exit_code: result.code,
        model: result.usage?.model ?? null,
        input_tokens: result.usage?.input_tokens ?? null,
        output_tokens: result.usage?.output_tokens ?? null,
        reject_reason: errorClass === "invalid_contract" || errorClass === "invalid_json" ? rejectReason : null,
        failure_tail: result.failure_tail ?? null,
      });
      if (errorClass === "invalid_contract" || errorClass === "invalid_json") {
        // One line, codes only: op, agent, class, reason slug. Never the reply or any data.
        log.warn("[agents] reply rejected", { op, agent: name, error_class: errorClass, reason: rejectReason });
      }
      const entry: AgentTriedEntry = { agent: name, error };
      if (!parsed && finalFailure) {
        if (availabilityHolds(finalFailure.state)) availabilityNote(name, finalFailure, op);
        entry.availability = {
          state: finalFailure.state,
          resets_at: finalFailure.resets_at,
          hold_until: null,
          detail: finalFailure.detail,
        };
      }
      tried.push(entry);
      return null;
    } catch (e: any) {
      if (signal?.aborted) throw e; // canceled mid-run — stop the rotation
      // The host had no spawn permit for this run. The CLI was never started, so this
      // says nothing about the agent — and the permit is PROCESS-WIDE, so the next
      // agent in the order would wait exactly as long and fail exactly as hard. Stop
      // the rotation and hand the caller the typed busy error to defer on, instead of
      // spending every remaining candidate's wait budget learning the same thing.
      if (isAgentBusyError(e)) throw e;
      breakerNoteFail(name);
      const message = String(e?.message || "");
      const timedOut = /timed out/i.test(message);
      // A thrown run still carries the CLI's own words on stderr in most cases;
      // classify them so a quota failure that also exits non-zero is not filed
      // as a generic process error.
      const failure = timedOut ? null : classifyAgentFailure(name, { code: null, raw: "", stderr: message }, new Date());
      const errorClass = timedOut ? "timeout" : (failure?.state ?? "process_error");
      emitAgentRun({
        op,
        agent: name,
        ok: false,
        parsed: false,
        latency_ms: Date.now() - started,
        tried_json: triedJson,
        status: errorClass === "process_error" ? "error" : errorClass,
        error_class: errorClass,
        error_message: e?.message,
      });
      const entry: AgentTriedEntry = { agent: name, error: e.message };
      if (failure && availabilityHolds(failure.state)) {
        availabilityNote(name, failure, op);
        entry.availability = {
          state: failure.state,
          resets_at: failure.resets_at,
          hold_until: null,
          detail: failure.detail,
        };
      }
      tried.push(entry);
      return null;
    }
  };

  // Pass 1: everything not currently held. A held provider is recorded as
  // skipped (never spawned) for as long as a non-held candidate remains, so a
  // caller that succeeds elsewhere can still say WHY the preferred agent sat out.
  const openCandidates = [...healthy, ...trippedOnly];
  if (openCandidates.length) {
    for (const name of heldAgents) {
      const hold = holds.get(name)!;
      tried.push({
        agent: name,
        error: availabilityReason({ state: hold.state, resets_at: hold.resets_at }),
        availability: { ...hold },
      });
    }
  }
  for (const name of openCandidates) {
    const hit = await attempt(name);
    if (hit) return hit;
  }
  // Pass 2: nothing else answered, so the held providers are now the only
  // remaining option and the prediction gets tested. A stale hold can never
  // strand an operation.
  if (heldAgents.length) {
    for (let i = tried.length - 1; i >= 0; i--) {
      if (heldAgents.includes(tried[i].agent) && !openCandidates.includes(tried[i].agent)) tried.splice(i, 1);
    }
    for (const name of heldAgents) {
      const hit = await attempt(name);
      if (hit) return hit;
    }
  }

  const dominant = dominantTriedState(tried);
  emitAgentDiagnostic({
    source: "agent",
    kind: "rotation_exhausted",
    level: "warning",
    operation: op,
    fingerprint: `agent:rotation_exhausted:${op}:${dominant}`,
    message: `no provider available (${dominant})`,
  });
  throw new AgentFallbackError(order, tried);
}

// ---------- tool policy: the CLIs are agents, Cairn's prompts are not tasks ----------
// Every coaching CLI here is an AUTONOMOUS coding agent: handed a long prompt with a
// JSON contract, grok and agy read whatever sits in their cwd, grep it, and run shell
// commands to "check" — and each of those steps is an inference round. Live on a Pi
// (2026-09-02) a chat turn was 28 tool executions across 23 rounds before the 150 s
// timeout, and agy's version of the same reflex was `run_terminal_command` → headless
// auto-deny → "no output produced" (exit 0, empty response). Every DATA: block already
// contains the whole picture, and the coach-read loop is a prompt protocol, not a tool.
//
// Verified on the Pi against grok 1.0.13 and agy 1.1.24: no CLI flag reliably turns the
// reflex off (`--max-turns 1` and `--permission-mode plan` cancel the turn when a tool
// is wanted, `--tools <one>` hung, `--disallowed-tools` still lists and reads,
// `--rules` was ignored) — but a plain sentence at the top of the prompt makes both
// answer in ONE round. So the rule travels with the prompt, provider-neutrally.
export const NO_TOOLS_PREAMBLE =
  "Everything you need is in this prompt. Do NOT use your own tools of any kind: do not read or " +
  "list files, run commands, or search the web. Answer directly from the prompt text, in exactly " +
  "the reply shape this prompt asks for; if something you need is not in the prompt, say so in " +
  "your answer.";

/**
 * The prompt the CLI actually receives. Untouched when the run hands the CLI files it
 * must open (an uploaded panel or photo — the same test that grants file access) or
 * when the op asked for provider tools; otherwise NO_TOOLS_PREAMBLE leads. Idempotent,
 * so the JSON-repair retry that re-runs a prompt never stacks a second copy.
 */
export function applyToolPolicy(prompt: string, tools: RunOpts["tools"] = "none"): string {
  if (tools === "provider") return prompt;
  if (promptReferencesDataDir(prompt)) return prompt;
  if (prompt.startsWith(NO_TOOLS_PREAMBLE)) return prompt;
  return `${NO_TOOLS_PREAMBLE}\n\n${prompt}`;
}

export function runAgent(name: string, rawPrompt: string, opts: RunOpts | number = {}): Promise<AgentResult> {
  const prompt = applyToolPolicy(rawPrompt, typeof opts === "number" ? "none" : opts.tools);
  // Back-compat: older call sites pass a bare timeout number.
  const timeoutMs = typeof opts === "number" ? opts : (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = typeof opts === "number" ? undefined : opts.signal;
  const extract = typeof opts === "number" ? undefined : opts.extract;
  const mcpConfigArgs = typeof opts === "number" ? undefined : opts.mcpConfigArgs;
  // ONE chokepoint: every path that spawns a CLI (direct runAgent, the rotation in
  // runAgentWithFallback, the streaming sibling below) resolves the op's profile
  // here, against the agent actually chosen.
  const { model, reasoning } = typeof opts === "number" ? {} : withResolvedProfile(name, opts);
  const schema = typeof opts === "number" ? undefined : opts.schema;
  // A bare-number call site is always a background lane (enrich.ts); only an explicit
  // opt-in claims the reserved interactive permit.
  const priority: AgentPriority = (typeof opts === "number" ? undefined : opts.priority) ?? "background";
  const op = typeof opts === "number" ? undefined : opts.op;
  return runAgentImpl(name, prompt, timeoutMs, signal, extract, mcpConfigArgs, model, reasoning, schema, priority, op);
}

// ---------- one process-wide cap on concurrent CLI subprocesses ----------
// Six lanes spawn coaching CLIs — chat, the agent-job runner, the enrichment queue,
// the proactive pass, the day-read precompute and the day-read refresh — and each
// only ever knew about ITSELF (its own serial runner or busy flag). Nothing counted
// the total, so on a quiet morning the scheduler could have a precompute, an enrich
// drain and a refresh in flight while the athlete opened chat, and a Pi 5 would be
// running four Node-based CLIs at once against 8 GB and four cores: every one of
// them slower, and the interactive one slowest of all.
//
// ONE semaphore, taken at the single point every lane passes through — the spawn.
// Waiting is FIFO within a priority class, so a lane cannot starve behind a steady
// drip from a busier one.
//
// PRIORITY: a run an athlete is actually waiting on — a chat turn, their own new read
// — declares `priority: "interactive"`, and two things follow. It jumps the queue,
// ahead of every waiting background run and behind only an earlier interactive one;
// and it may take ONE permit ABOVE the cap, reserved, that background work can never
// hold. Without that reserve, two background holders (a deep proposal job and an
// enrichment drain, the ordinary quiet-morning pair) left the athlete's chat turn
// queued behind an open SSE stream with nothing on it. At most cap+1 CLIs run at once,
// and the extra one only ever while a person is waiting on it.
//
// TIMEOUT CLOCK: the permit is taken BEFORE the run's timer is armed, so an op's
// timeout budget measures the CLI's own run and never the queue it waited in. A
// slow queue therefore delays a run; it can never make one look like it timed out.
// The WAIT carries its own bound of the same length: a run that cannot get a permit
// within its own configured timeout rejects with an "agent busy" error instead of
// waiting forever. So the worst case is honest and bounded (at most 2× the op's
// timeout — queue, then run), and a starved lane SAYS so rather than holding a
// surface open on a promise that will never settle. A caller with an AbortSignal
// (chat's Stop) still drops out of the queue the moment it aborts, without spawning.
const DEFAULT_MAX_AGENT_PROCS = 2;

/** Read per acquisition, so the cap can be changed without a restart (and by a test). */
function maxAgentProcs(): number {
  const raw = String(process.env.CAIRN_MAX_AGENT_PROCS ?? "").trim();
  if (!raw) return DEFAULT_MAX_AGENT_PROCS; // unset or blank — not "zero"
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_AGENT_PROCS;
  return Math.max(1, Math.min(64, Math.floor(parsed)));
}

/**
 * How many live processes this class of run may be one of. Background work stops at
 * the cap; an interactive run may also take the single reserved permit above it.
 */
function agentSlotCeiling(priority: AgentPriority): number {
  return priority === "interactive" ? maxAgentProcs() + 1 : maxAgentProcs();
}

interface AgentSlotWaiter {
  priority: AgentPriority;
  grant: () => void;
  cancel: (error: Error) => void;
}

let activeAgentProcs = 0;
// Ordered so every waiting interactive run sits ahead of every waiting background one,
// FIFO within each class. The head is therefore always the next run allowed to take a
// permit: if IT cannot, nothing behind it can either, since interactive (the class that
// can be ahead) has the higher ceiling of the two.
const agentSlotQueue: AgentSlotWaiter[] = [];

function enqueueAgentSlotWaiter(waiter: AgentSlotWaiter): void {
  if (waiter.priority === "background") {
    agentSlotQueue.push(waiter);
    return;
  }
  const firstBackground = agentSlotQueue.findIndex((w) => w.priority === "background");
  if (firstBackground < 0) agentSlotQueue.push(waiter);
  else agentSlotQueue.splice(firstBackground, 0, waiter);
}

function pumpAgentSlots(): void {
  while (agentSlotQueue.length) {
    const head = agentSlotQueue[0];
    if (activeAgentProcs >= agentSlotCeiling(head.priority)) return;
    agentSlotQueue.shift();
    head.grant();
  }
}

/**
 * Take a spawn permit. Resolves with the (idempotent) release. Rejects — without
 * spawning, and without holding a permit — if the caller's signal aborts while queued,
 * or if `waitMs` passes without a permit becoming available.
 */
function acquireAgentSlot(
  name: string,
  signal: AbortSignal | undefined,
  priority: AgentPriority,
  waitMs: number
): Promise<() => void> {
  return new Promise<() => void>((resolve, reject) => {
    const take = () => {
      activeAgentProcs++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeAgentProcs--;
        pumpAgentSlots();
      });
    };
    if (signal?.aborted) {
      reject(new Error(`agent "${name}" canceled`));
      return;
    }
    // FIFO inside the class: a newcomer never overtakes an already-queued waiter of its
    // own class, even when a permit happens to be free at this instant (for background
    // it isn't — a queued background waiter means the pump has not caught up). An
    // interactive newcomer DOES overtake waiting background ones; that is the priority.
    const queuedAhead =
      priority === "interactive"
        ? agentSlotQueue.some((w) => w.priority === "interactive")
        : agentSlotQueue.length > 0;
    if (!queuedAhead && activeAgentProcs < agentSlotCeiling(priority)) {
      take();
      return;
    }
    let settled = false;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const detach = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (waitTimer) clearTimeout(waitTimer);
    };
    const waiter: AgentSlotWaiter = {
      priority,
      grant: () => {
        if (settled) return;
        settled = true;
        detach();
        take();
      },
      cancel: (error: Error) => {
        if (settled) return;
        settled = true;
        detach();
        reject(error);
      },
    };
    const dropFromQueue = () => {
      const at = agentSlotQueue.indexOf(waiter);
      if (at >= 0) agentSlotQueue.splice(at, 1);
    };
    function onAbort() {
      dropFromQueue();
      waiter.cancel(new Error(`agent "${name}" canceled`));
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    // The bounded wait: this run's own timeout budget, spent again on the queue rather
    // than deducted from the run. A lane that never reaches the front fails loudly here
    // instead of leaving its caller (and the surface it is streaming to) waiting forever.
    const waitBudget = Math.max(1, waitMs);
    const waited = waitBudget >= 1000 ? `${Math.round(waitBudget / 1000)}s` : `${waitBudget}ms`;
    waitTimer = setTimeout(() => {
      dropFromQueue();
      // TYPED, because every background runner has to tell this apart from a run that
      // actually failed: it defers and retries instead of burning the row's status.
      waiter.cancel(
        new AgentBusyError(name, waitBudget, `agent "${name}" busy — no spawn permit within ${waited}`)
      );
    }, waitBudget);
    waitTimer.unref?.();
    enqueueAgentSlotWaiter(waiter);
  });
}

/** Observability + test hook for the spawn cap. */
export function agentSlotStats(): {
  active: number;
  waiting: number;
  waitingInteractive: number;
  limit: number;
  interactiveLimit: number;
} {
  return {
    active: activeAgentProcs,
    waiting: agentSlotQueue.length,
    waitingInteractive: agentSlotQueue.reduce((n, w) => n + (w.priority === "interactive" ? 1 : 0), 0),
    limit: maxAgentProcs(),
    interactiveLimit: agentSlotCeiling("interactive"),
  };
}

// ---------- subprocess env/workdir hardening (Trust build V1) ----------
// The agent CLIs are full subprocesses and (for research/grounding) now have web
// egress, so the blast radius of an exfiltrated secret is real. The shared helper
// passes a COPY of process.env with Cairn-only secrets/config removed, and runs
// ordinary subprocesses from DATA_DIR/.agent-workspaces/<kind> instead of DATA_DIR
// itself. Prompts that hand the CLI an absolute uploaded-file path still use
// DATA_DIR as cwd for compatibility with CLI file-read permissions.

interface AgentSpawnRequest {
  name: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  extract?: (text: string) => any | null;
  mcpConfigArgs?: string[];
  model?: string;
  reasoning?: ReasoningLevel;
  schema?: JsonSchema;
  op?: string;
}

async function runAgentImpl(
  name: string,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
  extract?: (text: string) => any | null,
  mcpConfigArgs?: string[],
  model?: string,
  reasoning?: ReasoningLevel,
  schema?: JsonSchema,
  priority: AgentPriority = "background",
  op?: string
): Promise<AgentResult> {
  const def = loadAgents()[name];
  if (!def) throw new Error(`Unknown agent "${name}"`);
  // Queue for the spawn permit before ANY setup work (the schema tempdir included), so
  // a run that never reaches the spawn leaves nothing behind — and so the run's own
  // timeout timer, armed inside the spawn below, never counts the queue. The wait gets
  // the same budget as the run, separately from it.
  const releaseSlot = await acquireAgentSlot(name, signal, priority, timeoutMs);
  try {
    // The refused-pin retry runs INSIDE the permit already held: a retry that queued
    // again could meet AgentBusyError, which must only ever mean "no permit", never a
    // consequence of this run's own failure.
    return await runWithModelAccessFallback(name, { model, reasoning }, op, signal, (pin) =>
      spawnAgentProcess(def, {
        name,
        prompt,
        timeoutMs,
        signal,
        extract,
        mcpConfigArgs,
        model: pin.model,
        reasoning: pin.reasoning,
        schema,
        op,
      })
    );
  } finally {
    releaseSlot();
  }
}

// ---------- a pinned model the account can't use ----------
// A run pinned to a model alias (or effort) the account may not use — a lower plan
// tier asked for the top alias — exits within a second with words like "There's an
// issue with the selected model". That is not a dead provider: the CLI answers fine on
// its own default. So the spawn tries ONCE more with the pin dropped, and remembers the
// refused pin (agentModelPins.ts) so the next run skips it up front instead of failing
// first. Every spawn path goes through here (runAgent, the rotation, chat streaming).
//
// Only a FAILED run is read (classifyAgentFailure's model arm is itself limited to a
// non-zero/signalled exit or an empty reply), and only a run that carried a pin is
// retried. A refused pin fails before the model says a word, so a retried stream has
// never shown the person any text.
async function runWithModelAccessFallback(
  name: string,
  pin: { model?: string; reasoning?: ReasoningLevel },
  op: string | undefined,
  signal: AbortSignal | undefined,
  spawnOnce: (pin: { model?: string; reasoning?: ReasoningLevel }) => Promise<AgentResult>
): Promise<AgentResult> {
  const effective = pinsAfterRefusals(name, pin);
  const remembered = effective.dropped;
  const first = await spawnOnce({ model: effective.model, reasoning: effective.reasoning });
  const tagged = (r: AgentResult, dropped: PinField[]): AgentResult => (dropped.length ? { ...r, pin_dropped: dropped } : r);
  if ((!effective.model && !effective.reasoning) || signal?.aborted) return tagged(first, remembered);
  const failed = first.code !== 0 || !!first.signal || !String(first.raw ?? "").trim();
  if (!failed) return tagged(first, remembered);
  const failure = classifyAgentFailure(name, first, new Date());
  if (failure?.state !== "model_unavailable") return tagged(first, remembered);
  // Which pin to remember: the one the CLI's words name, else whichever was pinned.
  const culprit: PinField =
    /effort/i.test(failure.detail) && effective.reasoning ? "reasoning" : effective.model ? "model" : "reasoning";
  const refusedValue = culprit === "model" ? effective.model : effective.reasoning;
  if (refusedValue) noteRefusedPin(name, culprit, refusedValue);
  log.warn(`[agents] ${name} refused the pinned ${culprit === "model" ? "model" : "effort"}; retrying on the CLI default`, {
    agent: name,
    op: op ?? null,
    model: effective.model ?? null,
    reasoning: effective.reasoning ?? null,
    refused: culprit,
  });
  // Both pins go for the retry: whichever one was refused, the CLI's own default pair
  // is the combination most certain to be valid for this account.
  const retry = await spawnOnce({});
  const dropped: PinField[] = [...remembered];
  if (effective.model) dropped.push("model");
  if (effective.reasoning) dropped.push("reasoning");
  return tagged(retry, dropped);
}

/**
 * ONE warn line per failed attempt, on every spawn path: which agent, which op, how it
 * ended, how long it ran, and a short redacted tail of what it printed. Before this a
 * CLI that exited non-zero with words no classifier knew left nothing in the log.
 */
function logFailedAttempt(
  name: string,
  details: {
    op?: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    startedAt: number;
    model?: string;
    reasoning?: ReasoningLevel;
    tail: string | null;
    resource: AgentFailure | null;
  }
): void {
  const fields = {
    agent: name,
    op: details.op ?? null,
    exit: details.code,
    signal: details.signal ?? null,
    ms: Date.now() - details.startedAt,
    model: details.model ?? null,
    reasoning: details.reasoning ?? null,
    state: details.resource?.state ?? null,
    tail: details.tail ?? "(no output)",
  };
  if (details.resource) log.warn(`[agents] ${name} failed: ${details.resource.detail.toLowerCase()}`, fields);
  else log.warn(`[agents] ${name} attempt failed`, fields);
}

function spawnAgentProcess(def: AgentDef, request: AgentSpawnRequest): Promise<AgentResult> {
  const { name, prompt, timeoutMs, signal, extract, mcpConfigArgs, model, reasoning, schema, op } = request;
  const startedAt = Date.now();
  // Enforced structured output, when BOTH the caller supplied a schema and this agent
  // declares how to take one. Everything below is best-effort by design: an agent with
  // no declaration, an argv template with no {schema_args} slot, or a filesystem error
  // all fall back to the prose contract + extractJson, because the rotation tries
  // agents of differing capability in order and no op may depend on enforcement.
  const structured = schema ? resolveStructuredOutput(def) : null;
  // Only treat the schema as ACTIVE when the flag can actually reach the CLI. This
  // guards the envelope unwrap below: enabling the flag is what makes a provider wrap
  // its payload, so unwrapping a run whose flag was never placed would discard a
  // perfectly good plain response.
  const structuredActive = !!structured && Array.isArray(def.args) && def.args.includes("{schema_args}");
  let schemaDir: string | null = null;
  let structuredArgs: string[] = [];
  let envelope: NonNullable<AgentStructuredOutput["envelope"]> | null = null;
  if (structured && structuredActive) {
    try {
      let substitution: string;
      if (structured.arg === "file") {
        // codex takes a PATH, not inline JSON. A private per-run directory keeps the
        // schema off a predictable path and makes cleanup a single recursive remove.
        schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-schema-"));
        substitution = path.join(schemaDir, "schema.json");
        fs.writeFileSync(substitution, JSON.stringify(schema), { mode: 0o600 });
      } else {
        substitution = JSON.stringify(schema);
      }
      structuredArgs = structured.flag.map((value) =>
        value.replaceAll("{schema}", substitution).replaceAll("{schema_file}", substitution)
      );
      envelope = structured.envelope ?? null;
    } catch {
      structuredArgs = [];
      envelope = null;
    }
  }

  const openLaunch = (forceLarge = false): AgentLaunch =>
    buildAgentLaunch(def, def.args, prompt, { mcpConfigArgs, model, reasoning, structuredArgs, forceLarge });

  let launch = openLaunch();
  // A provider whose schema flag rewrites stdout into an envelope needs unwrapping
  // BEFORE the operation's contract check; every other provider keeps the caller's
  // extractor byte-for-byte.
  const baseExtract = extract ?? extractJson;
  const activeEnvelope = envelope;
  const parseOut = activeEnvelope
    ? (text: string) => unwrapStructuredEnvelope(baseExtract(text), activeEnvelope)
    : baseExtract;

  // Cap accumulated output so a runaway/verbose CLI can't balloon RSS on a small
  // host (e.g. the Pi), especially during a multi-job enrichment queue drain.
  const MAX_OUT = 4 * 1024 * 1024; // 4 MB — far beyond any real JSON proposal.

  // Idempotent: the schema/prompt files outlive neither a clean close, a timeout kill,
  // an abort, nor a failed launch.
  const removeTemps = () => {
    if (schemaDir) {
      const target = schemaDir;
      schemaDir = null;
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    if (launch.promptDir) {
      const target = launch.promptDir;
      launch = { ...launch, promptDir: null };
      removePromptDir(target);
    }
  };

  return new Promise((resolve, reject) => {
    // Already-aborted before launch (Stop landed while queued): don't spawn.
    if (signal?.aborted) { removeTemps(); reject(new Error(`agent "${name}" canceled`)); return; }
    if (name === "antigravity") {
      try { ensureAntigravityHeadlessPermissions(); } catch { /* never block a spawn */ }
    }
    const spawnOpts = buildAgentSpawnOptions({
      kind: "agent",
      prompt,
      restoreEnvKeys: def.env_required || [],
    });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnAgentChild(def.command, launch.args, spawnOpts);
    } catch (e: any) {
      if (e?.code === "E2BIG" && launch.via === "arg") {
        removePromptDir(launch.promptDir);
        launch = openLaunch(true);
        try {
          child = spawnAgentChild(def.command, launch.args, spawnOpts);
        } catch (retry: any) {
          removeTemps();
          reject(retry instanceof Error ? retry : new Error(String(retry)));
          return;
        }
      } else {
        removeTemps();
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
    }
    let out = "";
    let err = "";
    // stdout/stderr chunks are arbitrary byte boundaries. Decoding each Buffer
    // independently turns a split UTF-8 character (for example `·` or `é`) into
    // replacement glyphs before chat/markdown ever sees it.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent "${name}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // A Stop on a running turn aborts the signal: SIGKILL the live subprocess so
    // the worker isn't left waiting on a now-unwanted run.
    const onAbort = () => {
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`agent "${name}" canceled`));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      removeTemps();
    };

    child.stdout.on("data", (d) => { if (out.length < MAX_OUT) out += outDecoder.write(d); });
    child.stderr.on("data", (d) => { if (err.length < MAX_OUT) err += errDecoder.write(d); });
    child.on("error", (e) => {
      cleanup();
      reject(new Error(`failed to launch "${def.command}": ${e.message}`));
    });
    child.on("close", (code, killSignal) => {
      cleanup();
      if (out.length < MAX_OUT) out += outDecoder.end();
      if (err.length < MAX_OUT) err += errDecoder.end();
      const parsed = parseOut(out);
      const usage = extractAgentUsage(`${out}\n${err}`);
      // Surface stderr (under DEBUG) when the run looks unhealthy: a non-zero exit,
      // or a clean exit that nonetheless produced no parseable JSON. This is what
      // a self-hoster needs to see "not logged in" / "no such model" first-run errors.
      if (code !== 0 || !parsed) debugAgentStderr(name, code, err);
      const resource = code !== 0 || killSignal ? resourceFailure({ code, raw: out, stderr: err, signal: killSignal }) : null;
      const failed = code !== 0 || !!killSignal || !out.trim();
      let error_text: string | null = null;
      let failure_tail: string | null = null;
      if (failed) {
        error_text = structuredErrorText(out) || null;
        failure_tail = failureTail({ stderr: err, stdout: out, error_text });
        logFailedAttempt(name, { op, code, signal: killSignal ?? null, startedAt, model, reasoning, tail: failure_tail, resource });
      }
      resolve({ code, signal: killSignal ?? null, raw: out, stderr: err, parsed, usage, error_text, failure_tail });
    });

    pipeAgentStdin(child, launch.stdin);
  });
}

// ---------- headless token streaming (chat) ----------
// Three of the four CLIs emit a streaming NDJSON event format in headless mode,
// each with its OWN schema:
//   - claude  `--output-format stream-json --include-partial-messages`  (verified live)
//             {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}
//   - grok    `--output-format streaming-json`  (verified live, grok 0.2.51)
//             {"type":"text","data":"…"}  — assistant text deltas
//             {"type":"thought","data":"…"} reasoning (ignored); {"type":"end",…} terminal
//   - codex   exec `--json` delivers the agent message ONLY as a complete item
//             (no token deltas), so streaming buys nothing — codex stays one-shot.
//   - agy     has no streaming flag at all — one-shot.
// streamDelta maps ONE line to the assistant text it carries, or null for any non-
// text event. streamProgress maps reasoning/tool status events to a short,
// sanitized progress label (never raw chain-of-thought). Both are deliberately
// CONSERVATIVE: an unrecognized shape yields null (empty accumulation → the caller
// falls back to the one-shot path), never garbage.
export function progressLabelFromText(text: string): string | null {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (/(photo|image|plate|meal|food|dish|macros?|calorie|protein|nutrition)/.test(lower)) {
    return "Reading the food context…";
  }
  if (/(sqlite|database|table|schema|query|file|directory|repo|workspace|\/app\b|\/data\b|cairn\.db|chat_messages|chat_turns|profile|plan_items)/.test(lower)) {
    return "Checking your Cairn data…";
  }
  if (/(training|workout|lift|program|plan|session|run|ride|recovery|sleep|hrv|garmin)/.test(lower)) {
    return "Reading training context…";
  }
  if (/(lab|marker|blood|health|ferritin|apob|apo b|vitamin|thyroid|ldl|hdl|triglyceride)/.test(lower)) {
    return "Reading health context…";
  }
  return "Thinking through the context…";
}

export function streamDelta(format: string, line: string): string | null {
  const s = line.trim();
  if (!s) return null;
  let obj: any;
  try { obj = JSON.parse(s); } catch { return null; }
  if (format === "claude") {
    if (obj?.type === "stream_event" && obj.event?.type === "content_block_delta" && obj.event.delta?.type === "text_delta") {
      return typeof obj.event.delta.text === "string" ? obj.event.delta.text : null;
    }
    return null;
  }
  if (format === "grok") {
    // grok 0.2.51 streaming-json: {"type":"text","data":"…"} carries assistant
    // text; {"type":"thought",…} is reasoning (skip), {"type":"end",…} is terminal.
    if (obj?.type === "text" && typeof obj.data === "string") return obj.data;
    // Tolerate the older xAI ACP shape too, in case a future grok emits it.
    const u = obj?.params?.update ?? obj?.update;
    if (u && u.sessionUpdate === "agent_message_chunk") {
      const c = u.content;
      if (typeof c === "string") return c;
      if (c && typeof c.text === "string") return c.text;
    }
    return null;
  }
  return null;
}

export function streamProgress(format: string, line: string): string | null {
  const s = line.trim();
  if (!s) return null;
  let obj: any;
  try { obj = JSON.parse(s); } catch { return null; }
  if (format === "claude") {
    const ev = obj?.type === "stream_event" ? obj.event : null;
    const delta = ev?.type === "content_block_delta" ? ev.delta : null;
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      return progressLabelFromText(delta.thinking);
    }
    const block = ev?.type === "content_block_start" ? ev.content_block : null;
    if (block?.type === "tool_use") return "Checking your Cairn data…";
    return null;
  }
  if (format === "grok") {
    if (obj?.type === "thought" && typeof obj.data === "string") return progressLabelFromText(obj.data);
    const u = obj?.params?.update ?? obj?.update;
    if (u && /thought|reason/i.test(String(u.sessionUpdate || ""))) {
      const c = u.content;
      if (typeof c === "string") return progressLabelFromText(c);
      if (c && typeof c.text === "string") return progressLabelFromText(c.text);
    }
    return null;
  }
  return null;
}

export function agentSupportsStream(name: string): boolean {
  const def = loadAgents()[name];
  return !!(def && def.stream && Array.isArray(def.stream.args) && def.stream.args.length);
}

export interface StreamRunOpts extends RunOpts {
  onDelta?: (text: string) => void; // called with each assistant text chunk as it arrives
  onProgress?: (label: string) => void; // sanitized reasoning/tool progress, never raw thought
}

// Streaming sibling of runAgent for the chat path. Spawns the CLI in its headless
// streaming mode (def.stream.args), reads stdout LINE BY LINE, maps each NDJSON
// event to assistant text via the format adapter, and calls onDelta as tokens land.
// `raw` accumulates the full assistant text (prose + the trailing actions block),
// parsed downstream by parseChatReply. Honors the same timeout + AbortSignal (Stop)
// as the one-shot path. Falls back to runAgent when the agent has no stream config.
export async function runAgentStreaming(
  name: string,
  rawPrompt: string,
  opts: StreamRunOpts = {}
): Promise<AgentResult> {
  const def = loadAgents()[name];
  if (!def) throw new Error(`Unknown agent "${name}"`);
  if (!def.stream?.args?.length) return runAgent(name, rawPrompt, opts); // no stream mode → one-shot
  // Chat queues for the SAME semaphore as every background lane — a path that skipped
  // the cap would leave the athlete's turn competing with three batch runs, which is
  // the exact contention the cap exists to remove. It queues at ITS priority, though:
  // a chat turn passes `priority: "interactive"` and so jumps the line and may use the
  // reserved permit above the cap, instead of sitting behind two batch runs with the
  // SSE stream open and nothing on it. Stop still drops a queued turn instantly (the
  // signal is honoured while waiting), and the turn's timeout is armed at the spawn,
  // so a wait can never be reported as a timeout.
  const releaseSlot = await acquireAgentSlot(
    name,
    opts.signal,
    opts.priority ?? "background",
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  try {
    // Resolved once here (not inside spawnAgentStream) so the refused-pin retry can
    // hand the spawn an explicitly EMPTY pin that a profile resolver cannot refill.
    const pin = withResolvedProfile(name, opts);
    return await runWithModelAccessFallback(name, pin, opts.op, opts.signal, (chosen) =>
      spawnAgentStream(def, name, rawPrompt, { ...opts, profile: undefined, model: chosen.model, reasoning: chosen.reasoning })
    );
  } finally {
    releaseSlot();
  }
}

function spawnAgentStream(
  def: AgentDef,
  name: string,
  rawPrompt: string,
  opts: StreamRunOpts
): Promise<AgentResult> {
  const stream = def.stream;
  if (!stream?.args?.length) return runAgent(name, rawPrompt, opts);
  const prompt = applyToolPolicy(rawPrompt, opts.tools);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = opts.signal;
  const onDelta = opts.onDelta;
  const format = stream.format;
  // No structuredArgs, deliberately: `stream.args` declares no {schema_args} slot for
  // any provider. A streamed op is prose-first (reply marker, then optional actions),
  // which a JSON schema would destroy — and grok's --json-schema would override its own
  // --output-format streaming-json. RunOpts.schema is therefore inert while streaming.
  const { model, reasoning } = withResolvedProfile(name, opts);
  const startedAt = Date.now();
  const openLaunch = (forceLarge = false): AgentLaunch =>
    buildAgentLaunch(def, stream.args, prompt, {
      mcpConfigArgs: opts.mcpConfigArgs,
      model,
      reasoning,
      forceLarge,
    });
  let launch = openLaunch();
  const MAX_OUT = 4 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      removePromptDir(launch.promptDir);
      reject(new Error(`agent "${name}" canceled`));
      return;
    }
    if (name === "antigravity") {
      try { ensureAntigravityHeadlessPermissions(); } catch { /* never block a spawn */ }
    }
    const spawnOpts = buildAgentSpawnOptions({
      kind: "chat",
      prompt,
      restoreEnvKeys: def.env_required || [],
    });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnAgentChild(def.command, launch.args, spawnOpts);
    } catch (e: any) {
      if (e?.code === "E2BIG" && launch.via === "arg") {
        removePromptDir(launch.promptDir);
        launch = openLaunch(true);
        try {
          child = spawnAgentChild(def.command, launch.args, spawnOpts);
        } catch (retry: any) {
          removePromptDir(launch.promptDir);
          reject(retry instanceof Error ? retry : new Error(String(retry)));
          return;
        }
      } else {
        removePromptDir(launch.promptDir);
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
    }
    let text = "";  // accumulated assistant text (the model's full output)
    let err = "";
    let buf = "";   // stdout line buffer (NDJSON)
    let meta = "";  // raw event snippets, used only for best-effort token/model telemetry
    // Keep UTF-8 code points intact across arbitrary subprocess chunk boundaries.
    // Without this, the NDJSON itself stays parseable but its text field can already
    // contain U+FFFD replacement characters by the time streamDelta reads it.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent "${name}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`agent "${name}" canceled`));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      removePromptDir(launch.promptDir);
      launch = { ...launch, promptDir: null };
    };

    const consume = (line: string) => {
      if (meta.length < MAX_OUT) meta += `${line}\n`;
      const progress = streamProgress(format, line);
      if (progress) {
        try { opts.onProgress?.(progress); } catch { /* a bad consumer must never kill the stream */ }
      }
      const piece = streamDelta(format, line);
      if (piece == null || text.length >= MAX_OUT) return;
      text += piece;
      try { onDelta?.(piece); } catch { /* a bad consumer must never kill the stream */ }
    };
    child.stdout.on("data", (d) => {
      buf += outDecoder.write(d);
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        consume(line);
      }
    });
    child.stderr.on("data", (d) => { if (err.length < MAX_OUT) err += errDecoder.write(d); });
    child.on("error", (e) => { cleanup(); reject(new Error(`failed to launch "${def.command}": ${e.message}`)); });
    child.on("close", (code, killSignal) => {
      cleanup();
      buf += outDecoder.end();
      if (err.length < MAX_OUT) err += errDecoder.end();
      if (buf.trim()) consume(buf); // flush a trailing line with no newline
      const usage = extractAgentUsage(`${meta}\n${err}`);
      // Chat's success is non-empty text (not JSON); log stderr when the stream
      // came back empty or the process exited non-zero so a failure is diagnosable.
      if (code !== 0 || !text.trim()) debugAgentStderr(name, code, err);
      const resource = code !== 0 || killSignal ? resourceFailure({ code, raw: meta, stderr: err, signal: killSignal }) : null;
      // `text` holds only assistant deltas, so the CLI's own error report (claude's
      // is_error result line) lives in `meta`. Lift it out for the classifiers.
      const failed = code !== 0 || !!killSignal || !text.trim();
      let error_text: string | null = null;
      let failure_tail: string | null = null;
      if (failed) {
        error_text = structuredErrorText(meta) || null;
        failure_tail = failureTail({ stderr: err, stdout: meta, error_text });
        logFailedAttempt(name, { op: opts.op, code, signal: killSignal ?? null, startedAt, model, reasoning, tail: failure_tail, resource });
      }
      resolve({ code, signal: killSignal ?? null, raw: text, stderr: err, parsed: extractJson(text), usage, error_text, failure_tail });
    });

    pipeAgentStdin(child, launch.stdin);
  });
}
