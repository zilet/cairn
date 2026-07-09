// Recompute-on-invalidate scheduler (Track A / A1). invalidateDayRead() clears the
// cached Brief, then arms a DEBOUNCED, COALESCED, fire-and-forget background
// recompute so the next open serves a warm agentic read instead of paying the ~90s
// agent run inline. These pin the load-bearing guarantees with the effectful edges
// (clock, agent gate, recompute, timer) injected, so no real timer, clock, or CLI runs:
//   - a burst of same-day signals collapses to ONE armed recompute (coalesce)
//   - only a TODAY invalidation arms anything (a past/future date is ignored)
//   - a fired debounce recomputes exactly once when an agent is usable
//   - NO usable agent -> the recompute does nothing (never re-caches a floor / spawns a CLI)
//   - reset() clears a pending timer so it can't leak across tests
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import {
  scheduleDayReadRefresh,
  configureDayReadRefresh,
  flushDayReadRefresh,
  resetDayReadRefresh,
} from "../dist/dayread-refresh.js";

// A deterministic fake timer: captures the scheduled callback + delay with no real
// clock, so debounce/coalesce is asserted precisely. The debounce only ever keeps
// one live timer, so `fireLatest` runs the most recently armed callback.
function fakeTimer() {
  let seq = 0;
  const timers = new Map();
  return {
    calls: { set: 0, clear: 0 },
    set(fn) { this.calls.set++; const id = ++seq; timers.set(id, fn); return id; },
    clear(id) { this.calls.clear++; timers.delete(id); },
    fireLatest() {
      const ids = [...timers.keys()];
      const id = ids[ids.length - 1];
      const fn = timers.get(id);
      timers.delete(id);
      if (fn) fn();
    },
    pending() { return timers.size; },
  };
}

const FIXED_TODAY = "2026-07-09";

beforeEach(() => resetDayReadRefresh());

test("coalesces a burst of same-day signals into ONE armed recompute", () => {
  const timer = fakeTimer();
  configureDayReadRefresh({
    today: () => FIXED_TODAY,
    setTimer: (fn) => timer.set(fn),
    clearTimer: (id) => timer.clear(id),
  });
  // A 20-set logging session -> 20 invalidations, all for today.
  for (let i = 0; i < 20; i++) scheduleDayReadRefresh(FIXED_TODAY);
  assert.equal(timer.calls.set, 20, "each signal (re)arms the debounce");
  assert.equal(timer.calls.clear, 19, "each new signal clears the prior pending timer");
  assert.equal(timer.pending(), 1, "exactly ONE recompute is left armed");
});

test("only schedules when the invalidated date covers today", () => {
  const timer = fakeTimer();
  configureDayReadRefresh({
    today: () => FIXED_TODAY,
    setTimer: (fn) => timer.set(fn),
    clearTimer: (id) => timer.clear(id),
  });
  scheduleDayReadRefresh("2026-07-01"); // a past date
  scheduleDayReadRefresh("2026-08-15"); // a future date
  assert.equal(timer.calls.set, 0, "a non-today invalidation never arms a recompute");
  scheduleDayReadRefresh(); // no arg -> defaults to today
  assert.equal(timer.calls.set, 1, "an undated (today) invalidation arms one");
  scheduleDayReadRefresh(FIXED_TODAY); // today, explicitly
  assert.equal(timer.calls.set, 2);
});

test("a fired debounce runs the recompute exactly ONCE when an agent is available", async () => {
  const timer = fakeTimer();
  let recomputes = 0;
  configureDayReadRefresh({
    today: () => FIXED_TODAY,
    setTimer: (fn) => timer.set(fn),
    clearTimer: (id) => timer.clear(id),
    agentsAvailable: () => true,
    recompute: () => { recomputes++; },
  });
  for (let i = 0; i < 5; i++) scheduleDayReadRefresh(FIXED_TODAY);
  assert.equal(recomputes, 0, "nothing runs until the debounce fires");
  timer.fireLatest();
  await flushDayReadRefresh();
  assert.equal(recomputes, 1, "the coalesced burst produced exactly one recompute");
});

test("no usable agent -> the recompute does NOTHING (no floor re-cache, no CLI)", async () => {
  const timer = fakeTimer();
  let recomputes = 0;
  configureDayReadRefresh({
    today: () => FIXED_TODAY,
    setTimer: (fn) => timer.set(fn),
    clearTimer: (id) => timer.clear(id),
    agentsAvailable: () => false,
    recompute: () => { recomputes++; },
  });
  scheduleDayReadRefresh(FIXED_TODAY);
  timer.fireLatest();
  await flushDayReadRefresh();
  assert.equal(recomputes, 0, "the gate short-circuits before any recompute / CLI spawn");
});

test("the REAL agent gate uses live settings — all agents disabled -> no recompute", async () => {
  // Exercises the production `agentsAvailable` default (getAgentConfig().some(usable))
  // against real settings, so the offline suite proves the no-agent no-op end to end.
  repo.setSettings({ disabled_agents: ["claude", "codex", "antigravity", "grok", "stub"] });
  const timer = fakeTimer();
  let recomputes = 0;
  configureDayReadRefresh({
    today: () => FIXED_TODAY,
    setTimer: (fn) => timer.set(fn),
    clearTimer: (id) => timer.clear(id),
    // agentsAvailable left as the real default on purpose.
    recompute: () => { recomputes++; },
  });
  scheduleDayReadRefresh(FIXED_TODAY);
  timer.fireLatest();
  await flushDayReadRefresh();
  assert.equal(recomputes, 0, "with every agent disabled the real gate short-circuits");
});

test("resetDayReadRefresh clears a pending timer so it can't leak across tests", () => {
  const timer = fakeTimer();
  configureDayReadRefresh({
    today: () => FIXED_TODAY,
    setTimer: (fn) => timer.set(fn),
    clearTimer: (id) => timer.clear(id),
  });
  scheduleDayReadRefresh(FIXED_TODAY);
  assert.equal(timer.pending(), 1);
  resetDayReadRefresh();
  assert.equal(timer.pending(), 0, "reset cleared the armed timer");
});
