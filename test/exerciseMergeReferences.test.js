// A merge DELETES a row, and every reference to that row has to have moved first.
//
// Two of the references are foreign keys declared ON DELETE SET NULL and the rest are
// names or keys derived from a name, so a reference left behind never crashes — it
// goes quiet. The one that bit: movement_tolerance_observations (the pain traffic
// light's and the swap pool's evidence) held `exercise:<the deleted id>`, every reader
// asked for the survivor, and a movement the athlete had reported PAINFUL came back
// clear. These tests seed one row in EVERY referencing table and assert the merge
// carries all of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";

const TODAY = localDateISO();

function insertExercise(name, group, mode = "reps") {
  return Number(
    db.prepare("INSERT INTO exercises (name, muscle_group, mode) VALUES (?, ?, ?)").run(name, group, mode)
      .lastInsertRowid
  );
}

function openWatch(area) {
  return Number(
    db
      .prepare(
        `INSERT INTO training_symptom_events (source_kind, area_text, status, onset_on, last_reported_on)
         VALUES ('chat', ?, 'active', ?, ?)`
      )
      .run(area, TODAY, TODAY).lastInsertRowid
  );
}

const insertObservation = (row) =>
  Number(
    db
      .prepare(
        `INSERT INTO movement_tolerance_observations
           (symptom_event_id, session_id, exercise_id, movement_key, movement_name,
            observed_on, outcome, evidence, relevant, evidence_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        row.event,
        row.session ?? null,
        row.exercise_id ?? null,
        row.key,
        row.name,
        row.on,
        row.outcome,
        row.evidence,
        row.relevant
      ).lastInsertRowid
  );

test("mergeExercises carries every reference to the survivor before deleting the merged row", () => {
  const survivor = repo.findOrCreateExercise("Machine Chest Press", "chest");
  const merged = insertExercise("Seated Chest Press", "chest");
  const session = repo.getOrCreateSession(TODAY);

  // (1) logged_sets — the FK the whole merge exists for.
  db.prepare(
    "INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 120, 8)"
  ).run(session.id, merged);
  // (2) plan_items.
  const planDay = db.prepare("INSERT INTO plan_days (day_number, name) VALUES (7, 'Push')").run();
  db.prepare("INSERT INTO plan_items (plan_day_id, position, exercise_id, sets) VALUES (?, 0, ?, 3)").run(
    planDay.lastInsertRowid,
    merged
  );
  // (3) strength_objectives — name + normalized key, resolved at read time.
  db.prepare(
    `INSERT INTO strength_objectives (exercise, exercise_key, target_kind, target_est_1rm, status)
     VALUES ('Seated Chest Press', 'seated chest press', 'explicit_est_1rm', 185, 'active')`
  ).run();
  // (4) session_skips — by name.
  db.prepare("INSERT INTO session_skips (session_id, exercise) VALUES (?, 'Seated Chest Press')").run(session.id);
  // (5) exercise_aliases whose canonical is the merged name.
  repo.setExerciseAlias("seated machine chest press", "Seated Chest Press", "agent");
  // (6) the strength re-test cadence, keyed by a name slug.
  db.prepare(
    `INSERT INTO attention_schedule (signal_key, domain, tier, next_due, reason, release_condition)
     VALUES ('training:strength:seated-chest-press', 'training', 'active', ?, 're-test', 'a fresh top set')`
  ).run(TODAY);
  // (7) the instructional guide: a linked one, and an unlinked SUGGESTION naming it.
  const guide = (guideId, exerciseId, candidate) =>
    db
      .prepare(
        `INSERT INTO exercise_guides
           (guide_id, name, name_key, exercise_id, match_candidate, match_confidence, image_count, source, license)
         VALUES (?, ?, ?, ?, ?, 'key', 0, 'test', 'test')`
      )
      .run(guideId, guideId, guideId.toLowerCase(), exerciseId, candidate);
  guide("Seated_Chest_Press", merged, null);
  guide("Chest_Press_Machine", null, "Seated Chest Press");
  // (8) the strength calibration anchor, keyed by the normalized exercise name.
  db.prepare(
    `INSERT INTO calibration_events (kind, date, target_key, result_json, source, ref_id)
     VALUES ('strength_topset', ?, 'seated chest press', '{"est_1rm":185}', 'detected', 42)`
  ).run(TODAY);
  // (9) the pain/tolerance memory, in all three of its spellings.
  const watch = openWatch("right shoulder");
  const byId = insertObservation({
    event: watch,
    session: session.id,
    exercise_id: merged,
    key: `exercise:${merged}`,
    name: "Seated Chest Press",
    on: TODAY,
    outcome: "pain_present",
    evidence: "stated",
    relevant: 1,
  });
  const bySlug = insertObservation({
    event: watch,
    session: null,
    exercise_id: null,
    key: "movement:seated-chest-press",
    name: "Seated Chest Press",
    on: TODAY,
    outcome: "pain_free",
    evidence: "stated",
    relevant: 1,
  });

  const result = repo.mergeExercises("Seated Chest Press", "Machine Chest Press");
  assert.equal(result.ok, true);
  assert.equal(result.moved_sets, 1);
  assert.equal(result.moved_plan_items, 1);
  assert.equal(result.moved_observations, 2, "both tolerance spellings follow the survivor");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM exercises WHERE id = ?").get(merged).n, 0, "the row is gone");

  const one = (sql, ...args) => db.prepare(sql).get(...args);
  assert.equal(one("SELECT exercise_id AS v FROM logged_sets WHERE session_id = ?", session.id).v, survivor.id);
  assert.equal(
    one("SELECT exercise_id AS v FROM plan_items WHERE plan_day_id = ?", planDay.lastInsertRowid).v,
    survivor.id
  );
  const objective = one("SELECT exercise, exercise_key FROM strength_objectives LIMIT 1");
  assert.equal(objective.exercise, "Machine Chest Press");
  assert.equal(objective.exercise_key, "machine chest press");
  assert.equal(one("SELECT exercise AS v FROM session_skips LIMIT 1").v, "Machine Chest Press");
  assert.equal(repo.getExerciseAlias("seated machine chest press").canonical, "Machine Chest Press");
  assert.equal(
    repo.getExerciseAlias("seated chest press").canonical,
    "Machine Chest Press",
    "the retired name keeps resolving"
  );
  assert.equal(
    one("SELECT signal_key AS v FROM attention_schedule LIMIT 1").v,
    "training:strength:machine-chest-press",
    "the re-test cadence follows the survivor"
  );
  assert.equal(
    one("SELECT exercise_id AS v FROM exercise_guides WHERE guide_id = 'Seated_Chest_Press'").v,
    survivor.id,
    "the survivor inherits the guide it did not have"
  );
  assert.equal(
    one("SELECT match_candidate AS v FROM exercise_guides WHERE guide_id = 'Chest_Press_Machine'").v,
    "Machine Chest Press",
    "a pending guide suggestion stays answerable"
  );
  assert.equal(
    one("SELECT target_key AS v FROM calibration_events WHERE kind = 'strength_topset'").v,
    "machine chest press",
    "the est-1RM anchor is still readable under the surviving lift"
  );

  const idRow = one("SELECT * FROM movement_tolerance_observations WHERE id = ?", byId);
  assert.equal(idRow.exercise_id, survivor.id);
  assert.equal(idRow.movement_key, `exercise:${survivor.id}`);
  assert.equal(idRow.movement_name, "Machine Chest Press");
  const slugRow = one("SELECT * FROM movement_tolerance_observations WHERE id = ?", bySlug);
  assert.equal(slugRow.movement_key, "movement:machine-chest-press", "the pre-resolution slug follows the name");
  assert.equal(slugRow.exercise_id, survivor.id);
  assert.equal(slugRow.movement_name, "Machine Chest Press");

  // Nothing is orphaned: no dangling FK, and no `exercise:<id>` key naming a row that
  // no longer exists.
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM movement_tolerance_observations
          WHERE (exercise_id IS NOT NULL AND exercise_id NOT IN (SELECT id FROM exercises))
             OR (movement_key LIKE 'exercise:%'
                 AND CAST(SUBSTR(movement_key, 10) AS INTEGER) NOT IN (SELECT id FROM exercises))`
      )
      .get().n,
    0,
    "no tolerance row points at a movement that no longer exists"
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM logged_sets WHERE exercise_id NOT IN (SELECT id FROM exercises)").get().n,
    0
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM plan_items WHERE exercise_id IS NOT NULL AND exercise_id NOT IN (SELECT id FROM exercises)"
      )
      .get().n,
    0
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM exercise_guides WHERE exercise_id IS NOT NULL AND exercise_id NOT IN (SELECT id FROM exercises)"
      )
      .get().n,
    0
  );
});

