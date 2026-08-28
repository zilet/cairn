// ============================================================================
// goal-proximity.ts — "is the athlete AT or NEAR the destination?"
//
// This is the ONE date-aware reader of that question. (recomposition.ts used to
// carry a second one, `nearGoal`, which answered false once the goal had been
// REACHED — its display math treated 0 remaining as at-destination rather than as a
// near-goal lever. It has been removed: two answers to one question is how a caller
// silently picks the wrong one. `isNearGoal` there is still the pure remaining math.)
// The rules that need this answer — "the cut is essentially finished, so stop
// shrinking the training plan and stop asking training to pay for the food":
//
//   1. applyFuelProtection (progression.ts): a fuel `reduce` at/near goal keeps
//      the prescribed sets and load; only the near-maximal single comes off.
//   2. underfuelingRead (underfueling.ts): `persistent_strain` at/near goal
//      asks for FOOD, never a lighter training dose.
//
// This is a LEAF on purpose: it reads the profile, the resolved bodyweight and
// the shared near-goal band, and nothing that reads fuel — so both callers can
// import it without pulling the recomposition read (which itself consumes the
// underfueling read) into their cycle.
// ============================================================================
import { resolvedCurrentBodyweight } from "./bodyweight.js";
import { effectiveGoalMode, getProfile } from "./profile.js";
import { NEAR_GOAL_REMAINING_LB } from "./recomposition-stage.js";
import { localDateISO } from "./shared.js";

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * How far BELOW a lose-mode goal the athlete may sit and still be read as "at the
 * destination". Passing a goal by a pound or two is finishing it; sitting five-plus
 * pounds under one is a goal nobody updated — the athlete has moved on, and a stale
 * number must not keep licensing the softer path forever. Past this band the strict
 * reading resumes (a `reduce` fuel read may veto again), which is the same answer a
 * goal-less profile gets.
 */
export const STALE_GOAL_OVERSHOOT_LB = 5;

/**
 * True when a live lose-mode goal is within `NEAR_GOAL_REMAINING_LB` — INCLUDING
 * the goal already reached, or passed by up to `STALE_GOAL_OVERSHOOT_LB`. Fail-soft:
 * any read problem answers false, so a missing profile can never license the softer
 * path.
 */
export function atOrNearGoal(date = localDateISO()): boolean {
  try {
    const profile = getProfile() as any;
    if (effectiveGoalMode(profile) !== "lose") return false;
    const resolved = resolvedCurrentBodyweight(profile, date);
    const current = finite(resolved?.weight_lb ?? profile?.weight_lb);
    const goal = finite(profile?.goal_weight_lb);
    if (current == null || goal == null) return false;
    const remaining = current - goal;
    // Bounded on BOTH sides: near the destination from above, and no further than a
    // small overshoot below it. Unbounded below, an athlete who kept losing past a
    // goal they never revised would have the strict fuel path permanently disabled.
    return remaining <= NEAR_GOAL_REMAINING_LB && remaining >= -STALE_GOAL_OVERSHOOT_LB;
  } catch {
    return false;
  }
}
