// The evidence writers: an APPLIED training change now predicts something about
// the athlete's own experience of it (src/repo/brain/change-expectations.ts,
// wired in src/repo/profile.ts recordAppliedProposalDecision), and every one of
// those predictions is written only when the evidence that could falsify it is
// already being logged. Before this round eight of the fifteen contract metrics
// had no writer at all, so their registered evaluators were dead code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";
import {
  buildHrvGuardExpectation,
  buildLiftProgressionExpectations,
  buildTrainingFeedbackExpectations,
  liftProgressionSubjects,
  rebaseDeferredExpectations,
} from "../dist/repo/brain/change-expectations.js";
import { evaluateExpectation } from "../dist/brainEvaluator.js";
import { recordDecision } from "../dist/domain/brain/decision-service.js";

function isoDaysAgo(n) {
  return localDateISO(new Date(Date.now() - n * 864e5));
}

function dbInsertSet(sessionId, exId, { set_number = 1, weight = null, reps = null, duration_sec = null }) {
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, duration_sec)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, exId, set_number, weight, reps, duration_sec);
}

function rateSession(date, { performance = null, soreness = null, joint_pain = null } = {}) {
  const session = repo.getOrCreateSession(date, null);
  db.prepare(`UPDATE sessions SET performance = ?, soreness = ?, joint_pain = ? WHERE id = ?`).run(
    performance,
    soreness,
    joint_pain,
    session.id
  );
  return session;
}

function benchWithHistory(weights = [[24, 175], [17, 180], [10, 185]]) {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest" });
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  const exercise = repo.findExercise("Barbell Bench Press");
  for (const [daysAgo, weight] of weights) {
    const session = repo.getOrCreateSession(isoDaysAgo(daysAgo), null);
    dbInsertSet(session.id, exercise.id, { weight, reps: 8 });
  }
  return exercise;
}

function applyBenchStep() {
  const proposal = repo.createProposal("auto-progression", "step the bench", "", {
    summary: "Bench moves to 190.",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 190 }],
  });
  const result = repo.applyProposal(proposal.id);
  assert.equal(result.ok, true, "the bench step should apply");
  return proposal;
}

function expectationsForProposal(proposalId) {
  const decision = db
    .prepare(
      `SELECT id FROM brain_decisions
       WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ? AND status = 'applied'
       ORDER BY id DESC LIMIT 1`
    )
    .get(String(proposalId));
  if (!decision) return { decisionId: null, rows: [] };
  const rows = db
    .prepare(
      `SELECT metric_key, subject_key, direction, baseline_json, target_json, minimum_data_json,
              window_start, window_end, evaluator
         FROM brain_expectations WHERE decision_id = ? ORDER BY id`
    )
    .all(decision.id);
  return { decisionId: decision.id, rows };
}

// ---- the data-presence rule -------------------------------------------------

test("an applied training change predicts session feel and joint pain once the athlete logs them", () => {
  benchWithHistory();
  for (const daysAgo of [24, 17, 10]) {
    rateSession(isoDaysAgo(daysAgo), { performance: 4, soreness: 2, joint_pain: null });
  }
  const proposal = applyBenchStep();
  const { rows } = expectationsForProposal(proposal.id);
  const byMetric = new Map(rows.map((row) => [row.metric_key, row]));

  const feel = byMetric.get("session_performance_feedback");
  assert.ok(feel, "a rated history should earn a session-feel prediction");
  assert.equal(feel.direction, "at_least");
  assert.equal(feel.evaluator, "session_feedback");
  // Baseline-relative with half a point of slack: the claim is "not worse than
  // before", never "keep scoring highly".
  assert.equal(JSON.parse(feel.baseline_json).average_rating, 4);
  assert.equal(JSON.parse(feel.target_json).value, 3.5);
  assert.equal(JSON.parse(feel.minimum_data_json).sessions, 2);

  const pain = byMetric.get("joint_pain_or_soreness");
  assert.ok(pain, "logged autoregulation feedback should earn a joint-pain prediction");
  assert.equal(pain.direction, "avoid");
  assert.equal(JSON.parse(pain.target_json).max, 0, "no pain was being reported, so any is a miss");
});

