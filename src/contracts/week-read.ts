// The week read contract — ONE server read for one calendar week, Horizon's Week page.
//
// Served by `GET /api/week?start=` (`get_week`), composed in
// src/domain/training/week-read.ts over the plan strip's own week (planWeek — the same
// cells `GET /api/plan/week` still answers), the race build, the one stage vocabulary
// (week-stage.ts), the one weight-trend read (weight-trend.ts) and Today's path. Nothing
// here is re-derived and nothing changes.
//
// Units and dates follow the athlete: every `*_words` / `words` / `line` / `summary`
// string is already in their units (settings → display-words.ts) and names dates in
// words. Machine fields (`date`, `*_date`, `km`, `*_lb`) stay canonical (YYYY-MM-DD, km,
// lb) for logic and links only — a renderer prints the words, never the machine field.
// The load shape is a WORD and a relative height for drawing; never a number shown,
// never a score.
//
// Self-contained on purpose: src/client/** reads these types through
// `import("../contracts/week-read.js")`, and this module imports nothing.

export type WeekStageKey = "base" | "build" | "sharpen" | "down" | "peak" | "taper" | "race";

/** The week's frame (week-stage.ts weekFrameLine): the hero and the one line under it. */
export interface WeekReadFrame {
  stage: {
    key: WeekStageKey;
    /** "Sharpen" — the short label. */
    word: string;
    /** "Sharpen week" — the week tag. */
    week_word: string;
    source: "race" | "block";
  } | null;
  /** "block week 6 of 6". */
  block: { week: number; of: number; words: string } | null;
  countdown: { days: number; event: string; race_date: string; race_date_words: string; words: string } | null;
  /** A dated push stance covering the week: "push through Nov 15". */
  push: { until: string; until_words: string; words: string } | null;
  /** "26 days to Cambridge Half" — else the stage's week word. */
  headline: string | null;
  /** "Sharpen · block week 6 of 6 · push through Nov 15". */
  line: string | null;
  /** Today's one link into Horizon: "26 days to Cambridge · Sharpen, wk 6 of 6". */
  glance: string | null;
}

/** The week so far, counted — and said in the athlete's units. */
export interface WeekReadTotals {
  lift_days_done: number;
  /** Stated/observed lifting weekdays; null when the athlete has no lifting week. */
  lift_days_planned: number | null;
  runs_done: number;
  runs_planned: number;
  /** Canonical km (logic only). */
  run_km_done: number;
  run_km_planned: number | null;
  units: "km" | "mi";
  /** "2 of 4 lifting days" / "1 lifting day"; null with no lifting. */
  lift_words: string | null;
  /** "12.4 of 31 km" / "7.7 of 19.3 mi"; null with no running. */
  run_words: string | null;
}

/** The planned dose of a day, as a word. Never a number shown. */
export type WeekDose = "rest" | "easy" | "moderate" | "hard" | "big";

/** One day of the week, chip-sized: the same words on Today's strip, Horizon and Program. */
export interface DayChip {
  /** Machine date (links, keys); null in template mode (no lifting calendar). */
  date: string | null;
  /** "Mon, Oct 6"; null in template mode. */
  date_words: string | null;
  /** "Mon"; null in template mode. */
  weekday: string | null;
  status: "done" | "today" | "upcoming" | "rest" | "open";
  today: boolean;
  lift: {
    day_number: number | null;
    /** The plan day's name ("Push"), or the logged session's title. */
    title: string;
    heavy_lower: boolean;
    /** Today only: the day read's caveat on the plan day ("Pull · lighter today"). */
    suggestion: { kind: "easy" | "rest"; label: string; caveat: string | null } | null;
  } | null;
  run: {
    kind: string;
    label: string;
    status: "open" | "completed";
    /** Canonical km (logic only). */
    km: number | null;
    /** "5 km" / "3.1 mi"; null when the engine does not size it. */
    distance_words: string | null;
    /** An open run the day read rested. */
    rested: boolean;
    /** A stated run weekday whose run already landed earlier this week. */
    covered: boolean;
  } | null;
  rest: boolean;
  /** A heavy-leg lift, a quality or a long run. */
  hard: boolean;
  /** The chip's one line: "Push · Easy run, 3.1 mi", "Rest". */
  words: string;
  /** The planned dose: a word for the day and a relative bar height (0..1) for drawing. */
  load: { dose: WeekDose; word: string; height: number };
  /** The day page: "/app/day/2026-10-06"; null in template mode. */
  href: string | null;
}

/** Planned work still ahead this week (at most two). */
export interface WeekReadOpen {
  kind: string;
  label: string;
  date: string | null;
  date_words: string | null;
  /** "Long run · Sunday". */
  words: string;
}

export type WeekReadMilestoneKind = "long_run" | "peak_week" | "checkpoint" | "race" | "goal" | "checkup";

/** A dated milestone beyond this week (the same row Season shows). */
export interface WeekReadMilestone {
  kind: WeekReadMilestoneKind;
  label: string;
  date: string;
  end_date: string | null;
  /** "Oct 18", "Nov 17 – Nov 23". */
  date_words: string;
  detail: string | null;
}

