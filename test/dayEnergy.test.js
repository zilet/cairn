// The DAY's energy number (repo/day-energy.ts): the accepted target is the week's average,
// and each day of the current week moves around it with the planned work. Protein never
// moves, a week already over is shaped from what was logged, nothing planned moves
// nothing, and a clear departure from the plan today moves today alone.
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

test("a week already over with nothing logged keeps the average", () => {
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

const KG = 153 / LB_PER_KG;
const CAP = AVERAGE * DAY_SHIFT_CAP_SHARE;
const tens = (n) => Math.round(n / 10) * 10;

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
    assert.ok(Math.abs(d.shift_kcal) <= CAP + 10, `${d.date} stays inside the cap`);
    if (d.words) {
      assert.equal(violatesReadingGrammar(d.words), null, d.words);
      assert.match(d.words, /^That day's number was about [\d,]+ kcal: your 2,160 average/);
    }
  }
  const drift = days.reduce((sum, d) => sum + d.shift_kcal, 0);
  assert.ok(Math.abs(drift) <= 40, `the week stays on its average (drift ${drift})`);
});

test("an unplanned ride today adds half its cost to today alone, said plainly", () => {
  athlete();
  repo.addActivity({ date: today(), type: "cycling", duration_min: 60 });
  const day = dayEnergyTarget(today(), AVERAGE, { today: today() });
  const expected = tens(KG * CROSS_NET_KCAL_PER_KG * DAY_SHIFT_SHARE);
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
  assert.ok(big.shift_kcal <= CAP + 10, `the day's whole move stays inside the cap (${big.shift_kcal})`);
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
  // Only the outcome is asserted: early in a week one logged run lets the agenda suggest
  // runs on the days still ahead, and that plan moves today's number on its own.
  assert.equal(day.outcome_shift_kcal, 0);
  assert.deepEqual(day.outcome_work, []);
  assert.equal(day.kcal, AVERAGE + day.shift_kcal);
  assert.doesNotMatch(day.words ?? "", /you logged/);
});

test("what was done against what was planned: a clearly different planned run, and no double count", () => {
  const date = today();
  const planned = (km, ran) => ({
    status: "completed",
    suggested_date: null,
    planned_distance_km: km,
    target_distance_km: km,
    completion: { date, distance_km: ran },
  });
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
  // An open run still placed on the day takes a short logged run as itself, not as extra.
  const open = { status: "open", suggested_date: date, planned_distance_km: 8, target_distance_km: 8, completion: null };
  assert.equal(dayOutcomeCost({ ...base, intents: [open], extras: [{ date, distance_km: 3 }] }).kcal, 0);
  // A run that closed nothing, on a day with no run planned, is extra.
  assert.ok(Math.abs(dayOutcomeCost({ ...base, intents: [], extras: [{ date, distance_km: 5 }] }).kcal - 5 * KG) < 0.01);
  // A ride on a day whose plan carried one is the planned session.
  const ride = { date, family: "ride", load: "moderate", duration_min: 60, distance_km: 25 };
  assert.equal(dayOutcomeCost({ ...base, intents: [], impacts: [ride], planned: { lifting: false, cross: true } }).kcal, 0);
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
  const hike = dayOutcomeCost({ ...base, intents: [], impacts: [{ ...ride, type: "hiking", family: "walk", load: "moderate" }] });
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
  assert.equal(dayOutcomeCost({ ...base, intents: [], lifted: true, planned: { lifting: true, cross: false } }).kcal, 0);
  assert.ok(Math.abs(dayOutcomeCost({ ...base, intents: [], lifted: true }).kcal - KG * LIFT_NET_KCAL_PER_KG) < 0.01);
  // Planned work not done takes nothing away.
  const notDone = { status: "open", suggested_date: date, planned_distance_km: 12, target_distance_km: 12, completion: null };
  assert.equal(dayOutcomeCost({ ...base, intents: [notDone] }).kcal, 0);
});

// Logging a session never re-plans the week: every OTHER day's number is the same before
// and after, whatever the session was.
const weekNumbers = () => Object.fromEntries(weekDates().map((d) => [d, dayEnergyTarget(d, AVERAGE, { today: today() })]));
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
  assert.ok(day.shift_kcal <= CAP + 10, `inside the cap (${day.shift_kcal})`);
  assert.deepEqual(day.outcome_work, ["the ride you logged"]);
  assert.match(day.words, /for the ride you logged/);
  assert.equal(violatesReadingGrammar(day.words), null);
});

test("logging the lift on a lift weekday changes no day's number: the lift was the plan", () => {
  athlete({ strength_schedule: { days: [{ dow: isoDow(today()) }, { dow: (isoDow(today()) + 3) % 7 }], source: "athlete", updated_at: today() } });
  repo.savePlanDay(1, "Full body", "strength", [{ exercise: "Back Squat", sets: 3, reps: "5" }], { day_type: "training" });
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
    kcal: 2480,
    average: 2160,
    plan: 320,
    outcome: 0,
    work: ["the long run"],
    outcomeWork: ["the ride you logged"],
    held: true,
    logged: false,
  });
  assert.equal(
    up,
    "Today's number is about 2,480 kcal: your 2,160 average plus about 320 for the long run and the ride you logged. That is as far up as a day's number goes."
  );
  const down = dayWords({
    date: d,
    today: d,
    kcal: 1840,
    average: 2160,
    plan: -320,
    outcome: 0,
    work: ["the long run"],
    outcomeWork: ["the shorter run you logged"],
    held: true,
    logged: false,
  });
  assert.match(down, /less about 320, with the long run planned and the shorter run you logged\. A day's number does not go lower than that\.$/);
  for (const words of [up, down]) assert.equal(violatesReadingGrammar(words), null, words);
});
