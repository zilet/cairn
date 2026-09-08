// LAZY APP-SHELL BUNDLES.
//
// index.html no longer loads the ~460 KB Me/Health bundle; the Stand and Me
// destinations inject it on first navigation. Everything that can go wrong here
// is invisible until a user taps a tab: two <script> tags for one bundle, a
// failed fetch that permanently wedges the destination, or a token/query string
// on the url that would miss the service worker's precache entry offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function fakeDom() {
  const scripts = [];
  function makeScript() {
    const listeners = new Map();
    const node = {
      dataset: {},
      src: "",
      attached: false,
      addEventListener: (type, fn) => listeners.set(type, fn),
      remove() {
        node.attached = false;
        const at = scripts.indexOf(node);
        if (at >= 0) scripts.splice(at, 1);
      },
      fire: (type) => listeners.get(type)?.(),
    };
    return node;
  }
  const document = {
    createElement: () => makeScript(),
    head: {
      appendChild(node) {
        node.attached = true;
        scripts.push(node);
        return node;
      },
    },
    querySelector(selector) {
      const name = /data-cairn-bundle="([^"]+)"/.exec(selector)?.[1];
      const wantLoaded = selector.includes('data-cairn-bundle-loaded="1"');
      return (
        scripts.find((s) => s.dataset.cairnBundle === name && (!wantLoaded || s.dataset.cairnBundleLoaded === "1")) ||
        null
      );
    },
  };
  return { document, scripts };
}

function loadLoader(extra = {}) {
  const source = readFileSync(new URL("../public/js/app-lazy-bundles.js", import.meta.url), "utf8");
  const dom = fakeDom();
  const context = {
    document: dom.document,
    window: {},
    globalThis: null,
    ...extra,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "app-lazy-bundles.js" });
  return { context, ...dom };
}

test("the me-health bundle is injected once, with a precache-matching url", async () => {
  const env = loadLoader();
  assert.equal(typeof env.context.ensureBundle, "function");
  assert.equal(typeof env.context.window.ensureBundle, "function");

  const first = env.context.ensureBundle("me-health");
  const second = env.context.ensureBundle("me-health");
  assert.equal(env.scripts.length, 1, "concurrent callers share one <script>");

  const script = env.scripts[0];
  // No query string, ever: Cache Storage keys on the full url, so `?token=` would
  // miss the worker's precached CORE_ASSETS entry and break the offline first open.
  assert.equal(script.src, "/js/bundle-05-me-health.js");
  assert.equal(script.dataset.cairnBundle, "me-health");
  assert.equal(env.context.bundleLoaded("me-health"), false);

  script.fire("load");
  await Promise.all([first, second]);

  assert.equal(env.context.bundleLoaded("me-health"), true);
  await env.context.ensureBundle("me-health");
  assert.equal(env.scripts.length, 1, "a loaded bundle is never re-injected");
});

test("a failed load rejects and stays retryable", async () => {
  const env = loadLoader();
  const attempt = env.context.ensureBundle("me-health");
  env.scripts[0].fire("error");
  await assert.rejects(attempt, /failed to load \/js\/bundle-05-me-health\.js/);
  assert.equal(env.scripts.length, 0, "the dead tag is removed");

  const retry = env.context.ensureBundle("me-health");
  assert.equal(env.scripts.length, 1, "a later navigation may retry");
  env.scripts[0].fire("load");
  await retry;
  assert.equal(env.context.bundleLoaded("me-health"), true);
});

test("an unknown bundle name rejects instead of injecting anything", async () => {
  const env = loadLoader();
  await assert.rejects(env.context.ensureBundle("not-a-bundle"), /unknown lazy bundle/);
  assert.equal(env.scripts.length, 0);
});

test("loading the bundle re-runs the boot registrations it carries", async () => {
  const calls = [];
  const env = loadLoader({
    registerAppJobReconnectors: () => calls.push("register"),
    jobReconnect: async () => {
      calls.push("reconnect");
    },
  });
  const pending = env.context.ensureBundle("me-health");
  assert.deepEqual(calls, [], "nothing runs before the script executes");
  env.scripts[0].fire("load");
  await pending;
  // The health_review reconnector lives on the Stand screen, so an in-flight
  // review only reattaches once this bundle has landed.
  assert.deepEqual(calls, ["register", "reconnect"]);
});
