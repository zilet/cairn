// Server-side idempotency guard (src/idempotency.ts). The PWA's offline outbox
// replays queued mutating writes with a stable X-Idempotency-Key on reconnect;
// this guard replays the first 2xx response for a repeated key so a retry can
// never double-apply the write (a duplicate logged set, a re-added food note).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { IDEMPOTENCY_LIMITS, idempotencyGuard } from "../dist/idempotency.js";

const DATE = "2030-02-01";

beforeEach(() => {
  for (const t of ["idempotency_keys", "logged_sets", "session_skips", "sessions", "plan_items"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
});

// ---- express-style req/res doubles (mirrors test/diagnostics.test.js) ----
function makeReq({ method = "POST", path = "/sets", key = null } = {}) {
  const headers = {};
  if (key != null) headers["x-idempotency-key"] = key;
  return {
    method,
    path,
    get(name) { return headers[String(name).toLowerCase()]; },
  };
}

function makeRes() {
  const listeners = new Map();
  let resolveSent;
  const sent = new Promise((resolve) => { resolveSent = resolve; });
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    sent,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); return this; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    once(name, callback) {
      const event = String(name);
      listeners.set(event, [...(listeners.get(event) || []), callback]);
      return this;
    },
    emit(name, ...args) {
      const event = String(name);
      const callbacks = listeners.get(event) || [];
      listeners.delete(event);
      for (const callback of callbacks) callback(...args);
      return callbacks.length > 0;
    },
    json(b) { this.body = b; resolveSent(this); return this; },
  };
}

// Drive one request through the guard. `handler` stands in for the route the guard
// gates: it only runs when the guard calls next() (a miss / collision pass-through),
// never on a replay short-circuit. Returns whether the handler executed.
function run(req, res, handler) {
  let ran = false;
  idempotencyGuard(req, res, () => { ran = true; handler(req, res); });
  return ran;
}

function logSetHandler(_req, res) {
  res.json(repo.logSetByName({ exercise: "Idem Squat", weight: 100, reps: 5, date: DATE }));
}

function countSets() {
  return db.prepare("SELECT COUNT(*) AS c FROM logged_sets").get().c;
}

test("replaying the same key returns the stored body and does not re-apply the write", () => {
  const key = "outbox-item-1";

  const res1 = makeRes();
  const ran1 = run(makeReq({ key }), res1, logSetHandler);
  assert.equal(ran1, true, "first request executes the write");
  assert.equal(countSets(), 1, "one set logged");

  const res2 = makeRes();
  const ran2 = run(makeReq({ key }), res2, logSetHandler);
  assert.equal(ran2, false, "replay short-circuits — the handler never runs");
  assert.equal(res2.getHeader("x-idempotency-replayed"), "1", "replay is flagged");
  assert.equal(
    JSON.stringify(res2.body),
    JSON.stringify(res1.body),
    "replay returns the identical first response"
  );
  assert.equal(countSets(), 1, "no second set was logged on replay");
});

test("two different keys each execute (no cross-key replay)", () => {
  run(makeReq({ key: "k1" }), makeRes(), logSetHandler);
  run(makeReq({ key: "k2" }), makeRes(), logSetHandler);
  assert.equal(countSets(), 2, "distinct keys create distinct writes");
});

test("no key header → behavior is unchanged (nothing stored, always re-executes)", () => {
  assert.equal(run(makeReq({ key: null }), makeRes(), logSetHandler), true);
  assert.equal(run(makeReq({ key: null }), makeRes(), logSetHandler), true);
  assert.equal(countSets(), 2, "each header-less request applies the write");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM idempotency_keys").get().c,
    0,
    "nothing is stored without a key"
  );
});

