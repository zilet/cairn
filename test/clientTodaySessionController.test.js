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

// Local-date (not UTC) days-ago ISO string, matching date-utils.js's localISO() convention —
// keeps humanDate() assertions stable regardless of when the suite actually runs.
function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
    this.value = attrs.value || "";
    this.textContent = attrs.textContent || "";
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this._innerHTML = "";
    this.focusCount = 0;
    this.removed = false;
  }

  get isConnected() {
    return Boolean(this.parentElement);
  }

  get nextElementSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index >= 0 ? this.parentElement.children[index + 1] || null : null;
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    if (this._innerHTML.includes('id="feedbackOpen"')) {
      this.appendChild(new FakeElement("button", { id: "feedbackOpen" }));
    }
    if (this._innerHTML.includes("feedback-form")) {
      this.appendChild(new FakeElement("button", { className: "feel-dot", dataset: { feel: "soreness", val: "1" } }));
      this.appendChild(new FakeElement("button", { className: "feel-dot", dataset: { feel: "soreness", val: "2" } }));
      this.appendChild(new FakeElement("button", { className: "feel-dot", dataset: { feel: "performance", val: "1" } }));
      this.appendChild(new FakeElement("input", { id: "feedbackJoint", value: decodeAttr(this._innerHTML.match(/id="feedbackJoint"[^>]*value="([^"]*)"/)?.[1] || "") }));
      this.appendChild(new FakeElement("button", { id: "feedbackDismiss" }));
    }
    if (this._innerHTML.includes('id="feedbackEdit"')) {
      this.appendChild(new FakeElement("button", { id: "feedbackEdit" }));
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, ref) {
    child.parentElement = this;
    child.parentNode = this;
    const index = this.children.indexOf(ref);
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  remove() {
    this.removed = true;
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
    this.parentNode = null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler({
        target: this,
        currentTarget: this,
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
    }
  }

  click() {
    this.dispatch("click");
  }

  focus() {
    this.focusCount += 1;
  }

  hasAttribute(name) {
    if (!name.startsWith("data-")) return false;
    const key = name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    return Object.hasOwn(this.dataset, key);
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
    if (selector === ".ex .logrow") return this.classList.contains("logrow") && this.parentElement?.classList.contains("ex");
    if (selector === "[data-logged] .chip") return this.classList.contains("chip") && Object.hasOwn(this.parentElement?.dataset || {}, "logged");
    if (selector === ".ex [data-logged] .chip") return this.classList.contains("chip") &&
      Object.hasOwn(this.parentElement?.dataset || {}, "logged") &&
      Boolean(this.parentElement?.parentElement?.classList.contains("ex"));
    if (selector === ".feel-dot[data-feel=\"soreness\"]") return this.classList.contains("feel-dot") && this.dataset.feel === "soreness";
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (selector === ".ex") return this.classList.contains("ex");
    if (selector === ".ex-skip") return this.classList.contains("ex-skip");
    if (selector === ".addex") return this.classList.contains("addex");
    if (selector === ".plansurface") return this.classList.contains("plansurface");
    if (selector === ".skipline-names") return this.classList.contains("skipline-names");
    if (selector === ".chip") return this.classList.contains("chip");
    if (selector === ".feel-dot") return this.classList.contains("feel-dot");
    if (selector === "[data-logged]") return Object.hasOwn(this.dataset, "logged");
    if (selector === "[data-prog]") return Object.hasOwn(this.dataset, "prog");
    if (selector === "[data-finishstat]") return Object.hasOwn(this.dataset, "finishstat");
    if (selector === "[data-del]") return Object.hasOwn(this.dataset, "del");
    if (selector === "[data-unskip]") return Object.hasOwn(this.dataset, "unskip");
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
    if (html.includes("data-unskip")) {
      this.content.firstElementChild = new FakeElement("button", {
        className: "skip-name",
        dataset: { unskip: html.match(/data-unskip="([^"]*)"/)?.[1] || "" },
        textContent: html.replace(/<[^>]+>/g, ""),
      });
      return;
    }
    const chip = new FakeElement("span", {
      className: "chip",
      dataset: { set: html.match(/data-set="([^"]*)"/)?.[1] || "" },
      textContent: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    });
    const del = new FakeElement("button", {
      className: "chip-x",
      dataset: { del: html.match(/data-del="([^"]*)"/)?.[1] || "" },
    });
    chip.appendChild(del);
    this.content.firstElementChild = chip;
  }
}

function loadController({ apiImpl, contextOverrides } = {}) {
  const requests = [];
  const invalidations = [];
  const toasts = [];
  const outbox = [];
  const renders = [];
  const rxRefreshes = [];
  const transitions = [];
  const starts = [];
  const stops = [];
  const cachedWrites = [];
  const collapses = [];
  const expands = [];
  const context = {
    Element: FakeElement,
    HTMLElement: FakeElement,
    Object,
    Promise,
    String,
    Number,
    JSON,
    decodeURIComponent,
    encodeURIComponent,
    window: null,
    globalThis: null,
    navigator: {},
    outboxEnqueue: (kind, path, body) => outbox.push({ kind, path, body }),
    document: {
      createElement: (tag) => tag === "template" ? new FakeTemplate() : new FakeElement(tag),
    },
    setTimeout: (fn) => fn(),
  };
  context.window = context;
  context.globalThis = context;
  // Opt-in host globals a case needs (AbortController + a capturing setTimeout for
  // the finish-timeout path, a fake localStorage for the notes draft). Omitted by
  // default so existing cases run exactly as before (no AbortController → the finish
  // timeout logic self-skips; no localStorage → the draft helpers no-op).
  if (contextOverrides) Object.assign(context, contextOverrides);
  vm.runInNewContext(readFileSync(join(root, "public/js/date-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-feedback-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-skip-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-set-model.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-set-actions.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-controller.js"), "utf8"), context);

  const rootEl = new FakeElement("section");
  const deps = {
    root: rootEl,
    state: { tab: "today", logDate: "2026-06-30", brief: { headline: "cached" }, pendingOffPlan: {} },
    api: async (path, opts) => {
      requests.push({ path, opts });
      if (apiImpl) return apiImpl(path, opts);
      if (path === "/sets" && opts?.method === "POST") return { ok: true, id: 10, set_number: 1, weight: 20, reps: 8, rir: 2 };
      if (path === "/sessions/skip" && opts?.method === "POST") return { ok: true };
      if (path.includes("/feedback")) return { soreness: 2, performance: null, joint_pain: "" };
      return { ok: true };
    },
    storeCached: (key, data) => cachedWrites.push({ key, data }),
    invalidate: (key) => invalidations.push(key),
    invalidateTodayProgression: () => invalidations.push("progression"),
    scheduleRxRefresh: () => rxRefreshes.push(true),
    renderToday: (opts) => renders.push(opts || {}),
    activateTab: (tab) => { deps.state.tab = tab; },
    withViewTransition: (fn) => {
      transitions.push(true);
      return fn();
    },
    viewEnter: () => transitions.push("enter"),
    reducedMotion: () => true,
    startRest: () => starts.push(true),
    stopRest: () => stops.push(true),
    toast: (message, options) => toasts.push({ message, options }),
    parseDur: (value) => Number(value) || null,
    fmtDur: (seconds) => `${seconds}s`,
    collapseEl: (el, done) => {
      collapses.push(el);
      if (done) done();
    },
    expandEl: (el) => expands.push(el),
    localISO: () => "2026-06-30",
    sessionStatus: {
      feedbackDoneHtml: (session) => session?.soreness != null ? `<div><button id="feedbackEdit"></button></div>` : "",
      feedbackFormHtml: () => `<div class="feedback-form"><button class="feel-dot" data-feel="soreness" data-val="1"></button><button class="feel-dot" data-feel="soreness" data-val="2"></button><input id="feedbackJoint" value=""><button id="feedbackDismiss"></button></div>`,
      feedbackOpenHtml: () => `<button id="feedbackOpen"></button>`,
      hasFeedback: (session) => session?.soreness != null,
      setChipHtml: (set) => `<span class="chip" data-set="${set.id}">#${set.set_number} ${set.weight} <span>×</span> ${set.reps}<button data-del="${set.id}"></button></span>`,
      skipLineHtml: () => "",
      skipNameHtml: (name) => `<button data-unskip="${encodeURIComponent(String(name))}">${name}</button>`,
    },
  };

  return {
    controller: context.CairnTodaySessionController,
    setModel: context.CairnTodaySessionSetModel,
    rootEl,
    deps,
    requests,
    invalidations,
    outbox,
    toasts,
    renders,
    rxRefreshes,
    starts,
    stops,
    cachedWrites,
    collapses,
    expands,
    transitions,
  };
}

function addLoggingCard(rootEl) {
  const card = rootEl.appendChild(new FakeElement("article", { className: "ex", dataset: { card: "Push-up" } }));
  const row = card.appendChild(new FakeElement("div", {
    className: "logrow",
    dataset: { ex: encodeURIComponent("Push-up"), day: "1", mode: "reps" },
  }));
  row.appendChild(new FakeElement("input", { className: "in-w", value: "20" }));
  row.appendChild(new FakeElement("input", { className: "in-r", value: "8" }));
  row.appendChild(new FakeElement("input", { className: "in-rir", value: "2" }));
  const button = row.appendChild(new FakeElement("button", { className: "logbtn" }));
  const logged = card.appendChild(new FakeElement("div", { dataset: { logged: "" } }));
  card.appendChild(new FakeElement("div", { dataset: { prog: "" }, textContent: "0 / 3 sets" }));
  card.appendChild(new FakeElement("button", { className: "ex-skip", dataset: { skip: encodeURIComponent("Push-up") } }));
  rootEl.appendChild(new FakeElement("div", { dataset: { finishstat: "" } }));
  return { card, row, button, logged };
}

function addLastSetLine(card, text) {
  return card.appendChild(new FakeElement("div", { className: "ex-lastset", textContent: text }));
}

test("Today session controller logs a set only after a successful POST and wires delete", async () => {
  const harness = loadController();
  const { card, row, button, logged } = addLoggingCard(harness.rootEl);

  harness.controller.wireLogRow(row, harness.deps);

  assert.equal(logged.children.length, 0);
  button.click();
  await flushAsync();

  assert.equal(harness.requests[0].path, "/sets");
  assert.equal(JSON.parse(harness.requests[0].opts.body).exercise, "Push-up");
  assert.equal(logged.children.length, 1);
  assert.equal(card.querySelector(".ex-skip"), null);
  assert.deepEqual(harness.invalidations, ["today:session:2026-06-30", "stats", "history:sessions", "progress:volume", "progression"]);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), ["Set logged"]);
  assert.equal(harness.starts.length, 1);
  assert.equal(harness.rxRefreshes.length, 1);

  logged.querySelector("[data-del]").click();
  await flushAsync();

  assert.equal(harness.requests[1].path, "/sets/10");
  assert.equal(harness.requests[1].opts.method, "DELETE");
  // Optimistic delete: the chip is removed locally and NO full renderToday fires.
  assert.equal(logged.children.length, 0);
  assert.equal(harness.renders.length, 0);
});

test("Today session controller rolls back an optimistic set delete when the DELETE fails", async () => {
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sets" && opts?.method === "POST") return { ok: true, id: 10, set_number: 1, weight: 20, reps: 8, rir: 2 };
      if (opts?.method === "DELETE") throw new Error("offline");
      return { ok: true };
    },
  });
  const { row, button, logged } = addLoggingCard(harness.rootEl);

  harness.controller.wireLogRow(row, harness.deps);
  button.click();
  await flushAsync();
  assert.equal(logged.children.length, 1);

  logged.querySelector("[data-del]").click();
  await flushAsync();

  // The DELETE was attempted, then rolled back — the chip is put back and a calm
  // toast fires, with no full renderToday.
  assert.equal(harness.requests.at(-1).path, "/sets/10");
  assert.equal(harness.requests.at(-1).opts.method, "DELETE");
  assert.equal(logged.children.length, 1);
  assert.equal(harness.renders.length, 0);
  assert.equal(harness.toasts.at(-1).message, "Couldn't remove that — try again.");
});

