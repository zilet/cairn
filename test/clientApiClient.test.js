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
    removeAttribute(name) {
      delete this.attrs[name];
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
function loadApiClient({ withTimers = false, sharedStorage = null, locks = null } = {}) {
  const storage = sharedStorage || new Map();
  let offlineBar = null;
  let outboxBar = null;
  const listeners = {};
  const body = {
    classList: classList(),
    appendChild(el) {
      if (el && el.className === "offline-bar") offlineBar = el;
      if (el && el.className === "outbox-bar") outboxBar = el;
      return el;
    },
  };
  const document = {
    body,
    head: { appendChild: (el) => el },
    querySelector(selector) {
      if (selector === ".offline-bar") return offlineBar;
      if (selector === ".outbox-bar") return outboxBar;
      return null;
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
    navigator: { onLine: true, ...(locks ? { locks } : {}) },
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
  return {
    context,
    storage,
    calls,
    body,
    listeners,
    timers,
    getOfflineBar: () => offlineBar,
    getOutboxBar: () => outboxBar,
  };
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
  assert.equal(loaded.getOfflineBar().classList.contains("show"), true);

  loaded.context.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) });
  await loaded.context.api("/health");
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
    loaded.getOfflineBar().classList.contains("show"),
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
  assert.equal(!!loaded.getOfflineBar()?.classList.contains("show"), false);
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
  assert.equal(!!loaded.getOfflineBar()?.classList.contains("show"), false);
});

test("api() preserves designed HTTP-200 ok:false outcomes", async () => {
  const loaded = loadApiClient();
  loaded.context.fetch = async () => ({
    status: 200,
    headers: { get: () => "req-app" },
    json: async () => ({ ok: false, error: "try another agent" }),
  });
  assert.deepEqual(await loaded.context.api("/session-suggest"), { ok: false, error: "try another agent" });
  assert.equal(!!loaded.getOfflineBar()?.classList.contains("show"), false);
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
  const item = await loaded.context.outboxEnqueue("set", "/sets", { reps: 8 });
  await loaded.context.flushOutbox();
  const stored = JSON.parse(loaded.storage.get("cairn.outbox.v1"));
  assert.equal(stored[0].state, "needs_attention");
  assert.equal(stored[0].failure_status, 400);
  assert.equal(sentInit.headers["X-Idempotency-Key"], item.id);
});

test("runtime outbox replays restore mutations with DELETE and a stable idempotency key", async () => {
  const loaded = loadApiClient();
  const item = await loaded.context.outboxEnqueue(
    "restore",
    "/sessions/skip",
    { date: "2026-06-30", exercise: "Squat" },
    { method: "DELETE" }
  );

  await loaded.context.flushOutbox();

  assert.equal(loaded.calls[0].url, "/api/sessions/skip");
  assert.equal(loaded.calls[0].init.method, "DELETE");
  assert.equal(loaded.calls[0].init.headers["X-Idempotency-Key"], item.id);
  assert.equal(loaded.context.CairnOutbox.count(), 0);
});

test("canonical workout mutations share the server session group and retry in FIFO order", async () => {
  const loaded = loadApiClient();
  const date = "2026-06-30";
  loaded.context.navigator.onLine = false;
  loaded.context.peekCached = (key) => {
    if (key === `today:session:${date}`) {
      return { data: { id: 44, date, daily_session: { id: 81, date } }, fresh: true };
    }
    return null;
  };
  const first = await loaded.context.runSessionMutation(
    {
      date,
      kind: "set",
      path: "/sets",
      body: { date, exercise: "Bench", n: 1 },
    },
    async () => {
      throw new Error("offline");
    }
  );
  let bypassed = 0;
  const second = await loaded.context.runSessionMutation(
    {
      date,
      kind: "set",
      path: "/sets",
      body: { date, exercise: "Bench", n: 2 },
    },
    async () => {
      bypassed++;
      return { id: 2 };
    }
  );
  const finish = await loaded.context.runSessionMutation(
    {
      date,
      kind: "finish",
      path: "/sessions/44/finish",
      body: { notes: "done" },
      identity: { sessionId: 44 },
    },
    async () => {
      bypassed++;
      return { id: 44 };
    }
  );
  await loaded.context.outboxEnqueue("weight", "/bodyweight", { weight_lb: 180 });

  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");
  assert.equal(finish.status, "queued");
  assert.equal(bypassed, 0, "later same-group calls never bypass the durable queue");
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        loaded.context.CairnOutbox.list()
          .slice(0, 3)
          .map((item) => item.group_id)
      )
    ),
    ["session:44", "session:44", "session:44"]
  );

  let firstSetAttempts = 0;
  loaded.context.navigator.onLine = true;
  loaded.context.fetch = async (url, init) => {
    loaded.calls.push({ url, init });
    const payload = init?.body ? JSON.parse(init.body) : {};
    if (url === "/api/sets" && payload.n === 1 && firstSetAttempts++ === 0) {
      return { status: 400, headers: { get: () => null }, json: async () => ({ error: "invalid set" }) };
    }
    return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true, id: 44 }) };
  };

  await loaded.context.flushOutbox();

  assert.deepEqual(
    loaded.calls.map((call) => call.url),
    ["/api/sets", "/api/bodyweight"]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(loaded.context.CairnOutbox.reviewItems().map(({ item, role }) => [item.kind, role]))),
    [
      ["set", "attention"],
      ["set", "blocked_dependent"],
      ["finish", "blocked_dependent"],
    ]
  );

  await loaded.context.CairnOutbox.retry(first.item.id);

  assert.deepEqual(
    loaded.calls.map((call) => call.url),
    ["/api/sets", "/api/bodyweight", "/api/sets", "/api/sets", "/api/sessions/44/finish"]
  );
  assert.equal(loaded.context.CairnOutbox.count(), 0);
});

