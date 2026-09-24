// ============================================================================
// progression.ts — the per-session auto-progression engine (MacroFactor-for-
// lifting). Deterministic, no agent, NO scores. It closes the loop: it reads
// what the athlete ACTUALLY logged (the latest top set + RIR) and the lift's
// program-state trajectory, and proposes the NEXT session's target — the small
// earned overload, the hold, the deload, the variation. Mirrors the
// program-state deterministic-floor pattern; the agentic plan-evolution loop
// (buildProgramEvolutionPrompt) sits on TOP of this, never replaces it.
//
// Constitution: everything here is a SUGGESTION the athlete drives. Nothing
// auto-applies — a prescription becomes a plan change only through the existing
// propose→apply path. Plain words only ("+5 lb", "hold 50", "−10%"), never a
// 0-100 score. Encoding honored: weight null = bodyweight, negative = assist
// (e.g. −30 = 30 lb assist); timed lifts progress in seconds, never load.
// ============================================================================
import { db } from "../db.js";
import { plausibleRir, round5 } from "../lib/numbers.js";
import {
  canonicalGroup,
  classifyConstraint,
  classifyMuscleGroup,
  detectExerciseMode,
  exerciseIdentityKey,
  isMobility,
  isPrepMovement,
  movementKey,
  type MuscleGroup,
  MUSCLE_LANDMARKS,
  normalizedExerciseKey,
  normalizeExerciseName,
  plainGroupWords,
  progressionLineageIds,
  resolveExerciseName,
  trainingRowsSignature,
} from "./exercise-canon.js";
import {
  classifyPattern,
  type Equipment,
  effectiveVolumeByGroup,
  examplesForGroup,
  type ExerciseVariation,
  suggestAlternatives,
  type VolumeSet,
} from "./exercise-variations.js";
import {
  achievableWorkingWeight,
  findExercise,
  getExercise,
  recentWorkingSeconds,
  recentWorkingWeight,
  unassistedProvenSessions,
} from "./exercises.js";
// The equipment profile and the learned like/dislike memories are leaf reads the
// prescription consumes; they live in their own modules so this engine keeps to
// prescription, autoregulation and the proposal builders.
import { availableEquipment } from "./equipment.js";
import { type ParsedPreference, learnedPreferences, preferenceRerank } from "./exercise-preferences.js";
import { getSettings } from "./settings.js";
import { relatedLiftStart } from "./related-lift.js";
import {
  type AcuteGateReading,
  acuteGates,
  enduranceDose,
  loadPhrase,
  recentEnduranceImpacts,
} from "./hybrid-load.js";
// Every athlete-facing sentence this engine says lives in ONE vocabulary module as
// a SET of phrasings, rotated per day and per exercise — never a literal here. See
// the contract at the top of progression-voice.ts.
import * as voice from "./progression-voice.js";
import { lightWeekExemption } from "./volume-floor-context.js";
import {
  type Exposure,
  planSlotStamps,
  sessionFirstSetAt,
  sinceClause,
  type SlotAuthorship,
  slotAuthorship,
  slotStamp,
} from "./prescription-authorship.js";
import { painAreaLoadsGroup } from "./pain-relevance.js";
import {
  bouncedOffLoadStep,
  coarseLoadStep,
  isIsolationLift,
  lastAppliedRepRangeMove,
  movedRepRange,
} from "./lift-response.js";
export { painAreaLoadsExercise } from "./pain-relevance.js";
import {
  appliedProgressionDeloads,
  appliedProgressionEscalations,
  getPlan,
  pressSlotKey,
} from "./plan.js";
// PERIODIZATION. The active block's phase changes what a main lift is prescribed
// (see the policy table in program-blocks.ts). No block active → nothing here fires.
import {
  type ActiveBlockContext,
  activeBlockContext,
  type PhaseProgressionPolicy,
  phaseProgressionPolicy,
} from "./program-blocks.js";
// THE THREE LEARNED SEAMS the decision consults but never obeys blindly: how much
// this lift's est-1RM deserves to be trusted, what the ledger's own verdicts said
// about it, and whether the movement itself has been flagged as one to be careful
// with. Each answers a today's-world neutral value until the learning loop fills
// it in, so every branch below has to be correct for both.
import { type UnverifiedRegressionHold, unverifiedRegressionHold } from "./calibration.js";
import { movementRiskFor } from "./movement-risk.js";
import { type PainBandRead, painBandForMovement } from "./pain-band.js";
import { cutQualityRead } from "./cut-quality.js";
import { atOrNearGoal } from "./goal-proximity.js";
import type { CoachPersonalModifier, CoachWhatWorksForYou } from "../brain/coach-context-contract.js";
import { applyPersonalResponseModifier, liftLedgerRead, whatWorksForYou } from "./reaction-model.js";
// createProposal + the auto-progression dedup live in profile.js; imported here (as
// run-progression.ts does for buildRunPlanProposal) so REST + MCP share ONE proposal
// builder instead of duplicating the change-shaping logic (and drifting).
import { createProposal, setProposalStatus, supersedeAutoProgressionDrafts } from "./proposals.js";
import {
  VOLUME_RESTORE_AGENT,
  VOLUME_RESTORE_INSTRUCTION,
  type VolumeCutCause,
  openVolumeRestoreDraftIds,
  openVolumeRestoreTargets,
  volumeRestorePayload,
} from "./volume-guard.js";
import { type LiftState, getProgramState, LIFT_CURRENT_WINDOW_DAYS } from "./program-state.js";
import { coachContextBackstopSignature, registerTrainingCacheClear } from "./training-cache.js";
import { addDaysISO, daysBetweenISO, localDateISO, round2_5 } from "./shared.js";
import { easedLoad, isIsolationGroup, STEP_CEIL_COMPOUND, STEP_CEIL_ISOLATION } from "./load-grid.js";
import { supportWorkRead } from "./support-work.js";
// Run-plan / DEXA / test-week digest producers. Imported for their types + a lazy
// compute when programAdjustments is called standalone (Today/Progress). The module
// cycle (progression → run-progression → coach → progression) is resolved at call
// time — these are only invoked inside programAdjustments, never at module init.
import { enduranceTestsDue, weeklyRunPlan, type WeeklyRunPlan } from "./run-progression.js";
import { dexaTargeting, type DexaTargeting } from "./dexa-targeting.js";
import { testWeekDue, type TestWeekDue } from "./muscle-trajectory.js";
import { trainingPlaybook, type TrainingPlaybookRead } from "./training-playbook.js";
import { currentUnderfuelingRead } from "./underfueling-snapshot.js";
import type { UnderfuelingRead } from "./underfueling.js";
import { latestSessionIdOnDate, sessionLogContradictsLowRating } from "./session-dose-log.js";
import { recentMovementResponse, type RecentMovementResponseVerdict } from "./training-response.js";
import {
  doseComparability,
  enduranceLoadedGroups,
  enduranceOverlapsMovement,
  OUTCOME_FACTS_SCHEMA_VERSION,
} from "./daily-reconciliation.js";
import { harderLoad, loadAtOrAbove } from "./outcome-comparability.js";

export {
  loadPhrase,
  recentMuscleLoad,
  muscleLoadPayload,
  type RecentLoad,
  type MuscleLoadPayload,
  type MuscleLoadGroup,
} from "./hybrid-load.js";

// ---- progression-step caps (mirrors applyProposal's clamp intent, tighter) ---
// A per-session step is a SMALL earned nudge, never a jump. The cap is the
// SMALLER of a fraction of the current load OR a flat ceiling — compounds get a
// 5 lb ceiling, isolation work 2.5 lb (a sane minimum plate jump), and the
// fraction (10%) keeps very light loads from ever leaping. Clamping happens
// here so a prescription is always safe BEFORE it ever reaches propose→apply.
const STEP_FRAC = 0.1; // ≤10% of the current load…
// …or the lift's own PROPORTIONAL ceiling, whichever is smaller. A flat 5 lb cap
// made a 250 lb squat and a 100 lb press earn the identical increment, which is a
// rounding error on one and a real week's work on the other. The ceiling is a small
// fraction of what is actually on the bar, floored at the minimum plate jump the
// lift deserves (so nothing gets SMALLER than it used to be) and rounded onto the
// 2.5 lb plate grid. Below ~200 lb this reproduces the old flat cap exactly.
const STEP_CEIL_FRAC = 0.025;
// The compound floor (5 lb) and isolation floor (2.5 lb) are STEP_CEIL_COMPOUND /
// STEP_CEIL_ISOLATION in load-grid.ts, the one plate grid every easing rounds onto.
// Timed holds progress by a RELATIVE step — a fraction of the current hold, clamped to
// a sane floor/ceiling — so a 20s plank and a 120s dead hang each progress proportionally
// (a flat +N is trivial on a long hold and a huge jump on a short one). Timed work moves
// in SECONDS, never load.
const SECONDS_STEP_FRAC = 0.1; // ~10% of the current hold…
const SECONDS_STEP_MIN = 3; // …never smaller than 3s (a real nudge on a short hold)
const SECONDS_STEP_MAX = 20; // …never larger than 20s in one step (a long hold doesn't leap)
// LOADED timed work (a carry, a weighted hold) double-progresses: seconds climb to a
// hold ceiling first, and only once EVERY set owns the ceiling does the load take one
// step while the seconds reset lower. Never both at once. A prescription already past
// the ceiling is its own ceiling.
const LOADED_HOLD_CEILING_SEC = 60;
const LOADED_HOLD_RESET_FRAC = 2 / 3; // 60s → 40s after a load step
const DELOAD_FRAC = 0.1; // a deload backs the load off ~10%
// Reps genuinely in hand. At RIR ≥ 2 the set was finished with room to spare; at
// RIR ≤ 1 it was a grind. The one place the engine draws that line.
const RIR_IN_RESERVE = 2;
// A REPEAT deload inside this window is not another identical cut — the second one
// escalates structurally (a lower rep window, or the movement itself rotates). See
// the escalation branch in repsPrescription and appliedProgressionDeloads (plan.ts).
const DELOAD_REPEAT_DAYS = 56;
// How long a lift sits flat before a variation is offered — and how much longer it
// gets while the athlete is in a genuine deficit. A flat lift on a real cut is muscle
// HELD, not a stall, and a cut is the worst moment to trade a readable movement for
// an unfamiliar one.
const PLATEAU_VARY_WEEKS = 3;
const PLATEAU_CUT_PATIENCE_WEEKS = 2;
const DELOAD_WAVE_FRAC = 0.05; // the escalated wave eases load only slightly; the SHAPE changes
const WAVE_REP_FLOOR = 3; // a rep wave never drops below a genuinely heavy triple
// Peak week's top set, as a fraction of the lift's best estimated single. The
// confident version is a true heavy single; the cautious one (a deep cut, or an
// estimate nothing recent has confirmed) is a double a touch lighter. BOTH sit
// above the fraction detectStrengthCalibration counts as a verifying set, so a
// logged peak actually re-anchors the estimate instead of just feeling heavy.
const PEAK_TOP_FRAC_CONFIDENT = 0.95;
const PEAK_TOP_FRAC_CAUTIOUS = 0.93;
const PEAK_BACKOFF_FRAC = 0.85;
// How far back the est-1RM history is read — mirrors calibration.ts's own window so
// the peak target is derived from the same number a verifying set is measured against.
const PEAK_HISTORY_DAYS = 400;
// A movement run this long (steady, not stalled) is ripe for PROACTIVE variety —
// introduce a fresh variation before staleness sets in, at a block boundary, rather
// than waiting for a measured plateau. Tenure = weeks since the lift was first logged.
const INTRODUCE_TENURE_WEEKS = 12;

// How far a target may sit above the log's achievable load before it re-grounds:
// Epley is an estimate, and a load the athlete just stepped up to sits a little past
// it while the reps fill in — that is reaching, not out of reach.
const REACHABLE_TOLERANCE = 1.05;
// How many of the last three sessions must show unassisted working sets (≥ 2 sets at
// the plan's rep floor, bodyweight or loaded) before an assist target is retired.
// Two of three: one good day is a good day; two is where the athlete is.
const ASSIST_RETIRE_SESSIONS = 2;

export type ProgressionAction = "overload" | "hold" | "deload" | "vary" | "introduce";

export interface PrescriptionTarget {
  sets: number;
  rep_low?: number;
  rep_high?: number;
  weight?: number | null; // null = bodyweight; negative = assist
  seconds?: number;
}

export interface Prescription {
  exercise: string;
  mode: "reps" | "timed";
  action: ProgressionAction;
  suggested: PrescriptionTarget;
  current: PrescriptionTarget | null; // from the plan item, when planned
  delta_text: string; // plain words: "+5 lb", "hold 50", "−10%", "+5s"
  why: string;
  reground?: boolean; // the plan target was behind (or out of reach of) logged reality — applying re-grounds it
  // The suggested load is a conservative idea taken from a RELATED lift, not this
  // movement's own history — true only while nothing has been logged for it. It is
  // deliberately never written to plan_items (see related-lift.ts): the first
  // logged set replaces it, and a stored guess would outlive the sessions that
  // contradict it.
  starting_idea?: boolean;
  vary_to?: string; // a concrete same-pattern variation to rotate in (action "vary")
  vary_options?: { name: string; why: string }[]; // a MENU of same-pattern swaps (action "vary"); vary_to is the lead
  plan_item_id?: number; // set by planDayProgression for the apply path
  day_number?: number; // set by planDayProgression — the day the lift sits on (for the swap apply path)
  autoregulated?: boolean; // recovery signals braked this step (overload→hold / hold→deload) — informational
  // A protective FUEL read cut this prescription's volume (applyFuelProtection's
  // recovery dose). It rides the proposal into the restore ledger as the cut's
  // `cause`, so the fuel loop's climb back speaks about fuel and never re-tells that
  // story over a cut something else asked for. See repo/volume-guard.ts.
  fuel_protected?: boolean;
  // A RED pain band took this movement's load down. Recorded for the same reason
  // `fuel_protected` is, and it earns the same exemption from the deload audit
  // trail: the repeat-deload ladder exists to notice that CUTTING LOAD is not
  // working for a lift, and a cut the athlete's own pain report asked for says
  // nothing about that. Marking it would make the next ordinary deload read as a
  // "repeat" and escalate a rep wave or rotate the movement out — a structural
  // change nobody's knee asked for. Informational only; nothing on the apply path
  // acts on it.
  pain_protected?: boolean;
  movement_response?: RecentMovementResponseVerdict; // repeated comparable dose evidence that supported or braked the step
  rep_step?: boolean; // double-progression REP advance (load held, reps climb in-range) — no plan change
  // The plan's SET COUNT catching up to what the log shows (setCatchUp): the last two
  // exposures each carried more good working sets than prescribed, so the item takes
  // one set toward them. `from` is the plan's count, `to` the new one. It is a real
  // plan change even on a hold, so buildProgressionProposal writes it.
  set_step?: { from: number; to: number };
  // The active training block's phase, when one shaped this prescription. Purely
  // informational for surfaces; the phase's effect is already in the numbers.
  block_phase?: ActiveBlockContext["phase"];
  // PEAK WEEK's top-set protocol: work up to one heavy set, then the back-off work.
  // A session protocol, not a plan edit — a near-maximal single is not a target the
  // plan should carry forward, so buildProgressionProposal deliberately skips it and
  // the result reaches the models through the logged set (detectStrengthCalibration).
  top_set?: {
    weight: number;
    reps: number;
    backoff: { sets: number; weight: number; rep_low?: number; rep_high?: number } | null;
  };
  // A REPEATED deload escalated instead of repeating itself: 'rep_wave' dropped the
  // rep window, 'variation' rotated the movement out. 'rep_range' is the isolation
  // answer to a grind the next load step is too coarse to fix: the load holds and the
  // range moves up (lift-response.ts). buildProgressionProposal writes it as a target
  // change and marks it, so a lift is moved up a range once and the ordinary ladder
  // answers any later stall.
  escalated?: "rep_wave" | "variation" | "rep_range";
  // The slot's prescription is UNTESTED (prescription-authorship.ts: authored after the
  // lift was last trained), so the fresh prescription stands at the plan until a session
  // is run at it. Informational for consumers that must not add to an untested slot (the
  // weekly dose). Reps path only; omit-when-false.
  untested?: true;
  dose_eligibility?: {
    linked_outcome: boolean;
    eligible: boolean;
    reason:
      | "legacy_unlinked"
      | "unfinished"
      | "non_comparable"
      | "partial"
      | "under_prescribed"
      | "full_comparable"
      | "full_load_through_confound";
  };
}

// ---- autoregulation + acute-recovery gate -----------------------------------
// The 1-tap session feedback (sessions.soreness/performance 1-5 + free-text
// joint_pain) plus recent ACUTE muscle load must GATE the deterministic
// prescription — otherwise the one-tap auto-progression could propose an OVERLOAD
// the morning after soreness 5 / a named sore joint. Recovery INFORMS, it never
// overrides progressive overload beyond ONE step toward safety: overload→hold on
// high soreness / low performance / a just-smoked group; hold→deload when a named
// joint loads that lift. Constitution: kind, plain words, no scores; a brake, not
// a penalty.
export interface AutoregSignals {
  soreness: number | null; // most recent 1-5
  performance: number | null; // most recent 1-5
  joint_pain: string | null; // most recent free-text ("left knee")
  date: string | null;
  performance_date?: string | null;
  performance_session_id?: number | null;
  // The canonical groups the session that REPORTED each signal actually trained.
  // Soreness and performance are read independently (the freshest non-null of
  // each), so they can come from different days and carry different scopes.
  // An EMPTY list means unresolved — and unresolved FAILS CLOSED to the old
  // whole-body brake, never to no brake at all.
  soreness_groups: MuscleGroup[];
  performance_groups: MuscleGroup[];
}

// Which canonical groups a session on this date loaded. Reuses the ONE effective
// -volume truth, so a bench day scopes to chest AND the triceps/shoulders it
// loaded indirectly rather than to a primary-group label alone. Null-safe: any
// read problem returns empty, which the brake reads as "unresolved".
function groupsTrainedOn(date: string | null): MuscleGroup[] {
  if (!date) return [];
  try {
    const rows = db
      .prepare(
        `SELECT e.muscle_group AS muscle_group, e.name AS exercise, s.date AS date,
                ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
           FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
           JOIN sessions s ON s.id = ls.session_id
          WHERE s.date = ?`
      )
      .all(String(date).slice(0, 10)) as any[];
    return [...effectiveVolumeByGroup(rows as VolumeSet[]).keys()].filter((g) => !isMobility(g));
  } catch {
    return [];
  }
}

const AUTOREG_WINDOW_DAYS = 3; // feedback older than this is stale — don't brake on it

// Read the most recent session feedback within the window (the freshest non-null
// value of each field). Null-safe: no feedback → all nulls (no brake).
export function recentAutoregulation(days = AUTOREG_WINDOW_DAYS, date = localDateISO()): AutoregSignals {
  const today = String(date || localDateISO()).slice(0, 10);
  const since = addDaysISO(today, -(Math.max(1, days) - 1)) ?? today;
  const out: AutoregSignals = {
    soreness: null,
    performance: null,
    joint_pain: null,
    date: null,
    performance_date: null,
    performance_session_id: null,
    soreness_groups: [],
    performance_groups: [],
  };
  let sorenessDate: string | null = null;
  let performanceDate: string | null = null;
  try {
    const rows = db
      .prepare(
        `SELECT id, date, soreness, performance, joint_pain FROM sessions
        WHERE date >= ? AND date <= ? ORDER BY date DESC, id DESC`
      )
      .all(since, today) as any[];
    for (const r of rows) {
      if (out.soreness == null && r.soreness != null) {
        out.soreness = Number(r.soreness);
        sorenessDate = String(r.date);
      }
      if (out.performance == null && r.performance != null) {
        out.performance = Number(r.performance);
        performanceDate = String(r.date);
        out.performance_date = performanceDate;
        const sid = Number(r.id);
        out.performance_session_id = Number.isInteger(sid) && sid > 0 ? sid : null;
      }
      if (out.joint_pain == null && r.joint_pain != null && String(r.joint_pain).trim())
        out.joint_pain = String(r.joint_pain).trim();
      if (
        out.date == null &&
        (r.soreness != null || r.performance != null || (r.joint_pain && String(r.joint_pain).trim()))
      )
        out.date = String(r.date);
    }
  } catch {
    /* sessions columns absent → no signal */
  }
  if (out.soreness != null) out.soreness_groups = groupsTrainedOn(sorenessDate);
  if (out.performance != null) out.performance_groups = groupsTrainedOn(performanceDate);
  return out;
}

// Does this feedback reach this lift? Soreness and a flat performance report
// belong to the muscles that session actually trained — a sore leg day used to
// hold the bench press too, for three days, because the brake never asked which
// muscles the feedback was ABOUT. (jointHit and the acute gate were already
// group-scoped; these two were the outliers.)
//
// FAILS CLOSED, deliberately. When the scope cannot be resolved — no logged sets
// on the feedback day, an unclassifiable lift, a read problem — the old
// whole-body brake stands. A safety brake may lose precision; it may never
// quietly lose effect.
function feedbackReaches(groups: MuscleGroup[] | undefined, group: MuscleGroup | null): boolean {
  if (!groups || !groups.length) return true; // unresolved → brake everything, as before
  if (!group) return true; // an unclassifiable lift cannot be ruled out
  return groups.includes(group);
}

// Decide the ONE-step autoregulation brake for a lift, given its computed action,
// its canonical group, the recent feedback, and the acute-load map. Returns the new
// action + a plain reason, or null when nothing brakes. Never steps more than once
// toward safety (overload→hold, hold→deload).
type BrakeResult = { action: "hold" | "deload"; why: string } | null;
function autoregBrake(
  action: ProgressionAction,
  group: MuscleGroup | null,
  hasHistory: boolean,
  autoreg: AutoregSignals | null,
  acute: Map<MuscleGroup, AcuteGateReading> | null,
  name: string,
  date: string
): BrakeResult {
  if (!autoreg && !acute) return null;
  const heavyAcute = group && acute ? acute.get(group)?.saturated === true : false;
  const jointHit = group && autoreg?.joint_pain ? painAreaLoadsGroup(autoreg.joint_pain, group) : false;
  const soreHigh =
    autoreg?.soreness != null && autoreg.soreness >= 4 && feedbackReaches(autoreg.soreness_groups, group);
  let perfLow =
    autoreg?.performance != null && autoreg.performance <= 2 && feedbackReaches(autoreg.performance_groups, group);
  // A completed log outranks a felt rating: if the session that carried the
  // 1–2 actually met every prescribed dose, the rating does not hold the lift.
  if (perfLow) {
    try {
      const sid =
        Number(autoreg?.performance_session_id) > 0
          ? Number(autoreg?.performance_session_id)
          : latestSessionIdOnDate(autoreg?.performance_date ?? autoreg?.date);
      if (sid != null && sessionLogContradictsLowRating(sid)) perfLow = false;
    } catch {
      /* a lookup miss must not invent a brake */
    }
  }
  const highStrain = soreHigh || perfLow || heavyAcute;

  // A named sore joint is the strongest brake — one step toward safety.
  if (jointHit) {
    if (action === "overload") {
      return { action: "hold", why: voice.liftVoice(voice.JOINT_BRAKE_HOLD, date, "joint_brake_hold", name) };
    }
    if (action === "hold" && hasHistory) {
      return { action: "deload", why: voice.liftVoice(voice.JOINT_BRAKE_DELOAD, date, "joint_brake_deload", name) };
    }
    return null;
  }
  // High soreness / low performance / a just-smoked group → don't add load today.
  if (highStrain && action === "overload") {
    const reason = heavyAcute
      ? "this muscle got a heavy dose recently"
      : soreHigh
        ? "recent soreness is running high"
        : "recent sessions felt flat";
    return {
      action: "hold",
      why: voice.liftVoice(voice.STRAIN_BRAKE_HOLD, date, "strain_brake_hold", name)(reason),
    };
  }
  return null;
}

// ---- the pain traffic light (per movement, never per session) ---------------
//
// The three bands (src/repo/pain-band.ts) decide ONE movement's load and nothing
// else — the same shape per-lift dose comparability already has, and for the same
// reason: one hurting movement must never block a session, and everything the
// symptom does not cover keeps training exactly as planned.
//
//   amber → the settling question is still open, so the load HOLDS and the next
//           exposure answers it. An earned step waits; it is not lost.
//   red   → it did not settle, or the athlete said it got worse, so this movement's
//           load comes DOWN one bounded step.
//
// A green band (nothing stated, or a report that settled) and an ABSENT read are
// both no-ops: silence never brakes a lift, and it never clears one either.
//
// This is a SAFETY floor, so it is blind to `training_drive`, and it runs after the
// autoregulation gate — a brake may lose precision, never effect.
type PainBrakeResult = { action: "hold" | "deload"; why: string } | null;
function painBandBrake(
  action: ProgressionAction,
  band: PainBandRead | null,
  name: string,
  date: string
): PainBrakeResult {
  if (!band || band.band === "green") return null;
  if (band.band === "red") {
    return { action: "deload", why: voice.liftVoice(voice.PAIN_RED_REDUCE, date, "pain_red_reduce", name) };
  }
  // Amber never manufactures a cut. It stops an ADDITION; a deload the ladder
  // already chose stands on its own reasons.
  if (action === "overload") {
    return { action: "hold", why: voice.liftVoice(voice.PAIN_AMBER_HOLD, date, "pain_amber_hold", name) };
  }
  return null;
}

// ---- movement tenure (proactive-variety ledger) -----------------------------
// Weeks since a movement was FIRST logged — how long the athlete has been running
// it. Used to suggest rotating a fresh variation in PROACTIVELY (before a measured
// plateau), at a block boundary. Null when the lift has never been logged.
export function movementTenureWeeks(name: string, date = localDateISO()): number | null {
  const ex = findExercise(name);
  if (!ex) return null;
  const first = (
    db
      .prepare(
        `SELECT MIN(s.date) AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id WHERE ls.exercise_id = ?`
      )
      .get(ex.id) as any
  )?.d;
  if (!first) return null;
  const days = daysBetweenISO(String(date || localDateISO()).slice(0, 10), String(first).slice(0, 10));
  if (days == null || days < 0) return 0;
  return Math.round(days / 7);
}

