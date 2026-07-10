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
    contains: (name) => classes.has(name),
  };
}

// A generic enough DOM element stand-in that code paths which build small UI
// (the offline bar, the token-entry sheet) can run end-to-end without throwing,
// even though nothing is actually rendered.
function fakeElement() {
  return {
    classList: classList(),
    className: "",
    attrs: {},
    innerHTML: "",
    textContent: "",
    hidden: false,
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    getAttribute(name) {
      return this.attrs[name];
    },
    appendChild(child) {
      return child;
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
  };
}

// `withTimers: true` adds a controllable fake setTimeout/clearTimeout (so the
// GET-timeout wiring can be exercised without a real 20s wait) plus the real
// Node AbortController — omitted by default so the two pre-existing tests below
// keep proving the graceful no-AbortController/no-setTimeout degrade path.
function loadApiClient({ withTimers = false } = {}) {
  const storage = new Map();
  let offlineBar = null;
  const listeners = {};
  const body = {
    classList: classList(),
    appendChild(el) {
      if (el && el.className === "offline-bar") offlineBar = el;
      return el;
    },
  };
  const document = {
    body,
    head: { appendChild: (el) => el },
    querySelector(selector) {
      return selector === ".offline-bar" ? offlineBar : null;
    },
    getElementById() {
      return null;
    },
    createElement() {
      return fakeElement();
    },
  };
  const calls = [];
  const context = {
    document,
    window: {
      addEventListener(type, fn) {
        listeners[type] = fn;
      },
      prompt() {
        return "";
      },
    },
    navigator: { onLine: true },
    location: {
      reloaded: false,
      reload() {
        this.reloaded = true;
      },
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "America/New_York" }) }) },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { status: 200, json: async () => ({ ok: true }) };
    },
    requestAnimationFrame: (fn) => fn(),
    encodeURIComponent,
    Promise,
  };
  const timers = [];
  if (withTimers) {
    context.AbortController = AbortController;
    context.setTimeout = (fn, delay) => {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    };
    context.clearTimeout = (timer) => {
      if (timer) timer.cleared = true;
    };
  }
  vm.runInNewContext(readFileSync(join(root, "public/js/api-client.js"), "utf8"), context);
  // Loading with `window` + `setTimeout` both present also arms the module's own
  // boot-time outbox-flush timer (api-client.ts's trailing `if (typeof window
  // !== "undefined") { ... setTimeout(() => flushOutbox(), 0) }` block) — drop
  // it so `timers` only reflects what the test itself triggers via api().
  if (withTimers) timers.length = 0;
  return { context, storage, calls, body, listeners, timers, getOfflineBar: () => offlineBar };
}

test("api client appends auth tokens to direct resource URLs", () => {
  const { context, storage } = loadApiClient();
  assert.equal(context.withToken("/api/export"), "/api/export");

  storage.set("cairn_token", "owner token");
  assert.equal(context.authToken(), "owner token");
  assert.equal(context.withToken("/api/export"), "/api/export?token=owner%20token");
  assert.equal(context.withToken("/api/export?format=db"), "/api/export?format=db&token=owner%20token");
});

test("api client sends auth and timezone headers on API calls", async () => {
  const { context, storage, calls } = loadApiClient();
  storage.set("cairn_token", "secret");

  const payload = await context.api("/health", { headers: { "X-Test": "1" } });

  assert.deepEqual(payload, { ok: true });
  assert.equal(calls[0].url, "/api/health");
  assert.equal(calls[0].init.headers["X-Test"], "1");
  assert.equal(calls[0].init.headers["X-Cairn-Token"], "secret");
  assert.equal(calls[0].init.headers["X-Cairn-TZ"], "America/New_York");
});

test("api client surfaces and clears the offline hairline", async () => {
  const loaded = loadApiClient();
  loaded.context.fetch = async () => {
    throw new Error("offline");
  };

  await assert.rejects(loaded.context.api("/health"), /Could not reach Cairn/);
  assert.equal(loaded.body.classList.contains("is-offline"), true);
  assert.equal(loaded.getOfflineBar().classList.contains("show"), true);

  loaded.context.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) });
  await loaded.context.api("/health");
  assert.equal(loaded.body.classList.contains("is-offline"), false);
  assert.equal(loaded.getOfflineBar().classList.contains("show"), false);
});

