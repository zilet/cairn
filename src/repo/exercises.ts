import { db } from "../db.js";
import { emitEnrichTransition } from "../enrichBus.js";
import { getSettings } from "./settings.js";
import {
  canonicalGroup,
  classifyMuscleGroup,
  cleanExerciseName,
  detectExerciseMode,
  getExerciseAlias,
  implementRelaxedExerciseKey,
  normalizeExerciseName,
  normalizedExerciseKey,
  resolveExerciseName,
  resolveGroup,
  setExerciseAlias,
  validateExerciseMergePlan,
} from "./exercise-canon.js";
import {
  getExerciseGuideByExerciseId,
  getGuideSuggestionForExercise,
  repointGuidesOnMerge,
} from "./exercise-guide.js";
import { isValidGarminRef, mapExerciseToGarmin, sameExerciseIdentity } from "./garmin-exercise-map.js";
import { getProgress } from "./sessions.js";
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
  garmin_category?: string | null;
  garmin_exercise?: string | null;
  garmin_map_status?: string | null;
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

  const norm = normalizeExerciseName(name);
  // Self-alignment writes are a DETERMINISTIC decision by this chokepoint, not an
  // agent's call — they carry source "auto" so the alias list stays readable.
  const selfAlign = (row: any): any => {
    if (row && norm && normalizeExerciseName(String(row.name)) !== norm) {
      setExerciseAlias(norm, String(row.name), "auto");
    }
    return row;
  };

  // (a) THE resolver decides which stored row this spelling IS: a persisted alias,
  //     a conservative key match ("Leg Extensions" ≡ "Leg Extension"), or an
  //     abbreviation-aware unique hit ("incline db press" → "Incline Dumbbell
  //     Press"). One ladder, shared with every reader — a name that RESOLVES to a
  //     row must never also create one, or the write path and the read path would
  //     disagree about which lift the athlete just logged.
  const resolved = resolveExerciseName(name);
  if (resolved.exercise_id != null) {
    const row = getExercise(resolved.exercise_id);
    if (row) return selfAlign(row);
  }

  // (b) Genuinely new — store a CLEAN display name. Explicit muscle_group/mode still
  //     win; otherwise auto-profile from the cleaned name. A supplied group passes
  //     through canonicalGroup() first so legacy values fold to the taxonomy.
  const cleanName = cleanExerciseName(name);
  // Cleaning can collapse a messy raw onto an EXISTING exercise the raw itself did
  // not reach (e.g. "incline db press 3x10" — the set/rep notation broke every key).
  // Resolve the CLEANED spelling too and reuse the row instead of an INSERT that
  // would hit the UNIQUE(name).
  const cleanResolved = cleanName && cleanName !== name ? resolveExerciseName(cleanName) : null;
  if (cleanResolved?.exercise_id != null) {
    const row = getExercise(cleanResolved.exercise_id);
    if (row) return selfAlign(row);
  }

  // (c) Last resort before the INSERT: the same movement typed with a STATION word
  //     the stored row does not carry ("Cable Rope Hammer Curl" onto "Rope Hammer
  //     Curl"). UNIQUE hit only — and, exactly like the abbreviation tier inside the
  //     resolver, a row whose relaxed key EXTENDS the input's ("DB Bench Press
  //     Incline" over "db bench press") makes the read ambiguous, so this tier must
  //     refuse rather than pick. The pair must additionally clear the merge
  //     validator's safety guards, so it can never fold incline onto flat, an
  //     assisted pull-up onto a strict one, or a timed hold onto a reps lift.
  const relaxedKey = implementRelaxedExerciseKey(name);
  if (relaxedKey) {
    const rows = db.prepare(`SELECT id, name, muscle_group, mode FROM exercises`).all() as Array<{
      id: number;
      name: string;
      muscle_group: string | null;
      mode: string | null;
    }>;
    const matches: typeof rows = [];
    let relaxedAmbiguous = false;
    for (const row of rows) {
      const rowKey = implementRelaxedExerciseKey(row.name);
      if (rowKey === relaxedKey) matches.push(row);
      else if (rowKey.startsWith(`${relaxedKey} `)) relaxedAmbiguous = true;
    }
    if (!relaxedAmbiguous && matches.length === 1) {
      const candidate = matches[0];
      const verdict = validateExerciseMergePlan(
        { name, group: muscle_group ?? null, mode: validMode(mode) ?? null },
        { name: candidate.name, group: candidate.muscle_group, mode: candidate.mode }
      );
      if (verdict.ok) {
        const row = getExercise(Number(candidate.id));
        if (row) return selfAlign(row);
      }
    }
  }
  const resolvedGroup = muscle_group != null
    ? (canonicalGroup(muscle_group) ?? muscle_group)
    : classifyMuscleGroup(cleanName);
  const resolvedMode = validMode(mode) ?? detectExerciseMode(cleanName);
  const info = db
    .prepare(`INSERT INTO exercises (name, muscle_group, constraint_note, mode) VALUES (?, ?, ?, ?)`)
    .run(cleanName, resolvedGroup ?? null, constraint_note ?? null, resolvedMode);
  // Every genuinely-new movement gets its deterministic Garmin FIT mapping right
  // here, on the INSERT — so seed, plan import and a hand-logged set all resolve one
  // the same way, with no agent involved. The agentic layer only ever refines the
  // long tail this floor could not place (see applyExerciseEnrichment).
  ensureGarminMapping(Number(info.lastInsertRowid));
  return db.prepare(`SELECT * FROM exercises WHERE id = ?`).get(info.lastInsertRowid);
}

