// The composition half of a nutrition-target change. The evaluator for
// `body_measurement_direction` has been registered since the ledger shipped and nothing
// ever wrote it, so the reaction model's body-measurement branch — already built to
// stage composition evidence per recomposition phase — could never fire.
//
// The invariant under test is the HONESTY RULE, not the write: a prediction exists only
// where the evidence that could falsify it is already being logged. Tape is rare, so
// most target changes must correctly write nothing, and the tests below spend most of
// their effort on the cases that write NOTHING.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, localDaysAgo } from "./_seed.js";
import { observeExpectation, evaluateMetricObservation, EVALUATOR_REGISTRY } from "../dist/brain/evaluators.js";

beforeEach(() =>
  resetTables(
    "nutrition_targets",
    "profile",
    "body_measurements",
    "bodyweight_log",
    "brain_decisions",
    "brain_expectations",
    "brain_evaluations"
  )
);

// A cutting athlete: computeGoalCheck lands a negative predicted weekly trend, which is
// what makes "the waist should not go up" a claim the change actually makes.
function seedCuttingProfile() {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 200,
    start_weight_lb: 210,
    goal_weight_lb: 180,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "lose",
  });
}

function logWaist(daysAgo, waistIn) {
  db.prepare(`INSERT INTO body_measurements (date, waist_in, source) VALUES (?, ?, 'manual')`).run(
    localDaysAgo(daysAgo),
    waistIn
  );
}

const bodyExpectations = () =>
  db
    .prepare(`SELECT * FROM brain_expectations WHERE metric_key = 'body_measurement_direction' ORDER BY id`)
    .all()
    .map((row) => ({
      ...row,
      baseline: JSON.parse(row.baseline_json || "null"),
      target: JSON.parse(row.target_json || "{}"),
      minimum_data: JSON.parse(row.minimum_data_json || "null"),
    }));

const setCut = () => repo.setNutritionTarget({ target_kcal: 2200, protein_g: 180, source: "checkin" });

// ---------------------------------------------------------------- the honesty rule ---

test("NO tape logged → a cut writes no composition prediction at all", () => {
  seedCuttingProfile();
  setCut();
  assert.equal(bodyExpectations().length, 0, "nothing could falsify it, so nothing is claimed");
});

test("ONE tape reading is not flowing data → still no prediction", () => {
  seedCuttingProfile();
  logWaist(20, 35.0);
  setCut();
  assert.equal(bodyExpectations().length, 0, "a single reading cannot support a follow-up comparison");
});

test("tape that has gone STALE (outside the trailing window) does not count as flowing", () => {
  seedCuttingProfile();
  logWaist(200, 36.0);
  logWaist(180, 35.8);
  setCut();
  assert.equal(bodyExpectations().length, 0, "measurements from six months ago are not a live logging habit");
});

test("TWO readings in the trailing window DO earn the prediction", () => {
  seedCuttingProfile();
  logWaist(40, 35.5);
  logWaist(10, 35.0);
  setCut();
  assert.equal(bodyExpectations().length, 1, "the evidence that could falsify it is already being logged");
});

test("the weight lever is written regardless — the composition half is additive, never a replacement", () => {
  seedCuttingProfile();
  setCut();
  const all = db.prepare(`SELECT metric_key FROM brain_expectations`).all().map((r) => r.metric_key);
  assert.ok(all.includes("intake_to_weight_response"), "the primary nutrition lever is untouched by this change");
});

// -------------------------------------------------------- cut-only, deliberately ---

test("a GAIN phase writes no waist prediction even with tape flowing", () => {
  // Some waist gain is expected in a lean gain and nothing here knows how much, so a
  // ceiling would be an invented number. Silence is the honest answer.
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 170,
    start_weight_lb: 165,
    goal_weight_lb: 185,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "gain",
  });
  logWaist(40, 32.0);
  logWaist(10, 32.2);
  repo.setNutritionTarget({ target_kcal: 3200, protein_g: 190, source: "checkin" });
  assert.equal(bodyExpectations().length, 0);
});

test("a MAINTAIN phase writes no waist prediction either", () => {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 180,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "maintain",
  });
  logWaist(40, 33.0);
  logWaist(10, 33.1);
  repo.setNutritionTarget({ target_kcal: 2600, protein_g: 175, source: "checkin" });
  assert.equal(bodyExpectations().length, 0);
});

// ------------------------------------------------------------- the evaluator shape ---

