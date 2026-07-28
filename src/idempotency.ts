import type { Request, Response, NextFunction } from "express";
import { db } from "./db.js";

// Server-side idempotency for the PWA's offline outbox. When the network drops,
// the client queues mutating writes and replays them on reconnect with a stable
// client-generated `X-Idempotency-Key`. Without this guard a replayed POST would
// apply the write twice (a duplicate logged set, a re-added food note). Here we
// remember the FIRST 2xx response per key and replay it verbatim on a repeat, so
// a retry is a no-op that returns the original result.
//
// A browser retry can overlap the original request after losing its response.
// In-process ownership is therefore claimed synchronously before the route runs:
// an exact waiter replays the owner's stored result, or takes ownership if the
// owner did not complete with a cacheable success.

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// A key longer than this is treated as absent (pass-through) rather than stored —
// the real client id is short; an oversized value is not something we replay.
const MAX_KEY_LEN = 120;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REPLAY_UNAVAILABLE_STATUS = 409;
const REPLAY_UNAVAILABLE_BODY = Object.freeze({
  ok: false,
  code: "idempotency_response_unavailable",
  error: "The original mutation succeeded, but its response was too large to replay. Refresh before retrying.",
});
const REPLAY_UNAVAILABLE_JSON = JSON.stringify(REPLAY_UNAVAILABLE_BODY);

export const IDEMPOTENCY_LIMITS = Object.freeze({
  max_key_length: MAX_KEY_LEN,
  max_response_bytes: MAX_RESPONSE_BYTES,
});

type StoredResponse = { method: string; path: string; status: number; response_json: string };
type InFlight = {
  method: string;
  path: string;
  done: Promise<void>;
  resolve: () => void;
};

const inFlight = new Map<string, InFlight>();

function trackedOutboxRoute(method: string, path: string): boolean {
  if (
    method === "POST" &&
    [
      "/sets",
      "/activities",
      "/bodyweight",
      "/food-notes",
      "/daily-session/prepare",
      "/training-symptoms/observation",
    ].includes(path)
  ) {
    return true;
  }
  if ((method === "POST" || method === "DELETE") && path === "/sessions/skip") return true;
  return method === "POST" && /^\/sessions\/[1-9]\d*\/finish$/.test(path);
}

function storedResponse(key: string): StoredResponse | undefined {
  return db.prepare("SELECT method, path, status, response_json FROM idempotency_keys WHERE key = ?").get(key) as
    | StoredResponse
    | undefined;
}

function conflict(res: Response): void {
  res.status(409).json({
    ok: false,
    code: "idempotency_key_conflict",
    error: "This idempotency key is already bound to a different operation.",
  });
}

function replay(res: Response, existing: StoredResponse): void {
  res.setHeader("X-Idempotency-Replayed", "1");
  let body: unknown = null;
  try {
    body = JSON.parse(existing.response_json);
  } catch {
    body = null;
  }
  res.status(existing.status).json(body);
}

function boundedStoredResponse(status: number, body: unknown): { status: number; responseJson: string } {
  try {
    const responseJson = JSON.stringify(body ?? null);
    if (Buffer.byteLength(responseJson, "utf8") <= MAX_RESPONSE_BYTES) return { status, responseJson };
  } catch {
    // A successful but unserializable response still needs a durable replay stop.
  }
  return { status: REPLAY_UNAVAILABLE_STATUS, responseJson: REPLAY_UNAVAILABLE_JSON };
}

// Harden rows written by an older build before the response limit existed. They
// still block a replayed mutation, but expose only the bounded recovery marker.
try {
  db.prepare(
    `UPDATE idempotency_keys
     SET status = ?, response_json = ?
     WHERE length(CAST(response_json AS BLOB)) > ?`
  ).run(REPLAY_UNAVAILABLE_STATUS, REPLAY_UNAVAILABLE_JSON, MAX_RESPONSE_BYTES);
} catch {
  /* table is created by db.ts; stay failure-safe if startup storage is unavailable */
}

function responseEnded(res: Response): boolean {
  const state = res as Response & { destroyed?: boolean; writableEnded?: boolean };
  return state.destroyed === true || state.writableEnded === true;
}

function dispatchKeyed(key: string, method: string, path: string, res: Response, next: NextFunction): void {
  const existing = storedResponse(key);
  if (existing) {
    if (existing.method === method && existing.path === path) replay(res, existing);
    else conflict(res);
    return;
  }

  const current = inFlight.get(key);
  if (current) {
    if (current.method !== method || current.path !== path) {
      conflict(res);
      return;
    }
    void current.done.then(() => {
      if (!responseEnded(res)) dispatchKeyed(key, method, path, res, next);
    });
    return;
  }

  let settle!: () => void;
  const owner: InFlight = {
    method,
    path,
    done: new Promise<void>((resolve) => {
      settle = resolve;
    }),
    resolve: () => settle(),
  };
  // JavaScript runs this section atomically: ownership exists before next() can
  // enter an async handler or another request can inspect this key.
  inFlight.set(key, owner);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (inFlight.get(key) === owner) inFlight.delete(key);
    owner.resolve();
  };
  res.once("finish", release);
  res.once("close", release);
  res.once("error", release);

  // Capture the first JSON body, persisting only a bounded representation of a
  // successful response. Oversized/unserializable bodies become a stable 409
  // replay marker: the first caller still receives its real successful body,
  // while later retries are stopped rather than applying the mutation again.
  const sendJson = res.json.bind(res);
  let captured = false;
  res.json = ((body: unknown) => {
    try {
      if (!captured) {
        captured = true;
        const status = res.statusCode || 200;
        if (status >= 200 && status < 300) {
          const stored = boundedStoredResponse(status, body);
          const now = Date.now();
          try {
            db.prepare(
              `INSERT OR IGNORE INTO idempotency_keys (key, method, path, status, response_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`
            ).run(key, method, path, stored.status, stored.responseJson, new Date(now).toISOString());
          } catch {
            /* never break the response on a bookkeeping-write failure */
          }
        }
      }
    } finally {
      release();
    }
    return sendJson(body);
  }) as typeof res.json;

  try {
    next();
  } catch (error) {
    release();
    throw error;
  }
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
  if (!trackedOutboxRoute(method, path)) {
    next();
    return;
  }
  dispatchKeyed(key, method, path, res, next);
}
