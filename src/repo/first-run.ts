// "Has this install started yet?" — the two facts a fresh install is missing, asked in
// one place so the day read, the program digest and the scheduler agree on day one.
//
//   - a PLANNED week: a plan day carrying items (the same predicate the week composer and
//     the scheduler's "no plan to evolve yet" use — an empty shell day is not a week);
//   - LOGGED history: any lifting set, logged activity, food note or check-in. Bodyweight
//     alone is deliberately not history: the first conversation may record one, and a
//     single weight is not a training or logging record to reason over.
//
// Reads only; cheap EXISTS probes, each failing closed to "has it" so a broken table never
// makes a lived-in install read as brand new.
import { db } from "../db.js";

function exists(sql: string): boolean {
  try {
    return !!db.prepare(sql).get();
  } catch {
    return true;
  }
}

export function hasPlannedTraining(): boolean {
  return exists(`SELECT 1 FROM plan_items pi JOIN plan_days pd ON pd.id = pi.plan_day_id LIMIT 1`);
}

export function hasLoggedHistory(): boolean {
  return (
    exists(`SELECT 1 FROM logged_sets LIMIT 1`) ||
    exists(`SELECT 1 FROM activities LIMIT 1`) ||
    exists(`SELECT 1 FROM food_notes LIMIT 1`) ||
    exists(`SELECT 1 FROM checkins LIMIT 1`)
  );
}

/** Day one: no week on the plan and nothing logged yet. */
export function isStartingOut(): boolean {
  return !hasPlannedTraining() && !hasLoggedHistory();
}
