// A weekly meal plan that follows each DAY's energy number (repo/meal-plan-day-energy.ts).
//
// The accepted target stays the week's AVERAGE on `daily_kcal`; the plan's days carry the
// server's own split, stored once at the drafting op and re-derived onto each day on every
// write. These tests pin what that must and must never do: the prompt carries the table,
// a plan sized to its days passes every floor, a flat plan on a clearly moved day is
// flagged, an old plan reads exactly as before, and no floor ever loosens.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, localDaysAgo, resetTables } from "./_seed.js";
import {
  applyMealPlanDayEnergy,
  mealPlanDayKcalFor,
  mealPlanDayKcalTargets,
  projectMealPlanDayEnergy,
  readMealPlanDayEnergy,
  shapeMealPlanDayEnergy,
} from "../dist/repo/meal-plan-day-energy.js";
import { validateMealPlanForPersistence } from "../dist/repo/nutrition.js";
import { computeMealPlanDayEnergy, draftMealPlanDayEnergy } from "../dist/repo/meal-plan-day-energy-compute.js";
import { dayEnergyTarget } from "../dist/repo/day-energy.js";
import { mealPlanFloorPrecheck, mealPlanFloorViolations } from "../dist/repo/verify-floors.js";
import { assessMealPlanAdequacy } from "../dist/repo/nutrition-safety.js";
import { buildMealPlanPrompt, renderMealPlanDayEnergy } from "../dist/prompt.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const AVERAGE = 2200;
const PROTEIN = 170;
const REFS = { kcalFloor: AVERAGE, proteinFloor: PROTEIN, fiberFloor: 30 };
const LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const label = (iso) => LABELS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
const datesFrom = (from) => Array.from({ length: 7 }, (_, i) => addDaysISO(from, i));

// The server's split for the seven food days from `from`: two lighter days and one long-run
// day, summing to zero shift so the week stays on its average.
function energy(from = addDaysISO(localDateISO(), 1), { floor = 1500, light = -150, big = 300 } = {}) {
  const dates = datesFrom(from);
  const day = (date, shift, why) => ({
    date,
    weekday: label(date).toLowerCase(),
    kcal: AVERAGE + shift,
    shift_kcal: shift,
    why,
  });
  return {
    version: 1,
    average_kcal: AVERAGE,
    floor_kcal: floor,
    from,
    days: [
      day(dates[0], light, "a lighter day"),
      day(dates[2], light, "a lighter day"),
      day(dates[5], big, "the long run"),
    ],
  };
}

// A week labelled by weekday in calendar order, one meal carrying each day. `kcal` maps a
// date to that day's total (default: the headline).
function week({ from = addDaysISO(localDateISO(), 1), kcal = {}, protein = PROTEIN, dayEnergy } = {}) {
  return {
    daily_kcal: AVERAGE,
    daily_protein_g: PROTEIN,
    daily_fiber_g: 30,
    days: datesFrom(from).map((date) => ({
      day: label(date),
      meals: [
        {
          name: "Lentil rice bowl",
          items: "lentils, brown rice, spinach",
          kcal: kcal[date] ?? AVERAGE,
          protein_g: protein,
          carbs_g: 250,
          fat_g: 70,
          fiber_g: 30,
        },
      ],
    })),
    shopping: ["lentils", "brown rice", "spinach"],
    ...(dayEnergy ? { day_energy: dayEnergy } : {}),
  };
}

// A week sized to the split's own numbers.
function sizedWeek(split, { kcal: extra = {}, ...rest } = {}) {
  const kcal = Object.fromEntries(split.days.map((d) => [d.date, d.kcal]));
  return week({ from: split.from, ...rest, kcal: { ...kcal, ...extra }, dayEnergy: split });
}

const codes = (violations) => violations.map((v) => v.code);

beforeEach(() => {
  resetTables("meal_plans", "food_notes", "nutrition_targets", "profile", "bodyweight_log", "plan_items", "plan_days");
});

