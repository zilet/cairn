// Day-specific fuel DEMAND — the deterministic read of "how much work does this
// particular day carry?", so a flat daily calorie target stops being the only thing
// the week knows about food.
//
// The gap this closes: `dayFuelState` grades protein pacing WITHIN a day and the
// nutrition guidance says "carb-forward around training" generically, so nothing
// connected the week's hardest days — the long run, a quality session, a heavy lower
// day, a strength+run double — to the fuel those days actually ask for. On a cut that
// is exactly where a flat target quietly underfuels the work.
//
// What this is NOT: it never moves a calorie target. The accepted `nutrition_targets`
// number stays authoritative; this read only says which days carry the big work, so a
// surface can bias CARBS toward them and a meal-plan agent can shape the week. It is a
// suggestion, never a gate, and it is adherence-NEUTRAL by construction: it reads
// forward-looking demand only and never grades a day that has already happened (there
// is no "you underfueled your long run" anywhere in this module or downstream of it).
//
// Sources, all read-only and all existing readers:
//   • RUN days come from `flexibleTrainingAgenda` — the same resolver the progress
//     surfaces use. Run days are movable (an intent carries a `suggested_date`, not a
//     fixed weekday), so re-deriving them off the weekly template would answer a
//     different question than the app already answers on screen.
//   • STRENGTH days come from `planDayStrengthGroups()` (which owns the heavy-lower
//     classification) projected onto the date with the plan's Monday-anchored
//     day_number→weekday convention.
//   • LOGGED work refines a date that has already started, via `dayLoad` and
//     `hybridDayContext().cardio_today`.
//
// Absence is neutral: no plan, no agenda, nothing logged → "standard". Nothing here
// throws; every failure degrades to the neutral read.
import { db } from "../db.js";
import { flexibleTrainingAgenda } from "./flexible-training-agenda.js";
import type { FlexibleRunKind, FlexibleTrainingAgenda } from "./flexible-training-agenda.js";
import type { WeeklyRunPlan } from "./run-progression.js";
import type { PlanDayGroups } from "./training-read.js";
import { dayLoad, hybridDayContext, planDayStrengthGroups } from "./training-read.js";
import { addDaysISO, localDateISO } from "./shared.js";

export type FuelDemandLevel = "light" | "standard" | "big";

export interface DayFuelDemand {
  date: string;
  demand: FuelDemandLevel;
  /**
   * Machine register: what makes this day big, in evidence prose. Empty on a
   * standard or light day. Never rendered to a person as-is — the athlete-facing
   * line rotates through its own variant set (see the fuel card).
   */
  drivers: string[];
  /** Which inputs were actually present for this read (never a confidence score). */
  evidence: string[];
}

export interface FuelDemandWeek {
  as_of: string;
  through: string;
  days: DayFuelDemand[];
}

export interface FuelDemandOpts {
  /** Test injection — mirrors flexibleTrainingAgenda's own runPlan override. */
  runPlan?: WeeklyRunPlan | null;
  /**
   * What "today" is, for the two rules that need it: a past week's run intentions are
   * not re-placed, and only a day that has already started is checked against logged
   * work. Injectable for deterministic tests, exactly as dayFuelState takes `now`.
   */
  today?: string;
  /**
   * An already-computed agenda for the CURRENT ISO week (mirrors weekLayoutRead's own
   * `agenda` injection). When provided, the current week's run days are read straight
   * off it instead of re-deriving `flexibleTrainingAgenda` — one derivation per
   * request instead of several identical ones. Only ever consulted for the week
   * containing `today`; a window that reaches into a future week still derives that
   * week live (an injected agenda is never stale-projected onto a week it wasn't
   * computed for). Omit (or pass `undefined`) to keep the previous always-derive
   * behavior; this is a pure optimization and changes no output.
   */
  agenda?: FlexibleTrainingAgenda | null;
}

const NEUTRAL_EVIDENCE: string[] = [];

function neutralDay(date: string): DayFuelDemand {
  return { date, demand: "standard", drivers: [], evidence: NEUTRAL_EVIDENCE.slice() };
}

// Plan days carry no inherent weekday, so day_number maps sequentially onto Mon..Sun
// (wrapping for a plan shorter than a week). The SAME convention as the rotation
// fallback (plan-selection.weekdayCandidate) and the hybrid forward projection
// (training-read.planDayForFutureDate) — both of which keep it private, so this
// mirrors the convention rather than reaching through a module boundary for it.
// Best-effort by design: the agent owns the real day-by-day, and a wrong guess here
// can only ever cost one quiet carb-bias line.
function planDayForDate(date: string, ordered: readonly PlanDayGroups[]): PlanDayGroups | null {
  if (!ordered.length) return null;
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
  return ordered[weekday % ordered.length] ?? null;
}

