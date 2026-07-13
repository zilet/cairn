import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, localDaysAgo } from "./_seed.js";

// getTrainingCalendar's heatmap `level` used to be tonnage-only: a cardio day (no
// logged_sets) or a zero-tonnage timed/bodyweight session both flattened to the
// lowest active shade (or, with no matching `activities` row, to 0) regardless of
// how long or how voluminous the day actually was. These cases prove every
// modality now registers honestly (max of independent tonnage/duration/sets
// signals) while pure lifting-day tonnage buckets stay exactly as before.

function cellFor(date, days = 7) {
  const { cells } = repo.getTrainingCalendar(days);
  const cell = cells.find((c) => c.date === date);
  assert.ok(cell, `expected a calendar cell for ${date}`);
  return cell;
}

function seedLoggedSets(date, exerciseName, count, { weight = null, reps = null, duration_sec = null } = {}) {
  const ex = repo.upsertExercise({ name: exerciseName, muscle_group: "legs" });
  const sess = repo.getOrCreateSession(date, null);
  for (let n = 1; n <= count; n++) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, duration_sec)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sess.id, ex.id, n, weight, reps, duration_sec);
  }
  return sess;
}

test("pure rest day still reads level 0", () => {
  const date = localDaysAgo(2);
  assert.equal(cellFor(date).level, 0);
});

test("a 90-minute cardio-only day is not floored to the lowest active shade", () => {
  const date = localDaysAgo(1);
  repo.addActivity({ date, type: "run", duration_min: 90 });

  const cell = cellFor(date);
  assert.equal(cell.lifted, false);
  assert.equal(cell.activity, true);
  assert.ok(cell.level >= 3, `expected level >= 3 for a 90-minute cardio day, got ${cell.level}`);
});

test("a 20-set zero-tonnage bodyweight day is not floored just because it has no load to sum", () => {
  const date = localDaysAgo(1);
  // reps>0 but weight NULL (bodyweight) never satisfies the tonnage query's
  // `weight > 0 AND reps > 0` filter, so this day contributes zero tonnage.
  seedLoggedSets(date, "Bodyweight Push-up", 20, { reps: 12 });

  const cell = cellFor(date);
  assert.equal(cell.lifted, false);
  assert.equal(cell.tonnage, 0);
  assert.ok(cell.level >= 2, `expected level >= 2 for a 20-set bodyweight day, got ${cell.level}`);
});

test("a short, low-volume zero-tonnage day still reads as active (level 1), not rest", () => {
  const date = localDaysAgo(1);
  seedLoggedSets(date, "Side Plank", 3, { duration_sec: 30 });

  const cell = cellFor(date);
  assert.equal(cell.lifted, false);
  assert.equal(cell.level, 1);
});

test("existing lifting-day tonnage buckets are unchanged when no duration is recorded", () => {
  const date = localDaysAgo(1);
  const ex = repo.upsertExercise({ name: "Heavy Squat", muscle_group: "legs" });
  const sess = repo.getOrCreateSession(date, null);
  // 4 sets x weight 300 x reps 10 = 12,000 lb tonnage -> 1 + min(3, floor(12000/5000)) = 3.
  // The session is never finished, so sessions.duration_min stays NULL and the
  // duration signal can't influence this day — isolates the tonnage bucket math.
  for (let n = 1; n <= 4; n++) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, ?, 300, 10)`
    ).run(sess.id, ex.id, n);
  }
  assert.equal(sess.duration_min, null);

  const cell = cellFor(date);
  assert.equal(cell.lifted, true);
  assert.equal(cell.tonnage, 12000);
  assert.equal(cell.level, 3, "tonnage bucket formula must be unchanged: 1 + min(3, floor(tonnage/5000))");
});

test("a light lifting day (low tonnage) is still floored at level 1, not boosted by unrelated signals", () => {
  const date = localDaysAgo(1);
  const ex = repo.upsertExercise({ name: "Light Curl", muscle_group: "arms" });
  const sess = repo.getOrCreateSession(date, null);
  // 2 sets x weight 20 x reps 10 = 400 lb tonnage -> 1 + min(3, floor(400/5000)) = 1.
  for (let n = 1; n <= 2; n++) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, ?, 20, 10)`
    ).run(sess.id, ex.id, n);
  }

  const cell = cellFor(date);
  assert.equal(cell.tonnage, 400);
  assert.equal(cell.level, 1);
});

test("a long day of any kind (session duration_min) raises the level via the duration signal", () => {
  const date = localDaysAgo(1);
  const ex = repo.upsertExercise({ name: "Moderate Bench", muscle_group: "chest" });
  const sess = repo.getOrCreateSession(date, null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 100, 10)`
  ).run(sess.id, ex.id);
  // Tonnage alone (1000 lb) would only earn level 1, but a 65-minute session
  // crosses the >=60min duration bucket (level 3) — the day's overall training
  // time is a real signal too, not just how much was lifted.
  db.prepare(`UPDATE sessions SET duration_min = 65 WHERE id = ?`).run(sess.id);

  const cell = cellFor(date);
  assert.equal(cell.tonnage, 1000);
  assert.equal(cell.level, 3);
});
