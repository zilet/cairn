import { db } from "../db.js";
import { emitEnrichTransition } from "../enrichBus.js";
import { getSettings } from "./settings.js";
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
import { bumpTrainingDataVersion } from "./training-cache.js";

// ---------- exercises ----------
const EXERCISE_MODES = ["reps", "timed"];

export interface ExerciseRow {
  id: number;
  name: string;
  muscle_group: string | null;
  constraint_note: string | null;
  mode: string | null;
  created_at?: string;
  cues?: string | null;
  equipment?: string | null;
  enrichment_status?: string | null;
}

function validMode(mode: any): string | undefined {
  return typeof mode === "string" && EXERCISE_MODES.includes(mode) ? mode : undefined;
}

export function listExercises(): ExerciseRow[] {
  return db.prepare(`SELECT * FROM exercises ORDER BY name`).all() as unknown as ExerciseRow[];
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
//
// `opts.enrich` (set by the user-facing POST /api/exercises route, NOT by
// seed/plan-import which call findOrCreateExercise directly): when this call
// creates a genuinely-new exercise row, queue the background 'exercise'
// enrichment job (canonicalize + classify + how-to guide + good art). It never
// fires for an existing exercise or an alias/key resolution — only a real INSERT.
export function upsertExercise(
  input: { name: string; muscle_group?: string | null; mode?: string | null },
  opts: { enrich?: boolean } = {},
): any {
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
  // findOrCreateExercise may still resolve to an EXISTING row (alias/key/clean-dupe
  // match) rather than inserting. AUTOINCREMENT ids are monotonic, so an id above
  // the pre-call max is the reliable "a new row was inserted" signal.
  const beforeMax = maxExerciseId();
  const row = findOrCreateExercise(name, input.muscle_group ?? undefined, undefined, input.mode ?? undefined);
  const created = !!row && Number(row.id) > beforeMax;
  if (created && opts.enrich) {
    // Only queue when enrichment is enabled — otherwise record 'skipped' directly
    // (no pending churn), mirroring addActivity/addFoodNote.
    const status = getSettings().enrich_enabled ? "pending" : "skipped";
    setExerciseEnrichStatus(Number(row.id), status);
    if (status === "pending") {
      // enrich.ts imports repo.ts, so import lazily to avoid a module-eval cycle.
      import("../enrich.js").then((m) => m.enqueueEnrich("exercise", Number(row.id))).catch(() => {});
    }
    return getExercise(Number(row.id)); // re-read so enrichment_status rides along
  }
  return row;
}

function maxExerciseId(): number {
  return Number((db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM exercises`).get() as any)?.m ?? 0);
}

// Background 'exercise' enrichment status machine (pending → in_progress →
// done/failed/skipped), mirroring the activity/food/health setters.
export function setExerciseEnrichStatus(id: number, status: string) {
  db.prepare(`UPDATE exercises SET enrichment_status = ? WHERE id = ?`).run(status, id);
  const row = getExercise(id);
  emitEnrichTransition("exercise", id, row); // wake any SSE watcher on this row
  return row;
}

// Whether an exercise's background enrichment is still running — the art route
// checks this to DEFER a name-only image so the enrichment job's muscle/equipment-
// aware art (generated under the SAME cache key) wins without a wasted generation.
export function exerciseArtPending(name: string): boolean {
  const row = db.prepare(`SELECT enrichment_status FROM exercises WHERE name = ? COLLATE NOCASE`).get(name) as any;
  const s = String(row?.enrichment_status ?? "");
  return s === "pending" || s === "in_progress";
}

// Logged-set + plan-item reference counts for an exercise (both keyed by
// exercise_id). Used to keep a background rename conservative — a movement the
// athlete has already logged/planned under a name is never silently renamed.
function exerciseReferenceCount(id: number): { logs: number; plan: number } {
  const logs = Number((db.prepare(`SELECT COUNT(*) AS c FROM logged_sets WHERE exercise_id = ?`).get(id) as any)?.c ?? 0);
  const plan = Number((db.prepare(`SELECT COUNT(*) AS c FROM plan_items WHERE exercise_id = ?`).get(id) as any)?.c ?? 0);
  return { logs, plan };
}

// Apply the background enrichment agent's classification to ONE exercise, safely.
// NEVER touches logged numbers. Returns the exercise's final id + name (which can
// change if it merged into / renamed to a cleaner canonical) so the caller warms
// the guide + art under the right name.
//
// Conservative, in order:
//   - canonical: if it names an EXISTING different movement → merge THIS into it
//     (repoints FKs by id, deletes the dup, records the alias). If it's a cleaner
//     name with no collision AND this row is still unreferenced (a freshly-added
//     off-plan movement) → rename by id + record the alias. Otherwise leave the
//     name and just record the alias so a future re-add resolves cleanly.
//   - muscle_group: only fills a null/"other" group with a recognized value.
//   - equipment: only fills an empty equipment tag.
//   - mode: only when there are no logged sets yet (mode drives logging shape).
export function applyExerciseEnrichment(
  id: number,
  fields: { canonical?: string | null; muscle_group?: string | null; mode?: string | null; equipment?: string | null },
): { id: number; name: string } {
  const cur = getExercise(id);
  if (!cur) return { id, name: "" };
  let workingId = id;
  let name = String(cur.name);

  const proposed = cleanExerciseName(String(fields.canonical ?? "").trim());
  if (proposed && normalizeExerciseName(proposed) !== normalizeExerciseName(name)) {
    const other = findExercise(proposed);
    if (other && Number(other.id) !== id) {
      const merged = mergeExercises(name, proposed);
      if (merged.ok) {
        setExerciseAlias(normalizeExerciseName(name), other.name);
        workingId = Number(other.id);
        name = String(other.name);
      }
    } else if (!other) {
      // No collision — safe to rename by id, but ONLY while the row is still
      // unreferenced (a freshly-added off-plan movement). Once it has logged sets
      // or sits in the plan, keep the name the athlete has been using.
      const refs = exerciseReferenceCount(id);
      if (refs.logs === 0 && refs.plan === 0) {
        db.prepare(`UPDATE exercises SET name = ? WHERE id = ?`).run(proposed, id);
        setExerciseAlias(normalizeExerciseName(name), proposed);
        name = proposed;
      }
    }
  }

  const ex = getExercise(workingId);
  if (!ex) return { id: workingId, name };

  const group = String(fields.muscle_group ?? "").trim();
  const canonGroup = group ? canonicalGroup(group) : null;
  if (canonGroup) {
    const curGroup = String(ex.muscle_group ?? "").trim().toLowerCase();
    if (!curGroup || curGroup === "other") {
      db.prepare(`UPDATE exercises SET muscle_group = ? WHERE id = ?`).run(canonGroup, workingId);
    }
  }

  const equip = String(fields.equipment ?? "").trim().slice(0, 60);
  if (equip && !String(ex.equipment ?? "").trim()) {
    db.prepare(`UPDATE exercises SET equipment = ? WHERE id = ?`).run(equip, workingId);
  }

  const mode = validMode(fields.mode ?? undefined);
  if (mode && mode !== ex.mode && exerciseReferenceCount(workingId).logs === 0) {
    db.prepare(`UPDATE exercises SET mode = ? WHERE id = ?`).run(mode, workingId);
  }

  return { id: workingId, name };
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
    bumpTrainingDataVersion(); // mode/muscle_group change re-grades lifts in program-state
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

// The athlete's actual recent WORKING weight for a lift — the hardest top-set load
// they've handled across the last few sessions (top set per session by est-1RM, then
// the heaviest of those). This is "what you're really lifting", which the progression
// engine grounds in so a stale plan target can't strand a lift below reality (the bug:
// plan says 27 lb, you log 45–50 every week, the engine kept prescribing 27). Robust to
// a single light day (it reads the hardest of several sessions). null when no loaded
// history. Encoding preserved: negative = assist (closer to 0 = harder), 0/bodyweight
// is excluded (load progression doesn't apply). sessionsBack defaults to 3.
export function recentWorkingWeight(name: string, sessionsBack = 3): number | null {
  const ex = findExercise(name);
  if (!ex) return null;
  const dates = (db.prepare(
    `SELECT DISTINCT s.date AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id = ? AND ls.weight IS NOT NULL AND ls.weight != 0
      ORDER BY s.date DESC LIMIT ?`
  ).all(ex.id, sessionsBack) as any[]).map((r) => r.d);
  if (!dates.length) return null;
  let best: number | null = null;
  for (const d of dates) {
    const sets = db.prepare(
      `SELECT ls.weight AS weight, ls.reps AS reps FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE ls.exercise_id = ? AND s.date = ? AND ls.weight IS NOT NULL AND ls.weight != 0`
    ).all(ex.id, d) as any[];
    // The session's top set by est-1RM (weight × (1 + reps/30)); keep its raw weight.
    let topW: number | null = null;
    let bestScore = -Infinity;
    for (const s of sets) {
      const w = Number(s.weight);
      const score = w * (1 + (Number(s.reps) || 0) / 30);
      if (score > bestScore) { bestScore = score; topW = w; }
    }
    // "Harder" is the larger signed value in both regimes (loaded + and assist −),
    // so a plain max picks the hardest working load they've actually handled.
    if (topW != null && (best == null || topW > best)) best = topW;
  }
  return best;
}
