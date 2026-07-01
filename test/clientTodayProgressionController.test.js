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
  constructor(owner, names = owner.className) {
    this.owner = owner;
    this.names = new Set(String(names || "").split(/\s+/).filter(Boolean));
  }

  contains(name) {
    return this.names.has(name);
  }

  add(...names) {
    for (const name of names) this.names.add(name);
    this.owner.className = [...this.names].join(" ");
  }
}

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.className = attrs.className || "";
    this.dataset = { ...(attrs.dataset || {}) };
    this.textContent = attrs.textContent || "";
    this.children = [];
    this.parentElement = null;
    this.classList = new FakeClassList(this);
    this.removed = false;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, ref) {
    child.parentElement = this;
    const index = this.children.indexOf(ref);
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  replaceWith(fresh) {
    if (!this.parentElement || !fresh) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) {
      fresh.parentElement = this.parentElement;
      this.parentElement.children[index] = fresh;
      this.parentElement = null;
    }
  }

  remove() {
    this.removed = true;
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  matches(selector) {
    if (selector === ".ex[data-card]") return this.classList.contains("ex") && this.dataset.card != null;
    if (selector === ".ex-rx") return this.classList.contains("ex-rx");
    if (selector === ".rx-banner") return this.classList.contains("rx-banner");
    if (selector === ".rx-banner-h") return this.classList.contains("rx-banner-h");
    if (selector === "[data-logged]") return Object.hasOwn(this.dataset, "logged");
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

class FakeTemplate {
  constructor() {
    this.content = { firstChild: null };
  }

  set innerHTML(value) {
    const text = String(value || "");
    const className = text.includes("ex-rx") ? "ex-rx" : "";
    this.content.firstChild = new FakeElement("div", { className, textContent: text.replace(/<[^>]+>/g, "") });
  }
}

function loadController() {
  const timeouts = [];
  const invalidations = [];
  const requests = [];
  let adjustmentLoads = 0;
  const context = {
    Object,
    Promise,
    String,
    console,
    window: null,
    globalThis: null,
    document: {
      createElement: (tag) => tag === "template" ? new FakeTemplate() : new FakeElement(tag),
    },
    setTimeout: (fn, delay) => {
      const token = { fn, delay };
      timeouts.push(token);
      return token;
    },
    clearTimeout: (token) => {
      token.cleared = true;
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-progression-controller.js"), "utf8"), context);

  const rootEl = new FakeElement("section");
  const squat = rootEl.appendChild(new FakeElement("article", { className: "ex", dataset: { card: "Squat" } }));
  const squatLogged = squat.appendChild(new FakeElement("div", { dataset: { logged: "" } }));
  const bench = rootEl.appendChild(new FakeElement("article", { className: "ex ex-complete", dataset: { card: "Bench" } }));
  const benchRx = bench.appendChild(new FakeElement("div", { className: "ex-rx", textContent: "old rx" }));
  const banner = rootEl.appendChild(new FakeElement("aside", { className: "rx-banner" }));
  const bannerHeading = banner.appendChild(new FakeElement("div", { className: "rx-banner-h", textContent: "old heading" }));
  const deps = {
    state: { tab: "today", day: 2, logDate: "2026-06-30" },
    root: rootEl,
    cachedApi: async (path, options) => {
      requests.push({ path, options });
      return [
        { exercise: "Squat", action: "overload" },
        { exercise: "Bench", action: "hold" },
      ];
    },
    invalidate: (key) => invalidations.push(key),
    exRxLineHtml: (rx) => rx ? `<div class="ex-rx">rx ${rx.exercise}</div>` : "",
    moveCount: () => 1,
    loadProgramAdjustmentsBanner: () => { adjustmentLoads += 1; },
  };
  return {
    controller: context.CairnTodayProgressionController,
    deps,
    requests,
    invalidations,
    timeouts,
    squat,
    squatLogged,
    benchRx,
    bannerHeading,
    get adjustmentLoads() { return adjustmentLoads; },
  };
}

test("Today progression controller refreshes card prescription lines in place", async () => {
  const harness = loadController();

  await harness.controller.refreshAdaptedRx(harness.deps);

  assert.deepEqual(plain(harness.requests), [{
    path: "/program/progression?day=2",
    options: { key: "program:progression:2", freshFor: 15000 },
  }]);
  assert.equal(harness.squat.children[0].className, "ex-rx");
  assert.equal(harness.squat.children[1], harness.squatLogged);
  assert.equal(harness.benchRx.removed, true);
  assert.equal(harness.bannerHeading.textContent, "One lift has a new target from what you logged");
  assert.equal(harness.adjustmentLoads, 1);
});

test("Today progression controller schedules refresh and invalidates scoped cache", () => {
  const harness = loadController();

  harness.controller.scheduleRxRefresh(harness.deps);
  harness.controller.invalidateTodayProgression(harness.deps);

  assert.equal(harness.timeouts.length, 1);
  assert.equal(harness.timeouts[0].delay, 600);
  assert.deepEqual(harness.invalidations, ["program:progression:2"]);
});
