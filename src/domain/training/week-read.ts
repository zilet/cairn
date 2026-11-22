// THE WEEK READ — one calendar week, Horizon's Week page (contract: src/contracts/week-read.ts).
//
// A composition over the reads that already own each fact, re-deriving none of them:
//   - the cells: planWeek, the plan strip's own week (GET /api/plan/week answers the same
//     cells), read as of today for this week, a later week as of its Monday and a past
//     week as of its Sunday (dayDetailWeekAsOf — the day page's own rule, so a chip and
//     the day it opens can never disagree);
//   - the frame: weekFrameLine (week-stage.ts) — the one stage word, block week,
//     countdown and push stance;
//   - the milestones and the goals: Today's path (the race estimate with its time, the
//     weight trend, the anchor lift) over the same race build;
//   - the weight: weightTrendRead (weight-trend.ts), the one rate every surface prints.
//
//   - the goals' threads (start, four weeks ago, now, goal, direction): the same board
//     rows, the strength journeys' own "now" and trend (strength-objectives.ts), the
//     race build's estimate trend and the weight trend's one verdict;
//     Two or more live lift goals are ONE strength row that lists every lift, each the
//     same thread a single strength row shows;
//   - proof: a race just run (race-recovery.ts latestFinishedRace and its goal review),
//     the weight journey's start (today-path.ts weightStart; left out beside a weight goal
//     row that draws its track) and up to two lifts' working loads, the anchor lift
//     first (working-load-history.ts over sessionWorkingLoad).
//
// Every string a person reads is in the athlete's units (athleteUnits → display-words)
// and names its dates in words. The load shape is a dose WORD and a relative height for
// drawing — never a number shown, never a score. Changes nothing.
import { standingRead } from "./standing-read.js";
import type {
  WeekReadJourney,
  WeekReadJourneyBehind,
  WeekReadJourneyMark,
  DayChip,
  WeekDose,
  WeekRead,
  WeekReadGoal,
  WeekReadGoalDirection,
  WeekReadGoalLift,
  WeekReadGoalTrack,
  WeekReadMilestone,
  WeekReadMilestoneKind,
  WeekReadOpen,
  WeekReadProof,
  WeekReadTotals,
  WeightTrendRead,
} from "../../contracts/week-read.js";
import { WEEK_GOAL_LIFTS_MAX } from "../../contracts/week-read.js";
import { addDaysISO, daysBetweenISO, isoDate, mondayOf } from "../../lib/dates.js";
import { round1 } from "../../lib/numbers.js";
import {
  awayWords,
  clockWords,
  dateRangeWords,
  dateWords,
  distanceOfWords,
  distanceWords,
  loadWords,
  raceDistanceName,
  sinceWords,
  weightWords,
  type AthleteUnits,
} from "../../repo/display-words.js";
import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import { canonicalBodyweightSeries } from "../../repo/bodyweight.js";
import { goalReviewRecords, type RaceReviewFacts } from "../../repo/goal-reviews.js";
import { getProfile } from "../../repo/profile.js";
import { fmtClock, raceBuild, type RaceBuild } from "../../repo/race-build.js";
import { latestFinishedRace } from "../../repo/race-recovery.js";
import { raceRunActivity } from "../../repo/race-results.js";
import { RUN_KIND_LABELS } from "../../repo/run-edit.js";
import { athleteUnits } from "../../repo/settings.js";
import { localDateISO } from "../../repo/shared.js";
import { buildMarkFor } from "../../repo/performance.js";
import {
  capacityEnvelopeAsOf,
  getStrengthJourneys,
  strengthObjectiveTrackedHistory,
  type StrengthJourney,
} from "../../repo/strength-objectives.js";
import {
  assistWords,
  repsDirection,
  repsEnvelopeAsOf,
  repsGoalOf,
  repsValueText,
  strengthRepsHistory,
  type RepsGoal,
} from "../../repo/strength-reps.js";
import {
  liveStrengthJourneys,
  strengthNow,
  strengthRepsNow,
  strengthRowId,
  todayPath,
  weightStart,
} from "../../repo/today-path.js";
import { planDayStrengthGroups } from "../../repo/training-read.js";
import { weekFrameLine } from "../../repo/week-stage.js";
import { WEIGHT_HOLDING_LB_WK, weightTrendRead } from "../../repo/weight-trend.js";
import { workingLoadHistory } from "../../repo/working-load-history.js";
import type { TodayPath } from "../../contracts/today-path.js";
import { dayDetailWeekAsOf } from "./day-detail.js";
import { planWeek, type PlanWeek, type PlanWeekDay } from "./plan-week.js";

export type { WeekRead } from "../../contracts/week-read.js";

/** The most still-open lines the week carries; the rest is the week's shape. */
const STILL_OPEN_MAX = 2;
/** The milestones beyond this week the page lists. */
const NEXT_MILESTONES_MAX = 3;
/** A race just run leads the proof for this many days after race day. */
export const RACE_PROOF_DAYS = 28;
/** The most proof rows the week carries. */
const PROOF_MAX = 3;
/** How far back a goal's "four weeks ago" ring looks. */
const AGO_DAYS = 28;
/** A weigh-in this close to the ring's day stands for it; further off, no ring. */
const AGO_SLACK_DAYS = 7;
/** The weeks of run volume a race's proof picture shows, through race week. */
const RACE_PROOF_WEEKS = 10;
/** The most points a proof picture carries (a long series is thinned evenly). */
const PROOF_SERIES_MAX = 24;
/** A goal track's margin past a thread that sits behind its start (drawing room only). */
const TRACK_MARGIN = 0.06;

