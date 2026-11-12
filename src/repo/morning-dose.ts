// ============================================================================
// morning-dose.ts — what this morning's body readings may conclude about the day.
//
// Owner rulings of 2026-11-12, revised against a verified evidence review. Every
// tunable lives in MORNING_DOSE_POLICY below, so a revised review changes a value,
// never a rule. Every value is PROVISIONAL.
//
// The reading of the review, in this module's terms:
//   A. A composite readiness score is an unvalidated input. Alone it never decides
//      REST on any day: an easy day on an unstated day, a dosed training day (loads
//      held, no reach, the regions yesterday loaded lighter) on a STATED lifting or
//      key-run day.
//   B. HRV decides a REST only as a ROLLING value (a ~week of valid nights against the
//      athlete's own band, overnight-band.ts `rollingBandRead`, with at least one valid
//      night in the last couple of days). One low night within a short window after a
//      hard or long endurance day, resting HR in band, is a usual answer to that day: a
//      caveat plus the dose.
//   C. A second consecutive low morning means EASY (low intensity), never rest.
//   D. One short night on a day with a session due keeps the session at a held dose
//      (heavy multi-joint work held back, no load raises), stated day or not; two or more
//      consecutive short nights mean easy, and so does one SEVERELY short night.
//   E. Resting HR above the athlete's band: after a hard day it is easy at most, on every
//      day, and never a training day when HRV is past its own band the same night. On a
//      second consecutive calendar morning, or — with an established personal band and a
//      reading its own source vouches for — on one night with no hard day behind it or
//      beside the athlete's own low word or a symptom report, it reads as possible
//      illness: REST. An unvouched single reading is a caution: easy at most.
//   F. REST is otherwise reserved for the floors the engine already owns (illness, pain,
//      clinical, safety, the athlete's corroborated low word, a recovery week or a
//      calendar hold) plus a SUSTAINED rolling HRV decline beside the log-confirmed
//      performance shortfall the deload read already computes.
//   G. A positive check-in lifts ONE step only a caution that rests on the composite
//      readiness score or on a single low HRV night; intensity stays held. It never lifts
//      acute load, resting HR, short sleep, a rolling HRV decline or any floor.
// The coaching defaults this module triggers (loads held, no load raises, the regions
// yesterday loaded kept lighter) are conservative defaults, not trial findings.
//
// Absence never vouches and never brakes: an unknowable yesterday, night or reading
// adds nothing here.
// ============================================================================
import {
  morningReadinessReading,
  overnightReadOn,
  overnightSeries,
  watchWakeReading,
  type OvernightFieldRead,
} from "./brain/read-adherence.js";
import { latestSleep } from "./coach.js";
import { rollingBandRead, type RollingBandRead } from "./overnight-band.js";
import { readsLowReadiness } from "./readiness-bands.js";
import { LAST_NIGHT_MAX_AGE_DAYS } from "./sensor-freshness.js";
import { addDaysISO } from "./shared.js";
import { dayLoad, hardCardioDay } from "./training-read.js";

