// Personal-baseline bands (VISION.md Amendment 2 — the reading grammar).
// Today's recovery and this week's training load, each read against the
// athlete's OWN rolling range in qualitative words — "in / below / above your
// range" — never a score, grade, or population-relative geometry.
//
// Two PURE math cores (unit-tested with plain arrays) plus thin DB wrappers that
// assemble the series from the same tables the unified recovery summary and the
// weekly stats already read. Null-safe end to end: thin history yields an empty
// dimension list / a null band, and the client degrades to nothing (the
// constitution: absent signals never force anything). The band geometry is
// emitted as [0,1] positions the client hands straight to `baselineBandHtml`;
// the raw numbers ride along for depth surfaces + tests but NEVER appear on the
// band row itself.
//
// The recovery baseline is SAMPLE-anchored, not calendar-anchored: a dimension's
// band is the athlete's most recent RECOVERY_BASELINE_MAX_POINTS readings taken
// no further back than RECOVERY_BASELINE_LOOKBACK_DAYS. A daily wearer's last 28
// readings ARE the last 28 days, so nothing about their band moves; an EPISODIC
// wearer (runs + the occasional baseline night) finally gets one instead of being
// dropped for having spread ten readings over four months. The floor is still
// RECOVERY_BASELINE_MIN_POINTS readings — thin history is still nothing.
//
// The band and its dot have SEPARATE lifetimes. The dot is a present-tense claim
// and answers to sensor-freshness (stale ⇒ `current: null`, never repositioned
// from the last known reading — the staleness law is absolute). The band is a
// durable personal range and survives a missing dot: the dimension still renders,
// dotless, carrying provenance (`readings`, `span_days`, `last_reading_date`) so
// the client can say how old the picture is in calm words.

import { db } from "../db.js";
import { type SensorSignal, sensorIsCurrent } from "./sensor-freshness.js";
import { localDateISO } from "./shared.js";

// ---- shared math (module-private) --------------------------------------------

// R-7 (linear-interpolation) quantile — the definition NumPy/R default to.
// `sorted` MUST be ascending and non-empty; q is clamped to [0,1].
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const h = (sorted.length - 1) * (q < 0 ? 0 : q > 1 ? 1 : q);
  const lo = Math.floor(h);
  const frac = h - lo;
  const a = sorted[lo];
  const b = sorted[lo + 1] ?? a;
  return a + frac * (b - a);
}

// Build the value→[0,1] mapper for a band track. The track spans the series' own
// [min,max] PADDED by 8% of the span on each side, so the p25–p75 region sits
// mid-track with headroom and the dot never pins hard to an edge under normal
// variation. A flat series (span 0) pads by a small epsilon so the track isn't
// degenerate — everything then maps to the centre. Every output is clamped to
// [0,1] so a caller can hand over any raw value unguarded.
function trackMapper(values: number[]): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const pad = span > 0 ? span * 0.08 : Math.max(Math.abs(max) * 0.05, 0.5);
  const lo = min - pad;
  const width = max + pad - lo || 1;
  return (v: number) => {
    const f = (v - lo) / width;
    return f < 0 ? 0 : f > 1 ? 1 : f;
  };
}

// ---- recovery baseline bands -------------------------------------------------

export type RecoveryBaselineDimKey = "hrv" | "rhr" | "sleep";

export interface RecoveryBaselineDimInput {
  // Every value in the selected sample (order irrelevant — quartiles sort internally).
  values: number[];
  // The most recent reading (latest date), IF it can still speak for today; null
  // when the dimension has no data or the newest reading is past its age bound.
  current: number | null;
  // Provenance of the selected sample — the oldest and newest reading actually
  // used, as ISO dates. Optional: the pure core degrades to null span/date.
  first_reading_date?: string | null;
  last_reading_date?: string | null;
}

export interface RecoveryBaselineInput {
  hrv: RecoveryBaselineDimInput;
  rhr: RecoveryBaselineDimInput;
  sleep: RecoveryBaselineDimInput;
}

export interface RecoveryBaselineDimension {
  key: RecoveryBaselineDimKey;
  label: string;
  phrase: string;
  hot: boolean;
  // [0,1] band geometry — handed straight to `baselineBandHtml`. `position` is
  // null when there is no current reading: the band draws, the dot does not.
  position: number | null;
  range_start: number;
  range_end: number;
  // Raw numbers — depth surfaces + tests only; NEVER surfaced on the band row.
  // `current` is null whenever the newest reading is too old to speak for today.
  current: number | null;
  p25: number;
  p75: number;
  n: number; // legacy name for `readings` — same number, kept for the client DTO
  // Provenance of the sample behind the band. `readings` is a gentle count, never
  // a quality grade; `span_days` is oldest→newest of the readings actually used.
  readings: number;
  span_days: number | null;
  last_reading_date: string | null;
}

