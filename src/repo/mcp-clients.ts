// AI apps connected to /mcp: the storage half of "Connect an AI app". src/mcpAccess.ts
// owns the request-side checks and src/routes/oauth.ts + src/routes/mcp-clients.ts the
// endpoints.
//
// Two ways an app holds access, one list (`mcp_clients`):
//   - a per-app KEY made in Settings → Devices (kind 'token'): `cairn_mcp_…`, shown once;
//   - an OAuth GRANT an app signed in for (kind 'oauth'): the Claude app's or ChatGPT's
//     custom connector registers itself (RFC 7591, `oauth_clients`), the owner allows it
//     on the consent page, and the app holds a one-hour access token (`cairn_mat_…`) and
//     a rotating ninety-day refresh token (`cairn_mrt_…`) in `oauth_tokens`.
//
// Every secret here — key, code, access and refresh token — is 32 random bytes stored
// only as its SHA-256 (a database copy opens nothing), and every one of them opens /mcp
// alone, never /api. Nothing here logs. Writes are auth bookkeeping no memoized coaching
// read consults, so the hourly last-used touch runs through memoNeutralWrite (CLAUDE.md
// "A request memo serves only while nothing was written").
import crypto from "node:crypto";
import { db } from "../db.js";
import { memoNeutralWrite } from "./request-memo.js";

export const MCP_TOKEN_PREFIX = "cairn_mcp_";
export const ACCESS_TOKEN_PREFIX = "cairn_mat_";
export const REFRESH_TOKEN_PREFIX = "cairn_mrt_";
export const ACCESS_TOKEN_TTL_SEC = 60 * 60;
export const REFRESH_TOKEN_TTL_SEC = 90 * 24 * 60 * 60;
export const AUTH_CODE_TTL_MS = 60 * 1000;
/** The last-used stamp moves at most this often. */
export const MCP_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
/** At most this many registered OAuth clients exist at once. */
export const MAX_OAUTH_CLIENTS = 50;
/** A registered client that never connected (or stopped) is forgotten after this long. */
export const OAUTH_CLIENT_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_REDIRECT_URIS = 5;
/** A registration this young is never evicted to make room: its owner may be mid-consent. */
export const OAUTH_CLIENT_FRESH_MS = 15 * 60 * 1000;
/**
 * A just-rotated refresh token presented again this soon, by its own client, is a retry or
 * a race — not theft: refused with invalid_grant, and nothing is revoked.
 */
export const REFRESH_REUSE_GRACE_MS = 60 * 1000;
/** The one scope this single-person instance grants: everything /mcp exposes. */
export const MCP_SCOPE = "full";

export type McpClient = {
  id: number;
  name: string;
  kind: "token" | "oauth";
  scopes: string;
  client_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  /** The redirect URI the grant was approved for (OAuth only). */
  redirect_uri: string | null;
  /** The device that made the key or approved the grant; null under the master token. */
  created_by_device_id: number | null;
};

export type OAuthClient = {
  id: string;
  name: string;
  redirect_uris: string[];
  created_at: string;
  last_used_at: string | null;
};

function iso(value: number = Date.now()): string {
  return new Date(value).toISOString();
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function randomSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function tokenShape(prefix: string, value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === prefix.length + 43 &&
    value.startsWith(prefix) &&
    /^[A-Za-z0-9_-]{43}$/.test(value.slice(prefix.length))
  );
}

export function isMcpTokenShape(value: unknown): value is string {
  return tokenShape(MCP_TOKEN_PREFIX, value);
}
export function isAccessTokenShape(value: unknown): value is string {
  return tokenShape(ACCESS_TOKEN_PREFIX, value);
}
export function isRefreshTokenShape(value: unknown): value is string {
  return tokenShape(REFRESH_TOKEN_PREFIX, value);
}

