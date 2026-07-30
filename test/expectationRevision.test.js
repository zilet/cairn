// The capstone of the accountability loop: a change that demonstrably FAILED its
// own prediction no longer merely gets a note — it queues a real step-back through
// the same propose -> apply machinery every other change uses.
//
// What these pin, in order: the reconstruction is field-scoped from the change's
// own before-snapshot; policy (not this code) picks the tier; the miss classes that
// are the ATHLETE's behaviour queue nothing; and every refusal to act is recorded
// where a human can read it rather than guessed around.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import {
  getBrainDecision,
  insertBrainExpectation,
  listBrainDecisions,
  patchBrainDecision,
} from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { applyProposalWithAutonomy } from "../dist/domain/brain/autonomy-service.js";
import { queueExpectationRevisions } from "../dist/brainEvaluator.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";

const ASOF = "2026-01-16";

function targetOf(dayNumber, exercise) {
  const day = repo.getPlan().find((entry) => Number(entry.day_number) === dayNumber);
  const item = (day?.items ?? []).find((entry) => String(entry.exercise).toLowerCase() === exercise.toLowerCase());
  return item ?? null;
}

// Land a real bounded target change the way the app lands one: a draft proposal
// through applyProposalWithAutonomy under lead mode. That is what writes BOTH the
// applied decision and the three-way before-snapshot the step-back reads.
function landBenchStep(changes = [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }]) {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
    { exercise: "Cable Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 90 },
  ]);
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("coach", "bench moves up one small step", "", {
    summary: "Bench moves up one small step.",
    changes,
  });
  const applied = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "quiet_apply" });
  assert.equal(applied.ok, true, "the fixture change must actually land");
  assert.equal(applied.tier, "quiet_apply");
  const decision = applied.decision;
  assert.ok(decision?.id, "the landed change recorded its decision");
  // The real thing is weeks old by the time its expectation matures. Backdating
  // matters: a same-week change would spend the training surprise budget and the
  // step-back would (correctly) be held for review instead of landing.
  db.prepare(`UPDATE brain_decisions SET created_at = '2026-01-01T12:00:00.000Z' WHERE id = ?`).run(decision.id);
  return getBrainDecision(decision.id);
}

function attachMiss(decisionId, overrides = {}) {
  const expectation = insertBrainExpectation(decisionId, {
    metric_key: "session_performance_feedback",
    subject_key: null,
    direction: "at_least",
    baseline: null,
    target: { value: 3.5 },
    window_start: "2026-01-01",
    window_end: "2026-01-15",
    minimum_data: { exposures: 2 },
    confounder_policy: "require_exposure",
    confidence: "tentative",
    evaluator: "session_feedback",
    evaluator_version: "session-feedback-guard-v1",
    ...overrides,
  });
  return insertBrainEvaluation({
    expectation_id: expectation.id,
    verdict: "not_aligned",
    actual: { value: 2.4, average_rating: 2.4, exposures: 4 },
    evidence_keys: ["sessions:2026-01-01..2026-01-15:n=4"],
    confounders: [],
    explanation: "The observed result did not land within the expectation.",
    evaluator_version: "brain-maturity-v1/session_feedback",
  });
}

function stepBackDecision() {
  return listBrainDecisions({ limit: 100 }).find((entry) => entry.context?.revision_step_back === true) ?? null;
}

// ---- the loop actually closes ------------------------------------------------

test("a failed change-effect prediction queues ONE draft step-back that restores the prior target", () => {
  const decision = landBenchStep();
  assert.equal(targetOf(1, "Barbell Bench Press").target_weight, 120, "the fixture change is in force");

  const outcomes = queueExpectationRevisions([attachMiss(decision.id)], ASOF);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "queued");
  assert.equal(outcomes[0].decision_id, decision.id);

  // The point of the whole track: the prescription is actually back where it was.
  assert.equal(targetOf(1, "Barbell Bench Press").target_weight, 115, "one step back, from the change's own snapshot");
  // …and ONLY the target the change moved. An untouched lift is never rewritten.
  assert.equal(targetOf(1, "Cable Row").target_weight, 90);

  const proposal = repo.getProposal(outcomes[0].proposal_id);
  assert.equal(proposal.agent, "revision-step-back");
  assert.deepEqual(
    proposal.parsed.changes.map((change) => [change.day_number, change.exercise, change.target_weight]),
    [[1, "Barbell Bench Press", 115]],
    "exactly the affected target, at exactly its prior value"
  );
  // The machine rationale names the failed prediction precisely…
  assert.match(proposal.parsed.rationale, /session_performance_feedback/);
  assert.match(proposal.parsed.rationale, new RegExp(`#${decision.id}`));
  // …and the athlete-facing summary never does. No score, no gate, no internals.
  assert.match(proposal.parsed.summary, /Barbell Bench Press/);
  assert.doesNotMatch(proposal.parsed.summary, /_|you must|score|expectation|not_aligned|policy|baseline/i);
});

