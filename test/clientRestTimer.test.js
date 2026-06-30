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

function loadRestTimer({ restSec = null } = {}) {
  const intervals = new Map();
  const body = {
    classList: new FakeClassList(),
    appended: [],
    appendChild(el) {
      this.appended.push(el);
    },
  };
  const toasts = [];
  const vibrations = [];
  let nextIntervalId = 1;
  const context = {
    Math,
    Number,
    Object,
    String,
    document: {
      body,
      createElement: () => new FakeRestBar(),
      querySelector: (selector) => (selector === ".rest" ? body.appended[0] || null : null),
    },
    localStorage: {
      getItem: (key) => (key === "restSec" && restSec != null ? String(restSec) : null),
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
  vm.runInNewContext(readFileSync(join(root, "public/js/rest-timer.js"), "utf8"), context);
  return { rest: context.CairnRestTimer, body, intervals, toasts, vibrations };
}

test("rest timer renders controls and applies adjustments", () => {
  const { rest, body } = loadRestTimer({ restSec: 90 });

  rest.startRest();
  const bar = body.appended[0];

  assert.equal(body.classList.contains("resting"), true);
  assert.equal(bar.classList.contains("show"), true);
  assert.equal(bar.children[".rest-time"].textContent, "Rest 1:30");
  assert.equal(bar.children[".rest-fill"].style.width, "100%");

  bar.buttons[0].click();
  assert.equal(bar.children[".rest-time"].textContent, "Rest 1:15");

  bar.buttons[1].click();
  assert.equal(bar.children[".rest-time"].textContent, "Rest 1:30");

  bar.buttons[2].click();
  assert.equal(bar.classList.contains("show"), false);
  assert.equal(body.classList.contains("resting"), false);
});

test("rest timer completes with toast and vibration", () => {
  const { rest, body, intervals, toasts, vibrations } = loadRestTimer();

  rest.startRest(1);
  const handler = [...intervals.values()][0];
  handler();

  assert.equal(body.appended[0].classList.contains("show"), false);
  assert.deepEqual(toasts, ["Rest done"]);
  assert.deepEqual(vibrations, [150]);
  assert.equal(intervals.size, 0);
});
