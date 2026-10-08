// Access for a hosted Cairn: per-device browser sessions, one-time pairing codes and
// passkeys. The storage half — src/auth.ts owns the request guard and
// src/routes/auth.ts the endpoints.
//
// What is stored: SHA-256 hashes of every session secret and pairing code (a database
// copy never signs anybody in), a short device label, the passkey's PUBLIC key and its
// counter. Never the master CAIRN_AUTH_TOKEN, never a raw sign-in secret, never a raw
// UA — the token is remembered only as a salted fingerprint, to notice a rotation. (The
// one raw value is the calendar feed token, which signs nobody in — see below.)
//
// Writes here are bookkeeping no request-memoized read consults (no coaching read ever
// looks at an auth table), so the hourly last-seen touch runs through memoNeutralWrite:
// a sign-in landing mid-request does not invalidate the reads a Today open memoized.
import crypto from "node:crypto";
import { db } from "../db.js";
import { memoNeutralWrite } from "./request-memo.js";
import { revokeAllMcpAccess, revokeMcpClientsCreatedByDevices } from "./mcp-clients.js";

export const SESSION_MAX_AGE_SEC = 180 * 24 * 60 * 60;
/** The last-seen stamp (and the cookie's sliding Max-Age) moves at most this often. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const FIRST_SIGN_IN_CODE_TTL_MS = 60 * 60 * 1000;
export const MAX_OUTSTANDING_PAIRING_CODES = 5;
// Eight characters from an alphabet with no 0/O, 1/I/L: unambiguous to read aloud
// or type from another screen. 31^8 ≈ 8.5e11 combinations behind a per-address failure limit.
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type AuthDevice = {
  id: number;
  name: string;
  kind: string;
  created_at: string;
  last_seen_at: string;
  user_agent_summary: string | null;
  revoked_at: string | null;
};

export type AuthPasskey = {
  id: number;
  device_id: number | null;
  /** The device that added it (null under the master token). */
  registered_device_id: number | null;
  /** The device that last signed in with it. */
  last_used_device_id: number | null;
  credential_id: string;
  public_key: string;
  sign_count: number;
  transports: string[];
  name: string;
  created_at: string;
  last_used_at: string | null;
};