interface PlanDayItemCount {
  items: number;
  cardio_items: number;
}

// How many items each plan day carries, so a programmed REST day (no items at all)
// is distinguishable from a cardio-only day. `planDayStrengthGroups` deliberately
// ignores cardio items, so on its own an empty group list cannot tell the two apart —
// and calling a run day "light" is the one mistake this read must not make.
function planDayItemCounts(): Map<number, PlanDayItemCount> {
  const out = new Map<number, PlanDayItemCount>();
  try {
    const rows = db
      .prepare(
        `SELECT pd.day_number AS day_number,
                COUNT(pi.id) AS items,
                SUM(CASE WHEN pi.kind = 'cardio' THEN 1 ELSE 0 END) AS cardio_items
           FROM plan_days pd
           LEFT JOIN plan_items pi ON pi.plan_day_id = pd.id
          GROUP BY pd.day_number`
      )
      .all() as any[];
    for (const row of rows) {
      const dayNumber = Number(row.day_number);
      if (!Number.isFinite(dayNumber)) continue;
      out.set(dayNumber, { items: Number(row.items) || 0, cardio_items: Number(row.cardio_items) || 0 });
    }
  } catch {
    return out;
  }
  return out;
}

interface RunDayRead {
  available: boolean;
  /** date → the run kinds landing on it (completed work first, then open intents). */
  byDate: Map<string, FlexibleRunKind[]>;
}

// Shared shaping of a FlexibleTrainingAgenda into the date→kinds map this module reads
// off, whether the agenda was just derived live or handed in already-computed.
function agendaToRunDayRead(agenda: FlexibleTrainingAgenda | null | undefined): RunDayRead {
  const byDate = new Map<string, FlexibleRunKind[]>();
  if (!agenda || !agenda.available) return { available: false, byDate };
  for (const intent of agenda.intents) {
    const date = intent.completion?.date ?? intent.suggested_date;
    if (!date) continue;
    const kinds = byDate.get(date);
    if (kinds) kinds.push(intent.kind);
    else byDate.set(date, [intent.kind]);
  }
  return { available: true, byDate };
}

// The week's run days as the app already resolves them. A completed intent is dated by
// the run that closed it; an open one by its suggested date (which is movable, and may
// be null when no clean opening remains — an undated intention belongs to no day).
function runDaysFromAgenda(asOf: string, opts?: FuelDemandOpts): RunDayRead {
  try {
    const agenda = flexibleTrainingAgenda(asOf, opts?.runPlan !== undefined ? { runPlan: opts.runPlan } : undefined);
    return agendaToRunDayRead(agenda);
  } catch {
    return { available: false, byDate: new Map() };
  }
}

function mondayOf(dateISO: string): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const NO_RUN_READ: RunDayRead = { available: false, byDate: new Map() };

// The agenda for the ISO week containing `week` (its Monday), read as of the right
// moment: the CURRENT week is read as of today, so work already logged this week has
// closed what it closed; a FUTURE week is read from its own Monday, where nothing has
// happened yet. A PAST week is not read at all — the agenda would re-place its
// unfinished intentions onto days that are already over, and a day that has been lived
// is described by what was actually logged, never by what was once suggested for it.
function agendaForWeek(week: string, today: string, opts?: FuelDemandOpts): RunDayRead {
  const currentWeek = mondayOf(today);
  if (week < currentWeek) return NO_RUN_READ;
  // An injected agenda was computed for TODAY's week only (mirrors weekLayoutRead's
  // own agenda injection) — reuse it there and only there. A window that reaches into
  // a future week still derives that week live rather than projecting a current-week
  // agenda onto days it was never computed for.
  if (week === currentWeek && opts?.agenda !== undefined) return agendaToRunDayRead(opts.agenda);
  return runDaysFromAgenda(week === currentWeek ? today : week, opts);
}

interface LoggedDay {
  strength: boolean;
  run: boolean;
  cardio: boolean;
}

