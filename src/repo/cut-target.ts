// CUT TARGET — the calorie target of an active cut, derived from LOGGED REALITY.
//
// The gap this closes: `computeGoalCheck` already answers "what rate would hit the
// date", and `estimateExpenditure` already answers "what does the intake + scale
// record say maintenance is". Nothing joined them into ONE number with ONE stated
// confidence, so the accepted target could drift off an agent's judgement of the
// week rather than off the athlete's own record — which is how a mid-cut target
// came to be RAISED toward maintenance without any logged evidence asking for it.
//
// THE LAW, in the order it binds:
//
//   1. MAINTENANCE IS DERIVED, NOT CHOSEN. When the record is thick enough —
//      GROUNDED_MIN_WEIGH_INS weigh-ins spanning GROUNDED_MIN_SPAN_DAYS and
//      GROUNDED_MIN_INTAKE_DAYS logged intake days inside the trailing window —
//      maintenance is the energy-balance outcome (intake minus the measured
//      tissue-energy change). Otherwise it is the formula/prior estimate, and the
//      derivation SAYS SO by returning `low` confidence rather than by going quiet.
//
//   2. BEST ESTIMATE AND MOVE. Absent data never parks the derivation. Every
//      branch that has a bodyweight to stand on returns a number; the honesty is
//      carried in `confidence` and `tdee_basis`, never in silence.
//
//   3. THE DEFICIT IS BOUNDED AT BOTH ENDS. CUT_DEFICIT_DEFAULT_KCAL ± TOLERANCE.
//      The floor stops a target from creeping toward maintenance for no logged
//      reason; the ceiling is why a goal date can never be met by crash-cutting.
//
//   4. THE DATE MOVES, THE PACE DOES NOT. When the goal date needs a faster pace
//      than the band (and the leanness-aware ceiling) allows, the deficit stays
//      capped and the DATE is what gives — reported as `goal_date_adaptation` for
//      an announced heads-up. Never a crash cut, never a silently missed date.
//
// Adherence-neutral throughout: a thin logging week lowers `confidence` and widens
// nothing else. It never blames, and a gap is never read as a number to act on.
//
// The decision core is PURE — callers hand over the numbers they already have and
// nothing in it reads the database or the clock. One thin DB-facing function
// assembles that state, mirroring sensor-recheck.ts's shape.

import { db } from "../db.js";
import { estimateExpenditure } from "./expenditure.js";
import {
  KCAL_PER_LB,
  currentBodyFatEstimate,
  effectiveGoalMode,
  getProfile,
  leannessAwareLossRates,
} from "./profile.js";
import { getAttentionSchedule } from "./attention.js";
import { activeBlockContext } from "./program-blocks.js";
import { getProgramState, strengthBlockPeaking } from "./program-state.js";
import { getLatestNutritionTarget, intakeLoggingMode, type KnownIntakeLoggingMode } from "./nutrition.js";
import { resolvedCurrentBodyweight } from "./bodyweight.js";
import { addDaysISO, localDateISO } from "./shared.js";

// ---- constants ---------------------------------------------------------------

// The trailing record the grounded derivation reads. Four weeks: long enough to
// hold two weigh-ins a fortnight apart plus a working week of food logs, short
// enough that it describes the CURRENT phase rather than the one before it.
export const CUT_EVIDENCE_WINDOW_DAYS = 28;
// What makes the energy-balance read admissible at all. Two weigh-ins a week apart
// is the minimum from which a weekly rate can be drawn without inventing one; seven
// intake days is the minimum from which a daily average can be.
export const GROUNDED_MIN_WEIGH_INS = 2;
export const GROUNDED_MIN_SPAN_DAYS = 7;
export const GROUNDED_MIN_INTAKE_DAYS = 7;

// The optimal cut pace, as a share of bodyweight per week. At 168 lb this is
// roughly 0.8-1.3 lb a week. It is the band the GOAL DATE is judged against; the
// deficit band below is what the target is actually built from, and where the two
// disagree the deficit ceiling wins (rule 3) and the date gives (rule 4).
export const CUT_PACE_MIN_PCT = 0.005;
export const CUT_PACE_MAX_PCT = 0.0075;

// The daily deficit a derived cut target carries: 350 kcal, give or take 100.
export const CUT_DEFICIT_DEFAULT_KCAL = 350;
export const CUT_DEFICIT_TOLERANCE_KCAL = 100;
export const CUT_DEFICIT_MIN_KCAL = CUT_DEFICIT_DEFAULT_KCAL - CUT_DEFICIT_TOLERANCE_KCAL;
export const CUT_DEFICIT_MAX_KCAL = CUT_DEFICIT_DEFAULT_KCAL + CUT_DEFICIT_TOLERANCE_KCAL;

