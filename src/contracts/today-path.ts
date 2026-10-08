// The Today path contract (the Today redesign, "The day, then the road it's on").
//
// ONE deterministic forward read under the Brief: where the race estimate, the
// bodyweight and the anchor lift stand and which way each is moving, the dated
// milestones between today and the furthest of them, the ONE lever that would most
// help the path this week, and the progress board that lays every thread out in full.
// Built in src/repo/today-path.ts from the reads that already own each fact (the race
// build, goal pace, the strength journeys, the next-checkup read, the attention
// schedule) — it re-derives none of them.
//
// Served by `GET /api/today-path` (`get_today_path`) and the `/today` fan-in. Every
// number is a real measure in its own unit (seconds, pounds, kilometres) with a
// direction; nothing here is a score or a grade. A race estimate against its target
// is a FIT word (`fits` / `stretch` / `beyond_horizon`), never a verdict.
//
// Self-contained on purpose: src/client/** reads these types through
// `import("../contracts/today-path.js")`, and this module imports nothing.

export type TodayPathFit = "fits" | "stretch" | "beyond_horizon";

export interface TodayPathRace {
  /** The race's own name ("Cambridge Half"), or null when the goal names none. */
  event: string | null;
  /** Short distance word for a row: "Half marathon", "10K", "Marathon", "21.1 km race". */
  distance_label: string;
  date: string;
  days_to_race: number;
  /** The current finish estimate, seconds. */
  estimate_sec: number;
  /** The stated target, seconds; null when none was set. */
  target_sec: number | null;
  /** What the athlete wrote ("sub-2:00"); null with no target. */
  target_raw: string | null;
  /** Movement of the estimate over its window (negative = faster); null with one point. */
  trend_delta_sec: number | null;
  /** The date the trend window starts on; null with one point. */
  since: string | null;
  /** `since` in words ("since Sep 8"); null with no window. */
  since_words?: string | null;
  /** The race day in words ("Oct 18"). */
  date_words?: string;
  /** The estimate as a clock ("1:52:10"): every surface that names the fit names the time too. */
  estimate_text?: string;
  /** The target as written, else its clock; null with no target. */
  target_text?: string | null;
  fit: TodayPathFit | null;
}

export interface TodayPathWeight {
  mode: "lose" | "gain" | "maintain";
  current_lb: number;
  /** The date of the newest weigh-in; null when the weight is the profile's own. */
  current_date: string | null;
  goal_lb: number | null;
  goal_date: string | null;
  /** The recent-trend slope, lb per week (negative = losing); null on thin data. */
  trend_lb_wk: number | null;
  /** The slope the goal date asks for; null with no dated goal. */
  needed_lb_wk: number | null;
  /** The canonical weigh-ins of the last ~6 weeks, oldest first (a sparkline's points). */
  points: Array<{ date: string; weight_lb: number }>;
  /** The athlete's weight unit; every `*_text` / `*_words` here is already in it. */
  units?: "lb" | "kg";
  /** "159.6 lb" / "72.4 kg". */
  current_text?: string;
  goal_text?: string | null;
  /** The trend and the ask in words ("−0.9 lb/wk"), from the ONE weight-trend read. */
  trend_words?: string | null;
  needed_words?: string | null;
  /** The one on-pace verdict (weightTrendRead): on_pace | ahead | behind | steady. */
  verdict?: "on_pace" | "ahead" | "behind" | "steady" | null;
  /** The one sentence every weight surface prints ("Trending −0.9 lb/wk — on pace for Dec 1."). */
  line?: string | null;
}

export interface TodayPathAnchor {
  exercise: string;
  est_1rm: number;
  target_est_1rm: number;
  /** The estimate's slope, lb per week; null when it is not moving or too thin to read. */
  lb_per_week: number | null;
  /** The projection window to the target, in weeks [earliest, latest]; null when withheld. */
  projection_weeks: [number, number] | null;
}

