// Day-specific fuel demand (src/repo/fuel-demand.ts).
//
// The gap: nothing connected the week's HARDEST days to that day's fuel. The pace
// gauge grades protein within a day and the nutrition guidance said "carb-forward
// around training" without naming a single day, so on a cut the long-run day and the
// heavy-lower day got the same flat number as a rest day. These tests pin the read
// that closes it — and, just as importantly, pin what it must NEVER do: invent a
// demand out of missing data, or carry a target of its own.
//
// Deterministic + offline: the run plan and "today" are injected (mirroring
// flexibleTrainingAgenda's own runPlan override and dayFuelState's `now`), so no case
// depends on the wall clock or on a seeded endurance goal.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedTrainingDay } from "./_seed.js";
import { carbRangeForTier, dayFuelDemand, fuelDemandWeek } from "../dist/repo/fuel-demand.js";
import { PROMPT_CONTEXT_SITES, projectCoachContext } from "../dist/prompt/context-projection.js";
import { buildMealPlanPrompt, buildMealSwapPrompt, buildNutritionCheckinPrompt } from "../dist/prompt.js";
import { localDateISO } from "../dist/repo/shared.js";

const MONDAY = "2026-04-20";
const TUESDAY = "2026-04-21";
const WEDNESDAY = "2026-04-22";
const SATURDAY = "2026-04-25";

function run(day_number, kind, km = 6) {
  return {
    day_number,
    label: kind === "quality" ? "Tempo run" : kind === "long" ? "Long run" : "Easy run",
    kind_label: kind,
    target_distance_km: km,
    target_duration_min: null,
    target_zone: kind === "quality" ? "Z3" : "Z2",
    note: null,
    day_name: `${kind} run`,
    focus: "Endurance",
    interval: null,
  };
}

function runWeek(runs) {
  return {
    available: true,
    week_start: MONDAY,
    runs,
    rationale: [],
    quality_focus: runs.some((item) => item.kind_label === "quality") ? "Tempo run" : null,
    mix_summary: "flexible test week",
    why: "A movable test week.",
  };
}

// day 1 = Monday (heavy lower), day 2 = Tuesday (upper). The plan's day_number →
// weekday convention is Monday-anchored and wraps, which two plan days is enough to
// exercise without the wrap making every day identical.
function seedSplit() {
  repo.savePlanDay(1, "Lower", "Lower", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 8 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10 },
  ]);
  repo.savePlanDay(2, "Pull", "Pull", [{ exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12 }]);
}

function reset() {
  resetTables(
    "logged_sets",
    "sessions",
    "activities",
    "garmin_activities",
    "garmin_sources",
    "exercises",
    "plan_items",
    "plan_days",
    "daily_metrics",
    "garmin_daily_metrics",
    "program_blocks",
    "app_state",
    "profile"
  );
}
beforeEach(reset);

// ── each driver earns "big" ──────────────────────────────────────────────────

test("the long-run day reads big, and names the long run as the driver", () => {
  const read = dayFuelDemand(WEDNESDAY, { today: MONDAY, runPlan: runWeek([run(3, "long", 18)]) });
  assert.equal(read.demand, "big");
  assert.ok(
    read.drivers.some((driver) => driver.includes("long run")),
    `drivers should name the long run (got ${JSON.stringify(read.drivers)})`
  );
  assert.ok(read.evidence.includes("flexible_training_agenda"), "the agenda is named as the input it came from");
});

test("a quality-run day reads big", () => {
  const read = dayFuelDemand(WEDNESDAY, { today: MONDAY, runPlan: runWeek([run(3, "quality", 8)]) });
  assert.equal(read.demand, "big");
  assert.ok(read.drivers.some((driver) => driver.includes("quality run")));
});

test("a heavy lower-body plan day reads big; the upper day beside it does not", () => {
  seedSplit();
  const lower = dayFuelDemand(MONDAY, { today: MONDAY, runPlan: null });
  assert.equal(lower.demand, "big");
  assert.ok(lower.drivers.some((driver) => driver.includes("heavy lower")));

  const upper = dayFuelDemand(TUESDAY, { today: MONDAY, runPlan: null });
  assert.equal(upper.demand, "standard", `an upper day is ordinary (got ${JSON.stringify(upper)})`);
  assert.deepEqual(upper.drivers, []);
});

