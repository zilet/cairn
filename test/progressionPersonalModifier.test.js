// How the progression ladder finds the load step this athlete has EARNED for a lift.
//
// trainingModifierFor used to resolve through `response.learnings` — the athlete-facing
// PROSE list, capped at the four most recent for calm — and then look up a modifier by
// that learning's key. Two things went wrong, both of them silently:
//
//   • a modifier safely present in `modifiers` became unreachable the moment its own
//     sentence fell off the four-item cap. The model had learned the lift's response,
//     stored it, and the ladder read nothing;
//   • the whole-athlete fallback took the first NULL-SUBJECT learning of ANY metric.
//     Nutrition learnings are null-subject and are usually the freshest thing in the
//     ledger, so a weight-trend sentence claimed the "global" slot, its key matched no
//     training modifier, and a live training default was shadowed by a food reading.
//
// It now resolves against `modifiers` — the map the model builds FOR consumers — with
// this lift's own reading preferred over a whole-athlete one, and another lift's
// reading never borrowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./_seed.js";
import { trainingModifierFor } from "../dist/repo/progression.js";
import { whatWorksForYou } from "../dist/repo/reaction-model.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const insertDecision = db.prepare(
  `INSERT INTO brain_decisions
     (created_at, effective_date, kind, domain, summary, rationale, source, status, autonomy_tier,
      risk_class, reversible, context_json, action_json, evaluator_version)
   VALUES (?, ?, ?, ?, ?, 'A bounded change, measured before the default moves again.',
           'test', 'applied', 'quiet_apply', 'low', 1, '{}', '{}', 'modifier-test-v1')`
);
const insertExpectation = db.prepare(
  `INSERT INTO brain_expectations
     (decision_id, metric_key, subject_key, direction, baseline_json, target_json, window_start,
      window_end, minimum_data_json, confounder_policy, confidence, evaluator, evaluator_version)
   VALUES (?, ?, ?, ?, ?, ?, '2026-01-01', '2026-01-29', NULL, 'standard', 'tentative',
           'modifier-test', 'modifier-test-v1')`
);
const insertEvaluation = db.prepare(
  `INSERT INTO brain_evaluations
     (expectation_id, evaluated_at, verdict, actual_json, evidence_json, confounders_json,
      explanation, evaluator_version)
   VALUES (?, ?, ?, ?, '[]', '[]', 'The observed result is on the record either way.',
           'modifier-test-v1')`
);

function stampDaysAgo(daysAgo) {
  return `${addDaysISO(localDateISO(), -daysAgo)} 12:00:00`;
}

// Two comparable outcomes judged the same way — the minimum that earns a learning.
function seedGroup({
  metricKey,
  subjectKey = null,
  kind = "training_target",
  domain = "training",
  verdict = "aligned",
  baseline = null,
  target = { exposures: 2 },
  actual = { value: 1, completion_rate: 1, exposures: 4 },
  daysAgo,
}) {
  for (let i = 0; i < 2; i++) {
    const stamp = stampDaysAgo(daysAgo + (1 - i));
    const decision = insertDecision.run(stamp, "2026-01-01", kind, domain, `${metricKey} ${subjectKey ?? "all"} ${i}.`);
    const expectation = insertExpectation.run(
      decision.lastInsertRowid,
      metricKey,
      subjectKey,
      "complete",
      baseline == null ? null : JSON.stringify(baseline),
      JSON.stringify(target)
    );
    insertEvaluation.run(expectation.lastInsertRowid, stamp, verdict, JSON.stringify(actual));
  }
}

// The four levers other than training, so the prose cap can be filled with learnings
// that are NOT the one under test.
function seedFourNonTrainingLearnings(startingDaysAgo) {
  seedGroup({
    metricKey: "weight_trend_lb_wk",
    kind: "nutrition_target",
    domain: "nutrition",
    baseline: { value: -1.2, recomposition_stage: "mid_cut" },
    target: { min: -1, max: -0.2 },
    actual: { value: -0.5, weigh_ins: 8 },
    daysAgo: startingDaysAgo,
  });
  seedGroup({
    metricKey: "run_volume_adherence",
    baseline: { weekly_prescribed_km: 30 },
    target: { rate: 0.8, expected_km: 120 },
    actual: { value: 0.95, completion_rate: 0.95, outings: 9 },
    daysAgo: startingDaysAgo + 3,
  });
  seedGroup({
    metricKey: "recovery_hrv_delta",
    kind: "recovery_adjustment",
    domain: "recovery",
    baseline: { hrv_avg_ms: 60, nights: 10 },
    target: { value: -6 },
    actual: { value: -1, nights: 10 },
    daysAgo: startingDaysAgo + 6,
  });
  seedGroup({
    metricKey: "plan_day_adherence",
    kind: "training_structure",
    target: { rate: 0.75, planned_sessions: 16 },
    actual: { value: 0.9, completion_rate: 0.9, sessions: 12 },
    daysAgo: startingDaysAgo + 9,
  });
}

