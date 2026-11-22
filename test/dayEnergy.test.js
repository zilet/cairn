// The DAY's energy number (repo/day-energy.ts): the accepted target is the week's average,
// and each day of the current week moves around it with the planned work. Protein never
// moves, a week already over keeps the average, and nothing planned moves nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import {
  dayEnergyTarget,
  withDayEnergy,
  DAY_SHIFT_CAP_SHARE,
} from "../dist/repo/day-energy.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { mondayOf } from "../dist/lib/dates.js";

const AVERAGE = 2160;
const today = () => localDateISO();
const weekDates = () => Array.from({ length: 7 }, (_, i) => addDaysISO(mondayOf(today()), i));

function athlete(extra = {}) {
  repo.setProfile({ age: 44, height_cm: 170, weight_lb: 153, sex: "male", activity_factor: 1.55, goal_mode: "lose", ...extra });
  repo.logWeight(153, today());
}

test("with nothing planned every day keeps the average and says nothing", () => {
  athlete();
  for (const date of weekDates()) {
    const day = dayEnergyTarget(date, AVERAGE, { today: today() });
    assert.equal(day.kcal, AVERAGE);
    assert.equal(day.shift_kcal, 0);
    assert.equal(day.words, null);
  }
});

test("lifting days are given more than rest days, inside the cap, and the week still averages the target", () => {
  athlete({ strength_schedule: { days: [{ dow: 1 }, { dow: 4 }], source: "athlete", updated_at: today() } });
  repo.savePlanDay(1, "Full body", "strength", [{ exercise: "Back Squat", sets: 3, reps: "5" }], { day_type: "training" });
  const days = weekDates().map((date) => dayEnergyTarget(date, AVERAGE, { today: today() }));
  const lift = days.filter((d) => d.work.includes("lifting"));
  const rest = days.filter((d) => !d.work.length);
  assert.ok(lift.length >= 1 && rest.length >= 1, "the week has both kinds of day");
  assert.ok(Math.min(...lift.map((d) => d.kcal)) >= Math.max(...rest.map((d) => d.kcal)));
  for (const d of days) {
    assert.ok(Math.abs(d.shift_kcal) <= AVERAGE * DAY_SHIFT_CAP_SHARE + 10, `${d.date} stays inside the cap`);
    if (d.words) {
      assert.equal(violatesReadingGrammar(d.words), null, d.words);
      assert.match(d.words, /your 2,160 average/);
    }
  }
  const drift = days.reduce((sum, d) => sum + d.shift_kcal, 0);
  assert.ok(Math.abs(drift) <= 40, `the week stays on its average (drift ${drift})`);
});

test("a week already over keeps the average: its plan is gone", () => {
  athlete({ strength_schedule: { days: [{ dow: 1 }, { dow: 4 }], source: "athlete", updated_at: today() } });
  const lastWeek = addDaysISO(mondayOf(today()), -3);
  assert.equal(dayEnergyTarget(lastWeek, AVERAGE, { today: today() }).kcal, AVERAGE);
});

test("laid over a day read: energy and what remains move, protein and the average are kept", () => {
  athlete({ strength_schedule: { days: [{ dow: 1 }, { dow: 4 }], source: "athlete", updated_at: today() } });
  repo.savePlanDay(1, "Full body", "strength", [{ exercise: "Back Squat", sets: 3, reps: "5" }], { day_type: "training" });
  const date = weekDates().find((d) => dayEnergyTarget(d, AVERAGE, { today: today() }).shift_kcal !== 0);
  assert.ok(date, "some day of the week moves");
  const intake = { date, totals: { kcal: 500, protein_g: 40 }, target: { kcal: AVERAGE, protein_g: 175 }, remaining: { kcal: AVERAGE - 500, protein_g: 135 } };
  const shaped = withDayEnergy(intake, { today: today() });
  assert.equal(shaped.target.average_kcal, AVERAGE);
  assert.equal(shaped.target.protein_g, 175);
  assert.equal(shaped.target.kcal, AVERAGE + shaped.target.day_shift_kcal);
  assert.equal(shaped.remaining.kcal, shaped.target.kcal - 500);
  assert.equal(shaped.remaining.protein_g, 135);
  assert.equal(withDayEnergy(shaped, { today: today() }), shaped, "never laid over twice");
  assert.equal(withDayEnergy({ ...intake, target: null, remaining: null }).target, null);
});
