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
// Every string a person reads is in the athlete's units (athleteUnits → display-words)
// and names its dates in words. The load shape is a dose WORD and a relative height for
// drawing — never a number shown, never a score. Changes nothing.
import type {
  WeekReadJourney,
  WeekReadJourneyBehind,
  WeekReadJourneyMark,
  DayChip,
  WeekDose,
  WeekRead,
  WeekReadGoal,
  WeekReadMilestone,
  WeekReadOpen,
  WeekReadTotals,
} from "../../contracts/week-read.js";
import { addDaysISO, daysBetweenISO, isoDate, mondayOf } from "../../lib/dates.js";
import { round1 } from "../../lib/numbers.js";
import {
  dateRangeWords,
  dateWords,
  distanceOfWords,
  distanceWords,
  weightDeltaWords,
  type AthleteUnits,
} from "../../repo/display-words.js";
import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import { raceBuild, type RaceBuild } from "../../repo/race-build.js";
import { RUN_KIND_LABELS } from "../../repo/run-edit.js";
import { athleteUnits } from "../../repo/settings.js";
import { localDateISO } from "../../repo/shared.js";
import { todayPath } from "../../repo/today-path.js";
import { planDayStrengthGroups } from "../../repo/training-read.js";
import { weekFrameLine } from "../../repo/week-stage.js";
import { weightTrendRead } from "../../repo/weight-trend.js";
import type { TodayPath } from "../../contracts/today-path.js";
import { dayDetailWeekAsOf } from "./day-detail.js";
import { planWeek, type PlanWeek, type PlanWeekDay } from "./plan-week.js";

export type { WeekRead } from "../../contracts/week-read.js";

/** The most still-open lines the week carries; the rest is the week's shape. */
const STILL_OPEN_MAX = 2;
/** The milestones beyond this week the page lists. */
const NEXT_MILESTONES_MAX = 3;

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
  const liftTitle = text(cell.plan_day?.name) || text(cell.session?.title);
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
    }));
}

const FIT_WORDS: Record<string, (target: string) => string> = {
  fits: (t) => `inside ${t}`,
  stretch: (t) => `${t} is a stretch from here`,
  beyond_horizon: (t) => `${t} sits past this build`,
};

function goalsOf(path: TodayPath | null, weightLine: string | null): WeekReadGoal[] {
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
    });
  }
  const weightRow = board.find((r) => r.key === "weight");
  if (weightRow) {
    out.push({
      key: "weight",
      label: weightRow.label,
      now_text: weightRow.now_text,
      goal_text: weightRow.goal_text,
      progress: weightRow.progress,
      line: weightLine,
    });
  }
  const strength = board.find((r) => r.key === "strength");
  if (strength) {
    out.push({
      key: "strength",
      label: strength.label,
      now_text: strength.now_text,
      goal_text: strength.goal_text,
      progress: strength.progress,
      line: strength.note ? `Est. 1RM ${strength.now_text}, ${strength.note}.` : `Est. 1RM ${strength.now_text}.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The journey — Today's path as a trail: where it began, every dated mark ahead,
// and what has already moved toward a goal. Re-derives nothing.
// ---------------------------------------------------------------------------

/** The most "behind you" lines the trail carries. */
const JOURNEY_BEHIND_MAX = 3;

function daysAwayWords(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days >= 21) return `in ${Math.round(days / 7)} weeks`;
  return `in ${days} days`;
}

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

function behindOf(path: TodayPath, units: AthleteUnits): WeekReadJourneyBehind[] {
  const out: WeekReadJourneyBehind[] = [];
  const race = path.race;
  if (race && race.trend_delta_sec != null && race.trend_delta_sec <= -30 && race.since) {
    const min = Math.max(1, Math.round(-race.trend_delta_sec / 60));
    const since = race.since_words || dateWords(race.since);
    out.push({ key: "race", words: `Race estimate ${min} min faster since ${since}` });
  }
  const w = path.weight;
  const first = w?.points?.[0];
  if (w && first && w.mode !== "maintain") {
    const delta = w.current_lb - first.weight_lb;
    const toward = w.mode === "lose" ? delta <= -0.5 : delta >= 0.5;
    if (toward)
      out.push({ key: "weight", words: `${weightDeltaWords(delta, units.weight)} since ${dateWords(first.date)}` });
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

function journeyOf(path: TodayPath | null, today: string, units: AthleteUnits): WeekReadJourney | null {
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
    behind: behindOf(path, units),
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
  const frame = weekFrameLine(thisWeek ? today : weekStart, { build, asOf: today });
  const path = safe(() => todayPath(today, { build }), null);
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
    goals: goalsOf(path, trend?.line ?? null),
    journey: thisWeek ? safe(() => journeyOf(path, today, units), null) : null,
    weight_trend: trend,
  };
}
