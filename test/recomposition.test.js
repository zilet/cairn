import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, localDaysAgo, repo, resetTables, seedIntake, seedWeight } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "profile",
    "bodyweight_log",
    "food_notes",
    "nutrition_targets",
    "checkins",
    "fueling_feedback",
    "sessions",
    "logged_sets",
    "exercises",
    "plan_days",
    "plan_items",
    "journey_phases",
    "activities",
    "garmin_activities",
    "daily_metrics",
    "garmin_daily_metrics",
    "app_state",
    "brain_decisions",
    "brain_expectations",
    "brain_evaluations",
  );
  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.55,
    weight_lb: 196,
    start_weight_lb: 205,
    start_date: localDaysAgo(42),
    goal_mode: "lose",
    goal_weight_lb: 180,
  });
  repo.setNutritionTarget(
    { target_kcal: 2_200, protein_g: 175, effective_date: localDaysAgo(30), source: "test" },
    { preserveReviewedKcal: true },
  );
});

function seedOutcomeTrend({ weekly = -2, finalShock = 0 } = {}) {
  for (let daysAgo = 20; daysAgo >= 1; daysAgo--) {
    seedIntake(daysAgo, 2_100, { protein_g: 175 });
    if (daysAgo % 3 === 1 || daysAgo === 20 || daysAgo === 1) {
      const elapsed = 20 - daysAgo;
      const ordinary = 200 + (weekly / 7) * elapsed;
      seedWeight(localDaysAgo(daysAgo), ordinary + (daysAgo === 1 ? finalShock : 0));
    }
  }
}

