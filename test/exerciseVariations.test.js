// exerciseVariations.test.js — node:test suite for src/repo/exercise-variations.ts
// Pure / offline — no DB, no agent, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as v from "../dist/repo/exercise-variations.js";

// ─── classifyPattern ──────────────────────────────────────────────────────────

test("classifyPattern: Romanian Deadlift → hinge", () => {
  assert.equal(v.classifyPattern("Romanian Deadlift"), "hinge");
});

test("classifyPattern: Conventional Deadlift → hinge", () => {
  assert.equal(v.classifyPattern("Conventional Deadlift"), "hinge");
});

test("classifyPattern: Seated DB Overhead Press → vertical-push", () => {
  assert.equal(v.classifyPattern("Seated DB Overhead Press"), "vertical-push");
});

test("classifyPattern: Barbell Overhead Press → vertical-push", () => {
  assert.equal(v.classifyPattern("Barbell Overhead Press"), "vertical-push");
});

test("classifyPattern: Lat Pulldown → vertical-pull", () => {
  assert.equal(v.classifyPattern("Lat Pulldown"), "vertical-pull");
});

test("classifyPattern: Pull-Up → vertical-pull", () => {
  assert.equal(v.classifyPattern("Pull-Up"), "vertical-pull");
});

test("classifyPattern: Chin-Up → vertical-pull", () => {
  assert.equal(v.classifyPattern("Chin-Up"), "vertical-pull");
});

test("classifyPattern: Bulgarian Split Squat → lunge", () => {
  assert.equal(v.classifyPattern("Bulgarian Split Squat"), "lunge");
});

test("classifyPattern: Step-Up → lunge", () => {
  assert.equal(v.classifyPattern("Step-Up"), "lunge");
});

test("classifyPattern: Ab Wheel Rollout → core", () => {
  assert.equal(v.classifyPattern("Ab Wheel Rollout"), "core");
});

test("classifyPattern: Plank → core", () => {
  assert.equal(v.classifyPattern("Plank"), "core");
});

test("classifyPattern: Back Squat → squat", () => {
  assert.equal(v.classifyPattern("Back Squat"), "squat");
});

test("classifyPattern: Goblet Squat → squat", () => {
  assert.equal(v.classifyPattern("Goblet Squat"), "squat");
});

test("classifyPattern: Barbell Bench Press → horizontal-push", () => {
  assert.equal(v.classifyPattern("Barbell Bench Press"), "horizontal-push");
});

test("classifyPattern: Push-Up → horizontal-push", () => {
  assert.equal(v.classifyPattern("Push-Up"), "horizontal-push");
});

test("classifyPattern: Bent Over Row → horizontal-pull", () => {
  assert.equal(v.classifyPattern("Bent Over Row"), "horizontal-pull");
});

test("classifyPattern: Hip Thrust → hip-extension", () => {
  assert.equal(v.classifyPattern("Hip Thrust"), "hip-extension");
});

test("classifyPattern: Glute Bridge → hip-extension", () => {
  assert.equal(v.classifyPattern("Glute Bridge"), "hip-extension");
});

test("classifyPattern: Standing Calf Raise → calf", () => {
  assert.equal(v.classifyPattern("Standing Calf Raise"), "calf");
});

test("classifyPattern: Farmer's Walk → carry", () => {
  assert.equal(v.classifyPattern("Farmer's Walk"), "carry");
});

test("classifyPattern: Hammer Curl → curl", () => {
  assert.equal(v.classifyPattern("Hammer Curl"), "curl");
});

test("classifyPattern: Skull Crusher → triceps", () => {
  assert.equal(v.classifyPattern("Skull Crusher"), "triceps");
});

test("classifyPattern: Dumbbell Lateral Raise → lateral-raise", () => {
  assert.equal(v.classifyPattern("Dumbbell Lateral Raise"), "lateral-raise");
});

test("classifyPattern: Unknown Exercise XYZ → null", () => {
  assert.equal(v.classifyPattern("Unknown Exercise XYZ"), null);
});

test("classifyPattern: uses muscle_group hint as fallback", () => {
  // A name that doesn't match any keyword but has a muscle group hint
  assert.equal(v.classifyPattern("Mystery Movement", "biceps"), "curl");
  assert.equal(v.classifyPattern("Mystery Movement", "chest"), "horizontal-push");
});

// ─── suggestVariations ────────────────────────────────────────────────────────

test("suggestVariations: Back Squat returns non-empty array", () => {
  const result = v.suggestVariations("Back Squat");
  assert.ok(Array.isArray(result), "should be an array");
  assert.ok(result.length > 0, "should return at least one variation");
});

test("suggestVariations: Back Squat does not include itself", () => {
  const result = v.suggestVariations("Back Squat");
  const names = result.map((r) => r.name.toLowerCase());
  assert.ok(!names.includes("back squat"), "should not include the input exercise");
});

test("suggestVariations: Back Squat results all have pattern squat", () => {
  const result = v.suggestVariations("Back Squat");
  for (const item of result) {
    assert.equal(item.pattern, "squat", `${item.name} should have pattern squat`);
  }
});

