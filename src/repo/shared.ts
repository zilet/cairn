import { activeTimeZone } from "../tz.js";

// Intl.DateTimeFormat construction is the costly part of date formatting, and
// getCoachContext builds these labels per logged entry (dozens per prompt). Cache
// one formatter per (zone × shape), keyed by the zone string ("" = system-local).
// At most a handful of zones ever exist (the owner's home + travel), so the caches
// stay tiny — this turns O(entries) constructions into O(zones) ≈ 1.
const partsFmt = new Map<string, Intl.DateTimeFormat>();
const timeFmt = new Map<string, Intl.DateTimeFormat>();
const weekdayFmt = new Map<string, Intl.DateTimeFormat>();
const monthDayFmt = new Map<string, Intl.DateTimeFormat>();
function cached(
  cache: Map<string, Intl.DateTimeFormat>,
  key: string,
  make: () => Intl.DateTimeFormat
): Intl.DateTimeFormat {
  let f = cache.get(key);
  if (!f) {
    f = make();
    cache.set(key, f);
  }
  return f;
}

// The wall-clock parts of an instant in a given IANA zone — or system-local when
// `zone` is undefined (getFullYear()/getHours() read the server's own TZ). Uses
// Intl so ANY zone works without changing process.TZ, which is what lets "local"
// follow the traveling device (see src/tz.ts). Cheap numeric parts come from the
// fast Date getters on the system-local path; the costly weekday/time formatters
// are cached above.
function zonedParts(d: Date, zone?: string) {
  const key = zone ?? "";
  const time = cached(
    timeFmt,
    key,
    () => new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" })
  ).format(d);
  if (!zone) {
    const weekday = cached(weekdayFmt, "", () => new Intl.DateTimeFormat("en-US", { weekday: "long" })).format(d);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      weekday,
      time,
    };
  }
  const parts = cached(
    partsFmt,
    key,
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        weekday: "long",
      })
  ).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: get("weekday"),
    time,
  };
}

// A cached "MMM d" label (e.g. "May 1") in the given zone — the >6-days-ago branch
// of chatHistoryTimeLabel.
function zonedMonthDay(d: Date, zone?: string): string {
  return cached(
    monthDayFmt,
    zone ?? "",
    () => new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric" })
  ).format(d);
}

const isoDate = (p: { year: number; month: number; day: number }) =>
  `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

export function addDaysISO(iso: string, days: number): string | null {
  const t = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 864e5).toISOString().slice(0, 10);
}

export function daysBetweenISO(laterISO: string, earlierISO: string): number | null {
  const later = Date.parse(`${String(laterISO).slice(0, 10)}T00:00:00Z`);
  const earlier = Date.parse(`${String(earlierISO).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return null;
  return Math.round((later - earlier) / 864e5);
}

// The local calendar date (YYYY-MM-DD). Frames in the active device zone when one
// is in scope (X-Cairn-TZ), else the server's own zone — so a meal logged at 9 PM
// counts toward the right day at home AND abroad. The day_reads cache is keyed by
// this; mirror it in dayread.localToday() so getCoachContext reads the row the
// Brief wrote. Defined here (not via dayread) to avoid a circular import.
export function localDateISO(d: Date = new Date(), tz: string | undefined = activeTimeZone()): string {
  return isoDate(zonedParts(d, tz));
}

// Integer count of LOCAL calendar days since the epoch — used to diff two dates
// by their local Y/M/D (TZ-correct, DST-safe) without wall-clock subtraction.
function localDayNumber(d: Date, tz?: string): number {
  const p = zonedParts(d, tz);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 864e5);
}

// Coarse, plain-words part of the day. Buckets chosen so the coach won't ask
// about a meal that hasn't happened (at 5 PM dinner is still ahead → "evening"
// begins at 17h, but the prompt still says it's ahead). No number wall, no score.
export function partOfDay(hour: number): string {
  return hour < 5
    ? "the middle of the night"
    : hour < 12
      ? "morning"
      : hour < 17
        ? "afternoon"
        : hour < 21
          ? "evening"
          : "night";
}

// The current LOCAL clock, folded into getCoachContext().now so every coaching
// prompt knows what time of day it is. Without this the agent is temporally
// blind — it would, e.g., ask "how'd dinner land last night?" at 5 PM because the
// conversation thread carries no clock. Plain words; the home server shares the
// owner's timezone (see localDateISO), so getHours()/locale formatting are local.
export function nowContext(d: Date = new Date(), tz: string | undefined = activeTimeZone()) {
  const p = zonedParts(d, tz);
  return {
    date: isoDate(p), // YYYY-MM-DD, local
    weekday: p.weekday, // "Tuesday"
    time: p.time, // "5:15 PM"
    hour: p.hour,
    part_of_day: partOfDay(p.hour),
    tz: tz ?? null, // which zone framed this (null = server-local) — helps the agent + debugging
  };
}

// Local fractional hour-of-day (e.g. 11.85 for 11:51 AM) of an instant in the
// active device zone — the minute-precise companion to nowContext().hour. Built
// on the same cached zonedParts machinery (never bare-string UTC math), so it
// follows the traveling device the way localDateISO/nowContext do. Used by the
// fuel-state pace model, where hour-only precision (±1h of a ~14h eating window)
// would swing the "expected by now" estimate too far to trust.
export function localHourFraction(d: Date = new Date(), tz: string | undefined = activeTimeZone()): number {
  const p = zonedParts(d, tz);
  return p.hour + p.minute / 60;
}

