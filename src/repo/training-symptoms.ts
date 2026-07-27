import { db } from "../db.js";
import { painAreaLoadsExercise } from "./pain-relevance.js";
import { requestDailyOutcomeReconciliation } from "./reconciliation-hooks.js";
import { daysBetweenISO, localDateISO } from "./shared.js";

export type SymptomFreshness = "acute_movement_brake" | "hold_easy_recheck" | "stale_needs_recheck";

export interface MovementToleranceReadiness {
  movement_key: string;
  movement_name: string;
  pain_free_exposures: number;
  trial_ready: boolean;
  last_observed_on: string;
}

export interface TrainingSymptomLifecycle {
  id: number;
  source_session_id: number | null;
  source_kind: string;
  area_text: string;
  status: "active" | "resolved";
  onset_on: string;
  last_reported_on: string;
  resolved_on: string | null;
  recurrence_count: number;
  evidence_epoch: number;
  legacy_unconfirmed: boolean;
  freshness: SymptomFreshness;
  scope: "movement_only";
  relevant_pain_free_exposures: number;
  trial_ready: boolean;
  trial_ready_scope: "movement";
  movement_readiness: MovementToleranceReadiness[];
}

export interface MovementToleranceInput {
  symptom_event_id: number;
  movement: string;
  exercise_id?: number | null;
  observed_on?: string;
  session_id?: number | null;
  pain_free: boolean | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: unknown, fallback = localDateISO()): string {
  const date = String(value ?? fallback);
  const parsed = DATE_RE.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("date must be a real YYYY-MM-DD");
  }
  return date;
}

