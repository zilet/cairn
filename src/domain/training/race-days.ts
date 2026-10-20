// THE RACE COUNTDOWN — today through race day, one row a day.
//
// Three weeks out the race page stops being a ladder of weeks and becomes a calendar:
// what each day holds, how it fits the week, what the coach adapted. Composed from the
// reads that already own each fact, nothing re-derived:
//   - the calendar: planWeek, the plan strip's own week — this week AS OF today, a later
//     week as of its Monday (dayDetailWeekAsOf, the rule the day page and the look-ahead
//     share), so a row says what the day opens on. Its lift is the weekday map's plan
//     day (today's cell the adaptive selection's), its run the agenda's intent dated there.
//   - the run's parts: the weekly run plan's prescription of that kind, laid out by the
//     day page's own dayDetailRunStructure, with the race build's pace bands.
//   - the week: the race build's rung (the ONE stage word, focus, how the lifting fits).
//   - the legs: the stress budget's race-week / taper / key-run-eve trim
//     (stressBudgetSnapshot) on a heavy-leg day, or a coach change adapting one.
//   - the coach's changes on each date (day-changes.ts).
//   - travel: the plan week's cell / the leg map's `travel`, read defensively (absent is
//     no marker).
//
// Changes nothing. Words, kilometres and paces in the athlete's units; no score, no gate.
import type { DayDetailChange } from "../../contracts/day-changes.js";
import {
  RACE_DAYS_WINDOW,
  type RaceDay,
  type RaceDayLift,
  type RaceDayRun,
  type RaceDays,
  type RaceDaysWeek,
} from "../../contracts/race-days.js";
import { addDaysISO, daysBetweenISO, mondayOf } from "../../lib/dates.js";
import { round1 } from "../../lib/numbers.js";
import { distanceValue, distanceWords, paceWords, type DistanceUnit } from "../../repo/display-words.js";
import { getHrModel } from "../../repo/hr-model.js";
import { getPlan } from "../../repo/plan.js";
import { isoDow, WEEKDAY_NAMES } from "../../repo/profile.js";
import { paceKeyForQuality, raceBuild, raceCountdown, type PaceBand, type RaceBuild } from "../../repo/race-build.js";
import { raceRecoveryLine } from "../../repo/race-recovery.js";
import { RUN_KIND_LABELS } from "../../repo/run-edit.js";
import { runZones, weeklyRunPlan, type RunPlanPrescription, type RunZones } from "../../repo/run-progression.js";
import { athleteUnits } from "../../repo/settings.js";
import { localDateISO } from "../../repo/shared.js";
import { stressBudgetSnapshot } from "../../repo/stress-budget.js";
import { planDayStrengthGroups } from "../../repo/training-read.js";
import { getTrainingIntent } from "../../repo/training-intent.js";
import { getBrainDecision } from "../../repo/brain-decisions.js";
import { coachChangesRead, decisionLowersDay, type CoachChangesRead } from "./day-changes.js";
import { dayDetailRunStructure, dayDetailWeekAsOf } from "./day-detail.js";
import { planWeek, type PlanWeek, type PlanWeekDay } from "./plan-week.js";

export { RACE_DAYS_WINDOW };

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

function positiveKm(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? round1(n) : null;
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function shortWeekday(date: string): string {
  return (WEEKDAY_NAMES[isoDow(date)] ?? "").slice(0, 3);
}

/** A trip label off whatever shape the cell's `travel` takes; null when there is none. */
function travelOf(value: unknown): { label: string } | null {
  if (!value) return null;
  if (value === true) return { label: "Travelling" };
  if (typeof value === "string") return { label: text(value) || "Travelling" };
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v.active === false || v.travel === false) return null;
    const label = [v.label, v.title, v.text, v.name, v.destination, v.place].map(text).find(Boolean);
    return { label: label || "Travelling" };
  }
  return null;
}

/** A `travel` field on a read that may or may not carry one yet (stream-added). */
function travelField(value: unknown): unknown {
  return value && typeof value === "object" ? (value as { travel?: unknown }).travel : null;
}

/** The day's own run: never a covered run that landed elsewhere, never a rested one. */
function ownRun(cell: PlanWeekDay | null): NonNullable<PlanWeekDay["run"]> | null {
  const run = cell?.run;
  if (!run || !cell?.date) return null;
  if (run.status === "completed" && run.completion_date && run.completion_date !== cell.date) return null;
  if (run.rested) return null;
  return run;
}

type WeekRead = {
  week: PlanWeek | null;
  plan: ReturnType<typeof weeklyRunPlan> | null;
  zones: RunZones | null;
};

function bandOf(bands: PaceBand[], key: string | null): PaceBand | null {
  return key ? (bands.find((b) => b.key === key) ?? null) : null;
}

