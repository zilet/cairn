// The welcome's first week, as the rest of the app sees it while it is being built and
// once, after, that it is ready. Two halves:
//
//   - status: read off the agent_jobs rows themselves — the running `welcome` job (or the
//     `compose_week` job a busy host handed its week to, `explicit_request`), whose phase
//     meta carries the days written so far (`days_so_far`, src/coachOps/welcome.ts);
//   - the one-shot "ready" notice: written when that job lands a week, cleared the first
//     time any surface shows it (or the person watched it land on the welcome itself).
//     Server-side, so a person who closed the app and came back later still hears it,
//     once, wherever they open it. Pull-never-push: an in-app line only, never an OS one.

import { getAppState, setAppState } from "./app-state.js";
import { listActiveAgentJobs } from "./chat.js";
import { canonicalGroup, classifyMuscleGroup, type MuscleGroup } from "./exercise-canon.js";
import { isHeavyLowerPlanDay, keyRunAwarePlacement, weekdayPlanDayMap } from "./plan-selection.js";
import { getEnduranceSchedule, statedLiftDows } from "./profile.js";
import { getSettings } from "./settings.js";

const NOTICE_KEY = "first_week_notice";
const MAX_DAYS = 7;

export interface FirstWeekDay {
  dow: number | null;
  day_number: number;
  name: string;
}

/** What GET /api/welcome/first-week answers (ClientFirstWeekStatus). */
export interface FirstWeekStatus {
  /** building: a welcome week is being composed now; ready: it landed and nobody has
   *  been told yet; failed: it could not be put together (told once, too); none. */
  state: "building" | "ready" | "failed" | "none";
  job_id: number | null;
  days: FirstWeekDay[];
  /** Where the week ended up: applied/announced (the plan) or draft (waits on Today). */
  week_state: string | null;
  /** Nothing is building and nothing is owed: a client may stop asking. */
  final: boolean;
}

interface Notice {
  job_id: number | null;
  state: "ready" | "failed";
  week_state: string | null;
  days: FirstWeekDay[];
  seen: boolean;
}

interface PreviewLift {
  day_number: number;
  name: string;
  day_type: "training";
  names: string[];
  groups: MuscleGroup[];
}

function groupsFor(items: any[]): MuscleGroup[] {
  const groups: MuscleGroup[] = [];
  for (const item of items) {
    const exercise = String(item?.exercise ?? "");
    const stored = item?.muscle_group == null || item.muscle_group === "" ? null : String(item.muscle_group);
    const group = canonicalGroup(stored) ?? classifyMuscleGroup(exercise);
    if (group && group !== "mobility" && !groups.includes(group)) groups.push(group);
  }
  return groups;
}

/** Quality and long run weekdays — the key runs a heavy-lower day keeps off. */
function statedKeyRunDows(): number[] {
  try {
    return (getEnduranceSchedule()?.days ?? [])
      .filter((day) => day.kind === "quality" || day.kind === "long")
      .map((day) => day.dow);
  } catch {
    return [];
  }
}

/**
 * Lay the welcome preview's strength days on the stated lifting weekdays, then trade a
 * heavy-lower day off a quality or long run (and the days beside them) with the same
 * `keyRunAwarePlacement` the live week uses. Nothing logged on a first week, so every
 * lifting weekday is still open — the same inputs the real week uses before a session
 * lands. No stated lifting weekdays: plan order, no weekday.
 */
export function placeFirstWeekLifts(days: any[] | null | undefined): FirstWeekDay[] | null {
  const lifting: PreviewLift[] = (Array.isArray(days) ? days : [])
    .filter((d) => Number.isFinite(Number(d?.day_number)) && Array.isArray(d?.items) && d.items.length > 0)
    .map((d) => ({
      day: d,
      items: d.items.filter((it: any) => String(it?.kind ?? "strength") !== "cardio"),
    }))
    .filter((d) => d.items.length > 0)
    .map((d) => ({
      day_number: Number(d.day.day_number),
      name: String(d.day.name || d.day.focus || `Day ${Number(d.day.day_number)}`)
        .trim()
        .slice(0, 60),
      day_type: "training" as const,
      names: d.items.map((it: any) => String(it?.exercise ?? "")),
      groups: groupsFor(d.items),
    }))
    .sort((a, b) => a.day_number - b.day_number);
  if (!lifting.length) return null;
  let liftDows: number[] = [];
  try {
    liftDows = statedLiftDows();
  } catch {
    liftDows = [];
  }
  if (!liftDows.length) {
    return lifting.map((d) => ({ dow: null, day_number: d.day_number, name: d.name }));
  }
  const dealt = weekdayPlanDayMap(lifting, liftDows);
  if (!dealt.size) {
    return lifting.map((d) => ({ dow: null, day_number: d.day_number, name: d.name }));
  }
  const placed = keyRunAwarePlacement(dealt, {
    keyRunDows: statedKeyRunDows(),
    open: dealt.keys(),
    isLower: (day) => isHeavyLowerPlanDay(day),
  }).map;
  return [...placed.entries()]
    .sort((a, b) => ((a[0] + 6) % 7) - ((b[0] + 6) % 7))
    .map(([dow, day]) => ({ dow, day_number: day.day_number, name: day.name }));
}

