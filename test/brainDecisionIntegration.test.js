import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { completeMealWeek, db, localDaysAgo, repo, resetTables, seedIntake, seedWeight } from "./_seed.js";
import { evaluateMatureExpectations } from "../dist/brainEvaluator.js";
import { automaticOrphanIntent } from "../dist/repo/proposal-intent.js";

beforeEach(() => {
  resetTables(
    "brain_evaluations",
    "brain_expectations",
    "brain_decisions",
    "brain_tool_calls",
    "health_directives",
    "health_documents",
    "nutrition_targets",
    "plan_proposals",
    "plan_items",
    "plan_days",
    "day_reads",
    "food_notes",
    "bodyweight_log",
    "profile"
  );
});

test("successful proposal applies record one linked decision and bounded expectations", () => {
  repo.savePlanDay(1, "Lower", "legs", [
    { exercise: "Ledger Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
  const proposal = repo.createProposal("stub", "progress the squat", "raw output stays on proposal", {
    summary: "Progress the next squat exposure.",
    changes: [{ day_number: 1, exercise: "Ledger Squat", target_weight: 190, reason: "two clean exposures" }],
  });

  assert.equal(repo.applyProposal(proposal.id).ok, true);
  // A second apply of the same proposal is refused outright — re-running would
  // duplicate side effects (a second nutrition row, a re-run restructure). The
  // ledger keeps exactly one decision either way.
  const again = repo.applyProposal(proposal.id);
  assert.equal(again.ok, false);
  assert.match(String(again.error), /already applied/i);

  const decisions = repo.listBrainDecisions({ kind: "training_target" });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].source_ref_type, "plan_proposal");
  assert.equal(decisions[0].source_ref_key, String(proposal.id));
  assert.equal(decisions[0].status, "applied");
  assert.equal(decisions[0].reversible, false, "direct applies do not promise an undo snapshot they do not have");
  assert.equal(repo.getBrainRollback(decisions[0].id), null);
  assert.equal(decisions[0].action.plan_proposal_id, proposal.id);
  assert.doesNotMatch(JSON.stringify(decisions[0]), /raw output stays on proposal/);

  const expectations = repo.listBrainExpectations({ decisionId: decisions[0].id });
  assert.equal(expectations.length, 1);
  assert.equal(expectations[0].metric_key, "exercise_target_completion");
  assert.equal(expectations[0].subject_key, "Ledger Squat");
});

test("nutrition targets and plan restructures use their durable source links", () => {
  const nutrition = repo.createProposal("stub", "weekly check-in", "", {
    kind: "nutrition_target",
    nutrition: { target_kcal: 2600, protein_g: 180, reason: "support the mileage ramp" },
  });
  const nutritionResult = repo.applyProposal(nutrition.id);
  assert.ok(nutritionResult.accepted);

  const nutritionDecision = repo.listBrainDecisions({ kind: "nutrition_target" })[0];
  assert.equal(nutritionDecision.source_ref_type, "nutrition_target");
  assert.equal(nutritionDecision.source_ref_key, String(nutritionResult.accepted.id));
  assert.equal(nutritionDecision.action.plan_proposal_id, nutrition.id);
  assert.equal(nutritionDecision.context.expectation_basis, "cold_start_broad_band");
  assert.equal(repo.listBrainExpectations({ decisionId: nutritionDecision.id }).length, 1);

  const restructure = repo.createProposal("stub", "move to full body", "", {
    summary: "Use two full-body days for this block.",
    days: [
      { day_number: 1, name: "Full body A", focus: "full body", items: [{ exercise: "Goblet Squat", sets: 3 }] },
      { day_number: 2, name: "Full body B", focus: "full body", items: [{ exercise: "Row", sets: 3 }] },
    ],
  });
  assert.equal(repo.applyProposal(restructure.id).restructured, true);

  const structureDecision = repo.listBrainDecisions({ kind: "training_structure" })[0];
  assert.equal(structureDecision.source_ref_type, "plan_proposal");
  assert.equal(structureDecision.source_ref_key, String(restructure.id));
  assert.equal(structureDecision.action.day_count, 2);
  const structureExpectation = repo.listBrainExpectations({ decisionId: structureDecision.id });
  assert.equal(structureExpectation.length, 1);
  assert.equal(structureExpectation[0].metric_key, "plan_day_adherence");
  assert.equal(structureExpectation[0].target.planned_sessions, 8);
});

test("direct nutrition targets enter the ledger with a thin-data expectation that matures inconclusive", () => {
  const saved = repo.setNutritionTarget({
    target_kcal: 2400,
    protein_g: 170,
    source: "manual",
    note: "Try this anchor.",
  });
  const decision = repo.listBrainDecisions({ kind: "nutrition_target" })[0];
  assert.equal(decision.source_ref_key, String(saved.id));
  assert.equal(decision.reversible, false);
  assert.equal(repo.getBrainRollback(decision.id), null);
  const expectations = repo.listBrainExpectations({ decisionId: decision.id });
  assert.equal(expectations.length, 1);
  assert.equal(expectations[0].metric_key, "intake_to_weight_response");
  assert.equal(decision.context.expectation_basis, "cold_start_broad_band");

  const evaluated = evaluateMatureExpectations(expectations[0].window_end);
  assert.equal(evaluated.evaluations[0].verdict, "inconclusive");
  assert.ok(evaluated.evaluations[0].confounders.some((item) => /required|usable|enough/i.test(item)));
});

test("meal plan acceptance, discard, and sibling supersession are durable ledger transitions", () => {
  const older = repo.createMealPlan("stub", "raw older", completeMealWeek({
    daily_kcal: 2200,
    daily_protein_g: 170,
    summary: "Earlier option",
    days: [],
  }));
  const accepted = repo.createMealPlan("stub", "raw accepted", completeMealWeek({
    daily_kcal: 2300,
    daily_protein_g: 175,
    summary: "Current week",
    rationale: "Fits the current training week.",
    days: [],
  }));
  repo.acceptMealPlan(accepted.id);
  const declined = repo.createMealPlan("stub", "raw declined", completeMealWeek({ daily_kcal: 2400 }));
  repo.setMealPlanStatus(declined.id, "discarded");

  const decisions = repo.listBrainDecisions({ kind: "meal_plan", limit: 20 });
  const byPlan = Object.fromEntries(decisions.map((decision) => [decision.source_ref_key, decision]));
  assert.equal(byPlan[String(accepted.id)].status, "applied");
  assert.equal(byPlan[String(accepted.id)].reversible, false);
  assert.equal(byPlan[String(older.id)].status, "superseded");
  assert.equal(byPlan[String(declined.id)].status, "rejected");
  assert.equal(repo.listBrainExpectations({ decisionId: byPlan[String(accepted.id)].id }).length, 1);
  assert.equal(repo.listBrainExpectations({ decisionId: byPlan[String(older.id)].id }).length, 0);
  assert.doesNotMatch(JSON.stringify(decisions), /raw accepted|raw older|raw declined/);

  const editedDays = accepted.parsed.days.map((day, index) =>
    index === 0
      ? { ...day, day: "Mon", meals: [{ name: "Chicken bowl", kcal: 2300, protein_g: 175 }] }
      : day
  );
  repo.updateMealPlanDays(accepted.id, editedDays);
  repo.swapMealInPlan(accepted.id, "Mon", 0, { name: "Salmon bowl", kcal: 2300, protein_g: 175 });
  assert.equal(
    repo.listBrainDecisions({ kind: "meal_plan", limit: 20 }).length,
    decisions.length,
    "manual meal edits do not claim a separate reversible coaching decision"
  );
});

test("a nutrition target gets a weight-response expectation only with a measured baseline", () => {
  // Maintenance deliberately ignores today's unfinished intake and scale data.
  // Keep the fixture entirely on completed, aligned days with a full 7-day span
  // so this remains a genuinely measured baseline rather than a cold start.
  for (let daysAgo = 8; daysAgo >= 1; daysAgo--) {
    seedWeight(localDaysAgo(daysAgo), 180 - (8 - daysAgo) * 0.1);
    seedIntake(daysAgo, 2400);
  }
  const proposal = repo.createProposal("stub", "weekly check-in", "", {
    kind: "nutrition_target",
    nutrition: { target_kcal: 2500, protein_g: 180, reason: "slow the current loss rate" },
  });
  repo.applyProposal(proposal.id);

  const decision = repo.listBrainDecisions({ kind: "nutrition_target" })[0];
  assert.equal(decision.context.expectation_basis, "measured_expenditure");
  const expectations = repo.listBrainExpectations({ decisionId: decision.id });
  assert.equal(expectations.length, 1);
  assert.equal(expectations[0].metric_key, "intake_to_weight_response");
  assert.equal(expectations[0].direction, "within_band");
  assert.equal(expectations[0].minimum_data.weigh_ins, 6);
  assert.equal(expectations[0].minimum_data.intake_days, 10);
  assert.equal(expectations[0].baseline.recomposition_stage, "maintenance");
});

test("discarded and superseded proposal states are retained in the decision ledger", () => {
  repo.savePlanDay(1, "Lower", "legs", [{ exercise: "State Squat", sets: 3, target_weight: 100 }]);
  const superseded = repo.createProposal("stub", "auto: weekly squat target", "", {
    summary: "First training read.",
    changes: [{ day_number: 1, exercise: "State Squat", target_weight: 102, reason: "first read" }],
  });
  const applied = repo.createProposal("stub", "auto: weekly squat target", "", {
    summary: "Newer training read.",
    changes: [{ day_number: 1, exercise: "State Squat", target_weight: 105, reason: "newer data" }],
  });
  const intent = automaticOrphanIntent(applied);
  assert.ok(intent);
  repo.applyProposal(applied.id, {
    orphanSiblingCleanup: {
      intent_key: intent.key,
      eligible_before: new Date(Date.now() + 1_000).toISOString(),
      provenance: "automatic",
    },
  });

  const discarded = repo.createProposal("stub", "not wanted", "", {
    summary: "Optional training change.",
    changes: [{ day_number: 1, exercise: "State Squat", target_weight: 107, reason: "optional" }],
  });
  repo.setProposalStatus(discarded.id, "discarded");

  const decisions = repo.listBrainDecisions({ kind: "training_target", limit: 20 });
  const byRef = Object.fromEntries(decisions.map((decision) => [decision.source_ref_key, decision.status]));
  assert.equal(byRef[String(applied.id)], "applied");
  assert.equal(byRef[String(superseded.id)], "superseded");
  assert.equal(byRef[String(discarded.id)], "rejected");
});

test("saved day reads are date-linked and duplicate saves stay idempotent", () => {
  const date = localDaysAgo(0);
  const read = {
    kind: "easy",
    headline: "Keep today restorative.",
    why: "Sleep was short after two loading days.",
    focus: "recovery",
    est_minutes: 25,
    signals: { sleep_min: 330, consecutive_loading_days: 2 },
    source: "deterministic",
  };
  repo.saveDayRead(date, read);
  repo.saveDayRead(date, read);

  const decisions = repo.listBrainDecisions({ kind: "day_read" });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].source_ref_type, "day_read");
  assert.equal(decisions[0].source_ref_key, date);
  assert.equal(decisions[0].action.kind, "easy");
  assert.deepEqual(decisions[0].context.signals, read.signals);
});

