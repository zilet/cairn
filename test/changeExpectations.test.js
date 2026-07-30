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
  buildAerobicTrendExpectation,
  buildHrvGuardExpectation,
  buildLiftProgressionExpectations,
  buildTrainingFeedbackExpectations,
  hasLiveAerobicTrendWindow,
  liftProgressionSubjects,
  rebaseDeferredExpectations,
} from "../dist/repo/brain/change-expectations.js";
import { evaluateExpectation } from "../dist/brainEvaluator.js";
import { recordDecision } from "../dist/domain/brain/decision-service.js";
import { transitionBrainDecision } from "../dist/repo/brain-decisions.js";
import { createBlock } from "../dist/repo/program-blocks.js";

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

// ---- the long-horizon aerobic read ------------------------------------------
//
// vo2max_trend is the one metric whose evaluator refuses to speak on less than 4
// readings spanning 21 days, so its window has to be long enough that an ordinary
// training month can fill it. That length is what makes it fragile, and the two guards
// below are the whole design: it is written only when the watch is actually producing
// VO2max, and never while another aerobic window is still standing — two overlapping
// windows are flagged as each other's confounder and both come back inconclusive.

function seedVo2max(rows) {
  const insert = db.prepare(
    `INSERT INTO daily_metrics (source, date, vo2max, updated_at) VALUES ('apple', ?, ?, datetime('now'))`
  );
  for (const [date, value] of rows) insert.run(date, value);
}

// Three readings inside the trailing month before 2026-02-01 — the flowing-signal bar.
function seedFlowingSignal() {
  seedVo2max([
    ["2026-01-15", 49],
    ["2026-01-22", 50],
    ["2026-01-29", 50],
  ]);
}

// Four readings inside the 2026-02-01 → 2026-03-29 window, spanning past the
// evaluator's 21-day floor, moving by `step` each reading.
function seedWindowTrend(step) {
  seedVo2max([
    ["2026-02-05", 50],
    ["2026-02-19", 50 + step],
    ["2026-03-05", 50 + step * 2],
    ["2026-03-19", 50 + step * 3],
  ]);
}

test("the aerobic-trend expectation is written only when VO2max readings are actually flowing", () => {
  assert.equal(buildAerobicTrendExpectation("2026-02-01"), null, "no watch data writes nothing at all");

  seedVo2max([
    ["2026-01-15", 49],
    ["2026-01-22", 50],
  ]);
  assert.equal(buildAerobicTrendExpectation("2026-02-01"), null, "two readings is not a flowing signal");

  seedVo2max([["2026-01-29", 50]]);
  const written = buildAerobicTrendExpectation("2026-02-01");
  assert.ok(written, "three readings in the trailing month opens the window");
  assert.equal(written.metric_key, "vo2max_trend");
  assert.equal(written.evaluator, "vo2max_trend");
  assert.equal(written.window_start, "2026-02-01");
  assert.equal(written.window_end, "2026-03-29", "an eight-week window");
  assert.deepEqual(
    written.minimum_data,
    { readings: 4, span_days: 21 },
    "the minimum-data rule mirrors what the evaluator actually demands"
  );
  assert.equal(written.direction, "at_least", "the claim is a floor — flat aerobic fitness is a fine outcome");
  assert.ok(written.target.value < 0, "the floor sits just below flat, not above it");
  assert.equal(written.baseline.recent_readings, 3, "the evidence that opened the window is recorded");
});

test("a standing aerobic window blocks a second one, so the two can never confound each other", () => {
  // The data gate is satisfied explicitly here so the OVERLAP guard is the only thing
  // under test.
  const flowing = { recentReadings: 5 };
  const first = buildAerobicTrendExpectation("2026-02-01", flowing);
  assert.ok(first);
  storedExpectation(first, { summary: "A long-horizon aerobic read." });

  assert.equal(buildAerobicTrendExpectation("2026-02-08", flowing), null, "a week later it is still standing");
  assert.equal(buildAerobicTrendExpectation("2026-03-28", flowing), null, "and still, right up to its last day");
  assert.ok(
    buildAerobicTrendExpectation("2026-03-30", flowing),
    "the day after it closes, the next window is free to open"
  );
});

