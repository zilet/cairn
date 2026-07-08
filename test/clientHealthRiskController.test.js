import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeElement {
  constructor(id = "", tag = "div") {
    this.id = id;
    this.tag = tag;
    this.listeners = new Map();
    this.selectors = new Map();
    this.html = "";
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

  click() {
    this.listeners.get("click")?.({ target: this, currentTarget: this });
  }

  querySelector(selector) {
    return this.selectors.get(selector) || null;
  }
}

function loadController(overrides = {}) {
  const renderCalls = [];
  const context = {
    console,
    Object,
    Promise,
    String,
    CairnHealthRisk: {
      renderCardiovascularRiskHtml: (data) => {
        renderCalls.push(data);
        // installs a fake sharpen affordance so the controller's click wiring is exercised
        return `<section class="hrisk">rendered:${data ? "ok" : "null"}<button data-risk-sharpen>sharpen</button></section>`;
      },
    },
    ...overrides,
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/health-risk-controller.js"), "utf8"), context);
  return { controller: context.CairnHealthRiskController, renderCalls };
}

function depsFor(root, options = {}) {
  const apiCalls = [];
  const activated = [];
  const state = options.state || {};
  const deps = {
    root,
    state,
    api:
      options.api ||
      ((path) => {
        apiCalls.push(path);
        return Promise.resolve(options.response ?? { ok: true });
      }),
    activateTab: (tab) => activated.push(tab),
    pollToken: () => options.pollToken ?? 1,
    select: (selector) => root.querySelector(selector),
    ...(options.onSharpen ? { onSharpen: options.onSharpen } : {}),
  };
  return { deps, apiCalls, activated, state };
}

test("health risk controller fetches /health/risk and paints the card into #hRisk", async () => {
  const rootEl = new FakeElement("root");
  const riskSlot = new FakeElement("hRisk");
  rootEl.selectors.set("#hRisk", riskSlot);
  const { controller, renderCalls } = loadController();
  const { deps, apiCalls } = depsFor(rootEl, { response: { model_status: { prevent: "computed" } } });

  controller.load(deps, 1);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(apiCalls, ["/health/risk"]);
  assert.equal(renderCalls.length, 1);
  assert.match(riskSlot.innerHTML, /rendered:ok/);
});

test("health risk controller drops a stale response when pollToken has advanced", async () => {
  const rootEl = new FakeElement("root");
  const riskSlot = new FakeElement("hRisk");
  rootEl.selectors.set("#hRisk", riskSlot);
  const { controller, renderCalls } = loadController();
  const { deps } = depsFor(rootEl, { pollToken: 2 }); // load() is called with the stale token 1

  controller.load(deps, 1);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(renderCalls.length, 0);
  assert.equal(riskSlot.innerHTML, "");
});

test("health risk controller degrades to the calm empty state on fetch failure", async () => {
  const rootEl = new FakeElement("root");
  const riskSlot = new FakeElement("hRisk");
  rootEl.selectors.set("#hRisk", riskSlot);
  const { controller, renderCalls } = loadController();
  const { deps } = depsFor(rootEl, { api: () => Promise.reject(new Error("network down")) });

  controller.load(deps, 1);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(renderCalls.length, 1);
  assert.equal(renderCalls[0], null);
  assert.match(riskSlot.innerHTML, /rendered:null/);
});

test("health risk controller wires the provisional-read Profile nudge", () => {
  const rootEl = new FakeElement("root");
  const riskSlot = new FakeElement("hRisk");
  const sharpen = new FakeElement("", "button");
  riskSlot.selectors.set("[data-risk-sharpen]", sharpen);
  rootEl.selectors.set("#hRisk", riskSlot);
  const { controller } = loadController();
  const { deps, activated, state } = depsFor(rootEl);

  controller.render({ model_status: { prevent: "computed_provisional" } }, deps);
  sharpen.click();

  assert.equal(state.meSeg, "profile");
  assert.deepEqual(activated, ["me"]);
});

test("health risk controller prefers an in-place onSharpen handler over the Profile jump", () => {
  const rootEl = new FakeElement("root");
  const riskSlot = new FakeElement("hRisk");
  const sharpen = new FakeElement("", "button");
  riskSlot.selectors.set("[data-risk-sharpen]", sharpen);
  rootEl.selectors.set("#hRisk", riskSlot);
  const { controller } = loadController();
  let sharpened = 0;
  const { deps, activated, state } = depsFor(rootEl, { onSharpen: () => { sharpened += 1; } });

  controller.render({ model_status: { prevent: "computed_provisional" } }, deps);
  sharpen.click();

  assert.equal(sharpened, 1);
  assert.equal(state.meSeg, undefined); // did NOT fall back to the tab jump
  assert.deepEqual(activated, []);
});