test("Today session controller keeps card unchanged when set POST fails", async () => {
  const harness = loadController({ apiImpl: async () => ({ ok: false, error: "bad set" }) });
  const { row, button, logged } = addLoggingCard(harness.rootEl);

  harness.controller.wireLogRow(row, harness.deps);
  button.click();
  await flushAsync();

  assert.equal(logged.children.length, 0);
  assert.deepEqual(harness.invalidations, []);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), ["bad set"]);
  assert.equal(button.disabled, false);
});

test("Today session controller finishes into cached done mode immediately", async () => {
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sessions/44/finish" && opts?.method === "POST") {
        return {
          id: 44,
          date: "2026-06-30",
          finished_at: "2026-06-30T15:00:00Z",
          sets: [
            { exercise: "Push-up", weight: 20, reps: 8 },
            { exercise: "Push-up", weight: 20, reps: 8 },
          ],
          summary: { sets: 2, tonnage: 320 },
        };
      }
      return { ok: true };
    },
  });
  harness.deps.state.planReveal = { date: "2026-06-30", on: true };
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  surface.appendChild(new FakeElement("textarea", { id: "sessNotes", value: "solid" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));

  harness.controller.wireSessionSurface({
    session: { id: 44, date: "2026-06-30", sets: [{ exercise: "Push-up" }] },
    hasLoggedSets: true,
  }, harness.deps);
  finish.click();
  await flushAsync();

  assert.equal(harness.requests[0].path, "/sessions/44/finish");
  assert.deepEqual(JSON.parse(harness.requests[0].opts.body), { notes: "solid" });
  assert.equal(harness.deps.state.planReveal, null);
  assert.equal(harness.deps.state.brief.read.kind, "done");
  assert.deepEqual(plain(harness.cachedWrites), [{
    key: "today:session:2026-06-30",
    data: {
      id: 44,
      date: "2026-06-30",
      finished_at: "2026-06-30T15:00:00Z",
      sets: [
        { exercise: "Push-up", weight: 20, reps: 8 },
        { exercise: "Push-up", weight: 20, reps: 8 },
      ],
    },
  }]);
  assert.deepEqual(harness.invalidations, ["stats", "history:sessions"]);
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.renders.length, 1);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), ["Done · 2 sets · 320 lb"]);
});