/** The pages a thread or a milestone opens (src/contracts/client-routes.ts canonical URLs). */
export const WEEK_HREFS = {
  race: "/app/horizon/race",
  goal: "/app/horizon/goal",
  program: "/app/train/program",
  checkup: "/app/you/checkup",
  behind: (id: number) => `/app/horizon/behind?id=${id}`,
  day: (date: string) => `/app/day/${date}`,
} as const;

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function text(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

/** A valid YYYY-MM-DD for `?start=`, or null (the route answers 400). Absent → today. */
export function weekReadStart(value: unknown): string | null {
  if (value == null || value === "") return localDateISO();
  return isoDate(String(value).slice(0, 10));
}

// ---------------------------------------------------------------------------
// The day chip and its dose
// ---------------------------------------------------------------------------

const DOSE_LEVEL: readonly WeekDose[] = ["rest", "easy", "moderate", "hard", "big"];
const DOSE_WORD: Record<WeekDose, string> = {
  rest: "Rest",
  easy: "Easy",
  moderate: "Moderate",
  hard: "Hard",
  big: "Big day",
};
/** Relative bar height per dose — a drawing aid, never printed. */
const DOSE_HEIGHT: Record<WeekDose, number> = { rest: 0.08, easy: 0.3, moderate: 0.55, hard: 0.8, big: 1 };

function runLevel(run: PlanWeekDay["run"], longestKm: number | null): number {
  if (!run || run.rested) return 0;
  if (run.kind === "quality") return 3;
  if (run.kind === "long") {
    // The week's longest run is its biggest leg demand: a big day.
    return longestKm != null && run.km != null && run.km >= longestKm - 0.05 ? 4 : 3;
  }
  if (run.kind === "logged") return run.km != null && run.km >= 15 ? 3 : 1;
  return 1;
}

/**
 * The day's planned dose: the harder of its lift and its run, one step up when it holds
 * both. A word for the day and a relative height for the week's shape.
 */
function doseOf(cell: PlanWeekDay, longestKm: number | null, heavyLower: boolean): DayChip["load"] {
  const lift = (!!cell.plan_day && cell.plan_day.day_type !== "rest") || !!cell.session;
  const liftLevel = lift ? (heavyLower ? 3 : 2) : 0;
  const run = runLevel(cell.run, longestKm);
  let level = Math.max(liftLevel, run);
  if (liftLevel > 0 && run > 0) level = Math.min(4, level + 1);
  const dose = DOSE_LEVEL[level] ?? "rest";
  return { dose, word: DOSE_WORD[dose], height: DOSE_HEIGHT[dose] };
}

function runChipLabel(run: NonNullable<PlanWeekDay["run"]>): string {
  return text(run.label) || RUN_KIND_LABELS[run.kind as keyof typeof RUN_KIND_LABELS] || "Run";
}

function chipOf(
  cell: PlanWeekDay,
  today: string,
  units: AthleteUnits,
  longestKm: number | null,
  heavy: Set<number>
): DayChip {
  const date = cell.date;
  const heavyLower = cell.plan_day != null && heavy.has(cell.plan_day.day_number);
  // A day with a logged session names what was DONE — the cell's session title, the
  // same answer Today's strip prints (src/repo/session-day.ts); the plan day names the rest.
  const liftTitle = text(cell.session?.title) || text(cell.plan_day?.name);
  const covered =
    !!cell.run && cell.run.status === "completed" && !!cell.run.completion_date && cell.run.completion_date !== date;
  const lift = liftTitle
    ? {
        day_number: cell.plan_day?.day_number ?? null,
        title: liftTitle,
        heavy_lower: heavyLower,
        suggestion: cell.suggestion
          ? { kind: cell.suggestion.kind, label: cell.suggestion.label, caveat: cell.suggestion.caveat }
          : null,
      }
    : null;
  const run = cell.run
    ? {
        kind: cell.run.kind,
        label: runChipLabel(cell.run),
        status: cell.run.status,
        km: cell.run.km,
        distance_words: cell.run.km != null && cell.run.km > 0 ? distanceWords(cell.run.km, units.distance) : null,
        rested: !!cell.run.rested,
        covered,
      }
    : null;
  const runWords = run
    ? run.rested
      ? "Rest or an easy walk"
      : covered
        ? `${run.label} already in`
        : `${run.label}${run.distance_words ? `, ${run.distance_words}` : ""}`
    : "";
  const words =
    [lift?.title ?? "", runWords].filter(Boolean).join(" · ") || (cell.status === "done" ? "Logged" : "Rest");
  return {
    date,
    date_words: date ? dateWords(date, today, "weekday") : null,
    weekday: cell.weekday,
    status: cell.status,
    today: !!date && date === today,
    lift,
    run,
    rest: !lift && !run,
    hard: cell.hard,
    words,
    load: doseOf(cell, longestKm, heavyLower),
    href: date ? `/app/day/${date}` : null,
  };
}

// ---------------------------------------------------------------------------
// Totals, still open, the summary sentence
// ---------------------------------------------------------------------------

/**
 * The week's counts. The planned running is the race build's week as planned when it
 * reads this week (the one figure Today's path and the race page print — never this
 * morning's call on today's run), else the strip's own runs summed.
 */
function totalsOf(week: PlanWeek, units: AthleteUnits, buildWeekKm: number | null): WeekReadTotals {
  const p = week.progress;
  const runCells = week.days.filter((d) => !!d.run && !d.run.rested);
  // A covered weekday carries the completed run of another day: count each run once.
  const seen = new Set<string>();
  let plannedKm = 0;
  let plannedRuns = 0;
  for (const d of runCells) {
    const r = d.run!;
    const key = r.status === "completed" ? `done:${r.completion_date}:${r.kind}` : `open:${d.date}:${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    plannedRuns += 1;
    plannedKm += r.km ?? 0;
  }
  const planned = buildWeekKm != null && buildWeekKm > 0 ? buildWeekKm : plannedRuns ? plannedKm : null;
  const runKmPlanned = planned != null ? round1(Math.max(planned, p.run_km)) : null;
  const liftPlanned = p.lift_days_planned;
  const days = (n: number) => `${n} lifting ${n === 1 ? "day" : "days"}`;
  const liftWords =
    liftPlanned != null && liftPlanned > 0
      ? p.lift_days_done > 0
        ? `${p.lift_days_done} of ${days(liftPlanned)}`
        : days(liftPlanned)
      : p.lift_days_done > 0
        ? days(p.lift_days_done)
        : null;
  const runWords =
    runKmPlanned != null && runKmPlanned > 0
      ? p.run_km > 0
        ? distanceOfWords(p.run_km, runKmPlanned, units.distance)
        : `${distanceWords(runKmPlanned, units.distance)} planned`
      : p.run_km > 0
        ? distanceWords(p.run_km, units.distance)
        : null;
  return {
    lift_days_done: p.lift_days_done,
    lift_days_planned: liftPlanned,
    runs_done: p.runs_done,
    runs_planned: Math.max(plannedRuns, p.runs_done),
    run_km_done: p.run_km,
    run_km_planned: runKmPlanned,
    units: units.distance,
    lift_words: liftWords,
    run_words: runWords,
  };
}

const KEY_RUN_ORDER: Record<string, number> = { long: 0, quality: 1, easy: 2 };

/** Planned work still ahead this week: key runs first, then lifts. At most two. */
function stillOpenOf(week: PlanWeek, today: string): WeekReadOpen[] {
  const out: (WeekReadOpen & { rank: number })[] = [];
  for (const d of week.days) {
    if (!d.date || d.date < today) continue;
    if (d.status !== "today" && d.status !== "upcoming") continue;
    const when = dateWords(d.date, today, "relative");
    if (d.run && d.run.status === "open" && !d.run.rested) {
      const label = runChipLabel(d.run);
      out.push({
        kind: d.run.kind,
        label,
        date: d.date,
        date_words: when,
        words: `${label} · ${cap(when)}`,
        rank: KEY_RUN_ORDER[d.run.kind] ?? 2,
      });
    }
    if (d.plan_day && d.plan_day.day_type !== "rest" && !d.session) {
      out.push({
        kind: "lift",
        label: d.plan_day.name,
        date: d.date,
        date_words: when,
        words: `${d.plan_day.name} · ${cap(when)}`,
        rank: 3,
      });
    }
  }
  return out
    .sort((a, b) => a.rank - b.rank || String(a.date).localeCompare(String(b.date)))
    .slice(0, STILL_OPEN_MAX)
    .map(({ rank: _rank, ...row }) => row);
}

/**
 * The week's ONE sentence, owned by Horizon: what kind of week it is, what is in, what
 * is still ahead. "Sharpen week: 2 of 4 lifting days and 7.7 of 12.6 mi in, the long
 * run still ahead Saturday." Counts only — never a score, never a verdict.
 */
function summaryOf(
  stageWord: string | null,
  totals: WeekReadTotals,
  open: WeekReadOpen[],
  when: "past" | "this" | "future"
): string | null {
  const lead = stageWord ?? (when === "this" ? "This week" : "That week");
  const lifts = (n: number) => `${n} lifting ${n === 1 ? "day" : "days"}`;
  const plannedKm = totals.run_km_planned;
  const runAhead = plannedKm ? `${distanceWords(plannedKm, totals.units)} of running` : "";
  const key = when === "this" ? open.find((o) => o.kind === "long" || o.kind === "quality") : undefined;
  const dw = key?.date_words ?? "";
  const on = dw === "today" || dw === "tomorrow" || !dw ? dw : `on ${dw}`;
  const nothingIn = totals.lift_days_done === 0 && totals.run_km_done === 0;
  const tail = key
    ? nothingIn
      ? `, the ${key.label.toLowerCase()} ${on}`.trimEnd()
      : `, the ${key.label.toLowerCase()} still ahead ${dw === "today" || dw === "tomorrow" ? dw : on}`.trimEnd()
    : "";
  if (when === "future" || (when === "this" && nothingIn)) {
    const parts = [totals.lift_days_planned ? lifts(totals.lift_days_planned) : "", runAhead].filter(Boolean);
    if (!parts.length) return null;
    return when === "future"
      ? `${lead} ahead: ${parts.join(" and ")}.`
      : `${lead}: ${parts.join(" and ")} ahead${tail}.`;
  }
  const liftIn =
    totals.lift_days_done > 0
      ? totals.lift_days_planned
        ? `${totals.lift_days_done} of ${lifts(totals.lift_days_planned)}`
        : lifts(totals.lift_days_done)
      : "";
  const runIn =
    totals.run_km_done > 0
      ? plannedKm
        ? distanceOfWords(totals.run_km_done, plannedKm, totals.units)
        : distanceWords(totals.run_km_done, totals.units)
      : "";
  const done = [liftIn, runIn].filter(Boolean).join(" and ");
  if (!done) return when === "past" ? `${lead}: nothing was logged.` : null;
  return `${lead}: ${done} ${when === "past" ? "went in" : "in"}${tail}.`;
}

// ---------------------------------------------------------------------------
// Milestones and goals — Today's path, re-framed for the week page
// ---------------------------------------------------------------------------

/**
 * Where a milestone goes: the race and its peak week → the race page; the checkup → the
 * checkup under You › Health; the goal weight → the goal line; the strength checkpoint →
 * Train's program page; a long run → its day page.
 */
export function milestoneHref(kind: WeekReadMilestoneKind, date: string): string | null {
  switch (kind) {
    case "race":
    case "peak_week":
      return WEEK_HREFS.race;
    case "checkup":
      return WEEK_HREFS.checkup;
    case "goal":
      return WEEK_HREFS.goal;
    case "checkpoint":
      return WEEK_HREFS.program;
    case "long_run":
      return isoDate(date) ? WEEK_HREFS.day(date) : null;
    default:
      return null;
  }
}

function milestonesBeyond(path: TodayPath | null, weekEnd: string): WeekReadMilestone[] {
  return (path?.milestones ?? [])
    .filter((m) => m.date > weekEnd)
    .slice(0, NEXT_MILESTONES_MAX)
    .map((m) => ({
      kind: m.kind,
      label: m.label,
      date: m.date,
      end_date: m.end_date,
      date_words: m.date_words ?? (m.end_date ? dateRangeWords(m.date, m.end_date) : dateWords(m.date)),
      detail: m.detail,
      href: milestoneHref(m.kind, m.date),
    }));
}

const FIT_WORDS: Record<string, (target: string) => string> = {
  fits: (t) => `inside ${t}`,
  stretch: (t) => `${t} is a stretch from here`,
  beyond_horizon: (t) => `${t} sits past this build`,
};

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** "four" for 4, "12" past ten. */
function numberWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * A goal's track on ONE axis. Positions are measured as progress from start (0) toward
 * goal (1); the axis runs from min(start, now, ago) — less a margin when that is behind
 * the start — to max(goal, now, ago), so a thread now BEHIND its start (an overhead press
 * below the estimate it began at) draws left of the start mark instead of pinned to it.
 * Drawing positions only, 0..1 — never printed.
 */
export function goalTrack(
  start: number | null,
  now: number | null,
  goal: number | null,
  ago: number | null = null,
  agoWords: string | null = null,
  mark: number | null = null
): WeekReadGoalTrack | null {
  if (start == null || now == null || goal == null) return null;
  if (![start, now, goal].every(Number.isFinite) || goal === start) return null;
  const at = (v: number) => (v - start) / (goal - start);
  const agoAt = ago != null && Number.isFinite(ago) ? at(ago) : null;
  const marks = [0, 1, at(now), ...(agoAt != null ? [agoAt] : [])];
  let lo = Math.min(...marks);
  let hi = Math.max(...marks);
  const span = hi - lo;
  if (lo < 0) lo -= TRACK_MARGIN * span;
  if (hi > 1) hi += TRACK_MARGIN * span;
  const pos = (p: number) => round3(Math.max(0, Math.min(1, (p - lo) / (hi - lo))));
  return {
    start: pos(0),
    now: pos(at(now)),
    goal: pos(1),
    ago: agoAt != null ? pos(agoAt) : null,
    ago_words: agoAt != null ? agoWords : null,
    // A waypoint is drawn only on the way: strictly between now and the goal.
    ...(mark != null && Number.isFinite(mark) && at(mark) > at(now) && at(mark) < 1 ? { mark: pos(at(mark)) } : {}),
  };
}

/** "43 s", "1 min 12 s", "2 min". */
function secondsWords(sec: number): string {
  const s = Math.round(Math.abs(sec));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** A window's real length: "in four weeks", "in 10 days". */
function windowWords(since: string, through: string): string | null {
  const days = daysBetweenISO(through, since);
  if (days == null || days <= 0) return null;
  const weeks = Math.round(days / 7);
  return weeks >= 2 ? `in ${numberWord(weeks)} weeks` : `in ${days} ${days === 1 ? "day" : "days"}`;
}

const DIRECTION_WORDS: Record<WeekReadGoalDirection, string> = {
  toward: "Moving toward",
  holding: "Holding",
  back: "Drifting back",
  reached: "Reached",
};

type GoalThread = Pick<
  WeekReadGoal,
  | "id"
  | "start_text"
  | "goal_words"
  | "track"
  | "direction"
  | "direction_words"
  | "move_words"
  | "href"
  | "carried_words"
  | "next_words"
  | "mark_words"
>;

/**
 * The race row's thread over the estimate's own trend window: its direction is the
 * build's trend word (faster / steady / slower, race-build.ts), never the fit.
 */
function raceThread(path: TodayPath, build: RaceBuild | null, today: string): GoalThread {
  const race = path.race!;
  const trend = build?.prediction?.trend ?? null;
  const now = race.estimate_sec;
  const start = race.trend_delta_sec != null ? now - race.trend_delta_sec : null;
  const goal = race.target_sec;
  const since = race.since;
  const reached = goal != null && now <= goal;
  const direction: WeekReadGoalDirection | null = reached
    ? "reached"
    : trend
      ? trend.word === "faster"
        ? "toward"
        : trend.word === "slower"
          ? "back"
          : "holding"
      : null;
  const through = build?.prediction?.as_of ?? today;
  const span = since ? windowWords(since, through) : null;
  const delta = race.trend_delta_sec;
  const move =
    delta == null || !span
      ? null
      : Math.round(Math.abs(delta)) < 1
        ? `level ${span.replace(/^in /, "over ")}`
        : `${secondsWords(delta)} ${delta < 0 ? "faster" : "slower"} ${span}`;
  // The ring: where the estimate stood when its trend window opened — the only earlier
  // reading the estimate carries — named by that date.
  const sinceDay = since ? dateWords(since, today) : null;
  return {
    id: "race",
    start_text: start != null && sinceDay ? `${fmtClock(start)} · ${sinceDay}` : null,
    goal_words: goal != null ? `${fmtClock(goal)} · ${dateWords(race.date, today)}` : null,
    track: goalTrack(start, now, goal, start, sinceDay),
    direction,
    direction_words: direction ? DIRECTION_WORDS[direction] : null,
    move_words: move,
    href: WEEK_HREFS.race,
  };
}

type WeighIn = { date: string; weight_lb: number };

/** The weigh-in nearest a day, within AGO_SLACK_DAYS; null when none is that close. */
function weighInNear(points: readonly WeighIn[], day: string): WeighIn | null {
  let best: WeighIn | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const gap = Math.abs(daysBetweenISO(p.date, day) ?? Number.POSITIVE_INFINITY);
    if (gap < bestGap) {
      best = p;
      bestGap = gap;
    }
  }
  return best && bestGap <= AGO_SLACK_DAYS ? best : null;
}

/** "−0.4 lb/wk" → "0.4 lb a week": the read's own figure, re-worded only. */
function rateAWeek(words: string | null | undefined): string | null {
  const w = String(words ?? "").trim();
  return w ? w.replace(/^[−+-]/, "").replace(/\/wk$/, " a week") : null;
}

/** "−0.5 lb/wk" → "0.5": the ask's own figure, unit dropped beside the rate that names it. */
function rateFigure(words: string | null | undefined): string | null {
  const w = String(words ?? "").trim();
  return w ? w.replace(/^[−+-]/, "").replace(/\s*\S+\/wk$/, "") : null;
}

/**
 * The weight row's thread: the board's own start (weightStart), the weight trend's ONE
 * verdict (verdict_words, capitalised) and its own rate and ask, re-worded — no rate is
 * computed here.
 */
function weightThread(
  path: TodayPath,
  trend: WeightTrendRead | null,
  profile: unknown,
  today: string,
  units: AthleteUnits
): GoalThread {
  const weight = path.weight!;
  const row = (path.board ?? []).find((r) => r.key === "weight");
  const begin = weightStart(weight, profile);
  const goal = weight.goal_lb;
  const agoDay = addDaysISO(today, -AGO_DAYS) ?? today;
  const near = canonicalBodyweightSeries({
    since: addDaysISO(agoDay, -AGO_SLACK_DAYS) ?? agoDay,
    through: addDaysISO(agoDay, AGO_SLACK_DAYS) ?? agoDay,
  });
  const ago = weighInNear(near, agoDay);
  const rate = trend?.rate_lb_wk ?? null;
  const needed = trend?.needed_lb_wk ?? null;
  const sign = weight.mode === "lose" ? -1 : weight.mode === "gain" ? 1 : needed ? Math.sign(needed) : 0;
  let direction: WeekReadGoalDirection | null = null;
  if (row?.reached) direction = "reached";
  else if (rate != null && Math.abs(rate) < WEIGHT_HOLDING_LB_WK) direction = "holding";
  else if (rate != null && sign !== 0) direction = rate * sign > 0 ? "toward" : "back";
  const verdict = trend?.verdict_words
    ? `${trend.verdict_words.charAt(0).toUpperCase()}${trend.verdict_words.slice(1)}`
    : null;
  const rateWords = rateAWeek(trend?.rate_words);
  const neededWords = rateFigure(trend?.needed_words);
  const wrongWay =
    rate != null && needed != null && rate !== 0 && needed !== 0 && Math.sign(rate) !== Math.sign(needed);
  const move = rateWords
    ? neededWords
      ? wrongWay
        ? `${rateWords} ${(rate ?? 0) > 0 ? "up" : "down"}, ${neededWords} ${(needed ?? 0) > 0 ? "up" : "down"} needed`
        : `${rateWords}, ${neededWords} needed`
      : rateWords
    : null;
  const marked = (lb: number, date: string | null) =>
    [weightWords(lb, units.weight), date ? dateWords(date, today) : ""].filter(Boolean).join(" · ");
  return {
    id: "weight",
    start_text: begin ? marked(begin.lb, begin.date) : null,
    goal_words: goal != null ? marked(goal, weight.goal_date) : null,
    track: goalTrack(
      begin?.lb ?? null,
      weight.current_lb,
      goal,
      ago?.weight_lb ?? null,
      ago ? dateWords(ago.date, today) : null
    ),
    direction,
    direction_words:
      direction === "reached" ? DIRECTION_WORDS.reached : (verdict ?? (direction ? DIRECTION_WORDS[direction] : null)),
    move_words: move,
    href: WEEK_HREFS.goal,
  };
}

/**
 * A lift's move over the track's own four weeks, in lb of estimated 1RM: the journey's
 * weekly thresholds (rising at +0.5 lb a week, falling at -0.75, strength-objectives.ts)
 * over AGO_DAYS. The word is read off the SAME two marks the track draws (the ring and
 * the now dot), so a ring left of the dot can never sit under "Drifting back".
 */
const LIFT_TOWARD_LB = 2;
const LIFT_BACK_LB = 3;

/** "Next session: 3 × 5–8 at 145 lb": a loaded reps prescription only (never assisted, bodyweight or timed). */
function prescriptionWords(journey: StrengthJourney, units: AthleteUnits): string | null {
  const rx = journey.next_prescription;
  const t = rx?.suggested;
  if (!rx || rx.mode !== "reps" || !t) return null;
  const weight = Number(t.weight);
  const low = Number(t.rep_low);
  const high = Number(t.rep_high);
  const sets = Number(t.sets);
  if (!(weight > 0) || !(low > 0) || !(high >= low) || !(sets > 0)) return null;
  const reps = low === high ? `${low}` : `${low}–${high}`;
  const step = /^[+−-]/.test(String(rx.delta_text ?? "")) ? `, ${rx.delta_text}` : "";
  return `Next session: ${sets} × ${reps} at ${loadWords(weight, units.weight)}${step}`;
}

/**
 * What is ahead for a lift goal, in the journey's own terms: the next prescription the
 * progression engine holds for the lift now trained, and the journey's planning range
 * when it gives one (it withholds it while the lift is flat). Null when it has neither.
 */
function strengthNextWords(journey: StrengthJourney | null, units: AthleteUnits): string | null {
  if (!journey || journey.objective?.status === "completed") return null;
  const p = journey.projection;
  const range = p ? `the goal in about ${p.earliest_weeks} to ${p.latest_weeks} weeks at this pace` : null;
  return [prescriptionWords(journey, units), range].filter(Boolean).join(" · ") || null;
}

/** "Carries your Pendlay Row goal since Nov 13": only while a recorded swap carries the goal. */
function strengthCarriedWords(journey: StrengthJourney | null, today: string): string | null {
  const tracked = journey?.tracked;
  if (!tracked) return null;
  const since = dateWords(tracked.since, today);
  return `Carries your ${tracked.from} goal${since ? ` since ${since}` : ""}`;
}

/**
 * The strength row's thread over the lift's own journey: its one "now" (strengthNow),
 * its starting estimate and the same envelope four weeks back (capacityEnvelopeAsOf).
 * The direction is the move between those two drawn marks (LIFT_TOWARD_LB / LIFT_BACK_LB);
 * with no reading four weeks back it is the journey's own trend call. A lift with no
 * exposure inside the envelope's window makes no call: it says when it was last trained.
 * History is the objective's TRACKED history, so a goal carried through a swap reads the
 * lift now trained.
 */
function strengthThread(
  row: TodayPath["board"][number],
  journey: StrengthJourney | null,
  today: string,
  units: AthleteUnits
): GoalThread {
  const repsGoal = journey?.objective ? repsGoalOf(journey.objective) : null;
  if (journey && repsGoal) return repsThread(row, journey, repsGoal, today, units);
  const objective = journey?.objective ?? null;
  const now = strengthNow(journey);
  const startLb = journey?.baseline?.est_1rm ?? objective?.baseline_est_1rm ?? null;
  const startDate = journey?.baseline?.date ?? objective?.baseline_date ?? null;
  const goal = objective?.target_est_1rm ?? null;
  const agoDay = addDaysISO(today, -AGO_DAYS) ?? today;
  const ago = objective ? capacityEnvelopeAsOf(strengthObjectiveTrackedHistory(objective), agoDay) : null;
  const agoWords = ago ? dateWords(agoDay, today) : null;
  const lbWk = journey?.trend?.est_1rm_lb_per_week ?? null;
  const call = journey?.trend?.direction ?? null;
  const load = (lb: number) => weightWords(lb, units.weight, { whole: true });
  // No exposure inside the envelope's window: `now` is the last one, however old.
  const stale = !!journey && !journey.current && !!journey.latest;
  // The next standard above this lift for the athlete's own sex, age and bodyweight: a
  // waypoint, said as a load. Only from a fresh reading, and only while it is still ahead.
  const trained = journey?.tracked?.exercise ?? objective?.exercise ?? null;
  const build = !stale && !row.reached && trained && now ? safe(() => buildMarkFor(trained, now.est_1rm), null) : null;
  const mark = build != null && now && build > now.est_1rm ? build : null;
  let direction: WeekReadGoalDirection | null = null;
  let words: string | null = null;
  let move: string | null = null;
  if (row.reached) direction = "reached";
  else if (stale) words = `Last trained ${dateWords(journey?.latest?.date, today)}`;
  else if (ago && now) {
    const delta = now.est_1rm - ago.est_1rm;
    direction = delta >= LIFT_TOWARD_LB ? "toward" : delta <= -LIFT_BACK_LB ? "back" : "holding";
    const abs = Math.abs(delta);
    move = abs < 0.5 ? `level since ${agoWords}` : `${load(abs)} ${delta > 0 ? "up" : "down"} since ${agoWords}`;
  } else {
    direction = call === "rising" ? "toward" : call === "falling" ? "back" : call === "stable" ? "holding" : null;
    if (lbWk != null && Number.isFinite(lbWk)) {
      const abs = Math.abs(lbWk);
      if (abs < 0.05) move = "level";
      else {
        const perWeek = `${weightWords(abs, units.weight)} a week`;
        // Holding is the journey's call; the measure still says which way it leans.
        move = direction === "holding" ? `${perWeek} ${lbWk > 0 ? "up" : "down"}` : perWeek;
      }
    }
  }
  return {
    id: row.id,
    start_text:
      startLb != null
        ? [load(startLb), startDate ? dateWords(startDate, today) : ""].filter(Boolean).join(" · ")
        : null,
    goal_words: goal != null ? load(goal) : null,
    track: goalTrack(startLb, now?.est_1rm ?? null, goal, ago?.est_1rm ?? null, agoWords, mark),
    direction,
    direction_words: words ?? (direction ? DIRECTION_WORDS[direction] : null),
    move_words: move,
    href: WEEK_HREFS.program,
    carried_words: strengthCarriedWords(journey, today),
    next_words: strengthNextWords(journey, units),
    mark_words: mark != null ? `Next mark for your build: ${load(mark)}` : null,
  };
}

/**
 * "Next session: 3 × 8–10", at bodyweight; "… with 25 lb assist" or "… with 10 lb added"
 * when the prescription carries one. Reps work only (never timed).
 */
function repsPrescriptionWords(journey: StrengthJourney, units: AthleteUnits): string | null {
  const rx = journey.next_prescription;
  const t = rx?.suggested;
  if (!rx || rx.mode !== "reps" || !t) return null;
  const low = Number(t.rep_low);
  const high = Number(t.rep_high);
  const sets = Number(t.sets);
  if (!(low > 0) || !(high >= low) || !(sets > 0)) return null;
  const reps = low === high ? `${low}` : `${low}–${high}`;
  const weight = t.weight == null ? 0 : Number(t.weight);
  const load = (lb: number) => weightWords(lb, units.weight, { whole: true });
  const at = weight < 0 ? ` with ${load(-weight)} assist` : weight > 0 ? ` with ${load(weight)} added` : "";
  return `Next session: ${sets} × ${reps}${at}`;
}

/**
 * A REPS goal's thread (strength-reps.ts): the measure from the goal's start to its goal
 * in reps, the same envelope four weeks back as the ring, and the move between the two in
 * reps (REPS_TOWARD up = toward, REPS_BACK down = back). While no set counts yet (every
 * set assisted), the move is the assist in words and less assist is toward. No standard
 * and no build mark: a rep count has no load to compare.
 */
function repsThread(
  row: TodayPath["board"][number],
  journey: StrengthJourney,
  goal: RepsGoal,
  today: string,
  units: AthleteUnits
): GoalThread {
  const reps = journey.reps!;
  const objective = journey.objective!;
  const now = strengthRepsNow(journey);
  const start = reps.baseline?.value ?? 0;
  const startDate = reps.baseline?.date ?? objective.baseline_date ?? null;
  const agoDay = addDaysISO(today, -AGO_DAYS) ?? today;
  const ago = repsEnvelopeAsOf(strengthRepsHistory(objective.exercise), goal, agoDay);
  const agoWords = ago ? dateWords(agoDay, today) : null;
  const stale = !reps.now && !!reps.latest;
  const load = (lb: number) => weightWords(lb, units.weight, { whole: true });
  let direction: WeekReadGoalDirection | null = null;
  let words: string | null = null;
  let move: string | null = null;
  if (row.reached) direction = "reached";
  else if (stale) words = `Last trained ${dateWords(reps.latest?.date, today)}`;
  else if (now && ago) {
    direction = repsDirection(now, ago);
    if (now.value === 0 && ago.value === 0) move = assistWords(now.assist_lb, ago.assist_lb, load);
    else {
      const delta = now.value - ago.value;
      const abs = Math.abs(delta);
      move =
        abs === 0
          ? `level since ${agoWords}`
          : `${abs} ${abs === 1 ? "rep" : "reps"} ${delta > 0 ? "up" : "down"} since ${agoWords}`;
    }
  } else if (now && now.value === 0) move = assistWords(now.assist_lb, reps.start_assist_lb, load);
  return {
    id: row.id,
    start_text: reps.baseline
      ? [repsValueText(start, goal), startDate ? dateWords(startDate, today) : ""].filter(Boolean).join(" · ")
      : null,
    goal_words: reps.goal_text,
    track: goalTrack(start, now?.value ?? null, reps.goal_value, ago?.value ?? null, agoWords),
    direction,
    direction_words: words ?? (direction ? DIRECTION_WORDS[direction] : null),
    move_words: move,
    href: WEEK_HREFS.program,
    carried_words: null,
    next_words: objective.status === "completed" ? null : repsPrescriptionWords(journey, units),
    mark_words: null,
  };
}

/** The strength row's count words, in a fixed order; a group of none is left out. */
const LIFT_GROUPS: ReadonlyArray<[WeekReadGoalDirection, string]> = [
  ["toward", "rising"],
  ["holding", "holding"],
  ["back", "drifting back"],
  ["reached", "reached"],
];

/**
 * The lift goals counted by their journeys' own calls: "Two rising, one holding, two
 * drifting back"; one group holding every lift reads "All five rising" ("Both rising" for two).
 * A lift whose journey makes no call yet is in no group. Null when none makes a call.
 */
export function liftCountWords(directions: ReadonlyArray<WeekReadGoalDirection | null>): string | null {
  const parts = LIFT_GROUPS.map(([dir, word]) => [directions.filter((d) => d === dir).length, word] as const).filter(
    ([n]) => n > 0
  );
  if (!parts.length) return null;
  if (parts.length === 1 && parts[0][0] === directions.length)
    return directions.length === 2 ? `Both ${parts[0][1]}` : `All ${numberWord(directions.length)} ${parts[0][1]}`;
  return cap(parts.map(([n, word]) => `${numberWord(n)} ${word}`).join(", "));
}

/**
 * Two or more live lift goals: ONE strength row that names every one of them (in the
 * board's order) instead of an arbitrary first. Each lift is the very thread the single
 * row would show (strengthThread): its now, track, direction and move words.
 */
function strengthGoalOfMany(
  rows: ReadonlyArray<TodayPath["board"][number]>,
  ctx: { journeys: StrengthJourney[]; today: string; units: AthleteUnits }
): WeekReadGoal {
  // The count words and "N lifts" speak only of the lifts the row lists, so they always agree.
  const lifts: WeekReadGoalLift[] = rows.slice(0, WEEK_GOAL_LIFTS_MAX).map((row) => {
    const journey = ctx.journeys.find((j) => strengthRowId(j) === row.id) ?? null;
    const thread = safe<Partial<GoalThread>>(() => strengthThread(row, journey, ctx.today, ctx.units), {});
    return {
      id: row.id,
      label: row.label,
      now_text: row.now_text,
      goal_text: row.goal_text ?? null,
      track: thread.track ?? null,
      direction: thread.direction ?? null,
      direction_words: thread.direction_words ?? null,
      move_words: thread.move_words ?? null,
      carried_words: thread.carried_words ?? null,
      next_words: thread.next_words ?? null,
      mark_words: thread.mark_words ?? null,
    };
  });
  const count = liftCountWords(lifts.map((l) => l.direction));
  const total = cap(numberWord(lifts.length));
  // "Three lift goals: one rising, …"; one group holding them all: "Three lift goals, all rising."
  const whole = count?.match(/^(?:All \S+|Both) (.+)$/);
  const line = !count
    ? `${total} lift goals.`
    : whole
      ? `${total} lift goals, ${lifts.length === 2 ? "both" : "all"} ${whole[1]}.`
      : `${total} lift goals: ${count[0].toLowerCase()}${count.slice(1)}.`;
  return {
    key: "strength",
    label: "Strength",
    now_text: `${lifts.length} lifts`,
    goal_text: null,
    progress: null,
    line,
    id: "strength",
    start_text: null,
    goal_words: null,
    track: null,
    direction: null,
    direction_words: null,
    move_words: count,
    href: WEEK_HREFS.program,
    lifts,
  };
}

function goalsOf(
  path: TodayPath | null,
  trend: WeightTrendRead | null,
  ctx: { build: RaceBuild | null; journeys: StrengthJourney[]; today: string; units: AthleteUnits }
): WeekReadGoal[] {
  if (!path) return [];
  const out: WeekReadGoal[] = [];
  const board = path.board ?? [];
  const race = path.race;
  const raceRow = board.find((r) => r.key === "race");
  if (race && raceRow) {
    const now = race.estimate_text ?? raceRow.now_text;
    const target = race.target_text ?? raceRow.goal_text;
    const fit = race.fit && target ? FIT_WORDS[race.fit]?.(target) : null;
    out.push({
      key: "race",
      label: race.event || race.distance_label,
      now_text: now,
      goal_text: target ?? null,
      progress: raceRow.progress,
      line: `Reads ${now}${fit ? `, ${fit}` : ""}.`,
      fit: race.fit,
      ...safe<GoalThread>(() => raceThread(path, ctx.build, ctx.today), { id: "race", href: WEEK_HREFS.race }),
    });
  }
  const weightRow = board.find((r) => r.key === "weight");
  if (weightRow) {
    const profile = safe(() => getProfile(), null);
    out.push({
      key: "weight",
      label: weightRow.label,
      now_text: weightRow.now_text,
      goal_text: weightRow.goal_text,
      progress: weightRow.progress,
      line: trend?.line ?? null,
      ...safe<GoalThread>(
        () =>
          path.weight
            ? weightThread(path, trend, profile, ctx.today, ctx.units)
            : { id: "weight", href: WEEK_HREFS.goal },
        { id: "weight", href: WEEK_HREFS.goal }
      ),
    });
  }
  const strengthRows = board.filter((r) => r.key === "strength");
  // Two or more lift goals: one row that names them all; one: that lift's own thread.
  const strength = strengthRows.length === 1 ? strengthRows[0] : null;
  if (strengthRows.length >= 2) out.push(strengthGoalOfMany(strengthRows, ctx));
  else if (strength) {
    const journey = ctx.journeys.find((j) => strengthRowId(j) === strength.id) ?? null;
    out.push({
      key: "strength",
      label: strength.label,
      now_text: strength.now_text,
      goal_text: strength.goal_text,
      progress: strength.progress,
      line: journey?.reps
        ? `Best ${strength.now_text} at bodyweight${strength.note ? `, ${lowerFirst(strength.note)}` : ""}.`
        : strength.note
          ? `Est. 1RM ${strength.now_text}, ${strength.note}.`
          : `Est. 1RM ${strength.now_text}.`,
      ...safe<GoalThread>(() => strengthThread(strength, journey, ctx.today, ctx.units), {
        id: strength.id,
        href: WEEK_HREFS.program,
      }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Proof — what has measurably changed since the athlete started. A before and an
// after, never a grade; the series is a drawing aid (0..1), never printed.
// ---------------------------------------------------------------------------

/** Thin a long series evenly, keeping the first and the last point. */
function thin<T>(values: readonly T[], max = PROOF_SERIES_MAX): T[] {
  if (values.length <= max) return [...values];
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(values[Math.round((i * (values.length - 1)) / (max - 1))]);
  return out;
}

/**
 * Values → 0..1 for drawing. A line or steps spans its own min..max; columns stand on
 * the ground (value / max). Fewer than two values draw nothing ([]).
 */
export function proofSeries(values: readonly number[], kind: WeekReadProof["series_kind"]): number[] {
  const vs = values.filter((v) => Number.isFinite(v));
  if (vs.length < 2) return [];
  const max = Math.max(...vs);
  if (kind === "columns") return max > 0 ? vs.map((v) => round3(Math.max(0, v) / max)) : [];
  const min = Math.min(...vs);
  return vs.map((v) => (max === min ? 0.5 : round3((v - min) / (max - min))));
}

/**
 * The race just run, while RACE_PROOF_DAYS last. The race OUTLIVES its goal (a new goal
 * set the day after keeps it in completed_races, race-recovery.ts), so it is found by its
 * logged effort — never through the live build's `finished`, which shows 14 days and only
 * while the goal still points at it. The picture is the build's weekly running from its
 * goal review, when one has been written; else no picture.
 */
function raceProof(today: string, units: AthleteUnits): WeekReadProof | null {
  const race = latestFinishedRace(today, RACE_PROOF_DAYS);
  if (!race || race.provisional) return null;
  const review = safe(
    () =>
      goalReviewRecords().find((r) => {
        const facts = r.facts as RaceReviewFacts;
        return r.kind === "race" && facts?.kind === "race" && facts.race_date === race.run_date;
      }) ?? null,
    null
  );
  const facts = review ? (review.facts as RaceReviewFacts) : null;
  const run = raceRunActivity(race.activity_id);
  const finish = run?.duration_min != null ? Math.round(run.duration_min * 60) : (facts?.result?.finish_sec ?? null);
  const name = race.event?.trim() || raceDistanceName(race.distance_km, units.distance);
  const weeks = [...(facts?.build?.weeks ?? [])]
    .filter((w) => w.week_start <= race.run_date)
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .slice(-RACE_PROOF_WEEKS);
  return {
    key: "race_done",
    stone: "endurance",
    label: "Running",
    before_text: null,
    after_text: finish != null ? `${name} · ${clockWords(finish)}` : name,
    since_words: null,
    series: proofSeries(
      weeks.map((w) => (Number(w.km) || 0) + (Number(w.race_km) || 0)),
      "columns"
    ),
    series_kind: "columns",
    href: review ? WEEK_HREFS.behind(review.id) : null,
  };
}

/** Weekly means of a weigh-in series, oldest first. */
function weeklyMeans(points: readonly WeighIn[]): number[] {
  const byWeek = new Map<string, { sum: number; n: number }>();
  for (const p of points) {
    const wk = mondayOf(p.date);
    const cell = byWeek.get(wk) ?? { sum: 0, n: 0 };
    cell.sum += p.weight_lb;
    cell.n += 1;
    byWeek.set(wk, cell);
  }
  return [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, c]) => c.sum / c.n);
}

/**
 * The weight journey from its start (the board's own start and its "moved" rule: at
 * least half a pound, toward the goal) to the latest weigh-in.
 */
function weightProof(path: TodayPath, today: string, units: AthleteUnits): WeekReadProof | null {
  const weight = path.weight;
  const row = (path.board ?? []).find((r) => r.key === "weight");
  if (!weight || !row?.moved_words || !((row.progress ?? 0) > 0)) return null;
  const begin = weightStart(
    weight,
    safe(() => getProfile(), null)
  );
  if (!begin) return null;
  const series: readonly WeighIn[] = begin.date
    ? canonicalBodyweightSeries({ since: begin.date, through: today })
    : weight.points;
  return {
    key: "weight",
    stone: "body",
    label: "Weight",
    before_text: weightWords(begin.lb, units.weight),
    after_text: weightWords(weight.current_lb, units.weight),
    since_words: begin.date ? sinceWords(begin.date, today) || null : null,
    series: proofSeries(thin(weeklyMeans(series)), "line"),
    series_kind: "line",
    href: WEEK_HREFS.goal,
  };
}

/** The most strength rows the proof carries: the anchor lift, then the next lift that rose. */
const STRENGTH_PROOF_MAX = 2;

/**
 * A lift's working load (the ONE definition, sessionWorkingLoad) from the objective's
 * start to its latest session — only when it rose. Assisted or bodyweight work is never
 * spoken here (negative = assist: the load words would lie).
 */
function strengthProof(
  exercise: string | null | undefined,
  journeys: StrengthJourney[],
  today: string,
  units: AthleteUnits
): WeekReadProof | null {
  if (!exercise) return null;
  const journey = journeys.find((j) => j.objective?.exercise === exercise) ?? null;
  // A reps goal's proof is its own row's reps, never a working load.
  if (journey?.reps) return null;
  const since = journey?.objective?.baseline_date ?? addDaysISO(today, -182) ?? today;
  const history = workingLoadHistory(exercise, { since, through: today });
  if (history.assisted || history.points.length < 2) return null;
  const first = history.points[0];
  const last = history.points[history.points.length - 1];
  if (!(last.load_lb > first.load_lb)) return null;
  const set = (p: { load_lb: number; reps: number }) => `${loadWords(p.load_lb, units.weight)} × ${p.reps}`;
  return {
    key: "strength",
    stone: "strength",
    label: exercise,
    before_text: set(first),
    after_text: set(last),
    since_words: sinceWords(first.date, today) || null,
    series: proofSeries(thin(history.points.map((p) => p.load_lb)), "steps"),
    series_kind: "steps",
    href: WEEK_HREFS.program,
  };
}

/**
 * Up to STRENGTH_PROOF_MAX lifts whose working load rose: the anchor lift first, then the
 * live journeys in the board's order.
 */
function strengthProofs(
  path: TodayPath,
  journeys: StrengthJourney[],
  today: string,
  units: AthleteUnits
): WeekReadProof[] {
  const anchor = path.anchor?.exercise ?? null;
  const rest = (path.board ?? [])
    .filter((r) => r.key === "strength")
    .map((r) => journeys.find((j) => strengthRowId(j) === r.id)?.objective?.exercise ?? null)
    .filter((exercise): exercise is string => !!exercise && exercise !== anchor);
  const out: WeekReadProof[] = [];
  for (const exercise of [anchor, ...rest]) {
    if (out.length >= STRENGTH_PROOF_MAX) break;
    const row = safe(() => strengthProof(exercise, journeys, today, units), null);
    if (row) out.push(row);
  }
  return out;
}

/**
 * This week's proof: a race just run first, then the weight journey, then up to two lifts
 * that rose. At most three. The weight journey is left out beside a weight goal row that
 * draws its track: that row already shows its start, now and goal.
 */
export function proofOf(
  path: TodayPath | null,
  journeys: StrengthJourney[],
  today: string,
  units: AthleteUnits,
  goals: readonly WeekReadGoal[] = []
): WeekReadProof[] {
  const weightOnGoals = goals.some((g) => g.key === "weight" && g.track != null);
  const rows = [
    safe(() => raceProof(today, units), null),
    path && !weightOnGoals ? safe(() => weightProof(path, today, units), null) : null,
    ...(path ? safe(() => strengthProofs(path, journeys, today, units), [] as WeekReadProof[]) : []),
  ];
  return rows.filter((r): r is WeekReadProof => !!r).slice(0, PROOF_MAX);
}

// ---------------------------------------------------------------------------
// The hero's quiet line: the week's counts said once, then the far race.
// ---------------------------------------------------------------------------

/** "the bench", "the press": a lead lift inside a sentence. */
export function liftShortName(exercise: string): string {
  const n = String(exercise ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (/overhead|military|\bohp\b|shoulder press/.test(n)) return "the press";
  if (/bench/.test(n)) return "the bench";
  if (/deadlift/.test(n) && !/romanian|\brdl\b|stiff/.test(n)) return "the deadlift";
  if (/squat/.test(n)) return "the squat";
  if (/\brow\b/.test(n)) return "the row";
  if (/pull-?up|chin-?up/.test(n)) return "the pull-up";
  return `the ${n.replace(/^(barbell|dumbbell|db|bb)\s+/, "")}`;
}

/** Key runs (long, quality) still open this week from `today`, or planned in a later week. */
function keyRunsAhead(week: PlanWeek | null, today: string, when: "past" | "this" | "future"): number {
  if (!week || when === "past") return 0;
  const seen = new Set<string>();
  for (const d of week.days) {
    const r = d.run;
    if (!r || r.rested || r.status !== "open" || (r.kind !== "long" && r.kind !== "quality")) continue;
    if (when === "this" && (!d.date || d.date < today)) continue;
    seen.add(`${d.date}:${r.kind}`);
  }
  return seen.size;
}

/**
 * The week's counts in one plain sentence: "One lift in of five, two key runs ahead."
 * Counts only, never a verdict — the summary keeps the full sentence; this is the
 * hero's quiet line when the purpose leads.
 */
export function weekCountSentence(
  totals: Pick<WeekReadTotals, "lift_days_done" | "lift_days_planned">,
  keyRuns: number,
  when: "past" | "this" | "future"
): string | null {
  const done = totals.lift_days_done;
  const planned = totals.lift_days_planned ?? 0;
  const lifts = (n: number) => (n === 1 ? "lift" : "lifts");
  const days = (n: number) => `lifting ${n === 1 ? "day" : "days"}`;
  const runs = keyRuns > 0 ? `${numberWord(keyRuns)} key ${keyRuns === 1 ? "run" : "runs"}` : "";
  let sentence: string;
  if (when === "past") {
    if (!done) return null;
    sentence = planned
      ? `${numberWord(done)} of ${numberWord(planned)} ${days(planned)} went in`
      : `${numberWord(done)} ${days(done)} went in`;
  } else if (when === "future" || done === 0) {
    const parts = [planned ? `${numberWord(planned)} ${days(planned)}` : "", runs].filter(Boolean);
    if (!parts.length) return null;
    sentence = `${parts.join(" and ")} ahead`;
  } else {
    const liftPart = planned
      ? done >= planned
        ? `all ${numberWord(planned)} ${lifts(planned)} in`
        : `${numberWord(done)} ${lifts(done)} in of ${numberWord(planned)}`
      : `${numberWord(done)} ${lifts(done)} in`;
    sentence = runs ? `${liftPart}, ${runs} ahead` : liftPart;
  }
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

// ---------------------------------------------------------------------------
// The journey — Today's path as a trail: where it began, every dated mark ahead,
// and what has already moved toward a goal. Re-derives nothing.
// ---------------------------------------------------------------------------

/** The most "behind you" lines the trail carries. */
const JOURNEY_BEHIND_MAX = 3;

// Days to a mark: the ONE away-words rule (display-words.ts awayWords) — the same floored
// weeks count as the race build's countdown, so the trail and the race page agree.
const daysAwayWords = awayWords;

/** The trail's short word beside a mark, from the milestone's own label (already in units). */
function markShort(m: TodayPath["milestones"][number], path: TodayPath): string {
  const tail = (m.label.split(" · ")[1] ?? "").split(",")[0].trim();
  switch (m.kind) {
    case "race": {
      const d = path.race?.distance_label ?? "";
      return d === "Half marathon" ? "Half" : d || "Race";
    }
    case "goal":
      return path.weight?.goal_text || tail || "Goal";
    case "peak_week":
      return tail || "Peak";
    case "long_run":
      return tail ? `Long ${tail}` : "Long run";
    case "checkpoint":
      return "Test";
    default:
      return "Checkup";
  }
}

/** A mark named inside a sentence: "the Cambridge Half", "the peak week", "your goal weight". */
function markName(m: WeekReadJourneyMark): string {
  switch (m.kind) {
    case "race":
      return m.label;
    case "goal":
      return "your goal weight";
    case "peak_week":
      return "the peak week";
    case "long_run":
      return "the long run";
    case "checkpoint":
      return "the strength checkpoint";
    default:
      return "the checkup";
  }
}

/**
 * Date words inside a "since …" sentence. `since_words` already begins with "since"
 * ("since Sep 19", "since yesterday"); a bare ISO falls back to `dateWords`.
 */
function sinceDateWords(words: string | null | undefined, iso: string | null | undefined): string {
  let said = String(words ?? "")
    .replace(/\s+/g, " ")
    .trim();
  while (/^since\s+/i.test(said)) said = said.replace(/^since\s+/i, "").trim();
  return said || dateWords(iso || "") || "";
}

/** "Race estimate 7 min faster since Sep 19". Empty when the date cannot be named. */
export function raceFasterSince(
  min: number,
  sinceWords: string | null | undefined,
  sinceIso: string | null | undefined
): string {
  const since = sinceDateWords(sinceWords, sinceIso);
  return since ? `Race estimate ${min} min faster since ${since}` : "";
}

/** "Cambridge Half Marathon run · 2:10:18" — the race just run, first behind you while it is shown. */
function raceDoneWords(finished: RaceBuild["finished"]): string {
  if (!finished) return "";
  const name = finished.event?.trim() || "Race";
  return finished.finish_sec != null ? `${name} run · ${clockWords(finished.finish_sec)}` : `${name} run`;
}

function behindOf(path: TodayPath, finished: RaceBuild["finished"] = null): WeekReadJourneyBehind[] {
  const out: WeekReadJourneyBehind[] = [];
  const done = raceDoneWords(finished);
  if (done) out.push({ key: "race_done", words: done });
  const race = path.race;
  if (race && race.trend_delta_sec != null && race.trend_delta_sec <= -30 && race.since) {
    const min = Math.max(1, Math.round(-race.trend_delta_sec / 60));
    const words = raceFasterSince(min, race.since_words, race.since);
    if (words) out.push({ key: "race", words });
  }
  for (const row of path.board ?? []) {
    // Weight is Today's own row, word for word ("6 lb down since Aug 3"): never a delta
    // re-derived from a raw window, so the two surfaces cannot disagree.
    if (row.key === "weight" && row.moved_words && (row.progress ?? 0) > 0)
      out.push({ key: "weight", words: row.moved_words });
  }
  for (const row of path.board ?? []) {
    if (row.key !== "strength") continue;
    if (row.reached) out.push({ key: "strength", words: `${row.label} goal reached, ${row.now_text}` });
    else if (row.start_text && (row.progress ?? 0) > 0)
      out.push({ key: "strength", words: `${row.label} ${row.start_text} → ${row.now_text}` });
  }
  return out.slice(0, JOURNEY_BEHIND_MAX);
}

/**
 * One calm line of where the athlete stands. `walked` counts only from a real start (the
 * race trend's own window); a default look-back window is never spoken as days walked.
 */
function journeyLine(walked: number | null, marks: WeekReadJourneyMark[], today: string): string {
  const next = marks[0];
  // The summit is the mark the road ends at (latest end), the same one journeyOf flags.
  const summit = marks.find((m) => m.summit) ?? marks[marks.length - 1];
  const nextPart = `${markName(next)} ${next.days_words}`;
  const total = (walked ?? 0) + summit.days_away;
  const share = walked != null && total > 0 ? walked / total : 0;
  const lead =
    share >= 0.8
      ? pickDayVariant(["Most of this road is behind you.", "The summit is in sight."], today, "week:journey:far")
      : share >= 0.5
        ? pickDayVariant(
            ["Past halfway on this road.", "More of this road is behind you than ahead."],
            today,
            "week:journey:half"
          )
        : walked != null && walked >= 7
          ? pickDayVariant(
              [`${walked} days on this road so far.`, `${walked} days walked on this road.`],
              today,
              "week:journey:early"
            )
          : pickDayVariant(
              ["One week at a time.", "Steady steps add up.", "Every logged day is a step on it."],
              today,
              "week:journey:start"
            );
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (summit === next) return `${lead} ${cap(nextPart)}.`;
  return `${lead} Next, ${nextPart}; ${markName(summit)} ${summit.days_words}.`;
}

function journeyOf(
  path: TodayPath | null,
  today: string,
  finished: RaceBuild["finished"] = null
): WeekReadJourney | null {
  if (!path) return null;
  const ahead = (path.milestones ?? []).filter((m) => m.date >= today);
  if (!ahead.length) return null;
  const start = path.trail_start && path.trail_start < today ? path.trail_start : today;
  const last = ahead.reduce((a, b) => ((b.end_date ?? b.date) > (a.end_date ?? a.date) ? b : a));
  const marks: WeekReadJourneyMark[] = ahead.map((m) => {
    const days = Math.max(0, daysBetweenISO(m.date, today) ?? 0);
    return {
      kind: m.kind,
      label: m.label,
      date: m.date,
      end_date: m.end_date,
      date_words: m.date_words ?? (m.end_date ? dateRangeWords(m.date, m.end_date) : dateWords(m.date)),
      detail: m.detail,
      href: milestoneHref(m.kind, m.date),
      short: markShort(m, path),
      days_away: days,
      days_words: daysAwayWords(days),
      summit: m === last,
    };
  });
  const walked = path.race?.since === start ? Math.max(0, daysBetweenISO(today, start) ?? 0) : null;
  return {
    start_date: start,
    start_words: dateWords(start, today),
    today,
    marks,
    behind: behindOf(path, finished),
    line: journeyLine(walked, marks, today),
  };
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * The week holding `start` (default: this week). `today` defaults to the server's local
 * date; `build` lets a caller that already read the race build share it.
 */
export function weekRead(start?: string, opts: { today?: string; build?: RaceBuild | null } = {}): WeekRead {
  const today = opts.today ?? localDateISO();
  const day = isoDate(String(start ?? today).slice(0, 10)) ?? today;
  const weekStart = mondayOf(day);
  const weekEnd = addDaysISO(weekStart, 6) ?? weekStart;
  const thisWeek = weekStart === mondayOf(today);
  const when: "past" | "this" | "future" = thisWeek ? "this" : weekStart > today ? "future" : "past";
  const asOf = dayDetailWeekAsOf(weekStart, today);
  const units = athleteUnits();
  const build = opts.build !== undefined ? opts.build : safe(() => raceBuild(today, { describeRunning: true }), null);

  const week = safe(() => planWeek(asOf), null);
  // One read of the strength journeys, shared with Today's path: one "now" per lift.
  const journeys = safe(() => liveStrengthJourneys(getStrengthJourneys()), [] as StrengthJourney[]);
  const path = safe(() => todayPath(today, { build, journeys }), null);
  // The lead lift is spoken in the week's purpose only while its own journey calls it rising.
  const anchor = path?.anchor ?? null;
  const anchorJourney = anchor ? journeys.find((j) => j.objective?.exercise === anchor.exercise) : null;
  const lift = anchor && anchorJourney?.trend?.direction === "rising" ? liftShortName(anchor.exercise) : null;
  const frame = weekFrameLine(thisWeek ? today : weekStart, { build, asOf: today, lift });
  const trend = safe(() => weightTrendRead(today, { units: units.weight }), null);

  const cells = week?.days ?? [];
  const longest = cells.reduce<number | null>(
    (best, d) => (d.run?.kind === "long" && d.run.km != null && (best == null || d.run.km > best) ? d.run.km : best),
    null
  );
  const heavy = new Set<number>();
  for (const g of safe(() => planDayStrengthGroups(), [])) if (g.heavy_lower) heavy.add(g.day_number);
  const days = cells.map((cell) => chipOf(cell, today, units, longest, heavy));
  const buildWeekKm =
    thisWeek && build?.this_week?.week_start === weekStart && build.this_week.km > 0 ? build.this_week.km : null;
  const totals: WeekReadTotals = week
    ? totalsOf(week, units, buildWeekKm)
    : {
        lift_days_done: 0,
        lift_days_planned: null,
        runs_done: 0,
        runs_planned: 0,
        run_km_done: 0,
        run_km_planned: null,
        units: units.distance,
        lift_words: null,
        run_words: null,
      };
  const stillOpen = week && when !== "past" ? stillOpenOf(week, today) : [];
  // The hero's quiet line: when the purpose leads, the week's counts and then the far
  // race ("One lift in of five, two key runs ahead. 5K time trial in 25 weeks."); when
  // the countdown leads, the purpose.
  const count =
    frame.lead === "purpose"
      ? safe(() => weekCountSentence(totals, keyRunsAhead(week, today, when), when), null)
      : null;
  const sub = frame.lead === "purpose" ? [count, frame.sub].filter(Boolean).join(" ") || null : frame.sub;

  const goals = goalsOf(path, trend, { build, journeys, today, units });

  return {
    as_of: asOf,
    today,
    week_start: weekStart,
    week_end: weekEnd,
    range_words: dateRangeWords(weekStart, weekEnd, today),
    this_week: thisWeek,
    units: { distance: units.distance, weight: units.weight },
    frame: {
      stage: frame.stage
        ? { key: frame.stage.key, word: frame.stage.word, week_word: frame.stage.week_word, source: frame.stage.source }
        : null,
      block: frame.block,
      countdown: frame.countdown,
      push: frame.push,
      purpose: frame.purpose,
      ...(frame.lead ? { lead: frame.lead } : {}),
      sub,
      headline: frame.headline,
      line: frame.line,
      glance: frame.glance,
    },
    summary: summaryOf(frame.stage?.week_word ?? null, totals, stillOpen, when),
    totals,
    days,
    layout_note: week && !week.layout.clean ? week.layout.suggestion : null,
    still_open: stillOpen,
    next_milestones: milestonesBeyond(path, weekEnd),
    goals,
    proof: thisWeek ? safe(() => proofOf(path, journeys, today, units, goals), []) : [],
    standing: thisWeek ? safe(() => standingRead(today, units, { build, path }), []) : [],
    journey: thisWeek ? safe(() => journeyOf(path, today, build?.finished ?? null), null) : null,
    weight_trend: trend,
  };
}