test("session and daily-composition caches resolve the same canonical workout group across tabs", () => {
  const date = "2026-06-30";
  const sessionTab = loadApiClient();
  sessionTab.context.peekCached = (key) =>
    key === `today:session:${date}` ? { data: { id: 44, date }, fresh: false } : null;
  const compositionTab = loadApiClient();
  compositionTab.context.peekCached = (key) =>
    key === `today:daily-session:${date}` ? { data: { id: 81, session_id: 44, date }, fresh: true } : null;

  assert.equal(sessionTab.context.outboxSessionGroupId(date), "session:44");
  assert.equal(compositionTab.context.outboxSessionGroupId(date), "session:44");
});

test("every central workout fallback persists its date and canonical group outside the payload", async () => {
  const loaded = loadApiClient();
  const date = "2026-06-30";
  loaded.context.navigator.onLine = false;
  const mutations = [
    { kind: "set", path: "/sets", body: { exercise: "Bench", reps: 5 } },
    { kind: "skip", path: "/sessions/skip", body: { exercise: "Squat" } },
    { kind: "restore", path: "/sessions/skip", method: "DELETE", body: { exercise: "Squat" } },
    {
      kind: "symptom_observation",
      path: "/training-symptoms/observation",
      body: { date, movement: "Bench", symptom_event_id: 9, outcome: "pain_present" },
    },
    { kind: "finish", path: "/sessions/44/finish", body: { notes: "done" } },
  ];
  for (const mutation of mutations) {
    await loaded.context.runSessionMutation(
      {
        date,
        ...mutation,
        identity: { sessionId: 44 },
      },
      async () => {
        throw new Error("offline");
      }
    );
  }

  const stored = loaded.context.CairnOutbox.list();
  assert.deepEqual(JSON.parse(JSON.stringify(stored.map((item) => item.kind))), [
    "set",
    "skip",
    "restore",
    "symptom_observation",
    "finish",
  ]);
  assert.equal(
    stored.every((item) => item.session_date === date),
    true
  );
  assert.equal(
    stored.every((item) => item.group_id === "session:44"),
    true
  );
  assert.equal(stored.find((item) => item.kind === "restore").method, "DELETE");
});

test("a staged cache pair uses its local prepare identity until reconciliation", async () => {
  const loaded = loadApiClient();
  const date = "2026-06-30";
  loaded.context.navigator.onLine = false;
  const prepare = await loaded.context.outboxEnqueue(
    "daily_session_prepare",
    "/daily-session/prepare",
    { date, source: "adaptive_plan", replace: false },
    { prepareIntent: { date, source: "adaptive_plan", items: [] } }
  );
  const daily = {
    date,
    source: "adaptive_plan",
    _staged_offline: true,
    _local_prepare_id: prepare.id,
  };
  const session = {
    date,
    daily_session: daily,
    _staged_offline: true,
    _local_prepare_id: prepare.id,
  };
  loaded.context.peekCached = (key) => (key === `today:session:${date}` ? { data: session, fresh: true } : null);
  let directCalls = 0;

  const set = await loaded.context.runSessionMutation(
    {
      date,
      kind: "set",
      path: "/sets",
      body: { date, exercise: "Bench", reps: 5 },
    },
    async () => {
      directCalls++;
      return { id: 1 };
    }
  );

  assert.equal(set.status, "queued");
  assert.equal(set.groupId, `prepare:${prepare.id}`);
  assert.equal(set.item.depends_on, prepare.id);
  assert.equal(set.item.session_date, date);
  assert.equal(directCalls, 0);
});

