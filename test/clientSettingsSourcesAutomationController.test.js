import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(value) {
  return escHtml(value).replace(/"/g, "&quot;");
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.checked = false;
    this.disabled = false;
    this.isConnected = true;
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
    this.html = "";
    this.children = new Map();
    this.dataset = {};
  }

  set innerHTML(value) {
    this.html = value;
    this.children = new Map();
    const ids = [
      "garminUsername",
      "garminPassword",
      "garminSyncBtn",
      "garminStatus",
      "garminExportStrength",
      "appleHealthCard",
      "ahConnect",
      "ahRefresh",
      "ahRetry",
      "enrichEnabled",
      "artEnabled",
      "researchEnabled",
      "geminiApiKey",
      "leadMode",
      "trainingDrive",
    ];
    for (const id of ids) {
      if (!new RegExp(`id="${id}"`).test(value)) continue;
      const el = id === "appleHealthCard" ? new FakeElement(id) : new FakeElement(id);
      el.checked = new RegExp(`id="${id}"[^>]*checked`).test(value);
      this.children.set(`#${id}`, el);
    }
    const revokeRe = /class="[^"]*ah-revoke[^"]*"[^>]*data-connection-id="(\d+)"/g;
    const revokes = [];
    for (const match of value.matchAll(revokeRe)) {
      const el = new FakeElement();
      el.dataset.connectionId = match[1];
      revokes.push(el);
    }
    this.children.set(".ah-revoke", revokes);
  }

  get innerHTML() {
    return this.html;
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  input(value) {
    this.value = value;
    const handler = this.listeners.get("input");
    if (handler) handler({ currentTarget: this });
  }

  change(value) {
    if (typeof value === "string") this.value = value;
    else this.checked = value;
    const handler = this.listeners.get("change");
    if (handler) handler({ currentTarget: this });
  }

  async click() {
    const handler = this.listeners.get("click");
    if (handler) await handler({ currentTarget: this });
  }

  querySelector(selector) {
    const value = this.children.get(selector);
    return Array.isArray(value) ? value[0] || null : value || null;
  }

  querySelectorAll(selector) {
    const value = this.children.get(selector);
    return Array.isArray(value) ? value : value ? [value] : [];
  }
}

class FakeRoot extends FakeElement {}

function loadSettingsSourcesAutomationController() {
  const context = { Object, Array, Set, String, Number, RegExp, JSON, URLSearchParams, escHtml, escAttr };
  context.window = context;
  // The controller hands the real date helpers to the surface, so the connection
  // rows are rendered here exactly as the browser renders them.
  vm.runInNewContext(readFileSync(join(root, "public/js/date-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-surface-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-sources-automation-controller.js"), "utf8"), context);
  return context.CairnSettingsSourcesAutomationController;
}

function baseDeps(rootEl, wm, overrides = {}) {
  const calls = [];
  const toasts = [];
  const timers = [];
  const openedUrls = [];
  return {
    deps: {
      root: rootEl,
      workingModel: wm,
      settings: {},
      data: { settings: {}, agents: [], research_auto_eligible: { eligible: true, reason: "web_agent_connected" } },
      artSpendHtml: "<div>spend</div>",
      garminStatusLine: (settings, syncing) => `status:${settings?.garmin_last_sync_status || "none"}:${syncing}`,
      api: async (path, opts = {}) => {
        calls.push([path, opts.method || "GET"]);
        if (path === "/garmin/sync") return { ok: true, activities: 2 };
        if (path === "/settings") return { settings: { garmin_last_sync_status: "ok: done" }, agents: [] };
        if (path === "/apple-health/config")
          return {
            available: true,
            install_url: "https://www.icloud.com/shortcuts/test-id",
            shortcut_name: "Cairn Apple Health Sync",
            help_url: "https://github.com/zilet/cairn/blob/main/docs/APPLE_HEALTH.md",
            pairing_available: true,
          };
        if (path === "/apple-health/connections") return { connections: [] };
        if (path === "/apple-health/pairings") return { code: "cairn_pair_one-time" };
        return {};
      },
      toast: (message) => toasts.push(message),
      locationOrigin: "https://cairn.test",
      authToken: () => "shortcut-secret",
      setTimeout: (fn) => {
        timers.push(fn);
        return 0;
      },
      openUrl: (url) => openedUrls.push(url),
      ...overrides,
    },
    calls,
    toasts,
    timers,
    openedUrls,
  };
}

test("settings sources controller owns Garmin and Apple Health wiring", async () => {
  const controller = loadSettingsSourcesAutomationController();
  const rootEl = new FakeRoot("root");
  const wm = {
    garmin_username: "",
    garmin_password: "",
    garmin_export_strength: true,
    enrich_enabled: false,
    art_enabled: true,
    research_enabled: false,
    gemini_api_key: "",
    lead_mode: "lead",
  };
  const harness = baseDeps(rootEl, wm);

  await controller.renderSources(harness.deps);

  assert.match(rootEl.innerHTML, /Garmin Connect/);
  const appleCard = rootEl.querySelector("#appleHealthCard");
  assert.match(appleCard.innerHTML, /Install Apple Health Sync/);
  // The guided path is the only path: no hand-built recipe, no endpoint copy.
  assert.doesNotMatch(appleCard.innerHTML, /Advanced manual setup|ahRecipeCopy|ahUrlCopy/);
  assert.equal(controller.appleHealthShortcutRecipe, undefined);

  rootEl.querySelector("#garminUsername").input("athlete@example.com");
  rootEl.querySelector("#garminPassword").input("secret");
  assert.equal(wm.garmin_username, "athlete@example.com");
  assert.equal(wm.garmin_password, "secret");

  // Strength write-back is on by default and reflects the model both ways.
  assert.equal(rootEl.querySelector("#garminExportStrength").checked, true);
  rootEl.querySelector("#garminExportStrength").change(false);
  assert.equal(wm.garmin_export_strength, false);

  await appleCard.querySelector("#ahConnect").click();
  assert.equal(harness.openedUrls.length, 1);
  assert.match(harness.openedUrls[0], /^shortcuts:\/\/run-shortcut\?/);
  const deepLink = new URL(harness.openedUrls[0]);
  const input = JSON.parse(deepLink.searchParams.get("text"));
  assert.deepEqual(input, { base_url: "https://cairn.test", pairing_code: "cairn_pair_one-time" });
  // Shortcuts takes "+" literally in run-shortcut URLs — the name must be
  // percent-encoded ("Cairn%20Apple…"), never form-encoded ("Cairn+Apple…").
  assert.match(harness.openedUrls[0], /name=Cairn%20Apple%20Health%20Sync/);
  assert.doesNotMatch(harness.openedUrls[0], /\+/);
  assert.doesNotMatch(harness.openedUrls[0], /shortcut-secret|Bearer/);
  assert.equal(appleCard.querySelector("#ahConnect").textContent, "Waiting for Shortcut…");

  await rootEl.querySelector("#garminSyncBtn").click();
  assert.ok(harness.calls.some(([path, method]) => path === "/garmin/sync" && method === "POST"));
  assert.equal(rootEl.querySelector("#garminSyncBtn").disabled, false);
  assert.equal(rootEl.querySelector("#garminSyncBtn").textContent, "Sync now");
  assert.equal(rootEl.querySelector("#garminStatus").innerHTML, "status:ok: done:false");
  assert.deepEqual(harness.toasts, ["Garmin synced · 2 activities"]);
});

test("Apple Health connect polls boundedly and restores retry controls after timeout", async () => {
  const controller = loadSettingsSourcesAutomationController();
  const rootEl = new FakeRoot("root");
  const wm = {
    garmin_username: "",
    garmin_password: "",
    garmin_export_strength: true,
    enrich_enabled: false,
    art_enabled: false,
    research_enabled: false,
    gemini_api_key: "",
    lead_mode: "lead",
  };
  const harness = baseDeps(rootEl, wm);

  await controller.renderSources(harness.deps);
  const card = rootEl.querySelector("#appleHealthCard");
  await card.querySelector("#ahConnect").click();

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const timer = harness.timers.at(-1);
    timer();
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.match(card.innerHTML, /Paired, but no Health data has arrived yet/);
  assert.match(card.innerHTML, /Open the Shortcuts app and tap the Shortcut once/);
  assert.ok(card.querySelector("#ahRetry"));
  assert.ok(card.querySelector("#ahRefresh"));
  assert.equal(card.querySelector("#ahConnect").disabled, false);
  assert.ok(
    harness.calls.filter(([path]) => path === "/apple-health/connections").length >= 10,
    "initial status, pre-launch snapshot, bounded polls, and final refresh should all check status"
  );
});

test("Apple Health connect waits for the first metrics ingest before reporting success", async () => {
  const controller = loadSettingsSourcesAutomationController();
  const rootEl = new FakeRoot("root");
  const wm = {
    garmin_username: "",
    garmin_password: "",
    garmin_export_strength: true,
    enrich_enabled: false,
    art_enabled: false,
    research_enabled: false,
    gemini_api_key: "",
    lead_mode: "lead",
  };
  const harness = baseDeps(rootEl, wm);
  let connectionReads = 0;
  harness.deps.api = async (path, opts = {}) => {
    harness.calls.push([path, opts.method || "GET"]);
    if (path === "/apple-health/config") {
      return {
        available: true,
        install_url: "https://www.icloud.com/shortcuts/test-id",
        shortcut_name: "Cairn Apple Health Sync",
        pairing_available: true,
      };
    }
    if (path === "/apple-health/pairings") return { code: "cairn_pair_one-time" };
    if (path === "/apple-health/connections") {
      connectionReads += 1;
      if (connectionReads <= 2) return { connections: [] };
      return {
        connections: [
          {
            id: 41,
            label: "Apple Health Shortcut",
            status: "connected",
            created_at: "2026-07-14T12:00:00.000Z",
            last_used_at: connectionReads >= 4 ? "2026-07-14T12:00:00.000Z" : null,
          },
        ],
      };
    }
    return {};
  };

  await controller.renderSources(harness.deps);
  const card = rootEl.querySelector("#appleHealthCard");
  await card.querySelector("#ahConnect").click();

  harness.timers[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.toasts, [], "pairing exchange alone is not a successful test");
  assert.equal(card.querySelector("#ahConnect").textContent, "Waiting for Shortcut…");

  harness.timers.at(-1)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.toasts, ["Apple Health connected"]);
  // Rendered through the app's own relTime/absDate, never as a raw ISO stamp.
  assert.match(card.innerHTML, /Last update (just now|\d+[mhd] ago)/);
  assert.match(card.innerHTML, /paired (just now|\d+[mhd] ago)/);
  assert.doesNotMatch(card.innerHTML, /2026-07-14T12:00:00\.000Z/);
  assert.doesNotMatch(card.innerHTML, /Open the Shortcuts app/);
});

