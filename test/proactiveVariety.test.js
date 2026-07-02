// Elite-training WAVE C5 — proactive variety toward heavier compounds (pure layer):
//   - previously-unclassifiable families (face pull / shrug / rear-delt fly / tibialis
//     / hip abduction) now classify (both the movement pattern AND the canon group),
//     so they have swap candidates
//   - the equipment/preference profile RANKS the variation pool by available equipment
//     and biases toward heavier COMPOUND loading, never re-suggesting a planned move
// Pure — no DB, no agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as v from "../dist/repo/exercise-variations.js";
import { classifyMuscleGroup } from "../dist/repo/exercise-canon.js";

test("C5: the previously-unmapped families classify to a movement pattern", () => {
  assert.equal(v.classifyPattern("Face Pull"), "rear-delt");
  assert.equal(v.classifyPattern("Cable Rear Delt Fly"), "rear-delt");
  assert.equal(v.classifyPattern("Barbell Shrug"), "shrug");
  assert.equal(v.classifyPattern("Tibialis Raise"), "tibialis");
  assert.equal(v.classifyPattern("Hip Abduction Machine"), "abduction");
});

test("C5: those families also classify to a canon muscle group (not null)", () => {
  assert.equal(classifyMuscleGroup("Face Pull"), "rear delts");
  assert.equal(classifyMuscleGroup("Barbell Shrug"), "shoulders");
  assert.equal(classifyMuscleGroup("Tibialis Raise"), "calves");
  assert.equal(classifyMuscleGroup("Hip Abduction Machine"), "glutes");
});

test("C5: the families now have same-pattern swap candidates (variety exists)", () => {
  for (const name of ["Face Pull", "Barbell Shrug", "Tibialis Raise", "Hip Abduction Machine"]) {
    const alts = v.suggestAlternatives(name, { limit: 3 });
    assert.ok(alts.length > 0, `${name} has variation candidates`);
    assert.ok(!alts.some((a) => a.name.toLowerCase() === name.toLowerCase()), "never suggests the input itself");
  }
});

test("C5: parseEquipment reads a free-text equipment profile", () => {
  assert.deepEqual(v.parseEquipment("dumbbells and a pull-up bar at home").sort(), ["bodyweight", "dumbbell"]);
  assert.ok(v.parseEquipment("full gym").length >= 6, "'full gym' means everything");
  assert.deepEqual(v.parseEquipment(""), [], "empty → no constraint");
});

test("C5: suggestAlternatives ranks the athlete's available equipment first", () => {
  const ranked = v.suggestAlternatives("Barbell Bench Press", {
    availableEquipment: ["dumbbell", "bodyweight"],
    limit: 4,
  });
  assert.ok(ranked.length > 0);
  assert.ok(
    ranked[0].equipment === "dumbbell" || ranked[0].equipment === "bodyweight",
    `the lead option uses available equipment (got ${ranked[0].equipment})`
  );
});

test("C5: preferCompound biases toward heavier compound loading (barbell/machine first)", () => {
  const ranked = v.suggestAlternatives("Goblet Squat", { preferCompound: true, limit: 6 });
  assert.ok(ranked.length > 0);
  // A barbell/machine option should outrank a bodyweight/kettlebell one.
  const order = ranked.map((r) => r.equipment);
  const firstHeavy = order.findIndex((e) => e === "barbell" || e === "machine");
  const firstLight = order.findIndex((e) => e === "bodyweight" || e === "kettlebell");
  if (firstHeavy !== -1 && firstLight !== -1) {
    assert.ok(firstHeavy < firstLight, "a heavier compound option ranks above a lighter one");
  }
});

test("C5: excludeNames never re-suggests a movement already in the plan", () => {
  const ranked = v.suggestAlternatives("Back Squat", { excludeNames: ["Front Squat", "Leg Press"], limit: 8 });
  const names = ranked.map((r) => r.name);
  assert.ok(!names.includes("Front Squat"), "excluded movement dropped");
  assert.ok(!names.includes("Leg Press"), "excluded movement dropped");
});

test("C5: indirectGroupsForExercise maps a press to triceps, a row to biceps", () => {
  assert.deepEqual(v.indirectGroupsForExercise("Barbell Bench Press").sort(), ["shoulders", "triceps"]);
  assert.ok(v.indirectGroupsForExercise("Barbell Bent Over Row").includes("biceps"));
  assert.deepEqual(v.indirectGroupsForExercise("Dumbbell Lateral Raise"), [], "an isolation move carries no indirect load");
});