// ---- small helpers ----
// The relative timed step for a hold of `seconds`: ~10% of the hold, clamped to
// [MIN, MAX] so short and long holds both progress proportionally.
function timedStep(seconds: number, modifier?: CoachPersonalModifier | null): number {
  const raw = Math.round(Math.abs(seconds) * SECONDS_STEP_FRAC);
  const standard = Math.min(SECONDS_STEP_MAX, Math.max(SECONDS_STEP_MIN, raw));
  if (!modifier) return standard;
  return Math.round(
    applyPersonalResponseModifier({
      base: standard,
      modifier,
      min: SECONDS_STEP_MIN,
      max: SECONDS_STEP_MAX,
      safety_ceiling: SECONDS_STEP_MAX,
    })
  );
}

// The step ceiling for a lift: PROPORTIONAL to what is on the bar, floored at the
// minimum plate jump for its kind, on the 2.5 lb plate grid. A 100 lb press keeps
// the familiar 5 lb cap; a 300 lb squat earns 7.5 — the same relative step, not the
// same absolute one. `weight` null/unknown falls back to the flat floor.
function stepCeiling(group: string | null, weight?: number | null): number {
  const floor = isIsolationGroup(group) ? STEP_CEIL_ISOLATION : STEP_CEIL_COMPOUND;
  const load = weight == null ? null : Math.abs(Number(weight));
  if (load == null || !Number.isFinite(load) || load <= 0) return floor;
  return Math.max(floor, round2_5(load * STEP_CEIL_FRAC));
}

// The same ceiling after the active phase's PACING is applied. The scale has to
// reach the ceiling and not just the 10% fraction: at any real working weight the
// ceiling is what actually binds, so a phase that only scaled the fraction would
// change nothing. Never below the smallest plate — a paced step is still a step.
function phaseStepCeiling(group: string | null, weight: number | null | undefined, scale: number): number {
  const ceil = stepCeiling(group, weight);
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return ceil;
  return Math.max(2.5, round2_5(ceil * scale));
}

// The learned load step for one lift, read straight off `modifiers` — the map the
// personal-response model builds FOR consumers — and never off `learnings`.
//
// `learnings` is the athlete-facing PROSE list, capped at the four most recent for
// calm. Resolving through it meant a modifier that was safely present in `modifiers`
// became unreachable the moment its own sentence fell off that cap: the model had
// learned this lift's response, stored it, and the ladder read nothing. Worse, the
// fallback took the first null-subject learning of ANY metric — so a fresh nutrition
// learning claimed the "global" slot and its key matched no training modifier, which
// silently shadowed a live training one.
//
// Preference order, and it matters which way round: THIS lift's own learning first,
// then a whole-athlete one (session feedback and joint pain are recorded with no
// subject and genuinely speak for every lift). Another exercise's learning is never
// borrowed — the squat's earned response is not the bench press's.
export function trainingModifierFor(
  exerciseName: string,
  response: CoachWhatWorksForYou | null = whatWorksForYou()
): CoachPersonalModifier | null {
  if (!response) return null;
  const name = exerciseName.trim().toLowerCase();
  const candidates = response.modifiers.filter((modifier) => modifier.target === "training_progression_step");
  const own = candidates.find((modifier) => modifier.subject_key?.trim().toLowerCase() === name) ?? null;
  const wholeAthlete = candidates.find((modifier) => modifier.subject_key == null) ?? null;
  if (!own) return wholeAthlete;
  // …with ONE exception to the lift-first preference, and it turns on provenance.
  //
  // An observed-only reading — every outcome behind it judged a decision the athlete
  // never made — is barred from pushing, but it can still land slightly UNDER 1 as it
  // fades toward the universal default with age. Preferred blindly, such a reading
  // would displace a fresh whole-athlete ease that session feedback or joint pain had
  // earned from changes the athlete really did make, and this lift alone would quietly
  // lose the more careful step. So when the whole-athlete reading is applied-backed
  // AND more cautious, it wins. Two readings of the same provenance are unaffected:
  // the lift's own still speaks for the lift.
  if (own.observed_only && wholeAthlete && !wholeAthlete.observed_only && wholeAthlete.scale < own.scale) {
    return wholeAthlete;
  }
  return own;
}

// Clamp a desired LOADED step to the safe cap, rounded to a sane plate. Only
// for positive loaded weight; assist/bodyweight handled separately. `phaseScale`
// is the active block phase's PACING (accumulation earns less of the step,
// intensification more) — it scales the step BEFORE the ceiling, never past it.
function clampedOverload(
  current: number,
  group: string | null,
  modifier?: CoachPersonalModifier | null,
  phaseScale = 1
): number {
  const isolation = isIsolationGroup(group);
  const scale = Number.isFinite(phaseScale) && phaseScale > 0 ? phaseScale : 1;
  const ceil = phaseStepCeiling(group, current, scale);
  const step = Math.min(Math.abs(current) * STEP_FRAC * scale, ceil);
  let earned = step;
  if (modifier) {
    const adjusted = applyPersonalResponseModifier({
      base: step,
      modifier,
      min: Math.min(2.5, ceil),
      max: ceil,
      safety_ceiling: ceil,
    });
    // A learned conservative response must be operational, not cosmetic. Use the
    // smallest common plate increment while the universal per-session ceiling stays
    // authoritative. A standard response retains the historical rounding below.
    if (adjusted < step) {
      const conservativeStep = Math.max(2.5, Math.floor(adjusted / 2.5) * 2.5);
      return Math.min(current + ceil, current + conservativeStep);
    }
    // …and the same has to hold the other way now that a modifier can exceed 1 (the
    // aligned-verdict acceleration in reaction-model.ts). Left on `step`, an earned
    // larger step was discarded here and the branch was decorative. The per-session
    // `ceil` still caps it — applyPersonalResponseModifier already clamped to it, and
    // the rounding guard below re-clamps — so this can raise the step within the safe
    // envelope and nowhere past it.
    if (adjusted > step) earned = Math.min(ceil, adjusted);
  }
  // Round to 5 lb for compounds, 2.5 for isolation, but never below the smaller
  // plate (so a light isolation lift still moves). A compound whose proportional
  // ceiling has outgrown the 5 lb floor rounds on the 2.5 grid instead — otherwise
  // a heavy squat's earned 7.5 lb step would be rounded straight back down to 5 and
  // the proportional cap would be decorative.
  const next = current + earned;
  const rounded = isolation || ceil % 5 !== 0 ? round2_5(next) : round5(next);
  // Guarantee the rounding never produces a step BIGGER than the cap, and never
  // a no-op (a too-small fraction shouldn't strand the lift).
  if (rounded > current + ceil) return current + ceil;
  // …and the minimum-plate guarantee never exceeds a ceiling the phase has paced
  // down: a half-step phase must be able to produce a genuine half step.
  if (rounded <= current) return current + Math.min(ceil, isolation ? 2.5 : 5);
  return rounded;
}

// The next load one ordinary earned step above `current` — the plate grid and the
// per-session cap an overload takes, with no phase pacing or learned modifier. The
// daily reach prices its heavier look off this, so a reach is never a bigger jump
// than the engine itself would take.
export function nextLoadStep(current: number, group: string | null): number {
  return clampedOverload(current, group);
}

// Peel assist toward bodyweight. Never crosses sign in one step — landing at or
// past 0 is bodyweight (null), matching the earned-assist branch.
function assistStepNext(
  baseWeight: number,
  group: string | null,
  modifier: CoachPersonalModifier | null | undefined,
  phaseStepScale: number
): number | null {
  const ceil = phaseStepCeiling(group, baseWeight, phaseStepScale);
  const standardStep = Math.min(Math.abs(baseWeight) * STEP_FRAC * phaseStepScale, ceil);
  const step = modifier
    ? applyPersonalResponseModifier({
        base: standardStep,
        modifier,
        min: 0,
        max: ceil,
        safety_ceiling: ceil,
      })
    : standardStep;
  const reduced = round5(baseWeight + step);
  return reduced >= 0 ? null : reduced;
}

// Find the plan item (and its prescribed targets) for an exercise, if any.
function planItemFor(name: string, stamps?: Map<number, string | null> | null): {
  plan_item_id: number;
  day_number: number;
  sets: number;
  rep_low: number | null;
  rep_high: number | null;
  weight: number | null;
  seconds: number | null;
  kind: string;
  // Where this movement sits among the day's STRENGTH work (0-based). The first
  // couple of movements are the day's main work; what follows them is accessory —
  // the same reading calibration.ts uses to decide which lifts are worth re-testing.
  strength_position: number;
  // When this slot's prescription was last authored (plan_items.prescribed_at, v111);
  // null for a row older than the stamp.
  prescribed_at: string | null;
  // The other strength movements on the same plan day — what a rotation must not
  // duplicate.
  day_exercises: string[];
} | null {
  // TIERED, mirroring resolvePlanSwapSlot: an EXACT spelling always beats a resolved
  // one (a day that names the lift verbatim wins over a day that only aliases onto
  // it), and tiers never mix. The second tier is the shared identity resolver — the
  // plan may store "Incline Dumbbell Press" while the athlete logs "Incline DB
  // Press", and a raw lowercase compare stranded that lift with no prescription.
  const lc = String(name).toLowerCase().trim();
  const identity = exerciseIdentityKey(name);
  const plan = getPlan() as any[];
  // Tier 2 resolves each plan-item name, which is a DB read; memoize so a plan with
  // the same lift on several days costs one lookup, not one per row.
  const identityCache = new Map<string, string>();
  const itemIdentity = (raw: string): string => {
    const cached = identityCache.get(raw);
    if (cached !== undefined) return cached;
    const key = exerciseIdentityKey(raw);
    identityCache.set(raw, key);
    return key;
  };
  const tiers: Array<(item: any) => boolean> = [
    (it) => String(it.exercise || "").toLowerCase().trim() === lc,
    ...(identity ? [(it: any) => itemIdentity(String(it.exercise || "")) === identity] : []),
  ];
  for (const matches of tiers) {
    for (const day of plan) {
      let strengthPosition = 0;
      for (const it of day.items || []) {
        const cardio = it.kind === "cardio";
        if (matches(it)) {
          return {
            plan_item_id: it.id,
            day_number: day.day_number,
            sets: Number(it.sets) || 0,
            rep_low: it.rep_low ?? null,
            rep_high: it.rep_high ?? null,
            weight: it.target_weight ?? null,
            seconds: it.target_seconds ?? null,
            kind: cardio ? "cardio" : "strength",
            strength_position: strengthPosition,
            prescribed_at: stamps ? (stamps.get(Number(it.id)) ?? null) : slotStamp(Number(it.id)),
            day_exercises: (day.items || [])
              .filter((other: any) => other !== it && other.kind !== "cardio" && other.exercise)
              .map((other: any) => String(other.exercise)),
          };
        }
        if (!cardio) strengthPosition += 1;
      }
    }
  }
  return null;
}

function isPrepWork(name: string, group: string | null): boolean {
  return isMobility(group) || isPrepMovement(name);
}

// Prep stays at the planned dose. No overload, no fuel-park story, no invented load.
function prepWorkPrescription(
  exerciseName: string,
  mode: "reps" | "timed",
  last: ReturnType<typeof latestTopSet>,
  current: PrescriptionTarget | null
): Prescription {
  const suggested: PrescriptionTarget = current
    ? { ...current }
    : mode === "timed"
      ? { sets: 1, seconds: last?.duration_sec ?? 30 }
      : {
          sets: 2,
          rep_low: last?.reps ?? 8,
          rep_high: last?.reps ?? 10,
          weight: null,
        };
  return {
    exercise: exerciseName,
    mode,
    action: "hold",
    suggested,
    current,
    delta_text: "prep, not working volume",
    why: "",
  };
}

function currentTarget(plan: ReturnType<typeof planItemFor>, mode: "reps" | "timed"): PrescriptionTarget | null {
  if (!plan) return null;
  if (mode === "timed") {
    return {
      sets: plan.sets || 1,
      seconds: plan.seconds ?? undefined,
      ...(plan.weight != null && plan.weight !== 0 ? { weight: plan.weight } : {}),
    };
  }
  return {
    sets: plan.sets || 0,
    rep_low: plan.rep_low ?? undefined,
    rep_high: plan.rep_high ?? undefined,
    weight: plan.weight,
  };
}

// The latest logged TOP set for a lift (heaviest est-1RM day's top set + its
// RIR) — the deterministic read of "what they actually did last time".
function latestTopSet(
  name: string
): {
  weight: number | null;
  reps: number | null;
  rir: number | null;
  duration_sec: number | null;
  date: string;
  session_id: number;
} | null {
  // The lift's own row, plus the bodyweight-ladder rows it replaced — a rotated-in
  // "Neutral-Grip Pull-Up" reads the last "Assisted Pull-Up" session rather than
  // starting over (progressionLineageIds; a loaded lift is only its own row).
  const ids = progressionLineageIds(name);
  if (!ids.length) return null;
  const inIds = ids.map(() => "?").join(",");
  // Most recent session that logged this lift; within it, the top set by est-1RM
  // (reps) or by duration (timed). RIR comes off that top set when present.
  const latestSession = (
    db
      .prepare(
        `SELECT s.id, s.date FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
         WHERE ls.exercise_id IN (${inIds}) AND (ls.reps IS NOT NULL OR ls.duration_sec IS NOT NULL)
         ORDER BY s.date DESC, s.id DESC LIMIT 1`
      )
      .get(...ids) as any
  );
  if (!latestSession?.date || latestSession?.id == null) return null;
  const sets = db
    .prepare(
      `SELECT ls.weight AS weight, ls.reps AS reps, ls.rir AS rir, ls.duration_sec AS duration_sec
       FROM logged_sets ls
      WHERE ls.exercise_id IN (${inIds}) AND ls.session_id = ?`
    )
    .all(...ids, latestSession.id) as any[];
  if (!sets.length) return null;
  // Top set: max (weight×(1+reps/30)) for reps; max duration for timed.
  let top = sets[0];
  let bestScore = -Infinity;
  for (const s of sets) {
    const score =
      s.duration_sec != null ? Number(s.duration_sec) : (Number(s.weight) || 0) * (1 + (Number(s.reps) || 0) / 30);
    if (score > bestScore) {
      bestScore = score;
      top = s;
    }
  }
  return {
    weight: top.weight ?? null,
    reps: top.reps ?? null,
    // Out-of-range RIR (seconds or a rep count typed into the wrong field) is absent.
    rir: plausibleRir(top.rir),
    duration_sec: top.duration_sec ?? null,
    date: String(latestSession.date),
    session_id: Number(latestSession.id),
  };
}

// The latest session's WORKING sets for a reps lift — the sets at that session's
// hardest (top) weight, so warmups/backoffs don't dilute the double-progression read.
// Bodyweight (null weight) sets are all "working". Empty when nothing's logged. This is
// how the engine tells "every set capped the range" from "only the top set did".
let latestSessionMemo: { key: string; date: string | null } | null = null;
function latestLoggedSessionDate(through: string): string | null {
  const key = `${through}|${trainingRowsSignature()}`;
  if (latestSessionMemo?.key === key) return latestSessionMemo.date;
  const row = db
    .prepare(
      `SELECT MAX(s.date) AS date FROM sessions s
        WHERE s.date <= ? AND EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id)`
    )
    .get(through) as { date?: string | null } | undefined;
  const date = row?.date ? String(row.date) : null;
  latestSessionMemo = { key, date };
  return date;
}

// Is `planWeight` the plan deliberately stepping up from the latest session? Every
// loaded working set there reached `repLow` with a logged RIR of at least
// RIR_IN_RESERVE, and the target sits no further above that load than one earned step
// (clampedOverload — the same cap an overload may take). No rating is not reserve.
function steppedUpFromReserve(
  name: string,
  group: string | null,
  planWeight: number | null,
  repLow: number | undefined
): boolean {
  if (planWeight == null || planWeight <= 0 || repLow == null) return false;
  const sets = latestWorkingSets(name);
  if (!sets.length) return false;
  const working = sets[0]?.weight;
  if (working == null || working <= 0 || planWeight <= working) return false;
  const reserved = sets.every(
    (s) => s.weight === working && s.reps != null && s.reps >= repLow && s.rir != null && s.rir >= RIR_IN_RESERVE
  );
  return reserved && planWeight <= clampedOverload(working, group);
}

function latestWorkingSets(name: string): { weight: number | null; reps: number | null; rir: number | null }[] {
  const ids = progressionLineageIds(name);
  if (!ids.length) return [];
  const inIds = ids.map(() => "?").join(",");
  const latestSession = (
    db
      .prepare(
        `SELECT s.id, s.date FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
         WHERE ls.exercise_id IN (${inIds}) AND ls.reps IS NOT NULL
         ORDER BY s.date DESC, s.id DESC LIMIT 1`
      )
      .get(...ids) as any
  );
  if (!latestSession?.date || latestSession?.id == null) return [];
  const rows = db
    .prepare(
      `SELECT ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
       FROM logged_sets ls
      WHERE ls.exercise_id IN (${inIds}) AND ls.session_id = ? AND ls.reps IS NOT NULL`
    )
    .all(...ids, latestSession.id) as any[];
  if (!rows.length) return [];
  // The working weight is the hardest (largest signed) weight in the session; sets
  // at it are the working sets. Bodyweight (null) is the zero of that signed scale:
  // harder than any assist, easier than any added load — so bodyweight sets beside
  // an assisted finisher ARE the working sets (the assisted set is the back-off),
  // while bodyweight sets beside loaded ones are warm-ups. A session with nothing
  // weighted is a bodyweight session and every logged set counts.
  const signed = (r: any): number => (r.weight == null ? 0 : Number(r.weight));
  let topW: number | null = null;
  for (const r of rows) {
    if (topW == null || signed(r) > topW) topW = signed(r);
  }
  const working = rows.filter((r) => signed(r) === topW);
  return working.map((r) => ({
    weight: r.weight ?? null,
    reps: r.reps != null ? Number(r.reps) : null,
    rir: plausibleRir(r.rir),
  }));
}

function metSnapshottedPrescription(dose: any): boolean {
  if (!dose || typeof dose !== "object") return false;
  if (dose.challenge_verdict === "met" || dose.challenge_verdict === "exceeded") return true;
  const prescribedSets = Number(dose.prescribed?.sets);
  const achievedSets = Number(dose.achieved?.sets);
  if (!Number.isFinite(prescribedSets) || prescribedSets <= 0 || !Number.isFinite(achievedSets) || achievedSets < prescribedSets) {
    return false;
  }
  const target = dose.prescribed?.target_weight;
  const top = dose.achieved?.top_weight;
  if (target == null || !Number.isFinite(Number(target))) return true;
  return top != null && Number.isFinite(Number(top)) && Number(top) + 0.1 >= Number(target);
}

// Confounders that only ever make a dose HARDER than a clean day would have been:
// the legs already carried a run, the athlete was travelling, the day was a
// prescribed recovery dose. They exist so a flat or short day is not read as a
// regression. They are not a reason to ignore a day the athlete cleared anyway.
// Illness, a movement-relevant symptom and a set shortfall are not in this set —
// those keep full authority.
const HANDICAP_CONFOUNDS = new Set(["loaded_endurance", "travel", "recovery_dose"]);

// WORK DONE IS EVIDENCE, in the one direction a handicap allows. A dose that was
// non-comparable ONLY because of a handicap, finished every prescribed set, met or
// beat its own prescription, and landed at or above its full-load reference (the
// lift's own recent working weight, the plan only as a no-history fallback) is a
// LOWER bound on what the lift can do — so it may count toward an earned step. It
// never counts against one: a missed handicapped day stays non-comparable. Loaded
// work only; the stored reference, never a guess.
function fullLoadThroughConfound(dose: any, reasons: readonly string[]): boolean {
  if (!dose || typeof dose !== "object" || dose.relevant_symptom === true) return false;
  if (!reasons.length || !reasons.every((r) => HANDICAP_CONFOUNDS.has(String(r)))) return false;
  if (dose.challenge_verdict !== "met" && dose.challenge_verdict !== "exceeded") return false;
  const prescribedSets = Number(dose.prescribed?.sets);
  const achievedSets = Number(dose.achieved?.sets);
  if (!(prescribedSets > 0) || !(achievedSets >= prescribedSets)) return false;
  const ref = dose.full_load_reference ?? {};
  const toNum = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const reference = harderLoad(toNum(ref.target_weight), toNum(ref.recent_working_weight));
  const top = toNum(dose.achieved?.top_weight);
  return reference != null && reference > 0 && top != null && loadAtOrAbove(top, reference);
}

function linkedDoseEligibility(
  sessionId: number | null | undefined,
  movement: string,
  opts?: { planBehind?: boolean }
): NonNullable<Prescription["dose_eligibility"]> {
  if (sessionId == null) return { linked_outcome: false, eligible: true, reason: "legacy_unlinked" };
  const row = db
    .prepare(
      `SELECT o.status, o.date, o.facts_json, s.finished_at
         FROM daily_session_outcomes o
         JOIN sessions s ON s.id = o.session_id
        WHERE o.session_id = ? ORDER BY o.id DESC LIMIT 1`
    )
    .get(Number(sessionId)) as any;
  if (!row) return { linked_outcome: false, eligible: true, reason: "legacy_unlinked" };
  if (row.status !== "completed" || !row.finished_at) {
    return { linked_outcome: true, eligible: false, reason: "unfinished" };
  }
  let facts: any = null;
  try {
    facts = JSON.parse(row.facts_json);
  } catch {
    return { linked_outcome: true, eligible: false, reason: "non_comparable" };
  }
  const stored = findExercise(movement);
  const identity =
    stored?.id != null ? `exercise:${Number(stored.id)}` : `movement:${normalizedExerciseKey(movement)}`;
  const dose = Array.isArray(facts?.dose_evidence)
    ? facts.dose_evidence.find(
        (entry: any) =>
          entry?.movement_key === identity ||
          String(entry?.exercise ?? "").toLowerCase() === String(movement).toLowerCase()
      )
    : null;
  const prescribedSets = Number(dose?.prescribed?.sets);
  const achievedSets = Number(dose?.achieved?.sets);
  const ownShortfall =
    Number.isFinite(prescribedSets) &&
    prescribedSets > 0 &&
    (!Number.isFinite(achievedSets) || achievedSets < prescribedSets);
  if (!dose || ownShortfall) {
    return { linked_outcome: true, eligible: false, reason: "partial" };
  }
  // Comparability is a per-LIFT question. Schema-4 rows store the answer
  // (including performed_at_full_load) and we trust it. Schema-3 rows already
  // carry a stored per-dose comparable, but they are re-derived live via
  // doseComparability so out-of-window rows (beyond the 60-day repair) follow
  // the new law rather than the stored verdict. Older rows carry the session
  // reason list and this dose's own numbers, which is enough to derive the
  // same verdict — and a stored performed_at_full_load, when present, is read
  // here so a repaired row and a live write agree.
  const sessionReasons: string[] = Array.isArray(facts?.dose_context?.non_comparable_reasons)
    ? facts.dose_context.non_comparable_reasons.map(String)
    : facts?.dose_context?.comparable === true
      ? []
      : ["non_comparable"];
  // A dose with no prescribed set count cannot PROVE it completed: the shortfall
  // check above only fires on a finite prescription, and the write path also
  // consults the session's skipped list, which read time cannot see. So when the
  // session already said `partial`, an unprovable dose KEEPS that reason rather
  // than dropping it — it never manufactures one, because with no session
  // `partial` there is nothing here to keep.
  const provablyPrescribed = Number.isFinite(prescribedSets) && prescribedSets > 0;
  const currentSchema = Number(facts?.schema_version) >= OUTCOME_FACTS_SCHEMA_VERSION;
  const perDose =
    currentSchema && typeof dose.comparable === "boolean"
      ? {
          comparable: dose.comparable === true,
          non_comparable_reasons: Array.isArray(dose.non_comparable_reasons)
            ? dose.non_comparable_reasons.map(String)
            : ["non_comparable"],
        }
      : doseComparability({
          session_reasons: sessionReasons,
          own_dose_shortfall: !provablyPrescribed && sessionReasons.includes("partial"),
          // An empty scope means the day's endurance work loaded nothing worth
          // guarding, so the reason blocks no lift — the same ONE test the write
          // path uses to decide whether to raise `loaded_endurance` at all.
          endurance_overlap:
            sessionReasons.includes("loaded_endurance") &&
            enduranceOverlapsMovement(
              movement,
              stored?.muscle_group ?? null,
              enduranceLoadedGroups(String(row.date ?? "").slice(0, 10))
            ),
          performed_at_full_load: dose.performed_at_full_load === true,
        });
  if (!perDose.comparable) {
    if (fullLoadThroughConfound(dose, perDose.non_comparable_reasons)) {
      return { linked_outcome: true, eligible: true, reason: "full_load_through_confound" };
    }
    return { linked_outcome: true, eligible: false, reason: "non_comparable" };
  }
  if (dose.challenge_verdict !== "met" && dose.challenge_verdict !== "exceeded") {
    // A plan re-ground must not turn a dose that met its own composition snapshot
    // into a blocker. When the plan is still behind logged reality and this dose
    // completed that snapshot, a later target rewrite may make the stored verdict
    // look under_prescribed — catch that up as a full comparable exposure. The
    // carve-out does NOT run before comparability: an endurance overlap or a
    // movement-relevant symptom still holds the lift out of the comparable set
    // (a handicapped dose that cleared full load counts only through
    // fullLoadThroughConfound above, under its own reason).
    if (opts?.planBehind && metSnapshottedPrescription(dose)) {
      return { linked_outcome: true, eligible: true, reason: "full_comparable" };
    }
    return { linked_outcome: true, eligible: false, reason: "under_prescribed" };
  }
  return { linked_outcome: true, eligible: true, reason: "full_comparable" };
}

// Pull the per-lift program-state read (status/trend/stall) for ONE exercise —
// reuse the aggregate so the engine and the program-state surface always agree.
// A caller iterating many lifts (planDayProgression / programAdjustments) builds
// the map ONCE and threads it in; a standalone nextPrescription(name) call
// computes it on demand. No module-level cache (it would go stale between tests
// that reset the DB within the same calendar day).
function buildLiftStateMap(): Map<string, LiftState> {
  const st = getProgramState();
  return new Map((st.lifts || []).map((l) => [l.exercise.toLowerCase(), l]));
}
function liftStateFor(name: string, states?: Map<string, LiftState>): LiftState | null {
  const map = states ?? buildLiftStateMap();
  return map.get(String(name).toLowerCase()) ?? null;
}

