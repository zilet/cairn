// Elite-training WAVE C3 — periodization is LIVE, not cosmetic:
//   - ensureActiveBlock() auto-creates a sensible block when none is running, and is
//     idempotent (never resets one mid-way through)
//   - advanceBlockWeek() moves the phase across weeks (accumulation → intensification
//     → deload), and a PEAK block reaches the 'realization' phase in its last week —
//     which is what makes testWeekDue's realization branch reachable
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import {
  chooseBlockFocus,
  ensureActiveBlock,
  advanceBlockWeek,
  createBlock,
  getActiveBlock,
} from "../dist/repo/program-blocks.js";
import { testWeekDue } from "../dist/repo/muscle-trajectory.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

beforeEach(() => {
  resetTables("program_blocks", "logged_sets", "sessions", "exercises", "plan_items", "plan_days");
  repo.setProfile({ endurance_goal: null, training_intent: null, primary_discipline: "strength" });
});

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

const MUSCLE_FIRST = {
  priorities: ["longevity", "muscle", "strength", "leanness", "endurance"],
  endurance_role: "supporting",
  source: "explicit",
};
const STRENGTH_FIRST = {
  priorities: ["longevity", "strength", "muscle", "leanness", "endurance"],
  endurance_role: "supporting",
  source: "explicit",
};
const CO_PRIMARY = {
  priorities: ["strength", "endurance", "muscle", "longevity"],
  endurance_role: "co_primary",
  source: "explicit",
};
const DERIVED_STRENGTH = {
  priorities: ["strength", "muscle", "longevity"],
  endurance_role: "none",
  source: "derived",
};
const EXPLICIT_GAIN = {
  priorities: ["muscle", "strength", "longevity"],
  endurance_role: "none",
  source: "explicit",
};

const BUILD_RACE = { is_race: true, phase: "build", weeks_to_race: 9, event: "Spring Half" };
const TAPER_RACE = { is_race: true, phase: "taper", weeks_to_race: 2, event: "Spring Half" };
const FAR_RACE_WITH_TARGET = {
  is_race: true,
  phase: "base",
  weeks_to_race: 14,
  event: "Spring Half",
  target: "sub-1:45",
};

test("supporting race 9 weeks out + muscle-first intent ⇒ hypertrophy block", () => {
  const chosen = chooseBlockFocus(BUILD_RACE, MUSCLE_FIRST);
  assert.equal(chosen.focus, "hypertrophy");
  assert.equal(chosen.total_weeks, 6);
  assert.match(chosen.goal, /muscle first/i);
  assert.match(chosen.goal, /spring half/i);
  assert.doesNotMatch(chosen.goal, /endurance-base|periodiz|mesocycle|focus/i);

  repo.setProfile({
    training_intent: MUSCLE_FIRST,
    endurance_goal: { mode: "race", event: "Spring Half", date: addDaysISO(localDateISO(), 63), distance_km: 21.1 },
  });
  const block = ensureActiveBlock();
  assert.equal(block.focus, "hypertrophy");
  assert.equal(block.total_weeks, 6);
  assert.match(block.goal, /supporting/i);
});

test("supporting race 9 weeks out + strength-first intent ⇒ strength block", () => {
  const chosen = chooseBlockFocus(BUILD_RACE, STRENGTH_FIRST);
  assert.equal(chosen.focus, "strength");
  assert.equal(chosen.total_weeks, 6);
  assert.match(chosen.goal, /strength first/i);

  repo.setProfile({
    training_intent: STRENGTH_FIRST,
    endurance_goal: { mode: "race", event: "Spring Half", date: addDaysISO(localDateISO(), 63), distance_km: 21.1 },
  });
  const block = ensureActiveBlock();
  assert.equal(block.focus, "strength");
  assert.equal(block.total_weeks, 6);
});

