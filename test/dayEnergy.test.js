// The DAY's energy number (repo/day-energy.ts): the accepted target is the week's average,
// and each day of the current week moves around it with the planned work, in fifties.
// Protein never moves, a week already over is shaped from what was logged, nothing planned
// moves nothing, the week's plan holds still while it is lived, and a clear departure from
// the plan moves that day alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import {
  dayEnergyTarget,
  dayOutcomeCost,
  dayWords,
  withDayEnergy,
  CROSS_NET_KCAL_PER_KG,
  DAY_SHIFT_CAP_SHARE,
  DAY_SHIFT_SHARE,
  DAY_SHIFT_STEP_KCAL,
  LIFT_NET_KCAL_PER_KG,
  RUN_KCAL_PER_KG_KM,
  WALK_NET_KCAL_PER_KG,
} from "../dist/repo/day-energy.js";
import { isoDow } from "../dist/repo/profile.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { LB_PER_KG, addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { mondayOf } from "../dist/lib/dates.js";

const AVERAGE = 2160;
const today = () => localDateISO();
const weekDates = () => Array.from({ length: 7 }, (_, i) => addDaysISO(mondayOf(today()), i));

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
  repo.savePlanDay(1, "Full body", "strength", [{ exercise: "Back Squat", sets: 3, reps: "5" }], {
    day_type: "training",
  });
  const days = weekDates().map((date) => dayEnergyTarget(date, AVERAGE, { today: today() }));
  const lift = days.filter((d) => d.work.includes("lifting"));
  const rest = days.filter((d) => !d.work.length);
  assert.ok(lift.length >= 1 && rest.length >= 1, "the week has both kinds of day");
  assert.ok(Math.min(...lift.map((d) => d.kcal)) >= Math.max(...rest.map((d) => d.kcal)));
  for (const d of days) {
    assert.ok(Math.abs(d.shift_kcal) <= AVERAGE * DAY_SHIFT_CAP_SHARE, `${d.date} stays inside the cap`);
    assert.equal(Math.abs(d.shift_kcal) % DAY_SHIFT_STEP_KCAL, 0, `${d.date} moves in fifties (${d.shift_kcal})`);
    if (d.words) {
      assert.equal(violatesReadingGrammar(d.words), null, d.words);
      assert.match(d.words, /your 2,160 average/);
    }
  }
  const drift = days.reduce((sum, d) => sum + d.shift_kcal, 0);
  assert.equal(drift, 0, "the week stays exactly on its average");
});

test("a week already over with nothing logged keeps the average", () => {
  athlete({ strength_schedule: { days: [{ dow: 1 }, { dow: 4 }], source: "athlete", updated_at: today() } });
  const lastWeek = addDaysISO(mondayOf(today()), -3);
  assert.equal(dayEnergyTarget(lastWeek, AVERAGE, { today: today() }).kcal, AVERAGE);
});

test("laid over a day read: energy and what remains move, protein and the average are kept", () => {
  athlete({ strength_schedule: { days: [{ dow: 1 }, { dow: 4 }], source: "athlete", updated_at: today() } });
  repo.savePlanDay(1, "Full body", "strength", [{ exercise: "Back Squat", sets: 3, reps: "5" }], {
    day_type: "training",
  });
  const date = weekDates().find((d) => dayEnergyTarget(d, AVERAGE, { today: today() }).shift_kcal !== 0);
  assert.ok(date, "some day of the week moves");
  const intake = {
    date,
    totals: { kcal: 500, protein_g: 40 },
    target: { kcal: AVERAGE, protein_g: 175 },
    remaining: { kcal: AVERAGE - 500, protein_g: 135 },
  };
  const shaped = withDayEnergy(intake, { today: today() });
  assert.equal(shaped.target.average_kcal, AVERAGE);
  assert.equal(shaped.target.protein_g, 175);
  assert.equal(shaped.target.kcal, AVERAGE + shaped.target.day_shift_kcal);
  assert.equal(shaped.remaining.kcal, shaped.target.kcal - 500);
  assert.equal(shaped.remaining.protein_g, 135);
  assert.equal(withDayEnergy(shaped, { today: today() }), shaped, "never laid over twice");
  assert.equal(withDayEnergy({ ...intake, target: null, remaining: null }).target, null);
});

const KG = 153 / LB_PER_KG;
const CAP = AVERAGE * DAY_SHIFT_CAP_SHARE;
const CAP_STEPS = Math.floor(CAP / 50) * 50;
const fifty = (n) => Math.round(n / 50) * 50;

