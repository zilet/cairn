// Settings round-trip (src/repo.ts getSettings/setSettings). The agent rotation,
// the weekly auto-coach schedule, and the enrich/art toggles all live here and
// are editable at runtime — so a setSettings -> getSettings round-trip MUST
// persist faithfully and reject nonsense (an unknown strategy falls back).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";

const originalSettingsSecretKey = process.env.CAIRN_SETTINGS_SECRET_KEY;

beforeEach(() => {
  process.env.CAIRN_SETTINGS_SECRET_KEY = "";
  // Settings is a single id=1 row; reset it so each case starts from defaults.
  try { db.prepare("DELETE FROM settings WHERE id = 1").run(); } catch {}
});

after(() => {
  if (originalSettingsSecretKey === undefined) delete process.env.CAIRN_SETTINGS_SECRET_KEY;
  else process.env.CAIRN_SETTINGS_SECRET_KEY = originalSettingsSecretKey;
});

test("getSettings lazily creates the singleton with sane defaults", () => {
  const s = repo.getSettings();
  assert.equal(s.agent_strategy, "round_robin");
  assert.equal(s.coach_enabled, false);
  assert.equal(s.enrich_enabled, true);
  assert.equal(s.art_enabled, true);
  assert.equal(s.meal_prefs, "");
  assert.equal(s.update_check_enabled, true); // quiet update check on by default
});

test("setSettings -> getSettings persists the coach schedule + toggles", () => {
  repo.setSettings({
    agent_strategy: "priority",
    coach_enabled: true,
    coach_day: 3,
    coach_hour: 7,
    onboarded: true,
    enrich_enabled: false,
    art_enabled: false,
  });
  const s = repo.getSettings();
  assert.equal(s.agent_strategy, "priority");
  assert.equal(s.coach_enabled, true);
  assert.equal(s.coach_day, 3);
  assert.equal(s.coach_hour, 7);
  assert.equal(s.onboarded, true);
  assert.equal(s.enrich_enabled, false);
  assert.equal(s.art_enabled, false);
});

test("update_check_enabled round-trips and defaults ON for old NULL rows", () => {
  // Explicit off, then back on.
  repo.setSettings({ update_check_enabled: false });
  assert.equal(repo.getSettings().update_check_enabled, false);
  repo.setSettings({ update_check_enabled: true });
  assert.equal(repo.getSettings().update_check_enabled, true);
  // A pre-v47 row (column NULL) reads as ON (the migration default + rowToSettings guard).
  db.prepare("UPDATE settings SET update_check_enabled = NULL WHERE id = 1").run();
  assert.equal(repo.getSettings().update_check_enabled, true);
});

test("meal_prefs round-trips (trimmed, capped at 2000 chars)", () => {
  repo.setSettings({ meal_prefs: "  I train fasted most mornings  " });
  assert.equal(repo.getSettings().meal_prefs, "I train fasted most mornings");
  repo.setSettings({ meal_prefs: "x".repeat(5000) });
  assert.equal(repo.getSettings().meal_prefs.length, 2000);
});

test("an unknown agent_strategy falls back to round_robin", () => {
  repo.setSettings({ agent_strategy: "totally-bogus" });
  assert.equal(repo.getSettings().agent_strategy, "round_robin");
});

test("a partial patch leaves untouched fields intact", () => {
  repo.setSettings({ coach_hour: 9, coach_enabled: true });
  repo.setSettings({ coach_hour: 11 }); // only change the hour
  const s = repo.getSettings();
  assert.equal(s.coach_hour, 11);
  assert.equal(s.coach_enabled, true, "coach_enabled preserved across a partial patch");
});

test("agent_order / disabled_agents round-trip as arrays", () => {
  repo.setSettings({ agent_order: ["claude", "codex", "stub"], disabled_agents: ["grok"] });
  const s = repo.getSettings();
  assert.deepEqual(s.agent_order, ["claude", "codex", "stub"]);
  assert.deepEqual(s.disabled_agents, ["grok"]);
});

test("agent_routes default to an empty map (no routing)", () => {
  assert.deepEqual(repo.getSettings().agent_routes, {});
});

test("agent_routes round-trips known task -> known agent; drops unknowns", () => {
  // claude/stub are real agents.json entries; "bogus" is not; "frobnicate" is not a task.
  repo.setSettings({
    agent_routes: {
      chat: "claude",
      meal_plan: "stub",
      health_synthesis: "claude",
      session_suggest: "bogus",   // unknown agent → dropped
      frobnicate: "claude",       // unknown task → dropped
      day_read: "",               // empty value → dropped (back to Auto)
    },
  });
  const r = repo.getSettings().agent_routes;
  assert.equal(r.chat, "claude");
  assert.equal(r.meal_plan, "stub");
  assert.equal(r.health_synthesis, "claude");
  assert.ok(!("session_suggest" in r), "route to an unknown agent is dropped");
  assert.ok(!("frobnicate" in r), "route under an unknown task is dropped");
  assert.ok(!("day_read" in r), "an empty route value clears the pin");
});

test("a partial patch leaves agent_routes intact", () => {
  repo.setSettings({ agent_routes: { chat: "claude" } });
  repo.setSettings({ coach_hour: 10 }); // unrelated change
  assert.deepEqual(repo.getSettings().agent_routes, { chat: "claude" });
});

