// Same-pattern suggestions, held to the catalog's idea of WHICH LIFT a name is.
//
// exercise-variations.ts is a pure table with no database, so it can only tell two
// names apart by their letters: asked for alternatives to the stored "Dumbbell Biceps
// Curl" it offered "DB Bicep Curl" — the same lift in another spelling — and nothing
// downstream could tell a rotation from a rename. Every suggestion list a person or a
// prompt reads goes through here instead, which, for each candidate:
//   • drops it when it is the input's own lift (sameLiftName: one stored row, or one
//     movement key when neither is stored),
//   • drops it when it is the same lift as an `excludeNames` entry,
//   • names it by its stored spelling when it resolves to a stored row, so whatever
//     the list feeds (a swap, a prompt) speaks the catalog's name,
//   • keeps only the first of several candidates that are one lift.
// A candidate that resolves to nothing passes as written. The table's own filters and
// ranking run first and are unchanged; the list is asked for wide and cut to `limit`
// after the identity pass, so a dropped alias never shortens it.
import {
  normalizedExerciseKey,
  resolveExerciseName,
  type ResolvedExerciseName,
} from "./exercise-canon.js";
import { type ExerciseVariation, suggestAlternatives, suggestVariations } from "./exercise-variations.js";

type AlternativesOpts = NonNullable<Parameters<typeof suggestAlternatives>[1]>;

// Wide enough to cover any one pattern's curated list.
const CANDIDATE_POOL = 64;

interface Identity {
  lower: string;
  norm: string;
  resolved: ResolvedExerciseName;
}

function identityReader(): (name: string) => Identity {
  const cache = new Map<string, Identity>();
  return (name: string) => {
    const text = String(name ?? "").trim();
    const lower = text.toLowerCase();
    let hit = cache.get(lower);
    if (!hit) {
      hit = { lower, norm: normalizedExerciseKey(text), resolved: resolveExerciseName(text) };
      cache.set(lower, hit);
    }
    return hit;
  };
}

// The sameLiftName test over identities read once per name (a list can compare every
// candidate against every planned lift).
function sameLift(a: Identity, b: Identity): boolean {
  if (!a.lower || !b.lower) return false;
  if (a.lower === b.lower) return true;
  if (a.resolved.key && a.resolved.key === b.resolved.key) return true;
  return !!a.norm && a.norm === b.norm;
}

function identityPass(
  input: string,
  candidates: ExerciseVariation[],
  excludeNames: readonly string[],
  limit: number
): ExerciseVariation[] {
  const identity = identityReader();
  const own = identity(input);
  const excluded = excludeNames.map((name) => String(name ?? "").trim()).filter(Boolean).map(identity);
  const kept: Identity[] = [];
  const out: ExerciseVariation[] = [];
  for (const candidate of candidates) {
    const id = identity(candidate.name);
    if (!id.lower || sameLift(id, own)) continue;
    if (excluded.some((entry) => sameLift(id, entry))) continue;
    if (kept.some((entry) => sameLift(id, entry))) continue;
    kept.push(id);
    const stored = id.resolved.exercise_id != null && id.resolved.canonical ? id.resolved.canonical : candidate.name;
    out.push(stored === candidate.name ? candidate : { ...candidate, name: stored });
    if (out.length >= limit) break;
  }
  return out;
}

/** suggestAlternatives, with the input's own lift, excluded lifts and duplicate spellings removed. */
export function liftAlternatives(exerciseName: string, opts: AlternativesOpts = {}): ExerciseVariation[] {
  const limit = opts.limit ?? 5;
  const pool = suggestAlternatives(exerciseName, { ...opts, limit: Math.max(limit, CANDIDATE_POOL) });
  return identityPass(exerciseName, pool, opts.excludeNames ?? [], limit);
}

/** suggestVariations, with the input's own lift and duplicate spellings removed. */
export function liftVariations(exerciseName: string, opts: { limit?: number } = {}): ExerciseVariation[] {
  const limit = opts.limit ?? 5;
  const pool = suggestVariations(exerciseName, { limit: Math.max(limit, CANDIDATE_POOL) });
  return identityPass(exerciseName, pool, [], limit);
}