// Build the plain-words delta for a loaded step (handles assist + bodyweight).
function loadedDeltaText(current: number | null, next: number | null): string {
  if (current == null && next == null) return "hold bodyweight";
  if (next == null) return "bodyweight";
  if (current == null) return next < 0 ? `assist ${Math.abs(next)} lb` : `${next} lb`;
  // assist (negative): reducing assist = a smaller absolute value = harder.
  if (current < 0 || next < 0) {
    const d = next - current; // toward 0 = +ve = less assist = harder
    if (d === 0) return `hold ${Math.abs(current)} lb assist`;
    return d > 0 ? `−${Math.abs(d)} lb assist` : `+${Math.abs(d)} lb assist`;
  }
  const d = next - current;
  if (d === 0) return `hold ${current} lb`;
  return d > 0 ? `+${d} lb` : `−${Math.abs(d)} lb`;
}

// ---- periodization: is this lift one the phase speaks to? --------------------
// The block's phase shapes MAIN work — the first movements of a day, the compounds
// the program is built on. Isolation and accessory work stays on plain double
// progression, where a rep window and a small plate are the whole story.
const MAIN_LIFT_POSITIONS = 2;

function isMainLift(group: string | null, plan: ReturnType<typeof planItemFor>): boolean {
  if (!plan || plan.kind === "cardio") return false;
  if (plan.strength_position >= MAIN_LIFT_POSITIONS) return false;
  return !isIsolationGroup(group);
}

// The best estimated single this lift's logged work supports — Epley on the best
// set of each day, carried as a running max. This MIRRORS calibration.ts's own
// reconstruction on purpose: a peak-week top set is prescribed as a fraction of
// exactly the number a verifying set will be measured against, so a completed peak
// re-anchors the estimate rather than landing just under the bar it had to clear.
function bestEstimated1rm(name: string, asOf: string): number | null {
  try {
    const key = normalizedExerciseKey(name);
    if (!key) return null;
    const ids = (db.prepare(`SELECT id, name FROM exercises`).all() as Array<{ id: number; name: string }>)
      .filter((row) => normalizedExerciseKey(String(row.name ?? "")) === key)
      .map((row) => Number(row.id));
    if (!ids.length) return null;
    const since = addDaysISO(asOf, -PEAK_HISTORY_DAYS) ?? asOf;
    const rows = db
      .prepare(
        `SELECT ls.weight AS weight, ls.reps AS reps
           FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
          WHERE ls.exercise_id IN (${ids.map(() => "?").join(",")})
            AND ls.weight IS NOT NULL AND ls.weight > 0
            AND ls.reps IS NOT NULL AND ls.reps > 0
            AND s.date <= ? AND s.date >= ?`
      )
      .all(...ids, asOf, since) as Array<{ weight: number; reps: number }>;
    let best = 0;
    for (const row of rows) {
      const weight = Number(row.weight);
      const reps = Number(row.reps);
      if (!Number.isFinite(weight) || !Number.isFinite(reps) || weight <= 0 || reps <= 0) continue;
      const est = weight * (1 + reps / 30);
      if (est > best) best = est;
    }
    return best > 0 ? best : null;
  } catch {
    return null;
  }
}

// Round UP onto the plate grid. The peak target rounds up rather than to nearest so
// a light lift's top set can never land a hair UNDER the fraction that makes it a
// verifying set — which would turn the whole peak week into a heavy set that
// anchored nothing.
function ceil2_5(n: number): number {
  return Math.ceil(n / 2.5) * 2.5;
}

interface TopSetProtocol {
  weight: number;
  reps: number;
  backoff: { sets: number; weight: number; rep_low?: number; rep_high?: number } | null;
}

// Peak week's protocol for one main lift: work up to a heavy top set derived from
// the lift's own best estimated single, then back off for the remaining work. This
// is est-1RM's FIRST prescriptive role — until now the estimate was read, charted
// and re-anchored, but it never told anybody what to lift.
//
// Cautious (a slightly lighter double) whenever the estimate is unconfirmed or the
// cut is biting; confident (a true heavy single) otherwise. Both clear the
// verifying fraction, so either way the logged result re-anchors the estimate.
function peakTopSetFor(
  name: string,
  baseWeight: number,
  sets: number,
  repLow: number | undefined,
  repHigh: number | undefined,
  cautious: boolean,
  asOf: string
): TopSetProtocol | null {
  const est = bestEstimated1rm(name, asOf);
  if (est == null || est <= 0) return null;
  const frac = cautious ? PEAK_TOP_FRAC_CAUTIOUS : PEAK_TOP_FRAC_CONFIDENT;
  // Never lighter than what they already handle for working reps — that would be a
  // back-off set masquerading as a peak.
  const weight = Math.max(ceil2_5(est * frac), ceil2_5(baseWeight));
  const backoffSets = Math.max(1, (Number(sets) || 1) - 1);
  return {
    weight,
    reps: cautious ? 2 : 1,
    backoff: {
      sets: backoffSets,
      weight: round2_5(weight * PEAK_BACKOFF_FRAC),
      rep_low: repLow,
      rep_high: repHigh,
    },
  };
}

// ---- the cut, as a lever rather than a sentence ------------------------------
// "Holding strength on a cut is a win" was prose in the playbook and nothing in the
// math. These two reads make it operational: the protective fuel read says whether
// training is being asked for more than the food supports, and the cut-quality read
// says whether the deficit itself is running hot. Both are READ-ONLY here.
export interface CutPressure {
  /** The fuel read asks for aggression to be held. Does NOT veto an earned promotion. */
  hold: boolean;
  /** The fuel read asks for an outright lighter dose. Vetoes promotion unless near_goal. */
  reduce: boolean;
  /**
   * Anchor lifts are actually dropping (`cutQualityRead` verdict `sliding`), or
   * THIS lift is regressing / has a log-confirmed shortfall. Always vetoes a
   * promotion.
   */
  sliding: boolean;
  /**
   * Loss rate is faster than lean-safe, but the verdict is not sliding. Parks
   * the challenge top set / heavy single; does NOT veto an earned load step
   * backed by a comparable, eligible, strong dose, and does not hold a
   * vary/introduce — a variation at the same load adds no load.
   */
  fast_loss: boolean;
  /**
   * Derived alias: `sliding || fast_loss`. Other readers treat either as "the
   * cut is running hot"; promotion itself consults `sliding` / `fast_loss`.
   */
  deep: boolean;
  /** Any of the above — the athlete is training in a genuine deficit right now. */
  any: boolean;
  /**
   * At OR within NEAR_GOAL_REMAINING_LB of goal weight on a live lose-mode cut
   * (`atOrNearGoal` — a goal already reached, or passed by up to the stale-goal
   * overshoot band, counts). Lifts
   * the reduce promotion veto so the log can still move the load; sliding still
   * vetoes. It ALSO lifts the volume reduction: at/near goal `applyFuelProtection`
   * keeps the prescribed sets and load and takes only the near-maximal single,
   * because the honest answer to underfueling at the destination is more food,
   * not a smaller session.
   */
  near_goal: boolean;
}

const NO_CUT_PRESSURE: CutPressure = {
  hold: false,
  reduce: false,
  sliding: false,
  fast_loss: false,
  deep: false,
  any: false,
  near_goal: false,
};

// sliding always vetoes an earned promotion (anchors — or this lift — are
// dropping). reduce vetoes unless we are near the destination. fast_loss never
// vetoes a promotion backed by a comparable, eligible, strong dose — it only
// parks the heavy single. hold never vetoes a promotion.
function cutVetoesPromotion(
  cut: CutPressure,
  lift?: { status?: string; shortfall?: boolean }
): boolean {
  // regressing / shortfall are belt-and-braces: the ladder already deloads a
  // slipping lift and refuses an ineligible dose before this is consulted.
  if (cut.sliding || lift?.status === "regressing" || lift?.shortfall) return true;
  if (cut.reduce && !cut.near_goal) return true;
  return false;
}

function readCutPressure(date: string): CutPressure {
  let hold = false;
  let reduce = false;
  let sliding = false;
  let fast_loss = false;
  try {
    const fuel = currentUnderfuelingRead(date);
    hold = fuel?.action?.training === "hold_aggression";
    reduce = fuel?.action?.training === "reduce";
  } catch {
    /* no fuel read → no pressure claimed */
  }
  try {
    const cut = cutQualityRead(date);
    if (cut.active) {
      sliding = cut.verdict === "sliding";
      fast_loss = cut.rate.vs_lean_safe === "above" && cut.verdict !== "sliding";
    }
  } catch {
    /* no cut read → no pressure claimed */
  }
  let near_goal = false;
  try {
    near_goal = atOrNearGoal(date);
  } catch {
    /* no remaining read → not claimed near the destination */
  }
  const deep = sliding || fast_loss;
  return { hold, reduce, sliding, fast_loss, deep, any: hold || reduce || deep, near_goal };
}

// The cut read is expensive (it walks the goal check and the program state), so it
// is computed at most ONCE per pass and only when a branch actually consults it —
// most days, no lift asks. A whole-day pass threads ONE thunk through every lift so
// the work is shared rather than repeated per movement.
function cutPressureThunk(date: string, provided?: CutPressure | (() => CutPressure) | null): () => CutPressure {
  if (typeof provided === "function") return provided;
  if (provided) return () => provided;
  let cached: CutPressure | null = null;
  return () => {
    if (!cached) cached = readCutPressure(date);
    return cached;
  };
}

// ---- the calibration read, shared across a day's pass -----------------------
// Reading how much a lift's estimate deserves to be trusted costs a full exercises
// SELECT plus a 400-day walk of that lift's logged sets, and only TWO branches
// below ever consult it (the peak-week protocol and the regressing arm). Computing
// it eagerly for every movement put that walk on the daily-decision, session-primer
// and coach hot paths for lifts that never asked. So it is LAZY per lift and shared
// per pass — the same shape as cutPressureThunk, keyed per movement because this
// answer, unlike the cut read, is about one lift rather than about the day.
export type EstimateReader = (name: string) => UnverifiedRegressionHold;

function estimateReader(date: string, provided?: EstimateReader | null): EstimateReader {
  if (provided) return provided;
  const cache = new Map<string, UnverifiedRegressionHold>();
  return (name: string) => {
    const key = normalizedExerciseKey(String(name ?? "")) || String(name ?? "");
    const cached = cache.get(key);
    if (cached) return cached;
    const read = unverifiedRegressionHold(name, date);
    cache.set(key, read);
    return read;
  };
}

// ---- what the ledger's own verdicts add to a stalled lift --------------------
// Conclusive verdicts on THIS lift's past progression expectations. Aligned
// verdicts buy patience (the lift has been answering honestly — give it another
// clean run before reshuffling); missed verdicts add confidence to changing
// something. It only ever moves the flat-for-long-enough line; it never reaches a
// safety brake, and an uninformative ledger says nothing at all.
const LEDGER_RECENT_VERDICTS = 3;

interface LedgerCounsel {
  /** Extra weeks of patience before a flat lift is offered a variation. */
  patience: number;
  /** The ledger has been missing on this lift — a change is better supported. */
  doubt: boolean;
}

function ledgerCounsel(name: string): LedgerCounsel {
  try {
    const read = liftLedgerRead(name);
    if (!read?.informative || !Array.isArray(read.verdicts) || !read.verdicts.length)
      return { patience: 0, doubt: false };
    const recent = read.verdicts.slice(0, LEDGER_RECENT_VERDICTS);
    const missed = recent.filter((v) => v?.outcome === "missed").length;
    const aligned = recent.filter((v) => v?.outcome === "aligned").length;
    if (missed >= 2) return { patience: 0, doubt: true };
    if (aligned >= 2 && missed === 0) return { patience: 2, doubt: false };
    return { patience: 0, doubt: false };
  } catch {
    return { patience: 0, doubt: false };
  }
}

// Has this lift already been backed off recently? Applied auto-progression deloads
// carry their own marker (see appliedProgressionDeloads in plan.ts).
function deloadedRecently(name: string, date: string): boolean {
  const since = addDaysISO(date, -DELOAD_REPEAT_DAYS);
  if (!since) return false;
  try {
    return appliedProgressionDeloads(name, since, date) > 0;
  } catch {
    return false;
  }
}

// …and is an escalated rep wave ALREADY running on it? The escalation answers a
// repeated deload by changing the shape of the work; re-answering the same way
// every week is the same failure one rung up, and it never terminates. So the
// ladder stops here: a lift inside a wave is left to run it out.
function waveRunning(name: string, date: string): boolean {
  const since = addDaysISO(date, -DELOAD_REPEAT_DAYS);
  if (!since) return false;
  try {
    return appliedProgressionEscalations(name, since, date) > 0;
  } catch {
    return false;
  }
}

// Same-pattern variation MENU for a lift, ranked toward the athlete's available
// equipment + heavier COMPOUND loading (the owner's explicit goal), gently biased
// by learned 'preference' memories, never re-suggesting a movement/slot already in
// the week. Pure over suggestAlternatives.
// A variation that is itself a loaded bench-style press (close-grip included, which
// `pressSlotKey` deliberately leaves out of the angle slots) is one more chest press.
function horizontalPressFamily(name: string): boolean {
  if (pressSlotKey(name) != null) return true;
  const n = normalizedExerciseKey(name).replace(/[-_]/g, " ");
  return /\bbench\b/.test(n) && /\bpress\b/.test(n) && !/\b(overhead|ohp|military)\b/.test(n);
}

// Pressing already on the day: a bench-style press, or dips (a chest/triceps press).
function dayCarriesPress(dayNames: string[]): boolean {
  return dayNames.some((n) => horizontalPressFamily(n) || /\bdips?\b/i.test(n));
}

function rankedVaryOptions(
  name: string,
  ctx?: PrescCtx,
  dayNames: string[] = []
): { name: string; why: string }[] {
  const equip = ctx?.availableEquipment ?? [];
  const exclude = ctx?.excludeNames ?? [];
  const prefs = ctx?.preferences ?? [];
  const filtered = (
    suggestAlternatives(name, {
      limit: 20,
      preferCompound: true,
      availableEquipment: equip.length ? equip : undefined,
      excludeNames: exclude.length ? exclude : undefined,
    }) as ExerciseVariation[]
  ).filter((candidate) => {
    const candidateKey = normalizedExerciseKey(candidate.name);
    const candidateMove = movementKey(candidate.name);
    const candidatePress = pressSlotKey(candidate.name);
    return !exclude.some(
      (planned) =>
        normalizedExerciseKey(planned) === candidateKey ||
        movementKey(planned) === candidateMove ||
        (candidatePress != null && pressSlotKey(planned) === candidatePress)
    );
  });
  // A rotation lands on THIS day, so it must not duplicate what the day already
  // presses: rotating a pushdown into a close-grip bench beside a dumbbell bench and
  // dips hands the athlete a third chest press. Leaving a lift that already IS a
  // press for another press stays allowed — the slot is the same one.
  const dayPresses = dayCarriesPress(dayNames) && !horizontalPressFamily(name);
  const dayKeys = new Set(dayNames.map((n) => normalizedExerciseKey(n)));
  const dayMoves = new Set(dayNames.map((n) => movementKey(n)));
  const onDay = filtered.filter(
    (candidate) =>
      !dayKeys.has(normalizedExerciseKey(candidate.name)) &&
      !dayMoves.has(movementKey(candidate.name)) &&
      !(dayPresses && horizontalPressFamily(candidate.name))
  );
  return riskRerank(historyRerank(preferenceRerank(onDay, name, prefs)), ctx?.date)
    .slice(0, 3)
    .map((v) => ({ name: v.name, why: v.why }));
}

// Prefer a variation the athlete has actually loaded: its card opens on their own
// working weight instead of a blank "establish a baseline". Stable otherwise.
function historyRerank(candidates: ExerciseVariation[]): ExerciseVariation[] {
  if (candidates.length < 2) return candidates;
  const logged = (candidate: ExerciseVariation): boolean => {
    try {
      return recentWorkingWeight(candidate.name) != null || recentWorkingSeconds(candidate.name) != null;
    } catch {
      return false;
    }
  };
  return candidates
    .map((c, i) => ({ c, i, logged: logged(c) }))
    .sort((a, b) => Number(b.logged) - Number(a.logged) || a.i - b.i)
    .map((x) => x.c);
}

// Demote movements this athlete's own tolerance memory has FLAGGED. A swap-in is a
// movement they'll be running for weeks, so proposing one that has repeatedly gone
// badly is worse than proposing the second-best candidate. Never filters — a flagged
// movement drops to the back of the menu but stays available, the same way a
// disliked one does. Stable: everything else keeps the ranking it arrived with.
function riskRerank(candidates: ExerciseVariation[], date?: string): ExerciseVariation[] {
  if (candidates.length < 2) return candidates;
  const flagged = (candidate: ExerciseVariation): boolean => {
    try {
      const ex = findExercise(candidate.name);
      if (!ex) return false; // never trained → no tolerance memory to hold against it
      return movementRiskFor(ex.id, date)?.risk === "flagged";
    } catch {
      return false;
    }
  };
  return candidates
    .map((c, i) => ({ c, i, flagged: flagged(c) }))
    .sort((a, b) => Number(a.flagged) - Number(b.flagged) || a.i - b.i)
    .map((x) => x.c);
}

// ---- the per-lift prescription ----------------------------------------------
// nextPrescription reads the latest logged top set + RIR + the lift's
// program-state status/trend, and proposes the NEXT session's target. Returns
// null when there's no history AND no plan item to read (nothing to say). Pass a
// pre-built `states` map when iterating many lifts (avoids recomputing the whole
// program-state per lift).
export interface PrescriptionOpts {
  autoreg?: AutoregSignals | null; // latest 1-tap session feedback (soreness/perf/joint)
  acute?: Map<MuscleGroup, AcuteGateReading> | null; // the shared acute-recovery gate per group
  availableEquipment?: Equipment[] | null; // rank variation candidates by what the athlete can load
  excludeNames?: string[] | null; // movements already in the week — don't re-suggest their exercise/slot
  personalModifier?: CoachPersonalModifier | null; // learned step size; never overrides constraints/recovery
  preferences?: ParsedPreference[] | null; // learned like/dislike memories; gently re-ranks variety, never constraints
  date?: string | null; // the day whose phrasing rotation applies (defaults to today)
  block?: ActiveBlockContext | null; // the active periodization block; null = nothing periodizes this pass
  cut?: CutPressure | (() => CutPressure) | null; // the shared fuel/cut read for the pass (lazy when a thunk, recomputed when absent)
  estimate?: EstimateReader | null; // the shared, lazy per-lift calibration read for the pass
  drive?: TrainingDrive | null; // the athlete's standing posture (settings.training_drive); read from settings when absent
  slotStamps?: Map<number, string | null> | null; // a pass's one read of plan_items.prescribed_at (planSlotStamps)
}

// The athlete's own standing declaration. It buys a handful of things below — a
// top set can earn the load step outside an intensification phase, an earned
// step (and a vary/introduce rotation) survives a soft fueling hold, a single
// met/exceeded on a full comparable dose is enough to take the step, and a
// re-ground that met its own snapshot stays comparable. It buys nothing from a
// SAFETY floor: the acute gate, the autoregulation brake, the symptom gates, the
// unverified-regression hold, a load-limiting constraint note and the clinician
// tier are all deliberately blind to it.
export type TrainingDrive = "steady" | "push";

export function readTrainingDrive(): TrainingDrive {
  try {
    return getSettings().training_drive === "push" ? "push" : "steady";
  } catch {
    return "steady";
  }
}

export function nextPrescription(
  rawExerciseName: string,
  states?: Map<string, LiftState>,
  opts?: PrescriptionOpts
): Prescription | null {
  // Canonicalize ONCE, at the entry. Everything below this line is keyed by name —
  // the plan slot, the logged history, the lift state, the tenure — so resolving
  // here is what stops a prescription that found the plan item under an alias from
  // reading no history for the same lift. An unknown name passes through unchanged.
  const resolvedName = resolveExerciseName(rawExerciseName);
  const exerciseName = resolvedName.exercise_id != null ? resolvedName.canonical : rawExerciseName;
  const ex = resolvedName.exercise_id != null ? getExercise(resolvedName.exercise_id) : null;
  const mode: "reps" | "timed" = ex?.mode === "timed" ? "timed" : "reps";
  const group: string | null = ex?.muscle_group ?? null;
  // Autoregulation + acute-recovery gate. Compute lazily for a standalone call so
  // Today's per-lift read is braked too; planDayProgression threads a shared read in.
  const canonGroup: MuscleGroup | null = canonicalGroup(group) ?? classifyMuscleGroup(exerciseName);
  const autoreg = opts && "autoreg" in opts ? (opts.autoreg ?? null) : recentAutoregulation();
  const acute = opts && "acute" in opts ? (opts.acute ?? null) : acuteGates();
  const equip = opts && "availableEquipment" in opts ? (opts.availableEquipment ?? []) : availableEquipment();
  const excludeNames = (opts?.excludeNames ?? []).filter(Boolean);
  const personalModifier =
    opts && "personalModifier" in opts ? (opts.personalModifier ?? null) : trainingModifierFor(exerciseName);
  const preferences = opts && "preferences" in opts ? (opts.preferences ?? []) : learnedPreferences();
  const tenureWeeks = movementTenureWeeks(exerciseName);
  // Only a LOAD-limiting constraint (pain/strain under load) freezes load. A form/
  // grip/ROM cue ("neutral grip only, no supinated curls") does NOT — the athlete
  // manages it technically and still earns load. classifyConstraint draws the line so
  // a grip note no longer strands a lift at a stale weight (the cubital-tunnel bug).
  const loadConstrained = classifyConstraint(ex?.constraint_note) === "load";
  const plan = planItemFor(exerciseName, opts?.slotStamps ?? null);
  // Cardio plan items aren't progressed here (the runner loop owns those).
  if (plan && plan.kind === "cardio") return null;
  const cur = currentTarget(plan, mode);
  const last = latestTopSet(exerciseName);
  // Stretching / activation / mobility is prep, not a lift. It never picks up
  // load, never earns "you already lifted this", and never enters the apply path.
  if (isPrepWork(exerciseName, group) && (last || plan)) {
    return prepWorkPrescription(exerciseName, mode, last, cur);
  }
  const state = liftStateFor(exerciseName, states);

  // Nothing logged and nothing planned → genuinely nothing to read.
  if (!last && !plan) return null;

  const date = String(opts?.date || localDateISO()).slice(0, 10);
  // A CARRY or isometric HOLD kept in reps mode, with a "rep" count no set of reps
  // reaches: that is seconds typed into the reps column (and, as often, junk in the
  // RIR field beside it). Reading it as reps is how "12 on every set — add the small
  // step" got said over a carry. No step is taken on numbers that mean something
  // else; the card holds and says how to log it so it can move.
  if (
    mode === "reps" &&
    last?.reps != null &&
    Number(last.reps) > CARRY_REPS_AS_SECONDS &&
    holdLikeMovement(exerciseName, group)
  ) {
    const suggested: PrescriptionTarget = cur
      ? { ...cur }
      : { sets: plan?.sets || 3, weight: last.weight ?? null };
    return {
      exercise: exerciseName,
      mode,
      action: "hold",
      suggested,
      current: cur,
      delta_text: "hold",
      why: voice.liftVoice(voice.CARRY_LOGGED_AS_REPS_HOLD, date, "carry_logged_as_reps_hold", exerciseName),
    };
  }
  const brakeCtx: PrescCtx = {
    canonGroup,
    autoreg,
    acute,
    tenureWeeks,
    availableEquipment: equip,
    excludeNames,
    personalModifier,
    preferences,
    date,
    block: opts && "block" in opts ? (opts.block ?? null) : activeBlockContext(date),
    cut: cutPressureThunk(date, opts?.cut ?? null),
    estimate: estimateReader(date, opts?.estimate ?? null),
    // The declaration is a property of the DAY, so a pass over many lifts reads it
    // once and threads it in (planDayProgression does); a standalone call reads it
    // here. Absent OR null means "whatever the athlete has standing" — there is no
    // meaningful third state to preserve, unlike the block/cut/estimate thunks.
    drive: opts?.drive ?? readTrainingDrive(),
    // The band is a property of THIS movement on THIS day, so it is read per lift.
    // The read returns null before touching its heavier queries when nothing has
    // been stated about the movement, which is the ordinary case.
    pain: painBandForMovement({ id: ex?.id ?? null, name: exerciseName, muscle_group: group }, date),
  };
  if (mode === "timed")
    return timedPrescription(exerciseName, group, loadConstrained, plan, cur, last, state, brakeCtx);
  return repsPrescription(exerciseName, group, loadConstrained, plan, cur, last, state, brakeCtx);
}

// Above this many "reps" on a carry or hold, the number is seconds, not reps.
const CARRY_REPS_AS_SECONDS = 25;

// A movement whose work is TIME under load — a loaded carry, or anything the
// name-level timed detector already calls a hold (plank, hang, wall sit).
function holdLikeMovement(name: string, group: string | null): boolean {
  return classifyPattern(name, group ?? undefined) === "carry" || detectExerciseMode(name) === "timed";
}

interface PrescCtx {
  canonGroup: MuscleGroup | null;
  autoreg: AutoregSignals | null;
  acute: Map<MuscleGroup, AcuteGateReading> | null;
  tenureWeeks: number | null;
  availableEquipment: Equipment[];
  excludeNames: string[];
  personalModifier: CoachPersonalModifier | null;
  preferences: ParsedPreference[];
  date: string; // keys the per-day phrasing rotation (with the exercise as the offset)
  block: ActiveBlockContext | null; // the active periodization block, when one is running
  cut: () => CutPressure; // the fuel/cut pressure, computed at most once and only if consulted
  estimate: EstimateReader; // the calibration read, computed at most once per lift and only if consulted
  drive: TrainingDrive; // the athlete's standing "push me" declaration; bounded authority, never over a safety floor
  pain: PainBandRead | null; // this movement's traffic-light band; null = nothing stated (absent, not green)
}

