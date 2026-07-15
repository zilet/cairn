import assert from "node:assert/strict";
import test from "node:test";
import { buildMealPlanPrompt, buildMealSwapPrompt, buildRecipePrompt } from "../dist/prompt.js";
import { repo } from "./_seed.js";

function week({ fiber = 30, meal = {} } = {}) {
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return {
    daily_kcal: 2200,
    daily_protein_g: 170,
    daily_fiber_g: 30,
    days: Array.from({ length: 7 }, (_, index) => ({
      day: weekdays[index],
      meals: [
        {
          name: "Tofu grain bowl",
          items: "tofu, brown rice, lentils, spinach",
          kcal: 2200,
          protein_g: 170,
          carbs_g: 240,
          fat_g: 70,
          fiber_g: fiber,
          ...meal,
        },
      ],
    })),
    shopping: ["tofu", "brown rice", "lentils", "spinach"],
  };
}

test("meal prompt contracts require per-meal fiber and explain the deterministic weekly rule", () => {
  const prompt = buildMealPlanPrompt();
  assert.match(prompt, /"daily_fiber_g": <number — at least 30>/);
  assert.match(prompt, /"fiber_g": <number>/);
  assert.match(prompt, /week averages at least this target with no day below 80%/);
});

test("fiber-tracked plans must average 30 g with no day below 24 g", () => {
  assert.throws(() => repo.createMealPlan("stub", "", week({ fiber: 23 })), /below the 24 g minimum day/);
  assert.equal(repo.listMealPlans().length, 0);

  const plan = repo.createMealPlan("stub", "", week({ fiber: 30 }));
  assert.equal(plan.parsed.daily_fiber_g, 30);
  assert.equal(plan.parsed.days[0].meals[0].fiber_g, 30);
  assert.deepEqual(plan.parsed.quality_validation.fiber, {
    status: "verified",
    target_daily_g: 30,
    average_daily_g: 30,
    minimum_day_g: 30,
  });
  assert.deepEqual(plan.parsed.validation_warnings, []);

  const coach = repo.mealPlanForCoach();
  assert.equal(coach.daily_fiber_g, 30);
  assert.equal(coach.today?.meals?.[0]?.fiber_g ?? coach.tomorrow?.meals?.[0]?.fiber_g, 30);
});

test("a meal swap carries fiber through coercion and cannot break the week's floor", () => {
  const plan = repo.createMealPlan("stub", "", week({ fiber: 30 }));
  const swapPrompt = buildMealSwapPrompt({ plan, day: "Mon", mealIndex: 0 });
  assert.match(swapPrompt, /"fiber_g": <number>/);
  assert.match(swapPrompt, /whole week after the swap/);

  assert.throws(
    () =>
      repo.swapMealInPlan(plan.id, "Mon", 0, {
        name: "Low-fiber plate",
        items: "tofu, rice",
        kcal: 2200,
        protein_g: 170,
        carbs_g: 240,
        fat_g: 70,
        fiber_g: 10,
      }),
    /below the 24 g minimum day/
  );
  assert.equal(repo.getMealPlan(plan.id).parsed.days[0].meals[0].fiber_g, 30);

  const swapped = repo.swapMealInPlan(plan.id, "Mon", 0, {
    name: "Lentil tofu plate",
    items: "lentils, tofu, spinach",
    kcal: 2200,
    protein_g: 170,
    carbs_g: 240,
    fat_g: 70,
    fiber_g: 31.4,
  });
  assert.equal(swapped.meal.fiber_g, 31);
  assert.equal(swapped.plan.parsed.quality_validation.fiber.status, "verified");
});

test("a legacy plan can still swap one meal without pretending partial fiber data verifies the week", () => {
  const legacy = week({ fiber: 30 });
  delete legacy.daily_fiber_g;
  for (const day of legacy.days) for (const meal of day.meals) delete meal.fiber_g;
  const plan = repo.createMealPlan("stub", "", legacy);
  assert.equal(plan.parsed.quality_validation.fiber.status, "unknown");

  const swapped = repo.swapMealInPlan(plan.id, "Mon", 0, {
    name: "Lentil tofu plate",
    items: "lentils, tofu, spinach",
    kcal: 2200,
    protein_g: 170,
    carbs_g: 240,
    fat_g: 70,
    fiber_g: 30,
  });
  assert.equal(swapped.meal.fiber_g, 30);
  assert.equal(swapped.plan.parsed.quality_validation.fiber.status, "unknown");
  assert.match(swapped.plan.parsed.validation_warnings[0], /Fiber could not be deterministically verified/);
});

