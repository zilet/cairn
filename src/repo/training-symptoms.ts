import { db } from "../db.js";
import { painAreaLoadsExercise } from "./pain-relevance.js";
import { requestDailyOutcomeReconciliation } from "./reconciliation-hooks.js";
import { daysBetweenISO, localDateISO } from "./shared.js";
import { extractSymptomAreaLabel, normalizeSymptomArea, symptomAreaKey } from "./symptom-area.js";

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
  // Only the batched relevance read fills this: which of the REQUESTED movement
  // names this symptom plausibly loads. Absent on every other read.
  relevant_movements?: string[];
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

/**
 * Which symptoms may hold a training outcome OUT of the comparable set.
 *
 * Only a current, athlete-confirmed report brakes. A `stale_needs_recheck` one
 * stays visible context — the primer already frames it as needing a recheck —
 * but stops gating comparability, and a legacy import never gates because nobody
 * has confirmed it yet. Staleness ends the GATING only: a symptom is never
 * auto-resolved, because closing one is the athlete's call.
 */
export function symptomGatesComparability(event: TrainingSymptomLifecycle): boolean {
  if (event.legacy_unconfirmed) return false;
  return event.freshness === "acute_movement_brake" || event.freshness === "hold_easy_recheck";
}

function freshness(lastReportedOn: string, on: string): SymptomFreshness {
  const age = daysBetweenISO(on, lastReportedOn);
  if (age == null || age <= 3) return "acute_movement_brake";
  if (age <= 7) return "hold_easy_recheck";
  return "stale_needs_recheck";
}

