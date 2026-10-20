// THIS WEEK'S STRENGTH PLACEMENT — which plan day sits on which date of the current week.
//
// One answer for every surface that lays this week's lifting onto the calendar: the Plan
// tab's week strip (domain/training/plan-week.ts) and the race build's leg map
// (race-build.ts). Before this module the strip traded today's swap into the week while
// the race build laid the raw weekday map, so Horizon said "Tuesday: Lower, heavy" under
// a strip saying "Tuesday: Push B · Friday: Lower" (2026-10-20).
//
// The rule, per date of the week:
//   1. A logged session owns its date: the plan day the logged work resolves to
//      (session-day.ts), or no plan day when nothing it lifted is on the plan.
//   2. Today, nothing logged yet, on a mapped lifting weekday: the day today's ONE
//      strength line names (today-strength-line.ts). The map's own day is `mapped`.
//      Only for the real today (asOf === localDateISO()) unless the caller hands the line
//      in: a week read as of a later Monday (Horizon's later rungs) is the map's forecast,
//      and never pays for a day read of a morning that has not happened.
//   3. Every other date: the weekday map's forecast (thisWeekPlanDayMap) — with every
//      DISPLACED day re-placed. A displaced day is one the map laid on a date already
//      lived (today included) whose date something else TOOK — a logged session that was
//      a different day, or today's line naming a different day — and that the week holds
//      nowhere else (logged earlier, today's line, or a repeat of a short pool still
//      ahead: one exposure a week, never a second). It lands on a later, unlogged lifting
//      weekday whose own day the week already holds elsewhere, so taking it drops nothing:
//      first the weekday that held the day which took its date (a straight trade), else
//      the nearest such duplicate. A heavy-lower day never lands on a stated quality or
//      long run day and prefers a slot clear of the day either side of one — but the
//      only slot left beside a key run still takes it (the stack note speaks there).
//      With no slot it does not fit this week, and says so (`unplaced_day_number`) —
//      never silently dropped. A date simply missed (lived, nothing logged) took nothing
//      and displaces nothing; it holds nothing either.
//      The week's map already absorbs a mismatched log from an EARLIER date (it re-phases
//      off it, plan-selection.ts), so in practice the re-placement fires for today: the
//      line's swap before the lift is logged and the logged day after it (2026-10-20:
//      Push B logged on Tuesday's Lower dropped Lower from the week and showed Push B
//      twice).
//
// Changes nothing. Reads only.

import { db } from "../db.js";
import { addDaysISO, mondayOf } from "../lib/dates.js";
import { isoDow } from "./profile.js";
import { isHeavyLowerPlanDay, statedKeyRunDows, thisWeekPlanDayMap, type PlanDayCandidate } from "./plan-selection.js";
import { loggedSessionDay, sessionDayCandidates } from "./session-day.js";
import { localDateISO } from "./shared.js";
import { todayStrengthLineDay, type TodayStrengthLine } from "./today-strength-line.js";

export type WeekSessionRow = {
  id: number;
  date: string;
  plan_day_id: number | null;
  day_number: number | null;
  day_name: string | null;
  finished: boolean;
  /** The plan day this session actually WAS (src/repo/session-day.ts); null when it shows as itself. */
  resolved_day_number: number | null;
  /** The plan day the logged work resolves to, whatever it is called — where a ring-ordered week files it. */
  placed_day_number: number | null;
  /** Its display name — the same answer the session lists and the today line print. */
  title: string;
};

