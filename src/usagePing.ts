import { feedbackBaseUrl, getInstanceId } from "./feedback.js";
import { detectPlatform } from "./hosting.js";
import { getAppState, setAppState } from "./repo/app-state.js";
import { getSettings } from "./repo/settings.js";
import { getVersion } from "./version.js";

// The opt-in usage ping: so the maintainer can tell how many installs exist and on
// what, without learning anything about anyone. OFF by default
// (settings.usage_ping_enabled), and inert when no feedback service is configured
// (CAIRN_FEEDBACK_URL="" turns off the DEFAULT_FEEDBACK_URL). When both hold, at most once a week
// it sends exactly five fields — a random install id, the Cairn version, the host
// platform, the CPU architecture and the Node version. Failures are silent and
// never retried sooner than a day; nothing here can block boot or a request.

const STATE_KEY = "usage_ping";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 24 * 60 * 60 * 1000;
const PING_TIMEOUT_MS = 10_000;

type Env = Record<string, string | undefined>;

export interface UsagePingState {
  last_sent_at: string | null;
  last_attempt_at: string | null;
}

export interface UsagePingPayload {
  instance_id: string;
  version: string;
  platform: string;
  arch: string;
  node: string;
}

export function readUsagePingState(): UsagePingState {
  try {
    const parsed = JSON.parse(getAppState(STATE_KEY) || "null");
    return {
      last_sent_at: typeof parsed?.last_sent_at === "string" ? parsed.last_sent_at : null,
      last_attempt_at: typeof parsed?.last_attempt_at === "string" ? parsed.last_attempt_at : null,
    };
  } catch {
    return { last_sent_at: null, last_attempt_at: null };
  }
}

/** Pure: may a ping go out now? Opted in, a service configured, a week since the last one, a day since a failed try. */
export function usagePingDue(opts: {
  enabled: boolean;
  baseUrl: string | null;
  state: UsagePingState;
  now: Date;
}): boolean {
  if (!opts.enabled || !opts.baseUrl) return false;
  const nowMs = opts.now.getTime();
  const since = (iso: string | null) => {
    const at = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(at) ? nowMs - at : Number.POSITIVE_INFINITY;
  };
  return since(opts.state.last_sent_at) >= WEEK_MS && since(opts.state.last_attempt_at) >= RETRY_MS;
}

/** Pure: the whole ping, nothing more. */
export function usagePingPayload(instance_id: string, env: Env = process.env): UsagePingPayload {
  return {
    instance_id,
    version: getVersion(),
    platform: detectPlatform(env),
    arch: process.arch,
    node: process.version,
  };
}

export interface UsagePingOptions {
  env?: Env;
  fetch?: typeof fetch;
  now?: Date;
  enabled?: boolean;
}

/** Send the weekly ping when it is due. Returns whether one was delivered. Never throws. */
export async function maybeSendUsagePing(options: UsagePingOptions = {}): Promise<boolean> {
  try {
    const env = options.env ?? process.env;
    const now = options.now ?? new Date();
    const baseUrl = feedbackBaseUrl(env);
    const enabled = options.enabled ?? !!getSettings().usage_ping_enabled;
    const state = readUsagePingState();
    if (!usagePingDue({ enabled, baseUrl, state, now })) return false;
    const attempt: UsagePingState = { ...state, last_attempt_at: now.toISOString() };
    setAppState(STATE_KEY, JSON.stringify(attempt));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
    try {
      const res = await (options.fetch ?? fetch)(`${baseUrl}/v1/ping`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "cairn-ping" },
        body: JSON.stringify(usagePingPayload(getInstanceId(), env)),
        signal: ctrl.signal,
      });
      if (!res.ok) return false;
      setAppState(STATE_KEY, JSON.stringify({ ...attempt, last_sent_at: now.toISOString() }));
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
