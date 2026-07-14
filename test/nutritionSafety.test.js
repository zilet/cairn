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
    days: Array.from({ length: 7 }, (_, index) => ({
      day: index === 0 ? "Mon" : `Day ${index + 1}`,
      meals: [
        {
          name: "Chicken bowl",
          items: "chicken, rice, spinach",
          kcal: 2600,
          protein_g: 170,
          carbs_g: 70,
          fat_g: 18,
        },
      ],
    })),
    shopping: ["chicken", "rice", "spinach"],
    ...overrides,
  };
}

function completeWeek({
  dailyKcal = 2300,
  dailyProtein = 175,
  actualKcal = dailyKcal,
  actualProtein = dailyProtein,
} = {}) {
  return {
    daily_kcal: dailyKcal,
    daily_protein_g: dailyProtein,
    days: Array.from({ length: 7 }, (_, index) => ({
      day: `Day ${index + 1}`,
      meals: [
        { name: "Breakfast", kcal: Math.round(actualKcal * 0.4), protein_g: Math.round(actualProtein * 0.4) },
        {
          name: "Dinner",
          kcal: actualKcal - Math.round(actualKcal * 0.4),
          protein_g: actualProtein - Math.round(actualProtein * 0.4),
        },
      ],
    })),
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
  const goal = repo.computeGoalCheck();
  const floorKcal = Math.max(1500, goal.recommended.target_intake_kcal, goal.effective_target.target_kcal);
  const floorProtein = Math.max(goal.recommended.protein_g, goal.effective_target.protein_g);
  const plan = repo.createMealPlan(
    "stub",
    "",
    completeWeek({ dailyKcal: 800, dailyProtein: 25, actualKcal: floorKcal, actualProtein: floorProtein })
  );
  assert.equal(plan.parsed.daily_kcal, floorKcal);
  assert.equal(plan.parsed.daily_protein_g, floorProtein);
});

test("an incomplete profile still gets the absolute 1500 kcal server floor", () => {
  const plan = repo.createMealPlan(
    "stub",
    "",
    completeWeek({ dailyKcal: 700, dailyProtein: 25, actualKcal: 1500, actualProtein: 25 })
  );
  assert.equal(plan.parsed.daily_kcal, 1500);
  assert.equal(plan.parsed.daily_protein_g, 25, "protein is not invented without enough profile data");
});

test("complete meal-plan persistence rejects headline laundering and accepts adequate days", () => {
  assert.throws(
    () => repo.createMealPlan("stub", "", completeWeek({ dailyKcal: 2300, actualKcal: 900, actualProtein: 60 })),
    /Day 1 totals 900 kcal and 60 g protein/
  );
  assert.equal(repo.listMealPlans().length, 0, "the rejected weekly plan is never persisted");

  const adequate = repo.createMealPlan("stub", "", completeWeek());
  assert.equal(
    adequate.parsed.days[0].meals.reduce((sum, meal) => sum + meal.kcal, 0),
    2300
  );
  assert.equal(
    adequate.parsed.days[0].meals.reduce((sum, meal) => sum + meal.protein_g, 0),
    175
  );
});

test("a meal plan cannot silently exceed its coordinated accepted target", () => {
  completeProfile({ goal_mode: "lose", goal_weight_lb: 170 });
  const proposal = repo.createProposal("stub", "reviewed", "", {
    kind: "nutrition_target",
    summary: "Use 2200 kcal for the cut.",
    nutrition: { target_kcal: 2200, protein_g: 180, reason: "reviewed target" },
  });
  repo.applyProposal(proposal.id);
  assert.equal(repo.computeGoalCheck().effective_target.target_kcal, 2200);
  assert.throws(
    () => repo.createMealPlan("stub", "", completeWeek({ dailyKcal: 2412, dailyProtein: 180 })),
    /2412 kcal headline is outside the ±100 kcal rounding tolerance around the coordinated 2200 kcal target/
  );
  assert.equal(repo.listMealPlans().length, 0);
});

test("coordinated meal totals use one direct ±100 kcal boundary", () => {
  completeProfile({ goal_mode: "lose", goal_weight_lb: 170 });
  const proposal = repo.createProposal("stub", "reviewed", "", {
    kind: "nutrition_target",
    summary: "Use 2200 kcal for the cut.",
    nutrition: { target_kcal: 2200, protein_g: 180, reason: "reviewed target" },
  });
  repo.applyProposal(proposal.id);

  assert.doesNotThrow(() =>
    repo.createMealPlan(
      "stub",
      "",
      completeWeek({ dailyKcal: 2300, dailyProtein: 180, actualKcal: 2300, actualProtein: 180 })
    )
  );
  assert.doesNotThrow(() =>
    repo.createMealPlan(
      "stub",
      "",
      completeWeek({ dailyKcal: 2200, dailyProtein: 180, actualKcal: 2100, actualProtein: 180 })
    )
  );
  assert.throws(
    () =>
      repo.createMealPlan(
        "stub",
        "",
        completeWeek({ dailyKcal: 2301, dailyProtein: 180, actualKcal: 2301, actualProtein: 180 })
      ),
    /2301 kcal headline is outside the ±100 kcal rounding tolerance/
  );
  assert.throws(
    () =>
      repo.createMealPlan(
        "stub",
        "",
        completeWeek({ dailyKcal: 2300, dailyProtein: 180, actualKcal: 2401, actualProtein: 180 })
      ),
    /Day 1 totals 2401 kcal, outside the ±100 kcal rounding tolerance around the coordinated 2200 kcal target/
  );
  assert.throws(
    () =>
      repo.createMealPlan(
        "stub",
        "",
        completeWeek({ dailyKcal: 2200, dailyProtein: 180, actualKcal: 2099, actualProtein: 180 })
      ),
    /Day 1 totals 2099 kcal, outside the ±100 kcal rounding tolerance around the coordinated 2200 kcal target/
  );
});

test("complete weeks enforce the current goal and expenditure floors in the meals themselves", () => {
  completeProfile({ goal_mode: "maintain" });
  const goal = repo.computeGoalCheck();
  const floorKcal = Math.max(goal.recommended.target_intake_kcal, goal.effective_target.target_kcal);
  const floorProtein = Math.max(goal.recommended.protein_g, goal.effective_target.protein_g);

  const plan = repo.createMealPlan(
    "stub",
    "",
    completeWeek({
      dailyKcal: 800,
      dailyProtein: 25,
      actualKcal: floorKcal,
      actualProtein: floorProtein,
    })
  );
  assert.equal(plan.parsed.daily_kcal, floorKcal);
  assert.equal(plan.parsed.daily_protein_g, floorProtein);
});

test("declared allergen aliases reject an unsafe plan atomically", () => {
  completeProfile({ allergies: "peanuts, shellfish" });
  const unsafe = safePlan();
  unsafe.days[0].meals[0] = {
    ...unsafe.days[0].meals[0],
    name: "Noodle bowl",
    items: "rice noodles, shrimp, greens",
  };
  assert.throws(() => repo.createMealPlan("stub", "", unsafe), /declared allergen shellfish \(shrimp\)/);
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
