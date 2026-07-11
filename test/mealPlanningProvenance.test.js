import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { buildMealPlanPrompt } from "../dist/prompt.js";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";

function seedFood(summary, daysAgo, hour = 13) {
  const date = localDaysAgo(daysAgo);
  const createdAt = `${date} ${String(hour).padStart(2, "0")}:00:00`;
  db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
     VALUES (?, 'meal', '', ?, 'done', ?)`
  ).run(date, JSON.stringify({ summary, protein_g: 40 }), createdAt);
}

beforeEach(() => {
  resetTables("food_notes", "memory", "meal_plans", "profile", "settings");
});

test("frequent foods retain one-tap recency while reporting distinct logged days", () => {
  seedFood("Chicken and rice bowl", 4);
  seedFood("Chicken & rice bowl", 2);
  seedFood("Tribos Peri Peri takeout", 30);

  const foods = repo.frequentFoods(13);
  const chicken = foods.find((food) => /chicken/i.test(food.summary));
  const tribos = foods.find((food) => /tribos/i.test(food.summary));

  assert.equal(chicken.count, 2);
  assert.equal(chicken.distinct_days, 2);
  assert.equal(tribos.count, 1, "a one-off remains available to the capture surface");
  assert.equal(tribos.distinct_days, 1);
});

test("meal planning excludes one-off food logs and one-day duplicate entries", () => {
  seedFood("Tribos Peri Peri takeout", 30);
  seedFood("Saturday baklava cafe treat", 20);
  seedFood("One-day sushi order", 3, 12);
  seedFood("One-day sushi order", 3, 13);

  const prompt = buildMealPlanPrompt();

  assert.doesNotMatch(prompt, /Tribos Peri Peri/);
  assert.doesNotMatch(prompt, /Saturday baklava/);
  assert.doesNotMatch(prompt, /One-day sushi order/);
  assert.match(prompt, /A food log says what happened once; it does NOT\s+establish a preference/);
});

test("meal planning may reuse a food only after it appears on distinct days", () => {
  seedFood("Home-cooked chicken and rice bowl", 5);
  seedFood("Home-cooked chicken & rice bowl", 2);
  seedFood("Old restaurant phase", 80);
  seedFood("Old restaurant phase", 70);

  const prompt = buildMealPlanPrompt();

  assert.match(prompt, /REPEATED FOOD PATTERNS/);
  assert.match(prompt, /Home-cooked chicken/);
  assert.match(prompt, /across 2 days/);
  assert.match(prompt, /optional dish\/staple ideas, not preferences or future commitments/);
  assert.doesNotMatch(prompt, /Old restaurant phase/);
});

test("meal planning sees durable preferences but not event observations or tentative enrichment", () => {
  repo.addMemory("Had takeout from Tribos Peri Peri last month.", "observation", "enrich");
  repo.addMemory("Prefers a Saturday baklava cafe treat.", "preference", "enrich");
  repo.addMemory(
    "Tribos Peri Peri is a workable local lean takeout option when ordering grilled chicken.",
    "preference",
    "chat-distill",
  );
  repo.addMemory(
    "Can occasionally enjoy a small baklava cafe treat; refined sweets stay infrequent and are not off-limits.",
    "preference",
    "chat-distill",
  );
  repo.addMemory("Usually eats clean, home-cooked whole food meals.", "preference", "user");

  const prompt = buildMealPlanPrompt();

  assert.doesNotMatch(prompt, /Tribos Peri Peri/);
  assert.doesNotMatch(prompt, /Saturday baklava/);
  assert.doesNotMatch(prompt, /small baklava cafe treat/);
  assert.match(prompt, /Usually eats clean, home-cooked whole food meals/);
  assert.match(prompt, /FOOD PREFERENCES & CONSTRAINTS/);
});
