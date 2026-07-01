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
  const focusCalls = [];
  const result = client.derive({
    logDate: "2026-07-01",
    session: null,
    day: { items: [{ exercise: "Squat" }] },
    read: { kind: "easy" },
    isToday: true,
    focusEngaged: (date, opts) => {
      focusCalls.push({ date, opts });
      return !!input.focusOn;
    },
    ...input,
  });
  return { result, focusCalls };
}

test("Today render state opens the plan from a train read or existing work", () => {
  assert.equal(derive({ read: { kind: "train" } }).result.showPlan, true);
  assert.equal(derive({ session: { sets: [{ exercise: "Squat" }] } }).result.showPlan, true);
  assert.equal(derive({ session: { garmin: { activity_id: 1 } } }).result.showPlan, true);
  assert.equal(derive({ read: { kind: "easy" } }).result.showPlan, false);
});

test("Today render state keeps finished today in done mode unless explicitly revealed", () => {
  const done = derive({ session: { finished_at: "2026-07-01T12:00:00Z", sets: [{ exercise: "Squat" }] }, focusOn: true });

  assert.equal(done.result.showDone, true);
  assert.equal(done.result.focus, false);
  assert.deepEqual(done.focusCalls, []);

  const revealed = derive({
    session: { finished_at: "2026-07-01T12:00:00Z", sets: [{ exercise: "Squat" }] },
    planReveal: { date: "2026-07-01", on: true },
    focusOn: true,
  });

  assert.equal(revealed.result.showDone, false);
  assert.equal(revealed.result.revealOn, true);
  assert.equal(revealed.result.focus, true);
});

test("Today render state keeps past dates in review mode", () => {
  const { result, focusCalls } = derive({
    isToday: false,
    session: { finished_at: "2026-06-30T12:00:00Z", sets: [] },
  });

  assert.equal(result.showPlan, true);
  assert.equal(result.showDone, false);
  assert.equal(focusCalls[0].opts.showPlan, true);
  assert.equal(focusCalls[0].opts.isToday, false);
});
