// LOW ENERGY AVAILABILITY WATCH — the symptom cluster nothing else in Cairn catches.
//
// Every other protective read here answers a question with ONE outcome behind it:
// the under-fuelling controller reads the plate against the scale, the cut
// derivation reads maintenance against the goal. Relative energy deficiency in a
// male athlete has no single tell — there is no amenorrhea signal, which is exactly
// why the male picture is the one that gets missed — and the IOC's 2023 consensus
// describes it as a CLUSTER: recovery, performance, loss pace, mood, illness, all
// drifting together while everything looks individually explainable.
//
// So this module asks five narrow questions of signals the athlete is ALREADY
// producing, and acts only when at least two of them have said yes for a week and a
// half. That bar is the whole design:
//
//   • EVERY ARM IS TRI-STATE. `met` / `not_met` / `absent`, and absent is never met.
//     No wearable, no check-ins, a thin logging fortnight — all of those are silence,
//     and silence has never been evidence of anything here (a thin week lowers
//     confidence and blames nobody).
//   • TWO ARMS, NOT ONE. One drifting channel is a Tuesday. Two independent ones,
//     held for ten days, is a pattern.
//   • ONE DIRECTION ONLY. The response this watch can produce is a raise of the
//     calorie target toward MEASURED maintenance and one calm explanation. It can
//     never deepen a deficit, never gate training, and never accelerate anything.
//
// WHAT THE RESPONSE IS BOUNDED BY. `capProtectiveRaise` (cut-target.ts) is the ONE
// authority on lifting a target, and it is used here rather than re-derived, with
// every consequence that carries: protection buys maintenance and never a surplus,
// and on a `formula_estimate` anchor it buys NOTHING — an unmeasured maintenance is
// not headroom. A watch that fired on a Mifflin estimate would be inventing the very
// number it claims to be protecting.
//
// THE EXIT IS THE ORDINARY PATH. When the arms recover, this module simply stops
// finding a cluster, and the cut resumes through the existing cut machinery. There
// is no special "recovery mode" here, because a second way to set the target is how
// two ways to set the target end up disagreeing.
//
// The decision core is PURE — it reads no clock and no database. One DB-facing
// function assembles the arms, and it is written so the SAME evaluation can be run
// for an earlier date, which is what makes "sustained" a measurement rather than a
// guess.

import { db } from "../db.js";
import { createHash } from "node:crypto";
import { capProtectiveRaise, type CutTdeeBasis, cutReaffirmation, deriveCutTarget } from "./cut-target.js";
import { estimateExpenditure } from "./expenditure.js";
import { getLatestNutritionTarget } from "./nutrition.js";
import { getProgramState } from "./program-state.js";
import { recoveryTrendBars } from "./recovery-trend.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";

// ---- the tri-state ------------------------------------------------------------

export type ArmVerdict = "met" | "not_met" | "absent";

export type EnergyDeficiencyArmKey =
  | "recovery_and_performance"
  | "loss_pace"
  | "mood_energy"
  | "illness_recurrence"
  | "lift_stall";

export interface EnergyDeficiencyArm {
  key: EnergyDeficiencyArmKey;
  verdict: ArmVerdict;
  /** MACHINE register: third-person evidence prose. The athlete's words are below. */
  summary: string;
  evidence_keys: string[];
}

/**
 * Kleene AND over two tri-states. A definite NO on either side settles the
 * conjunction; otherwise one absent input leaves the whole arm absent.
 *
 * The order matters and is the point: `not_met AND absent` is `not_met`, not
 * `absent`, because one channel has already answered the question.
 */
export function armAnd(left: ArmVerdict, right: ArmVerdict): ArmVerdict {
  if (left === "not_met" || right === "not_met") return "not_met";
  if (left === "absent" || right === "absent") return "absent";
  return "met";
}

// ---- constants ----------------------------------------------------------------

/** How many arms must agree before the cluster is a cluster. */
export const MIN_CLUSTER_ARMS = 2;
/**
 * How long the cluster must have been standing. The consensus describes a
 * persistent state rather than an event, and ten days is the shortest span that
 * cannot be filled by one heavy week plus one bad night's sleep.
 */
export const SUSTAINED_DAYS = 12;
/** The bounded protective step, in the same 100-250 kcal band every other fuel move uses. */
const MIN_PROTECTIVE_STEP_KCAL = 100;
const MAX_PROTECTIVE_STEP_KCAL = 250;

