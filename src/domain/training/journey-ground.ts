// The road's ground — what the athlete has actually done on this stretch of Horizon's road,
// set as dated stones on the walked part (contract: WeekReadJourneyStone). Each stone is a
// logged or measured event read from the source that owns it, handed in by the week read
// (week-read.ts journeyOf gathers every read once; nothing here touches the database):
//   - a race run: every race effort matched on the stretch (race-recovery.ts
//     finishedRacesBetween — it outlives the goal), else the build's `finished`;
//   - a lift's new best: a lift goal's own journey `best` against its baseline
//     (strength-objectives.ts); with no lift goal, the week's new bests on a main lift
//     (sessions.ts weekBests, the plan strip's own read);
//   - the longest run taken well: the race build's `review.longest_well` inside a dated
//     build; with no dated race, the stretch's own (run-capacity.ts demonstratedLongRun
//     over stretchRunDays — the same harm filter, race days left out);
//   - a bodyweight waypoint crossed toward a dated weight goal: each whole 5 lb / 2 kg on
//     the week-mean of the stretch's canonical weigh-ins (bodyweight.ts);
//   - a blood marker a newer draw moved back inside its optimal band, materially toward it,
//     or back inside the lab's range (standing/blood.ts bloodMarkerMoves) — one stone a draw;
//   - a training block finished (program-blocks.ts, completed, never abandoned), the most
//     recent; and the first week on the road that held every lifting and run day the
//     athlete set (their stated schedules, counted against the logged days);
//   - a measured body change: the waist by tape, or a body-fat level that measured lower,
//     only while the ONE body-fat estimate is `measured` (body-fat-estimate.ts).
// Each source fails alone: one that throws leaves the others standing. Words are plain
// facts — no score, no percent, no praise — in the athlete's units, and every sentence
// passes the reading grammar or the stone is not set.
import type { TodayPath } from "../../contracts/today-path.js";
import type { WeekReadJourneyStone } from "../../contracts/week-read.js";
import { JOURNEY_STONES_MAX } from "../../contracts/week-read.js";
import { addDaysISO, daysBetweenISO, mondayOf } from "../../lib/dates.js";
import {
  clockWords,
  dateWords,
  distanceWords,
  LB_PER_KG,
  loadWords,
  raceDistanceName,
  weightWords,
  type AthleteUnits,
} from "../../repo/display-words.js";
import { violatesReadingGrammar } from "../../repo/day-read-grammar.js";
import type { RaceBuild } from "../../repo/race-build.js";
import type { WeekBest } from "../../repo/sessions.js";
import type { StrengthJourney } from "../../repo/strength-objectives.js";
import type { BloodMarkerMove } from "./standing/blood.js";
import { cap, joinWords, numberWord } from "./standing/words.js";
import { liftShortName, WEEK_HREFS } from "./week-words.js";

/** A stone the line can name: its wire shape plus the line's own lead variants. */
export type StoneCandidate = WeekReadJourneyStone & { leads: string[] };

/** Two stones closer than this many days would sit on one another. */
const STONE_MIN_GAP_DAYS = 3;
/** …or closer than this share of the span the stones lie on (`start` → `end`; the walked part). */
const STONE_MIN_GAP_SHARE = 0.03;
/** A waypoint on the way to a weight goal, in the athlete's unit. */
const WEIGHT_WAYPOINT: Record<AthleteUnits["weight"], number> = { lb: 5, kg: 2 };
/** The weigh-ins a trend point averages: the week ending on it. */
const WEIGHT_TREND_DAYS = 7;
/**
 * The smallest waist change a stone names, in inches: about twice what one person's tape
 * reads apart on the same waist on two mornings, so a stone is never a re-measure.
 */
const WAIST_STONE_MIN_IN = 0.5;
/** A waist change is read across at least this many days, never between two tapes a week apart. */
const WAIST_MIN_SPAN_DAYS = 14;
const CM_PER_IN = 2.54;
/** When two stones share a day, the one kept. */
const STONE_PRIORITY: Record<WeekReadJourneyStone["kind"], number> = {
  race_done: 0,
  best: 1,
  longest_run: 2,
  health: 3,
  weight: 4,
  body_fat: 5,
  waist: 6,
  block: 7,
  full_week: 8,
};

/** How far back the road may start: a year of ground is a whole journey; past it, the start is history. */
export const ROAD_BACK_MAX_DAYS = 365;

