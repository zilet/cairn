import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeTimers, createHost, loadClientModule } from "./_dom.mjs";

// The week strip's slot reserves 125px (CSS `:empty:not([data-none])`) only while a paint
// is genuinely pending. Every way the paint can end without arriving must set data-none.

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a failed week read releases the reservation even with a held copy still in the slot", async () => {
  const win = loadClientModule(["html-utils", "ui-format", "ui-actions-client", "today-strip-client", "today-strip-controller"]);
  const host = createHost(win.document, { html: `<div data-held>held strip</div>` });
  win.CairnTodayStripController.mount(host, {
    date: "2026-10-02",
    peek: () => null,
    load: () => Promise.reject(new Error("offline")),
  });
  await flush();
  assert.equal(host.hasAttribute("data-none"), true);
});

test("the hold clearing an empty slot leaves it released, not reserved", () => {
  const timers = createFakeTimers();
  const win = loadClientModule("today-slot-hold", {
    globals: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  });
  class Obs {
    observe() {}
    disconnect() {}
  }
  win.MutationObserver = Obs;
  const root = createHost(win.document, { html: `<div id="todayStripSlot"></div>` });
  const slot = root.querySelector("#todayStripSlot");
  slot.innerHTML = `<div>held</div>`;
  const snapshot = win.CairnTodaySlotHold.capture(root);
  root.innerHTML = `<div id="todayStripSlot"></div>`;
  win.CairnTodaySlotHold.apply(root, snapshot);
  timers.tick(win.CairnTodaySlotHold.EXPIRE_MS + 1);
  const after = root.querySelector("#todayStripSlot");
  assert.equal(after.innerHTML, "");
  assert.equal(after.hasAttribute("data-none"), true);
});

function loadMount(withBundle, isCurrent = () => true) {
  const win = loadClientModule("today-ahead-mount", {
    globals: {
      withBundle,
      peekCached: () => null,
      cachedApi: async () => null,
      CairnTodayPathController: { mount() {} },
      CairnTodayAhead: { mount() {} },
    },
  });
  const view = createHost(win.document, { html: `<div class="today-main"><div id="todayStripSlot"></div></div>` });
  const rail = { state: {}, api() {}, activateTab() {}, gotoChatWith() {}, toast() {}, invalidate() {}, refreshToday() {} };
  win.CairnTodayAheadMount.mount(view, { date: "2026-10-02", read: null, agenda: Promise.resolve(null), isCurrent, rail });
  return view.querySelector("#todayStripSlot");
}

test("a bundle that fails to load releases the strip reservation", async () => {
  const slot = loadMount(() => Promise.reject(new Error("chunk")));
  await flush();
  assert.equal(slot.hasAttribute("data-none"), true);
});

test("a mount for a Today that has moved on releases it; a live one leaves it to the strip", async () => {
  const stale = loadMount((_n, fn) => fn(), () => false);
  assert.equal(stale.hasAttribute("data-none"), true);
  const live = loadMount((_n, fn) => fn());
  await flush();
  assert.equal(live.hasAttribute("data-none"), false);
});
