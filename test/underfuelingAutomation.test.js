import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { runUnderfuelingControlLoop } from "../dist/domain/brain/underfueling-service.js";
import { runEnergyDeficiencyWatch } from "../dist/domain/brain/energy-deficiency-service.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { applyDueAnnouncedDecisions, applyProposalWithAutonomy, revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { runWithTimeZone } from "../dist/tz.js";

const today = () => localDateISO();

function seedTarget(kcal = 2200) {
  db.prepare(
    `INSERT INTO nutrition_targets (effective_date, target_kcal, protein_g, carbs_g, fat_g, source)
     VALUES (?, ?, 175, 240, 70, 'test')`,
  ).run(addDaysISO(today(), -30), kcal);
  return repo.getActiveNutritionTarget(today());
}

function seedPlan() {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 4, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  repo.savePlanDay(2, "Run", "Aerobic", [
    { kind: "cardio", label: "Easy run", target_duration_min: 40, target_distance_km: 6, target_zone: "Z2" },
  ]);
}

function planShape(plan) {
  return plan.map((day) => ({
    day_number: day.day_number,
    name: day.name,
    focus: day.focus,
    items: day.items.map(({ id, ...item }) => item),
  }));
}

function read(state, signature = state) {
  const action = state === "execution_gap"
    ? { kind: "reshape_meals", kcal_delta: 0, training: "hold_aggression", line: "Make the existing target easier to complete." }
    : state === "prescription_strain"
      ? { kind: "raise_target", kcal_delta: 150, training: "hold_aggression", line: "Add one bounded carb-forward step." }
      : { kind: "recovery_package", kcal_delta: 250, training: "reduce", line: "Coordinate recovery and fuel." };
  return {
    as_of: today(),
    state,
    confidence: "medium",
    window: { since: addDaysISO(today(), -14), through: addDaysISO(today(), -1), calendar_days: 14 },
    uncertainty: { deadband_kcal: 225, deadband_basis: "test", missing_food_days: 0, partial_food_days: 0, note: "estimates" },
    intake: {
      observed_days: 10,
      credible_days: 10,
      compared_days: 10,
      materially_below_days: state === "execution_gap" ? 5 : 0,
      near_target_days: state === "execution_gap" ? 0 : 8,
      average_gap_kcal: state === "execution_gap" ? -400 : -25,
      current_target_kcal: 2200,
      maintenance_estimate_kcal: 2600,
    },
    correction: {
      target_id: 1,
      effective_date: addDaysISO(today(), state === "persistent_strain" ? -8 : -30),
      age_days: state === "persistent_strain" ? 8 : 30,
      upward_delta_kcal: state === "persistent_strain" ? 150 : null,
      settling: false,
    },
    channels: [],
    agreeing_channels: ["weight_trend", "performance", "recovery"],
    conflicting_channels: [],
    rationale: "Several independent completed-day outcome channels agree.",
    action,
    evidence_keys: ["test:underfueling"],
    signature,
  };
}

function seedNutritionMisses(stage) {
  for (const key of ["phase-miss-1", "phase-miss-2"]) {
    const recorded = recordDecision({
      effective_date: addDaysISO(today(), -40),
      kind: "nutrition_target",
      domain: "nutrition",
      summary: "Prior bounded fuel intervention.",
      rationale: "Evaluate before adapting again.",
      source: "test",
      source_ref_type: "nutrition_target",
      source_ref_key: key,
      status: "applied",
      autonomy_tier: "quiet_apply",
      risk_class: "low",
      reversible: true,
      input_fingerprint: null,
      context: { recomposition_stage: stage },
      action: { target_kcal: 2200 },
      specialist: null,
      applied_at: `${addDaysISO(today(), -40)}T12:00:00.000Z`,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: "phase-test-v1",
    }, [{
      metric_key: "intake_to_weight_response",
      subject_key: null,
      direction: "within_band",
      baseline: { target_kcal: 2200, recomposition_stage: stage },
      target: { min: -1, max: -0.2 },
      window_start: addDaysISO(today(), -40),
      window_end: addDaysISO(today(), -20),
      minimum_data: { weigh_ins: 6, intake_days: 10 },
      confounder_policy: "standard",
      confidence: "tentative",
      evaluator: "intake_response",
      evaluator_version: "phase-test-v1",
    }]);
    insertBrainEvaluation({
      expectation_id: recorded.expectations[0].id,
      verdict: "not_aligned",
      actual: { value: 0, trend_lb_wk: 0, weigh_ins: 8, intake_days: 12 },
      evidence_keys: [`clean:${key}:n=12`],
      confounders: [],
      explanation: "The observed trend was slower than the phase-matched prediction.",
      evaluator_version: "phase-test-v1",
    });
  }
}

