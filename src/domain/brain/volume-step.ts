// ============================================================================
// volume-step.ts — when the log has earned it, the coach adds ONE set, and says so.
//
// Until now the coach never raised weekly volume on its own initiative: every set raise was
// a floor fill (coverage-change.ts, plan-coverage.ts) or a catch-up toward sets the athlete
// had already logged (progression.ts setCatchUp), and a strong tolerance read
// (volume-tolerance.ts) only STOPPED trims. The evidence base: hypertrophy shows a
// dose-response to weekly sets with diminishing returns past roughly twenty a group;
// increases individualised to about a fifth over a person's own prior volume beat a fixed
// prescription; and in an energy deficit volume is not added. So this is the other half:
// when muscle or strength is a stated priority, every planned set has been carried at a held
// or rising load, the lifts are moving, and nothing is protecting the athlete, ONE group's
// week gets ONE more set on ONE lift it already has — and then it waits until that was
// trained twice.
//
// It edits a real person's plan by itself, so when in doubt it does nothing. It mirrors the
// coverage change in structure (coverage-change.ts) and reuses its reads rather than
// restating them:
//   - the SAME holds: coverage's weekHold + protectiveHold (an affirmed cut, cut pressure,
//     under-fuelling protection, an owed volume restore, a plan adaptation, a recovery week
//     drafted or upcoming or running, deload or deload-due, the race taper, post-race days, a
//     trip, a realization week) stop it. Those two functions are private to plan-coverage.ts
//     and answer null when no coverage gap stands, so a small copy lives here, built from the
//     same exported predicates; a test holds it to coverage's own codes;
//   - fail-closed reads: any read that throws makes the pass `unavailable` and changes
//     nothing, withdraws nothing;
//   - ONE change in flight, routed through the ORDINARY autonomy path
//     (applyProposalWithAutonomy, no requested tier). A one-set raise on a lift already in the
//     plan is a bounded, reversible `training_target`: quiet_apply under lead, announce under
//     announce_first, ask (one held draft) under review_everything. Whatever lands carries the
//     server-owned Undo and each touched lift's completion expectation;
//   - the athlete's NO is remembered per group: a held draft set aside, an announced change
//     held, a landed change undone — until their training intent changes or six weeks pass.
//     A gap or change the person authored (coverage_person_kept_v1) and a coverage change they
//     undid are theirs too (coverageAnswers).
//
// THE RULE — every condition required:
//   1. Intent: muscle or strength is a stated priority (readVolumeFloorContext, the volume
//      floor's own reading), endurance not the primary role.
//   2. One step a pass, one group a calendar week: plus ONE set on ONE lift already in the
//      plan, in the group with the strongest case. The ranking (rankVolumeStepGroups): the
//      group furthest below its own bound relative to its productive range — headroom =
//      (bound - planned) / (bound - low), bound = min(the group's landmark high, twenty
//      effective sets) and low = its landmark low — largest first, ties by plan order (the
//      group whose first lift comes earliest in the plan). A group under its floor is
//      coverage's, never this pass's. Within the group the first lift in plan order that
//      can honestly step takes the set.
//   3. The lift has a habit on record (habitualWorkingSetCountBefore) and room: one set
//      above that habit, never past five working sets (LIFT_STEP_CAP). The proportional bound
//      is the GROUP's: after the step its planned weekly sets are at most ceil(1.2 x the
//      group's habitual weekly effective sets over the same 56-day window, none on record
//      meaning no step) and at most twenty (weeklyGroupHasRoom) — `group_habit_bound`.
//   4. Tolerance vouches: volumeToleranceRead (every authored set carried at a held-or-rising
//      load), and the last fourteen days harm-free on the days the group was trained
//      (harmEvidenceOnDay — never re-derived). The group's PROGRESS is read per movement
//      unit (the capability read in program state, capability-consumers.ts
//      volumeStepUnitRead): no in-plan unit carrying the group may be slipping (more volume
//      is the wrong lever for a slide), no lift of the group may be plateaued and grinding
//      (recovery is not keeping up), and the group earns the set only through an in-plan
//      unit HOLDING on enough evidence (VOLUME_STEP_MIN_UNIT_EXPOSURES) with no cut, run
//      build or lighter week explaining it — a climbing unit needs nothing. The set goes to
//      a plan lift of that holding unit. Added volume helps a plateau only when recovery is
//      adequate, never a regression.
//   5. Settling: the group's previous volume step (and any coverage change on it) has been
//      trained at least twice since it landed — or six weeks passed — and, for a volume step
//      (which may sit above the habit), those first two sessions carried every written set of
//      the lift at a held-or-risen load; if either fell short the group does not step again
//      (`step_not_carried`, status settling). The earlier step is never reverted from here.
//   6. Holds, and lift-level exclusions: open pain or an injury the lift loads, a constraint
//      note, a slot nothing has been trained at since it was written (testedSlotAuthorship),
//      today's session already composed on that plan day, and a plateau-ladder change on the
//      lift that is open or landed this week (lift-structural-change.ts: one server-owned
//      structural change per lift per week, whichever came first — re-checked at landing).
//   7. Any read failing means `unavailable` and nothing changes.
//
// The landing waits for a natural boundary: never into a session already started
// (autonomy-service.ts quietApplyMustWait, for every change) — and never into one composed on
// the lift's plan day: coverageMustWait recognises only coverage's agent, so this pass holds
// such a lift itself (`session_composed`) until it is wired there.
//
// Calm: no scores, nothing pushed; the words are variant sets (pickDayVariant), numbers are
// words, and Undo puts the week back.
// ============================================================================
import crypto from "node:crypto";
import { db } from "../../db.js";
import { mondayOf } from "../../lib/dates.js";
import { harmEvidenceOnDay } from "../../repo/brain/read-adherence.js";
import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import { resolvedBlockPhase } from "../../repo/block-phase.js";
import { cutReaffirmation } from "../../repo/cut-target.js";
import { normalizedExerciseKey, progressionLineageIds, resolveExerciseName } from "../../repo/exercise-canon.js";
import { injuryAffectsExercise, listContextEvents } from "../../repo/health.js";
import { primaryMuscleGroup } from "../../repo/muscle-credit.js";
import { painBandForMovement } from "../../repo/pain-band.js";
import { activePlanAdaptations } from "../../repo/plan-adaptations.js";
import { getPlan } from "../../repo/plan.js";
import {
  COVERAGE_AGENT,
  coverageAnswers,
  coverageChangeRows,
  coverageOfferStillFits,
  type CoverageBasisEntry,
  type CoverageHoldReason,
} from "../../repo/plan-coverage.js";
import { type PlanQualityDay, plannedWeeklyGroupSets } from "../../repo/plan-quality.js";
import { latestLiftExposure, latestWorkingSets, testedSlotAuthorship } from "../../repo/prescription-authorship.js";
import {
  cutPressureRefusesSetIncrease,
  enduranceCarriedGroups,
  fuelReadLeavesTrainingAlone,
  habitualWorkingSetCountBefore,
  readCutPressureStrict,
} from "../../repo/progression.js";
import { activeCompositionPlanDayNumber } from "../../repo/adaptive-session.js";
import { createProposal, getProposal, setProposalStatus } from "../../repo/proposals.js";
import { getProgramState } from "../../repo/program-state.js";
import { type ProgramCapability, volumeStepUnitRead } from "../../repo/capability-consumers.js";
import { capabilityUnitOf } from "../../repo/strength-capability.js";
import { otherStructuralChangeOnLift, STRUCTURAL_CHANGE_AGENTS } from "../../repo/lift-structural-change.js";
import { inRaceRecovery } from "../../repo/race-recovery.js";
import { recoveryWeekStatus } from "../../repo/recovery-week.js";
import { effectiveVolumeByGroup, type VolumeSet } from "../../repo/exercise-variations.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "../../repo/shared.js";
import { activeRelevantTrainingSymptoms } from "../../repo/training-symptoms.js";
import { tripEventOn } from "../../repo/travel-days.js";
import { currentUnderfuelingRead } from "../../repo/underfueling-snapshot.js";
import { readVolumeFloorContext } from "../../repo/volume-floor-context.js";
import { type VolumeFloorContext, weeklySetTargets } from "../../repo/volume-floor.js";
import { openVolumeRestoreTargets } from "../../repo/volume-guard.js";
import {
  habitualSetCount,
  VOLUME_BOUNDS,
  volumeToleranceRead,
  weeklyGroupHasRoom,
} from "../../repo/volume-tolerance.js";
import { weeklyGroupEffectiveSets } from "../../repo/weekly-dose-ledger.js";
import { applyProposalWithAutonomy, registerServerPremise } from "./autonomy-service.js";

