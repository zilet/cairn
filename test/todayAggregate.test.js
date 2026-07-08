import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { todayAggregate } from "../dist/routes/today.js";
import { repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "logged_sets", "sessions", "plan_items", "plan_days", "exercises",
    "bodyweight_log", "activities", "garmin_activities", "garmin_sources", "profile",
  );
});

test("todayAggregate mirrors the independent Today cold-path reads", () => {
  repo.setProfile({ name: "Milo", weight_lb: 188, primary_discipline: "hybrid" });
  repo.savePlanDay(1, "Lift", "Strength", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  repo.logSetByName({ date: "2026-01-02", day_number: 1, exercise: "Back Squat", weight: 225, reps: 5, rir: 2 });

  const aggregate = todayAggregate("2026-01-02");

  assert.equal(aggregate.date, "2026-01-02");
  assert.deepEqual(aggregate.plan, repo.getPlan());
  assert.deepEqual(aggregate.session, repo.getSessionByDate("2026-01-02"));
  assert.deepEqual(aggregate.stats, repo.getWeeklyStats());
  assert.deepEqual(aggregate.profile, repo.getProfile());
  assert.deepEqual(aggregate.exercises, repo.listExercises());
});
