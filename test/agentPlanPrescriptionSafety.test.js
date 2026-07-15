import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, localDaysAgo } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "logged_sets",
    "sessions",
    "plan_proposals",
    "plan_items",
    "plan_days",
    "exercises",
    "day_reads",
  );
});

function baseDay() {
  repo.savePlanDay(1, "Full body", "Strength", [
    { exercise: "Goblet Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 40 },
  ]);
}

function proposal(change) {
  return repo.createProposal("stub", "agent plan safety", "", {
    summary: "bounded plan change",
    changes: [change],
  });
}

test("agent ADD removes an unsafe prescribed load from a constrained movement", () => {
  baseDay();
  const bench = repo.upsertExercise({ name: "Safety Bench Press", muscle_group: "chest" });
  repo.updateExercise(bench.id, { constraint_note: "chest irritation — keep the load light and stop on pain" });
  repo.logSetByName({ exercise: "Safety Bench Press", weight: 95, reps: 8, date: localDaysAgo(4) });

  const result = repo.applyProposal(proposal({
    day_number: 1,
    exercise: "Safety Bench Press",
    sets: 2,
    rep_low: 8,
    rep_high: 10,
    target_weight: 315,
  }).id);

  assert.equal(result.ok, true);
  const stored = repo.getPlanDay(1).items.find((item) => item.exercise === "Safety Bench Press");
  assert.equal(stored.target_weight, null, "the constraint remains authoritative");
  assert.equal(result.added[0].target_weight, null, "receipt reflects the stored prescription");
  assert.ok(result.clamped.some((item) =>
    item.exercise === "Safety Bench Press" && item.field === "target_weight" && item.applied === null
  ));
});

test("agent ADD uses only exact-exercise history and caps the requested load", () => {
  baseDay();
  repo.logSetByName({ exercise: "Safety Barbell Row", weight: 100, reps: 8, date: localDaysAgo(5) });

  const result = repo.applyProposal(proposal({
    day_number: 1,
    exercise: "Safety Barbell Row",
    sets: 3,
    rep_low: 8,
    rep_high: 10,
    target_weight: 250,
  }).id);

  assert.equal(result.ok, true);
  const stored = repo.getPlanDay(1).items.find((item) => item.exercise === "Safety Barbell Row");
  assert.equal(stored.target_weight, 110, "100 lb history permits at most the shared 10 lb step");
  assert.equal(result.added[0].target_weight, 110);
  assert.ok(result.clamped.some((item) =>
    item.exercise === "Safety Barbell Row" && item.requested === 250 && item.applied === 110
  ));
});

test("agent ADD with no exact-exercise history does not invent a starting load", () => {
  baseDay();
  // Similar-pattern history is deliberately irrelevant to the new exercise.
  repo.logSetByName({ exercise: "One Arm DB Row", weight: 60, reps: 10, date: localDaysAgo(3) });

  const result = repo.applyProposal(proposal({
    day_number: 1,
    exercise: "Chest Supported Row",
    target_weight: 180,
  }).id);

  assert.equal(result.ok, true);
  const stored = repo.getPlanDay(1).items.find((item) => item.exercise === "Chest Supported Row");
  assert.equal(stored.target_weight, null);
  assert.equal(result.added[0].target_weight, null, "complete receipt mirrors SQLite");
  assert.match(result.clamped.find((item) => item.exercise === "Chest Supported Row").reason, /no exact-exercise working history/i);
});

test("agent SWAP anchors load to the incoming exercise's own history and keeps the full receipt", () => {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Incline DB Press", sets: 2, rep_low: 8, rep_high: 10, target_weight: 40 },
  ]);
  repo.logSetByName({ exercise: "Incline Barbell Press", weight: 100, reps: 8, date: localDaysAgo(6) });

  const result = repo.applyProposal(proposal({
    day_number: 1,
    swap: { from: "Incline DB Press", to: "Incline Barbell Press" },
    sets: 3,
    rep_low: 6,
    rep_high: 8,
    target_weight: 300,
  }).id);

  assert.equal(result.ok, true);
  const receipt = result.applied[0];
  const stored = repo.getPlanDay(1).items[0];
  assert.equal(receipt.action, "swapped");
  assert.deepEqual(
    [stored.exercise, stored.sets, stored.rep_low, stored.rep_high, stored.target_weight],
    ["Incline Barbell Press", 3, 6, 8, 110],
  );
  assert.deepEqual(
    [receipt.exercise, receipt.sets, receipt.rep_low, receipt.rep_high, receipt.target_weight],
    ["Incline Barbell Press", 3, 6, 8, 110],
  );
});

test("agent UPDATE still uses the existing prescription baseline and shared step cap", () => {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Safety Close Grip Bench", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
  ]);
  const result = repo.applyProposal(proposal({
    day_number: 1,
    exercise: "Safety Close Grip Bench",
    target_weight: 250,
  }).id);

  assert.equal(result.ok, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 110);
  assert.equal(result.applied[0].target_weight, 110);
});
