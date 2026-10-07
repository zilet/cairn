// Connect an AI app: per-app MCP keys (src/repo/mcp-clients.ts, /api/auth/mcp-clients) and
// OAuth 2.1 for /mcp (src/routes/oauth.ts) — discovery, dynamic registration, the consent
// page behind a device session, PKCE, single-use codes, rotating refresh tokens with reuse
// detection, revocation, and the guard rule that none of these credentials opens /api.
// Over real HTTP against the real guard, routers and MCP handler, with a master token set.
//
// The token must be in the environment BEFORE dist/auth.js loads, so every dist import is dynamic.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const MASTER = "test-master-token-0123456789abcdef";
process.env.CAIRN_AUTH_TOKEN = MASTER;
process.env.CAIRN_RATE_LIMIT = "0";

const express = (await import("express")).default;
const auth = await import("../dist/auth.js");
const { authRouter } = await import("../dist/routes/auth.js");
const { mcpClientsRouter } = await import("../dist/routes/mcp-clients.js");
const oauth = await import("../dist/routes/oauth.js");
const { handleMcpPost } = await import("../dist/mcp.js");
const repo = await import("../dist/repo/mcp-clients.js");
const { db } = await import("../dist/db.js");

assert.equal(auth.authEnabled, true);

const app = express();
app.use(auth.authGuard);
app.use(express.json());
app.use(oauth.oauthRouter);
app.use(oauth.oauthResume);
app.use("/api", authRouter);
app.use("/api", mcpClientsRouter);
app.get("/api/thing", (req, res) => res.json({ ok: true, principal: auth.authPrincipal(req) }));
app.post("/mcp", handleMcpPost);
app.get("/", (_req, res) => res.type("html").send("<!doctype html><title>shell</title>"));

const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;
const RESOURCE = `${BASE}/mcp`;
after(() => server.close());

const master = { Authorization: `Bearer ${MASTER}` };
const REDIRECT = "https://app.example.com/oauth/callback";

async function call(path, { method = "GET", headers = {}, body, form } = {}) {
  const init = { method, headers: { ...headers }, redirect: "manual" };
  if (form) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers, cookies: res.headers.getSetCookie() };
}

async function mcp(token, method, params = {}, path = "/mcp") {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  let json = null;
  try {
    json = JSON.parse(line ? line.slice(6) : text);
  } catch {}
  return { status: res.status, json, headers: res.headers };
}

const initParams = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };

async function session() {
  const res = await call("/api/auth/session", { method: "POST", headers: master, body: {} });
  assert.equal(res.status, 200);
  const line = res.cookies.find((c) => c.startsWith("cairn_session="));
  return line.split(";")[0];
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(body = {}) {
  return call("/oauth/register", {
    method: "POST",
    body: { client_name: "Test Connector", redirect_uris: [REDIRECT], ...body },
  });
}

function authorizeQuery({ clientId, challenge, redirectUri = REDIRECT, state = "st-1", extra = {} }) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource: RESOURCE,
    scope: "full",
    ...extra,
  }).toString();
}

/** GET /oauth/authorize as a signed-in browser → the consent page's rid + csrf. */
async function consentPage(cookie, query) {
  const res = await call(`/oauth/authorize?${query}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200, res.text);
  const rid = /name="rid" value="([^"]+)"/.exec(res.text)?.[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(res.text)?.[1];
  assert.ok(rid && csrf, "the consent form carries its request handle and CSRF token");
  return { res, rid, csrf };
}

async function allow(cookie, { rid, csrf }, decision = "allow") {
  return call("/oauth/authorize", {
    method: "POST",
    headers: { Cookie: cookie, Origin: BASE },
    form: { rid, csrf, decision },
  });
}

/** The whole dance → {clientId, tokens}. `cookie`: approve from this device (default: a new one). */
async function connect({ cookie: given, redirectUris, redirectUri = REDIRECT } = {}) {
  const reg = await register(redirectUris ? { redirect_uris: redirectUris } : {});
  assert.equal(reg.status, 201);
  const clientId = reg.json.client_id;
  const cookie = given || (await session());
  const { verifier, challenge } = pkce();
  const page = await consentPage(cookie, authorizeQuery({ clientId, challenge, redirectUri }));
  const answer = await allow(cookie, page);
  assert.equal(answer.status, 303);
  const back = new URL(answer.headers.get("location"));
  const code = back.searchParams.get("code");
  const tokenRes = await call("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    },
  });
  assert.equal(tokenRes.status, 200, tokenRes.text);
  return { clientId, code, verifier, back, tokens: tokenRes.json, cookie };
}

// ---------- discovery ----------

test("discovery: protected-resource metadata (both well-known forms) and RFC 8414 server metadata", async () => {
  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const prm = await call(path);
    assert.equal(prm.status, 200);
    assert.equal(prm.json.resource, RESOURCE);
    assert.deepEqual(prm.json.authorization_servers, [BASE]);
    assert.deepEqual(prm.json.bearer_methods_supported, ["header"]);
    assert.equal(prm.headers.get("access-control-allow-origin"), "*");
  }
  const as = await call("/.well-known/oauth-authorization-server");
  assert.equal(as.status, 200);
  assert.equal(as.json.issuer, BASE);
  assert.equal(as.json.authorization_endpoint, `${BASE}/oauth/authorize`);
  assert.equal(as.json.token_endpoint, `${BASE}/oauth/token`);
  assert.equal(as.json.registration_endpoint, `${BASE}/oauth/register`);
  assert.deepEqual(as.json.response_types_supported, ["code"]);
  assert.deepEqual(as.json.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(as.json.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.json.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(as.json.authorization_response_iss_parameter_supported, true);
  // A well-known URI is exact: an odd spelling is no document.
  assert.equal((await call("/.well-known/OAuth-Authorization-Server")).status, 404);
});

test("an unauthenticated /mcp (any case) answers 401 with the RFC 9728 challenge", async () => {
  for (const path of ["/mcp", "/MCP", "/Mcp"]) {
    const res = await mcp(null, "initialize", initParams, path);
    assert.equal(res.status, 401, path);
    const challenge = res.headers.get("www-authenticate");
    assert.match(challenge, /^Bearer /);
    assert.match(challenge, new RegExp(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`));
    assert.doesNotMatch(challenge, /invalid_token/);
  }
  const bad = await mcp("cairn_mat_" + "x".repeat(43), "initialize", initParams);
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate"), /error="invalid_token"/);
  // /api's 401 carries no MCP challenge.
  const api = await call("/api/thing");
  assert.equal(api.status, 401);
  assert.equal(api.headers.get("www-authenticate"), null);
});

