// PLAN WEEK PROJECTION — the Plan tab's connected week (did / today / coming up).
//
// Assembles existing leaves into one athlete-facing week strip: weekday-anchored
// when a lift/run schedule is known, honest template order otherwise (never invent
// Mon=Day1). Strength cells come from the lifting week's weekday map (plan days hold
// strength only), run cells from the flexible agenda dated per weekday, and a weekday
// with neither is rest. Done evidence comes from this week's logged sessions; layout
// collision is the quiet weekLayoutRead sentence.
//
// Changes nothing. Suggestion voice only — no scores, no gates.

import { db } from "../../db.js";
import { travelDaysIn } from "../../repo/travel-days.js";
import { addDaysISO, mondayOf } from "../../lib/dates.js";
import { statedWeekdayNames, weekLayoutRead } from "./week-layout.js";
import { planItemsOutOfOrder } from "./plan-item-order.js";
import { flexibleTrainingAgenda } from "../../repo/flexible-training-agenda.js";
import { getEnduranceSchedule, statedRunDows, WEEKDAY_NAMES, isoDow } from "../../repo/profile.js";
import {
  planDayRole,
  selectAdaptivePlanDay,
  selectedPlanDayForDate,
  thisWeekPlanDayMap,
  type WeekdayPlanDayRole,
} from "../../repo/plan-selection.js";
import { planDayTitle } from "../../repo/session-day.js";
import {
  sessionForDate,
  strengthLineDayNumber,
  weekSessions,
  weekStrengthPlacement,
  type PlacementMove,
  type WeekSessionRow,
} from "../../repo/week-strength-placement.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "../../repo/endurance-sports.js";
import { withoutShadowActivities } from "../../repo/activity-shadow.js";
import { weekWins } from "../../repo/sessions.js";
import { getPlanWithPurpose } from "../../repo/day-read.js";
import { strengthScheduleRead } from "../../repo/strength-schedule.js";
import { weekLayoutClosed } from "../../repo/week-layout-closed.js";
import { athleteUnits } from "../../repo/settings.js";
import { distanceWords, type DistanceUnit } from "../../repo/display-words.js";
import { localDateISO } from "../../repo/shared.js";
import { planDayStrengthGroups } from "../../repo/training-read.js";
import { todayStrengthLine, type TodayStrengthLine } from "../../repo/today-strength-line.js";
import { datedPlanDayFocus, legTrimFocus, legTrimNote, legTrimClause, withLegTrimClause, type LegTrim } from "../../repo/plan-day-focus.js";
import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import { planDayLegTrimOn } from "../../repo/plan-day-trim.js";

export type PlanWeekStatus = "done" | "today" | "upcoming" | "rest" | "open";

export interface PlanWeekPlanDay {
  day_number: number;
  name: string;
  focus: string | null;
  purpose: string | null;
  day_type: "training" | "rest";
  role: WeekdayPlanDayRole;
  out_of_order: boolean;
  /**
   * TODAY's cell only, and only before anything is logged: the day the weekday map laid
   * on this weekday, when today's selection (the one strength line — the Brief, Session
   * and Train card all read it) adapted to a different plan day. The cell names the day
   * the athlete will actually be offered; this keeps the map's day one field away.
   */
  swapped_from?: { day_number: number; name: string };
  /**
   * One server-authored line saying why this day differs from its usual slot — a swap
   * (today's selection handed the day to another plan day, `after_run` when a run
   * logged today is the cause), the bumped day's new weekday (`moved`, said on both
   * cells), a race-build leg trim (`taper`), or a trip day (`trip`). One note per cell,
   * in that priority — but a swapped / moved cell that is also trimmed carries the trim
   * in the same sentence ("Lower lands here this week, lighter for the taper."), so the
   * taper is never lost behind the move. Absent when the day reads as itself. Printed verbatim.
   */
  note?: PlanWeekNote | null;
}

export type PlanWeekNoteKind = "swap" | "moved" | "taper" | "trip" | "after_run";

export interface PlanWeekNote {
  kind: PlanWeekNoteKind;
  text: string;
}

export interface PlanWeekSession {
  id: number;
  title: string;
  date: string;
  /** Finished (finish tapped). An open session on the as-of day is in progress, not done. */
  finished: boolean;
}

export interface PlanWeekRun {
  kind: string;
  label: string;
  status: "open" | "completed";
  suggested_date: string | null;
  completion_date: string | null;
  /** The engine's prescribed distance, or the logged distance once completed. */
  km: number | null;
  /** An open run the day read rested ("Rest or an easy walk"): no run is prescribed. */
  rested?: true;
}

/**
 * The week so far, in counts a person can read — the grounding for the strip's
 * one spoken progress line. Never a score: what was done, what is still open.
 */
export interface PlanWeekProgress {
  lift_days_done: number;
  /** Stated/observed lifting weekdays this week; null when the athlete has no lifting week. */
  lift_days_planned: number | null;
  runs_done: number;
  run_km: number;
  longest_run_km: number | null;
  runs_open: { kind: string; label: string; suggested_date: string | null; weekday: string | null }[];
  /** New bests in the trailing seven days (weekWins' window). */
  prs: number;
  line: string | null;
}