function movementKey(name: string, exerciseId: number | null): string {
  if (exerciseId != null) return `exercise:${exerciseId}`;
  return `movement:${name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

function resolveMovementIdentity(
  movement: unknown,
  requestedExerciseId?: number | null
): { movement_name: string; exercise_id: number | null; muscle_group: string | null } {
  const name = String(movement ?? "")
    .trim()
    .slice(0, 120);
  const exerciseId = requestedExerciseId == null ? null : Number(requestedExerciseId);
  const exercise =
    exerciseId != null && Number.isInteger(exerciseId) && exerciseId > 0
      ? (db.prepare(`SELECT id, name, muscle_group FROM exercises WHERE id = ?`).get(exerciseId) as any)
      : name
        ? (db
            .prepare(`SELECT id, name, muscle_group FROM exercises WHERE name = ? COLLATE NOCASE`)
            .get(name) as any)
        : null;
  if (requestedExerciseId != null && !exercise) throw new Error("exercise_id not found");
  const canonicalName = exercise?.name ? String(exercise.name) : name;
  if (!canonicalName) throw new Error("movement required");
  return {
    movement_name: canonicalName,
    exercise_id: exercise?.id == null ? null : Number(exercise.id),
    muscle_group: exercise?.muscle_group == null ? null : String(exercise.muscle_group),
  };
}

function freshness(lastReportedOn: string, on: string): SymptomFreshness {
  const age = daysBetweenISO(on, lastReportedOn);
  if (age == null || age <= 3) return "acute_movement_brake";
  if (age <= 7) return "hold_easy_recheck";
  return "stale_needs_recheck";
}

function reconcileAffectedOutcomeDates(from: string): void {
  const rows = db
    .prepare(
      `SELECT DISTINCT date FROM daily_session_outcomes
       WHERE date >= ? ORDER BY date LIMIT 128`
    )
    .all(from) as Array<{ date: string }>;
  const dates = new Set([from, ...rows.map((row) => String(row.date))]);
  for (const date of dates) requestDailyOutcomeReconciliation(date);
}

function latestEpisodeRow(id: number, on?: string): any | null {
  let episode = db.prepare(`SELECT * FROM training_symptom_events WHERE id = ?`).get(Number(id)) as any;
  const seen = new Set<number>();
  while (episode && !seen.has(Number(episode.id))) {
    seen.add(Number(episode.id));
    const child = db
      .prepare(
        `SELECT * FROM training_symptom_events
         WHERE source_kind = ? ${on == null ? "" : "AND onset_on <= ?"}
         ORDER BY onset_on DESC, id DESC LIMIT 1`
      )
      .get(...(on == null ? [`recurrence:${episode.id}`] : [`recurrence:${episode.id}`, on])) as any;
    if (!child) break;
    episode = child;
  }
  return episode;
}

function latestEpisodeAt(id: number, on: string): TrainingSymptomLifecycle | null {
  return hydrate(latestEpisodeRow(id, on), on);
}

function hydrate(row: any, on = localDateISO()): TrainingSymptomLifecycle | null {
  if (!row) return null;
  const readOn = validDate(on);
  const resolvedOn = row.resolved_on == null ? null : String(row.resolved_on);
  const activeOn = String(row.onset_on) <= readOn && (resolvedOn == null || resolvedOn > readOn);
  const observations = db
    .prepare(
      `SELECT movement_key, movement_name, session_id, observed_on, outcome, evidence_epoch, id
       FROM movement_tolerance_observations
       WHERE symptom_event_id = ? AND relevant = 1 AND evidence_epoch = ? AND observed_on <= ?
       ORDER BY observed_on, id`
    )
    .all(Number(row.id), Number(row.evidence_epoch ?? 1), readOn) as any[];
  const groups = new Map<
    string,
    {
      movement_key: string;
      movement_name: string;
      seen: Set<string>;
      pain_free_exposures: number;
      last_observed_on: string;
    }
  >();
  for (const observation of observations) {
    const key = String(observation.movement_key);
    if (key === "*") {
      for (const group of groups.values()) {
        group.seen.clear();
        group.pain_free_exposures = 0;
        group.last_observed_on = String(observation.observed_on);
      }
      continue;
    }
    const group = groups.get(key) ?? {
      movement_key: key,
      movement_name: String(observation.movement_name),
      seen: new Set<string>(),
      pain_free_exposures: 0,
      last_observed_on: String(observation.observed_on),
    };
    group.last_observed_on = String(observation.observed_on);
    if (observation.outcome === "pain_present") {
      // A recurrence resets only this movement's trial evidence. Other relevant
      // movements retain their own independent exposure history.
      group.seen.clear();
      group.pain_free_exposures = 0;
    } else {
      const exposure =
        observation.session_id == null ? `date:${observation.observed_on}` : `session:${observation.session_id}`;
      if (!group.seen.has(exposure)) {
        group.seen.add(exposure);
        group.pain_free_exposures++;
      }
    }
    groups.set(key, group);
  }
  const movementReadiness: MovementToleranceReadiness[] = [...groups.values()].map((group) => ({
    movement_key: group.movement_key,
    movement_name: group.movement_name,
    pain_free_exposures: group.pain_free_exposures,
    trial_ready: group.pain_free_exposures >= 2,
    last_observed_on: group.last_observed_on,
  }));
  const painFree = movementReadiness.reduce((sum, movement) => sum + movement.pain_free_exposures, 0);
  return {
    id: Number(row.id),
    source_session_id: row.source_session_id == null ? null : Number(row.source_session_id),
    source_kind: String(row.source_kind),
    area_text: String(row.area_text),
    status: activeOn ? "active" : "resolved",
    onset_on: String(row.onset_on),
    last_reported_on: String(row.last_reported_on),
    resolved_on: resolvedOn,
    recurrence_count: Number(row.recurrence_count ?? 0),
    evidence_epoch: Number(row.evidence_epoch ?? 1),
    legacy_unconfirmed: Number(row.legacy_unconfirmed) === 1,
    freshness: freshness(String(row.last_reported_on), readOn),
    scope: "movement_only",
    relevant_pain_free_exposures: painFree,
    trial_ready: activeOn && movementReadiness.some((movement) => movement.trial_ready),
    trial_ready_scope: "movement",
    movement_readiness: movementReadiness,
  };
}

// Import old free-text session feedback once. A legacy null is absence of
// evidence, and imported rows remain explicitly unconfirmed until the athlete
// resolves or re-reports them.
export function seedLegacyTrainingSymptoms(): number {
  const rows = db
    .prepare(
      `SELECT id, date, joint_pain FROM sessions
       WHERE joint_pain IS NOT NULL AND TRIM(joint_pain) != ''
       ORDER BY date, id`
    )
    .all() as any[];
  let inserted = 0;
  const statement = db.prepare(
    `INSERT OR IGNORE INTO training_symptom_events
      (source_session_id, source_kind, area_text, status, onset_on, last_reported_on, legacy_unconfirmed)
     VALUES (?, 'legacy_session_feedback', ?, 'active', ?, ?, 1)`
  );
  for (const row of rows) {
    inserted += Number(
      statement.run(Number(row.id), String(row.joint_pain).trim().slice(0, 300), row.date, row.date).changes
    );
  }
  return inserted;
}

export function reportTrainingSymptom(input: {
  area_text: string;
  onset_on?: string;
  source_session_id?: number | null;
  source_kind?: string;
}): TrainingSymptomLifecycle {
  const area = String(input.area_text ?? "")
    .trim()
    .slice(0, 300);
  if (!area) throw new Error("area_text required");
  const onset = validDate(input.onset_on);
  const sourceSessionId = input.source_session_id == null ? null : Number(input.source_session_id);
  const sourceKind = String(input.source_kind ?? "explicit").slice(0, 80);
  // A repeated surface/MCP delivery of the same explicit report is a retry, not
  // a second symptom. A later reappearance has the dedicated recurrence path.
  const existing = db
    .prepare(
      `SELECT * FROM training_symptom_events
       WHERE status = 'active' AND onset_on = ? AND area_text = ? COLLATE NOCASE
         AND source_kind = ? AND source_session_id IS ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(onset, area, sourceKind, sourceSessionId);
  if (existing) return hydrate(existing, onset)!;
  const result = db
    .prepare(
      `INSERT INTO training_symptom_events
        (source_session_id, source_kind, area_text, status, onset_on, last_reported_on, legacy_unconfirmed)
       VALUES (?, ?, ?, 'active', ?, ?, 0)`
    )
    .run(
      sourceSessionId,
      sourceKind,
      area,
      onset,
      onset
    );
  const event = getTrainingSymptom(Number(result.lastInsertRowid), onset)!;
  reconcileAffectedOutcomeDates(onset);
  return event;
}

