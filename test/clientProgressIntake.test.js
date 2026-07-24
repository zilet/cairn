import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function load() {
  const context = { window: {}, URL, console };
  vm.runInNewContext(readFileSync(new URL("../public/js/date-utils.js", import.meta.url), "utf8"), context);
  vm.runInNewContext(readFileSync(new URL("../public/js/html-utils.js", import.meta.url), "utf8"), context);
  vm.runInNewContext(readFileSync(new URL("../public/js/progress-intake-client.js", import.meta.url), "utf8"), context);
  return context.window.CairnProgressIntake;
}

function fixture() {
  const dates = ["2026-07-21", "2026-07-22", "2026-07-23"];
  return {
    window_days: 3,
    since: dates[0],
    through: dates[2],
    read: "Recorded <energy> is useful context.",
    next_move: "Keep & review.",
    coverage: {
      logged_days: 2,
      closed_logged_days: 1,
      unlogged_days: 1,
      macro_known_days: 1,
      partial_days: 0,
      open_day_logged: true,
      pending_entries: 0,
      logged_fraction: 0.67,
      macro_known_fraction: 0.5,
      observation_density: "sparse",
      confidence: "tentative",
      completeness_signal: null,
      note: "Macro-known does not prove every meal was captured.",
    },
    current_reference: {
      kcal: 2475,
      protein_g: 175,
      carbs_g: 303,
      fat_g: 62,
      fiber_g: 30,
      source: "accepted",
      effective_date: dates[2],
    },
    nutrients: [
      {
        nutrient: "kcal",
        label: "Recorded energy",
        unit: "kcal",
        average: 1800,
        known_days: 1,
        trend: "unknown",
        change: null,
        reference: 2475,
        reference_label: "current accepted reference",
      },
      {
        nutrient: "protein_g",
        label: "Protein",
        unit: "g",
        average: 170,
        known_days: 1,
        trend: "unknown",
        change: null,
        reference: 175,
        reference_label: "current accepted reference",
      },
      {
        nutrient: "carbs_g",
        label: "Carbohydrate",
        unit: "g",
        average: 130,
        known_days: 1,
        trend: "unknown",
        change: null,
        reference: 303,
        reference_label: "current accepted reference",
      },
      {
        nutrient: "fat_g",
        label: "Fat",
        unit: "g",
        average: 58,
        known_days: 1,
        trend: "unknown",
        change: null,
        reference: 62,
        reference_label: "current accepted reference",
      },
      {
        nutrient: "fiber_g",
        label: "Fiber",
        unit: "g",
        average: 29,
        known_days: 1,
        trend: "unknown",
        change: null,
        reference: 30,
        reference_label: "longevity floor",
      },
    ],
    target_alignment: {},
    energy_split: { known_days: 1, protein_pct: 30, carbs_pct: 40, fat_pct: 30 },
    food_quality_estimates: {
      sampled_entries: 2,
      sampled_days: 1,
      total_entries: 7,
      total_logged_days: 2,
      note: "Entry estimates from <2 of 7>; not extrapolated to the rest of the window.",
      food_quality: { mostly_whole: 1, mixed: 1, mostly_ultra_processed: 0, unknown: 0 },
      saturated_fat: { low: 1, moderate: 1, high: 0, unknown: 0 },
      added_sugar: { low: 1, moderate: 0, high: 1, unknown: 0 },
      sodium: { low: 0, moderate: 1, high: 1, unknown: 0 },
      potassium: { low: 0, moderate: 0, high: 2, unknown: 0 },
      calcium: { low: 0, moderate: 1, high: 0, unknown: 1 },
      iron: { low: 0, moderate: 1, high: 1, unknown: 0 },
      omega_3_source: { yes: 1, no: 0, unknown: 1 },
      confidence: { low: 1, medium: 1, high: 0, unknown: 0 },
      basis: { label: 0, user_report: 1, estimated_from_foods: 1, photo: 0, unknown: 0 },
      fat_grams: { sampled_entries: 1, average_saturated_fat_g: 4.2, average_unsaturated_fat_g: 11.8 },
    },
    series: [
      {
        date: dates[0],
        logged: true,
        entry_count: 3,
        pending_entries: 0,
        capture: "macro_known",
        nutrients: { kcal: 1800, protein_g: 170, carbs_g: 130, fat_g: 58, fiber_g: 29 },
        known: { kcal: true, protein_g: true, carbs_g: true, fat_g: true, fiber_g: true },
        target: {
          kcal: 2075,
          protein_g: 175,
          carbs_g: 205,
          fat_g: 62,
          source: "checkin",
          effective_date: "2026-07-11",
        },
      },
      {
        date: dates[1],
        logged: false,
        entry_count: 0,
        pending_entries: 0,
        capture: "unlogged",
        nutrients: { kcal: null, protein_g: null, carbs_g: null, fat_g: null, fiber_g: null },
        known: { kcal: false, protein_g: false, carbs_g: false, fat_g: false, fiber_g: false },
        target: {
          kcal: 2225,
          protein_g: 175,
          carbs_g: 240,
          fat_g: 62,
          source: "checkin",
          effective_date: "2026-07-15",
        },
      },
      {
        date: dates[2],
        logged: true,
        entry_count: 1,
        pending_entries: 0,
        capture: "open",
        nutrients: { kcal: 470, protein_g: 45, carbs_g: 35, fat_g: 14, fiber_g: 5 },
        known: { kcal: true, protein_g: true, carbs_g: true, fat_g: true, fiber_g: true },
        target: {
          kcal: 2475,
          protein_g: 175,
          carbs_g: 303,
          fat_g: 62,
          source: "checkin",
          effective_date: "2026-07-23",
        },
      },
    ],
    health_context: [
      {
        id: 1,
        domain: "nutrition",
        marker: "<ApoB>",
        directive: "More soluble fiber & fish.",
        rationale: "Cited <context>",
        citation: "javascript:alert(1)",
        uncertain: true,
        trigger_date: "2026-07-20",
        acute: false,
        age_days: 3,
        stale: false,
        transient: false,
        transient_reason: null,
        stale_measurement: false,
        rescan_reason: null,
      },
    ],
    frame: "Informational, not medical advice.",
  };
}

