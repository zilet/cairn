// The day detail contract — ONE server read for one calendar day of the training week.
//
// Horizon's tap-a-day view and Today's "what's ahead" strip both open a day and need
// the same four answers: what the day is FOR (its focus), what we are ACHIEVING (the
// point of the lift, the point of the run, and why this day sits where it does in the
// race build / block), WHERE TO PAY ATTENTION (a joint on watch, a recent best, a
// heavy-leg day beside a key run), and the actual CONTENT (the exercises with sets ×
// reps and the progression engine's load, the run's distance, zone, pace band and, for
// quality work, its structure). A day already lived also carries what was done.
//
// Served by `GET /api/plan/day-detail?date=` (`get_plan_day_detail`), composed in
// src/domain/training/day-detail.ts from reads that already own each fact — the plan
// strip's week (planWeek), the rolling run agenda and the weekly run plan, the race
// build, the progression engine (planDayProgression), the training-symptom watches,
// the block phase and the day record. Nothing here is re-derived and nothing changes.
//
// No score, no grade, no gate: words, prescriptions, logged numbers, kilometres and
// heart-rate bands. Distances travel in km with a miles twin; `run_units` says which
// one the athlete reads. Every sentence is a suggestion.
//
// Self-contained apart from the day record's logged shapes: src/client/** reads these
// types through `import("../contracts/day-detail.js")`.
import type { DayRecordActivity, DayRecordSession } from "./day-record.js";

/**
 * Where the day sits. `done` work was logged (a finished session, a run, or a past day
 * with anything logged); `today` the server's local today with work still open;
 * `upcoming` a day ahead with something planned; `rest` the calendar's rest day; `open`
 * a past day whose planned work was not logged — said neutrally, never as "missed".
 */
export type DayDetailStatus = "done" | "today" | "upcoming" | "rest" | "open";

/** One of the engine's five heart-rate zones. */
export type DayDetailZoneKey = "Z1" | "Z2" | "Z3" | "Z4" | "Z5";

/** A prescribed load. Weights are lb; `null` = bodyweight; negative = assisted (-30 = 30 lb assist). */
export interface DayDetailLoad {
  weight: number | null;
  /** "185 lb", "bodyweight", "30 lb assist". */
  text: string;
  /**
   * `progression` — the engine's next prescription for this slot (a day still ahead);
   * `plan` — the plan item's stored target (a day already lived, or no progression read).
   */
  source: "progression" | "plan";
  /** The progression's own step in plain words ("+5 lb", "hold 185"); null from the plan. */
  change: string | null;
  /** The progression's action for the slot; null from the plan. */
  action: "overload" | "hold" | "deload" | "vary" | "introduce" | null;
}

/** One movement of the day, in plan order. */
export interface DayDetailExercise {
  name: string;
  muscle_group: string | null;
  /** The exercise's mode: `reps`, `timed` (seconds), or `mobility` (a drill, never loaded). */
  mode: "reps" | "timed" | "mobility";
  sets: number | null;
  rep_low: number | null;
  rep_high: number | null;
  target_seconds: number | null;
  /** The prescription as a person reads it: "3 × 5–8", "3 × 45 s", "2 × 10". */
  prescription: string;
  /** Null when no load is known (bodyweight-only drills, a lift with no history and no plan target). */
  load: DayDetailLoad | null;
  /** The day's anchor: its first primary-tier compound (the read the weekly dose and stress budget use). */
  anchor: boolean;
  /** The plan item's own note, else the exercise's constraint note. */
  note: string | null;
}

export type DayDetailWatchKind = "symptom" | "constraint" | "recent_best" | "progression" | "untested";

/** One thing worth attention on the day, in plain words. */
export interface DayDetailWatch {
  kind: DayDetailWatchKind;
  /** The movement it concerns, or null when it concerns the day. */
  exercise: string | null;
  text: string;
}