/**
 * Where the road starts: the EARLIEST real start among the live goals and the last race
 * run — a dated weight goal's own start, a lift goal's baseline, the dated race's trend
 * window, the most recent finished race's build — never more than ROAD_BACK_MAX_DAYS
 * back. `real` is false when no goal named a start and the road falls back to `fallback`
 * (a look-back window that is never spoken as days walked).
 */
export function roadStart(
  today: string,
  candidates: ReadonlyArray<string | null | undefined>,
  fallback: string
): { start: string; real: boolean } {
  const floor = addDaysISO(today, -ROAD_BACK_MAX_DAYS) ?? today;
  const dates = candidates
    .map((d) => String(d ?? "").slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today)
    .map((d) => [d, floor].sort()[1]);
  if (!dates.length) return { start: [fallback, today].sort()[0], real: false };
  return { start: [...dates].sort()[0], real: true };
}

/** "12 days", "six weeks", "five and a half months", "a year": how long the road has been walked. */
export function walkedSpanWords(days: number): string {
  const d = Math.max(0, Math.round(days));
  if (d < 14) return `${numberWord(d)} ${d === 1 ? "day" : "days"}`;
  if (d < 63) return `${numberWord(Math.round(d / 7))} weeks`;
  const halves = Math.round((d / 30.44) * 2) / 2;
  if (halves >= 12) return "a year";
  const whole = Math.floor(halves);
  return halves > whole ? `${numberWord(whole)} and a half months` : `${numberWord(whole)} months`;
}

/** "today", "yesterday", "on Tuesday", "a week ago", "on Nov 3": when, inside the line. */
export function stoneWhen(date: string, today: string): string {
  const ago = daysBetweenISO(today, date) ?? 99;
  if (ago <= 0) return "today";
  if (ago === 1) return "yesterday";
  if (ago < 7) return `on ${dateWords(date, today, "day")}`;
  if (ago === 7) return "a week ago";
  return `on ${dateWords(date, today)}`;
}

function stoneOf(
  kind: WeekReadJourneyStone["kind"],
  stone: WeekReadJourneyStone["stone"],
  date: string,
  today: string,
  said: { short: string; words: string; href: string | null; leads: string[] }
): StoneCandidate {
  return {
    kind,
    stone,
    date,
    date_words: dateWords(date, today),
    days_ago: Math.max(0, daysBetweenISO(today, date) ?? 0),
    ...said,
  };
}

const inStretch = (date: string | null | undefined, start: string, today: string): date is string =>
  !!date && date >= start && date <= today;

/** A race run on the stretch, as the week read hands it in. */
export interface FinishedRaceRef {
  event: string | null;
  date: string;
  run_km: number;
  finish_sec: number | null;
}

function raceStoneOf(race: FinishedRaceRef, today: string, units: AthleteUnits): StoneCandidate {
  const distance = raceDistanceName(race.run_km, units.distance);
  const name = race.event?.trim() || distance;
  const on = dateWords(race.date, today);
  const when = stoneWhen(race.date, today);
  return stoneOf("race_done", "endurance", race.date, today, {
    short: distance === "Half marathon" ? "Half" : / race$/.test(distance) ? "Race" : distance,
    words:
      race.finish_sec != null ? `${name} run in ${clockWords(race.finish_sec)} on ${on}.` : `${name} run on ${on}.`,
    href: WEEK_HREFS.day(race.date),
    leads: [`${name}, run ${when}.`, `${name} is behind you, run ${when}.`],
  });
}

/** Every race run on the stretch: the hindsight list, and the build's `finished` when the list missed it. */
function raceStones(
  races: readonly FinishedRaceRef[],
  finished: RaceBuild["finished"],
  start: string,
  today: string,
  units: AthleteUnits
): StoneCandidate[] {
  const all = [...races];
  if (finished && !all.some((r) => r.date === finished.date))
    all.push({ event: finished.event, date: finished.date, run_km: finished.run_km, finish_sec: finished.finish_sec });
  return all.filter((r) => inStretch(r.date, start, today) && r.run_km > 0).map((r) => raceStoneOf(r, today, units));
}

function bestLeads(lift: string, date: string, today: string): string[] {
  const when = stoneWhen(date, today);
  return [`A new best on ${lift} ${when}.`, `You set a new best on ${lift} ${when}.`];
}

/**
 * A lift goal's new best on this stretch: the journey's own best (its whole tracked
 * history) dated inside the stretch and past where the goal began. Never a projection.
 */
