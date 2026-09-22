// Adaptive plan-day selection — pick which programmed day today's "train" read
// should point at. Starts from the historical rotation, then lets logged content,
// volume balance, and acute muscle load adapt the pick when another programmed day
// is clearly smarter. Deterministic + null-safe; never mutates the plan.
//
// Split out of the former intelligence.ts monolith (K4). dayRead / forwardLook (in
// day-read.ts) consume selectAdaptivePlanDay + the helpers re-exported here.
import { db } from "../db.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { canonicalGroup, classifyMuscleGroup, type MuscleGroup, plainGroupWords } from "./exercise-canon.js";
import { type AcuteGateReading, acuteGates, SATURATED_RESIDUAL } from "./hybrid-load.js";
import { statedRunDows } from "./profile.js";
import { programBalance } from "./progression.js";
import { liftDows } from "./strength-schedule.js";
import { daysBetweenISO, joinList, localDateISO } from "./shared.js";

export interface PlanDayCandidate {
  id: number;
  day_number: number;
  name: string;
  focus: string | null;
  // 'rest' is a first-class template value (v99), not an empty training day. It
  // rides in the ROTATION RING like any other day — that is the whole point, the
  // seam has to land where the athlete programmed it — but it never competes on
  // score in either direction, and it never becomes a session anchor.
  day_type: "training" | "rest";
  names: string[];
  groups: MuscleGroup[];
  /**
   * The day's CARDIO item names. `names`/`groups` deliberately exclude cardio (a run is
   * not a muscle group), which left an endurance-only day — "Long Run", nothing else on
   * it — indistinguishable from an empty training-day scaffold. The weekday mapping has
   * to tell those two apart: one belongs on a stated run day, the other is filler.
   */
  cardio: string[];
}