// ---------- per-app keys ----------

test("a per-app key: shown once, opens /mcp only, listed without its secret, revocable", async () => {
  const made = await call("/api/auth/mcp-clients", { method: "POST", headers: master, body: { name: "Claude Code" } });
  assert.equal(made.status, 201);
  const token = made.json.token;
  assert.match(token, /^cairn_mcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(made.json.mcp_url, RESOURCE);
  assert.equal(made.json.oauth_available, true, "loopback http may run OAuth");
  const stored = db.prepare("SELECT token_hash FROM mcp_clients").get().token_hash;
  assert.notEqual(stored, token, "only the hash is stored");
  assert.equal(stored, crypto.createHash("sha256").update(token).digest("hex"));

  const init = await mcp(token, "initialize", initParams);
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, "cairn");
  const tools = await mcp(token, "tools/list");
  assert.equal(tools.status, 200);
  assert.ok(tools.json.result.tools.length > 10);

  // Never /api, in any header form.
  assert.equal((await call("/api/thing", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await call("/api/thing", { headers: { "X-Cairn-Token": token } })).status, 401);
  assert.equal((await call("/API/thing", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  // And never through the query string or X-Cairn-Token on /mcp.
  const viaHeader = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Cairn-Token": token,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: initParams }),
  });
  assert.equal(viaHeader.status, 401);

  const list = await call("/api/auth/mcp-clients", { headers: master });
  assert.equal(list.status, 200);
  assert.equal(list.json.clients.length, 1);
  assert.equal(list.json.clients[0].name, "Claude Code");
  assert.equal(list.json.clients[0].kind, "token");
  assert.ok(list.json.clients[0].last_used_at, "a use is stamped");
  assert.doesNotMatch(list.text, /cairn_mcp_/, "the list never carries a key");

  const cookie = await session();
  const gone = await call(`/api/auth/mcp-clients/${made.json.client.id}`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: BASE },
  });
  assert.equal(gone.status, 200);
  assert.equal((await mcp(token, "initialize", initParams)).status, 401);
  assert.equal((await call("/api/auth/mcp-clients", { headers: master })).json.clients.length, 0);
});

test("an AI app's key cannot manage connections, and signing devices out leaves master-token apps connected", async () => {
  const made = await call("/api/auth/mcp-clients", { method: "POST", headers: master, body: { name: "App" } });
  const token = made.json.token;
  assert.equal(
    (await call("/api/auth/mcp-clients", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: {} }))
      .status,
    401
  );
  const cookie = await session();
  await call("/api/auth/devices/revoke-others", {
    method: "POST",
    headers: { Cookie: cookie, Origin: BASE },
    body: {},
  });
  assert.equal((await mcp(token, "initialize", initParams)).status, 200);
});

// ---------- dynamic client registration ----------

test("registration accepts https and loopback redirect URIs only, and issues public clients", async () => {
  const ok = await register({
    redirect_uris: [REDIRECT, "http://localhost:33418/callback", "http://127.0.0.1/cb"],
    token_endpoint_auth_method: "client_secret_post",
  });
  assert.equal(ok.status, 201);
  assert.match(ok.json.client_id, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(ok.json.token_endpoint_auth_method, "none", "a public client, whatever it asked for");
  assert.equal(ok.json.client_secret, undefined);
  assert.equal(ok.json.client_name, "Test Connector");

  for (const uris of [
    undefined,
    [],
    ["http://evil.example.com/cb"],
    ["https://app.example.com/cb#frag"],
    ["https://user:pw@app.example.com/cb"],
    ["javascript:alert(1)"],
    ["cursor://callback"],
    ["not a url"],
    Array.from({ length: 6 }, (_, i) => `https://a.example.com/${i}`),
  ]) {
    const res = await call("/oauth/register", { method: "POST", body: { redirect_uris: uris } });
    assert.equal(res.status, 400, JSON.stringify(uris));
    assert.equal(res.json.error, "invalid_redirect_uri");
  }
  const badGrant = await register({ grant_types: ["client_credentials"] });
  assert.equal(badGrant.status, 400);
  assert.equal(badGrant.json.error, "invalid_client_metadata");
  const name = await register({ client_name: "x\u0000y".padEnd(200, "z") });
  assert.equal(name.status, 201);
  assert.ok(name.json.client_name.length <= 60);
  assert.ok(!name.json.client_name.includes(String.fromCharCode(0)));
});

test("the registry is capped: a full one forgets the oldest never-used registration", async () => {
  const old = Date.now() - 20 * 60 * 1000;
  for (let i = 0; i < repo.MAX_OAUTH_CLIENTS; i++)
    repo.registerOAuthClient({ name: `c${i}`, redirectUris: [REDIRECT], now: old + i });
  assert.equal(repo.oauthClientCount(), repo.MAX_OAUTH_CLIENTS);
  const res = await register();
  assert.equal(res.status, 201);
  assert.equal(repo.oauthClientCount(), repo.MAX_OAUTH_CLIENTS);
});

test("a registration flood never evicts an app mid-consent: fresh, pending or code-holding clients stay", async () => {
  // Fifty registrations made just now: none may be evicted, so the newcomer is refused.
  for (let i = 0; i < repo.MAX_OAUTH_CLIENTS; i++)
    repo.registerOAuthClient({ name: `c${i}`, redirectUris: [REDIRECT] });
  const refused = await register();
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error, "temporarily_unavailable");
  assert.ok(Number(refused.headers.get("retry-after")) > 0);
  assert.equal(repo.oauthClientCount(), repo.MAX_OAUTH_CLIENTS);

  // Twenty minutes on: the oldest has an authorization waiting, the next holds an unspent
  // code — both stay, and the third-oldest makes room.
  const ids = db
    .prepare("SELECT id FROM oauth_clients ORDER BY created_at ASC, rowid ASC")
    .all()
    .map((r) => r.id);
  ids.forEach((id, i) =>
    db
      .prepare("UPDATE oauth_clients SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 20 * 60 * 1000 + i).toISOString(), id)
  );
  oauth.pendingAuthorizations.create({
    origin: BASE,
    ip: "203.0.113.9",
    clientId: ids[0],
    clientName: "c0",
    redirectUri: REDIRECT,
    codeChallenge: pkce().challenge,
    state: null,
    resource: RESOURCE,
  });
  repo.createAuthCode({
    clientId: ids[1],
    redirectUri: REDIRECT,
    codeChallenge: pkce().challenge,
    resource: RESOURCE,
    deviceId: null,
  });
  const ok = await register();
  assert.equal(ok.status, 201);
  assert.ok(repo.getOAuthClient(ids[0]), "a client with a pending authorization stays");
  assert.ok(repo.getOAuthClient(ids[1]), "a client holding an unspent code stays");
  assert.equal(repo.getOAuthClient(ids[2]), null, "the oldest idle registration made room");
});

test("app names drop bidi and zero-width format characters; an empty result takes the fallback", async () => {
  assert.equal(repo.boundedLabel("‮evil​ name‍﻿", "AI app"), "evil name");
  assert.equal(repo.boundedLabel("​‮ ⁦", "AI app"), "AI app");
  assert.equal(repo.boundedLabel("a\u0000\tb   c", "x"), "a b c");
  const long = repo.boundedLabel("\u{1F600}".repeat(70), "x");
  assert.equal(Array.from(long).length, 60);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(long), "never half a surrogate pair");
  const reg = await register({ client_name: "Claude‮gpj.exe​" });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.client_name, "Claudegpj.exe");
  const blank = await register({ client_name: "​‌‮" });
  assert.equal(blank.json.client_name, "AI app");
});

