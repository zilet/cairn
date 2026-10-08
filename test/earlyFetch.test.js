// index.html's inline early fetch (src/earlyFetch.ts): it is admitted by a CSP hash
// computed from the file actually served, and it asks for EXACTLY the paths the
// Today render asks for, with the same token + zone headers api() sends — so api()
// can take each response instead of a second request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { cspScriptHash, earlyFetchCspHash, earlyFetchScript } from "../dist/earlyFetch.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public/index.html"), "utf8");

test("the shell's early-fetch script is admitted by the hash of its served bytes", () => {
  const script = earlyFetchScript(html);
  assert.ok(script, "index.html carries the early fetch");
  const expected = `'sha256-${crypto.createHash("sha256").update(script, "utf8").digest("base64")}'`;
  assert.equal(cspScriptHash(script), expected);
  assert.equal(earlyFetchCspHash(join(root, "public")), expected);
  // It is the ONLY inline script: anything else would be refused by the CSP.
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
  assert.equal(inline.length, 1);
});

function runEarly({ pathname, token = "", date = new Date(2026, 8, 26, 7, 5) }) {
  const calls = [];
  const context = {
    location: { pathname },
    localStorage: { getItem: (key) => (key === "cairn_token" ? token : null) },
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "America/New_York" }) }) },
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ status: 200 });
    },
    Date: class extends Date {
      constructor(...args) {
        if (args.length) super(...args);
        else super(date.getTime());
      }
      static now() {
        return date.getTime();
      }
    },
  };
  context.window = context;
  vm.runInNewContext(earlyFetchScript(html), context);
  return { calls, early: context.__cairnEarly };
}

test("on a Today open it starts the aggregate, the Brief's read and the preview with api()'s headers", () => {
  const { calls: all, early } = runEarly({ pathname: "/app/today", token: " secret " });
  // A token an older build stored is swapped for a session cookie alongside (it still
  // rides the early reads until that lands; nothing waits on it).
  const exchange = all.filter((c) => c.url === "/api/auth/session");
  assert.equal(exchange.length, 1);
  assert.equal(exchange[0].init.headers.Authorization, "Bearer secret");
  const calls = all.filter((c) => !c.url.startsWith("/api/auth/"));
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      // The cheap Brief reads first: the server answers in order on one thread.
      "/api/today-read?date=2026-09-26&agent=auto",
      "/api/daily-session/preview?date=2026-09-26",
      "/api/today?date=2026-09-26&surface=today",
    ]
  );
  for (const call of calls) {
    assert.equal(call.init.headers["X-Cairn-Token"], "secret");
    assert.equal(call.init.headers["X-Cairn-TZ"], "America/New_York");
  }
  // Keyed by the API path api() is called with (no /api prefix).
  assert.deepEqual(Object.keys(early).sort(), [
    "/daily-session/preview?date=2026-09-26",
    "/today-read?date=2026-09-26&agent=auto",
    "/today?date=2026-09-26&surface=today",
  ]);
});

test("the paths match the ones the Today render builds", () => {
  // today-brief-controller.ts and today-screen.ts build these with URLSearchParams.
  const date = "2026-09-26";
  const brief = "/today-read?" + new URLSearchParams({ date, agent: "auto" }).toString();
  const preview = "/daily-session/preview?" + new URLSearchParams({ date }).toString();
  const { early } = runEarly({ pathname: "/" });
  assert.ok(brief in early);
  assert.ok(preview in early);
  assert.ok(`/today?date=${encodeURIComponent(date)}&surface=today` in early);
});

test("it stays quiet off Today and sends no token header without one", () => {
  // A lazy deep link (Train, Horizon, Health, ...; Fuel starts none) starts its own reads instead:
  // test/lazyRoutePreload.test.js.
  for (const pathname of ["/app/today/session", "/app/today/fuel", "/app/you", "/app/you/stone"]) {
    assert.deepEqual(runEarly({ pathname }).calls, [], pathname);
  }
  const { calls } = runEarly({ pathname: "/app" });
  assert.equal(calls.length, 3);
  assert.equal("X-Cairn-Token" in calls[0].init.headers, false);
});
