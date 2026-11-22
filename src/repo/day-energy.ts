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
//   - an hour of brisk walking or hiking: roughly 4.5 MET (the Compendium's walking and
//     hiking entries run about 3.5-7 MET), taken as about 3.5 kcal per kg net. Approximate.
// A session the load read calls light (yoga, mobility, an easy stroll) carries no cost:
// that kind of day is already in the activity level the average is worked out from.
// Because those are rough, only DAY_SHIFT_SHARE of each day's difference from the week's
// mean moves, and never more than DAY_SHIFT_CAP_SHARE of the average either way. A day
// never drops under the absolute calorie floor.
//
// Which work, by where the day sits:
//   - a day of this week or a later one is shaped by the PLAN: a run the agenda planned is
//     costed at its planned distance on the day it is placed (or the day it was run), never
//     at what a watch said was burned; a lift weekday (the calendar's) as an hour of
//     lifting; the known cross-training day (stated, else the usual one, read as of the
//     day before this week so nothing logged this week can move it) as an hour of it. None
//     of those three reads what was logged on the day itself, so logging a session never
//     re-plans the week and never moves another day's number;
//   - a week already over has no plan left (fuel-demand.ts holds the same law), so it is
//     shaped by what was LOGGED, with the same costs and the same rules: runs at their
//     logged distance, a day with a logged lifting session as an hour of lifting, other
//     sessions by their logged time. That week still sums to seven times the average;
//   - today and the days already lived this week keep their plan number, and a clear
//     departure from the plan moves that ONE day by DAY_SHIFT_SHARE of the difference
//     (`outcome_shift_kcal`), never handed to the other days: a session the plan did not
//     carry adds its cost, and a planned run done clearly longer or shorter is costed at
//     its logged distance. Planned work not logged never lowers a day and is never taken
//     back from another day; a lived day keeps its plan number. The day's whole move
//     (plan and outcome) stays inside the cap and above the floor.
// Watch calories are never read anywhere here.
import { resolvedCurrentBodyweight } from "./bodyweight.js";
import { crossTrainingDays, crossTrainingNoun } from "./cross-training-day.js";
import type { CrossTrainingDay } from "./cross-training-day.js";
import type { LoadFamily } from "./endurance-sports.js";
import { flexibleTrainingAgenda } from "./flexible-training-agenda.js";
import type { FlexibleRunIntent, FlexibleRunKind } from "./flexible-training-agenda.js";
import { recentEnduranceImpacts } from "./hybrid-load.js";
import type { EnduranceImpact } from "./hybrid-load.js";
import { ABSOLUTE_KCAL_FLOOR } from "./nutrition-safety.js";
import { calendarDayRead } from "./plan-selection.js";
import { isoDow } from "./profile.js";
import { copyDeep, requestMemo } from "./request-memo.js";
import { completedSessionOnDate } from "./session-dose-log.js";
import { LB_PER_KG, addDaysISO, localDateISO } from "./shared.js";
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
  /** The day's number, rounded to ten. Equal to the average when nothing moves it. */
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
const tens = (n: number) => Math.round(n / 10) * 10;
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

export interface DayOutcomeInput {
  date: string;
  kg: number;
  /** The week's run intentions (the agenda's). */
  intents: Array<Pick<FlexibleRunIntent, "status" | "suggested_date" | "planned_distance_km" | "target_distance_km" | "completion">>;
  /** Runs logged this week that closed no intention (the agenda's `extras`). */
  extras: Array<{ date: string; distance_km: number | null }>;
  /** The logged non-run sessions (runs among them are ignored here: the agenda owns runs). */
  impacts: ImpactLike[];
  /** A lifting session is logged on the day. */
  lifted: boolean;
  /** What the day's plan already carried. */
  planned: { lifting: boolean; cross: boolean };
}

/**
 * How far what was DONE on one day departs from what its plan carried, in kcal of cost
 * (before DAY_SHIFT_SHARE), with the words for it. A run that closed an intention is the
 * planned run (costed again only when its logged distance is clearly different); a run
 * that closed none is extra, unless an open run is still placed on that day (then it is
 * read as that run, and the plan's cost stands). Planned work not logged adds nothing and
 * takes nothing away.
 */
