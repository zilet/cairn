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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function flushAsync() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
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
    this.open = false;
    this.disabled = false;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this._innerHTML = "";
    this.focusCount = 0;
    this.scrollCount = 0;
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
    if (this._innerHTML.includes("data-movement-area")) {
      this.appendChild(new FakeElement("input", { dataset: { movementArea: "" } }));
    }
    for (const match of this._innerHTML.matchAll(/<button[^>]*data-movement-outcome="([^"]+)"[^>]*>/g)) {
      const tag = match[0];
      this.appendChild(new FakeElement("button", {
        dataset: {
          movementOutcome: match[1],
          ...(tag.match(/data-symptom-id="([^"]+)"/)?.[1]
            ? { symptomId: tag.match(/data-symptom-id="([^"]+)"/)[1] }
            : {}),
          ...(tag.match(/data-symptom-area="([^"]+)"/)?.[1]
            ? { symptomArea: decodeAttr(tag.match(/data-symptom-area="([^"]+)"/)[1]) }
            : {}),
        },
      }));
    }
    for (const key of ["movement-ease", "movement-stop", "movement-skip", "movement-alternatives"]) {
      if (this._innerHTML.includes(`data-${key}`)) {
        const dataKey = key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
        this.appendChild(new FakeElement("button", { dataset: { [dataKey]: "" } }));
      }
    }
    if (this._innerHTML.includes("data-movement-show")) {
      this.appendChild(new FakeElement("button", { dataset: { movementShow: "" } }));
    }
    for (const match of this._innerHTML.matchAll(/<button[^>]*data-movement-alternative="([^"]+)"[^>]*>/g)) {
      this.appendChild(new FakeElement("button", {
        dataset: { movementAlternative: decodeAttr(match[1]) },
      }));
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

  dispatchEvent(event) {
    this.dispatch(event.type, event);
    return true;
  }

  click() {
    this.dispatch("click");
  }

  focus() {
    this.focusCount += 1;
  }

  scrollIntoView() {
    this.scrollCount += 1;
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
    if (selector === ".in-w, .in-dur, .in-r") {
      return this.classList.contains("in-w") || this.classList.contains("in-dur") || this.classList.contains("in-r");
    }
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
    const dataOnly = selector.match(/^\[data-([a-z0-9-]+)\]$/i);
    if (dataOnly) {
      const key = dataOnly[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      return Object.hasOwn(this.dataset, key);
    }
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
  let mutationSeq = 0;
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
    escHtml: escapeHtml,
    escAttr: escapeAttr,
    window: null,
    globalThis: null,
    navigator: {},
    outboxEnqueue: (kind, path, body, options) => {
      const item = {
        kind,
        path,
        body,
        ...(options?.method === "DELETE" ? { method: "DELETE" } : {}),
        ...(options?.dependsOn ? { depends_on: options.dependsOn } : {}),
        ...(options?.groupId ? { group_id: options.groupId } : {}),
      };
      outbox.push(item);
      return item;
    },
    document: {
      createElement: (tag) => tag === "template" ? new FakeTemplate() : new FakeElement(tag),
    },
    setTimeout: (fn) => fn(),
  };
  context.window = context;
  context.globalThis = context;
  context.runSessionMutation = async (input, send) => {
    const identity = input.identity || {};
    const groupId = identity.sessionId != null
      ? `session:${identity.sessionId}`
      : identity.dailySessionId != null
        ? `daily:${identity.dailySessionId}`
        : `date:${input.date}`;
    const idempotencyKey = `test-mutation-${++mutationSeq}`;
    const blocked = (prerequisite) => ({
      status: "blocked",
      reason: prerequisite.reason || "phantom",
      prerequisiteId: prerequisite.id || null,
      groupId,
    });
    let prerequisite = context.outboxSessionPrerequisite?.(input.date) || { status: "none", id: null };
    if (prerequisite.status === "blocked") return blocked(prerequisite);
    const queue = async (dependsOn) => {
      const item = await context.outboxEnqueue(input.kind, input.path, input.body, {
        dependsOn,
        groupId,
        method: input.method,
      });
      return item ? { status: "queued", item, groupId } : { status: "storage_error", groupId };
    };
    if (prerequisite.status === "ready") return queue(prerequisite.id);
    if (outbox.some((item) => item.group_id === groupId)) return queue(null);
    try {
      return { status: "sent", value: await send(idempotencyKey), groupId };
    } catch (error) {
      const classify = context.CairnApiCache?.isTransientApiFailure;
      if (typeof classify === "function" && !classify(error)) return { status: "failed", error, groupId };
      prerequisite = context.outboxSessionPrerequisite?.(input.date) || { status: "none", id: null };
      if (prerequisite.status === "blocked") return blocked(prerequisite);
      return queue(prerequisite.status === "ready" ? prerequisite.id : null);
    }
  };
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
    feedback: context.CairnTodaySessionFeedback,
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

function addTimedLoggingCard(rootEl, duration = "90") {
  const card = rootEl.appendChild(new FakeElement("article", { className: "ex", dataset: { card: "Plank" } }));
  const row = card.appendChild(new FakeElement("div", {
    className: "logrow",
    dataset: { ex: encodeURIComponent("Plank"), day: "1", mode: "timed" },
  }));
  const durationEl = row.appendChild(new FakeElement("input", { className: "in-dur", value: duration }));
  const timer = row.appendChild(new FakeElement("button", { className: "timerbtn", dataset: { stopwatchState: "idle" }, textContent: "Start" }));
  const button = row.appendChild(new FakeElement("button", { className: "logbtn" }));
  const logged = card.appendChild(new FakeElement("div", { dataset: { logged: "" } }));
  card.appendChild(new FakeElement("div", { dataset: { prog: "" }, textContent: "0 / 3 sets" }));
  rootEl.appendChild(new FakeElement("div", { dataset: { finishstat: "" } }));
  return { card, row, durationEl, timer, button, logged };
}

// The per-card movement check, its stop markers and its alternatives flow are gone
// with the rest of the pain mini-UIs. A card asks for a set, nothing else; what the
// athlete wants to say about how it felt goes in words the extraction lane reads.
// trainingSymptomSurfaces.test.js asserts the markup and the fetches are absent.

test("timed logging stopwatch starts from zero, uses an absolute clock, resumes, pauses for log, and cleans detached rows", async () => {
  let now = 100_000;
  let timerId = 0;
  const intervals = new Map();
  function FakeDate(...args) {
    return new Date(...(args.length ? args : [now]));
  }
  FakeDate.now = () => now;
  const harness = loadController({
    contextOverrides: {
      Date: FakeDate,
      Event: class FakeEvent {
        constructor(type, options = {}) {
          this.type = type;
          this.bubbles = Boolean(options.bubbles);
        }
      },
      setInterval: (fn) => {
        const id = ++timerId;
        intervals.set(id, fn);
        return id;
      },
      clearInterval: (id) => intervals.delete(id),
    },
    apiImpl: async (path, opts) => {
      if (path === "/sets" && opts?.method === "POST") return { ok: true, id: 12, set_number: 1, duration_sec: 6 };
      return { ok: true };
    },
  });
  const { row, durationEl, timer, button } = addTimedLoggingCard(harness.rootEl);
  harness.deps.parseDur = (value) => Number(String(value).replace(/s$/, "")) || null;
  harness.controller.wireLogRow(row, harness.deps);

  timer.click();
  assert.equal(durationEl.value, "0s");
  assert.equal(timer.textContent, "Stop");
  assert.equal(timer.ariaLabel, "Stop Plank stopwatch");
  assert.equal(timer.ariaPressed, "true");
  now += 3_700;
  [...intervals.values()].forEach((tick) => tick());
  assert.equal(durationEl.value, "3s", "elapsed comes from the clock, not tick count");

  timer.click();
  assert.equal(timer.textContent, "Resume");
  now += 20_000;
  assert.equal(durationEl.value, "3s", "a paused stopwatch does not advance");
  timer.click();
  now += 2_300;
  [...intervals.values()].forEach((tick) => tick());
  assert.equal(durationEl.value, "6s", "resume retains the prior fractional second");

  now += 1_100;
  button.click();
  await flushAsync();
  assert.equal(JSON.parse(harness.requests[0].opts.body).duration_sec, 7, "logging preserves accumulated milliseconds before payload parsing");
  assert.equal(timer.textContent, "Start");
  assert.equal(timer.dataset.stopwatchState, "idle");
  assert.equal(timer.ariaPressed, "false");
  assert.equal(intervals.size, 0, "successful logging resets the stopwatch interval");

  timer.click();
  assert.equal(intervals.size, 1);
  row.remove();
  [...intervals.values()].forEach((tick) => tick());
  assert.equal(intervals.size, 0, "a detached row clears its own interval");
});

test("timed stopwatch updates the last-time line and only lets one timed row run", () => {
  let now = 200_000;
  let timerId = 0;
  const intervals = new Map();
  function FakeDate(...args) {
    return new Date(...(args.length ? args : [now]));
  }
  FakeDate.now = () => now;
  const harness = loadController({
    contextOverrides: {
      Date: FakeDate,
      Event: class FakeEvent {
        constructor(type, options = {}) { this.type = type; this.bubbles = Boolean(options.bubbles); }
      },
      setInterval: (fn) => { const id = ++timerId; intervals.set(id, fn); return id; },
      clearInterval: (id) => intervals.delete(id),
    },
  });
  const first = addTimedLoggingCard(harness.rootEl);
  const second = addTimedLoggingCard(harness.rootEl);
  harness.deps.parseDur = (value) => Number(String(value).replace(/s$/, "")) || null;
  const line = addLastSetLine(first.card, "Last time: 0:05 · last week");
  harness.setModel.wireLastSetLine(first.row, { duration_sec: 5, date: "2026-06-30" }, harness.deps);
  harness.controller.wireLogRow(first.row, harness.deps);
  harness.controller.wireLogRow(second.row, harness.deps);

  first.timer.click();
  now += 6_100;
  [...intervals.values()].forEach((tick) => tick());
  assert.equal(line.textContent, "That beats last time", "stopwatch display changes notify the existing last-set listener");

  second.timer.click();
  assert.equal(first.timer.textContent, "Resume", "starting a second hold pauses the first");
  assert.equal(first.durationEl.value, "6s");
  assert.equal(second.timer.textContent, "Stop");
  assert.equal(harness.stops.length, 2, "each newly started hold stops the rest countdown");
});

test("a queued timed log keeps the captured duration paused and resumable", async () => {
  let now = 300_000;
  let timerId = 0;
  const intervals = new Map();
  function FakeDate(...args) {
    return new Date(...(args.length ? args : [now]));
  }
  FakeDate.now = () => now;
  const harness = loadController({
    apiImpl: async () => { throw new Error("offline"); },
    contextOverrides: {
      Date: FakeDate,
      Event: class FakeEvent {
        constructor(type, options = {}) { this.type = type; this.bubbles = Boolean(options.bubbles); }
      },
      CairnApiCache: { isTransientApiFailure: () => true },
      setInterval: (fn) => { const id = ++timerId; intervals.set(id, fn); return id; },
      clearInterval: (id) => intervals.delete(id),
    },
  });
  const { row, durationEl, timer, button } = addTimedLoggingCard(harness.rootEl);
  harness.deps.parseDur = (value) => Number(String(value).replace(/s$/, "")) || null;
  harness.controller.wireLogRow(row, harness.deps);

  timer.click();
  now += 3_200;
  [...intervals.values()].forEach((tick) => tick());
  button.click();
  await flushAsync();
  assert.equal(harness.outbox.length, 1);
  assert.equal(durationEl.value, "3s");
  assert.equal(timer.textContent, "Resume");

  timer.click();
  now += 2_100;
  [...intervals.values()].forEach((tick) => tick());
  assert.equal(durationEl.value, "5s");
});

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

test("Today session controller does not poison the outbox on a permanent set rejection", async () => {
  const permanent = new Error("validation");
  const harness = loadController({
    apiImpl: async () => { throw permanent; },
    contextOverrides: { CairnApiCache: { isTransientApiFailure: (error) => error !== permanent } },
  });
  const { row, button, logged } = addLoggingCard(harness.rootEl);

  harness.controller.wireLogRow(row, harness.deps);
  button.click();
  await flushAsync();

  assert.equal(harness.outbox.length, 0);
  assert.equal(logged.children.length, 0);
  assert.equal(row.querySelector(".in-w").value, "20", "typed set values remain available to correct");
  assert.equal(row.querySelector(".in-r").value, "8");
  assert.equal(button.disabled, false);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), ["Couldn't log that set."]);
});

