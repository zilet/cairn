// THE DAYS AFTER A RACE — the ONE read of the post-race recovery window. Before this
// existed every race-scoped thing switched off the morning after the race (the race
// build, the stress budget's race read, the ramp) and lifting and the run engine
// resumed at full, as if the half marathon had been an ordinary Sunday.
//
// The athlete's rule (approved 2026-10-20): the window scales with the race distance,
// counted from race day + 1 —
//   up to 10 km           2 days
//   up to a half (21.1)   4 days
//   longer (marathon+)    7 days
// and it is NOT a rest block. He keeps training, at lower volume and not so heavy:
//   - lifting: every group on the card goes through the stress budget's ordinary
//     REDUCED list (`post_race_recovery`, stress-budget.ts) — composition's reduced-area
//     clamp, fewer sets at an eased load, never a progression step, never a reach host —
//     legs included but never excluded, and a push stance never widens inside it;
//   - running: easy and short only, no quality or long run (run-progression.ts);
//   - the day read stays a training day, said lighter (day-read.ts caveat);
//   - the surfaces say it once ("Recovering from …, back to full on Thu").
// When the window ends nothing lingers: every consumer reads THIS and nothing else, so
// the day after `ends_on` is an ordinary day again.
//
// WHICH race (race-results.ts): the race is the logged EFFORT — a run within two days of
// the goal date at ~its distance — never the goal's date by itself, and it outlives the
// goal slot: a new goal set the morning after keeps this window and this race day.
// Every reader below asks the candidates (each race kept in `completed_races`, plus the
// live goal's dated race) through one resolution:
//   - the window, as of a date: a run on or before it; a run BEFORE the goal date only
//     once the goal date has come; and, with nothing race-like logged yet, the goal date
//     PROVISIONALLY for RACE_DATE_SLACK_DAYS after it (a slow sync), then nothing;
//   - a race day for harm and capacity: in hindsight, the matched effort only — no
//     effort logged, nothing is blanked.
import { addDaysISO, daysBetweenISO } from "../lib/dates.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { getEnduranceGoal } from "./profile.js";
import {
  completedRaceRows,
  pickRaceEffort,
  RACE_DATE_SLACK_DAYS,
  raceLikeRuns,
  SHORT_RACE_MAX_KM,
  type RaceGoalRef,
  type RaceRun,
} from "./race-results.js";
import { copyDeep, requestMemo } from "./request-memo.js";
import { localDateISO } from "./shared.js";

export type RaceRecoveryKind = "short" | "half" | "marathon";

export interface RaceRecoveryWindow {
  /** `date` is the race EFFORT's day (the window counts from it), `goal_date` the goal's. */
  race: { event: string | null; date: string; distance_km: number; goal_date: string; provisional: boolean };
  /** 1 on the day after the race … `days` on the window's last day. */
  day_index: number;
  /** The window's length in days. */
  days: number;
  /** The window's last day (inclusive). */
  ends_on: string;
  /** The first ordinary day again (`ends_on` + 1). */
  back_on: string;
  kind: RaceRecoveryKind;
}

/** One race as resolved: its goal, and the day its effort was run. */
export interface RaceEffort extends RaceGoalRef {
  /** The race effort's day — the logged run's, or the goal date while provisional. */
  run_date: string;
  activity_id: number | null;
  run_km: number | null;
  /** True while nothing race-like is logged and the goal date stands in (slow sync). */
  provisional: boolean;
}

// The longest a run inside the window is planned: an easy, short shake-out.
export const POST_RACE_EASY_CAP_KM = 6;

// A whisker over each round distance, so a 10.0 km goal stays short and a 21.1 / 21.0975
// half stays a half.
const HALF_MAX_KM = 21.2;

/** The window length for a race distance: ≤10 km → 2, ≤ a half → 4, longer → 7. */
export function raceRecoveryShape(distanceKm: number): { days: number; kind: RaceRecoveryKind } | null {
  const km = Number(distanceKm);
  if (!Number.isFinite(km) || km <= 0) return null;
  if (km <= SHORT_RACE_MAX_KM) return { days: 2, kind: "short" };
  if (km <= HALF_MAX_KM) return { days: 4, kind: "half" };
  return { days: 7, kind: "marathon" };
}

