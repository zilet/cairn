// The DAY's energy number, prepared from the week's plan. The accepted calorie target is
// the WEEK'S AVERAGE and stays the one authoritative number for every weekly reader (the
// adaptive loop, expenditure, the cut floors, the meal plan's headline). This read only
// redistributes that average across the days of the week by the work each day is planned
// to carry, so a long-run day is given more and a rest day less, and the week still sums
// to seven times the average. Protein never moves.
//
// The cost of a day's planned work is a rough estimate, said as "about":
//   - running: about 1 kcal per kg per km, largely independent of speed (Margaria,
//     Cerretelli, Aghemo & Sassi, "Energy cost of running", J Appl Physiol 1963;18:367-370);
//   - an hour of lifting: about 3.5 MET (2011 Compendium of Physical Activities, Ainsworth
//     et al., Med Sci Sports Exerc 2011;43(8):1575-1581), 2.5 kcal per kg net of rest;
//   - an hour of steady riding or other cross-training: about 7 MET, 6 kcal per kg net.
// Because those are rough, only DAY_SHIFT_SHARE of each day's difference from the week's
// mean moves, and never more than DAY_SHIFT_CAP_SHARE of the average either way. A day
// never drops under the absolute calorie floor.
//
// PLAN-based, on purpose: a run the agenda planned is costed at its planned distance on
// the day it is placed (or the day it was run), never at what a watch said was burned. A
// week already over is not re-read (its plan is gone; fuel-demand.ts holds the same law),
// so a past week's days keep the average.
import { resolvedCurrentBodyweight } from "./bodyweight.js";
import { fuelDemandWeek } from "./fuel-demand.js";
import { flexibleTrainingAgenda } from "./flexible-training-agenda.js";
import type { FlexibleRunKind } from "./flexible-training-agenda.js";
import { ABSOLUTE_KCAL_FLOOR } from "./nutrition-safety.js";
import { calendarDayRead } from "./plan-selection.js";
import { copyDeep, requestMemo } from "./request-memo.js";
import { LB_PER_KG, addDaysISO, localDateISO } from "./shared.js";
import { mondayOf } from "../lib/dates.js";

export const RUN_KCAL_PER_KG_KM = 1;
export const LIFT_NET_KCAL_PER_KG = 2.5;
export const CROSS_NET_KCAL_PER_KG = 6;
/** The share of a day's cost difference from the week's mean that moves with the day. */
export const DAY_SHIFT_SHARE = 0.5;
/** The most a day moves either way, as a share of the weekly average. */
export const DAY_SHIFT_CAP_SHARE = 0.15;
/** A week whose largest shift is smaller than this is not worth different numbers. */
export const DAY_SHIFT_MIN_KCAL = 50;

export interface DayEnergy {
  date: string;
  /** The accepted target: the week's average. */
  average_kcal: number;
  /** The day's number, rounded to ten. Equal to the average when nothing moves it. */
  kcal: number;
  shift_kcal: number;
  /** What the day's planned work is, in words ("the long run", "lifting"). */
  work: string[];
  /** One sentence saying the number and why; null when the day sits at the average. */
  words: string | null;
}

interface WeekShape {
  /** date → { shift, work } for the seven days; absent when the week cannot be shaped. */
  days: Record<string, { shift: number; work: string[] }>;
}

const RUN_WORDS: Record<FlexibleRunKind, string> = { long: "the long run", quality: "the quality run", easy: "the easy run" };
const kcalWords = (n: number) => (Math.round(n / 10) * 10).toLocaleString("en-US");