// ---------- the authorization endpoint ----------

test("authorize needs a signed-in browser: a same-site bounce, then the sign-in screen, then back to consent", async () => {
  const reg = await register();
  const { challenge } = pkce();
  const query = authorizeQuery({ clientId: reg.json.client_id, challenge });
  // The cross-site hop carries no SameSite=Strict cookie: one meta-refresh step, never consent.
  const first = await call(`/oauth/authorize?${query}`);
  assert.equal(first.status, 200);
  assert.doesNotMatch(first.text, /name="csrf"/);
  const rid = /url=\/oauth\/authorize\?rid=([A-Za-z0-9_-]{43})/.exec(first.text)?.[1];
  assert.ok(rid, "the bounce page refreshes to the pending request");
  const hop = first.cookies.find((c) => c.startsWith("cairn_oauth_hop="));
  assert.match(hop, /HttpOnly/);
  assert.match(hop, /SameSite=Lax/);
  // Still signed out on the same-site step (proved by the bounce's own hop cookie): off to
  // the shell's sign-in, with a return cookie.
  const second = await call(`/oauth/authorize?rid=${rid}`, { headers: { Cookie: hop.split(";")[0] } });
  assert.equal(second.status, 303);
  assert.equal(second.headers.get("location"), "/");
  const returnCookie = second.cookies.find((c) => c.startsWith("cairn_oauth_return="));
  assert.match(returnCookie, /HttpOnly/);
  const returnPair = returnCookie.split(";")[0];
  // Signed out, the shell just loads (and shows its sign-in screen).
  const shell = await call("/", { headers: { Cookie: returnPair } });
  assert.equal(shell.status, 200);
  // Signed in now: the shell sends the browser straight back to consent.
  const cookie = await session();
  const back = await call("/", { headers: { Cookie: `${returnPair}; ${cookie}` } });
  assert.equal(back.status, 303);
  assert.equal(back.headers.get("location"), `/oauth/authorize?rid=${rid}`);
  assert.ok(back.cookies.some((c) => c.startsWith("cairn_oauth_return=;") && /Max-Age=0/.test(c)));
  const consent = await call(`/oauth/authorize?rid=${rid}`, { headers: { Cookie: cookie } });
  assert.equal(consent.status, 200);
  assert.match(consent.text, /Connect Test Connector\?/);
  assert.match(consent.text, /app\.example\.com/, "the redirect host is shown");
  assert.match(consent.text, /name="csrf"/);
  assert.equal(consent.headers.get("cache-control"), "no-store");
});

test("auth status hands a signed-in shell its pending consent page (the SW-cached reload never reaches oauthResume)", async () => {
  const reg = await register();
  const first = await call(
    `/oauth/authorize?${authorizeQuery({ clientId: reg.json.client_id, challenge: pkce().challenge })}`
  );
  const rid = /rid=([A-Za-z0-9_-]{43})/.exec(first.text)?.[1];
  const hopPair = first.cookies.find((c) => c.startsWith("cairn_oauth_hop=")).split(";")[0];
  const second = await call(`/oauth/authorize?rid=${rid}`, { headers: { Cookie: hopPair } });
  const returnPair = second.cookies.find((c) => c.startsWith("cairn_oauth_return=")).split(";")[0];
  const cookie = await session();
  // The master token is no browser: nothing to resume, cookie untouched.
  const asMaster = await call("/api/auth/status", { headers: { ...master, Cookie: returnPair } });
  assert.equal(asMaster.json.oauth_resume, null);
  // Without the return cookie there is nothing to resume.
  assert.equal((await call("/api/auth/status", { headers: { Cookie: cookie } })).json.oauth_resume, null);
  // Signed in with it: a same-origin relative path, and the cookie is spent.
  const status = await call("/api/auth/status", { headers: { Cookie: `${returnPair}; ${cookie}` } });
  assert.equal(status.json.oauth_resume, `/oauth/authorize?rid=${rid}`);
  assert.ok(status.cookies.some((c) => c.startsWith("cairn_oauth_return=;") && /Max-Age=0/.test(c)));
  // An answered (taken) request resumes nothing.
  oauth.pendingAuthorizations.take(rid);
  const stale = await call("/api/auth/status", { headers: { Cookie: `${returnPair}; ${cookie}` } });
  assert.equal(stale.json.oauth_resume, null);
});