/** The day's lift. Plan days hold strength only. */
export interface DayDetailLift {
  /** The plan day's number; null for a logged session the plan cannot place. */
  day_number: number | null;
  /** The plan day's NAME ("Push"), or the logged session's title. */
  title: string;
  focus: string | null;
  /** One sentence specific to THIS day: what leads it and what follows. */
  intent: string;
  /** What the session is for, in a sentence (the anchor's step, the block's phase). */
  point: string;
  /** The anchor movement's name, when the day has one. */
  anchor: string | null;
  exercises: DayDetailExercise[];
  /** Working sets across the day (mobility drills excluded). */
  total_sets: number;
  /** The day loads the legs heavily (squat / hinge / lunge work). */
  heavy_lower: boolean;
  /** Today only: the one strength line every surface prints verbatim. */
  today_line: string | null;
  /** Today only: the day read's suggestion carried as a caveat on the plan day. */
  suggestion: { kind: "easy" | "rest"; label: string; caveat: string | null } | null;
}

/** One part of a run. Quality work reads warm-up → main → cool-down. */
export interface DayDetailRunSegment {
  part: "warm_up" | "main" | "cool_down";
  /** "Warm-up", "Threshold", "Cool-down", "Easy", "Long run", "Race". */
  label: string;
  /** The segment in a line ("5 × 1 km at threshold, 60 s easy jog between"), in km. */
  text: string;
  /** The segment's distance; null when the engine does not size it (a tempo's warm-up). */
  km: number | null;
  mi: number | null;
  /** Interval structure, main segment only. */
  reps: number | null;
  /** Per-rep work as the engine writes it ("1km", "800m", "45s uphill"). */
  on: string | null;
  /** Per-rep recovery as the engine writes it ("60s jog", "jog down"). */
  off: string | null;
  zone: DayDetailZoneKey | null;
  /** The zone's heart-rate band, when the athlete's zones are known. */
  hr: { low_bpm: number; high_bpm: number } | null;
  /** The race build's pace band for the segment, when there is a dated race. */
  pace: { text: string; slow_sec_per_km: number; fast_sec_per_km: number } | null;
}

/** What a logged run was, off the agenda's own completion evidence. */
export interface DayDetailRunDone {
  km: number | null;
  mi: number | null;
  duration_min: number | null;
  pace_sec_per_km: number | null;
  avg_hr: number | null;
  /** "easy" / "steady" / "hard" — the athlete's register, never the watch's label. */
  effort: "easy" | "steady" | "hard" | null;
  title: string | null;
}

/**
 * The athlete's STATED quality session (`endurance_schedule.quality`) as this day carries
 * it: the type they chose, the parts in km, what they stated, and — when the week holds
 * the work below it — the sentence that says why. Present only on a quality run that IS
 * that session; null on every other run.
 */
export interface DayDetailStatedQuality {
  source: "stated";
  type: "threshold" | "tempo" | "vo2" | "hills";
  /** Continuous work, or reps (cruise intervals, VO2 reps, hill repeats). */
  form: "continuous" | "intervals";
  warm_up_km: number;
  /** The work this week carries (hill repeats: approximate, with the jog-downs). */
  work_km: number;
  cool_down_km: number;
  /** warm-up + work + cool-down: the run's distance. */
  total_km: number;
  /** The work the athlete stated; null when they named only the type. */
  stated_work_km: number | null;
  /** The warm-up / cool-down are the engine's default, not the athlete's numbers. */
  warm_cool_default: boolean;
  /** `short` a lighter week's set, `taper` the taper's dose, else `full`. */
  dose: "full" | "short" | "taper";
  /** The work held below what was stated this week, in one sentence; null when it runs as stated. */
  held: string | null;
}

