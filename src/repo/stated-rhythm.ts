import { harmEvidenceOnDay } from "./brain/read-adherence.js";
import { crossTrainingDays } from "./cross-training-day.js";
import { isStatedRunDay, isoDow } from "./profile.js";
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
export interface StatedRhythm {
  source: "stated" | "observed" | "run_only";
  lift_day: boolean;
  run_day: boolean;
  /** Today is the athlete's recurring cross-training day (stated or observed). */
  cross_training_day: boolean;
  streak_on_rhythm: boolean;
  recent_harm_free: boolean;
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

export function statedRhythmRead(date: string, consecutive: number | null): StatedRhythm | undefined {
  const lift = safe(() => strengthScheduleRead(date), null);
  const liftDows = new Set((lift?.days ?? []).map((day) => Number(day.dow)));
  const runWeek = safe(() => isStatedRunDay(date) != null, false);
  if (!liftDows.size && !runWeek) return undefined;
  const runDay = (iso: string) => safe(() => isStatedRunDay(iso) === true, false);
  const liftDay = (iso: string) => liftDows.has(isoDow(iso));
  // Read as of the READ day, once: the pattern is a property of the athlete's week, so
  // every day of the streak is judged against the same answer.
  const crossDows = new Set(safe(() => crossTrainingDays(date), []).map((day) => Number(day.dow)));
  const crossDay = (iso: string) => crossDows.has(isoDow(iso));
  const onRhythm = (iso: string) => liftDay(iso) || runDay(iso) || crossDay(iso);
  if (!onRhythm(date)) return undefined;
  const streak = Math.min(Math.max(0, Math.floor(consecutive ?? 0)), RHYTHM_STREAK_LOOKBACK_DAYS);
  let streakOnRhythm = true;
  for (let i = 1; i <= streak; i++) {
    const iso = addDaysISO(date, -i);
    if (!iso || !onRhythm(iso)) {
      streakOnRhythm = false;
      break;
    }
  }
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
  return {
    source: liftDows.size ? (lift?.source === "observed" ? "observed" : "stated") : "run_only",
    lift_day: liftDay(date),
    run_day: runDay(date),
    cross_training_day: crossDay(date),
    streak_on_rhythm: streakOnRhythm,
    recent_harm_free: recentHarmFree,
  };
}
