// The first week never promises a run day the calendar won't show (a real-provider walk:
// the composer's prose said "quality run Wednesday" while the run engine put the VO2
// intervals on a lifting Tuesday and left Wednesday as rest, because no run days had been
// captured).
//
//   - the onboarding contract captures the weekdays the person NAMED for running as the
//     stated endurance_schedule, through the existing setter and its normalizer;
//   - with run days stated, the engine places the week's runs on exactly those weekdays
//     (the same placements Today's calendar shows);
//   - the coach's first words and the composer may name a run weekday only when it was
//     stated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { applyOnboardParsed, emptyOnboardApplied } from "../dist/coachOps.js";
import { getEnduranceSchedule, isoDow, setProfile } from "../dist/repo/profile.js";
import { buildOnboardPrompt } from "../dist/prompt/program.js";
import { buildWeekComposePrompt } from "../dist/prompt/coach.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

test("the onboarding contract asks for named run days, and the reply may not guess one", () => {
  const prompt = buildOnboardPrompt("Half in November; I run Wednesdays and Sundays.", {
    welcome: true,
    today: "2026-10-13",
  });
  assert.match(prompt, /"endurance_schedule"/);
  assert.match(prompt, /never invent run days/);
  assert.match(prompt, /Never name a weekday for a run they did not name themselves/);
});

test("named run days land as the stated endurance schedule, kinds kept, junk dropped", () => {
  const applied = emptyOnboardApplied();
  applyOnboardParsed(
    {
      endurance_schedule: {
        days: [
          { dow: 3, kind: "quality" },
          { dow: 0, kind: "long" },
          { dow: 9, kind: "easy" },
          { dow: 5, kind: "whatever" },
        ],
      },
    },
    applied
  );
  const schedule = getEnduranceSchedule();
  assert.ok(schedule, "stored");
  const byDow = Object.fromEntries(schedule.days.map((d) => [d.dow, d.kind]));
  assert.equal(byDow[3], "quality");
  assert.equal(byDow[0], "long");
  assert.equal(byDow[9], undefined, "a weekday that does not exist is dropped");
  assert.deepEqual(
    applied.run_days,
    schedule.days.map((d) => d.dow)
  );
});

test("no run days said, none invented", () => {
  const applied = emptyOnboardApplied();
  applyOnboardParsed({ endurance_schedule: null, endurance_goal: null }, applied);
  assert.equal(getEnduranceSchedule(), null);
  assert.deepEqual(applied.run_days, []);
});

test("the composer may name a run weekday only when it is stated", () => {
  const prompt = buildWeekComposePrompt("first week");
  assert.match(prompt, /NEVER PROMISE A RUN WEEKDAY THE CALENDAR WON'T SHOW/);
  assert.match(prompt, /ONLY when DATA\.endurance_schedule states that weekday/);
});

test("with run days stated, the calendar places the runs on exactly those weekdays", () => {
  const today = localDateISO();
  setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "race", event: "Half marathon", date: addDaysISO(today, 42), distance_km: 21.1 },
  });
  applyOnboardParsed(
    {
      lift_days: [1, 2, 4, 5],
      endurance_schedule: {
        days: [
          { dow: 3, kind: "quality" },
          { dow: 6, kind: "long" },
          { dow: 0, kind: "easy" },
        ],
      },
    },
    emptyOnboardApplied()
  );
  repo.savePlanDay(1, "Upper", "upper", [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 10 }]);
  repo.savePlanDay(2, "Lower", "lower", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const week = planWeek(today);
  const runDays = week.days.filter((d) => d.run && d.run.status === "open" && d.date);
  assert.ok(
    week.days.some((d) => d.run),
    "the engine placed this week's runs"
  );
  for (const cell of runDays) {
    assert.ok(
      [3, 6, 0].includes(isoDow(cell.date)),
      `a run on ${cell.weekday} (${cell.run.kind}) is not a stated run day`
    );
  }
  assert.deepEqual(week.schedule.run_days.length, 3, "the stated run days are the calendar's");
});