function shapeWeek(week: string, today: string, average: number): WeekShape {
  const empty: WeekShape = { days: {} };
  if (week < mondayOf(today)) return empty;
  const lb = Number(resolvedCurrentBodyweight(undefined, today)?.weight_lb);
  if (!Number.isFinite(lb) || lb <= 0) return empty;
  const kg = lb / LB_PER_KG;
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) dates.push(i === 0 ? week : (addDaysISO(week, i) ?? week));
  const cost = new Map<string, { kcal: number; work: string[]; run: boolean }>(dates.map((d) => [d, { kcal: 0, work: [], run: false }]));

  let agenda: ReturnType<typeof flexibleTrainingAgenda> | null = null;
  try {
    agenda = flexibleTrainingAgenda(week === mondayOf(today) ? today : week);
  } catch {
    agenda = null;
  }
  if (agenda?.available) {
    for (const intent of agenda.intents) {
      if (intent.status === "open" && intent.adjustment?.dose === "rest") continue;
      const day = cost.get(String(intent.completion?.date ?? intent.suggested_date ?? ""));
      const km = Number(intent.planned_distance_km ?? intent.target_distance_km ?? intent.completion?.distance_km);
      if (!day || !Number.isFinite(km) || km <= 0) continue;
      day.kcal += km * kg * RUN_KCAL_PER_KG_KM;
      day.work.push(RUN_WORDS[intent.kind] ?? "the run");
      day.run = true;
    }
  }
  let demand: ReturnType<typeof fuelDemandWeek> | null = null;
  try {
    demand = fuelDemandWeek(week, 7, { today, ...(week === mondayOf(today) && agenda ? { agenda } : {}) });
  } catch {
    demand = null;
  }
  for (const date of dates) {
    const day = cost.get(date)!;
    let lift = false;
    try {
      lift = calendarDayRead(date)?.kind === "lift";
    } catch {
      lift = false;
    }
    const drivers = demand?.days.find((d) => d.date === date)?.drivers ?? [];
    // A day the read calls rest or easy this morning is not a lifting day's worth of work.
    if (lift && demand?.days.find((d) => d.date === date)?.demand !== "light") {
      day.kcal += kg * LIFT_NET_KCAL_PER_KG;
      day.work.push("lifting");
    }
    const cross = drivers.find((d) => /you named|your usual|long ride or endurance session/.test(d));
    if (cross && !day.run) {
      day.kcal += kg * CROSS_NET_KCAL_PER_KG;
      day.work.push(/long ride or endurance session/.test(cross) ? "the long session" : cross.replace(/^the optional /, "the "));
    }
  }

  const costs = dates.map((d) => cost.get(d)!.kcal);
  const mean = costs.reduce((a, b) => a + b, 0) / 7;
  if (!(mean > 0)) return empty;
  const cap = average * DAY_SHIFT_CAP_SHARE;
  const clamp = (n: number) => Math.max(-cap, Math.min(cap, n));
  let shifts = costs.map((c) => clamp((c - mean) * DAY_SHIFT_SHARE));
  // A clamped day leaves the week off its average; hand the remainder to the days with room.
  for (let pass = 0; pass < 3; pass++) {
    const residual = shifts.reduce((a, b) => a + b, 0);
    const free = shifts.map((s, i) => i).filter((i) => Math.abs(shifts[i]) < cap - 1);
    if (Math.abs(residual) < 5 || !free.length) break;
    shifts = shifts.map((s, i) => (free.includes(i) ? clamp(s - residual / free.length) : s));
  }
  // A week whose biggest move is small is left flat as a whole; zeroing single days would
  // take the week off its average.
  const flatWeek = Math.max(...shifts.map(Math.abs)) < DAY_SHIFT_MIN_KCAL;
  const days: WeekShape["days"] = {};
  dates.forEach((date, i) => {
    days[date] = { shift: flatWeek ? 0 : Math.round(shifts[i] / 10) * 10, work: cost.get(date)!.work };
  });
  return { days };
}

/**
 * The day's energy number for `date`, given the accepted weekly-average target. Never
 * throws: a week that cannot be shaped answers the average itself.
 */
export function dayEnergyTarget(date: string, averageKcal: number, opts: { today?: string } = {}): DayEnergy {
  const today = opts.today || localDateISO();
  const average = Math.round(Number(averageKcal));
  const flat: DayEnergy = { date, average_kcal: average, kcal: average, shift_kcal: 0, work: [], words: null };
  if (!Number.isFinite(average) || average <= ABSOLUTE_KCAL_FLOOR) return flat;
  let shape: WeekShape;
  try {
    const week = mondayOf(date);
    shape = requestMemo(`day_energy_week:${week}|${today}|${average}`, () => shapeWeek(week, today, average), copyDeep);
  } catch {
    return flat;
  }
  const day = shape.days[date];
  if (!day) return flat;
  if (!day.shift) return { ...flat, work: day.work };
  // A moved number is said to the ten everywhere it is printed, so the meter and the
  // sentence can never show two different figures.
  const kcal = Math.max(ABSOLUTE_KCAL_FLOOR, Math.round((average + day.shift) / 10) * 10);
  const shift = kcal - average;
  if (!shift) return { ...flat, work: day.work };
  // A few tens of kcal either way is the same number in words.
  if (Math.abs(shift) < DAY_SHIFT_MIN_KCAL) return { date, average_kcal: average, kcal, shift_kcal: shift, work: day.work, words: null };
  const which = date === today ? "Today's" : "This day's";
  const work = day.work.length ? day.work.join(" and ") : "";
  const words =
    shift > 0
      ? `${which} number is about ${kcalWords(kcal)} kcal: your ${kcalWords(average)} average plus about ${kcalWords(shift)}${work ? ` for ${work}` : ""}. The week still averages ${kcalWords(average)}.`
      : `${which} number is about ${kcalWords(kcal)} kcal: your ${kcalWords(average)} average less about ${kcalWords(-shift)}, ${work ? `with only ${work} planned` : "a lighter day"}. That room goes to the week's bigger days.`;
  return { date, average_kcal: average, kcal, shift_kcal: shift, work: day.work, words };
}

/**
 * A day's intake read with the DAY's energy number in place of the weekly average:
 * `target.kcal` and `remaining.kcal` move, `target.average_kcal` keeps the accepted number
 * and `target.day_words` says why. Protein is untouched. An intake with no target, or a
 * day that sits at the average, comes back as it was (with `average_kcal` named).
 */
export function withDayEnergy<T extends { date: string; totals: { kcal: number }; target: any; remaining: any }>(
  intake: T,
  opts: { today?: string } = {}
): T {
  const average = Number(intake?.target?.kcal);
  if (!intake?.target || !Number.isFinite(average) || intake.target.average_kcal != null) return intake;
  const day = dayEnergyTarget(intake.date, average, opts);
  return {
    ...intake,
    target: { ...intake.target, kcal: day.kcal, average_kcal: day.average_kcal, day_shift_kcal: day.shift_kcal, day_words: day.words },
    remaining: intake.remaining ? { ...intake.remaining, kcal: day.kcal - Number(intake.totals?.kcal || 0) } : intake.remaining,
  };
}