test("the step back is governed by decideAutonomyTier, not by being a step back", () => {
  const decision = landBenchStep();
  const outcomes = queueExpectationRevisions([attachMiss(decision.id)], ASOF);

  // A bounded, reversible target restore under lead mode is exactly the class that
  // may land quietly at a natural boundary — reached through policy, not a bypass.
  assert.equal(outcomes[0].tier, "quiet_apply");
  const revision = stepBackDecision();
  assert.ok(revision, "the step back recorded its own decision");
  assert.equal(revision.kind, "training_target");
  assert.equal(revision.domain, "training");
  assert.equal(revision.autonomy_tier, "quiet_apply");
  assert.equal(revision.status, "applied");
  // Provenance chains both ways, so Undo and the trail can walk between them.
  assert.equal(revision.context.revises_decision_id, decision.id);
  assert.equal(getBrainDecision(decision.id).context.revision.decision_id, revision.id);
  assert.equal(getBrainDecision(decision.id).context.revision.status, "queued");
});

test("review posture holds the step back instead of landing it — no special standing", () => {
  const decision = landBenchStep();
  repo.setSettings({ lead_mode: "review_everything" });

  const outcomes = queueExpectationRevisions([attachMiss(decision.id)], ASOF);
  assert.equal(outcomes[0].status, "queued");
  assert.equal(outcomes[0].tier, "ask", "the athlete's posture governs a step back like anything else");
  assert.equal(targetOf(1, "Barbell Bench Press").target_weight, 120, "nothing was applied behind the review gate");
  assert.equal(repo.getProposal(outcomes[0].proposal_id).status, "draft", "it waits as a draft");
});

// ---- restraint ---------------------------------------------------------------

test("one revision per failed change, ever — re-evaluation queues nothing", () => {
  const decision = landBenchStep();
  const first = queueExpectationRevisions([attachMiss(decision.id)], ASOF);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, "queued");

  // A second matured miss on the same change, the next night.
  const again = queueExpectationRevisions([attachMiss(decision.id)], "2026-01-17");
  assert.equal(again.length, 0, "the change is stepped back once, not once per prediction");
  assert.equal(
    listBrainDecisions({ limit: 100 }).filter((entry) => entry.context?.revision_step_back === true).length,
    1
  );
});

test("several failed predictions on one change are still one step back", () => {
  const decision = landBenchStep();
  const outcomes = queueExpectationRevisions([attachMiss(decision.id), attachMiss(decision.id)], ASOF);
  assert.equal(outcomes.length, 1, "the change is the unit, not the metric");
});

test("a step back that fails its OWN prediction spawns no revision of a revision", () => {
  const decision = landBenchStep();
  queueExpectationRevisions([attachMiss(decision.id)], ASOF);
  const revision = stepBackDecision();
  db.prepare(`UPDATE brain_decisions SET created_at = '2026-01-02T12:00:00.000Z' WHERE id = ?`).run(revision.id);

  const outcomes = queueExpectationRevisions([attachMiss(revision.id)], "2026-02-01");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "skipped");
  assert.match(outcomes[0].reason, /itself a step back/);
  assert.equal(
    listBrainDecisions({ limit: 100 }).filter((entry) => entry.context?.revision_step_back === true).length,
    1,
    "the machine does not argue with itself; the note carries it to a human"
  );
});

// The same restraint, on the path where the step back went through the REVIEW gate.
// Applying a held draft records a brand-new decision that the autonomy layer never
// touched, so the `revises_decision_id` stamp the test above relies on is not the
// thing keeping the loop closed here — miss that and a later not_aligned on the
// applied step back reconstructs from ITS snapshot and puts the load straight back up.
test("a step back applied from review is still a step back — no revision of a revision", () => {
  const decision = landBenchStep();
  repo.setSettings({ lead_mode: "review_everything" });
  const held = queueExpectationRevisions([attachMiss(decision.id)], ASOF);
  assert.equal(held[0].tier, "ask");
  assert.equal(repo.getProposal(held[0].proposal_id).status, "draft");

  // The athlete taps apply days later, through the ordinary proposal route.
  const applied = repo.applyProposal(held[0].proposal_id);
  assert.equal(applied.ok, true, "the held step back applies like any other draft");
  assert.equal(targetOf(1, "Barbell Bench Press").target_weight, 115, "it lands the step back");

  const revision = listBrainDecisions({ limit: 100 }).find(
    (entry) => entry.status === "applied" && entry.source === "revision-step-back"
  );
  assert.ok(revision, "the manual apply recorded its own applied decision");
  assert.equal(revision.context.revises_decision_id, decision.id, "provenance rode in on the proposal payload");
  db.prepare(`UPDATE brain_decisions SET created_at = '2026-01-02T12:00:00.000Z' WHERE id = ?`).run(revision.id);

  const outcomes = queueExpectationRevisions([attachMiss(revision.id)], "2026-02-01");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "skipped");
  assert.match(outcomes[0].reason, /itself a step back/);
  assert.equal(targetOf(1, "Barbell Bench Press").target_weight, 115, "the load is never put back up by a machine");
});