// recentWorkingWeight over only the sessions logged under the slot's CURRENT
// prescription (prescription-authorship.ts `sinceClause`: a later day, or on the
// stamp's own day a set created after it). With no stamp, the usual window. Null when
// none of those sessions carried a load. Shared by the reps path and the daily
// decision's earned floor, so both read the same evidence.
export function workingWeightUnderPrescription(
  name: string,
  authorship: Pick<SlotAuthorship, "since" | "since_at">,
  opts: { sessionsBack?: number; before?: string } = {}
): number | null {
  const sessionsBack = opts.sessionsBack ?? 3;
  if (!authorship.since) return recentWorkingWeight(name, sessionsBack, opts.before);
  const ids = progressionLineageIds(name);
  if (!ids.length) return null;
  const inIds = ids.map(() => "?").join(",");
  const since = sinceClause(authorship);
  const before = opts.before ? String(opts.before).slice(0, 10) : null;
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT s.date) AS n FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE ls.exercise_id IN (${inIds}) AND ls.weight IS NOT NULL AND ls.weight != 0 AND ${since.sql}
          ${before ? "AND s.date < ?" : ""}`
    )
    .get(...ids, ...since.args, ...(before ? [before] : [])) as { n?: number } | undefined;
  const count = Number(row?.n ?? 0);
  if (!(count > 0)) return null;
  return recentWorkingWeight(name, Math.min(sessionsBack, count), opts.before);
}

// The lift's latest logged exposure as prescription-authorship reads it: the session's
// day and its first set's time.
function lastExposureOf(name: string, last: ReturnType<typeof latestTopSet>): Exposure {
  if (!last) return null;
  return { date: last.date, first_at: sessionFirstSetAt(last.session_id, progressionLineageIds(name)) };
}

function repsPrescription(
  name: string,
  group: string | null,
  loadConstrained: boolean,
  plan: ReturnType<typeof planItemFor>,
  cur: PrescriptionTarget | null,
  last: ReturnType<typeof latestTopSet>,
  state: LiftState | null,
  brakeCtx?: PrescCtx
): Prescription {
  // Every verdict below picks its sentence from a SET of phrasings keyed on the day
  // and this lift, so two lifts in the same state never print the same line.
  const date = brakeCtx?.date ?? localDateISO();
  const say = <T>(set: readonly T[], code: string): T => voice.liftVoice(set, date, code, name);
  // Ground in REALITY. The load to progress FROM is the HARDER of the plan target and
  // the athlete's actual recent working weight — so a stale plan target (e.g. 27 lb)
  // can't strand a lift the athlete is genuinely driving (45–50 lb every week). Falls
  // back cleanly when one side is absent (off-plan → logged; nothing logged → plan).
  // Encoding preserved: assist is negative and the larger signed value is the harder/
  // realer load, so Math.max picks the right "from" in both regimes.
  const repLow = plan?.rep_low ?? cur?.rep_low ?? undefined;
  const repHigh = plan?.rep_high ?? cur?.rep_high ?? undefined;
  const planWeight = plan?.weight ?? null;
  // What the log supports at the plan's own rep floor. The heaviest recent top set
  // says nothing about reps — a calf raise done at 90 × 8 used to catch the plan up
  // to 90 × 15 — and an agent restructure can write a squat target the athlete's
  // best week never touched. Either way the hold waits for sets that cannot happen.
  const achievable = repLow != null ? achievableWorkingWeight(name, repLow, date) : null;
  const unreachable = (w: number | null): boolean =>
    w != null && w > 0 && achievable != null && w > achievable * REACHABLE_TOLERANCE;
  // Judged against the CURRENT prescription: when the slot carries an authored date,
  // only the loaded sessions on or after it can re-ground it — the work done under an
  // older prescription (a heavier block three weeks back) is not a working weight the
  // athlete has shown at THIS one. With no authored date (a pre-v111 row) the window
  // is the usual last few sessions.
  //
  // A slot written with NO load on a lift with loaded history is still grounded
  // (planUnset below): from the sessions under this prescription when there are any,
  // else the latest history, exactly as before the stamp existed.
  const authorship = slotAuthorship(plan?.prescribed_at ?? null, lastExposureOf(name, last), date);
  const underPrescription = workingWeightUnderPrescription(name, authorship);
  const loggedWorking = planWeight == null ? (underPrescription ?? recentWorkingWeight(name)) : underPrescription;
  const recentWorking = unreachable(loggedWorking) ? achievable : loggedWorking;
  // Sign is the encoding, not the name. A lift called "Assisted Pull-Up" with a
  // purely positive history is weighted work; the name must not freeze it as assist.
  const assistHistory = (planWeight != null && planWeight < 0) || (recentWorking != null && recentWorking < 0);
  let baseWeight: number | null;
  if (planWeight != null && recentWorking != null) {
    // A positive log on an assisted plan is untrusted for grounding — a typing
    // slip of +40 on a −25 assist lift must not become the "harder" load.
    if (planWeight < 0 && recentWorking > 0) baseWeight = planWeight;
    else if (planWeight > 0 && recentWorking < 0) baseWeight = recentWorking;
    else baseWeight = Math.max(planWeight, recentWorking);
  } else
    baseWeight =
      planWeight != null
        ? planWeight
        : recentWorking != null
          ? recentWorking
          : last?.weight != null
            ? Number(last.weight)
            : null;
  // The plan target is BEHIND what they're actually lifting → the prescription also
  // RE-GROUNDS the plan: the displayed "current" reflects reality, and applying lands
  // the plan target on what they truly handle ("gradually adjust the plan from logs").
  //
  // A NULL plan target with real logged history counts as behind. It used to be
  // excluded (`planWeight != null`), which meant the whole re-grounding path was
  // unreachable for exactly the lifts that need it most — a movement rotated in with
  // no target, then loaded for real, stayed at NULL forever with the catch-up prose
  // dead code. The bodyweight encoding is safe here: recentWorkingWeight ignores
  // null/zero loads, so a genuinely bodyweight lift never reads as behind.
  // A positive recent on an assisted plan is NOT behind — that number is the slip
  // the sign-integrity path exists to ignore, not a working weight to catch up to.
  // ASSIST RETIRED. Assisted → bodyweight → loaded is ONE ladder, and the log is
  // the truth about which rung the athlete is on. recentWorkingWeight reads only
  // non-zero loads, so a lift done at bodyweight for sessions — with one assisted
  // finisher — still read as "assist": the card kept asking for help the athlete
  // had stopped needing. When the recent sessions show unassisted working sets at
  // the plan's own rep floor, the base is bodyweight (null) and an assist target is
  // BEHIND reality, re-grounded through the same proposal as any catch-up. Never
  // past bodyweight in one step: added load is earned from there by the ladder.
  // A FRESH PRESCRIPTION IS THE BASELINE. When the slot was authored after the last
  // time this lift was logged (plan_items.prescribed_at is newer than the latest
  // exposure), nothing in the log was done AT it: the athlete (or a redraw) just wrote
  // this load, and a three-week-old top set, an in-flight wave, or a heavier recent
  // session cannot argue with a number nobody has trained yet. So the plan's own
  // sets/reps/weight stand as a HOLD — no re-ground, no catch-up, no plan-ahead
  // reach-down, no movement-response or push step off older work — and the first
  // session at it sets the baseline. The safety floors (a load-limiting note, the
  // autoregulation and pain brakes) still apply on top. One exposure on or after
  // prescribed_at and the ordinary ladder resumes, judged against the plan target.
  // The timed path has kept this rule all along (`evidencePredates`). A slot written
  // with no load at all is the exception: there is no number to stand, so it grounds
  // like any unset slot (planUnset).
  const groundsUnsetSlot =
    plan != null && planWeight == null && recentWorking != null && !(assistHistory && recentWorking > 0);
  const untested = authorship.untested && !groundsUnsetSlot;
  if (untested) baseWeight = planWeight;
  const assistRetired =
    !untested &&
    baseWeight != null &&
    baseWeight < 0 &&
    repLow != null &&
    unassistedProvenSessions(name, repLow) >= ASSIST_RETIRE_SESSIONS;
  if (assistRetired) baseWeight = null;
  const planUnset =
    !untested && !assistRetired && plan != null && planWeight == null && recentWorking != null && !(assistHistory && recentWorking > 0);
  const planBehind =
    !untested &&
    (planUnset ||
    (assistRetired && planWeight != null && planWeight < 0) ||
    (planWeight != null &&
      recentWorking != null &&
      !(planWeight < 0 && recentWorking > 0) &&
      recentWorking > planWeight + 0.1));
  // …and the mirror: a plan target the log cannot reach re-grounds DOWN to the
  // achievable load, through the same reground proposal as a catch-up. Except when the
  // plan is ONE earned step above a session finished with reps in reserve: Epley reads
  // the reps done, not the ones left, so 35 × 10 at RIR 4 made a written 40 look out of
  // reach and every card served the older, under-loaded 35. That target is the plan
  // stepping up on purpose, and the reps fill in at it.
  const planAhead =
    !untested && !planBehind && unreachable(planWeight) && !steppedUpFromReserve(name, group, planWeight, repLow);
  if (planAhead) baseWeight = achievable;

  const sets = plan?.sets || 3;

  // The decision. Order matters: an injury constraint HOLDS load before anything
  // else; then read the program-state status (progressing / plateaued / …).
  let action: ProgressionAction;
  let why: string;
  let nextWeight: number | null = baseWeight;
  let varyTo: string | undefined;
  let varyOptions: { name: string; why: string }[] | undefined;
  let repStep = false; // a DOUBLE-PROGRESSION rep advance (load held, reps climb in-range)
  let startingIdea = false; // the suggestion is a related-lift idea, not this lift's own history
  // CUT_HOLDING_WIN may only replace the not-earned / top-set-only fallthrough
  // sentence — never a plan-behind catch-up or a phase hold.
  let fallthroughHold = false;
  // Equipment-ranked, compound-biased, plan-deduped same-pattern candidates —
  // computed ONCE and reused by the vary + introduce branches (and the introduce guard).
  const varyCandidates = rankedVaryOptions(name, brakeCtx, plan?.day_exercises ?? []);
  const freshPrescription = authorship.fresh;
  // A movement with nothing logged of its own and no number on the plan is exactly
  // the case a rotate-in creates. Rather than showing an empty target and "start
  // light", offer a conservative starting idea from a related lift the athlete does
  // train — HERE, in the live prescription, and never in plan_items (a stored guess
  // would become the floor every future step is measured from; see related-lift.ts).
  // A load-limiting note is the authority and skips this entirely, and one logged
  // set retires it for good.
  const relatedStart = !last && baseWeight == null && !loadConstrained ? relatedLiftStart(name) : null;

  const status = state?.status ?? "new";
  const lastRir = last?.rir ?? null;
  // PERIODIZATION. The active block's phase changes what a MAIN lift is asked for;
  // isolation/accessory work keeps plain double progression, and with no block
  // running `policy` is null and every line below behaves exactly as it always did.
  const mainLift = isMainLift(group, plan);
  // Deliberate: an accessory gets NO policy even mid-block, so `holds_load` is
  // false for it and a deload week does not restrain the push rule on accessory
  // work. That is the existing "accessories never periodize" design, not an
  // oversight — the easy week is about the lifts the block is actually running.
  const policy: PhaseProgressionPolicy | null =
    brakeCtx?.block && mainLift ? phaseProgressionPolicy(brakeCtx.block.phase) : null;
  // DOUBLE PROGRESSION, grounded in what was ACTUALLY logged: advance REPS within the
  // prescribed range first, and only add LOAD once EVERY working set has hit the TOP of
  // the range — then reset reps to the bottom at the new load. `allSetsAtTop` reads the
  // latest session's working sets (a lone logged top set is trusted); `roomInRange` means
  // the top set is still below the ceiling (a rep to earn). No range (repHigh null) → the
  // old single-top-set read.
  //
  // A volume phase raises that ceiling by its saturation reps: the range has to be
  // genuinely full — a clean rep ON TOP of it, every set — before the load moves, so
  // the phase is spent banking work rather than stepping the bar.
  const hasRange = repLow != null && repHigh != null;
  const repCeiling = hasRange ? (repHigh as number) + (policy?.rep_saturation ?? 0) : null;
  const workingSets = latestWorkingSets(name);
  const doseEligibility = linkedDoseEligibility(last?.session_id, name, { planBehind });
  const topReps = last?.reps != null ? Number(last.reps) : null;
  const setsAtTop = hasRange
    ? workingSets.filter((s) => s.reps != null && (s.reps as number) >= (repCeiling as number)).length
    : 0;
  const allSetsAtTop = hasRange && workingSets.length > 0 && setsAtTop === workingSets.length;
  const topSetAtTop = hasRange && topReps != null && topReps >= (repCeiling as number);
  const roomInRange = hasRange && topReps != null && topReps < (repCeiling as number);
  // "Strong" = the work earned progression.
  //
  // ABSENCE OF A FELT RATING IS NOT WEAKNESS. The finish flow never asks for RIR,
  // so on real logs every exposure carries none — and reading that silence as "not
  // strong" closed the loop on itself: nothing was earned, so the plan never moved,
  // so the same weight was repeated at the TOP of the rep range, so the estimated
  // trend stayed flat, so nothing was ever earned. Classic DOUBLE PROGRESSION needs
  // no felt rating: capping the prescribed rep range IS the strength signal, and the
  // completeness gates below (allSetsAtTop / topSetAtTop / roomInRange) are what
  // actually require the cap. So with no RIR logged, the work speaks for itself.
  //
  // A LOGGED rating still speaks, in both directions: RIR ≤ 1 was a grind and holds
  // (unless the trend independently reads progressing, which it always did), and
  // RIR ≥ 2 still counts even below the ceiling for the rep stage.
  const rirLogged = lastRir != null;
  // A step is earned by CURRENT work. A lift that sat out of the rotation past
  // LIFT_CURRENT_WINDOW_DAYS while the athlete kept training re-baselines at its last
  // load when it comes back — a July top set does not buy a heavier card in September.
  // Measured against the athlete's latest logged session on or before the read's date,
  // not the wall clock: the question is "has this lift left the rotation", and a
  // historical replay must read the calendar it is replaying.
  const recencyRef = latestLoggedSessionDate(date) ?? date;
  const lastAge = last?.date ? daysBetweenISO(recencyRef, last.date) : null;
  const current = lastAge == null || lastAge <= LIFT_CURRENT_WINDOW_DAYS;
  const strong =
    current &&
    doseEligibility.eligible &&
    (status === "progressing" || (rirLogged ? (lastRir as number) >= RIR_IN_RESERVE : true));
  // The card must not tell an athlete who never logs RIR to come back at "RIR 2+".
  // Where a phrasing names the rating, the same meaning also exists spoken in reps;
  // the RIR wording is picked ONLY when an RIR was actually logged.
  const sayEffort = <T>(withRir: readonly T[], inReps: readonly T[], code: string): T =>
    say(rirLogged ? withRir : inReps, code);
  // The LOAD step is earned only when EVERY working set capped the range (double
  // progression). With no rep range, fall back to a strong top set (RIR 2+ / progressing).
  // An INTENSIFICATION phase buys the step with intensity instead of completeness: a
  // strong top set at the ceiling is enough on its own.
  // An athlete who has asked to be pushed buys the intensification phase's own
  // rule in ordinary phases too: a strong set at the ceiling is enough. A phase
  // that HOLDS load (deload, realization) keeps the strict reading — the easy week
  // is not something a declaration talks its way out of.
  const drive = brakeCtx?.drive ?? "steady";
  const topSetEarnsLoad = !!policy?.top_set_earns_load || (drive === "push" && !policy?.holds_load);
  const pushEarnedTopSet = topSetEarnsLoad && !policy?.top_set_earns_load && hasRange && !allSetsAtTop;
  // With NO rep range there is no cap to earn, so silence alone must not promote a
  // lift on nothing: the exposure has to have MET its own prescribed dose, or an
  // RIR ≥ 2 has to have been logged, or the trend has to read progressing.
  const openEarned =
    strong && (rirLogged || status === "progressing" || doseEligibility.reason === "full_comparable");
  const earnedByWork = hasRange ? (topSetEarnsLoad ? topSetAtTop : allSetsAtTop) && strong : openEarned;
  // The REP stage: strong work with a rep still to win inside the (possibly widened) range.
  const repStageEligible = hasRange && strong && roomInRange && !allSetsAtTop;
  // Every working set finished at the TOP of the prescribed range with reps still in
  // hand. That is the athlete OUT-DOING the card in the only way a held target allows:
  // the card caps the reps and fixes the weight, so there is nothing left to give but
  // reserve, and reserve is exactly what they showed. A grind (RIR ≤ 1) is not this.
  // It takes a SESSION, not a set: a lone logged top set is trusted for reading the
  // working weight, but it is not evidence the card was worked through, so at least two
  // capped working sets are required (or the whole card, when it asks for one).
  const workingRir = workingSets.map((s) => s.rir).filter((r): r is number => r != null);
  const cappedWithReserve =
    hasRange &&
    allSetsAtTop &&
    workingSets.length >= Math.min(sets, 2) &&
    (workingRir.length > 0
      ? workingRir.every((r) => r >= RIR_IN_RESERVE)
      : rirLogged && (lastRir as number) >= RIR_IN_RESERVE);
  // A recovery or peak week adds nothing new — neither load nor another rep. The
  // work was real; it just waits for the week to turn over.
  const phaseHolds = !!policy?.holds_load && (earnedByWork || repStageEligible);
  const earned = policy?.holds_load ? false : earnedByWork;
  // The phase's PACING of an earned step. Outside a block this is 1 — the step size
  // the engine has always produced.
  const phaseStepScale = policy?.step_scale ?? 1;
  // How much this lift's estimated single deserves to be trusted, and whether an
  // apparent slip is worth pausing over rather than deloading. Read at most once
  // per lift per pass, and ONLY from the two branches below that consult it.
  let estimateRead: UnverifiedRegressionHold | null = null;
  const estimate = (): UnverifiedRegressionHold =>
    (estimateRead ??= (brakeCtx?.estimate ?? estimateReader(date))(name));
  // PEAK WEEK's top-set protocol, when the phase asks for one and this lift is a main
  // lift the plan actually loads (the same reading the calibration ledger uses to pick
  // which lifts are worth re-testing). A slipping lift is not tested; it is rebuilt.
  const peakProtocol =
    policy?.top_set_protocol &&
    !loadConstrained &&
    status !== "regressing" &&
    baseWeight != null &&
    baseWeight > 0 &&
    (plan?.weight ?? 0) > 0
      ? peakTopSetFor(
          name,
          baseWeight,
          sets,
          repLow,
          repHigh,
          estimate().confidence !== "verified" || (brakeCtx?.cut?.() ?? NO_CUT_PRESSURE).any,
          date
        )
      : null;
  let topSet: TopSetProtocol | undefined;
  // A repeat deload rewrites the rep window instead of cutting load again (below), and
  // a coarse-stepped isolation lift moves it UP at the held load (the rep-range move).
  let waveRepLow: number | undefined;
  let waveRepHigh: number | undefined;
  let escalated: Prescription["escalated"];
  // THE REP-RANGE MOVE (lift-response.ts). An isolation lift whose next load step is too
  // coarse for it answers with the range, not the load: rep_low/rep_high +3 at the held
  // weight, once. Two doors lead to it — a grind (RIR ≤ 1, in place of the deload) and an
  // EARNED step (every working set capped the range at the current load, in place of the
  // coarse jump: extended double progression). Both need the plan to agree with the log,
  // reps that already reach within one of the new floor, and no earlier move still
  // standing on this lift (the ledger read, taken only when a door is otherwise open).
  const repRangeCandidate =
    hasRange && !planBehind && !planAhead && !untested && !loadConstrained && baseWeight != null && baseWeight > 0
      ? movedRepRange(repLow as number, repHigh as number)
      : null;
  const rangeMoveReaches =
    repRangeCandidate != null && topReps != null && topReps >= repRangeCandidate.rep_low - 1;
  let rangeLedger: boolean | null = null;
  const rangeMoveUnspent = (): boolean => {
    if (rangeLedger != null) return rangeLedger;
    const prior = lastAppliedRepRangeMove(name, date);
    // Spent when the moved range still stands, or when the athlete undid it: an Undo
    // restores the old range, and reading that as "never moved" re-proposed the same
    // move at every boundary.
    rangeLedger = !(
      prior != null &&
      (prior.vetoed || prior.rep_low == null || (repLow as number) >= prior.rep_low)
    );
    return rangeLedger;
  };
  // Whether the move stands in for an earned step (braked like one) or for a grind's deload.
  let rangeMoveEarned = false;

  if (loadConstrained) {
    action = "hold";
    nextWeight = baseWeight;
    why = say(voice.CONSTRAINED_HOLD, "constrained_hold");
  } else if (untested) {
    // See `untested` above: the fresh prescription stands until a session is run at it.
    action = "hold";
    nextWeight = planWeight;
    why = say(voice.UNTESTED_PRESCRIPTION_HOLD, "untested_prescription_hold");
  } else if (peakProtocol) {
    // PEAK WEEK. The block's last week on a main lift is not another small step —
    // it is the week the work gets expressed: up to one heavy top set derived from
    // this lift's own best estimate, then back-off work. Logged, that top set is
    // exactly what re-anchors the estimate the rest of the year progresses from.
    action = "overload";
    nextWeight = peakProtocol.weight;
    topSet = peakProtocol;
    why = say(voice.REALIZATION_TOP_SET, "realization_top_set")(
      `${peakProtocol.weight} lb`,
      peakProtocol.reps === 1 ? "single" : peakProtocol.reps === 2 ? "double" : "triple"
    );
  } else if (status === "regressing") {
    // A slip is not automatically a load problem. Cutting the weight cannot fix a
    // calorie shortfall, and it cannot fix an estimate that nothing heavy has
    // confirmed in months — in both cases the honest move is to hold and let the
    // real cause resolve (the calibration ladder already suggests the test).
    //
    // The unverified arm is SCOPED and BOUNDED by calibration.ts, and has to be:
    // "unverified" is near-universal on real data, so an unconditional hold here
    // would switch the deload arm off, and a hold on a lift the ladder never offers
    // a test for is a dead end that leaves it at its current weight indefinitely.
    // See unverifiedRegressionHold for the three conditions.
    const cut = brakeCtx?.cut?.() ?? NO_CUT_PRESSURE;
    if (cut.any) {
      action = "hold";
      nextWeight = baseWeight;
      why = say(voice.CUT_REGRESSION_HOLD, "cut_regression_hold");
    } else if (estimate().holds) {
      action = "hold";
      nextWeight = baseWeight;
      why = say(voice.UNVERIFIED_REGRESSION_HOLD, "unverified_regression_hold");
    } else {
      action = "deload";
      nextWeight = baseWeight != null && baseWeight > 0 ? round5(baseWeight * (1 - DELOAD_FRAC)) : baseWeight;
      why = say(voice.REGRESSING_DELOAD, "regressing_deload");
    }
  } else if (
    status === "plateaued" &&
    !(
      // A "plateau" is a claim about the ATHLETE, but when the log shows them
      // OUT-DOING the card — heavier than the plan asked, more working sets than it
      // prescribed, or every working set capping the rep range with reps still in
      // reserve — the flat trend is the PLAN's doing (a held target can only ever
      // reproduce itself), so the earned ladders below own the decision.
      // The athlete cannot take a step the card withholds: at a fixed weight and a
      // capped range, finishing at RIR ≥ 2 IS the out-doing, and calling it a stall
      // rotated a movement out from under someone who did exactly what was asked.
      // A GRIND (RIR ≤ 1) is different and keeps the plateau read — the reps were not
      // in hand, so the load is genuinely where they are. With NO felt rating, capping the
      // range is the only signal there is, and double progression's step is its
      // answer — the step when the range is capped, one more rep when it is not
      // (repStageEligible), and a capped top set over uncapped backoffs falls to the
      // finish-the-range ask below. A cut that genuinely vetoes promotion (reduce off goal, sliding
      // anchors) keeps the plateau read too — deferring would hand out a step the
      // cut rules just refused.
      (planBehind || workingSets.length > sets || !rirLogged || cappedWithReserve) &&
      (earnedByWork || repStageEligible || (hasRange && topSetAtTop && !allSetsAtTop && strong)) &&
      !cutVetoesPromotion(brakeCtx?.cut?.() ?? NO_CUT_PRESSURE, { status })
    )
  ) {
    // Grinding (RIR ≤ 1) → deload; flat long enough → vary; else hold/technique.
    //
    // How long "long enough" is is not a constant any more. A genuine deficit widens
    // it — a flat lift while the scale falls is muscle held, not a stall, and
    // reshuffling movements mid-cut trades a readable lift for a fresh unknown. The
    // ledger's own record on THIS lift moves it too: verdicts that have been landing
    // buy it patience, verdicts that have been missing bring the change forward.
    const cut = brakeCtx?.cut?.() ?? NO_CUT_PRESSURE;
    const counsel = ledgerCounsel(name);
    const flatWeeks = state?.weeks_static ?? 0;
    const varyAfterWeeks = Math.min(
      8,
      Math.max(2, PLATEAU_VARY_WEEKS + (cut.any ? PLATEAU_CUT_PATIENCE_WEEKS : 0) + counsel.patience - (counsel.doubt ? 1 : 0))
    );
    const grinding = lastRir != null && lastRir <= 1;
    const flatLong = flatWeeks >= varyAfterWeeks;
    // An ISOLATION grind whose next load step is too coarse to take (a 15 lb lateral
    // raise whose next step is 20): a tenth off is the same coarse jump the other way,
    // so the answer is the rep range, not the load. The range moves up at the held
    // weight — only when the athlete's reps already reach the new floor (within a rep),
    // the plan agrees with the log, and this lift has not been moved up a range before
    // (a later stall in the higher range falls to the ordinary ladder below, never a
    // second move). Compounds and anything uncoarse keep the deload.
    const repRange =
      grinding && rangeMoveReaches && coarseLoadStep(name, baseWeight, group) && rangeMoveUnspent()
        ? repRangeCandidate
        : null;
    if (repRange) {
      action = "hold";
      nextWeight = baseWeight;
      waveRepLow = repRange.rep_low;
      waveRepHigh = repRange.rep_high;
      escalated = "rep_range";
      why = say(voice.ISOLATION_REP_RANGE, "isolation_rep_range");
    } else if (grinding) {
      action = "deload";
      nextWeight = baseWeight != null && baseWeight > 0 ? round5(baseWeight * (1 - DELOAD_FRAC)) : baseWeight;
      why = counsel.doubt
        ? say(voice.LEDGER_MISSED_DELOAD, "ledger_missed_deload")
        : say(voice.PLATEAU_GRIND_DELOAD, "plateau_grind_deload");
    } else if (flatLong && !freshPrescription) {
      action = "vary";
      nextWeight = baseWeight;
      // Carry a concrete same-pattern candidate so "switch it up" is actionable (Today
      // shows the real alternative; the evolution/apply path can rotate it in).
      // A MENU of same-pattern candidates (not just one forced swap) so the athlete
      // chooses; vary_to stays the lead candidate for back-compat. Ranked by the
      // athlete's available equipment + biased toward heavier compound loading, and
      // never re-suggesting a movement already on the day.
      varyOptions = varyCandidates;
      varyTo = varyOptions[0]?.name;
      why = varyTo
        ? say(voice.PLATEAU_VARY_TO, "plateau_vary_to")(state?.weeks_static ?? 0, varyTo)
        : say(voice.PLATEAU_VARY_OPEN, "plateau_vary_open")(state?.weeks_static ?? 0);
    } else {
      action = "hold";
      nextWeight = baseWeight;
      // Same hold, three different truths about why it is the right one.
      why = flatLong
        ? say(voice.FRESH_PRESCRIPTION_HOLD, "fresh_prescription_hold")
        : cut.any
        ? say(voice.PLATEAU_CUT_HOLD, "plateau_cut_hold")
        : counsel.patience > 0
          ? say(voice.LEDGER_PATIENCE_HOLD, "ledger_patience_hold")
          : say(voice.PLATEAU_HOLD, "plateau_hold");
    }
  } else if (!last && plan) {
    action = "hold";
    if (relatedStart) {
      nextWeight = relatedStart.weight;
      startingIdea = true;
      why = say(voice.RELATED_START_IDEA, "related_start_idea")(
        relatedStart.source_exercise,
        `${relatedStart.weight} lb`
      );
    } else {
      nextWeight = baseWeight;
      why = say(voice.NO_HISTORY_PLANNED_HOLD, "no_history_planned_hold");
    }
  } else if (
    !loadConstrained &&
    state?.status === "maintaining" &&
    (brakeCtx?.tenureWeeks ?? 0) >= INTRODUCE_TENURE_WEEKS &&
    varyCandidates.length > 0 &&
    !freshPrescription
  ) {
    // PROACTIVE variety: the lift is holding steady but you've run it a long time —
    // introduce a fresh same-pattern variation (ranked toward heavier compound
    // loading) before staleness sets in, rather than waiting for a measured plateau.
    // Load is held; the novelty IS the stimulus. This makes the "introduce" action
    // reachable deterministically.
    action = "introduce";
    nextWeight = baseWeight;
    varyOptions = varyCandidates;
    varyTo = varyOptions[0]?.name;
    why = say(voice.INTRODUCE_VARIATION, "introduce_variation")(
      ex_name(name),
      brakeCtx?.tenureWeeks ?? 0,
      varyTo ?? "a close variation"
    );
  } else if (repStageEligible && !policy?.holds_load) {
    // DOUBLE PROGRESSION — the REP stage. The work was strong but not every set has
    // capped the range yet: advance reps within the range, hold the load. This is NO
    // plan change (the plan already prescribes the range) — the athlete just earns reps.
    // In a volume phase the rep being chased is the one ON TOP of the plan's range.
    action = "overload";
    repStep = true;
    nextWeight = baseWeight;
    why =
      policy && policy.rep_saturation > 0
        ? say(voice.ACCUMULATION_REP_STAGE, "accumulation_rep_stage")(repCeiling as number)
        : sayEffort(voice.REP_STAGE_OVERLOAD, voice.REP_STAGE_OVERLOAD_REPS, "rep_stage_overload")(
            repHigh as number
          );
  } else if (
    earned &&
    !policy &&
    repRangeCandidate != null &&
    rangeMoveReaches &&
    allSetsAtTop &&
    workingSets.every((s) => s.weight != null && Math.abs(Number(s.weight) - (baseWeight as number)) < 0.1) &&
    (coarseLoadStep(name, baseWeight, group) ||
      // …or the log already shows this load's last step bouncing (taken, reps fell under
      // the range, back to this load): the jump proved too coarse whatever its size.
      (isIsolationLift(name, group) && bouncedOffLoadStep(name, baseWeight as number, repLow as number))) &&
    rangeMoveUnspent()
  ) {
    // EXTENDED DOUBLE PROGRESSION. The range is capped at this load, and the next load is
    // a jump this lift does not take cleanly — so the range climbs first, at the held
    // weight. Once the higher range is capped too, the ordinary load step follows.
    action = "hold";
    nextWeight = baseWeight;
    waveRepLow = repRangeCandidate.rep_low;
    waveRepHigh = repRangeCandidate.rep_high;
    escalated = "rep_range";
    rangeMoveEarned = true;
    why = say(voice.ISOLATION_REP_RANGE_EARNED, "isolation_rep_range_earned");
  } else if (earned) {
    // DOUBLE PROGRESSION — the LOAD stage. Every working set capped the range at RIR 2+
    // (or no range + a strong top set) → the small earned step up, then reset to the bottom.
    action = "overload";
    if (baseWeight == null) {
      // Bodyweight reps lift — no load to add; progression is reps/sets.
      nextWeight = null;
      why = say(voice.BODYWEIGHT_OVERLOAD, "bodyweight_overload");
    } else if (baseWeight < 0) {
      // Assisted — reduce the assist toward bodyweight (a smaller absolute value).
      nextWeight = assistStepNext(baseWeight, group, brakeCtx?.personalModifier, phaseStepScale);
      why =
        nextWeight == null
          ? say(voice.ASSIST_TO_BODYWEIGHT, "assist_to_bodyweight")
          : say(voice.ASSIST_PEEL, "assist_peel");
    } else {
      nextWeight = clampedOverload(baseWeight, group, brakeCtx?.personalModifier, phaseStepScale);
      // The phase, when there is one, owns the sentence: the same earned step means
      // something different in a volume stretch than in a sharpening one.
      why =
        policy?.top_set_earns_load && hasRange
          ? say(voice.INTENSIFICATION_OVERLOAD, "intensification_overload")
          : // A volume stretch owns the sentence ahead of the declaration: the step is
            // still gentle and the volume is still the point, which is the thing the
            // athlete most needs to hear on an accumulation card.
            policy && policy.step_scale < 1
            ? say(voice.ACCUMULATION_OVERLOAD, "accumulation_overload")
            : pushEarnedTopSet
              ? // The step came from the top set alone because the athlete asked for
                // that, so the sentence says so rather than claiming every set capped.
                // The bar it cleared is the CEILING (the range's top plus whatever the
                // phase saturates on), never the plain rep_high.
                sayEffort(voice.PUSH_TOP_SET_OVERLOAD, voice.PUSH_TOP_SET_OVERLOAD_REPS, "push_top_set_overload")(
                  repCeiling as number
                )
            : hasRange
              ? sayEffort(voice.EARNED_RANGE_OVERLOAD, voice.EARNED_RANGE_OVERLOAD_REPS, "earned_range_overload")(
                  repHigh as number,
                  repLow as number
                )
              : sayEffort(voice.EARNED_OPEN_OVERLOAD, voice.EARNED_OPEN_OVERLOAD_REPS, "earned_open_overload");
    }
  } else if (phaseHolds) {
    // The work earned something and the WEEK is the reason it waits.
    action = "hold";
    nextWeight = baseWeight;
    why = policy?.top_set_protocol
      ? say(voice.PHASE_PEAK_HOLD, "phase_peak_hold")
      : say(voice.PHASE_DELOAD_HOLD, "phase_deload_hold");
  } else {
    action = "hold";
    nextWeight = baseWeight;
    if (last && !doseEligibility.eligible)
      why =
        doseEligibility.reason === "unfinished"
          ? say(voice.DOSE_UNFINISHED_HOLD, "dose_unfinished_hold")
          : doseEligibility.reason === "partial"
            ? say(voice.DOSE_PARTIAL_HOLD, "dose_partial_hold")
            : doseEligibility.reason === "under_prescribed"
              ? say(voice.DOSE_UNDER_HOLD, "dose_under_hold")
              : say(voice.DOSE_NON_COMPARABLE_HOLD, "dose_non_comparable_hold");
    else if (!last) why = say(voice.NO_HISTORY_HOLD, "no_history_hold");
    else if (hasRange && topReps != null && topReps >= (repCeiling as number) && !allSetsAtTop) {
      // In a volume phase the ceiling being named sits ABOVE the rep window printed
      // on the plan card — plan_items is deliberately never rewritten for a block, so
      // the card says 6–8 while the line asks for 9. The gap is real and intended;
      // the sentence has to own it rather than leave the two contradicting.
      why =
        policy && policy.rep_saturation > 0
          ? say(voice.ACCUMULATION_TOP_SET_ONLY_HOLD, "accumulation_top_set_only_hold")(repCeiling as number)
          : say(voice.TOP_SET_ONLY_HOLD, "top_set_only_hold")(repCeiling as number);
      fallthroughHold = true;
    } else if (rirLogged && (lastRir as number) <= 1) {
      // The range was finished, but the athlete rated the last set a grind. The
      // not-earned sentence would ask for work they already did; the honest reason
      // for the hold is the effort they reported.
      why = say(voice.GRIND_HOLD, "grind_hold");
      fallthroughHold = true;
    } else {
      why = sayEffort(voice.NOT_EARNED_HOLD, voice.NOT_EARNED_HOLD_REPS, "not_earned_hold");
      fallthroughHold = true;
    }
  }

  // REGROUND does not consume the step (either direction). A plan sitting under the real working
  // weight used to rewrite the card as a catch-up HOLD ("earn a clean extra
  // rep") even when every working set had already capped the range — applying
  // then only moved the target to the logged number and the earned step was
  // spent. When the log is at or past the ceiling, the prescription is the
  // earned overload FROM the logged weight; the proposal writes that one
  // number (catch-up + step). Mid-range stays a plain re-ground hold so the
  // extra rep is still earned at the real load.
  //
  // Promotion still has to EARN the step. A grind, an unfinished/incomparable
  // dose, or a genuine cut (reduce away from the destination, or sliding) must
  // stay a catch-up HOLD at the logged weight. A soft fuel hold does not veto
  // a promotion the log already earned; near the destination, reduce does not
  // either. fast_loss does not veto an earned load step; sliding always does.
  const cutPressure = brakeCtx?.cut?.() ?? NO_CUT_PRESSURE;
  const liftCut = {
    status,
    shortfall: doseEligibility.reason === "under_prescribed",
  };
  const mayPromoteLoad = strong && doseEligibility.eligible && !cutVetoesPromotion(cutPressure, liftCut);
  if (
    (planBehind || planAhead) &&
    baseWeight != null &&
    !loadConstrained &&
    !topSet &&
    !policy?.holds_load &&
    status !== "regressing" &&
    action !== "deload" &&
    action !== "vary" &&
    action !== "introduce"
  ) {
    const atOrPastCeiling = hasRange
      ? allSetsAtTop || (topReps != null && topReps > (repCeiling as number))
      : false;
    if (atOrPastCeiling && (action === "hold" || repStep) && mayPromoteLoad) {
      action = "overload";
      repStep = false;
      if (baseWeight < 0) {
        nextWeight = assistStepNext(baseWeight, group, brakeCtx?.personalModifier, phaseStepScale);
      } else {
        nextWeight = clampedOverload(baseWeight, group, brakeCtx?.personalModifier, phaseStepScale);
      }
    } else if (!atOrPastCeiling && action === "overload" && repStep) {
      action = "hold";
      nextWeight = baseWeight;
      repStep = false;
    }
  }

  // Catch-up framing: when the plan target was BEHIND the real working weight, say so
  // plainly — the step is "from where you actually are", and even a hold re-grounds the
  // plan onto reality (the suggested weight = baseWeight, so applying lands it there).
  if (assistRetired && planBehind && !loadConstrained) {
    // The catch-up here is the assist coming off, not a load to name.
    if (action === "overload" && !repStep && !topSet)
      why = say(voice.ASSIST_RETIRED_OVERLOAD, "assist_retired_overload");
    else if (action === "hold") why = say(voice.ASSIST_RETIRED_HOLD, "assist_retired_hold");
  } else if (planBehind && baseWeight != null) {
    const lbl = baseWeight < 0 ? `${Math.abs(baseWeight)} lb assist` : `${baseWeight} lb`;
    // "The plan said a lighter number" and "the plan said nothing at all" are
    // different facts, and the athlete can tell them apart on the card.
    // …except in peak week, where the sentence IS the protocol — a catch-up line
    // would drop the top set the athlete is meant to work up to.
    if (action === "overload" && !repStep && !topSet)
      why = planUnset
        ? say(voice.PLAN_UNSET_OVERLOAD, "plan_unset_overload")(lbl)
        : say(voice.PLAN_BEHIND_OVERLOAD, "plan_behind_overload")(lbl);
    else if (action === "hold" && !loadConstrained)
      why = planUnset
        ? say(voice.PLAN_UNSET_HOLD, "plan_unset_hold")(lbl)
        : say(voice.PLAN_BEHIND_HOLD, "plan_behind_hold")(lbl);
  } else if (planAhead && baseWeight != null && action === "hold" && !loadConstrained) {
    why = say(voice.PLAN_AHEAD_HOLD, "plan_ahead_hold")(`${baseWeight} lb`);
  }

  // Cut-pressure voice follows the consequence that actually landed.
  // CUT_HOLDING_WIN only speaks when the why is still the not-earned /
  // top-set-only fallthrough — never a plan-behind catch-up or a phase hold.
  // An earned promotion under a soft fuel hold keeps the lift's own overload
  // sentence. Fueling is a property of the DAY and belongs once above the cards —
  // repeating "you already lifted this" on every lift was noise. A parked single
  // is the exception: that is this lift's protocol, and applyFuelProtection names it.
  //
  // A cut running FASTER THAN LEAN-SAFE takes nothing here: the near-maximal single
  // it would want parked is already the one piece applyFuelProtection strips, and
  // the peak protocol itself goes cautious under any cut pressure (see peakTopSetFor).
  if (
    action === "hold" &&
    fallthroughHold &&
    !planBehind &&
    !phaseHolds &&
    // …and ONLY where the cut is what would have held it. `reduce` and `sliding`
    // veto a promotion; fast_loss does not, so on a fast_loss day the hold has its
    // OWN reason and "holding through a cut is the result to want" would be claiming
    // credit the deficit did not earn.
    (cutPressure.reduce || cutPressure.sliding) &&
    baseWeight != null &&
    baseWeight > 0 &&
    !loadConstrained
  ) {
    why = say(voice.CUT_HOLDING_WIN, "cut_holding_win");
  }

  // Repeated comparable movement-dose outcomes are the first recovery brake.
  // They can support an already-earned step, but never manufacture an extra one.
  // Repeated under-prescription moves at most one rung toward safety before the
  // existing acute autoregulation gate runs. A latest linked ineligible dose has
  // already taken that rung, so the history response must not compound it.
  // Whether the final deload was MANUFACTURED by a brake rather than chosen by the
  // progression ladder. The escalation below replaces a chosen deload outright (a
  // second cut is not the lever), but it may never hand back load a brake asked to
  // take off — those are two different claims about the same number.
  let brakedDeload = false;
  // Whether a RED pain band is what took the load off. Kept apart from `brakedDeload`
  // because they answer different questions: one is "did a brake make this deload",
  // the other is "may the repeat-deload ladder count it".
  let painProtected = false;
  const response = recentMovementResponse(name, {
    intent_key: `strength:reps:${repLow ?? "open"}-${repHigh ?? repLow ?? "open"}`,
  });
  // `earned_hold` (two comparable under-prescriptions) is the only movement-
  // response verdict that demotes an earned overload. Older comparable outcomes were
  // measured under the PREVIOUS prescription, so a fresh slot skips this block and
  // the push step below: it is judged from its own first session. `insufficient` never does:
  // before this pass a single comparable met/exceeded already left the ladder's
  // earned step standing, and it still does. Under push, that single met on a
  // full comparable dose is enough for the step — we do not wait for a second
  // comparable verdict to become earned_absorbed.
  if (untested) {
    /* the fresh prescription stands */
  } else if (response.verdict === "earned_hold") {
    if (action === "overload" || (escalated === "rep_range" && rangeMoveEarned)) {
      // An earned range move is an earned step, and is demoted the same one rung.
      if (escalated === "rep_range") {
        escalated = undefined;
        waveRepLow = undefined;
        waveRepHigh = undefined;
      }
      action = "hold";
      nextWeight = baseWeight;
      repStep = false;
      // The peak protocol is a near-maximal effort; a braked week is not the week for it.
      topSet = undefined;
      why = say(voice.MOVEMENT_RESPONSE_HOLD, "movement_response_hold");
    } else if (action === "hold" && last && doseEligibility.eligible) {
      action = "deload";
      brakedDeload = true;
      nextWeight = baseWeight != null && baseWeight > 0 ? round5(baseWeight * (1 - DELOAD_FRAC)) : baseWeight;
      why = say(voice.MOVEMENT_RESPONSE_DELOAD, "movement_response_deload");
    }
    varyTo = undefined;
    varyOptions = undefined;
  } else if (
    drive === "push" &&
    action === "hold" &&
    escalated !== "rep_range" &&
    !loadConstrained &&
    !policy?.holds_load &&
    status !== "regressing" &&
    mayPromoteLoad &&
    doseEligibility.eligible &&
    doseEligibility.reason === "full_comparable" &&
    (response.latest_verdict === "met" || response.latest_verdict === "exceeded") &&
    hasRange &&
    allSetsAtTop
  ) {
    // One full comparable met/exceeded is enough under push: take the step from
    // the logged working weight rather than waiting for a second exposure.
    action = "overload";
    repStep = false;
    if (baseWeight == null) nextWeight = null;
    else if (baseWeight < 0) nextWeight = assistStepNext(baseWeight, group, brakeCtx?.personalModifier, phaseStepScale);
    else nextWeight = clampedOverload(baseWeight, group, brakeCtx?.personalModifier, phaseStepScale);
    why = hasRange
      ? sayEffort(voice.EARNED_RANGE_OVERLOAD, voice.EARNED_RANGE_OVERLOAD_REPS, "earned_range_overload")(
          repHigh as number,
          repLow as number
        )
      : sayEffort(voice.EARNED_OPEN_OVERLOAD, voice.EARNED_OPEN_OVERLOAD_REPS, "earned_open_overload");
  }

  // A LOAD STEP IS TAKEN FROM THE WEIGHT THAT WAS WORKED. When the latest session
  // capped the range at a lighter load than the base (a reduced card, a lighter day),
  // that session proves the lighter load, not the base — stepping past the base off
  // it hands out a number nothing logged has touched. The step is re-taken from the
  // worked load and never lands below the base; when it would not clear the base, the
  // base IS the next target and the lift holds there until a session at it caps.
  const workedTop = workingSets.reduce<number | null>(
    (top, set) => (set.weight != null && (top == null || Number(set.weight) > top) ? Number(set.weight) : top),
    null
  );
  if (
    action === "overload" &&
    !repStep &&
    !topSet &&
    baseWeight != null &&
    baseWeight > 0 &&
    nextWeight != null &&
    nextWeight > baseWeight &&
    workedTop != null &&
    workedTop > 0 &&
    workedTop < baseWeight - 0.1
  ) {
    const fromWorked = clampedOverload(workedTop, group, brakeCtx?.personalModifier, phaseStepScale);
    if (fromWorked <= baseWeight + 0.1) {
      action = "hold";
      nextWeight = baseWeight;
      why = say(voice.LIGHTER_SESSION_HOLD, "lighter_session_hold")(`${baseWeight} lb`);
    } else {
      nextWeight = Math.min(nextWeight, fromWorked);
    }
  }

  // AUTOREGULATION GATE — one step toward safety on high soreness / low performance /
  // a just-smoked group / a named sore joint. Recovery INFORMS, never overrides
  // progressive overload by more than a step. Applied last so it wins over the earned
  // step (an earned overload the morning after a sore knee becomes a hold/deload).
  let autoregulated = false;
  const brake = brakeCtx
    ? autoregBrake(
        rangeMoveEarned && escalated === "rep_range" ? "overload" : action,
        brakeCtx.canonGroup,
        !!last,
        brakeCtx.autoreg,
        brakeCtx.acute,
        name,
        date
      )
    : null;
  if (brake) {
    autoregulated = true;
    action = brake.action;
    why = brake.why;
    repStep = false; // a braked step is a hold/deload, not a rep advance
    topSet = undefined; // …and never a near-maximal top set
    if (brake.action === "hold") nextWeight = baseWeight;
    else nextWeight = baseWeight != null && baseWeight > 0 ? round5(baseWeight * (1 - DELOAD_FRAC)) : baseWeight;
    varyTo = undefined;
    varyOptions = undefined;
  }

  // PAIN TRAFFIC LIGHT — this movement only. Runs after the autoregulation gate for
  // the same reason that gate runs after the earned step: a safety floor is applied
  // last so nothing above it can spend what it took off.
  //
  // A RED band on a movement carrying no external load (bodyweight, or assisted work,
  // where `baseWeight` is null or negative) has NOTHING to take off — the deload
  // arithmetic below is a no-op there, an inherited hole this file's autoregulation
  // twin has too. Rather than print "it comes down a step" over a number that did not
  // move, the red band DEGRADES TO A HOLD on those lifts and says the hold's sentence.
  // The protection is weaker, and it is honest about being weaker; fixing it properly
  // means teaching the ladder to ease assisted and bodyweight work, which is a change
  // to both brakes and out of scope here.
  const painBrake = brakeCtx
    ? painBandBrake(rangeMoveEarned && escalated === "rep_range" ? "overload" : action, brakeCtx.pain, name, date)
    : null;
  if (painBrake) {
    const loadCanEase = baseWeight != null && baseWeight > 0;
    const painAction = painBrake.action === "deload" && !loadCanEase ? "hold" : painBrake.action;
    autoregulated = true; // a brake shaped this, so the escalation ladder stays out of it
    action = painAction;
    // A red band that cannot ease the load still says RED's sentence, not amber's:
    // amber is waiting to hear how it settled, and this one already has its answer.
    why =
      painAction === painBrake.action
        ? painBrake.why
        : voice.liftVoice(voice.PAIN_RED_HOLD, date, "pain_red_hold", name);
    repStep = false;
    topSet = undefined;
    if (painAction === "hold") nextWeight = baseWeight;
    else {
      brakedDeload = true;
      painProtected = true; // a cut PAIN asked for; see `pain_protected` on Prescription
      nextWeight = round5(baseWeight! * (1 - DELOAD_FRAC));
    }
    varyTo = undefined;
    varyOptions = undefined;
  }

  // ESCALATION. A second light deload on the same lift inside a couple of months is
  // the definition of doing the same thing again: the first one already told us that
  // taking a tenth off and rebuilding is not what this lift needs. So the repeat
  // changes SHAPE instead of size — a lower, heavier rep window for a stretch (the
  // load barely moves; the scheme is the new stimulus), or, when there is no window
  // to wave, the movement itself rotates out.
  //
  // Runs LAST, off the FINAL action, and that ordering is the point. It used to run
  // before the brakes, so a deload the movement-response brake created afterwards
  // was never considered for escalation — while still carrying the deload marker
  // into the audit trail, which is what makes the NEXT one a "repeat". The two reads
  // disagreed about the same cut. Running here, the marker and the escalation are
  // derived from the same final decision, and a wave can no longer be left stranded
  // in `suggested` after a brake recomputed the weight underneath it.
  //
  // The ACUTE safety brake suppresses it outright. Its deload is a recovery response
  // to a sore joint or a smoked muscle, not evidence that a load cut is the wrong
  // lever for this lift — and restructuring a block, or rotating a movement, is not
  // what a sore knee is asking for. Its own sentence is the honest one.
  // A rep-range move is a HOLD at the load. A brake that reshaped it (a movement-
  // response deload, the autoregulation or pain gate) owns the card, and the range
  // stays where the plan has it.
  if (escalated === "rep_range" && (action !== "hold" || autoregulated)) {
    escalated = undefined;
    waveRepLow = undefined;
    waveRepHigh = undefined;
  }

  if (action === "deload" && !loadConstrained && !autoregulated && deloadedRecently(name, date)) {
    if (waveRunning(name, date)) {
      // A wave is already in flight. Stacking a second one changes the shape again
      // before the first change has had a chance to show anything — so the lift
      // holds and runs the wave out. The plan already carries the wave's own rep
      // window, so nothing needs to be re-prescribed here.
      action = "hold";
      nextWeight = baseWeight;
      why = say(voice.ESCALATE_WAVE_SETTLE, "escalate_wave_settle");
    } else if (hasRange && baseWeight != null && baseWeight > 0) {
      waveRepLow = Math.max(WAVE_REP_FLOOR, (repLow as number) - 2);
      waveRepHigh = Math.max(waveRepLow + 1, (repHigh as number) - 3);
      // The wave eases load only slightly — the scheme is the new stimulus, and it
      // REPLACES the second cut the ladder would otherwise have taken. But when a
      // brake is what produced this deload, its cut stands: the shape changes, and
      // load a brake asked to take off never travels back up.
      const waved = round5(baseWeight * (1 - DELOAD_WAVE_FRAC));
      nextWeight = brakedDeload && nextWeight != null && nextWeight > 0 ? Math.min(waved, nextWeight) : waved;
      escalated = "rep_wave";
      why = say(voice.ESCALATE_REP_WAVE, "escalate_rep_wave")(waveRepLow, waveRepHigh);
    } else if (varyCandidates.length > 0 && !freshPrescription && !untested && status !== "progressing") {
      // A lift the trend reads as progressing is never rotated out, whatever brake
      // produced the repeat deload — the deload stands on its own instead.
      action = "vary";
      nextWeight = baseWeight;
      varyOptions = varyCandidates;
      varyTo = varyOptions[0]?.name;
      escalated = "variation";
      why = say(voice.ESCALATE_VARIATION, "escalate_variation")(varyTo ?? "a close variation");
    }
  }

  // Assisted load (negative weight) never crosses sign in one step —
  // bodyweight (null) is the furthest it may travel, matching assistStepNext.
  // The name is not a sign: a purely positive history on an "Assisted …" lift
  // is weighted work and may step up like any other loaded movement.
  if (baseWeight != null && baseWeight < 0 && nextWeight != null && nextWeight > 0) nextWeight = null;

  // A peak week is TWO-TIER work and PrescriptionTarget only describes one tier, so
  // `suggested` carries the BULK of the session — the back-off block — and `top_set`
  // carries the heavy single the athlete works up to first (the delta text and the
  // why both lead with it). That split matters beyond presentation: the daily
  // composition authorizes today's session from `suggested`, and a consumer that
  // knows nothing about peak weeks must land on a real, lighter session rather than
  // on one near-maximal single with the rest of the work missing.
  //
  // A rep wave carries its new, lower window instead; a rep-range move its higher one.
  const suggested: PrescriptionTarget = topSet
    ? {
        sets: topSet.backoff?.sets ?? sets,
        rep_low: repLow ?? undefined,
        rep_high: repHigh ?? undefined,
        weight: topSet.backoff?.weight ?? nextWeight,
      }
    : {
        sets,
        rep_low: waveRepLow ?? repLow ?? undefined,
        rep_high: waveRepHigh ?? repHigh ?? undefined,
        weight: nextWeight,
      };
  // A rep advance holds the load and climbs the range — the honest delta is "+1 rep",
  // not "hold X lb" (loadedDeltaText would read it as a no-op load move). A peak-week
  // top set says what the set IS; it is not a step from anywhere.
  const delta_text = topSet
    ? `top set ${topSet.weight} × ${topSet.reps}`
    : repStep
      ? "+1 rep"
      : escalated === "rep_range" && waveRepLow != null && waveRepHigh != null
        ? `hold, ${waveRepLow}–${waveRepHigh} reps`
      : // A retired assist moves the card off the plan's assist number, whatever the
        // day then does with it — the delta says so rather than "hold bodyweight".
        loadedDeltaText(assistRetired && planBehind ? planWeight : baseWeight, nextWeight);
  // The displayed "current" reflects REALITY when the plan was behind, so the card
  // reads "50 → 52.5", never "27 → …" off a number the athlete left behind weeks ago.
  const displayCurrent: PrescriptionTarget | null = cur
    ? planBehind || planAhead
      ? { ...cur, weight: baseWeight }
      : cur
    : baseWeight != null
      ? { sets, rep_low: repLow ?? undefined, rep_high: repHigh ?? undefined, weight: baseWeight }
      : null;

  return {
    exercise: ex_name(name),
    mode: "reps",
    action,
    suggested,
    current: displayCurrent,
    delta_text,
    why,
    reground: planBehind || planAhead || undefined,
    // Only claim the starting idea while the suggestion IS still that number — a
    // brake that resets the load back to the plan has taken the idea away with it.
    starting_idea: (startingIdea && nextWeight != null) || undefined,
    vary_to: varyTo,
    vary_options: varyOptions,
    autoregulated: autoregulated || undefined,
    pain_protected: painProtected || undefined,
    movement_response: response.verdict,
    rep_step: repStep || undefined,
    block_phase: brakeCtx?.block?.phase,
    top_set: topSet,
    escalated,
    dose_eligibility: doseEligibility,
    ...(untested ? { untested: true as const } : {}),
  };
}

// The latest session's timed sets for a lift — load and time per set, so a loaded
// carry/hold can ask "did EVERY set own the time at this load". Empty when nothing's logged.
function latestTimedSets(name: string, sessionId: number | undefined): { weight: number | null; seconds: number }[] {
  if (sessionId == null) return [];
  const ids = progressionLineageIds(name);
  if (!ids.length) return [];
  const inIds = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT weight, duration_sec FROM logged_sets
        WHERE exercise_id IN (${inIds}) AND session_id = ? AND duration_sec IS NOT NULL AND duration_sec > 0`
    )
    .all(...ids, sessionId) as any[];
  return rows.map((r) => ({ weight: r.weight == null ? null : Number(r.weight), seconds: Number(r.duration_sec) }));
}