test("a response lost after finish commit replays the exact key and emits one review boundary", async () => {
  const loaded = loadApiClient();
  const date = "2026-06-30";
  loaded.context.navigator.onLine = false;
  const serverCache = new Map();
  let finishesApplied = 0;
  let reviewEvents = 0;
  const finishHandler = (key) => {
    if (serverCache.has(key)) return serverCache.get(key);
    finishesApplied++;
    reviewEvents++;
    const body = { ok: true, id: 44, date, finished_at: `${date}T15:00:00Z` };
    serverCache.set(key, body);
    return body;
  };
  let directKey = "";

  const result = await loaded.context.runSessionMutation(
    {
      date,
      kind: "finish",
      path: "/sessions/44/finish",
      body: { notes: "response was lost" },
      identity: { sessionId: 44 },
    },
    async (idempotencyKey) => {
      directKey = idempotencyKey;
      finishHandler(idempotencyKey);
      throw new Error("response lost after commit");
    }
  );

  assert.equal(result.status, "queued");
  assert.equal(result.item.id, directKey, "fallback preserves the pre-send mutation identity");
  assert.equal(result.item.claim_token, undefined, "transient settlement releases the direct claim generation");
  assert.equal(result.item.session_date, date, "finish date is explicit metadata, not inferred from {notes}");
  assert.equal(result.item.group_id, "session:44");
  assert.equal(finishesApplied, 1);
  assert.equal(reviewEvents, 1);

  loaded.context.fetch = async (url, init) => {
    loaded.calls.push({ url, init });
    const replayKey = init.headers["X-Idempotency-Key"];
    return { status: 200, headers: { get: () => null }, json: async () => finishHandler(replayKey) };
  };
  loaded.context.navigator.onLine = true;
  await loaded.context.flushOutbox();

  assert.equal(loaded.calls[0].init.headers["X-Idempotency-Key"], directKey);
  assert.equal(finishesApplied, 1, "the server-side keyed replay does not finish twice");
  assert.equal(reviewEvents, 1, "session_finished remains one material review event");
  assert.equal(loaded.context.CairnOutbox.count(), 0);
});

test("write-ahead persistence failure prevents the direct workout request", async () => {
  const loaded = loadApiClient();
  loaded.context.localStorage.setItem = () => {
    throw new Error("quota exceeded");
  };
  let directCalls = 0;

  const result = await loaded.context.runSessionMutation(
    {
      date: "2026-06-30",
      kind: "set",
      path: "/sets",
      body: { date: "2026-06-30", exercise: "Bench", reps: 5 },
      identity: { sessionId: 44 },
    },
    async () => {
      directCalls++;
      return { id: 1 };
    }
  );

  assert.equal(result.status, "storage_error");
  assert.equal(directCalls, 0, "nothing reaches the server before the WAL is durable");
  assert.equal(loaded.context.CairnOutbox.count(), 0);
});

test("a normal direct success observes its WAL and removes only that exact item", async () => {
  const loaded = loadApiClient();
  const date = "2026-06-30";
  let observed = null;

  const result = await loaded.context.runSessionMutation(
    {
      date,
      kind: "set",
      path: "/sets",
      body: { date, exercise: "Bench", reps: 5 },
      identity: { sessionId: 44 },
    },
    async (idempotencyKey) => {
      observed = loaded.context.CairnOutbox.list().find((item) => item.id === idempotencyKey);
      return { id: 101, session_id: 44, date, exercise: "Bench", reps: 5 };
    }
  );

  assert.equal(result.status, "sent");
  assert.equal(observed.id.length > 0, true, "the complete row exists before the send callback runs");
  assert.equal(typeof observed.claim_token, "string");
  assert.equal(observed.path, "/sets");
  assert.equal(observed.session_date, date);
  assert.equal(observed.group_id, "session:44");
  assert.equal(loaded.context.CairnOutbox.count(), 0);
});

test("direct semantic rejection stays durable and reviewable without mutating the UI contract", async () => {
  const loaded = loadApiClient();
  const date = "2026-06-30";

  const result = await loaded.context.runSessionMutation(
    {
      date,
      kind: "skip",
      path: "/sessions/skip",
      body: { date, exercise: "Squat" },
      identity: { sessionId: 44 },
    },
    async () => ({ ok: false, error: "finish the active set first" })
  );

  assert.equal(result.status, "sent", "the caller still receives and renders the precise response error");
  assert.equal(result.value.ok, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(loaded.context.CairnOutbox.reviewItems().map(({ item, role }) => [item.kind, role]))),
    [["skip", "attention"]]
  );
  assert.equal(loaded.context.CairnOutbox.list()[0].claim_token, undefined);
});

test("movement-check semantic rejection blocks later same-workout siblings but not another date", async () => {
  const loaded = loadApiClient();
  const date = "2026-06-30";
  const rejected = await loaded.context.runSessionMutation(
    {
      date,
      kind: "symptom_observation",
      path: "/training-symptoms/observation",
      body: { date, movement: "Bench", symptom_event_id: 9, outcome: "pain_free" },
      identity: { sessionId: 44 },
    },
    async () => ({ ok: false, error: "symptom no longer active" })
  );
  let sameWorkoutSends = 0;
  const sameWorkout = await loaded.context.runSessionMutation(
    {
      date,
      kind: "set",
      path: "/sets",
      body: { date, exercise: "Bench", reps: 5 },
      identity: { sessionId: 44 },
    },
    async () => {
      sameWorkoutSends++;
      return { id: 1 };
    }
  );
  const otherDate = await loaded.context.runSessionMutation(
    {
      date: "2026-07-01",
      kind: "set",
      path: "/sets",
      body: { date: "2026-07-01", exercise: "Row", reps: 8 },
      identity: { sessionId: 45 },
    },
    async () => ({ id: 2 })
  );

  assert.equal(rejected.status, "sent");
  assert.equal(sameWorkout.status, "queued");
  assert.equal(sameWorkoutSends, 0);
  assert.equal(otherDate.status, "sent");
  assert.deepEqual(
    JSON.parse(JSON.stringify(loaded.context.CairnOutbox.reviewItems().map(({ item, role }) => [item.kind, role]))),
    [
      ["symptom_observation", "attention"],
      ["set", "blocked_dependent"],
    ]
  );
  assert.match(loaded.context.CairnOutbox.itemSummary(loaded.context.CairnOutbox.list()[0]), /Pain-free today · Bench/);
});

