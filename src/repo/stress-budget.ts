import type { DailyDecisionKind, DailyDecisionReason, DailyDecisionSnapshot } from "./daily-decision.js";
import type { EnduranceRole } from "./training-intent.js";

// The WEEK'S STRESS BUDGET for the legs: what a race build's taper and race week, and
// the eve of a placed key run, ask of today's lower-body lifting. It speaks through the
// envelope's existing muscle lists — a group it names is REDUCED (composition's 2-set
// cap and eased load) or EXCLUDED — so composition needs nothing new.
//
// Two halves, the same split as the rest of the daily decision:
//   - `stressBudgetSnapshot` is the GATHER half. It may read the database (raceBuild,
//     the run placement). Its result is stamped onto the snapshot as `stress_budget`
//     ONLY when it has something to say, so an ordinary morning fingerprints exactly as
//     before.
//   - `stressBudgetDecision` is the DECIDE half, called inside buildDailySessionDecision
//     once the weekly-lower guarantee is resolved. It must stay pure.
//
// Must never: reduce or exclude a group the weekly lower guarantee is holding
// (`lowerWeekHolds` / `weekHeldGroups`), touch the anchor compound's group on a
// key-run eve, act when `lowerSafetyFloor` already governs the legs, change a load or
// a set count directly (that is composition's, via the muscle lists), or touch upper-
// body groups.

export type StressBudgetReason = Extract<DailyDecisionReason, "key_run_eve" | "race_taper_legs" | "race_week_legs">;

// The snapshot slice (`DailyDecisionSnapshot.stress_budget`). Fingerprinted: keep it
// compact, JSON-only, and stable for a given day's inputs.
export interface StressBudgetSnapshot {
  // raceBuild(date): the current week's kind and the days left to the race.
  race_week_kind?: string;
  days_to_race?: number;
  // Tomorrow's PLACED run (the run placement, not the raw schedule), when it is key.
  tomorrow_run?: "quality" | "long";
}

export interface StressBudgetGatherContext {
  dayType: "training" | "rest" | "run";
  // Today's plan-day items as the envelope will see them (recovery overlay applied).
  planItems: readonly any[];
  enduranceRole: EnduranceRole;
}

/** Gather half. `undefined` = nothing to say (the key stays off the snapshot). */
export function stressBudgetSnapshot(_date: string, _ctx: StressBudgetGatherContext): StressBudgetSnapshot | undefined {
  return undefined;
}

// The envelope's `stress` field: which rule spoke and the groups it named.
export interface DailyDecisionStress {
  code: StressBudgetReason;
  groups: string[];
}

export interface StressBudgetDecisionContext {
  date: string;
  kind: DailyDecisionKind;
  baseKind: DailyDecisionKind;
  trainAnyway: boolean;
  // The weekly lower guarantee is in force today (owner ruling 2026-09-23): nothing
  // here may take today's legs from it.
  lowerWeekHolds: boolean;
  // Groups held at logged load on the week's last lower day.
  weekHeldGroups: ReadonlySet<string>;
  // A deciding brake, low readiness, soreness, illness, a lower injury, a recovery
  // cycle/week or a deload phase already governs the legs — this module stands down.
  lowerSafetyFloor: boolean;
  // The day's first primary compound (effect-order tier 'primary'), or null.
  anchor: { exercise: string; muscle_group: string | null } | null;
  // Today's plan items as the snapshot carries them.
  planItems: DailyDecisionSnapshot["plan_items"];
  // Groups an injury or joint pain already excludes.
  injuryExcluded: readonly string[];
  enduranceRole: EnduranceRole;
  // The whole snapshot, for anything else the rule needs. Never mutate it.
  snapshot: DailyDecisionSnapshot;
}

export interface StressBudgetDecision {
  code: StressBudgetReason | null;
  // Merged into the envelope's reduced / excluded muscle lists.
  reduced: string[];
  excluded: string[];
  // Athlete-facing line for the rationale (pickDayVariant, violatesReadingGrammar-clean).
  rationale: string | null;
  // Machine-register detail for soft_preferences under `code`.
  soft: string | null;
  // The note an item carries when ONLY this rule excluded its group (the candidate's
  // `note`; its reason_code is `code`). null keeps the generic exclusion note.
  excluded_note: string | null;
}

/** Decide half. Pure. Nothing to say → no code, empty lists. */
export function stressBudgetDecision(
  _snapshot: StressBudgetSnapshot | undefined,
  _ctx: StressBudgetDecisionContext
): StressBudgetDecision {
  return { code: null, reduced: [], excluded: [], rationale: null, soft: null, excluded_note: null };
}