test("an oversized key remains pass-through", () => {
  const key = "k".repeat(IDEMPOTENCY_LIMITS.max_key_length + 1);
  assert.equal(run(makeReq({ key }), makeRes(), logSetHandler), true);
  assert.equal(run(makeReq({ key }), makeRes(), logSetHandler), true);
  assert.equal(countSets(), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM idempotency_keys").get().c, 0);
});

test("a keyed mutation outside the durable outbox route allowlist remains pass-through", () => {
  let calls = 0;
  const handler = (_req, res) => {
    calls++;
    res.json({ ok: true, calls });
  };
  assert.equal(run(makeReq({ key: "unscoped", path: "/profile" }), makeRes(), handler), true);
  assert.equal(run(makeReq({ key: "unscoped", path: "/profile" }), makeRes(), handler), true);
  assert.equal(calls, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM idempotency_keys").get().c, 0);
});

test("every current durable outbox mutation route is tracked", () => {
  const scopes = [
    ["POST", "/sets"],
    ["POST", "/sessions/skip"],
    ["DELETE", "/sessions/skip"],
    ["POST", "/sessions/42/finish"],
    ["POST", "/daily-session/prepare"],
    ["POST", "/activities"],
    ["POST", "/bodyweight"],
    ["POST", "/food-notes"],
  ];
  for (const [index, [method, path]] of scopes.entries()) {
    const key = `scope-${index}`;
    let calls = 0;
    const handler = (_req, res) => {
      calls++;
      res.json({ ok: true, path });
    };
    run(makeReq({ key, method, path }), makeRes(), handler);
    const replay = makeRes();
    assert.equal(run(makeReq({ key, method, path }), replay, handler), false, `${method} ${path} replays`);
    assert.equal(calls, 1, `${method} ${path} executes once`);
    assert.equal(replay.getHeader("x-idempotency-replayed"), "1");
  }
});

test("a non-2xx response is not cached — a retry re-executes", () => {
  const key = "fails-first";
  const badHandler = (_req, res) => res.status(400).json({ error: "bad request" });

  assert.equal(run(makeReq({ key }), makeRes(), badHandler), true, "first attempt runs");

  const res2 = makeRes();
  assert.equal(run(makeReq({ key }), res2, badHandler), true, "retry re-executes (not replayed)");
  assert.equal(res2.getHeader("x-idempotency-replayed"), undefined, "no replay header");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM idempotency_keys").get().c,
    0,
    "the failed response was never stored"
  );
});

test("the same key on a different tracked path returns a coded conflict without executing", () => {
  const key = "shared-key";
  run(makeReq({ key, path: "/sets" }), makeRes(), logSetHandler);

  const res2 = makeRes();
  const ran2 = run(
    makeReq({ key, path: "/activities" }),
    res2,
    (_req, res) => res.json({ ok: true, where: "activities" })
  );
  assert.equal(ran2, false, "a different tracked path never reaches its handler");
  assert.equal(res2.statusCode, 409);
  assert.equal(res2.getHeader("x-idempotency-replayed"), undefined, "no replay header on a collision");
  assert.equal(res2.body.code, "idempotency_key_conflict");
  assert.equal(countSets(), 1);
});

test("the same key on a different tracked method returns a coded conflict without executing", () => {
  const key = "shared-method-key";
  run(makeReq({ key, path: "/sessions/skip" }), makeRes(), (_req, res) => res.json({ ok: true }));

  let calls = 0;
  const response = makeRes();
  const ran = run(makeReq({ key, method: "DELETE", path: "/sessions/skip" }), response, (_req, res) => {
    calls++;
    res.json({ ok: true });
  });
  assert.equal(ran, false);
  assert.equal(calls, 0);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, "idempotency_key_conflict");
});

test("overlapping exact requests execute one async mutation and the waiter replays it", async () => {
  const key = "overlapping-response-loss";
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let mutations = 0;
  const first = makeRes();
  const second = makeRes();
  const conflicting = makeRes();

  const firstRan = run(makeReq({ key }), first, async (_req, res) => {
    mutations++;
    await gate;
    res.json({ ok: true, mutation_id: 44 });
  });
  const secondRan = run(makeReq({ key }), second, (_req, res) => {
    mutations++;
    res.json({ ok: true, mutation_id: 45 });
  });

  assert.equal(firstRan, true);
  assert.equal(secondRan, false, "the overlapping request waits instead of entering its handler");
  assert.equal(
    run(makeReq({ key, path: "/activities" }), conflicting, () => assert.fail("conflict must not execute")),
    false
  );
  assert.equal(conflicting.statusCode, 409);
  assert.equal(conflicting.body.code, "idempotency_key_conflict");
  assert.equal(mutations, 1);
  releaseFirst();
  await Promise.all([first.sent, second.sent]);

  assert.equal(mutations, 1, "only the owning handler applies the mutation");
  assert.equal(second.getHeader("x-idempotency-replayed"), "1");
  assert.deepEqual(second.body, first.body);
});

test("an exact waiter acquires and executes after the owner returns a non-cacheable failure", async () => {
  const key = "overlapping-owner-failure";
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const first = makeRes();
  const second = makeRes();

  run(makeReq({ key }), first, async (_req, res) => {
    calls++;
    await gate;
    res.status(503).json({ ok: false, error: "temporary" });
  });
  const secondRanImmediately = run(makeReq({ key }), second, (_req, res) => {
    calls++;
    res.json({ ok: true, recovered: true });
  });

  assert.equal(secondRanImmediately, false, "the waiter does not overlap the original handler");
  assert.equal(calls, 1);
  releaseFirst();
  await Promise.all([first.sent, second.sent]);

  assert.equal(calls, 2, "the waiter becomes the next owner after a non-2xx response");
  assert.equal(second.getHeader("x-idempotency-replayed"), undefined);
  assert.deepEqual(second.body, { ok: true, recovered: true });
  assert.equal(db.prepare("SELECT status FROM idempotency_keys WHERE key = ?").get(key).status, 200);
});

