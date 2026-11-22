// The "why" under each food guide and the two-week pattern read (repo/fuel-guide-why.ts,
// repo/fuel-pattern.ts): the explanation is made of the athlete's own weight and goal, the
// pattern speaks only from closed complete days, and every word holds the reading grammar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { fuelGuideWhys } from "../dist/repo/fuel-guide-why.js";
import { fuelPattern, PATTERN_MIN_DAYS } from "../dist/repo/fuel-pattern.js";
import { dayFuelGuides, nutritionDayRead } from "../dist/repo/fuel-guides.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const today = () => localDateISO();
const ago = (n) => addDaysISO(today(), -n);

function whyInput(overrides = {}) {
  return {
    mode: "lose",
    kg: 69.5,
    weight_words: "153 lb",
    weight_unit: "lb",
    kcal: 2163,
    protein_g: 175,
    own_target: true,
    carbs: { tier: "high", band: { low: 6, high: 10 }, within_target: true, high_g: 250, yours: false },
    fat: { low_g: 50, yours: false, share_low_g: 48.1, share_high_g: 84.1 },
    fiber: { per_kcal: true, lab_led: false },
    saturated_fat: { lipid: true },
    ...overrides,
  };
}

test("each number is explained in the athlete's own weight, with its effect and its source", () => {
  const whys = fuelGuideWhys(whyInput());
  assert.deepEqual(Object.keys(whys).sort(), ["carbs", "energy", "fat", "fiber", "omega_3", "protein", "saturated_fat"]);
  assert.match(whys.protein.made_of, /^175 g is 2\.5 g per kg at 153 lb\.$/);
  assert.match(whys.carbs.made_of, /6–10 g per kg, 415–695 g at 153 lb\. Your target holds less than that while you cut, so this is the top third/);
  assert.match(whys.carbs.effect, /30–60 g an hour/);
  assert.match(whys.fat.made_of, /is 48–84 g, with a fallback minimum of half a gram per kg \(35 g at 153 lb\)/);
  assert.match(whys.energy.made_of, /^Your own number\. .*at 153 lb that is 0\.8–1\.5 lb a week\.$/);
  assert.match(whys.saturated_fat.made_of, /^6% of today's energy/);
  for (const [key, why] of Object.entries(whys)) {
    for (const part of [why.made_of, why.effect, why.source]) {
      assert.equal(violatesReadingGrammar(part), null, `${key}: "${part}"`);
    }
    assert.ok(why.effect.length > 20, `${key} says what it does`);
  }
});

test("the explanation follows the goal and the day: no cut words outside a cut, a lighter day says so", () => {
  const whys = fuelGuideWhys(
    whyInput({
      mode: "maintain",
      weight_words: "70 kg",
      weight_unit: "kg",
      carbs: { tier: "light", band: { low: 3, high: 5 }, within_target: false, high_g: 300, yours: false },
      saturated_fat: { lipid: false },
    })
  );
  assert.doesNotMatch(JSON.stringify(whys), /\bcut\b|cutting/);
  assert.match(whys.carbs.made_of, /a lighter day is 3–5 g per kg, 210–350 g at 70 kg\.$/);
  assert.match(whys.carbs.effect, /fewer carbs/);
  assert.equal(whys.saturated_fat.made_of, "A tenth of today's energy.");
  assert.equal(whys.energy.source, "");
  assert.equal(fuelGuideWhys(whyInput({ kcal: null, protein_g: null, carbs: null, fat: null, saturated_fat: null })).energy, undefined);
});

function food(date, parsed, { meal = "meal", eatenAt = null } = {}) {
  db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, eaten_at) VALUES (?, ?, '', ?, 'done', ?)`
  ).run(date, meal, JSON.stringify(parsed), eatenAt);
}

// A day the log reads complete: a morning and an evening meal carrying real energy.
function fullDay(date, { kcal = 1800, protein = 170, carbs = 150, fat = 55, fiber = 32 } = {}) {
  const half = (n) => Math.round(n / 2);
  const meal = { kcal: half(kcal), protein_g: half(protein), carbs_g: half(carbs), fat_g: half(fat), fiber_g: half(fiber) };
  food(date, meal, { meal: "breakfast", eatenAt: "08:00" });
  food(date, meal, { meal: "dinner", eatenAt: "19:30" });
}

function cutting() {
  repo.setProfile({
    age: 44,
    height_cm: 170,
    weight_lb: 153,
    sex: "male",
    activity_factor: 1.55,
    goal_mode: "lose",
    goal_weight_lb: 148,
    goal_date: addDaysISO(today(), 84),
  });
  repo.setNutritionTarget({ target_kcal: 2160, protein_g: 175, source: "user", effective_date: ago(30) });
}

test("too few complete days say nothing, and a partial day never counts", () => {
  cutting();
  for (let n = 1; n < PATTERN_MIN_DAYS; n++) fullDay(ago(n));
  food(ago(8), { kcal: 300, protein_g: 20, carbs_g: 30, fat_g: 8, fiber_g: 2 }, { meal: "snack", eatenAt: "15:00" });
  assert.equal(fuelPattern(today()), null);
});

test("complete days landing under the athlete's own number, with weight falling faster than the line: the lever is energy", () => {
  cutting();
  for (let n = 1; n <= 10; n++) fullDay(ago(n));
  // About a pound a week, against a line that needs well under half of that.
  for (let n = 21; n >= 0; n -= 3) repo.logWeight(153 + (n / 7) * 1.0, ago(n));
  const pattern = fuelPattern(today());
  assert.equal(pattern.complete_days, 10);
  assert.equal(pattern.title, "Your last 10 complete days");
  const line = (key) => pattern.lines.find((l) => l.key === key)?.words;
  assert.equal(line("energy"), "Energy averaged about 1,800 kcal, about 360 under your number.");
  assert.equal(line("protein"), "Protein averaged 170 g, about on your number.");
  assert.match(line("fiber"), /^Fiber reached its floor on 10 of 10 days\.$/);
  assert.equal(pattern.lever.key, "energy");
  assert.match(pattern.lever.words, /^Your weight is moving about 1 lb a week, and the line you set needs 0\.\d\. Eating closer to your own number/);
  assert.match(pattern.lever.why, /% of your weight a week, inside the 0\.5–1% of body weight a week/);
  for (const words of [...pattern.lines.map((l) => l.words), pattern.lever.words, pattern.lever.why]) {
    assert.equal(violatesReadingGrammar(words), null, words);
    assert.doesNotMatch(words, /missed|failed|should|must|low\b/i, words);
  }
});

test("days landing on the number ask for no change", () => {
  cutting();
  for (let n = 1; n <= 7; n++) fullDay(ago(n), { kcal: 2150, protein: 176, carbs: 235, fat: 55, fiber: 34 });
  const pattern = fuelPattern(today());
  assert.equal(pattern.lines.find((l) => l.key === "energy").words, "Energy averaged about 2,150 kcal, close to your number.");
  assert.equal(pattern.lever, null);
});

test("the day read carries the explanations, and the pattern only for the day being lived", () => {
  cutting();
  for (let n = 1; n <= 6; n++) fullDay(ago(n));
  const read = nutritionDayRead(today());
  assert.deepEqual(read.guides.explain.map((e) => e.key), ["protein", "energy"]);
  assert.ok(read.guides.guides.find((g) => g.key === "fiber").why.effect);
  assert.equal(read.guides.pattern.complete_days, 6);
  const past = dayFuelGuides(ago(2), { today: today() });
  assert.equal(past.pattern, null, "a past day's page does not re-read the pattern");
  assert.equal(dayFuelGuides(ago(2), { today: today(), gramsOnly: true }).explain, undefined);
});