/**
 * A short, printable label: control characters become spaces, format characters (bidi
 * overrides like U+202E, zero-width U+200B/U+200D, a BOM) are dropped so a name can never
 * reorder or hide text on the consent page or in Settings, whitespace is folded, and at
 * most 60 characters remain (never half a surrogate pair). Empty after that → `fallback`.
 */
export function boundedLabel(value: unknown, fallback: string): string {
  const clean = (v: string) =>
    v
      .replace(/\p{Cf}/gu, "")
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  const text = typeof value === "string" ? clean(value) : "";
  return clean(
    Array.from(text || fallback)
      .slice(0, 60)
      .join("")
  );
}

function clientRow(row: any): McpClient {
  return {
    id: Number(row.id),
    name: String(row.name),
    kind: row.kind === "oauth" ? "oauth" : "token",
    scopes: String(row.scopes || MCP_SCOPE),
    client_id: row.client_id == null ? null : String(row.client_id),
    created_at: String(row.created_at),
    last_used_at: row.last_used_at == null ? null : String(row.last_used_at),
    revoked_at: row.revoked_at == null ? null : String(row.revoked_at),
    redirect_uri: row.redirect_uri == null ? null : String(row.redirect_uri),
    created_by_device_id: row.created_by_device_id == null ? null : Number(row.created_by_device_id),
  };
}

export function getMcpClient(id: number): McpClient | null {
  const row = db.prepare(`SELECT * FROM mcp_clients WHERE id = ?`).get(id);
  return row ? clientRow(row) : null;
}

// ---------- per-app keys ----------

/**
 * A new per-app key. The raw key is returned ONCE; only its hash is kept. `deviceId` is the
 * signed-in device that made it (null under the master token): revoking that device from
 * another one disconnects the key too.
 */
export function createMcpTokenClient(input: { name?: unknown; deviceId?: number | null; now?: number } = {}): {
  client: McpClient;
  token: string;
} {
  const token = MCP_TOKEN_PREFIX + randomSecret();
  const info = db
    .prepare(
      `INSERT INTO mcp_clients (name, kind, token_hash, scopes, created_at, created_by_device_id)
       VALUES (?, 'token', ?, ?, ?, ?)`
    )
    .run(boundedLabel(input.name, "AI app"), sha256Hex(token), MCP_SCOPE, iso(input.now), input.deviceId ?? null);
  return { client: getMcpClient(Number(info.lastInsertRowid)) as McpClient, token };
}

// ---------- the list Settings shows ----------

export type McpClientListing = McpClient & { redirect_host: string | null; device_name: string | null };

