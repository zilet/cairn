import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadStartup(options = {}) {
  const source = readFileSync(new URL("../public/js/app-startup.js", import.meta.url), "utf8");
  const calls = [];
  const listeners = new Map();
  const routeApiValue = options.routeApi === undefined
    ? {
        parseRoute: (href) => {
          calls.push(["parseRoute", href]);
          return options.parsedRoute || { tab: "chat" };
        },
        routeToUrl: () => "/app/chat",
      }
    : options.routeApi;
  const context = {
    URLSearchParams,
    activateTab: (tab, opts) => calls.push(["activateTab", tab, opts]),
    applyRouteState: (route) => {
      calls.push(["applyRouteState", route]);
      return route?.tab || options.appliedTab || "today";
    },
    globalThis: null,
    installMobileViewportGuards: () => calls.push(["installMobileViewportGuards"]),
    jobReconnect: () => calls.push(["jobReconnect"]),
    location: {
      href: options.href || "http://cairn.local/app/chat",
      pathname: options.pathname || "/app/chat",
      search: options.search || "",
    },
    maybeOnboard: () => calls.push(["maybeOnboard"]),
    primeArtManifest: () => calls.push(["primeArtManifest"]),
    primeDiscipline: () => calls.push(["primeDiscipline"]),
    registerAppJobReconnectors: () => calls.push(["registerAppJobReconnectors"]),
    registerServiceWorkerLifecycle: () => calls.push(["registerServiceWorkerLifecycle"]),
    registerTabBarHandlers: () => calls.push(["registerTabBarHandlers"]),
    routeApi: () => {
      calls.push(["routeApi"]);
      return routeApiValue;
    },
    setTimeout: (fn, ms) => {
      calls.push(["setTimeout", ms]);
      fn();
      return 1;
    },
    swrSweep: () => calls.push(["swrSweep"]),
    window: {
      addEventListener: (type, handler) => {
        listeners.set(type, handler);
        calls.push(["addEventListener", type]);
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "app-startup.js" });
  return {
    calls,
    context,
    listener: (type) => listeners.get(type),
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("app startup activates direct app routes without canonicalizing", () => {
  const env = loadStartup();

  assert.equal(typeof env.context.startAppShell, "function");
  assert.equal(typeof env.context.window.startAppShell, "function");
  env.context.startAppShell();

  assert.deepEqual(plain(env.calls), [
    ["registerServiceWorkerLifecycle"],
    ["swrSweep"],
    ["registerAppJobReconnectors"],
    ["registerTabBarHandlers"],
    ["routeApi"],
    ["parseRoute", "http://cairn.local/app/chat"],
    ["applyRouteState", { tab: "chat" }],
    ["primeDiscipline"],
    ["activateTab", "chat", { replace: false, syncRoute: false }],
    ["addEventListener", "popstate"],
    ["maybeOnboard"],
    ["primeArtManifest"],
    ["setTimeout", 0],
    ["jobReconnect"],
    ["installMobileViewportGuards"],
  ]);
});

test("app startup canonicalizes legacy tab/date query routes", () => {
  const env = loadStartup({
    href: "http://cairn.local/?tab=plan&date=2026-06-30",
    pathname: "/",
    search: "?tab=plan&date=2026-06-30",
    parsedRoute: { tab: "plan", date: "2026-06-30" },
  });

  env.context.startAppShell();

  assert.deepEqual(plain(env.calls.slice(0, 9)), [
    ["registerServiceWorkerLifecycle"],
    ["swrSweep"],
    ["registerAppJobReconnectors"],
    ["registerTabBarHandlers"],
    ["routeApi"],
    ["parseRoute", "http://cairn.local/?tab=plan&date=2026-06-30"],
    ["applyRouteState", { tab: "plan", date: "2026-06-30" }],
    ["primeDiscipline"],
    ["activateTab", "plan", { replace: true, syncRoute: true }],
  ]);
});

test("app startup routes browser popstate without pushing a new route", () => {
  const env = loadStartup({ parsedRoute: { tab: "today" } });

  env.context.startAppShell();
  env.calls.length = 0;
  env.listener("popstate")();

  assert.deepEqual(plain(env.calls), [
    ["routeApi"],
    ["parseRoute", "http://cairn.local/app/chat"],
    ["applyRouteState", { tab: "today" }],
    ["activateTab", "today", { syncRoute: false }],
  ]);
});
