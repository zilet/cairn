// ============================================================================
// overnight-band.ts — when ONE night's HRV or resting HR is a finding.
//
// The athlete's own band for an overnight field is taken off their own earlier
// readings: the mean, and the line one night has to cross to count — mean less (HRV)
// or plus (resting HR) one of their own standard deviations, never narrower than
// recoveryTrendBars. The harm arms (read-adherence.ts) and the run morning's floor
// (run-day-intensity.ts) both judge a night against it, so the two cannot disagree.
//
// ---------- A HAIR PAST THE LINE IS NOT A MEANINGFUL MISS (owner ruling 2026-09-29) ----------
//
// The line is a boundary, and a boundary charged at any distance past it turns
// measurement noise into a finding. A night 0.2 ms under a line 41.2 ms high was
// charged as physiology harm and set a 32.5 km week aside — and the athlete ran a
// 17.7 km long run well two days later.
//
// The HRV-guided training literature acts on MEANINGFUL deviations from a rolling
// personal baseline, never on single-night noise: the smallest worthwhile change is
// about half a standard deviation of the athlete's own baseline (Hopkins; Plews et al.
// 2012–2014, whose guided-training decisions read the rolling average against it),
// and the HRV-guided protocols (Kiviniemi et al. 2007/2010) change the day's session
// only when the reading sits outside the athlete's own band — and the rolling-average
// methods exist precisely because one night is noisy. So a night past the line is:
//
//   • MEANINGFUL — past it by at least the smallest worthwhile change, half the band's
//     own width (`SWC_SD_FRACTION` × max(sd, trend bar)). One such night brakes.
//   • MARGINAL — past the line by less than that. Alone it is a caveat: never harm,
//     never a brake. Two consecutive READINGS past the line (the newest earlier reading
//     still current for its signal, SENSOR_MAX_AGE_DAYS) are sustained suppression and
//     brake as one meaningful night does.
//
// The last-night law is untouched: only the night dated the morning itself may speak
// for it, and the prior reading only ever CORROBORATES a last-night reading past the
// line — it can never brake a morning on its own.
// ============================================================================

import { RECOVERY_BASELINE_MIN_POINTS } from "./baseline-bands.js";
import { sampleSd, SWC_SD_FRACTION } from "./recovery-science.js";
import { recoveryTrendBars } from "./recovery-trend.js";

export type OvernightField = "hrv_ms" | "resting_hr";

// ---------- A RESTING HR THE DAY'S OWN FLOOR ARGUES WITH IS NOT A READING ----------
//
// On a day the watch was not worn overnight Garmin posts a PROVISIONAL daytime resting
// HR, and it can sit below the same row's own `min_hr` (live 2026-10-06: resting 60
// beside a min 62) — physically impossible — or implausibly far above it. A true
// resting HR sits just above the day's floor (1-3 bpm in every sleep-backed row on
// record). The tolerance is relative, so an athlete whose floor sits at 70 is not told
// their own 77 argues with it; at a floor of 50 it is exactly 5.
//
// This is the ONE coherence test. The recovery summary's READING_TRUST (coach.ts) drops
// a contradicted reading from its trend windows with it, and the harm arms
// (read-adherence.ts `overnightNights`) drop it both as last night and from the band
// the athlete is compared against — so the run plan and the harm ladder cannot hold two
// opinions about the same number. The caller passes a `min_hr` from the SAME source as
// the resting HR; a missing floor (or a missing reading) cannot contradict anything.
export const RESTING_HR_FLOOR_MARGIN = 5;
export const RESTING_HR_FLOOR_MARGIN_RATIO = 0.1;

/**
 * True when the same source's day floor contradicts the resting HR: below it, or more
 * than max(5, 10% of the floor) above it. Null/non-finite inputs never contradict.
 */
export function restingHrContradictedByFloor(
  resting: number | null | undefined,
  minHr: number | null | undefined
): boolean {
  if (resting == null || minHr == null) return false;
  const r = Number(resting);
  const floor = Number(minHr);
  if (!Number.isFinite(r) || !Number.isFinite(floor)) return false;
  return !(r >= floor && r - floor <= Math.max(RESTING_HR_FLOOR_MARGIN, RESTING_HR_FLOOR_MARGIN_RATIO * floor));
}

// ---------- A RESTING HR ITS OWN SOURCE VOUCHES FOR ----------
// The positive half of the same question, for a decision that may REST a day on one
// reading (morning-dose.ts, E): the reading's OWN row shows the overnight it claims to
// describe — a same-row `min_hr` it coheres with, or a same-row night of at least
// RESTING_HR_SLEEP_WITNESS_MIN minutes — and the value is a possible resting HR. The
// recovery summary's READING_TRUST (coach.ts) calls this `verified` by the same rule. A
// row with neither (a generic phone or ring row carries no `min_hr`) is not evidence of a
// problem; it is a reading nothing could check, so it may caution a day, never rest it.
/** The shortest same-row night that vouches for a resting HR reading (minutes). */
export const RESTING_HR_SLEEP_WITNESS_MIN = 120;
/** The physiological band a resting HR must sit in before anything may vouch for it. */
export const RESTING_HR_PLAUSIBLE_RANGE = Object.freeze({ min: 30, max: 90 });

