import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadRouter() {
  const routeStateSrc = readFileSync(new URL("../public/js/route-state.js", import.meta.url), "utf8");
  const src = readFileSync(new URL("../public/js/app-router.js", import.meta.url), "utf8");
  const context = { window: {}, URL, URLSearchParams };
  vm.runInNewContext(routeStateSrc, context, { filename: "route-state.js" });
  vm.runInNewContext(src, context);
  return context.window.CairnAppRouter;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const deps = {
  routeApi: { planSections: ["edit", "food", "meals", "coach"] },
  planSections: [["edit", "Training"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]],
  progressSections: [["sessions", "History"], ["program", "Program"], ["energy", "Energy"]],
  meSections: [["standing", "Standing"], ["health", "Health"]],
  healthSections: [["read", "Read"], ["records", "Records"], ["markers", "Markers"]],
  settingsSections: [["agents", "Agents"], ["data", "Data"]],
};

test("app router derives tab names from the route contract", () => {
  const router = loadRouter();
  assert.deepEqual(plain(router.ROUTE_TABS), ["today", "plan", "progress", "chat", "me", "settings"]);
});

test("app router applies canonical route state without rendering", () => {
  const router = loadRouter();
  const state = {
    tab: "today",
    day: null,
    dayPicked: false,
    plan: [],
    today: {},
    logDate: "2026-06-29",
  };

  assert.equal(
    router.applyRouteState({ tab: "plan", section: "food", date: "2026-06-30" }, { state, ...deps }),
    "plan",
  );
  assert.equal(state.logDate, "2026-06-30");
  assert.equal(state.planSeg, "food");
  assert.equal(state.planJump, "food");

  assert.equal(
    router.applyRouteState({ tab: "progress", section: "energy" }, { state, ...deps }),
    "progress",
  );
  assert.equal(state.progressSeg, "energy");

  assert.equal(
    router.applyRouteState({ tab: "me", section: "health", healthSection: "records", id: "42" }, { state, ...deps }),
    "me",
  );
  assert.equal(state.meSeg, "health");
  assert.equal(state.healthSeg, "records");
  assert.equal(state.healthSegPicked, true);
  assert.equal(state.pendingHealthDocId, "42");
});

test("app router derives current route state from app state", () => {
  const router = loadRouter();
  const route = router.currentRouteState({
    state: {
      tab: "me",
      day: null,
      dayPicked: false,
      plan: [],
      today: {},
      logDate: "2026-06-29",
      meSeg: "health",
      healthSeg: "markers",
      pendingHealthDocId: "99",
    },
    ...deps,
    defaultProgressSection: "sessions",
  });

  assert.deepEqual(plain(route), {
    tab: "me",
    section: "health",
    healthSection: "markers",
    id: "99",
  });
});

test("app router syncs canonical URLs through push and replace history", () => {
  const router = loadRouter();
  const calls = [];
  const routes = { routeToUrl: (route) => `/app/${route.tab}/${route.section}` };
  const history = {
    pushState(state, title, url) { calls.push(["push", state, title, url]); },
    replaceState(state, title, url) { calls.push(["replace", state, title, url]); },
  };

  assert.equal(
    router.syncRouteFromState({
      routes,
      route: { tab: "progress", section: "program" },
      location: { pathname: "/app/today", search: "" },
      history,
    }),
    "/app/progress/program",
  );
  assert.deepEqual(plain(calls[0]), ["push", { cairn: true }, "", "/app/progress/program"]);

  assert.equal(
    router.syncRouteFromState({
      mode: "replace",
      routes,
      route: { tab: "settings", section: "data" },
      location: { pathname: "/app/progress/program", search: "" },
      history,
    }),
    "/app/settings/data",
  );
  assert.deepEqual(plain(calls[1]), ["replace", { cairn: true }, "", "/app/settings/data"]);

  assert.equal(
    router.syncRouteFromState({
      routes,
      route: { tab: "settings", section: "data" },
      location: { pathname: "/app/settings/data", search: "" },
      history,
    }),
    null,
  );
});
