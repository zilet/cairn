import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDueAnnouncedDecisions,
  applyMealPlanWithAutonomy,
  applyProposalWithAutonomy,
  revertDecision,
} from "../dist/domain/brain/autonomy-service.js";
import { runUnderfuelingControlLoop } from "../dist/domain/brain/underfueling-service.js";
import { flushBrainEventsForTest, resetBrainEventsForTest } from "../dist/brainEvents.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { afterSqliteCommit, withSqliteSavepoint } from "../dist/repo/sqlite-savepoint.js";
import { currentTrainingDataVersion } from "../dist/repo/training-cache.js";
import { completeMealWeek, db, repo } from "./_seed.js";

function seedBench(weight = 115) {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Atomic Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: weight },
  ]);
}

function targetProposal(weight = 120) {
  return repo.createProposal("stub", "bounded target", "", {
    summary: "Small atomic bench change",
    changes: [{ day_number: 1, exercise: "Atomic Bench Press", target_weight: weight, reason: "ready" }],
  });
}

function nutritionProposal(kcal = 2_350) {
  return repo.createProposal("stub", "bounded fuel target", "", {
    kind: "nutrition_target",
    summary: "Small atomic fuel change",
    nutrition: { target_kcal: kcal, protein_g: 175, reason: "measured drift" },
  });
}

function underfuelRead(state, signature = state) {
  const today = localDateISO();
  return {
    as_of: today,
    state,
    confidence: "medium",
    window: { since: addDaysISO(today, -14), through: addDaysISO(today, -1), calendar_days: 14 },
    uncertainty: {
      deadband_kcal: 225,
      deadband_basis: "test",
      missing_food_days: 0,
      partial_food_days: 0,
      note: "estimates",
    },
    intake: {
      observed_days: 10,
      credible_days: 10,
      compared_days: 10,
      materially_below_days: state === "execution_gap" ? 5 : 0,
      near_target_days: state === "execution_gap" ? 0 : 8,
      average_gap_kcal: state === "execution_gap" ? -400 : -25,
      current_target_kcal: 2_200,
      maintenance_estimate_kcal: 2_600,
    },
    correction: {
      target_id: 1,
      effective_date: addDaysISO(today, state === "persistent_strain" ? -8 : -30),
      age_days: state === "persistent_strain" ? 8 : 30,
      upward_delta_kcal: state === "persistent_strain" ? 150 : null,
      settling: false,
    },
    channels: [],
    agreeing_channels: ["weight_trend", "performance", "recovery"],
    conflicting_channels: [],
    rationale: "Several independent completed-day outcome channels agree.",
    action:
      state === "execution_gap"
        ? {
            kind: "reshape_meals",
            kcal_delta: 0,
            training: "hold_aggression",
            line: "Make the existing target easier to complete.",
          }
        : {
            kind: "raise_target",
            kcal_delta: 150,
            training: "hold_aggression",
            line: "Add one bounded carb-forward step.",
          },
    evidence_keys: ["test:underfueling"],
    signature,
  };
}

