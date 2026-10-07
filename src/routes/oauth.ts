// OAuth 2.1 for /mcp — how the Claude app, ChatGPT and other "custom connector" clients
// sign in to a hosted Cairn with nothing but its address (MCP Authorization, spec
// 2026-07-28; RFC 9728 protected-resource metadata, RFC 8414 server metadata, RFC 7591
// dynamic registration, RFC 8707 resource indicators, RFC 9207 `iss`, PKCE S256 only).
//
// Cairn is both the resource server (/mcp) and its own authorization server; the owner
// proves who they are with the browser session they already have (passkey, pairing code
// or the access token on the ordinary sign-in screen) and then allows the app on a
// server-rendered consent page. Mounted at the app root (not under /api), so the /api
// guard never sees these paths: each is public by design and guarded by its own checks,
// behind the per-IP limiter. Everything is inert (404) unless CAIRN_AUTH_TOKEN is set —
// an open instance needs no sign-in — and refuses to run over plain http off loopback.
//
// Storage and token rules: src/repo/mcp-clients.ts. Nothing here logs a code, a token,
// a state or a verifier.
import crypto from "node:crypto";
import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { authEnabled, checkRateLimit, rateLimitEnabled, trustProxyHops } from "../auth.js";
import { FailureLimiter, isSameOriginRequest, readSessionCookie, sessionCookie } from "../authHttp.js";
import { type AuthDevice, deviceForSessionSecret } from "../repo/auth-devices.js";
import {
  MCP_SCOPE,
  MAX_REDIRECT_URIS,
  OAUTH_CLIENT_FRESH_MS,
  type OAuthClient,
  consumeAuthCode,
  createAuthCode,
  getOAuthClient,
  grantFromCode,
  registerOAuthClient,
  resourcesEqual,
  revokeMcpClient,
  rotateRefreshToken,
} from "../repo/mcp-clients.js";
import {
  canonicalOrigin,
  httpsBehindUntrustedProxy,
  isLoopbackHost,
  mcpResourceUrl,
  oauthOriginAllowed,
} from "../mcpAccess.js";

export const oauthRouter = Router();

const urlencoded = express.urlencoded({ extended: false, limit: "16kb" });

// ---------- pure helpers (exported for tests) ----------

/** A redirect URI a client may register: https anywhere, or http on a loopback host. No fragment, no userinfo. */
export function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || !url.hostname) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

/**
 * The registered redirect URI a request names, or null. Exact string match — except a
 * loopback http URI, whose PORT may differ (a desktop app picks a free port per sign-in;
 * OAuth 2.1 §8.4.2 / RFC 8252 §7.3). Scheme, host, path and query must still match.
 * An omitted redirect_uri resolves only when exactly one is registered.
 */
export function matchRedirectUri(requested: unknown, registered: string[]): string | null {
  if (requested == null || requested === "") return registered.length === 1 ? registered[0] : null;
  if (typeof requested !== "string" || !validRedirectUri(requested)) return null;
  if (registered.includes(requested)) return requested;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return null;
  }
  if (want.protocol !== "http:" || !isLoopbackHost(want.hostname)) return null;
  for (const candidate of registered) {
    try {
      const have = new URL(candidate);
      if (
        have.protocol === "http:" &&
        have.hostname === want.hostname &&
        have.pathname === want.pathname &&
        have.search === want.search
      ) {
        return requested;
      }
    } catch {}
  }
  return null;
}

/** PKCE S256: BASE64URL(SHA256(verifier)) === challenge, compared in constant time. */
export function pkceS256Matches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function escHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string
  );
}

// ---------- pending authorization requests ----------

export const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 100;
/** One address holds at most this many pending requests; a sixth evicts its own oldest. */
export const MAX_PENDING_PER_IP = 5;

export type PendingAuthorization = {
  origin: string;
  /** The address that started the request (the per-address cap counts these). */
  ip: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string;
  expiresAt: number;
  /** Set when the consent page is shown: the device that must answer it, and its CSRF token. */
  deviceId: number | null;
  csrf: string | null;
  /** SHA-256 of the same-site hop nonce the bounce page's browser holds (see issueHop). */
  hopHash: string | null;
};