export function reconcileTrainingSymptomOutcomeDates(from: string): void {
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

export function latestTrainingSymptomEpisode(
  id: number,
  on = localDateISO()
): TrainingSymptomLifecycle | null {
  return latestEpisodeAt(Number(id), validDate(on));
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

// The area label a legacy session note becomes. Free-text session feedback was
// never bounded, so one row can hold a whole agent-written coach paragraph. We
// EXTRACT the area it names rather than importing the prose verbatim; when it
// names no area we recognize, the trimmed text is kept as the athlete's own
// record but cannot drive movement relevance (pain-relevance rejects it), so an
// unmapped note stays visible history instead of shadowing every lift.
function legacyAreaLabel(jointPain: unknown): string {
  return extractSymptomAreaLabel(jointPain) ?? normalizeSymptomArea(jointPain);
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
  // Self-healing: rows imported before the label contract still hold prose. Repair
  // only rows that are still untouched legacy imports — once the athlete confirms
  // or re-reports one, the text is theirs and we leave it alone.
  const repair = db.prepare(
    `UPDATE training_symptom_events SET area_text = ?, updated_at = datetime('now')
     WHERE source_session_id = ? AND source_kind = 'legacy_session_feedback'
       AND legacy_unconfirmed = 1 AND area_text != ?`
  );
  // A session note the athlete ALSO reported explicitly is one symptom, not two.
  // Without this the feedback form doubles every save: it writes sessions.joint_pain
  // and reports the area, then the next list call imports the same note again.
  const explicit = db
    .prepare(
      `SELECT area_text, onset_on FROM training_symptom_events
       WHERE source_kind != 'legacy_session_feedback'`
    )
    .all() as any[];
  const explicitKeys = explicit.map((row) => ({
    key: symptomAreaKey(row.area_text),
    onset_on: String(row.onset_on),
  }));
  for (const row of rows) {
    const area = legacyAreaLabel(row.joint_pain);
    if (!area) continue;
    const date = String(row.date);
    // Repair BEFORE the dedupe below, not after the insert. An already-imported
    // paragraph must heal even when the dedupe skips the insert — otherwise the
    // athlete reporting that same area explicitly is exactly what starves the row
    // that needed repair most, and the prose stays forever. Idempotent: a no-op
    // when the row is absent or already holds the label.
    repair.run(area, Number(row.id), area);
    const key = symptomAreaKey(area);
    if (explicitKeys.some((entry) => entry.key === key && entry.onset_on <= date)) continue;
    inserted += Number(statement.run(Number(row.id), area, date, date).changes);
  }
  return inserted;
}

export function reportTrainingSymptom(input: {
  area_text: string;
  onset_on?: string;
  source_session_id?: number | null;
  source_kind?: string;
}): TrainingSymptomLifecycle {
  const area = normalizeSymptomArea(input.area_text);
  if (!area) throw new Error("area_text required");
  const onset = validDate(input.onset_on);
  const sourceSessionId = input.source_session_id == null ? null : Number(input.source_session_id);
  const sourceKind = String(input.source_kind ?? "explicit").slice(0, 80);
  // One area is ONE open record, whichever surface named it. Matching the normalized
  // label across source_kinds is what keeps an edit ("left knee" -> "outside of left
  // knee") from opening a second row and orphaning the first — and lets an explicit
  // report adopt the legacy import of the same place instead of shadowing it. A
  // repeated delivery of the same report is a retry, not a second symptom; a
  // reappearance AFTER resolution still goes through the dedicated recurrence path.
  const key = symptomAreaKey(area);
  const active = db
    .prepare(
      `SELECT * FROM training_symptom_events
       WHERE onset_on <= ? AND (resolved_on IS NULL OR resolved_on > ?)
       ORDER BY last_reported_on DESC, id DESC`
    )
    .all(onset, onset) as any[];
  const existing = active.find((row) => symptomAreaKey(row.area_text) === key);
  if (existing) {
    const lastReportedOn = String(existing.last_reported_on);
    // Saying it again on a later day IS current evidence, so recency moves. Tolerance
    // evidence does not: only the explicit recurrence path resets an epoch.
    const reportedOn = onset > lastReportedOn ? onset : lastReportedOn;
    // The stored label stays the athlete's. Adopting matches on a normalized KEY,
    // deliberately coarser than the words, so a differently-worded report of the same
    // place must not silently overwrite what they first wrote — and a near-miss key
    // collision must not relabel their row to a place they never named.
    //
    // The ONE exception is an unconfirmed legacy import: that text is machine-
    // extracted prose, not their words, and adopting it is the exact moment it stops
    // being repairable (the seeder's repair is scoped to legacy_unconfirmed = 1). So
    // it takes their real label here, or the import's prose would outlive every path
    // that could have fixed it.
    const adoptLabel = Number(existing.legacy_unconfirmed) === 1;
    if (reportedOn === lastReportedOn && !adoptLabel) {
      return hydrate(existing, onset)!;
    }
    db.prepare(
      `UPDATE training_symptom_events
       SET area_text = ?, last_reported_on = ?, legacy_unconfirmed = 0, updated_at = datetime('now')
       WHERE id = ?`
    ).run(adoptLabel ? area : String(existing.area_text), reportedOn, Number(existing.id));
    const updated = getTrainingSymptom(Number(existing.id), onset)!;
    reconcileTrainingSymptomOutcomeDates(reportedOn);
    return updated;
  }
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
  reconcileTrainingSymptomOutcomeDates(onset);
  return event;
}

export function getTrainingSymptom(id: number, on = localDateISO()): TrainingSymptomLifecycle | null {
  return hydrate(db.prepare(`SELECT * FROM training_symptom_events WHERE id = ?`).get(Number(id)), validDate(on));
}

export function listTrainingSymptoms(
  opts: {
    on?: string;
    include_resolved?: boolean;
    seed_legacy?: boolean;
    movement?: string;
    exercise_id?: number | null;
    movements?: Array<string | null | undefined>;
  } = {}
): TrainingSymptomLifecycle[] {
  if (opts.seed_legacy !== false) seedLegacyTrainingSymptoms();
  const on = validDate(opts.on);
  // Already seeded (or deliberately not) above — the delegates must not repeat it.
  if (opts.movements != null) {
    return trainingSymptomsForMovements(on, opts.movements, { seed_legacy: false });
  }
  if (opts.movement != null || opts.exercise_id != null) {
    const identity = resolveMovementIdentity(opts.movement, opts.exercise_id);
    if (identity.exercise_id == null) throw new Error("movement must identify an existing exercise");
    return activeRelevantTrainingSymptoms(
      on,
      { name: identity.movement_name, muscle_group: identity.muscle_group },
      { seed_legacy: false }
    );
  }
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

// Which of a whole session's movements a currently active symptom plausibly
// loads — one read for one session render, so no surface has to ask per card and
// none of them carries a client-side copy of the pain→movement map. An imported
// `legacy_unconfirmed` row is absence of evidence, so it never claims a movement
// (the same exclusion `dailyDecisionSnapshot` applies).
export function trainingSymptomsForMovements(
  on: string,
  movements: Array<string | null | undefined>,
  opts: { seed_legacy?: boolean } = {}
): TrainingSymptomLifecycle[] {
  const readOn = validDate(on);
  if (opts.seed_legacy !== false) seedLegacyTrainingSymptoms();
  const wanted: Array<{ name: string; muscle_group: string | null }> = [];
  const seen = new Set<string>();
  for (const raw of movements) {
    const name = String(raw ?? "")
      .trim()
      .slice(0, 120);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    // A name with no exercises row still crosses the movement half of the map;
    // only the muscle-group half needs the row, so a miss is normal, not an error.
    const row = db.prepare(`SELECT muscle_group FROM exercises WHERE name = ? COLLATE NOCASE`).get(name) as any;
    wanted.push({ name, muscle_group: row?.muscle_group == null ? null : String(row.muscle_group) });
  }
  if (!wanted.length) return [];
  const rows = db
    .prepare(
      `SELECT * FROM training_symptom_events
       WHERE onset_on <= ? AND (resolved_on IS NULL OR resolved_on > ?)
         AND legacy_unconfirmed = 0
       ORDER BY last_reported_on DESC, id DESC`
    )
    .all(readOn, readOn) as any[];
  const events: TrainingSymptomLifecycle[] = [];
  for (const row of rows) {
    const relevant = wanted
      .filter((movement) => painAreaLoadsExercise(String(row.area_text), movement))
      .map((movement) => movement.name);
    if (!relevant.length) continue;
    const event = hydrate(row, readOn);
    if (event) events.push({ ...event, relevant_movements: relevant });
  }
  return events;
}

export function activeRelevantTrainingSymptoms(
  on: string,
  exercise: { name?: string | null; muscle_group?: string | null },
  opts: { seed_legacy?: boolean } = {}
): TrainingSymptomLifecycle[] {
  const readOn = validDate(on);
  if (opts.seed_legacy !== false) seedLegacyTrainingSymptoms();
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
  reconcileTrainingSymptomOutcomeDates(resolvedOn);
  return event;
}

/**
 * Close the open record for a named AREA. Chat's counterpart to the id-addressed
 * resolve the surfaces and MCP use: in conversation the athlete says "my knee's
 * fine now", not a row id, so the area label is the identity. Returns null when
 * no open record matches — never guesses at a neighbouring area.
 */
export function resolveTrainingSymptomByArea(
  areaText: string,
  on = localDateISO()
): TrainingSymptomLifecycle | null {
  const resolvedOn = validDate(on);
  const key = symptomAreaKey(areaText);
  if (!key) return null;
  const match = listTrainingSymptoms({ on: resolvedOn })
    .filter((event) => symptomAreaKey(event.area_text) === key)
    .sort((a, b) => b.last_reported_on.localeCompare(a.last_reported_on) || b.id - a.id)[0];
  return match ? resolveTrainingSymptom(match.id, resolvedOn) : null;
}

export function recurTrainingSymptom(
  id: number,
  input: {
    on?: string;
    area_text?: string;
    movement?: string | null;
    exercise_id?: number | null;
    session_id?: number | null;
  } = {}
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
  const area = input.area_text == null ? existing.area_text : normalizeSymptomArea(input.area_text) || existing.area_text;
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
        reconcileTrainingSymptomOutcomeDates(on);
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
       VALUES (?, ?, ?, ?, ?, ?, 'pain_present', 1, ?)`
    ).run(eventId, input.session_id == null ? null : Number(input.session_id), exerciseId, key, movementName, on, nextEpoch);
    db.exec("RELEASE recur_training_symptom");
    const recurred = getTrainingSymptom(eventId, on);
    reconcileTrainingSymptomOutcomeDates(on);
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
          session_id: input.session_id,
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
  if (inserted) reconcileTrainingSymptomOutcomeDates(observedOn);
  return getTrainingSymptom(event.id, observedOn);
}
