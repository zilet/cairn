import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, isoDaysAgo, repo, resetTables } from "./_seed.js";
// pain-relevance is not barrelled through repo.js — import the module directly.
import { muscleGroupsForPainArea, painAreaLoadsExercise } from "../dist/repo/pain-relevance.js";
import { painBandDecision, painBandForMovement } from "../dist/repo/pain-band.js";

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
  assert.equal(events[0].scope, "area", "a legacy import names a place, so it stays area-scoped");
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
  assert.equal(observed.scope, "area");
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

// ---- area labels: the contract that keeps relevance honest ------------------
// A symptom's area_text is a LABEL (where it hurts), never prose. The historical
// incident this guards: one agent-written coach paragraph landed in a symptom row,
// pain-relevance matched "back"/"press"/"row" inside it, and every logged movement
// became "relevant" — which made every training outcome permanently non-comparable.

test("an area label is normalized to one short clause at every write path", () => {
  const paragraph =
    "Left knee felt tight through the warm-up today. I backed off the squats and " +
    "worked around it with a press and a row, so keep the volume conservative for now.";

  const reported = repo.reportTrainingSymptom({ area_text: paragraph, onset_on: "2034-03-01" });
  assert.ok(reported.area_text.length <= 60, "a paragraph is trimmed to a label");
  assert.equal(reported.area_text, "Left knee felt tight through the warm-up today");

  // A different area, so this exercises the normalizer rather than adoption.
  const spaced = repo.reportTrainingSymptom({
    area_text: "  outside   of\n the LEFT elbow  ",
    onset_on: "2034-03-02",
    source_kind: "surface_test",
  });
  assert.equal(spaced.area_text, "outside of the LEFT elbow", "whitespace collapses, wording is kept");

  repo.setSessionFeedback("2034-03-03", { joint_pain: paragraph });
  const stored = db.prepare(`SELECT joint_pain FROM sessions WHERE date = '2034-03-03'`).get().joint_pain;
  assert.ok(stored.length <= 60, "session joint_pain obeys the same label contract");
});

test("an over-long or unmapped area cannot make every lift look symptomatic", () => {
  const squat = repo.findExercise("Back Squat");
  const paragraph =
    "Keep the back neutral on every press and row today, and treat the squat as a " +
    "gentle check rather than a hard session while things settle down.";

  assert.equal(
    painAreaLoadsExercise(paragraph, { name: squat.name, muscle_group: squat.muscle_group }),
    false,
    "prose long enough to match several maps at once drives NO relevance"
  );
  assert.equal(
    painAreaLoadsExercise("just feeling a bit flat", { name: squat.name, muscle_group: "quads" }),
    false,
    "text naming no area Cairn recognizes matches nothing"
  );
  assert.equal(
    painAreaLoadsExercise("left knee", { name: squat.name, muscle_group: "quads" }),
    true,
    "a real short label still works"
  );
  assert.deepEqual(muscleGroupsForPainArea(paragraph), []);
});

test("legacy session prose imports as an extracted area label, not the paragraph", () => {
  db.prepare(
    `INSERT INTO sessions (date, joint_pain) VALUES ('2034-04-01', ?)`
  ).run("Right shoulder was grumpy on the top set. Nothing sharp, just achy afterwards.");
  db.prepare(`INSERT INTO sessions (date, joint_pain) VALUES ('2034-04-02', 'felt generally flat')`).run();

  assert.equal(repo.seedLegacyTrainingSymptoms(), 2);
  const events = repo.listTrainingSymptoms({ on: "2034-04-05" });
  const shoulder = events.find((event) => /shoulder/i.test(event.area_text));
  assert.equal(shoulder.area_text, "right shoulder", "the joint vocabulary extracts the area");
  assert.equal(shoulder.legacy_unconfirmed, true);

  const unmapped = events.find((event) => /flat/i.test(event.area_text));
  assert.ok(unmapped, "an unrecognized note is still kept as the athlete's record");
  assert.equal(
    painAreaLoadsExercise(unmapped.area_text, { name: "Back Squat", muscle_group: "quads" }),
    false,
    "but it cannot drive relevance"
  );
});

