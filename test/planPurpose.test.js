// The plan day's PURPOSE (GET /plan, getPlanWithPurpose → plan-day-purpose.ts): a
// fragment specific to THE DAY — what leads it and what follows, its role in the week,
// the block phase — never one shared sentence printed on every card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { planDayPurposeLine } from "../dist/repo/plan-day-purpose.js";

const TUESDAY = "2026-04-21";
const THURSDAY = "2026-04-23";
const NEXT_TUESDAY = "2026-04-28";

function seedPlan() {
  repo.savePlanDay(1, "Push", "Chest, shoulders & triceps", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
    { exercise: "Overhead Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 85 },
    { exercise: "Triceps Pushdown", sets: 3, rep_low: 10, rep_high: 12, target_weight: 50 },
  ]);
  repo.savePlanDay(2, "Lower A", "Squat and hinge", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 },
    { exercise: "Leg Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 90 },
  ]);
  repo.savePlanDay(3, "Pull", "Back and biceps", [
    { exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 },
    { exercise: "Lat Pulldown", sets: 3, rep_low: 10, rep_high: 12, target_weight: 120 },
    { exercise: "Biceps Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 30 },
  ]);
}

test("each plan day's purpose names its own lead and differs from the others", () => {
  seedPlan();
  const plan = repo.getPlanWithPurpose(TUESDAY);
  const byName = Object.fromEntries(plan.map((d) => [d.name, d.purpose]));
  for (const [name, purpose] of Object.entries(byName)) {
    assert.equal(typeof purpose, "string", `${name} carries a purpose`);
    assert.ok(purpose.length > 10);
  }
  assert.match(byName.Push, /Bench Press/);
  assert.match(byName["Lower A"], /Back Squat/);
  assert.match(byName.Pull, /Barbell Row/);
  assert.equal(new Set(Object.values(byName)).size, 3, "no two days share one sentence");
  assert.doesNotMatch(Object.values(byName).join(" "), /\d+\s*\/\s*100|score/i, "no score");
});

test("the heavy-leg day says so; an upper day does not", () => {
  seedPlan();
  const plan = repo.getPlanWithPurpose(TUESDAY);
  const lower = plan.find((d) => d.name === "Lower A").purpose;
  const push = plan.find((d) => d.name === "Push").purpose;
  assert.match(lower, /leg day|lower-body day|legs carry/);
  assert.doesNotMatch(push, /leg day|lower-body day|legs carry/);
});

test("a day's purpose is stable through its week and rotates with the next week only", () => {
  seedPlan();
  const tue = repo.getPlanWithPurpose(TUESDAY).map((d) => d.purpose);
  assert.deepEqual(
    repo.getPlanWithPurpose(TUESDAY).map((d) => d.purpose),
    tue,
    "same read, same words"
  );
  assert.deepEqual(
    repo.getPlanWithPurpose(THURSDAY).map((d) => d.purpose),
    tue,
    "the same week, the same words"
  );
  const next = repo.getPlanWithPurpose(NEXT_TUESDAY).map((d) => d.purpose);
  assert.equal(next.length, tue.length);
  // Each still names its own lead next week.
  assert.match(next[0], /Bench Press/);
});

test("the block phase speaks through the purpose, and a day with no lifting has none", () => {
  const day = {
    id: 7,
    day_number: 1,
    items: [
      { exercise: "Bench Press", muscle_group: "chest" },
      { exercise: "Lateral Raise", muscle_group: "shoulders" },
    ],
  };
  const accumulation = planDayPurposeLine(day, TUESDAY, "accumulation");
  const intensification = planDayPurposeLine(day, TUESDAY, "intensification");
  const deload = planDayPurposeLine(day, TUESDAY, "deload");
  assert.match(accumulation, /volume|base|builds/);
  assert.match(intensification, /sharpen|intensif|heavier|every rep/);
  assert.match(deload, /lighter|easy pass|resets/);
  assert.match(planDayPurposeLine(day, TUESDAY, null), /^Bench Press|Bench Press/);
  assert.doesNotMatch(planDayPurposeLine(day, TUESDAY, null), / — /, "no phase, no phase clause");
  assert.equal(planDayPurposeLine({ id: 8, items: [] }, TUESDAY, "accumulation"), null);
  assert.equal(
    planDayPurposeLine(
      { id: 9, items: [{ exercise: "Hip 90/90", muscle_group: "mobility", mode: "mobility" }] },
      TUESDAY,
      null
    ),
    null,
    "prep alone is no purpose"
  );
});

test("GET /plan's shape is unchanged: every day keeps its fields plus purpose and out_of_order", () => {
  seedPlan();
  const plain = repo.getPlan();
  const withPurpose = repo.getPlanWithPurpose(TUESDAY);
  assert.equal(withPurpose.length, plain.length);
  for (let i = 0; i < plain.length; i++) {
    assert.equal(withPurpose[i].name, plain[i].name);
    assert.ok(Object.hasOwn(withPurpose[i], "purpose"));
    assert.ok(Object.hasOwn(withPurpose[i], "out_of_order"));
  }
});