test("a strength day that also carries a run reads big as a double", () => {
  seedSplit();
  // The easy run anchors to day_number 2 → Tuesday, which is the (non-lower) pull day.
  const read = dayFuelDemand(TUESDAY, { today: MONDAY, runPlan: runWeek([run(2, "easy", 6)]) });
  assert.equal(read.demand, "big");
  assert.ok(
    read.drivers.some((driver) => driver.includes("same day")),
    `the double is the driver, not the leg day (got ${JSON.stringify(read.drivers)})`
  );
  assert.ok(!read.drivers.some((driver) => driver.includes("heavy lower")));
});

test("work actually logged today can make the day big on its own", () => {
  seedTrainingDay(TUESDAY);
  repo.addActivity({ type: "run", date: TUESDAY, duration_min: 40, distance_km: 7 });
  const read = dayFuelDemand(TUESDAY, { today: TUESDAY, runPlan: null });
  assert.equal(read.demand, "big");
  assert.ok(read.drivers.some((driver) => driver.includes("same day")));
  assert.ok(read.evidence.includes("logged_sessions") && read.evidence.includes("logged_activities"));
});

// ── absence is neutral, and rest is rest ─────────────────────────────────────

test("no plan, no run week and nothing logged reads standard — absence is never a demand", () => {
  const read = dayFuelDemand(WEDNESDAY, { today: MONDAY, runPlan: null });
  assert.equal(read.demand, "standard");
  assert.deepEqual(read.drivers, []);
  assert.deepEqual(read.evidence, [], "nothing was present, and the read says so rather than implying a source");
});

// Rest is the CALENDAR's (migration 110): a weekday with no lifting and no run. A rest
// plan row cannot be written any more, so the rest day is a weekday the stated lifting
// week leaves open.
test("a calendar rest day reads light, but a lifting day never does", () => {
  repo.savePlanDay(1, "Lower", "Lower", [{ exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 8 }]);
  repo.setProfile({ strength_schedule: { days: [{ dow: 1 }], source: "athlete" } });
  assert.equal(dayFuelDemand(TUESDAY, { today: MONDAY, runPlan: null }).demand, "light");
  assert.equal(dayFuelDemand(MONDAY, { today: MONDAY, runPlan: null }).demand, "big");
});

test("with no lifting week known no day is ever called light — absence stays neutral", () => {
  repo.savePlanDay(1, "Lower", "Lower", [{ exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 8 }]);
  assert.notEqual(dayFuelDemand(TUESDAY, { today: MONDAY, runPlan: null }).demand, "light");
});

test("a calendar rest day that a run intention lands on is not light", () => {
  repo.savePlanDay(1, "Lower", "Lower", [{ exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 8 }]);
  repo.setProfile({ strength_schedule: { days: [{ dow: 1 }], source: "athlete" } });
  const read = dayFuelDemand(TUESDAY, { today: MONDAY, runPlan: runWeek([run(2, "easy", 6)]) });
  assert.notEqual(read.demand, "light");
});

test("a past week's run intentions are never re-placed onto days that are already over", () => {
  // The agenda would happily re-suggest an unfinished intention; a lived day is
  // described by what was actually logged, never by what was once suggested for it.
  const read = dayFuelDemand(WEDNESDAY, { today: "2026-05-06", runPlan: runWeek([run(3, "long", 18)]) });
  assert.deepEqual(read.drivers, []);
  assert.ok(!read.evidence.includes("flexible_training_agenda"));
});

// ── the week map ─────────────────────────────────────────────────────────────

test("the week map covers seven consecutive days and marks only the day that carries the work", () => {
  const week = fuelDemandWeek(MONDAY, 7, { today: MONDAY, runPlan: runWeek([run(6, "long", 18)]) });
  assert.equal(week.days.length, 7);
  assert.equal(week.as_of, MONDAY);
  assert.equal(week.through, "2026-04-26");
  assert.deepEqual(
    week.days.map((day) => day.date),
    [MONDAY, TUESDAY, WEDNESDAY, "2026-04-23", "2026-04-24", SATURDAY, "2026-04-26"]
  );
  const big = week.days.filter((day) => day.demand === "big");
  assert.equal(big.length, 1, `exactly one big day (got ${JSON.stringify(week.days)})`);
  assert.equal(big[0].date, SATURDAY);
});

