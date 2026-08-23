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
import { repointGuidesOnMerge } from "./exercise-guide.js";
import { withSqliteSavepoint } from "./sqlite-savepoint.js";
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
// a plan — with their muscle_group, mode, logged-set + distinct-logged-day counts,
// last-used date, and whether they're in the plan. The input the agentic exercise
// reconciler clusters (mirrors repo.distinctMarkerNames' shape) — the day count +
// last-used + in-plan give the agent (and the deterministic survivor pick) the usage
// context to judge which of two names is the real, well-trained lift. Null-safe.
export function distinctExerciseNames(): Array<{
  name: string;
  group: string | null;
  mode: string | null;
  sets: number;
  days: number;
  last_used: string | null;
  in_plan: boolean;
}> {
  try {
    return (
      db
        .prepare(
          `SELECT e.name AS name,
                  e.muscle_group AS group_,
                  e.mode AS mode,
                  COUNT(ls.id) AS sets,
                  COUNT(DISTINCT s.date) AS days,
                  MAX(s.date) AS last_used,
                  EXISTS (SELECT 1 FROM plan_items p WHERE p.exercise_id = e.id) AS in_plan
             FROM exercises e
             LEFT JOIN logged_sets ls ON ls.exercise_id = e.id
             LEFT JOIN sessions s ON s.id = ls.session_id
            WHERE EXISTS (SELECT 1 FROM logged_sets s2 WHERE s2.exercise_id = e.id)
               OR EXISTS (SELECT 1 FROM plan_items p2 WHERE p2.exercise_id = e.id)
            GROUP BY e.id
            ORDER BY e.name`
        )
        .all() as any[]
    ).map((r) => ({
      name: String(r.name),
      group: r.group_ != null ? String(r.group_) : null,
      mode: r.mode != null ? String(r.mode) : null,
      sets: Number(r.sets) || 0,
      days: Number(r.days) || 0,
      last_used: r.last_used != null ? String(r.last_used) : null,
      in_plan: !!Number(r.in_plan),
    }));
  } catch {
    return [];
  }
}

// The strength re-test cadence row is keyed by a lift slug, not a FK
// (training-milestones.ts writes `training:strength:${slug(name)}`). Mirror that slug
// so a merge can follow the cadence to the survivor instead of orphaning a stale
// "<from> re-test" in the forward timeline. Kept in lockstep with that module's slug.
function strengthSignalKey(name: string): string {
  const slug = normalizedExerciseKey(name || "benchmark").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "benchmark";
  return `training:strength:${slug}`;
}