test("a ?rid= link planted cross-site never sets the return cookie; only this browser's same-site leg does", async () => {
  const reg = await register();
  const query = authorizeQuery({ clientId: reg.json.client_id, challenge: pkce().challenge });
  // The "attacker" starts a request and takes its rid off the bounce page.
  const first = await call(`/oauth/authorize?${query}`);
  const rid = /rid=([A-Za-z0-9_-]{43})/.exec(first.text)?.[1];
  const hopPair = first.cookies.find((c) => c.startsWith("cairn_oauth_hop=")).split(";")[0];
  const noReturn = (res) => assert.ok(!res.cookies.some((c) => c.startsWith("cairn_oauth_return=")));
  // The victim's browser follows the bare link: no fetch metadata, or a cross-site one.
  for (const headers of [{}, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "none" }]) {
    const res = await call(`/oauth/authorize?rid=${rid}`, { headers });
    assert.equal(res.status, 400, JSON.stringify(headers));
    assert.equal(res.headers.get("location"), null);
    noReturn(res);
  }
  // A wrong hop nonce proves nothing either.
  const forged = await call(`/oauth/authorize?rid=${rid}`, {
    headers: { Cookie: `cairn_oauth_hop=${"A".repeat(43)}` },
  });
  assert.equal(forged.status, 400);
  noReturn(forged);
  // The browser that got the bounce page: its hop nonce works, once.
  const own = await call(`/oauth/authorize?rid=${rid}`, { headers: { Cookie: hopPair } });
  assert.equal(own.status, 303);
  assert.ok(own.cookies.some((c) => c.startsWith(`cairn_oauth_return=${rid}`)));
  assert.ok(own.cookies.some((c) => c.startsWith("cairn_oauth_hop=;") && /Max-Age=0/.test(c)));
  noReturn(await call(`/oauth/authorize?rid=${rid}`, { headers: { Cookie: hopPair } }));
  // A same-origin navigation (the meta refresh in a browser that sends fetch metadata) also does.
  const sameOrigin = await call(`/oauth/authorize?rid=${rid}`, { headers: { "Sec-Fetch-Site": "same-origin" } });
  assert.equal(sameOrigin.status, 303);
  assert.ok(sameOrigin.cookies.some((c) => c.startsWith(`cairn_oauth_return=${rid}`)));
});

test("a malformed CSRF token (multibyte, wrong shape) is a 403, never a 500", async () => {
  const reg = await register();
  const cookie = await session();
  const page = await consentPage(cookie, authorizeQuery({ clientId: reg.json.client_id, challenge: pkce().challenge }));
  for (const csrf of ["é".repeat(43), "\u{1F600}".repeat(43), "x".repeat(42), `${"x".repeat(42)}=`, ""]) {
    const res = await allow(cookie, { rid: page.rid, csrf });
    assert.equal(res.status, 403, JSON.stringify(csrf));
  }
  // The request survives the bad answers; the real token still works.
  assert.equal((await allow(cookie, page)).status, 303);
});

test("pending authorizations: at most five per address (its own oldest goes), and a repeat reuses its entry", () => {
  const store = new oauth.PendingAuthorizations();
  const base = {
    origin: BASE,
    clientId: "C".repeat(32),
    clientName: "App",
    redirectUri: REDIRECT,
    state: "s",
    resource: RESOURCE,
  };
  const other = store.create({ ...base, ip: "198.51.100.1", codeChallenge: pkce().challenge });
  const rids = [];
  for (let i = 0; i < 6; i++) rids.push(store.create({ ...base, ip: "203.0.113.5", codeChallenge: pkce().challenge }));
  assert.equal(store.get(rids[0]), null, "the address's oldest request was evicted");
  for (const rid of rids.slice(1)) assert.ok(store.get(rid));
  assert.ok(store.get(other), "another address's request is untouched");
  assert.equal(store.size(), 6);
  // The same request again (same client, challenge, state, redirect URI, address): one entry, fresh handle.
  const challenge = pkce().challenge;
  const a = store.create({ ...base, ip: "192.0.2.7", codeChallenge: challenge });
  const b = store.create({ ...base, ip: "192.0.2.7", codeChallenge: challenge });
  assert.notEqual(a, b);
  assert.equal(store.get(a), null);
  assert.ok(store.get(b));
  assert.equal(store.size(), 7);
  assert.ok(store.clientIds().has(base.clientId));
});

