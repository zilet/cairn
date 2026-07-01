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

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.names = new Set(String(owner.className || "").split(/\s+/).filter(Boolean));
  }

  add(...names) {
    for (const name of names) if (name) this.names.add(name);
    this.sync();
  }

  remove(...names) {
    for (const name of names) this.names.delete(name);
    this.sync();
  }

  contains(name) {
    return this.names.has(name);
  }

  toggle(name, on) {
    if (on) this.names.add(name);
    else this.names.delete(name);
    this.sync();
  }

  sync() {
    this.owner.className = [...this.names].join(" ");
  }
}

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.id = attrs.id || "";
    this.className = attrs.className || "";
    this.dataset = { ...(attrs.dataset || {}) };
    this.textContent = attrs.textContent || "";
    this.hidden = false;
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this.attributes = new Map();
    this.scrolls = [];
  }

  get isConnected() {
    return Boolean(this.parentElement);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  before(child) {
    if (!this.parentElement) return;
    child.parentElement = this.parentElement;
    const index = this.parentElement.children.indexOf(this);
    this.parentElement.children.splice(index < 0 ? this.parentElement.children.length : index, 0, child);
  }

  after(child) {
    if (!this.parentElement) return;
    child.parentElement = this.parentElement;
    const index = this.parentElement.children.indexOf(this);
    this.parentElement.children.splice(index < 0 ? this.parentElement.children.length : index + 1, 0, child);
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  click() {
    for (const handler of this.listeners.get("click") || []) handler({ target: this, currentTarget: this });
  }

  scrollIntoView(options) {
    this.scrolls.push(options);
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (selector === "[data-agentoffx]") return Object.hasOwn(this.dataset, "agentoffx");
    if (selector === "[data-override]") return Object.hasOwn(this.dataset, "override");
    if (selector === "[data-redirect]") return Object.hasOwn(this.dataset, "redirect");
    if (selector === "[data-steerreset]") return Object.hasOwn(this.dataset, "steerreset");
    if (selector === "[data-briefwhy]") return Object.hasOwn(this.dataset, "briefwhy");
    return false;
  }

  querySelector(selector) {
    if (this.matches(selector)) return this;
    for (const child of this.children) {
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    if (this.matches(selector)) out.push(this);
    for (const child of this.children) out.push(...child.querySelectorAll(selector));
    return out;
  }
}

function loadController() {
  const apiCalls = [];
  const invalidations = [];
  const renders = [];
  const transitions = [];
  const runOps = [];
  const countUps = [];
  const collapses = [];
  const tabs = [];
  const trainingProvenance = [];
  const reveals = [];
  const asks = [];
  let composerCount = 0;
  const rootEl = new FakeElement("section");
  const context = {
    Array,
    Object,
    Promise,
    String,
    URLSearchParams,
    HTMLElement: FakeElement,
    HTMLButtonElement: FakeElement,
    window: null,
    globalThis: null,
    document: {
      createElement: () => new FakeElement("div"),
    },
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    CairnTodayBrief: {
      provisionalRead: () => ({ kind: "train", headline: "Today", why: "", focus: null, est_minutes: null, signals: {}, source: "deterministic", _provisional: true }),
      briefHtml: (read, opts) => `<section class="brief">${read?.headline || "Today"}:${opts.activeOverride || ""}</section>`,
      focusBarHtml: (_read, day, opts) => `<div>${day?.name || ""}:${opts.exDone}/${opts.exTotal}:${opts.isToday ? "today" : "past"}</div>`,
      signalsText: () => "signals",
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-override-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-actions-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-controller.js"), "utf8"), context);

  const deps = {
    root: rootEl,
    state: {
      tab: "today",
      logDate: "2026-07-01",
      brief: null,
      _briefInflight: null,
      _briefMorph: false,
      focus: null,
      plan: [{ day_number: 1, name: "Day 1", items: [{ exercise: "Squat" }] }],
    },
    api: async (path) => {
      apiCalls.push(path);
      if (path.includes("fallback")) throw new Error("offline");
      return { kind: "easy", headline: "Easy day", why: "", focus: "walk", est_minutes: 20, signals: {}, override: "rough night" };
    },
    invalidate: (key) => invalidations.push(key),
    renderToday: (opts) => {
      renders.push(opts || null);
      return null;
    },
    withViewTransition: async (fn) => {
      transitions.push(true);
      return fn();
    },
    runOp: async (kind, body, options) => {
      runOps.push({ kind, body, options });
      return null;
    },
    runCountUps: (node) => countUps.push(node),
    reducedMotion: () => true,
    collapseEl: (el, done) => {
      collapses.push(el);
      if (done) done();
    },
    activateTab: (tab) => tabs.push(tab),
    toast: () => {},
    localISO: () => "2026-07-01",
    escapeHtml: (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    loadTrainingProvenance: (isToday) => trainingProvenance.push(isToday),
    revealPlanThen: (after, opts) => {
      reveals.push(opts || null);
      return after();
    },
    revealSessionComposer: () => { composerCount += 1; },
    askForSession: (opts) => asks.push(opts || null),
  };
  return {
    controller: context.CairnTodayBriefController,
    rootEl,
    deps,
    apiCalls,
    invalidations,
    renders,
    transitions,
    runOps,
    countUps,
    collapses,
    tabs,
    trainingProvenance,
    reveals,
    asks,
    get composerCount() { return composerCount; },
  };
}

test("Today Brief controller fetches, caches, and falls back without blocking the screen", async () => {
  const harness = loadController();

  const read = await harness.controller.loadBrief("2026-07-01", "", harness.deps);
  const cached = await harness.controller.loadBrief("2026-07-01", "rough night", harness.deps);

  assert.equal(read.headline, "Easy day");
  assert.equal(cached, read);
  assert.deepEqual(harness.apiCalls, ["/today-read?date=2026-07-01&agent=auto"]);
  assert.deepEqual(plain(harness.deps.state.brief), {
    date: "2026-07-01",
    override: "rough night",
    read: plain(read),
  });

  const fallback = await harness.controller.loadBrief("fallback", "", harness.deps);
  assert.equal(fallback._provisional, true);
  assert.equal(fallback.kind, "train");
});

test("Today Brief controller owns focus state decisions", () => {
  const harness = loadController();

  assert.equal(harness.controller.focusEngaged("2026-07-01", { showPlan: false, hasLoggedSets: true, isToday: true }, harness.deps), false);
  assert.equal(harness.controller.focusEngaged("2026-07-01", { showPlan: true, hasLoggedSets: true, isToday: true }, harness.deps), true);

  harness.controller.setFocus("2026-07-01", false, harness.deps);
  assert.equal(harness.controller.focusEngaged("2026-07-01", { showPlan: true, hasLoggedSets: true, isToday: true }, harness.deps), false);
  assert.equal(harness.controller.focusBarHtml({ kind: "train", headline: "Lift" }, { name: "Day A" }, { exDone: 1, exTotal: 3, isToday: true }), "<div>Day A:1/3:today</div>");
});

test("Today Brief controller preserves redirect wiring and override reconnect behavior", () => {
  const harness = loadController();
  const brief = harness.rootEl.appendChild(new FakeElement("section", { className: "brief" }));
  const steer = brief.appendChild(new FakeElement("div", { className: "brief-steer" }));
  const chip = steer.appendChild(new FakeElement("button", { className: "brief-steer-opt", dataset: { override: "short on time" }, textContent: "Short" }));
  const ask = brief.appendChild(new FakeElement("button", { dataset: { redirect: "ask-session" } }));
  const start = brief.appendChild(new FakeElement("button", { dataset: { redirect: "start-session" } }));
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));

  harness.controller.wireBrief({ kind: "train", headline: "Train", focus: "upper", signals: {} }, { isToday: true }, harness.deps);
  ask.click();
  start.click();
  chip.click();

  assert.equal(harness.composerCount, 1);
  assert.deepEqual(harness.reveals, [null]);
  assert.deepEqual(plain(surface.scrolls), [{ behavior: "auto", block: "start" }]);
  assert.equal(harness.runOps[0].kind, "day_read_override");
  assert.deepEqual(plain(harness.runOps[0].body), { date: "2026-07-01", override: "short on time", agent: "auto" });
  assert.equal(brief.attributes.get("aria-busy"), "true");

  const handlers = harness.controller.reconnectDayReadOverride({ input: { override: "short on time" } }, harness.deps);
  handlers.onDone({ kind: "train", headline: "Short lift", why: "", focus: "push", signals: {} });

  assert.equal(harness.deps.state.brief.read.headline, "Short lift");
  assert.equal(harness.transitions.length, 1);
  assert.equal(harness.asks[0].minutes, 30);
});