test("a step back with no provenance stamp is still recognised by what filed it", () => {
  const decision = landBenchStep();
  repo.setSettings({ lead_mode: "review_everything" });
  const held = queueExpectationRevisions([attachMiss(decision.id)], ASOF);
  repo.applyProposal(held[0].proposal_id);
  const revision = listBrainDecisions({ limit: 100 }).find(
    (entry) => entry.status === "applied" && entry.source === "revision-step-back"
  );
  // A row written before the payload carried its provenance — the belt that needs no
  // stamp at all is the proposal agent, copied onto every applied decision.
  patchBrainDecision(revision.id, { context: { instruction: null } });
  assert.equal(getBrainDecision(revision.id).context.revises_decision_id, undefined);
  db.prepare(`UPDATE brain_decisions SET created_at = '2026-01-02T12:00:00.000Z' WHERE id = ?`).run(revision.id);

  const outcomes = queueExpectationRevisions([attachMiss(revision.id)], "2026-02-01");
  assert.equal(outcomes[0].status, "skipped");
  assert.match(outcomes[0].reason, /itself a step back/);
  assert.equal(targetOf(1, "Barbell Bench Press").target_weight, 115);
});

// ---- the misses that are NOT the change's fault -------------------------------

test("behavioural misses queue nothing — adherence is the athlete's call", () => {
  const behavioural = [
    ["exercise_target_completion", "exercise_completion"],
    ["plan_day_adherence", "plan_adherence"],
    ["run_volume_adherence", "run_volume_adherence"],
  ];
  for (const [metric, evaluator] of behavioural) {
    const decision = landBenchStep();
    const evaluation = attachMiss(decision.id, {
      metric_key: metric,
      direction: "complete",
      target: { rate: 0.75, exposures: 2 },
      evaluator,
      evaluator_version: `${evaluator}-v1`,
    });
    assert.deepEqual(queueExpectationRevisions([evaluation], ASOF), [], `${metric} must not walk the plan back`);
    assert.equal(targetOf(1, "Barbell Bench Press").target_weight, 120);
  }
});

test("a missed day read queues nothing", () => {
  const decision = landBenchStep();
  const evaluation = attachMiss(decision.id, {
    metric_key: "day_read_adherence",
    direction: "complete",
    target: { followed: true },
    evaluator: "day_read_adherence",
    evaluator_version: "day-read-adherence-v1",
  });
  assert.deepEqual(queueExpectationRevisions([evaluation], ASOF), []);
});

test("an aligned verdict, and a change that never landed, queue nothing", () => {
  const decision = landBenchStep();
  const expectation = insertBrainExpectation(decision.id, {
    metric_key: "joint_pain_or_soreness",
    subject_key: null,
    direction: "at_most",
    baseline: null,
    target: { value: 2 },
    window_start: "2026-01-01",
    window_end: "2026-01-15",
    minimum_data: { exposures: 2 },
    confounder_policy: "require_exposure",
    confidence: "tentative",
    evaluator: "symptom_load",
    evaluator_version: "joint-pain-guard-v1",
  });
  const aligned = insertBrainEvaluation({
    expectation_id: expectation.id,
    verdict: "aligned",
    actual: { value: 1 },
    evidence_keys: ["sessions:2026-01-01..2026-01-15:n=4"],
    confounders: [],
    explanation: "The observed result landed within the expectation.",
    evaluator_version: "brain-maturity-v1/joint_pain",
  });
  assert.deepEqual(queueExpectationRevisions([aligned], ASOF), []);

  // A change still waiting on review has nothing in force to walk back.
  patchBrainDecision(decision.id, { status: "review" });
  assert.deepEqual(queueExpectationRevisions([attachMiss(decision.id)], ASOF), []);
});

// ---- it never guesses ---------------------------------------------------------

test("an athlete edit on the same target since the miss wins — reality moved on", () => {
  const decision = landBenchStep();
  // The athlete decided 125 themselves after the change landed.
  repo.updateTarget(1, "Barbell Bench Press", 125, undefined, {});

  const outcomes = queueExpectationRevisions([attachMiss(decision.id)], ASOF);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "skipped");
  assert.match(outcomes[0].reason, /has moved since the change/);
  assert.equal(targetOf(1, "Barbell Bench Press").target_weight, 125, "the coach never talks over the athlete");
  assert.equal(stepBackDecision(), null, "no draft, no ledger row, nothing to undo");
  // The refusal is readable where the failure is.
  assert.match(getBrainDecision(decision.id).context.revision.reason, /has moved since the change/);
  assert.equal(getBrainDecision(decision.id).context.revision.status, "skipped");
});

