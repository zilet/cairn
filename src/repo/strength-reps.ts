// A bodyweight lift's goal counts REPS, never an estimated max.
//
// A strength objective is normally an estimated-1RM target (Epley on a loaded set). A
// pull-up done at bodyweight has no load to put into Epley: its sets are logged with
// `weight` null (or 0), and an assisted set carries a NEGATIVE weight, the assist
// (CLAUDE.md "Weight encoding"). So the second objective kind, `bodyweight_reps`, reads:
//
//   - a set at bodyweight (weight null or 0) counts its reps;
//   - a set with added load (weight > 0) counts at least its reps;
//   - an ASSISTED set (weight < 0) never counts toward an unassisted goal. It is kept
//     only as the assist it took, so a goal the athlete cannot yet do unassisted still
//     reads progress honestly: less assist is progress.
//
// The goal is either reps in one set ("12 pull-ups") or a number of sets of a rep count
// in one session ("3 × 10"). The measure the journey moves on:
//
//   one set   the best set's reps (uncapped: 13 reps toward a 12-rep goal reads 13);
//   N sets    the best N sets of one session, each counted up to the target reps
//             (10, 10, 7 toward 3 × 10 is 27 of 30), so one huge set never stands in
//             for the sets the goal names. The goal is met when one session has N
//             sets at or above the target reps — exactly when the measure is N × target.
//
// "Now" is the same envelope every lift goal uses: the best measure across the latest
// three exposures within 28 days (strength-objectives.ts `capacityEnvelope`).
//
// Depends only on the DB and the exercise-name resolver, so the set-logging ledger
// (strength-objective-ledger.ts) can read it without the coaching graph.
import { db } from "../db.js";
import { isKnownBodyweightMovement, normalizedExerciseKey, resolveExerciseName } from "./exercise-canon.js";

export const BODYWEIGHT_REPS_KIND = "bodyweight_reps" as const;

/** The envelope's window and depth: the latest three exposures within 28 days. */
export const REPS_ENVELOPE_DAYS = 28;
const REPS_ENVELOPE_DEPTH = 3;

/** Over four weeks, a measure up by at least this many reps moves toward the goal. */
export const REPS_TOWARD = 1;
/** Over four weeks, a measure down by at least this many reps is drifting back. */
export const REPS_BACK = 2;
/** While every set is assisted: this much less assist over four weeks is toward the goal. */
export const ASSIST_TOWARD_LB = 5;
/** While every set is assisted: this much more assist over four weeks is drifting back. */
export const ASSIST_BACK_LB = 10;

export const REPS_TARGET_MAX = 100;
export const SETS_TARGET_MAX = 10;

export interface RepsGoal {
  target_reps: number;
  /** null (or 1) = one set. */
  target_sets: number | null;
}

/** One day of a bodyweight lift. */
export interface RepsExposure {
  date: string;
  /** Reps of every set that counts (bodyweight or loaded), largest first. */
  sets: number[];
  /** The lightest assist logged that day, in lb (positive), null with no assisted set. */
  assist_lb: number | null;
}

export interface RepsPoint {
  value: number;
  sets: number[];
  date: string;
  assist_lb: number | null;
}

function dayNumber(iso: string): number {
  return Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 864e5);
}

export function repsGoalSets(goal: RepsGoal): number {
  const n = Math.trunc(Number(goal.target_sets) || 1);
  return Math.max(1, Math.min(SETS_TARGET_MAX, n));
}

/** The measure's own goal: the target reps for one set, N × target for a sets goal. */
export function repsGoalValue(goal: RepsGoal): number {
  return repsGoalSets(goal) === 1 ? goal.target_reps : goal.target_reps * repsGoalSets(goal);
}

/** The measure of one day against the goal (see the header). 0 when no set counts. */
export function repsMeasure(exposure: Pick<RepsExposure, "sets">, goal: RepsGoal): number {
  const n = repsGoalSets(goal);
  if (!exposure.sets.length) return 0;
  if (n === 1) return exposure.sets[0];
  return exposure.sets.slice(0, n).reduce((sum, reps) => sum + Math.min(reps, goal.target_reps), 0);
}

/** One session met the goal: N sets at or above the target reps. */
export function repsGoalMet(exposure: Pick<RepsExposure, "sets">, goal: RepsGoal): boolean {
  return exposure.sets.filter((reps) => reps >= goal.target_reps).length >= repsGoalSets(goal);
}

function plural(n: number): string {
  return `${n} ${n === 1 ? "rep" : "reps"}`;
}

/** "12 reps" | "3 × 10". */
export function repsGoalText(goal: RepsGoal): string {
  const n = repsGoalSets(goal);
  return n === 1 ? plural(goal.target_reps) : `${n} × ${goal.target_reps}`;
}

