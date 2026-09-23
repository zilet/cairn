// Adaptive plan-day selection — pick which programmed day today's "train" read
// should point at. Starts from the historical rotation, then lets logged content,
// volume balance, and acute muscle load adapt the pick when another programmed day
// is clearly smarter. Deterministic + null-safe; never mutates the plan.
//
// Split out of the former intelligence.ts monolith (K4). dayRead / forwardLook (in
// day-read.ts) consume selectAdaptivePlanDay + the helpers re-exported here.
import { db } from "../db.js";
import { mondayOf } from "../lib/dates.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import {
  canonicalGroup,
  classifyMuscleGroup,
  type MuscleGroup,
  normalizeExerciseName,
  plainGroupWords,
} from "./exercise-canon.js";
import { recentWorkingWeight } from "./exercises.js";
import { type AcuteGateReading, acuteGates } from "./hybrid-load.js";
import { loadAtOrAbove } from "./outcome-comparability.js";
import { type EnduranceScheduleKind, getEnduranceSchedule } from "./profile.js";
import { programBalance } from "./progression.js";
import { liftDows } from "./strength-schedule.js";
import { registerHybridForwardProjection } from "./training-read.js";
import { daysBetweenISO, joinList, localDateISO } from "./shared.js";

export interface PlanDayCandidate {
  id: number;
  day_number: number;
  name: string;
  focus: string | null;
  // Always 'training' now. Plan days hold STRENGTH work only (migration 110): a rest
  // day is a weekday the athlete neither lifts nor runs, read off the calendar, and a
  // run lives in the run engine — neither is a plan row. The field stays on the shape
  // because every plan surface already carries it.
  day_type: "training" | "rest";
  names: string[];
  groups: MuscleGroup[];
}

export interface ResolvedSessionPlanDay {
  day_number: number;
  method: "linked" | "exercise-overlap" | "group-overlap";
}

export interface SelectedPlanDay {
  date: string;
  plan_day_id: number;
  day_number: number;
  focus: string | null;
  day_type: "training" | "rest";
  selection: Record<string, any>;
  source: "existing-session" | "cached-day-read" | "adaptive";
}

interface SessionAnchor {
  id: number;
  date: string;
  days_ago: number | null;
  groups: MuscleGroup[];
  resolved: ResolvedSessionPlanDay | null;
}

interface PlanSelectionScore {
  day_number: number;
  focus: string | null;
  score: number;
  due: string[];
  fresh_due: string[];
  recovering: string[];
  repeated: string[];
  over: string[];
  reasons: string[];
  mostly_recovering: boolean;
  /** Already trained in this lifting week while another strength day is still open. */
  done_this_week?: boolean;
}

export function planDayFocus(day: Pick<PlanDayCandidate, "name" | "focus" | "day_number">): string {
  return String(day.focus || day.name || `Day ${day.day_number}`)
    .replace(/\s+/g, " ")
    .trim();
}

// The label a plan day goes by everywhere a person reads it: its NAME ("Pull"). A
// name the athlete never gave ("Day 3") says nothing, so the focus stands in.
export function planDayLabel(day: Pick<PlanDayCandidate, "name" | "focus" | "day_number">): string {
  const name = String(day.name || "").replace(/\s+/g, " ").trim();
  if (name && !/^day\s*\d+$/i.test(name)) return name;
  return planDayFocus(day);
}

export function planDayCandidates(): PlanDayCandidate[] {
  // STRENGTH days only — the ring is the lifting days. A legacy rest row or a run item
  // (both retired by migration 110) is never a candidate, so nothing downstream can
  // land a session on one even on a database that has not migrated yet.
  const rows = db
    .prepare(
      `SELECT pd.id AS id, pd.day_number AS day_number, pd.name AS day_name, pd.focus AS focus,
            e.name AS exercise, e.muscle_group AS muscle_group
       FROM plan_days pd
       LEFT JOIN plan_items pi ON pi.plan_day_id = pd.id AND COALESCE(pi.kind, 'strength') != 'cardio'
       LEFT JOIN exercises e ON e.id = pi.exercise_id
      WHERE COALESCE(pd.day_type, 'training') != 'rest'
      ORDER BY pd.day_number, pi.position`
    )
    .all() as any[];
  const map = new Map<number, PlanDayCandidate>();
  for (const r of rows) {
    const id = Number(r.id);
    if (!Number.isFinite(id)) continue;
    const cur = map.get(id) ?? {
      id,
      day_number: Number(r.day_number),
      name: String(r.day_name || `Day ${r.day_number}`),
      focus: r.focus == null ? null : String(r.focus),
      day_type: "training" as const,
      names: [],
      groups: [],
    };
    const exercise = r.exercise == null ? "" : String(r.exercise).trim();
    if (exercise) {
      if (!cur.names.includes(exercise)) cur.names.push(exercise);
      const group = canonicalGroup(r.muscle_group) ?? classifyMuscleGroup(exercise);
      if (group && group !== "mobility" && !cur.groups.includes(group)) cur.groups.push(group);
    }
    map.set(id, cur);
  }
  return [...map.values()].sort((a, b) => a.day_number - b.day_number);
}

function sessionGroups(sessionId: number): MuscleGroup[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT e.name AS exercise, e.muscle_group AS muscle_group
       FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
      WHERE ls.session_id = ?`
    )
    .all(sessionId) as any[];
  const groups: MuscleGroup[] = [];
  for (const r of rows) {
    const group = canonicalGroup(r.muscle_group) ?? classifyMuscleGroup(r.exercise);
    if (group && group !== "mobility" && !groups.includes(group)) groups.push(group);
  }
  return groups;
}

// Core never decides which day to train. It is loaded by nearly everything (every
// run and ride credits it), recovers on its own clock, and rides along as an
// accessory on most split days — the same law RUN_PRIME_GROUPS applies to the run
// builder. Counting it let a 25-minute jog veto the programmed Pull day, and let any
// session that did a plank claim any day.
const NON_DECIDING_GROUPS: ReadonlySet<string> = new Set(["core"]);

export function resolveSessionPlanDay(
  sessionId: number,
  planDayId: number | null,
  candidates: PlanDayCandidate[]
): ResolvedSessionPlanDay | null {
  const loggedNames = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT LOWER(e.name) AS name
         FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
        WHERE ls.session_id = ?`
        )
        .all(sessionId) as any[]
    ).map((r) => String(r.name))
  );
  const groups = sessionGroups(sessionId);

  if (planDayId != null) {
    const linked = candidates.find((d) => d.id === Number(planDayId));
    // Candidates are strength days only, so a link to a retired rest/run row (or one
    // migration 110 nulled) simply finds nothing and falls through to the content
    // resolvers below, which read what was actually lifted.
    //
    // Nor does a link whose day has since been REWRITTEN: a restructure keeps the
    // session's plan_day_id while the day's content changes, so a squat session
    // stayed "Push" and the ring anchored off a day the athlete never did. The link
    // stands while the day still shares a movement or a muscle with what was logged.
    const stillMatches =
      !!linked &&
      (!linked.names.length ||
        !loggedNames.size ||
        linked.names.some((name) => loggedNames.has(name.toLowerCase())) ||
        linked.groups.some((g) => !NON_DECIDING_GROUPS.has(g) && groups.includes(g)));
    if (linked && stillMatches) return { day_number: linked.day_number, method: "linked" };
  }
  let exact: { day_number: number; hits: number } | null = null;
  for (const day of candidates) {
    let hits = 0;
    for (const name of day.names) if (loggedNames.has(name.toLowerCase())) hits++;
    if (hits && (!exact || hits > exact.hits)) exact = { day_number: day.day_number, hits };
  }
  if (exact) return { day_number: exact.day_number, method: "exercise-overlap" };

  if (!groups.length) return null;
  const loggedGroups = new Set(groups);
  let best: { day_number: number; hits: number; ratio: number } | null = null;
  for (const day of candidates) {
    if (!day.groups.length) continue;
    const hits = day.groups.filter((g) => loggedGroups.has(g)).length;
    if (!hits) continue;
    const ratio = hits / Math.max(1, Math.min(day.groups.length, loggedGroups.size));
    if (!best || hits > best.hits || (hits === best.hits && ratio > best.ratio)) {
      best = { day_number: day.day_number, hits, ratio };
    }
  }
  return best ? { day_number: best.day_number, method: "group-overlap" } : null;
}