/** The source every volume-step draft is written under (plan_proposals.agent; stored rows key on it). */
export const VOLUME_STEP_AGENT = "volume-step";
/** The single instruction those drafts carry. Never `auto:`/`chat:` — no orphan sweep adopts it. */
export const VOLUME_STEP_INSTRUCTION = "volume: the log carries more than the plan asks";

// The most working sets of one lift a step may reach, whatever the habit says. A lift's
// ceiling is min(this, habit + 1): ONE set above what the athlete habitually does on that
// lift. perLiftSetCeiling's floor(1.2 x habit) is deliberately NOT used here: at the habits
// that matter (three to five sets) it rounds back down to the habit itself, so a step could
// never rise above it. One set is the smallest possible step; the proportional (~1.2x) bound
// is held at the GROUP (groupHabitBoundHolds), where a single set is a small fraction.
const LIFT_STEP_CAP = 5;
// A no is remembered, and a step is "settling", for this long at most (six weeks).
const REMEMBER_DAYS = 42;
// A step is settled once every lift it touched was trained this many times since it landed.
const SETTLE_SESSIONS = 2;
// The harm look-back: the days the group was trained inside this many days before the read.
const HARM_LOOKBACK_DAYS = 14;

// ---- types --------------------------------------------------------------------------

/** Why one group or lift is set aside this pass (VolumeStepOutcome.blocked). */
export type VolumeStepBlock =
  | "pain"
  | "injury"
  | "constraint_note"
  // A movement unit carrying the group is slipping (capability read): more volume is the
  // wrong lever for a slide.
  | "unit_slipping"
  | "plateau_grinding"
  | "recent_harm"
  | "untested_slot"
  | "session_composed"
  // The plateau ladder has an open change on this lift, or one landed this calendar week:
  // one server-owned structural change per lift per week (lift-structural-change.ts).
  | "lift_changed_this_week"
  | "declined"
  | "step_not_carried"
  | "settling"
  | "at_ceiling"
  | "weekly_bound"
  | "group_habit_bound"
  // The group's units are climbing (they need nothing), held by the cut / run build /
  // lighter week, or not read yet; or this lift's unit is not the holding one.
  | "unit_climbing"
  | "unit_explained"
  | "unit_unread"
  | "unit_not_holding"
  | "no_habit"
  | "below_floor"
  | "timed_lift"
  | "no_lift";

/** Why nothing new is changed this pass when the whole pass is held. */
export type VolumeStepHold = CoverageHoldReason | VolumeStepBlock | "tolerance_unproven" | "week_used";

export interface VolumeStepOutcome {
  /**
   * none: nothing honest to do (no intent, no group with a habit and room); held: a hold
   * (the `hold` code) — nothing new; settling: the group's last step has not been trained
   * twice; declined: the athlete said no to every group that qualified; standing: a step is
   * already in flight (open draft); routed: a new step was routed and policy let it act or
   * held it for a yes (`tier`); unavailable: a read failed — nothing changed; would_route: a
   * dry run — what an acting pass would route; deferred: an act:false caller.
   */
  status:
    | "none"
    | "held"
    | "settling"
    | "declined"
    | "standing"
    | "routed"
    | "unavailable"
    | "would_route"
    | "deferred";
  hold?: VolumeStepHold;
  group: string | null;
  lift: string | null;
  day_number: number | null;
  from_sets: number | null;
  to_sets: number | null;
  /** Every group or lift set aside this pass, with the code (a dry run reads it too). */
  blocked: Array<{ group: string; lift?: string; code: VolumeStepBlock }>;
  tier: string | null;
  proposal_id: number | null;
  decision_id: number | null;
  effective_date: string | null;
  summary: string | null;
  explanation: string | null;
  /** True when policy held the routed step for the athlete's yes (review_everything). */
  asked?: boolean;
  /** Open drafts withdrawn quietly because their premise went. */
  withdrawn: number[];
}

/** What a routed volume step stands on now (volumeStepStillFits) — the serverPremise vocabulary. */
export type VolumeStepPremise = "fits" | "gone" | "held" | "unknown";

function outcome(status: VolumeStepOutcome["status"], extra: Partial<VolumeStepOutcome> = {}): VolumeStepOutcome {
  return {
    status,
    group: null,
    lift: null,
    day_number: null,
    from_sets: null,
    to_sets: null,
    blocked: [],
    tier: null,
    proposal_id: null,
    decision_id: null,
    effective_date: null,
    summary: null,
    explanation: null,
    withdrawn: [],
    ...extra,
  };
}

// ---- small private copies of plan-coverage.ts's private helpers (kept tiny) ------------

const TIMED_NAME = /\b(plank|carry|walk|hold|hang)\b/i;