test("pain already being reported is not held against the change that follows it", () => {
  benchWithHistory();
  rateSession(isoDaysAgo(24), { performance: 3, soreness: 3, joint_pain: "left shoulder" });
  rateSession(isoDaysAgo(17), { performance: 3, soreness: 3, joint_pain: "left shoulder" });
  rateSession(isoDaysAgo(10), { performance: 3, soreness: 2 });
  const proposal = applyBenchStep();
  const { rows } = expectationsForProposal(proposal.id);
  const pain = rows.find((row) => row.metric_key === "joint_pain_or_soreness");
  assert.ok(pain);
  // The bar is the pain level that already existed, expressed over the window it is
  // CHECKED over: two sore sessions in the 28-day lookback is one across a 14-day
  // window. Comparing the raw counts handed the guard twice the room it was written to
  // allow — a real doubling of joint complaints came back "aligned".
  assert.equal(JSON.parse(pain.target_json).max, 1, "the baseline count is rescaled to the window's length");
  const spanDays = Math.round(
    (Date.parse(`${pain.window_end}T00:00:00Z`) - Date.parse(`${pain.window_start}T00:00:00Z`)) / 864e5
  );
  assert.equal(spanDays, 14, "…and that window is the one the target is expressed in");
});

test("the pain guard keeps its floor: one occurrence in the lookback still permits one", () => {
  benchWithHistory();
  rateSession(isoDaysAgo(20), { performance: 3, soreness: 3, joint_pain: "left shoulder" });
  rateSession(isoDaysAgo(12), { performance: 3, soreness: 2 });
  const proposal = applyBenchStep();
  const { rows } = expectationsForProposal(proposal.id);
  const pain = rows.find((row) => row.metric_key === "joint_pain_or_soreness");
  assert.ok(pain);
  // Rounding is deliberately generous. Pain that was ALREADY being reported is not this
  // change's fault, and rescaling must never convert an existing complaint into a
  // guard the change is convicted by on its first sore day.
  assert.equal(JSON.parse(pain.target_json).max, 1, "an existing complaint is still tolerated once");
});

test("a frequent pain history scales down proportionally, not to zero", () => {
  benchWithHistory();
  for (const back of [26, 22, 18, 14]) {
    rateSession(isoDaysAgo(back), { performance: 3, soreness: 3, joint_pain: "left shoulder" });
  }
  const proposal = applyBenchStep();
  const { rows } = expectationsForProposal(proposal.id);
  const pain = rows.find((row) => row.metric_key === "joint_pain_or_soreness");
  assert.ok(pain);
  assert.equal(JSON.parse(pain.target_json).max, 2, "four sore sessions a month is two a fortnight");
});

test("an athlete who logs no feedback collects no feedback predictions", () => {
  benchWithHistory();
  const proposal = applyBenchStep();
  const { rows } = expectationsForProposal(proposal.id);
  const metrics = rows.map((row) => row.metric_key);
  assert.ok(
    !metrics.includes("session_performance_feedback"),
    "an unratable window must not earn a prediction that can never mature"
  );
  assert.ok(!metrics.includes("joint_pain_or_soreness"));
});

// ---- est-1RM ----------------------------------------------------------------

test("a load step on a lift with loaded history predicts its est-1RM holds", () => {
  benchWithHistory();
  const proposal = applyBenchStep();
  const { rows } = expectationsForProposal(proposal.id);
  const lift = rows.find((row) => row.metric_key === "exercise_est_1rm_trend");
  assert.ok(lift, "a loaded lift should earn an est-1RM prediction");
  assert.equal(lift.subject_key, "Barbell Bench Press");
  assert.equal(lift.direction, "at_least");
  assert.equal(lift.evaluator, "exercise_est_1rm");
  // Epley on the best set: 185 x 8 -> 234.3, floor at 97% of it.
  const baseline = JSON.parse(lift.baseline_json).est_1rm;
  assert.ok(Math.abs(baseline - 234.3) < 0.2, `unexpected baseline ${baseline}`);
  assert.ok(JSON.parse(lift.target_json).value < baseline);
  const spanDays = Math.round(
    (Date.parse(`${lift.window_end}T00:00:00Z`) - Date.parse(`${lift.window_start}T00:00:00Z`)) / 864e5
  );
  assert.equal(spanDays, 21, "est-1RM needs a window long enough to actually move");
});

