// Track B — the training-read memo layer (src/repo/training-cache.ts + the memoized
// getProgramState / getWeeklyStats / estimateExpenditure). These lock the invalidation
// contract: an in-process VERSION bump (every training write) invalidates exactly, a
// cheap SQL BACKSTOP catches an out-of-band write that skipped the counter, the memo is
// GOLDEN-equivalent to an uncached compute, and the test-isolate reset keeps cases from
// leaking a cached read into one another. Runs under the harness (test/run.mjs injects
// _isolate.mjs, whose beforeEach wipes the DB AND calls resetTrainingDataCache()).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedIntake, seedWeight } from "./_seed.js";
import {
  currentTrainingDataVersion,
  currentFoodDataVersion,
  bumpTrainingDataVersion,
  resetTrainingDataCache,
} from "../dist/repo/training-cache.js";

const REF = "2026-04-20";
const back = (n) => new Date(new Date(REF + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

beforeEach(() => {
  resetTables(
    "logged_sets",
    "sessions",
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "plan_items",
    "plan_days",
    "daily_metrics",
    "checkins",
    "bodyweight_log",
    "food_notes",
    "context_events",
    "program_blocks",
    "exercises"
  );
});

// A lift with a climbing est-1RM so getProgramState has something real to grade.
function seedProgressingBench() {
  const w = [135, 140, 145, 152, 160];
  [28, 21, 14, 7, 0].forEach((d, i) =>
    repo.logSetByName({ exercise: "Bench Press", weight: w[i], reps: 5, rir: 2, date: back(d) })
  );
}

test("a training write increments the training-data version", () => {
  assert.equal(currentTrainingDataVersion(), 0, "isolate reset leaves the counter at 0");
  const v0 = currentTrainingDataVersion();
  repo.logSetByName({ exercise: "Bench Press", weight: 135, reps: 5, date: back(0) });
  assert.ok(currentTrainingDataVersion() > v0, "a logged set bumped the version");
  const v1 = currentTrainingDataVersion();
  repo.logWeight(184, back(0));
  assert.ok(currentTrainingDataVersion() > v1, "a weigh-in bumped the version");
});

test("a food-note write increments the SEPARATE food-data version, not the training one", () => {
  const t0 = currentTrainingDataVersion();
  const f0 = currentFoodDataVersion();
  repo.addFoodNote("lunch", "", { kcal: 700 });
  assert.ok(currentFoodDataVersion() > f0, "a food note bumped the food version");
  assert.equal(currentTrainingDataVersion(), t0, "a food note does NOT bump the training version");
});

test("memo is GOLDEN-equivalent: a served value deep-equals a fresh uncached compute", () => {
  seedProgressingBench();
  seedWeight(back(7), 185);
  seedWeight(back(0), 183);
  for (let i = 0; i < 6; i++) seedIntake(i, 2400);

  for (const call of [
    () => repo.getProgramState(REF),
    () => repo.getWeeklyStats(REF),
    () => repo.estimateExpenditure(21),
  ]) {
    const miss = call(); // computes + caches
    const hit = call(); // served from the memo (a structuredClone)
    assert.deepEqual(hit, miss, "a memo hit equals the first computation");
    bumpTrainingDataVersion(); // no data change — only forces the next call to recompute
    const fresh = call(); // recomputes from identical data
    assert.deepEqual(fresh, miss, "the recompute equals the memoized value (golden)");
  }
});

test("VERSION path: an in-place set edit (invisible to the SQL backstop) invalidates the memo", () => {
  const logged = repo.logSetByName({ exercise: "Bench Press", weight: 135, reps: 5, rir: 2, date: back(0) });
  const before = repo.getProgramState(REF);
  const beforeBest = before.lifts.find((l) => l.exercise === "Bench Press")?.est_1rm ?? null;

  // updateSet changes weight IN PLACE: logged_sets COUNT and MAX(id) are unchanged, so
  // the backstop signature is identical — only the version bump can invalidate here.
  const backstopBefore = db.prepare("SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM logged_sets").get();
  repo.updateSet(logged.id, { weight: 315 });
  const backstopAfter = db.prepare("SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM logged_sets").get();
  assert.deepEqual(backstopAfter, backstopBefore, "an in-place edit leaves count/max unchanged");

  const after = repo.getProgramState(REF);
  const afterBest = after.lifts.find((l) => l.exercise === "Bench Press")?.est_1rm ?? null;
  assert.ok(afterBest !== null && afterBest !== beforeBest, "the heavier corrected set is reflected");
});

test("BACKSTOP path: a direct out-of-band insert (no version bump) still invalidates the memo", () => {
  repo.logSetByName({ exercise: "Bench Press", weight: 135, reps: 5, date: back(0) });
  const before = repo.getProgramState(REF);
  assert.ok(!before.lifts.some((l) => l.exercise === "Deadlift"), "no deadlift yet");

  // A brand-new exercise via the repo does NOT bump (creating a row ≠ a graded change);
  // capture the version, then insert the set DIRECTLY so nothing bumps the counter.
  const dl = repo.upsertExercise({ name: "Deadlift", muscle_group: "back" });
  const v = currentTrainingDataVersion();
  const sess = db.prepare("SELECT id FROM sessions WHERE date = ?").get(back(0));
  db.prepare(
    "INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, 315, 3, 2)"
  ).run(sess.id, dl.id);
  assert.equal(currentTrainingDataVersion(), v, "the direct insert did NOT bump the version");

  const after = repo.getProgramState(REF);
  assert.ok(
    after.lifts.some((l) => l.exercise === "Deadlift"),
    "the backstop caught the out-of-band set"
  );
});

test("getWeeklyStats reflects a fresh session through the memo (behavior preserved)", () => {
  const a = repo.getWeeklyStats(REF);
  assert.equal(a.week_sessions, 0, "empty floor");
  repo.logSetByName({ exercise: "Bench Press", weight: 135, reps: 5, date: back(1) });
  const b = repo.getWeeklyStats(REF);
  assert.equal(b.week_sessions, 1, "the memo re-served after the write");
});

test("a current-day food write invalidates the memo without entering completed-day expenditure", () => {
  seedWeight(back(6), 185);
  seedWeight(back(0), 184);
  const a = repo.estimateExpenditure(21);
  assert.equal(a.intake_avg_kcal, null, "no intake yet");
  repo.addFoodNote("lunch", "", { kcal: 2000 }); // bumps the food version
  const b = repo.estimateExpenditure(21);
  assert.equal(b.intake_avg_kcal, null, "unfinished current-day intake stays outside maintenance");
  assert.ok(currentFoodDataVersion() > 0, "the write still invalidated the memo for other food reads");
});

test("resetTrainingDataCache resets the counters (the isolate hook)", () => {
  repo.logSetByName({ exercise: "Bench Press", weight: 135, reps: 5, date: back(0) });
  repo.addFoodNote("lunch", "", { kcal: 500 });
  assert.ok(currentTrainingDataVersion() > 0 && currentFoodDataVersion() > 0, "counters advanced");
  resetTrainingDataCache();
  assert.equal(currentTrainingDataVersion(), 0, "training version reset to 0");
  assert.equal(currentFoodDataVersion(), 0, "food version reset to 0");
});

test("ISOLATION: the next case starts from a reset counter + a fresh-floor read (no leak)", () => {
  // The prior tests advanced the counter and cached program-state reads. The isolate's
  // beforeEach must have wiped the DB AND cleared the training memos before this case.
  assert.equal(currentTrainingDataVersion(), 0, "counter reset between cases");
  const st = repo.getProgramState(REF);
  assert.equal(st.lifts.length, 0, "no lift leaked from a prior case's cached program-state");
});
