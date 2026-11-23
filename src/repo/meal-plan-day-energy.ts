// A weekly meal plan that follows each DAY's energy number (repo/day-energy.ts).
//
// The accepted calorie target is the week's AVERAGE, and `daily_kcal` stays that number on
// every plan: the headline, the autonomy diff, the adherence evaluator's window and every
// other weekly reader keep reading it. What this module adds is the per-day split, and it
// is SERVER-OWNED end to end:
//
//   - `computeMealPlanDayEnergy` (meal-plan-day-energy-compute.ts) asks `dayEnergyTarget`
//     for each date of the plan's week, so a plan day carries the SAME number Intake shows
//     for that date (`shapeMealPlanDayEnergy`: in the same fifties; only the day floor, or
//     a window straddling two weeks that do not balance, moves a day off it, the later
//     week's days first), and keeps only the days that moved. A week that does not move (nothing planned, a week the read cannot shape)
//     yields nothing, and the plan is planned and checked flat, exactly as before.
//   - The result is stored once, at the drafting op, as `parsed.day_energy` — never taken
//     from model output (the drafting op strips any `day_energy` the model wrote and
//     replaces it with its own), and never recomputed afterwards, so a plan keeps the week
//     it was drafted for.
//   - `projectMealPlanDayEnergy` re-derives each plan day's `date` / `target_kcal` /
//     `target_why` from that stored record on every write, overwriting whatever a client
//     or a model put on the day, so an edit or a swap can neither drop nor invent a day's
//     number.
//
// The plan's days carry weekday LABELS ("Mon", "Tuesday"), never dates. A label maps to
// the first date with that weekday in the seven food days that start at the plan's
// natural boundary — the day after it was drafted, where autonomy lands a new plan
// (autonomy-service.ts nextMealBoundary) — which is also the day the coach reads
// `mealPlanForCoach` pick for that weekday during the plan's first week. A label that
// names no weekday gets no date and no number (it plans at the average). Readers only use
// a day's number for that exact date: once the plan's first week has passed, every day
// reads `daily_kcal` again, because the split belonged to that week's training.
//
// Everything here is PURE (no database, no clock) so the persistence gate, the verify
// pre-check and the readers share one mapping.
import { ABSOLUTE_KCAL_FLOOR } from "./kcal-floor.js";
import { DAY_SHIFT_STEP_KCAL, inSteps } from "./day-energy-step.js";
import { addDaysISO } from "../lib/dates.js";

export const MEAL_PLAN_DAY_ENERGY_VERSION = 1;

/** One day of the plan's week whose number differs from the week's average. */
export interface MealPlanEnergyDay {
  date: string;
  /** "mon" … "sun". */
  weekday: string;
  kcal: number;
  shift_kcal: number;
  /** Plain words for what the day carries ("the long run", "a lighter day"). */
  why: string;
}

export interface MealPlanDayEnergy {
  version: typeof MEAL_PLAN_DAY_ENERGY_VERSION;
  /** The accepted weekly average the split was made from. */
  average_kcal: number;
  /** The lowest number any day may carry (absolute floor, raised by a running cut's floor). */
  floor_kcal: number;
  /** First of the seven food days the plan's weekday labels map onto. */
  from: string;
  /** Only the days that moved; every other day sits at the average. */
  days: MealPlanEnergyDay[];
}

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const ISO = /^\d{4}-\d{2}-\d{2}$/;


/** "mon" … "sun" for a weekday label, or null when the label names no weekday. */
export function weekdayKeyOfLabel(label: unknown): string | null {
  const text = String(label ?? "")
    .trim()
    .toLowerCase();
  return WEEKDAY_KEYS.find((key) => text.startsWith(key)) ?? null;
}

export function weekdayKeyOfDate(iso: string): string | null {
  if (!ISO.test(String(iso))) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? WEEKDAY_KEYS[new Date(t).getUTCDay()] : null;
}

/** The seven food days a plan drafted on `draftDate` covers: the day after it, onward. */
export function mealPlanWeekDates(draftDate: string): string[] {
  const from = addDaysISO(draftDate, 1);
  if (!from) return [];
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDaysISO(from, i);
    if (d) out.push(d);
  }
  return out;
}

function datesFrom(from: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDaysISO(from, i);
    if (d) out.push(d);
  }
  return out;
}

/**
 * Shape the week from each date's raw day number. PURE.
 *
 * ONE NUMBER FOR ONE DATE: a plan day carries the number Intake shows for that date
 * (`dayEnergyTarget`), said in the same fifties (DAY_SHIFT_STEP_KCAL: the average plus a
 * multiple of the step). Only two things move a day off it:
 *   - the day floor: a day under `floor` is raised to the lowest such number at or above it;
 *   - the window's balance: the seven days run from the day after the draft, so they can
 *     straddle two Monday-to-Sunday weeks, each balanced only over its own days, and a
 *     floor raise adds energy too. Whatever the window carries over (or under) seven times
 *     the average is settled one step at a time on the days on that side, the day furthest
 *     out first, never past the average itself (days above only come down toward it, days
 *     below only come up, so no day is pushed under the floor). Days from
 *     `settleFirstFrom` on — a week that has not opened yet, whose own numbers are still
 *     provisional and are not on Intake's strip — settle first, so the week the athlete
 *     can see keeps its numbers wherever the later days have room.
 * The stored days then sum to seven times the average (within one step when no day has
 * room). An average at or under the floor plans flat (null). Only days whose number ends
 * up off the average are kept; nothing moved is null.
 */