test("the read never carries a calorie target of its own", () => {
  seedSplit();
  const week = fuelDemandWeek(MONDAY, 7, { today: MONDAY, runPlan: runWeek([run(6, "long", 18)]) });
  const serialized = JSON.stringify(week);
  assert.ok(!/kcal|calorie|target_kcal|protein_g/i.test(serialized), `no target anywhere in ${serialized}`);
});

// ── the prompt boundary ──────────────────────────────────────────────────────

test("fuel_demand reaches exactly the sites that plan or read a day's food", () => {
  const allowed = new Set(["meal_plan", "day_read"]);
  for (const [site, spec] of Object.entries(PROMPT_CONTEXT_SITES)) {
    const carries = spec.keys.includes("fuel_demand");
    assert.equal(carries, allowed.has(site), `${site} should ${allowed.has(site) ? "carry" : "not carry"} fuel_demand`);
  }
});

// A single heavy-lower plan day wraps onto every weekday, so "today" is a big day
// whatever day the suite runs — the prompts below can then be checked against the
// real getCoachContext() without pinning the wall clock.
function seedBigToday() {
  repo.savePlanDay(1, "Lower", "Lower", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 8 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10 },
  ]);
}

test("the coach context carries the week's demand, and the meal plan is told to read it", () => {
  seedBigToday();
  const ctx = repo.getCoachContext();
  assert.equal(ctx.fuel_demand?.days?.length, 7);
  assert.equal(ctx.fuel_demand.days[0].demand, "big");

  const prompt = buildMealPlanPrompt();
  assert.match(prompt, /DATA\.fuel_demand names WHICH days those are/);
  assert.match(prompt, /"fuel_demand":/, "and the DATA block actually carries it");
  assert.match(prompt, /never a reason to change the accepted daily target/i);
});

test("the check-in gets today and tomorrow as a rendered block, never a target of its own", () => {
  seedBigToday();
  const prompt = buildNutritionCheckinPrompt();
  assert.match(prompt, /DAY-SPECIFIC FUEL DEMAND/);
  assert.match(prompt, /\(today\)/);
  assert.match(prompt, /\(tomorrow\)/);
  assert.match(prompt, /never a retrospective judgement/i);
});

test("the check-in stays silent when no day in view carries bigger work", () => {
  const prompt = buildNutritionCheckinPrompt();
  assert.doesNotMatch(prompt, /DAY-SPECIFIC FUEL DEMAND/);
});

