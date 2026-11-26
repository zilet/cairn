// ============================================================================
// composition-eve.ts — how the STANDING key-run eve lands on today's card.
//
// The stress budget (stress-budget.ts, rule 3b) decides the eve outside a race build:
// tomorrow's placed quality or long run, lower ACCESSORIES only, sets only, load held. It
// names the items it trims (`trim_exercises`), so the trim is ITEM-scoped: a leg curl
// loses its set while the RDL beside it in the hamstrings stays whole. Composition
// (daily-composition.ts) applies it with the two helpers below:
//   - `standingEveTrimKeys` — the named items as exercise keys, or null when the envelope
//     carries no standing eve (the in-build eve keeps its group-level reduced-area clamp,
//     exactly as before);
//   - `standingEveSetCap` — ONE set off: max(STANDING_EVE_MIN_SETS, sets − 1). The
//     reduced-area cap (two sets) would take a four-set accessory to two; the eve's brief
//     is one set, the smallest change that still lowers the leg dose going into the run.
//
// Evidence: concurrent-training interference is driven by proximity and volume of the
// lower-body work before a key run; one fewer accessory set at the same load is the
// conservative step (practice-based, the evidence for any exact set count is weak).
// ============================================================================
import { normalizedExerciseKey } from "./exercise-canon.js";

/**
 * The fewest working sets a standing-eve trim leaves on an accessory: the plan-day
 * budget's accessory floor (daily-composition.ts PLAN_DAY_BUDGET_POLICY.accessory_min_sets),
 * restated here so this helper stays a leaf.
 */
export const STANDING_EVE_MIN_SETS = 1;
/** The standing eve takes exactly this many sets off each accessory it names. */
export const STANDING_EVE_SETS_OFF = 1;

/** One set off, never under the floor; a lift already at the floor keeps what it has. */
export function standingEveSetCap(sets: number): number {
  const n = Math.max(1, Math.trunc(Number(sets) || 1));
  return Math.max(Math.min(n, STANDING_EVE_MIN_SETS), n - STANDING_EVE_SETS_OFF);
}

/**
 * The exercise keys the standing eve trims, or null when the envelope carries no standing
 * eve (no stress slice, an in-build eve, a load-easing rule). An empty set is still a
 * standing eve: every item in its groups is then passed over.
 */
export function standingEveTrimKeys(
  stress: { load_held?: unknown; scope?: unknown; trim_exercises?: unknown } | null | undefined
): Set<string> | null {
  if (!stress || stress.load_held !== true || stress.scope !== "standing") return null;
  const names = Array.isArray(stress.trim_exercises) ? stress.trim_exercises : [];
  return new Set(names.map((name) => normalizedExerciseKey(String(name ?? ""))).filter(Boolean));
}
