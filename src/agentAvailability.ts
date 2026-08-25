// Provider availability: WHY a CLI failed, and how long to believe it.
//
// Cairn rotates several agent CLIs. Until this module existed every failure
// looked the same (`invalid_json`), so a provider that was out of weekly quota
// was re-probed on every single operation — each probe plus its JSON-repair
// retry burning seconds of the op's timeout — while Settings still showed it
// "✓ Connected". This module reads the CLI's own words ONCE and turns them into
// a small taxonomy the rotation, the telemetry spine and the UI all share.
//
// Deliberately dependency-free (no repo, no db): agents.ts imports it, and
// agents.ts must never import repo.ts (circular). The only import is tz.ts,
// which is pure AsyncLocalStorage. Persistence lives in
// src/repo/agent-availability.ts; the rotation reaches it through a sink.
//
// A hold is a PREDICTION, never a verdict: a held agent is skipped only while a
// healthier candidate remains. When it is the only option left it is probed
// anyway, and a success clears the hold immediately.
import { activeTimeZone } from "./tz.js";

export type AgentAvailabilityState =
  | "quota_exhausted"
  | "rate_limited"
  | "auth_required"
  | "payment_required"
  | "permission_denied"
  | "process_error"
  | "invalid_output";

export type AgentLimitWindow = "5h" | "7d";

export interface AgentFailure {
  state: AgentAvailabilityState;
  /** Which limit window the provider named, when it named one. */
  window?: AgentLimitWindow | null;
  /** ISO instant the limit lifts, when the provider said so. */
  resets_at: string | null;
  /** Short, user-safe sentence. Never raw CLI output beyond a recognized phrase. */
  detail: string;
}

/** States that mean "don't spend another spawn on this provider yet". */
const HOLDING_STATES = new Set<AgentAvailabilityState>([
  "quota_exhausted",
  "rate_limited",
  "auth_required",
  "payment_required",
]);

export function availabilityHolds(state: AgentAvailabilityState): boolean {
  return HOLDING_STATES.has(state);
}

// ---------- time: a wall clock in a named zone ----------

/** The zone framing athlete-facing times: the device zone in a request, else the server's. */
export function appTimeZone(): string {
  const active = activeTimeZone();
  if (active) return active;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** How far `zone` is from UTC at this instant, in ms (DST-correct, no deps). */
function zoneOffsetMs(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant whose wall time in `zone` is the given local Y-M-D H:M. */
function zonedWallTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, zone: string): number {
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ts = naive;
  // Two passes settle every zone including DST edges (the offset used to guess
  // is re-read at the guessed instant).
  for (let i = 0; i < 3; i++) {
    const next = naive - zoneOffsetMs(zone, new Date(ts));
    if (next === ts) break;
    ts = next;
  }
  return ts;
}

/** The calendar date `at` falls on, as seen from `zone`. */
function zonedYmd(zone: string, at: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day") };
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function to24h(hour: number, meridiem: string | null | undefined): number {
  const h = hour % 12;
  if (!meridiem) return hour % 24;
  return /^p/i.test(meridiem) ? h + 12 : h;
}

// `resets 8am (America/New_York)` · `resets Aug 26, 8am (…)` · `resets Aug 26, 2026 8am`
// · `resets at 8:30pm` · `resets 12:50pm (…)`.
//
// The shape matters more than it looks. Two bugs lived in the previous one-line
// version: the year alternative sat BEHIND the optional comma that had already
// been eaten (so "Aug 26, 2026 8am" fell through to the hour group, which happily
// took the "20" of the year), and `(?:at\s+)?` sat INSIDE the date group (so a
// dateless "resets at 8:30pm" never matched at all). So: the date group ends at
// an optional `, 2026`, and `at` is its own optional token outside it.
//
//   1 month · 2 day · 3 year · 4 hour · 5 minute · 6 meridiem · 7 zone
const RESETS_RE =
  /\bresets?\s+(?:(?:on\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4})[,\s]\s*)?)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm)\b)?\s*(?:\(([A-Za-z_]+\/[A-Za-z_+-]+|UTC|GMT)\))?/i;

/**
 * The wall time is read in the zone the CLI named; with no date we take the NEXT
 * occurrence at or after `now`, because "resets 8am" always means the coming 8am.
 */