test("direct permanent failure marks the write-ahead row for attention", async () => {
  const loaded = loadApiClient();
  const date = "2026-06-30";
  loaded.context.fetch = async () => ({
    status: 409,
    headers: { get: () => null },
    json: async () => ({ error: "conflict" }),
  });

  const result = await loaded.context.runSessionMutation(
    {
      date,
      kind: "finish",
      path: "/sessions/44/finish",
      body: { notes: "done" },
      identity: { sessionId: 44 },
    },
    (idempotencyKey) =>
      loaded.context.api("/sessions/44/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ notes: "done" }),
      })
  );

  assert.equal(result.status, "failed");
  const attention = loaded.context.CairnOutbox.list()[0];
  assert.equal(attention.kind, "finish");
  assert.equal(attention.state, "needs_attention");
  assert.equal(attention.failure_status, 409);
  assert.equal(attention.claim_token, undefined);
});

test("a failed finish blocks a later set resolved from the same canonical session", async () => {
  const loaded = loadApiClient();
  const date = "2026-06-30";
  loaded.context.navigator.onLine = false;
  loaded.context.peekCached = (key) =>
    key === `today:daily-session:${date}` ? { data: { id: 81, session_id: 44, date }, fresh: true } : null;
  const finish = await loaded.context.runSessionMutation(
    {
      date,
      kind: "finish",
      path: "/sessions/44/finish",
      body: { notes: "done" },
    },
    async () => {
      throw new Error("offline");
    }
  );
  loaded.context.fetch = async (url, init) => {
    loaded.calls.push({ url, init });
    return { status: 400, headers: { get: () => null }, json: async () => ({ error: "not ready" }) };
  };
  loaded.context.navigator.onLine = true;
  await loaded.context.flushOutbox();

  let directSets = 0;
  const set = await loaded.context.runSessionMutation(
    {
      date,
      kind: "set",
      path: "/sets",
      body: { date, exercise: "Bench", reps: 5 },
      identity: { sessionId: 44 },
    },
    async () => {
      directSets++;
      return { id: 1 };
    }
  );

  assert.equal(finish.groupId, "session:44");
  assert.equal(set.status, "queued");
  assert.equal(set.groupId, "session:44");
  assert.equal(directSets, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(loaded.context.CairnOutbox.reviewItems().map(({ item, role }) => [item.kind, role]))),
    [
      ["finish", "attention"],
      ["set", "blocked_dependent"],
    ]
  );
});

test("a staged date-fallback group remains stable after canonical identity arrives", async () => {
  const loaded = loadApiClient();
  const date = "2026-06-30";
  loaded.context.navigator.onLine = false;
  const staged = await loaded.context.runSessionMutation(
    {
      date,
      kind: "set",
      path: "/sets",
      body: { date, exercise: "Bench", n: 1 },
    },
    async () => {
      throw new Error("offline");
    }
  );
  loaded.context.peekCached = (key) =>
    key === `today:session:${date}` ? { data: { id: 44, date, daily_session: { id: 81, date } }, fresh: true } : null;
  let directCalls = 0;
  const canonical = await loaded.context.runSessionMutation(
    {
      date,
      kind: "finish",
      path: "/sessions/44/finish",
      body: { notes: "done" },
      identity: { sessionId: 44 },
    },
    async () => {
      directCalls++;
      return { id: 44 };
    }
  );

  assert.equal(staged.groupId, "date:2026-06-30");
  assert.equal(canonical.status, "queued");
  assert.equal(canonical.groupId, staged.groupId);
  assert.equal(directCalls, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.context.CairnOutbox.list().map((item) => item.group_id))), [
    "date:2026-06-30",
    "date:2026-06-30",
  ]);
});

test("a 200 skip rejection remains reviewable and blocks its workout group only", async () => {
  const loaded = loadApiClient();
  const groupId = "daily:81";
  await loaded.context.outboxEnqueue("skip", "/sessions/skip", { date: "2026-06-30", exercise: "Squat" }, { groupId });
  await loaded.context.outboxEnqueue("finish", "/sessions/44/finish", { notes: "done" }, { groupId });
  await loaded.context.outboxEnqueue("weight", "/bodyweight", { weight_lb: 180 });
  loaded.context.fetch = async (url, init) => {
    loaded.calls.push({ url, init });
    if (url === "/api/sessions/skip") {
      return { status: 200, headers: { get: () => null }, json: async () => ({ ok: false, error: "sets logged" }) };
    }
    return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
  };

  await loaded.context.flushOutbox();

  assert.deepEqual(
    loaded.calls.map((call) => call.url),
    ["/api/sessions/skip", "/api/bodyweight"]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(loaded.context.CairnOutbox.reviewItems().map(({ item, role }) => [item.kind, role]))),
    [
      ["skip", "attention"],
      ["finish", "blocked_dependent"],
    ]
  );
  assert.equal(loaded.context.CairnOutbox.list()[0].body.exercise, "Squat");
});

