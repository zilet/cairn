// The DAY's energy number, prepared from the week's plan. The accepted calorie target is
// the WEEK'S AVERAGE and stays the one authoritative number for every weekly reader (the
// adaptive loop, expenditure, the cut floors, the meal plan's headline). This read only
// redistributes that average across the days of the week by the work each day is planned
// to carry, so a long-run day is given more and a rest day less, and the week still sums
// to seven times the average. Protein never moves.
//
// The cost of a day's work is a rough estimate, said as "about":
//   - running: about 1 kcal per kg per km, largely independent of speed (Margaria,
//     Cerretelli, Aghemo & Sassi, "Energy cost of running", J Appl Physiol 1963;18:367-370);
//   - an hour of lifting: about 3.5 MET (code 02054, the same in the 2011 and 2024
//     Compendium of Physical Activities: Ainsworth et al., Med Sci Sports Exerc
//     2011;43(8):1575-1581; Herrmann et al., J Sport Health Sci 2024;13(1):6-12), 2.5 kcal
//     per kg net of rest;
//   - an hour of steady riding or other cross-training: about 7 MET (2024 code 01014,
//     bicycling, general), 6 kcal per kg net. Margaria's running figure is net of rest too,
//     the right reading here: the weekly average already holds resting energy;
//   - an hour of brisk walking or hiking: roughly 4.5 MET (the Compendium's walking
//     entries run about 3.5-5.5 MET and cross-country hiking 6.0), taken as about 3.5 kcal per
//     kg net: right for a brisk level walk, low for a hill hike. Approximate.
// A session the load read calls light (yoga, mobility, an easy stroll) carries no cost:
// that kind of day is already in the activity level the average is worked out from.
// Because those are rough (about ±20-30%), only DAY_SHIFT_SHARE of each day's difference
// from the week's mean moves, never more than DAY_SHIFT_CAP_SHARE of the average either
// way, and every move is said in fifties (DAY_SHIFT_STEP_KCAL): a day's number is the
// average plus a multiple of 50, so its sentence's parts add up exactly and claim no
// precision the costs do not have. A day never drops under the absolute calorie floor.
//
// Which work, by where the day sits:
//   - a day of this week or a later one is shaped by the PLAN, read as the week stood the
//     day before it opened (`weekEve`): the run engine's week as planned at its boundary
//     (last week's actuals, the legs, the recovery read and the program state of that
//     eve, never this morning's re-decision), each run costed at its planned distance on
//     the day the WEEK placed it, never on the day it was run or the day the agenda now
//     suggests; the lifting weekdays as of that eve (a stated strength schedule applies at
//     once, the observed pattern never sees this week's log) as an hour of lifting each;
//     the known cross-training day as of that eve as an hour of it; the bodyweight as of
//     that eve. So nothing logged this week, and no morning read, moves a day's PLAN
//     number: a morning that turns a run to rest leaves its day the planned cost. A week
//     the engine had no run plan for at its start carries no run cost; its logged runs are
//     outcomes on their own days;
//   - a week already over has no plan left (fuel-demand.ts holds the same law), so it is
//     shaped by what was LOGGED, with the same costs and the same rules: runs at their
//     logged distance, a day with a logged lifting session as an hour of lifting, other
//     sessions by their logged time. That week still sums to seven times the average;
//   - today and the days already lived this week keep their plan number, and a clear
//     departure from the plan moves that ONE day by DAY_SHIFT_SHARE of the difference
//     (`outcome_shift_kcal`), never handed to the other days: a session the plan did not
//     carry adds its cost, a planned run done clearly longer or shorter on its placed day
//     is costed at its logged distance, and a planned run done on another day is extra
//     work on the day it was run (its placed day keeps the plan number). Planned work not
//     logged never lowers a day and is never taken back from another day. The day's whole
//     move (plan and outcome) stays inside the cap and above the floor.
// There is deliberately no reserve for food left unlogged: the adaptive expenditure
// estimate is worked out from logged intake against the weight trend, so a steady
// under-log is already inside the accepted average.
// Watch calories are never read anywhere here.
import { resolvedCurrentBodyweight } from "./bodyweight.js";
import { withMorningReadiness } from "./brain/read-adherence.js";
import { getRecoverySummary } from "./coach.js";
import { crossTrainingDays, crossTrainingNoun } from "./cross-training-day.js";
import { DAY_SHIFT_STEP_KCAL, inSteps } from "./day-energy-step.js";
import type { CrossTrainingDay } from "./cross-training-day.js";
import type { LoadFamily } from "./endurance-sports.js";
import { weekRunClosures } from "./flexible-training-agenda.js";
import type { FlexibleRunKind, RunClosure } from "./flexible-training-agenda.js";
import { recentEnduranceImpacts, strengthLegLoad } from "./hybrid-load.js";
import type { EnduranceImpact } from "./hybrid-load.js";
import { ABSOLUTE_KCAL_FLOOR } from "./nutrition-safety.js";
import { isoDow } from "./profile.js";
import { getProgramState } from "./program-state.js";
import { copyDeep, requestMemo } from "./request-memo.js";
import { weekAsPlanned, weeklyRunPlan } from "./run-progression.js";
import type { RunPlanPrescription } from "./run-progression.js";
import { completedSessionOnDate } from "./session-dose-log.js";
import { getRunCompliance } from "./sessions.js";
import { LB_PER_KG, addDaysISO, localDateISO } from "./shared.js";
import { liftDows } from "./strength-schedule.js";
import { mondayOf } from "../lib/dates.js";