test("a week already over is shaped from what was logged, and still sums to seven times the average", () => {
  athlete();
  const monday = addDaysISO(mondayOf(today()), -7);
  const at = (i) => addDaysISO(monday, i);
  repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, date: at(0) });
  repo.addActivity({ date: at(2), type: "running", distance_km: 16, duration_min: 90 });
  repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, date: at(3) });
  repo.addActivity({ date: at(5), type: "cycling", duration_min: 90 });
  const days = Array.from({ length: 7 }, (_, i) => dayEnergyTarget(at(i), AVERAGE, { today: today() }));
  const run = days[2];
  assert.ok(run.kcal > AVERAGE, "the long run day was given more");
  assert.ok(run.work.includes("the run you logged"), run.work.join(", "));
  assert.ok(days[0].work.includes("lifting") && days[3].work.includes("lifting"));
  assert.ok(days[5].work.includes("the ride you logged"), days[5].work.join(", "));
  assert.ok(run.kcal >= Math.max(...days.map((d) => d.kcal)), "the run day is the biggest");
  assert.ok(days[6].kcal < AVERAGE, "an empty day was given less");
  for (const d of days) {
    assert.equal(d.outcome_shift_kcal, 0, "a week over has no outcome of its own");
    assert.ok(Math.abs(d.shift_kcal) <= CAP, `${d.date} stays inside the cap`);
    assert.equal(Math.abs(d.shift_kcal) % 50, 0, `${d.date} moves in fifties (${d.shift_kcal})`);
    if (d.words) {
      assert.equal(violatesReadingGrammar(d.words), null, d.words);
      assert.match(d.words, /^That day's number was about [\d,]+ kcal: your 2,160 average/);
    }
  }
  const drift = days.reduce((sum, d) => sum + d.shift_kcal, 0);
  assert.equal(drift, 0, "the week stays exactly on its average");
});

test("an unplanned ride today adds half its cost to today alone, said plainly", () => {
  athlete();
  repo.addActivity({ date: today(), type: "cycling", duration_min: 60 });
  const day = dayEnergyTarget(today(), AVERAGE, { today: today() });
  const expected = fifty(KG * CROSS_NET_KCAL_PER_KG * DAY_SHIFT_SHARE);
  assert.equal(day.outcome_shift_kcal, expected);
  assert.equal(day.kcal, AVERAGE + expected);
  assert.equal(day.shift_kcal, expected);
  assert.equal(
    day.words,
    `Today's number is about ${(AVERAGE + expected).toLocaleString("en-US")} kcal: your 2,160 average plus about ${expected} for the ride you logged. The rest of the week keeps its numbers.`
  );
  assert.equal(violatesReadingGrammar(day.words), null);
  // Not handed to the rest of the week: every other day keeps the average.
  for (const date of weekDates().filter((d) => d !== today())) {
    assert.equal(dayEnergyTarget(date, AVERAGE, { today: today() }).kcal, AVERAGE, date);
  }
});

test("a big unplanned day still stops at the cap, and its run is counted once", () => {
  athlete();
  repo.addActivity({ date: today(), type: "running", distance_km: 18, duration_min: 100 });
  const big = dayEnergyTarget(today(), AVERAGE, { today: today() });
  assert.ok(big.outcome_shift_kcal > 0);
  assert.equal(big.shift_kcal, CAP_STEPS, `the day's whole move stops at the cap (${big.shift_kcal})`);
  // Whether the week's agenda read it as its planned run done longer or as an extra, the
  // run is named once, as a run.
  assert.equal((big.words.match(/run you logged/g) ?? []).length, 1, big.words);
  assert.doesNotMatch(big.words, /ride|session/, "a run is counted once, as a run");
  assert.equal(violatesReadingGrammar(big.words), null);
});

test("an outcome under the smallest move is left alone", () => {
  athlete();
  repo.addActivity({ date: today(), type: "running", distance_km: 1.2, duration_min: 8 });
  const day = dayEnergyTarget(today(), AVERAGE, { today: today() });
  // The week's plan is read as it stood before the week opened, so a first run logged this
  // week plans nothing on the days ahead either.
  assert.equal(day.outcome_shift_kcal, 0);
  assert.deepEqual(day.outcome_work, []);
  assert.equal(day.kcal, AVERAGE);
  assert.equal(day.words, null);
});

