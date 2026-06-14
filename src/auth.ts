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