function numberWord(n: number): string {
  return ["zero", "one", "two", "three", "four", "five"][n] ?? String(n);
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function strengthItems(day: any): any[] {
  return (Array.isArray(day?.items) ? day.items : []).filter(
    (item: any) =>
      item &&
      typeof item === "object" &&
      String(item.kind ?? "strength").toLowerCase() !== "cardio" &&
      String(item.exercise ?? "").trim()
  );
}

function strengthDays(plan: readonly any[]): any[] {
  return (Array.isArray(plan) ? plan : [])
    .filter((day) => String(day?.day_type ?? "training").toLowerCase() !== "rest" && strengthItems(day).length > 0)
    .sort((a, b) => Number(a.day_number) - Number(b.day_number));
}

// One lift's identity, exactly as coverageOfferStillFits compares it.
function liftIdentity(name: string): string {
  try {
    const key = resolveExerciseName(name).key;
    if (key) return key;
  } catch {
    /* fall through to the conservative key */
  }
  return `movement:${normalizedExerciseKey(name)}`;
}

function storedGroup(item: any): string | null {
  return item?.muscle_group == null ? null : String(item.muscle_group);
}

function storedExerciseRow(name: string): any | null {
  const id = resolveExerciseName(name).exercise_id;
  return id == null
    ? null
    : (db.prepare(`SELECT id, muscle_group, mode, constraint_note FROM exercises WHERE id = ?`).get(id) as any);
}

// The open injuries as one predicate: does this lift load any of them? Throws when the read
// fails (fail closed).
function openInjuryLoads(date: string): (name: string, group: string | null) => boolean {
  const injuries = (listContextEvents({ activeOnly: true, on: date }) as any[]).filter((e) => e?.kind === "injury");
  return (name, group) => injuries.some((injury) => injuryAffectsExercise(injury, { name, muscle_group: group }));
}

// Pain reported in words, and stated pain on the lift itself in the pain band's window.
function painTouches(date: string): (name: string, group: string | null) => boolean {
  return (name, group) => {
    if (activeRelevantTrainingSymptoms(date, { name, muscle_group: group }, { seed_legacy: false }).length > 0)
      return true;
    const row = storedExerciseRow(name);
    return (
      painBandForMovement({ id: row?.id ?? null, name, muscle_group: group ?? row?.muscle_group ?? null }, date) != null
    );
  };
}

// The athlete's intent as the floor reads it, and the gap fingerprint coverage keys a "no"
// on (plan-coverage.ts fingerprint/intentKey) — the same value, so coverageAnswers answers.
function intentKey(ctx: VolumeFloorContext): string {
  return `strength:${ctx.strength_priority ? 1 : 0}|muscle:${ctx.muscle_priority ? 1 : 0}`;
}

function groupFingerprint(group: string, ctx: VolumeFloorContext): string {
  return crypto
    .createHash("sha1")
    .update(["group", group, intentKey(ctx)].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

// ---- the holds ----------------------------------------------------------------------

// Coverage's protectiveHold, through the same exported predicates.
function protectiveHold(today: string): CoverageHoldReason | null {
  if (!fuelReadLeavesTrainingAlone(currentUnderfuelingRead(today))) return "fuel_protection";
  const cut = readCutPressureStrict(today);
  if (cutPressureRefusesSetIncrease(cut) || cut.sliding) return "cut_pressure";
  if (openVolumeRestoreTargets().length > 0) return "volume_restore";
  if (activePlanAdaptations(today).length > 0) return "plan_adaptation";
  return null;
}

// Coverage's weekHold, plus what coverage need not say: a recovery week DRAFTED or
// upcoming (the floor context only sees a scheduled one), and a strength-led taper (coverage
// trims only its legs; no volume is ADDED anywhere in a taper). A read that throws throws.
function volumeStepWeekHold(today: string, ctx: VolumeFloorContext): CoverageHoldReason | null {
  if (ctx.exempt) return ctx.exempt;
  if (ctx.race_trimmed?.length) return "race_taper";
  if (resolvedBlockPhase(today) === "realization") return "realization_phase";
  // Any running cut holds it, re-affirmed or with its check-in still open: in an energy
  // deficit volume is never added. (Coverage's copy keys on the affirmation because it only
  // fills a floor; this adds above the habit.)
  if (cutReaffirmation(today).source !== "not_a_cut") return "affirmed_cut";
  if (inRaceRecovery(today)) return "post_race";
  if (tripEventOn(today) != null) return "trip";
  if (recoveryWeekStatus(today) != null) return "recovery_week";
  return protectiveHold(today);
}

// ---- the ranking --------------------------------------------------------------------

export interface VolumeStepGroupFacts {
  group: string;
  /** The week's counted sets for the group as the plan is written. */
  planned: number;
  /** The group's landmark low and high (volume-floor.ts weeklySetTargets). */
  low: number;
  high: number;
  /** Where the group's first lift sits in the plan (day, then position): the tie-break. */
  order: number;
}

/** The weekly bound for a group: its landmark high, never past VOLUME_BOUNDS' twenty. */
export function volumeStepBound(high: number): number {
  return Math.min(high, VOLUME_BOUNDS.WEEKLY_EFFECTIVE_SETS_PER_GROUP);
}

/**
 * Which group has the strongest case. A group already at its bound has no room and is left
 * out; the rest rank by headroom = (bound - planned) / (bound - low), largest first — the
 * share of its productive range still unused — and ties by plan order. Pure.
 */
export function rankVolumeStepGroups(groups: readonly VolumeStepGroupFacts[]): VolumeStepGroupFacts[] {
  const headroom = (g: VolumeStepGroupFacts) => {
    const bound = volumeStepBound(g.high);
    return (bound - g.planned) / Math.max(1, bound - g.low);
  };
  return groups
    .filter((g) => volumeStepBound(g.high) - g.planned > 1e-9)
    .map((g) => ({ g, h: headroom(g) }))
    .sort((a, b) => b.h - a.h || a.g.order - b.g.order)
    .map((x) => x.g);
}

// Which blocks are said out loud (a hold code), and which are only "nothing honest to do".
// Higher in the list wins when several groups are set aside for different reasons, so the
// reason a person would care about is the one reported.
const BLOCK_PRECEDENCE: readonly VolumeStepBlock[] = [
  "pain",
  "injury",
  "constraint_note",
  "unit_slipping",
  "plateau_grinding",
  "recent_harm",
  "untested_slot",
  "session_composed",
  "lift_changed_this_week",
  "declined",
  "step_not_carried",
  "settling",
  "at_ceiling",
  "weekly_bound",
  "group_habit_bound",
  "unit_explained",
  "unit_climbing",
  "unit_not_holding",
  "unit_unread",
  "no_habit",
  "below_floor",
  "timed_lift",
  "no_lift",
];
const QUIET_BLOCKS: ReadonlySet<VolumeStepBlock> = new Set([
  "at_ceiling",
  "weekly_bound",
  "group_habit_bound",
  "unit_explained",
  "unit_climbing",
  "unit_not_holding",
  "unit_unread",
  "no_habit",
  "below_floor",
  "timed_lift",
  "no_lift",
]);

// ---- the athlete's answers, and the log of steps -------------------------------------

const LINKED_DECISION = `d.source_ref_type = 'plan_proposal' AND d.source_ref_key = CAST(p.id AS TEXT)`;
const HELD_BY_USER = `EXISTS (SELECT 1 FROM brain_decisions d WHERE ${LINKED_DECISION}
  AND d.status = 'canceled' AND json_extract(d.context_json, '$.held_by_user') = 1)`;
const UNDONE = `EXISTS (SELECT 1 FROM brain_decisions d WHERE ${LINKED_DECISION} AND d.status = 'reverted')`;

interface StepRow {
  id: number;
  status: string;
  /** open: still a draft; yes: it landed and stands; no: the athlete said no to it. */
  answer: "open" | "yes" | "no";
  group: string;
  intent: string;
  created: string;
}

// created_at is SQLite's UTC datetime('now'); the pass compares it with the athlete's local
// day, so it is read as a UTC instant and dated locally (late in the evening west of UTC the
// raw slice was already tomorrow, and "one group a calendar week" missed today's step).
function localCreatedDay(createdAt: unknown): string {
  const raw = String(createdAt ?? "").trim();
  const instant = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw)
    ? new Date(`${raw.replace(" ", "T")}${/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? "" : "Z"}`)
    : null;
  return instant && Number.isFinite(instant.getTime()) ? localDateISO(instant) : raw.slice(0, 10);
}

/** Every volume-step draft that is open or answered, newest first. Null when the read failed. */
function volumeStepRows(): StepRow[] | null {
  try {
    const rows = db
      .prepare(
        `SELECT p.id AS id, p.status AS status, p.parsed_json AS parsed_json, p.created_at AS created_at,
                ${HELD_BY_USER} AS held_by_user, ${UNDONE} AS undone
           FROM plan_proposals p
          WHERE p.agent = ?
            AND (p.status IN ('draft', 'applied', 'discarded', 'rejected') OR (p.status = 'superseded' AND ${HELD_BY_USER}))
          ORDER BY p.id DESC LIMIT 80`
      )
      .all(VOLUME_STEP_AGENT) as any[];
    return rows.map((row) => {
      let parsed: any = null;
      try {
        parsed = row.parsed_json ? JSON.parse(String(row.parsed_json)) : null;
      } catch {
        parsed = null;
      }
      const status = String(row.status ?? "");
      const answer: StepRow["answer"] =
        status === "draft"
          ? "open"
          : status === "discarded" ||
              status === "rejected" ||
              Number(row.held_by_user) === 1 ||
              Number(row.undone) === 1
            ? "no"
            : "yes";
      return {
        id: Number(row.id),
        status,
        answer,
        group: String(parsed?.volume_step?.group ?? ""),
        intent: String(parsed?.volume_step?.intent ?? ""),
        created: localCreatedDay(row.created_at),
      };
    });
  } catch {
    return null;
  }
}

// A step (this agent's or a coverage change) that LANDED and may still be settling: the
// group it touched, the lifts, the day it landed.
interface LandedStep {
  groups: string[];
  lifts: string[];
  landed: string;
  /** A volume step's own lift and written set count (null for a coverage change). */
  own: { lift: string; to: number } | null;
}

function landedSteps(): LandedStep[] | null {
  try {
    const rows = db
      .prepare(
        `SELECT d.effective_date AS effective_date, d.created_at AS decided_at, p.created_at AS created_at,
                p.agent AS agent, p.parsed_json AS parsed_json
           FROM plan_proposals p
           JOIN brain_decisions d ON ${LINKED_DECISION}
          WHERE p.agent IN (?, ?) AND p.status = 'applied' AND d.status = 'applied'
          ORDER BY d.id DESC LIMIT 24`
      )
      .all(VOLUME_STEP_AGENT, COVERAGE_AGENT) as any[];
    const out: LandedStep[] = [];
    for (const row of rows) {
      let parsed: any = null;
      try {
        parsed = JSON.parse(String(row.parsed_json ?? "null"));
      } catch {
        parsed = null;
      }
      const groups: string[] =
        row.agent === VOLUME_STEP_AGENT
          ? [String(parsed?.volume_step?.group ?? "")].filter(Boolean)
          : (Array.isArray(parsed?.coverage_gap?.elements) ? parsed.coverage_gap.elements : [])
              .map((el: any) => String(el?.key ?? ""))
              .filter((key: string) => key.startsWith("group:"))
              .map((key: string) => key.slice("group:".length));
      const lifts: string[] = (Array.isArray(parsed?.changes) ? parsed.changes : [])
        .map((change: any) => String(change?.exercise ?? "").trim())
        .filter(Boolean);
      const landed = String(row.effective_date ?? row.decided_at ?? row.created_at ?? "").slice(0, 10);
      const own =
        row.agent === VOLUME_STEP_AGENT && parsed?.volume_step?.lift && Number.isFinite(Number(parsed?.volume_step?.to))
          ? { lift: String(parsed.volume_step.lift), to: Number(parsed.volume_step.to) }
          : null;
      if (groups.length && lifts.length && landed) out.push({ groups, lifts, landed, own });
    }
    return out;
  } catch {
    return null;
  }
}

// How many separate sessions of the lift (its whole lineage) were logged on or after `since`.
function sessionsSince(lift: string, since: string): number {
  const ids = progressionLineageIds(lift);
  if (!ids.length) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT s.id) AS n FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE ls.exercise_id IN (${ids.map(() => "?").join(",")}) AND ls.reps IS NOT NULL AND ls.reps > 0 AND s.date >= ?`
    )
    .get(...ids, since) as any;
  return Number(row?.n ?? 0);
}

// The lift's logged sessions (its whole lineage) as { date, sets, top }: working sets are the
// sets within 90% of the session's heaviest load (a ramp-up warm-up never counts), top is that
// heaviest signed load (an assisted lift's negative weight compares as is; bodyweight is 0).
function liftSessions(
  lift: string,
  where: string,
  arg: string,
  order: "ASC" | "DESC"
): Array<{ sets: number; top: number }> {
  const ids = progressionLineageIds(lift);
  if (!ids.length) return [];
  const rows = db
    .prepare(
      `SELECT s.id AS session_id, ls.weight AS weight FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE ls.exercise_id IN (${ids.map(() => "?").join(",")}) AND ls.reps IS NOT NULL AND ls.reps > 0 AND ${where}
        ORDER BY s.date ${order}, s.id ${order}`
    )
    .all(...ids, arg) as Array<{ session_id: number; weight: number | null }>;
  const bySession = new Map<number, number[]>();
  for (const row of rows) {
    const list = bySession.get(Number(row.session_id)) ?? [];
    list.push(row.weight == null ? 0 : Number(row.weight));
    bySession.set(Number(row.session_id), list);
  }
  return [...bySession.values()].map((loads) => {
    const top = Math.max(...loads);
    const band = top > 0 ? top * 0.9 : top < 0 ? top * 1.1 : 0;
    return { sets: loads.filter((w) => w >= band - 1e-9).length, top };
  });
}

/**
 * Did the two sessions that tested a landed volume step (the first two since it landed)
 * carry every written set of the stepped lift, at a load held or risen against the last
 * session before it landed? A step that sits above the athlete's habit is only a step if
 * he can carry it; a session that fell short is the log saying it was too much.
 */
function stepWasCarried(own: { lift: string; to: number }, landed: string): boolean {
  const since = liftSessions(own.lift, "s.date >= ?", landed, "ASC").slice(0, SETTLE_SESSIONS);
  const before = liftSessions(own.lift, "s.date < ?", landed, "DESC")[0];
  return since.every((s) => s.sets >= own.to && (before == null || s.top >= before.top - 1e-9));
}

/**
 * The groups whose last landed step (this agent's or a coverage change on them) has not been
 * trained SETTLE_SESSIONS times on every lift it touched (`settling`), and the groups whose
 * last volume step WAS trained twice but not carried (`notCarried`); each is younger than
 * REMEMBER_DAYS. A step that was not carried is never reverted from here (the set catch-up and
 * trim paths own that); it only stops the next one. Null when a read failed.
 */
function settlingGroups(date: string): { settling: Set<string>; notCarried: Set<string> } | null {
  const steps = landedSteps();
  if (!steps) return null;
  try {
    const horizon = addDaysISO(date, -REMEMBER_DAYS) ?? date;
    const settling = new Set<string>();
    const notCarried = new Set<string>();
    for (const step of steps) {
      if (step.landed < horizon) continue;
      if (step.groups.every((g) => settling.has(g) || notCarried.has(g))) continue;
      const settled = step.lifts.every((lift) => sessionsSince(lift, step.landed) >= SETTLE_SESSIONS);
      if (!settled) {
        for (const g of step.groups) settling.add(g);
      } else if (step.own && !stepWasCarried(step.own, step.landed)) {
        for (const g of step.groups) notCarried.add(g);
      }
    }
    return { settling, notCarried };
  } catch {
    return null;
  }
}

/**
 * The group's HABITUAL weekly effective sets: the median of the non-empty seven-day windows
 * in the HABITUAL_WINDOW_DAYS (56) before `date` — the window the per-lift habit reads —
 * counted the ledger's way (effectiveVolumeByGroup: warm-ups out, reserve-weighted, a real
 * second mover's share in). Null below HABITUAL_MIN_SESSIONS such weeks: no habit on record.
 * Throws when the read fails.
 */
export function groupHabitualWeeklySets(group: string, date: string): number | null {
  const from = addDaysISO(date, -VOLUME_BOUNDS.HABITUAL_WINDOW_DAYS);
  if (!from) return null;
  const rows = db
    .prepare(
      `SELECT s.date AS date, e.name AS exercise, e.muscle_group AS muscle_group,
              ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
         FROM logged_sets ls
         JOIN sessions s ON s.id = ls.session_id
         JOIN exercises e ON e.id = ls.exercise_id
        WHERE s.date >= ? AND s.date < ? AND ls.reps IS NOT NULL AND ls.reps > 0`
    )
    .all(from, date) as any[];
  const windows = new Map<number, any[]>();
  for (const row of rows) {
    const back = Math.floor(((daysBetweenISO(date, String(row.date).slice(0, 10)) ?? 1) - 1) / 7);
    const list = windows.get(back) ?? [];
    list.push(row);
    windows.set(back, list);
  }
  const weekly: number[] = [];
  for (const list of windows.values()) {
    const sets = effectiveVolumeByGroup(list as VolumeSet[]).get(group as any)?.sets ?? 0;
    if (sets > 0) weekly.push(sets);
  }
  return weekly.length < VOLUME_BOUNDS.HABITUAL_MIN_SESSIONS ? null : habitualSetCount(weekly);
}

/**
 * The group bound: after one more set the group's PLANNED week (counted sets) may be at most
 * ceil(1.2 x its own habitual weekly effective sets) — the proportional bound the per-lift
 * step does not carry — and still within the twenty-set bound. No habit on record: no step.
 */
function groupHabitBoundHolds(group: string, planned: number, date: string): boolean {
  const habit = groupHabitualWeeklySets(group, date);
  if (habit == null) return false;
  const bound = Math.ceil(habit * VOLUME_BOUNDS.PER_LIFT_HABITUAL_FACTOR - 1e-9);
  return planned + 1 <= bound + 1e-9 && weeklyGroupHasRoom(planned, 1);
}

// ---- tolerance, and the lifts ---------------------------------------------------------

// The days in the last HARM_LOOKBACK_DAYS the group was trained, each asked harmEvidenceOnDay
// (never re-derived). True when none of them reads as harm. Throws when a read fails.
function groupHarmFree(group: string, date: string): boolean {
  const from = addDaysISO(date, -HARM_LOOKBACK_DAYS) ?? date;
  const rows = db
    .prepare(
      `SELECT s.date AS date, e.name AS name, e.muscle_group AS muscle_group
         FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id JOIN exercises e ON e.id = ls.exercise_id
        WHERE s.date >= ? AND s.date < ? AND (ls.reps IS NOT NULL AND ls.reps > 0)
        GROUP BY s.date, e.id`
    )
    .all(from, date) as any[];
  const days = new Set<string>();
  for (const row of rows) {
    if (primaryMuscleGroup(String(row.name), row.muscle_group == null ? null : String(row.muscle_group)) === group) {
      days.add(String(row.date).slice(0, 10));
    }
  }
  for (const day of days) if (harmEvidenceOnDay(day) != null) return false;
  return true;
}

// What the program state says about the group's movement: the capability summary (progress
// per movement unit and muscle) and the in-rotation lifts' grinding tells. Read once a pass.
// A read that throws throws (fail closed); an unavailable capability read earns nothing.
interface ProgressReads {
  capability: ProgramCapability | null;
  /** In-rotation lifts (never a resting one) whose own log reads plateaued and grinding. */
  grinding: Array<{ group: string | null }>;
}

function progressReads(date: string): ProgressReads {
  const state = getProgramState(date);
  return {
    capability: state.capability ?? null,
    grinding: (state.lifts ?? [])
      .filter(
        (lift: any) =>
          lift?.resting !== true &&
          lift?.status === "plateaued" &&
          (Array.isArray(lift.stall_signals) ? lift.stall_signals : []).some((s: unknown) => /grinding/i.test(String(s)))
      )
      .map((lift: any) => ({
        group: primaryMuscleGroup(String(lift.exercise), lift.muscle_group == null ? null : String(lift.muscle_group)),
      })),
  };
}

// The group's condition, over MOVEMENT UNITS (capability-consumers.ts volumeStepUnitRead):
// a slipping unit carrying the group blocks it (more volume is the wrong lever for a
// slide); the group earns a set only through an in-plan unit HOLDING on enough evidence
// with no cut, run build or lighter week to explain it — a climbing unit needs nothing.
// Beside it, one recovery tell kept from the lifts: a lift of the group plateaued AND
// grinding says recovery is not keeping up, and added volume helps a plateau only when it
// is. Returns the block and the units that may take the set.
function groupProgressBlock(group: string, reads: ProgressReads): { block: VolumeStepBlock | null; earning: string[] } {
  const unit = volumeStepUnitRead(reads.capability, group);
  if (unit.block === "unit_slipping") return { block: "unit_slipping", earning: [] };
  if (reads.grinding.some((r) => r.group === group)) return { block: "plateau_grinding", earning: [] };
  return { block: unit.block, earning: unit.earning };
}

// The movement unit a plan lift belongs to (the capability read's own identity), or null.
function planLiftUnit(lift: PlanLift): string | null {
  try {
    const resolved = resolveExerciseName(lift.exercise);
    const row = storedExerciseRow(lift.exercise);
    const group = lift.stored_group ?? (row?.muscle_group == null ? null : String(row.muscle_group));
    return capabilityUnitOf(resolved.canonical || lift.exercise, group)?.key ?? null;
  } catch {
    return null;
  }
}

interface PlanLift {
  day_number: number;
  day_name: string;
  exercise: string;
  sets: number;
  note: string;
  stored_group: string | null;
}

// The lifts of a group in the plan, in plan order (day, then position).
function planLifts(days: readonly any[], group: string): PlanLift[] {
  const out: PlanLift[] = [];
  const seen = new Set<string>();
  for (const day of days) {
    for (const item of strengthItems(day)) {
      if (primaryMuscleGroup(String(item.exercise), storedGroup(item)) !== group) continue;
      const sets = Number(item.sets);
      if (!Number.isInteger(sets) || sets <= 0) continue;
      const key = `${day.day_number}|${liftIdentity(String(item.exercise))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        day_number: Number(day.day_number),
        day_name: String(day.name ?? "").trim() || `day ${day.day_number}`,
        exercise: String(item.exercise),
        sets,
        note: String(item.constraint_note ?? "").trim(),
        stored_group: storedGroup(item),
      });
    }
  }
  return out;
}

