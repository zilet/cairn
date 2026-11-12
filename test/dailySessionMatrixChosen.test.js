// The daily-session ownership matrix, part 2 of 2: the compositions the athlete chose —
// a manual plan day, an accepted agent suggestion, an empty "Open session" override and
// an itemful override — each unstarted, started, finished and finished-empty. The
// contract, the axes and what is pruned are in test/_dailySessionMatrix.mjs.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { OWNER_STATES, cellCount, requestCells, runOwnerState, seedPlan } from "./_dailySessionMatrix.mjs";

const STATES = OWNER_STATES.filter(
  (state) => state.composition && state.source !== "adaptive_plan" && state.source !== "adaptive_choice"
);

beforeEach(() => seedPlan());

test("part 2 holds the 16 chosen-composition states", () => {
  assert.equal(STATES.length, 16);
  assert.equal(cellCount(STATES), 16 * 180);
});

for (const state of STATES) {
  test(`ownership matrix: ${state.name}`, async () => {
    const tally = await runOwnerState(state);
    const total = Object.values(tally).reduce((sum, n) => sum + n, 0);
    assert.equal(total, [...requestCells(state)].length, "every generated cell ran");
  });
}