test("authorize never redirects for an unknown client or a mismatched redirect URI", async () => {
  const reg = await register();
  const cookie = await session();
  const { challenge } = pkce();
  const unknown = await call(`/oauth/authorize?${authorizeQuery({ clientId: "A".repeat(32), challenge })}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.get("location"), null);
  for (const redirectUri of ["https://evil.example.com/oauth/callback", `${REDIRECT}/x`, `${REDIRECT}?a=1`]) {
    const res = await call(
      `/oauth/authorize?${authorizeQuery({ clientId: reg.json.client_id, challenge, redirectUri })}`,
      {
        headers: { Cookie: cookie },
      }
    );
    assert.equal(res.status, 400, redirectUri);
    assert.equal(res.headers.get("location"), null);
  }
});

test("a loopback redirect may change its port, never its host or path", async () => {
  const reg = await register({ redirect_uris: ["http://127.0.0.1:5000/callback"] });
  const cookie = await session();
  const { challenge } = pkce();
  const ok = await call(
    `/oauth/authorize?${authorizeQuery({ clientId: reg.json.client_id, challenge, redirectUri: "http://127.0.0.1:61234/callback" })}`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(ok.status, 200);
  assert.match(ok.text, /an app on this computer/);
  assert.match(ok.text, /Only allow this if you started connecting an app on this computer/);
  for (const redirectUri of ["http://localhost:5000/callback", "http://127.0.0.1:5000/other"]) {
    const res = await call(
      `/oauth/authorize?${authorizeQuery({ clientId: reg.json.client_id, challenge, redirectUri })}`,
      {
        headers: { Cookie: cookie },
      }
    );
    assert.equal(res.status, 400, redirectUri);
  }
});

test("authorize requires PKCE S256 and this server's resource, answering on the redirect with state and iss", async () => {
  const reg = await register();
  const cookie = await session();
  const { challenge } = pkce();
  const cases = [
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge: "" }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ resource: "https://other.example.com/mcp" }, "invalid_target"],
  ];
  for (const [extra, error] of cases) {
    const res = await call(`/oauth/authorize?${authorizeQuery({ clientId: reg.json.client_id, challenge, extra })}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 303, JSON.stringify(extra));
    const loc = new URL(res.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, REDIRECT);
    assert.equal(loc.searchParams.get("error"), error);
    assert.equal(loc.searchParams.get("state"), "st-1");
    assert.equal(loc.searchParams.get("iss"), BASE);
  }
});

test("the consent answer is same-origin, CSRF-checked, bound to its device and single use", async () => {
  const reg = await register();
  const cookie = await session();
  const other = await session();
  const { challenge } = pkce();
  const page = await consentPage(cookie, authorizeQuery({ clientId: reg.json.client_id, challenge }));
  // Wrong CSRF token, foreign origin, no origin at all, another device's session.
  assert.equal((await allow(cookie, { rid: page.rid, csrf: "x".repeat(43) })).status, 403);
  const foreign = await call("/oauth/authorize", {
    method: "POST",
    headers: { Cookie: cookie, Origin: "https://evil.example.com" },
    form: { rid: page.rid, csrf: page.csrf, decision: "allow" },
  });
  assert.equal(foreign.status, 403);
  const noOrigin = await call("/oauth/authorize", {
    method: "POST",
    headers: { Cookie: cookie },
    form: { ...page, decision: "allow" },
  });
  assert.equal(noOrigin.status, 403);
  assert.equal((await allow(other, page)).status, 403);
  assert.equal((await allow("", page)).status, 403, "signed out");
  // Cancel → access_denied, and the request is spent.
  const denied = await allow(cookie, page, "deny");
  assert.equal(denied.status, 303);
  const loc = new URL(denied.headers.get("location"));
  assert.equal(loc.searchParams.get("error"), "access_denied");
  assert.equal(loc.searchParams.get("state"), "st-1");
  assert.equal(loc.searchParams.get("code"), null);
  assert.equal((await allow(cookie, page)).status, 403, "an answered request cannot be answered again");
});

// ---------- tokens ----------

test("the full dance: a code, PKCE, tokens bound to /mcp, initialize + tools/list, never /api", async () => {
  const { back, tokens, clientId } = await connect();
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("state"), "st-1");
  assert.equal(back.searchParams.get("iss"), BASE);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 3600);
  assert.match(tokens.access_token, /^cairn_mat_/);
  assert.match(tokens.refresh_token, /^cairn_mrt_/);
  assert.equal(tokens.scope, "full");
  const stored = db
    .prepare("SELECT token_hash FROM oauth_tokens")
    .all()
    .map((r) => r.token_hash);
  assert.ok(!stored.includes(tokens.access_token) && !stored.includes(tokens.refresh_token), "hashed at rest");

  const init = await mcp(tokens.access_token, "initialize", initParams);
  assert.equal(init.status, 200);
  const tools = await mcp(tokens.access_token, "tools/list");
  assert.equal(tools.status, 200);
  assert.ok(tools.json.result.tools.some((t) => t.name === "get_plan"));
  assert.equal((await mcp(tokens.access_token, "initialize", initParams, "/MCP")).status, 200);

  for (const token of [tokens.access_token, tokens.refresh_token]) {
    assert.equal((await call("/api/thing", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await call("/api/auth/mcp-clients", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  }
  assert.equal(
    (await mcp(tokens.refresh_token, "initialize", initParams)).status,
    401,
    "a refresh token is no access token"
  );

  const list = await call("/api/auth/mcp-clients", { headers: master });
  const grant = list.json.clients.find((c) => c.kind === "oauth");
  assert.equal(grant.name, "Test Connector");
  assert.equal(grant.redirect_host, "app.example.com");
  assert.equal(db.prepare("SELECT client_id FROM mcp_clients WHERE id = ?").get(grant.id).client_id, clientId);
});

test("a wrong PKCE verifier burns the code", async () => {
  const reg = await register();
  const cookie = await session();
  const { verifier, challenge } = pkce();
  const page = await consentPage(cookie, authorizeQuery({ clientId: reg.json.client_id, challenge }));
  const code = new URL((await allow(cookie, page)).headers.get("location")).searchParams.get("code");
  const form = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.json.client_id };
  const wrong = await call("/oauth/token", { method: "POST", form: { ...form, code_verifier: pkce().verifier } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error, "invalid_grant");
  const missing = await call("/oauth/token", { method: "POST", form });
  assert.equal(missing.json.error, "invalid_grant");
  const right = await call("/oauth/token", { method: "POST", form: { ...form, code_verifier: verifier } });
  assert.equal(right.status, 400, "the code was spent by the failed attempt");
  assert.equal(right.json.error, "invalid_grant");
});

test("a replayed code is refused and revokes what the first exchange minted", async () => {
  const { clientId, code, verifier, tokens } = await connect();
  const replay = await call("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    },
  });
  assert.equal(replay.status, 400);
  assert.equal(replay.json.error, "invalid_grant");
  assert.equal((await mcp(tokens.access_token, "initialize", initParams)).status, 401);
  const refresh = await call("/oauth/token", {
    method: "POST",
    form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId },
  });
  assert.equal(refresh.json.error, "invalid_grant");
});

