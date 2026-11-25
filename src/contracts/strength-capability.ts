// The capability read: progress judged per movement unit and per muscle group, with the
// single lift as evidence (src/repo/strength-capability.ts). Directional words only —
// never a score, never a grade.
export type CapabilityVerdict = "climbing" | "holding" | "slipping" | "not_enough";
/** Why a flat unit is not a plateau: an affirmed cut, a run build carrying the legs, a recovery week. */
export type CapabilityQualifier = "cut" | "run_build" | "recovery";

export interface CapabilityContributor {
  exercise: string;
  exercise_id: number;
  in_plan: boolean;
  last_trained: string | null;
  /** Comparable exposures inside the read's window. */
  exposures: number;
  direction: CapabilityVerdict;
  /** How this variant's change reached the unit: its own two windows, a ratio learned from
   *  this athlete's own log, the conservative table, or not yet. */
  transfer: "own" | "learned" | "table" | "none";
}

export interface CapabilityUnit {
  /** Stable key: a movement pattern for a compound, a movement region for an isolation lift. */
  key: string;
  label: string;
  kind: "pattern" | "region";
  compound: boolean;
  /** At least one contributor sits on the plan now. */
  in_plan: boolean;
  verdict: CapabilityVerdict;
  qualifiers: CapabilityQualifier[];
  hard_sets_trend: "rising" | "steady" | "falling" | null;
  /** One athlete-facing sentence (reading grammar; no numbers that read as a score). */
  line: string;
  contributors: CapabilityContributor[];
}

export interface CapabilityMuscle {
  group: string;
  verdict: "progressing" | "holding" | "slipping" | "not_enough";
  weekly_hard_sets: number | null;
  band: string | null;
  volume_trend: "rising" | "stable" | "falling" | null;
  /** Keys of the units that credit this group as primary or counted synergist. */
  units: string[];
  line: string;
}

export interface StrengthCapabilityRead {
  /** False when a read failed: nothing below is to be trusted or shown as a verdict. */
  available: boolean;
  date: string;
  overall: { verdict: CapabilityVerdict; line: string } | null;
  units: CapabilityUnit[];
  muscles: CapabilityMuscle[];
}
