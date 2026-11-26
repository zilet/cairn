// The ledger of a muscle group corrected because a high-confidence agent profile named another
// one AND the curated tables positively agree with it (repo/exercises.ts recheckExerciseGroups).
// recheckExerciseGroups itself only RETURNS its changes (from / into / source_was); a profile
// correction moves a group a person might have chosen before sources were tracked, so each one is
// also written here, and the previous value can always be read back. The table is created with the
// rest of the schema (src/db.ts, exercise_group_corrections).
import { db } from "../db.js";

export interface ExerciseGroupCorrection {
  id: number;
  exercise_id: number;
  from_group: string | null;
  into_group: string;
  source_was: string | null;
  reason: string;
  created_at: string;
}

export function recordExerciseGroupCorrection(c: {
  exercise_id: number;
  from_group: string | null;
  into_group: string;
  source_was: string | null;
  reason: string;
}): void {
  db.prepare(
    `INSERT INTO exercise_group_corrections (exercise_id, from_group, into_group, source_was, reason) VALUES (?, ?, ?, ?, ?)`,
  ).run(c.exercise_id, c.from_group, c.into_group, c.source_was, c.reason);
}

/** A lift's corrections, newest first: the previous group is `from_group`. */
export function exerciseGroupCorrections(exerciseId: number): ExerciseGroupCorrection[] {
  return db
    .prepare(`SELECT * FROM exercise_group_corrections WHERE exercise_id = ? ORDER BY id DESC`)
    .all(exerciseId) as unknown as ExerciseGroupCorrection[];
}
