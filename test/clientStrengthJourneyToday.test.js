import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadRenderer() {
  const context = { Array, Map, Number, Object, String, window: null, globalThis: null };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-plan-surface-renderer.js"), "utf8"), context);
  return context.CairnTodayPlanSurfaceRenderer;
}

function render(dayNumber, journey) {
  const renderer = loadRenderer();
  const captured = [];
  const items = [
    { exercise: "Barbell Bench Press", sets: 2 },
    { exercise: "Seated Cable Row", sets: 2 },
    { exercise: "Bicep Curl", sets: 2 },
  ];
  renderer.buildHtml({
    showDone: false,
    showPlan: true,
    focus: true,
    session: null,
    day: { day_number: dayNumber, name: "Push", items },
    isToday: true,
    plan: [],
    activeDay: dayNumber,
    logDate: "2026-07-14",
    cardioItems: [],
    strengthItems: items,
    activeItems: items,
    skippedItems: [],
    matchedCardio: new Map(),
    syncedLine: "",
    loggedByEx: {},
    offPlanEx: [],
    pendingOffPlan: [],
    lastSets: {},
    rxByEx: {},
    strengthJourney: journey,
    exDone: 0,
    exTotal: 3,
    hasSyncedCardioToday: false,
    hasLoggedSets: false,
    hasGarmin: false,
    isRunDay: false,
    prefillFor: () => ({}),
    rxFor: () => null,
  }, {
    planSurface: {
      sessionHeadHtml: () => "",
      daySwitchHtml: () => "",
      rxBannerHtml: () => "",
      addExerciseFormHtml: () => "",
      finishHtml: () => "",
    },
    planSurfaceDeps: () => ({}),
    isCardioItem: () => false,
    cardioLabel: () => "",
    cardioPlanCard: () => "",
    exCard: (item) => { captured.push(item); return `<div>${item.exercise}</div>`; },
    garminSessionCard: () => "",
    sessionDoneCard: () => "",
    skipLineHtml: () => "",
  });
  return captured;
}

const journey = {
  available: true,
  objective: { exercise: "Barbell Bench Press", status: "active" },
  current: { est_1rm: 160, date: "2026-07-07" },
  gap_lb: 40,
  phase: "building",
  planned_support: [{
    role: "upper back",
    exercise: "Seated Cable Row",
    why: "Builds the press shelf.",
    plan_day_number: 1,
    plan_day_name: "Push",
  }],
};

test("selected anchor day annotates exact anchor and exact plan-backed support only", () => {
  const items = render(1, journey);
  assert.equal(items[0].journey_role, "anchor");
  assert.match(items[0].journey_line, /160\.0 lb estimated 1RM on 2026-07-07/);
  assert.equal(items[1].journey_role, "support");
  assert.match(items[1].journey_line, /upper back for Barbell Bench Press — Builds the press shelf/);
  assert.equal(items[2].journey_role, undefined, "unrelated planned work stays silent");
});

test("support provenance is day-specific and unavailable journeys stay silent", () => {
  const wrongDay = render(2, journey);
  assert.equal(wrongDay[1].journey_role, undefined);
  const unavailable = render(1, { available: false });
  assert.ok(unavailable.every((item) => item.journey_role === undefined));
});

test("Today launch integration stays inside the existing card and checks exact anchor membership", () => {
  const source = readFileSync(join(root, "src/client/today-screen.ts"), "utf8");
  assert.match(source, /class="sess-launch-journey"/);
  assert.match(
    source,
    /const\s+hasAnchor\s*=\s*!!objective\?\.exercise\s*&&\s*\(opts\.day\?\.items\s*\|\|\s*\[\]\)\.some\(/,
  );
  assert.match(
    source,
    /String\(item\.exercise\s*\|\|\s*""\)[\s\S]*?\.trim\(\)[\s\S]*?\.toLowerCase\(\)\s*===\s*String\(objective\.exercise\)\.trim\(\)\.toLowerCase\(\)/,
  );
  assert.match(source, /Anchor day · hold or ease/);
  assert.doesNotMatch(source, /strength-journey-card|sjourney-card/);
});

test("durable mixed composition preserves saved order and current-session prescription semantics", () => {
  const renderer = loadRenderer();
  const order = [];
  const items = [
    { exercise: "Deadlift", kind: "strength", fromPlan: false, fromSession: true },
    { exercise: "Easy ride", kind: "cardio", fromPlan: false, fromSession: true },
    { exercise: "Pallof Press", kind: "strength", fromPlan: false, fromSession: true },
  ];
  renderer.buildHtml({
    showDone: false,
    showPlan: true,
    focus: true,
    session: null,
    day: { day_number: 0, name: "Built for today", items },
    isToday: true,
    plan: [],
    activeDay: null,
    logDate: "2026-07-20",
    cardioItems: [items[1]],
    strengthItems: [items[0], items[2]],
    activeItems: items,
    skippedItems: [],
    matchedCardio: new Map(),
    syncedLine: "",
    loggedByEx: {},
    offPlanEx: [],
    pendingOffPlan: [],
    lastSets: {},
    rxByEx: {},
    strengthJourney: null,
    exDone: 0,
    exTotal: 2,
    hasSyncedCardioToday: false,
    hasLoggedSets: false,
    hasGarmin: false,
    isRunDay: false,
    preserveItemOrder: true,
    prefillFor: () => ({}),
    rxFor: () => null,
  }, {
    planSurface: {
      sessionHeadHtml: () => "",
      daySwitchHtml: () => "",
      rxBannerHtml: () => "",
      addExerciseFormHtml: () => "",
      finishHtml: () => "",
    },
    planSurfaceDeps: () => ({}),
    isCardioItem: (item) => item.kind === "cardio",
    cardioLabel: (item) => item.exercise,
    cardioPlanCard: (item) => { order.push(item.exercise); return ""; },
    exCard: (item) => { order.push(item.exercise); assert.equal(item.fromSession, true); return ""; },
    garminSessionCard: () => "",
    sessionDoneCard: () => "",
    skipLineHtml: () => "",
  });
  assert.deepEqual(order, ["Deadlift", "Easy ride", "Pallof Press"]);
});
