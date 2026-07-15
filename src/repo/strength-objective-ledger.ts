// Lightweight persistence helpers for the anchor-lift journey.
//
// This module deliberately depends only on the DB + exercise-name canonicalizer so
// set logging can close an objective without importing the larger coaching /
// progression graph back into sessions.ts.
import { db } from "../db.js";
import { normalizedExerciseKey } from "./exercise-canon.js";
import { localDateISO } from "./shared.js";

type LedgerExposure = { date: string; est_1rm: number };

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function dayNumber(iso: string): number {
  return Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 864e5);
}

function epley(weight: number, reps: number): number {
  return round1(weight * (1 + reps / 30));
}

function exactExerciseIds(exerciseKey: string): number[] {
  if (!exerciseKey) return [];
  return (db.prepare(`SELECT id, name FROM exercises`).all() as Array<{ id: number; name: string }>)
    .filter((row) => normalizedExerciseKey(row.name) === exerciseKey)
    .map((row) => Number(row.id));
}

function exactHistory(exerciseKey: string): LedgerExposure[] {
  const ids = exactExerciseIds(exerciseKey);
  if (!ids.length) return [];
  const rows = db
    .prepare(
      `SELECT s.date, ls.weight, ls.reps
       FROM logged_sets ls JOIN sessions s ON s.id=ls.session_id
      WHERE ls.exercise_id IN (${ids.map(() => "?").join(",")})
        AND ls.weight > 0 AND ls.reps > 0
      ORDER BY s.date, ls.id`
    )
    .all(...ids) as Array<{ date: string; weight: number; reps: number }>;
  const byDate = new Map<string, LedgerExposure>();
  for (const row of rows) {
    const point = { date: String(row.date), est_1rm: epley(Number(row.weight), Number(row.reps)) };
    const current = byDate.get(point.date);
    if (!current || point.est_1rm > current.est_1rm) byDate.set(point.date, point);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function capacityEnvelope(history: LedgerExposure[], today = localDateISO()): LedgerExposure | null {
  const fresh = history.filter((point) => dayNumber(today) - dayNumber(point.date) <= 28).slice(-3);
  return fresh.reduce<LedgerExposure | null>(
    (best, point) => (!best || point.est_1rm > best.est_1rm ? point : best),
    null
  );
}

type TrackedObjective = {
  id: number;
  exercise_key: string;
  target_kind: "return_to_personal_best" | "explicit_est_1rm";
  target_est_1rm: number;
  baseline_est_1rm: number | null;
  baseline_date: string | null;
  status: "active" | "completed";
  achieved_est_1rm: number | null;
  achieved_date: string | null;
};

function currentTrackedObjective(): TrackedObjective | null {
  return (
    (db
      .prepare(
        `SELECT id, exercise_key, target_kind, target_est_1rm, baseline_est_1rm, baseline_date,
                status, achieved_est_1rm, achieved_date
       FROM strength_objectives
      WHERE status='active'
      UNION ALL
     SELECT id, exercise_key, target_kind, target_est_1rm, baseline_est_1rm, baseline_date,
            status, achieved_est_1rm, achieved_date
       FROM strength_objectives
      WHERE status='completed' AND NOT EXISTS (
        SELECT 1 FROM strength_objectives WHERE status='active'
      )
      ORDER BY id DESC LIMIT 1`
      )
      .get() as TrackedObjective | undefined) ?? null
  );
}

/** Reconcile the current exact-lift objective after an in-place set correction. */
export function reconcileStrengthObjectiveFromLoggedSets(input: { exercise: string; preferred_date?: string | null }): {
  completed: boolean;
  reopened: boolean;
} {
  const key = normalizedExerciseKey(input.exercise);
  const objective = currentTrackedObjective();
  if (!objective || objective.exercise_key !== key) return { completed: false, reopened: false };

  const history = exactHistory(key);
  const eligible = !objective.baseline_date
    ? history
    : history.filter(
        (point) =>
          point.date > objective.baseline_date! ||
          (point.date === objective.baseline_date &&
            point.est_1rm > Number(objective.baseline_est_1rm ?? 0)) ||
          (objective.status === "completed" && point.date === objective.achieved_date)
      );
  const supporting = eligible.filter((point) => point.est_1rm >= Number(objective.target_est_1rm));
  if (objective.status === "active") {
    if (!supporting.length) return { completed: false, reopened: false };
    const evidence = supporting.find((point) => point.date === input.preferred_date) ?? supporting.at(-1)!;
    db.prepare(
      `UPDATE strength_objectives
          SET status='completed', completed_at=COALESCE(completed_at, datetime('now')),
              achieved_est_1rm=?, achieved_date=?, updated_at=datetime('now')
        WHERE id=? AND status='active'`
    ).run(evidence.est_1rm, evidence.date, objective.id);
    return { completed: true, reopened: false };
  }

  if (!supporting.length) {
    // There is no active row when currentTrackedObjective returns a completed
    // objective, so reopening cannot violate the one-active-objective invariant.
    db.prepare(
      `UPDATE strength_objectives
          SET status='active', completed_at=NULL, achieved_est_1rm=NULL,
              achieved_date=NULL, updated_at=datetime('now')
        WHERE id=? AND status='completed'`
    ).run(objective.id);
    return { completed: false, reopened: true };
  }

  // Preserve the original milestone when that date still supports it. If a
  // correction removed only that evidence, point the completed row at another
  // verified exact-lift achievement instead of leaving stale provenance.
  const evidence = supporting.find((point) => point.date === objective.achieved_date) ?? supporting[0];
  if (objective.achieved_est_1rm !== evidence.est_1rm || objective.achieved_date !== evidence.date) {
    db.prepare(
      `UPDATE strength_objectives
          SET achieved_est_1rm=?, achieved_date=?, updated_at=datetime('now')
        WHERE id=? AND status='completed'`
    ).run(evidence.est_1rm, evidence.date, objective.id);
  }
  return { completed: false, reopened: false };
}

/** Mark the one active exact-lift objective complete after a verified set write. */
export function completeStrengthObjectiveFromLoggedSet(input: {
  exercise: string;
  est_1rm: number | null;
  date: string;
}): boolean {
  if (!(Number(input.est_1rm) > 0)) return false;
  return reconcileStrengthObjectiveFromLoggedSets({
    exercise: input.exercise,
    preferred_date: input.date,
  }).completed;
}

export interface StrengthJourneySessionMovement {
  exercise: string;
  current_est_1rm: number;
  current_date: string;
  capacity_delta_lb: number;
  gap_closed_lb: number;
}

/** A bounded positive movement read for a finished session containing the anchor. */
export function strengthJourneySessionMovement(sessionId: number): StrengthJourneySessionMovement | null {
  const session = db.prepare(`SELECT date FROM sessions WHERE id=?`).get(sessionId) as { date: string } | undefined;
  if (!session) return null;
  const objective = db
    .prepare(
      `SELECT exercise, exercise_key, target_est_1rm FROM strength_objectives
      WHERE status IN ('active','completed') ORDER BY id DESC LIMIT 1`
    )
    .get() as { exercise: string; exercise_key: string; target_est_1rm: number } | undefined;
  if (!objective) return null;
  const ids = exactExerciseIds(objective.exercise_key);
  if (!ids.length) return null;
  const hit = db
    .prepare(
      `SELECT 1 FROM logged_sets WHERE session_id=? AND exercise_id IN (${ids.map(() => "?").join(",")}) LIMIT 1`
    )
    .get(sessionId, ...ids);
  if (!hit) return null;
  const history = exactHistory(objective.exercise_key);
  const current = capacityEnvelope(history, session.date);
  const before = capacityEnvelope(
    history.filter((point) => point.date !== session.date),
    session.date
  );
  if (!current || !before) return null;
  const delta = round1(current.est_1rm - before.est_1rm);
  if (!(delta > 0)) return null;
  const priorGap = Math.max(0, Number(objective.target_est_1rm) - before.est_1rm);
  const currentGap = Math.max(0, Number(objective.target_est_1rm) - current.est_1rm);
  return {
    exercise: objective.exercise,
    current_est_1rm: current.est_1rm,
    current_date: current.date,
    capacity_delta_lb: delta,
    gap_closed_lb: round1(Math.max(0, priorGap - currentGap)),
  };
}
