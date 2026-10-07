import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function flush() {
  return Promise.resolve().then(() => Promise.resolve());
}

function tabElement(tab, calls) {
  const listeners = new Map();
  return {
    dataset: { tab },
    attrs: {},
    addEventListener: (type, handler) => {
      listeners.set(type, handler);
      calls.push(["addEventListener", tab, type]);
    },
    classList: {
      toggle: (name, on) => calls.push(["toggle", tab, name, on]),
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    getAttribute(name) {
      return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
    },
    click: () => listeners.get("click")?.(),
    clickWith: (event) => listeners.get("click")?.(event),
  };
}

// The tab bar's buttons are the five HOMES; state.tab stays the view.
const HOMES = ["today", "train", "horizon", "ask", "you"];

function loadRoutes() {
  const src = readFileSync(new URL("../public/js/route-state.js", import.meta.url), "utf8");
  const context = { window: {}, URL, URLSearchParams };
  vm.runInNewContext(src, context);
  return context.window.CairnRoutes;
}

function homeToggles(active) {
  return HOMES.map((home) => ["toggle", home, "active", home === active]);
}

function loadTabs(options = {}) {
  const source = readFileSync(new URL("../public/js/app-tabs.js", import.meta.url), "utf8");
  const calls = [];
  const view = options.view || { innerHTML: "" };
  const tabs = HOMES.map((tab) => tabElement(tab, calls));
  const routes = loadRoutes();
  const context = {
    MEALS_KEY: "meals:plans",
    ME_SEG: [["standing", "Standing"], ["profile", "Profile"], ["health", "Health"]],
    PROGRESS_SEG: [["sessions", "History"], ["endurance", "Endurance"], ["plan", "Plan"], ["program", "Program"]],
    chatTeardownMonitor: () => calls.push(["chatTeardownMonitor"]),
    closeDetail: (instant) => calls.push(["closeDetail", instant]),
    closeMealSheet: (instant) => calls.push(["closeMealSheet", instant]),
    document: {
      querySelectorAll: (selector) => selector === ".tab" ? tabs : [],
    },
    globalThis: null,
    isEndurance: () => !!options.endurance,
    peekCached: (key) => {
      calls.push(["peekCached", key]);
      return options.cachedKeys?.has(key) ? { data: {}, fresh: true } : null;
    },
    renderTab: (tab) => calls.push(["renderTab", tab]),
    segSkeleton: (active, seg, cards) => `seg:${active}:${seg.length}:${cards}`,
    showEnduranceTab: () => !!options.showEnduranceTab,
    skelLines: (count) => `lines:${count}`,
    state: {
      planJump: options.planJump || null,
      planSeg: options.planSeg || null,
      horizonSeg: options.horizonSeg ?? null,
      progressSeg: options.progressSeg,
      tab: options.currentTab || "today",
    },
    syncRouteFromState: (mode) => calls.push(["syncRouteFromState", mode]),
    tabErrorState: (tab) => calls.push(["tabErrorState", tab]),
    teardownJobs: () => calls.push(["teardownJobs"]),
    todaySkeleton: () => "today-skeleton",
    view,
    viewEnter: () => calls.push(["viewEnter", view.innerHTML]),
    window: {
      CairnAppRouter: {
        ROUTE_TABS: [...routes.validTabs],
      },
      CairnRoutes: routes,
    },
    tabSwap: (fn) => {
      calls.push(["tabSwap"]);
      fn();
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "app-tabs.js" });
  return { calls, context, tabs, view };
}

test("tab controller switches tabs with skeleton-first paint and route sync", async () => {
  const env = loadTabs();

  assert.equal(typeof env.context.switchTab, "function");
  assert.equal(typeof env.context.window.switchTab, "function");
  env.context.switchTab("plan");
  await flush();

  assert.equal(env.context.state.tab, "plan");
  // The plan editor wears Train's group nav, and Train is the home it lights.
  assert.equal(env.view.innerHTML, "seg:plan:4:3");
  assert.deepEqual(plain(env.calls), [
    ["teardownJobs"],
    ["closeDetail", true],
    ["closeMealSheet", true],
    ...homeToggles("train"),
    ["syncRouteFromState", "push"],
    // ONE swap carries the skeleton AND the renderer's synchronous paint; the
    // swap itself is the fade, so no separate view-enter keyframe is played.
    ["tabSwap"],
    ["peekCached", "plan"],
    ["renderTab", "plan"],
  ]);
});

test("tab controller skips warm skeletons and tears down chat when leaving", async () => {
  const env = loadTabs({ cachedKeys: new Set(["history:sessions"]), currentTab: "chat", progressSeg: "sessions" });

  env.context.switchTab("progress", { replace: true });
  await flush();

  assert.equal(env.view.innerHTML, "");
  assert.deepEqual(plain(env.calls.slice(0, 11)), [
    ["chatTeardownMonitor"],
    ["teardownJobs"],
    ["closeDetail", true],
    ["closeMealSheet", true],
    ...homeToggles("train"),
    ["syncRouteFromState", "replace"],
    ["tabSwap"],
  ]);
  assert.deepEqual(plain(env.calls.slice(11)), [
    ["peekCached", "history:sessions"],
    ["renderTab", "progress"],
  ]);
});

test("tab controller lands Progress on the Train overview by default", async () => {
  const env = loadTabs();

  env.context.switchTab("progress", { syncRoute: false });
  await flush();

  assert.equal(env.context.state.tab, "progress");
  assert.equal(env.context.defaultProgressSeg(), "overview");
  assert.match(env.view.innerHTML, /^seg:overview:/);
});

test("while a tab loads, <main> is named for the destination, never the tab just left", async () => {
  const attrs = { "aria-label": "Horizon" };
  const view = {
    innerHTML: "",
    setAttribute: (name, value) => (attrs[name] = String(value)),
    removeAttribute: (name) => delete attrs[name],
    querySelector: () => null,
  };
  // The renderer never settles: the label must already follow the tab while it loads.
  const env = loadTabs({ view, currentTab: "horizon" });
  env.context.renderTab = () => new Promise(() => {});
  env.context.document.querySelector = (selector) =>
    selector === '.tab[data-tab="train"]' ? { getAttribute: (name) => (name === "aria-label" ? "Train" : null) } : null;
  env.context.switchTab("progress", { syncRoute: false });
  await flush();
  assert.equal(attrs["aria-label"], "Train");
});

test("tab controller keeps the Endurance default for endurance athletes", async () => {
  const env = loadTabs({ endurance: true });

  assert.equal(env.context.defaultProgressSeg(), "endurance");
});

test("the race view's skeleton is Horizon's shape, never a dead Plan seg bar", async () => {
  const env = loadTabs({ planSeg: "endurance" });

  env.context.switchTab("plan", { syncRoute: false });
  await flush();

  assert.equal(env.context.state.tab, "plan");
  assert.equal(env.view.innerHTML, "lines:2lines:3");
});

test("tab controller registers tabbar clicks and normalizes invalid tabs", async () => {
  const env = loadTabs();

  env.context.registerTabBarHandlers();
  env.context.activateTab("bogus", { syncRoute: false });
  await flush();

  assert.equal(env.context.state.tab, "today");
  assert.match(env.view.innerHTML, /today-skeleton/);
  assert.equal(env.calls.filter(([kind]) => kind === "addEventListener").length, 5);

  env.calls.length = 0;
  env.tabs[4].click();
  await flush();

  assert.equal(env.context.state.tab, "you");
  assert.deepEqual(plain(env.calls.slice(0, 4)), [
    ["teardownJobs"],
    ["closeDetail", true],
    ["closeMealSheet", true],
    ["toggle", "today", "active", false],
  ]);
  // aria-current="page" names the live tab; only the active tab carries it.
  assert.equal(env.tabs.find((t) => t.dataset.tab === "you").getAttribute("aria-current"), "page");
  assert.equal(env.tabs.find((t) => t.dataset.tab === "today").getAttribute("aria-current"), null);
});

test("each tab-bar button names a home and opens that home's landing view", async () => {
  const landings = { today: "today", train: "progress", horizon: "horizon", ask: "chat", you: "you" };
  for (const [index, home] of HOMES.entries()) {
    const env = loadTabs({ currentTab: home === "today" ? "chat" : "today" });
    env.context.registerTabBarHandlers();
    env.tabs[index].click();
    await flush();
    assert.equal(env.context.state.tab, landings[home], `${home} opens ${landings[home]}`);
    assert.equal(env.tabs[index].getAttribute("aria-current"), "page", `${home} is lit`);
  }
  // A home name reaches activateTab as a view too (a shortcut, a stale caller).
  const env = loadTabs();
  env.context.activateTab("ask", { syncRoute: false });
  assert.equal(env.context.state.tab, "chat");
});

test("the Plan view lights the home its section lives under", async () => {
  const cases = [
    ["edit", "train"],
    ["endurance", "horizon"],
    ["food", "today"],
    ["meals", "today"],
    ["coach", "ask"],
  ];
  for (const [section, home] of cases) {
    const env = loadTabs({ planJump: section === "edit" ? null : section, planSeg: section });
    env.context.switchTab("plan", { syncRoute: false });
    await flush();
    const lit = env.tabs.filter((t) => t.getAttribute("aria-current") === "page").map((t) => t.dataset.tab);
    assert.deepEqual(lit, [home], `plan/${section} lights ${home}`);
    assert.equal(env.context.highlightHome("plan"), home);
  }
  // Every other view has one home.
  const env = loadTabs();
  const views = { today: "today", session: "today", progress: "train", horizon: "horizon", chat: "ask", stand: "you", me: "you", settings: "you", you: "you" };
  for (const [view, home] of Object.entries(views)) assert.equal(env.context.highlightHome(view), home, view);
});

// A focus-moving tab switch lands on the new view's heading. A tap lands it
// QUIETLY (no ring: data-focus-quiet + focusVisible:false); a keyboard-activated
// click (detail 0) keeps the keyboard ring.
function headingElement() {
  const listeners = new Map();
  return {
    attrs: {},
    focusCalls: [],
    hasAttribute(name) {
      return Object.hasOwn(this.attrs, name);
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    blur() {
      listeners.get("blur")?.();
    },
    focus(opts) {
      this.focusCalls.push(opts);
    },
  };
}

function viewWithHeading(heading) {
  return {
    innerHTML: "",
    querySelector: (selector) => (/h1/.test(selector) ? heading : null),
    removeAttribute() {},
    setAttribute() {},
  };
}

test("a tapped tab lands focus on the heading without painting the keyboard ring", async () => {
  const heading = headingElement();
  const env = loadTabs({ view: viewWithHeading(heading) });
  env.context.registerTabBarHandlers();
  env.tabs[1].clickWith({ detail: 1 });
  await flush();
  await flush();

  assert.equal(heading.attrs["data-focus-quiet"], "");
  assert.equal(heading.attrs.tabindex, "-1");
  assert.deepEqual(plain(heading.focusCalls), [{ preventScroll: true, focusVisible: false }]);
  heading.blur();
  assert.equal(heading.hasAttribute("data-focus-quiet"), false, "the quiet mark leaves with the focus");
});

test("a keyboard-activated tab keeps the focus ring on the landed heading", async () => {
  const heading = headingElement();
  const env = loadTabs({ view: viewWithHeading(heading) });
  env.context.registerTabBarHandlers();
  env.tabs[1].clickWith({ detail: 0 });
  await flush();
  await flush();

  assert.equal(heading.hasAttribute("data-focus-quiet"), false);
  assert.deepEqual(plain(heading.focusCalls), [{ preventScroll: true, focusVisible: true }]);
});

test("the tab-bar Horizon button always opens the timeline, before the Horizon bundle ever loads", async () => {
  // The reset lives in the eager shell: a goal-line visit from Train must not stick
  // even when the lazy horizon bundle (which renders the section) has not loaded.
  const env = loadTabs({ horizonSeg: "goal" });
  env.context.registerTabBarHandlers();
  env.tabs[HOMES.indexOf("today")].click();
  await flush();
  assert.equal(env.context.state.horizonSeg, "goal", "another home leaves Horizon's section alone");
  env.tabs[HOMES.indexOf("horizon")].click();
  await flush();
  assert.equal(env.context.state.horizonSeg, null);
  assert.equal(env.context.state.tab, "horizon");
});
