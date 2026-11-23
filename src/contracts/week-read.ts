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
  block: {
    week: number;
    of: number;
    words: string;
    /** True only when race day falls inside this block's last week: only then may a ribbon end at the race. */
    ends_at_race?: boolean;
  } | null;
  countdown: {
    days: number;
    event: string;
    race_date: string;
    race_date_words: string;
    words: string;
    /** The far form for a secondary line: "5K time trial in 25 weeks" (the ONE weeks count every surface prints). */
    far_words?: string;
  } | null;
  /** A dated push stance covering the week: "push through Nov 15". */
  push: { until: string; until_words: string; words: string } | null;
  /**
   * The week's purpose in the coach's voice ("Build the engine. Keep the press moving."):
   * a day-stable variant keyed on the stage and what the week holds; null when nothing names one.
   */
  purpose?: string | null;
  /**
   * What leads the hero: the countdown inside FRAME_COUNTDOWN_LEAD_DAYS (56) of a race or in a
   * post-race recovery window, else the purpose. `headline` is ALREADY the leading one; `sub`
   * is the other, said once as a quiet line ("One lift in of five, two key runs ahead. 5K time
   * trial in 25 weeks.").
   */
  lead?: "countdown" | "purpose";
  sub?: string | null;
  /** The hero's serif line: the countdown or recovery line when it leads, else the purpose, else the stage's week word. */
  headline: string | null;
  /** "Sharpen · block week 6 of 6 · push through Nov 15". */
  line: string | null;
  /** Today's one link into Horizon: "26 days to Cambridge · Sharpen week". */
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
  /** One plain sentence, never cut mid-word (a long one ends at a sentence or clause boundary). */
  detail: string | null;
  /** Where the row goes (the race page, the checkup, the goal line, a day page); null when it has no page. */
  href?: string | null;
}

/** A goal's drawn track: ONE axis, positions 0..1. The start need not sit at 0 — a thread now behind its start draws left of it. */
export interface WeekReadGoalTrack {
  start: number;
  now: number;
  goal: number;
  /** Where the thread stood about four weeks ago; null when the history is too thin to say. */
  ago: number | null;
  /** "4 weeks ago" / "Oct 19" — the ring's words for a label; null with no `ago`. */
  ago_words: string | null;
  /**
   * A lift goal only: where the next mark for the athlete's own build sits, drawn as a
   * quiet waypoint. Present only when it lies between now and the goal; null otherwise.
   */
  mark?: number | null;
}

export type WeekReadGoalDirection = "toward" | "holding" | "back" | "reached";

/** One goal, compact: the race estimate WITH its time, the weight trend, the lift goals. */
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
  /** Stable per thread ("race", "weight", "strength:overhead-press"). */
  id?: string;
  /** The start mark in words: "183 lb · Jun 6", "23:33 · Oct 19"; null with no start. */
  start_text?: string | null;
  /** The goal mark in words WITH its date when dated: "148 lb · Feb 14". */
  goal_words?: string | null;
  /** The track to draw; null with no start→goal track. Never printed as a number or a percent. */
  track?: WeekReadGoalTrack | null;
  /** Which way the thread moved over about four weeks, in the athlete's own terms; null when unreadable. */
  direction?: WeekReadGoalDirection | null;
  /** "Moving toward" / "Holding" / "Drifting back" / "Reached" — the weight row speaks its one verdict ("On pace"). */
  direction_words?: string | null;
  /** The plain measure of that move: "43 s faster in four weeks", "0.4 lb a week, 0.5 needed", "0.7 lb a week". */
  move_words?: string | null;
  /** The thread's depth: the race page, the goal line, the lift's program page; null when it has none. */
  href?: string | null;
  /**
   * A lift goal only, while a recorded plan swap carries it on a same-pattern variant: "Carries
   * your Pendlay Row goal since Nov 13". The row's label is then the lift now trained.
   */
  carried_words?: string | null;
  /**
   * A lift goal only: the next strength standard above this lift for the athlete's own sex,
   * age band and current bodyweight, as a load: "Next mark for your build: 240 lb". A waypoint
   * to look toward — never a level word, a percentile or a gate. Null when there is none.
   */
  mark_words?: string | null;
  /**
   * A lift goal only: what is ahead in the journey's own terms: "Next session: 3 × 5–8 at 145 lb, +1 rep",
   * and the journey's planning range when it gives one. Null when it has neither.
   */
  next_words?: string | null;
  /**
   * The strength row only, and only when the athlete holds TWO OR MORE active lift goals:
   * the first WEEK_GOAL_LIFTS_MAX of them in the board's order (most movement this month first),
   * so no lift goal is hidden behind an arbitrary pick; the count words cover exactly the lifts listed. The row itself then reads
   * label "Strength", now_text "5 lifts", move_words the count by direction
   * ("Two rising, one holding, two drifting back"), track null and direction null. With one
   * lift goal the row stays that lift's own thread and `lifts` is absent.
   */
  lifts?: WeekReadGoalLift[];
}