// Resolve and store the FIT category/sub-exercise pair for one movement, from its
// name plus whatever tags it already carries. Fill-only: a row already 'mapped' (an
// agent-refined or hand-corrected pair) is left alone, and an unmappable name is
// remembered as 'unmapped' rather than re-scored on every read. Never throws — a
// missing mapping only means that lift isn't included in a write-back.
export function ensureGarminMapping(id: number): { category: string | null; exercise: string | null; status: string } {
  const ex = getExercise(id);
  if (!ex) return { category: null, exercise: null, status: "unmapped" };
  const status = String(ex.garmin_map_status ?? "");
  const already = String(ex.garmin_category ?? "").trim();
  if (status === "mapped" && already) return { category: already, exercise: ex.garmin_exercise ?? null, status };
  if (status === "skipped" || status === "unmapped") return { category: null, exercise: null, status };
  try {
    const hit = mapExerciseToGarmin(String(ex.name), {
      muscle_group: ex.muscle_group ?? null,
      equipment: ex.equipment ?? null,
    });
    const mapped = hit.confidence !== "none" && isValidGarminRef(hit);
    db.prepare(`UPDATE exercises SET garmin_category = ?, garmin_exercise = ?, garmin_map_status = ? WHERE id = ?`).run(
      mapped ? hit.category : null,
      mapped ? hit.exercise : null,
      mapped ? "mapped" : "unmapped",
      id
    );
    return mapped
      ? { category: hit.category, exercise: hit.exercise, status: "mapped" }
      : { category: null, exercise: null, status: "unmapped" };
  } catch {
    return { category: null, exercise: null, status: "unmapped" };
  }
}

// The ONE gate that decides whether a freshly-created movement gets a background
// enrichment job. Both the user-facing upsert and the log-a-set path call it, so
// the "only queue when enrichment is enabled, otherwise record 'skipped' directly"
// rule cannot drift between them (a disabled install must not accrue pending churn).
export function queueExerciseEnrichment(id: number): "pending" | "skipped" {
  const status = getSettings().enrich_enabled ? "pending" : "skipped";
  setExerciseEnrichStatus(id, status);
  if (status === "pending") {
    // enrich.ts imports repo.ts, so import lazily to avoid a module-eval cycle.
    import("../enrich.js").then((m) => m.enqueueEnrich("exercise", id)).catch(() => {});
  }
  return status;
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
    queueExerciseEnrichment(Number(row.id));
    return getExercise(Number(row.id)); // re-read so enrichment_status rides along
  }
  return row;
}