test("offline set logging carries the current staged prepare dependency", async () => {
  const harness = loadController({
    apiImpl: async () => { throw new Error("offline"); },
    contextOverrides: {
      outboxSessionPrerequisite: () => ({ status: "ready", id: "prepare-local-1" }),
    },
  });
  const { row, button } = addLoggingCard(harness.rootEl);

  harness.controller.wireLogRow(row, harness.deps);
  button.click();
  await flushAsync();

  assert.deepEqual(plain(harness.outbox), [{
    kind: "set",
    path: "/sets",
    body: { exercise: "Push-up", weight: 20, reps: 8, rir: 2, day_number: 1, date: "2026-06-30" },
    depends_on: "prepare-local-1",
    group_id: "date:2026-06-30",
  }]);
});

test("a reloaded staged session queues its new set behind reconciliation before any direct POST", async () => {
  const harness = loadController({
    apiImpl: async () => { throw new Error("direct set POST must not run before reconciliation"); },
    contextOverrides: {
      outboxSessionPrerequisite: () => ({ status: "ready", id: "prepare-reload-1" }),
    },
  });
  const { row, button } = addLoggingCard(harness.rootEl);

  harness.controller.wireLogRow(row, harness.deps);
  button.click();
  await flushAsync();

  assert.deepEqual(harness.requests, []);
  assert.deepEqual(plain(harness.outbox), [{
    kind: "set",
    path: "/sets",
    body: { exercise: "Push-up", weight: 20, reps: 8, rir: 2, day_number: 1, date: "2026-06-30" },
    depends_on: "prepare-reload-1",
    group_id: "date:2026-06-30",
  }]);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), ["Set saved — reconciling this session"]);
});

