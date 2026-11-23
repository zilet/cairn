// The week's fuel: the seven days of the Monday-to-Sunday week holding a date, each with
// the DAY's energy number (repo/day-energy.ts) laid out against the week's average, so a
// higher long-run day or a lower rest day reads as part of one week instead of an
// arbitrary number. It is a read over `dayEnergyWeek`, never a second split: every day's
// number, shift, work and sentence are exactly what that day's own read says.
//
// What was eaten rides along only where the one credibility rule allows it
// (`classifyIntakeDay` through `completedIntakeRange`, repo/intake-window.ts): a lived day
// (past or today) carries `logged_kcal` only when its log reads complete. A partial or
// unlogged day carries null — absent, never "low" — and no day is ever graded against its
// number: the logged figure is a fact beside the number, not a verdict on it.
//
// The line above the strip (`words`) is composed here, deterministically, from the numbers
// themselves: the average, then the day the week gives most to and the day it gives least,
// rotating its phrasing by date (pickDayVariant).
import { pickDayVariant } from "./brain/day-read-rules.js";
import { type DayEnergy, dayEnergyWeek } from "./day-energy.js";
import { completedIntakeRange } from "./intake-window.js";
import { localDateISO } from "./shared.js";

export type FuelWeekWhen = "past" | "today" | "ahead";

export interface FuelWeekDay {
  date: string;
  /** "Mon" … "Sun". */
  weekday: string;
  /** The day's number (DayEnergy.kcal). */
  kcal: number;
  /** kcal minus the average: the plan's move and the outcome's together. */
  shift_kcal: number;
  /** The part of the shift that logged work added on this day alone (0 when none). */
  outcome_shift_kcal: number;
  /** The day's work in words ("the long run", "lifting"); empty on a day with none. */
  work: string[];
  /** What logged work added, in words ("the ride you logged"). */
  outcome_work: string[];
  /** One short word for the strip's column: "Long", "Run", "Lift", "Ride", … "Rest". */
  tag: string;
  /** The day's own sentence (DayEnergy.words); null when it sits at the average. */
  words: string | null;
  when: FuelWeekWhen;
  /**
   * What was logged on a lived day, ONLY when that day's log reads complete
   * (classifyIntakeDay); null for a partial or unlogged day and for every day ahead.
   */
  logged_kcal: number | null;
}

