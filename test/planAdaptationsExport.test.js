// The full-data JSON export (exportAll / GET /api/export) keeps race-scoped plan
// adaptations. There is no JSON import endpoint — the restore artifact is the SQLite
// snapshot (snapshotDbTo / GET /api/export/db), which is the whole database.
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { db, repo } from "./_seed.js";

const BEFORE = {
  id: 9,
  plan_day_id: 2,
  position: 0,
  exercise_id: 4,
  exercise: "Back Squat",
  sets: 3,
  rep_low: 5,
  rep_high: 8,
  target_weight: 155,
};

test("full export includes every plan_adaptations row, hydrated, and the snapshot restores it", () => {
  const insert = db.prepare(
    `INSERT INTO plan_adaptations
       (day_number, day_name, exercise, kind, until_date, reason, before_json, after_json, status)
     VALUES (?, 'Lower', ?, ?, '2031-11-01', ?, ?, ?, ?)`
  );
  const active = Number(
    insert.run(2, "Back Squat", "removed", "Taper", JSON.stringify(BEFORE), null, "active").lastInsertRowid
  );
  const cancelled = Number(
    insert.run(2, "Deadlift", "removed", "Taper", null, null, "cancelled").lastInsertRowid
  );

  const exported = repo.exportAll().plan_adaptations;
  assert.deepEqual(
    exported.map((row) => row.id),
    [active, cancelled],
    "active and cancelled rows both travel — a backup is the whole history"
  );
  const squat = exported.find((row) => row.id === active);
  assert.equal(squat.exercise, "Back Squat");
  assert.equal(squat.kind, "removed");
  assert.equal(squat.until_date, "2031-11-01");
  assert.equal(squat.status, "active");
  assert.equal(squat.day_number, 2);
  assert.deepEqual(squat.before, BEFORE);
  assert.equal(squat.after, null);
  assert.equal(squat.before_json, undefined, "the raw column is hydrated, not copied twice");
  assert.equal(squat.after_json, undefined);
  assert.equal(exported.find((row) => row.id === cancelled).status, "cancelled");
  assert.deepEqual(repo.exportAll().plan_adaptations, exported);

  const snapshotPath = path.join(process.env.DATA_DIR, "plan-adaptations.db");
  repo.snapshotDbTo(snapshotPath);
  const restored = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const rows = restored
      .prepare(
        `SELECT id, exercise, kind, until_date, status, before_json FROM plan_adaptations ORDER BY id`
      )
      .all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, active);
    assert.equal(rows[0].exercise, "Back Squat");
    assert.equal(rows[0].kind, "removed");
    assert.equal(rows[0].until_date, "2031-11-01");
    assert.equal(rows[0].status, "active");
    assert.deepEqual(JSON.parse(rows[0].before_json), BEFORE);
    assert.equal(rows[1].id, cancelled);
    assert.equal(rows[1].status, "cancelled");
  } finally {
    restored.close();
  }
});