function iso(value: number = Date.now()): string {
  return new Date(value).toISOString();
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function newSessionSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** A session secret's plausible shape (43 base64url chars) — anything else never hits the DB. */
export function isSessionSecretShape(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

// ---------- user agent → a calm label ----------

export function describeUserAgent(ua: unknown): { kind: string; summary: string | null } {
  const s = typeof ua === "string" ? ua.slice(0, 512) : "";
  if (!s) return { kind: "unknown", summary: null };
  const platform = /iPhone/.test(s)
    ? "iPhone"
    : /iPad/.test(s)
      ? "iPad"
      : /Android/.test(s)
        ? "Android"
        : /Macintosh|Mac OS X/.test(s)
          ? "Mac"
          : /Windows/.test(s)
            ? "Windows"
            : /CrOS/.test(s)
              ? "Chromebook"
              : /Linux/.test(s)
                ? "Linux"
                : null;
  const browser = /Edg\//.test(s)
    ? "Edge"
    : /Firefox\/|FxiOS/.test(s)
      ? "Firefox"
      : /Chrome\/|CriOS/.test(s)
        ? "Chrome"
        : /Safari\//.test(s)
          ? "Safari"
          : /curl\//i.test(s)
            ? "curl"
            : null;
  const kind =
    platform === "iPhone" || (platform === "Android" && /Mobile/.test(s))
      ? "phone"
      : platform === "iPad" || platform === "Android"
        ? "tablet"
        : platform
          ? "desktop"
          : "unknown";
  const summary = browser && platform ? `${browser} on ${platform}` : browser || platform;
  return { kind, summary };
}

function boundedName(value: unknown, fallback: string): string {
  const text =
    typeof value === "string"
      ? value
          .replace(/\p{Cc}/gu, " ")
          .trim()
          .replace(/\s+/g, " ")
      : "";
  return (text || fallback).slice(0, 60);
}

// ---------- device sessions ----------

function deviceRow(row: any): AuthDevice {
  return {
    id: Number(row.id),
    name: String(row.name),
    kind: String(row.kind || "unknown"),
    created_at: String(row.created_at),
    last_seen_at: String(row.last_seen_at),
    user_agent_summary: row.user_agent_summary == null ? null : String(row.user_agent_summary),
    revoked_at: row.revoked_at == null ? null : String(row.revoked_at),
  };
}

/**
 * A browser's device hint: a random, NON-secret id the client keeps in localStorage
 * (`cairn.device-hint`) and sends with every sign-in, so the same browser signing in
 * again lands on its own device row instead of piling up "Chrome on Mac" twice. It
 * proves nothing — every sign-in still needs the master token, a live pairing code or
 * a passkey — it only says WHICH row a proven sign-in belongs to. Stored hashed.
 */
export function isDeviceHintShape(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

/**
 * Create a device and its session, or — when the same browser signs in again (its
 * device hint and its browser/platform summary both match) and its latest row was never
 * revoked (live, or merely idle past its window) — give that row a fresh secret, so any
 * older secret it held stops working. A REVOKED row is never brought back: a revocation
 * is final, and the browser gets a new row (carrying only the old row's label — a name,
 * never a credential or a passkey binding). Returns the raw secret ONCE (for the cookie).
 */
export function createDeviceSession(
  input: { name?: unknown; userAgent?: unknown; hint?: unknown; now?: number } = {}
): {
  device: AuthDevice;
  secret: string;
  reused: boolean;
} {
  const now = iso(input.now);
  const { kind, summary } = describeUserAgent(input.userAgent);
  const secret = newSessionSecret();
  const hintHash = isDeviceHintShape(input.hint) ? sha256Hex(input.hint) : null;
  let priorName: string | null = null;
  if (hintHash) {
    const prior = db
      .prepare(
        `SELECT id, name, revoked_at FROM auth_devices WHERE hint_hash = ? AND user_agent_summary IS ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(hintHash, summary) as { id?: unknown; name?: unknown; revoked_at?: unknown } | undefined;
    if (prior?.id != null && prior.revoked_at == null) {
      const id = Number(prior.id);
      db.prepare(`UPDATE auth_devices SET session_hash = ?, last_seen_at = ?, kind = ? WHERE id = ?`).run(
        sha256Hex(secret),
        now,
        kind,
        id
      );
      return { device: getDevice(id) as AuthDevice, secret, reused: true };
    }
    if (prior?.id != null && typeof prior.name === "string") priorName = prior.name;
  }
  const name = boundedName(input.name ?? priorName, summary || "This device");
  const info = db
    .prepare(
      `INSERT INTO auth_devices (name, kind, created_at, last_seen_at, user_agent_summary, session_hash, hint_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, kind, now, now, summary, sha256Hex(secret), hintHash);
  return { device: getDevice(Number(info.lastInsertRowid)) as AuthDevice, secret, reused: false };
}

export function getDevice(id: number): AuthDevice | null {
  const row = db.prepare(`SELECT * FROM auth_devices WHERE id = ?`).get(id);
  return row ? deviceRow(row) : null;
}

/**
 * The live device a session secret belongs to, or null (unknown, revoked, or idle past
 * the 180-day window). `touched` is true when the last-seen stamp moved, which is when
 * the caller re-issues the cookie so its Max-Age slides too.
 */
export function deviceForSessionSecret(
  secret: unknown,
  now = Date.now()
): { device: AuthDevice; touched: boolean } | null {
  if (!isSessionSecretShape(secret)) return null;
  const row = db.prepare(`SELECT * FROM auth_devices WHERE session_hash = ?`).get(sha256Hex(secret));
  if (!row) return null;
  const device = deviceRow(row);
  if (device.revoked_at) return null;
  const seen = Date.parse(device.last_seen_at);
  if (!Number.isFinite(seen) || now - seen > SESSION_MAX_AGE_SEC * 1000) return null;
  if (now - seen < SESSION_TOUCH_INTERVAL_MS) return { device, touched: false };
  const stamp = iso(now);
  memoNeutralWrite(() => db.prepare(`UPDATE auth_devices SET last_seen_at = ? WHERE id = ?`).run(stamp, device.id));
  return { device: { ...device, last_seen_at: stamp }, touched: true };
}

export function listDevices(): Array<AuthDevice & { passkeys: number }> {
  const rows = db
    .prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM auth_passkeys p WHERE p.device_id = d.id) AS passkeys
         FROM auth_devices d WHERE d.revoked_at IS NULL ORDER BY d.last_seen_at DESC, d.id DESC`
    )
    .all() as any[];
  return rows.map((row) => ({ ...deviceRow(row), passkeys: Number(row.passkeys) || 0 }));
}

export function renameDevice(id: number, name: unknown): AuthDevice | null {
  const label = boundedName(name, "");
  if (!label) return null;
  const res = db.prepare(`UPDATE auth_devices SET name = ? WHERE id = ? AND revoked_at IS NULL`).run(label, id);
  return Number(res.changes) > 0 ? getDevice(id) : null;
}

/**
 * The passkeys revoking device `id` removes: every passkey that device could still hold —
 * the ones bound to it, the ones it REGISTERED and the ones it LAST SIGNED IN with. A
 * synced passkey (iCloud Keychain, Google Password Manager) lives on every device of
 * that account, so "bound to" alone would leave a lost laptop able to mint a fresh
 * session with a passkey the phone added.
 */
export function passkeysRemovedByRevoking(id: number): AuthPasskey[] {
  return (
    db
      .prepare(
        `SELECT * FROM auth_passkeys
          WHERE device_id = ? OR registered_device_id = ? OR last_used_device_id = ?
          ORDER BY created_at DESC, id DESC`
      )
      .all(id, id, id) as any[]
  ).map(passkeyRow);
}

/**
 * Sign a device out. Revoking ANOTHER device (a lost phone) also removes every passkey
 * it could still hold (passkeysRemovedByRevoking), so nothing left on that device can
 * mint a new session, and disconnects every AI app it connected — the keys it made and
 * the grants it approved (mcpClientsCreatedByDevices): whoever holds the device may hold
 * those too. Signing THIS device out keeps both (`keepPasskeys` + `keepApps`): its
 * passkeys are the way back in, and its apps are not lost with it.
 */
export function revokeDevice(
  id: number,
  opts: { keepPasskeys?: boolean; keepApps?: boolean; now?: number } = {}
): boolean {
  const now = opts.now ?? Date.now();
  const removed = opts.keepPasskeys ? [] : passkeysRemovedByRevoking(id);
  const res = db
    .prepare(`UPDATE auth_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(iso(now), id);
  if (Number(res.changes) === 0) return false;
  for (const passkey of removed) deletePasskey(passkey.id);
  if (!opts.keepApps) revokeMcpClientsCreatedByDevices([id], now);
  return true;
}

export function liveDeviceIdsExcept(keepId: number | null): number[] {
  return (db.prepare(`SELECT id FROM auth_devices WHERE revoked_at IS NULL AND id IS NOT ?`).all(keepId) as any[]).map(
    (row) => Number(row.id)
  );
}

/**
 * The passkeys "Sign out other devices" removes: every passkey not bound to the device
 * asking — including unbound ones (registered under the master token, or left behind by
 * a device that signed itself out) — plus any the other devices registered or last used,
 * even when it is bound here now. With no device asking (the master token), all of them.
 */
export function passkeysRemovedByRevokingOthers(keepId: number | null): AuthPasskey[] {
  const others = new Set(liveDeviceIdsExcept(keepId));
  return listPasskeys().filter(
    (p) =>
      keepId == null ||
      p.device_id !== keepId ||
      (p.registered_device_id != null && others.has(p.registered_device_id)) ||
      (p.last_used_device_id != null && others.has(p.last_used_device_id))
  );
}

/**
 * "Sign out other devices": every live device but `keepId`, every passkey but this
 * device's own, and every AI app one of those devices connected (keys made and grants
 * approved there; apps connected here or under the master token stay).
 */
export function revokeOtherDevices(keepId: number | null, now = Date.now()): number {
  const removed = passkeysRemovedByRevokingOthers(keepId);
  const ids = liveDeviceIdsExcept(keepId);
  for (const id of ids) revokeDevice(id, { now, keepPasskeys: true });
  for (const passkey of removed) deletePasskey(passkey.id);
  return ids.length;
}

export function activeDeviceCount(): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM auth_devices WHERE revoked_at IS NULL`).get() as any)?.n ?? 0);
}

// ---------- pairing codes ----------

/** "abcd-efgh", "ABCD EFGH", "abcdefgh" → "ABCDEFGH"; anything else → null. */
export function normalizePairingCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== 8) return null;
  for (const ch of compact) if (!PAIRING_ALPHABET.includes(ch)) return null;
  return compact;
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

function randomPairingCode(): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  return out;
}

function prunePairingCodes(now: string): void {
  db.prepare(`DELETE FROM auth_pairing_codes WHERE used_at IS NOT NULL OR expires_at <= ?`).run(now);
}

/**
 * Mint a single-use code. At most MAX_OUTSTANDING_PAIRING_CODES stay live: minting
 * past that retires the oldest, so a forgotten code never blocks a new one.
 */
export function createPairingCode(
  input: { createdByDeviceId?: number | null; purpose?: "pair" | "first_sign_in"; ttlMs?: number; now?: number } = {}
): { code: string; expires_at: string } {
  const nowMs = input.now ?? Date.now();
  const now = iso(nowMs);
  prunePairingCodes(now);
  const outstanding = db.prepare(`SELECT id FROM auth_pairing_codes ORDER BY created_at DESC, id DESC`).all() as any[];
  for (const row of outstanding.slice(MAX_OUTSTANDING_PAIRING_CODES - 1)) {
    db.prepare(`DELETE FROM auth_pairing_codes WHERE id = ?`).run(row.id);
  }
  const expiresAt = iso(nowMs + (input.ttlMs ?? PAIRING_CODE_TTL_MS));
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomPairingCode();
    try {
      db.prepare(
        `INSERT INTO auth_pairing_codes (code_hash, purpose, created_at, expires_at, created_by_device_id)
         VALUES (?, ?, ?, ?, ?)`
      ).run(sha256Hex(code), input.purpose || "pair", now, expiresAt, input.createdByDeviceId ?? null);
      return { code: formatPairingCode(code), expires_at: expiresAt };
    } catch {
      /* a hash collision with a live code: draw again */
    }
  }
  throw new Error("could not mint a pairing code");
}

export function outstandingPairingCodeCount(now = Date.now()): number {
  return Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM auth_pairing_codes WHERE used_at IS NULL AND expires_at > ?`)
        .get(iso(now)) as any
    )?.n ?? 0
  );
}

