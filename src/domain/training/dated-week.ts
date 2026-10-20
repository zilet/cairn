// THE DATED WEEK — which session lands on which DATE, today through the end of next
// week, in the compact shape a prompt can carry and a server check can read.
//
// The chat agent used to see the plan as a TEMPLATE (day_number 1..N) with no weekday
// map at all, so it guessed: it read "Day 2 Lower" as Tuesday, edited day 2 to spare a
// Tuesday that was actually Push B, and the edit landed on Friday's Lower instead
// (2026-10-19). Placement ADAPTS to the log — the ring continues from the last logged
// session — so a weekday is never a day_number, and nothing but the server's own week
// can say which is which.
//
// So this is NOT a new derivation. It is a projection of `planWeek` — the Plan strip's
// own week, the same reader the look-ahead and the day preview use — this week as of
// today and next week as of its own Monday (`lookAheadWeekAsOf`, the look-ahead's
// rule), with each run read through the look-ahead's own `runOf`. A lift's heavy-lower
// mark is the plan-day groups read planWeek's `hard` flag uses; a trip is
// `tripCoversDay` (the travel window every trip-confounder read shares).
//
// Consumers: the chat prompt's DATA.dated_week, the chat plan_update's `date` →
// day_number resolution (chatTurns.ts), and the schedule-claim check in
// chatGrounding.ts. Changes nothing.
import { addDaysISO, mondayOf } from "../../lib/dates.js";
import { localDateISO } from "../../repo/shared.js";
import { planDayStrengthGroups } from "../../repo/training-read.js";
import { tripCoversDay } from "../../repo/underfueling.js";
import { lookAheadWeekAsOf, runOf } from "./plan-look-ahead.js";
import { planWeek, type PlanWeekDay } from "./plan-week.js";

export type DatedWeekStatus = "done" | "today" | "upcoming";

/** One calendar day. Compact keys on purpose: this rides a chat prompt every turn. */
export interface DatedWeekDay {
  /** YYYY-MM-DD */
  date: string;
  /** Short weekday ("Tue"). */
  wd: string;
  st: DatedWeekStatus;
  /** The strength session on this date: the plan day_number and its display name. */
  lift?: { day: number; name: string; heavy_lower?: true };
  /** The run on this date (km, or null when the engine names none). */
  run?: { kind: string; km: number | null };
  /** A trip context event covers this date. */
  trip?: true;
}

export interface DatedWeek {
  from: string;
  to: string;
  days: DatedWeekDay[];
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function dayOf(cell: PlanWeekDay, today: string, heavyLower: ReadonlySet<number>): DatedWeekDay | null {
  const date = String(cell.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) return null;
  const isToday = date === today;
  const st: DatedWeekStatus = date > today ? "upcoming" : cell.status === "done" ? "done" : "today";
  const out: DatedWeekDay = { date, wd: String(cell.weekday ?? ""), st };
  const plan = cell.plan_day;
  if (plan && plan.role === "strength") {
    // A session logged today names what was done (the look-ahead's rule).
    const name = (isToday ? String(cell.session?.title ?? "").trim() : "") || plan.name;
    out.lift = {
      day: plan.day_number,
      name,
      ...(heavyLower.has(plan.day_number) ? { heavy_lower: true as const } : {}),
    };
  }
  const run = runOf(cell, isToday);
  if (run) out.run = { kind: run.kind, km: run.km };
  if (safe(() => tripCoversDay(date), false)) out.trip = true;
  return out;
}

/**
 * Today through next Sunday, one row per date. Null when the athlete has no calendar
 * week (no lifting weekdays known and no running week): the plan is then a ring in
 * template order, and no date can be claimed for any day of it.
 */
export function datedWeek(today: string = localDateISO()): DatedWeek | null {
  const asOf = String(today).slice(0, 10);
  const thisWeek = safe(() => planWeek(asOf), null);
  if (!thisWeek || !thisWeek.days.some((d) => d.date)) return null;
  const nextMonday = addDaysISO(mondayOf(asOf), 7) ?? asOf;
  const nextWeek = safe(() => planWeek(lookAheadWeekAsOf(nextMonday, asOf)), null);
  const heavyLower = new Set<number>();
  for (const g of safe(() => planDayStrengthGroups(), [])) if (g.heavy_lower) heavyLower.add(g.day_number);
  const days = [...thisWeek.days, ...(nextWeek?.days ?? [])]
    .map((cell) => dayOf(cell, asOf, heavyLower))
    .filter((d): d is DatedWeekDay => !!d);
  if (!days.length) return null;
  return { from: days[0].date, to: days[days.length - 1].date, days };
}

/** The dated row for one date, or null when the date is outside the week's window. */
export function datedWeekDay(week: DatedWeek | null | undefined, date: string): DatedWeekDay | null {
  return week?.days.find((d) => d.date === date) ?? null;
}
