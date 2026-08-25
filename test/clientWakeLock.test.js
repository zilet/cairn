import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadWakeLock({ supported = true, enabled = false, visibility = "visible", deferRequest = false } = {}) {
  const calls = [];
  const store = new Map();
  if (enabled) store.set("cairn.wakeLock.v1", "1");
  const listeners = new Map();
  const state = { visibility };
  let nextSentinel = 1;
  let pendingResolve = null;

  const sentinels = [];
  const wakeLock = {
    request: async (type) => {
      calls.push(["request", type]);
      if (deferRequest) {
        await new Promise((resolve) => {
          pendingResolve = resolve;
        });
      }
      const id = nextSentinel++;
      const sentinel = {
        id,
        released: false,
        releaseListeners: [],
        release: async () => {
          sentinel.released = true;
          calls.push(["release", id]);
        },
        addEventListener: (name, handler) => {
          if (name === "release") sentinel.releaseListeners.push(handler);
        },
      };
      sentinels.push(sentinel);
      return sentinel;
    },
  };

  const context = {
    Object,
    Promise,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    navigator: supported ? { wakeLock } : {},
    document: {
      get visibilityState() {
        return state.visibility;
      },
      addEventListener: (type, handler) => listeners.set(type, handler),
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/app-wake-lock.js"), "utf8"), context);

  return {
    api: context,
    calls,
    store,
    sentinels,
    resolveRequest: () => {
      const resolve = pendingResolve;
      pendingResolve = null;
      if (typeof resolve === "function") resolve();
    },
    hide: () => {
      state.visibility = "hidden";
      listeners.get("visibilitychange")?.();
    },
    show: () => {
      state.visibility = "visible";
      listeners.get("visibilitychange")?.();
    },
    hasWatcher: () => listeners.has("visibilitychange"),
  };
}

test("wake lock is a silent no-op where the browser has no API", async () => {
  const env = loadWakeLock({ supported: false, enabled: true });

  assert.equal(env.api.wakeLockSupported(), false);
  await env.api.acquireWakeLock();
  await env.api.releaseWakeLock();

  assert.deepEqual(env.calls, []);
});

test("an opened session takes no lock until the athlete has opted in", async () => {
  const env = loadWakeLock({ enabled: false });

  assert.equal(env.api.wakeLockSupported(), true);
  assert.equal(env.api.wakeLockEnabled(), false);
  await env.api.acquireWakeLock();
  assert.deepEqual(env.calls, [], "the preference gates the request, not the API's presence");

  // Flipping the Settings toggle mid-session takes effect at once.
  env.api.setWakeLockEnabled(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(env.calls, [["request", "screen"]]);
  assert.equal(env.store.get("cairn.wakeLock.v1"), "1");
});

test("acquire, re-acquire on return, release on finish", async () => {
  const env = loadWakeLock({ enabled: true });
  env.api.installWakeLockWatcher();
  assert.equal(env.hasWatcher(), true);

  await env.api.acquireWakeLock();
  assert.deepEqual(env.calls, [["request", "screen"]]);

  // A second acquire while one is held must not stack requests.
  await env.api.acquireWakeLock();
  assert.deepEqual(env.calls, [["request", "screen"]]);

  // Hiding releases the lock in the browser; returning takes a fresh one.
  env.hide();
  env.show();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(env.calls, [["request", "screen"], ["request", "screen"]]);

  await env.api.releaseWakeLock();
  assert.deepEqual(env.calls, [["request", "screen"], ["request", "screen"], ["release", 2]]);

  // Once released, a resume must NOT quietly re-take it — the session is over.
  env.hide();
  env.show();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(env.calls, [["request", "screen"], ["request", "screen"], ["release", 2]]);
});

test("request is skipped while hidden — the API rejects there", async () => {
  const env = loadWakeLock({ enabled: true, visibility: "hidden" });

  await env.api.acquireWakeLock();
  assert.deepEqual(env.calls, []);

  env.api.installWakeLockWatcher();
  env.show();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(env.calls, [["request", "screen"]], "the resume path takes the lock it could not take while hidden");
});

test("turning the preference off releases the held lock", async () => {
  const env = loadWakeLock({ enabled: true });
  await env.api.acquireWakeLock();
  assert.deepEqual(env.calls, [["request", "screen"]]);

  env.api.setWakeLockEnabled(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(env.store.has("cairn.wakeLock.v1"), false);
  assert.deepEqual(env.calls, [["request", "screen"], ["release", 1]]);
});

test("overlapping acquires share one in-flight request", async () => {
  const env = loadWakeLock({ enabled: true, deferRequest: true });

  const first = env.api.acquireWakeLock();
  const second = env.api.acquireWakeLock();
  assert.deepEqual(env.calls, [["request", "screen"]], "the second join must not stack a request");
  assert.equal(env.sentinels.length, 0, "the request has not resolved yet");

  env.resolveRequest();
  await Promise.all([first, second]);
  assert.equal(env.sentinels.length, 1);
  assert.equal(env.sentinels[0].released, false);

  await env.api.releaseWakeLock();
  assert.equal(env.sentinels[0].released, true);
  assert.deepEqual(env.calls, [["request", "screen"], ["release", 1]]);
});

test("release during an in-flight request drops the sentinel when it arrives", async () => {
  const env = loadWakeLock({ enabled: true, deferRequest: true });

  const taking = env.api.acquireWakeLock();
  assert.deepEqual(env.calls, [["request", "screen"]]);

  await env.api.releaseWakeLock();
  assert.equal(env.sentinels.length, 0, "nothing to drop until the request resolves");

  env.resolveRequest();
  await taking;

  assert.equal(env.sentinels.length, 1);
  assert.equal(env.sentinels[0].released, true);
  assert.deepEqual(env.calls, [["request", "screen"], ["release", 1]]);

  await env.api.releaseWakeLock();
  assert.deepEqual(env.calls, [["request", "screen"], ["release", 1]], "nothing is held");
});
