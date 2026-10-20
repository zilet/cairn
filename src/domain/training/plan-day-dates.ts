// WHICH DATES CARRY A PLAN DAY — the link from a change to a plan day's prescription to
// the calendar days it touches.
//
// A coach change edits a plan day by NUMBER ("day 2"), and the athlete lives dates. Which
// date a number lands on is the weekday map's answer (strengthPlanDayOn over
// thisWeekPlanDayMap: the log-anchored ring laid onto the lifting weekdays), never a
// Mon=Day 1 guess — the 2026-10-19 incident was exactly that guess: a chat replan
// edited day 2 believing it was Tuesday, and day 2 was Friday's session. The ring is
// never re-derived here: this week is read as of today and a later week as of its own
// Monday, the rule planWeek's strip, the look-ahead and the day page share
// (lookAheadWeekAsOf), so a date here carries the plan day its row shows.
//
// Pure reads; changes nothing.
import type { BrainDecision } from "../../brain/decision-contract.js";
import { addDaysISO, mondayOf } from "../../lib/dates.js";
import { strengthPlanDayOn, thisWeekPlanDayMap } from "../../repo/plan-selection.js";
import { getProposal } from "../../repo/proposals.js";
import { copyDeep, requestMemo } from "../../repo/request-memo.js";
import { localDateISO, localDayOfStamp } from "../../repo/shared.js";
import { weekStrengthPlacement } from "../../repo/week-strength-placement.js";

/** A date and the strength plan day it carries. */
export interface PlanDayDate {
  date: string;
  day_number: number;
}

// Never walk further than this, whatever `through` asks (a countdown is three weeks).
const MAX_DAYS = 42;

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** The last day the day page forecasts (dayDetailHorizon): the end of next week. */
export function planDayDatesHorizon(today: string): string {
  return addDaysISO(mondayOf(today), 13) ?? today;
}

/**
 * Every date from `today` through `through` (default: the end of next week) that carries
 * a strength plan day, with that day's number. Run and rest weekdays are left out.
 */
export function planDayDatesAhead(today = localDateISO(), through?: string): PlanDayDate[] {
  const start = String(today).slice(0, 10);
  const end = String(through || planDayDatesHorizon(start)).slice(0, 10);
  return requestMemo(`plan_day_dates:${start}:${end}`, () => planDayDatesRead(start, end), copyDeep);
}

function planDayDatesRead(today: string, end: string): PlanDayDate[] {
  const out: PlanDayDate[] = [];
  const weeks = new Map<string, ReturnType<typeof thisWeekPlanDayMap> | null>();
  const thisMonday = mondayOf(today);
  // THIS week as placed — the strip's own answer (week-strength-placement.ts): today
  // names the strength line's day and a swapped day trades into its later weekday, so a
  // change to Lower lands on the Friday Lower now sits on, never the Tuesday it left.
  const placement = safe(() => weekStrengthPlacement(today), null);
  let date: string | null = today;
  for (let i = 0; date && date <= end && i < MAX_DAYS; i++) {
    const day: string = date;
    const monday = mondayOf(day);
    if (monday === thisMonday && placement?.lifting_week) {
      const n = Number(placement.on(day)?.day_number);
      if (Number.isInteger(n) && n > 0) out.push({ date: day, day_number: n });
      date = addDaysISO(day, 1);
      continue;
    }
    // lookAheadWeekAsOf: this week as of today, a later week as of its Monday.
    const asOf = monday === thisMonday ? today : monday;
    if (!weeks.has(asOf)) weeks.set(asOf, safe(() => thisWeekPlanDayMap(asOf), null));
    const weekMap = weeks.get(asOf) ?? undefined;
    const plan = safe(() => strengthPlanDayOn(day, weekMap ? { weekMap } : {}), null);
    const n = Number(plan?.day_number);
    if (Number.isInteger(n) && n > 0) out.push({ date: day, day_number: n });
    date = addDaysISO(day, 1);
  }
  return out;
}

function dayNumbersIn(list: unknown, into: Set<number>): void {
  for (const item of Array.isArray(list) ? list : []) {
    const n = Number((item as { day_number?: unknown } | null)?.day_number);
    if (Number.isInteger(n) && n > 0) into.add(n);
  }
}

/**
 * The plan days a decision changes, by number. A landed change carries its own record
 * (`action.changes[]` / `action.swaps[]`); an announced one has not written it yet, so
 * its draft (the plan proposal behind it) says which days it will touch. [] for a change
 * that is not about plan days (a nutrition target, a recovery-week overlay, a run plan).
 */