/**
 * The compact day rows, bounded: a day needs a name and a real plan day number; at most a
 * week of them. The reveal's week also carries run-only weekdays (`day_number: null`), and
 * Number(null) is 0 — those are not plan days, so they never reach this list.
 */
export function firstWeekDays(raw: unknown): FirstWeekDay[] {
  if (!Array.isArray(raw)) return [];
  const out: FirstWeekDay[] = [];
  for (const row of raw) {
    const name = typeof row?.name === "string" ? row.name.trim().slice(0, 60) : "";
    const value = row?.day_number;
    const n = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : Number.NaN;
    if (!name || !Number.isInteger(n) || n < 1) continue;
    const dow = Number.isInteger(row?.dow) && row.dow >= 0 && row.dow <= 6 ? Number(row.dow) : null;
    out.push({ dow, day_number: n, name });
    if (out.length >= MAX_DAYS) break;
  }
  return out;
}

function readNotice(): Notice | null {
  try {
    const raw = getAppState(NOTICE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      job_id: Number.isFinite(Number(parsed.job_id)) ? Number(parsed.job_id) : null,
      state: parsed.state === "failed" ? "failed" : "ready",
      week_state: typeof parsed.week_state === "string" ? parsed.week_state : null,
      days: firstWeekDays(parsed.days),
      seen: parsed.seen === true,
    };
  } catch {
    return null;
  }
}

/** The welcome's week job, while it runs: the welcome itself, or the compose job it handed off. */
function activeWeekJob(): any | null {
  const jobs = listActiveAgentJobs() as any[];
  for (let i = jobs.length - 1; i >= 0; i--) {
    const job = jobs[i];
    if (job?.kind === "welcome") return job;
    if (job?.kind === "compose_week" && job?.input?.explicit_request === true) return job;
  }
  return null;
}

export function firstWeekStatus(): FirstWeekStatus {
  const job = activeWeekJob();
  if (job) {
    return {
      state: "building",
      job_id: Number(job.id),
      days: firstWeekDays(job.meta?.days_so_far),
      week_state: null,
      final: false,
    };
  }
  const notice = readNotice();
  if (notice && !notice.seen) {
    return {
      state: notice.state,
      job_id: notice.job_id,
      days: notice.days,
      week_state: notice.week_state,
      final: false,
    };
  }
  let welcomed = false;
  try {
    welcomed = getSettings().coach_welcomed === true;
  } catch {
    welcomed = false;
  }
  return { state: "none", job_id: null, days: [], week_state: null, final: welcomed };
}

/**
 * A welcome (or its handed-off compose job) finished: record what became of the week so
 * the next surface that asks says so once. `existing`/`none` owe nothing (no new week);
 * `queued` is not an ending (its compose job records its own).
 */
export function recordFirstWeekOutcome(jobId: number, weekState: unknown, week: unknown): void {
  const ending = typeof weekState === "string" ? weekState : null;
  const state: Notice["state"] | null =
    ending === "applied" || ending === "announced" || ending === "draft"
      ? "ready"
      : ending === "failed"
        ? "failed"
        : null;
  if (!state) return;
  const notice: Notice = { job_id: jobId, state, week_state: ending, days: firstWeekDays(week), seen: false };
  setAppState(NOTICE_KEY, JSON.stringify(notice));
}

/** Somebody has been told (a notice shown, or the reveal watched): never again. */
export function markFirstWeekSeen(): FirstWeekStatus {
  const notice = readNotice();
  if (notice && !notice.seen) setAppState(NOTICE_KEY, JSON.stringify({ ...notice, seen: true }));
  return firstWeekStatus();
}
