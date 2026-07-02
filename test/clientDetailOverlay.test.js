import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.style = {};
    this._innerHTML = "";
    this.className = "";
    this.dataset = {};
    this.attrs = {};
    this.focusCount = 0;
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }

  getAttribute(name) {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
  }

  focus() {
    this.focusCount += 1;
  }

  get isConnected() {
    return Boolean(this.parentElement);
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    if (this._innerHTML.includes("detail-bg")) {
      const bg = new FakeElement("div");
      bg.className = "detail-bg";
      bg.parentElement = this;
      bg._innerHTML = this._innerHTML.match(/<div class="detail-bg">([\s\S]*?)<\/div>/)?.[1] || "";
      this.children.push(bg);
    }
    if (this._innerHTML.includes("detail-x")) {
      const close = new FakeElement("button");
      close.className = "detail-x";
      close.parentElement = this;
      this.children.push(close);
    }
    const scrollMatch = this._innerHTML.match(/<div class="detail-scroll">([\s\S]*)<\/div>$/);
    if (scrollMatch) {
      const scroll = new FakeElement("div");
      scroll.className = "detail-scroll";
      scroll.parentElement = this;
      scroll.innerHTML = scrollMatch[1];
      this.children.push(scroll);
    }
    if (this._innerHTML.includes("detail-art")) {
      const art = new FakeElement("div");
      art.className = "detail-art";
      art.parentElement = this;
      const inner = new FakeElement("span");
      inner.parentElement = art;
      art.children.push(inner);
      this.children.push(art);
    }
    if (this._innerHTML.includes("data-close")) {
      const button = new FakeElement("button");
      button.dataset.close = "";
      button.parentElement = this;
      this.children.push(button);
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

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler({ target: this, currentTarget: this, preventDefault() {}, ...event });
    }
  }

  click() {
    this.dispatch("click");
  }

  matches(selector) {
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector === "[data-close]") return Object.hasOwn(this.dataset, "close");
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

class FakeDocument {
  constructor() {
    this.body = new FakeElement("body");
    this.activeElement = null;
    this.listeners = new Map();
    this.transitions = 0;
    this.startViewTransition = (fn) => {
      this.transitions += 1;
      fn();
      return { finished: Promise.resolve() };
    };
  }

  createElement(tag) {
    return new FakeElement(tag);
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  keydown(key) {
    for (const handler of this.listeners.get("keydown") || []) handler({ key });
  }
}

function loadOverlay({ reduced = false } = {}) {
  const document = new FakeDocument();
  let closeMealSheetCalls = 0;
  const context = {
    document,
    window: null,
    globalThis: null,
    HTMLElement: FakeElement,
    Element: FakeElement,
    Map,
    Math,
    Promise,
    String,
    setTimeout: (fn) => fn(),
    escAttr(value) {
      return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    },
    reducedMotion: () => reduced,
    withViewTransition(fn) {
      document.transitions += 1;
      fn();
      return { finished: Promise.resolve() };
    },
    closeMealSheet() {
      closeMealSheetCalls += 1;
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/detail-overlay-client.js"), "utf8"), context);
  return { context, document, get closeMealSheetCalls() { return closeMealSheetCalls; } };
}

test("detail overlay mounts, escapes photo source, and closes from controls", () => {
  const { context, document } = loadOverlay({ reduced: true });

  const detail = context.mountDetail("<h2>Details</h2>", `x" onerror="bad`);

  assert.equal(document.querySelector(".detail"), detail);
  assert.match(detail.innerHTML, /x&quot; onerror=&quot;bad/);
  detail.querySelector(".detail-x").click();
  assert.equal(document.querySelector(".detail"), null);

  const backdrop = context.CairnDetailOverlay.mountDetail("<p>Again</p>");
  backdrop.dispatch("click", { target: backdrop });
  assert.equal(document.querySelector(".detail"), null);
});

test("detail overlay carries dialog semantics, locks scroll, and restores it on close", () => {
  const { context, document } = loadOverlay({ reduced: true });

  const detail = context.mountDetail("<h2>Details</h2>");
  assert.equal(detail.getAttribute("role"), "dialog");
  assert.equal(detail.getAttribute("aria-modal"), "true");
  assert.equal(detail.getAttribute("aria-label"), "Details");
  // Focus lands on the close control inside the dialog.
  assert.ok(detail.querySelector(".detail-x").focusCount >= 1);
  // Background scroll is locked while open, restored on close.
  assert.equal(document.body.style.overflow, "hidden");

  detail.querySelector(".detail-x").click();
  assert.equal(document.querySelector(".detail"), null);
  assert.equal(document.body.style.overflow, "");
});

test("detail overlay opens from an origin tile with transition cleanup", () => {
  const { context, document } = loadOverlay();
  const oldDetail = context.mountDetail("<p>Old</p>");
  const origin = new FakeElement("button");
  document.body.appendChild(origin);
  let builds = 0;

  context.openDetailFrom(origin, () => {
    builds += 1;
    context.mountDetail("<p>New</p>");
  });

  assert.equal(oldDetail.isConnected, false);
  assert.equal(builds, 1);
  assert.equal(origin.style.viewTransitionName, "");
  assert.equal(document.transitions, 1);
  assert.match(document.querySelector(".detail").innerHTML, /New/);
});

test("detail overlay Escape closes a sheet first, then detail", () => {
  const harness = loadOverlay({ reduced: true });
  const { context, document } = harness;
  const sheet = new FakeElement("div");
  sheet.className = "sheet";
  document.body.appendChild(sheet);
  context.mountDetail("<p>Open</p>");

  document.keydown("Escape");
  assert.equal(harness.closeMealSheetCalls, 1);
  assert.ok(document.querySelector(".detail"));

  sheet.remove();
  document.keydown("Escape");
  assert.equal(document.querySelector(".detail"), null);
});

test("detail overlay common wiring zooms art and wires data-close controls", () => {
  const { context, document } = loadOverlay({ reduced: false });
  const detail = context.mountDetail('<div class="detail-art"><span></span></div><button data-close>Done</button>');

  context.wireDetailCommon();
  const art = detail.querySelector(".detail-art");
  art.dispatch("wheel", { deltaY: -100 });
  assert.match(art.firstElementChild.style.transform, /scale\(1\./);

  detail.querySelector("[data-close]").click();
  assert.equal(document.querySelector(".detail"), null);
});
