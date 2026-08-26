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

function acceptPlanComposition(items, date = DATE) {
  repo.savePlanDay(1, "Outcome fixture", "Accepted work", items);
  return repo.prepareDailySession({ date, source: "manual_plan", day_number: 1 });
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
  assert.equal(outcome.facts.schema_version, 4, "4 carries per-dose full-load evidence");
  assert.equal(outcome.facts.dose_context.comparable, true);
  const squatDose = outcome.facts.dose_evidence.find((entry) => entry.exercise === "Back Squat");
  assert.equal(squatDose.comparable, true, "a clean day leaves the lift's own exposure comparable");
  assert.deepEqual(squatDose.non_comparable_reasons, []);
  assert.equal(squatDose.full_load_reference.target_weight, 225);
  assert.equal(squatDose.full_load_reference.sets, 3);
  assert.equal(typeof squatDose.performed_at_full_load, "boolean");
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

test("matching planned cardio becomes a completed outcome with exact endurance evidence", () => {
  const prepared = acceptPlanComposition([
    {
      kind: "cardio",
      exercise: "Quality run",
      target_duration_min: 40,
      target_distance_km: 7,
      target_zone: "Z4",
      interval: [{ reps: 4, on: "1 km", off: "2 min", zone: "Z4" }],
    },
  ]);
  repo.upsertGarminActivity({
    external_id: "planned-quality-run",
    date: DATE,
    type: "run",
    name: "Morning intervals",
    duration_min: 42,
    distance_km: 7.2,
    pace: "5:50/km",
    avg_hr: 158,
    hr_zones: [
      { zone: 2, secs: 600 },
      { zone: 4, secs: 1_200 },
    ],
  });

  const outcome = getDailySessionOutcome(DATE);
  assert.equal(outcome.status, "completed", "cardio-only work does not need the strength finish button");
  assert.equal(
    outcome.facts.reason_codes.includes("completed_as_suggested"),
    false,
    "aggregate zones cannot prove prescribed interval structure"
  );
  assert.equal(outcome.facts.confounders.includes("other_activity"), false, "planned cardio is not its own confounder");
  assert.equal(outcome.facts.dose_context.endurance, false);
  assert.equal(outcome.facts.dose_context.comparable, false);
  assert.ok(outcome.facts.dose_context.non_comparable_reasons.includes("endurance_quality_unverified"));
  assert.equal(outcome.facts.endurance_evidence.length, 1);
  const evidence = outcome.facts.endurance_evidence[0];
  assert.equal(evidence.composition_item_key, `composition:${prepared.daily_session.id}:item:0`);
  assert.equal(evidence.intent_key, "endurance:run:quality run");
  assert.deepEqual(evidence.prescribed, {
    sport: "run",
    label: "Quality run",
    duration_min: 40,
    distance_km: 7,
    target_zone: "Z4",
    interval_text: '[{"off":"2 min","on":"1 km","reps":4,"zone":"Z4"}]',
  });
  assert.deepEqual(evidence.achieved, {
    sport: "run",
    type: "run",
    name: "Morning intervals",
    duration_min: 42,
    distance_km: 7.2,
    pace: "5:50/km",
    avg_hr: 158,
    observed_zone_summary: [
      { zone: "Z2", seconds: 600 },
      { zone: "Z4", seconds: 1_200 },
    ],
    source: "garmin",
  });
  assert.equal(evidence.match_confidence, "high");
  assert.deepEqual(evidence.match_provenance, ["same_date", "canonical_sport:run", "activity_source:garmin"]);
  assert.equal(evidence.zone_verdict, "observed");
  assert.equal(evidence.completion_verdict, "quality_unverified");
});

test("a matched cardio duration or distance shortfall is factual partial evidence", () => {
  acceptPlanComposition([
    {
      kind: "cardio",
      exercise: "Long ride",
      target_duration_min: 90,
      target_distance_km: 35,
      target_zone: "Z2",
    },
  ]);
  repo.addActivity({ date: DATE, type: "ride", duration_min: 55, distance_km: 22 });

  const outcome = getDailySessionOutcome(DATE);
  const evidence = outcome.facts.endurance_evidence[0];
  assert.equal(outcome.status, "completed");
  assert.equal(evidence.completion_verdict, "dose_shortfall");
  assert.equal(evidence.zone_verdict, "unknown", "a prescribed zone is not compared without observed zones");
  assert.equal(evidence.achieved.observed_zone_summary, null);
  assert.equal(outcome.facts.dose_context.partial, true);
  assert.equal(outcome.facts.dose_context.comparable, false);
  assert.equal(outcome.facts.reason_codes.includes("partial_session"), true);
  assert.equal("adherence" in outcome.facts, false);
});

test("same-duration easy zones contradict a prescribed Z4 interval without blocking cardio completion", () => {
  acceptPlanComposition([
    {
      kind: "cardio",
      exercise: "Run intervals",
      target_duration_min: 40,
      target_zone: "Z4",
      interval: [{ reps: 5, on: "3 min", off: "2 min", zone: "Z4" }],
    },
  ]);
  repo.upsertGarminActivity({
    external_id: "easy-instead-of-quality",
    date: DATE,
    type: "run",
    name: "Easy run",
    duration_min: 40,
    distance_km: 6,
    hr_zones: [{ zone: 2, secs: 2_400 }],
  });

  const outcome = getDailySessionOutcome(DATE);
  const evidence = outcome.facts.endurance_evidence[0];
  assert.equal(outcome.status, "completed", "the actual effort still happened");
  assert.equal(evidence.zone_verdict, "not_observed");
  assert.equal(evidence.completion_verdict, "quality_not_observed");
  assert.equal(outcome.facts.reason_codes.includes("completed_as_suggested"), false);
  assert.ok(outcome.facts.reason_codes.includes("endurance_quality_not_observed"));
  assert.ok(outcome.facts.dose_context.non_comparable_reasons.includes("endurance_quality_not_observed"));
});

test("a prescribed zone with no observed zones remains quality-unverified", () => {
  acceptPlanComposition([
    { kind: "cardio", exercise: "Tempo run", target_duration_min: 35, target_zone: "Z3" },
  ]);
  repo.addActivity({ date: DATE, type: "run", duration_min: 35, distance_km: 6 });

  const outcome = getDailySessionOutcome(DATE);
  const evidence = outcome.facts.endurance_evidence[0];
  assert.equal(outcome.status, "completed");
  assert.equal(evidence.zone_verdict, "unknown");
  assert.equal(evidence.completion_verdict, "quality_unverified");
  assert.equal(outcome.facts.reason_codes.includes("completed_as_suggested"), false);
  assert.ok(outcome.facts.reason_codes.includes("endurance_quality_unverified"));
});

test("simple dose-only cardio can complete as suggested without invented quality evidence", () => {
  acceptPlanComposition([
    { kind: "cardio", exercise: "Easy run", target_duration_min: 30, target_distance_km: 5 },
  ]);
  repo.addActivity({ date: DATE, type: "run", duration_min: 31, distance_km: 5.1 });

  const outcome = getDailySessionOutcome(DATE);
  const evidence = outcome.facts.endurance_evidence[0];
  assert.equal(outcome.status, "completed");
  assert.equal(evidence.zone_verdict, "unknown");
  assert.equal(evidence.completion_verdict, "met_or_exceeded");
  assert.equal(outcome.facts.reason_codes.includes("completed_as_suggested"), true);
  assert.equal(outcome.facts.dose_context.comparable, true);
});

test("a non-interval target zone is observed only when it dominates the recorded effort", () => {
  acceptPlanComposition([
    { kind: "cardio", exercise: "Threshold run", target_duration_min: 30, target_zone: "Z4" },
  ]);
  repo.upsertGarminActivity({
    external_id: "observed-threshold",
    date: DATE,
    type: "run",
    name: "Threshold run",
    duration_min: 30,
    distance_km: 5,
    hr_zones: [
      { zone: 2, secs: 300 },
      { zone: 4, secs: 1_500 },
    ],
  });

  const outcome = getDailySessionOutcome(DATE);
  assert.equal(outcome.facts.endurance_evidence[0].completion_verdict, "quality_observed");
  assert.ok(outcome.facts.reason_codes.includes("completed_as_suggested"));
  assert.ok(outcome.facts.reason_codes.includes("endurance_quality_observed"));
  assert.equal(outcome.facts.dose_context.comparable, true);
});

test("wrong-modality and unmatched cardio do not falsely complete", () => {
  acceptPlanComposition([
    { kind: "cardio", exercise: "Easy run", target_duration_min: 30, target_zone: "Z2" },
  ]);
  repo.addActivity({ date: DATE, type: "ride", duration_min: 30, distance_km: 10 });

  const outcome = getDailySessionOutcome(DATE);
  assert.equal(outcome.status, "not_started");
  assert.equal(outcome.facts.endurance_evidence[0].completion_verdict, "unmatched");
  assert.equal(outcome.facts.endurance_evidence[0].achieved, null);
  assert.equal(outcome.facts.confidence, "low");
  assert.equal(outcome.facts.confounders.includes("other_activity"), true);
});

test("one actual endurance effort can satisfy at most one accepted cardio item", () => {
  acceptPlanComposition([
    { kind: "cardio", exercise: "Easy run", target_duration_min: 30, target_zone: "Z2" },
    { kind: "cardio", exercise: "Long run", target_duration_min: 60, target_zone: "Z2" },
  ]);
  repo.addActivity({ date: DATE, type: "run", duration_min: 58, distance_km: 9 });

  const outcome = getDailySessionOutcome(DATE);
  assert.equal(
    outcome.facts.endurance_evidence.filter((entry) => entry.completion_verdict === "unmatched").length,
    1,
    "one of the two accepted items remains unmatched"
  );
  assert.equal(outcome.facts.endurance_evidence.filter((entry) => entry.achieved != null).length, 1);
});

test("generic planned cardio matches conservatively at lower confidence", () => {
  acceptPlanComposition([
    { kind: "cardio", exercise: "Easy cardio", target_duration_min: 25 },
  ]);
  repo.addActivity({ date: DATE, type: "row", duration_min: 25 });

  const evidence = getDailySessionOutcome(DATE).facts.endurance_evidence[0];
  assert.equal(evidence.prescribed.sport, null);
  assert.equal(evidence.achieved.sport, "row");
  assert.equal(evidence.match_confidence, "low");
  assert.ok(evidence.match_provenance.includes("generic_cardio"));
});

test("mixed strength and cardio keeps finish semantics and carries planned endurance as context", () => {
  const prepared = acceptPlanComposition([
    { exercise: "Back Squat", sets: 1, rep_low: 5, rep_high: 5, target_weight: 225 },
    { kind: "cardio", exercise: "Easy run", target_duration_min: 30, target_zone: "Z2" },
  ]);
  repo.addActivity({ date: DATE, type: "run", duration_min: 30, distance_km: 5 });
  let outcome = getDailySessionOutcome(DATE);
  assert.equal(outcome.status, "in_progress", "matched cardio cannot finish the mixed strength session");

  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  outcome = getDailySessionOutcome(DATE);
  assert.equal(outcome.status, "in_progress");
  repo.finishSession(prepared.session_id, null);
  outcome = getDailySessionOutcome(DATE);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.facts.endurance_evidence[0].completion_verdict, "quality_unverified");
  assert.equal(outcome.facts.confounders.includes("other_activity"), false);
  assert.equal(outcome.facts.dose_context.endurance, true, "planned endurance still bounds strength learning");
  assert.equal(outcome.facts.dose_context.comparable, false);
  assert.ok(outcome.facts.dose_context.non_comparable_reasons.includes("loaded_endurance"));
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

// A symptom that has gone quiet is context, not a brake. Before this, the ladder
// ended at stale_needs_recheck FOREVER, so one old note held every later outcome
// out of the comparable set and no verdict could ever be reached again.
test("a symptom that has gone stale stops gating comparability but stays visible", () => {
  seedPlan();
  const symptom = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2031-07-01" });

  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 1, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  repo.finishSession(prepared.session_id, null);

  const outcome = getDailySessionOutcome(DATE);
  const squat = outcome.facts.dose_evidence.find((dose) => dose.exercise === "Back Squat");
  // The watch itself is LIVE — they squatted today, and quiet training is what keeps
  // a note from dying of neglect now. What has gone quiet is their own account, and
  // that is what decides whether it holds an outcome out of the comparable set.
  assert.equal(repo.getTrainingSymptom(symptom.id, DATE).freshness, "acute_movement_brake");
  assert.equal(repo.getTrainingSymptom(symptom.id, DATE).stated_freshness, "stale_needs_recheck");
  assert.equal(repo.getTrainingSymptom(symptom.id, DATE).last_stated_on, "2031-07-01");
  assert.equal(repo.getTrainingSymptom(symptom.id, DATE).status, "active", "it is never auto-resolved");
  assert.deepEqual(squat.symptom_event_ids, [symptom.id], "still attached as context");
  assert.equal(squat.relevant_symptom, false, "but no longer a brake");
  assert.ok(!outcome.facts.dose_context.non_comparable_reasons.includes("relevant_symptom"));
});

test("an unconfirmed legacy import never makes an outcome non-comparable", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 1, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  db.prepare(`UPDATE sessions SET joint_pain = NULL WHERE date = ?`).run(DATE);
  db.prepare(`INSERT INTO sessions (date, joint_pain) VALUES ('2031-08-04', 'left knee')`).run();
  repo.seedLegacyTrainingSymptoms();
  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  repo.finishSession(prepared.session_id, null);

  const outcome = getDailySessionOutcome(DATE);
  const squat = outcome.facts.dose_evidence.find((dose) => dose.exercise === "Back Squat");
  assert.equal(squat.symptom_event_ids.length, 1, "the imported note is still visible context");
  assert.equal(squat.relevant_symptom, false, "nobody has confirmed it, so it cannot brake");
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

// What the session actually PRESCRIBES for a lift, which is not always the number
// the agent proposed: an exposure that capped the rep range earns a load step, so
// the next composition asks for more. A fixture that re-logs the old weight would
// be logging a genuine shortfall, not a repeat exposure.
function prescribedWeight(prepared, exercise) {
  const item = (prepared.daily_session?.items || []).find((entry) => entry.exercise === exercise);
  return item?.target_weight ?? null;
}

test("movement response requires two comparable completed outcomes with the same stable intent", () => {
  seedPlan();
  const dates = ["2031-08-05", "2031-08-07"];
  for (const [index, date] of dates.entries()) {
    const prepared = acceptComposition(
      [{ exercise: "Back Squat", sets: 2, rep_low: 5, rep_high: 5, target_weight: 225 }],
      date
    );
    const weight = prescribedWeight(prepared, "Back Squat");
    repo.logSetByName({ date, exercise: "Back Squat", weight, reps: 5, day_number: null });
    repo.logSetByName({ date, exercise: "Back Squat", weight, reps: 5, day_number: null });
    repo.finishSession(prepared.session_id, null);
    const response = recentMovementResponse("Back Squat", { intent_key: "strength:reps:5-5" });
    assert.equal(response.verdict, index === 0 ? "insufficient" : "earned_absorbed");
    assert.equal(response.comparable_outcomes, index + 1);
  }
});

test("two newer clean outcomes supersede an older conflicting hold in the bounded response window", () => {
  seedPlan();
  // The oldest exposure lands 25 lb under what was asked (the conflicting hold);
  // the two newest meet whatever the day prescribes.
  const exposures = [
    { date: "2031-07-28", short: 25 },
    { date: "2031-08-01", short: 0 },
    { date: "2031-08-05", short: 0 },
  ];
  for (const exposure of exposures) {
    const prepared = acceptComposition(
      [{ exercise: "Back Squat", sets: 2, rep_low: 5, rep_high: 5, target_weight: 225 }],
      exposure.date
    );
    const weight = prescribedWeight(prepared, "Back Squat") - exposure.short;
    repo.logSetByName({ date: exposure.date, exercise: "Back Squat", weight, reps: 5, day_number: null });
    repo.logSetByName({ date: exposure.date, exercise: "Back Squat", weight, reps: 5, day_number: null });
    repo.finishSession(prepared.session_id, null);
  }

  const response = recentMovementResponse("Back Squat", { intent_key: "strength:reps:5-5" });
  assert.equal(response.verdict, "earned_absorbed");
  assert.equal(response.comparable_outcomes, 2, "only the two newest comparable exposures decide");
  assert.equal(response.considered_outcomes, 3, "older conflicting history remains inspectable");
});

function insertCompletedDoseOutcome({ date, movementKey, intentKey, challengeVerdict }) {
  const sessionId = Number(db.prepare(`INSERT INTO sessions (date, kind) VALUES (?, 'strength')`).run(date).lastInsertRowid);
  const compositionId = Number(
    db
      .prepare(
        `INSERT INTO daily_session_compositions
          (version, session_id, date, source, status, title, items_json, request_fingerprint)
         VALUES (1, ?, ?, 'manual_plan', 'active', 'Response fixture', '[]', ?)`
      )
      .run(sessionId, date, `response-fixture-${date}`).lastInsertRowid
  );
  const facts = {
    schema_version: 2,
    confidence: "high",
    dose_context: { comparable: true },
    dose_evidence: [{ movement_key: movementKey, intent_key: intentKey, challenge_verdict: challengeVerdict }],
  };
  db.prepare(
    `INSERT INTO daily_session_outcomes
      (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'completed', ?)`
  ).run(compositionId, sessionId, date, JSON.stringify(facts));
}

test("movement response finds sparse matching exposures beyond unrelated recent outcomes", () => {
  seedPlan();
  const squatKey = `exercise:${repo.findExercise("Back Squat").id}`;
  const intentKey = "strength:reps:5-5";
  insertCompletedDoseOutcome({ date: "2031-07-01", movementKey: squatKey, intentKey, challengeVerdict: "met" });
  insertCompletedDoseOutcome({ date: "2031-07-02", movementKey: squatKey, intentKey, challengeVerdict: "met" });
  for (let day = 3; day <= 11; day++) {
    insertCompletedDoseOutcome({
      date: `2031-07-${String(day).padStart(2, "0")}`,
      movementKey: `movement:unrelated-${day}`,
      intentKey,
      challengeVerdict: "met",
    });
  }

  const response = recentMovementResponse("Back Squat", { intent_key: intentKey });
  assert.equal(response.verdict, "earned_absorbed");
  assert.equal(response.comparable_outcomes, 2);
  assert.equal(response.considered_outcomes, 2);
});

test("newer matching contradictory outcomes supersede older positive movement evidence", () => {
  seedPlan();
  const squatKey = `exercise:${repo.findExercise("Back Squat").id}`;
  const intentKey = "strength:reps:5-5";
  insertCompletedDoseOutcome({ date: "2031-07-01", movementKey: squatKey, intentKey, challengeVerdict: "met" });
  insertCompletedDoseOutcome({ date: "2031-07-02", movementKey: squatKey, intentKey, challengeVerdict: "met" });
  for (let day = 3; day <= 11; day++) {
    insertCompletedDoseOutcome({
      date: `2031-07-${String(day).padStart(2, "0")}`,
      movementKey: `movement:unrelated-${day}`,
      intentKey,
      challengeVerdict: "met",
    });
  }
  insertCompletedDoseOutcome({ date: "2031-07-12", movementKey: squatKey, intentKey, challengeVerdict: "under_prescribed" });
  insertCompletedDoseOutcome({ date: "2031-07-13", movementKey: squatKey, intentKey, challengeVerdict: "under_prescribed" });

  const response = recentMovementResponse("Back Squat", { intent_key: intentKey });
  assert.equal(response.verdict, "earned_hold");
  assert.equal(response.comparable_outcomes, 2, "only the two newest matching exposures decide");
  assert.equal(response.considered_outcomes, 4, "older matching evidence remains inspectable");
});
