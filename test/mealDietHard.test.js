// A whole-diet IDENTITY (vegan/vegetarian/pescatarian/kosher/halal/keto/…) is a
// HARD constraint — as firm as an allergy — not a soft "respect strongly" nudge.
// This suite pins that the meal prompts (plan, swap, check-in, recipe) render a
// HARD dietary-identity block, re-anchor protein onto PLANT sources for a
// plant-forward diet, and scan every place the user could have declared it
// (profile.dietary_restrictions, settings.meal_prefs, the typed instruction/hint),
// while an un-recognized free-text preference ("no cilantro") stays soft.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { completeMealWeek, db, repo } from "./_seed.js";
import * as prompt from "../dist/prompt.js";

beforeEach(() => {
  try { db.prepare("DELETE FROM family_members").run(); } catch {}
  try { db.prepare("UPDATE profile SET allergies = NULL, dietary_restrictions = NULL WHERE id = 1").run(); } catch {}
  try { repo.setSettings({ meal_prefs: "" }); } catch {}
});

// ---------- source 1: profile.dietary_restrictions ----------

test("dietary_restrictions:'vegan' → HARD vegan block + plant protein, never merely 'respect strongly'", () => {
  repo.setProfile({ dietary_restrictions: "vegan" });
  const p = prompt.buildMealPlanPrompt();

  // The HARD block, with the exact allergy-firmness language.
  assert.match(p, /DIETARY IDENTITY \(HARD CONSTRAINT/);
  assert.match(p, /VEGAN \(HARD RULE — as firm as an allergy; EVERY meal, item, recipe, and substitution MUST comply\)/);
  assert.match(p, /NO meat, poultry, fish, seafood, dairy, eggs, honey, gelatin, or any animal-derived ingredient\./);

  // Plant-protein guidance replaces the animal-protein / oily-fish anchors.
  assert.match(p, /Anchor EVERY meal on PLANT protein/);
  assert.match(p, /Do NOT use meat, poultry, or fish to hit protein/);
  assert.doesNotMatch(p, /Oily fish 2-3x\/week/, "oily-fish anchor is gone for a vegan");

  // Vegan is NOT rendered as a soft preference.
  assert.doesNotMatch(p, /DIETARY RESTRICTIONS \(respect strongly\): vegan/i);
});

test("vegetarian and pescatarian each get their own HARD rule text", () => {
  repo.setProfile({ dietary_restrictions: "vegetarian" });
  let p = prompt.buildMealPlanPrompt();
  assert.match(p, /VEGETARIAN \(HARD RULE/);
  assert.match(p, /NO meat, poultry, fish, or seafood/);
  assert.match(p, /Anchor EVERY meal on PLANT protein/); // vegetarian is plant-forward

  repo.setProfile({ dietary_restrictions: "pescatarian" });
  p = prompt.buildMealPlanPrompt();
  assert.match(p, /PESCATARIAN \(HARD RULE/);
  assert.match(p, /NO meat or poultry \(fish & seafood are allowed\)/);
  // Pescatarian still eats fish → the oily-fish longevity anchor stays.
  assert.match(p, /Oily fish 2-3x\/week/);
});

test("kosher and halal render as plain HARD rules", () => {
  repo.setProfile({ dietary_restrictions: "kosher" });
  let p = prompt.buildMealPlanPrompt();
  assert.match(p, /KOSHER \(HARD RULE/);

  repo.setProfile({ dietary_restrictions: "halal" });
  p = prompt.buildMealPlanPrompt();
  assert.match(p, /HALAL \(HARD RULE/);
});

// ---------- source 2: settings.meal_prefs ----------

test("meal_prefs mentioning 'vegan' elevates to the HARD vegan block", () => {
  repo.setSettings({ meal_prefs: "I train fasted; also I am vegan." });
  const p = prompt.buildMealPlanPrompt();
  assert.match(p, /VEGAN \(HARD RULE/);
  assert.match(p, /Anchor EVERY meal on PLANT protein/);
});

// ---------- source 3: the typed instruction / hint ----------

test("buildMealPlanPrompt(\"I'm vegan\") instruction elevates to the HARD vegan block", () => {
  const p = prompt.buildMealPlanPrompt("I'm vegan, plan my week");
  assert.match(p, /VEGAN \(HARD RULE/);
  assert.match(p, /Anchor EVERY meal on PLANT protein/);
});

// ---------- non-diet free-text stays soft ----------

test("a non-diet free-text preference ('no cilantro') stays soft, no HARD identity block", () => {
  repo.setProfile({ dietary_restrictions: "no cilantro" });
  const p = prompt.buildMealPlanPrompt();
  assert.doesNotMatch(p, /DIETARY IDENTITY \(HARD CONSTRAINT/);
  assert.match(p, /DIETARY RESTRICTIONS \(respect strongly\):/);
  assert.match(p, /no cilantro/);
});

test("a recognized diet mixed with free-text: diet → HARD, remainder → soft", () => {
  repo.setProfile({ dietary_restrictions: "vegan, no cilantro" });
  const p = prompt.buildMealPlanPrompt();
  assert.match(p, /VEGAN \(HARD RULE/);
  // The leftover ('no cilantro') still surfaces softly; 'vegan' is stripped from it.
  assert.match(p, /DIETARY RESTRICTIONS \(respect strongly\): no cilantro/);
  assert.doesNotMatch(p, /respect strongly\): vegan/i);
});

// ---------- word-boundary matching ----------

test("word-boundary: 'novegan' / a substring does NOT misfire", () => {
  repo.setProfile({ dietary_restrictions: "novegan blend, veganic soil is fine" });
  const p = prompt.buildMealPlanPrompt();
  assert.doesNotMatch(p, /DIETARY IDENTITY \(HARD CONSTRAINT/);
});

// ---------- the block reaches every meal-generating prompt ----------

test("the HARD vegan block reaches the swap, check-in, and recipe prompts", () => {
  repo.setProfile({ dietary_restrictions: "vegan" });

  const plan = repo.createMealPlan("stub", "", completeMealWeek({
    daily_kcal: 2200, daily_protein_g: 170,
    days: [{ day: "Mon", meals: [{ name: "Tofu scramble", items: "tofu, spinach", kcal: 500, protein_g: 35, carbs_g: 30, fat_g: 20 }] }],
  }));

  const swap = prompt.buildMealSwapPrompt({ plan, day: "Mon", mealIndex: 0 });
  assert.match(swap, /VEGAN \(HARD RULE/);
  assert.match(swap, /Anchor EVERY meal on PLANT protein/);

  const checkin = prompt.buildNutritionCheckinPrompt();
  assert.match(checkin, /VEGAN \(HARD RULE/);
  assert.match(checkin, /PLANT-PROTEIN ANCHOR/);

  const recipe = prompt.buildRecipePrompt({ plan, day: "Mon", mealIndex: 0 });
  assert.match(recipe, /VEGAN \(HARD RULE/);
  assert.match(recipe, /Anchor EVERY meal on PLANT protein/);
});

test("meal-swap picks up 'I'm vegan now' from the free-text hint", () => {
  const plan = repo.createMealPlan("stub", "", completeMealWeek({
    daily_kcal: 2200, daily_protein_g: 170,
    days: [{ day: "Mon", meals: [{ name: "Chicken bowl", items: "chicken, rice", kcal: 600, protein_g: 45, carbs_g: 50, fat_g: 18 }] }],
  }));
  const swap = prompt.buildMealSwapPrompt({ plan, day: "Mon", mealIndex: 0, hint: "I'm vegan now" });
  assert.match(swap, /VEGAN \(HARD RULE/);
});
