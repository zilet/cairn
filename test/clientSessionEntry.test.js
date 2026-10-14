import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeTarget {
  constructor() {
    this.listeners = {};
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
}

function load() {
  const document = new FakeTarget();
  document.activeElement = null;
  document.visibilityState = "visible";
  document.elementFromPoint = () => null;
  const context = { Object, Promise, Date, WeakMap, setTimeout, document, globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/session-entry-client.js"), "utf8"), context);
  return { entry: context.CairnSessionEntry, document };
}

function fakeField(host) {
  return { matches: (sel) => sel.includes("input"), closest: () => ({}), inSurface: host };
}

function fakeHost(document) {
  const host = new FakeTarget();
  host.surface = true;
  host.querySelector = () => (host.surface ? {} : null);
  host.contains = (el) => el?.inSurface === host;
  return host;
}

const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

test("a repaint waits while a field on the surface is focused, then lands once with merged options", async () => {
  const { entry, document } = load();
  const host = fakeHost(document);
  const painted = [];
  const paint = async (opts) => { painted.push(opts); };
  const gated = entry.gate(host, ".sess-dest", paint);
  assert.equal(entry.gate(host, ".sess-dest", paint), gated, "one gate per painter");

  document.activeElement = fakeField(host);
  const a = gated({ soft: true });
  const b = gated({ keepScroll: true });
  await tick();
  assert.deepEqual(painted, [], "nothing replaced the focused field");

  document.activeElement = null;
  host.fire("focusout");
  await Promise.all([a, b]);
  assert.equal(painted.length, 1);
  assert.equal(painted[0].soft, false, "a full request outranks a soft one");
  assert.equal(painted[0].keepScroll, true);
});

test("a repaint waits for a finger to lift, and a fresh entry never waits", async () => {
  const { entry, document } = load();
  const host = fakeHost(document);
  const painted = [];
  const gated = entry.gate(host, ".sess-dest", async (opts) => { painted.push(opts); });

  await gated({}); // installs the watchers; nothing in progress paints at once
  assert.equal(painted.length, 1);
  host.fire("pointerdown");
  const queued = gated({ soft: true });
  await gated({ fresh: true });
  assert.equal(painted.length, 2, "fresh paints immediately");
  document.fire("pointerup");
  await queued;
  assert.equal(painted.length, 3);
});

test("Log acts on a touch pointerup without the click doubling it, and never on a slide-off", () => {
  const { entry, document } = load();
  const button = new FakeTarget();
  button.contains = (el) => el === button;
  let acted = 0;
  entry.tapWithoutBlur(button, () => { acted++; });

  let prevented = false;
  button.fire("pointerdown", { pointerType: "touch", preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, "focus stays on the field being typed in");
  document.elementFromPoint = () => button;
  button.fire("pointerup", { pointerType: "touch", clientX: 1, clientY: 1 });
  button.fire("click", {});
  assert.equal(acted, 1);

  document.elementFromPoint = () => ({});
  button.fire("pointerup", { pointerType: "touch", clientX: 99, clientY: 99 });
  assert.equal(acted, 1, "a finger that slid off is not a tap");
});
