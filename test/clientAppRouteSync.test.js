import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadRouteSync(options = {}) {
  const source = readFileSync(new URL("../public/js/app-route-sync.js", import.meta.url), "utf8");
  const calls = [];
  const state = {
    logDate: "2026-06-29",
    planJump: null,
    planSeg: null,
    tab: options.tab || "today",
  };
  const routes = options.routes === undefined
    ? {
        parseRoute: () => ({ tab: "plan", section: "food" }),
        routeToUrl: (route) => `/app/${route.tab}/${route.section || ""}`.replace(/\/$/, ""),
      }
    : options.routes;
  const context = {
    HEALTH_SEG: [["read", "Read"], ["records", "Records"]],
    ME_SEG: [["standing", "Standing"], ["health", "Health"]],
    PROGRESS_SEG: [["sessions", "History"], ["program", "Program"]],
    SET_SEG: [["agents", "Agents"], ["data", "Data"]],
    defaultProgressSeg: () => "sessions",
    globalThis: null,
    history: {
      pushState: (stateArg, title, url) => calls.push(["pushState", stateArg, title, url]),
      replaceState: (stateArg, title, url) => calls.push(["replaceState", stateArg, title, url]),
    },
    location: {
      pathname: options.pathname || "/app/today",
      search: options.search || "",
    },
    planSeg: () => [["edit", "Training"], ["food", "Food"], ["coach", "Coach"]],
    state,
    window: {
      CairnAppRouter: {
        applyRouteState: (route, deps) => {
          calls.push(["applyRouteState", route, {
            planSections: deps.planSections,
            progressSections: deps.progressSections,
            routeApi: !!deps.routeApi,
          }]);
          deps.state.tab = route?.tab || "today";
          return deps.state.tab;
        },
        currentRouteState: (deps) => {
          calls.push(["currentRouteState", {
            defaultProgressSection: deps.defaultProgressSection,
            settingsSections: deps.settingsSections,
          }]);
          return { tab: deps.state.tab, section: "sessions" };
        },
        routeKey: (key, items, fallback) => {
          calls.push(["routeKey", key, items, fallback]);
          return fallback;
        },
        syncRouteFromState: (deps) => {
          calls.push(["syncRouteFromState", {
            mode: deps.mode,
            route: deps.route,
            routes: !!deps.routes,
          }]);
          deps.history[deps.mode === "replace" ? "replaceState" : "pushState"]({ cairn: true }, "", "/app/synced");
          return "/app/synced";
        },
      },
      CairnRoutes: routes,
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "app-route-sync.js" });
  return { calls, context, state };
}

test("route sync wrapper exposes route API and applies parsed routes with app segments", () => {
  const env = loadRouteSync();

  assert.equal(typeof env.context.routeApi, "function");
  assert.equal(typeof env.context.window.routeApi, "function");
  assert.equal(env.context.routeApi(), env.context.window.CairnRoutes);
  assert.equal(env.context.applyRouteState({ tab: "plan", section: "food" }), "plan");

  assert.deepEqual(plain(env.calls), [
    ["applyRouteState", { tab: "plan", section: "food" }, {
      planSections: [["edit", "Training"], ["food", "Food"], ["coach", "Coach"]],
      progressSections: [["sessions", "History"], ["program", "Program"]],
      routeApi: true,
    }],
  ]);
});

test("route sync wrapper derives current state and delegates browser history sync", () => {
  const env = loadRouteSync({ tab: "progress" });

  assert.deepEqual(plain(env.context.currentRouteState()), { tab: "progress", section: "sessions" });
  env.context.syncRouteFromState("replace");

  assert.deepEqual(plain(env.calls), [
    ["currentRouteState", {
      defaultProgressSection: "sessions",
      settingsSections: [["agents", "Agents"], ["data", "Data"]],
    }],
    ["currentRouteState", {
      defaultProgressSection: "sessions",
      settingsSections: [["agents", "Agents"], ["data", "Data"]],
    }],
    ["syncRouteFromState", {
      mode: "replace",
      route: { tab: "progress", section: "sessions" },
      routes: true,
    }],
    ["replaceState", { cairn: true }, "", "/app/synced"],
  ]);
});

test("route sync wrapper degrades when the route parser is unavailable", () => {
  const env = loadRouteSync({ routes: null });

  assert.equal(env.context.routeApi(), null);
  env.context.syncRouteFromState();

  assert.equal(env.calls.at(-1)[0], "pushState");
  assert.deepEqual(plain(env.calls.at(-2)), ["syncRouteFromState", {
    mode: "push",
    route: { tab: "today", section: "sessions" },
    routes: false,
  }]);
});
