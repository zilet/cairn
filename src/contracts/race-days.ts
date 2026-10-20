// The race countdown contract — today through race day, one row a day.
//
// "To the race" read the build week by week, which is the right altitude far out and
// the wrong one in the last three weeks: then the athlete asks what to do on each day
// — which run, how far, at what pace, what lifts, whether travel moves anything, and
// whether the coach adapted it. GET /api/race-build/days (`get_race_days`) answers that
// in one read, composed in src/domain/training/race-days.ts from reads that already own
// each fact: the plan strip's week (planWeek — the weekday map's lift, the agenda's run
// dated on the day), the weekly run plan's prescription for the run's structure
// (dayDetailRunStructure, the day page's own parts), the race build's pace bands and
// week rungs, the stress budget's race-week / taper / key-run-eve leg trim, and the
// coach changes attached to each date (day-changes.ts).
//
// Only within three weeks of a dated race; `available:false` with a reason otherwise.
// Every distance and pace SENTENCE here is already in the athlete's run units; numbers
// travel in km with a miles twin. No score, no grade, no gate.
import type { DayDetailChange } from "./day-changes.js";

/** How far ahead the countdown opens: three weeks out. */
export const RACE_DAYS_WINDOW = 21;

/**
 * How far off the race is, in ONE set of words every surface prints (raceCountdown,
 * src/repo/race-build.ts). Counted in DAYS from the date it is read for — never the
 * ladder's calendar-week count (`weeks_to_race` is the engine's arrival count to race
 * WEEK and keeps that job: a week's `kind`), which said "1 wk out" twelve days before a
 * race while every other surface counted days.
 */
export interface RaceCountdown {
  /** Whole days from the read date to race day (0 on race day; negative once run). */
  days: number;
  /** "Race day", "Tomorrow", "Race week", "12 days out", "3 wks out", "Race run". */
  words: string;
  /** The span alone, for "… to <race>": "12 days", "1 day", "3 weeks"; null on race day or after. */
  span: string | null;
  /** The read date falls in the race's own calendar week. */
  race_week: boolean;
}

export interface RaceDayRun {
  kind: "easy" | "quality" | "long";
  /** "Easy run", "Threshold intervals", "Long run", "Race day — Cambridge Half". */
  label: string;
  status: "open" | "completed";
  km: number | null;
  mi: number | null;
  /** The distance in the athlete's run units ("6.2 mi"); null when the engine does not size it. */
  distance_text: string | null;
  /** The race build's pace band for the run ("8:49–9:01 /mi"); null without one. */
  pace_text: string | null;
  /**
   * A quality session's parts on one line ("1.2 mi easy · 3.1 mi threshold 8:49–9:01 /mi · 1 mi easy");
   * null for a one-part run (its distance and pace already say it).
   */
  structure_text: string | null;
  /** The race itself. */
  race: boolean;
}

export interface RaceDayLift {
  /** The plan day's number; null for a logged session the plan cannot place. */
  day_number: number | null;
  /** The plan day's NAME ("Lower"), or the logged session's title. */
  name: string;
  /** The day loads the legs heavily (squat / hinge / lunge work). */
  heavy_lower: boolean;
  /**
   * The legs go lighter on the day: the race build's taper / race-week / key-run-eve trim
   * (stress-budget.ts) applies to it, or a coach change adapted a heavy-leg day.
   */
  legs_lighter: boolean;
  /** Logged and finished. */
  done: boolean;
}

export interface RaceDay {
  date: string;
  /** Short weekday ("Thu"). */
  weekday: string;
  /** Whole days from this date to race day (0 on race day). */
  days_out: number;
  /** `days_out` in the countdown's one wording ("Race day", "Tomorrow", "12 days out"). */
  out_words?: string;
  today: boolean;
  race_day: boolean;
  /** The plan strip's status for the day. */
  status: "done" | "today" | "upcoming" | "rest" | "open";
  run: RaceDayRun | null;
  lift: RaceDayLift | null;
  /** Neither a run nor a lift: the calendar's rest day. */
  rest: boolean;
  /** A trip covers the date (the plan week's / leg map's `travel`); null otherwise. */
  travel: { label: string } | null;
  /** Coach changes in effect on the day (or announced to land by it). */
  changes: DayDetailChange[];
}

export interface RaceDaysWeek {
  week_start: string;
  /** The race build's ONE stage word for the week ("Taper week"). */
  stage_word: string | null;
  kind: "build" | "down" | "peak" | "taper" | "race" | null;
  /** The week in a few words ("Easy runs and strides"). */
  focus_short: string | null;
  /** The week's one coaching sentence. */
  focus: string | null;
  /** How the lifting fits the week, in words; null for a running-only week. */
  with_lifting: string | null;
  /**
   * A whole-week layout the coach wrote for THIS week (day-changes.ts `weeks`), said once
   * on the week's heading — never repeated on each day, never on another week.
   */
  changes?: DayDetailChange[];
  days: RaceDay[];
}

export interface RaceDaysRace {
  event: string | null;
  date: string;
  days_to_race: number;
  /** How far off the race is from today, in the countdown's one wording. */
  countdown?: RaceCountdown | null;
  /** The race distance in the athlete's run units ("13.1 mi"). */
  distance_text: string;
  /** What the athlete wrote as the goal ("sub-1:45"); null with none. */
  target_text: string | null;
  /** The race-pace band ("7:58–8:06 /mi"); null without paces. */
  pace_text: string | null;
}

export interface RaceDays {
  available: boolean;
  /** Why there is no countdown (no dated race, more than three weeks out, the race is run). */
  reason: string | null;
  as_of: string;
  run_units: "km" | "mi";
  race: RaceDaysRace | null;
  /** Today's week first; race week last. */
  weeks: RaceDaysWeek[];
}
