// GET /api/week-ahead must never spawn a coaching CLI inline on the request
// path (scheduler.ts "week_ahead_warm_date" / agentJobs.ts "week_ahead").
// weekAheadServe is the synchronous, agent-free cache read the route now
// calls; ensureWeekAheadJob is the durable, deduplicated background kickoff
// that fills the cache for next time. This file proves: a cold GET returns
// fast with no agent spawn, a warm cache is served untouched, a stale cache
// is served immediately while flagged for a background refresh, in-flight
// jobs dedupe onto one row, and the scheduler warm is idempotent per day (the
// exact op body restated here, mirroring directiveDeriveSchedule.test.js's
// practice, so drift in scheduler.ts shows up here too).
import assert from "node:assert/strict";
import test from "node:test";
import { ensureWeekAheadJob } from "../dist/agentJobs.js";
import { weekAheadCacheKey, weekAheadServe } from "../dist/coachOps.js";
import { db, repo } from "./_seed.js";

const cachedWeek = {
  ok: true,
  days: [{ day: "Today", kind: "lift", label: "Warm cache fixture" }],
  summary: "Served straight from cache — no agent call.",
  source: "agent",
  cached: false,
  agent: "cached",
};

function seedWeekCache(freshForMs = 18 * 60 * 60 * 1000) {
  const cacheKey = weekAheadCacheKey(repo.weekAheadPlan());
  repo.saveAiCache("week_ahead", cacheKey, {
    result: cachedWeek,
    chosen_agent: "cached",
    freshForMs,
  });
  return cacheKey;
}

function weekAheadJobRows() {
  return db.prepare(`SELECT * FROM agent_jobs WHERE kind = 'week_ahead'`).all();
}

test("weekAheadServe is a plain synchronous function — it cannot itself await an agent subprocess", () => {
  assert.equal(weekAheadServe.constructor.name, "Function", "must stay sync, never AsyncFunction");
});

test("a cold cache returns the deterministic floor immediately, marked computing, with no agent spawn", () => {
  const { response, needsRefresh, cacheKey } = weekAheadServe();
  assert.equal(response.ok, true);
  assert.equal(response.source, "deterministic");
  assert.equal(response.cached, false);
  assert.equal(response.computing, true);
  assert.ok(Array.isArray(response.days), "the floor still has a usable (if empty, on a plan-less DB) shape");
  assert.equal(typeof response.summary, "string");
  assert.equal(needsRefresh, true);
  assert.equal(typeof cacheKey, "string");
  assert.equal(weekAheadJobRows().length, 0, "reading the cache must never itself create/spawn a job");
});

test("a fresh cache hit is served untouched — no refresh needed, no computing marker", () => {
  seedWeekCache();
  const { response, needsRefresh } = weekAheadServe();
  assert.equal(response.ok, true);
  assert.equal(response.source, "agent");
  assert.equal(response.cached, true);
  assert.equal(response.computing, undefined);
  assert.equal(response.days[0].label, cachedWeek.days[0].label);
  assert.equal(needsRefresh, false);
});

test("a stale cache is still served instantly, but flagged for a background refresh", () => {
  seedWeekCache(-1000); // already past stale_after
  const { response, needsRefresh } = weekAheadServe();
  assert.equal(response.ok, true);
  assert.equal(response.source, "agent");
  assert.equal(response.cached, true);
  assert.equal(response.stale, true);
  assert.equal(response.computing, true);
  assert.equal(response.days[0].label, cachedWeek.days[0].label, "the stale answer is still the real cached one");
  assert.equal(needsRefresh, true);
});

test("ensureWeekAheadJob queues exactly one job for a cold cacheKey, carrying the requested agent", () => {
  const { cacheKey } = weekAheadServe();
  const { job, created } = ensureWeekAheadJob("stub", cacheKey);
  assert.equal(created, true);
  assert.equal(job.status, "queued");
  assert.equal(job.kind, "week_ahead");
  assert.equal(job.agent, "stub");
  assert.equal(job.input.cacheKey, cacheKey);
  assert.equal(weekAheadJobRows().length, 1);
});

test("a second ensureWeekAheadJob call for the same cacheKey dedupes onto the in-flight job", () => {
  const { cacheKey } = weekAheadServe();
  const first = ensureWeekAheadJob(undefined, cacheKey);
  const second = ensureWeekAheadJob("stub", cacheKey);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
  assert.equal(weekAheadJobRows().length, 1, "a burst of cold GETs must spawn at most one CLI per day+fingerprint");
});