export interface RecoveryBaselineRead {
  dimensions: RecoveryBaselineDimension[];
}

// A personal range needs enough READINGS behind it to mean anything — not enough
// calendar days. Ten is the floor either way.
export const RECOVERY_BASELINE_MIN_POINTS = 10;
// How many of the most recent readings a band is built from. 28 keeps a daily
// wearer's band identical to the calendar-anchored 28-day window it replaces.
export const RECOVERY_BASELINE_MAX_POINTS = 28;
// How far back those readings may be drawn from. Beyond half a year a "usual
// range" is somebody else's body, so the sample stops there rather than reaching.
export const RECOVERY_BASELINE_LOOKBACK_DAYS = 180;

const RECOVERY_DIM_ORDER: readonly RecoveryBaselineDimKey[] = ["hrv", "rhr", "sleep"];
const RECOVERY_DIM_LABEL: Record<RecoveryBaselineDimKey, string> = {
  hrv: "HRV",
  rhr: "Resting HR",
  sleep: "Sleep",
};

// Phrase + tone per dimension. `hot` (terracotta — a lever, never punishment)
// fires ONLY on the watch side that is genuinely actionable today: an elevated
// resting HR (a cue to ease up). Higher HRV and longer sleep read as calm wins;
// a low-HRV / short night is information to rest gently, never flagged hot — so
// the RHR "above is the watch side" inversion is the only place terracotta lands.
function recoveryPhrase(
  key: RecoveryBaselineDimKey,
  current: number,
  p25: number,
  p75: number
): { phrase: string; hot: boolean } {
  const above = current > p75;
  const below = current < p25;
  if (key === "sleep") {
    return { phrase: below ? "shorter than usual" : above ? "longer than usual" : "about your usual", hot: false };
  }
  if (key === "rhr") {
    return { phrase: above ? "above your usual" : below ? "below your usual" : "in your usual range", hot: above };
  }
  // hrv — higher is the good side, so it is never hot.
  return { phrase: above ? "above your usual" : below ? "below your usual" : "in your usual range", hot: false };
}

// The dotless read: with no current reading there is nothing to place, so the
// phrase names the BAND itself instead of a position in it. Same register as the
// dotted phrases above — a plain fragment, no number, no verdict — and never hot,
// because a band with no dot cannot be a lever. (Fixed literals, like the dotted
// phrases: these are UI row fragments, not the day read's rotating prose.)
const RECOVERY_BAND_ONLY_PHRASE: Record<RecoveryBaselineDimKey, string> = {
  hrv: "your usual range",
  rhr: "your usual range",
  sleep: "your usual nights",
};