/** Consume a code: true exactly once per live code. Atomic (one UPDATE). */
export function consumePairingCode(value: unknown, now = Date.now()): boolean {
  return consumePairingCodePurpose(value, now) != null;
}

/** Spends a live code and says what it was for (`first_sign_in` or `pair`); null when it was not live. */
export function consumePairingCodePurpose(value: unknown, now = Date.now()): "pair" | "first_sign_in" | null {
  const code = normalizePairingCode(value);
  if (!code) return null;
  const stamp = iso(now);
  const row = db
    .prepare(
      `UPDATE auth_pairing_codes SET used_at = ?
        WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING purpose`
    )
    .get(stamp, sha256Hex(code), stamp) as { purpose?: string } | undefined;
  if (!row) return null;
  return row.purpose === "first_sign_in" ? "first_sign_in" : "pair";
}

// ---------- the first device, with no terminal ----------

const MASTER_USED_KEY = "auth_master_used_at";

/** Remember (once) that the master token has signed something in. Never the token. */
export function recordMasterTokenUse(now = Date.now()): void {
  memoNeutralWrite(() =>
    db
      .prepare(
        `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO NOTHING`
      )
      .run(MASTER_USED_KEY, iso(now))
  );
}

/** True once the master token has ever been used successfully on this database. */
export function masterTokenEverUsed(): boolean {
  return db.prepare(`SELECT 1 FROM app_state WHERE key = ?`).get(MASTER_USED_KEY) != null;
}

