import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load the compiled api-client (which carries the api() coalescer core) in a
// bare context — no window/document/navigator/fetch/setTimeout/AbortController,
// so the runtime wiring (api(), buildFetchInit) all self-gates off and we're
// left with the pure createApiCoalescer + decision-helper core to exercise, the
// same pattern test/clientOutbox.test.js uses for createOutbox. Deliberately NOT
// providing `structuredClone` here exercises the JSON round-trip clone fallback;
// a separate loader below adds it back to cover the structuredClone path too.
function loadApiCache({ withStructuredClone = false } = {}) {
  const context = { Date, JSON, Math, Array, Object, String, Number, Promise, Set, Map };
  context.globalThis = context;
  if (withStructuredClone) context.structuredClone = (v) => JSON.parse(JSON.stringify(v));
  vm.runInNewContext(readFileSync(join(root, "public/js/api-client.js"), "utf8"), context);
  return context.CairnApiCache;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------- pure decision helpers ----------

test("shouldBypassApiCache: true only when the caller brings a signal or cache option", () => {
  const { shouldBypassApiCache } = loadApiCache();
  assert.equal(shouldBypassApiCache({}), false);
  assert.equal(shouldBypassApiCache({ headers: { "X-Test": "1" } }), false);
  assert.equal(shouldBypassApiCache({ signal: {} }), true);
  assert.equal(shouldBypassApiCache({ cache: "no-store" }), true);
  assert.equal(shouldBypassApiCache({ signal: {}, cache: "no-store" }), true);
});

test("shouldArmGetTimeout: GET with no caller signal arms; POST or a caller signal never does", () => {
  const { shouldArmGetTimeout } = loadApiCache();
  assert.equal(shouldArmGetTimeout("GET", {}), true);
  assert.equal(shouldArmGetTimeout("get", {}), true, "method is case-insensitive");
  assert.equal(shouldArmGetTimeout("GET", { signal: {} }), false, "caller's own signal disarms the timeout");
  assert.equal(shouldArmGetTimeout("POST", {}), false, "never on non-GET");
  assert.equal(shouldArmGetTimeout("POST", { signal: {} }), false);
});

// ---------- in-flight dedupe (share) ----------

test("share: concurrent calls to the same path join one in-flight start()", () => {
  const { createApiCoalescer } = loadApiCache();
  const c = createApiCoalescer({});
  let starts = 0;
  const d = deferred();
  const start = () => {
    starts++;
    return d.promise;
  };

  const p1 = c.share("/stats", start);
  const p2 = c.share("/stats", start);
  assert.equal(starts, 1, "the second concurrent caller joins the first instead of re-invoking start()");
  assert.equal(p1, p2, "both callers get the exact same shared promise");
  assert.equal(c.inFlightCount(), 1);

  d.resolve({ status: 200, body: { ok: true } });
  return p1.then((v) => {
    assert.deepEqual(v, { status: 200, body: { ok: true } });
  });
});

test("share: different paths never join", () => {
  const { createApiCoalescer } = loadApiCache();
  const c = createApiCoalescer({});
  let starts = 0;
  const start = () => {
    starts++;
    return Promise.resolve(starts);
  };
  c.share("/settings", start);
  c.share("/profile", start);
  assert.equal(starts, 2);
});

test("share: the in-flight entry clears when the shared promise settles (success) — a later call re-fetches", async () => {
  const { createApiCoalescer } = loadApiCache();
  const c = createApiCoalescer({});
  let starts = 0;
  const first = c.share("/stats", () => {
    starts++;
    return Promise.resolve({ status: 200, body: starts });
  });
  await first;
  assert.equal(c.inFlightCount(), 0, "cleared once the shared promise settles");

  const second = c.share("/stats", () => {
    starts++;
    return Promise.resolve({ status: 200, body: starts });
  });
  const result = await second;
  assert.equal(starts, 2, "a fresh call after settle re-invokes start(), it does not reuse the stale promise");
  assert.equal(result.body, 2);
});

test("share: clears on REJECTION too — a rejected fetch doesn't wedge the path, a retry actually retries", async () => {
  const { createApiCoalescer } = loadApiCache();
  const c = createApiCoalescer({});
  let starts = 0;
  const failing = c.share("/stats", () => {
    starts++;
    return Promise.reject(new Error("network down"));
  });
  await assert.rejects(failing, /network down/);
  assert.equal(c.inFlightCount(), 0, "the entry is cleared even though the shared promise rejected");

  const retried = c.share("/stats", () => {
    starts++;
    return Promise.resolve({ status: 200, body: "ok" });
  });
  const result = await retried;
  assert.equal(starts, 2, "the retry actually re-invoked start(), it wasn't blocked by a stale entry");
  assert.equal(result.body, "ok");
});

test("share: a shared promise that RESOLVES to a 401-shaped outcome still clears immediately (never a hang in the core)", async () => {
  // api() itself is what turns a 401 outcome into a per-caller never-settling
  // promise (so the auth prompt only opens once); the core's job is only to make
  // sure the dedupe map entry is released the moment the underlying fetch
  // settles — regardless of what any individual caller later does with the value.
  const { createApiCoalescer } = loadApiCache();
  const c = createApiCoalescer({});
  const p = c.share("/profile", () => Promise.resolve({ status: 401 }));
  const outcome = await p;
  assert.equal(outcome.status, 401);
  assert.equal(c.inFlightCount(), 0, "settling with a 401 outcome still releases the in-flight slot");
});

test("share: an item enqueued mid-flight for a NEW path is independent of an in-flight old path", async () => {
  const { createApiCoalescer } = loadApiCache();
  const c = createApiCoalescer({});
  const d = deferred();
  const pending = c.share("/settings", () => d.promise);
  assert.equal(c.inFlightCount(), 1);
  const other = await c.share("/profile", () => Promise.resolve("profile-data"));
  assert.equal(other, "profile-data");
  assert.equal(c.inFlightCount(), 1, "the still-pending /settings entry is untouched");
  d.resolve("settings-data");
  await pending;
  assert.equal(c.inFlightCount(), 0);
});

// ---------- micro-TTL cache (peekFresh / store / invalidateAll) ----------

test("TTL cache: only the configured paths are cacheable — everything else never stores", () => {
  const { createApiCoalescer } = loadApiCache();
  const c = createApiCoalescer({ now: () => 0 });
  assert.equal(c.isMicroCachePath("/settings"), true);
  assert.equal(c.isMicroCachePath("/profile"), true);
  assert.equal(c.isMicroCachePath("/stats"), true);
  assert.equal(c.isMicroCachePath("/coaching-focus"), true);
  // Both are read from several Today sites inside one render burst, and those
  // bursts do not always overlap — in-flight dedupe alone misses them.
  assert.equal(c.isMicroCachePath("/exercises"), true);
  assert.equal(c.isMicroCachePath("/plan"), true);
  assert.equal(c.isMicroCachePath("/today"), false);
  assert.equal(c.isMicroCachePath("/stats?date=2026-07-09"), false, "query-param'd paths stay uncached");
  assert.equal(c.isMicroCachePath("/plan?date=2026-07-09"), false, "a dated plan read is its own request");

  c.store("/today", { a: 1 });
  assert.equal(c.cacheSize(), 0);
  assert.equal(c.peekFresh("/today"), undefined);

  c.store("/exercises", [{ name: "Back Squat" }]);
  assert.deepEqual(c.peekFresh("/exercises"), [{ name: "Back Squat" }]);
  c.invalidateAll();
  assert.equal(c.peekFresh("/exercises"), undefined, "any write still clears it");
});

test("TTL cache: serves a fresh hit within the window and expires after it", () => {
  let now = 1000;
  const { createApiCoalescer } = loadApiCache();
  const c = createApiCoalescer({ now: () => now, ttlMs: 1500 });

  c.store("/settings", { onboarded: true });
  assert.equal(c.cacheSize(), 1);
  now += 1000; // still inside the 1500ms window
  assert.deepEqual(c.peekFresh("/settings"), { onboarded: true });

  now += 600; // now 1600ms after store — past the 1500ms TTL
  assert.equal(c.peekFresh("/settings"), undefined, "expired entries are not served");
  assert.equal(c.cacheSize(), 0, "an expired peek also evicts the row");
});

test("TTL cache: any write invalidates the WHOLE micro-cache immediately", () => {
  const { createApiCoalescer } = loadApiCache();
  const c = createApiCoalescer({ now: () => 0 });
  c.store("/settings", { a: 1 });
  c.store("/profile", { b: 2 });
  assert.equal(c.cacheSize(), 2);
  c.invalidateAll();
  assert.equal(c.cacheSize(), 0);
  assert.equal(c.peekFresh("/settings"), undefined);
  assert.equal(c.peekFresh("/profile"), undefined);
});

test("TTL cache: serves a structuredClone so a caller mutating the result can't poison the cache", () => {
  const { createApiCoalescer } = loadApiCache({ withStructuredClone: true });
  const c = createApiCoalescer({ now: () => 0 });
  const original = { nested: { count: 1 } };
  c.store("/stats", original);

  const first = c.peekFresh("/stats");
  first.nested.count = 999;
  const second = c.peekFresh("/stats");
  assert.equal(second.nested.count, 1, "mutating a served value must not affect the next read");

  original.nested.count = 42;
  const third = c.peekFresh("/stats");
  assert.equal(third.nested.count, 1, "mutating the object AFTER store() must not affect what's cached");
});

test("TTL cache: falls back to a JSON round-trip clone when structuredClone is unavailable", () => {
  const { createApiCoalescer } = loadApiCache({ withStructuredClone: false });
  const c = createApiCoalescer({ now: () => 0 });
  c.store("/profile", { nested: { count: 1 } });
  const peeked = c.peekFresh("/profile");
  peeked.nested.count = 999;
  assert.equal(c.peekFresh("/profile").nested.count, 1, "still isolated without structuredClone in the environment");
});

test("TTL cache: a custom ttlPaths/ttlMs override applies to the injected list only", () => {
  const { createApiCoalescer } = loadApiCache();
  const c = createApiCoalescer({ now: () => 0, ttlMs: 5000, ttlPaths: ["/custom"] });
  assert.equal(
    c.isMicroCachePath("/settings"),
    false,
    "the default paths are not cacheable when a custom list is given"
  );
  assert.equal(c.isMicroCachePath("/custom"), true);
  c.store("/custom", { v: 1 });
  assert.deepEqual(c.peekFresh("/custom"), { v: 1 });
});

// ---------- opt-in stale-while-revalidate tier ----------

test("SWR tier: micro-cache paths are staleable by default; other paths only once opted in", () => {
  const { createApiCoalescer } = loadApiCache();
  let now = 0;
  const c = createApiCoalescer({ now: () => now });
  c.store("/coaching-focus", { v: 1 });
  c.store("/journey", { v: 1 });
  now = 60_000; // long past the micro TTL
  assert.equal(c.peekFresh("/coaching-focus"), undefined, "the micro-cache itself expired");
  const remembered = c.peekStale("/coaching-focus", 300_000);
  assert.deepEqual(remembered?.data, { v: 1 });
  assert.equal(remembered?.age, 60_000);
  assert.equal(c.peekStale("/journey", 300_000), undefined, "an un-opted path is never remembered");

  c.markStaleable("/journey");
  c.store("/journey", { v: 2 });
  assert.deepEqual(c.peekStale("/journey", 300_000)?.data, { v: 2 });
  assert.equal(c.isMicroCachePath("/journey"), false, "opting in never widens the micro-cache");
});

test("SWR tier: entries older than maxAge are dropped, and served copies are isolated", () => {
  const { createApiCoalescer } = loadApiCache();
  let now = 0;
  const c = createApiCoalescer({ now: () => now });
  c.markStaleable("/journey");
  c.store("/journey", { nested: { n: 1 } });
  const served = c.peekStale("/journey", 1000);
  served.data.nested.n = 99;
  assert.equal(c.peekStale("/journey", 1000).data.nested.n, 1, "mutating a served body never poisons the tier");
  now = 1001;
  assert.equal(c.peekStale("/journey", 1000), undefined);
  assert.equal(c.staleSize(), 0, "an expired entry is evicted on read");
});

test("SWR tier: any write clears it, and a body fetched across a write is never remembered", () => {
  const { createApiCoalescer } = loadApiCache();
  const c = createApiCoalescer({ now: () => 0 });
  c.markStaleable("/journey");
  c.store("/journey", { v: 1 });
  const genBeforeWrite = c.writeGeneration();
  c.invalidateAll();
  assert.equal(c.peekStale("/journey", 1e9), undefined, "a write clears remembered bodies");
  assert.equal(c.writeGeneration(), genBeforeWrite + 1);

  // A GET that began before the write lands after it: returned to its caller, not stored.
  c.store("/journey", { v: "pre-write" }, genBeforeWrite);
  assert.equal(c.peekStale("/journey", 1e9), undefined);
  c.store("/settings", { v: "pre-write" }, genBeforeWrite);
  assert.equal(c.peekFresh("/settings"), undefined, "the micro-cache honors the same guard");

  c.store("/journey", { v: "post-write" }, c.writeGeneration());
  assert.deepEqual(c.peekStale("/journey", 1e9)?.data, { v: "post-write" });
});

test("SWR tier: bounded — the least-recently-stored entry drops first", () => {
  const { createApiCoalescer } = loadApiCache();
  const c = createApiCoalescer({ now: () => 0, ttlPaths: [], maxStaleEntries: 2 });
  for (const p of ["/a", "/b", "/c"]) c.markStaleable(p);
  c.store("/a", 1);
  c.store("/b", 2);
  c.store("/a", 11); // re-stored → most recent
  c.store("/c", 3);
  assert.equal(c.staleSize(), 2);
  assert.equal(c.peekStale("/b", 1e9), undefined, "/b was the least recently stored");
  assert.equal(c.peekStale("/a", 1e9)?.data, 11);
  assert.equal(c.peekStale("/c", 1e9)?.data, 3);
});
