import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../dist/db.js";
import { extractAgentUsage } from "../dist/agents.js";
import { getBuildInfo, resolveBuildInfo } from "../dist/build-info.js";
import { buildMcpServer, mcpMetricOperation } from "../dist/mcp.js";
import { getAgentStats, recordAgentRun, pruneAgentRuns } from "../dist/repo/agent-telemetry.js";
import {
  getRequestPerformance,
  isInternalMcpMetricOperation,
  normalizeServerMetricRoute,
  recordRequestMetric,
} from "../dist/repo/request-metrics.js";
import { installSmokeLifetime, smokeMaxRuntimeMs } from "../dist/smoke-lifetime.js";
import { agentErrorClass } from "../dist/telemetry-privacy.js";

test("agent telemetry preserves the low-cardinality invalid-contract classification", () => {
  assert.equal(agentErrorClass("invalid_output", "invalid_contract"), "invalid_contract");
});

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
  assert.equal(row.exit_code, null);
  assert.equal(row.input_tokens, null);
  assert.equal(row.output_tokens, null);
  assert.equal(row.model, null);
  assert.doesNotMatch(JSON.stringify(row), /private ApoB|Users|secret|raw stdout/);
  db.prepare(
    `INSERT INTO agent_runs (build_id,op,agent,ok,parsed,tried_json) VALUES ('old-build','test','stub',1,1,0)`
  ).run();
  const stats = getAgentStats();
  assert.equal(stats.build_id, row.build_id);
  assert.equal(stats.runs, 1);
  assert.equal(stats.recent[0].exit_code, null);
  assert.equal(stats.recent[0].input_tokens, null);
  assert.equal(stats.recent[0].output_tokens, null);
  assert.equal(stats.by_agent[0].input_tokens, null);
  assert.equal(stats.by_agent[0].output_tokens, null);
});

