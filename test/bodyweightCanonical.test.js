import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { canonicalBodyweightSeries } from "../dist/repo/bodyweight.js";
import { LB_PER_KG } from "../dist/repo/shared.js";
import { repo, resetTables, seedIntake, localDaysAgo } from "./_seed.js";

beforeEach(() => {
  resetTables("food_notes", "bodyweight_log", "garmin_daily_metrics", "garmin_sources", "profile");
});

function seedGarminWeights(points) {
  const source = repo.upsertGarminSource({ label: "scale" });
  for (const [date, weightLb] of points) {
    repo.upsertGarminDailyMetric({ date, weight_kg: weightLb / LB_PER_KG }, source.id);
  }
}

test("Garmin-only scale history drives the shared expenditure and goal trend", () => {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 200,
    goal_weight_lb: 170,
    goal_mode: "lose",
    sex: "male",
    activity_factor: 1.5,
  });
  for (let i = 1; i <= 7; i++) seedIntake(i, 2_400);
  seedGarminWeights([
    [localDaysAgo(7), 182],
    [localDaysAgo(4), 181],
    [localDaysAgo(1), 180],
  ]);

  const expenditure = repo.estimateExpenditure(21);
  assert.equal(expenditure.coverage.weigh_in_days, 3);
  assert.ok(expenditure.trend_lb_wk < 0);
  assert.ok(expenditure.outcome_tdee > expenditure.intake_avg_kcal);
  assert.ok(
    expenditure.anchors
      .find((anchor) => anchor.kind === "outcome")
      ?.provenance.includes("garmin_daily_metrics.weight_kg")
  );

  const goal = repo.computeGoalCheck();
  assert.equal(goal.lbs_to_lose, 10, "goal distance uses the fresh Garmin weight, not the stale profile value");
  assert.equal(goal.recommended.protein_g, 180);
  assert.equal(goal.trend_lb_wk, expenditure.trend_lb_wk);
});

test("same-date manual and Garmin weights resolve to one point with manual provenance", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 190, sex: "male", activity_factor: 1.5 });
  seedGarminWeights([
    [localDaysAgo(7), 184],
    [localDaysAgo(1), 181],
  ]);
  const manual = repo.logWeight(180, localDaysAgo(1), "manual correction");

  const series = canonicalBodyweightSeries({ since: localDaysAgo(7), through: localDaysAgo(1) });
  assert.equal(series.length, 2, "same-date sources never become two trend points");
  assert.deepEqual(series.at(-1), {
    date: localDaysAgo(1),
    weight_lb: 180,
    source: "manual",
    source_id: manual.id,
    provenance: "bodyweight_log.weight_lb",
  });
  assert.equal(repo.estimateExpenditure(21).coverage.weigh_in_days, 2);
  assert.deepEqual(repo.listWeight(), [manual], "public manual weight history remains unchanged");
});

test("fresh canonical weight replaces stale profile weight in goal and weekly pace calculations", () => {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 200,
    goal_weight_lb: 180,
    goal_date: localDaysAgo(-70),
    goal_mode: "lose",
    sex: "male",
    activity_factor: 1.5,
  });
  seedGarminWeights([[localDaysAgo(0), 190]]);

  const goal = repo.computeGoalCheck();
  assert.equal(goal.lbs_to_lose, 10);
  assert.equal(goal.recommended.protein_g, 190);
  assert.equal(repo.getProfile().weight_lb, 200, "calculation resolution never writes Garmin weight into profile");
  assert.deepEqual(repo.listWeight(), [], "calculation resolution never creates a manual weigh-in");

  const weekly = repo.getWeeklyStats();
  assert.equal(weekly.weight_lb, 190);
  assert.equal(weekly.goal_mode, "lose");
  assert.ok(weekly.needed_lb_wk < 0, "pace feasibility is based on the canonical current weight");
});