/** The day's run. Runs come from the stated run days and the run engine, never a plan row. */
export interface DayDetailRun {
  kind: "easy" | "quality" | "long";
  /** "Easy run", "Threshold intervals", "Long run", "Race day — Riverside Half". */
  label: string;
  status: "open" | "completed";
  /** The engine's prescribed distance (or the logged one once completed). */
  km: number | null;
  mi: number | null;
  /** The athlete's display unit for run distances and paces. */
  run_units: "km" | "mi";
  /** The target zone with its bpm band and the plain-words feel. */
  zone: {
    key: DayDetailZoneKey | null;
    label: string | null;
    low_bpm: number | null;
    high_bpm: number | null;
    feel: string | null;
    /** The engine's own zone tag, verbatim ("Z2 (128–142 bpm)"). */
    text: string | null;
  } | null;
  /** The race build's pace band for the run's kind (dated race only). */
  pace: { key: string; label: string; text: string; slow_sec_per_km: number; fast_sec_per_km: number } | null;
  /** Easy/long: the personal model's easy ceiling, the line that holds over pace. */
  hr_ceiling_bpm: number | null;
  /**
   * Warm-up / main / cool-down for quality work; one segment for an easy, long or race run.
   * For the athlete's stated session every part carries its km (the stated session's own).
   */
  structure: DayDetailRunSegment[];
  /** The athlete's own quality session, when this run is it; null otherwise. */
  stated: DayDetailStatedQuality | null;
  /** The engine's own session sentence, verbatim. */
  session: string | null;
  /** A trimmed week's short quality set: that morning decides whether it runs. */
  short: boolean;
  race: boolean;
  /** What the morning made of the planned run ("Long run, shortened to 8 km this morning."), else null. */
  adjusted: string | null;
  /** What the run is for, in a sentence. */
  point: string;
  /** Completed only: what was actually run. */
  completed: DayDetailRunDone | null;
}

/** A neighbouring day the stack note talks about. */
export interface DayDetailNeighbour {
  date: string;
  weekday: string;
  /** "Lower A" / "Threshold intervals". */
  what: string;
  kind: "heavy_lower" | "quality_run" | "long_run";
}

/**
 * Heavy legs beside a key run (same day, the day before, the day after): a quiet
 * suggestion about how to carry the two, never a rule.
 */
export interface DayDetailStack {
  text: string;
  neighbours: DayDetailNeighbour[];
}

/** The week this day belongs to, in its own words. */
export interface DayDetailWeek {
  week_start: string;
  /** The race build's rung for the week (dated race only). */
  race: {
    event: string | null;
    kind: "build" | "down" | "peak" | "taper" | "race";
    /** "Build week", "Taper week". */
    word: string;
    /** The rung's one coaching sentence. */
    focus: string;
    weeks_to_race: number;
  } | null;
  /** The active block's week, as the week actually runs it (block-phase.ts). */
  block: {
    phase: "accumulation" | "intensification" | "deload" | "realization";
    focus: string;
    week_index: number;
    total_weeks: number;
  } | null;
}

/** What the log holds for a day already lived (past days and today). */
export interface DayDetailDone {
  session: DayRecordSession | null;
  runs: DayRecordActivity[];
  /** Other logged efforts (a ride, a walk). */
  other: DayRecordActivity[];
}

export interface DayDetail {
  date: string;
  /** Short weekday ("Thu"). */
  weekday: string;
  /** The server's local today, so the client never decides the relation itself. */
  today: string;
  status: DayDetailStatus;
  /**
   * False when the lifting week is not on the calendar (no stated or observed lifting
   * weekdays): the lift cannot be dated, so only a dated run can show.
   */
  placed: boolean;
  /** The day's focus in a few words: "Push · Threshold intervals", "Long run", "Rest". */
  focus: string;
  /** One athlete-facing sentence naming the day ("A Push day, then threshold intervals."). */
  headline: string;
  /** Why this day sits where it does: the race build's week, the block's phase. Null when nothing grounds it. */
  why: string | null;
  week: DayDetailWeek;
  lift: DayDetailLift | null;
  run: DayDetailRun | null;
  /** Everything worth attention on the day, lift and run together. */
  watch: DayDetailWatch[];
  stack: DayDetailStack | null;
  /** Past days and today: what was logged. Null for a day ahead. */
  done: DayDetailDone | null;
  /** Life-context events active that day, by title (a trip, an illness logged as context). */
  caveats: string[];
  run_units: "km" | "mi";
}