test("cross-tab prepare barriers prevent direct set and finish POSTs in every shared queue state", async () => {
  for (const state of ["pending", "prepared", "needs_attention"]) {
    const prerequisite = () => ({ status: "blocked", id: `prepare-${state}`, reason: "other_tab" });
    const setHarness = loadController({
      apiImpl: async () => { throw new Error("direct set POST must stay blocked"); },
      contextOverrides: { outboxSessionPrerequisite: prerequisite },
    });
    const { row, button } = addLoggingCard(setHarness.rootEl);
    setHarness.controller.wireLogRow(row, setHarness.deps);
    button.click();
    await flushAsync();

    assert.deepEqual(setHarness.requests, [], `${state} set barrier made no direct request`);
    assert.deepEqual(setHarness.outbox, []);
    assert.deepEqual(setHarness.toasts.map((toast) => toast.message), [
      "This session is being prepared in another tab or view — refresh before logging more sets.",
    ]);

    const finishHarness = loadController({
      apiImpl: async () => { throw new Error("direct finish POST must stay blocked"); },
      contextOverrides: { outboxSessionPrerequisite: prerequisite },
    });
    const surface = finishHarness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
    surface.appendChild(new FakeElement("input", { id: "sessNotes", value: "saved note" }));
    const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));
    finishHarness.controller.wireSessionSurface({
      session: { id: 44, date: "2026-06-30", sets: [{ exercise: "Push-up" }] },
      hasLoggedSets: true,
    }, finishHarness.deps);
    finish.click();
    await flushAsync();

    assert.deepEqual(finishHarness.requests, [], `${state} finish barrier made no direct request`);
    assert.deepEqual(finishHarness.outbox, []);
    assert.deepEqual(finishHarness.toasts.map((toast) => toast.message), [
      "This session is being prepared in another tab or view — refresh before finishing.",
    ]);
  }
});

