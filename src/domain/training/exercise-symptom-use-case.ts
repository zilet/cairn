import { db } from "../../db.js";
import { painAreaLoadsExercise } from "../../repo/pain-relevance.js";
import { getAuthoritativeSessionRow } from "../../repo/session-core.js";
import { afterSqliteCommit, withSqliteSavepoint } from "../../repo/sqlite-savepoint.js";
import { normalizeSymptomArea } from "../../repo/symptom-area.js";
import {
  latestTrainingSymptomEpisode,
  reconcileTrainingSymptomOutcomeDates,
  recordMovementTolerance,
  type TrainingSymptomLifecycle,
} from "../../repo/training-symptoms.js";

export type ExerciseSymptomObservationOutcome = "pain_present" | "pain_free";

export interface ExerciseSymptomObservationInput {
  date: string;
  movement: string;
  session_id?: number | null;
  symptom_event_id?: number | null;
  area_text?: string | null;
  outcome: ExerciseSymptomObservationOutcome;
}

export interface ExerciseSymptomObservationResponse {
  ok: true;
  date: string;
  session_id: number;
  exercise: {
    id: number;
    name: string;
    muscle_group: string | null;
  };
  outcome: ExerciseSymptomObservationOutcome;
  symptom: TrainingSymptomLifecycle;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_KIND = "exercise_card_observation";

function validDate(value: unknown): string {
  const date = String(value ?? "");
  const parsed = DATE_RE.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("date must be a real YYYY-MM-DD");
  }
  return date;
}

function positiveId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${field} must be a positive integer`);
  return id;
}

function canonicalExercise(movement: unknown): {
  id: number;
  name: string;
  muscle_group: string | null;
} {
  const requested = String(movement ?? "").trim();
  if (!requested) throw new Error("movement required");
  if (requested.length > 120) throw new Error("movement must be 120 characters or fewer");
  const row = db
    .prepare(`SELECT id, name, muscle_group FROM exercises WHERE name = ? COLLATE NOCASE`)
    .get(requested) as any;
  if (!row) throw new Error("movement must identify an existing exercise");
  return {
    id: Number(row.id),
    name: String(row.name),
    muscle_group: row.muscle_group == null ? null : String(row.muscle_group),
  };
}

function sessionForObservation(date: string, requestedId?: number | null): any {
  if (requestedId != null) {
    const id = positiveId(requestedId, "session_id");
    const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
    if (!session) throw new Error("session_id not found");
    if (String(session.date) !== date) throw new Error("session_id must match date");
    return session;
  }
  const session = getAuthoritativeSessionRow(date);
  if (!session) throw new Error("an existing session is required for date");
  return session;
}

function compositionExerciseMembership(
  sessionId: number,
  date: string,
  exercise: { id: number; name: string }
): boolean | null {
  const row = db
    .prepare(
      `SELECT items_json FROM daily_session_compositions
       WHERE session_id = ? AND date = ? AND status = 'active'
       ORDER BY version DESC LIMIT 1`
    )
    .get(sessionId, date) as any;
  if (!row) return null;
  try {
    const items = JSON.parse(String(row.items_json));
    if (!Array.isArray(items)) return false;
    return items.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const candidate = item as Record<string, unknown>;
      if (Number(candidate.exercise_id) === exercise.id) return true;
      return String(candidate.exercise ?? "").trim().toLowerCase() === exercise.name.toLowerCase();
    });
  } catch {
    return false;
  }
}

function sessionContainsExercise(session: any, date: string, exercise: { id: number; name: string }): boolean {
  const compositionMembership = compositionExerciseMembership(Number(session.id), date, exercise);
  // Once an accepted composition exists it is the exclusive prescription truth
  // for this exposure. A missing/malformed item list fails closed and cannot
  // fall through to the weekly template it was derived from.
  if (compositionMembership != null) return compositionMembership;
  if (
    session.plan_day_id != null &&
    db
      .prepare(`SELECT 1 FROM plan_items WHERE plan_day_id = ? AND exercise_id = ? LIMIT 1`)
      .get(Number(session.plan_day_id), exercise.id)
  ) {
    return true;
  }
  if (
    db
      .prepare(`SELECT 1 FROM logged_sets WHERE session_id = ? AND exercise_id = ? LIMIT 1`)
      .get(Number(session.id), exercise.id)
  ) {
    return true;
  }
  return !!db
    .prepare(`SELECT 1 FROM session_skips WHERE session_id = ? AND exercise = ? COLLATE NOCASE LIMIT 1`)
    .get(Number(session.id), exercise.name);
}

function relevantEpisode(
  symptomEventId: unknown,
  date: string,
  exercise: { name: string; muscle_group: string | null },
  requireActive: boolean
): TrainingSymptomLifecycle {
  const id = positiveId(symptomEventId, "symptom_event_id");
  const symptom = latestTrainingSymptomEpisode(id, date);
  if (!symptom) throw new Error("symptom_event_id not found for date");
  if (date < symptom.onset_on) throw new Error("observation date cannot be before symptom onset");
  if (requireActive && symptom.status !== "active") {
    throw new Error("pain_free requires an active symptom_event_id for date");
  }
  if (!painAreaLoadsExercise(symptom.area_text, exercise)) {
    throw new Error("symptom_event_id is not relevant to movement");
  }
  return symptom;
}

function response(
  date: string,
  sessionId: number,
  exercise: { id: number; name: string; muscle_group: string | null },
  outcome: ExerciseSymptomObservationOutcome,
  symptom: TrainingSymptomLifecycle
): ExerciseSymptomObservationResponse {
  return {
    ok: true,
    date,
    session_id: sessionId,
    exercise,
    outcome,
    symptom,
  };
}

function priorPainPresent(
  symptomEventId: number,
  sessionId: number,
  date: string,
  exerciseId: number
): TrainingSymptomLifecycle | null {
  const row = db
    .prepare(
      `SELECT symptom_event_id FROM movement_tolerance_observations
       WHERE symptom_event_id = ? AND session_id = ? AND exercise_id = ?
         AND observed_on = ? AND outcome = 'pain_present'
       ORDER BY id DESC LIMIT 1`
    )
    .get(symptomEventId, sessionId, exerciseId, date) as any;
  return row ? latestTrainingSymptomEpisode(Number(row.symptom_event_id), date) : null;
}

function areaText(value: unknown): string {
  const area = normalizeSymptomArea(value);
  if (!area) throw new Error("area_text required when symptom_event_id is absent");
  return area;
}

function createOrReuseSessionSymptom(
  date: string,
  sessionId: number,
  exercise: { id: number; name: string; muscle_group: string | null },
  area: string
): { symptom: TrainingSymptomLifecycle; inserted: boolean } {
  let event = db
    .prepare(
      `SELECT * FROM training_symptom_events
       WHERE source_session_id = ? AND source_kind = ? AND onset_on = ?
         AND area_text = ? COLLATE NOCASE
         AND (resolved_on IS NULL OR resolved_on > ?)
       ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId, SOURCE_KIND, date, area, date) as any;
  if (!event) {
    const inserted = db
      .prepare(
        `INSERT INTO training_symptom_events
          (source_session_id, source_kind, area_text, status, onset_on, last_reported_on, legacy_unconfirmed)
         VALUES (?, ?, ?, 'active', ?, ?, 0)`
      )
      .run(sessionId, SOURCE_KIND, area, date, date);
    event = db
      .prepare(`SELECT * FROM training_symptom_events WHERE id = ?`)
      .get(Number(inserted.lastInsertRowid));
  }
  const symptom = latestTrainingSymptomEpisode(Number(event.id), date);
  if (!symptom) throw new Error("symptom observation could not be created");
  const inserted = Number(
    db
      .prepare(
        `INSERT OR IGNORE INTO movement_tolerance_observations
          (symptom_event_id, session_id, exercise_id, movement_key, movement_name,
           observed_on, outcome, relevant, evidence_epoch)
         VALUES (?, ?, ?, ?, ?, ?, 'pain_present', 1, ?)`
      )
      .run(
        symptom.id,
        sessionId,
        exercise.id,
        `exercise:${exercise.id}`,
        exercise.name,
        date,
        symptom.evidence_epoch
      ).changes
  );
  const stored = priorPainPresent(symptom.id, sessionId, date, exercise.id);
  if (!stored) throw new Error("movement observation could not be recorded");
  return { symptom: stored, inserted: inserted > 0 };
}