test("co_primary 9 weeks out ⇒ endurance-base", () => {
  const chosen = chooseBlockFocus(BUILD_RACE, CO_PRIMARY);
  assert.equal(chosen.focus, "endurance-base");
  assert.match(chosen.goal, /aerobic base/i);

  repo.setProfile({
    training_intent: CO_PRIMARY,
    endurance_goal: { mode: "race", event: "Spring Half", date: addDaysISO(localDateISO(), 63), distance_km: 21.1 },
  });
  const block = ensureActiveBlock();
  assert.equal(block.focus, "endurance-base");
});

test("supporting race 2 weeks out ⇒ peak", () => {
  const chosen = chooseBlockFocus(TAPER_RACE, MUSCLE_FIRST);
  assert.equal(chosen.focus, "peak");
  assert.ok(chosen.total_weeks >= 2 && chosen.total_weeks <= 4);
  assert.match(chosen.goal, /sharpen/i);

  repo.setProfile({
    training_intent: MUSCLE_FIRST,
    endurance_goal: { mode: "race", event: "Spring Half", date: addDaysISO(localDateISO(), 14), distance_km: 21.1 },
  });
  const block = ensureActiveBlock();
  assert.equal(block.focus, "peak");
});

test("derived intent + race 9 wk ⇒ endurance-base (old tree)", () => {
  const chosen = chooseBlockFocus(BUILD_RACE, DERIVED_STRENGTH);
  assert.equal(chosen.focus, "endurance-base");
  assert.match(chosen.goal, /aerobic base/i);

  repo.setProfile({
    training_intent: null,
    primary_discipline: "strength",
    goal_mode: "maintain",
    endurance_goal: { mode: "race", event: "Spring Half", date: addDaysISO(localDateISO(), 63), distance_km: 21.1 },
  });
  const block = ensureActiveBlock();
  assert.equal(block.focus, "endurance-base");
});

test("derived intent + race 14 wk with target ⇒ endurance-base (old 16-wk branch)", () => {
  const chosen = chooseBlockFocus(FAR_RACE_WITH_TARGET, DERIVED_STRENGTH);
  assert.equal(chosen.focus, "endurance-base");
  assert.match(chosen.goal, /aerobic base/i);

  // 10k (short race) 14 weeks out is phase "base", so getEnduranceGoal hits the
  // target-within-16-weeks branch rather than the 10-week build window.
  repo.setProfile({
    training_intent: null,
    primary_discipline: "strength",
    goal_mode: "maintain",
    endurance_goal: {
      mode: "race",
      event: "Spring 10k",
      date: addDaysISO(localDateISO(), 98),
      distance_km: 10,
      target: "sub-45",
    },
  });
  const block = ensureActiveBlock();
  assert.equal(block.focus, "endurance-base");
});

test("explicit gain-with-no-goal follows the explicit strength-led branch", () => {
  const chosen = chooseBlockFocus(null, EXPLICIT_GAIN);
  assert.equal(chosen.focus, "hypertrophy", "muscle leads strength on the explicit branch");
  assert.equal(chosen.total_weeks, 6);

  repo.setProfile({
    goal_mode: "gain",
    training_intent: EXPLICIT_GAIN,
    endurance_goal: null,
  });
  const block = ensureActiveBlock();
  assert.equal(block.focus, "hypertrophy");
  assert.equal(block.total_weeks, 6);
});

test("derived intent + no endurance goal ⇒ strength/6 (old tree, including gain)", () => {
  const chosen = chooseBlockFocus(null, {
    ...DERIVED_STRENGTH,
    priorities: ["muscle", "strength", "longevity"],
  });
  assert.equal(chosen.focus, "strength");
  assert.equal(chosen.total_weeks, 6);

  repo.setProfile({
    training_intent: null,
    primary_discipline: "strength",
    goal_mode: "gain",
    endurance_goal: null,
  });
  const block = ensureActiveBlock();
  assert.equal(block.focus, "strength");
  assert.equal(block.total_weeks, 6);
});