function recentSessionAnchors(date: string, candidates: PlanDayCandidate[]): SessionAnchor[] {
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.date AS date, s.plan_day_id AS plan_day_id
       FROM sessions s
      WHERE s.date < ?
        AND EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id)
      ORDER BY s.date DESC, s.id DESC LIMIT 20`
    )
    .all(date) as any[];
  return rows.map((r) => ({
    id: Number(r.id),
    date: String(r.date),
    days_ago: daysBetweenISO(date, String(r.date)),
    groups: sessionGroups(Number(r.id)),
    resolved: resolveSessionPlanDay(Number(r.id), r.plan_day_id == null ? null : Number(r.plan_day_id), candidates),
  }));
}

/**
 * The strength plan days already trained in `date`'s Monday-first week, before `date`.
 * Read off the resolved session anchors — the same resolution the ring's phase uses —
 * so a session counts as the plan day it actually was, not the one it was linked to.
 */
function strengthDaysDoneThisWeek(date: string, anchors: readonly SessionAnchor[]): Set<number> {
  const done = new Set<number>();
  const dateIndex = dayIndexOf(date);
  if (dateIndex == null) return done;
  const monday = dateIndex - ((dateIndex + EPOCH_DOW + 6) % 7);
  for (const anchor of anchors) {
    const at = dayIndexOf(anchor.date);
    if (at == null || at < monday || at >= dateIndex || !anchor.resolved) continue;
    done.add(anchor.resolved.day_number);
  }
  return done;
}

// ---- one genuinely loaded lower-body exposure a week (owner ruling, 2026-09-23) ----
// The race build's own strength law is "heavy lower once a week" (race-build.ts
// STRENGTH_HINT). A hybrid week that lifts Mon–Fri and runs Tue/Thu/weekend lands every
// lower day the morning after a run, and each of those mornings, read alone, had a
// reason to lighten or move the legs — so the week as a whole could pass with no full
// leg session at all. These reads let the selector and the envelope ask the WEEK'S
// question: has a full-load lower session landed yet, and is today the last chance.
//
// Keyed on STRENGTH plan days and the LOG only — never on cardio items or an
// endurance/rest plan day — so it reads the same whether or not runs live on the plan.

// A plan day is a lower day when it carries squat/hinge work. Calves are excluded, the
// same line training-read.ts draws for `heavy_lower` (a calf-raise day is not a leg day).
export const HEAVY_LOWER_GROUPS: ReadonlySet<string> = new Set(["quads", "hamstrings", "glutes"]);

// The main lower lifts a "genuinely loaded" session is judged on: squat and hinge
// patterns and their loaded cousins, never an isolation machine (a leg extension at its
// usual weight is not a leg session). Matched over the normalized name.
const LOWER_MAIN_LIFT_PATTERN =
  /\b(squat|dead ?lift|rdl|leg press|hip thrust|lunge|step ?up|good ?morning)\b/;

// "No reduced cap": the reduced-area clamp is two sets per lift, so a session counts only
// when the lift got its un-reduced prescription — the plan's own set count for it, at most
// three (a lift the plan writes at two sets is whole at two).
const LOWER_FULL_SETS_MAX = 3;
const LOWER_WORKING_SET_FRACTION = 0.9;

export function isHeavyLowerPlanDay(day: Pick<PlanDayCandidate, "day_number" | "day_type" | "names" | "groups">): boolean {
  return planDayRole(day) === "strength" && day.groups.some((g) => HEAVY_LOWER_GROUPS.has(g));
}

export function isLowerMainLift(name: string, group: string | null | undefined): boolean {
  const resolved = canonicalGroup(group ?? null) ?? classifyMuscleGroup(name);
  if (!resolved || !HEAVY_LOWER_GROUPS.has(resolved)) return false;
  return LOWER_MAIN_LIFT_PATTERN.test(normalizeExerciseName(name));
}

/**
 * The first date in `date`'s Monday-first week, BEFORE `date`, on which a main lower lift
 * was logged genuinely loaded: its working sets (loads within 10% of the day's top) met
 * the lift's un-reduced set count, and the top load sat at or above the lift's own
 * logged working weight going in (`recentWorkingWeight`, the same reference
 * `performed_at_full_load` uses; `loadAtOrAbove`). No reference is unknown, and unknown
 * is not met. The log is the truth: an unlinked session, or one the athlete took past
 * a lighter card, counts exactly like a planned one.
 */
/** The active composed card's target weight for `exercise` on `date`, when there is one. */
function prescribedTargetOn(date: string, exercise: string): number | null {
  try {
    const row = db
      .prepare(
        `SELECT items_json FROM daily_session_compositions
          WHERE date = ? AND status = 'active' ORDER BY version DESC, id DESC LIMIT 1`
      )
      .get(date) as { items_json?: string | null } | undefined;
    const items = row?.items_json ? JSON.parse(String(row.items_json)) : [];
    const want = exercise.toLowerCase();
    // A top set shares the exercise name (one heavier single); the working block is the
    // matching item with the most sets.
    const item = (Array.isArray(items) ? items : [])
      .filter((it: any) => String(it?.exercise ?? "").toLowerCase() === want)
      .sort((a: any, b: any) => (Number(b?.sets) || 0) - (Number(a?.sets) || 0))[0];
    const weight = Number(item?.target_weight);
    return Number.isFinite(weight) ? weight : null;
  } catch {
    return null;
  }
}

export function fullLoadLowerSessionThisWeek(date: string): string | null {
  if (dayIndexOf(date) == null) return null;
  const monday = mondayOf(String(date).slice(0, 10));
  const rows = db
    .prepare(
      `SELECT s.date AS date, e.name AS exercise, e.muscle_group AS muscle_group,
              ls.weight AS weight, ls.reps AS reps
         FROM logged_sets ls
         JOIN sessions s ON s.id = ls.session_id
         JOIN exercises e ON e.id = ls.exercise_id
        WHERE s.date >= ? AND s.date < ?
          AND COALESCE(s.kind, 'strength') = 'strength'
          AND ls.weight > 0 AND ls.reps IS NOT NULL
        ORDER BY s.date, ls.id`
    )
    .all(monday, date) as Array<{ date: string; exercise: string; muscle_group: string | null; weight: number; reps: number }>;
  const byLiftDay = new Map<string, { date: string; exercise: string; weights: number[] }>();
  for (const row of rows) {
    const exercise = String(row.exercise ?? "").trim();
    if (!exercise || !isLowerMainLift(exercise, row.muscle_group)) continue;
    const key = `${row.date}\u0000${exercise.toLowerCase()}`;
    const entry = byLiftDay.get(key) ?? { date: String(row.date), exercise, weights: [] };
    entry.weights.push(Number(row.weight));
    byLiftDay.set(key, entry);
  }
  if (!byLiftDay.size) return null;
  const plannedSets = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT e.name AS exercise, MAX(pi.sets) AS sets FROM plan_items pi
         JOIN exercises e ON e.id = pi.exercise_id
        WHERE COALESCE(pi.kind, 'strength') != 'cardio'
        GROUP BY e.id`
    )
    .all() as Array<{ exercise: string; sets: number | null }>) {
    const sets = Number(row.sets);
    if (Number.isFinite(sets) && sets > 0) plannedSets.set(String(row.exercise).toLowerCase(), sets);
  }
  const met = [...byLiftDay.values()]
    .filter((entry) => {
      const top = Math.max(...entry.weights);
      const working = entry.weights.filter((w) => w >= top * LOWER_WORKING_SET_FRACTION).length;
      const required = Math.min(LOWER_FULL_SETS_MAX, plannedSets.get(entry.exercise.toLowerCase()) ?? LOWER_FULL_SETS_MAX);
      if (working < required) return false;
      // Full load is "did the work the card asked for, or more": the day's own prescription
      // counts as well as the logged working weight — a 192.5 × 8–10 card completed in full
      // is a full lower session even when an old 205 × 5 top set sets the working weight.
      const prescribed = prescribedTargetOn(entry.date, entry.exercise);
      if (prescribed != null && prescribed > 0 && loadAtOrAbove(top, prescribed)) return true;
      const reference = recentWorkingWeight(entry.exercise, 3, entry.date);
      return reference != null && loadAtOrAbove(top, reference);
    })
    .map((entry) => entry.date)
    .sort();
  return met[0] ?? null;
}