test("an immediate autonomous apply rolls back plan, proposal, and ledger when rollback persistence fails", () => {
  seedBench();
  repo.setSettings({ lead_mode: "lead" });
  const proposal = targetProposal();
  resetBrainEventsForTest();
  const versionBefore = currentTrainingDataVersion();
  db.exec(`CREATE TRIGGER fail_atomic_rollback BEFORE INSERT ON brain_rollbacks
    BEGIN SELECT RAISE(ABORT, 'rollback unavailable'); END`);
  try {
    const result = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
    assert.equal(result.ok, false);
    assert.match(result.error, /rollback unavailable/i);
    assert.equal(repo.getPlanDay(1).items[0].target_weight, 115);
    assert.equal(repo.getProposal(proposal.id).status, "draft");
    assert.equal(repo.listBrainDecisions({ status: "applied" }).length, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions WHERE reversible = 1`).get().n, 0);
    assert.equal(currentTrainingDataVersion(), versionBefore, "a rolled-back apply does not publish a cache version");
    assert.deepEqual(flushBrainEventsForTest(), [], "a rolled-back apply emits no phantom plan event");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_atomic_rollback");
  }
});

test("meal acceptance and its announcement stay unchanged when boundary rollback persistence fails", () => {
  repo.setSettings({ lead_mode: "lead" });
  const current = repo.createMealPlan("stub", "", completeMealWeek({ summary: "Current", daily_kcal: 2_250 }));
  repo.acceptMealPlan(current.id);
  const next = repo.createMealPlan("stub", "", completeMealWeek({ summary: "Next", daily_kcal: 2_300 }));
  const scheduled = applyMealPlanWithAutonomy(next.id);
  assert.equal(scheduled.decision.reversible, false, "an announcement does not claim a rollback before it lands");
  resetBrainEventsForTest();

  db.exec(`CREATE TRIGGER fail_meal_boundary_rollback BEFORE INSERT ON brain_rollbacks
    WHEN NEW.decision_id = ${Number(scheduled.decision.id)}
    BEGIN SELECT RAISE(ABORT, 'meal rollback unavailable'); END`);
  try {
    const due = applyDueAnnouncedDecisions(scheduled.effective_date);
    assert.deepEqual(due.applied, []);
    assert.deepEqual(due.failed, [scheduled.decision.id]);
    assert.equal(repo.currentMealPlan().id, current.id);
    assert.equal(repo.getMealPlan(current.id).status, "accepted");
    assert.equal(repo.getMealPlan(next.id).status, "draft");
    assert.equal(repo.getBrainDecision(scheduled.decision.id).status, "review");
    assert.equal(repo.getBrainDecision(scheduled.decision.id).reversible, false);
    assert.equal(repo.getBrainRollback(scheduled.decision.id), null);
    assert.deepEqual(flushBrainEventsForTest(), [], "rolled-back meal acceptance emits no phantom event");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_meal_boundary_rollback");
  }
});

test("meal acceptance failure cannot supersede the current plan or partially apply its decision", () => {
  repo.setSettings({ lead_mode: "lead" });
  const current = repo.createMealPlan("stub", "", completeMealWeek({ summary: "Current", daily_kcal: 2_250 }));
  repo.acceptMealPlan(current.id);
  const next = repo.createMealPlan("stub", "", completeMealWeek({ summary: "Next", daily_kcal: 2_300 }));
  const scheduled = applyMealPlanWithAutonomy(next.id);
  db.exec(`CREATE TRIGGER fail_meal_accept BEFORE UPDATE OF status ON meal_plans
    WHEN OLD.id = ${Number(next.id)} AND NEW.status = 'accepted'
    BEGIN SELECT RAISE(ABORT, 'meal acceptance unavailable'); END`);
  try {
    const due = applyDueAnnouncedDecisions(scheduled.effective_date);
    assert.deepEqual(due.applied, []);
    assert.equal(repo.currentMealPlan().id, current.id);
    assert.equal(repo.getMealPlan(current.id).status, "accepted");
    assert.equal(repo.getMealPlan(next.id).status, "draft");
    assert.equal(repo.getBrainDecision(scheduled.decision.id).status, "review");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_meal_accept");
  }
});

test("Undo restores neither plan nor ledger when its decision transition fails", () => {
  seedBench();
  repo.setSettings({ lead_mode: "lead" });
  const applied = applyProposalWithAutonomy(targetProposal().id, { requested_tier: "quiet_apply" });
  assert.equal(applied.ok, true);
  const expectation = repo.listBrainExpectations({ decisionId: applied.decision.id })[0];
  db.exec(`CREATE TRIGGER fail_revert_transition BEFORE UPDATE OF status ON brain_decisions
    WHEN OLD.id = ${Number(applied.decision.id)} AND NEW.status = 'reverted'
    BEGIN SELECT RAISE(ABORT, 'revert transition unavailable'); END`);
  try {
    const result = revertDecision(applied.decision.id, "fault injection");
    assert.equal(result.ok, false);
    assert.match(result.error, /revert transition unavailable/i);
    assert.equal(repo.getPlanDay(1).items[0].target_weight, 120);
    assert.equal(repo.getBrainDecision(applied.decision.id).status, "applied");
    assert.equal(repo.listBrainExpectations({ decisionId: applied.decision.id })[0].status, expectation.status);
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM brain_evaluations WHERE expectation_id = ?`).get(expectation.id).n,
      0
    );
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_revert_transition");
  }
});