export function parseResetsPhrase(text: string, now: Date): string | null {
  const m = RESETS_RE.exec(text);
  if (!m) return null;
  const zone = normalizeZone(m[7]) ?? appTimeZone();
  const rawHour = Number(m[4]);
  const meridiem = m[6];
  // A bare number is only a clock time when it says so — either a meridiem or an
  // explicit `:mm`. Without that guard a stray four-digit year (or any loose
  // number after "resets") reads as an hour, which is exactly how "Aug 26, 2026"
  // used to file itself at 20:00.
  if (!meridiem && m[5] === undefined) return null;
  if (meridiem && rawHour > 12) return null;
  const hour = to24h(rawHour, meridiem);
  const minute = m[5] ? Number(m[5]) : 0;
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;
  if (m[1] && MONTHS[m[1].toLowerCase()]) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = Number(m[2]);
    const year = m[3] ? Number(m[3]) : zonedYmd(zone, now).y;
    let ts = zonedWallTimeToUtc(year, month, day, hour, minute, zone);
    // No year given and the date already passed → next year's occurrence.
    if (!m[3] && ts < now.getTime() - 86_400_000) {
      ts = zonedWallTimeToUtc(year + 1, month, day, hour, minute, zone);
    }
    return new Date(ts).toISOString();
  }
  const today = zonedYmd(zone, now);
  let ts = zonedWallTimeToUtc(today.y, today.m, today.d, hour, minute, zone);
  if (ts <= now.getTime()) {
    const tomorrow = new Date(ts + 26 * 3_600_000);
    const ymd = zonedYmd(zone, tomorrow);
    ts = zonedWallTimeToUtc(ymd.y, ymd.m, ymd.d, hour, minute, zone);
  }
  return new Date(ts).toISOString();
}

function normalizeZone(value: string | undefined): string | null {
  if (!value) return null;
  if (/^(utc|gmt)$/i.test(value)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** `try again at Sep 18th, 2026 4:23 PM.` — no zone named, so the app's clock frames it. */
export function parseTryAgainPhrase(text: string, now: Date, zone = appTimeZone()): string | null {
  const m =
    /\btry again (?:at|on|after)\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(
      text
    );
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = Number(m[2]);
  const year = m[3] ? Number(m[3]) : zonedYmd(zone, now).y;
  const hour = to24h(Number(m[4]), m[6]);
  const minute = m[5] ? Number(m[5]) : 0;
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;
  let ts = zonedWallTimeToUtc(year, month, day, hour, minute, zone);
  if (!m[3] && ts < now.getTime() - 86_400_000) {
    ts = zonedWallTimeToUtc(year + 1, month, day, hour, minute, zone);
  }
  return new Date(ts).toISOString();
}

/** "Tue 8:00 AM" / "Sep 18, 4:23 PM" — how a reset is SAID to a person. */
export function formatResetForPerson(iso: string | null, now: Date, zone = appTimeZone()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const withinWeek = at.getTime() - now.getTime() < 6 * 86_400_000;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      ...(withinWeek ? { weekday: "short" } : { month: "short", day: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    })
      .format(at)
      .replace(/,\s*/, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return null;
  }
}

// ---------- the recognized phrases ----------

// Moved verbatim from chatTurns.classifyChatAgentResult so both surfaces read one
// definition. `infraSized` is part of the rule: a long reply that merely MENTIONS
// logging in is a coaching answer, not an auth failure.
const AUTH_PATTERNS: RegExp[] = [
  /\bnot logged in\b/,
  /\blogged out\b/,
  /\bplease (run )?\/?(log|sign)in\b/,
  /\b(run|use) .{0,24}\/?(log|sign)in\b/,
  /\bauth(entication|orization)? (required|failed|error)\b/,
  /\bunauthenticated\b/,
  /\bapi key\b.{0,40}\b(missing|required|invalid)\b/,
  /\b(missing|required|invalid)\b.{0,40}\bapi key\b/,
];

const AUTH_INFRA_MAX_CHARS = 800;

/** True when the combined CLI output reads as "you are not signed in". */
export function isAuthFailureText(raw: string, stderr: string): boolean {
  const combined = `${raw ?? ""}\n${stderr ?? ""}`;
  if (combined.trim().length > AUTH_INFRA_MAX_CHARS) return false;
  const lower = combined.toLowerCase();
  return AUTH_PATTERNS.some((re) => re.test(lower));
}

const WEEKLY_LIMIT = /\bhit your weekly limit\b|\bweekly (usage )?limit (reached|exceeded)\b/i;
const USAGE_LIMIT = /\bhit your usage limit\b|\busage limit (reached|exceeded)\b|\bquota (exceeded|exhausted)\b/i;
const SHORT_LIMIT = /\bsession limit\b|\b5-?\s?hour limit\b|\bfive[- ]hour limit\b|\bhit your limit\b/i;
const PAYMENT =
  /\b402\b|\bpayment required\b|\bbalance exhausted\b|\binsufficient (credit|credits|funds|balance)\b|\bbilling\b|\bupgrade to (plus|pro)\b.{0,40}\bpayment\b/i;
const PERMISSION =
  /\bno output produced\b|\bauto-denied\b|\bauto denied\b|\bpermission\b.{0,80}\bheadless\b|\bheadless\b.{0,80}\bpermission\b/i;
// Throttling reads in two strengths, because `rate_limited` is a HOLDING state
// and this classifier also runs over runs that exited 0 with unparseable
// COACHING PROSE in stdout. "work capacity", "503 kcal", "try again later" all
// occur in a perfectly healthy coach reply, and a contract miss on such a run
// used to park a hold on a provider that was never throttled.
//
// EXPLICIT: names throttling or an HTTP status outright. Trusted on its own.
const RATE_EXPLICIT =
  /\brate[-_ ]limit(ed|ing|_event)?\b|\btoo many requests\b|\b(?:status|http)\s*(?:code)?\s*[:=]?\s*(?:429|503|529)\b/i;
// WEAK: words that are ALSO ordinary English. Only believed when the run also
// failed (non-zero / signalled exit) or an explicit phrase already anchored it.
const RATE_WEAK = /\b429\b|\b529\b|\b503\b|\boverloaded\b|\bover capacity\b|\bcapacity\b|\btry again later\b|\bservice unavailable\b/i;

/** HTTP statuses the provider's own result line reports as throttling. */
const RATE_STATUSES = new Set([429, 503, 529]);

interface StreamRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
}

/**
 * Claude's `--output-format stream-json` emits one `rate_limit_event` line whose
 * payload states the window AND the exact reset instant — far better evidence
 * than the prose, so it is read first.
 */
export function parseStreamRateLimitEvent(text: string): StreamRateLimitInfo | null {
  if (!text.includes("rate_limit_event")) return null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes("rate_limit_event")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.type !== "rate_limit_event") continue;
      const info = parsed.rate_limit_info;
      if (info && typeof info === "object") return info as StreamRateLimitInfo;
    } catch {
      /* a truncated stream line is not evidence */
    }
  }
  return null;
}