// ------------------------------------------------------------- the split itself

test("a day under the floor is raised to it and the bigger days pay for it, so the week keeps its average", () => {
  const from = addDaysISO(localDateISO(), 1);
  const dates = datesFrom(from);
  const raw = dates.map((date, i) => ({
    date,
    kcal: i === 5 ? 2700 : i === 0 || i === 2 ? 1950 : 2200,
    work: i === 5 ? ["the long run"] : [],
  }));
  const split = shapeMealPlanDayEnergy({ from, average: AVERAGE, floor: 2050, days: raw });
  assert.ok(split, "the week moved");
  const kcalOn = (date) => split.days.find((d) => d.date === date)?.kcal ?? AVERAGE;
  assert.equal(kcalOn(dates[0]), 2050, "a lighter day stops at the floor");
  assert.equal(kcalOn(dates[2]), 2050);
  assert.equal(kcalOn(dates[5]), 2500, "the long-run day gives back what the floor cost");
  const total = dates.reduce((sum, date) => sum + kcalOn(date), 0);
  assert.equal(total, 7 * AVERAGE, "the week still averages the accepted target");
  for (const day of split.days) assert.equal(violatesReadingGrammar(day.why), null, day.why);
});

test("a window straddling two unbalanced weeks is re-centred on the average, both ways, to within 10 kcal", () => {
  const from = addDaysISO(localDateISO(), 1);
  const dates = datesFrom(from);
  const total = (split, average) =>
    dates.reduce((sum, date) => sum + (split.days.find((d) => d.date === date)?.kcal ?? average), 0);
  // Over: two bigger days from different weeks, every other day a little under.
  const over = shapeMealPlanDayEnergy({
    from,
    average: AVERAGE,
    floor: 1500,
    days: dates.map((date, i) => ({
      date,
      kcal: i === 0 ? 2500 : i === 5 ? 2600 : 2150,
      work: i === 0 || i === 5 ? ["lifting"] : [],
    })),
  });
  assert.ok(
    Math.abs(total(over, AVERAGE) - 7 * AVERAGE) <= 10,
    `over-full window re-centred (${total(over, AVERAGE)})`
  );
  const kcalOn = (split, date) => split.days.find((d) => d.date === date)?.kcal ?? AVERAGE;
  assert.ok(
    kcalOn(over, dates[0]) > AVERAGE && kcalOn(over, dates[5]) > kcalOn(over, dates[0]),
    "the bigger days stay bigger"
  );
  assert.equal(kcalOn(over, dates[1]), 2150, "a lighter day is not touched by an over-full window");
  // Under: two lighter days and one small bump.
  const under = shapeMealPlanDayEnergy({
    from,
    average: AVERAGE,
    floor: 1500,
    days: dates.map((date, i) => ({ date, kcal: i === 1 || i === 2 ? 2000 : i === 5 ? 2300 : 2200 })),
  });
  assert.ok(Math.abs(total(under, AVERAGE) - 7 * AVERAGE) <= 10);
  assert.equal(kcalOn(under, dates[1]), 2150);
  assert.equal(kcalOn(under, dates[5]), 2300, "a bigger day is not touched by a short window");
  // An average that is not a round ten: days at it are not "moved", and the window still sums right.
  const odd = shapeMealPlanDayEnergy({
    from,
    average: 2213,
    floor: 1500,
    days: dates.map((date, i) => ({ date, kcal: i === 0 ? 2480 : i === 1 ? 2000 : 2213 })),
  });
  assert.ok(Math.abs(total(odd, 2213) - 7 * 2213) <= 10, `odd average re-centred (${total(odd, 2213)})`);
  assert.ok(
    odd.days.every((d) => Math.abs(d.shift_kcal) >= 10),
    "no 3 kcal non-moves"
  );
  for (const split of [over, under, odd]) for (const day of split.days) assert.ok(day.kcal >= 1500);
});