test("finish, close, and error release an owner that did not produce JSON", async () => {
  for (const event of ["finish", "close", "error"]) {
    const key = `owner-${event}`;
    let calls = 0;
    const owner = makeRes();
    const waiter = makeRes();
    run(makeReq({ key }), owner, () => { calls++; });
    assert.equal(run(makeReq({ key }), waiter, (_req, res) => {
      calls++;
      res.json({ ok: true, event });
    }), false);

    owner.emit(event, event === "error" ? new Error("connection failed") : undefined);
    await waiter.sent;
    assert.equal(calls, 2, `${event} lets the waiter become owner`);
    assert.equal(waiter.getHeader("x-idempotency-replayed"), undefined);
  }
});

test("a response exactly at the byte limit is stored and replayed verbatim", () => {
  const emptyBytes = Buffer.byteLength(JSON.stringify({ payload: "" }), "utf8");
  const body = { payload: "x".repeat(IDEMPOTENCY_LIMITS.max_response_bytes - emptyBytes) };
  const key = "max-response";
  const first = makeRes();
  run(makeReq({ key }), first, (_req, res) => res.json(body));

  const stored = db.prepare("SELECT status, response_json FROM idempotency_keys WHERE key = ?").get(key);
  assert.equal(stored.status, 200);
  assert.equal(Buffer.byteLength(stored.response_json, "utf8"), IDEMPOTENCY_LIMITS.max_response_bytes);

  const replay = makeRes();
  assert.equal(run(makeReq({ key }), replay, () => assert.fail("replay must not execute")), false);
  assert.equal(replay.getHeader("x-idempotency-replayed"), "1");
  assert.deepEqual(replay.body, body);
});

test("an oversized successful response stores a bounded replay error and never repeats the effect", () => {
  const oversized = { payload: "x".repeat(IDEMPOTENCY_LIMITS.max_response_bytes + 1) };
  const key = "oversized-response";
  let mutations = 0;
  const first = makeRes();
  run(makeReq({ key }), first, (_req, res) => {
    mutations++;
    res.json(oversized);
  });
  assert.deepEqual(first.body, oversized, "the first successful caller receives its real response");

  const stored = db.prepare("SELECT status, response_json FROM idempotency_keys WHERE key = ?").get(key);
  assert.equal(stored.status, 409);
  assert.ok(Buffer.byteLength(stored.response_json, "utf8") <= IDEMPOTENCY_LIMITS.max_response_bytes);

  const replay = makeRes();
  const ran = run(makeReq({ key }), replay, (_req, res) => {
    mutations++;
    res.json({ ok: true });
  });
  assert.equal(ran, false);
  assert.equal(mutations, 1, "the already-committed mutation is never re-applied");
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.getHeader("x-idempotency-replayed"), "1");
  assert.equal(replay.body.code, "idempotency_response_unavailable");
});

test("boot bounds an oversized response stored by an older build", async () => {
  const legacyBody = JSON.stringify({ payload: "x".repeat(IDEMPOTENCY_LIMITS.max_response_bytes + 1) });
  db.prepare(
    `INSERT INTO idempotency_keys (key, method, path, status, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("legacy-oversized", "POST", "/sets", 200, legacyBody, "2026-01-01T00:00:00.000Z");

  await import("../dist/idempotency.js?bounded-legacy-regression");
  const stored = db.prepare("SELECT status, response_json FROM idempotency_keys WHERE key = ?").get("legacy-oversized");
  assert.equal(stored.status, 409);
  assert.ok(Buffer.byteLength(stored.response_json, "utf8") <= IDEMPOTENCY_LIMITS.max_response_bytes);
  assert.equal(JSON.parse(stored.response_json).code, "idempotency_response_unavailable");
});

test("a response older than seven days survives boot and requests without re-applying the write", async () => {
  const cachedBody = { id: 71, exercise: "Idem Squat", weight: 100, reps: 5 };
  db.prepare(
    `INSERT INTO idempotency_keys (key, method, path, status, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("old-response-lost", "POST", "/sets", 200, JSON.stringify(cachedBody), "2000-01-01T00:00:00.000Z");

  // A fresh module evaluation used to prune old rows during service boot.
  await import("../dist/idempotency.js?retention-boot-regression");
  assert.ok(
    db.prepare("SELECT 1 FROM idempotency_keys WHERE key = 'old-response-lost'").get(),
    "service boot retains an old committed response"
  );

  // A later successful keyed request used to trigger age-pruning on this path.
  run(makeReq({ key: "new-request", path: "/activities" }), makeRes(), (_req, res) =>
    res.json({ ok: true })
  );

  const replay = makeRes();
  const ran = run(makeReq({ key: "old-response-lost" }), replay, logSetHandler);
  assert.equal(ran, false, "the original handler is never re-run after a long offline interval");
  assert.equal(replay.getHeader("x-idempotency-replayed"), "1");
  assert.deepEqual(replay.body, cachedBody, "the original committed response remains available");
  assert.equal(countSets(), 0, "the mutation is not applied a second time");
  assert.ok(
    db.prepare("SELECT 1 FROM idempotency_keys WHERE key = 'old-response-lost'").get(),
    "the durable ledger row remains stored"
  );
});