test("a nutrition target cannot land when the linked proposal transition fails", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.setNutritionTarget({ target_kcal: 2_200, protein_g: 170, source: "manual" });
  const before = db.prepare(`SELECT COUNT(*) AS n FROM nutrition_targets`).get().n;
  const proposal = nutritionProposal();
  const pending = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  resetBrainEventsForTest();
  db.exec(`CREATE TRIGGER fail_nutrition_proposal_transition BEFORE UPDATE OF status ON plan_proposals
    WHEN OLD.id = ${Number(proposal.id)} AND NEW.status = 'applied'
    BEGIN SELECT RAISE(ABORT, 'proposal transition unavailable'); END`);
  try {
    const due = applyDueAnnouncedDecisions(pending.effective_date);
    assert.deepEqual(due.applied, []);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM nutrition_targets`).get().n, before);
    assert.equal(repo.getActiveNutritionTarget().target_kcal, 2_200);
    assert.equal(repo.getProposal(proposal.id).status, "draft");
    assert.equal(repo.getBrainDecision(pending.decision.id).status, "review");
    assert.equal(repo.getAppState("meal_plan_refresh_requested"), null);
    assert.deepEqual(flushBrainEventsForTest(), [], "rolled-back target persistence emits no phantom event");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_nutrition_proposal_transition");
  }
});

test("recordDecision never leaves a decision without its required expectations", () => {
  db.exec(`CREATE TRIGGER fail_required_expectation BEFORE INSERT ON brain_expectations
    BEGIN SELECT RAISE(ABORT, 'expectation unavailable'); END`);
  try {
    assert.throws(
      () =>
        repo.recordDecision(
          {
            effective_date: "2026-07-16",
            kind: "training_target",
            domain: "training",
            summary: "Atomic expectation",
            status: "applied",
            autonomy_tier: "ask",
            risk_class: "low",
            reversible: false,
            action: { proposal_id: 1 },
          },
          [
            {
              metric_key: "exercise_target_completion",
              subject_key: "Atomic Bench Press",
              direction: "complete",
              baseline: null,
              target: { exposures: 2 },
              window_start: "2026-07-16",
              window_end: "2026-08-13",
              minimum_data: { exposures: 2 },
              confounder_policy: "require_exposure",
              confidence: "tentative",
              evaluator: "exercise_completion",
              evaluator_version: "exercise-completion-v1",
            },
          ]
        ),
      /expectation unavailable/i
    );
    assert.equal(repo.listBrainDecisions().length, 0);
    assert.equal(repo.listBrainExpectations().length, 0);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_required_expectation");
  }
});

test("an autonomous apply rolls back when its required learning expectation cannot be stored", () => {
  seedBench();
  repo.setSettings({ lead_mode: "lead" });
  const proposal = targetProposal();
  db.exec(`CREATE TRIGGER fail_autonomy_expectation BEFORE INSERT ON brain_expectations
    BEGIN SELECT RAISE(ABORT, 'autonomy expectation unavailable'); END`);
  try {
    const result = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
    assert.equal(result.ok, false);
    assert.match(result.error, /autonomy expectation unavailable/i);
    assert.equal(repo.getPlanDay(1).items[0].target_weight, 115);
    assert.equal(repo.getProposal(proposal.id).status, "draft");
    assert.equal(repo.listBrainDecisions().length, 0);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_autonomy_expectation");
  }
});

test("a recovery restructure cannot land without its strict ownership stamp", () => {
  seedBench();
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("stub", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Atomic recovery week",
    days: [
      {
        day_number: 1,
        name: "Push recovery",
        focus: "Chest",
        items: [{ exercise: "Atomic Bench Press", sets: 2, rep_low: 6, rep_high: 8, target_weight: 105 }],
      },
    ],
  });
  const announced = applyProposalWithAutonomy(proposal.id, { requested_tier: "announce" });
  db.exec(`CREATE TRIGGER fail_recovery_owner BEFORE INSERT ON app_state
    WHEN NEW.key = 'recovery_week_applied'
    BEGIN SELECT RAISE(ABORT, 'recovery owner unavailable'); END`);
  try {
    const due = applyDueAnnouncedDecisions(announced.effective_date);
    assert.deepEqual(due.applied, []);
    assert.deepEqual(due.failed, [announced.decision.id]);
    assert.equal(repo.getPlanDay(1).items[0].sets, 3);
    assert.equal(repo.getProposal(proposal.id).status, "draft");
    assert.equal(repo.getAppState("recovery_week_applied"), null);
    assert.equal(repo.getBrainDecision(announced.decision.id).status, "review");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_recovery_owner");
  }
});

test("replacePlan is nest-safe and an outer failure restores the original plan", () => {
  seedBench();
  assert.throws(
    () =>
      withSqliteSavepoint("outer_replace_test", () => {
        repo.replacePlan([
          {
            day_number: 1,
            name: "Replacement",
            focus: "Full body",
            items: [{ exercise: "Goblet Squat", sets: 3, rep_low: 8, rep_high: 10 }],
          },
        ]);
        throw new Error("outer unit failed");
      }),
    /outer unit failed/i
  );
  assert.equal(repo.getPlanDay(1).name, "Push");
  assert.equal(repo.getPlanDay(1).items[0].exercise, "Atomic Bench Press");
});

test("one due rollback failure is isolated and a later healthy decision still commits", () => {
  seedBench();
  repo.setSettings({ lead_mode: "announce_first" });
  const training = applyProposalWithAutonomy(targetProposal().id, { requested_tier: "announce" });
  const nutrition = applyProposalWithAutonomy(nutritionProposal(2_300).id, { requested_tier: "quiet_apply" });
  db.exec(`CREATE TRIGGER fail_one_due_rollback BEFORE INSERT ON brain_rollbacks
    WHEN NEW.decision_id = ${Number(training.decision.id)}
    BEGIN SELECT RAISE(ABORT, 'one rollback unavailable'); END`);
  try {
    const due = applyDueAnnouncedDecisions("2099-01-01");
    assert.deepEqual(due.failed, [training.decision.id]);
    assert.deepEqual(due.applied, [nutrition.decision.id]);
    assert.equal(repo.getPlanDay(1).items[0].target_weight, 115);
    assert.equal(repo.getBrainDecision(training.decision.id).status, "review");
    assert.equal(repo.getBrainDecision(training.decision.id).reversible, false);
    assert.equal(repo.getActiveNutritionTarget().target_kcal, 2_300);
    assert.equal(repo.getBrainDecision(nutrition.decision.id).status, "applied");
    assert.equal(repo.getBrainDecision(nutrition.decision.id).reversible, true);
    assert.ok(repo.getBrainRollback(nutrition.decision.id));
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_one_due_rollback");
  }
});

test("after-commit callbacks merge through nested success and discard rolled-back frames", () => {
  const seen = [];
  withSqliteSavepoint("outer_after_commit", () => {
    afterSqliteCommit(() => seen.push("outer-before"));
    withSqliteSavepoint("inner_after_commit", () => afterSqliteCommit(() => seen.push("inner")));
    assert.deepEqual(seen, [], "nested callbacks stay private until the outer commit");
    assert.throws(
      () =>
        withSqliteSavepoint("discard_after_commit", () => {
          afterSqliteCommit(() => seen.push("discarded"));
          throw new Error("discard this frame");
        }),
      /discard this frame/i
    );
    afterSqliteCommit(() => seen.push("outer-after"));
  });
  assert.deepEqual(seen, ["outer-before", "inner", "outer-after"]);
  assert.throws(
    () =>
      withSqliteSavepoint("discard_outer_after_commit", () => {
        afterSqliteCommit(() => seen.push("discarded outer"));
        throw new Error("discard outer frame");
      }),
    /discard outer frame/i
  );
  afterSqliteCommit(() => seen.push("immediate"));
  assert.deepEqual(seen, ["outer-before", "inner", "outer-after", "immediate"]);
});

test("nutrition Undo deletes its target but preserves a newer same-date manual target", () => {
  repo.setSettings({ lead_mode: "lead" });
  const original = repo.setNutritionTarget({ target_kcal: 2_200, protein_g: 170, source: "manual" });
  const pending = applyProposalWithAutonomy(nutritionProposal(2_350).id, { requested_tier: "quiet_apply" });
  const due = applyDueAnnouncedDecisions(pending.effective_date);
  assert.deepEqual(due.applied, [pending.decision.id]);
  const appliedId = Number(repo.getBrainDecision(pending.decision.id).source_ref_key);
  const newer = repo.setNutritionTarget({ target_kcal: 2_450, protein_g: 180, source: "manual" });

  assert.equal(revertDecision(pending.decision.id, "keep my newer target").ok, true);
  assert.equal(repo.getNutritionTarget(appliedId), null, "the reverted target is removed from history");
  assert.equal(repo.getActiveNutritionTarget().id, newer.id, "the newer manual target remains authoritative");
  assert.ok(repo.getNutritionTarget(original.id), "the exact predecessor remains in history without duplication");
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM nutrition_targets`).get().n), 2);
});