test("Today session controller queues finish when the network drops", async () => {
  const harness = loadController({
    apiImpl: async () => {
      throw new Error("offline");
    },
  });
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  surface.appendChild(new FakeElement("input", { id: "sessNotes", value: "felt strong but tired" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));

  harness.controller.wireSessionSurface({
    session: { id: 44, date: "2026-06-30", sets: [{ exercise: "Push-up" }] },
    hasLoggedSets: true,
  }, harness.deps);
  finish.click();
  await flushAsync();

  assert.equal(harness.requests[0].path, "/sessions/44/finish");
  assert.deepEqual(plain(harness.outbox), [{
    kind: "finish",
    path: "/sessions/44/finish",
    body: { notes: "felt strong but tired" },
  }]);
  assert.equal(finish.disabled, false);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), ["Finish saved — will sync when you're back online"]);
  assert.deepEqual(harness.cachedWrites, []);
  assert.deepEqual(harness.invalidations, []);
});

test("Today session controller times out a hung finish and queues it with the typed notes", async () => {
  // A flaky radio can leave the finish POST hanging forever (api() only arms its
  // safety timeout for GETs). The controller's own ~15s AbortController must abort
  // the call so it falls into the same offline outbox path a thrown fetch takes.
  let fireFinishTimeout = null;
  const harness = loadController({
    // Never resolves on its own — only rejects when the finish AbortController fires.
    apiImpl: (_path, opts) => new Promise((_resolve, reject) => {
      const signal = opts && opts.signal;
      if (signal) signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
    contextOverrides: {
      AbortController,
      clearTimeout: () => {},
      setTimeout: (fn) => { fireFinishTimeout = fn; return 1; },
    },
  });
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  surface.appendChild(new FakeElement("input", { id: "sessNotes", value: "heavy pulls, felt great" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));

  harness.controller.wireSessionSurface({
    session: { id: 44, date: "2026-06-30", sets: [{ exercise: "Push-up" }] },
    hasLoggedSets: false,
  }, harness.deps);
  finish.click();
  await flushAsync();

  // The POST is in flight (hung): nothing queued yet and the button stays disabled.
  assert.equal(harness.requests[0].path, "/sessions/44/finish");
  assert.equal(harness.outbox.length, 0);
  assert.equal(finish.disabled, true);

  // The 15s timeout fires → abort → api rejects → the offline path runs.
  assert.equal(typeof fireFinishTimeout, "function", "the finish timeout was armed");
  fireFinishTimeout();
  await flushAsync();

  assert.deepEqual(plain(harness.outbox), [{
    kind: "finish",
    path: "/sessions/44/finish",
    body: { notes: "heavy pulls, felt great" },
  }]);
  assert.equal(finish.disabled, false);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), ["Finish saved — will sync when you're back online"]);
});

test("Today session controller restores a notes draft into an empty input and clears it on finish", async () => {
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  // A note drafted during a session that never finished (e.g. a reload) is keyed by
  // log date and must be restored into the empty input on the next render.
  store.set("cairn.sessnotes.2026-06-30", "draft that survived a reload");

  const harness = loadController({
    apiImpl: async (path) => path === "/sessions/44/finish"
      ? { id: 44, date: "2026-06-30", sets: [], summary: { sets: 1, tonnage: 100 } }
      : { ok: true },
    contextOverrides: { localStorage },
  });
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  const notes = surface.appendChild(new FakeElement("input", { id: "sessNotes", value: "" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));

  harness.controller.wireSessionSurface({
    session: { id: 44, date: "2026-06-30", sets: [{ exercise: "Push-up" }] },
    hasLoggedSets: false,
  }, harness.deps);

  // The empty input is seeded from the saved draft.
  assert.equal(notes.value, "draft that survived a reload");

  // Typing persists the latest value under the date key.
  notes.value = "updated mid-session";
  notes.dispatch("input");
  assert.equal(store.get("cairn.sessnotes.2026-06-30"), "updated mid-session");

  // A clean finish clears the draft — it has done its job.
  finish.click();
  await flushAsync();
  assert.equal(harness.requests[0].path, "/sessions/44/finish");
  assert.equal(store.has("cairn.sessnotes.2026-06-30"), false);
});

test("Today session controller skips, undoes, and removes off-plan cards", async () => {
  const harness = loadController();
  const plan = harness.rootEl.appendChild(new FakeElement("article", { className: "ex", dataset: { card: "Squat" } }));
  const skip = plan.appendChild(new FakeElement("button", { className: "ex-skip", dataset: { skip: encodeURIComponent("Squat") } }));
  const addex = harness.rootEl.appendChild(new FakeElement("div", { className: "addex" }));
  const line = harness.rootEl.appendChild(new FakeElement("div", { id: "skipLine", className: "skipline skipline-empty" }));
  const names = line.appendChild(new FakeElement("span", { className: "skipline-names" }));

  harness.controller.wireSkips(harness.deps);
  skip.click();
  await flushAsync();

  assert.equal(plan.isConnected, false);
  assert.equal(names.querySelectorAll("[data-unskip]").length, 1);
  assert.equal(line.classList.contains("skipline-empty"), false);
  assert.deepEqual(plain(harness.renders), [{ soft: true }]);
  assert.equal(harness.toasts.at(-1).options.action, "Undo");

  harness.toasts.at(-1).options.onAction();
  await flushAsync();

  assert.equal(plan.isConnected, true);
  assert.equal(harness.rootEl.children.indexOf(plan) < harness.rootEl.children.indexOf(addex), true);
  assert.equal(harness.expands[0], plan);
  assert.equal(names.querySelectorAll("[data-unskip]").length, 0);

  harness.deps.state.pendingOffPlan["2026-06-30"] = [{ name: "Curl" }, { name: "Lunge" }];
  const offPlan = harness.rootEl.appendChild(new FakeElement("article", { className: "ex", dataset: { card: "Curl" } }));
  const remove = offPlan.appendChild(new FakeElement("button", { className: "ex-skip", dataset: { removeCard: "" } }));
  harness.controller.wireSkips(harness.deps);
  remove.click();

  assert.equal(offPlan.isConnected, false);
  assert.deepEqual(plain(harness.deps.state.pendingOffPlan["2026-06-30"]), [{ name: "Lunge" }]);
});

test("Today session controller saves feedback and merges the returned row", async () => {
  const harness = loadController();
  const slot = harness.rootEl.appendChild(new FakeElement("div", { id: "feedbackSlot" }));
  const session = { id: 44, date: "2026-06-30" };

  harness.controller.renderFeedback(slot, session, harness.deps);
  slot.querySelector("#feedbackOpen").click();
  slot.querySelector(".feel-dot[data-feel=\"soreness\"]").click();
  await flushAsync();

  assert.equal(harness.requests[0].path, "/sessions/2026-06-30/feedback");
  assert.deepEqual(JSON.parse(harness.requests[0].opts.body), { soreness: 1, joint_pain: null });
  assert.equal(session.soreness, 2);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), ["Noted"]);
});