export function shapeMealPlanDayEnergy(input: {
  from: string;
  average: number;
  floor: number;
  days: Array<{ date: string; kcal: number; work?: string[] }>;
  settleFirstFrom?: string | null;
}): MealPlanDayEnergy | null {
  const average = Math.round(Number(input.average));
  const floor = Math.max(ABSOLUTE_KCAL_FLOOR, Math.round(Number(input.floor) || 0));
  if (!ISO.test(String(input.from)) || !Number.isFinite(average) || average <= floor) return null;
  const rows = (Array.isArray(input.days) ? input.days : []).filter(
    (d) => ISO.test(String(d?.date)) && Number.isFinite(Number(d?.kcal)) && Number(d.kcal) > 0
  );
  if (!rows.length) return null;
  const step = DAY_SHIFT_STEP_KCAL;
  // The lowest number in the step at or above the floor.
  const floorValue = average + Math.ceil((floor - average) / step) * step;
  // Each day in the step around the average (a day's own number already is), raised to the floor.
  const shift = rows.map((d) => inSteps(Number(d.kcal) - average));
  const values = shift.map((s) => Math.max(floorValue, average + s));
  const first = ISO.test(String(input.settleFirstFrom ?? "")) ? String(input.settleFirstFrom) : null;
  let residual = values.reduce((a, b) => a + b, 0) - rows.length * average;
  for (let guard = 0; residual !== 0 && guard < rows.length * 40; guard++) {
    // Over: a day above the average gives a step; under: a day below takes one.
    const side = residual > 0 ? 1 : -1;
    const pool = rows.map((_, i) => i).filter((i) => (values[i] - average) * side >= step);
    if (!pool.length) break;
    const early = (i: number) => (first && rows[i].date >= first ? 0 : 1);
    // A later, provisional week first; then the day furthest out; a tie goes to the day that
    // started closer in (so the bigger day stays the bigger), then the earlier date.
    pool.sort(
      (a, b) =>
        early(a) - early(b) ||
        Math.abs(values[b] - average) - Math.abs(values[a] - average) ||
        Math.abs(shift[a]) - Math.abs(shift[b]) ||
        a - b
    );
    const i = pool[0];
    values[i] -= side * step;
    residual -= side * step;
  }
  const days: MealPlanEnergyDay[] = [];
  rows.forEach((row, i) => {
    const value = values[i];
    if (value === average) return;
    const weekday = weekdayKeyOfDate(row.date);
    if (!weekday) return;
    const work = (Array.isArray(row.work) ? row.work : []).map((w) => String(w).trim()).filter(Boolean);
    days.push({
      date: row.date,
      weekday,
      kcal: value,
      shift_kcal: value - average,
      why: work.length ? work.join(" and ") : value < average ? "a lighter day" : "the day's training",
    });
  });
  if (!days.length) return null;
  return { version: MEAL_PLAN_DAY_ENERGY_VERSION, average_kcal: average, floor_kcal: floor, from: input.from, days };
}

/** The stored record when it is one this module wrote, else null. PURE. */
export function readMealPlanDayEnergy(parsed: any): MealPlanDayEnergy | null {
  const raw = parsed?.day_energy;
  if (!raw || typeof raw !== "object" || Number(raw.version) !== MEAL_PLAN_DAY_ENERGY_VERSION) return null;
  const average = Number(raw.average_kcal);
  const floor = Math.max(ABSOLUTE_KCAL_FLOOR, Number(raw.floor_kcal) || 0);
  if (!ISO.test(String(raw.from)) || !Number.isFinite(average) || average <= 0) return null;
  const window = new Set(datesFrom(String(raw.from)));
  const days = (Array.isArray(raw.days) ? raw.days : [])
    .filter((d: any) => d && window.has(String(d.date)) && Number.isFinite(Number(d.kcal)) && Number(d.kcal) >= floor)
    .map((d: any) => ({
      date: String(d.date),
      weekday: weekdayKeyOfDate(String(d.date)) ?? "",
      kcal: Math.round(Number(d.kcal)),
      shift_kcal: Math.round(Number(d.kcal)) - Math.round(average),
      why: String(d.why ?? "").slice(0, 120),
    }));
  if (!days.length) return null;
  return {
    version: MEAL_PLAN_DAY_ENERGY_VERSION,
    average_kcal: Math.round(average),
    floor_kcal: floor,
    from: String(raw.from),
    days,
  };
}

/** The date a plan day's label maps onto inside the plan's week, or null. PURE. */
function dateForLabel(energy: MealPlanDayEnergy, label: unknown): string | null {
  const key = weekdayKeyOfLabel(label);
  if (!key) return null;
  return datesFrom(energy.from).find((d) => weekdayKeyOfDate(d) === key) ?? null;
}

