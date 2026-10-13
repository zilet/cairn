// On an install that already holds a running goal or run week, the onboard extraction
// (MCP `onboard`, POST /api/onboard) changes them only where the person's own text
// explicitly states them — never wiped, or replaced wholesale, from words that do not.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_seed.js";
import { applyOnboardParsed, emptyOnboardApplied } from "../dist/coachOps.js";
import { getEnduranceGoal, getEnduranceSchedule, setProfile } from "../dist/repo/profile.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const plain = (value) => JSON.parse(JSON.stringify(value));

function existingInstall() {
  const raceDate = addDaysISO(localDateISO(), 60);
  setProfile({
    endurance_goal: {
      mode: "race",
      event: "City Half",
      date: raceDate,
      distance_km: 21.1,
      target: "sub-1:50",
      weekly_km: 30,
    },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
      source: "athlete",
    },
  });
  return raceDate;
}

test("an existing goal and run week stand when the text does not state them", () => {
  const raceDate = existingInstall();
  const applied = emptyOnboardApplied();
  applyOnboardParsed(
    {
      endurance_goal: { mode: "standing", label: "general fitness" },
      endurance_schedule: {
        days: [
          { dow: 1, kind: "any" },
          { dow: 3, kind: "any" },
        ],
      },
    },
    applied,
    { raw: "I want to get stronger and lift four days a week." }
  );
  assert.equal(applied.endurance_goal, null);
  assert.deepEqual(applied.run_days, []);
  const goal = getEnduranceGoal();
  assert.equal(goal.mode, "race");
  assert.equal(goal.date, raceDate);
  assert.equal(goal.weekly_km, 30);
  assert.deepEqual(
    getEnduranceSchedule()
      .days.map((d) => d.dow)
      .sort(),
    [0, 2, 4]
  );

  // Without the person's text there is nothing to hold an overwrite to.
  applyOnboardParsed({ endurance_goal: { mode: "standing", label: "10k-ready" } }, emptyOnboardApplied());
  assert.equal(getEnduranceGoal().mode, "race");

  // An extraction carrying nothing never wipes them.
  applyOnboardParsed({ endurance_goal: null, endurance_schedule: null }, emptyOnboardApplied(), { raw: "hi" });
  assert.equal(getEnduranceGoal().event, "City Half");
  assert.equal(getEnduranceSchedule().days.length, 3);
});

test("an existing install changes only what the text explicitly states, and keeps the rest", () => {
  existingInstall();
  const moved = addDaysISO(localDateISO(), 75);
  const applied = emptyOnboardApplied();
  applyOnboardParsed(
    {
      endurance_goal: { mode: "race", event: "City Half", date: moved, distance_km: 21.1 },
      endurance_schedule: {
        days: [
          { dow: 1, kind: "easy" },
          { dow: 5, kind: "long" },
        ],
      },
    },
    applied,
    { raw: `My half marathon moved to ${moved}, and I run Mondays and Fridays now.` }
  );
  assert.equal(applied.endurance_goal, "race");
  const goal = getEnduranceGoal();
  assert.equal(goal.date, moved);
  assert.equal(goal.weekly_km, 30, "the stated weekly volume stands");
  assert.equal(goal.target, "sub-1:50", "the same race keeps its stated target");
  assert.deepEqual(plain(applied.run_days).sort(), [1, 5]);

  // A run day the words never named keeps the stored week whole.
  applyOnboardParsed(
    {
      endurance_schedule: {
        days: [
          { dow: 2, kind: "easy" },
          { dow: 6, kind: "long" },
        ],
      },
    },
    emptyOnboardApplied(),
    { raw: "I run Tuesdays, and a long one sometimes" }
  );
  assert.deepEqual(
    getEnduranceSchedule()
      .days.map((d) => d.dow)
      .sort(),
    [1, 5],
    "Saturday was not named in their words"
  );
});
