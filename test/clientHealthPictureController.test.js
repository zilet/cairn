import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.id = attrs.id || "";
    this.className = attrs.className || "";
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this._innerHTML = "";
  }

  get isConnected() {
    return !this.parentElement || this.parentElement.children.includes(this);
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    if (this._innerHTML.includes('id="hHeroShare"')) {
      this.appendChild(new FakeElement("button", { id: "hHeroShare" }));
    }
    if (this._innerHTML.includes('id="hRevBtn"')) {
      this.appendChild(new FakeElement("button", { id: "hRevBtn" }));
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  click() {
    for (const handler of this.listeners.get("click") || []) handler({ target: this, currentTarget: this });
  }

  matches(selector) {
    return selector.startsWith("#") && this.id === selector.slice(1);
  }

  querySelector(selector) {
    if (this.matches(selector)) return this;
    for (const child of this.children) {
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}

function loadController() {
  const context = {
    Date,
    Number,
    Object,
    Promise,
    String,
    globalThis: null,
    window: null,
    HTMLElement: FakeElement,
    localStorage: null,
    CairnHealthPicture: {
      parsedReview: (review) => (review && !review.error && review.parsed ? review.parsed : null),
      reviewBusyHtml: () => `<div class="hpic-busy">busy</div>`,
      healthHeroHtml: (err) => `<div class="hpic-hero">${err || ""}<button id="hHeroShare">share</button></div>`,
      buildPictureHtml: (err, count) => `<div class="hpic-build">${err || ""}<span>${count}</span><button id="hRevBtn">build</button></div>`,
      reviewHtml: (review, stale, err) => `<div class="hpic-review">${err || ""}<span>${review.parsed?.headline || ""}</span><span>${stale ? "stale" : "fresh"}</span><button id="hRevBtn">refresh</button></div>`,
    },
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/health-picture-controller.js"), "utf8"), context);
  return context.CairnHealthPictureController;
}

function makeDeps({ api, runOp, token = 1, storage, onHealthReadView } = {}) {
  const rootEl = new FakeElement("section");
  const slot = rootEl.appendChild(new FakeElement("div", { id: "hPicture" }));
  const calls = [];
  const state = {};
  const deps = {
    root: rootEl,
    state,
    api: api || (async () => null),
    runOp: runOp || (async () => undefined),
    toast: (message) => calls.push(["toast", message]),
    switchHealthSeg: (seg, opts) => calls.push(["switch", seg, opts || {}]),
    onHealthReadView: onHealthReadView || (() => true),
    pollToken: () => token,
    escapeHtml: (value) => String(value ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    storage: storage ?? null,
  };
  return { deps, rootEl, slot, calls, state };
}

test("Health Picture controller owns shared cache and persisted zero-doc default", () => {
  const controller = loadController();
  const storage = {
    values: new Map([["cairn:healthDocCount", "0"]]),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, value); },
  };

  assert.equal(controller.getHealthPictureCache(), null);
  assert.equal(controller.healthDocsKnownEmpty({ storage }), true);
  controller.setHealthPictureCache({ docCount: 2, newestDocAt: "2026-07-01T10:00:00Z" });
  assert.equal(controller.healthDocsKnownEmpty({ storage }), false);
  assert.deepEqual(controller.getHealthPictureCache(), { docCount: 2, newestDocAt: "2026-07-01T10:00:00Z" });
});

test("Health Picture controller paints hero, build, and stale review states", () => {
  const controller = loadController();
  const { deps, slot, calls } = makeDeps();

  controller.setHealthPictureCache(null);
  controller.paintHealthPicture(deps);
  assert.match(slot.innerHTML, /hpic-hero/);
  slot.querySelector("#hHeroShare").click();
  assert.deepEqual(plain(calls), [["switch", "records", { openPicker: true }]]);

  controller.setHealthPictureCache({ docCount: 3 });
  controller.paintHealthPicture(deps);
  assert.match(slot.innerHTML, /hpic-build/);
  assert.match(slot.innerHTML, /3/);

  controller.setHealthPictureCache({
    review: { created_at: "2026-07-01T09:00:00Z", parsed: { headline: "Ready" } },
    docCount: 3,
    newestDocAt: "2026-07-01T10:00:00Z",
  });
  controller.paintHealthPicture(deps);
  assert.match(slot.innerHTML, /hpic-review/);
  assert.match(slot.innerHTML, /Ready/);
  assert.match(slot.innerHTML, /stale/);
});

test("Health Picture controller loads review and docs with stale-token and storage guards", async () => {
  const controller = loadController();
  const stored = [];
  const storage = {
    getItem() { return null; },
    setItem(key, value) { stored.push([key, value]); },
  };
  const { deps, state } = makeDeps({
    storage,
    api: async () => ({ created_at: "2026-07-01T09:00:00Z", parsed: { headline: "Loaded" } }),
    token: 7,
  });

  await controller.loadHealthPicture(7, Promise.resolve([
    { created_at: "2026-07-01T10:00:00Z" },
    { created_at: "2026-07-01T08:00:00Z" },
  ]), deps);
  assert.deepEqual(plain(controller.getHealthPictureCache()), {
    review: { created_at: "2026-07-01T09:00:00Z", parsed: { headline: "Loaded" } },
    docCount: 2,
    newestDocAt: "2026-07-01T10:00:00Z",
  });
  assert.equal(state.healthReview.parsed.headline, "Loaded");
  assert.deepEqual(stored, [["cairn:healthDocCount", "2"]]);

  controller.setHealthPictureCache(null);
  await controller.loadHealthPicture(6, Promise.resolve([{ created_at: "2026-07-01T10:00:00Z" }]), deps);
  assert.equal(controller.getHealthPictureCache(), null);

  const failedDocs = makeDeps({ storage, api: async () => null, token: 1 });
  stored.length = 0;
  await controller.loadHealthPicture(1, Promise.reject(new Error("offline")), failedDocs.deps);
  assert.deepEqual(stored, [], "failed docs fetch must not persist a false zero count");
});

test("Health Picture controller runs the review as a durable runOp job and stores the result", async () => {
  // A4: the review is now a background agent job (runOp), not a blocking POST — under
  // default bg_ops the route returns {ok, job} and the result streams to completion.
  const controller = loadController();
  let runOpCalls = 0;
  let captured = null;
  const { deps, calls, state, slot } = makeDeps({
    runOp: async (kind, body, opts) => {
      runOpCalls += 1;
      assert.equal(kind, "health_review");
      assert.equal(Object.keys(body).length, 0);
      assert.equal(opts.path, "/health/review");
      captured = opts;
      return { id: "job-1" }; // a job handle — render/onFail fire later off the stream
    },
  });
  controller.setHealthPictureCache({ docCount: 1 });

  // A second run while one is in flight is a no-op (dedupe on the running flag).
  await Promise.all([controller.runHealthReview(deps), controller.runHealthReview(deps)]);
  assert.equal(runOpCalls, 1, "a second review while one is running is deduped");
  assert.equal(controller.isHealthReviewRunning(), true, "the review is marked running until the job resolves");
  assert.match(slot.innerHTML, /hpic-busy/, "the busy card is shown immediately");

  // The fail contract the runOp harness uses to route render vs onFail.
  assert.equal(captured.isFail({ ok: true, review: { parsed: {} } }), false);
  assert.equal(captured.isFail({ ok: false, error: "x" }), true);
  assert.equal(captured.isFail(null), true);

  // Simulate the job completing successfully (what runOp calls on a good result).
  captured.render({ ok: true, review: { created_at: "2026-07-01T10:00:00Z", parsed: { headline: "Done" } } });
  assert.equal(controller.isHealthReviewRunning(), false, "the running flag clears when the job finishes");
  assert.equal(state.healthReview.parsed.headline, "Done");
  assert.equal(controller.getHealthPictureCache().review.parsed.headline, "Done");
  assert.deepEqual(calls, [["toast", "Your picture is ready"]]);
  assert.match(slot.innerHTML, /Done/);
});

test("Health Picture controller surfaces a review failure in place", async () => {
  const controller = loadController();
  let captured = null;
  const { deps, slot } = makeDeps({
    runOp: async (_kind, _body, opts) => { captured = opts; return { id: "job-2" }; },
  });
  controller.setHealthPictureCache({ docCount: 2 });

  await controller.runHealthReview(deps);
  // The job fails (e.g. no agent) — runOp routes to onFail.
  captured.onFail({ ok: false, error: "no agent" });
  assert.equal(controller.isHealthReviewRunning(), false);
  assert.match(slot.innerHTML, /hpic-build/, "it repaints the picture with the docs it has");
  assert.match(slot.innerHTML, /didn&#x27;t finish|didn't finish/, "the failure reason is shown in place");
});

test("Health Picture controller reconnects to an in-flight review after reload", () => {
  const controller = loadController();
  const { deps, state, slot } = makeDeps();
  controller.setHealthPictureCache({ docCount: 1 });

  const handlers = controller.reconnectHealthReview(deps);
  assert.ok(handlers, "reconnect returns handlers when on the read view");
  assert.equal(controller.isHealthReviewRunning(), true, "reconnect marks the review running while reattached");
  assert.match(slot.innerHTML, /hpic-busy/);

  handlers.onDone({ ok: true, review: { created_at: "2026-07-02T10:00:00Z", parsed: { headline: "Reattached" } } });
  assert.equal(controller.isHealthReviewRunning(), false);
  assert.equal(state.healthReview.parsed.headline, "Reattached");
  assert.match(slot.innerHTML, /Reattached/);
});

test("Health Picture controller does not reconnect off the read view", () => {
  const controller = loadController();
  const { deps } = makeDeps({ onHealthReadView: () => false });
  assert.equal(controller.reconnectHealthReview(deps), null);
  assert.equal(controller.isHealthReviewRunning(), false);
});