export interface FuelWeek {
  /** The Monday the week opens on. */
  week_of: string;
  /** The accepted target: the week's average. */
  average_kcal: number;
  /** Seven times the average: what the week's numbers add up to, before anything logged moved a day. */
  week_kcal: number;
  /** What logged work added on its own days (the outcome shifts together); 0 most weeks. */
  logged_extra_kcal: number;
  days: FuelWeekDay[];
  /** The one line above the strip: the average, then the day given most and the day given least. */
  words: string;
  /** The plain fact that the seven days add up to seven times the average. */
  sum_words: string;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const kcalWords = (n: number) => (Math.round(n / 10) * 10).toLocaleString("en-US");
const dowOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

// The column's one word, by the biggest piece of work the day carries. A run outranks
// lifting (it moves the number more), and a day with no work is a rest day.
const TAGS: Array<[RegExp, string]> = [
  [/long run/, "Long"],
  [/\brun\b/, "Run"],
  [/\bride\b/, "Ride"],
  [/\bswim\b/, "Swim"],
  [/\bhike\b/, "Hike"],
  [/\brow\b/, "Row"],
  [/\bskiing\b/, "Ski"],
  [/\bpaddle\b/, "Paddle"],
  [/lifting/, "Lift"],
];

/** One short word for a day's work ("Long", "Lift", … "Rest"); exported for its tests. */
export function fuelWeekTag(work: readonly string[]): string {
  const text = work.join(" · ").toLowerCase();
  if (!text.trim()) return "Rest";
  for (const [pattern, tag] of TAGS) if (pattern.test(text)) return tag;
  return "Work";
}

function names(days: readonly FuelWeekDay[]): string {
  return listWords(days.map((d) => WEEKDAY_LONG[dowOf(d.date)]));
}

type Side = { name: string; plural: boolean; why: string; lived: boolean };

/**
 * The day (or two) sitting furthest out on one side, by name; three or more sharing that
 * place are "the bigger days" / "the lighter days". Null when no day sits on that side.
 */
function furthest(days: readonly FuelWeekDay[], side: 1 | -1): Side | null {
  const out = days.filter((d) => Math.sign(d.shift_kcal) === side);
  if (!out.length) return null;
  const edge = side > 0 ? Math.max(...out.map((d) => d.shift_kcal)) : Math.min(...out.map((d) => d.shift_kcal));
  const at = out.filter((d) => d.shift_kcal === edge);
  const lived = at.every((d) => d.when === "past");
  if (at.length > 2) return { name: side > 0 ? "the bigger days" : "the lighter days", plural: true, why: "", lived };
  return { name: names(at), plural: at.length > 1, why: forWork(at), lived };
}

/** "a", "a and b", "a, b and c". */
function listWords(items: readonly string[]): string {
  return items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "for the long run" when the bigger day (or both) carry the same work, else "". */
function forWork(days: readonly FuelWeekDay[]): string {
  const pieces = days.map((d) => listWords([...d.work, ...d.outcome_work]));
  return pieces[0] && pieces.every((p) => p === pieces[0]) ? ` for ${pieces[0]}` : "";
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The line above the strip, composed from the numbers; exported for its tests. */
export function fuelWeekWords(
  days: readonly FuelWeekDay[],
  average: number,
  opts: { date: string; past: boolean }
): string {
  const avg = kcalWords(average);
  if (days.every((d) => d.shift_kcal === 0)) {
    return pickDayVariant(
      [
        `Every day this week ${opts.past ? "sat" : "sits"} at the ${avg} average.`,
        `The week ${opts.past ? "kept" : "keeps"} one number, its ${avg} average, every day.`,
        `The week ${opts.past ? "averaged" : "averages"} ${avg}, the same number each day.`,
      ],
      opts.date,
      "fuel-week-flat"
    );
  }
  const up = furthest(days, 1);
  const down = furthest(days, -1);
  // A bigger day already lived reads in the past tense, inside the week or after it.
  const verb = (base: "carry" | "get"): string =>
    opts.past || up?.lived
      ? base === "carry"
        ? "carried"
        : "got"
      : up?.plural
        ? base
        : `${base === "carry" ? "carries" : "gets"}`;
  // Each phrasing says the same facts; none grades a day.
  const shape = (base: "carry" | "get", lead: boolean): string => {
    const cap = (s: string) => (lead ? capital(s) : s);
    if (up && down) return `${cap(up.name)} ${verb(base)} more${up.why}, ${down.name} less.`;
    if (up) return `${cap(up.name)} ${verb(base)} more${up.why}.`;
    if (down) return `${cap(down.name)} ${opts.past || down.lived ? "had" : down.plural ? "have" : "has"} less.`;
    return "";
  };
  const averages = opts.past ? "averaged" : "averages";
  return pickDayVariant(
    [
      `The week ${averages} ${avg}. ${shape("carry", true)}`,
      `This week ${averages} ${avg}: ${shape("get", false)}`,
      `${avg} ${opts.past ? "was" : "is"} the week's average. ${shape("get", true)}`,
    ],
    opts.date,
    "fuel-week"
  );
}

/**
 * The week's fuel for the week holding `date`, around the accepted weekly `average`.
 * Null when there is no average to lay out. Never throws.
 */
export function fuelWeekRead(
  date: string,
  averageKcal: number | null | undefined,
  opts: { today?: string } = {}
): FuelWeek | null {
  try {
    const average = Math.round(Number(averageKcal));
    if (!Number.isFinite(average) || average <= 0) return null;
    const today = opts.today || localDateISO();
    const energy: DayEnergy[] = dayEnergyWeek(date, average, { today });
    if (energy.length !== 7) return null;
    const monday = energy[0].date;
    const sunday = energy[6].date;
    // One read of the week's food notes, classified by the one credibility rule; today's
    // own log counts once it reads complete.
    const complete = new Map<string, number>();
    if (monday <= today) {
      for (const day of completedIntakeRange(monday, sunday, today).days)
        if (day.credible) complete.set(day.date, day.kcal);
    }
    const days: FuelWeekDay[] = energy.map((day) => {
      const when: FuelWeekWhen = day.date < today ? "past" : day.date === today ? "today" : "ahead";
      return {
        date: day.date,
        weekday: WEEKDAY_SHORT[dowOf(day.date)],
        kcal: day.kcal,
        shift_kcal: day.shift_kcal,
        outcome_shift_kcal: day.outcome_shift_kcal,
        work: [...day.work],
        outcome_work: [...day.outcome_work],
        tag: fuelWeekTag([...day.work, ...day.outcome_work]),
        words: day.words,
        when,
        logged_kcal: when !== "ahead" && complete.has(day.date) ? Math.round(complete.get(day.date)!) : null,
      };
    });
    const extra = days.reduce((sum, d) => sum + d.outcome_shift_kcal, 0);
    const planned = days.reduce((sum, d) => sum + d.kcal - d.outcome_shift_kcal, 0);
    const past = sunday < today;
    const add = past ? "added" : "add";
    const sum_words =
      planned === 7 * average
        ? `The seven days ${add} up to ${kcalWords(7 * average)}, seven times the average${
            extra ? `, ${extra > 0 ? "plus" : "less"} about ${kcalWords(Math.abs(extra))} for what you logged` : ""
          }.`
        : `The seven days ${add} up to about ${kcalWords(planned + extra)}.`;
    return {
      week_of: monday,
      average_kcal: average,
      week_kcal: 7 * average,
      logged_extra_kcal: extra,
      days,
      words: fuelWeekWords(days, average, { date, past }),
      sum_words,
    };
  } catch {
    return null;
  }
}
