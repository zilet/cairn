// The alias self-rotation left plan slots claiming "Rotated in for <their own lift>"
// with a fresh prescribed_at (so the slot read as untested). The one-time repair
// (src/repo/self-rotation-repair.ts) clears that false note and, where the decision's
// rollback record shows the apply that wrote it, puts the pre-rotation stamp back. A
// genuine rotation is never touched, and a second run changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import {
  SELF_ROTATION_REPAIR_KEY,
  repairSelfRotationNotes,
  repairSelfRotationNotesOnce,
  rotatedInFor,
  rotationSentence,
} from "../dist/repo/self-rotation-repair.js";
import { getAppState } from "../dist/repo/app-state.js";

const STORED = "Dumbbell Biceps Curl";
const BUG_NOTE = "Rotated in for Dumbbell Biceps Curl — picking up from your last working 50 lb.";
const GENUINE_NOTE = "Rotated in for Barbell Bench Press — picking up from your last working 60 lb.";

function slot(dayNumber, exercise) {
  return db
    .prepare(
      `SELECT pi.note AS note, pi.prescribed_at AS prescribed_at FROM plan_items pi
         JOIN plan_days pd ON pd.id = pi.plan_day_id JOIN exercises e ON e.id = pi.exercise_id
        WHERE pd.day_number = ? AND e.name = ?`
    )
    .get(dayNumber, exercise);
}

function setSlot(dayNumber, exercise, note, stamp) {
  db.prepare(
    `UPDATE plan_items SET note = ?, prescribed_at = ?
      WHERE plan_day_id = (SELECT id FROM plan_days WHERE day_number = ?)
        AND exercise_id = (SELECT id FROM exercises WHERE name = ?)`
  ).run(note, stamp, dayNumber, exercise);
}

// The decision ledger's record of the buggy apply: the slot's note and stamp before and
// after (autonomy-service.ts trainingRollbackPayload, version 2).
function recordApply({
  beforeNote,
  afterNote,
  beforeStamp,
  afterStamp,
  exercise = STORED,
  day = 3,
  beforeWeight = 50,
  afterWeight = 50,
}) {
  const decision = Number(
    db
      .prepare(
        `INSERT INTO brain_decisions (kind, domain, summary, status, autonomy_tier, risk_class, reversible, applied_at)
         VALUES ('training_plan_change', 'training', 'progression rotation', 'applied', 'quiet_apply', 'low', 1, datetime('now'))`
      )
      .run().lastInsertRowid
  );
  const key = `${day}|${exercise.toLowerCase()}`;
  const item = (note, weight) => ({ exercise, sets: 3, rep_low: 8, rep_high: 12, target_weight: weight, note });
  const payload = {
    version: 2,
    before: [{ day_number: day, name: "Arms", focus: null, day_type: "training", items: [item(beforeNote, beforeWeight)] }],
    after: [{ day_number: day, name: "Arms", focus: null, day_type: "training", items: [item(afterNote, afterWeight)] }],
    before_stamps: { [key]: beforeStamp },
    after_stamps: { [key]: afterStamp },
  };
  db.prepare(`INSERT INTO brain_rollbacks (decision_id, kind, payload_json) VALUES (?, 'training_plan', ?)`).run(
    decision,
    JSON.stringify(payload)
  );
  return decision;
}

function seedPlan() {
  repo.upsertExercise({ name: STORED, muscle_group: "biceps", mode: "reps" });
  repo.upsertExercise({ name: "Dumbbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.savePlanDay(3, "Arms", "Arms", [
    { exercise: STORED, sets: 3, rep_low: 8, rep_high: 12, target_weight: 50 },
    { exercise: "Dumbbell Bench Press", sets: 3, rep_low: 8, rep_high: 12, target_weight: 60 },
  ]);
  setSlot(3, STORED, BUG_NOTE, "2026-11-20");
  setSlot(3, "Dumbbell Bench Press", GENUINE_NOTE, "2026-11-18");
}

test("the note parser reads the lift a rotation note names, and nothing else", () => {
  assert.equal(rotatedInFor(BUG_NOTE), STORED);
  assert.equal(rotatedInFor("Rotated in for Dumbbell Biceps Curl."), STORED);
  assert.equal(rotatedInFor("Rotated in for Hack Squat — start light, log your actual working value."), "Hack Squat");
  assert.equal(rotatedInFor("Slow lowering"), null);
  assert.equal(rotatedInFor(null), null);
});

test("a self-rotation slot gets its note and its pre-rotation stamp back; a genuine rotation survives", () => {
  seedPlan();
  recordApply({ beforeNote: "Slow lowering", afterNote: BUG_NOTE, beforeStamp: "2026-01-05", afterStamp: "2026-11-20" });

  const { repaired } = repairSelfRotationNotes();
  assert.equal(repaired.length, 1, JSON.stringify(repaired));
  assert.deepEqual({ ...slot(3, STORED) }, { note: "Slow lowering", prescribed_at: "2026-01-05" });
  assert.deepEqual(
    { ...slot(3, "Dumbbell Bench Press") },
    { note: GENUINE_NOTE, prescribed_at: "2026-11-18" },
    "a rotation in for a DIFFERENT lift is never touched"
  );
  // Idempotent: the repaired note no longer matches.
  assert.equal(repairSelfRotationNotes().repaired.length, 0);
});

test("with no decision record, only the false note is cleared and the stamp is left alone", () => {
  seedPlan();
  const { repaired } = repairSelfRotationNotes();
  assert.equal(repaired.length, 1);
  assert.deepEqual({ ...slot(3, STORED) }, { note: null, prescribed_at: "2026-11-20" });
});

