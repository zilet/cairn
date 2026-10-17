// A Garmin sync is a background job, and there is only ever one of it.
//
// POST /api/garmin/sync used to hold the request open for the whole Garmin Connect pull
// (15 s median, 33 s worst in production), and nothing stopped a second tap, the
// scheduler's pass and an MCP call from pulling the same data side by side. The route
// now answers at once with a `garmin_sync` agent job, a second POST while one is going
// gets that same job, and syncGarmin() itself is single-flight for every caller.
//
// The network pass is swapped for a fake (setGarminSyncPassForTests) that the test
// releases by hand, so "the request did not wait" is proved by the response arriving
// while the pass is still blocked — no timing threshold.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { db, repo } from "./_seed.js";
import {
  GARMIN_SYNC_DEADLINE_MS,
  GarminSyncAbandonedError,
  garminSyncWindow,
  setGarminSyncPassForTests,
  syncGarmin,
} from "../dist/garmin.js";
import { garminRouter } from "../dist/routes/garmin.js";
import { agentJobsRouter } from "../dist/routes/agent-jobs.js";
import { registerGarminTools } from "../dist/surfaces/mcp/garmin.js";

beforeEach(() => {
  db.prepare(`DELETE FROM agent_jobs`).run();
});

afterEach(() => setGarminSyncPassForTests(null));

// A pass that stays open until the test lets it finish, counting how often it ran and
// whether two ever ran at once.
function heldPass() {
  const calls = [];
  let running = 0;
  let overlapped = false;
  const pass = (window, signal) => {
    running += 1;
    if (running > 1) overlapped = true;
    let release;
    const done = new Promise((resolve) => {
      release = resolve;
    });
    const call = { window, signal, release: (result) => release(result) };
    calls.push(call);
    return done.then((result) => {
      running -= 1;
      if (result instanceof Error) throw result;
      return result;
    });
  };
  return { pass, calls, overlapped: () => overlapped };
}

const OK = (activities = 3) => ({ ok: true, source_id: 1, days: 30, activities, daily_metrics: 14 });

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use("/api", garminRouter);
  app.use("/api/agent-jobs", agentJobsRouter);
  // The shared error envelope, as server.ts answers it.
  app.use((_err, _req, res, _next) => res.status(500).json({ ok: false, error: "internal error" }));
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        resolve(await fn(base));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

async function post(base, body = {}) {
  const res = await fetch(`${base}/api/garmin/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return res.json();
}

// The worker kicks on the next macrotask; let it reach the (fake) pass.
async function until(predicate, what) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const terminal = (id) => ["done", "error", "canceled"].includes(repo.getAgentJob(id)?.status);

test("the sync window is normalized, so equal asks are the same sync", () => {
  assert.deepEqual(garminSyncWindow({}), { days: 30, limit: 100, daily: true });
  assert.deepEqual(garminSyncWindow({ days: "7", limit: 500, daily: false }), { days: 7, limit: 200, daily: false });
  assert.deepEqual(garminSyncWindow({ days: "soon", limit: 0 }), { days: 30, limit: 1, daily: true });
  assert.deepEqual(garminSyncWindow(null), garminSyncWindow({ days: 30 }));
});

test("syncGarmin is single-flight: the same window joins, a different one waits its turn", async () => {
  const held = heldPass();
  setGarminSyncPassForTests(held.pass);

  const a = syncGarmin();
  const b = syncGarmin({ days: 30, limit: 100 });
  assert.equal(a, b, "an equal window is the same promise");
  const c = syncGarmin({ days: 7 });
  await until(() => held.calls.length === 1, "the first pass");
  // The second window does not start while the first is still running.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(held.calls.length, 1, "a different window waits for the running pass");

  held.calls[0].release(OK(4));
  assert.deepEqual(await a, OK(4));
  await until(() => held.calls.length === 2, "the queued window");
  assert.deepEqual(held.calls[1].window, { days: 7, limit: 100, daily: true });
  held.calls[1].release(OK(1));
  assert.deepEqual(await c, OK(1));
  assert.equal(held.overlapped(), false, "two passes never ran at once");

  // Once settled, the next ask is a fresh pass, not the old answer.
  const d = syncGarmin();
  assert.notEqual(d, a);
  await until(() => held.calls.length === 3, "a fresh pass");
  held.calls[2].release(OK(0));
  assert.equal((await d).activities, 0);
});

test("a pass that throws does not wedge the next one", async () => {
  const held = heldPass();
  setGarminSyncPassForTests(held.pass);
  const first = syncGarmin();
  await until(() => held.calls.length === 1, "the first pass");
  held.calls[0].release(new Error("boom"));
  await assert.rejects(first, /boom/);
  const next = syncGarmin();
  await until(() => held.calls.length === 2, "the next pass");
  held.calls[1].release(OK());
  assert.equal((await next).ok, true);
});

test("POST /garmin/sync answers with the job while the pass is still running, and a second POST joins it", async () => {
  const held = heldPass();
  setGarminSyncPassForTests(held.pass);
  await withServer(async (base) => {
    const first = await post(base);
    // The response arrived and the pass has not been released: the request did not wait.
    assert.equal(first.ok, true);
    assert.equal(first.queued, true);
    assert.equal(first.joined, false);
    assert.equal(first.job.kind, "garmin_sync");
    assert.equal(first.job_id, first.job.id);
    assert.ok(["queued", "running"].includes(first.job.status));
    assert.deepEqual(first.job.input, { days: 30, limit: 100, daily: true });

    await until(() => held.calls.length === 1, "the pass to start");
    const second = await post(base);
    assert.equal(second.job_id, first.job_id, "the same job, not a second sync");
    assert.equal(second.joined, true);
    assert.equal(held.calls.length, 1, "one pass for both taps");
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM agent_jobs WHERE kind = 'garmin_sync'`).get().n,
      1,
      "one job row"
    );

    const running = await (await fetch(`${base}/api/agent-jobs/${first.job_id}`)).json();
    assert.equal(running.job.status, "running");
    assert.equal(running.job.phase, "syncing with Garmin");

    held.calls[0].release(OK(5));
    await until(() => terminal(first.job_id), "the job to finish");
    const done = await (await fetch(`${base}/api/agent-jobs/${first.job_id}`)).json();
    assert.equal(done.job.status, "done");
    assert.deepEqual(done.job.result, OK(5), "the job's result is the body the route used to return");
  });
});

