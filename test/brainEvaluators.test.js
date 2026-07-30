import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAIN_METRIC_KEYS, EXPECTATION_EVALUATORS_BY_METRIC } from "../dist/brain/expectation-contract.js";
import { EVALUATOR_REGISTRY, evaluateMetricObservation } from "../dist/brain/evaluators.js";
import { evaluateMatureExpectations } from "../dist/brainEvaluator.js";
import { recordDecision } from "../dist/domain/brain/decision-service.js";
import { transitionBrainDecision } from "../dist/repo/brain-decisions.js";
import { listBrainEvaluations } from "../dist/repo/brain-evaluations.js";
import { db } from "../dist/db.js";
import { repo } from "./_seed.js";

function decision(overrides = {}) {
  return {
    effective_date: "2026-01-01",
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

function weightExpectation(overrides = {}) {
  return {
    metric_key: "weight_trend_lb_wk",
    subject_key: null,
    direction: "within_band",
    baseline: { value: -1.2 },
    target: { min: -1, max: -0.2 },
    window_start: "2026-01-01",
    window_end: "2026-01-15",
    minimum_data: { weigh_ins: 6, span_days: 10 },
    confounder_policy: "exclude_context_events",
    confidence: "tentative",
    evaluator: "weight_trend",
    evaluator_version: "test-v1",
    ...overrides,
  };
}

function addWeights(rows) {
  const insert = db.prepare(`INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)`);
  for (const [date, weight] of rows) insert.run(date, weight);
}

const CLEAN_WEIGHTS = [
  ["2026-01-01", 200],
  ["2026-01-04", 199.8],
  ["2026-01-07", 199.6],
  ["2026-01-10", 199.4],
  ["2026-01-13", 199.2],
  ["2026-01-15", 199.0],
];

test("the versioned evaluator registry covers every frozen metric key", () => {
  assert.deepEqual(Object.keys(EVALUATOR_REGISTRY).sort(), [...BRAIN_METRIC_KEYS].sort());
  for (const key of BRAIN_METRIC_KEYS) {
    assert.ok(EXPECTATION_EVALUATORS_BY_METRIC[key].includes(EVALUATOR_REGISTRY[key].evaluator));
    assert.match(EVALUATOR_REGISTRY[key].version, /^brain-maturity-v1\//);
  }
});

test("every metric produces aligned, inconclusive, and confounded verdicts through the shared evaluator contract", () => {
  for (const metric_key of BRAIN_METRIC_KEYS) {
    const expectation = {
      id: 1,
      decision_id: 1,
      metric_key,
      subject_key: null,
      direction: "at_least",
      baseline: { value: 0 },
      target: { value: 1 },
      window_start: "2026-01-01",
      window_end: "2026-01-15",
      minimum_data: null,
      confounder_policy: "none",
      confidence: "tentative",
      status: "mature",
      evaluator: EVALUATOR_REGISTRY[metric_key].evaluator,
      evaluator_version: "test-v1",
    };
    const aligned = evaluateMetricObservation(expectation, {
      actual: { value: 1 },
      evidence_keys: [`${metric_key}:fixture`],
      counts: { data_points: 1 },
      issues: [],
    });
    assert.equal(aligned.verdict, "aligned", `${metric_key} aligned fixture`);

    const thin = evaluateMetricObservation(expectation, {
      actual: null,
      evidence_keys: [],
      counts: { data_points: 0 },
      issues: ["No comparable data."],
    });
    assert.equal(thin.verdict, "inconclusive", `${metric_key} thin fixture`);

    const confounded = evaluateMetricObservation(
      expectation,
      { actual: { value: 1 }, evidence_keys: [], counts: { data_points: 1 }, issues: [] },
      ["Material travel overlapped the window."]
    );
    assert.equal(confounded.verdict, "inconclusive", `${metric_key} confounded fixture`);
  }
});

test("a matured weight expectation is evaluated deterministically from bounded evidence", () => {
  const recorded = recordDecision(decision(), [weightExpectation()]);
  addWeights(CLEAN_WEIGHTS);

  const result = evaluateMatureExpectations("2026-01-15");
  assert.equal(result.evaluated, 1);
  assert.equal(result.evaluations[0].verdict, "aligned");
  assert.equal(result.evaluations[0].actual.weigh_ins, 6);
  assert.match(result.evaluations[0].explanation, /observed result/i);
  assert.equal(listBrainEvaluations(recorded.expectations[0].id).length, 1);
});

test("sparse evidence stays inconclusive and an unchanged nightly pass does not append", () => {
  const recorded = recordDecision(decision(), [weightExpectation()]);
  addWeights([
    ["2026-01-01", 200],
    ["2026-01-03", 199.8],
  ]);

  const first = evaluateMatureExpectations("2026-01-15");
  const second = evaluateMatureExpectations("2026-01-15");
  assert.equal(first.evaluations[0].verdict, "inconclusive");
  assert.ok(first.evaluations[0].confounders.some((item) => /required|stable trend/i.test(item)));
  assert.equal(second.evaluated, 0);
  assert.equal(second.skipped_unchanged, 1);
  assert.equal(listBrainEvaluations(recorded.expectations[0].id).length, 1);
});

test("late evidence appends a new authoritative verdict without erasing the first", () => {
  const recorded = recordDecision(decision(), [weightExpectation()]);
  addWeights([
    ["2026-01-01", 200],
    ["2026-01-03", 199.8],
  ]);
  assert.equal(evaluateMatureExpectations("2026-01-15").evaluations[0].verdict, "inconclusive");

  addWeights(CLEAN_WEIGHTS.slice(2));
  const rerun = evaluateMatureExpectations("2026-01-15");
  assert.equal(rerun.evaluations[0].verdict, "aligned");
  const history = listBrainEvaluations(recorded.expectations[0].id);
  assert.equal(history.length, 2);
  assert.deepEqual(new Set(history.map((item) => item.verdict)), new Set(["inconclusive", "aligned"]));
});

test("reverted decisions receive a canceled outcome rather than a causal verdict", () => {
  const recorded = recordDecision(decision(), [weightExpectation()]);
  transitionBrainDecision(recorded.decision.id, "reverted");
  addWeights(CLEAN_WEIGHTS);

  const result = evaluateMatureExpectations("2026-01-15");
  assert.equal(result.evaluations[0].verdict, "canceled");
  assert.match(result.evaluations[0].explanation, /canceled|reversed/i);
  assert.equal(result.evaluations[0].evidence_keys.length, 0);
});

test("material context contaminates an otherwise aligned window", () => {
  // Two applied nutrition targets reaching for the SAME metric over the same span used
  // to leave two live windows, each confounded by the other, and both permanently
  // inconclusive. Supersede-on-write ends that: the second one owns the metric, the
  // first is retired unevaluated, and the survivor is judged on its own evidence.
  // (The confounder rule itself is unchanged and still covered — see
  // "a live overlapping window on another decision still confounds" in
  // brainExpectationSupersede.test.js.)
  recordDecision(decision({ summary: "First bounded target." }), [weightExpectation()]);
  recordDecision(
    decision({
      summary: "Second bounded target.",
      source: "second-test",
      action: { target_kcal: 2400 },
    }),
    [weightExpectation()]
  );
  db.prepare(
    `INSERT INTO context_events (kind, title, start_date, end_date) VALUES ('trip', 'Work travel', '2026-01-05', '2026-01-10')`
  ).run();
  addWeights(CLEAN_WEIGHTS);

  const result = evaluateMatureExpectations("2026-01-15");
  assert.equal(result.evaluated, 1, "only the surviving window is evaluated");
  const [evaluation] = result.evaluations;
  // A trip through the middle of the window still muddies a causal weight question,
  // which is the whole point of `exclude_context_events` — the supersede changed who
  // gets asked, never what counts as contamination.
  assert.equal(evaluation.verdict, "inconclusive");
  assert.ok(evaluation.confounders.some((item) => /Work travel/i.test(item)));
  assert.ok(
    !evaluation.confounders.some((item) => /also targeted/i.test(item)),
    "the retired window is no longer a rival"
  );
});

test("zero exposure yields inconclusive, never a decisive verdict the contract refuses", () => {
  db.prepare(`INSERT INTO exercises (name, muscle_group) VALUES ('Bulgarian Split Squat', 'legs')`).run();
  const recorded = recordDecision(
    decision({ kind: "training_target", domain: "training", summary: "Add split squats twice weekly." }),
    [
      weightExpectation({
        metric_key: "exercise_target_completion",
        subject_key: "Bulgarian Split Squat",
        direction: "complete",
        baseline: null,
        target: { value: 1 },
        minimum_data: null,
        confounder_policy: "none",
        evaluator: EVALUATOR_REGISTRY.exercise_target_completion.evaluator,
      }),
    ]
  );

  const first = evaluateMatureExpectations("2026-01-15");
  assert.equal(first.errors, 0);
  assert.equal(first.evaluated, 1);
  assert.equal(first.evaluations[0].verdict, "inconclusive");
  assert.ok(first.evaluations[0].confounders.some((item) => /not exposed/i.test(item)));

  const second = evaluateMatureExpectations("2026-01-15");
  assert.equal(second.errors, 0);
  assert.equal(second.skipped_unchanged, 1);
  assert.equal(listBrainEvaluations(recorded.expectations[0].id).length, 1);
});

test("plan adherence with an expected count but zero logged sessions stays inconclusive", () => {
  const recorded = recordDecision(
    decision({ kind: "training_target", domain: "training", summary: "Hold three planned sessions." }),
    [
      weightExpectation({
        metric_key: "plan_day_adherence",
        subject_key: null,
        direction: "complete",
        baseline: null,
        target: { planned_sessions: 3 },
        minimum_data: null,
        confounder_policy: "none",
        evaluator: EVALUATOR_REGISTRY.plan_day_adherence.evaluator,
      }),
    ]
  );

  const result = evaluateMatureExpectations("2026-01-15");
  assert.equal(result.errors, 0);
  assert.equal(result.evaluations[0].verdict, "inconclusive");
  assert.ok(result.evaluations[0].confounders.some((item) => /no sessions were logged/i.test(item)));
  assert.equal(listBrainEvaluations(recorded.expectations[0].id).length, 1);
});

test("snack-only partial intake plus a terminal scale shock cannot yield a decisive nutrition outcome", () => {
  const recorded = recordDecision(decision(), [
    weightExpectation({
      metric_key: "intake_to_weight_response",
      baseline: { target_kcal: 2200, predicted_trend_lb_wk: -0.5, recomposition_stage: "mid_cut" },
      minimum_data: { weigh_ins: 6, intake_days: 3 },
      evaluator: "intake_response",
    }),
  ]);
  addWeights([
    ["2026-01-01", 200],
    ["2026-01-03", 199.9],
    ["2026-01-05", 199.8],
    ["2026-01-07", 199.7],
    ["2026-01-09", 199.6],
    ["2026-01-11", 199.5],
    ["2026-01-14", 190],
  ]);
  for (const date of ["2026-01-02", "2026-01-04", "2026-01-06", "2026-01-08"]) {
    db.prepare(
      `INSERT INTO food_notes (date, meal, raw_output, parsed_json) VALUES (?, 'snack', '', ?)`
    ).run(date, JSON.stringify({ kcal: 250 }));
  }

  const result = evaluateMatureExpectations("2026-01-15");
  assert.equal(result.evaluations[0].verdict, "inconclusive");
  assert.equal(result.evaluations[0].actual, null, "no credible completed intake exposure exists");
  assert.ok(result.evaluations[0].confounders.some((item) => /terminal scale change/i.test(item)));
  assert.ok(result.evaluations[0].confounders.some((item) => /credible completed intake/i.test(item)));
  assert.equal(listBrainEvaluations(recorded.expectations[0].id).length, 1);
});

// ── endurance evaluators: run_volume_adherence + vo2max_trend ────────────────

test("the two new endurance metric keys are registered with their own evaluators", () => {
  for (const key of ["run_volume_adherence", "vo2max_trend"]) {
    assert.ok(BRAIN_METRIC_KEYS.includes(key), `${key} is a frozen metric key`);
    assert.equal(EVALUATOR_REGISTRY[key].evaluator, key, `${key} maps to its own evaluator`);
    assert.match(EVALUATOR_REGISTRY[key].version, /^brain-maturity-v1\//);
  }
});

function runVolumeExpectation(overrides = {}) {
  return {
    id: 1,
    decision_id: 1,
    metric_key: "run_volume_adherence",
    subject_key: null,
    direction: "complete",
    baseline: { weekly_prescribed_km: 25 },
    target: { rate: 0.8, expected_km: 100 },
    window_start: "2026-04-01",
    window_end: "2026-04-28",
    minimum_data: { outings: 2 },
    confounder_policy: "exclude_context_events",
    confidence: "tentative",
    status: "mature",
    evaluator: "run_volume_adherence",
    evaluator_version: "run-volume-adherence-v1",
    ...overrides,
  };
}

function observe(metricKey, expectation, asOf = "2026-05-15") {
  return EVALUATOR_REGISTRY[metricKey].observe({ expectation, decision: {}, as_of: asOf });
}

test("run_volume_adherence: running the prescribed km aligns", () => {
  const expectation = runVolumeExpectation();
  for (const [date, km] of [
    ["2026-04-03", 25],
    ["2026-04-10", 25],
    ["2026-04-17", 25],
    ["2026-04-24", 25],
  ]) {
    repo.addActivity({ type: "run", distance_km: km, duration_min: km * 6, date });
  }
  const obs = observe("run_volume_adherence", expectation);
  assert.equal(obs.counts.outings, 4);
  assert.ok(obs.actual.completion_rate >= 0.99, `completion ${obs.actual.completion_rate}`);
  assert.equal(evaluateMetricObservation(expectation, obs).verdict, "aligned");
});

test("run_volume_adherence: materially under-running the prescription is not_aligned", () => {
  const expectation = runVolumeExpectation();
  // ~45 of 100 prescribed km → 0.45 completion, below the 0.8 bar.
  for (const [date, km] of [
    ["2026-04-05", 15],
    ["2026-04-12", 15],
    ["2026-04-19", 15],
  ]) {
    repo.addActivity({ type: "run", distance_km: km, duration_min: km * 6, date });
  }
  const obs = observe("run_volume_adherence", expectation);
  assert.ok(obs.actual.completion_rate < 0.8);
  assert.equal(evaluateMetricObservation(expectation, obs).verdict, "not_aligned");
});

test("run_volume_adherence: zero run outings stays inconclusive (zero-evidence contract), never a miss", () => {
  const expectation = runVolumeExpectation();
  // A ride and a hike in the window can NEVER satisfy a run prescription.
  repo.addActivity({ type: "cycling", distance_km: 40, duration_min: 90, date: "2026-04-08" });
  repo.addActivity({ type: "hike", distance_km: 10, duration_min: 120, date: "2026-04-15" });
  const obs = observe("run_volume_adherence", expectation);
  assert.equal(obs.counts.outings, 0);
  assert.deepEqual(obs.evidence_keys, []);
  const evaluation = evaluateMetricObservation(expectation, obs);
  assert.equal(evaluation.verdict, "inconclusive");
  assert.ok(evaluation.confounders.some((item) => /no running was logged/i.test(item)));
});

// Distance-less-run asymmetry: a MISS can never be declared while an unmeasured run
// exists, but a PASS can (measured km alone clearing the bar is enough).
function seedDistancelessRun(date) {
  db.prepare(`INSERT INTO activities (type, distance_km, duration_min, date) VALUES ('run', NULL, 40, ?)`).run(date);
}

test("run_volume_adherence: all distance-less run outings stay inconclusive, never a false miss", () => {
  const expectation = runVolumeExpectation();
  seedDistancelessRun("2026-04-05");
  seedDistancelessRun("2026-04-12");
  seedDistancelessRun("2026-04-19"); // 3 runs, none carrying a distance
  const obs = observe("run_volume_adherence", expectation);
  assert.equal(obs.counts.outings, 3);
  assert.equal(obs.actual.measured_outings, 0);
  assert.equal(obs.actual.actual_km, 0);
  const evaluation = evaluateMetricObservation(expectation, obs);
  assert.equal(evaluation.verdict, "inconclusive");
  assert.ok(evaluation.confounders.some((item) => /without distance/i.test(item)));
});

test("run_volume_adherence: a measured shortfall WITH a distance-less run present is inconclusive, not a miss", () => {
  const expectation = runVolumeExpectation();
  repo.addActivity({ type: "run", distance_km: 30, duration_min: 180, date: "2026-04-05" });
  repo.addActivity({ type: "run", distance_km: 20, duration_min: 120, date: "2026-04-12" }); // 50 of 100 measured
  seedDistancelessRun("2026-04-19"); // an unmeasured outing makes the shortfall unverifiable
  const obs = observe("run_volume_adherence", expectation);
  assert.ok(obs.actual.completion_rate < 0.8);
  assert.equal(obs.actual.unmeasured_outings, 1);
  assert.equal(evaluateMetricObservation(expectation, obs).verdict, "inconclusive");
});

test("run_volume_adherence: measured km alone clears the bar with an unmeasured run present → aligned", () => {
  const expectation = runVolumeExpectation();
  repo.addActivity({ type: "run", distance_km: 45, duration_min: 270, date: "2026-04-05" });
  repo.addActivity({ type: "run", distance_km: 45, duration_min: 270, date: "2026-04-12" }); // 90 of 100 → clears 0.8
  seedDistancelessRun("2026-04-19"); // unmeasured presence is irrelevant to a PASS
  const obs = observe("run_volume_adherence", expectation);
  assert.ok(obs.actual.completion_rate >= 0.8);
  assert.equal(obs.actual.unmeasured_outings, 1);
  assert.equal(evaluateMetricObservation(expectation, obs).verdict, "aligned");
});

function vo2Expectation(overrides = {}) {
  return {
    id: 1,
    decision_id: 1,
    metric_key: "vo2max_trend",
    subject_key: null,
    direction: "increase",
    baseline: null,
    target: {},
    window_start: "2026-04-01",
    window_end: "2026-05-20",
    minimum_data: null,
    confounder_policy: "exclude_context_events",
    confidence: "tentative",
    status: "mature",
    evaluator: "vo2max_trend",
    evaluator_version: "vo2max-trend-v1",
    ...overrides,
  };
}

function seedVo2(date, value) {
  db.prepare(
    `INSERT INTO daily_metrics (source, date, vo2max, updated_at) VALUES ('apple', ?, ?, datetime('now'))`
  ).run(date, value);
}

test("vo2max_trend: an improving slope over ≥4 readings and ≥3 weeks reads as increasing", () => {
  const expectation = vo2Expectation();
  for (const [date, v] of [
    ["2026-04-02", 48],
    ["2026-04-12", 49],
    ["2026-04-22", 50],
    ["2026-05-02", 51],
    ["2026-05-12", 52],
  ]) {
    seedVo2(date, v);
  }
  const obs = observe("vo2max_trend", expectation);
  assert.equal(obs.counts.readings, 5);
  assert.ok(obs.actual.delta > 0, "vo2max rose across the window");
  assert.equal(evaluateMetricObservation(expectation, obs).verdict, "aligned");
});

test("vo2max_trend: stays inconclusive under the 4-reading gate", () => {
  const expectation = vo2Expectation();
  seedVo2("2026-04-02", 48);
  seedVo2("2026-04-20", 50);
  seedVo2("2026-05-05", 51); // only 3 readings
  const obs = observe("vo2max_trend", expectation);
  assert.equal(obs.actual, null);
  assert.equal(evaluateMetricObservation(expectation, obs).verdict, "inconclusive");
});

test("vo2max_trend: stays inconclusive under the 21-day span gate even with 4 readings", () => {
  const expectation = vo2Expectation();
  for (const [date, v] of [
    ["2026-04-02", 48],
    ["2026-04-05", 49],
    ["2026-04-09", 50],
    ["2026-04-14", 51], // 4 readings but only a 12-day span
  ]) {
    seedVo2(date, v);
  }
  const obs = observe("vo2max_trend", expectation);
  assert.equal(obs.counts.readings, 4);
  assert.equal(obs.actual, null);
  const evaluation = evaluateMetricObservation(expectation, obs);
  assert.equal(evaluation.verdict, "inconclusive");
  assert.ok(evaluation.confounders.some((item) => /at least 4 readings/i.test(item)));
});

test("stored applied nutrition expectations use supported clean counts and mature with credible exposure", () => {
  repo.setProfile({
    age: 40,
    sex: "male",
    height_cm: 180,
    start_weight_lb: 200,
    weight_lb: 190,
    goal_weight_lb: 175,
    goal_date: "2026-06-01",
  });
  repo.setNutritionTarget({ target_kcal: 2200, protein_g: 170, effective_date: "2026-01-01", source: "test" });
  const row = db.prepare(
    `SELECT expectation.* FROM brain_expectations expectation
      JOIN brain_decisions decision ON decision.id = expectation.decision_id
     WHERE decision.kind = 'nutrition_target' ORDER BY expectation.id DESC LIMIT 1`
  ).get();
  assert.equal(row.metric_key, "intake_to_weight_response");
  assert.deepEqual(JSON.parse(row.minimum_data_json), { weigh_ins: 6, intake_days: 10 });
  assert.equal(JSON.parse(row.baseline_json).recomposition_stage, "mid_cut");

  for (let index = 0; index < 10; index++) {
    const date = `2026-01-${String(index + 1).padStart(2, "0")}`;
    for (const [meal, kcal] of [["breakfast", 900], ["dinner", 1300]]) {
      db.prepare(
        `INSERT INTO food_notes (date, meal, raw_output, parsed_json) VALUES (?, ?, '', ?)`
      ).run(date, meal, JSON.stringify({ kcal }));
    }
  }
  addWeights([
    ["2026-01-01", 190],
    ["2026-01-06", 189.8],
    ["2026-01-11", 189.6],
    ["2026-01-16", 189.4],
    ["2026-01-21", 189.2],
    ["2026-01-28", 189.0],
  ]);

  const result = evaluateMatureExpectations("2026-01-29");
  assert.ok(["aligned", "not_aligned"].includes(result.evaluations[0].verdict));
  assert.equal(result.evaluations[0].actual.credible_intake_days, 10);
  assert.equal(result.evaluations[0].actual.weigh_ins, 6);
  assert.equal(result.evaluations[0].confounders.some((item) => /not supported/i.test(item)), false);
});
