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
  const spec = validateInstallMethod(name, raw);
  // How much disk a fresh install needs (measured, MB) — checked against the CLI root's
  // free space before anything is downloaded. Optional: no estimate, no pre-check.
  const size = Number(raw.size_mb);
  spec.size_mb = raw.size_mb == null ? null : Number.isFinite(size) && size > 0 && size <= 10_000 ? Math.ceil(size) : null;
  if (raw.size_mb != null && spec.size_mb == null) throw new Error("install size_mb is invalid");
  // HOME-relative vendor copies Cairn removes once its own copy runs (grok's installer
  // and `grok update` keep a second ~170 MB binary in ~/.grok). Plain relative paths only.
  const cleanup = Array.isArray(raw.cleanup) ? raw.cleanup.map(String) : [];
  for (const rel of cleanup) {
    if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(rel) || rel.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error(`install cleanup path ${rel} is invalid`);
    }
  }
  spec.cleanup = cleanup;
  return spec;
}

function validateInstallMethod(name, raw) {
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
    const url = httpsUrl(raw.url, "installer URL");
    const sha256 = String(raw.sha256 || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("installer SHA-256 is invalid");
    return { method: "script", url, sha256, update_args: safeArgv(raw.update_args) };
  }
  if (raw.method === "binary") {
    const version = String(raw.version || "");
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error("binary installer version must be an exact semver");
    const artifacts = {};
    const rawArtifacts = raw.artifacts && typeof raw.artifacts === "object" && !Array.isArray(raw.artifacts) ? raw.artifacts : {};
    for (const [platform, artifact] of Object.entries(rawArtifacts)) {
      if (!/^[a-z0-9]+-[a-z0-9_]+(?:-musl)?$/.test(platform)) throw new Error(`invalid artifact platform ${platform}`);
      artifacts[platform] = validateArtifact(platform, artifact);
    }
    const script = raw.script == null ? null : httpsUrl(raw.script, "vendor installer URL");
    if (!Object.keys(artifacts).length && !script) throw new Error(`agent ${name} declares no artifact or vendor installer`);
    return { method: "binary", version, artifacts, script, update_args: safeArgv(raw.update_args) };
  }
  throw new Error(`unsupported installer method for ${name}`);
}

// Every download Cairn makes is HTTPS with no embedded credentials; curl is also told
// never to follow a redirect off HTTPS (see `fetchTo`).
function httpsUrl(value, what) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") throw new Error(`${what} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${what} must not carry credentials`);
  return url.toString();
}

function validateArtifact(platform, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`artifact ${platform} is invalid`);
  const url = httpsUrl(raw.url, `artifact ${platform} URL`);
  const sha256 = raw.sha256 == null ? null : String(raw.sha256).toLowerCase();
  const sha512 = raw.sha512 == null ? null : String(raw.sha512).toLowerCase();
  if (sha256 != null && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`artifact ${platform} SHA-256 is invalid`);
  if (sha512 != null && !/^[a-f0-9]{128}$/.test(sha512)) throw new Error(`artifact ${platform} SHA-512 is invalid`);
  if (!sha256 && !sha512) throw new Error(`artifact ${platform} needs a sha256 or sha512 pin`);
  const archive = String(raw.archive || "none");
  if (!["none", "gz", "tar.gz"].includes(archive)) throw new Error(`artifact ${platform} archive type is invalid`);
  const entry = raw.entry == null ? null : String(raw.entry);
  if (archive === "tar.gz" && !(entry && /^[A-Za-z0-9._-]{1,80}$/.test(entry) && !entry.startsWith("."))) {
    throw new Error(`artifact ${platform} needs the archive entry to extract`);
  }
  return { url, algorithm: sha512 ? "sha512" : "sha256", digest: sha512 || sha256, archive, entry };
}

export function readAgentInstall(manifestPath, name) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const agent = manifest?.[name];
  const command = String(agent?.command || "");
  if (!/^[a-z0-9._-]{1,80}$/i.test(command)) throw new Error(`unknown agent ${name}`);
  const label = typeof agent?.label === "string" && agent.label.trim() ? agent.label.trim() : name;
  return { command, label, spec: validateInstallSpec(name, agent.install) };
}

