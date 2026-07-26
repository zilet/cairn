// Food and meal-plan writes must bust the cached Brief just like every sibling
// write family (sessions, activities, plan edits, fueling feedback) — otherwise
// Today can keep showing a stale read after a meal is logged, corrected, deleted,
// or the plan itself changes. Mirrors the bustsCache() pattern in
// test/dayReadInvalidation.test.js.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { completeMealWeek, db, repo, resetTables, localDaysAgo } from "./_seed.js";

const TODAY = () => localDaysAgo(0);
const YESTERDAY = () => localDaysAgo(1);

beforeEach(() => resetTables("food_notes", "meal_plans", "day_reads", "profile", "bodyweight_log"));

function seedRead(date) {
  repo.saveDayRead(date, { kind: "train", headline: "Old read", why: "stale" });
  assert.ok(repo.getCachedDayRead(date), `precondition: a read is cached for ${date}`);
}

function bustsCache(date, mutate) {
  seedRead(date);
  mutate();
  assert.equal(repo.getCachedDayRead(date), null, `the cached Brief for ${date} was busted`);
}

// Insert a food_notes row directly for a chosen date. addFoodNote CAN backdate now
// (pass { date }), but a raw insert keeps the fixture free of the write's own side
// effects — which is exactly what matters when those side effects are the thing
// under test below.
function seedFoodNoteOn(date, parsed = { kcal: 500, protein_g: 40 }) {
  const info = db
    .prepare(
      `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status) VALUES (?, 'lunch', '', ?, NULL)`
    )
    .run(date, JSON.stringify(parsed));
  return repo.getFoodNote(Number(info.lastInsertRowid));
}

test("addFoodNote busts today's Brief", () => {
  bustsCache(TODAY(), () => repo.addFoodNote("lunch", "", { summary: "Chicken bowl", kcal: 500, protein_g: 45 }));
});

test("addFoodNote leaves other days' cached reads untouched", () => {
  seedRead(YESTERDAY());
  repo.addFoodNote("lunch", "", { summary: "Chicken bowl", kcal: 500, protein_g: 45 });
  assert.ok(repo.getCachedDayRead(YESTERDAY()), "a past day's cached read is unaffected by a fresh log");
});

// A BACKDATED log is a past-day intake change, so it takes the same two-call path
// the corrections above do: its own day's Brief is now wrong, and today's trailing
// -average fuel/expenditure read moved underneath it too.
test("a backdated addFoodNote busts both the meal's own day and today's Brief", () => {
  bustsCache(TODAY(), () =>
    bustsCache(YESTERDAY(), () =>
      repo.addFoodNote("dinner", "", { summary: "Steak", kcal: 700, protein_g: 55 }, undefined, {
        date: YESTERDAY(),
        eaten_at: "19:30",
      })
    )
  );
});

// Mirrors fueling.ts's two-call pattern: invalidateDayRead(d) busts the note's
// own day, and — because a past intake correction feeds the trailing-average
// expenditure math that shapes TODAY's read too — a second invalidateDayRead()
// (no arg) busts today's cache as well whenever the two dates differ.
test("updateFoodNoteParsed (enrichment overwrite) busts both the note's own day and today's", () => {
  const note = seedFoodNoteOn(YESTERDAY());
  bustsCache(TODAY(), () =>
    bustsCache(YESTERDAY(), () => repo.updateFoodNoteParsed(note.id, { summary: "Chicken bowl", kcal: 550 }))
  );
});

test("updateFoodNote (manual correction) busts both the note's own day and today's", () => {
  const note = seedFoodNoteOn(YESTERDAY());
  bustsCache(TODAY(), () => bustsCache(YESTERDAY(), () => repo.updateFoodNote(note.id, { kcal: 600 })));
});

// A day MOVE is the third case, and the one invalidateDayReadForDate cannot see on
// its own: it only knows an entry's CURRENT day (plus today). Miss the day the
// entry LEFT and that day keeps serving a Brief built on intake that has since
// moved somewhere else.
test("moving an entry to another day busts the day it left, the day it landed on, and today", () => {
  const twoDaysAgo = localDaysAgo(2);
  const note = seedFoodNoteOn(twoDaysAgo);
  seedRead(twoDaysAgo);
  seedRead(YESTERDAY());
  seedRead(TODAY());

  repo.updateFoodNote(note.id, { date: YESTERDAY() });

  assert.equal(repo.getCachedDayRead(twoDaysAgo), null, "the VACATED day is busted");
  assert.equal(repo.getCachedDayRead(YESTERDAY()), null, "the day it landed on is busted");
  assert.equal(repo.getCachedDayRead(TODAY()), null, "and today, whose trailing averages both days feed");
});

test("a correction that does not move the day leaves an unrelated day's read alone", () => {
  const note = seedFoodNoteOn(YESTERDAY());
  seedRead(localDaysAgo(3));
  repo.updateFoodNote(note.id, { kcal: 600 });
  assert.ok(repo.getCachedDayRead(localDaysAgo(3)), "an unrelated day is never touched");
});

test("deleteFoodNote busts both the note's own day and today's", () => {
  const note = seedFoodNoteOn(YESTERDAY());
  bustsCache(TODAY(), () => bustsCache(YESTERDAY(), () => repo.deleteFoodNote(note.id)));
});

test("deleteFoodNote for a note logged today busts today's Brief", () => {
  const note = seedFoodNoteOn(TODAY());
  bustsCache(TODAY(), () => repo.deleteFoodNote(note.id));
});

function seedPlan() {
  return repo.createMealPlan(
    "stub",
    "",
    completeMealWeek({
      days: [{ day: "Mon", meals: [{ name: "Oats", kcal: 400, protein_g: 20 }, { name: "Salmon rice bowl", kcal: 600, protein_g: 45 }] }],
    })
  );
}

test("acceptMealPlan busts today's Brief", () => {
  const plan = seedPlan();
  bustsCache(TODAY(), () => repo.acceptMealPlan(plan.id));
});

test("updateMealPlanDays busts today's Brief", () => {
  const plan = seedPlan();
  const days = completeMealWeek({
    days: [{ day: "Mon", meals: [{ name: "Eggs & toast", kcal: 350, protein_g: 25 }] }],
  }).days;
  bustsCache(TODAY(), () => repo.updateMealPlanDays(plan.id, days));
});

test("swapMealInPlan busts today's Brief", () => {
  const plan = seedPlan();
  bustsCache(TODAY(), () => repo.swapMealInPlan(plan.id, "Mon", 0, { name: "Greek yogurt bowl", kcal: 380, protein_g: 30 }));
});

test("setMealRecipe does NOT bust today's Brief (caching a recipe doesn't change the plan)", () => {
  const plan = seedPlan();
  seedRead(TODAY());
  repo.setMealRecipe(plan.id, "Mon", 0, { summary: "Simple oats", steps: ["Boil water", "Add oats"] });
  assert.ok(repo.getCachedDayRead(TODAY()), "a cached recipe is not plan content, so the Brief is untouched");
});