export const RUN_KCAL_PER_KG_KM = 1;
export const LIFT_NET_KCAL_PER_KG = 2.5;
export const CROSS_NET_KCAL_PER_KG = 6;
/** An hour of a walk or hike the load read does not call light, kcal per kg net (approximate). */
export const WALK_NET_KCAL_PER_KG = 3.5;
/** The share of a day's cost difference from the week's mean that moves with the day. */
export const DAY_SHIFT_SHARE = 0.5;
/** The most a day moves either way, as a share of the weekly average. */
export const DAY_SHIFT_CAP_SHARE = 0.15;
/** A week whose largest shift is smaller than this is not worth different numbers; so is a smaller outcome move. */
export const DAY_SHIFT_MIN_KCAL = 50;
// Every shift, plan and outcome, is a multiple of DAY_SHIFT_STEP_KCAL (day-energy-step.ts,
// shared with the meal plan's split so a plan day lands on the same number).
export { DAY_SHIFT_STEP_KCAL };
/** A planned run done this much longer or shorter (as a share of the planned distance)… */
export const RUN_DISTANCE_CHANGE_SHARE = 0.25;
/** …and by at least this many km is costed at its logged distance. */
export const RUN_DISTANCE_CHANGE_MIN_KM = 2;
/** A day's other sessions under this many minutes in all carry no cost of their own. */
export const CROSS_MIN_MINUTES = 20;
/** A day's other sessions are costed for at most this many hours. */
export const CROSS_MAX_HOURS = 3;

export interface DayEnergy {
  date: string;
  /** The accepted target: the week's average. */
  average_kcal: number;
  /**
   * The day's number: the average plus a multiple of DAY_SHIFT_STEP_KCAL (the average itself
   * is never rounded). Equal to the average when nothing moves it; never under the floor.
   */
  kcal: number;
  /** kcal minus the average: the plan's move and the outcome's together. */
  shift_kcal: number;
  /** The part of shift_kcal that comes from what was actually done today or on a lived day this week (0 when none). */
  outcome_shift_kcal: number;
  /** What the day's work is, in words ("the long run", "lifting"); for a week already over, what was logged. */
  work: string[];
  /** What the outcome added, in words ("the ride you logged"); empty when outcome_shift_kcal is 0. */
  outcome_work: string[];
  /** One sentence saying the number and why; null when the day sits at the average. */
  words: string | null;
}

interface DayShape {
  /** The plan's (or, for a week over, the log's) move, rebalanced across the week. */
  shift: number;
  work: string[];
  /** The outcome's move on this day alone, already held inside the cap. */
  outcome: number;
  outcome_work: string[];
}

