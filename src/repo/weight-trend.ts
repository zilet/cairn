// THE WEIGHT TREND — one rate, one on-pace verdict, every surface.
//
// Four surfaces used to print four figures for one scale: Today's path (−0.93, "needs
// −0.98"), the Body page (−0.9 "on pace"), the Season (−0.87 off a different window) and
// What moved ("1.0 lb lower than the week before"). Each fit its own window and judged
// "on pace" by its own tolerance. This read is the one answer:
//   - the RATE is goalPace's trailing least-squares slope (≤21 days of canonical
//     weigh-ins) read off ONE window (GOAL_PACE_WINDOW_DAYS), rounded ONCE to a tenth;
//   - the NEEDED rate is goalPace's straight line to the goal, rounded the same way;
//   - the VERDICT compares the two with one tolerance (`paceVerdict`);
//   - every number reaches a person through display-words in the athlete's weight
//     unit, so "−0.9 lb/wk" on one surface is "−0.4 kg/wk" on all of them.
// Stored values stay lb. Information, never a verdict on the person; no score.
import type { WeightPaceVerdict, WeightTrendRead } from "../contracts/week-read.js";
import { daysBetweenISO } from "../lib/dates.js";
import { round1 } from "../lib/numbers.js";
import {
  dateWords,
  sinceWords,
  weightRateValue,
  weightRateWords,
  weightWords,
  type WeightUnit,
} from "./display-words.js";
import { goalPace, type GoalPaceResult } from "./goal-pace.js";
import { effectiveGoalMode, getProfile } from "./profile.js";
import { athleteUnits } from "./settings.js";
import { addDaysISO, localDateISO } from "./shared.js";

/** The one window every weight-trend surface reads (the trend itself fits the last ≤21 days of it). */
export const GOAL_PACE_WINDOW_DAYS = 90;
/** A rate under this (lb/wk, either way) is holding, not moving. */
export const WEIGHT_HOLDING_LB_WK = 0.1;
/** The 7-day average must move at least this much (lb) to be news in What moved. */
export const WEIGHT_WEEK_CHANGE_MIN_LB = 0.4;

export type { WeightPaceVerdict, WeightTrendRead } from "../contracts/week-read.js";


/**
 * The one on-pace rule: progress toward the goal per week against the rate the line
 * asks, within one tolerance (a tenth of a pound or 15% of the ask, whichever is wider).
 * Inputs are the ROUNDED rates, so the verdict and the printed figures always agree.
 */
export function paceVerdict(rate: number | null, needed: number | null): WeightPaceVerdict | null {
  if (rate == null) return null;
  if (needed == null || needed === 0) return Math.abs(rate) < WEIGHT_HOLDING_LB_WK ? "steady" : null;
  const dir = Math.sign(needed);
  const progress = rate * dir;
  const ask = Math.abs(needed);
  const tolerance = Math.max(0.1, ask * 0.15);
  if (Math.abs(progress - ask) <= tolerance + 1e-9) return "on_pace";
  return progress > ask ? "ahead" : "behind";
}

const VERDICT_WORDS: Record<WeightPaceVerdict, string> = {
  on_pace: "on pace",
  ahead: "ahead of the line",
  behind: "behind the line",
  steady: "holding steady",
};

function weekChange(pace: GoalPaceResult, today: string, units: WeightUnit): WeightTrendRead["week_change"] {
  const thisStart = addDaysISO(today, -6) ?? today;
  const priorStart = addDaysISO(today, -13) ?? today;
  const recent = pace.points.filter((p) => p.date >= thisStart && p.date <= today);
  const prior = pace.points.filter((p) => p.date >= priorStart && p.date < thisStart);
  if (recent.length < 2 || prior.length < 2) return null;
  const mean = (xs: { weight_lb: number }[]) => xs.reduce((s, x) => s + x.weight_lb, 0) / xs.length;
  const a = round1(mean(recent));
  const b = round1(mean(prior));
  const delta = round1(a - b);
  if (Math.abs(delta) < WEIGHT_WEEK_CHANGE_MIN_LB) return null;
  return {
    avg_lb: a,
    prior_avg_lb: b,
    delta_lb: delta,
    since: priorStart,
    since_words: sinceWords(priorStart, today),
    words: `${weightWords(Math.abs(delta), units)} ${delta < 0 ? "lower" : "higher"} than the week before`,
  };
}

