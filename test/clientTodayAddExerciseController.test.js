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

// Drains the microtask queue completely (not a fixed tick count — the add-exercise
// controller's await chain has grown deeper than a handful of Promise.resolve() hops
// as it fetches /last-set from more call sites, and a fixed count is fragile against
// future depth changes). setImmediate's callback only runs once Node has fully
// drained the microtask queue, so a single hop here flushes any depth of awaits.
async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
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

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
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
    const logrow = card.appendChild(new FakeElement("div", { className: "logrow" }));
    card.appendChild(new FakeElement("div", { className: "logged" }));
    logrow.appendChild(new FakeElement("input", { className: html.includes("in-dur") ? "in-dur" : "in-r" }));
    // Mirrors exerciseCardHtml's real .ex-lastset element — the mocked exCard below
    // marks its presence so wireLastSetLine (loaded alongside the controller) has a
    // real element to find via row.closest(".ex").querySelector(".ex-lastset").
    if (html.includes('class="ex-lastset"')) {
      card.appendChild(new FakeElement("div", { className: "ex-lastset", textContent: "Last time: mock" }));
    }
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
    Number,
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
  // Loaded alongside the controller (same shared-global-scope pattern the real bundle
  // uses) so the controller's direct CairnTodaySessionSetModel.wireLastSetLine call
  // resolves to the real implementation, not a ReferenceError.
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-set-model.js"), "utf8"), context);
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
    exCard: (item, _logged, prefill, _revealIdx, _rx, lastSet) =>
      `<article class="ex" data-card="${item.exercise}" data-mode="${item.mode || "reps"}"><div class="logrow"></div><div class="logged"></div><input class="${item.mode === "timed" ? "in-dur" : "in-r"}" value="${prefill.reps ?? ""}">${lastSet ? `<div class="ex-lastset">Last time: mock</div>` : ""}</article>`,
    wireGuides: (card) => guides.push(card),
    wireLogRow: (row) => logRows.push(row),
    wireSkips: () => { skipWires += 1; },
    toast: (message) => toasts.push(message),
    escapeHtml: (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    escapeAttr: (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;"),
    parseDur: (text) => {
      const num = Number(text);
      return Number.isFinite(num) ? num : null;
    },
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

test("Today add-exercise controller persists a brand-new off-plan exercise (reps, fire-and-forget)", async () => {
  const harness = loadController();

  await harness.controller.setupAddExercise(harness.deps);
  harness.btn.click();
  await flushAsync();

  // A name not in the known set is a genuinely-new movement: it's POSTed so the
  // exercises row exists immediately (which lets the background brain canonicalize
  // it, write a guide, and generate art), while the off-plan card still renders.
  harness.input.value = "Zercher squat";
  harness.go.click();
  await flushAsync();

  assert.deepEqual(harness.modes, [{ name: "Zercher squat", mode: "reps" }], "new reps exercise is persisted");
  assert.deepEqual(plain(harness.deps.state.pendingOffPlan["2026-06-30"]), [{ name: "Zercher squat", mode: "reps" }]);
  assert.equal(harness.deps.state.exModes["Zercher squat"], "reps", "marked known so a rapid re-add doesn't double-post");
  assert.equal(harness.form.hidden, true);
});

test("Today add-exercise controller persists a brand-new TIMED off-plan exercise with its mode", async () => {
  const harness = loadController();

  await harness.controller.setupAddExercise(harness.deps);
  harness.btn.click();
  await flushAsync();

  harness.input.value = "Copenhagen plank";
  harness.modeWrap.querySelectorAll("[data-exmode]").find((button) => button.dataset.exmode === "timed").click();
  harness.go.click();
  await flushAsync();

  assert.deepEqual(harness.modes, [{ name: "Copenhagen plank", mode: "timed" }], "new timed exercise is persisted with its mode");
  assert.deepEqual(plain(harness.deps.state.pendingOffPlan["2026-06-30"]), [{ name: "Copenhagen plank", mode: "timed" }]);
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

test("Today add-exercise controller renders the last-time line and live-wires it for a freshly-inserted off-plan card", async () => {
  const harness = loadController();
  await harness.controller.setupAddExercise(harness.deps);

  harness.input.value = "Dead hang";
  harness.go.click();
  await flushAsync();

  assert.deepEqual(harness.requests, ["/last-set?exercise=Dead%20hang"], "fetches /last-set exactly once");
  const card = harness.rootEl.querySelector(".ex[data-card]");
  const line = card.querySelector(".ex-lastset");
  assert.ok(line, "the inserted card carries the .ex-lastset line");
  assert.equal(line.dataset.wired, "1", "wireLastSetLine wired the live beat state");
  assert.equal(line.classList.contains("ex-lastset-beat"), false);

  // The default last-set (weight 30 × 10 reps → Epley score 40) is beaten by typing
  // a higher-scoring set into the freshly-inserted card's own input.
  const repsInput = card.querySelector(".in-r");
  repsInput.value = "50";
  repsInput.dispatch("input");
  assert.equal(line.classList.contains("ex-lastset-beat"), true, "live wiring reacts to input on the inserted card");
});

test("Today add-exercise controller omits the last-time line when there's no last-set data", async () => {
  const harness = loadController();
  harness.deps.api = async (path) => {
    harness.requests.push(path);
    if (path === "/exercises") return [];
    return null;
  };
  await harness.controller.setupAddExercise(harness.deps);

  harness.input.value = "Zercher squat";
  harness.go.click();
  await flushAsync();

  const card = harness.rootEl.querySelector(".ex[data-card]");
  assert.equal(card.querySelector(".ex-lastset"), null);
});

test("Today add-exercise controller fetches and wires the last-time line on the mode-switch replace path", async () => {
  const harness = loadController();
  const existing = harness.rootEl.appendChild(new FakeElement("article", { className: "ex", dataset: { card: "Row", mode: "reps" } }));
  existing.appendChild(new FakeElement("div", { className: "logged" }));

  await harness.controller.setupAddExercise(harness.deps);

  harness.input.value = "Row";
  harness.modeWrap.querySelectorAll("[data-exmode]").find((button) => button.dataset.exmode === "timed").click();
  harness.go.click();
  await flushAsync();

  assert.deepEqual(harness.requests, ["/last-set?exercise=Row"], "replaceEmptyExistingCard fetches /last-set too");
  const card = harness.rootEl.querySelector(".ex[data-card]");
  const line = card.querySelector(".ex-lastset");
  assert.ok(line, "the replaced card carries the .ex-lastset line");
  assert.equal(line.dataset.wired, "1", "wireLastSetLine wired the live beat state on the replace path too");
});
