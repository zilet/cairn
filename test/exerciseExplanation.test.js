import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import {
  exerciseExplanationCacheKey,
  getCachedExerciseExplanation,
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
