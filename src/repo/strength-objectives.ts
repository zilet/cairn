// Explicit anchor-lift objectives and their deterministic comeback reads.
//
// This is deliberately narrower than program-state: the athlete selects an exact
// exercise (canonicalised through resolveExerciseName), its target is snapped at
// selection time, and every trend/projection reads that exact exercise (never movementKey). Barbell and dumbbell histories therefore
// remain separate even when they train the same movement pattern.
//
// ONE EXCEPTION, AND IT IS RECORDED, NOT GUESSED: when the plan swapped the objective's
// exercise for a same-pattern variant, the goal follows the movement (the carry,
// strength-objective-carry.ts). The journey then reads the replacement's sets from the
// swap day on, says so in `tracked`, and takes its prescription, lift state and support
// from the lift actually trained.
//
// SEVERAL ANCHORS MAY BE ACTIVE AT ONCE. Rebuilding six lifts in parallel is one
// goal, not six competing ones, so the invariant is one active row PER exercise_key
// (schema v98) — never one active row overall. `getStrengthJourney()` still reads the
// primary (most recent) anchor for the single-journey surfaces; `getStrengthJourneys()`
// is the whole set, and every journey also carries `active_objectives`.
//
// TWO GOAL KINDS. An est-1RM goal (return_to_personal_best | explicit_est_1rm) reads the
// lift's Epley on loaded sets. A bodyweight lift's goal is `bodyweight_reps`: reps in one
// set, or N sets of a rep count in one session (strength-reps.ts). A reps goal stores 0
// in `target_est_1rm` (SQLite cannot drop that column's NOT NULL), so every reader
// branches on `target_kind` (or on `journey.reps`) BEFORE it reads an est-1RM field. A
// reps journey carries `reps` and leaves every est-1RM field null.
import { db } from "../db.js";
import { getAppState, setAppState } from "./app-state.js";
import { classifyConstraint, normalizedExerciseKey, resolveExerciseName } from "./exercise-canon.js";
import { classifyPattern, type Equipment, type MovementPattern } from "./exercise-variations.js";
import { injuryAffectsExercise, listContextEvents } from "./health.js";
import { availableEquipment } from "./equipment.js";
import { nextPrescription, recentAutoregulation, type Prescription } from "./progression.js";
import { painAreaLoadsExercise } from "./pain-relevance.js";
import { getProgramState, type LiftState, type ProgramState } from "./program-state.js";
import { localDateISO } from "./shared.js";
import { strengthObjectiveCarry, type StrengthObjectiveCarry } from "./strength-objective-carry.js";
import {
  BODYWEIGHT_REPS_KIND,
  goalLiftRead,
  parseRepsGoal,
  repsDirection,
  repsEnvelopeAsOf,
  repsGoalMet,
  repsGoalOf,
  repsGoalText,
  repsGoalValue,
  repsMeasure,
  repsNowText,
  repsPoint,
  strengthRepsHistory,
  type RepsDirection,
  type RepsGoal,
  type RepsPoint,
} from "./strength-reps.js";
import { round1, round5 } from "../lib/numbers.js";

export type StrengthObjectiveTargetKind = "return_to_personal_best" | "explicit_est_1rm" | "bodyweight_reps";
export type StrengthObjectiveStatus = "active" | "superseded" | "completed" | "archived";

export interface StrengthObjective {
  id: number;
  exercise: string;
  exercise_key: string;
  target_kind: StrengthObjectiveTargetKind;
  /** 0 on a bodyweight_reps goal: read target_kind first. */
  target_est_1rm: number;
  baseline_est_1rm: number | null;
  baseline_date: string | null;
  source: "user";
  status: StrengthObjectiveStatus;
  created_at: string;
  updated_at: string;
  superseded_at: string | null;
  completed_at: string | null;
  achieved_est_1rm: number | null;
  achieved_date: string | null;
  // A bodyweight_reps goal only (null on an est-1RM goal): reps in one set, or
  // target_sets sets of target_reps in one session (strength-reps.ts).
  target_reps?: number | null;
  target_sets?: number | null;
  baseline_reps?: number | null;
  achieved_reps?: number | null;
}

/**
 * A bodyweight lift's REPS goal, read (strength-reps.ts). `value` is the goal's measure:
 * the best set's reps for a one-set goal, the best sets of one session (each up to the
 * target) for a sets goal. An assisted set never counts; while nothing counts yet the
 * reading is `value: 0` with `assist_lb` the lightest assist, so less assist reads as
 * progress.
 */
export interface StrengthRepsJourney {
  target_reps: number;
  target_sets: number | null;
  goal_value: number;
  goal_text: string;
  now: (RepsPoint & { text: string }) | null;
  latest: (RepsPoint & { text: string }) | null;
  best: (RepsPoint & { text: string }) | null;
  baseline: { value: number; date: string | null } | null;
  /** The same envelope 28 days back, for the four-week move. */
  four_weeks_ago: (RepsPoint & { as_of: string }) | null;
  direction: RepsDirection | null;
  /** The assist at the goal's start (its first envelope), while nothing counts yet. */
  start_assist_lb: number | null;
}

export interface StrengthExposure {
  date: string;
  top_weight: number;
  top_reps: number;
  est_1rm: number;
}

export interface StrengthSupportRole {
  role: string;
  exercise: string;
  why: string;
  plan_day_number: number;
  plan_day_name: string;
}

export interface StrengthJourneyProjection {
  earliest_weeks: number;
  latest_weeks: number;
  basis: string;
  caveat: string;
}

export interface StrengthJourney {
  available: boolean;
  objective: StrengthObjective | null;
  latest: { est_1rm: number; date: string } | null;
  current: { est_1rm: number; date: string } | null;
  best: { est_1rm: number; date: string } | null;
  baseline: { est_1rm: number; date: string | null } | null;
  gap_lb: number | null;
  trend: {
    direction: "rising" | "stable" | "falling" | null;
    est_1rm_lb_per_week: number | null;
    exposures: number;
    span_days: number;
  };
  phase: "establishing" | "rebuilding" | "building" | "consolidating" | "protecting" | "reached" | null;
  next_prescription: Prescription | null;
  planned_support: StrengthSupportRole[];
  support_suggestions: StrengthSupportRole[];
  projection: StrengthJourneyProjection | null;
  projection_withheld_reason: string | null;
  safety: {
    load_constraint: boolean;
    recent_joint_pain: string | null;
    relevant_joint_pain: string | null;
    relevant_active_injuries: string[];
    stalled_or_regressing: boolean;
  };
  capacity_basis: string | null;
  // Set only while the goal is CARRIED: the plan swapped the objective's exercise for a
  // same-pattern variant, so `exercise` is the lift now trained and counted, `from` the
  // objective's own, `since` the swap day. Null (or absent) while the goal reads its own lift.
  tracked?: { exercise: string; from: string; since: string } | null;
  // Set only on a bodyweight_reps goal; then latest/current/best/baseline/gap_lb are null.
  reps?: StrengthRepsJourney | null;
  // Every anchor the athlete currently holds, newest first — the journey above reads
  // ONE of them (the primary), and this is the parallel set the coach context and the
  // prompt sites need so a six-anchor rebuild never reads as a single-lift goal.
  active_objectives: StrengthObjective[];
  // Populated by the surfaces (route/MCP) only when NO objective exists yet — a
  // quiet invitation into the anchor-lift journey. Left unset elsewhere.
  suggestion?: AnchorObjectiveSuggestion | null;
}