test("what was done against what was planned: a clearly different planned run, and no double count", () => {
  const date = today();
  const planned = (km, ran, on = date) => ({ placed_date: on, planned_km: km, completion: { date, distance_km: ran } });
  const base = { date, kg: KG, extras: [], impacts: [], lifted: false, planned: { lifting: false, cross: false } };
  // The planned run, done about as planned, is the plan's and adds nothing.
  assert.equal(dayOutcomeCost({ ...base, intents: [planned(10, 10.5)] }).kcal, 0);
  // 2 km longer but under a quarter of the distance: still the planned run.
  assert.equal(dayOutcomeCost({ ...base, intents: [planned(10, 12)] }).kcal, 0);
  // Clearly longer: costed at the logged distance.
  const longer = dayOutcomeCost({ ...base, intents: [planned(10, 14)] });
  assert.ok(Math.abs(longer.kcal - 4 * KG * RUN_KCAL_PER_KG_KM) < 0.01);
  assert.deepEqual(longer.words, ["the longer run you logged"]);
  // Clearly shorter: costed at the logged distance too.
  const shorter = dayOutcomeCost({ ...base, intents: [planned(20, 14)] });
  assert.ok(Math.abs(shorter.kcal + 6 * KG * RUN_KCAL_PER_KG_KM) < 0.01);
  assert.deepEqual(shorter.words, ["the shorter run you logged"]);
  // A planned run done on another day than the week placed it is extra work on the day it
  // was run, at its logged distance, however close to plan…
  const tomorrow = addDaysISO(date, 1);
  const early = dayOutcomeCost({ ...base, intents: [planned(10, 10, tomorrow)] });
  assert.ok(Math.abs(early.kcal - 10 * KG * RUN_KCAL_PER_KG_KM) < 0.01);
  assert.deepEqual(early.words, ["the run you logged"]);
  // …and its placed day gets nothing from it: that day keeps its plan number.
  const placedDay = { ...base, date: tomorrow };
  assert.equal(dayOutcomeCost({ ...placedDay, intents: [planned(10, 10, tomorrow)] }).kcal, 0);
  // An open run still placed on the day takes a short logged run as itself, not as extra.
  const open = { placed_date: date, planned_km: 8, completion: null };
  assert.equal(dayOutcomeCost({ ...base, intents: [open], extras: [{ date, distance_km: 3 }] }).kcal, 0);
  // A run that closed nothing, on a day with no run planned, is extra.
  assert.ok(
    Math.abs(dayOutcomeCost({ ...base, intents: [], extras: [{ date, distance_km: 5 }] }).kcal - 5 * KG) < 0.01
  );
  // A ride on a day whose plan carried one is the planned session.
  const ride = { date, family: "ride", load: "moderate", duration_min: 60, distance_km: 25 };
  assert.equal(
    dayOutcomeCost({ ...base, intents: [], impacts: [ride], planned: { lifting: false, cross: true } }).kcal,
    0
  );
  // Runs among the logged sessions are the agenda's, never costed again as a session.
  const run = { date, family: "run", load: "moderate", duration_min: 50, distance_km: 10 };
  assert.equal(dayOutcomeCost({ ...base, intents: [], impacts: [run] }).kcal, 0);
  // An everyday walk is daily life; so is any session the load read calls light (yoga,
  // mobility); a short session is too small to cost.
  assert.equal(dayOutcomeCost({ ...base, intents: [], impacts: [{ ...ride, family: "walk", load: "light" }] }).kcal, 0);
  const yoga = { date, type: "yoga", family: "whole_body", load: "light", duration_min: 60, distance_km: null };
  assert.equal(dayOutcomeCost({ ...base, intents: [], impacts: [yoga] }).kcal, 0);
  assert.equal(dayOutcomeCost({ ...base, intents: [], impacts: [{ ...ride, load: "light" }] }).kcal, 0);
  // A real hike is costed at the walking figure, not the riding one.
  const hike = dayOutcomeCost({
    ...base,
    intents: [],
    impacts: [{ ...ride, type: "hiking", family: "walk", load: "moderate" }],
  });
  assert.ok(Math.abs(hike.kcal - KG * WALK_NET_KCAL_PER_KG) < 0.01);
  assert.deepEqual(hike.words, ["the hike you logged"]);
  // A snow-family session is "the skiing" only when its own type says ski.
  const snow = (type) => dayOutcomeCost({ ...base, intents: [], impacts: [{ ...ride, type, family: "snow" }] }).words;
  assert.deepEqual(snow("resort_skiing_snowboarding_ws"), ["the skiing you logged"]);
  assert.deepEqual(snow("ice_skating"), ["the session you logged"]);
  assert.equal(dayOutcomeCost({ ...base, intents: [], impacts: [{ ...ride, duration_min: 15 }] }).kcal, 0);
  // A long ride is costed for three hours at most.
  const long = dayOutcomeCost({ ...base, intents: [], impacts: [{ ...ride, duration_min: 300 }] });
  assert.ok(Math.abs(long.kcal - 3 * KG * CROSS_NET_KCAL_PER_KG) < 0.01);
  // Lifting: extra only when the plan did not carry it.
  assert.equal(
    dayOutcomeCost({ ...base, intents: [], lifted: true, planned: { lifting: true, cross: false } }).kcal,
    0
  );
  assert.ok(Math.abs(dayOutcomeCost({ ...base, intents: [], lifted: true }).kcal - KG * LIFT_NET_KCAL_PER_KG) < 0.01);
  // Planned work not done takes nothing away.
  const notDone = { placed_date: date, planned_km: 12, completion: null };
  assert.equal(dayOutcomeCost({ ...base, intents: [notDone] }).kcal, 0);
});