test("the meal swap sees the demand for the day it is swapping inside, and only that day", () => {
  seedBigToday();
  const today = localDateISO();
  const shortDay = new Date(`${today}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const plan = { parsed: { days: [{ day: shortDay, meals: [{ name: "Rice bowl", kcal: 700, protein_g: 45 }] }] } };
  const matched = buildMealSwapPrompt({ plan, day: shortDay, mealIndex: 0 });
  assert.match(matched, /DAY-SPECIFIC FUEL DEMAND/);
  assert.match(matched, new RegExp(today));

  // A day the read's window does not cover says nothing rather than describing
  // some other day's work.
  const unmatched = buildMealSwapPrompt({
    plan: { parsed: { days: [{ day: "Someday", meals: [{ name: "Rice bowl" }] }] } },
    day: "Someday",
    mealIndex: 0,
  });
  assert.doesNotMatch(unmatched, /DAY-SPECIFIC FUEL DEMAND/);
});

test("the projection copies fuel_demand through untouched where it is allowed", () => {
  const week = fuelDemandWeek(MONDAY, 7, { today: MONDAY, runPlan: runWeek([run(6, "long", 18)]) });
  const ctx = { fuel_demand: week };
  assert.deepEqual(projectCoachContext(ctx, "meal_plan").fuel_demand, week);
  assert.deepEqual(projectCoachContext(ctx, "day_read").fuel_demand, week);
  assert.equal(projectCoachContext(ctx, "coach").fuel_demand, undefined);
  assert.equal(projectCoachContext(ctx, "insight").fuel_demand, undefined);
});

// ── carbohydrate periodised to the work ─────────────────────────────────────

test("with no target to fit into, a day's carbs are the published ACSM/IOC band for its work", () => {
  const basis = { weight_kg: 70, target_kcal: null, protein_g: null };
  assert.deepEqual(carbRangeForTier("light", basis).grams, { low: 210, high: 350 });
  assert.deepEqual(carbRangeForTier("moderate", basis).grams, { low: 350, high: 490 });
  const big = carbRangeForTier("high", basis);
  assert.deepEqual(big.grams, { low: 420, high: 700 });
  assert.deepEqual(big.g_per_kg, { low: 6, high: 10 });
  assert.equal(big.tier, "high");
  assert.equal(big.basis, "band");
  assert.equal(carbRangeForTier("high", null), null, "no bodyweight, no range");
});

test("inside a cut's target the ranges flex with the work, protein held and fat inside its band", () => {
  const basis = { weight_kg: 73, target_kcal: 2400, protein_g: 175 };
  const light = carbRangeForTier("light", basis);
  const moderate = carbRangeForTier("moderate", basis);
  const big = carbRangeForTier("high", basis);
  for (const range of [light, moderate, big]) assert.equal(range.basis, "within_target");
  // Ordered by the work, never overlapping upward.
  assert.ok(light.grams.high <= moderate.grams.low + 5 && moderate.grams.high <= big.grams.low + 5);
  // The big day holds at most what the target does with fat at its 20% floor…
  assert.ok(big.grams.high <= (2400 * 0.8 - 175 * 4) / 4 + 2.5);
  // …and the light day never asks fat past its 35% ceiling.
  assert.ok(light.grams.low >= (2400 * 0.65 - 175 * 4) / 4 - 2.5);
  // And no day is ever told more than its published band.
  const surplus = carbRangeForTier("light", { weight_kg: 60, target_kcal: 4000, protein_g: 120 });
  assert.ok(surplus.grams.high <= 5 * 60);
});

test("with a carb basis every day carries its range: endurance work earns the high band, strength the moderate", () => {
  seedSplit();
  // Lifting Monday and Tuesday: Wednesday is the calendar's rest day.
  repo.setProfile({ strength_schedule: { days: [{ dow: 1 }, { dow: 2 }], source: "athlete" } });
  const basis = { weight_kg: 73, target_kcal: 2400, protein_g: 175 };
  const opts = { today: MONDAY, runPlan: runWeek([run(4, "long", 18)]), carbBasis: basis };
  // A heavy lower day is big for the demand line, but ~1 h of lifting is the moderate band.
  const lower = dayFuelDemand(MONDAY, opts);
  assert.equal(lower.demand, "big");
  assert.equal(lower.carbs.tier, "moderate");
  assert.equal(dayFuelDemand(WEDNESDAY, opts).carbs.tier, "light");
  assert.equal(dayFuelDemand("2026-04-23", opts).carbs.tier, "high", "the long-run day");
  assert.equal(dayFuelDemand(MONDAY, { today: MONDAY, runPlan: null }).carbs, undefined, "no basis, no grams");
});

test("a long ride already logged makes the day big; a short commute does not", () => {
  repo.addActivity({ type: "cycling", date: TUESDAY, duration_min: 115, distance_km: 30 });
  const long = dayFuelDemand(TUESDAY, { today: TUESDAY, runPlan: null });
  assert.equal(long.demand, "big");
  assert.ok(long.drivers.some((driver) => driver.includes("long ride")));
  reset();
  repo.addActivity({ type: "cycling", date: TUESDAY, duration_min: 38, distance_km: 12 });
  assert.equal(dayFuelDemand(TUESDAY, { today: TUESDAY, runPlan: null }).demand, "standard");
});

test("the check-in names the day's carb range from the coach context, as shape and never a new target", () => {
  seedBigToday();
  repo.setProfile({
    sex: "male",
    age: 40,
    height_in: 70,
    weight_lb: 161,
    goal_weight_lb: 154,
    goal_mode: "lose",
    activity_factor: 1.5,
  });
  const ctx = repo.getCoachContext();
  assert.equal(ctx.fuel_demand.days[0].carbs?.basis, "within_target");
  const prompt = buildNutritionCheckinPrompt();
  assert.match(prompt, /carbs \d+–\d+ g \([\d.]+–[\d.]+ g\/kg\)/);
  assert.match(prompt, /never a new target, and never a measure of what was or wasn't eaten/);
});
