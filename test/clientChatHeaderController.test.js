import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.names = new Set(String(owner.className || "").split(/\s+/).filter(Boolean));
  }

  syncFromOwner() {
    for (const name of String(this.owner.className || "").split(/\s+/).filter(Boolean)) this.names.add(name);
  }

  contains(name) {
    this.syncFromOwner();
    return this.names.has(name);
  }

  add(name) {
    this.syncFromOwner();
    this.names.add(name);
    this.owner.className = [...this.names].join(" ");
  }

  remove(name) {
    this.syncFromOwner();
    this.names.delete(name);
    this.owner.className = [...this.names].join(" ");
  }
}

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.id = attrs.id || "";
    this.className = attrs.className || "";
    this.hidden = !!attrs.hidden;
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this.innerHTML = "";
    this.focusCount = 0;
    this.removed = false;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  prepend(child) {
    child.parentElement = this;
    this.children.unshift(child);
    return child;
  }

  remove() {
    this.removed = true;
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  click() {
    for (const handler of this.listeners.get("click") || []) handler({ target: this, currentTarget: this });
  }

  focus() {
    this.focusCount += 1;
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
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
}

class FakeTextArea extends FakeElement {}

class FakeTemplate {
  constructor() {
    this.content = { firstElementChild: null };
  }

  set innerHTML(value) {
    const html = String(value || "");
    if (!html.includes("hdrChatActions")) {
      this.content.firstElementChild = null;
      return;
    }
    const wrap = new FakeElement("div", { id: "hdrChatActions" });
    wrap.appendChild(new FakeElement("button", { id: "hdrHistory" }));
    wrap.appendChild(new FakeElement("button", { id: "hdrFresh", hidden: html.includes("hidden") }));
    this.content.firstElementChild = wrap;
  }
}

function findById(rootEl, id) {
  if (rootEl.id === id) return rootEl;
  for (const child of rootEl.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function loadHarness(overrides = {}) {
  const body = new FakeElement("body");
  const header = body.appendChild(new FakeElement("header"));
  const chatlog = body.appendChild(new FakeElement("div", { id: "chatlog" }));
  const fuelSlot = body.appendChild(new FakeElement("div", { id: "chatFuelSlot" }));
  fuelSlot.innerHTML = "fuel";
  const input = body.appendChild(new FakeTextArea("textarea", { id: "chatInput" }));
  const timers = [];
  const requests = [];
  const streams = [];
  let historyOpened = 0;
  let clearFuel = 0;
  let drawEmpty = 0;
  let token = overrides.token ?? 11;

  const context = {
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLTextAreaElement: FakeTextArea,
    Object,
    Number,
    Promise,
    String,
    console,
    globalThis: null,
    window: null,
    document: {
      createElement: (tag) => tag === "template" ? new FakeTemplate() : new FakeElement(tag),
      getElementById: (id) => findById(body, id),
      querySelector: (selector) => selector === "header" ? header : body.querySelector(selector),
    },
    CairnChatClient: {
      headerActionsHtml: () => `<div id="hdrChatActions"><button id="hdrHistory"></button><button id="hdrFresh" hidden></button></div>`,
      freshPillHtml: (distilled) => distilled ? `${distilled} remembered` : "Fresh start",
    },
    requestAnimationFrame: (fn) => {
      fn();
      return 1;
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length;
    },
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    },
    matchMedia: () => ({ matches: overrides.hover ?? true }),
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/chat-header-controller.js"), "utf8"), context);

  const deps = {
    state: { tab: "chat" },
    currentToken: () => token,
    clearFuelContext: () => { clearFuel += 1; },
    drawEmptyChat: () => { drawEmpty += 1; },
    enqueueJob: async (path, bodyArg) => {
      requests.push({ path, body: bodyArg });
      return overrides.enqueueResult ?? { ok: true, distilled: 2 };
    },
    openJobStream: (jobId, handlers) => {
      streams.push({ jobId, handlers });
    },
    openChatHistory: () => { historyOpened += 1; },
  };

  return {
    context,
    deps,
    body,
    header,
    chatlog,
    fuelSlot,
    input,
    requests,
    streams,
    timers,
    setToken: (next) => { token = next; },
    get historyOpened() { return historyOpened; },
    get clearFuel() { return clearFuel; },
    get drawEmpty() { return drawEmpty; },
  };
}

test("chat header controller wires history and the two-tap fresh-start flow", async () => {
  const harness = loadHarness();
  const buttons = harness.context.CairnChatHeaderController.ensureChatHeaderBtns(harness.deps);

  assert.equal(buttons.historyBtn.id, "hdrHistory");
  assert.equal(buttons.freshBtn.id, "hdrFresh");
  assert.equal(harness.header.querySelector("#hdrChatActions").parentElement, harness.header);

  buttons.historyBtn.click();
  assert.equal(harness.historyOpened, 1);

  buttons.freshBtn.click();
  assert.equal(buttons.freshBtn.classList.contains("armed"), true);
  assert.equal(harness.requests.length, 0);

  buttons.freshBtn.click();
  await flushAsync();

  assert.equal(buttons.freshBtn.classList.contains("armed"), false);
  assert.equal(buttons.freshBtn.hidden, true);
  assert.equal(harness.clearFuel, 1);
  assert.equal(harness.drawEmpty, 1);
  assert.equal(harness.fuelSlot.innerHTML, "");
  assert.equal(harness.input.focusCount, 1);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].path, "/chat/reset");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.requests[0].body)), {});
  assert.equal(harness.header.querySelector(".fresh-pill").innerHTML, "2 remembered");
});

test("chat header controller settles background distill jobs with stale guards", async () => {
  const harness = loadHarness({ enqueueResult: { ok: true, distilling: "job-1" } });
  const buttons = harness.context.CairnChatHeaderController.ensureChatHeaderBtns(harness.deps);

  buttons.freshBtn.click();
  buttons.freshBtn.click();
  await flushAsync();

  assert.equal(harness.streams.length, 1);
  assert.equal(harness.streams[0].jobId, "job-1");
  assert.equal(harness.streams[0].handlers.guard(), false);

  harness.deps.state.tab = "plan";
  assert.equal(harness.streams[0].handlers.guard(), true);
  harness.deps.state.tab = "chat";
  harness.setToken(12);
  assert.equal(harness.streams[0].handlers.guard(), true);

  harness.setToken(11);
  harness.streams[0].handlers.onDone({ ok: true, distilled: 3 });
  assert.equal(harness.header.querySelector(".fresh-pill").innerHTML, "3 remembered");
});
