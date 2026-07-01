// Elite-training WAVE C3 — periodization is LIVE, not cosmetic:
//   - ensureActiveBlock() auto-creates a sensible block when none is running, and is
//     idempotent (never resets one mid-way through)
//   - advanceBlockWeek() moves the phase across weeks (accumulation → intensification
//     → deload), and a PEAK block reaches the 'realization' phase in its last week —
//     which is what makes testWeekDue's realization branch reachable
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { ensureActiveBlock, advanceBlockWeek, createBlock, getActiveBlock } from "../dist/repo/program-blocks.js";
import { testWeekDue } from "../dist/repo/muscle-trajectory.js";

beforeEach(() => resetTables("program_blocks", "logged_sets", "sessions", "exercises", "plan_items", "plan_days"));

test("C3: ensureActiveBlock auto-creates one when none is running, then is idempotent", () => {
  assert.equal(getActiveBlock(), null, "no block to start");
  const created = ensureActiveBlock();
  assert.ok(created && created.status === "active", "a block is created");
  const again = ensureActiveBlock();
  assert.equal(again.id, created.id, "idempotent — the same active block is returned, never reset");
});

test("C3: advancing a block moves its phase across the weeks (accumulation → intensification → deload)", () => {
  const b = createBlock({ goal: "Base", focus: "strength", total_weeks: 5, week_index: 1 });
  assert.equal(b.phase, "accumulation");
  advanceBlockWeek(b.id); // wk2
  advanceBlockWeek(b.id); // wk3
  const wk4 = advanceBlockWeek(b.id); // wk4 — past halfway
  assert.equal(wk4.phase, "intensification", "the back half pushes intensity");
  const wk5 = advanceBlockWeek(b.id); // wk5 — last week
  assert.equal(wk5.phase, "deload", "a non-peak block's last week is a deload");
});

test("C3: a PEAK block reaches 'realization' in its last week, making a test week due", () => {
  // Some benchmark history so testWeekDue has key lifts to name.
  [42, 35, 28, 21, 14, 7, 0].forEach((d, i) =>
    repo.logSetByName({ exercise: "Back Squat", weight: 300 + i * 5, reps: 3, rir: 2, date: new Date(Date.now() - d * 864e5).toISOString().slice(0, 10) })
  );
  const peak = createBlock({ goal: "Peak for the meet", focus: "peak", total_weeks: 3, week_index: 2 });
  assert.notEqual(peak.phase, "realization", "not yet in the last week");
  const last = advanceBlockWeek(peak.id); // → week 3 (last)
  assert.equal(last.phase, "realization", "a peak block realizes in its final week");
  assert.equal(last.status, "active", "still active while realizing");

  const tw = testWeekDue(undefined, { block: last });
  assert.equal(tw.due, true, "the realization phase makes a strength test week due");
  assert.match(tw.why.toLowerCase(), /realization/);
});
