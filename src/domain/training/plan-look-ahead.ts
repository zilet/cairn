// PLAN LOOK-AHEAD — the Program landing's calm read-only week: today through the end of
// next week, a row a day.
//
// Composed from reads that already own their facts; nothing is re-derived here:
//   - the calendar: planWeek, the plan strip's own week. This week is read AS OF today
//     (so the rows agree with the strip, Horizon's week and Today), next week as of its
//     own Monday (`lookAheadWeekAsOf`, the same rule the day preview reads, so a tapped
//     day opens on the words its row showed). Plan days hold strength only; runs and
//     rest come from the calendar, never a plan row.
//   - today's lift: the one server strength line (todayStrengthLine), carried whole so
//     the renderer prints it verbatim and never works a state out of the log.
//   - a lift day's key movements: the plan day's own items, in plan order.
//   - the week's context: the race build's ladder rung (build/down/peak/taper/race), an
//     applied or announced recovery week, a block deload that will actually run
//     (block-phase.ts, so a push athlete's skipped deload is never named).
//
// Changes nothing. Words and kilometres only: no score, no gate.
import { addDaysISO, mondayOf } from "../../lib/dates.js";
import { resolvedBlockPhase, nextWeekScheduledDeloadRuns } from "../../repo/block-phase.js";
import { getPlan } from "../../repo/plan.js";
import { isoDow, WEEKDAY_NAMES } from "../../repo/profile.js";
import { raceBuild } from "../../repo/race-build.js";
import { activeRecoveryWeek, recoveryWeekStatus } from "../../repo/recovery-week.js";
import { RUN_KIND_LABELS } from "../../repo/run-edit.js";
import { athleteUnits } from "../../repo/settings.js";
import { rungStage } from "../../repo/week-stage.js";
import { localDateISO } from "../../repo/shared.js";
import { todayStrengthLine, type TodayStrengthLine } from "../../repo/today-strength-line.js";
import type { DayDetailExercise } from "../../contracts/day-detail.js";
// A function-level cycle (day-detail reads lookAheadWeekAsOf): neither module touches the other at load.
import { planDayExercisesAhead } from "./day-detail.js";
import { planWeek, type PlanWeek, type PlanWeekDay } from "./plan-week.js";

/** How many of a lift day's movements a row names; the rest are counted. */
export const LOOK_AHEAD_KEY_LIFTS = 3;

export interface PlanLookAheadLift {
  /** The plan day's NAME ("Pull"). Today's row prints the strength line instead. */
  title: string;
  focus: string | null;
  /** The plan day's first movements, in plan order. */
  lifts: string[];
  /** How many more movements the day holds past `lifts`. */
  more: number;
  /** Logged already (today's row only; a future day is never done). */
  done: boolean;
  /**
   * `order` mode only (a row with no date to open a day page on): the plan day's
   * exercises with their next prescription, opened in place on the Program landing.
   */
  exercises?: DayDetailExercise[];
}

export interface PlanLookAheadRun {
  kind: string;
  /** "Easy run" / "Long run"; today's open run keeps the agenda's own word for the morning. */
  label: string;
  /** Prescribed distance, or the logged one once done. Always km; the client prints run units. */
  km: number | null;
  done: boolean;
}

export interface PlanLookAheadDay {
  date: string;
  /** Short weekday ("Mon"). */
  weekday: string;
  today: boolean;
  lift: PlanLookAheadLift | null;
  run: PlanLookAheadRun | null;
  /** Neither a lift nor a run: the calendar's rest day. */
  rest: boolean;
  /** Heavy lower or a quality/long run: the week's harder days, said as a quiet mark. */
  hard: boolean;
}

export type PlanLookAheadMarkerKind = "race_build" | "recovery" | "deload";

export interface PlanLookAheadMarker {
  kind: PlanLookAheadMarkerKind;
  /** A few words for a tag ("Taper week", "Recovery week"). */
  word: string;
  /** One short line beside it, or null. */
  note: string | null;
}

export interface PlanLookAheadWeek {
  week_start: string;
  label: "This week" | "Next week";
  markers: PlanLookAheadMarker[];
  days: PlanLookAheadDay[];
}

export interface PlanLookAhead {
  as_of: string;
  /**
   * `calendar` dated rows; `order` a plan with no lifting weekdays known yet (no dates
   * to place it on, so the lifting days read in ring order); `empty` nothing planned.
   */
  mode: "calendar" | "order" | "empty";
  run_units: "km" | "mi";
  /** Today's lift in the one line the Brief, Session and plan strip print. */
  strength_line: TodayStrengthLine | null;
  weeks: PlanLookAheadWeek[];
  /** `order` mode: the lifting days in the order they come round, the next one first. */
  order: PlanLookAheadLift[];
}

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