test("settings automation controller owns enrichment and research toggles", () => {
  const controller = loadSettingsSourcesAutomationController();
  const rootEl = new FakeRoot("root");
  const wm = {
    garmin_username: "",
    garmin_password: "",
    garmin_export_strength: true,
    enrich_enabled: true,
    art_enabled: false,
    research_enabled: false,
    gemini_api_key: "",
    lead_mode: "lead",
    training_drive: "steady",
  };
  const harness = baseDeps(rootEl, wm, {
    settings: { gemini_api_key_configured: true, gemini_api_key_source: "env" },
  });

  controller.renderAutomation(harness.deps);

  assert.match(rootEl.innerHTML, /Agentic enrichment/);
  assert.match(rootEl.innerHTML, /turn this on for live, cited research/);

  rootEl.querySelector("#enrichEnabled").change(false);
  rootEl.querySelector("#artEnabled").change(true);
  rootEl.querySelector("#researchEnabled").change(true);
  rootEl.querySelector("#leadMode").change("announce_first");
  rootEl.querySelector("#trainingDrive").change("push");
  rootEl.querySelector("#geminiApiKey").input("gemini-key");

  assert.equal(wm.enrich_enabled, false);
  assert.equal(wm.art_enabled, true);
  assert.equal(wm.research_enabled, true);
  assert.equal(wm.lead_mode, "announce_first");
  assert.equal(wm.training_drive, "push");
  // An unrecognized value from a stale cached bundle falls back to the calm posture
  // rather than writing junk the server would then have to reject.
  rootEl.querySelector("#trainingDrive").change("maximum-overload");
  assert.equal(wm.training_drive, "steady");
  assert.equal(wm.gemini_api_key, "gemini-key");
});
