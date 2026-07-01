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
    this.dataset = {};
    this.listeners = new Map();
    this.selectors = new Map();
    this.allSelectors = new Map();
    this.removed = false;
    this.focused = false;
    this.disabled = false;
    this.value = "";
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

  click() {
    this.listeners.get("click")?.({ target: this, currentTarget: this });
  }

  querySelector(selector) {
    return this.selectors.get(selector) || null;
  }

  querySelectorAll(selector) {
    return this.allSelectors.get(selector) || [];
  }

  remove() {
    this.removed = true;
  }

  focus() {
    this.focused = true;
  }
}

class FakeForm extends FakeElement {
  constructor() {
    super("bpSheetForm", "form");
  }

  submit() {
    return this.listeners.get("submit")?.({ preventDefault() {}, currentTarget: this });
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.listeners = new Map();
    this.body = {
      appended: [],
      appendChild: (el) => {
        this.body.appended.push(el);
        this.elements.set("#bpSheetOv", el);
        this.installBpOverlay(el);
      },
    };
  }

  createElement(tag) {
    return new FakeElement("", tag);
  }

  getElementById(id) {
    return this.elements.get(`#${id}`) || null;
  }

  querySelector(selector) {
    return this.elements.get(selector) || null;
  }

  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }

  removeEventListener(type, fn) {
    if (this.listeners.get(type) === fn) this.listeners.delete(type);
  }

  installBpOverlay(overlay) {
    const form = new FakeForm();
    const close = new FakeElement("", "button");
    const cancel = new FakeElement("", "button");
    const submit = new FakeElement("", "button");
    const fields = {
      "#bpSys": "118",
      "#bpDia": "76",
      "#bpPulse": "58",
      "#bpAt": "2026-07-01T07:30",
      "#bpPosition": "Seated",
      "#bpNote": "After coffee",
    };
    for (const [selector, value] of Object.entries(fields)) {
      const input = new FakeElement(selector.slice(1), "input");
      input.value = value;
      this.elements.set(selector, input);
    }
    form.selectors.set("button[type='submit']", submit);
    overlay.selectors.set("#bpSheetForm", form);
    overlay.selectors.set(".bpsheet-x", close);
    overlay.selectors.set("[data-close]", cancel);
    this.elements.set("#bpSheetForm", form);
    this.elements.set(".bpsheet-x", close);
    this.elements.set("[data-close]", cancel);
    this.elements.set("button[type='submit']", submit);
  }
}

function loadController(overrides = {}) {
  const renderCalls = [];
  const context = {
    console,
    Date,
    JSON,
    Number,
    Object,
    Promise,
    String,
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    CairnHealthStanding: {
      localDateTimeInputValue: () => "2026-07-01T07:00",
      renderHealthStandingHtml: (data, options) => {
        renderCalls.push([data, options]);
        return `<section class="standing">ref:${options.referenceAge}</section>`;
      },
    },
    ...overrides,
  };
  context.globalThis = context;
  context.window = context;
  context.HTMLFormElement = FakeForm;
  vm.runInNewContext(readFileSync(join(root, "public/js/health-standing-controller.js"), "utf8"), context);
  return { controller: context.CairnHealthStandingController, renderCalls };
}