test("retrying a semantic skip rejection uses a fresh key and preserves its workout metadata", async () => {
  const loaded = loadApiClient();
  const date = "2026-06-30";
  const original = await loaded.context.outboxEnqueue(
    "skip",
    "/sessions/skip",
    { date, exercise: "Squat" },
    { groupId: "session:44", sessionDate: date }
  );
  let corrected = false;
  let retriedSnapshot = null;
  loaded.context.fetch = async (url, init) => {
    loaded.calls.push({ url, init });
    if (corrected) retriedSnapshot = loaded.context.CairnOutbox.list()[0];
    return {
      status: 200,
      headers: { get: () => null },
      json: async () =>
        corrected
          ? { ok: true, session_id: 44, date, exercise: "Squat", skips: ["Squat"] }
          : { ok: false, error: "finish the active set first" },
    };
  };

  await loaded.context.flushOutbox();
  assert.equal(loaded.context.CairnOutbox.list()[0].state, "needs_attention");
  const firstKey = loaded.calls[0].init.headers["X-Idempotency-Key"];
  assert.equal(firstKey, original.id);

  corrected = true;
  assert.equal(await loaded.context.CairnOutbox.retry(original.id), true);

  const retryKey = loaded.calls[1].init.headers["X-Idempotency-Key"];
  assert.notEqual(retryKey, firstKey, "a cached 2xx rejection cannot pin the retry to its old key");
  assert.equal(retriedSnapshot.id, retryKey);
  assert.equal(retriedSnapshot.group_id, "session:44");
  assert.equal(retriedSnapshot.session_date, date);
  assert.equal(retriedSnapshot.method, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(retriedSnapshot.body)), { date, exercise: "Squat" });
  assert.equal(loaded.context.CairnOutbox.count(), 0);
});

test("Web Locks serialize concurrent cross-tab enqueues so both durable items survive", async () => {
  const sharedStorage = new Map();
  let tail = Promise.resolve();
  const locks = {
    request(_name, callback) {
      const run = tail.then(callback, callback);
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };
  const first = loadApiClient({ sharedStorage, locks });
  const second = loadApiClient({ sharedStorage, locks });

  const [activity, weight] = await Promise.all([
    first.context.outboxEnqueue("activity", "/activities", { text: "run" }),
    second.context.outboxEnqueue("weight", "/bodyweight", { weight_lb: 180 }),
  ]);

  assert.ok(activity);
  assert.ok(weight);
  const stored = JSON.parse(sharedStorage.get("cairn.outbox.v1"));
  assert.deepEqual(
    stored.map((item) => item.kind),
    ["activity", "weight"]
  );
});

test("write-ahead ordering survives no-Web-Locks lease expiry during an in-flight set", async () => {
  const sharedStorage = new Map();
  const first = loadApiClient({ sharedStorage });
  const second = loadApiClient({ sharedStorage });
  const date = "2026-06-30";
  for (const loaded of [first, second]) {
    loaded.context.peekCached = (key) =>
      key === `today:session:${date}`
        ? { data: { id: 44, date, daily_session: { id: 81, session_id: 44, date } }, fresh: true }
        : null;
  }

  const responses = new Map();
  const applications = [];
  const requestKeys = [];
  let takeoverClaimToken = "";
  let releaseFirstResponse;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => {
    firstStartedResolve = resolve;
  });
  const response = (body) => ({ status: 200, headers: { get: () => null }, json: async () => body });
  const serverFetch = (url, init) => {
    const key = init.headers["X-Idempotency-Key"];
    requestKeys.push([url, key]);
    if (responses.has(key)) {
      if (url === "/api/sets") {
        const current = JSON.parse(sharedStorage.get("cairn.outbox.v1"));
        takeoverClaimToken = current.find((item) => item.id === key)?.claim_token || "";
      }
      return Promise.resolve(response(responses.get(key)));
    }
    if (url === "/api/sets") {
      applications.push("set");
      const body = { id: 101, session_id: 44, date, exercise: "Bench", reps: 5 };
      responses.set(key, body);
      firstStartedResolve();
      return new Promise((resolve) => {
        releaseFirstResponse = () => resolve(response(body));
      });
    }
    if (url === "/api/sessions/44/finish") {
      applications.push("finish");
      const body = { id: 44, date, finished_at: `${date}T15:00:00Z` };
      responses.set(key, body);
      return Promise.resolve(response(body));
    }
    throw new Error(`unexpected request ${url}`);
  };
  first.context.fetch = serverFetch;
  second.context.fetch = serverFetch;

  const setMutation = first.context.runSessionMutation(
    {
      date,
      kind: "set",
      path: "/sets",
      body: { date, exercise: "Bench", reps: 5 },
      identity: { sessionId: 44 },
    },
    (idempotencyKey) =>
      first.context.api("/sets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ date, exercise: "Bench", reps: 5 }),
      })
  );
  await firstStarted;
  const wal = JSON.parse(sharedStorage.get("cairn.outbox.v1"));
  assert.deepEqual(
    wal.map((item) => item.kind),
    ["set"],
    "tab A publishes its set before waiting on the response"
  );
  assert.equal(wal[0].state, "sending");
  const firstClaimToken = wal[0].claim_token;
  assert.equal(typeof firstClaimToken, "string");
  assert.equal(first.context.CairnOutbox.reviewItems().length, 0, "an active bounded claim is pending, not attention");
  const setKey = wal[0].id;

  // Delivery deliberately does not hold a lease. Model a stale owner left by a
  // suspended context so tab B must take it over before claiming the expired WAL.
  sharedStorage.set("cairn.outbox.v1.lock", JSON.stringify({ owner: "tab-a-stale", expires: Date.now() - 1 }));
  wal[0].in_flight_until = Date.now() - 1;
  sharedStorage.set("cairn.outbox.v1", JSON.stringify(wal));
  let finishDirectCalls = 0;
  const finishMutation = await second.context.runSessionMutation(
    {
      date,
      kind: "finish",
      path: "/sessions/44/finish",
      body: { notes: "done" },
      identity: { sessionId: 44 },
    },
    async () => {
      finishDirectCalls++;
      return { id: 44, date };
    }
  );

  assert.equal(finishMutation.status, "queued");
  assert.equal(finishDirectCalls, 0, "tab B cannot overtake tab A with a direct finish");
  assert.deepEqual(
    JSON.parse(sharedStorage.get("cairn.outbox.v1")).map((item) => item.kind),
    ["set", "finish"],
    "lease takeover appends without overwriting the first tab's WAL"
  );
  await second.context.flushOutbox();
  assert.deepEqual(applications, ["set", "finish"]);
  assert.notEqual(takeoverClaimToken, firstClaimToken, "expired takeover sends under a fresh claim generation");
  assert.deepEqual(requestKeys.slice(0, 2), [
    ["/api/sets", setKey],
    ["/api/sets", setKey],
  ]);
  assert.equal(JSON.parse(sharedStorage.get("cairn.outbox.v1")).length, 0);

  releaseFirstResponse();
  const settledSet = await setMutation;
  assert.equal(settledSet.status, "sent");
  assert.deepEqual(applications, ["set", "finish"], "late tab A completion cannot reapply or erase newer work");
  assert.equal(JSON.parse(sharedStorage.get("cairn.outbox.v1")).length, 0);
});

