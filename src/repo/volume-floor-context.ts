// The LIVE context the plan's volume floor is read against (see volume-floor.ts for
// the rule itself). Kept apart from the pure module so the plan compiler never
// imports the progression engine: a caller that has a live athlete resolves this
// once and hands it to validateTrainingPlan / the redraw precheck / the prompt.
import { activeBlockContext, derivePhase, getActiveBlock } from "./program-blocks.js";
import { getProgramState } from "./program-state.js";
import { raceBuild } from "./race-build.js";
import { enduranceCarriedGroups } from "./progression.js";
import { activeRecoveryWeek } from "./recovery-week.js";
import { addDaysISO, localDateISO } from "./shared.js";
import { getTrainingIntent } from "./training-intent.js";
import { getPlan } from "./plan.js";
import { plannedWeeklyGroupSets, type PlanQualityDay } from "./plan-quality.js";
import { type VolumeFloorContext, type VolumeFloorExemption, weeklySetTargets } from "./volume-floor.js";

// Is this week — or the next one, which is where a drafted week lands — deliberately
// light? Each read is independent and fail-soft: an unreadable source is "not light",
// never a thrown context. Ordered from the most explicit (a recovery week the athlete
// has in force or scheduled) to the most derived (the race taper off the run engine).
export function lightWeekExemption(today: string): VolumeFloorExemption | null {
  const attempt = (read: () => boolean): boolean => {
    try {
      return read();
    } catch {
      return false;
    }
  };
  // Active now, or scheduled to start within the week the draft would land in.
  if (
    attempt(() =>
      Array.from({ length: 8 }, (_, i) => addDaysISO(today, i) ?? today).some((day) => !!activeRecoveryWeek(day))
    )
  )
    return "recovery_week";
  if (
    attempt(() => {
      if (activeBlockContext(today)?.phase === "deload") return true;
      // The block's NEXT week is its deload by the block's own phase plan (derivePhase,
      // the schedule advanceBlockWeek walks): the draft lands into it. A two-week block
      // is never exempted whole — its first week is the only building week it has.
      const block = getActiveBlock();
      if (!block) return false;
      const total = Number(block.total_weeks);
      const week = Number(block.week_index);
      return total > 2 && week < total && derivePhase(week + 1, total, block.focus) === "deload";
    })
  )
    return "deload_phase";
  if (attempt(() => getProgramState(today).mesocycle?.phase === "deload-due")) return "deload_due";
  if (
    attempt(() => {
      const build = raceBuild(today);
      if (!build?.available) return false;
      const current = build.weeks.findIndex((week) => week.current);
      const window = current >= 0 ? build.weeks.slice(current, current + 2) : build.weeks.slice(0, 1);
      return window.some((week) => week.kind === "taper" || week.kind === "race");
    })
  )
    return "race_taper";
  return null;
}

/**
 * Resolve the volume-floor context for a date. Fail-soft in the direction of NO
 * floor: an unreadable intent is not a priority, and a read problem never turns
 * into a warning the athlete cannot act on.
 */
export function readVolumeFloorContext(date = localDateISO()): VolumeFloorContext | null {
  const today = String(date || localDateISO()).slice(0, 10);
  try {
    const intent = getTrainingIntent();
    const enduranceLed = intent.endurance_role === "primary";
    const priorities = Array.isArray(intent.priorities) ? intent.priorities : [];
    const exempt = lightWeekExemption(today);
    let carried: string[] = [];
    try {
      carried = enduranceCarriedGroups(2, today);
    } catch {
      carried = [];
    }
    return {
      strength_priority: !enduranceLed && priorities.includes("strength"),
      muscle_priority: !enduranceLed && priorities.includes("muscle"),
      endurance_carried: carried,
      exempt,
    };
  } catch {
    return null;
  }
}

export interface WeeklySetTargetsRead {
  applies: boolean;
  exempt: VolumeFloorContext["exempt"];
  endurance_carried: string[];
  /** Per priority group: the landmark window and what the current plan gives it now. */
  targets: Array<{ group: string; low: number; high: number; planned: number }>;
}

/**
 * The weekly per-group set targets the plan-shaping prompts are handed (DATA's
 * `weekly_set_targets`), with what the CURRENT plan gives each group beside them —
 * the same arithmetic the plan compiler and the redraw precheck hold a draft to, so
 * the agent can check its own week instead of being corrected after the fact.
 */
export function weeklySetTargetsRead(date = localDateISO(), plan?: PlanQualityDay[]): WeeklySetTargetsRead {
  const ctx = readVolumeFloorContext(date);
  const targets = weeklySetTargets(ctx);
  const base: WeeklySetTargetsRead = {
    applies: targets.length > 0,
    exempt: ctx?.exempt ?? null,
    endurance_carried: ctx?.endurance_carried ?? [],
    targets: [],
  };
  if (!targets.length) return base;
  let planned = new Map<string, number>();
  try {
    planned = plannedWeeklyGroupSets(plan ?? (getPlan() as PlanQualityDay[]));
  } catch {
    /* no plan → every group plans zero */
  }
  base.targets = targets.map((t) => ({
    ...t,
    planned: Math.round((planned.get(t.group) ?? 0) * 10) / 10,
  }));
  return base;
}
