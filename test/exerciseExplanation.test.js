import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import {
  exerciseExplanationCacheKey,
  explainExercise,
  getCachedExerciseExplanation,
  getExerciseDetailWithExplanation,
  normalizeExerciseExplanation,
} from "../dist/coachOps.js";

beforeEach(() => {
  resetTables("ai_cache", "logged_sets", "sessions", "plan_items", "plan_days", "exercises");
});

test("normalizeExerciseExplanation accepts only the compact generated shape", () => {
  assert.deepEqual(
    normalizeExerciseExplanation({
      setup: "  Front foot planted.  Rear foot light. ",
      move: "Lower under control.",
      feel: "Front quad and glute.",
      avoid: "Do not bounce.",
    }),
    {
      setup: "Front foot planted. Rear foot light.",
      move: "Lower under control.",
      feel: "Front quad and glute.",
      avoid: "Do not bounce.",
    }
  );
  assert.equal(normalizeExerciseExplanation({ setup: "ready", move: "go" }), null);
});

test("getCachedExerciseExplanation hydrates a cached generated explanation", () => {
  const ex = repo.upsertExercise({ name: "Bulgarian Split Squat", muscle_group: "legs" });
  const detail = repo.getExerciseDetail(ex.name);
  const key = exerciseExplanationCacheKey(detail);
  const explanation = {
    setup: "Front foot far enough forward to stay balanced.",
    move: "Lower smoothly, then drive through the front midfoot.",
    feel: "Front-leg quad and glute.",
    avoid: "Do not push off the rear leg.",
  };
  repo.saveAiCache("exercise_explanation", key, {
    result: { ok: true, exercise: ex.name, explanation },
    chosen_agent: "stub",
    ref_table: "exercises",
    ref_id: ex.id,
    freshForMs: 60_000,
  });

  const hit = getCachedExerciseExplanation("bulgarian split squat");
  assert.equal(hit.ok, true);
  assert.equal(hit.cached, true);
  assert.equal(hit.agent, "stub");
  assert.deepEqual(hit.explanation, explanation);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM ai_cache WHERE kind='exercise_explanation'`).get().n,
    1
  );
});

const SPLIT_SQUAT_EXPLANATION = {
  setup: "Front foot far enough forward to stay balanced.",
  move: "Lower smoothly, then drive through the front midfoot.",
  feel: "Front-leg quad and glute.",
  avoid: "Do not push off the rear leg.",
};

function planSplitSquat(exerciseId, { sets = 3, repLow = 8, repHigh = 10, note = null } = {}) {
  const day = db.prepare(`INSERT INTO plan_days (day_number, name) VALUES (1, 'Lower')`).run();
  db.prepare(
    `INSERT INTO plan_items (plan_day_id, position, exercise_id, sets, rep_low, rep_high, note) VALUES (?, 0, ?, ?, ?, ?, ?)`
  ).run(day.lastInsertRowid, exerciseId, sets, repLow, repHigh, note);
}

test("a plan reshape (sets, rep range, day note) keeps the same explanation cache key and hit", () => {
  const ex = repo.upsertExercise({ name: "Bulgarian Split Squat", muscle_group: "legs" });
  planSplitSquat(ex.id);
  const before = repo.getExerciseDetail(ex.name);
  assert.equal(before.appears.length, 1);
  const key = exerciseExplanationCacheKey(before);
  repo.saveAiCache("exercise_explanation", key, {
    result: { ok: true, exercise: ex.name, explanation: SPLIT_SQUAT_EXPLANATION },
    chosen_agent: "stub",
    ref_table: "exercises",
    ref_id: ex.id,
    freshForMs: 60_000,
  });

  // Auto-progression / a reshape moves the prescription and the day note.
  db.prepare(`UPDATE plan_items SET sets = 4, rep_low = 6, rep_high = 8, note = 'top set first' WHERE exercise_id = ?`).run(ex.id);
  const after = repo.getExerciseDetail(ex.name);
  assert.equal(after.appears[0].sets, 4);
  assert.equal(exerciseExplanationCacheKey(after), key, "plan appearances stay out of the key");

  const hit = getCachedExerciseExplanation(ex.name);
  assert.equal(hit.cached, true);
  assert.equal(hit.stale, false);
  assert.deepEqual(hit.explanation, SPLIT_SQUAT_EXPLANATION);

  // What changes form cues still moves the key.
  repo.updateExercise(ex.id, { cues: "Stay tall." });
  assert.equal(repo.getExerciseDetail(ex.name).cues, "Stay tall.");
  assert.notEqual(exerciseExplanationCacheKey(repo.getExerciseDetail(ex.name)), key);
});

test("an explanation stored under an older key shape is served as stale via its exercise row", async () => {
  const ex = repo.upsertExercise({ name: "Bulgarian Split Squat", muscle_group: "legs" });
  repo.saveAiCache("exercise_explanation", "legacy-key-with-plan-appearances", {
    result: { ok: true, exercise: ex.name, explanation: SPLIT_SQUAT_EXPLANATION },
    chosen_agent: "stub",
    ref_table: "exercises",
    ref_id: ex.id,
    freshForMs: 60_000,
  });

  const hit = getCachedExerciseExplanation("bulgarian split squat");
  assert.equal(hit.cached, true);
  assert.equal(hit.stale, true, "a ref fallback is always stale so the sheet revalidates");
  assert.deepEqual(hit.explanation, SPLIT_SQUAT_EXPLANATION);

  // The detail payload carries it on first paint.
  const detail = getExerciseDetailWithExplanation("Bulgarian Split Squat");
  assert.equal(detail.found, true);
  assert.deepEqual(detail.explanation, SPLIT_SQUAT_EXPLANATION);
  assert.equal(detail.explanation_stale, true);

  // Another exercise's row never leaks across.
  const other = repo.upsertExercise({ name: "Goblet Squat", muscle_group: "legs" });
  assert.equal(getCachedExerciseExplanation(other.name).cached, false);
  const otherDetail = getExerciseDetailWithExplanation(other.name);
  assert.equal(otherDetail.explanation, null);
  assert.equal(otherDetail.explanation_stale, false);
});

test("explainExercise serves an exact fresh hit without running an agent", async () => {
  const ex = repo.upsertExercise({ name: "Bulgarian Split Squat", muscle_group: "legs" });
  const key = exerciseExplanationCacheKey(repo.getExerciseDetail(ex.name));
  repo.saveAiCache("exercise_explanation", key, {
    result: { ok: true, exercise: ex.name, explanation: SPLIT_SQUAT_EXPLANATION },
    chosen_agent: "stub",
    ref_table: "exercises",
    ref_id: ex.id,
    freshForMs: 60_000,
  });
  const fresh = await explainExercise("stub", ex.name);
  assert.equal(fresh.cached, true);
  assert.equal(fresh.stale, false);
  assert.deepEqual(fresh.explanation, SPLIT_SQUAT_EXPLANATION);
});
