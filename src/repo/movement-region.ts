import { pressSlotKey } from "./plan-quality.js";

// Which movement REGION an exercise occupies on one card: two items in the same region
// are the same stimulus twice (flat dumbbell bench then flat barbell bench), so a
// composed session keeps one of them (composition-pairing.ts `collapseRegionDuplicates`).
// A region is narrower than a movement pattern — flat and incline press are different
// regions, and so are a straight-leg and a bent-knee calf raise.
//
// Contract: a pure function of the name (and, when known, the stored muscle group).
// `null` means "no region rule applies" — never "unknown, drop it". The big compounds
// (squat, hinge, row) have no region: a squat and a leg press both stay on a card.
//
// Today it answers only the horizontal-press angles, exactly as `pressSlotKey` always
// has (flat / incline / decline); the other regions (vertical press, dip, knee
// extension and flexion, calf straight/bent, curl grip, triceps overhead/pushdown,
// lateral raise, rear delt) land with the pairing package.
export function movementRegionKey(name: string, _group?: string | null): string | null {
  return pressSlotKey(name);
}
