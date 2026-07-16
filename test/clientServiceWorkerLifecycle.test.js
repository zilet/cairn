import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadLifecycle(options = {}) {
  const source = readFileSync(new URL(`../public/js/${options.file || "app-service-worker.js"}`, import.meta.url), "utf8");
  const listeners = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const registerCalls = [];
  const intervalCalls = [];
  let reloadCount = 0;
  let updateCalls = 0;
  const registrationObj = {
    update: () => {
      updateCalls += 1;
      return options.rejectUpdate ? Promise.reject(new Error("update failed")) : Promise.resolve();
    },
  };
  const serviceWorker = {
    controller: options.controller ? {} : null,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    register(path) {
      registerCalls.push(path);
      return options.rejectRegister ? Promise.reject(new Error("register failed")) : Promise.resolve(registrationObj);
    },
  };
  const context = {
    globalThis: null,
    location: { reload: () => { reloadCount += 1; } },
    navigator: options.noServiceWorker ? {} : { serviceWorker },
    window: options.bareWindow
      ? {}
      : {
          addEventListener(type, handler) {
            windowListeners.set(type, handler);
          },
        },
  };
  // These are set (or omitted) BEFORE vm.runInNewContext runs the source below —
  // sw-recovery.ts's lifecycle self-invokes at load time (unlike service-worker.ts,
  // which only exposes the function for startup.ts to call), so any "unavailable
  // API" scenario must be true at construction time, not patched in afterward.
  if (!options.noSetInterval) {
    context.setInterval = (fn, ms) => {
      intervalCalls.push({ fn, ms });
      return intervalCalls.length;
    };
  }
  if (!options.noDocument) {
    context.document = {
      visibilityState: options.visibilityState || "visible",
      addEventListener(type, handler) {
        documentListeners.set(type, handler);
      },
    };
  }
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: options.file || "app-service-worker.js" });

  return {
    context,
    listener: (type) => listeners.get(type),
    documentListener: (type) => documentListeners.get(type),
    windowListener: (type) => windowListeners.get(type),
    registerCalls,
    intervalCalls,
    reloadCount: () => reloadCount,
    updateCalls: () => updateCalls,
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

// Both service-worker.ts and sw-recovery.ts implement the same lifecycle
// independently (see the file header on sw-recovery.ts) — whichever loads
// first in the boot sequence is the one that actually runs, so the two must
// stay behaviorally identical. Run the update-check contract against both
// generated outputs.
for (const file of ["app-service-worker.js", "app-sw-recovery.js"]) {
  test(`${file}: becoming visible triggers a throttled registration.update() check`, async () => {
    const env = loadLifecycle({ file, controller: true, visibilityState: "visible" });
    env.context.registerServiceWorkerLifecycle();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(typeof env.documentListener("visibilitychange"), "function");
    env.documentListener("visibilitychange")();
    assert.equal(env.updateCalls(), 1);

    // A second check right away is throttled (within the 5-minute minimum gap).
    env.documentListener("visibilitychange")();
    assert.equal(env.updateCalls(), 1);
  });

  test(`${file}: a hidden visibilitychange does not trigger an update check`, async () => {
    const env = loadLifecycle({ file, controller: true, visibilityState: "hidden" });
    env.context.registerServiceWorkerLifecycle();
    await Promise.resolve();
    await Promise.resolve();

    env.documentListener("visibilitychange")();
    assert.equal(env.updateCalls(), 0);
  });

  test(`${file}: pageshow triggers a throttled registration.update() check`, async () => {
    const env = loadLifecycle({ file, controller: true });
    env.context.registerServiceWorkerLifecycle();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(typeof env.windowListener("pageshow"), "function");
    env.windowListener("pageshow")({ persisted: true });
    assert.equal(env.updateCalls(), 1);

    env.windowListener("pageshow")({ persisted: true });
    assert.equal(env.updateCalls(), 1);
  });

  test(`${file}: schedules a 60-minute update-check interval that calls registration.update()`, async () => {
    const env = loadLifecycle({ file, controller: true });
    env.context.registerServiceWorkerLifecycle();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(env.intervalCalls.length, 1);
    assert.equal(env.intervalCalls[0].ms, 60 * 60 * 1000);
    env.intervalCalls[0].fn();
    assert.equal(env.updateCalls(), 1);
  });

  test(`${file}: a rejected registration.update() never throws`, async () => {
    const env = loadLifecycle({ file, controller: true, rejectUpdate: true });
    env.context.registerServiceWorkerLifecycle();
    await Promise.resolve();
    await Promise.resolve();

    assert.doesNotThrow(() => env.documentListener("visibilitychange")());
    assert.equal(env.updateCalls(), 1);
  });

  test(`${file}: degrades when document is unavailable (no crash, register still happens)`, async () => {
    const env = loadLifecycle({ file, controller: true, noDocument: true });

    assert.doesNotThrow(() => env.context.registerServiceWorkerLifecycle());
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(env.registerCalls, ["/sw.js"]);
    assert.equal(env.documentListener("visibilitychange"), undefined);
    // The other two triggers still wire up independently of document.
    assert.equal(typeof env.windowListener("pageshow"), "function");
    assert.equal(env.intervalCalls.length, 1);
  });

  test(`${file}: degrades when window.addEventListener is unavailable (no crash)`, async () => {
    const env = loadLifecycle({ file, controller: true, bareWindow: true });

    assert.doesNotThrow(() => env.context.registerServiceWorkerLifecycle());
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(env.registerCalls, ["/sw.js"]);
    assert.equal(env.windowListener("pageshow"), undefined);
    assert.equal(typeof env.documentListener("visibilitychange"), "function");
    assert.equal(env.intervalCalls.length, 1);
  });

  test(`${file}: degrades when setInterval is unavailable (no crash)`, async () => {
    const env = loadLifecycle({ file, controller: true, noSetInterval: true });

    assert.doesNotThrow(() => env.context.registerServiceWorkerLifecycle());
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(env.registerCalls, ["/sw.js"]);
    assert.equal(env.intervalCalls.length, 0);
    assert.equal(typeof env.documentListener("visibilitychange"), "function");
    assert.equal(typeof env.windowListener("pageshow"), "function");
  });
}
