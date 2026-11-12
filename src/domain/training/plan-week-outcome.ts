// WHAT A DAY OF THE WEEK STRIP ACHIEVED, decided once on the server (the client only draws it).
//
// A cell's tick used to mean "the planned session is done", so a hard day of off-plan work
// (a ride, a run nobody planned) read as nothing achieved. Four facts, never a score:
//   plan_done — the day had a plan and every planned piece is in (a lift session, a planned run)
//   extra     — work was logged that was not the plan: a lift with no plan day, a run that closed
//               no intention, or a logged non-run activity (a ride, a paddle, a court game)
//   missed    — a PAST day whose plan is not all done. Neutral: the strip fades it, never blames it
//   activity  — the day's logged non-run activity (the strip's diamond), by the repo's own read
// A day that is not over is never `missed`; nothing logged and nothing planned is all-false.
import type { EnduranceImpact } from "../../repo/hybrid-load.js";
import type { LoadFamily } from "../../repo/endurance-sports.js";

export interface PlanWeekActivity {
  family: LoadFamily;
  /** The activity's own short label ("trail MTB"). */
  label: string;
}

export interface PlanWeekOutcome {
  plan_done: boolean;
  extra: boolean;
  missed: boolean;
  activity: PlanWeekActivity | null;
}

export const NO_OUTCOME: PlanWeekOutcome = { plan_done: false, extra: false, missed: false, activity: null };

/**
 * The day's non-run activity worth a mark: the heaviest logged piece (recentEnduranceImpacts
 * sorts heaviest first), except a light walk — a stroll is not a session in its own right
 * (the same bar `sameDayEnduranceOutings` holds).
 */
export function dayActivity(impacts: readonly EnduranceImpact[], date: string): PlanWeekActivity | null {
  const hit = impacts.find((i) => i.date === date && i.family !== "run" && !(i.family === "walk" && i.load === "light"));
  return hit ? { family: hit.family, label: String(hit.label || "").trim() || "activity" } : null;
}

export function dayOutcome(input: {
  date: string;
  asOf: string;
  /** The cell's plan day is a strength day. */
  liftPlanned: boolean;
  /** A session is logged on the cell and counts as done (finished, or on a day already over). */
  liftDone: boolean;
  hasSession: boolean;
  /** The cell's planned run: an agenda intent dated on it (null for none, or a run only logged). */
  plannedRun: { completed: boolean } | null;
  /** A run logged on the date that closed no intention (an extra), or no intention existed. */
  extraRun: boolean;
  activity: PlanWeekActivity | null;
}): PlanWeekOutcome {
  const { date, asOf } = input;
  if (date > asOf) return { ...NO_OUTCOME };
  const planExists = input.liftPlanned || input.plannedRun != null;
  const plan_done =
    planExists && (!input.liftPlanned || input.liftDone) && (input.plannedRun == null || input.plannedRun.completed);
  const extra = (input.hasSession && !input.liftPlanned) || input.extraRun || input.activity != null;
  return { plan_done, extra, missed: date < asOf && planExists && !plan_done, activity: input.activity };
}
