import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function loadPrimer(options = {}) {
  const source = readFileSync(new URL("../public/js/app-discipline-primer.js", import.meta.url), "utf8");
  const calls = [];
  let currentDiscipline = options.initialDiscipline || "strength";
  let enduranceGoalSet = !!options.initialEnduranceGoalSet;
  const context = {
    api: (path) => {
      calls.push(["api", path]);
      return options.apiReject ? Promise.reject(new Error("profile failed")) : Promise.resolve(options.profile || null);
    },
    defaultProgressSeg: () => (currentDiscipline === "endurance" || currentDiscipline === "hybrid" ? "endurance" : "sessions"),
    globalThis: null,
    peekCached: (key) => {
      calls.push(["peekCached", key]);
      return options.warmProfile ? { data: options.warmProfile, fresh: true } : null;
    },
    renderTab: (tab) => calls.push(["renderTab", tab]),
    setDiscipline: (discipline) => {
      currentDiscipline = discipline || "strength";
      calls.push(["setDiscipline", currentDiscipline]);
      return currentDiscipline;
    },
    setEnduranceGoalSet: (present) => {
      enduranceGoalSet = !!present;
      calls.push(["setEnduranceGoalSet", enduranceGoalSet]);
      return enduranceGoalSet;
    },
    showEnduranceTab: () => currentDiscipline === "endurance" || currentDiscipline === "hybrid" || enduranceGoalSet,
    state: {
      tab: options.tab || "today",
      progressSeg: options.progressSeg,
    },
    window: {},
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "app-discipline-primer.js" });
  return { calls, context };
}

test("discipline primer uses warm profile cache before first paint", () => {
  const env = loadPrimer({
    warmProfile: { primary_discipline: "hybrid", endurance_goal_json: "{}" },
  });

  assert.equal(typeof env.context.primeDiscipline, "function");
  assert.equal(typeof env.context.window.primeDiscipline, "function");
  env.context.primeDiscipline();

  assert.deepEqual(env.calls, [
    ["peekCached", "profile"],
    ["setDiscipline", "hybrid"],
    ["setEnduranceGoalSet", true],
  ]);
});

test("discipline primer re-renders Progress when cold profile changes default segment", async () => {
  const env = loadPrimer({
    profile: { primary_discipline: "endurance", endurance_goal_json: null },
    tab: "progress",
  });

  env.context.primeDiscipline();
  await flush();

  assert.deepEqual(env.calls, [
    ["peekCached", "profile"],
    ["api", "/profile"],
    ["setDiscipline", "endurance"],
    ["setEnduranceGoalSet", false],
    ["renderTab", "progress"],
  ]);
});

test("discipline primer re-renders Plan when endurance tab appears after profile load", async () => {
  const env = loadPrimer({
    profile: { primary_discipline: "strength", endurance_goal_json: "{}" },
    tab: "plan",
  });

  env.context.primeDiscipline();
  await flush();

  assert.deepEqual(env.calls, [
    ["peekCached", "profile"],
    ["api", "/profile"],
    ["setDiscipline", "strength"],
    ["setEnduranceGoalSet", true],
    ["renderTab", "plan"],
  ]);
});

test("discipline primer swallows profile lookup failures", async () => {
  const env = loadPrimer({ apiReject: true, tab: "progress" });

  env.context.primeDiscipline();
  await flush();

  assert.deepEqual(env.calls, [
    ["peekCached", "profile"],
    ["api", "/profile"],
  ]);
});