test("api() dedupes concurrent identical GET calls into a single fetch", async () => {
  const loaded = loadApiClient();
  let fetchCount = 0;
  loaded.context.fetch = async () => {
    fetchCount++;
    return { status: 200, json: async () => ({ n: fetchCount }) };
  };

  const p1 = loaded.context.api("/stats");
  const p2 = loaded.context.api("/stats");
  assert.equal(fetchCount, 1, "the second concurrent call joins the first instead of firing its own fetch");

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, { n: 1 });
  assert.deepEqual(r2, { n: 1 }, "both callers resolve to the same single response");
  assert.equal(fetchCount, 1);
});

test("api() never dedupes non-GET calls — every write actually lands", async () => {
  const loaded = loadApiClient();
  let fetchCount = 0;
  loaded.context.fetch = async () => {
    fetchCount++;
    return { status: 200, json: async () => ({ ok: true }) };
  };

  const p1 = loaded.context.api("/sets", { method: "POST", body: "{}" });
  const p2 = loaded.context.api("/sets", { method: "POST", body: "{}" });
  assert.equal(fetchCount, 2, "two concurrent POSTs to the same path each fire their own fetch");
  await Promise.all([p1, p2]);
  assert.equal(fetchCount, 2);
});

test("api() dedupe entry clears on a rejected fetch so a retry actually re-fetches", async () => {
  const loaded = loadApiClient();
  loaded.context.fetch = async () => {
    throw new Error("down");
  };
  await assert.rejects(loaded.context.api("/stats"));

  let fetchCount = 0;
  loaded.context.fetch = async () => {
    fetchCount++;
    return { status: 200, json: async () => ({ ok: true }) };
  };
  await loaded.context.api("/stats");
  assert.equal(fetchCount, 1, "the failed attempt didn't wedge the path — the retry actually hit the network");
});

test("api() dedupe entry clears on a 401 so it never wedges the path — each caller independently hangs", async () => {
  const loaded = loadApiClient();
  let fetchCount = 0;
  loaded.context.fetch = async () => {
    fetchCount++;
    return { status: 401, json: async () => ({ error: "unauthorized" }) };
  };

  const p1 = loaded.context.api("/profile");
  const p2 = loaded.context.api("/profile");
  assert.equal(fetchCount, 1, "both 401 callers shared the one fetch");

  // Let the shared fetch fully settle — fetch -> the 401 check -> the internal
  // cleanup .finally -> share()'s own release is several microtask ticks, more
  // than racing against an already-resolved promise would flush. A real macro-
  // task boundary (setImmediate) guarantees every one of those ticks has run,
  // same as any real elapsed time would in the browser (a retry only happens
  // after a human re-enters a token, long after this settles).
  await new Promise((resolve) => setImmediate(resolve));

  // The in-flight slot is free — a LATER call to the same path hits the network
  // again rather than joining the still-unsettled hung promises above.
  loaded.context.fetch = async () => {
    fetchCount++;
    return { status: 200, json: async () => ({ ok: true }) };
  };
  await loaded.context.api("/profile");
  assert.equal(
    fetchCount,
    2,
    "the dedupe slot was released the moment the 401 response arrived, not when the caller promise settles"
  );

  // p1/p2 themselves must still never settle — the per-caller hang is
  // independent of the dedupe-slot release proven above.
  const sentinel = Symbol("still-pending");
  const race1 = await Promise.race([p1, Promise.resolve(sentinel)]);
  const race2 = await Promise.race([p2, Promise.resolve(sentinel)]);
  assert.equal(race1, sentinel, "the first caller's promise never settles");
  assert.equal(race2, sentinel, "the second caller's promise never settles");
});

