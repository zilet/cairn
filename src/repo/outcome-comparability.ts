// Per-lift dose comparability — db-free so migrate.ts and the runtime share
// one transform. db.ts statically imports migrate.ts, so this file must never
// import the database (same reason proposal-provenance-clamp.ts exists).
//
// WORK DONE IS EVIDENCE. A prescription is a suggestion; the log is the truth.
// A dose performed at or above the athlete's full working load is comparable
// evidence no matter what the morning read suggested. Calendar counts never
// produce a brake on their own. Safety floors (illness, a relevant symptom)
// keep full authority.

export const NEVER_BLOCKS_A_LIFT = new Set([
  "athlete_override",
  "endurance_quality_not_observed",
  "endurance_quality_unverified",
]);

// Inside a real recovery/travel window, full-load work still counts. Illness
// and a movement-relevant symptom are safety and do not drop.
const DROPS_AT_FULL_LOAD = new Set(["recovery_dose", "travel"]);

export interface DoseComparabilityInput {
  session_reasons: readonly string[];
  own_dose_shortfall: boolean;
  endurance_overlap: boolean;
  performed_at_full_load?: boolean;
}

export interface FullLoadReference {
  sets: number | null;
  target_weight: number | null;
  target_seconds: number | null;
  rep_low: number | null;
  recent_working_weight: number | null;
  recent_working_seconds: number | null;
}

export interface RepairOutcomeComparabilityCtx {
  // True only when a recovery_cycles row (active/recheck as of the date) or an
  // applied recovery-week stamp covered the outcome's date. Prose,
  // caps.intensity "deload", and template.focus "recovery" are not this.
  recovery: boolean;
}

// Larger signed value is harder in both regimes (loaded + and assist −).
// −25 is less assist than −30, so −25 >= −30. A positive log against a
// negative reference is the typing-slip progression already ignores, not
// "at or above".
export function loadAtOrAbove(achieved: number, reference: number): boolean {
  if (!Number.isFinite(achieved) || !Number.isFinite(reference)) return false;
  if (reference < 0 && achieved > 0) return false;
  if (reference > 0 && achieved < 0) return false;
  return achieved >= reference;
}

// recentWorkingWeight (or recentWorkingSeconds for timed) is the PRIMARY
// full-load reference. The plan target is a FORWARD prescription — progression
// writes the NEXT target there — so comparing against it would silently mean
// "hit your next target", not "matched your recent effort"; the plan target
// is used only as a fallback when there is no logged history at all. This
// mirrors the `reach` rule: computed from the LOGGED working weight, never a
// plan target. A positive plan target sitting on a negative (assisted)
// history stays untrusted for exactly that reason — recent, when present,
// always wins over it.
export function harderLoad(plan: number | null, recent: number | null): number | null {
  if (recent != null) return recent;
  return plan;
}

export function evaluatePerformedAtFullLoad(
  mode: "reps" | "timed",
  achieved: {
    sets: number;
    top_weight: number | null;
    top_reps: number | null;
    top_seconds: number | null;
  },
  reference: FullLoadReference
): boolean {
  // Unknown is not met. No plan-row sets (a substitution, another day's
  // prescription, a missing item) must not grant full-load — inside a real
  // recovery cycle that would drop recovery_dose for a reduced set count at
  // the usual weight.
  if (reference.sets == null || achieved.sets < reference.sets) return false;
  if (mode === "timed") {
    const refSec = harderLoad(reference.target_seconds, reference.recent_working_seconds);
    if (refSec == null) return false;
    return achieved.top_seconds != null && achieved.top_seconds >= refSec;
  }
  const refW = harderLoad(reference.target_weight, reference.recent_working_weight);
  if (refW == null) {
    // Bodyweight: sets (already) AND a rep reference at/above the un-reduced
    // prescription. No rep_low is unknown, not "any rep count".
    if (reference.rep_low == null) return false;
    return achieved.top_reps != null && achieved.top_reps >= reference.rep_low;
  }
  return achieved.top_weight != null && loadAtOrAbove(achieved.top_weight, refW);
}