// Nothing has been trained at this slot since it was written: its prescription stands as a hold.
function slotUntested(lift: PlanLift, date: string): boolean {
  const id = resolveExerciseName(lift.exercise).exercise_id;
  if (id == null) return false;
  const row = db
    .prepare(
      `SELECT pi.prescribed_at AS prescribed_at, pi.target_weight AS target_weight, pi.rep_low AS rep_low, pi.sets AS sets
         FROM plan_items pi JOIN plan_days pd ON pd.id = pi.plan_day_id
        WHERE pd.day_number = ? AND pi.exercise_id = ? LIMIT 1`
    )
    .get(lift.day_number, id) as any;
  if (!row) return false;
  const exposure = latestLiftExposure(lift.exercise);
  return testedSlotAuthorship(
    row.prescribed_at,
    exposure,
    { weight: row.target_weight, rep_low: row.rep_low, sets: row.sets },
    () => latestWorkingSets(lift.exercise, row.rep_low),
    date
  ).untested;
}

interface LiftVerdict {
  block: VolumeStepBlock | null;
  to?: number;
}

// Can this lift honestly take one more set today? Reads that fail throw (fail closed).
function judgeLift(
  lift: PlanLift,
  date: string,
  earning: ReadonlySet<string>,
  loads: { injury: (n: string, g: string | null) => boolean; pain: (n: string, g: string | null) => boolean },
  composedDay: number | null
): LiftVerdict {
  const row = storedExerciseRow(lift.exercise);
  if (row?.mode === "timed" || TIMED_NAME.test(lift.exercise)) return { block: "timed_lift" };
  if (lift.note || String(row?.constraint_note ?? "").trim()) return { block: "constraint_note" };
  const group = lift.stored_group ?? (row?.muscle_group == null ? null : String(row.muscle_group));
  if (loads.pain(lift.exercise, group)) return { block: "pain" };
  if (loads.injury(lift.exercise, group)) return { block: "injury" };
  if (composedDay != null && composedDay === lift.day_number) return { block: "session_composed" };
  // One server-owned structural change per lift per week: the plateau ladder's open or
  // landed-this-week change on this lift came first.
  if (otherStructuralChangeOnLift([lift.exercise], date, { self: STRUCTURAL_CHANGE_AGENTS.volume_step }))
    return { block: "lift_changed_this_week" };
  if (slotUntested(lift, date)) return { block: "untested_slot" };
  // The set goes to a lift of a HOLDING unit: one whose movement is not moving with recovery
  // intact. A lift of a climbing unit (or one the read cannot place) is left as it is.
  const unit = planLiftUnit(lift);
  if (!unit || !earning.has(unit)) return { block: "unit_not_holding" };
  const habitual = habitualWorkingSetCountBefore(lift.exercise, date);
  if (habitual == null) return { block: "no_habit" };
  // One set above the habit, never past five (LIFT_STEP_CAP's comment says why not the floor).
  const ceiling = Math.min(LIFT_STEP_CAP, Math.floor(habitual + 1e-9) + 1);
  if (lift.sets >= ceiling) return { block: "at_ceiling" };
  return { block: null, to: lift.sets + 1 };
}