interface WeekShape {
  /** date → the day's shape for the seven days; absent when the week cannot be shaped. */
  days: Record<string, DayShape>;
  /** True when the week is over and its days were shaped from the log. */
  logged: boolean;
}

const RUN_WORDS: Record<FlexibleRunKind, string> = { long: "the long run", quality: "the quality run", easy: "the easy run" };
const CROSS_WORDS: Partial<Record<LoadFamily, string>> = {
  ride: "the ride",
  swim: "the swim",
  row: "the row",
  walk: "the hike",
  ski: "the skiing",
  paddle: "the paddle",
};
// A snow-family session is "the skiing" only when its own type key says so (a skate or a
// sled is not); anything else is "the session".
const crossWords = (i: ImpactLike) =>
  i.family === "snow" ? (/ski/i.test(String(i.type ?? "")) ? "the skiing" : "the session") : (CROSS_WORDS[i.family] ?? "the session");
const crossRate = (family: LoadFamily) => (family === "walk" ? WALK_NET_KCAL_PER_KG : CROSS_NET_KCAL_PER_KG);
const kcalWords = (n: number) => (Math.round(n / 10) * 10).toLocaleString("en-US");
const fifties = inSteps;
/** The cap as a multiple of the step, so a rounded day never passes it. */
const capInSteps = (average: number) =>
  Math.floor((average * DAY_SHIFT_CAP_SHARE) / DAY_SHIFT_STEP_KCAL) * DAY_SHIFT_STEP_KCAL;
const finitePositive = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const uniq = (xs: string[]) => [...new Set(xs)];

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

type ImpactLike = Pick<EnduranceImpact, "date" | "family" | "load" | "duration_min" | "distance_km"> & { type?: string };

/**
 * The cost of a day's logged sessions other than running and lifting, by logged time:
 * CROSS_NET_KCAL_PER_KG an hour (WALK_NET_KCAL_PER_KG for a walk or hike), at most
 * CROSS_MAX_HOURS in all, nothing under CROSS_MIN_MINUTES in all. A session the load read
 * calls light, of any kind, carries no cost here (see the header).
 */
function crossCostOn(impacts: ImpactLike[], date: string, kg: number): { kcal: number; words: string[] } {
  const pieces = impacts.filter(
    (i) =>
      String(i.date).slice(0, 10) === date && i.family !== "run" && i.load !== "light" && finitePositive(i.duration_min) != null
  );
  const minutes = pieces.reduce((sum, i) => sum + (finitePositive(i.duration_min) ?? 0), 0);
  if (minutes < CROSS_MIN_MINUTES) return { kcal: 0, words: [] };
  // Past the most an outing is costed for, every piece is scaled down alike.
  const scale = Math.min(1, (CROSS_MAX_HOURS * 60) / minutes);
  const kcal = pieces.reduce((sum, i) => sum + kg * crossRate(i.family) * ((finitePositive(i.duration_min) ?? 0) / 60) * scale, 0);
  return { kcal, words: uniq(pieces.map(crossWords)) };
}

/** One run the week planned, as the outcome read sees it. */
export interface PlannedRunOutcome {
  /** The day the WEEK placed the run (its plan cost sits there). */
  placed_date: string;
  /** The planned distance, km. */
  planned_km: number | null;
  /** The logged run that closed this intention, when one did. */
  completion: { date: string; distance_km: number | null } | null;
}

export interface DayOutcomeInput {
  date: string;
  kg: number;
  /** The week's planned runs, each with the logged run that closed it (weekRunClosures). */
  intents: PlannedRunOutcome[];
  /** Runs logged this week that closed no intention. */
  extras: Array<{ date: string; distance_km: number | null }>;
  /** The logged non-run sessions (runs among them are ignored here: the run week owns runs). */
  impacts: ImpactLike[];
  /** A lifting session is logged on the day. */
  lifted: boolean;
  /** What the day's plan already carried. */
  planned: { lifting: boolean; cross: boolean };
}

