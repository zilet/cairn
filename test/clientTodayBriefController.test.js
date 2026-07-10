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

function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function loadController(opts = {}) {
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
  const openSessions = [];
  let composerCount = 0;
  const rootEl = new FakeElement("section");
  const context = {
    Array,
    Object,
    Number,
    Promise,
    String,
    JSON,
    URLSearchParams,
    HTMLElement: FakeElement,
    HTMLButtonElement: FakeElement,
    openSession: () => { openSessions.push(true); },
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
      briefHtml: (read, briefOpts) => `<section class="brief">${read?.headline || "Today"}:${briefOpts.activeOverride || ""}</section>`,
      materiallyDiffers: (a, b) => {
        if (!a || !b) return true;
        const str = (v) => (v == null ? "" : String(v).trim());
        return str(a.kind) !== str(b.kind) || str(a.headline) !== str(b.headline)
          || str(a.why) !== str(b.why) || str(a.focus) !== str(b.focus)
          || Number(a.est_minutes || 0) !== Number(b.est_minutes || 0);
      },
      signalsText: () => "signals",
    },
  };
  if (opts.localStorage) context.localStorage = opts.localStorage;
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
    openSessions,
    get composerCount() { return composerCount; },
  };
}

test("Today Brief controller revalidates same-date memory without blocking the screen", async () => {
  const harness = loadController();

  const read = await harness.controller.loadBrief("2026-07-01", "", harness.deps);
  const cached = await harness.controller.loadBrief("2026-07-01", "rough night", harness.deps);

  assert.equal(read.headline, "Easy day");
  assert.deepEqual(plain(cached), plain(read));
  assert.deepEqual(harness.apiCalls, [
    "/today-read?date=2026-07-01&agent=auto",
    "/today-read?date=2026-07-01&agent=auto&override=rough+night",
  ]);
  assert.deepEqual(plain(harness.deps.state.brief), {
    date: "2026-07-01",
    override: "rough night",
    read: plain(read),
  });

  const fallback = await harness.controller.loadBrief("fallback", "", harness.deps);
  assert.equal(fallback._provisional, true);
  assert.equal(fallback.kind, "train");
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
  // start-session now opens the isolated Session destination (no inline reveal/scroll).
  assert.deepEqual(harness.openSessions, [true]);
  assert.deepEqual(harness.reveals, []);
  assert.deepEqual(plain(surface.scrolls), []);
  assert.equal(harness.runOps[0].kind, "day_read_override");
  assert.deepEqual(plain(harness.runOps[0].body), { date: "2026-07-01", override: "short on time", agent: "auto" });
  assert.equal(brief.attributes.get("aria-busy"), "true");

  const handlers = harness.controller.reconnectDayReadOverride({ input: { override: "short on time" } }, harness.deps);
  handlers.onDone({ kind: "train", headline: "Short lift", why: "", focus: "push", signals: {} });

  assert.equal(harness.deps.state.brief.read.headline, "Short lift");
  assert.equal(harness.transitions.length, 1);
  assert.equal(harness.asks[0].minutes, 30);
});

test("loadBrief fast mode paints the last-known real read instantly and reconciles behind it", async () => {
  const ls = fakeLocalStorage();
  const cachedRead = { kind: "easy", headline: "Cached easy read", why: "recover", focus: "walk", est_minutes: 20, signals: {} };
  ls.setItem("cairn.brief.v1", JSON.stringify({ date: "2026-07-01", read: cachedRead }));
  const harness = loadController({ localStorage: ls });

  const read = await harness.controller.loadBrief("2026-07-01", "", harness.deps, { fast: true });

  // Instant real paint from the cache — no invented placeholder.
  assert.equal(read._provisional, undefined);
  assert.equal(read._cached, true);
  assert.equal(read.headline, "Cached easy read");
  // The network fetch still fires and is parked for the silent post-render reconcile.
  assert.equal(harness.deps.state._briefInflight?.date, "2026-07-01");
  assert.deepEqual(harness.apiCalls, ["/today-read?date=2026-07-01&agent=auto"]);
});

test("loadBrief fast mode never paints a cache entry from a different date", async () => {
  const ls = fakeLocalStorage();
  ls.setItem("cairn.brief.v1", JSON.stringify({ date: "2026-06-30", read: { kind: "easy", headline: "Yesterday", signals: {} } }));
  const harness = loadController({ localStorage: ls });

  const read = await harness.controller.loadBrief("2026-07-01", "", harness.deps, { fast: true });

  // Cache is for a prior day → not used; the fetch resolves instantly here so we get the real read.
  assert.notEqual(read.headline, "Yesterday");
  assert.notEqual(read._cached, true);
});