/** The dates after `date`, through its week's Sunday, whose weekday-map day is a lower day. */
function laterLowerDatesThisWeek(date: string, map: ReadonlyMap<number, PlanDayCandidate>): string[] {
  const index = dayIndexOf(date);
  if (index == null) return [];
  const out: string[] = [];
  const toSunday = 6 - ((index + EPOCH_DOW + 6) % 7);
  for (let i = 1; i <= toSunday; i++) {
    const iso = new Date((index + i) * 86_400_000).toISOString().slice(0, 10);
    const day = map.get(new Date(`${iso}T00:00:00Z`).getUTCDay());
    if (day && isHeavyLowerPlanDay(day)) out.push(iso);
  }
  return out;
}

export interface WeeklyLowerExposure {
  /** Today is one of the athlete's lifting weekdays (stated, or observed off the log). */
  lift_day: boolean;
  /** The date a genuinely loaded lower session landed earlier this week, or null. */
  fulfilled_on: string | null;
  /** Later dates this week the lifting week still lays a lower day on. Empty = last chance. */
  later_lower_dates: string[];
}

/**
 * The week's lower-body coverage as of `date`'s morning, or null when the athlete has no
 * lifting week (the guarantee is about a week they described or lived) or the plan holds
 * no lower strength day at all. Read off the same weekday map the selector uses.
 */
export function weeklyLowerExposure(date: string): WeeklyLowerExposure | null {
  const { map, lift_dows } = thisWeekPlanDayMap(date);
  if (!lift_dows.length || ![...map.values()].some((day) => isHeavyLowerPlanDay(day))) return null;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return {
    lift_day: lift_dows.includes(dow),
    fulfilled_on: fullLoadLowerSessionThisWeek(date),
    later_lower_dates: laterLowerDatesThisWeek(date, map),
  };
}

export function nextCandidateAfter(candidates: PlanDayCandidate[], dayNumber: number): PlanDayCandidate {
  const idx = candidates.findIndex((d) => d.day_number === dayNumber);
  return candidates[idx >= 0 ? (idx + 1) % candidates.length : 0];
}

// ---------- the weekday ring ----------
//
// The ring used to be purely POSITIONAL: Monday took plan day 1, Tuesday day 2, and so
// on down a Mon–Sun line. That is the right answer for an athlete who has told us
// nothing, and the wrong one the moment they have. An athlete who says "I lift every
// workday and keep the weekend for the long run and the bike" has named their week;
// a positional ring will still hand them a strength day on Sunday because Sunday is
// slot seven, and no amount of scoring downstream can undo a premise that wrong.
//
// So when a strength schedule is STATED (or, failing that, observed off the log), the
// positional mapping runs over the lifting weekdays only. The plan's strength days — the
// ONLY days a plan holds (migration 110) — are laid, in ring order, onto the lift
// weekdays in weekday order. Every other weekday maps to NO plan day: a stated run
// weekday is a run day (the run engine owns it) and anything else is a calendar rest
// day. An unstated weekday never receives a strength day. With no schedule at all,
// nothing changes.
//
// PLAN-DAY COUNT NEED NOT EQUAL LIFT-DAY COUNT, and the two mismatches resolve in
// opposite directions — both of them here rather than in the scorer, because both are
// questions about the athlete's week rather than about their recovery:
//
//   FEWER strength days than lift weekdays: the pool repeats inside the week. Three
//   strength days over Mon–Fri gives Mon/Tue/Wed the three and Thu/Fri the first two
//   again. Every named lifting weekday carries a session, because that is the thing the
//   athlete said.
//
//   MORE strength days than lift weekdays: the surplus rotates ACROSS weeks. Six
//   strength days over Mon–Fri gives the sixth day to next Monday, not to Saturday —
//   the pool is a continuous sequence dealt onto the lifting weekdays, phased by
//   `strengthStart` so a week boundary never resets it. The phase is anchored on the
//   last logged plan day (`strengthStartForWeek`), so the ring picks up where the
//   athlete actually left it, and an unstated weekday still never becomes a lifting day.

/** The shape the weekday mapping needs off a plan day. */
export interface WeekdayMappablePlanDay {
  day_number: number;
  day_type?: "training" | "rest";
  /** Strength item names — a day with any of these is a STRENGTH day. */
  names?: readonly string[];
}

// "endurance" and "rest" are CALENDAR roles now: they name a weekday that carries a run
// or nothing, never a plan row. A plan day itself is "strength", or "empty" while it is
// an editor scaffold with nothing on it yet (CLAUDE.md: an empty plan day is never
// startable, and it never takes a lifting weekday).
export type WeekdayPlanDayRole = "strength" | "endurance" | "rest" | "empty";

export function planDayRole(day: WeekdayMappablePlanDay): WeekdayPlanDayRole {
  if (day.day_type === "rest") return "rest";
  return (day.names?.length ?? 0) > 0 ? "strength" : "empty";
}

/** dow 0–6 (0 = Sunday) in the order the week is lived: Monday first, Sunday last. */
const weekdayOrder = (dow: number): number => (dow + 6) % 7;

function normalizeDows(dows: readonly number[] | null | undefined): number[] {
  const seen = new Set<number>();
  for (const raw of dows ?? []) {
    const dow = Number(raw);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
    seen.add(dow);
  }
  return [...seen].sort((a, b) => weekdayOrder(a) - weekdayOrder(b));
}

/**
 * Lay a plan's STRENGTH days onto the athlete's lifting weekdays.
 *
 * Pure: no DB, no clock, no mutation. Returns `dow -> plan day` for the lifting weekdays
 * only; every other weekday is left OUT of the map, because the plan has nothing for
 * it — a run day belongs to the run engine and a free weekday is rest.
 *
 * `strengthDows` empty means "unstated" — the map comes back empty and every caller
 * falls back to the positional ring, which is exactly the old behavior.
 *
 * The lifting days CYCLE. Five stated lifting weekdays against a plan with three
 * strength days gives Mon/Tue/Wed the three and Thu/Fri the first two again. Every
 * stated lifting weekday carries a strength session, because that is the thing the
 * athlete actually said; a repeat inside one week is a programming question the scorer
 * and the agent get to answer, not a reason to hand back rest on a day they told us
 * they lift.
 *
 * `strengthStart` is the strength pool index the week's FIRST lifting weekday takes.
 * It is what makes the cycle continuous across weeks rather than restarting every
 * Monday, which is the only way a plan with MORE strength days than lifting weekdays
 * ever reaches its surplus days. 0 — the default — deals the pool from its first day,
 * which is the right answer for a week with no logged session to phase against.
 */
export function weekdayPlanDayMap<T extends WeekdayMappablePlanDay>(
  planDays: readonly T[],
  strengthDows: readonly number[] | null | undefined,
  strengthStart = 0
): Map<number, T> {
  const map = new Map<number, T>();
  const lift = normalizeDows(strengthDows);
  if (!lift.length || !planDays.length) return map;
  const strengthPool = [...planDays]
    .sort((a, b) => a.day_number - b.day_number)
    .filter((d) => planDayRole(d) === "strength");
  // A stated lifting weekday takes a STRENGTH day and nothing else — with no strength
  // day in the plan at all there is nothing honest to put there, so it stays unmapped.
  if (!strengthPool.length) return map;
  const size = strengthPool.length;
  const raw = Number.isFinite(strengthStart) ? Math.trunc(strengthStart) : 0;
  const start = ((raw % size) + size) % size;
  lift.forEach((dow, i) => map.set(dow, strengthPool[(start + i) % size]));
  return map;
}