test("the token request must repeat the redirect URI, the client and the resource", async () => {
  const reg = await register({ redirect_uris: [REDIRECT, "https://app.example.com/other"] });
  const cookie = await session();
  const mint = async () => {
    const { verifier, challenge } = pkce();
    const page = await consentPage(cookie, authorizeQuery({ clientId: reg.json.client_id, challenge }));
    const code = new URL((await allow(cookie, page)).headers.get("location")).searchParams.get("code");
    return { code, verifier };
  };
  let m = await mint();
  const mismatch = await call("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code: m.code,
      redirect_uri: "https://app.example.com/other",
      client_id: reg.json.client_id,
      code_verifier: m.verifier,
    },
  });
  assert.equal(mismatch.json.error, "invalid_grant");
  m = await mint();
  const omitted = await call("/oauth/token", {
    method: "POST",
    form: { grant_type: "authorization_code", code: m.code, client_id: reg.json.client_id, code_verifier: m.verifier },
  });
  assert.equal(omitted.json.error, "invalid_grant", "two registered URIs: the token request must name one");
  m = await mint();
  const otherClient = await register();
  const wrongClient = await call("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code: m.code,
      redirect_uri: REDIRECT,
      client_id: otherClient.json.client_id,
      code_verifier: m.verifier,
    },
  });
  assert.equal(wrongClient.json.error, "invalid_grant");
  m = await mint();
  const wrongResource = await call("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code: m.code,
      redirect_uri: REDIRECT,
      client_id: reg.json.client_id,
      code_verifier: m.verifier,
      resource: "https://other.example.com/mcp",
    },
  });
  assert.equal(wrongResource.json.error, "invalid_target");
  const unknownClient = await call("/oauth/token", {
    method: "POST",
    form: { grant_type: "authorization_code", client_id: "B".repeat(32) },
  });
  assert.equal(unknownClient.status, 401);
  assert.equal(unknownClient.json.error, "invalid_client");
  const badGrant = await call("/oauth/token", {
    method: "POST",
    form: { grant_type: "password", client_id: reg.json.client_id },
  });
  assert.equal(badGrant.json.error, "unsupported_grant_type");
  assert.equal(badGrant.headers.get("cache-control"), "no-store");
});

test("refresh tokens rotate; presenting a rotated one revokes the whole family", async () => {
  const { clientId, tokens } = await connect();
  const first = await call("/oauth/token", {
    method: "POST",
    form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId, resource: RESOURCE },
  });
  assert.equal(first.status, 200, first.text);
  assert.notEqual(first.json.refresh_token, tokens.refresh_token);
  assert.notEqual(first.json.access_token, tokens.access_token);
  assert.equal(
    (await mcp(tokens.access_token, "initialize", initParams)).status,
    401,
    "the old access token went with it"
  );
  assert.equal((await mcp(first.json.access_token, "initialize", initParams)).status, 200);
  // Reuse of the rotated token past the reuse grace: refused, and the live family dies with it.
  const reuse = repo.rotateRefreshToken({
    refreshToken: tokens.refresh_token,
    clientId,
    resource: null,
    now: Date.now() + repo.REFRESH_REUSE_GRACE_MS + 1000,
  });
  assert.deepEqual(reuse, { ok: false, error: "invalid_grant", reused: true });
  assert.equal((await mcp(first.json.access_token, "initialize", initParams)).status, 401);
  const next = await call("/oauth/token", {
    method: "POST",
    form: { grant_type: "refresh_token", refresh_token: first.json.refresh_token, client_id: clientId },
  });
  assert.equal(next.json.error, "invalid_grant");
  assert.equal((await call("/api/auth/mcp-clients", { headers: master })).json.clients.length, 0);
});

function refreshForm(refreshToken, clientId) {
  return { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: RESOURCE };
}

test("refresh reuse grace: a retry inside 60 s is refused and costs nothing — the successor pair stays live", async () => {
  const { clientId, tokens } = await connect();
  const a = await call("/oauth/token", { method: "POST", form: refreshForm(tokens.refresh_token, clientId) });
  assert.equal(a.status, 200);
  const b = await call("/oauth/token", { method: "POST", form: refreshForm(tokens.refresh_token, clientId) });
  assert.equal(b.status, 400);
  assert.equal(b.json.error, "invalid_grant");
  assert.equal((await mcp(a.json.access_token, "initialize", initParams)).status, 200, "the successor still works");
  // Even once that successor is in use, a reuse inside the window is a race, not theft.
  const c = await call("/oauth/token", { method: "POST", form: refreshForm(tokens.refresh_token, clientId) });
  assert.equal(c.json.error, "invalid_grant");
  assert.equal((await mcp(a.json.access_token, "initialize", initParams)).status, 200);
  const next = await call("/oauth/token", { method: "POST", form: refreshForm(a.json.refresh_token, clientId) });
  assert.equal(next.status, 200, next.text);
  assert.equal((await call("/api/auth/mcp-clients", { headers: master })).json.clients.length, 1);
});