test("meal Undo restores only its predecessor and preserves a newer announced draft", () => {
  repo.setSettings({ lead_mode: "lead" });
  const original = repo.createMealPlan("stub", "", completeMealWeek({ summary: "Original", daily_kcal: 2_250 }));
  repo.acceptMealPlan(original.id);
  const appliedPlan = repo.createMealPlan("stub", "", completeMealWeek({ summary: "Applied", daily_kcal: 2_300 }));
  const applied = applyMealPlanWithAutonomy(appliedPlan.id, { coordinated_update: true });
  assert.deepEqual(applyDueAnnouncedDecisions(applied.effective_date).applied, [applied.decision.id]);
  const future = repo.createMealPlan("stub", "", completeMealWeek({ summary: "Future", daily_kcal: 2_350 }));
  const announced = applyMealPlanWithAutonomy(future.id, { coordinated_update: true });
  assert.equal(announced.announced, true);

  assert.equal(revertDecision(applied.decision.id, "restore prior week").ok, true);
  assert.equal(repo.currentMealPlan().id, original.id);
  assert.equal(repo.getMealPlan(appliedPlan.id).status, "superseded");
  assert.equal(repo.getMealPlan(future.id).status, "draft", "the independent future option is untouched");
  assert.equal(repo.getBrainDecision(announced.decision.id).status, "announced");
});

