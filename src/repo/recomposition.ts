import { db } from "../db.js";
import { estimateExpenditure, type ExpenditureEstimate } from "./expenditure.js";
import { currentBodyFatEstimate, effectiveGoalMode, getProfile, leannessAwareLossRates } from "./profile.js";
import { getProgramState, type ProgramState } from "./program-state.js";
import { daysBetweenISO, localDateISO } from "./shared.js";
import { resolvedCurrentBodyweight } from "./bodyweight.js";
import { wholePersonTrajectory, type WholePersonTrajectory } from "./whole-person-trajectory.js";
import { currentUnderfuelingRead } from "./underfueling-snapshot.js";
import type { UnderfuelingRead } from "./underfueling.js";
import {
  classifyRecompositionStage,
  isNearGoal,
  type RecompositionStageKind,
} from "./recomposition-stage.js";

export type { RecompositionStageKind } from "./recomposition-stage.js";
export { NEAR_GOAL_REMAINING_LB, isNearGoal } from "./recomposition-stage.js";

export type RecompositionActionKind = "hold" | "protect_fuel" | "settling" | "stabilize" | "collect_signal";

export interface RecompositionRead {
  as_of: string;
  stage: {
    kind: RecompositionStageKind;
    label: string;
    confidence: "low" | "medium" | "high";
    basis: string[];
  };
  progress: {
    start_weight_lb: number | null;
    current_weight_lb: number | null;
    goal_weight_lb: number | null;
    lost_lb: number | null;
    remaining_lb: number | null;
    progress_fraction: number | null;
    robust_trend_lb_wk: number | null;
    target_rate: { low: number; ideal: number; high: number } | null;
    timeline: {
      earliest_weeks: number;
      likely_weeks: number;
      latest_weeks: number;
      confidence: "low" | "medium" | "high";
      includes_stabilization: boolean;
    } | null;
  };
  scale: {
    state: "trend_clear" | "ordinary_noise" | "unconfirmed_shift" | "settling";
    line: string;
  };
  muscle: {
    state: "advancing" | "holding" | "watch" | "at_risk" | "unknown";
    evidence: string[];
  };
  fuel: {
    state: "adequate" | "watch" | "protect" | "settling" | "unknown";
    evidence: string[];
  };
  action: {
    kind: RecompositionActionKind;
    status: "active" | "settling" | "recommended" | "holding";
    label: string;
    kcal_delta: number | null;
    carb_forward: boolean;
    training_directive: "proceed" | "hold_aggression" | "reduce";
    autonomy: "none" | "announce";
    effective_boundary: "next_week" | null;
    line: string;
  };
  line: string;
  reassurance: string | null;
  evidence_keys: string[];
}

type PhaseLike = {
  kind?: string | null;
  start_date?: string | null;
  target_weight_lb?: number | null;
  status?: string | null;
} | null;

