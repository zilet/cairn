import { db } from "../db.js";
import {
  canonicalGroup,
  classifyMuscleGroup,
  cleanExerciseName,
  detectExerciseMode,
  getExerciseAlias,
  normalizeExerciseName,
  normalizedExerciseKey,
  resolveGroup,
  setExerciseAlias,
} from "./exercise-canon.js";

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
  // Exact name already exists — reuse it.
  const existing = findExercise(name);
  if (existing) return existing;

  // (a) A persisted alias for this (raw) input maps it to a canonical exercise that
  //     already exists — reuse that instead of creating a duplicate variant.
  const norm = normalizeExerciseName(name);
  const alias = norm ? getExerciseAlias(norm) : null;
  if (alias?.canonical) {
    const aliased = findExercise(alias.canonical);
    if (aliased) return aliased;
  }

  // (b) No alias, but an existing exercise keys the same way (same movement logged
  //     under a messier name) — self-align: record the alias so the raw variant
  //     resolves directly next time, and reuse the existing exercise.
  const key = normalizedExerciseKey(name);
  if (key) {
    const all = db.prepare(`SELECT name FROM exercises`).all() as Array<{ name: string }>;
    const sameKey = all.find((e) => normalizedExerciseKey(e.name) === key);
    if (sameKey) {
      if (normalizeExerciseName(sameKey.name) !== norm) setExerciseAlias(norm, sameKey.name);
      return findExercise(sameKey.name);
    }
  }

  // (c) Genuinely new — store a CLEAN display name. Explicit muscle_group/mode still
  //     win; otherwise auto-profile from the cleaned name. A supplied group passes
  //     through canonicalGroup() first so legacy values fold to the taxonomy.
  const cleanName = cleanExerciseName(name);
  // Cleaning can collapse a messy raw onto an EXISTING clean name that the raw didn't
  // match by alias/key (e.g. "Incline DB Press 3x10" → "Incline DB Press"). Reuse it
  // (and self-align the raw) instead of an INSERT that would hit the UNIQUE(name).
  const cleanDupe = findExercise(cleanName);
  if (cleanDupe) {
    if (norm && normalizeExerciseName(cleanName) !== norm) setExerciseAlias(norm, cleanDupe.name);
    return cleanDupe;
  }
  const resolvedGroup = muscle_group != null
    ? (canonicalGroup(muscle_group) ?? muscle_group)
    : classifyMuscleGroup(cleanName);
  const resolvedMode = validMode(mode) ?? detectExerciseMode(cleanName);
  const info = db
    .prepare(`INSERT INTO exercises (name, muscle_group, constraint_note, mode) VALUES (?, ?, ?, ?)`)
    .run(cleanName, resolvedGroup ?? null, constraint_note ?? null, resolvedMode);
  return db.prepare(`SELECT * FROM exercises WHERE id = ?`).get(info.lastInsertRowid);
}

// Create-or-update by name: new exercises get the given fields; existing ones
// only update fields that were explicitly provided.
export function upsertExercise(input: { name: string; muscle_group?: string | null; mode?: string | null }): any {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("name required");
  const existing = findExercise(name);
  if (existing) {
    // Canonicalize the supplied group before passing it through.
    const mg = input.muscle_group !== undefined
      ? (input.muscle_group != null ? (canonicalGroup(input.muscle_group) ?? input.muscle_group) : null)
      : undefined;
    return updateExercise(existing.id, {
      muscle_group: mg,
      mode: input.mode ?? undefined,
    });
  }
  return findOrCreateExercise(name, input.muscle_group ?? undefined, undefined, input.mode ?? undefined);
}

// Backfill / normalize muscle_group for ALL existing exercises. Idempotent:
// exercises already on a canonical group are skipped.
//   - null group  → classify by name via the KB
//   - legacy value (legs, posterior, abs, grip, …) → canonical taxonomy value
// Returns a count of changed rows + a change log (name, from, into).
export function reconcileExerciseGroups(): {
  updated: number;
  changes: Array<{ name: string; from: string | null; into: string }>;
} {
  const rows = db.prepare("SELECT id, name, muscle_group FROM exercises").all() as Array<{
    id: number;
    name: string;
    muscle_group: string | null;
  }>;
  const changes: Array<{ name: string; from: string | null; into: string }> = [];
  for (const ex of rows) {
    const resolved = resolveGroup(ex.name, ex.muscle_group);
    if (!resolved || resolved === ex.muscle_group) continue;
    db.prepare("UPDATE exercises SET muscle_group = ? WHERE id = ?").run(resolved, ex.id);
    changes.push({ name: ex.name, from: ex.muscle_group, into: resolved });
  }
  return { updated: changes.length, changes };
}

// Distinct exercise names that carry signal — those with logged sets OR that sit in
// a plan — with their muscle_group and a logged-set count. The input the agentic
// exercise reconciler clusters (mirrors repo.distinctMarkerNames' shape). Null-safe.
export function distinctExerciseNames(): Array<{ name: string; group: string | null; sets: number }> {
  try {
    return (
      db
        .prepare(
          `SELECT e.name AS name,
                  e.muscle_group AS group_,
                  COUNT(ls.id) AS sets
             FROM exercises e
             LEFT JOIN logged_sets ls ON ls.exercise_id = e.id
            WHERE EXISTS (SELECT 1 FROM logged_sets s WHERE s.exercise_id = e.id)
               OR EXISTS (SELECT 1 FROM plan_items p WHERE p.exercise_id = e.id)
            GROUP BY e.id
            ORDER BY e.name`
        )
        .all() as any[]
    ).map((r) => ({
      name: String(r.name),
      group: r.group_ != null ? String(r.group_) : null,
      sets: Number(r.sets) || 0,
    }));
  } catch {
    return [];
  }
}

// Merge one exercise into another: re-point all logged_sets.exercise_id and
// plan_items.exercise_id from `fromName` to `intoName`, then delete the now-empty
// `from` exercise. Guards: `into` must exist; `from` must exist. Idempotent —
// if `from` is already gone, returns ok:true with 0 moves.
export function mergeExercises(
  fromName: string,
  intoName: string
): { ok: boolean; moved_sets: number; moved_plan_items: number; error?: string } {
  const into = findExercise(intoName);
  if (!into) return { ok: false, moved_sets: 0, moved_plan_items: 0, error: `target exercise "${intoName}" not found` };
  const from = findExercise(fromName);
  if (!from) return { ok: true, moved_sets: 0, moved_plan_items: 0 }; // already gone — idempotent
  if (from.id === into.id) return { ok: true, moved_sets: 0, moved_plan_items: 0 }; // same exercise

  const moved_sets = Number(db.prepare("UPDATE logged_sets SET exercise_id = ? WHERE exercise_id = ?").run(into.id, from.id).changes);
  const moved_plan_items = Number(db.prepare("UPDATE plan_items SET exercise_id = ? WHERE exercise_id = ?").run(into.id, from.id).changes);
  // Remove the now-empty exercise row (no FKs remain pointing at it).
  db.prepare("DELETE FROM exercises WHERE id = ?").run(from.id);
  return { ok: true, moved_sets, moved_plan_items };
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

