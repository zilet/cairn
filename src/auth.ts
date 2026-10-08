import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "node:http";
import { verifyAppleHealthIngestToken } from "./repo/apple-health.js";
import {
  applyAccessTokenEpoch,
  deviceForSessionSecret,
  masterTokenEverUsed,
  recordMasterTokenUse,
  verifyCalendarFeedToken,
} from "./repo/auth-devices.js";
import {
  ResourceLinkStore,
  clearedSessionCookie,
  isSameOriginRequest,
  isUnsafeMethod,
  readSessionCookie,
  sessionCookie,
} from "./authHttp.js";
import { isMcpScope, mcpBearerClient, setMcpChallenge } from "./mcpAccess.js";

// OPTIONAL shared-token auth. Cairn is single-user and self-hosted; the default
// (no token set) keeps the zero-friction localhost behaviour Cairn has always
// had. Set CAIRN_AUTH_TOKEN to gate the data + control planes (/api and /mcp)
// behind a bearer token — the right move whenever the port is reachable from a
// LAN, tailnet, or anywhere beyond loopback.
//
// When enabled, a BROWSER signs in once (the token, a one-time pairing code, or a
// passkey — src/routes/auth.ts) and then carries an HttpOnly per-device session
// cookie. API/MCP clients keep presenting the master token, three ways:
//   - Authorization: Bearer <token>   (MCP clients, API tooling)
//   - X-Cairn-Token: <token>          (the PWA's fetch helper)
//   - ?token=<token>                  (only for browser surfaces that cannot set headers:
//                                      downloads, EventSource streams, and WS upgrades)
//
// Two narrower query credentials exist for URLs a browser opens outside the app's own
// cookie jar (an installed iOS app opens a new tab in Safari): `?sig=`, a two-minute link
// bound to one path and its exact query, that a signed-in client mints (POST
// /api/auth/resource-link), and `?feed=`,
// the long-lived, revocable calendar subscription token that opens GET /api/plan.ics alone.
//
// Never gated: the PWA static shell (so it can render the sign-in screen),
// GET /api/health (so the Docker healthcheck keeps working), the Apple Health
// pairing exchange, and the unauthenticated sign-in doors (SIGN_IN_DOORS).

const TOKEN = (process.env.CAIRN_AUTH_TOKEN || "").trim();

export const authEnabled = TOKEN.length > 0;

// Fail-closed enforcement for any deployment reachable beyond loopback (a public
// reverse proxy, Tailscale Funnel, a port-forward, a "public" cloud-sandbox port).
// CAIRN_REQUIRE_AUTH=1 turns the "set a token when exposed" CONVENTION into a hard
// boot check: the server refuses to start without a token instead of silently
// serving an open instance. Default off ⇒ the trusted-network/localhost behaviour
// is unchanged. Bake CAIRN_REQUIRE_AUTH=1 into any compose/template that exposes
// the port so it can never boot insecurely.
export const requireAuth = /^(1|true|yes|on)$/i.test((process.env.CAIRN_REQUIRE_AUTH || "").trim());

// Pure + unit-testable: the message to abort boot with, or null if boot may
// proceed. server.ts calls this before listen() and exits non-zero on a message.
export function authStartupError(opts: { requireAuth: boolean; authEnabled: boolean }): string | null {
  if (opts.requireAuth && !opts.authEnabled) {
    return (
      "CAIRN_REQUIRE_AUTH is set but CAIRN_AUTH_TOKEN is empty — refusing to start " +
      "an unauthenticated instance. Set a long random CAIRN_AUTH_TOKEN, or unset " +
      "CAIRN_REQUIRE_AUTH for trusted-network / localhost use."
    );
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function presentedToken(req: Request): string | null {
  const auth = req.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1].trim();
  }
  const header = req.get("x-cairn-token");
  if (header) return header.trim();
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof q === "string" && q && queryTokenAllowedPath(req.path, req.method)) return q;
  return null;
}

const appleHealthPrincipals = new WeakMap<Request, { connection_id: number }>();

export function appleHealthTokenScopeAllows(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && path === "/api/health-metrics";
}

export function appleHealthConnectionForRequest(req: Request): number | null {
  return appleHealthPrincipals.get(req)?.connection_id ?? null;
}

