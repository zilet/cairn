// The first target for a variant entering the plan, from its movement unit
// (src/repo/variant-start.ts, wired into plan.ts's swap/append grounding). Invariants:
//   1. no history of its own: a current sibling's working load x the table ratio x
//      NEW_VARIANT_START_FACTOR, rounded DOWN to the lift's step;
//   2. stale history and a LEARNED ratio: the lower of its old number and the unit start;
//      current history keeps its own number;
//   3. no ratio: today's behaviour (no stored number);
//   4. a typed load is never overwritten; assisted and timed work keep today's behaviour;
//   5. the slot is a new prescription, untested until lifted.
// Synthetic fixtures through the repo's writers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { enteringVariantStart, NEW_VARIANT_START_FACTOR, unitStartingLoad } from "../dist/repo/variant-start.js";
import { addExerciseToPlanDay, applyPlanChange } from "../dist/repo/plan.js";
import { buildAndApplySwap } from "../dist/repo/plan-swap.js";
import { nextPrescription } from "../dist/repo/progression.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const today = () => localDateISO();
const day = (delta) => addDaysISO(today(), delta);

function session(exercise, daysAgo, weight, reps = [5, 5, 5]) {
  for (const r of reps) repo.logSetByName({ exercise, weight, reps: r, date: day(-daysAgo) });
}

function benchPlan() {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.replacePlan([
    {
      day_number: 1,
      name: "Upper",
      items: [
        {
          exercise: "Barbell Bench Press",
          muscle_group: "chest",
          sets: 3,
          rep_low: 5,
          rep_high: 8,
          target_weight: 200,
        },
      ],
    },
  ]);
  for (const d of [21, 14, 7]) session("Barbell Bench Press", d, 200);
}

test("no history of its own: the table ratio under the caution factor, rounded down to the step", () => {
  benchPlan();
  const start = unitStartingLoad("DB Bench Press", "chest");
  // 200 x 0.4 x 0.9 = 72, rounded down to the dumbbell's 5 lb step.
  assert.equal(NEW_VARIANT_START_FACTOR, 0.9);
  assert.deepEqual(start, { weight: 70, source: "Barbell Bench Press", basis: "table" });
});

test("a swap stores that start, says where it came from, and leaves the slot untested", () => {
  benchPlan();
  db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(day(-60));
  const out = buildAndApplySwap(1, "Barbell Bench Press", "DB Bench Press");
  assert.equal(out.ok, true, JSON.stringify(out));
  const slot = repo.getPlan()[0].items[0];
  assert.equal(slot.exercise, "DB Bench Press");
  assert.equal(slot.target_weight, 70);
  assert.match(slot.note, /Barbell Bench Press/);
  assert.doesNotMatch(slot.note, /start light/);
  const p = nextPrescription("DB Bench Press");
  assert.equal(p?.suggested?.weight ?? p?.current?.weight, 70, "the card holds the stored start");
});

test("a load the person typed is never overwritten", () => {
  benchPlan();
  applyPlanChange({ day_number: 1, swap: { from: "Barbell Bench Press", to: "DB Bench Press" }, target_weight: 95 });
  assert.equal(repo.getPlan()[0].items[0].target_weight, 95);
});

test("no ratio on record keeps today's behaviour: nothing stored", () => {
  benchPlan();
  // A machine press is in the flat-press unit but has no table edge, and no shared log.
  assert.equal(unitStartingLoad("Machine Chest Press", "chest"), null);
  buildAndApplySwap(1, "Barbell Bench Press", "Machine Chest Press");
  assert.equal(repo.getPlan()[0].items[0].target_weight, null);
});

test("a sibling not trained lately transfers nothing", () => {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  for (const d of [120, 113, 106]) session("Barbell Bench Press", d, 200);
  assert.equal(unitStartingLoad("DB Bench Press", "chest"), null);
});

test("stale history with a learned ratio starts at the lower of its old number and the unit's", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Front Squat", muscle_group: "quads", mode: "reps" });
  // Done side by side three times: front squat sits at 0.8 of the back squat.
  for (const d of [120, 110, 100]) {
    session("Back Squat", d, 200);
    session("Front Squat", d - 1, 160);
  }
  for (const d of [21, 14, 7]) session("Back Squat", d, 200);
  const start = enteringVariantStart("Front Squat", "quads", 160);
  // 200 x 0.8 x 0.9 = 144 -> 140, under the old 160.
  assert.equal(start?.basis, "learned");
  assert.equal(start?.weight, 140);
  // Current history keeps its own number.
  session("Front Squat", 3, 160);
  assert.equal(enteringVariantStart("Front Squat", "quads", 160), null);
});

test("assisted and timed work keep today's behaviour", () => {
  benchPlan();
  assert.equal(enteringVariantStart("Assisted Pull-Up", "back", -30), null, "an assist is its own regime");
  assert.equal(enteringVariantStart("Pull-Up", "back", null), null, "bodyweight has no stored load to transfer");
  repo.upsertExercise({ name: "Plank", muscle_group: "core", mode: "timed" });
  addExerciseToPlanDay(1, "Plank", "Added");
  const plank = repo.getPlan()[0].items.find((i) => i.exercise === "Plank");
  assert.ok(plank);
  assert.equal(plank.target_weight, null, "a hold carries no transferred load");
});

test("the append path takes the unit start too", () => {
  benchPlan();
  repo.replacePlan([
    {
      day_number: 1,
      name: "Upper",
      items: [
        {
          exercise: "Barbell Bench Press",
          muscle_group: "chest",
          sets: 3,
          rep_low: 5,
          rep_high: 8,
          target_weight: 200,
        },
      ],
    },
    {
      day_number: 2,
      name: "Arms",
      items: [{ exercise: "Rope Pushdown", muscle_group: "triceps", sets: 3, rep_low: 10, rep_high: 12 }],
    },
  ]);
  addExerciseToPlanDay(2, "DB Bench Press", "Added as a fresh variation for Barbell Bench Press");
  const added = repo.getPlan()[1].items.find((i) => i.exercise === "DB Bench Press");
  assert.equal(added?.target_weight, 70);
});