function setMidCutProfile() {
  repo.setProfile({
    age: 40,
    sex: "male",
    height_cm: 180,
    start_weight_lb: 200,
    weight_lb: 185,
    goal_weight_lb: 170,
    goal_date: addDaysISO(today(), 120),
  });
}

beforeEach(() => {
  repo.setSettings({ lead_mode: "lead", proactive_enabled: true });
});

test("an execution gap queues a next-boundary meal reshape without changing calories or unrelated drafts", () => {
  seedTarget();
  const unrelated = repo.createProposal("chat", "athlete-authored", "", { summary: "Keep me", changes: [] });
  const beforeTargets = Number(db.prepare(`SELECT COUNT(*) AS n FROM nutrition_targets`).get().n);

  const result = runUnderfuelingControlLoop(today(), { read: read("execution_gap") });

  assert.equal(result.action, "meal_reshape_queued");
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM nutrition_targets`).get().n), beforeTargets);
  assert.equal(repo.getProposal(unrelated.id).status, "draft");
  assert.equal(repo.getAppState("meal_plan_refresh_requested"), addDaysISO(today(), 1));
  assert.match(repo.getAppState("meal_plan_refresh_instruction"), /calories unchanged/i);
  assert.match(repo.getAppState("meal_plan_refresh_instruction"), /carb-forward/i);
});

test("the control-loop cooldown never suppresses retry ownership after a meal reshape failure", async () => {
  seedTarget();
  const queued = runUnderfuelingControlLoop(today(), { read: read("execution_gap", "retry-owner") });
  const request = repo.getAppState(repo.MEAL_REFRESH_REQUEST_KEY);
  assert.equal(queued.action, "meal_reshape_queued");

  const failed = await repo.runOwnedMealRefreshAttempt(
    request,
    async () => ({ ok: false, error: "temporary agent failure" }),
    { today: request },
  );
  assert.equal(failed.ok, false);
  assert.equal(repo.getAppState(repo.MEAL_REFRESH_REQUEST_KEY), request);

  const cooldown = runUnderfuelingControlLoop(today(), { read: read("execution_gap", "same-cooldown") });
  assert.equal(cooldown.action, "none", "the control loop does not enqueue a duplicate reshape");
  assert.equal(repo.getAppState(repo.MEAL_REFRESH_REQUEST_KEY), request, "the scheduler-owned retry remains pending");
  const retryState = repo.getMealRefreshAttemptState();
  assert.equal(
    repo.mealRefreshRetryDue(request, new Date(Date.parse(retryState.next_attempt_at) + 1), request),
    true,
    "the persisted retry becomes due independently of the seven-day control cooldown",
  );
});

test("prescription strain schedules exactly one bounded correction inside the seven-day guard", () => {
  seedTarget();
  const first = runUnderfuelingControlLoop(today(), { read: read("prescription_strain", "one") });
  assert.equal(first.action, "nutrition_correction_scheduled");
  assert.equal(first.nutrition.pending, true);
  const proposal = repo.getProposal(Number(first.nutrition.decision.action.proposal_id));
  assert.equal(proposal.parsed.nutrition.target_kcal, 2350);
  assert.equal(proposal.parsed.nutrition.delta_kcal, 150);

  const second = runUnderfuelingControlLoop(today(), { read: read("prescription_strain", "two") });
  assert.equal(second.action, "none");
  assert.equal(repo.listBrainDecisions({ kind: "nutrition_target" }).length, 1, "no duplicate pending target");
});

test("under review posture, a persistent prescription strain never stacks more than one open protective-fuel review draft", () => {
  // Review posture holds every bounded correction for the athlete's decision instead of
  // owning it. The seven-day cooldown is deliberately NOT stamped on that held branch so
  // the correction stays retry-able — which, without supersession, let a fresh identical
  // held draft accumulate on every daily pass. This guards that at most one stays open.
  repo.setSettings({ lead_mode: "review_everything", proactive_enabled: true });
  seedTarget();

  const sig = "persistent-prescription-sig";
  for (let pass = 0; pass < 3; pass++) {
    const result = runUnderfuelingControlLoop(today(), { read: read("prescription_strain", sig) });
    assert.equal(result.action, "none", "a held correction reports no owned action");
  }

  // Exactly one open protective-fuel review draft survives all three daily passes.
  const openProtectiveDrafts = repo
    .listReviewHeldProposals(50)
    .filter((p) => p.agent === "underfuel-brain" && p.instruction === "auto: protective fuel correction");
  assert.equal(openProtectiveDrafts.length, 1, "held protective-fuel drafts do not pile up daily");

  // The ledger holds exactly one LIVE (review-status) decision for these drafts; the
  // earlier ones are superseded (terminal), so no live duplicate remains dangling.
  const liveReview = repo
    .listBrainDecisions({ status: "review", kind: "nutrition_target", domain: "nutrition", limit: 100 })
    .filter((d) => {
      const p = repo.getProposal(Number(d.source_ref_key));
      return p && p.agent === "underfuel-brain" && p.instruction === "auto: protective fuel correction";
    });
  assert.equal(liveReview.length, 1, "no live duplicate review decisions accumulate");
  assert.equal(
    Number(liveReview[0].source_ref_key),
    openProtectiveDrafts[0].id,
    "the one live review decision owns the one open draft",
  );

  // Retry-ability is preserved: the seven-day control cooldown was never stamped.
  assert.equal(repo.getAppState("underfuel_prescription_last_action"), null, "the held branch stamps no cooldown");
});

test("two clean same-stage misses make a standard 150 kcal correction become a rounded 175", () => {
  setMidCutProfile();
  seedNutritionMisses("mid_cut");
  seedTarget();
  const result = runUnderfuelingControlLoop(today(), { read: read("prescription_strain", "phase-earned") });
  const proposal = repo.getProposal(Number(result.nutrition.decision.action.proposal_id));
  assert.equal(proposal.parsed.nutrition.delta_kcal, 175);
  assert.equal(proposal.parsed.nutrition.target_kcal, 2375);
});

test("a nutrition modifier earned in another recomposition stage does not change the standard step", () => {
  setMidCutProfile();
  seedNutritionMisses("early_cut");
  seedTarget();
  const result = runUnderfuelingControlLoop(today(), { read: read("prescription_strain", "phase-mismatch") });
  const proposal = repo.getProposal(Number(result.nutrition.decision.action.proposal_id));
  assert.equal(proposal.parsed.nutrition.delta_kcal, 150);
});

test("persistent strain links a reversible recovery week and fuel step, applies them at boundaries, and is idempotent", () => {
  seedTarget();
  seedPlan();
  const priorPlan = planShape(repo.getPlan());
  const first = runUnderfuelingControlLoop(today(), { read: read("persistent_strain", "persistent") });

  assert.equal(first.action, "recovery_package_scheduled");
  assert.ok(first.coordination_key);
  assert.equal(first.nutrition.pending, true);
  assert.equal(first.recovery.announced, true);
  assert.equal(first.nutrition.decision.context.coordination_key, first.coordination_key);
  assert.equal(first.recovery.decision.context.coordination_key, first.coordination_key);

  const second = runUnderfuelingControlLoop(today(), { read: read("persistent_strain", "persistent-again") });
  assert.equal(second.action, "none");
  assert.equal(
    repo.listBrainDecisions({ limit: 100 }).filter((decision) => decision.context?.coordination_key === first.coordination_key).length,
    3,
    "the two owned decisions plus one immutable coordination link are recorded exactly once",
  );
  assert.equal(first.recovery.package_link.status, "observed");
  assert.equal(first.recovery.package_link.reversible, false);
  assert.equal(first.recovery.package_link.action.recovery_decision_id, first.recovery.decision.id);
  assert.equal(first.recovery.package_link.action.nutrition_decision_id, first.nutrition.decision.id);

  const due = applyDueAnnouncedDecisions("2099-01-01");
  assert.equal(due.applied.length, 2);
  assert.equal(repo.getActiveNutritionTarget().target_kcal, 2450, "fuel moves no more than 250 kcal toward maintenance");
  assert.deepEqual(planShape(repo.getPlan()), priorPlan, "the stable weekly plan remains unchanged");
  const recoveryCycle = repo.recoveryCycleAt(first.recovery.effective_date);
  assert.equal(recoveryCycle.effective_status, "active");
  assert.equal(recoveryCycle.overlay.source_decision_id, first.recovery.decision.id);

  assert.equal(revertDecision(first.recovery.decision.id, "resume the prior build").ok, true);
  assert.deepEqual(planShape(repo.getPlan()), priorPlan, "recovery Undo never rewrites the prior plan");
  assert.equal(repo.getRecoveryCycle(recoveryCycle.id, first.recovery.effective_date).effective_status, "canceled");
  assert.equal(revertDecision(first.nutrition.decision.id, "restore the prior target").ok, true);
  assert.equal(repo.getActiveNutritionTarget().target_kcal, 2200, "fuel Undo restores the prior target");
});

test("an existing recovery week is retained instead of duplicated", () => {
  seedTarget();
  seedPlan();
  const manualRecovery = repo.createProposal("coach", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Existing recovery week",
    days: [{ day_number: 1, name: "Push", focus: "Chest", items: [{ exercise: "Barbell Bench Press", sets: 2, rep_low: 6, rep_high: 8, target_weight: 165 }] }],
  });
  const scheduled = applyProposalWithAutonomy(manualRecovery.id, {
    requested_tier: "announce",
  });
  assert.equal(scheduled.announced, true);

  const result = runUnderfuelingControlLoop(today(), { read: read("persistent_strain", "existing-recovery") });
  assert.equal(result.action, "recovery_package_scheduled");
  assert.equal(result.recovery.reused, true);
  assert.equal(result.recovery.decision.id, scheduled.decision.id, "the original announced recovery decision remains the owner");
  assert.equal(result.recovery.package_link.action.recovery_decision_id, scheduled.decision.id);
  assert.match(result.reason, /existing owned recovery week/i);
  const recoveryDrafts = repo.listProposals(20).filter((proposal) => String(proposal.instruction).startsWith(repo.RECOVERY_WEEK_INSTRUCTION_PREFIX));
  assert.equal(recoveryDrafts.length, 1, "no second recovery reshape is created");

  const due = applyDueAnnouncedDecisions("2099-01-01");
  assert.equal(due.applied.length, 2);
  assert.equal(revertDecision(scheduled.decision.id, "undo the original manual recovery").ok, true);
  assert.equal(repo.getProposal(manualRecovery.id).status, "reverted", "Undo still belongs to the original decision/proposal");
});

test("an already-applied non-reversible recovery is linked truthfully and only nutrition claims Undo", () => {
  seedTarget();
  seedPlan();
  const manualRecovery = repo.createProposal("coach", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Directly applied recovery week",
    days: [
      { day_number: 1, name: "Push Recovery", focus: "Chest", items: [{ exercise: "Barbell Bench Press", sets: 2, rep_low: 6, rep_high: 8, target_weight: 165 }] },
      { day_number: 2, name: "Easy Run", focus: "Aerobic", items: [{ kind: "cardio", label: "Easy run", target_duration_min: 25, target_zone: "Z1-Z2" }] },
    ],
  });
  assert.equal(repo.applyProposal(manualRecovery.id).ok, true);
  const directDecision = repo.listBrainDecisions({ status: "applied", domain: "recovery", limit: 10 })
    .find((decision) => decision.source_ref_key === String(manualRecovery.id));
  assert.ok(directDecision);
  assert.equal(directDecision.reversible, false, "direct/manual apply has no invented rollback snapshot");

  const result = runUnderfuelingControlLoop(today(), { read: read("persistent_strain", "direct-applied-recovery") });
  assert.equal(result.action, "recovery_package_scheduled");
  assert.equal(result.recovery.reused, true);
  assert.equal(result.recovery.decision.id, directDecision.id);
  assert.equal(result.recovery.reversibility.reversible, false);
  assert.equal(result.recovery.package_link.action.recovery_reversible, false);
  assert.equal(result.recovery.package_link.action.recovery_undo_available_now, false);
  assert.equal(result.recovery.package_link.action.nutrition_reversible, true);
  assert.deepEqual(result.recovery.package_link.action.undo_decision_ids, [] , "pending nutrition gains rollback only after it applies");
  assert.match(result.reason, /already live without a rollback snapshot/i);
  assert.match(result.reason, /only the bounded nutrition decision claims Undo/i);
  assert.doesNotMatch(result.recovery.package_link.summary, /reversible expert-team response/i);
  assert.equal(revertDecision(directDecision.id, "try to undo direct apply").ok, false);

  const due = applyDueAnnouncedDecisions("2099-01-01");
  assert.equal(due.applied.length, 1, "only the scheduled nutrition half still had a boundary to land");
  const appliedNutrition = repo.getBrainDecision(result.nutrition.decision.id);
  assert.equal(appliedNutrition.reversible, true);
  assert.equal(revertDecision(appliedNutrition.id, "restore prior fuel target").ok, true);
  assert.equal(repo.getActiveNutritionTarget().target_kcal, 2200);
});

test("a bare recovery draft is routed through autonomy and is never described as scheduled while it remains review-only", () => {
  seedTarget();
  seedPlan();
  repo.setSettings({ lead_mode: "review_everything", proactive_enabled: true });
  const bare = repo.createProposal("coach", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Bare recovery draft",
    days: [{ day_number: 1, name: "Push", focus: "Chest", items: [{ exercise: "Barbell Bench Press", sets: 2, rep_low: 6, rep_high: 8, target_weight: 165 }] }],
  });
  assert.equal(repo.recoveryWeekStatus().state, "drafted");

  const result = runUnderfuelingControlLoop(today(), { read: read("persistent_strain", "bare-draft") });
  assert.notEqual(result.action, "recovery_package_scheduled");
  assert.equal(result.recovery.review_required, true);
  assert.equal(result.recovery.decision.source_ref_key, String(bare.id));
  assert.match(result.reason, /not scheduled/i);
  assert.equal(repo.listProposals(20).filter((proposal) => String(proposal.instruction).startsWith(repo.RECOVERY_WEEK_INSTRUCTION_PREFIX)).length, 1);
});

test("under review posture, a persistent strain never stacks more than one open protective fuel + recovery draft", () => {
  // Persistent strain schedules BOTH a bounded fuel correction and a coordinated recovery
  // week. Under review posture neither is owned and the branch stamps no cooldown, so —
  // without supersession — a daily scheduler pass would mint a fresh held nutrition draft
  // AND a fresh recovery review decision every day. Guard: at most one of each survives.
  repo.setSettings({ lead_mode: "review_everything", proactive_enabled: true });
  seedTarget();
  seedPlan();

  const sig = "persistent-strain-review-sig";
  for (let pass = 0; pass < 3; pass++) {
    const result = runUnderfuelingControlLoop(today(), { read: read("persistent_strain", sig) });
    assert.equal(result.action, "none", "a held package reports no owned action");
  }

  // Exactly one open protective-fuel NUTRITION review draft + one live review decision.
  const nutritionDrafts = repo
    .listReviewHeldProposals(50)
    .filter((p) => p.agent === "underfuel-brain" && p.instruction === "auto: protective fuel correction");
  assert.equal(nutritionDrafts.length, 1, "held protective-fuel nutrition drafts do not pile up daily");
  const liveNutritionReview = repo
    .listBrainDecisions({ status: "review", kind: "nutrition_target", domain: "nutrition", limit: 100 })
    .filter((d) => {
      const p = repo.getProposal(Number(d.source_ref_key));
      return p && p.agent === "underfuel-brain" && p.instruction === "auto: protective fuel correction";
    });
  assert.equal(liveNutritionReview.length, 1, "no live duplicate nutrition review decisions accumulate");

  // Exactly one open protective RECOVERY draft + one live review decision (the draft is
  // reused across passes, so what would otherwise pile is the review decision on it).
  const recoveryDrafts = repo
    .listProposals(50)
    .filter(
      (p) =>
        p.agent === "underfuel-brain" &&
        p.status === "draft" &&
        String(p.instruction).startsWith(repo.RECOVERY_WEEK_INSTRUCTION_PREFIX)
    );
  assert.equal(recoveryDrafts.length, 1, "the coordinated recovery draft is reused, never duplicated");
  const liveRecoveryReview = repo
    .listBrainDecisions({ status: "review", kind: "training_structure", domain: "recovery", limit: 100 })
    .filter((d) => {
      const p = repo.getProposal(Number(d.source_ref_key));
      return p && p.agent === "underfuel-brain" && String(p.instruction).startsWith(repo.RECOVERY_WEEK_INSTRUCTION_PREFIX);
    });
  assert.equal(liveRecoveryReview.length, 1, "no live duplicate recovery review decisions accumulate");

  // Retry-ability preserved: persistent strain never stamps a cooldown on the held branch.
  assert.equal(repo.getAppState("underfuel_prescription_last_action"), null, "the held branch stamps no cooldown");
});

// ---------------------------------------------------------------------------
// THE LOW-ENERGY-AVAILABILITY WATCH'S one action (src/domain/brain/energy-deficiency-service.ts).
// The cluster read itself is pinned in underfueling.test.js; what matters here is
// that a standing cluster produces exactly ONE bounded raise through the ordinary
// ledger, carries falsifiable predictions about the arms recovering, explains itself
// once, and then refuses to do it again inside the settling window.

function clusterRead(overrides = {}) {
  return {
    as_of: today(),
    state: "sustained_cluster",
    arms: [],
    met_keys: ["recovery_and_performance", "loss_pace"],
    met_keys_before: ["recovery_and_performance", "loss_pace"],
    sustained: true,
    protection: {
      raise: true,
      from_kcal: 2200,
      target_kcal: 2450,
      capped: false,
      reason: "Two independent arms have held, so the target moves 250 kcal toward measured maintenance.",
    },
    reason: "recovery_and_performance, loss_pace have agreed for at least 12 days while the deficit ran.",
    signature: "cluster-sig-1",
    ...overrides,
  };
}

function seedRecoverySignals() {
  for (let d = 34; d >= 1; d--) {
    db.prepare(`INSERT INTO daily_metrics (source, date, hrv_ms) VALUES ('apple', ?, ?)`).run(
      addDaysISO(today(), -d),
      d <= 7 ? 55 : 70,
    );
  }
  for (const d of [-12, -8, -4]) {
    db.prepare(`INSERT INTO sessions (date, performance) VALUES (?, 3)`).run(addDaysISO(today(), d));
  }
}

test("a standing cluster buys ONE bounded protective raise, with arm-recovery expectations and one calm explanation", () => {
  seedTarget(2200);
  seedRecoverySignals();

  const result = runEnergyDeficiencyWatch(today(), { read: clusterRead() });
  assert.equal(result.action, "protective_raise_scheduled");
  const decision = result.nutrition?.decision;
  assert.ok(decision, "the move goes through the autonomy ledger, never straight to the table");
  assert.equal(decision.domain, "nutrition");
  assert.equal(decision.kind, "nutrition_target");
  const proposal = repo.getProposal(Number(decision.source_ref_key));
  assert.equal(proposal.parsed.nutrition.target_kcal, 2450);
  assert.equal(proposal.parsed.nutrition.prev_target_kcal, 2200);
  assert.equal(proposal.parsed.nutrition.protein_g, 175, "protein is carried forward, never trimmed");

  // The falsifiable claim is that the arms that fired come back.
  assert.ok(result.expectations >= 1, "at least one arm-recovery prediction is attached");
  const metrics = repo.listBrainExpectations({ decisionId: Number(decision.id) }).map((row) => row.metric_key);
  assert.ok(metrics.includes("recovery_hrv_delta"), "the HRV arm is asked to recover");

  // One explanation, in the athlete's register, waiting in-app.
  const insight = db.prepare(`SELECT * FROM insights ORDER BY id DESC LIMIT 1`).get();
  assert.ok(insight, "the pattern is explained once");
  assert.equal(insight.status, "new");
  assert.doesNotMatch(`${insight.text} ${insight.rationale}`, /REDs|relative energy deficiency|syndrome|\d\/10/i);

  // A queued move has NOT stamped the cooldown — the fortnight starts when the change
  // lands — so what stops a second pass minting a second proposal is the in-flight guard.
  const again = runEnergyDeficiencyWatch(today(), { read: clusterRead() });
  assert.equal(again.action, "none");
  assert.match(again.reason, /waiting for the next food-day boundary/i);
  const drafts = repo.listProposals(20).filter((p) => String(p.agent) === "energy-deficiency-brain");
  assert.equal(drafts.length, 1, "no second protective draft is minted while the first waits");
});

// A protective raise never lands the moment it is decided: it waits for a food-day
// boundary, and the boundary re-validates it and may set it aside. Stamping the
// fortnight at decision time meant a raise that never happened still bought silence —
// the watch slept while the cluster stood and the athlete's food had not moved.
test("the fortnight of silence starts when the change LANDS, not when it is decided", () => {
  seedTarget(2200);
  seedRecoverySignals();
  const scheduled = runEnergyDeficiencyWatch(today(), { read: clusterRead() });
  assert.equal(scheduled.action, "protective_raise_scheduled");

  const due = applyDueAnnouncedDecisions("2099-01-01");
  assert.ok(due.applied.length >= 1, "the boundary applies the queued raise");
  assert.equal(repo.getActiveNutritionTarget().target_kcal, 2450);

  // With the raise in force, the same standing cluster is now held off by the cooldown
  // rather than by the in-flight guard — and the cooldown is what a fortnight of
  // repeated passes runs into.
  const after = runEnergyDeficiencyWatch(today(), { read: clusterRead() });
  assert.equal(after.action, "none");
  assert.match(after.reason, /settling window/i);
});

// `applied_at` is an INSTANT stamped by datetime('now') — UTC — while the watch runs
// on a LOCAL calendar day. West of Greenwich the two disagree every evening: a raise
// that landed at 6 PM carries a UTC stamp dated tomorrow, and reading the stamp's
// first ten characters dated the landing in the future. The window then held nothing
// at all for the rest of that evening, and the same standing cluster bought a second
// raise on the very next pass.
test("a raise that landed this evening is inside the window, not dated into tomorrow", () => {
  const zone = "Pacific/Midway"; // UTC-11, so a UTC stamp is a day ahead all evening
  seedTarget(2200);
  seedRecoverySignals();
  assert.equal(runEnergyDeficiencyWatch(today(), { read: clusterRead() }).action, "protective_raise_scheduled");
  assert.ok(applyDueAnnouncedDecisions("2099-01-01").applied.length >= 1);

  const zoneToday = localDateISO(new Date(), zone);
  // 05:00 UTC on the day AFTER the local one is 6 PM of that local evening.
  db.prepare(`UPDATE brain_decisions SET applied_at = ? WHERE status = 'applied'`).run(
    `${addDaysISO(zoneToday, 1)} 05:00:00`,
  );

  const after = runWithTimeZone(zone, () => runEnergyDeficiencyWatch(zoneToday, { read: clusterRead() }));
  assert.equal(after.action, "none");
  assert.match(after.reason, /settling window/i);
});

test("no standing cluster and no affordable raise are both no-ops", () => {
  seedTarget(2200);
  assert.equal(runEnergyDeficiencyWatch(today(), { read: clusterRead({ state: "emerging" }) }).action, "none");
  assert.equal(
    runEnergyDeficiencyWatch(today(), {
      read: clusterRead({
        protection: { raise: false, from_kcal: 2200, target_kcal: null, capped: true, reason: "no headroom" },
      }),
    }).action,
    "none",
  );
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM nutrition_targets`).get().n), 1, "no target was written");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM insights`).get().n, 0, "and nothing was explained");
});

// The baseline every protective step is measured FROM has to be the number the
// athlete is actually eating to. An accepted row goes `review_due` once its adaptive
// window elapses, and from that moment the goal's effective target — the formula —
// is what is in force. Reading the stale row instead put the baseline BELOW the
// number in force, and `capProtectiveRaise` waves a "raise" at or under its previous
// straight through as the ordinary path: a stale 1,500 row under a formula target of
// ~1,988 turned a protective raise into a CUT of several hundred calories.
test("the raise is measured from the target in force, never from a review-overdue row", () => {
  setMidCutProfile();
  db.prepare(
    `INSERT INTO nutrition_targets (effective_date, target_kcal, protein_g, carbs_g, fat_g, source)
     VALUES (?, 1500, 175, 150, 50, 'adaptive')`,
  ).run(addDaysISO(today(), -60));

  const stale = repo.getLatestNutritionTarget(today());
  assert.equal(stale.target_kcal, 1500);
  assert.equal(stale.review_due, true, "the accepted row is past its review window");
  const inForce = Number(repo.computeGoalCheck().effective_target.target_kcal);
  assert.ok(inForce > 1500, "so the formula target is what the athlete eats to");

  const state = repo.energyDeficiencyState(today());
  assert.equal(state.active_target_kcal, inForce, "the watch baselines on the same ladder the boundary uses");

  // And with that baseline, the only thing this watch can produce is a move UP.
  const read = repo.energyDeficiencyDecision({
    ...state,
    cut_active: true,
    tdee_kcal: 2600,
    tdee_basis: "logged_reality",
    arms: [
      { key: "loss_pace", verdict: "met", summary: "", evidence_keys: [] },
      { key: "mood_energy", verdict: "met", summary: "", evidence_keys: [] },
    ],
    arms_before: [
      { key: "loss_pace", verdict: "met", summary: "", evidence_keys: [] },
      { key: "mood_energy", verdict: "met", summary: "", evidence_keys: [] },
    ],
  });
  assert.equal(read.protection.raise, true);
  assert.ok(
    read.protection.target_kcal > inForce,
    `a protective move may only ever raise: ${read.protection.target_kcal} vs ${inForce} in force`,
  );
});

// A SET-ASIDE and a DECLINE are different answers. The boundary setting a raise aside
// is the evidence declining it, and the watch may come back tomorrow with a
// re-derived one. The ATHLETE declining it is an answer, and asking again tomorrow is
// nagging — which is exactly what happened while the settling window counted only
// `applied`: a discarded raise cleared the in-flight guard and was re-proposed every
// single day, forever.
test("an athlete's no buys the same fortnight of quiet an applied change buys", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  seedTarget(2200);
  seedRecoverySignals();

  const ourDrafts = () => repo.listProposals(50).filter((p) => String(p.agent) === "energy-deficiency-brain");
  for (let pass = 0; pass < 5; pass++) {
    runEnergyDeficiencyWatch(today(), { read: clusterRead() });
    // The athlete discards whatever is waiting on them.
    for (const draft of ourDrafts()) {
      if (draft.status === "draft") repo.setProposalStatus(Number(draft.id), "rejected");
    }
  }
  assert.equal(ourDrafts().length, 1, "exactly one ask per settling window, however many passes run");
  assert.equal(
    repo.listBrainDecisions({ domain: "nutrition", limit: 20 }).filter((d) => d.status === "rejected").length,
    1,
    "and exactly one decline was recorded",
  );

  // A set-aside is deliberately NOT this case: when the boundary declines a raise the
  // EVIDENCE said no, and the watch may return with a re-derived one.
});

test("waist-only prescription strain does not trigger the volume-restore pass", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 5, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  const cut = repo.createProposal("test", "volume change", "", {
    summary: "cut volume",
    changes: [
      {
        day_number: 1,
        exercise: "Barbell Bench Press",
        sets: 4,
        reason: "Fuelling is short right now.",
        volume_cause: "fuel",
      },
    ],
  });
  assert.equal(repo.applyProposal(cut.id).ok, true);

  const waistOnly = {
    ...read("prescription_strain", "waist-only"),
    action: {
      kind: "raise_target",
      kcal_delta: 150,
      training: "proceed",
      line: "Add one bounded carb-forward step.",
    },
  };
  const result = runUnderfuelingControlLoop(today(), { read: waistOnly });
  assert.equal(
    result.volume_restore,
    undefined,
    "training may proceed while calories are still moving; volume stays down"
  );
  const item = repo.getPlanDay(1).items.find((entry) => entry.exercise === "Barbell Bench Press");
  assert.equal(item.sets, 4, "the protective cut is left where it was");
});
