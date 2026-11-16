/**
 * THE SESSION'S WORKING LOAD — one definition, read by every place that asks "what
 * weight did the athlete actually work at in that session" (`recentWorkingWeight`,
 * progression's `latestTopSet`, `latestWorkingSets`). Double progression is judged AT
 * that load: the reps and RIR that decide a step are the ones taken there, never a
 * lighter set taken for more reps (a ramp-in opener) and never a heavier feeler that
 * fell short of the range.
 *
 * The working load is the HEAVIEST load at which the athlete took a set that reached the
 * rep floor — one such set is enough: athletes climb set to set, and a set inside the
 * range at the heaviest load is the work. Precisely, over the session's positive-load
 * rep sets (weight > 0, reps > 0, no seconds):
 *   1. drop warm-ups: a set under WARMUP_LOAD_FRACTION of the session's top load
 *      (outcome-comparability.ts — the one warm-up line);
 *   2. the rep floor is the prescription's `rep_low` when the reader knows it, else
 *      MIN_WORKING_REPS (3) — a single or a double is a feeler or a test, not the work;
 *   3. the working load is the heaviest load among the sets that reached the floor;
 *   4. when NO set reached it (a day where every set fell short), the working load is the
 *      UNDER_FLOOR_SETS-th (2nd) heaviest load among the sets left — the only one when
 *      one set was logged — so a lone under-floor feeler over under-floor work is still
 *      not the load.
 * So 140 × 8, 145 × 6, 145 × 5 on a 5–8 card works at 145 (not the Epley-best 140 × 8);
 * 140 × 8 ×2, 140 × 7, 155 × 1 works at 140 (the feeler is under the floor); 135 × 10,
 * 140 × 8, 140 × 6 works at 140; 57.5 × 12, 60 × 12 works at 60; a top set over back-offs
 * (145 × 8, 135 × 10 ×2) works at 145. Straight sets read their one load, as always.
 *
 * Returns null when the session has no positive-load rep set — assisted (negative),
 * bodyweight and timed work — and each reader keeps its own long-standing pick there.
 * Est-1RM (Epley on the best set of a day) is a different question and stays Epley.
 */
import { WARMUP_LOAD_FRACTION } from "./outcome-comparability.js";

/** With no rep range known, a set under this many reps is a feeler, not a working set. */
export const MIN_WORKING_REPS = 3;
/** When no set reached the floor, how many sets must carry a load for it to be the work. */
export const UNDER_FLOOR_SETS = 2;

export interface WorkingLoadSet {
  weight: number | null | undefined;
  reps: number | null | undefined;
  duration_sec?: number | null | undefined;
}

/** A positive-load rep set: the only kind the working-load rule reads. */
export function isLoadedRepSet(set: WorkingLoadSet): boolean {
  const w = Number(set.weight);
  const reps = Number(set.reps);
  return (
    set.weight != null &&
    Number.isFinite(w) &&
    w > 0 &&
    set.reps != null &&
    Number.isFinite(reps) &&
    reps > 0 &&
    set.duration_sec == null
  );
}

/** Pure: the session's working load (see the module comment), or null when it has none. */
export function sessionWorkingLoad(sets: readonly WorkingLoadSet[], repLow?: number | null): number | null {
  const loaded = sets.filter(isLoadedRepSet);
  if (!loaded.length) return null;
  const top = Math.max(...loaded.map((s) => Number(s.weight)));
  const working = loaded.filter((s) => Number(s.weight) >= top * WARMUP_LOAD_FRACTION);
  const floor =
    repLow != null && Number.isFinite(Number(repLow)) && Number(repLow) > 0 ? Number(repLow) : MIN_WORKING_REPS;
  const atFloor = working.filter((s) => Number(s.reps) >= floor);
  if (atFloor.length) return Math.max(...atFloor.map((s) => Number(s.weight)));
  const loads = working.map((s) => Number(s.weight)).sort((a, b) => b - a);
  return loads[Math.min(UNDER_FLOOR_SETS, loads.length) - 1] ?? null;
}

/** Is this set taken AT the working load (the sets double progression reads)? */
export function atWorkingLoad(set: WorkingLoadSet, load: number): boolean {
  return isLoadedRepSet(set) && Math.abs(Number(set.weight) - load) < 0.05;
}
