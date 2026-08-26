import { daysBetweenISO } from "./shared.js";

export type RecompositionStageKind =
  | "early_cut"
  | "mid_cut"
  | "leaning_out"
  | "stabilizing"
  | "maintenance"
  | "lean_gain"
  | "uncertain";

export interface RecompositionStageClassification {
  kind: RecompositionStageKind;
  label: string;
  basis: string[];
}

// Pure phase classifier shared by Journey and decision-time learning. It has no
// DB/repo dependencies, so nutrition can persist a phase without importing the
// higher-level recomposition read (which itself consumes nutrition/underfueling).
export function classifyRecompositionStage(input: {
  mode: string;
  phaseKind?: string | null;
  progress: number | null;
  remaining: number | null;
  current: number | null;
  bodyFatPct: number | null;
  bodyFatDate: string | null;
  goalBodyFat: number | null;
  today: string;
}): RecompositionStageClassification {
  const phaseKind = String(input.phaseKind ?? "");
  if (phaseKind === "diet_break" || phaseKind === "reverse") {
    return { kind: "stabilizing", label: "Stabilizing", basis: [`Active ${phaseKind.replaceAll("_", " ")} phase`] };
  }
  if (input.mode === "maintain" || phaseKind === "maintenance") {
    return { kind: "maintenance", label: "Maintenance", basis: ["Current goal is maintenance"] };
  }
  if (input.mode === "gain" || phaseKind === "gain") {
    return { kind: "lean_gain", label: "Lean-gain phase", basis: ["Current goal is gradual gain"] };
  }
  if (input.mode !== "lose" || input.current == null) {
    return {
      kind: "uncertain",
      label: "Still learning the phase",
      basis: ["A clear current weight and goal are still needed"],
    };
  }
  if (input.progress == null && input.remaining == null && input.goalBodyFat == null) {
    return {
      kind: "uncertain",
      label: "Still learning the phase",
      basis: ["A declared weight or body-fat destination is still needed"],
    };
  }

  const bodyFatAge = input.bodyFatDate ? daysBetweenISO(input.today, input.bodyFatDate) : null;
  const freshBodyFat = bodyFatAge != null && bodyFatAge >= 0 && bodyFatAge <= 45;
  const nearBodyFatGoal =
    freshBodyFat && input.goalBodyFat != null && input.bodyFatPct != null
      ? input.bodyFatPct <= input.goalBodyFat + 3
      : false;
  // Leaning-out is the last stretch of a cut (within 8 lb, or ~72% of the
  // path). Near-goal is tighter — within NEAR_GOAL_REMAINING_LB of the
  // destination — and is the lever that stops a soft/reduce fuel hold from
  // vetoing a promotion the log already earned. Sliding still vetoes;
  // fast_loss does not. The two stretches are not the same.
  if (
    (input.progress != null && input.progress >= 0.72) ||
    nearBodyFatGoal ||
    (input.remaining != null && input.remaining <= 8)
  ) {
    return {
      kind: "leaning_out",
      label: "Leaning-out phase",
      basis: [
        input.progress != null
          ? `${Math.round(input.progress * 100)}% of the weight path is complete`
          : "The remaining weight gap is small",
        ...(nearBodyFatGoal ? ["A recent body-fat estimate is approaching the declared target"] : []),
      ],
    };
  }
  if (input.progress != null && input.progress >= 0.35) {
    return {
      kind: "mid_cut",
      label: "Mid-cut",
      basis: [`${Math.round(input.progress * 100)}% of the weight path is complete`],
    };
  }
  return { kind: "early_cut", label: "Early cut", basis: ["Most of the declared weight path is still ahead"] };
}

// Close enough to the destination that a soft fuel hold (and even a reduce)
// should not sit on a promotion the log already earned. 2.5 lb ≈ 1.1 kg.
// The date-aware reader is `nearGoal` in recomposition.ts — this file stays
// free of DB/repo dependencies so nutrition can persist a phase without
// pulling the higher-level recomposition read.
export const NEAR_GOAL_REMAINING_LB = 2.5;

export function isNearGoal(remaining: number | null | undefined): boolean {
  return remaining != null && Number.isFinite(remaining) && remaining <= NEAR_GOAL_REMAINING_LB;
}