// Logging a session never re-plans the week: every OTHER day's number is the same before
// and after, whatever the session was.
const weekNumbers = () =>
  Object.fromEntries(weekDates().map((d) => [d, dayEnergyTarget(d, AVERAGE, { today: today() })]));
function assertOthersUnchanged(before, after) {
  for (const date of weekDates()) {
    if (date === today()) continue;
    assert.equal(after[date].kcal, before[date].kcal, `${date} keeps its number`);
    assert.deepEqual(after[date].work, before[date].work, `${date} keeps its work`);
  }
}

test("a ride logged on the named cross-training day is that day's ride: nothing else moves", () => {
  athlete({
    endurance_schedule: { days: [], cross_training: [{ dow: isoDow(today()), sport: "ride" }], source: "athlete" },
  });
  const before = weekNumbers();
  assert.ok(before[today()].work.includes("the ride you named"), before[today()].work.join(", "));
  repo.addActivity({ date: today(), type: "cycling", duration_min: 60 });
  const after = weekNumbers();
  assertOthersUnchanged(before, after);
  assert.equal(after[today()].kcal, before[today()].kcal, "the planned ride is not added again");
  assert.equal(after[today()].outcome_shift_kcal, 0);
  assert.deepEqual(after[today()].outcome_work, []);
});

test("a long ride logged on an ordinary day moves that day alone, as what was logged", () => {
  athlete();
  const before = weekNumbers();
  repo.addActivity({ date: today(), type: "cycling", duration_min: 120 });
  const after = weekNumbers();
  assertOthersUnchanged(before, after);
  const day = after[today()];
  assert.ok(day.outcome_shift_kcal > 0, "the ride raised today");
  assert.ok(day.shift_kcal <= CAP, `inside the cap (${day.shift_kcal})`);
  assert.equal(Math.abs(day.shift_kcal) % 50, 0);
  assert.deepEqual(day.outcome_work, ["the ride you logged"]);
  assert.match(day.words, /for the ride you logged/);
  assert.equal(violatesReadingGrammar(day.words), null);
});

test("logging the lift on a lift weekday changes no day's number: the lift was the plan", () => {
  athlete({
    strength_schedule: {
      days: [{ dow: isoDow(today()) }, { dow: (isoDow(today()) + 3) % 7 }],
      source: "athlete",
      updated_at: today(),
    },
  });
  repo.savePlanDay(1, "Full body", "strength", [{ exercise: "Back Squat", sets: 3, reps: "5" }], {
    day_type: "training",
  });
  const before = weekNumbers();
  assert.ok(before[today()].work.includes("lifting"), before[today()].work.join(", "));
  repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, date: today() });
  const after = weekNumbers();
  assertOthersUnchanged(before, after);
  assert.equal(after[today()].kcal, before[today()].kcal);
  assert.equal(after[today()].outcome_shift_kcal, 0);
});

test("when the cap or the floor already holds the day, the sentence names what produced the move", () => {
  const d = today();
  const up = dayWords({
    date: d,
    today: d,
    kcal: 2460,
    average: 2160,
    plan: 300,
    outcome: 0,
    work: ["the long run"],
    outcomeWork: ["the ride you logged"],
    held: true,
    logged: false,
  });
  assert.equal(
    up,
    "Today's number is about 2,460 kcal: your 2,160 average plus about 300 for the long run and the ride you logged. That is as far up as a day's number goes."
  );
  const down = dayWords({
    date: d,
    today: d,
    kcal: 1860,
    average: 2160,
    plan: -300,
    outcome: 0,
    work: ["the long run"],
    outcomeWork: ["the shorter run you logged"],
    held: true,
    logged: false,
  });
  assert.match(
    down,
    /less about 300, with the long run planned and the shorter run you logged\. A day's number does not go lower than that\.$/
  );
  for (const words of [up, down]) assert.equal(violatesReadingGrammar(words), null, words);
});