export const MORNING_DOSE_POLICY = Object.freeze({
  // ---- B: the rolling HRV read ----
  /** Days in the rolling HRV window. */
  hrv_rolling_window_days: 7,
  /** Valid nights the rolling window needs before HRV says anything at all. */
  hrv_rolling_min_nights: 3,
  /** Days of baseline before the rolling window, for the athlete's own band. */
  hrv_baseline_days: 28,
  /**
   * The rolling read also needs a valid night inside this many days ending on the morning
   * (2 = last night or the night before): a window of only old nights is not this morning.
   */
  hrv_rolling_recent_night_days: 2,
  /** Days after a hard or long endurance day inside which a low night is the expected answer to it. */
  endurance_window_days: 2,
  // ---- C: persistence ----
  /** Consecutive low mornings (this one counted) that make the day EASY, never dosed. */
  low_mornings_for_easy: 2,
  // ---- D: short nights ----
  /** Consecutive short nights (last night counted) that make the day EASY. One short night is the dose. */
  short_nights_for_easy: 2,
  /**
   * A night shorter than this (minutes) reads EASY on its own, even on a stated day. A
   * conservative coaching default, NOT a literature finding: the review supports a cost
   * from sleep at or under ~6 h and more from consecutive restriction, not a specific
   * single-night cut-off; "about four hours" is where the owner's ruling puts the floor.
   */
  severe_short_night_max_min: 240,
  // ---- E: resting HR above the athlete's band ----
  /** How far past the athlete's line ONE night must sit to count ("meaningful" = by the smallest worthwhile change). */
  rhr_single_night_min_past: "meaningful" as "meaningful" | "marginal",
  /** Consecutive CALENDAR mornings past the line that make an elevated resting HR the illness pattern. */
  rhr_illness_consecutive_readings: 2,
  /**
   * What resting HR past the line needs before it may REST a day as possible illness — on
   * BOTH arms, one meaningful night and consecutive mornings (second review, item 7): the
   * athlete's own established band (not the watch's seven-day fallback) and readings their
   * own rows vouch for (overnight-band.ts restingHrReadingVerified) — last night's, and on
   * the consecutive arm the morning before's too. Without them it is a caution: easy at most.
   */
  rhr_rest_requires: Object.freeze({ established_band: true, verified_reading: true }),
  // ---- F: a sustained rolling HRV decline ----
  /** Consecutive mornings the rolling HRV value must sit below the athlete's line to be SUSTAINED. */
  hrv_sustained_decline_mornings: 3,
  // ---- G: the positive check-in ----
  /** A same-day energy tap at or above this lifts a readiness-only caution one step. */
  checkin_lift_energy_min: 4,
  /** …unless sleep-feel sits at or below this: a mixed morning stays an advisory caveat. */
  checkin_lift_sleep_feel_veto_max: 2,
  /**
   * The only deciding brakes a check-in may lift over (one must be present): the composite
   * readiness score, and HRV — only while it is a SINGLE low night (last night alone past
   * the band, the rolling read not past its line). Never acute load, resting HR, short
   * sleep, a rolling HRV decline, or any rest-reserved floor.
   */
  checkin_liftable_brakes: Object.freeze(["training_readiness", "hrv"]) as readonly string[],
  /**
   * Brakes that may sit BESIDE it without blocking the lift: the legs' share of yesterday's
   * endurance and generic activity — what the held dose and the lighter regions already
   * answer, never a reading of the body. Acute load (acute:chronic past its bar) is NOT here:
   * it is the week's load, not the morning's, and a tap does not answer it.
   */
  checkin_lift_tolerated_brakes: Object.freeze(["hybrid_interference", "generic_activity_load"]) as readonly string[],
});

/** What "one step" maps to (G): an easy read becomes a training day at a held intensity. */
export const CHECKIN_LIFT_STEP = Object.freeze({ easy: "train_held" } as const);

export type LoadExplanation = "hard_cardio_yesterday" | "hard_day_yesterday" | "wake_reading_restates_load";

/** What the morning's body readings conclude, before the engine's own floors. */
export type MorningBasis =
  // REST (E, F)
  | "resting_hr_illness_pattern"
  | "hrv_decline_with_shortfall"
  // EASY on every day (C, D, E)
  | "consecutive_short_nights"
  | "consecutive_low_mornings"
  | "severe_short_night"
  | "resting_hr_after_endurance"
  | "resting_hr_unconfirmed"
  // EASY on an unstated day, the DOSE on a stated one (A)
  | "readiness_rest_grade"
  // the DOSE on a stated day; nothing here on an unstated one (A): the milder low band
  | "readiness_low"
  // the DOSE on any day with a session due (B, D)
  | "short_night"
  | "overnight_dip_after_endurance";

export interface MorningFacts {
  /** The read's own fresh rest-grade reading this morning (A). */
  rest_grade_today: boolean;
  /** Consecutive mornings, this one counted, with a fresh low readiness reading (C). */
  low_readiness_mornings: number;
  /** Consecutive short nights, last night counted, by the read's own short-night rule (D). */
  short_nights: number;
  /** Last night's length in minutes, when known (D's severe floor). */
  last_night_min: number | null;
  /**
   * The read's own chronic short-sleep trend (its rolling average under the short-night
   * bar): a short night on top of it is consecutive restriction, not a single night (D).
   */
  short_sleep_trend?: boolean;
  /** Last night's HRV / resting HR against the athlete's own band. */
  hrv_night: OvernightFieldRead | null;
  rhr_night: OvernightFieldRead | null;
  /**
   * On the consecutive arm: the morning before's resting HR was ALSO judged against the
   * athlete's own established band, on a reading its row vouches for (E). Absent = not
   * shown, which never rests a day.
   */
  rhr_prior_trusted?: boolean;
  /** A hard or long endurance day inside the endurance window (B, E). */
  hard_endurance_recent: boolean;
  /** What about yesterday explains a low morning (provenance; A's dose is not conditional on it). */
  load_explained: LoadExplanation[];
  /** The rolling HRV read this morning, and consecutive mornings it has sat below the line (F). */
  hrv_rolling: { past_line: boolean; nights: number; mornings_below: number };
  /** The log-confirmed performance shortfall the deload read computes (F). */
  performance_shortfall: boolean;
  /** The athlete's own run-down word today, and a symptom report stated today (E). */
  low_word: boolean;
  symptom_today: boolean;
}