test("focused Session finishes with the real ID created by its first set without rewiring", async () => {
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sets" && opts?.method === "POST") {
        return { id: 10, session_id: 88, set_number: 1, weight: 20, reps: 8, rir: 2 };
      }
      if (path === "/sessions/88/finish" && opts?.method === "POST") {
        return {
          id: 88,
          date: "2026-06-30",
          finished_at: "2026-06-30T15:00:00Z",
          sets: [{ exercise: "Push-up", weight: 20, reps: 8 }],
          summary: { sets: 1, tonnage: 160 },
        };
      }
      throw new Error(`unexpected request: ${opts?.method || "GET"} ${path}`);
    },
  });
  harness.deps.state.tab = "session";
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  surface.appendChild(new FakeElement("textarea", { id: "sessNotes", value: "focused session" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));
  const { button } = addLoggingCard(harness.rootEl);

  // Focused Session deliberately has a Finish control before a session row exists.
  harness.controller.wireSessionSurface({ session: null, hasLoggedSets: true }, harness.deps);
  button.click();
  await flushAsync();
  finish.click();
  await flushAsync();

  assert.deepEqual(harness.requests.map((request) => request.path), ["/sets", "/sessions/88/finish"]);
  assert.equal(harness.requests.every((request) => /^test-mutation-\d+$/.test(request.opts.headers["X-Idempotency-Key"])), true);
  assert.notEqual(
    harness.requests[0].opts.headers["X-Idempotency-Key"],
    harness.requests[1].opts.headers["X-Idempotency-Key"],
  );
  assert.equal(harness.requests.some((request) => request.path.includes("/sessions//")), false);
  assert.equal(harness.outbox.length, 0);
  assert.equal(harness.deps.state.brief.read.kind, "done");
});

test("focused Session finishes with the real ID created by its first skip", async () => {
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sessions/skip" && opts?.method === "POST") {
        return { ok: true, session_id: 89, date: "2026-06-30", exercise: "Squat", skips: ["Squat"] };
      }
      if (path === "/sessions/89/finish" && opts?.method === "POST") {
        return {
          id: 89,
          date: "2026-06-30",
          finished_at: "2026-06-30T15:00:00Z",
          sets: [],
          summary: { sets: 0, tonnage: 0 },
        };
      }
      throw new Error(`unexpected request: ${opts?.method || "GET"} ${path}`);
    },
  });
  harness.deps.state.tab = "session";
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));
  const card = harness.rootEl.appendChild(new FakeElement("article", { className: "ex", dataset: { card: "Squat" } }));
  const skip = card.appendChild(new FakeElement("button", {
    className: "ex-skip",
    dataset: { skip: encodeURIComponent("Squat") },
  }));

  harness.controller.wireSessionSurface({ session: null, hasLoggedSets: true }, harness.deps);
  skip.click();
  await flushAsync();
  finish.click();
  await flushAsync();

  assert.deepEqual(harness.requests.map((request) => request.path), ["/sessions/skip", "/sessions/89/finish"]);
  assert.equal(harness.requests.every((request) => /^test-mutation-\d+$/.test(request.opts.headers["X-Idempotency-Key"])), true);
  assert.equal(harness.requests.some((request) => request.path.includes("/sessions//")), false);
});

test("focused Session never posts or queues a malformed finish when no real session ID exists", async () => {
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sessions?date=2026-06-30" && !opts?.method) return null;
      throw new Error(`unexpected request: ${opts?.method || "GET"} ${path}`);
    },
    contextOverrides: { localStorage },
  });
  harness.deps.state.tab = "session";
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  const notes = surface.appendChild(new FakeElement("textarea", { id: "sessNotes", value: "keep this note" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));

  harness.controller.wireSessionSurface({ session: null, hasLoggedSets: true }, harness.deps);
  finish.click();
  await flushAsync();
  await flushAsync(); // recovery GET + controller continuation

  assert.deepEqual(harness.requests.map((request) => request.path), ["/sessions?date=2026-06-30"]);
  assert.equal(harness.requests.some((request) => request.opts?.method === "POST"), false);
  assert.equal(harness.requests.some((request) => request.path.includes("/sessions//")), false);
  assert.equal(harness.outbox.length, 0);
  assert.equal(notes.value, "keep this note");
  assert.equal(store.get("cairn.sessnotes.2026-06-30"), "keep this note");
  assert.equal(finish.disabled, false);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), ["Session isn't ready yet — your note is saved"]);
  assert.equal(harness.setModel.sessionPathId({}, harness.deps, "2026-06-30"), null);
  assert.equal(harness.setModel.sessionPathId({ id: 0 }, harness.deps, "2026-06-30"), null);
});

test("focused Session recovers the session created by an offline replay before finishing", async () => {
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sessions?date=2026-06-30" && !opts?.method) {
        return { id: 90, date: "2026-06-30", sets: [{ exercise: "Push-up" }] };
      }
      if (path === "/sessions/90/finish" && opts?.method === "POST") {
        return {
          id: 90,
          date: "2026-06-30",
          finished_at: "2026-06-30T15:00:00Z",
          sets: [{ exercise: "Push-up" }],
          summary: { sets: 1, tonnage: 160 },
        };
      }
      throw new Error(`unexpected request: ${opts?.method || "GET"} ${path}`);
    },
  });
  harness.deps.state.tab = "session";
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));

  harness.controller.wireSessionSurface({ session: null, hasLoggedSets: true }, harness.deps);
  finish.click();
  await flushAsync();
  await flushAsync();

  assert.deepEqual(harness.requests.map((request) => request.path), [
    "/sessions?date=2026-06-30",
    "/sessions/90/finish",
  ]);
  assert.equal(harness.cachedWrites[0].key, "today:session:2026-06-30");
});

