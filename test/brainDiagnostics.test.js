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
  ).run(
    JSON.stringify({
      ok: true,
      opinions: [{ domain: "training" }, { domain: "nutrition" }],
      unavailable: ["recovery"],
      conflicts: ["deficit_recovery"],
      unresolved_conflicts: [],
    })
  );
  db.prepare(
    `INSERT INTO agent_jobs (status, kind, result_json, finished_at)
     VALUES ('done', 'case_conference', ?, datetime('now'))`
  ).run(
    JSON.stringify({
      ok: true,
      opinions: [{ domain: "recovery" }],
      unavailable: [],
      conflicts: [],
      unresolved_conflicts: [],
      decision: {
        kind: "case_conference",
        domain: "recovery",
        summary: "Keep recovery protected.",
        rationale: "The complete conference supports a bounded recovery focus.",
        risk_class: "low",
        reversible: false,
        autonomy_tier: "ask",
        parallel_actions: [],
        resolved_conflicts: [],
        deferred: [],
        expectations: [],
        review_window: "Review in two weeks.",
        user_explanation: "I am keeping recovery protected.",
        revision: null,
      },
    })
  );
  const addSpecialistAttempt = (op, ok, parsed, errorClass = null, status = ok ? "ok" : "invalid_output") =>
    db
      .prepare(
        `INSERT INTO agent_runs (op, agent, ok, parsed, tried_json, status, error_class)
       VALUES (?, 'stub', ?, ?, 0, ?, ?)`
      )
      .run(op, ok ? 1 : 0, parsed ? 1 : 0, status, errorClass);
  addSpecialistAttempt("conference_training", true, true);
  addSpecialistAttempt("conference_nutrition", false, true, "invalid_contract");
  addSpecialistAttempt("conference_recovery", false, false, "process_error", "error");
  addSpecialistAttempt("conference_health", false, false, "invalid_json");

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
  assert.equal(diagnostics.metrics.conferences.jobs, 2);
  assert.equal(diagnostics.metrics.conferences.successful, 2);
  assert.equal(diagnostics.metrics.conferences.complete_successful, 1);
  assert.equal(diagnostics.metrics.conferences.useful_degraded_or_incomplete, 1);
  assert.equal(diagnostics.metrics.conferences.degraded, 0);
  assert.equal(diagnostics.metrics.conferences.incomplete, 1);
  assert.equal(diagnostics.metrics.conferences.conflicts_detected, 1);
  assert.equal(diagnostics.metrics.conferences.conflicts_unresolved, 0);
  assert.equal(diagnostics.metrics.conferences.specialist_valid_opinions, 3);
  assert.equal(diagnostics.metrics.conferences.specialist_valid_opinion_yield_pct, 75);
  assert.equal(diagnostics.metrics.conferences.specialist_agent_attempts, 4);
  assert.equal(diagnostics.metrics.conferences.specialist_agent_accepted_turns, 1);
  assert.equal(diagnostics.metrics.conferences.specialist_contract_failures, 1);
  assert.equal(diagnostics.metrics.conferences.specialist_parse_failures, 1);
  assert.equal(diagnostics.metrics.conferences.specialist_provider_process_failures, 1);
  assert.equal(diagnostics.metrics.conferences.specialist_availability_pct, 75);
  // The additive failure-cause breakdown: every failed attempt by its class, and every
  // missing seat by the conference's reason code ("unrecorded" on an older row).
  assert.deepEqual(diagnostics.metrics.conferences.specialist_failure_causes, {
    invalid_contract: 1,
    process_error: 1,
    invalid_json: 1,
  });
  assert.deepEqual(diagnostics.metrics.conferences.specialist_unavailable_reasons, { unrecorded: 1 });
});

test("conference diagnostics break missing seats and failed attempts down by cause", () => {
  const job = (result) =>
    db
      .prepare(
        `INSERT INTO agent_jobs (status, kind, result_json, finished_at)
         VALUES ('done', 'case_conference', ?, datetime('now'))`
      )
      .run(JSON.stringify(result));
  job({
    ok: true,
    degraded: true,
    opinions: [{ domain: "training" }, { domain: "nutrition" }, { domain: "health" }],
    unavailable: ["recovery", "lifestyle"],
    unavailable_reasons: { recovery: "deadline", lifestyle: "host_busy" },
    specialist_outcomes: [
      { domain: "training", reason: "ok", busy_deferrals: 0 },
      { domain: "nutrition", reason: "ok", busy_deferrals: 1 },
      { domain: "health", reason: "ok", busy_deferrals: 0 },
      { domain: "recovery", reason: "deadline", busy_deferrals: 0 },
      { domain: "lifestyle", reason: "host_busy", busy_deferrals: 3 },
    ],
    conductor_outcome: { reason: "invalid_decision", detail: null, busy_deferrals: 1 },
    conflicts: [],
    unresolved_conflicts: [],
  });
  job({
    ok: false,
    opinions: [{ domain: "training" }],
    unavailable: ["nutrition", "recovery"],
    unavailable_reasons: { nutrition: "providers_exhausted", recovery: "providers_exhausted" },
    conductor_outcome: { reason: "not_convened", detail: "below_quorum", busy_deferrals: 0 },
    conflicts: [],
    unresolved_conflicts: [],
  });
  for (const [errorClass, status] of [
    ["rate_limited", "rate_limited"],
    ["rate_limited", "rate_limited"],
    ["quota_exhausted", "quota_exhausted"],
    ["timeout", "timeout"],
  ]) {
    db.prepare(
      `INSERT INTO agent_runs (op, agent, ok, parsed, tried_json, status, error_class)
       VALUES ('conference_recovery', 'stub', 0, 0, 0, ?, ?)`
    ).run(status, errorClass);
  }

  const conferences = getBrainDiagnostics(5).metrics.conferences;
  assert.deepEqual(conferences.specialist_unavailable_reasons, {
    deadline: 1,
    host_busy: 1,
    providers_exhausted: 2,
  });
  assert.deepEqual(conferences.specialist_failure_causes, { rate_limited: 2, quota_exhausted: 1, timeout: 1 });
  // The pre-existing buckets are unchanged: availability holds still land in "other".
  assert.equal(conferences.specialist_other_failures, 3);
  assert.equal(conferences.specialist_busy_deferrals, 4);
  assert.deepEqual(conferences.conductor_outcomes, { invalid_decision: 1, not_convened: 1 });
  assert.equal(conferences.conductor_busy_deferrals, 1);
  assert.equal(conferences.below_quorum, 1);
});
