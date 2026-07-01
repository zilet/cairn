// Close the adaptive-nutrition loop (Wave B / B3). When the athlete ACCEPTS a
// nutrition_target proposal, the accepted number is PERSISTED (not re-derived forever):
// the fuel card, the goal math and the next check-in all read the accepted target, with
// the formula only as a fallback/floor.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, localDaysAgo } from "./_seed.js";
import { buildNutritionCheckinPrompt } from "../dist/prompt.js";

beforeEach(() => resetTables("nutrition_targets", "profile", "food_notes", "bodyweight_log", "plan_proposals"));

// A complete-enough profile so computeGoalCheck().ok is true (maintain mode).
function seedProfile() {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5, goal_mode: "maintain" });
}

test("setNutritionTarget / getActiveNutritionTarget round-trip (newest effective wins)", () => {
  repo.setNutritionTarget({ target_kcal: 2500, protein_g: 170, source: "checkin", effective_date: localDaysAgo(10) });
  repo.setNutritionTarget({ target_kcal: 2700, protein_g: 175, source: "checkin", effective_date: localDaysAgo(2) });
  const active = repo.getActiveNutritionTarget();
  assert.equal(active.target_kcal, 2700, "the newest effective target is active");
  assert.equal(active.protein_g, 175);
  // A future-dated target does not apply yet.
  repo.setNutritionTarget({ target_kcal: 9999, protein_g: 300, source: "checkin", effective_date: localDaysAgo(-5) });
  assert.equal(repo.getActiveNutritionTarget().target_kcal, 2700, "a future-dated target is not active yet");
});

test("applying a nutrition_target proposal persists the accepted target", () => {
  seedProfile();
  assert.equal(repo.getActiveNutritionTarget(), null, "nothing accepted yet");

  const p = repo.createProposal("stub", "check-in", "", {
    kind: "nutrition_target",
    nutrition: { target_kcal: 3000, protein_g: 200, carbs_g: 320, fat_g: 95, reason: "a mileage ramp — fuel it" },
  });
  const res = repo.applyProposal(p.id);
  assert.equal(res.ok, true, "the advisory target applied");
  assert.ok(res.accepted, "the apply result reports the accepted target");

  const active = repo.getActiveNutritionTarget();
  assert.ok(active, "an accepted target is now persisted");
  assert.equal(active.target_kcal, 3000);
  assert.equal(active.protein_g, 200);
});

test("the fuel card + goal math + next check-in read the accepted number", () => {
  seedProfile();
  const p = repo.createProposal("stub", "check-in", "", {
    kind: "nutrition_target",
    nutrition: { target_kcal: 3000, protein_g: 200, carbs_g: 320, fat_g: 95, reason: "fuel the ramp" },
  });
  repo.applyProposal(p.id);

  // computeGoalCheck exposes the EFFECTIVE target (accepted wins over the formula).
  const goal = repo.computeGoalCheck();
  assert.equal(goal.effective_target.source, "accepted");
  assert.equal(goal.effective_target.target_kcal, 3000);
  assert.equal(goal.effective_target.protein_g, 200);

  // The fuel card (getDayIntake) shows the accepted target, not the re-derived formula.
  const day = repo.getDayIntake();
  assert.ok(day.target, "a target is framed");
  assert.equal(day.target.kcal, 3000, "the fuel card reads the accepted target");
  assert.equal(day.target.source, "accepted");

  // The next check-in's CURRENT TARGET line reflects the accepted number.
  const prompt = buildNutritionCheckinPrompt();
  assert.match(prompt, /CURRENT TARGET: ~3000 kcal\/day/, "the check-in reads the accepted target");
  assert.match(prompt, /ACCEPTED target from a prior check-in/, "and knows it's a prior acceptance");
});
