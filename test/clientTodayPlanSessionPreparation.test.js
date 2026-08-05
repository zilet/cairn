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

  const items = [{ exercise: "Bench" }, { exercise: "Squat" }, { kind: "cardio", label: "Easy run" }];
  const efforts = [{ label: "Easy run" }, { label: "Easy run" }];
  const matchedCardio = model.matchCardioEfforts(
    items.filter((item) => item.kind === "cardio"),
    efforts,
    (item, effort) => item.label === effort?.label
  );
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

  const state = {
    logDate: "2026-06-30",
    day: 1,
    plan: [{ day_number: 1, items }],
    pendingOffPlan: { "2026-06-30": [{ name: "Curl" }, { name: "Lateral raise" }] },
  };
  assert.deepEqual(plain(model.prunePendingOffPlan(state, groups.planNames, loggedByEx)), [{ name: "Lateral raise" }]);
  assert.deepEqual(plain(state.pendingOffPlan["2026-06-30"]), [{ name: "Lateral raise" }]);
  assert.deepEqual(plain(model.prefillFor({ exercise: "Bench", target_weight: 180, rep_low: 5 }, loggedByEx, {})), {
    weight: 190,
    reps: 4,
    rir: 1,
    duration_sec: null,
  });
  assert.deepEqual(plain(model.selectedPlanDay({ day: 9, plan: [{ day_number: 2, name: "Fallback" }] }, false)), {
    day_number: 2,
    name: "Fallback",
  });
});

// A rotated-in lift arrives with target_weight NULL and no history under its own
// name. The server's grounded suggestion is the only honest fallback — and a
// deliberate NULL (bodyweight) must survive when the server has no number either.
test("Today prefill falls back to the server's grounded suggestion, never to an invented number", () => {
  const context = loadPreparation();
  const model = context.CairnTodayPlanSessionModel;
  const rotated = { exercise: "Incline DB Press", rep_low: null, target_weight: null };

  assert.deepEqual(
    plain(model.prefillFor(rotated, {}, {}, { suggested: { weight: 55, rep_low: 8, sets: 3 } })),
    { weight: 55, reps: 8, rir: null, duration_sec: null }
  );
  assert.deepEqual(plain(model.prefillFor(rotated, {}, {}, { suggested: {} })), {
    weight: null,
    reps: null,
    rir: null,
    duration_sec: null,
  });
  assert.deepEqual(plain(model.prefillFor(rotated, {}, {}, null)), {
    weight: null,
    reps: null,
    rir: null,
    duration_sec: null,
  });
  // A real target on the item always outranks the suggestion.
  assert.equal(
    model.prefillFor({ ...rotated, target_weight: 60 }, {}, {}, { suggested: { weight: 55 } }).weight,
    60
  );
  // Timed movements ground in seconds the same way.
  assert.equal(
    model.prefillFor({ exercise: "Plank", target_seconds: null }, {}, {}, { suggested: { seconds: 45 } })
      .duration_sec,
    45
  );
  // Today's own logged set still wins over everything.
  assert.equal(
    model.prefillFor(
      rotated,
      { "Incline DB Press": [{ exercise: "Incline DB Press", weight: 70, reps: 6, rir: 1 }] },
      {},
      { suggested: { weight: 55 } }
    ).weight,
    70
  );
});

// The per-session symptom-relevance read is gone with the per-card movement check
// it fed. Nothing on a card gates on pain any more, so the session render asks one
// fewer question of the server.

test("Today plan/session data helper loads cached last sets and refreshes stale data", async () => {
  const context = loadPreparation();
  const requests = [];
  const data = context.CairnTodayPlanSessionData;
  const result = await data.loadLastSets(
    ["Bench", "Squat", "Bench"],
    {
      Squat: [{ exercise: "Squat", set_number: 1, weight: 225 }],
    },
    {
      state: { logDate: "2026-06-30" },
      peekCached: (key) => (key === "last-set:Bench" ? { data: { weight: 185, reps: 5, rir: 2 }, fresh: true } : null),
      cachedApi: async (path, opts) => {
        requests.push({ path, opts });
        return { weight: 0 };
      },
      api: async () => ({}),
      isCardioItem: () => false,
    }
  );

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
    plan: [
      {
        day_number: 1,
        name: "Strength + run",
        items: [
          { exercise: "Bench", target_weight: 180, rep_low: 5, target_seconds: null },
          { kind: "cardio", label: "Easy run", target_duration_min: 40, target_zone: "Z2" },
        ],
      },
    ],
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
  assert.deepEqual(plain(result.prefillFor({ exercise: "Bench", rep_low: 5 })), {
    weight: 185,
    reps: 5,
    rir: 1,
    duration_sec: null,
  });
  assert.equal(result.rxFor("Bench").action, "overload");
  assert.equal(result.hasSyncedCardioToday, true);
  assert.equal(result.expectingRun, false);
  assert.deepEqual(apiRequests, [
    "/cardio?date=2026-06-30",
    "/settings",
    "/strength-journey",
  ]);
  assert.equal(
    cachedRequests.some((request) => request.path === "/program/progression?day=1"),
    true
  );
});