test("the shared mutation lock observes a concurrently staged prepare and never creates a detached write", async () => {
  const sharedStorage = new Map();
  let tail = Promise.resolve();
  const locks = {
    request(_name, callback) {
      const run = tail.then(callback, callback);
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };
  const staging = loadApiClient({ sharedStorage, locks });
  const logging = loadApiClient({ sharedStorage, locks });
  const date = "2026-06-30";
  let directCalls = 0;

  const preparePromise = staging.context.outboxEnqueue(
    "daily_session_prepare",
    "/daily-session/prepare",
    { date, source: "adaptive_plan", replace: false },
    {
      prepareIntent: {
        date,
        source: "adaptive_plan",
        plan_day_id: 22,
        title: "Upper",
        focus: "Push",
        est_minutes: null,
        items: [],
      },
    }
  );
  const mutationPromise = logging.context.runSessionMutation(
    {
      date,
      kind: "set",
      path: "/sets",
      body: { date, exercise: "Bench", reps: 5 },
    },
    async () => {
      directCalls++;
      return { id: 1 };
    }
  );
  const [prepare, mutation] = await Promise.all([preparePromise, mutationPromise]);

  assert.ok(prepare);
  assert.equal(mutation.status, "blocked");
  assert.equal(mutation.reason, "other_tab");
  assert.equal(directCalls, 0);
  const stored = JSON.parse(sharedStorage.get("cairn.outbox.v1"));
  assert.deepEqual(
    stored.map((item) => item.kind),
    ["daily_session_prepare"]
  );
  assert.equal(stored[0].session_date, date);
  assert.equal(
    stored.some((item) => item.kind === "set" && !item.depends_on),
    false
  );
});

test("another tab sees every shared prepare state as a refresh barrier without a matching staged pair", async () => {
  const sharedStorage = new Map();
  let tail = Promise.resolve();
  const locks = {
    request(_name, callback) {
      const run = tail.then(callback, callback);
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };
  const first = loadApiClient({ sharedStorage, locks });
  const second = loadApiClient({ sharedStorage, locks });
  const date = "2026-06-30";
  // A warm canonical-looking SWR entry is not permission to bypass a prepare
  // written by another context; only a cache pair carrying its exact local ID is.
  second.context.peekCached = (key) =>
    key === `today:session:${date}` ? { data: { id: 44, date, sets: [] }, fresh: true } : null;

  const prepare = await first.context.outboxEnqueue(
    "daily_session_prepare",
    "/daily-session/prepare",
    { date, source: "adaptive_plan", replace: false },
    {
      prepareIntent: {
        date,
        source: "adaptive_plan",
        plan_day_id: 22,
        title: "Upper",
        focus: "Push",
        est_minutes: null,
        items: [],
      },
    }
  );
  for (const state of [undefined, "prepared", "needs_attention"]) {
    const stored = JSON.parse(sharedStorage.get("cairn.outbox.v1"));
    if (state === undefined) delete stored[0].state;
    else stored[0].state = state;
    sharedStorage.set("cairn.outbox.v1", JSON.stringify(stored));
    assert.deepEqual(
      JSON.parse(JSON.stringify(second.context.outboxSessionPrerequisite(date))),
      { status: "blocked", id: prepare.id, reason: "other_tab" },
      `shared ${state || "pending"} prepare remains a cross-tab barrier`
    );
  }
});

test("fallback outbox lease takes over an expired owner and releases it after the mutation", async () => {
  const sharedStorage = new Map();
  sharedStorage.set("cairn.outbox.v1.lock", JSON.stringify({ owner: "suspended-tab", expires: Date.now() - 1 }));
  const loaded = loadApiClient({ sharedStorage });

  const item = await loaded.context.outboxEnqueue("weight", "/bodyweight", { weight_lb: 180 });

  assert.ok(item);
  assert.equal(sharedStorage.has("cairn.outbox.v1.lock"), false);
  assert.deepEqual(
    JSON.parse(sharedStorage.get("cairn.outbox.v1")).map((row) => row.kind),
    ["weight"]
  );
});

test("runtime outbox retry immediately replays and discard removes only the chosen log", async () => {
  const loaded = loadApiClient();
  loaded.context.fetch = async () => ({
    status: 422,
    headers: { get: () => null },
    json: async () => ({ error: "invalid" }),
  });
  const rejected = await loaded.context.outboxEnqueue("activity", "/activities", { text: "run" });
  const kept = await loaded.context.outboxEnqueue("weight", "/bodyweight", { weight_lb: 180 });
  await loaded.context.flushOutbox();

  let stored = JSON.parse(loaded.storage.get("cairn.outbox.v1"));
  assert.equal(stored[0].state, "needs_attention");
  assert.equal(stored[1].state, "needs_attention");

  loaded.context.fetch = async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) });
  await loaded.context.CairnOutbox.retry(rejected.id);
  stored = JSON.parse(loaded.storage.get("cairn.outbox.v1"));
  assert.equal(stored.length, 1, "the retried log is removed only after successful replay");
  assert.equal(stored[0].id, kept.id);

  assert.equal(await loaded.context.CairnOutbox.discard(kept.id), true);
  assert.equal(loaded.context.CairnOutbox.count(), 0);
  assert.equal(
    loaded.getOutboxBar().classList.contains("show"),
    false,
    "an empty disabled bar returns to its hidden state"
  );
  assert.equal(loaded.getOutboxBar().classList.contains("outbox-actionable"), false);
  assert.equal(loaded.getOutboxBar().getAttribute("disabled"), "");
  assert.equal(loaded.getOutboxBar().getAttribute("role"), "status");
  assert.equal(await loaded.context.CairnOutbox.discard(kept.id), false);
});