export function dayOutcomeCost(input: DayOutcomeInput): { kcal: number; words: string[] } {
  const { date, kg } = input;
  let kcal = 0;
  const words: string[] = [];
  for (const intent of input.intents) {
    const done = intent.completion;
    if (!done || String(done.date) !== date) continue;
    const planned = finitePositive(intent.planned_distance_km) ?? finitePositive(intent.target_distance_km);
    const ran = finitePositive(done.distance_km);
    if (planned == null || ran == null) continue;
    const diff = ran - planned;
    if (Math.abs(diff) < Math.max(planned * RUN_DISTANCE_CHANGE_SHARE, RUN_DISTANCE_CHANGE_MIN_KM)) continue;
    kcal += diff * kg * RUN_KCAL_PER_KG_KM;
    words.push(diff > 0 ? "the longer run you logged" : "the shorter run you logged");
  }
  const openRunHere = input.intents.some((i) => i.status === "open" && i.suggested_date === date);
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
 * and a week whose biggest move is small left flat. Sums to about zero.
 */
function distribute(costs: number[], average: number): number[] {
  const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
  if (!(mean > 0)) return costs.map(() => 0);
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
  if (Math.max(...shifts.map(Math.abs)) < DAY_SHIFT_MIN_KCAL) return costs.map(() => 0);
  return shifts.map(tens);
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

function shapeWeek(week: string, today: string, average: number): WeekShape {
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) dates.push(i === 0 ? week : (addDaysISO(week, i) ?? week));
  const thisWeek = mondayOf(today);
  if (week < thisWeek) return loggedWeek(dates, today, average);
  const empty: WeekShape = { days: {}, logged: false };
  const kg = bodyweightKg(today);
  if (kg == null) return empty;
  const cost = new Map<string, { kcal: number; work: string[]; run: boolean; lift: boolean; cross: boolean }>(
    dates.map((d) => [d, { kcal: 0, work: [], run: false, lift: false, cross: false }])
  );

  const agenda = safe(() => flexibleTrainingAgenda(week === thisWeek ? today : week), null);
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
  // The known cross-training days, read as of the day before this week: a ride logged this
  // week can neither add a weekday to the usual pattern nor take one away.
  const crossDays = safe(() => crossTrainingDays(addDaysISO(thisWeek, -1) ?? thisWeek), [] as CrossTrainingDay[]);
  for (const date of dates) {
    const day = cost.get(date)!;
    // The calendar's lift weekday is the plan, whatever this morning's read suggests and
    // whether or not the lift was logged yet: the plan never changes when the log does.
    if (safe(() => calendarDayRead(date)?.kind === "lift", false)) {
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
  const cap = average * DAY_SHIFT_CAP_SHARE;
  const lived = week === thisWeek ? dates.filter((d) => d <= today) : [];
  const impacts = lived.length ? safe(() => recentEnduranceImpacts(lived.length, today), [] as EnduranceImpact[]) : [];
  // With no run week to read, nothing planned a run: every logged run is extra.
  const extras = agenda?.available
    ? (agenda.extras ?? [])
    : impacts.filter((i) => i.family === "run").map((i) => ({ date: String(i.date).slice(0, 10), distance_km: i.distance_km }));
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
            intents: agenda?.available ? agenda.intents : [],
            extras,
            impacts,
            lifted: !!completedSessionOnDate(date),
            planned: { lifting: day.lift, cross: day.cross },
          }),
        { kcal: 0, words: [] as string[] }
      );
      const move = tens(found.kcal * DAY_SHIFT_SHARE);
      if (Math.abs(move) >= DAY_SHIFT_MIN_KCAL) {
        // The day's whole move stays inside the cap: the outcome takes only the room the plan left.
        const total = Math.max(-cap, Math.min(cap, shifts[i] + move));
        outcome = tens(total) - shifts[i];
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
  const flat: DayEnergy = {
    date,
    average_kcal: average,
    kcal: average,
    shift_kcal: 0,
    outcome_shift_kcal: 0,
    work: [],
    outcome_work: [],
    words: null,
  };
  if (!Number.isFinite(average) || average <= ABSOLUTE_KCAL_FLOOR) return flat;
  let shape: WeekShape;
  try {
    const week = mondayOf(date);
    // Memoized per request: requestMemo serves an entry only while no row has been written
    // since, so a session or activity logged in between is always read.
    shape = requestMemo(`day_energy_week:${week}|${today}|${average}`, () => shapeWeek(week, today, average), copyDeep);
  } catch {
    return flat;
  }
  const day = shape.days[date];
  if (!day) return flat;
  if (!day.shift && !day.outcome) return { ...flat, work: day.work };
  // A moved number is said to the ten everywhere it is printed, so the meter and the
  // sentence can never show two different figures.
  const kcal = Math.max(ABSOLUTE_KCAL_FLOOR, tens(average + day.shift + day.outcome));
  const shift = kcal - average;
  if (!shift) return { ...flat, work: day.work };
  // The plan's part as it would land alone; the rest of the move is the outcome's. When the
  // cap or the floor took all of the outcome, the whole move is the plan's, and the
  // sentence still names what was logged (`held`).
  const planKcal = Math.max(ABSOLUTE_KCAL_FLOOR, tens(average + day.shift));
  const plan = day.shift ? planKcal - average : 0;
  let outcome = day.outcome ? shift - plan : 0;
  if (outcome && Math.sign(outcome) !== Math.sign(day.outcome)) outcome = 0;
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
        ? `${i.date === i.today ? "That is" : "That was"} as far up as a day's number goes.`
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
    return `${head} ${kcalWords(i.kcal)} kcal: your ${avg} average ${joined}. The rest of the week keeps its numbers.`;
  }
  const weekLine =
    i.plan > 0
      ? i.logged
        ? ` The week still averaged ${avg}.`
        : ` The week still averages ${avg}.`
      : i.logged
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
