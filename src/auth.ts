import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// OPTIONAL shared-token auth. Cairn is single-user and self-hosted; the default
// (no token set) keeps the zero-friction localhost behaviour Cairn has always
// had. Set CAIRN_AUTH_TOKEN to gate the data + control planes (/api and /mcp)
// behind a bearer token — the right move whenever the port is reachable from a
// LAN, tailnet, or anywhere beyond loopback.
//
// When enabled, a client may present the token three ways:
//   - Authorization: Bearer <token>   (MCP clients, API tooling)
//   - X-Cairn-Token: <token>          (the PWA's fetch helper)
//   - ?token=<token>                  (last-resort query fallback)
//
// Never gated: the PWA static shell (so it can render a token prompt) and
// GET /api/health (so the Docker healthcheck keeps working).

const TOKEN = (process.env.CAIRN_AUTH_TOKEN || "").trim();

export const authEnabled = TOKEN.length > 0;

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
  if (typeof q === "string" && q) return q;
  return null;
}

// A single global guard. It only enforces on /api and /mcp; the static PWA
// shell and the healthcheck pass straight through. No-op when no token is set.
export function authGuard(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled) return next();
  const p = req.path;
  if (!p.startsWith("/api") && !p.startsWith("/mcp")) return next();
  if (p === "/api/health") return next();
  const got = presentedToken(req);
  if (got && safeEqual(got, TOKEN)) return next();
  res.status(401).json({ error: "unauthorized" });
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

// Non-Express token check for the WebSocket upgrade path. WS upgrades bypass
// Express middleware, so that handler must authenticate itself — this mirrors
// authGuard (allow-all when no token is set; otherwise a timing-safe compare).
export function tokenMatches(token: string | null | undefined): boolean {
  if (!authEnabled) return true;
  return !!token && safeEqual(token, TOKEN);
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

// Sits in FRONT of authGuard so it also throttles token-guessing on the auth
// boundary. No-op unless auth is on and a positive limit is configured. Same
// scope as authGuard (/api + /mcp, /api/health exempt).
export function rateLimitGuard(req: Request, res: Response, next: NextFunction) {
  if (!rateLimitEnabled) return next();
  const p = req.path;
  if (!p.startsWith("/api") && !p.startsWith("/mcp")) return next();
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