export interface MorningVerdict {
  /** rest / easy / dose — "dose" means a training day at a held dose. Null: the morning concludes nothing here. */
  kind: "rest" | "easy" | "dose" | null;
  basis: MorningBasis | null;
}

// "A hard day before" for the resting-HR read: hard endurance inside the window, or a day
// the ordinary load grade called hard yesterday (heavy lifting raises it too).
function hardDayRecent(facts: MorningFacts): boolean {
  return facts.hard_endurance_recent || facts.load_explained.includes("hard_day_yesterday");
}

// Resting HR past the athlete's line on consecutive CALENDAR mornings (E).
function restingHrRepeated(facts: MorningFacts): boolean {
  return (facts.rhr_night?.consecutive_days ?? 0) >= MORNING_DOSE_POLICY.rhr_illness_consecutive_readings;
}

// The resting-HR readings a REST may stand on (E, `rhr_rest_requires`): last night judged
// against the athlete's own established band on a reading its row vouches for — and, on
// the consecutive arm, the morning before as well.
function restingHrTrusted(facts: MorningFacts): boolean {
  const rhr = facts.rhr_night;
  const needs = MORNING_DOSE_POLICY.rhr_rest_requires;
  if (rhr == null) return false;
  const lastNight = (!needs.established_band || rhr.established_band) && (!needs.verified_reading || rhr.verified);
  return lastNight && (!restingHrRepeated(facts) || facts.rhr_prior_trusted === true);
}

/**
 * Whether the resting-HR caution (`resting_hr_unconfirmed`) stands on consecutive mornings
 * rather than one reading — for words that are true of it (item 4): "one reading" only
 * when it is one.
 */
export function restingHrCautionRepeated(facts: MorningFacts | null): boolean {
  return facts != null && restingHrRepeated(facts);
}

/**
 * Which shape of the possible-illness pattern a morning is (E), for words that are true
 * of it: `repeat` (consecutive mornings), `unexplained` (one night, no hard day behind
 * it), `reported` (one night after a hard day, beside the athlete's own low word or a
 * symptom stated today). Null when the pattern did not fire.
 */
export function restingHrIllnessShape(facts: MorningFacts | null): "repeat" | "unexplained" | "reported" | null {
  if (!facts || classifyMorning(facts, false).basis !== "resting_hr_illness_pattern") return null;
  if (restingHrRepeated(facts)) return "repeat";
  return hardDayRecent(facts) ? "reported" : "unexplained";
}

/**
 * The pure classifier (A–F). `stated` is whether the athlete's stated week puts a lift
 * or key run on the day. Precedence: the REST patterns, then the EASY patterns (every
 * day), then the single-morning reads, then the post-endurance dip.
 */