export function isRestPlanDay(day: Pick<PlanDayCandidate, "day_type"> | null | undefined): boolean {
  return day?.day_type === "rest";
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
  const rows = db
    .prepare(
      `SELECT pd.id AS id, pd.day_number AS day_number, pd.name AS day_name, pd.focus AS focus,
            pd.day_type AS day_type,
            pi.kind AS kind, e.name AS exercise, e.muscle_group AS muscle_group
       FROM plan_days pd
       LEFT JOIN plan_items pi ON pi.plan_day_id = pd.id
       LEFT JOIN exercises e ON e.id = pi.exercise_id
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
      day_type: String(r.day_type ?? "training").toLowerCase() === "rest" ? ("rest" as const) : ("training" as const),
      names: [],
      groups: [],
      cardio: [],
    };
    const exercise = r.exercise == null ? "" : String(r.exercise).trim();
    if (exercise && r.kind !== "cardio") {
      if (!cur.names.includes(exercise)) cur.names.push(exercise);
      const group = canonicalGroup(r.muscle_group) ?? classifyMuscleGroup(exercise);
      if (group && group !== "mobility" && !cur.groups.includes(group)) cur.groups.push(group);
    }
    if (r.kind === "cardio") {
      const label = exercise || "Cardio";
      if (!cur.cardio.includes(label)) cur.cardio.push(label);
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
    // A REST day is never an anchor. Training anyway on the programmed rest day
    // creates a session linked to it, and letting that link anchor the rotation
    // would advance the ring off the seam — the athlete's one extra session would
    // shift every following day by one for the rest of the block. Fall through to
    // the content-based resolvers instead, which read what was actually lifted.
    //
    // Nor is a link whose day has since been REWRITTEN: a restructure keeps the
    // session's plan_day_id while the day's content changes, so a squat session
    // stayed "Push" and the ring anchored off a day the athlete never did. The link
    // stands while the day still shares a movement or a muscle with what was logged.
    const stillMatches =
      !!linked &&
      (!linked.names.length ||
        !loggedNames.size ||
        linked.names.some((name) => loggedNames.has(name.toLowerCase())) ||
        linked.groups.some((g) => !NON_DECIDING_GROUPS.has(g) && groups.includes(g)));
    if (linked && !isRestPlanDay(linked) && stillMatches) return { day_number: linked.day_number, method: "linked" };
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

export function nextCandidateAfter(candidates: PlanDayCandidate[], dayNumber: number): PlanDayCandidate {
  const idx = candidates.findIndex((d) => d.day_number === dayNumber);
  return candidates[idx >= 0 ? (idx + 1) % candidates.length : 0];
}

/**
 * The next TRAINING day on the SAME rotation ring, skipping any rest days in between.
 * The one caller today is train-anyway from a programmed rest morning: the athlete
 * overrode the seam, and the day they should be handed is the one their own week was
 * about to give them — not a generic fallback, and not the empty rest day itself.
 * Null when the plan has no training day at all (a week that is nothing but rest).
 */
export function nextTrainingCandidateAfter(candidates: PlanDayCandidate[], dayNumber: number): PlanDayCandidate | null {
  if (!candidates.length) return null;
  let cursor = dayNumber;
  for (let step = 0; step < candidates.length; step++) {
    const next = nextCandidateAfter(candidates, cursor);
    if (!isRestPlanDay(next)) return next;
    cursor = next.day_number;
  }
  return null;
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
// positional mapping runs over the lifting weekdays only. The plan's strength days are
// laid, in ring order, onto the lift weekdays in weekday order; endurance-only plan days
// go on stated run weekdays that are not also lift days; every other weekday gets a rest
// day. An unstated weekday never receives a strength day while the plan holds anything
// else to give it. With no schedule at all, nothing changes.
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
  day_type: "training" | "rest";
  /** Non-cardio item names — a day with any of these is a STRENGTH day. */
  names?: readonly string[];
  /** Cardio item names — a training day with only these is an ENDURANCE-only day. */
  cardio?: readonly string[];
}

export type WeekdayPlanDayRole = "strength" | "endurance" | "rest" | "empty";

export function planDayRole(day: WeekdayMappablePlanDay): WeekdayPlanDayRole {
  if (day.day_type === "rest") return "rest";
  if ((day.names?.length ?? 0) > 0) return "strength";
  if ((day.cardio?.length ?? 0) > 0) return "endurance";
  // A training day with nothing on it is a scaffold, not a session (CLAUDE.md: an empty
  // plan day is never startable). It is not strength, so it can fill an unstated weekday.
  return "empty";
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
 * Lay a plan's days onto the seven weekdays, honoring the athlete's stated schedules.
 *
 * Pure: no DB, no clock, no mutation. Returns `dow -> plan day`, and leaves a weekday
 * OUT of the map when the plan holds nothing suitable for it (the caller then keeps its
 * own fallback rather than being handed a day that contradicts the athlete).
 *
 * `strengthDows` empty means "unstated" — the map comes back empty and every caller
 * falls back to the positional ring, which is exactly the old behavior.
 *
 * The two halves fill DIFFERENTLY, and the difference is the whole design:
 *
 *   The lifting days CYCLE. Five stated lifting weekdays against a plan with three
 *   strength days gives Mon/Tue/Wed the three and Thu/Fri the first two again. Every
 *   stated lifting weekday carries a strength session, because that is the thing the
 *   athlete actually said; a repeat inside one week is a programming question the
 *   scorer and the agent get to answer, not a reason to hand back rest on a day they
 *   told us they lift.
 *
 *   Everything else is CONSUMED, one day each. A week with one "Long Run" and one
 *   "Rest" and two free weekdays gets the long run on one and the rest on the other —
 *   cycling there would invent a second long run out of a plan that authored one, and
 *   an invented session is a worse answer than a quiet rest day.
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
  enduranceDows: readonly number[] | null | undefined,
  strengthStart = 0
): Map<number, T> {
  const map = new Map<number, T>();
  const lift = normalizeDows(strengthDows);
  if (!lift.length || !planDays.length) return map;
  const run = normalizeDows(enduranceDows).filter((dow) => !lift.includes(dow));
  const free = [1, 2, 3, 4, 5, 6, 0].filter((dow) => !lift.includes(dow) && !run.includes(dow));

  const ordered = [...planDays].sort((a, b) => a.day_number - b.day_number);
  const byRole = (role: WeekdayPlanDayRole) => ordered.filter((d) => planDayRole(d) === role);
  const strengthPool = byRole("strength");
  // The three non-strength queues, drained in a preference order that differs per
  // weekday kind. A day leaves its queue when it is placed, so no plan day lands twice
  // while another sits unused.
  const queues: Record<"endurance" | "rest" | "empty", T[]> = {
    endurance: byRole("endurance"),
    rest: byRole("rest"),
    empty: byRole("empty"),
  };
  // The full non-strength set in ring order, kept for the last-resort wrap below.
  const nonStrength = ordered.filter((d) => planDayRole(d) !== "strength");
  let wrap = 0;
  const take = (prefer: readonly ("endurance" | "rest" | "empty")[]): T | undefined => {
    for (const role of prefer) {
      const queue = queues[role];
      if (queue.length) return queue.shift();
    }
    // Every non-strength day is already placed and there are still weekdays to fill.
    // Wrap rather than hand back a strength day — an unstated weekday never becomes a
    // lifting day, which is the entire point of having a stated schedule.
    return nonStrength.length ? nonStrength[wrap++ % nonStrength.length] : undefined;
  };

  // A stated lifting weekday takes a STRENGTH day and nothing else — with no strength
  // day in the plan at all there is nothing honest to put there, so it stays unmapped.
  if (strengthPool.length) {
    const size = strengthPool.length;
    const raw = Number.isFinite(strengthStart) ? Math.trunc(strengthStart) : 0;
    const start = ((raw % size) + size) % size;
    lift.forEach((dow, i) => map.set(dow, strengthPool[(start + i) % size]));
  }
  // A stated run weekday that is not also a lifting day takes the endurance-only day;
  // once those run out, a rest day is the truthful stand-in (the run is not in the plan).
  for (const dow of run) {
    const day = take(["endurance", "rest", "empty"]);
    if (day) map.set(dow, day);
  }
  // Everything else is a weekday they named for neither — rest, or a leftover scaffold.
  for (const dow of free) {
    const day = take(["rest", "empty", "endurance"]);
    if (day) map.set(dow, day);
  }
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
  const map = weekdayPlanDayMap(candidates, lift, statedRunDows(), strength_start);
  return { map, lift_dows: lift, strength_start };
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
    const day = weekdayPlanDayMap(candidates, lift, statedRunDows(), strength_start).get(dow);
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
  const freshDue = dueGroups.filter((g) => !recovering.includes(g) && !isLoaded(g));
  const repeated = lastAge != null && lastAge <= 3 ? day.groups.filter((g) => lastGroups.has(g)) : [];

  let score = day.day_number === rotation.day_number ? 2 : 0;
  score -= distance * 0.25;
  if (!day.groups.length) score -= 0.5;
  // Due credit follows the gate's contract ("do not call it due today"): a
  // saturated group earns none, a loaded one half. Weekly volume can wait a day.
  const dueWeight = broadLow ? 1.2 : 3;
  for (const group of dueGroups) {
    if (recovering.includes(group)) continue;
    score += isLoaded(group) ? dueWeight / 2 : dueWeight;
  }
  if (freshDue.length >= 2) score += 0.75;
  score -= overGroups.length * 2;
  for (const group of recovering) {
    // Graded by how DEEP the residual still is rather than by the calendar: a
    // group carrying half again a session's worth is a harder no than one that
    // has just crossed the line. (Internal magnitude — nothing here is rendered.)
    const gate = acute.get(group);
    score -= gate && gate.residual >= SATURATED_RESIDUAL * 1.5 ? 5 : 3;
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
    mostly_recovering: day.groups.length > 0 && recovering.length * 2 >= day.groups.length,
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

export function selectAdaptivePlanDay(date: string): {
  day_number: number;
  focus: string | null;
  day_type: "training" | "rest";
  selection: Record<string, any>;
} | null {
  const candidates = planDayCandidates();
  if (!candidates.length) return null;
  const anchors = recentSessionAnchors(date, candidates);
  const anchor = anchors.find((a) => a.resolved) ?? null;
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
  const scheduleBlob = scheduled
    ? { lift_days: scheduled.lift_dows, ring_start: scheduled.strength_start, day_number: scheduled.day.day_number }
    : null;

  // ---- the rotation landed on the programmed REST day ----
  // Returned as-is, with no scoring pass at all. The scorer's whole job is "which of
  // the training days fits today best", and there is no version of that question whose
  // answer should be "so train on the rest day instead". Ending here is also what makes
  // the seam stable: run the comparison and a due-heavy week would reopen the rest day
  // every single time it came round, which is how a template ends up with no rest in it.
  // The read this produces is still a SUGGESTION — the athlete can train anyway, and
  // train_anyway carries them through exactly as it does from any other rest morning.
  if (isRestPlanDay(rotation)) {
    return {
      day_number: rotation.day_number,
      focus: planDayFocus(rotation),
      day_type: "rest",
      selection: {
        selected: { day_number: rotation.day_number, focus: planDayFocus(rotation), day_type: "rest" },
        rotation: { day_number: rotation.day_number, focus: planDayFocus(rotation), day_type: "rest" },
        adapted: false,
        reason: null,
        rest_day: true,
        weekday_schedule: scheduleBlob,
        anchor: anchorBlob,
        last_session: lastSessionBlob,
      },
    };
  }

  // ---- the lifting week says today is not a lifting day ----
  // An endurance-only plan day, or a leftover scaffold, on a weekday the athlete did not
  // name for lifting. Returned whole, with no scoring pass, for the same reason the rest
  // day above is: the scorer answers "which STRENGTH day fits today best", and the
  // athlete has already answered the question before it. Letting the scorer run here
  // would quietly put a squat session on the weekday they kept for the long run, which
  // is the exact premise the schedule exists to fix. Still a SUGGESTION — train_anyway
  // carries them onto the next training day from here as from any other quiet morning.
  if (scheduled && planDayRole(rotation) !== "strength") {
    return {
      day_number: rotation.day_number,
      focus: planDayFocus(rotation),
      day_type: rotation.day_type,
      selection: {
        selected: { day_number: rotation.day_number, focus: planDayFocus(rotation), day_type: rotation.day_type },
        rotation: { day_number: rotation.day_number, focus: planDayFocus(rotation) },
        adapted: false,
        reason: null,
        weekday_schedule: scheduleBlob,
        anchor: anchorBlob,
        last_session: lastSessionBlob,
      },
    };
  }

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
  // Only TRAINING days are scored. A rest day carries no groups, so the scorer would
  // read it as a thin, nothing-due day and rank it near the bottom — but "near the
  // bottom" is not the same as "not a candidate", and the day the rotation is pointing
  // at is a training day here. The rest day is not an alternative to it; it is a
  // different question, already answered above.
  //
  // With a lifting week in play the map has ALREADY settled that today is a lifting day,
  // so the only question left open is which strength day — the scorer chooses among
  // those alone, and its recovery penalties stay the tie-breaker inside that set. Swapping
  // out to the long-run day here would undo the week the athlete described.
  const scorable = candidates.filter((day) => (scheduled ? planDayRole(day) === "strength" : !isRestPlanDay(day)));
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
  const sorted = [...scored].sort((a, b) => b.score - a.score || a.day_number - b.day_number);
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
    const viable = scored.filter(
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
  const selected = candidates.find((d) => d.day_number === selectedScore.day_number) ?? rotation;
  const reason = materiallyBetter ? selectionReason(selectedScore, rotationScore, date) : null;

  return {
    day_number: selected.day_number,
    focus: planDayFocus(selected),
    day_type: selected.day_type,
    selection: {
      selected: { day_number: selected.day_number, focus: planDayFocus(selected) },
      rotation: { day_number: rotation.day_number, focus: planDayFocus(rotation) },
      adapted: !!materiallyBetter,
      reason,
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
      scores: sorted.slice(0, 5),
    },
  };
}

// One server-owned answer to "which programmed day would I train on this date?".
// Reuse the Brief's persisted adaptive answer when available; otherwise derive it
// from the same selector. Validate the referenced day so a deleted plan day cannot
// survive through an old cache row.
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
    const row = db.prepare(`SELECT signals FROM day_reads WHERE date = ?`).get(date) as any;
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