// The same absolute kcal floor every other nutrition surface honors. Duplicated as
// a local constant rather than imported because profile.ts keeps its copy private.
const KCAL_ABSOLUTE_FLOOR = 1_500;
// Targets are shown to a person, so they land on a round number.
const TARGET_ROUNDING_KCAL = 25;

// ---- the shape the pure core reads and returns -------------------------------

export type CutTdeeBasis = "logged_reality" | "formula_estimate";
export type CutTargetConfidence = "low" | "moderate" | "high";

// ---- rule 5: the next step of the deficit waits for an ordinary week ---------
//
// The derivation used to read expenditure, the scale and the calendar and NOTHING
// about the training week the deficit would land in, so a deeper cut could be set
// against the heaviest week of a block. The only thing downstream that noticed was
// the under-fuelling controller, whose trigger by construction needs two poor
// sessions to have already happened — a correction after the cost, not before it.
//
// So the derivation now reads the week it is prescribing INTO. During a high-demand
// week the deficit does not deepen: the target HOLDS at the number already in force
// and the next step happens at the next ordinary week. The deficit itself is never
// cancelled — only its next increment waits.
//
// `capProtectiveRaise` below stays the ONE authority on lifting a target, so the
// hold is expressed by calling it rather than by a second ceiling of its own. Two
// consequences fall straight out of that, both deliberate: a hold can never carry
// the target past MEASURED maintenance, and on a `formula_estimate` anchor it can
// buy nothing at all — an unmeasured maintenance is not headroom, here either.
export type CutTrainingDemandBasis = "block_phase" | "combined_load";

export interface CutTrainingDemand {
  /** True when this week is one of the block's big asks, or both lanes are ramped. */
  high: boolean;
  /** MACHINE register: which read said so. Empty when the week is ordinary. */
  basis: CutTrainingDemandBasis[];
  /** The active block's phase word, when a block is running. */
  phase: string | null;
}

export interface CutTargetCoverage {
  window_days: number;
  intake_days: number;
  weigh_ins: number;
  weigh_in_span_days: number;
}

export interface CutTargetState {
  today: string;
  weight_lb: number | null;
  goal_weight_lb: number | null;
  goal_date: string | null;
  body_fat_pct: number | null;
  // The energy-balance answer, when the record produced one. Null means the
  // outcome could not be computed at all (no intake, or no weight trend).
  outcome_tdee: number | null;
  // The formula / wearable prior. The fallback of rule 1, and never null-safe to
  // assume: a profile too thin for Mifflin leaves both anchors null.
  prior_tdee: number | null;
  // The physiological band `estimateExpenditure` already derives from the profile
  // seed. Reused verbatim so the outlier clamp here and the implausibility read
  // there can never disagree about what counts as an outlier.
  plausible_tdee_min: number;
  plausible_tdee_max: number;
  coverage: CutTargetCoverage;
  // Whether the athlete is logging meals at all right now. `quiet` does NOT make
  // the derivation quieter — it changes what the derivation SAYS it stood on, so a
  // scale-and-prior estimate is never described as a record that has not filled in
  // yet. Null when the mode could not be read (including the read's own "unknown",
  // which is normalized away here); the derivation then behaves exactly as it did
  // before this field existed.
  intake_mode?: KnownIntakeLoggingMode | null;
  // The protein figure already in force. The derivation moves calories only —
  // protein is carried forward, never trimmed as a side effect of a kcal change.
  protein_floor_g: number | null;
  // The calorie target the athlete is eating to today, when one has been accepted.
  // Rule 5 needs it because a "deepening" is only nameable against the number
  // already in force; absent it there is nothing to hold and the derivation
  // behaves exactly as it did before rule 5 existed.
  active_target_kcal?: number | null;
  // The training week this target would be eaten in. Optional for the same reason:
  // a caller that hands over no week gets the pre-rule-5 answer rather than a
  // guess about one.
  training_demand?: CutTrainingDemand | null;
}

export interface CutGoalDateAdaptation {
  from: string;
  to: string;
  weeks_added: number;
  // MACHINE register. `cutTargetBody` owns what a person reads.
  reason: string;
}

export interface CutTargetDerivation {
  target_kcal: number;
  protein_g: number | null;
  tdee_kcal: number;
  tdee_basis: CutTdeeBasis;
  confidence: CutTargetConfidence;
  // What the target actually delivers, after every clamp above it.
  deficit_kcal: number;
  pace_lb_wk: number;
  // True when the goal date wanted a faster pace than the law allows, so the
  // deficit ceiling bound the answer and the date is what moved.
  pace_capped: boolean;
  // True when the raw energy-balance outcome fell outside the physiological band
  // and was pulled back to its edge.
  outlier_clamped: boolean;
  goal_date: string | null;
  projected_goal_date: string | null;
  goal_date_adaptation: CutGoalDateAdaptation | null;
  coverage: CutTargetCoverage;
  // Carried through so the words a person reads (`cutTargetBody`) can tell a
  // record that is still filling in from one that is deliberately not being kept.
  intake_mode: KnownIntakeLoggingMode | null;
  // Rule 5: the week this target lands in, and whether the next step of the
  // deficit is waiting for an ordinary one. `deepening_held` is false whenever the
  // derivation stepped normally — including a week too demanding to step in that
  // had no measured maintenance to hold against.
  training_demand: CutTrainingDemand | null;
  deepening_held: boolean;
  // MACHINE register — third-person evidence prose for the target note and the
  // provenance trail.
  reason: string;
}