/** One lift goal inside the strength row: its own small thread. */
export interface WeekReadGoalLift {
  /** "strength:front squat". */
  id: string;
  /** "Front Squat". */
  label: string;
  /** The lift's one "now" (the capacity envelope): "150 lb". */
  now_text: string;
  /** "200 lb"; null with no target. */
  goal_text: string | null;
  /** start / four weeks ago / now / goal, as on a goal row; null when undrawable. */
  track: WeekReadGoalTrack | null;
  /** The journey's own trend call, in the goal row's vocabulary; null when unreadable. */
  direction: WeekReadGoalDirection | null;
  /** The direction finished with the goal: "Moving toward 200 lb" / "Holding, 200 lb is the goal" / "Drifting back from 200 lb" / "Reached 200 lb" (a reps goal: "Moving toward 3 × 8"); "Last trained Oct 3, goal 200 lb" (direction null) with no fresh exposure. */
  direction_words: string | null;
  /** "4 lb up since Oct 25"; "1.2 lb a week up" with no reading four weeks back; null when unreadable. */
  move_words: string | null;
  /** "Carries your Pendlay Row goal since Nov 13"; null unless a recorded swap carries the goal. */
  carried_words?: string | null;
  /** "Next session: 3 × 5–8 at 145 lb, +1 rep"; null when the journey holds no next step. */
  next_words?: string | null;
  /** "Next mark for your build: 240 lb"; null when there is none. */
  mark_words?: string | null;
}

/** The most lift goals the strength row lists. */
export const WEEK_GOAL_LIFTS_MAX = 6;

/**
 * Proof: what has measurably changed since the athlete started (a measure before and after,
 * never a grade), each with a small picture. A race just run leads while its recovery-and-
 * reflection window lasts (RACE_PROOF_DAYS).
 */
export interface WeekReadProof {
  /** The row's kind (and its stone class), not a unique id: two lifts can both be "strength". */
  key: "weight" | "strength" | "race_done" | "race" | "running";
  stone: "body" | "strength" | "endurance";
  /** "Weight", "Bench press", "Running". */
  label: string;
  /** "183 lb", "115 lb × 10"; null when the row is a single fact (a race run). */
  before_text: string | null;
  /** "153.9 lb", "145 lb × 6", "First half marathon · 2:10:18". */
  after_text: string;
  /** "since Jun 6"; null when undated. */
  since_words: string | null;
  /** The picture's values, oldest first, each 0..1 within the series' own span (drawing only); empty or ≥ 2. */
  series: number[];
  /** A measured line (weight), steps (a working load), or columns (weekly run volume). */
  series_kind: "line" | "steps" | "columns";
  /** Where the row goes; null when it has no page. */
  href: string | null;
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
  key: "race" | "race_done" | "weight" | "strength";
  /** "Cambridge Half Marathon run, 2:10:18", "Race estimate 4 min faster", "−2.1 lb", "Deadlift up 20 lb, to 285 lb". */
  words: string;
}