function km(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
}

/**
 * The as-of day a week is read from. The week holding today is read as of today; a
 * later week as of its own Monday, its opening with the whole week still ahead, so the
 * agenda places that week's runs once rather than suggesting the next open run on
 * every day it is asked about.
 */
export function lookAheadWeekAsOf(date: string, today: string): string {
  const monday = mondayOf(date);
  return monday === mondayOf(today) ? today : monday;
}

type PlanDayItems = { names: string[] };

/** Each plan day's movement names, in plan order, a mobility drill after the lifts. */
function planDayItems(): Map<number, PlanDayItems> {
  const out = new Map<number, PlanDayItems>();
  for (const day of safe(() => getPlan() as any[], [])) {
    const items = Array.isArray(day?.items) ? (day.items as any[]) : [];
    const lifts: string[] = [];
    const drills: string[] = [];
    for (const item of items) {
      const name = text(item?.exercise);
      if (!name || lifts.includes(name) || drills.includes(name)) continue;
      (String(item?.mode ?? "") === "mobility" ? drills : lifts).push(name);
    }
    out.set(Number(day?.day_number), { names: [...lifts, ...drills] });
  }
  return out;
}

function liftOf(day: PlanWeekDay, items: Map<number, PlanDayItems>, isToday: boolean): PlanLookAheadLift | null {
  const plan = day.plan_day;
  const strength = plan && plan.role === "strength" ? plan : null;
  // A session logged today the plan cannot place still names itself.
  const title = text(strength?.name) || (isToday ? text(day.session?.title) : "");
  if (!title) return null;
  const names = strength ? (items.get(strength.day_number)?.names ?? []) : [];
  return {
    title,
    focus: text(strength?.focus) || null,
    lifts: names.slice(0, LOOK_AHEAD_KEY_LIFTS),
    more: Math.max(0, names.length - LOOK_AHEAD_KEY_LIFTS),
    done: isToday && !!day.session?.finished,
  };
}

/** One calendar day's run as its row says it (exported for its own test). */
export function runOf(day: PlanWeekDay, isToday: boolean): PlanLookAheadRun | null {
  const run = day.run;
  if (!run) return null;
  // A stated run day whose run already landed earlier in the week is covered, not ahead.
  if (run.status === "completed" && run.completion_date && run.completion_date !== day.date) return null;
  // A run the morning's read rested is no run at all (plan-week's progress line drops it
  // the same way): the row is the day's lift, or the calendar's rest day.
  if (run.rested) return null;
  const kind = text(run.kind);
  const done = run.status === "completed";
  // A run done is named by its kind, as Horizon's week names it: the agenda's label is a
  // morning's read that no longer describes it. Today's open run keeps the morning's word.
  const label =
    isToday && !done
      ? text(run.label) || RUN_KIND_LABELS[kind] || "Run"
      : RUN_KIND_LABELS[kind] || text(run.label) || "Run";
  return { kind, label, km: km(run.km), done };
}

function shortWeekday(date: string): string {
  return (WEEKDAY_NAMES[isoDow(date)] ?? "").slice(0, 3);
}

function dayOf(day: PlanWeekDay, today: string, items: Map<number, PlanDayItems>): PlanLookAheadDay | null {
  const date = text(day.date);
  if (!date) return null;
  const isToday = date === today;
  const lift = liftOf(day, items, isToday);
  const run = runOf(day, isToday);
  return { date, weekday: shortWeekday(date), today: isToday, lift, run, rest: !lift && !run, hard: !!day.hard };
}


// A note that only restates its tag ("Lighter week" · "A lighter week") says nothing.
function distinctNote(word: string, note: string): string | null {
  const bare = (s: string) => s.toLowerCase().replace(/^(a|an|the)\s+/, "").replace(/[.\s]+$/, "");
  return note && bare(note) !== bare(word) ? note : null;
}

