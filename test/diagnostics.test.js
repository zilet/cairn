import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { apiErrorHandler } from "../dist/api.js";
import {
  apiDiagnosticMiddleware,
  isOrdinaryProductRequest,
  matchedApiRoute,
  recordSchedulerFailure,
  recordAsyncFailure,
  registerProcessDiagnosticHandlers,
} from "../dist/diagnostics.js";
import { db } from "../dist/db.js";
import {
  getDiagnostics,
  ingestClientDiagnosticEvents,
  parseClientDiagnosticBatch,
  pruneDiagnosticEvents,
  recordDiagnosticEvent,
  sanitizeDiagnosticText,
} from "../dist/repo/diagnostics.js";
import { clientTelemetryHandler } from "../dist/routes/operator.js";
import { readinessHandler, schedulerReadiness } from "../dist/routes/system.js";

function responseDouble() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.body = undefined;
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = String(value);
  };
  res.getHeader = (name) => res.headers[String(name).toLowerCase()];
  res.status = (status) => {
    res.statusCode = status;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.end = () => res;
  return res;
}

test("diagnostic storage scrubs sensitive detail and normalizes routes", () => {
  const body = {
    events: [
      {
        kind: "api_failure",
        level: "error",
        message:
          "Bearer abc.def token=secret prompt='private coaching' at /Users/me/cairn/src/a.ts https://x.test/api/foo?token=secret",
        stack: "Error: private family detail\n    at render (/private/tmp/cairn/src/client.ts:4:2)",
        route: "/api/health-docs/123?token=secret&marker=LDL",
        method: "post",
        status: 500,
        duration_ms: 42,
        request_id: "req-1",
        fingerprint: "api:health-failure",
        tab: "stand",
        online: true,
        release: "v1.2.3",
        unknown_body: { health: "never stored" },
      },
    ],
  };
  const parsed = parseClientDiagnosticBatch(body);
  assert.ok(parsed);
  assert.equal(parsed.length, 1);
  ingestClientDiagnosticEvents(parsed);

  const row = db.prepare("SELECT * FROM diagnostic_events").get();
  assert.equal(row.route, "/api/health-docs");
  assert.equal(row.operation, "POST /api/health-docs");
  assert.equal(row.fingerprint, "client:api_failure:POST:/api/health-docs:500");
  assert.equal(row.message, "Client API request failed");
  assert.doesNotMatch(row.stack, /\/private\/tmp/);
  assert.doesNotMatch(row.metadata_json, /health|unknown_body/i);
  assert.deepEqual(JSON.parse(row.metadata_json), { tab: "stand", online: true });
  assert.equal(row.release, null);
  assert.doesNotMatch(sanitizeDiagnosticText("password=hunter2 cookie=abc"), /hunter2|cookie=abc/);
  assert.doesNotMatch(sanitizeDiagnosticText("LDL 150 mg/dl and weight=180 lb"), /150|180/);
});

test("client telemetry validation rejects malformed and oversized batches", () => {
  assert.equal(parseClientDiagnosticBatch({ events: [] }), null);
  assert.equal(parseClientDiagnosticBatch({ events: Array.from({ length: 21 }, () => ({})) }), null);
  assert.equal(
    parseClientDiagnosticBatch({ events: [{ kind: "made_up", level: "error", message: "x", fingerprint: "x" }] }),
    null
  );
  assert.equal(
    parseClientDiagnosticBatch({
      events: [{ kind: "render_error", level: "error", message: "x", fingerprint: "x", route: "/not-api?secret=y" }],
    }),
    null
  );
});

