// Assisted-sign integrity: negative weight is assist, a typing slip of +40 on a
// lift that has been −25/−30/−40 must not become a loaded working weight, and
// migration 95 repairs the rows that already slipped.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { db, repo } from "./_seed.js";
import { recentWorkingWeight } from "../dist/repo/exercises.js";
import { MIGRATIONS, runMigrations } from "../dist/migrate.js";

function reset() {
  for (const t of ["logged_sets", "plan_items", "plan_days", "sessions", "exercises"]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist */
    }
  }
}

beforeEach(reset);

function makeExercise(name) {
  return repo.upsertExercise({ name, muscle_group: "back", mode: "reps" });
}

test("recentWorkingWeight ranks assisted sets by less assist and more reps", () => {
  makeExercise("Assisted Dip");
  const ex = repo.findExercise("Assisted Dip");
  const sess = repo.getOrCreateSession("2031-04-10", null);
  // Same day: −40×3 vs −35×12. The old `w*(1+reps/30)` on a negative w scored
  // the 3-rep (more assist, fewer reps) set higher. Harder is less assist AND
  // more reps, so the working weight is −35.
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, ?, 3, 2)`
  ).run(sess.id, ex.id, -40);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 2, ?, 12, 2)`
  ).run(sess.id, ex.id, -35);
  assert.equal(recentWorkingWeight("Assisted Dip"), -35);

  const harder = repo.getOrCreateSession("2031-04-17", null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, ?, 8, 2)`
  ).run(harder.id, ex.id, -25);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 2, ?, 12, 2)`
  ).run(harder.id, ex.id, -40);
  // Across days, harder = the larger signed value (−25 beats −35).
  assert.equal(recentWorkingWeight("Assisted Dip"), -25);
});

test("log +40 after an assisted history is stored as −40 with a normalized marker", () => {
  makeExercise("Assisted Dip");
  repo.logSetByName({ date: "2031-04-01", exercise: "Assisted Dip", weight: -25, reps: 8, rir: 2 });
  repo.logSetByName({ date: "2031-04-08", exercise: "Assisted Dip", weight: -30, reps: 8, rir: 2 });
  repo.logSetByName({ date: "2031-04-15", exercise: "Assisted Dip", weight: -40, reps: 8, rir: 2 });

  const logged = repo.logSetByName({ date: "2031-04-22", exercise: "Assisted Dip", weight: 40, reps: 8, rir: 2 });
  assert.equal(logged.weight, -40, "the slip is stored as assist, not a loaded 40");
  assert.equal(logged.normalized, "assist_sign");
  assert.equal(logged.est_1rm, null, "assisted sets carry no Epley");
  const row = db.prepare(`SELECT weight FROM logged_sets WHERE id = ?`).get(logged.id);
  assert.equal(row.weight, -40);
});

test("an explicit positive larger than the assist band is honored as typed", () => {
  makeExercise("Assisted Dip");
  repo.logSetByName({ date: "2031-04-01", exercise: "Assisted Dip", weight: -25, reps: 8, rir: 2 });

  const logged = repo.logSetByName({ date: "2031-04-08", exercise: "Assisted Dip", weight: 120, reps: 5, rir: 2 });
  assert.equal(logged.weight, 120, "120 is outside 1.5× of 25 lb assist — the athlete may have gone weighted");
  assert.equal(logged.normalized, undefined);
  assert.ok(logged.est_1rm > 0, "a real loaded set still gets an estimate");
});

test("after an honored positive the name arm no longer flips a later in-band load", () => {
  makeExercise("Assisted Dip");
  repo.logSetByName({ date: "2031-04-01", exercise: "Assisted Dip", weight: -25, reps: 8, rir: 2 });
  repo.logSetByName({ date: "2031-04-08", exercise: "Assisted Dip", weight: -30, reps: 8, rir: 2 });
  repo.logSetByName({ date: "2031-04-15", exercise: "Assisted Dip", weight: -40, reps: 8, rir: 2 });
  const weighted = repo.logSetByName({ date: "2031-04-22", exercise: "Assisted Dip", weight: 120, reps: 5, rir: 2 });
  assert.equal(weighted.weight, 120, "the first out-of-band positive is honored");

  const belt = repo.logSetByName({ date: "2031-04-29", exercise: "Assisted Dip", weight: 25, reps: 8, rir: 2 });
  assert.equal(belt.weight, 25, "a later 25 lb belt is weighted work, not flipped to −25 forever");
  assert.equal(belt.normalized, undefined);
});