function seedLiftTrend(name, weights) {
  const exercise = repo.upsertExercise({ name, muscle_group: "chest" });
  const days = [42, 32, 22, 12, 6, 2];
  for (let i = 0; i < days.length; i++) {
    const session = repo.getOrCreateSession(localDaysAgo(days[i]), null);
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir)
       VALUES (?, ?, 1, ?, 5, 2)`
    ).run(session.id, exercise.id, weights[i]);
  }
}

test("fast robust loss plus repeated low energy and several regressing lifts recommends bounded fuel protection", () => {
  seedOutcomeTrend({ weekly: -2.6 });
  seedLiftTrend("Z Recomp Press", [160, 155, 150, 145, 140, 135]);
  seedLiftTrend("Z Recomp Row", [180, 175, 170, 165, 160, 155]);
  repo.addCheckin(localDaysAgo(3), { energy: 2 });
  repo.addCheckin(localDaysAgo(1), { energy: 2 });

  const read = repo.recompositionRead(localDaysAgo(0));
  assert.ok(read.progress.robust_trend_lb_wk < -read.progress.target_rate.high);
  assert.equal(read.muscle.state, "at_risk");
  assert.equal(read.fuel.state, "protect");
  assert.equal(read.action.kind, "protect_fuel");
  assert.equal(read.action.status, "recommended");
  assert.equal(read.action.label, "Next protective adjustment");
  assert.ok(read.action.kcal_delta >= 100 && read.action.kcal_delta <= 250);
  assert.equal(read.action.carb_forward, true);
  assert.equal(read.action.training_directive, "hold_aggression");
  assert.equal(read.action.autonomy, "none");
  assert.equal(read.action.effective_boundary, null);
  assert.match(read.action.line, /bounded|fuel step/i);
  assert.doesNotMatch(`${read.line} ${read.reassurance}`, /RED-S|muscle gain guaranteed/i);
});

test("a recent higher accepted target turns the same risk picture into settling, not another increase", () => {
  seedOutcomeTrend({ weekly: -2.6 });
  seedLiftTrend("Z Settle Press", [160, 155, 150, 145, 140, 135]);
  seedLiftTrend("Z Settle Row", [180, 175, 170, 165, 160, 155]);
  repo.addCheckin(localDaysAgo(3), { energy: 2 });
  repo.addCheckin(localDaysAgo(1), { energy: 2 });
  repo.setNutritionTarget(
    { target_kcal: 2_000, protein_g: 175, effective_date: localDaysAgo(8), source: "manual" },
    { preserveReviewedKcal: true },
  );
  repo.setNutritionTarget(
    { target_kcal: 2_225, protein_g: 175, effective_date: localDaysAgo(0), source: "manual" },
    { preserveReviewedKcal: true },
  );

  const read = repo.recompositionRead(localDaysAgo(0));
  assert.equal(read.action.kind, "settling");
  assert.equal(read.action.status, "settling");
  assert.equal(read.action.label, "Correction settling");
  assert.equal(read.action.kcal_delta, 0);
  assert.equal(read.fuel.state, "settling");
  assert.match(read.action.line, /seven-day settling window/i);
});

test("a first low target is not mistaken for a recent increase and does not block needed fuel protection", () => {
  seedOutcomeTrend({ weekly: -2.6 });
  seedLiftTrend("Z First Target Press", [160, 155, 150, 145, 140, 135]);
  seedLiftTrend("Z First Target Row", [180, 175, 170, 165, 160, 155]);
  repo.addCheckin(localDaysAgo(3), { energy: 2 });
  repo.addCheckin(localDaysAgo(1), { energy: 2 });
  repo.setNutritionTarget(
    { target_kcal: 1_800, protein_g: 175, effective_date: localDaysAgo(0), source: "manual" },
    { preserveReviewedKcal: true },
  );

  const read = repo.recompositionRead(localDaysAgo(0));
  assert.equal(read.action.kind, "protect_fuel");
  assert.equal(read.action.status, "recommended");
  assert.notEqual(read.action.kind, "settling");
});

test("isNearGoal and nearGoal mark the last 2.5 lb, not the whole leaning-out stretch", () => {
  const { isNearGoal, NEAR_GOAL_REMAINING_LB, nearGoal } = repo;
  assert.equal(NEAR_GOAL_REMAINING_LB, 2.5);
  assert.equal(isNearGoal(0), true);
  assert.equal(isNearGoal(1.2), true);
  assert.equal(isNearGoal(2.5), true);
  assert.equal(isNearGoal(2.51), false);
  assert.equal(isNearGoal(8), false);
  assert.equal(isNearGoal(null), false);
  assert.equal(isNearGoal(undefined), false);

  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.55,
    weight_lb: 181.2,
    start_weight_lb: 205,
    start_date: localDaysAgo(42),
    goal_mode: "lose",
    goal_weight_lb: 180,
  });
  assert.equal(nearGoal(localDaysAgo(0)), true, "1.2 lb remaining is near the destination");

  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.55,
    weight_lb: 188,
    start_weight_lb: 205,
    start_date: localDaysAgo(42),
    goal_mode: "lose",
    goal_weight_lb: 180,
  });
  assert.equal(nearGoal(localDaysAgo(0)), false, "8 lb remaining is leaning out, not near goal");

  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.55,
    weight_lb: 180,
    start_weight_lb: 170,
    start_date: localDaysAgo(42),
    goal_mode: "gain",
    goal_weight_lb: 200,
  });
  assert.equal(nearGoal(localDaysAgo(0)), false, "a gain goal +20 lb is never near-goal");

  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.55,
    weight_lb: 180,
    start_weight_lb: 180,
    start_date: localDaysAgo(42),
    goal_mode: "maintain",
    goal_weight_lb: 180,
  });
  assert.equal(nearGoal(localDaysAgo(0)), false, "maintain is never near-goal");

  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.55,
    weight_lb: 181.2,
    start_weight_lb: 205,
    start_date: localDaysAgo(42),
    goal_mode: "lose",
    goal_weight_lb: 180,
  });
  assert.equal(nearGoal(localDaysAgo(0)), true, "lose with remaining 1.2 is near the destination");

  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.55,
    weight_lb: 183,
    start_weight_lb: 205,
    start_date: localDaysAgo(42),
    goal_mode: "lose",
    goal_weight_lb: 180,
  });
  assert.equal(nearGoal(localDaysAgo(0)), false, "lose with remaining 3 is not near goal");

  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.55,
    weight_lb: 180,
    start_weight_lb: 205,
    start_date: localDaysAgo(42),
    goal_mode: "lose",
    goal_weight_lb: null,
  });
  assert.equal(nearGoal(localDaysAgo(0)), false, "a missing goal is never 0-as-near");
});

test("a missing goal stays unknown instead of manufacturing a zero-pound destination or timeline", () => {
  seedOutcomeTrend({ weekly: -0.8 });
  db.prepare(`UPDATE profile SET goal_weight_lb = NULL, goal_bodyfat_pct = NULL`).run();

  const read = repo.recompositionRead(localDaysAgo(0));
  assert.equal(read.stage.kind, "uncertain");
  assert.equal(read.progress.goal_weight_lb, null);
  assert.equal(read.progress.remaining_lb, null);
  assert.equal(read.progress.progress_fraction, null);
  assert.equal(read.progress.timeline, null);
  assert.doesNotMatch(JSON.stringify(read), /toward 0 lb|0 lb remaining/i);
});

test("one scale shock and one regressing lift never trigger a fuel change", () => {
  seedOutcomeTrend({ weekly: -0.8, finalShock: -4 });
  seedLiftTrend("Z Single Signal Press", [160, 158, 156, 154, 152, 150]);

  const read = repo.recompositionRead(localDaysAgo(0));
  assert.equal(read.scale.state, "unconfirmed_shift");
  assert.notEqual(read.action.kind, "protect_fuel");
  assert.equal(read.action.kcal_delta, 0);
  assert.match(read.scale.line, /not treating it as tissue change/i);
});

test("Journey maps the exact canonical day-seven action instead of a parallel settling rule", () => {
  seedOutcomeTrend({ weekly: -2.6 });
  seedLiftTrend("Z Day Seven Press", [160, 155, 150, 145, 140, 135]);
  repo.addCheckin(localDaysAgo(3), { energy: 2 });
  repo.addCheckin(localDaysAgo(1), { energy: 2 });
  repo.setNutritionTarget(
    { target_kcal: 2_350, protein_g: 175, effective_date: localDaysAgo(7), source: "manual" },
    { preserveReviewedKcal: true },
  );

  const canonical = repo.currentUnderfuelingRead(localDaysAgo(0));
  const journey = repo.journeyRead(localDaysAgo(0));
  assert.equal(canonical.state, "persistent_strain", "day seven is outside the settling window");
  assert.equal(journey.underfueling.signature, canonical.signature);
  assert.equal(journey.recomposition.fuel.state, "protect");
  assert.equal(journey.recomposition.action.kcal_delta, canonical.action.kcal_delta);
  assert.equal(journey.recomposition.action.training_directive, canonical.action.training);
});

test("a +75 kcal target does not become Journey settling when the canonical read is not settling", () => {
  seedOutcomeTrend({ weekly: -2.6 });
  seedLiftTrend("Z Small Correction Press", [160, 155, 150, 145, 140, 135]);
  repo.addCheckin(localDaysAgo(3), { energy: 2 });
  repo.addCheckin(localDaysAgo(1), { energy: 2 });
  repo.setNutritionTarget(
    { target_kcal: 2_275, protein_g: 175, effective_date: localDaysAgo(3), source: "manual" },
    { preserveReviewedKcal: true },
  );

  const canonical = repo.currentUnderfuelingRead(localDaysAgo(0));
  const journey = repo.journeyRead(localDaysAgo(0));
  assert.notEqual(canonical.state, "settling");
  assert.equal(journey.underfueling.signature, canonical.signature);
  assert.notEqual(journey.recomposition.fuel.state, "settling");
  assert.equal(journey.recomposition.action.kcal_delta, canonical.action.kcal_delta);
  assert.equal(journey.recomposition.action.training_directive, canonical.action.training);
});
