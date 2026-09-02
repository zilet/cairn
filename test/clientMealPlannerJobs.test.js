// The meals surface's memory of a verify outcome.
//
// A verify has three outcomes now, not two: checked-and-clean, checked-with-a
// breach the repair could not clear, and a turn that died carrying the floors the
// SERVER had already computed. Only the badge decides which of those renders, so
// this layer must not pre-filter them — gating on `checked` silently dropped the
// third, which is the one an athlete most needs to see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadPlannerJobs() {
  const context = { Array, JSON, Map, Math, Number, Object, Set, String };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/meal-planner-jobs-client.js"), "utf8"), context);
  return context.CairnMealPlannerJobs;
}

const planResult = (verified) => ({ ok: true, plan: { id: 7 }, verified });

test("every verify outcome the server returns reaches the meals badge", () => {
  const jobs = loadPlannerJobs();

  const clean = { checked: true, adjustments: [], by: "agent" };
  jobs.rememberVerified(planResult(clean));
  assert.deepEqual(jobs.verifiedForPlan(7), clean, "a clean check is remembered");

  // The regression: a dead agent turn still carries the server's own arithmetic.
  const unfinished = {
    checked: false,
    adjustments: [],
    by: "server",
    unresolved: ["Wed totals 1200 kcal, below the lean-safe floor of 2000 kcal."],
  };
  jobs.rememberVerified(planResult(unfinished));
  assert.deepEqual(jobs.verifiedForPlan(7), unfinished, "an unresolved breach must not be dropped here");

  const stillOver = {
    checked: true,
    adjustments: ["raised Tuesday to the floor"],
    by: "agent",
    unresolved: ["Wed totals 1200 kcal, below the lean-safe floor of 2000 kcal."],
  };
  jobs.rememberVerified(planResult(stillOver));
  assert.deepEqual(jobs.verifiedForPlan(7), stillOver);
});

test("nothing is remembered without a verification or a plan to attach it to", () => {
  const jobs = loadPlannerJobs();

  jobs.rememberVerified(planResult(null));
  assert.equal(jobs.verifiedForPlan(7), null, "no verification is nothing to render");

  jobs.rememberVerified({ ok: true, verified: { checked: true, adjustments: [] } });
  jobs.rememberVerified({ ok: false, plan: { id: 7 }, verified: { checked: true, adjustments: [] } });
  assert.equal(jobs.verifiedForPlan(7), null, "a failed op or a plan with no id attaches nothing");

  assert.equal(jobs.verifiedForPlan(null), null);
  assert.equal(jobs.verifiedForPlan(999), null, "an unknown plan id is a miss, not a stale hit");
});
