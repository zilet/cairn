// ONE rule for a heavy lower day near a key run (src/repo/key-run-proximity.ts): the
// week-layout read (`lower_lift_placement`, week-layout.ts) and the live placement
// (`keyRunAwarePlacement`, plan-selection.ts) can never disagree. Pinned across EVERY
// weekday arrangement of a 3-run week (quality, long, easy) with 3 or 4 lifting days:
//   - the read calls a day `preferred` exactly when the placement would leave it alone;
//   - a day the placement trades is never read preferred, and its new weekday always is;
//   - a non-preferred day the placement leaves in place has no clear lifting weekday to go to;
//   - the states: eve (the day before), on (the run's own day), after (the day after).
// Pure functions only; deterministic and offline.
import assert from "node:assert/strict";
import { test } from "node:test";
import { lowerLiftPlacement } from "../dist/domain/training/week-layout.js";
import { keyRunRelation, nearKeyRun } from "../dist/repo/key-run-proximity.js";
import { keyRunAwarePlacement } from "../dist/repo/plan-selection.js";

const REF = "2026-04-20";
const DOWS = [0, 1, 2, 3, 4, 5, 6];
const ring = (dow) => (dow === 0 ? 7 : dow); // JS weekday → Mon=1 … Sun=7

function subsets(list, k) {
  if (k === 0) return [[]];
  if (list.length < k) return [];
  const [head, ...rest] = list;
  return [...subsets(rest, k - 1).map((s) => [head, ...s]), ...subsets(rest, k)];
}

function* runWeeks() {
  for (const quality of DOWS)
    for (const long of DOWS)
      for (const easy of DOWS) {
        if (new Set([quality, long, easy]).size < 3) continue;
        yield { quality, long, easy };
      }
}

const isLower = (day) => day.lower === true;
const dealt = (lifts, lowers) =>
  new Map(lifts.map((dow, i) => [dow, { day_number: i + 1, lower: lowers.includes(dow) }]));

function stateFor(relation) {
  return relation === "eve" ? "eve_of_key_run" : relation === "on" ? "on_key_run" : relation === "after" ? "after_key_run" : "neutral";
}

test("the shared rule: eve, on and after are exactly the placement's 'near a key run'", () => {
  // Thursday quality (4), Sunday long (0).
  assert.equal(keyRunRelation(3, [4, 0]), "eve");
  assert.equal(keyRunRelation(4, [4, 0]), "on");
  assert.equal(keyRunRelation(5, [4, 0]), "after");
  assert.equal(keyRunRelation(6, [4, 0]), "eve", "Saturday is the long run's eve");
  assert.equal(keyRunRelation(1, [4, 0]), "after", "Monday follows Sunday's long run: the week wraps");
  assert.equal(keyRunRelation(2, [4, 0]), null);
  for (const dow of DOWS) assert.equal(nearKeyRun(dow, [4, 0]), keyRunRelation(dow, [4, 0]) != null);
});

for (const liftCount of [3, 4]) {
  test(`one heavy lower day, 3 runs and ${liftCount} lifts: the read and the placement agree in every arrangement`, () => {
    let checked = 0;
    let traded = 0;
    for (const { quality, long } of runWeeks()) {
      const keyRuns = [quality, long];
      for (const lifts of subsets(DOWS, liftCount)) {
        for (const lower of lifts) {
          const read = lowerLiftPlacement([ring(lower)], ring(long), ring(quality), REF);
          const near = nearKeyRun(lower, keyRuns);
          assert.equal(read.preferred, !near, JSON.stringify({ quality, long, lifts, lower, read }));
          assert.equal(read.preferred, read.state === "neutral");
          assert.equal(read.state, stateFor(keyRunRelation(lower, keyRuns)));
          const { swaps } = keyRunAwarePlacement(dealt(lifts, [lower]), { keyRunDows: keyRuns, open: lifts, isLower });
          if (read.preferred) assert.equal(swaps.length, 0, "a preferred day is never traded");
          if (swaps.length) {
            traded += 1;
            assert.equal(swaps.length, 1);
            assert.equal(read.preferred, false, "a traded day was never read preferred");
            const moved = lowerLiftPlacement([ring(swaps[0].to_dow)], ring(long), ring(quality), REF);
            assert.equal(moved.preferred, true, "the weekday it trades onto reads preferred");
          } else if (!read.preferred) {
            // Left in place only when no lifting weekday sits clear of every key run.
            assert.ok(
              lifts.filter((d) => d !== lower).every((d) => nearKeyRun(d, keyRuns)),
              JSON.stringify({ quality, long, lifts, lower })
            );
          }
          checked += 1;
        }
      }
    }
    assert.ok(checked > 1000 && traded > 0, `${checked} arrangements, ${traded} traded`);
  });
}

test("two heavy lower days in a 4-lift week: a preferred read is never traded, a trade is never preferred", () => {
  for (const { quality, long } of runWeeks()) {
    const keyRuns = [quality, long];
    for (const lifts of subsets(DOWS, 4)) {
      for (const lowers of subsets(lifts, 2)) {
        const read = lowerLiftPlacement(lowers.map(ring), ring(long), ring(quality), REF);
        const { swaps } = keyRunAwarePlacement(dealt(lifts, lowers), { keyRunDows: keyRuns, open: lifts, isLower });
        assert.equal(read.preferred, lowers.every((d) => !nearKeyRun(d, keyRuns)));
        if (read.preferred) assert.equal(swaps.length, 0, JSON.stringify({ quality, long, lifts, lowers }));
        if (swaps.length) assert.equal(read.preferred, false);
      }
    }
  }
});