const DAY_MS = 864e5;

function dayEpoch(iso: unknown): number | null {
  const text = String(iso ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const t = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

// Absence must stay ABSENT. `Number(null)` is 0 and `Number("")` is 0, both
// finite, so a bare Number.isFinite check silently turns "no reading" into a
// reading of zero — which here would read a missing maintenance anchor as a
// maintenance of 0 kcal and a missing protein figure as a protein floor of none.
function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * Does the trailing record support an energy-balance read, or only a formula one?
 *
 * PURE. Exported because it is the exact sentence of rule 1 and the tests pin it
 * directly rather than inferring it from a derived number.
 */
export function cutEvidenceIsGrounded(coverage: CutTargetCoverage, outcomeTdee: number | null): boolean {
  if (outcomeTdee == null) return false;
  return (
    Number(coverage?.weigh_ins) >= GROUNDED_MIN_WEIGH_INS &&
    Number(coverage?.weigh_in_span_days) >= GROUNDED_MIN_SPAN_DAYS &&
    Number(coverage?.intake_days) >= GROUNDED_MIN_INTAKE_DAYS
  );
}

/**
 * The target of an active cut, from the record it actually has.
 *
 * Null ONLY when there is nothing at all to stand on: no bodyweight, no goal
 * weight below it, or neither an outcome nor a prior maintenance estimate. Every
 * other thinness is answered with an estimate and a confidence, never silence
 * (rule 2).
 *
 * PURE: no clock, no database, no writes.
 */
export function cutTargetDecision(state: CutTargetState): CutTargetDerivation | null {
  const today = dayEpoch(state?.today);
  if (today == null) return null;
  const weight = finite(state?.weight_lb);
  const goalWeight = finite(state?.goal_weight_lb);
  if (weight == null || weight <= 0) return null;
  const lbsToLose = goalWeight == null ? null : weight - goalWeight;
  // At or below goal there is no cut left to fuel; the maintenance conversation
  // that follows belongs to the journey layer, not to this derivation.
  if (lbsToLose == null || lbsToLose <= 0) return null;

  const coverage: CutTargetCoverage = {
    window_days: Number(state?.coverage?.window_days) || CUT_EVIDENCE_WINDOW_DAYS,
    intake_days: Math.max(0, Math.round(Number(state?.coverage?.intake_days) || 0)),
    weigh_ins: Math.max(0, Math.round(Number(state?.coverage?.weigh_ins) || 0)),
    weigh_in_span_days: Math.max(0, Math.round(Number(state?.coverage?.weigh_in_span_days) || 0)),
  };

  // ---- rule 1 + 3: which maintenance estimate, and how sure ------------------
  const outcome = finite(state?.outcome_tdee);
  const prior = finite(state?.prior_tdee);
  const grounded = cutEvidenceIsGrounded(coverage, outcome);
  const bandLow = finite(state?.plausible_tdee_min) ?? 0;
  const bandHigh = finite(state?.plausible_tdee_max) ?? Number.POSITIVE_INFINITY;

  let tdee: number;
  let tdeeBasis: CutTdeeBasis;
  let outlierClamped = false;
  if (grounded && outcome != null) {
    // The outlier guard is the SAME physiological band estimateExpenditure judges
    // its own outcome against, so a reading it calls implausible cannot set a
    // target here either — it is pulled to the nearest edge rather than dropped,
    // which keeps the evidence in play at a stated lower confidence (rule 2).
    const bounded = clamp(outcome, bandLow, bandHigh);
    outlierClamped = Math.round(bounded) !== Math.round(outcome);
    tdee = Math.round(bounded);
    tdeeBasis = "logged_reality";
  } else if (prior != null) {
    tdee = Math.round(clamp(prior, bandLow, bandHigh));
    tdeeBasis = "formula_estimate";
  } else if (outcome != null) {
    // Grounding failed AND there is no prior at all: the outcome is still the only
    // measurement in the room. Use it, clamped, at the lowest confidence.
    tdee = Math.round(clamp(outcome, bandLow, bandHigh));
    tdeeBasis = "formula_estimate";
    outlierClamped = Math.round(tdee) !== Math.round(outcome);
  } else {
    return null; // genuinely nothing to estimate from
  }

  let confidence: CutTargetConfidence = "low";
  if (tdeeBasis === "logged_reality") {
    // "High" asks for a record that describes a whole month rather than a corner
    // of one: near-daily intake and a weigh-in habit spanning the window.
    confidence =
      coverage.intake_days >= 20 && coverage.weigh_ins >= 8 && coverage.weigh_in_span_days >= 21 ? "high" : "moderate";
    if (outlierClamped) confidence = "low";
  }

  // ---- rule 4: the pace the law allows, then the pace the date wants ---------
  const paceBandMin = CUT_PACE_MIN_PCT * weight;
  const paceBandMax = CUT_PACE_MAX_PCT * weight;
  // The leanness taper is a SAFETY ceiling, and a safety ceiling never relaxes to
  // accommodate a date. It can only narrow the band, never widen it.
  const leanSafeMax = finite(leannessAwareLossRates(weight, state?.body_fat_pct ?? null).safe_max_rate_lb);
  const effectiveMax = Math.max(0.01, leanSafeMax == null ? paceBandMax : Math.min(paceBandMax, leanSafeMax));
  const effectiveMin = Math.min(paceBandMin, effectiveMax);

  const goalDate = /^\d{4}-\d{2}-\d{2}$/.test(String(state?.goal_date ?? "")) ? String(state.goal_date) : null;
  const goalEpoch = goalDate == null ? null : dayEpoch(goalDate);
  const weeksToGoalDate = goalEpoch == null ? null : (goalEpoch - today) / (7 * DAY_MS);
  // A goal date already in the past asks for an infinite pace, which is the same
  // question as "faster than allowed" and gets the same answer.
  const paceWanted =
    weeksToGoalDate == null ? null : weeksToGoalDate > 0 ? lbsToLose / weeksToGoalDate : Number.POSITIVE_INFINITY;
  const paceChosen = paceWanted == null ? effectiveMin : clamp(paceWanted, effectiveMin, effectiveMax);

  const deficitWanted = Math.round((paceChosen * KCAL_PER_LB) / 7);
  const deficit = Math.round(clamp(deficitWanted, CUT_DEFICIT_MIN_KCAL, CUT_DEFICIT_MAX_KCAL));

  // ---- the number itself ----------------------------------------------------
  const rawTarget = roundTo(tdee - deficit, TARGET_ROUNDING_KCAL);
  const steppedTarget = Math.max(KCAL_ABSOLUTE_FLOOR, rawTarget);

  // ---- rule 5: does this week get the step, or hold? ------------------------
  // Only a DEEPENING waits. A target that would rise, or stay where it is, is not
  // the increment this rule is about and passes straight through.
  const demand = state?.training_demand ?? null;
  const activeTarget = finite(state?.active_target_kcal);
  let deepeningHeld = false;
  let target = steppedTarget;
  if (demand?.high === true && activeTarget != null && steppedTarget < activeTarget) {
    // The hold is a RAISE relative to the step this week wanted, so it goes through
    // the one function allowed to lift a target. Measured maintenance is therefore
    // the ceiling of the hold as well, and an unmeasured one refuses it outright.
    const held = capProtectiveRaise(activeTarget, steppedTarget, tdee, tdeeBasis);
    target = Math.round(held.target_kcal);
    deepeningHeld = target > steppedTarget;
  }
  // Read the delivered deficit back off the target that survived every clamp, so
  // the pace reported is the pace this number actually buys — not the one asked
  // for before the kcal floor had its say.
  const deliveredDeficit = Math.max(0, tdee - target);
  const paceDelivered = (deliveredDeficit * 7) / KCAL_PER_LB;
  const paceCapped = paceWanted != null && paceWanted > paceDelivered + 0.01;

  // ---- rule 4: the date that pace actually reaches --------------------------
  let projected: string | null = null;
  if (paceDelivered > 0.01) {
    const daysNeeded = Math.ceil((lbsToLose / paceDelivered) * 7);
    projected = addDaysISO(String(state.today).slice(0, 10), daysNeeded);
  }
  let adaptation: CutGoalDateAdaptation | null = null;
  if (goalDate && projected && projected > goalDate) {
    // The derivation stays PURE and reports every slip it sees, however small. What is
    // worth moving a goal date FOR is decided at the seam that records the decision
    // (maybeAdaptGoalDateFromCut), and its materiality bar is a fortnight — so any slip
    // that reaches a person carries weeks_added >= 2 and the floor below never binds.
    const weeksAdded = Math.max(1, Math.round(((dayEpoch(projected)! - goalEpoch!) / DAY_MS / 7) * 10) / 10);
    adaptation = {
      from: goalDate,
      to: projected,
      weeks_added: weeksAdded,
      reason: `Reaching ${goalWeight} lb by ${goalDate} would need a faster weekly loss than the lean-safe ceiling allows, so the deficit stays at ${deficit} kcal and the arrival date moves out to ${projected}.`,
    };
  }

  // What the number actually stood on. When the plate has gone quiet, the estimate
  // is led by the scale and a metabolic prior BY DESIGN — describing it as a record
  // that has not thickened yet would read as a complaint about missing logs and
  // would misdescribe where the number came from.
  const intakeMode = state?.intake_mode ?? null;
  const basisWords =
    tdeeBasis === "logged_reality"
      ? `logged intake over ${coverage.intake_days} complete days measured against ${coverage.weigh_ins} weigh-ins spanning ${coverage.weigh_in_span_days} days`
      : intakeMode === "quiet"
        ? `the measured weight trend and a metabolic prior, since meals are not being logged over the trailing ${coverage.window_days} days`
        : "a formula and activity estimate, because the logged record is not yet thick enough to measure maintenance";
  const proteinFloor = finite(state?.protein_floor_g);

  // MACHINE register, appended rather than substituted: the basis sentence is what
  // the provenance trail is read for, and the hold is a second fact about the same
  // number, not a replacement for the first.
  const holdWords = deepeningHeld
    ? ` The next step down is holding at the ${target} kcal already in force — this week is one of the block's bigger asks (${
        demand?.basis?.length ? demand.basis.join(", ") : "high training demand"
      }) — and it comes at the next ordinary week.`
    : "";

  return {
    target_kcal: target,
    protein_g: proteinFloor == null ? null : Math.round(proteinFloor),
    tdee_kcal: tdee,
    tdee_basis: tdeeBasis,
    confidence,
    deficit_kcal: deliveredDeficit,
    pace_lb_wk: Math.round(paceDelivered * 100) / 100,
    pace_capped: paceCapped,
    outlier_clamped: outlierClamped,
    goal_date: goalDate,
    projected_goal_date: projected,
    goal_date_adaptation: adaptation,
    coverage,
    intake_mode: intakeMode,
    training_demand: demand,
    deepening_held: deepeningHeld,
    reason: `Maintenance estimated at ${tdee} kcal from ${basisWords}; the cut target holds a ${deliveredDeficit} kcal deficit, about ${(Math.round(paceDelivered * 100) / 100).toFixed(2)} lb a week.${holdWords}`,
  };
}

// ---- protection buys maintenance, never a surplus ----------------------------

export interface ProtectiveRaiseCap {
  target_kcal: number;
  capped: boolean;
}

/**
 * The ceiling on a PROTECTIVE raise: measured maintenance.
 *
 * The grounded ceiling above (rule 3, `target_kcal`) has one deliberate escape —
 * fresh under-fuelling evidence, which is exactly the grounded evidence the rule
 * asks for and so passes straight through it. That escape had no ceiling of its
 * OWN, and the evidence that opens it (heavy endurance load during a cut) is a
 * CHRONIC condition rather than an event: every check-in found the escape open and
 * added another bounded step, and the target ratcheted past maintenance and kept
 * going. A cut fuelled above maintenance is not a protected cut, it is a surplus.
 *
 * So: protection may lift the target all the way TO measured maintenance, and no
 * further. And, exactly as the grounded clamp does, it can never push the target
 * BELOW the number already in force — refusing a raise is a hold, never a cut
 * nobody asked for.
 *
 * ONLY A MEASURED MAINTENANCE MAY LIFT THE CEILING. `tdee_basis` decides that, and
 * it is a required argument rather than an optional one so no future caller can
 * forget to hand it over. When grounding failed the derivation still reports a
 * number — the Mifflin prior — and reading that as headroom is how a formula
 * estimate, which knows nothing about this athlete's record, came to authorize a
 * raise the record had already outrun. So on any basis other than `logged_reality`
 * the ceiling is `previous`: protection HOLDS the target where it is, because
 * protection cannot buy a surplus on an unmeasured maintenance.
 *
 * `tdee_kcal` absent or unreadable is a different case and keeps its own answer:
 * there is no ceiling to run this cap against at all, so it does not run and the
 * caller's own bounded step is the only bound. A present-but-formula figure is not
 * silence — it is a positive statement that maintenance is unmeasured.
 *
 * PURE. Shared by the check-in boundary (`personalizeNutritionCheckinTarget`), the
 * apply-time revalidation at a natural boundary, and rule 5's high-demand hold
 * above, so no two of them can disagree about what a lift is allowed to buy.
 */
export function capProtectiveRaise(
  target: number,
  previous: number,
  tdeeKcal: number | null | undefined,
  tdeeBasis: CutTdeeBasis | null | undefined
): ProtectiveRaiseCap {
  const tdee = finite(tdeeKcal);
  if (tdee == null || !Number.isFinite(target) || !Number.isFinite(previous)) {
    return { target_kcal: target, capped: false };
  }
  // Only a RAISE is ever capped. A hold or a lower target is the ordinary path.
  if (target <= previous) return { target_kcal: target, capped: false };
  const ceiling = tdeeBasis === "logged_reality" ? Math.max(previous, tdee) : previous;
  if (target <= ceiling) return { target_kcal: target, capped: false };
  return { target_kcal: Math.round(ceiling), capped: true };
}

// ---- the words a person reads ------------------------------------------------
//
// Variant sets, not literals (VISION.md Amendment 2), rotated by `pickDayVariant`
// on the date so a stable derivation never prints the same sentence for weeks.
// Adherence-neutral register: a thin record is described as an estimate that will
// sharpen, never as something the athlete failed to supply.

const GROUNDED_BODIES: readonly string[] = [
  "This comes from what you actually ate and what the scale actually did — it keeps updating as both do.",
  "Your own logged food and weigh-ins set this number, and they keep setting it as they come in.",
  "Read straight off your record rather than a formula, so it moves when your record moves.",
  "Built from your logged days and your weigh-ins; it will keep tracking them.",
];

const ESTIMATE_BODIES: readonly string[] = [
  "That's an estimate for now — a few more logged days and weigh-ins will sharpen it.",
  "A starting estimate. It gets more exact as food logs and weigh-ins accumulate.",
  "Still an estimate rather than a measurement, and it tightens as the record fills in.",
  "This leans on the wider picture for now; your own logged days will take it over.",
];

// The same estimate register, for a record that is not filling in because meals
// are not being logged — by choice, not by omission. The ESTIMATE_BODIES promise
// that "a few more logged days will sharpen it" is both untrue and a nudge here;
// what actually sharpens this number is the scale and the tape, which the
// measurement-request module already asks for on its own schedule.
const OUTCOME_LED_BODIES: readonly string[] = [
  "With meals off the log, this leans on the scale and your metabolic picture instead — weigh-ins are what keep it honest.",
  "This one is read from the scale rather than the plate, so weigh-ins are what move it.",
  "There's no food log under this number right now; it tracks your weight trend and a metabolic estimate.",
  "Built from the scale and the tape rather than the diary, which is a perfectly good way to run a cut.",
];

// Rule 5 in the athlete's register. The week is described, never scored, and the
// hold is a choice the coach made rather than something the athlete has to do.
const DEEPENING_HELD_BODIES: readonly string[] = [
  "Your training week is one of the bigger ones, so your food stays where it is — the next step down can wait for a quieter week.",
  "There's a lot of work in this week, so this number is staying put rather than dropping again; it'll step when the week is an ordinary one.",
  "Heavy week on the training side, so your fuel holds here. The next step happens once the block eases off.",
  "This week asks a lot of you, so the calories stay steady instead of tightening — the step is only waiting, not gone.",
];

export function cutTargetBody(derivation: CutTargetDerivation, date: string): string {
  const set = derivation.deepening_held
    ? DEEPENING_HELD_BODIES
    : derivation.tdee_basis === "logged_reality"
      ? GROUNDED_BODIES
      : derivation.intake_mode === "quiet"
        ? OUTCOME_LED_BODIES
        : ESTIMATE_BODIES;
  return pickVariant(set, date, "cut_target_body");
}

// Local copy of the day-variant rotation rather than an import from
// brain/day-read-rules.js: this module sits under the nutrition read and must not
// pull the day-read rule engine in behind it.
function pickVariant<T>(variants: readonly T[], date: string, key = ""): T {
  if (variants.length <= 1) return variants[0];
  const ms = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`);
  const dayIndex = Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : 0;
  let offset = 0;
  for (let i = 0; i < key.length; i++) offset = (offset * 31 + key.charCodeAt(i)) % 9973;
  const span = variants.length;
  return variants[(((dayIndex + offset) % span) + span) % span];
}

// One flat pool of every athlete-facing literal this module can produce, so a
// grammar test can enumerate the vocabulary wholesale rather than sampling it.
export function cutTargetGrammarPool(): string[] {
  return [...GROUNDED_BODIES, ...ESTIMATE_BODIES, ...OUTCOME_LED_BODIES, ...DEEPENING_HELD_BODIES];
}

// ---- the thin DB-facing read -------------------------------------------------

/**
 * Assemble the state the decision core needs. One expenditure read (memoized in
 * expenditure.ts) plus the profile, so a caller pays for a single pass.
 *
 * `expenditure` may be handed in by a caller that already has one — the whole
 * nutrition surface shares a single estimate per request, and re-reading it here
 * would double the cost of every check-in.
 */
export function cutTargetState(
  asOf: string = localDateISO(),
  opts: { expenditure?: ReturnType<typeof estimateExpenditure> | null } = {}
): CutTargetState {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf)) ? String(asOf) : localDateISO();
  const profile = getProfile() as any;
  const resolved = resolvedCurrentBodyweight(profile, today);
  const weight = finite(resolved?.weight_lb) ?? finite(profile?.weight_lb);

  let estimate: ReturnType<typeof estimateExpenditure> | null = null;
  if (opts.expenditure !== undefined) {
    estimate = opts.expenditure;
  } else {
    try {
      estimate = estimateExpenditure(CUT_EVIDENCE_WINDOW_DAYS, { asOf: today });
    } catch {
      estimate = null;
    }
  }

  let proteinFloor: number | null = null;
  let activeTarget: number | null = null;
  try {
    // The protein already in force wins; the goal formula only ever floors it. The
    // same accepted row carries the calories rule 5 measures a deepening against,
    // so one read answers both.
    const accepted = getLatestNutritionTarget(today);
    proteinFloor = finite(accepted?.protein_g);
    activeTarget = finite(accepted?.target_kcal);
  } catch {
    proteinFloor = null;
    activeTarget = null;
  }
  if (proteinFloor == null && weight != null) proteinFloor = Math.round(weight);

  let bodyFat: number | null = null;
  try {
    bodyFat = finite(currentBodyFatEstimate(profile)?.body_fat_pct);
  } catch {
    bodyFat = null;
  }

  // Is the plate still being logged at all? Read over the SAME trailing window the
  // grounding floor reads, so the basis words and the evidence they describe can
  // never be talking about different fortnights.
  // "unknown" is the read declining to answer, and it is normalized to null here
  // for the same reason the catch is: an unread habit must leave the derivation
  // describing its basis exactly as it did before this field existed, never
  // borrowing the outcome-led words a genuinely quiet plate earns.
  let mode: KnownIntakeLoggingMode | null = null;
  try {
    const read = intakeLoggingMode(CUT_EVIDENCE_WINDOW_DAYS, today);
    mode = read === "unknown" ? null : read;
  } catch {
    mode = null;
  }

  return {
    today,
    weight_lb: weight,
    goal_weight_lb: finite(profile?.goal_weight_lb),
    goal_date: /^\d{4}-\d{2}-\d{2}$/.test(String(profile?.goal_date ?? "")) ? String(profile.goal_date) : null,
    body_fat_pct: bodyFat,
    outcome_tdee: finite(estimate?.outcome_tdee),
    prior_tdee: finite(estimate?.prior_tdee) ?? finite(estimate?.tdee),
    plausible_tdee_min: finite(estimate?.quality?.plausible_tdee_min) ?? 1_200,
    plausible_tdee_max: finite(estimate?.quality?.plausible_tdee_max) ?? 8_000,
    coverage: {
      window_days: CUT_EVIDENCE_WINDOW_DAYS,
      // COMPLETE days only. A partial day is absent evidence, never a low-intake
      // day (the intake-coverage law, src/repo/intake-window.ts) — counting one
      // toward the grounding floor is how a fortnight of logged breakfasts came to
      // vouch for a maintenance number measured against a whole day's eating.
      intake_days: Number(estimate?.coverage?.credible_intake_days) || 0,
      weigh_ins: Number(estimate?.coverage?.weigh_in_days) || 0,
      weigh_in_span_days: Number(estimate?.coverage?.weigh_in_span_days) || 0,
    },
    intake_mode: mode,
    protein_floor_g: proteinFloor,
    active_target_kcal: activeTarget,
    training_demand: cutTrainingDemand(today),
  };
}

/**
 * Is the week this target would be eaten in one of training's big asks?
 *
 * Two reads, neither of them re-derived here:
 *
 *   - the BLOCK's own phase, through `strengthBlockPeaking` — the shared predicate
 *     the combined-load policy and run-progression's race-ramp pull already read.
 *     A third copy of "which phases are the heavy ones" is exactly how those two
 *     would drift apart.
 *   - the COMBINED stress budget (`hybrid.combined_load`, program-state.ts), which
 *     is non-null only when BOTH lanes' acute:chronic ratios sit in their upper
 *     caution band at once — the acute top band, already computed, already floored
 *     against a thin base.
 *
 * Consulted in that order and short-circuited, so the cheap block read answers the
 * common case and the heavier (memoized) program-state read is only paid for when
 * it can still change the answer.
 *
 * Fail-SOFT: an unreadable week is an ORDINARY week, never a hold. A hold that
 * fires on a read error would quietly park the cut.
 */
function cutTrainingDemand(today: string): CutTrainingDemand {
  let phase: string | null = null;
  const basis: CutTrainingDemandBasis[] = [];
  try {
    const block = activeBlockContext(today);
    phase = block?.phase ?? null;
    if (strengthBlockPeaking(block)) basis.push("block_phase");
  } catch {
    phase = null;
  }
  if (basis.length === 0) {
    try {
      if (getProgramState(today)?.hybrid?.combined_load) basis.push("combined_load");
    } catch {
      /* an unreadable stress budget is an ordinary week */
    }
  }
  return { high: basis.length > 0, basis, phase };
}

// The whole derivation in one call: assemble, then decide. Read-only.
export function deriveCutTarget(
  asOf: string = localDateISO(),
  opts: { expenditure?: ReturnType<typeof estimateExpenditure> | null } = {}
): CutTargetDerivation | null {
  return cutTargetDecision(cutTargetState(asOf, opts));
}

// ---- is this cut the athlete's own, and still standing? ----------------------

export type CutReaffirmationSource = "never_asked" | "answered" | "converged" | "open_question" | "not_a_cut";

export interface CutReaffirmation {
  reaffirmed: boolean;
  source: CutReaffirmationSource;
  // The day the goal was last confirmed or set, when one is on record.
  stamped: string | null;
}

// The signal key the goal check-in files under (src/repo/goal-checkin.ts). Read
// here rather than imported so this module does not pull the Today-agenda types in
// behind goal-checkin.ts.
const GOAL_CHECKIN_SIGNAL_KEY = "journey:goal-checkin";

/**
 * Is the athlete in a cut they have affirmed, rather than one the system inferred
 * and they have never been asked about?
 *
 * The answer rides machinery that already exists. `confirmGoalCheckin` /
 * `reactivateGoalCheckin` stamp the shared attention schedule every time the goal
 * is confirmed, waved off or changed, and the tier ladder converges to `released`
 * for a goal that has held through several asks. So:
 *
 *   - no entry at all      → never asked. The goal is the one the athlete set, so
 *                            it stands. (`never_asked`)
 *   - released, or not due → they have answered, or the question has converged.
 *                            The cut stands. (`answered` / `converged`)
 *   - due and unanswered   → the system is currently ASKING whether this is still
 *                            the goal. While that question is open the cut is not
 *                            reaffirmed, and a transition may be proposed.
 *
 * Deliberately fail-SAFE toward honoring the cut: every branch except a live,
 * unanswered question reads as reaffirmed, because proposing maintenance to
 * someone mid-cut reads as being told to gain weight, and that is the costlier
 * error by a wide margin.
 */
export function cutReaffirmation(asOf: string = localDateISO()): CutReaffirmation {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf)) ? String(asOf) : localDateISO();
  const profile = getProfile() as any;
  if (!profile) return { reaffirmed: false, source: "not_a_cut", stamped: null };
  if (effectiveGoalMode(profile) !== "lose") return { reaffirmed: false, source: "not_a_cut", stamped: null };
  const resolved = resolvedCurrentBodyweight(profile, today);
  const weight = finite(resolved?.weight_lb) ?? finite(profile?.weight_lb);
  const goalWeight = finite(profile?.goal_weight_lb);
  if (weight == null || goalWeight == null || weight - goalWeight <= 0)
    return { reaffirmed: false, source: "not_a_cut", stamped: null };

  let entry: ReturnType<typeof getAttentionSchedule> = null;
  try {
    entry = getAttentionSchedule(GOAL_CHECKIN_SIGNAL_KEY);
  } catch {
    entry = null;
  }
  if (!entry) return { reaffirmed: true, source: "never_asked", stamped: null };
  const stamped = entry.last_checked || null;
  if (entry.tier === "released") return { reaffirmed: true, source: "converged", stamped };
  if (!entry.next_due || entry.next_due > today) return { reaffirmed: true, source: "answered", stamped };
  return { reaffirmed: false, source: "open_question", stamped };
}

/**
 * Is a cut phase actually running right now?
 *
 * Reads `journey_phases` directly instead of importing `activeJourneyPhase`, so
 * journey.ts can depend on THIS module (it gates its own transition suggestions on
 * `cutReaffirmation`) without the two forming a cycle. The same one-query pattern
 * `recompositionStageAt` uses in profile.ts, for the same reason.
 */
export function activeCutPhaseKind(): string | null {
  try {
    const row = db
      .prepare(
        `SELECT kind FROM journey_phases WHERE status = 'active'
          ORDER BY COALESCE(start_date, created_at) DESC, id DESC LIMIT 1`
      )
      .get() as any;
    const kind = row?.kind == null ? null : String(row.kind);
    return kind || null;
  } catch {
    return null;
  }
}

/**
 * The gate rule 1 of the owner's ruling asks for, in one predicate.
 *
 * True when the system may propose maintenance / a diet break ON ITS OWN. False
 * while the athlete is in a reaffirmed cut — which does NOT stop them from asking
 * for one, and does not stop a grounded ease of the deficit; it stops the SYSTEM
 * from volunteering a phase that reads as "start gaining weight again" without
 * logged evidence asking for it.
 */
export function mayProposeEaseFromCut(asOf: string = localDateISO()): boolean {
  const phase = activeCutPhaseKind();
  // Nothing to ease out of unless a cut is what is running (an absent phase with a
  // lose-mode goal is still a cut in everything but bookkeeping).
  if (phase != null && phase !== "cut") return true;
  return !cutReaffirmation(asOf).reaffirmed;
}
