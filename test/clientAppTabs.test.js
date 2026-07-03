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
  };
}

function loadTabs(options = {}) {
  const source = readFileSync(new URL("../public/js/app-tabs.js", import.meta.url), "utf8");
  const calls = [];
  const view = { innerHTML: "" };
  const tabs = ["today", "plan", "progress", "chat", "me", "settings"].map((tab) => tabElement(tab, calls));
  const context = {
    MEALS_KEY: "meals:plans",
    ME_SEG: [["standing", "Standing"], ["profile", "Profile"], ["health", "Health"]],
    PROGRESS_SEG: [["sessions", "History"], ["endurance", "Endurance"], ["program", "Program"]],
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
    planSeg: () => [["edit", "Training"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"], ["endurance", "Endurance"]],
    renderTab: (tab) => calls.push(["renderTab", tab]),
    segSkeleton: (active, seg, cards) => `seg:${active}:${seg.length}:${cards}`,
    showEnduranceTab: () => !!options.showEnduranceTab,
    skelLines: (count) => `lines:${count}`,
    state: {
      planJump: options.planJump || null,
      planSeg: options.planSeg || null,
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
        ROUTE_TABS: ["today", "plan", "progress", "chat", "me", "settings"],
      },
    },
    withViewTransition: (fn) => {
      calls.push(["withViewTransition"]);
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
  assert.equal(env.view.innerHTML, "seg:edit:5:3");
  assert.deepEqual(plain(env.calls), [
    ["teardownJobs"],
    ["closeDetail", true],
    ["closeMealSheet", true],
    ["toggle", "today", "active", false],
    ["toggle", "plan", "active", true],
    ["toggle", "progress", "active", false],
    ["toggle", "chat", "active", false],
    ["toggle", "me", "active", false],
    ["toggle", "settings", "active", false],
    ["syncRouteFromState", "push"],
    ["withViewTransition"],
    ["peekCached", "plan"],
    ["viewEnter", "seg:edit:5:3"],
    ["renderTab", "plan"],
  ]);
});

test("tab controller skips warm skeletons and tears down chat when leaving", async () => {
  const env = loadTabs({ cachedKeys: new Set(["history:sessions"]), currentTab: "chat", progressSeg: "sessions" });

  env.context.switchTab("progress", { replace: true });
  await flush();

  assert.equal(env.view.innerHTML, "");
  assert.deepEqual(plain(env.calls.slice(0, 12)), [
    ["chatTeardownMonitor"],
    ["teardownJobs"],
    ["closeDetail", true],
    ["closeMealSheet", true],
    ["toggle", "today", "active", false],
    ["toggle", "plan", "active", false],
    ["toggle", "progress", "active", true],
    ["toggle", "chat", "active", false],
    ["toggle", "me", "active", false],
    ["toggle", "settings", "active", false],
    ["syncRouteFromState", "replace"],
    ["withViewTransition"],
  ]);
  assert.deepEqual(plain(env.calls.slice(12)), [
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

test("tab controller keeps the Endurance default for endurance athletes", async () => {
  const env = loadTabs({ endurance: true });

  assert.equal(env.context.defaultProgressSeg(), "endurance");
});

test("tab controller honors a direct Plan Endurance route even when the tab is normally hidden", async () => {
  const env = loadTabs({ planSeg: "endurance" });

  env.context.switchTab("plan", { syncRoute: false });
  await flush();

  assert.equal(env.context.state.tab, "plan");
  assert.equal(env.view.innerHTML, "seg:endurance:5:3");
});

test("tab controller registers tabbar clicks and normalizes invalid tabs", async () => {
  const env = loadTabs();

  env.context.registerTabBarHandlers();
  env.context.activateTab("bogus", { syncRoute: false });
  await flush();

  assert.equal(env.context.state.tab, "today");
  assert.match(env.view.innerHTML, /today-skeleton/);
  assert.equal(env.calls.filter(([kind]) => kind === "addEventListener").length, 6);

  env.calls.length = 0;
  env.tabs[5].click();
  await flush();

  assert.equal(env.context.state.tab, "settings");
  assert.deepEqual(plain(env.calls.slice(0, 4)), [
    ["teardownJobs"],
    ["closeDetail", true],
    ["closeMealSheet", true],
    ["toggle", "today", "active", false],
  ]);
  // aria-current="page" names the live tab; only the active tab carries it.
  assert.equal(env.tabs.find((t) => t.dataset.tab === "settings").getAttribute("aria-current"), "page");
  assert.equal(env.tabs.find((t) => t.dataset.tab === "today").getAttribute("aria-current"), null);
});