/**
 * How far what was DONE on one day departs from what its plan carried, in kcal of cost
 * (before DAY_SHIFT_SHARE), with the words for it. A run that closed an intention ON ITS
 * PLACED DAY is the planned run, costed again only when its logged distance is clearly
 * different (RUN_DISTANCE_CHANGE_*). A run that closed an intention placed on ANOTHER day
 * is extra work on the day it was run, at its logged distance; its placed day keeps the
 * plan's cost and gets nothing from it. A run that closed none is extra, unless a still-open
 * run is placed on that day (then it is read as that run, and the plan's cost stands).
 * Planned work not logged adds nothing and takes nothing away.
 */
export function dayOutcomeCost(input: DayOutcomeInput): { kcal: number; words: string[] } {
  const { date, kg } = input;
  let kcal = 0;
  const words: string[] = [];
  for (const intent of input.intents) {
    const done = intent.completion;
    if (!done || String(done.date) !== date) continue;
    const planned = finitePositive(intent.planned_km);
    const ran = finitePositive(done.distance_km);
    if (String(intent.placed_date) !== date) {
      // Done on another day than the week placed it: extra on the day it was run.
      const km = ran ?? planned;
      if (km == null) continue;
      kcal += km * kg * RUN_KCAL_PER_KG_KM;
      words.push("the run you logged");
      continue;
    }
    if (planned == null || ran == null) continue;
    const diff = ran - planned;
    if (Math.abs(diff) < Math.max(planned * RUN_DISTANCE_CHANGE_SHARE, RUN_DISTANCE_CHANGE_MIN_KM)) continue;
    kcal += diff * kg * RUN_KCAL_PER_KG_KM;
    words.push(diff > 0 ? "the longer run you logged" : "the shorter run you logged");
  }
  const openRunHere = input.intents.some((i) => !i.completion && String(i.placed_date) === date);
  if (!openRunHere) {
    for (const extra of input.extras) {
      if (String(extra.date) !== date) continue;
      const km = finitePositive(extra.distance_km);
      if (km == null) continue;
      kcal += km * kg * RUN_KCAL_PER_KG_KM;
      words.push("the run you logged");
    }
  }
  if (!input.planned.cross) {
    const cross = crossCostOn(input.impacts, date, kg);
    if (cross.kcal > 0) {
      kcal += cross.kcal;
      words.push(...cross.words.map((w) => `${w} you logged`));
    }
  }
  if (input.lifted && !input.planned.lifting) {
    kcal += kg * LIFT_NET_KCAL_PER_KG;
    words.push("the lifting you logged");
  }
  return { kcal, words: uniq(words) };
}

/**
 * The week's costs laid across its days: DAY_SHIFT_SHARE of each day's difference from
 * the mean, inside the cap, the remainder of a clamped day handed to the days with room,
 * and a week whose biggest move is small left flat. Each shift is then said in fifties
 * and the week kept exactly zero-sum (fiftiesZeroSum).
 */
function distribute(costs: number[], average: number): number[] {
  const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
  if (!(mean > 0)) return costs.map(() => 0);
  const cap = capInSteps(average);
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
  if (Math.max(...shifts.map(Math.abs)) < DAY_SHIFT_MIN_KCAL) return costs.map(() => 0);
  return fiftiesZeroSum(shifts, cap);
}

/**
 * Each shift rounded to the nearest DAY_SHIFT_STEP_KCAL, then the rounding residual
 * removed one step at a time from the day whose rounding moved it furthest in the
 * residual's direction, never past `cap` (a multiple of the step) and, while any other
 * day can take it, never onto a day whose unrounded shift was zero. Sums to exactly zero
 * when the unrounded shifts did (to within a few kcal) and any day has room.
 */
