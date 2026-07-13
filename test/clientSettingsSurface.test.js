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

function loadSettingsSurface() {
  const context = { Math, Number, String, Object, Array, Set, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-surface-client.js"), "utf8"), context);
  return context.CairnSettingsSurface;
}

test("settings surface normalizes API data into the working model", () => {
  const surface = loadSettingsSurface();
  assert.deepEqual(JSON.parse(JSON.stringify(surface.SET_SEG)), [
    ["you", "You"], ["agents", "Agents"], ["system", "System"], ["sources", "Sources"], ["automation", "Automation"], ["data", "Data"],
  ]);
  const data = surface.settingsData({
    settings: {
      agent_strategy: "priority",
      agent_routes: { chat: "claude" },
      art_enabled: false,
      update_check_enabled: null,
      garmin_username: "athlete@example.com",
      time_zone: "America/New_York",
    },
    agents: [
      { name: "claude", enabled: true },
      { name: "stub", enabled: false },
      { description: "missing name" },
    ],
    research_auto_eligible: { eligible: true, reason: "web_agent_connected" },
  });
  const wm = surface.workingModel(data);

  assert.deepEqual(data.agents.map((agent) => agent.name), ["claude", "stub"]);
  assert.equal(wm.agent_strategy, "priority");
  assert.deepEqual(wm.order, ["claude", "stub"]);
  assert.equal(wm.disabled.has("stub"), true);
  assert.equal(wm.routes.chat, "claude");
  assert.equal(wm.art_enabled, false);
  assert.equal(wm.update_check_enabled, true);
  assert.equal(wm.lead_mode, "lead");
  assert.equal(wm.garmin_username, "athlete@example.com");
  assert.equal(wm.time_zone, "America/New_York");
  assert.equal(surface.routeEligible(data).reason, "web_agent_connected");
});

test("settings surface renders source and automation slices without echoing secrets", () => {
  const surface = loadSettingsSurface();
  const wm = {
    garmin_username: `athlete"@example.com`,
    enrich_enabled: true,
    art_enabled: false,
    research_enabled: false,
    lead_mode: "announce_first",
  };

  const sources = surface.sourcesSliceHtml({
    workingModel: wm,
    settings: {
      garmin_password_configured: true,
      garmin_credentials_source: `Settings "saved"`,
    },
    garminStatusHtml: `<span class="sync-text">Never synced</span>`,
  });
  assert.match(sources, /value="athlete&quot;@example\.com"/);
  assert.match(sources, /placeholder="Configured via Settings &quot;saved&quot;"/);
  assert.doesNotMatch(sources, /GARMIN_PASSWORD"/);
  assert.match(sources, /href="shortcuts:\/\/create-shortcut"/);
  assert.match(sources, /id="ahRecipeCopy"/);
  assert.match(sources, /source: apple_health/);
  assert.match(sources, /Apple still requires you to add/);

  const automation = surface.automationSliceHtml({
    workingModel: wm,
    settings: {
      gemini_api_key_configured: true,
      gemini_api_key_source: `env "key"`,
    },
    artSpendHtml: "<div>spend</div>",
    researchEligible: { eligible: true, reason: "web_agent_connected" },
  });
  assert.match(automation, /id="enrichEnabled" checked/);
  assert.match(automation, /value="announce_first" selected/);
  assert.doesNotMatch(automation, /id="artEnabled" checked/);
  assert.match(automation, /placeholder="Configured via env &quot;key&quot;"/);
  assert.match(automation, /turn this on for live, cited research/);
});

test("settings surface exposes status helpers and art spend card", () => {
  const surface = loadSettingsSurface();
  const status = surface.statusHelpers({ relTime: () => "now", absDate: () => "Today" });

  assert.match(status.garminStatusLine({ garmin_last_sync_at: "2026-06-29", garmin_last_sync_status: "ok: done" }, false), /Synced now · done/);
  assert.equal(status.agentOpLabel("chat_distill"), "saved chat to memory");
  assert.equal(status.agentChipState({ configured: true }).label, "✓ Connected");

  const spend = surface.artSpendCardHtml({
    since_enabled: { est_cost_usd: 0.004, images_generated: 1, reused: 2, est_saved_usd: 0.01 },
    all_time: { est_cost_usd: 1.23, images_generated: 4 },
    enabled_at: "2026-06-29T12:00:00Z",
    cached_assets: 5,
  });
  assert.match(spend, /\$0\.0040/);
  assert.match(spend, /1 image generated/);
  assert.match(spend, /5 cached/);
});