/** A quality session's parts on one line, distances and the work's pace in the run units. */
function structureLine(structure: ReturnType<typeof dayDetailRunStructure>, units: DistanceUnit): string | null {
  if (structure.length < 2) return null;
  const parts = structure
    .map((seg) => {
      if (seg.km == null) return text(seg.text);
      const dist = distanceWords(seg.km, units);
      if (seg.part !== "main") return `${dist} easy`;
      return [`${dist} ${lowerFirst(text(seg.label))}`, text(seg.pace?.text)].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function runOf(
  cell: PlanWeekDay | null,
  read: WeekRead,
  build: RaceBuild,
  units: DistanceUnit,
  raceDay: boolean
): RaceDayRun | null {
  const bands = build.paces?.bands ?? [];
  const own = ownRun(cell);
  const event = text(build.race?.event);
  if (!own && !raceDay) return null;
  const rawKind = String(own?.kind ?? (raceDay ? "long" : ""));
  // A run logged on a day the agenda closed no intent for still happened: it reads easy.
  const kind: RaceDayRun["kind"] = rawKind === "quality" || rawKind === "long" ? rawKind : "easy";
  const runs = Array.isArray(read.plan?.runs) ? read.plan.runs : [];
  const rx: RunPlanPrescription | null = runs.find((r) => r.kind_label === kind) ?? null;
  const label = raceDay
    ? `Race day${event ? ` — ${event}` : ""}`
    : text(own?.label) || RUN_KIND_LABELS[kind] || "Run";
  const km = raceDay
    ? (positiveKm(build.race?.distance_km) ?? positiveKm(own?.km))
    : (positiveKm(own?.km) ?? positiveKm(rx?.target_distance_km));
  const short = kind === "quality" && rx?.dose === "short";
  const structure = safe(
    () => dayDetailRunStructure(kind, km, rx, label, raceDay, short, read.zones, bands, units),
    []
  );
  const paceKey = raceDay
    ? "race"
    : kind === "quality"
      ? paceKeyForQuality(rx?.label ?? label)
      : kind;
  const band = bandOf(bands, paceKey);
  const completed = own?.status === "completed";
  // A run already run says what was run — the logged pace off this week's own runs
  // (the race build's this_week.runs, the actual line's source), never the plan's band.
  const ranPace = completed && cell?.date ? loggedPace(build, cell.date) : null;
  return {
    kind,
    label,
    status: completed ? "completed" : "open",
    km,
    mi: km == null ? null : distanceValue(km, "mi"),
    distance_text: km == null ? null : distanceWords(km, units),
    pace_text: completed ? (ranPace != null ? paceWords(ranPace, units) : null) : band ? text(band.text) || null : null,
    structure_text: kind === "quality" && !raceDay && !completed ? structureLine(structure, units) : null,
    race: raceDay,
  };
}

/** The pace run on `date` (seconds per km, distance-weighted over its runs), off the build's week as run; null with none. */
function loggedPace(build: RaceBuild, date: string): number | null {
  const runs = (build.this_week?.runs ?? []).filter(
    (r) => r.date === date && r.pace_sec_per_km != null && Number(r.pace_sec_per_km) > 0
  );
  if (!runs.length) return null;
  const km = runs.reduce((sum, r) => sum + (Number(r.km) > 0 ? Number(r.km) : 0), 0);
  if (km <= 0) return Number(runs[0].pace_sec_per_km);
  return runs.reduce((sum, r) => sum + Number(r.pace_sec_per_km) * (Number(r.km) > 0 ? Number(r.km) : 0), 0) / km;
}

/** The plan day's items, for the stress budget's read of whether the card carries legs. */
function planItemsOf(dayNumber: number): any[] {
  const day = safe(() => (getPlan() as any[]).find((d) => Number(d?.day_number) === dayNumber), null);
  return Array.isArray(day?.items) ? day.items : [];
}

/**
 * The race build's leg trim on a heavy-leg day: taper (lighter legs), race week (heavy
 * legs sit out) or the eve of a placed key run (fewer leg sets) — stressBudgetSnapshot's
 * own read, never a second rule.
 */
function legTrimOn(date: string, dayNumber: number | null): boolean {
  if (dayNumber == null) return false;
  const role = safe(() => getTrainingIntent().endurance_role, "none" as const);
  const snap = safe(
    () => stressBudgetSnapshot(date, { dayType: "training", planItems: planItemsOf(dayNumber), enduranceRole: role }),
    undefined
  );
  if (!snap) return false;
  return snap.race_week_kind === "taper" || snap.race_week_kind === "race" || !!snap.key_run;
}

function liftOf(
  date: string,
  cell: PlanWeekDay | null,
  heavyLower: Set<number>,
  changes: DayDetailChange[]
): RaceDayLift | null {
  const plan = cell?.plan_day && cell.plan_day.role === "strength" && cell.plan_day.day_type !== "rest" ? cell.plan_day : null;
  const session = cell?.session ?? null;
  const name = text(plan?.name) || text(session?.title);
  if (!name) return null;
  const dayNumber = plan ? Number(plan.day_number) : null;
  const heavy = dayNumber != null && heavyLower.has(dayNumber);
  const done = !!session?.finished;
  // Lighter legs come from the race build's own trim, or a coach change that lowers this
  // day's work — a progression that raised the squat adapted the day, not lightened it.
  const lowered = changes.some((c) => decisionLowersDay(safe(() => getBrainDecision(c.decision_id), null), dayNumber));
  const lighter = heavy && !done && (lowered || legTrimOn(date, dayNumber));
  return { day_number: dayNumber, name, heavy_lower: heavy, legs_lighter: lighter, done };
}

function unavailable(today: string, units: DistanceUnit, reason: string): RaceDays {
  return { available: false, reason, as_of: today, run_units: units, race: null, weeks: [] };
}

/**
 * Today through race day (or `through`, never past it), grouped by week. Within
 * RACE_DAYS_WINDOW days of a dated race only; `available:false` with a reason otherwise.
 */
export function raceDays(opts: { today?: string; through?: string } = {}): RaceDays {
  const today = String(opts.today || localDateISO()).slice(0, 10);
  const units: DistanceUnit = safe(() => athleteUnits().distance, "km" as DistanceUnit);
  const build = safe(() => raceBuild(today), null);
  const race = build?.available ? build.race : null;
  if (!build || !race?.date) {
    // The days after the race: said once (race-recovery.ts), never "set a race".
    const recovering = safe(() => raceRecoveryLine(today), null);
    const reason = recovering ? `${recovering}.` : "Set a dated race and the countdown reads from it.";
    return unavailable(today, units, reason);
  }
  const daysToRace = daysBetweenISO(race.date, today);
  if (daysToRace == null || daysToRace < 0) return unavailable(today, units, "The race has been run.");
  if (daysToRace > RACE_DAYS_WINDOW) {
    return unavailable(today, units, "The day-by-day countdown opens three weeks before the race.");
  }
  const askedEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.through ?? "")) ? String(opts.through) : race.date;
  const end = askedEnd < today ? today : askedEnd > race.date ? race.date : askedEnd;

  const heavyLower = new Set<number>();
  for (const g of safe(() => planDayStrengthGroups(), [])) if (g.heavy_lower) heavyLower.add(g.day_number);
  // Day-level changes on their days; a whole-week layout once, on its week's heading.
  const coach: CoachChangesRead = safe(() => coachChangesRead(today, end), {
    days: new Map<string, DayDetailChange[]>(),
    weeks: new Map<string, DayDetailChange[]>(),
  });
  const changes = coach.days;
  const bands = build.paces?.bands ?? [];
  const thisMonday = mondayOf(today);
  const reads = new Map<string, WeekRead>();
  const readFor = (date: string): WeekRead => {
    const asOf = dayDetailWeekAsOf(date, today);
    let read = reads.get(asOf);
    if (!read) {
      read = {
        week: safe(() => planWeek(asOf), null),
        plan: safe(() => weeklyRunPlan(asOf), null),
        zones: safe(() => runZones({ model: safe(() => getHrModel(asOf), null) }), null),
      };
      reads.set(asOf, read);
    }
    return read;
  };

  const weeks: RaceDaysWeek[] = [];
  let date: string | null = today;
  for (let i = 0; date && date <= end && i <= RACE_DAYS_WINDOW; i++) {
    const day: string = date;
    const read = readFor(day);
    const cell = read.week?.days.find((d) => d.date === day) ?? null;
    const monday = mondayOf(day);
    const legDay =
      monday === thisMonday ? (build.leg_map ?? []).find((d) => d.day_number === ((isoDow(day) + 6) % 7) + 1) : null;
    const dayChanges = changes.get(day) ?? [];
    const raceDay = day === race.date;
    const run = runOf(cell, read, build, units, raceDay);
    const lift = raceDay ? null : liftOf(day, cell, heavyLower, dayChanges);
    const row: RaceDay = {
      date: day,
      weekday: shortWeekday(day),
      days_out: daysBetweenISO(race.date, day) ?? 0,
      out_words: raceCountdown(day, race.date, { byDay: true })?.words ?? "",
      today: day === today,
      race_day: raceDay,
      status: (cell?.status as RaceDay["status"]) ?? (day === today ? "today" : "upcoming"),
      run,
      lift,
      rest: !run && !lift,
      travel: travelOf(travelField(cell)) ?? travelOf(travelField(legDay)),
      changes: dayChanges,
    };
    let week = weeks[weeks.length - 1];
    if (!week || week.week_start !== monday) {
      const rung = (build.weeks ?? []).find((w) => w.week_start === monday) ?? null;
      week = {
        week_start: monday,
        stage_word: text(rung?.stage_word) || null,
        kind: rung?.kind ?? null,
        focus_short: text(rung?.focus_short) || null,
        focus: text(rung?.focus) || null,
        with_lifting: text(rung?.with_lifting) || null,
        changes: coach.weeks.get(monday) ?? [],
        days: [],
      };
      weeks.push(week);
    }
    week.days.push(row);
    date = addDaysISO(day, 1);
  }

  return {
    available: true,
    reason: null,
    as_of: today,
    run_units: units,
    race: {
      event: text(race.event) || null,
      date: race.date,
      days_to_race: daysToRace,
      countdown: race.countdown ?? raceCountdown(today, race.date),
      distance_text: distanceWords(Number(race.distance_km) || 0, units),
      target_text: text(race.target?.raw ?? race.target_raw) || null,
      pace_text: text(bandOf(bands, "race")?.text) || null,
    },
    weeks,
  };
}
