// Frozen snapshot of the exercise-identity repair as of 2026-09-17; migrations must
// not track live code.
//
// WHY A COPY AND NOT AN IMPORT. A migration is a statement about what the ladder did
// on the day it shipped. Importing the live modules (repo/exercise-canon.ts,
// repo/exercises.ts#mergeExercises, repo/exercise-dedupe.ts) means a fresh install
// replays this migration against TODAY's semantics — a silently different repair from
// the one every existing database received. The live modules stay free to evolve;
// this snapshot does not. Do not "fix" a bug here: fix it in the live module and, if
// old rows need it, append a NEW migration.
//
// DO NOT REFORMAT. This file is a verbatim-in-spirit copy of the live name keying and
// merge write; a formatter reflowing it would break the one property that makes it
// auditable — that every line still matches the source it was taken from.
import type { DatabaseSync } from "node:sqlite";

// ---- name normalization (snapshot of repo/exercise-canon.ts) ----------------
export function normalizeExerciseName(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function foldPluralToken(t: string): string {
  return t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;
}

const NON_DISTINGUISHING = new Set(["timed"]);

export function normalizedExerciseKey(name: string): string {
  const tokens = normalizeExerciseName(name).split(" ").filter(Boolean);
  const kept = tokens.filter((t) => !NON_DISTINGUISHING.has(t)).map(foldPluralToken);
  return (kept.length ? kept : tokens.map(foldPluralToken)).join(" ");
}

const EXERCISE_ABBREVIATIONS: Record<string, string> = {
  db: "dumbbell",
  dbs: "dumbbell",
  bb: "barbell",
  kb: "kettlebell",
  kbs: "kettlebell",
  ohp: "overhead press",
  rdl: "romanian deadlift",
  bw: "bodyweight",
};

export function expandExerciseAbbreviations(name: string): string {
  const tokens = normalizeExerciseName(name).split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const expansion = EXERCISE_ABBREVIATIONS[tokens[i]];
    if (expansion) {
      const parts = expansion.split(" ").filter(Boolean);
      out.push(...parts);
      while (i + 1 < tokens.length && parts.includes(tokens[i + 1])) i += 1;
    } else {
      out.push(tokens[i]);
    }
  }
  return out.join(" ");
}

export function expandedExerciseKey(name: string): string {
  return normalizedExerciseKey(expandExerciseAbbreviations(name));
}

// ---- the merge write (snapshot of repo/exercises.ts#mergeExercises) ---------
// Re-points logged_sets + plan_items, carries the anchor-lift objective, learned
// aliases and one-session skips onto the survivor, remaps the strength re-test
// cadence, the instructional guide and its pending suggestion, the strength
// calibration anchor and the pain/tolerance evidence, records the from-name as an
// alias, then deletes the now-empty `from` row. EVERY reference moves BEFORE the
// DELETE: the two foreign keys are ON DELETE SET NULL and the rest are names or
// derived keys, so a reference left behind is not a crash — it is evidence that
// quietly stops existing. NEVER touches logged numbers. The migration runner already
// wraps each entry in BEGIN/COMMIT, so there is no savepoint here.
function strengthSignalKey(name: string): string {
  const slug = normalizedExerciseKey(name || "benchmark").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "benchmark";
  return `training:strength:${slug}`;
}

function findExerciseRow(db: DatabaseSync, name: string): { id: number; name: string; mode: string | null } | null {
  const row = db.prepare(`SELECT id, name, mode FROM exercises WHERE name = ? COLLATE NOCASE LIMIT 1`).get(name) as any;
  return row ? { id: Number(row.id), name: String(row.name), mode: row.mode == null ? null : String(row.mode) } : null;
}