// A timed lift's working load: the plan's; else — only when EVERY set of the last
// session carried one — the heaviest (signed: less assist is harder) of them. One
// incidental loaded set never turns an unloaded hold into loaded work. null = unloaded.
function timedWorkingLoad(
  plan: ReturnType<typeof planItemFor>,
  lastSets: { weight: number | null }[]
): { load: number | null; planned: boolean } {
  if (plan?.weight != null && plan.weight !== 0) return { load: plan.weight, planned: true };
  if (!lastSets.length) return { load: null, planned: false };
  let best: number | null = null;
  for (const s of lastSets) {
    if (s.weight == null || s.weight === 0 || !Number.isFinite(s.weight)) return { load: null, planned: false };
    if (best == null || s.weight > best) best = s.weight;
  }
  return { load: best, planned: false };
}

function timedPrescription(
  name: string,
  group: string | null,
  loadConstrained: boolean,
  plan: ReturnType<typeof planItemFor>,
  cur: PrescriptionTarget | null,
  last: ReturnType<typeof latestTopSet>,
  state: LiftState | null,
  brakeCtx?: PrescCtx
): Prescription {
  const date = brakeCtx?.date ?? localDateISO();
  const say = <T>(set: readonly T[], code: string): T => voice.liftVoice(set, date, code, name);
  const baseSeconds: number | null =
    plan?.seconds != null ? plan.seconds : last?.duration_sec != null ? Math.round(Number(last.duration_sec)) : null;
  const sets = plan?.sets || 1;

  let action: ProgressionAction;
  let why: string;
  let nextSeconds: number | null = baseSeconds;

  const status = state?.status ?? "new";
  const doseEligibility = linkedDoseEligibility(last?.session_id, name);
  const lastSets = last ? latestTimedSets(name, last.session_id) : [];
  const { load, planned: loadPlanned } = timedWorkingLoad(plan, lastSets);
  let nextLoad: number | null = load;
  let loadStepped = false;
  // A loaded carry/hold reads ONLY the sets at (or heavier than) its load — a lighter
  // set says nothing about this load — and only a session on or after the current
  // prescription, so a step just applied is not re-stepped off the work before it.
  const working = load != null ? lastSets.filter((s) => s.weight != null && s.weight >= load) : [];
  const evidencePredates = load != null && slotAuthorship(plan?.prescribed_at ?? null, lastExposureOf(name, last)).untested;
  // Solid = the latest hold comfortably met (or beat) the current target.
  const target = baseSeconds ?? 0;
  const held =
    load != null
      ? working.length
        ? Math.round(Math.max(...working.map((s) => s.seconds)))
        : null
      : last?.duration_sec != null
        ? Math.round(Number(last.duration_sec))
        : null;
  const solid = held != null && target > 0 && held >= target;

  if (loadConstrained) {
    action = "hold";
    nextSeconds = baseSeconds;
    why = say(voice.TIMED_CONSTRAINED_HOLD, "timed_constrained_hold");
  } else if (status === "regressing") {
    action = "deload";
    nextSeconds = baseSeconds != null ? Math.max(10, Math.round(baseSeconds * (1 - DELOAD_FRAC))) : baseSeconds;
    why = say(voice.TIMED_REGRESSING_DELOAD, "timed_regressing_deload");
  } else if (!last && plan) {
    action = "hold";
    nextSeconds = baseSeconds;
    why = say(voice.TIMED_NO_HISTORY_PLANNED_HOLD, "timed_no_history_planned_hold");
  } else if (load != null && (!working.length || evidencePredates)) {
    action = "hold";
    nextSeconds = baseSeconds ?? held;
    why = say(voice.TIMED_LOAD_NEW_HOLD, "timed_load_new_hold");
  } else if ((load != null ? solid : solid || status === "progressing") && doseEligibility.eligible) {
    action = "overload";
    const base = baseSeconds ?? held ?? 0;
    const step = timedStep(base, brakeCtx?.personalModifier);
    nextSeconds = base + step;
    why = say(voice.TIMED_OVERLOAD, "timed_overload")(step, base);
    if (load != null) {
      // Loaded carry/hold: seconds up to the ceiling, then one load step — never both.
      const ceiling = Math.max(LOADED_HOLD_CEILING_SEC, base);
      const working = lastSets.filter((s) => s.weight != null && s.weight >= load);
      const everySetOwned = base > 0 && working.length >= sets && working.every((s) => s.seconds >= base);
      if (base < ceiling) {
        const capped = Math.min(step, ceiling - base);
        nextSeconds = base + capped;
        why = say(voice.TIMED_OVERLOAD, "timed_overload")(capped, base);
      } else if (everySetOwned && !loadPlanned) {
        // The load is only the log's, never the plan's: the time is owned, but the
        // plan carries no load to step, so the next weight stays the athlete's call.
        action = "hold";
        nextSeconds = base;
        why = say(voice.TIMED_UNPLANNED_LOAD_HOLD, "timed_unplanned_load_hold");
      } else if (everySetOwned) {
        nextLoad =
          load > 0
            ? clampedOverload(load, group, brakeCtx?.personalModifier)
            : assistStepNext(load, group, brakeCtx?.personalModifier, 1);
        nextSeconds = Math.max(10, Math.round(ceiling * LOADED_HOLD_RESET_FRAC));
        loadStepped = true;
        why = say(voice.TIMED_LOAD_STEP, "timed_load_step")(
          nextLoad == null ? "bodyweight" : nextLoad < 0 ? `${Math.abs(nextLoad)} lb assist` : `${nextLoad} lb`,
          nextSeconds
        );
      } else {
        action = "hold";
        nextSeconds = base;
        why = say(voice.TIMED_LOAD_CEILING_HOLD, "timed_load_ceiling_hold");
      }
    }
  } else {
    action = "hold";
    nextSeconds = baseSeconds ?? held;
    why =
      last && !doseEligibility.eligible
        ? doseEligibility.reason === "unfinished"
          ? say(voice.TIMED_DOSE_UNFINISHED_HOLD, "timed_dose_unfinished_hold")
          : doseEligibility.reason === "partial"
            ? say(voice.TIMED_DOSE_PARTIAL_HOLD, "timed_dose_partial_hold")
            : doseEligibility.reason === "under_prescribed"
              ? say(voice.TIMED_DOSE_UNDER_HOLD, "timed_dose_under_hold")
              : say(voice.TIMED_DOSE_NON_COMPARABLE_HOLD, "timed_dose_non_comparable_hold")
        : say(voice.TIMED_DEFAULT_HOLD, "timed_default_hold");
  }

  const response = recentMovementResponse(name, { intent_key: "strength:timed" });
  if (response.verdict === "earned_hold") {
    if (action === "overload") {
      action = "hold";
      nextSeconds = baseSeconds;
      nextLoad = load;
      loadStepped = false;
      why = say(voice.TIMED_RESPONSE_HOLD, "timed_response_hold");
    } else if (action === "hold" && last && doseEligibility.eligible) {
      action = "deload";
      nextSeconds = baseSeconds != null ? Math.max(10, Math.round(baseSeconds * (1 - DELOAD_FRAC))) : baseSeconds;
      why = say(voice.TIMED_RESPONSE_DELOAD, "timed_response_deload");
    }
  }

  // AUTOREGULATION GATE (timed): a sore joint this hold loads, high soreness, or a
  // just-smoked group holds/eases the duration rather than extending. Timed work
  // eases in SECONDS (a loaded carry keeps its load). Applied last so it wins over
  // the earned extension.
  let autoregulated = false;
  const brake = brakeCtx
    ? autoregBrake(action, brakeCtx.canonGroup, !!last, brakeCtx.autoreg, brakeCtx.acute, name, date)
    : null;
  if (brake) {
    autoregulated = true;
    action = brake.action;
    why = brake.why;
    nextLoad = load;
    loadStepped = false;
    if (brake.action === "hold") nextSeconds = baseSeconds;
    else nextSeconds = baseSeconds != null ? Math.max(10, Math.round(baseSeconds * (1 - DELOAD_FRAC))) : baseSeconds;
  }

  // PAIN TRAFFIC LIGHT (timed): the same per-movement bands, eased in SECONDS —
  // a red band shortens the hold (a loaded carry keeps its load). With no
  // duration on record there is nothing to shorten, so red degrades to the hold's
  // sentence rather than claiming a cut that did not happen (the reps path does the
  // same for bodyweight and assisted work).
  const painBrake = brakeCtx ? painBandBrake(action, brakeCtx.pain, name, date) : null;
  let painProtected = false;
  if (painBrake) {
    const canEase = baseSeconds != null && baseSeconds > 10;
    const painAction = painBrake.action === "deload" && !canEase ? "hold" : painBrake.action;
    autoregulated = true;
    nextLoad = load;
    loadStepped = false;
    action = painAction;
    why =
      painAction === painBrake.action
        ? painBrake.why
        : voice.liftVoice(voice.PAIN_RED_HOLD, date, "pain_red_hold", name);
    if (painAction === "hold") nextSeconds = baseSeconds;
    else {
      painProtected = true;
      nextSeconds = Math.max(10, Math.round(baseSeconds! * (1 - DELOAD_FRAC)));
    }
  }

  const suggested: PrescriptionTarget = {
    sets,
    seconds: nextSeconds ?? undefined,
    ...(load != null ? { weight: nextLoad } : {}),
  };
  const delta_text = loadStepped
    ? `${loadedDeltaText(load, nextLoad)}, ${nextSeconds}s`
    : secondsDeltaText(baseSeconds, nextSeconds);

  return {
    exercise: ex_name(name),
    mode: "timed",
    autoregulated: autoregulated || undefined,
    pain_protected: painProtected || undefined,
    movement_response: response.verdict,
    action,
    suggested,
    current: cur,
    delta_text,
    why,
    dose_eligibility: doseEligibility,
  };
}

