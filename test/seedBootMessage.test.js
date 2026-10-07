// The boot line after a first-run seed names what was actually written: a blank
// profile seeds only the exercise catalog, never "the default plan".
import { test } from "node:test";
import assert from "node:assert/strict";
import { seedBootMessage } from "../dist/seed.js";

test("the seed boot line is accurate for the default, blank-profile and demo seeds", () => {
  assert.match(seedBootMessage({}), /seeded with the default plan/);
  const blank = seedBootMessage({ CAIRN_BLANK_PROFILE: "1" });
  assert.match(blank, /exercise catalog only/);
  assert.doesNotMatch(blank, /default plan/);
  assert.match(seedBootMessage({ CAIRN_BLANK_PROFILE: "true" }), /exercise catalog only/);
  assert.match(seedBootMessage({ CAIRN_SEED_DEMO: "1", CAIRN_BLANK_PROFILE: "1" }), /demo dataset/);
});