export function setFrozenExerciseAlias(db: DatabaseSync, alias: string, canonical: string, source: string): void {
  const a = normalizeExerciseName(alias);
  const c = String(canonical ?? "").replace(/\s+/g, " ").trim();
  if (!a || !c) return;
  try {
    db.prepare(
      `INSERT INTO exercise_aliases (alias, canonical, source) VALUES (?, ?, ?)
         ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical, source = excluded.source`
    ).run(a, c, source);
  } catch {
    /* an optional alias store never fails the repair */
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  try {
    return !!db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`).get(name);
  } catch {
    return false;
  }
}

// The two movement-key spellings movement_tolerance_observations persists (snapshot of
// the shape repo/training-symptoms.ts writes and repo/pain-band.ts + repo/movement-risk.ts
// read back): `exercise:<id>` once a reported movement resolved to a catalog row, and
// `movement:<name-slug>` when it did not.
function toleranceMovementSlug(name: string): string {
  return `movement:${String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

// A merged lift and its survivor on the SAME plan day are one slot, not two. plan_items
// carries no unique index on (plan_day_id, exercise_id), so re-pointing a day that
// already prescribed the survivor would leave the athlete two cards for one movement.
// THE SURVIVOR'S OWN ITEM IS KEPT (its position, superset pairing and note stay as
// programmed) and the re-pointed duplicate is dropped; the duplicate hands over only a
// prescription the survivor is MISSING — target_weight/target_seconds where the
// survivor's is NULL. `sets` is NOT NULL, so it always holds a value and never carries.
function foldPlanDayDuplicatesFrozen(
  db: DatabaseSync,
  from: { id: number },
  into: { id: number }
): void {
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
    .all(into.id, from.id) as any[];
  for (const row of duplicates) {
    if (row.keep_id == null) continue;
    db.prepare(
      `UPDATE plan_items
          SET target_weight = COALESCE(target_weight, ?), target_seconds = COALESCE(target_seconds, ?)
        WHERE id = ?`
    ).run(row.from_weight ?? null, row.from_seconds ?? null, Number(row.keep_id));
    db.prepare(`DELETE FROM plan_items WHERE id = ?`).run(Number(row.from_id));
  }
}

// Carry a symptom watch's movement evidence onto the survivor. The table names the
// lift three ways — the FK `exercise_id` (ON DELETE SET NULL), the `movement_key` it is
// READ by, and the display `movement_name` — and none of them cascades, so a row left
// behind holds `exercise:<a deleted id>` while every reader asks for the survivor's id
// or name slug: still stored, permanently invisible. Both unique exposure indexes key
// on (event, session, movement_key, day, outcome, epoch), so a re-point can collide
// with a row the survivor already owns; the SURVIVOR's row is kept and the loser's
// strength folded into it first ('stated' outranks 'inferred', relevant=1 outranks 0)
// before the duplicate is dropped.
function repointMovementToleranceFrozen(
  db: DatabaseSync,
  from: { id: number; name: string },
  into: { id: number; name: string }
): void {
  if (!tableExists(db, "movement_tolerance_observations")) return;
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
    .all(fromExerciseKey, fromSlug, from.id) as any[];
  const twin = db.prepare(
    `SELECT id, evidence, relevant FROM movement_tolerance_observations
      WHERE symptom_event_id = ? AND IFNULL(session_id, -1) = IFNULL(?, -1) AND movement_key = ?
        AND observed_on = ? AND outcome = ? AND evidence_epoch = ? LIMIT 1`
  );
  for (const row of rows) {
    const key = String(row.movement_key);
    const target = key === fromExerciseKey ? intoExerciseKey : key === fromSlug ? intoSlug : null;
    if (target == null || target === key) {
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
    ) as any;
    if (existing) {
      const evidence = String(row.evidence) === "stated" || String(existing.evidence) === "stated" ? "stated" : "inferred";
      const relevant = Number(row.relevant) === 1 || Number(existing.relevant) === 1 ? 1 : 0;
      db.prepare(
        "UPDATE movement_tolerance_observations SET exercise_id = ?, movement_name = ?, evidence = ?, relevant = ? WHERE id = ?"
      ).run(into.id, into.name, evidence, relevant, Number(existing.id));
      db.prepare("DELETE FROM movement_tolerance_observations WHERE id = ?").run(Number(row.id));
      continue;
    }
    db.prepare(
      "UPDATE movement_tolerance_observations SET exercise_id = ?, movement_key = ?, movement_name = ? WHERE id = ?"
    ).run(into.id, target, into.name, Number(row.id));
  }
}

export function mergeExercisesFrozen(
  db: DatabaseSync,
  fromName: string,
  intoName: string
): { ok: boolean; moved_sets: number; moved_plan_items: number; error?: string } {
  const empty = { moved_sets: 0, moved_plan_items: 0 };
  const into = findExerciseRow(db, intoName);
  if (!into) return { ok: false, ...empty, error: `target exercise "${intoName}" not found` };
  const from = findExerciseRow(db, fromName);
  if (!from) return { ok: true, ...empty }; // already gone — idempotent
  if (from.id === into.id) return { ok: true, ...empty };

  const fromMode = from.mode === "timed" ? "timed" : "reps";
  const intoMode = into.mode === "timed" ? "timed" : "reps";
  if (fromMode !== intoMode) {
    return { ok: false, ...empty, error: "cannot merge a timed movement with a reps movement" };
  }

  const moved_sets = Number(
    db.prepare("UPDATE logged_sets SET exercise_id = ? WHERE exercise_id = ?").run(into.id, from.id).changes
  );
  // Fold FIRST, re-point what is left: a day that already prescribes the survivor must
  // not end up holding the same movement twice.
  try {
    foldPlanDayDuplicatesFrozen(db, from, into);
  } catch {
    /* a fixture without target_seconds keeps the re-point; a duplicate slot is visible, not lost */
  }
  const moved_plan_items = Number(
    db.prepare("UPDATE plan_items SET exercise_id = ? WHERE exercise_id = ?").run(into.id, from.id).changes
  );

  const intoKey = normalizedExerciseKey(into.name);
  const fromKey = normalizedExerciseKey(from.name);
  try {
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
    db.prepare(
      "UPDATE strength_objectives SET exercise = ?, exercise_key = ? WHERE exercise_key = ? OR exercise = ? COLLATE NOCASE"
    ).run(into.name, intoKey, fromKey, from.name);
  } catch {
    /* an anchor-lift journey is a downstream consequence, not merge integrity */
  }

  try {
    db.prepare("UPDATE exercise_aliases SET canonical = ? WHERE canonical = ? COLLATE NOCASE").run(into.name, from.name);
  } catch {
    /* no alias store yet */
  }
  try {
    db.prepare("UPDATE OR IGNORE session_skips SET exercise = ? WHERE exercise = ? COLLATE NOCASE").run(
      into.name,
      from.name
    );
  } catch {
    /* skips are per-session ephemera */
  }

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

  try {
    const survivorHasGuide = db
      .prepare(`SELECT 1 AS present FROM exercise_guides WHERE exercise_id = ? LIMIT 1`)
      .get(into.id) as any;
    if (survivorHasGuide) {
      db.prepare(`UPDATE exercise_guides SET exercise_id = NULL, match_confidence = NULL WHERE exercise_id = ?`).run(
        from.id
      );
    } else {
      db.prepare(`UPDATE exercise_guides SET exercise_id = ? WHERE exercise_id = ?`).run(into.id, from.id);
    }
    // An unlinked guide SUGGESTION names its candidate exercise in TEXT, so the pending
    // yes/no follows the survivor rather than becoming unanswerable.
    db.prepare(
      `UPDATE exercise_guides SET match_candidate = ? WHERE exercise_id IS NULL AND match_candidate = ? COLLATE NOCASE`
    ).run(into.name, from.name);
  } catch {
    /* an optional, re-importable guide never fails a merge */
  }

  // The strength calibration anchor is keyed by normalizedExerciseKey — a NAME, not an
  // FK — so a merged-away name strands the est-1RM confirmation the lift was anchored
  // on. UPDATE OR IGNORE: (kind, target_key, ref_id) is UNIQUE wherever ref_id is set,
  // and a colliding row keeps its stale key rather than being deleted.
  try {
    if (fromKey && intoKey && fromKey !== intoKey) {
      db.prepare(
        `UPDATE OR IGNORE calibration_events SET target_key = ? WHERE kind = 'strength_topset' AND target_key = ?`
      ).run(intoKey, fromKey);
    }
  } catch {
    /* the calibration ledger is a downstream consequence, not merge integrity */
  }

  // The pain/tolerance memory, BEFORE the delete: the FK is ON DELETE SET NULL, so
  // afterwards the row's link to the lift is gone and unrecoverable.
  repointMovementToleranceFrozen(db, from, into);

  db.prepare("DELETE FROM exercises WHERE id = ?").run(from.id);
  setFrozenExerciseAlias(db, from.name, into.name, "merge");
  return { ok: true, moved_sets, moved_plan_items };
}

// ---- the generic duplicate fold (snapshot of repo/exercise-dedupe.ts) -------
// Exercises sharing one expandedExerciseKey are one movement typed twice; they fold
// into the member with the most logged sets (ties → the lowest id). Equal expanded
// keys mean identical tokens, so no variation/assisted asymmetry is possible.
//
// STORED METADATA STILL VETOES. A merge deletes a row and cannot be undone, so the
// generic pass refuses any pair the catalog itself says is two movements: a differing
// `mode` (a timed hold and a reps lift never share one series — mergeExercisesFrozen
// refuses it anyway) or a differing `muscle_group` where BOTH are non-null (one null
// is missing metadata, not a disagreement). Only the hand-curated NAMED_MERGES below
// may cross that line, because a person decided those pairs one at a time.
function namedClusterPair(a: string, b: string): boolean {
  const x = normalizeExerciseName(a);
  const y = normalizeExerciseName(b);
  return NAMED_MERGES.some((step) => {
    const f = normalizeExerciseName(step.from);
    const t = normalizeExerciseName(step.into);
    return (f === x && t === y) || (f === y && t === x);
  });
}

// Why a pair sharing one expanded key is still NOT folded, or null when it may be.
export function duplicateFoldVeto(
  a: { name: string; mode: string | null; muscle_group: string | null },
  b: { name: string; mode: string | null; muscle_group: string | null }
): string | null {
  if (namedClusterPair(a.name, b.name)) return null;
  if ((a.mode === "timed" ? "timed" : "reps") !== (b.mode === "timed" ? "timed" : "reps")) {
    return "one is timed and one is reps — they never share a series";
  }
  if (a.muscle_group && b.muscle_group && a.muscle_group !== b.muscle_group) {
    return `the catalog files them under different muscle groups (${a.muscle_group} / ${b.muscle_group})`;
  }
  return null;
}

export function foldDuplicateExerciseKeys(db: DatabaseSync): Array<{ from: string; into: string }> {
  const rows = (
    db
      .prepare(
        `SELECT e.id AS id, e.name AS name, e.mode AS mode, e.muscle_group AS muscle_group, COUNT(ls.id) AS sets
           FROM exercises e LEFT JOIN logged_sets ls ON ls.exercise_id = e.id
          GROUP BY e.id`
      )
      .all() as any[]
  ).map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    mode: r.mode == null ? null : String(r.mode),
    muscle_group: r.muscle_group == null ? null : String(r.muscle_group),
    sets: Number(r.sets) || 0,
  }));
  const clusters = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = expandedExerciseKey(row.name);
    if (!key) continue;
    const bucket = clusters.get(key);
    if (bucket) bucket.push(row);
    else clusters.set(key, [row]);
  }
  const done: Array<{ from: string; into: string }> = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const ordered = [...members].sort((a, b) => b.sets - a.sets || a.id - b.id);
    const survivor = ordered[0];
    for (const member of ordered.slice(1)) {
      if (duplicateFoldVeto(member, survivor)) continue;
      const result = mergeExercisesFrozen(db, member.name, survivor.name);
      if (result.ok) done.push({ from: member.name, into: survivor.name });
    }
  }
  return done;
}

