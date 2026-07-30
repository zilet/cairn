// Two halves of "a prediction has to survive, and a miss has to be visible":
//
//   1. Case-conference predictions used to reach the ledger on ONE of three
//      paths. The held path recorded a review row and dropped them; the advisory
//      path passed a literal empty array. Now a landed revision keeps them live,
//      a held one PARKS them (predicting the effect of a change that did not
//      happen would write a verdict about a counterfactual), and advice keeps
//      them as observational predictions.
//   2. A change that missed its prediction used to stay applied forever with
//      nobody told. It now files exactly one calm in-app note, once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { runCaseConference } from "../dist/domain/brain/case-conference.js";
import { getBrainDecision, listBrainExpectations, transitionBrainDecision } from "../dist/repo/brain-decisions.js";
import { recordDecision } from "../dist/domain/brain/decision-service.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { getAttentionSchedule, listAttentionBySource } from "../dist/repo/attention.js";
import {
  releaseStaleExpectationFollowups,
  surfaceExpectationMisses,
} from "../dist/brainEvaluator.js";

const opinion = (domain, overrides = {}) => ({
  domain,
  recommendation: "Keep the change bounded.",
  rationale: "The shared snapshot supports a cautious next step.",
  evidence_keys: [`${domain}:evidence`],
  risks: [],
  contraindications: [],
  uncertainties: [],
  expected_outcomes: [],
  autonomy_ceiling: "quiet_apply",
  ...overrides,
});

const conferenceExpectation = {
  metric_key: "plan_day_adherence",
  subject_key: null,
  direction: "complete",
  baseline: null,
  target: { rate: 0.75 },
  window_start: "2026-01-01",
  window_end: "2026-01-15",
  minimum_data: { sessions: 2 },
  confounder_policy: "exclude_context_events",
  confidence: "tentative",
  evaluator: "plan_adherence",
  evaluator_version: "case-conference-v1",
};

function conductorDecision(overrides = {}) {
  return {
    kind: "case_conference",
    domain: "training",
    summary: "Keep the next change bounded.",
    rationale: "The shared snapshot supports one reversible step.",
    risk_class: "low",
    reversible: true,
    autonomy_tier: "quiet_apply",
    parallel_actions: [],
    resolved_conflicts: [],
    deferred: [],
    expectations: [conferenceExpectation],
    review_window: "Review in two weeks.",
    user_explanation: "I made one bounded change and will review the response.",
    revision: null,
    ...overrides,
  };
}

function seedPlan() {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
  ]);
}

const benchStep = {
  type: "plan_update",
  summary: "Small bench step",
  changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
};

async function conference(question, overrides, extraInput = {}) {
  return runCaseConference(
    "stub",
    { question, domains: ["training", "recovery"], ...extraInput },
    {
      context: () => ({ training: "progress load", ...(extraInput.context ?? {}) }),
      specialistRun: async (_agent, _prompt, domain) => opinion(domain),
      conductorRun: async () => conductorDecision(overrides),
    }
  );
}

// ---- conference predictions on all three paths ------------------------------

test("a conference revision that LANDS keeps its predictions live", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const result = await conference("Make the next bounded adjustment.", {
    resolved_conflicts: [{ key: "injury_load", resolution: "Use only the already-cleared small load step." }],
    revision: benchStep,
  });
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.equal(recorded.status, "applied");
  const metrics = listBrainExpectations({ decisionId: recorded.id }).map((e) => e.metric_key);
  assert.ok(metrics.includes("plan_day_adherence"), "an applied revision asserts its predictions");
  assert.equal(recorded.action.deferred_expectations, undefined, "nothing to park when the change happened");
});

test("a conference revision HELD for review parks its predictions instead of asserting them", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  // An unresolved injury/load conflict clamps the tier, so the proposal is held.
  const result = await conference(
    "Should bench load move despite shoulder pain?",
    { revision: benchStep },
    { context: { injury: "shoulder pain" } }
  );
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.equal(recorded.status, "review");
  assert.equal(repo.getProposal(result.proposal_id).status, "draft", "nothing was applied");
  assert.equal(
    listBrainExpectations({ decisionId: recorded.id }).length,
    0,
    "an unapplied change must not be judged on schedule"
  );
  const parked = recorded.action.deferred_expectations;
  assert.ok(Array.isArray(parked) && parked.length === 1, "the predictions survive the hold");
  assert.equal(parked[0].metric_key, "plan_day_adherence");
});

test("a parked prediction thaws onto the decision that finally applies the proposal", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const result = await conference(
    "Should bench load move despite shoulder pain?",
    { revision: benchStep },
    { context: { injury: "shoulder pain" } }
  );
  assert.equal(repo.getProposal(result.proposal_id).status, "draft");

  const applied = repo.applyProposal(result.proposal_id);
  assert.equal(applied.ok, true);
  const appliedDecision = db
    .prepare(
      `SELECT id FROM brain_decisions
       WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ? AND status = 'applied'
       ORDER BY id DESC LIMIT 1`
    )
    .get(String(result.proposal_id));
  assert.ok(appliedDecision, "the apply recorded its own decision");
  const thawed = listBrainExpectations({ decisionId: appliedDecision.id }).find(
    (e) => e.metric_key === "plan_day_adherence" && e.evaluator_version === "case-conference-v1"
  );
  assert.ok(thawed, "the conference prediction reached the change that actually happened");
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(thawed.window_start, today, "the window starts the day the change landed");
  assert.notEqual(thawed.window_start, "2026-01-01");
});