test("loadBrief fast mode ignores the cache for an override steer", async () => {
  const ls = fakeLocalStorage();
  ls.setItem("cairn.brief.v1", JSON.stringify({ date: "2026-07-01", read: { kind: "rest", headline: "Cached rest read", signals: {} } }));
  const harness = loadController({ localStorage: ls });

  const read = await harness.controller.loadBrief("2026-07-01", "rough night", harness.deps, { fast: true });

  // Cache is bypassed for an override steer (never painted, never overwritten); the
  // override read is fetched fresh. (In this harness setTimeout is synchronous so
  // the 1200ms guard wins the race → a provisional placeholder + a parked fetch.)
  assert.notEqual(read._cached, true);
  assert.ok(harness.apiCalls[0].includes("override=rough+night"));
  assert.equal(harness.deps.state._briefInflight?.override, "rough night");
  assert.equal(JSON.parse(ls.getItem("cairn.brief.v1")).read.headline, "Cached rest read");
});

test("loadBrief persists a real canonical read but not a provisional or override read", async () => {
  const ls = fakeLocalStorage();
  const harness = loadController({ localStorage: ls });

  await harness.controller.loadBrief("2026-07-02", "", harness.deps);
  const stored = JSON.parse(ls.getItem("cairn.brief.v1"));
  assert.equal(stored.date, "2026-07-02");
  assert.equal(stored.read.headline, "Easy day");
  assert.equal(stored.read._cached, undefined);
  assert.equal(stored.read._provisional, undefined);

  // A fetch that fails (provisional) must not clobber the good cache.
  await harness.controller.loadBrief("fallback", "", harness.deps);
  assert.equal(JSON.parse(ls.getItem("cairn.brief.v1")).date, "2026-07-02");

  // An override read must not clobber the canonical cache either.
  await harness.controller.loadBrief("2026-07-03", "rough night", harness.deps);
  assert.equal(JSON.parse(ls.getItem("cairn.brief.v1")).date, "2026-07-02");
});

test("upgradeBriefInPlace flashes thinking for a provisional paint but reconciles a cached paint silently", async () => {
  // Provisional placeholder → visible thinking animation before the swap.
  const prov = loadController({ localStorage: fakeLocalStorage() });
  prov.deps.reducedMotion = () => false;
  const provBrief = prov.rootEl.appendChild(new FakeElement("section", { className: "brief" }));
  let resolveProv;
  const provPromise = new Promise((resolve) => { resolveProv = resolve; });
  prov.deps.state.brief = { date: prov.deps.state.logDate, override: "", read: { kind: "train", headline: "Today", _provisional: true } };
  prov.deps.state._briefInflight = { date: prov.deps.state.logDate, override: "", promise: provPromise };
  const provDone = prov.controller.upgradeBriefInPlace(prov.deps.state.logDate, true, prov.deps);
  assert.equal(provBrief.classList.contains("is-thinking"), true);
  resolveProv({ kind: "train", headline: "Upper day", why: "ready", _provisional: false });
  await provDone;

  // Cached paint → silent reconcile, NO thinking flash.
  const cachedHarness = loadController({ localStorage: fakeLocalStorage() });
  cachedHarness.deps.reducedMotion = () => false;
  const cachedBrief = cachedHarness.rootEl.appendChild(new FakeElement("section", { className: "brief" }));
  let resolveCached;
  const cachedPromise = new Promise((resolve) => { resolveCached = resolve; });
  const shownRead = { kind: "train", headline: "Upper day", why: "ready", focus: null, est_minutes: 45 };
  cachedHarness.deps.state.brief = { date: cachedHarness.deps.state.logDate, override: "", read: { ...shownRead, _cached: true } };
  cachedHarness.deps.state._briefInflight = { date: cachedHarness.deps.state.logDate, override: "", promise: cachedPromise };
  const cachedDone = cachedHarness.controller.upgradeBriefInPlace(cachedHarness.deps.state.logDate, true, cachedHarness.deps);
  assert.equal(cachedBrief.classList.contains("is-thinking"), false);
  resolveCached({ ...shownRead }); // identical → no DOM churn
  await cachedDone;

  // Fresh read adopted into state (flag dropped) and the element was never swapped.
  assert.equal(!!cachedHarness.deps.state.brief.read._cached, false);
  assert.equal(cachedHarness.rootEl.querySelector(".brief") === cachedBrief, true);
});

test("a completed-state upgrade repaints all of Today so stale Start controls disappear", async () => {
  const harness = loadController({ localStorage: fakeLocalStorage() });
  const brief = harness.rootEl.appendChild(new FakeElement("section", { className: "brief" }));
  let resolveRead;
  const promise = new Promise((resolve) => { resolveRead = resolve; });
  harness.deps.state.brief = {
    date: harness.deps.state.logDate,
    override: "",
    read: { kind: "train", headline: "Easy long run", why: "Go run", _cached: true },
  };
  harness.deps.state._briefInflight = { date: harness.deps.state.logDate, override: "", promise };

  const done = harness.controller.upgradeBriefInPlace(harness.deps.state.logDate, true, harness.deps);
  resolveRead({ kind: "done", headline: "Long run done", why: "The work is in", focus: null, est_minutes: null });
  await done;

  assert.deepEqual(plain(harness.renders), [{ soft: true }]);
  assert.equal(harness.deps.state.brief.read.kind, "done");
  assert.equal(brief.classList.contains("is-thinking"), false);
});
