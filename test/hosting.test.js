// How a release reaches THIS host (src/hosting.ts): platform detection, the update
// method each host gets, and POST /api/update/apply's two real actions — the deploy
// hook (mocked fetch; the URL is a credential and must never surface) and the
// installer's trigger file (written into a throwaway DATA_DIR). Offline: no request
// leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  UPDATE_REQUEST_FILE,
  UPDATER_STATUS_FILE,
  applyUpdate,
  deployHookUrl,
  detectPlatform,
  parseUpdaterStatus,
  updateCapability,
  updateMethodFor,
} from "../dist/hosting.js";
import { getUpdateStatus } from "../dist/updateCheck.js";

const HOOK = "https://hooks.example.com/deploy/srv-secret123?key=abcDEF";
const noDocker = () => false;

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cairn-hosting-"));
}

test("detectPlatform: explicit CAIRN_PLATFORM wins, then host markers, then /.dockerenv, else source", () => {
  assert.equal(detectPlatform({ CAIRN_PLATFORM: "installer", RAILWAY_PROJECT_ID: "p" }, noDocker), "installer");
  assert.equal(detectPlatform({ CAIRN_PLATFORM: " Docker " }, noDocker), "docker");
  assert.equal(detectPlatform({ RAILWAY_ENVIRONMENT_ID: "e" }, noDocker), "railway");
  assert.equal(detectPlatform({ RAILWAY_PROJECT_ID: "p" }, noDocker), "railway");
  assert.equal(detectPlatform({ CAIRN_PLATFORM: "unknown-host" }, noDocker), "source");
  assert.equal(
    detectPlatform({}, (p) => p === "/.dockerenv"),
    "docker"
  );
  assert.equal(detectPlatform({}, noDocker), "source");
  // An unknown name is not trusted; detection continues.
  assert.equal(detectPlatform({ CAIRN_PLATFORM: "heroku" }, noDocker), "source");
  assert.equal(
    detectPlatform({}, () => {
      throw new Error("EACCES");
    }),
    "source"
  );
});

test("updateMethodFor: trigger-file override, then an https hook, then the platform default", () => {
  assert.equal(updateMethodFor("railway", {}), "automatic");
  assert.equal(updateMethodFor("installer", {}), "trigger_file");
  assert.equal(updateMethodFor("docker", {}), "manual");
  assert.equal(updateMethodFor("source", {}), "manual");
  assert.equal(updateMethodFor("docker", { CAIRN_DEPLOY_HOOK_URL: HOOK }), "deploy_hook");
  assert.equal(updateMethodFor("docker", { CAIRN_UPDATE_METHOD: "trigger-file" }), "trigger_file");
  assert.equal(
    updateMethodFor("docker", { CAIRN_UPDATE_METHOD: "trigger-file", CAIRN_DEPLOY_HOOK_URL: HOOK }),
    "trigger_file"
  );
  // A plain-http (or junk) hook is ignored, never called.
  assert.equal(deployHookUrl({ CAIRN_DEPLOY_HOOK_URL: "http://hooks.example.com/deploy/x" }), null);
  assert.equal(deployHookUrl({ CAIRN_DEPLOY_HOOK_URL: "not a url" }), null);
  assert.equal(updateMethodFor("docker", { CAIRN_DEPLOY_HOOK_URL: "http://x.example/hook" }), "manual");
});

test("parseUpdaterStatus flags an updater quiet for more than three days as stale", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const fresh = parseUpdaterStatus(
    { installed: true, last_run: "2026-10-06T03:00:00Z", last_result: "ok: 2.0.0 → 2.1.0", version: "2.1.0" },
    now
  );
  assert.deepEqual(fresh, {
    installed: true,
    last_run: "2026-10-06T03:00:00Z",
    last_result: "ok: 2.0.0 → 2.1.0",
    version: "2.1.0",
    stale: false,
  });
  assert.equal(parseUpdaterStatus({ last_run: "2026-10-03T11:00:00Z" }, now).stale, true);
  assert.equal(parseUpdaterStatus({ installed: true }, now).stale, true, "never ran reads stale");
  assert.equal(parseUpdaterStatus(null, now), null);
});