test("setSettings({agent_routes:{}}) clears all routing", () => {
  repo.setSettings({ agent_routes: { chat: "claude", meal_plan: "stub" } });
  repo.setSettings({ agent_routes: {} });
  assert.deepEqual(repo.getSettings().agent_routes, {});
});

test("settings-saved secrets stay out of API-shaped settings responses", () => {
  repo.setSettings({
    garmin_username: "athlete@example.com",
    garmin_password: "watch-password",
    gemini_api_key: "gemini-key",
  });
  const s = repo.getSettings();
  assert.equal("garmin_password" in s, false);
  assert.equal("gemini_api_key" in s, false);
  assert.equal(s.garmin_password_configured, true);
  assert.equal(s.gemini_api_key_configured, true);
  assert.deepEqual(repo.getGarminCredentials(), {
    username: "athlete@example.com",
    password: "watch-password",
    configured: true,
  });
  assert.equal(repo.getGeminiApiKey(), "gemini-key");
});

test("CAIRN_SETTINGS_SECRET_KEY encrypts Settings-saved Garmin and Gemini secrets", () => {
  process.env.CAIRN_SETTINGS_SECRET_KEY = "0".repeat(64);
  repo.setSettings({
    garmin_username: "athlete@example.com",
    garmin_password: "watch-password",
    gemini_api_key: "gemini-key",
  });

  const raw = db.prepare(
    "SELECT garmin_password, garmin_password_encrypted, gemini_api_key, gemini_api_key_encrypted FROM settings WHERE id = 1"
  ).get();
  assert.equal(raw.garmin_password, "");
  assert.equal(raw.gemini_api_key, "");
  assert.match(raw.garmin_password_encrypted, /^enc:v1:/);
  assert.match(raw.gemini_api_key_encrypted, /^enc:v1:/);
  assert.deepEqual(repo.getGarminCredentials(), {
    username: "athlete@example.com",
    password: "watch-password",
    configured: true,
  });
  assert.equal(repo.getGeminiApiKey(), "gemini-key");
  assert.equal(repo.getSettings().garmin_credentials_source, "settings");
  assert.equal(repo.getSettings().gemini_api_key_source, "settings");

  repo.setSettings({ coach_hour: 6 });
  const afterPartial = db.prepare(
    "SELECT garmin_password, garmin_password_encrypted, gemini_api_key, gemini_api_key_encrypted FROM settings WHERE id = 1"
  ).get();
  assert.equal(afterPartial.garmin_password, "");
  assert.equal(afterPartial.gemini_api_key, "");
  assert.equal(afterPartial.garmin_password_encrypted, raw.garmin_password_encrypted);
  assert.equal(afterPartial.gemini_api_key_encrypted, raw.gemini_api_key_encrypted);
});

test("legacy plaintext Settings secrets seal themselves once an encryption key is present", () => {
  repo.setSettings({
    garmin_username: "athlete@example.com",
    garmin_password: "legacy-password",
    gemini_api_key: "legacy-gemini",
  });
  let raw = db.prepare(
    "SELECT garmin_password, garmin_password_encrypted, gemini_api_key, gemini_api_key_encrypted FROM settings WHERE id = 1"
  ).get();
  assert.equal(raw.garmin_password, "legacy-password");
  assert.equal(raw.gemini_api_key, "legacy-gemini");
  assert.equal(raw.garmin_password_encrypted, "");
  assert.equal(raw.gemini_api_key_encrypted, "");

  process.env.CAIRN_SETTINGS_SECRET_KEY = "seal-test-key";
  assert.equal(repo.getSettings().garmin_password_configured, true);
  raw = db.prepare(
    "SELECT garmin_password, garmin_password_encrypted, gemini_api_key, gemini_api_key_encrypted FROM settings WHERE id = 1"
  ).get();
  assert.equal(raw.garmin_password, "");
  assert.equal(raw.gemini_api_key, "");
  assert.match(raw.garmin_password_encrypted, /^enc:v1:/);
  assert.match(raw.gemini_api_key_encrypted, /^enc:v1:/);
  assert.deepEqual(repo.getGarminCredentials(), {
    username: "athlete@example.com",
    password: "legacy-password",
    configured: true,
  });
  assert.equal(repo.getGeminiApiKey(), "legacy-gemini");
});

test("clear flags remove encrypted Settings secrets without requiring plaintext echoes", () => {
  process.env.CAIRN_SETTINGS_SECRET_KEY = "clear-test-key";
  repo.setSettings({
    garmin_username: "athlete@example.com",
    garmin_password: "watch-password",
    gemini_api_key: "gemini-key",
  });
  repo.setSettings({ clear_garmin_password: true, clear_gemini_api_key: true });
  const raw = db.prepare(
    "SELECT garmin_password, garmin_password_encrypted, gemini_api_key, gemini_api_key_encrypted FROM settings WHERE id = 1"
  ).get();
  assert.equal(raw.garmin_password, "");
  assert.equal(raw.garmin_password_encrypted, "");
  assert.equal(raw.gemini_api_key, "");
  assert.equal(raw.gemini_api_key_encrypted, "");
  assert.equal(repo.getGarminCredentials().configured, false);
  assert.equal(repo.getGeminiApiKey(), "");
});
