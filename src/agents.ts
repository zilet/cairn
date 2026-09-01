import { spawn, spawnSync } from "node:child_process";
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
  type AgentAvailabilityState,
  type AgentFailure,
} from "./agentAvailability.js";
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
  console.error(`[agent:${name}] exit ${code} stderr:\n${s.slice(0, 4000)}`);
}

export type ReasoningLevel = "low" | "medium" | "high" | "xhigh" | "max";

// Cairn's provider-NEUTRAL model classes. An operation asks for a class ("this is
// cheap structuring" vs "this is the hard read"); each agents.json entry maps the
// classes IT supports onto its own CLI model name via `model_classes`. Nothing in
// src/ names a concrete model, and an agent that declares no mapping simply runs on
// its own configured default — which is why an Anthropic alias never reaches a
// non-Anthropic CLI.
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
  env_required?: string[];        // env vars that indicate this agent is usable
  web_access?: boolean;           // declares this CLI can browse the live web (drives research routing)
  // Declarative login / connected-state fields (Agent Connect). Every argv array is
  // APPENDED to `command` (like `args`). None of these change how a coaching run is
  // built — they drive the login flow, the connected-state probe, and read-only
  // model visibility only. `command`/`args`/`input`/`stream` stay exactly as before.
  login?: string[] | null;        // argv to start the interactive login flow (run by the PTY bridge, Stream A)
  status_check?: string[] | null; // argv for a non-interactive login probe; its STDOUT is parsed (NEVER the exit code) — see agentConfigured
  auth_state?: string[] | null; // HOME-relative paths whose presence is a fallback "logged in" signal when there is no status_check
  models_list?: string[] | null; // argv that prints the available models (grok/agy); null ⇒ no model catalog
  model_flag?: string[] | null; // ["--model","{model}"] — expanded only at an explicit {model_args} slot
  // This provider's own name for each Cairn model class, e.g. {"fast":"sonnet","deep":"opus"}.
  // Pin an ALIAS, never a dated id, so a new generation ships without a code change.
  // Omit the map (or a class) to let the CLI use whatever model it is configured with.
  model_classes?: Partial<Record<ModelClass, string>>;
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
  // Optional, server-owned lazy-install contract. The browser can select only an
  // agent name; package names, versions, URLs and checksums always come from this
  // bundled manifest. Installed files live under the persistent app HOME.
  install?:
    | { method: "npm"; package: string; version: string; args?: string[] }
    | { method: "script"; url: string; sha256: string; update_args?: string[] };
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
    // whether this agent declares an interactive login flow / a model catalog —
    // pure config reads, surfaced so the UI can render the right affordances.
    can_login: def.login != null,
    models_list: def.models_list != null,
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

// Fallback signal when an agent has no `status_check`: any of its HOME-relative
// auth_state paths exists. Used only where a status probe isn't available.
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
function parseStatusOutput(name: string, stdout: string): boolean | null {
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
  // Generic fallback for any future status_check: an explicit "not logged in".
  if (/not logged in|logged out|please (log|sign) in/i.test(s)) return false;
  return null;
}

function probeConfigured(name: string, def: AgentDef): boolean | null {
  // 1. A status_check is the strongest signal — run it and parse stdout.
  if (Array.isArray(def.status_check) && def.status_check.length) {
    // Don't even spawn if the binary isn't installed (and don't false-negative —
    // an absent binary is "present:false" territory, not "logged out").
    if (!commandPresent(def.command)) return null;
    try {
      const r = spawnSync(def.command, def.status_check, {
        ...buildAgentSpawnOptions({ kind: "status", restoreEnvKeys: def.env_required || [] }),
        timeout: 5000,
        encoding: "utf8",
      });
      // A spawn error (ENOENT / timeout) tells us nothing about login state.
      if (r.error) return null;
      // claude emits its JSON on stdout — parse THAT alone first so a stderr notice
      // (update banner, deprecation warning) can't corrupt the JSON parse. Fall back
      // to the combined stream only for the plain-text heuristics.
      let verdict = parseStatusOutput(name, r.stdout || "");
      if (verdict === null) verdict = parseStatusOutput(name, (r.stdout || "") + "\n" + (r.stderr || ""));
      if (verdict !== null) return verdict;
      // status_check ran but we couldn't read it — fall through to auth_state.
    } catch { /* fall through to the fallback signals */ }
  }
  // 2. grok has no status command. The HEADLESS path needs XAI_API_KEY; the in-app
  //    `grok login --device-auth` flow instead writes ~/.grok/auth.json. So an env
  //    key is a definite yes, but its absence is NOT a no — fall through to the
  //    auth_state check below so a Connect login flips Installed → Connected.
  if (name === "grok" && process.env.XAI_API_KEY) return true;
  // 3. auth_state fallback: a known post-login file/dir exists ⇒ logged in; absent
  //    ⇒ null (NOT false — many CLIs create the dir before login, so absence is
  //    only weak evidence and we must never exclude on it).
  if (authStatePresent(def)) return true;
  return null;
}