function hostOf(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri) return null;
  try {
    return new URL(uri).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Where a grant returns the browser to: the redirect URI it was APPROVED for. A grant
 * from before that was recorded falls back to its client's registration only when that
 * named a single URI — with several, the first need not be the one the owner allowed.
 */
function grantRedirectHost(row: any): string | null {
  if (row.redirect_uri) return hostOf(row.redirect_uri);
  try {
    const uris = JSON.parse(String(row.oauth_redirect_uris || "[]"));
    return Array.isArray(uris) && uris.length === 1 ? hostOf(uris[0]) : null;
  } catch {
    return null;
  }
}

/** Every live connection — keys and OAuth grants — most recently used first. */
export function listMcpClients(): McpClientListing[] {
  const rows = db
    .prepare(
      `SELECT m.*, o.redirect_uris AS oauth_redirect_uris, d.name AS device_name
         FROM mcp_clients m
         LEFT JOIN oauth_clients o ON o.id = m.client_id
         LEFT JOIN auth_devices d ON d.id = m.created_by_device_id
        WHERE m.revoked_at IS NULL
        ORDER BY COALESCE(m.last_used_at, m.created_at) DESC, m.id DESC`
    )
    .all() as any[];
  return rows.map((row) => ({
    ...clientRow(row),
    redirect_host: row.kind === "oauth" ? grantRedirectHost(row) : null,
    device_name: row.device_name == null ? null : String(row.device_name),
  }));
}

/** The live connections these devices made or approved: what revoking them from elsewhere disconnects. */
export function mcpClientsCreatedByDevices(deviceIds: number[]): McpClient[] {
  const ids = deviceIds.filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return [];
  return (
    db
      .prepare(
        `SELECT * FROM mcp_clients
          WHERE revoked_at IS NULL AND created_by_device_id IN (${ids.map(() => "?").join(",")})
          ORDER BY created_at DESC, id DESC`
      )
      .all(...ids) as any[]
  ).map(clientRow);
}

/** Disconnect every live connection these devices made or approved. Returns how many. */
export function revokeMcpClientsCreatedByDevices(deviceIds: number[], now = Date.now()): number {
  let n = 0;
  for (const client of mcpClientsCreatedByDevices(deviceIds)) if (revokeMcpClient(client.id, now)) n++;
  return n;
}

/** Revoke one connection: its key stops working, or its grant's tokens all die. */
export function revokeMcpClient(id: number, now = Date.now()): boolean {
  const stamp = iso(now);
  const res = db.prepare(`UPDATE mcp_clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(stamp, id);
  if (Number(res.changes) === 0) return false;
  db.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`).run(stamp, id);
  return true;
}

/**
 * Every AI app loses access at once: every key, every OAuth grant and its tokens, every
 * unspent code. For "the master token changed — sign everyone out" style resets.
 * Registered OAuth clients stay (they are only names and redirect URIs, never access).
 */
export function revokeAllMcpAccess(now = Date.now()): number {
  const stamp = iso(now);
  const res = db.prepare(`UPDATE mcp_clients SET revoked_at = ? WHERE revoked_at IS NULL`).run(stamp);
  db.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE revoked_at IS NULL`).run(stamp);
  db.prepare(`DELETE FROM oauth_codes`).run();
  return Number(res.changes);
}

// ---------- the bearer check ----------

function touch(client: McpClient, now: number): McpClient {
  const last = client.last_used_at ? Date.parse(client.last_used_at) : Number.NaN;
  if (Number.isFinite(last) && now - last < MCP_TOUCH_INTERVAL_MS) return client;
  const stamp = iso(now);
  memoNeutralWrite(() => {
    db.prepare(`UPDATE mcp_clients SET last_used_at = ? WHERE id = ?`).run(stamp, client.id);
    if (client.client_id)
      db.prepare(`UPDATE oauth_clients SET last_used_at = ? WHERE id = ?`).run(stamp, client.client_id);
  });
  return { ...client, last_used_at: stamp };
}

/**
 * The live connection a bearer credential belongs to, or null: a per-app key, or an
 * unexpired OAuth access token whose audience is `resource` (RFC 8707 — a token minted for
 * another address of this Cairn, or any other server, is refused). Looked up by hash, so
 * the comparison never runs over the secret itself.
 */
export function mcpClientForBearer(token: unknown, resource: string, now = Date.now()): McpClient | null {
  if (isMcpTokenShape(token)) {
    const row = db.prepare(`SELECT * FROM mcp_clients WHERE token_hash = ? AND kind = 'token'`).get(sha256Hex(token));
    if (!row) return null;
    const client = clientRow(row);
    return client.revoked_at ? null : touch(client, now);
  }
  if (isAccessTokenShape(token)) {
    const row = db
      .prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'`)
      .get(sha256Hex(token)) as any;
    if (!row || row.revoked_at || Date.parse(String(row.expires_at)) <= now) return null;
    if (!resourcesEqual(String(row.resource), resource)) return null;
    const client = getMcpClient(Number(row.grant_id));
    if (!client || client.revoked_at || client.kind !== "oauth") return null;
    // An access token's FIRST use is stamped (once): it proves the app received that
    // pair, which ends the refresh-reuse grace for the token it replaced.
    if (!row.used_at) {
      const stamp = iso(now);
      memoNeutralWrite(() =>
        db.prepare(`UPDATE oauth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`).run(stamp, row.id)
      );
    }
    return touch(client, now);
  }
  return null;
}

