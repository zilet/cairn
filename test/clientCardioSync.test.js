import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadCardioSync() {
  class FixedDate extends Date {
    static now() {
      return Date.parse("2026-06-30T12:00:00.000Z");
    }
  }

  const context = {
    Date: FixedDate,
    Infinity,
    Math,
    Number,
    Object,
    String,
    relTime: (at) => `<${at}>`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/cardio-sync-client.js"), "utf8"), context);
  return context.CairnCardioSync;
}

test("cardio sync helper detects configured Garmin credentials", () => {
  const sync = loadCardioSync();

  assert.equal(typeof sync.wire, "function");
  assert.deepEqual(Array.from(sync.zoneColors), ["#cdd7c0", "#b9c79a", "#e6c87a", "#d98a4e", "#b4552d"]);
  assert.equal(sync.configured(null), false);
  assert.equal(sync.configured({ garmin_credentials_source: "none" }), false);
  assert.equal(sync.configured({ garmin_credentials_source: "env" }), true);
  assert.equal(sync.configured({ garmin_username: "athlete" }), true);
  assert.equal(sync.configured({ garmin_password_configured: true }), true);
});

test("cardio sync helper stays silent when Garmin is not configured", () => {
  const sync = loadCardioSync();

  assert.equal(sync.lineHtml({ garmin_credentials_source: "none" }), "");
});

test("cardio sync helper nudges stale expected runs calmly", () => {
  const sync = loadCardioSync();
  const html = sync.lineHtml({ garmin_username: "athlete" }, { expectingRun: true });

  assert.match(html, /this morning's run not synced yet\?/);
  assert.match(html, /cardio-sync-dot stale/);
  assert.match(html, /data-syncnow/);
});

test("cardio sync helper renders recent sync freshness", () => {
  const sync = loadCardioSync();
  const html = sync.lineHtml({
    garmin_username: "athlete",
    garmin_last_sync_at: "2026-06-30T11:00:00.000Z",
    garmin_last_sync_status: "ok",
  });

  assert.match(html, /synced &lt;2026-06-30T11:00:00\.000Z&gt;/);
  assert.doesNotMatch(html, /stale/);
});

test("cardio sync helper renders failed sync state", () => {
  const sync = loadCardioSync();
  const html = sync.lineHtml({
    garmin_username: "athlete",
    garmin_last_sync_at: "2026-06-30T11:00:00.000Z",
    garmin_last_sync_status: "failed: auth",
  });

  assert.match(html, /Sync failed/);
  assert.match(html, /cardio-sync-dot err/);
});
