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

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
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
    if (selector === "[data-runleg]") return Object.hasOwn(this.dataset, "runleg");
    if (selector === "[data-redirect]") return Object.hasOwn(this.dataset, "redirect");
    if (selector === "[data-steerreset]") return Object.hasOwn(this.dataset, "steerreset");
    if (selector === "[data-briefwhy]") return Object.hasOwn(this.dataset, "briefwhy");
    if (selector === "[data-tradetomorrow]") return Object.hasOwn(this.dataset, "tradetomorrow");
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
    openSession: (date, options) => { openSessions.push({ date, options }); return Promise.resolve(true); },
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
      kind: (read) => String(read?.kind || "train"),
      updatedInnerHtml: (read) => `stamp:${read?.computed_at || ""}`,
    },
  };
  if (opts.localStorage) context.localStorage = opts.localStorage;
  if (opts.extraContext) Object.assign(context, opts.extraContext);
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-open-session-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-override-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-actions-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-cache-client.js"), "utf8"), context);
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
    context,
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
  assert.equal(harness.openSessions.length, 1);
  assert.equal(harness.openSessions[0].options.source, "adaptive_plan");
  assert.equal(harness.openSessions[0].options.provenance.entry, "brief_start");
  assert.equal(harness.openSessions[0].options.trigger, start);
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

test("upgradeBriefInPlace treats the session launch card as a live entry (no duplicate Log-training ask)", async () => {
  const harness = loadController({ localStorage: fakeLocalStorage() });
  const brief = harness.rootEl.appendChild(new FakeElement("section", { className: "brief" }));
  // Today renders the showPlan state as the LAUNCH card (.sess-launch), never
  // .plansurface — the DOM-derived options must recognize it or a same-kind 'done'
  // upgrade re-renders the brief believing nothing below offers an entry.
  harness.rootEl.appendChild(new FakeElement("div", { className: "sess-launch" }));
  const seen = [];
  // The controller's internal wrapper calls the CairnTodayBrief GLOBAL (not a dep) —
  // intercept it on the sandbox context to observe the options it derives.
  harness.context.CairnTodayBrief.briefHtml = (read, briefOpts) => {
    seen.push({ showPlan: briefOpts.showPlan, showDone: briefOpts.showDone });
    return `<section class="brief">${read?.headline || "Today"}</section>`;
  };
  const done = { kind: "done", headline: "Done for today", why: "", focus: null, est_minutes: null, signals: {} };
  harness.deps.state.brief = { date: harness.deps.state.logDate, override: "", read: done };
  harness.deps.state._briefInflight = {
    date: harness.deps.state.logDate,
    override: "",
    // Same kind (in-place path), fresher sentence (an identical read reconciles
    // silently and never re-renders — which would make this test vacuous).
    promise: Promise.resolve({ ...done, headline: "Strong push, warm run." }),
  };

  await harness.controller.upgradeBriefInPlace(harness.deps.state.logDate, true, harness.deps);

  assert.equal(seen.length, 1, "same-kind upgrade re-renders in place");
  assert.equal(seen[0].showPlan, true, "the launch card counts as an existing entry");
  assert.equal(brief.parentNode == null || harness.rootEl.querySelector(".brief") != null, true);
});

test("upgradeBriefInPlace reuses the nothingToStart witness today-screen.ts persisted on state", async () => {
  const harness = loadController({ localStorage: fakeLocalStorage() });
  harness.rootEl.appendChild(new FakeElement("section", { className: "brief" }));
  // No .plansurface / .sess-launch in the DOM — a genuinely empty plan day.
  const seen = [];
  harness.context.CairnTodayBrief.briefHtml = (read, briefOpts) => {
    seen.push(!!briefOpts.nothingToStart);
    return `<section class="brief">${read?.headline || "Today"}</section>`;
  };
  const train = { kind: "train", headline: "Push day", why: "", focus: null, est_minutes: null, signals: {} };
  harness.deps.state.brief = { date: harness.deps.state.logDate, override: "", read: train };
  harness.deps.state.nothingToStart = true;
  harness.deps.state._briefInflight = {
    date: harness.deps.state.logDate,
    override: "",
    promise: Promise.resolve({ ...train, headline: "Push day, freshly read." }),
  };

  await harness.controller.upgradeBriefInPlace(harness.deps.state.logDate, true, harness.deps);
  assert.deepEqual(seen, [true], "an empty day carries the witness through to the in-place repaint");

  // The same day now has something to launch (the last full render set the
  // witness to false) — the in-place repaint must follow it, not a stale true.
  seen.length = 0;
  harness.deps.state.nothingToStart = false;
  harness.deps.state._briefInflight = {
    date: harness.deps.state.logDate,
    override: "",
    promise: Promise.resolve({ ...train, headline: "Push day, read again." }),
  };
  await harness.controller.upgradeBriefInPlace(harness.deps.state.logDate, true, harness.deps);
  assert.deepEqual(seen, [false]);
});

