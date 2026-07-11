import assert from "node:assert/strict";
import test from "node:test";
import {
  draftMealPlan,
  nutritionCheckin,
  runHealthReview,
  suggestSession,
} from "../dist/coachOps.js";
import { db } from "./_seed.js";

test("user-facing coaching operations degrade calmly after an exhausted semantic rotation", async () => {
  const before = {
    meals: db.prepare("SELECT COUNT(*) AS n FROM meal_plans").get().n,
    reviews: db.prepare("SELECT COUNT(*) AS n FROM health_reviews").get().n,
    proposals: db.prepare("SELECT COUNT(*) AS n FROM plan_proposals").get().n,
  };

  // The offline stub intentionally returns a valid plan-proposal object. That is
  // the wrong semantic contract for each operation below, so its repair attempt
  // is rejected and the one-agent rotation is exhausted.
  const session = await suggestSession("stub", { minutes: 35, focus: "calm-failure-contract" });
  const mealPlan = await draftMealPlan("stub", "calm failure contract");
  const checkin = await nutritionCheckin("stub", 21);
  const review = await runHealthReview("stub");

  for (const result of [session, mealPlan, checkin, review]) {
    assert.equal(result.ok, false);
    assert.equal(result.agent, null);
    assert.equal(result.tried.length, 1);
    assert.equal(result.tried[0].agent, "stub");
    assert.match(result.tried[0].error, /outside the requested contract/);
  }

  assert.deepEqual(
    {
      meals: db.prepare("SELECT COUNT(*) AS n FROM meal_plans").get().n,
      reviews: db.prepare("SELECT COUNT(*) AS n FROM health_reviews").get().n,
      proposals: db.prepare("SELECT COUNT(*) AS n FROM plan_proposals").get().n,
    },
    before,
    "failed coaching runs must not persist empty drafts or partial domain data"
  );
});

test("a user Stop still propagates as cancellation instead of graceful agent degradation", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    suggestSession(
      "stub",
      { minutes: 20, focus: "cancellation-contract" },
      { signal: controller.signal }
    ),
    /canceled/
  );
});