/**
 * The weight trend as of `asOf`, in the athlete's units (or `opts.units`). Never throws;
 * an athlete with no weigh-ins gets a read of nulls.
 */
export function weightTrendRead(asOf?: string, opts: { units?: WeightUnit; pace?: GoalPaceResult } = {}): WeightTrendRead {
  const today = String(asOf || localDateISO()).slice(0, 10);
  const units = opts.units ?? athleteUnits().weight;
  const empty: WeightTrendRead = {
    as_of: today,
    units,
    mode: null,
    current: null,
    goal: null,
    rate_lb_wk: null,
    rate_value: null,
    needed_lb_wk: null,
    needed_value: null,
    rate_words: null,
    needed_words: null,
    verdict: null,
    verdict_words: null,
    line: null,
    window: null,
    week_change: null,
  };
  let pace: GoalPaceResult;
  try {
    pace = opts.pace ?? goalPace(GOAL_PACE_WINDOW_DAYS, today);
  } catch {
    return empty;
  }
  let profile: any = null;
  try {
    profile = getProfile();
  } catch {
    profile = null;
  }
  const last = pace.points.at(-1) ?? null;
  const rate = pace.trend.lb_wk != null ? round1(pace.trend.lb_wk) : null;
  const needed = pace.needed.lb_wk != null ? round1(pace.needed.lb_wk) : null;
  const verdict = paceVerdict(rate, needed);
  const goalLb = pace.goal.weight_lb;
  const goalDateWords = pace.goal.date ? dateWords(pace.goal.date, today) : null;
  const windowSince = pace.trend.line?.[0]?.date ?? null;
  const windowPoints = windowSince ? pace.points.filter((p) => p.date >= windowSince).length : 0;

  let line: string | null = null;
  if (rate != null) {
    const rateWords = weightRateWords(rate, units);
    if (verdict && verdict !== "steady" && goalDateWords) {
      line =
        verdict === "behind" && needed != null
          ? `Trending ${rateWords}; ${weightRateWords(needed, units)} would meet ${goalDateWords}.`
          : `Trending ${rateWords} — ${VERDICT_WORDS[verdict]} for ${goalDateWords}.`;
    } else if (verdict === "steady") {
      line = `Holding steady (${rateWords}).`;
    } else {
      line = goalDateWords ? `Trending ${rateWords} toward ${goalDateWords}.` : `Trending ${rateWords}.`;
    }
  }

  let mode: WeightTrendRead["mode"] = null;
  try {
    mode = effectiveGoalMode(profile) as WeightTrendRead["mode"];
  } catch {
    mode = null;
  }

  return {
    as_of: today,
    units,
    mode,
    current: last
      ? {
          lb: round1(last.weight_lb),
          date: last.date,
          words: weightWords(last.weight_lb, units),
          date_words: dateWords(last.date, today, "relative"),
        }
      : null,
    goal:
      goalLb != null
        ? { lb: round1(goalLb), date: pace.goal.date, words: weightWords(goalLb, units), date_words: goalDateWords }
        : null,
    rate_lb_wk: rate,
    rate_value: rate != null ? weightRateValue(rate, units) : null,
    needed_lb_wk: needed,
    needed_value: needed != null ? weightRateValue(needed, units) : null,
    rate_words: rate != null ? weightRateWords(rate, units) : null,
    needed_words: needed != null ? weightRateWords(needed, units) : null,
    verdict,
    verdict_words: verdict ? VERDICT_WORDS[verdict] : null,
    line,
    window:
      windowSince && last
        ? {
            since: windowSince,
            through: last.date,
            weigh_ins: windowPoints,
            since_words: sinceWords(windowSince, today),
          }
        : null,
    week_change: weekChange(pace, today, units),
  };
}

/** Days until the goal date, or null. */
export function weightGoalDaysLeft(read: WeightTrendRead): number | null {
  return read.goal?.date ? daysBetweenISO(read.goal.date, read.as_of) : null;
}