test("remembered session IDs are isolated by date", () => {
  const harness = loadController();
  harness.setModel.rememberMutationSessionId(harness.deps, "2026-06-30", { session_id: 91, id: 10 });

  assert.equal(harness.setModel.sessionPathId({}, harness.deps, "2026-06-30"), "91");
  harness.deps.state.logDate = "2026-07-01";
  assert.equal(harness.setModel.sessionPathId({}, harness.deps, "2026-07-01"), null);
});

test("set mutation IDs never masquerade as session IDs when session_id is absent", async () => {
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sets" && opts?.method === "POST") {
        return { id: 10, date: "2026-06-30", set_number: 1, weight: 20, reps: 8, rir: 2 };
      }
      if (path === "/sessions?date=2026-06-30" && !opts?.method) {
        return { id: 93, date: "2026-06-30", sets: [{ exercise: "Push-up" }] };
      }
      if (path === "/sessions/93/finish" && opts?.method === "POST") {
        return {
          id: 93,
          date: "2026-06-30",
          finished_at: "2026-06-30T15:00:00Z",
          sets: [{ exercise: "Push-up" }],
          summary: { sets: 1, tonnage: 160 },
        };
      }
      throw new Error(`unexpected request: ${opts?.method || "GET"} ${path}`);
    },
  });
  harness.deps.state.tab = "session";
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));
  const { button } = addLoggingCard(harness.rootEl);

  harness.controller.wireSessionSurface({ session: null, hasLoggedSets: true }, harness.deps);
  button.click();
  await flushAsync();
  finish.click();
  await flushAsync();
  await flushAsync();

  assert.deepEqual(harness.requests.map((request) => request.path), [
    "/sets",
    "/sessions?date=2026-06-30",
    "/sessions/93/finish",
  ]);
  assert.equal(harness.requests.some((request) => request.path === "/sessions/10/finish"), false);
});

test("an in-flight set response stays scoped to its request date after navigation", async () => {
  let resolveSet;
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sets" && opts?.method === "POST") {
        return new Promise((resolve) => { resolveSet = resolve; });
      }
      throw new Error(`unexpected request: ${opts?.method || "GET"} ${path}`);
    },
  });
  const { row, button, logged } = addLoggingCard(harness.rootEl);
  harness.controller.wireLogRow(row, harness.deps);

  button.click();
  await flushAsync();
  assert.equal(JSON.parse(harness.requests[0].opts.body).date, "2026-06-30");
  harness.deps.state.logDate = "2026-07-01";
  resolveSet({
    id: 10,
    session_id: 94,
    date: "2026-06-30",
    set_number: 1,
    weight: 20,
    reps: 8,
    rir: 2,
  });
  await flushAsync();

  assert.equal(harness.deps.state.sessionIdsByDate["2026-06-30"], "94");
  assert.equal(harness.deps.state.sessionIdsByDate["2026-07-01"], undefined);
  assert.equal(harness.setModel.sessionPathId({}, harness.deps, "2026-07-01"), null);
  assert.equal(logged.children.length, 0);
  assert.deepEqual(harness.invalidations, []);
  assert.deepEqual(harness.toasts, []);
  assert.deepEqual(harness.starts, []);
});

test("an in-flight skip response cannot mutate the next date's surface", async () => {
  let resolveSkip;
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sessions/skip" && opts?.method === "POST") {
        return new Promise((resolve) => { resolveSkip = resolve; });
      }
      throw new Error(`unexpected request: ${opts?.method || "GET"} ${path}`);
    },
  });
  const card = harness.rootEl.appendChild(new FakeElement("article", { className: "ex", dataset: { card: "Squat" } }));
  const skip = card.appendChild(new FakeElement("button", {
    className: "ex-skip",
    dataset: { skip: encodeURIComponent("Squat") },
  }));
  harness.controller.wireSkips(harness.deps);

  skip.click();
  await flushAsync();
  assert.deepEqual(JSON.parse(harness.requests[0].opts.body), { date: "2026-06-30", exercise: "Squat" });
  harness.deps.state.logDate = "2026-07-01";
  resolveSkip({ ok: true, session_id: 95, date: "2026-06-30", exercise: "Squat", skips: ["Squat"] });
  await flushAsync();

  assert.equal(harness.deps.state.sessionIdsByDate["2026-06-30"], "95");
  assert.equal(harness.deps.state.sessionIdsByDate["2026-07-01"], undefined);
  assert.equal(card.isConnected, true);
  assert.deepEqual(harness.invalidations, []);
  assert.deepEqual(harness.collapses, []);
  assert.deepEqual(harness.toasts, []);
  assert.deepEqual(harness.renders, []);
});

