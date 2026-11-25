// The cheap, cached READ side of the agent's exercise profile (repo/exercise-profile.ts owns
// the writes, the vocabularies and the validation).
//
// A LEAF on purpose: exercise-variations.ts, movement-region.ts and muscle-credit.ts consult it
// from inside pure classifiers, so it may import only the db, the name normalizer and the
// training-cache signals — never those three, which would close a cycle. Every consumer
// therefore checks the value it reads against ITS OWN vocabulary (a pattern against the
// MovementPattern table, a region against the region table, a group against the canonical
// taxonomy); nothing here decides what is a valid value.
//
// Only profiles an agent (or a person) was at least `medium` sure of are indexed: a `low` row is
// stored for the detail read and never applied to any answer.
//
// The index is one small table read, rebuilt only when the training-data version moved (every
// exercise write bumps it, as does a profile write), and it carries an EPOCH that moves only
// when the indexed CONTENT changed, so a memo keyed on the epoch (the muscle-credit cache)
// survives the thousands of ordinary writes that never touched a profile.
import { db } from "../db.js";
import { normalizeExerciseName } from "./exercise-canon.js";
import { currentTrainingDataVersion, registerTrainingCacheClear } from "./training-cache.js";

/** What the engine may read of a profile (already past the confidence floor). */
export interface AppliedExerciseProfile {
  pattern: string | null;
  region: string | null;
  primary_group: string | null;
  /** `[group, share]` pairs; the consumer re-validates group and share. */
  secondary: ReadonlyArray<readonly [string, number]>;
  confidence: "high" | "medium";
}

let builtAtVersion = -1;
let epoch = 0;
let signature = "";
let index = new Map<string, AppliedExerciseProfile>();

registerTrainingCacheClear(() => {
  builtAtVersion = -1;
});

function parseSecondary(raw: unknown): Array<readonly [string, number]> {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Array<readonly [string, number]> = [];
    for (const item of parsed) {
      const group = typeof item?.group === "string" ? item.group : null;
      const share = Number(item?.share);
      if (group && Number.isFinite(share)) out.push([group, share] as const);
    }
    return out;
  } catch {
    return [];
  }
}

function rebuild(): void {
  const next = new Map<string, AppliedExerciseProfile>();
  const parts: string[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT e.name AS name, p.pattern, p.region, p.primary_group, p.secondary_json, p.confidence
           FROM exercise_profile p JOIN exercises e ON e.id = p.exercise_id
          WHERE p.confidence IN ('high','medium')
          ORDER BY e.id`
      )
      .all() as Array<Record<string, any>>;
    const byLowerName = new Map<string, AppliedExerciseProfile>();
    for (const r of rows) {
      const profile: AppliedExerciseProfile = {
        pattern: r.pattern ?? null,
        region: r.region ?? null,
        primary_group: r.primary_group ?? null,
        secondary: parseSecondary(r.secondary_json),
        confidence: r.confidence === "high" ? "high" : "medium",
      };
      const name = String(r.name ?? "");
      const lower = name.trim().toLowerCase();
      if (!lower) continue;
      byLowerName.set(lower, profile);
      next.set(lower, profile);
      const norm = normalizeExerciseName(name);
      if (norm) next.set(norm, profile);
      parts.push(`${lower}|${profile.pattern}|${profile.region}|${profile.primary_group}|${JSON.stringify(profile.secondary)}|${profile.confidence}`);
    }
    if (byLowerName.size) {
      // A spelling that resolves onto a classified lift reads that lift's profile.
      const aliases = db.prepare(`SELECT alias, canonical FROM exercise_aliases`).all() as Array<{ alias: string; canonical: string }>;
      for (const a of aliases) {
        const target = byLowerName.get(String(a.canonical ?? "").trim().toLowerCase());
        const key = String(a.alias ?? "").trim().toLowerCase();
        if (target && key && !next.has(key)) next.set(key, target);
      }
    }
  } catch {
    // A missing table or a closed db reads as "no profiles", never as an error in a classifier.
    next.clear();
    parts.length = 0;
  }
  const sig = parts.join("\n");
  if (sig !== signature) {
    signature = sig;
    epoch += 1;
  }
  index = next;
}

function refresh(): void {
  const version = currentTrainingDataVersion();
  if (version === builtAtVersion) return;
  builtAtVersion = version;
  rebuild();
}

/** Moves only when the indexed profiles changed. Memos over profile-aware answers key on it. */
export function exerciseProfileEpoch(): number {
  refresh();
  return epoch;
}

/**
 * The applicable profile for a lift spelling, or null. Exact stored name first (case-folded),
 * then the normalized spelling, then an alias onto a stored name. Never throws.
 */
export function appliedProfileFor(name: string): AppliedExerciseProfile | null {
  if (typeof name !== "string" || !name) return null;
  refresh();
  if (index.size === 0) return null;
  const lower = name.trim().toLowerCase();
  return index.get(lower) ?? index.get(normalizeExerciseName(name)) ?? null;
}
