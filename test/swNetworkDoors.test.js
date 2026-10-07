// The service worker answers app navigations with the cached shell — and NOTHING else
// that a server must render. An MCP connector's OAuth consent flow (GET/POST
// /oauth/authorize, its same-site hop, the return after sign-in) and the discovery
// documents under /.well-known/ go to the network, as does any non-GET request: a
// cached index.html there strands the connector flow on the app shell forever.
//
// Driven through the real public/sw.js fetch handler in a vm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

function fetchHandler() {
  const listeners = {};
  const context = {
    URL,
    JSON,
    Promise,
    Set,
    Map,
    Error,
    setTimeout,
    caches: { match: async () => undefined, open: async () => ({ match: async () => undefined }) },
    fetch: async () => ({ ok: true, status: 200 }),
    self: {
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      skipWaiting() {},
      clients: { claim: async () => {} },
    },
  };
  vm.runInNewContext(SOURCE, context, { filename: "sw.js" });
  return listeners.fetch;
}

/** True when the worker took the request (respondWith), false when it fell through to the network. */
function intercepted(handler, path, { method = "GET", mode = "navigate" } = {}) {
  let responded = false;
  handler({
    request: { url: `https://cairn.example${path}`, method, mode },
    respondWith: (p) => {
      responded = true;
      Promise.resolve(p).catch(() => {});
    },
  });
  return responded;
}

test("OAuth doors, discovery and every non-GET navigation reach the network", () => {
  const handler = fetchHandler();
  for (const path of [
    "/oauth/authorize?client_id=x&redirect_uri=y",
    "/oauth/authorize?rid=abc",
    "/oauth/token",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    assert.equal(intercepted(handler, path), false, `${path} must not be answered from the cache`);
  }
  assert.equal(intercepted(handler, "/oauth/authorize", { method: "POST" }), false);
  assert.equal(intercepted(handler, "/", { method: "POST" }), false, "a form POST is never the shell");
  assert.equal(intercepted(handler, "/app/today", { method: "POST", mode: "same-origin" }), false);
});

test("an app navigation is still the cached shell, cache-first", () => {
  const handler = fetchHandler();
  assert.equal(intercepted(handler, "/"), true);
  assert.equal(intercepted(handler, "/app/train"), true);
  assert.equal(intercepted(handler, "/oauthish-looking-route"), true, "only the /oauth/ door is exempt");
  assert.equal(intercepted(handler, "/api/today"), false);
});