function depsFor(root, options = {}) {
  const apiCalls = [];
  const toasts = [];
  const invalidated = [];
  const activated = [];
  const dexaSlots = [];
  const deps = {
    root,
    document: options.document || new FakeDocument(),
    state: options.state || { healthStandingRef: 40 },
    api: options.api || ((path) => {
      apiCalls.push(path);
      return Promise.resolve({ ok: true });
    }),
    swrInvalidate: (key) => invalidated.push(key),
    toast: (msg) => toasts.push(msg),
    activateTab: (tab) => activated.push(tab),
    pollToken: () => options.pollToken ?? 7,
    select: (selector) => deps.document.querySelector(selector),
    escapeAttr: (value) => String(value).replace(/"/g, "&quot;"),
    loadDexaTargeting: (slot) => {
      dexaSlots.push(slot);
      return Promise.resolve();
    },
  };
  return { deps, apiCalls, toasts, invalidated, activated, dexaSlots };
}

test("health standing controller paints the review and preserves the Health Read jump", async () => {
  const content = new FakeElement("hContent");
  const standing = new FakeElement("hStanding");
  const jump = new FakeElement("hStandingToRead", "button");
  const rootEl = new FakeElement("root");
  rootEl.selectors.set("#hContent", content);
  rootEl.selectors.set("#hStanding", standing);
  rootEl.selectors.set("#hStandingToRead", jump);
  const { controller } = loadController();
  const { deps, apiCalls, activated } = depsFor(rootEl);

  controller.paintReview(deps);
  await Promise.resolve();

  assert.match(content.innerHTML, /hStanding/);
  assert.match(content.innerHTML, /The full health read/);
  assert.equal(apiCalls[0], "/health/standing?reference_age=40");

  jump.click();
  assert.equal(deps.state.meSeg, "health");
  assert.equal(deps.state.healthSeg, "read");
  assert.equal(deps.state.healthSegPicked, true);
  assert.deepEqual(activated, ["me"]);
});

test("health standing controller wires reference age, marker lever, BP open, and DEXA slot", () => {
  const rootEl = new FakeElement("root");
  const standing = new FakeElement("hStanding");
  const ref = new FakeElement("", "button");
  ref.dataset.refage = "30";
  const lever = new FakeElement("", "button");
  const bp = new FakeElement("bpLogOpen", "button");
  const conductor = new FakeElement("cfocus");
  const healthLever = new FakeElement("", "div");
  let healthLeverRemoved = false;
  healthLever.remove = () => { healthLeverRemoved = true; };
  standing.allSelectors.set("[data-refage]", [ref]);
  standing.selectors.set("[data-lever-go]", lever);
  standing.selectors.set(".hstand-lever", healthLever);
  rootEl.selectors.set("#hStanding", standing);
  rootEl.selectors.set("#bpLogOpen", bp);
  rootEl.selectors.set("#cfocusStandingSlot .cfocus", conductor);
  const { controller } = loadController();
  const { deps, apiCalls, activated, dexaSlots } = depsFor(rootEl);

  controller.render({ hero: { headline: "Standing" } }, deps);

  assert.equal(healthLeverRemoved, true);
  assert.deepEqual(dexaSlots, ["hDexaSlot"]);
  ref.click();
  assert.equal(deps.state.healthStandingRef, 30);
  assert.equal(apiCalls[0], "/health/standing?reference_age=30");
  lever.click();
  assert.equal(deps.state.healthSeg, "markers");
  assert.deepEqual(activated, ["me"]);
  bp.click();
  assert.ok(deps.document.getElementById("bpSheetOv"));
});

test("health standing controller posts BP readings and refreshes standing/marker state", async () => {
  const doc = new FakeDocument();
  const rootEl = new FakeElement("root");
  const standing = new FakeElement("hStanding");
  rootEl.selectors.set("#hStanding", standing);
  const apiCalls = [];
  const api = (path, options) => {
    apiCalls.push([path, options || null]);
    return Promise.resolve({ ok: true });
  };
  const { controller } = loadController();
  const { deps, toasts, invalidated } = depsFor(rootEl, { document: doc, api, state: { healthStandingRef: 50 } });

  controller.openBpSheet(deps);
  const form = doc.querySelector("#bpSheetForm");
  await form.submit();

  assert.equal(apiCalls[0][0], "/blood-pressure");
  assert.deepEqual(JSON.parse(apiCalls[0][1].body), {
    systolic: "118",
    diastolic: "76",
    pulse: "58",
    measured_at: "2026-07-01T07:30",
    position: "Seated",
    note: "After coffee",
    source: "manual",
  });
  assert.equal(apiCalls[1][0], "/health/standing?reference_age=50");
  assert.deepEqual(toasts, ["BP logged"]);
  assert.deepEqual(invalidated, ["markers:"]);
  assert.equal(doc.getElementById("bpSheetOv").removed, true);
});
