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
//      variation/assisted asymmetry is possible — but the catalog's own metadata
//      still vetoes: a pair whose `mode` differs, or whose `muscle_group` differs and
//      is stated on BOTH rows, is two movements however the names read. Those pairs
//      are SKIPPED and reported (`skipped[]`), never folded, because a merge deletes a
//      row and cannot be undone. Only a hand-curated named cluster may cross that
//      line, and today there is none.
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
import {
  expandedExerciseKey,
  listExerciseAliases,
  normalizeExerciseName,
  resolveExerciseName,
  setExerciseAlias,
} from "./exercise-canon.js";
import { mergeExercises, normalizeExerciseTitles, planExerciseRetitles } from "./exercises.js";

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
  dropped_plan_items?: number;
  moved_observations?: number;
  folded_observations?: number;
  error?: string;
}

/** A pair that shares a movement key but that the catalog's own metadata says is two. */
export interface ExerciseMergeSkip {
  from: string;
  into: string;
  reason: string;
}

export interface ExerciseDedupeResult {
  ok: true;
  dry_run: boolean;
  // Stored names whose casing the canon would change ("Dead hang" → "Dead Hang").
  // Display text only, no identity question — applied with the fold, reported before.
  retitles: Array<{ id: number; from: string; into: string }>;
  alias_repairs: ExerciseAliasRepair[];
  merges: ExerciseMergePlanRow[];
  skipped: ExerciseMergeSkip[];
  merged: number;
  aliases_repaired: number;
}

interface CatalogRow {
  id: number;
  name: string;
  mode: string | null;
  muscle_group: string | null;
  sets: number;
}

// Pairs a person has explicitly declared ONE movement despite disagreeing metadata.
// Empty on purpose: every fold this module performs is generic, and the named clusters
// this catalog once needed ("Seated Chest Press" → "Machine Chest Press", and the rest)
// were one-time corrections migration 103 already applied. Add a pair here only after
// deciding it by hand — it is the one door past the veto below, and a merge is final.
const NAMED_CLUSTERS: ReadonlyArray<{ from: string; into: string }> = [];

function namedClusterPair(a: string, b: string): boolean {
  const x = normalizeExerciseName(a);
  const y = normalizeExerciseName(b);
  return NAMED_CLUSTERS.some((pair) => {
    const f = normalizeExerciseName(pair.from);
    const t = normalizeExerciseName(pair.into);
    return (f === x && t === y) || (f === y && t === x);
  });
}

/**
 * Why a pair sharing one expanded key is still NOT folded, or null when it may be.
 *
 * A merge deletes a row and cannot be undone, so a disagreement the catalog itself
 * records outranks a name-token match. `mode` is the hard one (mergeExercises refuses
 * a timed↔reps merge regardless). `muscle_group` only vetoes when BOTH rows state one:
 * a null is missing metadata, not a disagreement, and vetoing on it would strand every
 * un-profiled duplicate forever.
 */
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

function catalogWithCounts(): CatalogRow[] {
  return (
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

/**
 * Duplicate clusters, each folded into its highest-set-count survivor — plus the pairs
 * that share a movement key and are NOT folded, with the reason, so a dry run shows
 * what it declined as well as what it would do.
 */
export function planExerciseDedupe(): {
  merges: Array<{ from: string; into: string; reason: string; sets: number }>;
  skipped: ExerciseMergeSkip[];
} {
  const clusters = new Map<string, CatalogRow[]>();
  for (const row of catalogWithCounts()) {
    const key = expandedExerciseKey(row.name);
    if (!key) continue;
    const bucket = clusters.get(key);
    if (bucket) bucket.push(row);
    else clusters.set(key, [row]);
  }
  const out: Array<{ from: string; into: string; reason: string; sets: number }> = [];
  const skipped: ExerciseMergeSkip[] = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const ordered = [...members].sort((a, b) => b.sets - a.sets || a.id - b.id);
    const survivor = ordered[0];
    for (const member of ordered.slice(1)) {
      const veto = duplicateFoldVeto(member, survivor);
      if (veto) {
        skipped.push({ from: member.name, into: survivor.name, reason: veto });
        continue;
      }
      out.push({
        from: member.name,
        into: survivor.name,
        reason: "same movement logged under two names",
        sets: member.sets,
      });
    }
  }
  const byName = (a: { from: string; into: string }, b: { from: string; into: string }) =>
    a.into.localeCompare(b.into) || a.from.localeCompare(b.from);
  return { merges: out.sort(byName), skipped: skipped.sort(byName) };
}

export function dedupeExercises(opts: { dryRun?: boolean } = {}): ExerciseDedupeResult {
  const dryRun = opts.dryRun !== false;
  const retitles = dryRun ? planExerciseRetitles() : normalizeExerciseTitles().retitled;
  const aliasRepairs = planExerciseAliasRepairs();
  const plan = planExerciseDedupe();
  const skipped = plan.skipped;
  const merges: ExerciseMergePlanRow[] = plan.merges.map((row) => ({ ...row, applied: false }));
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      retitles,
      alias_repairs: aliasRepairs,
      merges,
      skipped,
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
    row.dropped_plan_items = result.dropped_plan_items;
    row.moved_observations = result.moved_observations;
    row.folded_observations = result.folded_observations;
    merged += 1;
  }
  return {
    ok: true,
    dry_run: false,
    retitles,
    alias_repairs: aliasRepairs,
    merges,
    skipped,
    merged,
    aliases_repaired: aliasesRepaired,
  };
}