test("in-flight recovery never finishes or caches its session after the date changes", async () => {
  let resolveRecovery;
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sessions?date=2026-06-30" && !opts?.method) {
        return new Promise((resolve) => { resolveRecovery = resolve; });
      }
      throw new Error(`unexpected request: ${opts?.method || "GET"} ${path}`);
    },
    contextOverrides: { localStorage },
  });
  harness.deps.state.tab = "session";
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  surface.appendChild(new FakeElement("textarea", { id: "sessNotes", value: "keep on A" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));
  harness.controller.wireSessionSurface({ session: null, hasLoggedSets: true }, harness.deps);

  finish.click();
  await flushAsync();
  harness.deps.state.logDate = "2026-07-01";
  resolveRecovery({ id: 96, date: "2026-06-30", sets: [{ exercise: "Push-up" }] });
  await flushAsync();
  await flushAsync();

  assert.deepEqual(harness.requests.map((request) => request.path), ["/sessions?date=2026-06-30"]);
  assert.equal(harness.deps.state.sessionIdsByDate["2026-06-30"], "96");
  assert.equal(harness.deps.state.sessionIdsByDate["2026-07-01"], undefined);
  assert.deepEqual(harness.cachedWrites, []);
  assert.deepEqual(harness.invalidations, []);
  assert.deepEqual(harness.toasts, []);
  assert.equal(store.get("cairn.sessnotes.2026-06-30"), "keep on A");
  assert.equal(store.has("cairn.sessnotes.2026-07-01"), false);
});

test("session recovery rejects a full-session row for a different date", async () => {
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sessions?date=2026-06-30" && !opts?.method) {
        return { id: 97, date: "2026-07-01", sets: [{ exercise: "Push-up" }] };
      }
      throw new Error(`unexpected request: ${opts?.method || "GET"} ${path}`);
    },
  });
  harness.deps.state.tab = "session";
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));
  harness.controller.wireSessionSurface({ session: null, hasLoggedSets: true }, harness.deps);

  finish.click();
  await flushAsync();
  await flushAsync();

  assert.deepEqual(harness.requests.map((request) => request.path), ["/sessions?date=2026-06-30"]);
  assert.equal(harness.deps.state.sessionIdsByDate?.["2026-06-30"], undefined);
  assert.equal(harness.deps.state.sessionIdsByDate?.["2026-07-01"], undefined);
  assert.deepEqual(harness.cachedWrites, []);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), ["Session isn't ready yet — your note is saved"]);
});

test("an in-flight finish response cannot cache or repaint under the next date", async () => {
  let resolveFinish;
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sessions/44/finish" && opts?.method === "POST") {
        return new Promise((resolve) => { resolveFinish = resolve; });
      }
      throw new Error(`unexpected request: ${opts?.method || "GET"} ${path}`);
    },
  });
  harness.deps.state.tab = "session";
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));
  harness.controller.wireSessionSurface({
    session: { id: 44, date: "2026-06-30", sets: [{ exercise: "Push-up" }] },
    hasLoggedSets: true,
  }, harness.deps);

  finish.click();
  await flushAsync();
  harness.deps.state.logDate = "2026-07-01";
  harness.deps.state.brief = { headline: "July 1" };
  resolveFinish({
    id: 44,
    date: "2026-06-30",
    finished_at: "2026-06-30T15:00:00Z",
    sets: [{ exercise: "Push-up" }],
    summary: { sets: 1, tonnage: 160 },
  });
  await flushAsync();

  assert.deepEqual(harness.requests.map((request) => request.path), ["/sessions/44/finish"]);
  assert.deepEqual(plain(harness.deps.state.brief), { headline: "July 1" });
  assert.deepEqual(harness.cachedWrites, []);
  assert.deepEqual(harness.invalidations, []);
  assert.deepEqual(harness.toasts, []);
  assert.deepEqual(harness.renders, []);
  assert.deepEqual(harness.stops, []);
});

test("an in-flight reopen response cannot reopen or cache under the next date", async () => {
  let resolveReopen;
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sessions/44/reopen" && opts?.method === "POST") {
        return new Promise((resolve) => { resolveReopen = resolve; });
      }
      throw new Error(`unexpected request: ${opts?.method || "GET"} ${path}`);
    },
  });
  harness.deps.state.tab = "session";
  harness.deps.state.planReveal = { date: "2026-06-30", on: false };
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  const reopen = surface.appendChild(new FakeElement("button", { id: "reopenBtn" }));
  harness.controller.wireSessionSurface({
    session: { id: 44, date: "2026-06-30", finished_at: "2026-06-30T15:00:00Z" },
    hasLoggedSets: true,
  }, harness.deps);

  reopen.click();
  await flushAsync();
  harness.deps.state.logDate = "2026-07-01";
  harness.deps.state.brief = { headline: "July 1" };
  harness.deps.state.planReveal = { date: "2026-07-01", on: false };
  resolveReopen({ id: 44, date: "2026-06-30", finished_at: null, sets: [] });
  await flushAsync();

  assert.deepEqual(plain(harness.deps.state.brief), { headline: "July 1" });
  assert.deepEqual(plain(harness.deps.state.planReveal), { date: "2026-07-01", on: false });
  assert.deepEqual(harness.cachedWrites, []);
  assert.deepEqual(harness.invalidations, []);
  assert.deepEqual(harness.toasts, []);
  assert.deepEqual(harness.renders, []);
  assert.deepEqual(harness.transitions, []);
});

