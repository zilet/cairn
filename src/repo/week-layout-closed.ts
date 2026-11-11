// WHAT OF THIS WEEK IS ALREADY BEHIND THE ATHLETE — the one answer every week-layout
// read is handed (src/domain/training/week-layout.ts `closed`). A layout suggestion is
// advice about the days still ahead: it may never ask the athlete to move a lift they
// have already trained, onto a day that has already gone by, or to protect a key run
// they have already run. Every caller (the race build, the Plan strip, the coach
// context) derives that from the log through this helper, so the three can never
// disagree about which days are still open.
//
//   days       weekday slots (Mon = 1 … Sun = 7) before `asOf` in its Mon–Sun week,
//              plus `asOf` itself once a lift is logged on it (a session with sets).
//   runs_done  a long / quality intent the flexible agenda already reads as completed
//              this week — on whatever day it was run (a Thursday quality session run
//              on Tuesday is done, and Wednesday's legs no longer sit before it).
import { db } from "../db.js";
import { addDaysISO, mondayOf } from "../lib/dates.js";
import { type FlexibleTrainingAgenda, flexibleTrainingAgenda } from "./flexible-training-agenda.js";
import type { WeeklyRunPlan } from "./run-progression.js";
import { withoutShadowActivities } from "./activity-shadow.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "./endurance-sports.js";
import { dowToDayNumber, isoDow, statedRunDows } from "./profile.js";

export interface WeekLayoutClosed {
  days: number[];
  runs_done: { long: boolean; quality: boolean };
}

function liftLoggedOn(date: string): boolean {
  try {
    const row = db
      .prepare(
        `SELECT 1 AS hit FROM sessions s WHERE s.date = ?
           AND EXISTS (SELECT 1 FROM logged_sets ls WHERE ls.session_id = s.id) LIMIT 1`
      )
      .get(date) as { hit?: number } | undefined;
    return !!row?.hit;
  } catch {
    return false;
  }
}

/**
 * `agenda` / `runPlan` are what the caller already holds: an agenda is read as-is; with
 * none, one is built off `runPlan` (or the engine's own week when that is absent too).
 * Fail-soft — an unreadable agenda closes no run.
 */
export function weekLayoutClosed(
  asOf: string,
  opts: { agenda?: FlexibleTrainingAgenda | null; runPlan?: WeeklyRunPlan | null } = {}
): WeekLayoutClosed {
  const days: number[] = [];
  const monday = mondayOf(asOf);
  for (let slot = 1; slot <= 7; slot++) {
    const date = addDaysISO(monday, slot - 1);
    if (!date) break;
    if (date < asOf || (date === asOf && liftLoggedOn(date))) days.push(slot);
  }
  let agenda: FlexibleTrainingAgenda | null = null;
  try {
    agenda =
      opts.agenda !== undefined
        ? opts.agenda
        : flexibleTrainingAgenda(asOf, opts.runPlan === undefined ? undefined : { runPlan: opts.runPlan });
  } catch {
    agenda = null;
  }
  const done = (kind: "long" | "quality"): boolean =>
    !!agenda?.available &&
    Array.isArray(agenda.intents) &&
    agenda.intents.some((intent) => intent.kind === kind && intent.status === "completed");
  return { days, runs_done: { long: done("long"), quality: done("quality") } };
}

// ---------- THE WEEK CLOSED EARLY (2026-10-04) ----------
//
// A Mon–Sun week used to count as closed only once Monday came round, so a week whose
// running was all done by Sunday morning — the long run in, no run day left — kept
// reading as its prescription until the next day: the race ladder walked on from the
// planned 19.5 km while 35.8 km had actually been run.
//
// The smallest sound rule, deliberately conservative:
//   • `asOf` is the week's last day, Sunday — never earlier. A Tue/Thu runner's week
//     closed on Thursday would be counted as a harm-free closed week (capacity, the
//     ladder's floor) before the next morning that can show its last run's harm exists,
//     then fall back on Friday: the ladder moving twice in two days. By Sunday every
//     run but a Sunday one has its next morning on record, and a Sunday run's is
//     Monday's, when the week closes in the ordinary way anyway;
//   • the athlete has STATED run days (no stated calendar → never closed early: with no
//     named weekdays nothing says the running is over), and
//   • a run is logged on the LAST stated run day, or every one of the agenda's intents
//     is completed.
// An unstated day (an optional Saturday ride, a spontaneous run) never holds the week
// open — and a run logged after the early close simply reads into the week next time.
export type CurrentWeekClosedReason = "last_run_day_logged" | "every_intent_done";

export interface CurrentWeekClosed {
  closed: boolean;
  reason: CurrentWeekClosedReason | null;
  /** The last stated run day of the week (ISO date), when there is a stated calendar. */
  last_run_day: string | null;
}

function runLoggedOn(date: string): boolean {
  try {
    const sport = activitySportWhere("a", RUN_SPORT_PATTERNS);
    const rows = db
      .prepare(
        `SELECT a.id, a.date, a.type, a.source, a.external_id, a.duration_min, a.distance_km
           FROM activities a
          WHERE a.date = ? AND (${sport.sql})
            AND (COALESCE(a.distance_km, 0) > 0 OR COALESCE(a.duration_min, 0) > 0)`
      )
      .all(date, ...sport.params) as any[];
    return withoutShadowActivities(rows).length > 0;
  } catch {
    return false;
  }
}

/**
 * Is `asOf`'s Mon–Sun week already closed — its running done — on its Sunday, before
 * Monday reads it as closed?
 * `agenda` is the caller's own read when it holds one (built here off the engine's week
 * otherwise, fail-soft). See the rule above.
 */
export function currentWeekClosedEarly(
  asOf: string,
  opts: { agenda?: FlexibleTrainingAgenda | null; statedDows?: readonly number[] | null } = {}
): CurrentWeekClosed {
  const open: CurrentWeekClosed = { closed: false, reason: null, last_run_day: null };
  let dows: readonly number[] = [];
  try {
    dows = opts.statedDows ?? statedRunDows(asOf);
  } catch {
    dows = [];
  }
  if (!dows.length) return open;
  const monday = mondayOf(asOf);
  const asOfSlot = dowToDayNumber(isoDow(asOf));
  const slots = [...new Set(dows.map((dow) => dowToDayNumber(dow)))];
  const lastSlot = Math.max(...slots);
  const lastRunDay = addDaysISO(monday, lastSlot - 1);
  const out: CurrentWeekClosed = { ...open, last_run_day: lastRunDay ?? null };
  // Sunday only (see the rule above): earlier, the week's last run has no next morning yet.
  if (asOfSlot !== 7 || lastSlot > asOfSlot || !lastRunDay) return out;
  if (runLoggedOn(lastRunDay)) return { ...out, closed: true, reason: "last_run_day_logged" };
  let agenda: FlexibleTrainingAgenda | null = null;
  try {
    agenda = opts.agenda !== undefined ? opts.agenda : flexibleTrainingAgenda(asOf);
  } catch {
    agenda = null;
  }
  const everyDone =
    !!agenda?.available &&
    Array.isArray(agenda.intents) &&
    agenda.intents.length > 0 &&
    agenda.intents.every((intent) => intent.status === "completed");
  return everyDone ? { ...out, closed: true, reason: "every_intent_done" } : out;
}
