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
    peekCached: (key) => peeks[key] || null,
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