test("a failed session recovery keeps the note and never poisons the finish outbox", async () => {
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  const harness = loadController({
    apiImpl: async () => { throw new Error("offline"); },
    contextOverrides: { localStorage },
  });
  harness.deps.state.tab = "session";
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  surface.appendChild(new FakeElement("textarea", { id: "sessNotes", value: "offline note" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));

  harness.controller.wireSessionSurface({ session: null, hasLoggedSets: true }, harness.deps);
  finish.click();
  await flushAsync();
  await flushAsync();

  assert.deepEqual(harness.requests.map((request) => request.path), ["/sessions?date=2026-06-30"]);
  assert.equal(harness.outbox.length, 0);
  assert.equal(store.get("cairn.sessnotes.2026-06-30"), "offline note");
  assert.equal(finish.disabled, false);
});

test("Finish fails safe while the first set is still in flight, then adopts it on retry", async () => {
  let resolveSet;
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  const harness = loadController({
    apiImpl: async (path, opts) => {
      if (path === "/sets" && opts?.method === "POST") {
        return new Promise((resolve) => { resolveSet = resolve; });
      }
      if (path === "/sessions?date=2026-06-30" && !opts?.method) return null;
      if (path === "/sessions/92/finish" && opts?.method === "POST") {
        return {
          id: 92,
          date: "2026-06-30",
          finished_at: "2026-06-30T15:00:00Z",
          sets: [{ exercise: "Push-up" }],
          summary: { sets: 1, tonnage: 160 },
        };
      }
      throw new Error(`unexpected request: ${opts?.method || "GET"} ${path}`);
    },
    contextOverrides: { localStorage },
  });
  harness.deps.state.tab = "session";
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  surface.appendChild(new FakeElement("textarea", { id: "sessNotes", value: "race-safe note" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));
  const { button } = addLoggingCard(harness.rootEl);

  harness.controller.wireSessionSurface({ session: null, hasLoggedSets: true }, harness.deps);
  button.click();
  await flushAsync();
  finish.click();
  await flushAsync();
  await flushAsync();

  assert.deepEqual(harness.requests.map((request) => request.path), ["/sets", "/sessions?date=2026-06-30"]);
  assert.equal(harness.outbox.length, 0);
  assert.equal(store.get("cairn.sessnotes.2026-06-30"), "race-safe note");
  assert.equal(finish.disabled, false);

  resolveSet({ id: 10, session_id: 92, set_number: 1, weight: 20, reps: 8, rir: 2 });
  await flushAsync();
  await flushAsync();
  finish.click();
  await flushAsync();

  assert.equal(harness.requests.at(-1).path, "/sessions/92/finish");
  assert.equal(harness.requests.some((request) => request.path.includes("/sessions//")), false);
});

test("Reopen leaves the current UI intact when ID recovery or the POST fails", async () => {
  const missing = loadController({ apiImpl: async () => null });
  missing.deps.state.planReveal = { date: "2026-06-30", on: false };
  const missingBrief = missing.deps.state.brief;
  const missingSurface = missing.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  const missingReopen = missingSurface.appendChild(new FakeElement("button", { id: "reopenBtn" }));
  missing.controller.wireSessionSurface({ session: null, hasLoggedSets: false }, missing.deps);
  missingReopen.click();
  await flushAsync();
  await flushAsync();

  assert.equal(missing.deps.state.brief, missingBrief);
  assert.deepEqual(plain(missing.deps.state.planReveal), { date: "2026-06-30", on: false });
  assert.equal(missing.renders.length, 0);
  assert.equal(missing.transitions.length, 0);
  assert.equal(missingReopen.disabled, false);

  const rejected = loadController({ apiImpl: async () => { throw new Error("offline"); } });
  rejected.deps.state.planReveal = { date: "2026-06-30", on: false };
  const rejectedBrief = rejected.deps.state.brief;
  const rejectedSurface = rejected.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  const rejectedReopen = rejectedSurface.appendChild(new FakeElement("button", { id: "reopenBtn" }));
  rejected.controller.wireSessionSurface({ session: { id: 44 }, hasLoggedSets: false }, rejected.deps);
  rejectedReopen.click();
  await flushAsync();

  assert.deepEqual(rejected.requests.map((request) => request.path), ["/sessions/44/reopen"]);
  assert.equal(rejected.deps.state.brief, rejectedBrief);
  assert.deepEqual(plain(rejected.deps.state.planReveal), { date: "2026-06-30", on: false });
  assert.equal(rejected.renders.length, 0);
  assert.equal(rejected.transitions.length, 0);
  assert.equal(rejectedReopen.disabled, false);
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
    contextOverrides: {
      outboxSessionPrerequisite: () => ({ status: "ready", id: "prepare-local-1" }),
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

  assert.deepEqual(harness.requests, []);
  assert.deepEqual(plain(harness.outbox), [{
    kind: "finish",
    path: "/sessions/44/finish",
    body: { notes: "felt strong but tired" },
    depends_on: "prepare-local-1",
    group_id: "session:44",
  }]);
  assert.equal(finish.disabled, false);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), ["Finish saved — reconciling this session"]);
  assert.deepEqual(harness.cachedWrites, []);
  assert.deepEqual(harness.invalidations, []);
});

test("Today session controller reports when a transient finish cannot be stored locally", async () => {
  const harness = loadController({
    apiImpl: async () => { throw new Error("offline"); },
    contextOverrides: { outboxEnqueue: () => null },
  });
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  surface.appendChild(new FakeElement("input", { id: "sessNotes", value: "keep this note" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));

  harness.controller.wireSessionSurface({
    session: { id: 44, date: "2026-06-30", sets: [{ exercise: "Push-up" }] },
    hasLoggedSets: true,
  }, harness.deps);
  finish.click();
  await flushAsync();

  assert.equal(finish.disabled, false);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), [
    "Couldn’t save that finish on this device — free storage and try again.",
  ]);
});

test("Today set logging reports when a transient set cannot be stored locally", async () => {
  const harness = loadController({
    apiImpl: async () => { throw new Error("offline"); },
    contextOverrides: { outboxEnqueue: () => null },
  });
  const { row, button, logged } = addLoggingCard(harness.rootEl);
  harness.controller.wireLogRow(row, harness.deps);

  button.click();
  await flushAsync();

  assert.equal(button.disabled, false);
  assert.equal(logged.children.length, 0);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), [
    "Couldn’t save that set on this device — free storage and try again.",
  ]);
});