/** One goal, compact: the race estimate WITH its time, the weight trend, the anchor lift. */
export interface WeekReadGoal {
  key: "race" | "weight" | "strength";
  /** "Half marathon", "Weight", "Deadlift". */
  label: string;
  /** "1:52:10", "159.6 lb", "285 lb". */
  now_text: string;
  goal_text: string | null;
  /** Where now sits on the start→goal track, 0..1, for a drawn bar only; null with no track. */
  progress: number | null;
  /** One sentence: "Reads 1:52:10, inside sub-1:55.", "Trending −0.9 lb/wk — on pace for Dec 1." */
  line: string | null;
  /** The race's fit word, race goal only. */
  fit?: "fits" | "stretch" | "beyond_horizon" | null;
}

/** One dated mark on the journey trail (a milestone, with the word the trail prints beside it). */
export interface WeekReadJourneyMark extends WeekReadMilestone {
  /** The trail's short word: "Half", "72 kg", "48 km", "Test", "Checkup". */
  short: string;
  /** Days from today to the mark (0 = today). */
  days_away: number;
  /** "in 10 days", "tomorrow", "today". */
  days_words: string;
  /** True for the furthest mark: the summit the trail climbs to. */
  summit: boolean;
}

/** Something that has already moved toward a goal since the trail began (measures, never grades). */
export interface WeekReadJourneyBehind {
  key: "race" | "weight" | "strength";
  /** "Race estimate 4 min faster", "−2.1 lb", "Deadlift up 20 lb, to 285 lb". */
  words: string;
}

/**
 * The journey trail Horizon's Week draws: to scale in time from `start_date` through today to
 * the furthest dated goal. Built over Today's path (src/repo/today-path.ts), re-deriving
 * nothing; null when no dated mark lies ahead or the week is not this week.
 */
export interface WeekReadJourney {
  start_date: string;
  /** "Sep 8". */
  start_words: string;
  today: string;
  /** Every dated mark ahead, ascending; the last is the summit. */
  marks: WeekReadJourneyMark[];
  /** What moved toward a goal since `start_date` (at most three); empty when nothing did. */
  behind: WeekReadJourneyBehind[];
  /** One calm line of where the athlete stands on the trail ("31 days walked, 10 to the race."). */
  line: string;
}

export type WeightPaceVerdict = "on_pace" | "ahead" | "behind" | "steady";

/**
 * THE weight trend (src/repo/weight-trend.ts weightTrendRead): one rate, one ask, one
 * verdict, every surface. Also served beside `GET /api/nutrition/goal-pace` as `read`.
 */
export interface WeightTrendRead {
  as_of: string;
  units: "lb" | "kg";
  mode: "lose" | "gain" | "maintain" | null;
  current: { lb: number; date: string; words: string; date_words: string } | null;
  goal: { lb: number; date: string | null; words: string; date_words: string | null } | null;
  /** lb/week, rounded ONCE to a tenth — the one number every surface prints. */
  rate_lb_wk: number | null;
  /** The rate in the athlete's unit, rounded once. */
  rate_value: number | null;
  needed_lb_wk: number | null;
  needed_value: number | null;
  /** "−0.9 lb/wk" / "−0.4 kg/wk". */
  rate_words: string | null;
  needed_words: string | null;
  verdict: WeightPaceVerdict | null;
  /** "on pace", "ahead of the line", "behind the line", "holding steady". */
  verdict_words: string | null;
  /** "Trending −0.9 lb/wk — on pace for Dec 1." */
  line: string | null;
  window: { since: string; through: string; weigh_ins: number; since_words: string } | null;
  /** The last 7 days' average against the 7 before; null when it is not news. */
  week_change: {
    avg_lb: number;
    prior_avg_lb: number;
    delta_lb: number;
    since: string;
    since_words: string;
    /** "1 lb lower than the week before". */
    words: string;
  } | null;
}

export interface WeekRead {
  /** The day the week is read as of (today for this week, else the week's own Monday or Sunday). */
  as_of: string;
  /** The server's local today. */
  today: string;
  week_start: string;
  week_end: string;
  /** "Oct 6 – Oct 12". */
  range_words: string;
  /** The week holding today. */
  this_week: boolean;
  units: { distance: "km" | "mi"; weight: "lb" | "kg" };
  frame: WeekReadFrame;
  /** The week's ONE summary sentence (Horizon owns it). */
  summary: string | null;
  totals: WeekReadTotals;
  /** Mon→Sun on the calendar; template order when no lifting week is known. */
  days: DayChip[];
  /** A layout suggestion for the days still ahead, when the week's layout collides. */
  layout_note: string | null;
  still_open: WeekReadOpen[];
  /** The next 2–3 milestones beyond this week. */
  next_milestones: WeekReadMilestone[];
  goals: WeekReadGoal[];
  /** The journey trail: this week only, null with no dated mark ahead. */
  journey: WeekReadJourney | null;
  /** The one weight-trend read behind the weight goal row. */
  weight_trend: WeightTrendRead | null;
}
