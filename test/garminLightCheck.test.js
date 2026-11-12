// The light arrival check's edges: the PWA's foreground route, the auth guard over it,
// and the refreshed-token write-back that keeps a check at one list call.
//
// The route test proves "answers at once" by the response arriving while the fake
// Garmin list call is still held open — no timing threshold.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import "./_seed.js";
import {
  GARMIN_LIGHT_FOREGROUND_MIN_MS,
  persistRefreshedGarminToken,
  requestGarminLightCheck,
  resetGarminLightCheckForTests,
  setGarminClientForTests,
  setGarminTokenDirForTests,
} from "../dist/garmin.js";
import { garminRouter } from "../dist/routes/garmin.js";

afterEach(() => {
  setGarminClientForTests(null);
  setGarminTokenDirForTests(null);
  resetGarminLightCheckForTests();
});

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use("/api", garminRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        resolve(await fn(base));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

async function check(base) {
  const res = await fetch(`${base}/api/garmin/check`, { method: "POST" });
  assert.equal(res.status, 200);
  return res.json();
}

// A Garmin whose list call stays open until the test releases it.
function heldGarmin() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const state = { lists: 0, release: () => release() };
  state.client = {
    async getActivities() {
      state.lists++;
      await gate;
      return [];
    },
  };
  return state;
}

test("POST /api/garmin/check answers at once, and the server holds the five-minute floor", async () => {
  const garmin = heldGarmin();
  setGarminClientForTests(() => garmin.client);
  assert.equal(GARMIN_LIGHT_FOREGROUND_MIN_MS, 5 * 60_000);
  await withServer(async (base) => {
    const first = await check(base);
    assert.deepEqual(first, { ok: true, started: true }, "answered while the list call is still open");
    assert.equal(garmin.lists, 1);
    // A second foreground in the same window joins the running check, never a second call.
    assert.deepEqual(await check(base), { ok: true, started: true });
    garmin.release();
    // Let the held check finish, then the floor answers without any call.
    await requestGarminLightCheck({ minIntervalMs: 0 }).catch(() => null);
    const again = await check(base);
    assert.deepEqual(again, { ok: true, started: false, skipped: "recent" });
    assert.equal(garmin.lists, 1, "the floor costs Garmin nothing");
  });
});

test("POST /api/garmin/check sits behind the auth guard like its sibling", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-garmin-check-auth-"));
  const script = `
    import assert from "node:assert/strict";
    const auth = await import("./dist/auth.js");
    const run = (method, p, token) => {
      let next = false, status = 0;
      const req = { method, path: p, query: {}, headers: {}, get(name) { return name.toLowerCase() === "authorization" && token ? "Bearer " + token : undefined; } };
      const res = { status(value) { status = value; return this; }, json() { return this; }, set() { return this; } };
      auth.authGuard(req, res, () => { next = true; });
      return { next, status };
    };
    for (const p of ["/api/garmin/check", "/api/garmin/sync"]) {
      assert.deepEqual(run("POST", p, null), { next: false, status: 401 }, p + " without a token");
      assert.deepEqual(run("POST", p, "owner-test-token"), { next: true, status: 0 }, p + " with the token");
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        CAIRN_AUTH_TOKEN: "owner-test-token",
        DATA_DIR: dataDir,
        DB_PATH: path.join(dataDir, "test.db"),
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---- the refreshed token -----------------------------------------------------------

// Shaped like garmin-connect's client: exportToken() hands back the live pair, and a
// 401 inside a call swaps the OAuth2 token for a fresh one (the library's refresh).
function tokenGarmin(state) {
  return {
    exportToken() {
      if (!state.oauth2) throw new Error("exportToken: Token not found");
      return { oauth1: state.oauth1, oauth2: state.oauth2 };
    },
    async getActivities() {
      state.lists++;
      if (state.refreshOnNextCall) {
        state.refreshOnNextCall = false;
        state.oauth2 = { access_token: `fresh-${state.lists}`, expires_at: 2_000_000_000 };
      }
      if (state.fail) throw new Error("401 Unauthorized");
      return [];
    },
  };
}

test("a token the library refreshed mid-check is written back, atomically, once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-garmin-token-"));
  try {
    setGarminTokenDirForTests(dir);
    // The stored pair, with the owner-only mode a real install keeps.
    const oauth1 = { oauth_token: "o1", oauth_token_secret: "s1" };
    fs.writeFileSync(path.join(dir, "oauth1_token.json"), JSON.stringify(oauth1), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "oauth2_token.json"), JSON.stringify({ access_token: "stale" }), { mode: 0o600 });
    const state = { lists: 0, oauth1, oauth2: { access_token: "stale" }, refreshOnNextCall: true };
    const client = tokenGarmin(state);
    setGarminClientForTests(() => client);

    const first = await requestGarminLightCheck({ minIntervalMs: 0 });
    assert.equal(first.checked, true);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "oauth2_token.json"), "utf8"));
    assert.equal(stored.access_token, "fresh-1", "the refreshed token replaced the stale one");
    assert.equal(fs.statSync(path.join(dir, "oauth2_token.json")).mode & 0o777, 0o600, "the file keeps its mode");
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      ["oauth1_token.json", "oauth2_token.json"],
      "no temp file is left behind"
    );

    // Unchanged on the next check: no rewrite.
    fs.rmSync(path.join(dir, "oauth2_token.json"));
    await requestGarminLightCheck({ minIntervalMs: 0 });
    assert.equal(fs.existsSync(path.join(dir, "oauth2_token.json")), false, "an unchanged token is not written");
    assert.equal(persistRefreshedGarminToken(client), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a check whose refresh landed but whose call failed still keeps the token, then rests an hour", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-garmin-token-"));
  try {
    setGarminTokenDirForTests(dir);
    const state = {
      lists: 0,
      oauth1: { oauth_token: "o1" },
      oauth2: { access_token: "stale" },
      refreshOnNextCall: true,
      fail: true,
    };
    setGarminClientForTests(() => tokenGarmin(state));
    const out = await requestGarminLightCheck({ minIntervalMs: 0 });
    assert.match(String(out.error), /401/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "oauth2_token.json"), "utf8")).access_token, "fresh-1");
    assert.equal((await requestGarminLightCheck({ minIntervalMs: 0 })).skipped, "backoff", "no loop: an hour's rest");
    assert.equal(state.lists, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a client with no usable token (a failed exchange cleared it) writes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-garmin-token-"));
  try {
    setGarminTokenDirForTests(dir);
    setGarminClientForTests(() => null);
    assert.equal(persistRefreshedGarminToken(tokenGarmin({ oauth1: { oauth_token: "o1" }, oauth2: null })), false);
    assert.equal(persistRefreshedGarminToken({}), false, "a client without exportToken");
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a test's fake client never writes into the real token dir", () => {
  setGarminClientForTests(() => null);
  const client = tokenGarmin({ oauth1: { oauth_token: "o1" }, oauth2: { access_token: "x" } });
  assert.equal(persistRefreshedGarminToken(client), false);
});