test("operator telemetry endpoint validates batches and returns 204", () => {
  const invalid = responseDouble();
  clientTelemetryHandler({ body: { events: [] } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.body, { error: "invalid telemetry batch" });

  const accepted = responseDouble();
  clientTelemetryHandler(
    {
      body: {
        events: [{ kind: "render_error", level: "error", message: "render failed", fingerprint: "render:today" }],
      },
    },
    accepted
  );
  assert.equal(accepted.statusCode, 204);
  assert.equal(accepted.body, undefined);
});

test("request correlation returns generic 500 and records one bounded issue", () => {
  const request = {
    method: "GET",
    baseUrl: "/api",
    route: { path: "/test-error" },
    originalUrl: "/api/test-error?token=do-not-store",
    url: "/test-error?token=do-not-store",
  };
  const response = responseDouble();
  apiDiagnosticMiddleware(request, response, () => {});
  const id = response.headers["x-request-id"];
  assert.ok(id);
  const privateText = "Milos private Friday meal and family plan\nsecond private health line";
  const logs = [];
  const originalError = console.error;
  console.error = (message) => logs.push(String(message));
  try {
    apiErrorHandler(new TypeError(privateText), request, response, () => {});
  } finally {
    console.error = originalError;
  }
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { error: "internal error", request_id: id });
  response.emit("finish");

  const exception = db
    .prepare("SELECT * FROM diagnostic_events WHERE kind = 'server_exception' ORDER BY id DESC LIMIT 1")
    .get();
  assert.equal(exception.request_id, id);
  assert.equal(exception.route, "/api/test-error");
  assert.equal(exception.message, "TypeError: server operation failed");
  assert.doesNotMatch(exception.stack, new RegExp(privateText));
  assert.doesNotMatch(exception.stack, /do-not-store/);
  assert.match(logs.join(" "), new RegExp(`${id}.*TypeError`));
  assert.doesNotMatch(logs.join(" "), new RegExp(privateText));
  const rows = db.prepare("SELECT kind FROM diagnostic_events WHERE request_id = ?").all(id);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["server_exception"]
  );
});

test("diagnostic rollups group issues and expose recent and slow events", () => {
  for (let i = 0; i < 2; i++) {
    recordDiagnosticEvent({
      source: "api",
      kind: "http_error",
      level: "error",
      route: "/api/plan/:id",
      trusted_route_template: true,
      status: 500,
      fingerprint: "api:plan:500",
      message: "HTTP 500",
    });
  }
  recordDiagnosticEvent({
    source: "api",
    kind: "slow_request",
    level: "warning",
    route: "/api/plan",
    trusted_route_template: true,
    status: 200,
    duration_ms: 2500,
    fingerprint: "api:slow:plan",
    message: "Request exceeded 2000 ms",
  });
  const stats = getDiagnostics({ days: 999, recent: 999 });
  assert.equal(stats.window_days, 365);
  assert.equal(stats.total, 3);
  assert.deepEqual(stats.by_source, { api: 3 });
  assert.deepEqual(stats.by_kind, { http_error: 2, slow_request: 1 });
  assert.deepEqual(stats.by_route, [
    { route: "/api/plan/:id", count: 2 },
    { route: "/api/plan", count: 1 },
  ]);
  assert.equal(stats.issues.find((issue) => issue.fingerprint === "api:plan:500").count, 2);
  assert.equal(stats.recent.length, 2);
  assert.equal(stats.recent.find((event) => event.fingerprint === "api:plan:500").occurrence_count, 2);
  assert.equal(stats.slow.length, 1);
  assert.equal(stats.slow[0].duration_ms, 2500);
  assert.equal(getDiagnostics({ days: 0, recent: 0 }).window_days, 1);
});

test("diagnostic retention removes events older than 30 days", () => {
  recordDiagnosticEvent({ source: "process", kind: "test", level: "error", fingerprint: "old", message: "old" });
  db.prepare("UPDATE diagnostic_events SET created_at = datetime('now', '-31 days') WHERE fingerprint = 'old'").run();
  pruneDiagnosticEvents();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM diagnostic_events WHERE fingerprint = 'old'").get().n, 0);
});