function secondsDeltaText(current: number | null, next: number | null): string {
  if (next == null) return "hold";
  if (current == null) return `${next}s`;
  const d = next - current;
  if (d === 0) return `hold ${current}s`;
  return d > 0 ? `+${d}s` : `−${Math.abs(d)}s`;
}

// Preserve the exercise's stored display name (case) when we have it.
// The stored display spelling for a lift. Alias-aware, so a prescription built from
// the athlete's shorthand still names the catalog's row.
function ex_name(name: string): string {
  return resolveExerciseName(name).exercise_id != null ? resolveExerciseName(name).canonical : name;
}

// ---- a whole plan day's progression -----------------------------------------
// nextPrescription for every STRENGTH item on a plan day (cardio skipped — the
// runner loop owns those). Powers Today's session card + the apply path. Each
// row carries its plan_item_id so a "apply these" build can route through
// propose→apply by day_number.
export function planDayProgression(
  dayNumber: number,
  // `fuelRead` overrides ONLY the fuel/protection read for this pass — the seam that
  // lets a fixture state "a `reduce` reached this day" without staging the whole
  // channel agreement behind it. Omit it and the read is the live one, exactly as before.
  opts: { forNextSession?: boolean; fuelRead?: UnderfuelingRead } = {}
): Prescription[] {
  const day = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(dayNumber) as any;
  if (!day) return [];
  const items = db
    .prepare(
      `SELECT pi.id AS plan_item_id, pi.kind AS kind, e.name AS name
       FROM plan_items pi LEFT JOIN exercises e ON e.id = pi.exercise_id
      WHERE pi.plan_day_id = ? ORDER BY pi.position`
    )
    .all(day.id) as any[];
  const states = buildLiftStateMap(); // compute the program-state ONCE for the day
  // Autoregulation + acute-load read computed ONCE for the whole day and threaded in,
  // so the one-tap apply proposal built from these is gated too (no overload the
  // morning after soreness / a named sore joint). Equipment + the day's own movements
  // are threaded in too so a variety suggestion ranks by what the athlete can load and
  // never re-suggests an exercise/slot already anywhere in the week.
  // At the finish boundary this proposal is for the NEXT exposure, not another
  // set today. Do not let the just-completed session masquerade as poor readiness;
  // constraints still apply here, and readiness is re-checked when that day starts.
  const autoreg = opts.forNextSession ? null : recentAutoregulation();
  const acute = opts.forNextSession ? null : acuteGates();
  const equip = availableEquipment();
  const plannedMovements = getPlan().flatMap((planDay: any) =>
    (Array.isArray(planDay?.items) ? planDay.items : [])
      .filter((item: any) => item.kind !== "cardio" && item.exercise)
      .map((item: any) => String(item.exercise))
  );
  const personalResponse = whatWorksForYou();
  const preferences = learnedPreferences();
  const today = localDateISO();
  const fuelProtection = opts.fuelRead ?? currentUnderfuelingRead(today);
  // The periodization phase and the fuel/cut read are properties of the DAY, not of
  // a lift — read once and threaded in, so a day's pass never walks the program state
  // once per movement.
  const block = activeBlockContext(today);
  const cut = cutPressureThunk(today);
  const atNearGoal = atOrNearGoal(today);
  // The calibration read is per-LIFT, not per-day, so the shared reader is a memo
  // rather than a single value — a movement appearing twice in a pass walks its
  // 400-day history once, and a movement no branch asks about never walks it.
  const estimate = estimateReader(today);
  // The athlete's standing declaration is a property of the day too — read once.
  const drive = readTrainingDrive();
  // Items whose volume is still owed back after a cut: the restore ledger owns their
  // climb, so the set-count catch-up stays off them (read once for the day).
  const owedRestoreKeys = (() => {
    try {
      return new Set(openVolumeRestoreTargets().map((t) => `${t.day_number}|${normalizeExerciseName(t.exercise)}`));
    } catch {
      return new Set<string>();
    }
  })();
  // The light-week read (recovery week, deload now or next, deload-due, race taper) is
  // the plan floor's own exemption. Costly, so lazy and at most once per pass.
  let lightWeekMemo: { value: string | null } | null = null;
  const lightWeek = (): string | null => {
    if (!lightWeekMemo) {
      let value: string | null = null;
      try {
        value = lightWeekExemption(today);
      } catch {
        value = null;
      }
      lightWeekMemo = { value };
    }
    return lightWeekMemo.value;
  };
  // When every slot was prescribed — ONE read for the pass (prescription-authorship.ts).
  const slotStamps = planSlotStamps();
  const out: Prescription[] = [];
  for (const it of items) {
    if (it.kind === "cardio" || !it.name) continue; // skip cardio + label-only rows
    const excludeNames = plannedMovements.filter((n) => n.toLowerCase() !== String(it.name).toLowerCase());
    const personalModifier = trainingModifierFor(String(it.name), personalResponse);
    const p = nextPrescription(it.name, states, {
      autoreg,
      acute,
      availableEquipment: equip,
      excludeNames,
      personalModifier,
      preferences,
      date: today,
      block,
      cut,
      estimate,
      drive,
      slotStamps,
    });
    if (p) {
      const protectedPrescription = applyFuelProtection(p, fuelProtection, today, drive, atNearGoal);
      const stepped = setCatchUp(protectedPrescription, p, {
        date: today,
        dayNumber,
        block,
        cut,
        liftState: liftStateFor(String(it.name), states),
        restoreKeys: owedRestoreKeys,
        since: slotAuthorship(slotStamps.get(Number(it.plan_item_id)) ?? null, null, today),
        lightWeek,
      });
      out.push({ ...stepped, plan_item_id: it.plan_item_id, day_number: dayNumber });
    }
  }
  return out;
}

// ---- the log is truth for set count ------------------------------------------
// An agent-authored week can prescribe one or two working sets on a lift the athlete
// has been doing three sets of every time. The load ladder never reads set COUNT, so
// the log kept saying "the prescription is short" and nothing listened. This is the
// bounded answer: when the last SET_STEP_EXPOSURES exposures of a lift EACH carried
// more good working sets than the plan prescribes, the plan item takes ONE set toward
// them — never past what the athlete actually did, never past SET_STEP_CAP.
//
// "Good working sets" means working volume AT the prescribed dose: within 90% of the
// session's top working load (warm-up ramps and back-offs never count), at or above
// the plan's target load when one exists, and at the plan's rep floor within a small
// slack (SET_STEP_REP_SLACK reps, or a fifth of the floor on a high-rep prescription,
// whichever is larger) — so a log whose extra set is a lighter back-off or a failed,
// short one never raises the plan. Only exposures on or after the slot was prescribed
// count (prescription-authorship.ts: a redraw's or a person's set count re-stamps the
// slot, a brain's small set step does not), so neither a redraw's deliberate cut nor
// the athlete's own is undone by older logs; and it rides only a hold or a rep step,
// never a load step.
//
// It is a catch-up to work ALREADY being done, not new stress, so the cut reads that
// veto a LOAD step do not all veto it. `hold`, `fast_loss` and even a `sliding` cut
// verdict leave it alone: those veto added load because a new stimulus on a body
// losing ground is the risk, and here nothing new is asked — writing a smaller
// number than the athlete does protects nothing, it only makes the plan disagree
// with the log. What DOES block it is the fuel read asking outright for a lighter
// dose (`reduce` away from the destination — the plan must not grow toward the log
// then), and THIS lift regressing or coming in short. It never fires in a light week
// (the plan floor's own exemption: recovery week, deload now or next, deload-due, race
// taper), on a braked/pain-protected/fuel-reduced prescription, or
// on an item whose cut volume the restore ledger still owes (that ledger owns the
// climb). It rides the ordinary proposal → autonomy path like any target step.
const SET_STEP_EXPOSURES = 2;
const SET_STEP_CAP = 4; // working sets, compound and isolation alike
const SET_STEP_REP_SLACK = 2;

// Within this fraction of the session's top working load, a set is working, not a
// ramp or a back-off.
const SET_STEP_WORKING_FRAC = 0.9;

// The good working-set count of each of a lift's most recent exposures (on or after
// `since`), newest first. A set is GOOD when it is real working volume at the
// prescribed dose: within SET_STEP_WORKING_FRAC of that session's top working load
// (so a warm-up ramp and a back-off never count), at or above the plan's target
// load when one exists, and within a small slack of the rep floor. Loads are compared
// SIGNED — an assist is negative, so less assist is the harder set. A session with no
// load at all is bodyweight work, read on reps alone.
function recentGoodWorkingSetCounts(
  name: string,
  opts: { repFloor: number | null; targetWeight: number | null; since: Pick<SlotAuthorship, "since" | "since_at"> },
  limit = SET_STEP_EXPOSURES
): number[] {
  const ids = progressionLineageIds(name);
  if (!ids.length) return [];
  const inIds = ids.map(() => "?").join(",");
  const since = sinceClause(opts.since);
  const sessions = db
    .prepare(
      `SELECT s.id AS id FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE ls.exercise_id IN (${inIds}) AND ls.reps IS NOT NULL AND ls.reps > 0 AND ${since.sql}
        GROUP BY s.id ORDER BY MAX(s.date) DESC, s.id DESC LIMIT ?`
    )
    .all(...ids, ...since.args, limit) as Array<{ id: number }>;
  const repFloor = opts.repFloor;
  const slack = repFloor != null ? Math.max(SET_STEP_REP_SLACK, Math.round(repFloor * 0.2)) : 0;
  const minReps = repFloor != null && repFloor > 0 ? Math.max(1, repFloor - slack) : 1;
  const target = opts.targetWeight != null && Number.isFinite(Number(opts.targetWeight)) ? Number(opts.targetWeight) : null;
  return sessions.map((session) => {
    const rows = db
      .prepare(
        `SELECT ls.weight AS weight, ls.reps AS reps FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
          WHERE ls.exercise_id IN (${inIds}) AND ls.session_id = ? AND ls.reps IS NOT NULL AND ls.reps > 0
            AND ${since.sql}`
      )
      .all(...ids, session.id, ...since.args) as Array<{ weight: number | null; reps: number }>;
    const loads = rows.map((r) => (r.weight == null ? null : Number(r.weight)));
    const bodyweightOnly = loads.every((w) => w == null || w === 0);
    // Bodyweight is the zero of the signed scale: harder than any assist, easier than
    // any added load (the same reading latestWorkingSets uses).
    const signed = (w: number | null): number => (w == null ? 0 : w);
    const top = Math.max(...loads.map(signed));
    // The lowest load still inside the working band: 90% of a load, or 10% more assist.
    const band = top > 0 ? top * SET_STEP_WORKING_FRAC : top < 0 ? top * (2 - SET_STEP_WORKING_FRAC) : 0;
    return rows.filter((r, i) => {
      if (Number(r.reps) < minReps) return false;
      if (bodyweightOnly && target == null) return true;
      const w = signed(loads[i]);
      if (w < band - 1e-9) return false; // a warm-up ramp or a back-off
      if (target != null && w < target - 1e-9) return false; // under the prescribed load
      return true;
    }).length;
  });
}

function setCatchUp(
  p: Prescription,
  pre: Prescription,
  ctx: {
    date: string;
    dayNumber: number;
    block: ActiveBlockContext | null;
    cut: () => CutPressure;
    liftState: LiftState | null;
    restoreKeys: Set<string>;
    // Where evidence about THIS prescription starts (slotAuthorship.since): a redraw's
    // or a person's set count re-stamps the slot, so older logs cannot walk it back.
    since: Pick<SlotAuthorship, "since" | "since_at">;
    lightWeek: () => string | null;
  }
): Prescription {
  if (p.mode !== "reps" || !p.current) return p;
  // A carry or hold kept in reps mode is time typed as reps; its count waits with it.
  if (holdLikeMovement(p.exercise, null)) return p;
  const planned = Number(p.current.sets) || 0;
  if (planned < 1 || planned >= SET_STEP_CAP) return p;
  // ONE change at a time: the set count rides only a HOLD or a double-progression REP
  // step — never a load step, a re-ground, a deload, a rotation, a peak-week protocol,
  // a starting idea, or any recovery brake. A step in load plus a step in volume on
  // the same exposure is two stimuli, and the log vouched for neither together.
  const holdOrRepStep = (x: Prescription) => x.action === "hold" || (x.action === "overload" && x.rep_step === true);
  if (!holdOrRepStep(pre) || !holdOrRepStep(p)) return p;
  if (p.reground || pre.reground) return p;
  // A rep-range move is already this exposure's one change.
  if (p.escalated === "rep_range" || pre.escalated === "rep_range") return p;
  const planWeight = p.current.weight ?? null;
  if ((p.suggested?.weight ?? null) !== planWeight) return p;
  if (pre.autoregulated || pre.pain_protected || p.fuel_protected || p.pain_protected) return p;
  if (p.top_set || p.starting_idea || p.suggested?.sets !== planned) return p;
  if (ctx.block?.phase === "deload") return p;
  if (ctx.restoreKeys.has(`${ctx.dayNumber}|${normalizeExerciseName(p.exercise)}`)) return p;
  let counts: number[];
  try {
    counts = recentGoodWorkingSetCounts(p.exercise, {
      repFloor: p.current.rep_low ?? null,
      targetWeight: planWeight,
      since: ctx.since,
    });
  } catch {
    return p;
  }
  if (counts.length < SET_STEP_EXPOSURES || !counts.every((n) => n > planned)) return p;
  // A lift slipping, or an exposure the session never finished / came in short on
  // set count, is not the log vouching for more sets. (A missed load or rep
  // CHALLENGE — `under_prescribed` — says nothing about set count; the per-set rep
  // floor and load band above are the quality test for that.)
  if (ctx.liftState?.status === "regressing") return p;
  if (p.dose_eligibility?.reason === "unfinished" || p.dose_eligibility?.reason === "partial") return p;
  const cut = ctx.cut();
  if (cut.reduce && !cut.near_goal) return p;
  // A deliberately light week — a recovery week in force or scheduled, a deload now or
  // next, a deload-due mesocycle, the race taper — is the same exemption the plan's
  // volume floor reads (volume-floor-context.ts), read last because it is the costly one.
  if (ctx.lightWeek()) return p;
  const to = Math.min(planned + 1, SET_STEP_CAP, ...counts);
  if (to <= planned) return p;
  const say = voice.liftVoice(voice.SET_CATCH_UP, ctx.date, "set_catch_up", p.exercise)(to, Math.min(...counts));
  return {
    ...p,
    suggested: { ...p.suggested, sets: to },
    set_step: { from: planned, to },
    why: p.why ? `${p.why} ${say}` : say,
  };
}