test("refresh reuse grace: a concurrent double refresh leaves exactly one working pair and the grant", async () => {
  const { clientId, tokens } = await connect();
  const results = await Promise.all([
    call("/oauth/token", { method: "POST", form: refreshForm(tokens.refresh_token, clientId) }),
    call("/oauth/token", { method: "POST", form: refreshForm(tokens.refresh_token, clientId) }),
  ]);
  const won = results.filter((r) => r.status === 200);
  const lost = results.filter((r) => r.status !== 200);
  assert.equal(won.length, 1, results.map((r) => r.text).join(" | "));
  assert.equal(lost[0].json.error, "invalid_grant");
  const live = won[0].json;
  assert.equal(
    (await mcp(live.access_token, "initialize", initParams)).status,
    200,
    "the race never cost the live pair"
  );
  const next = await call("/oauth/token", { method: "POST", form: refreshForm(live.refresh_token, clientId) });
  assert.equal(next.status, 200);
  assert.equal((await mcp(next.json.access_token, "initialize", initParams)).status, 200);
});

test("refresh reuse grace ends at 60 s: a later reuse is theft and the whole grant goes", async () => {
  // Late: 61 s after the rotation.
  {
    const { clientId, tokens } = await connect();
    const t0 = Date.now();
    const first = repo.rotateRefreshToken({
      refreshToken: tokens.refresh_token,
      clientId,
      resource: RESOURCE,
      now: t0,
    });
    assert.equal(first.ok, true);
    const inside = repo.rotateRefreshToken({
      refreshToken: tokens.refresh_token,
      clientId,
      resource: RESOURCE,
      now: t0 + 59_000,
    });
    assert.deepEqual(
      inside,
      { ok: false, error: "invalid_grant" },
      "59 s on is still a race: refused, nothing revoked"
    );
    assert.equal((await mcp(first.tokens.access_token, "initialize", initParams)).status, 200);
    const late = repo.rotateRefreshToken({
      refreshToken: tokens.refresh_token,
      clientId,
      resource: RESOURCE,
      now: t0 + 61_000,
    });
    assert.deepEqual(late, { ok: false, error: "invalid_grant", reused: true });
    assert.equal((await mcp(first.tokens.access_token, "initialize", initParams)).status, 401);
    assert.equal((await call("/api/auth/mcp-clients", { headers: master })).json.clients.length, 0);
  }
  // Another client presenting it inside the window gets nothing and costs nothing.
  {
    const { clientId, tokens } = await connect();
    const a = await call("/oauth/token", { method: "POST", form: refreshForm(tokens.refresh_token, clientId) });
    const other = await register();
    const wrong = await call("/oauth/token", {
      method: "POST",
      form: refreshForm(tokens.refresh_token, other.json.client_id),
    });
    assert.equal(wrong.json.error, "invalid_grant");
    assert.equal((await mcp(a.json.access_token, "initialize", initParams)).status, 200);
  }
});

test("Settings lists the redirect host a grant was approved for, and the approving device and date", async () => {
  const second = "https://second.example.net/cb";
  const cookie = await session();
  await connect({ cookie, redirectUris: [REDIRECT, second], redirectUri: second });
  const listed = (await call("/api/auth/mcp-clients", { headers: master })).json.clients;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].redirect_host, "second.example.net", "the URI actually used, not the first registered");
  const devices = (await call("/api/auth/devices", { headers: { Cookie: cookie } })).json.devices;
  assert.equal(listed[0].device_name, devices[0].name);
  assert.ok(Date.parse(listed[0].created_at));
  // A key made from a device names it; one made with the master token names none.
  const made = await call("/api/auth/mcp-clients", {
    method: "POST",
    headers: { Cookie: cookie, Origin: BASE },
    body: { name: "From the phone" },
  });
  assert.equal(made.status, 201);
  assert.equal(made.json.client.device_name, devices[0].name);
  await call("/api/auth/mcp-clients", { method: "POST", headers: master, body: { name: "Master" } });
  const rows = (await call("/api/auth/mcp-clients", { headers: master })).json.clients;
  assert.equal(rows.find((c) => c.name === "Master").device_name, null);
  assert.equal(rows.find((c) => c.name === "From the phone").redirect_host, null);
  // An older grant with no recorded URI shows its registration's host only when it named one.
  db.prepare("UPDATE mcp_clients SET redirect_uri = NULL WHERE kind = 'oauth'").run();
  const legacy = (await call("/api/auth/mcp-clients", { headers: master })).json.clients.find(
    (c) => c.kind === "oauth"
  );
  assert.equal(legacy.redirect_host, null, "two registered URIs: no guess");
});

test("revoking a device from another one disconnects the apps it connected; signing itself out does not", async () => {
  const lost = await session();
  const here = await session();
  const key = async (cookie, name) =>
    (await call("/api/auth/mcp-clients", { method: "POST", headers: { Cookie: cookie, Origin: BASE }, body: { name } }))
      .json.token;
  const lostKey = await key(lost, "Lost key");
  const lostGrant = await connect({ cookie: lost });
  const hereKey = await key(here, "Here key");
  const masterKey = (await call("/api/auth/mcp-clients", { method: "POST", headers: master, body: { name: "M" } })).json
    .token;

  // The confirm data names the apps before anything is removed.
  const view = (await call("/api/auth/devices", { headers: { Cookie: here } })).json;
  assert.equal(view.devices.length, 2);
  const lostRow = view.devices.find((d) => !d.current);
  assert.deepEqual(lostRow.revoke_disconnects_apps.map((a) => a.name).sort(), ["Lost key", "Test Connector"]);
  assert.deepEqual(view.devices.find((d) => d.current).revoke_disconnects_apps, []);
  assert.deepEqual(view.revoke_others_disconnects_apps.map((a) => a.name).sort(), ["Lost key", "Test Connector"]);

  const gone = await call(`/api/auth/devices/${lostRow.id}`, {
    method: "DELETE",
    headers: { Cookie: here, Origin: BASE },
  });
  assert.equal(gone.status, 200);
  assert.equal((await mcp(lostKey, "initialize", initParams)).status, 401);
  assert.equal((await mcp(lostGrant.tokens.access_token, "initialize", initParams)).status, 401);
  const refresh = await call("/oauth/token", {
    method: "POST",
    form: refreshForm(lostGrant.tokens.refresh_token, lostGrant.clientId),
  });
  assert.equal(refresh.json.error, "invalid_grant");
  assert.equal((await mcp(hereKey, "initialize", initParams)).status, 200);
  assert.equal((await mcp(masterKey, "initialize", initParams)).status, 200);

  // Signing THIS device out (by id, or logout) keeps its apps.
  const hereId = view.devices.find((d) => d.current).id;
  const self = await call(`/api/auth/devices/${hereId}`, { method: "DELETE", headers: { Cookie: here, Origin: BASE } });
  assert.equal(self.json.signed_out, true);
  assert.equal((await mcp(hereKey, "initialize", initParams)).status, 200);
  const third = await session();
  const thirdKey = await key(third, "Third key");
  await call("/api/auth/logout", { method: "POST", headers: { Cookie: third, Origin: BASE }, body: {} });
  assert.equal((await mcp(thirdKey, "initialize", initParams)).status, 200);
});