test("a legacy row imported before the label contract is repaired in place", () => {
  const paragraph = "Left knee tightness — ease the squats, keep the press and row light, and recheck in a week.";
  db.prepare(`INSERT INTO sessions (date, joint_pain) VALUES ('2034-04-10', ?)`).run(paragraph);
  db.prepare(
    `INSERT INTO training_symptom_events
       (source_session_id, source_kind, area_text, status, onset_on, last_reported_on, legacy_unconfirmed)
     SELECT id, 'legacy_session_feedback', ?, 'active', date, date, 1 FROM sessions WHERE date = '2034-04-10'`
  ).run(paragraph);

  repo.seedLegacyTrainingSymptoms();
  const repaired = repo.listTrainingSymptoms({ on: "2034-04-11" })[0];
  assert.equal(repaired.area_text, "left knee");
});

test("the same area reported again updates one record instead of doubling it", () => {
  const session = repo.getOrCreateSession("2034-05-01");
  const first = repo.reportTrainingSymptom({
    area_text: "left knee",
    onset_on: "2034-05-01",
    source_session_id: session.id,
    source_kind: "session_feedback",
  });
  // A different surface, a different day, an edited wording — still one place.
  const edited = repo.reportTrainingSymptom({
    area_text: "outside of left knee",
    onset_on: "2034-05-03",
    source_kind: "chat_explicit",
  });
  assert.equal(edited.id, first.id, "an edit updates in place across source kinds");
  assert.equal(
    edited.area_text,
    "left knee",
    "adopting matches on a key coarser than the words, so the athlete's own label is never overwritten"
  );
  assert.equal(edited.last_reported_on, "2034-05-03", "saying it again is current evidence");
  assert.equal(edited.evidence_epoch, first.evidence_epoch, "a re-report never wipes tolerance evidence");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n, 1);
});

test("an explicit report adopts the legacy import of the same place", () => {
  repo.setSessionFeedback("2034-05-10", { joint_pain: "left knee" });
  repo.listTrainingSymptoms({ on: "2034-05-10" }); // triggers the legacy import
  const legacy = repo.listTrainingSymptoms({ on: "2034-05-10" })[0];
  assert.equal(legacy.legacy_unconfirmed, true);

  const confirmed = repo.reportTrainingSymptom({ area_text: "Left Knee", onset_on: "2034-05-11" });
  assert.equal(confirmed.id, legacy.id);
  assert.equal(confirmed.legacy_unconfirmed, false, "the athlete confirming it clears the unconfirmed flag");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n, 1);
});

test("only a current, confirmed symptom may gate comparability", () => {
  const acute = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2034-06-01" });
  assert.equal(repo.symptomGatesComparability(repo.getTrainingSymptom(acute.id, "2034-06-02")), true);
  assert.equal(repo.symptomGatesComparability(repo.getTrainingSymptom(acute.id, "2034-06-06")), true);

  const stale = repo.getTrainingSymptom(acute.id, "2034-06-20");
  assert.equal(stale.freshness, "stale_needs_recheck");
  assert.equal(stale.status, "active", "staleness NEVER auto-resolves a symptom — the athlete owns closure");
  assert.equal(repo.symptomGatesComparability(stale), false, "but it stops holding outcomes non-comparable");

  db.prepare(`INSERT INTO sessions (date, joint_pain) VALUES ('2034-06-02', 'right shoulder')`).run();
  repo.seedLegacyTrainingSymptoms();
  const imported = repo
    .listTrainingSymptoms({ on: "2034-06-03" })
    .find((event) => event.legacy_unconfirmed);
  assert.equal(imported.freshness, "acute_movement_brake");
  assert.equal(repo.symptomGatesComparability(imported), false, "an unconfirmed import never gates");
});

test("chat can close the open record for an area it names", () => {
  const knee = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2034-07-01" });
  repo.reportTrainingSymptom({ area_text: "right shoulder", onset_on: "2034-07-01" });

  assert.equal(repo.resolveTrainingSymptomByArea("something vague", "2034-07-05"), null);
  const closed = repo.resolveTrainingSymptomByArea("my left knee", "2034-07-05");
  assert.equal(closed.id, knee.id);
  assert.equal(closed.status, "resolved");
  assert.equal(closed.resolved_on, "2034-07-05");
  assert.equal(
    repo.listTrainingSymptoms({ on: "2034-07-05" }).length,
    1,
    "the other area stays open — closing is scoped to what they named"
  );
  assert.equal(repo.resolveTrainingSymptomByArea("left knee", "2034-07-06"), null, "already closed");
});