export function fiftiesZeroSum(shifts: number[], cap: number): number[] {
  const step = DAY_SHIFT_STEP_KCAL;
  const out = shifts.map((s) => Math.max(-cap, Math.min(cap, fifties(s))));
  let residual = out.reduce((a, b) => a + b, 0);
  for (let guard = 0; residual !== 0 && guard < shifts.length * 4; guard++) {
    const move = residual > 0 ? -step : step;
    const fits = (i: number) => Math.abs(out[i] + move) <= cap;
    // Rounding error in the residual's direction: the day rounded up most gives the step back first.
    const error = (i: number) => (out[i] - shifts[i]) * Math.sign(-move);
    const pick = (pool: number[]) => pool.filter(fits).sort((a, b) => error(b) - error(a) || a - b)[0];
    const all = shifts.map((_, i) => i);
    const i = pick(all.filter((j) => shifts[j] !== 0)) ?? pick(all);
    if (i == null) break;
    out[i] = out[i] + move || 0;
    residual += move;
  }
  return out;
}

function bodyweightKg(through: string, fallback?: string): number | null {
  let lb = Number(safe(() => resolvedCurrentBodyweight(undefined, through)?.weight_lb, undefined));
  if ((!Number.isFinite(lb) || lb <= 0) && fallback) lb = Number(safe(() => resolvedCurrentBodyweight(undefined, fallback)?.weight_lb, undefined));
  return Number.isFinite(lb) && lb > 0 ? lb / LB_PER_KG : null;
}

/** A week already over, shaped from its log. */
function loggedWeek(dates: string[], today: string, average: number): WeekShape {
  const empty: WeekShape = { days: {}, logged: true };
  const sunday = dates[6];
  // The weight as of that week; a week before the first weigh-in reads today's.
  const kg = bodyweightKg(sunday, today);
  if (kg == null) return empty;
  const impacts = safe(() => recentEnduranceImpacts(7, sunday), [] as EnduranceImpact[]);
  const cost = dates.map((date) => {
    let kcal = 0;
    const work: string[] = [];
    const km = impacts
      .filter((i) => String(i.date).slice(0, 10) === date && i.family === "run")
      .reduce((sum, i) => sum + (finitePositive(i.distance_km) ?? 0), 0);
    if (km > 0) {
      kcal += km * kg * RUN_KCAL_PER_KG_KM;
      work.push("the run you logged");
    }
    if (safe(() => completedSessionOnDate(date), null)) {
      kcal += kg * LIFT_NET_KCAL_PER_KG;
      work.push("lifting");
    }
    const cross = crossCostOn(impacts, date, kg);
    if (cross.kcal > 0) {
      kcal += cross.kcal;
      work.push(...cross.words.map((w) => `${w} you logged`));
    }
    return { kcal, work };
  });
  const shifts = distribute(cost.map((c) => c.kcal), average);
  const days: WeekShape["days"] = {};
  dates.forEach((date, i) => {
    days[date] = { shift: shifts[i], work: cost[i].work, outcome: 0, outcome_work: [] };
  });
  return { days, logged: true };
}

/**
 * The run week as PLANNED at its boundary: the engine's week for `week`, read the way
 * run-compliance reads the prescription a week is judged against (last week's actuals, the
 * closed week's volume anchor, no morning re-decision), with the legs, the recovery read and
 * the program state taken as of `eve`, the day before the week opens, so a run, a lift or a
 * morning sync this week cannot move where the runs sit or how long they are. [] when the
 * engine had no run week for it.
 */
function plannedRunWeek(week: string, eve: string): RunPlanPrescription[] {
  const recovery = safe(() => withMorningReadiness(getRecoverySummary(14, undefined, eve), eve), null);
  const plan = weeklyRunPlan(week, {
    compliance: getRunCompliance(addDaysISO(week, -7) ?? eve),
    volumeAnchorDate: eve,
    adjustToday: false,
    legLoad: strengthLegLoad(eve),
    ...(recovery ? { recovery, programState: getProgramState(eve, recovery) } : {}),
  });
  return plan?.available ? weekAsPlanned(plan).filter((run) => run.day_number >= 1 && run.day_number <= 7) : [];
}