// ---- "beat this" last-set quiet target line (lastSetScore / lastSetLineText / wireLastSetLine) ----

test("lastSetLineText formats every weight encoding and appends a humanized date", () => {
  const harness = loadController();
  const { setModel, deps } = harness;
  const date = isoDaysAgo(3);

  assert.equal(setModel.lastSetLineText({ weight: 165, reps: 10, date }, deps), "Last time: 165 × 10 · 3 days ago");
  assert.equal(setModel.lastSetLineText({ weight: null, reps: 12, date }, deps), "Last time: 12 reps · 3 days ago");
  assert.equal(setModel.lastSetLineText({ weight: -30, reps: 8, date }, deps), "Last time: -30 lb assist × 8 · 3 days ago");
  assert.equal(setModel.lastSetLineText({ duration_sec: 90, date }, deps), "Last time: 90s · 3 days ago");
});

test("lastSetLineText omits the date suffix when absent and renders nothing for missing/malformed data", () => {
  const harness = loadController();
  const { setModel, deps } = harness;

  assert.equal(setModel.lastSetLineText({ weight: 100, reps: 5 }, deps), "Last time: 100 × 5");
  assert.equal(setModel.lastSetLineText(null, deps), "");
  assert.equal(setModel.lastSetLineText(undefined, deps), "");
  assert.equal(setModel.lastSetLineText({}, deps), "");
  assert.equal(setModel.lastSetLineText({ weight: "not-a-number", reps: 5 }, deps), "");
});