interface RaceCandidate extends RaceGoalRef {
  runs: RaceRun[];
}

// The races there are to resolve: every kept one (its matched effort is permanent; an
// unmatched one is matched live) and the live goal's dated race. One goal = one key.
function raceCandidates(): RaceCandidate[] {
  return requestMemo("race_candidates", raceCandidatesRead, copyDeep);
}

function raceCandidatesRead(): RaceCandidate[] {
  const out = new Map<string, RaceCandidate>();
  const key = (date: string, km: number) => `${date}|${Math.round(km * 1000)}`;
  for (const row of completedRaceRows()) {
    if (!(row.distance_km > 0)) continue;
    const ref = { goal_date: row.goal_date, distance_km: row.distance_km, event: row.event };
    const runs: RaceRun[] = row.run_date
      ? [
          {
            date: row.run_date,
            activity_id: row.activity_id,
            km: Number(row.run_km) || row.distance_km,
            duration_min: null,
          },
        ]
      : raceLikeRuns(ref);
    out.set(key(ref.goal_date, ref.distance_km), { ...ref, runs });
  }
  try {
    const goal = getEnduranceGoal();
    const km = Number(goal?.distance_km);
    if (goal?.is_race && goal.date && km > 0) {
      const ref = {
        goal_date: String(goal.date).slice(0, 10),
        distance_km: km,
        event: goal.event ? String(goal.event) : null,
      };
      const k = key(ref.goal_date, km);
      if (!out.has(k)) out.set(k, { ...ref, runs: raceLikeRuns(ref) });
    }
  } catch {
    /* no live goal to add */
  }
  return [...out.values()];
}

// One candidate resolved as of `asOf` (window rules), or in hindsight (asOf null).
function resolve(c: RaceCandidate, asOf: string | null): RaceEffort | null {
  const ref = { goal_date: c.goal_date, distance_km: c.distance_km, event: c.event };
  const run = pickRaceEffort(ref, c.runs, asOf);
  if (run) return { ...ref, run_date: run.date, activity_id: run.activity_id, run_km: run.km, provisional: false };
  const graceEnds = addDaysISO(c.goal_date, RACE_DATE_SLACK_DAYS);
  if (asOf != null && graceEnds && asOf >= c.goal_date && asOf <= graceEnds)
    return { ...ref, run_date: c.goal_date, activity_id: null, run_km: null, provisional: true };
  return null;
}

function efforts(asOf: string | null): RaceEffort[] {
  let list: RaceCandidate[];
  try {
    list = raceCandidates();
  } catch {
    return [];
  }
  // One run is one race: two goals resolving to the same day (a goal's date or distance
  // corrected after the race) keep the matched one whose distance is nearest the run's.
  const byDay = new Map<string, RaceEffort>();
  const fit = (e: RaceEffort) =>
    e.provisional ? Number.POSITIVE_INFINITY : Math.abs((e.run_km ?? e.distance_km) - e.distance_km);
  for (const e of list.map((c) => resolve(c, asOf))) {
    if (!e) continue;
    const held = byDay.get(e.run_date);
    if (!held || fit(e) < fit(held)) byDay.set(e.run_date, e);
  }
  return [...byDay.values()].sort((a, b) => a.run_date.localeCompare(b.run_date));
}

/** The latest race effort run strictly before `date`, as known on `date`. Fail-soft. */
export function raceEffortBefore(date: string): RaceEffort | null {
  const d = String(date).slice(0, 10);
  const before = efforts(d).filter((e) => e.run_date < d);
  return before.length ? before[before.length - 1] : null;
}