const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Constant-time equality of two 43-char base64url secrets; any other shape is unequal, never a throw. */
export function secretsEqual(given: unknown, expected: string | null): boolean {
  if (typeof given !== "string" || !expected || !SECRET_SHAPE.test(given) || !SECRET_SHAPE.test(expected)) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Validated authorization requests waiting for the owner: keyed by the SHA-256 of a
 * random handle (`rid`) so the handle survives the sign-in detour (a SameSite=Strict
 * session cookie is not sent on the cross-site hop that opens /oauth/authorize). In
 * process memory, ten minutes, at most a hundred — and at most MAX_PENDING_PER_IP per
 * address, so one address cannot flush everyone else's; a restart only means "connect
 * again". The same request made again (same client, PKCE challenge, state and redirect
 * URI, from the same address) reuses its entry under a fresh handle instead of adding one.
 */
export class PendingAuthorizations {
  private entries = new Map<string, PendingAuthorization>();

  create(entry: Omit<PendingAuthorization, "expiresAt" | "deviceId" | "csrf" | "hopHash">, now = Date.now()): string {
    this.prune(now);
    for (const [key, have] of this.entries) {
      if (
        have.ip === entry.ip &&
        have.origin === entry.origin &&
        have.clientId === entry.clientId &&
        have.codeChallenge === entry.codeChallenge &&
        have.state === entry.state &&
        have.redirectUri === entry.redirectUri
      ) {
        this.entries.delete(key);
      }
    }
    const fromIp = [...this.entries].filter(([, have]) => have.ip === entry.ip);
    for (const [key] of fromIp.slice(0, Math.max(0, fromIp.length - (MAX_PENDING_PER_IP - 1)))) {
      this.entries.delete(key);
    }
    while (this.entries.size >= MAX_PENDING) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const rid = crypto.randomBytes(32).toString("base64url");
    this.entries.set(hashRid(rid), {
      ...entry,
      expiresAt: now + PENDING_TTL_MS,
      deviceId: null,
      csrf: null,
      hopHash: null,
    });
    return rid;
  }

  /**
   * A fresh nonce for the one same-site hop the bounce page makes: the bounce response
   * hands it to THAT browser as a cookie, so only the browser that opened the request can
   * take the signed-out detour with it (a ?rid= link planted on someone else cannot).
   */
  issueHop(rid: string): string {
    const entry = this.get(rid);
    if (!entry) throw new Error("pending authorization expired");
    const nonce = crypto.randomBytes(32).toString("base64url");
    entry.hopHash = hashRid(nonce);
    return nonce;
  }

  /** Spend the hop nonce: true once, for the browser holding it. */
  spendHop(rid: unknown, nonce: unknown, now = Date.now()): boolean {
    const entry = this.get(rid, now);
    if (!entry?.hopHash || typeof nonce !== "string" || !SECRET_SHAPE.test(nonce)) return false;
    const a = Buffer.from(hashRid(nonce), "hex");
    const b = Buffer.from(entry.hopHash, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    entry.hopHash = null;
    return true;
  }

  /** The clients with a request waiting — never evicted from the registry to make room. */
  clientIds(now = Date.now()): Set<string> {
    this.prune(now);
    return new Set([...this.entries.values()].map((e) => e.clientId));
  }

  get(rid: unknown, now = Date.now()): PendingAuthorization | null {
    if (typeof rid !== "string" || !SECRET_SHAPE.test(rid)) return null;
    const key = hashRid(rid);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  /** Bind the request to the device shown its consent page; returns that page's CSRF token. */
  bind(rid: string, deviceId: number): string {
    const entry = this.get(rid);
    if (!entry) throw new Error("pending authorization expired");
    if (entry.deviceId !== deviceId || !entry.csrf) {
      entry.deviceId = deviceId;
      entry.csrf = crypto.randomBytes(32).toString("base64url");
    }
    return entry.csrf;
  }

  /** Remove and return a request (a consent answer is single use). */
  take(rid: unknown, now = Date.now()): PendingAuthorization | null {
    const entry = this.get(rid, now);
    if (entry) this.entries.delete(hashRid(rid as string));
    return entry;
  }

  size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}

function hashRid(rid: string): string {
  return crypto.createHash("sha256").update(rid, "utf8").digest("hex");
}

export const pendingAuthorizations = new PendingAuthorizations();

// ---------- limits ----------

/** Every request to these doors shares the global per-IP window (no-op unless auth is on). */
function oauthRateLimit(req: Request, res: Response, next: NextFunction) {
  const gate = checkRateLimit(req.ip || "unknown");
  if (gate.allowed) return next();
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))));
  res.status(429).json({ error: "rate_limited" });
}