// Public tri-state: true logged-in / false logged-out / null undetectable.
export function agentConfigured(name: string): boolean | null {
  if (configuredCache.has(name)) return configuredCache.get(name) ?? null;
  const def = loadAgents()[name];
  let verdict: boolean | null = null;
  if (def) {
    try { verdict = probeConfigured(name, def); } catch { verdict = null; }
  }
  configuredCache.set(name, verdict);
  return verdict;
}

// Drop the cached login verdict AND the derived version/model read-caches, so the
// next probe re-reads everything. Called after an in-app login completes (the
// boot-time probe ran before the auth state existed — without this the card stays
// "Installed" until restart) and after a CLI update (so a new version / model list
// shows without a restart).
export function invalidateAgentConfigured(name?: string): void {
  _codexModel = undefined; // codex model is read from ~/.codex/config.toml
  // A completed login is exactly the event a persisted auth hold was waiting for
  // — drop it here rather than making the person wait out the re-probe leash.
  for (const agent of name ? [name] : Object.keys(loadAgents())) availabilityClear(agent);
  if (name) {
    configuredCache.delete(name);
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
    modelsRawCache.clear();
    modelsCache.clear();
    versionCache.clear();
  }
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
  // codex has no `models` catalog, but its CURRENT model is pinned in
  // ~/.codex/config.toml (`model = "…"`) — a free, local, read-only lookup (never a
  // coaching/paid call). null when unpinned ⇒ the UI shows "—".
  if (name === "codex") return readCodexConfigModel();
  // The catalog listing exposes the default for free: `grok models` (and similarly
  // `agy models`) prints a "Default model: <id>" line above the catalog. Read THAT —
  // never a coaching/paid call. null when no such line exists ⇒ the UI shows "—".
  return parseDefaultModel(rawModelsOutput(name));
}

// Read codex's pinned model from ~/.codex/config.toml. codex exposes no `models`
// catalog command, so this config read is its only free, non-interactive current-
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
      });
      if (!r.error) raw = `${r.stdout || ""}\n${r.stderr || ""}`;
    } catch { raw = ""; }
  }
  modelsRawCache.set(name, raw);
  return raw;
}

// Read a CLI's model catalog (grok/agy declare `models_list`). Returns a clean
// string[] (one model per line), or [] for a CLI with no catalog / on any failure.
// Informational only — no pinning this batch.
const modelsCache = new Map<string, string[]>();

export function listAgentModels(name: string): string[] {
  const def = loadAgents()[name];
  if (!def || !Array.isArray(def.models_list) || !def.models_list.length) return [];
  if (modelsCache.has(name)) return modelsCache.get(name) ?? [];
  const models = parseModelsOutput(rawModelsOutput(name));
  modelsCache.set(name, models);
  return models;
}