function goalBestStones(
  journeys: readonly StrengthJourney[],
  start: string,
  today: string,
  units: AthleteUnits
): StoneCandidate[] {
  const out: StoneCandidate[] = [];
  for (const j of journeys) {
    const exercise = j.tracked?.exercise ?? j.objective?.exercise;
    if (!exercise) continue;
    const lift = liftShortName(exercise);
    if (j.reps) {
      const best = j.reps.best;
      const base = j.reps.baseline;
      if (!best || !(best.value > 0) || !base || best.value <= base.value) continue;
      if (!inStretch(best.date, start, today) || (base.date && base.date >= best.date)) continue;
      const sets = best.text.includes(",");
      out.push(
        stoneOf("best", "strength", best.date, today, {
          short: sets ? `${Math.max(...best.sets)} reps` : best.text,
          words: `A new best on ${lift} on ${dateWords(best.date, today)}: ${sets ? `sets of ${best.text}` : best.text}.`,
          href: WEEK_HREFS.day(best.date),
          leads: bestLeads(lift, best.date, today),
        })
      );
      continue;
    }
    const best = j.best;
    const base = j.baseline;
    if (!best || !base || best.est_1rm < base.est_1rm + 1) continue;
    if (!inStretch(best.date, start, today) || (base.date && base.date >= best.date)) continue;
    const load = weightWords(best.est_1rm, units.weight, { whole: true });
    out.push(
      stoneOf("best", "strength", best.date, today, {
        short: load,
        words: `A new best on ${lift} on ${dateWords(best.date, today)}, an estimated ${load} max.`,
        href: WEEK_HREFS.day(best.date),
        leads: bestLeads(lift, best.date, today),
      })
    );
  }
  return out;
}

/** The main lifts a road names when the athlete holds no lift goal. */
const MAIN_LIFTS = new Set(["the press", "the bench", "the deadlift", "the squat", "the row", "the pull-up"]);

/** With no lift goal, the week's new bests on a main lift (weekBests, the strip's own read). */
function weekBestStones(
  bests: readonly Omit<WeekBest, "label">[],
  start: string,
  today: string,
  units: AthleteUnits
): StoneCandidate[] {
  const out: StoneCandidate[] = [];
  for (const b of bests) {
    const lift = liftShortName(b.exercise);
    if (!MAIN_LIFTS.has(lift) || !inStretch(b.date, start, today)) continue;
    if (!(Number(b.weight_lb) > 0) || !(Number(b.reps) > 0)) continue;
    const set = `${loadWords(Number(b.weight_lb), units.weight)} × ${Number(b.reps)}`;
    out.push(
      stoneOf("best", "strength", b.date, today, {
        short: set,
        words: `A new best on ${lift} on ${dateWords(b.date, today)}: ${set}.`,
        href: WEEK_HREFS.day(b.date),
        leads: bestLeads(lift, b.date, today),
      })
    );
  }
  return out;
}

/** The longest run of the last four weeks taken well (the race build's own read). */
function buildLongRunStone(
  build: RaceBuild | null,
  start: string,
  today: string,
  units: AthleteUnits
): StoneCandidate | null {
  const run = build?.review?.longest_well;
  if (!run || !(run.km > 0) || !inStretch(run.date, start, today)) return null;
  const dist = distanceWords(run.km, units.distance);
  const when = stoneWhen(run.date, today);
  return stoneOf("longest_run", "endurance", run.date, today, {
    short: dist,
    words: `${dist} on ${dateWords(run.date, today)}, the longest run of the last four weeks.`,
    href: WEEK_HREFS.day(run.date),
    leads: [
      `${dist} ${when}, your longest run in four weeks.`,
      `Your longest run in four weeks came ${when}: ${dist}.`,
    ],
  });
}

/** With no dated race: the stretch's longest run taken well (demonstratedLongRun over the stretch). */
export interface StretchLongRun {
  km: number;
  date: string;
  /** True when no longer run on the stretch was set aside for what it cost the next morning. */
  longest: boolean;
}

