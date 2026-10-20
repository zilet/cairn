// A plan day's race-build leg trim on a date — READ from the stress budget, never
// re-derived. The words live in plan-day-focus.ts (legTrimFocus / legTrimNote); this is
// the one read every surface that prints a dated plan day's focus asks:
//   - today: the morning envelope's own stress-budget code (daily-decision.ts) — the
//     only place the key-run eve is decided, since it depends on that morning's weekly
//     lower guarantee and safety floor;
//   - any date (today included, before the envelope exists): the calendar half of the
//     budget, stressBudgetCalendarTrim — taper week's lighter legs, race week's heavy
//     legs sitting out — applied to the plan day's own items.
// Null when nothing trims the day. Never throws: an unreadable input is no trim.
import { getLatestDailySessionDecision } from "./daily-decision.js";
import { isLegTrim, type LegTrim } from "./plan-day-focus.js";
import { getPlan } from "./plan.js";
import { localDateISO } from "./shared.js";
import { stressBudgetCalendarTrim } from "./stress-budget.js";
import { getTrainingIntent } from "./training-intent.js";

/** The morning envelope's leg trim for `date` (the day it was decided for), or null. */
export function envelopeLegTrim(date: string): LegTrim | null {
  try {
    const code = getLatestDailySessionDecision(String(date).slice(0, 10))?.stress?.code ?? null;
    return isLegTrim(code) ? code : null;
  } catch {
    return null;
  }
}

function planItemsOf(dayNumber: number): any[] {
  try {
    const day = (getPlan() as any[]).find((d) => Number(d?.day_number) === Number(dayNumber));
    return Array.isArray(day?.items) ? day.items : [];
  } catch {
    return [];
  }
}

/** The calendar half of the trim (taper / race week) for a plan day's items on `date`, or null. */
export function calendarLegTrim(date: string, planItems: readonly any[]): LegTrim | null {
  try {
    const role = getTrainingIntent().endurance_role;
    const items = (Array.isArray(planItems) ? planItems : []).filter((it) => it && String(it.kind ?? "") !== "cardio");
    if (!items.length) return null;
    return stressBudgetCalendarTrim(String(date).slice(0, 10), items, role)?.code ?? null;
  } catch {
    return null;
  }
}

/**
 * The leg trim on plan day `dayNumber` dated `date`: today's envelope first (it is the
 * morning's decision, the eve included), then the calendar trim. `planItems` when the
 * caller already holds the day's items.
 */
export function planDayLegTrimOn(
  date: string,
  dayNumber: number | null | undefined,
  opts: { today?: string; planItems?: readonly any[] } = {}
): LegTrim | null {
  const d = String(date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const today = String(opts.today || localDateISO()).slice(0, 10);
  if (d < today) return null;
  if (d === today) {
    const morning = envelopeLegTrim(d);
    if (morning) return morning;
  }
  if (dayNumber == null && !opts.planItems) return null;
  const items = opts.planItems ?? planItemsOf(Number(dayNumber));
  return calendarLegTrim(d, items);
}