test("suggestVariations: all results have non-empty why string", () => {
  const result = v.suggestVariations("Back Squat");
  for (const item of result) {
    assert.ok(typeof item.why === "string" && item.why.length > 0, `${item.name} missing why`);
  }
});

test("suggestVariations: all results have valid equipment", () => {
  const validEquipment = new Set(["barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell"]);
  const result = v.suggestVariations("Back Squat");
  for (const item of result) {
    assert.ok(validEquipment.has(item.equipment), `${item.name} has unknown equipment: ${item.equipment}`);
  }
});

test("suggestVariations: respects limit option", () => {
  const result = v.suggestVariations("Back Squat", { limit: 3 });
  assert.ok(result.length <= 3, "should respect the limit");
});

test("suggestVariations: Unknown Exercise XYZ → []", () => {
  const result = v.suggestVariations("Unknown Exercise XYZ");
  assert.deepEqual(result, []);
});

test("suggestVariations: Conventional Deadlift does not include itself, all hinge", () => {
  const result = v.suggestVariations("Conventional Deadlift");
  assert.ok(result.length > 0);
  for (const item of result) {
    assert.equal(item.pattern, "hinge");
    assert.notEqual(item.name.toLowerCase(), "conventional deadlift");
  }
});

// ─── suggestAlternatives ──────────────────────────────────────────────────────

test("suggestAlternatives: bodyweightOnly — all results are bodyweight", () => {
  const result = v.suggestAlternatives("Barbell Bench Press", { bodyweightOnly: true });
  assert.ok(result.length > 0, "should return at least one bodyweight alternative");
  for (const item of result) {
    assert.equal(item.equipment, "bodyweight", `${item.name} should be bodyweight`);
  }
});

test("suggestAlternatives: avoidEquipment barbell — none have barbell", () => {
  const result = v.suggestAlternatives("Barbell Bent Over Row", { avoidEquipment: ["barbell"] });
  assert.ok(result.length > 0, "should return alternatives without barbell");
  for (const item of result) {
    assert.notEqual(item.equipment, "barbell", `${item.name} should not use barbell`);
  }
});

test("suggestAlternatives: avoidEquipment multiple — none use avoided equipment", () => {
  const result = v.suggestAlternatives("Barbell Bench Press", {
    avoidEquipment: ["barbell", "dumbbell"],
  });
  for (const item of result) {
    assert.ok(item.equipment !== "barbell" && item.equipment !== "dumbbell",
      `${item.name} uses avoided equipment: ${item.equipment}`);
  }
});

test("suggestAlternatives: Unknown Exercise XYZ → []", () => {
  const result = v.suggestAlternatives("Unknown Exercise XYZ");
  assert.deepEqual(result, []);
});

test("suggestAlternatives: injuryAreas lower-back — no barbell deadlifts or good mornings", () => {
  const result = v.suggestAlternatives("Conventional Deadlift", {
    injuryAreas: ["lower-back"],
  });
  // None of the results should be flagged for lower-back
  const risky = ["Conventional Deadlift", "Romanian Deadlift", "Sumo Deadlift",
    "Good Morning", "Barbell Bent Over Row", "T-Bar Row", "Pendlay Row",
    "Stiff-Leg Deadlift"];
  for (const item of result) {
    assert.ok(!risky.includes(item.name), `${item.name} is risky for lower-back`);
  }
});

test("suggestAlternatives: respects limit option", () => {
  const result = v.suggestAlternatives("Barbell Bench Press", { limit: 2 });
  assert.ok(result.length <= 2);
});

test("suggestAlternatives: results have non-empty why strings", () => {
  const result = v.suggestAlternatives("Barbell Bench Press", { bodyweightOnly: true });
  for (const item of result) {
    assert.ok(typeof item.why === "string" && item.why.length > 0, `missing why on ${item.name}`);
  }
});

test("suggestAlternatives: does not include the input exercise itself", () => {
  const result = v.suggestAlternatives("Barbell Bench Press");
  const names = result.map((r) => r.name.toLowerCase());
  assert.ok(!names.includes("barbell bench press"));
});

// ─── regression: a hamstring "curl" must not read as a biceps curl ────────────
test("classifyPattern: Leg Curl is posterior-chain (hinge), NOT a biceps curl", () => {
  assert.equal(v.classifyPattern("Leg Curl"), "hinge");
  assert.equal(v.classifyPattern("Lying Leg Curl"), "hinge");
  assert.equal(v.classifyPattern("Seated Leg Curl"), "hinge");
  // a real biceps curl still classifies as curl
  assert.equal(v.classifyPattern("Barbell Curl"), "curl");
  assert.equal(v.classifyPattern("Hammer Curl"), "curl");
});

test("suggestVariations(Leg Curl) returns hamstring movements, never bicep curls", () => {
  const names = v.suggestVariations("Leg Curl").map((r) => r.name.toLowerCase());
  assert.ok(names.length > 0, "has hamstring alternatives");
  assert.ok(!names.some((n) => /bicep|hammer|preacher/.test(n)), "no biceps curls leak in");
});