test("a canceled decision releases its aerobic window instead of blocking the next one forever", () => {
  const flowing = { recentReadings: 5 };
  const stored = storedExpectation(buildAerobicTrendExpectation("2026-02-01", flowing), {
    summary: "A long-horizon aerobic read.",
  });
  assert.equal(buildAerobicTrendExpectation("2026-02-08", flowing), null);

  transitionBrainDecision(stored.decision.id, "canceled");
  assert.ok(buildAerobicTrendExpectation("2026-02-08", flowing), "a decision that died takes its window with it");
});

test("the aerobic evaluator reads a held trend as aligned on mature evidence", () => {
  seedFlowingSignal();
  seedWindowTrend(0.5); // gently climbing across the window
  const stored = storedExpectation(buildAerobicTrendExpectation("2026-02-01"), {
    summary: "A long-horizon aerobic read.",
  });
  const verdict = evaluateExpectation(stored.expectation, stored.decision, "2026-03-30");
  assert.equal(verdict.verdict, "aligned", JSON.stringify(verdict.confounders));
  assert.equal(verdict.actual.readings, 4, "exactly the evaluator's minimum is enough");
  assert.ok(verdict.actual.span_days >= 21);
  assert.ok(verdict.actual.value > 0, "the reported value is the per-week slope");
});

test("a real aerobic decline across the window reads as not aligned", () => {
  seedFlowingSignal();
  seedWindowTrend(-1.5);
  const stored = storedExpectation(buildAerobicTrendExpectation("2026-02-01"), {
    summary: "A long-horizon aerobic read.",
  });
  const verdict = evaluateExpectation(stored.expectation, stored.decision, "2026-03-30");
  assert.equal(verdict.verdict, "not_aligned", JSON.stringify(verdict.confounders));
  assert.ok(verdict.actual.value < 0);
});

test("a flat aerobic trend is a perfectly good outcome, not a miss", () => {
  seedFlowingSignal();
  seedWindowTrend(0);
  const stored = storedExpectation(buildAerobicTrendExpectation("2026-02-01"), {
    summary: "A long-horizon aerobic read.",
  });
  const verdict = evaluateExpectation(stored.expectation, stored.decision, "2026-03-30");
  assert.equal(verdict.verdict, "aligned", "holding aerobic fitness clears a floor-shaped claim");
});

test("a thin window stays inconclusive rather than convicting an athlete whose watch went quiet", () => {
  seedFlowingSignal();
  const stored = storedExpectation(buildAerobicTrendExpectation("2026-02-01"), {
    summary: "A long-horizon aerobic read.",
  });
  // Only two readings land inside the window, and they span under three weeks.
  seedVo2max([
    ["2026-02-05", 50],
    ["2026-02-12", 49],
  ]);
  const verdict = evaluateExpectation(stored.expectation, stored.decision, "2026-03-30");
  assert.equal(verdict.verdict, "inconclusive", "absence of signal is neutral, never a miss");
  assert.ok(verdict.confounders.some((item) => /4 readings|readings were available/i.test(item)));
});

// ---- where the aerobic read actually lives ----------------------------------
//
// A program block is the only training structure with a declared multi-week lifetime
// and it is created rarely, so it is the one decision that can host a window measured
// in months without either confounding itself or attributing two months of aerobic
// drift to one week's prescription.

function blockDecisions() {
  return db
    .prepare(`SELECT id, summary, status, action_json FROM brain_decisions WHERE kind = 'training_structure' ORDER BY id`)
    .all();
}

function aerobicExpectations() {
  return db
    .prepare(`SELECT id, decision_id, window_start, window_end FROM brain_expectations WHERE metric_key = 'vo2max_trend' ORDER BY id`)
    .all();
}