test("adaptive chat telemetry is correlated, taxonomy-only, and rolls up lane latency plus TTFT", () => {
  const buildId = getBuildInfo().build_id;
  const turn = db
    .prepare(
      `INSERT INTO chat_turns (status, created_at, finished_at, routing_json, build_id)
       VALUES ('done', datetime('now', '-1 second'), datetime('now'), ?, ?)`
    )
    .run(
      JSON.stringify({ policy_version: "chat-routing-v1", lane: "capture", reason_codes: ["explicit_food_log"] }),
      buildId
    );
  recordAgentRun({
    op: "chat",
    agent: "claude",
    ok: true,
    parsed: true,
    latency_ms: 800,
    tried_json: false,
    lane: "capture",
    policy_version: "chat-routing-v1",
    reason_codes: ["explicit_food_log", "private raw message"],
    requested_model: "claude-sonnet-4-5",
    requested_reasoning: "low",
    effective_reasoning: "low",
    streaming: true,
    ttft_ms: 120,
    chat_turn_id: Number(turn.lastInsertRowid),
    attempt_index: 1,
    escalation_source: null,
  });
  const row = db.prepare("SELECT * FROM agent_runs WHERE op='chat' ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.lane, "capture");
  assert.equal(row.chat_turn_id, Number(turn.lastInsertRowid));
  assert.equal(row.ttft_ms, 120);
  assert.deepEqual(JSON.parse(row.reason_codes_json), ["explicit_food_log"]);
  assert.doesNotMatch(JSON.stringify(row), /private raw message/);
  const stats = getAgentStats();
  const lane = stats.by_lane.find((entry) => entry.lane === "capture");
  assert.equal(lane.runs, 1);
  assert.equal(lane.p50_ms, 1000, "lane latency is durable turn end-to-end time, not provider attempt time");
  assert.equal(lane.p95_ms, 1000);
  assert.equal(lane.p50_ttft_ms, 120);
  assert.equal(stats.recent[0].chat_turn_id, Number(turn.lastInsertRowid));
});

test("adaptive lane telemetry uses durable outcomes and nearest-rank end-to-end percentiles", () => {
  const buildId = getBuildInfo().build_id;
  const routing = JSON.stringify({
    policy_version: "chat-routing-v1",
    lane: "capture",
    reason_codes: ["explicit_food_log", "capture_correction"],
  });
  const quick = db
    .prepare(
      `INSERT INTO chat_turns
        (status, created_at, finished_at, routing_json, capture_food_note_id, idempotent_replays, build_id)
       VALUES ('done', '2026-07-22 00:00:00', '2026-07-22 00:00:00.100', ?, 1, 2, ?)`
    )
    .run(routing, buildId);
  const slow = db
    .prepare(
      `INSERT INTO chat_turns
        (status, created_at, finished_at, routing_json, build_id)
       VALUES ('canceled', '2026-07-22 00:00:00', '2026-07-22 00:00:10', ?, ?)`
    )
    .run(
      JSON.stringify({ policy_version: "chat-routing-v1", lane: "capture", reason_codes: ["explicit_food_log"] }),
      buildId
    );
  db.prepare(
    `INSERT INTO chat_turns (status, created_at, finished_at, routing_json, build_id)
     VALUES ('done', '2026-07-22 00:00:00', '2026-07-22 00:00:20', ?, 'old-build')`
  ).run(routing);
  recordAgentRun({
    op: "chat",
    agent: "claude",
    ok: true,
    parsed: true,
    latency_ms: 99,
    tried_json: false,
    lane: "capture",
    policy_version: "chat-routing-v1",
    reason_codes: ["explicit_food_log"],
    chat_turn_id: Number(slow.lastInsertRowid),
    escalation_source: "coach",
  });
  const stats = getAgentStats();
  const lane = stats.by_lane.find((entry) => entry.lane === "capture");
  assert.equal(lane.runs, 2, "one durable turn per user-visible turn, not per provider attempt");
  assert.equal(stats.build_id, buildId, "lane outcomes use the same build scope as provider attempts");
  assert.equal(lane.done, 1);
  assert.equal(lane.canceled, 1);
  assert.equal(lane.fail, 1);
  assert.equal(lane.instant_captures, 1);
  assert.equal(lane.idempotent_replays, 2);
  assert.equal(lane.capture_corrections, 1);
  assert.equal(lane.escalated, 1);
  assert.equal(lane.p50_ms, 100);
  assert.equal(lane.p95_ms, 10000, "nearest-rank p95 selects the slowest of two samples");
  assert.equal(stats.chat_turns.runs, 2);
  assert.equal(stats.chat_turns.idempotent_replays, 2);
  assert.doesNotMatch(JSON.stringify(stats), /routing_json|2026-07-22 00:00/);
  assert.equal(Number(quick.lastInsertRowid) > 0, true);
});

test("agent telemetry retention removes old attempts", () => {
  recordAgentRun({ op: "test", agent: "stub", ok: true, parsed: true, latency_ms: 1, tried_json: false });
  db.prepare("UPDATE agent_runs SET created_at=datetime('now','-31 days')").run();
  pruneAgentRuns(Number.MAX_SAFE_INTEGER);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_runs").get().n, 0);
});

test("agent-run row cap remains enforced during a same-hour write storm", () => {
  db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 20001)
    INSERT INTO agent_runs (build_id,op,agent,ok,parsed,tried_json)
    SELECT 'old-build','seed','stub',1,1,0 FROM n`);
  for (let i = 0; i < 250; i++)
    recordAgentRun({ op: "storm", agent: "stub", ok: true, parsed: true, latency_ms: 1, tried_json: false });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_runs").get().n <= 20_000, true);
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
  recordRequestMetric({
    protocol: "api",
    method: "GET",
    route: "/api/health",
    status: 200,
    duration_ms: 1,
    scope: "internal",
  });
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
  assert.equal(isInternalMcpMetricOperation("get_diagnostics"), true);
  assert.equal(isInternalMcpMetricOperation("get_agent_stats"), true);
  assert.equal(isInternalMcpMetricOperation("get_profile"), false);
  await server.close();
});

test("agent usage ignores domain-shaped model fields", () => {
  assert.equal(extractAgentUsage('{"model":"apob_high","input_tokens":7}').model ?? null, null);
  assert.deepEqual(extractAgentUsage('{"model":"gpt-private_apob_plan","input_tokens":987,"output_tokens":654}'), {
    model: null,
    input_tokens: null,
    output_tokens: null,
  });
  assert.deepEqual(extractAgentUsage('{"usage":{"input_tokens":7,"output_tokens":3},"model":"claude-3-7-sonnet"}'), {
    model: null,
    input_tokens: null,
    output_tokens: null,
  });
  assert.deepEqual(
    extractAgentUsage(
      '{"type":"result","subtype":"success","usage":{"input_tokens":7,"output_tokens":3},"model":"claude-3-7-sonnet"}'
    ),
    { model: "claude-3-7-sonnet", input_tokens: 7, output_tokens: 3 }
  );
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