test("Today session controller keeps finish notes and skips the outbox on a permanent rejection", async () => {
  const permanent = new Error("missing session");
  const harness = loadController({
    apiImpl: async () => { throw permanent; },
    contextOverrides: { CairnApiCache: { isTransientApiFailure: (error) => error !== permanent } },
  });
  const surface = harness.rootEl.appendChild(new FakeElement("div", { className: "plansurface" }));
  const notes = surface.appendChild(new FakeElement("input", { id: "sessNotes", value: "do not lose this" }));
  const finish = surface.appendChild(new FakeElement("button", { id: "finishBtn" }));

  harness.controller.wireSessionSurface({
    session: { id: 44, date: "2026-06-30", sets: [{ exercise: "Push-up" }] },
    hasLoggedSets: true,
  }, harness.deps);
  finish.click();
  await flushAsync();

  assert.equal(harness.outbox.length, 0);
  assert.equal(notes.value, "do not lose this");
  assert.equal(finish.disabled, false);
  assert.deepEqual(harness.toasts.map((toast) => toast.message), ["Couldn't finish that session"]);
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
    group_id: "session:44",
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

  assert.deepEqual(harness.requests.map((request) => request.opts.method), ["POST", "DELETE"]);
  assert.equal(harness.requests.every((request) => /^test-mutation-\d+$/.test(request.opts.headers["X-Idempotency-Key"])), true);
  assert.notEqual(
    harness.requests[0].opts.headers["X-Idempotency-Key"],
    harness.requests[1].opts.headers["X-Idempotency-Key"],
  );
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

test("same-tab staged skip and restore queue behind preparation without a direct request", async () => {
  const harness = loadController({
    apiImpl: async () => { throw new Error("staged skip/restore must not POST directly"); },
    contextOverrides: {
      outboxSessionPrerequisite: () => ({ status: "ready", id: "prepare-local-1" }),
    },
  });
  const plan = harness.rootEl.appendChild(new FakeElement("article", {
    className: "ex",
    dataset: { card: "Squat" },
  }));
  const skip = plan.appendChild(new FakeElement("button", {
    className: "ex-skip",
    dataset: { skip: encodeURIComponent("Squat") },
  }));
  harness.rootEl.appendChild(new FakeElement("div", { className: "addex" }));
  const line = harness.rootEl.appendChild(new FakeElement("div", {
    id: "skipLine",
    className: "skipline skipline-empty",
  }));
  line.appendChild(new FakeElement("span", { className: "skipline-names" }));

  harness.controller.wireSkips(harness.deps);
  skip.click();
  await flushAsync();
  assert.deepEqual(harness.requests, []);
  assert.deepEqual(plain(harness.outbox), [{
    kind: "skip",
    path: "/sessions/skip",
    body: { date: "2026-06-30", exercise: "Squat" },
    depends_on: "prepare-local-1",
    group_id: "date:2026-06-30",
  }]);
  assert.equal(plan.isConnected, false);

  harness.toasts.at(-1).options.onAction();
  await flushAsync();
  assert.deepEqual(harness.requests, []);
  assert.deepEqual(plain(harness.outbox), [
    {
      kind: "skip",
      path: "/sessions/skip",
      body: { date: "2026-06-30", exercise: "Squat" },
      depends_on: "prepare-local-1",
      group_id: "date:2026-06-30",
    },
    {
      kind: "restore",
      path: "/sessions/skip",
      body: { date: "2026-06-30", exercise: "Squat" },
      method: "DELETE",
      depends_on: "prepare-local-1",
      group_id: "date:2026-06-30",
    },
  ]);
  assert.equal(plan.isConnected, true);
});

test("cross-tab prepare states block direct skip and restore with refresh guidance", async () => {
  for (const state of ["pending", "prepared", "needs_attention"]) {
    const harness = loadController({
      apiImpl: async () => { throw new Error("cross-tab barrier must prevent direct mutation"); },
      contextOverrides: {
        outboxSessionPrerequisite: () => ({
          status: "blocked",
          id: `prepare-${state}`,
          reason: "other_tab",
        }),
      },
    });
    const plan = harness.rootEl.appendChild(new FakeElement("article", { className: "ex" }));
    const skip = plan.appendChild(new FakeElement("button", {
      className: "ex-skip",
      dataset: { skip: encodeURIComponent("Squat") },
    }));
    const line = harness.rootEl.appendChild(new FakeElement("div", { id: "skipLine", className: "skipline" }));
    const names = line.appendChild(new FakeElement("span", { className: "skipline-names" }));
    const restore = names.appendChild(new FakeElement("button", {
      dataset: { unskip: encodeURIComponent("Bench") },
    }));

    harness.controller.wireSkips(harness.deps);
    skip.click();
    await flushAsync();
    line.dispatch("click", { target: restore });
    await flushAsync();

    assert.deepEqual(harness.requests, [], state);
    assert.deepEqual(harness.outbox, [], state);
    assert.equal(plan.isConnected, true);
    assert.equal(restore.isConnected, true);
    assert.deepEqual(harness.toasts.map((toast) => toast.message), [
      "This session is being prepared in another tab or view — refresh before skipping.",
      "This session is being prepared in another tab or view — refresh before restoring.",
    ]);
  }
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