/** RFC 8707 resource comparison: scheme and host case-insensitive, the rest exact. */
export function resourcesEqual(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return (
      x.origin === y.origin &&
      x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "") &&
      !x.search &&
      !y.search
    );
  } catch {
    return false;
  }
}

// ---------- OAuth clients (Dynamic Client Registration) ----------

function oauthClientRow(row: any): OAuthClient {
  let uris: string[] = [];
  try {
    const parsed = JSON.parse(String(row.redirect_uris || "[]"));
    if (Array.isArray(parsed)) uris = parsed.filter((u) => typeof u === "string");
  } catch {}
  return {
    id: String(row.id),
    name: String(row.name),
    redirect_uris: uris,
    created_at: String(row.created_at),
    last_used_at: row.last_used_at == null ? null : String(row.last_used_at),
  };
}

export function getOAuthClient(id: unknown): OAuthClient | null {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
  const row = db.prepare(`SELECT * FROM oauth_clients WHERE id = ?`).get(id);
  return row ? oauthClientRow(row) : null;
}

/** Forget registered clients with no live grant that have sat unused past the idle window. */
export function pruneOAuthClients(now = Date.now()): number {
  const cutoff = iso(now - OAUTH_CLIENT_IDLE_MS);
  const res = db
    .prepare(
      `DELETE FROM oauth_clients
        WHERE COALESCE(last_used_at, created_at) < ?
          AND id NOT IN (SELECT client_id FROM mcp_clients WHERE client_id IS NOT NULL AND revoked_at IS NULL)`
    )
    .run(cutoff);
  return Number(res.changes);
}

export function oauthClientCount(): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM oauth_clients`).get() as any)?.n ?? 0);
}

/**
 * Register a public client (validated redirect URIs come from the route). Returns null
 * when the registry is full even after pruning and nothing may be evicted — a caller
 * answers that with a 429.
 *
 * Full: room is made by forgetting the oldest registration that never connected — but
 * never one registered in the last OAUTH_CLIENT_FRESH_MS, one with an unspent code, or
 * one in `busyClientIds` (a pending authorization the owner may be answering right now),
 * so a registration flood cannot evict an app midway through being allowed. A client
 * with a grant (live or once) is never evicted either.
 */
export function registerOAuthClient(input: {
  name?: unknown;
  redirectUris: string[];
  busyClientIds?: Iterable<string>;
  now?: number;
}): OAuthClient | null {
  const now = input.now ?? Date.now();
  pruneOAuthClients(now);
  if (oauthClientCount() >= MAX_OAUTH_CLIENTS) {
    const busy = [...new Set(input.busyClientIds ?? [])];
    db.prepare(
      `DELETE FROM oauth_clients WHERE id = (
         SELECT id FROM oauth_clients
          WHERE last_used_at IS NULL
            AND created_at < ?
            AND id NOT IN (SELECT client_id FROM mcp_clients WHERE client_id IS NOT NULL)
            AND id NOT IN (SELECT client_id FROM oauth_codes WHERE used_at IS NULL AND expires_at > ?)
            AND id NOT IN (SELECT value FROM json_each(?))
          ORDER BY created_at ASC LIMIT 1)`
    ).run(iso(now - OAUTH_CLIENT_FRESH_MS), iso(now), JSON.stringify(busy));
    if (oauthClientCount() >= MAX_OAUTH_CLIENTS) return null;
  }
  const id = crypto.randomBytes(24).toString("base64url");
  db.prepare(`INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)`).run(
    id,
    boundedLabel(input.name, "AI app"),
    JSON.stringify(input.redirectUris.slice(0, MAX_REDIRECT_URIS)),
    iso(now)
  );
  return getOAuthClient(id);
}

// ---------- authorization codes ----------

/** A single-use, sixty-second code bound to everything the token request must repeat. */
export function createAuthCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  deviceId: number | null;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  // A spent code is kept a day past its expiry so a late replay still finds (and revokes) its grant.
  db.prepare(`DELETE FROM oauth_codes WHERE expires_at <= ?`).run(iso(now - 24 * 60 * 60 * 1000));
  const code = randomSecret();
  db.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, scope, device_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sha256Hex(code),
    input.clientId,
    input.redirectUri,
    input.codeChallenge,
    input.resource,
    MCP_SCOPE,
    input.deviceId,
    iso(now),
    iso(now + AUTH_CODE_TTL_MS)
  );
  return code;
}

export type AuthCodeRow = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  /** The device that answered the consent page. */
  device_id: number | null;
};

/**
 * Spend a code. `ok` exactly once per live code (one atomic UPDATE). A second
 * presentation is `replayed` — the caller revokes whatever the first one minted
 * (OAuth 2.1 §4.1.3) — and anything else is `invalid`.
 */
export function consumeAuthCode(
  code: unknown,
  now = Date.now()
):
  | { status: "ok"; row: AuthCodeRow; codeHash: string }
  | { status: "replayed"; grantId: number | null }
  | { status: "invalid" } {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) return { status: "invalid" };
  const hash = sha256Hex(code);
  const stamp = iso(now);
  const res = db
    .prepare(`UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`)
    .run(stamp, hash, stamp);
  const row = db.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ?`).get(hash) as any;
  if (Number(res.changes) === 1 && row) {
    return {
      status: "ok",
      codeHash: hash,
      row: {
        client_id: String(row.client_id),
        redirect_uri: String(row.redirect_uri),
        code_challenge: String(row.code_challenge),
        resource: String(row.resource),
        scope: String(row.scope),
        device_id: row.device_id == null ? null : Number(row.device_id),
      },
    };
  }
  if (row?.used_at) return { status: "replayed", grantId: row.grant_id == null ? null : Number(row.grant_id) };
  return { status: "invalid" };
}

