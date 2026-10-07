// index.html's early reads (window.__cairnEarly) are requested at boot, before any
// write. A cold lazy deep link parks up to a dozen of them, and a destination the
// athlete navigated away from never takes its own — so a write MUST drop the table,
// or a later read is answered with a body from before the write and remembered as
// current truth (api-core.ts forgetReads; today-prefetch.ts takeEarly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

function load() {
  const fetched = [];
  const stored = new Map();
  const context = {
    Error,
    TypeError,
    Promise,
    Object,
    JSON,
    String,
    Number,
    Map,
    Set,
    Array,
    Math,
    Date,
    Intl,
    setOffline: () => {},
    addEventListener() {},
    localStorage: {
      getItem: (k) => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => stored.set(k, String(v)),
      removeItem: (k) => stored.delete(k),
      key: (i) => [...stored.keys()][i] ?? null,
      get length() {
        return stored.size;
      },
    },
    fetch: (url, init) => {
      fetched.push({ url, method: (init && init.method) || "GET" });
      return Promise.resolve({ status: 200, headers: { get: () => null }, json: async () => ({ fresh: true }) });
    },
  };
  context.globalThis = context;
  context.window = context;
  for (const file of ["public/js/api-cache.js", "public/js/api-reach.js", "public/js/api-auth.js", "public/js/api-core.js", "public/js/today-prefetch.js"]) {
    vm.runInNewContext(read(file), context);
  }
  const early = (body) => ({
    at: Date.now(),
    res: Promise.resolve({ status: 200, headers: { get: () => null }, json: async () => body }),
  });
  const park = () => {
    context.__cairnEarly = { "/directives": early({ stale: true }), "/plan": early({ stale: true }) };
  };
  return { context, fetched, park };
}

test("an early read parked at boot is handed over while nothing has been written", async () => {
  const { context, fetched, park } = load();
  park();
  const body = await context.api("/directives");
  assert.equal(body.stale, true, "the boot-time response is the answer");
  assert.equal(fetched.length, 0, "no second request");
});

test("a local write drops every early read: the next read asks the network", async () => {
  const { context, fetched, park } = load();
  park();
  await context.api("/directives/7", { method: "PATCH", body: "{}" });
  assert.equal(context.CairnTodayPrefetch.takeEarly("/plan"), undefined, "no pre-write body survives");
  const body = await context.api("/directives");
  assert.deepEqual({ ...body }, { fresh: true });
  assert.deepEqual(
    fetched.map((f) => `${f.method} ${f.url}`),
    ["PATCH /api/directives/7", "GET /api/directives"]
  );
});

test("a write that landed elsewhere (apiInvalidate) drops them too", () => {
  const { context, park } = load();
  park();
  context.apiInvalidate();
  assert.equal(context.CairnTodayPrefetch.takeEarly("/directives"), undefined);
  assert.equal(context.__cairnEarly, undefined);
});

test("forgetting every remembered body (a 401, a new token) drops them too", () => {
  const { context, park } = load();
  park();
  context.clearRememberedApiBodies();
  assert.equal(context.CairnTodayPrefetch.takeEarly("/directives"), undefined);
});
