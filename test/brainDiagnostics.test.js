import { test } from "node:test";
import assert from "node:assert/strict";
import { getBrainDiagnostics } from "../dist/domain/operator/brain-diagnostics-use-case.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation, recordBrainToolCall } from "../dist/repo/brain-evaluations.js";
import { db, isoDaysAgo } from "./_seed.js";

function decision(domain, status, key) {
  return {
    effective_date: isoDaysAgo(2),
    kind: domain === "nutrition" ? "nutrition_target" : "training_target",
    domain,
    summary: `${domain} decision ${key}`,
    rationale: "A bounded accountable change.",
    source: "test",
    source_ref_type: "plan_proposal",
    source_ref_key: key,
    status,
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: { key },
    specialist: null,
    applied_at: status === "applied" ? new Date().toISOString() : null,
    reverted_at: status === "reverted" ? new Date().toISOString() : null,
    superseded_by: null,
    evaluator_version: null,
  };
}

function maturedExpectation() {
  return {
    metric_key: "weight_trend_lb_wk",
    subject_key: null,
    direction: "within_band",
    baseline: { value: -1.2 },
    target: { min: -1, max: -0.25 },
    window_start: isoDaysAgo(20),
    window_end: isoDaysAgo(1),
    minimum_data: { weigh_ins: 6 },
    confounder_policy: "exclude_context_events",
    confidence: "tentative",
    evaluator: "weight_trend",
    evaluator_version: "nutrition-weight-v1",
  };
}

test("brain diagnostics aggregate accountability, autonomy, tools, and conference health", () => {
  const nutrition = recordDecision(decision("nutrition", "applied", "nutrition-1"), [maturedExpectation()]);
  const expectation = nutrition.expectations[0];
  insertBrainEvaluation({
    expectation_id: expectation.id,
    verdict: "aligned",
    actual: { value: -0.6 },
    evidence_keys: ["bodyweight_log:test"],
    confounders: [],
    explanation: "The measured trend landed inside the expected band.",
    evaluator_version: "nutrition-weight-v1",
  });
  recordDecision(decision("training", "applied", "training-1"));
  recordDecision(decision("training", "reverted", "training-2"));
  recordDecision(decision("training", "reverted", "training-3"));

  recordBrainToolCall({
    run_id: "conference-run-1",
    op: "case_conference",
    tool: "read_exercise_history",
    rows_returned: 8,
    latency_ms: 10,
    status: "ok",
  });
  recordBrainToolCall({
    run_id: "conference-run-1",
    op: "case_conference",
    tool: "read_marker_history",
    rows_returned: 0,
    latency_ms: 30,
    status: "budget_exhausted",
  });
  db.prepare(
    `INSERT INTO agent_jobs (status, kind, result_json, finished_at)
     VALUES ('done', 'case_conference', ?, datetime('now'))`
  ).run(JSON.stringify({
    ok: true,
    opinions: [{ domain: "training" }, { domain: "nutrition" }],
    unavailable: ["recovery"],
    conflicts: ["deficit_recovery"],
    unresolved_conflicts: [],
  }));

  const diagnostics = getBrainDiagnostics(10);
  assert.equal(diagnostics.metrics.decisions.material, 4);
  assert.equal(diagnostics.metrics.decisions.with_expectations, 1);
  assert.equal(diagnostics.metrics.decisions.expectation_coverage_pct, 25);
  assert.equal(diagnostics.metrics.expectations.matured, 1);
  assert.equal(diagnostics.metrics.expectations.matured_evaluated, 1);
  assert.equal(diagnostics.metrics.expectations.matured_evaluation_coverage_pct, 100);
  assert.deepEqual(diagnostics.metrics.expectations.latest_verdicts, { aligned: 1 });
  assert.equal(diagnostics.metrics.decisions.revert_rate_pct, 50);
  assert.deepEqual(diagnostics.metrics.autonomy.demoted_domains, ["training"]);
  assert.equal(diagnostics.metrics.tools.calls, 2);
  assert.equal(diagnostics.metrics.tools.runs, 1);
  assert.equal(diagnostics.metrics.tools.budget_exhausted, 1);
  assert.equal(diagnostics.metrics.tools.average_latency_ms, 20);
  assert.equal(diagnostics.metrics.conferences.jobs, 1);
  assert.equal(diagnostics.metrics.conferences.successful, 1);
  assert.equal(diagnostics.metrics.conferences.conflicts_detected, 1);
  assert.equal(diagnostics.metrics.conferences.conflicts_unresolved, 0);
  assert.equal(diagnostics.metrics.conferences.specialist_availability_pct, 66.7);
});
