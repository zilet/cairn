import * as repo from "./repo.js";
import { getVersion, isNewer } from "./version.js";

// In-app "a newer Cairn is available" check — the self-hosted update path.
//
// Constitution fit: this is PULL, never push. Nothing notifies. A quiet daily
// background check (scheduler.ts) just STORES the latest-release info in the
// app_state KV; the result waits in Settings → Data until the operator looks.
// It is gated by settings.update_check_enabled (default on, one toggle to
// disable) — when off, no automatic outbound request is made.
//
// The source of truth is the GitHub Releases API for the repo — unauthenticated
// (60 req/hr/IP, trivial for once-a-day), no new infrastructure, and it already
// hosts the tagged releases + notes the release workflow cuts. It sends nothing
// but an anonymous GET: no instance id, no telemetry.

const APP_STATE_KEY = "update_check";
const DEFAULT_REPO = "zilet/cairn";
const CHECK_TIMEOUT_MS = 10_000;
const MAX_NOTES = 4000;

export interface UpdateCheckCache {
  latest: string | null; // latest release version, normalized (no leading "v"), or null
  html_url: string | null; // the GitHub release page
  notes: string | null; // release notes (markdown), bounded
  published_at: string | null; // ISO timestamp of the latest release
  checked_at: string; // ISO of our last reach to GitHub
  error: string | null; // last error (offline / rate-limited / draft), else null
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  update_available: boolean;
  html_url: string | null;
  notes: string | null;
  published_at: string | null;
  checked_at: string | null;
  enabled: boolean; // settings.update_check_enabled
  error: string | null;
}

// owner/repo to query. Overridable for forks/mirrors via CAIRN_UPDATE_REPO.
function repoSlug(): string {
  const env = (process.env.CAIRN_UPDATE_REPO || "").trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(env)) return env;
  return DEFAULT_REPO;
}

// Pure: pull the fields we keep from a GitHub `releases/latest` payload. A draft
// or missing tag yields nulls (no crash). Exported for offline unit testing.
export function parseLatestRelease(json: any): Omit<UpdateCheckCache, "checked_at" | "error"> {
  const tag = typeof json?.tag_name === "string" ? json.tag_name.trim() : "";
  const latest = tag ? tag.replace(/^v/i, "") : null;
  return {
    latest,
    html_url: typeof json?.html_url === "string" ? json.html_url : null,
    notes: typeof json?.body === "string" ? json.body.slice(0, MAX_NOTES) : null,
    published_at: typeof json?.published_at === "string" ? json.published_at : null,
  };
}

// Pure: fold the running version + a cached check + the toggle into the status
// the UI/MCP read. Exported so it's unit-testable without the network or DB.
export function computeUpdateStatus(
  current: string,
  cache: UpdateCheckCache | null,
  enabled: boolean,
): UpdateStatus {
  const latest = cache?.latest ?? null;
  return {
    current,
    latest,
    update_available: !!latest && isNewer(latest, current),
    html_url: cache?.html_url ?? null,
    notes: cache?.notes ?? null,
    published_at: cache?.published_at ?? null,
    checked_at: cache?.checked_at ?? null,
    enabled,
    error: cache?.error ?? null,
  };
}

function readCache(): UpdateCheckCache | null {
  const raw = repo.getAppState(APP_STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UpdateCheckCache;
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCheckCache) {
  repo.setAppState(APP_STATE_KEY, JSON.stringify(cache));
}

// The current rolled-up status from cache (no network). What GET /api/update-status
// and the scheduler's "should I bother" read.
export function getUpdateStatus(): UpdateStatus {
  const enabled = !!repo.getSettings().update_check_enabled;
  return computeUpdateStatus(getVersion(), readCache(), enabled);
}

// Reach GitHub for the latest release, cache it, return the rolled-up status.
// Network/parse failure is swallowed into the cache's `error` field (the last
// good `latest` is preserved) — this NEVER throws, so a caller can fire-and-forget.
export async function checkForUpdate(): Promise<UpdateStatus> {
  const url = `https://api.github.com/repos/${repoSlug()}/releases/latest`;
  const checked_at = new Date().toISOString();
  const prev = readCache();
  const base = prev ?? { latest: null, html_url: null, notes: null, published_at: null };
  const settle = (cache: UpdateCheckCache): UpdateStatus => {
    writeCache(cache);
    return computeUpdateStatus(getVersion(), cache, !!repo.getSettings().update_check_enabled);
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "cairn-update-check", Accept: "application/vnd.github+json" },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        // Keep the last good cache; just record the error + when we tried.
        return settle({ ...base, checked_at, error: `GitHub returned ${res.status}` });
      }
      const parsed = parseLatestRelease(await res.json());
      return settle({ ...parsed, checked_at, error: null });
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    const error = e?.name === "AbortError" ? "timed out" : (e?.message ?? "check failed");
    return settle({ ...base, checked_at, error });
  }
}