// Registrations are counted, not just failures: ten per address per hour (off, like the
// per-IP window, with CAIRN_RATE_LIMIT=0). Per address only — a global lock would let anyone
// shut registration for everyone; the 50-client cap with oldest-unused eviction bounds the total.
const registerLimiter = new FailureLimiter({
  windowMs: 60 * 60 * 1000,
  perIpFailures: 10,
  maxLockMs: 60 * 60 * 1000,
});

oauthRouter.use(["/.well-known", "/oauth"], oauthRateLimit);

// ---------- shared request plumbing ----------

/** The origin OAuth may run at for this request, or null (auth off, plain http off loopback, odd host). */
function oauthOrigin(req: Request): string | null {
  if (!authEnabled) return null;
  const origin = canonicalOrigin(req);
  return oauthOriginAllowed(origin) ? origin : null;
}

function cors(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");
  res.setHeader("Access-Control-Max-Age", "600");
}

function notFound(res: Response): Response {
  return res.status(404).json({ error: "not_found" });
}

/** The live device this browser's own session cookie opens (sliding the cookie when its stamp moved). */
function liveDevice(req: Request, res: Response): AuthDevice | null {
  const secret = readSessionCookie(req.headers.cookie);
  const hit = secret ? deviceForSessionSecret(secret) : null;
  if (!hit || !secret) return null;
  if (hit.touched) res.append("Set-Cookie", sessionCookie(secret, { secure: req.secure === true }));
  return hit.device;
}

// ---------- discovery ----------

function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Cairn",
  };
}

function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  };
}

// The protected-resource document is served at both forms the MCP authorization spec
// names (Authorization Server Discovery → "Protected Resource Metadata Discovery
// Requirements"): path-suffixed for /mcp — the one the 401's WWW-Authenticate points at,
// RFC 9728 §3.1 — and the root, which MCP clients MUST try next when a challenge carries
// no resource_metadata. Strict RFC 9728 §3.3 would tie the root document to a resource
// of the bare origin; the MCP spec deliberately lists the root for a sub-path endpoint,
// and the document is public, so the root stays rather than strand an older client.
const DISCOVERY = {
  "/.well-known/oauth-protected-resource": protectedResourceMetadata,
  "/.well-known/oauth-protected-resource/mcp": protectedResourceMetadata,
  "/.well-known/oauth-authorization-server": authorizationServerMetadata,
} as const;

for (const [path, build] of Object.entries(DISCOVERY)) {
  oauthRouter.options(path, (_req, res) => {
    cors(res);
    res.status(204).end();
  });
  oauthRouter.get(path, (req, res) => {
    cors(res);
    // Exact case only: a well-known URI is case-sensitive, and an odd spelling is no document.
    if (req.path !== path) return notFound(res);
    const origin = oauthOrigin(req);
    if (!origin) return notFound(res);
    res.setHeader("Cache-Control", "no-store");
    res.json(build(origin));
  });
}

// ---------- Dynamic Client Registration (RFC 7591), public clients only ----------

function registrationError(res: Response, error: string, description: string): Response {
  return res.status(400).json({ error, error_description: description });
}