/** Sessions with at least one logged set dated inside [weekStart, weekEnd], resolved to the day they were. */
export function weekSessions(weekStart: string, weekEnd: string): WeekSessionRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.date AS date, s.plan_day_id AS plan_day_id,
                pd.day_number AS day_number, pd.name AS day_name,
                s.finished_at AS finished_at
           FROM sessions s
           LEFT JOIN plan_days pd ON pd.id = s.plan_day_id
          WHERE s.date >= ? AND s.date <= ?
            AND EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id)
          ORDER BY s.date ASC, s.id ASC`
      )
      .all(weekStart, weekEnd) as any[];
    const candidates = sessionDayCandidates();
    return rows.map((r) => {
      const id = Number(r.id);
      const plan_day_id = r.plan_day_id == null ? null : Number(r.plan_day_id);
      // One answer for the cell's plan day AND its title: the strip printed the title,
      // Horizon the plan day, and a redraw that rewrote a row in place made them
      // two different days (src/repo/session-day.ts).
      const logged = loggedSessionDay(id, plan_day_id, candidates);
      return {
        id,
        date: String(r.date),
        plan_day_id,
        day_number: r.day_number == null ? null : Number(r.day_number),
        day_name: r.day_name == null ? null : String(r.day_name),
        finished: !!r.finished_at,
        resolved_day_number: logged.day_number,
        placed_day_number: logged.placed_day_number,
        title: logged.title,
      };
    });
  } catch {
    return [];
  }
}

export function sessionForDate(rows: readonly WeekSessionRow[], date: string): WeekSessionRow | null {
  return rows.find((r) => r.date === date) ?? null;
}

/** The plan day today's strength line names, when it names a strength day. */
export function strengthLineDayNumber(line: TodayStrengthLine | null | undefined): number | null {
  return line && line.role === "strength" && line.day_number != null ? Number(line.day_number) : null;
}

/** A displaced plan day and where it landed. */
export interface PlacementMove {
  /** The plan day the map laid on `from_date`. */
  day_number: number;
  /** The lived date it was laid on, which something else took. */
  from_date: string;
  /** The later date it landed on. */
  to_date: string;
  /** The plan day that took `from_date` (the logged day, or today's line); null for a session that shows as itself. */
  by_day_number: number | null;
}

/** A displaced plan day no later weekday could take. */
export interface UnplacedStrengthDay {
  day_number: number;
  /** The lived date it was laid on. */
  from_date: string;
  /** A slot existed but only on a stated quality / long run day, which a heavy-lower day never takes. */
  key_runs: boolean;
}

/** One date's placement. */
export interface PlacedStrengthDay {
  date: string;
  dow: number;
  /** The plan day on this date (null: no lift, or a logged session that shows as itself). */
  day_number: number | null;
  /**
   * The plan day the date's work FILES under — `day_number`, except on a logged date, where
   * it is the plan day the logged work resolves to even when the session is titled as
   * itself (session-day.ts `placed_day_number`). For leg / stress reads: a squat session
   * named "Legs, short" is still the heavy-lower day it was.
   */
  placed_day_number: number | null;
  /** A logged session's display name, when it shows as itself (day_number null); else null. */
  logged_title: string | null;
  /** The weekday map's forecast for this date (after re-placing displaced days); differs from day_number only on a swapped today. */
  mapped_day_number: number | null;
  /** A logged session owns this date. */
  logged: boolean;
}

export interface WeekStrengthPlacement {
  as_of: string;
  week_start: string;
  /** The weekday map is known (a stated or observed lifting week). False: template order, no calendar. */
  lifting_week: boolean;
  /** The forecast after the trade: dow → plan day. */
  forecast: Map<number, PlanDayCandidate>;
  /** The later date the map's day for TODAY landed on, when today's line or today's log displaced it. */
  moved_to: string | null;
  /** Every displaced day re-placed this week, oldest displacement first. */
  moves: PlacementMove[];
  /** The first displaced day no later weekday could take: it does not fit this week. */
  unplaced_day_number: number | null;
  /** Every displaced day that does not fit this week (the first is `unplaced_day_number`). */
  unplaced_day_numbers: number[];
  /** The same, with why: `key_runs` when a slot existed but only on a quality / long run day. */
  unplaced: UnplacedStrengthDay[];
  /** Monday → Sunday. */
  days: PlacedStrengthDay[];
  on(date: string): PlacedStrengthDay | null;
}

/**
 * This week's strength placement. Callers that already hold the map, the week's sessions
 * or today's strength line pass them in (planWeek does); otherwise each is read here.
 */
export function weekStrengthPlacement(
  date?: string,
  opts: {
    map?: Map<number, PlanDayCandidate>;
    sessions?: readonly WeekSessionRow[];
    strengthLine?: TodayStrengthLine | null;
    /** The stated quality / long run weekdays (0 = Sunday); read from the endurance schedule when omitted. */
    keyRunDows?: readonly number[];
  } = {}
): WeekStrengthPlacement {
  const asOf = String(date || localDateISO()).slice(0, 10);
  const weekStart = mondayOf(asOf);
  const weekEnd = addDaysISO(weekStart, 6) ?? asOf;
  const map = opts.map ?? thisWeekPlanDayMap(asOf).map;
  const sessions = opts.sessions ?? weekSessions(weekStart, weekEnd);
  // Today's line only for the real today (or when the caller hands it in): any other
  // as-of date is the map's forecast.
  const lineDayNumber =
    opts.strengthLine !== undefined
      ? strengthLineDayNumber(opts.strengthLine)
      : asOf === localDateISO()
        ? (() => {
            try {
              return todayStrengthLineDay(asOf);
            } catch {
              return null;
            }
          })()
        : null;

  const forecast = new Map(map);
  const weekDates: string[] = [];
  for (let d: string | null = weekStart; d && d <= weekEnd; d = addDaysISO(d, 1)) weekDates.push(d);
  const inWeek = asOf >= weekStart && asOf <= weekEnd;
  // Today's line names today's day only on an unlogged, mapped lifting weekday (rule 2).
  const todayLine =
    inWeek && lineDayNumber != null && map.has(isoDow(asOf)) && !sessionForDate(sessions, asOf) ? lineDayNumber : null;
  const keyRuns = new Set(
    (
      opts.keyRunDows ??
      (() => {
        try {
          return statedKeyRunDows();
        } catch {
          return [];
        }
      })()
    ).map((dow) => ((Math.trunc(Number(dow)) % 7) + 7) % 7)
  );
  const nearKeyRun = (dow: number): boolean =>
    keyRuns.has(dow) || keyRuns.has((dow + 1) % 7) || keyRuns.has((dow + 6) % 7);
  const isLower = (day: PlanDayCandidate): boolean => {
    try {
      return isHeavyLowerPlanDay(day);
    } catch {
      return false;
    }
  };

  // What the week holds on each date: the log, today's line, else the forecast. A date
  // lived with nothing logged holds nothing — the day it was laid with did not happen.
  const held = (d: string): number | null => {
    const session = sessionForDate(sessions, d);
    if (session) return session.placed_day_number;
    if (d === asOf && todayLine != null) return todayLine;
    if (d < asOf) return null;
    return forecast.get(isoDow(d))?.day_number ?? null;
  };
  const heldElsewhere = (n: number, except: string): boolean =>
    weekDates.some((other) => other !== except && held(other) === n);
  const heldAhead = (n: number, except: string): boolean =>
    weekDates.some(
      (other) => other !== except && other >= asOf && !sessionForDate(sessions, other) && held(other) === n
    );
  const loggedElsewhere = (n: number, except: string): number =>
    sessions.filter(
      (row) => row.date !== except && row.date >= weekStart && row.date <= weekEnd && row.placed_day_number === n
    ).length;
  const laidCount = (n: number): number => [...map.values()].filter((day) => day.day_number === n).length;

  const moves: PlacementMove[] = [];
  const unplaced: UnplacedStrengthDay[] = [];
  for (const from of weekDates) {
    if (from > asOf) break;
    const laid = map.get(isoDow(from));
    if (!laid) continue; // an unstated weekday: an extra session there displaces nothing
    const taken = !!sessionForDate(sessions, from) || (from === asOf && todayLine != null);
    if (!taken) continue;
    const by = held(from);
    if (by === laid.day_number) continue;
    // Still on another date ahead (today's line, a repeat of a short pool): nothing to place.
    if (heldAhead(laid.day_number, from)) continue;
    // Logged elsewhere this week as often as the map lays it: one exposure a week, never a
    // second — unless the pool repeats it, when the repeat the log has not covered moves.
    if (loggedElsewhere(laid.day_number, from) >= laidCount(laid.day_number)) continue;
    const lower = isLower(laid);
    const open = weekDates.filter((d) => {
      if (d <= asOf || sessionForDate(sessions, d)) return false;
      const n = forecast.get(isoDow(d))?.day_number;
      return n != null && n !== laid.day_number && heldElsewhere(n, d);
    });
    const slots = open.filter((d) => !(lower && keyRuns.has(isoDow(d))));
    const rank = (d: string): number[] => [
      lower && nearKeyRun(isoDow(d)) ? 1 : 0,
      by != null && forecast.get(isoDow(d))?.day_number === by ? 0 : 1,
    ];
    const target =
      slots.sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        return ra[0] - rb[0] || ra[1] - rb[1] || a.localeCompare(b);
      })[0] ?? null;
    if (target) {
      forecast.set(isoDow(target), laid);
      moves.push({ day_number: laid.day_number, from_date: from, to_date: target, by_day_number: by });
    } else {
      unplaced.push({ day_number: laid.day_number, from_date: from, key_runs: open.length > 0 });
    }
  }
  const movedTo = moves.find((m) => m.from_date === asOf)?.to_date ?? null;

  const days: PlacedStrengthDay[] = [];
  for (let offset = 0; offset < 7; offset++) {
    const cellDate = addDaysISO(weekStart, offset) ?? weekStart;
    const dow = isoDow(cellDate);
    const session = sessionForDate(sessions, cellDate);
    if (session) {
      days.push({
        date: cellDate,
        dow,
        day_number: session.resolved_day_number,
        placed_day_number: session.placed_day_number ?? session.resolved_day_number,
        logged_title: session.resolved_day_number == null ? session.title : null,
        mapped_day_number: null,
        logged: true,
      });
      continue;
    }
    const mapped = forecast.get(dow)?.day_number ?? null;
    const day_number = cellDate === asOf && todayLine != null ? todayLine : mapped;
    days.push({
      date: cellDate,
      dow,
      day_number,
      placed_day_number: day_number,
      logged_title: null,
      mapped_day_number: mapped,
      logged: false,
    });
  }

  return {
    as_of: asOf,
    week_start: weekStart,
    lifting_week: map.size > 0,
    forecast,
    moved_to: movedTo,
    moves,
    unplaced_day_number: unplaced[0]?.day_number ?? null,
    unplaced_day_numbers: unplaced.map((u) => u.day_number),
    unplaced,
    days,
    on: (d: string) => days.find((day) => day.date === d) ?? null,
  };
}
