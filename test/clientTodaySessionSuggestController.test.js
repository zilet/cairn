import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function decodeAttr(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

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

  sync() {
    this.owner.className = [...this.names].join(" ");
  }
}

class FakeStyle {
  constructor() {
    this.removed = [];
  }

  removeProperty(name) {
    this.removed.push(name);
  }
}

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.id = attrs.id || "";
    this.className = attrs.className || "";
    this.dataset = { ...(attrs.dataset || {}) };
    this.value = attrs.value || "";
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.style = new FakeStyle();
    this.classList = new FakeClassList(this);
    this._innerHTML = "";
    this.focusCount = 0;
    this.scrolls = [];
  }

  get isConnected() {
    return Boolean(this.parentElement);
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    if (this._innerHTML.includes("sug-card")) this.addChild(new FakeElement("section", { className: "sug-card" }));
    if (this._innerHTML.includes("job-cap")) this.addChild(new FakeElement("div", { className: "job-cap" }));
    if (this._innerHTML.includes("sug-prompt")) this.addChild(new FakeElement("input", { className: "sug-prompt" }));
    if (this._innerHTML.includes("data-sugbuild")) this.addChild(new FakeElement("button", { dataset: { sugbuild: "" } }));
    if (this._innerHTML.includes("data-sugcancel")) this.addChild(new FakeElement("button", { dataset: { sugcancel: "" } }));
    for (const match of this._innerHTML.matchAll(/data-vibe="([^"]*)"/g)) {
      this.addChild(new FakeElement("button", { dataset: { vibe: decodeAttr(match[1]) } }));
    }
    for (const match of this._innerHTML.matchAll(/data-sugaction="([^"]*)"/g)) {
      this.addChild(new FakeElement("button", { dataset: { sugaction: decodeAttr(match[1]) } }));
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  addChild(child) {
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
      handler({ target: this, currentTarget: this, preventDefault() {}, key: undefined, ...event });
    }
  }

  click() {
    this.dispatch("click");
  }

  focus() {
    this.focusCount += 1;
  }

  scrollIntoView(options) {
    this.scrolls.push(options);
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector === "[data-sugbuild]") return Object.hasOwn(this.dataset, "sugbuild");
    if (selector === "[data-sugcancel]") return Object.hasOwn(this.dataset, "sugcancel");
    if (selector === "[data-vibe]") return Object.hasOwn(this.dataset, "vibe");
    if (selector === "[data-sugaction]") return Object.hasOwn(this.dataset, "sugaction");
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

function loadController({ reduced = false } = {}) {
  const rootEl = new FakeElement("section");
  const slot = rootEl.addChild(new FakeElement("div", { id: "sugSlot" }));
  const requests = [];
  const captions = [];
  const countUps = [];
  const collapses = [];
  const toasts = [];
  const appended = [];
  const reveals = [];
  const context = {
    Element: FakeElement,
    HTMLElement: FakeElement,
    Object,
    Promise,
    String,
    window: null,
    globalThis: null,
    setTimeout: (fn) => fn(),
    CairnTodaySessionSuggest: {
      composerHtml: () => `<div class="sug-composer"><input class="sug-prompt"><button data-vibe="upper body"></button><button data-sugbuild></button><button data-sugcancel></button></div>`,
      loadingHtml: () => `<div class="sug-card sug-loading"><div class="job-cap"></div></div>`,
      cardHtml: (session) => `<section class="sug-card"><h3>${session?.name || "Session"}</h3><button data-sugaction="log"></button><button data-sugaction="dismiss"></button></section>`,
      failureHtml: () => `<section class="sug-card"><button data-sugaction="retry"></button></section>`,
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-suggest-controller.js"), "utf8"), context);
  const deps = {
    root: rootEl,
    state: { logDate: "2026-06-30", suggestedSession: null },
    runOp: async (kind, body, options) => {
      requests.push({ kind, body, options });
      return { queued: true };
    },
    thinkingCaption: (el, op) => {
      captions.push({ el, op });
      return () => captions.push({ stopped: true });
    },
    runCountUps: (el) => countUps.push(el),
    collapseEl: (el, done) => {
      collapses.push(el);
      if (done) done();
    },
    reducedMotion: () => reduced,
    toast: (message) => toasts.push(message),
    revealPlanThen: (after, opts) => {
      reveals.push(opts);
      return after();
    },
    appendOffPlanCard: (name, mode) => appended.push({ name, mode }),
  };
  return {
    controller: context.CairnTodaySessionSuggestController,
    rootEl,
    slot,
    deps,
    requests,
    captions,
    countUps,
    collapses,
    toasts,
    appended,
    reveals,
  };
}

test("Today session-suggest controller submits composer constraints and guards duplicates", async () => {
  const harness = loadController();

  harness.controller.revealSessionComposer(harness.deps);
  const input = harness.slot.querySelector(".sug-prompt");
  assert.equal(input.focusCount, 1);
  harness.slot.querySelector("[data-vibe]").click();
  assert.equal(input.value, "upper body");

  harness.slot.querySelector("[data-sugbuild]").click();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].kind, "session_suggest");
  assert.deepEqual(plain(harness.requests[0].body), { date: "2026-06-30", constraints: "upper body" });
  assert.match(harness.slot.innerHTML, /sug-loading/);

  await harness.controller.askForSession({}, harness.deps);
  assert.deepEqual(harness.toasts, ["Already drafting a session…"]);
});

test("Today session-suggest controller renders success and logs suggested items", () => {
  const harness = loadController({ reduced: true });
  const options = harness.controller.sessionSuggestOpOpts(harness.deps);

  options.render({
    ok: true,
    verified: { checked: true },
    session: {
      name: "Quick upper",
      items: [
        { exercise: "Push-up", sets: 2, rep_low: 8 },
        { exercise: "Dead hang", mode: "timed", target_seconds: 45 },
      ],
    },
  });

  assert.equal(harness.deps.state.suggestedSession.name, "Quick upper");
  assert.equal(harness.countUps[0], harness.slot);
  assert.deepEqual(plain(harness.slot.scrolls[0]), { behavior: "auto", block: "nearest" });

  harness.slot.querySelectorAll("[data-sugaction]").find((button) => button.dataset.sugaction === "log").click();
  assert.deepEqual(plain(harness.reveals), [{ blank: true }]);
  assert.deepEqual(plain(harness.appended), [
    { name: "Push-up", mode: "reps" },
    { name: "Dead hang", mode: "timed" },
  ]);
  assert.equal(harness.deps.state.suggestedSession, null);
  assert.deepEqual(harness.toasts, ["Added to today — log as you go"]);
  assert.equal(harness.slot.innerHTML, "");
});

test("Today session-suggest controller reconnects loading state and clears on failure", () => {
  const harness = loadController();

  const handlers = harness.controller.reconnectSessionSuggest({ id: "job_1" }, harness.deps);
  assert.ok(handlers);
  assert.match(harness.slot.innerHTML, /sug-loading/);
  assert.equal(harness.captions[0].op, "session_suggest");
  assert.equal(harness.slot.classList.contains("is-thinking"), true);

  handlers.onError();
  assert.equal(harness.slot.classList.contains("is-thinking"), false);
  assert.deepEqual(harness.slot.style.removed, ["--frac"]);
  assert.match(harness.slot.innerHTML, /data-sugaction="retry"/);
  assert.deepEqual(harness.captions.at(-1), { stopped: true });
});
