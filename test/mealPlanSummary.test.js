// listMealPlansSummary() (src/repo/nutrition.ts) — the slim projection of
// listMealPlans() that the Today side loader (and GET /mealplans?fields=summary)
// use instead of the full parsed_json/raw_output payload. It must stay small, keep
// only meal names, and carry the server's own adequacy verdict so a client can
// pick the canonical current plan without the kcal/protein totals this shape omits.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { completeMealWeek, db, repo, resetTables } from "./_seed.js";

beforeEach(() => resetTables("meal_plans", "profile"));

function insertPlan(status, parsed, weekOf = "2026-01-02") {
  const info = db
    .prepare(`INSERT INTO meal_plans (week_of, agent, raw_output, parsed_json, status) VALUES (?, ?, ?, ?, ?)`)
    .run(weekOf, "stub", "raw agent narration that never reaches the summary", JSON.stringify(parsed), status);
  return Number(info.lastInsertRowid);
}

test("the summary payload stays small — names only, no macros/ingredients/raw_output", () => {
  for (let i = 0; i < 6; i++)
    insertPlan(i === 0 ? "accepted" : "superseded", completeMealWeek({}), `2026-01-${String(i + 1).padStart(2, "0")}`);

  const summary = repo.listMealPlansSummary(6);
  const bytes = Buffer.byteLength(JSON.stringify(summary));
  assert.ok(bytes < 10_000, `expected < 10,000 bytes, got ${bytes}`);

  for (const plan of summary) {
    assert.equal(plan.parsed, undefined, "no parsed blob");
    assert.equal(plan.parsed_json, undefined, "no raw parsed_json string");
    assert.equal(plan.raw_output, undefined, "no raw_output");
    for (const day of plan.days) {
      for (const meal of day.meals) {
        assert.deepEqual(Object.keys(meal), ["name"], "a meal is only its name");
      }
    }
  }
});

test("adequate mirrors assessMealPlanAdequacy — a complete week is adequate, a one-day legacy row is not", () => {
  const completeId = insertPlan("accepted", completeMealWeek({}), "2026-01-02");
  const partialId = insertPlan(
    "kept",
    { days: [{ day: "Mon", meals: [{ name: "Legacy single day", kcal: 500, protein_g: 30 }] }] },
    "2026-01-03"
  );

  const summary = repo.listMealPlansSummary(10);
  const complete = summary.find((p) => p.id === completeId);
  const partial = summary.find((p) => p.id === partialId);

  assert.equal(complete.adequate, true);
  assert.equal(partial.adequate, false);
});

test("the first meal name of today's day survives the projection", () => {
  const id = insertPlan(
    "accepted",
    completeMealWeek({
      days: [{ day: "Mon", meals: [{ name: "Salmon rice bowl", kcal: 900, protein_g: 60 }] }],
    }),
    "2026-01-02"
  );

  const summary = repo.listMealPlansSummary(6);
  const plan = summary.find((p) => p.id === id);
  const monday = plan.days.find((d) => d.day.toLowerCase().startsWith("mon"));
  assert.equal(monday.meals[0].name, "Salmon rice bowl");
});

test("constraint_state carries through so a refresh-needed plan is still visible to the client", () => {
  const plan = repo.createMealPlan(
    "stub",
    "",
    completeMealWeek({
      days: Array.from({ length: 7 }, (_, i) => ({
        day: `Day ${i + 1}`,
        meals: [{ name: "Peanut tofu bowl", items: "peanuts, tofu, rice", kcal: 2200, protein_g: 170 }],
      })),
    })
  );
  repo.acceptMealPlan(plan.id);
  repo.setProfile({ allergies: "peanuts" });

  const summary = repo.listMealPlansSummary(6);
  const found = summary.find((p) => p.id === plan.id);
  assert.equal(found.constraint_state?.status, "refresh_needed");
});