/**
 * An install someone has already set up (onboarded) is not a fresh one, even with no
 * device row and no master-token stamp yet: an upgrade from a build that predates both
 * still has its owner, who signs in with the token they already hold.
 */
function installAlreadySetUp(): boolean {
  try {
    const row = db.prepare(`SELECT onboarded FROM settings WHERE id = 1`).get() as { onboarded?: unknown } | undefined;
    return Number(row?.onboarded) === 1;
  } catch {
    return false;
  }
}

/** The one "nobody has ever signed in" condition: the boot's first-sign-in line and the sign-in screen's first-visit help both ask it. */
export function neverSignedIn(): boolean {
  return activeDeviceCount() === 0 && passkeyCount() === 0 && !masterTokenEverUsed() && !installAlreadySetUp();
}

const RAILWAY_ID = /^[0-9a-f-]{36}$/i;

/**
 * What the unauthenticated sign-in screen may be told while the instance has never been
 * signed in: which host this is, where a Railway owner finds the access token, and whether
 * a live first-sign-in code sits in the deploy logs. Never the token, never the code.
 * Null once anyone has signed in (or auth is off).
 */
export function firstVisitHelp(opts: {
  authEnabled: boolean;
  platform: "railway" | "installer" | "docker" | "source";
  env?: NodeJS.ProcessEnv;
  now?: number;
}): {
  platform: "railway" | "installer" | "docker" | null;
  host_settings_url: string | null;
  log_code: boolean;
} | null {
  if (!opts.authEnabled || !neverSignedIn()) return null;
  const env = opts.env ?? process.env;
  let hostSettingsUrl: string | null = null;
  if (opts.platform === "railway") {
    const [p, s, e] = [env.RAILWAY_PROJECT_ID, env.RAILWAY_SERVICE_ID, env.RAILWAY_ENVIRONMENT_ID].map((v) =>
      String(v || "").trim()
    );
    if (RAILWAY_ID.test(p) && RAILWAY_ID.test(s) && RAILWAY_ID.test(e)) {
      hostSettingsUrl = `https://railway.com/project/${p}/service/${s}/variables?environmentId=${e}`;
    }
  }
  const live = db
    .prepare(
      `SELECT 1 AS n FROM auth_pairing_codes WHERE purpose = 'first_sign_in' AND used_at IS NULL AND expires_at > ? LIMIT 1`
    )
    .get(new Date(opts.now ?? Date.now()).toISOString());
  return {
    platform: opts.platform === "source" ? null : opts.platform,
    host_settings_url: hostSettingsUrl,
    log_code: !!live,
  };
}

