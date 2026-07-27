import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables("movement_tolerance_observations", "training_symptom_events", "logged_sets", "sessions", "exercises");
  repo.findOrCreateExercise("Back Squat", "quads");
  repo.findOrCreateExercise("Reverse Lunge", "quads");
  repo.findOrCreateExercise("Bench Press", "chest");
});

test("legacy joint pain seeds as unconfirmed while null feedback is no evidence", () => {
  db.prepare(`INSERT INTO sessions (date, joint_pain) VALUES ('2034-01-01', 'left knee')`).run();
  db.prepare(`INSERT INTO sessions (date, joint_pain) VALUES ('2034-01-02', NULL)`).run();
  assert.equal(repo.seedLegacyTrainingSymptoms(), 1);
  assert.equal(repo.seedLegacyTrainingSymptoms(), 0, "legacy seeding is idempotent");
  const events = repo.listTrainingSymptoms({ on: "2034-01-03" });
  assert.equal(events.length, 1);
  assert.equal(events[0].legacy_unconfirmed, true);
  assert.equal(events[0].freshness, "acute_movement_brake");
  assert.equal(events[0].scope, "movement_only");
});

test("same-source report retries are idempotent and an explicit exercise id preserves movement identity", () => {
  const squat = repo.findExercise("Back Squat");
  const session = repo.getOrCreateSession("2034-01-10");
  const first = repo.reportTrainingSymptom({
    area_text: "left knee",
    onset_on: "2034-01-10",
    source_session_id: session.id,
    source_kind: "surface_test",
  });
  const retry = repo.reportTrainingSymptom({
    area_text: "LEFT KNEE",
    onset_on: "2034-01-10",
    source_session_id: session.id,
    source_kind: "surface_test",
  });
  assert.equal(retry.id, first.id);

  const observed = repo.recordMovementTolerance({
    symptom_event_id: first.id,
    movement: "client display name is ignored",
    exercise_id: squat.id,
    observed_on: "2034-01-11",
    pain_free: true,
  });
  assert.equal(observed.movement_readiness[0].movement_key, `exercise:${squat.id}`);
  assert.equal(observed.movement_readiness[0].movement_name, "Back Squat");
});

test("two relevant pain-free exposures make a movement trial-ready but never resolved", () => {
  const symptom = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2034-02-01" });
  const nullRead = repo.recordMovementTolerance({
    symptom_event_id: symptom.id,
    movement: "Back Squat",
    observed_on: "2034-02-02",
    pain_free: null,
  });
  assert.equal(nullRead.relevant_pain_free_exposures, 0);

  const unrelated = repo.recordMovementTolerance({
    symptom_event_id: symptom.id,
    movement: "Bench Press",
    observed_on: "2034-02-02",
    pain_free: true,
  });
  assert.equal(unrelated.relevant_pain_free_exposures, 0, "unrelated movement cannot clear knee concern");

  const lunge = repo.recordMovementTolerance({
    symptom_event_id: symptom.id,
    movement: "Reverse Lunge",
    observed_on: "2034-02-03",
    pain_free: true,
  });
  assert.equal(lunge.trial_ready, false);

  const firstSquat = repo.recordMovementTolerance({
    symptom_event_id: symptom.id,
    movement: "Back Squat",
    observed_on: "2034-02-04",
    pain_free: true,
  });
  assert.equal(firstSquat.trial_ready, false, "one exposure to each of two movements cannot combine");
  const second = repo.recordMovementTolerance({
    symptom_event_id: symptom.id,
    movement: "Back Squat",
    observed_on: "2034-02-05",
    pain_free: true,
  });
  assert.equal(second.relevant_pain_free_exposures, 3);
  assert.equal(second.trial_ready, true);
  assert.equal(second.trial_ready_scope, "movement");
  assert.deepEqual(
    second.movement_readiness.map((movement) => ({
      movement: movement.movement_name,
      exposures: movement.pain_free_exposures,
      trial_ready: movement.trial_ready,
    })),
    [
      { movement: "Reverse Lunge", exposures: 1, trial_ready: false },
      { movement: "Back Squat", exposures: 2, trial_ready: true },
    ],
    "readiness is exposed for the exact movement, not the whole symptom area"
  );
  assert.equal(second.status, "active", "observed tolerance is not explicit resolution");
});

test("freshness decays to recheck and recurrence reopens an explicitly resolved symptom", () => {
  const symptom = repo.reportTrainingSymptom({ area_text: "right elbow", onset_on: "2034-03-01" });
  assert.equal(repo.getTrainingSymptom(symptom.id, "2034-03-04").freshness, "acute_movement_brake");
  assert.equal(repo.getTrainingSymptom(symptom.id, "2034-03-06").freshness, "hold_easy_recheck");
  assert.equal(repo.getTrainingSymptom(symptom.id, "2034-03-10").freshness, "stale_needs_recheck");

  const resolved = repo.resolveTrainingSymptom(symptom.id, "2034-03-10");
  assert.equal(resolved.status, "resolved");
  const recurred = repo.recurTrainingSymptom(symptom.id, {
    on: "2034-03-12",
    area_text: "right elbow soreness again",
  });
  assert.notEqual(recurred.id, symptom.id, "a recurrence is a new durable episode");
  assert.equal(recurred.status, "active");
  assert.equal(recurred.resolved_on, null);
  assert.equal(recurred.recurrence_count, 1);
  assert.equal(recurred.freshness, "acute_movement_brake");
});

