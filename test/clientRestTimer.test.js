import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(name) {
    this.values.add(name);
  }

  remove(name) {
    this.values.delete(name);
  }

  toggle(name, force) {
    if (force === true) this.values.add(name);
    else if (force === false) this.values.delete(name);
    else if (this.values.has(name)) this.values.delete(name);
    else this.values.add(name);
    return this.values.has(name);
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeButton {
  constructor(delta) {
    this.dataset = { r: String(delta) };
    this.handlers = {};
  }

  addEventListener(name, handler) {
    this.handlers[name] = handler;
  }

  click() {
    return this.handlers.click?.();
  }
}

class FakeRestBar {
  constructor() {
    this.className = "";
    this.classList = new FakeClassList();
    this.children = {
      ".rest-fill": { style: { width: "" } },
      ".rest-time": { textContent: "" },
      ".rest-skip": { textContent: "" },
    };
    this.buttons = [];
  }

  set innerHTML(_value) {
    this.buttons = [new FakeButton(-15), new FakeButton(15), new FakeButton(0)];
  }

  querySelector(selector) {
    return this.children[selector] || null;
  }

  querySelectorAll(selector) {
    return selector === "[data-r]" ? this.buttons : [];
  }
}

// A fake wall clock is the whole point of the deadline model: nothing here
// counts ticks, so every assertion moves `now` and asks what the module derives.
function loadRestTimer({ restSec = null, store = new Map(), now = 1_700_000_000_000, visibility = "visible" } = {}) {
  const intervals = new Map();
  const body = {
    classList: new FakeClassList(),
    dataset: {},
    appended: [],
    appendChild(el) {
      this.appended.push(el);
    },
  };
  const toasts = [];
  const vibrations = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  let nextIntervalId = 1;
  if (restSec != null && !store.has("restSec")) store.set("restSec", String(restSec));
  const clock = { now };
  const context = {
    JSON,
    Math,
    Number,
    Object,
    String,
    Date: { now: () => clock.now },
    document: {
      body,
      get visibilityState() {
        return clock.visibility ?? visibility;
      },
      createElement: () => new FakeRestBar(),
      getElementById: () => null,
      querySelector: (selector) => (selector === ".rest" ? body.appended[0] || null : null),
      addEventListener: (type, handler) => documentListeners.set(type, handler),
    },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    navigator: {
      vibrate: (pattern) => vibrations.push(pattern),
    },
    toast: (message) => toasts.push(message),
    setInterval: (handler) => {
      const id = nextIntervalId++;
      intervals.set(id, handler);
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
    },
  };
  context.window = context;
  context.window.addEventListener = (type, handler) => windowListeners.set(type, handler);
  vm.runInNewContext(readFileSync(join(root, "public/js/rest-timer.js"), "utf8"), context);
  return {
    rest: context.CairnRestTimer,
    context,
    body,
    intervals,
    toasts,
    vibrations,
    store,
    clock,
    tick: () => [...intervals.values()].forEach((handler) => handler()),
    advance: (ms) => {
      clock.now += ms;
    },
    hide: () => {
      clock.visibility = "hidden";
    },
    show: () => {
      clock.visibility = "visible";
      documentListeners.get("visibilitychange")?.();
    },
    pageshow: () => windowListeners.get("pageshow")?.(),
    focus: () => windowListeners.get("focus")?.(),
  };
}

function fillPercent(bar) {
  return Number(String(bar.children[".rest-fill"].style.width).replace("%", ""));
}

function attachRenderDispatch(env) {
  const { context } = env;
  context.headerTitle = { classList: new FakeClassList() };
  context.updateHeaderCondense = () => {};
  context.releaseWakeLock = undefined;
  context.PROGRESS_HANDLERS = {};
  context.defaultProgressSeg = () => "history";
  context.state = { planJump: null, planSeg: null };
  context.CairnStand = { renderStand: () => {} };
  for (const name of [
    "renderToday",
    "renderSession",
    "renderChat",
    "renderFoodJournal",
    "renderMeals",
    "renderCoach",
    "renderPlanEndurance",
    "renderPlanEditor",
    "renderHistory",
    "renderMe",
    "renderSettings",
  ]) {
    context[name] = () => {};
  }
  vm.runInNewContext(readFileSync(join(root, "public/js/app-render-dispatch.js"), "utf8"), context);
}

test("rest timer renders controls and derives the countdown from the deadline", () => {
  const env = loadRestTimer({ restSec: 90 });

  env.rest.startRest();
  const bar = env.body.appended[0];

  assert.equal(env.body.classList.contains("resting"), true);
  assert.equal(bar.classList.contains("show"), true);
  assert.equal(bar.children[".rest-time"].textContent, "Rest 1:30");
  assert.equal(fillPercent(bar), 100);

  // No tick fired — the clock alone moves the countdown.
  env.advance(30_000);
  env.tick();
  assert.equal(bar.children[".rest-time"].textContent, "Rest 1:00");
  assert.equal(Math.round(fillPercent(bar)), 67);

  env.rest.stopRest();
  assert.equal(bar.classList.contains("show"), false);
  assert.equal(env.body.classList.contains("resting"), false);
});

test("−15 shortens the rest without the fill jumping backward, and teaches the next set", () => {
  const env = loadRestTimer({ restSec: 90 });
  env.rest.startRest();
  const bar = env.body.appended[0];

  env.advance(30_000);
  env.tick();
  const before = fillPercent(bar);

  bar.buttons[0].click(); // −15
  const after = fillPercent(bar);
  assert.equal(bar.children[".rest-time"].textContent, "Rest 0:45");
  assert.ok(after < before, `−15 must not raise the fill (was ${before}%, now ${after}%)`);
  // total shrank with the deadline: 45 remaining of a 75s rest.
  assert.equal(Math.round(after), 60);
  // The adjust is the preference for the next set.
  assert.equal(env.store.get("restSec"), "75");

  bar.buttons[1].click(); // +15
  assert.equal(bar.children[".rest-time"].textContent, "Rest 1:00");
  assert.equal(env.store.get("restSec"), "90");
});

test("the countdown lands into a quiet count-up, announced once with vibration", () => {
  const env = loadRestTimer();

  env.rest.startRest(60);
  const bar = env.body.appended[0];
  env.advance(60_000);
  env.tick();

  // The bar stays up — this readout is the point on a heavy lift.
  assert.equal(bar.classList.contains("show"), true);
  assert.equal(bar.classList.contains("rested"), true);
  assert.equal(bar.children[".rest-time"].textContent, "Rested 1:00");
  assert.equal(bar.children[".rest-skip"].textContent, "Done");
  assert.deepEqual(env.toasts, ["Rested 1:00"]);
  assert.deepEqual(env.vibrations, [150]);

  env.advance(20_000);
  env.tick();
  assert.equal(bar.children[".rest-time"].textContent, "Rested 1:20");
  assert.deepEqual(env.toasts, ["Rested 1:00"], "the completion is announced exactly once");
  assert.deepEqual(env.vibrations, [150]);

  // ±15 has no deadline left to move.
  bar.buttons[0].click();
  assert.equal(bar.children[".rest-time"].textContent, "Rested 1:20");
});

test("a locked phone returning after five minutes reports the rest it actually took", () => {
  const env = loadRestTimer();
  env.rest.startRest(120);
  const bar = env.body.appended[0];

  // Suspended: no ticks run at all while hidden.
  env.hide();
  env.advance(5 * 60_000);
  assert.deepEqual(env.toasts, []);

  env.show();
  assert.equal(bar.classList.contains("rested"), true);
  assert.equal(bar.children[".rest-time"].textContent, "Rested 5:00");
  assert.deepEqual(env.toasts, ["Rested 5:00"], "on return it says what happened, not 'Rest done'");
  assert.deepEqual(env.vibrations, [150]);

  env.show();
  env.pageshow();
  env.focus();
  assert.deepEqual(env.toasts, ["Rested 5:00"], "reconciling again must not re-announce");
});

test("pageshow and focus reconcile a still-running countdown against the clock", () => {
  const env = loadRestTimer();
  env.rest.startRest(180);
  const bar = env.body.appended[0];

  env.advance(60_000);
  env.pageshow();
  assert.equal(bar.children[".rest-time"].textContent, "Rest 2:00");

  env.advance(30_000);
  env.focus();
  assert.equal(bar.children[".rest-time"].textContent, "Rest 1:30");
  assert.deepEqual(env.toasts, []);
});

test("a persisted rest survives a reload and picks up where the clock says it is", () => {
  const first = loadRestTimer();
  first.rest.startRest(120);
  assert.ok(first.store.has("cairn.rest.v1"));

  // The service worker's controllerchange reload (or an iOS app relaunch): a
  // brand-new module instance, the same device storage, a later clock.
  const second = loadRestTimer({ store: first.store, now: first.clock.now + 5 * 60_000 });

  assert.deepEqual(second.body.appended, [], "restore does not show the bar before the tab is known");
  assert.equal(second.body.classList.contains("resting"), false);
  assert.equal(second.intervals.size, 1, "the repaint pump is re-armed");
  assert.deepEqual(second.toasts, ["Rested 5:00"]);

  second.rest.surfaceRestBar();
  const bar = second.body.appended[0];
  assert.ok(bar, "surfacing after restore creates the bar");
  assert.equal(bar.classList.contains("show"), true);
  assert.equal(bar.classList.contains("rested"), true);
  assert.equal(bar.children[".rest-time"].textContent, "Rested 5:00");
});

test("restore then renderAppTab shows the bar only on a logging tab", () => {
  const first = loadRestTimer();
  first.rest.startRest(120);

  const second = loadRestTimer({ store: first.store, now: first.clock.now + 30_000 });
  assert.deepEqual(second.body.appended, [], "restore does not show the bar before the tab is known");
  assert.equal(second.body.classList.contains("resting"), false);

  attachRenderDispatch(second);
  second.context.renderTab("chat");
  assert.deepEqual(second.body.appended, [], "Chat does not surface a restored rest");
  assert.equal(second.body.classList.contains("resting"), false);

  second.context.renderTab("session");
  const bar = second.body.appended[0];
  assert.ok(bar, "Session surfaces the restored rest");
  assert.equal(bar.classList.contains("show"), true);
  assert.equal(second.body.classList.contains("resting"), true);
  assert.equal(bar.children[".rest-time"].textContent, "Rest 1:30");
});

test("a rest older than the walk-away cutoff is discarded silently on restore", () => {
  const first = loadRestTimer();
  first.rest.startRest(120);

  const second = loadRestTimer({ store: first.store, now: first.clock.now + 31 * 60_000 });

  assert.deepEqual(second.body.appended, [], "no bar comes back for a rest they walked away from");
  assert.deepEqual(second.toasts, []);
  assert.deepEqual(second.vibrations, []);
  assert.equal(second.store.has("cairn.rest.v1"), false, "the stale record is cleared");
});

test("stopRest clears the persisted rest so nothing restores it", () => {
  const env = loadRestTimer();
  env.rest.startRest(120);
  assert.ok(env.store.has("cairn.rest.v1"));

  env.rest.stopRest();
  assert.equal(env.store.has("cairn.rest.v1"), false);
  assert.equal(env.intervals.size, 0);

  const next = loadRestTimer({ store: env.store, now: env.clock.now + 1000 });
  assert.deepEqual(next.body.appended, []);
});

test("a completion tick while hidden still announces once on return", () => {
  const env = loadRestTimer();
  env.rest.startRest();
  const bar = env.body.appended[0];

  env.hide();
  env.advance(3 * 60_000);
  env.tick();
  assert.deepEqual(env.toasts, [], "a hidden completion tick must not announce");
  assert.deepEqual(env.vibrations, []);
  assert.equal(bar.classList.contains("rested"), true);

  env.advance(60_000);
  env.show();
  assert.deepEqual(env.toasts, ["Rested 4:00"]);
  assert.deepEqual(env.vibrations, [150]);

  env.show();
  env.pageshow();
  env.focus();
  assert.deepEqual(env.toasts, ["Rested 4:00"], "the deferred announce is still once");
  assert.deepEqual(env.vibrations, [150]);
});

test("a rested bar older than the walk-away cutoff stops quietly while the tab stays visible", () => {
  const env = loadRestTimer();
  env.rest.startRest(120);
  const bar = env.body.appended[0];
  env.advance(120_000);
  env.tick();
  assert.deepEqual(env.toasts, ["Rested 2:00"]);
  assert.equal(bar.classList.contains("show"), true);

  env.advance(31 * 60_000);
  env.tick();
  assert.equal(bar.classList.contains("show"), false);
  assert.equal(env.body.classList.contains("resting"), false);
  assert.deepEqual(env.toasts, ["Rested 2:00"], "the stale drop must not toast");
  assert.deepEqual(env.vibrations, [150]);
  assert.equal(env.store.has("cairn.rest.v1"), false);
});

test("hiding the rest bar keeps the deadline so a logging tab can restore it", () => {
  const env = loadRestTimer();
  env.rest.startRest(120);
  const bar = env.body.appended[0];
  assert.equal(bar.classList.contains("show"), true);
  assert.equal(env.body.classList.contains("resting"), true);

  env.rest.hideRestBar();
  assert.equal(bar.classList.contains("show"), false);
  assert.equal(env.body.classList.contains("resting"), false);
  assert.ok(env.store.has("cairn.rest.v1"), "the deadline stays persisted");

  env.advance(30_000);
  env.rest.surfaceRestBar();
  assert.equal(bar.classList.contains("show"), true);
  assert.equal(env.body.classList.contains("resting"), true);
  assert.equal(bar.children[".rest-time"].textContent, "Rest 1:30");
});

test("the rest clock grows an hour place past 60 minutes", () => {
  const env = loadRestTimer();
  env.rest.startRest(60);
  env.advance(60_000);
  env.tick();
  // Paint without ticking so the 30-minute stale cutoff does not fire — this
  // is the readout a stuck bar used to show as "61:01".
  env.advance(3601_000);
  env.rest.paintRest();
  assert.equal(env.body.appended[0].children[".rest-time"].textContent, "Rested 1:01:01");
});

test("−15 does not teach a floor-clamped junk default, and restSec stays in [30, 600]", () => {
  const clamped = loadRestTimer({ restSec: 120 });
  clamped.rest.startRest();
  clamped.advance(115_000);
  clamped.tick();
  clamped.body.appended[0].buttons[0].click(); // −15 with 5 s left
  assert.equal(clamped.store.get("restSec"), "120", "a floor-clamped −15 must not rewrite the preference");

  const low = loadRestTimer({ restSec: 40 });
  low.rest.startRest();
  low.body.appended[0].buttons[0].click(); // −15 → 25 s live rest
  assert.equal(low.store.get("restSec"), "30");

  const high = loadRestTimer({ restSec: 590 });
  high.rest.startRest();
  high.body.appended[0].buttons[1].click(); // +15 → 605 s live rest
  assert.equal(high.store.get("restSec"), "600");
});

test("rested ±15 buttons keep their layout slot so Done does not jump", () => {
  const css = readFileSync(join(root, "public/styles.css"), "utf8");
  assert.match(css, /\.rest\.rested \.rest-btn:not\(\.rest-skip\)\{visibility:hidden\}/);
  assert.doesNotMatch(css, /\.rest\.rested \.rest-btn:not\(\.rest-skip\)\{display:none\}/);
});
