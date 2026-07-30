// The run-volume ACCELERATION branch of the personal-response model
// (src/repo/reaction-model.ts). Weekly running mileage is the most cautious lever in
// the system: connective tissue adapts slower than the aerobic engine, so this branch
// is held to a higher bar than the in-session load step (three consecutive aligned
// verdicts instead of two, a 1.05 ceiling instead of 1.1) and every guard in the stack
// has to hold at once.
//
// Each test below removes exactly ONE guard from an otherwise-earning history and
// asserts the acceleration is withheld, so a future refactor cannot quietly drop a
// guard and still pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./_seed.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { whatWorksForYou } from "../dist/repo/reaction-model.js";
import { localDateISO, addDaysISO } from "../dist/repo/shared.js";

const EASE = 0.9;
const ACCELERATED = 1.05;
const DECLARED_BOUNDS = { min: 0.9, max: 1.05 };

function runDecision(key) {
  return {
    effective_date: "2026-01-01",
    kind: "training_target",
    domain: "training",
    summary: `Weekly run prescription ${key}.`,
    rationale: "Check whether the prescribed mileage is actually being absorbed.",
    source: "test",
    source_ref_type: "plan_proposal",
    source_ref_key: key,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: { weekly_km: 30 },
    specialist: null,
    applied_at: "2026-01-01T12:00:00.000Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "run-volume-adherence-v1",
  };
}

function runExpectation() {
  return {
    metric_key: "run_volume_adherence",
    subject_key: null,
    direction: "complete",
    baseline: { weekly_prescribed_km: 30 },
    target: { rate: 0.8, expected_km: 120 },
    window_start: "2026-01-01",
    window_end: "2026-01-29",
    minimum_data: { outings: 2 },
    confounder_policy: "exclude_context_events",
    confidence: "tentative",
    evaluator: "run_volume_adherence",
    evaluator_version: "run-volume-adherence-v1",
  };
}

// One comparable run-volume outcome. All of them share a decision kind, metric,
// subject and direction, so they land in one comparable group.
function runOutcome(key, verdict) {
  const recorded = recordDecision(runDecision(key), [runExpectation()]);
  const evaluation = insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict,
    actual: { value: verdict === "aligned" ? 0.95 : 0.4, completion_rate: verdict === "aligned" ? 0.95 : 0.4 },
    evidence_keys: ["activities:2026-01-01..2026-01-29:n=9"],
    confounders: [],
    explanation:
      verdict === "aligned"
        ? "The prescribed weekly distance was run."
        : "Well under the prescribed weekly distance was run.",
    evaluator_version: "run-volume-adherence-v1",
  });
  return { recorded, evaluation };
}

function alignedRun(n, startAt = 1) {
  for (let i = 0; i < n; i++) runOutcome(String(startAt + i), "aligned");
}

// evaluated_at is a DB default, so a test that needs an outcome to fall OUT of the
// 365-day comparable window has to backdate the stored row directly.
function backdateEvaluation(evaluationId, daysAgo) {
  const when = `${addDaysISO(localDateISO(), -daysAgo)} 12:00:00`;
  db.prepare(`UPDATE brain_evaluations SET evaluated_at = ? WHERE id = ?`).run(when, evaluationId);
}

function runModifier() {
  const learned = whatWorksForYou();
  return learned?.modifiers.find((modifier) => modifier.target === "run_volume_step") ?? null;
}

test("three consecutive clean run-volume outcomes earn the capped acceleration", () => {
  alignedRun(3);
  const modifier = runModifier();
  assert.ok(modifier, "a run_volume_step modifier is emitted");
  assert.equal(modifier.scale, ACCELERATED, "the earned scale is the 1.05 ceiling, not the load step's 1.1");
  assert.match(modifier.rationale, /larger/i, "the rationale says the larger step is the earned default");
});

test("run volume needs one more aligned outcome than the in-session load step does", () => {
  alignedRun(2); // the bar the strength branch clears
  assert.equal(runModifier().scale, 1, "two aligned run weeks hold the standard build");

  runOutcome("3", "aligned");
  assert.equal(runModifier().scale, ACCELERATED, "the third completes the run");
});

test("a missed outcome anywhere in the comparable window withholds the acceleration", () => {
  runOutcome("0", "not_aligned");
  alignedRun(3, 1);
  const modifier = runModifier();
  assert.ok(modifier, "the learning still exists");
  assert.equal(modifier.scale, 1, "a week the athlete could not absorb outranks three they could");
});