// AUTOINCREMENT ids are monotonic, so an id above the pre-call max is the reliable
// "a new row was inserted" signal — findOrCreateExercise may instead resolve to an
// existing row via alias/key/clean-dupe. Exported for the log-a-set path, which asks
// the same question.
export function maxExerciseId(): number {
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
// checks this to wait for the full job's pose-aware producer instead of firing
// a parallel exercise_art generate (the two share warmExerciseArt / inFlight).
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
//     name with no collision AND either this row is still unreferenced (a freshly-
//     added off-plan movement) OR the canonical is demonstrably the SAME lift
//     (sameExerciseIdentity — "DB Incline Press" → "Incline Dumbbell Press") →
//     rename by id + record the alias. Otherwise leave the name and just record the
//     alias so a future re-add resolves cleanly.
//   - muscle_group: only fills a null/"other" group with a recognized value.
//   - equipment: only fills an empty equipment tag.
//   - mode: only when there are no logged sets yet (mode drives logging shape).
//   - garmin_category/garmin_exercise: validated against the FIT catalog, fill-only.
//
// The rename rule is deliberately about IDENTITY, not references: a logged movement
// may be relabelled to a cleaner name for the same lift (the label is display text;
// the logged numbers never move, and the id is stable), but it is never renamed
// across a real implement/angle difference — that would silently turn one lift's
// history into another's. sameExerciseIdentity is the guard, and it fails closed.
export function applyExerciseEnrichment(
  id: number,
  fields: {
    canonical?: string | null;
    muscle_group?: string | null;
    mode?: string | null;
    equipment?: string | null;
    garmin_category?: string | null;
    garmin_exercise?: string | null;
  },
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
      // No collision — safe to rename by id when the row is still unreferenced (a
      // freshly-added off-plan movement) OR when the canonical is the SAME lift
      // spelled cleanly. Anything else keeps the name the athlete has been using.
      const refs = exerciseReferenceCount(id);
      if ((refs.logs === 0 && refs.plan === 0) || sameExerciseIdentity(name, proposed)) {
        db.prepare(`UPDATE exercises SET name = ? WHERE id = ?`).run(proposed, id);
        setExerciseAlias(normalizeExerciseName(name), proposed);
        name = proposed;
        // The old messy name may have mapped to the wrong FIT enum; the clean one
        // deserves a fresh look. The floor runs after the agent's pick below so a
        // valid shortlist choice wins, and a group fill can inform the retry.
        db.prepare(
          `UPDATE exercises SET garmin_category = NULL, garmin_exercise = NULL, garmin_map_status = NULL WHERE id = ?`
        ).run(id);
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

  // The agent's FIT mapping, held to the catalog's own enum. An invented category
  // or sub-exercise is dropped outright (Garmin would 400 the whole PUT), and an
  // already-mapped pair is never replaced by an empty or invalid one — the
  // deterministic floor stands until something strictly better validates.
  const proposedCategory = String(fields.garmin_category ?? "").trim().toUpperCase();
  const proposedExercise = String(fields.garmin_exercise ?? "").trim().toUpperCase() || null;
  if (proposedCategory) {
    const ref = { category: proposedCategory, exercise: proposedExercise };
    const alreadyMapped = String(ex.garmin_map_status ?? "") === "mapped" && !!String(ex.garmin_category ?? "").trim();
    if (!alreadyMapped && isValidGarminRef(ref)) {
      db.prepare(
        `UPDATE exercises SET garmin_category = ?, garmin_exercise = ?, garmin_map_status = 'mapped' WHERE id = ?`
      ).run(ref.category, ref.exercise, workingId);
    }
  }

  // ensureGarminMapping early-returns once a row is already 'mapped' OR 'unmapped'
  // (that memoized 'unmapped' is deliberate — never re-score a row we already
  // scored and rejected). So this call only actually re-scores after the RENAME
  // path above has cleared garmin_map_status to null; a group/equipment fill
  // never touches the status and this is a no-op for it, same as a mapped row.
  ensureGarminMapping(workingId);

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

// A movement key in the exact shape movement_tolerance_observations persists it. The
// symptom lifecycle (repo/training-symptoms.ts) writes `exercise:<id>` once a reported
// movement resolves to a catalog row and `movement:<name-slug>` when it does not, and
// BOTH spellings are read back — by the pain traffic light (repo/pain-band.ts) and by
// the swap-pool risk read (repo/movement-risk.ts). Mirrored here so a merge can follow
// the evidence; kept in lockstep with those three modules.
function toleranceMovementSlug(name: string): string {
  return `movement:${String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

interface MergeSide {
  id: number;
  name: string;
}

/**
 * A merged lift and its survivor on the SAME plan day are one slot, not two.
 *
 * plan_items carries no unique index on (plan_day_id, exercise_id) — nothing stops one
 * exercise appearing twice on a day — so re-pointing a day that already prescribed the
 * survivor leaves the athlete two cards for one movement, indistinguishable in the Plan
 * editor and counted twice by every volume read.
 *
 * THE SURVIVOR'S OWN ITEM IS KEPT: it is the row the day already reads from, so its
 * position, superset pairing and note stay exactly as programmed, and the re-pointed
 * duplicate is dropped. The only thing the duplicate hands over is a prescription the
 * survivor is MISSING — `target_weight` and `target_seconds` are carried only where the
 * survivor's is NULL, so a real prescription is never overwritten and never lost when
 * the survivor had none. `sets` is NOT NULL in the schema, so it always holds a value
 * and therefore never carries. Where the survivor holds several items on that day the
 * earliest (lowest position) wins. Dropping a row leaves a gap in `position`, which is
 * read ORDER BY only and never as a dense sequence.
 */
function foldPlanDayDuplicates(from: MergeSide, into: MergeSide): number {
  const duplicates = db
    .prepare(
      `SELECT f.id AS from_id, f.target_weight AS from_weight, f.target_seconds AS from_seconds,
              (SELECT s.id FROM plan_items s
                WHERE s.plan_day_id = f.plan_day_id AND s.exercise_id = ?
                ORDER BY s.position, s.id LIMIT 1) AS keep_id
         FROM plan_items f
        WHERE f.exercise_id = ?
        ORDER BY f.id`
    )
    .all(into.id, from.id) as Array<{
    from_id: number;
    from_weight: number | null;
    from_seconds: number | null;
    keep_id: number | null;
  }>;
  let dropped = 0;
  for (const row of duplicates) {
    if (row.keep_id == null) continue; // that day only ever prescribed the merged lift
    db.prepare(
      `UPDATE plan_items
          SET target_weight = COALESCE(target_weight, ?), target_seconds = COALESCE(target_seconds, ?)
        WHERE id = ?`
    ).run(row.from_weight, row.from_seconds, Number(row.keep_id));
    db.prepare("DELETE FROM plan_items WHERE id = ?").run(Number(row.from_id));
    dropped += 1;
  }
  return dropped;
}

/**
 * Carry a symptom watch's movement evidence onto the survivor.
 *
 * movement_tolerance_observations names the lift THREE ways at once: the FK
 * `exercise_id`, the `movement_key` it is actually READ by, and the display
 * `movement_name`. None of them cascades — the FK is ON DELETE SET NULL — so deleting
 * the merged row used to leave the observation holding `exercise:<a deleted id>` while
 * every reader asks for the survivor's id or the survivor's name slug. The rows stayed
 * in the table and went invisible: a movement the athlete had reported PAINFUL read
 * clear on the traffic light and walked back into the swap pool.
 *
 * Both unique exposure indexes key on (event, session, movement_key, day, outcome,
 * epoch), so a re-point can land on a row the survivor already owns. THE SURVIVOR'S ROW
 * IS KEPT, and the loser's STRENGTH is folded into it first: `evidence='stated'`
 * outranks `'inferred'` (the athlete said it, vs. we read it off a logged set) and
 * `relevant=1` outranks 0 — in both directions the weaker value is the one that would
 * quietly drop evidence. Only then is the duplicate deleted, so nothing the two rows
 * disagreed about is lost.
 *
 * Deliberately NOT best-effort: an exposure that goes missing here is the merge
 * silently un-reporting pain, so a failure must roll the whole merge back.
 */
function repointMovementToleranceOnMerge(from: MergeSide, into: MergeSide): { moved: number; folded: number } {
  const fromExerciseKey = `exercise:${from.id}`;
  const intoExerciseKey = `exercise:${into.id}`;
  const fromSlug = toleranceMovementSlug(from.name);
  const intoSlug = toleranceMovementSlug(into.name);
  const rows = db
    .prepare(
      `SELECT id, symptom_event_id, session_id, movement_key, observed_on, outcome, evidence, relevant, evidence_epoch
         FROM movement_tolerance_observations
        WHERE movement_key IN (?, ?) OR exercise_id = ?
        ORDER BY id`
    )
    .all(fromExerciseKey, fromSlug, from.id) as Array<{
    id: number;
    symptom_event_id: number;
    session_id: number | null;
    movement_key: string;
    observed_on: string;
    outcome: string;
    evidence: string;
    relevant: number;
    evidence_epoch: number;
  }>;
  // The twin is looked up against LIVE state on every row, so two loser rows that
  // collapse onto the same survivor key fold into each other correctly too.
  const twin = db.prepare(
    `SELECT id, evidence, relevant FROM movement_tolerance_observations
      WHERE symptom_event_id = ? AND IFNULL(session_id, -1) = IFNULL(?, -1) AND movement_key = ?
        AND observed_on = ? AND outcome = ? AND evidence_epoch = ? LIMIT 1`
  );
  let moved = 0;
  let folded = 0;
  for (const row of rows) {
    const key = String(row.movement_key);
    const target = key === fromExerciseKey ? intoExerciseKey : key === fromSlug ? intoSlug : null;
    if (target == null || target === key) {
      // A row this merge owns only through its FK, or one whose key spelling the merge
      // does not rename (both names slug the same). Only the dangling id needs fixing.
      db.prepare("UPDATE movement_tolerance_observations SET exercise_id = ? WHERE id = ?").run(into.id, Number(row.id));
      continue;
    }
    const existing = twin.get(
      Number(row.symptom_event_id),
      row.session_id == null ? null : Number(row.session_id),
      target,
      String(row.observed_on),
      String(row.outcome),
      Number(row.evidence_epoch)
    ) as { id: number; evidence: string; relevant: number } | undefined;
    if (existing) {
      const evidence = String(row.evidence) === "stated" || String(existing.evidence) === "stated" ? "stated" : "inferred";
      const relevant = Number(row.relevant) === 1 || Number(existing.relevant) === 1 ? 1 : 0;
      db.prepare(
        "UPDATE movement_tolerance_observations SET exercise_id = ?, movement_name = ?, evidence = ?, relevant = ? WHERE id = ?"
      ).run(into.id, into.name, evidence, relevant, Number(existing.id));
      db.prepare("DELETE FROM movement_tolerance_observations WHERE id = ?").run(Number(row.id));
      folded += 1;
      continue;
    }
    db.prepare(
      "UPDATE movement_tolerance_observations SET exercise_id = ?, movement_key = ?, movement_name = ? WHERE id = ?"
    ).run(into.id, target, into.name, Number(row.id));
    moved += 1;
  }
  return { moved, folded };
}

// Merge one exercise into another: the single write that de-duplicates a movement
// logged under two names. Re-points logged_sets + plan_items, carries the anchor-lift
// objective + learned aliases + one-session skips onto the survivor, records the
// from-name as an alias so it resolves to the survivor forever, remaps the strength
// re-test cadence, follows the instructional guide and its pending suggestion, moves
// the strength calibration anchor and the pain/tolerance evidence, then deletes the
// now-empty `from` row. Savepoint-wrapped so a mid-way failure leaves the split
// untouched. Guards: `into` must exist; `from` must exist (idempotent — ok:true with 0
// moves when already gone); refuses a timed↔reps merge (incompatible logging shapes).
// NEVER touches logged numbers — only which exercise a set/plan row belongs to.
// `objectives`/`aliases`/`session_skips`/`*_observations` are the non-FK references
// re-pointed; `moved_sets`/`moved_plan_items` the FK repoints, and
// `dropped_plan_items` the duplicate plan slots folded away.
//
// EVERY reference must move BEFORE the DELETE. Three of the tables below hold a NAME
// or a derived key rather than a foreign key, and the two that do hold one are
// ON DELETE SET NULL — so a reference left behind is not a crash, it is evidence that
// quietly stops existing. See the reference map in docs/ARCHITECTURE.md.
export function mergeExercises(
  fromName: string,
  intoName: string
): {
  ok: boolean;
  moved_sets: number;
  moved_plan_items: number;
  dropped_plan_items: number;
  objectives: number;
  aliases: number;
  session_skips: number;
  moved_observations: number;
  folded_observations: number;
  error?: string;
} {
  const empty = {
    moved_sets: 0,
    moved_plan_items: 0,
    dropped_plan_items: 0,
    objectives: 0,
    aliases: 0,
    session_skips: 0,
    moved_observations: 0,
    folded_observations: 0,
  };
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
    // Fold FIRST, re-point what is left: a day that already prescribes the survivor
    // must not end up holding the same movement twice.
    const dropped_plan_items = foldPlanDayDuplicates(from, into);
    const moved_plan_items = Number(db.prepare("UPDATE plan_items SET exercise_id = ? WHERE exercise_id = ?").run(into.id, from.id).changes);

    // strength_objectives references a lift by NAME + normalizedExerciseKey (resolved
    // at read time, not by FK) — repoint any row keyed on the from-lift so an active
    // anchor-lift journey follows the survivor instead of losing its exact-lift anchor.
    const intoKey = normalizedExerciseKey(into.name);
    const fromKey = normalizedExerciseKey(from.name);
    // Schema v98 holds ONE active objective per exercise_key. Merging two lifts that
    // BOTH carry a live anchor would land two active rows on the survivor's key and
    // throw UNIQUE mid-merge, 500-ing a merge that is otherwise perfectly legal. So
    // supersede first, mirroring setStrengthObjective's per-lift semantics: the NEWEST
    // active anchor across the two lifts survives, the rest become 'superseded'
    // history (never deleted, never rewritten).
    const contendingActive = db
      .prepare(
        `SELECT id FROM strength_objectives
          WHERE status = 'active' AND (exercise_key = ? OR exercise_key = ? OR exercise = ? COLLATE NOCASE)
          ORDER BY id DESC`
      )
      .all(fromKey, intoKey, from.name) as Array<{ id: number }>;
    if (contendingActive.length > 1) {
      for (const row of contendingActive.slice(1)) {
        db.prepare(
          `UPDATE strength_objectives
              SET status = 'superseded', superseded_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?`
        ).run(Number(row.id));
      }
    }
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
      // An unlinked guide SUGGESTION names its candidate exercise in text
      // (getGuideSuggestionForExercise matches on that name, not on an id), so the
      // pending yes/no has to follow the survivor or it becomes unanswerable.
      db.prepare(
        "UPDATE exercise_guides SET match_candidate = ? WHERE exercise_id IS NULL AND match_candidate = ? COLLATE NOCASE"
      ).run(into.name, from.name);
    } catch {
      /* an optional, re-importable guide never fails a merge */
    }

    // The strength calibration anchor is keyed by normalizedExerciseKey — a NAME, not
    // an FK — so repo/calibration.ts reads `strength_topset` under the lift's key and a
    // merged-away name strands the est-1RM confirmation the lift was anchored on.
    // UPDATE OR IGNORE because (kind, target_key, ref_id) is UNIQUE wherever ref_id is
    // set: when the same session already anchored the survivor's key, the older row
    // keeps its stale key instead of being deleted. An anchor is never destroyed to
    // make a merge tidy.
    try {
      if (fromKey && intoKey && fromKey !== intoKey) {
        db.prepare(
          "UPDATE OR IGNORE calibration_events SET target_key = ? WHERE kind = 'strength_topset' AND target_key = ?"
        ).run(intoKey, fromKey);
      }
    } catch {
      /* the calibration ledger is a downstream consequence, not merge integrity */
    }

    // The pain/tolerance memory — three references, none of them cascading. This MUST
    // run before the DELETE: the FK is ON DELETE SET NULL, so afterwards the row's link
    // to the lift is gone and unrecoverable.
    const tolerance = repointMovementToleranceOnMerge(from, into);

    // Remove the now-empty exercise row, then record the from-name → survivor alias so
    // a future log/plan of the old name self-aligns (findOrCreateExercise path (a)).
    // setExerciseAlias is an UPSERT, so only count it when it actually adds/changes a
    // mapping (an identical alias already present is not a new change — no off-by-one).
    db.prepare("DELETE FROM exercises WHERE id = ?").run(from.id);
    const priorAlias = getExerciseAlias(from.name);
    setExerciseAlias(from.name, into.name, "merge");
    const aliasRecorded = !priorAlias || priorAlias.canonical !== into.name ? 1 : 0;

    bumpTrainingDataVersion(); // the merged history re-grades lifts in program-state
    return {
      ok: true,
      moved_sets,
      moved_plan_items,
      dropped_plan_items,
      objectives,
      aliases: rewritten + aliasRecorded,
      session_skips,
      moved_observations: tolerance.moved,
      folded_observations: tolerance.folded,
    };
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
export function recentWorkingWeight(name: string, sessionsBack = 3, beforeExclusive?: string): number | null {
  // Alias-aware: "Incline DB Press" and "Incline Dumbbell Press" are one series.
  const ex = resolveExerciseName(name);
  if (ex.exercise_id == null) return null;
  const exId = ex.exercise_id;
  const cutoff = String(beforeExclusive ?? "").slice(0, 10);
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(cutoff);
  const dates = (
    dated
      ? (db.prepare(
          `SELECT DISTINCT s.date AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
            WHERE ls.exercise_id = ? AND ls.weight IS NOT NULL AND ls.weight != 0 AND s.date < ?
            ORDER BY s.date DESC LIMIT ?`
        ).all(exId, cutoff, sessionsBack) as any[])
      : (db.prepare(
          `SELECT DISTINCT s.date AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
            WHERE ls.exercise_id = ? AND ls.weight IS NOT NULL AND ls.weight != 0
            ORDER BY s.date DESC LIMIT ?`
        ).all(exId, sessionsBack) as any[])
  ).map((r) => r.d);
  if (!dates.length) return null;
  let best: number | null = null;
  for (const d of dates) {
    const sets = db.prepare(
      `SELECT ls.weight AS weight, ls.reps AS reps FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE ls.exercise_id = ? AND s.date = ? AND ls.weight IS NOT NULL AND ls.weight != 0`
    ).all(exId, d) as any[];
    // The session's hardest working set. Loaded (w>0): heavier and more reps
    // ranks higher — the Epley-shaped `w * (1 + reps/30)` read. Assisted (w<0):
    // that same multiply ranked FEWER reps higher because the weight is negative,
    // which is the opposite of "harder". Score those on `(w, reps)` so less assist
    // (closer to 0) AND more reps both rank higher.
    let topW: number | null = null;
    let bestScore = -Infinity;
    for (const s of sets) {
      const w = Number(s.weight);
      const reps = Number(s.reps) || 0;
      const score = w < 0 ? w + reps / 30 : w * (1 + reps / 30);
      if (score > bestScore) { bestScore = score; topW = w; }
    }
    // "Harder" is the larger signed value in both regimes (loaded + and assist −),
    // so a plain max picks the hardest working load they've actually handled.
    if (topW != null && (best == null || topW > best)) best = topW;
  }
  return best;
}

// True when the last few sessions of this lift were assisted or bodyweight
// (negative / 0 / null working weights) — the history recentWorkingWeight
// ignores because it only reads non-zero loaded sets. Empty history is false:
// a lift that has never been logged is not "genuinely bodyweight".
export function hasUnloadedWorkingHistory(name: string, sessionsBack = 3): boolean {
  const ex = resolveExerciseName(name);
  if (ex.exercise_id == null) return false;
  const exId = ex.exercise_id;
  const dates = (
    db
      .prepare(
        `SELECT DISTINCT s.date AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
          WHERE ls.exercise_id = ?
          ORDER BY s.date DESC LIMIT ?`
      )
      .all(exId, sessionsBack) as any[]
  ).map((r) => r.d);
  if (!dates.length) return false;
  for (const d of dates) {
    const sets = db
      .prepare(
        `SELECT ls.weight AS weight FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
          WHERE ls.exercise_id = ? AND s.date = ?`
      )
      .all(exId, d) as any[];
    if (!sets.length) return false;
    const sessionUnloaded = sets.every((s) => {
      if (s.weight == null || s.weight === "") return true;
      const n = Number(s.weight);
      return Number.isFinite(n) && n <= 0;
    });
    if (!sessionUnloaded) return false;
  }
  return true;
}

// Timed-movement twin of recentWorkingWeight. It deliberately resolves the exact
// stored exercise row before reading history: a dead-hang duration is not a safe
// anchor for a different grip/variation merely because the names share a movement
// family. The hardest completed hold across the last few sessions is the trustworthy
// baseline used when an agent proposes a new timed prescription.
export function recentWorkingSeconds(name: string, sessionsBack = 3, beforeExclusive?: string): number | null {
  const ex = resolveExerciseName(name);
  if (ex.exercise_id == null) return null;
  const exId = ex.exercise_id;
  const cutoff = String(beforeExclusive ?? "").slice(0, 10);
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(cutoff);
  const row = (
    dated
      ? db.prepare(
          `SELECT MAX(recent.best_seconds) AS best_seconds
             FROM (
               SELECT s.date, MAX(ls.duration_sec) AS best_seconds
                 FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
                WHERE ls.exercise_id = ? AND ls.duration_sec IS NOT NULL AND ls.duration_sec > 0
                  AND s.date < ?
                GROUP BY s.date
                ORDER BY s.date DESC
                LIMIT ?
             ) recent`
        ).get(exId, cutoff, sessionsBack)
      : db.prepare(
          `SELECT MAX(recent.best_seconds) AS best_seconds
             FROM (
               SELECT s.date, MAX(ls.duration_sec) AS best_seconds
                 FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
                WHERE ls.exercise_id = ? AND ls.duration_sec IS NOT NULL AND ls.duration_sec > 0
                GROUP BY s.date
                ORDER BY s.date DESC
                LIMIT ?
             ) recent`
        ).get(exId, sessionsBack)
  ) as any;
  const value = Number(row?.best_seconds);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// ---------- exercise guide ----------
export function getExerciseDetail(name: string) {
  const ex = findExercise(name);
  if (!ex) return { found: false, name };
  const recent = db
    .prepare(
      `SELECT s.date AS date, ls.weight, ls.reps, ls.rir, ls.duration_sec FROM logged_sets ls
       JOIN sessions s ON s.id = ls.session_id
       WHERE ls.exercise_id = ? ORDER BY s.date DESC, ls.id DESC LIMIT 8`
    )
    .all(ex.id);
  const appears = db
    .prepare(
      `SELECT pd.day_number, pd.name AS day_name, pi.sets, pi.rep_low, pi.rep_high, pi.target_weight, pi.note, pi.warmup_sets, pi.target_seconds
       FROM plan_items pi JOIN plan_days pd ON pd.id = pi.plan_day_id
       WHERE pi.exercise_id = ? ORDER BY pd.day_number`
    )
    .all(ex.id);
  // The instructional layer rides along on the detail the sheet already fetches —
  // one round-trip, and `null` (the ordinary state, before any import) simply means
  // the sheet renders without a "How to" section.
  const guide = getExerciseGuideByExerciseId(Number(ex.id));
  // And when nothing matched confidently, the parked candidate rides along too — the
  // sheet is the one place a human can answer the question the matcher could not.
  // Never both: a linked guide means there is nothing left to ask.
  const guide_suggestion = guide ? null : getGuideSuggestionForExercise(String(ex.name));
  return { found: true, ...ex, progress: getProgress(ex.name), recent, appears, guide, guide_suggestion };
}
