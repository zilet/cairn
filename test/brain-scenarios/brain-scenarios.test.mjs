import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBrainDecision } from "../../dist/brain/decision-contract.js";
import { normalizeBrainEvaluation } from "../../dist/brain/evaluation-contract.js";
import { normalizeBrainExpectation, normalizeProposedExpectation } from "../../dist/brain/expectation-contract.js";
import { COACH_READ_TOOL_CATALOG, normalizeCoachReadToolRequest } from "../../dist/brain/read-tools.js";
import { normalizeSpecialistOpinion } from "../../dist/brain/specialist-contract.js";
import { evaluateScenario } from "./evaluate.mjs";
import { BRAIN_SCENARIOS } from "./fixtures.mjs";

const contracts = { normalizeBrainDecision, normalizeBrainEvaluation, normalizeSpecialistOpinion };

test("Phase-0 longitudinal fixtures cover the ten initial elite-brain scenarios", () => {
  assert.equal(BRAIN_SCENARIOS.length, 10);
  assert.equal(new Set(BRAIN_SCENARIOS.map((scenario) => scenario.id)).size, 10);
  for (const scenario of BRAIN_SCENARIOS) {
    const result = evaluateScenario(scenario, contracts);
    assert.ok(result.chronological, `${scenario.id}: timeline must be chronological`);
    assert.ok(result.is_longitudinal, `${scenario.id}: fixture must contain at least two distinct dates`);
    assert.ok(result.decision, `${scenario.id}: decision must satisfy the frozen contract`);
    assert.ok(result.opinions.every(Boolean), `${scenario.id}: specialist opinions must satisfy the frozen contract`);
    if (scenario.evaluation)
      assert.ok(result.evaluation, `${scenario.id}: evaluation must satisfy the frozen contract`);
  }
});

test("scenario decisions respect specialist ceilings and never make unsafe actions autonomous", () => {
  for (const scenario of BRAIN_SCENARIOS) {
    const result = evaluateScenario(scenario, contracts);
    assert.deepEqual(
      result.unsafe_autonomy_reasons,
      [],
      `${scenario.id}: ${result.unsafe_autonomy_reasons.join(", ")}`
    );
  }
});

test("scenario recommendations cite every material constraint as a structured evidence key", () => {
  for (const scenario of BRAIN_SCENARIOS) {
    const result = evaluateScenario(scenario, contracts);
    assert.deepEqual(
      result.missing_evidence_keys,
      [],
      `${scenario.id}: missing ${result.missing_evidence_keys.join(", ")}`
    );
  }
});

test("cross-domain contradictions are deterministic and match the pinned expectation", () => {
  for (const scenario of BRAIN_SCENARIOS) {
    const result = evaluateScenario(scenario, contracts);
    assert.deepEqual(result.contradictions, scenario.expected_contradictions.toSorted(), scenario.id);
  }
});

test("thin data and material ambiguity produce one question and inconclusive evaluation", () => {
  const thin = BRAIN_SCENARIOS.find((scenario) => scenario.id === "thin-data-uncertainty");
  const travel = BRAIN_SCENARIOS.find((scenario) => scenario.id === "travel-sparse-logging");
  for (const scenario of [thin, travel]) {
    assert.ok(scenario);
    const result = evaluateScenario(scenario, contracts);
    assert.equal(result.decision.autonomy_tier, "ask");
    assert.equal(scenario.question_count, 1);
    assert.equal(result.evaluation.verdict, "inconclusive");
  }
});

test("model-emitted contract normalizers reject unknown metrics, verdicts, and unevidenced opinions", () => {
  assert.equal(
    normalizeProposedExpectation({
      metric_key: "mood_score",
      direction: "increase",
      target: { value: 10 },
      window_start: "2026-07-01",
      window_end: "2026-07-14",
      confidence: "strong",
      evaluator: "session_feedback",
      evaluator_version: "v1",
    }),
    null
  );
  assert.equal(
    normalizeBrainExpectation({
      decision_id: 1,
      metric_key: "weight_trend_lb_wk",
      direction: "decrease",
      target: { max: -0.5 },
      window_start: "2026-08-01",
      window_end: "2026-07-01",
      confidence: "tentative",
      evaluator: "weight_trend",
      evaluator_version: "v1",
    }),
    null
  );
  assert.equal(
    normalizeBrainEvaluation({
      expectation_id: 1,
      verdict: "probably",
      explanation: "Guess",
      evaluator_version: "v1",
    }),
    null
  );
  assert.equal(
    normalizeSpecialistOpinion({
      domain: "health",
      recommendation: "Change the dose.",
      rationale: "Because.",
      evidence_keys: [],
      autonomy_ceiling: "quiet_apply",
    }),
    null
  );
});

test("read-tool request normalization is allowlisted and enforces date and row bounds", () => {
  const request = normalizeCoachReadToolRequest({
    tool: "read_exercise_history",
    args: { exercise: "Barbell Bench Press", start_date: "2026-01-01", end_date: "2026-06-01", limit: 200 },
  });
  assert.equal(request?.tool, "read_exercise_history");
  assert.equal(request?.args.limit, 200);
  assert.equal(normalizeCoachReadToolRequest({ tool: "update_plan", args: {} }), null);
  assert.equal(
    normalizeCoachReadToolRequest({
      tool: "read_recovery_window",
      args: { days: 91 },
    }),
    null
  );
  assert.equal(
    normalizeCoachReadToolRequest({
      tool: "read_exercise_history",
      args: { exercise: "Bench", start_date: "2025-01-01", end_date: "2026-01-01" },
    }),
    null
  );
  for (const tool of Object.values(COACH_READ_TOOL_CATALOG)) {
    assert.equal(tool.effect, "read");
    assert.equal(tool.launches_agent, false);
    assert.equal(tool.exposes_sensitive_raw_data, false);
    assert.ok(tool.max_rows > 0);
  }
});
