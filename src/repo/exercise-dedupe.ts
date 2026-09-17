// Exercise de-duplication as a RE-RUNNABLE pass — the catalog counterpart to
// dedupeHealthDocuments (one panel per draw date). Two repairs, in order:
//
//   1. BROKEN ALIASES. An `exercise_aliases` row whose `canonical` names no stored
//      exercise resolves to nothing — the live catalog carried "cable overhead
//      triceps extension" → "Cable Overhead Tricep Extension", a misspelling that
//      has no row, while the real lift sits under "…Triceps Extension". The alias is
//      repointed at whatever the shared resolver says that canonical IS; an alias
//      whose canonical simply has not been created yet is left alone (harmless).
//   2. DUPLICATE CLUSTERS. Exercises sharing one `expandedExerciseKey` ("DB" spelled
//      out) are one movement typed twice. They fold into the member with the most
//      logged sets (ties → the lowest id) — the same survivor rule
//      planExerciseMerges uses and the same one resolveExerciseName prefers, so a
//      fold never moves a lift somewhere a read would not already have looked.
//      `expandedExerciseKey` equality means both names carry the SAME tokens, so no
//      variation/assisted asymmetry is possible; the one remaining guard is the
//      logging mode, which mergeExercises refuses to cross anyway.
//
// A bare call only REPORTS. The fold — which deletes rows — needs an explicit
// `apply: true`, mirroring POST /api/health-docs/dedupe. Idempotent: a second pass
// finds no broken alias and no multi-member cluster, so it reports nothing to do.
//
// Migration 103 ran this same repair once, through a FROZEN snapshot
// (`src/migrations/frozen/v103-exercise-identity-repair.ts`) plus the one-time
// corrections that were specific to the catalog as it stood. This module is the
// LIVE path, free to track today's semantics — never import it from a migration.
import { db } from "../db.js";
import { expandedExerciseKey, listExerciseAliases, resolveExerciseName, setExerciseAlias } from "./exercise-canon.js";
import { mergeExercises } from "./exercises.js";

export interface ExerciseAliasRepair {
  alias: string;
  from: string;
  into: string;
}

export interface ExerciseMergePlanRow {
  from: string;
  into: string;
  reason: string;
  sets: number;
  applied: boolean;
  moved_sets?: number;
  moved_plan_items?: number;
  error?: string;
}

export interface ExerciseDedupeResult {
  ok: true;
  dry_run: boolean;
  alias_repairs: ExerciseAliasRepair[];
  merges: ExerciseMergePlanRow[];
  merged: number;
  aliases_repaired: number;
}

interface CatalogRow {
  id: number;
  name: string;
  mode: string | null;
  sets: number;
}

function catalogWithCounts(): CatalogRow[] {
  return (
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
}

/** The aliases whose canonical names no stored exercise but does resolve to one. */
export function planExerciseAliasRepairs(): ExerciseAliasRepair[] {
  const out: ExerciseAliasRepair[] = [];
  let rows: Array<{ alias: string; canonical: string }> = [];
  try {
    rows = listExerciseAliases();
  } catch {
    return out;
  }
  for (const row of rows) {
    const canonical = String(row.canonical ?? "").trim();
    if (!canonical) continue;
    const stored = db.prepare(`SELECT name FROM exercises WHERE name = ? COLLATE NOCASE LIMIT 1`).get(canonical) as any;
    if (stored) continue; // the canonical exists — nothing broken
    const resolved = resolveExerciseName(canonical);
    if (resolved.exercise_id == null) continue; // not created yet; leave it be
    // An alias whose repaired canonical equals the alias text itself is still worth
    // writing: what it replaces is a canonical that names NOTHING, and an identity
    // mapping resolves correctly where a dangling one does not.
    if (resolved.canonical === canonical) continue;
    out.push({ alias: String(row.alias), from: canonical, into: resolved.canonical });
  }
  return out;
}

/** Duplicate clusters, each folded into its highest-set-count survivor. */
export function planExerciseDedupeMerges(): Array<{ from: string; into: string; reason: string; sets: number }> {
  const clusters = new Map<string, CatalogRow[]>();
  for (const row of catalogWithCounts()) {
    const key = expandedExerciseKey(row.name);
    if (!key) continue;
    const bucket = clusters.get(key);
    if (bucket) bucket.push(row);
    else clusters.set(key, [row]);
  }
  const out: Array<{ from: string; into: string; reason: string; sets: number }> = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const ordered = [...members].sort((a, b) => b.sets - a.sets || a.id - b.id);
    const survivor = ordered[0];
    const survivorMode = survivor.mode === "timed" ? "timed" : "reps";
    for (const member of ordered.slice(1)) {
      const memberMode = member.mode === "timed" ? "timed" : "reps";
      // A timed hold and a reps lift never share one series — mergeExercises
      // refuses it, so the plan must not promise it either.
      if (memberMode !== survivorMode) continue;
      out.push({
        from: member.name,
        into: survivor.name,
        reason: "same movement logged under two names",
        sets: member.sets,
      });
    }
  }
  return out.sort((a, b) => a.into.localeCompare(b.into) || a.from.localeCompare(b.from));
}

export function dedupeExercises(opts: { dryRun?: boolean } = {}): ExerciseDedupeResult {
  const dryRun = opts.dryRun !== false;
  const aliasRepairs = planExerciseAliasRepairs();
  const plan = planExerciseDedupeMerges();
  const merges: ExerciseMergePlanRow[] = plan.map((row) => ({ ...row, applied: false }));
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      alias_repairs: aliasRepairs,
      merges,
      merged: 0,
      aliases_repaired: 0,
    };
  }
  let aliasesRepaired = 0;
  for (const repair of aliasRepairs) {
    setExerciseAlias(repair.alias, repair.into, "repair");
    aliasesRepaired += 1;
  }
  let merged = 0;
  for (const row of merges) {
    const result = mergeExercises(row.from, row.into);
    if (!result.ok) {
      row.error = result.error;
      continue;
    }
    row.applied = true;
    row.moved_sets = result.moved_sets;
    row.moved_plan_items = result.moved_plan_items;
    merged += 1;
  }
  return {
    ok: true,
    dry_run: false,
    alias_repairs: aliasRepairs,
    merges,
    merged,
    aliases_repaired: aliasesRepaired,
  };
}