test("a training modifier is reachable even when its sentence fell off the prose cap", () => {
  // The lift's learning is the OLDEST of five, so the four-item prose list has no room
  // for it — which is exactly the case the old lookup could not answer.
  seedGroup({ metricKey: "exercise_target_completion", subjectKey: "Back Squat", daysAgo: 40 });
  seedFourNonTrainingLearnings(4);

  const learned = whatWorksForYou();
  assert.ok(learned);
  const prose = learned.learnings.filter((item) => item.metric_key !== "day_read_adherence");
  assert.equal(prose.length, 4, "the athlete-facing list is still capped at four");
  assert.ok(!prose.some((item) => item.subject_key === "Back Squat"), "and the squat's sentence is the one it dropped");

  const modifier = trainingModifierFor("Back Squat", learned);
  assert.ok(modifier, "the ladder still reads the step the model learned for this lift");
  assert.equal(modifier.target, "training_progression_step");
  assert.equal(modifier.subject_key, "Back Squat");
});

test("this lift's own reading beats the whole-athlete one, and is never lent to another lift", () => {
  // A whole-athlete reading (session feedback carries no subject and genuinely speaks
  // for every lift) that says EASE, and a squat-specific one that earned a bigger step.
  // Both older than the four other levers, so neither has a sentence in the prose list —
  // the busy-ledger shape, where the old lookup could resolve neither.
  seedGroup({ metricKey: "exercise_target_completion", subjectKey: "Back Squat", daysAgo: 30 });
  seedGroup({ metricKey: "session_performance_feedback", verdict: "not_aligned", daysAgo: 20 });
  seedFourNonTrainingLearnings(2);

  const learned = whatWorksForYou();
  const squat = trainingModifierFor("Back Squat", learned);
  assert.ok(squat);
  assert.equal(squat.subject_key, "Back Squat", "the squat gets its own earned response");
  assert.ok(squat.scale > 1);

  const press = trainingModifierFor("Overhead Press", learned);
  assert.ok(press, "a lift with no reading of its own still gets the whole-athlete default");
  assert.equal(press.subject_key, null, "…and never borrows the squat's");
  assert.ok(press.scale < 1, "which here is the conservative one session feedback earned");
});

test("lookup is insensitive to how the athlete happened to capitalize the lift", () => {
  seedGroup({ metricKey: "exercise_target_completion", subjectKey: "Back Squat", daysAgo: 4 });

  const learned = whatWorksForYou();
  assert.equal(trainingModifierFor("  back squat ", learned)?.subject_key, "Back Squat");
});

test("a fresh nutrition learning no longer shadows a live training default", () => {
  // The whole-athlete training reading, and then a NEWER nutrition one. Nutrition
  // learnings are null-subject too, so under the old prose-first resolution the weight
  // trend claimed the global slot and the training default went unread.
  seedGroup({ metricKey: "session_performance_feedback", verdict: "not_aligned", daysAgo: 20 });
  seedGroup({
    metricKey: "weight_trend_lb_wk",
    kind: "nutrition_target",
    domain: "nutrition",
    baseline: { value: -1.2, recomposition_stage: "mid_cut" },
    target: { min: -1, max: -0.2 },
    actual: { value: -0.5, weigh_ins: 8 },
    daysAgo: 2,
  });

  const learned = whatWorksForYou();
  assert.equal(
    learned.learnings.filter((item) => item.metric_key !== "day_read_adherence")[0].metric_key,
    "weight_trend_lb_wk",
    "the nutrition learning is the freshest thing on the list, as the bug required"
  );

  const modifier = trainingModifierFor("Overhead Press", learned);
  assert.ok(modifier, "the training default is still there to be read");
  assert.equal(modifier.target, "training_progression_step");
  assert.equal(modifier.subject_key, null);
});