/**
 * This week's weekday → plan-day map with the real ring phase (anchor-aware).
 * Empty `map` when no lift schedule is known — callers then fall back to template
 * order rather than inventing Mon=Day1 weekdays.
 */
export function thisWeekPlanDayMap(date = localDateISO()): {
  map: Map<number, PlanDayCandidate>;
  lift_dows: number[];
  strength_start: number;
} {
  const candidates = planDayCandidates();
  const lift = normalizeDows(liftDows(date));
  if (!lift.length || !candidates.length) {
    return { map: new Map(), lift_dows: [], strength_start: 0 };
  }
  const anchors = recentSessionAnchors(date, candidates);
  const anchor = anchors.find((a) => a.resolved) ?? null;
  const pool = candidates.filter((day) => planDayRole(day) === "strength");
  const strength_start = strengthStartForWeek(date, lift, pool, anchor);
  const map = weekdayPlanDayMap(candidates, lift, strength_start);
  return { map, lift_dows: lift, strength_start };
}

// ---------- the calendar day: lift, run, or rest ----------
//
// Plan days hold strength only, so "what kind of day is today" is a question about the
// athlete's CALENDAR, not about a plan row: a lifting weekday lifts, a stated run
// weekday that is not also a lifting weekday is a run day, and a weekday that is
// neither is a rest day. Known only when a lifting week is known (stated or observed);
// null otherwise, and every caller then keeps the positional ring's answer.
export type CalendarDayKind = "lift" | "run" | "rest";

export interface CalendarDayRead {
  kind: CalendarDayKind;
  /** The stated run kind when the weekday is a stated run day (a lift day may carry one too). */
  run_kind: EnduranceScheduleKind | null;
  lift_dows: number[];
  run_dows: number[];
}

export function calendarDayRead(date: string): CalendarDayRead | null {
  const d = String(date || "").slice(0, 10);
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  if (!Number.isInteger(dow)) return null;
  let lift: number[] = [];
  try {
    lift = normalizeDows(liftDows(d));
  } catch {
    return null; // a schedule we cannot read is a schedule we do not have
  }
  if (!lift.length) return null;
  let runDays: { dow: number; kind: EnduranceScheduleKind }[] = [];
  try {
    runDays = getEnduranceSchedule()?.days ?? [];
  } catch {
    runDays = [];
  }
  const run_dows = normalizeDows(runDays.map((day) => day.dow));
  const run_kind = runDays.find((day) => day.dow === dow)?.kind ?? null;
  const kind: CalendarDayKind = lift.includes(dow) ? "lift" : run_kind ? "run" : "rest";
  return { kind, run_kind, lift_dows: lift, run_dows };
}

/**
 * The strength plan day a date's weekday carries, for FORWARD projections (the hybrid
 * look-ahead, the fuel-demand week, the run engine's leg days). With a lifting week
 * known it is the weekday map's answer — and null on a run or rest weekday; with none,
 * the plain positional ring over the strength days (Monday takes the first). Pass
 * `weekMap` when projecting several dates of one week so the ring phase is read once.
 */
export function strengthPlanDayOn(
  date: string,
  opts: {
    candidates?: PlanDayCandidate[];
    weekMap?: { map: ReadonlyMap<number, PlanDayCandidate>; lift_dows: readonly number[] };
  } = {}
): PlanDayCandidate | null {
  const candidates = opts.candidates ?? planDayCandidates();
  const pool = candidates.filter((day) => planDayRole(day) === "strength");
  if (!pool.length) return null;
  const dow = new Date(`${String(date).slice(0, 10)}T00:00:00Z`).getUTCDay();
  if (!Number.isInteger(dow)) return null;
  const week = opts.weekMap ?? thisWeekPlanDayMap(date);
  if (week.lift_dows.length) return week.map.get(dow) ?? null;
  return pool[weekdayOrder(dow) % pool.length] ?? null;
}

/**
 * Where train-anyway goes from a calendar rest or run morning: the strength day the
 * athlete's own week was about to hand them on its NEXT lifting weekday — not a generic
 * fallback. With no lifting week known it is the ring's next day after the anchor. Null
 * when the plan holds no strength day at all.
 */
export function trainAnywayPlanDay(date: string): PlanDayCandidate | null {
  const d = String(date).slice(0, 10);
  const candidates = planDayCandidates();
  const pool = candidates.filter((day) => planDayRole(day) === "strength");
  if (!pool.length) return null;
  const anchors = recentSessionAnchors(d, candidates);
  const anchor = anchors.find((a) => a.resolved) ?? null;
  const lift = (() => {
    try {
      return normalizeDows(liftDows(d));
    } catch {
      return [];
    }
  })();
  const index = dayIndexOf(d);
  if (lift.length && index != null) {
    for (let ahead = 1; ahead <= 7; ahead++) {
      const iso = new Date((index + ahead) * 86_400_000).toISOString().slice(0, 10);
      const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
      if (!lift.includes(dow)) continue;
      const start = strengthStartForWeek(iso, lift, pool, anchor);
      const day = weekdayPlanDayMap(candidates, lift, start).get(dow);
      if (day) return day;
    }
  }
  return anchor?.resolved ? nextCandidateAfter(pool, anchor.resolved.day_number) : pool[0];
}

/** The plain day-number→weekday convention: Monday takes day 1, Sunday day 7. */
function weekdayCandidate(candidates: PlanDayCandidate[], date: string): PlanDayCandidate {
  const dow = new Date(date + "T00:00:00Z").getUTCDay();
  return candidates[weekdayOrder(dow) % candidates.length];
}

/** 1970-01-01 was a Thursday, so day-index 0 carries dow 4. */
const EPOCH_DOW = 4;

/** Whole days from the epoch to `date` at UTC midnight, or null when unparseable. */
function dayIndexOf(date: string): number | null {
  const ms = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
}

/**
 * How many lifting weekdays have come and gone from the epoch up to and INCLUDING
 * `dayIndex`. One monotone counter over the whole calendar — that is what lets the
 * strength pool keep its phase across a week boundary, because the pool is dealt onto
 * THIS sequence rather than restarted each Monday.
 */
function liftOccurrencesThrough(dayIndex: number, lift: readonly number[]): number {
  let count = 0;
  for (const dow of lift) {
    const first = (dow - EPOCH_DOW + 7) % 7;
    if (dayIndex >= first) count += Math.floor((dayIndex - first) / 7) + 1;
  }
  return count;
}

/** The pool index of the first strength day AFTER `dayNumber` in ring order, wrapping. */
function nextStrengthIndexAfter(pool: readonly PlanDayCandidate[], dayNumber: number): number {
  const at = pool.findIndex((day) => day.day_number > dayNumber);
  return at >= 0 ? at : 0;
}

/**
 * Where in the strength pool this date's week starts — the ring's PHASE.
 *
 * The anchor (the last session that resolved to a plan day) still decides where the
 * rotation has got to; it just no longer decides WHICH WEEKDAY gets a session. Given
 * the anchor resolved to day D on date A, the next lifting weekday after A should carry
 * the strength day that follows D in ring order, and every lifting weekday after that
 * follows on. That is one equation, solved once here and handed to the map.
 *
 * No anchor means no phase to recover: start at the pool's first day.
 */
function strengthStartForWeek(
  date: string,
  lift: readonly number[],
  pool: readonly PlanDayCandidate[],
  anchor: SessionAnchor | null
): number {
  const size = pool.length;
  if (!size || !lift.length || !anchor?.resolved) return 0;
  const anchorIndex = dayIndexOf(anchor.date);
  const dateIndex = dayIndexOf(date);
  if (anchorIndex == null || dateIndex == null) return 0;
  // The first lifting weekday of the week `date` falls in. `lift` arrives sorted
  // Monday-first, so lift[0] is that week's opening lifting day.
  const monday = dateIndex - ((dateIndex + EPOCH_DOW + 6) % 7);
  const first = monday + weekdayOrder(lift[0]);
  // Occurrence index (0-based) of that opening day, and of the next UNCONSUMED slot
  // after the anchor — the anchor's own day counts as consumed when it was a lift day.
  const firstOccurrence = liftOccurrencesThrough(first, lift) - 1;
  const offset = nextStrengthIndexAfter(pool, anchor.resolved.day_number) - liftOccurrencesThrough(anchorIndex, lift);
  return (((firstOccurrence + offset) % size) + size) % size;
}