test("api() micro-caches /settings within the TTL window; any write invalidates it", async () => {
  const loaded = loadApiClient();
  let fetchCount = 0;
  loaded.context.fetch = async (url) => {
    fetchCount++;
    return { status: 200, json: async () => ({ n: fetchCount, url }) };
  };

  const first = await loaded.context.api("/settings");
  assert.equal(first.n, 1);
  const second = await loaded.context.api("/settings");
  assert.equal(fetchCount, 1, "served from the micro-cache — no second round trip");
  // Compare fields, not object identity: the cached value round-trips through
  // the vm context's OWN JSON.parse (no structuredClone injected here), so its
  // plain-object prototype differs from `first`'s outer-realm one — a real
  // cross-realm artifact of this test harness, not a product behavior.
  assert.equal(second.n, first.n);
  assert.equal(second.url, first.url);

  await loaded.context.api("/sets", { method: "POST", body: "{}" });
  assert.equal(fetchCount, 2, "the write itself always hits the network");

  const third = await loaded.context.api("/settings");
  assert.equal(fetchCount, 3, "the prior write invalidated the micro-cache, so this GET actually re-fetches");
  assert.equal(third.n, 3);
});

test("api() only micro-caches the four allowlisted paths — a query-param'd or other GET is never cached", async () => {
  const loaded = loadApiClient();
  let fetchCount = 0;
  loaded.context.fetch = async () => {
    fetchCount++;
    return { status: 200, json: async () => ({ n: fetchCount }) };
  };
  await loaded.context.api("/today?date=2026-07-09");
  await loaded.context.api("/today?date=2026-07-09");
  assert.equal(fetchCount, 2, "a query-param'd path always re-fetches (no in-window overlap here)");
});

test("api() bypasses dedupe and the micro-cache for a caller-supplied signal or cache option", async () => {
  const loaded = loadApiClient();
  let fetchCount = 0;
  loaded.context.fetch = async () => {
    fetchCount++;
    return { status: 200, json: async () => ({ n: fetchCount }) };
  };

  const p1 = loaded.context.api("/stats", { signal: {} });
  const p2 = loaded.context.api("/stats");
  await Promise.all([p1, p2]);
  assert.equal(fetchCount, 2, "a caller-supplied signal opts that call out of sharing with a concurrent plain GET");

  await loaded.context.api("/settings");
  assert.equal(fetchCount, 3);
  const bypassed = await loaded.context.api("/settings", { cache: "no-store" });
  assert.equal(fetchCount, 4, "a cache option always goes to the network, ignoring the micro-cache");
  assert.equal(bypassed.n, 4);

  const normalAgain = await loaded.context.api("/settings");
  assert.equal(fetchCount, 4, "the bypassed call's result was never stored, so the ORIGINAL cached value still serves");
  assert.equal(normalAgain.n, 3);
});

test("api() arms a 20s GET timeout with no caller signal, and clears it on a normal resolve", async () => {
  const loaded = loadApiClient({ withTimers: true });
  loaded.context.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) });

  await loaded.context.api("/stats");
  assert.equal(loaded.timers.length, 1, "a timeout timer was armed for this GET");
  assert.equal(loaded.timers[0].delay, 20000);
  assert.equal(loaded.timers[0].cleared, true, "resolving before the timeout clears it");
});

test("api() timing out aborts the fetch and reads exactly like a network drop (offline hairline)", async () => {
  const loaded = loadApiClient({ withTimers: true });
  loaded.context.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });

  const pending = loaded.context.api("/stats");
  assert.equal(loaded.timers.length, 1);
  loaded.timers[0].fn(); // simulate the 20s elapsing

  await assert.rejects(pending, /timed out/i);
  assert.equal(
    loaded.body.classList.contains("is-offline"),
    true,
    "a timeout surfaces the calm offline hairline, same as any other network drop"
  );
});

test("api() does not arm its own timeout when the caller passes a signal", async () => {
  const loaded = loadApiClient({ withTimers: true });
  const controller = new AbortController();
  loaded.context.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) });

  await loaded.context.api("/stats", { signal: controller.signal });
  assert.equal(loaded.timers.length, 0, "the caller owns cancellation here, so no safety timer is created");
});

test("api() never arms a timeout for a non-GET call", async () => {
  const loaded = loadApiClient({ withTimers: true });
  loaded.context.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) });

  await loaded.context.api("/sets", { method: "POST", body: "{}" });
  assert.equal(loaded.timers.length, 0, "a slow health-doc-style upload must never be timed out");
});

