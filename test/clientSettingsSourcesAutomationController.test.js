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
  }

  set innerHTML(value) {
    this.html = value;
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
}

class FakeRoot extends FakeElement {
  set innerHTML(value) {
    this.html = value;
    this.children = new Map();
    const ids = [
      "garminUsername",
      "garminPassword",
      "garminSyncBtn",
      "garminStatus",
      "ahUrl",
      "ahUrlCopy",
      "enrichEnabled",
      "artEnabled",
      "researchEnabled",
      "geminiApiKey",
      "leadMode",
    ];
    for (const id of ids) {
      const el = new FakeElement(id);
      el.checked = new RegExp(`id="${id}"[^>]*checked`).test(value);
      this.children.set(`#${id}`, el);
    }
  }

  get innerHTML() {
    return this.html;
  }

  querySelector(selector) {
    return this.children.get(selector) || null;
  }
}

function loadSettingsSourcesAutomationController() {
  const context = { Object, Array, Set, String, Number, RegExp, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-surface-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-sources-automation-controller.js"), "utf8"), context);
  return context.CairnSettingsSourcesAutomationController;
}

function baseDeps(rootEl, wm, overrides = {}) {
  const calls = [];
  const toasts = [];
  const clipboardWrites = [];
  const timers = [];
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
        return {};
      },
      toast: (message) => toasts.push(message),
      locationOrigin: "https://cairn.test",
      clipboard: { writeText: async (value) => clipboardWrites.push(value) },
      setTimeout: (fn) => {
        timers.push(fn);
        return 0;
      },
      ...overrides,
    },
    calls,
    toasts,
    clipboardWrites,
    timers,
  };
}

test("settings sources controller owns Garmin and Apple Health wiring", async () => {
  const controller = loadSettingsSourcesAutomationController();
  const rootEl = new FakeRoot("root");
  const wm = {
    garmin_username: "",
    garmin_password: "",
    enrich_enabled: false,
    art_enabled: true,
    research_enabled: false,
    gemini_api_key: "",
    lead_mode: "lead",
  };
  const harness = baseDeps(rootEl, wm);

  controller.renderSources(harness.deps);

  assert.match(rootEl.innerHTML, /Garmin Connect/);
  assert.equal(rootEl.querySelector("#ahUrl").textContent, "https://cairn.test/api/health-metrics");

  rootEl.querySelector("#garminUsername").input("athlete@example.com");
  rootEl.querySelector("#garminPassword").input("secret");
  assert.equal(wm.garmin_username, "athlete@example.com");
  assert.equal(wm.garmin_password, "secret");

  await rootEl.querySelector("#ahUrlCopy").click();
  assert.deepEqual(harness.clipboardWrites, ["https://cairn.test/api/health-metrics"]);
  assert.equal(rootEl.querySelector("#ahUrlCopy").textContent, "Copied");
  harness.timers[0]();
  assert.equal(rootEl.querySelector("#ahUrlCopy").textContent, "Copy");

  await rootEl.querySelector("#garminSyncBtn").click();
  assert.deepEqual(harness.calls, [["/garmin/sync", "POST"], ["/settings", "GET"]]);
  assert.equal(rootEl.querySelector("#garminSyncBtn").disabled, false);
  assert.equal(rootEl.querySelector("#garminSyncBtn").textContent, "Sync now");
  assert.equal(rootEl.querySelector("#garminStatus").innerHTML, "status:ok: done:false");
  assert.deepEqual(harness.toasts, ["Garmin synced · 2 activities"]);
});

test("settings automation controller owns enrichment and research toggles", () => {
  const controller = loadSettingsSourcesAutomationController();
  const rootEl = new FakeRoot("root");
  const wm = {
    garmin_username: "",
    garmin_password: "",
    enrich_enabled: true,
    art_enabled: false,
    research_enabled: false,
    gemini_api_key: "",
    lead_mode: "lead",
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
  rootEl.querySelector("#geminiApiKey").input("gemini-key");

  assert.equal(wm.enrich_enabled, false);
  assert.equal(wm.art_enabled, true);
  assert.equal(wm.research_enabled, true);
  assert.equal(wm.lead_mode, "announce_first");
  assert.equal(wm.gemini_api_key, "gemini-key");
});