test("a colliding tolerance exposure folds into the survivor's row, keeping the stronger evidence", () => {
  const survivor = repo.findOrCreateExercise("Machine Chest Press", "chest");
  const merged = insertExercise("Seated Chest Press", "chest");
  const session = repo.getOrCreateSession(TODAY);
  const watch = openWatch("right shoulder");
  // Both unique exposure indexes key on (event, session, movement_key, day, outcome,
  // epoch) — so these two rows become one. The survivor's is the weaker read (we
  // INFERRED it from a logged set, and the relevance map had ruled it out); the merged
  // lift's is what the athlete actually SAID.
  const keep = insertObservation({
    event: watch,
    session: session.id,
    exercise_id: survivor.id,
    key: `exercise:${survivor.id}`,
    name: "Machine Chest Press",
    on: TODAY,
    outcome: "pain_present",
    evidence: "inferred",
    relevant: 0,
  });
  const lose = insertObservation({
    event: watch,
    session: session.id,
    exercise_id: merged,
    key: `exercise:${merged}`,
    name: "Seated Chest Press",
    on: TODAY,
    outcome: "pain_present",
    evidence: "stated",
    relevant: 1,
  });

  const result = repo.mergeExercises("Seated Chest Press", "Machine Chest Press");
  assert.equal(result.ok, true);
  assert.equal(result.folded_observations, 1);
  assert.equal(result.moved_observations, 0);

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM movement_tolerance_observations WHERE id = ?").get(lose).n,
    0,
    "the duplicate exposure is gone"
  );
  const kept = db.prepare("SELECT * FROM movement_tolerance_observations WHERE id = ?").get(keep);
  assert.equal(kept.evidence, "stated", "the athlete's own report outranks an inferred exposure");
  assert.equal(kept.relevant, 1, "and relevance is kept, never downgraded by the fold");
  assert.equal(kept.exercise_id, survivor.id);
  assert.equal(kept.movement_name, "Machine Chest Press");
});