export interface PlanWeekDay {
  /** Calendar date (YYYY-MM-DD) when calendar mode; null in template mode. */
  date: string | null;
  weekday: string | null;
  dow: number | null;
  status: PlanWeekStatus;
  plan_day: PlanWeekPlanDay | null;
  session: PlanWeekSession | null;
  run: PlanWeekRun | null;
  hard: boolean;
  /** Inside a trip (a context event): where he is that date. Absent date (template mode) is null. */
  travel: { title: string; location: string | null } | null;
  /**
   * TODAY's cell only: the day read's suggestion, carried from the one strength line
   * so the strip and the Brief say the same thing about one day ("Pull · lighter
   * today"). A caveat on the plan day, never a replacement title; absent once the day
   * is logged, and on every other cell.
   */
  suggestion?: { kind: "easy" | "rest"; label: string; caveat: string | null };
}

export interface PlanWeek {
  as_of: string;
  week_start: string;
  days: PlanWeekDay[];
  summary: string | null;
  progress: PlanWeekProgress;
  layout: { clean: boolean; suggestion: string | null };
  schedule: {
    lift_days: string[];
    lift_days_source: "stated" | "observed" | null;
    run_days: string[];
  };
  /** Today's lift in the one line the Brief, Session and Train overview also print. */
  strength_line: TodayStrengthLine | null;
  /** The athlete's run units (settings.run_units): every `km` here is printed in them. */
  run_units: "km" | "mi";
  /**
   * Plan days displaced this week that no later weekday could take (week-strength-placement.ts
   * `unplaced`) — said, never silently dropped. One calm server sentence each, printed verbatim.
   */
  unplaced: PlanWeekUnplaced[];
}

export interface PlanWeekUnplaced {
  day_number: number;
  name: string;
  text: string;
}

type TemplateDay = {
  id?: number;
  day_number: number;
  name?: string;
  focus?: string | null;
  purpose?: string | null;
  day_type?: string | null;
  items?: unknown[];
  names?: string[];
};

function shortWeekday(dow: number): string {
  const full = WEEKDAY_NAMES[dow] ?? "";
  return full.slice(0, 3) || `D${dow}`;
}

