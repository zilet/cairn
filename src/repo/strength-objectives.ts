// One explicit anchor-lift objective and its deterministic comeback read.
//
// This is deliberately narrower than program-state: the athlete selects ONE exact
// exercise, its target is snapped at selection time, and every trend/projection uses
// normalizedExerciseKey (never movementKey). Barbell and dumbbell histories therefore
// remain separate even when they train the same movement pattern.
import { db } from "../db.js";
import { getAppState, setAppState } from "./app-state.js";
import { classifyConstraint, normalizedExerciseKey } from "./exercise-canon.js";
import { classifyPattern, type Equipment, type MovementPattern } from "./exercise-variations.js";
import { injuryAffectsExercise, listContextEvents } from "./health.js";
import {
  availableEquipment,
  nextPrescription,
  painAreaLoadsExercise,
  recentAutoregulation,
  type Prescription,
} from "./progression.js";
import { getProgramState, type LiftState, type ProgramState } from "./program-state.js";
import { localDateISO } from "./shared.js";

export type StrengthObjectiveTargetKind = "return_to_personal_best" | "explicit_est_1rm";
export type StrengthObjectiveStatus = "active" | "superseded" | "completed" | "archived";

export interface StrengthObjective {
  id: number;
  exercise: string;
  exercise_key: string;
  target_kind: StrengthObjectiveTargetKind;
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

export function getActiveStrengthObjective(): StrengthObjective | null {
  return asObjective(
    db.prepare(`SELECT * FROM strength_objectives WHERE status = 'active' ORDER BY id DESC LIMIT 1`).get()
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function epley(weight: number, reps: number): number {
  return round1(weight * (1 + reps / 30));
}

function objectiveExerciseName(raw: unknown): { exercise: string; key: string; mode: string | null } {
  const supplied = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const key = normalizedExerciseKey(supplied);
  if (!supplied || !key) throw new Error("exercise required");
  const existing = (
    db.prepare(`SELECT name, mode FROM exercises ORDER BY id`).all() as Array<{ name: string; mode: string | null }>
  ).find((row) => normalizedExerciseKey(row.name) === key);
  return { exercise: existing?.name ?? supplied, key, mode: existing?.mode ?? null };
}

// Exact normalized-exercise history. This intentionally does NOT use movementKey:
// "Incline DB Press" cannot contribute to "Incline Barbell Bench Press" here.
export function strengthObjectiveHistory(exercise: string): StrengthExposure[] {
  const key = normalizedExerciseKey(exercise);
  if (!key) return [];
  const ids = (db.prepare(`SELECT id, name FROM exercises`).all() as Array<{ id: number; name: string }>)
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

export function setStrengthObjective(input: {
  exercise: unknown;
  target_kind: unknown;
  target_est_1rm?: unknown;
}): StrengthObjective {
  const { exercise, key, mode } = objectiveExerciseName(input.exercise);
  if (mode === "timed") throw new Error("strength objectives require a reps-based exercise with estimated-1RM history");
  const targetKind = String(input.target_kind ?? "") as StrengthObjectiveTargetKind;
  if (targetKind !== "return_to_personal_best" && targetKind !== "explicit_est_1rm")
    throw new Error("target_kind must be return_to_personal_best or explicit_est_1rm");
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
    db.prepare(
      `UPDATE strength_objectives
          SET status = 'superseded', superseded_at = datetime('now'), updated_at = datetime('now')
        WHERE status = 'active'`
    ).run();
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
      db.prepare(
        `UPDATE strength_objectives SET status='superseded', superseded_at=datetime('now'), updated_at=datetime('now')
          WHERE status='active' AND id != ?`
      ).run(id);
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
  const fresh = history.filter((point) => dayNumber(localDateISO()) - dayNumber(point.date) <= 28).slice(-3);
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

function currentJourneyObjective(): StrengthObjective | null {
  return (
    getActiveStrengthObjective() ??
    asObjective(db.prepare(`SELECT * FROM strength_objectives WHERE status='completed' ORDER BY id DESC LIMIT 1`).get())
  );
}

function exactLiftState(exercise: string, programState: ProgramState): LiftState | null {
  const key = normalizedExerciseKey(exercise);
  return (programState.lifts || []).find((lift) => normalizedExerciseKey(lift.exercise) === key) ?? null;
}

export function getStrengthJourney(opts: { programState?: ProgramState } = {}): StrengthJourney {
  const objective = currentJourneyObjective();
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
    };
  }

  const history = strengthObjectiveHistory(objective.exercise);
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
  const liftState = exactLiftState(objective.exercise, state);
  const ex = (db
    .prepare(`SELECT name, muscle_group, constraint_note FROM exercises WHERE name=? COLLATE NOCASE`)
    .get(objective.exercise) as any) ?? { name: objective.exercise, muscle_group: null, constraint_note: null };
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
      : nextPrescription(objective.exercise, states, { autoreg });
  const plannedSupport =
    loadConstraint || relevantPain || activeInjuryLabels.length
      ? []
      : plannedSupportFor(objective.exercise, recentPain);
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
      ? "Best exact-lift estimated 1RM across the latest three exposures, refreshed within 28 days."
      : null,
  };
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

function round5(value: number): number {
  return Math.round(value / 5) * 5;
}

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
