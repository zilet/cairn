// ============================================================================
// goal-proximity.ts — "is the athlete AT or NEAR the destination?"
//
// `nearGoal()` (recomposition.ts) deliberately answers false once the goal has
// been REACHED (`goal >= current`), because its display math treats 0 remaining
// as at-destination rather than as a near-goal lever. Two rules need the other
// answer — the one that says "the cut is essentially finished, so stop shrinking
// the training plan and stop asking training to pay for the food":
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
 * True when a live lose-mode goal is within `NEAR_GOAL_REMAINING_LB` — INCLUDING
 * the goal already reached or passed (remaining <= 0). Fail-soft: any read
 * problem answers false, so a missing profile can never license the softer path.
 */
export function atOrNearGoal(date = localDateISO()): boolean {
  try {
    const profile = getProfile() as any;
    if (effectiveGoalMode(profile) !== "lose") return false;
    const resolved = resolvedCurrentBodyweight(profile, date);
    const current = finite(resolved?.weight_lb ?? profile?.weight_lb);
    const goal = finite(profile?.goal_weight_lb);
    if (current == null || goal == null) return false;
    return current - goal <= NEAR_GOAL_REMAINING_LB;
  } catch {
    return false;
  }
}
