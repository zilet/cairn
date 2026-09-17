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
// cadence and the instructional guide, records the from-name as an alias, then
// deletes the now-empty `from` row. NEVER touches logged numbers. The migration
// runner already wraps each entry in BEGIN/COMMIT, so there is no savepoint here.
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
  } catch {
    /* an optional, re-importable guide never fails a merge */
  }

  db.prepare("DELETE FROM exercises WHERE id = ?").run(from.id);
  setFrozenExerciseAlias(db, from.name, into.name, "merge");
  return { ok: true, moved_sets, moved_plan_items };
}

// ---- the generic duplicate fold (snapshot of repo/exercise-dedupe.ts) -------
// Exercises sharing one expandedExerciseKey are one movement typed twice; they fold
// into the member with the most logged sets (ties → the lowest id). Equal expanded
// keys mean identical tokens, so no variation/assisted asymmetry is possible — the
// only guard left is the logging mode, which mergeExercisesFrozen refuses to cross.
export function foldDuplicateExerciseKeys(db: DatabaseSync): Array<{ from: string; into: string }> {
  const rows = (
    db
      .prepare(
        `SELECT e.id AS id, e.name AS name, e.mode AS mode, COUNT(ls.id) AS sets
           FROM exercises e LEFT JOIN logged_sets ls ON ls.exercise_id = e.id
          GROUP BY e.id`
      )
      .all() as any[]
  ).map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    mode: r.mode == null ? null : String(r.mode),
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
    const survivorMode = survivor.mode === "timed" ? "timed" : "reps";
    for (const member of ordered.slice(1)) {
      if ((member.mode === "timed" ? "timed" : "reps") !== survivorMode) continue;
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
