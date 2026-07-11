#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = fs.existsSync("/app/agents.json")
  ? "/app/agents.json"
  : path.resolve(here, "..", "agents.json");
const TIMEOUT_MS = Math.max(30_000, Number(process.env.AGENT_INSTALL_TIMEOUT_SECONDS || 300) * 1000);
const DENIED_ENV = [
  "CAIRN_AUTH_TOKEN",
  "GARMIN_PASSWORD",
  "GARMIN_USERNAME",
  "GEMINI_API_KEY",
  "GOOGLE_AI_KEY",
  "DB_PATH",
  "DATA_DIR",
  "GARMIN_TOKEN_DIR",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function safeArgv(value) {
  if (!Array.isArray(value)) return [];
  const out = value.filter((item) => typeof item === "string" && item.length > 0 && item.length <= 120);
  if (out.length !== value.length || out.length > 12) throw new Error("installer argv is invalid");
  return out;
}

export function validateInstallSpec(name, raw) {
  if (!/^[a-z0-9_-]{1,40}$/i.test(name || "")) throw new Error("invalid agent name");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`agent ${name} is not installable`);
  if (raw.method === "npm") {
    const packageName = String(raw.package || "");
    const version = String(raw.version || "");
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)) throw new Error("invalid npm package");
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error("npm installer version must be an exact semver");
    }
    return { method: "npm", package: packageName, version, args: safeArgv(raw.args) };
  }
  if (raw.method === "script") {
    const url = new URL(String(raw.url || ""));
    const sha256 = String(raw.sha256 || "").toLowerCase();
    if (url.protocol !== "https:") throw new Error("installer URL must use HTTPS");
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("installer SHA-256 is invalid");
    return { method: "script", url: url.toString(), sha256, update_args: safeArgv(raw.update_args) };
  }
  throw new Error(`unsupported installer method for ${name}`);
}

export function readAgentInstall(manifestPath, name) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const agent = manifest?.[name];
  const command = String(agent?.command || "");
  if (!/^[a-z0-9._-]{1,80}$/i.test(command)) throw new Error(`unknown agent ${name}`);
  return { command, spec: validateInstallSpec(name, agent.install) };
}

export function cliRoot(env = process.env) {
  const home = env.HOME || env.USERPROFILE || "";
  if (!home) throw new Error("HOME is required for persistent CLI installation");
  return path.resolve(env.CAIRN_CLI_ROOT || path.join(home, ".cairn-tools"));
}

function commandOnPath(command, env) {
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      if (fs.statSync(candidate).isFile() && (fs.statSync(candidate).mode & 0o111)) return candidate;
    } catch {
      // Keep scanning.
    }
  }
  return null;
}

function run(command, args, env) {
  log(`running ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { env, stdio: "inherit", timeout: TIMEOUT_MS });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function versionLine(command, env) {
  const result = spawnSync(command, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
  if (result.error) return "installed";
  return `${result.stdout || ""}${result.stderr || ""}`.trim().split(/\r?\n/)[0] || "installed";
}

function vendorCandidates(command, env, root) {
  const home = env.HOME || "";
  return [
    path.join(root, "bin", command),
    commandOnPath(command, env),
    home ? path.join(home, ".local", "bin", command) : null,
    home ? path.join(home, ".grok", "bin", command) : null,
    home ? path.join(home, ".antigravity-ide", "antigravity-ide", "bin", command) : null,
  ].filter(Boolean);
}

function persistVendorBinary(command, env, root) {
  const target = path.join(root, "bin", command);
  for (const candidate of vendorCandidates(command, env, root)) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      if (path.resolve(candidate) === path.resolve(target)) return target;
      const source = fs.realpathSync(candidate);
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o755);
      return target;
    } catch {
      // Try the next known vendor location.
    }
  }
  throw new Error(`${command} installer completed but no executable was found`);
}

function downloadVerifiedInstaller(spec, env) {
  const tmp = path.join(os.tmpdir(), `cairn-agent-installer-${randomUUID()}.sh`);
  try {
    run("curl", ["-fsSL", spec.url, "-o", tmp], env);
    const body = fs.readFileSync(tmp);
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== spec.sha256) {
      throw new Error(`installer checksum mismatch: expected ${spec.sha256}, got ${actual}`);
    }
    fs.chmodSync(tmp, 0o700);
    run("bash", [tmp], env);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

export function installAgentCli(name, options = {}) {
  const manifestPath = options.manifestPath || process.env.CAIRN_AGENT_CLI_MANIFEST || DEFAULT_MANIFEST;
  const { command, spec } = readAgentInstall(manifestPath, name);
  const root = cliRoot(options.env || process.env);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const env = { ...(options.env || process.env) };
  for (const key of DENIED_ENV) delete env[key];
  Object.assign(env, {
    CAIRN_CLI_ROOT: root,
    NPM_CONFIG_PREFIX: root,
    NPM_CONFIG_CACHE: path.join(root, ".npm-cache"),
    XDG_CACHE_HOME: path.join(root, ".cache"),
    PATH: [bin, String((options.env || process.env).PATH || "")].filter(Boolean).join(path.delimiter),
  });

  if (spec.method === "npm") {
    run("npm", ["install", "--global", "--prefix", root, `${spec.package}@${spec.version}`, ...spec.args], env);
  } else {
    const installed = commandOnPath(command, env);
    let updated = false;
    if (installed && spec.update_args.length) {
      try {
        run(command, spec.update_args, env);
        updated = true;
      } catch (error) {
        log(`first-party update failed; falling back to the verified installer: ${error.message}`);
      }
    }
    if (!updated) downloadVerifiedInstaller(spec, env);
    persistVendorBinary(command, env, root);
  }

  const installed = commandOnPath(command, env);
  if (!installed) throw new Error(`${command} is not on PATH after installation`);
  log(`ok: ${name} -> ${versionLine(command, env)}`);
  return { name, command, root };
}

async function main() {
  const names = process.argv.slice(2);
  if (!names.length) throw new Error("usage: cairn-update-agent-clis <agent> [agent...]");
  for (const name of names) installAgentCli(name);
  log("agent CLI install/update complete");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`agent CLI install failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
