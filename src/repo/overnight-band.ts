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