export type TodayPathMilestoneKind = "long_run" | "peak_week" | "checkpoint" | "race" | "goal" | "checkup";

export interface TodayPathMilestone {
  date: string;
  /** Last day of a window (a peak week, a checkup week); null for a single day. */
  end_date: string | null;
  label: string;
  kind: TodayPathMilestoneKind;
  /** One plain sentence of why or what; null when there is nothing to add. */
  detail: string | null;
  /** `date` (and the window's end) in words: "Oct 18", "Nov 17 – Nov 23". Never an ISO date. */
  date_words?: string;
}

export type TodayPathLeverKind = "weight" | "sleep" | "race";

export interface TodayPathLever {
  /** ONE calm sentence (two at most), day-rotated phrasing — no gate language, no score. */
  text: string;
  kind: TodayPathLeverKind;
}

export type TodayPathBoardKey = "race" | "weight" | "strength" | "marker";

/** One thread on the progress board: start, now and goal marks on a track. */
export interface TodayPathBoardRow {
  key: TodayPathBoardKey;
  /** Stable per row ("race", "weight", "strength:deadlift", "marker:apob"). */
  id: string;
  label: string;
  /** Finished value words, each with its unit ("2:06:46", "159.8 lb", "285 lb"). */
  start_text: string | null;
  now_text: string;
  goal_text: string | null;
  /** Where now sits on the start→goal track, 0..1 (1 = at or past the goal); null with no track. */
  progress: number | null;
  /** True once now has reached or passed the goal. */
  reached: boolean;
  /** One short plain line under the track ("+4.2 lb/wk", "Recheck opens Nov 16"). */
  note: string | null;
  /**
   * Weight row only: how far now has moved from the journey's START ("6 lb down since Aug 3"),
   * the very text `note` carries when it says so — null with no start-anchored move of at
   * least half a pound. Horizon's "behind you" reads this instead of re-deriving a delta.
   */
  moved_words?: string | null;
  /** Direction words for a marker row: toward / away / steady; null elsewhere. */
  direction: "toward" | "away" | "steady" | null;
  /** How much of the start→goal distance moved in the last ~30 days (sorting only, never shown). */
  movement: number;
}

export interface TodayPathWeek {
  /** This week's planned running, km; null with no run plan. */
  km_planned: number | null;
  /** Kilometres already run this week. */
  km_logged: number | null;
  /** This week's long run, km; null when the week has none. */
  long_km: number | null;
  /** The week's stage word (stage-words.ts: "Sharpen", "Peak week", "Taper"); null when nothing names the week. */
  phase: string | null;
  /** The week's running in the athlete's run units ("3.8 of 19.3 mi"); null with no plan. */
  distance_words?: string | null;
}

/** The week's frame (week-stage.ts weekFrameLine), and Today's one link into Horizon. */
export interface TodayPathFrame {
  /** "26 days to Cambridge Half". */
  headline: string | null;
  /** "Sharpen · block week 6 of 6 · push through Nov 15". */
  line: string | null;
  /** The glance line Today prints, and where it goes. */
  glance: { line: string; href: string } | null;
}

export interface TodayPath {
  as_of: string;
  /** The left edge of the trail: the start of the race trend window, else ~4 weeks back. */
  trail_start: string;
  race: TodayPathRace | null;
  weight: TodayPathWeight | null;
  anchor: TodayPathAnchor | null;
  /** Dated, ascending, today onward. */
  milestones: TodayPathMilestone[];
  lever: TodayPathLever | null;
  /** The season's focus in a few words ("lipids & recomposition"); null when nothing names one. */
  focus: string | null;
  board: TodayPathBoardRow[];
  week: TodayPathWeek | null;
  /** The week's frame and Today's glance into Horizon; absent on older payloads. */
  frame?: TodayPathFrame | null;
  /** The athlete's units every sentence and `*_text` here is already in. */
  units?: { distance: "km" | "mi"; weight: "lb" | "kg" };
}