export function decisionPlanDayNumbers(decision: BrainDecision | null | undefined): number[] {
  if (!decision) return [];
  const action = (decision.action ?? {}) as Record<string, unknown>;
  const days = new Set<number>();
  dayNumbersIn(action.changes, days);
  dayNumbersIn(action.swaps, days);
  if (!days.size) {
    const proposalId =
      Number(action.proposal_id) ||
      (decision.source_ref_type === "plan_proposal" ? Number(decision.source_ref_key) : Number.NaN);
    if (proposalId > 0) {
      const proposal = safe(() => getProposal(proposalId) as { parsed?: { changes?: unknown } | null } | null, null);
      dayNumbersIn(proposal?.parsed?.changes, days);
    }
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * The Monday of the week a WHOLE-WEEK layout was made for, or null for any other change.
 *
 * A restructure (`training_structure` carrying the plan's `days`: every day laid out
 * again, its Undo "Restore your previous week") is about ONE week — the week it was
 * written into ("the rest of the week of October 12"). It adapted that week's days, and
 * its Undo rolls that week back; on a day of a later week it is history, not this day's
 * adaptation (2026-10-20: two rewrites from the Thursday before still sat on the next
 * week's Friday with a live "Restore your previous week"). The week is the one the
 * change took effect in; one landing on a Sunday is for the week it opens.
 *
 * An ANNOUNCED layout has no dates until it lands: decisionAffectedDates places it only
 * from its `effective_date`, so until then the applied layout it will replace is still the
 * week's (coachChangesRead ranks an applied layout above a newer announced one).
 */
export function weekLayoutWeekOf(decision: BrainDecision | null | undefined): string | null {
  if (!decision || decision.kind !== "training_structure") return null;
  const action = (decision.action ?? {}) as { days?: unknown };
  if (!Array.isArray(action.days) || !action.days.length) return null;
  const context = (decision.context ?? {}) as { proposal_as_of_date?: unknown };
  // `effective_date` and the proposal's as-of date are LOCAL dates, read as written;
  // `applied_at` / `created_at` are UTC instants, read as the local day they fell on
  // (localDayOfStamp) — a slice would file an evening rewrite under tomorrow's week.
  const localDate = (value: unknown): string | null => {
    const day = String(value ?? "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  };
  const made =
    localDate(decision.effective_date) ??
    localDayOfStamp(decision.applied_at) ??
    localDate(context.proposal_as_of_date) ??
    localDayOfStamp(decision.created_at) ??
    "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(made)) return null;
  const monday = mondayOf(made);
  return monday === made || addDaysISO(monday, 6) !== made ? monday : (addDaysISO(made, 1) ?? monday);
}

/**
 * The dates from `today` through `through` (default: the end of next week) a decision
 * adapted: the dates carrying a plan day it changed. Only a change in effect (`applied`)
 * or announced to land (`announced`, and then only from the day it lands) touches a day;
 * a put-back, held or superseded change touches none. A whole-week layout touches only
 * the days of the week it was made for (weekLayoutWeekOf).
 */
export function decisionAffectedDates(
  decision: BrainDecision | null | undefined,
  today = localDateISO(),
  through?: string
): string[] {
  if (!decision || (decision.status !== "applied" && decision.status !== "announced")) return [];
  const days = new Set(decisionPlanDayNumbers(decision));
  if (!days.size) return [];
  const lands = decision.status === "announced" ? String(decision.effective_date ?? "").slice(0, 10) : "";
  const from = lands && lands > today ? lands : today;
  const week = weekLayoutWeekOf(decision);
  const weekEnd = week ? (addDaysISO(week, 6) ?? week) : null;
  return planDayDatesAhead(today, through)
    .filter((row) => row.date >= from && days.has(row.day_number))
    .filter((row) => !week || !weekEnd || (row.date >= week && row.date <= weekEnd))
    .map((row) => row.date);
}

/**
 * The feed row's link (`open_day`): the first date a decision adapted, as a spread-in
 * field — `{}` when it touched no dated day, so a row about something else is unchanged.
 */
export function decisionOpenDay(decision: BrainDecision | null | undefined, today: string): { open_day?: string } {
  const first = safe(() => decisionAffectedDates(decision, today)[0], undefined);
  return first ? { open_day: first } : {};
}