/** Claude's stream/json result line carries the provider's HTTP status. */
function parseApiErrorStatus(text: string): number | null {
  const m = /"api_error_status"\s*:\s*(\d{3})/.exec(text);
  return m ? Number(m[1]) : null;
}

function windowFromRateLimitType(type: string | undefined): AgentLimitWindow | null {
  if (!type) return null;
  if (/seven[_-]?day|weekly/i.test(type)) return "7d";
  if (/five[_-]?hour|hourly|session/i.test(type)) return "5h";
  return null;
}

function limitDetail(window: AgentLimitWindow | null, resetsAt: string | null, now: Date): string {
  const noun = window === "7d" ? "Weekly limit" : window === "5h" ? "Session limit" : "Usage limit";
  const when = formatResetForPerson(resetsAt, now);
  return (when ? `${noun} — resets ${when}` : `${noun} reached`).slice(0, 120);
}

/** The limit / payment arms, shared by the failure classifier and the chat banner read. */
function limitOrPaymentFailure(combined: string, now: Date): AgentFailure | null {
  if (WEEKLY_LIMIT.test(combined)) {
    const resets_at = parseResetsPhrase(combined, now) ?? parseTryAgainPhrase(combined, now);
    return { state: "quota_exhausted", window: "7d", resets_at, detail: limitDetail("7d", resets_at, now) };
  }
  if (USAGE_LIMIT.test(combined)) {
    const resets_at = parseTryAgainPhrase(combined, now) ?? parseResetsPhrase(combined, now);
    return { state: "quota_exhausted", window: null, resets_at, detail: limitDetail(null, resets_at, now) };
  }
  if (SHORT_LIMIT.test(combined)) {
    const resets_at = parseResetsPhrase(combined, now) ?? parseTryAgainPhrase(combined, now);
    return { state: "quota_exhausted", window: "5h", resets_at, detail: limitDetail("5h", resets_at, now) };
  }
  if (PAYMENT.test(combined)) {
    return { state: "payment_required", window: null, resets_at: null, detail: "Provider needs credit" };
  }
  return null;
}

/**
 * "You've hit your weekly limit · resets 8am" — read WITHOUT asking whether the run
 * failed. Several CLIs print their limit banner to stdout and still exit 0, which
 * made the banner itself the chat bubble while a healthy-looking run cleared the
 * provider's hold. The `infraSized` guard is what keeps this safe on a clean exit:
 * a real coaching answer discussing usage limits is far longer than a banner.
 */
export function classifyLimitBannerText(raw: string, stderr: string, now: Date = new Date()): AgentFailure | null {
  const combined = `${raw ?? ""}\n${stderr ?? ""}`;
  if (combined.trim().length > AUTH_INFRA_MAX_CHARS) return null;
  return limitOrPaymentFailure(combined, now);
}

/**
 * Read a FAILED run's own words. The caller decides what "failed" means (no
 * usable parse); every failure gets a class, so `process_error` /
 * `invalid_output` are the honest floors rather than a guess.
 */