// Calendar days from the oldest to the newest reading in the sample (0 when both
// land on one date). Null when either date is missing or unparseable.
function readingSpanDays(first?: string | null, last?: string | null): number | null {
  const a = Date.parse(`${String(first ?? "").slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(last ?? "").slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 864e5));
}

// PURE: given the assembled per-dimension sample, produce the band read. Only
// ONE thing drops a dimension: fewer than RECOVERY_BASELINE_MIN_POINTS values
// (thin data → absent → the client shows nothing). A missing current reading no
// longer does — the personal range is durable and outlives last night's dot, so
// the dimension renders band-only with `current`/`position` null and its
// provenance attached. A stale reading arrives here as `current: null`; it is
// never resurrected as a position.
export function recoveryBaselineRead(input: RecoveryBaselineInput): RecoveryBaselineRead {
  const dimensions: RecoveryBaselineDimension[] = [];
  for (const key of RECOVERY_DIM_ORDER) {
    const dim = input[key];
    const values = (dim?.values ?? []).filter((v) => Number.isFinite(v));
    if (values.length < RECOVERY_BASELINE_MIN_POINTS) continue;
    const raw = dim?.current;
    const current = raw != null && Number.isFinite(raw) ? raw : null;
    const sorted = [...values].sort((a, b) => a - b);
    const p25 = quantile(sorted, 0.25);
    const p75 = quantile(sorted, 0.75);
    const map = trackMapper(current == null || values.includes(current) ? values : [...values, current]);
    const { phrase, hot } =
      current == null ? { phrase: RECOVERY_BAND_ONLY_PHRASE[key], hot: false } : recoveryPhrase(key, current, p25, p75);
    dimensions.push({
      key,
      label: RECOVERY_DIM_LABEL[key],
      phrase,
      hot,
      position: current == null ? null : map(current),
      range_start: map(p25),
      range_end: map(p75),
      current,
      p25,
      p75,
      n: values.length,
      readings: values.length,
      span_days: readingSpanDays(dim?.first_reading_date, dim?.last_reading_date),
      last_reading_date: dim?.last_reading_date ?? null,
    });
  }
  return { dimensions };
}

const RECOVERY_FIELDS = ["hrv_ms", "resting_hr", "sleep_min"] as const;
type RecoveryField = (typeof RECOVERY_FIELDS)[number];
// Each band's dot is a CURRENT reading, so it answers to the same per-signal age
// bound every other decision site uses rather than to this module's window length.
const RECOVERY_FIELD_SIGNAL: Record<RecoveryField, SensorSignal> = {
  hrv_ms: "hrv",
  resting_hr: "resting_hr",
  sleep_min: "sleep",
};
type RecoveryDbRow = { date: string } & Partial<Record<RecoveryField, number | null>>;

// Collapse a source's rows to the newest non-null value per date/field. Rows
// arrive `date DESC, updated_at DESC`, so the FIRST non-null seen per field is
// the newest.
function collapseRecoveryRows(rows: RecoveryDbRow[]): Map<string, Record<RecoveryField, number | null>> {
  const byDate = new Map<string, Record<RecoveryField, number | null>>();
  for (const row of rows) {
    const date = String(row.date);
    let slot = byDate.get(date);
    if (!slot) {
      slot = { hrv_ms: null, resting_hr: null, sleep_min: null };
      byDate.set(date, slot);
    }
    for (const field of RECOVERY_FIELDS) {
      const raw = row[field];
      if (slot[field] == null && raw != null && Number.isFinite(Number(raw))) slot[field] = Number(raw);
    }
  }
  return byDate;
}

// DB wrapper: assemble each dimension's sample — the most recent `maxPoints`
// readings from no further back than `lookbackDays` — out of the same two tables
// the unified recovery summary merges (garmin_daily_metrics and the
// source-agnostic daily_metrics), with Garmin PREFERRED per field per date
// (mirrors getRecoverySummary's precedence). Selection is per FIELD, so a wearer
// whose sleep is logged nightly and whose HRV only lands on run days gets each
// band built from its own newest readings rather than from one shared window.
// Then hand the sample to the pure core. Deterministic; null-safe (no rows →
// empty). For a daily wearer the newest 28 readings are the last 28 days, so the
// band is bit-for-bit what the old calendar window produced.
export function getRecoveryBaselineRead(
  lookbackDays = RECOVERY_BASELINE_LOOKBACK_DAYS,
  maxPoints = RECOVERY_BASELINE_MAX_POINTS
): RecoveryBaselineRead {
  const today = localDateISO();
  const since = localDateISO(new Date(Date.now() - Math.max(0, lookbackDays - 1) * 864e5));
  const cols = "date, resting_hr, hrv_ms, sleep_min";
  const generic = db
    .prepare(
      `SELECT ${cols} FROM daily_metrics WHERE date >= ? AND date <= ? ORDER BY date DESC, updated_at DESC, id DESC`
    )
    .all(since, today) as RecoveryDbRow[];
  const garmin = db
    .prepare(
      `SELECT ${cols} FROM garmin_daily_metrics WHERE date >= ? AND date <= ? ORDER BY date DESC, updated_at DESC, id DESC`
    )
    .all(since, today) as RecoveryDbRow[];

  const g = collapseRecoveryRows(garmin);
  const o = collapseRecoveryRows(generic);
  const dates = new Set<string>([...g.keys(), ...o.keys()]);
  const series: Record<RecoveryField, Array<{ date: string; v: number }>> = {
    hrv_ms: [],
    resting_hr: [],
    sleep_min: [],
  };
  for (const date of dates) {
    for (const field of RECOVERY_FIELDS) {
      const v = g.get(date)?.[field] ?? o.get(date)?.[field] ?? null; // Garmin preferred, else generic
      if (v != null) series[field].push({ date, v });
    }
  }
  const cap = Math.max(1, Math.floor(maxPoints));
  const dim = (field: RecoveryField): RecoveryBaselineDimInput => {
    const arr = series[field];
    if (!arr.length) return { values: [], current: null, first_reading_date: null, last_reading_date: null };
    // Newest first, then take the cap — "the last N readings", not "the last N days".
    const newestFirst = [...arr].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const used = newestFirst.slice(0, cap);
    const latest = used[0];
    const oldest = used[used.length - 1];
    // The band's dot is spoken in the PRESENT TENSE ("above your usual"), so it may
    // only be drawn from a reading that can still speak for today. Past the signal's
    // age bound the dot is dropped and never repositioned from the last known value.
    // The band behind it is a durable personal range and still renders — dotless,
    // with its provenance, so the client can say how old the picture is.
    const fresh = sensorIsCurrent(RECOVERY_FIELD_SIGNAL[field], latest.date, today);
    return {
      values: used.map((x) => x.v),
      current: fresh ? latest.v : null,
      first_reading_date: oldest.date,
      last_reading_date: latest.date,
    };
  };
  return recoveryBaselineRead({ hrv: dim("hrv_ms"), rhr: dim("resting_hr"), sleep: dim("sleep_min") });
}

// ---- training-load band ------------------------------------------------------

export interface TrainingLoadBand {
  label: string;
  phrase: string;
  hot: boolean;
  position: number;
  range_start: number;
  range_end: number;
  current: number;
  p25: number;
  p75: number;
  n: number; // number of prior weekly buckets in the baseline
}

// A "typical week" range needs a few prior weeks behind it to mean anything.
export const TRAINING_LOAD_MIN_WEEKS = 4;

// PURE: this week's load vs the distribution of the athlete's prior weekly loads.
// `current` is the trailing-7-day set count; `history` is the set counts of the
// preceding non-overlapping 7-day weeks (oldest→newest, leading pre-training
// empty weeks already trimmed by the wrapper). Fewer than TRAINING_LOAD_MIN_WEEKS
// prior weeks → null (thin history → the client shows nothing). "running hot" is
// the only lever (terracotta): a heavier-than-usual week is a cue to protect
// recovery. A lighter week is calm information, never a scold.
export function trainingLoadBaselineRead(input: { current: number; history: number[] }): TrainingLoadBand | null {
  const history = (input?.history ?? []).filter((v) => Number.isFinite(v));
  if (history.length < TRAINING_LOAD_MIN_WEEKS) return null;
  const current = Number.isFinite(input.current) ? input.current : 0;
  const sorted = [...history].sort((a, b) => a - b);
  const p25 = quantile(sorted, 0.25);
  const p75 = quantile(sorted, 0.75);
  const map = trackMapper([...history, current]);
  const above = current > p75;
  const below = current < p25;
  const phrase = above ? "running hot" : below ? "a lighter week than usual" : "about your usual volume";
  return {
    label: "Training load",
    phrase,
    hot: above,
    position: map(current),
    range_start: map(p25),
    range_end: map(p75),
    current,
    p25,
    p75,
    n: history.length,
  };
}

const TRAINING_LOAD_PRIOR_WEEKS = 8;

// DB wrapper: trailing weekly set counts (the honest simple volume proxy — every
// logged set, timed sets included, matching getWeeklyStats' `week_sets`).
// `current` is the last 7 days ending today; the baseline is the eight preceding
// non-overlapping 7-day weeks with the leading pre-training empty weeks trimmed
// off (an interior rest week legitimately stays a 0 and widens the range).
// Reuses the same logged_sets⋈sessions date-window query getWeeklyStats uses.
// Deterministic; thin history → null.
export function trainingLoadBand(date?: string): TrainingLoadBand | null {
  const requested = String(date || "").slice(0, 10);
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : localDateISO();
  const anchorMs = Date.parse(`${anchor}T00:00:00Z`);
  const iso = (offsetDays: number) => new Date(anchorMs - offsetDays * 864e5).toISOString().slice(0, 10);
  const setsBetween = db.prepare(
    `SELECT COUNT(*) AS c FROM logged_sets l JOIN sessions s ON s.id = l.session_id WHERE s.date >= ? AND s.date <= ?`
  );
  // A 7-day window ending `endOffset` days before the anchor (inclusive both ends).
  const weekSets = (endOffset: number): number =>
    Number((setsBetween.get(iso(endOffset + 6), iso(endOffset)) as { c?: number } | undefined)?.c ?? 0);

  const current = weekSets(0); // today−6 … today
  const history: number[] = []; // oldest → newest
  for (let w = TRAINING_LOAD_PRIOR_WEEKS; w >= 1; w--) history.push(weekSets(w * 7));
  while (history.length && history[0] === 0) history.shift(); // drop pre-training empty weeks
  return trainingLoadBaselineRead({ current, history });
}