export interface OwnDoseShortfallDose {
  prescribed?: { sets?: unknown } | null;
  achieved?: { sets?: unknown } | null;
  exercise?: unknown;
}

// Own-lift shortfall: the prescribed set count not landed, OR this lift is
// on the session's skipped list. One function so the live write and the
// repair cannot drift.
export function ownDoseShortfall(
  dose: OwnDoseShortfallDose | null | undefined,
  skipped: readonly unknown[] = []
): boolean {
  const prescribedSets = dose?.prescribed?.sets;
  if (prescribedSets != null && Number(dose?.achieved?.sets ?? 0) < Number(prescribedSets)) return true;
  const name = String(dose?.exercise ?? "")
    .trim()
    .toLowerCase();
  if (!name) return false;
  return skipped.some((entry) => String(entry ?? "").trim().toLowerCase() === name);
}

export function doseComparability(input: DoseComparabilityInput): {
  comparable: boolean;
  non_comparable_reasons: string[];
} {
  const atFullLoad = input.performed_at_full_load === true;
  const reasons: string[] = [];
  for (const raw of input.session_reasons) {
    const reason = String(raw);
    if (NEVER_BLOCKS_A_LIFT.has(reason)) continue;
    if (atFullLoad && DROPS_AT_FULL_LOAD.has(reason)) continue;
    if (reason === "partial") {
      if (input.own_dose_shortfall) reasons.push(reason);
      continue;
    }
    if (reason === "loaded_endurance") {
      if (input.endurance_overlap) reasons.push(reason);
      continue;
    }
    // An unrecognized reason is treated as day-wide: a new confounder must not
    // become invisible just because this table has not learned it yet.
    reasons.push(reason);
  }
  if (input.own_dose_shortfall && !reasons.includes("partial")) reasons.push("partial");
  return { comparable: reasons.length === 0, non_comparable_reasons: reasons };
}

// Repair a stored facts blob under the new law, using only the blob + whether a
// structured recovery window covered the date. Travel is left in place: a stored
// row cannot prove the prescription was a reduced one (the snapshot IS the
// prescription, reduced or not), so this never invents performed_at_full_load.
// Schema 2 never carried per-dose comparable — leave dose_evidence byte-identical
// and only clear a false recovery_dose on dose_context. Schema 3+ doses that
// already stored per-dose reasons are rewritten, honoring skipped the same way
// the live write does.
export function repairOutcomeComparability(facts: unknown, ctx: RepairOutcomeComparabilityCtx): unknown {
  if (!facts || typeof facts !== "object") return facts;
  let next: any;
  try {
    next = JSON.parse(JSON.stringify(facts));
  } catch {
    return facts;
  }
  const recovery = ctx?.recovery === true;
  const sessionReasons: string[] = Array.isArray(next.dose_context?.non_comparable_reasons)
    ? next.dose_context.non_comparable_reasons.map(String)
    : [];
  const repairedSession = sessionReasons.filter((reason) => recovery || reason !== "recovery_dose");
  if (next.dose_context && typeof next.dose_context === "object") {
    next.dose_context.recovery = recovery;
    next.dose_context.non_comparable_reasons = repairedSession;
    next.dose_context.comparable = repairedSession.length === 0;
  }
  const schema = Number(next.schema_version);
  if (!(schema >= 3) || !Array.isArray(next.dose_evidence)) return next;
  const skipped = Array.isArray(next.skipped) ? next.skipped : [];
  next.dose_evidence = next.dose_evidence.map((dose: any) => {
    if (!dose || typeof dose !== "object") return dose;
    const hadStored =
      typeof dose.comparable === "boolean" || Array.isArray(dose.non_comparable_reasons);
    if (!hadStored) return dose;
    const storedReasons = Array.isArray(dose.non_comparable_reasons)
      ? dose.non_comparable_reasons.map(String)
      : [];
    const verdict = doseComparability({
      session_reasons: repairedSession,
      own_dose_shortfall: ownDoseShortfall(dose, skipped),
      endurance_overlap: storedReasons.includes("loaded_endurance"),
      performed_at_full_load: dose.performed_at_full_load === true,
    });
    return { ...dose, ...verdict };
  });
  return next;
}