// The artifact key for this host, in the manifest's own spelling (`linux-x64`,
// `darwin-arm64`, `linux-x64-musl`). A musl Linux never matches a glibc pin, so it
// goes to the vendor's own installer, which picks the musl build itself.
export function platformKey(platform = process.platform, arch = process.arch, musl = isMusl()) {
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : arch;
  return `${platform}-${cpu}${platform === "linux" && musl ? "-musl" : ""}`;
}

function isMusl() {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport?.();
    if (report?.header && !report.header.glibcVersionRuntime) return true;
  } catch {}
  return fs.existsSync("/lib/libc.musl-x86_64.so.1") || fs.existsSync("/lib/libc.musl-aarch64.so.1");
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
  // Cairn's own timeout sends SIGTERM (and reports ETIMEDOUT above); a SIGKILL nobody
  // here sent is the kernel's OOM killer.
  if (result.signal === "SIGKILL" || result.status === 137) throw outOfMemoryError("a provider");
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
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
  // Pick the NEWEST build among the known locations, then persist it at root/bin.
  // The old rule scanned root/bin first and returned it as "already persisted", so a
  // first-party `update` that wrote into the vendor's own directory (grok: ~/.grok/bin)
  // never reached the copy on PATH — grok sat at 0.2.93 in .cairn-tools/bin while
  // ~/.grok/bin held 1.0.13. Newest-mtime wins in both directions: a vendor that
  // updates in place at root/bin (agy) keeps its copy, and a stale leftover in
  // ~/.local/bin never overwrites a fresher one.
  let newest = null;
  for (const candidate of vendorCandidates(command, env, root)) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { candidate, mtimeMs: stat.mtimeMs };
    } catch {
      // Not present at this location.
    }
  }
  if (!newest) throw new Error(`${command} installer completed but no executable was found`);
  if (path.resolve(newest.candidate) === path.resolve(target)) return target;
  const source = fs.realpathSync(newest.candidate);
  // Replace a link at root/bin rather than writing through it into a vendor directory
  // (the cleanup below may delete that directory).
  try {
    if (fs.lstatSync(target).isSymbolicLink()) fs.rmSync(target, { force: true });
  } catch {}
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
  return target;
}

// curl with HTTPS pinned end to end: `--proto =https` refuses any other scheme and
// `--proto-redir =https` refuses a redirect that would leave HTTPS. A failed fetch is a
// `download_failed` error — the caller may fall back; a checksum mismatch never may.
function fetchTo(url, output, env) {
  try {
    run("curl", ["-fsSL", "--proto", "=https", "--proto-redir", "=https", url, "-o", output], env);
  } catch (error) {
    throw Object.assign(new Error(`could not download ${url}: ${error.message}`), { code: "download_failed" });
  }
}

function digestOf(file, algorithm) {
  const hash = createHash(algorithm);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

// The checksum Cairn ships with no longer matches what the vendor served. For a pinned,
// VERSIONED artifact that is never "the vendor moved on" (a new release gets a new URL),
// so it is treated as an integrity failure: nothing is installed and there is no
// fallback. The message leads with plain words; the hashes follow for whoever debugs it.
function integrityError(label, what, algorithm, expected, actual) {
  return Object.assign(
    new Error(
      `${label}'s ${what} didn't match the checksum Cairn ships with, so nothing was installed. ` +
        `(${algorithm} expected ${expected}, got ${actual})`
    ),
    { code: "integrity" }
  );
}

// Install one pinned, versioned vendor build: download, verify, unpack, then place it at
// root/bin/<command> by rename so a half-written binary is never on PATH.
function installPinnedArtifact(artifact, { command, label, root, env }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-agent-artifact-"));
  try {
    const payload = path.join(stage, "payload");
    fetchTo(artifact.url, payload, env);
    const actual = digestOf(payload, artifact.algorithm);
    if (actual !== artifact.digest) throw integrityError(label, "download", artifact.algorithm, artifact.digest, actual);
    let binary = payload;
    if (artifact.archive === "gz") {
      binary = path.join(stage, command);
      const out = fs.openSync(binary, "w", 0o700);
      try {
        const result = spawnSync("gzip", ["-dc", payload], { env, stdio: ["ignore", out, "inherit"], timeout: TIMEOUT_MS });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`gzip exited with status ${result.status}`);
      } finally {
        fs.closeSync(out);
      }
    } else if (artifact.archive === "tar.gz") {
      run("tar", ["-xzf", payload, "-C", stage, artifact.entry], env);
      binary = path.join(stage, artifact.entry);
      const stat = fs.lstatSync(binary);
      if (!stat.isFile()) throw new Error(`${artifact.entry} in the ${label} archive is not a regular file`);
    }
    const target = path.join(root, "bin", command);
    const tmpTarget = `${target}.${randomUUID()}.tmp`;
    fs.copyFileSync(binary, tmpTarget);
    fs.chmodSync(tmpTarget, 0o755);
    fs.renameSync(tmpTarget, target);
    return target;
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  }
}

