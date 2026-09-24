import type { AcuteGateReading } from "./hybrid-load.js";
import type {
  DailyDecisionCandidate,
  DailyDecisionEnvelope,
  DailyDecisionKind,
  DailyDecisionSnapshot,
} from "./daily-decision.js";
import type { ProgramState } from "./program-state.js";
import type { Prescription } from "./progression.js";

// The WEEKLY DOSE: how far each muscle group's week sits under its contextual floor
// (volume-floor.ts), counting what is already logged this Monday-first week plus what
// today and the rest of the week's lift days still plan — and, when a group would end
// the week short, which of TODAY's items may take one extra set toward it.
//
// Two halves, the same split as the rest of the daily decision:
//   - `weeklyDoseSnapshot` is the GATHER half. It may read the database. Its result is
//     stamped onto the snapshot as `weekly_dose` ONLY when it has something to say, so
//     an ordinary morning fingerprints exactly as it did before this module existed.
//   - `weeklyDoseDecision` is the DECIDE half. It must stay a pure function of the
//     snapshot slice and its context (buildDailySessionDecision is pure), and its
//     result lands on the envelope as `dose` (spread only when present).
// The composition half, `applyWeeklyDose`, lives in composition-dose.ts.
//
// Must never: change a load (target_weight/target_seconds), add to an untested slot
// (`Prescription.untested`), fill on a non-train day, a run day, a light or exempt week,
// or for a group the envelope excludes, reduces, holds saturated or reads deep.

export interface WeeklyDoseGap {
  group: string;
  // Working sets the week would still end under the group's floor. Never negative.
  short: number;
}

export interface WeeklyDoseEligibleItem {
  exercise: string;
  group: string;
}

// The snapshot slice (`DailyDecisionSnapshot.weekly_dose`). Fingerprinted: keep it
// compact, JSON-only, and stable for a given day's inputs.
export interface WeeklyDoseSnapshot {
  gaps: WeeklyDoseGap[];
  eligible: WeeklyDoseEligibleItem[];
}

// Everything the gather half may want from gatherDailyDecisionSnapshot's own reads, so
// it never repeats an expensive one. Read-only.
export interface WeeklyDoseGatherContext {
  // 'training' when today composes a strength day; 'rest'/'run' when the calendar
  // puts no lifting here (the snapshot's plan.day_type).
  dayType: "training" | "rest" | "run";
  dayNumber: number | null;
  // Today's plan-day items exactly as the envelope will see them (recovery-cycle
  // overlay applied). Raw plan rows: exercise, muscle_group, sets, mode, kind, note…
  planItems: readonly any[];
  // planDayProgression(dayNumber): the raw prescriptions, carrying `untested`,
  // `action`, `fuel_protected`, `pain_protected`, `top_set`, `movement_response`.
  progression: readonly Prescription[];
  programState: ProgramState | null;
  // The acute gate per group (hybrid-load.acuteGates) — the one recovery question.
  muscleLoad: ReadonlyMap<string, AcuteGateReading>;
  // dayRead's kind for the date, and whether a recovery week is in force.
  readKind: string | null;
  recoveryWeek: boolean;
}

/** Gather half. `undefined` = nothing to say (the key stays off the snapshot). */
export function weeklyDoseSnapshot(_date: string, _ctx: WeeklyDoseGatherContext): WeeklyDoseSnapshot | undefined {
  return undefined;
}

// The envelope's `dose` field: the gaps the day was read against, and the fills it
// authorizes — at most one extra working set per item.
export interface DailyDecisionDose {
  gaps: WeeklyDoseGap[];
  fills: Array<{ exercise: string; group: string; add_sets: 1 }>;
}

// The decide half's inputs: the day's own verdict, as buildDailySessionDecision has
// already resolved it by the time the dose is asked. Read-only.
export interface WeeklyDoseDecisionContext {
  date: string;
  kind: DailyDecisionKind;
  // The snapshot's plan.day_type; 'run' / 'rest' days carry no lifting card.
  dayType: "training" | "rest" | "run";
  // A stated run day without train-anyway (the card carries no lifting).
  runDay: boolean;
  trainAnyway: boolean;
  caps: DailyDecisionEnvelope["caps"];
  // The envelope's muscle view: excluded, reduced, saturated, deep, week_held.
  muscles: DailyDecisionEnvelope["muscles"];
  // Final candidates (actions after every hold/deload/exclude/equipment pass). A
  // candidate with `top_set` is already carrying the day's heavy single.
  candidates: readonly DailyDecisionCandidate[];
  recoveryWeek: boolean;
  mesocyclePhase: string | null;
  // The whole snapshot, for anything else the rule needs. Never mutate it.
  snapshot: DailyDecisionSnapshot;
}

export interface WeeklyDoseDecision {
  dose: DailyDecisionDose | null;
  // Machine-register detail for soft_preferences under `weekly_dose_fill`.
  soft: string | null;
  // Athlete-facing line for the rationale (pickDayVariant, violatesReadingGrammar-clean).
  rationale: string | null;
}

/** Decide half. Pure. Nothing to fill → `{ dose: null, soft: null, rationale: null }`. */
export function weeklyDoseDecision(
  _snapshot: WeeklyDoseSnapshot | undefined,
  _ctx: WeeklyDoseDecisionContext
): WeeklyDoseDecision {
  return { dose: null, soft: null, rationale: null };
}
