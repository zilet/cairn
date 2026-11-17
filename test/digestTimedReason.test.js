// A digest move's reason never states a step the move on the card does not take.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_seed.js";
import { liftMoveOf } from "../dist/domain/today/today-digest.js";

const before = { sets: 3, target_seconds: 36 };

test("a timed move whose stated step disagrees with its numbers drops the reason", () => {
  const move = liftMoveOf({ exercise: "Dead Hang", target_seconds: 50, reason: "The hold's solid — add 4s." }, before);
  assert.equal(move.from_text, "36 s");
  assert.equal(move.to_text, "50 s");
  assert.equal(move.reason, null);
});

test("a timed move whose stated step matches keeps its reason", () => {
  const move = liftMoveOf({ exercise: "Dead Hang", target_seconds: 40, reason: "The hold's solid — add 4s." }, before);
  assert.equal(move.to_text, "40 s");
  assert.match(move.reason, /add 4s/);
});
