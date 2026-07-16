import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAIN_EVALUATION_VERDICTS } from "../dist/brain/evaluation-contract.js";
import { EVALUATOR_REGISTRY } from "../dist/brain/evaluators.js";
import { evaluateMatureExpectations } from "../dist/brainEvaluator.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { listBrainEvaluations } from "../dist/repo/brain-evaluations.js";
import { db } from "../dist/db.js";

// A matured window shared by every seeded expectation, and the as-of the nightly
// evaluator sweeps at. window_end <= asOf, so all of them are due in one pass.
const WINDOW_END = "2026-01-15";
const ASOF = "2026-01-15";

function decision(key, overrides = {}) {
  return {
    effective_date: "2026-01-01",
    kind: "nutrition_target",
    domain: "nutrition",
    summary: `Bounded change ${key} to evaluate.`,
    rationale: "A bounded change makes the response measurable.",
    source: "test",
    source_ref_type: null,
    source_ref_key: null,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: { seed: key }, // distinct action → a distinct fingerprint per seed
    specialist: null,
    applied_at: "2026-01-01T12:00:00.000Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "test-v1",
    ...overrides,
  };
}

function expectation(metric, overrides = {}) {
  return {
    metric_key: metric,
    subject_key: null,
    direction: "within_band",
    baseline: { value: -1.2 },
    target: { min: -1, max: -0.2 },
    window_start: "2026-01-01",
    window_end: WINDOW_END,
    minimum_data: { weigh_ins: 6 },
    confounder_policy: "standard",
    confidence: "tentative",
    evaluator: EVALUATOR_REGISTRY[metric].evaluator,
    evaluator_version: "test-v1",
    ...overrides,
  };
}

test("a single nightly sweep evaluates every matured expectation across kinds exactly once", () => {
  // A comprehensive Function-Health-style week: several matured expectations across
  // distinct metric kinds, all due at once. This is the throughput contract — the
  // sweep must cover EVERY matured expectation, not a subset.
  db.prepare(`INSERT INTO exercises (name, muscle_group) VALUES ('Bulgarian Split Squat', 'legs')`).run();

  const seeds = [
    recordDecision(decision("weight"), [expectation("weight_trend_lb_wk")]),
    recordDecision(decision("adherence", { kind: "training_target", domain: "training" }), [
      expectation("plan_day_adherence", {
        direction: "complete",
        baseline: null,
        target: { planned_sessions: 3 },
        minimum_data: null,
        confounder_policy: "none",
      }),
    ]),
    recordDecision(decision("exercise", { kind: "training_target", domain: "training" }), [
      expectation("exercise_target_completion", {
        subject_key: "Bulgarian Split Squat",
        direction: "complete",
        baseline: null,
        target: { value: 1 },
        minimum_data: null,
        confounder_policy: "none",
      }),
    ]),
    recordDecision(decision("intake"), [
      expectation("intake_to_weight_response", {
        baseline: { target_kcal: 2200, predicted_trend_lb_wk: -0.5, recomposition_stage: "mid_cut" },
        minimum_data: { weigh_ins: 6, intake_days: 3 },
        evaluator: "intake_response",
      }),
    ]),
  ];
  const expectationIds = seeds.map((s) => s.expectations[0].id);

  const result = evaluateMatureExpectations(ASOF);
  assert.equal(result.scanned, expectationIds.length, "the sweep scanned every matured expectation");
  assert.equal(result.evaluated, expectationIds.length, "every matured expectation was evaluated in one pass");
  assert.equal(result.errors, 0);

  // Each expectation has exactly one recorded evaluation carrying a valid verdict.
  for (const id of expectationIds) {
    const history = listBrainEvaluations(id);
    assert.equal(history.length, 1, `expectation ${id} evaluated exactly once`);
    assert.ok(BRAIN_EVALUATION_VERDICTS.includes(history[0].verdict), `expectation ${id} has a valid verdict`);
  }

  // A second identical sweep is idempotent — no expectation is re-evaluated or duplicated.
  const rerun = evaluateMatureExpectations(ASOF);
  assert.equal(rerun.evaluated, 0, "an unchanged nightly re-run appends nothing");
  for (const id of expectationIds) {
    assert.equal(listBrainEvaluations(id).length, 1, `expectation ${id} still has a single evaluation`);
  }
});
