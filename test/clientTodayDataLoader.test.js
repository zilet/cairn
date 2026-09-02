import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeRoot {
  constructor() {
    this.innerHTML = "";
    this.hasTodayWrap = false;
  }

  querySelector(selector) {
    if (selector === ".today-wrap" && this.hasTodayWrap) return {};
    return null;
  }
}

function loadDataLoader() {
  const context = {
    Object,
    Promise,
    Array,
    String,
    Number,
    JSON,
    Set,
    encodeURIComponent,
    document: { activeElement: null },
    window: null,
    globalThis: null,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-data-loader.js"), "utf8"), context);
  return context.CairnTodayDataLoader;
}

function makeDeps(overrides = {}) {
  const calls = [];
  const writes = [];
  const peeks = overrides.peeks || {};
  const rootEl = overrides.root || new FakeRoot();
  const deps = {
    root: rootEl,
    state: { logDate: "2026-01-02", plan: [] },
    api: async (path) => {
      calls.push(["api", path]);
      if (path === "/plan") return [{ day_number: 1, name: "Fallback", items: [] }];
      if (path === "/sessions?date=2026-01-02") return null;
      if (path === "/stats") return { week_sets: 0 };
      if (path === "/profile") return { name: "Fallback" };
      if (path === "/exercises") return [];
      throw new Error("unexpected api path " + path);
    },
    cachedApi: async (path, options = {}) => {
      calls.push(["cached", path, options.key || path]);
      if (overrides.cachedApi) return overrides.cachedApi(path, options);
      const payload = {
        date: "2026-01-02",
        plan: [{ day_number: 1, name: "Aggregate", items: [] }],
        session: { id: 7, date: "2026-01-02", sets: [] },
        stats: { week_sets: 3 },
        profile: { name: "Aggregate" },
        exercises: [{ id: 1, name: "Back Squat" }],
      };
      if (options.onUpgrade) options.onUpgrade(payload, { changed: true });
      return payload;
    },
    peekCached: (key) => overrides.peekCached ? overrides.peekCached(key) : peeks[key] || null,
    storeCached: (key, data) => writes.push({ key, data }),
    localISO: () => "2026-01-02",
    todaySkeleton: () => "<section>Loading</section>",
    setTodayHeaderTitle: () => calls.push(["header"]),
    nextPollToken: () => 42,
  };
  return { deps, calls, writes, rootEl };
}

test("Today data loader uses the aggregate on a cold path and primes slice caches", async () => {
  const loader = loadDataLoader();
  const { deps, calls, writes, rootEl } = makeDeps();

  const result = await loader.load({}, deps);

  assert.equal(rootEl.innerHTML, "<section>Loading</section>");
  assert.deepEqual(calls, [
    ["header"],
    ["cached", "/today?date=2026-01-02", "today:aggregate:2026-01-02"],
  ]);
  assert.deepEqual(deps.state.plan, [{ day_number: 1, name: "Aggregate", items: [] }]);
  assert.deepEqual(result.session, { id: 7, date: "2026-01-02", sets: [] });
  assert.deepEqual(result.stats, { week_sets: 3 });
  assert.deepEqual(result.profile, { name: "Aggregate" });
  assert.deepEqual(result.exercises, [{ id: 1, name: "Back Squat" }]);
  assert.deepEqual(writes.map((row) => row.key), [
    "plan",
    "today:session:2026-01-02",
    "stats",
    "profile",
    "exercises",
  ]);
  assert.equal(result.revalidations.length, 0);
});

test("Today data loader lets a fresh aggregate replace warm-but-stale slices", async () => {
  const loader = loadDataLoader();
  const { deps, writes } = makeDeps({
    peeks: {
      plan: { data: [{ day_number: 1, name: "Stale", items: [] }], fresh: true },
      stats: { data: { week_sets: 1 }, fresh: true },
      profile: { data: { name: "Stale" }, fresh: true },
      exercises: { data: [{ id: 9, name: "Old Lift" }], fresh: true },
    },
  });
  deps.state.plan = [{ day_number: 1, name: "State Stale", items: [] }];

  const result = await loader.load({}, deps);

  assert.deepEqual(deps.state.plan, [{ day_number: 1, name: "Aggregate", items: [] }]);
  assert.deepEqual(result.stats, { week_sets: 3 });
  assert.deepEqual(result.profile, { name: "Aggregate" });
  assert.deepEqual(result.exercises, [{ id: 1, name: "Back Squat" }]);
  assert.deepEqual(writes.map((row) => row.key), [
    "plan",
    "today:session:2026-01-02",
    "stats",
    "profile",
    "exercises",
  ]);
  assert.equal(result.revalidations.length, 0);
});

test("an aggregate read superseded by session preparation cannot repaint or cache the old session", async () => {
  const loader = loadDataLoader();
  const cache = new Map();
  const prepared = { id: 22, date: "2026-01-02", sets: [], daily_session: { id: 9, version: 2 } };
  const { deps, writes } = makeDeps({
    peekCached: (key) => cache.has(key) ? { data: cache.get(key), fresh: true } : null,
    cachedApi: async (path) => {
      if (!path.startsWith("/today?")) return null;
      cache.set("today:session:2026-01-02", prepared);
      return {
        date: "2026-01-02",
        plan: [],
        session: { id: 12, date: "2026-01-02", sets: [], daily_session: null },
        stats: {},
        profile: {},
        exercises: [],
      };
    },
  });
  const originalStore = deps.storeCached;
  deps.storeCached = (key, data) => {
    cache.set(key, data);
    originalStore(key, data);
  };

  const result = await loader.load({}, deps);

  assert.deepEqual(result.session, prepared);
  assert.deepEqual(cache.get("today:session:2026-01-02"), prepared);
  assert.equal(writes.some((row) => row.key === "today:session:2026-01-02"), false);
});

test("Today data loader falls back to independent reads when the aggregate is unavailable", async () => {
  const loader = loadDataLoader();
  const { deps, calls } = makeDeps({
    cachedApi: async (path) => {
      if (path.startsWith("/today?")) throw new Error("offline");
      return null;
    },
  });

  const result = await loader.load({}, deps);
  await Promise.all(result.revalidations);

  assert.deepEqual(
    calls.filter((call) => call[0] === "api").map((call) => call[1]),
    ["/plan", "/sessions?date=2026-01-02", "/stats", "/profile", "/exercises"],
  );
  assert.equal(result.revalidations.length, 5);
  assert.deepEqual(deps.state.plan, [{ day_number: 1, name: "Fallback", items: [] }]);
});

// ---- the fan-in: one aggregate on the warm path too, and its prep slices ----

function aggregatePayload(extra = {}) {
  return {
    date: "2026-01-02",
    plan: [{ day_number: 1, name: "Aggregate", items: [] }],
    session: { id: 7, date: "2026-01-02", sets: [] },
    stats: { week_sets: 3 },
    profile: { name: "Aggregate" },
    exercises: [{ id: 1, name: "Back Squat" }],
    ...extra,
  };
}

function warmPeeks(overrides = {}) {
  return {
    plan: { data: [{ day_number: 1, name: "Warm", items: [] }], fresh: true },
    "today:session:2026-01-02": { data: { id: 7, date: "2026-01-02", sets: [] }, fresh: true },
    stats: { data: { week_sets: 3 }, fresh: true },
    profile: { data: { name: "Warm" }, fresh: true },
    exercises: { data: [{ id: 1, name: "Back Squat" }], fresh: true },
    ...overrides,
  };
}

test("a warm Today open revalidates through ONE aggregate, not five separate reads", async () => {
  const loader = loadDataLoader();
  const cache = warmPeeks();
  const { deps, calls } = makeDeps({
    peekCached: (key) => cache[key] || null,
    cachedApi: async (_path, options = {}) => {
      const payload = aggregatePayload();
      if (options.onUpgrade) options.onUpgrade(payload, { changed: true });
      return payload;
    },
  });

  const result = await loader.load({}, deps);
  await Promise.all(result.revalidations);

  const requested = calls.filter((call) => call[0] === "cached" || call[0] === "api");
  assert.deepEqual(requested, [["cached", "/today?date=2026-01-02", "today:aggregate:2026-01-02"]]);
  assert.equal(result.revalidations.length, 1);
  // The warm paint still comes from the cache, and the background aggregate is a
  // per-render read, so its agenda must never be offered to the screen.
  assert.equal(result.aggregateFresh, false);
  assert.equal(result.agenda, null);
  assert.deepEqual([...result.primedLastSets], []);
});

test("a cold Today open still costs exactly one request", async () => {
  const loader = loadDataLoader();
  const { deps, calls } = makeDeps();

  const result = await loader.load({}, deps);
  await Promise.all(result.revalidations);

  assert.deepEqual(
    calls.filter((call) => call[0] === "cached" || call[0] === "api"),
    [["cached", "/today?date=2026-01-02", "today:aggregate:2026-01-02"]],
  );
  assert.equal(result.revalidations.length, 0);
});

test("a warm aggregate writes a slice only when it changed and nothing newer owns the key", async () => {
  const loader = loadDataLoader();
  const cache = warmPeeks();
  const { deps, writes } = makeDeps({
    peekCached: (key) => cache[key] || null,
    cachedApi: async (_path, options = {}) => {
      // A set logged while the request was in flight: the session key moved.
      cache["today:session:2026-01-02"] = { data: { id: 7, date: "2026-01-02", sets: [{ id: 1 }] }, fresh: true };
      const payload = aggregatePayload();
      if (options.onUpgrade) options.onUpgrade(payload, { changed: true });
      return payload;
    },
  });

  const result = await loader.load({}, deps);
  await Promise.all(result.revalidations);

  // profile changed ("Warm" -> "Aggregate"); stats/exercises did not; the session
  // key is owned by the newer write and must not be clobbered by the older read.
  assert.deepEqual(writes.map((row) => row.key), ["plan", "profile"]);
  assert.equal(result.changed(), true);
});

test("a fresh aggregate primes the prep keys and reports what it covered", async () => {
  const loader = loadDataLoader();
  const { deps, writes } = makeDeps({
    cachedApi: async (_path, options = {}) => {
      const payload = aggregatePayload({
        last_sets: { "Back Squat": { weight: 225, reps: 5 }, "Barbell Row": null },
        progression_day: 1,
        progression: [{ exercise: "Back Squat", action: "push" }],
        strength_journey: { available: false },
        agenda: { primary: [], more: [] },
        coaching_focus: { lead: { domain: "training" } },
      });
      if (options.onUpgrade) options.onUpgrade(payload, { changed: true });
      return payload;
    },
  });

  const result = await loader.load({}, deps);

  const written = Object.fromEntries(writes.map((row) => [row.key, row.data]));
  assert.deepEqual(written["last-set:Back Squat"], { weight: 225, reps: 5 });
  assert.equal(written["last-set:Barbell Row"], null);
  assert.deepEqual(written["program:progression:1"], [{ exercise: "Back Squat", action: "push" }]);
  assert.deepEqual([...result.primedLastSets], ["Back Squat", "Barbell Row"]);
  assert.equal(result.primedProgressionDay, 1);
  assert.equal(result.aggregateFresh, true);
  assert.deepEqual(result.agenda, { primary: [], more: [] });
  assert.deepEqual(result.coachingFocus, { lead: { domain: "training" } });
  assert.deepEqual(result.strengthJourney, { available: false });
});

test("a background aggregate only FILLS an empty last-set key, never overwrites one", async () => {
  const loader = loadDataLoader();
  const cache = warmPeeks({ "last-set:Back Squat": { data: { weight: 245, reps: 3 }, fresh: true } });
  const { deps, writes } = makeDeps({
    peekCached: (key) => cache[key] || null,
    cachedApi: async (_path, options = {}) => {
      const payload = aggregatePayload({
        last_sets: { "Back Squat": { weight: 225, reps: 5 }, "Bench Press": { weight: 165, reps: 5 } },
      });
      if (options.onUpgrade) options.onUpgrade(payload, { changed: true });
      return payload;
    },
  });

  const result = await loader.load({}, deps);
  await Promise.all(result.revalidations);

  const keys = writes.map((row) => row.key);
  assert.equal(keys.includes("last-set:Back Squat"), false);
  assert.equal(keys.includes("last-set:Bench Press"), true);
  assert.deepEqual([...result.primedLastSets], []);
});