/**
 * A day's reading in the goal's own terms: "8 reps" for a one-set goal; the best sets
 * the goal names for a sets goal ("10, 10, 7"). "0 reps" when no set counted.
 */
export function repsNowText(exposure: Pick<RepsExposure, "sets">, goal: RepsGoal): string {
  const n = repsGoalSets(goal);
  if (!exposure.sets.length) return plural(0);
  if (n === 1) return plural(exposure.sets[0]);
  const top = exposure.sets.slice(0, n);
  return top.length === 1 ? plural(top[0]) : top.join(", ");
}

/**
 * A bare measure in words, where the sets themselves are not at hand (a start, a
 * baseline): "8 reps" for a one-set goal, "21 of 30 reps" for a sets goal.
 */
export function repsValueText(value: number, goal: RepsGoal): string {
  return repsGoalSets(goal) === 1 ? plural(value) : `${value} of ${repsGoalValue(goal)} reps`;
}

/** The exact lift's ids: through the one resolver, else every row sharing the key. */
function exactIds(exercise: string): number[] {
  const key = normalizedExerciseKey(exercise);
  if (!key) return [];
  const resolved = resolveExerciseName(exercise).exercise_id;
  if (resolved != null) return [Number(resolved)];
  return (db.prepare(`SELECT id, name FROM exercises`).all() as Array<{ id: number; name: string }>)
    .filter((row) => normalizedExerciseKey(row.name) === key)
    .map((row) => Number(row.id));
}

