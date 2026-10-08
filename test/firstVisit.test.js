// The unauthenticated /api/health tells the sign-in screen where the access token lives, but
// ONLY while nobody has ever signed in (the boot's first-sign-in condition), and never a secret.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

const MASTER = "test-master-token-first-visit-0123456789";
process.env.CAIRN_AUTH_TOKEN = MASTER;
process.env.CAIRN_RATE_LIMIT = "0";

const express = (await import("express")).default;
const auth = await import("../dist/auth.js");
const { authRouter } = await import("../dist/routes/auth.js");
const { systemRouter } = await import("../dist/routes/system.js");
const devicesRepo = await import("../dist/repo/auth-devices.js");

const app = express();
app.use(express.json());
app.use(auth.authGuard);
app.use("/api", systemRouter);
app.use("/api", authRouter);
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const P = "11111111-2222-3333-4444-555555555555";
const S = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const E = "99999999-8888-7777-6666-000000000000";
const KEYS = ["CAIRN_PLATFORM", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID", "RAILWAY_ENVIRONMENT_ID"];
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});

const health = async () => (await fetch(`${BASE}/api/health`)).json();

test("first_visit appears only on a never-signed-in install, with no secret in the payload", async () => {
  Object.assign(process.env, { RAILWAY_PROJECT_ID: P, RAILWAY_SERVICE_ID: S, RAILWAY_ENVIRONMENT_ID: E });
  const line = devicesRepo.firstSignInNotice({ authEnabled: true, env: {} });
  const code = /#pair=([A-Z2-9-]+)/.exec(line)[1];
  const body = await health();
  assert.deepEqual(body.first_visit, {
    platform: "railway",
    host_settings_url: `https://railway.com/project/${P}/service/${S}/variables?environmentId=${E}`,
    log_code: true,
  });
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(MASTER) && !raw.includes(code) && !raw.includes(code.replace("-", "")));
});

test("log_code is false when no live first-sign-in code exists; the other platforms carry no URL", async () => {
  process.env.CAIRN_PLATFORM = "installer";
  assert.deepEqual((await health()).first_visit, { platform: "installer", host_settings_url: null, log_code: false });
  process.env.CAIRN_PLATFORM = "docker";
  assert.equal((await health()).first_visit.platform, "docker");
});

test("the Railway URL is built only from valid ids", async () => {
  Object.assign(process.env, { RAILWAY_PROJECT_ID: P, RAILWAY_SERVICE_ID: "x/../evil", RAILWAY_ENVIRONMENT_ID: E });
  const body = await health();
  assert.equal(body.first_visit.platform, "railway");
  assert.equal(body.first_visit.host_settings_url, null);
});

test("first_visit is gone once a device exists, a passkey exists, or the master token was used", async () => {
  assert.ok((await health()).first_visit, "fresh install");
  const res = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MASTER}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 200);
  assert.equal("first_visit" in (await health()), false);
});

test("an onboarded (upgraded) install never shows first_visit", async () => {
  const { db } = await import("../dist/db.js");
  db.prepare("INSERT INTO settings (id) VALUES (1) ON CONFLICT(id) DO NOTHING").run();
  db.prepare("UPDATE settings SET onboarded = 1 WHERE id = 1").run();
  assert.equal("first_visit" in (await health()), false);
});

// ---- later additions: other ways a first visit ends, /auth/pair's `first`, the cache law ----

const resetInstall = async () => {
  const { db } = await import("../dist/db.js");
  for (const t of ["auth_devices", "auth_passkeys", "auth_pairing_codes"]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {}
  }
  db.prepare("DELETE FROM app_state WHERE key = 'auth_master_used_at'").run();
  db.prepare("UPDATE settings SET onboarded = 0 WHERE id = 1").run();
};

test("first_visit is gone after a device made by a pairing code alone, and log_code drops once spent", async () => {
  await resetInstall();
  const line = devicesRepo.firstSignInNotice({ authEnabled: true, env: {} });
  const code = /#pair=([A-Z2-9-]+)/.exec(line)[1];
  assert.equal((await health()).first_visit.log_code, true);
  const res = await fetch(`${BASE}/api/auth/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).first, true, "a first_sign_in code says so");
  assert.equal("first_visit" in (await health()), false);
});

test("an ordinary pairing code does not claim `first`", async () => {
  await resetInstall();
  const { code } = devicesRepo.createPairingCode({ purpose: "pair" });
  const res = await fetch(`${BASE}/api/auth/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(res.status, 200);
  assert.equal("first" in (await res.json()), false);
});

test("log_code is false once the first-sign-in code is consumed, with no device yet", async () => {
  await resetInstall();
  const line = devicesRepo.firstSignInNotice({ authEnabled: true, env: {} });
  const code = /#pair=([A-Z2-9-]+)/.exec(line)[1];
  assert.equal(devicesRepo.consumePairingCode(code), true);
  const body = await health();
  assert.equal(body.first_visit?.log_code, false);
});

test("first_visit is gone after a passkey alone", async () => {
  await resetInstall();
  assert.ok((await health()).first_visit);
  devicesRepo.addPasskey({ deviceId: null, credentialId: "cred-first-visit", publicKey: "pk", signCount: 0 });
  assert.equal("first_visit" in (await health()), false);
});

test("firstVisitHelp is null with auth off; /health is never cached", async () => {
  await resetInstall();
  assert.equal(devicesRepo.firstVisitHelp({ authEnabled: false, platform: "docker" }), null);
  const { apiCacheControlFor } = await import("../dist/api.js");
  assert.equal(apiCacheControlFor("/health"), "private, no-store");
});