test("an advisory conference keeps its predictions as observational ones", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const result = await conference("What should I be watching?", { revision: null });
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.equal(recorded.context.advisory_only, true);
  assert.equal(recorded.context.observational_expectations, true);
  const metrics = listBrainExpectations({ decisionId: recorded.id }).map((e) => e.metric_key);
  assert.deepEqual(metrics, ["plan_day_adherence"], "advice-only output stays checkable");
});

// ---- the miss becomes visible ------------------------------------------------

function appliedTrainingExpectation(overrides = {}) {
  return recordDecision(
    {
      effective_date: "2026-01-01",
      kind: "training_target",
      domain: "training",
      summary: "Bench moves up one small step.",
      rationale: "The last exposure cleared the top of the range.",
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
    },
    [
      {
        ...conferenceExpectation,
        metric_key: "session_performance_feedback",
        direction: "at_least",
        target: { value: 3.5 },
        evaluator: "session_feedback",
        evaluator_version: "session-feedback-guard-v1",
      },
    ]
  );
}

function missVerdict(expectationId) {
  return insertBrainEvaluation({
    expectation_id: expectationId,
    verdict: "not_aligned",
    actual: { value: 2.5, average_rating: 2.5, exposures: 4 },
    evidence_keys: ["sessions:2026-01-01..2026-01-15:n=4:ids=1-4"],
    confounders: [],
    explanation: "The observed result did not land within the expectation.",
    evaluator_version: "brain-maturity-v1/session_feedback",
  });
}

test("a missed prediction files exactly one calm note, and re-running files none", () => {
  const recorded = appliedTrainingExpectation();
  const evaluation = missVerdict(recorded.expectations[0].id);

  const first = surfaceExpectationMisses([evaluation], "2026-01-16");
  assert.equal(first.length, 1);
  const entry = first[0];
  assert.equal(entry.signal_key, `training:change-check:d${recorded.decision.id}`);
  assert.equal(entry.domain, "training");
  assert.equal(entry.tier, "active");
  assert.equal(entry.next_due, "2026-01-16", "it is visible the day it is written, not a quarter later");
  assert.match(entry.reason, /Bench moves up one small step/);
  assert.match(entry.reason, /hasn't|expected/i);
  // Calm register: a suggestion to look, never a gate, a grade, or a command.
  assert.doesNotMatch(entry.reason, /you must|failed|score|not_aligned|expectation/i);

  const again = surfaceExpectationMisses([evaluation], "2026-01-17");
  assert.equal(again.length, 0, "one failed prediction nags exactly once");
  assert.equal(listAttentionBySource("expectation-followup").length, 1);
});

test("several missed predictions on one change are still one note", () => {
  const recorded = appliedTrainingExpectation();
  const evaluation = missVerdict(recorded.expectations[0].id);
  const written = surfaceExpectationMisses([evaluation, evaluation], "2026-01-16");
  assert.equal(written.length, 1, "the athlete hears about the change, not about each metric");
});

test("an aligned verdict, and a change that never landed, say nothing", () => {
  const recorded = appliedTrainingExpectation();
  const aligned = insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict: "aligned",
    actual: { value: 4 },
    evidence_keys: ["sessions:2026-01-01..2026-01-15:n=4:ids=1-4"],
    confounders: [],
    explanation: "The observed result landed within the expectation.",
    evaluator_version: "brain-maturity-v1/session_feedback",
  });
  assert.equal(surfaceExpectationMisses([aligned], "2026-01-16").length, 0);

  // A distinct action, or the ledger's fingerprint dedupe would hand back the
  // decision above instead of recording a second one.
  const held = appliedTrainingExpectation({
    status: "review",
    summary: "A change that is still waiting on you.",
    action: { plan_proposal_id: 999 },
  });
  const missedButUnapplied = missVerdict(held.expectations[0].id);
  assert.equal(
    surfaceExpectationMisses([missedButUnapplied], "2026-01-16").length,
    0,
    "only a change that actually landed can have missed"
  );
});

test("a standing note goes quiet on its own, and the moment its change is undone", () => {
  const recorded = appliedTrainingExpectation();
  surfaceExpectationMisses([missVerdict(recorded.expectations[0].id)], "2026-01-16");
  const signalKey = `training:change-check:d${recorded.decision.id}`;

  assert.equal(releaseStaleExpectationFollowups("2026-01-20"), 0, "a fresh note has not had its say yet");
  assert.equal(getAttentionSchedule(signalKey).tier, "active");

  transitionBrainDecision(recorded.decision.id, "reverted");
  assert.equal(releaseStaleExpectationFollowups("2026-01-20"), 1, "the change is gone, so the note is moot");
  const released = getAttentionSchedule(signalKey);
  assert.equal(released.tier, "released");
  assert.equal(released.next_due, null);
  assert.equal(listAttentionBySource("expectation-followup").length, 0, "released rows leave every read surface");

  // The released row is still the dedupe record, so the same change never speaks twice.
  assert.equal(surfaceExpectationMisses([missVerdict(recorded.expectations[0].id)], "2026-02-01").length, 0);
});

test("a note that nobody acted on goes quiet after its standing window", () => {
  const recorded = appliedTrainingExpectation();
  surfaceExpectationMisses([missVerdict(recorded.expectations[0].id)], "2026-01-16");
  assert.equal(releaseStaleExpectationFollowups("2026-02-01"), 0, "still inside its standing window");
  assert.equal(releaseStaleExpectationFollowups("2026-02-10"), 1);
  assert.equal(getAttentionSchedule(`training:change-check:d${recorded.decision.id}`).tier, "released");
});
