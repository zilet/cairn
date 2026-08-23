// Client midnight/resume rollover (Track A / A3). state.logDate is set once at boot,
// so a PWA resumed after midnight keeps yesterday's date + Brief. The rollover
// decision is extracted as a pure function so the rule is deterministically tested
// without DOM, timers, or a real clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadRollover() {
  // The module block only touches globalThis/window (via typeof) + Object.assign at
  // load; document/window/setTimeout are referenced only inside the installer, which
  // we never call here. So a minimal context is enough.
  const context = { Date, Math, Object };
  vm.runInNewContext(readFileSync(join(root, "public/js/app-day-rollover.js"), "utf8"), context);
  return context;
}

test("dayRolloverTarget rolls only when the day changed and the user hasn't picked a date", () => {
  const { dayRolloverTarget } = loadRollover();
  assert.equal(typeof dayRolloverTarget, "function");

  // Still the same calendar day -> nothing to do.
  assert.equal(dayRolloverTarget("2026-07-09", "2026-07-09", false), null);
  // The day genuinely rolled and the user hasn't steered -> roll to the new day.
  assert.equal(dayRolloverTarget("2026-07-09", "2026-07-10", false), "2026-07-10");
  // No measurable date -> no-op (defensive).
  assert.equal(dayRolloverTarget("2026-07-09", "", false), null);
});

test("dayRolloverTarget catches up when the pick was made on the day it names", () => {
  const { dayRolloverTarget } = loadRollover();
  // dayPicked is set by ordinary same-day actions too (tapping a plan day, entering
  // a manual-plan session), so honouring it behind the calendar stranded a resumed
  // PWA on yesterday's Brief forever. A pick anchored to the day it names was simply
  // "today" when it was made, and rolling it forward contradicts no intent.
  assert.equal(dayRolloverTarget("2026-07-09", "2026-07-10", true, "2026-07-09"), "2026-07-10");
  // Deliberately looking AHEAD of the calendar is still left alone.
  assert.equal(dayRolloverTarget("2026-07-11", "2026-07-10", true, "2026-07-11"), null);
  // Same day is a no-op whatever dayPicked says.
  assert.equal(dayRolloverTarget("2026-07-10", "2026-07-10", true, "2026-07-10"), null);
});

test("dayRolloverTarget never drags a deliberately opened past day to today", () => {
  const { dayRolloverTarget } = loadRollover();
  // The athlete opens Saturday on Monday to log that workout: the pick was made on
  // 07-10 and names 07-08. Switching apps and returning must not re-point logging at
  // 07-10 — the sets they type next belong to the day they opened.
  assert.equal(dayRolloverTarget("2026-07-08", "2026-07-10", true, "2026-07-10"), null);
  // Still true after another midnight passes while the past day is open.
  assert.equal(dayRolloverTarget("2026-07-08", "2026-07-11", true, "2026-07-10"), null);
  // With no anchor at all we cannot tell a stale pick from a deliberate one, so the
  // picked date stands.
  assert.equal(dayRolloverTarget("2026-07-08", "2026-07-10", true), null);
  assert.equal(dayRolloverTarget("2026-07-08", "2026-07-10", true, null), null);
  // No pick behind the calendar is still stale however it got there.
  assert.equal(dayRolloverTarget("2026-07-08", "2026-07-10", false, "2026-07-10"), "2026-07-10");
});

// Rolling the date forward without clearing the pick left Today opening on a stale
// plan day, and openSession then read the retained pick as a manual plan choice.
// The watcher has to arrive on the new day the way "Back to today" does.
test("the rollover watcher resets the pick it just outlived", () => {
  const listeners = {};
  const context = {
    Date,
    Math,
    Object,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    document: {
      visibilityState: "visible",
      addEventListener: (name, fn) => { listeners[name] = fn; },
    },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    state: {
      tab: "today",
      logDate: "2026-07-09",
      day: 3,
      dayPicked: true,
      dayPickedOn: "2026-07-09",
      brief: { read: "yesterday" },
    },
    localISO: () => "2026-07-10",
    activateTab: (tab, opts) => { context.activated = { tab, opts }; },
    syncRouteFromState: (mode) => { context.synced = mode; },
  };
  vm.runInNewContext(readFileSync(join(root, "public/js/app-day-rollover.js"), "utf8"), context);
  context.window.installDayRolloverWatcher();
  listeners.visibilitychange();

  assert.equal(context.state.logDate, "2026-07-10");
  assert.equal(context.state.dayPicked, false);
  assert.equal(context.state.dayPickedOn, null);
  assert.equal(context.state.day, null);
  assert.equal(context.state.brief, null);
  // The objects come from the vm realm, so compare by value, not by prototype.
  assert.equal(context.activated.tab, "today");
  assert.equal(context.activated.opts.syncRoute, false);
  assert.equal(context.synced, "replace");
});

test("the rollover watcher leaves a deliberately opened past day alone", () => {
  const listeners = {};
  const context = {
    Date,
    Math,
    Object,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    document: {
      visibilityState: "visible",
      addEventListener: (name, fn) => { listeners[name] = fn; },
    },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    // Opened 07-08 on 07-10 to log that day's workout, then switched apps.
    state: { tab: "today", logDate: "2026-07-08", day: 2, dayPicked: true, dayPickedOn: "2026-07-10" },
    localISO: () => "2026-07-10",
    activateTab: () => { context.activated = true; },
    syncRouteFromState: () => { context.synced = true; },
  };
  vm.runInNewContext(readFileSync(join(root, "public/js/app-day-rollover.js"), "utf8"), context);
  context.window.installDayRolloverWatcher();
  listeners.visibilitychange();
  listeners.pageshow();

  assert.equal(context.state.logDate, "2026-07-08");
  assert.equal(context.state.day, 2);
  assert.equal(context.state.dayPicked, true);
  assert.equal(context.activated, undefined);
  assert.equal(context.synced, undefined);
});
