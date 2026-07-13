import type { Request, Response, NextFunction } from "express";
import { db } from "./db.js";

// Server-side idempotency for the PWA's offline outbox. When the network drops,
// the client queues mutating writes and replays them on reconnect with a stable
// client-generated `X-Idempotency-Key`. Without this guard a replayed POST would
// apply the write twice (a duplicate logged set, a re-added food note). Here we
// remember the FIRST 2xx response per key and replay it verbatim on a repeat, so
// a retry is a no-op that returns the original result.
//
// Concurrency: the outbox drain is strictly serial and Cairn is single-user, so
// two requests never race the same key — no locking is needed.

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// A key longer than this is treated as absent (pass-through) rather than stored —
// the real client id is short; an oversized value is not something we replay.
const MAX_KEY_LEN = 120;
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // rows older than this are pruned
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // at most ~once/hour on the insert path

let lastPruneAt = 0;

// Delete rows past the TTL. Deterministic (caller/clock-injectable), no timers.
// created_at is ISO 8601, which sorts lexicographically the same as chronologically.
export function pruneIdempotencyKeys(now: number = Date.now()): number {
  lastPruneAt = now;
  const cutoff = new Date(now - TTL_MS).toISOString();
  const info = db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").run(cutoff);
  return Number(info.changes || 0);
}

function maybePrune(now: number): void {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  try {
    pruneIdempotencyKeys(now);
  } catch {
    /* pruning is bookkeeping — never break the response on a failure */
  }
}

// Prune once at module load so a long-lived process clears stale keys on boot.
try {
  pruneIdempotencyKeys();
} catch {
  /* table always exists (db.ts creates it), but stay failure-safe on boot */
}

export function idempotencyGuard(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (!MUTATING.has(method)) {
    next();
    return;
  }

  const raw = req.get("x-idempotency-key");
  const key = typeof raw === "string" ? raw.trim() : "";
  // No key (or an implausibly long one, treated as absent) is a zero-cost pass-through.
  if (!key || key.length > MAX_KEY_LEN) {
    next();
    return;
  }

  // req.path is mount-relative here (this runs inside the /api router), which is
  // fine: it's stored and matched consistently and still differs per endpoint.
  const path = req.path;

  const existing = db
    .prepare("SELECT method, path, status, response_json FROM idempotency_keys WHERE key = ?")
    .get(key) as
    | { method: string; path: string; status: number; response_json: string }
    | undefined;

  if (existing) {
    if (existing.method === method && existing.path === path) {
      // Genuine replay of the same write → return the stored response verbatim.
      res.setHeader("X-Idempotency-Replayed", "1");
      let body: unknown = null;
      try {
        body = JSON.parse(existing.response_json);
      } catch {
        body = null;
      }
      res.status(existing.status).json(body);
      return;
    }
    // Same key, different method+path: a key collision must never replay the wrong
    // response, so we pass through and let the write re-execute (the conservative
    // failure mode) WITHOUT overwriting the stored row.
    next();
    return;
  }

  // Miss: capture the first JSON body sent and persist it for a later replay — but
  // only for a 2xx status. A failed write wrote nothing, so a retry should genuinely
  // re-execute; caching a 4xx/5xx would wrongly replay the failure.
  const sendJson = res.json.bind(res);
  let captured = false;
  res.json = ((body: unknown) => {
    if (!captured) {
      captured = true;
      const status = res.statusCode || 200;
      if (status >= 200 && status < 300) {
        const now = Date.now();
        maybePrune(now);
        try {
          db.prepare(
            `INSERT OR IGNORE INTO idempotency_keys (key, method, path, status, response_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(key, method, path, status, JSON.stringify(body ?? null), new Date(now).toISOString());
        } catch {
          /* never break the response on a bookkeeping-write failure */
        }
      }
    }
    return sendJson(body);
  }) as typeof res.json;

  next();
}