// The Brief read raw last-4-sessions joint_pain text, so "Mark resolved" changed
// nothing: the same area kept warning every morning until the row was deleted.
test("the coach's joint rollup goes quiet once the athlete closes that area", () => {
  const { trainingSignals } = repo;
  db.prepare(`INSERT INTO sessions (date, joint_pain) VALUES (?, 'left knee')`).run(isoDaysAgo(2));
  db.prepare(`INSERT INTO sessions (date, joint_pain) VALUES (?, 'right shoulder')`).run(isoDaysAgo(1));

  const before = trainingSignals();
  assert.deepEqual(before.autoregulation.joint_areas.sort(), ["left knee", "right shoulder"]);

  const knee = repo
    .listTrainingSymptoms({})
    .find((event) => /knee/i.test(event.area_text));
  repo.resolveTrainingSymptom(knee.id);

  const after = trainingSignals();
  assert.deepEqual(
    after.autoregulation.joint_areas,
    ["right shoulder"],
    "the closed area drops out; the still-open one keeps speaking"
  );
});

// ---- review findings: repair starvation, lossy identity, lost relevance -----

// Two ways a legacy paragraph used to be starved of repair. Both matter: the live
// poisoned row is a paragraph an agent wrote into sessions.joint_pain, and it only
// ever heals through one of these paths.

// (1) The seeder ran repair only when the INSERT was a no-op, and the explicit-report
// dedupe `continue`d before reaching it — so the row most in need of repair was the
// one row that could never get it.
test("a legacy paragraph is repaired even when the dedupe skips its insert", () => {
  const paragraph = "Left knee tightness — ease the squats, keep the press and row light, and recheck in a week.";
  // The athlete reported the knee explicitly BEFORE this session's note existed, so
  // the later import is deduped away — but the row is already in the table.
  repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2034-08-01", source_kind: "chat_explicit" });
  db.prepare(`INSERT INTO sessions (date, joint_pain) VALUES ('2034-08-05', ?)`).run(paragraph);
  db.prepare(
    `INSERT INTO training_symptom_events
       (source_session_id, source_kind, area_text, status, onset_on, last_reported_on, legacy_unconfirmed)
     SELECT id, 'legacy_session_feedback', ?, 'active', date, date, 1 FROM sessions WHERE date = '2034-08-05'`
  ).run(paragraph);

  repo.seedLegacyTrainingSymptoms();

  const legacy = db
    .prepare(`SELECT area_text, legacy_unconfirmed FROM training_symptom_events WHERE source_kind = 'legacy_session_feedback'`)
    .get();
  assert.equal(legacy.area_text, "left knee", "repair runs before the dedupe skip, not after the insert");
  assert.equal(legacy.legacy_unconfirmed, 1, "repairing the text does not confirm it on the athlete's behalf");
  assert.equal(
    painAreaLoadsExercise(legacy.area_text, { name: "Back Squat", muscle_group: "quads" }),
    true,
    "and the healed row can drive relevance again"
  );
});

// (2) When an explicit report ADOPTS an unconfirmed import it clears the flag the
// seeder's repair is scoped to — so that adoption has to carry the athlete's real
// label, or the prose outlives every path that could have fixed it.
test("adopting an unconfirmed import takes the athlete's label instead of keeping the prose", () => {
  const paragraph = "Right shoulder was grumpy on the top set. Nothing sharp, just achy afterwards.";
  db.prepare(`INSERT INTO sessions (date, joint_pain) VALUES ('2034-08-10', ?)`).run(paragraph);
  db.prepare(
    `INSERT INTO training_symptom_events
       (source_session_id, source_kind, area_text, status, onset_on, last_reported_on, legacy_unconfirmed)
     SELECT id, 'legacy_session_feedback', ?, 'active', date, date, 1 FROM sessions WHERE date = '2034-08-10'`
  ).run(paragraph);

  const confirmed = repo.reportTrainingSymptom({ area_text: "right shoulder", onset_on: "2034-08-11" });

  assert.equal(confirmed.area_text, "right shoulder");
  assert.equal(confirmed.legacy_unconfirmed, false);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n, 1, "adopted, not doubled");
});

test("upper, mid and lower back are distinct places that never adopt one another", () => {
  const upper = repo.reportTrainingSymptom({ area_text: "upper back", onset_on: "2034-09-01" });
  const mid = repo.reportTrainingSymptom({ area_text: "mid back", onset_on: "2034-09-01" });
  const lower = repo.reportTrainingSymptom({ area_text: "lower back", onset_on: "2034-09-01" });

  assert.equal(new Set([upper.id, mid.id, lower.id]).size, 3, "three places, three records");
  assert.equal(upper.area_text, "upper back");
  assert.equal(mid.area_text, "mid back");
  // Each still loads the same movements the bare "back" did — only identity split.
  for (const area of ["upper back", "mid back", "lower back"]) {
    assert.equal(
      painAreaLoadsExercise(area, { name: "Back Squat", muscle_group: "quads" }),
      true,
      `${area} keeps its relevance`
    );
  }
});

