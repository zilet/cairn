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
  const routes =
    options.routes === undefined
      ? {
          parseRoute: () => ({ tab: "plan", section: "meals" }),
          planSections: ["edit", "meals", "coach"],
          routeToUrl: (route) => `/app/${route.tab}/${route.section || ""}`.replace(/\/$/, ""),
        }
      : options.routes;
  const context = {
    HEALTH_SEG: [
      ["read", "Read"],
      ["records", "Records"],
    ],
    ME_SEG: [
      ["standing", "Standing"],
      ["health", "Health"],
    ],
    PROGRESS_SEG: [
      ["sessions", "History"],
      ["program", "Program"],
    ],
    SET_SEG: [
      ["agents", "Agents"],
      ["data", "Data"],
    ],
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
    state,
    window: {
      CairnAppRouter: {
        applyRouteState: (route, deps) => {
          calls.push([
            "applyRouteState",
            route,
            {
              planSections: deps.planSections,
              progressSections: deps.progressSections,
              routeApi: !!deps.routeApi,
            },
          ]);
          deps.state.tab = route?.tab || "today";
          return deps.state.tab;
        },
        currentRouteState: (deps) => {
          calls.push([
            "currentRouteState",
            {
              defaultProgressSection: deps.defaultProgressSection,
              planSections: deps.planSections,
              settingsSections: deps.settingsSections,
            },
          ]);
          return { tab: deps.state.tab, section: options.section || "sessions" };
        },
        routeKey: (key, items, fallback) => {
          calls.push(["routeKey", key, items, fallback]);
          return fallback;
        },
        syncRouteFromState: (deps) => {
          calls.push([
            "syncRouteFromState",
            {
              mode: deps.mode,
              route: deps.route,
              routes: !!deps.routes,
            },
          ]);
          calls.historyStates = [...(calls.historyStates || []), deps.historyState];
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
  assert.equal(env.context.applyRouteState({ tab: "plan", section: "meals" }), "plan");

  assert.deepEqual(plain(env.calls), [
    [
      "applyRouteState",
      { tab: "plan", section: "meals" },
      {
        planSections: ["edit", "meals", "coach"],
        progressSections: [
          ["sessions", "History"],
          ["program", "Program"],
        ],
        routeApi: true,
      },
    ],
  ]);
});

test("route sync wrapper derives current state and delegates browser history sync", () => {
  const env = loadRouteSync({ tab: "progress" });

  assert.deepEqual(plain(env.context.currentRouteState()), { tab: "progress", section: "sessions" });
  env.context.syncRouteFromState("replace");

  assert.deepEqual(plain(env.calls), [
    [
      "currentRouteState",
      {
        defaultProgressSection: "sessions",
        planSections: ["edit", "meals", "coach"],
        settingsSections: [
          ["agents", "Agents"],
          ["data", "Data"],
        ],
      },
    ],
    [
      "currentRouteState",
      {
        defaultProgressSection: "sessions",
        planSections: ["edit", "meals", "coach"],
        settingsSections: [
          ["agents", "Agents"],
          ["data", "Data"],
        ],
      },
    ],
    [
      "syncRouteFromState",
      {
        mode: "replace",
        route: { tab: "progress", section: "sessions" },
        routes: true,
      },
    ],
    ["replaceState", { cairn: true }, "", "/app/synced"],
  ]);
});

test("route sync wrapper degrades when the route parser is unavailable", () => {
  const env = loadRouteSync({ routes: null });

  assert.equal(env.context.routeApi(), null);
  env.context.syncRouteFromState();

  assert.equal(env.calls.at(-1)[0], "pushState");
  assert.deepEqual(plain(env.calls.at(-2)), [
    "syncRouteFromState",
    {
      mode: "push",
      route: { tab: "today", section: "sessions" },
      routes: false,
    },
  ]);
});

// A section change inside a view can move it to another home (Plan's race view is
// Horizon's, its Fuel is Today's), so every URL sync re-lights the tab bar first.
test("every route sync re-lights the home the current view lives under", () => {
  const env = loadRouteSync({ tab: "plan" });
  const lit = [];
  env.context.highlightHome = (view) => lit.push(view);
  env.context.syncRouteFromState();
  assert.deepEqual(lit, ["plan"]);
  assert.equal(env.calls.at(-1)[0], "pushState");
});

// The week menu opened by an in-app tap marks its entry, so its back link can step back
// to the opener (coach-meals-screen.ts mealMenuOpenedInApp); a cold or replaced entry never does.
test("an in-app push to the week menu marks its history entry for the back link", () => {
  const pushed = loadRouteSync({ tab: "plan", section: "meals" });
  pushed.context.syncRouteFromState("push");
  assert.deepEqual(plain(pushed.calls.historyStates), [{ back: 1 }]);
  const replaced = loadRouteSync({ tab: "plan", section: "meals" });
  replaced.context.syncRouteFromState("replace");
  assert.deepEqual(plain(replaced.calls.historyStates), [null]);
  const other = loadRouteSync({ tab: "progress", section: "intake" });
  other.context.syncRouteFromState("push");
  assert.deepEqual(plain(other.calls.historyStates), [null]);
});
