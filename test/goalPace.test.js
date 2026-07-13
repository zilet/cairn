// goalPace (src/repo/goal-pace.ts) is the deterministic series behind the
// motivational weight-progress chart: the canonical weigh-in points, the recent
// ≤21-day least-squares trend line (with a short forward projection), and the
// straight line to the goal. Constitution-critical: it is null-safe end to end,
// never throws, and carries no scores — just points and two lines.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { LB_PER_KG } from "../dist/repo/shared.js";
import { repo, resetTables, seedWeight, localDaysAgo } from "./_seed.js";

beforeEach(() => {
  resetTables("bodyweight_log", "garmin_daily_metrics", "garmin_sources", "profile");
});

function seedGarminWeight(date, weightLb) {
  const source = repo.upsertGarminSource({ label: "scale" });
  repo.upsertGarminDailyMetric({ date, weight_kg: weightLb / LB_PER_KG }, source.id);
}

test("empty DB → empty points, all-null lines/goal, default window, never throws", () => {
  const gp = repo.goalPace();
  assert.deepEqual(gp.points, []);
  assert.deepEqual(gp.trend, { lb_wk: null, line: null });
  assert.deepEqual(gp.needed, { lb_wk: null, line: null });
  assert.deepEqual(gp.goal, { weight_lb: null, date: null });
  assert.equal(gp.window_days, 90);
});

test("descending weigh-ins → negative trend slope with projected endpoints", () => {
  // 200 → 186 over two weeks: a clear downward trajectory.
  for (let i = 14; i >= 0; i -= 2) seedWeight(localDaysAgo(i), 186 + i);

  const gp = repo.goalPace(90);
  assert.equal(gp.points.length, 8, "one point per seeded weigh-in date");
  assert.ok(gp.trend.lb_wk < 0, "losing weight reads as a negative lb/week slope");

  assert.ok(Array.isArray(gp.trend.line) && gp.trend.line.length === 2);
  const [start, end] = gp.trend.line;
  assert.equal(start.date, localDaysAgo(14), "trend line starts at the first in-window weigh-in");
  assert.equal(end.date, addDaysISO(localDateISO(), 28), "trend line projects ~28 days past today");
  assert.ok(end.weight_lb < start.weight_lb, "the projection continues the downward slope");
  assert.ok(start.weight_lb > 0 && end.weight_lb > 0, "endpoints stay plausible (>0)");
});

test("ascending weigh-ins → positive trend slope", () => {
  for (let i = 14; i >= 0; i -= 2) seedWeight(localDaysAgo(i), 180 + (14 - i) * 0.5);
  const gp = repo.goalPace(90);
  assert.ok(gp.trend.lb_wk > 0, "gaining weight reads as a positive lb/week slope");
});

test("trend is null under a <3-day span even with two points", () => {
  seedWeight(localDaysAgo(1), 181);
  seedWeight(localDaysAgo(0), 180);
  const gp = repo.goalPace(90);
  assert.equal(gp.points.length, 2);
  assert.equal(gp.trend.lb_wk, null, "a slope over <3 days is not trustworthy");
  assert.equal(gp.trend.line, null);
});

test("trend is null with a single point", () => {
  seedWeight(localDaysAgo(0), 180);
  const gp = repo.goalPace(90);
  assert.equal(gp.trend.lb_wk, null);
  assert.equal(gp.trend.line, null);
});

test("manual weigh-in beats Garmin on the same date", () => {
  seedGarminWeight(localDaysAgo(5), 205);
  // Same date: a Garmin scale reading AND an explicit manual entry — manual wins.
  seedGarminWeight(localDaysAgo(0), 200);
  seedWeight(localDaysAgo(0), 180);

  const gp = repo.goalPace(90);
  const today = gp.points.find((p) => p.date === localDaysAgo(0));
  assert.ok(today, "today's date is present in the canonical series");
  assert.equal(today.weight_lb, 180, "the manual entry owns the date over Garmin");
  assert.equal(gp.points.length, 2, "the same-date collision resolves to one point");
});

test("a real loss goal produces a needed line-to-goal with a negative rate", () => {
  const goalDate = addDaysISO(localDateISO(), 70); // 10 weeks out
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 200,
    goal_weight_lb: 180,
    goal_date: goalDate,
    goal_mode: "lose",
    sex: "male",
  });
  seedWeight(localDaysAgo(0), 200); // current canonical weight

  const gp = repo.goalPace(90);
  assert.deepEqual(gp.goal, { weight_lb: 180, date: goalDate });
  assert.ok(gp.needed.lb_wk < 0, "needing to lose reads as a negative required rate");
  assert.ok(Math.abs(gp.needed.lb_wk - -2) < 0.05, "20 lb over ~10 weeks ≈ -2 lb/week");
  assert.ok(Array.isArray(gp.needed.line) && gp.needed.line.length === 2);
  assert.deepEqual(gp.needed.line[0], { date: localDateISO(), weight_lb: 200 });
  assert.deepEqual(gp.needed.line[1], { date: goalDate, weight_lb: 180 });
});

test("no goal → needed nulls (points/trend still populate)", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 185, sex: "male" });
  for (let i = 14; i >= 0; i -= 2) seedWeight(localDaysAgo(i), 186 + i);

  const gp = repo.goalPace(90);
  assert.equal(gp.needed.lb_wk, null);
  assert.equal(gp.needed.line, null);
  assert.deepEqual(gp.goal, { weight_lb: null, date: null });
  assert.ok(gp.points.length > 0, "points still populate without a goal");
  assert.ok(gp.trend.lb_wk != null, "the trend still reads without a goal");
});

test("a past goal date → needed nulls (no backward line)", () => {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 190,
    goal_weight_lb: 175,
    goal_date: localDaysAgo(30),
    goal_mode: "lose",
    sex: "male",
  });
  seedWeight(localDaysAgo(0), 188);

  const gp = repo.goalPace(90);
  assert.equal(gp.needed.lb_wk, null, "a past goal date has no weeks remaining");
  assert.equal(gp.needed.line, null);
  // The goal itself is still echoed for context.
  assert.equal(gp.goal.weight_lb, 175);
  assert.equal(gp.goal.date, localDaysAgo(30));
});

test("needed nulls when there is no current weight to anchor from", () => {
  // A goal exists but there is no weigh-in and no profile weight to resolve.
  repo.setProfile({ age: 40, height_cm: 178, goal_weight_lb: 170, goal_date: addDaysISO(localDateISO(), 60), sex: "male" });
  const gp = repo.goalPace(90);
  assert.equal(gp.needed.lb_wk, null);
  assert.equal(gp.needed.line, null);
});

test("windowDays clamps to 14–365 (and defaults on junk)", () => {
  assert.equal(repo.goalPace(5).window_days, 14, "below the floor clamps up to 14");
  assert.equal(repo.goalPace(50).window_days, 50, "an in-range value is honored");
  assert.equal(repo.goalPace(9999).window_days, 365, "above the ceiling clamps to 365");
  assert.equal(repo.goalPace(Number.NaN).window_days, 14, "non-finite falls back to the floor");
  assert.equal(repo.goalPace().window_days, 90, "default window is 90 days");
});

test("the window bounds which weigh-ins become points", () => {
  seedWeight(localDaysAgo(200), 210); // outside a 90-day window
  seedWeight(localDaysAgo(10), 190); // inside
  seedWeight(localDaysAgo(0), 188); // inside
  const gp = repo.goalPace(90);
  assert.equal(gp.points.length, 2, "only weigh-ins within the window are points");
  assert.ok(!gp.points.some((p) => p.date === localDaysAgo(200)));
});
