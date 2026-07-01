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

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.names = new Set(String(owner.className || "").split(/\s+/).filter(Boolean));
  }

  contains(name) {
    return this.names.has(name);
  }

  toggle(name, on) {
    if (on) this.names.add(name);
    else this.names.delete(name);
    this.owner.className = [...this.names].join(" ");
  }
}

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.id = attrs.id || "";
    this.className = attrs.className || "";
    this.dataset = { ...(attrs.dataset || {}) };
    this.value = attrs.value || "";
    this.hidden = false;
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this._innerHTML = "";
    this.focusCount = 0;
    this.scrolls = [];
    this.clicks = 0;
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    for (const match of this._innerHTML.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)) {
      this.appendChild(new FakeElement("option", { value: decodeAttr(match[1]) }));
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

  before(child) {
    if (!this.parentElement) return;
    child.parentElement = this.parentElement;
    const index = this.parentElement.children.indexOf(this);
    this.parentElement.children.splice(index < 0 ? this.parentElement.children.length : index, 0, child);
  }

  replaceWith(fresh) {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) {
      fresh.parentElement = this.parentElement;
      this.parentElement.children[index] = fresh;
      this.parentElement = null;
    }
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
    this.clicks += 1;
    this.dispatch("click");
  }

  focus() {
    this.focusCount += 1;
  }

  scrollIntoView(options) {
    this.scrolls.push(options);
  }

  matches(selector) {
    if (selector === "#skipLine [data-unskip]") return this.dataset.unskip != null && this.parentElement?.id === "skipLine";
    if (selector === ".logged .chip") return this.classList.contains("chip") && this.parentElement?.classList.contains("logged");
    if (selector === ".ex[data-card]") return this.classList.contains("ex") && this.dataset.card != null;
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (selector === "[data-exmode]") return this.dataset.exmode != null;
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
    this.content = { firstElementChild: null };
  }

  set innerHTML(value) {
    const html = String(value || "");
    const card = new FakeElement("article", {
      className: "ex",
      dataset: {
        card: decodeAttr(html.match(/data-card="([^"]*)"/)?.[1] || ""),
        mode: decodeAttr(html.match(/data-mode="([^"]*)"/)?.[1] || "reps"),
      },
    });
    card.appendChild(new FakeElement("div", { className: "logrow" }));
    card.appendChild(new FakeElement("div", { className: "logged" }));
    card.appendChild(new FakeElement("input", { className: html.includes("in-dur") ? "in-dur" : "in-r" }));
    this.content.firstElementChild = card;
  }
}