test("a split held to a higher live floor raises its lighter days and the bigger days pay it back", () => {
  const split = energy();
  const plan = repo.createMealPlan("test", "", sizedWeek(split));
  const dates = datesFrom(split.from);
  // A cut started after the draft: the lighter days' 2,050 is under its 2,100 floor.
  const stale = validateMealPlanForPersistence(plan.parsed, { day_floor_kcal: 2100 });
  assert.equal(stale.ok, false, "meals sized to the old lighter number no longer pass");
  assert.equal(stale.parsed.day_energy.floor_kcal, 2100);
  assert.deepEqual(
    stale.parsed.day_energy.days.map((d) => [d.date, d.kcal]),
    [
      [dates[0], 2100],
      [dates[2], 2100],
      [dates[5], 2400],
    ]
  );
  const resized = sizedWeek(split, { kcal: { [dates[0]]: 2100, [dates[2]]: 2100, [dates[5]]: 2400 } });
  const fresh = validateMealPlanForPersistence(resized, { day_floor_kcal: 2100 });
  assert.equal(fresh.ok, true, fresh.error);
  assert.equal(fresh.parsed.days[5].target_kcal, 2400);
  // The live floor never lowers a split made under a higher one.
  const lower = validateMealPlanForPersistence(plan.parsed, { day_floor_kcal: 1500 });
  assert.equal(lower.ok, true);
  assert.equal(lower.parsed.days[0].target_kcal, 2050);
});

test("once the split's week has passed the plan reads flat on the page but keeps being judged as sized", () => {
  const from = localDaysAgo(10);
  const split = energy(from);
  const created = repo.createMealPlan("test", "", sizedWeek(split));
  const read = repo.getMealPlan(created.id).parsed;
  assert.ok(read.days.every((d) => d.target_kcal === undefined && d.target_why === undefined && d.date === undefined));
  assert.deepEqual(
    read.days.map((d) => d.planned_kcal ?? null),
    [2050, null, 2050, null, null, 2500, null],
    "what each day was sized to stays for the plan's checks"
  );
  assert.equal(repo.currentMealPlan()?.id, created.id, "the plan is still the current plan");
  // The same plan read inside its week shows each day's number.
  const inWeek = applyMealPlanDayEnergy(sizedWeek(split), split);
  assert.equal(inWeek.days[5].target_kcal, 2500);
  const passed = applyMealPlanDayEnergy(sizedWeek(split), split);
  assert.equal(projectMealPlanDayEnergy(passed, { today: localDateISO() }).days[5].target_kcal, undefined);
});

test("nothing moved, or an average at the floor, plans flat", () => {
  const from = addDaysISO(localDateISO(), 1);
  const flat = datesFrom(from).map((date) => ({ date, kcal: AVERAGE }));
  assert.equal(shapeMealPlanDayEnergy({ from, average: AVERAGE, floor: 1500, days: flat }), null);
  const moved = datesFrom(from).map((date, i) => ({ date, kcal: i === 3 ? AVERAGE + 200 : AVERAGE }));
  assert.equal(shapeMealPlanDayEnergy({ from, average: AVERAGE, floor: AVERAGE, days: moved }), null);
});

