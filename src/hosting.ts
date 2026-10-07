import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where this Cairn runs, and how a new release reaches it. Cairn is deployed by
// people who never open a terminal (Railway, a one-line installer) as well
// as by operators running Docker or a source checkout; the Settings → Data update
// card and POST /api/update/apply read this ONE description so every surface says
// the same thing about how updates happen here.
//
// Contract (shared with the hosting templates and the installer):
//   CAIRN_PLATFORM          railway | installer | docker — else auto-detected
//   CAIRN_DEPLOY_HOOK_URL   a host's redeploy webhook; POSTing it redeploys (https only)
//   CAIRN_UPDATE_METHOD     trigger-file → the app writes `${DATA_DIR}/.cairn-update-requested`
//                           and the host updater answers in `${DATA_DIR}/.cairn-updater.json`
//
// The deploy hook URL is a credential (anyone holding it can redeploy the service),
// so it NEVER leaves this module: no status, error or log line carries it.

export type HostPlatform = "railway" | "installer" | "docker" | "source";
export type UpdateMethod = "automatic" | "deploy_hook" | "trigger_file" | "manual";

export const UPDATE_REQUEST_FILE = ".cairn-update-requested";
export const UPDATER_STATUS_FILE = ".cairn-updater.json";
const UPDATER_STALE_MS = 3 * 24 * 60 * 60 * 1000;
const HOOK_TIMEOUT_MS = 10_000;
const PLATFORMS: readonly HostPlatform[] = ["railway", "installer", "docker"];

type Env = Record<string, string | undefined>;

export interface UpdaterStatus {
  installed: boolean;
  last_run: string | null;
  last_result: string | null;
  version: string | null;
  /** The updater has not reported in for more than three days. */
  stale: boolean;
}

export interface UpdateCapability {
  platform: HostPlatform;
  update_method: UpdateMethod;
  /** POST /api/update/apply can act on this host. */
  can_apply: boolean;
  /** One plain sentence: how a new release reaches this instance. */
  update_how: string;
  /** trigger_file only: what the host updater last reported, or null when it never has. */
  updater: UpdaterStatus | null;
  /** trigger_file only: a request is written and the updater has not picked it up yet. */
  update_requested_at: string | null;
  /** CAIRN_DEPLOY_HOOK_URL is set but is not an https URL, so it is ignored. */
  hook_misconfigured: boolean;
}

export interface ApplyUpdateResult {
  ok: boolean;
  method: UpdateMethod;
  message: string;
}

export function dataDir(env: Env = process.env): string {
  return env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
}

/** Pure: which host this is. An explicit CAIRN_PLATFORM wins; then the host's own env markers. */
export function detectPlatform(env: Env = process.env, exists: (p: string) => boolean = fs.existsSync): HostPlatform {
  const named = String(env.CAIRN_PLATFORM || "")
    .trim()
    .toLowerCase();
  if ((PLATFORMS as readonly string[]).includes(named)) return named as HostPlatform;
  if (env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PROJECT_ID) return "railway";
  try {
    if (exists("/.dockerenv")) return "docker";
  } catch {
    /* an unreadable root is simply "not Docker" */
  }
  return "source";
}

