// A reconciled day_read outcome: `trained` stays "strength was done" (the rest-override and
// minutes-drift lessons read it that way); endurance work rides beside it as
// `endurance_trained` / `trained_kind`, so a long run or a race day is not "not trained".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, localDaysAgo, resetTables, seedTrainingDay } from "./_seed.js";

const outcomeOf = (id) => JSON.parse(db.prepare(`SELECT outcome_json FROM suggestions WHERE id = ?`).get(id).outcome_json ?? "null");

beforeEach(() => {
  resetTables("suggestions", "memory", "sessions", "logged_sets", "exercises", "activities", "garmin_activities");
});

function reconcileDay(date) {
  const row = repo.recordSuggestion("day_read", date, { kind: "easy" });
  repo.reconcileSuggestions();
  return outcomeOf(row.id);
}

test("run-only day: strength `trained` stays false, endurance is recorded", () => {
  const date = localDaysAgo(2);
  repo.addActivity({ type: "run", date, duration_min: 110, distance_km: 20 });
  const out = reconcileDay(date);
  assert.equal(out.trained, false);
  assert.equal(out.sets, 0);
  assert.equal(out.endurance_trained, true);
  assert.equal(out.trained_kind, "endurance");
});

test("lift-only day", () => {
  const date = localDaysAgo(2);
  seedTrainingDay(date);
  const out = reconcileDay(date);
  assert.equal(out.trained, true);
  assert.equal(out.endurance_trained, false);
  assert.equal(out.trained_kind, "strength");
});

test("lift and run on one day", () => {
  const date = localDaysAgo(2);
  seedTrainingDay(date);
  repo.addActivity({ type: "run", date, duration_min: 40, distance_km: 6 });
  const out = reconcileDay(date);
  assert.equal(out.trained, true);
  assert.equal(out.endurance_trained, true);
  assert.equal(out.trained_kind, "both");
});

test("a day with nothing logged", () => {
  const out = reconcileDay(localDaysAgo(2));
  assert.equal(out.trained, false);
  assert.equal(out.endurance_trained, false);
  assert.equal(out.trained_kind, "none");
});

test("a run on a rest-read day is never read as lifting through it (no rest-override lesson)", () => {
  for (const back of [2, 3, 4]) {
    const date = localDaysAgo(back);
    repo.addActivity({ type: "run", date, duration_min: 60, distance_km: 10 });
    const row = repo.recordSuggestion("day_read", date, { kind: "rest" });
    assert.ok(row);
  }
  const result = repo.reconcileSuggestions();
  assert.equal(result.learnings, 0);
});