/**
 * A stone set on the WALKED part of the trail: something the athlete actually did between
 * `start_date` and today, read from the source that owns it (a race run, a lift's new best,
 * the longest run taken well, a bodyweight waypoint crossed). A logged event, never an
 * estimate of the future and never a grade.
 */
export interface WeekReadJourneyStone {
  kind: "race_done" | "best" | "longest_run" | "weight";
  stone: "strength" | "endurance" | "body" | "heart";
  date: string;
  /** "Nov 3". */
  date_words: string;
  /** Days from the stone to today (0 = today). */
  days_ago: number;
  /** The trail's short word: "285 lb", "14 km", "175 lb", "Half". */
  short: string;
  /** One full sentence: "A new best on the squat on Nov 12, an estimated 285 lb max." */
  words: string;
  /** The day it happened (or the goal page); null when it has no page. */
  href: string | null;
}

/** The most stones the walked part carries, so the trail stays calm. */
export const JOURNEY_STONES_MAX = 6;

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
  /**
   * What the athlete has already done on this stretch, as dated stones on the walked part,
   * ascending (at most JOURNEY_STONES_MAX). Absent on an older read; when it holds stones the
   * trail's "Behind you" list prints their sentences instead of `behind`.
   */
  walked?: WeekReadJourneyStone[];
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

/** Which way a standing row or line has moved over its own window; null while it cannot be told. */
export type WeekReadStandingDirection = "better" | "holding" | "worse";

/** One line inside a standing row: a movement, a marker family, a mobility check. */
export interface WeekReadStandingLine {
  id: string;
  /** "Squat", "Lipids", "Ankle, left". */
  label: string;
  /** The lead fact, already in the athlete's units ("234 lb", "In range", "9 cm"); null when there is no reading. */
  now_text: string | null;
  direction: WeekReadStandingDirection | null;
  /** "Building" / "Holding" / "Slipping": a direction, never a grade or a level word. */
  direction_words: string | null;
  /** The measure of the move in words ("3% up since Oct 25", "two of five back in range since June"). */
  move_words: string | null;
  /** One quiet clause of context ("led by Back Squat", "next draw Dec 22"). */
  note: string | null;
}

/**
 * Where the athlete stands, whole person: one row per area a coach would look at. Words and
 * directions only: no score, no percentile, no level word, no raw lab value, and never a gate.
 * A row with nothing measured still appears when it carries an `invite` (what would let it speak).
 */
export interface WeekReadStandingRow {
  key: "strength" | "endurance" | "mobility" | "body" | "blood" | "pressure" | "recovery";
  /** The stone whose hue the row wears (docs/DESIGN.md): identity, never state. */
  stone: "strength" | "endurance" | "recovery" | "fuel" | "body" | "heart";
  label: string;
  direction: WeekReadStandingDirection | null;
  direction_words: string | null;
  /** The row's one sentence. */
  words: string;
  /** "since Oct 25": the window the direction is read over; null when no direction is read. */
  since_words: string | null;
  lines: WeekReadStandingLine[];
  /** What would sharpen or open this row, as an offer ("Four two-minute checks would let this row speak."); null when nothing is missing. */
  invite: string | null;
  href: string | null;
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
  /** Since you started: at most three measured changes, most telling first; empty when nothing has moved yet. This week only. */
  proof?: WeekReadProof[];
  /** Where you stand, whole person: this week only, omitted or empty when nothing can be said. */
  standing?: WeekReadStandingRow[];
  /** The journey trail: this week only, null with no dated mark ahead. */
  journey: WeekReadJourney | null;
  /** The one weight-trend read behind the weight goal row. */
  weight_trend: WeightTrendRead | null;
}
