// ============================================================================
// unit-substitution.ts — the gym swap: a lift logged in place of a planned one.
//
// He walks in, the cable station is taken, and he does the machine pulldown instead of the
// lat pulldown on the card. Matched by resolved exercise identity alone, the card read the
// planned pulldown as skipped and the machine pulldown as an extra lift: a partial session,
// a shortfall in the per-lift contradiction read, and a skipped name on the outcome — for a
// session that did exactly the work it asked for, on a different variant.
//
// The second rung, after the exact match: a logged lift that is NOT on the card satisfies a
// planned slot that was NOT logged when both fall in the same MOVEMENT UNIT (the capability
// read's unit: a compound's movement pattern, an isolation lift's movement region —
// strength-capability.ts capabilityUnitOf). Rules:
//   - the exact (resolved-identity) match always wins: only slots nothing logged matched,
//     and only logged lifts no slot named, take part;
//   - a slot the athlete explicitly SKIPPED is never a target: the caller leaves it out,
//     and the skip stands;
//   - one logged lift satisfies at most one planned slot, and one slot takes at most one
//     logged lift; slots are filled in card order, each by the first logged lift (in log
//     order) of its unit;
//   - a COMPOUND slot is satisfied only by a compound of its unit: a region key can be
//     shared by a compound and an isolation lift, and an isolation lift never stands in for
//     the main work (a leg extension never satisfies a squat slot);
//   - a free-weight compound slot filled by a machine or cable compound of the same pattern
//     (a leg press for a back squat) is `machine_for_free_weight`: the movement unit was
//     trained, but less of the body and a coarser stack, so the reader keeps it apart from a
//     like-for-like swap (`like_for_like`);
//   - a lift with no unit (no pattern, no region) never substitutes for anything;
//   - it never changes the plan: it only reads the session.
// Pure over its inputs apart from the unit classification. The reader decides what a
// satisfied slot means (daily-reconciliation.ts: done by a same-movement lift, not skipped,
// its dose credited but never comparable load evidence and never an exposure of the planned
// lift, because the work was a different variant's).
// ============================================================================
import { db } from "../db.js";
import { isMobility, isPlaceholderExerciseName, resolveExerciseName } from "./exercise-canon.js";
import { liftLeadTier } from "./movement-standing.js";
import { capabilityUnitOf } from "./strength-capability.js";

export interface SubstitutionLift {
  /** The caller's identity key for the lift (the one its exact matching uses). */
  key: string;
  exercise: string;
  group: string | null;
}

/** like_for_like: the same class of lift; machine_for_free_weight: a machine/cable compound filled a free-weight compound slot. */
export type UnitSubstitutionKind = "like_for_like" | "machine_for_free_weight";

export interface UnitSubstitution {
  /** The planned slot's key and name. */
  slot_key: string;
  planned: string;
  /** The logged lift that satisfied it. */
  logged_key: string;
  logged: string;
  unit: string;
  kind: UnitSubstitutionKind;
}

/** The stored muscle group of a lift (its resolved row), else null. Fail-soft. */
export function storedGroupOf(name: string): string | null {
  try {
    const id = resolveExerciseName(String(name ?? "")).exercise_id;
    if (id == null) return null;
    const row = db.prepare(`SELECT muscle_group FROM exercises WHERE id = ?`).get(id) as any;
    return row?.muscle_group == null ? null : String(row.muscle_group);
  } catch {
    return null;
  }
}

interface LiftUnit {
  key: string;
  compound: boolean;
  /** movement-standing.ts liftLeadTier: 0/1 free-weight compound, 2 machine/cable compound, 3 accessory. */
  tier: number;
}

function unitOf(lift: SubstitutionLift): LiftUnit | null {
  const name = String(lift.exercise ?? "").trim();
  if (!name || isPlaceholderExerciseName(name) || isMobility(lift.group)) return null;
  try {
    const resolved = resolveExerciseName(name);
    const canonical = resolved.canonical || name;
    const group = lift.group ?? storedGroupOf(name);
    const unit = capabilityUnitOf(canonical, group);
    if (!unit) return null;
    return { key: unit.key, compound: unit.compound, tier: liftLeadTier(canonical, group) };
  } catch {
    return null;
  }
}

/**
 * Pair planned slots nothing logged matched with logged lifts no slot named, by movement
 * unit. `slots` in card order, `logged` in log order; both already exclude the exact
 * matches (and the slots the athlete skipped). Never more than one pairing per slot or per
 * logged lift; a compound slot only ever takes a compound.
 */
export function matchUnitSubstitutions(
  slots: readonly SubstitutionLift[],
  logged: readonly SubstitutionLift[]
): UnitSubstitution[] {
  const loggedUnits = logged.map((lift) => ({ lift, unit: unitOf(lift) }));
  const used = new Set<string>();
  const out: UnitSubstitution[] = [];
  const filled = new Set<string>();
  for (const slot of slots) {
    if (filled.has(slot.key)) continue;
    const unit = unitOf(slot);
    if (!unit) continue;
    const hit = loggedUnits.find(
      (entry) =>
        entry.unit != null &&
        entry.unit.key === unit.key &&
        (!unit.compound || entry.unit.compound) &&
        !used.has(entry.lift.key)
    );
    if (!hit || !hit.unit) continue;
    used.add(hit.lift.key);
    filled.add(slot.key);
    out.push({
      slot_key: slot.key,
      planned: slot.exercise,
      logged_key: hit.lift.key,
      logged: hit.lift.exercise,
      unit: unit.key,
      kind: unit.compound && unit.tier <= 1 && hit.unit.tier === 2 ? "machine_for_free_weight" : "like_for_like",
    });
  }
  return out;
}