function stretchLongRunStone(
  run: StretchLongRun | null | undefined,
  start: string,
  today: string,
  units: AthleteUnits
): StoneCandidate | null {
  if (!run || !(run.km > 0) || !inStretch(run.date, start, today)) return null;
  const dist = distanceWords(run.km, units.distance);
  const since = dateWords(start, today);
  const when = stoneWhen(run.date, today);
  const what = run.longest
    ? `your longest run since ${since}`
    : `your longest run since ${since} that you came through well`;
  return stoneOf("longest_run", "endurance", run.date, today, {
    short: dist,
    words: `${dist} on ${dateWords(run.date, today)}, ${what}.`,
    href: WEEK_HREFS.day(run.date),
    leads: [`${dist} ${when}, ${what}.`, `${cap(what)} came ${when}: ${dist}.`],
  });
}

/**
 * Each whole waypoint (5 lb / 2 kg) the weight TREND crossed on the way to a dated weight
 * goal and stayed past: the trend is the mean of the week of canonical weigh-ins ending on
 * each one, so one light morning never sets a stone. Only toward the goal, never past it.
 */
function weightStones(
  weight: TodayPath["weight"],
  start: string,
  today: string,
  units: AthleteUnits
): StoneCandidate[] {
  if (!weight || weight.goal_lb == null || !weight.goal_date) return [];
  if (weight.mode !== "lose" && weight.mode !== "gain") return [];
  const points = [...(weight.points ?? [])]
    .filter((p) => p.weight_lb > 0 && p.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length < 3) return [];
  const unit = (lb: number) => (units.weight === "kg" ? lb / LB_PER_KG : lb);
  const trend = points.map((p, i) => {
    const week = points.slice(0, i + 1).filter((q) => (daysBetweenISO(p.date, q.date) ?? 99) < WEIGHT_TREND_DAYS);
    return { date: p.date, v: unit(week.reduce((sum, q) => sum + q.weight_lb, 0) / week.length) };
  });
  const lose = weight.mode === "lose";
  const step = WEIGHT_WAYPOINT[units.weight];
  const goal = unit(weight.goal_lb);
  // Where the stretch began is the first week of weigh-ins averaged, never one morning: a
  // single heavy day must not mint a crossing the trend never made.
  const opening = trend.filter((p) => (daysBetweenISO(p.date, trend[0].date) ?? 99) < WEIGHT_TREND_DAYS);
  const first = opening[opening.length - 1].v;
  const last = trend[trend.length - 1].v;
  const out: StoneCandidate[] = [];
  for (let w = Math.ceil(Math.min(first, last) / step) * step; w <= Math.max(first, last); w += step) {
    const crossed = lose ? first >= w && last < w && w >= goal : first <= w && last > w && w <= goal;
    if (!crossed) continue;
    // The first day of the run the trend has stayed past the waypoint through today.
    let k = trend.length - 1;
    while (k > 0 && (lose ? trend[k - 1].v < w : trend[k - 1].v > w)) k--;
    const date = trend[k].date;
    if (!inStretch(date, start, today)) continue;
    const said = weightWords(units.weight === "kg" ? w * LB_PER_KG : w, units.weight, { whole: true });
    const side = lose ? "under" : "over";
    const when = stoneWhen(date, today);
    out.push(
      stoneOf("weight", "body", date, today, {
        short: said,
        words: `Your weight trend went ${side} ${said} on ${dateWords(date, today)}.`,
        href: WEEK_HREFS.goal,
        leads: [
          `Your weight trend went ${side} ${said} ${when}.`,
          `${lose ? "Under" : "Over"} ${said} on the weight trend ${when}.`,
        ],
      })
    );
  }
  return out;
}