// ---------- grants and tokens ----------

export type IssuedTokens = { access_token: string; refresh_token: string; expires_in: number; scope: string };

/** Run `fn` in one write transaction (every ROLLBACK through db.exec — see request-memo). */
function inTransaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** A new access + refresh pair; `parentId` is the refresh token whose rotation minted it. */
function issueTokens(grantId: number, resource: string, now: number, parentId: number | null = null): IssuedTokens {
  const access = ACCESS_TOKEN_PREFIX + randomSecret();
  const refresh = REFRESH_TOKEN_PREFIX + randomSecret();
  const insert = db.prepare(
    `INSERT INTO oauth_tokens (grant_id, kind, token_hash, resource, created_at, expires_at, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run(
    grantId,
    "access",
    sha256Hex(access),
    resource,
    iso(now),
    iso(now + ACCESS_TOKEN_TTL_SEC * 1000),
    parentId
  );
  insert.run(
    grantId,
    "refresh",
    sha256Hex(refresh),
    resource,
    iso(now),
    iso(now + REFRESH_TOKEN_TTL_SEC * 1000),
    parentId
  );
  // Expired rows of this family are history nobody reads.
  db.prepare(`DELETE FROM oauth_tokens WHERE grant_id = ? AND expires_at <= ?`).run(grantId, iso(now));
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TOKEN_TTL_SEC, scope: MCP_SCOPE };
}

/**
 * A spent code → a new grant (one live grant per registered client: allowing the same
 * app again replaces its earlier grant rather than listing it twice) and its first tokens.
 * The grant remembers the redirect URI it was approved for and the device that approved
 * it — what Settings shows, and what revoking that device from elsewhere disconnects.
 */
export function grantFromCode(input: { codeHash: string; row: AuthCodeRow; now?: number }): IssuedTokens | null {
  const now = input.now ?? Date.now();
  const client = getOAuthClient(input.row.client_id);
  if (!client) return null;
  return inTransaction(() => {
    const prior = db
      .prepare(`SELECT id FROM mcp_clients WHERE kind = 'oauth' AND client_id = ? AND revoked_at IS NULL`)
      .all(client.id) as any[];
    for (const p of prior) revokeMcpClient(Number(p.id), now);
    const info = db
      .prepare(
        `INSERT INTO mcp_clients
           (name, kind, token_hash, scopes, client_id, created_at, last_used_at, redirect_uri, created_by_device_id)
         VALUES (?, 'oauth', NULL, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        client.name,
        input.row.scope || MCP_SCOPE,
        client.id,
        iso(now),
        iso(now),
        input.row.redirect_uri,
        input.row.device_id
      );
    const grantId = Number(info.lastInsertRowid);
    db.prepare(`UPDATE oauth_codes SET grant_id = ? WHERE code_hash = ?`).run(grantId, input.codeHash);
    db.prepare(`UPDATE oauth_clients SET last_used_at = ? WHERE id = ?`).run(iso(now), client.id);
    return issueTokens(grantId, input.row.resource, now);
  });
}

