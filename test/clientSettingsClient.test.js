import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(v) {
  return escHtml(v).replace(/"/g, "&quot;");
}

function loadSettingsClient() {
  const context = { Math, Number, String, Object, Array, Set, Date, Intl, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-client.js"), "utf8"), context);
  return context.CairnSettingsClient;
}

test("settings Garmin status line escapes server status and handles sync states", () => {
  const settings = loadSettingsClient();
  const opts = { relTime: () => "2 hours ago" };

  assert.match(settings.garminStatusLine(null, true, opts), /Syncing/);
  assert.match(settings.garminStatusLine({}, false, opts), /Never synced/);

  const html = settings.garminStatusLine(
    {
      garmin_last_sync_at: "2026-06-29T12:00:00Z",
      garmin_last_sync_status: "ok: 12 activities <bad>",
    },
    false,
    opts
  );
  assert.match(html, /Synced 2 hours ago · 12 activities &lt;bad&gt;/);
});

test("settings agent health and activity stay qualitative and escaped", () => {
  const settings = loadSettingsClient();
  const health = settings.agentHealthCard({
    runs: 3,
    ok_rate: 0.67,
    by_agent: [
      { agent: "<Claude>", ok: 2, fail: 1, auth_required: 1, p50_ms: 1250, input_tokens: 1200, output_tokens: 300 },
    ],
    by_op: [{ op: "chat", runs: 2, ok: 1, fail: 1 }],
  });
  assert.match(health, /Agent health · last 7 days/);
  assert.match(health, /In the last 7 days, most runs completed/);
  assert.match(health, /mostly clean · 1.3s typical · 1 connect · 1.5k tok/);
  assert.match(health, /answered in chat · 2 · 1 fallback/);
  assert.match(health, /&lt;Claude&gt;/);
  assert.doesNotMatch(health, /\b67\b|0\.67/);

  const activity = settings.agentActivityCard(
    {
      recent: [
        {
          op: "chat_distill",
          agent: "Claude",
          created_at: "2026-06-29 12:00:00",
          ok: true,
          parsed: true,
          tried_json: false,
          model: "sonnet",
          input_tokens: 100,
          output_tokens: 20,
        },
        {
          op: "custom_op",
          agent: "<Bad>",
          created_at: "2026-06-29 12:01:00",
          ok: false,
          parsed: false,
          tried_json: false,
          status: "auth_required",
          error_message: `Please run /login <bad>`,
        },
      ],
    },
    { relTime: () => "now", absDate: () => "June 29, 2026" }
  );
  assert.match(activity, /saved chat to memory/);
  assert.match(activity, /custom op/);
  assert.match(activity, /&lt;Bad&gt;/);
  assert.match(activity, /sonnet/);
  assert.match(activity, /120 tok/);
  assert.match(activity, /clean/);
  assert.match(activity, /connect/);
  assert.match(activity, /Please run \/login &lt;bad&gt;/);
});

test("settings agent health keeps older telemetry compatible and renders chat lanes when present", () => {
  const settings = loadSettingsClient();
  const older = settings.agentHealthCard({ runs: 1, by_agent: [] });
  assert.doesNotMatch(older, /Chat lanes/);

  const health = settings.agentHealthCard({
    runs: 3,
    by_lane: [{ lane: "<deep>", runs: 2, p50_ms: 1200, p95_ms: 2800, ttft_p50_ms: 300, ttft_p95_ms: 700 }],
  });
  assert.match(health, /Chat lanes/);
  assert.match(health, /&lt;deep&gt;/);
  assert.match(health, /2 runs · 1\.2s p50 \/ 2\.8s p95 · TTFT 300ms \/ 700ms p95/);
  assert.doesNotMatch(health, /\$/);
});

test("settings noticed card escapes durable learning text", () => {
  const settings = loadSettingsClient();
  assert.equal(settings.noticedCard({ learnings: [] }), "");
  const html = settings.noticedCard(
    {
      learnings: [{ content: "<script>prefer easy runs</script>", noticed_at: "2026-06-29 12:00:00" }],
    },
    { relTime: () => "today", absDate: () => "June 29, 2026" }
  );
  assert.match(html, /What Cairn has noticed/);
  assert.match(html, /&lt;script&gt;prefer easy runs&lt;\/script&gt;/);
  assert.match(html, /today/);
});

test("brain diagnostics stay bounded, qualitative, and escaped", () => {
  const settings = loadSettingsClient();
  const html = settings.brainDiagnosticsCard({
    metrics: {
      decisions: { material: 4, with_expectations: 3 },
      expectations: { matured: 2, matured_evaluated: 2 },
      autonomy: { resolved: 3, reverted: 1, demoted_domains: ["training"] },
      tools: { calls: 8, failed: 1, budget_exhausted: 0 },
      conferences: { jobs: 3, successful: 3, complete_successful: 1, useful_degraded_or_incomplete: 2 },
    },
    decisions: [
      { summary: "<b>Small plan change</b>", domain: "training", status: "applied", latest_verdict: "not_aligned" },
    ],
    tool_calls: [{ tool: "read_exercise_history", op: "coach", rows_returned: 8, status: "ok" }],
  });
  assert.match(html, /Brain diagnostics/);
  assert.match(html, /&lt;b&gt;Small plan change&lt;\/b&gt;/);
  assert.match(html, /not aligned/);
  assert.match(html, /read_exercise_history/);
  assert.match(html, /8 rows/);
  assert.match(html, /3 of 4 material decisions/);
  assert.match(html, /2 of 2 mature expectations/);
  assert.match(html, /1 of 3 case conferences were complete/);
  assert.match(html, /2 returned useful partial or degraded advice/);
  assert.doesNotMatch(html, /3 of 3 case conferences completed/);
  assert.match(html, /Review-first after repeated reversals: training/);
  assert.doesNotMatch(html, /hidden_reasoning_payload/i);
});

test("settings agent chips and update card render stable operator states", () => {
  const settings = loadSettingsClient();
  const absent = settings.agentChipState({ present: false });
  assert.equal(absent.cls, "agent-chip-absent");
  assert.equal(absent.label, "Not installed");
  const connected = settings.agentChipState({ configured: true });
  assert.equal(connected.cls, "agent-chip-ok");
  assert.equal(connected.label, "✓ Connected");
  const connect = settings.agentChipState({ configured: false });
  assert.equal(connect.cls, "agent-chip-connect");
  assert.equal(connect.label, "Connect →");

  assert.match(settings.updateCardHtml(null, { updateCheckEnabled: true }), /Checking/);
  assert.match(
    settings.updateCardHtml({ current: "0.7.4" }, { updateCheckEnabled: false }),
    /Automatic update checks are off/
  );

  const html = settings.updateCardHtml(
    {
      current: "0.7.4",
      latest: "0.8.0",
      update_available: true,
      html_url: `https://example.com/"notes"`,
      checked_at: "2026-06-29T12:15:00Z",
    },
    { updateCheckEnabled: true }
  );
  assert.match(html, /v0\.8\.0 is available/);
  assert.match(html, /href="https:\/\/example\.com\/&quot;notes&quot;"/);
  assert.match(html, /releases\/latest\/download\/docker-compose\.yml/);
  assert.match(html, /mv docker-compose\.yml\.new docker-compose\.yml/);
  assert.match(html, /docker compose pull &amp;&amp; docker compose up -d/);
});

test("system health distinguishes loading, unavailable, healthy zero, warning, and error", () => {
  const settings = loadSettingsClient();
  assert.match(
    settings.diagnosticsCard(null, { status: "loading", readinessStatus: "loading", days: 1 }),
    /Checking system health/
  );
  assert.match(
    settings.diagnosticsCard(null, { status: "loading", readinessStatus: "loading", days: 1 }),
    /last 24 hours/
  );
  const unavailable = settings.diagnosticsCard(null, { status: "unavailable", readinessStatus: "unavailable" });
  assert.match(unavailable, /Diagnostics unavailable/);
  assert.match(unavailable, /Readiness unavailable/);
  assert.match(unavailable, /different from a valid zero-event response/);
  assert.match(unavailable, /data-system-retry/);

  const healthy = settings.diagnosticsCard(
    { window_days: 7, total: 0, issues: [], recent: [], slow: [] },
    {
      readinessStatus: "ready",
      readiness: {
        ok: true,
        database: "ok",
        scheduler: { status: "fresh", age_sec: 8 },
        queues: {
          agent_jobs: { queued: 0, running: 0, oldest_age_sec: null, failed_24h: 0 },
          chat_turns: { queued: 0, running: 0, oldest_age_sec: null, failed_24h: 0 },
        },
      },
    }
  );
  assert.match(healthy, /System is ready/);
  assert.match(healthy, /Healthy zero-event response/);
  assert.doesNotMatch(healthy, /Diagnostics unavailable/);

  const older = settings.diagnosticsCard(
    { window_days: 7, total: 0, issues: [], recent: [], slow: [] },
    {
      readinessStatus: "ready",
      readiness: {
        ok: true,
        database: "ok",
        queues: { agent_jobs: { queued: 0, running: 0 }, chat_turns: { queued: 0, running: 0 } },
      },
    }
  );
  assert.match(older, /Operational warnings captured/);
  assert.match(older, /Scheduler freshness is not reported by this version/);
  assert.match(older, /Queue age and recent-failure detail are not reported by this version/);
  assert.doesNotMatch(older, /Healthy zero-event response/);

  const warning = settings.diagnosticsCard(
    {
      window_days: 7,
      total: 1,
      issues: [{ source: "server", kind: "slow_request", level: "warning", count: 1, route: "/api/today" }],
      recent: [],
      slow: [],
    },
    { readinessStatus: "ready", readiness: { ok: true, database: "ok" } }
  );
  assert.match(warning, /Operational warnings captured/);
  assert.match(warning, /actlog-warning/);

  const error = settings.diagnosticsCard(
    {
      window_days: 7,
      total: 1,
      issues: [{ source: "server", kind: "request_error", level: "error", count: 1 }],
      recent: [],
      slow: [],
    },
    { readinessStatus: "ready", readiness: { ok: true, database: "ok" } }
  );
  assert.match(error, /Runtime errors need a look/);
  assert.match(error, /actlog-error/);
});

test("system health renders actionable bounded details and escapes contract fields", () => {
  const settings = loadSettingsClient();
  const issues = Array.from({ length: 10 }, (_, index) => ({
    source: index === 9 ? "client" : "server",
    kind: `api_failure_${index}`,
    level: index === 9 ? "error" : "warning",
    route: `/api/route-${index}`,
    operation: "GET diagnostics",
    status: 503,
    count: index + 1,
    first_seen: "2026-07-09 10:00:00",
    last_seen: "2026-07-10 12:00:00",
    message: index === 9 ? "<script>server failed</script>" : "slow",
    release: "1.0.0",
  }));
  const html = settings.diagnosticsCard(
    {
      window_days: 7,
      total: 12,
      issues,
      recent: [
        {
          source: "client",
          kind: "api_failure",
          level: "error",
          route: "/api/<settings>",
          status: 503,
          duration_ms: 15225,
          request_id: `req-<bad>"`,
          created_at: "2026-07-10 12:00:00",
          message: "<script>server failed</script>",
          release: "1.0.0",
        },
      ],
      slow: [{ route: "/api/stats", duration_ms: 2100 }],
    },
    {
      relTime: () => "just now",
      source: "all",
      severity: "all",
      readinessStatus: "ready",
      readiness: { ok: true, database: "ok" },
    }
  );

  assert.match(html, /System health/);
  assert.match(html, /data-save-ignore/);
  assert.match(html, /12 diagnostic events captured/);
  assert.match(html, /Grouped issues/);
  assert.match(html, /Recent events/);
  assert.match(html, /15\.2s/);
  assert.match(html, /\/api\/stats/);
  assert.match(html, /2\.1s/);
  assert.match(html, /Request ID/);
  assert.match(html, /data-copy-request="req-&lt;bad&gt;&quot;"/);
  assert.match(html, /Release/);
  assert.match(html, /First seen/);
  assert.match(html, /Last seen/);
  assert.match(html, /sysdiag-absolute/);
  assert.match(html, /Page 1 of 2/);
  assert.equal(
    (html.match(/<details class="sysdiag-item/g) || []).length,
    10,
    "eight grouped and two recent rows bound the DOM"
  );
  assert.match(html, /Request bodies, health values, chat text, and credentials are never collected/);
  assert.doesNotMatch(html, /<script>/);

  const filtered = settings.diagnosticsCard(
    { window_days: 7, total: 10, issues, recent: [], slow: [] },
    { source: "client", severity: "error", readinessStatus: "ready", readiness: { ok: true, database: "ok" } }
  );
  assert.match(filtered, /api failure 9/);
  assert.doesNotMatch(filtered, /api failure 0/);
});

test("readiness truth overrides a zero diagnostic count and renders optional operator summaries", () => {
  const settings = loadSettingsClient();
  const base = {
    window_days: 7,
    total: 0,
    issues: [],
    recent: [],
    slow: [],
    build: { version: "1.0.0", build_id: "abc123", build_source: "environment" },
    performance: {
      window_days: 7,
      requests: 42,
      avg_ms: 125,
      p50_ms: 100,
      p95_ms: 2100,
      max_ms: 15225,
      throughput_per_hour: 0.25,
      by_protocol: { api: 40, mcp: 2 },
      top_routes: [{ method: "GET", route: "/api/<today>", requests: 12, errors: 1, p95_ms: 2100 }],
    },
    storage: {
      diagnostic_events: { rows: 18, retention_days: 30, row_cap: 20000 },
      request_metric_buckets: { rows: 9, retention_days: 30, row_cap: 50000 },
    },
  };
  const stale = settings.diagnosticsCard(base, {
    readinessStatus: "ready",
    readiness: {
      ok: false,
      database: "ok",
      scheduler: { status: "stale", age_sec: 640, last_at: "2026-07-10 12:00:00" },
      queues: {
        agent_jobs: { queued: 1, running: 0, oldest_age_sec: 1800, failed_24h: 2 },
        chat_turns: { queued: 0, running: 0, oldest_age_sec: null, failed_24h: 0 },
      },
    },
  });
  assert.match(stale, /Runtime errors need a look/);
  assert.match(stale, /Scheduler heartbeat is stale/);
  assert.match(stale, /2 failed in the last 24 hours/);
  assert.match(stale, /oldest active item is 30m old/);
  assert.match(stale, /No diagnostic events/);
  assert.doesNotMatch(stale, /Healthy zero-event response/);
  assert.match(stale, /1\.0\.0 @ abc123/);
  assert.match(stale, /42<\/b> requests/);
  assert.match(stale, /2\.1s<\/b> p95/);
  assert.match(stale, /100ms<\/b> p50/);
  assert.match(stale, /0\.25<\/b> requests\/hour/);
  assert.match(stale, /GET \/api\/&lt;today&gt;/);
  assert.match(stale, /18 diagnostic rows/);
  assert.match(stale, /9 metric buckets/);

  const failedJobs = settings.diagnosticsCard(base, {
    readinessStatus: "ready",
    readiness: {
      ok: true,
      database: "ok",
      scheduler: { status: "fresh", age_sec: 10 },
      queues: { agent_jobs: { queued: 0, running: 0, failed_24h: 1 }, chat_turns: {} },
    },
  });
  assert.match(failedJobs, /Operational warnings captured/);
  assert.doesNotMatch(failedJobs, /Healthy zero-event response/);

  const dbDown = settings.diagnosticsCard(base, {
    readinessStatus: "ready",
    readiness: { ok: false, database: "unavailable" },
  });
  assert.match(dbDown, /Database is unavailable/);
  assert.match(dbDown, /Runtime errors need a look/);
});

test("current-build diagnostics determine health while prior-build incidents remain historical", () => {
  const settings = loadSettingsClient();
  const readiness = {
    ok: true,
    database: "ok",
    scheduler: { status: "fresh", age_sec: 5 },
    queues: {
      agent_jobs: { queued: 0, running: 0, oldest_age_sec: null, failed_24h: 0 },
      chat_turns: { queued: 0, running: 0, oldest_age_sec: null, failed_24h: 0 },
    },
  };
  const cleanDeploy = settings.diagnosticsCard(
    {
      window_days: 7,
      total: 10,
      issues: [{ source: "api", kind: "old_build_error", level: "error", count: 10 }],
      recent: [{ source: "api", kind: "old_build_error", level: "error" }],
      slow: [],
      current_build: {
        scope: "current_build",
        build_id: `abc<123>`,
        release: `1.1.0<rc>@abc<123>`,
        total: 0,
        prior_build_total: 10,
        issues: [],
        recent: [],
        slow: [],
      },
    },
    { readinessStatus: "ready", readiness }
  );
  assert.match(cleanDeploy, /System is ready/);
  assert.match(cleanDeploy, /Healthy zero-event response/);
  assert.match(cleanDeploy, /Current build 1\.1\.0&lt;rc&gt;@abc&lt;123&gt;/);
  assert.doesNotMatch(cleanDeploy, /abc&lt;123&gt;@abc&lt;123&gt;/);
  assert.match(cleanDeploy, /10 earlier-build events remain as history and do not affect current health/);
  assert.doesNotMatch(cleanDeploy, /old build error|Runtime errors need a look/);

  const currentWarning = settings.diagnosticsCard(
    {
      window_days: 7,
      total: 10,
      issues: [],
      recent: [],
      slow: [],
      current_build: {
        scope: "current_build",
        build_id: "new-build",
        release: "1.1.0",
        total: 1,
        prior_build_total: 9,
        issues: [{ source: "api", kind: "current_slow", level: "warning", count: 1, route: "/api/today" }],
        recent: [],
        slow: [],
      },
    },
    { readinessStatus: "ready", readiness }
  );
  assert.match(currentWarning, /Operational warnings captured/);
  assert.match(currentWarning, /Current build 1\.1\.0@new-build/);
  assert.match(currentWarning, /current slow/);
  assert.match(currentWarning, /9 earlier-build events remain/);
});

// The sink bumps created_at on every hit of a coalesced row, so a stream that
// has been running for nine days reads as a one-second burst unless first_seen
// is shown next to it.
test("a coalesced diagnostic row shows the span it covers, not just its last hit", () => {
  const settings = loadSettingsClient();
  const options = { relTime: (value) => `rel(${value})`, source: "all", severity: "all", readinessStatus: "ready" };
  const card = (event) =>
    settings.diagnosticsCard({ window_days: 30, total: 9, issues: [], recent: [event], slow: [] }, options);

  const spanning = card({
    source: "client",
    kind: "api_failure",
    level: "warning",
    route: "/api/insights",
    occurrence_count: 9,
    first_seen: "2026-08-16 09:00:00",
    created_at: "2026-08-25 09:00:00",
  });
  assert.match(spanning, /First seen/);
  assert.match(spanning, /datetime="2026-08-16T09:00:00Z"/);
  assert.match(spanning, /Last seen/);
  assert.match(spanning, /datetime="2026-08-25T09:00:00Z"/);
  assert.match(spanning, /9×/, "the summary says how many hits the row stands for");
  assert.doesNotMatch(spanning, /Captured/, "a nine-day stream is not one capture");

  // A genuine single event keeps the simpler, quieter line.
  const single = card({
    source: "client",
    kind: "render_error",
    level: "error",
    route: "/api/today",
    occurrence_count: 1,
    first_seen: "2026-08-25 09:00:00",
    created_at: "2026-08-25 09:00:00",
  });
  assert.match(single, /Captured/);
  assert.doesNotMatch(single, /First seen/);
});
