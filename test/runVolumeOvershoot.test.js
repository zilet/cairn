// Running MORE than was prescribed, made visible and made useful.
//
// Two halves of one signal:
//   • the evaluator reports the completion rate UNCAPPED. A 9.1 km run against a
//     4.9 km prescription reads 1.86, not 1 and not the 0.8 bar. Clamped, an
//     athlete who cleared the week by 80% would be indistinguishable from one who
//     landed exactly on it, and the clearest evidence that the prescription sat
//     under their capacity would never reach the learning model at all.
//   • the learning model reads it. Run-volume acceleration normally waits for three
//     consecutive aligned windows; two windows cleared by a clear margin now earn it.
//     Only that wait shortens — the ceiling, the missed-window guard, the symptom
//     guard and the eased-into penalty are all untouched.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { EVALUATOR_REGISTRY } from "../dist/brain/evaluators.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { personalResponseModifierFor } from "../dist/repo/reaction-model.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const WINDOW_START = "2026-06-01";
const WINDOW_END = "2026-06-29";

beforeEach(() => {
  resetTables(
    "activities",
    "sessions",
    "training_symptom_events",
    "brain_evaluations",
    "brain_expectations",
    "brain_decisions"
  );
});

// ── the evaluator ────────────────────────────────────────────────────────────

function observeRunVolume(expectedKm) {
  return EVALUATOR_REGISTRY.run_volume_adherence.observe({
    expectation: {
      metric_key: "run_volume_adherence",
      subject_key: null,
      direction: "complete",
      baseline: null,
      target: { rate: 0.8, expected_km: expectedKm },
      window_start: WINDOW_START,
      window_end: WINDOW_END,
    },
    today: WINDOW_END,
  });
}

test("a week run well past what was prescribed reports the overshoot, not a clipped 1", () => {
  // The athlete's real shape: a 4.9 km long run prescribed, a comfortable 9.1 km run.
  repo.addActivity({ type: "run", duration_min: 55, distance_km: 9.1, date: "2026-06-10" });
  const observation = observeRunVolume(4.9);
  assert.equal(observation.actual.completion_rate, 1.86, "9.1 against 4.9 reads 1.86");
  assert.equal(observation.actual.value, 1.86, "and the compared value is the same number");
  assert.equal(observation.actual.actual_km, 9.1);
  assert.equal(observation.actual.expected_km, 4.9);
});

test("a shortfall still reads as a shortfall, and the bar itself is unchanged", () => {
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: "2026-06-10" });
  const observation = observeRunVolume(20);
  assert.equal(observation.actual.completion_rate, 0.25);
  assert.equal(observation.issues.length, 0, "a measured shortfall is verifiable, so nothing is flagged unreadable");
});

// ── the learning model ───────────────────────────────────────────────────────

// One applied run-plan decision with an evaluated run_volume_adherence window.
function seedRunWindow({ slot, rate, daysAgo, verdict = "aligned" }) {
  const recorded = recordDecision(
    {
      effective_date: "2026-01-01",
      kind: "training_target",
      domain: "training",
      summary: `Weekly run volume window ${slot}.`,
      rationale: "A bounded weekly step, measured before the default moves again.",
      source: "test",
      source_ref_type: null,
      source_ref_key: null,
      status: "applied",
      autonomy_tier: "quiet_apply",
      risk_class: "low",
      reversible: true,
      input_fingerprint: null,
      context: {},
      action: { slot: `run-volume-${slot}` },
      specialist: null,
      applied_at: "2026-01-01T12:00:00.000Z",
      reverted_at: null,
      superseded_by: null,
      evaluator_version: "overshoot-test-v1",
    },
    [
      {
        metric_key: "run_volume_adherence",
        subject_key: null,
        direction: "complete",
        baseline: { weekly_prescribed_km: 30 },
        target: { rate: 0.8, expected_km: 120 },
        window_start: WINDOW_START,
        window_end: WINDOW_END,
        minimum_data: null,
        confounder_policy: "standard",
        confidence: "tentative",
        evaluator: "run_volume_adherence",
        evaluator_version: "overshoot-test-v1",
      },
    ]
  );
  const evaluation = insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict,
    actual: { value: rate, completion_rate: rate, actual_km: Math.round(120 * rate), expected_km: 120, outings: 10 },
    evidence_keys: [`activities:${WINDOW_START}..${WINDOW_END}:n=10:${slot}`],
    confounders: [],
    explanation: "The window was evaluated against the prescribed distance.",
    evaluator_version: "overshoot-test-v1",
  });
  db.prepare(`UPDATE brain_evaluations SET evaluated_at = ? WHERE id = ?`).run(
    `${addDaysISO(localDateISO(), -daysAgo)} 12:00:00`,
    evaluation.id
  );
}

test("two windows cleared by a clear margin earn the acceleration that normally waits for three", () => {
  seedRunWindow({ slot: "a", rate: 1.3, daysAgo: 20 });
  seedRunWindow({ slot: "b", rate: 1.22, daysAgo: 5 });
  const modifier = personalResponseModifierFor("run_volume_step");
  assert.ok(modifier, "a run-volume default is learned");
  assert.equal(modifier.scale, 1.05, "and it is the declared ceiling, not the standard hold");
  assert.deepEqual(modifier.bounds, { min: 0.9, max: 1.05 }, "the band itself is unchanged");
});

test("two windows that merely MET the prescription still wait for the third", () => {
  seedRunWindow({ slot: "a", rate: 0.98, daysAgo: 20 });
  seedRunWindow({ slot: "b", rate: 1.02, daysAgo: 5 });
  const modifier = personalResponseModifierFor("run_volume_step");
  assert.ok(modifier);
  assert.equal(modifier.scale, 1, "meeting the prescription holds the standard build");
});

test("three merely-met windows earn it the slow way, exactly as before", () => {
  seedRunWindow({ slot: "a", rate: 0.98, daysAgo: 30 });
  seedRunWindow({ slot: "b", rate: 1.01, daysAgo: 20 });
  seedRunWindow({ slot: "c", rate: 0.99, daysAgo: 5 });
  assert.equal(personalResponseModifierFor("run_volume_step").scale, 1.05);
});

test("an overshoot streak still cannot outrun a miss, or a symptom on record", () => {
  seedRunWindow({ slot: "miss", rate: 0.4, daysAgo: 40, verdict: "not_aligned" });
  seedRunWindow({ slot: "a", rate: 1.3, daysAgo: 20 });
  seedRunWindow({ slot: "b", rate: 1.25, daysAgo: 5 });
  assert.equal(
    personalResponseModifierFor("run_volume_step").scale,
    1,
    "a miss anywhere in the comparable window, and the eased-into wait, both still stand"
  );
});

test("a live training symptom withholds the shortened wait too", () => {
  seedRunWindow({ slot: "a", rate: 1.3, daysAgo: 20 });
  seedRunWindow({ slot: "b", rate: 1.25, daysAgo: 5 });
  db.prepare(
    `INSERT INTO training_symptom_events (source_kind, area_text, status, scope, onset_on, last_reported_on)
     VALUES ('session', 'left knee', 'active', 'area', ?, ?)`
  ).run(localDateISO(), localDateISO());
  assert.equal(
    personalResponseModifierFor("run_volume_step").scale,
    1,
    "mileage never stacks onto something already sore, however well the weeks went"
  );
});