/**
 * The server's number for each of the plan's days, in `parsed.days` order: a number for a
 * day that moved, null for a day that sits at the average (or a plan with no split at all).
 * Read from the stored record, never from a day's own `target_kcal`. PURE.
 */
export function mealPlanDayKcalTargets(parsed: any): Array<number | null> {
  const days = Array.isArray(parsed?.days) ? parsed.days : [];
  const energy = readMealPlanDayEnergy(parsed);
  if (!energy) return days.map(() => null);
  return days.map((day: any) => {
    const date = dateForLabel(energy, day?.day);
    return date ? (energy.days.find((d) => d.date === date)?.kcal ?? null) : null;
  });
}

/** The lowest number any of the plan's days may total, or the absolute floor. PURE. */
export function mealPlanDayFloorKcal(parsed: any): number {
  return readMealPlanDayEnergy(parsed)?.floor_kcal ?? ABSOLUTE_KCAL_FLOOR;
}

/**
 * The plan's own number for a calendar date, or null when the plan carries none for it
 * (an old plan, a day at the average, a date outside the plan's week). PURE.
 */
export function mealPlanDayKcalFor(parsed: any, date: string): number | null {
  const energy = readMealPlanDayEnergy(parsed);
  return energy?.days.find((d) => d.date === date)?.kcal ?? null;
}

/** The last of the seven food days the split covers. PURE. */
export function mealPlanDayEnergyEnd(energy: MealPlanDayEnergy): string {
  return addDaysISO(energy.from, 6) ?? energy.from;
}

/**
 * The stored split held to a (possibly higher) day floor: when `floor` is above the floor
 * it was made with — a cut that started after the draft — every day under it is raised and
 * the week re-centred exactly as at the draft (shapeMealPlanDayEnergy). A floor at or above
 * the average leaves no split (null): the plan is then held to the flat checks. PURE.
 */
export function refloorMealPlanDayEnergy(energy: MealPlanDayEnergy, floor: number): MealPlanDayEnergy | null {
  const live = Math.round(Number(floor) || 0);
  if (!(live > energy.floor_kcal)) return energy;
  const days = datesFrom(energy.from).map((date) => {
    const moved = energy.days.find((d) => d.date === date);
    return { date, kcal: moved?.kcal ?? energy.average_kcal, work: moved?.why ? [moved.why] : [] };
  });
  return shapeMealPlanDayEnergy({ from: energy.from, average: energy.average_kcal, floor: live, days });
}

/**
 * Re-derive every day's fields from the stored record, dropping whatever a model or a
 * client put on a day under those names. A plan with no (valid) record comes back with the
 * fields removed and nothing else touched. PURE.
 *
 * - `planned_kcal`: the number a moved day's meals are sized to, for as long as the plan
 *   lives (the client's copy of the adequacy check reads it; the server's reads the record).
 * - `date`, `target_kcal`, `target_why`: the day's date and its number for display, only
 *   while the split's week is current. With `today` past the window's last day they are
 *   left off, so a plan viewed from its second week reads flat, like every server reader.
 * - `floor`: the live day floor; a stored split made under a lower floor is raised to it
 *   (refloorMealPlanDayEnergy) and the raised record is what comes back.
 */
export function projectMealPlanDayEnergy<T>(parsed: T, opts: { today?: string; floor?: number } = {}): T {
  const p: any = parsed;
  if (!p || typeof p !== "object" || !Array.isArray(p.days)) return parsed;
  const stored = readMealPlanDayEnergy(p);
  const energy = stored && opts.floor != null ? refloorMealPlanDayEnergy(stored, opts.floor) : stored;
  const current = !!energy && (!opts.today || opts.today <= mealPlanDayEnergyEnd(energy));
  const days = p.days.map((day: any) => {
    if (!day || typeof day !== "object") return day;
    const { date: _d, target_kcal: _k, target_why: _w, planned_kcal: _p, ...rest } = day;
    if (!energy) return rest;
    const date = dateForLabel(energy, day.day);
    if (!date) return rest;
    const moved = energy.days.find((d) => d.date === date);
    if (!current) return moved ? { ...rest, planned_kcal: moved.kcal } : rest;
    return moved
      ? { ...rest, date, planned_kcal: moved.kcal, target_kcal: moved.kcal, target_why: moved.why }
      : { ...rest, date };
  });
  const out: any = { ...p, days };
  if (!energy) delete out.day_energy;
  else out.day_energy = energy;
  return out as T;
}

/**
 * Lay the server's split over a draft: any `day_energy` the draft already carries (a
 * model's echo) is discarded, the server's record (or none) takes its place, and the days
 * are projected from it. PURE.
 */
export function applyMealPlanDayEnergy<T>(parsed: T, energy: MealPlanDayEnergy | null): T {
  const p: any = parsed;
  if (!p || typeof p !== "object") return parsed;
  const { day_energy: _dropped, ...rest } = p;
  return projectMealPlanDayEnergy((energy ? { ...rest, day_energy: energy } : rest) as T);
}
