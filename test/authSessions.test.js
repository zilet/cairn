// Hosted access: per-device sessions, one-time pairing codes, passkey plumbing and the
// guard matrix — over real HTTP against the real guard + router (src/auth.ts,
// src/routes/auth.ts), with a configured master token.
//
// The token must be in the environment BEFORE dist/auth.js loads (it is read once at
// module load), so every dist import below is dynamic.
import { test, after } from "node:test";
import assert from "node:assert/strict";

const MASTER = "test-master-token-0123456789abcdef";
process.env.CAIRN_AUTH_TOKEN = MASTER;
process.env.CAIRN_RATE_LIMIT = "0";

const express = (await import("express")).default;
const auth = await import("../dist/auth.js");
const { authRouter } = await import("../dist/routes/auth.js");
const { appleHealthRouter } = await import("../dist/routes/apple-health.js");
const { systemRouter } = await import("../dist/routes/system.js");
const devicesRepo = await import("../dist/repo/auth-devices.js");
const appleRepo = await import("../dist/repo/apple-health.js");
const { db } = await import("../dist/db.js");

assert.equal(auth.authEnabled, true, "the master token reached dist/auth.js");

const app = express();
// One trusted hop, so a test can speak from several client addresses (X-Forwarded-For);
// without the header req.ip is still the socket peer.
app.set("trust proxy", 1);
app.use(express.json());
app.use(auth.authGuard);
app.use("/api", systemRouter);
app.use("/api", authRouter);
app.use("/api", appleHealthRouter);
app.get("/api/thing", (req, res) => res.json({ ok: true, principal: auth.authPrincipal(req) }));
app.post("/api/thing", (req, res) => res.json({ ok: true, principal: auth.authPrincipal(req) }));
app.post("/mcp", (_req, res) => res.json({ ok: true }));

const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;
const HOST = `127.0.0.1:${server.address().port}`;
after(() => server.close());

async function call(path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json, cookies: res.headers.getSetCookie() };
}

const master = { Authorization: `Bearer ${MASTER}` };
const sameOrigin = { Origin: BASE };

function sessionFrom(cookies) {
  const line = cookies.find((c) => c.startsWith("cairn_session="));
  assert.ok(line, `a session cookie was set: ${JSON.stringify(cookies)}`);
  return line.split(";")[0].slice("cairn_session=".length);
}

async function signInWithMaster() {
  const res = await call("/api/auth/session", { method: "POST", headers: master, body: {} });
  assert.equal(res.status, 200);
  return { secret: sessionFrom(res.cookies), res };
}

test("the master token mints a device session: HttpOnly, SameSite=Strict, 180 days, no Secure on plain http", async () => {
  const { secret, res } = await signInWithMaster();
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  const cookie = res.cookies.find((c) => c.startsWith("cairn_session="));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=15552000/);
  assert.doesNotMatch(cookie, /Secure/, "plain http never marks the cookie Secure");
  assert.equal(res.json.ok, true);
  assert.equal(res.json.device.current, true);
  // Only the hash is stored.
  const row = db.prepare("SELECT session_hash FROM auth_devices").get();
  assert.equal(row.session_hash, devicesRepo.sha256Hex(secret));
  assert.notEqual(row.session_hash, secret);
});

test("Secure rides the cookie exactly when the request is https", async () => {
  const { sessionCookie, clearedSessionCookie } = await import("../dist/authHttp.js");
  assert.match(sessionCookie("abc", { secure: true }), /; Secure$/);
  assert.doesNotMatch(sessionCookie("abc", { secure: false }), /Secure/);
  assert.match(clearedSessionCookie({ secure: true }), /Max-Age=0/);
});