test("a failed sync finishes quietly and the next POST is a fresh try", async () => {
  const held = heldPass();
  setGarminSyncPassForTests(held.pass);
  await withServer(async (base) => {
    // syncGarmin's designed failure: {ok:false}, recorded as the job's done result.
    const first = await post(base);
    await until(() => held.calls.length === 1, "the first pass");
    held.calls[0].release({ ok: false, source_id: 1, error: "Garmin said no" });
    await until(() => terminal(first.job_id), "the failed job");
    const failed = repo.getAgentJob(first.job_id);
    assert.equal(failed.status, "done");
    assert.equal(failed.result.ok, false);

    const retry = await post(base);
    assert.notEqual(retry.job_id, first.job_id, "a finished failure never blocks the retry");
    assert.equal(retry.joined, false);
    await until(() => held.calls.length === 2, "the retry pass");

    // A pass that throws ends the job as an error — still not blocking.
    held.calls[1].release(new Error("socket hang up"));
    await until(() => terminal(retry.job_id), "the thrown job");
    assert.equal(repo.getAgentJob(retry.job_id).status, "error");

    const again = await post(base);
    assert.notEqual(again.job_id, retry.job_id);
    await until(() => held.calls.length === 3, "the third pass");
    held.calls[2].release(OK(2));
    await until(() => terminal(again.job_id), "the third job");
    assert.equal(repo.getAgentJob(again.job_id).result.activities, 2);
  });
});

test("a POST for a different window is its own job, run after the one in flight", async () => {
  const held = heldPass();
  setGarminSyncPassForTests(held.pass);
  await withServer(async (base) => {
    const usual = await post(base);
    const backfill = await post(base, { days: 90 });
    assert.notEqual(backfill.job_id, usual.job_id);
    assert.equal(backfill.joined, false);
    await until(() => held.calls.length === 1, "the first pass");
    held.calls[0].release(OK());
    await until(() => held.calls.length === 2, "the backfill pass");
    assert.equal(held.calls[1].window.days, 90);
    held.calls[1].release(OK(9));
    await until(() => terminal(backfill.job_id), "the backfill job");
    assert.equal(repo.getAgentJob(backfill.job_id).result.activities, 9);
    assert.equal(held.overlapped(), false);
  });
});

