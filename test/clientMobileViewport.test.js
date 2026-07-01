import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function listenerMap() {
  return new Map();
}

function addListener(map) {
  return (type, handler) => {
    const list = map.get(type) || [];
    list.push(handler);
    map.set(type, list);
  };
}

function fire(map, type, event = {}) {
  for (const handler of map.get(type) || []) handler(event);
}

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  toggle(name, on) {
    if (on) this.values.add(name);
    else this.values.delete(name);
  }

  add(name) {
    this.values.add(name);
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName;
    this.attrs = attrs;
    this.classList = new FakeClassList();
    this.isContentEditable = false;
    this.blurCount = 0;
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }

  closest(selector) {
    return selector === ".chatview" ? this.chatView || null : null;
  }

  blur() {
    this.blurCount += 1;
  }
}

function loadMobileViewport(options = {}) {
  const source = readFileSync(new URL("../public/js/app-mobile-viewport.js", import.meta.url), "utf8");
  const windowListeners = listenerMap();
  const documentListeners = listenerMap();
  const viewportListeners = listenerMap();
  const style = new Map();
  let measureCount = 0;

  const visualViewport = {
    height: options.viewportHeight ?? 760,
    offsetTop: options.offsetTop ?? 0,
    addEventListener: addListener(viewportListeners),
  };
  const body = new FakeElement("BODY");
  const document = {
    activeElement: body,
    body,
    documentElement: { style: { setProperty: (name, value) => style.set(name, value) } },
    visibilityState: "visible",
    addEventListener: addListener(documentListeners),
  };
  const window = {
    innerHeight: options.innerHeight ?? 800,
    visualViewport,
    addEventListener: addListener(windowListeners),
  };
  const context = {
    Element: FakeElement,
    HTMLElement: FakeElement,
    clearTimeout,
    document,
    globalThis: null,
    matchMedia: () => ({ matches: false }),
    measureChatTop: () => {
      measureCount += 1;
    },
    requestAnimationFrame: (fn) => fn(),
    setTimeout,
    state: { tab: options.tab ?? "chat" },
    window,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "app-mobile-viewport.js" });
  return {
    body,
    context,
    document,
    documentListeners,
    fireDocument: (type, event) => fire(documentListeners, type, event),
    fireViewport: (type, event) => fire(viewportListeners, type, event),
    fireWindow: (type, event) => fire(windowListeners, type, event),
    getMeasureCount: () => measureCount,
    getStyle: (name) => style.get(name),
    viewportListeners,
    visualViewport,
    window,
    windowListeners,
  };
}

test("mobile viewport guard installs once and preserves bottom inset", () => {
  const env = loadMobileViewport();
  const install = env.context.window.installMobileViewportGuards;

  assert.equal(typeof install, "function");
  install();
  assert.equal(env.getStyle("--vvb"), "40px");
  assert.equal(env.body.classList.contains("kb-open"), false);
  assert.equal(env.body.classList.contains("kb-geometry-open"), false);
  assert.equal(env.getMeasureCount(), 1);
  assert.equal(env.windowListeners.get("resize").length, 1);
  assert.equal(env.viewportListeners.get("resize").length, 1);
  assert.equal(env.viewportListeners.get("scroll").length, 1);

  install();
  assert.equal(env.windowListeners.get("resize").length, 1);
  assert.equal(env.viewportListeners.get("resize").length, 1);

  env.fireWindow("resize");
  assert.equal(env.getMeasureCount(), 2);
});

test("mobile viewport guard derives keyboard state from visual viewport geometry", () => {
  const env = loadMobileViewport({ viewportHeight: 800 });
  env.context.window.installMobileViewportGuards();

  assert.equal(env.body.classList.contains("kb-open"), false);
  assert.equal(env.getStyle("--vvb"), "0px");

  env.visualViewport.height = 540;
  env.fireViewport("resize");
  assert.equal(env.body.classList.contains("kb-open"), true);
  assert.equal(env.body.classList.contains("kb-geometry-open"), true);
  assert.equal(env.getStyle("--vvb"), "0px");

  const chatView = new FakeElement("DIV");
  const input = new FakeElement("TEXTAREA");
  input.chatView = chatView;
  env.body.classList.add("chat-mode");
  env.document.activeElement = input;
  env.visualViewport.height = 800;
  env.fireViewport("resize");

  assert.equal(env.body.classList.contains("kb-open"), false);
  assert.equal(env.body.classList.contains("kb-geometry-open"), false);
  assert.equal(input.blurCount, 1);
});

test("mobile viewport keeps keyboard intent separate from geometry truth", () => {
  const env = loadMobileViewport({ viewportHeight: 800 });
  env.context.window.installMobileViewportGuards();
  const chatView = new FakeElement("DIV");
  const input = new FakeElement("TEXTAREA");
  input.chatView = chatView;

  env.fireDocument("pointerdown", { target: input });

  assert.equal(env.body.classList.contains("kb-open"), true);
  assert.equal(env.body.classList.contains("kb-geometry-open"), false);
});
