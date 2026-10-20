// A RACE THAT WAS RUN — its identity, bound to the logged EFFORT and kept past the goal.
//
// The endurance goal is one mutable slot, and the athlete sets the next race the morning
// after this one. So "the race" can never be "whatever the goal slot says now": a new 5k
// set on race + 1 would erase an open recovery window and turn the half just run back
// into an ordinary longest run (harm, capacity, novelty). Two rules fix that:
//
//   1. The race is its EFFORT, not the goal's date. A logged run within
//      RACE_DATE_SLACK_DAYS of the goal date whose distance is at least
//      RACE_EFFORT_MIN_SHARE of the goal's (a half needs ~18 km) is the race. A run on the
//      goal date wins; else the nearest to it. Off the goal date, a short race (≤10 km,
//      where a training run of that length is ordinary) must also be race-paced when its
//      pace can be read against the runs before it. No such run logged → no race.
//   2. The race outlives the goal. When the goal changes away from a dated race whose
//      effort is logged, or whose date has already come (the effort may still be
//      syncing), the race is kept in `completed_races` (`keepCompletedRace`, called by
//      setProfile) and read alongside the live goal from then on.
//
// race-recovery.ts is the one consumer-facing read over this (the window, a race day's
// identity for harm and capacity). This module stays a leaf — db, dates and the
// activity helpers only — so profile.ts can call it without a cycle.
import { db } from "../db.js";
import { addDaysISO, daysBetweenISO } from "../lib/dates.js";
import { withoutShadowActivities } from "./activity-shadow.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "./endurance-sports.js";

/** A run at least this share of the goal distance can be the race (a half: ≥ ~18 km). */
export const RACE_EFFORT_MIN_SHARE = 0.85;
/** How far from the goal date the race effort may be logged, either side. */
export const RACE_DATE_SLACK_DAYS = 2;
/** A whisker over 10 km: a race up to here is SHORT (its length is an ordinary run). */
export const SHORT_RACE_MAX_KM = 10.05;
// A short race off its goal date must run at least this much faster than the median
// pace of the runs before it (when there are enough to read one).
const RACE_PACE_EDGE = 0.95;
const PACE_LOOKBACK_DAYS = 28;
const PACE_MIN_RUNS = 3;

export interface RaceGoalRef {
  goal_date: string;
  distance_km: number;
  event: string | null;
}

export interface RaceRun {
  date: string;
  activity_id: number | null;
  km: number;
  duration_min: number | null;
}

export interface CompletedRaceRow extends RaceGoalRef {
  run_date: string | null;
  activity_id: number | null;
  run_km: number | null;
}

function runRowsBetween(from: string, to: string): any[] {
  const sport = activitySportWhere("activities", RUN_SPORT_PATTERNS);
  const rows = db
    .prepare(
      `SELECT id, date, type, source, external_id, duration_min, distance_km FROM activities
        WHERE date >= ? AND date <= ? AND distance_km > 0 AND (${sport.sql})
        ORDER BY date, id`
    )
    .all(from, to, ...sport.params) as any[];
  // A hand log shadowing the watch's row of the same run never counts twice.
  return withoutShadowActivities(rows);
}

const paceOf = (row: { duration_min?: unknown; distance_km?: unknown }): number | null => {
  const min = Number(row.duration_min);
  const km = Number(row.distance_km);
  return Number.isFinite(min) && min > 0 && Number.isFinite(km) && km > 0 ? min / km : null;
};

/** Whether `run` was race-paced against the runs before the race window. Unknown → true. */
function racePaced(run: RaceRun, goalDate: string): boolean {
  if (run.duration_min == null) return true;
  const pace = paceOf({ duration_min: run.duration_min, distance_km: run.km });
  if (pace == null) return true;
  const to = addDaysISO(goalDate, -(RACE_DATE_SLACK_DAYS + 1));
  const from = to ? addDaysISO(to, -PACE_LOOKBACK_DAYS) : null;
  if (!from || !to) return true;
  const paces = runRowsBetween(from, to)
    .map(paceOf)
    .filter((p): p is number => p != null)
    .sort((a, b) => a - b);
  if (paces.length < PACE_MIN_RUNS) return true;
  const mid = Math.floor(paces.length / 2);
  const median = paces.length % 2 ? paces[mid] : (paces[mid - 1] + paces[mid]) / 2;
  return pace <= median * RACE_PACE_EDGE;
}