/** What the athlete's lifting week says this date is, or null when they have no week. */
interface ScheduledPlanDay {
  day: PlanDayCandidate;
  lift_dows: number[];
  strength_start: number;
}

/**
 * The lifting week's answer for `date` — AUTHORITATIVE over the anchor rotation.
 *
 * `liftDows()` is empty when the athlete has neither stated a week nor lived one, and
 * an empty map means every caller falls back to the positional ring, which is exactly
 * the old behavior.
 */
function scheduledPlanDay(
  candidates: PlanDayCandidate[],
  date: string,
  anchor: SessionAnchor | null
): ScheduledPlanDay | null {
  const dow = new Date(date + "T00:00:00Z").getUTCDay();
  try {
    const lift = normalizeDows(liftDows(date));
    if (!lift.length) return null;
    const pool = candidates.filter((day) => planDayRole(day) === "strength");
    const strength_start = strengthStartForWeek(date, lift, pool, anchor);
    const day = weekdayPlanDayMap(candidates, lift, strength_start).get(dow);
    return day ? { day, lift_dows: lift, strength_start } : null;
  } catch {
    return null; // a schedule we cannot read is a schedule we do not have
  }
}

// The ONE derivation of "which of this day's groups are still recovering" — the
// shared acuteGate, never a re-derived window (CLAUDE.md). Both the scorer and the
// per-candidate read the pills render from go through here, so a dimmed pill and a
// penalised score can never disagree about the same day.
function recoveringGroupsForDay(
  day: Pick<PlanDayCandidate, "groups">,
  acute: Map<MuscleGroup, AcuteGateReading>
): MuscleGroup[] {
  return day.groups.filter((g) => !NON_DECIDING_GROUPS.has(g) && acute.get(g)?.saturated === true);
}

// A candidate day as the Today pills read it. No scores cross this line — the
// question a pill answers is "is this day's work still in my legs", and the answer
// is the groups themselves plus whether they are most of what the day trains.
export interface PlanDayRecoveryCandidate {
  day_number: number;
  focus: string;
  day_type: "training" | "rest";
  recovering_groups: MuscleGroup[];
  mostly_recovering: boolean;
}

export function planDayRecoveryCandidates(date: string): PlanDayRecoveryCandidate[] {
  const candidates = planDayCandidates();
  if (!candidates.length) return [];
  let acute: Map<MuscleGroup, AcuteGateReading>;
  try {
    acute = acuteGates(date);
  } catch {
    acute = new Map();
  }
  return candidates.map((day) => {
    const recovering = recoveringGroupsForDay(day, acute);
    return {
      day_number: day.day_number,
      focus: planDayFocus(day),
      day_type: day.day_type,
      recovering_groups: recovering,
      // "Most of what this day trains is still coming back." Half is the line, so a
      // two-group day with one recovering group already says so — that day IS half
      // unavailable. A day with no groups at all (a rest day, an empty scaffold)
      // never qualifies.
      mostly_recovering: day.groups.length > 0 && recovering.length * 2 >= day.groups.length,
    };
  });
}

function scorePlanDay(params: {
  day: PlanDayCandidate;
  rotation: PlanDayCandidate;
  rotationIndex: number;
  candidates: PlanDayCandidate[];
  due: Set<string>;
  over: Set<string>;
  broadLow: boolean;
  acute: Map<MuscleGroup, AcuteGateReading>;
  last: SessionAnchor | null;
}): PlanSelectionScore {
  const { day, rotation, rotationIndex, candidates, due, over, broadLow, acute, last } = params;
  const dayIndex = candidates.findIndex((d) => d.day_number === day.day_number);
  const distance =
    dayIndex >= 0 && rotationIndex >= 0 ? (dayIndex - rotationIndex + candidates.length) % candidates.length : 0;
  const lastGroups = new Set(last?.groups ?? []);
  const lastAge = last?.days_ago;
  const dueGroups = day.groups.filter((g) => due.has(g));
  const overGroups = day.groups.filter((g) => over.has(g));
  // The shared acute gate — no days_ago cliff on top of it. `saturated` already
  // knows how long ago the work landed AND how fast this group forgets, so quads
  // after Sunday's long run still read recovering while rear delts do not.
  const recovering = recoveringGroupsForDay(day, acute);
  // "Fresh" means the gate's own FRESH band. A LOADED group (still carrying real
  // work, under the saturation bar) is not fresh: the morning after a bench session
  // chest reads loaded, and scoring it as fresh-and-due is how the day after Push
  // picked the other chest day over the programmed Pull.
  const isLoaded = (g: MuscleGroup) => acute.get(g)?.band === "loaded";
  // Saturated but only just over its own bar: the work HOLDS (composition keeps the
  // slot at held load) rather than moves, so it scores like a loaded group — half due
  // credit, a light penalty — and never counts toward "mostly recovering". Only a
  // DEEP residual is reason enough to hand today to a different plan day.
  const deepRecovering = recovering.filter((g) => acute.get(g)?.deep === true);
  const shallowRecovering = recovering.filter((g) => !deepRecovering.includes(g));
  const freshDue = dueGroups.filter((g) => !recovering.includes(g) && !isLoaded(g));
  const repeated = lastAge != null && lastAge <= 3 ? day.groups.filter((g) => lastGroups.has(g)) : [];

  let score = day.day_number === rotation.day_number ? 2 : 0;
  score -= distance * 0.25;
  if (!day.groups.length) score -= 0.5;
  // Due credit follows the gate's contract ("do not call it due today"): a
  // saturated group earns none, a loaded one half. Weekly volume can wait a day.
  const dueWeight = broadLow ? 1.2 : 3;
  for (const group of dueGroups) {
    if (deepRecovering.includes(group)) continue;
    score += isLoaded(group) || shallowRecovering.includes(group) ? dueWeight / 2 : dueWeight;
  }
  if (freshDue.length >= 2) score += 0.75;
  score -= overGroups.length * 2;
  score -= shallowRecovering.length;
  for (const group of deepRecovering) {
    // Graded by how DEEP the residual still is rather than by the calendar: a
    // group carrying half again ITS OWN saturation bar is a harder no than one
    // that has just crossed it. The bar is relative to the athlete's own habitual
    // load (hybrid-load.ts's saturationBar), so a runner's legs need genuinely
    // more than usual to earn the harder penalty, not just more than a lifter's
    // absolute floor. (Internal magnitude — nothing here is rendered.)
    const gate = acute.get(group);
    score -= gate && gate.residual >= gate.bar * 1.5 ? 5 : 3;
  }
  for (const group of repeated) {
    // A saturated group already carries the stronger recovering penalty.
    if (acute.get(group)?.saturated || NON_DECIDING_GROUPS.has(group)) continue;
    score -= lastAge != null && lastAge <= 1 ? 2.5 : 1.5;
  }
  if (day.groups.length >= 3 && freshDue.length >= 2) score += 0.5; // full-body day that covers several fresh gaps

  const reasons: string[] = [];
  if (freshDue.length) reasons.push(`${joinList(freshDue)} due`);
  if (recovering.length) reasons.push(`${joinList(recovering)} recovering`);
  if (repeated.length) reasons.push(`${joinList(repeated)} just trained`);
  if (overGroups.length) reasons.push(`${joinList(overGroups)} running high`);
  if (!reasons.length && day.day_number === rotation.day_number) reasons.push("normal rotation");

  return {
    day_number: day.day_number,
    focus: planDayFocus(day),
    score: Math.round(score * 10) / 10,
    due: dueGroups,
    fresh_due: freshDue,
    recovering,
    repeated,
    over: overGroups,
    reasons,
    mostly_recovering: day.groups.length > 0 && deepRecovering.length * 2 >= day.groups.length,
  };
}