// ---- the words ----------------------------------------------------------------------

const SUMMARIES: ReadonlyArray<(day: string, lift: string) => string> = [
  (day, lift) => `On ${day}, one more set of ${lift}.`,
  (day, lift) => `${lift} on ${day} takes one more set.`,
  (day, lift) => `One more set of ${lift} on ${day}.`,
];

// What earned it, the acting register: the step is made, and Undo puts the week back.
const ACTS: ReadonlyArray<(group: string, lift: string) => string> = [
  (group, lift) =>
    `Every set of your ${group} work has been carried at a held or rising load lately, so ${lift} takes one more set. Undo puts the week back as you had it.`,
  (group, lift) =>
    `You have carried every planned set of your ${group} lifts at the same weight or heavier, so there is room for one more set of ${lift}. Undo takes it back out.`,
  (group, lift) =>
    // Never "recent": proposal-truth.ts re-dates that word in a stored draft into a numbered date.
    `Your sessions lately held every set at a steady or rising load, so your ${group} can take one more set of ${lift}; Undo puts it back as it was.`,
];

// The asking register: only when server policy holds the step for a yes.
const OFFERS: ReadonlyArray<(group: string, lift: string) => string> = [
  (group, lift) =>
    `Your sessions lately carried every set of your ${group} work at a held or rising load, so one more set of ${lift} would fit. It is yours to take or leave.`,
  (group, lift) =>
    `You have been carrying every planned ${group} set at the same weight or heavier; one more set of ${lift} is ready if you want it.`,
  (group, lift) =>
    `Your ${group} lifts have held up at every set lately, so one small step is ready, one more set of ${lift}, and it is your call.`,
];