test("Garmin import of a positive stack weight on an assist-history lift stays positive", () => {
  makeExercise("Assisted Dip");
  repo.logSetByName({ date: "2031-04-01", exercise: "Assisted Dip", weight: -25, reps: 8, rir: 2 });
  repo.logSetByName({ date: "2031-04-08", exercise: "Assisted Dip", weight: -30, reps: 8, rir: 2 });
  repo.logSetByName({ date: "2031-04-15", exercise: "Assisted Dip", weight: -40, reps: 8, rir: 2 });

  const session = repo.getOrCreateSession("2031-04-22", null);
  const result = repo.importGarminActivitySets({
    session_id: session.id,
    date: "2031-04-22",
    activity_key: "watch-assist-stack",
    sets: [{ exercise: "Assisted Dip", weight: 40, reps: 8 }],
  });
  assert.equal(result.imported, 1);
  assert.equal(result.already_imported, false);
  const row = db.prepare(`SELECT weight FROM logged_sets WHERE session_id = ?`).get(session.id);
  assert.equal(row.weight, 40, "Garmin reports the machine's absolute stack; the import path does not flip it");
});

test("migration 95 repairs synthetic assisted-sign slips and is idempotent", () => {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE exercises (id INTEGER PRIMARY KEY, name TEXT);`);
  d.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY, date TEXT);`);
  d.exec(`CREATE TABLE plan_days (id INTEGER PRIMARY KEY, day_number INTEGER, name TEXT);`);
  d.exec(`CREATE TABLE logged_sets (
    id INTEGER PRIMARY KEY,
    session_id INTEGER,
    exercise_id INTEGER,
    set_number INTEGER,
    weight REAL,
    reps INTEGER,
    est_1rm REAL
  );`);
  d.exec(`CREATE TABLE plan_items (
    id INTEGER PRIMARY KEY,
    plan_day_id INTEGER,
    position INTEGER,
    exercise_id INTEGER,
    sets INTEGER DEFAULT 3,
    target_weight REAL
  );`);
  d.exec(`INSERT INTO exercises (id, name) VALUES (1, 'Assisted Dip'), (2, 'Barbell Row');`);
  d.exec(`INSERT INTO sessions (id, date) VALUES
    (1, '2031-04-01'), (2, '2031-04-08'), (3, '2031-04-15'), (4, '2031-04-22'), (5, '2031-04-22');`);
  d.exec(`INSERT INTO logged_sets (id, session_id, exercise_id, set_number, weight, reps, est_1rm) VALUES
    (1, 1, 1, 1, -25, 8, NULL),
    (2, 2, 1, 1, -30, 8, NULL),
    (3, 3, 1, 1, -40, 8, NULL),
    (4, 4, 1, 1, 40, 8, 45.3),
    (5, 5, 1, 1, 120, 5, 140),
    (6, 4, 2, 1, 135, 8, 171);`);
  d.exec(`INSERT INTO plan_days (id, day_number, name) VALUES (1, 1, 'Pull');`);
  d.exec(`INSERT INTO plan_items (id, plan_day_id, position, exercise_id, target_weight) VALUES
    (1, 1, 0, 1, 40),
    (2, 1, 1, 2, 135);`);
  d.exec("PRAGMA user_version = 94;");

  const first = runMigrations(d);
  assert.equal(first.from, 94);
  assert.ok(first.applied >= 1);
  assert.equal(Number(d.prepare("PRAGMA user_version").get().user_version), MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0));

  const dipSets = d.prepare(`SELECT id, weight, est_1rm FROM logged_sets WHERE exercise_id = 1 ORDER BY id`).all();
  assert.equal(dipSets.find((r) => r.id === 4).weight, -40, "the +40 slip is repaired to assist");
  assert.equal(
    dipSets.find((r) => r.id === 4).est_1rm,
    45.3,
    "Epley is computed at read time; the migration does not write est_1rm"
  );
  assert.equal(dipSets.find((r) => r.id === 5).weight, 120, "a true loaded jump stays positive");
  assert.equal(d.prepare(`SELECT weight FROM logged_sets WHERE id = 6`).get().weight, 135, "unrelated lifts are untouched");
  assert.equal(d.prepare(`SELECT target_weight FROM plan_items WHERE id = 1`).get().target_weight, -40);
  assert.equal(d.prepare(`SELECT target_weight FROM plan_items WHERE id = 2`).get().target_weight, 135);

  const m95 = MIGRATIONS.find((m) => m.version === 95);
  assert.ok(m95, "version 95 is the assisted-sign repair");
  m95.up(d);
  m95.up(d);
  assert.equal(d.prepare(`SELECT weight FROM logged_sets WHERE id = 4`).get().weight, -40, "a second pass does not flip again");
  assert.equal(d.prepare(`SELECT target_weight FROM plan_items WHERE id = 1`).get().target_weight, -40);
  d.close();
});