test("durable daily composition wins over the weekly plan and preserves saved order and source", async () => {
  const context = loadPreparation();
  const prep = context.CairnTodayPlanSessionPreparation;
  const cachedRequests = [];
  const state = {
    logDate: "2026-07-20",
    day: 1,
    dayPicked: false,
    plan: [
      {
        id: 11,
        day_number: 1,
        name: "Pull",
        focus: "Back",
        items: [{ exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12 }],
      },
    ],
    pendingOffPlan: {},
  };
  const dailySession = {
    id: 41,
    version: 1,
    session_id: 9,
    date: "2026-07-20",
    source: "agent_suggest",
    status: "active",
    plan_day_id: null,
    title: "Deadlift + bench",
    focus: "Full body",
    why: "Legs are ready and upper body is fresh.",
    est_minutes: 42,
    items: [
      { position: 2, kind: "strength", exercise: "Pallof Press", sets: 2, rep_low: 10, rep_high: 12, mode: "reps" },
      {
        position: 0,
        kind: "strength",
        exercise: "Deadlift",
        sets: 3,
        rep_low: 4,
        rep_high: 6,
        target_weight: 225,
        mode: "reps",
      },
      { position: 1, kind: "cardio", exercise: "Easy ride", target_duration_min: 12, target_zone: "easy" },
    ],
  };

  const result = await prep.preparePlanSession({
    state,
    session: { id: 9, sets: [], skips: [], daily_session: dailySession },
    isToday: true,
    suggestedPlanDayNumber: async () => {
      throw new Error("durable composition should bypass selection");
    },
    isCardioItem: (item) => item.kind === "cardio",
    cardioLabel: (item) => item.exercise || "Cardio",
    cardioEffortMatches: () => false,
    api: async (path) => (path === "/strength-journey" ? {} : []),
    peekCached: () => null,
    cachedApi: async (path) => {
      cachedRequests.push(path);
      if (path.startsWith("/last-set")) return null;
      return [];
    },
  });

  assert.equal(result.dailySession.source, "agent_suggest");
  assert.equal(result.day.name, "Deadlift + bench");
  assert.equal(result.day.focus, "Full body");
  assert.equal(state.day, null, "custom session does not inherit Pull's day number");
  assert.deepEqual(plain(result.activeItems.map((item) => item.exercise)), ["Deadlift", "Easy ride", "Pallof Press"]);
  assert.equal(result.activeItems[0].fromSession, true);
  assert.equal(result.activeItems[0].fromPlan, false);
  assert.equal(
    cachedRequests.some((path) => path.startsWith("/program/progression")),
    false
  );
});

test("plan-backed daily composition remains an immutable strength and cardio snapshot", async () => {
  const context = loadPreparation();
  const prep = context.CairnTodayPlanSessionPreparation;
  const state = {
    logDate: "2026-07-20",
    day: 5,
    dayPicked: true,
    plan: [
      {
        id: 51,
        day_number: 5,
        name: "Full body",
        items: [
          { exercise: "Changed weekly squat", sets: 5 },
          { kind: "cardio", exercise: "Smoke easy run", note: "Smoke easy run", target_duration_min: 32 },
        ],
      },
    ],
    pendingOffPlan: {},
  };
  const dailySession = {
    id: 61,
    version: 1,
    session_id: 71,
    date: "2026-07-20",
    source: "adaptive_plan",
    status: "active",
    plan_day_id: 51,
    title: "Accepted full body",
    focus: "Strength",
    items: [{ position: 0, kind: "strength", exercise: "Snapshot squat", sets: 3 }],
  };

  const result = await prep.preparePlanSession({
    state,
    session: { id: 71, sets: [{ exercise: "Off-plan curl", set_number: 1 }], skips: [], daily_session: dailySession },
    isToday: true,
    suggestedPlanDayNumber: async () => {
      throw new Error("durable composition should bypass selection");
    },
    isCardioItem: (item) => item.kind === "cardio",
    cardioLabel: (item) => item.note || item.exercise || "Cardio",
    cardioEffortMatches: () => false,
    api: async (path) => (path === "/strength-journey" ? {} : []),
    peekCached: () => null,
    cachedApi: async () => null,
  });

  assert.deepEqual(plain(result.activeItems.map((item) => item.exercise)), ["Snapshot squat"]);
  assert.equal(
    result.activeItems.some((item) => item.exercise === "Changed weekly squat"),
    false
  );
  assert.equal(result.activeItems[0].fromSession, true);
  assert.equal(
    result.activeItems.some((item) => item.exercise === "Smoke easy run"),
    false,
    "later weekly-plan cardio must not be appended to the accepted snapshot"
  );
});