function shapeWeek(week: string, today: string, average: number): WeekShape {
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) dates.push(i === 0 ? week : (addDaysISO(week, i) ?? week));
  const thisWeek = mondayOf(today);
  if (week < thisWeek) return loggedWeek(dates, today, average);
  const current = week === thisWeek;
  const empty: WeekShape = { days: {}, logged: false };
  // The day before the week opens: everything the plan reads, it reads as of then.
  const eve = addDaysISO(week, -1) ?? week;
  const kg = current ? bodyweightKg(eve, today) : bodyweightKg(today);
  if (kg == null) return empty;
  const cost = new Map<string, { kcal: number; work: string[]; run: boolean; lift: boolean; cross: boolean }>(
    dates.map((d) => [d, { kcal: 0, work: [], run: false, lift: false, cross: false }])
  );

  // Each run on the day the WEEK placed it, at its planned distance.
  const runs = safe(() => plannedRunWeek(week, eve), [] as RunPlanPrescription[]);
  for (const run of runs) {
    const day = cost.get(dates[run.day_number - 1]);
    const km = finitePositive(run.target_distance_km);
    if (!day || km == null) continue;
    day.kcal += km * kg * RUN_KCAL_PER_KG_KM;
    day.work.push(RUN_WORDS[run.kind_label as FlexibleRunKind] ?? "the run");
    day.run = true;
  }
  // The lifting weekdays as of the eve, applied to all seven days: a stated strength
  // schedule applies at once, the observed pattern never counts this week's own sessions.
  const lift = new Set(safe(() => liftDows(eve), [] as number[]).map((dow) => Number(dow) % 7));
  // The known cross-training days, read as of the day before this week: a ride logged this
  // week can neither add a weekday to the usual pattern nor take one away.
  const crossDays = safe(() => crossTrainingDays(addDaysISO(thisWeek, -1) ?? thisWeek), [] as CrossTrainingDay[]);
  for (const date of dates) {
    const day = cost.get(date)!;
    // A lifting weekday is the plan whether or not the lift was logged yet.
    if (lift.has(isoDow(date))) {
      day.kcal += kg * LIFT_NET_KCAL_PER_KG;
      day.work.push("lifting");
      day.lift = true;
    }
    const known = crossDays.find((d) => d.dow === isoDow(date));
    // A usual day that is usually light carries no cost; a named day with nothing logged on
    // it yet is taken at the athlete's word.
    const counts =
      !!known &&
      (known.typical_load === "moderate" || known.typical_load === "heavy" || (known.source === "stated" && known.typical_load == null));
    if (known && counts && !day.run) {
      const noun = crossTrainingNoun(known.sport_family);
      day.kcal += kg * CROSS_NET_KCAL_PER_KG;
      day.work.push(known.source === "stated" ? `the ${noun} you named` : `your usual ${known.weekday} ${noun}`);
      day.cross = true;
    }
  }

  const shifts = distribute(dates.map((d) => cost.get(d)!.kcal), average);
  const cap = capInSteps(average);
  const lived = current ? dates.filter((d) => d <= today) : [];
  const impacts = lived.length ? safe(() => recentEnduranceImpacts(lived.length, today), [] as EnduranceImpact[]) : [];
  // This week's logged runs matched against the week as planned (the one week matcher);
  // with no run week every logged run is an extra.
  const closures = lived.length ? safe(() => weekRunClosures(week, today, { prescriptions: runs }), [] as RunClosure[]) : [];
  const intents: PlannedRunOutcome[] = runs.map((run, index) => {
    const closed = closures.find((c) => c.slot_index === index);
    return {
      placed_date: dates[run.day_number - 1],
      planned_km: finitePositive(run.target_distance_km),
      completion: closed ? { date: closed.date, distance_km: closed.evidence.distance_km } : null,
    };
  });
  const extras = closures.filter((c) => c.closed == null).map((c) => ({ date: c.date, distance_km: c.evidence.distance_km }));
  const days: WeekShape["days"] = {};
  dates.forEach((date, i) => {
    const day = cost.get(date)!;
    let outcome = 0;
    let outcomeWork: string[] = [];
    if (lived.includes(date)) {
      const found = safe(
        () =>
          dayOutcomeCost({
            date,
            kg,
            intents,
            extras,
            impacts,
            lifted: !!completedSessionOnDate(date),
            planned: { lifting: day.lift, cross: day.cross },
          }),
        { kcal: 0, words: [] as string[] }
      );
      const half = found.kcal * DAY_SHIFT_SHARE;
      if (Math.abs(half) >= DAY_SHIFT_MIN_KCAL) {
        // The day's whole move stays inside the cap: the outcome takes only the room the plan left.
        const total = Math.max(-cap, Math.min(cap, shifts[i] + fifties(half)));
        outcome = total - shifts[i] || 0;
        // Kept even when the cap took all of it, so the sentence still names it.
        outcomeWork = found.words;
      }
    }
    days[date] = { shift: shifts[i], work: day.work, outcome, outcome_work: outcomeWork };
  });
  return { days, logged: false };
}

