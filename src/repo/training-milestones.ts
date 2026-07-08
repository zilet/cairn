import {
  applyAttentionObservation,
  listAttentionSchedule,
  listDueAttention,
  type AttentionScheduleEntry,
  type AttentionSignalStatus,
  type CadencePolicy,
} from "./attention.js";
import { normalizedExerciseKey } from "./exercise-canon.js";
import { testWeekDue, type TestWeekDue } from "./muscle-trajectory.js";
import { getProgramState, type LiftState, type ProgramState } from "./program-state.js";
import { enduranceTestsDue } from "./run-progression.js";
import { localDateISO } from "./shared.js";

export interface StrengthMilestoneInput {
  key: string;
  label: string;
  exercise: string;
  est_1rm: number;
  level: string;
  to_next?: { level: string; lb: number } | null;
}

export interface EnduranceMilestoneInput {
  vo2max: number | null;
  percentile: number | null;
  tone: string;
  headline: string;
}

export type TrainingMilestoneKind = "strength-standard" | "endurance-benchmark";

export interface TrainingMilestoneCandidate {
  id: string;
  kind: TrainingMilestoneKind;
  title: string;
  target: string;
  why: string;
  exercise?: string;
  current?: string;
  suggested_test?: string;
  priority: number;
}

export interface TrainingBenchmarkRead {
  generated_for: string;
  milestones: TrainingMilestoneCandidate[];
  attention: AttentionScheduleEntry[];
  due: AttentionScheduleEntry[];
}

const STRENGTH_POLICY: CadencePolicy = {
  signal_class: "training:strength-benchmark",
  domain: "training",
  source: "training-milestones",
  active_days: 14,
  confirming_days: 21,
  surveillance_initial_days: 42,
  surveillance_multiplier: 1.75,
  surveillance_max_days: 112,
  surveillance_checks_before_release: 1,
  reason: "A lift is plateaued, regressing, or at a block checkpoint; re-test only after a useful response window.",
  release_condition:
    "The lift is progressing cleanly or is no longer trained; no fixed 1RM cadence is needed until a plateau, block ending, or athlete question brings it back.",
};

const ENDURANCE_POLICY: CadencePolicy = {
  signal_class: "training:endurance-benchmark",
  domain: "running",
  source: "training-milestones",
  active_days: 21,
  confirming_days: 28,
  surveillance_initial_days: 56,
  surveillance_multiplier: 1.75,
  surveillance_max_days: 120,
  surveillance_checks_before_release: 1,
  reason: "An endurance benchmark is stale or the run signal has flattened; re-test after a focused training response window.",
  release_condition:
    "Endurance is progressing cleanly with no stale benchmark; it goes quiet until a plateau, block change, new goal, or athlete question brings it back.",
};

