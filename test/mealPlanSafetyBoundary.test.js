import assert from "node:assert/strict";
import test from "node:test";
import { generateRecipe, validateMealPlanDraftForPersistence } from "../dist/coachOps.js";
import * as repo from "../dist/repo.js";
import { applyMealPlanWithAutonomy } from "../dist/domain/brain/autonomy-service.js";
import { db } from "./_seed.js";

function week(actualKcal, actualProtein, targetKcal = 2300, targetProtein = 175) {
  return {
    daily_kcal: targetKcal,
    daily_protein_g: targetProtein,
    days: Array.from({ length: 7 }, (_, index) => ({
      day: `Day ${index + 1}`,
      meals: [
        { name: "First meal", kcal: Math.round(actualKcal / 2), protein_g: Math.round(actualProtein / 2) },
        {
          name: "Second meal",
          kcal: actualKcal - Math.round(actualKcal / 2),
          protein_g: actualProtein - Math.round(actualProtein / 2),
        },
      ],
    })),
  };
}

test("coachOps meal boundary returns designed failure before persistence", () => {
  const result = validateMealPlanDraftForPersistence(week(900, 60));
  assert.equal(result.ok, false);
  assert.match(result.error, /Day 1 totals 900 kcal and 60 g protein/);
  assert.equal(repo.listMealPlans().length, 0);
});

test("coachOps meal boundary accepts a week whose meals match its canonical target", () => {
  const result = validateMealPlanDraftForPersistence(week(2300, 175));
  assert.equal(result.ok, true);
  assert.equal(result.adequacy_checked, true);
  assert.equal(result.parsed.daily_kcal, 2300);
  assert.equal(result.parsed.daily_protein_g, 175);
});

test("one-day legacy plans stay readable but cannot cross any current-plan write boundary", async () => {
  const partial = {
    daily_kcal: 2600,
    daily_protein_g: 170,
    days: [{ day: "Mon", meals: [{ name: "Single bowl", kcal: 650, protein_g: 45 }] }],
  };
  const inserted = db
    .prepare(`INSERT INTO meal_plans (week_of, agent, raw_output, parsed_json) VALUES (date('now'), 'legacy', '', ?)`)
    .run(JSON.stringify(partial));
  const id = Number(inserted.lastInsertRowid);

  assert.equal(repo.getMealPlan(id).parsed.days[0].meals[0].kcal, 650, "legacy hydration remains readable");
  assert.ok(repo.listMealPlans().some((plan) => plan.id === id), "legacy history remains listable");
  assert.equal(repo.currentMealPlan(), null, "an unchecked draft is not a canonical current plan");
  assert.equal(repo.mealPlanForCoach(), null, "the coaching brain never receives the unchecked fallback");
  assert.throws(() => repo.createMealPlan("new", "", partial), /requires 5 to 7 complete days/);
  assert.throws(() => repo.acceptMealPlan(id), /requires 5 to 7 complete days/);
  assert.throws(() => repo.setMealPlanStatus(id, "draft"), /requires 5 to 7 complete days/);
  assert.throws(() => repo.setMealPlanStatus(id, "accepted"), /requires 5 to 7 complete days/);
  assert.throws(
    () => repo.updateMealPlanDays(id, partial.days),
    /requires 5 to 7 complete days/,
    "an edit cannot re-persist unchecked legacy days"
  );
  assert.throws(
    () => repo.swapMealInPlan(id, "Mon", 0, { name: "Another bowl", kcal: 700, protein_g: 50 }),
    /requires 5 to 7 complete days/,
    "a swap cannot make an unchecked legacy plan current"
  );
  assert.throws(
    () =>
      repo.setMealRecipe(id, "Mon", 0, {
        ingredients: [{ item: "rice", qty: "1 cup" }],
        steps: ["Cook the rice."],
      }),
    /requires 5 to 7 complete days/
  );
  assert.equal(repo.getMealPlan(id).parsed.days[0].meals[0].recipe, undefined, "recipe write stayed atomic");
  const generated = await generateRecipe("stub", { plan: repo.getMealPlan(id), id, day: "Mon", mealIndex: 0 });
  assert.equal(generated.ok, false);
  assert.match(generated.error, /requires 5 to 7 complete days/);
  assert.equal(generated.tried.length, 0, "the unsafe plan is rejected before any agent work");
  const autonomy = applyMealPlanWithAutonomy(id);
  assert.equal(autonomy.ok, false);
  assert.equal(autonomy.applied, false);
  assert.match(autonomy.error, /requires 5 to 7 complete days/);
  assert.equal(repo.getMealPlan(id).status, "draft");
  assert.equal(repo.getMealPlan(id).autonomy, null);
});

test("a valid accepted week remains canonical ahead of a newer unsafe legacy draft", () => {
  const valid = repo.createMealPlan("new", "", week(2300, 175));
  repo.acceptMealPlan(valid.id);
  const partial = {
    daily_kcal: 2600,
    daily_protein_g: 170,
    days: [{ day: "Mon", meals: [{ name: "Legacy bowl", kcal: 650, protein_g: 45 }] }],
  };
  const legacyId = Number(
    db
      .prepare(`INSERT INTO meal_plans (week_of, agent, raw_output, parsed_json) VALUES (date('now'), 'legacy', '', ?)`)
      .run(JSON.stringify(partial)).lastInsertRowid
  );

  assert.equal(repo.currentMealPlan().id, valid.id);
  assert.equal(repo.mealPlanForCoach().id, valid.id);
  assert.ok(repo.listMealPlans().some((plan) => plan.id === legacyId));
  const recipe = repo.setMealRecipe(valid.id, "Day 1", 0, {
    ingredients: [{ item: "rice", qty: "1 cup" }],
    steps: ["Cook the rice."],
  });
  assert.equal(recipe.recipe.steps[0], "Cook the rice.");
});
