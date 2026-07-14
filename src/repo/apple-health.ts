import crypto from "node:crypto";
import { db } from "../db.js";

const PAIRING_PREFIX = "cairn_pair_";
const INGEST_PREFIX = "cairn_ah_";
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CONNECTION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export type AppleHealthConnection = {
  id: number;
  label: string;
  shortcut_version: string | null;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  status: "connected" | "expired" | "revoked";
};

type StoredConnection = Omit<AppleHealthConnection, "status"> & { token_hash: string };

function iso(value: Date | number): string {
  return new Date(value).toISOString();
}

function bounded(value: unknown, fallback: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, max);
}

export function hashAppleHealthSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

function safeHashEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function randomSecret(prefix: string): string {
  return prefix + crypto.randomBytes(32).toString("base64url");
}

function pruneAppleHealthPairings(now: string): void {
  // Pairing rows are transient authorization challenges, not an audit log. Once
  // used or expired they no longer serve the owner or the Shortcut, so remove
  // them on the next mint and keep repeated pairing attempts from growing the DB.
  db.prepare(`DELETE FROM apple_health_pairings WHERE used_at IS NOT NULL OR expires_at <= ?`).run(now);
}

function statusFor(row: Omit<AppleHealthConnection, "status">, nowMs = Date.now()): AppleHealthConnection["status"] {
  if (row.revoked_at) return "revoked";
  if (Date.parse(row.expires_at) <= nowMs) return "expired";
  return "connected";
}

function publicConnection(row: StoredConnection, nowMs = Date.now()): AppleHealthConnection {
  const { token_hash: _secret, ...safe } = row;
  return { ...safe, status: statusFor(safe, nowMs) };
}

export function createAppleHealthPairing(
  input: { label?: unknown; shortcut_version?: unknown; now_ms?: number; ttl_ms?: number } = {}
) {
  const nowMs = input.now_ms ?? Date.now();
  const ttlMs = Math.max(60_000, Math.min(input.ttl_ms ?? DEFAULT_PAIRING_TTL_MS, 60 * 60 * 1000));
  const code = randomSecret(PAIRING_PREFIX);
  const createdAt = iso(nowMs);
  const expiresAt = iso(nowMs + ttlMs);
  pruneAppleHealthPairings(createdAt);
  const label = bounded(input.label, "Apple Health Shortcut", 80);
  const shortcutVersion = bounded(input.shortcut_version, "", 40) || null;
  const result = db
    .prepare(
      `INSERT INTO apple_health_pairings
       (code_hash, label, shortcut_version, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
    )
    .run(hashAppleHealthSecret(code), label, shortcutVersion, createdAt, expiresAt);
  return {
    id: Number(result.lastInsertRowid),
    code,
    label,
    shortcut_version: shortcutVersion,
    created_at: createdAt,
    expires_at: expiresAt,
  };
}

export function exchangeAppleHealthPairing(
  code: unknown,
  input: {
    label?: unknown;
    shortcut_version?: unknown;
    now_ms?: number;
    connection_ttl_ms?: number;
  } = {}
): { connection: AppleHealthConnection; ingest_token: string } | null {
  if (typeof code !== "string" || !code.startsWith(PAIRING_PREFIX) || code.length > 160) return null;
  const nowMs = input.now_ms ?? Date.now();
  const now = iso(nowMs);
  const codeHash = hashAppleHealthSecret(code);
  const pairing = db
    .prepare(
      `SELECT id,code_hash,label,shortcut_version,expires_at,used_at
       FROM apple_health_pairings WHERE code_hash = ?`
    )
    .get(codeHash) as any;
  if (
    !pairing ||
    !safeHashEqual(codeHash, String(pairing.code_hash)) ||
    pairing.used_at ||
    Date.parse(pairing.expires_at) <= nowMs
  )
    return null;

  const ttlMs = Math.max(
    24 * 60 * 60 * 1000,
    Math.min(input.connection_ttl_ms ?? DEFAULT_CONNECTION_TTL_MS, DEFAULT_CONNECTION_TTL_MS)
  );
  const token = randomSecret(INGEST_PREFIX);
  const tokenHash = hashAppleHealthSecret(token);
  const label = bounded(input.label, pairing.label || "Apple Health Shortcut", 80);
  const version = bounded(input.shortcut_version, pairing.shortcut_version || "", 40) || null;
  let insertedId = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    const claimed = db
      .prepare(
        `UPDATE apple_health_pairings SET used_at = ?
       WHERE id = ? AND used_at IS NULL AND expires_at > ?`
      )
      .run(now, pairing.id, now);
    if (Number(claimed.changes) !== 1) {
      db.exec("ROLLBACK");
      return null;
    }
    const inserted = db
      .prepare(
        `INSERT INTO apple_health_connections
         (label, shortcut_version, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(label, version, tokenHash, now, iso(nowMs + ttlMs));
    insertedId = Number(inserted.lastInsertRowid);
    db.prepare(`UPDATE apple_health_pairings SET connection_id = ? WHERE id = ?`).run(insertedId, pairing.id);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  const row = db.prepare(`SELECT * FROM apple_health_connections WHERE id = ?`).get(insertedId) as StoredConnection;
  return { connection: publicConnection(row, nowMs), ingest_token: token };
}

export function verifyAppleHealthIngestToken(token: unknown, nowMs = Date.now()): AppleHealthConnection | null {
  if (typeof token !== "string" || !token.startsWith(INGEST_PREFIX) || token.length > 160) return null;
  const tokenHash = hashAppleHealthSecret(token);
  const row = db.prepare(`SELECT * FROM apple_health_connections WHERE token_hash = ?`).get(tokenHash) as
    | StoredConnection
    | undefined;
  if (!row || !safeHashEqual(tokenHash, row.token_hash)) return null;
  const connection = publicConnection(row, nowMs);
  return connection.status === "connected" ? connection : null;
}

export function listAppleHealthConnections(nowMs = Date.now()): AppleHealthConnection[] {
  const rows = db.prepare(`SELECT * FROM apple_health_connections ORDER BY id DESC`).all() as StoredConnection[];
  return rows.map((row) => publicConnection(row, nowMs));
}

export function revokeAppleHealthConnection(id: number, nowMs = Date.now()): boolean {
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const result = db
    .prepare(`UPDATE apple_health_connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(iso(nowMs), id);
  return Number(result.changes) === 1;
}

export function markAppleHealthConnectionUsed(id: number, nowMs = Date.now()): boolean {
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const now = iso(nowMs);
  const result = db
    .prepare(
      `UPDATE apple_health_connections SET last_used_at = ?
     WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`
    )
    .run(now, id, now);
  return Number(result.changes) === 1;
}
