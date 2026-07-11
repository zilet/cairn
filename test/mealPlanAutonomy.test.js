import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDueAnnouncedDecisions,
  applyMealPlanWithAutonomy,
  revertDecision,
} from "../dist/domain/brain/autonomy-service.js";
import * as repo from "../dist/repo.js";

function week(summary, kcal = 2200) {
  return {
    summary,
    daily_kcal: kcal,
    daily_protein_g: 175,
    days: [
      {
        day: "Mon",
        meals: [
          { name: `${summary} breakfast`, items: "eggs and oats", kcal: 600, protein_g: 42, carbs_g: 65, fat_g: 18 },
          { name: `${summary} dinner`, items: "salmon and potatoes", kcal: 800, protein_g: 58, carbs_g: 80, fat_g: 24 },
        ],
      },
    ],
  };
}

test("lead mode announces a meal plan, keeps today's plan, lands tomorrow, and undoes exactly", () => {
  repo.setSettings({ lead_mode: "lead" });
  const current = repo.createMealPlan("stub", "", week("Current", 2250));
  repo.acceptMealPlan(current.id);
  const next = repo.createMealPlan("stub", "", week("Next", 2300));

  const scheduled = applyMealPlanWithAutonomy(next.id);
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.announced, true);
  assert.equal(scheduled.tier, "announce");
  assert.equal(repo.currentMealPlan().id, current.id, "an upcoming plan does not replace today's meals");
  assert.equal(repo.getMealPlan(next.id).autonomy.status, "announced");

  const due = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(due.applied, [scheduled.decision.id]);
  assert.equal(repo.currentMealPlan().id, next.id);
  assert.equal(repo.getMealPlan(current.id).status, "superseded");
  assert.equal(repo.getBrainDecision(scheduled.decision.id).context.rollback_available, true);
  assert.equal(repo.getBrainRollback(scheduled.decision.id).kind, "meal_plan");

  const undone = revertDecision(scheduled.decision.id, "keep the prior week");
  assert.equal(undone.ok, true);
  assert.equal(repo.currentMealPlan().id, current.id);
  assert.equal(repo.getMealPlan(next.id).status, "superseded");
  assert.equal(repo.getBrainDecision(scheduled.decision.id).status, "reverted");
});

test("a fresher queued meal week supersedes the older queue and Hold prevents landing", () => {
  repo.setSettings({ lead_mode: "lead" });
  const first = repo.createMealPlan("stub", "", week("First"));
  const firstScheduled = applyMealPlanWithAutonomy(first.id, { coordinated_update: true });
  const second = repo.createMealPlan("stub", "", week("Second"));
  const secondScheduled = applyMealPlanWithAutonomy(second.id, { coordinated_update: true });

  assert.equal(repo.getMealPlan(first.id).status, "superseded");
  assert.equal(repo.getBrainDecision(firstScheduled.decision.id).status, "superseded");
  assert.equal(repo.getMealPlan(second.id).autonomy.status, "announced");

  const held = revertDecision(secondScheduled.decision.id, "travel changed");
  assert.equal(held.ok, true);
  assert.equal(repo.getMealPlan(second.id).status, "superseded");
  assert.equal(repo.getBrainDecision(secondScheduled.decision.id).status, "canceled");
  assert.deepEqual(applyDueAnnouncedDecisions(secondScheduled.effective_date).applied, []);
});

test("review-everything keeps a meal plan as a plain draft", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  const plan = repo.createMealPlan("stub", "", week("Review"));
  const result = applyMealPlanWithAutonomy(plan.id);

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.tier, "ask");
  assert.equal(repo.getMealPlan(plan.id).status, "draft");
  assert.equal(repo.getMealPlan(plan.id).autonomy, null);
});
