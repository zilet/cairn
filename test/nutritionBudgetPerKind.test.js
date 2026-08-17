import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDueAnnouncedDecisions,
  applyMealPlanWithAutonomy,
  applyProposalWithAutonomy,
} from "../dist/domain/brain/autonomy-service.js";
import * as repo from "../dist/repo.js";

// A nutritionally complete 7-day plan whose meal totals match daily_kcal/daily_protein_g,
// so validateMealPlanForPersistence lets the autonomy layer announce it.
function week(summary, kcal = 2200) {
  return {
    summary,
    daily_kcal: kcal,
    daily_protein_g: 175,
    days: Array.from({ length: 7 }, (_, index) => ({
      day: `Day ${index + 1}`,
      meals: [
        { name: `${summary} breakfast`, items: "eggs and oats", kcal: 800, protein_g: 70, carbs_g: 65, fat_g: 18 },
        {
          name: `${summary} dinner`,
          items: "salmon and potatoes",
          kcal: kcal - 800,
          protein_g: 105,
          carbs_g: 80,
          fat_g: 24,
        },
      ],
    })),
  };
}

function nutritionTargetProposal(instruction, kcal) {
  return repo.createProposal("stub", instruction, "", {
    kind: "nutrition_target",
    summary: "Small measured intake adjustment",
    nutrition: { target_kcal: kcal, protein_g: 170, reason: "The measured trend missed its expected band." },
  });
}

// The nutrition surprise budget counts PER CHANGE-KIND: the standing weekly meal refresh
// and a bounded ±kcal target nudge are one coordinated story, not two independent surprises.

test("a bounded target nudge still quiet-applies in a week that already landed a meal refresh", () => {
  repo.setSettings({ lead_mode: "lead" });
  // The standing weekly meal refresh announces and lands this week (an applied meal_plan
  // decision in the nutrition domain).
  const current = repo.createMealPlan("stub", "", week("Current", 2250));
  repo.acceptMealPlan(current.id);
  const next = repo.createMealPlan("stub", "", week("Next", 2300));
  const scheduled = applyMealPlanWithAutonomy(next.id);
  assert.equal(scheduled.announced, true);
  const mealDue = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(mealDue.applied, [scheduled.decision.id], "the meal refresh lands this week");
  assert.equal(repo.currentMealPlan().id, next.id, "the refreshed week is now current");

  // A bounded (delta 0 — no active target seeded) nutrition_target nudge must NOT be demoted
  // to ask by the meal refresh; it commits (pending, nutrition always waits for the boundary).
  const nudge = nutritionTargetProposal("weekly nutrition response", 2250);
  const pending = applyProposalWithAutonomy(nudge.id, { requested_tier: "quiet_apply" });
  assert.equal(pending.pending, true, "the bounded target nudge is committed, not held for review");
  assert.equal(pending.tier, "quiet_apply");
  assert.equal(repo.getProposal(nudge.id).status, "draft");
});

test("a bounded target nudge that overruns the same-kind week waits instead of asking", () => {
  repo.setSettings({ lead_mode: "lead" });
  // The per-kind budget is still real; the 2026-08-17 ruling only changed its pace (one
  // change a week became three) and what a miss DOES — it delays, it never asks.
  for (const [index, kcal] of [2250, 2260, 2270].entries()) {
    const nudge = nutritionTargetProposal(`nutrition response ${index}`, kcal);
    assert.equal(applyProposalWithAutonomy(nudge.id, { requested_tier: "quiet_apply" }).pending, true);
  }

  const overrun = nutritionTargetProposal("the nudge that overruns the week", 2280);
  const deferred = applyProposalWithAutonomy(overrun.id, { requested_tier: "quiet_apply" });
  assert.equal(deferred.applied, false);
  assert.equal(deferred.review_required, undefined, "a full week is a wait, never a question");
  assert.notEqual(deferred.tier, "ask");
  assert.equal(deferred.announced, true);
  assert.equal(deferred.budget_deferred, true);
  assert.equal(repo.getProposal(overrun.id).status, "draft");
});

test("a meal plan announces even with a same-week nutrition_target decision", () => {
  repo.setSettings({ lead_mode: "lead" });
  // A bounded target nudge is committed (pending) this week.
  const nudge = nutritionTargetProposal("weekly nutrition response", 2250);
  const pending = applyProposalWithAutonomy(nudge.id, { requested_tier: "quiet_apply" });
  assert.equal(pending.pending, true);

  // The weekly meal refresh is a different change-kind, so it must still be free to announce.
  const plan = repo.createMealPlan("stub", "", week("Next", 2250));
  const scheduled = applyMealPlanWithAutonomy(plan.id);
  assert.equal(scheduled.announced, true, "the meal refresh is not blocked by the target nudge");
  assert.equal(scheduled.tier, "announce");
});