test("legacy day edits preserve missing fiber as unknown instead of coercing it to zero", () => {
  const legacy = week({ fiber: 30 });
  for (const day of legacy.days) for (const meal of day.meals) delete meal.fiber_g;
  const plan = repo.createMealPlan("stub", "", legacy);

  const editedDays = plan.parsed.days.map((day, index) =>
    index === 0 ? { ...day, meals: [{ name: "Salmon bowl", items: "salmon, rice", kcal: 2200, protein_g: 170 }] } : day
  );
  const edited = repo.updateMealPlanDays(plan.id, editedDays);

  assert.equal(edited.parsed.quality_validation.fiber.status, "unknown");
  assert.equal("fiber_g" in edited.parsed.days[0].meals[0], false);
  assert.match(edited.parsed.validation_warnings[0], /does not have complete per-meal fiber estimates/);
});

test("a verified plan cannot drop a fiber estimate and downgrade itself to unknown", () => {
  const plan = repo.createMealPlan("stub", "", week());
  const editedDays = structuredClone(plan.parsed.days);
  delete editedDays[0].meals[0].fiber_g;

  assert.throws(
    () => repo.updateMealPlanDays(plan.id, editedDays),
    /previously fiber-verified week cannot omit a meal fiber estimate/
  );
  assert.equal(repo.getMealPlan(plan.id).parsed.quality_validation.fiber.status, "verified");
  assert.equal(repo.getMealPlan(plan.id).parsed.days[0].meals[0].fiber_g, 30);
});

test("declared vegan and pescatarian identities are enforced at every plan write boundary", () => {
  repo.setProfile({ dietary_restrictions: "vegan" });
  assert.throws(
    () => repo.createMealPlan("stub", "", week({ meal: { name: "Chicken bowl", items: "chicken, rice" } })),
    /violates declared vegan diet \(chicken\)/
  );

  const vegan = repo.createMealPlan("stub", "", week());
  assert.throws(
    () =>
      repo.swapMealInPlan(vegan.id, "Mon", 0, {
        name: "Salmon bowl",
        items: "salmon, rice, spinach",
        kcal: 2200,
        protein_g: 170,
        carbs_g: 240,
        fat_g: 70,
        fiber_g: 30,
      }),
    /violates declared vegan diet \(salmon\)/
  );
  assert.throws(
    () =>
      repo.setMealRecipe(vegan.id, "Mon", 0, {
        ingredients: [{ item: "tofu", qty: "200 g" }],
        steps: ["Cook the tofu in butter."],
      }),
    /violates declared vegan diet \(butter\)/
  );
  assert.doesNotThrow(() =>
    repo.setMealRecipe(vegan.id, "Mon", 0, {
      ingredients: [{ item: "vegan cheese", qty: "30 g" }],
      steps: ["Fold in the plant-based cheese."],
    })
  );

  repo.setProfile({ dietary_restrictions: "pescatarian" });
  assert.doesNotThrow(() =>
    repo.createMealPlan("stub", "", week({ meal: { name: "Salmon bowl", items: "salmon, rice, spinach" } }))
  );
  assert.throws(
    () => repo.createMealPlan("stub", "", week({ meal: { name: "Steak bowl", items: "beef, rice" } })),
    /violates declared pescatarian diet \((?:steak|beef)\)/
  );
});

test("gluten-free compliance labels are accepted without hiding actual gluten ingredients", () => {
  repo.setProfile({ dietary_restrictions: "gluten-free" });
  assert.doesNotThrow(() =>
    repo.createMealPlan(
      "stub",
      "",
      week({
        meal: {
          name: "Gluten-free toast plate",
          items: "certified gluten-free bread, tofu, spinach",
        },
      })
    )
  );
  assert.throws(
    () =>
      repo.createMealPlan(
        "stub",
        "",
        week({
          meal: {
            name: "Gluten-free toast plate",
            items: "gluten-free bread, wheat flour, tofu",
          },
        })
      ),
    /violates declared gluten-free diet \(wheat\)/
  );
});

