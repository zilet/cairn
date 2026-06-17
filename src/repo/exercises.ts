import { db } from "../db.js";

// ---------- exercises ----------
const EXERCISE_MODES = ["reps", "timed"];

function validMode(mode: any): string | undefined {
  return typeof mode === "string" && EXERCISE_MODES.includes(mode) ? mode : undefined;
}

export function listExercises() {
  return db.prepare(`SELECT * FROM exercises ORDER BY name`).all();
}

export function findExercise(name: string): any {
  return db.prepare(`SELECT * FROM exercises WHERE name = ? COLLATE NOCASE`).get(name);
}

export function getExercise(id: number): any {
  return db.prepare(`SELECT * FROM exercises WHERE id = ?`).get(id) ?? null;
}

export function findOrCreateExercise(name: string, muscle_group?: string, constraint_note?: string, mode?: string): any {
  const existing = findExercise(name);
  if (existing) return existing;
  const info = db
    .prepare(`INSERT INTO exercises (name, muscle_group, constraint_note, mode) VALUES (?, ?, ?, ?)`)
    .run(name.trim(), muscle_group ?? null, constraint_note ?? null, validMode(mode) ?? "reps");
  return db.prepare(`SELECT * FROM exercises WHERE id = ?`).get(info.lastInsertRowid);
}

// Create-or-update by name: new exercises get the given fields; existing ones
// only update fields that were explicitly provided.
export function upsertExercise(input: { name: string; muscle_group?: string | null; mode?: string | null }): any {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("name required");
  const existing = findExercise(name);
  if (existing) {
    return updateExercise(existing.id, {
      muscle_group: input.muscle_group !== undefined ? input.muscle_group : undefined,
      mode: input.mode ?? undefined,
    });
  }
  return findOrCreateExercise(name, input.muscle_group ?? undefined, undefined, input.mode ?? undefined);
}

export function updateExercise(
  id: number,
  patch: { mode?: string | null; muscle_group?: string | null; cues?: string | null; constraint_note?: string | null }
): any {
  const cur = getExercise(id);
  if (!cur) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.mode !== undefined && patch.mode !== null) {
    const m = validMode(patch.mode);
    if (!m) throw new Error(`mode must be one of: ${EXERCISE_MODES.join(", ")}`);
    sets.push("mode = ?"); vals.push(m);
  }
  if (patch.muscle_group !== undefined) { sets.push("muscle_group = ?"); vals.push(patch.muscle_group ?? null); }
  if (patch.cues !== undefined) { sets.push("cues = ?"); vals.push(patch.cues ?? null); }
  if (patch.constraint_note !== undefined) { sets.push("constraint_note = ?"); vals.push(patch.constraint_note ?? null); }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE exercises SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getExercise(id);
}

// Delete an exercise by name. Refuses (200 + ok:false) when it's still referenced
// by a plan day or any logged set — neither table cascades, so a blind DELETE would
// orphan a foreign key. The caller surfaces the reason and offers the safe path
// (remove it from the plan / delete the logged sets first). A clean delete returns
// ok:true so the UI can drop the row.
export function deleteExercise(name: string) {
  const ex = findExercise(name);
  if (!ex) return { ok: false, deleted: 0, error: "not found", exercise: name };
  const inPlan = (db.prepare(`SELECT COUNT(*) AS c FROM plan_items WHERE exercise_id = ?`).get(ex.id) as any)?.c ?? 0;
  const inLogs = (db.prepare(`SELECT COUNT(*) AS c FROM logged_sets WHERE exercise_id = ?`).get(ex.id) as any)?.c ?? 0;
  if (inPlan > 0 || inLogs > 0) {
    return {
      ok: false, deleted: 0, exercise: name, plan_count: inPlan, log_count: inLogs,
      error: inLogs > 0
        ? "It still has logged sets — delete those first."
        : "It's still in your plan — remove it from the plan first.",
    };
  }
  const changes = db.prepare(`DELETE FROM exercises WHERE id = ?`).run(ex.id).changes;
  return { ok: changes > 0, deleted: changes, exercise: name };
}