// A ready-to-start anchor-lift objective proposed from logged history. Its fields
// map straight onto the existing create path (setStrengthObjective).
export interface AnchorObjectiveSuggestion {
  exercise: string;
  target_kind: StrengthObjectiveTargetKind;
  target_est_1rm: number;
  current_est_1rm: number | null;
  gap_lb: number | null;
  title: string;
  detail: string;
  basis: string;
}

// The standards-read capacity shape this module consumes. Injected by the caller
// (the REST/MCP surface, which may safely import performance.ts) so this module
// never imports the performance/standards layer — that would close a cycle
// (performance -> coach -> strength-objectives).
export interface AnchorCapacityInput {
  exercise: string;
  label?: string | null;
  est_1rm: number;
  level?: string | null;
  to_next?: { level: string; lb: number } | null;
}

function asObjective(row: any): StrengthObjective | null {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    target_est_1rm: Number(row.target_est_1rm),
    baseline_est_1rm: row.baseline_est_1rm == null ? null : Number(row.baseline_est_1rm),
    achieved_est_1rm: row.achieved_est_1rm == null ? null : Number(row.achieved_est_1rm),
    target_reps: row.target_reps == null ? null : Number(row.target_reps),
    target_sets: row.target_sets == null ? null : Number(row.target_sets),
    baseline_reps: row.baseline_reps == null ? null : Number(row.baseline_reps),
    achieved_reps: row.achieved_reps == null ? null : Number(row.achieved_reps),
    source: "user",
  } as StrengthObjective;
}

export function listStrengthObjectives(limit = 50): StrengthObjective[] {
  const n = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 50)));
  return (db.prepare(`SELECT * FROM strength_objectives ORDER BY id DESC LIMIT ?`).all(n) as any[])
    .map(asObjective)
    .filter((row): row is StrengthObjective => !!row);
}

export function getStrengthObjective(id: number): StrengthObjective | null {
  return asObjective(db.prepare(`SELECT * FROM strength_objectives WHERE id = ?`).get(Number(id)));
}

/** Every active anchor, newest first. One row per lift by construction (schema v98). */
export function listActiveStrengthObjectives(): StrengthObjective[] {
  return (db.prepare(`SELECT * FROM strength_objectives WHERE status = 'active' ORDER BY id DESC`).all() as any[])
    .map(asObjective)
    .filter((row): row is StrengthObjective => !!row);
}

/**
 * The PRIMARY active anchor — the most recently chosen one. Kept for the single-journey
 * surfaces; anything that must honour every anchor reads listActiveStrengthObjectives().
 */
export function getActiveStrengthObjective(): StrengthObjective | null {
  return listActiveStrengthObjectives()[0] ?? null;
}

/** The active objective for one exact lift, if the athlete holds one. */
export function getActiveStrengthObjectiveForExercise(exercise: string): StrengthObjective | null {
  const key = normalizedExerciseKey(String(exercise ?? ""));
  if (!key) return null;
  return asObjective(
    db
      .prepare(
        `SELECT * FROM strength_objectives WHERE status = 'active' AND exercise_key = ? ORDER BY id DESC LIMIT 1`
      )
      .get(key)
  );
}

function epley(weight: number, reps: number): number {
  return round1(weight * (1 + reps / 30));
}

function objectiveExerciseName(raw: unknown): {
  exercise: string;
  key: string;
  mode: string | null;
  exercise_id: number | null;
} {
  const supplied = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!supplied || !normalizedExerciseKey(supplied)) throw new Error("exercise required");
  // Through the ONE resolver, so "Bench Press" anchors on the athlete's Barbell Bench
  // Press rather than a key no logged set carries. The resolver only takes a unique
  // hit, so barbell and dumbbell histories still never merge.
  const resolved = resolveExerciseName(supplied);
  const existing =
    resolved.exercise_id == null
      ? null
      : (db.prepare(`SELECT name, mode FROM exercises WHERE id = ?`).get(resolved.exercise_id) as
          | { name: string; mode: string | null }
          | undefined);
  const exercise = existing?.name ?? supplied;
  return {
    exercise,
    key: normalizedExerciseKey(exercise),
    mode: existing?.mode ?? null,
    exercise_id: existing ? Number(resolved.exercise_id) : null,
  };
}

