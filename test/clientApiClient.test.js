import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function classList() {
  const classes = new Set();
  return {
    add: (name) => classes.add(name),
    remove: (name) => classes.delete(name),
    contains: (name) => classes.has(name),
  };
}

function loadApiClient() {
  const storage = new Map();
  let offlineBar = null;
  const listeners = {};
  const body = {
    classList: classList(),
    appendChild(el) {
      offlineBar = el;
      return el;
    },
  };
  const document = {
    body,
    querySelector(selector) {
      return selector === ".offline-bar" ? offlineBar : null;
    },
    createElement() {
      return {
        classList: classList(),
        className: "",
        attrs: {},
        innerHTML: "",
        setAttribute(name, value) {
          this.attrs[name] = value;
        },
      };
    },
  };
  const calls = [];
  const context = {
    document,
    window: {
      addEventListener(type, fn) {
        listeners[type] = fn;
      },
      prompt() {
        return "";
      },
    },
    navigator: { onLine: true },
    location: { reloaded: false, reload() { this.reloaded = true; } },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "America/New_York" }) }) },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { status: 200, json: async () => ({ ok: true }) };
    },
    requestAnimationFrame: (fn) => fn(),
    encodeURIComponent,
    Promise,
  };
  vm.runInNewContext(readFileSync(join(root, "public/js/api-client.js"), "utf8"), context);
  return { context, storage, calls, body, listeners, getOfflineBar: () => offlineBar };
}

test("api client appends auth tokens to direct resource URLs", () => {
  const { context, storage } = loadApiClient();
  assert.equal(context.withToken("/api/export"), "/api/export");

  storage.set("cairn_token", "owner token");
  assert.equal(context.authToken(), "owner token");
  assert.equal(context.withToken("/api/export"), "/api/export?token=owner%20token");
  assert.equal(context.withToken("/api/export?format=db"), "/api/export?format=db&token=owner%20token");
});

test("api client sends auth and timezone headers on API calls", async () => {
  const { context, storage, calls } = loadApiClient();
  storage.set("cairn_token", "secret");

  const payload = await context.api("/health", { headers: { "X-Test": "1" } });

  assert.deepEqual(payload, { ok: true });
  assert.equal(calls[0].url, "/api/health");
  assert.equal(calls[0].init.headers["X-Test"], "1");
  assert.equal(calls[0].init.headers["X-Cairn-Token"], "secret");
  assert.equal(calls[0].init.headers["X-Cairn-TZ"], "America/New_York");
});

test("api client surfaces and clears the offline hairline", async () => {
  const loaded = loadApiClient();
  loaded.context.fetch = async () => {
    throw new Error("offline");
  };

  await assert.rejects(loaded.context.api("/health"), /offline/);
  assert.equal(loaded.body.classList.contains("is-offline"), true);
  assert.equal(loaded.getOfflineBar().classList.contains("show"), true);

  loaded.context.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) });
  await loaded.context.api("/health");
  assert.equal(loaded.body.classList.contains("is-offline"), false);
  assert.equal(loaded.getOfflineBar().classList.contains("show"), false);
});
