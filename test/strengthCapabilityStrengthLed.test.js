// Owner rule: for a strength-led athlete rising weekly running never explains a leg lift
// away (no run_build qualifier from the acute:chronic ratio or a distant race goal), and
// a press slot belongs to a press: a knee raise on a flat bench is core work, a close-grip
// bench is a flat press, and cuff rotation is never an overhead press.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityUnitOf } from "../dist/repo/strength-capability.js";

test("a press slot belongs to a press, whatever the stored group says", () => {
  assert.equal(capabilityUnitOf("Close-Grip Bench Press", "forearms")?.key, "horizontal-push:flat");
  assert.equal(capabilityUnitOf("Close-Grip Bench Press", "triceps")?.compound, true);
  assert.equal(capabilityUnitOf("Barbell Bench Press", "chest")?.key, "horizontal-push:flat");
  assert.equal(capabilityUnitOf("Flat Bench Knee Raise", "core")?.key, "core:flexion");
});

test("cuff rotation is its own unit, never an overhead press", () => {
  const unit = capabilityUnitOf("Rotator Cuff External Rotation", "shoulders");
  assert.equal(unit?.key, "rotator-cuff");
  assert.equal(unit?.compound, false);
  assert.equal(capabilityUnitOf("Barbell Overhead Press", "shoulders")?.key, "vertical-push");
});