test("active directive decisions use semantic links and dedupe across a diff-based re-apply", () => {
  const input = [
    {
      domain: "watch",
      marker: "ApoB",
      directive: "Discuss the ApoB trend with your clinician at the next review.",
      rationale: "The marker remains above the preferred range.",
      citation: "ACC/AHA Guideline",
    },
  ];
  assert.equal(repo.applyReviewDirectives(input), 1);
  const firstRow = db.prepare("SELECT id FROM health_directives WHERE status = 'active'").get();
  // A re-apply with identical content is now a zero-churn no-op: the diff keeps the exact
  // same physical row untouched (no clear+reinsert), so nothing is saved.
  assert.equal(repo.applyReviewDirectives(input), 0, "an unchanged re-apply churns nothing");
  const secondRow = db.prepare("SELECT id FROM health_directives WHERE status = 'active'").get();
  assert.equal(firstRow.id, secondRow.id, "the diff keeps the same physical row (stable id)");

  const decisions = repo.listBrainDecisions({ kind: "health_directive" });
  assert.equal(decisions.length, 1, "semantic directive identity prevents scheduler churn");
  assert.equal(decisions[0].source_ref_type, "directive");
  assert.match(decisions[0].source_ref_key, /^health_review:watch:apob:/);
  assert.equal(decisions[0].context.directive_row_id, firstRow.id);
  assert.equal(decisions[0].reversible, false, "clinician observations never claim an automatic rollback");
});