test("MCP sync_garmin still waits for the result, and joins a sync already running", async () => {
  const held = heldPass();
  setGarminSyncPassForTests(held.pass);
  const tools = new Map();
  registerGarminTools({ tool: (name, _description, _schema, handler) => tools.set(name, handler) });
  await withServer(async (base) => {
    const job = await post(base);
    await until(() => held.calls.length === 1, "the app's pass");
    const viaMcp = tools.get("sync_garmin")({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(held.calls.length, 1, "MCP joined the running pass instead of starting another");
    held.calls[0].release(OK(6));
    const body = JSON.parse((await viaMcp).content[0].text);
    assert.deepEqual(body, OK(6), "MCP answers with the sync result itself, not a job");
    await until(() => terminal(job.job_id), "the app's job");
    assert.deepEqual(repo.getAgentJob(job.job_id).result, OK(6));
  });
});

// ---- a pass that never comes back --------------------------------------------------
// garmin-connect sets no timeout, so a connection that stalls mid-response would hold
// the single-flight — and every later sync — until a restart. The pass now has a hard
// deadline, and a job's Stop reaches it.

test("the deadline is a named four minutes", () => {
  assert.equal(GARMIN_SYNC_DEADLINE_MS, 4 * 60_000);
});

test("a pass past its deadline is abandoned: everyone waiting gets the failure and the chain moves on", async () => {
  const held = heldPass();
  setGarminSyncPassForTests(held.pass, { deadlineMs: 200 });

  const stuck = syncGarmin();
  const joined = syncGarmin();
  const other = syncGarmin({ days: 7 }); // a different window, queued behind the stuck one
  await assert.rejects(stuck, (e) => e instanceof GarminSyncAbandonedError && e.code === "timed_out");
  await assert.rejects(joined, (e) => e instanceof GarminSyncAbandonedError && e.code === "timed_out");
  assert.equal(held.calls[0].signal.aborted, true, "the abandoned pass is told to stop");
  assert.equal(repo.getSettings().garmin_last_sync_status, "failed: timed out", "the sync line says so");

  // The queued window was not held hostage: it runs now, on its own clock.
  await until(() => held.calls.length === 2, "the queued window to start");
  assert.equal(held.calls[1].window.days, 7);
  held.calls[1].release(OK(7));
  assert.equal((await other).activities, 7);

  // The next ask is a fresh pass, not the dead one.
  const fresh = syncGarmin();
  assert.notEqual(fresh, stuck);
  await until(() => held.calls.length === 3, "a fresh pass");
  // The abandoned pass finishing late answers nobody and leaves the newer pass alone.
  held.calls[0].release(OK(99));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(syncGarmin(), fresh, "the newer pass is still the one in flight");
  held.calls[2].release(OK(3));
  assert.deepEqual(await fresh, OK(3));
});

test("a stuck sync ends its job as an ordinary failure, the next POST is a fresh job, MCP gets the failure", async () => {
  const held = heldPass();
  setGarminSyncPassForTests(held.pass, { deadlineMs: 300 });
  const tools = new Map();
  registerGarminTools({ tool: (name, _description, _schema, handler) => tools.set(name, handler) });
  await withServer(async (base) => {
    const first = await post(base);
    await until(() => held.calls.length === 1, "the stuck pass");
    const viaMcp = tools.get("sync_garmin")({}); // joins the stuck pass
    await until(() => terminal(first.job_id), "the stuck job to end");
    const ended = repo.getAgentJob(first.job_id);
    assert.equal(ended.status, "error", "not left running — an ordinary failed job");

    const body = JSON.parse((await viaMcp).content[0].text);
    assert.deepEqual(body, { ok: false, error: "Garmin sync timed out", code: "timed_out" });

    const retry = await post(base);
    assert.notEqual(retry.job_id, first.job_id, "a fresh job, not the dead one");
    assert.equal(retry.joined, false);
    await until(() => held.calls.length === 2, "a fresh pass for the retry");
    held.calls[1].release(OK(4));
    await until(() => terminal(retry.job_id), "the retry");
    assert.deepEqual(repo.getAgentJob(retry.job_id).result, OK(4));
  });
});

test("Stop on a stuck sync job frees the lane and the pass at once", async () => {
  const held = heldPass();
  setGarminSyncPassForTests(held.pass); // the real four-minute deadline: only Stop can help
  await withServer(async (base) => {
    const first = await post(base);
    await until(() => held.calls.length === 1, "the stuck pass");
    const stopped = await (await fetch(`${base}/api/agent-jobs/${first.job_id}/cancel`, { method: "POST" })).json();
    assert.equal(stopped.ok, true);
    assert.equal(repo.getAgentJob(first.job_id).status, "canceled");
    assert.equal(held.calls[0].signal.aborted, true, "the pass got the Stop");
    assert.equal(held.calls[0].signal.reason?.code, "canceled");

    const next = await post(base);
    assert.notEqual(next.job_id, first.job_id);
    await until(() => held.calls.length === 2, "the next job's pass — the lane is free");
    held.calls[1].release(OK(1));
    await until(() => terminal(next.job_id), "the next job");
    assert.equal(repo.getAgentJob(next.job_id).status, "done");
    assert.equal(repo.getAgentJob(first.job_id).status, "canceled", "the stopped job stays stopped");
    // The abandoned pass coming back late changes nothing.
    held.calls[0].release(OK(99));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(repo.getAgentJob(first.job_id).status, "canceled");
    assert.equal(repo.getAgentJob(next.job_id).result.activities, 1);
  });
});