test("timed, assisted, and bodyweight movements never carry an est-1RM prediction", () => {
  repo.upsertExercise({ name: "Plank", muscle_group: "core", mode: "timed" });
  repo.upsertExercise({ name: "Assisted Pull-up", muscle_group: "back" });
  repo.upsertExercise({ name: "Push-up", muscle_group: "chest" });
  const plank = repo.findExercise("Plank");
  const assisted = repo.findExercise("Assisted Pull-up");
  const bodyweight = repo.findExercise("Push-up");
  const session = repo.getOrCreateSession(isoDaysAgo(10), null);
  dbInsertSet(session.id, plank.id, { duration_sec: 60 });
  dbInsertSet(session.id, assisted.id, { weight: -30, reps: 8 });
  dbInsertSet(session.id, bodyweight.id, { weight: null, reps: 15 });

  const subjects = liftProgressionSubjects(["Plank", "Assisted Pull-up", "Push-up"], localDateISO());
  assert.deepEqual(subjects, [], "none of these can carry a one-rep-max estimate");
  assert.deepEqual(buildLiftProgressionExpectations(subjects, localDateISO()), []);
});

// ---- the wearable-neutral rule ----------------------------------------------

test("the HRV recovery guard is written only when the watch has been producing HRV", () => {
  const today = localDateISO();
  const context = { prior_weekly_km: 20, new_weekly_km: 26 };
  assert.equal(buildHrvGuardExpectation(today, 28, context), null, "no nights logged means no prediction");

  const insert = db.prepare(`INSERT INTO daily_metrics (date, hrv_ms) VALUES (?, ?)`);
  for (let daysAgo = 1; daysAgo <= 8; daysAgo++) insert.run(isoDaysAgo(daysAgo), 60);
  const guard = buildHrvGuardExpectation(today, 28, context);
  assert.ok(guard, "eight logged nights is a real baseline");
  assert.equal(guard.metric_key, "recovery_hrv_delta");
  assert.equal(guard.evaluator, "recovery_delta");
  // A tenth of the athlete's OWN level, not a population constant.
  assert.equal(guard.target.value, -6);
  assert.equal(guard.baseline.hrv_avg_ms, 60);
});

// ---- the evaluators actually answer these ------------------------------------

function storedExpectation(expectation, decisionOverrides = {}) {
  const recorded = recordDecision(
    {
      effective_date: "2026-01-01",
      kind: "training_target",
      domain: "training",
      summary: "One bounded step on the main lift.",
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
      ...decisionOverrides,
    },
    [expectation]
  );
  return { decision: recorded.decision, expectation: recorded.expectations[0] };
}

test("each newly wired metric reaches a decisive verdict on mature synthetic evidence", () => {
  const exercise = repo.upsertExercise({ name: "Back Squat", muscle_group: "legs" });
  // Sessions the change can be judged against: feel holds, no pain, the lift holds.
  for (const [date, weight] of [
    ["2026-01-03", 225],
    ["2026-01-08", 230],
    ["2026-01-13", 235],
  ]) {
    const session = repo.getOrCreateSession(date, null);
    dbInsertSet(session.id, exercise.id, { weight, reps: 5 });
    db.prepare(`UPDATE sessions SET performance = 4, soreness = 2 WHERE id = ?`).run(session.id);
  }

  const feel = storedExpectation(
    buildTrainingFeedbackExpectations("2026-01-01", {
      rated_sessions: 3,
      average_rating: 4,
      feedback_sessions: 3,
      pain_sessions: 0,
    })[0]
  );
  const feelVerdict = evaluateExpectation(feel.expectation, feel.decision, "2026-01-20");
  assert.equal(feelVerdict.verdict, "aligned", JSON.stringify(feelVerdict.confounders));
  assert.equal(feelVerdict.actual.average_rating, 4);

  const pain = storedExpectation(
    buildTrainingFeedbackExpectations("2026-01-01", {
      rated_sessions: 3,
      average_rating: 4,
      feedback_sessions: 3,
      pain_sessions: 0,
    })[1],
    { summary: "A second bounded step, judged on joint pain." }
  );
  const painVerdict = evaluateExpectation(pain.expectation, pain.decision, "2026-01-20");
  assert.equal(painVerdict.verdict, "aligned", JSON.stringify(painVerdict.confounders));

  const lift = storedExpectation(
    buildLiftProgressionExpectations(
      [{ exercise: "Back Squat", exercise_id: exercise.id, baseline_est_1rm: 250 }],
      "2026-01-01"
    )[0],
    { summary: "A bounded step on the squat, judged on its own estimate." }
  );
  const liftVerdict = evaluateExpectation(lift.expectation, lift.decision, "2026-01-25");
  assert.equal(liftVerdict.verdict, "aligned", JSON.stringify(liftVerdict.confounders));
  // 235 x 5 -> 274 est-1RM, comfortably above the 242.5 floor.
  assert.ok(liftVerdict.actual.value > 250);
});