/** The athlete-facing summary and why for one step. Rotates by day; names no number but the one set. */
export function volumeStepWords(
  date: string,
  group: string,
  lift: string,
  dayName: string
): { summary: string; explanation: string; ask_explanation: string } {
  const key = `${group}:${lift}`;
  return {
    summary: capitalize(pickDayVariant(SUMMARIES, date, `volume_step_summary:${key}`)(dayName, lift)),
    explanation: pickDayVariant(ACTS, date, `volume_step_act:${key}`)(group, lift),
    ask_explanation: pickDayVariant(OFFERS, date, `volume_step_ask:${key}`)(group, lift),
  };
}

/** The proposal payload a volume step is written as. */
export function volumeStepProposalPayload(
  step: {
    group: string;
    lift: PlanLift;
    to: number;
    intent: string;
  },
  date: string
): Record<string, unknown> {
  const words = volumeStepWords(date, step.group, step.lift.exercise, step.lift.day_name);
  const changes = [
    {
      day_number: step.lift.day_number,
      exercise: step.lift.exercise,
      sets: step.to,
      reason: `Your ${step.group} work has earned one more set.`,
    },
  ];
  const basis: CoverageBasisEntry[] = [
    { day_number: step.lift.day_number, identity: liftIdentity(step.lift.exercise), sets: step.lift.sets },
  ];
  return {
    summary: words.summary,
    rationale: words.explanation,
    changes,
    volume_step: {
      version: 1,
      as_of: date,
      group: step.group,
      intent: step.intent,
      lift: step.lift.exercise,
      day_number: step.lift.day_number,
      from: step.lift.sets,
      to: step.to,
      // The asking register, read only when server policy holds the step for a yes.
      explanation: words.ask_explanation,
      // The offer exactly as derived, and the plan slot it was computed against.
      offer: JSON.stringify(changes),
      basis,
    },
  };
}

// ---- the premise ----------------------------------------------------------------------

/**
 * Does a routed volume step still stand on what it was made for? `fits`: its slot still has
 * the set count it was offered against and the change only raises it, no pain or injury
 * touches it, the athlete's intent still names muscle or strength and is the one it was made
 * under, and nothing holds the week, the log still vouches (tolerance, a harm-free
 * fortnight), the step's lift still belongs to a unit that is holding with no slipping unit
 * or grinding lift in the group (the pass's own unit rule), and the group still has room.
 * `gone`: the offer or the intent went stale, or the unit is now climbing (it needs nothing). `held`: it stands but this is no week to land it. `unknown`: a read
 * failed, or the payload is too old to carry its basis. The autonomy layer checks this in
 * place of the generic evidence fingerprint (the change edits plan rows and nothing else).
 */