export function classifyMorning(facts: MorningFacts, stated: boolean): MorningVerdict {
  const policy = MORNING_DOSE_POLICY;
  const rhr = facts.rhr_night;
  const repeated = restingHrRepeated(facts);
  const rhrPast =
    rhr != null && (policy.rhr_single_night_min_past === "marginal" || rhr.past === "meaningful" || repeated);
  const hardDay = hardDayRecent(facts);
  // Resting HR may REST a day only on the athlete's own established band and readings their
  // own source vouches for — one night, or consecutive mornings alike (item 7); otherwise it
  // is a caution (easy at most).
  const trusted = restingHrTrusted(facts);
  const singleNightIllness = !hardDay || facts.low_word || facts.symptom_today;
  if (rhrPast && trusted && (repeated || singleNightIllness))
    return { kind: "rest", basis: "resting_hr_illness_pattern" };
  if (facts.hrv_rolling.mornings_below >= policy.hrv_sustained_decline_mornings && facts.performance_shortfall)
    return { kind: "rest", basis: "hrv_decline_with_shortfall" };
  if (facts.short_nights >= policy.short_nights_for_easy) return { kind: "easy", basis: "consecutive_short_nights" };
  if (facts.low_readiness_mornings >= policy.low_mornings_for_easy)
    return { kind: "easy", basis: "consecutive_low_mornings" };
  if (rhrPast) {
    // Readings nothing vouches for, with nothing hard behind them (or beside the athlete's
    // own word): a caution — one night or several.
    if (singleNightIllness) return { kind: "easy", basis: "resting_hr_unconfirmed" };
    // E: resting HR past the band after a hard day is easy at most, on every day.
    return { kind: "easy", basis: "resting_hr_after_endurance" };
  }
  // D: one short night keeps a due session at a held dose, on any day — unless it was
  // severely short.
  if (facts.short_nights >= 1) {
    if (facts.last_night_min != null && facts.last_night_min < policy.severe_short_night_max_min)
      return { kind: "easy", basis: "severe_short_night" };
    // On top of a short rolling average the night is not a single one: easy, as two are.
    if (facts.short_sleep_trend === true) return { kind: "easy", basis: "consecutive_short_nights" };
    return { kind: "dose", basis: "short_night" };
  }
  if (facts.rest_grade_today) return { kind: stated ? "dose" : "easy", basis: "readiness_rest_grade" };
  // A: the milder low band is the SAME dose on a stated day — a worse score never buys a
  // more permissive day, nor a milder one a harsher day (second review, item 2). On an
  // unstated day this module concludes nothing: the engine's own rules read it easy.
  if (stated && facts.low_readiness_mornings >= 1) return { kind: "dose", basis: "readiness_low" };
  if (facts.hrv_night != null && facts.hard_endurance_recent && rhr == null)
    return { kind: "dose", basis: "overnight_dip_after_endurance" };
  return { kind: null, basis: null };
}

function safely<T>(compute: () => T, fallback: T): T {
  try {
    return compute();
  } catch {
    return fallback;
  }
}

/** Is a check-in a lifting tap (G)? Absent fields never lift. */
export function checkinLiftsRead(checkin: { energy?: unknown; sleep_feel?: unknown } | null | undefined): boolean {
  if (!checkin || checkin.energy == null) return false;
  const energy = Number(checkin.energy);
  if (!Number.isFinite(energy) || energy < MORNING_DOSE_POLICY.checkin_lift_energy_min) return false;
  if (checkin.sleep_feel != null && Number(checkin.sleep_feel) <= MORNING_DOSE_POLICY.checkin_lift_sleep_feel_veto_max)
    return false;
  return true;
}

/**
 * May a lifting tap (G) lift a quiet read over THESE deciding brakes? Only when at least
 * one is liftable (the readiness score, or HRV while it is a single low night) and every
 * other is a tolerated load-arithmetic brake. Acute load, resting HR, short sleep, a
 * rolling HRV decline and every floor fall outside both lists, so any of them holds the
 * read. Pure: the caller says whether the HRV brake is a single night.
 */
export function checkinLiftsBrakes(decidingBrakes: readonly string[], hrvSingleNight: boolean): boolean {
  const policy = MORNING_DOSE_POLICY;
  const liftable = (field: string) =>
    policy.checkin_liftable_brakes.includes(field) && (field !== "hrv" || hrvSingleNight);
  return (
    decidingBrakes.some(liftable) &&
    decidingBrakes.every((field) => liftable(field) || policy.checkin_lift_tolerated_brakes.includes(field))
  );
}

function rollingHrvOn(date: string): RollingBandRead {
  const policy = MORNING_DOSE_POLICY;
  const from = addDaysISO(
    date,
    -(policy.hrv_rolling_window_days + policy.hrv_baseline_days + policy.hrv_sustained_decline_mornings)
  );
  if (!from) return { value: null, nights: 0, band: null, past_line: false };
  const series = overnightSeries("hrv_ms", from, date);
  return rollingBandRead(series, "hrv_ms", date, {
    windowDays: policy.hrv_rolling_window_days,
    minNights: policy.hrv_rolling_min_nights,
    baselineDays: policy.hrv_baseline_days,
    recentNightDays: policy.hrv_rolling_recent_night_days,
  });
}

