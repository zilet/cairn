import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { recordDecision, transitionBrainDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { applyPersonalResponseModifier, whatWorksForYou } from "../dist/repo/reaction-model.js";

function decision(key, overrides = {}) {
  return {
    effective_date: "2026-01-01",
    kind: "nutrition_target",
    domain: "nutrition",
    summary: `Bounded nutrition adjustment ${key}.`,
    rationale: "Measure the response before changing the default again.",
    source: "test",
    source_ref_type: "nutrition_target",
    source_ref_key: key,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: { target_kcal: 2300 + Number(key) },
    specialist: null,
    applied_at: "2026-01-01T12:00:00.000Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "response-test-v1",
    ...overrides,
  };
}

function expectation(overrides = {}) {
  return {
    metric_key: "weight_trend_lb_wk",
    subject_key: null,
    direction: "within_band",
    baseline: { value: -1.2 },
    target: { min: -1, max: -0.2 },
    window_start: "2026-01-01",
    window_end: "2026-01-21",
    minimum_data: { weigh_ins: 6 },
    confounder_policy: "standard",
    confidence: "tentative",
    evaluator: "weight_trend",
    evaluator_version: "response-test-v1",
    ...overrides,
  };
}

function recordOutcome(key, verdict, opts = {}) {
  const recorded = recordDecision(decision(key, opts.decision), [expectation(opts.expectation)]);
  insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict,
    actual: opts.actual ?? { value: verdict === "aligned" ? -0.5 : 0, weigh_ins: opts.measurements ?? 8 },
    evidence_keys: [`bodyweight_log:2026-01-01..2026-01-21:n=${opts.measurements ?? 8}`],
    confounders: opts.confounders ?? [],
    explanation:
      verdict === "aligned"
        ? "The observed weight trend landed inside the expected band."
        : "The observed weight trend stayed outside the expected band.",
    evaluator_version: "response-test-v1",
  });
  return recorded;
}

test("one noisy outcome does not change a future personal default", () => {
  recordOutcome("1", "not_aligned", { measurements: 1 });

  assert.equal(whatWorksForYou(), null);
  assert.equal(repo.getCoachContext().what_works_for_you, null);
});

test("two expectations from one decision do not masquerade as two comparable decisions", () => {
  const recorded = recordDecision(decision("1"), [
    expectation(),
    expectation({ window_start: "2026-02-01", window_end: "2026-02-21" }),
  ]);
  for (const item of recorded.expectations) {
    insertBrainEvaluation({
      expectation_id: item.id,
      verdict: "not_aligned",
      actual: { value: 0, weigh_ins: 8 },
      evidence_keys: [`bodyweight_log:${item.window_start}..${item.window_end}:n=8`],
      confounders: [],
      explanation: "The observed weight trend stayed outside the expected band.",
      evaluator_version: "response-test-v1",
    });
  }

  assert.equal(whatWorksForYou(), null);
});

test("repeated clean misses earn a bounded modifier and appear in coach context", () => {
  recordOutcome("1", "not_aligned");
  recordOutcome("2", "not_aligned");

  const learned = whatWorksForYou();
  assert.ok(learned);
  assert.equal(learned.version, 2);
  assert.equal(learned.learnings.length, 1);
  assert.equal(learned.learnings[0].confidence, "observed");
  assert.equal(learned.learnings[0].evidence_n, 2);
  assert.equal(learned.learnings[0].missed_n, 2);
  assert.match(learned.learnings[0].statement, /missed the expectation/i);
  assert.equal(learned.modifiers[0].target, "nutrition_step");
  assert.equal(learned.modifiers[0].scale, 1.15);
  assert.deepEqual(learned.modifiers[0].never_overrides, ["injury", "allergy", "clinical", "lean_safe"]);

  const context = repo.getCoachContext().what_works_for_you;
  assert.equal(context.modifiers[0].scale, 1.15);
});

test("a later contradiction lowers confidence before a repeated new response supersedes the old one", () => {
  recordOutcome("1", "aligned");
  recordOutcome("2", "aligned");
  assert.equal(whatWorksForYou().modifiers[0].scale, 1);

  recordOutcome("3", "not_aligned");
  const mixed = whatWorksForYou();
  assert.equal(mixed.learnings[0].confidence, "tentative");
  assert.equal(mixed.learnings[0].contradictions, 1);
  assert.equal(mixed.modifiers.length, 0);
  assert.match(mixed.learnings[0].change, /(?:standard|universal) default/i);

  recordOutcome("4", "not_aligned");
  const superseded = whatWorksForYou();
  assert.equal(superseded.modifiers[0].scale, 1.15);
  assert.equal(superseded.learnings[0].superseded_evidence_n, 2);
  assert.equal(superseded.learnings[0].confidence, "observed");
});

test("superseded decisions do not count as comparable evidence", () => {
  const first = recordOutcome("1", "not_aligned");
  const second = recordOutcome("2", "not_aligned");
  transitionBrainDecision(first.decision.id, "superseded", { supersededBy: second.decision.id });

  assert.equal(whatWorksForYou(), null);
});

test("one strong repeated-measurement outcome can qualify without treating sparse evidence as strong", () => {
  recordOutcome("1", "aligned", {
    measurements: 14,
    expectation: { confidence: "strong" },
  });
  const learned = whatWorksForYou();
  assert.ok(learned);
  assert.equal(learned.learnings[0].confidence, "strong");
  assert.equal(learned.modifiers[0].scale, 1);
});

test("personal modifiers stay bounded and cannot weaken universal safety constraints", () => {
  const modifier = {
    key: "test",
    target: "training_progression_step",
    scale: 0.5,
    bounds: { min: 0.85, max: 1.1 },
    confidence: "strong",
    evidence_n: 4,
    rationale: "test",
    never_overrides: ["injury", "allergy", "clinical", "lean_safe"],
  };

  assert.equal(applyPersonalResponseModifier({ base: 100, modifier }), 85);
  assert.equal(applyPersonalResponseModifier({ base: 2200, modifier, safety_floor: 2100 }), 2100);
  for (const hard_constraint of ["injury", "allergy", "clinical"]) {
    assert.equal(applyPersonalResponseModifier({ base: 100, modifier, hard_constraint }), 100);
  }
});
