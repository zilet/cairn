// The week's fuel (repo/fuel-week.ts): the seven days of the week the day's energy number
// belongs to, each exactly the number its own day read gives, around the accepted average.
// What was eaten rides along only on a lived day whose log reads complete (the one
// credibility rule): a partial or unlogged day carries nothing, never a low number. The
// day read gains the week as one additive field and every other field is untouched.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { dayEnergyTarget, withDayEnergy } from "../dist/repo/day-energy.js";
import { fuelWeekRead, fuelWeekTag, fuelWeekWords } from "../dist/repo/fuel-week.js";
import { nutritionDayRead } from "../dist/repo/fuel-guides.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { mondayOf } from "../dist/lib/dates.js";

const AVERAGE = 2160;
const today = () => localDateISO();
const weekDates = (of = today()) => Array.from({ length: 7 }, (_, i) => addDaysISO(mondayOf(of), i));

beforeEach(() => {
  resetTables("food_notes", "profile", "bodyweight_log", "plan_items", "plan_days", "nutrition_targets");
});

function athlete(extra = {}) {
  repo.setProfile({
    age: 44,
    height_cm: 170,
    weight_lb: 153,
    sex: "male",
    activity_factor: 1.55,
    goal_mode: "lose",
    ...extra,
  });
  repo.logWeight(153, today());
}

function liftingWeek() {
  athlete({ strength_schedule: { days: [{ dow: 1 }, { dow: 4 }], source: "athlete", updated_at: today() } });
  repo.savePlanDay(1, "Full body", "strength", [{ exercise: "Back Squat", sets: 3, reps: "5" }], {
    day_type: "training",
  });
}

// A raw food row (the production writer refuses a future date; the read must still ignore one).
function food(date, meal, kcal, eatenAt = null) {
  db.prepare(`INSERT INTO food_notes (date, meal, raw_output, parsed_json, eaten_at) VALUES (?, ?, '', ?, ?)`).run(
    date,
    meal,
    JSON.stringify({ kcal }),
    eatenAt
  );
}

test("the seven days are each day's own number, Monday to Sunday, and the plan sums to seven times the average", () => {
  liftingWeek();
  const week = fuelWeekRead(today(), AVERAGE, { today: today() });
  assert.ok(week, "a week with an average reads");
  assert.deepEqual(
    week.days.map((d) => d.date),
    weekDates()
  );
  assert.deepEqual(
    week.days.map((d) => d.weekday),
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  );
  for (const day of week.days) {
    const own = dayEnergyTarget(day.date, AVERAGE, { today: today() });
    assert.equal(day.kcal, own.kcal, `${day.date} is its own day read's number`);
    assert.equal(day.shift_kcal, own.shift_kcal);
    assert.equal(day.words, own.words);
    assert.deepEqual(day.work, own.work);
  }
  assert.equal(week.week_of, mondayOf(today()));
  assert.equal(week.average_kcal, AVERAGE);
  assert.equal(week.week_kcal, 7 * AVERAGE);
  const planned = week.days.reduce((sum, d) => sum + d.kcal - d.outcome_shift_kcal, 0);
  assert.equal(planned, 7 * AVERAGE, "the plan's seven numbers add up to seven times the average");
  assert.match(week.sum_words, /seven times the average/);
  assert.ok(week.days.some((d) => d.shift_kcal > 0) && week.days.some((d) => d.shift_kcal < 0), "the week has a shape");
  for (const day of week.days) assert.equal(day.tag, day.work.includes("lifting") ? "Lift" : "Rest");
  assert.match(week.words, /2,160/);
  for (const line of [week.words, week.sum_words]) {
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.doesNotMatch(line, /%|score|\bover\b|\bunder\b|\blow\b/i, line);
  }
});

test("past, today and ahead follow the calendar", () => {
  liftingWeek();
  const week = fuelWeekRead(today(), AVERAGE, { today: today() });
  for (const day of week.days) {
    const expected = day.date < today() ? "past" : day.date === today() ? "today" : "ahead";
    assert.equal(day.when, expected, day.date);
  }
  assert.equal(week.days.filter((d) => d.when === "today").length, 1);
  const lastWeek = fuelWeekRead(addDaysISO(mondayOf(today()), -3), AVERAGE, { today: today() });
  assert.ok(
    lastWeek.days.every((d) => d.when === "past"),
    "a week already over is all lived"
  );
  const nextWeek = fuelWeekRead(addDaysISO(mondayOf(today()), 9), AVERAGE, { today: today() });
  assert.ok(
    nextWeek.days.every((d) => d.when === "ahead" && d.logged_kcal == null),
    "a week not yet opened is all ahead"
  );
});

test("a lived day carries what was logged only when its log reads complete; a partial or unlogged day carries nothing", () => {
  athlete();
  const monday = addDaysISO(mondayOf(today()), -7);
  const at = (i) => addDaysISO(monday, i);
  // Monday: a whole day (morning into the evening, past the spanning bar).
  food(at(0), "breakfast", 650, "07:30");
  food(at(0), "lunch", 700, "12:30");
  food(at(0), "dinner", 900, "19:00");
  // Tuesday: breakfast and lunch only — the dinner never arrived. Partial: absent, never low.
  food(at(1), "breakfast", 650, "07:30");
  food(at(1), "lunch", 700, "12:30");
  // Wednesday: snacks only.
  food(at(2), "snack", 300, "08:00");
  food(at(2), "snack", 300, "20:00");
  const week = fuelWeekRead(at(3), AVERAGE, { today: today() });
  assert.equal(week.days[0].logged_kcal, 2250, "the complete day says what was logged");
  assert.equal(week.days[1].logged_kcal, null, "a partial day is absent");
  assert.equal(week.days[2].logged_kcal, null, "snacks alone are not a day's eating");
  for (const day of week.days.slice(3)) assert.equal(day.logged_kcal, null, "an unlogged day is absent");
});

