// The self-hosted update-detection layer (src/updateCheck.ts). The network call
// itself isn't exercised (the harness is offline + deterministic) — we test the
// pure pieces and the app_state/settings-backed status roll-up, which is what the
// API/MCP surfaces and the scheduler actually read. Constitution: a check is PULL
// (cached, never pushed) and gated by settings.update_check_enabled.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { parseLatestRelease, computeUpdateStatus, getUpdateStatus } from "../dist/updateCheck.js";
import { getVersion } from "../dist/version.js";

beforeEach(() => {
  try { db.prepare("DELETE FROM app_state WHERE key = 'update_check'").run(); } catch {}
  try { db.prepare("DELETE FROM settings WHERE id = 1").run(); } catch {}
});

test("parseLatestRelease extracts and normalizes a GitHub release payload", () => {
  const r = parseLatestRelease({
    tag_name: "v0.7.0",
    html_url: "https://github.com/zilet/cairn/releases/tag/v0.7.0",
    body: "## Notes",
    published_at: "2026-07-01T00:00:00Z",
  });
  assert.equal(r.latest, "0.7.0"); // leading v stripped
  assert.equal(r.html_url, "https://github.com/zilet/cairn/releases/tag/v0.7.0");
  assert.equal(r.notes, "## Notes");
  assert.equal(r.published_at, "2026-07-01T00:00:00Z");
});

test("parseLatestRelease tolerates a missing/draft payload (no crash, nulls)", () => {
  const r = parseLatestRelease({});
  assert.equal(r.latest, null);
  assert.equal(r.html_url, null);
  assert.equal(r.notes, null);
  assert.equal(r.published_at, null);
});

test("computeUpdateStatus flags newer, holds on equal/older, and is null-safe", () => {
  const cache = { latest: "0.7.0", html_url: "u", notes: "n", published_at: null, checked_at: "t", error: null };
  assert.equal(computeUpdateStatus("0.6.1", cache, true).update_available, true);
  assert.equal(computeUpdateStatus("0.7.0", cache, true).update_available, false); // already on it
  assert.equal(computeUpdateStatus("0.8.0", cache, true).update_available, false); // ahead of latest
  // No cache yet → unknown, never an update.
  const none = computeUpdateStatus("0.6.1", null, true);
  assert.equal(none.update_available, false);
  assert.equal(none.latest, null);
  assert.equal(none.checked_at, null);
  // The toggle state is carried through verbatim.
  assert.equal(computeUpdateStatus("0.6.1", cache, false).enabled, false);
});

test("getUpdateStatus reads the cached check + the enabled flag, current = running version", () => {
  repo.setSettings({ update_check_enabled: false });
  repo.setAppState("update_check", JSON.stringify({
    latest: "9.9.9", html_url: "https://example/r", notes: null, published_at: null, checked_at: "2026-07-01T00:00", error: null,
  }));
  const st = getUpdateStatus();
  assert.equal(st.enabled, false, "reflects settings.update_check_enabled");
  assert.equal(st.current, getVersion(), "current is the running version");
  assert.equal(st.latest, "9.9.9");
  assert.equal(st.update_available, true, "9.9.9 is newer than any real running version");
  assert.equal(st.html_url, "https://example/r");
});

test("getUpdateStatus with no cached check reports current only (calm unknown)", () => {
  repo.setSettings({ update_check_enabled: true });
  const st = getUpdateStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.latest, null);
  assert.equal(st.update_available, false);
  assert.equal(st.error, null);
});