// The reviewer diffed 46 labels x 7 exercises; these two were the only mappings the
// relevance gate silently dropped, because pain-relevance matches \bac\b and \bsi\b
// but the vocabulary did not recognize either as an area.
test("AC joint and SI keep the relevance pain-relevance maps for them", () => {
  assert.equal(
    painAreaLoadsExercise("AC joint", { name: "Bench Press", muscle_group: "chest" }),
    true,
    "AC joint loads pressing"
  );
  assert.equal(
    painAreaLoadsExercise("left ac joint", { name: "Bench Press", muscle_group: "chest" }),
    true
  );
  assert.equal(
    painAreaLoadsExercise("SI", { name: "Back Squat", muscle_group: "quads" }),
    true,
    "SI loads squat/hinge"
  );
  assert.equal(
    painAreaLoadsExercise("sacroiliac", { name: "Back Squat", muscle_group: "quads" }),
    true
  );

  // And they carry a real identity, so two SI reports are one record.
  const first = repo.reportTrainingSymptom({ area_text: "SI joint", onset_on: "2034-10-01" });
  const again = repo.reportTrainingSymptom({ area_text: "sacroiliac", onset_on: "2034-10-02" });
  assert.equal(again.id, first.id);
  assert.equal(again.area_text, "SI joint", "the first wording stands");
});

// ---------------------------------------------------------------------------
// THE PAIN TRAFFIC LIGHT (src/repo/pain-band.ts)
//
// Cairn's capture contract carries no 0-10 severity and this deliberately does not
// add one, so the three bands are mapped onto the vocabulary capture already
// produces: a stated pain_present exposure with the settling question still open is
// AMBER, one the athlete's own words or a later exposure settled is GREEN, and
// 'worse' / two painful days inside a week is RED. Absence is none of the three.
test("pain bands: absent, amber, settled-green, worse-red and unsettled-red", () => {
  const band = (input) => painBandDecision({ as_of: "2034-03-20", changes: [], doms: null, ...input });

  assert.equal(band({ exposures: [] }), null, "nothing stated → ABSENT, not green");
  assert.equal(
    band({ exposures: [{ on: "2034-03-18", outcome: "pain_present", evidence: "inferred" }] }),
    null,
    "quiet training is never a statement about how it felt"
  );

  const amber = band({ exposures: [{ on: "2034-03-18", outcome: "pain_present", evidence: "stated" }] });
  assert.equal(amber.band, "amber");
  assert.equal(amber.settled, null, "the 24-hour question is still open");

  const settled = band({
    exposures: [
      { on: "2034-03-18", outcome: "pain_present", evidence: "stated" },
      { on: "2034-03-19", outcome: "pain_free", evidence: "stated" },
    ],
  });
  assert.equal(settled.band, "green", "it settled by the next exposure");
  assert.equal(settled.settled, true);

  const better = band({
    exposures: [{ on: "2034-03-18", outcome: "pain_present", evidence: "stated" }],
    changes: [{ on: "2034-03-19", change: "better" }],
  });
  assert.equal(better.band, "green", "the athlete's own word settles it too");

  const worse = band({
    exposures: [{ on: "2034-03-18", outcome: "pain_present", evidence: "stated" }],
    changes: [{ on: "2034-03-19", change: "worse" }],
  });
  assert.equal(worse.band, "red");
  assert.equal(worse.settled, false);

  const unsettled = band({
    exposures: [
      { on: "2034-03-16", outcome: "pain_present", evidence: "stated" },
      { on: "2034-03-19", outcome: "pain_present", evidence: "stated" },
    ],
  });
  assert.equal(unsettled.band, "red", "two painful days inside a week is week-over-week unsettled");

  const old = band({
    exposures: [
      { on: "2034-03-01", outcome: "pain_present", evidence: "stated" },
      { on: "2034-03-19", outcome: "pain_present", evidence: "stated" },
    ],
  });
  assert.equal(old.band, "amber", "a painful day a fortnight earlier is not this episode");
});