export function volumeStepStillFits(
  parsed: any,
  asOf: string = localDateISO(),
  ownId: number | null = null
): VolumeStepPremise {
  const step = parsed?.volume_step;
  const group = String(step?.group ?? "");
  if (!group || !Array.isArray(step?.basis) || !step.basis.length) return "unknown";
  try {
    const date = String(asOf || localDateISO()).slice(0, 10);
    const changes = Array.isArray(parsed?.changes) ? parsed.changes : [];
    const fits = coverageOfferStillFits(changes, step.basis, { date });
    if (fits === null) return "unknown";
    if (fits === false) return "gone";
    // One server-owned structural change per lift per week, whichever came first: a
    // plateau-ladder change on the lift that landed this week, or that is open and was
    // written before this step (with no id known, any open one), holds it.
    if (
      typeof step.lift === "string" &&
      otherStructuralChangeOnLift([step.lift], date, {
        self: STRUCTURAL_CHANGE_AGENTS.volume_step,
        before: ownId ?? Number.MAX_SAFE_INTEGER,
      })
    )
      return "held";
    const ctx = readVolumeFloorContext(date);
    if (!ctx) return "unknown";
    if (!(ctx.strength_priority || ctx.muscle_priority)) return "gone";
    if (String(step.intent ?? "") !== intentKey(ctx)) return "gone";
    if (volumeStepWeekHold(date, ctx)) return "held";
    if (volumeToleranceRead(date) == null) return "held";
    if (!groupHarmFree(group, date)) return "held";
    // The same unit rule the pass applies: the step's lift must still belong to a unit
    // that is holding with recovery intact. A unit now climbing needs nothing (gone); one
    // slipping, explained or unread holds the step until it is read again.
    const reads = progressReads(date);
    const progress = groupProgressBlock(group, reads);
    const liftUnit = typeof step.lift === "string" ? planLiftUnit({ exercise: step.lift, stored_group: null } as PlanLift) : null;
    const ownVerdict = reads.capability?.units.find((u) => u.key === liftUnit)?.verdict ?? null;
    if (progress.block === "unit_climbing" || ownVerdict === "climbing") return "gone";
    if (progress.block) return "held";
    if (!liftUnit || !progress.earning.includes(liftUnit)) return "held";
    if (!weeklyGroupHasRoom(weeklyGroupEffectiveSets(date, group), 1)) return "held";
    const planned = plannedWeeklyGroupSets(strengthDays(getPlan() as any[]) as PlanQualityDay[]).get(group as any) ?? 0;
    if (!groupHabitBoundHolds(group, planned, date)) return "held";
    return "fits";
  } catch {
    return "unknown";
  }
}

// ---- the pass -------------------------------------------------------------------------

function draftOutcome(
  status: VolumeStepOutcome["status"],
  proposalId: number,
  withdrawn: number[],
  extra: Partial<VolumeStepOutcome> = {}
): VolumeStepOutcome {
  const proposal = getProposal(proposalId) as any;
  const step = proposal?.parsed?.volume_step;
  const autonomy = proposal?.autonomy ?? null;
  const asked = autonomy?.status === "review";
  return outcome(status, {
    tier: autonomy?.tier ?? null,
    proposal_id: proposalId,
    decision_id: autonomy?.id ?? null,
    effective_date: autonomy?.effective_date ?? null,
    summary: typeof proposal?.parsed?.summary === "string" ? proposal.parsed.summary : null,
    explanation: asked
      ? typeof step?.explanation === "string"
        ? step.explanation
        : null
      : typeof proposal?.parsed?.rationale === "string"
        ? proposal.parsed.rationale
        : null,
    group: typeof step?.group === "string" ? step.group : null,
    lift: typeof step?.lift === "string" ? step.lift : null,
    day_number: Number.isFinite(Number(step?.day_number)) ? Number(step.day_number) : null,
    from_sets: Number.isFinite(Number(step?.from)) ? Number(step.from) : null,
    to_sets: Number.isFinite(Number(step?.to)) ? Number(step.to) : null,
    withdrawn,
    ...(asked ? { asked: true } : {}),
    ...extra,
  });
}

function withdraw(id: number, withdrawn: number[]): void {
  // Quietly: the athlete did not answer it, so it is not a "no".
  setProposalStatus(id, "superseded", { recordDecision: false });
  withdrawn.push(id);
}

function route(
  step: { group: string; lift: PlanLift; to: number; intent: string },
  date: string,
  withdrawn: number[]
): VolumeStepOutcome {
  const proposal = createProposal(
    VOLUME_STEP_AGENT,
    VOLUME_STEP_INSTRUCTION,
    "",
    volumeStepProposalPayload(step, date)
  ) as any;
  const id = Number(proposal?.id);
  if (!Number.isFinite(id) || id <= 0) return outcome("none", { withdrawn });
  // The ordinary path: no clamp, no requested tier from here. Server policy reads the
  // change's shape (a one-set raise on a lift already there is a bounded training_target)
  // and the lead mode.
  const routed = applyProposalWithAutonomy(id, {}) as any;
  if (routed?.review_required === true) return draftOutcome("routed", id, withdrawn);
  if (routed?.ok === true && routed?.superseded !== true && routed?.decision?.id != null) {
    return draftOutcome("routed", id, withdrawn, {
      tier: String(routed.tier ?? routed?.decision?.autonomy_tier ?? "") || null,
      effective_date: routed.effective_date ?? routed?.decision?.effective_date ?? null,
    });
  }
  // A routing that neither acted nor held (its premise went in the same breath, an apply the
  // plan refused) leaves nothing behind.
  if ((getProposal(id) as any)?.status === "draft") setProposalStatus(id, "superseded", { recordDecision: false });
  return outcome("none", { withdrawn });
}

function blockedStatus(
  code: VolumeStepBlock,
  blocked: VolumeStepOutcome["blocked"],
  withdrawn: number[]
): VolumeStepOutcome {
  if (code === "declined") return outcome("declined", { blocked, withdrawn });
  if (code === "settling" || code === "step_not_carried") return outcome("settling", { blocked, withdrawn });
  if (QUIET_BLOCKS.has(code)) return outcome("none", { blocked, withdrawn });
  return outcome("held", { hold: code, blocked, withdrawn });
}

/**
 * Read the plan, the log and the protective state and add ONE set to ONE lift when the log
 * has earned it — through the ordinary autonomy path, with Undo — or nothing: no intent, no
 * group that qualifies, a hold, the athlete's no, a step still settling, a draft already in
 * flight. `act:false` never routes a change (status `deferred`). `dry:true` writes nothing
 * at all and reports what an acting pass WOULD do (status `would_route`) — the read to
 * check a live plan with before the scheduler acts. Idempotent. Never throws for a read
 * problem: every safety read fails CLOSED to "unavailable" (nothing changed, nothing
 * withdrawn).
 */
export function settleVolumeStep(opts: { date?: string; act?: boolean; dry?: boolean } = {}): VolumeStepOutcome {
  const date = String(opts.date || localDateISO()).slice(0, 10);
  const dry = opts.dry === true;
  const act = opts.act !== false;
  try {
    return runPass(date, act, dry);
  } catch {
    return outcome("unavailable");
  }
}