/**
 * The reuse grace: `row` (an already-rotated refresh token) presented again within
 * REFRESH_REUSE_GRACE_MS of its rotation. That is the app racing itself (two refreshes in
 * flight) or retrying one whose answer it lost — never proof of theft. The answer is a
 * plain invalid_grant that costs nothing: the successor pair the first rotation minted
 * stays live (the app may well be holding it), and the grant stands. Only a reuse later
 * than this is treated as a stolen copy.
 */
function withinReuseGrace(row: any, now: number): boolean {
  const since = now - Date.parse(String(row.used_at));
  return since >= 0 && since <= REFRESH_REUSE_GRACE_MS;
}

/**
 * Rotate a refresh token (OAuth 2.1 §4.3.1, mandatory for public clients). A token that
 * was already rotated and is presented again is a stolen copy — the whole family is
 * revoked (the app signs in again, the thief holds nothing) — except inside the short
 * reuse grace (withinReuseGrace), where the app's own race or retry is refused and nothing
 * is revoked.
 */
export function rotateRefreshToken(input: {
  refreshToken: unknown;
  clientId: unknown;
  resource: string | null;
  now?: number;
}): { ok: true; tokens: IssuedTokens } | { ok: false; error: "invalid_grant"; reused?: boolean } {
  const now = input.now ?? Date.now();
  if (!isRefreshTokenShape(input.refreshToken)) return { ok: false, error: "invalid_grant" };
  const row = db
    .prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`)
    .get(sha256Hex(input.refreshToken)) as any;
  if (!row) return { ok: false, error: "invalid_grant" };
  const grant = getMcpClient(Number(row.grant_id));
  if (!grant || grant.kind !== "oauth" || grant.client_id !== input.clientId)
    return { ok: false, error: "invalid_grant" };
  if (row.used_at) {
    if (withinReuseGrace(row, now)) return { ok: false, error: "invalid_grant" };
    revokeMcpClient(grant.id, now);
    return { ok: false, error: "invalid_grant", reused: true };
  }
  if (grant.revoked_at || row.revoked_at || Date.parse(String(row.expires_at)) <= now) {
    return { ok: false, error: "invalid_grant" };
  }
  if (input.resource && !resourcesEqual(String(row.resource), input.resource))
    return { ok: false, error: "invalid_grant" };
  const stamp = iso(now);
  const tokens = inTransaction(() => {
    const spent = db
      .prepare(`UPDATE oauth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`)
      .run(stamp, row.id);
    if (Number(spent.changes) !== 1) return null;
    // The family's earlier access tokens go with the old refresh token.
    db.prepare(
      `UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND kind = 'access' AND revoked_at IS NULL`
    ).run(stamp, grant.id);
    return issueTokens(grant.id, String(row.resource), now, Number(row.id));
  });
  // Spent between the read and the write: a concurrent refresh of the same token just
  // rotated it, which is the reuse grace by definition — refused, nothing revoked.
  if (!tokens) return { ok: false, error: "invalid_grant" };
  return { ok: true, tokens };
}
