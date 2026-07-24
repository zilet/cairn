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
  progressSections: [["sessions", "History"], ["program", "Program"], ["intake", "Intake"], ["energy", "Energy"]],
  standSections: ["records", "share", "learned", "connections", "markers", "body", "recovery", "supplements", "age"],
  meSections: [["standing", "Standing"], ["profile", "Profile"], ["health", "Health"]],
  healthSections: [["read", "Read"], ["records", "Records"], ["markers", "Markers"]],
  settingsSections: [["agents", "Agents"], ["system", "System"], ["data", "Data"]],
};

test("app router derives tab names from the route contract", () => {
  const router = loadRouter();
  assert.deepEqual(plain(router.ROUTE_TABS), ["today", "session", "stand", "plan", "progress", "chat", "me", "settings"]);
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
    router.applyRouteState({ tab: "progress", section: "intake" }, { state, ...deps }),
    "progress",
  );
  assert.equal(state.progressSeg, "intake");

  // Stand sub-views are first-class routes.
  assert.equal(
    router.applyRouteState({ tab: "stand", section: "records", id: "7" }, { state, ...deps }),
    "stand",
  );
  assert.equal(state.standSeg, "records");
  assert.equal(state.pendingHealthDocId, "7");

  // Legacy me/health deep links redirect into the Stand tab (health home).
  assert.equal(
    router.applyRouteState({ tab: "me", section: "health", healthSection: "records", id: "42" }, { state, ...deps }),
    "stand",
  );
  assert.equal(state.standSeg, "records");
  assert.equal(state.pendingHealthDocId, "42");

  assert.equal(
    router.applyRouteState({ tab: "me", section: "health", healthSection: "read" }, { state, ...deps }),
    "stand",
  );
  assert.equal(state.standSeg, null);

  // Legacy me/standing lands on the hosted bio-age read.
  assert.equal(
    router.applyRouteState({ tab: "me", section: "standing" }, { state, ...deps }),
    "stand",
  );
  assert.equal(state.standSeg, "age");

  // Me stays the about-you home.
  assert.equal(
    router.applyRouteState({ tab: "me", section: "profile" }, { state, ...deps }),
    "me",
  );
  assert.equal(state.meSeg, "profile");

  assert.equal(
    router.applyRouteState({ tab: "settings", section: "system" }, { state, ...deps }),
    "settings",
  );
  assert.equal(state.setSeg, "system");
});

test("app router derives current route state from app state", () => {
  const router = loadRouter();
  const route = router.currentRouteState({
    state: {
      tab: "stand",
      day: null,
      dayPicked: false,
      plan: [],
      today: {},
      logDate: "2026-06-29",
      standSeg: "records",
      pendingHealthDocId: "99",
    },
    ...deps,
    defaultProgressSection: "sessions",
  });

  assert.deepEqual(plain(route), {
    tab: "stand",
    section: "records",
    id: "99",
  });

  const meRoute = router.currentRouteState({
    state: {
      tab: "me",
      day: null,
      dayPicked: false,
      plan: [],
      today: {},
      logDate: "2026-06-29",
      meSeg: "profile",
    },
    ...deps,
    defaultProgressSection: "sessions",
  });

  assert.deepEqual(plain(meRoute), { tab: "me", section: "profile" });

  const settingsRoute = router.currentRouteState({
    state: {
      tab: "settings",
      day: null,
      dayPicked: false,
      plan: [],
      today: {},
      logDate: "2026-06-29",
      setSeg: "system",
    },
    ...deps,
    defaultProgressSection: "sessions",
  });
  assert.deepEqual(plain(settingsRoute), { tab: "settings", section: "system" });
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
