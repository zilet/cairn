import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  getDailySessionOutcome,
  reconcileDailySession,
  recentMovementResponse,
} from "../dist/repo/daily-reconciliation.js";
import { db, repo, resetTables } from "./_seed.js";

const DATE = "2031-08-05";

beforeEach(() => {
  resetTables(
    "daily_session_outcomes",
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "movement_tolerance_observations",
    "training_symptom_events",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "activities",
    "context_events",
    "plan_items",
    "plan_days",
    "exercises",
    "plan_proposals",
    "recovery_cycles",
    "app_state"
  );
});

function seedPlan() {
  repo.savePlanDay(1, "Lower body", "Quads and hinge", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
  ]);
}

function acceptComposition(items, date = DATE) {
  const session = {
    name: "Lower body",
    focus: "Quads and hinge",
    why: "Fits the plan today.",
    est_minutes: 50,
    items,
  };
  const job = repo.createAgentJob({ kind: "session_compose", input: { date } });
  repo.finishAgentJob(job.id, {
    chosen_agent: "codex",
    result: { ok: true, session, agent: "codex", tried: [{ agent: "codex" }] },
  });
  return repo.prepareDailySession({ date, source: "agent_suggest", agent_job_id: job.id });
}

test("a session with no daily-session composition reconciles to null", () => {
  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  const session = repo.getSessionByDate(DATE);
  const outcome = reconcileDailySession(session.id);
  assert.equal(outcome, null);
});

test("completing the suggested work records a completed, adherence-neutral outcome", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
  ]);
  for (let i = 0; i < 3; i++) {
    repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 230, reps: 5, day_number: null });
    repo.logSetByName({ date: DATE, exercise: "Romanian Deadlift", weight: 185, reps: 8, day_number: null });
  }
  repo.finishSession(prepared.session_id, null);

  const outcome = getDailySessionOutcome(DATE);
  assert.ok(outcome);
  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.facts.completed.sort(), ["Back Squat", "Romanian Deadlift"]);
  assert.equal(outcome.facts.substituted.length, 0);
  assert.equal(outcome.facts.skipped.length, 0);
  assert.ok(outcome.facts.reason_codes.includes("completed_as_suggested"));
  const squat = outcome.facts.progression_evidence.find((p) => p.exercise === "Back Squat");
  assert.equal(squat.verdict, "met_or_exceeded");
  assert.equal(squat.target_sets, 3);
  assert.equal(squat.achieved_sets, 3);
  assert.equal(squat.challenge_verdict, "exceeded");
  assert.equal(outcome.facts.schema_version, 2);
  assert.equal(outcome.facts.dose_context.comparable, true);
  assert.equal(outcome.facts.confidence, "high");
});

test("a substitution explained by travel is not judged as poor adherence", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
  ]);
  repo.addContextEvent({ kind: "trip", title: "Work trip", start_date: DATE, end_date: DATE });
  // Trained something else entirely (a hotel-gym machine).
  repo.logSetByName({ date: DATE, exercise: "Leg Press", weight: 300, reps: 10, day_number: null });
  repo.finishSession(prepared.session_id, null);

  const outcome = getDailySessionOutcome(DATE);
  assert.ok(outcome);
  assert.ok(outcome.facts.substituted.includes("Leg Press"));
  assert.ok(outcome.facts.skipped.includes("Back Squat"));
  assert.ok(outcome.facts.confounders.includes("travel_window"));
  assert.ok(outcome.facts.reason_codes.includes("substituted_movements"));
  assert.ok(outcome.facts.reason_codes.includes("explained_by_context"));
  // Adherence-neutral: no numeric adherence/score field is ever produced.
  assert.ok(!("adherence" in outcome.facts));
  assert.ok(!("score" in outcome.facts));
});

test("reconciliation is idempotent — re-running upserts a single row", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  const first = reconcileDailySession(prepared.session_id);
  const second = reconcileDailySession(prepared.session_id);
  const rows = db
    .prepare(`SELECT COUNT(*) AS n FROM daily_session_outcomes WHERE session_id = ?`)
    .get(prepared.session_id);
  assert.equal(rows.n, 1);
  assert.deepEqual(first.facts.completed, second.facts.completed);
});

test("legacy v1 outcome JSON remains readable", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  const legacyFacts = {
    suggested_count: 1,
    suggested_exercises: ["Back Squat"],
    logged_exercises: [],
    completed: [],
    substituted: [],
    skipped: ["Back Squat"],
    reordered: false,
    achieved: [],
    progression_evidence: [],
    feedback: { soreness: null, performance: null, joint_pain: null },
    confounders: [],
    reason_codes: ["not_started"],
    confidence: "low",
  };
  db.prepare(
    `INSERT INTO daily_session_outcomes
      (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'not_started', ?)`
  ).run(prepared.daily_session.id, prepared.session_id, DATE, JSON.stringify(legacyFacts));

  const outcome = getDailySessionOutcome(DATE);
  assert.equal(outcome.facts.suggested_count, 1);
  assert.equal(outcome.facts.schema_version, undefined, "legacy JSON is read without destructive rewriting");
});