export function queryTokenAllowedPath(p: string, method = "GET"): boolean {
  if (method.toUpperCase() !== "GET") return false;
  if (p === "/api/plan.ics") return true;
  if (p === "/api/export" || p === "/api/export/db" || p === "/api/health-export") return true;
  // The clinician report opens in a new browser tab (and its .txt twin downloads),
  // neither of which can set an auth header — the query token is their only path.
  if (p === "/api/health-report" || p === "/api/health-report.txt") return true;
  // The PWA renders generated artwork via <img src=…?token=…>; an <img> can't set
  // request headers, so the query token is its only auth path. (204/PNG GET only.)
  if (p === "/api/art") return true;
  // The generic movement-pattern stand-in layered under an exercise figure (same
  // <img> constraint; exact path, GET-only, a starter-pack image or a 204).
  if (p === "/api/art/generic") return true;
  // Demonstration photos in the exercise "How to" sheet render via <img> as well.
  // Both segments are exact: a dataset slug and a single-digit frame index, so no
  // broader guide path (import, attach) is reachable with a query token.
  if (/^\/api\/exercise-guides\/image\/[A-Za-z0-9_-]{1,120}\/\d$/.test(p)) return true;
  // Chat-attached photos render via <img> too; the filename is server-generated
  // and route-local, so query-token auth is the browser-compatible path.
  if (/^\/api\/chat-images\/[0-9a-f-]+\.(?:jpg|png|webp|gif|heic|heif)$/i.test(p)) return true;
  if (/^\/api\/health-docs\/\d+\/file$/.test(p)) return true;
  // Imaging attachments render in <img>/<iframe> elements. Both ownership ids
  // must be exact positive decimal segments; broader health-doc paths stay denied.
  if (/^\/api\/health-docs\/[1-9]\d*\/imaging-files\/[1-9]\d*$/.test(p)) return true;
  if (/^\/api\/chat\/turns\/\d+\/stream$/.test(p)) return true;
  if (/^\/api\/agent-jobs\/\d+\/stream$/.test(p)) return true;
  // Background-enrichment status streams (EventSource — no header): the PWA watches
  // a just-logged activity / food note / health doc enrich in place via these.
  if (/^\/api\/activities\/\d+\/stream$/.test(p)) return true;
  if (/^\/api\/food-notes\/\d+\/stream$/.test(p)) return true;
  if (/^\/api\/health-docs\/\d+\/stream$/.test(p)) return true;
  return false;
}

// How a request was let in: the master token, a device session, or an open
// (auth-disabled) instance. Routes read it through authPrincipal().
export type AuthPrincipal =
  | { kind: "master" }
  | { kind: "session"; device_id: number }
  | { kind: "link" }
  | { kind: "feed" }
  | { kind: "mcp_client"; id: number }
  | { kind: "open" };
const principals = new WeakMap<Request, AuthPrincipal>();

export function authPrincipal(req: Request): AuthPrincipal {
  if (!authEnabled) return { kind: "open" };
  return principals.get(req) ?? { kind: "open" };
}

/** True when the request presented the master token itself (header or Bearer). */
export function presentsMasterToken(req: Request): boolean {
  if (!authEnabled) return false;
  const got = presentedToken(req);
  return !!got && safeEqual(got, TOKEN);
}

// The unauthenticated sign-in doors. Each is POST-only, rate limited (the global
// per-IP limiter in front of this guard, plus src/routes/auth.ts's failure limiter),
// and mints a session only after proving something: a live pairing code, a passkey
// assertion. Logout only ever ends the session the request itself carries.
const SIGN_IN_DOORS = new Set([
  "/api/auth/pair",
  "/api/auth/passkeys/login/options",
  "/api/auth/passkeys/login/verify",
  "/api/auth/logout",
]);

export function isSignInDoor(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && SIGN_IN_DOORS.has(path);
}

/** The process's signed resource links (src/authHttp.ts ResourceLinkStore). */
export const resourceLinks = new ResourceLinkStore();

/** The calendar feed opens exactly one read. */
export const CALENDAR_FEED_PATH = "/api/plan.ics";

function queryParam(req: Request, name: string): string | null {
  const v = (req.query as Record<string, unknown> | undefined)?.[name];
  return typeof v === "string" && v ? v : null;
}

/** The request's raw query string ("?a=1&sig=…", or ""), as the browser sent it. */
function rawQuery(req: Request): string {
  const url = String(req.originalUrl || req.url || "");
  const at = url.indexOf("?");
  return at >= 0 ? url.slice(at) : "";
}

// The first successful master-token sign-in is remembered once (app_state), so the boot's
// first-sign-in line stops the moment the owner has used the token. A primary-key read per
// master-token request, one write ever; never the token itself.
function noteMasterTokenUse(): void {
  try {
    if (!masterTokenEverUsed()) recordMasterTokenUse();
  } catch {
    /* a locked DB: the next request stamps it */
  }
}

/**
 * Boot: compare the configured token with the fingerprint the database remembers.
 * "changed" means the owner rotated CAIRN_AUTH_TOKEN, and every device session and
 * passkey minted under the old one has just been revoked.
 */
export function accessTokenEpochAtBoot(): "disabled" | "first" | "same" | "changed" {
  return authEnabled ? applyAccessTokenEpoch(TOKEN) : "disabled";
}