// ---- the one-time corrections this catalog needed ---------------------------
// Named clusters the generic fold cannot reach (their keys genuinely differ), plus
// the metadata a wrong row carried. Every step is idempotent: a merge whose `from`
// is already gone is a no-op, and each UPDATE is guarded on the value it replaces.
//
// DELIBERATELY NOT MERGED, and why:
//   * "Hammer Curl" (dumbbell) stays separate from "Rope Hammer Curl" — a rope on a
//     cable is not a dumbbell in each hand.
//   * The three triceps pushdowns (rope / straight-bar cable / triangular bar) are
//     three implements, three lifts.
//   * "Row" and "Dumbbell Row" are left apart: "Row" is too generic to prove which
//     movement it recorded, and a merge cannot be undone.
//   * "Unknown" (a Garmin import that mapped to no movement) keeps its own row —
//     folding it anywhere would put sets on a lift that was not performed.
const NAMED_MERGES: Array<{ from: string; into: string }> = [
  // The chest-press station, typed three ways. The survivor keeps the name the two
  // existing alias rows already point at.
  { from: "Bench press machine", into: "Machine Chest Press" },
  { from: "Seated machine chest press", into: "Machine Chest Press" },
  { from: "Seated Chest Press", into: "Machine Chest Press" },
  // A cable rope hammer curl IS a rope hammer curl.
  { from: "Cable Rope Hammer Curl", into: "Rope Hammer Curl" },
  // The single-arm row, already aliased but never folded.
  { from: "Single-Arm Dumbbell Pull", into: "Single-Arm Dumbbell Row" },
];

