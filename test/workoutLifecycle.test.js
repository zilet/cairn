// Workout-lifecycle + exercise-CRUD data integrity (src/repo.ts). These back the
// PWA's finished-session "done" card, history editing, and the manage-exercise
// surface — all of which mutate logged data, so the guardrails matter:
//   - finishSession stamps finished_at; reopenSession clears it (the done/open flip)
//   - updateSet / updateSessionNotes edit in place, only the provided fields
//   - deleteExercise REFUSES when the exercise is still referenced (no orphaned FKs)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";

const DATE = "2030-01-15";

beforeEach(() => {
  // Wipe the tables these cases touch so they start from a known floor (the runner
  // shares one process/DB — every suite resets what it depends on).
  for (const t of ["logged_sets", "session_skips", "sessions", "plan_items"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
});

test("finishSession stamps finished_at; reopenSession clears it", () => {
  repo.logSetByName({ exercise: "Test Squat", weight: 100, reps: 5, date: DATE });
  let s = repo.getSessionByDate(DATE);
  assert.equal(s.finished_at, null, "a fresh session is open");
  repo.finishSession(s.id, "good work");
  s = repo.getSessionByDate(DATE);
  assert.ok(s.finished_at, "finished_at is set after finish");
  assert.equal(s.notes, "good work");
  repo.reopenSession(s.id);
  s = repo.getSessionByDate(DATE);
  assert.equal(s.finished_at, null, "reopen clears finished_at");
});

test("updateSet edits only the provided fields, returns the row with exercise name", () => {
  const set = repo.logSetByName({ exercise: "Test Bench", weight: 135, reps: 8, rir: 2, date: DATE });
  const updated = repo.updateSet(set.id, { weight: 140 });
  assert.equal(updated.weight, 140, "weight updated");
  assert.equal(updated.reps, 8, "reps left untouched");
  assert.equal(updated.rir, 2, "rir left untouched");
  assert.equal(updated.exercise, "Test Bench", "exercise name is joined in");
  assert.equal(repo.updateSet(999999, { weight: 1 }), null, "unknown set id → null");
});

test("updateSessionNotes trims + saves; unknown id → null", () => {
  repo.logSetByName({ exercise: "Test Row", weight: 100, reps: 10, date: DATE });
  const s = repo.getSessionByDate(DATE);
  const r = repo.updateSessionNotes(s.id, "  tight hamstrings  ");
  assert.equal(r.notes, "tight hamstrings", "notes trimmed");
  assert.equal(repo.updateSessionNotes(999999, "x"), null, "unknown session id → null");
});

test("deleteExercise refuses when the exercise still has logged sets", () => {
  repo.logSetByName({ exercise: "Logged Move", weight: 50, reps: 5, date: DATE });
  const r = repo.deleteExercise("Logged Move");
  assert.equal(r.ok, false);
  assert.ok(r.log_count >= 1, "reports the blocking logged-set count");
  assert.ok(repo.findExercise("Logged Move"), "still exists — not deleted");
});

test("deleteExercise refuses when the exercise is referenced in a plan", () => {
  const ex = repo.findOrCreateExercise("Planned Move");
  const pd = db.prepare("INSERT INTO plan_days (day_number, name) VALUES (?, ?)").run(91, "Test Day");
  db.prepare("INSERT INTO plan_items (plan_day_id, position, sets, rep_low, rep_high, exercise_id) VALUES (?,?,?,?,?,?)")
    .run(pd.lastInsertRowid, 0, 3, 5, 8, ex.id);
  const r = repo.deleteExercise("Planned Move");
  assert.equal(r.ok, false);
  assert.ok(r.plan_count >= 1, "reports the blocking plan-item count");
  // leave no stray plan rows behind for other suites
  db.prepare("DELETE FROM plan_items WHERE exercise_id = ?").run(ex.id);
  db.prepare("DELETE FROM plan_days WHERE day_number = 91").run();
  repo.deleteExercise("Planned Move");
});

test("deleteExercise removes a free exercise (no sets, no plan); unknown → not found", () => {
  repo.findOrCreateExercise("Free Move");
  const r = repo.deleteExercise("Free Move");
  assert.equal(r.ok, true);
  assert.equal(r.deleted, 1);
  assert.equal(repo.findExercise("Free Move"), undefined, "gone");
  const nf = repo.deleteExercise("No Such Move");
  assert.equal(nf.ok, false);
  assert.equal(nf.error, "not found");
});

test("upsertExercise honors an explicit mode change on an existing exercise (the re-add-as-timed path)", () => {
  repo.upsertExercise({ name: "Mode Switch", mode: "reps" });
  assert.equal(repo.findExercise("Mode Switch").mode, "reps");
  repo.upsertExercise({ name: "Mode Switch", mode: "timed" });
  assert.equal(repo.findExercise("Mode Switch").mode, "timed", "mode flips to timed");
  repo.deleteExercise("Mode Switch");
});
