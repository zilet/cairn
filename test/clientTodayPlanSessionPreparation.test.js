import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadPreparation() {
  const context = {
    Object,
    Promise,
    Array,
    Map,
    Set,
    String,
    Number,
    encodeURIComponent,
    window: null,
    globalThis: null,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-plan-session-model.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-plan-session-data-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-plan-session-preparation.js"), "utf8"), context);
  return context;
}

test("Today plan/session model groups sets, matches cardio once, prunes pending off-plan, and chooses prefill", () => {
  const context = loadPreparation();
  const model = context.CairnTodayPlanSessionModel;
  const session = {
    skips: ["Easy run", "Squat"],
    sets: [
      { exercise: "Bench", set_number: 2, weight: 190, reps: 4, rir: 1 },
      { exercise: "Bench", set_number: 1, weight: 185, reps: 5, rir: 2 },
      { exercise: "Curl", set_number: 1, weight: 30, reps: 12, rir: 2 },
    ],
  };
  const loggedByEx = model.groupLoggedSets(session);
  assert.deepEqual(plain(loggedByEx.Bench.map((set) => set.set_number)), [1, 2]);

  const items = [
    { exercise: "Bench" },
    { exercise: "Squat" },
    { kind: "cardio", label: "Easy run" },
  ];
  const efforts = [{ label: "Easy run" }, { label: "Easy run" }];
  const matchedCardio = model.matchCardioEfforts(items.filter((item) => item.kind === "cardio"), efforts, (item, effort) => item.label === effort?.label);
  assert.equal(matchedCardio.size, 1);
  const groups = model.itemGroups({
    items,
    loggedByEx,
    matchedCardio,
    skips: session.skips,
    isCardioItem: (item) => item.kind === "cardio",
    cardioLabel: (item) => item.label || "Cardio",
  });
  assert.deepEqual(plain(groups.planEx), ["Bench"]);
  assert.deepEqual(plain(groups.offPlanEx), ["Curl"]);
  assert.deepEqual(plain(groups.skippedItems), [{ exercise: "Squat" }]);

  const state = { logDate: "2026-06-30", day: 1, plan: [{ day_number: 1, items }], pendingOffPlan: { "2026-06-30": [{ name: "Curl" }, { name: "Lateral raise" }] } };
  assert.deepEqual(plain(model.prunePendingOffPlan(state, groups.planNames, loggedByEx)), [{ name: "Lateral raise" }]);
  assert.deepEqual(plain(state.pendingOffPlan["2026-06-30"]), [{ name: "Lateral raise" }]);
  assert.deepEqual(plain(model.prefillFor({ exercise: "Bench", target_weight: 180, rep_low: 5 }, loggedByEx, {})), { weight: 190, reps: 4, rir: 1, duration_sec: null });
  assert.deepEqual(plain(model.selectedPlanDay({ day: 9, plan: [{ day_number: 2, name: "Fallback" }] }, false)), { day_number: 2, name: "Fallback" });
});

test("Today plan/session data helper loads cached last sets and refreshes stale data", async () => {
  const context = loadPreparation();
  const requests = [];
  const data = context.CairnTodayPlanSessionData;
  const result = await data.loadLastSets(["Bench", "Squat", "Bench"], {
    Squat: [{ exercise: "Squat", set_number: 1, weight: 225 }],
  }, {
    state: { logDate: "2026-06-30" },
    peekCached: (key) => key === "last-set:Bench" ? { data: { weight: 185, reps: 5, rir: 2 }, fresh: true } : null,
    cachedApi: async (path, opts) => {
      requests.push({ path, opts });
      return { weight: 0 };
    },
    api: async () => ({}),
    isCardioItem: () => false,
  });

  assert.deepEqual(plain(result), { Bench: { weight: 185, reps: 5, rir: 2 } });
  assert.deepEqual(plain(requests), [{ path: "/last-set?exercise=Bench", opts: { key: "last-set:Bench" } }]);
});

test("Today plan/session preparation assembles cardio, pending off-plan, prescriptions, and prefill data", async () => {
  const context = loadPreparation();
  const apiRequests = [];
  const cachedRequests = [];
  const prep = context.CairnTodayPlanSessionPreparation;
  const state = {
    logDate: "2026-06-30",
    day: 1,
    dayPicked: true,
    plan: [{
      day_number: 1,
      name: "Strength + run",
      items: [
        { exercise: "Bench", target_weight: 180, rep_low: 5, target_seconds: null },
        { kind: "cardio", label: "Easy run", target_duration_min: 40, target_zone: "Z2" },
      ],
    }],
    pendingOffPlan: {
      "2026-06-30": [{ name: "Curl" }, { name: "Bench" }],
    },
  };
  const result = await prep.preparePlanSession({
    state,
    session: { skips: ["Easy run"], sets: [] },
    isToday: true,
    suggestedPlanDayNumber: async () => 1,
    isCardioItem: (item) => item.kind === "cardio",
    cardioLabel: (item) => item.label || "Cardio",
    cardioEffortMatches: (item, effort) => item.label === effort?.label,
    api: async (path) => {
      apiRequests.push(path);
      if (path.startsWith("/cardio")) return [{ label: "Easy run", duration_min: 38 }];
      if (path === "/settings") return { settings: { garmin_enabled: true } };
      return {};
    },
    peekCached: () => null,
    cachedApi: async (path, opts) => {
      cachedRequests.push({ path, opts });
      if (path.startsWith("/program/progression")) return [{ exercise: "Bench", action: "overload" }];
      if (path.includes("Bench")) return { weight: 185, reps: 5, rir: 1 };
      if (path.includes("Curl")) return { weight: 30, reps: 12, rir: 2 };
      return null;
    },
  });

  assert.equal(result.day.name, "Strength + run");
  assert.equal(result.matchedCardio.size, 1);
  assert.equal(result.skippedItems.length, 0);
  assert.deepEqual(result.pendingOffPlan, [{ name: "Curl" }]);
  assert.deepEqual(state.pendingOffPlan["2026-06-30"], [{ name: "Curl" }]);
  assert.deepEqual(plain(result.prefillFor({ exercise: "Bench", rep_low: 5 })), { weight: 185, reps: 5, rir: 1, duration_sec: null });
  assert.equal(result.rxFor("Bench").action, "overload");
  assert.equal(result.hasSyncedCardioToday, true);
  assert.equal(result.expectingRun, false);
  assert.deepEqual(apiRequests, ["/cardio?date=2026-06-30", "/settings"]);
  assert.equal(cachedRequests.some((request) => request.path === "/program/progression?day=1"), true);
});