export function restingHrReadingVerified(
  resting: number | null | undefined,
  minHr: number | null | undefined,
  sleepMin: number | null | undefined
): boolean {
  if (resting == null || !Number.isFinite(Number(resting))) return false;
  const r = Number(resting);
  if (r < RESTING_HR_PLAUSIBLE_RANGE.min || r > RESTING_HR_PLAUSIBLE_RANGE.max) return false;
  const floor = minHr == null ? null : Number(minHr);
  if (floor != null && Number.isFinite(floor) && floor > 0) return !restingHrContradictedByFloor(r, floor);
  const night = sleepMin == null ? null : Number(sleepMin);
  return night != null && Number.isFinite(night) && night >= RESTING_HR_SLEEP_WITNESS_MIN;
}

export interface PersonalBand {
  mean: number;
  /** The line one night has to cross to count at all. */
  line: number;
  /** The band's own width: max(the athlete's sd, recoveryTrendBars). */
  width: number;
  /** The line a night has to cross by the smallest worthwhile change to brake alone. */
  meaningful_line: number;
}

/** How far past the athlete's own line one night sits: a meaningful miss, a marginal one, or neither. */
export type NightPast = "meaningful" | "marginal" | null;

/**
 * The athlete's OWN band for one overnight field, from their own earlier readings. Null
 * below RECOVERY_BASELINE_MIN_POINTS. The one formula every per-night judgement uses.
 */
export function personalBand(values: readonly number[], field: OvernightField): PersonalBand | null {
  if (values.length < RECOVERY_BASELINE_MIN_POINTS) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = sampleSd([...values]) ?? 0;
  const bars = recoveryTrendBars({ hrv: mean, rhr: mean });
  const width = Math.max(field === "hrv_ms" ? bars.hrv : bars.rhr, sd);
  const swc = width * SWC_SD_FRACTION;
  return field === "hrv_ms"
    ? { mean, line: mean - width, width, meaningful_line: mean - width - swc }
    : { mean, line: mean + width, width, meaningful_line: mean + width + swc };
}

/** Where one reading sits against the band: past it meaningfully, marginally, or not at all. */
export function nightPastBand(
  value: number | null | undefined,
  band: PersonalBand | null,
  field: OvernightField
): NightPast {
  if (value == null || !Number.isFinite(value) || !band) return null;
  if (field === "hrv_ms") {
    if (!(value < band.line)) return null;
    return value <= band.meaningful_line ? "meaningful" : "marginal";
  }
  if (!(value > band.line)) return null;
  return value >= band.meaningful_line ? "meaningful" : "marginal";
}

/**
 * Does last night brake? A meaningful miss on its own, or a miss of any size the reading
 * before it corroborates (two consecutive readings past the line). A marginal night alone
 * never does.
 */
export function overnightBrakes(tonight: NightPast, prior: NightPast): boolean {
  if (tonight === "meaningful") return true;
  return tonight === "marginal" && prior != null;
}

// ============================================================================
// THE ROLLING READ — what a REST decision may ask of HRV (owner ruling 2026-11-12).
//
// One night is too noisy to decide a day: the guided-training protocols judge a rolling
// value (about a week) against a personal band taken off the few weeks before it, and
// need several valid nights inside the window before the value means anything. So the
// one-night logic above stays for the uses that are not rest decisions (the harm arms),
// and a rest decision reads THIS: the mean of the valid readings in the rolling window
// ending on `asOf`, against the athlete's band from the baseline window before it.
// Fewer than `minNights` valid readings in the window and the read says nothing — absent
// data never brakes. Pure; the caller supplies the series and the window sizes (the
// tunables live in morning-dose.ts).
// ============================================================================
export interface RollingBandRead {
  /** Mean of the valid readings in the rolling window, or null below `minNights`. */
  value: number | null;
  /** Valid readings in the rolling window. */
  nights: number;
  band: PersonalBand | null;
  /** The rolling value sits past the athlete's own line (below for HRV, above for resting HR). */
  past_line: boolean;
}

export function rollingBandRead(
  series: ReadonlyArray<{ date: string; value: number }>,
  field: OvernightField,
  asOf: string,
  opts: {
    windowDays: number;
    minNights: number;
    baselineDays: number;
    /**
     * When set, at least one valid reading must be dated within this many days ending on
     * `asOf` (2 = last night or the night before), or the read says nothing: a window whose
     * every night is old is not about this morning.
     */
    recentNightDays?: number;
  }
): RollingBandRead {
  const dayMs = 864e5;
  const asOfMs = Date.parse(`${String(asOf).slice(0, 10)}T00:00:00Z`);
  const none: RollingBandRead = { value: null, nights: 0, band: null, past_line: false };
  if (!Number.isFinite(asOfMs)) return none;
  const windowStart = asOfMs - (opts.windowDays - 1) * dayMs;
  const baselineStart = windowStart - opts.baselineDays * dayMs;
  const anchorStart = opts.recentNightDays != null ? asOfMs - (opts.recentNightDays - 1) * dayMs : null;
  const recent: number[] = [];
  const baseline: number[] = [];
  let anchored = anchorStart == null;
  for (const point of series) {
    const at = Date.parse(`${String(point.date).slice(0, 10)}T00:00:00Z`);
    const value = Number(point.value);
    if (!Number.isFinite(at) || !Number.isFinite(value) || value <= 0) continue;
    if (at >= windowStart && at <= asOfMs) {
      recent.push(value);
      if (anchorStart != null && at >= anchorStart) anchored = true;
    } else if (at >= baselineStart && at < windowStart) baseline.push(value);
  }
  const band = personalBand(baseline, field);
  if (recent.length < opts.minNights || !anchored) return { ...none, nights: recent.length, band };
  const value = recent.reduce((sum, v) => sum + v, 0) / recent.length;
  const past_line = band != null && (field === "hrv_ms" ? value < band.line : value > band.line);
  return { value, nights: recent.length, band, past_line };
}