/** The post-race recovery window covering `date`, or null. */
export function raceRecoveryWindow(date: string = localDateISO()): RaceRecoveryWindow | null {
  const d = String(date).slice(0, 10);
  for (const e of efforts(d).reverse()) {
    const shape = raceRecoveryShape(e.distance_km);
    if (!shape) continue;
    const dayIndex = daysBetweenISO(d, e.run_date);
    if (dayIndex == null || dayIndex < 1 || dayIndex > shape.days) continue;
    const endsOn = addDaysISO(e.run_date, shape.days);
    const backOn = addDaysISO(e.run_date, shape.days + 1);
    if (!endsOn || !backOn) continue;
    return {
      race: {
        event: e.event ? String(e.event).slice(0, 80) : null,
        date: e.run_date,
        distance_km: e.distance_km,
        goal_date: e.goal_date,
        provisional: e.provisional,
      },
      day_index: dayIndex,
      days: shape.days,
      ends_on: endsOn,
      back_on: backOn,
      kind: shape.kind,
    };
  }
  return null;
}

/** The window's span for a resolved race: race day + 1 … its last day. */
export function raceRecoverySpan(e: Pick<RaceEffort, "run_date" | "distance_km">): { from: string; to: string } | null {
  const shape = raceRecoveryShape(e.distance_km);
  const from = addDaysISO(e.run_date, 1);
  const to = shape ? addDaysISO(e.run_date, shape.days) : null;
  return from && to ? { from, to } : null;
}

/** True when `date` falls inside a post-race recovery window. Fail-soft. */
export function inRaceRecovery(date: string = localDateISO()): boolean {
  return raceRecoveryWindow(date) != null;
}

/**
 * The days in [from, to] whose running was a RACE, never training: the capacity reads
 * (run-capacity.ts) and the long-run ladder (run-progression.ts) leave them out. In
 * hindsight, matched efforts only — a race with no logged effort blanks nothing.
 */
export function raceRunDates(from: string | null, to: string): Set<string> {
  const hi = String(to).slice(0, 10);
  const lo = from ? String(from).slice(0, 10) : null;
  return new Set(
    efforts(null)
      .map((e) => e.run_date)
      .filter((day) => day <= hi && (lo == null || day >= lo))
  );
}

/**
 * Whether `date`'s run was the race. In hindsight (no `asOf`): a matched effort only —
 * the harm read's question. As of a day (`asOf`): the window's rules, so in the slow-sync
 * grace the goal date stands in — the next morning's novelty brake asks this way.
 */
export function isRaceDay(date: string, asOf?: string): boolean {
  const d = String(date).slice(0, 10);
  return efforts(asOf ? String(asOf).slice(0, 10) : null).some((e) => e.run_date === d);
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Thu" for an ISO date. */
export function weekdayShort(iso: string): string {
  const t = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? (WEEKDAY[new Date(t).getUTCDay()] ?? "") : "";
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The day full training is back, said from `date`: "Thu" inside the week, "Mon Nov 9" past it. */
export function backOnWords(backOn: string, date: string): string {
  const day = weekdayShort(backOn);
  const away = daysBetweenISO(backOn, date);
  if (away != null && away >= 1 && away <= 6) return day;
  const t = Date.parse(`${String(backOn).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  const at = new Date(t);
  return `${day} ${MONTH[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

// The window said ONCE, calmly, for the surfaces that name the week (the week frame's
// headline, the race lane and race page in place of "the race is behind you", the race
// countdown's reason). Rotated by date.
type WindowLine = (race: string, back: string) => string;
export const RACE_RECOVERY_LINES: readonly [WindowLine, ...WindowLine[]] = [
  (race, back) => `Recovering from ${race} · back to full on ${back}`,
  (race, back) => `Recovering from ${race} · full training again on ${back}`,
  (race, back) => `Easing back after ${race} · back to full on ${back}`,
];

/** "Recovering from Cambridge Half · back to full on Thu" for `date`, or null outside a window. */
export function raceRecoveryLine(date: string = localDateISO(), win = raceRecoveryWindow(date)): string | null {
  if (!win) return null;
  const race = win.race.event || "the race";
  return pickDayVariant(RACE_RECOVERY_LINES, date, "race-recovery:line")(race, backOnWords(win.back_on, date));
}
