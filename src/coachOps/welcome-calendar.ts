// The first week as Today's calendar holds it, in the welcome reveal's shape. Its own
// module so the welcome and its follow-up (welcome-follow-up.ts) both read it without
// importing each other.
import { planWeek } from "../domain/training/plan-week.js";
import { localDateISO } from "../repo/shared.js";
import { log } from "../log.js";

export interface WelcomeWeekDay {
  /** 0 = Sunday; null when no lifting weekdays were stated (the plan's ring order only). */
  dow: number | null;
  /** The plan day lifted on this weekday; null on a run-only day. */
  day_number: number | null;
  /** The lift's name, or on a run-only day the run's ("Long run"). */
  name: string;
  /** The run the calendar places on this weekday, when there is one (the reveal only). */
  run?: string;
}

/**
 * The week the reveal shows once it is on the plan: the WHOLE week as Today's calendar
 * holds it (planWeek — the strip's own source), lifts and the run engine's runs on the
 * weekdays they actually land, so the reveal can never show a run day the calendar won't.
 * Null when the week has no weekdays to stand on (no lifting or run days known): the
 * caller's lift-only, plan-order rows are then the honest answer.
 */
export function welcomeCalendarWeek(today = localDateISO()): WelcomeWeekDay[] | null {
  try {
    const week = planWeek(today);
    const rows: WelcomeWeekDay[] = [];
    for (const day of week.days) {
      if (day.dow == null) return null;
      const lift = day.plan_day && day.plan_day.day_type !== "rest" ? day.plan_day : null;
      const run = day.run && !day.run.rested ? String(day.run.label || "").trim() : "";
      if (!lift && !run) continue;
      rows.push({
        dow: day.dow,
        day_number: lift ? lift.day_number : null,
        name: (lift ? String(lift.name || `Day ${lift.day_number}`) : run).trim().slice(0, 60),
        ...(run ? { run: run.slice(0, 60) } : {}),
      });
    }
    return rows.length ? rows : null;
  } catch (err) {
    log.debug("[welcome] the calendar week could not be read for the reveal", { error: err });
    return null;
  }
}