function runPass(date: string, act: boolean, dry: boolean): VolumeStepOutcome {
  const plan = getPlan() as PlanQualityDay[];
  const ctx = readVolumeFloorContext(date);
  if (!ctx) return outcome("unavailable");
  // 1. Intent: muscle or strength is a stated priority (endurance is not the primary role).
  if (!(ctx.strength_priority || ctx.muscle_priority)) return outcome("none");
  const rows = volumeStepRows();
  if (!rows) return outcome("unavailable");

  // 2. Open drafts: one change in flight. One whose premise is GONE is withdrawn quietly; a
  //    week that merely holds it changes nothing.
  const withdrawn: number[] = [];
  let open: number | null = null;
  for (const row of rows) {
    if (row.status !== "draft") continue;
    const proposal = getProposal(row.id) as any;
    const live = ["review", "pending", "announced"].includes(String(proposal?.autonomy?.status ?? ""));
    if (!live || volumeStepStillFits(proposal?.parsed, date, row.id) === "gone") {
      if (dry) withdrawn.push(row.id);
      else withdraw(row.id, withdrawn);
      continue;
    }
    if (open == null) open = row.id;
    else if (dry) withdrawn.push(row.id);
    else withdraw(row.id, withdrawn);
  }
  const openOutcome = (status: VolumeStepOutcome["status"], extra: Partial<VolumeStepOutcome> = {}) =>
    open != null ? draftOutcome(status, open, withdrawn, extra) : outcome(status, { withdrawn, ...extra });

  // 3. Holds: a week that holds changes nothing new; what is open stays exactly as it is.
  const hold = volumeStepWeekHold(date, ctx);
  if (hold) return openOutcome("held", { hold });
  if (open != null) return openOutcome("standing");

  // 4. One group a calendar week, whoever's it was and however it was answered.
  const weekStart = mondayOf(date);
  if (
    rows.some(
      (row) =>
        row.status !== "discarded" && row.status !== "rejected" && row.created >= weekStart && row.created <= date
    )
  ) {
    return outcome("held", { hold: "week_used", withdrawn });
  }

  // 5. Tolerance vouches: the athlete's own log carried every authored set at a held-or-
  //    rising load. (volumeToleranceRead answers null when it cannot be read: no step.)
  if (volumeToleranceRead(date) == null) return outcome("held", { hold: "tolerance_unproven", withdrawn });

  // 6. Candidate groups, strongest case first.
  const days = strengthDays(plan);
  if (!days.length) return outcome("none", { withdrawn });
  const planned = plannedWeeklyGroupSets(days as PlanQualityDay[]);
  const carried = new Set<string>([
    ...(ctx.endurance_carried ?? []).map((g) => String(g).toLowerCase()),
    ...enduranceCarriedGroups(6, date).map((g) => String(g).toLowerCase()),
  ]);
  const order = new Map<string, number>();
  let position = 0;
  for (const day of days) {
    for (const item of strengthItems(day)) {
      const g = primaryMuscleGroup(String(item.exercise), storedGroup(item));
      if (g && !order.has(g)) order.set(g, position);
      position += 1;
    }
  }
  const facts: VolumeStepGroupFacts[] = [];
  const blocked: VolumeStepOutcome["blocked"] = [];
  for (const target of weeklySetTargets(ctx)) {
    if (carried.has(target.group) || !order.has(target.group)) continue;
    const sets = planned.get(target.group as any) ?? 0;
    // A group under its floor is coverage's to close, never this pass's.
    if (sets < target.low - 1e-9) {
      blocked.push({ group: target.group, code: "below_floor" });
      continue;
    }
    facts.push({
      group: target.group,
      planned: sets,
      low: target.low,
      high: target.high,
      order: order.get(target.group) ?? 0,
    });
  }
  const ranked = rankVolumeStepGroups(facts);
  if (!ranked.length) return outcome("none", { blocked, withdrawn });

  // Reads every group shares. A read that throws makes the whole pass unavailable.
  const rowsAnswered = coverageChangeRows();
  const answers = rowsAnswered ? coverageAnswers(rowsAnswered) : null;
  const settling = settlingGroups(date);
  if (!answers || !settling) return outcome("unavailable");
  const reads = progressReads(date);
  const loads = { injury: openInjuryLoads(date), pain: painTouches(date) };
  // The plan day today's active composition was taken from: a lift on it waits.
  const composedDay = activeCompositionPlanDayNumber(date);
  const memoryFrom = addDaysISO(date, -REMEMBER_DAYS) ?? date;
  const intent = intentKey(ctx);

  for (const fact of ranked) {
    const group = fact.group;
    const declinedHere =
      rows.some((r) => r.answer === "no" && r.group === group && r.intent === intent && r.created >= memoryFrom) ||
      answers.declined({
        key: `group:${group}`,
        kind: "group",
        group,
        planned: fact.planned,
        low: fact.low,
        fingerprint: groupFingerprint(group, ctx),
      });
    if (declinedHere) {
      blocked.push({ group, code: "declined" });
      continue;
    }
    if (settling.notCarried.has(group)) {
      blocked.push({ group, code: "step_not_carried" });
      continue;
    }
    if (settling.settling.has(group)) {
      blocked.push({ group, code: "settling" });
      continue;
    }
    if (!weeklyGroupHasRoom(weeklyGroupEffectiveSets(date, group), 1)) {
      blocked.push({ group, code: "weekly_bound" });
      continue;
    }
    // The proportional bound lives at the group: planned sets after the step at most
    // ceil(1.2 x the group's habitual weekly effective sets); no habit on record, no step.
    if (!groupHabitBoundHolds(group, fact.planned, date)) {
      blocked.push({ group, code: "group_habit_bound" });
      continue;
    }
    const progress = groupProgressBlock(group, reads);
    if (progress.block) {
      blocked.push({ group, code: progress.block });
      continue;
    }
    const earning = new Set(progress.earning);
    if (!groupHarmFree(group, date)) {
      blocked.push({ group, code: "recent_harm" });
      continue;
    }
    const lifts = planLifts(days, group);
    if (!lifts.length) {
      blocked.push({ group, code: "no_lift" });
      continue;
    }
    let chosen: { lift: PlanLift; to: number } | null = null;
    const liftBlocks: VolumeStepBlock[] = [];
    for (const lift of lifts) {
      const verdict = judgeLift(lift, date, earning, loads, composedDay);
      if (verdict.block) {
        liftBlocks.push(verdict.block);
        blocked.push({ group, lift: lift.exercise, code: verdict.block });
        continue;
      }
      chosen = { lift, to: verdict.to as number };
      break;
    }
    if (!chosen) continue;
    // The ONE bounded step for the strongest case that can honestly take it.
    const words = volumeStepWords(date, group, chosen.lift.exercise, chosen.lift.day_name);
    const base = {
      group,
      lift: chosen.lift.exercise,
      day_number: chosen.lift.day_number,
      from_sets: chosen.lift.sets,
      to_sets: chosen.to,
      blocked,
      withdrawn,
    };
    if (!act) return outcome("deferred", base);
    if (dry) return outcome("would_route", { ...base, summary: words.summary, explanation: words.explanation });
    return { ...route({ group, lift: chosen.lift, to: chosen.to, intent }, date, withdrawn), blocked };
  }

  // Nothing could step. Report the reason a person would care about most.
  const top = BLOCK_PRECEDENCE.find((code) => blocked.some((b) => b.code === code));
  return top ? blockedStatus(top, blocked, withdrawn) : outcome("none", { blocked, withdrawn });
}

/**
 * What the next acting pass WOULD do, without writing anything: no draft, no withdrawal, no
 * decision. Read-only.
 */
export function previewVolumeStep(date?: string): VolumeStepOutcome {
  return settleVolumeStep({ date, act: true, dry: true });
}

// The step's own premise stands in for the evidence fingerprint at routing and at the
// boundary, it never lands into a session composed on its plan day, and a held draft
// speaks its own sentence (autonomy-service.ts registerServerPremise).
registerServerPremise({
  owns: (proposal) => String(proposal?.agent ?? "") === VOLUME_STEP_AGENT && !!proposal?.parsed?.volume_step,
  premise: (proposal, asOf) =>
    volumeStepStillFits(proposal.parsed, asOf, Number.isFinite(Number(proposal?.id)) ? Number(proposal.id) : null),
  waits_for_composed_day: true,
  explanation: (proposal) => proposal?.parsed?.volume_step?.explanation,
});
