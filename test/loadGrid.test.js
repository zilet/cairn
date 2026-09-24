// The load grid (src/repo/load-grid.ts): every eased load — composition's reduced / easy /
// deload factor, the recovery overlay, the fuel recovery dose, the recovery-week proposal —
// lands on a number the lift can actually be set to. Pure; no DB.
import assert from "node:assert/strict";
import { test } from "node:test";
import { easedLoad, isStackLoaded, loadIncrement, minimumLoadStep } from "../dist/repo/load-grid.js";

test("the increment is the engine's plate floor for the group, never under the stack floor", () => {
  assert.equal(minimumLoadStep("quads"), 5);
  assert.equal(minimumLoadStep("biceps"), 2.5);
  assert.equal(loadIncrement("Back Squat", "quads"), 5);
  assert.equal(loadIncrement("Dumbbell Curl", "biceps"), 2.5);
  assert.equal(loadIncrement("Rope Pushdown", "triceps"), 5, "a pinned stack never jumps under 5 lb");
  assert.equal(loadIncrement("Barbell Curl", null), 2.5, "no stored group: the name's own group answers");
  assert.equal(isStackLoaded("Smith Machine Calf Raise"), false, "a smith machine is plate-loaded");
});

test("a positive load eases DOWN onto its grid", () => {
  for (const [load, name, group, eased] of [
    [185, "Back Squat", "quads", 165],
    [205, "Romanian Deadlift", "hamstrings", 180],
    [225, "Deadlift", "hamstrings", 200],
    [135, "Leg Extension", "quads", 120],
    [90, "Standing Calf Raise", "calves", 80],
    [25, "Dumbbell Curl", "biceps", 22.5],
  ]) {
    assert.equal(easedLoad(load, 0.9, name, group), eased, `${name} ${load}`);
  }
  assert.equal(easedLoad(225, 0.85, "Back Squat", "quads"), 190, "the recovery overlay's ×0.85");
  assert.equal(easedLoad(155, 0.8, "Bench Press", "chest"), 120, "an easy day's ×0.8");
});

test("a coarse step at a light load never cuts past the ease", () => {
  // 60 × 0.9 = 54: the floor (50) is a 17% cut, so the nearest step under 60 stands in.
  assert.equal(easedLoad(60, 0.9, "Bulgarian Split Squat", "quads"), 55);
  // 20 × 0.9 = 18 on a 5 lb stack: no step lands near it under 20 — the load holds.
  assert.equal(easedLoad(20, 0.9, "Cable Lateral Raise", "shoulders"), 20);
});

test("assistance is never multiplied toward harder; with an assist factor it grows onto the grid", () => {
  assert.equal(easedLoad(-30, 0.9, "Assisted Pull-Up", "back"), -30);
  assert.equal(easedLoad(-30, 0.85, "Assisted Pull-Up", "back", { assistFactor: 1.1 }), -35);
  assert.equal(easedLoad(-20, 0.85, "Assisted Pull-Up", "back", { assistFactor: 1.1 }), -20, "no step lands near 22");
});

test("bodyweight, zero and non-numbers pass through", () => {
  assert.equal(easedLoad(null, 0.9, "Pull-Up", "back"), null);
  assert.equal(easedLoad(undefined, 0.9, "Pull-Up", "back"), null);
  assert.equal(easedLoad(0, 0.9, "Pull-Up", "back"), 0);
  assert.ok(Number.isNaN(easedLoad("heavy", 0.9, "Pull-Up", "back")));
  assert.equal(easedLoad(185, 1, "Back Squat", "quads"), 185, "no ease, no change");
});
