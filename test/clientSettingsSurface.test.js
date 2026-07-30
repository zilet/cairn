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
    ["you", "You"],
    ["agents", "Agents"],
    ["system", "System"],
    ["sources", "Sources"],
    ["automation", "Automation"],
    ["data", "Data"],
  ]);
  const data = surface.settingsData({
    settings: {
      agent_strategy: "priority",
      agent_routes: { chat: "claude" },
      art_enabled: false,
      update_check_enabled: null,
      garmin_username: "athlete@example.com",
      time_zone: "America/New_York",
      chat_routing_mode: "single",
      chat_profile_bindings: { hidden: { capture: { model: "keep" } }, visible: { coach: { reasoning: "medium" } } },
    },
    agents: [{ name: "claude", enabled: true }, { name: "stub", enabled: false }, { description: "missing name" }],
    research_auto_eligible: { eligible: true, reason: "web_agent_connected" },
  });
  const wm = surface.workingModel(data);

  assert.deepEqual(
    data.agents.map((agent) => agent.name),
    ["claude", "stub"]
  );
  assert.equal(wm.agent_strategy, "priority");
  assert.deepEqual(wm.order, ["claude", "stub"]);
  assert.equal(wm.disabled.has("stub"), true);
  assert.equal(wm.routes.chat, "claude");
  assert.equal(wm.art_enabled, false);
  assert.equal(wm.update_check_enabled, true);
  assert.equal(wm.lead_mode, "lead");
  assert.equal(wm.garmin_username, "athlete@example.com");
  assert.equal(wm.time_zone, "America/New_York");
  assert.equal(wm.chat_routing_mode, "single");
  assert.deepEqual(JSON.parse(JSON.stringify(wm.chat_profile_bindings.hidden)), { capture: { model: "keep" } });
  assert.equal(wm.chat_profile_bindings.visible.coach.reasoning, "medium");
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
  assert.doesNotMatch(sources, /shortcuts:\/\/create-shortcut/);
  assert.match(sources, /Checking connection/);

  const unavailable = surface.appleHealthCardHtml({
    config: { available: false, pairing_available: true },
    connections: [],
  });
  assert.match(unavailable, /This server has no install link configured/);
  assert.match(unavailable, /docs\/APPLE_HEALTH\.md/);
  assert.doesNotMatch(unavailable, /class="ghostbtn ah-install"/);
  assert.doesNotMatch(unavailable, /id="ahConnect"/);
  // The hand-built recipe is gone: the published Shortcut is the only setup path.
  assert.doesNotMatch(unavailable, /id="ahRecipeCopy"|Advanced manual setup|ah-steps/);

  // Pre-publication validate flow: a hand-installed Shortcut can still pair —
  // Connect & test needs only a name + auth, never a published install URL.
  const handInstalled = surface.appleHealthCardHtml({
    config: { available: false, shortcut_name: "Cairn Apple Health Sync", pairing_available: true },
    connections: [],
  });
  assert.match(handInstalled, /This server has no install link configured/);
  assert.doesNotMatch(handInstalled, /class="ghostbtn ah-install"/);
  assert.match(handInstalled, /id="ahConnect"/);
  assert.doesNotMatch(handInstalled, /id="ahRecipeCopy"|Advanced manual setup/);

  const dates = { relTime: (iso) => `rel(${iso})`, absDate: (iso) => `abs(${iso})` };
  const available = surface.appleHealthCardHtml({
    config: {
      available: true,
      install_url: "https://www.icloud.com/shortcuts/abc",
      shortcut_name: "Cairn Apple Health Sync",
      pairing_available: true,
    },
    connections: [
      {
        id: 7,
        label: "iPhone",
        status: "connected",
        created_at: "2026-07-14T12:00:00.000Z",
        last_used_at: null,
      },
    ],
    dates,
  });
  assert.match(available, /Install Apple Health Sync/);
  assert.match(available, /id="ahConnect"/);
  // A never-used connection says what to do next, by name.
  assert.match(available, /Waiting for its first update/);
  assert.match(available, /paired rel\(2026-07-14T12:00:00\.000Z\)/);
  assert.match(available, /title="abs\(2026-07-14\)"/);
  assert.match(available, /Open the Shortcuts app and tap Cairn Apple Health Sync once/);

  const used = surface.appleHealthCardHtml({
    config: { available: true, install_url: "https://www.icloud.com/shortcuts/abc", pairing_available: true },
    connections: [
      {
        id: 8,
        label: "iPhone",
        status: "connected",
        created_at: "2026-07-14T12:00:00.000Z",
        last_used_at: "2026-07-20T06:30:00.000Z",
      },
    ],
    dates,
  });
  assert.match(used, /Last update rel\(2026-07-20T06:30:00\.000Z\)/);
  assert.match(used, /paired rel\(2026-07-14T12:00:00\.000Z\)/);
  assert.doesNotMatch(used, /Open the Shortcuts app/);

  // Without injected date helpers the raw stamp still renders — never "undefined".
  const bare = surface.appleHealthCardHtml({
    config: { available: true, install_url: "https://www.icloud.com/shortcuts/abc", pairing_available: true },
    connections: [{ id: 9, label: "iPhone", status: "connected", created_at: "2026-07-14T12:00:00.000Z" }],
  });
  assert.match(bare, /paired 2026-07-14T12:00:00\.000Z/);
  assert.doesNotMatch(bare, /undefined/);

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

  assert.match(
    status.garminStatusLine({ garmin_last_sync_at: "2026-06-29", garmin_last_sync_status: "ok: done" }, false),
    /Synced now · done/
  );
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