oauthRouter.options("/oauth/register", (_req, res) => {
  cors(res);
  res.status(204).end();
});

oauthRouter.post("/oauth/register", (req, res) => {
  cors(res);
  res.setHeader("Cache-Control", "no-store");
  const origin = oauthOrigin(req);
  if (!origin) return notFound(res);
  const ip = req.ip || "unknown";
  const gate = rateLimitEnabled ? registerLimiter.check(ip) : { allowed: true, retryAfterMs: 0 };
  if (!gate.allowed) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))));
    return res.status(429).json({ error: "rate_limited" });
  }
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return registrationError(res, "invalid_redirect_uri", `Register 1 to ${MAX_REDIRECT_URIS} redirect URIs.`);
  }
  if (!uris.every(validRedirectUri)) {
    return registrationError(
      res,
      "invalid_redirect_uri",
      "Redirect URIs must use https, or http on localhost / 127.0.0.1 / [::1], with no fragment."
    );
  }
  const grants = body.grant_types;
  if (
    grants !== undefined &&
    (!Array.isArray(grants) ||
      !grants.includes("authorization_code") ||
      !grants.every((g) => g === "authorization_code" || g === "refresh_token"))
  ) {
    return registrationError(
      res,
      "invalid_client_metadata",
      "Only authorization_code and refresh_token are supported."
    );
  }
  const responses = body.response_types;
  if (responses !== undefined && (!Array.isArray(responses) || !responses.every((r) => r === "code"))) {
    return registrationError(res, "invalid_client_metadata", "Only the code response type is supported.");
  }
  const client = registerOAuthClient({
    name: body.client_name,
    redirectUris: [...new Set(uris as string[])],
    busyClientIds: pendingAuthorizations.clientIds(),
  });
  if (!client) {
    // Full of apps that may be mid-consent: refuse the newcomer rather than evict one.
    res.setHeader("Retry-After", String(Math.ceil(OAUTH_CLIENT_FRESH_MS / 1000)));
    return res.status(429).json({
      error: "temporarily_unavailable",
      error_description: "Too many apps are connecting right now. Try again in a few minutes.",
    });
  }
  registerLimiter.fail(ip); // counts every registration, not only failures
  // Public client: no secret is issued, whatever auth method was asked for (RFC 7591 §3.2.1
  // lets the server substitute values; the response is authoritative).
  res.status(201).json({
    client_id: client.id,
    client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
    client_name: client.name,
    redirect_uris: client.redirect_uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: MCP_SCOPE,
  });
});

// ---------- the authorization endpoint ----------

export const OAUTH_RETURN_COOKIE = "cairn_oauth_return";

