import type { SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const AGENT_WORKSPACES_DIRNAME = ".agent-workspaces";

// The agent CLIs are full subprocesses and can have web egress. Keep inherited
// env broad enough for CLI auth and normal shell behavior, but strip Cairn-owned
// secrets/config the CLIs never need.
export const AGENT_ENV_DENYLIST = [
  "CAIRN_AUTH_TOKEN",   // the shared API/MCP gate token - never the CLI's business
  "GARMIN_PASSWORD",    // Garmin credentials
  "GARMIN_USERNAME",
  "GEMINI_API_KEY",     // image/text-art keys (Cairn's own Gemini calls, not the CLI's)
  "GOOGLE_AI_KEY",
  "DB_PATH",            // host filesystem layout - internal config the CLI shouldn't see
  "DATA_DIR",           // used to pick cwd; not needed (or wanted) in child env
  "GARMIN_TOKEN_DIR",
];

export function agentCliPath(source: NodeJS.ProcessEnv = process.env): string {
  const home = source.HOME || source.USERPROFILE || "";
  const preferred = [
    "/usr/local/bin",
    home ? path.join(home, ".local", "bin") : "",
    home ? path.join(home, ".grok", "bin") : "",
    home ? path.join(home, ".antigravity-ide", "antigravity-ide", "bin") : "",
    "/usr/bin",
    "/bin",
  ];
  const existing = String(source.PATH || "").split(path.delimiter);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...preferred, ...existing]) {
    const p = raw.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join(path.delimiter);
}

export function sanitizeAgentEnv(
  source: NodeJS.ProcessEnv = process.env,
  restoreKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const k of AGENT_ENV_DENYLIST) delete env[k];
  for (const k of restoreKeys) {
    if (source[k] !== undefined) env[k] = source[k];
  }
  env.PATH = agentCliPath(source);
  return env;
}

export function agentDataDir(source: NodeJS.ProcessEnv = process.env): string {
  return source.DATA_DIR || path.join(__dirname, "..", "data");
}

function safeWorkspaceName(kind: string): string {
  return (kind || "agent").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "agent";
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function chmodPrivate(p: string): void {
  try {
    fs.chmodSync(p, 0o700);
  } catch {
    /* best effort on filesystems that do not support chmod */
  }
}

function promptReferencesDataDirPath(prompt: string | undefined, dataDir: string): boolean {
  if (!prompt) return false;
  const root = path.resolve(dataDir);
  return prompt.includes(root + path.sep) || prompt.includes(root + "/");
}

export function promptReferencesDataDir(
  prompt: string | undefined,
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  return promptReferencesDataDirPath(prompt, agentDataDir(source));
}

export function agentExecutionCwd(
  kind = "agent",
  opts: { prompt?: string; sourceEnv?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const sourceEnv = opts.sourceEnv || process.env;
  const dataDir = path.resolve(agentDataDir(sourceEnv));

  // Uploaded health docs/photos are intentionally handed to agents as absolute
  // DATA_DIR paths. Keep those compatibility runs at DATA_DIR so existing CLI
  // file-read permissions do not regress; ordinary chat/login/update/probe runs
  // get an isolated workspace below.
  if (promptReferencesDataDirPath(opts.prompt, dataDir) && dirExists(dataDir)) return dataDir;

  const root = path.join(dataDir, AGENT_WORKSPACES_DIRNAME);
  const cwd = path.join(root, safeWorkspaceName(kind));
  try {
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    chmodPrivate(root);
    chmodPrivate(cwd);
    return cwd;
  } catch {
    return dirExists(dataDir) ? dataDir : undefined;
  }
}

export function buildAgentSpawnOptions(opts: {
  kind?: string;
  prompt?: string;
  sourceEnv?: NodeJS.ProcessEnv;
  restoreEnvKeys?: readonly string[];
} = {}): SpawnOptionsWithoutStdio {
  const sourceEnv = opts.sourceEnv || process.env;
  const env = sanitizeAgentEnv(sourceEnv, opts.restoreEnvKeys || []);
  const cwd = agentExecutionCwd(opts.kind || "agent", { prompt: opts.prompt, sourceEnv });
  return cwd ? { cwd, env } : { env };
}