// selectionReason() produces the ONE machine→athlete caveat day-read.ts splices
// into the Brief's `why` (`"<lead> — " + caveats.join("; and ")`), so every
// phrasing here is a second-person, lowercase-starting sentence fragment with NO
// terminal punctuation — never a bare noun phrase, and never a plan-day label
// capitalized mid-sentence (that label is always lowercased before it lands in a
// template below). Distinct reason shapes each get their own ≥3-phrasing variant
// set, rotated with pickDayVariant on the SAME day the rest of the Brief rotates
// on — a stable plan-selection state fires the same shape every morning, so one
// literal per shape would read as a stuck app within a week (CLAUDE.md).
// The FATIGUE-AWARE pick: today's programmed day is still carrying real work and
// the day we chose instead is not. Given its own set (and checked first) because
// it is the most specific true thing that can be said — the generic fresh-due
// lead would answer "more due", which is not the reason. Phrased without a verb
// that has to agree with the group ("your chest are…"), so any mix of names
// reads correctly.
const SELECTION_LEAD_FRESHER = [
  "today steps around {groups}, still carrying recent work",
  "you're giving {groups} another day and training what's fresher instead",
  "this shape leaves {groups} alone while the work settles",
  "you're picking up fresher work and letting {groups} recover",
  "today leans away from {groups} and toward what's ready",
] as const;
const SELECTION_LEAD_FRESH_DUE = [
  "you're leaning into {groups} today — more due and fresher than usual",
  "you're catching {groups} at the better time, more due and still fresh",
  "you're picking up {groups} today, the more due and fresher option",
] as const;
const SELECTION_LEAD_RECOVERING = [
  "you're still touching {groups} a little early here, but the rest of today fits better",
  "you're working {groups} while it's mid-recovery, though everything else lines up better",
  "you're catching {groups} a touch sooner than ideal, but today still reads as the better fit",
] as const;
const SELECTION_LEAD_REPEATED = [
  "you're repeating {groups} from your last session, but the rest of today fits better",
  "you're touching {groups} again so soon, though everything else lines up better",
  "you're working {groups} a little sooner than usual, but today still reads as the better fit",
] as const;
const SELECTION_LEAD_OVER = [
  "you're still leaning into {groups}, already running high, but the rest of today fits better",
  "you're adding a bit more to {groups}, already well-loaded, though everything else lines up better",
  "you're working {groups} on the high side, but today still reads as the better fit",
] as const;
const SELECTION_LEAD_FALLBACK = [
  "it lines up better with what you've trained recently",
  "this shape simply fits your recent training history better",
  "it reads as the better match for how you've been training lately",
] as const;

const SELECTION_AVOID_RECOVERING = [
  "your usual {day} day would overlap {groups}, still recovering",
  "your regular {day} day would lean back into {groups}, not yet recovered",
  "sticking with {day} would touch {groups}, still on the mend",
  "your usual {day} day would ask more of {groups} too soon",
] as const;
const SELECTION_AVOID_REPEATED = [
  "your usual {day} day repeats {groups} from your last session",
  "your regular {day} day would train {groups} again, too soon after last time",
  "sticking with {day} would touch {groups} you just worked",
] as const;
const SELECTION_AVOID_OVER = [
  "your usual {day} day leans into {groups}, already running high",
  "your regular {day} day would add to {groups}, already well-loaded",
  "sticking with {day} would pile onto {groups}, already running high",
] as const;