const DAY_MS = 864e5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(value: unknown): string {
  return String(value ?? "").slice(0, 10);
}

// `Number(null)` is 0 and 0 is finite, so absence must be coerced to null EXPLICITLY
// or a missing maintenance anchor reads as a maintenance of zero.
function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---- shared trend reads -------------------------------------------------------
//
// Exported deliberately. The saturation/overreaching reads ask the same two
// questions of the same two tables, and two formulas for "is HRV falling" is how two
// surfaces come to disagree about the same fortnight in front of the athlete.

export interface TrendRead {
  direction: "falling" | "steady" | "rising" | "absent";
  recent_avg: number | null;
  baseline_avg: number | null;
  samples: number;
  baseline_samples: number;
}

const ABSENT_TREND: TrendRead = {
  direction: "absent",
  recent_avg: null,
  baseline_avg: null,
  samples: 0,
  baseline_samples: 0,
};

/** Source-agnostic overnight values by date, any non-null wearable row winning. */
function nightlyByDate(column: "hrv_ms" | "resting_hr", from: string, to: string): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const table of ["daily_metrics", "garmin_daily_metrics"]) {
    let rows: any[] = [];
    try {
      rows = db
        .prepare(
          `SELECT date, ${column} AS value FROM ${table}
            WHERE date BETWEEN ? AND ? AND ${column} IS NOT NULL ORDER BY date LIMIT 500`
        )
        .all(from, to) as any[];
    } catch {
      rows = [];
    }
    for (const row of rows) {
      const value = finite(row.value);
      if (value != null && value > 0) byDate.set(isoDay(row.date), value);
    }
  }
  return byDate;
}

/**
 * Is overnight HRV drifting DOWN against the athlete's own recent norm?
 *
 * Norm-relative, through `recoveryTrendBars` — the ONE answer to "is this drift
 * meaningful for this person" — so a 40 ms athlete's real collapse registers and a
 * 120 ms athlete's ordinary noise does not.
 *
 * A wearable is optional in this app, so a thin record is ABSENT, never steady.
 */
export function hrvTrendRead(asOf: string, recentDays = 7, baselineDays = 28): TrendRead {
  const today = isoDay(asOf);
  if (!DATE_RE.test(today)) return ABSENT_TREND;
  const recentFrom = addDaysISO(today, -(Math.max(2, recentDays) - 1)) ?? today;
  const baselineTo = addDaysISO(recentFrom, -1) ?? recentFrom;
  const baselineFrom = addDaysISO(baselineTo, -(Math.max(7, baselineDays) - 1)) ?? baselineTo;
  const recent = [...nightlyByDate("hrv_ms", recentFrom, today).values()];
  const baseline = [...nightlyByDate("hrv_ms", baselineFrom, baselineTo).values()];
  if (recent.length < 4 || baseline.length < 6) {
    return { ...ABSENT_TREND, samples: recent.length, baseline_samples: baseline.length };
  }
  const recentAvg = mean(recent)!;
  const baselineAvg = mean(baseline)!;
  const bar = recoveryTrendBars({ hrv: baselineAvg }).hrv;
  return {
    direction: recentAvg <= baselineAvg - bar ? "falling" : recentAvg >= baselineAvg + bar ? "rising" : "steady",
    recent_avg: round(recentAvg, 1),
    baseline_avg: round(baselineAvg, 1),
    samples: recent.length,
    baseline_samples: baseline.length,
  };
}

/**
 * Is the athlete's own rating of how sessions GO drifting down?
 *
 * `sessions.performance` is an optional 1-5 signal, so its absence is absent and its
 * presence is compared against the athlete's own prior fortnight rather than a fixed
 * "good enough" line. There are no scores here — the question is direction.
 */
