import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { PROVIDER_UNAVAILABLE_MIN_BACKOFF_MS, ProviderUnavailableError } from "../provider-unavailable.js";

export type SchedulerOperationStatus = "pending" | "running" | "retry_wait" | "succeeded" | "no_op" | "exhausted";

export interface SchedulerOperation {
  operation: string;
  slot_stamp: string;
  status: SchedulerOperationStatus;
  attempts: number;
  claim_token: string | null;
  lease_expires_at: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SchedulerOperationClaim extends SchedulerOperation {
  status: "running";
  claim_token: string;
}

export interface SchedulerTaskCompletion<T = unknown> {
  outcome: "succeeded" | "no_op";
  value?: T;
}

export interface SchedulerRunResult<T = unknown> {
  attempted: boolean;
  status: SchedulerOperationStatus;
  operation: SchedulerOperation;
  value?: T;
  error: string | null;
  /**
   * The ERROR OBJECT the task threw, alongside the sanitized `last_error` line.
   *
   * `last_error` is a redacted string, so a caller that wanted to REPORT the failure had
   * to re-wrap it in a fresh `new Error(...)` — which discarded the class and left
   * telemetry naming every scheduled failure "Error", provider exhaustion included.
   * Present only on the attempt that actually failed; a row read back from an earlier
   * attempt still carries `last_error` and no cause.
   */
  cause?: unknown;
}

export interface SchedulerClaimResult {
  claim: SchedulerOperationClaim | null;
  operation: SchedulerOperation;
  terminalized_expired_lease: boolean;
}

const DEFAULT_LEASE_MS = 20 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = [15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000, 12 * 60 * 60 * 1000];

function cleanKey(value: unknown, fallback: string): string {
  const withoutControls = Array.from(String(value ?? ""), (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  }).join("");
  const clean = withoutControls.replace(/\s+/g, " ").trim().slice(0, 120);
  return clean || fallback;
}

// Persist only a bounded single line and redact the common credential shapes.
// Scheduler diagnostics need the failure class, never raw provider output,
// filesystem dumps, authorization headers, or query-string secrets.
export function sanitizeSchedulerError(error: unknown): string {
  let text: string;
  if (error instanceof Error) text = error.message;
  else if (typeof error === "string") text = error;
  else {
    try {
      text = JSON.stringify(error);
    } catch {
      text = "scheduler operation failed";
    }
  }
  return String(text || "scheduler operation failed")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|api[_-]?key|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\/(?:Users|home)\/[^/\s]+\/[^\s,;]*/g, "[path]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\[^\s,;]*/g, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function rowToOperation(row: any): SchedulerOperation {
  return {
    operation: String(row.operation),
    slot_stamp: String(row.slot_stamp),
    status: row.status as SchedulerOperationStatus,
    attempts: Math.max(0, Math.trunc(Number(row.attempts) || 0)),
    claim_token: row.claim_token == null ? null : String(row.claim_token),
    lease_expires_at: row.lease_expires_at == null ? null : String(row.lease_expires_at),
    next_retry_at: row.next_retry_at == null ? null : String(row.next_retry_at),
    last_error: row.last_error == null ? null : String(row.last_error),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
  };
}

export function getSchedulerOperation(operation: string, slotStamp: string): SchedulerOperation | null {
  const row = db
    .prepare(`SELECT * FROM scheduler_operations WHERE operation = ? AND slot_stamp = ?`)
    .get(cleanKey(operation, "unknown"), cleanKey(slotStamp, "unknown"));
  return row ? rowToOperation(row) : null;
}

function ensureSchedulerOperation(operation: string, slotStamp: string): SchedulerOperation {
  const op = cleanKey(operation, "unknown");
  const slot = cleanKey(slotStamp, "unknown");
  db.prepare(
    `INSERT OR IGNORE INTO scheduler_operations (operation, slot_stamp, status)
     VALUES (?, ?, 'pending')`
  ).run(op, slot);
  return getSchedulerOperation(op, slot)!;
}

// A database with no scheduler_operations rows has never run a scheduler at
// all — the signal startScheduler uses to tell a fresh install (owes no
// catch-up) from an upgraded one (a missed slot should catch up).
export function hasSchedulerHistory(): boolean {
  return db.prepare(`SELECT 1 FROM scheduler_operations LIMIT 1`).get() !== undefined;
}

function isoMs(value: string | null): number | null {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function schedulerOperationDue(operation: string, slotStamp: string, now = new Date()): boolean {
  const row = ensureSchedulerOperation(operation, slotStamp);
  if (row.status === "succeeded" || row.status === "no_op" || row.status === "exhausted") return false;
  const current = now.getTime();
  if (row.status === "running") {
    const lease = isoMs(row.lease_expires_at);
    return lease == null || lease <= current;
  }
  if (row.status === "retry_wait") {
    const next = isoMs(row.next_retry_at);
    return next == null || next <= current;
  }
  return true;
}

export function claimSchedulerOperation(
  operation: string,
  slotStamp: string,
  opts: { now?: Date; leaseMs?: number; maxAttempts?: number } = {}
): SchedulerOperationClaim | null {
  const op = cleanKey(operation, "unknown");
  const slot = cleanKey(slotStamp, "unknown");
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseMs = Math.max(1_000, Math.trunc(Number(opts.leaseMs) || DEFAULT_LEASE_MS));
  const maxAttempts = Math.max(1, Math.trunc(Number(opts.maxAttempts) || DEFAULT_MAX_ATTEMPTS));
  const token = randomUUID();

  db.exec("SAVEPOINT scheduler_operation_claim");
  try {
    ensureSchedulerOperation(op, slot);
    const existing = getSchedulerOperation(op, slot)!;
    const leaseExpired =
      existing.status === "running" &&
      (isoMs(existing.lease_expires_at) == null || isoMs(existing.lease_expires_at)! <= now.getTime());

    if (leaseExpired && existing.attempts >= maxAttempts) {
      db.prepare(
        `UPDATE scheduler_operations
            SET status = 'exhausted', claim_token = NULL, lease_expires_at = NULL,
                next_retry_at = NULL,
                last_error = COALESCE(last_error, 'Previous scheduler lease expired before completion.'),
                completed_at = ?, updated_at = ?
          WHERE operation = ? AND slot_stamp = ? AND status = 'running'`
      ).run(nowIso, nowIso, op, slot);
      db.exec("RELEASE scheduler_operation_claim");
      return null;
    }

    const updated = db
      .prepare(
        `UPDATE scheduler_operations
          SET status = 'running', attempts = attempts + 1, claim_token = ?,
              lease_expires_at = ?, next_retry_at = NULL,
              last_error = CASE
                WHEN status = 'running' THEN COALESCE(last_error, 'Previous scheduler lease expired before completion.')
                ELSE last_error
              END,
              updated_at = ?, completed_at = NULL
        WHERE operation = ? AND slot_stamp = ?
          AND attempts < ?
          AND (
            status = 'pending'
            OR (status = 'retry_wait' AND (next_retry_at IS NULL OR next_retry_at <= ?))
            OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
          )`
      )
      .run(token, new Date(now.getTime() + leaseMs).toISOString(), nowIso, op, slot, maxAttempts, nowIso, nowIso);
    const claimed = Number(updated.changes) === 1 ? getSchedulerOperation(op, slot) : null;
    db.exec("RELEASE scheduler_operation_claim");
    return claimed?.status === "running" && claimed.claim_token === token ? (claimed as SchedulerOperationClaim) : null;
  } catch (error) {
    db.exec("ROLLBACK TO scheduler_operation_claim");
    db.exec("RELEASE scheduler_operation_claim");
    throw error;
  }
}

export function claimSchedulerOperationWithStatus(
  operation: string,
  slotStamp: string,
  opts: { now?: Date; leaseMs?: number; maxAttempts?: number } = {}
): SchedulerClaimResult {
  const before = getSchedulerOperation(operation, slotStamp);
  const claim = claimSchedulerOperation(operation, slotStamp, opts);
  const row = getSchedulerOperation(operation, slotStamp)!;
  return {
    claim,
    operation: row,
    terminalized_expired_lease: before?.status === "running" && row.status === "exhausted",
  };
}

export function completeSchedulerOperation(
  claim: Pick<SchedulerOperationClaim, "operation" | "slot_stamp" | "claim_token">,
  outcome: "succeeded" | "no_op",
  now = new Date()
): SchedulerOperation | null {
  const nowIso = now.toISOString();
  const changed = db
    .prepare(
      `UPDATE scheduler_operations
        SET status = ?, claim_token = NULL, lease_expires_at = NULL,
            next_retry_at = NULL, last_error = NULL,
            completed_at = ?, updated_at = ?
      WHERE operation = ? AND slot_stamp = ? AND status = 'running' AND claim_token = ?`
    )
    .run(outcome, nowIso, nowIso, claim.operation, claim.slot_stamp, claim.claim_token);
  return Number(changed.changes) === 1 ? getSchedulerOperation(claim.operation, claim.slot_stamp) : null;
}

// A separately owned operation can fulfill the same logical slot (currently the
// protective meal-refresh owner superseding the ordinary weekly refresh). This
// terminal write clears the prior claim token, fencing any stale worker from
// completing after the substitute effect has landed. A previously succeeded
// row remains succeeded; every other state settles as an explicit calm no-op.
export function supersedeSchedulerOperation(
  operation: string,
  slotStamp: string,
  now = new Date()
): SchedulerOperation {
  const op = cleanKey(operation, "unknown");
  const slot = cleanKey(slotStamp, "unknown");
  const nowIso = now.toISOString();
  db.exec("SAVEPOINT scheduler_operation_supersede");
  try {
    ensureSchedulerOperation(op, slot);
    db.prepare(
      `UPDATE scheduler_operations
          SET status = 'no_op', claim_token = NULL, lease_expires_at = NULL,
              next_retry_at = NULL, last_error = NULL,
              completed_at = ?, updated_at = ?
        WHERE operation = ? AND slot_stamp = ? AND status != 'succeeded'`
    ).run(nowIso, nowIso, op, slot);
    const row = getSchedulerOperation(op, slot)!;
    db.exec("RELEASE scheduler_operation_supersede");
    return row;
  } catch (error) {
    db.exec("ROLLBACK TO scheduler_operation_supersede");
    db.exec("RELEASE scheduler_operation_supersede");
    throw error;
  }
}

export function failSchedulerOperation(
  claim: Pick<SchedulerOperationClaim, "operation" | "slot_stamp" | "claim_token" | "attempts">,
  error: unknown,
  opts: { now?: Date; maxAttempts?: number; backoffMs?: number[] } = {}
): SchedulerOperation | null {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const maxAttempts = Math.max(1, Math.trunc(Number(opts.maxAttempts) || DEFAULT_MAX_ATTEMPTS));
  const schedule = opts.backoffMs?.length ? opts.backoffMs : DEFAULT_BACKOFF_MS;
  const exhausted = claim.attempts >= maxAttempts;
  const delay = Math.max(1_000, Number(schedule[Math.min(schedule.length - 1, Math.max(0, claim.attempts - 1))]) || 0);
  const changed = db
    .prepare(
      `UPDATE scheduler_operations
        SET status = ?, claim_token = NULL, lease_expires_at = NULL,
            next_retry_at = ?, last_error = ?, completed_at = ?, updated_at = ?
      WHERE operation = ? AND slot_stamp = ? AND status = 'running' AND claim_token = ?`
    )
    .run(
      exhausted ? "exhausted" : "retry_wait",
      exhausted ? null : new Date(now.getTime() + delay).toISOString(),
      sanitizeSchedulerError(error),
      exhausted ? nowIso : null,
      nowIso,
      claim.operation,
      claim.slot_stamp,
      claim.claim_token
    );
  return Number(changed.changes) === 1 ? getSchedulerOperation(claim.operation, claim.slot_stamp) : null;
}

export async function runSchedulerOperation<T>(
  operation: string,
  slotStamp: string,
  task: () => Promise<SchedulerTaskCompletion<T>> | SchedulerTaskCompletion<T>,
  opts: { now?: Date; leaseMs?: number; maxAttempts?: number; backoffMs?: number[] } = {}
): Promise<SchedulerRunResult<T>> {
  const claimResult = claimSchedulerOperationWithStatus(operation, slotStamp, opts);
  const claim = claimResult.claim;
  if (!claim) {
    const row = claimResult.operation;
    // An expired final lease terminalizes exactly once inside claim(). Surface
    // that transition as this call's result/diagnostic signal; later polls see an
    // already-exhausted row and stay quiet.
    return {
      attempted: claimResult.terminalized_expired_lease,
      status: row.status,
      operation: row,
      error: row.last_error,
    };
  }
  try {
    const result = await task();
    if (result?.outcome !== "succeeded" && result?.outcome !== "no_op") {
      throw new Error("Scheduler task returned no explicit completion outcome.");
    }
    const completed = completeSchedulerOperation(claim, result.outcome);
    if (!completed) {
      const current = getSchedulerOperation(operation, slotStamp)!;
      return { attempted: true, status: current.status, operation: current, error: current.last_error };
    }
    return {
      attempted: true,
      status: completed.status,
      operation: completed,
      value: result.value,
      error: null,
    };
  } catch (error) {
    // A PROVIDER OUTAGE IS WAITED OUT, NOT HAMMERED. The ordinary ladder retries in
    // fifteen minutes, which is the right answer for a transient fault and the wrong one
    // for a weekly usage limit: five attempts inside a day, five identical rows, and the
    // provider no closer to being available. When the ladder is on its defaults, a typed
    // provider-unavailable failure waits hours instead — at least PROVIDER_UNAVAILABLE_
    // MIN_BACKOFF_MS, and longer when a provider itself said when it resets. A caller
    // that passed its own backoff schedule (the tests do) keeps it exactly.
    const providerBackoff =
      error instanceof ProviderUnavailableError && !opts.backoffMs?.length
        ? [Math.max(PROVIDER_UNAVAILABLE_MIN_BACKOFF_MS, error.retryAfterMs ?? 0)]
        : undefined;
    const failed =
      failSchedulerOperation(claim, error, providerBackoff ? { ...opts, backoffMs: providerBackoff } : opts) ??
      getSchedulerOperation(operation, slotStamp)!;
    return {
      attempted: true,
      status: failed.status,
      operation: failed,
      error: failed.last_error,
      cause: error,
    };
  }
}
