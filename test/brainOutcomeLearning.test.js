// The exercise outcome-learning loop must reach honest verdicts whenever real
// evidence exists — and stay inconclusive, with a NAMED reason, when it does not.
//
// Each block below reproduces one root cause a live audit found behind a quarter
// in which every exercise, pain, and recovery expectation came back inconclusive or
// was never evaluated at all:
//   1. a blanket context rule (any trip/injury/tag anywhere in the window silenced
//      every exercise verdict, even with clean sessions either side of it);
//   2. a raw lowercase name match (alias-spelled subjects never found their lift);
//   3. a completion target with no prescription (every exposure "completed");
//   4. the session that EARNED the change graded against it;
//   5. agent-authored est-1RM floors the generic comparison could not read;
//   6. a recovery evaluator that threw on a column that never existed — silently;
//   7. a candidate order that let finished canceled rows crowd out new maturations;
//   8. a pain guard reading a retired feedback box instead of the verbatim reports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExpectation, evaluateMatureExpectations } from "../dist/brainEvaluator.js";
import { getBrainDecision, getBrainExpectation, recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation, latestBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { classifyInconclusiveReason, inconclusiveReasons } from "../dist/brain/inconclusive-reasons.js";
import { getBrainDiagnostics } from "../dist/domain/operator/brain-diagnostics-use-case.js";
import { sessionFeedbackBaseline } from "../dist/repo/brain/change-expectations.js";
import { liftLedgerRead } from "../dist/repo/reaction-model.js";
import { trainingModifierFor } from "../dist/repo/progression.js";
import { sameLiftName } from "../dist/repo/exercise-canon.js";
import { db } from "../dist/db.js";

const APPLIED_AT = "2026-01-01T12:00:00.000Z";
const AS_OF = "2026-01-29";

let seedCounter = 0;
function decision(overrides = {}) {
  seedCounter += 1;
  return {
    effective_date: "2026-01-01",
    kind: "training_target",
    domain: "training",
    summary: `Bounded training change ${seedCounter}.`,
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
    action: { seed: seedCounter },
    specialist: null,
    applied_at: APPLIED_AT,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "test-v1",
    ...overrides,
  };
}

function completion(subject, overrides = {}) {
  return {
    metric_key: "exercise_target_completion",
    subject_key: subject,
    direction: "complete",
    baseline: null,
    target: { exposures: 2 },
    window_start: "2026-01-01",
    window_end: "2026-01-28",
    minimum_data: { exposures: 2 },
    confounder_policy: "require_exposure",
    confidence: "tentative",
    evaluator: "exercise_completion",
    evaluator_version: "exercise-completion-v1",
    ...overrides,
  };
}

function est1rm(subject, overrides = {}) {
  return {
    metric_key: "exercise_est_1rm_trend",
    subject_key: subject,
    direction: "at_least",
    baseline: { est_1rm: 200, basis: "estimated" },
    target: { value: 194 },
    window_start: "2026-01-01",
    window_end: "2026-01-22",
    minimum_data: { exposures: 3 },
    confounder_policy: "require_exposure",
    confidence: "tentative",
    evaluator: "exercise_est_1rm",
    evaluator_version: "lift-progression-hold-v2",
    ...overrides,
  };
}

function exercise(name, group = "back") {
  const row = db.prepare(`SELECT id FROM exercises WHERE name = ?`).get(name);
  if (row) return Number(row.id);
  return Number(
    db.prepare(`INSERT INTO exercises (name, muscle_group) VALUES (?, ?)`).run(name, group).lastInsertRowid
  );
}

// One session of `name` on `date`, finished at `finishedAt` (UTC SQLite stamp), with
// the given [weight, reps] sets.
function session(date, name, sets, finishedAt = `${date} 18:00:00`) {
  const exerciseId = exercise(name);
  const sessionId = Number(
    db.prepare(`INSERT INTO sessions (date, kind, finished_at) VALUES (?, 'strength', ?)`).run(date, finishedAt)
      .lastInsertRowid
  );
  sets.forEach(([weight, reps], index) => {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, ?, ?, ?)`
    ).run(sessionId, exerciseId, index + 1, weight, reps);
  });
  return sessionId;
}

function judge(recorded, asOf = AS_OF) {
  const expectation = getBrainExpectation(recorded.expectations[0].id);
  return evaluateExpectation(expectation, getBrainDecision(expectation.decision_id), asOf);
}

const rowChange = (overrides = {}) => ({
  day_number: 1,
  exercise: "Pendlay Row",
  sets: 2,
  rep_low: 8,
  rep_high: 10,
  target_weight: 150,
  target_seconds: null,
  ...overrides,
});

// ---- 3. a completion target with no prescription is never a free pass ----------

test("a completion expectation with no prescription anywhere stays inconclusive and says why", () => {
  session("2026-01-05", "Pendlay Row", [
    [145, 10],
    [145, 10],
  ]);
  session("2026-01-12", "Pendlay Row", [
    [145, 10],
    [145, 10],
  ]);
  const recorded = recordDecision(decision(), [completion("Pendlay Row")]);

  const result = judge(recorded);
  assert.equal(result.verdict, "inconclusive", "touching the lift is not completing a prescription");
  assert.ok(inconclusiveReasons(result.confounders).includes("no_prescription"));
});

test("the prescription is read from the decision's own change and judged per set", () => {
  // The change asked for 2 x 8 @ 150; two sessions at 145 never met it.
  session("2026-01-05", "Pendlay Row", [
    [145, 10],
    [145, 10],
  ]);
  session("2026-01-12", "Pendlay Row", [
    [145, 10],
    [145, 10],
  ]);
  session("2026-01-19", "Pendlay Row", [
    [150, 8],
    [140, 8],
  ]); // one set at load is not two
  const missed = recordDecision(decision({ action: { changes: [rowChange()] } }), [completion("Pendlay Row")]);

  const result = judge(missed);
  assert.equal(result.verdict, "not_aligned");
  assert.equal(result.actual.completed_exposures, 0);
  assert.equal(result.actual.prescription.target_weight, 150);
  assert.equal(result.actual.prescription.source, "decision_change");
});

test("the prescription met in at least the stated number of sessions aligns — one off day does not flip it", () => {
  session("2026-01-05", "Pendlay Row", [
    [150, 8],
    [150, 9],
  ]);
  session("2026-01-12", "Pendlay Row", [
    [135, 10],
    [135, 10],
  ]); // an easy day
  session("2026-01-19", "Pendlay Row", [
    [150, 10],
    [150, 8],
  ]);
  const recorded = recordDecision(decision({ action: { changes: [rowChange()] } }), [completion("Pendlay Row")]);

  const result = judge(recorded);
  assert.equal(result.verdict, "aligned");
  assert.equal(result.actual.completed_exposures, 2);
  assert.equal(result.actual.exposures, 3);
});

test("a change that did not move the lift's prescription is not a change to judge", () => {
  session("2026-01-05", "Ankle Rocker", [
    [null, 10],
    [null, 10],
  ]);
  session("2026-01-12", "Ankle Rocker", [[null, 10]]);
  const unchanged = {
    day_number: 1,
    exercise: "Ankle Rocker",
    sets: 2,
    rep_low: 10,
    rep_high: 10,
    target_weight: null,
    before: { sets: 2, rep_low: 10, rep_high: 10, target_weight: null },
  };
  const recorded = recordDecision(decision({ action: { changes: [unchanged] } }), [completion("Ankle Rocker")]);

  const result = judge(recorded);
  assert.equal(result.verdict, "inconclusive");
  assert.ok(inconclusiveReasons(result.confounders).includes("no_change"));
});

// ---- 4. the session that earned the change is not a test of it -------------------

test("work finished before the change landed is set aside, even on the decision's own date", () => {
  // The triggering session finished one minute before the change was applied.
  session(
    "2026-01-01",
    "Pendlay Row",
    [
      [150, 10],
      [150, 10],
    ],
    "2026-01-01 11:59:00"
  );
  session("2026-01-12", "Pendlay Row", [
    [150, 8],
    [150, 8],
  ]);
  const recorded = recordDecision(decision({ action: { changes: [rowChange()] } }), [completion("Pendlay Row")]);

  const result = judge(recorded);
  assert.equal(result.actual.pre_change_exposures, 1);
  assert.equal(result.actual.exposures, 1, "only the post-change session counts");
  assert.equal(result.verdict, "inconclusive", "one clean exposure is under the expectation's own minimum");
  assert.ok(inconclusiveReasons(result.confounders).includes("thin_sample"));
});

test("an est-1RM hold is judged on post-change work only — the trigger's number never vouches for it", () => {
  // Trigger: 200 x 6 → est 240. After the step the lift never got back near it.
  session("2026-01-01", "Back Squat", [[200, 6]], "2026-01-01 11:00:00");
  session("2026-01-06", "Back Squat", [[185, 5]]);
  session("2026-01-12", "Back Squat", [[185, 5]]);
  session("2026-01-19", "Back Squat", [[185, 6]]);
  const recorded = recordDecision(decision(), [est1rm("Back Squat", { target: { value: 232.8 } })]);

  const result = judge(recorded);
  assert.equal(result.verdict, "not_aligned");
  assert.ok(result.actual.best_est_1rm < 232.8);
  assert.equal(result.actual.pre_change_exposures, 1);
});

// ---- 1. context confounds the exposures it covered, not the whole window ----------

test("a trip inside an exercise window sets aside only the sessions it covered", () => {
  db.prepare(
    `INSERT INTO context_events (kind, title, start_date, end_date) VALUES ('trip', 'Belgrade', '2026-01-10', '2026-01-14')`
  ).run();
  session("2026-01-05", "Pendlay Row", [
    [150, 8],
    [150, 8],
  ]);
  session("2026-01-12", "Pendlay Row", [
    [120, 8],
    [120, 8],
  ]); // hotel gym — inside the trip
  session("2026-01-19", "Pendlay Row", [
    [150, 9],
    [150, 8],
  ]);
  const recorded = recordDecision(decision({ action: { changes: [rowChange()] } }), [completion("Pendlay Row")]);

  const result = judge(recorded);
  assert.equal(result.verdict, "aligned", "clean sessions either side of the trip still answer the question");
  assert.equal(result.actual.context_excluded_exposures, 1);
  assert.deepEqual(result.actual.context_excluded_by, ["Belgrade"]);
  assert.ok(!result.confounders.some((item) => /overlapped the evaluation window/.test(item)));
});

test("an injury still sets aside the sessions inside it, and a window with nothing clean left says so", () => {
  db.prepare(
    `INSERT INTO context_events (kind, title, start_date, end_date) VALUES ('injury', 'Flank niggle', '2026-01-01', '2026-01-28')`
  ).run();
  session("2026-01-05", "Pendlay Row", [
    [150, 8],
    [150, 8],
  ]);
  session("2026-01-12", "Pendlay Row", [
    [150, 8],
    [150, 8],
  ]);
  const recorded = recordDecision(decision({ action: { changes: [rowChange()] } }), [completion("Pendlay Row")]);

  const result = judge(recorded);
  assert.equal(result.verdict, "inconclusive");
  const reasons = inconclusiveReasons(result.confounders);
  assert.ok(reasons.includes("context_excluded_all"), reasons.join(","));
  assert.ok(!reasons.includes("not_exposed"), "it was exposed — just never cleanly");
});

test("a window-level metric (weight trend) is still confounded by the same trip", () => {
  db.prepare(
    `INSERT INTO context_events (kind, title, start_date, end_date) VALUES ('trip', 'Belgrade', '2026-01-05', '2026-01-08')`
  ).run();
  const insert = db.prepare(`INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)`);
  for (const [date, weight] of [
    ["2026-01-01", 200],
    ["2026-01-04", 199.8],
    ["2026-01-07", 199.6],
    ["2026-01-10", 199.4],
    ["2026-01-13", 199.2],
    ["2026-01-15", 199.0],
  ])
    insert.run(date, weight);
  const recorded = recordDecision(decision({ kind: "nutrition_target", domain: "nutrition" }), [
    {
      metric_key: "weight_trend_lb_wk",
      subject_key: null,
      direction: "within_band",
      baseline: { value: -1.2 },
      target: { min: -1, max: -0.2 },
      window_start: "2026-01-01",
      window_end: "2026-01-15",
      minimum_data: { weigh_ins: 6 },
      confounder_policy: "exclude_context_events",
      confidence: "tentative",
      evaluator: "weight_trend",
      evaluator_version: "test-v1",
    },
  ]);
  const result = judge(recorded, "2026-01-15");
  assert.equal(result.verdict, "inconclusive");
  assert.ok(inconclusiveReasons(result.confounders).includes("context_event"));
});

// ---- 2. alias spellings find their lift ----------------------------------------------

test("an alias-spelled subject resolves through the exercise ladder instead of 'could not be matched'", () => {
  exercise("Incline Dumbbell Press", "chest");
  session("2026-01-05", "Incline Dumbbell Press", [
    [45, 10],
    [45, 10],
  ]);
  session("2026-01-12", "Incline Dumbbell Press", [
    [45, 10],
    [45, 9],
  ]);
  const change = { day_number: 2, exercise: "Incline DB Press", sets: 2, rep_low: 8, target_weight: 45 };
  const recorded = recordDecision(decision({ action: { changes: [change] } }), [completion("Incline DB Press")]);

  const result = judge(recorded);
  assert.ok(!inconclusiveReasons(result.confounders).includes("subject_unmatched"), result.confounders.join(" | "));
  assert.equal(result.actual.exposures, 2);
  assert.equal(result.verdict, "aligned");
});

test("the lift ledger and the learned step find a verdict filed under an alias spelling", () => {
  assert.equal(sameLiftName("Incline DB Press", "Incline Dumbbell Press"), false, "no catalog row yet");
  exercise("Incline Dumbbell Press", "chest");
  assert.equal(sameLiftName("Incline DB Press", "Incline Dumbbell Press"), true);

  const response = {
    modifiers: [
      { target: "training_progression_step", subject_key: "Incline DB Press", scale: 0.9, key: "k1" },
      { target: "training_progression_step", subject_key: null, scale: 1, key: "k2" },
    ],
  };
  assert.equal(trainingModifierFor("Incline Dumbbell Press", response).scale, 0.9, "the lift's own learning is found");

  for (const [seed, verdict] of [
    [1, "not_aligned"],
    [2, "not_aligned"],
  ]) {
    const recorded = recordDecision(decision({ action: { seed: `ledger-${seed}` } }), [
      completion("Incline DB Press", {
        window_start: `2026-0${seed}-01`,
        window_end: `2026-0${seed}-20`,
      }),
    ]);
    insertBrainEvaluation({
      expectation_id: recorded.expectations[0].id,
      verdict,
      actual: { value: 0 },
      evidence_keys: [`logged_sets:fixture:${seed}`],
      confounders: [],
      explanation: "fixture",
      evaluator_version: "brain-maturity-v1/exercise_completion",
    });
  }
  const ledger = liftLedgerRead("Incline Dumbbell Press");
  assert.equal(ledger.informative, true);
  assert.deepEqual(
    ledger.verdicts.map((v) => v.outcome),
    ["missed", "missed"]
  );
});

// ---- 5. agent-authored est-1RM floors -------------------------------------------------

test("an agent-written est-1RM floor is read under its own spelling", () => {
  session("2026-01-05", "Barbell Overhead Press", [[75, 8]]);
  session("2026-01-12", "Barbell Overhead Press", [[75, 7]]);
  session("2026-01-19", "Barbell Overhead Press", [[70, 6]]);
  const kept = recordDecision(decision({ kind: "case_conference" }), [
    est1rm("Barbell Overhead Press", { direction: "maintain", target: { min_est_1rm_lb: 88 } }),
  ]);
  // Best est-1RM is 75 x 8 → 95: the floor held.
  assert.equal(judge(kept).verdict, "aligned");
});

test("a floor beside a criterion the evaluator cannot check can fail the target but never pass it", () => {
  session("2026-01-05", "Barbell Overhead Press", [[75, 8]]);
  session("2026-01-12", "Barbell Overhead Press", [[75, 7]]);
  session("2026-01-19", "Barbell Overhead Press", [[70, 6]]);
  const pass = recordDecision(decision({ kind: "case_conference" }), [
    est1rm("Barbell Overhead Press", { target: { est_1rm_min: 90, trend_lb_wk_min: 0 } }),
  ]);
  const result = judge(pass);
  assert.equal(result.verdict, "inconclusive");
  assert.ok(inconclusiveReasons(result.confounders).includes("target_uncomparable"));

  const fail = recordDecision(decision({ kind: "case_conference" }), [
    est1rm("Barbell Overhead Press", { target: { est_1rm_min: 120, trend_lb_wk_min: 0 } }),
  ]);
  assert.equal(judge(fail).verdict, "not_aligned", "a missed floor fails the target whatever else it asked");
});

// ---- 6. an evaluator that throws is recorded, not skipped forever ----------------------

function recoveryExpectation(overrides = {}) {
  return {
    metric_key: "recovery_hrv_delta",
    subject_key: null,
    direction: "maintain",
    baseline: { average_ms: 50 },
    target: { tolerance: 5 },
    window_start: "2026-01-01",
    window_end: "2026-01-14",
    minimum_data: { nights: 6 },
    confounder_policy: "exclude_context_events",
    confidence: "tentative",
    evaluator: "recovery_delta",
    evaluator_version: "test-v1",
    ...overrides,
  };
}

test("the recovery evaluator reads real nights instead of throwing on a column that never existed", () => {
  const insert = db.prepare(`INSERT INTO daily_metrics (source, date, hrv_ms) VALUES ('manual', ?, ?)`);
  for (let day = 1; day <= 12; day++) insert.run(`2026-01-${String(day).padStart(2, "0")}`, 50 + (day % 3));
  recordDecision(decision({ kind: "recovery_adjustment", domain: "recovery" }), [recoveryExpectation()]);

  const summary = evaluateMatureExpectations("2026-01-15");
  assert.equal(summary.errors, 0, JSON.stringify(summary.failures));
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.evaluations[0].verdict, "aligned");
});

test("an evaluator failure becomes an inconclusive verdict that names it, and a fixed evaluator reaches it", () => {
  const recorded = recordDecision(decision({ kind: "recovery_adjustment", domain: "recovery" }), [
    recoveryExpectation(),
  ]);
  db.exec(`ALTER TABLE daily_metrics RENAME TO daily_metrics_hidden`);
  let summary;
  try {
    summary = evaluateMatureExpectations("2026-01-15");
  } finally {
    db.exec(`ALTER TABLE daily_metrics_hidden RENAME TO daily_metrics`);
  }
  assert.equal(summary.errors, 1);
  assert.equal(summary.failures[0].expectation_id, recorded.expectations[0].id);
  const stored = latestBrainEvaluation(recorded.expectations[0].id);
  assert.equal(stored.verdict, "inconclusive");
  assert.deepEqual(inconclusiveReasons(stored.confounders), ["evaluator_error"]);
  assert.equal(getBrainExpectation(recorded.expectations[0].id).status, "evaluated");

  // Re-probed like any inconclusive row: once the evaluator can read, it is judged.
  const insert = db.prepare(`INSERT INTO daily_metrics (source, date, hrv_ms) VALUES ('manual', ?, ?)`);
  for (let day = 1; day <= 12; day++) insert.run(`2026-01-${String(day).padStart(2, "0")}`, 50);
  const next = evaluateMatureExpectations("2026-01-15");
  assert.equal(next.errors, 0);
  assert.equal(latestBrainEvaluation(recorded.expectations[0].id).verdict, "aligned");
});

// ---- 7. a never-evaluated expectation is never crowded out ------------------------------

test("finished canceled rows leave the candidate set, and a never-evaluated row goes first", () => {
  // Three canceled rows that already carry their canceled verdict, windows OLDER than
  // the pending one, so the old order (window_end first) would have spent a budget of
  // one on them every night.
  for (let i = 0; i < 3; i++) {
    const recorded = recordDecision(decision({ status: "reverted", reverted_at: "2026-01-02T00:00:00.000Z" }), [
      completion(`Old Lift ${i}`, { window_start: "2025-12-01", window_end: "2025-12-20" }),
    ]);
    evaluateMatureExpectations("2026-01-29");
    assert.equal(getBrainExpectation(recorded.expectations[0].id).status, "canceled");
  }
  session("2026-01-05", "Pendlay Row", [
    [150, 8],
    [150, 8],
  ]);
  session("2026-01-12", "Pendlay Row", [
    [150, 8],
    [150, 8],
  ]);
  const fresh = recordDecision(decision({ action: { changes: [rowChange()] } }), [completion("Pendlay Row")]);

  const summary = evaluateMatureExpectations(AS_OF, { limit: 1 });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.evaluations[0]?.expectation_id, fresh.expectations[0].id);
  assert.equal(summary.evaluations[0].verdict, "aligned");
});

// ---- 8. the pain guard reads where pain is reported now -----------------------------------

function painReport(date, area, text, sessionId = null, createdAt = `${date} 20:00:00`) {
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO training_symptom_events (source_kind, area_text, onset_on, last_reported_on, source_session_id)
       VALUES ('symptom_extraction', ?, ?, ?, ?)`
      )
      .run(area, date, date, sessionId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO symptom_reports (symptom_event_id, session_id, text, source_kind, reported_on, extraction_status, created_at)
     VALUES (?, ?, ?, 'session_note', ?, 'done', ?)`
  ).run(eventId, sessionId, text, date, createdAt);
  return eventId;
}

function painGuard(overrides = {}) {
  return {
    metric_key: "joint_pain_or_soreness",
    subject_key: null,
    direction: "avoid",
    baseline: { pain_sessions: 0, feedback_sessions: 4 },
    target: { max: 0 },
    window_start: "2026-01-01",
    window_end: "2026-01-14",
    minimum_data: { feedback_entries: 2 },
    confounder_policy: "exclude_context_events",
    confidence: "tentative",
    evaluator: "symptom_load",
    evaluator_version: "symptom-load-guard-v1",
    ...overrides,
  };
}

function soreSessions() {
  for (const date of ["2026-01-03", "2026-01-06", "2026-01-09"]) {
    db.prepare(`INSERT INTO sessions (date, kind, soreness, finished_at) VALUES (?, 'strength', 2, ?)`).run(
      date,
      `${date} 18:00:00`
    );
  }
}

test("a stated pain in words fails the guard; the retired feedback box alone used to call it pain-free", () => {
  soreSessions();
  painReport("2026-01-07", "left knee", "My left knee ached after the squats.");
  const recorded = recordDecision(decision(), [painGuard()]);

  const result = judge(recorded, "2026-01-14");
  assert.equal(result.verdict, "not_aligned");
  assert.equal(result.actual.joint_pain_reports, 1);
});

test("an injury overlapping a pain guard never hides the pain it is about", () => {
  soreSessions();
  db.prepare(
    `INSERT INTO context_events (kind, title, start_date, end_date) VALUES ('injury', 'Left knee', '2026-01-07', '2026-01-12')`
  ).run();
  painReport("2026-01-07", "left knee", "Left knee flared.");
  const recorded = recordDecision(decision(), [painGuard()]);
  assert.equal(judge(recorded, "2026-01-14").verdict, "not_aligned");
});

test("a pain-free window passes the guard, and pain stated before the change is not about it", () => {
  soreSessions();
  painReport("2026-01-01", "left knee", "Knee ached this morning.", null, "2026-01-01 08:00:00");
  const recorded = recordDecision(decision(), [painGuard()]);
  const result = judge(recorded, "2026-01-14");
  assert.equal(result.verdict, "aligned");
  assert.equal(result.actual.joint_pain_reports, 0);
});

test("a pain the evaluator cannot place against an area subject can never let the guard pass", () => {
  soreSessions();
  painReport("2026-01-07", "below right lateral", "Unpleasant feeling below my right lateral after Pallof press.");
  const recorded = recordDecision(decision(), [painGuard({ subject_key: "hand_joint" })]);
  const result = judge(recorded, "2026-01-14");
  assert.equal(result.verdict, "inconclusive");
  assert.ok(inconclusiveReasons(result.confounders).includes("unverifiable"));
});

test("an agent-authored pain target a report count cannot measure stays unjudged", () => {
  soreSessions();
  for (const target of [
    { max_level: "mild", flares: 0 },
    { max: 2, unit: "scale_1_to_5" },
  ]) {
    const recorded = recordDecision(decision(), [painGuard({ target })]);
    const result = judge(recorded, "2026-01-14");
    assert.equal(result.verdict, "inconclusive", JSON.stringify(target));
    assert.ok(inconclusiveReasons(result.confounders).includes("target_uncomparable"));
  }
});

test("the guard's baseline counts the same stated pain the guard is judged on", () => {
  db.prepare(`INSERT INTO sessions (date, kind, soreness) VALUES ('2025-12-20', 'strength', 3)`).run();
  painReport("2025-12-22", "left knee", "Left knee was sore.");
  const baseline = sessionFeedbackBaseline("2026-01-01");
  assert.equal(baseline.pain_sessions, 1);
});

// ---- observability ---------------------------------------------------------------------

test("every confounder sentence the evaluators emit classifies to a reason code", () => {
  const cases = {
    "Context event 'Belgrade' overlapped the evaluation window.": "context_event",
    "Decision 27487 also targeted this outcome during the evaluation window.": "overlapping_decision",
    "Only 1 exposures were available; 2 were required.": "thin_sample",
    "At least two comparable loaded exercise exposures are needed.": "thin_sample",
    "The expected exercise could not be matched to a known movement.": "subject_unmatched",
    "The affected movement was not exposed during the evaluation window.": "not_exposed",
    "The expectation requires exposure and none was observed in the window.": "not_exposed",
    "No prescribed running distance was stored to compare against.": "no_prescription",
    "The stored target could not be compared deterministically without guessing.": "target_uncomparable",
    "Logged intake diverged from the live meal plan on most readable days in this window, so the weight response cannot be attributed to the calorie target.":
      "meal_plan_confounded",
    "A comparable follow-up marker draw was not available.": "data_missing",
    "Recovery data did not contain enough comparable nights.": "thin_sample",
    "The evaluator failed on this expectation: boom": "evaluator_error",
  };
  for (const [sentence, code] of Object.entries(cases))
    assert.equal(classifyInconclusiveReason(sentence), code, sentence);
});

test("the diagnostics read breaks inconclusive verdicts down by reason and by metric", () => {
  session("2026-01-05", "Pendlay Row", [
    [145, 10],
    [145, 10],
  ]);
  session("2026-01-12", "Pendlay Row", [
    [145, 10],
    [145, 10],
  ]);
  recordDecision(decision(), [completion("Pendlay Row")]);
  evaluateMatureExpectations(AS_OF);

  const health = getBrainDiagnostics(5).metrics.expectation_health;
  assert.equal(health.inconclusive_reasons.inconclusive, 1);
  assert.equal(health.inconclusive_reasons.by_reason.no_prescription, 1);
  assert.equal(health.inconclusive_reasons.by_metric.exercise_target_completion.no_prescription, 1);
  const metric = health.by_metric.find((row) => row.metric_key === "exercise_target_completion");
  assert.equal(metric.inconclusive_reasons.no_prescription, 1);
  assert.equal(metric.matured_unevaluated, 0);
});