function asTemplateDay(raw: Record<string, unknown>): TemplateDay {
  const items = Array.isArray(raw.items) ? (raw.items as any[]) : [];
  const names: string[] = [];
  for (const it of items) {
    const name = String(it?.exercise ?? "").trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return {
    id: raw.id == null ? undefined : Number(raw.id),
    day_number: Number(raw.day_number),
    name: raw.name == null ? undefined : String(raw.name),
    focus: raw.focus == null ? null : String(raw.focus),
    purpose: raw.purpose == null ? null : String(raw.purpose),
    day_type: String(raw.day_type ?? "training").toLowerCase() === "rest" ? "rest" : "training",
    items,
    names,
  };
}

function toPlanWeekPlanDay(day: TemplateDay): PlanWeekPlanDay {
  const day_type = day.day_type === "rest" ? "rest" : "training";
  const role = planDayRole({ day_number: day.day_number, day_type, names: day.names ?? [] });
  return {
    day_number: day.day_number,
    // The one label (src/repo/session-day.ts): the today line and the session lists say
    // the same words, a "Day 3" the athlete never named reading as its focus everywhere.
    name: planDayTitle({ name: String(day.name || `Day ${day.day_number}`), focus: day.focus ?? null, day_number: day.day_number }),
    focus: day.focus ?? null,
    purpose: day.purpose ?? null,
    day_type,
    role,
    out_of_order: planItemsOutOfOrder((day.items ?? []) as any[]),
  };
}

type WeekRunLog = { date: string; km: number | null };

/** Runs actually logged this week through `through` — the log is the truth for "did". */
function weekRunLog(weekStart: string, through: string): WeekRunLog[] {
  try {
    const sport = activitySportWhere("a", RUN_SPORT_PATTERNS);
    const rawRows = db
      .prepare(
        `SELECT a.date AS date, a.type AS type, a.source AS source, a.external_id AS external_id,
                a.distance_km AS km, a.distance_km AS distance_km, a.duration_min AS duration_min
           FROM activities a
          WHERE a.date >= ? AND a.date <= ? AND (${sport.sql})
          ORDER BY a.date ASC, a.id ASC`
      )
      .all(weekStart, through, ...sport.params) as any[];
    // A hand-logged shadow of a synced run is one cell entry, not a doubled km sum.
    const rows = withoutShadowActivities(rawRows);
    return rows.map((r) => ({
      date: String(r.date),
      km: r.km == null || !Number.isFinite(Number(r.km)) ? null : Number(r.km),
    }));
  } catch {
    return [];
  }
}

function toPlanWeekSession(hit: WeekSessionRow): PlanWeekSession {
  return {
    id: hit.id,
    title: hit.title,
    date: hit.date,
    finished: hit.finished,
  };
}

/**
 * Template mode: the session this plan day's cell holds — one the logged work resolves
 * to the day, whatever it ended up called (the cell sits by WHERE, its title says WHAT).
 * Never the raw link: a redraw rewrites a row in place, so the link can name a day the
 * session never was. `taken` keeps one session to one cell.
 */
function sessionForPlanDay(rows: WeekSessionRow[], dayNumber: number, taken: Set<number>): PlanWeekSession | null {
  const hit = rows.find((r) => !taken.has(r.id) && r.placed_day_number === dayNumber);
  if (!hit) return null;
  taken.add(hit.id);
  return toPlanWeekSession(hit);
}

function statusForCell(opts: {
  date: string | null;
  asOf: string;
  planDay: PlanWeekPlanDay | null;
  session: PlanWeekSession | null;
  run: PlanWeekRun | null;
  todayDayNumber: number | null;
  /** A calendar rest day: a weekday the athlete neither lifts nor runs. */
  restDay?: boolean;
  /** Template mode only: another cell in this same week already reads "today"
   *  off an unfinished logged session. That cell is the actual today — the
   *  todayDayNumber fallback below must defer to it rather than also claiming
   *  "today" for whichever day number the ring points at, which would put two
   *  "today" cells on screen at once. */
  todayClaimedBySession?: boolean;
}): PlanWeekStatus {
  const { date, asOf, planDay, session, run, todayDayNumber } = opts;
  // Work logged TODAY in a session not yet finished is in progress, never done — the
  // same state todayStrengthLine reads off the log ("Lower A · in progress"), so the
  // cell and the today line under it cannot disagree. A past day's logged session is
  // done whether or not finish was ever tapped: the day is over, the log is the truth.
  if (session) return session.date === asOf && !session.finished ? "today" : "done";
  // A run logged on the day is that day's work done — unless the day also holds a
  // lift, which a run does not do for it ("Run in · Pull still open").
  if (run?.status === "completed" && date && run.completion_date === date && planDay?.role !== "strength") {
    return "done";
  }
  // An open run suggested for this date outranks a calendar rest day: the agenda is
  // the live truth for running.
  if (run?.status === "open" && date && run.suggested_date === date) {
    return date === asOf ? "today" : date > asOf ? "upcoming" : "open";
  }
  if (opts.restDay || planDay?.day_type === "rest") return "rest";
  if (date) {
    if (date === asOf) return "today";
    if (date > asOf) return "upcoming";
    return "open";
  }
  // Template mode — no calendar claim. Rest already returned above.
  if (planDay && todayDayNumber != null && planDay.day_number === todayDayNumber && !opts.todayClaimedBySession) {
    return "today";
  }
  return "upcoming";
}

type AgendaIntent = NonNullable<ReturnType<typeof flexibleTrainingAgenda>["intents"]>[number];

function toPlanWeekRun(intent: AgendaIntent): PlanWeekRun {
  const completed = intent.status === "completed";
  const loggedKm = intent.completion?.distance_km;
  const targetKm = intent.target_distance_km;
  const km =
    completed && loggedKm != null && Number.isFinite(Number(loggedKm))
      ? Math.round(Number(loggedKm) * 10) / 10
      : targetKm != null && Number.isFinite(Number(targetKm))
        ? Math.round(Number(targetKm) * 10) / 10
        : null;
  return {
    kind: String(intent.kind),
    label: String(intent.label || `${intent.kind} run`),
    status: completed ? "completed" : "open",
    suggested_date: intent.suggested_date ? String(intent.suggested_date) : null,
    completion_date: intent.completion?.date ? String(intent.completion.date) : null,
    km,
    ...(!completed && intent.adjustment?.dose === "rest" ? { rested: true as const } : {}),
  };
}


const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven"];
function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/**
 * The strip's one spoken line: what the week holds so far and what is still open.
 * Composed from counts, so a stable week never prints one literal for a month.
 */
function progressLine(
  p: Omit<PlanWeekProgress, "line">,
  asOf: string,
  weekStart: string,
  units: DistanceUnit
): string | null {
  const parts: string[] = [];
  const weekOpened = asOf >= weekStart;
  if (p.lift_days_planned != null && p.lift_days_planned > 0) {
    if (p.lift_days_done >= p.lift_days_planned) {
      parts.push(`All ${countWord(p.lift_days_planned)} lifting days are in.`);
    } else if (p.lift_days_done > 0) {
      parts.push(`${cap(countWord(p.lift_days_done))} of ${countWord(p.lift_days_planned)} lifting days in.`);
    } else if (weekOpened) {
      parts.push(`First of ${countWord(p.lift_days_planned)} lifting days still ahead.`);
    }
  } else if (p.lift_days_done > 0) {
    parts.push(
      `${cap(countWord(p.lift_days_done))} lifting ${p.lift_days_done === 1 ? "session" : "sessions"} logged.`
    );
  }
  if (p.runs_done > 0) {
    const longest =
      p.longest_run_km != null && p.runs_done > 1 && p.longest_run_km >= 8
        ? `, ${distanceWords(p.longest_run_km, units)} the longest`
        : "";
    parts.push(
      `${distanceWords(p.run_km, units)} run over ${countWord(p.runs_done)} ${p.runs_done === 1 ? "run" : "runs"}${longest}.`
    );
  }
  const dated = p.runs_open.filter((r) => r.weekday);
  if (dated.length === 1) {
    parts.push(`${cap(dated[0].label)} still open — ${dated[0].weekday} looks cleanest.`);
  } else if (dated.length > 1) {
    parts.push(`Still open: ${dated.map((r) => `${r.label.toLowerCase()} ${r.weekday}`).join(", ")}.`);
  } else if (p.runs_open.length) {
    const r = p.runs_open[0];
    parts.push(`${cap(r.label)} still open, no clean day left this week — it carries no catch-up.`);
  }
  if (p.prs > 0) {
    parts.push(`${cap(countWord(p.prs))} new ${p.prs === 1 ? "best" : "bests"} in the last seven days.`);
  }
  return parts.length ? parts.join(" ") : null;
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * The Plan tab's week projection. Calendar Mon→Sun when a lift schedule maps
 * weekdays; otherwise template day_number order with weekday:null.
 *
 * A DONE cell belongs to the session that was logged on it — linked plan day, or
 * the day resolved off what was lifted — never to the projected ring, which is a
 * forecast and can be a day off from what the athlete actually chose. A run cell
 * belongs to the agenda intent dated on it; the template only lends a name.
 */
export function planWeek(date?: string): PlanWeek {
  const asOf = String(date || localDateISO()).slice(0, 10);
  const weekStart = mondayOf(asOf);
  const weekEnd = addDaysISO(weekStart, 6) ?? asOf;

  const lifting = strengthScheduleRead(asOf);
  const runDows = statedRunDows();
  const statedRunKinds = new Map<number, string>(
    (() => {
      try {
        return (getEnduranceSchedule()?.days ?? []).map((day) => [day.dow, String(day.kind)] as [number, string]);
      } catch {
        return [];
      }
    })()
  );
  const schedule = {
    lift_days: statedWeekdayNames(lifting.days.map((d) => d.dow)),
    lift_days_source: lifting.source,
    run_days: statedWeekdayNames(runDows),
  };

  let agenda: ReturnType<typeof flexibleTrainingAgenda> | null = null;
  try {
    agenda = flexibleTrainingAgenda(asOf);
  } catch {
    agenda = null;
  }
  const intents: AgendaIntent[] = agenda?.available && Array.isArray(agenda.intents) ? agenda.intents : [];

  const { map } = thisWeekPlanDayMap(asOf);
  const weekdayMap = new Map([...map].map(([dow, candidate]) => [dow, candidate.day_number]));

  let layoutRead: ReturnType<typeof weekLayoutRead> | null = null;
  try {
    // Judged on the CALENDAR when the lifting week maps it — the strip and this line
    // must be talking about the same Friday.
    layoutRead = weekLayoutRead(asOf, {
      agenda,
      strengthDows: lifting.days.map((d) => d.dow),
      liftDaysSource: lifting.source,
      enduranceDows: runDows,
      weekdayMap,
      // The strip's own done cells: a suggestion only ever involves the days ahead.
      closed: weekLayoutClosed(asOf, { agenda }),
    });
  } catch {
    layoutRead = null;
  }

  const template = (getPlanWithPurpose(asOf) as Record<string, unknown>[]).map(asTemplateDay);
  const byNumber = new Map(template.map((d) => [d.day_number, d]));
  const sessions = weekSessions(weekStart, weekEnd);

  const heavyLower = new Set<number>();
  try {
    for (const g of planDayStrengthGroups()) {
      if (g.heavy_lower) heavyLower.add(g.day_number);
    }
  } catch {
    /* ignore */
  }

  // Today's lift, in the ONE line every surface prints (the Brief, the Session header,
  // the Train card, Horizon). Read before the cells are laid so today's cell names the
  // same plan day the line does — the weekday map is the week's forecast, and the
  // adaptive selection may hand today a different strength day (the legs still carrying
  // a long run turn a lower day into the upper one). Two names for one morning was the
  // 2026-10-06 bug: the strip said "Lower B" under a Train card saying "Push".
  const strengthLine = (() => {
    try {
      return todayStrengthLine(asOf);
    } catch {
      return null;
    }
  })();
  const lineDayNumber = strengthLineDayNumber(strengthLine);

  let todayDayNumber: number | null = lineDayNumber;
  if (todayDayNumber == null) {
    try {
      todayDayNumber = selectAdaptivePlanDay(asOf)?.day_number ?? null;
    } catch {
      todayDayNumber = null;
    }
  }

  // Which plan day sits on which date — the ONE placement the race build's leg map also
  // reads (src/repo/week-strength-placement.ts): the log owns a logged date, today names
  // the strength line's day, and when that line handed today a different day than the
  // map laid, the two trade places (2026-10-20: a morning run turned Tuesday's Lower into
  // Push B, and Friday read Push B too).
  const placement = weekStrengthPlacement(asOf, { map, sessions, strengthLine });
  const movedTo = placement.moved_to;
  const moves = placement.moves;
  const unplaced: PlanWeekUnplaced[] = [];
  for (const u of placement.unplaced) {
    const templateDay = byNumber.get(u.day_number);
    if (!templateDay) continue;
    const name = toPlanWeekPlanDay(templateDay).name;
    const set = u.key_runs ? UNPLACED_KEY_RUNS : UNPLACED_NO_SLOT;
    const text = pickDayVariant(set, asOf, `plan_week_unplaced:${u.key_runs ? "key_runs" : "no_slot"}`)(name);
    unplaced.push({ day_number: u.day_number, name, text });
  }

  const isHard = (plan_day: PlanWeekPlanDay | null, run: PlanWeekRun | null): boolean =>
    !!(plan_day && heavyLower.has(plan_day.day_number)) || !!(run && (run.kind === "quality" || run.kind === "long"));

  const days: PlanWeekDay[] = [];
  // The log is the truth for "did": a run logged on a day the agenda closed no intent
  // for still happened, and belongs on that day's cell.
  const through = asOf < weekEnd ? asOf : weekEnd;
  const runLog = weekRunLog(weekStart, through);

  // A running-only athlete (no strength template at all) still has a week: the stated
  // run days, the agenda's runs and the log sit on the calendar, and every other day is
  // rest. Template mode would have no rows to walk, and an empty strip reads as nothing
  // planned rather than as the running week it is.
  const runningOnly = template.length === 0 && (runDows.length > 0 || intents.length > 0 || runLog.length > 0);
  if (map.size > 0 || runningOnly) {
    // Calendar mode — one cell per weekday Mon→Sun.
    for (let offset = 0; offset < 7; offset++) {
      const cellDate = addDaysISO(weekStart, offset) ?? weekStart;
      const dow = isoDow(cellDate);
      const sessionRow = sessionForDate(sessions, cellDate);
      // The logged session owns its cell. A session the resolver cannot place on the
      // plan (a freestyle day, a session on the rest day) shows as itself, with no
      // plan-day name borrowed from the forecast. Today, nothing logged yet, on a
      // lifting weekday: the cell names the strength line's day, and the map's own day
      // rides along as `swapped_from` when they differ.
      const placed = placement.on(cellDate);
      const mappedDay =
        placed && !placed.logged && placed.mapped_day_number != null ? (byNumber.get(placed.mapped_day_number) ?? null) : null;
      const templateDay: TemplateDay | null =
        (placed?.day_number != null ? byNumber.get(placed.day_number) : null) ?? (placed?.logged ? null : mappedDay);
      const plan_day = templateDay ? toPlanWeekPlanDay(templateDay) : null;
      if (plan_day && mappedDay && mappedDay.day_number !== plan_day.day_number) {
        const mapped = toPlanWeekPlanDay(mappedDay);
        plan_day.swapped_from = { day_number: mapped.day_number, name: mapped.name };
      }
      // The focus as it reads on THIS date: a stored "on the threshold-run day" written
      // for another layout never rides onto a weekday it is not true of.
      if (plan_day) plan_day.focus = datedPlanDayFocus(plan_day.focus, cellDate);
      const session = sessionRow ? toPlanWeekSession(sessionRow) : null;
      // Runs are dated by the agenda: a completion on this date, or an open intent
      // suggested for it. An intent with no date stays off the calendar — putting it
      // on a mapped cell would invent the very date the agenda declined to name.
      const intent =
        intents.find((i) => i.completion?.date && String(i.completion.date) === cellDate) ??
        intents.find((i) => i.status === "open" && i.suggested_date && String(i.suggested_date) === cellDate) ??
        null;
      let run = intent ? toPlanWeekRun(intent) : null;
      if (!run) {
        const logged = runLog.filter((r) => r.date === cellDate);
        if (logged.length) {
          const km = logged.reduce<number | null>((sum, r) => (r.km == null ? sum : (sum ?? 0) + r.km), null);
          run = {
            kind: "logged",
            label: "Run",
            status: "completed",
            suggested_date: null,
            completion_date: cellDate,
            km: km == null ? null : Math.round(km * 10) / 10,
          };
        }
      }
      // A stated run weekday whose run already happened elsewhere this week (the long
      // run landed Thursday) must not read "Up next" on Saturday. Carry the completed
      // intent so the cell can say "done Thu", and hold the cell OPEN rather than upcoming.
      const statedKind = map.has(dow) ? null : (statedRunKinds.get(dow) ?? null);
      let covered = false;
      if (!run && !session && statedKind && cellDate >= asOf) {
        const kind = statedKind === "long" || statedKind === "quality" ? statedKind : "easy";
        const done = intents.find((i) => i.status === "completed" && String(i.kind) === kind);
        const stillOpen = intents.some((i) => i.status === "open" && String(i.kind) === kind);
        if (done && !stillOpen) {
          run = toPlanWeekRun(done);
          covered = true;
        }
      }
      // No lift mapped here and no run dated here (nothing logged, nothing the agenda
      // suggests, nothing covered): the calendar's rest day. No plan row stands for it —
      // including a stated run weekday the week's run did not land on ("Saturday or
      // Sunday" long run placed on Sunday).
      const restDay = !plan_day && !session && !run && !map.has(dow);
      days.push({
        date: cellDate,
        weekday: shortWeekday(dow),
        dow,
        status: covered
          ? "open"
          : statusForCell({ date: cellDate, asOf, planDay: plan_day, session, run, todayDayNumber, restDay }),
        plan_day,
        session,
        run,
        hard: isHard(plan_day, run),
        travel: null,
      });
    }
  } else {
    // Template mode — no invented weekdays. A cell whose own unfinished session is
    // dated today already reads "today" (statusForCell's session rule); the
    // todayDayNumber fallback below must not also crown a second cell "today" for
    // whichever day number the ring points at — the log outranks it.
    // Every session this week holds a cell (one with no plan day to sit on gets its own,
    // below), so an unfinished one today always IS the today cell.
    const todayClaimedBySession = sessions.some((s) => s.date === asOf && !s.finished);
    const taken = new Set<number>();
    for (const templateDay of template) {
      const plan_day = toPlanWeekPlanDay(templateDay);
      const session = sessionForPlanDay(sessions, plan_day.day_number, taken);
      const intent = intents.find((i) => Number(i.provisional_day_number) === plan_day.day_number) ?? null;
      const run = intent ? toPlanWeekRun(intent) : null;
      days.push({
        date: null,
        weekday: null,
        dow: null,
        status: statusForCell({
          date: null,
          asOf,
          planDay: plan_day,
          session,
          run,
          todayDayNumber,
          todayClaimedBySession,
        }),
        plan_day,
        session,
        run,
        hard: isHard(plan_day, run),
        travel: null,
      });
    }
    // A session the plan cannot place (nothing it lifted is on any plan day), or a second
    // one on a day already holding one, still happened: it shows as itself, after the
    // plan's days, and never disappears from the week.
    for (const row of sessions) {
      if (taken.has(row.id)) continue;
      taken.add(row.id);
      const session = toPlanWeekSession(row);
      days.push({
        date: null,
        weekday: null,
        dow: null,
        status: statusForCell({ date: null, asOf, planDay: null, session, run: null, todayDayNumber }),
        plan_day: null,
        session,
        run: null,
        hard: false,
        travel: null,
      });
    }
  }

  // ---- the week so far, in counts ----
  const runKm = runLog.reduce((sum, r) => sum + (r.km ?? 0), 0);
  const longest = runLog.reduce<number | null>(
    (best, r) => (r.km != null && (best == null || r.km > best) ? r.km : best),
    null
  );
  let prs = 0;
  try {
    prs = weekWins(asOf).prs.length;
  } catch {
    prs = 0;
  }
  const liftDows = lifting.days.map((d) => d.dow);
  const counts: Omit<PlanWeekProgress, "line"> = {
    // A lifting day is "in" when its cell reads done: a finished session, or any
    // logged session on a day already over. Today's open session is in progress —
    // counting it here said "Two of five in" over a cell that says "In progress".
    lift_days_done: new Set(sessions.filter((s) => s.finished || s.date !== asOf).map((s) => s.date)).size,
    lift_days_planned: liftDows.length ? liftDows.length : null,
    runs_done: runLog.length,
    run_km: Math.round(runKm * 10) / 10,
    longest_run_km: longest == null ? null : Math.round(longest * 10) / 10,
    // A run this morning rested is not "still open": the read already answered it
    // (no run today), and listing "rest or an easy walk Tuesday" beside the week's
    // real openings read as a run still owed. It simply drops out of the line.
    runs_open: intents
      .filter((i) => i.status === "open" && i.adjustment?.dose !== "rest")
      .map((i) => ({
        kind: String(i.kind),
        label: String(i.label || `${i.kind} run`),
        suggested_date: i.suggested_date ? String(i.suggested_date) : null,
        weekday: i.suggested_date ? (WEEKDAY_NAMES[isoDow(String(i.suggested_date))] ?? null) : null,
      })),
    prs,
  };
  const runUnits = weekRunUnits();
  const progress: PlanWeekProgress = {
    ...counts,
    line: days.length ? progressLine(counts, asOf, weekStart, runUnits) : null,
  };

  const summary =
    layoutRead && !layoutRead.clean && layoutRead.suggestion
      ? layoutRead.suggestion
      : schedule.lift_days.length || runningOnly
        ? null
        : days.length
          ? "Your training week in plan order — say which weekdays you lift and the strip will sit on the calendar."
          : null;

  // One day, one voice: the cell that IS today carries the line's own suggestion. The
  // line has already decided whether one applies (a lift not yet logged, a quiet read).
  if (strengthLine?.suggestion && strengthLine.suggestion_label) {
    const todayCell = days.find(
      (cell) =>
        cell.status === "today" &&
        (cell.date === asOf ||
          (cell.date == null &&
            cell.plan_day?.day_number != null &&
            cell.plan_day.day_number === strengthLine.day_number))
    );
    if (todayCell) {
      todayCell.suggestion = {
        kind: strengthLine.suggestion,
        label: strengthLine.suggestion_label,
        caveat: strengthLine.caveat,
      };
    }
  }

  // Away dates, said on the cell (the plan itself is untouched — a trip is information).
  try {
    const away = travelDaysIn(weekStart, weekEnd);
    for (const cell of days) cell.travel = cell.date ? (away.get(cell.date) ?? null) : null;
  } catch {
    for (const cell of days) cell.travel = null;
  }

  // The race build's leg trim on each lift day still ahead — read ONCE per cell, through
  // the one dated trim read (planDayLegTrimOn: this morning's envelope, else the stress
  // budget's calendar half). The cell's focus says it the way the day page and the
  // today line do (legTrimFocus), so Train's strip and the day page read one day; the
  // note below composes it with any swap / move on the same cell.
  const trims = new Map<string, LegTrim>();
  for (const cell of days) {
    const planDay = cell.plan_day;
    if (!planDay || planDay.role !== "strength" || !cell.date || cell.date < asOf || cell.status === "done") continue;
    let trim: LegTrim | null = null;
    try {
      trim = planDayLegTrimOn(cell.date, planDay.day_number, {
        today: asOf,
        planItems: byNumber.get(planDay.day_number)?.items ?? [],
      });
    } catch {
      trim = null;
    }
    if (!trim) continue;
    trims.set(cell.date, trim);
    planDay.focus = legTrimFocus(planDay.focus, trim, cell.date);
  }

  // Why a day differs from its usual slot — one line per cell. Garnish: the week
  // stands without it, so an unreadable input drops the note, never the strip.
  try {
    attachPlanWeekNotes(days, { asOf, strengthLine, byNumber, movedTo, moves, trims });
  } catch {
    /* no notes */
  }

  return {
    as_of: asOf,
    week_start: weekStart,
    days,
    summary,
    progress,
    layout: {
      clean: layoutRead ? layoutRead.clean : true,
      suggestion: layoutRead?.suggestion ?? null,
    },
    schedule,
    strength_line: strengthLine,
    run_units: runUnits,
    unplaced,
  };
}

// ---------- the cell note: why this day differs from its usual slot ----------
//
// Every reason is READ, never re-derived: the swap is today's one strength line against
// the weekday map (and the selection's own reason, plan-selection.ts), the bump is the
// trade the strip already made above, the leg trim is the one dated trim read
// (planDayLegTrimOn, plan-day-trim.ts) in the one trim wording (legTrimNote,
// plan-day-focus.ts), and the trip is travel-days.ts. A cell that is BOTH swapped / moved
// and trimmed keeps one note, its lead fact closed with the trim's clause
// (withLegTrimClause) — "Lower lands here this week, lighter for the taper." — so the
// taper is never lost behind the move. A stable week fires the same rule for days, so every
// line is a variant set rotated by date (pickDayVariant). Suggestion voice: a trip day
// is the athlete's to skip, a trim is a lighter dose, never a gate.

const SWAP_WITH_REASON: ReadonlyArray<(day: string, mapped: string, reason: string) => string> = [
  (day, mapped, reason) => `${day} in place of ${mapped} — ${reason}.`,
  (day, mapped, reason) => `Today is ${day} rather than ${mapped}: ${reason}.`,
  (day, mapped, reason) => `${day} today instead of ${mapped} — ${reason}.`,
];
const SWAP_PLAIN: ReadonlyArray<(day: string, mapped: string) => string> = [
  (day, mapped) => `${day} today in place of ${mapped}.`,
  (day, mapped) => `Today is ${day} rather than ${mapped}.`,
  (day, mapped) => `${day} steps in for ${mapped} today.`,
];
const AFTER_RUN: ReadonlyArray<(day: string) => string> = [
  (day) => `${day} today, since you've already run.`,
  (day) => `${day} today — the run is already in.`,
  (day) => `With the run already in, today is ${day}.`,
];
const MOVES_TO: ReadonlyArray<(mapped: string, weekday: string) => string> = [
  (mapped, weekday) => `${mapped} moves to ${weekday}.`,
  (mapped, weekday) => `${mapped} shifts to ${weekday}.`,
  (mapped, weekday) => `${mapped} picks up on ${weekday}.`,
];
const MOVED_HERE: ReadonlyArray<(mapped: string, from: string, day: string) => string> = [
  (mapped, from, day) => `${mapped} moved here from ${from}, which went to ${day}.`,
  (mapped, from, day) => `${mapped} lands here this week — ${from} went to ${day}.`,
  (mapped, from, day) => `Moved from ${from}: ${day} took that day, so ${mapped} is here.`,
];
// The moved day that is also trimmed: one sentence, the move then the trim's clause.
// A displaced day with no later weekday to take it: said, never silently dropped — and
// the athlete's to place, never a gate.
const UNPLACED_KEY_RUNS: ReadonlyArray<(name: string) => string> = [
  (name) => `${name} didn't fit this week — the key runs took its days. Say the word and I'll find it a spot.`,
  (name) => `The key runs left no clean day for ${name} this week. Say the word and I'll find it a spot.`,
  (name) => `${name} has no open day left around this week's key runs. Say the word and I'll find it a spot.`,
];
const UNPLACED_NO_SLOT: ReadonlyArray<(name: string) => string> = [
  (name) => `${name} didn't fit this week — the other days are spoken for. Say the word and I'll find it a spot.`,
  (name) => `No open day is left for ${name} this week. Say the word and I'll find it a spot.`,
  (name) => `${name} has no day left this week. Say the word and I'll find it a spot.`,
];

// A moved day whose date was taken by a session that names no plan day.
const MOVED_HERE_PLAIN: ReadonlyArray<(mapped: string, from: string) => string> = [
  (mapped, from) => `${mapped} moved here from ${from}.`,
  (mapped, from) => `${mapped} lands here this week, moved from ${from}.`,
  (mapped, from) => `Moved from ${from}, so ${mapped} is here.`,
];
const MOVED_HERE_PLAIN_TRIMMED: ReadonlyArray<(mapped: string, from: string, clause: string) => string> = [
  (mapped, from, clause) => `${mapped} moved here from ${from}, ${clause}.`,
  (mapped, _from, clause) => `${mapped} lands here this week, ${clause}.`,
  (mapped, from, clause) => `Moved from ${from}, ${mapped} is here, ${clause}.`,
];
const MOVED_HERE_TRIMMED: ReadonlyArray<(mapped: string, from: string, day: string, clause: string) => string> = [
  (mapped, from, _day, clause) => `${mapped} moved here from ${from}, ${clause}.`,
  (mapped, _from, _day, clause) => `${mapped} lands here this week, ${clause}.`,
  (mapped, from, day, clause) => `${from} went to ${day}, so ${mapped} is here, ${clause}.`,
];
const TRIP_DAY: ReadonlyArray<(day: string, where: string | null) => string> = [
  (_day, where) => `Trip day${where ? ` (${where})` : ""} — lift if you can, skip it freely.`,
  (day, where) => `You're away${where ? ` in ${where}` : ""} — ${day} is there if it fits, and fine to skip.`,
  (day) => `Travel day: ${day} if the day allows, and no catch-up if not.`,
];

interface NoteContext {
  asOf: string;
  strengthLine: TodayStrengthLine | null;
  byNumber: Map<number, TemplateDay>;
  movedTo: string | null;
  /** Every displaced day the placement re-placed (week-strength-placement.ts), today's included. */
  moves: readonly PlacementMove[];
  /** The leg trim per lift-day date still ahead (planDayLegTrimOn), read once by planWeek. */
  trims: Map<string, LegTrim>;
}

function weekdayName(iso: string): string {
  return WEEKDAY_NAMES[isoDow(iso)] ?? iso;
}

// The selection's own athlete-facing reason for today's swap (plan-selection.ts
// selectionReason) — its lead clause only: a strip cell names why, not an inventory.
function swapReason(asOf: string, dayNumber: number): string | null {
  try {
    const selected = selectedPlanDayForDate(asOf);
    if (!selected || Number(selected.selection?.selected?.day_number ?? selected.day_number) !== dayNumber) return null;
    const raw = String(selected.selection?.reason ?? "").trim();
    if (!raw) return null;
    const lead = raw
      .split(/,\s+while\s+/)[0]
      .replace(/[.;:,\s]+$/, "")
      .trim();
    return lead || null;
  } catch {
    return null;
  }
}

function attachPlanWeekNotes(days: PlanWeekDay[], ctx: NoteContext): void {
  const { asOf } = ctx;

  // 1. The swap on today's cell, and the bumped day's new weekday on both cells.
  const today = days.find((cell) => cell.date === asOf && cell.plan_day?.swapped_from);
  if (today?.plan_day?.swapped_from) {
    const day = today.plan_day.name;
    const mapped = today.plan_day.swapped_from.name;
    const movedCell = ctx.movedTo ? days.find((cell) => cell.date === ctx.movedTo) : null;
    const movedLanded =
      !!movedCell?.date &&
      !!movedCell.plan_day &&
      movedCell.plan_day.day_number === today.plan_day.swapped_from.day_number;
    const ranToday = !!ctx.strengthLine?.run_in;
    let lead: string;
    if (ranToday) {
      lead = pickDayVariant(AFTER_RUN, asOf, "plan_week_note:after_run")(day);
    } else {
      const reason = swapReason(asOf, today.plan_day.day_number);
      lead = reason
        ? pickDayVariant(SWAP_WITH_REASON, asOf, "plan_week_note:swap_reason")(day, mapped, reason)
        : pickDayVariant(SWAP_PLAIN, asOf, "plan_week_note:swap")(day, mapped);
    }
    const moves =
      movedLanded && movedCell?.date
        ? ` ${pickDayVariant(MOVES_TO, asOf, "plan_week_note:moves_to")(mapped, weekdayName(movedCell.date))}`
        : "";
    // Today's day trimmed too (the morning's envelope, or the taper's calendar trim):
    // the lead closes with the trim, still one note.
    const todayTrim = ctx.trims.get(asOf) ?? null;
    if (todayTrim) lead = withLegTrimClause(lead, todayTrim, asOf);
    today.plan_day.note = { kind: ranToday ? "after_run" : "swap", text: `${lead}${moves}` };
    if (movedLanded && movedCell?.plan_day && movedCell.date) {
      const movedTrim = ctx.trims.get(movedCell.date) ?? null;
      const clause = movedTrim ? legTrimClause(movedTrim, movedCell.date) : null;
      movedCell.plan_day.note = {
        kind: "moved",
        text: clause
          ? pickDayVariant(MOVED_HERE_TRIMMED, movedCell.date, "plan_week_note:moved")(mapped, weekdayName(asOf), day, clause)
          : pickDayVariant(MOVED_HERE, movedCell.date, "plan_week_note:moved")(mapped, weekdayName(asOf), day),
      };
    }
  }

  // 1b. Every other displaced day where it landed: a day logged in place of the one the
  // map laid (2026-10-20: Push B logged on Tuesday's Lower put Lower on Friday). The cell
  // that took the date is done, and says nothing; the cell the day landed on says why.
  for (const move of ctx.moves) {
    const movedCell = days.find((cell) => cell.date === move.to_date);
    const planDay = movedCell?.plan_day;
    if (!movedCell?.date || !planDay || planDay.note || planDay.day_number !== move.day_number) continue;
    if (movedCell.status === "done") continue;
    const fromCell = days.find((cell) => cell.date === move.from_date);
    const tookIt = fromCell?.session?.title || fromCell?.plan_day?.name || null;
    const from = weekdayName(move.from_date);
    const trim = ctx.trims.get(movedCell.date) ?? null;
    const clause = trim ? legTrimClause(trim, movedCell.date) : null;
    const key = "plan_week_note:moved";
    const text = tookIt
      ? clause
        ? pickDayVariant(MOVED_HERE_TRIMMED, movedCell.date, key)(planDay.name, from, tookIt, clause)
        : pickDayVariant(MOVED_HERE, movedCell.date, key)(planDay.name, from, tookIt)
      : clause
        ? pickDayVariant(MOVED_HERE_PLAIN_TRIMMED, movedCell.date, key)(planDay.name, from, clause)
        : pickDayVariant(MOVED_HERE_PLAIN, movedCell.date, key)(planDay.name, from);
    planDay.note = { kind: "moved", text };
  }

  // 2. The race build's leg trim, then 3. a trip day — on the lift days still ahead.
  for (const cell of days) {
    const planDay = cell.plan_day;
    if (!planDay || planDay.note || planDay.role !== "strength" || !cell.date || cell.date < asOf) continue;
    if (cell.status === "done") continue;
    // The leg trim in the one wording every dated plan day prints (plan-day-focus.ts),
    // read once above off the one trim read (plan-day-trim.ts).
    const trimText = legTrimNote(planDay.name, ctx.trims.get(cell.date) ?? null, cell.date);
    if (trimText) {
      planDay.note = { kind: "taper", text: trimText };
      continue;
    }
    if (cell.travel) {
      planDay.note = {
        kind: "trip",
        text: pickDayVariant(TRIP_DAY, cell.date, "plan_week_note:trip")(planDay.name, cell.travel.location),
      };
    }
  }
}

/** The athlete's run units (athleteUnits(), km when settings cannot be read). */
function weekRunUnits(): DistanceUnit {
  return athleteUnits().distance;
}