test("a change with no before-snapshot is skipped with a recorded reason, never guessed", () => {
  const decision = landBenchStep();
  // A manually applied proposal records its decision but stores no rollback
  // snapshot; there is no prior value to restore and inventing one is not allowed.
  db.prepare(`DELETE FROM brain_rollbacks WHERE decision_id = ?`).run(decision.id);

  const outcomes = queueExpectationRevisions([attachMiss(decision.id)], ASOF);
  assert.equal(outcomes[0].status, "skipped");
  assert.match(outcomes[0].reason, /no training before-snapshot/);
  assert.equal(targetOf(1, "Barbell Bench Press").target_weight, 120);
  assert.match(getBrainDecision(decision.id).context.revision.reason, /no training before-snapshot/);
});

test("an exercise that has left the plan is skipped rather than re-added", () => {
  const decision = landBenchStep();
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Cable Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 90 },
  ]);

  const outcomes = queueExpectationRevisions([attachMiss(decision.id)], ASOF);
  assert.equal(outcomes[0].status, "skipped");
  assert.match(outcomes[0].reason, /no longer the prescription/);
  assert.equal(stepBackDecision(), null, "re-adding a movement is structural, not a step back");
});

test("a prior prescription with no stored value is refused, not half-restored", () => {
  // The lift carried no rep range before the change, and `null` means "leave alone"
  // in the plan-change contract — so that field cannot be put back. The load COULD
  // be, but restoring half of one prescription would leave a shape the coach never
  // chose, so the whole target is refused instead.
  repo.savePlanDay(1, "Push", "Chest", [{ exercise: "Barbell Bench Press", target_weight: 115 }]);
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("coach", "load and a rep range", "", {
    summary: "Bench picks up load and a rep range.",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120, rep_low: 6, rep_high: 8 }],
  });
  const applied = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "quiet_apply" });
  assert.equal(applied.ok, true);
  db.prepare(`UPDATE brain_decisions SET created_at = '2026-01-01T12:00:00.000Z' WHERE id = ?`).run(
    applied.decision.id
  );

  const outcomes = queueExpectationRevisions([attachMiss(applied.decision.id)], ASOF);
  assert.equal(outcomes[0].status, "skipped");
  assert.match(outcomes[0].reason, /carried no rep_low/);
  assert.equal(targetOf(1, "Barbell Bench Press").target_weight, 120, "nothing was half-applied");
  assert.equal(stepBackDecision(), null);
});

test("a rotation is not a one-step-back target", () => {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
  ]);
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("coach", "rotate the press", "", {
    summary: "Rotate a same-pattern variation in.",
    changes: [{ day_number: 1, swap: { from: "Barbell Bench Press", to: "Dumbbell Bench Press" } }],
  });
  const applied = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "quiet_apply" });
  assert.equal(applied.ok, true);
  db.prepare(`UPDATE brain_decisions SET created_at = '2026-01-01T12:00:00.000Z' WHERE id = ?`).run(
    applied.decision.id
  );

  const outcomes = queueExpectationRevisions([attachMiss(applied.decision.id)], ASOF);
  assert.equal(outcomes[0].status, "skipped");
  assert.match(outcomes[0].reason, /rotated a movement/);
});

// ---- the athlete-facing register ----------------------------------------------

test("every step-back phrasing holds the reading grammar, and rotates", () => {
  const summaries = new Set();
  // One phrasing printed verbatim for weeks is what makes an app feel robotic, so
  // the set rotates by date + change like every other athlete-facing line.
  for (const asOf of ["2026-01-16", "2026-01-17", "2026-01-18", "2026-01-19", "2026-01-20", "2026-01-21"]) {
    // Age everything already in the ledger, so each round is a change from a
    // previous week rather than six changes fighting over one week's budget.
    db.prepare(`UPDATE brain_decisions SET created_at = '2026-01-01T12:00:00.000Z'`).run();
    const decision = landBenchStep();
    const outcome = queueExpectationRevisions([attachMiss(decision.id)], asOf)[0];
    assert.equal(outcome.status, "queued");
    const summary = repo.getProposal(outcome.proposal_id).parsed.summary;
    summaries.add(summary);
    assert.equal(
      violatesReadingGrammar(summary),
      null,
      `"${summary}" must hold the same grammar every other athlete-facing line does`
    );
  }
  assert.ok(summaries.size > 1, "a variant set, never one literal");
});