test("symptom dates are real and lifecycle mutations cannot cross episode chronology", () => {
  assert.throws(
    () => repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2034-02-30" }),
    /real YYYY-MM-DD/
  );
  const symptom = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2034-03-10" });
  assert.throws(() => repo.resolveTrainingSymptom(symptom.id, "2034-03-09"), /before symptom onset/);
  assert.throws(
    () =>
      repo.recordMovementTolerance({
        symptom_event_id: symptom.id,
        movement: "Back Squat",
        observed_on: "2034-03-09",
        pain_free: true,
      }),
    /before symptom onset/
  );
  const resolved = repo.resolveTrainingSymptom(symptom.id, "2034-03-12");
  assert.equal(resolved.resolved_on, "2034-03-12");
  assert.throws(
    () => repo.recurTrainingSymptom(symptom.id, { on: "2034-03-11", movement: "Back Squat" }),
    /before the current episode resolution/
  );
  assert.throws(
    () =>
      repo.recordMovementTolerance({
        symptom_event_id: symptom.id,
        movement: "Back Squat",
        observed_on: "2034-13-01",
        pain_free: true,
      }),
    /real YYYY-MM-DD/
  );
  assert.equal(
    repo.resolveTrainingSymptom(symptom.id, "2034-03-20").resolved_on,
    "2034-03-12",
    "a later resolve retry cannot rewrite the historical boundary"
  );
});

test("a relevant pain-present observation is recurrence evidence, never whole-body rest", () => {
  const symptom = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2034-04-01" });
  repo.recordMovementTolerance({
    symptom_event_id: symptom.id,
    movement: "Back Squat",
    observed_on: "2034-04-03",
    pain_free: true,
  });
  const ready = repo.recordMovementTolerance({
    symptom_event_id: symptom.id,
    movement: "Back Squat",
    observed_on: "2034-04-05",
    pain_free: true,
  });
  assert.equal(ready.movement_readiness[0].trial_ready, true);
  const observed = repo.recordMovementTolerance({
    symptom_event_id: symptom.id,
    movement: "Back Squat",
    observed_on: "2034-04-07",
    pain_free: false,
  });
  assert.equal(observed.recurrence_count, 1);
  assert.equal(observed.last_reported_on, "2034-04-07");
  assert.equal(observed.scope, "movement_only");
  assert.equal(observed.trial_ready, false);
  assert.equal(observed.movement_readiness[0].pain_free_exposures, 0, "recurrence resets only this movement");
});