test("a day already lived this week reads in one tense", () => {
  const d = today();
  const yesterday = addDaysISO(d, -1);
  const lighter = dayWords({
    date: yesterday,
    today: d,
    kcal: 1910,
    average: 2160,
    plan: -250,
    outcome: 0,
    work: [],
    outcomeWork: [],
    held: false,
    logged: false,
  });
  assert.equal(
    lighter,
    "That day's number was about 1,910 kcal: your 2,160 average less about 250, a lighter day. That room went to the week's bigger days."
  );
  const bigger = dayWords({
    date: yesterday,
    today: d,
    kcal: 2460,
    average: 2160,
    plan: 300,
    outcome: 0,
    work: ["the long run"],
    outcomeWork: [],
    held: false,
    logged: false,
  });
  assert.equal(
    bigger,
    "That day's number was about 2,460 kcal: your 2,160 average plus about 300 for the long run. The week still averaged 2,160."
  );
  const moved = dayWords({
    date: yesterday,
    today: d,
    kcal: 2360,
    average: 2160,
    plan: 0,
    outcome: 200,
    work: [],
    outcomeWork: ["the ride you logged"],
    held: false,
    logged: false,
  });
  assert.match(moved, /^That day's number was about 2,360 kcal: .* The rest of the week kept its numbers\.$/);
  const ahead = dayWords({
    date: addDaysISO(d, 1),
    today: d,
    kcal: 2460,
    average: 2160,
    plan: 300,
    outcome: 0,
    work: ["the long run"],
    outcomeWork: ["x"],
    held: true,
    logged: false,
  });
  assert.match(ahead, /^This day's number is about .* That is as far up as a day's number goes\.$/);
});

// ---- the week's plan holds still within the week ----
// A fixed week, so nothing here depends on the real weekday: MONDAY is a Monday.
const MONDAY = "2026-06-15";
const at = (i) => addDaysISO(MONDAY, i);
const fixedWeek = (todayIso) =>
  Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => [at(i), dayEnergyTarget(at(i), AVERAGE, { today: todayIso })])
  );
function assertSame(before, after, dates) {
  for (const date of dates) {
    assert.equal(after[date].kcal, before[date].kcal, `${date} keeps its number`);
    assert.deepEqual(after[date].work, before[date].work, `${date} keeps its work`);
  }
}
function fixedAthlete(extra = {}) {
  repo.setProfile({
    age: 44,
    height_cm: 170,
    weight_lb: 153,
    sex: "male",
    activity_factor: 1.55,
    goal_mode: "lose",
    ...extra,
  });
  repo.logWeight(153, at(-10));
}
function lastWeekRuns() {
  repo.addActivity({ date: at(-6), type: "running", distance_km: 6, duration_min: 36 });
  repo.addActivity({ date: at(-4), type: "running", distance_km: 8, duration_min: 45 });
  repo.addActivity({ date: at(-2), type: "running", distance_km: 12, duration_min: 72 });
}
const STATED_RUNS = {
  days: [
    { dow: 2, kind: "easy" },
    { dow: 4, kind: "quality" },
    { dow: 6, kind: "long" },
  ],
  source: "athlete",
};

test("with stated run days, a run logged on Tuesday leaves Wednesday to Sunday exactly as planned", () => {
  fixedAthlete({ endurance_schedule: STATED_RUNS });
  lastWeekRuns();
  const wednesday = at(2);
  const before = fixedWeek(wednesday);
  assert.ok(before[at(5)].work.includes("the long run"), before[at(5)].work.join(", "));
  repo.addActivity({ date: at(1), type: "running", distance_km: 9, duration_min: 50 });
  const after = fixedWeek(wednesday);
  assertSame(before, after, [at(2), at(3), at(4), at(5), at(6)]);
  assert.equal(
    after[at(1)].shift_kcal - after[at(1)].outcome_shift_kcal,
    before[at(1)].shift_kcal,
    "Tuesday's plan part holds"
  );
  assert.equal(
    Object.values(after).reduce((sum, d) => sum + (d.shift_kcal - d.outcome_shift_kcal), 0),
    0,
    "the plan still sums to zero"
  );
});

