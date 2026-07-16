import { db } from "../db.js";
import { addDaysISO, localDateISO } from "./shared.js";

export interface CompletedIntakeDay {
  date: string;
  kcal: number;
  meals: string[];
  credible: boolean;
}

export interface CompletedIntakeWindow {
  since: string;
  through: string;
  calendar_days: number;
  days: CompletedIntakeDay[];
  credible_days: number;
  partial_days: number;
  missing_days: number;
  evidence_keys: string[];
}

function normalizedWindowDays(value: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(3, Math.min(90, Math.trunc(n))) : 14;
}

function credibleDay(total: number, meals: string[]): boolean {
  const snackOnly = meals.length > 0 && meals.every((meal) => /^(snack|treat|drink|beverage)$/.test(meal));
  const primarySlots = new Set(meals.filter((meal) => /^(breakfast|brunch|lunch|dinner|supper)$/.test(meal))).size;
  const nonSnackEntries = meals.filter((meal) => !/^(snack|treat|drink|beverage)$/.test(meal)).length;
  const genericDayTotal = meals.some((meal) => meal === "meal") && total >= 1_000;
  return !snackOnly && (primarySlots >= 2 || nonSnackEntries >= 2 || genericDayTotal);
}

// One shared credibility read for expenditure and the protective fuel loop.
// Only CLOSED local calendar days are eligible. Missing days stay absent and are
// reported as missing; they are never converted into zero intake.
function calendarDays(since: string, through: string): number {
  const start = Date.parse(`${since}T00:00:00Z`);
  const end = Date.parse(`${through}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? Math.round((end - start) / 86_400_000) + 1
    : 0;
}

// Arbitrary CLOSED-date evidence for both the live brain and outcome evaluators.
// `closedThrough` prevents the current, still-incomplete local day from becoming
// a completed exposure. Snack-only/partial days stay visible but not credible.
export function completedIntakeRange(
  since: string,
  through: string,
  closedThrough = addDaysISO(localDateISO(), -1) ?? localDateISO()
): CompletedIntakeWindow {
  const effectiveThrough = through < closedThrough ? through : closedThrough;
  const days = calendarDays(since, effectiveThrough);
  if (!days) {
    return {
      since,
      through: effectiveThrough,
      calendar_days: 0,
      days: [],
      credible_days: 0,
      partial_days: 0,
      missing_days: 0,
      evidence_keys: [],
    };
  }
  const rows = db
    .prepare(
      `SELECT id, COALESCE(date, substr(created_at, 1, 10)) AS day, meal, parsed_json
         FROM food_notes
        WHERE COALESCE(date, substr(created_at, 1, 10)) >= ?
          AND COALESCE(date, substr(created_at, 1, 10)) <= ?`,
    )
    .all(since, effectiveThrough) as any[];
  const byDay = new Map<string, { kcal: number; meals: string[] }>();
  for (const row of rows) {
    let parsed: any = null;
    try {
      parsed = row.parsed_json ? JSON.parse(String(row.parsed_json)) : null;
    } catch {
      parsed = null;
    }
    const kcal = Number(parsed?.kcal);
    const date = String(row.day ?? "").slice(0, 10);
    if (!date || !Number.isFinite(kcal) || kcal <= 0) continue;
    const current = byDay.get(date) ?? { kcal: 0, meals: [] };
    current.kcal += kcal;
    current.meals.push(String(row.meal || "meal").trim().toLowerCase());
    byDay.set(date, current);
  }
  const observed = [...byDay.entries()]
    .map(([date, value]) => ({
      date,
      kcal: Math.round(value.kcal),
      meals: value.meals,
      credible: credibleDay(value.kcal, value.meals),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const credible = observed.filter((day) => day.credible).length;
  return {
    since,
    through: effectiveThrough,
    calendar_days: days,
    days: observed,
    credible_days: credible,
    partial_days: observed.length - credible,
    missing_days: Math.max(0, days - observed.length),
    evidence_keys: rows.length
      ? [`food_notes:${since}..${effectiveThrough}:n=${rows.length}:days=${observed.length}:credible=${credible}`]
      : [],
  };
}

export function completedIntakeWindow(windowDays = 14, referenceDate = localDateISO()): CompletedIntakeWindow {
  const days = normalizedWindowDays(windowDays);
  const through = addDaysISO(referenceDate, -1) ?? referenceDate;
  const since = addDaysISO(through, -(days - 1)) ?? through;
  return completedIntakeRange(since, through, through);
}