test("reconciliation never mutates the weekly plan or creates a proposal", () => {
  seedPlan();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n;
  const planBefore = db.prepare(`SELECT COUNT(*) AS n FROM plan_items`).get().n;
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  repo.logSetByName({ date: DATE, exercise: "Front Squat", weight: 185, reps: 5, day_number: null });
  repo.finishSession(prepared.session_id, null);
  reconcileDailySession(prepared.session_id);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n, before);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_items`).get().n, planBefore);
});

test("an unstarted accepted session records a not_started, low-confidence outcome", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  const outcome = reconcileDailySession(prepared.session_id);
  assert.ok(outcome);
  assert.equal(outcome.status, "not_started");
  assert.ok(outcome.facts.reason_codes.includes("not_started"));
  assert.equal(outcome.facts.confidence, "low");
});

test("session feedback flows into the reconciliation as a confounder", () => {
  seedPlan();
  acceptComposition([{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 }]);
  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  repo.setSessionFeedback(DATE, { joint_pain: "left knee", soreness: 4 });
  const outcome = getDailySessionOutcome(DATE);
  assert.ok(outcome);
  assert.equal(outcome.facts.feedback.joint_pain, "left knee");
  assert.ok(outcome.facts.confounders.includes("joint_pain"));
  assert.ok(outcome.facts.confounders.includes("high_soreness"));
});

test("active movement-relevant symptom evidence makes the outcome non-comparable without session pain text", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 1, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  const symptom = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: DATE });
  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  repo.finishSession(prepared.session_id, null);

  const outcome = getDailySessionOutcome(DATE);
  const squat = outcome.facts.dose_evidence.find((dose) => dose.exercise === "Back Squat");
  assert.equal(outcome.facts.feedback.joint_pain, null);
  assert.equal(squat.relevant_symptom, true);
  assert.deepEqual(squat.symptom_event_ids, [symptom.id]);
  assert.equal(outcome.facts.dose_context.comparable, false);
  assert.ok(outcome.facts.dose_context.non_comparable_reasons.includes("relevant_symptom"));
});

test("late same-date symptom lifecycle mutations refresh finished outcome history idempotently", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 1, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  repo.finishSession(prepared.session_id, null);
  assert.equal(getDailySessionOutcome(DATE).facts.dose_context.comparable, true);

  const symptom = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: DATE });
  let outcome = getDailySessionOutcome(DATE);
  assert.equal(outcome.facts.dose_context.symptom, true);
  assert.equal(outcome.facts.dose_context.comparable, false);
  assert.deepEqual(outcome.facts.dose_evidence[0].symptom_event_ids, [symptom.id]);

  repo.resolveTrainingSymptom(symptom.id, DATE);
  outcome = getDailySessionOutcome(DATE);
  assert.equal(outcome.facts.dose_context.symptom, false);
  assert.equal(outcome.facts.dose_context.comparable, true);

  const recurred = repo.recurTrainingSymptom(symptom.id, { on: DATE, movement: "Back Squat" });
  outcome = getDailySessionOutcome(DATE);
  assert.equal(outcome.facts.dose_context.symptom, true);
  assert.equal(outcome.facts.dose_context.comparable, false);
  assert.deepEqual(outcome.facts.dose_evidence[0].symptom_event_ids, [recurred.id]);
  repo.recurTrainingSymptom(symptom.id, { on: DATE, movement: "Back Squat" });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM daily_session_outcomes WHERE date = ?`).get(DATE).n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n, 2);
});