test("a device session never mints another: /auth/session hands back the one it carries, no new row", async () => {
  const { secret } = await signInWithMaster();
  const rows = () => db.prepare("SELECT COUNT(*) AS n FROM auth_devices").get().n;
  assert.equal(rows(), 1);
  // Cookie alone, or cookie AND the master token (the boot swap racing a session that
  // just landed): the same device, no Set-Cookie, no second row.
  for (const headers of [{}, master]) {
    const res = await call("/api/auth/session", {
      method: "POST",
      headers: { Cookie: `cairn_session=${secret}`, ...sameOrigin, ...headers },
      body: {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.reused, true);
    assert.equal(res.json.device.current, true);
    assert.ok(!res.cookies.some((c) => c.startsWith("cairn_session=")), "no new secret");
  }
  assert.equal(rows(), 1, "still one device");

  // No live session and no master token: refused.
  const bare = await call("/api/auth/session", { method: "POST", headers: { Cookie: "cairn_session=x" }, body: {} });
  assert.equal(bare.status, 401);
});

test("two concurrent token swaps from one page load leave one device row", async () => {
  // The live-test failure: the inline boot script and a second caller both POSTed
  // /auth/session with the legacy token and got "Chrome on Mac" twice.
  const ua = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36" };
  const body = { device_hint: "browser-hint-0123456789" };
  const [a, b] = await Promise.all([
    call("/api/auth/session", { method: "POST", headers: { ...master, ...ua }, body }),
    call("/api/auth/session", { method: "POST", headers: { ...master, ...ua }, body }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const devices = db.prepare("SELECT * FROM auth_devices WHERE revoked_at IS NULL").all();
  assert.equal(devices.length, 1, "one row for one browser");
  assert.equal(devices[0].name, "Chrome on Mac");
  // The later swap's secret is the live one; the earlier one no longer opens anything.
  const live = [sessionFrom(a.cookies), sessionFrom(b.cookies)].filter(
    (s) => devicesRepo.deviceForSessionSecret(s) != null
  );
  assert.equal(live.length, 1);
  assert.notEqual(devices[0].hint_hash, body.device_hint, "the hint is stored hashed");
});

test("the same browser signing in again lands on its own LIVE row; a revoked row is never brought back", async () => {
  const ua = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1 Mobile" };
  const hint = "phone-hint-abcdefghijkl";
  const first = await call("/api/auth/session", {
    method: "POST",
    headers: { ...master, ...ua },
    body: { device_hint: hint },
  });
  const id = first.json.device.id;
  await call(`/api/auth/devices/${id}`, { method: "PATCH", headers: master, body: { name: "Kitchen phone" } });
  const own = sessionFrom(first.cookies);

  // Signing in again while the row is live (a cleared cookie jar, say): the same row, a fresh secret.
  const { code: again } = devicesRepo.createPairingCode();
  const relog = await call("/api/auth/pair", { method: "POST", headers: ua, body: { code: again, device_hint: hint } });
  assert.equal(relog.status, 200);
  assert.equal(relog.json.device.id, id, "its own live row");
  assert.equal(relog.json.device.name, "Kitchen phone");
  assert.equal(devicesRepo.deviceForSessionSecret(own), null, "the older secret stops working");
  const live = sessionFrom(relog.cookies);

  // Signed out (this device signing itself out keeps it on the list of rows, revoked).
  const out = await call("/api/auth/logout", {
    method: "POST",
    headers: { Cookie: `cairn_session=${live}`, ...sameOrigin },
    body: {},
  });
  assert.equal(out.status, 200);

  // A pairing code signs the same browser back in on a NEW row: a revocation is final. Only
  // the label it was given carries over.
  const { code } = devicesRepo.createPairingCode();
  const back = await call("/api/auth/pair", { method: "POST", headers: ua, body: { code, device_hint: hint } });
  assert.equal(back.status, 200);
  assert.notEqual(back.json.device.id, id, "never the revoked row");
  assert.equal(back.json.device.name, "Kitchen phone", "the name it was given carries over");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_devices").get().n, 2);
  assert.ok(devicesRepo.getDevice(id).revoked_at, "the revoked row stays revoked");
  assert.equal(devicesRepo.deviceForSessionSecret(live), null, "the old secret stays dead");
  // The new row is now this browser's live row: the next sign-in reuses it.
  const { code: third } = devicesRepo.createPairingCode();
  const next = await call("/api/auth/pair", { method: "POST", headers: ua, body: { code: third, device_hint: hint } });
  assert.equal(next.json.device.id, back.json.device.id);

  // A different browser on the same phone (another UA summary), or no hint: a new row.
  const chrome = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/130.0 Mobile" };
  const other = await call("/api/auth/session", {
    method: "POST",
    headers: { ...master, ...chrome },
    body: { device_hint: hint },
  });
  assert.notEqual(other.json.device.id, id);
  const none = await call("/api/auth/session", { method: "POST", headers: { ...master, ...ua }, body: {} });
  assert.notEqual(none.json.device.id, id);
  // A malformed hint is ignored, never matched.
  const junk = await call("/api/auth/session", {
    method: "POST",
    headers: { ...master, ...ua },
    body: { device_hint: "x" },
  });
  assert.notEqual(junk.json.device.id, id);
});

test("a pairing link opened by a browser that is already signed in keeps its session and leaves the code unspent", async () => {
  const { secret } = await signInWithMaster();
  const { code } = devicesRepo.createPairingCode();
  const res = await call("/api/auth/pair", {
    method: "POST",
    headers: { Cookie: `cairn_session=${secret}` },
    body: { code },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.already_signed_in, true);
  assert.ok(!res.cookies.some((c) => c.startsWith("cairn_session=")));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_devices").get().n, 1);
  assert.equal(devicesRepo.outstandingPairingCodeCount(), 1, "the code still works for the device it was meant for");
  const phone = await call("/api/auth/pair", { method: "POST", body: { code } });
  assert.equal(phone.status, 200);
  assert.equal(phone.json.already_signed_in, undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_devices").get().n, 2);
});

test("passkey sign-in from a browser already signed in returns that session; nothing is spent", async () => {
  const { secret } = await signInWithMaster();
  const res = await call("/api/auth/passkeys/login/verify", {
    method: "POST",
    headers: { Cookie: `cairn_session=${secret}` },
    body: { response: { id: "nope" } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.already_signed_in, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_devices").get().n, 1);
});

test("resource links: a signed-in client mints a two-minute, one-path ?sig= a cookieless browser can open", async () => {
  const { secret } = await signInWithMaster();
  const cookie = { Cookie: `cairn_session=${secret}`, ...sameOrigin };
  // Minting needs a signed-in caller.
  const anon = await call("/api/auth/resource-link", { method: "POST", body: { path: "/api/export" } });
  assert.equal(anon.status, 401);
  const minted = await call("/api/auth/resource-link", {
    method: "POST",
    headers: cookie,
    body: { path: "/api/health-docs/5/file?x=1&token=leak" },
  });
  assert.equal(minted.status, 200);
  const url = new URL(minted.json.url, BASE);
  assert.equal(url.pathname, "/api/health-docs/5/file");
  assert.equal(url.searchParams.get("x"), "1");
  assert.equal(url.searchParams.get("token"), null, "a credential on the way in is dropped");
  const sig = url.searchParams.get("sig");
  assert.match(sig, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.json.expires_in_sec, 120);

  // Only the allowlisted GET paths are linkable — never a write, never a broader read.
  for (const path of [
    "/api/thing",
    "/api/auth/devices",
    "/api/../api/export",
    "https://evil.example/api/export",
    "//evil/api/export",
    "/api/export#x",
  ]) {
    const refused = await call("/api/auth/resource-link", { method: "POST", headers: cookie, body: { path } });
    assert.equal(refused.status, 400, path);
  }

  // The guard: ?sig= opens exactly its own path, GET only, and is no session.
  app.get("/api/health-docs/:id/file", (req, res) => res.json({ ok: true, principal: auth.authPrincipal(req) }));
  app.get("/api/export", (req, res) => res.json({ ok: true, principal: auth.authPrincipal(req) }));
  const other = await call(`/api/export?sig=${sig}`);
  assert.equal(other.status, 401, "bound to one path");
  // ...and to its exact query: a changed, dropped or added parameter never opens.
  assert.equal((await call(`/api/health-docs/5/file?x=2&sig=${sig}`)).status, 401, "another value");
  assert.equal((await call(`/api/health-docs/5/file?sig=${sig}`)).status, 401, "a dropped parameter");
  assert.equal((await call(`/api/health-docs/5/file?x=1&y=1&sig=${sig}`)).status, 401, "an added parameter");
  const opened = await fetch(`${BASE}/api/health-docs/5/file?sig=${sig}&x=1`);
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual((await opened.json()).principal, { kind: "link" });
  assert.ok(
    !opened.headers.getSetCookie().some((c) => c.startsWith("cairn_session=")),
    "a link never signs a browser in"
  );
  assert.equal((await call(`/api/health-docs/6/file?sig=${sig}&x=1`)).status, 401);
  assert.equal((await call(`/api/thing?sig=${sig}&x=1`)).status, 401, "never off the allowlist");
});

test("ResourceLinkStore: two minutes from minting, thirty seconds after first use, one path and query", async () => {
  const { ResourceLinkStore, RESOURCE_LINK_TTL_MS, RESOURCE_LINK_GRACE_MS, canonicalLinkQuery } = await import(
    "../dist/authHttp.js"
  );
  const store = new ResourceLinkStore();
  const t0 = 1_000_000;
  const sig = store.mint("/api/export", "", t0);
  assert.equal(store.use(sig, "/api/export/db", "", t0), false, "another path");
  assert.equal(store.use("x".repeat(43), "/api/export", "", t0), false, "an unknown sig");
  assert.equal(store.use(sig, "/api/export", "?format=csv", t0), false, "an added query");
  assert.equal(store.use(sig, "/api/export", `?sig=${sig}`, t0 + 1000), true, "first use (sig itself aside)");
  assert.equal(
    store.use(sig, "/api/export", "", t0 + 1000 + RESOURCE_LINK_GRACE_MS - 1),
    true,
    "a range request inside the grace"
  );
  assert.equal(store.use(sig, "/api/export", "", t0 + 1000 + RESOURCE_LINK_GRACE_MS), false, "then it is gone");
  const unused = store.mint("/api/export", "", t0);
  assert.equal(
    store.use(unused, "/api/export", "", t0 + RESOURCE_LINK_TTL_MS),
    false,
    "never used, still dead at two minutes"
  );

  // The query is canonical: order and encoding never matter, a value always does.
  assert.equal(canonicalLinkQuery("?b=2&a=1&sig=zzz"), canonicalLinkQuery("a=1&b=2"));
  assert.equal(canonicalLinkQuery("?name=a%20b"), canonicalLinkQuery("?name=a+b"));
  const named = store.mint("/api/health-report", new URLSearchParams({ name: "A", lang: "en" }), t0);
  assert.equal(store.use(named, "/api/health-report", "?name=B&lang=en", t0), false, "another value");
  assert.equal(store.use(named, "/api/health-report", "?lang=en&name=A", t0), true, "same params, any order");
});

test("clientAddress: the WebSocket upgrade keys the limiter as Express's trust proxy would", async () => {
  const { clientAddress } = await import("../dist/authHttp.js");
  const xff = { "x-forwarded-for": "6.6.6.6, 1.2.3.4, 10.0.0.2" };
  assert.equal(clientAddress(xff, "10.0.0.1", 0), "10.0.0.1", "no trusted hop: the socket peer, header ignored");
  assert.equal(clientAddress(xff, "10.0.0.1", 1), "10.0.0.2", "one hop: the right-most forwarded address");
  assert.equal(clientAddress(xff, "10.0.0.1", 2), "1.2.3.4");
  assert.equal(clientAddress(xff, "10.0.0.1", 4), "6.6.6.6", "more hops than entries: the left-most");
  assert.equal(clientAddress({}, "10.0.0.1", 1), "10.0.0.1", "no header: the peer");
  assert.equal(clientAddress({ "x-forwarded-for": ["9.9.9.9", "8.8.8.8"] }, "p", 1), "8.8.8.8");
  assert.equal(clientAddress({}, undefined, 0), "unknown");

  // The same answer Express gives req.ip with the same hop count.
  const probe = express();
  probe.set("trust proxy", 2);
  probe.get("/ip", (req, res) => res.json({ ip: req.ip }));
  const s = await new Promise((resolve) => {
    const srv = probe.listen(0, "127.0.0.1", () => resolve(srv));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/ip`, {
      headers: { "X-Forwarded-For": xff["x-forwarded-for"] },
    });
    const { ip } = await res.json();
    assert.equal(clientAddress(xff, "127.0.0.1", 2), ip);
  } finally {
    s.close();
  }
});

test("the calendar link: one stable ?feed= that opens plan.ics alone, until it is reset", async () => {
  const { secret } = await signInWithMaster();
  const cookie = { Cookie: `cairn_session=${secret}`, ...sameOrigin };
  app.get("/api/plan.ics", (req, res) => res.json({ ok: true, principal: auth.authPrincipal(req) }));
  const first = await call("/api/auth/calendar-link", { method: "POST", headers: cookie, body: {} });
  const second = await call("/api/auth/calendar-link", { method: "POST", headers: cookie, body: {} });
  assert.equal(first.json.url, second.json.url, "subscribing on a second device never cuts off the first");
  const feed = new URL(first.json.url, BASE).searchParams.get("feed");
  assert.match(feed, /^[A-Za-z0-9_-]{43}$/);
  const read = await call(`/api/plan.ics?feed=${feed}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.principal, { kind: "feed" });
  assert.equal((await call(`/api/export?feed=${feed}`)).status, 401, "plan.ics alone");
  assert.equal((await call(`/api/plan.ics?feed=${"a".repeat(43)}`)).status, 401);
  // The master token's ?token= keeps working for subscriptions made before.
  assert.equal((await call(`/api/plan.ics?token=${MASTER}`)).status, 200);

  const reset = await call("/api/auth/calendar-link", { method: "DELETE", headers: cookie });
  assert.equal(reset.json.ok, true);
  assert.equal((await call(`/api/plan.ics?feed=${feed}`)).status, 401, "a reset link stops working");
  const fresh = await call("/api/auth/calendar-link", { method: "POST", headers: cookie, body: {} });
  assert.notEqual(fresh.json.url, first.json.url);
});

test("guard matrix: master, cookie, revoked cookie, none — and the exemptions stand", async () => {
  const { secret } = await signInWithMaster();
  const cookie = { Cookie: `cairn_session=${secret}` };

  assert.equal((await call("/api/thing")).status, 401, "nothing presented");
  assert.equal((await call("/api/thing", { headers: { Authorization: "Bearer nope" } })).status, 401);
  const viaMaster = await call("/api/thing", { headers: master });
  assert.equal(viaMaster.status, 200);
  assert.equal(viaMaster.json.principal.kind, "master");
  const viaCookie = await call("/api/thing", { headers: cookie });
  assert.equal(viaCookie.status, 200);
  assert.equal(viaCookie.json.principal.kind, "session");
  assert.equal((await call("/mcp", { method: "POST", headers: master, body: {} })).status, 200);

  // Exempt as before: liveness, the Apple Health config read and pairing exchange.
  const health = await call("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.auth_required, true);
  assert.deepEqual(health.json.auth_methods, { passkeys: false });
  assert.equal((await call("/api/apple-health/config")).status, 200);
  const exchange = await call("/api/apple-health/pairing/exchange", { method: "POST", body: { pairing_code: "x" } });
  assert.equal(exchange.status, 400, "reaches the route (an invalid code), never the guard's 401");
  // …and an Apple Health ingest token still opens exactly one route, never a session.
  const pairing = appleRepo.createAppleHealthPairing();
  const ingest = appleRepo.exchangeAppleHealthPairing(pairing.code);
  assert.equal((await call("/api/thing", { headers: { Authorization: `Bearer ${ingest.token}` } })).status, 401);

  // Revoked: the same cookie opens nothing, and is cleared.
  const id = db.prepare("SELECT id FROM auth_devices").get().id;
  const revoke = await call(`/api/auth/devices/${id}`, { method: "DELETE", headers: master });
  assert.equal(revoke.status, 200);
  const after = await call("/api/thing", { headers: cookie });
  assert.equal(after.status, 401);
  assert.ok(
    after.cookies.some((c) => c.startsWith("cairn_session=;") && /Max-Age=0/.test(c)),
    "a dead cookie is cleared"
  );
});

test("CSRF: a cookie-authenticated write needs this origin; reads and master-token writes do not", async () => {
  const { secret } = await signInWithMaster();
  const cookie = { Cookie: `cairn_session=${secret}` };
  assert.equal((await call("/api/thing", { method: "POST", headers: cookie, body: {} })).status, 403, "no Origin");
  assert.equal(
    (await call("/api/thing", { method: "POST", headers: { ...cookie, Origin: "https://evil.example" }, body: {} }))
      .status,
    403
  );
  assert.equal(
    (await call("/api/thing", { method: "POST", headers: { ...cookie, Referer: "https://evil.example/x" }, body: {} }))
      .status,
    403
  );
  assert.equal(
    (await call("/api/thing", { method: "POST", headers: { ...cookie, ...sameOrigin }, body: {} })).status,
    200
  );
  assert.equal(
    (await call("/api/thing", { method: "POST", headers: { ...cookie, Referer: `${BASE}/app/today` }, body: {} }))
      .status,
    200,
    "a same-origin Referer stands in for a missing Origin"
  );
  assert.equal((await call("/api/thing", { headers: cookie })).status, 200, "GET needs no Origin");
  assert.equal(
    (await call("/api/thing", { method: "POST", headers: master, body: {} })).status,
    200,
    "API clients unaffected"
  );
});

test("same-origin helpers: Host, trusted X-Forwarded-Host only, Origin before Referer", async () => {
  const { isSameOriginRequest, requestHostCandidates, relyingPartyFor, readSessionCookie } = await import(
    "../dist/authHttp.js"
  );
  const h = { host: "cairn.local:8787", origin: "http://cairn.local:8787" };
  assert.equal(isSameOriginRequest(h, 0), true);
  const proxied = {
    host: "10.0.0.2:8787",
    "x-forwarded-host": "cairn.example.app",
    origin: "https://cairn.example.app",
  };
  assert.equal(isSameOriginRequest(proxied, 0), false, "an untrusted hop's X-Forwarded-Host is ignored");
  assert.equal(isSameOriginRequest(proxied, 1), true);
  assert.deepEqual(requestHostCandidates(proxied, 1), ["10.0.0.2:8787", "cairn.example.app"]);
  assert.equal(isSameOriginRequest({ host: "a", origin: "null" }, 0), false);
  assert.equal(readSessionCookie("a=1; cairn_session=xyz; b=2"), "xyz");
  assert.equal(readSessionCookie("cairn_sessionx=1"), null);

  const rp = relyingPartyFor({
    hostname: "cairn.example.app",
    protocol: "http",
    host: "cairn.example.app",
    headers: { host: "cairn.example.app", origin: "https://cairn.example.app" },
    trustedProxyHops: 0,
  });
  assert.equal(rp.rpID, "cairn.example.app");
  assert.deepEqual(
    rp.origins,
    ["http://cairn.example.app", "https://cairn.example.app"],
    "a TLS proxy Cairn wasn't told about"
  );
  const foreign = relyingPartyFor({
    hostname: "cairn.example.app",
    protocol: "https",
    host: "cairn.example.app",
    headers: { host: "cairn.example.app", origin: "https://evil.example" },
    trustedProxyHops: 0,
  });
  assert.deepEqual(foreign.origins, ["https://cairn.example.app"], "a foreign Origin is never expected");
});

test("pairing codes: XXXX-XXXX from the unambiguous alphabet, single use, expiring, at most five live", async () => {
  const minted = await call("/api/auth/pairing-codes", { method: "POST", headers: master });
  assert.equal(minted.status, 200);
  assert.deepEqual(Object.keys(minted.json).sort(), ["code", "expires_at"]);
  assert.match(minted.json.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  const ttl = Date.parse(minted.json.expires_at) - Date.now();
  assert.ok(ttl > 9 * 60_000 && ttl <= 10 * 60_000, `ten minutes (got ${ttl})`);
  const stored = db.prepare("SELECT code_hash FROM auth_pairing_codes").all();
  assert.ok(!stored.some((r) => r.code_hash.includes(minted.json.code.replace("-", ""))), "only the hash is stored");

  // Typed lowercase, without the dash: still the same code.
  const typed = minted.json.code.toLowerCase().replace("-", " ");
  const paired = await call("/api/auth/pair", {
    method: "POST",
    headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile Safari/604.1" },
    body: { code: typed },
  });
  assert.equal(paired.status, 200);
  const secret = sessionFrom(paired.cookies);
  assert.equal(paired.json.device.name, "Safari on iPhone");
  assert.equal((await call("/api/thing", { headers: { Cookie: `cairn_session=${secret}` } })).status, 200);

  const again = await call("/api/auth/pair", { method: "POST", body: { code: minted.json.code } });
  assert.equal(again.status, 400, "a code works once");
  assert.equal(again.cookies.length, 0);

  // Expiry, directly against the repo clock.
  const old = devicesRepo.createPairingCode({ now: Date.now() - 11 * 60_000 });
  assert.equal(devicesRepo.consumePairingCode(old.code), false);

  // At most five outstanding: minting more retires the oldest.
  for (let i = 0; i < 7; i++) devicesRepo.createPairingCode();
  assert.equal(devicesRepo.outstandingPairingCodeCount(), 5);

  // A signed-in device may mint one too (same contract), and is recorded as its maker.
  const cookie = { Cookie: `cairn_session=${secret}`, ...sameOrigin };
  const fromDevice = await call("/api/auth/pairing-codes", { method: "POST", headers: cookie });
  assert.equal(fromDevice.status, 200);
  assert.match(fromDevice.json.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test("normalizePairingCode refuses ambiguous characters and wrong lengths", () => {
  assert.equal(devicesRepo.normalizePairingCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(devicesRepo.normalizePairingCode("ABCD-EFG0"), null, "0 is not in the alphabet");
  assert.equal(devicesRepo.normalizePairingCode("ABCD-EFGI"), null, "I is not in the alphabet");
  assert.equal(devicesRepo.normalizePairingCode("ABCD-EFG"), null);
  assert.equal(devicesRepo.normalizePairingCode(12345678), null);
});

test("devices: list marks this one, rename, revoke-others keeps this one and drops their passkeys", async () => {
  const a = await signInWithMaster();
  const b = await signInWithMaster();
  const c = await signInWithMaster();
  const cookieA = { Cookie: `cairn_session=${a.secret}`, ...sameOrigin };
  const list = await call("/api/auth/devices", { headers: cookieA });
  assert.equal(list.json.devices.length, 3);
  assert.equal(list.json.devices.filter((d) => d.current).length, 1);
  const idA = list.json.current_device_id;
  const idB = b.res.json.device.id;
  devicesRepo.addPasskey({ deviceId: idB, credentialId: "cred-b", publicKey: "pk", signCount: 0, name: "B" });
  devicesRepo.addPasskey({ deviceId: idA, credentialId: "cred-a", publicKey: "pk", signCount: 0, name: "A" });
  // Added under the master token alone (bound to nothing), and a synced one bound to A but
  // last used to sign C in: "sign out other devices" removes both.
  devicesRepo.addPasskey({ deviceId: null, credentialId: "cred-master", publicKey: "pk", signCount: 0, name: "M" });
  const synced = devicesRepo.addPasskey({
    deviceId: idA,
    credentialId: "cred-sync",
    publicKey: "pk",
    signCount: 0,
    name: "S",
  });
  devicesRepo.recordPasskeyUse(synced.id, { signCount: 1, deviceId: idA, usedByDeviceId: c.res.json.device.id });
  const preview = await call("/api/auth/devices", { headers: cookieA });
  assert.deepEqual(
    preview.json.revoke_others_removes_passkeys.map((p) => p.name).sort(),
    ["B", "M", "S"],
    "the confirm sheet names every passkey that goes"
  );
  assert.deepEqual(
    preview.json.devices.find((d) => d.id === idA).revoke_removes_passkeys,
    [],
    "signing THIS device out keeps its passkeys"
  );

  const renamed = await call(`/api/auth/devices/${idA}`, {
    method: "PATCH",
    headers: cookieA,
    body: { name: "  Kitchen\u0007 iPad " },
  });
  assert.equal(renamed.json.device.name, "Kitchen iPad");

  const others = await call("/api/auth/devices/revoke-others", { method: "POST", headers: cookieA });
  assert.equal(others.json.revoked, 2);
  assert.equal((await call("/api/thing", { headers: { Cookie: `cairn_session=${b.secret}` } })).status, 401);
  assert.equal((await call("/api/thing", { headers: { Cookie: `cairn_session=${c.secret}` } })).status, 401);
  assert.equal((await call("/api/thing", { headers: cookieA })).status, 200);
  assert.deepEqual(
    devicesRepo.listPasskeys().map((p) => p.credential_id),
    ["cred-a"],
    "the signed-out devices' passkeys are gone; this one's stays"
  );

  // Signing THIS device out clears its cookie but keeps its passkey: the way back in.
  const self = await call(`/api/auth/devices/${idA}`, { method: "DELETE", headers: cookieA });
  assert.equal(self.json.signed_out, true);
  assert.ok(self.cookies.some((x) => /Max-Age=0/.test(x)));
  assert.equal(devicesRepo.listPasskeys().length, 1);
  assert.equal((await call("/api/thing", { headers: cookieA })).status, 401);
});

test("revoking a device removes every passkey it could still hold: bound, added or last used", async () => {
  const phone = await signInWithMaster();
  const laptop = await signInWithMaster();
  const other = await signInWithMaster();
  const idPhone = phone.res.json.device.id;
  const idLaptop = laptop.res.json.device.id;
  const idOther = other.res.json.device.id;
  const cookie = { Cookie: `cairn_session=${phone.secret}`, ...sameOrigin };
  // Added on the laptop, now bound to the phone (it moved there).
  devicesRepo.addPasskey({
    deviceId: idPhone,
    registeredDeviceId: idLaptop,
    credentialId: "added",
    publicKey: "pk",
    signCount: 0,
    name: "Added",
  });
  // Added on the phone and still bound there, but last used to sign the laptop in (synced).
  const used = devicesRepo.addPasskey({
    deviceId: idPhone,
    credentialId: "used",
    publicKey: "pk",
    signCount: 0,
    name: "Used",
  });
  devicesRepo.recordPasskeyUse(used.id, { signCount: 1, deviceId: idPhone, usedByDeviceId: idLaptop });
  devicesRepo.addPasskey({ deviceId: idLaptop, credentialId: "bound", publicKey: "pk", signCount: 0, name: "Bound" });
  devicesRepo.addPasskey({
    deviceId: idOther,
    credentialId: "untouched",
    publicKey: "pk",
    signCount: 0,
    name: "Other",
  });
  assert.equal(devicesRepo.listPasskeys().find((p) => p.credential_id === "used").last_used_device_id, idLaptop);

  const list = await call("/api/auth/devices", { headers: cookie });
  assert.deepEqual(
    list.json.devices
      .find((d) => d.id === idLaptop)
      .revoke_removes_passkeys.map((p) => p.name)
      .sort(),
    ["Added", "Bound", "Used"]
  );
  const res = await call(`/api/auth/devices/${idLaptop}`, { method: "DELETE", headers: cookie });
  assert.equal(res.json.ok, true);
  assert.deepEqual(
    devicesRepo.listPasskeys().map((p) => p.credential_id),
    ["untouched"],
    "the laptop can mint nothing with a passkey it saw"
  );
});

test("logout ends only the presented session, and needs this origin when it carries one", async () => {
  const { secret } = await signInWithMaster();
  const cookie = { Cookie: `cairn_session=${secret}` };
  assert.equal((await call("/api/auth/logout", { method: "POST", headers: cookie })).status, 403);
  const out = await call("/api/auth/logout", { method: "POST", headers: { ...cookie, ...sameOrigin } });
  assert.equal(out.status, 200);
  assert.equal((await call("/api/thing", { headers: cookie })).status, 401);
  assert.equal((await call("/api/auth/logout", { method: "POST" })).status, 200, "no cookie: a harmless no-op");
});

test("sliding expiry: the last-seen stamp (and the cookie) move at most hourly; an idle session ends", async () => {
  const { secret } = await signInWithMaster();
  const cookie = { Cookie: `cairn_session=${secret}` };
  const fresh = await call("/api/thing", { headers: cookie });
  assert.equal(fresh.cookies.length, 0, "seen moments ago: no re-issue");
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  db.prepare("UPDATE auth_devices SET last_seen_at = ?").run(twoHoursAgo);
  const slid = await call("/api/thing", { headers: cookie });
  assert.ok(slid.cookies.some((c) => c.startsWith(`cairn_session=${secret}`) && /Max-Age=15552000/.test(c)));
  assert.notEqual(db.prepare("SELECT last_seen_at FROM auth_devices").get().last_seen_at, twoHoursAgo);
  db.prepare("UPDATE auth_devices SET last_seen_at = ?").run(new Date(Date.now() - 181 * 86400_000).toISOString());
  assert.equal((await call("/api/thing", { headers: cookie })).status, 401);
});

test("the first-sign-in code is minted at boot only while nobody can sign in, and only that line carries it", () => {
  const railway = devicesRepo.firstSignInNotice({
    authEnabled: true,
    env: { RAILWAY_PUBLIC_DOMAIN: "cairn-production.up.railway.app" },
  });
  assert.match(
    railway,
    /^First sign-in: open https:\/\/cairn-production\.up\.railway\.app\/#pair=[A-Z2-9]{4}-[A-Z2-9]{4} \(expires in 60 min, works once\)$/
  );
  const code = /#pair=([A-Z2-9-]+)/.exec(railway)[1];
  const row = db.prepare("SELECT purpose, created_at, expires_at FROM auth_pairing_codes").get();
  assert.equal(row.purpose, "first_sign_in");
  assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 60 * 60_000);

  // A second boot replaces the first boot's unused code.
  const plain = devicesRepo.firstSignInNotice({ authEnabled: true, env: {} });
  assert.match(
    plain,
    /^First sign-in: open your Cairn address followed by #pair=[A-Z2-9]{4}-[A-Z2-9]{4} \(expires in 60 min, works once\)$/
  );
  assert.equal(devicesRepo.consumePairingCode(code), false, "the previous boot's code is gone");
  assert.equal(devicesRepo.outstandingPairingCodeCount(), 1);

  // An open instance never mints one; neither does one with a device or a passkey.
  assert.equal(devicesRepo.firstSignInNotice({ authEnabled: false, env: {} }), null);
  devicesRepo.createDeviceSession({});
  assert.equal(devicesRepo.firstSignInNotice({ authEnabled: true, env: {} }), null);
  db.prepare("DELETE FROM auth_devices").run();
  devicesRepo.addPasskey({ deviceId: null, credentialId: "c", publicKey: "p", signCount: 0 });
  assert.equal(devicesRepo.firstSignInNotice({ authEnabled: true, env: {} }), null);
});

test("the first-sign-in line stops once the master token has worked, and can be turned off", async () => {
  // The owner opted out: no line, and no code minted for nobody to read.
  for (const value of ["0", "false", "off"]) {
    assert.equal(devicesRepo.firstSignInNotice({ authEnabled: true, env: { CAIRN_FIRST_SIGNIN_LOG: value } }), null);
  }
  assert.equal(devicesRepo.outstandingPairingCodeCount(), 0);
  assert.ok(devicesRepo.firstSignInNotice({ authEnabled: true, env: { CAIRN_FIRST_SIGNIN_LOG: "1" } }));

  // A wrong token never counts; the master token used successfully (an API client, a
  // sign-in that left no device behind) ends the line for good — the stamp holds no token.
  assert.equal((await call("/api/thing", { headers: { Authorization: "Bearer nope" } })).status, 401);
  assert.equal(devicesRepo.masterTokenEverUsed(), false);
  assert.equal((await call("/api/thing", { headers: master })).status, 200);
  assert.equal(devicesRepo.masterTokenEverUsed(), true);
  const stamp = db.prepare("SELECT value FROM app_state WHERE key = 'auth_master_used_at'").get();
  assert.ok(!Number.isNaN(Date.parse(stamp.value)));
  assert.ok(!stamp.value.includes(MASTER));
  assert.equal(devicesRepo.activeDeviceCount(), 0);
  assert.equal(devicesRepo.firstSignInNotice({ authEnabled: true, env: {} }), null);
});

test("rotating the access token evicts everyone: sessions, passkeys and pairing codes", async () => {
  assert.equal(devicesRepo.applyAccessTokenEpoch("token-one"), "first", "the first boot only remembers it");
  const a = await signInWithMaster();
  const b = await signInWithMaster();
  devicesRepo.addPasskey({ deviceId: a.res.json.device.id, credentialId: "k1", publicKey: "pk", signCount: 0 });
  devicesRepo.addPasskey({ deviceId: null, credentialId: "k2", publicKey: "pk", signCount: 0 });
  devicesRepo.createPairingCode();
  assert.equal(devicesRepo.applyAccessTokenEpoch("token-one"), "same", "a restart on the same token changes nothing");
  assert.equal((await call("/api/thing", { headers: { Cookie: `cairn_session=${a.secret}` } })).status, 200);

  const stored = db.prepare("SELECT value FROM app_state WHERE key = 'auth_token_fingerprint'").get().value;
  assert.match(stored, /^v1:[A-Za-z0-9_-]+:[0-9a-f]{64}$/);
  assert.ok(!stored.includes("token-one"), "a fingerprint, never the token");

  const mcpRepo = await import("../dist/repo/mcp-clients.js");
  const app = mcpRepo.createMcpTokenClient({ name: "Rotation test app" });
  assert.equal(mcpRepo.getMcpClient(app.client.id).revoked_at, null);
  assert.equal(devicesRepo.applyAccessTokenEpoch("token-two"), "changed");
  assert.ok(mcpRepo.getMcpClient(app.client.id).revoked_at, "a rotation disconnects connected AI apps too");
  for (const s of [a.secret, b.secret]) {
    assert.equal((await call("/api/thing", { headers: { Cookie: `cairn_session=${s}` } })).status, 401);
  }
  assert.equal(devicesRepo.activeDeviceCount(), 0);
  assert.equal(devicesRepo.passkeyCount(), 0);
  assert.equal(devicesRepo.outstandingPairingCodeCount(), 0);
  assert.equal(devicesRepo.applyAccessTokenEpoch("token-two"), "same", "the new token is remembered");
  // The boot wrapper reads the configured token; the line it logs carries no secret.
  assert.equal(typeof auth.accessTokenEpochAtBoot, "function");
});

test("the challenge store: single use, kind-bound, five-minute TTL", async () => {
  const { ChallengeStore, CHALLENGE_TTL_MS, challengeFromClientData } = await import("../dist/authHttp.js");
  const store = new ChallengeStore();
  const now = 1_000_000;
  store.put("c1", { kind: "login", rpID: "x" }, now);
  assert.equal(store.take("c1", "register", now), null, "wrong kind consumes and refuses");
  assert.equal(store.take("c1", "login", now), null, "already gone");
  store.put("c2", { kind: "login", rpID: "x" }, now);
  assert.equal(store.take("c2", "login", now + CHALLENGE_TTL_MS + 1), null, "expired");
  store.put("c3", { kind: "register", rpID: "x", deviceId: 4 }, now);
  assert.equal(store.take("c3", "register", now + 1000).deviceId, 4);
  assert.equal(store.take("c3", "register", now + 1000), null, "single use");
  const clientData = Buffer.from(JSON.stringify({ challenge: "abc", type: "webauthn.get" })).toString("base64url");
  assert.equal(challengeFromClientData(clientData), "abc");
  assert.equal(challengeFromClientData("%%%"), null);
});

test("sign-in challenges: one address holds five and churns only its own; registrations live elsewhere", async () => {
  const { ChallengeStore, MAX_LOGIN_CHALLENGES_PER_IP } = await import("../dist/authHttp.js");
  assert.equal(MAX_LOGIN_CHALLENGES_PER_IP, 5);
  const login = new ChallengeStore({ perIpMax: MAX_LOGIN_CHALLENGES_PER_IP });
  const register = new ChallengeStore();
  const now = 2_000_000;
  register.put("reg", { kind: "register", rpID: "x", deviceId: 1 }, now);
  login.put("owner", { kind: "login", rpID: "x", ip: "10.0.0.1" }, now);
  // A noisy address floods the sign-in door.
  for (let i = 0; i < 500; i++) login.put(`noise-${i}`, { kind: "login", rpID: "x", ip: "6.6.6.6" }, now + i);
  assert.equal(login.size(), 6, "the noisy address holds five; the owner's one stands");
  assert.equal(login.take("noise-494", "login", now + 600), null, "its own oldest went first");
  assert.ok(login.take("noise-499", "login", now + 600), "its newest is live");
  assert.ok(login.take("owner", "login", now + 600), "the owner's challenge survived the flood");
  assert.equal(register.take("reg", "register", now + 600).deviceId, 1, "registration was never touched");

  // The overall cap still bounds memory, spread across many addresses.
  const capped = new ChallengeStore({ max: 10, perIpMax: 5 });
  for (let i = 0; i < 50; i++) capped.put(`c${i}`, { kind: "login", rpID: "x", ip: `1.1.1.${i}` }, now);
  assert.equal(capped.size(), 10);
});

test("passkey options: registration needs a session and binds to it; login options are open and allow-list free", async () => {
  const { secret } = await signInWithMaster();
  const cookie = { Cookie: `cairn_session=${secret}`, ...sameOrigin, Host: HOST };
  assert.equal((await call("/api/auth/passkeys/register/options", { method: "POST", body: {} })).status, 401);
  const reg = await call("/api/auth/passkeys/register/options", { method: "POST", headers: cookie, body: {} });
  assert.equal(reg.status, 200);
  assert.equal(reg.json.rp.id, "127.0.0.1");
  assert.equal(reg.json.authenticatorSelection.residentKey, "required");
  assert.ok(reg.json.challenge.length >= 32);
  const login = await call("/api/auth/passkeys/login/options", { method: "POST", body: {} });
  assert.equal(login.status, 200);
  assert.equal(login.json.rpId, "127.0.0.1");
  assert.ok(
    !login.json.allowCredentials || login.json.allowCredentials.length === 0,
    "nothing about which passkeys exist"
  );

  // A forged assertion for a known credential fails cleanly — never a session.
  devicesRepo.addPasskey({
    deviceId: null,
    credentialId: "cred-x",
    publicKey: Buffer.from("not a key").toString("base64url"),
    signCount: 0,
  });
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge: login.json.challenge, origin: BASE })
  ).toString("base64url");
  const forged = await call("/api/auth/passkeys/login/verify", {
    method: "POST",
    body: {
      response: {
        id: "cred-x",
        rawId: "cred-x",
        type: "public-key",
        response: { clientDataJSON, authenticatorData: "AAAA", signature: "AAAA" },
        clientExtensionResults: {},
      },
    },
  });
  assert.equal(forged.status, 400);
  assert.equal(forged.cookies.length, 0);
  // The challenge was spent by that attempt.
  const replay = await call("/api/auth/passkeys/login/verify", {
    method: "POST",
    body: { response: { id: "cred-x", response: { clientDataJSON } } },
  });
  assert.equal(replay.json.error, "passkey_not_verified");
  assert.deepEqual((await call("/api/health")).json.auth_methods, { passkeys: true });
});

// ---- a software authenticator: just enough CBOR + COSE + ES256 to be a passkey ----
function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const s = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, s.length), s]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error("unsupported cbor value");
}

async function softAuthenticator() {
  const crypto = await import("node:crypto");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = crypto.randomBytes(16);
  const cose = cbor(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ])
  );
  const rpHash = (rpID) => crypto.createHash("sha256").update(rpID).digest();
  const counter = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  return {
    id: credId.toString("base64url"),
    register(options, origin) {
      const clientData = Buffer.from(
        JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false })
      );
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([
        rpHash(options.rp.id),
        Buffer.from([0x45]),
        counter(0),
        Buffer.alloc(16),
        len,
        credId,
        cose,
      ]);
      const attestationObject = cbor(
        new Map([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ])
      );
      return {
        id: credId.toString("base64url"),
        rawId: credId.toString("base64url"),
        type: "public-key",
        response: {
          clientDataJSON: clientData.toString("base64url"),
          attestationObject: attestationObject.toString("base64url"),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    assert(options, origin, signCount) {
      const clientData = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false })
      );
      const authData = Buffer.concat([rpHash(options.rpId), Buffer.from([0x05]), counter(signCount)]);
      const signature = crypto.sign(
        "sha256",
        Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]),
        privateKey
      );
      return {
        id: credId.toString("base64url"),
        rawId: credId.toString("base64url"),
        type: "public-key",
        response: {
          clientDataJSON: clientData.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: signature.toString("base64url"),
        },
        clientExtensionResults: {},
      };
    },
  };
}

test("a passkey end to end: register on a signed-in device, then sign a fresh browser in with it", async () => {
  const { secret } = await signInWithMaster();
  const cookie = { Cookie: `cairn_session=${secret}`, ...sameOrigin };
  const authenticator = await softAuthenticator();

  const regOptions = await call("/api/auth/passkeys/register/options", { method: "POST", headers: cookie, body: {} });
  const registered = await call("/api/auth/passkeys/register/verify", {
    method: "POST",
    headers: cookie,
    body: { response: authenticator.register(regOptions.json, BASE), name: "My phone" },
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  const stored = devicesRepo.listPasskeys();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].credential_id, authenticator.id);
  assert.equal(
    stored[0].device_id,
    db.prepare("SELECT id FROM auth_devices").get().id,
    "bound to the device that added it"
  );
  const status = await call("/api/auth/status", { headers: cookie });
  assert.equal(status.json.device.has_passkey, true);

  // A replayed registration (same challenge) is refused.
  const replay = await call("/api/auth/passkeys/register/verify", {
    method: "POST",
    headers: cookie,
    body: { response: authenticator.register(regOptions.json, BASE) },
  });
  assert.equal(replay.status, 400);

  // A fresh browser (no cookie) signs in with it.
  const loginOptions = await call("/api/auth/passkeys/login/options", { method: "POST", body: {} });
  const login = await call("/api/auth/passkeys/login/verify", {
    method: "POST",
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36" },
    body: { response: authenticator.assert(loginOptions.json, BASE, 1) },
  });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const fresh = sessionFrom(login.cookies);
  assert.notEqual(fresh, secret);
  assert.equal(login.json.device.name, "Chrome on Mac");
  assert.equal((await call("/api/thing", { headers: { Cookie: `cairn_session=${fresh}` } })).status, 200);
  assert.equal(
    (await call("/api/thing", { headers: { Cookie: `cairn_session=${secret}` } })).status,
    200,
    "the phone stays signed in"
  );
  assert.equal(devicesRepo.listPasskeys()[0].sign_count, 1);
  // The laptop used it: still bound to the phone, but signing the laptop out would remove it.
  assert.equal(devicesRepo.listPasskeys()[0].last_used_device_id, login.json.device.id);
  assert.equal(devicesRepo.listPasskeys()[0].registered_device_id, stored[0].device_id);
  assert.deepEqual(
    devicesRepo.passkeysRemovedByRevoking(login.json.device.id).map((p) => p.id),
    [stored[0].id]
  );

  // A cloned authenticator (counter went backwards) is refused, and a foreign origin too.
  const again = await call("/api/auth/passkeys/login/options", { method: "POST", body: {} });
  const cloned = await call("/api/auth/passkeys/login/verify", {
    method: "POST",
    body: { response: authenticator.assert(again.json, BASE, 1) },
  });
  assert.equal(cloned.status, 400);
  const third = await call("/api/auth/passkeys/login/options", { method: "POST", body: {} });
  const phished = await call("/api/auth/passkeys/login/verify", {
    method: "POST",
    body: { response: authenticator.assert(third.json, "https://evil.example", 2) },
  });
  assert.equal(phished.status, 400);

  // Removing the passkey closes that door.
  const removed = await call(`/api/auth/passkeys/${stored[0].id}`, { method: "DELETE", headers: cookie });
  assert.equal(removed.json.ok, true);
  const fourth = await call("/api/auth/passkeys/login/options", { method: "POST", body: {} });
  const gone = await call("/api/auth/passkeys/login/verify", {
    method: "POST",
    body: { response: authenticator.assert(fourth.json, BASE, 3) },
  });
  assert.equal(gone.status, 400);
});

test("FailureLimiter: five misses close one address (doubling on repeat); misses elsewhere never lock anyone", async () => {
  const { FailureLimiter, PAIRING_LIMITS } = await import("../dist/authHttp.js");
  assert.equal(PAIRING_LIMITS.perIpFailures, 5);
  const lim = new FailureLimiter({ windowMs: 900_000, perIpFailures: 5, maxLockMs: 4 * 3600_000 });
  const t = 5_000_000;
  for (let i = 0; i < 4; i++) lim.fail("1.1.1.1", t);
  assert.equal(lim.check("1.1.1.1", t).allowed, true, "four misses: still open");
  lim.fail("1.1.1.1", t);
  assert.equal(lim.check("1.1.1.1", t).allowed, false);
  assert.ok(Math.abs(lim.check("1.1.1.1", t).retryAfterMs - 900_000) < 5);
  assert.equal(lim.check("2.2.2.2", t).allowed, true, "another address is unaffected");
  assert.equal(lim.check("1.1.1.1", t + 900_001).allowed, true, "the lock passes");
  // A second lockout the same day lasts twice as long.
  for (let i = 0; i < 5; i++) lim.fail("1.1.1.1", t + 900_001);
  assert.ok(lim.check("1.1.1.1", t + 900_001).retryAfterMs > 1_700_000, "backoff doubles");
  // A spray from a thousand addresses closes each of them, never pairing for everyone.
  for (let i = 0; i < 1000; i++) for (let j = 0; j < 5; j++) lim.fail(`9.9.${i >> 8}.${i & 255}`, t + 1000);
  assert.equal(lim.check("3.3.3.3", t + 1000).allowed, true, "no global lock");
  assert.equal(lim.check("9.9.0.7", t + 1000).allowed, false);
});

test("the pairing door has no global lock: misses from other addresses never shut a good code out", async () => {
  // The first-sign-in code an attacker would most like to keep closed.
  const notice = devicesRepo.firstSignInNotice({ authEnabled: true, env: {} });
  const firstCode = /#pair=([A-Z2-9-]+)/.exec(notice)[1];
  for (let i = 0; i < 12; i++) {
    const miss = await call("/api/auth/pair", {
      method: "POST",
      headers: { "X-Forwarded-For": `203.0.113.${i}` },
      body: { code: "ZZZZ-ZZZZ" },
    });
    assert.equal(miss.status, 400);
  }
  const owner = await call("/api/auth/pair", {
    method: "POST",
    headers: { "X-Forwarded-For": "198.51.100.7" },
    body: { code: firstCode },
  });
  assert.equal(owner.status, 200, "twelve misses from elsewhere never close pairing for the owner");
  assert.ok(owner.cookies.some((c) => c.startsWith("cairn_session=")));
});

// LAST: this exhausts the route's own limiter for the socket peer's address.
test("the pairing door: wrong codes are rate limited per address, and a closed address is refused unchecked", async () => {
  const good = devicesRepo.createPairingCode();
  // An earlier test already spent one miss from this address; at most five land as 400.
  let last;
  let misses = 0;
  do {
    last = await call("/api/auth/pair", { method: "POST", body: { code: "ZZZZ-ZZZZ" } });
    if (last.status === 400) misses++;
  } while (last.status === 400 && misses < 10);
  assert.equal(last.status, 429);
  assert.ok(misses >= 4 && misses <= 5, `closed after five misses in all (this test saw ${misses})`);
  assert.equal(last.cookies.length, 0);
  last = await call("/api/auth/pair", { method: "POST", body: { code: good.code } });
  assert.equal(last.status, 429, "this address is closed, even for a good code");
  assert.ok(Number(last.cookies.length) === 0);
  assert.ok(devicesRepo.consumePairingCode(good.code), "a locked-out attempt never spent the code");
});

test("a case-changed path never walks past the guard (Express routes case-insensitively)", async () => {
  for (const path of ["/API/thing", "/Api/thing", "/api/THING", "/API/auth/pairing-codes"]) {
    const method = path.includes("pairing-codes") ? "POST" : "GET";
    const res = await call(path, { method, body: method === "POST" ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${path} must need a credential`);
  }
  const mcp = await call("/MCP", { method: "POST", body: {} });
  assert.equal(mcp.status, 401, "POST /MCP must need a credential");
  // An odd-cased exempt path is not exempt: it simply needs a credential too.
  const door = await call("/API/auth/pair", { method: "POST", body: { code: "ABCD-EFGH" } });
  assert.equal(door.status, 401);
  const ok = await call("/API/thing", { headers: master });
  assert.equal(ok.status, 200, "with the token, routing still reaches the handler");
});
