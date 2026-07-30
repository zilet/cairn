import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../dist/mcp.js";
import { nutritionRouter } from "../dist/routes/nutrition.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { db, repo } from "./_seed.js";

const today = () => localDateISO();
const ago = (days) => addDaysISO(today(), -days);

function food(date, parsed, { meal = "meal", status = "done" } = {}) {
  return Number(
    db
      .prepare(
        `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status)
         VALUES (?, ?, '', ?, ?)`
      )
      .run(date, meal, JSON.stringify(parsed), status).lastInsertRowid
  );
}

function target(date, { kcal, protein, carbs, fat, source = "checkin" }) {
  db.prepare(
    `INSERT INTO nutrition_targets (effective_date, target_kcal, protein_g, carbs_g, fat_g, source)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(date, kcal, protein, carbs, fat, source);
}

function full(kcal, protein = 170, carbs = 180, fat = 60, fiber = 30) {
  return { kcal, protein_g: protein, carbs_g: carbs, fat_g: fat, fiber_g: fiber };
}

test("nutrition progress emits a complete chronological local-day series with unknowns, not zeroes", () => {
  food(ago(3), { kcal: 500, protein_g: 45, carbs_g: 50, fat_g: 15 }, { meal: "lunch" });
  food(ago(3), { kcal: 700, protein_g: 60, fat_g: 25, fiber_g: 9 }, { meal: "dinner" });
  food(ago(2), full(1600), { status: "pending" });

  const read = repo.nutritionProgress(2); // clamps to 14
  assert.equal(read.window_days, 14);
  assert.equal(read.series.length, 14);
  assert.equal(read.series[0].date, ago(13));
  assert.equal(read.series.at(-1).date, today());

  const mixed = read.series.find((day) => day.date === ago(3));
  assert.equal(mixed.nutrients.kcal, 1200);
  assert.equal(mixed.nutrients.protein_g, 105);
  assert.equal(mixed.nutrients.carbs_g, null, "one unknown entry makes the day's nutrient unknown");
  assert.equal(mixed.nutrients.fiber_g, null);
  assert.equal(mixed.capture, "partial");
  const pending = read.series.find((day) => day.date === ago(2));
  assert.equal(pending.pending_entries, 1);
  assert.equal(pending.capture, "partial");
  const gap = read.series.find((day) => day.date === ago(1));
  assert.equal(gap.logged, false);
  assert.deepEqual(gap.nutrients, { kcal: null, protein_g: null, carbs_g: null, fat_g: null, fiber_g: null });
});

test("averages and trends exclude today's open intake and use known closed-day nutrients only", () => {
  food(ago(2), full(1800, 170, 150, 60, 28));
  food(ago(1), full(2000, 180, 170, 65, 32));
  food(today(), full(470, 45, 35, 14, 5));

  const read = repo.nutritionProgress(14);
  assert.equal(read.series.at(-1).capture, "open");
  assert.equal(read.nutrients.find((item) => item.nutrient === "kcal").average, 1900);
  assert.equal(read.nutrients.find((item) => item.nutrient === "fiber_g").average, 30);
  assert.equal(read.coverage.closed_logged_days, 2);
  assert.equal(read.coverage.logged_days, 2);
  assert.equal(read.coverage.unlogged_days, 11);
  assert.equal(read.coverage.open_day_logged, true);
});

test("today is excluded from food-pattern aggregates and pending coverage", () => {
  food(ago(1), {
    ...full(700),
    nutrition_pattern: { food_quality: "mostly_whole", saturated_fat: "low" },
  });
  const openId = food(
    today(),
    {
      ...full(400),
      nutrition_pattern: { food_quality: "mostly_ultra_processed", saturated_fat: "high" },
    },
    { status: "pending" }
  );
  const read = repo.nutritionProgress(14);
  assert.equal(read.food_quality_estimates.sampled_entries, 1);
  assert.equal(read.food_quality_estimates.food_quality.mostly_whole, 1);
  assert.equal(read.food_quality_estimates.food_quality.mostly_ultra_processed, 0);
  assert.equal(read.coverage.pending_entries, 0);
  assert.deepEqual(read.coverage.pending_entry_ids, [openId]);
});

test("food-quality estimates aggregate only object-shaped sampled entries without extrapolating sparse data", () => {
  food(ago(3), {
    ...full(700),
    nutrition_pattern: {
      food_quality: "mostly_whole",
      saturated_fat: "low",
      saturated_fat_g: 4.2,
      unsaturated_fat_g: 11.8,
      added_sugar: "low",
      sodium: "moderate",
      potassium: "high",
      calcium: "moderate",
      iron: "moderate",
      omega_3_source: true,
      confidence: "medium",
      basis: "user_report",
    },
  });
  food(ago(2), {
    ...full(900),
    nutrition_pattern: {
      food_quality: "mixed",
      saturated_fat: "moderate",
      added_sugar: "high",
      sodium: "high",
      potassium: "low",
      calcium: "unknown",
      iron: "high",
      omega_3_source: false,
      confidence: "low",
      basis: "estimated_from_foods",
    },
  });
  food(ago(2), full(450));

  const estimates = repo.nutritionProgress(14).food_quality_estimates;
  assert.equal(estimates.sampled_entries, 2);
  assert.equal(estimates.total_entries, 3);
  assert.equal(estimates.sampled_days, 2);
  assert.equal(estimates.total_logged_days, 2);
  // The second entry is confidence "low", so it stays out of the band tallies
  // entirely — only the first (medium-confidence) entry moves them.
  assert.equal(estimates.food_quality.mostly_whole, 1);
  assert.equal(estimates.food_quality.mixed, 1);
  assert.equal(estimates.saturated_fat.low, 1);
  assert.equal(estimates.saturated_fat.moderate, 0);
  assert.equal(estimates.added_sugar.high, 0);
  assert.deepEqual(estimates.omega_3_source, { yes: 1, no: 1, unknown: 0 });
  assert.equal(estimates.fat_grams.sampled_entries, 1);
  assert.equal(estimates.fat_grams.average_saturated_fat_g, 4.2);
  assert.equal(estimates.fat_grams.average_unsaturated_fat_g, 11.8);
  assert.match(estimates.note, /2 of 3 recorded entries.*2 of 2 logged days/i);
  assert.match(estimates.note, /not extrapolated/i);
});

test("low-confidence entries leave the food-quality band tallies alone", () => {
  food(ago(4), {
    ...full(700),
    nutrition_pattern: { sodium: "high", confidence: "high", basis: "label" },
  });
  food(ago(3), {
    ...full(700),
    nutrition_pattern: { sodium: "high", confidence: "medium", basis: "user_report" },
  });
  food(ago(2), {
    ...full(700),
    nutrition_pattern: { sodium: "high", confidence: "low", basis: "estimated_from_foods" },
  });
  food(ago(1), {
    ...full(700),
    nutrition_pattern: { sodium: "high", confidence: "low", basis: "estimated_from_foods" },
  });

  const estimates = repo.nutritionProgress(14).food_quality_estimates;
  // Only the two high/medium-confidence entries are evidence of a sodium band,
  // so the athlete-facing count is 2 — and it is a whole number, never "3.5".
  assert.equal(estimates.sodium.high, 2);
  // The provenance histograms still count every entry, unchanged.
  assert.equal(estimates.confidence.high, 1);
  assert.equal(estimates.confidence.medium, 1);
  assert.equal(estimates.confidence.low, 2);
  assert.equal(estimates.sampled_entries, 4);
});

test("every band tally an athlete reads is a whole number, low-confidence entries included", () => {
  food(ago(3), {
    ...full(700),
    nutrition_pattern: { saturated_fat: "high", added_sugar: "high", sodium: "high", confidence: "low", basis: "photo" },
  });

  const estimates = repo.nutritionProgress(14).food_quality_estimates;
  // The lone entry is a rough guess: it shifts no band, but it is still visible
  // as provenance — one low-confidence, photo-based sample.
  assert.equal(estimates.saturated_fat.high, 0);
  assert.equal(estimates.added_sugar.high, 0);
  assert.equal(estimates.sodium.high, 0);
  assert.equal(estimates.confidence.low, 1);
  assert.equal(estimates.basis.photo, 1);
  assert.equal(estimates.sampled_entries, 1);
  const bands = ["saturated_fat", "added_sugar", "sodium", "potassium", "calcium", "iron"];
  for (const band of bands) {
    for (const [name, count] of Object.entries(estimates[band])) {
      assert.ok(Number.isInteger(count), `${band}.${name} must be a whole count, got ${count}`);
    }
  }
});

test("fat-quality gram averages require both sides and reject splits above the entry total", () => {
  food(ago(3), {
    ...full(700, 45, 65, 20),
    nutrition_pattern: { saturated_fat_g: 4, unsaturated_fat_g: 11 },
  });
  food(ago(2), {
    ...full(700, 45, 65, 20),
    nutrition_pattern: { saturated_fat_g: 5, unsaturated_fat_g: null },
  });
  food(ago(1), {
    ...full(700, 45, 65, 20),
    nutrition_pattern: { saturated_fat_g: 15, unsaturated_fat_g: 15 },
  });
  food(ago(4), {
    kcal: 700,
    protein_g: 45,
    carbs_g: 65,
    fiber_g: 10,
    nutrition_pattern: { saturated_fat_g: 3, unsaturated_fat_g: 9 },
  });
  const grams = repo.nutritionProgress(14).food_quality_estimates.fat_grams;
  assert.deepEqual(grams, {
    sampled_entries: 1,
    average_saturated_fat_g: 4,
    average_unsaturated_fat_g: 11,
  });
});

test("adaptive historical targets expire after the review window while explicit targets remain", () => {
  target(ago(60), { kcal: 2200, protein: 175, carbs: 220, fat: 65, source: "checkin" });
  let read = repo.nutritionProgress(35);
  assert.equal(read.series.find((day) => day.date === ago(17)).target, null);
  assert.equal(read.current_reference.carbs_g, null);
  assert.equal(read.current_reference.fat_g, null);
  assert.equal(read.current_reference.source, "longevity_floor");

  target(ago(60), { kcal: 2100, protein: 170, carbs: 200, fat: 60, source: "manual" });
  read = repo.nutritionProgress(35);
  const historical = read.series.find((day) => day.date === ago(17)).target;
  assert.equal(historical.carbs_g, 200);
  assert.equal(historical.provenance.carbs_g.freshness, "explicit");
});

test("historical accepted targets stay attached per day and drive carb-led recorded-intake context", () => {
  target(ago(12), { kcal: 2100, protein: 175, carbs: 210, fat: 62 });
  target(ago(6), { kcal: 2500, protein: 175, carbs: 300, fat: 62 });
  for (let days = 12; days >= 1; days--) {
    food(ago(days), full(1750, 170, 130, 58, 29));
  }
  const read = repo.nutritionProgress(14);
  assert.equal(read.series.find((day) => day.date === ago(10)).target.kcal, 2100);
  assert.equal(read.series.find((day) => day.date === ago(3)).target.carbs_g, 300);
  assert.ok(read.target_alignment.carbs_g.recorded_to_target < 0.7);
  assert.ok(read.target_alignment.protein_g.recorded_to_target > 0.9);
  assert.match(read.read, /recorded energy and carbohydrate/i);
  assert.match(read.next_move, /if these records reflect most of your day.*carbohydrate/i);
});

test("current protein provenance stays formula-derived when the accepted target is below its safety floor", () => {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 200,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "maintain",
  });
  target(today(), { kcal: 2500, protein: 150, carbs: 250, fat: 70 });

  const reference = repo.nutritionProgress(14).current_reference;
  assert.equal(reference.kcal, 2500);
  assert.equal(reference.provenance.kcal.source, "accepted");
  assert.equal(reference.protein_g, 180);
  assert.equal(reference.provenance.protein_g.source, "formula");
  assert.equal(reference.provenance.protein_g.effective_date, null);
  assert.equal(reference.source, "mixed");
});

test("one macro-complete breakfast per day is dense records, never strong or unqualified advice", () => {
  for (let days = 34; days >= 1; days--) {
    food(ago(days), { ...full(1800 + days), summary: "Complete breakfast" }, { meal: "breakfast" });
  }
  const read = repo.nutritionProgress(35);
  assert.equal(read.coverage.macro_known_days, 34);
  assert.equal(read.coverage.observation_density, "dense");
  assert.equal(read.coverage.confidence, "observed");
  assert.equal(read.coverage.completeness_signal, null);
  assert.match(read.coverage.note, /record coverage only/i);
  assert.match(read.coverage.note, /does not prove every meal or the full day was captured/i);
  assert.match(read.read, /^If these records reflect most of your day/i);
  assert.match(read.next_move, /^If these records reflect most of your day/i);
  assert.doesNotMatch(JSON.stringify(read), /streak|grade|score/i);
});

test("manual correction and delete immediately change the progress read", () => {
  const id = food(ago(1), full(1200, 100, 100, 40, 18));
  assert.equal(repo.nutritionProgress(14).nutrients.find((item) => item.nutrient === "fiber_g").average, 18);
  repo.updateFoodNote(id, { fiber_g: 31, kcal: 1500 });
  assert.equal(repo.nutritionProgress(14).nutrients.find((item) => item.nutrient === "fiber_g").average, 31);
  repo.deleteFoodNote(id);
  const after = repo.nutritionProgress(14);
  assert.equal(after.coverage.logged_days, 0);
  assert.equal(after.series.find((day) => day.date === ago(1)).nutrients.kcal, null);
});

test("nutrition progress bounds active nutrition/relevant-watch directives and preserves uncertainty/freshness", () => {
  repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "ApoB",
    directive: "Favor soluble-fiber-rich foods.",
    rationale: "ApoB is worth keeping in view.",
    citation: "https://example.test/guideline",
    uncertain: true,
    trigger_date: ago(2),
  });
  repo.addDirective({
    source: "markers",
    domain: "watch",
    marker: "LDL-C",
    directive: "Recheck with the next panel.",
    trigger_date: ago(5),
  });
  repo.addDirective({
    source: "markers",
    domain: "watch",
    marker: "Testosterone",
    directive: "Unrelated watch item.",
    trigger_date: ago(1),
  });
  const resolved = repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "Iron",
    directive: "Resolved.",
    trigger_date: ago(1),
  });
  repo.updateDirective(resolved.id, { status: "resolved" });

  const context = repo.nutritionProgress(35).health_context;
  assert.equal(context.length, 2);
  assert.equal(context[0].marker, "ApoB");
  assert.equal(context[0].uncertain, true);
  assert.equal(context[0].stale, false);
  assert.equal(context[0].citation, "https://example.test/guideline");
  assert.ok(context.every((item) => item.marker !== "Testosterone" && item.directive !== "Resolved."));
});

function nutritionRoutePayload(path, query = {}) {
  const layer = nutritionRouter.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.get);
  assert.ok(layer);
  let payload;
  layer.route.stack.at(-1).handle(
    { query },
    {
      json(value) {
        payload = value;
        return this;
      },
    }
  );
  return payload;
}

test("REST and MCP nutrition-progress surfaces return the shared deterministic read", async () => {
  food(ago(1), full(1900));
  const rest = nutritionRoutePayload("/nutrition/progress", { days: "14" });
  assert.deepEqual(rest, repo.nutritionProgress(14));

  const server = buildMcpServer();
  const client = new Client({ name: "nutrition-progress-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "get_nutrition_progress", arguments: { days: 14 } });
    const text = result.content.find((entry) => entry.type === "text")?.text;
    assert.deepEqual(JSON.parse(text), rest);
  } finally {
    await client.close();
    await server.close();
  }
});

test("REST and MCP day-intake surfaces preserve numeric legacy fields plus honest known flags", async () => {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 185,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "maintain",
  });
  food(today(), { kcal: 600, protein_g: 45, summary: "Known breakfast" }, { meal: "breakfast" });
  food(today(), { kcal: 700, summary: "Pending lunch" }, { meal: "lunch", status: "pending" });
  const rest = nutritionRoutePayload("/nutrition/day", { date: today() });
  assert.equal(rest.totals.kcal, 1300);
  assert.equal(rest.known.kcal, true);
  assert.equal(rest.totals.protein_g, 45);
  assert.equal(rest.known.protein_g, false);
  assert.equal(typeof rest.remaining?.protein_g, "number");

  const server = buildMcpServer();
  const client = new Client({ name: "day-intake-compat-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "get_day_intake", arguments: { date: today() } });
    const text = result.content.find((entry) => entry.type === "text")?.text;
    assert.deepEqual(JSON.parse(text), rest);
  } finally {
    await client.close();
    await server.close();
  }
});