test("training Undo preserves a manual prepend and reorder while restoring only the owned target", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Atomic Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
    { exercise: "Atomic Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 100 },
    { exercise: "Atomic Fly", sets: 2, rep_low: 10, rep_high: 12, target_weight: 30 },
  ]);
  const applied = applyProposalWithAutonomy(targetProposal(120).id, { requested_tier: "quiet_apply" });
  const current = repo.getPlanDay(1).items;
  const byName = new Map(current.map((item) => [item.exercise, item]));
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Atomic Push-up", sets: 2, rep_low: 12, rep_high: 15 },
    byName.get("Atomic Fly"),
    byName.get("Atomic Bench Press"),
    byName.get("Atomic Row"),
  ]);

  assert.equal(revertDecision(applied.decision.id, "undo target only").ok, true);
  const restored = repo.getPlanDay(1).items;
  assert.deepEqual(
    restored.map((item) => item.exercise),
    ["Atomic Push-up", "Atomic Fly", "Atomic Bench Press", "Atomic Row"]
  );
  assert.equal(restored.find((item) => item.exercise === "Atomic Bench Press").target_weight, 115);
});

test("rotation Undo follows the rotated exercise after a manual reorder", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Rotation Bench", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
    { exercise: "Rotation Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 100 },
  ]);
  const proposal = repo.createProposal("stub", "rotate", "", {
    summary: "Rotate bench variation",
    changes: [{ day_number: 1, swap: { from: "Rotation Bench", to: "Dumbbell Bench Press" } }],
  });
  const applied = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  const current = repo.getPlanDay(1).items;
  repo.savePlanDay(1, "Push", "Chest", [
    current.find((item) => item.exercise === "Rotation Row"),
    current.find((item) => item.exercise === "Dumbbell Bench Press"),
  ]);

  assert.equal(revertDecision(applied.decision.id, "undo rotation").ok, true);
  assert.deepEqual(
    repo.getPlanDay(1).items.map((item) => item.exercise),
    ["Rotation Row", "Rotation Bench"]
  );
});