test("today's complete log counts; a day ahead never carries a logged amount", () => {
  athlete();
  food(today(), "breakfast", 600, "07:00");
  food(today(), "dinner", 1100, "19:30");
  const tomorrow = addDaysISO(today(), 1);
  food(tomorrow, "breakfast", 600, "07:00");
  food(tomorrow, "dinner", 1100, "19:30");
  const week = fuelWeekRead(today(), AVERAGE, { today: today() });
  assert.equal(week.days.find((d) => d.when === "today").logged_kcal, 1700);
  const ahead = week.days.find((d) => d.date === tomorrow);
  if (ahead) assert.equal(ahead.logged_kcal, null, "food dated ahead is not a lived day");
});

test("the day read gains the week and keeps every field it had, units untouched", () => {
  liftingWeek();
  food(today(), "breakfast", 600, "07:00");
  const read = nutritionDayRead(today(), { today: today() });
  const plain = withDayEnergy(repo.getDayIntake(today()), { today: today() });
  assert.deepEqual(read.target, plain.target, "the target (kcal, protein, average) is untouched");
  assert.deepEqual(read.totals, plain.totals);
  assert.deepEqual(read.remaining, plain.remaining);
  assert.ok(read.fuel_week, "the week rides along");
  assert.equal(read.fuel_week.average_kcal, read.target.average_kcal);
  const own = read.fuel_week.days.find((d) => d.date === today());
  assert.equal(own.kcal, read.target.kcal, "today in the week is today's number");
  assert.equal(own.words, read.target.day_words ?? null);
  // Numbers stay kcal integers; the week never converts anything.
  for (const day of read.fuel_week.days) assert.ok(Number.isInteger(day.kcal));
});

test("no target, no week", () => {
  const read = nutritionDayRead(today(), { today: today() });
  assert.equal(read.target, null);
  assert.equal(read.fuel_week, null);
  assert.equal(fuelWeekRead(today(), null), null);
});

const day = (date, shift, work = [], extra = {}) => ({
  date,
  weekday: "",
  kcal: AVERAGE + shift,
  shift_kcal: shift,
  outcome_shift_kcal: 0,
  work,
  outcome_work: [],
  tag: fuelWeekTag(work),
  words: null,
  when: "ahead",
  logged_kcal: null,
  ...extra,
});
// 2026-11-16 is a Monday.
const NOV = (i) => addDaysISO("2026-11-16", i);

test("the line names the average, the day given most and the day given least, and rotates its phrasing", () => {
  const days = [
    day(NOV(0), -150),
    day(NOV(1), 0),
    day(NOV(2), 0),
    day(NOV(3), 0),
    day(NOV(4), -50),
    day(NOV(5), 200, ["the long run"]),
    day(NOV(6), 0),
  ];
  const lines = new Set();
  for (let i = 0; i < 6; i++) {
    const line = fuelWeekWords(days, AVERAGE, { date: NOV(i), past: false });
    lines.add(line);
    assert.match(line, /2,160/);
    assert.match(line, /Saturday (carries|gets) more for the long run(,| and) Monday less\./);
  }
  assert.ok(lines.size > 1, "the phrasing rotates by date");
  const past = fuelWeekWords(days, AVERAGE, { date: NOV(0), past: true });
  assert.match(past, /averaged|average\./);
  assert.match(past, /Saturday (carried|got) more/);
});

test("a flat week says so; a three-way tie is named as the bigger or lighter days", () => {
  const flat = Array.from({ length: 7 }, (_, i) => day(NOV(i), 0));
  assert.match(fuelWeekWords(flat, AVERAGE, { date: NOV(0), past: false }), /2,160/);
  const ties = [
    day(NOV(0), 100, ["lifting"]),
    day(NOV(1), -100),
    day(NOV(2), 100, ["lifting"]),
    day(NOV(3), -100),
    day(NOV(4), 100, ["lifting"]),
    day(NOV(5), -100),
    day(NOV(6), 0),
  ];
  for (let i = 0; i < 3; i++) {
    const line = fuelWeekWords(ties, AVERAGE, { date: NOV(i), past: false });
    assert.match(line, /[Tt]he bigger days (carry|get) more(,| and) the lighter days less\./, line);
  }
  const two = [
    day(NOV(0), 100, ["lifting"]),
    day(NOV(3), 100, ["lifting"]),
    ...[1, 2, 4, 5, 6].map((i) => day(NOV(i), -40)),
  ];
  assert.match(
    fuelWeekWords(two, AVERAGE, { date: NOV(0), past: false }),
    /Monday and Thursday (carry|get) more for lifting/
  );
});

test("each column's word follows the biggest piece of work, and a day with none is a rest day", () => {
  assert.equal(fuelWeekTag([]), "Rest");
  assert.equal(fuelWeekTag(["the long run"]), "Long");
  assert.equal(fuelWeekTag(["lifting", "the easy run"]), "Run");
  assert.equal(fuelWeekTag(["lifting"]), "Lift");
  assert.equal(fuelWeekTag(["your usual Wednesday ride"]), "Ride");
  assert.equal(fuelWeekTag(["the run you logged"]), "Run");
  assert.equal(fuelWeekTag(["the hike you logged"]), "Hike");
});
