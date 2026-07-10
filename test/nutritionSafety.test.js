import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";

function completeProfile(patch = {}) {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 180,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "maintain",
    allergies: "",
    ...patch,
  });
}

function safePlan(overrides = {}) {
  return {
    daily_kcal: 2600,
    daily_protein_g: 170,
    days: [
      {
        day: "Mon",
        meals: [
          { name: "Chicken bowl", items: "chicken, rice, spinach", kcal: 650, protein_g: 45, carbs_g: 70, fat_g: 18 },
        ],
      },
    ],
    shopping: ["chicken", "rice", "spinach"],
    ...overrides,
  };
}

test("direct nutrition-target writes cannot bypass the active lean-safe floor", () => {
  completeProfile({ goal_mode: "maintain" });
  const floor = repo.computeGoalCheck().recommended;
  const saved = repo.setNutritionTarget({ target_kcal: 900, protein_g: 20, source: "direct" });
  assert.equal(saved.target_kcal, Math.max(1500, floor.target_intake_kcal));
  assert.equal(saved.protein_g, floor.protein_g);
});

test("meal-plan persistence clamps calorie and protein targets before write", () => {
  completeProfile({ goal_mode: "maintain" });
  const floor = repo.computeGoalCheck().recommended;
  const plan = repo.createMealPlan("stub", "", safePlan({ daily_kcal: 800, daily_protein_g: 25 }));
  assert.equal(plan.parsed.daily_kcal, Math.max(1500, floor.target_intake_kcal));
  assert.equal(plan.parsed.daily_protein_g, floor.protein_g);
});

test("an incomplete profile still gets the absolute 1500 kcal server floor", () => {
  const plan = repo.createMealPlan("stub", "", safePlan({ daily_kcal: 700, daily_protein_g: 25 }));
  assert.equal(plan.parsed.daily_kcal, 1500);
  assert.equal(plan.parsed.daily_protein_g, 25, "protein is not invented without enough profile data");
});

test("declared allergen aliases reject an unsafe plan atomically", () => {
  completeProfile({ allergies: "peanuts, shellfish" });
  assert.throws(
    () =>
      repo.createMealPlan(
        "stub",
        "",
        safePlan({
          days: [
            {
              day: "Mon",
              meals: [{ name: "Noodle bowl", items: "rice noodles, shrimp, greens", kcal: 650, protein_g: 40 }],
            },
          ],
        })
      ),
    /declared allergen shellfish \(shrimp\)/
  );
  assert.equal(repo.listMealPlans().length, 0, "no partial unsafe draft was stored");
});

test("manual edits and swaps cannot introduce a declared allergen", () => {
  completeProfile({ allergies: "tree nuts" });
  const plan = repo.createMealPlan("stub", "", safePlan());

  assert.throws(
    () =>
      repo.updateMealPlanDays(plan.id, [
        { day: "Mon", meals: [{ name: "Oats", items: "oats, almond butter", kcal: 500 }] },
      ]),
    /declared allergen tree nuts \(almond\)/
  );
  assert.equal(
    repo.getMealPlan(plan.id).parsed.days[0].meals[0].name,
    "Chicken bowl",
    "failed edit did not mutate storage"
  );

  assert.throws(
    () => repo.swapMealInPlan(plan.id, "Mon", 0, { name: "Cashew stir fry", items: "cashews, vegetables", kcal: 600 }),
    /declared allergen tree nuts \(cashew/
  );
  assert.equal(
    repo.getMealPlan(plan.id).parsed.days[0].meals[0].name,
    "Chicken bowl",
    "failed swap did not mutate storage"
  );
});

test("recipe ingredient, step, and tip text cannot reintroduce an allergen", () => {
  completeProfile({ allergies: "dairy" });
  const plan = repo.createMealPlan("stub", "", safePlan());

  assert.throws(
    () =>
      repo.setMealRecipe(plan.id, "Mon", 0, {
        summary: "Weeknight bowl",
        ingredients: [{ item: "rice", qty: "1 cup" }],
        steps: ["Cook the rice", "Finish with butter"],
        tips: [],
      }),
    /declared allergen milk\/dairy \(butter\)/
  );
  assert.equal(repo.getMealPlan(plan.id).parsed.days[0].meals[0].recipe, undefined);
});

test("uncommon declared food allergies are enforced by exact phrase", () => {
  completeProfile({ allergies: "kiwi" });
  assert.throws(
    () => repo.createMealPlan("stub", "", safePlan({ shopping: ["chicken", "kiwi"] })),
    /declared allergen kiwi \(kiwi\)/
  );
});