test("an est-1RM that regresses past the floor reads as not aligned, not as noise", () => {
  const exercise = repo.upsertExercise({ name: "Back Squat", muscle_group: "legs" });
  for (const [date, weight] of [
    ["2026-01-03", 205],
    ["2026-01-08", 195],
    ["2026-01-13", 185],
  ]) {
    const session = repo.getOrCreateSession(date, null);
    dbInsertSet(session.id, exercise.id, { weight, reps: 5 });
  }
  const lift = storedExpectation(
    buildLiftProgressionExpectations(
      [{ exercise: "Back Squat", exercise_id: exercise.id, baseline_est_1rm: 250 }],
      "2026-01-01"
    )[0]
  );
  const verdict = evaluateExpectation(lift.expectation, lift.decision, "2026-01-25");
  assert.equal(verdict.verdict, "not_aligned", JSON.stringify(verdict.confounders));
});

test("a planned deload as the last exposure is not a regression — the window's BEST answers the claim", () => {
  // The claim this expectation makes is "the step should HOLD": did the lift's estimate
  // stay at or above where it stood. Reading the LAST exposure made an easy final
  // session look like a miss, which both eased the progression step and filed a "that
  // change hasn't landed" note about a change that had in fact worked.
  const exercise = repo.upsertExercise({ name: "Front Squat", muscle_group: "legs" });
  for (const [date, weight] of [
    ["2026-01-03", 215],
    ["2026-01-08", 210],
    ["2026-01-13", 150], // the deload
  ]) {
    const session = repo.getOrCreateSession(date, null);
    dbInsertSet(session.id, exercise.id, { weight, reps: 5 });
  }
  const lift = storedExpectation(
    buildLiftProgressionExpectations(
      [{ exercise: "Front Squat", exercise_id: exercise.id, baseline_est_1rm: 250 }],
      "2026-01-01"
    )[0]
  );
  const verdict = evaluateExpectation(lift.expectation, lift.decision, "2026-01-25");
  assert.equal(verdict.verdict, "aligned", JSON.stringify(verdict));
  assert.ok(verdict.actual.best_est_1rm > verdict.actual.last_est_1rm, "both are reported; the best is what is judged");
  assert.equal(verdict.actual.value, verdict.actual.best_est_1rm);
});

// ---- deferred conference predictions ----------------------------------------

test("a parked prediction thaws with its window slid onto the day the change lands", () => {
  const parked = [
    {
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
      evaluator_version: "conference-v1",
    },
  ];
  const [thawed] = rebaseDeferredExpectations(parked, "2026-03-10");
  assert.equal(thawed.window_start, "2026-03-10");
  assert.equal(thawed.window_end, "2026-03-24", "the original 14-day length is preserved");
  assert.deepEqual(rebaseDeferredExpectations([{ metric_key: "nonsense" }], "2026-03-10"), []);
  assert.deepEqual(rebaseDeferredExpectations(null, "2026-03-10"), []);
});