test("lastSetScore compares timed/loaded/bodyweight/assisted sets on the same scale as progress history", () => {
  const harness = loadController();
  const { setModel } = harness;

  assert.equal(setModel.lastSetScore(165, 10, null), 165 * (1 + 10 / 30));
  assert.equal(setModel.lastSetScore(null, 12, null), 12);
  assert.equal(setModel.lastSetScore(-30, 8, null), 8);
  assert.equal(setModel.lastSetScore(null, null, 90), 90);
  // duration_sec wins even if weight/reps are also present (defensive — shouldn't happen).
  assert.equal(setModel.lastSetScore(999, 999, 45), 45);
});

test("wireLastSetLine swaps the quiet line for a sage affirmation once the typed set beats last time, and back", async () => {
  const harness = loadController();
  const { card, row } = addLoggingCard(harness.rootEl);
  const line = addLastSetLine(card, "Last time: 165 × 10 · last week");
  row.querySelector(".in-w").value = "165";
  row.querySelector(".in-r").value = "10";

  harness.setModel.wireLastSetLine(row, { weight: 165, reps: 10, date: "2026-06-30" }, harness.deps);

  assert.equal(line.textContent, "Last time: 165 × 10 · last week");
  assert.equal(line.classList.contains("ex-lastset-beat"), false);

  row.querySelector(".in-r").value = "11";
  row.querySelector(".in-r").dispatch("input");
  assert.equal(line.textContent, "That beats last time");
  assert.equal(line.classList.contains("ex-lastset-beat"), true);

  row.querySelector(".in-r").value = "10";
  row.querySelector(".in-r").dispatch("input");
  assert.equal(line.textContent, "Last time: 165 × 10 · last week");
  assert.equal(line.classList.contains("ex-lastset-beat"), false);
});