test("an ease cannot whiplash straight into an acceleration", () => {
  // The miss is real but old enough to have left the 365-day window, so `missed_n` is
  // clean — the ONLY thing standing between this history and an acceleration is the
  // ease that immediately preceded the current run.
  const missed = runOutcome("0", "not_aligned");
  backdateEvaluation(missed.evaluation.id, 500);
  alignedRun(3, 1);

  const afterThree = runModifier();
  assert.equal(afterThree.scale, 1, "the first clean cycle after an ease only earns the standard build back");

  runOutcome("4", "aligned");
  assert.equal(runModifier().scale, ACCELERATED, "a full clean cycle on top of that finally earns the larger step");
});

test("a live training symptom withholds the acceleration", () => {
  alignedRun(3);
  assert.equal(runModifier().scale, ACCELERATED, "the history alone would earn it");

  db.prepare(
    `INSERT INTO training_symptom_events (source_kind, area_text, status, onset_on, last_reported_on)
     VALUES ('reported', 'left achilles', 'active', ?, ?)`
  ).run(addDaysISO(localDateISO(), -5), addDaysISO(localDateISO(), -2));

  assert.equal(runModifier().scale, 1, "mileage never stacks onto something already sore");
});

test("a hand-written joint-pain note on a recent session withholds the acceleration", () => {
  alignedRun(3);
  assert.equal(runModifier().scale, ACCELERATED);

  db.prepare(`INSERT INTO sessions (date, joint_pain) VALUES (?, ?)`).run(
    addDaysISO(localDateISO(), -3),
    "right knee felt off on the long run"
  );

  assert.equal(runModifier().scale, 1, "the raw session note counts even without a lifecycle row");
});

test("a missed run-volume outcome still eases the weekly build", () => {
  runOutcome("1", "not_aligned");
  runOutcome("2", "not_aligned");
  assert.equal(runModifier().scale, EASE, "the ease keeps its full power — the asymmetry is the point");
});

test("the declared run-volume bounds are exactly the reachable ones", () => {
  alignedRun(3);
  const accelerated = runModifier();
  assert.deepEqual(accelerated.bounds, DECLARED_BOUNDS, "no unreachable ceiling is advertised");
  assert.equal(accelerated.scale, accelerated.bounds.max, "the top of the declared band is actually produced");

  // …and the bottom of the band is the miss scale, so both ends are real values.
  assert.equal(DECLARED_BOUNDS.min, EASE);
});

// The aerobic trend is an OUTCOME, not headroom. A run of aligned vo2max_trend
// verdicts says fitness is holding or climbing; it says nothing about whether there is
// room for a bigger weekly step, and the two must never be confused.
test("aligned aerobic-trend outcomes stay prose and never earn a training modifier", () => {
  for (const key of ["1", "2", "3", "4"]) {
    const recorded = recordDecision(
      { ...runDecision(key), summary: `Long-horizon aerobic read ${key}.` },
      [
        {
          metric_key: "vo2max_trend",
          subject_key: null,
          direction: "at_least",
          baseline: { recent_readings: 5, lookback_days: 28 },
          target: { value: -0.05 },
          window_start: "2026-01-01",
          window_end: "2026-02-26",
          minimum_data: { readings: 4, span_days: 21 },
          confounder_policy: "exclude_context_events",
          confidence: "tentative",
          evaluator: "vo2max_trend",
          evaluator_version: "aerobic-trend-hold-v1",
        },
      ]
    );
    insertBrainEvaluation({
      expectation_id: recorded.expectations[0].id,
      verdict: "aligned",
      actual: { value: 0.1, readings: 5, span_days: 40 },
      evidence_keys: ["garmin_daily_metrics:2026-01-01..2026-02-26:n=5"],
      confounders: [],
      explanation: "Aerobic fitness held across the window.",
      evaluator_version: "aerobic-trend-hold-v1",
    });
  }

  const learned = whatWorksForYou();
  assert.ok(learned, "the aerobic read still becomes a learning");
  assert.ok(
    learned.learnings.some((item) => item.metric_key === "vo2max_trend"),
    "it is surfaced as prose"
  );
  assert.equal(learned.modifiers.length, 0, "and moves no lever at all");
});
