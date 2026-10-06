// THE DAY RECORD — any day that is not today, read-only (v2 wave 7, "Today is Home").
//
// Today only ever renders today. Every other day is a destination: a PAST day reads
// back what the log holds (the session, the runs and rides, the food summary, a
// weigh-in, and the day read that stood), a FUTURE day previews what the calendar
// holds (the planned lift, the planned run, and what is already known to shape it).
//
// Composed from reads that already exist and own their facts — nothing is re-derived:
//   - the log: getSessionByDate + trainingOnDate (the Lately feed's own rows, shadows
//     folded), getDayIntake + classifyIntakeDay (absent is absent, never "low");
//   - the read: getCachedDayRead (a stale row stays hidden, exactly as elsewhere);
//   - the calendar: planWeek, the plan strip's own week (the week that holds today is
//     read AS OF today, so the preview agrees with the strip and Horizon's week), and
//     the life-context events active on the day.
//
// Changes nothing. No score: words, logged numbers and kilometres.
import type {
  DayRecord,
  DayRecordActivity,
  DayRecordIntake,
  DayRecordPlannedLift,
  DayRecordPlannedRun,
  DayRecordRead,
  DayRecordRelation,
  DayRecordSession,
} from "../../contracts/day-record.js";
import { db } from "../../db.js";
import { trainingOnDate } from "../../repo/activities.js";
import { getCachedDayRead } from "../../repo/day-read-cache.js";
import { canonicalEnduranceSport } from "../../repo/endurance-sports.js";
import { listContextEvents } from "../../repo/health.js";
import { classifyIntakeDay } from "../../repo/intake-window.js";
import { getDayIntake } from "../../repo/nutrition.js";
import { RUN_KIND_LABELS } from "../../repo/run-edit.js";
import { getSessionByDate } from "../../repo/sessions.js";
import { athleteUnits } from "../../repo/settings.js";
import { localDateISO } from "../../repo/shared.js";
import { lookAheadWeekAsOf } from "../training/plan-look-ahead.js";
import { planWeek, type PlanWeekDay } from "../training/plan-week.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A valid YYYY-MM-DD, or null. The route answers 400 on null. */
export function dayRecordDate(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim().slice(0, 10) : "";
  if (!ISO.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d ? s : null;
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

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function relationOf(date: string, today: string): DayRecordRelation {
  return date < today ? "past" : date > today ? "future" : "today";
}

function sessionOf(date: string, movementsById: Map<number, DayRecordSession["movements"]>): DayRecordSession | null {
  const s = safe(() => getSessionByDate(date) as any, null);
  if (!s) return null;
  const sets = Array.isArray(s.sets) ? s.sets.length : 0;
  const movements = movementsById.get(Number(s.id)) ?? [];
  // A session row with nothing logged and never finished is a started-then-left shell,
  // not a record of training.
  if (!sets && !s.finished_at) return null;
  return {
    id: Number(s.id),
    title: text(s.title) || "Strength",
    finished: !!s.finished_at,
    sets,
    movements,
    skipped: Array.isArray(s.skips) ? s.skips.map(text).filter(Boolean) : [],
    notes: text(s.notes) || null,
  };
}

function intakeOf(date: string): DayRecordIntake | null {
  const intake = safe(() => getDayIntake(date) as any, null);
  const entries: any[] = Array.isArray(intake?.entries) ? intake.entries : [];
  if (!entries.length) return null;
  const shape = classifyIntakeDay(
    entries.map((e) => ({ meal: e.meal ?? null, eaten_at: e.eaten_at ?? null, kcal: num(e.kcal) ?? 0 }))
  );
  // A nutrient sum is spoken only when every entry carried it (the `known` flags); a
  // partial sum would read as the day's total.
  const known = (intake?.known ?? {}) as Record<string, boolean>;
  const total = (key: string): number | null =>
    known[key] === true ? Math.round(Number(intake?.totals?.[key]) || 0) : null;
  return {
    coverage: shape.coverage,
    entries: entries.length,
    kcal: total("kcal"),
    protein_g: total("protein_g"),
    carbs_g: total("carbs_g"),
    fat_g: total("fat_g"),
    meals: entries.slice(0, 12).map((e) => ({
      meal: text(e.meal) || null,
      summary: text(e.summary) || "Food",
      // Only a time the athlete STATED: with none, logged_at is the write-time label,
      // which for a remembered meal is when it was typed, not when it was eaten.
      logged_at: e.eaten_at ? text(e.logged_at) || null : null,
    })),
  };
}

function readOf(date: string): DayRecordRead | null {
  const read = safe(() => getCachedDayRead(date), null);
  const headline = text(read?.headline);
  if (!read || !headline) return null;
  return { kind: text(read.kind) || "train", headline, why: text(read.why) || null };
}

function weightOf(date: string): number | null {
  const row = safe(
    () =>
      db.prepare(`SELECT weight_lb FROM bodyweight_log WHERE date = ? ORDER BY id DESC LIMIT 1`).get(date) as
        | { weight_lb?: unknown }
        | undefined,
    undefined
  );
  const w = num(row?.weight_lb);
  return w != null && w > 0 ? Math.round(w * 10) / 10 : null;
}

// The plan strip's own week. The week that holds today is read AS OF today, so a
// preview of Thursday agrees with the strip and Horizon's week; a later week is read
// as of its own Monday (lookAheadWeekAsOf), the same week the Program look-ahead
// lists, so a tapped day previews exactly what its row said. Read as of the day
// itself, the agenda suggested its next open run on every day it was asked about.
function calendarDay(date: string, today: string): PlanWeekDay | null {
  const week = safe(() => planWeek(lookAheadWeekAsOf(date, today)), null);
  return week?.days.find((d) => d.date === date) ?? null;
}

function liftOf(day: PlanWeekDay | null): DayRecordPlannedLift | null {
  const plan = day?.plan_day;
  if (!plan || plan.role !== "strength" || !text(plan.name)) return null;
  return { title: text(plan.name), focus: text(plan.focus) || null, purpose: text(plan.purpose) || null };
}

function runOf(day: PlanWeekDay | null): DayRecordPlannedRun | null {
  const run = day?.run;
  if (!run) return null;
  const kind = text(run.kind);
  return { kind, label: RUN_KIND_LABELS[kind] ?? (text(run.label) || "Run"), km: num(run.km) };
}

function caveatsOf(date: string): string[] {
  const events = safe(() => listContextEvents({ activeOnly: true, on: date }) as any[], []);
  const out: string[] = [];
  for (const e of events) {
    const title = text(e?.title);
    if (title && !out.includes(title)) out.push(title);
  }
  return out.slice(0, 4);
}

function lower(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function pastLine(
  session: DayRecordSession | null,
  activities: DayRecordActivity[],
  logged: { intake: DayRecordIntake | null; weight: number | null }
): string {
  const runs = activities.filter((a) => a.run);
  const other = activities.filter((a) => !a.run);
  const effort = runs.length
    ? runs.length === 1
      ? "a run"
      : `${runs.length} runs`
    : other.length
      ? withArticle(other[0].title)
      : "";
  if (session) {
    const lift = session.finished ? session.title : `${session.title}, left open`;
    return effort ? `${lift}, and ${effort}.` : `${lift}.`;
  }
  if (effort) return `${effort.charAt(0).toUpperCase()}${effort.slice(1)}.`;
  // Food or a weigh-in is still a log: the line speaks only for training, never
  // "nothing" over a Fuel section that shows the day's meals.
  if ((logged.intake?.entries ?? 0) > 0 || logged.weight != null) return "A rest day.";
  return "Nothing was logged this day.";
}

function withArticle(phrase: string): string {
  const p = lower(phrase);
  return `${/^[aeiou]/i.test(p) ? "an" : "a"} ${p}`;
}

function futureLine(lift: DayRecordPlannedLift | null, run: DayRecordPlannedRun | null): string {
  if (lift && run) return `${lift.title}, then ${withArticle(run.label)}.`;
  if (lift) return `${/^[aeiou]/i.test(lift.title) ? "An" : "A"} ${lift.title} day.`;
  if (run) return `${run.label}.`;
  return "A rest day. Nothing is planned.";
}

export function dayRecord(date: string, opts: { today?: string } = {}): DayRecord {
  const today = opts.today && ISO.test(opts.today) ? opts.today : localDateISO();
  const relation = relationOf(date, today);
  const runUnits = athleteUnits().distance;

  // ---- the log (a past day and today) ----
  const feed = relation === "future" ? [] : safe(() => trainingOnDate(date), []);
  const movementsById = new Map<number, DayRecordSession["movements"]>();
  const activities: DayRecordActivity[] = [];
  for (const row of feed) {
    if (row.kind === "strength") {
      movementsById.set(row.id, Array.isArray(row.movements) ? row.movements : []);
      continue;
    }
    const meta = row.meta || {};
    activities.push({
      id: row.id,
      title: text(row.title) || "Activity",
      run: canonicalEnduranceSport(row.title).key === "run",
      distance_km: num(meta.distance_km),
      duration_min: num(meta.duration_min),
      pace: text(meta.pace) || null,
      note: text(row.note) || null,
      source: row.source ?? null,
    });
  }
  const session = relation === "future" ? null : sessionOf(date, movementsById);
  const intake = relation === "future" ? null : intakeOf(date);
  const read = relation === "past" ? readOf(date) : null;
  const weight = relation === "future" ? null : weightOf(date);

  // ---- the calendar (a future day and today) ----
  const day = relation === "past" ? null : calendarDay(date, today);
  const lift = relation === "past" ? null : liftOf(day);
  const run = relation === "past" ? null : runOf(day);

  return {
    date,
    relation,
    today,
    run_units: runUnits,
    session,
    activities,
    intake,
    read,
    weight_lb: weight,
    lift,
    run,
    rest: relation !== "past" && !lift && !run,
    caveats: caveatsOf(date),
    line: relation === "past" ? pastLine(session, activities, { intake, weight }) : futureLine(lift, run),
  };
}
