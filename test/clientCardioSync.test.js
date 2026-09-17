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
  // date-utils publishes pickDayVariant, which the quiet notes rotate through; the
  // fixture's relTime stub still wins so the assertions stay on the wording.
  vm.runInNewContext(readFileSync(join(root, "public/js/date-utils.js"), "utf8"), context);
  context.relTime = (at) => `<${at}>`;
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

// ---- the quiet notes under the sync row ----------------------------------------
// Two things could be wrong and neither was visible anywhere: a strength write-back
// that had stopped landing, and a watch that had stopped sending sleep.

const CONFIGURED = { garmin_credentials_source: "env", garmin_last_sync_at: "2026-06-30T11:00:00.000Z" };

test("a Garmin write-back that stopped landing says so, with what happens next", () => {
  const sync = loadCardioSync();

  const html = sync.lineHtml({
    ...CONFIGURED,
    garmin_last_export_status: "failed: timeout",
    garmin_last_export_attempt_at: "2026-06-30T10:00:00.000Z",
  });

  assert.match(html, /cardio-sync-note/);
  assert.match(html, /didn't land|didn't take|failed/);
  // The stub's angle brackets come back escaped — the note goes through escHtml.
  assert.match(html, /&lt;2026-06-30T10:00:00\.000Z&gt;/);
});

test("a watch that stopped sending sleep is named once, and only past the threshold", () => {
  const sync = loadCardioSync();

  assert.match(sync.lineHtml({ ...CONFIGURED, garmin_sleep_gap_nights: 4 }), /4 of the last 7 nights/);
  // Two stray nights is normal; the line stays quiet.
  assert.doesNotMatch(sync.lineHtml({ ...CONFIGURED, garmin_sleep_gap_nights: 2 }), /cardio-sync-note/);
  assert.doesNotMatch(sync.lineHtml(CONFIGURED), /cardio-sync-note/);
});

test("an unconfigured Garmin says nothing at all, notes included", () => {
  const sync = loadCardioSync();

  assert.equal(sync.lineHtml({ garmin_sleep_gap_nights: 7, garmin_last_export_status: "failed: auth" }), "");
});