test("DOMS: symmetric soreness a day after a novel dose is NOT amber, and one 'worse' word ends that", () => {
  const doms = { novel_exposure_on: "2034-03-17", symmetric: true };
  const trainThrough = painBandDecision({
    as_of: "2034-03-20",
    exposures: [{ on: "2034-03-19", outcome: "pain_present", evidence: "stated" }],
    changes: [],
    doms,
  });
  assert.equal(trainThrough.band, "green");
  assert.equal(trainThrough.doms, true);

  // One-sided, so the shape is indistinguishable from a symptom → err amber (safe).
  const oneSided = painBandDecision({
    as_of: "2034-03-20",
    exposures: [{ on: "2034-03-19", outcome: "pain_present", evidence: "stated" }],
    changes: [],
    doms: { novel_exposure_on: "2034-03-17", symmetric: false },
  });
  assert.equal(oneSided.band, "amber");

  // A week after the novel dose is outside the 24-72h peak → not the DOMS shape.
  const tooLate = painBandDecision({
    as_of: "2034-03-26",
    exposures: [{ on: "2034-03-25", outcome: "pain_present", evidence: "stated" }],
    changes: [],
    doms,
  });
  assert.equal(tooLate.band, "amber");

  const gotWorse = painBandDecision({
    as_of: "2034-03-20",
    exposures: [{ on: "2034-03-19", outcome: "pain_present", evidence: "stated" }],
    changes: [{ on: "2034-03-19", change: "worse" }],
    doms,
  });
  assert.equal(gotWorse.band, "red", "the DOMS reading can never survive the athlete saying it got worse");
});

test("a systemic report drives no movement band, and one movement's band is its own", () => {
  const squat = repo.findExercise("Back Squat");
  const bench = repo.findExercise("Bench Press");
  const systemic = repo.reportTrainingSymptom({
    area_text: "everything feels off",
    onset_on: "2034-04-01",
    scope: "systemic",
  });
  repo.recordMovementTolerance({
    symptom_event_id: systemic.id,
    movement: "Back Squat",
    exercise_id: squat.id,
    observed_on: "2034-04-02",
    pain_free: false,
  });
  assert.equal(
    painBandForMovement({ id: squat.id, name: "Back Squat", muscle_group: "quads" }, "2034-04-03"),
    null,
    "a watch that names no place can never load one lift"
  );

  const knee = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2034-04-05" });
  repo.recordMovementTolerance({
    symptom_event_id: knee.id,
    movement: "Back Squat",
    exercise_id: squat.id,
    observed_on: "2034-04-06",
    pain_free: false,
  });
  assert.equal(
    painBandForMovement({ id: squat.id, name: "Back Squat", muscle_group: "quads" }, "2034-04-07").band,
    "amber"
  );
  assert.equal(
    painBandForMovement({ id: bench.id, name: "Bench Press", muscle_group: "chest" }, "2034-04-07"),
    null,
    "one hurting movement never speaks for another"
  );
});

// The DOMS carve-out, through the DATABASE rather than the pure core. It used to
// select a `report_text` column off training_symptom_events — a column that does not
// exist (the athlete's words live in symptom_reports.text and are hydrated in) — so
// the query threw on every single call, the catch read `symmetric = false`, and the
// whole carve-out was dead code: a newly introduced movement plus ordinary bilateral
// soreness froze that lift at amber for three weeks.
test("DOMS reads the athlete's own words from where they actually live", () => {
  const squat = repo.findExercise("Back Squat");
  const session = repo.getOrCreateSession("2034-06-10");
  db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 135, 8)`).run(
    session.id,
    squat.id,
  );
  const sore = repo.reportTrainingSymptom({
    area_text: "both glutes",
    report_text: "both glutes are wrecked two days after that first squat session",
    onset_on: "2034-06-11",
  });
  repo.recordMovementTolerance({
    symptom_event_id: sore.id,
    movement: "Back Squat",
    exercise_id: squat.id,
    observed_on: "2034-06-11",
    pain_free: false,
  });

  const band = painBandForMovement({ id: squat.id, name: "Back Squat", muscle_group: "quads" }, "2034-06-12");
  assert.ok(band, "the exposure is relevant and stated, so a band is read");
  assert.equal(band.doms, true, "symmetric soreness a day after a first exposure is the DOMS shape");
  assert.equal(band.band, "green", "…and DOMS trains through");
});

test("bilateral JOINT pain is never DOMS, and one watch's symmetry never speaks for another", () => {
  const squat = repo.findExercise("Back Squat");
  const session = repo.getOrCreateSession("2034-07-10");
  db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 135, 8)`).run(
    session.id,
    squat.id,
  );
  // "Both knees" is bilateral and follows a novel dose — and is a reason to be MORE
  // careful, not less.
  const knees = repo.reportTrainingSymptom({
    area_text: "both knees",
    report_text: "both knees ache after the squats",
    onset_on: "2034-07-11",
  });
  repo.recordMovementTolerance({
    symptom_event_id: knees.id,
    movement: "Back Squat",
    exercise_id: squat.id,
    observed_on: "2034-07-11",
    pain_free: false,
  });
  const jointBand = painBandForMovement({ id: squat.id, name: "Back Squat", muscle_group: "quads" }, "2034-07-12");
  assert.equal(jointBand.doms, false);
  assert.equal(jointBand.band, "amber");

  // An unrelated symmetric watch covering the same lift must not launder that one.
  repo.reportTrainingSymptom({
    area_text: "both glutes",
    report_text: "both glutes are just sore from the new squats",
    onset_on: "2034-07-11",
  });
  const stillAmber = painBandForMovement({ id: squat.id, name: "Back Squat", muscle_group: "quads" }, "2034-07-12");
  assert.equal(stillAmber.doms, false, "the shape belongs to the watch that reported the pain");
  assert.equal(stillAmber.band, "amber");
});

