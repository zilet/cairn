import assert from "node:assert/strict";
import test from "node:test";
import { seedDemo } from "../dist/demoSeed.js";
import { assessMealPlanAdequacy } from "../dist/repo/nutrition-safety.js";
import * as repo from "../dist/repo.js";

test("the demo seeds a complete current meal week that passes the production adequacy gate", () => {
  seedDemo();
  const plan = repo.currentMealPlan();
  assert.ok(plan);
  assert.equal(plan.status, "applied");
  assert.equal(plan.parsed.days.length, 7);
  const adequacy = assessMealPlanAdequacy(plan.parsed);
  assert.equal(adequacy.ok, true);
  assert.equal(adequacy.checked, true);
  const target = repo.computeGoalCheck().effective_target;
  assert.equal(target.target_kcal, 2050, "the populated plan uses the athlete-reviewed effective target");
  assert.ok(
    adequacy.days.every((day) => Math.abs(day.kcal - target.target_kcal) <= 100),
    "every demo day stays inside the production coordination boundary"
  );
});
