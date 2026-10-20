// THE COACH'S CHANGES, ON THE DAYS THEY ADAPTED.
//
// A change landed on a plan day ("day 2") is invisible on the day it actually touches
// unless something says so there: on 2026-10-19 a chat replan moved Friday's session and
// Friday showed nothing. This attaches each coach change in the Changes feed to the
// dates that carry the plan day it changed (plan-day-dates.ts — the weekday map, never a
// Mon=Day 1 guess), so the day page and the race countdown can say "the coach adapted
// this day" with the feed's own title, why and Undo.
//
// A read over reads: the rows ARE brainChangesRead()'s (the athlete register, the
// server-owned Undo), only placed on dates. Changes nothing. No score, no gate.
import type { DayDetailChange } from "../../contracts/day-changes.js";
import type { BrainDecision } from "../../brain/decision-contract.js";
import { addDaysISO, daysBetweenISO, mondayOf } from "../../lib/dates.js";
import { getBrainDecision } from "../../repo/brain-decisions.js";
import { activePlanAdaptations } from "../../repo/plan-adaptations.js";
import { localDateISO, localDayOfStamp, parseDbTime } from "../../repo/shared.js";
import { brainChangesRead } from "../brain/changes-feed.js";
import { decisionAffectedDates, planDayDatesHorizon, weekLayoutWeekOf } from "./plan-day-dates.js";

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** An un-scoped change stays "this day's adaptation" for a week after it landed. */
const UNSCOPED_DAYS = 7;

function changeEntries(decision: BrainDecision | null | undefined): Record<string, any>[] {
  const list = (decision?.action as { changes?: unknown } | null | undefined)?.changes;
  return Array.isArray(list) ? list.filter((c) => c && typeof c === "object") : [];
}

/** Does the decision carry an end date (the race-scoped taper): on the action or on a change? */
function isScoped(decision: BrainDecision | null | undefined): boolean {
  const action = (decision?.action ?? {}) as { plan_adaptation?: unknown };
  return !!action.plan_adaptation || changeEntries(decision).some((c) => typeof c.until === "string" && c.until);
}

/**
 * Whether a change is still in effect on `date`. A scoped adaptation holds through its
 * end date and only while its row is active (an Undo or a restore ends it); an un-scoped
 * one reads as this day's adaptation for a week from when it landed, and never once a
 * later decision superseded it. An announced change is placed from the day it lands.
 */
function inEffectOn(
  decision: BrainDecision | null,
  date: string,
  today: string,
  adaptedUntil: Map<number, string>
): boolean {
  if (!decision || decision.superseded_by != null) return false;
  if (isScoped(decision)) {
    const until = adaptedUntil.get(Number(decision.id));
    return !!until && date <= until;
  }
  if (decision.status !== "applied") return true;
  const landed = landedDay(decision);
  if (!landed) return true;
  const floor = addDaysISO(today, -UNSCOPED_DAYS);
  return !floor || landed >= floor;
}

/**
 * Does the decision lower the leg work of plan day `dayNumber` — a removed lift, fewer
 * sets, or a lighter target than it carried before? A progression that RAISED the squat
 * adapted the day without lightening it.
 */