/**
 * When the server requires a token but nobody has signed in yet — no live device, no
 * passkey, the master token never used successfully, and the install never set up (a
 * one-click host deploy, say) —
 * boot mints a one-hour first-sign-in code and returns the ONE log line that may carry
 * it. That line reaches whatever reads the logs (a host's log viewer, a log drain), which
 * is why it stops for good once anyone has signed in, and why CAIRN_FIRST_SIGNIN_LOG=0
 * turns it off entirely (no code is minted then). Each boot retires the previous boot's
 * unused code.
 */
export function firstSignInNotice(
  opts: { authEnabled: boolean; env?: NodeJS.ProcessEnv; now?: number } = { authEnabled: false }
): string | null {
  if (!opts.authEnabled) return null;
  const env = opts.env ?? process.env;
  if (/^(0|false|no|off)$/i.test(String(env.CAIRN_FIRST_SIGNIN_LOG || "").trim())) return null;
  if (!neverSignedIn()) return null;
  db.prepare(`DELETE FROM auth_pairing_codes WHERE purpose = 'first_sign_in' AND used_at IS NULL`).run();
  const { code } = createPairingCode({ purpose: "first_sign_in", ttlMs: FIRST_SIGN_IN_CODE_TTL_MS, now: opts.now });
  const domain = String(env.RAILWAY_PUBLIC_DOMAIN || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return domain && /^[A-Za-z0-9.-]+(?::\d+)?$/.test(domain)
    ? `First sign-in: open https://${domain}/#pair=${code} (expires in 60 min, works once)`
    : `First sign-in: open your Cairn address followed by #pair=${code} (expires in 60 min, works once)`;
}

// ---------- passkeys ----------

function passkeyRow(row: any): AuthPasskey {
  let transports: string[] = [];
  try {
    const parsed = JSON.parse(String(row.transports || "[]"));
    if (Array.isArray(parsed)) transports = parsed.filter((t) => typeof t === "string").slice(0, 8);
  } catch {}
  return {
    id: Number(row.id),
    device_id: row.device_id == null ? null : Number(row.device_id),
    registered_device_id: row.registered_device_id == null ? null : Number(row.registered_device_id),
    last_used_device_id: row.last_used_device_id == null ? null : Number(row.last_used_device_id),
    credential_id: String(row.credential_id),
    public_key: String(row.public_key),
    sign_count: Number(row.sign_count) || 0,
    transports,
    name: String(row.name),
    created_at: String(row.created_at),
    last_used_at: row.last_used_at == null ? null : String(row.last_used_at),
  };
}

export function passkeyCount(): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM auth_passkeys`).get() as any)?.n ?? 0);
}

export function listPasskeys(): AuthPasskey[] {
  return (db.prepare(`SELECT * FROM auth_passkeys ORDER BY created_at DESC, id DESC`).all() as any[]).map(passkeyRow);
}

export function getPasskeyByCredentialId(credentialId: unknown): AuthPasskey | null {
  if (typeof credentialId !== "string" || !credentialId || credentialId.length > 1024) return null;
  const row = db.prepare(`SELECT * FROM auth_passkeys WHERE credential_id = ?`).get(credentialId);
  return row ? passkeyRow(row) : null;
}

export function addPasskey(input: {
  deviceId: number | null;
  /** The device that added it, when not the one it is bound to (default: deviceId). */
  registeredDeviceId?: number | null;
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports?: string[];
  name?: unknown;
  now?: number;
}): AuthPasskey {
  const info = db
    .prepare(
      `INSERT INTO auth_passkeys
         (device_id, registered_device_id, credential_id, public_key, sign_count, transports, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.deviceId,
      input.registeredDeviceId === undefined ? input.deviceId : input.registeredDeviceId,
      input.credentialId,
      input.publicKey,
      Math.max(0, Math.floor(input.signCount || 0)),
      JSON.stringify((input.transports || []).filter((t) => typeof t === "string").slice(0, 8)),
      boundedName(input.name, "Passkey"),
      iso(input.now)
    );
  return passkeyRow(db.prepare(`SELECT * FROM auth_passkeys WHERE id = ?`).get(Number(info.lastInsertRowid)));
}