export function repairExerciseIdentity(db: DatabaseSync): {
  aliases_repaired: number;
  merged: number;
  mode_fixed: number;
  metadata_fixed: number;
} {
  let aliases_repaired = 0;
  let merged = 0;
  let mode_fixed = 0;
  let metadata_fixed = 0;

  // (a) Aliases whose canonical names no stored exercise. Repoint them at the row
  //     that canonical KEYS to ("Cable Overhead Tricep Extension" → the stored
  //     "Cable Overhead Triceps Extension"); leave one that resolves to nothing.
  try {
    const aliases = db.prepare(`SELECT alias, canonical FROM exercise_aliases`).all() as Array<{
      alias: string;
      canonical: string;
    }>;
    const catalog = (db.prepare(`SELECT id, name FROM exercises`).all() as any[]).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
    }));
    for (const row of aliases) {
      const canonical = String(row.canonical ?? "").trim();
      if (!canonical) continue;
      if (findExerciseRow(db, canonical)) continue;
      const key = normalizedExerciseKey(canonical);
      const hit =
        catalog.find((e) => normalizedExerciseKey(e.name) === key) ??
        catalog.find((e) => expandedExerciseKey(e.name) === expandedExerciseKey(canonical));
      if (!hit) continue;
      // An alias whose repaired canonical equals the alias text itself is still worth
      // writing: what it replaces is a canonical that names NOTHING (the live row
      // pointed at a misspelling), and an identity mapping resolves correctly.
      if (hit.name === canonical) continue;
      db.prepare(`UPDATE exercise_aliases SET canonical = ? WHERE alias = ?`).run(hit.name, String(row.alias));
      aliases_repaired += 1;
    }
  } catch {
    /* no alias store yet — nothing to repair */
  }

  // (b) The named clusters. A survivor that does not exist yet is created from the
  //     first member's row so the merge has somewhere to land.
  for (const step of NAMED_MERGES) {
    try {
      const from = findExerciseRow(db, step.from);
      if (!from) continue; // already folded, or never existed here
      if (!findExerciseRow(db, step.into)) {
        db.prepare(`UPDATE exercises SET name = ? WHERE id = ?`).run(step.into, from.id);
        setFrozenExerciseAlias(db, step.from, step.into, "merge");
        merged += 1;
        continue;
      }
      const result = mergeExercisesFrozen(db, step.from, step.into);
      if (result.ok) merged += 1;
    } catch {
      /* one unmergeable pair never blocks the rest of the repair */
    }
  }

  // (c) A pull-up logged as a TIMED movement: pull-ups are counted in reps, and a
  //     timed row keeps its whole history out of the reps series.
  try {
    mode_fixed = Number(
      db.prepare(`UPDATE exercises SET mode = 'reps' WHERE name = 'Pull Up' COLLATE NOCASE AND mode = 'timed'`).run()
        .changes
    );
  } catch {
    /* a missing row is the ordinary case on a fresh install */
  }

  // (d) Muscle groups that name the wrong region. A horizontal pull and a pull-up are
  //     both back-dominant; the stored values said "chest" and "forearms", which is
  //     what every volume and per-muscle recovery read then believed.
  //
  //     Garmin FIT categories: "Seated leg press - machine" carried SHOULDER_PRESS,
  //     which is a different body half. The catalog's leg press is SQUAT/LEG_PRESS
  //     (src/repo/garmin-exercise-map.ts + garmin-exercise-catalog.json) — never an
  //     invented enum. NOT changed, because the FIT profile really does file them
  //     this way: "Leg Extension" under CRUNCH (CRUNCH/LEG_EXTENSIONS) and a chest
  //     dip under TRICEPS_EXTENSION (there is no DIP or CHEST_DIP category).
  const metadata: Array<{ sql: string; args: unknown[] }> = [
    {
      sql: `UPDATE exercises SET muscle_group = 'back' WHERE name = 'Chest-Supported Row' COLLATE NOCASE AND muscle_group = 'chest'`,
      args: [],
    },
    {
      sql: `UPDATE exercises SET muscle_group = 'back' WHERE name = 'Neutral-Grip Pull-Up' COLLATE NOCASE AND muscle_group = 'forearms'`,
      args: [],
    },
    {
      sql: `UPDATE exercises SET garmin_category = 'SQUAT', garmin_exercise = 'LEG_PRESS', garmin_map_status = 'mapped'
             WHERE name = 'Seated leg press - machine' COLLATE NOCASE AND garmin_category = 'SHOULDER_PRESS'`,
      args: [],
    },
  ];
  for (const step of metadata) {
    try {
      metadata_fixed += Number(db.prepare(step.sql).run(...(step.args as any[])).changes);
    } catch {
      /* a column or row that does not exist here needs no correction */
    }
  }

  // (e) The generic pass, last: whatever still shares one expanded key.
  try {
    merged += foldDuplicateExerciseKeys(db).length;
  } catch {
    /* the named repairs stand even if the generic fold cannot run */
  }

  return { aliases_repaired, merged, mode_fixed, metadata_fixed };
}