test("intake renderer leads with meaning, shows honest gaps, and escapes server text", () => {
  const intake = load();
  const html = intake.intakeBodyHtml(fixture(), "kcal");
  assert.match(html, /Recorded &lt;energy&gt; is useful context/);
  assert.match(html, /Record coverage is sparse/);
  assert.match(html, /data-intake-nutrient="kcal"/);
  assert.match(html, /Jul 22: unlogged day/);
  assert.match(html, /class="nprog-day gap"/);
  assert.match(html, /Daily marks follow the accepted reference effective on each date/);
  assert.doesNotMatch(html, /javascript:alert/);
  assert.match(html, /&lt;ApoB&gt;/);
  assert.match(html, /Food quality estimates/);
  assert.match(html, /4\.2 g saturated and 11\.8 g unsaturated estimated average per sampled entry across 1 entry/);
  assert.match(html, /Entry estimates from &lt;2 of 7&gt;; not extrapolated/);
  assert.doesNotMatch(html, /whole month|all 3 days/i);
  assert.match(html, /Informational, not medical advice/);
});

test("intake timelines expose accepted historical targets and never coerce null into a value", () => {
  const intake = load();
  const html = intake.intakeChartHtml(fixture(), "carbs_g");
  assert.match(html, /bottom:67\.7%/); // 205 relative to the 303 ceiling
  assert.match(html, /Carbs unknown|unlogged day/);
  assert.doesNotMatch(html, /2026-07-22: 0 g recorded/);
  assert.match(html, /current 303 g/);
  assert.doesNotMatch(html, />2026-07-\d{2}</);
});

test("intake timelines name a formula-derived protein reference honestly", () => {
  const intake = load();
  const progress = fixture();
  progress.nutrients.find((item) => item.nutrient === "protein_g").reference_label = "current formula reference";
  const html = intake.intakeChartHtml(progress, "protein_g");
  assert.match(html, /Daily marks follow the formula reference effective on each date/);
  assert.doesNotMatch(html, /Daily marks follow the accepted reference effective on each date/);
});

test("intake unavailable state is calm and does not imply recorded data was lost", () => {
  assert.match(load().unavailableHtml(), /isn't available right now.*recorded food is still safe/i);
});
