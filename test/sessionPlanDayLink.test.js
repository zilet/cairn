// A session's plan_day_id is a link to a plan day by id, and a restructure rewrites the
// day's CONTENT under that id. The link must not outlive the content: a squat session
// still linked to a day that is now "Push" anchored the rotation off a day the athlete
// never did. Deterministic, offline, temp DB (see test/run.mjs).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { planDayCandidates, resolveSessionPlanDay } from "../dist/repo/plan-selection.js";

const DATE = "2026-05-12";

beforeEach(() => resetTables("logged_sets", "sessions", "plan_items", "plan_days", "exercises"));

function seedPlan() {
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Barbell Bench Press", muscle_group: "chest", sets: 3, rep_low: 8, rep_high: 12 },
    { exercise: "Front Plank", muscle_group: "core", sets: 2, rep_low: 30, rep_high: 45 },
  ]);
  repo.savePlanDay(3, "Lower", "Lower", [
    { exercise: "Back Squat", muscle_group: "quads", sets: 3, rep_low: 8, rep_high: 10 },
  ]);
}

function linkedSession(dayNumber, lifts) {
  const sess = repo.getOrCreateSession(DATE, repo.getPlanDay(dayNumber).id);
  for (const [name, group] of lifts) {
    const ex = repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, 100, 8, 2)`
    ).run(sess.id, ex.id);
  }
  return db.prepare(`SELECT id, plan_day_id FROM sessions WHERE id = ?`).get(sess.id);
}

test("a link to a day that still matches what was logged stands", () => {
  seedPlan();
  const s = linkedSession(1, [["Barbell Bench Press", "chest"]]);
  assert.deepEqual(resolveSessionPlanDay(s.id, s.plan_day_id, planDayCandidates()), {
    day_number: 1,
    method: "linked",
  });
});

test("a link to a day rewritten since the session resolves by what was actually lifted", () => {
  seedPlan();
  // Squats and a plank, linked to the day that is now Push — the plank alone must not
  // keep the link: core rides along on nearly every day and decides nothing.
  const s = linkedSession(1, [
    ["Back Squat", "quads"],
    ["Hanging Leg Raise", "core"],
  ]);
  assert.deepEqual(resolveSessionPlanDay(s.id, s.plan_day_id, planDayCandidates()), {
    day_number: 3,
    method: "exercise-overlap",
  });
});
