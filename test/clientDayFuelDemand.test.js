// The Fuel card's big-day line (src/client/day-fuel-client.ts).
//
// One quiet sentence appears on a day that carries the week's bigger work, and the
// three rules that keep it honest are pinned here:
//   • BIG DAYS ONLY — a standard or light day says nothing new,
//   • TODAY ONLY — a past day's card never carries a line about fueling work that is
//     already done (that would be a verdict on what they ate, which the nutrition
//     laws forbid outright),
//   • the TARGET DOES NOT MOVE — every variant says so, and the card's own kcal
//     arithmetic is untouched by the line.
// The sentence also rotates by date, so a stable week does not print one literal for
// days on end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The card reads "today" through the client's own localISO(), so the fixture pins it.
const TODAY = "2026-04-25";

function loadDayFuel(today = TODAY) {
  const context = {
    Array,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Set,
    String,
    art: (_kind, text) => `art:${text}`,
    localISO: () => today,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/date-utils.js"), "utf8"), context);
  // date-utils publishes the real localISO; the fixture's fixed clock wins.
  context.localISO = () => today;
  vm.runInNewContext(readFileSync(join(root, "public/js/day-fuel-client.js"), "utf8"), context);
  return context.CairnDayFuel;
}

function day(overrides = {}) {
  return {
    date: TODAY,
    count: 1,
    totals: { kcal: 800, protein_g: 60, carbs_g: 90, fat_g: 25, fiber_g: 9 },
    known: { kcal: true, protein_g: true, carbs_g: true, fat_g: true, fiber_g: true },
    target: { kcal: 2600, protein_g: 175 },
    remaining: { kcal: 1800, protein_g: 115 },
    entries: [{ id: 1, summary: "Oats", meal: "breakfast", kcal: 800, protein_g: 60 }],
    ...overrides,
  };
}

const BIG_LONG_RUN = { date: TODAY, demand: "big", drivers: ["long run on this day"], evidence: [] };

test("a big day gets one quiet line that biases carbs and leaves the target alone", () => {
  const fuel = loadDayFuel();
  const html = fuel.dayFuelHtml(day({ fuel_demand: BIG_LONG_RUN }));
  assert.match(html, /dayfuel-demand/);
  assert.match(html, /carb/i, "the line is about carbohydrate, not a new number");
  // The card's own arithmetic is untouched: the accepted target still drives it.
  assert.match(html, /1800/, "kcal remaining is unchanged");
  assert.doesNotMatch(html, /new target|raise your target|eat \d+ more/i);
});

test("EVERY variant says the accepted target stays put — none of them proposes a number", () => {
  const drivers = [
    "long run on this day",
    "quality run on this day",
    "heavy lower-body strength day",
    "strength and running on the same day",
    "something the card has no register for",
  ];
  // Four consecutive days walks the whole rotation of each variant set.
  for (const date of ["2026-04-25", "2026-04-26", "2026-04-27", "2026-04-28"]) {
    const fuel = loadDayFuel(date);
    for (const driver of drivers) {
      const line = fuel.dayFuelDemandHtml({ date, fuel_demand: { date, demand: "big", drivers: [driver] } });
      assert.match(
        line,
        /target|number stays as it is/i,
        `"${driver}" on ${date} must say the target itself does not move (got ${line})`
      );
      assert.doesNotMatch(line, /\d/, `and must never carry a number of its own (got ${line})`);
    }
  }
});

test("standard and light days say nothing new", () => {
  const fuel = loadDayFuel();
  for (const demand of ["standard", "light"]) {
    const html = fuel.dayFuelHtml(day({ fuel_demand: { date: TODAY, demand, drivers: [], evidence: [] } }));
    assert.doesNotMatch(html, /dayfuel-demand/, `${demand} days carry no demand line`);
  }
  assert.doesNotMatch(fuel.dayFuelHtml(day()), /dayfuel-demand/, "and neither does a card with no read at all");
});

test("a day that is not today never carries the line — a lived day is not re-litigated", () => {
  const fuel = loadDayFuel();
  const yesterday = "2026-04-24";
  const html = fuel.dayFuelHtml(day({ date: yesterday, fuel_demand: { ...BIG_LONG_RUN, date: yesterday } }));
  assert.doesNotMatch(html, /dayfuel-demand/);
  // (The card's macro row legitimately says "carbs" — the absent thing is the LINE.)
  assert.doesNotMatch(html, /earns its place|carb-forward|carbs to lead/i);
});

test("the empty card still shows the day's shape without turning it into a logging nudge", () => {
  const fuel = loadDayFuel();
  const html = fuel.dayFuelHtml(day({ count: 0, entries: [], fuel_demand: BIG_LONG_RUN }));
  assert.match(html, /dayfuel-demand/);
  assert.doesNotMatch(html, /you should have|behind|missed/i);
});

test("the sentence follows the driver and rotates by date", () => {
  const drivers = {
    "long run on this day": /long run/i,
    "quality run on this day": /quality|fast|hard running/i,
    "heavy lower-body strength day": /leg|lower/i,
    "strength and running on the same day": /both|double|two sessions|strength and a run/i,
  };
  for (const [driver, pattern] of Object.entries(drivers)) {
    const fuel = loadDayFuel();
    const html = fuel.dayFuelDemandHtml({
      date: TODAY,
      fuel_demand: { date: TODAY, demand: "big", drivers: [driver] },
    });
    assert.match(html, pattern, `"${driver}" should speak in its own register (got ${html})`);
  }

  // Same driver, consecutive days: the phrasing is a variant SET, never one literal.
  const lines = new Set();
  for (const date of ["2026-04-25", "2026-04-26", "2026-04-27", "2026-04-28"]) {
    const fuel = loadDayFuel(date);
    lines.add(fuel.dayFuelDemandHtml({ date, fuel_demand: { ...BIG_LONG_RUN, date } }));
  }
  assert.ok(lines.size > 1, "a stable input must not print the same sentence every morning");
});
