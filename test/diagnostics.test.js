import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { apiErrorHandler } from "../dist/api.js";
import {
  apiDiagnosticMiddleware,
  recordSchedulerFailure,
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
import { readinessHandler } from "../dist/routes/system.js";

function responseDouble() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.body = undefined;
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = String(value);
  };
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
        stack: "Error: failed at /private/tmp/cairn/src/client.ts:4:2",
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
  assert.equal(row.route, "/api/health-docs/:id");
  assert.equal(row.operation, "POST /api/health-docs/:id");
  assert.doesNotMatch(row.message, /abc\.def|secret|private coaching|\/Users\//i);
  assert.doesNotMatch(row.stack, /\/private\/tmp/);
  assert.doesNotMatch(row.metadata_json, /health|unknown_body/i);
  assert.deepEqual(JSON.parse(row.metadata_json), { tab: "stand", online: true });
  assert.equal(row.release, "v1.2.3");
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
      route: "/api/plan/123?private=x",
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
  assert.equal(stats.recent.length, 3);
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
    "v9.9.9"
  );
  db.prepare("UPDATE diagnostic_events SET metadata_json = '{broken' WHERE fingerprint = ?").run(
    "render:release-fallback"
  );
  const stats = getDiagnostics({ days: 1, recent: 1 });
  assert.equal(stats.recent[0].release, "v9.9.9");
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
  assert.deepEqual(response.body, {
    ok: true,
    database: "ok",
    queues: {
      agent_jobs: { queued: 1, running: 1 },
      chat_turns: { queued: 1, running: 0 },
    },
  });
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
