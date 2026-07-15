import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadClient() {
  const context = {
    Array,
    Number,
    Object,
    Promise,
    Set,
    window: null,
    globalThis: null,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-plan-selection-client.js"), "utf8"), context);
  return context.CairnTodayPlanSelection;
}

const plan = [
  { id: 11, day_number: 1, items: [{ exercise: "Squat" }, { exercise: "Bench" }] },
  { id: 12, day_number: 2, items: [{ exercise: "Deadlift" }, { exercise: "Row" }] },
  { id: 13, day_number: 3, items: [{ exercise: "Run" }] },
];

test("Today plan selection maps sessions by explicit plan day id first", () => {
  const client = loadClient();
  const session = { plan_day_id: "12", sets: [{ exercise: "Bench" }] };

  assert.equal(client.planDayNumberForSession(session, plan), 2);
});

test("Today plan selection falls back to the best exercise-name match", () => {
  const client = loadClient();
  const session = { sets: [{ exercise: "Deadlift" }, { exercise: "Row" }, { exercise: "Bench" }] };

  assert.equal(client.planDayNumberForSession(session, plan), 2);
  assert.equal(client.planDayNumberForSession({ sets: [] }, plan), null);
  assert.equal(client.planDayNumberForSession(null, plan), null);
});

test("Today plan selection falls back to movement character when exercise names differ", () => {
  const client = loadClient();
  const split = [
    { id: 11, day_number: 1, items: [{ exercise: "Lat Pulldown" }, { exercise: "Seated Cable Row" }] },
    { id: 12, day_number: 2, items: [{ exercise: "Bench Press" }, { exercise: "Overhead Press" }] },
  ];
  const session = { sets: [{ exercise: "Pull-Up" }, { exercise: "One-Arm DB Row" }, { exercise: "Hammer Curl" }] };

  assert.equal(client.planDayNumberForSession(session, split), 1);
});

test("Today plan selection wraps to the next ordered day", () => {
  const client = loadClient();
  const unsorted = [plan[2], plan[0], plan[1]];

  assert.equal(client.nextPlanDayNumber(1, unsorted), 2);
  assert.equal(client.nextPlanDayNumber(3, unsorted), 1);
  assert.equal(client.nextPlanDayNumber(99, unsorted), 1);
  assert.equal(client.nextPlanDayNumber(null, []), null);
});

test("Today plan selection uses the server-owned adaptive day unless the athlete picked/logged a day", async () => {
  const client = loadClient();
  const calls = [];
  const deps = {
    state: { logDate: "2026-07-01", plan },
    api: async (path) => {
      calls.push(path);
      return { date: "2026-07-01", plan_day_id: 13, day_number: 3, focus: "Run" };
    },
  };

  assert.equal(await client.suggestedPlanDayNumber({ sets: [{ exercise: "Run" }] }, true, deps), 3);
  assert.deepEqual(calls, []);
  assert.equal(await client.suggestedPlanDayNumber({ sets: [] }, false, deps), 1);
  assert.deepEqual(calls, []);
  assert.equal(await client.suggestedPlanDayNumber({ sets: [] }, true, deps), 3);
  assert.deepEqual(calls, ["/today-plan-day?date=2026-07-01"]);

  const failingDeps = {
    state: { logDate: "2026-07-01", plan },
    api: async () => { throw new Error("offline"); },
  };
  assert.equal(await client.suggestedPlanDayNumber({ sets: [] }, true, failingDeps), 1);
});

test("Today plan selection rejects a stale server day that is no longer in the loaded plan", async () => {
  const client = loadClient();
  const deps = {
    state: { logDate: "2026-07-01", plan },
    api: async () => ({ date: "2026-07-01", plan_day_id: 999, day_number: 9, focus: "Deleted day" }),
  };
  assert.equal(await client.suggestedPlanDayNumber({ sets: [] }, true, deps), 1);
});