function lc(s: unknown): string {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

// Canonical keys are the MACHINE register — `recovering`/`fresh_due` keep them so
// the signals stay analysable. Anything a person reads goes through the friendly
// mapping instead, capped at two names: a calm sentence names what matters, not
// an inventory.
function groupWords(groups: string[]): string {
  return plainGroupWords(groups, 2) ?? joinList(groups);
}

function fillGroups(template: string, groups: string): string {
  return template.replace(/\{groups\}/g, groups);
}

function fillDayAndGroups(template: string, day: string, groups: string): string {
  return template.replace(/\{day\}/g, day).replace(/\{groups\}/g, groups);
}

// The lead clause: why the SELECTED day itself is the better pick, in the same
// priority order the original literal fallback (fresh-due > recovering > repeated
// > over > "fits better") checked — but authored, second person, and rotating.
function selectionLeadClause(selected: PlanSelectionScore, rotation: PlanSelectionScore, date: string): string {
  if (!selected.recovering.length && rotation.recovering.length) {
    return fillGroups(
      pickDayVariant(SELECTION_LEAD_FRESHER, date, "plan-selection:lead:fresher"),
      groupWords(rotation.recovering)
    );
  }
  if (selected.fresh_due.length) {
    return fillGroups(
      pickDayVariant(SELECTION_LEAD_FRESH_DUE, date, "plan-selection:lead:fresh_due"),
      groupWords(selected.fresh_due)
    );
  }
  if (selected.recovering.length) {
    return fillGroups(
      pickDayVariant(SELECTION_LEAD_RECOVERING, date, "plan-selection:lead:recovering"),
      groupWords(selected.recovering)
    );
  }
  if (selected.repeated.length) {
    return fillGroups(
      pickDayVariant(SELECTION_LEAD_REPEATED, date, "plan-selection:lead:repeated"),
      groupWords(selected.repeated)
    );
  }
  if (selected.over.length) {
    return fillGroups(pickDayVariant(SELECTION_LEAD_OVER, date, "plan-selection:lead:over"), groupWords(selected.over));
  }
  return pickDayVariant(SELECTION_LEAD_FALLBACK, date, "plan-selection:lead:fallback");
}

// The avoid clause: what the athlete's USUAL (rotation) day would have cost —
// `rotation.focus` is a plan-day label ("Lower body", "Push") and is lowercased
// before it lands mid-sentence.
function selectionAvoidClause(rotation: PlanSelectionScore, date: string): string {
  const day = lc(rotation.focus) || "that";
  if (rotation.recovering.length) {
    return fillDayAndGroups(
      pickDayVariant(SELECTION_AVOID_RECOVERING, date, "plan-selection:avoid:recovering"),
      day,
      groupWords(rotation.recovering)
    );
  }
  if (rotation.repeated.length) {
    return fillDayAndGroups(
      pickDayVariant(SELECTION_AVOID_REPEATED, date, "plan-selection:avoid:repeated"),
      day,
      groupWords(rotation.repeated)
    );
  }
  if (rotation.over.length) {
    return fillDayAndGroups(
      pickDayVariant(SELECTION_AVOID_OVER, date, "plan-selection:avoid:over"),
      day,
      groupWords(rotation.over)
    );
  }
  return "";
}

function selectionReason(selected: PlanSelectionScore, rotation: PlanSelectionScore, date: string): string | null {
  if (selected.day_number === rotation.day_number) return null;
  const lead = selectionLeadClause(selected, rotation, date);
  const avoid = selectionAvoidClause(rotation, date);
  return avoid ? `${lead}, while ${avoid}` : lead;
}

export interface AdaptivePlanDayPick {
  /** null on a calendar run or rest day — the plan holds no row for that weekday. */
  day_number: number | null;
  focus: string | null;
  /**
   * 'training' when a strength plan day was picked. 'run' / 'rest' are CALENDAR days
   * (calendarDayRead): a stated run weekday that is not a lifting weekday, or a weekday
   * that is neither. Neither carries a plan day.
   */
  day_type: "training" | "rest" | "run";
  selection: Record<string, any>;
}

export function selectAdaptivePlanDay(date: string): AdaptivePlanDayPick | null {
  const candidates = planDayCandidates();
  const anchors = candidates.length ? recentSessionAnchors(date, candidates) : [];
  const anchor = anchors.find((a) => a.resolved) ?? null;
  const anchorBlob = anchor
    ? {
        date: anchor.date,
        days_ago: anchor.days_ago,
        groups: anchor.groups,
        resolved_day_number: anchor.resolved?.day_number ?? null,
        method: anchor.resolved?.method ?? null,
      }
    : null;
  const lastSessionBlob = anchors[0]
    ? { date: anchors[0].date, days_ago: anchors[0].days_ago, groups: anchors[0].groups }
    : null;

  // ---- the calendar says today is not a lifting day ----
  // Plan days hold strength only (migration 110), so a weekday the athlete did not name
  // for lifting has NO plan day: a stated run weekday is a run day and anything else is
  // a rest day. Returned with no scoring pass — the scorer answers "which STRENGTH day
  // fits today best", and the athlete has already answered the question before it.
  // Letting it run would quietly put a squat session on the weekday they kept for the
  // long run, which is the exact premise the schedule exists to fix. Still a SUGGESTION:
  // train_anyway carries them onto the day their week was about to give them
  // (trainAnywayPlanDay). Answered even with an empty plan, so a runner with no lifting
  // days on file still reads their rest and run days truthfully.
  const calendar = calendarDayRead(date);
  if (calendar && calendar.kind !== "lift") {
    const dayType = calendar.kind === "run" ? "run" : "rest";
    return {
      day_number: null,
      focus: null,
      day_type: dayType,
      selection: {
        selected: null,
        rotation: null,
        adapted: false,
        reason: null,
        calendar: { kind: calendar.kind, run_kind: calendar.run_kind },
        ...(dayType === "rest" ? { rest_day: true } : {}),
        weekday_schedule: { lift_days: calendar.lift_dows, ring_start: null, day_number: null },
        anchor: anchorBlob,
        last_session: lastSessionBlob,
      },
    };
  }
  if (!candidates.length) return null;
  // ---- the lifting week comes FIRST ----
  // Ahead of the anchor rotation, not after it. A schedule is a statement about which
  // weekdays carry which KIND of day, and a purely positional walk from the last logged
  // session cannot honor one — for any athlete with history an anchor always resolves,
  // so consulting the week only when no anchor exists leaves it permanently inert. The
  // anchor still sets the ring's PHASE (strengthStartForWeek); it no longer overrides
  // which weekday gets a session.
  const scheduled = scheduledPlanDay(candidates, date, anchor);
  const rotation =
    scheduled?.day ??
    (anchor?.resolved
      ? nextCandidateAfter(candidates, anchor.resolved.day_number)
      : weekdayCandidate(candidates, date));
  const scheduleBlob = scheduled
    ? { lift_days: scheduled.lift_dows, ring_start: scheduled.strength_start, day_number: scheduled.day.day_number }
    : null;

  let balance: any = null;
  try {
    balance = programBalance(2, date);
  } catch {
    balance = null;
  }
  let acute: Map<MuscleGroup, AcuteGateReading>;
  try {
    acute = acuteGates(date);
  } catch {
    acute = new Map();
  }

  const due = new Set<string>(Array.isArray(balance?.due) ? balance.due : []);
  const over = new Set<string>(Array.isArray(balance?.over) ? balance.over : []);
  const rotationIndex = candidates.findIndex((d) => d.day_number === rotation.day_number);
  // With a lifting week in play the map has ALREADY settled that today is a lifting day,
  // so the only question left open is which strength day — the scorer chooses among
  // those alone, and its recovery penalties stay the tie-breaker inside that set — an
  // empty editor scaffold is never one of them.
  const scorable = candidates.filter((day) => planDayRole(day) === "strength" || !scheduled);
  const scored = scorable.map((day) =>
    scorePlanDay({
      day,
      rotation,
      rotationIndex,
      candidates,
      due,
      over,
      broadLow: !!balance?.broad_low,
      acute,
      last: anchors[0] ?? null,
    })
  );
  // ---- week coverage: a day already trained this week is not an alternative ----
  // With a lifting week in play the week is the unit the athlete programmed. While a
  // strength day is still untrained this week, a day they ALREADY did cannot stand in
  // for today's — the scorer only ever saw the last session, so Monday's Push read as
  // "not just trained" on Wednesday and replaced Lower A, leaving a week of two Push
  // days and no legs. Once every strength day has had its turn, repeats are fair game
  // again (a short pool over five lifting days is SUPPOSED to repeat).
  const doneThisWeek = scheduled ? strengthDaysDoneThisWeek(date, anchors) : new Set<number>();
  const weekStillOpen = scorable.some((day) => !doneThisWeek.has(day.day_number));
  for (const entry of scored) {
    if (weekStillOpen && entry.day_number !== rotation.day_number && doneThisWeek.has(entry.day_number)) {
      entry.done_this_week = true;
      entry.reasons.push("already trained this week");
    }
  }
  const eligible = scored.filter((entry) => !entry.done_this_week);
  const sorted = [...eligible].sort((a, b) => b.score - a.score || a.day_number - b.day_number);
  const rotationScore = scored.find((s) => s.day_number === rotation.day_number) ?? sorted[0];
  const best = sorted[0] ?? rotationScore;
  const materiallyBetter =
    best && rotationScore && best.day_number !== rotation.day_number && best.score >= rotationScore.score + 2.5;
  // When the rotated day is still carrying most of its work, skip FORWARD to the
  // next fresh day in the split. Shopping the whole week for "most due" is how
  // Monday's Lower B became Thursday's Upper mashed with Monday's bench.
  let selectedScore = materiallyBetter ? best : rotationScore;
  if (rotationScore?.mostly_recovering && materiallyBetter) {
    const scorableIndexOf = (dayNumber: number) => scorable.findIndex((day) => day.day_number === dayNumber);
    const rotationAt = scorableIndexOf(rotation.day_number);
    const distance = (dayNumber: number) => {
      const at = scorableIndexOf(dayNumber);
      if (at < 0 || rotationAt < 0 || !scorable.length) return Number.POSITIVE_INFINITY;
      return (at - rotationAt + scorable.length) % scorable.length;
    };
    const viable = eligible.filter(
      (entry) =>
        !entry.mostly_recovering &&
        entry.day_number !== rotation.day_number &&
        entry.score >= rotationScore.score + 2.5
    );
    const nearest = [...viable].sort(
      (a, b) => distance(a.day_number) - distance(b.day_number) || b.score - a.score
    )[0];
    if (nearest) selectedScore = nearest;
  }
  // ---- the week's last lower day is not swapped away (owner ruling, 2026-09-23) ----
  // "Heavy lower once a week." When the lifting week lays no further lower day after
  // today and no genuinely loaded lower session has landed yet this week, handing today
  // to an upper day leaves the week with no leg session at all. The rotation's lower day
  // stays — lighter if the legs are still carrying work (the envelope holds it at the
  // logged load rather than reducing it) — unless the better pick is itself a lower day.
  // Not when every one of its leg groups was loaded THIS morning: the run-morning law
  // moves that work anyway, and a lower day emptied of its legs is no exposure at all.
  let lowerWeekKept = false;
  const legsAllLoadedToday = rotation.groups
    .filter((g) => HEAVY_LOWER_GROUPS.has(g))
    .every((g) => acute.get(g)?.saturated === true && acute.get(g)?.days_ago === 0);
  if (
    scheduled &&
    isHeavyLowerPlanDay(rotation) &&
    !legsAllLoadedToday &&
    selectedScore.day_number !== rotation.day_number
  ) {
    const pick = candidates.find((d) => d.day_number === selectedScore.day_number);
    if (pick && !isHeavyLowerPlanDay(pick)) {
      const lastLowerOpen = (() => {
        try {
          const map = weekdayPlanDayMap(candidates, scheduled.lift_dows, scheduled.strength_start);
          return laterLowerDatesThisWeek(date, map).length === 0 && fullLoadLowerSessionThisWeek(date) == null;
        } catch {
          return false; // an unreadable week keeps the scorer's answer
        }
      })();
      if (lastLowerOpen && rotationScore) {
        selectedScore = rotationScore;
        lowerWeekKept = true;
      }
    }
  }
  const selected = candidates.find((d) => d.day_number === selectedScore.day_number) ?? rotation;
  const adapted = !!materiallyBetter && !lowerWeekKept;
  const reason = adapted ? selectionReason(selectedScore, rotationScore, date) : null;

  return {
    day_number: selected.day_number,
    focus: planDayFocus(selected),
    day_type: selected.day_type,
    selection: {
      selected: { day_number: selected.day_number, focus: planDayFocus(selected) },
      rotation: { day_number: rotation.day_number, focus: planDayFocus(rotation) },
      adapted,
      reason,
      // Omit-when-idle: present only on the morning the week's last lower day was kept.
      ...(lowerWeekKept ? { lower_week: { kept: true } } : {}),
      weekday_schedule: scheduleBlob,
      anchor: anchorBlob,
      last_session: lastSessionBlob,
      due: [...due].slice(0, 8),
      over: [...over].slice(0, 8),
      recent_load: [...acute.values()]
        .map((r) => ({
          group: r.group,
          days_ago: r.days_ago,
          saturated: r.saturated,
          source: r.source,
          activity: r.activity,
        }))
        .slice(0, 8),
      scores: [...sorted, ...scored.filter((entry) => entry.done_this_week)].slice(0, 5),
    },
  };
}

// One server-owned answer to "which programmed day would I train on this date?".
// Reuse the Brief's persisted adaptive answer when available; otherwise derive it
// from the same selector. Validate the referenced day so a deleted plan day cannot
// survive through an old cache row. NULL on a calendar run or rest day (no session
// started): the plan holds no row for it, and the caller asks calendarDayRead / the
// selector's day_type what kind of day it is instead.
export function selectedPlanDayForDate(date: string): SelectedPlanDay | null {
  const candidates = planDayCandidates();
  if (!candidates.length) return null;
  // Once the athlete has started or manually chosen a session, that concrete
  // session outranks the earlier Brief/cache. This keeps chat, REST, MCP, and the
  // Today surface on the same plan day without stealing an explicit selection.
  const session = db.prepare(`SELECT plan_day_id FROM sessions WHERE date = ?`).get(date) as any;
  const sessionDay =
    session?.plan_day_id == null ? null : candidates.find((candidate) => candidate.id === Number(session.plan_day_id));
  if (sessionDay) {
    return {
      date,
      plan_day_id: sessionDay.id,
      day_number: sessionDay.day_number,
      focus: planDayFocus(sessionDay),
      day_type: sessionDay.day_type,
      selection: {
        selected: {
          day_number: sessionDay.day_number,
          focus: planDayFocus(sessionDay),
          day_type: sessionDay.day_type,
        },
      },
      source: "existing-session",
    };
  }
  try {
    // Exclude rows an invalidation marked STALE (day-read-cache.ts) — the same
    // '$._day_read_meta.stale' flag getCachedDayRead hides from every consumer
    // that treats this row as current truth. A stale row still carries yesterday's
    // plan_selection blob; dayRead() has already re-picked, so pinning it here
    // would put the Brief and this selector on different days.
    const row = db
      .prepare(
        `SELECT signals FROM day_reads
          WHERE date = ?
            AND (json_extract(signals, '$._day_read_meta.stale') IS NULL
                 OR json_extract(signals, '$._day_read_meta.stale') = 0)`
      )
      .get(date) as any;
    const signals = row?.signals ? JSON.parse(String(row.signals)) : null;
    const selection = signals?.plan_selection;
    const dayNumber = Number(selection?.selected?.day_number);
    const day = Number.isFinite(dayNumber) ? candidates.find((candidate) => candidate.day_number === dayNumber) : null;
    if (day)
      return {
        date,
        plan_day_id: day.id,
        day_number: day.day_number,
        focus: planDayFocus(day),
        // Read from the LIVE plan row, never from the cached selection blob: the
        // template may have been edited since the Brief was written, and the day's
        // type is the one thing in here that changes what today IS.
        day_type: day.day_type,
        selection,
        source: "cached-day-read",
      };
  } catch {
    // Missing/malformed cache is only a cache miss.
  }
  const selected = selectAdaptivePlanDay(date);
  if (!selected) return null;
  const day = candidates.find((candidate) => candidate.day_number === selected.day_number);
  if (!day) return null;
  return {
    date,
    plan_day_id: day.id,
    day_number: day.day_number,
    focus: planDayFocus(day),
    day_type: day.day_type,
    selection: selected.selection,
    source: "adaptive",
  };
}

// Shared trust-boundary normalizer for REST, MCP, and chat set logging. Omission
// means "use Today's canonical adaptive session"; an own day_number property —
// including null — is an explicit caller choice and is preserved.
export function resolveImplicitPlanDay<T extends object>(input: T): T & { day_number?: number | null } {
  if (Object.hasOwn(input, "day_number")) return input;
  const fields = input as { date?: unknown };
  const date = fields.date ? String(fields.date) : localDateISO();
  // A prepared custom session deliberately has no weekly-template link. Do not
  // let the ordinary implicit logger attach today's adaptive day behind its back.
  // (Explicit day_number remains an athlete-directed override, as before.)
  const custom = db
    .prepare(
      `SELECT id FROM daily_session_compositions
        WHERE date = ? AND status = 'active' AND source IN ('agent_suggest','athlete_override')
        LIMIT 1`
    )
    .get(date);
  if (custom) return { ...input, day_number: null };
  return { ...input, day_number: selectedPlanDayForDate(date)?.day_number };
}

/**
 * The weekday SLOTS (1 = Monday … 7 = Sunday) of `date`'s week that carry a heavy-lower
 * strength day — the axis the run engine reads to keep its hard runs off leg days. With a
 * lifting week known it is the weekday map's answer (a run or rest weekday never lifts);
 * with none, the template convention the engine has always used: plan day N is weekday N.
 */
export function heavyLowerWeekdaySlots(date: string): Set<number> {
  const out = new Set<number>();
  const candidates = planDayCandidates();
  if (!candidates.length) return out;
  const week = thisWeekPlanDayMap(date);
  if (!week.lift_dows.length) {
    for (const day of candidates) {
      if (day.day_number >= 1 && day.day_number <= 7 && isHeavyLowerPlanDay(day)) out.add(day.day_number);
    }
    return out;
  }
  for (const [dow, day] of week.map) {
    if (isHeavyLowerPlanDay(day)) out.add(dow === 0 ? 7 : dow);
  }
  return out;
}

// The hybrid read's forward half (training-read.hybridDayContext): the next STATED run
// weekday and the next heavy-lower day the lifting week lands. Runs never come off the
// plan — the athlete's run days and the run engine own them.
function projectHybridForward(date: string): {
  planned_run_next: { date: string; kind: "easy" | "long" | "quality"; km: number | null } | null;
  heavy_lower_next: { date: string; focus: string | null } | null;
} {
  let planned_run_next: { date: string; kind: "easy" | "long" | "quality"; km: number | null } | null = null;
  let heavy_lower_next: { date: string; focus: string | null } | null = null;
  const runDays = getEnduranceSchedule()?.days ?? [];
  const candidates = planDayCandidates();
  const weeks = new Map<string, ReturnType<typeof thisWeekPlanDayMap>>();
  const index = dayIndexOf(date);
  if (index == null) return { planned_run_next, heavy_lower_next };
  for (let ahead = 1; ahead <= 6 && (!planned_run_next || !heavy_lower_next); ahead++) {
    const fd = new Date((index + ahead) * 86_400_000).toISOString().slice(0, 10);
    const dow = new Date(`${fd}T00:00:00Z`).getUTCDay();
    if (!planned_run_next) {
      const stated = runDays.find((day) => day.dow === dow);
      if (stated) {
        planned_run_next = {
          date: fd,
          kind: stated.kind === "quality" || stated.kind === "long" ? stated.kind : "easy",
          km: null,
        };
      }
    }
    if (!heavy_lower_next && candidates.length) {
      const monday = mondayOf(fd);
      const week = weeks.get(monday) ?? thisWeekPlanDayMap(fd);
      weeks.set(monday, week);
      const day = strengthPlanDayOn(fd, { candidates, weekMap: week });
      if (day && isHeavyLowerPlanDay(day)) heavy_lower_next = { date: fd, focus: planDayFocus(day) };
    }
  }
  return { planned_run_next, heavy_lower_next };
}

registerHybridForwardProjection(projectHybridForward);