test("explicit recurrence starts a new episode and resets only the named movement in its evidence epoch", () => {
  const symptom = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2034-05-01" });
  for (const movement of ["Back Squat", "Reverse Lunge"]) {
    repo.recordMovementTolerance({
      symptom_event_id: symptom.id,
      movement,
      observed_on: "2034-05-02",
      pain_free: true,
    });
    repo.recordMovementTolerance({
      symptom_event_id: symptom.id,
      movement,
      observed_on: "2034-05-03",
      pain_free: true,
    });
  }
  const ready = repo.getTrainingSymptom(symptom.id, "2034-05-03");
  assert.equal(ready.movement_readiness.every((movement) => movement.trial_ready), true);
  repo.resolveTrainingSymptom(symptom.id, "2034-05-04");

  const recurred = repo.recurTrainingSymptom(symptom.id, {
    on: "2034-05-05",
    movement: "Back Squat",
  });
  assert.notEqual(recurred.id, symptom.id);
  assert.equal(recurred.evidence_epoch, 2);
  assert.equal(recurred.status, "active");
  assert.deepEqual(
    recurred.movement_readiness.map((movement) => [
      movement.movement_name,
      movement.pain_free_exposures,
      movement.trial_ready,
    ]),
    [
      ["Reverse Lunge", 2, true],
      ["Back Squat", 0, false],
    ]
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations WHERE symptom_event_id = ?`).get(symptom.id).n,
    4,
    "the resolved episode keeps its evidence unchanged"
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations WHERE symptom_event_id = ?`).get(recurred.id)
      .n,
    3,
    "the recurrence marker and unaffected movement evidence belong to the new episode"
  );

  const retry = repo.recurTrainingSymptom(symptom.id, { on: "2034-05-05", movement: "Back Squat" });
  assert.equal(retry.id, recurred.id);
  assert.equal(retry.recurrence_count, 1, "same recurrence retry is idempotent");
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations`).get().n,
    7,
    "retry creates neither an episode nor an observation"
  );
});

test("a stable ancestor id updates the latest recurrence episode and same-date retries stay idempotent", () => {
  const symptom = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2034-05-10" });
  repo.resolveTrainingSymptom(symptom.id, "2034-05-11");
  const child = repo.recurTrainingSymptom(symptom.id, {
    on: "2034-05-12",
    movement: "Back Squat",
  });
  const later = repo.recurTrainingSymptom(symptom.id, {
    on: "2034-05-15",
    movement: "Reverse Lunge",
  });
  assert.equal(later.id, child.id, "the root id resolves to the latest durable episode");
  assert.equal(later.last_reported_on, "2034-05-15");
  assert.equal(later.recurrence_count, 2);
  assert.equal(later.evidence_epoch, 3);
  assert.equal(
    db.prepare(`SELECT last_reported_on FROM training_symptom_events WHERE id = ?`).get(symptom.id).last_reported_on,
    "2034-05-10",
    "the resolved ancestor is immutable"
  );
  assert.deepEqual(
    {
      ...db
        .prepare(
          `SELECT symptom_event_id, observed_on, evidence_epoch
             FROM movement_tolerance_observations
            WHERE observed_on = '2034-05-15'`
        )
        .get(),
    },
    { symptom_event_id: child.id, observed_on: "2034-05-15", evidence_epoch: 3 }
  );

  const observationCount = db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations`).get().n;
  const retry = repo.recurTrainingSymptom(symptom.id, {
    on: "2034-05-15",
    movement: "Reverse Lunge",
  });
  assert.equal(retry.id, child.id);
  assert.equal(retry.evidence_epoch, 3);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations`).get().n, observationCount);
});

test("an unknown-movement recurrence clears every movement and null-session retries do not duplicate", () => {
  const symptom = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2034-06-01" });
  for (const movement of ["Back Squat", "Reverse Lunge"]) {
    for (const observed_on of ["2034-06-02", "2034-06-03"]) {
      repo.recordMovementTolerance({
        symptom_event_id: symptom.id,
        movement,
        observed_on,
        pain_free: true,
      });
    }
  }
  repo.resolveTrainingSymptom(symptom.id, "2034-06-04");
  const recurred = repo.recurTrainingSymptom(symptom.id, { on: "2034-06-05" });
  assert.deepEqual(recurred.movement_readiness, []);

  const first = repo.recordMovementTolerance({
    symptom_event_id: symptom.id,
    movement: "Back Squat",
    observed_on: "2034-06-06",
    pain_free: false,
  });
  const retry = repo.recordMovementTolerance({
    symptom_event_id: symptom.id,
    movement: "Back Squat",
    observed_on: "2034-06-06",
    pain_free: false,
  });
  assert.equal(first.recurrence_count, 2);
  assert.equal(retry.recurrence_count, 2);
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM movement_tolerance_observations
         WHERE symptom_event_id = ? AND observed_on = '2034-06-06'`
      )
      .get(recurred.id).n,
    1,
    "the partial unique index covers NULL session_id retries"
  );
});

test("resolved gaps remain historically inactive after recurrence and late reads stay date-true", () => {
  const squat = repo.findOrCreateExercise("Back Squat", "quads");
  const symptom = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2034-06-01" });
  repo.recordMovementTolerance({
    symptom_event_id: symptom.id,
    movement: "Back Squat",
    observed_on: "2034-06-02",
    pain_free: true,
  });
  repo.recordMovementTolerance({
    symptom_event_id: symptom.id,
    movement: "Back Squat",
    observed_on: "2034-06-03",
    pain_free: true,
  });
  assert.equal(repo.getTrainingSymptom(symptom.id, "2034-06-03").trial_ready, true);
  repo.resolveTrainingSymptom(symptom.id, "2034-06-04");

  const recurred = repo.recurTrainingSymptom(symptom.id, {
    on: "2034-06-10",
    movement: "Back Squat",
  });
  assert.notEqual(recurred.id, symptom.id);
  assert.equal(recurred.trial_ready, false);
  assert.equal(recurred.evidence_epoch, 2);

  assert.deepEqual(repo.listTrainingSymptoms({ on: "2034-06-07" }), []);
  assert.deepEqual(
    repo.activeRelevantTrainingSymptoms("2034-06-07", { name: squat.name, muscle_group: "quads" }),
    [],
    "late reconciliation of a gap session cannot see the later recurrence"
  );
  assert.deepEqual(
    repo.activeRelevantTrainingSymptoms("2034-06-10", { name: squat.name, muscle_group: "quads" }).map(
      (event) => event.id
    ),
    [recurred.id]
  );
  assert.equal(repo.getTrainingSymptom(symptom.id, "2034-06-03").status, "active");
  assert.equal(repo.getTrainingSymptom(symptom.id, "2034-06-07").status, "resolved");

  const retry = repo.recurTrainingSymptom(symptom.id, { on: "2034-06-10", movement: "Back Squat" });
  assert.equal(retry.id, recurred.id);
  assert.equal(retry.recurrence_count, 1);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n,
    2,
    "retry does not create another episode"
  );
});
