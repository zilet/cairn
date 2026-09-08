// Frozen snapshot of src/repo/outcome-comparability.ts#repairOutcomeComparability as of 2026-09-08 (commit 456211f0); migrations must not track live code.
//
// WHY A COPY AND NOT AN IMPORT. A migration is a statement about what the ladder did
// on the day it shipped. Importing the live module means a fresh install replays that
// migration against TODAY's semantics — a silently different repair from the one every
// existing database received. The live module stays free to evolve; this snapshot does
// not. Do not "fix" a bug here: fix it in the live module and, if old rows need it,
// append a NEW migration.
//
// DO NOT REFORMAT. This file is a verbatim copy; a formatter reflowing it would
// break the one property that makes it auditable — that every line still matches
// the live source it was taken from.

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

export interface RepairOutcomeComparabilityCtx {
  // True only when a recovery_cycles row (active/recheck as of the date) or an
  // applied recovery-week stamp covered the outcome's date. Prose,
  // caps.intensity "deload", and template.focus "recovery" are not this.
  recovery: boolean;
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