// The vendor's own documented installer (`curl -fsSL <url> | bash`), fetched over HTTPS
// from the vendor host. Used only when no pinned build fits this host or the pinned build
// is gone from the vendor's storage — it is what keeps an old Cairn installable after a
// vendor prunes old releases. Both vendors' scripts resolve the CURRENT release from
// their own servers (Antigravity also checks its SHA-512 from its own manifest).
function runVendorScript(url, env, pinnedSha256 = null, label = "the vendor") {
  const tmp = path.join(os.tmpdir(), `cairn-agent-installer-${randomUUID()}.sh`);
  try {
    fetchTo(url, tmp, env);
    if (pinnedSha256) {
      const actual = digestOf(tmp, "sha256");
      if (actual !== pinnedSha256) throw integrityError(label, "installer script", "sha256", pinnedSha256, actual);
    }
    fs.chmodSync(tmp, 0o700);
    run("bash", [tmp], env);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function installBinary(spec, ctx) {
  const key = platformKey();
  const artifact = spec.artifacts[key];
  if (artifact) {
    try {
      installPinnedArtifact(artifact, ctx);
      log(`installed pinned ${ctx.label} ${spec.version} (${key})`);
      return;
    } catch (error) {
      if (error?.code !== "download_failed" || !spec.script) throw error;
      log(`pinned ${ctx.label} ${spec.version} is no longer downloadable; using ${ctx.label}'s own installer instead`);
    }
  } else if (!spec.script) {
    throw new InstallError("unsupported", `${ctx.label} has no build for this server (${key}).`);
  } else {
    log(`no pinned ${ctx.label} build for ${key}; using ${ctx.label}'s own installer`);
  }
  runVendorScript(spec.script, ctx.env, null, ctx.label);
  persistVendorBinary(ctx.command, ctx.env, ctx.root);
}

// ---------- failures a person can act on ----------
// Every failure leaves with a reason code the server reads (see `failureLine`) and a
// message that leads with plain words. Codes: disk_full · not_runnable · integrity ·
// download_failed · unsupported · failed.
export class InstallError extends Error {
  constructor(reason, message, extra = {}) {
    super(message);
    this.reason = reason;
    Object.assign(this, extra);
  }
}

/** Free MB on the filesystem that holds `dir` (its nearest existing ancestor), or null. */
export function freeMb(dir) {
  let at = path.resolve(dir);
  for (;;) {
    try {
      const st = fs.statfsSync(at);
      return Math.floor((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024));
    } catch {
      const up = path.dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
}

function outOfMemoryError(what) {
  return new InstallError(
    "out_of_memory",
    `Your server ran out of memory while setting up ${what}. A bigger plan, or one provider at a time, helps.`
  );
}

function diskFullError(label, free, need) {
  return new InstallError(
    "disk_full",
    `Your server's disk is nearly full (${free} MB free; ${label} needs about ${need} MB). ` +
      "Use a bigger volume or remove a provider you don't use.",
    { free_mb: free, need_mb: need }
  );
}

// Anything that failed while the disk is (now) short of what this CLI needs is the
// disk's fault, whatever the step said: npm, for one, reports a platform package it
// could not unpack as an optional skip and exits 0.
function classifyInstallError(error, { label, root, spec, measure = freeMb }) {
  if (error instanceof InstallError && error.reason !== "not_runnable" && error.reason !== "failed") return error;
  const free = measure(root);
  const need = spec.size_mb;
  const message = error instanceof Error ? error.message : String(error);
  if ((need && free != null && free < need) || /\bENOSPC\b|no space left on device/i.test(message)) {
    return diskFullError(label, free ?? 0, need ?? 0);
  }
  if (error instanceof InstallError) return error;
  if (error?.code === "integrity") return new InstallError("integrity", message);
  if (error?.code === "download_failed") {
    return new InstallError("download_failed", `Couldn't download ${label}. Check the server's internet connection, then try again. (${message})`);
  }
  return new InstallError("failed", message);
}

// ---------- removal ----------
function rmQuiet(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// What Cairn installed for this CLI, and the vendor copies it is allowed to clear.
function removeInstalledFiles(command, spec, root, home) {
  const bin = path.join(root, "bin", command);
  if (spec.method === "npm") {
    rmQuiet(path.join(root, "lib", "node_modules", ...spec.package.split("/")));
    // npm on Windows-less hosts links bin -> ../lib/node_modules/<pkg>/…; drop the link.
    try {
      if (fs.lstatSync(bin)) fs.rmSync(bin, { force: true });
    } catch {}
  } else {
    rmQuiet(bin);
  }
  for (const rel of spec.cleanup) if (home) rmQuiet(path.join(home, rel));
}

/** Remove a provider's CLI from the tools root (its sign-in, in HOME, is left alone). */
export function removeAgentCli(name, options = {}) {
  const manifestPath = options.manifestPath || process.env.CAIRN_AGENT_CLI_MANIFEST || DEFAULT_MANIFEST;
  const { command, label, spec } = readAgentInstall(manifestPath, name);
  const env = options.env || process.env;
  const root = cliRoot(env);
  const before = freeMb(root);
  removeInstalledFiles(command, spec, root, env.HOME || "");
  const after = freeMb(root);
  log(`removed ${label} (${command}); ${after ?? "?"} MB free${before != null && after != null ? ` (+${Math.max(0, after - before)} MB)` : ""}`);
  return { name, command, root, free_mb: after };
}

// The installed CLI must actually START, the way an agent run will launch it: npm
// "succeeds" with no platform binary when the disk fills mid-install (Claude's 500-byte
// stub, Codex's launcher that throws), and that must never read as "Ready".
function verifyRuns(command, env) {
  const found = commandOnPath(command, env);
  if (!found) return { ok: false, line: `${command} is not on PATH after installation` };
  const result = spawnSync(found, ["--version"], { env, encoding: "utf8", timeout: 60_000 });
  const text = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const first = text.split(/\r?\n/).find((line) => line.trim()) || "";
  if (result.error) return { ok: false, line: result.error.message };
  if (result.status !== 0) {
    const why = result.signal ? `killed by ${result.signal}` : `exit ${result.status}`;
    return { ok: false, line: `${first || "no output"} (${why})`, signal: result.signal || null, status: result.status };
  }
  return { ok: true, line: first || "installed" };
}

// The vendor's own copies, once Cairn's copy in the tools root runs: only when that
// copy is a real file (never a link INTO the vendor's directory).
function cleanupVendorCopies(command, spec, root, home) {
  if (!home || !spec.cleanup.length) return;
  try {
    const own = fs.lstatSync(path.join(root, "bin", command));
    if (!own.isFile()) return;
  } catch {
    return;
  }
  let freed = 0;
  for (const rel of spec.cleanup) {
    const target = path.join(home, rel);
    try {
      fs.lstatSync(target);
    } catch {
      continue;
    }
    if (rmQuiet(target)) freed++;
  }
  if (freed) log(`removed ${freed} duplicate vendor cop${freed === 1 ? "y" : "ies"} of ${command} from HOME`);
}

export function installAgentCli(name, options = {}) {
  const manifestPath = options.manifestPath || process.env.CAIRN_AGENT_CLI_MANIFEST || DEFAULT_MANIFEST;
  const { command, label, spec } = readAgentInstall(manifestPath, name);
  const sourceEnv = options.env || process.env;
  const root = cliRoot(sourceEnv);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  // Package caches go to a scratch dir on the system temp disk and are deleted after:
  // on a small data volume a kept npm cache alone is a provider's worth of space.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-agent-cli-cache-"));
  const env = { ...sourceEnv };
  for (const key of DENIED_ENV) delete env[key];
  Object.assign(env, {
    CAIRN_CLI_ROOT: root,
    NPM_CONFIG_PREFIX: root,
    NPM_CONFIG_CACHE: path.join(scratch, "npm"),
    XDG_CACHE_HOME: path.join(scratch, "cache"),
    PATH: [bin, String(sourceEnv.PATH || "")].filter(Boolean).join(path.delimiter),
  });
  const home = env.HOME || "";
  const fresh = !fs.existsSync(path.join(bin, command));
  const measure = options.freeMb || freeMb;
  const free = measure(root);
  log(`installing ${label} (${name}); ${free ?? "?"} MB free${spec.size_mb ? `, needs about ${spec.size_mb} MB` : ""}`);

  try {
    if (fresh && spec.size_mb && free != null && free < spec.size_mb) throw diskFullError(label, free, spec.size_mb);
    if (spec.method === "npm") {
      run("npm", ["install", "--global", "--prefix", root, `${spec.package}@${spec.version}`, ...spec.args], env);
    } else {
      const installed = commandOnPath(command, env);
      let updated = false;
      if (installed && spec.update_args.length) {
        try {
          run(command, spec.update_args, env);
          persistVendorBinary(command, env, root);
          updated = true;
        } catch (error) {
          log(`first-party update failed; falling back to a fresh install: ${error.message}`);
        }
      }
      if (!updated) {
        if (spec.method === "binary") {
          installBinary(spec, { command, label, root, env });
        } else {
          runVendorScript(spec.url, env, spec.sha256, label);
          persistVendorBinary(command, env, root);
        }
      }
    }
    const check = verifyRuns(command, env);
    if (!check.ok) {
      removeInstalledFiles(command, spec, root, home);
      if (check.signal === "SIGKILL" || check.status === 137) throw outOfMemoryError(label);
      throw new InstallError(
        "not_runnable",
        `${label} was installed but doesn't start on this server, so Cairn removed it. (${check.line})`
      );
    }
    cleanupVendorCopies(command, spec, root, home);
    log(`ok: ${name} -> ${check.line}`);
    return { name, command, root };
  } catch (error) {
    const classified = classifyInstallError(error, { label, root, spec, measure });
    classified.agent = name;
    classified.free_mb ??= measure(root);
    if (spec.size_mb) classified.need_mb ??= spec.size_mb;
    throw classified;
  } finally {
    rmQuiet(scratch);
  }
}

// The one machine-readable line the server parses out of stderr (src/agentCliUpdates.ts):
// the reason code and the plain message, nothing else (no CLI output, no paths beyond
// what the message already says).
export const FAILURE_PREFIX = "CAIRN_INSTALL_FAILURE ";
export function failureLine(error, agent = null) {
  const reason = error instanceof InstallError ? error.reason : "failed";
  return (
    FAILURE_PREFIX +
    JSON.stringify({
      agent: error?.agent ?? agent,
      reason,
      message: error instanceof Error ? error.message : String(error),
      free_mb: Number.isFinite(error?.free_mb) ? error.free_mb : null,
      need_mb: Number.isFinite(error?.need_mb) ? error.need_mb : null,
    })
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const remove = argv[0] === "--remove";
  const names = remove ? argv.slice(1) : argv;
  if (!names.length) throw new Error("usage: cairn-update-agent-clis [--remove] <agent> [agent...]");
  for (const name of names) {
    try {
      if (remove) removeAgentCli(name);
      else installAgentCli(name);
    } catch (error) {
      process.stderr.write(`${failureLine(error, name)}\n`);
      throw error;
    }
  }
  log(remove ? "agent CLI removal complete" : "agent CLI install/update complete");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`agent CLI install failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