// The fuel read's TRAINING consequence, said in the TRAINING register.
//
// This used to concatenate `read.action.line` — a nutrition-domain sentence built
// for the nutrition surfaces — straight into a lift card's `why`, which is how "A
// recent fuel correction is still inside its seven-day settling window, so no
// second calorie move is made." ended up printed under a bench press. The
// consequence (hold this step / take a lighter dose) belongs on the lift; the
// calorie mechanics behind it belong to the surfaces that already carry them.
// The stored muscle group of a lift by name (through the one resolver), or null.
function storedGroupOf(name: string): string | null {
  const resolved = resolveExerciseName(name);
  if (resolved.exercise_id == null) return null;
  return (getExercise(resolved.exercise_id) as any)?.muscle_group ?? null;
}

function applyFuelProtection(
  prescription: Prescription,
  read: UnderfuelingRead,
  date: string,
  drive: TrainingDrive = "steady",
  atNearGoal = false
): Prescription {
  const say = <T>(set: readonly T[], code: string): T => voice.liftVoice(set, date, code, prescription.exercise);
  if (read.action.training === "proceed") return prescription;
  // Prep is not loaded work. A fuel read must not invent a load story for it.
  if (isPrepMovement(prescription.exercise)) return prescription;
  if (read.action.training === "hold_aggression") {
    // The fuel read is a property of the DAY. It gets to speak on a lift card only
    // where it actually changed THAT lift — a lift already holding for its own
    // reason is not held by fueling, and gluing the day's clause onto it was how a
    // per-lift sentence ended up carrying somebody else's explanation.
    // A rep-range move is a step too (the range climbs), so a soft fuel hold holds it.
    const rangeMove = prescription.escalated === "rep_range";
    if (!["overload", "vary", "introduce"].includes(prescription.action) && !rangeMove) return prescription;
    // A soft fueling signal no longer erases a step the work earned when the
    // athlete has asked to be pushed. The near-maximal top set still comes off:
    // that is the genuinely costly piece of an underfed day, and the athlete's
    // declaration is about training hard, not about testing a single. The same
    // carve-out keeps a vary/introduce rotation — those are the stimulus, not
    // the costly single.
    if (drive === "push" && (prescription.action === "overload" || rangeMove)) {
      return prescription.top_set
        ? {
            ...prescription,
            top_set: undefined,
            // The day's read changed THIS lift, so the surfaces that ask "did
            // something brake this?" have to see it — the decision ledger's
            // evidence and the session primer both read this flag. NOT
            // `fuel_protected`: that one marks a dose the fuel read REDUCED, and
            // the restore ledger turns it into volume owed back. The step stands
            // and no sets came off here, so there is no debt to record.
            autoregulated: true,
            why: say(voice.LOG_EARNED_FUEL_PARK_SINGLE, "log_earned_fuel_park_single"),
          }
        : prescription; // the step stands; the lift's own overload why already says so
    }
    if (drive === "push" && (prescription.action === "vary" || prescription.action === "introduce")) {
      return {
        ...prescription,
        top_set: undefined,
        autoregulated: true,
        why: `${prescription.why} ${say(voice.PUSH_FUEL_VARIETY_KEEP, "push_fuel_variety_keep")}`,
      };
    }
    const current = prescription.current ?? prescription.suggested;
    return {
      ...prescription,
      action: "hold",
      suggested: { ...current },
      delta_text: prescription.mode === "timed"
        ? current.seconds == null ? "hold" : `hold ${current.seconds}s`
        : current.weight == null ? "hold" : `hold ${current.weight}`,
      vary_to: undefined,
      vary_options: undefined,
      rep_step: undefined,
      // …and a range move comes off with it: the card is the plan's own range again.
      escalated: rangeMove ? undefined : prescription.escalated,
      // A near-maximal top set is exactly the kind of aggression this read is asking
      // to hold, so the peak protocol comes off with the step.
      top_set: undefined,
      // The suggestion is the plan's own number again, so it is no longer the
      // related-lift idea this prescription came in carrying.
      starting_idea: undefined,
      autoregulated: true,
      why: say(voice.FUEL_HOLD_STEP, "fuel_hold_step"),
    };
  }
  // training === "reduce" (persistent_strain) from here. fast_loss never reaches
  // this branch — it is not a fuel `reduce`.
  //
  // AT OR NEAR THE DESTINATION, a fuel `reduce` STOPS SHRINKING THE PLAN. The cut
  // is essentially finished, and the honest answer to "training is running ahead of
  // the food" there is more food, not a smaller session (the underfueling read itself
  // now refuses to say `reduce` at/near goal — see underfueling.ts — so this branch
  // is the belt to that braces). Full prescribed sets AND the load stand, for an
  // earned step and for a hold alike; the one thing this read may still take is the
  // near-maximal top set / heavy single, the genuinely costly piece of an underfed day.
  //
  // Away from goal the reduction stands, EXCEPT that a `push` athlete keeps the full
  // set count on a step their log earned — the same bounded mechanical authority the
  // declaration already carries under `hold_aggression`. Neither carve-out touches a
  // safety floor: a pain-braked prescription falls through to the reduction below, and
  // illness/symptom floors never reach this function at all.
  const rangeStep = prescription.escalated === "rep_range";
  const earnedStep = ["overload", "vary", "introduce"].includes(prescription.action) || rangeStep;
  const keepsFullVolume = !prescription.pain_protected && (atNearGoal || (drive === "push" && earnedStep));
  if (keepsFullVolume && (earnedStep || prescription.action === "hold")) {
    const parkedSingle = Boolean(prescription.top_set);
    return {
      ...prescription,
      // Deliberately NOT `fuel_protected`: that flag marks a dose the fuel read
      // REDUCED, and the restore ledger turns it into volume owed back. Nothing came
      // off the set count here, so there is no debt to record.
      top_set: undefined,
      autoregulated: true,
      why:
        prescription.action === "overload" || rangeStep
          ? parkedSingle
            ? say(voice.LOG_EARNED_FUEL_PARK_SINGLE, "log_earned_fuel_park_single")
            : prescription.why
          : prescription.action === "hold"
            ? say(voice.AT_GOAL_FUEL_KEEP_VOLUME, "at_goal_fuel_keep_volume")
            : // vary / introduce. WHY the rotation stands has to match why it was
              // actually kept: a push athlete asked for it, an at-goal athlete did
              // not. `keepsFullVolume` admits both, so naming the push declaration
              // unconditionally told a steady athlete the card reflects a preference
              // they never expressed. (The overload sentences above are already
              // attribution-free — they name the LOG, which is true either way.)
              drive === "push"
              ? `${prescription.why} ${say(voice.PUSH_FUEL_VARIETY_KEEP, "push_fuel_variety_keep")}`
              : `${prescription.why} ${say(voice.AT_GOAL_FUEL_VARIETY_KEEP, "at_goal_fuel_variety_keep")}`,
    };
  }
  // Any other action at/near goal keeps its own prescription and only hears the fuel
  // clause. The recovery-dose downgrade (−10% load AND half the sets) must not fire
  // once the destination is this close.
  if (atNearGoal && !prescription.pain_protected) {
    return {
      ...prescription,
      top_set: undefined,
      autoregulated: true,
      why: `${prescription.why} ${say(voice.FUEL_DELOAD_CLAUSE, "fuel_deload_clause")}`,
    };
  }
  // A PROGRESSION deload is already a reduced dose — load and volume both — so fuel
  // protection has nothing left to take and only adds its clause. A PAIN-braked deload
  // is a different animal: it cuts LOAD and deliberately leaves the set count alone.
  // Early-returning on it let the two floors cancel each other out — underfed plus a
  // red pain band produced a lift with the load off and the FULL volume still on,
  // which is the one combination neither brake would allow by itself. Fuel protection's
  // set-halving still applies on top.
  if (prescription.action === "deload" && !prescription.pain_protected)
    return {
      ...prescription,
      autoregulated: true,
      why: `${prescription.why} ${say(voice.FUEL_DELOAD_CLAUSE, "fuel_deload_clause")}`,
    };
  // For a pain-braked deload the pain brake's own cut number IS the load to keep:
  // `current` is the PRE-brake weight and would hand the load straight back. The two
  // brakes must not multiply on the same number, so only the volume comes off here.
  const base = prescription.pain_protected ? prescription.suggested : prescription.current ?? prescription.suggested;
  const reduced: PrescriptionTarget = {
    ...base,
    sets: Math.max(1, Math.ceil(Number(base.sets || prescription.suggested.sets || 1) / 2)),
  };
  if (!prescription.pain_protected) {
    if (prescription.mode === "timed" && Number.isFinite(Number(base.seconds)))
      reduced.seconds = Math.max(10, Math.round(Number(base.seconds) * 0.8));
    if (prescription.mode === "reps" && Number.isFinite(Number(base.weight)) && Number(base.weight) > 0)
      // Onto the lift's own load grid (load-grid.ts), never a half-pound no bar loads.
      reduced.weight = easedLoad(base.weight, 0.9, prescription.exercise, storedGroupOf(prescription.exercise));
  }
  return {
    ...prescription,
    action: "deload",
    suggested: reduced,
    delta_text: "recovery dose",
    escalated: rangeStep ? undefined : prescription.escalated,
    vary_to: undefined,
    vary_options: undefined,
    rep_step: undefined,
    top_set: undefined,
    starting_idea: undefined,
    autoregulated: true,
    fuel_protected: true,
    // A pain-braked lift keeps its own sentence — that is the safety-relevant one, and
    // the athlete reported the pain themselves — with the fuel clause appended. Only a
    // dose fuel alone reduced gets replaced by the recovery-dose sentence outright.
    why: prescription.pain_protected
      ? `${prescription.why} ${say(voice.FUEL_DELOAD_CLAUSE, "fuel_deload_clause")}`
      : say(voice.FUEL_RECOVERY_DOSE, "fuel_recovery_dose"),
  };
}

// The stored strength targets on a day, keyed by lowercased exercise name. A
// present key with a null value is a slot with NO target — which is different from
// a slot that isn't on the day at all, and the re-grounding check needs to tell
// those apart.
function planTargetsForDay(day: number): Map<string, number | null> {
  const out = new Map<string, number | null>();
  try {
    const rows = db
      .prepare(
        `SELECT e.name AS name, pi.target_weight AS target_weight
           FROM plan_items pi
           JOIN plan_days pd ON pd.id = pi.plan_day_id
           JOIN exercises e ON e.id = pi.exercise_id
          WHERE pd.day_number = ? AND (pi.kind IS NULL OR pi.kind != 'cardio')`
      )
      .all(Number(day)) as any[];
    for (const row of rows) out.set(String(row?.name ?? "").toLowerCase(), row?.target_weight ?? null);
  } catch {
    /* no plan day → nothing to compare against */
  }
  return out;
}

// Turn a day's per-lift prescriptions into a DRAFT plan proposal (the one-tap
// auto-progression apply), via the existing propose→apply path — never auto-applied.
// THE ONE shared builder for REST + MCP so they never drift. A `vary` prescription
// becomes a real {swap:{from,to}} change (rotating the stalled lift out for the lead
// same-pattern option) — it used to map to a target change on the SAME exercise at
// the held weight, i.e. a silent no-op. Everything else maps to a target step, and a
// "hold" (including an autoregulation-braked hold) is by definition no change → dropped.
// Returns the designed { ok:false, error } (status 200 at the surface) when there's
// nothing to propose.
export function buildProgressionProposal(
  day: number,
  opts: { forNextSession?: boolean } = {}
): { ok: false; error: string } | { ok: true; proposal: any } {
  if (!Number.isFinite(day)) return { ok: false, error: "day required" };
  const prescriptions = planDayProgression(day, opts);
  const planTargets = planTargetsForDay(day);
  const changes: Record<string, any>[] = [];
  for (const p of prescriptions) {
    // A hold is by definition no change — EXCEPT when it re-grounds a plan target
    // that sits below (or has nothing on it at all) what the athlete demonstrably
    // lifts. Without this the plan never caught up: the prescription said "50 lb"
    // on the card while plan_items kept its stale 27 (or its NULL) forever, so the
    // catch-up existed only in prose. It rides the SAME propose→apply path as every
    // other target nudge — bounded, reversible, ledgered, landing at a natural
    // boundary through applyProposalWithAutonomy — never a silent direct write.
    const planned = planTargets.get(p.exercise.toLowerCase());
    // A retired assist re-grounds to bodyweight, which is a NULL target — still a
    // real change against a stored negative one.
    const regroundOnly =
      p.action === "hold" &&
      p.reground === true &&
      p.mode === "reps" &&
      (p.suggested?.weight != null
        ? planned == null || Math.abs(Number(p.suggested.weight) - Number(planned)) > 0.1
        : p.suggested?.weight === null && planned != null && Number(planned) < 0);
    // A set-count catch-up is a real plan change on any hold or rep step it rides.
    const setStep = p.set_step != null && p.mode === "reps";
    // A rep-range move is a HOLD at the load with a new range — a real target change
    // (and a new prescription: the apply path re-stamps the slot, so the range stands
    // until a session is run at it). A fuel or pain dose that reshaped it is not one.
    const rangeMove =
      p.action === "hold" &&
      p.escalated === "rep_range" &&
      p.mode === "reps" &&
      !p.fuel_protected &&
      !p.pain_protected &&
      p.suggested?.rep_low != null &&
      p.suggested?.rep_high != null &&
      (p.current == null ||
        p.suggested.rep_low !== p.current.rep_low ||
        p.suggested.rep_high !== p.current.rep_high);
    if (p.action === "hold" && !regroundOnly && !setStep && !rangeMove) continue;
    if (p.rep_step && !setStep) continue; // a double-progression rep advance is no plan change — the range already covers it
    // A peak-week top set is a SESSION protocol, not a plan target. Writing a
    // near-maximal single into plan_items would make it the number every later step
    // is measured from, long after the peak week is over — the result reaches the
    // models through the logged set instead (detectStrengthCalibration).
    if (p.top_set) continue;
    // A vary/introduce → a first-class swap (rotate the lift out for the lead option).
    if (p.action === "vary" || p.action === "introduce") {
      const to = p.vary_to ?? p.vary_options?.[0]?.name ?? null;
      if (!to) continue; // no candidate → nothing to swap to (skip, never a no-op)
      changes.push({
        day_number: day,
        swap: { from: p.exercise, to },
        reason: p.why || `Rotate a variation in for ${p.exercise}.`,
      });
      continue;
    }
    const c: Record<string, any> = {
      day_number: day,
      exercise: p.exercise,
      sets: p.suggested?.sets ?? null,
      rep_low: p.suggested?.rep_low ?? null,
      rep_high: p.suggested?.rep_high ?? null,
      reason: p.why || p.delta_text || null,
      // WHY any volume this change takes off is owed back — read at apply time by
      // the restore ledger (volume-guard.ts). Only the fuel-protection dose claims
      // the fuel story; every other cut records its debt as ordinary policy.
      ...(p.fuel_protected ? { volume_cause: "fuel" } : {}),
      // The audit trail a REPEAT deload is recognised from. Only a progression deload
      // claims it — a fuel-protection dose is a cut about fuel, and a lift should not
      // inherit an escalation for a week the kitchen was the problem. Nothing on the
      // apply path reads this field; it is history, not an instruction.
      ...(p.action === "deload" && !p.fuel_protected && !p.pain_protected
        ? { progression_action: "deload" }
        : {}),
      // …and the SHAPE change, when the repeat escalated into one. Without it the
      // wave has no audit trail of its own, so the next repeat would escalate again
      // on top of a wave that has not had time to work. Read back by waveRunning().
      ...(p.escalated === "rep_wave" && !p.fuel_protected && !p.pain_protected
        ? { progression_escalation: "rep_wave" }
        : {}),
      // …and the rep-range move's own trail: read back by lastAppliedRepRangeMove
      // (lift-response.ts), so a lift is moved up a range once, never in a loop.
      ...(rangeMove ? { progression_escalation: "rep_range" } : {}),
    };
    if (p.mode === "timed") {
      if (p.suggested.seconds != null) c.target_seconds = p.suggested.seconds;
      // A loaded carry/hold's load step travels with its seconds reset. A load the
      // plan never carried (adopted off the log) is never written into it.
      if (planned != null && p.suggested.weight !== undefined && p.suggested.weight !== planned)
        c.target_weight = p.suggested.weight;
    } else if (p.suggested.weight !== undefined) {
      // A re-ground on an assisted-history lift never writes a positive target
      // in one step — bodyweight (null) is the furthest it may travel.
      const suggestedWeight = p.suggested.weight;
      c.target_weight =
        suggestedWeight != null && suggestedWeight > 0 && planned != null && planned < 0 ? null : suggestedWeight;
    }
    // Only a change that moves a target, the range or the set count (or is a swap) is a real change.
    if (c.target_weight !== undefined || c.target_seconds !== undefined || setStep || rangeMove) changes.push(c);
  }
  if (!changes.length) return { ok: false, error: "nothing to propose for this day" };
  const parsed = {
    summary: `Auto-progression for day ${day} — ${changes.length} lift${changes.length === 1 ? "" : "s"}`,
    changes,
  };
  // Retire any prior un-applied auto-progression draft for THIS day so repeated taps
  // never stack duplicates (the fresh draft reflects the latest logs).
  supersedeAutoProgressionDrafts(day);
  const proposal = createProposal("auto-progression", `day ${day} progression`, "", parsed);
  return { ok: true, proposal };
}

// Build the DRAFT proposal that gives held training volume back — one set per
// item per boundary, never past the value the reduction recorded. Volume is the
// one prescription field the ladder above cannot climb (see volume-guard.ts), so
// without this a protective cut is permanent. It rides the ordinary propose→apply
// path and is never auto-applied here; the caller routes it through autonomy,
// which lands it announced. Returns the designed { ok:false, error } when nothing
// is owed — the calm, common answer.
export function buildVolumeRestoreProposal(
  opts: { cause?: VolumeCutCause } = {}
): { ok: false; error: string } | { ok: true; proposal: any } {
  const parsed = volumeRestorePayload(opts);
  if (!parsed) return { ok: false, error: "no held training volume to restore" };
  // At most one restore card is ever open: a daily pass re-derives the same step
  // from the plan, so a waiting draft is replaced rather than stacked beside.
  for (const draftId of openVolumeRestoreDraftIds()) setProposalStatus(draftId, "superseded");
  const proposal = createProposal(VOLUME_RESTORE_AGENT, VOLUME_RESTORE_INSTRUCTION, "", parsed);
  return { ok: true, proposal };
}

// ---- program balance (volume per canonical group) ---------------------------
export interface GroupBalance {
  group: string;
  sets: number; // working sets over the window (per week, rounded)
  band: "low" | "productive" | "high";
  last_trained: string | null; // ISO date of the most recent set in that group
  status: "due" | "ok" | "high";
  // Endurance sessions per week that loaded this region, in heavy-session
  // equivalents. Held SEPARATE from `sets` on purpose (see enduranceByRegion):
  // MUSCLE_LANDMARKS are resistance-calibrated, so folding a run into a set count
  // would make a runner's quads read "productive" on lifting volume they never
  // did. It only ever answers a different question — is this region already
  // carrying real work?
  endurance_sessions: number;
  // True when that endurance load is substantial enough that calling this group
  // "due" would be dishonest. The group is still LOW on resistance volume; it is
  // simply not idle.
  endurance_supported: boolean;
}
export interface ProgramBalance {
  groups: GroupBalance[];
  due: string[];
  over: string[];
  summary: string;
  // True when MOST groups read "due" at once — the honest signal then isn't a
  // 10-item to-do list, it's "overall strength volume is low right now" (expected
  // during an endurance-led block). Surfaces collapse to one calm line instead of a
  // wall of due chips. See buildBalanceSummary.
  broad_low: boolean;
}

// How much ENDURANCE work each region carried over the window, in heavy-session
// equivalents per week. Deliberately a SEPARATE number from the working-set
// tally rather than added into it: MUSCLE_LANDMARKS are calibrated against
// resistance volume, so crediting a long run as "sets" would tell a runner their
// quads are at productive lifting volume they never did. This answers the other
// question — is the region actually idle, or is it just not being LIFTED?
//
// THE RULE (see programBalance): a region carrying at least
// ENDURANCE_SUPPORTED_PER_WEEK heavy-session equivalents is never called "due".
// Its band stays honest (resistance volume really is low), but a 40-mile week
// leaves calves and trunk loaded, not neglected.
//
// EXCEPT the legs' lifting prime movers. Quads, hamstrings and glutes are what a
// squat or hinge day trains, and running keeps them busy, not stronger — exempting
// them meant a runner's legs could never read "due", so the day picker drifted to
// upper days for weeks.
const ENDURANCE_SUPPORTED_PER_WEEK = 1.5;
const LIFT_ONLY_GROUPS = new Set(["quads", "hamstrings", "glutes"]);

function enduranceSupported(group: string, weeklySessions: number): boolean {
  return !LIFT_ONLY_GROUPS.has(group) && weeklySessions >= ENDURANCE_SUPPORTED_PER_WEEK;
}

// The regions the athlete's endurance work is carrying right now, by the same rule
// that keeps programBalance from calling them "due". The plan's volume floor
// (volume-floor.ts) exempts exactly these, so the balance read and the plan
// compiler can never disagree about whether a runner's calves are neglected.
export function enduranceCarriedGroups(weeks = 2, date = localDateISO()): string[] {
  const out: string[] = [];
  for (const [group, weekly] of enduranceByRegion(weeks, String(date).slice(0, 10)))
    if (enduranceSupported(group, weekly)) out.push(group);
  return out;
}

function enduranceByRegion(weeks: number, date: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const days = Math.max(1, Math.round(weeks * 7));
    for (const impact of recentEnduranceImpacts(days, date)) {
      const dose = enduranceDose(impact);
      if (!(dose > 0)) continue;
      for (const region of impact.regions) {
        if (isMobility(region)) continue;
        out.set(region, (out.get(region) ?? 0) + dose / weeks);
      }
    }
  } catch {
    /* no activities → the balance read is simply strength-only, as it always was */
  }
  return out;
}

// Working-set volume per CANONICAL group over the window (default 2 wk), banded
// against MUSCLE_LANDMARKS. Mobility is EXCLUDED from set-count math (it never
// inflates the working-set picture). `due` = a group under its low landmark OR
// not trained in 7 days — UNLESS endurance is already loading that region (see
// enduranceByRegion); `over` = above its high landmark. Plain words only.
export function programBalance(weeks = 2, date = localDateISO()): ProgramBalance {
  const today = String(date || localDateISO()).slice(0, 10);
  const since = addDaysISO(today, -(weeks * 7 - 1)) ?? today;
  const endurance = enduranceByRegion(weeks, today);
  const enduranceWeekly = (group: string): number => Math.round((endurance.get(group) ?? 0) * 10) / 10;

  const rows = db
    .prepare(
      `SELECT e.muscle_group AS muscle_group, e.name AS exercise, s.date AS date,
            ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
       FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
       JOIN sessions s ON s.id = ls.session_id
      WHERE s.date >= ? AND s.date <= ?`
    )
    .all(since, today) as any[];

  // ONE honest-volume truth: warmups excluded, RIR-weighted, indirect credit, canon
  // taxonomy (mobility never counts). Shared with muscleVolume + getVolumeByMuscle.
  const tally = effectiveVolumeByGroup(rows as VolumeSet[]);

  const daysAgo = (iso: string | null): number | null => {
    if (!iso) return null;
    return daysBetweenISO(today, iso);
  };

  const groups: GroupBalance[] = [];
  for (const [group, v] of tally) {
    const weeklySets = Math.round((v.sets / weeks) * 10) / 10;
    const lm = MUSCLE_LANDMARKS[group];
    let band: GroupBalance["band"] = "productive";
    if (lm) band = weeklySets < lm.low ? "low" : weeklySets > lm.high ? "high" : "productive";
    const since7 = daysAgo(v.last_date);
    const stale = since7 != null && since7 > 7;
    const enduranceSessions = enduranceWeekly(group);
    const supported = enduranceSupported(group, enduranceSessions);
    const wouldBeDue = band === "low" || stale;
    const status: GroupBalance["status"] =
      wouldBeDue && !supported ? "due" : band === "high" ? "high" : "ok";
    groups.push({
      group,
      sets: weeklySets,
      band,
      last_trained: v.last_date,
      status,
      endurance_sessions: enduranceSessions,
      endurance_supported: supported && wouldBeDue,
    });
  }
  // Surface groups that are PROGRAMMED but not trained at all in the window too.
  // Otherwise the brain can show "Pull" because the template says so while the
  // balance layer quietly omits push/core groups that have zero recent rows. Keep
  // this plan-scoped: totally unplanned groups still surface through the explicit
  // missing-pattern gaps below, not as a fake 12-item due wall.
  const presentGroups = new Set(groups.map((g) => g.group));
  const plannedGroups = new Set([...plannedMovesByGroup().keys()].filter((g) => MUSCLE_LANDMARKS[g]));
  if (plannedGroups.size) {
    const lastByGroup = new Map<string, string>();
    const lastRows = db
      .prepare(
        `SELECT e.muscle_group AS muscle_group, e.name AS exercise, MAX(s.date) AS last_date
         FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
         JOIN sessions s ON s.id = ls.session_id
        WHERE s.date <= ?
        GROUP BY e.id`
      )
      .all(today) as any[];
    for (const r of lastRows) {
      const g = canonicalGroup(r.muscle_group) ?? classifyMuscleGroup(r.exercise);
      if (!g || g === "mobility" || !MUSCLE_LANDMARKS[g]) continue;
      const last = String(r.last_date || "");
      if (last && (!lastByGroup.has(g) || last > (lastByGroup.get(g) ?? ""))) lastByGroup.set(g, last);
    }
    for (const group of plannedGroups) {
      if (presentGroups.has(group)) continue;
      // The same rule applies to a group with ZERO logged sets: a runner's calves
      // are programmed, untrained, and anything but idle.
      const enduranceSessions = enduranceWeekly(group);
      const supported = enduranceSupported(group, enduranceSessions);
      groups.push({
        group,
        sets: 0,
        band: "low",
        last_trained: lastByGroup.get(group) ?? null,
        status: supported ? "ok" : "due",
        endurance_sessions: enduranceSessions,
        endurance_supported: supported,
      });
      presentGroups.add(group);
    }
  }

  groups.sort((a, b) => b.sets - a.sets);

  const due = groups.filter((g) => g.status === "due").map((g) => g.group);
  const over = groups.filter((g) => g.status === "high").map((g) => g.group);

  // Broad-low: when MOST groups are due at once, the signal is "overall strength
  // volume is low", not a per-group to-do list — common when running is the focus.
  const broad_low = groups.length >= 5 && due.length >= Math.ceil(groups.length * 0.6);

  // Plain-words adherence-skew summary (no numbers as a grade).
  const summary = buildBalanceSummary(groups, due, over, broad_low);
  return { groups, due, over, summary, broad_low };
}

