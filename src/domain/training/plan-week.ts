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
import { addDaysISO, mondayOf } from "../../lib/dates.js";
import { statedWeekdayNames, weekLayoutRead } from "./week-layout.js";
import { planItemsOutOfOrder } from "./plan-item-order.js";
import { flexibleTrainingAgenda } from "../../repo/flexible-training-agenda.js";
import { getEnduranceSchedule, statedRunDows, WEEKDAY_NAMES, isoDow } from "../../repo/profile.js";
import {
  planDayCandidates,
  planDayRole,
  resolveSessionPlanDay,
  selectAdaptivePlanDay,
  thisWeekPlanDayMap,
  type WeekdayPlanDayRole,
} from "../../repo/plan-selection.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "../../repo/endurance-sports.js";
import { withoutShadowActivities } from "../../repo/activity-shadow.js";
import { weekWins } from "../../repo/sessions.js";
import { getPlanWithPurpose } from "../../repo/day-read.js";
import { strengthScheduleRead } from "../../repo/strength-schedule.js";
import { localDateISO } from "../../repo/shared.js";
import { deriveSessionTitle, planDayStrengthGroups } from "../../repo/training-read.js";
import { todayStrengthLine, type TodayStrengthLine } from "../../repo/today-strength-line.js";

export type PlanWeekStatus = "done" | "today" | "upcoming" | "rest" | "open";

export interface PlanWeekPlanDay {
  day_number: number;
  name: string;
  focus: string | null;
  purpose: string | null;
  day_type: "training" | "rest";
  role: WeekdayPlanDayRole;
  out_of_order: boolean;
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

type WeekSessionRow = {
  id: number;
  date: string;
  plan_day_id: number | null;
  day_number: number | null;
  day_name: string | null;
  finished: boolean;
  /** The plan day this session actually WAS — linked, or resolved off what was lifted. */
  resolved_day_number: number | null;
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
    name: String(day.name || `Day ${day.day_number}`),
    focus: day.focus ?? null,
    purpose: day.purpose ?? null,
    day_type,
    role,
    out_of_order: planItemsOutOfOrder((day.items ?? []) as any[]),
  };
}