test("wireLastSetLine handles bodyweight/assisted reps-only comparisons and timed durations", () => {
  const harness = loadController();

  // Bodyweight: more reps at no added weight beats last time.
  {
    const { card, row } = addLoggingCard(harness.rootEl);
    const line = addLastSetLine(card, "Last time: 12 reps · last week");
    row.querySelector(".in-w").value = "";
    row.querySelector(".in-r").value = "12";
    harness.setModel.wireLastSetLine(row, { weight: null, reps: 12, date: "2026-06-30" }, harness.deps);
    row.querySelector(".in-r").value = "13";
    row.querySelector(".in-r").dispatch("input");
    assert.equal(line.classList.contains("ex-lastset-beat"), true);
  }

  // Timed: a longer hold beats last time; a shorter one does not.
  {
    const rootEl = new FakeElement("section");
    const card = rootEl.appendChild(new FakeElement("article", { className: "ex" }));
    const row = card.appendChild(new FakeElement("div", { className: "logrow", dataset: { ex: "Plank", day: "1", mode: "timed" } }));
    const durEl = row.appendChild(new FakeElement("input", { className: "in-dur", value: "90" }));
    row.appendChild(new FakeElement("button", { className: "logbtn" }));
    const line = addLastSetLine(card, "Last time: 1:30 · last week");
    harness.setModel.wireLastSetLine(row, { duration_sec: 90, date: "2026-06-30" }, harness.deps);

    durEl.value = "100";
    durEl.dispatch("input");
    assert.equal(line.classList.contains("ex-lastset-beat"), true);

    durEl.value = "80";
    durEl.dispatch("input");
    assert.equal(line.classList.contains("ex-lastset-beat"), false);
  }
});