test("upgradeBriefInPlace adopts a terminally-failed fetch so the shimmer doesn't return on the next render", async () => {
  const harness = loadController({ localStorage: fakeLocalStorage() });
  harness.deps.reducedMotion = () => false;
  const brief = harness.rootEl.appendChild(new FakeElement("section", { className: "brief" }));
  let resolveRead;
  const promise = new Promise((resolve) => { resolveRead = resolve; });
  // Nothing real cached yet — what's painted right now IS the placeholder.
  const placeholder = { kind: "train", headline: "Today", why: "", focus: null, est_minutes: null, signals: {}, source: "deterministic", _provisional: true };
  harness.deps.state.brief = { date: harness.deps.state.logDate, override: "", read: placeholder };
  harness.deps.state._briefInflight = { date: harness.deps.state.logDate, override: "", promise };

  const done = harness.controller.upgradeBriefInPlace(harness.deps.state.logDate, true, harness.deps);
  // Mirrors loadBrief's fetchRead fallback: a terminal failure still resolves to
  // provisional fallback content, now flagged _failed.
  resolveRead({ ...placeholder, _failed: true });
  await done;

  assert.equal(brief.classList.contains("is-thinking"), false);
  // The failed flag is adopted into state so a later renderToday()/briefHtml()
  // call sees `_failed` and does not re-add the shimmer.
  assert.equal(harness.deps.state.brief.read._failed, true);
  assert.equal(harness.deps.state.brief.read._provisional, true);
});