test("structuring a block opens the aerobic window when the watch is reporting VO2max", () => {
  seedVo2max([
    [isoDaysAgo(20), 49],
    [isoDaysAgo(12), 50],
    [isoDaysAgo(5), 50],
  ]);

  const block = createBlock({ goal: "Strength base", focus: "strength", total_weeks: 6 });
  const decisions = blockDecisions();
  assert.equal(decisions.length, 1, "the block is recorded in the ledger");
  assert.equal(decisions[0].status, "applied");
  assert.equal(JSON.parse(decisions[0].action_json).block_id, block.id, "the decision points back at its block");

  const written = aerobicExpectations();
  assert.equal(written.length, 1, "and carries the long-horizon aerobic expectation");
  assert.equal(written[0].decision_id, decisions[0].id);
  assert.equal(written[0].window_start, localDateISO(), "the window opens the day the block starts");
});

test("a block started by an athlete with no VO2max readings records the block and claims nothing", () => {
  createBlock({ goal: "Strength base", focus: "strength", total_weeks: 6 });
  assert.equal(blockDecisions().length, 1, "the structural fact is still recorded");
  assert.equal(aerobicExpectations().length, 0, "no watch, no prediction — absence stays neutral");
});

test("a second block inside a live window is recorded without opening a duplicate window", () => {
  seedVo2max([
    [isoDaysAgo(20), 49],
    [isoDaysAgo(12), 50],
    [isoDaysAgo(5), 50],
  ]);

  createBlock({ goal: "Strength base", focus: "strength", total_weeks: 6 });
  assert.equal(aerobicExpectations().length, 1);

  // The athlete changes direction a fortnight in. The block is superseded; the aerobic
  // window it opened is not, and a second one would confound both into silence.
  createBlock({ goal: "Endurance base", focus: "endurance-base", total_weeks: 8 });
  assert.equal(blockDecisions().length, 2, "the new block is recorded on its own decision");
  assert.equal(aerobicExpectations().length, 1, "but the standing aerobic window is left alone");
});

test("block recording never takes periodization down with it", () => {
  // The ledger is audit, not the mutation: with the decision tables unavailable,
  // creating a block must still return a live block rather than throwing at the athlete.
  //
  // The schema is captured and restored in `finally` rather than simply dropped. The
  // harness's per-test wipe (test/_isolate.mjs) enumerates tables and prepares its
  // DELETE statements ONCE at import, and worker processes are shared across files, so
  // a table left dropped here would fail the wipe for every later test in the process —
  // including tests in other files.
  const ddl = db
    .prepare(
      `SELECT sql FROM sqlite_master
        WHERE sql IS NOT NULL
          AND (name IN ('brain_decisions', 'brain_expectations')
               OR tbl_name IN ('brain_decisions', 'brain_expectations'))
        ORDER BY CASE WHEN type = 'table' THEN 0 ELSE 1 END, rootpage`
    )
    .all()
    .map((row) => row.sql);
  assert.ok(ddl.length >= 2, "the ledger schema was captured before it is taken away");

  try {
    db.exec(`DROP TABLE IF EXISTS brain_expectations; DROP TABLE IF EXISTS brain_decisions;`);
    const block = createBlock({ goal: "Strength base", focus: "strength", total_weeks: 6 });
    assert.ok(block?.id > 0, "the block is created regardless");
    assert.equal(block.status, "active");
  } finally {
    for (const sql of ddl) db.exec(sql);
  }

  // …and the restored ledger is usable again, so nothing downstream inherits a wreck.
  assert.equal(blockDecisions().length, 0);
  const after = createBlock({ goal: "Endurance base", focus: "endurance-base", total_weeks: 8 });
  assert.ok(after?.id > 0);
  assert.equal(blockDecisions().length, 1, "recording resumes once the ledger is back");
});
