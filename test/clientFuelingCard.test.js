import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

// The fueling follow-up card is an AGENDA rail card: the loader hydrates #fuelingSlot with
// the actual 1-tap interaction inline (three options that POST to /nutrition/fueling-feedback
// and melt into a quiet acknowledgement — never a link to another screen). This drives the
// compiled loader against a minimal tailored DOM (the established client-test pattern), so the
// acceptance behavior is a real regression guard, not a code read.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeButton {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.disabled = false;
    this._handlers = {};
  }
  addEventListener(type, fn) {
    (this._handlers[type] ||= []).push(fn);
  }
  async click() {
    for (const fn of this._handlers.click || []) await fn();
  }
}

// A slot that recognizes exactly the markup the loader emits: three .fueling-opt buttons
// (data-energy 1/2/3) and the #fuelingSkip control. Raw HTML is kept for text assertions.
class FakeSlot {
  constructor() {
    this._html = "";
    this.isConnected = true;
    this._opts = [];
    this._skip = null;
  }
  set innerHTML(value) {
    this._html = String(value || "");
    this._opts = this._html.includes("fueling-opt")
      ? [1, 2, 3].map((energy) => new FakeButton({ energy: String(energy) }))
      : [];
    this._skip = this._html.includes('id="fuelingSkip"') ? new FakeButton() : null;
  }
  get innerHTML() {
    return this._html;
  }
  querySelector(sel) {
    return sel === "#fuelingSkip" ? this._skip : null;
  }
  querySelectorAll(sel) {
    return sel === ".fueling-opt" ? this._opts : [];
  }
}

function loadRailLoaders() {
  const context = { Object, Number, String, Array, JSON, Boolean, Promise, encodeURIComponent, console };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-rail-loaders-client.js"), "utf8"), context);
  return context.CairnTodayRailLoaders;
}

function makeDeps({ due }) {
  const slot = new FakeSlot();
  const calls = [];
  const toasts = [];
  const nav = { count: 0 };
  const deps = {
    root: { querySelector: (sel) => (sel === "#fuelingSlot" ? slot : null) },
    state: { tab: "today", logDate: "2026-07-13" },
    api: async (path, opts) => {
      calls.push({ path, opts });
      if (path === "/nutrition/fueling-followup") return { due, recent: [] };
      if (path === "/nutrition/fueling-feedback") return { date: "2026-07-13", energy: JSON.parse(opts.body).energy };
      return null;
    },
    activateTab: () => {
      nav.count += 1;
    },
    gotoChatWith: () => {
      nav.count += 1;
    },
    toast: (message) => toasts.push(message),
    escapeHtml: (value) => String(value ?? ""),
    invalidate: () => {},
    refreshToday: async () => {},
    runCountUps: () => {},
  };
  return { deps, slot, calls, toasts, nav };
}

test("the fueling card renders three inline options when due", async () => {
  const loaders = loadRailLoaders();
  const { deps, slot } = makeDeps({ due: true });
  await loaders.loadFuelingFollowup(deps);
  assert.match(slot.innerHTML, /How's fueling feeling\?/);
  assert.equal(slot.querySelectorAll(".fueling-opt").length, 3);
  assert.ok(slot.querySelector("#fuelingSkip"), "carries a skip control");
});

test("tapping an option posts the read inline and melts into a quiet acknowledgement", async () => {
  const loaders = loadRailLoaders();
  const { deps, slot, calls, nav } = makeDeps({ due: true });
  await loaders.loadFuelingFollowup(deps);
  await slot.querySelectorAll(".fueling-opt")[0].click(); // "Running low" = energy 1

  const post = calls.find((c) => c.path === "/nutrition/fueling-feedback");
  assert.ok(post, "posts to the fueling-feedback endpoint");
  assert.equal(post.opts.method, "POST");
  assert.deepEqual(JSON.parse(post.opts.body), { energy: 1 });
  assert.match(slot.innerHTML, /fueling-done/, "melts into the acknowledgement in place");
  assert.match(slot.innerHTML, /Noted/);
  assert.equal(nav.count, 0, "the interaction is fully inline — never a link to another screen");
});

test("the card renders nothing when not due", async () => {
  const loaders = loadRailLoaders();
  const { deps, slot } = makeDeps({ due: false });
  await loaders.loadFuelingFollowup(deps);
  assert.equal(slot.innerHTML, "", "answered/not-due → the slot stays empty");
});

test("the skip control hides the card without logging anything", async () => {
  const loaders = loadRailLoaders();
  const { deps, slot, calls } = makeDeps({ due: true });
  await loaders.loadFuelingFollowup(deps);
  await slot.querySelector("#fuelingSkip").click();
  assert.equal(slot.innerHTML, "", "the ✕ hides the card for this render");
  assert.equal(calls.filter((c) => c.path === "/nutrition/fueling-feedback").length, 0, "skip never posts");
});