function weekSessions(weekStart: string, weekEnd: string): WeekSessionRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.date AS date, s.plan_day_id AS plan_day_id,
                pd.day_number AS day_number, pd.name AS day_name,
                s.finished_at AS finished_at
           FROM sessions s
           LEFT JOIN plan_days pd ON pd.id = s.plan_day_id
          WHERE s.date >= ? AND s.date <= ?
            AND EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id)
          ORDER BY s.date ASC, s.id ASC`
      )
      .all(weekStart, weekEnd) as any[];
    let candidates: ReturnType<typeof planDayCandidates> = [];
    try {
      candidates = planDayCandidates();
    } catch {
      candidates = [];
    }
    return rows.map((r) => {
      const id = Number(r.id);
      const plan_day_id = r.plan_day_id == null ? null : Number(r.plan_day_id);
      let resolved_day_number: number | null = null;
      try {
        resolved_day_number = resolveSessionPlanDay(id, plan_day_id, candidates)?.day_number ?? null;
      } catch {
        resolved_day_number = null;
      }
      return {
        id,
        date: String(r.date),
        plan_day_id,
        day_number: r.day_number == null ? null : Number(r.day_number),
        day_name: r.day_name == null ? null : String(r.day_name),
        finished: !!r.finished_at,
        resolved_day_number,
      };
    });
  } catch {
    return [];
  }
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

function sessionForDate(rows: WeekSessionRow[], date: string): WeekSessionRow | null {
  return rows.find((r) => r.date === date) ?? null;
}

function toPlanWeekSession(hit: WeekSessionRow): PlanWeekSession {
  return {
    id: hit.id,
    title: deriveSessionTitle(hit.id, hit.plan_day_id, hit.day_name),
    date: hit.date,
    finished: hit.finished,
  };
}

function sessionForPlanDay(rows: WeekSessionRow[], dayNumber: number): PlanWeekSession | null {
  const hit = rows.find((r) => (r.resolved_day_number ?? r.day_number) === dayNumber);
  return hit ? toPlanWeekSession(hit) : null;
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
  };
}

function fmtKm(km: number): string {
  return Number.isInteger(km) ? String(km) : km.toFixed(1);
}

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven"];
function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/**
 * The strip's one spoken line: what the week holds so far and what is still open.
 * Composed from counts, so a stable week never prints one literal for a month.
 */
function progressLine(p: Omit<PlanWeekProgress, "line">, asOf: string, weekStart: string): string | null {
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
        ? `, ${fmtKm(p.longest_run_km)} km the longest`
        : "";
    parts.push(
      `${fmtKm(p.run_km)} km run over ${countWord(p.runs_done)} ${p.runs_done === 1 ? "run" : "runs"}${longest}.`
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

  let todayDayNumber: number | null = null;
  try {
    todayDayNumber = selectAdaptivePlanDay(asOf)?.day_number ?? null;
  } catch {
    todayDayNumber = null;
  }

  const isHard = (plan_day: PlanWeekPlanDay | null, run: PlanWeekRun | null): boolean =>
    !!(plan_day && heavyLower.has(plan_day.day_number)) || !!(run && (run.kind === "quality" || run.kind === "long"));

  const days: PlanWeekDay[] = [];
  // The log is the truth for "did": a run logged on a day the agenda closed no intent
  // for still happened, and belongs on that day's cell.
  const through = asOf < weekEnd ? asOf : weekEnd;
  const runLog = weekRunLog(weekStart, through);

  if (map.size > 0) {
    // Calendar mode — one cell per weekday Mon→Sun.
    for (let offset = 0; offset < 7; offset++) {
      const cellDate = addDaysISO(weekStart, offset) ?? weekStart;
      const dow = isoDow(cellDate);
      const sessionRow = sessionForDate(sessions, cellDate);
      // The logged session owns its cell. A session the resolver cannot place on the
      // plan (a freestyle day, a session on the rest day) shows as itself, with no
      // plan-day name borrowed from the forecast.
      let templateDay: TemplateDay | null;
      if (sessionRow) {
        templateDay =
          sessionRow.resolved_day_number != null ? (byNumber.get(sessionRow.resolved_day_number) ?? null) : null;
      } else {
        const candidate = map.get(dow) ?? null;
        templateDay = candidate ? (byNumber.get(candidate.day_number) ?? null) : null;
      }
      const plan_day = templateDay ? toPlanWeekPlanDay(templateDay) : null;
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
      });
    }
  } else {
    // Template mode — no invented weekdays. A cell whose own unfinished session is
    // dated today already reads "today" (statusForCell's session rule); the
    // todayDayNumber fallback below must not also crown a second cell "today" for
    // whichever day number the ring points at — the log outranks it.
    const todayClaimedBySession = sessions.some((s) => s.date === asOf && !s.finished);
    for (const templateDay of template) {
      const plan_day = toPlanWeekPlanDay(templateDay);
      const session = sessionForPlanDay(sessions, plan_day.day_number);
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
    runs_open: intents
      .filter((i) => i.status === "open")
      .map((i) => ({
        kind: String(i.kind),
        label: String(i.label || `${i.kind} run`),
        suggested_date: i.suggested_date ? String(i.suggested_date) : null,
        weekday: i.suggested_date ? (WEEKDAY_NAMES[isoDow(String(i.suggested_date))] ?? null) : null,
      })),
    prs,
  };
  const progress: PlanWeekProgress = { ...counts, line: days.length ? progressLine(counts, asOf, weekStart) : null };

  const summary =
    layoutRead && !layoutRead.clean && layoutRead.suggestion
      ? layoutRead.suggestion
      : schedule.lift_days.length
        ? null
        : days.length
          ? "Your training week in plan order — say which weekdays you lift and the strip will sit on the calendar."
          : null;

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
    strength_line: (() => {
      try {
        return todayStrengthLine(asOf);
      } catch {
        return null;
      }
    })(),
  };
}