test("a current-turn gluten-free task reaches the deterministic write gate without changing profile", () => {
  const task = "Make this week gluten-free.";
  assert.match(buildMealPlanPrompt(task), /GLUTEN-FREE \(HARD RULE/);
  assert.throws(
    () =>
      repo.createMealPlan(
        "stub",
        "",
        week({
          meal: {
            name: "Wheat toast plate",
            items: "wheat bread, tofu, spinach",
          },
        }),
        { dietary_instruction: task }
      ),
    /violates declared gluten-free diet \(wheat\)/
  );
  assert.equal(repo.listMealPlans().length, 0);

  const negated = "Don't make this week gluten-free; wheat is fine.";
  assert.doesNotMatch(buildMealPlanPrompt(negated), /GLUTEN-FREE \(HARD RULE/);
  assert.doesNotThrow(() =>
    repo.createMealPlan(
      "stub",
      "",
      week({
        meal: {
          name: "Wheat toast plate",
          items: "wheat bread, tofu, spinach",
        },
      }),
      { dietary_instruction: negated }
    )
  );
});

test("a current-turn gluten-free plan keeps its hard constraint for later swaps and recipes", () => {
  const instruction = "Make this week gluten-free.";
  const plan = repo.createMealPlan("stub", "", week(), { dietary_instruction: instruction });
  assert.deepEqual(plan.parsed.hard_diet_constraints, {
    keys: ["gluten_free"],
    provenance: [{ key: "gluten_free", source: "current_instruction" }],
  });

  const swapPrompt = buildMealSwapPrompt({ plan, day: "Mon", mealIndex: 0 });
  const recipePrompt = buildRecipePrompt({ plan, day: "Mon", mealIndex: 0 });
  assert.match(swapPrompt, /GLUTEN-FREE \(HARD RULE/);
  assert.match(recipePrompt, /GLUTEN-FREE \(HARD RULE/);

  assert.throws(
    () =>
      repo.swapMealInPlan(plan.id, "Mon", 0, {
        name: "Wheat noodle bowl",
        items: "wheat noodles, tofu, spinach",
        kcal: 2200,
        protein_g: 170,
        carbs_g: 240,
        fat_g: 70,
        fiber_g: 30,
      }),
    /violates declared gluten-free diet \(wheat\)/
  );
  assert.throws(
    () =>
      repo.setMealRecipe(plan.id, "Mon", 0, {
        ingredients: [{ item: "wheat flour", qty: "1 cup" }],
        steps: ["Mix and cook."],
      }),
    /violates declared gluten-free diet \(wheat\)/
  );

  const reordered = repo.updateMealPlanDays(plan.id, [...plan.parsed.days].reverse());
  assert.deepEqual(reordered.parsed.hard_diet_constraints, plan.parsed.hard_diet_constraints);
  const exported = repo.exportAll().meal_plans.find((entry) => entry.id === plan.id);
  assert.deepEqual(exported.parsed.hard_diet_constraints, plan.parsed.hard_diet_constraints);
});

test("meal preferences become hard constraints only for explicit identity or global-must language", () => {
  repo.setSettings({ meal_prefs: "I train fasted; also I am vegan." });
  assert.throws(
    () => repo.createMealPlan("stub", "", week({ meal: { name: "Chicken bowl", items: "chicken, rice" } })),
    /violates declared vegan diet/
  );

  for (const meal_prefs of ["Prefer vegetarian lunches", "Mostly vegetarian", "I am not vegan"]) {
    repo.setSettings({ meal_prefs });
    assert.doesNotThrow(
      () => repo.createMealPlan("stub", "", week({ meal: { name: "Chicken bowl", items: "chicken, rice" } })),
      meal_prefs
    );
  }
});

test("an explicit hard-diet identity survives unrelated soft wording after a conjunction", () => {
  repo.setSettings({ meal_prefs: "I am vegan and prefer low sodium" });
  assert.throws(
    () => repo.createMealPlan("stub", "", week({ meal: { name: "Chicken bowl", items: "chicken, rice" } })),
    /violates declared vegan diet/
  );

  for (const meal_prefs of ["Prefer vegetarian lunches", "Mostly vegetarian", "I am not vegan and prefer low sodium"]) {
    repo.setSettings({ meal_prefs });
    assert.doesNotThrow(
      () => repo.createMealPlan("stub", "", week({ meal: { name: "Chicken bowl", items: "chicken, rice" } })),
      meal_prefs
    );
  }
});

test("constraints that cannot be proven from labels remain visible as validation warnings", () => {
  repo.setProfile({ dietary_restrictions: "low FODMAP" });
  const plan = repo.createMealPlan("stub", "", week());
  assert.equal(plan.parsed.quality_validation.dietary_constraints.status, "partial");
  assert.match(plan.parsed.validation_warnings[0], /low FODMAP/);
  assert.match(plan.parsed.validation_warnings[0], /cannot be deterministically verified/);

  repo.setProfile({ dietary_restrictions: "vegan, no cilantro" });
  const mixed = repo.createMealPlan("stub", "", week());
  assert.match(mixed.parsed.validation_warnings[0], /no cilantro/);
});
