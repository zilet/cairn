// A lift's WORKING LOAD, session by session — the week page's strength proof
// ("115 lb × 10 → 145 lb × 6") and its little step picture.
//
// Every session's load is the ONE working-load definition (working-load.ts
// sessionWorkingLoad: the heaviest load at which a set reached the rep floor), never the
// Epley-best set; the reps beside it are the most taken AT that load. The exercise is
// resolved through the one name ladder (exercise-canon.ts resolveExerciseName), exactly
// as the strength journey's history is, so the proof and the journey read one lift.
//
// Assisted (negative) and bodyweight work has no working load (working-load.ts returns
// null there); `assisted` says the lift carries such sets in the window, so a caller that
// only speaks loaded progress can skip it (the weight-encoding trap: negative = assist).
// Pure read; never throws past its caller's guard.
import { db } from "../db.js";
import { normalizedExerciseKey, resolveExerciseName } from "./exercise-canon.js";
import { atWorkingLoad, sessionWorkingLoad } from "./working-load.js";

export interface WorkingLoadPoint {
  date: string;
  /** The session's working load, canonical lb (always > 0). */
  load_lb: number;
  /** The most reps taken at that load. */
  reps: number;
}

export interface WorkingLoadHistory {
  exercise: string;
  /** Oldest first: one point per session date that carried a working load. */
  points: WorkingLoadPoint[];
  /** True when the window holds an assisted (negative) or bodyweight rep set for the lift. */
  assisted: boolean;
}

function exerciseIds(exercise: string): number[] {
  const key = normalizedExerciseKey(exercise);
  if (!key) return [];
  const resolved = resolveExerciseName(exercise).exercise_id;
  if (resolved != null) return [Number(resolved)];
  return (db.prepare(`SELECT id, name FROM exercises`).all() as Array<{ id: number; name: string }>)
    .filter((row) => normalizedExerciseKey(row.name) === key)
    .map((row) => Number(row.id));
}

/** The lift's working load per session from `since` (inclusive) through `through`. */
export function workingLoadHistory(
  exercise: string,
  opts: { since?: string | null; through?: string | null } = {}
): WorkingLoadHistory {
  const out: WorkingLoadHistory = { exercise, points: [], assisted: false };
  const ids = exerciseIds(exercise);
  if (!ids.length) return out;
  const marks = ids.map(() => "?").join(",");
  const clauses: string[] = [];
  const values: (string | number)[] = [...ids];
  if (opts.since) {
    clauses.push("s.date >= ?");
    values.push(opts.since);
  }
  if (opts.through) {
    clauses.push("s.date <= ?");
    values.push(opts.through);
  }
  const rows = db
    .prepare(
      `SELECT s.date AS date, ls.weight AS weight, ls.reps AS reps, ls.duration_sec AS duration_sec
         FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE ls.exercise_id IN (${marks})${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}
        ORDER BY s.date, ls.id`
    )
    .all(...values) as Array<{ date: string; weight: number | null; reps: number | null; duration_sec: number | null }>;
  const byDate = new Map<string, typeof rows>();
  for (const row of rows) {
    const reps = Number(row.reps);
    if (row.duration_sec == null && reps > 0 && (row.weight == null || Number(row.weight) <= 0)) out.assisted = true;
    const date = String(row.date).slice(0, 10);
    const list = byDate.get(date) ?? [];
    list.push(row);
    byDate.set(date, list);
  }
  for (const [date, sets] of byDate) {
    const load = sessionWorkingLoad(sets);
    if (load == null || !(load > 0)) continue;
    const reps = Math.max(0, ...sets.filter((s) => atWorkingLoad(s, load)).map((s) => Number(s.reps) || 0));
    if (!(reps > 0)) continue;
    out.points.push({ date, load_lb: load, reps });
  }
  out.points.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