// A single global guard. It only enforces on /api and /mcp; the static PWA
// shell and the healthcheck pass straight through. No-op when no token is set.
export function authGuard(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled) return next();
  const p = req.path;
  // Express routes case-insensitively, so /API/… reaches the /api router: the scope test
  // must lowercase too, or a case change walks past the guard. Exemptions stay exact-case
  // on purpose — an odd-cased exempt path simply needs a credential.
  const scope = p.toLowerCase();
  if (!scope.startsWith("/api") && !scope.startsWith("/mcp")) return next();
  if (p === "/api/health") return next();
  if (p === "/api/apple-health/config" && req.method === "GET") return next();
  // The Shortcuts template exchanges a high-entropy, ten-minute, single-use
  // code. It cannot present the owner's token yet. The global per-IP limiter
  // still runs in front of this exception whenever auth is enabled.
  if (p === "/api/apple-health/pairing/exchange" && req.method === "POST") return next();
  if (isSignInDoor(req.method, p)) return next();
  const got = presentedToken(req);
  if (got && safeEqual(got, TOKEN)) {
    noteMasterTokenUse();
    principals.set(req, { kind: "master" });
    return next();
  }
  // An AI app's own key or OAuth access token (src/mcpAccess.ts): /mcp only, never /api.
  if (isMcpScope(scope)) {
    const client = mcpBearerClient(req);
    if (client) {
      principals.set(req, { kind: "mcp_client", id: client.id });
      return next();
    }
  }
  // A browser's device session. A cookie-authenticated WRITE must also come from this
  // very origin (Origin, else Referer): SameSite=Strict already keeps the cookie off
  // cross-site requests, and this is the second, independent lock.
  const secret = readSessionCookie(req.headers?.cookie);
  if (secret) {
    const hit = deviceForSessionSecret(secret);
    if (hit) {
      if (isUnsafeMethod(req.method) && !isSameOriginRequest(req.headers, trustProxyHops())) {
        return res.status(403).json({ error: "origin_mismatch" });
      }
      principals.set(req, { kind: "session", device_id: hit.device.id });
      // Sliding expiry: the stamp moved (at most hourly), so the cookie's Max-Age does too.
      if (hit.touched) res.append("Set-Cookie", sessionCookie(secret, { secure: req.secure === true }));
      return next();
    }
  }
  // A signed resource link (?sig=) or the calendar feed (?feed=): GET only, on the
  // query-credential allowlist only, never a session. A page a link opened must not
  // hand the link on in a Referer.
  if (req.method === "GET" && queryTokenAllowedPath(p, req.method)) {
    const sig = queryParam(req, "sig");
    if (sig && resourceLinks.use(sig, p, rawQuery(req))) {
      principals.set(req, { kind: "link" });
      res.setHeader("Referrer-Policy", "no-referrer");
      return next();
    }
    const feed = p === CALENDAR_FEED_PATH ? queryParam(req, "feed") : null;
    if (feed && verifyCalendarFeedToken(feed)) {
      principals.set(req, { kind: "feed" });
      return next();
    }
  }
  // A paired Shortcut credential is deliberately narrower than owner auth. It
  // can only ingest daily health metrics; it never reaches reads, settings,
  // exports, MCP, or any other mutation.
  if (got && appleHealthTokenScopeAllows(req.method, p)) {
    const connection = verifyAppleHealthIngestToken(got);
    if (connection) {
      appleHealthPrincipals.set(req, { connection_id: connection.id });
      return next();
    }
  }
  // A cookie that no longer opens anything (revoked, idle past its window) is cleared,
  // so the browser stops presenting it.
  if (secret) res.append("Set-Cookie", clearedSessionCookie({ secure: req.secure === true }));
  // An MCP client learns where to sign in (MCP Authorization; RFC 9728 §5.1).
  if (isMcpScope(scope)) setMcpChallenge(req, res);
  res.status(401).json({ error: "unauthorized" });
}

/**
 * The WebSocket upgrade's own check (upgrades bypass Express): the master token on the
 * query string (the legacy path), or a live device session cookie from this very
 * origin — a browser always sends Origin on a WebSocket handshake.
 */
export function upgradeAuthorized(req: IncomingMessage, queryToken: string | null | undefined): boolean {
  if (!authEnabled) return true;
  if (queryToken && safeEqual(queryToken, TOKEN)) {
    noteMasterTokenUse();
    return true;
  }
  const secret = readSessionCookie(req.headers?.cookie);
  if (!secret || !deviceForSessionSecret(secret)) return false;
  return isSameOriginRequest(req.headers, trustProxyHops());
}

