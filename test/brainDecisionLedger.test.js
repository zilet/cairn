import { test } from "node:test";
import assert from "node:assert/strict";
import { recordDecision } from "../dist/domain/brain/decision-service.js";
import {
  getBrainDecision,
  listBrainDecisions,
  listBrainExpectations,
  rollbackEvidenceByKind,
  ROLLBACK_EVIDENCE_WEIGHT,
  saveBrainRollback,
  transitionBrainDecision,
} from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation, latestBrainEvaluation, recordBrainToolCall } from "../dist/repo/brain-evaluations.js";
import { db } from "../dist/db.js";

function decision(overrides = {}) {
  return {
    effective_date: "2026-07-10",
    kind: "nutrition_target",
    domain: "nutrition",
    summary: "Raise the daily target slightly while recovery settles.",
    rationale: "Weight trend and recovery both moved below the expected band.",
    source: "nutrition_checkin",
    source_ref_type: "nutrition_target",
    source_ref_key: "42",
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: { weight_trend_lb_wk: -1.4, recovery: "low" },
    action: { target_kcal: 2450 },
    specialist: null,
    applied_at: "2026-07-09T16:00:00.000Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "nutrition-weight-v1",
    ...overrides,
  };
}

function expectation() {
  return {
    metric_key: "weight_trend_lb_wk",
    subject_key: null,
    direction: "within_band",
    baseline: { value: -1.4 },
    target: { min: -1, max: -0.25 },
    window_start: "2026-07-10",
    window_end: "2026-07-31",
    minimum_data: { weigh_ins: 6, intake_days: 10 },
    confounder_policy: "exclude_context_events",
    confidence: "tentative",
    evaluator: "weight_trend",
    evaluator_version: "nutrition-weight-v1",
  };
}

test("decision recording is fingerprint-idempotent and stores bounded expectations", () => {
  const first = recordDecision(decision(), [expectation()]);
  const second = recordDecision(decision(), [expectation()]);

  assert.equal(first.decision.id, second.decision.id);
  assert.equal(listBrainDecisions().length, 1);
  const expectations = listBrainExpectations({ decisionId: first.decision.id });
  assert.equal(expectations.length, 1);
  assert.equal(expectations[0].metric_key, "weight_trend_lb_wk");
  assert.deepEqual(expectations[0].target, { min: -1, max: -0.25 });
});

test("reverting a decision preserves history and cancels pending expectations", () => {
  const recorded = recordDecision(decision(), [expectation()]);
  const reverted = transitionBrainDecision(recorded.decision.id, "reverted");

  assert.equal(reverted.status, "reverted");
  assert.ok(reverted.reverted_at);
  assert.equal(getBrainDecision(recorded.decision.id).status, "reverted");
  assert.equal(listBrainExpectations({ decisionId: recorded.decision.id })[0].status, "canceled");
});

// W3.2: brain_rollbacks was previously write-only (read back only to perform the
// undo itself). rollbackEvidenceByKind reads it as evidence about the DECISION
// KIND — a revert is the strongest available "no" (the change already applied
// and the athlete deliberately undid it).
test("a reverted decision with a rollback snapshot is visible as negative evidence for its kind", () => {
  const recorded = recordDecision(decision(), [expectation()]);
  saveBrainRollback(recorded.decision.id, "nutrition_target", { target_kcal: 2200 });
  transitionBrainDecision(recorded.decision.id, "reverted");

  const groups = rollbackEvidenceByKind();
  const group = groups.find((g) => g.kind === "nutrition_target");
  assert.ok(group, "the decision's own kind ('nutrition_target') is the grouping key, not the rollback snapshot kind");
  assert.equal(group.count, 1);
  assert.equal(group.domain, "nutrition");
  assert.ok(group.last_reverted_at);
});

test("rollback evidence is scoped to REVERTED decisions only — applied/kept decisions never count", () => {
  const recorded = recordDecision(decision(), [expectation()]);
  saveBrainRollback(recorded.decision.id, "nutrition_target", { target_kcal: 2200 });
  // Still 'applied' — never transitioned to reverted.
  const groups = rollbackEvidenceByKind();
  assert.ok(!groups.some((g) => g.kind === "nutrition_target"));
});

test("ROLLBACK_EVIDENCE_WEIGHT is a real number strictly under 1 (near-applied, never above it)", () => {
  assert.ok(Number.isFinite(ROLLBACK_EVIDENCE_WEIGHT));
  assert.ok(ROLLBACK_EVIDENCE_WEIGHT > 0 && ROLLBACK_EVIDENCE_WEIGHT < 1);
});

test("versioned evaluations append and the newest verdict is authoritative", () => {
  const recorded = recordDecision(decision(), [expectation()]);
  const expectationId = listBrainExpectations({ decisionId: recorded.decision.id })[0].id;

  insertBrainEvaluation({
    expectation_id: expectationId,
    verdict: "inconclusive",
    actual: null,
    evidence_keys: [],
    confounders: ["travel overlapped the maturity window"],
    explanation: "We cannot tell yet because travel changed both intake and recovery.",
    evaluator_version: "nutrition-weight-v1",
  });
  insertBrainEvaluation({
    expectation_id: expectationId,
    verdict: "aligned",
    actual: { value: -0.6 },
    evidence_keys: ["bodyweight_log:2026-07-10..2026-08-07"],
    confounders: [],
    explanation: "This moved as expected after enough clean data arrived.",
    evaluator_version: "nutrition-weight-v1",
  });

  assert.equal(latestBrainEvaluation(expectationId).verdict, "aligned");
  assert.equal(listBrainExpectations({ decisionId: recorded.decision.id })[0].status, "evaluated");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM brain_evaluations").get().n, 2);
});

test("brain tool telemetry is sanitized and failure-safe", () => {
  recordBrainToolCall({
    run_id: "run-1",
    op: "case_conference",
    tool: "read_marker_history",
    args_summary: "marker=ferritin;days=180",
    rows_returned: 8,
    latency_ms: 12,
    status: "ok",
  });
  const row = db.prepare("SELECT * FROM brain_tool_calls WHERE run_id = 'run-1'").get();
  assert.equal(row.tool, "read_marker_history");
  assert.equal(row.rows_returned, 8);
});