// recordMovementTolerance derives `relevant` from the AREA LABEL alone and asks
// nothing about scope, so a systemic watch whose label happens to name a place lands
// as a relevant exposure. The scope law has to be re-applied where the band is read,
// or "everything aches, mostly my shoulders" drives one lift's load.
test("a systemic watch cannot drive a movement band even when its label names a place", () => {
  const bench = repo.findExercise("Bench Press");
  const systemic = repo.reportTrainingSymptom({
    area_text: "shoulders",
    report_text: "everything aches today, mostly my shoulders",
    onset_on: "2034-08-01",
    scope: "systemic",
  });
  const observed = repo.recordMovementTolerance({
    symptom_event_id: systemic.id,
    movement: "Bench Press",
    exercise_id: bench.id,
    observed_on: "2034-08-02",
    pain_free: false,
  });
  assert.ok(observed, "the exposure is written — this is not about refusing to record it");
  const relevant = db
    .prepare(`SELECT relevant FROM movement_tolerance_observations WHERE symptom_event_id = ? LIMIT 1`)
    .get(systemic.id);
  assert.equal(relevant.relevant, 1, "and the label DID pass the relevance map, which is the trap");
  assert.equal(
    painBandForMovement({ id: bench.id, name: "Bench Press", muscle_group: "chest" }, "2034-08-03"),
    null,
    "a watch that names no place still may never load one lift",
  );
});

// Symmetry has to be SAID. Asserting it from a muscle NAME read "the left side of my
// chest is sharp when I press" — one-sided, sharp, right after a new movement — as
// bilateral soreness and trained straight through it.
test("a muscle name alone is not symmetry, and injury words are never DOMS", () => {
  const bench = repo.findExercise("Bench Press");
  const novel = (date) => {
    const session = repo.getOrCreateSession(date);
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 135, 8)`,
    ).run(session.id, bench.id);
  };
  const report = (label, text, on) => {
    const event = repo.reportTrainingSymptom({ area_text: label, report_text: text, onset_on: on });
    repo.recordMovementTolerance({
      symptom_event_id: event.id,
      movement: "Bench Press",
      exercise_id: bench.id,
      observed_on: on,
      pain_free: false,
    });
    return event;
  };

  novel("2034-09-10");
  report("chest", "the left side of my chest is sharp when I press", "2034-09-11");
  const oneSided = painBandForMovement({ id: bench.id, name: "Bench Press", muscle_group: "chest" }, "2034-09-12");
  assert.equal(oneSided.doms, false, "one side, and 'sharp' — this is the report to be careful with");
  assert.equal(oneSided.band, "amber");

  // The genuine article still trains through: bilateral, muscle-belly, day after a
  // movement that has just been introduced.
  resetTables("movement_tolerance_observations", "training_symptom_events", "symptom_reports", "logged_sets", "sessions");
  novel("2034-10-10");
  report("rear delts", "rear delts are sore on both sides after that new press", "2034-10-11");
  const doms = painBandForMovement({ id: bench.id, name: "Bench Press", muscle_group: "chest" }, "2034-10-12");
  assert.equal(doms.doms, true);
  assert.equal(doms.band, "green");
});
