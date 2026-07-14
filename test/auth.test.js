import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryTokenAllowedPath, authStartupError, appleHealthTokenScopeAllows } from "../dist/auth.js";

test("query-token auth is limited to browser-only GET surfaces", () => {
  assert.equal(queryTokenAllowedPath("/api/health-docs/12/file"), true);
  assert.equal(queryTokenAllowedPath("/api/chat/turns/12/stream"), true);
  assert.equal(queryTokenAllowedPath("/api/agent-jobs/12/stream"), true);
  // Background-enrichment status streams (EventSource — no header).
  assert.equal(queryTokenAllowedPath("/api/activities/12/stream"), true);
  assert.equal(queryTokenAllowedPath("/api/food-notes/12/stream"), true);
  assert.equal(queryTokenAllowedPath("/api/health-docs/12/stream"), true);
  // Only GET is ever query-token authed — a POST to the same path is rejected.
  assert.equal(queryTokenAllowedPath("/api/activities/12/stream", "POST"), false);
  assert.equal(queryTokenAllowedPath("/api/export"), true);
  assert.equal(queryTokenAllowedPath("/api/export/db"), true);
  assert.equal(queryTokenAllowedPath("/api/health-export"), true);
  assert.equal(queryTokenAllowedPath("/api/plan.ics"), true);
  assert.equal(queryTokenAllowedPath("/api/chat-images/123e4567-e89b-12d3-a456-426614174000.jpg"), true);
  // Generated artwork is loaded via <img> (can't set headers) → query token must pass.
  assert.equal(queryTokenAllowedPath("/api/art"), true);
});

test("query-token auth is rejected for normal API and MCP routes", () => {
  assert.equal(queryTokenAllowedPath("/api/settings"), false);
  assert.equal(queryTokenAllowedPath("/api/plan"), false);
  assert.equal(queryTokenAllowedPath("/mcp"), false);
  assert.equal(queryTokenAllowedPath("/api/export", "POST"), false);
});

test("CAIRN_REQUIRE_AUTH refuses to boot without a token (fail closed)", () => {
  // The only failing combination: enforcement demanded but no token present.
  const err = authStartupError({ requireAuth: true, authEnabled: false });
  assert.ok(err && /CAIRN_AUTH_TOKEN/.test(err), "should return an actionable message");
});

test("auth startup is permissive in every safe combination", () => {
  // Default (no enforcement) never blocks boot, with or without a token.
  assert.equal(authStartupError({ requireAuth: false, authEnabled: false }), null);
  assert.equal(authStartupError({ requireAuth: false, authEnabled: true }), null);
  // Enforcement satisfied by a configured token.
  assert.equal(authStartupError({ requireAuth: true, authEnabled: true }), null);
});

test("Apple Health ingest credentials have one exact REST scope", () => {
  assert.equal(appleHealthTokenScopeAllows("POST", "/api/health-metrics"), true);
  assert.equal(appleHealthTokenScopeAllows("GET", "/api/health-metrics"), false);
  assert.equal(appleHealthTokenScopeAllows("POST", "/api/apple-health/pairings"), false);
  assert.equal(appleHealthTokenScopeAllows("POST", "/api/settings"), false);
  assert.equal(appleHealthTokenScopeAllows("POST", "/mcp"), false);
});

test("auth middleware accepts an active Apple Health token only for metrics ingest", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cairn-ah-auth-"));
  const script = `
    import assert from "node:assert/strict";
    const auth = await import("./dist/auth.js");
    const repo = await import("./dist/repo/apple-health.js");
    const metricsRoute = await import("./dist/routes/health-metrics.js");
    const allRepo = await import("./dist/repo.js");
    const pairing = repo.createAppleHealthPairing();
    const exchanged = repo.exchangeAppleHealthPairing(pairing.code);
    assert.ok(exchanged);
    const run = (method, path, token) => {
      let next = false, status = 0;
      const req = { method, path, query: {}, get(name) { return name.toLowerCase() === "authorization" && token ? "Bearer " + token : undefined; } };
      const res = { status(value) { status = value; return this; }, json() { return this; } };
      auth.authGuard(req, res, () => { next = true; });
      return { next, status, req };
    };
    const scoped = run("POST", "/api/health-metrics", exchanged.ingest_token);
    assert.deepEqual({ next: scoped.next, status: scoped.status }, { next: true, status: 0 });
    assert.equal(metricsRoute.healthMetricSourceForRequest(scoped.req), "apple_health");
    const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    metricsRoute.ingestHealthMetrics({ source: "garmin", date, steps: 4321 }, metricsRoute.healthMetricSourceForRequest(scoped.req));
    assert.equal(allRepo.getDailyMetrics("apple_health", 14).length, 1);
    assert.equal(allRepo.getDailyMetrics("garmin", 14).length, 0);
    for (const [method, path, token, expected] of [
      ["GET", "/api/health-metrics", exchanged.ingest_token, { next: false, status: 401 }],
      ["POST", "/mcp", exchanged.ingest_token, { next: false, status: 401 }],
      ["GET", "/api/apple-health/config", null, { next: true, status: 0 }],
    ]) {
      const actual = run(method, path, token);
      assert.deepEqual({ next: actual.next, status: actual.status }, expected);
    }
    repo.revokeAppleHealthConnection(exchanged.connection.id);
    const revoked = run("POST", "/api/health-metrics", exchanged.ingest_token);
    assert.deepEqual({ next: revoked.next, status: revoked.status }, { next: false, status: 401 });
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        CAIRN_AUTH_TOKEN: "owner-test-token",
        DATA_DIR: dataDir,
        DB_PATH: join(dataDir, "test.db"),
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
