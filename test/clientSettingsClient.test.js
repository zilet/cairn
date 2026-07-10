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
  const context = { Math, Number, String, Object, Array, escHtml, escAttr };
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
  assert.match(health, /Most recent runs completed/);
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
      conferences: { jobs: 2, successful: 1 },
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
  assert.match(html, /docker compose pull &amp;&amp; docker compose up -d/);
});