// What is actually on the books for a date that has already started. A future date has
// nothing logged by definition, so this is never asked about one.
function loggedWork(date: string): LoggedDay {
  let strength = false;
  let run = false;
  let cardio = false;
  try {
    strength = dayLoad(date, { countsCardio: false }) !== "none";
  } catch {
    strength = false;
  }
  try {
    const today = hybridDayContext(date).cardio_today;
    cardio = !!today;
    run = today?.sport === "run";
  } catch {
    cardio = false;
    run = false;
  }
  return { strength, run, cardio };
}

interface DemandInputs {
  runs: RunDayRead;
  planDays: readonly PlanDayGroups[];
  itemCounts: Map<number, PlanDayItemCount>;
  today: string;
}

function classify(date: string, inputs: DemandInputs): DayFuelDemand {
  const { runs, planDays, itemCounts, today } = inputs;
  const drivers: string[] = [];
  const evidence: string[] = [];

  const runKinds = new Set(runs.byDate.get(date) ?? []);
  if (runs.available) evidence.push("flexible_training_agenda");

  const planDay = planDayForDate(date, planDays);
  if (planDay) evidence.push("plan_days");
  const counts = planDay ? itemCounts.get(planDay.day_number) : undefined;

  const logged = date <= today ? loggedWork(date) : null;
  if (logged?.strength) evidence.push("logged_sessions");
  if (logged?.cardio) evidence.push("logged_activities");

  const strengthDay = !!planDay?.groups.length || !!logged?.strength;
  const runDay = runKinds.size > 0 || !!logged?.run;

  if (runKinds.has("long")) drivers.push("long run on this day");
  if (runKinds.has("quality")) drivers.push("quality run on this day");
  if (planDay?.heavy_lower) drivers.push("heavy lower-body strength day");
  if (strengthDay && runDay) drivers.push("strength and running on the same day");

  const demand: FuelDemandLevel = drivers.length
    ? "big"
    : // A genuine rest day: the plan programs nothing at all that day, no run
      // intention has landed on it, and (for a day already underway) nothing has
      // been logged. Anything less certain than that stays standard — absence of
      // evidence is neutral here, never a reason to read a day as light.
      planDay && counts && counts.items === 0 && !runDay && !logged?.strength && !logged?.cardio
      ? "light"
      : "standard";

  return { date, demand, drivers, evidence };
}

/**
 * The demand read for ONE date (defaults to today). Deterministic, read-only and
 * null-safe: any failure degrades to the neutral "standard" read rather than
 * throwing into a nutrition surface.
 */
export function dayFuelDemand(date?: string, opts?: FuelDemandOpts): DayFuelDemand {
  const today = opts?.today || localDateISO();
  const d = date || today;
  try {
    return classify(d, {
      runs: agendaForWeek(mondayOf(d), today, opts),
      planDays: planDayStrengthGroups(),
      itemCounts: planDayItemCounts(),
      today,
    });
  } catch {
    return neutralDay(d);
  }
}

/**
 * The forward week's demand map — `days` consecutive days starting at `date`
 * (default: today). This is what a weekly meal plan is built against, so the agent
 * can bias carbohydrate toward the days that carry the work instead of spreading one
 * flat number across seven different days.
 *
 * The agenda is week-scoped, so a window that crosses into the next ISO week reads
 * both weeks' agendas — never one agenda per day, which would re-anchor "as of" seven
 * times and hand back seven mutually inconsistent placements.
 */
export function fuelDemandWeek(date?: string, days = 7, opts?: FuelDemandOpts): FuelDemandWeek {
  const today = opts?.today || localDateISO();
  const start = date || today;
  const span = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 14) : 7;
  const dates: string[] = [];
  for (let i = 0; i < span; i++) {
    const d = i === 0 ? start : addDaysISO(start, i);
    if (!d) break;
    dates.push(d);
  }
  const through = dates.length ? dates[dates.length - 1] : start;
  try {
    const planDays = planDayStrengthGroups();
    const itemCounts = planDayItemCounts();
    // One agenda per ISO week the window touches — never one per day, which would
    // re-anchor "as of" seven times and hand back seven mutually inconsistent
    // placements of the same movable intentions.
    const agendas = new Map<string, RunDayRead>();
    const runsFor = (d: string): RunDayRead => {
      const week = mondayOf(d);
      const cached = agendas.get(week);
      if (cached) return cached;
      const read = agendaForWeek(week, today, opts);
      agendas.set(week, read);
      return read;
    };
    return {
      as_of: start,
      through,
      days: dates.map((d) => classify(d, { runs: runsFor(d), planDays, itemCounts, today })),
    };
  } catch {
    return { as_of: start, through, days: dates.map(neutralDay) };
  }
}
