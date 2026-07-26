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
    known: { kcal: true, protein_g: true, carbs_g: false, fat_g: false, fiber_g: false },
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

test("day fuel helper uses known flags instead of displaying legacy zeroes for partial totals", () => {
  const fuel = loadDayFuel();
  const html = fuel.dayFuelHtml({
    count: 1,
    totals: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
    known: { kcal: false, protein_g: false, carbs_g: false, fat_g: false, fiber_g: false },
    target: { kcal: 2200, protein_g: 170 },
    remaining: { kcal: 2200, protein_g: 170 },
    entries: [{ id: 1, summary: "Photo meal", enrichment_status: "pending" }],
  });

  assert.match(html, /&mdash;/);
  assert.doesNotMatch(html, /data-cu="0"/);
  assert.doesNotMatch(html, /2200.*kcal left/i);
});

test("a recorded eating time reads in plain words next to the meal", () => {
  const fuel = loadDayFuel();
  const html = fuel.dayFuelHtml({
    count: 1,
    totals: { kcal: 900 },
    entries: [{ id: 1, summary: "Steak", meal: "dinner", eaten_at: "21:00", logged_at: "9:00 PM", kcal: 900 }],
  });

  assert.match(html, /Dinner &middot; 9:00 PM/);
});

test("an entry with no recorded time looks completely ordinary — no dash, no empty slot", () => {
  const fuel = loadDayFuel();
  const html = fuel.dayFuelHtml({
    count: 2,
    totals: { kcal: 900 },
    entries: [
      // logged_at is populated but eaten_at is NOT — the server falls back to the
      // WRITE time, which for an entry remembered later is the moment it was typed.
      // Showing it here would put "8:40 AM" under last night's dinner, which is the
      // precise confusion this feature exists to remove. eaten_at gates the display.
      { id: 1, summary: "Leftovers", meal: "lunch", logged_at: "8:40 AM", kcal: 500 },
      { id: 2, summary: "Unnamed", logged_at: "8:41 AM", kcal: 400 },
    ],
  });

  // The meal label stands alone, with no trailing separator waiting for a time.
  assert.match(html, /<span class="dayfuel-meal lbl">Lunch<\/span>/);
  assert.doesNotMatch(html, /8:4[01]\s*AM/, "an unstated time is never shown as if it were the eating time");
  // An entry with neither meal nor stated time renders no meta line at all, rather
  // than an empty element that reads as something missing.
  assert.doesNotMatch(html, /<span class="dayfuel-meal lbl"><\/span>/);
  assert.doesNotMatch(html, /Lunch &middot;\s*</);
});

test("an eating time alone still reads, without inventing a meal slot for it", () => {
  const fuel = loadDayFuel();
  const html = fuel.dayFuelHtml({
    count: 1,
    totals: { kcal: 300 },
    entries: [{ id: 1, summary: "Something", eaten_at: "15:40", logged_at: "3:40 PM", kcal: 300 }],
  });

  assert.match(html, /<span class="dayfuel-meal lbl">3:40 PM<\/span>/);
});
