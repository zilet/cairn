import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadLifecycle(options = {}) {
  const source = readFileSync(new URL("../public/js/app-service-worker.js", import.meta.url), "utf8");
  const listeners = new Map();
  const registerCalls = [];
  let reloadCount = 0;
  const serviceWorker = {
    controller: options.controller ? {} : null,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    register(path) {
      registerCalls.push(path);
      return options.rejectRegister ? Promise.reject(new Error("register failed")) : Promise.resolve({});
    },
  };
  const context = {
    globalThis: null,
    location: { reload: () => { reloadCount += 1; } },
    navigator: options.noServiceWorker ? {} : { serviceWorker },
    window: {},
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "app-service-worker.js" });

  return {
    context,
    listener: (type) => listeners.get(type),
    registerCalls,
    reloadCount: () => reloadCount,
  };
}

test("service worker lifecycle registers and reloads once for controlled pages", async () => {
  const env = loadLifecycle({ controller: true });

  assert.equal(typeof env.context.registerServiceWorkerLifecycle, "function");
  assert.equal(typeof env.context.window.registerServiceWorkerLifecycle, "function");
  env.context.registerServiceWorkerLifecycle();
  await Promise.resolve();

  assert.deepEqual(env.registerCalls, ["/sw.js"]);
  assert.equal(typeof env.listener("controllerchange"), "function");
  env.listener("controllerchange")();
  env.listener("controllerchange")();
  assert.equal(env.reloadCount(), 1);
});

test("service worker lifecycle skips reload for first install", async () => {
  const env = loadLifecycle({ controller: false });

  env.context.registerServiceWorkerLifecycle();
  await Promise.resolve();
  env.listener("controllerchange")();

  assert.deepEqual(env.registerCalls, ["/sw.js"]);
  assert.equal(env.reloadCount(), 0);
});

test("service worker lifecycle degrades when service workers are unavailable", () => {
  const env = loadLifecycle({ noServiceWorker: true });

  env.context.registerServiceWorkerLifecycle();

  assert.deepEqual(env.registerCalls, []);
  assert.equal(env.reloadCount(), 0);
});
