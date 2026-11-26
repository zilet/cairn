// The decisions that used to count single lifts, restated over movement units.
//
// The capability read (strength-capability.ts) judges progress per movement unit and per
// muscle, the single lift as evidence. Program state carries a compact summary of it
// (`ProgramState.capability`, built here by `summarizeCapability`), and every decision
// that once tallied lifts reads that one summary through the small pure helpers below:
// the deload's fatigue arm, the volume step, the under-fuelling stall arm, the program
// headline and `adaptations_due`, the plateau plays and the muscle trajectory. So two
// variants of one movement are one witness, a swap inside a unit is never a reset, and a
// lift he is not doing never speaks.
//
// The science these helpers hold to:
//   - In a calorie deficit, maintaining strength is the realistic goal; a plateau there is
//     the plan working, not a programming failure (`cut` explains a flat or easing unit).
//   - Concurrent training interferes mainly with lower-body maximal strength, so a leg
//     unit easing while the running load ramps is the interference effect, expected within
//     limits (`run_build`).
//   - Added volume helps a plateau only when recovery is adequate, and never a regression.
//
// Pure: no database, no clock. Every helper fails toward silence: an unavailable read
// witnesses nothing, calls for nothing and counts nothing.
import type {
  CapabilityQualifier,
  CapabilityVerdict,
  StrengthCapabilityRead,
} from "../contracts/strength-capability.js";
import { normalizedExerciseKey } from "./exercise-canon.js";

/** One lift feeding a unit, in the read's own order (tier, recent hard sets, recency). */
export interface ProgramCapabilityLift {
  exercise: string;
  exercise_id: number;
  in_plan: boolean;
  /** Off the plan and not trained inside the current window: it feeds the unit's history, it is never named. */
  resting: boolean;
  /**
   * Trained inside the current window (program state's LIFT_CURRENT_WINDOW_DAYS). A unit
   * speaks for how he is coping NOW only through a current lift, as the lift-level reads
   * it replaces graded a stall or a slide only on a lift trained lately. Optional, so a
   * summary built before the field existed reads as not current (toward silence).
   */
  current?: boolean;
}

/** program-state's LIFT_CURRENT_WINDOW_DAYS, restated (a top-level read of a cycle-mate's binding breaks a load order). */
const CURRENT_WINDOW_DAYS = 28;