/**
 * A passkey signed a browser in: its counter, when, which device it is bound to now
 * (`deviceId`) and which device used it (`usedByDeviceId`, default `deviceId`) — the
 * latter is what lets revoking that device remove the passkey too.
 */
export function recordPasskeyUse(
  id: number,
  input: { signCount: number; deviceId: number; usedByDeviceId?: number; now?: number }
): void {
  db.prepare(
    `UPDATE auth_passkeys SET sign_count = ?, last_used_at = ?, device_id = ?, last_used_device_id = ? WHERE id = ?`
  ).run(
    Math.max(0, Math.floor(input.signCount || 0)),
    iso(input.now),
    input.deviceId,
    input.usedByDeviceId ?? input.deviceId,
    id
  );
}

export function deletePasskey(id: number): boolean {
  return Number(db.prepare(`DELETE FROM auth_passkeys WHERE id = ?`).run(id).changes) > 0;
}

// ---------- the calendar feed ----------

const CALENDAR_FEED_KEY = "auth_calendar_feed_token";

/** A feed token's shape (43 base64url chars) — anything else never hits the DB. */
function isFeedTokenShape(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * The calendar subscription credential. A calendar app polls /api/plan.ics for months
 * with no cookie jar, so it carries `?feed=<token>`: long-lived, opens GET
 * /api/plan.ics and nothing else, and revocable (resetCalendarFeedToken). Unlike a
 * session secret it is kept as-is, so "Subscribe" hands every device the SAME link and
 * a second tap never silently cuts off the first calendar. It unlocks only the
 * training-plan calendar, which any copy of this database already holds in full.
 */
export function calendarFeedToken(): string {
  const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(CALENDAR_FEED_KEY) as any;
  if (isFeedTokenShape(row?.value)) return String(row.value);
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(CALENDAR_FEED_KEY, token);
  return token;
}

/** Retire the calendar link: every subscribed calendar stops updating until re-subscribed. */
export function resetCalendarFeedToken(): void {
  db.prepare(`DELETE FROM app_state WHERE key = ?`).run(CALENDAR_FEED_KEY);
}

/** True when `value` is the live calendar feed token (constant-time compare). */
export function verifyCalendarFeedToken(value: unknown): boolean {
  if (!isFeedTokenShape(value)) return false;
  const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(CALENDAR_FEED_KEY) as any;
  if (!isFeedTokenShape(row?.value)) return false;
  return crypto.timingSafeEqual(Buffer.from(String(row.value)), Buffer.from(value));
}

/** The one stable WebAuthn user handle for this single-person instance. */
export function webauthnUserId(): string {
  const row = db.prepare(`SELECT value FROM app_state WHERE key = 'auth_webauthn_user_id'`).get() as any;
  if (row?.value) return String(row.value);
  const id = crypto.randomBytes(32).toString("base64url");
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES ('auth_webauthn_user_id', ?, datetime('now'))
     ON CONFLICT(key) DO NOTHING`
  ).run(id);
  return String((db.prepare(`SELECT value FROM app_state WHERE key = 'auth_webauthn_user_id'`).get() as any).value);
}

// ---------- the access-token epoch ----------

const TOKEN_FINGERPRINT_KEY = "auth_token_fingerprint";

function tokenFingerprint(salt: string, token: string): string {
  return sha256Hex(`cairn-access-token:${salt}:${token}`);
}

/**
 * Rotating CAIRN_AUTH_TOKEN evicts everyone. The database keeps a salted SHA-256
 * fingerprint of the token it last booted with (`v1:<salt>:<hex>` in app_state — never
 * the token); a boot with a DIFFERENT token revokes every device session and deletes
 * every passkey, live pairing code and the calendar link, since each was minted on the
 * old token's authority, then remembers the new fingerprint. The first boot only stores it.
 */
export function applyAccessTokenEpoch(token: string, now = Date.now()): "first" | "same" | "changed" {
  const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(TOKEN_FINGERPRINT_KEY) as any;
  const stored = /^v1:([A-Za-z0-9_-]{16,64}):([0-9a-f]{64})$/.exec(String(row?.value ?? ""));
  if (stored && crypto.timingSafeEqual(Buffer.from(tokenFingerprint(stored[1], token)), Buffer.from(stored[2]))) {
    return "same";
  }
  const salt = crypto.randomBytes(16).toString("base64url");
  const value = `v1:${salt}:${tokenFingerprint(salt, token)}`;
  const changed = row?.value != null;
  db.exec("BEGIN");
  try {
    if (changed) {
      db.prepare(`UPDATE auth_devices SET revoked_at = ? WHERE revoked_at IS NULL`).run(iso(now));
      db.prepare(`DELETE FROM auth_passkeys`).run();
      db.prepare(`DELETE FROM auth_pairing_codes`).run();
      // The calendar link was handed out under the old token's authority too: retired, so
      // the next Subscribe mints a fresh one. (Apple Health ingest tokens are random,
      // per-connection credentials, not derived from the token; they stand.)
      db.prepare(`DELETE FROM app_state WHERE key = ?`).run(CALENDAR_FEED_KEY);
    }
    db.prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(TOKEN_FINGERPRINT_KEY, value);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // Connected AI apps (MCP keys and OAuth grants) were authorised under the old token too.
  if (changed) revokeAllMcpAccess(now);
  return changed ? "changed" : "first";
}