export interface MorningFactInputs {
  /** The read's own fresh low / rest-grade reading this morning. */
  lowReadinessToday: boolean;
  restGradeToday: boolean;
  /** The read's own short-night rule, for a night's minutes (null minutes = no night). */
  isShortNight: (minutes: unknown) => boolean;
  /** The read's own chronic short-sleep trend (its rolling average under the short-night bar). */
  shortSleepTrend?: boolean;
  lowWord: boolean;
  symptomToday: boolean;
  cardioLoadMedian?: number | null;
  /** The log-confirmed shortfall, asked lazily (only when the rolling HRV read is sustained). */
  performanceShortfall: () => boolean;
}

/** Gather the facts for `date` from the readings the harm test already reads. Fail-soft per fact. */
export function morningFacts(date: string, input: MorningFactInputs): MorningFacts {
  const policy = MORNING_DOSE_POLICY;
  const yesterday = addDaysISO(date, -1);
  const load_explained: LoadExplanation[] = [];
  if (yesterday) {
    if (safely(() => hardCardioDay(yesterday, input.cardioLoadMedian), false))
      load_explained.push("hard_cardio_yesterday");
    if (safely(() => dayLoad(yesterday, { countsCardio: true }) === "hard", false))
      load_explained.push("hard_day_yesterday");
  }
  if (safely(() => watchWakeReading(date)?.restates_load === true, false))
    load_explained.push("wake_reading_restates_load");
  let hardEnduranceRecent = load_explained.includes("hard_cardio_yesterday");
  for (let back = 2; !hardEnduranceRecent && back <= policy.endurance_window_days; back++) {
    const day = addDaysISO(date, -back);
    if (day && safely(() => hardCardioDay(day, input.cardioLoadMedian), false)) hardEnduranceRecent = true;
  }

  let short_nights = 0;
  let last_night_min: number | null = null;
  for (let back = 0; back < Math.max(policy.short_nights_for_easy, 1); back++) {
    const morning = addDaysISO(date, -back);
    const night = morning ? safely(() => latestSleep(LAST_NIGHT_MAX_AGE_DAYS, morning) as any, null) : null;
    if (back === 0 && night && Number.isFinite(Number(night.total_min)) && Number(night.total_min) > 0)
      last_night_min = Number(night.total_min);
    if (!night || !input.isShortNight(night.total_min)) break;
    short_nights++;
  }

  let low_readiness_mornings = 0;
  if (input.lowReadinessToday || input.restGradeToday) {
    low_readiness_mornings = 1;
    for (let back = 1; back < policy.low_mornings_for_easy; back++) {
      const morning = addDaysISO(date, -back);
      const value = morning ? safely(() => morningReadinessReading(morning), null) : null;
      if (value == null || !readsLowReadiness(value)) break;
      low_readiness_mornings++;
    }
  }

  const overnight = safely(() => overnightReadOn(date), { hrv: null, rhr: null });
  // The consecutive arm's earlier morning, judged the way last night is (E, item 7).
  const needs = policy.rhr_rest_requires;
  const priorRhr =
    yesterday && (overnight.rhr?.consecutive_days ?? 0) >= policy.rhr_illness_consecutive_readings
      ? safely(() => overnightReadOn(yesterday).rhr, null)
      : null;
  const rhrPriorTrusted =
    priorRhr != null &&
    (!needs.established_band || priorRhr.established_band) &&
    (!needs.verified_reading || priorRhr.verified);

  let mornings_below = 0;
  const rollingToday = safely(() => rollingHrvOn(date), { value: null, nights: 0, band: null, past_line: false });
  if (rollingToday.past_line) {
    mornings_below = 1;
    for (let back = 1; back < policy.hrv_sustained_decline_mornings; back++) {
      const morning = addDaysISO(date, -back);
      if (!morning || !safely(() => rollingHrvOn(morning).past_line, false)) break;
      mornings_below++;
    }
  }
  const sustained = mornings_below >= policy.hrv_sustained_decline_mornings;

  return {
    rest_grade_today: input.restGradeToday,
    low_readiness_mornings,
    short_nights,
    last_night_min,
    short_sleep_trend: input.shortSleepTrend === true,
    hrv_night: overnight.hrv,
    rhr_night: overnight.rhr,
    rhr_prior_trusted: rhrPriorTrusted,
    hard_endurance_recent: hardEnduranceRecent,
    load_explained,
    hrv_rolling: { past_line: rollingToday.past_line, nights: rollingToday.nights, mornings_below },
    performance_shortfall: sustained ? safely(input.performanceShortfall, false) : false,
    low_word: input.lowWord,
    symptom_today: input.symptomToday,
  };
}
