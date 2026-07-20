import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function classList() {
  const classes = new Set();
  return {
    add: (name) => classes.add(name),
    remove: (name) => classes.delete(name),
    toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    contains: (name) => classes.has(name),
  };
}

function storageFrom(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    getItem: (key) => data.get(key) || null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    key: (index) => [...data.keys()][index] || null,
    has: (key) => data.has(key),
    keys: () => [...data.keys()],
  };
}

function loadSwrCache({ storage = storageFrom(), apiImpl } = {}) {
  let response = { ok: true };
  const calls = [];
  const renders = [];
  const context = {
    Date,
    JSON,
    Map,
    Math,
    Error,
    Promise,
    localStorage: storage,
    document: { body: { classList: classList() } },
    state: { tab: "today" },
    pollToken: 1,
    skelSwap(fn) {
      fn();
    },
    api: async (path) => {
      calls.push(path);
      if (apiImpl) return apiImpl(path);
      return response;
    },
  };
  vm.runInNewContext(readFileSync(join(root, "public/js/swr-cache.js"), "utf8"), context);
  return {
    context,
    storage,
    calls,
    renders,
    setResponse(next) {
      response = next;
    },
  };
}

test("SWR cache stores normal payloads in memory and localStorage", async () => {
  const loaded = loadSwrCache();

  await loaded.context.cachedApi("/profile", { key: "profile" });

  assert.equal(loaded.calls[0], "/profile");
  assert.deepEqual(loaded.context.peekCached("profile").data, { ok: true });
  assert.equal(loaded.storage.has("cairn.swr.v1.profile"), true);
});

test("SWR cache can be primed directly from mutation results", () => {
  const loaded = loadSwrCache();

  loaded.context.swrSet("today:session:2026-07-01", { id: 12, finished_at: "2026-07-01T14:00:00Z" });

  assert.deepEqual(loaded.context.peekCached("today:session:2026-07-01").data, {
    id: 12,
    finished_at: "2026-07-01T14:00:00Z",
  });
  assert.equal(loaded.storage.has("cairn.swr.v1.today:session:2026-07-01"), true);
});

test("an older revalidate cannot overwrite a newer mutation result", async () => {
  let resolveRead;
  const loaded = loadSwrCache({
    apiImpl: () => new Promise((resolve) => { resolveRead = resolve; }),
  });
  const upgrades = [];
  const read = loaded.context.cachedApi("/sessions?date=2026-07-01", {
    key: "today:session:2026-07-01",
    onUpgrade: (data) => upgrades.push(data),
  });
  await new Promise((resolve) => setImmediate(resolve));

  const prepared = { id: 22, daily_session: { id: 7, version: 2 } };
  loaded.context.swrSet("today:session:2026-07-01", prepared);
  resolveRead({ id: 12, daily_session: null });

  assert.deepEqual(await read, prepared);
  assert.deepEqual(loaded.context.peekCached("today:session:2026-07-01").data, prepared);
  assert.deepEqual(upgrades, [], "superseded GET must not repaint");
});

test("optimisticMutation primes locally, commits server truth, and rolls back on failure", async () => {
  const loaded = loadSwrCache();
  const changes = [];

  await loaded.context.optimisticMutation({
    key: "me:memory",
    apply: (current) => [{ id: -1, content: "draft" }, ...(current || [])],
    request: async () => ({ id: 7, content: "server" }),
    commit: (current, result) => current.map((row) => row.id === -1 ? result : row),
    onChange: (data, meta) => changes.push({ data, phase: meta.phase }),
  });

  assert.deepEqual(loaded.context.peekCached("me:memory").data, [{ id: 7, content: "server" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(changes)), [
    { data: [{ id: -1, content: "draft" }], phase: "optimistic" },
    { data: [{ id: 7, content: "server" }], phase: "commit" },
  ]);

  await assert.rejects(
    loaded.context.optimisticMutation({
      key: "me:memory",
      apply: () => [{ id: 8, content: "bad" }],
      request: async () => { throw new Error("offline"); },
      onChange: (data, meta) => changes.push({ data, phase: meta.phase }),
    }),
    /offline/,
  );
  assert.deepEqual(loaded.context.peekCached("me:memory").data, [{ id: 7, content: "server" }]);
  assert.equal(changes.at(-1).phase, "rollback");
});

test("SWR cache keeps markers and recovery payloads memory-only", async () => {
  const loaded = loadSwrCache();

  await loaded.context.cachedApi("/markers/priority", { key: "markers:priority" });
  await loaded.context.cachedApi("/recovery?days=14", { key: "recovery:14" });

  assert.deepEqual(loaded.context.peekCached("markers:priority").data, { ok: true });
  assert.deepEqual(loaded.context.peekCached("recovery:14").data, { ok: true });
  assert.equal(loaded.storage.has("cairn.swr.v1.markers:priority"), false);
  assert.equal(loaded.storage.has("cairn.swr.v1.recovery:14"), false);
});

test("SWR invalidation removes exact and prefix cache entries", async () => {
  const loaded = loadSwrCache();
  await loaded.context.cachedApi("/profile", { key: "profile" });
  await loaded.context.cachedApi("/stats", { key: "progress:stats" });
  await loaded.context.cachedApi("/volume", { key: "progress:volume" });

  loaded.context.swrInvalidate("profile");
  assert.equal(loaded.context.peekCached("profile"), null);
  assert.equal(loaded.storage.has("cairn.swr.v1.profile"), false);

  loaded.context.swrInvalidate("progress:");
  assert.equal(loaded.context.peekCached("progress:stats"), null);
  assert.equal(loaded.context.peekCached("progress:volume"), null);
  assert.equal(loaded.storage.keys().some((key) => key.startsWith("cairn.swr.v1.progress:")), false);
});

test("paintSWR renders warm data first and upgrades only changed payloads", async () => {
  const loaded = loadSwrCache();
  await loaded.context.cachedApi("/profile", { key: "profile" });
  loaded.setResponse({ ok: true, name: "updated" });

  await loaded.context.paintSWR({
    key: "profile",
    path: "/profile",
    render: (data, meta) => loaded.renders.push({ data, meta }),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(loaded.renders)), [
    { data: { ok: true }, meta: { warm: true } },
    { data: { ok: true, name: "updated" }, meta: { warm: false } },
  ]);
});

test("swrSweep evicts stale rows and caps retained localStorage entries", () => {
  const now = Date.now();
  const initial = { "cairn.swr.v1.old": JSON.stringify({ data: "old", ts: now - 25 * 60 * 60 * 1000 }) };
  for (let i = 0; i < 45; i++) {
    initial[`cairn.swr.v1.row-${String(i).padStart(2, "0")}`] = JSON.stringify({ data: i, ts: now - i });
  }
  const loaded = loadSwrCache({ storage: storageFrom(initial) });

  loaded.context.swrSweep();

  assert.equal(loaded.storage.has("cairn.swr.v1.old"), false);
  assert.equal(loaded.storage.keys().filter((key) => key.startsWith("cairn.swr.v1.")).length, 40);
});
