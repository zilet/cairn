import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { nextPrescription } from "../dist/repo/progression.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { personalizeNutritionCheckinTarget } from "../dist/coachOps.js";
import { enqueueAgentJob, executeBrainReviewAction, onJobEvent } from "../dist/agentJobs.js";
import { applyDueAnnouncedDecisions } from "../dist/domain/brain/autonomy-service.js";

function learnedMiss(kind, domain, metricKey, subjectKey, key, target = { exposures: 2 }, actual = { exposures: 2, completed: 0 }) {
  const recorded = recordDecision({
    effective_date: "2026-06-01",
    kind,
    domain,
    summary: `Measured response ${key}`,
    rationale: "Use the result to tune only the next bounded step.",
    source: "test",
    source_ref_type: "plan_proposal",
    source_ref_key: key,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: {},
    specialist: null,
    applied_at: "2026-06-01T12:00:00.000Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "closed-loop-test-v1",
  }, [{
    metric_key: metricKey,
    subject_key: subjectKey,
    direction: metricKey === "weight_trend_lb_wk" ? "within_band" : "complete",
    baseline: null,
    target,
    window_start: "2026-06-01",
    window_end: "2026-06-21",
    minimum_data: {},
    confounder_policy: "standard",
    confidence: "tentative",
    evaluator: metricKey === "weight_trend_lb_wk" ? "weight_trend" : "exercise_completion",
    evaluator_version: "closed-loop-test-v1",
  }]);
  insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict: "not_aligned",
    actual,
    evidence_keys: [`test:${key}`],
    confounders: [],
    explanation: "The clean result missed the expected response.",
    evaluator_version: "closed-loop-test-v1",
  });
}

function seedEarnedBench({ constrained = false } = {}) {
  const exercise = repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest" });
  if (constrained) repo.updateExercise(exercise.id, { constraint_note: "chest wall pain — hold load until pain-free" });
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 12, target_weight: 185 },
  ]);
  const session = repo.getOrCreateSession("2026-07-08", repo.getPlanDay(1).id);
  for (let set = 1; set <= 3; set += 1) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir)
       VALUES (?, ?, ?, 185, 12, 2)`
    ).run(session.id, exercise.id, set);
  }
  return repo.finishSession(session.id);
}

async function runJob(id) {
  const done = new Promise((resolve, reject) => {
    const off = onJobEvent(id, (event) => {
      if (event.type === "done") { off(); resolve(event); }
      if (event.type === "error") { off(); reject(new Error(event.message)); }
    });
  });
  enqueueAgentJob(id);
  return Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("job timeout")), 3_000))]);
}

test("learned training response changes the real next target but never overrides an injury constraint", () => {
  seedEarnedBench();
  assert.equal(nextPrescription("Barbell Bench Press", undefined, { autoreg: null, recentLoad: null }).suggested.weight, 190);

  learnedMiss("training_target", "training", "exercise_target_completion", "Barbell Bench Press", "1");
  learnedMiss("training_target", "training", "exercise_target_completion", "Barbell Bench Press", "2");
  const personalized = nextPrescription("Barbell Bench Press", undefined, { autoreg: null, recentLoad: null });
  assert.equal(personalized.suggested.weight, 187.5, "the learned conservative step reaches the actual prescription");
  assert.ok(personalized.suggested.weight - 185 <= 5, "the universal compound ceiling still wins");

  repo.updateExercise(repo.findExercise("Barbell Bench Press").id, { constraint_note: "chest wall pain — hold load until pain-free" });
  const constrained = nextPrescription("Barbell Bench Press", undefined, { autoreg: null, recentLoad: null });
  assert.equal(constrained.action, "hold");
  assert.equal(constrained.suggested.weight, 185);
});

test("learned nutrition response changes the proposal target inside the 250-kcal and lean-safe clamps", () => {
  const goal = {
    ok: true,
    effective_target: { target_kcal: 2_200 },
    recommended: { target_intake_kcal: 2_050, protein_g: 170 },
  };
  const standard = personalizeNutritionCheckinTarget({ target_kcal: 2_400, prev_target_kcal: 2_200, protein_g: 150 }, goal);
  assert.deepEqual({ kcal: standard.target_kcal, protein: standard.protein_g }, { kcal: 2_400, protein: 170 });

  learnedMiss("nutrition_target", "nutrition", "weight_trend_lb_wk", null, "1", { min: -0.8, max: -0.3 }, { value: 0 });
  learnedMiss("nutrition_target", "nutrition", "weight_trend_lb_wk", null, "2", { min: -0.8, max: -0.3 }, { value: 0 });
  const personalized = personalizeNutritionCheckinTarget(
    { target_kcal: 2_400, prev_target_kcal: 2_200, protein_g: 150, delta_kcal: 200 },
    goal
  );
  assert.equal(personalized.target_kcal, 2_430);
  assert.equal(personalized.delta_kcal, 230);
  assert.ok(personalized.target_kcal - 2_200 <= 250);
  assert.equal(personalized.protein_g, 170, "personal learning cannot lower the protein floor");

  const floored = personalizeNutritionCheckinTarget({ target_kcal: 1_000, prev_target_kcal: 2_200, protein_g: 100 }, goal);
  assert.equal(floored.target_kcal, 2_050, "lean-safe floor overrides the requested downward step");
  assert.equal(floored.protein_g, 170);
});

test("a finished-session brain review quietly applies the deterministic next-session progression", async () => {
  const session = seedEarnedBench();
  repo.setSettings({ lead_mode: "lead" });
  const job = repo.createAgentJob({
    kind: "brain_review",
    agent: "stub",
    input: { event: { kind: "session_finished", domain: "training", date: session.date, entity_id: session.id } },
  });
  await runJob(job.id);

  const stored = repo.getAgentJob(job.id);
  assert.equal(stored.status, "done");
  assert.equal(stored.result.action, "training_progression");
  assert.equal(stored.result.autonomy.tier, "quiet_apply");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 190);
  assert.equal(repo.getProposal(stored.result.proposal.id).status, "applied");
});

test("a material nutrition correction can schedule only a bounded next-day target", async () => {
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("stub", "material food correction", "", {
    kind: "nutrition_target",
    summary: "Small measured nutrition correction",
    nutrition: { target_kcal: 2_250, protein_g: 170, reason: "The corrected intake changed the weekly read." },
  });
  const result = await executeBrainReviewAction(
    { event: { kind: "food_corrected", domain: "nutrition", date: "2026-07-09", material: true } },
    "stub",
    undefined,
    { nutritionCheckin: async () => ({ ok: true, change: true, proposal }) }
  );

  assert.equal(result.action, "nutrition_recheck");
  assert.equal(result.autonomy.pending, true);
  assert.equal(repo.getActiveNutritionTarget(), null, "a partly-lived food day is never rewritten");
  const due = applyDueAnnouncedDecisions(result.autonomy.effective_date);
  assert.deepEqual(due.applied, [result.autonomy.decision.id]);
  assert.equal(repo.getActiveNutritionTarget().target_kcal, 2_250);
});
