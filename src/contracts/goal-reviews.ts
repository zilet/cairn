// "Behind you" — the finished-goal reviews (src/repo/goal-reviews.ts).
//
// Every FINISHED goal (a race run, a strength objective completed, a goal weight
// reached) is snapshotted once with deterministic facts, then looked back on ONCE by
// an agent in its own words (headline, story, lessons, carry-forward) and frozen.
// Horizon › Season lists them quietly under "Behind you", newest first, and each one
// opens a detail page. No grade, no comparison against the target, no score — a
// review is a measure said back, never a verdict, and it never notifies.
//
// Served by GET /api/goal-reviews (list), GET /api/goal-reviews/:id (one, 200 + null
// on absence) and POST /api/goal-reviews/:id/review (queue the one review for a row
// not yet frozen). MCP mirrors: list_goal_reviews, get_goal_review, review_goal.
// Self-contained, so src/client/** can read these types through
// `import("../contracts/goal-reviews.js")`.

export const GOAL_REVIEW_KINDS = ["race", "strength_objective", "weight_goal"] as const;
export type GoalReviewKind = (typeof GOAL_REVIEW_KINDS)[number];

/**
 * waiting — a race still inside its post-race recovery days (looked back on after);
 * pending — ready to be reviewed (the nightly pass takes one a night);
 * ready   — reviewed and frozen, never rewritten;
 * failed  — the last attempt found no usable review; retried on a later night (3 tries).
 */
export const GOAL_REVIEW_STATUSES = ["pending", "waiting", "ready", "failed"] as const;
export type GoalReviewStatus = (typeof GOAL_REVIEW_STATUSES)[number];

/** The agent's own words, frozen once written. */
export interface GoalReviewText {
  /** One sentence: what this goal was, said back. The list row's line. */
  headline: string;
  /** 2–4 sentences: how it went, with the facts' own numbers. */
  story: string;
  /** 2–4 sentences: what this build taught about this athlete. */
  lessons: string;
  /** 1–3 sentences: what carries into what comes next. */
  carry_forward: string;
}

/** One row of "Behind you". */
export interface GoalReviewRow {
  id: number;
  kind: GoalReviewKind;
  /** "Cambridge Half Marathon", "Back squat 315 lb", "Goal weight 175 lb". */
  title: string;
  /** The day it was reached / run (YYYY-MM-DD). */
  achieved_on: string;
  /** "Sun, Nov 1, 2026". */
  date_text: string;
  status: GoalReviewStatus;
  /** The measure, in the athlete's units: "13.2 mi in 2:10:18 · 9:54 /mi". Never a grade. */
  result_line: string;
  /**
   * The row's one sentence: the agent's headline once reviewed; "Looked back on once the
   * recovery days are done" while a race is still in its window; null while pending.
   */
  line: string | null;
}

/** One Mon–Sun week of a race build, in the athlete's distance unit, drawn to scale. */
export interface GoalReviewChartWeek {
  week_start: string;
  /** "Oct 5" — the week's Monday. */
  label: string;
  /** Training distance that week (the race's own distance excluded), athlete's unit. */
  value: number;
  /** The race's own distance, stacked on race week only; 0 elsewhere. */
  race_value: number;
  /** True on the week holding the race. */
  race_week: boolean;
  /** True when the capacity read set the week's volume aside (the body paid for it). */
  set_aside: boolean;
  /** "28.4 mi" (+ " · race 13.2 mi" on race week) — the bar's accessible words. */
  words: string;
}

export interface GoalReviewBuildChart {
  units: "km" | "mi";
  weeks: GoalReviewChartWeek[];
  /** The tallest stacked bar (value + race_value), so a renderer scales without re-deriving. */
  max_value: number;
}

/** A build lever this review proposed and the server adopted (src/repo/build-levers.ts). */
export interface GoalReviewLever {
  key: string;
  value: number;
  /** The athlete-facing reason, one sentence. */
  because: string;
  /** active — shaping the next build; superseded — a later review replaced it; reverted — undone. */
  status: "active" | "superseded" | "reverted";
}

export interface GoalReviewCarried {
  /** The agent's carry-forward sentences (null until reviewed). */
  text: string | null;
  /** The levers this review adopted, each with its reason. Empty for most reviews. */
  levers: GoalReviewLever[];
  /** The brain_decisions row the adoption was recorded on: Undo goes through its revert route. */
  decision_id: number | null;
  /** True while any of those levers is still active (an Undo has something to undo). */
  undoable: boolean;
}

/** One review in full: the detail page. */
export interface GoalReviewDetail extends GoalReviewRow {
  review: GoalReviewText | null;
  /** Race builds only: the weekly volume bars, race week stacked with the race. */
  build: GoalReviewBuildChart | null;
  /** A few plain fact lines under the hero (the longest run, the taper, the recovery days…). */
  fact_lines: string[];
  carried: GoalReviewCarried;
  /** When the review was written (ISO), null until then. */
  reviewed_at: string | null;
}

/** GET /api/goal-reviews. */
export interface GoalReviewListResponse {
  reviews: GoalReviewRow[];
}

/** POST /api/goal-reviews/:id/review — a durable job, or the designed refusal at 200. */
export type GoalReviewQueueResponse =
  | { ok: true; job: unknown }
  | { ok: false; error: string; tried: Array<{ agent: string; error: string }> };