const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const finite = (value: unknown): number | null => {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function remainingToGoalLb(current: number | null, goal: number | null): number | null {
  if (current == null || goal == null) return null;
  return goal < current ? round1(current - goal) : 0;
}

// Close enough to the destination that a soft/reduce fuel hold no longer vetoes
// a promotion the log already earned. Sliding cut pressure still does; fast_loss
// does not. Pure remaining math lives in `isNearGoal`; this is the date-aware
// reader. Only a live lose-mode cut can be "near" — a gain/maintain athlete, a
// missing weight/goal, or a goal already at/past current must never read as
// near (0 remaining is at-destination display math, not a near-goal lever).
export function nearGoal(date = localDateISO()): boolean {
  try {
    const profile = getProfile() as any;
    if (effectiveGoalMode(profile) !== "lose") return false;
    const currentResolved = resolvedCurrentBodyweight(profile, date);
    const current = finite(currentResolved?.weight_lb ?? profile?.weight_lb);
    const goal = finite(profile?.goal_weight_lb);
    if (current == null || goal == null || goal >= current) return false;
    return isNearGoal(remainingToGoalLb(current, goal));
  } catch {
    return false;
  }
}

function activePhaseFallback(): PhaseLike {
  try {
    return db
      .prepare(
        `SELECT kind, start_date, target_weight_lb, status
           FROM journey_phases WHERE status = 'active'
          ORDER BY COALESCE(start_date, created_at) DESC, id DESC LIMIT 1`
      )
      .get() as PhaseLike;
  } catch {
    return null;
  }
}

export function recompositionRead(
  today = localDateISO(),
  opts: {
    activePhase?: PhaseLike;
    // `null` is an intentional precomputed-unavailable sentinel. Only an omitted
    // value authorizes this standalone read to estimate expenditure itself.
    expenditure?: ExpenditureEstimate | null;
    programState?: ProgramState;
    wholePerson?: WholePersonTrajectory;
    underfueling?: UnderfuelingRead;
  } = {}
): RecompositionRead {
  const profile = getProfile() as any;
  const currentResolved = resolvedCurrentBodyweight(profile, today);
  const current = finite(currentResolved?.weight_lb ?? profile?.weight_lb);
  const start = finite(profile?.start_weight_lb);
  const goal = finite(profile?.goal_weight_lb);
  const goalBodyFat = finite(profile?.goal_bodyfat_pct);
  const mode = effectiveGoalMode(profile);
  const phase = opts.activePhase === undefined ? activePhaseFallback() : opts.activePhase;
  const bodyFat = currentBodyFatEstimate(profile);
  const expenditure = opts.expenditure === undefined ? estimateExpenditure(21) : opts.expenditure;
  const expenditureConfidence = expenditure?.confidence ?? "none";
  const expenditureQuality = expenditure?.quality ?? null;
  const program = opts.programState ?? getProgramState(today);
  const whole = opts.wholePerson ?? wholePersonTrajectory({ end: today, days: 56 });
  const underfueling =
    opts.underfueling ??
    currentUnderfuelingRead(today, {
      expenditure,
      programState: program,
      wholePerson: whole,
    });

  const lost =
    start != null && current != null && start > current
      ? round1(start - current)
      : start != null && current != null
        ? 0
        : null;
  const remaining = remainingToGoalLb(current, goal);
  const total = start != null && goal != null && start > goal ? start - goal : null;
  const progress = total != null && lost != null ? Math.max(0, Math.min(1, lost / total)) : null;
  const stage = classifyRecompositionStage({
    mode,
    phaseKind: phase?.kind,
    progress,
    remaining,
    current,
    bodyFatPct: bodyFat?.body_fat_pct ?? null,
    bodyFatDate: bodyFat?.date ?? null,
    goalBodyFat,
    today,
  });
  const rates =
    current != null && mode === "lose" ? leannessAwareLossRates(current, bodyFat?.body_fat_pct ?? null) : null;
  const targetRate =
    rates && rates.lean_ideal_rate_lb > 0
      ? {
          low: round2(Math.max(0.2, rates.lean_ideal_rate_lb * 0.7)),
          ideal: round2(rates.lean_ideal_rate_lb),
          high: round2(rates.safe_max_rate_lb),
        }
      : null;
  const phaseAge = phase?.start_date ? daysBetweenISO(today, String(phase.start_date)) : null;
  const stabilizationWeeks = stage.kind === "leaning_out" || (phaseAge != null && phaseAge >= 56) ? 2 : 0;
  const timeline =
    remaining != null && remaining > 0 && targetRate
      ? {
          earliest_weeks: Math.max(1, Math.ceil(remaining / Math.max(0.1, targetRate.high))),
          likely_weeks: Math.max(1, Math.ceil(remaining / Math.max(0.1, targetRate.ideal)) + stabilizationWeeks),
          latest_weeks: Math.max(1, Math.ceil(remaining / Math.max(0.1, targetRate.low)) + stabilizationWeeks),
          confidence:
            expenditureConfidence === "high"
              ? ("high" as const)
              : expenditureConfidence === "medium"
                ? ("medium" as const)
                : ("low" as const),
          includes_stabilization: stabilizationWeeks > 0,
        }
      : null;

  const trend = finite(expenditure?.trend_lb_wk);
  const scale = expenditureQuality?.terminal_weight_shock
    ? {
        state: "unconfirmed_shift" as const,
        line: "The latest scale move is still unconfirmed, so Cairn is not treating it as tissue change or changing fuel from it.",
      }
    : expenditureQuality?.weight_level_shift === "corroborated"
      ? {
          state: "settling" as const,
          line: "Repeated weigh-ins support a new scale level, but Cairn is admitting that shift gradually rather than over-reading it.",
        }
      : trend == null || expenditureConfidence === "none"
        ? {
            state: "ordinary_noise" as const,
            line: "The scale signal is still too thin for a directional call; hold the plan instead of chasing day-to-day movement.",
          }
        : {
            state: "trend_clear" as const,
            line: `The completed-day trend is about ${round2(trend)} lb per week across the robust energy window.`,
          };

  const regressingLifts = (program.lifts || []).filter((lift: any) => lift.status === "regressing");
  const strengthDomain = whole.domains.find((domain) => domain.domain === "strength") ?? null;
  const strengthRegression = regressingLifts.length >= 2 || strengthDomain?.verdict === "worse";
  const performanceStrain = underfueling.channels.some(
    (channel) => channel.key === "performance" && channel.direction === "strain"
  );
  const riskEvidence = underfueling.channels
    .filter((channel) => channel.direction === "strain")
    .map((channel) => channel.summary);

  let action: RecompositionRead["action"];
  if (underfueling.action.kind === "raise_target" || underfueling.action.kind === "recovery_package") {
    action = {
      kind: "protect_fuel",
      status: "recommended",
      label:
        underfueling.action.kind === "recovery_package" ? "Coordinated recovery step" : "Next protective adjustment",
      kcal_delta: underfueling.action.kcal_delta,
      carb_forward: true,
      training_directive: underfueling.action.training,
      autonomy: "none",
      effective_boundary: null,
      line: underfueling.action.line,
    };
  } else if (underfueling.action.kind === "settle") {
    action = {
      kind: "settling",
      status: "settling",
      label: "Correction settling",
      kcal_delta: underfueling.action.kcal_delta,
      carb_forward: true,
      training_directive: underfueling.action.training,
      autonomy: "none",
      effective_boundary: null,
      line: underfueling.action.line,
    };
  } else if (underfueling.action.kind === "collect_signal") {
    action = {
      kind: "collect_signal",
      status: "holding",
      label: "Current move",
      kcal_delta: underfueling.action.kcal_delta,
      carb_forward: false,
      training_directive: underfueling.action.training,
      autonomy: "none",
      effective_boundary: null,
      line: underfueling.action.line,
    };
  } else {
    action = {
      kind: "hold",
      status: "holding",
      label: underfueling.action.kind === "reshape_meals" ? "Make the target easier to complete" : "Current move",
      kcal_delta: underfueling.action.kcal_delta,
      carb_forward: underfueling.action.kind === "reshape_meals",
      training_directive: underfueling.action.training,
      autonomy: "none",
      effective_boundary: null,
      line: underfueling.action.line,
    };
  }

  const muscleState: RecompositionRead["muscle"]["state"] =
    strengthDomain?.verdict === "better" && !strengthRegression
      ? "advancing"
      : performanceStrain && underfueling.action.training !== "proceed"
        ? "at_risk"
        : performanceStrain || strengthRegression
          ? "watch"
          : strengthDomain?.verdict === "holding" || program.recovery_week
            ? "holding"
            : "unknown";
  const fuelState: RecompositionRead["fuel"]["state"] =
    underfueling.state === "prescription_strain" || underfueling.state === "persistent_strain"
      ? "protect"
      : underfueling.state === "settling"
        ? "settling"
        : underfueling.state === "execution_gap" || underfueling.state === "uncertain"
          ? "watch"
          : underfueling.state === "insufficient_signal"
            ? "unknown"
            : "adequate";

  const line = underfueling.action.line;
  const reassurance =
    stage.kind === "leaning_out"
      ? "Later fat-loss phases normally move more slowly; that taper protects training quality and lean mass rather than signaling failure."
      : action.kind === "protect_fuel" || action.kind === "settling"
        ? "A small fuel correction is part of protecting the long game, not backing away from the goal."
        : scale.state === "unconfirmed_shift"
          ? "Water, glycogen, sodium, and digestion can move a single weigh-in without representing the same amount of tissue change."
          : null;

  return {
    as_of: today,
    stage: {
      ...stage,
      confidence:
        progress != null && (expenditureConfidence === "medium" || expenditureConfidence === "high")
          ? expenditureConfidence
          : "low",
    },
    progress: {
      start_weight_lb: start,
      current_weight_lb: current,
      goal_weight_lb: goal,
      lost_lb: lost,
      remaining_lb: remaining,
      progress_fraction: progress == null ? null : round2(progress),
      robust_trend_lb_wk: trend == null ? null : round2(trend),
      target_rate: targetRate,
      timeline,
    },
    scale,
    muscle: { state: muscleState, evidence: riskEvidence.filter((line) => /lift|strength/i.test(line)).slice(0, 3) },
    fuel: { state: fuelState, evidence: riskEvidence.slice(0, 5) },
    action,
    line,
    reassurance,
    evidence_keys: [
      `expenditure:21d:${expenditureConfidence}`,
      `program_state:${today}`,
      `whole_person:${whole.window.start}..${whole.window.end}`,
      `underfueling:${underfueling.signature}`,
      ...(underfueling.correction.target_id ? [`nutrition_target:${underfueling.correction.target_id}`] : []),
      ...(program.recovery_week?.applied_on ? [`recovery_week:${program.recovery_week.applied_on}`] : []),
    ],
  };
}