test("api() classifies reachable HTTP failures without marking Cairn offline", async () => {
  const loaded = loadApiClient();
  loaded.context.fetch = async () => ({
    status: 503,
    headers: { get: (name) => (name.toLowerCase() === "x-request-id" ? "req-503" : null) },
    json: async () => ({ error: "internal error" }),
  });

  await assert.rejects(loaded.context.api("/today?private=value"), (error) => {
    assert.equal(error.name, "CairnApiError");
    assert.equal(error.kind, "http");
    assert.equal(error.status, 503);
    assert.equal(error.route, "/today");
    assert.equal(error.requestId, "req-503");
    return true;
  });
  assert.equal(loaded.body.classList.contains("is-offline"), false);
});

test("api() can opt into a bounded non-2xx readiness body", async () => {
  const loaded = loadApiClient();
  loaded.context.fetch = async (url, init) => {
    loaded.calls.push({ url, init });
    return {
      status: 503,
      headers: { get: () => null },
      json: async () => ({ ok: false, database: "ok", scheduler: { status: "stale" } }),
    };
  };

  const readiness = await loaded.context.api("/ready", { cache: "no-store", acceptErrorBody: true });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.scheduler.status, "stale");
  assert.equal(loaded.calls[0].init.acceptErrorBody, undefined, "client-only options never leak into fetch");
});

test("api() classifies invalid successful JSON and does not cache it", async () => {
  const loaded = loadApiClient();
  let calls = 0;
  loaded.context.fetch = async () => {
    calls++;
    return {
      status: 200,
      headers: { get: () => "req-json" },
      json: async () => {
        throw new SyntaxError("bad json");
      },
    };
  };

  await assert.rejects(loaded.context.api("/settings"), (error) => {
    assert.equal(error.kind, "invalid_json");
    assert.equal(error.requestId, "req-json");
    return true;
  });
  await assert.rejects(loaded.context.api("/settings"));
  assert.equal(calls, 2, "an invalid response never enters the successful GET cache");
  assert.equal(loaded.body.classList.contains("is-offline"), false);
});

test("api() preserves designed HTTP-200 ok:false outcomes", async () => {
  const loaded = loadApiClient();
  loaded.context.fetch = async () => ({
    status: 200,
    headers: { get: () => "req-app" },
    json: async () => ({ ok: false, error: "try another agent" }),
  });
  assert.deepEqual(await loaded.context.api("/session-suggest"), { ok: false, error: "try another agent" });
  assert.equal(loaded.body.classList.contains("is-offline"), false);
});

test("api() reports bounded failure metadata without query or payload content", async () => {
  const loaded = loadApiClient();
  const events = [];
  loaded.context.CairnClientDiagnostics = { report: (event) => events.push(event) };
  loaded.context.fetch = async () => ({
    status: 422,
    headers: { get: () => "req-safe" },
    json: async () => ({ error: "private response body" }),
  });

  await assert.rejects(
    loaded.context.api("/health?token=private", { method: "POST", body: JSON.stringify({ chat: "private body" }) })
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].route, "/api/health");
  assert.match(events[0].route, /^\/api(?:\/|$)/, "the ingest contract accepts only normalized API routes");
  assert.equal(events[0].method, "POST");
  assert.equal(events[0].status, 422);
  assert.equal(events[0].request_id, "req-safe");
  assert.doesNotMatch(JSON.stringify(events[0]), /private|token=|chat/);
});

test("runtime outbox marks permanent HTTP failures and sends its stable idempotency key", async () => {
  const loaded = loadApiClient();
  let sentInit;
  loaded.context.fetch = async (_url, init) => {
    sentInit = init;
    return { status: 400, headers: { get: () => "req-outbox" }, json: async () => ({ error: "invalid" }) };
  };
  const item = loaded.context.outboxEnqueue("set", "/sets", { reps: 8 });
  await loaded.context.flushOutbox();
  const stored = JSON.parse(loaded.storage.get("cairn.outbox.v1"));
  assert.equal(stored[0].state, "needs_attention");
  assert.equal(stored[0].failure_status, 400);
  assert.equal(sentInit.headers["X-Idempotency-Key"], item.id);
});