test("upgradeBriefInPlace keeps a good cached read on a failed refetch instead of adopting the failure", async () => {
  const harness = loadController({ localStorage: fakeLocalStorage() });
  harness.deps.reducedMotion = () => false;
  harness.rootEl.appendChild(new FakeElement("section", { className: "brief" }));
  let resolveRead;
  const promise = new Promise((resolve) => { resolveRead = resolve; });
  const cachedRead = { kind: "easy", headline: "Cached easy read", why: "recover", focus: "walk", est_minutes: 20, signals: {}, _cached: true };
  harness.deps.state.brief = { date: harness.deps.state.logDate, override: "", read: cachedRead };
  harness.deps.state._briefInflight = { date: harness.deps.state.logDate, override: "", promise };

  const done = harness.controller.upgradeBriefInPlace(harness.deps.state.logDate, true, harness.deps);
  resolveRead({ kind: "train", headline: "Today", why: "", focus: null, est_minutes: null, signals: {}, source: "deterministic", _provisional: true, _failed: true });
  await done;

  // The cached, already-true content stands — never clobbered by a failed refetch.
  assert.equal(harness.deps.state.brief.read.headline, "Cached easy read");
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

// ---- the freshness stamp is patched, not deferred (Finding 6, controller half) ----

test("a recompute that moved only the stamp patches that one node and leaves the sentence alone", async () => {
  const harness = loadController();
  const shown = {
    kind: "easy",
    headline: "Keep it light",
    why: "Load has been stacking.",
    focus: null,
    est_minutes: 20,
    signals: {},
    computed_at: "2026-03-15T08:00:00.000Z",
    _cached: true,
  };
  const fresh = { ...shown, computed_at: "2026-03-15T11:39:00.000Z", _cached: false };

  const brief = harness.rootEl.appendChild(new FakeElement("section", { className: "brief" }));
  const stamp = brief.appendChild(new FakeElement("div", { className: "brief-updated" }));
  stamp.innerHTML = "stamp:2026-03-15T08:00:00.000Z";

  harness.deps.state.brief = { date: "2026-07-01", override: "", read: shown };
  harness.deps.state._briefInflight = { date: "2026-07-01", override: "", promise: Promise.resolve(fresh) };

  await harness.controller.upgradeBriefInPlace("2026-07-01", true, harness.deps);

  assert.equal(stamp.innerHTML, "stamp:2026-03-15T11:39:00.000Z");
  // The Brief itself was not rewritten: same node, no settle animation, no recount.
  assert.equal(harness.rootEl.children[0], brief);
  assert.deepEqual(harness.countUps, []);
  assert.equal(harness.deps.state.brief.read.computed_at, "2026-03-15T11:39:00.000Z");
});

// ---- the plan day's own name reaches the Brief (Finding 10) ----

test("briefHtml resolves the plan-day name from the read's own plan selection", () => {
  const harness = loadController();
  const seen = [];
  harness.context.CairnTodayBrief.briefHtml = (read, opts) => {
    seen.push(opts.planDayName);
    return `<section class="brief">${read?.headline || ""}</section>`;
  };
  harness.deps.state.plan = [
    { day_number: 1, name: "Push", items: [] },
    { day_number: 2, name: "Pull", items: [] },
  ];

  harness.controller.briefHtml(
    { kind: "easy", headline: "Easy", signals: { plan_selection: { selected: { day_number: 2 } } } },
    { isToday: true },
    harness.deps
  );
  // No selection in the read: the surface's own selected day is the fallback.
  harness.deps.state.day = 1;
  harness.controller.briefHtml({ kind: "easy", headline: "Easy", signals: {} }, { isToday: true }, harness.deps);
  // A day number that is not in the loaded plan names nothing at all.
  harness.deps.state.day = 9;
  harness.controller.briefHtml({ kind: "easy", headline: "Easy", signals: {} }, { isToday: true }, harness.deps);

  assert.deepEqual(seen, ["Pull", "Push", ""]);
});

test("briefHtml forwards nothingToStart through to CairnTodayBrief.briefHtml's options", () => {
  const harness = loadController();
  const seen = [];
  harness.context.CairnTodayBrief.briefHtml = (read, opts) => {
    seen.push(!!opts.nothingToStart);
    return `<section class="brief">${read?.headline || ""}</section>`;
  };

  harness.controller.briefHtml({ kind: "train", headline: "Train" }, { isToday: true, nothingToStart: true }, harness.deps);
  harness.controller.briefHtml({ kind: "train", headline: "Train" }, { isToday: true, nothingToStart: false }, harness.deps);
  harness.controller.briefHtml({ kind: "train", headline: "Train" }, { isToday: true }, harness.deps);

  assert.deepEqual(seen, [true, false, false]);
});

// ---- the rest trade (Finding 4's button) ----

// The trade handler is async through a fetch and a view transition; drain the
// microtask queue rather than guessing how many turns that is.
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function tradeHarness(respond, extra = {}) {
  const harness = loadController(extra);
  const brief = harness.rootEl.appendChild(new FakeElement("section", { className: "brief" }));
  const button = brief.appendChild(new FakeElement("button", { dataset: { tradetomorrow: "" } }));
  const posts = [];
  harness.deps.api = async (path, opts) => {
    posts.push({ path, opts });
    return respond();
  };
  harness.controller.wireBrief({ kind: "easy", headline: "Easy", focus: null, signals: {} }, { isToday: true }, harness.deps);
  return { harness, brief, button, posts };
}

test("the rest trade POSTs today's date and repaints from the read the server hands back", async () => {
  const traded = { kind: "train", headline: "Pull day", why: "You traded tomorrow.", focus: "Pull", signals: {} };
  const { harness, brief, button, posts } = tradeHarness(() => ({ ok: true, read: traded }));

  button.click();
  await flush();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/today-read/trade-rest");
  assert.equal(posts[0].opts.method, "POST");
  assert.deepEqual(JSON.parse(posts[0].opts.body), { date: "2026-07-01" });
  assert.equal(harness.deps.state.brief.read.headline, "Pull day");
  assert.equal(harness.transitions.length, 1);
  assert.equal(brief.children.includes(button), true, "a trade that landed keeps its button until the repaint");
});

test("the rest trade hides itself when the server refuses, and when the endpoint isn't there at all", async () => {
  for (const respond of [() => ({ ok: false, error: "rest_grade_readiness" }), () => { throw new Error("404"); }]) {
    const { harness, brief, button } = tradeHarness(respond);

    button.click();
    await flush();

    assert.equal(brief.children.includes(button), false, "a trade the server won't honour stops being offered");
    assert.equal(harness.transitions.length, 0, "and nothing repaints");
    assert.equal(harness.deps.state.brief, null);
  }
});

// Removing the button was never enough on its own: `leaning` is a property of the
// READ, so the very next repaint rendered the offer straight back and the athlete
// could tap a trade the server had already refused, over and over.
test("a repaint after a refused trade stops offering it for that date", async () => {
  const { harness, brief, button } = tradeHarness(() => ({ ok: false, error: "rest_grade_readiness" }));
  const seen = [];
  harness.context.CairnTodayBrief.briefHtml = (_read, opts) => {
    seen.push(opts);
    return `<section class="brief">${opts.tradeRefused ? "" : "<button data-tradetomorrow></button>"}</section>`;
  };
  const read = { kind: "easy", headline: "Easy", focus: null, signals: {} };

  const before = harness.controller.briefHtml(read, { isToday: true }, harness.deps);
  assert.match(before, /data-tradetomorrow/, "the offer stands until the server says otherwise");
  assert.equal(seen[0].tradeRefused, false);

  button.click();
  await flush();
  assert.equal(brief.children.includes(button), false);

  const after = harness.controller.briefHtml(read, { isToday: true }, harness.deps);
  assert.equal(seen[1].tradeRefused, true, "the refusal reaches the render, not just the DOM");
  assert.doesNotMatch(after, /data-tradetomorrow/, "and the repaint does not put the button back");

  // Tomorrow is a different question — the refusal is scoped to the date it was given on.
  harness.deps.state.logDate = "2026-07-02";
  harness.controller.briefHtml(read, { isToday: true }, harness.deps);
  assert.equal(seen[2].tradeRefused, false);
});

test("run-before-leg-day rows ask for their own focus and caveat; Rest steers the read", () => {
  const harness = loadController();
  const brief = harness.rootEl.appendChild(new FakeElement("section", { className: "brief" }));
  const upper = brief.appendChild(new FakeElement("button", {
    dataset: { runleg: "upper", runlegFocus: "upper body", runlegConstraints: "already ran today — spare the legs" },
  }));
  const rest = brief.appendChild(new FakeElement("button", {
    className: "brief-recovery-opt",
    dataset: { override: "rest — already ran today, my legs need the recovery" },
  }));

  harness.controller.wireBrief({ kind: "train", headline: "Train", focus: "Squat & quads", signals: {} }, { isToday: true }, harness.deps);
  upper.click();
  rest.click();

  assert.deepEqual(plain(harness.asks), [
    { focus: "upper body", constraints: "already ran today — spare the legs", autoUse: true },
  ]);
  assert.equal(harness.runOps[0].kind, "day_read_override");
  assert.equal(harness.runOps[0].body.override, "rest — already ran today, my legs need the recovery");
});

test("a one-tap menu row shows its own progress, holds the other rows, and ignores a second tap", async () => {
  const observers = [];
  const harness = loadController({
    extraContext: {
      MutationObserver: class {
        constructor(cb) { this.cb = cb; this.on = false; observers.push(this); }
        observe() { this.on = true; }
        disconnect() { this.on = false; }
      },
    },
  });
  const slot = harness.rootEl.appendChild(new FakeElement("div", { id: "sugSlot" }));
  harness.deps.askForSession = (opts) => {
    harness.asks.push(opts);
    slot.appendChild(new FakeElement("div", { className: "sug-loading" }));
  };
  const brief = harness.rootEl.appendChild(new FakeElement("section", { className: "brief" }));
  const upper = brief.appendChild(new FakeElement("button", {
    className: "brief-recovery-opt",
    dataset: { runleg: "upper", runlegFocus: "upper body", runlegConstraints: "spare the legs" },
  }));
  const lighter = brief.appendChild(new FakeElement("button", {
    className: "brief-recovery-opt",
    dataset: { runleg: "lighter", runlegFocus: "Squat & quads", runlegConstraints: "lighter" },
  }));

  harness.controller.wireBrief({ kind: "train", headline: "Train", focus: null, signals: {} }, { isToday: true }, harness.deps);
  upper.click();
  await Promise.resolve();

  assert.equal(harness.asks.length, 1);
  assert.equal(upper.classList.contains("is-working"), true, "the tapped row carries the progress");
  assert.equal(upper.getAttribute("aria-busy"), "true");
  assert.equal(lighter.disabled, true, "the other rows step back");
  assert.equal(upper.children.some((c) => c.className === "brief-recovery-opt-status"), true, "a status line rides on the row");

  upper.click();
  lighter.click();
  assert.equal(harness.asks.length, 1, "a tap while one is drafting never asks again (no toast)");

  // The slot stops loading (the drafted card or a failure landed): the row lets go.
  slot.children = [];
  observers[0].cb();
  assert.equal(upper.classList.contains("is-working"), false);
  assert.equal(upper.getAttribute("aria-busy"), null);
  assert.equal(lighter.disabled, false);
  assert.equal(observers[0].on, false, "the watcher is disconnected");
});

// A rest trade is also "train today": the server answers train_anyway:true, and the app goes
// straight to the session the way the Train anyway action does — it never stops at the repaint.
test("a rest trade that answers train_anyway opens the session, as Train anyway does", async () => {
  const opened = [];
  const traded = { kind: "train", headline: "Pull day", why: "", focus: "Pull", signals: {} };
  const { button } = tradeHarness(() => ({ ok: true, train_anyway: true, read: traded }), {
    extraContext: { openSession: (date, options) => { opened.push({ date, options }); return Promise.resolve(true); } },
  });

  button.click();
  await flush();

  assert.equal(opened.length, 1);
  assert.equal(opened[0].date, undefined);
  assert.equal(opened[0].options.trainAnyway, true);
  assert.equal(opened[0].options.replace, true);
  assert.equal(opened[0].options.source, "adaptive_plan");
  assert.equal(opened[0].options.provenance.entry, "train_anyway");
});

test("a rest trade without train_anyway only repaints", async () => {
  const opened = [];
  const traded = { kind: "train", headline: "Pull day", why: "", focus: "Pull", signals: {} };
  const { harness, button } = tradeHarness(() => ({ ok: true, read: traded }), {
    extraContext: { openSession: () => { opened.push(1); return Promise.resolve(true); } },
  });
  button.click();
  await flush();
  assert.equal(opened.length, 0);
  assert.equal(harness.transitions.length, 1);
});

// The server's open_session is the Brief's one session fact: its label is every start action's
// wording, and a day the athlete CHOSE on a quiet read is a train-shaped Brief whose caveat the
// strength line carries — no "rest" headline.
test("briefHtml hands the open session to the Brief and reads a chosen quiet day as the session", () => {
  const harness = loadController();
  const seen = [];
  harness.context.CairnTodayBrief.briefHtml = (read, opts) => {
    seen.push({ read, opts });
    return "<section class=\"brief\"></section>";
  };
  const open = { daily_session_id: 5, session_id: 6, started: false, chosen: true, action: "start", title: "Pull", label: "Start Pull" };
  const rest = { kind: "rest", headline: "Rest day", why: "Take it easy.", focus: "recovery", signals: {} };

  harness.deps.state.openSession = { date: harness.deps.state.logDate, read: open };
  harness.controller.briefHtml(rest, { isToday: true, showPlan: true }, harness.deps);
  assert.equal(seen[0].opts.open.label, "Start Pull");
  assert.equal(seen[0].read.kind, "train", "the chosen session is the day");
  assert.equal(seen[0].read.headline, "Pull");
  assert.equal(seen[0].read.why, "", "the quiet read survives only as the strength line's caveat");

  harness.deps.state.openSession = { date: harness.deps.state.logDate, read: { ...open, chosen: false } };
  harness.controller.briefHtml(rest, { isToday: true, showPlan: true }, harness.deps);
  assert.equal(seen[1].read.kind, "rest", "an open session the athlete did not choose leaves the read as it is");
  assert.equal(seen[1].opts.open.label, "Start Pull");

  harness.deps.state.openSession = { date: "2020-01-01", read: open };
  harness.controller.briefHtml(rest, { isToday: true }, harness.deps);
  assert.equal(seen[2].opts.open, null, "another date's session is never printed");
  assert.equal(seen[2].read.kind, "rest");
});
