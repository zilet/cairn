// SENSOR COVERAGE DISCIPLINE — the one place the "is there ENOUGH of this datum
// to speak from" question is answered.
//
// Its sibling `sensor-freshness.ts` answers a different question — how OLD may a
// reading be — and the two are easy to confuse. Age is about ONE datum: a night
// from three weeks ago is not last night. Coverage is about a SERIES: seven
// perfectly fresh readings scattered across ninety days are not a baseline, and a
// two-night "recent window" is not a trend. The law here is:
//
//   A THIN SAMPLE MAY DESCRIBE ITSELF, NEVER A TREND.
//
// The athlete this module exists for wears the watch EPISODICALLY — every run,
// the occasional baseline sleep night, nothing in between. That is a legitimate
// way to use a sensor, and the product ruling it forces is the same one absence
// already gets (VISION.md): thin data is NEUTRAL. It never becomes a caution, it
// never nudges toward rest, and it never manufactures a verdict. When coverage is
// too thin for a comparison, the comparison is simply not made — the underlying
// readings still report as themselves.
//
// Everything here is PURE: callers pass the dates and the counts they already
// have, and nothing in this file reads the database or the clock. That is what
// lets the same thresholds bind the Brief, the coach prompt, the conductor and
// the run plan without any of them being able to quietly disagree.

// ---- wear pattern -----------------------------------------------------------

// How the athlete actually uses the sensor over a long window.
//  • continuous  — worn most days; a genuine daily record, safe to trend.
//  • intermittent — worn often enough to have a personal norm, but with real
//    gaps; comparisons are honest only when the specific windows are covered.
//  • spot_check  — a handful of readings. Each one describes its own day and
//    nothing more.
//  • none        — nothing in the window. Absence, which is already neutral.
export type WearPattern = "continuous" | "intermittent" | "spot_check" | "none";

export type SensorCadence = {
  pattern: WearPattern;
  readings: number;
  window_days: number;
  coverage_ratio: number;
  last_reading_date: string | null;
  median_gap_days: number | null;
};

// Fraction of the window that must carry a reading before the series reads as a
// continuous daily record. 0.6 is deliberately below "most days": a continuous
// wearer still loses days to charging, travel and a flat battery, and holding
// them to 0.9 would demote an honestly daily record to "intermittent".
export const CONTINUOUS_COVERAGE = 0.6;
// Below this the series is a scatter of spot checks rather than a habit. 0.15 of
// ninety days is roughly a reading every week — the point at which a 30-day
// baseline window can still be expected to contain something.
export const INTERMITTENT_COVERAGE = 0.15;
// The long window a wear PATTERN is read over. Long enough that a two-week trip
// does not reclassify a daily wearer, short enough that a habit abandoned last
// season stops counting.
export const CADENCE_WINDOW_DAYS = 90;

const DAY_MS = 864e5;

// Midnight-UTC epoch for a YYYY-MM-DD string; null when it is not one. Date-only
// strings are parsed in UTC on purpose — these are day KEYS, not instants, so a
// local-zone parse would slip a day under a negative offset.
function dayEpoch(iso: unknown): number | null {
  const text = String(iso ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const t = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * Classify how the athlete wears a sensor, from the dates its readings carry.
 *
 * `readingDates` may contain duplicates, junk and dates outside the window — all
 * three are facts of life for a merged multi-source series. Duplicates collapse
 * (two sources reporting the same night is one night of coverage), unparseable
 * entries drop, and anything before the window or AFTER `today` is ignored: a
 * future-dated reading is a clock problem, not coverage, exactly as
 * `sensorIsCurrent` treats it.
 *
 * The window is inclusive of `today` and spans `windowDays` days, matching the
 * bounded-window convention the repo's aggregates already use.
 */
export function classifyWearPattern(
  readingDates: string[],
  today: string,
  windowDays: number = CADENCE_WINDOW_DAYS
): SensorCadence {
  const span = Math.max(1, Math.trunc(Number(windowDays)) || CADENCE_WINDOW_DAYS);
  const end = dayEpoch(today);
  const empty: SensorCadence = {
    pattern: "none",
    readings: 0,
    window_days: span,
    coverage_ratio: 0,
    last_reading_date: null,
    median_gap_days: null,
  };
  if (end == null) return empty;
  const start = end - (span - 1) * DAY_MS;

  const inWindow = new Set<number>();
  for (const raw of Array.isArray(readingDates) ? readingDates : []) {
    const t = dayEpoch(raw);
    if (t == null || t < start || t > end) continue;
    inWindow.add(t);
  }
  const days = [...inWindow].sort((a, b) => a - b);
  if (!days.length) return empty;

  // Ratio of covered days to window days, rounded to three places so a stored or
  // serialized cadence compares equal across runs.
  const ratio = Math.round((days.length / span) * 1000) / 1000;
  const pattern: WearPattern =
    ratio >= CONTINUOUS_COVERAGE ? "continuous" : ratio >= INTERMITTENT_COVERAGE ? "intermittent" : "spot_check";

  // Typical distance between consecutive readings — the plain-words answer to
  // "how often do they actually measure this". Undefined for a single reading:
  // one dot has no rhythm.
  let medianGap: number | null = null;
  if (days.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < days.length; i++) gaps.push(Math.round((days[i] - days[i - 1]) / DAY_MS));
    gaps.sort((a, b) => a - b);
    const mid = gaps.length >> 1;
    const raw = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
    medianGap = Math.round(raw * 10) / 10;
  }

  return {
    pattern,
    readings: days.length,
    window_days: span,
    coverage_ratio: ratio,
    last_reading_date: new Date(days[days.length - 1]).toISOString().slice(0, 10),
    median_gap_days: medianGap,
  };
}

// ---- decision-grade coverage ------------------------------------------------

// When a caller cannot say how many days its window covered, this is the sample
// count below which a recent-vs-baseline delta is not a coaching lead. Five is
// deliberately STRICTER than the floor that applies with a known window: an
// unknown window is the case where we cannot check whether the samples are
// spread or bunched, so the count has to carry the whole argument.
const UNKNOWN_WINDOW_FLOOR = 5;
// Half of a known window is enough to call it covered, but a window longer than a
// fortnight does not keep raising the bar — seven readings is a trend at any
// length.
const WINDOW_HALF_CAP_DAYS = 14;

/**
 * Is a series dense enough for a comparison to LEAD a decision?
 *
 * The shared generalization of the gate the coaching-focus conductor has always
 * applied to its recovery lead: half of the available window, capped at a week,
 * with a floor of `minSamples`; and when the window is unknown, a flat five.
 *
 * Deliberately NOT symmetric with the freshness law — failing this does not make
 * a reading stale or wrong. It means the reading speaks for its own day and the
 * TREND stays unsaid, which is the neutral outcome absence already produces.
 */
export function hasDecisionGradeCoverage(
  sampleCount: number | null | undefined,
  expectedDays: number | null | undefined,
  minSamples = 3
): boolean {
  const samples = Number(sampleCount);
  if (sampleCount == null || !Number.isFinite(samples) || samples < 0) return false;
  const floor = Math.max(1, Math.trunc(Number(minSamples)) || 1);
  const expected = Number(expectedDays);
  const known = expectedDays != null && Number.isFinite(expected) && expected > 0;
  const required = known
    ? Math.max(floor, Math.ceil(Math.min(expected, WINDOW_HALF_CAP_DAYS) / 2))
    : Math.max(floor, UNKNOWN_WINDOW_FLOOR);
  return samples >= required;
}