test("diagnostic row cap remains enforced during a same-hour write storm", () => {
  db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 20001)
    INSERT INTO diagnostic_events (source,kind,level,fingerprint,release)
    SELECT 'worker','storm','error','seed-' || x,'old@build' FROM n`);
  for (let i = 0; i < 250; i++)
    recordDiagnosticEvent({ source: "worker", kind: "storm", level: "error", fingerprint: `live-${i}`, release: "new@build" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM diagnostic_events").get().n <= 20_000, true);
});

test("client batches use the server release fallback and tolerate malformed stored metadata", () => {
  ingestClientDiagnosticEvents(
    [
      {
        source: "client",
        kind: "render_error",
        level: "error",
        message: "render failed",
        fingerprint: "render:release-fallback",
      },
    ],
    "v9.9.9@abc123def456"
  );
  db.prepare("UPDATE diagnostic_events SET metadata_json = '{broken' WHERE kind = 'render_error'").run();
  const stats = getDiagnostics({ days: 1, recent: 1 });
  assert.equal(stats.recent[0].release, "v9.9.9@abc123def456");
  assert.equal(stats.recent[0].metadata, null);
});

test("fresh schema includes diagnostic table and query indexes", () => {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(diagnostic_events)")
      .all()
      .map((row) => row.name)
  );
  for (const name of [
    "source",
    "kind",
    "level",
    "route",
    "request_id",
    "fingerprint",
    "message",
    "stack",
    "occurrence_count",
    "first_seen",
    "created_at",
  ]) {
    assert.ok(columns.has(name), name);
  }
  const indexes = new Set(
    db
      .prepare("PRAGMA index_list(diagnostic_events)")
      .all()
      .map((row) => row.name)
  );
  assert.ok(indexes.has("idx_diagnostic_events_created"));
  assert.ok(indexes.has("idx_diagnostic_events_issue"));
  assert.ok(indexes.has("idx_diagnostic_events_route"));
});

test("readiness verifies SQLite and reports compact queue backlog", () => {
  db.prepare("INSERT INTO agent_jobs (kind, status) VALUES ('day_read', 'queued')").run();
  db.prepare("INSERT INTO agent_jobs (kind, status) VALUES ('day_read', 'running')").run();
  db.prepare("INSERT INTO chat_turns (status) VALUES ('queued')").run();
  const response = responseDouble();
  readinessHandler({}, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.database, "ok");
  assert.deepEqual(response.body.queues.agent_jobs.queued, 1);
  assert.deepEqual(response.body.queues.agent_jobs.running, 1);
  assert.deepEqual(response.body.queues.chat_turns.queued, 1);
  assert.equal(response.body.queues.agent_jobs.failed_24h, 0);
  assert.ok(["starting", "fresh"].includes(response.body.scheduler.status));
  assert.ok(response.body.build.build_id);
});

test("async failures use generic class-only detail and coalesce duplicate storms", () => {
  const privateText = "private family health narrative with token xyz";
  recordAsyncFailure("agent jobs", "brain review", new TypeError(privateText));
  recordAsyncFailure("agent jobs", "brain review", new TypeError(privateText));
  const rows = db.prepare("SELECT * FROM diagnostic_events WHERE source='worker'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occurrence_count, 2);
  assert.equal(rows[0].fingerprint, "worker:final_failure:agent_jobs:brain_review:TypeError");
  assert.doesNotMatch(JSON.stringify(rows), /private family|token xyz/);
});

test("process handler records rejections and exits after uncaught exceptions", () => {
  const emitter = new EventEmitter();
  const captured = [];
  const logs = [];
  const exits = [];
  const remove = registerProcessDiagnosticHandlers({
    process: emitter,
    sink: (event) => captured.push(event),
    log: (message) => logs.push(message),
    exit: (code) => exits.push(code),
  });
  const privateText = "private ApoB discussion with family travel details\nsecond private line";
  emitter.emit("unhandledRejection", new TypeError(privateText));
  emitter.emit("uncaughtException", new Error(privateText));
  remove();
  assert.deepEqual(
    captured.map((event) => event.kind),
    ["unhandled_rejection", "uncaught_exception"]
  );
  assert.deepEqual(exits, [1]);
  assert.equal(emitter.listenerCount("uncaughtException"), 0);
  assert.deepEqual(
    captured.map((event) => event.message),
    ["TypeError: process failure", "Error: process failure"]
  );
  assert.doesNotMatch(JSON.stringify(captured), new RegExp(privateText));
  assert.match(logs.join(" "), /TypeError|Error/);
  assert.doesNotMatch(logs.join(" "), new RegExp(privateText));
});

test("scheduler failures share the bounded diagnostic contract", () => {
  const captured = [];
  const privateText = "private health plan and API token=secret";
  recordSchedulerFailure("nightly health pass", new TypeError(privateText), (event) => captured.push(event));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].source, "scheduler");
  assert.equal(captured[0].kind, "task_failure");
  assert.equal(captured[0].operation, "nightly_health_pass");
  assert.equal(captured[0].message, "TypeError: scheduled operation failed");
  assert.doesNotMatch(JSON.stringify(captured), /private health plan|secret/);
});

test("scheduler readiness is deterministic and optional providers never gate it", () => {
  const now = Date.parse("2026-07-10T12:00:00Z");
  assert.deepEqual(schedulerReadiness(null, { now_ms: now, uptime_sec: 30 }), { status: "starting", age_sec: null, ok: true });
  assert.deepEqual(schedulerReadiness("2026-07-10T11:59:00Z", { now_ms: now, uptime_sec: 999 }), { status: "fresh", age_sec: 60, ok: true });
  assert.deepEqual(schedulerReadiness("2026-07-10T11:50:00Z", { now_ms: now, uptime_sec: 999 }), { status: "stale", age_sec: 600, ok: false });
});

test("matched templates discard named values and SSE/probes stay outside product latency", () => {
  assert.equal(matchedApiRoute({ baseUrl: "/api", route: { path: "/exercises/:name" } }), "/api/exercises/:name");
  assert.equal(matchedApiRoute({ baseUrl: "/api", route: undefined }), "/api/unknown");
  const sse = responseDouble();
  sse.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  assert.equal(isOrdinaryProductRequest(sse, "/api/turns/:id/stream"), false);
  assert.equal(isOrdinaryProductRequest(responseDouble(), "/api/health"), false);
  assert.equal(isOrdinaryProductRequest(responseDouble(), "/api/ready"), false);
  assert.equal(isOrdinaryProductRequest(responseDouble(), "/api/diagnostics"), false);
  assert.equal(isOrdinaryProductRequest(responseDouble(), "/api/agent-stats"), false);
  assert.equal(isOrdinaryProductRequest(responseDouble(), "/api/telemetry/client"), false);
  assert.equal(isOrdinaryProductRequest(responseDouble(), "/api/art/stats"), false);
  assert.equal(isOrdinaryProductRequest(responseDouble(), "/api/plan"), true);

  const streamReq = { method: "GET", baseUrl: "/api", route: { path: "/turns/:id/stream" } };
  const streamRes = responseDouble();
  apiDiagnosticMiddleware(streamReq, streamRes, () => {});
  streamRes.setHeader("Content-Type", "text/event-stream");
  streamRes.emit("finish");
  const probeReq = { method: "GET", baseUrl: "/api", route: { path: "/ready" } };
  const probeRes = responseDouble();
  apiDiagnosticMiddleware(probeReq, probeRes, () => {});
  probeRes.emit("finish");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM request_metric_buckets WHERE route LIKE '%stream%'").get().n, 0);
  assert.deepEqual(db.prepare("SELECT scope,route FROM request_metric_buckets").all().map((row) => ({ ...row })), [
    { scope: "internal", route: "/api/ready" },
  ]);
});

test("client identifiers are server-derived and adversarial values never persist", () => {
  const parsed = parseClientDiagnosticBatch({ events: [{ kind: "api_failure", level: "error",
    message: "ignored private text", fingerprint: "MilosPrivateApoBPlan",
    request_id: "PrivateFamilyRequestIdentifier", tab: "FamilyVacationSecret",
    route: "/api/exercises/NamedPrivateExercise", method: "GET", status: 500 }] });
  assert.ok(parsed);
  ingestClientDiagnosticEvents(parsed, "1.0.0@build-a");
  const stored = db.prepare("SELECT fingerprint,route,request_id,metadata_json FROM diagnostic_events").get();
  assert.equal(stored.fingerprint, "client:api_failure:GET:/api/exercises:500");
  assert.equal(stored.route, "/api/exercises");
  assert.equal(stored.request_id, null);
  assert.deepEqual(JSON.parse(stored.metadata_json), { tab: "unknown", online: null });
  assert.doesNotMatch(JSON.stringify(stored), /Milos|ApoB|Vacation|NamedPrivate/);
});

test("diagnostic coalescing never crosses or relabels releases", () => {
  for (const release of ["1.0.0@build-a", "1.0.0@build-a", "1.0.0@build-b"])
    recordDiagnosticEvent({ source: "worker", kind: "failure", level: "error", fingerprint: "same", release });
  const rows = db.prepare("SELECT release,occurrence_count FROM diagnostic_events ORDER BY id").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { release: "1.0.0@build-a", occurrence_count: 2 },
    { release: "1.0.0@build-b", occurrence_count: 1 },
  ]);
  assert.equal(getDiagnostics().issues.length, 2);
});

test("diagnostics preserve history but mark and isolate the current build", () => {
  const initial = getDiagnostics();
  const release = `${initial.build.version}@${initial.build.build_id}`;
  recordDiagnosticEvent({ source: "worker", kind: "failure", level: "error", fingerprint: "current", release });
  recordDiagnosticEvent({ source: "worker", kind: "failure", level: "error", fingerprint: "prior", release: "0.9.0@prior-build" });
  const stats = getDiagnostics();
  assert.equal(stats.total, 2);
  assert.equal(stats.issues.length, 2);
  assert.equal(stats.current_build.scope, "current_build");
  assert.equal(stats.current_build.release, release);
  assert.equal(stats.current_build.total, 1);
  assert.equal(stats.current_build.prior_build_total, 1);
  assert.deepEqual(stats.current_build.issues.map((issue) => issue.fingerprint), ["current"]);
});
