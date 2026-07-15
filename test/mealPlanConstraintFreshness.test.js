import assert from "node:assert/strict";
import test from "node:test";
import { completeMealWeek, db, repo } from "./_seed.js";
import { assertMealAllergenSafe, canonicalAllergyKeys } from "../dist/repo/nutrition-safety.js";

function week(meal = {}) {
  return completeMealWeek({
    daily_kcal: 2200,
    daily_protein_g: 170,
    days: Array.from({ length: 7 }, (_, index) => ({
      day: `Day ${index + 1}`,
      meals: [{ name: "Tofu rice bowl", items: "tofu, rice, lentils, spinach", kcal: 2200, protein_g: 170, ...meal }],
    })),
  });
}

function acceptedWeek(meal = {}, opts = {}) {
  const plan = repo.createMealPlan("stub", "", week(meal), opts);
  return repo.acceptMealPlan(plan.id);
}

test("an accepted chicken plan becomes refresh-needed when the profile becomes vegan", () => {
  const accepted = acceptedWeek({ name: "Chicken rice bowl", items: "chicken, rice, spinach" });
  const original = accepted.parsed.constraint_provenance.planned_for_fingerprint;
  repo.setProfile({ dietary_restrictions: "vegan" });

  const current = repo.currentMealPlan();
  assert.equal(current.id, accepted.id, "the ledgered plan remains visible instead of silently selecting another week");
  assert.equal(current.constraint_state.status, "refresh_needed");
  assert.equal(current.constraint_state.changed_since_planned, true);
  assert.equal(current.constraint_state.planned_for_fingerprint, original);
  assert.match(current.constraint_state.conflicts[0].detail, /vegan diet \(chicken\)/);

  const coach = repo.mealPlanForCoach();
  assert.equal(coach.refresh_needed, true);
  assert.equal(coach.today, null);
  assert.equal(coach.tomorrow, null);
  assert.equal(JSON.stringify(coach).includes("Chicken rice bowl"), false);

  const persisted = repo.getMealPlan(accepted.id);
  assert.equal(persisted.parsed.constraint_state.status, "refresh_needed");
  assert.equal(persisted.status, "accepted", "revalidation never destroys plan history or status");
});

test("a newly declared peanut allergy blocks an accepted peanut plan on read", () => {
  const accepted = acceptedWeek({ name: "Peanut tofu bowl", items: "peanuts, tofu, rice" });
  repo.setProfile({ allergies: "peanuts" });
  const current = repo.currentMealPlan();
  assert.equal(current.id, accepted.id);
  assert.equal(current.constraint_state.status, "refresh_needed");
  assert.equal(current.constraint_state.conflicts[0].kind, "allergy");
  assert.match(current.constraint_state.conflicts[0].detail, /declared allergen peanut/);
});

test("singular reads immediately revalidate a changed vegan identity", () => {
  const accepted = acceptedWeek({ name: "Chicken rice bowl", items: "chicken, rice, spinach" });
  repo.setProfile({ dietary_restrictions: "vegan" });

  const singular = repo.getMealPlan(accepted.id);
  assert.equal(singular.status, "accepted", "history/status remains intact");
  assert.equal(singular.constraint_state.status, "refresh_needed");
  assert.equal(singular.parsed.constraint_state.status, "refresh_needed");
  assert.match(singular.constraint_state.conflicts[0].detail, /vegan diet \(chicken\)/);
});

test("singular reads immediately revalidate a changed allergy", () => {
  const accepted = acceptedWeek({ name: "Peanut tofu bowl", items: "peanuts, tofu, rice" });
  repo.setProfile({ allergies: "peanuts" });

  const singular = repo.getMealPlan(accepted.id);
  assert.equal(singular.status, "accepted");
  assert.equal(singular.constraint_state.status, "refresh_needed");
  assert.equal(singular.constraint_state.conflicts[0].kind, "allergy");
});

test("a compatible hard-constraint change refreshes the checked fingerprint and remains usable", () => {
  const accepted = acceptedWeek();
  const plannedFor = accepted.parsed.constraint_provenance.planned_for_fingerprint;
  repo.setProfile({ dietary_restrictions: "vegan" });
  const current = repo.currentMealPlan();
  assert.equal(current.constraint_state.status, "current");
  assert.equal(current.constraint_state.changed_since_planned, true);
  assert.equal(current.constraint_state.planned_for_fingerprint, plannedFor);
  assert.notEqual(current.constraint_state.fingerprint, plannedFor);
  assert.equal(repo.mealPlanForCoach().refresh_needed, false);
});

