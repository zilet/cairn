import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDiagnostics(options = {}) {
  const storage = new Map();
  if (options.stored) storage.set("cairn.diagnostics.v1", JSON.stringify(options.stored));
  const listeners = {};
  const timers = [];
  const calls = [];
  const context = {
    window: {
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
    },
    navigator: { onLine: true },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "America/New_York" }) }) },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return options.fetch ? options.fetch(url, init) : { status: 204 };
    },
    setTimeout: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    URL,
    Error,
    Math,
    Map,
    JSON,
    Date,
    String,
    Number,
    Object,
    Array,
  };
  context.window.window = context.window;
  vm.runInNewContext(readFileSync(join(root, "public/js/client-diagnostics.js"), "utf8"), context);
  return { context, storage, listeners, timers, calls };
}

test("reporter startup asynchronously flushes a persisted diagnostic queue", async () => {
  const loaded = loadDiagnostics({
    stored: [{
      kind: "api_failure",
      level: "error",
      message: "GET failed",
      route: "/today",
      method: "GET",
      status: 500,
      fingerprint: "persisted-event",
    }],
  });
  assert.equal(loaded.calls.length, 0, "startup does not synchronously block on delivery");
  const startup = loaded.timers.find((timer) => timer.delay === 0);
  assert.ok(startup, "startup replay is scheduled");
  startup.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loaded.calls.length, 1);
  assert.equal(loaded.calls[0].url, "/api/telemetry/client");
  assert.equal(loaded.context.CairnClientDiagnostics.pending().length, 0);
});

test("client diagnostics sanitize query values and credentials, dedupe, and batch directly", async () => {
  const loaded = loadDiagnostics();
  const calls = [];
  let now = 100_000;
  const reporter = loaded.context.CairnClientDiagnosticsCore.createClientDiagnosticReporter({
    storage: loaded.context.localStorage,
    now: () => now,
    schedule: () => {},
    authToken: () => "owner-secret",
    timeZone: () => "America/New_York",
    tab: () => "settings",
    online: () => true,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { status: 204 };
    },
  });

  assert.equal(
    reporter.report({
      kind: "api_failure",
      level: "error",
      message: "GET https://host/api/health?token=supersecret Authorization: Bearer abc123",
      stack: "at run (https://host/app.js?token=supersecret:4:2)",
      route: "/health?chat=private words&token=supersecret",
      method: "get",
      status: 500,
      request_id: "req-1",
    }),
    true
  );
  assert.equal(
    reporter.report({
      kind: "api_failure",
      level: "error",
      message: "duplicate",
      fingerprint: reporter.pending()[0].fingerprint,
    }),
    false
  );
  assert.equal(reporter.pending().length, 1);
  const event = reporter.pending()[0];
  assert.equal(event.route, "/health");
  assert.equal(event.method, "GET");
  assert.equal(event.tab, "settings");
  assert.doesNotMatch(JSON.stringify(event), /supersecret|abc123|private words/);

  await reporter.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/telemetry/client");
  assert.equal(calls[0].init.headers["X-Cairn-Token"], "owner-secret");
  assert.equal(reporter.pending().length, 0);
  now += 31_000;
});

test("failed telemetry delivery is silent, persisted, and nonrecursive", async () => {
  const loaded = loadDiagnostics();
  let attempts = 0;
  const reporter = loaded.context.CairnClientDiagnosticsCore.createClientDiagnosticReporter({
    storage: loaded.context.localStorage,
    schedule: () => {},
    fetch: async () => {
      attempts++;
      throw new Error("reporter offline");
    },
  });
  reporter.report({ kind: "render_error", level: "error", message: "paint failed" });
  await reporter.flush();
  assert.equal(attempts, 1);
  assert.equal(reporter.pending().length, 1, "the original event remains for a later retry");
});

test("a permanently invalid queued event cannot block later diagnostics", async () => {
  const loaded = loadDiagnostics();
  const reporter = loaded.context.CairnClientDiagnosticsCore.createClientDiagnosticReporter({
    storage: loaded.context.localStorage,
    schedule: () => {},
    fetch: async () => ({ status: 400 }),
  });
  reporter.report({ kind: "render_error", level: "error", message: "first" });
  reporter.report({ kind: "unhandled_error", level: "error", message: "second" });
  await reporter.flush();
  assert.equal(reporter.pending().length, 1);
  assert.equal(reporter.pending()[0].kind, "unhandled_error");
});

test("global handlers avoid persisting arbitrary rejection content and tab boundary reports render errors", () => {
  const loaded = loadDiagnostics();
  const reporter = loaded.context.CairnClientDiagnostics;
  loaded.listeners.unhandledrejection({ reason: "private chat text from a rejected value" });
  loaded.listeners.error({ message: "boom", error: new Error("private health and chat content") });
  const events = reporter.pending();
  assert.equal(events.length, 2);
  assert.equal(events[0].message, "Unhandled promise rejection");
  assert.doesNotMatch(JSON.stringify(events), /private chat text/);
  assert.equal(events[1].kind, "unhandled_error");
  assert.equal(events[1].message, "Error: browser operation failed");
  assert.doesNotMatch(JSON.stringify(events), /private health and chat content/);

  const tabs = readFileSync(join(root, "src/client/app/tabs.ts"), "utf8");
  assert.match(tabs, /reportError\?\.\("render_error", err/);
  assert.match(tabs, /tabErrorState\(next\)/, "the existing recovery UI remains intact");
});