/** A bodyweight lift's days, oldest first: the reps that count, and the assist taken. */
export function strengthRepsHistory(exercise: string): RepsExposure[] {
  const ids = exactIds(exercise);
  if (!ids.length) return [];
  const rows = db
    .prepare(
      `SELECT s.date AS date, ls.weight AS weight, ls.reps AS reps
         FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE ls.exercise_id IN (${ids.map(() => "?").join(",")}) AND ls.reps > 0
        ORDER BY s.date, ls.id`
    )
    .all(...ids) as Array<{ date: string; weight: number | null; reps: number }>;
  const byDate = new Map<string, RepsExposure>();
  for (const row of rows) {
    const reps = Math.trunc(Number(row.reps));
    if (!(reps > 0)) continue;
    const date = String(row.date);
    const day = byDate.get(date) ?? { date, sets: [], assist_lb: null };
    const weight = row.weight == null ? 0 : Number(row.weight);
    if (weight < 0) {
      const assist = Math.abs(weight);
      day.assist_lb = day.assist_lb == null ? assist : Math.min(day.assist_lb, assist);
    } else day.sets.push(reps);
    byDate.set(date, day);
  }
  for (const day of byDate.values()) day.sets.sort((a, b) => b - a);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function window(history: RepsExposure[], asOf: string): RepsExposure[] {
  const day = dayNumber(asOf);
  return history
    .filter((point) => point.date <= asOf && day - dayNumber(point.date) <= REPS_ENVELOPE_DAYS)
    .slice(-REPS_ENVELOPE_DEPTH);
}

/**
 * The goal's "now" as it stood on `asOf`: the best measure across the latest three
 * exposures within 28 days (a later exposure wins a tie). An assisted-only day is an
 * exposure too, so a goal the athlete can only do assisted reads `value: 0` with the
 * lightest assist of that window — never "no reading".
 */
export function repsEnvelopeAsOf(history: RepsExposure[], goal: RepsGoal, asOf: string): RepsPoint | null {
  const fresh = window(history, asOf);
  if (!fresh.length) return null;
  let best: RepsExposure | null = null;
  for (const point of fresh) if (!best || repsMeasure(point, goal) >= repsMeasure(best, goal)) best = point;
  const assists = fresh.map((point) => point.assist_lb).filter((lb): lb is number => lb != null);
  return {
    value: repsMeasure(best!, goal),
    sets: best!.sets.slice(0, repsGoalSets(goal)),
    date: best!.date,
    assist_lb: assists.length ? Math.min(...assists) : null,
  };
}

/** One exposure as a point (the latest, or the best ever). */
export function repsPoint(exposure: RepsExposure, goal: RepsGoal): RepsPoint {
  return {
    value: repsMeasure(exposure, goal),
    sets: exposure.sets.slice(0, repsGoalSets(goal)),
    date: exposure.date,
    assist_lb: exposure.assist_lb,
  };
}

export type RepsDirection = "toward" | "holding" | "back";

/**
 * The move between two readings four weeks apart: reps first (REPS_TOWARD up, REPS_BACK
 * down); while neither reading has an unassisted rep, the assist (ASSIST_TOWARD_LB less,
 * ASSIST_BACK_LB more). Null when the two cannot be compared.
 */
export function repsDirection(now: RepsPoint | null, ago: RepsPoint | null): RepsDirection | null {
  if (!now || !ago) return null;
  if (now.value > 0 || ago.value > 0) {
    const delta = now.value - ago.value;
    return delta >= REPS_TOWARD ? "toward" : delta <= -REPS_BACK ? "back" : "holding";
  }
  if (now.assist_lb == null || ago.assist_lb == null) return null;
  const less = ago.assist_lb - now.assist_lb;
  return less >= ASSIST_TOWARD_LB ? "toward" : less <= -ASSIST_BACK_LB ? "back" : "holding";
}

/**
 * "25 lb of assist, down from 40" — the assist said in words while no rep counts yet.
 * `load` formats a pound amount in the athlete's unit. Null without an assist reading.
 */
export function assistWords(
  nowLb: number | null | undefined,
  fromLb: number | null | undefined,
  load: (lb: number) => string
): string | null {
  if (nowLb == null || !(nowLb > 0)) return null;
  const now = `${load(nowLb)} of assist`;
  if (fromLb == null || !(fromLb > 0) || Math.round(fromLb) === Math.round(nowLb)) return now;
  return `${now}, ${fromLb > nowLb ? "down" : "up"} from ${load(fromLb).replace(/\s*(?:lb|kg)$/, "")}`;
}

export interface GoalLiftRead {
  /** Done at bodyweight: a stated bodyweight profile, a known bodyweight movement, or a history of unloaded sets only. */
  bodyweight: boolean;
  /** Any logged set carried added load (weight > 0). */
  loaded_sets: boolean;
  mode: string | null;
  mobility: boolean;
}

/**
 * Which kind of goal a lift can hold. A bodyweight lift holds a reps goal; a loaded one
 * an estimated max. A bodyweight lift that has also been logged with added load (a
 * weighted pull-up day) may hold either. A name alone never says "loaded": a lift with
 * no history and no bodyweight signal is simply unknown, so it is not bodyweight.
 */
export function goalLiftRead(exerciseId: number | null, name: string): GoalLiftRead {
  const row =
    exerciseId == null
      ? null
      : (db.prepare(`SELECT name, mode, equipment, input_profile FROM exercises WHERE id = ?`).get(exerciseId) as
          | { name: string; mode: string | null; equipment: string | null; input_profile: string | null }
          | undefined);
  const counts =
    exerciseId == null
      ? { loaded: 0, unloaded: 0 }
      : ((db
          .prepare(
            `SELECT SUM(CASE WHEN weight > 0 THEN 1 ELSE 0 END) AS loaded,
                    SUM(CASE WHEN weight IS NULL OR weight <= 0 THEN 1 ELSE 0 END) AS unloaded
               FROM logged_sets WHERE exercise_id = ? AND reps > 0`
          )
          .get(exerciseId) as { loaded: number | null; unloaded: number | null }) ?? { loaded: 0, unloaded: 0 });
  const loaded = Number(counts.loaded) || 0;
  const unloaded = Number(counts.unloaded) || 0;
  const stated = String(row?.input_profile ?? "").toLowerCase();
  const liftName = row?.name ?? name;
  const bodyweight =
    stated === "bodyweight" ||
    (stated !== "loaded" &&
      stated !== "mobility" &&
      (isKnownBodyweightMovement(liftName, row?.equipment ?? null) || (loaded === 0 && unloaded > 0)));
  return { bodyweight, loaded_sets: loaded > 0, mode: row?.mode ?? null, mobility: stated === "mobility" };
}

export function parseRepsGoal(input: { target_reps?: unknown; target_sets?: unknown }): RepsGoal {
  const reps = Number(input.target_reps);
  if (!Number.isInteger(reps) || reps < 1 || reps > REPS_TARGET_MAX)
    throw new Error(`target_reps must be a whole number from 1 to ${REPS_TARGET_MAX}`);
  const rawSets = input.target_sets;
  if (rawSets == null || rawSets === "") return { target_reps: reps, target_sets: null };
  const sets = Number(rawSets);
  if (!Number.isInteger(sets) || sets < 1 || sets > SETS_TARGET_MAX)
    throw new Error(`target_sets must be a whole number from 1 to ${SETS_TARGET_MAX}`);
  return { target_reps: reps, target_sets: sets === 1 ? null : sets };
}

/** An objective row as a reps goal, or null when it is not one. */
export function repsGoalOf(objective: {
  target_kind?: string | null;
  target_reps?: number | null;
  target_sets?: number | null;
}): RepsGoal | null {
  if (objective?.target_kind !== BODYWEIGHT_REPS_KIND) return null;
  const reps = Number(objective.target_reps);
  if (!(reps > 0)) return null;
  const sets = objective.target_sets == null ? null : Number(objective.target_sets);
  return { target_reps: reps, target_sets: sets != null && sets > 1 ? sets : null };
}