test("wireLastSetLine is a no-op without last-set data and wires each row only once", () => {
  const harness = loadController();
  const { card, row } = addLoggingCard(harness.rootEl);
  const line = addLastSetLine(card, "Last time: 165 × 10 · last week");

  // No lastSet -> nothing wired, typing never flips the class.
  harness.setModel.wireLastSetLine(row, null, harness.deps);
  row.querySelector(".in-r").value = "50";
  row.querySelector(".in-r").dispatch("input");
  assert.equal(line.classList.contains("ex-lastset-beat"), false);
  assert.equal(line.dataset.wired, undefined);

  // Wiring twice with real data only attaches listeners once (idempotent guard).
  harness.setModel.wireLastSetLine(row, { weight: 165, reps: 10, date: "2026-06-30" }, harness.deps);
  const firstWireListenerCount = row.querySelector(".in-r").listeners.get("input").length;
  harness.setModel.wireLastSetLine(row, { weight: 165, reps: 10, date: "2026-06-30" }, harness.deps);
  assert.equal(row.querySelector(".in-r").listeners.get("input").length, firstWireListenerCount);
});

test("Today session controller wires each row's last-time line automatically from wireSessionSurface's lastSets map", () => {
  const harness = loadController();
  const { card, row } = addLoggingCard(harness.rootEl);
  const line = addLastSetLine(card, "Last time: 165 × 10 · last week");
  row.querySelector(".in-w").value = "165";
  row.querySelector(".in-r").value = "10";

  harness.controller.wireSessionSurface({
    session: { id: 44, date: "2026-06-30", sets: [] },
    hasLoggedSets: false,
    lastSets: { "Push-up": { weight: 165, reps: 10, date: "2026-06-30" } },
  }, harness.deps);

  assert.equal(line.classList.contains("ex-lastset-beat"), false);

  row.querySelector(".in-r").value = "11";
  row.querySelector(".in-r").dispatch("input");
  assert.equal(line.textContent, "That beats last time");
  assert.equal(line.classList.contains("ex-lastset-beat"), true);
});

test("Today session controller's lastSets wiring is a no-op for an exercise missing last-set data", () => {
  const harness = loadController();
  const { card, row } = addLoggingCard(harness.rootEl);
  const line = addLastSetLine(card, "Last time: 165 × 10 · last week");

  harness.controller.wireSessionSurface({
    session: { id: 44, date: "2026-06-30", sets: [] },
    hasLoggedSets: false,
    lastSets: {},
  }, harness.deps);

  row.querySelector(".in-r").value = "50";
  row.querySelector(".in-r").dispatch("input");
  assert.equal(line.classList.contains("ex-lastset-beat"), false);
  assert.equal(line.dataset.wired, undefined);
});