test("updateCapability describes each host in one sentence and never carries the hook URL", () => {
  const dir = tempDataDir();
  const railway = updateCapability({ RAILWAY_PROJECT_ID: "p", DATA_DIR: dir });
  assert.equal(railway.platform, "railway");
  assert.equal(railway.update_method, "automatic");
  assert.equal(railway.can_apply, false);
  assert.match(railway.update_how, /automatically when Auto Updates is on/);

  const hooked = updateCapability({ CAIRN_PLATFORM: "docker", CAIRN_DEPLOY_HOOK_URL: HOOK, DATA_DIR: dir });
  assert.equal(hooked.update_method, "deploy_hook");
  assert.equal(hooked.can_apply, true);
  assert.doesNotMatch(JSON.stringify(hooked), /srv-secret123|abcDEF|hooks\.example\.com/);

  const badHook = updateCapability({ CAIRN_PLATFORM: "docker", CAIRN_DEPLOY_HOOK_URL: "http://plain/hook", DATA_DIR: dir });
  assert.equal(badHook.update_method, "manual");
  assert.equal(badHook.hook_misconfigured, true);
  assert.match(badHook.update_how, /updates by hand/);

  const installer = updateCapability(
    { CAIRN_PLATFORM: "installer", DATA_DIR: dir },
    Date.parse("2026-10-07T12:00:00Z")
  );
  assert.equal(installer.update_method, "trigger_file");
  assert.equal(installer.updater, null, "no updater report yet");
  fs.writeFileSync(
    path.join(dir, UPDATER_STATUS_FILE),
    JSON.stringify({ installed: true, last_run: "2026-10-07T03:00:00Z", last_result: "ok", version: "2.0.0" })
  );
  const reported = updateCapability({ CAIRN_PLATFORM: "installer", DATA_DIR: dir }, Date.parse("2026-10-07T12:00:00Z"));
  assert.equal(reported.updater.stale, false);
  assert.equal(reported.updater.version, "2.0.0");
});

test("getUpdateStatus carries the host capability alongside the release check", () => {
  const status = getUpdateStatus();
  for (const key of ["platform", "update_method", "can_apply", "update_how", "updater", "hook_misconfigured"]) {
    assert.ok(key in status, `status has ${key}`);
  }
  assert.ok("current" in status && "update_available" in status, "release fields still present");
});

test("applyUpdate (deploy_hook) POSTs the hook and reports success without echoing it", async () => {
  const calls = [];
  const result = await applyUpdate({
    env: { CAIRN_PLATFORM: "docker", CAIRN_DEPLOY_HOOK_URL: HOOK },
    fetch: async (url, init) => {
      calls.push({ url, method: init.method });
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(calls, [{ url: HOOK, method: "POST" }]);
  assert.equal(result.ok, true);
  assert.equal(result.method, "deploy_hook");
  assert.match(result.message, /rebuilding Cairn/);
});

test("applyUpdate (deploy_hook) failures are plain sentences that never name the hook", async () => {
  const refused = await applyUpdate({
    env: { CAIRN_PLATFORM: "docker", CAIRN_DEPLOY_HOOK_URL: HOOK },
    fetch: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /HTTP 404/);
  const offline = await applyUpdate({
    env: { CAIRN_PLATFORM: "docker", CAIRN_DEPLOY_HOOK_URL: HOOK },
    fetch: async (url) => {
      throw new TypeError(`fetch failed for ${url}`);
    },
  });
  assert.equal(offline.ok, false);
  for (const r of [refused, offline]) assert.doesNotMatch(JSON.stringify(r), /srv-secret123|abcDEF|hooks\.example\.com/);
});

test("applyUpdate (trigger_file) writes {requested_at} into DATA_DIR for the host updater", async () => {
  const dir = tempDataDir();
  const at = new Date("2026-10-07T12:34:56.000Z");
  const result = await applyUpdate({ env: { CAIRN_PLATFORM: "installer", DATA_DIR: dir }, now: () => at });
  assert.equal(result.ok, true);
  assert.equal(result.method, "trigger_file");
  assert.match(result.message, /hasn't reported in yet/, "no updater report: says so");
  const written = JSON.parse(fs.readFileSync(path.join(dir, UPDATE_REQUEST_FILE), "utf8"));
  assert.deepEqual(written, { requested_at: "2026-10-07T12:34:56.000Z" });
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
    "the atomic write leaves no temp file"
  );
  // The pending request now shows on the status.
  const cap = updateCapability({ CAIRN_PLATFORM: "installer", DATA_DIR: dir });
  assert.equal(cap.update_requested_at, "2026-10-07T12:34:56.000Z");

  // An explicit override puts a Docker host on the same path.
  const other = tempDataDir();
  const viaOverride = await applyUpdate({ env: { CAIRN_UPDATE_METHOD: "trigger-file", DATA_DIR: other } });
  assert.equal(viaOverride.method, "trigger_file");
  assert.ok(fs.existsSync(path.join(other, UPDATE_REQUEST_FILE)));
});

test("applyUpdate refuses, with the reason, on hosts that update themselves or only by hand", async () => {
  let fetched = false;
  const fetchSpy = async () => {
    fetched = true;
    return { ok: true, status: 200 };
  };
  const auto = await applyUpdate({ env: { RAILWAY_PROJECT_ID: "p" }, fetch: fetchSpy });
  assert.deepEqual([auto.ok, auto.method], [false, "automatic"]);
  assert.match(auto.message, /Auto Updates is on/);
  const manual = await applyUpdate({ env: { CAIRN_PLATFORM: "docker" }, fetch: fetchSpy });
  assert.deepEqual([manual.ok, manual.method], [false, "manual"]);
  assert.match(manual.message, /pull the new image/);
  assert.equal(fetched, false);
});
