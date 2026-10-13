// A whole-plan write is ONE brain event. Each routed review-worthy event becomes its own
// brain_review job (one agent run each), so a replacePlan that also emitted a per-day
// plan_changed for every day it wrote fanned one first week out into five reviews — the
// welcome's composed week alone spent five agent runs saying "no genuine new insight".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { flushBrainEventsForTest, resetBrainEventsForTest } from "../dist/brainEvents.js";

beforeEach(() => {
  resetTables("plan_items", "plan_days", "exercises", "sessions", "logged_sets");
  resetBrainEventsForTest();
});

const day = (day_number, name, exercise) => ({
  day_number,
  name,
  items: [{ exercise, sets: 3, rep_low: 6, rep_high: 8 }],
});

test("replacePlan routes one full-plan event, never one per day it wrote or removed", () => {
  repo.replacePlan([day(1, "Old A", "Back Squat"), day(3, "Old C", "Deadlift")]);
  flushBrainEventsForTest(1_000, 0);

  repo.replacePlan([
    day(1, "Upper A", "Bench Press"),
    day(2, "Lower A", "Back Squat"),
    day(4, "Upper B", "Overhead Press"),
    day(5, "Lower B", "Deadlift"),
  ]);
  const routed = flushBrainEventsForTest(2_000, 0).filter((event) => event.kind === "plan_changed");
  assert.deepEqual(
    routed.map((event) => event.subject_key),
    ["full-plan"],
    "the whole write is one review, whatever days it touched"
  );
  assert.equal(routed[0].review, true);
});

test("a single-day edit still routes its own per-day event", () => {
  repo.savePlanDay(2, "Lower", "legs", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const routed = flushBrainEventsForTest(1_000, 0).filter((event) => event.kind === "plan_changed");
  assert.deepEqual(
    routed.map((event) => event.subject_key),
    ["day:2"]
  );
  repo.deletePlanDay(2);
  const removed = flushBrainEventsForTest(2_000, 0).filter((event) => event.kind === "plan_changed");
  assert.deepEqual(
    removed.map((event) => event.subject_key),
    ["day:2"]
  );
});
