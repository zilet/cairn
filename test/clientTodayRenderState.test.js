import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadClient() {
  const context = {
    Object,
    window: null,
    globalThis: null,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-render-state-client.js"), "utf8"), context);
  return context.CairnTodayRenderState;
}

function derive(input) {
  const client = loadClient();
  return client.derive({
    logDate: "2026-07-01",
    session: null,
    day: { items: [{ exercise: "Squat" }] },
    read: { kind: "easy" },
    isToday: true,
    ...input,
  });
}

test("Today render state opens the plan from a train read or existing work", () => {
  assert.equal(derive({ read: { kind: "train" } }).showPlan, true);
  assert.equal(derive({ session: { sets: [{ exercise: "Squat" }] } }).showPlan, true);
  assert.equal(derive({ session: { garmin: { activity_id: 1 } } }).showPlan, true);
  assert.equal(derive({ read: { kind: "easy" } }).showPlan, false);
});

// 2026-11-07 (live): a session planned over MCP (athlete_override) on an easy-read
// morning was invisible on Today — the Brief offered only "Train anyway", which the
// server then refused because that very session already owned the date.
test("a session the athlete chose opens its launch card under a quiet read", () => {
  const items = [{ exercise: "Pull-Up" }];
  assert.equal(derive({ read: { kind: "easy" }, dailySession: { source: "athlete_override", items } }).showPlan, true);
  assert.equal(derive({ read: { kind: "rest" }, dailySession: { source: "agent_suggest", items } }).showPlan, true);
  assert.equal(
    derive({ read: { kind: "easy" }, dailySession: { source: "athlete_override", items: [] } }).showPlan,
    true,
    "an open session"
  );
  assert.equal(
    derive({ read: { kind: "rest" }, dailySession: { source: "agent_suggest", items: [] } }).showPlan,
    false,
    "an empty 'Rest day' card"
  );
  assert.equal(derive({ read: { kind: "easy" }, dailySession: { source: "adaptive_plan", items } }).showPlan, false);
});

test("Today render state keeps finished today in done mode unless explicitly revealed", () => {
  const done = derive({ session: { finished_at: "2026-07-01T12:00:00Z", sets: [{ exercise: "Squat" }] } });

  assert.equal(done.showDone, true);

  const revealed = derive({
    session: { finished_at: "2026-07-01T12:00:00Z", sets: [{ exercise: "Squat" }] },
    planReveal: { date: "2026-07-01", on: true },
  });

  assert.equal(revealed.showDone, false);
  assert.equal(revealed.revealOn, true);
});

test("Today render state keeps past dates in review mode", () => {
  const result = derive({
    isToday: false,
    session: { finished_at: "2026-06-30T12:00:00Z", sets: [] },
  });

  assert.equal(result.showPlan, true);
  assert.equal(result.showDone, false);
});
