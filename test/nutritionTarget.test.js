// Close the adaptive-nutrition loop (Wave B / B3). When the athlete ACCEPTS a
// nutrition_target proposal, the accepted number is PERSISTED (not re-derived forever):
// the fuel card, the goal math and the next check-in all read the accepted target, with
// the formula only as a fallback/floor.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, localDaysAgo } from "./_seed.js";
import { buildChatPrompt, buildNutritionCheckinPrompt } from "../dist/prompt.js";

beforeEach(() => resetTables("nutrition_targets", "profile", "food_notes", "bodyweight_log", "plan_proposals"));

// A complete-enough profile so computeGoalCheck().ok is true (maintain mode).
function seedProfile() {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 180,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "maintain",
  });
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

test("a nutrition target persistence failure leaves the proposal reviewable and unapplied", () => {
  seedProfile();
  const p = repo.createProposal("stub", "check-in", "", {
    kind: "nutrition_target",
    nutrition: { target_kcal: 3000, protein_g: 200, reason: "reviewed target" },
  });
  db.exec(`CREATE TEMP TRIGGER fail_nutrition_target_insert
    BEFORE INSERT ON nutrition_targets
    BEGIN
      SELECT RAISE(ABORT, 'forced nutrition target persistence failure');
    END`);
  try {
    assert.throws(
      () => repo.applyProposal(p.id),
      /nutrition target could not be saved; the proposal remains reviewable/i
    );
    assert.equal(repo.getProposal(p.id).status, "draft", "a failed write does not consume the proposal");
    assert.equal(repo.getActiveNutritionTarget(), null, "no target is falsely reported as active");
    const linkedApplied = repo
      .listBrainDecisions({ kind: "nutrition_target", status: "applied", limit: 100 })
      .filter((decision) => Number(decision.action?.plan_proposal_id) === p.id);
    assert.equal(linkedApplied.length, 0, "no applied decision is recorded for the failed write");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_nutrition_target_insert");
  }
});

test("a reviewed proposal target survives apply exactly and the ledger action agrees", () => {
  seedProfile();
  repo.setProfile({ goal_mode: "lose", goal_weight_lb: 170 });
  const p = repo.createProposal("stub", "check-in", "", {
    kind: "nutrition_target",
    summary: "Set the reviewed target to 2200 kcal.",
    nutrition: { target_kcal: 2200, protein_g: 180, reason: "A measured, moderate cut." },
  });
  const res = repo.applyProposal(p.id);
  assert.equal(res.nutrition.target_kcal, 2200);
  assert.equal(res.accepted.target_kcal, 2200);
  assert.equal(repo.getActiveNutritionTarget().target_kcal, 2200);
  const decision = repo.listBrainDecisions({ kind: "nutrition_target" }).at(-1);
  assert.match(decision.summary, /2200 kcal/);
  assert.equal(decision.action.target_kcal, 2200);
});

test("a target drafted for loss is rejected transparently after the goal mode changes", () => {
  seedProfile();
  repo.setProfile({ goal_mode: "lose", goal_weight_lb: 170 });
  const p = repo.createProposal("stub", "check-in", "", {
    kind: "nutrition_target",
    summary: "Set the reviewed cut target to 2200 kcal.",
    nutrition: { target_kcal: 2200, protein_g: 180, reason: "A measured, moderate cut." },
  });

  repo.setProfile({ goal_mode: "maintain", goal_weight_lb: null });
  const current = repo.computeGoalCheck();
  assert.ok(current.recommended.target_intake_kcal > 2200);
  assert.throws(() => repo.applyProposal(p.id), /below the current maintenance requirement.*did not apply or alter/is);
  assert.equal(repo.getProposal(p.id).status, "draft");
  assert.equal(repo.getActiveNutritionTarget(), null);
});

test("adaptive targets become review-due after six weeks while explicit targets persist", () => {
  seedProfile();
  repo.setNutritionTarget({ target_kcal: 3000, protein_g: 180, source: "checkin", effective_date: localDaysAgo(43) });
  assert.equal(repo.getActiveNutritionTarget(), null);
  const goal = repo.computeGoalCheck();
  assert.equal(goal.effective_target.source, "formula");
  assert.equal(goal.effective_target.review_due, true);
  assert.equal(goal.effective_target.expired_target.target_kcal, 3000);
  assert.match(goal.message, /review-due/i);

  repo.setNutritionTarget({ target_kcal: 3000, protein_g: 180, source: "direct", effective_date: localDaysAgo(42) });
  assert.equal(repo.getActiveNutritionTarget().freshness, "explicit");
  assert.equal(repo.getActiveNutritionTarget().target_kcal, 3000);
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
  assert.match(goal.message, /Active target: ~3000 kcal/, "the human summary agrees with the accepted target");
  assert.notEqual(
    goal.message,
    goal.formula_message,
    "the date/formula estimate remains provenance, not the active instruction"
  );

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

test("chat target guidance uses the effective target and retains the formula fallback", () => {
  seedProfile();
  let prompt = buildChatPrompt([], "How much should I eat today?");
  assert.match(prompt, /For EVERY kcal or protein target\s+reference, use DATA\.goal\.effective_target first/i);
  assert.match(prompt, /falling back to DATA\.goal\.recommended only when effective_target is absent/i);
  assert.match(prompt, /"effective_target":\{"target_kcal":\d+,"protein_g":\d+,.*"source":"formula"/);

  repo.setNutritionTarget({ target_kcal: 3000, protein_g: 200, source: "checkin" });
  prompt = buildChatPrompt([], "How much should I eat today?");
  assert.match(
    prompt,
    /"effective_target":\{"target_kcal":3000,"protein_g":200,.*"source":"accepted"/,
    "the accepted target is the number chat sees as authoritative"
  );
});