function weekMarkers(
  weekStart: string,
  from: string,
  isThisWeek: boolean,
  today: string,
  race: ReturnType<typeof raceBuild> | null
): PlanLookAheadMarker[] {
  const out: PlanLookAheadMarker[] = [];
  const weekEnd = addDaysISO(weekStart, 6) ?? weekStart;

  // The race build's rung for this week, its own short words beside it.
  const rung = race?.available ? (race.weeks ?? []).find((w) => w.week_start === weekStart) : null;
  // The week's name is the ONE stage word (stage-words.ts), as a week tag.
  const stage = rungStage(rung);
  if (rung && stage) {
    const word = stage.week_word;
    out.push({ kind: "race_build", word, note: distinctNote(word, text(rung.focus_short)) });
  }

  // An applied recovery week running on any day still ahead in this window, else one
  // announced to land inside it.
  let recovery: PlanLookAheadMarker | null = null;
  for (let d = from; d <= weekEnd; d = addDaysISO(d, 1) ?? weekEnd) {
    if (safe(() => activeRecoveryWeek(d), null)) {
      recovery = { kind: "recovery", word: "Recovery week", note: null };
      break;
    }
    if (d === weekEnd) break;
  }
  if (!recovery) {
    const status = safe(() => recoveryWeekStatus(today), null);
    if (status?.state === "upcoming" && status.effective_date >= from && status.effective_date <= weekEnd) {
      const lands = status.effective_date > weekStart ? `Lands ${WEEKDAY_NAMES[isoDow(status.effective_date)]}` : null;
      recovery = { kind: "recovery", word: "Recovery week", note: lands };
    }
  }
  if (recovery) out.push(recovery);

  // A block deload that will actually run (never one a push athlete is running as a push).
  if (!recovery) {
    const deload = isThisWeek
      ? safe(() => resolvedBlockPhase(today), null) === "deload"
      : safe(() => nextWeekScheduledDeloadRuns(today), false);
    if (deload) out.push({ kind: "deload", word: "Deload week", note: null });
  }
  return out;
}

/** The lifting days in the order they come round, the one up next first (no calendar). */
function ringOrder(week: PlanWeek, items: Map<number, PlanDayItems>, today: string): PlanLookAheadLift[] {
  const lifts = week.days.filter((d) => d.plan_day?.role === "strength");
  const next = lifts.findIndex((d) => d.status === "today" || d.status === "upcoming");
  const start = next >= 0 ? next : 0;
  return [...lifts.slice(start), ...lifts.slice(0, start)]
    .map((d) => {
      const lift = liftOf({ ...d, session: null }, items, false);
      const dayNumber = d.plan_day?.day_number;
      if (!lift || dayNumber == null) return lift;
      return { ...lift, exercises: safe(() => planDayExercisesAhead(dayNumber, today), []) };
    })
    .filter((lift): lift is PlanLookAheadLift => !!lift);
}

export function planLookAhead(date?: string): PlanLookAhead {
  const today = String(date || localDateISO()).slice(0, 10);
  const runUnits = athleteUnits().distance;
  const thisWeek = safe(() => planWeek(today), null);
  const strengthLine = thisWeek?.strength_line ?? safe(() => todayStrengthLine(today), null);
  const items = planDayItems();
  const base = { as_of: today, run_units: runUnits, strength_line: strengthLine };

  const dated = !!thisWeek?.days.some((d) => d.date);
  if (!thisWeek || !dated) {
    const order = thisWeek ? ringOrder(thisWeek, items, today) : [];
    return { ...base, mode: order.length ? "order" : "empty", weeks: [], order };
  }

  const nextMonday = addDaysISO(mondayOf(today), 7) ?? today;
  const nextWeek = safe(() => planWeek(lookAheadWeekAsOf(nextMonday, today)), null);
  const race = safe(() => raceBuild(today), null);

  const weeks: PlanLookAheadWeek[] = [];
  const thisDays = thisWeek.days
    .filter((d) => d.date && d.date >= today)
    .map((d) => dayOf(d, today, items))
    .filter((d): d is PlanLookAheadDay => !!d);
  if (thisDays.length) {
    weeks.push({
      week_start: thisWeek.week_start,
      label: "This week",
      markers: weekMarkers(thisWeek.week_start, today, true, today, race),
      days: thisDays,
    });
  }
  const nextDays = (nextWeek?.days ?? []).map((d) => dayOf(d, today, items)).filter((d): d is PlanLookAheadDay => !!d);
  if (nextWeek && nextDays.length) {
    weeks.push({
      week_start: nextWeek.week_start,
      label: "Next week",
      markers: weekMarkers(nextWeek.week_start, nextWeek.week_start, false, today, race),
      days: nextDays,
    });
  }

  const anything = weeks.some((w) => w.days.some((d) => !d.rest));
  return { ...base, mode: anything ? "calendar" : "empty", weeks: anything ? weeks : [], order: [] };
}