test("the generic dedupe pass refuses a pair the catalog itself calls two movements", () => {
  // Same expanded key ("DB" spelled out), two different stored muscle groups. A merge
  // deletes a row and cannot be undone, so the pass reports it instead of folding it.
  insertExercise("DB Row", "chest");
  insertExercise("Dumbbell Row", "back");
  // Same expanded key, two different logging shapes.
  insertExercise("DB Plank", "core", "timed");
  insertExercise("Dumbbell Plank", "core", "reps");
  // …and a pair that agrees on everything, which still folds.
  insertExercise("DB Fly", "chest");
  insertExercise("Dumbbell Fly", "chest");

  const dry = repo.dedupeExercises();
  const skipped = (from) => dry.skipped.find((row) => row.from === from || row.into === from);
  assert.ok(skipped("DB Row"), "the muscle-group disagreement is reported, not folded");
  assert.match(skipped("DB Row").reason, /muscle group/i);
  assert.ok(skipped("DB Plank"), "the timed/reps disagreement is reported too");
  assert.match(skipped("DB Plank").reason, /timed/i);
  assert.ok(
    !dry.merges.some((row) => row.from === "DB Row" || row.from === "DB Plank"),
    "neither vetoed pair is planned"
  );
  assert.ok(
    dry.merges.some((row) => row.from === "DB Fly" || row.into === "DB Fly"),
    "a pair that agrees on everything still folds"
  );

  repo.dedupeExercises({ dryRun: false });
  const names = new Set(
    db
      .prepare("SELECT name FROM exercises")
      .all()
      .map((r) => r.name)
  );
  assert.ok(names.has("DB Row") && names.has("Dumbbell Row"), "both rows survive the apply");
  assert.ok(names.has("DB Plank") && names.has("Dumbbell Plank"));
});