// ---- optional rate limiting (defense in depth) ----
// Only meaningful once the port is reachable beyond loopback, which is exactly
// when CAIRN_AUTH_TOKEN is set — so the limiter shares that gate. It's a calm,
// generous fixed-window cap per client IP (a single-user app makes very few
// requests; the point is to blunt a token brute-force or a misbehaving client,
// not to throttle normal use). Set CAIRN_RATE_LIMIT=0 to disable even with auth on.
//
// The decision is a PURE function so it's deterministic + unit-testable without
// touching process env or the clock; the middleware just supplies now()/config/state.

export interface RateState {
  hits: Map<string, { count: number; resetAt: number }>;
}

export function newRateState(): RateState {
  return { hits: new Map() };
}

// Pure fixed-window decision. `now`/`windowMs` in ms. Mutates `state` (the caller
// owns it). limit <= 0 means "no limit" → always allowed. A fresh window opens on
// the first hit after the previous window's resetAt has passed.
export function rateLimitDecision(
  state: RateState,
  key: string,
  now: number,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  if (limit <= 0) return { allowed: true, remaining: Infinity, retryAfterMs: 0 };
  const e = state.hits.get(key);
  if (!e || now >= e.resetAt) {
    state.hits.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
  }
  if (e.count < limit) {
    e.count += 1;
    return { allowed: true, remaining: limit - e.count, retryAfterMs: 0 };
  }
  return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, e.resetAt - now) };
}

const RATE_LIMIT = (() => {
  const raw = process.env.CAIRN_RATE_LIMIT;
  if (raw == null || raw === "") return 600; // generous default per window
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 600;
})();
const RATE_WINDOW_MS = (() => {
  const n = Number(process.env.CAIRN_RATE_WINDOW_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60_000;
})();

export const rateLimitEnabled = authEnabled && RATE_LIMIT > 0;

const rateState = newRateState();

// Bound memory: when the per-IP table grows, drop windows that have already
// expired. A self-hosted instance sees a handful of clients, so this stays tiny.
function pruneRateState(now: number) {
  if (rateState.hits.size < 1024) return;
  for (const [k, v] of rateState.hits) if (now >= v.resetAt) rateState.hits.delete(k);
}

// Non-Express rate-limit check for the WS upgrade path, sharing the same fixed
// window + per-IP state as rateLimitGuard. No-op (allowed) unless auth is on and a
// positive limit is configured. `key` is the client IP.
export function checkRateLimit(key: string): { allowed: boolean; retryAfterMs: number } {
  if (!rateLimitEnabled) return { allowed: true, retryAfterMs: 0 };
  const now = Date.now();
  pruneRateState(now);
  const d = rateLimitDecision(rateState, key || "unknown", now, RATE_LIMIT, RATE_WINDOW_MS);
  return { allowed: d.allowed, retryAfterMs: d.retryAfterMs };
}

// How many reverse-proxy hops to trust for the client address (Express `trust proxy`).
// Behind Caddy, Tailscale Serve or a PaaS edge, every request otherwise arrives from
// the proxy's IP and the per-IP limiter collapses into one shared bucket. A HOP COUNT,
// never `true`: trusting every hop would let a client pick its own key by sending
// X-Forwarded-For. Unset = trust nothing, except on Railway, whose edge proxy always
// sits exactly one hop in front of the service.
export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.CAIRN_TRUST_PROXY || "").trim().toLowerCase();
  if (/^\d+$/.test(raw)) return Math.min(Number(raw), 4);
  if (raw === "true" || raw === "yes" || raw === "on") return 1;
  if (raw === "false" || raw === "no" || raw === "off") return 0;
  return env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PROJECT_ID ? 1 : 0;
}

// Sits in FRONT of authGuard so it also throttles token-guessing on the auth
// boundary. No-op unless auth is on and a positive limit is configured. Same
// scope as authGuard (/api + /mcp, /api/health exempt).
export function rateLimitGuard(req: Request, res: Response, next: NextFunction) {
  if (!rateLimitEnabled) return next();
  const p = req.path;
  // Express routes case-insensitively, so /API/… reaches the /api router: the scope test
  // must lowercase too, or a case change walks past the guard. Exemptions stay exact-case
  // on purpose — an odd-cased exempt path simply needs a credential.
  const scope = p.toLowerCase();
  if (!scope.startsWith("/api") && !scope.startsWith("/mcp")) return next();
  if (p === "/api/health") return next();
  const now = Date.now();
  pruneRateState(now);
  const key = req.ip || "unknown";
  const d = rateLimitDecision(rateState, key, now, RATE_LIMIT, RATE_WINDOW_MS);
  res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT));
  if (!d.allowed) {
    res.setHeader("Retry-After", String(Math.ceil(d.retryAfterMs / 1000)));
    return res.status(429).json({ error: "rate_limited" });
  }
  if (Number.isFinite(d.remaining)) res.setHeader("X-RateLimit-Remaining", String(d.remaining));
  next();
}