function buildBalanceSummary(groups: GroupBalance[], due: string[], over: string[], broadLow: boolean): string {
  if (!groups.length)
    return "Not enough logged yet to read your volume balance — keep training and it'll come into focus.";
  // Broad-low → one calm line instead of listing every group. Name the 1-2 groups
  // that have gone LONGEST without work (the genuinely-neglected standouts) so it
  // stays actionable, never a wall of "everything's behind".
  if (broadLow) {
    const overPart = over.length ? ` ${over.join(", ")} running a touch high.` : "";
    const stale = due
      .map((g) => groups.find((x) => x.group === g))
      .filter((g): g is GroupBalance => !!g)
      .sort((a, b) => (a.last_trained ?? "").localeCompare(b.last_trained ?? ""))
      .slice(0, 2)
      .map((g) => g.group);
    const lead = stale.length
      ? ` No need to chase every group — ${stale.join(" and ")} ${stale.length > 1 ? "have" : "has"} gone longest without work, so start there.`
      : "";
    return `Strength volume is light across most groups right now — expected if running is the priority, not a problem.${overPart}${lead}`;
  }
  // Regions the endurance work is already carrying. Named so they do not simply
  // VANISH from the picture — "light on lifting, but not idle" is the honest read,
  // and it is the difference between a calm note and an unexplained silence.
  const carried = groups.filter((g) => g.endurance_supported).map((g) => g.group);
  const carriedPart = carried.length
    ? ` ${plainGroupWords(carried, 2)} ${carried.length > 1 ? "are" : "is"} light on lifting but already carrying your endurance work.`
    : "";
  const parts: string[] = [];
  if (over.length) parts.push(`${over.join(", ")} running high`);
  if (due.length) parts.push(`${due.join(", ")} due`);
  if (!parts.length)
    return `Volume looks well balanced across the groups you're training.${carriedPart}`;
  return `${parts.join("; ")}.${carriedPart}`;
}

// ---- the "what changed & why" digest ----------------------------------------
export interface ProgramAdjustment {
  kind: "progression" | "balance" | "deload" | "gap" | "cardio" | "dexa" | "test";
  title: string;
  why: string;
  exercise?: string;
  // The canonical group this is about (balance/gap items), so the UI can route a
  // "plan it" action; and a few concrete movements to actually do about it.
  group?: string;
  suggestions?: string[];
  // A due group that's recovering from recent acute load (a long ride/run, or a
  // heavy session) — informational, NOT a "do it now" pick. The UI sinks + reframes
  // it; "plan it" becomes "plan around it" rather than "add it".
  recovering?: boolean;
  // A due group that is ALREADY programmed in the plan — the gap is logged volume,
  // not a missing movement. The UI reframes "add a movement" → "train what's there"
  // so it never tells you to add work you already have scheduled.
  programmed?: boolean;
}

// The handful of concrete adaptations DUE right now — lifts to push/hold/deload
// (from the plan-day prescriptions across the whole plan), groups that are due,
// and missing-pattern GAPS (no core / grip / mobility programmed). Plain words,
// most-actionable first, deduped. This is the calm "what the system noticed"
// surface — pull, never push.
//
// MEMOIZED (repo/training-cache.ts). One Today open asks this question up to three
// times — the /program/adjustments route, todayAgenda's adaptations candidate, and the
// coach-context build — and each pass walks every plan day's progression (~1.4k
// statements). The KEY is the coach-context backstop (counts + high-water marks + the
// update odometer over every table this read touches, plus profile and settings by
// value) and the local date, so any write that could change an adaptation lands a new
// key. The optional arguments are serialized into the key too: a caller may thread a
// balance / acute-gate view built for a DIFFERENT date than today, and keying on
// "arguments were supplied" alone would let one caller's view answer another's
// question. Bounded to a handful of slots (the argument shapes are few and fixed) and
// cleared with every other training memo; structuredClone on the way out, because
// consumers sort and annotate these rows.
const PROGRAM_ADJUSTMENTS_MEMO_SLOTS = 8;
const programAdjustmentsCache = new Map<string, ProgramAdjustment[]>();
registerTrainingCacheClear(() => {
  programAdjustmentsCache.clear();
});

/**
 * Stable, cheap key fragment for one optional argument (Maps ordered by their keys).
 *
 * The absent and empty cases are answered without serializing anything, because they are
 * the common ones: a caller that supplies no view at all, and an acute-gate map with no
 * readings yet, would otherwise pay a JSON round-trip on every call including the hits.
 * A real view is still serialized BY VALUE, never by identity — two callers that
 * assembled an equal view must share one memo slot, and an identity-keyed shortcut would
 * quietly stop them doing that.
 */
function adjustmentsArgKey(arg: unknown): string {
  if (arg === undefined) return "-";
  if (arg === null) return "null";
  try {
    if (arg instanceof Map) {
      if (arg.size === 0) return "[]"; // what the serialized empty entry list already was
      return JSON.stringify([...arg.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    }
    // An all-null options object is deliberately NOT folded into an empty one:
    // `"runPlan" in opts` is how the reader tells "explicitly no run plan" from "go read
    // one", so {runPlan: null} and {} are different questions.
    return JSON.stringify(arg);
  } catch {
    return `unserializable:${Math.random()}`; // never-matching → compute rather than guess
  }
}

export function programAdjustments(
  balArg?: ProgramBalance,
  acuteArg?: Map<MuscleGroup, AcuteGateReading>,
  opts?: { runPlan?: WeeklyRunPlan | null; dexa?: DexaTargeting | null; testWeek?: TestWeekDue | null }
): ProgramAdjustment[] {
  const key = [
    localDateISO(),
    coachContextBackstopSignature(),
    adjustmentsArgKey(balArg),
    adjustmentsArgKey(acuteArg),
    adjustmentsArgKey(opts),
  ].join("|");
  const hit = programAdjustmentsCache.get(key);
  if (hit) return structuredClone(hit);
  const value = computeProgramAdjustments(balArg, acuteArg, opts);
  // Keep the map bounded: drop the oldest insertion once past the slot budget.
  if (programAdjustmentsCache.size >= PROGRAM_ADJUSTMENTS_MEMO_SLOTS) {
    const oldest = programAdjustmentsCache.keys().next().value;
    if (oldest !== undefined) programAdjustmentsCache.delete(oldest);
  }
  programAdjustmentsCache.set(key, value);
  return structuredClone(value);
}

function computeProgramAdjustments(
  balArg?: ProgramBalance,
  acuteArg?: Map<MuscleGroup, AcuteGateReading>,
  opts?: { runPlan?: WeeklyRunPlan | null; dexa?: DexaTargeting | null; testWeek?: TestWeekDue | null }
): ProgramAdjustment[] {
  const out: ProgramAdjustment[] = [];
  const seen = new Set<string>();
  const push = (a: ProgramAdjustment) => {
    const k = `${a.kind}|${a.title}`.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(a);
  };

  // 1) Per-lift adaptations across every plan day — deloads + varies first
  //    (most actionable), then earned overloads.
  const days = db.prepare(`SELECT day_number FROM plan_days ORDER BY day_number`).all() as any[];
  const deloads: ProgramAdjustment[] = [];
  const varies: ProgramAdjustment[] = [];
  const overloads: ProgramAdjustment[] = [];
  for (const d of days) {
    for (const p of planDayProgression(d.day_number)) {
      if (p.action === "deload")
        deloads.push({ kind: "deload", title: `Deload ${p.exercise}`, why: p.why, exercise: p.exercise });
      else if (p.action === "vary")
        varies.push({
          kind: "progression",
          title: `Rotate a variation for ${p.exercise}`,
          why: p.why,
          exercise: p.exercise,
        });
      else if (p.action === "overload")
        overloads.push({
          kind: "progression",
          title: `${p.exercise} — ${p.delta_text}`,
          why: p.why,
          exercise: p.exercise,
        });
    }
  }
  // Lead with the WINS — an earned step-up is the most motivating, actionable thing a
  // coach can surface ("your work paid off, here's the load"). They used to be pushed
  // dead-last and cut by the 8-item cap, buried under "No X programmed" gap-nags.
  overloads.slice(0, 3).forEach(push);
  deloads.forEach(push);
  varies.forEach(push);

  // 2) Mesocycle: a deload about due (program-state read).
  try {
    const st = getProgramState();
    if (st.mesocycle?.phase === "deload-due") {
      push({ kind: "deload", title: "A deload week is about due", why: st.mesocycle.note });
    }
  } catch {
    /* program-state unavailable → skip */
  }

  // 3) Balance: groups that are due (under-volume or not trained recently) —
  //    reconciled against ACUTE recovery so a just-smoked muscle is never put up as
  //    the next move. A group hammered in the last day or two (lifting OR a long
  //    ride/run) is held back (sunk below fresh work + the gaps, reframed honestly);
  //    fresh due groups lead. This is the connected read that makes the next-day
  //    pick elite — your legs are toast after a 3 h ride, so it stops recommending
  //    them and surfaces what's actually fresh.
  // Reuse the balance + acute-load reads getCoachContext already computed (the hot
  // path), falling back to a fresh compute when called standalone.
  const bal = balArg ?? programBalance();
  const acute = acuteArg ?? acuteGates();
  // Plan-aware reframe: a due group that's ALREADY programmed doesn't need a NEW
  // movement — the gap is logged volume (you scheduled it; train it). So we never
  // tell you to "add a back movement" when your plan already has rows, lat pulldowns
  // and pull-ups. ONE plan query feeds both the per-group moves and the GAPS below.
  const plannedMoves = plannedMovesByGroup();
  const planned = new Set(plannedMoves.keys());
  const recovering: Array<{ group: string; gate: AcuteGateReading }> = [];
  for (const g of bal.due.slice(0, 4)) {
    const gb = bal.groups.find((x) => x.group === g);
    const reason = gb && gb.band === "low" ? "under its productive volume range lately" : "not trained in over a week";
    // The shared acute gate: a group still carrying a session's worth of
    // undissipated work is never put up as the next move, however "due" it looks.
    const gate = acute.get(g as MuscleGroup);
    if (gate?.saturated) {
      recovering.push({ group: g, gate });
      continue;
    }
    if (planned.has(g)) {
      // Already in the plan — honest read: get those sessions in, don't add more.
      const moves = plannedMoves.get(g) ?? [];
      const where = plannedDaysPhrase(moves);
      push({
        kind: "balance",
        title: `${cap(g)} is due`,
        why: `${cap(g)} is ${reason}, but it's already in your plan${where ? ` (${where})` : ""} — the gap is logged volume, so get those sessions in this week rather than adding more.`,
        group: g,
        suggestions: moves.slice(0, 3).map((m) => m.exercise),
        programmed: true,
      });
    } else {
      push({
        kind: "balance",
        title: `${cap(g)} is due`,
        why: `${cap(g)} is ${reason} — work it in this week.`,
        group: g,
        suggestions: examplesForGroup(g, 3),
      });
    }
  }
  // ONE consolidated recovering note, right after the fresh due groups — so the
  // athlete SEES why a smoked muscle isn't being recommended (the connected read)
  // without three near-identical rows crowding the card, and it always survives the
  // 8-item cap. Fresh, actionable work still leads above it.
  if (recovering.length) {
    const groups = recovering.map((r) => r.group);
    const lead = (recovering.find((r) => r.gate.activity) ?? recovering[0]).gate;
    const many = groups.length > 1;
    const subj = many ? "They're" : `${cap(groups[0])} is`;
    const it = many ? "them" : "it";
    push({
      kind: "balance",
      title: `${cap(groups.join(", "))} — recovering`,
      why: `${subj} due, but ${loadPhrase(lead)} loaded ${it} hard — give ${it} a day before training ${it} again. The fresher work above is the smarter pick for your next session.`,
      group: groups[0],
      recovering: true,
    });
  }
  for (const g of bal.over.slice(0, 2)) {
    push({
      kind: "balance",
      title: `${cap(g)} is running high`,
      why: `${cap(g)} volume is above its productive range — there's room to redirect some of it to a due group.`,
      group: g,
    });
  }

  // 4) Missing-pattern GAPS — the elite-coach floors this athlete is missing.
  //    Read what groups appear ANYWHERE in the plan; flag core / forearms (grip)
  //    / mobility when they're absent (they were invisible until the taxonomy
  //    added them as first-class groups). Reuses `planned` from the balance step.
  // Gap titles are ADDITIVE and calm ("Add a little core"), never a "No X programmed"
  // nag-wall — these are gentle floors worth rounding the program out with, not failures
  // (constitution: calm, never shaming). They sit BELOW the earned wins + due focus above.
  for (const [group, title, why, suggestions] of [
    [
      "core",
      "Add a little core",
      "No anti-extension / anti-rotation core work is programmed — a loaded carry or a plank/pallof variation underpins everything else.",
      ["Pallof Press", "Farmer's Walk", "Hanging Leg Raise"],
    ],
    [
      "forearms",
      "Work in some grip",
      "No grip work is programmed — dead hangs or loaded carries build grip, protect the elbow, and carry over to every pull.",
      ["Farmer's Walk", "Suitcase Carry", "Dead Hang"],
    ],
    [
      "mobility",
      "A little mobility prep",
      "No mobility / activation work is programmed — a few minutes of ankle + hip prep protects the joints, especially for a returning runner.",
      ["Ankle Rocker", "90/90 Hip Switch", "World's Greatest Stretch"],
    ],
  ] as const) {
    if (!planned.has(group)) {
      push({ kind: "gap", title, why, group, suggestions: [...suggestions] });
    }
  }

  // 5) RUNNING — this week's periodized run mix as a single calm digest item, so
  //    the "what changed & why" surface spans running, not just lifting. Reuse the
  //    pre-computed plan from getCoachContext when threaded; else compute it lazily.
  try {
    // A week-level digest (mix_summary / why): the morning's call on today changes neither.
    const rp = opts && "runPlan" in opts ? opts.runPlan : weeklyRunPlan(undefined, { adjustToday: false });
    if (rp?.available && rp.mix_summary) {
      push({
        kind: "cardio",
        title: `This week's runs: ${rp.mix_summary}`,
        why: rp.why || (Array.isArray(rp.rationale) ? rp.rationale.join(" ") : ""),
      });
    }
  } catch {
    /* run plan unavailable → skip */
  }

  // 6) DEXA — the body scan's training targets as gentle "From your DEXA" items
  //    (bias + concrete moves). Nutrition targets stay in the nutrition prompts.
  try {
    const dx = opts && "dexa" in opts ? opts.dexa : dexaTargeting();
    if (dx?.available && Array.isArray(dx.targets)) {
      for (const t of dx.targets.filter((x) => x.domain === "training").slice(0, 2)) {
        push({
          kind: "dexa",
          title: `From your DEXA: ${t.bias}`,
          why: `${t.signal}${Array.isArray(t.moves) && t.moves.length ? ` Moves: ${t.moves.join(", ")}.` : ""}`,
          group: Array.isArray(t.groups) && t.groups.length ? t.groups[0] : undefined,
          suggestions: Array.isArray(t.moves) ? t.moves.slice(0, 3) : undefined,
        });
      }
    }
  } catch {
    /* dexa unavailable → skip */
  }

  // 7) TEST WEEK — a cadenced re-test invitation (block realization / ~7-week
  //    cadence), naming the benchmark lifts to re-anchor true capacity.
  try {
    const tw = opts && "testWeek" in opts ? opts.testWeek : testWeekDue();
    if (tw?.due && Array.isArray(tw.key_lifts) && tw.key_lifts.length) {
      push({
        kind: "test",
        title: "A test week is about due",
        why: `${tw.why} Worth re-testing: ${tw.key_lifts.join(", ")}.`,
      });
    }
  } catch {
    /* test-week unavailable → skip */
  }

  return out.slice(0, 8);
}

// The strength movements programmed in the plan, grouped by canonical muscle group
// (with the day each sits on) — so a due-but-programmed group can say "you have these,
// on these days" instead of suggesting movements you already train. ONE query feeds
// both the per-group moves and the plan's programmed-group set (its keys).
type PlannedMove = { exercise: string; day: number; day_name: string | null };
function plannedMovesByGroup(): Map<string, PlannedMove[]> {
  const rows = db
    .prepare(
      `SELECT DISTINCT e.name AS name, e.muscle_group AS mg, pd.day_number AS day, pd.name AS day_name
       FROM plan_items pi
       JOIN exercises e ON e.id = pi.exercise_id
       JOIN plan_days pd ON pd.id = pi.plan_day_id
      WHERE (pi.kind IS NULL OR pi.kind != 'cardio')
      ORDER BY pd.day_number, pi.position`
    )
    .all() as any[];
  const map = new Map<string, PlannedMove[]>();
  for (const r of rows) {
    const g = canonicalGroup(r.mg) ?? classifyMuscleGroup(r.name);
    if (!g) continue;
    (map.get(g) ?? map.set(g, []).get(g)!).push({ exercise: r.name, day: r.day, day_name: r.day_name ?? null });
  }
  return map;
}

// Plain-words "Day 3 (Pull), Day 5" phrase over a group's programmed movements.
function plannedDaysPhrase(moves: Array<{ day: number; day_name: string | null }>): string {
  const seen = new Set<number>();
  const parts: string[] = [];
  for (const m of moves) {
    if (seen.has(m.day)) continue;
    seen.add(m.day);
    parts.push(`Day ${m.day}${m.day_name ? ` (${m.day_name})` : ""}`);
    if (parts.length >= 3) break;
  }
  return parts.join(", ");
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ---------------------------------------------------------------------------
// programEvolutionTrigger — the DATA-TRIGGERED half of the continuous-coach
// cadence. The scheduler's WEEKLY auto-evolution fires on the calendar; this
// answers "has the athlete's own logged data shifted enough that the plan should
// adapt SOONER than next Sunday?" — a lift truly plateaued and wanting a
// variation (more load isn't the answer), a muscle group running UNDER its
// productive volume range (a weak point to build — core / grip / a lagging
// pattern), or a cadenced re-test come due. Deterministic, no agent, no scores.
//
// The scheduler reads `due` + the stable `signature` (so a STANDING condition
// drafts ONCE, not every day) and, on a genuine shift, drafts the same one-tap
// evolution proposal early — still pull-never-push, still deduped so it never
// piles up. Materiality guard: a weak-point group only triggers for an athlete
// who is ACTUALLY training (≥4 logged sessions on some lift), so a brand-new
// plan — which reads every group as "under-trained" — is a calm no-op, not a
// flood. Injectable opts mirror testWeekDue/programAdjustments for pure testing.
// ---------------------------------------------------------------------------
export interface ProgramEvolutionTrigger {
  due: boolean;
  reasons: string[]; // plain-language, surfaced as the draft's "why now"
  signature: string; // stable key of the conditions, for once-per-shift dedup
}

export function programEvolutionTrigger(
  date?: string,
  opts: {
    programState?: any;
    balance?: ProgramBalance;
    testWeek?: TestWeekDue;
    enduranceTests?: { exercise?: string; kind?: string; why?: string }[];
    trainingPlaybook?: TrainingPlaybookRead | null;
  } = {}
): ProgramEvolutionTrigger {
  const reasons: string[] = [];
  const sigParts: string[] = [];

  let ps = opts.programState;
  if (ps === undefined) {
    try {
      ps = getProgramState(date);
    } catch {
      ps = { lifts: [] };
    }
  }
  const lifts = Array.isArray(ps?.lifts) ? ps.lifts : [];
  // Enough logged history to read a real trajectory (plateau/vary already imply
  // ≥3 sessions; this gate is for the weak-point signal, which would otherwise
  // light up on a never-trained group of a fresh plan).
  const hasHistory = lifts.some((l: any) => (l?.sessions ?? 0) >= 4);

  // (1) A lift that has truly plateaued and wants a variation, or is regressing —
  //     the strongest "the plan should change" signal (load isn't the lever).
  const wantsVary = lifts
    .filter((l: any) => l?.suggested_action === "vary" || l?.status === "regressing")
    .map((l: any) => l?.exercise)
    .filter(Boolean)
    .map((s: any) => String(s))
    .sort();
  if (wantsVary.length) {
    reasons.push(
      wantsVary.length === 1
        ? `${wantsVary[0]} has stalled — time to rotate a variation in.`
        : `${wantsVary.slice(0, 3).join(", ")} have stalled — time to rotate variations in.`
    );
    sigParts.push(`vary:${wantsVary.join(",")}`);
  }

  // (1b) Support-work: a lagging COMPOUND whose CONTRIBUTING muscles are under-
  //      trained wants targeted supporting work, not just a movement rotation — the
  //      elite-coach read ("bench is stuck and the triceps are the weak link; build
  //      them before rotating the lift"). Deterministic, driven off the same
  //      program-state read. Each entry folds its plain-language suggestion into the
  //      reasons and a stable {lift + weak-link groups} digest into the signature, so
  //      a standing weak-link condition drafts once and re-arms only when the picture
  //      changes. Reuses the already-resolved `ps` (no recompute; injectable in tests).
  const supportEntries = supportWorkRead(date, { programState: ps });
  for (const entry of supportEntries) {
    reasons.push(entry.suggestion);
    sigParts.push(entry.signature);
  }

  // (3) A cadenced re-test come due — re-measure true capacity before the next
  //     block (an honest checkpoint, never a forced max). Computed before the
  //     weak-point clause so it can also satisfy the "actively training" gate.
  let tw = opts.testWeek;
  if (tw === undefined) {
    try {
      tw = testWeekDue(date, { programState: ps });
    } catch {
      tw = undefined;
    }
  }
  const twDue = !!tw?.due;

  // (2) Endurance/hybrid shifts that should wake the same plan-evolution loop:
  //     a material mileage ramp, a mono-stimulus/run-plateau read, a due endurance
  //     benchmark, or a ramp colliding with the next strength day. This is still
  //     a draft trigger only — it does not mutate the plan.
  const endurance = ps?.endurance;
  const hybrid = ps?.hybrid;
  const enduranceAcwr = Number(endurance?.acute_chronic_ratio);
  const mileageRamp = Number.isFinite(enduranceAcwr) && enduranceAcwr >= 1.25;
  if (mileageRamp) {
    const pct = Math.round((enduranceAcwr - 1) * 100);
    reasons.push(`Endurance volume is up ~${pct}% over your base — adapt the week before stacking more load.`);
    sigParts.push(`endurance-ramp:${Math.round(enduranceAcwr * 100)}`);
  }
  if (endurance?.suggested_action === "add-quality") {
    reasons.push(
      "Running has turned into one steady stimulus — add a quality or long-run variation instead of just repeating the same run."
    );
    sigParts.push("run-plateau:add-quality");
  } else if (endurance?.pace_trend === "declining") {
    reasons.push(
      "Run pace is drifting the wrong way — treat this as a recovery/programming problem before adding more mileage."
    );
    sigParts.push("run-plateau:pace-decline");
  }
  if (
    mileageRamp &&
    (hybrid?.next_strength?.advice === "swap-or-upper" || hybrid?.next_strength?.advice === "hold-load")
  ) {
    reasons.push(
      `Mileage is ramping into ${hybrid.next_strength.day_name || "the next strength day"} — sequence lower-body work or deload it instead of forcing both.`
    );
    sigParts.push(`hybrid-interference:${hybrid.next_strength.advice}:${hybrid.next_strength.day_number ?? "next"}`);
  }

  let et = opts.enduranceTests;
  if (et === undefined) {
    try {
      et = enduranceTestsDue(date);
    } catch {
      et = undefined;
    }
  }
  const enduranceTestKeys = (Array.isArray(et) ? et : [])
    .map((t) => String(t?.exercise || "").trim())
    .filter(Boolean)
    .sort();
  if (enduranceTestKeys.length) {
    reasons.push(`An endurance benchmark is due (${enduranceTestKeys.slice(0, 2).join(", ")}).`);
    sigParts.push(`endurance-test:${enduranceTestKeys.join(",")}`);
  }

  let playbook = opts.trainingPlaybook;
  if (playbook === undefined) {
    try {
      playbook = trainingPlaybook(date, { programState: ps });
    } catch {
      playbook = null;
    }
  }
  const plays = Array.isArray(playbook?.plateau_plays) ? playbook!.plateau_plays : [];
  for (const play of plays) {
    if (!play?.kind) continue;
    if (play.kind === "strength_plateau" && wantsVary.includes(String(play.exercise || ""))) {
      continue; // the older vary trigger already names this exact lift
    }
    reasons.push(`${play.title}: ${play.adaptations?.[0] || play.why}`);
    sigParts.push(`playbook:${play.kind}:${play.exercise || play.title}`);
  }
  if (playbook?.adherence && playbook.adherence.status !== "clear") {
    reasons.push(
      `${playbook.adherence.pattern} Suggest a smaller or shorter template instead of letting the plan silently fail.`
    );
    sigParts.push(
      `adherence:${playbook.adherence.status}:${playbook.adherence.missed_planned_sessions}:${playbook.adherence.skipped_exercises}`
    );
  }

  // (3) A muscle group running UNDER its productive volume range (or untrained
  //     lately) — a weak point worth building toward. Only fires for an athlete
  //     with real training history (else a blank new plan reads everything "due").
  let bal = opts.balance;
  if (bal === undefined) {
    try {
      bal = programBalance(2, date);
    } catch {
      bal = undefined;
    }
  }
  const dueGroups = [...(Array.isArray(bal?.due) ? bal!.due : [])].sort();
  if (dueGroups.length && (hasHistory || wantsVary.length || twDue)) {
    reasons.push(
      `${dueGroups.slice(0, 3).join(", ")} ${dueGroups.length === 1 ? "is" : "are"} under-trained — worth building up.`
    );
    sigParts.push(`due:${dueGroups.join(",")}`);
  }

  if (twDue) {
    const keys = Array.isArray(tw?.key_lifts) ? tw!.key_lifts.slice(0, 2) : [];
    reasons.push(`A re-test is due${keys.length ? ` (${keys.join(", ")})` : ""}.`);
    sigParts.push("test:1");
  }

  return { due: reasons.length > 0, reasons, signature: sigParts.join("|") };
}
