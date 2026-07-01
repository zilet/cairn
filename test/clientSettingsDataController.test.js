import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.innerHTML = "";
    this.textContent = "";
    this.disabled = false;
    this.checked = false;
    this.isConnected = true;
    this.style = {};
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  async click() {
    const handler = this.listeners.get("click");
    if (handler) await handler({ currentTarget: this });
  }

  change(checked) {
    this.checked = checked;
    const handler = this.listeners.get("change");
    if (handler) handler({ currentTarget: this });
  }
}

class FakeRoot extends FakeElement {
  constructor() {
    super("root");
    this.children = new Map();
  }

  set innerHTML(value) {
    this.html = value;
    this.children = new Map();
    for (const id of ["updateCard", "updateCheckEnabled", "updateCheckNow", "dlJson", "dlDb", "rerunSetup"]) {
      const el = new FakeElement(id);
      if (id === "updateCheckEnabled") el.checked = /id="updateCheckEnabled" checked/.test(value);
      if (id === "updateCard") el.innerHTML = (value.match(/<div id="updateCard" class="sess">([\s\S]*?)<\/div>/) || [])[1] || "";
      if (id === "updateCheckNow" && /id="updateCheckNow"[\s\S]*display:none/.test(value)) el.style.display = "none";
      this.children.set(`#${id}`, el);
    }
  }

  get innerHTML() {
    return this.html || "";
  }

  querySelector(selector) {
    return this.children.get(selector) || null;
  }
}

function loadSettingsDataController() {
  const calls = [];
  const context = {
    Object,
    window: {},
    CairnSettingsData: {
      phoneAccessCardHtml: ({ inStandaloneApp } = {}) => (inStandaloneApp ? "" : "<details id=\"phone\"></details>"),
      wirePhoneAccessCard: (options = {}) => calls.push(["wirePhoneAccessCard", typeof options.api, typeof options.toast]),
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-data-controller.js"), "utf8"), context);
  return { controller: context.CairnSettingsDataController, calls };
}

test("settings data controller owns update, export, and setup wiring", async () => {
  const { controller, calls } = loadSettingsDataController();
  const wm = { update_check_enabled: true };
  const rootEl = new FakeRoot();
  const apiCalls = [];
  const downloads = [];
  let dirty = 0;
  let reloaded = false;
  const statuses = {
    "/update-status": { latest: "0.8.0" },
    "/update-check": { latest: "0.9.0" },
  };

  controller.render({
    root: rootEl,
    workingModel: wm,
    inStandaloneApp: false,
    api: async (path, opts) => {
      apiCalls.push([path, opts?.method || "GET", opts?.body || ""]);
      return statuses[path] || { ok: true };
    },
    toast: () => {},
    markDirty: () => { dirty += 1; },
    updateCardHtml: (status) => `card:${status?.latest || "none"}:${wm.update_check_enabled}`,
    withToken: (path) => `${path}?token=t`,
    downloadFile: (path) => downloads.push(path),
    reload: () => { reloaded = true; },
  });

  assert.match(rootEl.innerHTML, /Data &amp; backup/);
  assert.deepEqual(calls, [["wirePhoneAccessCard", "function", "function"]]);
  assert.equal(rootEl.querySelector("#updateCard").innerHTML, "card:none:true");

  await Promise.resolve();
  assert.equal(rootEl.querySelector("#updateCard").innerHTML, "card:0.8.0:true");
  assert.deepEqual(apiCalls[0], ["/update-status", "GET", ""]);

  rootEl.querySelector("#updateCheckEnabled").change(false);
  assert.equal(wm.update_check_enabled, false);
  assert.equal(dirty, 1);
  assert.equal(rootEl.querySelector("#updateCheckNow").style.display, "none");
  assert.equal(rootEl.querySelector("#updateCard").innerHTML, "card:0.8.0:false");

  await rootEl.querySelector("#updateCheckNow").click();
  assert.equal(rootEl.querySelector("#updateCard").innerHTML, "card:0.9.0:false");
  assert.equal(rootEl.querySelector("#updateCheckNow").textContent, "Check now");

  await rootEl.querySelector("#dlJson").click();
  await rootEl.querySelector("#dlDb").click();
  assert.deepEqual(downloads, ["/api/export?token=t", "/api/export/db?token=t"]);

  await rootEl.querySelector("#rerunSetup").click();
  assert.deepEqual(apiCalls.at(-1), ["/settings", "PUT", JSON.stringify({ onboarded: false })]);
  assert.equal(reloaded, true);
});