// Exact normalized-exercise history. This intentionally does NOT use movementKey:
// "Incline DB Press" cannot contribute to "Incline Barbell Bench Press" here.
export function strengthObjectiveHistory(exercise: string): StrengthExposure[] {
  const key = normalizedExerciseKey(exercise);
  if (!key) return [];
  const resolvedId = resolveExerciseName(exercise).exercise_id;
  const ids =
    resolvedId != null
      ? [Number(resolvedId)]
      : (db.prepare(`SELECT id, name FROM exercises`).all() as Array<{ id: number; name: string }>)
          .filter((row) => normalizedExerciseKey(row.name) === key)
          .map((row) => Number(row.id));
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT s.date AS date, ls.weight AS weight, ls.reps AS reps
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id IN (${placeholders}) AND ls.weight > 0 AND ls.reps > 0
      ORDER BY s.date, ls.id`
    )
    .all(...ids) as any[];
  const byDate = new Map<string, StrengthExposure>();
  for (const row of rows) {
    const weight = Number(row.weight);
    const reps = Number(row.reps);
    if (!(weight > 0) || !(reps > 0)) continue;
    const point: StrengthExposure = {
      date: String(row.date),
      top_weight: weight,
      top_reps: reps,
      est_1rm: epley(weight, reps),
    };
    const current = byDate.get(point.date);
    if (!current || point.est_1rm > current.est_1rm) byDate.set(point.date, point);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The history an objective is judged on: its own exact lift, plus — while the goal is
 * carried through a recorded swap — the replacement's sets from the swap day onward.
 * One point per day (the better estimate). With no carry this IS the exact-lift history.
 */
export function strengthObjectiveTrackedHistory(
  objective: Pick<StrengthObjective, "exercise" | "exercise_key"> & { target_kind?: string | null },
  carry: StrengthObjectiveCarry | null = strengthObjectiveCarry(objective)
): StrengthExposure[] {
  const own = strengthObjectiveHistory(objective.exercise);
  if (!carry) return own;
  const byDate = new Map(own.map((point) => [point.date, point]));
  for (const point of strengthObjectiveHistory(carry.exercise)) {
    if (point.date < carry.since) continue;
    const current = byDate.get(point.date);
    if (!current || point.est_1rm > current.est_1rm) byDate.set(point.date, point);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function setStrengthObjective(input: {
  exercise: unknown;
  target_kind: unknown;
  target_est_1rm?: unknown;
  target_reps?: unknown;
  target_sets?: unknown;
}): StrengthObjective {
  const { exercise, key, mode, exercise_id } = objectiveExerciseName(input.exercise);
  if (mode === "timed") throw new Error("strength objectives require a reps-based exercise with estimated-1RM history");
  const targetKind = String(input.target_kind ?? "") as StrengthObjectiveTargetKind;
  if (targetKind !== "return_to_personal_best" && targetKind !== "explicit_est_1rm" && targetKind !== BODYWEIGHT_REPS_KIND)
    throw new Error("target_kind must be return_to_personal_best, explicit_est_1rm or bodyweight_reps");
  const lift = goalLiftRead(exercise_id, exercise);
  if (targetKind === BODYWEIGHT_REPS_KIND) {
    if (!lift.bodyweight)
      throw new Error(
        `A reps goal is for a lift done at bodyweight, like a pull-up. ${exercise} is a loaded lift, so its goal is an estimated max instead.`
      );
    return insertRepsObjective(exercise, key, parseRepsGoal(input));
  }
  if (lift.bodyweight && !lift.loaded_sets)
    throw new Error(
      `${exercise} is done at bodyweight, so its goal counts reps rather than an estimated max. Set a reps goal instead (for example 12 reps, or 3 × 10).`
    );
  const history = strengthObjectiveHistory(exercise);
  const latest = history.at(-1) ?? null;
  const allTimeBest = history.reduce<StrengthExposure | null>(
    (best, point) => (!best || point.est_1rm > best.est_1rm ? point : best),
    null
  );
  let target: number;
  if (targetKind === "return_to_personal_best") {
    if (!allTimeBest) throw new Error("return_to_personal_best requires logged history for that exact exercise");
    target = allTimeBest.est_1rm;
  } else {
    target = Number(input.target_est_1rm);
    if (!Number.isFinite(target) || target <= 0 || target > 5000)
      throw new Error("target_est_1rm must be a positive realistic number");
    target = round1(target);
  }
  const reached = capacityEnvelope(history);
  const alreadyReached = !!reached && reached.est_1rm >= target;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Per-lift supersede: naming a new squat target retires the old SQUAT objective
    // and leaves every other anchor the athlete is rebuilding exactly where it is.
    db.prepare(
      `UPDATE strength_objectives
          SET status = 'superseded', superseded_at = datetime('now'), updated_at = datetime('now')
        WHERE status = 'active' AND exercise_key = ?`
    ).run(key);
    const info = db
      .prepare(
        `INSERT INTO strength_objectives
        (exercise, exercise_key, target_kind, target_est_1rm, baseline_est_1rm, baseline_date, source, status,
         completed_at, achieved_est_1rm, achieved_date)
       VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, ?)`
      )
      .run(
        exercise,
        key,
        targetKind,
        target,
        latest?.est_1rm ?? null,
        latest?.date ?? null,
        alreadyReached ? "completed" : "active",
        alreadyReached ? new Date().toISOString() : null,
        alreadyReached ? reached.est_1rm : null,
        alreadyReached ? reached.date : null
      );
    db.exec("COMMIT");
    return getStrengthObjective(Number(info.lastInsertRowid))!;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * The reps-goal create path. The same per-lift supersede as an est-1RM goal; the target is
 * the athlete's stated reps (and sets), snapped now; `baseline_reps` is the measure of the
 * latest exposure. A goal the fresh envelope already meets is recorded completed at once.
 */
function insertRepsObjective(exercise: string, key: string, goal: RepsGoal): StrengthObjective {
  const history = strengthRepsHistory(exercise);
  const latest = history.at(-1) ?? null;
  const today = localDateISO();
  const fresh = history.filter((point) => point.date <= today && dayNumber(today) - dayNumber(point.date) <= 28).slice(-3);
  const met = [...fresh].reverse().find((point) => repsGoalMet(point, goal)) ?? null;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE strength_objectives
          SET status = 'superseded', superseded_at = datetime('now'), updated_at = datetime('now')
        WHERE status = 'active' AND exercise_key = ?`
    ).run(key);
    // target_est_1rm is NOT NULL in the schema and SQLite cannot drop that by ALTER: a
    // reps goal stores 0 there, and every reader branches on target_kind first.
    const info = db
      .prepare(
        `INSERT INTO strength_objectives
        (exercise, exercise_key, target_kind, target_est_1rm, baseline_est_1rm, baseline_date, source, status,
         completed_at, achieved_est_1rm, achieved_date, target_reps, target_sets, baseline_reps, achieved_reps)
       VALUES (?, ?, ?, 0, NULL, ?, 'user', ?, ?, NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        exercise,
        key,
        BODYWEIGHT_REPS_KIND,
        latest?.date ?? null,
        met ? "completed" : "active",
        met ? new Date().toISOString() : null,
        met ? met.date : null,
        goal.target_reps,
        goal.target_sets,
        latest ? repsMeasure(latest, goal) : null,
        met ? repsMeasure(met, goal) : null
      );
    db.exec("COMMIT");
    return getStrengthObjective(Number(info.lastInsertRowid))!;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function setStrengthObjectiveStatus(
  id: number,
  status: Exclude<StrengthObjectiveStatus, "superseded">
): StrengthObjective | null {
  if (!(["active", "completed", "archived"] as string[]).includes(status))
    throw new Error("invalid strength objective status");
  const current = getStrengthObjective(id);
  if (!current) return null;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (status === "active") {
      // Only the other active objective ON THE SAME LIFT is in the way — reactivating a
      // superseded bench objective must not retire the athlete's live squat anchor.
      db.prepare(
        `UPDATE strength_objectives SET status='superseded', superseded_at=datetime('now'), updated_at=datetime('now')
          WHERE status='active' AND exercise_key = ? AND id != ?`
      ).run(current.exercise_key, id);
    }
    db.prepare(
      `UPDATE strength_objectives SET status=?, updated_at=datetime('now'),
        superseded_at=CASE WHEN ?='active' THEN NULL ELSE superseded_at END WHERE id=?`
    ).run(status, status, id);
    db.exec("COMMIT");
    return getStrengthObjective(id);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function dayNumber(iso: string): number {
  return Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 864e5);
}

function slopePerWeek(points: StrengthExposure[]): number | null {
  if (points.length < 2) return null;
  const base = dayNumber(points[0].date);
  const xy = points.map((point) => ({ x: dayNumber(point.date) - base, y: point.est_1rm }));
  const mx = xy.reduce((sum, point) => sum + point.x, 0) / xy.length;
  const my = xy.reduce((sum, point) => sum + point.y, 0) / xy.length;
  const numerator = xy.reduce((sum, point) => sum + (point.x - mx) * (point.y - my), 0);
  const denominator = xy.reduce((sum, point) => sum + (point.x - mx) ** 2, 0);
  return denominator === 0 ? null : round1((numerator / denominator) * 7);
}

type PlannedExercise = {
  name: string;
  muscle_group: string | null;
  constraint_note: string | null;
  equipment: string | null;
  day_number: number;
  day_name: string;
};

function plannedExercises(): PlannedExercise[] {
  return (
    db
      .prepare(
        `SELECT e.name, e.muscle_group, e.constraint_note, e.equipment, pd.day_number, pd.name AS day_name
       FROM plan_items pi JOIN exercises e ON e.id=pi.exercise_id
       JOIN plan_days pd ON pd.id=pi.plan_day_id
      WHERE COALESCE(pi.kind,'strength') != 'cardio' ORDER BY pi.plan_day_id, pi.position`
      )
      .all() as PlannedExercise[]
  ).map((row) => ({ ...row, day_number: Number(row.day_number) }));
}

function objectivePattern(exercise: string): MovementPattern | null {
  const row = db.prepare(`SELECT muscle_group FROM exercises WHERE name = ? COLLATE NOCASE LIMIT 1`).get(exercise) as
    | { muscle_group?: string | null }
    | undefined;
  const classified = classifyPattern(exercise, row?.muscle_group ?? undefined);
  if (classified) return classified;
  // Names such as "Incline DB Press" contain an implement between the angle and
  // the movement word, so the generic variation classifier can miss them. Keep
  // this local fallback deliberately narrow: it only decides which assistance
  // roles surround the athlete-selected anchor and never merges lift history.
  if (
    /\b(?:flat|incline|decline|bench|chest)\b.*\b(?:press|bench)\b|\b(?:press|bench)\b.*\b(?:flat|incline|decline|bench|chest)\b/i.test(
      exercise
    )
  )
    return "horizontal-push";
  return null;
}

const SUPPORT: Partial<Record<MovementPattern, Array<{ role: string; candidates: string[]; why: string }>>> = {
  "horizontal-push": [
    {
      role: "upper back",
      candidates: ["Chest-Supported Row", "Seated Cable Row", "DB Row"],
      why: "Builds the stable upper-back shelf and control the press needs.",
    },
    {
      role: "triceps",
      candidates: ["Tricep Pushdown", "Rope Pushdown", "Triceps Rope Pushdown", "Cable Overhead Tricep Extension"],
      why: "Builds lockout strength without adding another chest-press slot.",
    },
    {
      role: "trunk",
      candidates: ["Pallof Press", "Dead Bug", "Plank"],
      why: "Builds bracing so force transfers cleanly through the bench.",
    },
  ],
  "vertical-push": [
    {
      role: "upper back",
      candidates: ["Chest-Supported Row", "Seated Cable Row"],
      why: "Supports shoulder-blade control around the anchor press.",
    },
    {
      role: "triceps",
      candidates: ["Tricep Pushdown", "Rope Pushdown", "Triceps Rope Pushdown", "Cable Overhead Tricep Extension"],
      why: "Builds the finish of the press without duplicating the anchor.",
    },
    { role: "trunk", candidates: ["Pallof Press", "Dead Bug"], why: "Keeps the torso stable while pressing overhead." },
  ],
  squat: [
    {
      role: "posterior chain",
      candidates: ["Romanian Deadlift", "Leg Curl"],
      why: "Supports hip drive and balance around the squat.",
    },
    {
      role: "trunk",
      candidates: ["Pallof Press", "Dead Bug", "Plank"],
      why: "Builds the brace that keeps the anchor lift organized.",
    },
    {
      role: "single-leg control",
      candidates: ["Reverse Lunge", "Step-Up"],
      why: "Builds side-to-side control with less anchor-lift fatigue.",
    },
  ],
  hinge: [
    {
      role: "upper back",
      candidates: ["Chest-Supported Row", "Lat Pulldown"],
      why: "Builds the upper-back position that keeps the pull connected.",
    },
    {
      role: "trunk",
      candidates: ["Pallof Press", "Dead Bug"],
      why: "Builds bracing without another heavy hinge exposure.",
    },
    {
      role: "single-leg control",
      candidates: ["Reverse Lunge", "Step-Up"],
      why: "Builds lower-body control without duplicating the pull.",
    },
  ],
};

function relevantActiveInjuries(exercise: { name: string; muscle_group: string | null }): any[] {
  return (listContextEvents({ activeOnly: true }) as any[]).filter(
    (event) => event?.kind === "injury" && !event?.likely_resolved && injuryAffectsExercise(event, exercise)
  );
}

function inferredEquipment(item: PlannedExercise): Equipment | null {
  const stored = String(item.equipment || "").toLowerCase();
  if (/barbell/.test(stored)) return "barbell";
  if (/dumbbell/.test(stored)) return "dumbbell";
  if (/cable|pulley/.test(stored)) return "cable";
  if (/machine|smith/.test(stored)) return "machine";
  if (/kettlebell/.test(stored)) return "kettlebell";
  if (/bodyweight/.test(stored)) return "bodyweight";
  const name = item.name.toLowerCase();
  if (/\b(?:db|dumbbell)\b/.test(name)) return "dumbbell";
  if (/\b(?:barbell|bench press|back squat|front squat|deadlift)\b/.test(name)) return "barbell";
  if (/\b(?:cable|pushdown|pallof)\b/.test(name)) return "cable";
  if (/\b(?:machine|pulldown|leg press|leg curl)\b/.test(name)) return "machine";
  if (/\b(?:plank|dead bug|push-up|pull-up)\b/.test(name)) return "bodyweight";
  return null;
}

function plannedSupportFor(exercise: string, recentPain: string | null): StrengthSupportRole[] {
  const pattern = objectivePattern(exercise);
  const specs = (pattern && SUPPORT[pattern]) || [
    {
      role: "trunk",
      candidates: ["Pallof Press", "Dead Bug", "Plank"],
      why: "Builds a stable base for the anchor lift.",
    },
  ];
  const planned = plannedExercises();
  const equipment = availableEquipment();
  const out: StrengthSupportRole[] = [];
  for (const spec of specs) {
    const chosen = planned.find((item) =>
      spec.candidates.some((candidate) => normalizedExerciseKey(item.name) === normalizedExerciseKey(candidate))
    );
    if (!chosen) continue;
    // A horizontal-press objective never receives another horizontal press as
    // "support" — flat/incline and barbell/DB variants remain distinct main work.
    if (
      pattern === "horizontal-push" &&
      classifyPattern(chosen.name, chosen.muscle_group ?? undefined) === "horizontal-push"
    )
      continue;
    if (normalizedExerciseKey(chosen.name) === normalizedExerciseKey(exercise)) continue;
    if (classifyConstraint(chosen.constraint_note) === "load") continue;
    const needed = inferredEquipment(chosen);
    if (equipment.length && needed && !equipment.includes(needed)) continue;
    if (recentPain && painAreaLoadsExercise(recentPain, chosen)) continue;
    if (relevantActiveInjuries(chosen).length) continue;
    out.push({
      role: spec.role,
      exercise: chosen.name,
      why: spec.why,
      plan_day_number: chosen.day_number,
      plan_day_name: chosen.day_name,
    });
    if (out.length >= 3) break;
  }
  return out;
}

// Current capacity is the best exact-lift estimate across the latest three
// exposures, provided that evidence is still fresh. This small rolling envelope
// keeps a deliberate light technique/deload session from masquerading as lost
// capacity while still aging out quickly enough to require a new checkpoint.
function capacityEnvelope(history: StrengthExposure[]): StrengthExposure | null {
  return bestOfLatestThree(history.filter((point) => dayNumber(localDateISO()) - dayNumber(point.date) <= 28));
}

/**
 * The same envelope as it stood on `asOf` (exposures on or before it): the ONE
 * definition of a lift's "now", read back in time — the week page's "four weeks ago"
 * ring for a strength goal reads this, never a single day's Epley.
 */
export function capacityEnvelopeAsOf(history: StrengthExposure[], asOf: string): StrengthExposure | null {
  const day = dayNumber(asOf);
  return bestOfLatestThree(history.filter((point) => point.date <= asOf && day - dayNumber(point.date) <= 28));
}

function bestOfLatestThree(eligible: StrengthExposure[]): StrengthExposure | null {
  const fresh = eligible.slice(-3);
  return fresh.reduce<StrengthExposure | null>(
    (best, point) => (!best || point.est_1rm > best.est_1rm ? point : best),
    null
  );
}

function envelopeSeries(history: StrengthExposure[]): StrengthExposure[] {
  return history.map((_point, index) => {
    const window = history.slice(Math.max(0, index - 2), index + 1);
    return window.reduce((best, point) => (point.est_1rm > best.est_1rm ? point : best));
  });
}

function currentJourneyObjective(exercise?: string | null): StrengthObjective | null {
  const key = exercise == null ? null : normalizedExerciseKey(String(exercise));
  if (exercise != null && !key) return null;
  if (key) {
    return (
      getActiveStrengthObjectiveForExercise(String(exercise)) ??
      asObjective(
        db
          .prepare(
            `SELECT * FROM strength_objectives WHERE status='completed' AND exercise_key=? ORDER BY id DESC LIMIT 1`
          )
          .get(key)
      )
    );
  }
  return (
    getActiveStrengthObjective() ??
    asObjective(db.prepare(`SELECT * FROM strength_objectives WHERE status='completed' ORDER BY id DESC LIMIT 1`).get())
  );
}

function exactLiftState(exercise: string, programState: ProgramState): LiftState | null {
  const key = normalizedExerciseKey(exercise);
  return (programState.lifts || []).find((lift) => normalizedExerciseKey(lift.exercise) === key) ?? null;
}

export function getStrengthJourney(
  opts: { programState?: ProgramState; exercise?: string | null; activeObjectives?: StrengthObjective[] } = {}
): StrengthJourney {
  // The active set is identical for every journey in one read, so getStrengthJourneys()
  // threads its single query through here exactly as it threads the program state.
  const activeObjectives = opts.activeObjectives ?? listActiveStrengthObjectives();
  const objective = currentJourneyObjective(opts.exercise ?? null);
  if (!objective) {
    return {
      available: false,
      objective: null,
      latest: null,
      current: null,
      best: null,
      baseline: null,
      gap_lb: null,
      trend: { direction: null, est_1rm_lb_per_week: null, exposures: 0, span_days: 0 },
      phase: null,
      next_prescription: null,
      planned_support: [],
      support_suggestions: [],
      projection: null,
      projection_withheld_reason: "Choose one anchor lift before Cairn builds a comeback journey.",
      safety: {
        load_constraint: false,
        recent_joint_pain: null,
        relevant_joint_pain: null,
        relevant_active_injuries: [],
        stalled_or_regressing: false,
      },
      capacity_basis: null,
      active_objectives: activeObjectives,
    };
  }

  const repsGoal = repsGoalOf(objective);
  if (repsGoal) return repsJourney(objective, repsGoal, activeObjectives, opts.programState);

  const carry = strengthObjectiveCarry(objective);
  // The lift actually trained: the one carrying the goal, else the objective's own.
  const trained = carry?.exercise ?? objective.exercise;
  const history = strengthObjectiveTrackedHistory(objective, carry);
  const latestPoint = history.at(-1) ?? null;
  let currentPoint = capacityEnvelope(history);
  // Completion is a durable milestone, not a claim that every later set must be
  // equally strong. Keep the verified achievement as the capacity floor while
  // retaining a later light/technique exposure separately in `latest`.
  if (
    objective.achieved_est_1rm != null &&
    objective.achieved_date &&
    (!currentPoint || objective.achieved_est_1rm > currentPoint.est_1rm)
  ) {
    currentPoint = {
      date: objective.achieved_date,
      top_weight: 0,
      top_reps: 0,
      est_1rm: objective.achieved_est_1rm,
    };
  }
  const bestPoint = history.reduce<StrengthExposure | null>(
    (best, point) => (!best || point.est_1rm > best.est_1rm ? point : best),
    null
  );
  const recent = envelopeSeries(history).slice(-8);
  const spanDays = recent.length > 1 ? dayNumber(recent.at(-1)!.date) - dayNumber(recent[0].date) : 0;
  const latestAgeDays = latestPoint ? Math.max(0, dayNumber(localDateISO()) - dayNumber(latestPoint.date)) : null;
  const trendPerWeek = slopePerWeek(recent);
  const lastFourTrend = slopePerWeek(recent.slice(-4));
  const lastFour = recent.slice(-4);
  const stableRecentSteps =
    lastFour.length >= 4 && lastFour.slice(1).every((point, index) => point.est_1rm >= lastFour[index].est_1rm - 0.5);
  const direction =
    trendPerWeek == null ? null : trendPerWeek >= 0.5 ? "rising" : trendPerWeek <= -0.75 ? "falling" : "stable";
  const state = opts.programState ?? getProgramState();
  const liftState = exactLiftState(trained, state);
  const ex = (db
    .prepare(`SELECT name, muscle_group, constraint_note FROM exercises WHERE name=? COLLATE NOCASE`)
    .get(trained) as any) ?? { name: trained, muscle_group: null, constraint_note: null };
  const loadConstraint = classifyConstraint(ex?.constraint_note) === "load";
  const autoreg = recentAutoregulation();
  const recentPain = autoreg.joint_pain?.trim() || null;
  const relevantPain = recentPain && painAreaLoadsExercise(recentPain, ex) ? recentPain : null;
  const activeInjuries = relevantActiveInjuries(ex);
  const activeInjuryLabels = activeInjuries
    .map((event) => String(event.title || event.detail || "active injury").trim())
    .filter(Boolean)
    .slice(0, 3);
  // ProgramState's latest-set regression signal is useful only when the rolling
  // exact-lift capacity envelope also falls. A deliberate technique/deload set
  // therefore cannot erase demonstrated capacity or create a false regression.
  const stalledOrRegressing = liftState?.status === "plateaued" || liftState?.status === "regressing";
  const gap = currentPoint ? round1(Math.max(0, objective.target_est_1rm - currentPoint.est_1rm)) : null;

  let phase: StrengthJourney["phase"];
  // Safety state dominates milestone state. Reaching the snapped target does not
  // authorize another prescription while a load constraint or fresh pain signal is
  // active; the journey can celebrate it after the brake clears.
  if (loadConstraint || relevantPain || activeInjuryLabels.length || stalledOrRegressing) phase = "protecting";
  else if (objective.status === "completed") phase = "reached";
  else if (recent.length < 4 || spanDays < 21) phase = "establishing";
  else if (
    objective.baseline_est_1rm != null &&
    currentPoint &&
    currentPoint.est_1rm < objective.baseline_est_1rm - 0.5
  )
    phase = "rebuilding";
  else if (direction === "rising") phase = "building";
  else phase = "consolidating";

  let projection: StrengthJourneyProjection | null = null;
  let withheld: string | null = null;
  const stablePositive =
    recent.length >= 4 &&
    spanDays >= 21 &&
    (trendPerWeek ?? 0) >= 0.5 &&
    (lastFourTrend ?? 0) > 0 &&
    stableRecentSteps &&
    latestAgeDays != null &&
    latestAgeDays <= 28 &&
    !stalledOrRegressing &&
    !loadConstraint &&
    !relevantPain &&
    !activeInjuryLabels.length &&
    objective.status === "active";
  if (latestAgeDays != null && latestAgeDays > 28)
    withheld =
      "Log a current anchor-lift exposure before projecting; the latest exact-lift set is more than 28 days old.";
  else if (gap == null || !currentPoint) withheld = "Log the anchor lift before projecting the path forward.";
  else if (gap <= 0)
    withheld = "The snapped target has already been reached; consolidate it before choosing the next objective.";
  else if (loadConstraint) withheld = "Projection is paused while this lift carries a load-limiting constraint.";
  else if (activeInjuryLabels.length)
    withheld = "Projection is paused while an active injury context is relevant to this lift.";
  else if (relevantPain) withheld = "Projection is paused while recent pain feedback is relevant to this lift.";
  else if (stalledOrRegressing) withheld = "Projection is paused while the exact lift is stalled or moving backward.";
  else if (recent.length < 4 || spanDays < 21)
    withheld = "At least four exact-lift exposures across 21 days are needed for a useful range.";
  else if (!stablePositive)
    withheld = "The recent exact-lift trend is not yet positive and stable enough for a useful range.";
  else {
    const pace = trendPerWeek!;
    const earliest = Math.max(1, Math.ceil(gap / (pace * 1.25)));
    const latest = Math.max(earliest + 1, Math.ceil(gap / (pace * 0.6)));
    if (latest > 24) withheld = "The current trend puts the target beyond a useful 24-week projection window.";
    else {
      projection = {
        earliest_weeks: earliest,
        latest_weeks: latest,
        basis: `${recent.length} exact-lift exposures across ${spanDays} days, trending about ${trendPerWeek} lb/week.`,
        caveat: "A wide planning range, not a promise; recovery, pain, and future logged sets can change it.",
      };
    }
  }

  const states = new Map((state.lifts || []).map((lift) => [lift.exercise.toLowerCase(), lift]));
  const next =
    phase === "protecting" || objective.status === "completed"
      ? null
      : nextPrescription(trained, states, { autoreg });
  const plannedSupport =
    loadConstraint || relevantPain || activeInjuryLabels.length
      ? []
      : plannedSupportFor(trained, recentPain);
  return {
    available: true,
    objective,
    latest: latestPoint ? { est_1rm: latestPoint.est_1rm, date: latestPoint.date } : null,
    current: currentPoint ? { est_1rm: currentPoint.est_1rm, date: currentPoint.date } : null,
    best: bestPoint ? { est_1rm: bestPoint.est_1rm, date: bestPoint.date } : null,
    baseline:
      objective.baseline_est_1rm == null
        ? null
        : { est_1rm: objective.baseline_est_1rm, date: objective.baseline_date },
    gap_lb: gap,
    trend: { direction, est_1rm_lb_per_week: trendPerWeek, exposures: recent.length, span_days: spanDays },
    phase,
    next_prescription: next,
    planned_support: plannedSupport,
    support_suggestions: [],
    projection,
    projection_withheld_reason: projection ? null : withheld,
    safety: {
      load_constraint: loadConstraint,
      recent_joint_pain: recentPain,
      relevant_joint_pain: relevantPain,
      relevant_active_injuries: activeInjuryLabels,
      stalled_or_regressing: stalledOrRegressing,
    },
    capacity_basis: currentPoint
      ? carry
        ? `Best estimated 1RM across the latest three exposures within 28 days; ${carry.exercise} carries this goal since the plan swapped it in for ${carry.from} on ${carry.since}.`
        : "Best exact-lift estimated 1RM across the latest three exposures, refreshed within 28 days."
      : null,
    tracked: carry ? { exercise: carry.exercise, from: carry.from, since: carry.since } : null,
    active_objectives: activeObjectives,
  };
}

const REPS_PROJECTION_WITHHELD =
  "A reps goal has no planning range; it reads the sets you log at bodyweight.";

function withText(point: RepsPoint | null, goal: RepsGoal): (RepsPoint & { text: string }) | null {
  return point ? { ...point, text: repsNowText(point, goal) } : null;
}

/**
 * The journey of a bodyweight_reps goal (strength-reps.ts). Same envelope, same safety
 * reads and the same phases as an est-1RM goal, in reps: no Epley, no pounds, no
 * projection, no carry. Every est-1RM field is null; `reps` carries the read.
 */
function repsJourney(
  objective: StrengthObjective,
  goal: RepsGoal,
  activeObjectives: StrengthObjective[],
  programState?: ProgramState
): StrengthJourney {
  const today = localDateISO();
  const trained = objective.exercise;
  const history = strengthRepsHistory(trained);
  const latestExposure = history.at(-1) ?? null;
  let now = repsEnvelopeAsOf(history, goal, today);
  const goalValue = repsGoalValue(goal);
  // Completion is a durable milestone: the met session stays the floor of "now".
  if (objective.achieved_reps != null && objective.achieved_date && (!now || objective.achieved_reps > now.value)) {
    now = { value: objective.achieved_reps, sets: [], date: objective.achieved_date, assist_lb: null };
  }
  // A reading from the met session alone (the milestone floor) says the goal it met.
  const nowRead = now
    ? { ...now, text: now.sets.length || now.value === 0 ? repsNowText(now, goal) : repsGoalText(goal) }
    : null;
  const bestExposure = history.reduce<(typeof history)[number] | null>(
    (best, point) => (!best || repsMeasure(point, goal) >= repsMeasure(best, goal) ? point : best),
    null
  );
  const agoDay = new Date(Date.parse(`${today}T00:00:00Z`) - 28 * 864e5).toISOString().slice(0, 10);
  const ago = repsEnvelopeAsOf(history, goal, agoDay);
  const direction = repsDirection(now, ago);
  const start = objective.baseline_date ? repsEnvelopeAsOf(history, goal, objective.baseline_date) : null;
  const exposures = history.slice(-8);
  const spanDays = exposures.length > 1 ? dayNumber(exposures.at(-1)!.date) - dayNumber(exposures[0].date) : 0;

  const state = programState ?? getProgramState();
  const liftState = exactLiftState(trained, state);
  const ex = (db
    .prepare(`SELECT name, muscle_group, constraint_note FROM exercises WHERE name=? COLLATE NOCASE`)
    .get(trained) as any) ?? { name: trained, muscle_group: null, constraint_note: null };
  const loadConstraint = classifyConstraint(ex?.constraint_note) === "load";
  const autoreg = recentAutoregulation();
  const recentPain = autoreg.joint_pain?.trim() || null;
  const relevantPain = recentPain && painAreaLoadsExercise(recentPain, ex) ? recentPain : null;
  const activeInjuryLabels = relevantActiveInjuries(ex)
    .map((event) => String(event.title || event.detail || "active injury").trim())
    .filter(Boolean)
    .slice(0, 3);
  const stalledOrRegressing = liftState?.status === "plateaued" || liftState?.status === "regressing";

  let phase: StrengthJourney["phase"];
  if (loadConstraint || relevantPain || activeInjuryLabels.length || stalledOrRegressing) phase = "protecting";
  else if (objective.status === "completed") phase = "reached";
  else if (exposures.length < 4 || spanDays < 21) phase = "establishing";
  else if (objective.baseline_reps != null && now && now.value < objective.baseline_reps) phase = "rebuilding";
  else if (direction === "toward") phase = "building";
  else phase = "consolidating";

  const states = new Map((state.lifts || []).map((lift) => [lift.exercise.toLowerCase(), lift]));
  const next =
    phase === "protecting" || objective.status === "completed" ? null : nextPrescription(trained, states, { autoreg });
  const plannedSupport =
    loadConstraint || relevantPain || activeInjuryLabels.length ? [] : plannedSupportFor(trained, recentPain);
  const latestAgeDays = latestExposure ? dayNumber(today) - dayNumber(latestExposure.date) : null;
  return {
    available: true,
    objective,
    latest: null,
    current: null,
    best: null,
    baseline: null,
    gap_lb: null,
    // The reps move over four weeks in the journey's own words (no lb/week: there is no load).
    trend: {
      direction: direction === "toward" ? "rising" : direction === "back" ? "falling" : direction ? "stable" : null,
      est_1rm_lb_per_week: null,
      exposures: exposures.length,
      span_days: spanDays,
    },
    phase,
    next_prescription: next,
    planned_support: plannedSupport,
    support_suggestions: [],
    projection: null,
    projection_withheld_reason:
      latestAgeDays == null
        ? "Log the lift at bodyweight to start this goal's read."
        : latestAgeDays > 28
          ? "Log a current set of this lift; the latest one is more than 28 days old."
          : REPS_PROJECTION_WITHHELD,
    safety: {
      load_constraint: loadConstraint,
      recent_joint_pain: recentPain,
      relevant_joint_pain: relevantPain,
      relevant_active_injuries: activeInjuryLabels,
      stalled_or_regressing: stalledOrRegressing,
    },
    capacity_basis: now
      ? "Best reps at bodyweight across the latest three exposures within 28 days; assisted sets never count."
      : null,
    tracked: null,
    reps: {
      target_reps: goal.target_reps,
      target_sets: goal.target_sets,
      goal_value: goalValue,
      goal_text: repsGoalText(goal),
      now: nowRead,
      latest: withText(latestExposure ? repsPoint(latestExposure, goal) : null, goal),
      best: withText(bestExposure ? repsPoint(bestExposure, goal) : null, goal),
      baseline:
        objective.baseline_reps == null ? null : { value: objective.baseline_reps, date: objective.baseline_date },
      four_weeks_ago: ago ? { ...ago, as_of: agoDay } : null,
      direction,
      start_assist_lb: start && start.value === 0 ? start.assist_lb : null,
    },
    active_objectives: activeObjectives,
  };
}

/**
 * One journey per ACTIVE anchor, newest anchor first — the parallel read for an athlete
 * rebuilding several lifts at once. Falls back to the single (possibly completed)
 * journey when nothing is active, so a surface can render this list unconditionally.
 * The shared program state AND the active-objective read are computed once and threaded
 * into every journey.
 */
export function getStrengthJourneys(opts: { programState?: ProgramState } = {}): StrengthJourney[] {
  const active = listActiveStrengthObjectives();
  if (!active.length) return [getStrengthJourney({ ...opts, activeObjectives: active })];
  const programState = opts.programState ?? getProgramState();
  return active.map((objective) =>
    getStrengthJourney({ programState, exercise: objective.exercise, activeObjectives: active })
  );
}

// ---- anchor-lift activation -------------------------------------------------
// The strength-journey feature has zero uptake until something invites the
// athlete in. From logged history (plus injected standards capacities) this
// proposes 1-2 reachable, identity-shaped anchor objectives — a top lift nearing
// a strength standard, or a clear comeback to a personal best. A suggestion,
// never a gate; dismissing it quiets it for a long while.

const ANCHOR_DISMISS_KEY = "strength_anchor_suggestion_dismissed_at";
const ANCHOR_DISMISS_COOLDOWN_DAYS = 60;
const STANDARD_REACHABLE_MAX_LB = 35;
const PB_REGRESSION_MIN_LB = 10;
const PB_BEST_MAX_AGE_DAYS = 540;
const ANCHOR_HISTORY_FRESH_DAYS = 45;

function daysSinceStamp(stamp: string | null): number | null {
  if (!stamp) return null;
  const t = Date.parse(stamp);
  return Number.isFinite(t) ? (Date.now() - t) / 864e5 : null;
}

export function dismissAnchorObjectiveSuggestion(): { dismissed_at: string } {
  const now = new Date().toISOString();
  setAppState(ANCHOR_DISMISS_KEY, now);
  return { dismissed_at: now };
}

export function suggestAnchorObjectives(
  opts: { capacities?: AnchorCapacityInput[]; programState?: ProgramState; today?: string } = {}
): AnchorObjectiveSuggestion[] {
  // Never overlap an existing journey — the card already renders active/completed
  // objectives; the suggestion is only for the truly-empty state.
  if (currentJourneyObjective()) return [];
  const dismissedDays = daysSinceStamp(getAppState(ANCHOR_DISMISS_KEY));
  if (dismissedDays != null && dismissedDays < ANCHOR_DISMISS_COOLDOWN_DAYS) return [];

  const today = opts.today ?? localDateISO();
  const todayNum = dayNumber(today);
  // Candidate (B) scans the trained lifts. Default to the current program state so
  // the surfaces can ask for a suggestion with just the standards capacities and
  // still receive comeback-to-best candidates.
  const programState = opts.programState ?? getProgramState(today);
  const out: Array<AnchorObjectiveSuggestion & { priority: number }> = [];
  const seen = new Set<string>();

  // (A) A top lift nearing the next strength standard — a forward identity target.
  for (const cap of opts.capacities ?? []) {
    const exercise = String(cap?.exercise ?? "").trim();
    const est = Number(cap?.est_1rm);
    const toNext = cap?.to_next;
    if (!exercise || !(est > 0) || !toNext) continue;
    const addLb = Number(toNext.lb);
    if (!(addLb > 0) || addLb > STANDARD_REACHABLE_MAX_LB) continue;
    const key = normalizedExerciseKey(exercise);
    if (!key || seen.has(key)) continue;
    const history = strengthObjectiveHistory(exercise);
    const latest = history.at(-1);
    if (!latest || todayNum - dayNumber(latest.date) > ANCHOR_HISTORY_FRESH_DAYS) continue;
    const target = round5(est + addLb);
    if (!(target > est)) continue;
    seen.add(key);
    const label = String(cap.label ?? exercise).trim();
    out.push({
      exercise,
      target_kind: "explicit_est_1rm",
      target_est_1rm: target,
      current_est_1rm: round1(est),
      gap_lb: round1(target - est),
      title: `Reach the ${toNext.level} ${label.toLowerCase()} standard`,
      detail: `Your ${exercise} is about ${addLb} lb from the ${toNext.level} strength standard — a reachable identity to train toward.`,
      basis: "a reachable next standard from your logged lifts",
      priority: 200 - addLb,
    });
  }

  // (B) A clear comeback to a personal best on a lift they still train.
  for (const lift of programState.lifts ?? []) {
    const exercise = String((lift as any)?.exercise ?? "").trim();
    if (!exercise) continue;
    const key = normalizedExerciseKey(exercise);
    if (!key || seen.has(key)) continue;
    const history = strengthObjectiveHistory(exercise);
    if (history.length < 4) continue;
    const latest = history.at(-1)!;
    if (todayNum - dayNumber(latest.date) > ANCHOR_HISTORY_FRESH_DAYS) continue;
    const best = history.reduce<StrengthExposure | null>(
      (b, point) => (!b || point.est_1rm > b.est_1rm ? point : b),
      null
    );
    const current = capacityEnvelope(history);
    if (!best || !current) continue;
    const regression = round1(best.est_1rm - current.est_1rm);
    if (regression < PB_REGRESSION_MIN_LB) continue;
    if (todayNum - dayNumber(best.date) > PB_BEST_MAX_AGE_DAYS) continue;
    seen.add(key);
    out.push({
      exercise,
      target_kind: "return_to_personal_best",
      target_est_1rm: round1(best.est_1rm),
      current_est_1rm: round1(current.est_1rm),
      gap_lb: regression,
      title: `Rebuild your ${exercise} to its best`,
      detail: `You've reached about ${round1(best.est_1rm)} lb estimated 1RM on ${exercise} before and you're near ${round1(current.est_1rm)} lb now — a clear comeback to train toward.`,
      basis: "a level you have reached before",
      priority: 120 + Math.min(40, regression),
    });
  }

  return out
    .sort((a, b) => b.priority - a.priority || a.exercise.localeCompare(b.exercise))
    .slice(0, 2)
    .map(({ priority: _priority, ...rest }) => rest);
}

export function suggestAnchorObjective(
  opts: { capacities?: AnchorCapacityInput[]; programState?: ProgramState; today?: string } = {}
): AnchorObjectiveSuggestion | null {
  return suggestAnchorObjectives(opts)[0] ?? null;
}