// A peak day prescribes the SAME lift twice — a near-max top single, then a
// back-off block — and logged sets can only carry the one real lift name (est-1RM
// and calibration read that name). Without per-card attribution the back-off card
// read the name-keyed pile and opened prefilled with the 315x1 the athlete had
// just hit.
test("Peak-day cards claim their own logged sets and never prefill from a sibling card", () => {
  const context = loadPreparation();
  const model = context.CairnTodayPlanSessionModel;
  const topSingle = { exercise: "Back Squat", sets: 1, rep_low: 1, rep_high: 1, target_weight: 315 };
  const backOff = { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 265 };
  const items = [topSingle, backOff];
  const isCardioItem = (item) => item.kind === "cardio";

  const loggedByEx = model.groupLoggedSets({
    sets: [{ exercise: "Back Squat", set_number: 1, weight: 315, reps: 1, rir: 0 }],
  });
  const attribution = model.cardAttribution({ items, loggedByEx, isCardioItem });

  // The top single claims the first logged set; the back-off block has none yet.
  assert.deepEqual(plain(attribution.get(topSingle).sets.map((set) => set.weight)), [315]);
  assert.deepEqual(plain(attribution.get(backOff).sets), []);
  assert.notEqual(attribution.get(topSingle).key, attribution.get(backOff).key);
  assert.equal(attribution.get(topSingle).siblings, 2);

  // THE SAFETY CASE: the back-off card opens on its OWN prescribed dose, not on
  // the near-max single sitting in the name-keyed pile.
  assert.deepEqual(
    plain(model.prefillFor(backOff, loggedByEx, {}, null, attribution.get(backOff))),
    { weight: 265, reps: 5, rir: null, duration_sec: null }
  );
  // ...and a name-keyed history row cannot override it either.
  assert.deepEqual(
    plain(model.prefillFor(backOff, loggedByEx, { "Back Squat": { weight: 315, reps: 1, rir: 0 } }, null, attribution.get(backOff))),
    { weight: 265, reps: 5, rir: null, duration_sec: null }
  );
  // The card that DID log continues from what it logged.
  assert.deepEqual(
    plain(model.prefillFor(topSingle, loggedByEx, {}, null, attribution.get(topSingle))),
    { weight: 315, reps: 1, rir: 0, duration_sec: null }
  );

  // Later sets fill the back-off card in order; the top single keeps only its one.
  const laterLogged = model.groupLoggedSets({
    sets: [
      { exercise: "Back Squat", set_number: 1, weight: 315, reps: 1, rir: 0 },
      { exercise: "Back Squat", set_number: 2, weight: 265, reps: 5, rir: 2 },
      { exercise: "Back Squat", set_number: 3, weight: 265, reps: 5, rir: 1 },
      { exercise: "Back Squat", set_number: 4, weight: 265, reps: 5, rir: 1 },
      { exercise: "Back Squat", set_number: 5, weight: 265, reps: 4, rir: 0 },
    ],
  });
  const later = model.cardAttribution({ items, loggedByEx: laterLogged, isCardioItem });
  assert.deepEqual(plain(later.get(topSingle).sets.map((set) => set.set_number)), [1]);
  // The last card absorbs the overflow set rather than dropping it.
  assert.deepEqual(plain(later.get(backOff).sets.map((set) => set.set_number)), [2, 3, 4, 5]);
});

// The ordinary day must not notice any of this: one card per exercise means the
// card key IS the exercise name and the card claims the whole pile, which is
// exactly what the name-keyed model did.
test("A one-card-per-exercise day degenerates to the name-keyed behaviour", () => {
  const context = loadPreparation();
  const model = context.CairnTodayPlanSessionModel;
  const bench = { exercise: "Bench", sets: 3, rep_low: 5, target_weight: 185 };
  const items = [bench, { exercise: "Row", sets: 3, rep_low: 8 }, { kind: "cardio", label: "Easy run" }];
  const loggedByEx = model.groupLoggedSets({
    sets: [
      { exercise: "Bench", set_number: 1, weight: 185, reps: 5, rir: 2 },
      { exercise: "Bench", set_number: 2, weight: 190, reps: 4, rir: 1 },
    ],
  });
  const attribution = model.cardAttribution({ items, loggedByEx, isCardioItem: (item) => item.kind === "cardio" });

  assert.equal(attribution.get(bench).key, "Bench", "an unshared name stays its own key");
  assert.equal(attribution.get(bench).siblings, 1);
  assert.deepEqual(plain(attribution.get(bench).sets.map((set) => set.set_number)), [1, 2]);
  // Same prefill with and without the attribution argument.
  const withAttribution = plain(model.prefillFor(bench, loggedByEx, {}, null, attribution.get(bench)));
  const withoutAttribution = plain(model.prefillFor(bench, loggedByEx, {}, null));
  assert.deepEqual(withAttribution, withoutAttribution);
  assert.deepEqual(withAttribution, { weight: 190, reps: 4, rir: 1, duration_sec: null });
  // A single card still prefers real history over its stored target.
  const row = items[1];
  assert.deepEqual(
    plain(model.prefillFor(row, {}, { Row: { weight: 135, reps: 8, rir: 2 } }, null, attribution.get(row))),
    { weight: 135, reps: 8, rir: 2, duration_sec: null }
  );
});
