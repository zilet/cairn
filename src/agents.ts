import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDataDir, buildAgentSpawnOptions, promptReferencesDataDir } from "./agentExecution.js";
export { AGENT_ENV_DENYLIST, agentExecutionCwd, buildAgentSpawnOptions, promptReferencesDataDir, sanitizeAgentEnv } from "./agentExecution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.AGENTS_CONFIG || path.join(__dirname, "..", "agents.json");

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

export interface AgentDef {
  command: string;
  args: string[];                 // "{prompt}" is substituted with the full prompt
  input?: "arg" | "stdin";        // how the prompt reaches the CLI (default: arg)
  description?: string;
  env_required?: string[];        // env vars that indicate this agent is usable
  // Declarative login / connected-state fields (Agent Connect). Every argv array is
  // APPENDED to `command` (like `args`). None of these change how a coaching run is
  // built — they drive the login flow, the connected-state probe, and read-only
  // model visibility only. `command`/`args`/`input`/`stream` stay exactly as before.
  login?: string[] | null;        // argv to start the interactive login flow (run by the PTY bridge, Stream A)
  status_check?: string[] | null; // argv for a non-interactive login probe; its STDOUT is parsed (NEVER the exit code) — see agentConfigured
  auth_state?: string[] | null;   // HOME-relative paths whose presence is a fallback "logged in" signal when there is no status_check
  models_list?: string[] | null;  // argv that prints the available models (grok/agy); null ⇒ no model catalog
  model_flag?: string[] | null;   // ["--model","{model}"] — DECLARED for a future optional pin; UNUSED this batch (never injected)
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
    // whether the agent's CLI binary is actually installed/on PATH (cached probe)
    present: commandPresent(def.command),
    // tri-state login/connected probe (true logged-in / false logged-out / null
    // undetectable). Only `false` excludes from the rotation — see agentConfigured.
    configured: agentConfigured(name),
    // whether this agent declares an interactive login flow / a model catalog —
    // pure config reads, surfaced so the UI can render the right affordances.
    can_login: def.login != null,
    models_list: def.models_list != null,
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

function lookupOnPath(cmd: string): boolean {
  // Absolute / relative path → just stat it.
  if (cmd.includes("/")) {
    try { return fs.existsSync(cmd); } catch { return false; }
  }
  const PATH = process.env.PATH || "";
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
  if (name) {
    configuredCache.delete(name);
    modelsRawCache.delete(name);
    modelsCache.delete(name);
    const cmd = loadAgents()[name]?.command;
    if (cmd) versionCache.delete(cmd);
  } else {
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
  signal?: AbortSignal;   // abort to kill the live subprocess mid-run (chat-turn Stop)
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
  return out.slice(0, 8);
}

function expandAgentArgs(def: AgentDef, args: string[], prompt: string, useStdin: boolean): string[] {
  const dataDir = path.resolve(agentDataDir(process.env));
  const needsFileAccess = promptReferencesDataDir(prompt);
  const images = needsFileAccess ? extractPromptImagePaths(prompt) : [];
  const replaceCommon = (s: string, image?: string) => s
    .replaceAll("{data_dir}", dataDir)
    .replaceAll("{image}", image ?? "")
    .replaceAll("{prompt}", useStdin ? "{prompt}" : prompt);
  const out: string[] = [];
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
    const expanded = replaceCommon(arg);
    if (expanded !== "") out.push(expanded);
  }
  return out;
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
  const signal = o.signal;
  const tried: { agent: string; error: string }[] = [];

  // Prefer agents whose breaker is closed; tripped ones go to the back so they're
  // only probed when nothing healthier is available.
  const healthy = order.filter((n) => !breakerIsOpen(n));
  const tripped = order.filter((n) => breakerIsOpen(n));
  const sequence = [...healthy, ...tripped];

  for (let i = 0; i < sequence.length; i++) {
    // Abort = a deliberate Stop: bail the whole rotation, never fall through to
    // the next agent (the caller wants the turn killed, not retried elsewhere).
    if (signal?.aborted) throw new Error("canceled");
    const name = sequence[i];
    const isProbe = breakerIsOpen(name);
    // A tripped agent is probed only on a short leash; if healthier agents exist
    // and this one is tripped, it's already at the back of the line.
    const timeoutMs = isProbe ? Math.min(baseTimeout, BREAKER_PROBE_TIMEOUT_MS) : baseTimeout;
    const started = Date.now();
    let triedJson = false;
    try {
      let result = await runAgent(name, prompt, { timeoutMs, signal });
      // One-shot JSON-repair retry: it ran but emitted nothing parseable.
      if (!result.parsed && !signal?.aborted) {
        triedJson = true;
        try {
          result = await runAgent(name, prompt + JSON_REPAIR_SUFFIX, { timeoutMs, signal });
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
      if (signal?.aborted) throw e; // canceled mid-run — stop the rotation
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
  const signal = typeof opts === "number" ? undefined : opts.signal;
  return runAgentImpl(name, prompt, timeoutMs, signal);
}

// ---------- subprocess env/workdir hardening (Trust build V1) ----------
// The agent CLIs are full subprocesses and (for research/grounding) now have web
// egress, so the blast radius of an exfiltrated secret is real. The shared helper
// passes a COPY of process.env with Cairn-only secrets/config removed, and runs
// ordinary subprocesses from DATA_DIR/.agent-workspaces/<kind> instead of DATA_DIR
// itself. Prompts that hand the CLI an absolute uploaded-file path still use
// DATA_DIR as cwd for compatibility with CLI file-read permissions.

function runAgentImpl(name: string, prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentResult> {
  const def = loadAgents()[name];
  if (!def) return Promise.reject(new Error(`Unknown agent "${name}"`));

  const useStdin = def.input === "stdin";
  const args = expandAgentArgs(def, def.args, prompt, useStdin);

  // Cap accumulated output so a runaway/verbose CLI can't balloon RSS on a small
  // host (e.g. the Pi), especially during a multi-job enrichment queue drain.
  const MAX_OUT = 4 * 1024 * 1024; // 4 MB — far beyond any real JSON proposal.

  return new Promise((resolve, reject) => {
    // Already-aborted before launch (Stop landed while queued): don't spawn.
    if (signal?.aborted) { reject(new Error(`agent "${name}" canceled`)); return; }
    const child = spawn(def.command, args, buildAgentSpawnOptions({
      kind: "agent",
      prompt,
      restoreEnvKeys: def.env_required || [],
    }));
    let out = "";
    let err = "";
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
    const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); };

    child.stdout.on("data", (d) => { if (out.length < MAX_OUT) out += d.toString(); });
    child.stderr.on("data", (d) => { if (err.length < MAX_OUT) err += d.toString(); });
    child.on("error", (e) => {
      cleanup();
      reject(new Error(`failed to launch "${def.command}": ${e.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      const parsed = extractJson(out);
      // Surface stderr (under DEBUG) when the run looks unhealthy: a non-zero exit,
      // or a clean exit that nonetheless produced no parseable JSON. This is what
      // a self-hoster needs to see "not logged in" / "no such model" first-run errors.
      if (code !== 0 || !parsed) debugAgentStderr(name, code, err);
      resolve({ code, raw: out, stderr: err, parsed });
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
  const args = expandAgentArgs(def, def.stream.args, prompt, useStdin);
  const MAX_OUT = 4 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(`agent "${name}" canceled`)); return; }
    const child = spawn(def.command, args, buildAgentSpawnOptions({
      kind: "chat",
      prompt,
      restoreEnvKeys: def.env_required || [],
    }));
    let text = "";  // accumulated assistant text (the model's full output)
    let err = "";
    let buf = "";   // stdout line buffer (NDJSON)
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
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        consume(line);
      }
    });
    child.stderr.on("data", (d) => { if (err.length < MAX_OUT) err += d.toString(); });
    child.on("error", (e) => { cleanup(); reject(new Error(`failed to launch "${def.command}": ${e.message}`)); });
    child.on("close", (code) => {
      cleanup();
      if (buf.trim()) consume(buf); // flush a trailing line with no newline
      // Chat's success is non-empty text (not JSON); log stderr when the stream
      // came back empty or the process exited non-zero so a failure is diagnosable.
      if (code !== 0 || !text.trim()) debugAgentStderr(name, code, err);
      resolve({ code, raw: text, stderr: err, parsed: extractJson(text) });
    });

    if (useStdin) child.stdin.write(prompt);
    child.stdin.end();
  });
}