test("with no stated run days, a run logged on Tuesday leaves Wednesday to Sunday exactly as planned", () => {
  fixedAthlete();
  lastWeekRuns();
  const wednesday = at(2);
  const before = fixedWeek(wednesday);
  assert.ok(
    Object.values(before).some((d) => d.work.some((w) => /run/.test(w))),
    "the engine planned runs"
  );
  repo.addActivity({ date: at(1), type: "running", distance_km: 9, duration_min: 50 });
  repo.addActivity({ date: at(2), type: "running", distance_km: 5, duration_min: 30 });
  const after = fixedWeek(wednesday);
  assertSame(before, after, [at(3), at(4), at(5), at(6)]);
  for (const date of [at(1), at(2)]) {
    assert.equal(
      after[date].shift_kcal - after[date].outcome_shift_kcal,
      before[date].shift_kcal,
      `${date}'s plan part holds`
    );
  }
});

test("with no run week at the week's start, a first run is an outcome on its own day and plans nothing", () => {
  fixedAthlete();
  const wednesday = at(2);
  repo.addActivity({ date: at(1), type: "running", distance_km: 8, duration_min: 45 });
  const after = fixedWeek(wednesday);
  for (const date of [at(0), at(2), at(3), at(4), at(5), at(6)]) {
    assert.equal(after[date].kcal, AVERAGE, `${date} keeps the average`);
  }
  const tuesday = after[at(1)];
  assert.equal(tuesday.outcome_shift_kcal, Math.min(CAP_STEPS, fifty(8 * KG * RUN_KCAL_PER_KG_KM * DAY_SHIFT_SHARE)));
  assert.deepEqual(tuesday.outcome_work, ["the run you logged"]);
  assert.match(
    tuesday.words,
    /^That day's number was about [\d,]+ kcal: your 2,160 average plus about \d+ for the run you logged\. The rest of the week kept its numbers\.$/
  );
});

test("a planned run done a day early: its placed day keeps its number, the day it was run gets the outcome", () => {
  fixedAthlete({
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 6, kind: "long" },
      ],
      source: "athlete",
    },
  });
  lastWeekRuns();
  const saturday = at(5);
  const before = fixedWeek(saturday);
  assert.ok(before[saturday].work.includes("the long run"), before[saturday].work.join(", "));
  repo.addActivity({ date: at(4), type: "running", distance_km: 14, duration_min: 80 });
  const after = fixedWeek(saturday);
  assertSame(before, after, [at(0), at(1), at(2), at(3), at(5), at(6)]);
  assert.equal(after[saturday].outcome_shift_kcal, 0, "the placed day gets nothing from it");
  const friday = after[at(4)];
  assert.ok(friday.outcome_shift_kcal > 0, `Friday took the run (${friday.outcome_shift_kcal})`);
  assert.equal(friday.outcome_shift_kcal % 50, 0);
  assert.ok(friday.shift_kcal <= CAP_STEPS);
  assert.deepEqual(friday.outcome_work, ["the run you logged"]);
});

test("a lift logged on a new weekday this week does not change which weekdays count as lifting", () => {
  fixedAthlete();
  // Monday and Thursday three weeks running; Wednesday two weeks, one short of the pattern.
  for (const week of [-7, -14, -21]) {
    repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, date: at(week) });
    repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, date: at(week + 3) });
  }
  for (const week of [-7, -14])
    repo.logSetByName({ exercise: "Bench Press", weight: 135, reps: 5, date: at(week + 2) });
  const wednesday = at(2);
  const before = fixedWeek(wednesday);
  const liftDays = (week) => Object.keys(week).filter((d) => week[d].work.includes("lifting"));
  assert.deepEqual(liftDays(before), [at(0), at(3)]);
  // This Wednesday would be the third: the week's lifting weekdays are read as it opened.
  repo.logSetByName({ exercise: "Bench Press", weight: 135, reps: 5, date: wednesday });
  const after = fixedWeek(wednesday);
  assert.deepEqual(liftDays(after), [at(0), at(3)]);
  assertSame(before, after, [at(0), at(1), at(3), at(4), at(5), at(6)]);
  assert.equal(after[wednesday].shift_kcal - after[wednesday].outcome_shift_kcal, before[wednesday].shift_kcal);
  assert.deepEqual(after[wednesday].outcome_work, ["the lifting you logged"]);
});