function returnCookie(rid: string, opts: { secure: boolean; maxAgeSec: number }): string {
  const attrs = [`${OAUTH_RETURN_COOKIE}=${rid}`, "Path=/", `Max-Age=${opts.maxAgeSec}`, "HttpOnly", "SameSite=Lax"];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** The proof of the bounce page's same-site hop, held only by the browser that got that page. */
export const OAUTH_HOP_COOKIE = "cairn_oauth_hop";

function hopCookie(nonce: string, opts: { secure: boolean; maxAgeSec: number }): string {
  const attrs = [
    `${OAUTH_HOP_COOKIE}=${nonce}`,
    "Path=/oauth",
    `Max-Age=${opts.maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

function readCookie(header: unknown, name: string): string | null {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return SECRET_SHAPE.test(value) ? value : null;
  }
  return null;
}

function readReturnCookie(header: unknown): string | null {
  return readCookie(header, OAUTH_RETURN_COOKIE);
}

/**
 * True when this ?rid= request is the same-site leg of a flow THIS browser started: a
 * same-origin navigation (Sec-Fetch-Site — the bounce page's meta refresh, or the shell
 * sending a signed-in browser back), or the bounce page's own hop nonce in its cookie
 * for browsers that send no fetch metadata. A bare cross-site ?rid= link is neither.
 */
function sameSiteLeg(req: Request, rid: string): boolean {
  if (req.get("sec-fetch-site") === "same-origin") return true;
  return pendingAuthorizations.spendHop(rid, readCookie(req.headers.cookie, OAUTH_HOP_COOKIE));
}

/** The browser goes back to the app with `params` (+ RFC 9207 `iss`) on its redirect URI. */
function redirectToClient(
  res: Response,
  redirectUri: string,
  origin: string,
  params: Record<string, string | null | undefined>
): void {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, value);
  url.searchParams.set("iss", origin);
  res.setHeader("Cache-Control", "no-store");
  res.redirect(303, url.toString());
}

function queryString(req: Request, name: string, max = 2048): string | null {
  const v = (req.query as Record<string, unknown>)[name];
  return typeof v === "string" && v.length <= max ? v : null;
}

function redirectHostLabel(redirectUri: string): { label: string; loopback: boolean } {
  try {
    const url = new URL(redirectUri);
    return isLoopbackHost(url.hostname)
      ? { label: "an app on this computer", loopback: true }
      : { label: url.hostname, loopback: false };
  } catch {
    return { label: "the app", loopback: false };
  }
}

oauthRouter.get("/oauth/authorize", (req, res) => {
  const origin = oauthOrigin(req);
  if (!origin) {
    return sendPage(res, 404, {
      title: "Not available",
      body: `<p>${
        !authEnabled
          ? "This Cairn has sign-in turned off, so apps connect without one."
          : httpsBehindUntrustedProxy(req)
            ? "This Cairn sits behind a proxy it does not trust yet, so it cannot tell the address is secure. Set CAIRN_TRUST_PROXY=1 and restart."
            : "Connecting apps needs this Cairn on a secure (https) address."
      }</p>`,
    });
  }
  let rid = queryString(req, "rid", 64);
  let entry = rid ? pendingAuthorizations.get(rid) : null;
  if (rid && !entry) return sendPage(res, 400, EXPIRED_PAGE);
  if (entry && entry.origin !== origin) return sendPage(res, 400, EXPIRED_PAGE);

  if (!entry) {
    // A fresh request. Until the client and its redirect URI check out, an error is shown
    // here and the browser is NEVER sent anywhere (OAuth 2.1 §4.1.2.1).
    const client: OAuthClient | null = getOAuthClient(queryString(req, "client_id", 64));
    const redirectUri = client ? matchRedirectUri(queryString(req, "redirect_uri", 512), client.redirect_uris) : null;
    if (!client || !redirectUri) return sendPage(res, 400, INVALID_REQUEST_PAGE);
    const state = queryString(req, "state");
    const fail = (error: string, description: string) =>
      redirectToClient(res, redirectUri, origin, { error, error_description: description, state });
    if (queryString(req, "response_type") !== "code") {
      return fail("unsupported_response_type", "Only response_type=code is supported.");
    }
    const challenge = queryString(req, "code_challenge", 128);
    if (queryString(req, "code_challenge_method") !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    const resourceParam = queryString(req, "resource", 512);
    const resource = mcpResourceUrl(origin);
    if (resourceParam && !resourcesEqual(resourceParam, resource)) {
      return fail("invalid_target", "This server only issues tokens for its /mcp endpoint.");
    }
    rid = pendingAuthorizations.create({
      origin,
      ip: req.ip || "unknown",
      clientId: client.id,
      clientName: client.name,
      redirectUri,
      codeChallenge: challenge,
      state,
      resource,
    });
    entry = pendingAuthorizations.get(rid);
    if (!entry) return sendPage(res, 400, EXPIRED_PAGE);
  }

  const device = liveDevice(req, res);
  if (device && rid) {
    const csrf = pendingAuthorizations.bind(rid, device.id);
    return sendConsentPage(res, entry, rid, csrf);
  }
  if (!queryString(req, "rid", 64) && rid) {
    // The cross-site hop that opened this page carried no SameSite=Strict cookie, even if
    // this browser is signed in. One same-site step (a meta refresh) brings it along —
    // and this browser alone gets the nonce that proves that step was its own.
    res.append(
      "Set-Cookie",
      hopCookie(pendingAuthorizations.issueHop(rid), {
        secure: req.secure === true,
        maxAgeSec: PENDING_TTL_MS / 1000,
      })
    );
    return sendPage(res, 200, {
      title: "Connecting…",
      head: `<meta http-equiv="refresh" content="0;url=/oauth/authorize?rid=${escHtml(rid)}">`,
      body: `<p>Taking you to Cairn… <a href="/oauth/authorize?rid=${escHtml(rid)}">Continue</a></p>`,
    });
  }
  // Signed out: the ordinary sign-in screen, then straight back here (oauthResume) — but
  // only on the same-site leg of a flow this browser started. A bare cross-site ?rid=
  // link (someone else's pending request) never plants the return cookie, so it can
  // never surface a consent page the owner did not ask for.
  if (!rid || !sameSiteLeg(req, rid)) return sendPage(res, 400, EXPIRED_PAGE);
  res.append("Set-Cookie", hopCookie("", { secure: req.secure === true, maxAgeSec: 0 }));
  res.append("Set-Cookie", returnCookie(rid, { secure: req.secure === true, maxAgeSec: PENDING_TTL_MS / 1000 }));
  res.setHeader("Cache-Control", "no-store");
  res.redirect(303, "/");
});

// The owner's answer. Same-origin, CSRF-checked, from the very device the page was shown to.
oauthRouter.post("/oauth/authorize", urlencoded, (req, res) => {
  const origin = oauthOrigin(req);
  if (!origin)
    return sendPage(res, 404, { title: "Not available", body: "<p>Connecting apps is not available here.</p>" });
  if (!isSameOriginRequest(req.headers, trustProxyHops())) return sendPage(res, 403, INVALID_REQUEST_PAGE);
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const rid = typeof body.rid === "string" ? body.rid : "";
  const entry = pendingAuthorizations.get(rid);
  const device = liveDevice(req, res);
  if (
    !entry ||
    !device ||
    entry.origin !== origin ||
    entry.deviceId !== device.id ||
    // Shape first, then byte lengths: a multibyte csrf of the right string length is a 403, never a throw.
    !secretsEqual(body.csrf, entry.csrf)
  ) {
    return sendPage(res, 403, EXPIRED_PAGE);
  }
  pendingAuthorizations.take(rid);
  if (body.decision !== "allow") {
    return redirectToClient(res, entry.redirectUri, origin, {
      error: "access_denied",
      error_description: "The owner did not allow this app.",
      state: entry.state,
    });
  }
  const code = createAuthCode({
    clientId: entry.clientId,
    redirectUri: entry.redirectUri,
    codeChallenge: entry.codeChallenge,
    resource: entry.resource,
    deviceId: device.id,
  });
  redirectToClient(res, entry.redirectUri, origin, { code, state: entry.state });
});

/**
 * The consent page a signed-in browser is on its way back to, as a same-origin relative
 * path — or null. For the shell's own sign-in screen: the return cookie is HttpOnly and an
 * installed service worker answers the reload from its cache (oauthResume never sees it),
 * so GET /api/auth/status hands the path to the client, which navigates there. Spends the
 * return cookie exactly like oauthResume does.
 */
export function pendingOAuthResumePath(req: Request, res: Response, signedIn: boolean): string | null {
  if (!authEnabled || !signedIn) return null;
  const rid = readReturnCookie(req.headers.cookie);
  if (!rid) return null;
  res.append("Set-Cookie", returnCookie("", { secure: req.secure === true, maxAgeSec: 0 }));
  return pendingAuthorizations.get(rid) ? `/oauth/authorize?rid=${encodeURIComponent(rid)}` : null;
}

/**
 * Back from the sign-in detour: the shell (`/`, `/app/…`) loaded with a pending request's
 * cookie, now signed in, goes straight to the consent page. Signed out, the shell loads
 * and shows its sign-in screen as always (whose success reloads into this).
 */
export function oauthResume(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled || (req.method !== "GET" && req.method !== "HEAD")) return next();
  if (req.path !== "/" && !/^\/app(?:\/|$)/.test(req.path)) return next();
  const rid = readReturnCookie(req.headers.cookie);
  if (!rid) return next();
  const entry = pendingAuthorizations.get(rid);
  if (!entry) {
    res.append("Set-Cookie", returnCookie("", { secure: req.secure === true, maxAgeSec: 0 }));
    return next();
  }
  if (!liveDevice(req, res)) return next();
  res.append("Set-Cookie", returnCookie("", { secure: req.secure === true, maxAgeSec: 0 }));
  res.setHeader("Cache-Control", "no-store");
  res.redirect(303, `/oauth/authorize?rid=${rid}`);
}

// ---------- the token endpoint ----------

function tokenError(res: Response, status: number, error: string, description: string): Response {
  return res.status(status).json({ error, error_description: description });
}

oauthRouter.options("/oauth/token", (_req, res) => {
  cors(res);
  res.status(204).end();
});

oauthRouter.post("/oauth/token", urlencoded, (req, res) => {
  cors(res);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  const origin = oauthOrigin(req);
  if (!origin) return notFound(res);
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const str = (name: string, max = 2048): string | null => {
    const v = body[name];
    return typeof v === "string" && v.length <= max ? v : null;
  };
  const client = getOAuthClient(str("client_id", 64));
  if (!client) return tokenError(res, 401, "invalid_client", "Unknown client.");
  const resourceParam = str("resource", 512);
  if (resourceParam && !resourcesEqual(resourceParam, mcpResourceUrl(origin))) {
    return tokenError(res, 400, "invalid_target", "This server only issues tokens for its /mcp endpoint.");
  }
  const grantType = str("grant_type", 64);

  if (grantType === "authorization_code") {
    // Spend the code FIRST: a wrong verifier or redirect URI still burns it.
    const spent = consumeAuthCode(str("code", 128));
    if (spent.status === "replayed") {
      // A code presented twice: whatever the first exchange minted is revoked (OAuth 2.1 §4.1.3).
      if (spent.grantId != null) revokeMcpClient(spent.grantId);
      return tokenError(res, 400, "invalid_grant", "The authorization code was already used.");
    }
    if (spent.status !== "ok")
      return tokenError(res, 400, "invalid_grant", "The authorization code is invalid or expired.");
    const row = spent.row;
    if (row.client_id !== client.id)
      return tokenError(res, 400, "invalid_grant", "The code was issued to another client.");
    const redirectUri = str("redirect_uri", 512);
    if (redirectUri ? redirectUri !== row.redirect_uri : client.redirect_uris.length !== 1) {
      return tokenError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request.");
    }
    if (!pkceS256Matches(body.code_verifier, row.code_challenge)) {
      return tokenError(res, 400, "invalid_grant", "PKCE verification failed.");
    }
    if (resourceParam && !resourcesEqual(resourceParam, row.resource)) {
      return tokenError(res, 400, "invalid_target", "resource does not match the authorization request.");
    }
    const tokens = grantFromCode({ codeHash: spent.codeHash, row });
    if (!tokens) return tokenError(res, 400, "invalid_grant", "The client is no longer registered.");
    return res.json({ token_type: "Bearer", ...tokens });
  }

  if (grantType === "refresh_token") {
    const rotated = rotateRefreshToken({
      refreshToken: str("refresh_token", 128),
      clientId: client.id,
      resource: resourceParam,
    });
    if (!rotated.ok) return tokenError(res, 400, "invalid_grant", "The refresh token is invalid, expired or revoked.");
    return res.json({ token_type: "Bearer", ...rotated.tokens });
  }

  return tokenError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
});

// ---------- pages ----------

type Page = { title: string; body: string; head?: string };

const EXPIRED_PAGE: Page = {
  title: "Start again from the app",
  body: "<p>This request to connect an app has expired or was already answered. Go back to the app and connect again.</p>",
};

const INVALID_REQUEST_PAGE: Page = {
  title: "This link isn't valid",
  body: "<p>The app sent an incomplete or unrecognised request, so nothing was connected. Go back to the app and connect again.</p>",
};

function sendConsentPage(res: Response, entry: PendingAuthorization, rid: string, csrf: string): void {
  const name = escHtml(entry.clientName);
  const dest = redirectHostLabel(entry.redirectUri);
  const loopbackNote = dest.loopback
    ? `<p class="note">Only allow this if you started connecting an app on this computer just now.</p>`
    : "";
  sendPage(res, 200, {
    title: `Connect ${entry.clientName}?`,
    body: `<h1>Connect ${name}?</h1>
      <p><strong>${name}</strong> wants to use your Cairn — read and change your training, food and health data.</p>
      <p class="meta">You'll go back to <strong>${escHtml(dest.label)}</strong>. “${name}” is the name the app gave itself.</p>
      ${loopbackNote}
      <p class="meta">You can disconnect it any time in Settings → Devices → Connected AI apps.</p>
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="rid" value="${escHtml(rid)}">
        <input type="hidden" name="csrf" value="${escHtml(csrf)}">
        <div class="actions">
          <button class="quiet" type="submit" name="decision" value="deny">Cancel</button>
          <button class="solid" type="submit" name="decision" value="allow">Allow</button>
        </div>
      </form>`,
  });
}

const PAGE_STYLE = `
@font-face{font-family:"Hanken Grotesk";src:url(/fonts/hanken-grotesk-latin-wght.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Young Serif";src:url(/fonts/young-serif-latin-400.woff2) format("woff2");font-display:swap}
:root{color-scheme:light;--ground:#ebe7de;--surface:#f7f4ee;--line:#d5cec0;--ink:#191d20;--ink2:#454b50;--muted:#5d625d;--dawn:#984b0e;--dawn-deep:#843f0a;--on-accent:#fbf8f2;--warn:#a53d35}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--ground:#121619;--surface:#1a2024;--line:#2e373d;--ink:#ece6da;--ink2:#b0b3ad;--muted:#91988f;--dawn:#f0aa62;--dawn-deep:#f6c28e;--on-accent:#121619;--warn:#ee9184}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--ground);color:var(--ink);font:16px/1.5 "Hanken Grotesk",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:420px;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:28px 24px}
.mark{font-family:"Young Serif",Georgia,serif;font-size:15px;color:var(--muted);letter-spacing:.02em;margin:0 0 18px}
h1{font-family:"Young Serif",Georgia,serif;font-weight:400;font-size:24px;line-height:1.25;margin:0 0 12px;overflow-wrap:anywhere}
p{margin:0 0 12px;color:var(--ink2);overflow-wrap:anywhere}
strong{color:var(--ink);font-weight:600}
.meta{font-size:14px;color:var(--muted)}
.note{font-size:14px;color:var(--warn)}
.actions{display:flex;gap:12px;justify-content:flex-end;margin-top:22px}
button{font:inherit;font-weight:600;border-radius:999px;padding:11px 22px;min-height:44px;cursor:pointer;border:1px solid transparent}
button:active{transform:scale(.96)}
.solid{background:var(--dawn);color:var(--on-accent)}
.solid:hover{background:var(--dawn-deep)}
.quiet{background:transparent;color:var(--ink);border-color:var(--line)}
a{color:var(--dawn)}
@media (prefers-reduced-motion:reduce){button:active{transform:none}}`;

function sendPage(res: Response, status: number, page: Page): void {
  res.setHeader("Cache-Control", "no-store");
  // The consent form's POST must carry its Origin: the app-wide no-referrer policy would
  // send `Origin: null` on a form post. same-origin still sends nothing cross-site.
  res.setHeader("Referrer-Policy", "same-origin");
  res
    .status(status)
    .type("html")
    .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escHtml(page.title)} · Cairn</title>${page.head || ""}
<style>${PAGE_STYLE}</style></head>
<body><main><p class="mark">Cairn</p>${page.body}</main></body></html>`);
}