export function decisionLowersDay(decision: BrainDecision | null | undefined, dayNumber: number | null): boolean {
  if (dayNumber == null) return false;
  for (const c of changeEntries(decision)) {
    if (Number(c.day_number) !== dayNumber) continue;
    const before = (c.before ?? {}) as Record<string, unknown>;
    if (c.change === "removed" || c.kind === "removed" || c.sets === 0) return true;
    const lower = (now: unknown, was: unknown): boolean =>
      typeof now === "number" && typeof was === "number" && Number.isFinite(now) && Number.isFinite(was) && now < was;
    if (lower(c.sets, before.sets) || lower(c.target_weight, before.target_weight)) return true;
  }
  return false;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The LOCAL day a decision landed: `applied_at` / `created_at` are UTC instants
 * (datetime('now')), so slicing them dates an evening change a day early or late west or
 * east of Greenwich — read through localDayOfStamp (brain-decisions.ts). `effective_date`
 * is already a local date and is read as written.
 */
function landedDay(decision: BrainDecision): string | null {
  const effective = String(decision.effective_date ?? "").slice(0, 10);
  return (
    localDayOfStamp(decision.applied_at) ??
    (ISO_DAY.test(effective) ? effective : null) ??
    localDayOfStamp(decision.created_at)
  );
}

/**
 * Which of two layouts of one week stands, for ordering them (the greater key wins): an
 * APPLIED layout outranks an announced one — an announced layout touches no date before
 * it lands (decisionAffectedDates), so letting the newer announcement win would hide the
 * applied layout, Undo and all, through the days it is still in effect — then the newest.
 */
function landedKey(decision: BrainDecision): string {
  const applied = decision.status === "applied" ? "1" : "0";
  const at = parseInstant(decision.applied_at ?? decision.effective_date ?? decision.created_at);
  return `${applied}#${String(at).padStart(16, "0")}#${String(decision.id ?? 0).padStart(12, "0")}`;
}

function parseInstant(value: unknown): number {
  const raw = String(value ?? "").trim();
  const t = ISO_DAY.test(raw) ? Date.parse(`${raw}T00:00:00Z`) : (parseDbTime(raw)?.getTime() ?? 0);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * How far back the feed is read: its default fortnight, widened to the countdown's three
 * weeks and further still to the oldest race-scoped adaptation that is still active — a
 * taper applied a month before the race is in effect until race day, and must not fall
 * off the day pages because the feed's own window moved past the day it landed.
 */
const MIN_WINDOW_DAYS = 21;
const MAX_WINDOW_DAYS = 90;

function feedWindowDays(today: string, adaptationIds: Iterable<number>): number {
  let days = MIN_WINDOW_DAYS;
  for (const id of adaptationIds) {
    const decision = safe(() => getBrainDecision(id), null);
    const landed = decision ? landedDay(decision) : null;
    const back = landed ? daysBetweenISO(today, landed) : null;
    if (back != null && back + 1 > days) days = back + 1;
  }
  return Math.min(MAX_WINDOW_DAYS, days);
}

export interface CoachChangesRead {
  /** Per date: the changes that adapted that day's own prescription. */
  days: Map<string, DayDetailChange[]>;
  /**
   * Per week (its Monday): the whole-week layouts in effect for it (weekLayoutWeekOf) —
   * one only: the newest applied one, since a later rewrite of the same week replaced it
   * (an announced one only while none is applied: it has no dates until it lands). A week's
   * change is said ONCE, for the week, never repeated on each of its days.
   */
  weeks: Map<string, DayDetailChange[]>;
}

/**
 * Every coach change from `today` through `through` (default: the end of next week), in
 * the feed's words: day-level changes on the dates they adapted (newest first per date),
 * whole-week layouts on the week they were made for — and on no other week, so a later
 * week's day never offers an Undo that would roll back an earlier week.
 */
export function coachChangesRead(today = localDateISO(), through?: string): CoachChangesRead {
  const days = new Map<string, DayDetailChange[]>();
  const weeks = new Map<string, DayDetailChange[]>();
  const adaptedUntil = new Map<number, string>();
  for (const a of safe(() => activePlanAdaptations(today), [])) {
    if (a.decision_id == null) continue;
    const prior = adaptedUntil.get(Number(a.decision_id));
    if (!prior || a.until > prior) adaptedUntil.set(Number(a.decision_id), a.until);
  }
  const read = safe(
    () => brainChangesRead({ asOf: today, days: feedWindowDays(today, adaptedUntil.keys()), limit: 200 }),
    null
  );
  const rows: { row: any; decision: BrainDecision | null }[] = [];
  for (const group of read?.days ?? []) {
    for (const row of group.changes ?? []) {
      if (row.state !== "applied" && row.state !== "announced") continue;
      rows.push({ row, decision: safe(() => getBrainDecision(Number(row.id)), null) });
    }
  }
  // The newest layout per week: an earlier rewrite of the same week is replaced by it,
  // whether or not the ledger stamped `superseded_by`. An announced layout has no dates
  // until it lands, so an applied one outranks it until then (landedKey).
  const newestLayout = new Map<string, BrainDecision>();
  for (const { decision } of rows) {
    const week = weekLayoutWeekOf(decision);
    if (!week || !decision || decision.superseded_by != null) continue;
    const held = newestLayout.get(week);
    if (!held || landedKey(decision) > landedKey(held)) newestLayout.set(week, decision);
  }
  for (const { row, decision } of rows) {
    const week = weekLayoutWeekOf(decision);
    if (week && newestLayout.get(week)?.id !== decision?.id) continue;
    const dates = safe(() => decisionAffectedDates(decision, today, through), [] as string[]);
    if (!dates.length) continue;
    const change: DayDetailChange = {
      decision_id: Number(row.id),
      title: row.title,
      why: row.why ?? null,
      state: row.state,
      status_line: row.status_line,
      reversible: !!decision?.reversible,
      undo: { available: row.undo?.available === true, label: row.undo?.label ?? null },
    };
    if (week) {
      // decisionAffectedDates already kept only the week's own days: said once, on the week.
      if (!dates.some((date) => inEffectOn(decision, date, today, adaptedUntil))) continue;
      const list = weeks.get(week) ?? [];
      if (!list.some((c) => c.decision_id === change.decision_id)) list.push({ ...change });
      weeks.set(week, list);
      continue;
    }
    for (const date of dates) {
      if (!inEffectOn(decision, date, today, adaptedUntil)) continue;
      const list = days.get(date) ?? [];
      if (!list.some((c) => c.decision_id === change.decision_id)) list.push({ ...change });
      days.set(date, list);
    }
  }
  return { days, weeks };
}

/** Day-level coach changes per date (coachChangesRead's `days`): never a whole-week layout. */
export function dayChangesByDate(today = localDateISO(), through?: string): Map<string, DayDetailChange[]> {
  return coachChangesRead(today, through).days;
}

/**
 * The coach changes on one date — [] for a day already lived or past the end of next
 * week. The day page is one day of one week, so a whole-week layout made for THIS day's
 * week is said there too (after the day's own changes); one made for another week never.
 */
export function dayChangesOn(date: string, today = localDateISO()): DayDetailChange[] {
  const day = String(date || "").slice(0, 10);
  if (!day || day < today || day > planDayDatesHorizon(today)) return [];
  const read = coachChangesRead(today);
  return [...(read.days.get(day) ?? []), ...(read.weeks.get(mondayOf(day)) ?? [])];
}