test("a DIFFERENT cacheKey (e.g. a new day) is never coalesced into another day's job", () => {
  const { cacheKey } = weekAheadServe();
  const first = ensureWeekAheadJob(undefined, cacheKey);
  const second = ensureWeekAheadJob(undefined, `${cacheKey}-different-day`);
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.notEqual(second.job.id, first.job.id);
  assert.equal(weekAheadJobRows().length, 2);
});

test("once a job for a cacheKey is terminal, a later miss/staleness starts a fresh dedup window", () => {
  const { cacheKey } = weekAheadServe();
  const { job } = ensureWeekAheadJob(undefined, cacheKey);
  // Simulate the worker finishing the job (success or failure — either is terminal).
  db.prepare(`UPDATE agent_jobs SET status = 'done' WHERE id = ?`).run(job.id);
  const again = ensureWeekAheadJob(undefined, cacheKey);
  assert.equal(again.created, true, "a finished job is not a match — it must not block a fresh warm");
  assert.notEqual(again.job.id, job.id);
  assert.equal(weekAheadJobRows().length, 2);
});

// ---- the scheduler warm (day rollover) ----
// The exact op body scheduler.ts's weekAheadWarmTick runs, restated here per the
// project's convention (directiveDeriveSchedule.test.js) so drift shows up here.
const weekAheadWarmOp = () => {
  const { needsRefresh, cacheKey } = weekAheadServe();
  if (needsRefresh) ensureWeekAheadJob(undefined, cacheKey);
  return { outcome: "succeeded", value: { needsRefresh } };
};

test("the scheduler warm op queues a background job on a cold cache and acknowledges its slot", async () => {
  const run = await repo.runSchedulerOperation("week_ahead_warm_date", "2026-08-17", weekAheadWarmOp);
  assert.equal(run.status, "succeeded");
  assert.equal(run.value.needsRefresh, true);
  assert.equal(weekAheadJobRows().length, 1);
  assert.equal(
    repo.schedulerOperationDue("week_ahead_warm_date", "2026-08-17"),
    false,
    "the day's slot is acknowledged after the warm ran"
  );
});

test("the scheduler warm is idempotent per day — a second run for the same slot does not attempt again", async () => {
  await repo.runSchedulerOperation("week_ahead_warm_date", "2026-08-17", weekAheadWarmOp);
  assert.equal(weekAheadJobRows().length, 1);
  // dailySlotDue's real guard (repo.getAppState(...) === slotStamp) is what
  // scheduler.ts checks BEFORE calling runScheduled at all; schedulerOperationDue
  // is the durable half of that same guard exercised directly here.
  assert.equal(repo.schedulerOperationDue("week_ahead_warm_date", "2026-08-17"), false);
  const second = await repo.runSchedulerOperation("week_ahead_warm_date", "2026-08-17", weekAheadWarmOp);
  assert.equal(second.attempted, false, "an already-succeeded slot is not re-run");
  assert.equal(weekAheadJobRows().length, 1, "no second job was queued for the same day");
});

test("the scheduler warm is a calm no-op once the cache is already fresh", async () => {
  seedWeekCache();
  const run = await repo.runSchedulerOperation("week_ahead_warm_date", "2026-08-18", weekAheadWarmOp);
  assert.equal(run.status, "succeeded");
  assert.equal(run.value.needsRefresh, false);
  assert.equal(weekAheadJobRows().length, 0, "a fresh cache must not spawn a job it does not need");
});

// ---- the timeout floor (weekAheadRead itself, unchanged by this work) ----
// A real hung-CLI timeout cannot be exercised offline (no agent CLI, no
// network — see CLAUDE.md), so this locks in, by source inspection, that the
// background computation still routes through the existing bounded timeout
// machinery rather than re-deriving or dropping it.
test("weekAheadRead still bounds its agent call with interactiveTimeoutForOp — a hung CLI cannot hold the job slot", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../src/coachOps.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /runChosen\(agent, prompt, \{\s*op: WEEK_AHEAD_KIND,\s*timeoutMs: repo\.interactiveTimeoutForOp\(WEEK_AHEAD_KIND\)/,
    "the week-ahead agent call must stay bounded by the shared interactive timeout"
  );
});
