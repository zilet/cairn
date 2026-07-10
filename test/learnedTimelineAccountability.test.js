import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";

function decision(key, overrides = {}) {
  return {
    effective_date: "2026-01-01",
    kind: "nutrition_target",
    domain: "nutrition",
    summary: `Make a bounded nutrition adjustment ${key}.`,
    rationale: "Learn from the measured response.",
    source: "test",
    source_ref_type: "nutrition_target",
    source_ref_key: key,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: { internal_score: 99 },
    action: { target_kcal: 2300 + Number(key), raw_secret: "do-not-render" },
    specialist: null,
    applied_at: "2026-01-01T12:00:00.000Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "timeline-test-v1",
    ...overrides,
  };
}

function expectation(overrides = {}) {
  return {
    metric_key: "weight_trend_lb_wk",
    subject_key: null,
    direction: "within_band",
    baseline: { value: -1.2 },
    target: { min: -1, max: -0.2, internal_score: 100 },
    window_start: "2026-01-01",
    window_end: "2026-01-21",
    minimum_data: { weigh_ins: 6 },
    confounder_policy: "standard",
    confidence: "tentative",
    evaluator: "weight_trend",
    evaluator_version: "timeline-test-v1",
    ...overrides,
  };
}

function recordOutcome(key, verdict, explanation) {
  const recorded = recordDecision(decision(key), [expectation()]);
  insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict,
    actual: { value: verdict === "aligned" ? -0.5 : 0, weigh_ins: 8, internal_score: 98 },
    evidence_keys: ["bodyweight_log:raw-row-ids-must-not-render:n=8"],
    confounders: [],
    explanation,
    evaluator_version: "timeline-test-v1",
  });
  return recorded;
}

test("Learned shows the latest authoritative decision outcome without raw internals", () => {
  const recorded = recordDecision(decision("1"), [expectation()]);
  insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict: "inconclusive",
    actual: null,
    evidence_keys: [],
    confounders: ["travel overlapped the window"],
    explanation: "Travel made the first read inconclusive.",
    evaluator_version: "timeline-test-v1",
  });
  insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict: "aligned",
    actual: { value: -0.5, weigh_ins: 8, internal_score: 98 },
    evidence_keys: ["bodyweight_log:raw-row-ids-must-not-render:n=8"],
    confounders: [],
    explanation: "The later clean trend landed inside the expected band.",
    evaluator_version: "timeline-test-v1",
  });

  const outcome = repo.learnedTimeline().items.find((item) => item.source === "accountability · nutrition");
  assert.ok(outcome);
  assert.equal(outcome.kind, "outcome");
  assert.equal(outcome.title, "A change that landed as expected");
  assert.match(outcome.detail, /Expected weight trend to within band/);
  assert.match(outcome.detail, /later clean trend/);

  const rendered = JSON.stringify(outcome);
  assert.doesNotMatch(
    rendered,
    /first read|travel overlapped|raw-row-ids|raw_secret|do-not-render|internal_score|target_kcal/i
  );
});

test("pending decisions stay out of the historical timeline until there is an outcome", () => {
  recordDecision(decision("1", { status: "pending", applied_at: null }), [expectation()]);
  assert.equal(
    repo.learnedTimeline().items.some((item) => item.kind === "outcome"),
    false
  );
});

test("Learned adds a compact cumulative personal-response item after repeated clean outcomes", () => {
  recordOutcome("1", "not_aligned", "The first clean trend stayed outside the expected band.");
  recordOutcome("2", "not_aligned", "The second clean trend stayed outside the expected band.");

  const items = repo.learnedTimeline().items;
  const personal = items.find((item) => item.source?.startsWith("personal response ·"));
  assert.ok(personal);
  assert.equal(personal.kind, "outcome");
  assert.equal(personal.title, "A response pattern Cairn has seen");
  assert.match(personal.detail, /missed the expectation across 2 comparable decisions/i);
  assert.match(personal.source, /observed · 2 comparable decisions/);
  assert.doesNotMatch(JSON.stringify(personal), /1\.15|scale|modifier|internal_score|raw-row-ids/i);
});