// Merge one exercise into another: the single write that de-duplicates a movement
// logged under two names. Re-points logged_sets + plan_items, carries the anchor-lift
// objective + learned aliases + one-session skips onto the survivor, records the
// from-name as an alias so it resolves to the survivor forever, remaps the strength
// re-test cadence, then deletes the now-empty `from` row. Savepoint-wrapped so a
// mid-way failure leaves the split untouched. Guards: `into` must exist; `from` must
// exist (idempotent — ok:true with 0 moves when already gone); refuses a timed↔reps
// merge (incompatible logging shapes). NEVER touches logged numbers — only which
// exercise a set/plan row belongs to. `objectives`/`aliases`/`session_skips` are the
// non-FK references re-pointed; `moved_sets`/`moved_plan_items` the FK repoints.
export function mergeExercises(
  fromName: string,
  intoName: string
): {
  ok: boolean;
  moved_sets: number;
  moved_plan_items: number;
  objectives: number;
  aliases: number;
  session_skips: number;
  error?: string;
} {
  const empty = { moved_sets: 0, moved_plan_items: 0, objectives: 0, aliases: 0, session_skips: 0 };
  const into = findExercise(intoName);
  if (!into) return { ok: false, ...empty, error: `target exercise "${intoName}" not found` };
  const from = findExercise(fromName);
  if (!from) return { ok: true, ...empty }; // already gone — idempotent
  if (from.id === into.id) return { ok: true, ...empty }; // same exercise

  // A timed hold logs duration_sec; a reps lift logs weight/reps. They must never share
  // one series, so refuse the merge rather than silently corrupt the progression read.
  const fromMode = from.mode === "timed" ? "timed" : "reps";
  const intoMode = into.mode === "timed" ? "timed" : "reps";
  if (fromMode !== intoMode) {
    return { ok: false, ...empty, error: "cannot merge a timed movement with a reps movement" };
  }

  return withSqliteSavepoint("merge_exercises", () => {
    const moved_sets = Number(db.prepare("UPDATE logged_sets SET exercise_id = ? WHERE exercise_id = ?").run(into.id, from.id).changes);
    const moved_plan_items = Number(db.prepare("UPDATE plan_items SET exercise_id = ? WHERE exercise_id = ?").run(into.id, from.id).changes);

    // strength_objectives references a lift by NAME + normalizedExerciseKey (resolved
    // at read time, not by FK) — repoint any row keyed on the from-lift so an active
    // anchor-lift journey follows the survivor instead of losing its exact-lift anchor.
    const intoKey = normalizedExerciseKey(into.name);
    const fromKey = normalizedExerciseKey(from.name);
    const objectives = Number(
      db
        .prepare("UPDATE strength_objectives SET exercise = ?, exercise_key = ? WHERE exercise_key = ? OR exercise = ? COLLATE NOCASE")
        .run(into.name, intoKey, fromKey, from.name).changes
    );

    // Learned aliases that resolved TO the from-name now resolve to the survivor.
    const rewritten = Number(
      db.prepare("UPDATE exercise_aliases SET canonical = ? WHERE canonical = ? COLLATE NOCASE").run(into.name, from.name).changes
    );
    // One-session "not today" skips reference the exercise by name (COLLATE NOCASE,
    // UNIQUE(session_id, exercise)) — carry them over, ignoring a same-session dup.
    const session_skips = Number(
      db.prepare("UPDATE OR IGNORE session_skips SET exercise = ? WHERE exercise = ? COLLATE NOCASE").run(into.name, from.name).changes
    );

    // Follow the strength re-test cadence to the survivor. Best-effort: a schema-absent
    // DB, or a collision with the survivor's own row, must never fail the merge.
    try {
      const fromSig = strengthSignalKey(from.name);
      const intoSig = strengthSignalKey(into.name);
      if (fromSig !== intoSig) {
        db.prepare("UPDATE OR IGNORE attention_schedule SET signal_key = ? WHERE signal_key = ?").run(intoSig, fromSig);
        db.prepare("DELETE FROM attention_schedule WHERE signal_key = ?").run(fromSig);
      }
    } catch {
      /* the re-test cadence is a downstream consequence, not merge integrity */
    }

    // Carry the instructional guide across before the row disappears. The FK is
    // ON DELETE SET NULL, so skipping this would silently drop a matched guide
    // rather than crash — quieter, and wrong. The survivor's own guide wins.
    try {
      repointGuidesOnMerge(from.id, into.id);
    } catch {
      /* an optional, re-importable guide never fails a merge */
    }

    // Remove the now-empty exercise row, then record the from-name → survivor alias so
    // a future log/plan of the old name self-aligns (findOrCreateExercise path (a)).
    // setExerciseAlias is an UPSERT, so only count it when it actually adds/changes a
    // mapping (an identical alias already present is not a new change — no off-by-one).
    db.prepare("DELETE FROM exercises WHERE id = ?").run(from.id);
    const priorAlias = getExerciseAlias(from.name);
    setExerciseAlias(from.name, into.name, "merge");
    const aliasRecorded = !priorAlias || priorAlias.canonical !== into.name ? 1 : 0;

    bumpTrainingDataVersion(); // the merged history re-grades lifts in program-state
    return { ok: true, moved_sets, moved_plan_items, objectives, aliases: rewritten + aliasRecorded, session_skips };
  });
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

// Timed-movement twin of recentWorkingWeight. It deliberately resolves the exact
// stored exercise row before reading history: a dead-hang duration is not a safe
// anchor for a different grip/variation merely because the names share a movement
// family. The hardest completed hold across the last few sessions is the trustworthy
// baseline used when an agent proposes a new timed prescription.
export function recentWorkingSeconds(name: string, sessionsBack = 3): number | null {
  const ex = findExercise(name);
  if (!ex) return null;
  const row = db.prepare(
    `SELECT MAX(recent.best_seconds) AS best_seconds
       FROM (
         SELECT s.date, MAX(ls.duration_sec) AS best_seconds
           FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
          WHERE ls.exercise_id = ? AND ls.duration_sec IS NOT NULL AND ls.duration_sec > 0
          GROUP BY s.date
          ORDER BY s.date DESC
          LIMIT ?
       ) recent`
  ).get(ex.id, sessionsBack) as any;
  const value = Number(row?.best_seconds);
  return Number.isFinite(value) && value > 0 ? value : null;
}
