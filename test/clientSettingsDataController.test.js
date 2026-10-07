import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, loadClientModule } from "./_dom.mjs";

function loadSettingsDataController() {
  const calls = [];
  const win = loadClientModule("settings-data-controller", {
    globals: {
      CairnSettingsData: {
        phoneAccessCardHtml: ({ inStandaloneApp } = {}) => (inStandaloneApp ? "" : "<details id=\"phone\"></details>"),
        wirePhoneAccessCard: (options = {}) => calls.push(["wirePhoneAccessCard", typeof options.api, typeof options.toast]),
        wireExerciseGuideCard: (options = {}) =>
          calls.push(["wireExerciseGuideCard", typeof options.api, typeof options.toast]),
      },
    },
  });
  return { controller: win.CairnSettingsDataController, calls, document: win.document };
}

test("settings data controller owns update, export, and setup wiring", async () => {
  const { controller, calls, document } = loadSettingsDataController();
  const wm = { update_check_enabled: true };
  const rootEl = createHost(document, { id: "root" });
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
    // A download leaves the app, so it rides a signed link (api-core openResourceLink).
    openResourceLink: async (path, mode) => downloads.push(`${mode}:${path}`),
    reload: () => { reloaded = true; },
  });

  assert.match(rootEl.innerHTML, /Data &amp; backup/);
  assert.deepEqual(calls, [
    ["wirePhoneAccessCard", "function", "function"],
    ["wireExerciseGuideCard", "function", "function"],
  ]);
  assert.equal(rootEl.querySelector("#updateCard").innerHTML, "card:none:true");

  await Promise.resolve();
  assert.equal(rootEl.querySelector("#updateCard").innerHTML, "card:0.8.0:true");
  assert.deepEqual(apiCalls[0], ["/update-status", "GET", ""]);

  await rootEl.querySelector("#updateCheckEnabled").click(); // checked -> unchecked, fires change
  assert.equal(wm.update_check_enabled, false);
  assert.equal(dirty, 1);
  assert.equal(rootEl.querySelector("#updateCheckNow").style.display, "none");
  assert.equal(rootEl.querySelector("#updateCard").innerHTML, "card:0.8.0:false");

  await rootEl.querySelector("#updateCheckNow").click();
  assert.equal(rootEl.querySelector("#updateCard").innerHTML, "card:0.9.0:false");
  assert.equal(rootEl.querySelector("#updateCheckNow").textContent, "Check now");

  await rootEl.querySelector("#dlJson").click();
  await rootEl.querySelector("#dlDb").click();
  assert.deepEqual(downloads, ["download:/api/export", "download:/api/export/db"]);

  await rootEl.querySelector("#rerunSetup").click();
  assert.deepEqual(apiCalls.at(-1), ["/settings", "PUT", JSON.stringify({ onboarded: false })]);
  assert.equal(reloaded, true);
});

test("Devices is its own Settings slice: Data no longer carries the pairing card", async () => {
  const wired = [];
  const win = loadClientModule("settings-data-controller", {
    globals: {
      CairnSettingsData: {
        phoneAccessCardHtml: () => "",
        wirePhoneAccessCard: () => {},
        wireExerciseGuideCard: () => {},
      },
      CairnSettingsPairing: {
        devicesSliceHtml: () => '<section id="devicesSlice"><div id="accessCard" hidden></div></section>',
        accessCardHtml: () => '<div id="accessCard" hidden></div>',
        wireAccessCard: (deps) => wired.push([deps.root, deps.origin, typeof deps.api]),
      },
    },
  });
  const controller = win.CairnSettingsDataController;
  const base = {
    workingModel: { update_check_enabled: false },
    api: async () => ({}),
    toast: () => {},
    markDirty: () => {},
    updateCardHtml: () => "",
    withToken: (p) => p,
    downloadFile: () => {},
    reload: () => {},
    origin: "https://cairn.example",
  };

  const data = createHost(win.document, { id: "data" });
  controller.render({ ...base, root: data });
  assert.equal(data.querySelector("#accessCard"), null, "Data is exports and updates only");
  assert.equal(wired.length, 0);

  const devices = createHost(win.document, { id: "devices" });
  controller.renderDevices({ ...base, root: devices });
  assert.ok(devices.querySelector("#devicesSlice"));
  assert.deepEqual(wired, [[devices, "https://cairn.example", "function"]]);
});