test("late manual and Garmin endurance changes refresh an existing same-date outcome", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 1, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  repo.finishSession(prepared.session_id, null);
  assert.equal(getDailySessionOutcome(DATE).facts.dose_context.endurance, false);

  const walk = repo.addActivity({ date: DATE, type: "walk", duration_min: 15, distance_km: 1 });
  const yoga = repo.addActivity({ date: DATE, type: "yoga", duration_min: 30 });
  assert.equal(getDailySessionOutcome(DATE).facts.dose_context.endurance, false, "benign movement is inert");
  repo.deleteActivity(walk.id);
  repo.deleteActivity(yoga.id);

  const manual = repo.addActivity({ date: DATE, type: "run", duration_min: 30, distance_km: 5 });
  assert.equal(getDailySessionOutcome(DATE).facts.dose_context.endurance, true);
  db.prepare(
    `UPDATE daily_session_outcomes SET facts_json = json_set(
       facts_json, '$.dose_context.endurance', json('false'),
       '$.dose_context.comparable', json('true')
     ) WHERE date = ?`
  ).run(DATE);
  repo.updateActivityFields(manual.id, { duration_min: 22 });
  assert.equal(getDailySessionOutcome(DATE).facts.dose_context.endurance, true, "update refreshes stale facts");
  repo.deleteActivity(manual.id);
  assert.equal(getDailySessionOutcome(DATE).facts.dose_context.endurance, false);

  const garmin = repo.upsertGarminActivity({
    external_id: "late-run",
    date: DATE,
    type: "run",
    name: "Late run",
    duration_min: 30,
    distance_km: 5,
  });
  assert.equal(getDailySessionOutcome(DATE).facts.dose_context.endurance, true);
  db.prepare(
    `UPDATE daily_session_outcomes SET facts_json = json_set(
       facts_json, '$.dose_context.endurance', json('false'),
       '$.dose_context.comparable', json('true')
     ) WHERE date = ?`
  ).run(DATE);
  repo.upsertGarminActivity({
    external_id: "late-run",
    date: DATE,
    type: "run",
    duration_min: 31,
    distance_km: 5,
  });
  assert.equal(getDailySessionOutcome(DATE).facts.dose_context.endurance, true, "Garmin upsert refreshes stale facts");
  repo.deleteGarminActivity(garmin.id);
  assert.equal(getDailySessionOutcome(DATE).facts.dose_context.endurance, false);
});

test("late set corrections, deletions, skips, reopen, and finish refresh the full-dose outcome", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Romanian Deadlift", sets: 1, rep_low: 8, rep_high: 10, target_weight: 185 },
  ]);
  const sets = Array.from({ length: 3 }, () =>
    repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null })
  );
  repo.finishSession(prepared.session_id, null);
  let outcome = getDailySessionOutcome(DATE);
  let squat = outcome.facts.dose_evidence.find((dose) => dose.exercise === "Back Squat");
  assert.equal(squat.challenge_verdict, "met");
  assert.equal(squat.achieved.sets_detail.length, 3);

  for (const set of sets) repo.updateSet(set.id, { weight: 200 });
  outcome = getDailySessionOutcome(DATE);
  squat = outcome.facts.dose_evidence.find((dose) => dose.exercise === "Back Squat");
  assert.equal(squat.challenge_verdict, "under_prescribed", "late corrections replace stale dose facts");

  repo.deleteSet(sets[0].id);
  outcome = getDailySessionOutcome(DATE);
  squat = outcome.facts.dose_evidence.find((dose) => dose.exercise === "Back Squat");
  assert.equal(squat.achieved.sets, 2, "delete refreshes achieved set count");

  repo.skipExercise("Romanian Deadlift", DATE);
  assert.ok(getDailySessionOutcome(DATE).facts.skipped.includes("Romanian Deadlift"));
  repo.reopenSession(prepared.session_id);
  assert.equal(getDailySessionOutcome(DATE).status, "in_progress");
  repo.finishSession(prepared.session_id, null);
  assert.equal(getDailySessionOutcome(DATE).status, "completed");
});

test("movement response requires two comparable completed outcomes with the same stable intent", () => {
  seedPlan();
  const dates = ["2031-08-05", "2031-08-07"];
  for (const [index, date] of dates.entries()) {
    const prepared = acceptComposition(
      [{ exercise: "Back Squat", sets: 2, rep_low: 5, rep_high: 5, target_weight: 225 }],
      date
    );
    repo.logSetByName({ date, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
    repo.logSetByName({ date, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
    repo.finishSession(prepared.session_id, null);
    const response = recentMovementResponse("Back Squat", { intent_key: "strength:reps:5-5" });
    assert.equal(response.verdict, index === 0 ? "insufficient" : "earned_absorbed");
    assert.equal(response.comparable_outcomes, index + 1);
  }
});

test("two newer clean outcomes supersede an older conflicting hold in the bounded response window", () => {
  seedPlan();
  const exposures = [
    { date: "2031-07-28", weight: 200 },
    { date: "2031-08-01", weight: 225 },
    { date: "2031-08-05", weight: 225 },
  ];
  for (const exposure of exposures) {
    const prepared = acceptComposition(
      [{ exercise: "Back Squat", sets: 2, rep_low: 5, rep_high: 5, target_weight: 225 }],
      exposure.date
    );
    repo.logSetByName({
      date: exposure.date,
      exercise: "Back Squat",
      weight: exposure.weight,
      reps: 5,
      day_number: null,
    });
    repo.logSetByName({
      date: exposure.date,
      exercise: "Back Squat",
      weight: exposure.weight,
      reps: 5,
      day_number: null,
    });
    repo.finishSession(prepared.session_id, null);
  }

  const response = recentMovementResponse("Back Squat", { intent_key: "strength:reps:5-5" });
  assert.equal(response.verdict, "earned_absorbed");
  assert.equal(response.comparable_outcomes, 2, "only the two newest comparable exposures decide");
  assert.equal(response.considered_outcomes, 3, "older conflicting history remains inspectable");
});
