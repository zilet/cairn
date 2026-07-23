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

// Insert a food_notes row directly for a chosen date (bypasses addFoodNote,
// which always stamps today — see _seed.js seedIntake for the same reasoning).
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