test("a merge never leaves one movement twice on a plan day", () => {
  const survivor = repo.findOrCreateExercise("Machine Chest Press", "chest");
  const merged = insertExercise("Seated Chest Press", "chest");
  const day = Number(db.prepare("INSERT INTO plan_days (day_number, name) VALUES (8, 'Push')").run().lastInsertRowid);
  const otherDay = Number(
    db.prepare("INSERT INTO plan_days (day_number, name) VALUES (9, 'Upper')").run().lastInsertRowid
  );
  const addItem = db.prepare(
    "INSERT INTO plan_items (plan_day_id, position, exercise_id, sets, target_weight, note) VALUES (?, ?, ?, ?, ?, ?)"
  );
  // The day already prescribes the survivor, with no target weight of its own. There is
  // no unique index on (plan_day_id, exercise_id), so a blind re-point stacks them.
  const keep = Number(addItem.run(day, 0, survivor.id, 4, null, "as programmed").lastInsertRowid);
  const dupe = Number(addItem.run(day, 1, merged, 3, 145, "the merged spelling").lastInsertRowid);
  // A day that only ever prescribed the merged lift keeps its slot — nothing to fold.
  const lone = Number(addItem.run(otherDay, 0, merged, 3, 135, null).lastInsertRowid);

  const result = repo.mergeExercises("Seated Chest Press", "Machine Chest Press");
  assert.equal(result.ok, true);
  assert.equal(result.dropped_plan_items, 1, "the duplicate slot is folded away");
  assert.equal(result.moved_plan_items, 1, "and only the genuinely orphaned item is re-pointed");

  const onDay = db.prepare("SELECT * FROM plan_items WHERE plan_day_id = ? ORDER BY position").all(day);
  assert.equal(onDay.length, 1, "one movement, one slot");
  assert.equal(onDay[0].id, keep, "the survivor's own item is the one kept");
  assert.equal(onDay[0].sets, 4, "its own prescription is never overwritten");
  assert.equal(onDay[0].note, "as programmed");
  assert.equal(onDay[0].target_weight, 145, "but a weight it was MISSING is carried over");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM plan_items WHERE id = ?").get(dupe).n, 0);

  const elsewhere = db.prepare("SELECT * FROM plan_items WHERE id = ?").get(lone);
  assert.equal(elsewhere.exercise_id, survivor.id, "a day with no survivor item just follows the merge");
  assert.equal(elsewhere.target_weight, 135, "and keeps its own prescription");
});

test("a survivor's stated prescription outranks the merged item's", () => {
  const survivor = repo.findOrCreateExercise("Machine Chest Press", "chest");
  const merged = insertExercise("Seated Chest Press", "chest");
  const day = Number(db.prepare("INSERT INTO plan_days (day_number, name) VALUES (10, 'Push')").run().lastInsertRowid);
  const addItem = db.prepare(
    "INSERT INTO plan_items (plan_day_id, position, exercise_id, sets, target_weight) VALUES (?, ?, ?, ?, ?)"
  );
  const keep = Number(addItem.run(day, 0, survivor.id, 3, 160).lastInsertRowid);
  addItem.run(day, 1, merged, 3, 145);

  assert.equal(repo.mergeExercises("Seated Chest Press", "Machine Chest Press").dropped_plan_items, 1);
  const kept = db.prepare("SELECT * FROM plan_items WHERE plan_day_id = ?").all(day);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, keep);
  assert.equal(kept[0].target_weight, 160, "a prescription that is already there is never replaced");
});