test("the server's split replaces any the model wrote, and each day's number is projected from it", () => {
  const split = energy();
  const dates = datesFrom(split.from);
  const echoed = week({
    dayEnergy: {
      version: 1,
      average_kcal: AVERAGE,
      floor_kcal: 1500,
      from: split.from,
      days: [{ date: dates[1], kcal: 3900 }],
    },
  });
  echoed.days[1].target_kcal = 3900;
  echoed.days[1].date = "2000-01-01";
  const applied = applyMealPlanDayEnergy(echoed, split);
  assert.deepEqual(
    applied.day_energy.days.map((d) => d.date),
    [dates[0], dates[2], dates[5]]
  );
  assert.equal(applied.days[5].target_kcal, AVERAGE + 300);
  assert.equal(applied.days[5].target_why, "the long run");
  assert.equal(applied.days[5].date, dates[5]);
  assert.equal(applied.days[1].target_kcal, undefined, "a model-written number never survives");
  assert.equal(applied.days[1].date, dates[1], "every mapped day carries its date");
  assert.deepEqual(mealPlanDayKcalTargets(applied), [2050, null, 2050, null, null, 2500, null]);

  const none = applyMealPlanDayEnergy(echoed, null);
  assert.equal(none.day_energy, undefined, "no server split means no split at all");
  assert.equal(none.days[1].target_kcal, undefined);
  assert.ok(none.days.every((d) => d.date === undefined));

  // A label that names no weekday maps to no date and plans at the average.
  const odd = applyMealPlanDayEnergy(
    { ...week(), days: week().days.map((d, i) => (i === 5 ? { ...d, day: "Day 6" } : d)) },
    split
  );
  assert.equal(odd.days[5].target_kcal, undefined);
  assert.equal(odd.days[5].date, undefined);
});

// ------------------------------------------------------------- verify floors

test("a plan sized to each day's own number passes every floor", () => {
  assert.deepEqual(mealPlanFloorViolations(sizedWeek(energy()), REFS), []);
});

test("a plan flat at the headline on clearly moved days is flagged, the way an off-target day is", () => {
  const split = energy();
  const dates = datesFrom(split.from);
  const flat = week({ dayEnergy: split });
  const found = mealPlanFloorViolations(flat, REFS);
  const longDay = found.find((v) => v.day === label(dates[5]));
  assert.equal(longDay?.code, "meal_plan_day_kcal_below_day_number");
  assert.equal(longDay.floor, 2500);
  assert.equal(longDay.observed, AVERAGE);
  assert.deepEqual(
    found.filter((v) => v.code === "meal_plan_day_kcal_above_day_number").map((v) => v.day),
    [label(dates[0]), label(dates[2])]
  );
  for (const v of found) assert.equal(violatesReadingGrammar(v.message), null, v.message);
});

test("an old plan with no per-day numbers verifies exactly as before", () => {
  assert.deepEqual(mealPlanFloorViolations(week(), REFS), []);
  const dates = datesFrom(addDaysISO(localDateISO(), 1));
  const underfed = mealPlanFloorViolations(week({ kcal: { [dates[3]]: 1200 } }), REFS);
  assert.deepEqual(codes(underfed), ["meal_plan_day_kcal_below_floor"]);
  assert.equal(underfed[0].floor, AVERAGE);
  // A day 1 kcal under the headline is still caught on a flat plan.
  assert.deepEqual(codes(mealPlanFloorViolations(week({ kcal: { [dates[1]]: AVERAGE - 1 } }), REFS)), [
    "meal_plan_day_kcal_below_floor",
  ]);
});

test("floors never loosen: the day floor, a forged low number, protein and the week's mean all still hold", () => {
  const split = energy();
  const dates = datesFrom(split.from);
  // A running cut's floor above a lighter day's number: the floor wins.
  const cut = mealPlanFloorViolations(sizedWeek(split), { ...REFS, dayKcalFloor: 2100 });
  assert.deepEqual(
    cut.filter((v) => v.code === "meal_plan_day_kcal_below_floor").map((v) => [v.day, v.floor]),
    [
      [label(dates[0]), 2100],
      [label(dates[2]), 2100],
    ]
  );
  // A stored number under the absolute floor is not a number at all: that day is held to the headline.
  const forged = { ...split, days: [...split.days, { date: dates[3], kcal: 1200, shift_kcal: -1000, why: "x" }] };
  assert.equal(readMealPlanDayEnergy({ day_energy: forged }).days.length, 3);
  const forgedWeek = sizedWeek(forged, { kcal: { [dates[3]]: 1200 } });
  const forgedFound = mealPlanFloorViolations(forgedWeek, REFS).find((v) => v.day === label(dates[3]));
  assert.equal(forgedFound?.code, "meal_plan_day_kcal_below_floor");
  assert.equal(forgedFound.floor, AVERAGE);
  // Protein never moves: a lighter day still has to carry the whole protein target.
  const thin = mealPlanFloorViolations(sizedWeek(split, { protein: 120 }), REFS);
  assert.equal(thin.filter((v) => v.code === "meal_plan_day_protein_below_target").length, 7);
  // The week's mean stays the headline even when every day clears its own check.
  const heavy = sizedWeek(split, { kcal: { [dates[1]]: 2450, [dates[3]]: 2450, [dates[4]]: 2450, [dates[6]]: 2450 } });
  assert.ok(codes(mealPlanFloorViolations(heavy, REFS)).includes("meal_plan_week_kcal_off_average"));
});