test("the written expectation matches what the registered evaluator actually computes", () => {
  seedCuttingProfile();
  logWaist(40, 35.5);
  logWaist(10, 35.0);
  setCut();
  const [exp] = bodyExpectations();
  assert.ok(exp, "an expectation was written");

  // The evaluator dispatches on this pair; a mismatch returns a refusal observation.
  assert.equal(exp.evaluator, "body_measurement_direction");
  assert.equal(EVALUATOR_REGISTRY.body_measurement_direction.evaluator, exp.evaluator);
  // bodyMeasurementObservation reads subject_key as a COLUMN NAME off body_measurements.
  assert.equal(exp.subject_key, "waist_in");
  // It reports the latest reading as `actual.value` and counts rows as `measurements`,
  // so the falsifiable claim is an absolute ceiling, and the minimum-data key must be
  // one the evaluator's `counts` actually carries.
  assert.equal(exp.direction, "at_most");
  assert.equal(typeof exp.target.max, "number");
  assert.equal(exp.minimum_data.measurements, 2);
  // reaction-model's outcomeStage reads the phase from BASELINE, not from context.
  assert.ok(exp.baseline.recomposition_stage, "the recomposition phase rides in the baseline");
  assert.equal(exp.baseline.value, 35.0, "the baseline is the latest reading at write time");
  assert.ok(exp.target.max > exp.baseline.value, "the ceiling sits above the baseline by the tape-noise band");
});

test("on mature data the evaluator returns a decisive verdict in both directions", () => {
  seedCuttingProfile();
  logWaist(40, 35.5);
  logWaist(10, 35.0);
  setCut();
  const [row] = bodyExpectations();

  const expectation = {
    id: row.id,
    decision_id: row.decision_id,
    metric_key: row.metric_key,
    subject_key: row.subject_key,
    direction: row.direction,
    baseline: row.baseline,
    target: row.target,
    window_start: row.window_start,
    window_end: row.window_end,
    minimum_data: row.minimum_data,
    confounder_policy: row.confounder_policy,
    confidence: row.confidence,
    evaluator: row.evaluator,
    evaluator_version: row.evaluator_version,
    status: "mature",
  };
  const asOf = row.window_end;
  const context = { expectation, decision: {}, as_of: asOf };

  // A waist that held or came down inside the window → ALIGNED.
  db.prepare(`INSERT INTO body_measurements (date, waist_in, source) VALUES (?, ?, 'manual')`).run(
    row.window_start,
    35.0
  );
  db.prepare(`INSERT INTO body_measurements (date, waist_in, source) VALUES (?, ?, 'manual')`).run(
    row.window_end,
    34.4
  );
  const good = observeExpectation(context);
  assert.ok(good.actual, "the evaluator produced an observation from real rows");
  assert.equal(good.counts.measurements, 2, "the minimum-data key lines up with the evaluator's counts");
  assert.ok(good.evidence_keys.length > 0, "a decisive verdict needs evidence rows and has them");
  assert.equal(evaluateMetricObservation(expectation, good).verdict, "aligned");

  // A waist that ran away past the noise band → NOT_ALIGNED.
  db.prepare(`DELETE FROM body_measurements WHERE date = ?`).run(row.window_end);
  db.prepare(`INSERT INTO body_measurements (date, waist_in, source) VALUES (?, ?, 'manual')`).run(
    row.window_end,
    37.0
  );
  const bad = observeExpectation({ ...context, expectation });
  assert.equal(evaluateMetricObservation(expectation, bad).verdict, "not_aligned");
});

test("a window with only ONE reading stays inconclusive rather than guessing", () => {
  seedCuttingProfile();
  logWaist(40, 35.5);
  logWaist(10, 35.0);
  setCut();
  const [row] = bodyExpectations();
  const expectation = {
    id: row.id,
    decision_id: row.decision_id,
    metric_key: row.metric_key,
    subject_key: row.subject_key,
    direction: row.direction,
    baseline: row.baseline,
    target: row.target,
    window_start: row.window_start,
    window_end: row.window_end,
    minimum_data: row.minimum_data,
    confounder_policy: row.confounder_policy,
    confidence: row.confidence,
    evaluator: row.evaluator,
    evaluator_version: row.evaluator_version,
    status: "mature",
  };
  db.prepare(`INSERT INTO body_measurements (date, waist_in, source) VALUES (?, ?, 'manual')`).run(
    row.window_end,
    34.0
  );
  const observation = observeExpectation({ expectation, decision: {}, as_of: row.window_end });
  const result = evaluateMetricObservation(expectation, observation);
  assert.equal(result.verdict, "inconclusive", "one reading cannot settle a direction");
  assert.ok(result.confounders.length > 0, "and it says why");
});
