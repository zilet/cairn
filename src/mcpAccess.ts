// The request side of "Connect an AI app": which origin this Cairn answers as, the /mcp
// resource and its metadata URL, the bearer check src/auth.ts runs for /mcp, and the
// `WWW-Authenticate` challenge a 401 on /mcp carries (MCP Authorization, RFC 9728 §5.1).
//
// Deliberately free of src/auth.ts imports (auth.ts calls in here), and pure where it
// can be. Nothing here logs; a token never reaches an error message.
import type { Request, Response } from "express";
import { type McpClient, MCP_SCOPE, mcpClientForBearer } from "./repo/mcp-clients.js";

const HOST_SHAPE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/;

/**
 * The origin a request reached this Cairn at: Express's protocol and host, which honour
 * X-Forwarded-Proto/-Host ONLY through the trust-proxy hop count (CAIRN_TRUST_PROXY, the
 * Railway default) — the same rule every other origin check here follows. Lowercased,
 * no trailing slash; null for a host that is not a plain DNS name, IPv4 or [IPv6].
 */
export function canonicalOrigin(req: Pick<Request, "protocol" | "host">): string | null {
  const host = String(req.host || "").toLowerCase();
  if (!host || host.length > 255 || !HOST_SHAPE.test(host)) return null;
  const scheme = req.protocol === "https" ? "https" : "http";
  return `${scheme}://${host}`;
}

/** Loopback hosts may use plain http (a local install, a desktop client's own callback). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/** OAuth runs over https, or over plain http on a loopback host only (OAuth 2.1 §1.5). */
export function oauthOriginAllowed(origin: string | null): origin is string {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
  } catch {
    return false;
  }
}

/**
 * True when a proxy says the browser reached it over https (X-Forwarded-Proto) but this
 * request still reads as plain http — the proxy hop is not trusted (CAIRN_TRUST_PROXY
 * unset), so Express ignored the header. The fix is that setting, not a certificate.
 */
export function httpsBehindUntrustedProxy(req: Pick<Request, "protocol" | "headers">): boolean {
  if (req.protocol === "https") return false;
  const raw = req.headers?.["x-forwarded-proto"];
  const first = String(Array.isArray(raw) ? raw[0] : raw || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return first === "https";
}

/** The protected resource: this Cairn's /mcp endpoint. */
export function mcpResourceUrl(origin: string): string {
  return `${origin}/mcp`;
}

/** RFC 9728's metadata URL for the /mcp resource (the path-suffixed well-known form). */
export function protectedResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}

/** The guard's scope test for /mcp (already lowercased by the caller: Express routes /MCP there too). */
export function isMcpScope(lowercasedPath: string): boolean {
  return lowercasedPath === "/mcp" || lowercasedPath === "/mcp/";
}

/**
 * The bearer an MCP client presented — the Authorization header ONLY (the MCP spec
 * forbids a token in the query string, and an app never sends X-Cairn-Token).
 */
export function authorizationBearer(req: Pick<Request, "get">): string | null {
  const auth = req.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  return m ? m[1] : null;
}

/**
 * The live AI-app connection this /mcp request carries (a per-app key or an OAuth access
 * token minted for exactly this origin's /mcp), or null.
 */
export function mcpBearerClient(req: Request): McpClient | null {
  const token = authorizationBearer(req);
  if (!token) return null;
  const origin = canonicalOrigin(req);
  return mcpClientForBearer(token, origin ? mcpResourceUrl(origin) : "", Date.now());
}

/** The 401 challenge: where the protected-resource metadata lives, and the one scope. */
export function mcpChallenge(origin: string | null, opts: { invalidToken?: boolean } = {}): string {
  const parts: string[] = [];
  if (opts.invalidToken) parts.push(`error="invalid_token"`);
  if (oauthOriginAllowed(origin)) parts.push(`resource_metadata="${protectedResourceMetadataUrl(origin)}"`);
  parts.push(`scope="${MCP_SCOPE}"`);
  return `Bearer ${parts.join(", ")}`;
}

/** Stamp the challenge on a /mcp 401 (the guard's fall-through). */
export function setMcpChallenge(req: Request, res: Response): void {
  // A bare stand-in response (a unit test's guard harness) has no headers to set.
  if (typeof res.setHeader !== "function") return;
  const presented = authorizationBearer(req);
  res.setHeader("WWW-Authenticate", mcpChallenge(canonicalOrigin(req), { invalidToken: !!presented }));
}
