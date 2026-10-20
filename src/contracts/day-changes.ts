// A coach change, attached to the DAY it adapted.
//
// The Changes feed (src/contracts/brain-changes.ts) says what the team changed and why;
// it never said WHICH DAY that touched. A change to a plan day's prescription lands on
// whichever calendar date carries that plan day this week or next — the weekday map
// (`thisWeekPlanDayMap` / `strengthPlanDayOn`), never a guessed Mon=Day 1 — so a replan
// that moved Friday's session showed nothing on Friday. This is that link: one row per
// coach change in effect (or announced to land) on a date, in the feed's own athlete
// register, with the feed's own server-owned Undo.
//
// Served on GET /api/plan/day-detail (`changes`) and on each day of
// GET /api/race-build/days. Built in src/domain/training/day-changes.ts from
// brainChangesRead() and the weekday map (src/domain/training/plan-day-dates.ts).
// Athlete-facing wording is "adapted", never "removed". No score, no gate.

/** One coach change on one day. */
export interface DayDetailChange {
  /** The durable `brain_decisions` id — what Undo posts to `/api/brain/decisions/:id/revert`. */
  decision_id: number;
  /** The feed's finished headline: what changed. */
  title: string;
  /** Why, in the spoken voice; null when nothing athlete-facing was written. */
  why: string | null;
  /** `applied` — in effect on the day; `announced` — decided, lands on or before the day. */
  state: "applied" | "announced";
  /** The feed's timing line ("Landed today", "Lands Monday"). */
  status_line: string;
  /** The change can be put back by the server's own snapshot. */
  reversible: boolean;
  /** The feed's Undo: available now, with the server-owned label naming the effect. */
  undo: { available: boolean; label: string | null };
}
