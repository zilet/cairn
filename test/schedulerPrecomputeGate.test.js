// The nightly Brief precompute's two failure seams, as their own exported pieces.
//
// The tick used to stamp the day BEFORE doing the work, so a single throw burned
// the whole date: the gate said "already ran" until local midnight and the morning
// never got its cached read. And it awaited precomputeDayRead — which ends in an
// external agent — with no bound, so a promise that never settled held the busy
// latch for the life of the process and stopped the stream silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDailyOnceGate, withDeadline } from "../dist/scheduler.js";
import { computeCanonicalDayRead, resetDayReadComputeCoalescing } from "../dist/dayread.js";
import { configureDayReadRefresh } from "../dist/dayread-refresh.js";
import { localDaysAgo, repo } from "./_seed.js";

/** Every CLI off, so a recompute settles on the deterministic floor without spawning. */
function offlineAgents() {
  repo.setSettings({ disabled_agents: ["claude", "codex", "antigravity", "grok", "stub"] });
}

/** A date whose recompute cannot arm a real debounce timer behind the test. */
function quietDate() {
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  resetDayReadComputeCoalescing();
  offlineAgents();
  return date;
}

test("the day is stamped on success, not on the attempt", () => {
  const gate = createDailyOnceGate();
  assert.equal(gate.claim("2026-09-14"), true, "the first run of the day is allowed");
  assert.equal(gate.claim("2026-09-14"), false, "and nothing else starts while it is running");

  gate.release(); // the work threw
  assert.equal(gate.claim("2026-09-14"), true, "a failure does not cost the day");

  gate.succeed("2026-09-14");
  assert.equal(gate.state().done, "2026-09-14");
  assert.equal(gate.state().busy, false, "success releases the latch");
  assert.equal(gate.claim("2026-09-14"), false, "a finished day is never re-run");
});

test("a repeatedly failing day is capped, not retried every tick", () => {
  const gate = createDailyOnceGate(); // default: two attempts
  assert.equal(gate.claim("2026-09-14"), true);
  gate.release();
  assert.equal(gate.claim("2026-09-14"), true);
  gate.release();
  assert.equal(gate.claim("2026-09-14"), false, "out of attempts — the hour is not a retry storm");
  assert.equal(gate.state().attempts, 2);

  assert.equal(gate.claim("2026-09-15"), true, "the next day starts fresh");
  assert.equal(gate.state().attempts, 1);
});

test("an empty stamp never claims", () => {
  const gate = createDailyOnceGate();
  assert.equal(gate.claim(""), false);
  assert.equal(gate.state().busy, false);
});

test("withDeadline passes a settled value straight through", async () => {
  assert.equal(await withDeadline(Promise.resolve("cached"), 5_000, "day-read precompute"), "cached");
});

test("withDeadline rejects a promise that never settles, so the latch always clears", async () => {
  const gate = createDailyOnceGate();
  assert.equal(gate.claim("2026-09-14"), true);
  const never = new Promise(() => {});
  await assert.rejects(async () => {
    try {
      await withDeadline(never, 20, "day-read precompute");
    } finally {
      gate.release();
    }
  }, /day-read precompute did not settle/);
  assert.equal(gate.state().busy, false, "the busy latch is free again");
  assert.equal(gate.claim("2026-09-14"), true, "and the day can still be retried");
});

test("withDeadline surfaces the work's own rejection unchanged", async () => {
  await assert.rejects(
    () => withDeadline(Promise.reject(new Error("agent offline")), 5_000, "day-read precompute"),
    /agent offline/
  );
});

// ---- the deadline has to ABORT, or the retry is not a retry -------------------
// Releasing the latch was only half the fix: computeCanonicalDayRead holds ONE lane
// per date, so the abandoned run stayed in that lane and the second attempt joined
// the same never-settling promise — while the hung CLI went on holding an agent
// permit. The deadline now aborts the run it gave up on, which retires the lane.

test("the deadline tells the run it gave up on to stop", async () => {
  // The tick's own composition: bound the await, and on the bound firing, abort.
  const bail = new AbortController();
  let told = false;
  bail.signal.addEventListener("abort", () => {
    told = true;
  });

  await assert.rejects(async () => {
    try {
      await withDeadline(new Promise(() => {}), 20, "day-read precompute");
    } catch (e) {
      bail.abort();
      throw e;
    }
  }, /day-read precompute did not settle/);

  assert.equal(told, true, "a released latch alone leaves the abandoned run running");
});

test("an aborted precompute retires its lane, so the remaining attempt is a real one", async () => {
  const date = quietDate();

  const bail = new AbortController();
  const abandoned = computeCanonicalDayRead({ date, signal: bail.signal });
  assert.equal(computeCanonicalDayRead({ date }), abandoned, "fixture check: one lane per date while it runs");

  bail.abort(); // exactly what the tick does when withDeadline rejects
  const retry = computeCanonicalDayRead({ date });
  assert.notEqual(retry, abandoned, "the retry starts its own run instead of joining the dead one");

  await Promise.all([abandoned, retry]);
});

test("a run with no deadline keeps the lane it always had", async () => {
  const date = quietDate();

  const first = computeCanonicalDayRead({ date });
  assert.equal(computeCanonicalDayRead({ date }), first, "an unbounded run still shares one lane per date");
  await first;
});

test("a signal already aborted never leaves a lane behind", async () => {
  const date = quietDate();

  const over = computeCanonicalDayRead({ date, signal: AbortSignal.abort() });
  const fresh = computeCanonicalDayRead({ date });
  assert.notEqual(fresh, over, "nothing joins a run that was over before it began");
  await Promise.allSettled([over, fresh]);
});