/** Every logged run that could be the race effort for `goal`, by distance and date. */
export function raceLikeRuns(goal: RaceGoalRef): RaceRun[] {
  const km = Number(goal.distance_km);
  if (!(km > 0)) return [];
  const from = addDaysISO(goal.goal_date, -RACE_DATE_SLACK_DAYS);
  const to = addDaysISO(goal.goal_date, RACE_DATE_SLACK_DAYS);
  if (!from || !to) return [];
  try {
    const minKm = km * RACE_EFFORT_MIN_SHARE;
    const short = km <= SHORT_RACE_MAX_KM;
    return runRowsBetween(from, to)
      .map((r) => ({
        date: String(r.date).slice(0, 10),
        activity_id: r.id != null ? Number(r.id) : null,
        km: Number(r.distance_km),
        duration_min: Number(r.duration_min) > 0 ? Number(r.duration_min) : null,
      }))
      .filter((r) => Number.isFinite(r.km) && r.km >= minKm - 1e-9)
      .filter((r) => !short || r.date === goal.goal_date || racePaced(r, goal.goal_date));
  } catch {
    return [];
  }
}

/**
 * The race effort among `runs` as known on `asOf` (null: in hindsight, everything
 * logged). A run on the goal date wins (the longest there); else the nearest to it, the
 * longer, then the earlier. As of a date, only runs on or before it count, and a run
 * BEFORE the goal date only once the goal date itself has come — until then it is a
 * training run the race has not yet happened after.
 */
export function pickRaceEffort(goal: RaceGoalRef, runs: readonly RaceRun[], asOf: string | null): RaceRun | null {
  const eligible = runs.filter(
    (r) => asOf == null || (r.date <= asOf && (r.date >= goal.goal_date || asOf >= goal.goal_date))
  );
  if (!eligible.length) return null;
  const off = (r: RaceRun) => Math.abs(daysBetweenISO(r.date, goal.goal_date) ?? 99);
  return [...eligible].sort((a, b) => off(a) - off(b) || b.km - a.km || a.date.localeCompare(b.date))[0] ?? null;
}

/** Every kept race, oldest first. Fail-soft: none. */
export function completedRaceRows(): CompletedRaceRow[] {
  try {
    return (
      db
        .prepare(
          `SELECT goal_date, distance_km, event, run_date, activity_id, run_km FROM completed_races
            ORDER BY goal_date, id`
        )
        .all() as any[]
    ).map((r) => ({
      goal_date: String(r.goal_date).slice(0, 10),
      distance_km: Number(r.distance_km),
      event: r.event != null ? String(r.event) : null,
      run_date: r.run_date != null ? String(r.run_date).slice(0, 10) : null,
      activity_id: r.activity_id != null ? Number(r.activity_id) : null,
      run_km: r.run_km != null ? Number(r.run_km) : null,
    }));
  } catch {
    return [];
  }
}

/**
 * Keep the race an outgoing goal named (setProfile calls this when the endurance goal
 * changes). Kept with its matched effort when one is logged; kept unmatched when its
 * date has already come by `today` (the effort may still be syncing — race-recovery.ts
 * gives it the slow-sync grace and matches it when it lands); otherwise a race not yet
 * run is simply a goal that changed, and nothing is kept. Idempotent; a matched effort
 * is never overwritten by an unmatched one. Fail-soft.
 */
export function keepCompletedRace(
  goal: { date?: string | null; distance_km?: number | null; event?: string | null } | null | undefined,
  today: string
): void {
  try {
    const goalDate = goal?.date ? String(goal.date).slice(0, 10) : null;
    const km = Number(goal?.distance_km);
    if (!goalDate || !(km > 0)) return;
    const ref: RaceGoalRef = {
      goal_date: goalDate,
      distance_km: km,
      event: goal?.event ? String(goal.event).slice(0, 120) : null,
    };
    const run = pickRaceEffort(ref, raceLikeRuns(ref), null);
    if (!run && goalDate > String(today).slice(0, 10)) return;
    db.prepare(
      `INSERT INTO completed_races (goal_date, distance_km, event, run_date, activity_id, run_km)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(goal_date, distance_km) DO UPDATE SET
         event = COALESCE(excluded.event, completed_races.event),
         run_date = COALESCE(completed_races.run_date, excluded.run_date),
         activity_id = COALESCE(completed_races.activity_id, excluded.activity_id),
         run_km = COALESCE(completed_races.run_km, excluded.run_km),
         updated_at = datetime('now')`
    ).run(ref.goal_date, ref.distance_km, ref.event, run?.date ?? null, run?.activity_id ?? null, run?.km ?? null);
  } catch {
    /* keeping the race is best-effort: the goal write itself must never fail on it */
  }
}