test("runtime discard of a failed workout member immediately releases later siblings in order", async () => {
  const loaded = loadApiClient();
  const date = "2026-06-30";
  const prepare = await loaded.context.outboxEnqueue(
    "daily_session_prepare",
    "/daily-session/prepare",
    { date, source: "athlete_override", replace: true, session: { name: "Saved", items: [] } },
    {
      prepareIntent: {
        date,
        source: "athlete_override",
        plan_day_id: null,
        title: "Saved",
        focus: null,
        why: null,
        est_minutes: null,
        items: [],
      },
    }
  );
  const failed = await loaded.context.outboxEnqueue(
    "set",
    "/sets",
    { date, exercise: "Bench", reps: 5 },
    { dependsOn: prepare.id }
  );
  await loaded.context.outboxEnqueue("skip", "/sessions/skip", { date, exercise: "Squat" }, { dependsOn: prepare.id });
  await loaded.context.outboxEnqueue("finish", "/sessions/44/finish", { notes: "done" }, { dependsOn: prepare.id });
  const stored = JSON.parse(loaded.storage.get("cairn.outbox.v1"));
  stored[0].state = "prepared";
  stored[1].state = "needs_attention";
  stored[1].failure_status = 400;
  loaded.storage.set("cairn.outbox.v1", JSON.stringify(stored));

  assert.equal(await loaded.context.CairnOutbox.discard(failed.id), true);

  assert.deepEqual(
    loaded.calls.map((call) => call.url),
    ["/api/sessions/skip", "/api/sessions/44/finish"]
  );
  assert.equal(loaded.context.CairnOutbox.count(), 0);
});