export function getTrainingSymptom(id: number, on = localDateISO()): TrainingSymptomLifecycle | null {
  return hydrate(db.prepare(`SELECT * FROM training_symptom_events WHERE id = ?`).get(Number(id)), validDate(on));
}

export function listTrainingSymptoms(
  opts: { on?: string; include_resolved?: boolean; seed_legacy?: boolean } = {}
): TrainingSymptomLifecycle[] {
  if (opts.seed_legacy !== false) seedLegacyTrainingSymptoms();
  const on = validDate(opts.on);
  const rows = db
    .prepare(
      `SELECT * FROM training_symptom_events
       WHERE onset_on <= ?
         ${opts.include_resolved ? "" : "AND (resolved_on IS NULL OR resolved_on > ?)"}
       ORDER BY last_reported_on DESC, id DESC`
    )
    .all(...(opts.include_resolved ? [on] : [on, on])) as any[];
  return rows.map((row) => hydrate(row, on)).filter((event): event is TrainingSymptomLifecycle => event != null);
}

export function movementToleranceReadiness(symptomEventId: number, on = localDateISO()): MovementToleranceReadiness[] {
  return getTrainingSymptom(symptomEventId, on)?.movement_readiness ?? [];
}

export function activeRelevantTrainingSymptoms(
  on: string,
  exercise: { name?: string | null; muscle_group?: string | null }
): TrainingSymptomLifecycle[] {
  const readOn = validDate(on);
  seedLegacyTrainingSymptoms();
  const rows = db
    .prepare(
      `SELECT * FROM training_symptom_events
       WHERE onset_on <= ? AND (resolved_on IS NULL OR resolved_on > ?)
       ORDER BY last_reported_on DESC, id DESC`
    )
    .all(readOn, readOn) as any[];
  return rows
    .filter((row) => painAreaLoadsExercise(String(row.area_text), exercise))
    .map((row) => hydrate(row, readOn))
    .filter((event): event is TrainingSymptomLifecycle => event != null);
}

