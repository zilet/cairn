// Server-side idempotency guard (src/idempotency.ts). The PWA's offline outbox
// replays queued mutating writes with a stable X-Idempotency-Key on reconnect;
// this guard replays the first 2xx response for a repeated key so a retry can
// never double-apply the write (a duplicate logged set, a re-added food note).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { idempotencyGuard, pruneIdempotencyKeys } from "../dist/idempotency.js";

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
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); return this; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
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

test("the same key on a different path passes through (a collision never replays the wrong body)", () => {
  const key = "shared-key";
  run(makeReq({ key, path: "/sets" }), makeRes(), logSetHandler);

  const res2 = makeRes();
  const ran2 = run(
    makeReq({ key, path: "/activities" }),
    res2,
    (_req, res) => res.json({ ok: true, where: "activities" })
  );
  assert.equal(ran2, true, "a different path re-executes rather than replaying");
  assert.equal(res2.getHeader("x-idempotency-replayed"), undefined, "no replay header on a collision");
  assert.deepEqual(res2.body, { ok: true, where: "activities" }, "returns the real handler body");
});

test("prune removes rows older than the TTL and keeps fresh ones", () => {
  const insert = db.prepare(
    `INSERT INTO idempotency_keys (key, method, path, status, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  insert.run("old", "POST", "/sets", 200, "{}", "2000-01-01T00:00:00.000Z");
  insert.run("fresh", "POST", "/sets", 200, "{}", new Date().toISOString());

  const removed = pruneIdempotencyKeys();
  assert.ok(removed >= 1, "at least the stale row is pruned");
  assert.equal(db.prepare("SELECT 1 FROM idempotency_keys WHERE key = 'old'").get(), undefined, "stale row gone");
  assert.ok(db.prepare("SELECT 1 FROM idempotency_keys WHERE key = 'fresh'").get(), "fresh row kept");
});