export function recordExerciseSymptomObservation(
  input: ExerciseSymptomObservationInput
): ExerciseSymptomObservationResponse {
  const date = validDate(input.date);
  const exercise = canonicalExercise(input.movement);
  const session = sessionForObservation(date, input.session_id);
  const sessionId = Number(session.id);
  if (!sessionContainsExercise(session, date, exercise)) {
    throw new Error("movement is not part of this session exposure");
  }
  if (input.outcome !== "pain_present" && input.outcome !== "pain_free") {
    throw new Error("outcome must be pain_present or pain_free");
  }

  return withSqliteSavepoint("exercise_symptom_observation", () => {
    if (input.outcome === "pain_free") {
      if (input.symptom_event_id == null) {
        throw new Error("pain_free requires an explicit symptom_event_id");
      }
      const symptom = relevantEpisode(input.symptom_event_id, date, exercise, true);
      const painPresent = priorPainPresent(symptom.id, sessionId, date, exercise.id);
      if (painPresent) return response(date, sessionId, exercise, "pain_present", painPresent);
      const recorded = recordMovementTolerance({
        symptom_event_id: symptom.id,
        movement: exercise.name,
        exercise_id: exercise.id,
        observed_on: date,
        session_id: sessionId,
        pain_free: true,
      });
      if (!recorded) throw new Error("symptom_event_id not found for date");
      return response(date, sessionId, exercise, "pain_free", recorded);
    }

    if (input.symptom_event_id != null) {
      const symptom = relevantEpisode(input.symptom_event_id, date, exercise, false);
      const prior = priorPainPresent(symptom.id, sessionId, date, exercise.id);
      if (prior) return response(date, sessionId, exercise, "pain_present", prior);
      const recorded = recordMovementTolerance({
        symptom_event_id: symptom.id,
        movement: exercise.name,
        exercise_id: exercise.id,
        observed_on: date,
        session_id: sessionId,
        pain_free: false,
      });
      if (!recorded) throw new Error("symptom_event_id not found for date");
      return response(date, sessionId, exercise, "pain_present", recorded);
    }

    const created = createOrReuseSessionSymptom(date, sessionId, exercise, areaText(input.area_text));
    if (created.inserted) afterSqliteCommit(() => reconcileTrainingSymptomOutcomeDates(date));
    return response(date, sessionId, exercise, "pain_present", created.symptom);
  });
}
