// Frozen snapshot of the strength-objective identity repair as of 2026-09-22;
// migrations must not track live code. Do not "fix" a bug here: fix the live module
// (repo/strength-objectives.ts) and, if old rows need it, append a NEW migration.
//
// DO NOT REFORMAT. Every line should still match the source it was taken from.
import type { DatabaseSync } from "node:sqlite";
import { normalizedExerciseKey, normalizeExerciseName } from "./v103-exercise-identity-repair.js";

// The two resolver tiers a selection-time name needs (snapshot of
// repo/exercise-canon.ts#resolveExerciseName tiers 1–2): the exact stored name, then
// one alias hop onto a stored canonical.
function storedExercise(db: DatabaseSync, name: string): { id: number; name: string } | null {
  const norm = normalizeExerciseName(name);
  if (!norm) return null;
  const rows = db.prepare(`SELECT id, name FROM exercises ORDER BY id`).all() as Array<{ id: number; name: string }>;
  const byName = (text: string) => rows.find((row) => normalizeExerciseName(row.name) === normalizeExerciseName(text));
  const exact = byName(name);
  if (exact) return { id: Number(exact.id), name: String(exact.name) };
  let alias: { canonical: string } | undefined;
  try {
    alias = db.prepare(`SELECT canonical FROM exercise_aliases WHERE alias = ?`).get(norm) as
      | { canonical: string }
      | undefined;
  } catch {
    alias = undefined;
  }
  const aliased = alias?.canonical ? byName(String(alias.canonical)) : undefined;
  return aliased ? { id: Number(aliased.id), name: String(aliased.name) } : null;
}

function epley(weight: number, reps: number): number {
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

// The latest exact-lift exposure on or before the day the objective was chosen —
// the baseline selection would have snapped had the name resolved then.
function baselineAsOf(db: DatabaseSync, exerciseId: number, asOf: string): { est_1rm: number; date: string } | null {
  const rows = db
    .prepare(
      `SELECT s.date AS date, ls.weight AS weight, ls.reps AS reps
         FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE ls.exercise_id = ? AND s.date <= ? AND ls.weight > 0 AND ls.reps > 0
        ORDER BY s.date DESC, ls.id`
    )
    .all(exerciseId, asOf) as Array<{ date: string; weight: number; reps: number }>;
  if (!rows.length) return null;
  const latest = String(rows[0].date);
  let best = 0;
  for (const row of rows) if (String(row.date) === latest) best = Math.max(best, epley(Number(row.weight), Number(row.reps)));
  return best > 0 ? { est_1rm: best, date: latest } : null;
}

export function repairStrengthObjectiveIdentity(db: DatabaseSync): { renamed: number; baselined: number } {
  let renamed = 0;
  let baselined = 0;
  const active = db
    .prepare(
      `SELECT id, exercise, exercise_key, baseline_est_1rm, created_at FROM strength_objectives WHERE status = 'active'`
    )
    .all() as Array<{ id: number; exercise: string; exercise_key: string; baseline_est_1rm: number | null; created_at: string | null }>;
  for (const row of active) {
    const stored = storedExercise(db, String(row.exercise));
    if (!stored) continue;
    const key = normalizedExerciseKey(stored.name);
    if (key && key !== row.exercise_key) {
      const taken = db
        .prepare(`SELECT 1 FROM strength_objectives WHERE status = 'active' AND exercise_key = ? AND id != ?`)
        .get(key, row.id);
      if (!taken) {
        db.prepare(
          `UPDATE strength_objectives SET exercise = ?, exercise_key = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(stored.name, key, row.id);
        renamed++;
      }
    }
    if (row.baseline_est_1rm == null) {
      const asOf = String(row.created_at ?? "").slice(0, 10) || "9999-12-31";
      const baseline = baselineAsOf(db, stored.id, asOf);
      if (baseline) {
        db.prepare(
          `UPDATE strength_objectives SET baseline_est_1rm = ?, baseline_date = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(baseline.est_1rm, baseline.date, row.id);
        baselined++;
      }
    }
  }
  return { renamed, baselined };
}
