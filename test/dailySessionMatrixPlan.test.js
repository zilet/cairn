// The daily-session ownership matrix, part 1 of 2: a date with nothing, a session row
// logged outside any composition, and the plan-sourced adaptive compositions (plain and
// train-by-choice). The contract, the axes and what is pruned are in
// test/_dailySessionMatrix.mjs; part 2 is dailySessionMatrixChosen.test.js.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { OWNER_STATES, cellCount, requestCells, runOwnerState, seedPlan } from "./_dailySessionMatrix.mjs";

const STATES = OWNER_STATES.filter(
  (state) => !state.composition || state.source === "adaptive_plan" || state.source === "adaptive_choice"
);

beforeEach(() => seedPlan());

test("the whole matrix is generated: 3840 cells over 28 owner states (part 1 holds 12 of them)", () => {
  assert.equal(OWNER_STATES.length, 28);
  assert.equal(cellCount(), 3840);
  assert.equal(STATES.length, 12);
  assert.equal(cellCount(STATES), 4 * 96 + 8 * 144);
});

for (const state of STATES) {
  test(`ownership matrix: ${state.name}`, async () => {
    const tally = await runOwnerState(state);
    const total = Object.values(tally).reduce((sum, n) => sum + n, 0);
    assert.equal(total, [...requestCells(state)].length, "every generated cell ran");
  });
}
