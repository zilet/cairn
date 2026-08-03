// WHAT IS ALLOWED TO SILENCE A VERDICT.
//
// A confounder forces `inconclusive`, so anything that produces one permanently and
// invisibly stops the learning loop dead. Two live annihilators are pinned here:
//
//   1. an OPEN-ENDED context event (end_date NULL) overlapped every window from its
//      start date to the end of time, so two injuries opened in late July and never
//      closed confounded every long-window evaluation opened afterwards;
//   2. an UNRECOGNIZED minimum_data key was recorded as a confounder, so 21 live
//      agent-authored expectations were silenced by rules — `credible_days`,
//      `rated_strength_sessions` — that no evaluator has ever counted.
//
// Neither is evidence that the data is untrustworthy. One is a row nobody closed; the
// other is a rule that was never applied to anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./_seed.js";
import { evaluateMatureExpectations, staleOpenEndedContextEvents } from "../dist/domain/brain/evaluation-service.js";
import { evaluateMetricObservation } from "../dist/brain/evaluators.js";
import { normalizeProposedExpectation } from "../dist/brain/expectation-contract.js";
import { recordDecision } from "../dist/domain/brain/decision-service.js";

const WINDOW_START = "2026-01-01";
const WINDOW_END = "2026-01-15";
const AS_OF = "2026-01-15";

function decision(overrides = {}) {
  return {
    effective_date: WINDOW_START,
    kind: "nutrition_target",
    domain: "nutrition",
    summary: "Keep the next change small and evaluate the observed response.",
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
    action: {},
    specialist: null,
    applied_at: "2026-01-01T12:00:00.000Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "test-v1",
    ...overrides,
  };
}

// A window whose evidence lands cleanly inside the expectation, so the ONLY thing that
// can move the verdict off `aligned` is a confounder.
function weightExpectation(overrides = {}) {
  return {
    metric_key: "weight_trend_lb_wk",
    subject_key: null,
    direction: "within_band",
    baseline: { value: -1.2 },
    target: { min: -1, max: -0.2 },
    window_start: WINDOW_START,
    window_end: WINDOW_END,
    minimum_data: { weigh_ins: 6, span_days: 10 },
    confounder_policy: "standard",
    confidence: "tentative",
    evaluator: "weight_trend",
    evaluator_version: "test-v1",
    ...overrides,
  };
}

function addCleanWeights() {
  const insert = db.prepare(`INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)`);
  for (const [date, weight] of [
    ["2026-01-01", 200],
    ["2026-01-04", 199.8],
    ["2026-01-07", 199.6],
    ["2026-01-10", 199.4],
    ["2026-01-13", 199.2],
    ["2026-01-15", 199.0],
  ]) {
    insert.run(date, weight);
  }
}