/**
 * The day's energy number for `date`, given the accepted weekly-average target. Never
 * throws: a week that cannot be shaped answers the average itself.
 */
export function dayEnergyTarget(date: string, averageKcal: number, opts: { today?: string } = {}): DayEnergy {
  const today = opts.today || localDateISO();
  const average = Math.round(Number(averageKcal));
  if (!Number.isFinite(average) || average <= ABSOLUTE_KCAL_FLOOR) return flatDay(date, average);
  return dayFromShape(weekShapeOf(date, today, average), date, today, average);
}

/**
 * The seven days of the Monday-to-Sunday week holding `date`, each exactly as
 * `dayEnergyTarget` reads it, from ONE shape of the week (repo/fuel-week.ts lays them out).
 * Never throws: a week that cannot be shaped answers the average on every day.
 */
export function dayEnergyWeek(date: string, averageKcal: number, opts: { today?: string } = {}): DayEnergy[] {
  const today = opts.today || localDateISO();
  const average = Math.round(Number(averageKcal));
  const monday = mondayOf(date);
  const dates = Array.from({ length: 7 }, (_, i) => (i === 0 ? monday : (addDaysISO(monday, i) ?? monday)));
  if (!Number.isFinite(average) || average <= ABSOLUTE_KCAL_FLOOR) return dates.map((d) => flatDay(d, average));
  const shape = weekShapeOf(date, today, average);
  return dates.map((d) => dayFromShape(shape, d, today, average));
}

function flatDay(date: string, average: number): DayEnergy {
  return { date, average_kcal: average, kcal: average, shift_kcal: 0, outcome_shift_kcal: 0, work: [], outcome_work: [], words: null };
}

/** The shape of the week holding `date`, or null when it cannot be shaped. */
function weekShapeOf(date: string, today: string, average: number): WeekShape | null {
  try {
    const week = mondayOf(date);
    // Memoized per request: requestMemo serves an entry only while no row has been written
    // since, so a session or activity logged in between is always read.
    return requestMemo(`day_energy_week:${week}|${today}|${average}`, () => shapeWeek(week, today, average), copyDeep);
  } catch {
    return null;
  }
}

/** One day's energy read off its week's shape. */
function dayFromShape(shape: WeekShape | null, date: string, today: string, average: number): DayEnergy {
  const flat = flatDay(date, average);
  if (!shape) return flat;
  const day = shape.days[date];
  if (!day) return flat;
  if (!day.shift && !day.outcome) return { ...flat, work: day.work };
  // Every move is a multiple of the step; the floor holds the lowest such move that keeps
  // the day at or above it, so a floored day still reads as the average plus fifties.
  const lowest = Math.ceil((ABSOLUTE_KCAL_FLOOR - average) / DAY_SHIFT_STEP_KCAL) * DAY_SHIFT_STEP_KCAL;
  const shift = Math.max(lowest, day.shift + day.outcome) || 0;
  const kcal = average + shift;
  // The plan's part as it would land alone; the rest of the move is the outcome's. When the
  // cap or the floor took all of the outcome, the whole move is the plan's, and the
  // sentence still names what was logged (`held`).
  const plan = day.shift ? Math.max(lowest, day.shift) : 0;
  let outcome = day.outcome ? shift - plan : 0;
  if (outcome && Math.sign(outcome) !== Math.sign(day.outcome)) outcome = 0;
  // An outcome that brought the day back to the average: the number says nothing, the parts
  // still say what moved it.
  if (!shift) return { ...flat, work: day.work, outcome_shift_kcal: outcome, outcome_work: outcome ? day.outcome_work : [] };
  const base = {
    date,
    average_kcal: average,
    kcal,
    shift_kcal: shift,
    outcome_shift_kcal: outcome,
    work: day.work,
    outcome_work: outcome ? day.outcome_work : [],
  };
  // A few tens of kcal either way is the same number in words.
  if (Math.abs(shift) < DAY_SHIFT_MIN_KCAL) return { ...base, words: null };
  const words = dayWords({
    date,
    today,
    kcal,
    average,
    plan: outcome ? plan : shift,
    outcome,
    work: day.work,
    outcomeWork: day.outcome_work,
    held: !outcome && day.outcome_work.length > 0,
    logged: shape.logged,
  });
  return { ...base, words };
}

