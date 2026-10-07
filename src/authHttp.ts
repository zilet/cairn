// The HTTP mechanics of device sessions and passkeys, kept pure where they can be:
// the session cookie (read + serialize), the same-origin check that guards every
// cookie-authenticated write, the WebAuthn relying-party identity a request implies,
// the single-use challenge store, and the failure limiter in front of the two
// unauthenticated sign-in doors (a pairing code, a passkey assertion).
//
// Nothing here logs. A session secret, a pairing code or a challenge never reaches a
// log line, a telemetry row or an error message.
import type { IncomingHttpHeaders } from "node:http";
import crypto from "node:crypto";
import { SESSION_MAX_AGE_SEC } from "./repo/auth-devices.js";

export const SESSION_COOKIE = "cairn_session";

// ---------- the cookie ----------

/** The raw `cairn_session` value from a Cookie header, or null. */
export function readSessionCookie(header: unknown): string | null {
  if (typeof header !== "string" || !header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

/**
 * The Set-Cookie value for a session: HttpOnly (no script ever reads it), SameSite=Strict
 * (never sent on a cross-site request), Path=/ (the shell, /api, /mcp and the WS
 * upgrade), Secure exactly when the request arrived over HTTPS — a plain-HTTP LAN or
 * localhost install still works — and a 180-day Max-Age the guard slides hourly.
 */
export function sessionCookie(secret: string, opts: { secure: boolean; maxAgeSec?: number }): string {
  const attrs = [
    `${SESSION_COOKIE}=${secret}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec ?? SESSION_MAX_AGE_SEC))}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearedSessionCookie(opts: { secure: boolean }): string {
  return sessionCookie("", { secure: opts.secure, maxAgeSec: 0 });
}

// ---------- same-origin (CSRF defense in depth) ----------

function firstHeader(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "")
    .split(",")[0]
    .trim();
}

/**
 * The hosts a request may legitimately call itself: its Host header, and — only when a
 * proxy hop is trusted (CAIRN_TRUST_PROXY / the platform default) — the X-Forwarded-Host
 * that proxy set. Lowercased, port kept.
 */
export function requestHostCandidates(headers: IncomingHttpHeaders, trustedProxyHops: number): string[] {
  const out = new Set<string>();
  const host = firstHeader(headers.host).toLowerCase();
  if (host) out.add(host);
  if (trustedProxyHops > 0) {
    const forwarded = firstHeader(headers["x-forwarded-host"]).toLowerCase();
    if (forwarded) out.add(forwarded);
  }
  return [...out];
}

/** The origin a request's Origin (or, failing that, Referer) header names, or null. */
export function requestSourceOrigin(headers: IncomingHttpHeaders): URL | null {
  for (const raw of [firstHeader(headers.origin), firstHeader(headers.referer)]) {
    if (!raw || raw === "null") continue;
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") return url;
    } catch {
      /* not a URL: try the next header */
    }
  }
  return null;
}

/** True when Origin/Referer names this very host. A request with neither is refused. */
export function isSameOriginRequest(headers: IncomingHttpHeaders, trustedProxyHops: number): boolean {
  const source = requestSourceOrigin(headers);
  if (!source) return false;
  return requestHostCandidates(headers, trustedProxyHops).includes(source.host.toLowerCase());
}

/**
 * The client address for a request Express never sees (the WebSocket upgrade), derived
 * exactly as Express's numeric `trust proxy` does: with N trusted hops, the Nth address
 * from the RIGHT of X-Forwarded-For (the socket peer counts as hop zero), or the
 * left-most one when the header is shorter; with none trusted, the socket peer alone —
 * a client can never pick its own key by sending the header.
 */
export function clientAddress(
  headers: IncomingHttpHeaders,
  socketAddress: string | null | undefined,
  trustedProxyHops: number
): string {
  const peer = String(socketAddress || "").trim() || "unknown";
  if (!(trustedProxyHops > 0)) return peer;
  const raw = headers["x-forwarded-for"];
  const forwarded = (Array.isArray(raw) ? raw.join(",") : String(raw || ""))
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  // Nearest first: the peer, then X-Forwarded-For right to left.
  const chain = [peer, ...forwarded.reverse()];
  return chain[Math.min(trustedProxyHops, chain.length - 1)];
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(String(method || "").toUpperCase());
}

// ---------- the WebAuthn relying party ----------

export type RelyingParty = { rpID: string; origins: string[] };

/**
 * The RP ID is the hostname the browser is on (Express's req.hostname, which honours
 * X-Forwarded-Host only through the trust-proxy setting); the expected origin is the
 * request's own scheme + host. A same-host Origin header is accepted as well, so a TLS
 * proxy Cairn was not told to trust (http inside, https outside) still verifies.
 */
export function relyingPartyFor(input: {
  hostname: string;
  protocol: string;
  host: string;
  headers: IncomingHttpHeaders;
  trustedProxyHops: number;
}): RelyingParty | null {
  const rpID = String(input.hostname || "").toLowerCase();
  if (!rpID || !/^[a-z0-9.-]+$/.test(rpID)) return null;
  const origins = new Set<string>();
  const host = String(input.host || "").toLowerCase();
  if (host) origins.add(`${input.protocol === "https" ? "https" : "http"}://${host}`);
  const source = requestSourceOrigin(input.headers);
  if (
    source &&
    requestHostCandidates(input.headers, input.trustedProxyHops).concat(host).includes(source.host.toLowerCase())
  ) {
    origins.add(source.origin.toLowerCase());
  }
  return { rpID, origins: [...origins] };
}

// ---------- single-use challenges ----------

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Outstanding challenges one store holds at most (its oldest dropped past that). */
export const MAX_CHALLENGES = 1000;
/** Outstanding sign-in challenges one address holds at most; its OWN oldest goes first. */
export const MAX_LOGIN_CHALLENGES_PER_IP = 5;

export type ChallengeKind = "register" | "login";
type ChallengeEntry = { kind: ChallengeKind; expiresAt: number; deviceId: number | null; rpID: string; ip: string };

/**
 * Single-use WebAuthn challenges. The routes keep TWO stores — sign-in and registration —
 * so traffic on the unauthenticated sign-in door can never evict a registration a
 * signed-in device is halfway through. With `perIpMax` one address holds at most that
 * many outstanding challenges and a new one retires that address's own oldest, so a
 * noisy client churns its own entries, not the owner's.
 */
export class ChallengeStore {
  private entries = new Map<string, ChallengeEntry>();

  constructor(private readonly opts: { max?: number; perIpMax?: number } = {}) {}

  put(
    challenge: string,
    entry: { kind: ChallengeKind; deviceId?: number | null; rpID: string; ip?: string | null },
    now = Date.now()
  ): void {
    this.prune(now);
    const ip = entry.ip || "unknown";
    const perIpMax = this.opts.perIpMax ?? 0;
    if (perIpMax > 0) {
      // Map iteration is insertion order: the first of this address's keys are its oldest.
      const mine: string[] = [];
      for (const [key, e] of this.entries) if (e.ip === ip) mine.push(key);
      for (const key of mine.slice(0, Math.max(0, mine.length - perIpMax + 1))) this.entries.delete(key);
    }
    const max = this.opts.max ?? MAX_CHALLENGES;
    while (this.entries.size >= max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(challenge, {
      kind: entry.kind,
      deviceId: entry.deviceId ?? null,
      rpID: entry.rpID,
      ip,
      expiresAt: now + CHALLENGE_TTL_MS,
    });
  }

  /** Remove and return a live challenge of `kind`; a second take of the same one is null. */
  take(challenge: unknown, kind: ChallengeKind, now = Date.now()): ChallengeEntry | null {
    if (typeof challenge !== "string" || !challenge) return null;
    const entry = this.entries.get(challenge);
    if (!entry) return null;
    this.entries.delete(challenge);
    if (entry.kind !== kind || entry.expiresAt <= now) return null;
    return entry;
  }

  size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}

/** The challenge a WebAuthn response signed, read from its clientDataJSON (base64url). */
export function challengeFromClientData(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== "string" || clientDataJSON.length > 8192) return null;
  try {
    const parsed = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8"));
    return typeof parsed?.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}

// ---------- signed resource links ----------

/** How long a minted ?sig= link opens anything at all. */
export const RESOURCE_LINK_TTL_MS = 2 * 60 * 1000;
/** After its first use a link lives this much longer at most (a PDF viewer's range requests, one reload). */
export const RESOURCE_LINK_GRACE_MS = 30 * 1000;
const MAX_RESOURCE_LINKS = 200;

type ResourceLinkEntry = { target: string; expiresAt: number };

/**
 * A query string in one canonical form, `sig` itself left out: parameters sorted by name
 * (a name's repeated values keep their order) and re-encoded, so `?b=2&a=1` and
 * `?a=1&b=2` are the same link and `?a=1` is not `?a=2`.
 */
export function canonicalLinkQuery(search: string | URLSearchParams): string {
  const params = new URLSearchParams(search);
  params.delete("sig");
  params.sort();
  return params.toString();
}

function linkTarget(path: string, search: string | URLSearchParams = ""): string {
  const query = canonicalLinkQuery(search);
  return query ? `${path}?${query}` : path;
}

/**
 * Short-lived links for URLs a browser opens on its own — a report in a new tab, a file,
 * a download. An installed iOS app opens those in Safari, whose cookie jar is not the
 * app's, so the session cookie never rides along; the link carries `?sig=` instead.
 * Each sig is 32 random bytes, kept only as its SHA-256 in process memory, bound to ONE
 * path AND its exact query (canonicalised, `sig` aside — a link minted for
 * `?name=A` never opens `?name=B`), dead two minutes after minting and thirty seconds
 * after its first use. A restart forgets them all, which only means a link minted a
 * moment earlier asks to be tapped again.
 */
export class ResourceLinkStore {
  private entries = new Map<string, ResourceLinkEntry>();

  mint(path: string, search: string | URLSearchParams = "", now = Date.now()): string {
    this.prune(now);
    while (this.entries.size >= MAX_RESOURCE_LINKS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const sig = crypto.randomBytes(32).toString("base64url");
    this.entries.set(hashSig(sig), { target: linkTarget(path, search), expiresAt: now + RESOURCE_LINK_TTL_MS });
    return sig;
  }

  /** True when `sig` is live for exactly `path` + `search`; its first use starts the short grace. */
  use(sig: unknown, path: string, search: string | URLSearchParams = "", now = Date.now()): boolean {
    if (typeof sig !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
    const key = hashSig(sig);
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return false;
    }
    if (entry.target !== linkTarget(path, search)) return false;
    entry.expiresAt = Math.min(entry.expiresAt, now + RESOURCE_LINK_GRACE_MS);
    return true;
  }

  size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}

function hashSig(sig: string): string {
  return crypto.createHash("sha256").update(sig, "utf8").digest("hex");
}

// ---------- the failure limiter on the unauthenticated doors ----------

export type FailureLimiterOptions = {
  /** Misses from one address inside this window close it. */
  windowMs: number;
  perIpFailures: number;
  /** The longest a repeat offender is closed for (each lockout doubles, up to this). */
  maxLockMs: number;
};

export const PAIRING_LIMITS: FailureLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  perIpFailures: 5,
  maxLockMs: 4 * 60 * 60 * 1000,
};

/** A lockout streak is forgotten after this long without a miss. */
const STRIKE_MEMORY_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_ADDRESSES = 4096;

type FailureEntry = { count: number; resetAt: number; lockedUntil: number; strikes: number; lastFailAt: number };

/**
 * Counts FAILED attempts per address, never successes, and never across addresses:
 * five misses from one address in fifteen minutes close THAT address for fifteen
 * minutes, and each further lockout doubles (up to four hours). There is deliberately
 * no global lock — one would let anyone shut pairing (the first-sign-in code included)
 * for everybody. A distributed guess stays hopeless without one: a code is 8 characters
 * from 31 (≈8.5e11), at most five are live, and each lives ten minutes. The master token
 * and passkeys are unaffected by a lockout.
 */
export class FailureLimiter {
  private perIp = new Map<string, FailureEntry>();

  constructor(private readonly opts: FailureLimiterOptions) {}

  check(ip: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const entry = this.perIp.get(ip || "unknown");
    if (entry && now < entry.lockedUntil) return { allowed: false, retryAfterMs: entry.lockedUntil - now };
    return { allowed: true, retryAfterMs: 0 };
  }

  fail(ip: string, now = Date.now()): void {
    const key = ip || "unknown";
    let entry = this.perIp.get(key);
    if (!entry) {
      entry = { count: 0, resetAt: 0, lockedUntil: 0, strikes: 0, lastFailAt: 0 };
      this.perIp.set(key, entry);
    }
    if (now - entry.lastFailAt > STRIKE_MEMORY_MS) entry.strikes = 0;
    entry.lastFailAt = now;
    if (now >= entry.resetAt) {
      entry.count = 1;
      entry.resetAt = now + this.opts.windowMs;
    } else entry.count += 1;
    if (entry.count >= this.opts.perIpFailures) {
      entry.strikes += 1;
      const lockMs = Math.min(this.opts.windowMs * 2 ** (entry.strikes - 1), this.opts.maxLockMs);
      entry.lockedUntil = now + lockMs;
      entry.count = 0;
      entry.resetAt = 0;
    }
    this.prune(now);
  }

  private prune(now: number): void {
    if (this.perIp.size <= 1024) return;
    for (const [k, v] of this.perIp) {
      if (now >= v.lockedUntil && now >= v.resetAt && now - v.lastFailAt > STRIKE_MEMORY_MS) this.perIp.delete(k);
    }
    // Still flooded (a spray from very many addresses): forget the oldest-seen first.
    for (const k of this.perIp.keys()) {
      if (this.perIp.size <= MAX_TRACKED_ADDRESSES) break;
      this.perIp.delete(k);
    }
  }
}

/** A random WebAuthn-safe challenge (base64url of 32 bytes) — used by tests and as a fallback. */
export function randomChallenge(): string {
  return crypto.randomBytes(32).toString("base64url");
}
