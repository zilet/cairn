import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDayFuel() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    String,
    art: () => "<svg></svg>",
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/day-fuel-client.js"), "utf8"), context);
  return context.CairnDayFuel;
}

test("day fuel helper exposes stable meal labels", () => {
  const fuel = loadDayFuel();

  assert.equal(fuel.MEAL_LABEL.breakfast, "Breakfast");
  assert.equal(fuel.MEAL_LABEL.snack, "Snack");
  assert.equal(fuel.mealLabelHtml("custom <slot>"), "custom &lt;slot&gt;");
});

test("day fuel helper renders calm empty review state", () => {
  const fuel = loadDayFuel();
  const html = fuel.dayFuelHtml({ count: 0, totals: {} });

  assert.match(html, /Today's fuel/);
  assert.match(html, /Nothing logged yet today &mdash; log a meal/);
  assert.match(html, /id="dayFuelAsk"/);
});

test("day fuel helper renders totals, remaining fuel, and editable rows", () => {
  const fuel = loadDayFuel();
  const html = fuel.dayFuelHtml({
    count: 2,
    totals: { kcal: 844.4, protein_g: 77.6 },
    target: { kcal: 2200 },
    remaining: { kcal: 940.2, protein_g: 42.1 },
    entries: [
      { id: 7, summary: "Eggs & oats", meal: "breakfast", kcal: 620, protein_g: 45 },
      { id: 8, summary: "Shake <vanilla>", meal: "snack", protein_g: 33, enrichment_status: "pending" },
    ],
  });

  assert.match(html, /2 items/);
  assert.match(html, /data-cu="844"/);
  assert.match(html, /data-cu="78"/);
  assert.match(html, /data-cu="940">0<\/span> kcal left &middot; 42 g protein to go/);
  assert.match(html, /data-fooditem="7"/);
  assert.match(html, /Eggs &amp; oats/);
  assert.match(html, /Breakfast/);
  assert.match(html, /Shake &lt;vanilla&gt;/);
  assert.match(html, /&middot; estimating&hellip;/);
  assert.match(html, /&mdash; &middot; 33g P/);
});

test("day fuel helper renders complete-fuel state without pressure", () => {
  const fuel = loadDayFuel();
  const html = fuel.dayFuelHtml({
    count: 1,
    totals: { kcal: 2201, protein_g: 150 },
    target: { kcal: 2200 },
    remaining: { kcal: -1, protein_g: 0 },
    entries: [{ id: 1, summary: "Dinner", meal: "dinner", kcal: 900 }],
  });

  assert.match(html, /Fuel's in for today\./);
  assert.doesNotMatch(html, /consumed/i);
});