export function performanceTrendRead(asOf: string, windowDays = 14): TrendRead {
  const today = isoDay(asOf);
  if (!DATE_RE.test(today)) return ABSENT_TREND;
  const span = Math.max(7, Math.trunc(windowDays));
  const recentFrom = addDaysISO(today, -(span - 1)) ?? today;
  const priorTo = addDaysISO(recentFrom, -1) ?? recentFrom;
  const priorFrom = addDaysISO(priorTo, -(span - 1)) ?? priorTo;
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT date, performance FROM sessions
          WHERE date BETWEEN ? AND ? AND performance IS NOT NULL ORDER BY date LIMIT 200`
      )
      .all(priorFrom, today) as any[];
  } catch {
    return ABSENT_TREND;
  }
  const recent: number[] = [];
  const prior: number[] = [];
  for (const row of rows) {
    const value = finite(row.performance);
    if (value == null) continue;
    (isoDay(row.date) >= recentFrom ? recent : prior).push(value);
  }
  if (recent.length < 3 || prior.length < 3) {
    return { ...ABSENT_TREND, samples: recent.length, baseline_samples: prior.length };
  }
  const recentAvg = mean(recent)!;
  const priorAvg = mean(prior)!;
  return {
    direction: recentAvg <= priorAvg - 0.5 ? "falling" : recentAvg >= priorAvg + 0.5 ? "rising" : "steady",
    recent_avg: round(recentAvg),
    baseline_avg: round(priorAvg),
    samples: recent.length,
    baseline_samples: prior.length,
  };
}

// ---- the five arms ------------------------------------------------------------

function recoveryAndPerformanceArm(asOf: string): EnergyDeficiencyArm {
  const hrv = hrvTrendRead(asOf);
  const performance = performanceTrendRead(asOf);
  const hrvVerdict: ArmVerdict =
    hrv.direction === "absent" ? "absent" : hrv.direction === "falling" ? "met" : "not_met";
  const performanceVerdict: ArmVerdict =
    performance.direction === "absent" ? "absent" : performance.direction === "falling" ? "met" : "not_met";
  const verdict = armAnd(hrvVerdict, performanceVerdict);
  return {
    key: "recovery_and_performance",
    verdict,
    summary:
      verdict === "met"
        ? `Overnight HRV is drifting below its own recent norm (${hrv.recent_avg} vs ${hrv.baseline_avg} ms) while session ratings fell from ${performance.baseline_avg} to ${performance.recent_avg}.`
        : verdict === "absent"
          ? "Either overnight HRV or rated sessions are too thin to compare, so this arm says nothing."
          : "Overnight recovery and rated sessions are not both drifting downward.",
    evidence_keys: [
      ...(hrv.direction === "absent" ? [] : [`hrv_trend:${asOf}:${hrv.direction}:n=${hrv.samples}`]),
      ...(performance.direction === "absent"
        ? []
        : [`sessions.performance:${asOf}:${performance.direction}:n=${performance.samples}`]),
    ],
  };
}

/**
 * Is the scale falling FASTER than the cut is asking for?
 *
 * Both halves come from reads that already exist: the intended pace is the cut
 * derivation's own `pace_lb_wk`, and the actual one is the robust expenditure trend.
 * A trend the expenditure read will not vouch for is ABSENT — reading a low-confidence
 * trend here would be inventing a loss rate from two weigh-ins.
 */
function lossPaceArm(asOf: string): EnergyDeficiencyArm {
  let trend: number | null = null;
  let confidence = "none";
  try {
    const estimate = estimateExpenditure(28, { asOf }) as any;
    trend = finite(estimate?.trend_lb_wk);
    confidence = String(estimate?.confidence ?? "none");
  } catch {
    trend = null;
  }
  let intended: number | null = null;
  try {
    intended = finite(deriveCutTarget(asOf)?.pace_lb_wk);
  } catch {
    intended = null;
  }
  if (trend == null || !["medium", "high"].includes(confidence) || intended == null || intended <= 0) {
    return {
      key: "loss_pace",
      verdict: "absent",
      summary: "There is no robust weight trend and intended pace to compare, so this arm says nothing.",
      evidence_keys: [],
    };
  }
  const loss = trend < 0 ? Math.abs(trend) : 0;
  const ceiling = intended * 1.25;
  return {
    key: "loss_pace",
    verdict: loss > ceiling ? "met" : "not_met",
    summary:
      loss > ceiling
        ? `The robust weight trend is falling ${round(loss)} lb a week against an intended ${round(intended)} lb.`
        : `The robust weight trend (${round(loss)} lb a week) is inside the pace this cut intends.`,
    evidence_keys: [`expenditure_trend:${asOf}:${confidence}:${round(loss)}`],
  };
}

/**
 * Are the athlete's own mood and energy check-ins drifting down?
 *
 * Floored at four ratings a side, and compared against their OWN prior fortnight —
 * this is a direction, not a grade, and a fortnight nobody filled in is absent.
 */
function moodEnergyArm(asOf: string): EnergyDeficiencyArm {
  const span = 14;
  const recentFrom = addDaysISO(asOf, -(span - 1)) ?? asOf;
  const priorTo = addDaysISO(recentFrom, -1) ?? recentFrom;
  const priorFrom = addDaysISO(priorTo, -(span - 1)) ?? priorTo;
  let rows: any[] = [];
  try {
    rows = db
      .prepare(`SELECT date, mood, energy FROM checkins WHERE date BETWEEN ? AND ? ORDER BY date LIMIT 200`)
      .all(priorFrom, asOf) as any[];
  } catch {
    rows = [];
  }
  const recent: number[] = [];
  const prior: number[] = [];
  for (const row of rows) {
    const values = [finite(row.mood), finite(row.energy)].filter((value): value is number => value != null);
    if (!values.length) continue;
    (isoDay(row.date) >= recentFrom ? recent : prior).push(mean(values)!);
  }
  if (recent.length < 4 || prior.length < 4) {
    return {
      key: "mood_energy",
      verdict: "absent",
      summary: "There are too few check-ins on either side of the comparison to read a direction.",
      evidence_keys: [],
    };
  }
  const recentAvg = mean(recent)!;
  const priorAvg = mean(prior)!;
  const met = recentAvg <= priorAvg - 0.5;
  return {
    key: "mood_energy",
    verdict: met ? "met" : "not_met",
    summary: met
      ? `Check-in mood and energy have drifted from ${round(priorAvg)} to ${round(recentAvg)} across the two fortnights.`
      : "Check-in mood and energy are broadly holding across the two fortnights.",
    evidence_keys: [`checkins:${priorFrom}..${asOf}:n=${recent.length + prior.length}`],
  };
}

/**
 * Illness-SHAPED signals, repeated. Two separate resting-HR spike episodes against
 * the athlete's own norm inside a month, or two logged illness windows inside two.
 *
 * Two SEPARATE episodes, never two consecutive mornings of one — a single bad night
 * spanning two dates is one event written twice.
 */
function illnessArm(asOf: string): EnergyDeficiencyArm {
  const from = addDaysISO(asOf, -27) ?? asOf;
  const baselineTo = addDaysISO(from, -1) ?? from;
  const baselineFrom = addDaysISO(baselineTo, -27) ?? baselineTo;
  const recent = nightlyByDate("resting_hr", from, asOf);
  const baselineValues = [...nightlyByDate("resting_hr", baselineFrom, baselineTo).values()];
  let episodes = 0;
  let baselineAvg: number | null = null;
  if (baselineValues.length >= 6 && recent.size) {
    baselineAvg = mean(baselineValues)!;
    const bar = recoveryTrendBars({ rhr: baselineAvg }).rhr;
    const spikeDays = [...recent.entries()]
      .filter(([, value]) => value >= baselineAvg! + bar)
      .map(([date]) => date)
      .sort();
    let previous: string | null = null;
    for (const day of spikeDays) {
      const gap = previous == null ? null : daysBetweenISO(day, previous);
      if (previous == null || (gap != null && gap >= 2)) episodes++;
      previous = day;
    }
  }

  let illnessWindows = 0;
  let contextReadable = true;
  const ILLNESS_RE =
    /\b(ill|illness|sick|sickness|flu|fever|cold|covid|infection|virus|unwell|under the weather|sore throat|cough|congest(ed|ion)|sinus)\b/i;
  try {
    const since = addDaysISO(asOf, -59) ?? asOf;
    const rows = db
      .prepare(
        `SELECT title, detail, start_date FROM context_events
          WHERE COALESCE(archived, 0) = 0 AND COALESCE(start_date, '') BETWEEN ? AND ? LIMIT 200`
      )
      .all(since, asOf) as any[];
    illnessWindows = rows.filter((row) => ILLNESS_RE.test(`${row.title ?? ""} ${row.detail ?? ""}`)).length;
  } catch {
    contextReadable = false;
  }

  if (baselineAvg == null && !contextReadable) {
    return {
      key: "illness_recurrence",
      verdict: "absent",
      summary: "Neither a resting-HR norm nor a life-context record is readable, so this arm says nothing.",
      evidence_keys: [],
    };
  }
  if (baselineAvg == null && illnessWindows === 0) {
    return {
      key: "illness_recurrence",
      verdict: "absent",
      summary: "There is no resting-HR norm to judge a spike against, and nothing logged that reads as illness.",
      evidence_keys: [],
    };
  }
  const met = episodes >= 2 || illnessWindows >= 2;
  return {
    key: "illness_recurrence",
    verdict: met ? "met" : "not_met",
    summary: met
      ? `Illness-shaped signals have repeated: ${episodes} separate resting-HR spike episode(s) in the last month and ${illnessWindows} logged illness window(s) in the last two.`
      : "Illness-shaped signals are not repeating across the last month.",
    evidence_keys: [
      ...(baselineAvg == null ? [] : [`resting_hr_episodes:${asOf}:${episodes}`]),
      ...(illnessWindows ? [`context_events.illness:${asOf}:${illnessWindows}`] : []),
    ],
  };
}

/**
 * Are lifts stalling or slipping on evidence that can actually vouch for them?
 *
 * The vouched-compliance law is inherited rather than re-implemented: a lift's
 * `status` is graded only on sessions the comparability filter admits, and a lift
 * without enough of them grades as `new` — which this arm reads as ABSENT. A stale
 * prescription is silence, never a stall.
 */
function liftStallArm(asOf: string): EnergyDeficiencyArm {
  let lifts: any[] = [];
  try {
    lifts = (getProgramState(asOf) as any)?.lifts ?? [];
  } catch {
    lifts = [];
  }
  const graded = (Array.isArray(lifts) ? lifts : []).filter((lift) => lift?.status && lift.status !== "new");
  if (graded.length === 0) {
    return {
      key: "lift_stall",
      verdict: "absent",
      summary: "No lift has enough comparable history to grade, so this arm says nothing.",
      evidence_keys: [],
    };
  }
  const stalled = graded.filter((lift) => ["regressing", "plateaued"].includes(String(lift.status)));
  return {
    key: "lift_stall",
    verdict: stalled.length >= 2 ? "met" : "not_met",
    summary:
      stalled.length >= 2
        ? `${stalled.length} of ${graded.length} graded lifts are stalled or slipping on comparable sessions.`
        : `Comparable sessions have ${graded.length - stalled.length} of ${graded.length} graded lifts still moving.`,
    evidence_keys: [`program_state.lifts:${asOf}:stalled=${stalled.length}/${graded.length}`],
  };
}

/**
 * All five arms for one date. Exported so the sustain check can ask the same
 * question of an earlier day rather than approximating one.
 */
export function energyDeficiencyArms(asOf: string): EnergyDeficiencyArm[] {
  return [recoveryAndPerformanceArm(asOf), lossPaceArm(asOf), moodEnergyArm(asOf), illnessArm(asOf), liftStallArm(asOf)];
}

// ---- the pure decision --------------------------------------------------------

export type EnergyDeficiencyStateKind =
  | "not_watching"
  | "insufficient_signal"
  | "clear"
  | "emerging"
  | "sustained_cluster";

export interface EnergyDeficiencyInput {
  as_of: string;
  /** True only during an affirmed cut with a target under a MEASURED maintenance. */
  cut_active: boolean;
  arms: EnergyDeficiencyArm[];
  /** The same five arms, evaluated SUSTAINED_DAYS earlier. */
  arms_before: EnergyDeficiencyArm[];
  tdee_kcal: number | null;
  tdee_basis: CutTdeeBasis | null;
  active_target_kcal: number | null;
}

export interface EnergyDeficiencyProtection {
  raise: boolean;
  from_kcal: number | null;
  target_kcal: number | null;
  capped: boolean;
  /** MACHINE register. `energyDeficiencyBody` owns what a person reads. */
  reason: string;
}

export interface EnergyDeficiencyRead {
  as_of: string;
  state: EnergyDeficiencyStateKind;
  arms: EnergyDeficiencyArm[];
  met_keys: EnergyDeficiencyArmKey[];
  met_keys_before: EnergyDeficiencyArmKey[];
  sustained: boolean;
  protection: EnergyDeficiencyProtection;
  reason: string;
  signature: string;
}

function metKeys(arms: EnergyDeficiencyArm[]): EnergyDeficiencyArmKey[] {
  return (Array.isArray(arms) ? arms : []).filter((arm) => arm?.verdict === "met").map((arm) => arm.key);
}

/**
 * The watch's verdict for one day.
 *
 * PURE: no clock, no database, no writes. Every branch that could act is bounded by
 * `capProtectiveRaise`, so nothing here can lift a target past measured maintenance
 * and nothing here can lift one at all on an unmeasured maintenance.
 */
export function energyDeficiencyDecision(input: EnergyDeficiencyInput): EnergyDeficiencyRead {
  const asOf = isoDay(input?.as_of);
  const arms = Array.isArray(input?.arms) ? input.arms : [];
  const before = Array.isArray(input?.arms_before) ? input.arms_before : [];
  const met = metKeys(arms);
  const metBefore = metKeys(before);
  const sustained = met.length >= MIN_CLUSTER_ARMS && metBefore.length >= MIN_CLUSTER_ARMS;
  const readable = arms.filter((arm) => arm.verdict !== "absent").length;

  let state: EnergyDeficiencyStateKind;
  if (!input?.cut_active) state = "not_watching";
  else if (readable < MIN_CLUSTER_ARMS && met.length < MIN_CLUSTER_ARMS) state = "insufficient_signal";
  else if (sustained) state = "sustained_cluster";
  else if (met.length >= MIN_CLUSTER_ARMS) state = "emerging";
  else state = "clear";

  const active = finite(input?.active_target_kcal);
  const tdee = finite(input?.tdee_kcal);
  let protection: EnergyDeficiencyProtection = {
    raise: false,
    from_kcal: active,
    target_kcal: null,
    capped: false,
    reason:
      state === "sustained_cluster"
        ? "The cluster is standing, but there is no accepted target and measured maintenance to move between."
        : "No protective move: the cluster is not standing.",
  };
  if (state === "sustained_cluster" && active != null && tdee != null) {
    // Toward maintenance, in the same bounded 100-250 kcal step every other fuel move
    // uses — then through the ONE function allowed to lift a target, which is what
    // makes measured maintenance the ceiling and a formula anchor a refusal.
    const room = tdee - active;
    const wanted = active + Math.min(MAX_PROTECTIVE_STEP_KCAL, Math.max(MIN_PROTECTIVE_STEP_KCAL, Math.round(room)));
    const capped = capProtectiveRaise(wanted, active, tdee, input?.tdee_basis ?? null);
    const target = Math.round(capped.target_kcal);
    const raise = target - active >= MIN_PROTECTIVE_STEP_KCAL;
    protection = {
      raise,
      from_kcal: active,
      target_kcal: raise ? target : null,
      capped: capped.capped,
      reason: raise
        ? `Two independent arms have held for ${SUSTAINED_DAYS} days, so the target moves ${target - active} kcal toward the measured maintenance of ${tdee} kcal.`
        : input?.tdee_basis === "logged_reality"
          ? `The target is already within ${MIN_PROTECTIVE_STEP_KCAL} kcal of measured maintenance, so protection has nothing left to buy.`
          : "Maintenance here is an estimate rather than a measurement, so protection holds the target where it is rather than buying a raise it cannot ground.",
    };
  }

  const reason =
    state === "not_watching"
      ? "No affirmed deficit is running, so there is nothing for this watch to read."
      : state === "insufficient_signal"
        ? "Too few of the five channels are producing evidence to read a cluster either way."
        : state === "sustained_cluster"
          ? `${met.join(", ")} have agreed for at least ${SUSTAINED_DAYS} days while the deficit ran.`
          : state === "emerging"
            ? `${met.join(", ")} agree today, but the cluster has not been standing long enough to act on.`
            : "The readable channels do not agree that the deficit is costing more than fat.";

  return {
    as_of: asOf,
    state,
    arms,
    met_keys: met,
    met_keys_before: metBefore,
    sustained,
    protection,
    reason,
    signature: createHash("sha256")
      .update(JSON.stringify({ as_of: asOf, state, met: [...met].sort(), before: [...metBefore].sort() }))
      .digest("hex"),
  };
}

// ---- the words a person reads -------------------------------------------------
//
// Variant sets, rotated on the date, in the athlete's own register: what the pattern
// looks like and what was done about it. No clinical vocabulary, no diagnosis, no
// score, and nothing the athlete has to do — the change has already been made for
// them and can be undone with one tap.

const CLUSTER_BODIES: readonly string[] = [
  "A few things have been drifting the same way at once — recovery, how sessions feel, how fast the scale is moving. Taken together, the deficit looks like it's costing more than fat, so your food has moved back toward where you hold steady.",
  "Several separate signals have been pointing the same direction for a week and a half now. That pattern usually means the deficit is buying more than fat loss, so your calories step back toward maintenance for a while.",
  "Recovery, training and the scale have all been leaning the same way lately. That combination is worth easing rather than pushing through, so your target moves up toward the level you maintain on.",
  "The last stretch has a shape to it: things that normally move independently have all softened together. Rather than press on, your food goes back toward steady ground and we watch what recovers.",
];

export function energyDeficiencyBody(read: EnergyDeficiencyRead, date: string): string {
  return pickVariant(CLUSTER_BODIES, date, "energy_deficiency_body");
}

/** One flat pool of every athlete-facing literal here, for the grammar test. */
export function energyDeficiencyGrammarPool(): string[] {
  return [...CLUSTER_BODIES];
}

// Local copy of the day-variant rotation, for the reason cut-target.ts keeps one: a
// module under the nutrition read must not pull the day-read rule engine in behind it.
function pickVariant<T>(variants: readonly T[], date: string, key = ""): T {
  if (variants.length <= 1) return variants[0];
  const ms = Date.parse(`${isoDay(date)}T00:00:00Z`);
  const dayIndex = Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : 0;
  let offset = 0;
  for (let i = 0; i < key.length; i++) offset = (offset * 31 + key.charCodeAt(i)) % 9973;
  const span = variants.length;
  return variants[(((dayIndex + offset) % span) + span) % span];
}

// ---- the thin DB-facing read --------------------------------------------------

/**
 * Is an actual deficit running right now?
 *
 * Both halves of the spec's gate: the athlete's cut is theirs and still standing
 * (`cutReaffirmation`), and the number they are eating to sits under a MEASURED
 * maintenance. A target below a formula estimate is not evidence of a deficit — it is
 * evidence of an estimate — which is the same reason the protective raise refuses to
 * ride one.
 */
function deficitIsRunning(asOf: string, derivation: ReturnType<typeof deriveCutTarget>, active: number | null): boolean {
  let reaffirmed = false;
  try {
    reaffirmed = cutReaffirmation(asOf).reaffirmed;
  } catch {
    reaffirmed = false;
  }
  if (!reaffirmed) return false;
  if (derivation?.tdee_basis !== "logged_reality") return false;
  const tdee = finite(derivation?.tdee_kcal);
  if (tdee == null) return false;
  return active != null && active < tdee;
}

export function energyDeficiencyState(asOf: string = localDateISO()): EnergyDeficiencyInput {
  const today = DATE_RE.test(String(asOf)) ? String(asOf) : localDateISO();
  let derivation: ReturnType<typeof deriveCutTarget> = null;
  try {
    derivation = deriveCutTarget(today);
  } catch {
    derivation = null;
  }
  let active: number | null = null;
  try {
    active = finite((getLatestNutritionTarget(today) as any)?.target_kcal);
  } catch {
    active = null;
  }
  const cutActive = deficitIsRunning(today, derivation, active);
  // The earlier evaluation is what turns "two arms today" into "two arms that have
  // been standing", and it is the same function rather than a proxy for it. Skipped
  // entirely when no deficit is running, so the common case pays for nothing.
  const before = addDaysISO(today, -SUSTAINED_DAYS) ?? today;
  return {
    as_of: today,
    cut_active: cutActive,
    arms: cutActive ? energyDeficiencyArms(today) : [],
    arms_before: cutActive ? energyDeficiencyArms(before) : [],
    tdee_kcal: finite(derivation?.tdee_kcal),
    tdee_basis: derivation?.tdee_basis ?? null,
    active_target_kcal: active,
  };
}

/** The whole watch in one call: assemble, then decide. Read-only. */
export function energyDeficiencyRead(asOf: string = localDateISO()): EnergyDeficiencyRead {
  return energyDeficiencyDecision(energyDeficiencyState(asOf));
}
