// raceFrameGlance.test.js — Today's link into Horizon never glues the lifting block's
// week count to a race phase (src/repo/week-stage.ts weekFrameLine `glance`).
//
// Live (2026-10-20): "12 days to Cambridge Half · Taper, wk 1 of 6" — the taper is the
// race build's, the "wk 1 of 6" an accumulation block's. Now a race-named week glances by
// its race word alone; the block's week stays in `line`, named as the block's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { weekFrameLine } from "../dist/repo/week-stage.js";
import { createBlock } from "../dist/repo/program-blocks.js";

const TODAY = "2026-10-20";

function taperBuild() {
  return {
    available: true,
    as_of: TODAY,
    race: { event: "Cambridge Half", date: "2026-11-01", distance_km: 21.1, phase: "taper", days_to_race: 12 },
    weeks: [
      { week_start: "2026-10-19", kind: "taper", phase: "taper", current: true },
      { week_start: "2026-10-26", kind: "race", phase: "taper", current: false },
    ],
  };
}

test("a taper week glances 'N days to <race> · Taper week' — never the block's wk n of m", () => {
  repo.setProfile({ age: 40 });
  createBlock({ goal: "Accumulation", focus: "hypertrophy", total_weeks: 6, week_index: 1, started_at: "2026-10-19" });
  const frame = weekFrameLine(TODAY, { build: taperBuild() });
  assert.equal(frame.stage?.source, "race");
  assert.ok(frame.block, "the fixture's block is active");
  assert.equal(frame.glance, `12 days to Cambridge · ${frame.stage.week_word}`);
  assert.match(frame.glance, /Taper week$/);
  assert.doesNotMatch(frame.glance, /wk \d+ of \d+/);
  // The block's week is still said, as the block's, in the line under the headline.
  assert.match(frame.line ?? "", /block week 1 of 6/);
});

test("a week named by the block (no race) keeps its block week in the glance", () => {
  createBlock({ goal: "Build", focus: "strength", total_weeks: 5, week_index: 3, started_at: "2026-10-06" });
  const frame = weekFrameLine(TODAY, { build: { available: false, weeks: [] } });
  if (frame.stage?.source === "block") assert.match(frame.glance ?? "", /wk 3 of 5|Block week 3 of 5/);
  else assert.match(frame.glance ?? "", /Block week 3 of 5/);
});
