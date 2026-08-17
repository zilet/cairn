import { db } from "../db.js";
import { addDaysISO, approxTimeForMealLabel, localDateISO, normalizeWallClock } from "./shared.js";

export type IntakeDayCoverage = "complete" | "partial" | "none";

export interface CompletedIntakeDay {
  date: string;
  kcal: number;
  meals: string[];
  // The one classification (see `classifyIntakeDay`). `credible` is exactly
  // `coverage === "complete"`, kept as its own field because every existing reader
  // filters on it.
  coverage: IntakeDayCoverage;
  credible: boolean;
  entries: number;
  morning: boolean;
  evening: boolean;
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

// ---- the one intake-coverage classifier --------------------------------------
//
// THE LAW, mirroring sensor-freshness's "a stale wearable reading behaves as
// absent, never as current": LOGGED INTAKE IS EVIDENCE ONLY WHEN THE DAY IS
// PLAUSIBLY COMPLETE. A partial or unlogged day is ABSENT, never "low". Reading a
// day whose dinner was never logged as a low-intake day is how a quiet week turns
// into a fabricated deficit, an underfueling read, and a maintenance estimate
// built on food nobody failed to eat.
//
// A COMPLETE day looks like the athlete's own description of one: food at the
// front of the day AND food at the end of it, across at least two entries. A day
// with food on it that does not span that way — one mid-day entry, an evening-only
// entry, a day whose dinner never arrived — is PARTIAL. A day with nothing on it
// is NONE. Partial and none are both absent for evidence purposes; they are kept
// distinct because coverage reporting wants to say which one it saw.
//
// Placement uses the SAME read-time ladder `getDayIntake` sorts a day by, and for
// the same reason: `eaten_at` is the only recorded fact, a named meal's
// representative hour is good enough to place breakfast before dinner and never
// good enough to store, and nothing here is ever written back to the row.
//
// Two shapes never reach that ladder, and each keeps its own rule:
//   - snacks and drinks alone are not a day's eating, whatever hours they span;
//   - a day whose entries carry no time and no placeable label ("meal") can still
//     be a whole day declared in one go, so a day's worth of calories on such a
//     day reads complete. The bar is a DAY's food, not a meal's — and it only
//     applies where placement is genuinely unknown, which means NOTHING on the day
//     could be placed. One untimed drink alongside a logged breakfast and lunch
//     does not make the missing dinner ambiguous; where we can see that the food
//     landed before the evening, that absence is informative and stands.
const MORNING_WINDOW_END_HOUR = 12; // food logged before noon opens the day
// 17:00 — the same hour partOfDay flips to "evening" at and MEAL_WINDOWS opens
// dinner at, so "the end of the day" means one thing across the whole system.
const EVENING_WINDOW_START_HOUR = 17;
const MIN_COMPLETE_ENTRIES = 2;
// A day's worth of food, for a day whose entries cannot be placed in time at all.
const UNPLACEABLE_DAY_MIN_KCAL = 1_500;
// The floor on the SPANNING arm. Reaching from the morning into the evening says
// the day's shape is on the record; it does not say the day's food is. A logged
// breakfast and a logged late snack span the whole day between them and come to
// less than one meal — read as complete, that becomes a fabricated 800 kcal day
// and the same fabricated deficit the law above exists to prevent. Set BELOW the
// unplaceable bar on purpose: a spanning day has real placement evidence behind
// it, so it is asked for less than a day declared in one untimed lump.
const SPANNING_DAY_MIN_KCAL = 1_200;
const SNACK_LABEL = /^(snack|treat|drink|beverage)$/;

export interface IntakeDayEntry {
  meal: string;
  eaten_at: string | null;
  kcal: number;
}

export interface IntakeDayShape {
  coverage: IntakeDayCoverage;
  // Entries carrying real calories — the only ones that can back an intake number.
  entries: number;
  kcal: number;
  morning: boolean;
  evening: boolean;
  placed: number;
  unplaceable: number;
  snack_only: boolean;
  // MACHINE register — third-person evidence prose for the provenance trail.
  reason: string;
}

function minuteOfDay(hhmm: unknown): number | null {
  const t = normalizeWallClock(hhmm);
  return t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null;
}

/**
 * Classify one day's logged entries as complete / partial / none.
 *
 * PURE — no clock, no database. Every coverage read in the system routes here:
 * `completedIntakeRange` for a window of closed days, `dayIntakeCoverage` for a
 * single named day (today included).
 */
export function classifyIntakeDay(entries: IntakeDayEntry[]): IntakeDayShape {
  const food = (Array.isArray(entries) ? entries : []).filter((entry) => Number(entry?.kcal) > 0);
  const kcal = Math.round(food.reduce((sum, entry) => sum + Number(entry.kcal), 0));
  if (!food.length) {
    return {
      coverage: "none",
      entries: 0,
      kcal: 0,
      morning: false,
      evening: false,
      placed: 0,
      unplaceable: 0,
      snack_only: false,
      reason: "Nothing is logged for this day, so intake is unknown rather than low.",
    };
  }

  const labels = food.map((entry) =>
    String(entry?.meal ?? "meal")
      .trim()
      .toLowerCase()
  );
  const snackOnly = labels.every((label) => SNACK_LABEL.test(label));
  const placements = food.map(
    (entry, i) => minuteOfDay(entry.eaten_at) ?? minuteOfDay(approxTimeForMealLabel(labels[i]))
  );
  const placed = placements.filter((minute): minute is number => minute != null);
  const unplaceable = food.length - placed.length;
  const unplaceableKcal = Math.round(
    food.reduce((sum, entry, i) => (placements[i] == null ? sum + Number(entry.kcal) : sum), 0)
  );
  const morning = placed.some((minute) => minute < MORNING_WINDOW_END_HOUR * 60);
  const evening = placed.some((minute) => minute >= EVENING_WINDOW_START_HOUR * 60);

  const spans = food.length >= MIN_COMPLETE_ENTRIES && morning && evening;
  const spansTheDay = spans && kcal >= SPANNING_DAY_MIN_KCAL;
  // Genuinely unknown placement means NOTHING on the day could be placed, and the
  // bar is measured against the untimed calories alone — counting placed food
  // toward it would let one placeable meal carry an untimed sip over the line.
  const wholeDayDeclared = placed.length === 0 && unplaceable > 0 && unplaceableKcal >= UNPLACEABLE_DAY_MIN_KCAL;
  const complete = !snackOnly && (spansTheDay || wholeDayDeclared);

  const reason = complete
    ? spansTheDay
      ? `${food.length} logged entries reach from the morning into the evening, so the day reads as a whole one.`
      : `${unplaceableKcal} kcal across ${food.length} untimed ${food.length === 1 ? "entry" : "entries"} is a whole day's food declared at once.`
    : snackOnly
      ? "Only snacks or drinks are logged, which does not describe a day's eating."
      : spans
        ? `The logged entries reach across the day but come to ${kcal} kcal, less than a day's eating, so the day's total is absent evidence rather than a low intake.`
        : !evening
          ? "Nothing is logged at the end of the day, so the day's total is absent evidence rather than a low intake."
          : "The logged entries do not reach across the day, so the day's total is absent evidence rather than a low intake.";

  return {
    coverage: complete ? "complete" : "partial",
    entries: food.length,
    kcal,
    morning,
    evening,
    placed: placed.length,
    unplaceable,
    snack_only: snackOnly,
    reason,
  };
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
      `SELECT id, COALESCE(date, substr(created_at, 1, 10)) AS day, meal, eaten_at, parsed_json
         FROM food_notes
        WHERE COALESCE(date, substr(created_at, 1, 10)) >= ?
          AND COALESCE(date, substr(created_at, 1, 10)) <= ?`
    )
    .all(since, effectiveThrough) as any[];
  const byDay = new Map<string, IntakeDayEntry[]>();
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
    const current = byDay.get(date) ?? [];
    current.push({
      meal: String(row.meal || "meal")
        .trim()
        .toLowerCase(),
      eaten_at: row.eaten_at ?? null,
      kcal,
    });
    byDay.set(date, current);
  }
  const observed = [...byDay.entries()]
    .map(([date, dayEntries]) => {
      const shape = classifyIntakeDay(dayEntries);
      return {
        date,
        kcal: shape.kcal,
        meals: dayEntries.map((entry) => entry.meal),
        coverage: shape.coverage,
        credible: shape.coverage === "complete",
        entries: shape.entries,
        morning: shape.morning,
        evening: shape.evening,
      };
    })
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