test("runtime outbox clears actionable state when an attention bar hides offline", async () => {
  const loaded = loadApiClient();
  await loaded.context.outboxEnqueue("activity", "/activities", { text: "run" });
  const stored = JSON.parse(loaded.storage.get("cairn.outbox.v1"));
  stored[0].state = "needs_attention";
  stored[0].failure_status = 422;
  loaded.storage.set("cairn.outbox.v1", JSON.stringify(stored));
  loaded.context.CairnOutbox.renderBar();
  assert.equal(loaded.getOutboxBar().classList.contains("outbox-actionable"), true);

  loaded.context.navigator.onLine = false;
  loaded.context.CairnOutbox.renderBar();

  assert.equal(loaded.getOutboxBar().classList.contains("show"), false);
  assert.equal(loaded.getOutboxBar().classList.contains("outbox-actionable"), false);
  assert.equal(loaded.getOutboxBar().getAttribute("disabled"), "");
});

test("runtime outbox queues a second drain when retry is requested during an active flush", async () => {
  const loaded = loadApiClient();
  let resolveFirst;
  const fetched = [];
  loaded.context.fetch = (url) => {
    fetched.push(url);
    if (fetched.length === 1) {
      return new Promise((resolve) => {
        resolveFirst = () => resolve({ status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) });
      });
    }
    return Promise.resolve({ status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) });
  };
  await loaded.context.outboxEnqueue("activity", "/activities", { text: "run" });
  const attention = await loaded.context.outboxEnqueue("weight", "/bodyweight", { weight_lb: 180 });
  const stored = JSON.parse(loaded.storage.get("cairn.outbox.v1"));
  stored[1].state = "needs_attention";
  stored[1].failure_status = 404;
  loaded.storage.set("cairn.outbox.v1", JSON.stringify(stored));

  const activeFlush = loaded.context.flushOutbox();
  for (let i = 0; i < 12 && typeof resolveFirst !== "function"; i++) await Promise.resolve();
  assert.equal(typeof resolveFirst, "function", "the first replay is held in flight");
  const queuedRetry = loaded.context.CairnOutbox.retry(attention.id);
  resolveFirst();
  await Promise.all([activeFlush, queuedRetry]);

  assert.deepEqual(fetched, ["/api/activities", "/api/bodyweight"]);
  assert.equal(loaded.context.CairnOutbox.count(), 0, "the retried item was drained after the active pass settled");
});

test("needs-attention copy counts failed logs while pending copy counts the whole queue", async () => {
  const loaded = loadApiClient();
  await loaded.context.outboxEnqueue("activity", "/activities", { text: "run" });
  await loaded.context.outboxEnqueue("weight", "/bodyweight", { weight_lb: 180 });
  const stored = JSON.parse(loaded.storage.get("cairn.outbox.v1"));
  stored[0].state = "needs_attention";
  stored[0].failure_status = 422;
  loaded.storage.set("cairn.outbox.v1", JSON.stringify(stored));

  loaded.context.CairnOutbox.renderBar();

  assert.match(loaded.getOutboxBar().innerHTML, /Needs attention · 1 saved item</);
  assert.doesNotMatch(loaded.getOutboxBar().innerHTML, /Needs attention · 2 saved items/);
});

test("outbox hidden-state CSS does not force disabled bars visible", () => {
  const styles = readFileSync(join(root, "public/styles.css"), "utf8");
  assert.match(styles, /\.outbox-bar\.show\s*\{[^}]*opacity:1/);
  assert.doesNotMatch(styles, /\.outbox-bar:disabled\s*\{[^}]*opacity:1/);
});

test("outbox review rerenders restore focus to a remaining dialog control", () => {
  const client = readFileSync(join(root, "public/js/api-client.js"), "utf8");
  assert.match(client, /function focusOutboxReviewControl\(overlay\)/);
  assert.match(client, /querySelector\("\[data-outbox-retry\]"\)/);
  assert.equal(
    (client.match(/renderOutboxReview\(\{\s*focusControl:\s*true\s*\}\)/g) || []).length,
    2,
    "both discard and retry rerenders request an in-dialog focus target"
  );
});

test("capture enqueue classifier treats network, timeout, and retryable HTTP as transient only", () => {
  const loaded = loadApiClient();
  const { ApiError, isTransientApiFailure } = loaded.context.CairnApiCache;
  const error = (kind, status = null) => new ApiError({ kind, method: "POST", route: "/sets", status });

  assert.equal(isTransientApiFailure(error("network")), true);
  assert.equal(isTransientApiFailure(error("timeout")), true, "finish AbortError is wrapped as a retryable timeout");
  assert.equal(isTransientApiFailure(error("http", 408)), true);
  assert.equal(isTransientApiFailure(error("http", 429)), true);
  assert.equal(isTransientApiFailure(error("http", 503)), true);
  assert.equal(isTransientApiFailure(error("http", 401)), false);
  assert.equal(isTransientApiFailure(error("http", 404)), false);
  assert.equal(isTransientApiFailure(error("http", 422)), false);
  assert.equal(isTransientApiFailure(error("invalid_json", 200)), false);
});