test("soft and negated meal preferences do not change the hard-constraint fingerprint", () => {
  const accepted = acceptedWeek({ name: "Chicken bowl", items: "chicken, rice" });
  const before = repo.mealPlanConstraintSnapshot(accepted.parsed).fingerprint;
  for (const meal_prefs of ["Prefer vegetarian lunches", "Mostly vegetarian", "I am not vegan"]) {
    repo.setSettings({ meal_prefs });
    const current = repo.currentMealPlan();
    assert.equal(current.constraint_state.status, "current", meal_prefs);
    assert.equal(repo.mealPlanConstraintSnapshot(current.parsed).fingerprint, before, meal_prefs);
  }
});

test("plan-scoped hard constraints remain in provenance and enforcement", () => {
  const accepted = acceptedWeek({}, { dietary_instruction: "Make this week gluten-free." });
  assert.deepEqual(accepted.parsed.constraint_provenance.planned_for_sources.plan_hard_diets, ["gluten_free"]);
  repo.setSettings({ meal_prefs: "Prefer vegetarian lunches" });
  const current = repo.currentMealPlan();
  assert.deepEqual(current.parsed.constraint_provenance.current.sources.plan_hard_diets, ["gluten_free"]);
  assert.equal(current.constraint_state.status, "current");
});

test("legacy accepted plans are revalidated on canonical read rather than trusted", () => {
  repo.setProfile({ dietary_restrictions: "vegan" });
  const legacy = week({ name: "Chicken bowl", items: "chicken, rice" });
  const info = db
    .prepare(`INSERT INTO meal_plans (week_of, agent, raw_output, parsed_json, status) VALUES ('2026-07-14', 'legacy', '', ?, 'accepted')`)
    .run(JSON.stringify(legacy));
  const current = repo.currentMealPlan();
  assert.equal(current.id, Number(info.lastInsertRowid));
  assert.equal(current.constraint_state.status, "refresh_needed");
  assert.equal(current.constraint_state.legacy_unstamped, true);
  assert.equal(repo.getMealPlan(current.id).parsed.constraint_provenance.planned_for_fingerprint, null);
});

test("constraint fingerprints are stable and order-insensitive", () => {
  repo.setProfile({ allergies: "shellfish, peanuts", dietary_restrictions: "gluten-free, vegan" });
  repo.setSettings({ meal_prefs: "I am dairy-free." });
  const first = repo.mealPlanConstraintSnapshot({ hard_diet_constraints: { keys: ["pescatarian", "kosher"] } });
  repo.setProfile({ allergies: "peanuts and shellfish", dietary_restrictions: "vegan; gluten free" });
  const second = repo.mealPlanConstraintSnapshot({
    hard_diet_constraints: { keys: ["kosher", "pescatarian", "kosher"] },
  });
  assert.deepEqual(second.sources, first.sources);
  assert.equal(second.fingerprint, first.fingerprint);
});

test("diet and allergy fingerprints qualify each mention independently", () => {
  repo.setSettings({ meal_prefs: "I am vegan and prefer simple meals" });
  repo.setProfile({ allergies: "allergic to peanuts but not shellfish" });
  const mixed = repo.mealPlanConstraintSnapshot();
  assert.deepEqual(mixed.sources.settings_hard_diets, ["vegan"]);
  assert.deepEqual(mixed.sources.profile_allergies, ["peanut"]);

  repo.setSettings({ meal_prefs: "Prefer vegan meals" });
  repo.setProfile({ allergies: "not allergic to peanuts" });
  const negated = repo.mealPlanConstraintSnapshot();
  assert.deepEqual(negated.sources.settings_hard_diets, []);
  assert.deepEqual(negated.sources.profile_allergies, []);
  assert.notEqual(negated.fingerprint, mixed.fingerprint);
});

test("allergy enforcement preserves multiple positives while excluding per-allergen negations", () => {
  assert.deepEqual(canonicalAllergyKeys("allergic to peanuts and shellfish"), ["peanut", "shellfish"]);
  assert.deepEqual(canonicalAllergyKeys("allergic to peanuts but not shellfish"), ["peanut"]);
  assert.deepEqual(canonicalAllergyKeys("not allergic to peanuts"), []);

  assert.doesNotThrow(() =>
    assertMealAllergenSafe(
      { name: "Shrimp rice bowl", items: "shrimp, rice" },
      "allergic to peanuts but not shellfish",
      "test meal"
    )
  );
  assert.throws(
    () =>
      assertMealAllergenSafe(
        { name: "Peanut rice bowl", items: "peanuts, rice" },
        "allergic to peanuts but not shellfish",
        "test meal"
      ),
    /declared allergen peanut/
  );
});