/** A marker's name on the trail: its abbreviation ("LDL", "HbA1c") or a short name. */
function markerShort(name: string): string {
  const first = name.split(/[\s(,]+/)[0] ?? name;
  if ((first.match(/[A-Z]/g) ?? []).length >= 2) return first;
  return name.length <= 12 ? name : "Labs";
}

function markerClause(m: BloodMarkerMove): string {
  const way = m.down ? "down" : "up";
  if (m.kind === "back") return `${m.name} came ${way} into its optimal band`;
  if (m.kind === "lab_back") return `${m.name} came back inside the lab's range`;
  return `${m.name} moved ${way} toward its optimal band`;
}

/**
 * One stone a draw: the markers that draw moved the right way against the draw before
 * (back inside first, then toward), at most two named. Informational: a direction and a
 * date, never a value judged, never a cure.
 */
function healthStones(moves: readonly BloodMarkerMove[], start: string, today: string): StoneCandidate[] {
  const byDraw = new Map<string, BloodMarkerMove[]>();
  for (const m of moves) {
    if (!inStretch(m.date, start, today)) continue;
    if (violatesReadingGrammar(m.name)) continue;
    byDraw.set(m.date, [...(byDraw.get(m.date) ?? []), m]);
  }
  const rank = { back: 0, lab_back: 1, toward: 2 } as const;
  const out: StoneCandidate[] = [];
  for (const [date, list] of byDraw) {
    const ordered = [...list].sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
    const lead = ordered[0];
    const rest = ordered.slice(1);
    const draw = `the ${dateWords(date, today)} draw`;
    let words = `${markerClause(lead)} on ${draw}.`;
    if (rest.length) {
      const n = rest.length;
      const what = rest.every((m) => m.kind !== "toward")
        ? "came back into range"
        : rest.every((m) => m.kind === "toward")
          ? `moved toward ${n === 1 ? "its" : "their"} optimal ${n === 1 ? "band" : "bands"}`
          : "moved toward or into range";
      words = `On ${draw}, ${markerClause(lead)}, and ${numberWord(n)} ${n === 1 ? "other marker" : "other markers"} ${what}.`;
    }
    out.push(
      stoneOf("health", "heart", date, today, {
        short: rest.length ? "Labs" : markerShort(lead.name),
        words,
        href: WEEK_HREFS.markers,
        leads: [`${markerClause(lead)} on your latest draw.`, `Your latest draw: ${markerClause(lead)}.`],
      })
    );
  }
  return out;
}

/** A finished training block, as the week read hands it in. */
export interface FinishedBlockRef {
  focus: string;
  /** The weeks it ran. */
  weeks: number;
  /** Its last day (its last week's Sunday, never past the next block's start or today). */
  end_date: string;
}

const BLOCK_FOCUS_WORDS: Readonly<Record<string, string>> = {
  strength: "strength",
  hypertrophy: "muscle-building",
  "endurance-base": "base",
  peak: "peaking",
};

/** The most recent block finished on the stretch: a fact, never praise. */
function blockStone(blocks: readonly FinishedBlockRef[], start: string, today: string): StoneCandidate | null {
  const done = blocks
    .filter((b) => b.weeks >= 2 && inStretch(b.end_date, start, today))
    .sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
  if (!done) return null;
  const focus = BLOCK_FOCUS_WORDS[done.focus] ?? "training";
  const n = numberWord(done.weeks);
  const week = dateWords(mondayOf(done.end_date), today);
  return stoneOf("block", done.focus === "endurance-base" ? "endurance" : "strength", done.end_date, today, {
    short: "Block",
    words: `A ${n}-week ${focus} block finished the week of ${week}.`,
    href: WEEK_HREFS.program,
    leads: [`A ${n}-week ${focus} block finished the week of ${week}.`, `The ${focus} block ran its ${n} weeks.`],
  });
}

/** The lifting and run days a week holds against what the athlete set, as the week read hands them in. */
export interface StatedWeekDays {
  /** How many lifting days and runs the stated schedules set a week. */
  lift_days: number;
  run_days: number;
  /** The days on the stretch a real lifting session / a run happened (race days left out). */
  lift_dates: readonly string[];
  run_dates: readonly string[];
}

/**
 * The FIRST week on the road that held every day the athlete set (as many lifting days and
 * runs as their schedules name — a moved day still counts, the log is truth), dated the
 * day the last of them was done. Only weeks wholly on the road; null with nothing set.
 */
function fullWeekStone(days: StatedWeekDays | null | undefined, start: string, today: string): StoneCandidate | null {
  if (!days) return null;
  const L = Math.max(0, Math.floor(days.lift_days));
  const R = Math.max(0, Math.floor(days.run_days));
  if (!L && !R) return null;
  const byWeek = (dates: readonly string[]) => {
    const out = new Map<string, string[]>();
    for (const d of [...new Set(dates)].sort()) {
      if (!inStretch(d, start, today)) continue;
      const wk = mondayOf(d);
      out.set(wk, [...(out.get(wk) ?? []), d]);
    }
    return out;
  };
  const lifts = byWeek(days.lift_dates);
  const runs = byWeek(days.run_dates);
  const weeks = [...new Set([...lifts.keys(), ...runs.keys()])].filter((w) => w >= start).sort();
  for (const wk of weeks) {
    const l = lifts.get(wk) ?? [];
    const r = runs.get(wk) ?? [];
    if (l.length < L || r.length < R) continue;
    const doneOn = [L ? l[L - 1] : "", R ? r[R - 1] : ""].sort().at(-1) as string;
    const parts = [
      L ? `${numberWord(L)} lifting ${L === 1 ? "day" : "days"}` : "",
      R ? `${numberWord(R)} ${R === 1 ? "run" : "runs"}` : "",
    ].filter(Boolean);
    const week = dateWords(wk, today);
    return stoneOf("full_week", L ? "strength" : "endurance", doneOn, today, {
      short: "Full week",
      words: `The week of ${week} was the first on this road with every day of your set week done: ${joinWords(parts)}.`,
      href: WEEK_HREFS.day(doneOn),
      leads: [`The week of ${week} had every day of your set week done.`, `Every day of your set week was done the week of ${week}.`],
    });
  }
  return null;
}

/** A body measurement on the stretch, as the week read hands it in (only while the estimate is measured). */
export interface BodyMeasured {
  /** bodyFatEstimate(...).measured today: a real scan or tape sets the level. */
  measured: boolean;
  /** Waist tapes, one a day, ascending (inches). */
  waist: ReadonlyArray<{ date: string; value: number }>;
  /** The estimate now and as of the day before its newest measurement, each with its range. */
  fat?: {
    now: { date: string; low: number; high: number };
    before: { date: string; low: number; high: number };
  } | null;
}

/** The waist by tape, smaller across the stretch by more than a re-measure. */
function waistStone(body: BodyMeasured | null | undefined, start: string, today: string, units: AthleteUnits) {
  if (!body?.measured) return null;
  const tapes = [...body.waist]
    .filter((p) => p.value > 0 && p.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const base = [...tapes].reverse().find((p) => p.date <= start) ?? tapes.find((p) => p.date >= start);
  const latest = tapes.at(-1);
  if (!base || !latest || !inStretch(latest.date, start, today)) return null;
  if ((daysBetweenISO(latest.date, base.date) ?? 0) < WAIST_MIN_SPAN_DAYS) return null;
  const down = base.value - latest.value;
  if (!(down >= WAIST_STONE_MIN_IN)) return null;
  const amount = units.weight === "kg" ? `${Math.round(down * CM_PER_IN)} cm` : `${Math.round(down * 10) / 10} in`;
  const when = stoneWhen(latest.date, today);
  return stoneOf("waist", "body", latest.date, today, {
    short: `−${amount}`,
    words: `Your waist measured ${amount} smaller on ${dateWords(latest.date, today)} than on ${dateWords(base.date, today)}.`,
    href: WEEK_HREFS.body,
    leads: [`Your waist measured ${amount} smaller ${when}.`, `${amount} off the waist, by the tape ${when}.`],
  });
}

/** A body-fat level that measured lower, its likely range clear of the one before it. */
function bodyFatStone(body: BodyMeasured | null | undefined, start: string, today: string) {
  const fat = body?.measured ? body.fat : null;
  if (!fat || !inStretch(fat.now.date, start, today) || !(fat.before.date < fat.now.date)) return null;
  if (!(fat.now.high < fat.before.low)) return null;
  const when = stoneWhen(fat.now.date, today);
  return stoneOf("body_fat", "body", fat.now.date, today, {
    short: "Leaner",
    words: `Body fat measured lower on ${dateWords(fat.now.date, today)} than on ${dateWords(fat.before.date, today)}.`,
    href: WEEK_HREFS.body,
    leads: [`Body fat measured lower ${when}.`, `A leaner reading ${when}, clear of the one before.`],
  });
}

/**
 * The stones the road carries: variety first (the newest of each stone hue, then of each
 * kind), then the rest spread along the road (each next the one farthest from those
 * already chosen, the newer on a tie), so six waypoints over five months read as the
 * journey rather than its last weeks; never two closer than a few days (or ~3% of the
 * road), and at most JOURNEY_STONES_MAX. Ascending by date.
 */
export function pickJourneyStones<T extends WeekReadJourneyStone>(
  candidates: readonly T[],
  start: string,
  end: string
): T[] {
  const newest = [...candidates].sort(
    (a, b) => b.date.localeCompare(a.date) || STONE_PRIORITY[a.kind] - STONE_PRIORITY[b.kind]
  );
  const order: T[] = [];
  const hues = new Set<string>();
  const kinds = new Set<string>();
  for (const c of newest) {
    if (hues.has(c.stone)) continue;
    hues.add(c.stone);
    kinds.add(c.kind);
    order.push(c);
  }
  for (const c of newest) {
    if (kinds.has(c.kind)) continue;
    kinds.add(c.kind);
    order.push(c);
  }
  const gap = Math.max(STONE_MIN_GAP_DAYS, Math.round((daysBetweenISO(end, start) ?? 0) * STONE_MIN_GAP_SHARE));
  const near = (a: T, b: T) => Math.abs(daysBetweenISO(a.date, b.date) ?? 0);
  const kept: T[] = [];
  const keep = (c: T) => {
    if (kept.length >= JOURNEY_STONES_MAX || kept.some((k) => near(k, c) < gap)) return;
    kept.push(c);
  };
  for (const c of order) keep(c);
  // The rest, spread: the candidate farthest from every stone kept, until the cap.
  let rest = newest.filter((c) => !order.includes(c));
  while (kept.length < JOURNEY_STONES_MAX && rest.length) {
    let best: T | null = null;
    let bestGap = -1;
    for (const c of rest) {
      const d = kept.length ? Math.min(...kept.map((k) => near(k, c))) : Number.MAX_SAFE_INTEGER;
      if (d > bestGap) {
        best = c;
        bestGap = d;
      }
    }
    if (!best || bestGap < gap) break;
    kept.push(best);
    rest = rest.filter((c) => c !== best);
  }
  return kept.sort((a, b) => a.date.localeCompare(b.date) || STONE_PRIORITY[a.kind] - STONE_PRIORITY[b.kind]);
}

/** The reads the stones come from — every one gathered once by the week read. */
export interface JourneyGroundInput {
  start: string;
  today: string;
  /** The day the road ends (the summit's last day). */
  end: string;
  units: AthleteUnits;
  finished?: RaceBuild["finished"];
  /** Every race run on the stretch (hindsight; outlives the goal). */
  races?: readonly FinishedRaceRef[];
  build?: RaceBuild | null;
  /** With no dated race, the stretch's longest run taken well. */
  longestRun?: StretchLongRun | null;
  journeys?: readonly StrengthJourney[];
  bests?: readonly Omit<WeekBest, "label">[];
  weight?: TodayPath["weight"];
  markers?: readonly BloodMarkerMove[];
  blocks?: readonly FinishedBlockRef[];
  weekDays?: StatedWeekDays | null;
  body?: BodyMeasured | null;
}

/** One source, alone: a source that throws sets no stone and takes no other with it. */
function source(read: () => StoneCandidate | StoneCandidate[] | null): StoneCandidate[] {
  try {
    const out = read();
    return (Array.isArray(out) ? out : out ? [out] : []).filter(
      (c) =>
        !violatesReadingGrammar(c.words) && !violatesReadingGrammar(c.short) && !c.leads.some(violatesReadingGrammar)
    );
  } catch {
    return [];
  }
}

/** Every stone on the walked part, picked (pickJourneyStones), each with its line leads. */
export function journeyGround(input: JourneyGroundInput): StoneCandidate[] {
  const { start, today, units } = input;
  const journeys = input.journeys ?? [];
  const goalLifts = journeys.some((j) => j.objective);
  const races = source(() => raceStones(input.races ?? [], input.finished ?? null, start, today, units));
  const raceDays = new Set(races.map((r) => r.date));
  const candidates: StoneCandidate[] = [
    ...races,
    ...source(() => goalBestStones(journeys, start, today, units)),
    ...source(() => (goalLifts ? [] : weekBestStones(input.bests ?? [], start, today, units))),
    // A race is never training: no long-run stone on a race's day.
    ...source(() => buildLongRunStone(input.build ?? null, start, today, units)).filter((c) => !raceDays.has(c.date)),
    ...source(() => stretchLongRunStone(input.longestRun, start, today, units)).filter((c) => !raceDays.has(c.date)),
    ...source(() => weightStones(input.weight ?? null, start, today, units)),
    ...source(() => healthStones(input.markers ?? [], start, today)),
    ...source(() => blockStone(input.blocks ?? [], start, today)),
    ...source(() => fullWeekStone(input.weekDays, start, today)),
    ...source(() => waistStone(input.body, start, today, units)),
    ...source(() => bodyFatStone(input.body, start, today)),
  ];
  // Spaced against the WALKED part (start → today), the stretch the stones are drawn on.
  return pickJourneyStones(candidates, start, today);
}