function contextEvent(row) {
  db.prepare(
    `INSERT INTO context_events (kind, title, detail, start_date, end_date, expected_recovery_days, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.kind ?? "injury",
    row.title ?? "Right hand joint pain",
    row.detail ?? null,
    row.start_date ?? null,
    row.end_date ?? null,
    row.expected_recovery_days ?? null,
    row.resolved_at ?? null
  );
}

function verdict() {
  addCleanWeights();
  const result = evaluateMatureExpectations(AS_OF);
  assert.equal(result.evaluated, 1, "the expectation must actually have been evaluated");
  return result.evaluations[0];
}

// ── open-ended context events ────────────────────────────────────────────────

test("an open-ended injury still inside its staleness horizon confounds the window", () => {
  recordDecision(decision(), [weightExpectation()]);
  // Twelve days before the window opens, no end date — the acute phase genuinely
  // overlaps, so silence is the honest answer.
  contextEvent({ start_date: "2025-12-20", end_date: null });

  const evaluation = verdict();
  assert.equal(evaluation.verdict, "inconclusive");
  assert.match(evaluation.confounders.join(" "), /overlapped the evaluation window/);
});

test("an open-ended injury aged past the horizon has stopped speaking", () => {
  recordDecision(decision(), [weightExpectation()]);
  // Opened in October and never closed. Under the old overlap test this row silenced
  // every window opened after it, forever.
  contextEvent({ start_date: "2025-10-01", end_date: null });

  const evaluation = verdict();
  assert.deepEqual(evaluation.confounders, []);
  assert.equal(evaluation.verdict, "aligned");
});

test("the event's own recorded healing window is the horizon where it has one", () => {
  recordDecision(decision(), [weightExpectation()]);
  contextEvent({ start_date: "2025-10-01", end_date: null, expected_recovery_days: 120 });

  const evaluation = verdict();
  assert.equal(evaluation.verdict, "inconclusive", "an injury that said it would take months is believed");
});

test("an event explicitly marked resolved keeps its own dates", () => {
  recordDecision(decision(), [weightExpectation()]);
  contextEvent({ start_date: "2025-12-28", end_date: null, resolved_at: "2025-12-30" });

  const evaluation = verdict();
  assert.deepEqual(evaluation.confounders, [], "healed before the window opened");
  assert.equal(evaluation.verdict, "aligned");
});

test("an explicitly dated event overlapping the window confounds it exactly as before", () => {
  recordDecision(decision(), [weightExpectation()]);
  contextEvent({ kind: "trip", title: "Ten days abroad", start_date: "2026-01-03", end_date: "2026-01-12" });

  assert.equal(verdict().verdict, "inconclusive");
});

test("aging past the horizon is visible to an operator rather than silent", () => {
  contextEvent({ start_date: "2025-10-01", end_date: null, title: "Right hand joint pain" });
  contextEvent({ start_date: "2026-01-10", end_date: null, title: "Tweaked calf" });
  contextEvent({ start_date: "2025-10-01", end_date: "2025-10-20", title: "Closed properly" });

  const stale = staleOpenEndedContextEvents(AS_OF);
  assert.equal(stale.length, 1, "only the unclosed row that has aged out is reported");
  assert.equal(stale[0].title, "Right hand joint pain");
  assert.equal(stale[0].horizon_end, "2025-10-15");
  assert.ok(stale[0].days_past_horizon > 80);
});

test("the diagnostics card carries the stale open-ended events", async () => {
  contextEvent({ start_date: "2025-10-01", end_date: null, title: "Right hand joint pain" });
  const { getBrainDiagnostics } = await import("../dist/domain/operator/brain-diagnostics-use-case.js");
  const rows = getBrainDiagnostics(5).metrics.stale_open_ended_context_events;
  assert.ok(Array.isArray(rows));
  assert.ok(rows.some((row) => row.title === "Right hand joint pain"));
});

// ── minimum_data ─────────────────────────────────────────────────────────────

test("an unsupported minimum-data rule is dropped at the write, in the open", () => {
  const normalized = normalizeProposedExpectation(
    weightExpectation({
      baseline: { value: -1.2 },
      minimum_data: { credible_days: 3, rated_strength_sessions: 2, weigh_in_days: 6, span_days: 10 },
    })
  );
  assert.deepEqual(normalized.minimum_data, { weigh_ins: 6, span_days: 10 }, "the alias is renamed, the rest dropped");
  assert.deepEqual(normalized.baseline.dropped_minimum_data, ["credible_days", "rated_strength_sessions"]);
  assert.equal(normalized.baseline.value, -1.2, "the rest of the baseline is untouched");
});

test("an agent-authored expectation with an unsupported rule still reaches a verdict", () => {
  recordDecision(decision(), [weightExpectation({ minimum_data: { credible_days: 3, weigh_ins: 6 } })]);

  const evaluation = verdict();
  assert.equal(evaluation.verdict, "aligned", "a rule nobody can check is not a reason to distrust the data");
  assert.deepEqual(evaluation.confounders, []);
});

// A row already on disk from before the write-time normalization existed. It cannot be
// reached through recordDecision, which now cleans it — so the evaluator is exercised
// directly, exactly as the nightly pass would meet the stored row.
function storedExpectation(minimumData) {
  return {
    id: 1,
    decision_id: 1,
    metric_key: "weight_trend_lb_wk",
    subject_key: null,
    direction: "at_least",
    baseline: { value: 0 },
    target: { value: 1 },
    window_start: WINDOW_START,
    window_end: WINDOW_END,
    minimum_data: minimumData,
    confounder_policy: "none",
    confidence: "tentative",
    status: "mature",
    evaluator: "weight_trend",
    evaluator_version: "test-v1",
  };
}

const OBSERVATION = {
  actual: { value: 1 },
  evidence_keys: ["weight_trend:fixture"],
  counts: { weigh_ins: 6, data_points: 6 },
  issues: [],
};

test("a legacy stored rule no evaluator counts degrades to an ignored note", () => {
  const evaluation = evaluateMetricObservation(storedExpectation({ rated_strength_sessions: 2 }), OBSERVATION);
  assert.equal(evaluation.verdict, "aligned");
  assert.deepEqual(evaluation.confounders, []);
  assert.match(evaluation.explanation, /Ignored unsupported minimum-data rule: rated_strength_sessions\./);
});

test("a genuine shortfall is still a confounder", () => {
  const evaluation = evaluateMetricObservation(storedExpectation({ weigh_ins: 12 }), OBSERVATION);
  assert.equal(evaluation.verdict, "inconclusive");
  assert.match(evaluation.confounders.join(" "), /Only 6 weigh ins were available; 12 were required\./);
});

test("a shortfall and an unsupported rule in one expectation keep their separate registers", () => {
  const evaluation = evaluateMetricObservation(storedExpectation({ weigh_ins: 12, credible_days: 3 }), OBSERVATION);
  assert.equal(evaluation.verdict, "inconclusive");
  assert.equal(evaluation.confounders.length, 1, "only the checkable rule confounds");
  assert.match(evaluation.explanation, /Ignored unsupported minimum-data rule: credible_days\./);
});
