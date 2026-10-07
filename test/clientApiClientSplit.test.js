// api-client.ts was split into api-core / api-cache / token-sheet and the five
// outbox modules (docs/V2-PLAN.md, Wave 0 F4). Every caller still reaches the
// same globals, so these tests pin the published surface and the load order
// against the BUILT modules instead of regexing the TypeScript source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { BUNDLES, CLIENT_OUTPUTS } from "../scripts/build-client.mjs";
import { flush, loadClientModule } from "./_dom.mjs";
import { API_CLIENT_MODULES, runApiClientModules } from "./_apiClientModules.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Everything api-client.js published, by name.
const BARE_FUNCTIONS = [
  "authToken",
  "withToken",
  "deviceTimeZone",
  "api",
  "apiBinary",
  "setOffline",
  "outboxEnqueue",
  "outboxSessionDependency",
  "outboxSessionGroupId",
  "outboxSessionPrerequisite",
  "runSessionMutation",
  "outboxResolveSessionPrerequisite",
  "outboxBlockSessionPrerequisite",
  "flushOutbox",
  "outboxCount",
];
const OUTBOX_MEMBERS = [
  "createOutbox",
  "enqueue",
  "flush",
  "count",
  "list",
  "reviewItems",
  "renderBar",
  "openReview",
  "closeReview",
  "retry",
  "discard",
  "itemSummary",
  "sessionGroupId",
  "runSessionMutation",
  "sessionDependency",
  "sessionPrerequisite",
  "resolveSessionPrerequisite",
];
const API_CACHE_MEMBERS = [
  "createApiCoalescer",
  "shouldBypassApiCache",
  "shouldArmGetTimeout",
  "MICRO_TTL_MS",
  "MICRO_CACHE_PATHS",
  "GET_TIMEOUT_MS",
  "ApiError",
  "isTransientApiFailure",
  "normalizeRoute",
  "diagnosticRoute",
];

function bareContext() {
  const context = { Date, JSON, Math, Array, Object, String, Number, Promise, Set, Map };
  context.globalThis = context;
  return context;
}

test("the split modules publish every global api-client.js did", () => {
  const context = runApiClientModules(bareContext());
  for (const name of BARE_FUNCTIONS) assert.equal(typeof context[name], "function", `${name} is still a global`);
  assert.equal(typeof context.CairnApiError, "function");
  assert.equal(context.CairnApiCache.ApiError, context.CairnApiError, "one error class, reachable both ways");
  assert.deepEqual(Object.keys(context.CairnOutbox), OUTBOX_MEMBERS);
  for (const name of OUTBOX_MEMBERS) assert.equal(typeof context.CairnOutbox[name], "function", `CairnOutbox.${name}`);
  for (const name of API_CACHE_MEMBERS) assert.ok(name in context.CairnApiCache, `CairnApiCache.${name}`);
  // The same functions answer through the namespace and the bare global.
  assert.equal(context.CairnOutbox.flush, context.flushOutbox);
  assert.equal(context.CairnOutbox.sessionGroupId, context.outboxSessionGroupId);
  assert.equal(context.CairnOutbox.runSessionMutation, context.runSessionMutation);
});

test("each module loads with only the modules before it, so nothing reaches forward at load time", () => {
  // One context, filled in load order: when module k runs, only modules 0..k-1 exist.
  const context = vm.createContext(bareContext());
  API_CLIENT_MODULES.forEach((name, index) => {
    const source = readFileSync(join(root, `public/js/${name}.js`), "utf8");
    assert.doesNotThrow(
      () => vm.runInContext(source, context),
      `${name} loads after ${API_CLIENT_MODULES.slice(0, index).join(", ") || "nothing"}`
    );
  });
});

test("bundle-01 carries the split modules where api-client.js was, in load order", () => {
  const outputs = CLIENT_OUTPUTS.map((item) => item.output);
  assert.ok(!outputs.includes("public/js/api-client.js"), "the monolith is gone");
  for (const name of API_CLIENT_MODULES) {
    assert.ok(
      CLIENT_OUTPUTS.some((item) => item.source === `src/client/${name}.ts` && item.output === `public/js/${name}.js`),
      `${name} is a client output`
    );
  }
  const core = BUNDLES[0].inputs;
  const start = core.indexOf("public/js/client-diagnostics.js") + 1;
  assert.deepEqual(
    core.slice(start, start + API_CLIENT_MODULES.length),
    API_CLIENT_MODULES.map((name) => `public/js/${name}.js`)
  );
  assert.equal(core[start + API_CLIENT_MODULES.length], "public/js/app-download.js");
  assert.ok(core.indexOf("public/js/ui-sheet.js") < start, "ui-sheet loads before the token sheet and the review");
});

test("the token sheet takes its look from styles.css and injects no <style> of its own", async () => {
  const location = { reload() {} };
  const win = loadClientModule(["html-utils", "ui-sheet", ...API_CLIENT_MODULES], {
    globals: {
      setTimeout: () => 0,
      clearTimeout() {},
      requestAnimationFrame: (fn) => fn(),
      navigator: { onLine: true },
      location,
      fetch: async () => ({ status: 401, headers: { get: () => null }, json: async () => ({}) }),
      toast() {},
    },
  });
  void win.api("/profile");
  await flush();
  assert.ok(win.document.querySelector(".token-sheet-ov .token-sheet"), "the 401 opened the sheet");
  assert.equal(win.document.querySelector("style"), null);

  const styles = readFileSync(join(root, "public/styles.css"), "utf8");
  assert.match(styles, /\.token-sheet-ov\{[^}]*z-index:var\(--z-token\)/);
  assert.match(styles, /\.token-sheet-btn\{[^}]*border-radius:var\(--radius-pill\)/);
});

test("a signed-in write refused 403 origin_mismatch says why (once), rejects, and never opens the sign-in sheet", async () => {
  const said = [];
  const win = loadClientModule(["html-utils", "ui-sheet", ...API_CLIENT_MODULES], {
    globals: {
      setTimeout: () => 0,
      clearTimeout() {},
      requestAnimationFrame: (fn) => fn(),
      navigator: { onLine: true },
      location: { reload() {} },
      fetch: async () => ({
        status: 403,
        headers: { get: () => null },
        json: async () => ({ error: "origin_mismatch" }),
      }),
      toast: (message) => said.push(message),
    },
  });
  const post = () =>
    win.api("/checkins", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(
      () => "resolved",
      (err) => err.status
    );
  assert.equal(await post(), 403, "the caller still sees the failure");
  assert.equal(await post(), 403);
  assert.equal(said.length, 1, "told once per page");
  assert.match(said[0], /Host header|CAIRN_TRUST_PROXY/);
  assert.equal(win.document.querySelector(".token-sheet-ov"), null, "signing in again would not fix it");
});