// Parse a stored timestamp into a Date INSTANT. SQLite's datetime('now') yields
// "YYYY-MM-DD HH:MM:SS" with NO zone marker but in UTC — and `new Date(that)`
// would (wrongly) read it as LOCAL. So normalize to ISO-UTC unless the string
// already carries a zone. Returns null on anything unparseable.
export function parseDbTime(s: unknown): Date | null {
  if (s instanceof Date) return Number.isNaN(s.getTime()) ? null : s;
  if (s == null) return null;
  let str = String(s).trim();
  if (!str) return null;
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(str);
  if (!hasZone) str = str.replace(" ", "T") + "Z";
  else if (str.includes(" ") && !str.includes("T")) str = str.replace(" ", "T");
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A short, human time label for a chat message relative to `now`, so the agent
// can tell this morning's turn from a 5 PM one (the history it's handed is
// otherwise timestamp-less). Today → just the clock time; yesterday/earlier this
// week → a day word; older → a calendar date. Local-day diffing throughout.
export function chatHistoryTimeLabel(
  createdAt: unknown,
  now: Date = new Date(),
  tz: string | undefined = activeTimeZone()
): string {
  const d = parseDbTime(createdAt);
  if (!d) return "";
  const p = zonedParts(d, tz);
  const time = p.time;
  const diff = localDayNumber(now, tz) - localDayNumber(d, tz);
  if (diff <= 0) return time;
  if (diff === 1) return `yesterday ${time}`;
  if (diff <= 6) return `${p.weekday} ${time}`;
  return `${zonedMonthDay(d, tz)} ${time}`;
}

// Plain words for a brain expectation metric key. The single source of truth for
// the team's-week read (src/repo/team-week.ts), the Learned timeline
// (src/repo/learned-timeline.ts) and the reaction model (src/repo/reaction-model.ts),
// so all three speak with one identical vocabulary — do not re-inline a private copy
// in any consumer.
const METRIC_LABELS: Record<string, string> = {
  weight_trend_lb_wk: "weight trend",
  intake_to_weight_response: "intake-to-weight response",
  exercise_target_completion: "exercise completion",
  exercise_est_1rm_trend: "strength progression",
  session_performance_feedback: "session performance",
  joint_pain_or_soreness: "joint-pain or soreness response",
  plan_day_adherence: "plan adherence",
  run_volume_adherence: "run-volume adherence",
  vo2max_trend: "VO2max trend",
  recovery_hrv_delta: "HRV response",
  recovery_rhr_delta: "resting-heart-rate response",
  sleep_duration_delta: "sleep response",
  marker_direction: "marker direction",
  body_measurement_direction: "body-measurement direction",
};
export function metricLabel(metric: unknown): string {
  const key = String(metric ?? "");
  return METRIC_LABELS[key] ?? key.replace(/_/g, " ");
}

// Pounds per kilogram — the single conversion constant (was duplicated in profile.ts
// and, less precisely as 2.2046, in enrich.ts's Garmin kg→lb path).
export const LB_PER_KG = 2.2046226218;

export interface ClipTextOptions {
  // Collapse every whitespace run (including newlines) to a single space before
  // trimming, rather than only trimming the ends. Default false.
  collapseWhitespace?: boolean;
  // Appended after a truncation. "" means a silent hard cut with no marker at
  // all (learned-timeline.ts's original behavior). Default "…".
  ellipsis?: string;
  // Walk back to the last word boundary (space) inside the budget instead of
  // slicing at exactly `max` chars. Default false — most of the seven originals
  // this consolidates did NOT actually do this despite the shared "never cut
  // mid-word" intent behind them; see the callers in attention.ts,
  // coaching-focus.ts, forward-timeline.ts, training-milestones.ts and
  // today-agenda.ts, which preserve that pre-existing (mid-word-cutting) gap on
  // purpose — this is a refactor, not a behavior fix.
  wordBoundary?: boolean;
  // Opt-in on top of `wordBoundary`: additionally prefer ending on a sentence
  // boundary (". "/"! "/"? ") when one falls at least halfway into the budget,
  // before falling back to the word boundary. Default false — team-week.ts is
  // the one caller that wants this; it must never become every caller's default.
  sentenceBoundary?: boolean;
}

// The one truncation primitive behind what used to be seven independently
// reimplemented "trim to N chars without cutting mid-word" helpers (attention.ts,
// coaching-focus.ts, forward-timeline.ts, learned-timeline.ts, team-week.ts,
// training-milestones.ts, today-agenda.ts) — each with its own small, silent
// drift in ellipsis character, whitespace handling, or boundary behavior. The
// options above cover every behavior actually observed across those seven;
// every caller keeps its own exact prior output via the matching option set.
export function clipText(value: unknown, max: number, opts: ClipTextOptions = {}): string {
  const { collapseWhitespace = false, ellipsis = "…", wordBoundary = false, sentenceBoundary = false } = opts;
  const raw = String(value ?? "");
  const s = collapseWhitespace ? raw.replace(/\s+/g, " ").trim() : raw.trim();
  if (s.length <= max) return s;

  if (!wordBoundary) {
    if (!ellipsis) return s.slice(0, max);
    return `${s.slice(0, max - 1).trimEnd()}${ellipsis}`;
  }

  const window = s.slice(0, max);
  if (sentenceBoundary) {
    const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    if (sentenceEnd >= Math.floor(max * 0.5)) return window.slice(0, sentenceEnd + 1).trim();
  }
  const lastSpace = window.lastIndexOf(" ");
  const cut = (lastSpace > 0 ? window.slice(0, lastSpace) : window).replace(/[\s,;:.!?…]+$/, "");
  return ellipsis ? `${cut}${ellipsis}` : cut;
}

// Round a load to the nearest 2.5 lb plate — the smallest realistic gym increment.
// Shared by the progression engine's step math and the Garmin kg→lb conversion.
export function round2_5(n: number): number {
  return Math.round(n / 2.5) * 2.5;
}
