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
  /**
   * The plateau ladder's next lever for this unit (src/repo/unit-plateau.ts), filled only
   * where a surface composes the read with the ladder (`capabilityWithLadder`): the REST
   * route and the MCP tool. Absent on the bare read, on an off-plan unit, and when the
   * ladder could not be read.
   */
  next?: CapabilityUnitNext;
}

/** The plateau ladder's levers, in ladder order. `none`: still climbing; `wait`: the hold is explained or too young. */
export type CapabilityNextLever = "none" | "wait" | "rep_scheme" | "set_quality" | "volume" | "variation";

export interface CapabilityUnitNext {
  lever: CapabilityNextLever;
  /** Plain words, athlete-facing register; never a number that reads as a score. */
  reason: string;
  /** The plan lift the unit is judged on. */
  plan_lift: string | null;
  /** The variant a `variation` lever would rotate in. */
  candidate: string | null;
  /** The rep range a `rep_scheme` lever would write. */
  rep_range?: { rep_low: number; rep_high: number } | null;
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
