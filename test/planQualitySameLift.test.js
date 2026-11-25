// Plan quality's "same lift twice on one day" keys on resolver identity
// (exercise-canon.ts resolveExerciseName): two spellings of ONE stored lift are caught
// even when the conservative key cannot see it, and a name the resolver cannot place
// keeps exactly the behaviour it had. Deterministic and offline (see test/run.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./_seed.js";
import { validateTrainingPlan, plannedWeeklyGroupSets } from "../dist/repo/plan-quality.js";
import { normalizedExerciseKey, resolveExerciseName, setExerciseAlias } from "../dist/repo/exercise-canon.js";

const curl = (exercise) => ({ exercise, sets: 3, rep_low: 10, rep_high: 12 });
const duplicates = (report) => report.errors.filter((e) => e.code === "canonical_duplicate");

test("two spellings of one stored lift on one day are the same lift twice", () => {
  db.prepare(`INSERT INTO exercises (name, muscle_group, mode) VALUES (?, ?, ?)`).run("Dumbbell Biceps Curl", "biceps", "reps");
  setExerciseAlias("db bicep curl", "Dumbbell Biceps Curl", "manual");
  // The precondition that makes this a regression test: the conservative key alone
  // never saw these two as one lift.
  assert.notEqual(normalizedExerciseKey("DB Bicep Curl"), normalizedExerciseKey("Dumbbell Biceps Curl"));
  assert.equal(resolveExerciseName("DB Bicep Curl").key, resolveExerciseName("Dumbbell Biceps Curl").key);

  const report = validateTrainingPlan([{ day_number: 1, items: [curl("DB Bicep Curl"), curl("Dumbbell Biceps Curl")] }]);
  const found = duplicates(report);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].exercises, ["DB Bicep Curl", "Dumbbell Biceps Curl"]);
  assert.equal(found[0].day_number, 1);

  // On different days the same lift is not a duplicate.
  const split = validateTrainingPlan([
    { day_number: 1, items: [curl("DB Bicep Curl")] },
    { day_number: 2, items: [curl("Dumbbell Biceps Curl")] },
  ]);
  assert.deepEqual(duplicates(split), []);
  // The arithmetic-only read never runs the check, and its numbers are unchanged.
  assert.equal(
    plannedWeeklyGroupSets([{ day_number: 1, items: [curl("DB Bicep Curl"), curl("Dumbbell Biceps Curl")] }]).get("biceps"),
    6
  );
});

test("names the resolver cannot place keep their old behaviour", () => {
  // Same conservative key, nothing stored: still one lift twice.
  const plural = validateTrainingPlan([{ day_number: 1, items: [curl("Leg Extensions"), curl("Leg Extension")] }]);
  assert.equal(duplicates(plural).length, 1);
  // Different lifts, nothing stored: never joined.
  const distinct = validateTrainingPlan([{ day_number: 1, items: [curl("Cable Fly"), curl("Lat Pulldown")] }]);
  assert.deepEqual(duplicates(distinct), []);
});
