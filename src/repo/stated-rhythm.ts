import { harmEvidenceOnDay } from "./brain/read-adherence.js";
import { crossTrainingDays, crossTrainingDoseOn, type CrossTrainingDose } from "./cross-training-day.js";
import { getEnduranceSchedule, isStatedRunDay, isoDow } from "./profile.js";
import { addDaysISO } from "./shared.js";
import { strengthScheduleRead } from "./strength-schedule.js";

// THE ATHLETE'S OWN WEEK, read against a date — one read for the daily decision (the
// `stated_rhythm` license, daily-decision.ts) and the day read's stacked-days ceiling
// (day-read.ts), so the two can never disagree about whether a run of days is the
// plan the athlete wrote or an accident of the calendar.
//
// `streak_on_rhythm`: every day of the current consecutive streak (last seven at most)
// was a stated (or observed) lift day, a stated run day, or the athlete's recurring
// cross-training day (`endurance_schedule.cross_training`, else the observed
// 2-of-6-weeks pattern — crossTrainingDays). The weekend ride IS the week for an
// athlete who lifts Monday to Friday and rides Saturdays: reading it as off-rhythm
// broke every streak that crossed a weekend, and the stacked-days ceiling then eased a
// day the athlete's own week had put on the calendar (2026-10-06). `recent_harm_free`:
// nothing in the last three days says the work cost them (harmEvidenceOnDay).
// Undefined when the athlete has no rhythm at all, or today is not on it.
//
// ---- the widening is BOUNDED (review, 2026-10-06) ----
// Letting a pattern read off the log stand as "the plan" is a real widening of what the
// stacked-days law lets through, so it is held to three bounds, all published:
//   • THE DOSE IS THE HABIT. A cross-training day counts as the week only at the dose
//     the week usually carries (crossTrainingDoseOn: not heavier than his usual band on
//     that weekday, not past 1.5× his usual minutes). A bigger outing is a new stimulus,
//     off the week — the streak is not on rhythm (`cross_training_beyond`).
//   • ONE OBSERVED DAY. A stack the athlete's STATED week carries may lean on at most
//     OBSERVED_DAYS_MAX_IN_STREAK day that only a pattern puts on it; more than that is
//     the log describing itself, not the athlete's week.
//   • A STATED WEEK OR NO CEILING. `stated_week` is whether the athlete wrote any week
//     at all (lifting days or run days). A rhythm read entirely off the log may still
//     name the stack as his week below the hard ceiling, but it never carries the stack
//     PAST it (day-read.ts) — a guessed week does not move a safety bound.
// And the habitual ride still loads the legs the day after: when YESTERDAY was the
// cross-training day, its outing graded hard on intensity, and TODAY carries the stated
// long run, `hard_ride_before_long_run` says so, and the day read keeps that dose as
// news for today rather than exempting it as the week's own (RHYTHM_OWN_DOSE_FIELDS).
export interface StatedRhythm {
  source: "stated" | "observed" | "run_only";
  lift_day: boolean;
  run_day: boolean;
  /** Today is the athlete's recurring cross-training day (stated or observed). */
  cross_training_day: boolean;
  streak_on_rhythm: boolean;
  recent_harm_free: boolean;
  /**
   * How the streak (today included) sits on the week: "stated" when every day is on
   * what the athlete SAID, "observed" when at least one day is on it only through a
   * pattern read off the log (observed lifting weekdays, an observed cross-training day).
   */
  basis: "stated" | "observed";
  /** The athlete stated a week at all — lifting weekdays or run days. */
  stated_week: boolean;
  /** The streak days (today included) on the week only through an observed pattern. */
  observed_days: string[];
  /** A cross-training outing in the streak past his own habit (it broke the rhythm). */
  cross_training_beyond: Pick<CrossTrainingDose, "date" | "beyond" | "minutes" | "load" | "typical_min" | "typical_load"> | null;
  /** Yesterday's cross-training outing graded hard, and today carries the stated long run. */
  hard_ride_before_long_run: boolean;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// How far back "the work has not cost them" reads. Fresh means the last few days, not
// the whole streak: a physiology brake a week ago is not news about this morning.
const RHYTHM_HARM_WINDOW_DAYS = 3;
const RHYTHM_STREAK_LOOKBACK_DAYS = 7;
/** The most streak days a STATED week may lean on through an observed pattern alone. */
export const OBSERVED_DAYS_MAX_IN_STREAK = 1;

export function statedRhythmRead(date: string, consecutive: number | null): StatedRhythm | undefined {
  const lift = safe(() => strengthScheduleRead(date), null);
  const liftDows = new Set((lift?.days ?? []).map((day) => Number(day.dow)));
  const liftStated = lift?.source === "stated" && liftDows.size > 0;
  const runWeek = safe(() => isStatedRunDay(date) != null, false);
  if (!liftDows.size && !runWeek) return undefined;
  const statedWeek = liftStated || runWeek;
  const runDay = (iso: string) => safe(() => isStatedRunDay(iso) === true, false);
  const liftDay = (iso: string) => liftDows.has(isoDow(iso));
  // Read as of the READ day, once: the pattern is a property of the athlete's week, so
  // every day of the streak is judged against the same answer.
  const cross = safe(() => crossTrainingDays(date), []);
  const crossFor = (iso: string) => cross.find((day) => Number(day.dow) === isoDow(iso)) ?? null;
  // How each day sits on the week: "stated", "observed", or off it (null). A day on the
  // stated week through any door is stated; otherwise an observed lift weekday or an
  // observed cross-training day makes it observed. A cross-training day counts only at
  // its habitual dose — `beyondOf` records the outing that broke it.
  const beyondOf = new Map<string, CrossTrainingDose>();
  const basisOf = (iso: string): "stated" | "observed" | null => {
    const statedLift = liftStated && liftDay(iso);
    if (statedLift || runDay(iso)) return "stated";
    const crossDay = crossFor(iso);
    if (crossDay) {
      const dose = safe(() => crossTrainingDoseOn(iso, crossDay), null);
      if (dose && !dose.within_habit) {
        beyondOf.set(iso, dose);
      } else return crossDay.source === "stated" ? "stated" : "observed";
    }
    if (liftDay(iso)) return "observed"; // an observed lifting weekday
    return null;
  };
  const todayBasis = basisOf(date);
  if (!todayBasis) return undefined;
  const observedDays: string[] = todayBasis === "observed" ? [date] : [];
  const streak = Math.min(Math.max(0, Math.floor(consecutive ?? 0)), RHYTHM_STREAK_LOOKBACK_DAYS);
  let streakOnRhythm = true;
  let breaker: string | null = null;
  for (let i = 1; i <= streak; i++) {
    const iso = addDaysISO(date, -i);
    const basis = iso ? basisOf(iso) : null;
    if (!iso || !basis) {
      streakOnRhythm = false;
      breaker = iso;
      break;
    }
    if (basis === "observed") observedDays.push(iso);
  }
  // A stated week may lean on one observed day; past that the "week" is the log
  // describing itself. A rhythm with no stated week at all is observed throughout and
  // is bounded instead at the ceiling (day-read.ts).
  if (streakOnRhythm && statedWeek && observedDays.length > OBSERVED_DAYS_MAX_IN_STREAK) streakOnRhythm = false;
  let recentHarmFree = true;
  for (let i = 1; i <= RHYTHM_HARM_WINDOW_DAYS; i++) {
    const iso = addDaysISO(date, -i);
    if (!iso) continue;
    // Fail closed: an unreadable day is not evidence that the work was free.
    if (safe(() => harmEvidenceOnDay(iso) != null, true)) {
      recentHarmFree = false;
      break;
    }
  }
  const yesterday = addDaysISO(date, -1);
  const yesterdayCross = yesterday ? crossFor(yesterday) : null;
  const longRunToday = safe(
    () => (getEnduranceSchedule()?.days ?? []).some((day) => day.dow === isoDow(date) && day.kind === "long"),
    false
  );
  const hardRideBeforeLongRun =
    !!yesterday &&
    !!yesterdayCross &&
    longRunToday &&
    safe(() => crossTrainingDoseOn(yesterday, yesterdayCross)?.intensity_hard === true, false);
  // The outing that broke the streak, when it was a cross-training day past the habit.
  const beyond = breaker ? (beyondOf.get(breaker) ?? null) : null;
  return {
    source: liftDows.size ? (lift?.source === "observed" ? "observed" : "stated") : "run_only",
    lift_day: liftDay(date),
    run_day: runDay(date),
    cross_training_day: crossFor(date) != null,
    streak_on_rhythm: streakOnRhythm,
    recent_harm_free: recentHarmFree,
    basis: observedDays.length ? "observed" : "stated",
    stated_week: statedWeek,
    observed_days: observedDays,
    cross_training_beyond: beyond
        ? {
            date: beyond.date,
            beyond: beyond.beyond,
            minutes: beyond.minutes,
            load: beyond.load,
            typical_min: beyond.typical_min,
            typical_load: beyond.typical_load,
          }
        : null,
    hard_ride_before_long_run: hardRideBeforeLongRun,
  };
}