test("a failed direct proposal apply keeps its standing announcement", () => {
  seedBench();
  repo.setSettings({ lead_mode: "lead" });
  const proposal = targetProposal(120);
  const announced = applyProposalWithAutonomy(proposal.id, { requested_tier: "announce" });
  db.exec(`CREATE TRIGGER fail_direct_apply BEFORE UPDATE OF target_weight ON plan_items
    BEGIN SELECT RAISE(ABORT, 'direct mutation failed'); END`);
  try {
    const result = repo.applyProposal(proposal.id);
    assert.equal(result.ok, false);
    assert.equal(repo.getProposal(proposal.id).status, "draft");
    assert.equal(repo.getBrainDecision(announced.decision.id).status, "announced");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_direct_apply");
  }
});

test("re-announcing a canceled proposal creates a fresh lifecycle row", () => {
  seedBench();
  repo.setSettings({ lead_mode: "lead" });
  const proposal = targetProposal(120);
  const first = applyProposalWithAutonomy(proposal.id, { requested_tier: "announce" });
  assert.equal(revertDecision(first.decision.id, "not this week").ok, true);
  const second = applyProposalWithAutonomy(proposal.id, { requested_tier: "announce" });
  assert.notEqual(second.decision.id, first.decision.id);
  assert.equal(repo.getBrainDecision(first.decision.id).status, "canceled");
  assert.equal(second.decision.status, "announced");
  assert.equal(second.decision.context.lifecycle_after_decision_id, first.decision.id);
});

test("underfueling state-write failure leaves no cooldown and can be retried", () => {
  repo.setSettings({ lead_mode: "lead", proactive_enabled: true });
  db.exec(`CREATE TRIGGER fail_underfuel_state BEFORE INSERT ON app_state
    WHEN NEW.key = 'meal_plan_refresh_instruction'
    BEGIN SELECT RAISE(ABORT, 'state unavailable'); END`);
  try {
    const failed = runUnderfuelingControlLoop(localDateISO(), { read: underfuelRead("execution_gap", "state-fail") });
    assert.equal(failed.action, "none");
    assert.equal(repo.getAppState("underfuel_execution_last_action"), null);
    assert.equal(repo.getAppState("meal_plan_refresh_requested"), null);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_underfuel_state");
  }
  const retried = runUnderfuelingControlLoop(localDateISO(), { read: underfuelRead("execution_gap", "state-retry") });
  assert.equal(retried.action, "meal_reshape_queued");
});

test("review-everything underfueling does not report or stamp a scheduled correction", () => {
  repo.setSettings({ lead_mode: "review_everything", proactive_enabled: true });
  repo.setNutritionTarget({ target_kcal: 2_200, protein_g: 170, source: "manual" });
  const result = runUnderfuelingControlLoop(localDateISO(), {
    read: underfuelRead("prescription_strain", "review-only"),
  });
  assert.equal(result.action, "none");
  assert.equal(repo.getAppState("underfuel_prescription_last_action"), null);
  assert.equal(repo.getAppState("meal_plan_refresh_instruction"), null);
  assert.equal(
    repo.listBrainDecisions({ kind: "nutrition_target" }).some((decision) => decision.status === "review"),
    true
  );
});
