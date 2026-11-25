// How one variant's change is read across a swap (src/repo/variant-transfer.ts): a ratio
// learned from this athlete's own bridge sessions, else the conservative table and only
// downward, else nothing. Pure: no rows needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_seed.js";
import { addDaysISO } from "../dist/repo/shared.js";
import {
  BRIDGE_AGREEMENT,
  BRIDGE_MAX_GAP_DAYS,
  BRIDGE_MAX_REP_GAP,
  BRIDGE_MIN_PAIRS,
  bridgePairs,
  learnedTransferRatio,
  tableTransferRatio,
  variantTransfer,
} from "../dist/repo/variant-transfer.js";

const BASE = "2026-03-01";
const day = (n) => addDaysISO(BASE, n);
// One exposure: top set `weight x reps`, Epley as the read computes it.
const ex = (n, weight, reps = 8) => ({
  date: day(n),
  top_weight: weight,
  top_reps: reps,
  est_1rm: weight * (1 + reps / 30),
});

test("the knobs are the documented ones", () => {
  assert.equal(BRIDGE_MAX_GAP_DAYS, 10);
  assert.equal(BRIDGE_MAX_REP_GAP, 3);
  assert.equal(BRIDGE_MIN_PAIRS, 2);
  assert.equal(BRIDGE_AGREEMENT, 0.05);
});

test("two bridge pairs that agree give a learned ratio, the median of the envelope ratios", () => {
  // Pairs a month apart, so each envelope is that one exposure.
  const sibling = [ex(0, 120), ex(40, 125)];
  const variant = [ex(3, 100), ex(42, 105)];
  const pairs = bridgePairs(variant, sibling);
  assert.equal(pairs.length, 2);
  const read = learnedTransferRatio(variant, sibling);
  assert.equal(read.pairs, 2);
  const expected = (100 / 120 + 105 / 125) / 2;
  assert.ok(Math.abs(read.ratio - expected) < 1e-9, `ratio ${read.ratio}`);
  assert.equal(
    variantTransfer(
      { name: "Wide Grip Lat Pulldown", exposures: variant },
      { name: "Lat Pulldown", exposures: sibling }
    ).kind,
    "learned"
  );
});

test("a learned ratio is rejected when the pairs disagree by more than five percent", () => {
  // 100/120 = 0.833 and 110/120 = 0.917: about ten percent apart.
  const sibling = [ex(0, 120), ex(40, 120)];
  const variant = [ex(2, 100), ex(41, 110)];
  const read = learnedTransferRatio(variant, sibling);
  assert.equal(read.ratio, null);
  assert.equal(read.reason, "pairs_disagree");
  // Neither name is in the table, so nothing carries across.
  const transfer = variantTransfer(
    { name: "Chest Supported Row", exposures: variant },
    { name: "Seated Cable Row", exposures: sibling }
  );
  assert.deepEqual(transfer, { kind: "none", reason: "pairs_disagree" });
  // Within five percent they stand.
  const close = learnedTransferRatio([ex(2, 100), ex(41, 104)], sibling);
  assert.equal(close.pairs, 2);
});

test("a bridge needs the two lifts close in time and in reps, and each exposure pairs once", () => {
  const sibling = [ex(0, 120, 8), ex(40, 120, 8)];
  assert.equal(bridgePairs([ex(11, 100, 8), ex(52, 100, 8)], sibling).length, 0, "eleven days apart is no bridge");
  assert.equal(bridgePairs([ex(2, 100, 12), ex(41, 100, 12)], sibling).length, 0, "four reps apart is no bridge");
  assert.equal(bridgePairs([ex(2, 100, 11), ex(41, 100, 5)], sibling).length, 2, "three reps apart still bridges");
  // Two variant exposures beside one sibling exposure: one pair, never two off one session.
  assert.equal(bridgePairs([ex(1, 100), ex(3, 100)], [ex(2, 120)]).length, 1);
  const one = learnedTransferRatio([ex(1, 100)], [ex(2, 120)]);
  assert.equal(one.ratio, null);
  assert.equal(one.reason, "no_bridge", "one pair is an accident, not a relationship");
});

test("the table ratio runs only downward, from the harder anchor to the lighter derivative", () => {
  assert.equal(tableTransferRatio("Front Squat", "Back Squat"), 0.75);
  assert.equal(tableTransferRatio("Back Squat", "Front Squat"), null, "a lighter lift never estimates a heavier one");
  assert.equal(tableTransferRatio("Romanian Deadlift", "Deadlift"), 0.6);
  assert.equal(tableTransferRatio("Deadlift", "Romanian Deadlift"), null);
  assert.equal(
    tableTransferRatio("Machine Chest Press", "Bench Press"),
    null,
    "a name the table cannot classify gets nothing"
  );
  // With no bridge, the table speaks downward and stays silent upward.
  assert.deepEqual(
    variantTransfer({ name: "Front Squat", exposures: [ex(50, 150)] }, { name: "Back Squat", exposures: [ex(0, 250)] }),
    {
      kind: "table",
      ratio: 0.75,
    }
  );
  assert.deepEqual(
    variantTransfer({ name: "Back Squat", exposures: [ex(50, 250)] }, { name: "Front Squat", exposures: [ex(0, 150)] }),
    {
      kind: "none",
      reason: "no_table_edge",
    }
  );
});

test("the athlete's own agreeing bridges outrank the table", () => {
  const sibling = [ex(0, 250, 5), ex(40, 250, 5)];
  const variant = [ex(2, 200, 5), ex(41, 200, 5)];
  const transfer = variantTransfer(
    { name: "Front Squat", exposures: variant },
    { name: "Back Squat", exposures: sibling }
  );
  assert.equal(transfer.kind, "learned");
  assert.ok(Math.abs(transfer.ratio - 0.8) < 1e-9);
});