test("a slot re-stamped since the rotation keeps its newer stamp", () => {
  seedPlan();
  // The rotation stamped 2026-11-20, but a later write re-stamped the slot 2026-11-22.
  recordApply({ beforeNote: "Slow lowering", afterNote: BUG_NOTE, beforeStamp: "2026-01-05", afterStamp: "2026-11-20" });
  setSlot(3, STORED, BUG_NOTE, "2026-11-22");
  repairSelfRotationNotes();
  assert.deepEqual({ ...slot(3, STORED) }, { note: "Slow lowering", prescribed_at: "2026-11-22" });
});

test("a rotation note naming the lift under another spelling is the same bug", () => {
  seedPlan();
  db.prepare(`INSERT INTO exercise_aliases (alias, canonical, source) VALUES ('db bicep curl', ?, 'auto')`).run(STORED);
  setSlot(3, STORED, "Rotated in for DB Bicep Curl — starting at 50 lb, where you left this one.", "2026-11-20");
  assert.equal(repairSelfRotationNotes().repaired.length, 1);
  assert.equal(slot(3, STORED).note, null);
});

test("the boot pass runs once per database", () => {
  seedPlan();
  const first = repairSelfRotationNotesOnce();
  assert.equal(first?.length, 1);
  assert.ok(getAppState(SELF_ROTATION_REPAIR_KEY), "the run is recorded");
  setSlot(3, STORED, BUG_NOTE, "2026-11-20");
  assert.equal(repairSelfRotationNotesOnce(), null, "a second boot does nothing");
  assert.equal(slot(3, STORED).note, BUG_NOTE);
});

test("a rotation that also moved the prescription keeps its stamp; only the note is fixed", () => {
  seedPlan();
  // The self-swap re-grounded the load 45 → 50: the slot really is prescribed anew.
  recordApply({
    beforeNote: "Slow lowering",
    afterNote: BUG_NOTE,
    beforeStamp: "2026-01-05",
    afterStamp: "2026-11-20",
    beforeWeight: 45,
  });
  repairSelfRotationNotes();
  assert.deepEqual({ ...slot(3, STORED) }, { note: "Slow lowering", prescribed_at: "2026-11-20" });
});

test("the same self-rotation note twice walks back to the state before the first", () => {
  seedPlan();
  recordApply({ beforeNote: "Slow lowering", afterNote: BUG_NOTE, beforeStamp: "2026-01-05", afterStamp: "2026-11-10" });
  recordApply({ beforeNote: BUG_NOTE, afterNote: BUG_NOTE, beforeStamp: "2026-11-10", afterStamp: "2026-11-20" });
  repairSelfRotationNotes();
  assert.deepEqual(
    { ...slot(3, STORED) },
    { note: "Slow lowering", prescribed_at: "2026-01-05" },
    "never a stamp a self-rotation wrote"
  );
});

test("differing self-rotation notes (50 lb, then 52.5 lb) walk back to the first one's before-state", () => {
  seedPlan();
  const first = "Rotated in for Dumbbell Biceps Curl — picking up from your last working 50 lb.";
  const second = "Rotated in for DB Bicep Curl — starting at 52.5 lb, where you left this one.";
  db.prepare(`INSERT INTO exercise_aliases (alias, canonical, source) VALUES ('db bicep curl', ?, 'auto')`).run(STORED);
  recordApply({ beforeNote: "Slow lowering", afterNote: first, beforeStamp: "2026-01-05", afterStamp: "2026-11-10" });
  recordApply({ beforeNote: first, afterNote: second, beforeStamp: "2026-11-10", afterStamp: "2026-11-20" });
  setSlot(3, STORED, second, "2026-11-20");
  repairSelfRotationNotes();
  assert.deepEqual({ ...slot(3, STORED) }, { note: "Slow lowering", prescribed_at: "2026-01-05" });
});

test("text appended after the false sentence stays; only the sentence goes", () => {
  seedPlan();
  const layered = `${BUG_NOTE}\nCoach note: Keep the elbows pinned.`;
  setSlot(3, STORED, layered, "2026-11-20");
  repairSelfRotationNotes();
  assert.deepEqual({ ...slot(3, STORED) }, { note: "Coach note: Keep the elbows pinned.", prescribed_at: "2026-11-20" });

  // With the ledger, the pre-rotation note comes back ahead of the kept layer.
  setSlot(3, STORED, layered, "2026-11-20");
  recordApply({ beforeNote: "Slow lowering", afterNote: BUG_NOTE, beforeStamp: "2026-01-05", afterStamp: "2026-11-20" });
  repairSelfRotationNotes();
  assert.deepEqual(
    { ...slot(3, STORED) },
    { note: "Slow lowering\nCoach note: Keep the elbows pinned.", prescribed_at: "2026-01-05" }
  );
});

test("the rotation sentence parser handles every phrasing movementStartNote wrote", () => {
  const cases = [
    ["Rotated in for Hack Squat.", "Hack Squat", ""],
    ["Rotated in for Hack Squat — start light, log your actual working value.", "Hack Squat", ""],
    ["Rotated in for Hack Squat — picking up from your last working 52.5 lb. Extra.", "Hack Squat", "Extra."],
    [
      "Rotated in for Hack Squat — nothing logged on this one yet; your Back Squat suggests starting around 135 lb. Log what you actually lift.",
      "Hack Squat",
      "",
    ],
    ["Rotated in for Pull-Up — starting at 30 lb assist, where you left this one.", "Pull-Up", ""],
  ];
  for (const [note, lift, rest] of cases) {
    const parsed = rotationSentence(note);
    assert.equal(parsed?.lift, lift, note);
    assert.equal(parsed?.rest, rest, note);
  }
});
