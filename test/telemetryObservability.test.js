import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../dist/db.js";
import { extractAgentUsage } from "../dist/agents.js";
import { resolveBuildInfo } from "../dist/build-info.js";
import { buildMcpServer, mcpMetricOperation } from "../dist/mcp.js";
import { getAgentStats, recordAgentRun, pruneAgentRuns } from "../dist/repo/agent-telemetry.js";
import { getRequestPerformance, normalizeServerMetricRoute, recordRequestMetric } from "../dist/repo/request-metrics.js";
import { installSmokeLifetime, smokeMaxRuntimeMs } from "../dist/smoke-lifetime.js";

test("agent telemetry persists taxonomy only and never raw CLI detail", () => {
  const privateText = "private ApoB result /Users/me/data token=secret raw stdout";
  recordAgentRun({
    op: "health synthesis",
    agent: "claude",
    ok: false,
    parsed: false,
    latency_ms: 123,
    tried_json: true,
    status: "invalid_output",
    error_class: "invalid_json",
    error_message: privateText,
    model: "claude model/private",
  });
  const row = db.prepare("SELECT * FROM agent_runs").get();
  assert.equal(row.op, "health_synthesis");
  assert.equal(row.error_class, "invalid_json");
  assert.equal(row.error_message, "invalid_json: agent attempt failed");
  assert.ok(row.build_id);
  assert.equal(row.model, null);
  assert.doesNotMatch(JSON.stringify(row), /private ApoB|Users|secret|raw stdout/);
  db.prepare(`INSERT INTO agent_runs (build_id,op,agent,ok,parsed,tried_json) VALUES ('old-build','test','stub',1,1,0)`).run();
  const stats = getAgentStats();
  assert.equal(stats.build_id, row.build_id);
  assert.equal(stats.runs, 1);
});

test("agent telemetry retention removes old attempts", () => {
  recordAgentRun({ op: "test", agent: "stub", ok: true, parsed: true, latency_ms: 1, tried_json: false });
  db.prepare("UPDATE agent_runs SET created_at=datetime('now','-31 days')").run();
  pruneAgentRuns(Number.MAX_SAFE_INTEGER);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_runs").get().n, 0);
});

test("hourly request histograms provide bounded API and MCP percentiles", () => {
  for (const duration_ms of [10, 20, 40, 100, 900, 2100]) {
    recordRequestMetric({
      protocol: "api",
      method: "GET",
      route: "/api/plan/:id",
      status: 200,
      duration_ms,
    });
  }
  recordRequestMetric({ protocol: "api", method: "GET", route: "/api/plan/:id", status: 500, duration_ms: 300 });
  recordRequestMetric({ protocol: "mcp", method: "POST", route: "ping", status: 200, duration_ms: 80 });
  recordRequestMetric({ protocol: "api", method: "GET", route: "/api/health", status: 200, duration_ms: 1, scope: "internal" });
  const performance = getRequestPerformance(1);
  assert.equal(performance.requests, 8);
  assert.deepEqual(performance.traffic, { product: 8, internal: 1 });
  assert.equal(performance.observed_hours, 1);
  assert.equal(performance.throughput_per_hour, 8);
  assert.equal(performance.by_protocol.api, 7);
  assert.equal(performance.by_protocol.mcp, 1);
  assert.equal(performance.p50_ms, 100);
  assert.equal(performance.p95_ms, 5000);
  assert.equal(performance.top_routes[0].route, "/api/plan/:id");
  assert.equal(performance.top_routes[0].errors, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM request_metric_buckets").get().n < 9, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM request_metric_buckets WHERE route LIKE '%secret%'").get().n, 0);
  assert.ok(db.prepare("SELECT build_id FROM request_metric_buckets LIMIT 1").get().build_id);
});

test("MCP metrics accept registered tools only and bound arbitrary names to unknown", async () => {
  const server = buildMcpServer();
  assert.equal(mcpMetricOperation({ method: "tools/call", params: { name: "get_diagnostics" } }), "get_diagnostics");
  assert.equal(mcpMetricOperation({ method: "tools/call", params: { name: "PrivateApoBTool" } }), "unknown");
  assert.equal(normalizeServerMetricRoute("mcp", "PrivateApoBTool"), "/mcp/unknown");
  assert.equal(mcpMetricOperation({ method: "unbounded/private" }), "unknown");
  await server.close();
});

test("agent usage ignores domain-shaped model fields", () => {
  assert.equal(extractAgentUsage('{"model":"apob_high","input_tokens":7}').model ?? null, null);
  assert.equal(extractAgentUsage('{"usage":{"input_tokens":7},"model":"claude-3-7-sonnet"}').model, "claude-3-7-sonnet");
});

test("build identity prefers a validated environment SHA and has a safe fallback", () => {
  const exact = resolveBuildInfo({ CAIRN_BUILD_SHA: "A".repeat(40) }, () => "b".repeat(40));
  assert.equal(exact.build_sha, "a".repeat(40));
  assert.equal(exact.build_source, "environment");
  const fallback = resolveBuildInfo({}, () => {
    throw new Error("no git");
  });
  assert.equal(fallback.build_sha, null);
  assert.equal(fallback.build_id, "source-unidentified");
});

test("smoke lifetime is opt-in, temp-DB scoped, bounded, and schedules termination", () => {
  assert.equal(smokeMaxRuntimeMs({}), null);
  assert.equal(smokeMaxRuntimeMs({ CAIRN_SMOKE_MODE: "1", DATA_DIR: "/data" }), null);
  assert.equal(
    smokeMaxRuntimeMs({
      CAIRN_SMOKE_MODE: "1",
      DATA_DIR: "/tmp/cairn-smoke-browser-test",
      CAIRN_SMOKE_MAX_RUNTIME_MS: "1",
    }),
    60_000
  );
  let scheduled = null;
  let terminated = false;
  const fakeTimer = { unref() {} };
  const result = installSmokeLifetime({
    env: { CAIRN_SMOKE_MODE: "1", DB_PATH: "/tmp/cairn-smoke-test/db.sqlite", CAIRN_SMOKE_MAX_RUNTIME_MS: "90000" },
    terminate: () => {
      terminated = true;
    },
    setTimer: (fn, ms) => {
      scheduled = { fn, ms };
      return fakeTimer;
    },
  });
  assert.equal(result, fakeTimer);
  assert.equal(scheduled.ms, 90_000);
  scheduled.fn();
  assert.equal(terminated, true);
});