/** The day's sentence from its parts (exported for its tests). */
export function dayWords(i: {
  date: string;
  today: string;
  kcal: number;
  average: number;
  plan: number;
  outcome: number;
  work: string[];
  outcomeWork: string[];
  /** What was logged moved nothing: the cap or the floor had already been reached. */
  held: boolean;
  logged: boolean;
}): string {
  // A day already lived reads in the past tense throughout, a week over or not.
  const past = i.date < i.today;
  const head = i.date === i.today ? "Today's number is about" : past ? "That day's number was about" : "This day's number is about";
  const avg = kcalWords(i.average);
  if (i.held) {
    // Name what produced the move: the plan's work and what was logged, then why the log
    // could not move it further.
    const planned = i.work.length ? `${i.work.join(" and ")}${i.plan < 0 ? " planned" : ""}` : "";
    const named = [planned, i.outcomeWork.join(" and ")].filter(Boolean).join(" and ");
    const tail =
      i.plan > 0
        ? `${past ? "That was" : "That is"} as far up as a day's number goes.`
        : "A day's number does not go lower than that.";
    return i.plan > 0
      ? `${head} ${kcalWords(i.kcal)} kcal: your ${avg} average plus about ${kcalWords(i.plan)} for ${named}. ${tail}`
      : `${head} ${kcalWords(i.kcal)} kcal: your ${avg} average less about ${kcalWords(-i.plan)}, with ${named}. ${tail}`;
  }
  const work = i.work.length ? i.work.join(" and ") : "";
  const planPart = !i.plan
    ? ""
    : i.plan > 0
      ? `plus about ${kcalWords(i.plan)}${work ? ` for ${work}` : ""}`
      : i.logged
        ? `less about ${kcalWords(-i.plan)}, ${work ? `a lighter day with only ${work}` : "a lighter day"}`
        : `less about ${kcalWords(-i.plan)}, ${work ? `with only ${work} planned` : "a lighter day"}`;
  if (i.outcome) {
    const did = i.outcomeWork.length ? i.outcomeWork.join(" and ") : "what you logged";
    const outPart =
      planPart && i.plan > 0 && i.outcome > 0
        ? `and about ${kcalWords(i.outcome)} for ${did}`
        : `${i.outcome > 0 ? "plus" : "less"} about ${kcalWords(Math.abs(i.outcome))} for ${did}`;
    const joined = planPart ? `${planPart}${i.plan > 0 && i.outcome > 0 ? " " : ", "}${outPart}` : outPart;
    return `${head} ${kcalWords(i.kcal)} kcal: your ${avg} average ${joined}. The rest of the week ${past ? "kept" : "keeps"} its numbers.`;
  }
  const weekLine =
    i.plan > 0
      ? past
        ? ` The week still averaged ${avg}.`
        : ` The week still averages ${avg}.`
      : past
        ? " That room went to the week's bigger days."
        : " That room goes to the week's bigger days.";
  return `${head} ${kcalWords(i.kcal)} kcal: your ${avg} average ${planPart}.${weekLine}`;
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
