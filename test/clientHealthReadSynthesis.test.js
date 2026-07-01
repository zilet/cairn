import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.dataset = {};
    this.listeners = new Map();
    this.selectors = new Map();
    this.allSelectors = new Map();
    this.children = [];
    this.classList = { toggle() {} };
    this.className = "";
    this.html = "";
    this.isConnected = true;
  }

  set innerHTML(value) {
    this.html = value;
  }

  get innerHTML() {
    return this.html;
  }

  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }

  querySelector(selector) {
    return this.selectors.get(selector) || null;
  }

  querySelectorAll(selector) {
    return this.allSelectors.get(selector) || [];
  }

  appendChild(el) {
    this.children.push(el);
  }
}

function escHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadSynthesis(overrides = {}) {
  const context = {
    console,
    Date,
    JSON,
    Number,
    Object,
    Promise,
    String,
    document: {
      createElement: (tag) => new FakeElement(tag),
    },
    ...overrides,
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/health-read-synthesis-client.js"), "utf8"), context);
  return context.CairnHealthReadSynthesis;
}

function depsFor(options = {}) {
  const rootEl = new FakeElement("root");
  const synthesis = new FakeElement("hSynthesis");
  rootEl.selectors.set("#hSynthesis", synthesis);
  const apiCalls = [];
  const runOps = [];
  const invalidated = [];
  const toasts = [];
  const deps = {
    root: rootEl,
    state: { tab: "me", meSeg: "health", healthSeg: "read", pendingHealthScroll: null },
    api: options.api || ((path) => {
      apiCalls.push(path);
      return Promise.resolve({});
    }),
    cachedApi: () => Promise.resolve({}),
    peekCached: () => null,
    markRefreshing() {},
    swrInvalidate: (key) => invalidated.push(key),
    runOp: (kind, body, handlers) => {
      runOps.push({ kind, body, handlers });
      return Promise.resolve({});
    },
    toast: (msg) => toasts.push(msg),
    pollToken: () => options.pollToken ?? 7,
    select: (selector) => rootEl.querySelector(selector),
    escapeAttr: escHtml,
    escapeHtml: escHtml,
    relTime: () => "moments ago",
    stagger: (i) => `--i:${i ?? 0}`,
    reducedMotion: () => true,
    switchHealthSeg() {},
    isHealthReviewRunning: () => false,
    loadHealthPicture: () => Promise.resolve(),
    paintHealthPicture() {},
    setReadSpy() {},
    teardownReadSpy() {},
  };
  return { deps, synthesis, apiCalls, runOps, invalidated, toasts };
}

test("health read synthesis renders the connected read and escapes generated content", () => {
  const helper = loadSynthesis();
  const { deps, synthesis } = depsFor();

  helper.render({
    stale: true,
    synthesis: {
      headline: "ApoB <focus>",
      story: "Keep it calm & connected",
      generated_at: "2026-07-01T10:00:00Z",
      priorities: [
        { label: "Lipids <now>", the_move: "Add fiber & walk", recheck: "Retest <8w>" },
        { label: "", the_move: "" },
      ],
      one_change: "Make breakfast boring <steady>",
    },
  }, deps, 7);

  assert.match(synthesis.innerHTML, /Your health — one picture/);
  assert.match(synthesis.innerHTML, /ApoB &lt;focus&gt;/);
  assert.match(synthesis.innerHTML, /Keep it calm &amp; connected/);
  assert.match(synthesis.innerHTML, /Lipids &lt;now&gt;/);
  assert.match(synthesis.innerHTML, /Add fiber &amp; walk/);
  assert.match(synthesis.innerHTML, /Retest &lt;8w&gt;/);
  assert.match(synthesis.innerHTML, /Make breakfast boring &lt;steady&gt;/);
  assert.match(synthesis.innerHTML, /New results — refresh/);
  assert.doesNotMatch(synthesis.innerHTML, /<focus>|<now>|<8w>|<steady>/);
});

test("health read synthesis load keeps token freshness", async () => {
  const helper = loadSynthesis();
  const { deps, synthesis, apiCalls } = depsFor({
    api: (path) => {
      apiCalls.push(path);
      return Promise.resolve({ synthesis: { headline: "Fresh read" } });
    },
  });

  helper.load(deps, 7);
  await Promise.resolve();

  assert.deepEqual(apiCalls, ["/health/synthesis"]);
  assert.match(synthesis.innerHTML, /Fresh read/);

  helper.render({ synthesis: { headline: "Stale read" } }, { ...deps, pollToken: () => 8 }, 7);
  assert.doesNotMatch(synthesis.innerHTML, /Stale read/);
});

test("health read synthesis trigger preserves job contract and refresh fallback", () => {
  const helper = loadSynthesis();
  const { deps, synthesis, runOps, invalidated, toasts } = depsFor();
  const card = new FakeElement("card");
  synthesis.selectors.set(".hsyn", card);

  helper.trigger(deps);

  assert.equal(card.children[0].className, "job-cap lbl hsyn-cap");
  assert.equal(runOps.length, 1);
  assert.equal(runOps[0].kind, "health_synthesis");
  assert.equal(runOps[0].handlers.path, "/health/synthesis");
  assert.equal(runOps[0].handlers.anchor, "#hSynthesis .hsyn");
  assert.deepEqual(Array.from(runOps[0].handlers.caption), [
    "reading your labs",
    "connecting it to your training & recovery",
    "finding what matters most",
    "writing your picture",
  ]);

  runOps[0].handlers.render({ synthesis: { headline: "Updated read" } });
  assert.match(synthesis.innerHTML, /Updated read/);
  assert.deepEqual(invalidated, ["plan:coach"]);

  runOps[0].handlers.onFail();
  assert.deepEqual(toasts, ["Couldn't read the picture right now — try again in a bit."]);
});

test("health read controller keeps synthesis methods bridged through the public API", () => {
  const calls = [];
  const context = {
    console,
    Array,
    Date,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    document: { getElementById: () => null },
    window: {},
    CairnHealthReadSynthesis: {
      load: (...args) => calls.push(["load", args]),
      render: (...args) => calls.push(["render", args]),
      trigger: (...args) => calls.push(["trigger", args]),
    },
    CairnHealthDirectiveLoader: { load: () => Promise.resolve() },
    CairnHealthRead: {
      recoveryHtml: () => "",
      recoveryNoDataHtml: () => "",
      priorityMarkersSectionHtml: () => "",
    },
    setTimeout: () => 0,
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/health-read-controller.js"), "utf8"), context);
  const deps = {};

  context.CairnHealthReadController.loadSynthesis(deps, 4);
  context.CairnHealthReadController.renderSynthesis({ ok: true }, deps, 4);
  context.CairnHealthReadController.triggerSynthesis(deps);

  assert.equal(context.CairnHealthReadController.loadSynthesis, context.CairnHealthReadSynthesis.load);
  assert.equal(context.CairnHealthReadController.renderSynthesis, context.CairnHealthReadSynthesis.render);
  assert.equal(context.CairnHealthReadController.triggerSynthesis, context.CairnHealthReadSynthesis.trigger);
  assert.deepEqual(calls.map(([name]) => name), ["load", "render", "trigger"]);
});