// Parse a `models` listing into clean entries. CLIs print one model per line
// (sometimes with a leading bullet/marker, a trailing " (current)" note, or a
// status/banner line first); keep the model entries, drop empties/headers/banners.
// Conservative + capped. Informational only — no pinning this batch — so a stray
// banner line is cosmetic, not load-bearing.
export function parseModelsOutput(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const lineRaw of (raw || "").split(/\r?\n/)) {
    let line = lineRaw.trim();
    if (!line) continue;
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
}

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
 * THIS agent can actually take. Never throws and never invents a value — an agent
 * with no mapping for the class, no model flag, or no reasoning support simply gets
 * that field omitted and runs on its own default. The offline stub always resolves
 * to nothing (it ignores execution profiles by contract).
 */
export function resolveAgentProfileForClass(
  def: AgentDef | undefined,
  want: AbstractExecutionProfile | undefined
): { model?: string; reasoning?: ReasoningLevel } {
  if (!def || !want) return {};
  const capabilities = normalizedAgentCapabilities(def);
  if (capabilities.execution_profile_noop) return {};
  const out: { model?: string; reasoning?: ReasoningLevel } = {};
  if (capabilities.model && Array.isArray(def.model_flag)) {
    const model = String(want.model ?? (want.model_class ? def.model_classes?.[want.model_class] : "") ?? "").trim();
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

function expandAgentArgs(
  def: AgentDef,
  args: string[],
  prompt: string,
  useStdin: boolean,
  mcpConfigArgs: string[] = [],
  requestedProfile: Pick<RunOpts, "model" | "reasoning"> = {},
  structuredArgs: string[] = []
): string[] {
  const profile = resolveAgentExecutionProfile(def, requestedProfile).effective;
  const dataDir = path.resolve(agentDataDir(process.env));
  const needsFileAccess = promptReferencesDataDir(prompt);
  const images = needsFileAccess ? extractPromptImagePaths(prompt) : [];
  const replaceCommon = (s: string, image?: string) => s
    .replaceAll("{data_dir}", dataDir)
    .replaceAll("{image}", image ?? "")
    .replaceAll("{prompt}", useStdin ? "{prompt}" : prompt);
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
    const expanded = replaceCommon(arg);
    if (expanded !== "") out.push(expanded);
  }
  if (profile.model && !expandedModel) throw new Error("Agent argv template has no {model_args} slot");
  if (profile.reasoning && !expandedReasoning) throw new Error("Agent argv template has no {reasoning_args} slot");
  return out;
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

function acceptsParsed(result: AgentResult, acceptParsed?: (parsed: any) => boolean): boolean {
  if (!result.parsed) return false;
  if (!acceptParsed) return true;
  try {
    return acceptParsed(result.parsed) === true;
  } catch {
    return false;
  }
}

export interface AgentUsage {
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

export interface AgentResult {
  code: number | null;
  raw: string;
  stderr: string;
  parsed: any | null;
  usage?: AgentUsage;
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
      const wasteful = !!failure && (availabilityHolds(failure.state) || failure.state === "permission_denied");
      if (!acceptedBeforeRepair && !wasteful && !signal?.aborted) {
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
      });
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

export function runAgent(name: string, prompt: string, opts: RunOpts | number = {}): Promise<AgentResult> {
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
  return runAgentImpl(name, prompt, timeoutMs, signal, extract, mcpConfigArgs, model, reasoning, schema);
}

// ---------- subprocess env/workdir hardening (Trust build V1) ----------
// The agent CLIs are full subprocesses and (for research/grounding) now have web
// egress, so the blast radius of an exfiltrated secret is real. The shared helper
// passes a COPY of process.env with Cairn-only secrets/config removed, and runs
// ordinary subprocesses from DATA_DIR/.agent-workspaces/<kind> instead of DATA_DIR
// itself. Prompts that hand the CLI an absolute uploaded-file path still use
// DATA_DIR as cwd for compatibility with CLI file-read permissions.

function runAgentImpl(
  name: string,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
  extract?: (text: string) => any | null,
  mcpConfigArgs?: string[],
  model?: string,
  reasoning?: ReasoningLevel,
  schema?: JsonSchema
): Promise<AgentResult> {
  const def = loadAgents()[name];
  if (!def) return Promise.reject(new Error(`Unknown agent "${name}"`));

  const useStdin = def.input === "stdin";
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
  const args = expandAgentArgs(def, def.args, prompt, useStdin, mcpConfigArgs, { model, reasoning }, structuredArgs);
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

  // Idempotent: the schema file outlives neither a clean close, a timeout kill, an
  // abort, nor a failed launch.
  const removeSchemaDir = () => {
    if (!schemaDir) return;
    const target = schemaDir;
    schemaDir = null;
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  return new Promise((resolve, reject) => {
    // Already-aborted before launch (Stop landed while queued): don't spawn.
    if (signal?.aborted) { removeSchemaDir(); reject(new Error(`agent "${name}" canceled`)); return; }
    if (name === "antigravity") {
      try { ensureAntigravityHeadlessPermissions(); } catch { /* never block a spawn */ }
    }
    const child = spawn(def.command, args, buildAgentSpawnOptions({
      kind: "agent",
      prompt,
      restoreEnvKeys: def.env_required || [],
    }));
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
      removeSchemaDir();
    };

    child.stdout.on("data", (d) => { if (out.length < MAX_OUT) out += outDecoder.write(d); });
    child.stderr.on("data", (d) => { if (err.length < MAX_OUT) err += errDecoder.write(d); });
    child.on("error", (e) => {
      cleanup();
      reject(new Error(`failed to launch "${def.command}": ${e.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      if (out.length < MAX_OUT) out += outDecoder.end();
      if (err.length < MAX_OUT) err += errDecoder.end();
      const parsed = parseOut(out);
      const usage = extractAgentUsage(`${out}\n${err}`);
      // Surface stderr (under DEBUG) when the run looks unhealthy: a non-zero exit,
      // or a clean exit that nonetheless produced no parseable JSON. This is what
      // a self-hoster needs to see "not logged in" / "no such model" first-run errors.
      if (code !== 0 || !parsed) debugAgentStderr(name, code, err);
      resolve({ code, raw: out, stderr: err, parsed, usage });
    });

    if (useStdin) child.stdin.write(prompt);
    child.stdin.end();
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
export function runAgentStreaming(name: string, prompt: string, opts: StreamRunOpts = {}): Promise<AgentResult> {
  const def = loadAgents()[name];
  if (!def) return Promise.reject(new Error(`Unknown agent "${name}"`));
  if (!def.stream?.args?.length) return runAgent(name, prompt, opts); // no stream mode → one-shot
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = opts.signal;
  const onDelta = opts.onDelta;
  const format = def.stream.format;
  const useStdin = def.input === "stdin";
  // No structuredArgs, deliberately: `stream.args` declares no {schema_args} slot for
  // any provider. A streamed op is prose-first (reply marker, then optional actions),
  // which a JSON schema would destroy — and grok's --json-schema would override its own
  // --output-format streaming-json. RunOpts.schema is therefore inert while streaming.
  const args = expandAgentArgs(
    def,
    def.stream.args,
    prompt,
    useStdin,
    opts.mcpConfigArgs,
    withResolvedProfile(name, opts)
  );
  const MAX_OUT = 4 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(`agent "${name}" canceled`)); return; }
    if (name === "antigravity") {
      try { ensureAntigravityHeadlessPermissions(); } catch { /* never block a spawn */ }
    }
    const child = spawn(def.command, args, buildAgentSpawnOptions({
      kind: "chat",
      prompt,
      restoreEnvKeys: def.env_required || [],
    }));
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
    const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); };

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
    child.on("close", (code) => {
      cleanup();
      buf += outDecoder.end();
      if (err.length < MAX_OUT) err += errDecoder.end();
      if (buf.trim()) consume(buf); // flush a trailing line with no newline
      const usage = extractAgentUsage(`${meta}\n${err}`);
      // Chat's success is non-empty text (not JSON); log stderr when the stream
      // came back empty or the process exited non-zero so a failure is diagnosable.
      if (code !== 0 || !text.trim()) debugAgentStderr(name, code, err);
      resolve({ code, raw: text, stderr: err, parsed: extractJson(text), usage });
    });

    if (useStdin) child.stdin.write(prompt);
    child.stdin.end();
  });
}