function daysBefore(later: string, earlier: string | null | undefined): number | null {
  if (!earlier) return null;
  const a = Date.parse(`${String(later).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(earlier).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 864e5) : null;
}

/** A movement unit as program state carries it: words and names only, no score. */
export interface ProgramCapabilityUnit {
  key: string;
  label: string;
  compound: boolean;
  in_plan: boolean;
  verdict: CapabilityVerdict;
  qualifiers: CapabilityQualifier[];
  line: string;
  lifts: ProgramCapabilityLift[];
  /** The first contributor on the plan now: the lift a call about this unit names as evidence. */
  plan_lift: string | null;
  /** Honest comparable exposures across the unit's contributors inside the read's window. */
  exposures: number;
}

export interface ProgramCapabilityMuscle {
  group: string;
  verdict: "progressing" | "holding" | "slipping" | "not_enough";
  band: string | null;
  units: string[];
  line: string;
}

/** The capability read, summarized for program state and everything that reads it. */
export interface ProgramCapability {
  available: boolean;
  overall: { verdict: CapabilityVerdict; line: string } | null;
  units: ProgramCapabilityUnit[];
  muscles: ProgramCapabilityMuscle[];
}

export const UNAVAILABLE_CAPABILITY: Readonly<ProgramCapability> = Object.freeze({
  available: false,
  overall: null,
  units: [],
  muscles: [],
});

/** Summarize a capability read for program state. A failed read stays `available:false`. */
export function summarizeCapability(read: StrengthCapabilityRead | null | undefined): ProgramCapability {
  if (!read || read.available !== true) return { available: false, overall: null, units: [], muscles: [] };
  return {
    available: true,
    overall: read.overall ? { verdict: read.overall.verdict, line: read.overall.line } : null,
    units: (Array.isArray(read.units) ? read.units : []).map((unit) => {
      const lifts = (Array.isArray(unit.contributors) ? unit.contributors : []).map((c) => {
        const age = daysBefore(read.date, c.last_trained);
        const current = age != null && age >= 0 && age <= CURRENT_WINDOW_DAYS;
        return {
          exercise: String(c.exercise),
          exercise_id: Number(c.exercise_id),
          in_plan: c.in_plan === true,
          resting: c.in_plan !== true && !current,
          current,
        };
      });
      return {
        key: String(unit.key),
        label: String(unit.label),
        compound: unit.compound === true,
        in_plan: unit.in_plan === true,
        verdict: unit.verdict,
        qualifiers: Array.isArray(unit.qualifiers) ? [...unit.qualifiers] : [],
        line: String(unit.line ?? ""),
        lifts,
        plan_lift: lifts.find((l) => l.in_plan)?.exercise ?? null,
        exposures: (Array.isArray(unit.contributors) ? unit.contributors : []).reduce(
          (sum, c) => sum + (Number.isFinite(Number(c.exposures)) ? Number(c.exposures) : 0),
          0
        ),
      };
    }),
    muscles: (Array.isArray(read.muscles) ? read.muscles : []).map((m) => ({
      group: String(m.group),
      verdict: m.verdict,
      band: m.band ?? null,
      units: Array.isArray(m.units) ? [...m.units] : [],
      line: String(m.line ?? ""),
    })),
  };
}

/**
 * With no plan at all, every unit he trains is his program (the capability read's own
 * overall rule: with no plan, every compound unit counts). Program state applies this when
 * the plan carries no strength item, so an athlete training without a written plan is not
 * read as doing nothing "on the plan".
 */
export function everyUnitOnPlan(cap: ProgramCapability): ProgramCapability {
  if (!cap.available) return cap;
  return { ...cap, units: cap.units.map((u) => ({ ...u, in_plan: true })) };
}

const usable = (cap: ProgramCapability | null | undefined): cap is ProgramCapability =>
  !!cap && cap.available === true && Array.isArray(cap.units);

/**
 * A flat or easing unit whose own qualifier explains it: the cut (holding strength in a
 * deficit is the win), the run build carrying the legs (the interference effect), or a
 * lighter week running. Such a unit is no fatigue witness, no stall to rotate and no
 * plateau to add volume to.
 */
export function unitExplained(unit: Pick<ProgramCapabilityUnit, "qualifiers">): boolean {
  return Array.isArray(unit?.qualifiers) && unit.qualifiers.length > 0;
}

/** A unit's athlete-facing noun ("flat press", "pulldown and pull-up"). */
export function unitPhrase(unit: Pick<ProgramCapabilityUnit, "label">): string {
  const label = String(unit?.label ?? "").trim();
  return label ? label.charAt(0).toLowerCase() + label.slice(1) : "movement";
}

/** The lift a call about this unit names: the one on the plan, else its leading contributor he is doing. */
export function unitEvidenceLift(unit: Pick<ProgramCapabilityUnit, "plan_lift" | "lifts">): string | null {
  return unit?.plan_lift ?? unit?.lifts?.find((l) => !l.resting)?.exercise ?? null;
}

/** The lifts a unit may be named by: never a resting one, the plan's first. */
export function unitNamedLifts(unit: Pick<ProgramCapabilityUnit, "lifts">): string[] {
  const named = (unit?.lifts ?? []).filter((l) => !l.resting);
  return [...named.filter((l) => l.in_plan), ...named.filter((l) => !l.in_plan)].map((l) => l.exercise);
}

// ---- 1. the deload's fatigue arm ---------------------------------------------------

/**
 * How many independent movements must be easing before the log confirms fatigue. Two
 * COMPOUND units on the plan, each slipping with nothing of its own to explain it: one
 * easing movement is noise (a bad week, a technique change), two main movements easing
 * together beside physiology is the overreaching picture a lighter week answers. The same
 * two the lift-level rule asked for (two independent regressing lifts), counted per
 * movement, so two variants of one movement are one witness.
 */
export const FATIGUE_MIN_SLIPPING_UNITS = 2;

/**
 * Does a unit's own qualifier explain its slide away as a fatigue witness? A lighter week
 * running does (the dose was cut on purpose). A run build does, and the read stamps
 * `run_build` on LOWER-body units only (the interference effect lands on the legs), so an
 * upper-body unit easing during a run build still counts. The cut never does: in a deficit
 * two main movements sliding, after four loaded weeks and beside physiology, is exactly
 * when a lighter week is right — and every other condition of the arm still has to hold.
 */
export function fatigueSlideExplained(unit: Pick<ProgramCapabilityUnit, "qualifiers">): boolean {
  const q = Array.isArray(unit?.qualifiers) ? unit.qualifiers : [];
  return q.includes("recovery") || q.includes("run_build");
}

/** The units that witness fatigue: compound, on the plan, slipping, not explained by a lighter week or (legs) a run build. */
export function fatigueWitnessUnits(cap: ProgramCapability | null | undefined): ProgramCapabilityUnit[] {
  if (!usable(cap)) return [];
  return cap.units.filter((u) => u.compound && u.in_plan && u.verdict === "slipping" && !fatigueSlideExplained(u));
}

/** Can the summary decide anything (available, with its units)? Otherwise the lift-level rules answer. */
export function capabilityUsable(cap: ProgramCapability | null | undefined): cap is ProgramCapability {
  return usable(cap);
}

// ---- 3. the under-fuelling stall arm ------------------------------------------------

/**
 * The under-fuelling watch's stall arm, over units. It fires wherever the lift-level rule
 * it replaced fired (two graded, current lifts plateaued or regressing, out of any number
 * graded) once the same lifts are grouped into movements, and never on a lift he is not
 * doing. So a witness is any graded unit, holding or slipping, with a lift trained inside
 * the current window — compound or isolation, on the plan or trained lately off it, as the
 * lift rule counted — and no qualifier explains a unit away here: the arm exists to ask
 * what a deficit is costing, so the cut is what it watches, and a lighter week or a run
 * build never exempted a lift under the old rule either. Met at `LIFT_STALL_MIN_UNITS`
 * witnesses; no share of the graded units and no slipping unit is required, so several
 * movements all flat in a deficit read met, as two flat lifts did. Two UNITS where the
 * rule said two lifts: two variants of one movement were never two independent signs (one
 * stimulus), and two distinct movements stalling is exactly the evidence two distinct
 * lifts were. A unit with no current lift (every contributor resting, or an on-plan lift
 * untrained for weeks) is neither a witness nor graded, as such a lift was neither.
 */
export const LIFT_STALL_MIN_UNITS = 2;

export interface LiftStallUnitRead {
  verdict: "met" | "not_met" | "absent";
  graded: number;
  stalled: number;
  slipping: number;
  units: string[];
}

/**
 * A lift trained inside the current window. A summary carried without the `current` field
 * (an injected or older one) reads it as "not resting", the rotation fields it did carry.
 */
function liftCurrent(l: ProgramCapabilityLift): boolean {
  return typeof l?.current === "boolean" ? l.current : l?.resting !== true;
}

/** A graded unit he is doing now: a verdict other than not_enough, and a lift trained inside the current window. */
function currentGradedUnit(u: ProgramCapabilityUnit): boolean {
  return u.verdict !== "not_enough" && Array.isArray(u.lifts) && u.lifts.some(liftCurrent);
}

export function liftStallUnitRead(cap: ProgramCapability | null | undefined): LiftStallUnitRead {
  if (!usable(cap)) return { verdict: "absent", graded: 0, stalled: 0, slipping: 0, units: [] };
  const graded = cap.units.filter(currentGradedUnit);
  if (!graded.length) return { verdict: "absent", graded: 0, stalled: 0, slipping: 0, units: [] };
  const stalled = graded.filter((u) => u.verdict === "holding" || u.verdict === "slipping");
  const slipping = stalled.filter((u) => u.verdict === "slipping").length;
  return {
    verdict: stalled.length >= LIFT_STALL_MIN_UNITS ? "met" : "not_met",
    graded: graded.length,
    stalled: stalled.length,
    slipping,
    units: stalled.map((u) => u.key),
  };
}

/**
 * The under-fuelling read's performance channel, over units (underfueling.ts). The same
 * population as the stall arm above (graded units with a current lift, none explained
 * away), tallied for the proportionate "is strength under strain" bar: climbing units
 * against slipping and holding ones, as the lift tally counted progressing lifts against
 * regressing and flat ones. `absent` when no unit is graded — the channel then falls back
 * to its lift-level read — so an unavailable read never reads as no strain.
 */
export interface StrengthStrainUnitTally {
  read: LiftStallUnitRead;
  /** Graded current units that are climbing. */
  improving: number;
  /** Graded current units that are slipping. */
  declining: number;
  /** Graded current units that are holding. */
  steady: number;
}

export function strengthStrainUnitTally(cap: ProgramCapability | null | undefined): StrengthStrainUnitTally {
  const read = liftStallUnitRead(cap);
  if (read.verdict === "absent" || !usable(cap)) return { read, improving: 0, declining: 0, steady: 0 };
  const improving = cap.units.filter((u) => currentGradedUnit(u) && u.verdict === "climbing").length;
  return { read, improving, declining: read.slipping, steady: read.stalled - read.slipping };
}

// ---- 2. the volume step ---------------------------------------------------------------

/**
 * Enough evidence for a unit's "holding" to earn a set: this many honest comparable
 * exposures across its contributors. A hold read off two sessions is a guess.
 */
export const VOLUME_STEP_MIN_UNIT_EXPOSURES = 4;

export type VolumeStepUnitBlock = "unit_slipping" | "unit_climbing" | "unit_explained" | "unit_unread";

export interface VolumeStepUnitRead {
  /** Null when the group may take a set; otherwise why not. */
  block: VolumeStepUnitBlock | null;
  /** The in-plan units, holding with enough evidence and nothing explaining it, that may take the set. */
  earning: string[];
}

/**
 * Does a muscle group's capability earn one more set? Its in-plan units (the ones the
 * muscle read lists as crediting it) decide: any slipping unit blocks the group (more
 * volume is the wrong lever for a slide), and the group earns only through a unit that is
 * HOLDING on enough evidence with no qualifier explaining it — a climbing unit needs
 * nothing, and a unit held by the cut, the run build or a lighter week is not short of
 * volume. Fails toward silence: an unavailable read, or no unit read for the group, earns
 * nothing.
 */
export function volumeStepUnitRead(cap: ProgramCapability | null | undefined, group: string): VolumeStepUnitRead {
  if (!usable(cap)) return { block: "unit_unread", earning: [] };
  const muscle = cap.muscles.find((m) => m.group === group);
  const keys = new Set(muscle?.units ?? []);
  const units = cap.units.filter((u) => keys.has(u.key) && u.in_plan);
  if (!units.length) return { block: "unit_unread", earning: [] };
  if (units.some((u) => u.verdict === "slipping")) return { block: "unit_slipping", earning: [] };
  const earning = units.filter(
    (u) => u.verdict === "holding" && !unitExplained(u) && u.exposures >= VOLUME_STEP_MIN_UNIT_EXPOSURES
  );
  if (earning.length) return { block: null, earning: earning.map((u) => u.key) };
  if (units.some((u) => u.verdict === "holding" && unitExplained(u))) return { block: "unit_explained", earning: [] };
  if (units.some((u) => u.verdict === "climbing")) return { block: "unit_climbing", earning: [] };
  return { block: "unit_unread", earning: [] };
}

// ---- lifts against their unit ---------------------------------------------------------

/** The unit a lift contributes to, matched by its row id, else by its name's key. */
export function unitOfLift(
  cap: ProgramCapability | null | undefined,
  exercise: string,
  exerciseId?: number | null
): ProgramCapabilityUnit | null {
  if (!usable(cap)) return null;
  if (exerciseId != null && Number.isFinite(Number(exerciseId))) {
    const byId = cap.units.find((u) => u.lifts.some((l) => l.exercise_id === Number(exerciseId)));
    if (byId) return byId;
  }
  const key = normalizedExerciseKey(String(exercise ?? ""));
  if (!key) return null;
  return cap.units.find((u) => u.lifts.some((l) => normalizedExerciseKey(l.exercise) === key)) ?? null;
}

/**
 * Does a single lift's stall or slide still stand as a call once its unit is read? Only
 * when the read is available, the lift's unit is on the plan, the unit itself is holding
 * or slipping, and no qualifier explains it. A stalled variant inside a climbing unit is a
 * swap, not a plateau; a lift whose unit holds through the cut is the plan working. With
 * no read (or a lift the read could not place) the lift-level call stands as it was.
 */
export function liftCallStands(
  cap: ProgramCapability | null | undefined,
  exercise: string,
  exerciseId?: number | null
): boolean {
  if (!usable(cap)) return true;
  const unit = unitOfLift(cap, exercise, exerciseId);
  if (!unit) return true;
  if (!unit.in_plan) return false;
  if (unit.verdict !== "holding" && unit.verdict !== "slipping") return false;
  return !unitExplained(unit);
}

/** In-plan units by verdict (not_enough never counts). */
export function inPlanUnitCounts(cap: ProgramCapability | null | undefined): {
  climbing: number;
  holding: number;
  slipping: number;
} {
  const out = { climbing: 0, holding: 0, slipping: 0 };
  if (!usable(cap)) return out;
  for (const u of cap.units) {
    if (!u.in_plan) continue;
    if (u.verdict === "climbing") out.climbing++;
    else if (u.verdict === "holding") out.holding++;
    else if (u.verdict === "slipping") out.slipping++;
  }
  return out;
}

// ---- 6. the prompt key ------------------------------------------------------------------

/** The compact `capability` key the plan-shaping and chat prompts carry: names and words only. */
export type CapabilityPromptView = {
  overall: string | null;
  units: Array<{ movement: string; verdict: CapabilityVerdict; because?: CapabilityQualifier; lifts: string[] }>;
  muscles: Array<{ group: string; verdict: ProgramCapabilityMuscle["verdict"] }>;
};

const PROMPT_UNITS_MAX = 12;
const PROMPT_LIFTS_PER_UNIT = 3;

export function capabilityPromptView(cap: ProgramCapability | null | undefined): CapabilityPromptView | null {
  if (!usable(cap)) return null;
  const lead = (q: CapabilityQualifier[]): CapabilityQualifier | undefined =>
    q.includes("recovery") ? "recovery" : q.includes("run_build") ? "run_build" : q.includes("cut") ? "cut" : undefined;
  return {
    overall: cap.overall?.line ?? null,
    units: cap.units
      .filter((u) => u.in_plan)
      .slice(0, PROMPT_UNITS_MAX)
      .map((u) => {
        const because = lead(u.qualifiers);
        return {
          movement: unitPhrase(u),
          verdict: u.verdict,
          ...(because ? { because } : {}),
          lifts: unitNamedLifts(u).slice(0, PROMPT_LIFTS_PER_UNIT),
        };
      }),
    muscles: cap.muscles.filter((m) => m.verdict !== "not_enough").map((m) => ({ group: m.group, verdict: m.verdict })),
  };
}