function clip(text: unknown, max = 220): string {
  const s = String(text ?? "").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}...` : s;
}

function slug(text: string): string {
  return normalizedExerciseKey(text || "benchmark").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "benchmark";
}

function round5(n: number): number {
  return Math.round(n / 5) * 5;
}

function liftStatus(lift: LiftState | undefined | null): AttentionSignalStatus {
  if (!lift) return "normal";
  if (lift.status === "plateaued" || lift.status === "regressing") return "flagged";
  if (lift.status === "progressing") return "clean";
  return "stable";
}

function liftReason(lift: LiftState | undefined | null, fallback: string): string {
  if (!lift) return fallback;
  if (lift.status === "plateaued") {
    return `${lift.exercise} is plateaued${lift.weeks_static ? ` ~${lift.weeks_static} wk` : ""}; re-test or rotate only after a useful training response.`;
  }
  if (lift.status === "regressing") {
    return `${lift.exercise} is drifting down; treat the next check as a rebuild confirmation, not a forced max.`;
  }
  if (lift.status === "progressing") {
    return `${lift.exercise} is progressing cleanly, so Cairn releases fixed re-test cadence and lets training keep working.`;
  }
  return fallback;
}

export function strengthBenchmarkMilestones(caps: StrengthMilestoneInput[] = []): TrainingMilestoneCandidate[] {
  return caps
    .filter((c) => c && c.to_next && Number(c.to_next.lb) > 0 && Number(c.est_1rm) > 0)
    .map((c) => {
      const add = Math.max(5, round5(Number(c.to_next!.lb)));
      const target = round5(Number(c.est_1rm) + add);
      return {
        id: `strength:${slug(c.exercise)}:${String(c.to_next!.level).toLowerCase()}`,
        kind: "strength-standard" as const,
        title: `${c.label} to ${c.to_next!.level}`,
        target: `${target} lb estimated 1RM`,
        current: `${Math.round(Number(c.est_1rm))} lb estimated 1RM`,
        exercise: c.exercise,
        suggested_test: `Heavy triple or clean top set on ${c.exercise}`,
        why: `${c.exercise} is ${add} lb from the next ${c.label.toLowerCase()} standard (${c.to_next!.level}). Treat it as a direction of travel, not a gate.`,
        priority: Math.max(1, 200 - add),
      };
    })
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title))
    .slice(0, 4);
}

export function enduranceBenchmarkMilestones(
  endurance: EnduranceMilestoneInput | null | undefined,
  testsDue: Array<{ exercise?: string; why?: string }> = [],
): TrainingMilestoneCandidate[] {
  const out: TrainingMilestoneCandidate[] = [];
  const vo2 = Number(endurance?.vo2max);
  const hasVo2 = Number.isFinite(vo2) && vo2 > 0;
  if (hasVo2 && endurance?.tone !== "strong") {
    out.push({
      id: "endurance:vo2-next-rung",
      kind: "endurance-benchmark",
      title: `VO2max to ${Math.round(vo2 + 2)}`,
      target: `${Math.round(vo2 + 2)} VO2max estimate`,
      current: `${Math.round(vo2)} VO2max estimate`,
      suggested_test: "Hard sustained outdoor run your watch can read",
      why: "A small VO2max rung is a concrete endurance milestone; it moves through consistent easy volume plus one quality session, not daily testing.",
      priority: endurance?.tone === "watch" ? 130 : 95,
    });
  }
  for (const t of testsDue.slice(0, 2)) {
    const exercise = clip(t.exercise || "endurance benchmark", 80);
    out.push({
      id: `endurance:test:${slug(exercise)}`,
      kind: "endurance-benchmark",
      title: exercise,
      target: "Fresh pace / fitness benchmark",
      suggested_test: exercise,
      why: clip(t.why || "A benchmark would re-anchor current endurance fitness.", 260),
      priority: 140,
    });
  }
  return out.sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title)).slice(0, 3);
}

export function benchmarkMilestoneCandidates(args: {
  capacities?: StrengthMilestoneInput[];
  endurance?: EnduranceMilestoneInput | null;
  enduranceTests?: Array<{ exercise?: string; why?: string }>;
}): TrainingMilestoneCandidate[] {
  return [
    ...strengthBenchmarkMilestones(args.capacities ?? []),
    ...enduranceBenchmarkMilestones(args.endurance ?? null, args.enduranceTests ?? []),
  ]
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title))
    .slice(0, 5);
}

export function refreshTrainingBenchmarkAttention(
  date?: string,
  opts: {
    programState?: ProgramState;
    enduranceTests?: { exercise?: string; kind?: string; why?: string }[];
    testWeek?: TestWeekDue | null;
  } = {},
): AttentionScheduleEntry[] {
  const d = date || localDateISO();
  const ps = opts.programState ?? getProgramState(d);
  const out: AttentionScheduleEntry[] = [];
  const lifts = Array.isArray(ps.lifts) ? ps.lifts : [];
  for (const lift of lifts.filter((l) => l.sessions >= 3).slice(0, 12)) {
    out.push(
      applyAttentionObservation({
        signal_key: `training:strength:${slug(lift.exercise)}`,
        policy: STRENGTH_POLICY,
        observation: {
          checked_at: d,
          status: liftStatus(lift),
          reason: liftReason(lift, `${lift.exercise} has enough history to track benchmark cadence.`),
        },
      }),
    );
  }

  const tw = opts.testWeek === undefined ? testWeekDue(d, { programState: ps }) : opts.testWeek;
  out.push(
    applyAttentionObservation({
      signal_key: "training:strength:test-week",
      policy: STRENGTH_POLICY,
      observation: {
        checked_at: d,
        status: tw?.due ? "active" : "clean",
        reason: tw?.due
          ? `${tw.why} Re-test the named lifts near the block checkpoint, then let cadence stretch again.`
          : "No strength test week is due; clean progress releases fixed testing cadence.",
      },
    }),
  );

  const enduranceTests = opts.enduranceTests ?? enduranceTestsDue(d);
  const endurance = ps.endurance;
  const enduranceStatus: AttentionSignalStatus =
    enduranceTests.length || endurance?.suggested_action === "add-quality" || endurance?.pace_trend === "declining"
      ? "flagged"
      : endurance?.status === "building" || endurance?.status === "maintaining"
        ? "clean"
        : "stable";
  out.push(
    applyAttentionObservation({
      signal_key: "training:endurance:benchmark",
      policy: ENDURANCE_POLICY,
      observation: {
        checked_at: d,
        status: enduranceStatus,
        reason: enduranceTests.length
          ? `An endurance benchmark is due (${enduranceTests.map((t) => t.exercise).filter(Boolean).slice(0, 2).join(", ")}).`
          : enduranceStatus === "clean"
            ? "Endurance is building or maintaining cleanly, so no fixed re-test cadence is needed."
            : "No current endurance benchmark signal is active.",
      },
    }),
  );

  return out;
}

export function trainingBenchmarkRead(
  date?: string,
  opts: {
    capacities?: StrengthMilestoneInput[];
    endurance?: EnduranceMilestoneInput | null;
    programState?: ProgramState;
    refreshAttention?: boolean;
  } = {},
): TrainingBenchmarkRead {
  const d = date || localDateISO();
  const ps = opts.programState ?? getProgramState(d);
  const enduranceTests = enduranceTestsDue(d);
  const milestones = benchmarkMilestoneCandidates({
    capacities: opts.capacities ?? [],
    endurance: opts.endurance ?? null,
    enduranceTests,
  });
  const attention = opts.refreshAttention
    ? refreshTrainingBenchmarkAttention(d, { programState: ps, enduranceTests })
    : listAttentionSchedule({ domain: "training", limit: 100 }).concat(listAttentionSchedule({ domain: "running", limit: 25 }));
  return {
    generated_for: d,
    milestones,
    attention,
    due: listDueAttention(d, { domain: "training", limit: 20 }).concat(listDueAttention(d, { domain: "running", limit: 10 })),
  };
}