test("measurable marker directives carry a next-draw expectation", () => {
  repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-01-10",
    parsed_json: {
      markers: [{ name: "Vitamin D", value: 18, unit: "ng/mL", flag: "low" }],
    },
    enrichment_status: "done",
  });
  repo.deriveDirectives();
  const decision = repo.listBrainDecisions({ kind: "health_directive" }).find((row) => row.context.marker);
  assert.ok(decision);
  const expectations = repo.listBrainExpectations({ decisionId: decision.id });
  assert.ok(expectations.some((row) => row.metric_key === "marker_direction"));
  const marker = expectations.find((row) => row.metric_key === "marker_direction");
  assert.equal(marker.direction, "increase");
  assert.equal(marker.confounder_policy, "next_draw");
  assert.deepEqual(marker.minimum_data, { draws: 2 });
});

test("ledger failures never break authoritative proposal, day-read, or directive writes", () => {
  db.exec(`CREATE TRIGGER fail_brain_decision BEFORE INSERT ON brain_decisions
    BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END`);
  try {
    repo.savePlanDay(1, "Lower", "legs", [{ exercise: "Fail-soft Squat", sets: 3, target_weight: 100 }]);
    const proposal = repo.createProposal("stub", "small bump", "", {
      changes: [{ day_number: 1, exercise: "Fail-soft Squat", target_weight: 105, reason: "ready" }],
    });
    assert.equal(repo.applyProposal(proposal.id).ok, true);
    assert.equal(repo.getProposal(proposal.id).status, "applied");
    assert.equal(repo.getPlanDay(1).items[0].target_weight, 105);

    const date = localDaysAgo(0);
    repo.saveDayRead(date, { kind: "train", headline: "Train as planned.", why: "Recovery is steady." });
    assert.equal(repo.getCachedDayRead(date).kind, "train");

    assert.equal(
      repo.applyReviewDirectives([{ domain: "watch", directive: "Keep this finding on the next clinician agenda." }]),
      1
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_directives WHERE status = 'active'").get().n, 1);
    assert.equal(repo.listBrainDecisions().length, 0);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_brain_decision");
  }
});

test("full export includes all four hydrated ledger tables", () => {
  repo.savePlanDay(1, "Lower", "legs", [{ exercise: "Export Squat", sets: 3, target_weight: 100 }]);
  const proposal = repo.createProposal("stub", "small bump", "", {
    changes: [{ day_number: 1, exercise: "Export Squat", target_weight: 105, reason: "ready" }],
  });
  repo.applyProposal(proposal.id);
  const decision = repo.listBrainDecisions({ kind: "training_target" })[0];
  const expectation = repo.listBrainExpectations({ decisionId: decision.id })[0];
  repo.insertBrainEvaluation({
    expectation_id: expectation.id,
    verdict: "inconclusive",
    actual: null,
    evidence_keys: [],
    confounders: ["not enough exposures yet"],
    explanation: "The target has not had enough exposures to judge.",
    evaluator_version: "exercise-completion-v1",
  });
  repo.recordBrainToolCall({ run_id: "export-run", op: "review", tool: "read_exercise_history", status: "ok" });

  const backup = repo.exportAll();
  assert.equal(backup.brain_decisions.length, 1);
  assert.equal(backup.brain_decisions[0].action.plan_proposal_id, proposal.id);
  assert.equal(backup.brain_expectations.length, 1);
  assert.deepEqual(backup.brain_expectations[0].target, { exposures: 2 });
  assert.equal(backup.brain_evaluations.length, 1);
  assert.deepEqual(backup.brain_evaluations[0].confounders, ["not enough exposures yet"]);
  assert.equal(backup.brain_tool_calls.length, 1);
});