export function resolveTrainingSymptom(id: number, on = localDateISO()): TrainingSymptomLifecycle | null {
  const resolvedOn = validDate(on);
  const row = db.prepare(`SELECT * FROM training_symptom_events WHERE id = ?`).get(Number(id)) as any;
  if (!row) return null;
  if (resolvedOn < String(row.onset_on)) {
    throw new Error("resolution date cannot be before symptom onset");
  }
  if (resolvedOn < String(row.last_reported_on)) {
    throw new Error("resolution date cannot be before the latest symptom report");
  }
  if (row.resolved_on != null) {
    return hydrate(row, resolvedOn);
  }
  db.prepare(
    `UPDATE training_symptom_events
     SET status = 'resolved', resolved_on = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(resolvedOn, Number(id));
  const event = getTrainingSymptom(id, resolvedOn);
  reconcileAffectedOutcomeDates(resolvedOn);
  return event;
}

export function recurTrainingSymptom(
  id: number,
  input: { on?: string; area_text?: string; movement?: string | null; exercise_id?: number | null } = {}
): TrainingSymptomLifecycle | null {
  const on = validDate(input.on);
  const existingRow = latestEpisodeRow(id);
  if (!existingRow) return null;
  const onsetOn = String(existingRow.onset_on);
  const resolvedOn = existingRow.resolved_on == null ? null : String(existingRow.resolved_on);
  const lastReportedOn = String(existingRow.last_reported_on);
  if (on < onsetOn) throw new Error("recurrence date cannot be before the current episode onset");
  if (resolvedOn != null && on < resolvedOn) {
    throw new Error("recurrence date cannot be before the current episode resolution");
  }
  if (resolvedOn == null && on < lastReportedOn) {
    throw new Error("recurrence date cannot be before the latest symptom report");
  }
  const existing = hydrate(existingRow, on)!;
  const area =
    input.area_text == null ? existing.area_text : String(input.area_text).trim().slice(0, 300) || existing.area_text;
  const movement = String(input.movement ?? "").trim().slice(0, 120);
  let movementName = "*";
  let key = "*";
  let exerciseId: number | null = null;
  if (movement || input.exercise_id != null) {
    const identity = resolveMovementIdentity(movement, input.exercise_id);
    movementName = identity.movement_name;
    exerciseId = identity.exercise_id;
    key = movementKey(movementName, exerciseId);
  }
  const duplicate = db
    .prepare(
      `SELECT 1 FROM movement_tolerance_observations
       WHERE symptom_event_id = ? AND session_id IS NULL AND movement_key = ?
         AND observed_on = ? AND outcome = 'pain_present' AND evidence_epoch = ? LIMIT 1`
    )
    .get(existing.id, key, on, existing.evidence_epoch);
  if (duplicate && existing.status === "active" && existing.resolved_on == null) return existing;

  const nextEpoch = existing.evidence_epoch + 1;
  db.exec("SAVEPOINT recur_training_symptom");
  try {
    let eventId = existing.id;
    if (existing.status === "resolved") {
      const sourceKind = `recurrence:${existing.id}`;
      const priorRetry = db
        .prepare(
          `SELECT * FROM training_symptom_events
           WHERE source_kind = ? AND onset_on = ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(sourceKind, on) as any;
      if (priorRetry) {
        db.exec("RELEASE recur_training_symptom");
        const retried = hydrate(priorRetry, on);
        reconcileAffectedOutcomeDates(on);
        return retried;
      }
      const inserted = db
        .prepare(
          `INSERT INTO training_symptom_events
            (source_session_id, source_kind, area_text, status, onset_on, last_reported_on,
             recurrence_count, evidence_epoch, legacy_unconfirmed)
           VALUES (NULL, ?, ?, 'active', ?, ?, ?, ?, 0)`
        )
        .run(sourceKind, area, on, on, existing.recurrence_count + 1, nextEpoch);
      eventId = Number(inserted.lastInsertRowid);
      if (key !== "*") {
        db.prepare(
          `INSERT OR IGNORE INTO movement_tolerance_observations
            (symptom_event_id, session_id, exercise_id, movement_key, movement_name,
             observed_on, outcome, relevant, evidence_epoch)
           SELECT ?, session_id, exercise_id, movement_key, movement_name,
                  observed_on, outcome, relevant, ?
             FROM movement_tolerance_observations
            WHERE symptom_event_id = ? AND evidence_epoch = ? AND movement_key != ?`
        ).run(eventId, nextEpoch, existing.id, existing.evidence_epoch, key);
      }
    } else {
      db.prepare(
        `UPDATE training_symptom_events
         SET area_text = ?, last_reported_on = ?,
             recurrence_count = recurrence_count + 1, evidence_epoch = ?,
             legacy_unconfirmed = 0, updated_at = datetime('now')
         WHERE id = ?`
      ).run(area, on, nextEpoch, existing.id);
    }
    db.prepare(
      `INSERT INTO movement_tolerance_observations
        (symptom_event_id, session_id, exercise_id, movement_key, movement_name,
         observed_on, outcome, relevant, evidence_epoch)
       VALUES (?, NULL, ?, ?, ?, ?, 'pain_present', 1, ?)`
    ).run(eventId, exerciseId, key, movementName, on, nextEpoch);
    db.exec("RELEASE recur_training_symptom");
    const recurred = getTrainingSymptom(eventId, on);
    reconcileAffectedOutcomeDates(on);
    return recurred;
  } catch (error) {
    try {
      db.exec("ROLLBACK TO recur_training_symptom");
    } finally {
      db.exec("RELEASE recur_training_symptom");
    }
    throw error;
  }
}

