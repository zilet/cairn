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
//      athlete's own band, overnight-band.ts `rollingBandRead`). One low night within a
//      short window after a hard or long endurance day, resting HR in band, is the
//      expected answer to that day: a caveat plus the dose.
//   C. A second consecutive low morning means EASY (low intensity), never rest.
//   D. One short night eases (a dosed day on a stated day, easy otherwise); two or more
//      consecutive short nights mean easy.
//   E. Resting HR above the athlete's band: after a hard endurance day it is expected —
//      easy at most. Without one, on a second consecutive morning, or beside the
//      athlete's own low word or a symptom report, it reads as possible illness — REST.
//   F. REST is otherwise reserved for the floors the engine already owns (illness, pain,
//      clinical, safety, the athlete's corroborated low word, a recovery week or a
//      calendar hold) plus a SUSTAINED rolling HRV decline beside the log-confirmed
//      performance shortfall the deload read already computes.
//   G. A positive check-in lifts ONE step only a caution that rests on the composite
//      readiness score; intensity stays held.
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
  /** Days after a hard or long endurance day inside which a low night is the expected answer to it. */
  endurance_window_days: 2,
  // ---- C: persistence ----
  /** Consecutive low mornings (this one counted) that make the day EASY, never dosed. */
  low_mornings_for_easy: 2,
  // ---- D: short nights ----
  /** Consecutive short nights (last night counted) that make the day EASY. One short night eases. */
  short_nights_for_easy: 2,
  // ---- E: resting HR above the athlete's band ----
  /** How far past the athlete's line ONE night must sit to count ("meaningful" = by the smallest worthwhile change). */
  rhr_single_night_min_past: "meaningful" as "meaningful" | "marginal",
  /** Consecutive readings past the line that make an elevated resting HR the illness pattern. */
  rhr_illness_consecutive_readings: 2,
  /** After a hard endurance day, what an elevated resting HR leaves a STATED day as: a dosed train, or easy. */
  rhr_after_endurance_on_stated_day: "dosed_train" as "dosed_train" | "easy",
  // ---- F: a sustained rolling HRV decline ----
  /** Consecutive mornings the rolling HRV value must sit below the athlete's line to be SUSTAINED. */
  hrv_sustained_decline_mornings: 3,
  // ---- G: the positive check-in ----
  /** A same-day energy tap at or above this lifts a readiness-only caution one step. */
  checkin_lift_energy_min: 4,
  /** …unless sleep-feel sits at or below this: a mixed morning stays an advisory caveat. */
  checkin_lift_sleep_feel_veto_max: 2,
  /** The only deciding brake a check-in may lift over: the composite readiness score (it must be present). */
  checkin_liftable_brakes: Object.freeze(["training_readiness"]) as readonly string[],
  /**
   * Brakes that may sit BESIDE it without blocking the lift: the week's own load arithmetic
   * (yesterday's endurance on the legs, acute load, generic activity) — what the held dose
   * and the lighter regions already answer, never a reading of the body.
   */
  checkin_lift_tolerated_brakes: Object.freeze([
    "hybrid_interference",
    "acute_load",
    "generic_activity_load",
  ]) as readonly string[],
});

/** What "one step" maps to (G): an easy read becomes a training day at a held intensity. */
export const CHECKIN_LIFT_STEP = Object.freeze({ easy: "train_held" } as const);

export type LoadExplanation = "hard_cardio_yesterday" | "hard_day_yesterday" | "wake_reading_restates_load";

/** What the morning's body readings conclude, before the engine's own floors. */
export type MorningBasis =
  // REST (E, F)
  | "resting_hr_illness_pattern"
  | "hrv_decline_with_shortfall"
  // EASY on every day (C, D)
  | "consecutive_short_nights"
  | "consecutive_low_mornings"
  // EASY on an unstated day, the DOSE on a stated one (A, D, E)
  | "short_night"
  | "resting_hr_after_endurance"
  | "readiness_rest_grade"
  // the DOSE on any day with a session due (B)
  | "overnight_dip_after_endurance";

export interface MorningFacts {
  /** The read's own fresh rest-grade reading this morning (A). */
  rest_grade_today: boolean;
  /** Consecutive mornings, this one counted, with a fresh low readiness reading (C). */
  low_readiness_mornings: number;
  /** Consecutive short nights, last night counted, by the read's own short-night rule (D). */
  short_nights: number;
  /** Last night's HRV / resting HR against the athlete's own band. */
  hrv_night: OvernightFieldRead | null;
  rhr_night: OvernightFieldRead | null;
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

/**
 * The pure classifier (A–F). `stated` is whether the athlete's stated week puts a lift
 * or key run on the day. Precedence: the REST patterns, then the EASY persistence
 * patterns, then the single-morning eases, then the post-endurance dip.
 */
export function classifyMorning(facts: MorningFacts, stated: boolean): MorningVerdict {
  const policy = MORNING_DOSE_POLICY;
  const rhr = facts.rhr_night;
  const rhrPast =
    rhr != null &&
    (policy.rhr_single_night_min_past === "marginal" ||
      rhr.past === "meaningful" ||
      rhr.consecutive >= policy.rhr_illness_consecutive_readings);
  // "A hard day before" for the resting-HR read: hard endurance inside the window, or a
  // day the ordinary load grade called hard yesterday (heavy lifting raises it too).
  const hardDayRecent = facts.hard_endurance_recent || facts.load_explained.includes("hard_day_yesterday");
  if (
    rhrPast &&
    (!hardDayRecent ||
      (rhr?.consecutive ?? 0) >= policy.rhr_illness_consecutive_readings ||
      facts.low_word ||
      facts.symptom_today)
  )
    return { kind: "rest", basis: "resting_hr_illness_pattern" };
  if (facts.hrv_rolling.mornings_below >= policy.hrv_sustained_decline_mornings && facts.performance_shortfall)
    return { kind: "rest", basis: "hrv_decline_with_shortfall" };
  if (facts.short_nights >= policy.short_nights_for_easy) return { kind: "easy", basis: "consecutive_short_nights" };
  if (facts.low_readiness_mornings >= policy.low_mornings_for_easy)
    return { kind: "easy", basis: "consecutive_low_mornings" };
  if (rhrPast)
    return {
      kind: stated && policy.rhr_after_endurance_on_stated_day === "dosed_train" ? "dose" : "easy",
      basis: "resting_hr_after_endurance",
    };
  if (facts.short_nights >= 1) return { kind: stated ? "dose" : "easy", basis: "short_night" };
  if (facts.rest_grade_today) return { kind: stated ? "dose" : "easy", basis: "readiness_rest_grade" };
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
  });
}

export interface MorningFactInputs {
  /** The read's own fresh low / rest-grade reading this morning. */
  lowReadinessToday: boolean;
  restGradeToday: boolean;
  /** The read's own short-night rule, for a night's minutes (null minutes = no night). */
  isShortNight: (minutes: unknown) => boolean;
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
  for (let back = 0; back < Math.max(policy.short_nights_for_easy, 1); back++) {
    const morning = addDaysISO(date, -back);
    const night = morning ? safely(() => latestSleep(LAST_NIGHT_MAX_AGE_DAYS, morning) as any, null) : null;
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
    hrv_night: overnight.hrv,
    rhr_night: overnight.rhr,
    hard_endurance_recent: hardEnduranceRecent,
    load_explained,
    hrv_rolling: { past_line: rollingToday.past_line, nights: rollingToday.nights, mornings_below },
    performance_shortfall: sustained ? safely(input.performanceShortfall, false) : false,
    low_word: input.lowWord,
    symptom_today: input.symptomToday,
  };
}