/** Pure: the deploy hook, only when it is a well-formed https URL. */
export function deployHookUrl(env: Env = process.env): string | null {
  const raw = String(env.CAIRN_DEPLOY_HOOK_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Pure: how a release reaches this host. An operator's explicit choice outranks the platform default. */
export function updateMethodFor(platform: HostPlatform, env: Env = process.env): UpdateMethod {
  const method = String(env.CAIRN_UPDATE_METHOD || "")
    .trim()
    .toLowerCase();
  if (method === "trigger-file") return "trigger_file";
  if (deployHookUrl(env)) return "deploy_hook";
  if (platform === "railway") return "automatic";
  if (platform === "installer") return "trigger_file";
  return "manual";
}

/** Pure: fold a raw `.cairn-updater.json` body into what the card reads. */
export function parseUpdaterStatus(raw: unknown, nowMs = Date.now()): UpdaterStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const text = (value: unknown, max: number): string | null =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
  const last_run = text(row.last_run, 40);
  const ranAt = last_run ? Date.parse(last_run) : Number.NaN;
  return {
    installed: row.installed === undefined ? true : !!row.installed,
    last_run,
    last_result: text(row.last_result, 200),
    version: text(row.version, 40),
    stale: !Number.isFinite(ranAt) || nowMs - ranAt > UPDATER_STALE_MS,
  };
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function howUpdatesHappen(platform: HostPlatform, method: UpdateMethod): string {
  if (method === "automatic")
    return "Your host installs new releases automatically in its maintenance window — nothing to do here.";
  if (method === "deploy_hook")
    return "Update now asks your host to rebuild Cairn from the latest release. Your data stays where it is.";
  if (method === "trigger_file")
    return "Update now asks the updater on this machine to fetch the latest release and restart Cairn. Your data stays where it is.";
  if (platform === "source") return "This copy runs from source: pull the latest release and rebuild to update.";
  return "This host updates by hand: back up, then pull the new image and restart the container.";
}

export function updateCapability(env: Env = process.env, nowMs = Date.now()): UpdateCapability {
  const platform = detectPlatform(env);
  const update_method = updateMethodFor(platform, env);
  const dir = dataDir(env);
  let updater: UpdaterStatus | null = null;
  let update_requested_at: string | null = null;
  if (update_method === "trigger_file") {
    updater = parseUpdaterStatus(readJsonFile(path.join(dir, UPDATER_STATUS_FILE)), nowMs);
    const request = readJsonFile(path.join(dir, UPDATE_REQUEST_FILE)) as Record<string, unknown> | null;
    update_requested_at =
      request && typeof request.requested_at === "string" ? request.requested_at.slice(0, 40) : null;
  }
  return {
    platform,
    update_method,
    can_apply: update_method === "deploy_hook" || update_method === "trigger_file",
    update_how: howUpdatesHappen(platform, update_method),
    updater,
    update_requested_at,
    hook_misconfigured: !!String(env.CAIRN_DEPLOY_HOOK_URL || "").trim() && !deployHookUrl(env),
  };
}

export interface ApplyUpdateOptions {
  env?: Env;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Perform this host's update method. Never throws and never names the hook URL:
 * a failure reads as a plain sentence with, at most, the host's HTTP status.
 */
export async function applyUpdate(options: ApplyUpdateOptions = {}): Promise<ApplyUpdateResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const doFetch = options.fetch ?? fetch;
  const platform = detectPlatform(env);
  const method = updateMethodFor(platform, env);

  if (method === "automatic") {
    return {
      ok: false,
      method,
      message:
        "Your host installs new releases automatically in its maintenance window, so there is nothing to start from here.",
    };
  }
  if (method === "manual") {
    return {
      ok: false,
      method,
      message: `${howUpdatesHappen(platform, method)} Cairn can't update itself on this host.`,
    };
  }
  if (method === "deploy_hook") {
    const hook = deployHookUrl(env);
    if (!hook) return { ok: false, method, message: "The deploy hook isn't configured." };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HOOK_TIMEOUT_MS);
    try {
      const res = await doFetch(hook, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "User-Agent": "cairn-update" },
      });
      if (!res.ok) {
        return {
          ok: false,
          method,
          message: `Your host didn't accept the update request (HTTP ${res.status}). Check the deploy hook in your hosting dashboard.`,
        };
      }
      return {
        ok: true,
        method,
        message: "Your host is rebuilding Cairn with the latest release. It will be back in a few minutes.",
      };
    } catch (error: any) {
      // Deliberately generic: a fetch error message can carry the URL it tried.
      const why = error?.name === "AbortError" ? "it didn't answer in time" : "it couldn't be reached";
      return { ok: false, method, message: `Couldn't ask your host to update — ${why}. Try again in a moment.` };
    } finally {
      clearTimeout(timer);
    }
  }

  // trigger_file: write the request atomically; the host updater removes it once acted on.
  const dir = dataDir(env);
  const target = path.join(dir, UPDATE_REQUEST_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify({ requested_at: now().toISOString() })}\n`, { mode: 0o644 });
    fs.renameSync(temp, target);
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* nothing to clean */
    }
    return {
      ok: false,
      method,
      message: "Couldn't write the update request into the data folder. Check that the data volume is writable.",
    };
  }
  const updater = parseUpdaterStatus(readJsonFile(path.join(dir, UPDATER_STATUS_FILE)), now().getTime());
  const message = !updater
    ? "Update requested. The updater on this machine hasn't reported in yet — if nothing changes in a few minutes, run the installer's update command."
    : updater.stale
      ? "Update requested. The updater on this machine hasn't run for a few days — if nothing changes soon, check that its timer is still enabled."
      : "Update requested. The updater on this machine will fetch the latest release and restart Cairn within a few minutes.";
  return { ok: true, method, message };
}