export function recordMovementTolerance(input: MovementToleranceInput): TrainingSymptomLifecycle | null {
  const observedOn = validDate(input.observed_on);
  const event = latestEpisodeAt(input.symptom_event_id, observedOn);
  if (!event) return null;
  if (observedOn < event.onset_on) {
    throw new Error("observation date cannot be before symptom onset");
  }
  // Null means the athlete did not answer. It is not pain-free evidence and does
  // not change event recency, status, or trial readiness.
  if (input.pain_free == null) return event;
  const identity = resolveMovementIdentity(input.movement, input.exercise_id);
  const relevant = painAreaLoadsExercise(event.area_text, {
    name: identity.movement_name,
    muscle_group: identity.muscle_group,
  });
  if (event.status === "resolved") {
    return !input.pain_free && relevant
      ? recurTrainingSymptom(event.id, {
          on: observedOn,
          movement: identity.movement_name,
          exercise_id: identity.exercise_id,
        })
      : event;
  }
  const key = movementKey(identity.movement_name, identity.exercise_id);
  const prior = db
    .prepare(
      `SELECT 1 FROM movement_tolerance_observations
       WHERE symptom_event_id = ? AND session_id IS ? AND movement_key = ?
         AND observed_on = ? AND outcome = ? LIMIT 1`
    )
    .get(
      event.id,
      input.session_id == null ? null : Number(input.session_id),
      key,
      observedOn,
      input.pain_free ? "pain_free" : "pain_present"
    );
  if (prior) return event;
  const evidenceEpoch = !input.pain_free && relevant ? event.evidence_epoch + 1 : event.evidence_epoch;
  if (!input.pain_free && relevant) {
    db.prepare(
      `INSERT OR IGNORE INTO movement_tolerance_observations
        (symptom_event_id, session_id, exercise_id, movement_key, movement_name,
         observed_on, outcome, relevant, evidence_epoch)
       SELECT symptom_event_id, session_id, exercise_id, movement_key, movement_name,
              observed_on, outcome, relevant, ?
         FROM movement_tolerance_observations
        WHERE symptom_event_id = ? AND evidence_epoch = ? AND movement_key != ?`
    ).run(evidenceEpoch, event.id, event.evidence_epoch, key);
  }
  const inserted = Number(
    db
      .prepare(
        `INSERT OR IGNORE INTO movement_tolerance_observations
      (symptom_event_id, session_id, exercise_id, movement_key, movement_name,
       observed_on, outcome, relevant, evidence_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        input.session_id == null ? null : Number(input.session_id),
        identity.exercise_id,
        key,
        identity.movement_name,
        observedOn,
        input.pain_free ? "pain_free" : "pain_present",
        relevant ? 1 : 0,
        evidenceEpoch
      ).changes
  );
  if (inserted && !input.pain_free && relevant) {
    db.prepare(
      `UPDATE training_symptom_events
       SET last_reported_on = ?, recurrence_count = recurrence_count + 1,
           evidence_epoch = ?, legacy_unconfirmed = 0, updated_at = datetime('now')
       WHERE id = ?`
    ).run(observedOn, evidenceEpoch, event.id);
  }
  if (inserted) reconcileAffectedOutcomeDates(observedOn);
  return getTrainingSymptom(event.id, observedOn);
}
