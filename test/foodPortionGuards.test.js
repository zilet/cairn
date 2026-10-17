// Guards around the chocolate-bar scaler and the meal-slot heuristics: an amendment that
// only ADDS a row must never re-scale the rows it did not touch, and a stated or negated
// meal word is read as the athlete meant it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amendFoodIngredients,
  recomputeFoodIngredients,
  explicitFoodMealLabel,
  isObviouslySnackCapture,
} from "../dist/foodCapture.js";
import { inferCaptureMeal } from "../dist/chatTurns.js";

const withCoffee = (row) => [
  { item: row.item, amount: row.amount },
  { item: "Coffee", amount: "1 cup", kcal: 5 },
];

for (const row of [
  { item: "Chocolate croissant", amount: "1 piece", kcal: 400 },
  { item: "Chocolate chip cookie", amount: "1 piece", kcal: 280 },
  { item: "Lindt dark chocolate", amount: "1 block", kcal: 530 },
]) {
  test(`adding a coffee leaves an untouched "${row.item}" (${row.amount}) at ${row.kcal} kcal`, () => {
    const r = recomputeFoodIngredients({ ingredients: [row], kcal: row.kcal }, withCoffee(row));
    assert.equal(r.totals.kcal, row.kcal + 5);
  });
}

test("a stored '1 square' carrying a whole bar's calories heals even when restated", () => {
  const prev = { ingredients: [{ item: "Lindt dark chocolate", amount: "1 square", kcal: 530 }], kcal: 530 };
  const r = recomputeFoodIngredients(prev, [{ item: "Lindt dark chocolate", amount: "1 square" }]);
  assert.equal(r.totals.kcal, 53);
});

test("a real quantity change among squares still scales linearly", () => {
  const prev = { ingredients: [{ item: "Dark chocolate", amount: "1 square", kcal: 55 }], kcal: 55 };
  const r = recomputeFoodIngredients(prev, [{ item: "Dark chocolate", amount: "2 squares" }]);
  assert.equal(r.totals.kcal, 110);
});

test("a named meal that did not happen is not the slot", () => {
  assert.equal(explicitFoodMealLabel("I skipped breakfast and just had a coffee"), null);
  assert.equal(explicitFoodMealLabel("no breakfast, a black coffee"), null);
  assert.equal(inferCaptureMeal("I skipped breakfast and just had a coffee", 6), "snack");
});

test("a named main meal outranks a workout or late-night cue", () => {
  assert.equal(explicitFoodMealLabel("had lunch after a pre-workout shake"), "lunch");
  assert.equal(explicitFoodMealLabel("a late-night dinner of pasta"), "dinner");
  assert.equal(isObviouslySnackCapture("post-workout meal: chicken and rice"), false);
  assert.equal(explicitFoodMealLabel("a snack after dinner"), "snack");
});

test("an amendment matches stored rows by whole words, never by substring", () => {
  const prev = {
    ingredients: [
      { item: "Eggs" },
      { item: "Toast" },
      { item: "Butter", kcal: 36 },
      { item: "Peanut butter", kcal: 95 },
    ],
  };
  const names = (rows) => rows.map((r) => r.item);
  assert.deepEqual(names(amendFoodIngredients(prev, [], ["butter"])), ["Eggs", "Toast", "Peanut butter"]);
  const added = amendFoodIngredients({ ingredients: [{ item: "Butter", kcal: 36 }] }, [
    { item: "Peanut butter", kcal: 95 },
  ]);
  assert.deepEqual(names(added), ["Butter", "Peanut butter"]);
  assert.equal(added[0].kcal, 36);
  assert.deepEqual(names(amendFoodIngredients({ ingredients: [{ item: "Cream cheese" }] }, [], ["cheese"])), [
    "Cream cheese",
  ]);
  // A typo'd name still finds its one row; an ambiguous one finds none.
  const fixed = amendFoodIngredients({ ingredients: [{ item: "Lindt Excellence dark chocolate with raspberry" }] }, [
    { item: "Lindt excellenece dark chocolate with raspberry", amount: "1 square" },
  ]);
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].amount, "1 square");
  const twin = amendFoodIngredients(
    { ingredients: [{ item: "Grilled chicken breast" }, { item: "Roast chicken breast" }] },
    [{ item: "Chicken breast", amount: "100 g" }]
  );
  assert.equal(twin.length, 3);
});

test("a change to '1 block' is never scaled by guess", () => {
  const prev = { ingredients: [{ item: "Lindt dark chocolate", amount: "1 bar (100 g)", kcal: 530 }], kcal: 530 };
  const r = recomputeFoodIngredients(prev, [{ item: "Lindt dark chocolate", amount: "1 block" }]);
  assert.ok(
    r.totals.kcal === 530 || r.totals.kcal === undefined || r.totals.kcal > 100,
    "the bar's calories are not silently cut to a piece"
  );
});