test("the live pre-check judges the drafting op's own split, never the draft's", () => {
  const split = energy();
  const dates = datesFrom(split.from);
  // The model echoed a split that would excuse a flat week; the server's says otherwise.
  const echoed = week({ dayEnergy: { ...split, days: [] } });
  const judged = mealPlanFloorPrecheck(echoed, { day_energy: split });
  assert.ok(
    judged.violations.some((v) => v.code === "meal_plan_day_kcal_below_day_number" && v.day === label(dates[5]))
  );
  // With no server split the draft's echo is dropped and the week is judged flat.
  const flat = mealPlanFloorPrecheck(sizedWeek(split), { day_energy: null });
  assert.ok(flat.violations.every((v) => !v.code.includes("day_number")));
});

// ------------------------------------------------------------- the persistence gate

test("adequacy holds each moved day to its own number and the week to its headline; an old plan reads as before", () => {
  const split = energy();
  assert.equal(assessMealPlanAdequacy(sizedWeek(split)).ok, true);
  const flat = assessMealPlanAdequacy(week({ dayEnergy: split }));
  assert.equal(flat.ok, false);
  assert.match(flat.error, /that day's own 2500 kcal/);
  assert.equal(assessMealPlanAdequacy(week()).ok, true, "an old flat plan is unchanged");

  // Inside its tolerance but under the day floor: still refused.
  const dates = datesFrom(split.from);
  const floored = {
    ...split,
    floor_kcal: 2000,
    days: split.days.map((d) => (d.kcal < AVERAGE ? { ...d, kcal: 2050, shift_kcal: -150 } : d)),
  };
  const under = assessMealPlanAdequacy(sizedWeek(floored, { kcal: { [dates[0]]: 1960 } }));
  assert.equal(under.ok, false);
});

test("a stored plan keeps each day's number through edits and swaps, and a client cannot rewrite it", () => {
  const split = energy();
  const dates = datesFrom(split.from);
  const plan = repo.createMealPlan("test", "", sizedWeek(split));
  assert.equal(plan.parsed.days[5].target_kcal, 2500);
  assert.equal(plan.parsed.days[0].target_kcal, 2050);
  assert.equal(repo.currentMealPlan()?.id, plan.id, "a split plan is the current plan");

  // An edit that tries to carry its own numbers is projected back to the server's.
  const edited = plan.parsed.days.map((d, i) => (i === 5 ? { ...d, target_kcal: 9999, date: "2000-01-01" } : d));
  const updated = repo.updateMealPlanDays(plan.id, edited);
  assert.equal(updated.parsed.days[5].target_kcal, 2500);
  assert.equal(updated.parsed.days[5].date, dates[5]);

  // A like-for-like swap keeps the day and its number.
  const swapped = repo.swapMealInPlan(plan.id, label(dates[5]), 0, {
    name: "Salmon rice bowl",
    items: "salmon, rice, broccoli",
    kcal: 2480,
    protein_g: PROTEIN,
    carbs_g: 260,
    fat_g: 80,
    fiber_g: 30,
  });
  assert.equal(swapped.plan.parsed.days[5].target_kcal, 2500);
  assert.equal(swapped.plan.parsed.days[5].meals[0].name, "Salmon rice bowl");
  // A swap that would flatten the long-run day is refused.
  assert.throws(
    () =>
      repo.swapMealInPlan(plan.id, label(dates[5]), 0, {
        name: "Small bowl",
        items: "rice",
        kcal: AVERAGE,
        protein_g: PROTEIN,
        fiber_g: 30,
      }),
    /that day's own 2500 kcal/
  );
});

test("a logged day is read against the plan's own number for that date, and an old plan against the headline", () => {
  const from = localDaysAgo(8);
  const split = energy(from, { light: -250, big: 500 });
  const big = split.days.find((d) => d.shift_kcal > 0).date;
  repo.createMealPlan("test", "", sizedWeek(split));
  repo.addFoodNote("meal", "", { kcal: 2700, protein_g: PROTEIN }, undefined, { date: big });
  const read = repo.mealPlanAdherence(localDaysAgo(8), localDaysAgo(2));
  assert.equal(read.days.find((d) => d.date === big)?.classification, "followed");
  assert.equal(read.daily_kcal, AVERAGE, "the weekly headline is unchanged");
  assert.equal(mealPlanDayKcalFor(repo.currentMealPlan().parsed, big), 2700);

  resetTables("meal_plans", "food_notes");
  repo.createMealPlan("test", "", week({ from }));
  repo.addFoodNote("meal", "", { kcal: 2700, protein_g: PROTEIN }, undefined, { date: big });
  const old = repo.mealPlanAdherence(localDaysAgo(8), localDaysAgo(2));
  assert.equal(old.days.find((d) => d.date === big)?.classification, "diverged", "an old plan reads the headline");
});

// ------------------------------------------------------------- the prompt

test("the meal-plan prompt carries the per-day table, and a flat week carries none", () => {
  const split = energy();
  const prompt = buildMealPlanPrompt(undefined, { dayEnergy: split });
  assert.match(prompt, /EACH DAY'S OWN NUMBER/);
  assert.ok(prompt.includes(`${label(split.days[2].date)} ${split.days[2].date}: 2,500 kcal (+300) — the long run`));
  assert.match(prompt, /daily_kcal stays 2,200, the accepted weekly average/);
  assert.match(prompt, /at each day's own number/);

  const flat = buildMealPlanPrompt(undefined, { dayEnergy: null });
  assert.doesNotMatch(flat, /EACH DAY'S OWN NUMBER/);
  assert.match(flat, /at the same daily kcal/);
  assert.equal(renderMealPlanDayEnergy(null), "");
});

test("a lifting week drafts with its own split, and the prompt shows it", () => {
  const today = localDateISO();
  repo.setProfile({
    age: 44,
    height_cm: 170,
    weight_lb: 153,
    sex: "male",
    activity_factor: 1.55,
    goal_mode: "maintain",
    strength_schedule: { days: [{ dow: 1 }, { dow: 4 }], source: "athlete", updated_at: today },
  });
  repo.logWeight(153, today);
  repo.savePlanDay(1, "Full body", "strength", [{ exercise: "Back Squat", sets: 3, reps: "5" }], {
    day_type: "training",
  });
  const split = draftMealPlanDayEnergy();
  assert.ok(split, "a week with lifting days moves");
  const window = new Set(datesFrom(addDaysISO(today, 1)));
  for (const day of split.days) {
    assert.ok(window.has(day.date), `${day.date} is one of the plan's seven food days`);
    assert.ok(day.kcal >= split.floor_kcal);
    assert.equal(violatesReadingGrammar(day.why), null, day.why);
  }
  const drift = split.days.reduce((sum, day) => sum + day.shift_kcal, 0);
  assert.ok(Math.abs(drift) <= 10, `the window straddling two weeks still averages the target (drift ${drift})`);
  const prompt = buildMealPlanPrompt();
  assert.match(prompt, /EACH DAY'S OWN NUMBER/);
  for (const day of split.days) assert.ok(prompt.includes(day.date), `the prompt lists ${day.date}`);
});

// ------------------------------------------------------------- one number for one date

test("for a seeded week every plan day carries the number Intake shows for that date, and the window keeps its average", () => {
  const today = localDateISO();
  repo.setProfile({
    age: 44,
    height_cm: 170,
    weight_lb: 153,
    sex: "male",
    activity_factor: 1.55,
    goal_mode: "maintain",
    strength_schedule: { days: [{ dow: 1 }, { dow: 4 }], source: "athlete", updated_at: today },
  });
  repo.logWeight(153, today);
  repo.savePlanDay(1, "Full body", "strength", [{ exercise: "Back Squat", sets: 3, reps: "5" }], {
    day_type: "training",
  });
  // An average that is not a round ten: a day said "to the ten" would read 2,260 where
  // Intake says 2,263.
  for (const average of [2200, 2213]) {
    for (const draftDate of [today, addDaysISO(today, 3)]) {
      const split = computeMealPlanDayEnergy({ average, draftDate, today });
      assert.ok(split, `a lifting week moves (draft ${draftDate}, average ${average})`);
      const dates = datesFrom(addDaysISO(draftDate, 1));
      const kcalOn = (date) => split.days.find((d) => d.date === date)?.kcal ?? average;
      for (const date of dates) {
        assert.equal(kcalOn(date), dayEnergyTarget(date, average, { today }).kcal, `${date} is Intake's number for it`);
      }
      const total = dates.reduce((sum, date) => sum + kcalOn(date), 0);
      assert.ok(Math.abs(total - 7 * average) <= 50, `the window keeps its average to within one step (${total - 7 * average})`);
    }
  }
});

test("a window straddling two weeks that do not balance settles on the week not yet opened, in fifties", () => {
  const from = "2026-11-19"; // a Thursday: Thu–Sun this week, Mon–Wed the next
  const dates = datesFrom(from);
  // Over by 100: this week's long run and lighter Sunday, then a lifting Tuesday ahead.
  const raw = [0, 0, 300, -100, -100, 100, -100].map((shift, i) => ({
    date: dates[i],
    kcal: AVERAGE + shift,
    work: shift > 0 ? ["the long run"] : [],
  }));
  const split = shapeMealPlanDayEnergy({ from, average: AVERAGE, floor: 1500, days: raw, settleFirstFrom: dates[4] });
  const kcalOn = (date) => split.days.find((d) => d.date === date)?.kcal ?? AVERAGE;
  assert.deepEqual(
    dates.map(kcalOn),
    [2200, 2200, 2500, 2100, 2100, 2200, 2100],
    "this week's days keep their numbers; next Tuesday gives back what the window carried over"
  );
  for (const day of split.days) assert.equal(Math.abs(day.shift_kcal) % 50, 0, `${day.date} moves in fifties`);
  // With no room in the later week, the visible week settles, furthest out first.
  const tight = shapeMealPlanDayEnergy({
    from,
    average: AVERAGE,
    floor: 1500,
    days: [0, 0, 100, -200, 0, 50, 0].map((shift, i) => ({ date: dates[i], kcal: AVERAGE + shift })),
    settleFirstFrom: dates[4],
  });
  const tightOn = (date) => tight.days.find((d) => d.date === date)?.kcal ?? AVERAGE;
  assert.equal(dates.reduce((sum, date) => sum + tightOn(date), 0), 7 * AVERAGE, "the window still keeps its average");
  assert.equal(tightOn(dates[3]), 2050, "the lighter day of the visible week takes the step back up");
  assert.equal(tightOn(dates[5]), 2250, "a later day above the average is never pushed further out");
});