function loadController() {
  const rootEl = new FakeElement("section");
  const addBlock = rootEl.appendChild(new FakeElement("div", { className: "addex" }));
  const btn = rootEl.appendChild(new FakeElement("button", { id: "addExBtn" }));
  const form = rootEl.appendChild(new FakeElement("form", { id: "addExForm" }));
  form.hidden = true;
  const input = form.appendChild(new FakeElement("input", { id: "addExInput" }));
  const go = form.appendChild(new FakeElement("button", { id: "addExGo" }));
  const datalist = form.appendChild(new FakeElement("datalist", { id: "exOptions" }));
  const modeWrap = form.appendChild(new FakeElement("div", { id: "addExMode" }));
  modeWrap.appendChild(new FakeElement("button", { className: "modebtn active", dataset: { exmode: "reps" } }));
  modeWrap.appendChild(new FakeElement("button", { className: "modebtn", dataset: { exmode: "timed" } }));

  const requests = [];
  const modes = [];
  const guides = [];
  const logRows = [];
  let skipWires = 0;
  const toasts = [];
  const context = {
    Element: FakeElement,
    HTMLElement: FakeElement,
    Object,
    Promise,
    String,
    decodeURIComponent,
    encodeURIComponent,
    window: null,
    globalThis: null,
    document: {
      createElement: (tag) => tag === "template" ? new FakeTemplate() : new FakeElement(tag),
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-add-exercise-controller.js"), "utf8"), context);

  const deps = {
    root: rootEl,
    state: { logDate: "2026-06-30", exModes: {}, pendingOffPlan: {} },
    api: async (path) => {
      requests.push(path);
      if (path === "/exercises") {
        return [
          { name: "Dead hang", mode: "timed", muscle_group: "forearms" },
          { name: "Cable row", mode: "reps", muscle_group: "back" },
        ];
      }
      return { weight: 30, reps: 10, rir: 2, duration_sec: null };
    },
    postExerciseMode: async (name, mode) => {
      modes.push({ name, mode });
      return { ok: true };
    },
    exCard: (item, _logged, prefill) =>
      `<article class="ex" data-card="${item.exercise}" data-mode="${item.mode || "reps"}"><div class="logrow"></div><div class="logged"></div><input class="${item.mode === "timed" ? "in-dur" : "in-r"}" value="${prefill.reps ?? ""}"></article>`,
    wireGuides: (card) => guides.push(card),
    wireLogRow: (row) => logRows.push(row),
    wireSkips: () => { skipWires += 1; },
    toast: (message) => toasts.push(message),
    escapeHtml: (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    escapeAttr: (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;"),
  };

  return {
    controller: context.CairnTodayAddExerciseController,
    rootEl,
    addBlock,
    btn,
    form,
    input,
    go,
    datalist,
    modeWrap,
    deps,
    requests,
    modes,
    guides,
    logRows,
    toasts,
    get skipWires() { return skipWires; },
  };
}

test("Today add-exercise controller loads known exercises and appends off-plan cards", async () => {
  const harness = loadController();

  await harness.controller.setupAddExercise(harness.deps);
  harness.btn.click();
  await flushAsync();

  assert.equal(harness.form.hidden, false);
  assert.equal(harness.btn.hidden, true);
  assert.equal(harness.input.focusCount, 1);
  assert.deepEqual(harness.requests, ["/exercises"]);
  assert.match(harness.datalist.innerHTML, /Dead hang/);

  harness.input.value = "Dead hang";
  harness.input.dispatch("input");
  harness.go.click();
  await flushAsync();

  assert.deepEqual(plain(harness.deps.state.pendingOffPlan["2026-06-30"]), [{ name: "Dead hang", mode: "timed" }]);
  assert.deepEqual(harness.requests, ["/exercises", "/last-set?exercise=Dead%20hang"]);
  assert.deepEqual(harness.modes, []);
  assert.equal(harness.rootEl.children.indexOf(harness.guides[0]) < harness.rootEl.children.indexOf(harness.addBlock), true);
  assert.equal(harness.logRows[0].className, "logrow");
  assert.equal(harness.skipWires, 1);
  assert.equal(harness.form.hidden, true);
  assert.equal(harness.btn.hidden, false);
});

test("Today add-exercise controller restores skipped exercises and protects existing typed cards", async () => {
  const harness = loadController();
  const existing = harness.rootEl.appendChild(new FakeElement("article", { className: "ex", dataset: { card: "Push-up", mode: "reps" } }));
  const logged = existing.appendChild(new FakeElement("div", { className: "logged" }));
  logged.appendChild(new FakeElement("span", { className: "chip" }));
  existing.appendChild(new FakeElement("input", { className: "in-r" }));
  const skipLine = harness.rootEl.appendChild(new FakeElement("div", { id: "skipLine" }));
  const skipped = skipLine.appendChild(new FakeElement("button", { dataset: { unskip: encodeURIComponent("Cable row") } }));

  await harness.controller.setupAddExercise(harness.deps);

  harness.input.value = "Cable row";
  harness.go.click();
  await flushAsync();
  assert.equal(skipped.clicks, 1);

  harness.input.value = "Push-up";
  harness.modeWrap.querySelectorAll("[data-exmode]").find((button) => button.dataset.exmode === "timed").click();
  harness.go.click();
  await flushAsync();

  assert.deepEqual(harness.toasts, ["Push-up already has sets — delete them to change its type"]);
  assert.equal(existing.scrolls.length, 1);
  assert.deepEqual(harness.modes, []);
});
