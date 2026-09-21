import { test } from "node:test";
import assert from "node:assert/strict";
import { isItemSpecificChangeReason } from "../dist/domain/training/exercise-notes.js";

test("a week-layout essay is not an exercise cue", () => {
  assert.equal(
    isItemSpecificChangeReason(
      "Your weekly split is redrawn directly around the days you actually train: lifting Monday through Friday and reserving the weekend for endurance and recovery. Monday anchors Lower A."
    ),
    false
  );
});

test("the fuel-park sentence is a session fact, not a lift cue", () => {
  assert.equal(
    isItemSpecificChangeReason(
      "You already lifted this; the weight goes up because of that, and fueling can catch up around it.",
      "Updated 3 lifts from what you logged."
    ),
    false
  );
});

test("a cue unique to the movement is kept", () => {
  assert.equal(isItemSpecificChangeReason("Straps from set 2 if grip/elbow flags."), true);
  assert.equal(isItemSpecificChangeReason("Half the sets while sleep catches up."), true);
  assert.equal(isItemSpecificChangeReason("Rotated in for Leg Curl — start conservative."), true);
});

test("repeating the decision summary on a card is not specific", () => {
  const summary = "Volume comes down while sleep recovers.";
  assert.equal(isItemSpecificChangeReason(summary, summary), false);
  assert.equal(isItemSpecificChangeReason(null, summary), false);
});