test("signing out other devices disconnects the apps they connected, never this device's or the master token's", async () => {
  const other = await session();
  const here = await session();
  const key = async (cookie, name) =>
    (await call("/api/auth/mcp-clients", { method: "POST", headers: { Cookie: cookie, Origin: BASE }, body: { name } }))
      .json.token;
  const otherKey = await key(other, "Other");
  const otherGrant = await connect({ cookie: other });
  const hereKey = await key(here, "Here");
  const hereGrant = await connect({ cookie: here });
  const masterKey = (await call("/api/auth/mcp-clients", { method: "POST", headers: master, body: { name: "M" } })).json
    .token;
  const res = await call("/api/auth/devices/revoke-others", {
    method: "POST",
    headers: { Cookie: here, Origin: BASE },
    body: {},
  });
  assert.equal(res.status, 200);
  assert.equal((await mcp(otherKey, "initialize", initParams)).status, 401);
  assert.equal((await mcp(otherGrant.tokens.access_token, "initialize", initParams)).status, 401);
  assert.equal((await mcp(hereKey, "initialize", initParams)).status, 200);
  assert.equal((await mcp(hereGrant.tokens.access_token, "initialize", initParams)).status, 200);
  assert.equal((await mcp(masterKey, "initialize", initParams)).status, 200);
});

test("a refresh token belongs to its client", async () => {
  const { tokens } = await connect();
  const other = await register();
  const res = await call("/oauth/token", {
    method: "POST",
    form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: other.json.client_id },
  });
  assert.equal(res.json.error, "invalid_grant");
});

test("Disconnect revokes an OAuth grant's access and refresh tokens; expired access tokens fail too", async () => {
  const { clientId, tokens } = await connect();
  const grant = (await call("/api/auth/mcp-clients", { headers: master })).json.clients[0];
  db.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'access'").run(
    new Date(Date.now() - 1000).toISOString()
  );
  assert.equal((await mcp(tokens.access_token, "initialize", initParams)).status, 401, "expired");
  db.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'access'").run(
    new Date(Date.now() + 60_000).toISOString()
  );
  assert.equal((await mcp(tokens.access_token, "initialize", initParams)).status, 200);
  assert.equal((await call(`/api/auth/mcp-clients/${grant.id}`, { method: "DELETE", headers: master })).status, 200);
  assert.equal((await mcp(tokens.access_token, "initialize", initParams)).status, 401);
  const refresh = await call("/oauth/token", {
    method: "POST",
    form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId },
  });
  assert.equal(refresh.json.error, "invalid_grant");
});

test("allowing the same app again replaces its grant rather than listing it twice", async () => {
  const { clientId, tokens, cookie } = await connect();
  const { verifier, challenge } = pkce();
  const page = await consentPage(cookie, authorizeQuery({ clientId, challenge }));
  const code = new URL((await allow(cookie, page)).headers.get("location")).searchParams.get("code");
  const again = await call("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    },
  });
  assert.equal(again.status, 200);
  assert.equal((await mcp(tokens.access_token, "initialize", initParams)).status, 401);
  assert.equal((await mcp(again.json.access_token, "initialize", initParams)).status, 200);
  assert.equal((await call("/api/auth/mcp-clients", { headers: master })).json.clients.length, 1);
});

test("revokeAllMcpAccess ends every key and grant at once", async () => {
  const { tokens } = await connect();
  const key = (await call("/api/auth/mcp-clients", { method: "POST", headers: master, body: { name: "k" } })).json
    .token;
  assert.equal(repo.revokeAllMcpAccess(), 2);
  assert.equal((await mcp(tokens.access_token, "initialize", initParams)).status, 401);
  assert.equal((await mcp(key, "initialize", initParams)).status, 401);
});

test("case variants of the OAuth paths reach the same checks, never a bypass", async () => {
  const reg = await register();
  const res = await call("/OAuth/Token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code: "x".repeat(43),
      client_id: reg.json.client_id,
      code_verifier: pkce().verifier,
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, "invalid_grant");
  const authz = await call(
    `/OAUTH/authorize?${authorizeQuery({ clientId: "C".repeat(32), challenge: pkce().challenge })}`
  );
  assert.equal(authz.status, 400);
  assert.equal(authz.headers.get("location"), null);
});

test("pure helpers: redirect URI rules and PKCE", () => {
  assert.equal(oauth.validRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(oauth.validRedirectUri("http://[::1]:8080/cb"), true);
  assert.equal(oauth.validRedirectUri("http://localhost.evil.com/cb"), false);
  assert.equal(oauth.matchRedirectUri(undefined, [REDIRECT]), REDIRECT);
  assert.equal(oauth.matchRedirectUri(undefined, [REDIRECT, `${REDIRECT}2`]), null);
  const { verifier, challenge } = pkce();
  assert.equal(oauth.pkceS256Matches(verifier, challenge), true);
  assert.equal(oauth.pkceS256Matches(verifier + "x", challenge), false);
  assert.equal(oauth.pkceS256Matches("short", challenge), false);
});