export function classifyAgentFailure(
  _agent: string,
  r: { code: number | null; raw: string; stderr: string },
  now: Date = new Date()
): AgentFailure | null {
  const raw = String(r.raw ?? "");
  const stderr = String(r.stderr ?? "");
  const combined = `${raw}\n${stderr}`;

  // 1. The structured stream event beats every prose reading.
  const event = parseStreamRateLimitEvent(combined);
  if (event && /rejected|exceeded|limited/i.test(String(event.status ?? ""))) {
    const window = windowFromRateLimitType(event.rateLimitType);
    const resets_at =
      typeof event.resetsAt === "number" && Number.isFinite(event.resetsAt)
        ? new Date(event.resetsAt * 1000).toISOString()
        : parseResetsPhrase(combined, now);
    return { state: "quota_exhausted", window, resets_at, detail: limitDetail(window, resets_at, now) };
  }

  // 2-3. A named usage/weekly limit is a QUOTA, even when the same line offers an
  //      upgrade link — the primary condition is the limit, not the payment. Money
  //      before throttling: a 402 never clears on its own.
  const limit = limitOrPaymentFailure(combined, now);
  if (limit) return limit;

  // 4. Signed out.
  if (isAuthFailureText(raw, stderr)) {
    return { state: "auth_required", window: null, resets_at: null, detail: "Not connected" };
  }

  // 5. Headless permission refusal: the CLI is healthy, this OP was blocked.
  if (PERMISSION.test(combined)) {
    return {
      state: "permission_denied",
      window: null,
      resets_at: null,
      detail: "Blocked by a headless permission rule",
    };
  }

  // 6. Temporary overload — a retry, not a hold on the provider. The weak arm
  //    needs an anchor: on a clean exit, bare "capacity"/"503" is coaching prose
  //    that failed the JSON contract, and that is `invalid_output` below.
  const apiStatus = parseApiErrorStatus(combined);
  if (
    RATE_EXPLICIT.test(combined) ||
    (apiStatus !== null && RATE_STATUSES.has(apiStatus)) ||
    (r.code !== 0 && RATE_WEAK.test(combined))
  ) {
    return { state: "rate_limited", window: null, resets_at: null, detail: "Provider busy — trying again shortly" };
  }

  // 7. The floors. A clean exit that produced nothing usable is an output
  //    problem; a non-zero exit with no recognized phrase is a process problem.
  if (r.code === 0) {
    return { state: "invalid_output", window: null, resets_at: null, detail: "Ran but returned no valid JSON" };
  }
  return {
    state: "process_error",
    window: null,
    resets_at: null,
    detail: /timed out/i.test(combined) ? "The CLI timed out" : "The CLI failed",
  };
}

const HOLD_CAP_MS = 8 * 86_400_000;

/**
 * How long to believe a failure. Quota holds until the provider's own reset,
 * throttling backs off geometrically, money waits a day, a signed-out CLI waits
 * for a login (30 min is just a re-probe leash). Everything else returns null —
 * the process-local breaker already handles transient noise.
 */
export function holdUntil(f: AgentFailure, streak: number, now: Date = new Date()): string | null {
  const n = now.getTime();
  const cap = (ms: number) => new Date(Math.min(n + ms, n + HOLD_CAP_MS)).toISOString();
  switch (f.state) {
    case "quota_exhausted": {
      if (!f.resets_at) return cap(3_600_000);
      const at = new Date(f.resets_at).getTime();
      if (!Number.isFinite(at) || at <= n) return cap(3_600_000);
      return new Date(Math.min(at, n + HOLD_CAP_MS)).toISOString();
    }
    case "rate_limited": {
      const steps = Math.max(0, Math.min(Number.isFinite(streak) ? streak : 0, 4));
      return cap(Math.min(5 * 60_000 * 2 ** steps, 3_600_000));
    }
    case "payment_required":
      return cap(24 * 3_600_000);
    case "auth_required":
      return cap(30 * 60_000);
    default:
      return null;
  }
}

/** How a held provider is named in an error ledger: "claude: weekly limit, resets Tue 8:00 AM". */
export function availabilityReason(
  f: { state: AgentAvailabilityState; resets_at?: string | null; window?: AgentLimitWindow | string | null },
  now: Date = new Date()
): string {
  const { state } = f;
  const when = formatResetForPerson(f.resets_at ?? null, now);
  const limitNoun = f.window === "7d" ? "weekly limit" : f.window === "5h" ? "session limit" : "usage limit";
  switch (state) {
    case "quota_exhausted":
      return when ? `${limitNoun}, resets ${when}` : `${limitNoun} reached`;
    case "rate_limited":
      return "busy, backing off";
    case "payment_required":
      return "needs credit";
    case "auth_required":
      return "not connected";
    case "permission_denied":
      return "blocked by a headless permission rule";
    case "invalid_output":
      return "ran but returned no valid JSON";
    default:
      return "the CLI failed";
  }
}
