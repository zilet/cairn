// Model 1 — body-measurement verdicts as EVIDENCE into the nutrition-step reasoning
// (src/repo/reaction-model.ts modifierFor / whatWorksForYou). Invariants:
//   - a decisive, repeated body_measurement_direction outcome earns a bounded
//     nutrition_step modifier, staged per recomposition phase like the weight lever
//   - the measurement modifier can only HOLD (aligned) or EASE toward conservative
//     (missed) — capped at max 1, never inflating a deficit
//   - a single (sparse) outcome earns nothing (decisive-but-not-repeated stays quiet)
//   - the PRIMARY weight lever takes precedence: when both exist for the same
//     target+stage, personalResponseModifierFor returns the weight-based modifier;
//     measurement evidence only sets the step when no weight modifier exists
// Deterministic, offline, temp DB (see test/run.mjs). Imports from dist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { whatWorksForYou, personalResponseModifierFor } from "../dist/repo/reaction-model.js";

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
    action: { target_kcal: 2300 },
    specialist: null,
    applied_at: "2026-01-01T12:00:00.000Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "bm-test-v1",
    ...overrides,
  };
}

// A body-measurement expectation records its recomposition phase in the baseline, so
// the learning stages per phase exactly like the weight lever.
function bodyExpectation(overrides = {}) {
  return {
    metric_key: "body_measurement_direction",
    subject_key: "waist_in",
    direction: "decrease",
    baseline: { value: 34, recomposition_stage: "mid_cut" },
    target: { max: 33.5 },
    window_start: "2026-01-01",
    window_end: "2026-01-28",
    minimum_data: { measurements: 2 },
    confounder_policy: "standard",
    confidence: "tentative",
    evaluator: "body_measurement_direction",
    evaluator_version: "bm-test-v1",
    ...overrides,
  };
}

function weightExpectation(overrides = {}) {
  return {
    metric_key: "weight_trend_lb_wk",
    subject_key: null,
    direction: "within_band",
    baseline: { value: -1.2, recomposition_stage: "mid_cut" },
    target: { min: -1, max: -0.2 },
    window_start: "2026-01-01",
    window_end: "2026-01-21",
    minimum_data: { weigh_ins: 6 },
    confounder_policy: "standard",
    confidence: "tentative",
    evaluator: "weight_trend",
    evaluator_version: "bm-test-v1",
    ...overrides,
  };
}

function recordBody(key, verdict, opts = {}) {
  const recorded = recordDecision(decision(key, opts.decision), [bodyExpectation(opts.expectation)]);
  insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict,
    actual: { value: verdict === "aligned" ? 33.2 : 34.1, delta: verdict === "aligned" ? -0.8 : 0.1, measurements: opts.measurements ?? 4 },
    evidence_keys: [`body_measurements:2026-01-01..2026-01-28:n=${opts.measurements ?? 4}`],
    confounders: opts.confounders ?? [],
    explanation:
      verdict === "aligned"
        ? "The waist trend moved toward the expected band."
        : "The waist trend did not move as expected.",
    evaluator_version: "bm-test-v1",
  });
  return recorded;
}

function recordWeight(key, verdict, opts = {}) {
  const recorded = recordDecision(decision(key, opts.decision), [weightExpectation(opts.expectation)]);
  insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict,
    actual: { value: verdict === "aligned" ? -0.5 : 0, weigh_ins: opts.measurements ?? 8 },
    evidence_keys: [`bodyweight_log:2026-01-01..2026-01-21:n=${opts.measurements ?? 8}`],
    confounders: [],
    explanation: "weight trend test",
    evaluator_version: "bm-test-v1",
  });
  return recorded;
}

test("a repeated aligned body-measurement trend HOLDS the nutrition step (scale 1, capped)", () => {
  recordBody("1", "aligned");
  recordBody("2", "aligned");
  const learned = whatWorksForYou();
  assert.ok(learned, "a learning is earned from two clean measurement outcomes");
  const mod = learned.modifiers.find((m) => m.target === "nutrition_step");
  assert.ok(mod, "a nutrition_step modifier is produced from the measurement evidence");
  assert.equal(mod.stage, "mid_cut", "the modifier is staged to the recomposition phase");
  assert.equal(mod.scale, 1, "an aligned composition trend supports the current step");
  assert.equal(mod.bounds.max, 1, "measurement evidence can never inflate a deficit");
  assert.deepEqual(mod.never_overrides, ["injury", "allergy", "clinical", "lean_safe"]);
});

test("a repeated missed body-measurement trend EASES toward conservative (scale 0.9)", () => {
  recordBody("1", "not_aligned");
  recordBody("2", "not_aligned");
  const mod = whatWorksForYou().modifiers.find((m) => m.target === "nutrition_step");
  assert.ok(mod);
  assert.equal(mod.scale, 0.9, "a missed composition trend is evidence toward the conservative side");
  assert.ok(mod.bounds.min >= 0.9 && mod.bounds.max <= 1);
});

test("a single body-measurement outcome earns no modifier", () => {
  recordBody("1", "not_aligned");
  assert.equal(whatWorksForYou(), null, "one decisive outcome is below the repeat floor");
});

test("body-measurement outcomes from different phases do not combine into one trial group", () => {
  recordBody("1", "not_aligned", { expectation: { baseline: { value: 34, recomposition_stage: "mid_cut" } } });
  recordBody("2", "not_aligned", { expectation: { baseline: { value: 32, recomposition_stage: "leaning_out" } } });
  assert.equal(whatWorksForYou(), null, "distinct phases stay distinct, neither repeats");
});

test("the primary weight lever takes precedence over measurement evidence for the same phase", () => {
  // A weight lever that wants a LARGER step (missed, losing too slowly) + an aligned
  // measurement lever (hold). personalResponseModifierFor must return the weight one.
  recordWeight("w1", "not_aligned"); // value 0 vs a -1..-0.2 band → wants a larger step (1.15)
  recordWeight("w2", "not_aligned");
  recordBody("b1", "aligned");
  recordBody("b2", "aligned");

  const chosen = personalResponseModifierFor("nutrition_step", { stage: "mid_cut" });
  assert.ok(chosen, "a nutrition_step modifier is available for the phase");
  assert.equal(chosen.scale, 1.15, "the weight lever wins; measurement evidence does not shadow it");
});

test("measurement evidence sets the step when no weight lever exists for the phase", () => {
  recordBody("b1", "not_aligned");
  recordBody("b2", "not_aligned");
  const chosen = personalResponseModifierFor("nutrition_step", { stage: "mid_cut" });
  assert.ok(chosen, "measurement evidence fills the nutrition-step lever when weight is silent");
  assert.equal(chosen.scale, 0.9);
});
