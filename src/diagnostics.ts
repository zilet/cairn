import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getBuildStamp } from "./build-info.js";
import type { ProviderUnavailableError } from "./provider-unavailable.js";
import { recordDiagnosticEvent } from "./repo/diagnostics.js";
import { normalizeServerApiRouteTemplate, recordRequestMetric } from "./repo/request-metrics.js";
import {
  genericFailureMessage,
  telemetryErrorName,
  telemetryIdentifier,
  telemetryRequestPathLabel,
  telemetryStackFrames,
} from "./telemetry-privacy.js";

const DEFAULT_SLOW_REQUEST_MS = 2_000;
const INTERNAL_TELEMETRY_ROUTES = new Set([
  "/api/health", "/api/ready", "/api/diagnostics", "/api/agent-stats",
  "/api/brain-diagnostics", "/api/art/stats", "/api/telemetry/client",
]);
const requestIds = new WeakMap<Request, string>();
const unexpectedErrorRequests = new WeakSet<Request>();

export function requestId(req: Request): string {
  return requestIds.get(req) || "";
}

/** Error names are useful operator context; arbitrary Error.message is not. */
export function diagnosticErrorName(error: unknown): string {
  return telemetryErrorName(error);
}

/** V8's first stack line repeats Error.message, so retain frames only. */
function diagnosticStackFrames(error: unknown): string | null {
  return telemetryStackFrames(error);
}

export function matchedApiRoute(req: Pick<Request, "baseUrl" | "route">): string {
  const routePath = typeof req.route?.path === "string" ? req.route.path : null;
  if (!routePath) return "/api/unknown";
  const base = typeof req.baseUrl === "string" && req.baseUrl.startsWith("/api") ? req.baseUrl : "/api";
  return normalizeServerApiRouteTemplate(`${base.replace(/\/$/, "")}/${routePath.replace(/^\//, "")}`);
}

function requestRoute(req: Request): string {
  return matchedApiRoute(req);
}

export function isOrdinaryProductRequest(res: Pick<Response, "getHeader">, route: string): boolean {
  const contentType = String(res.getHeader("Content-Type") || "").toLowerCase();
  if (contentType.startsWith("text/event-stream")) return false;
  return !INTERNAL_TELEMETRY_ROUTES.has(route);
}

function isEventStream(res: Pick<Response, "getHeader">): boolean {
  return String(res.getHeader("Content-Type") || "").toLowerCase().startsWith("text/event-stream");
}

/** Mounted before auth so every /api response, including a 401, is correlated. */
export function apiDiagnosticMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = randomUUID();
  requestIds.set(req, id);
  res.setHeader("X-Request-ID", id);
  const started = performance.now();
  let finished = false;
  res.once("finish", () => {
    if (finished) return;
    finished = true;
    const duration = Math.max(0, Math.round(performance.now() - started));
    const route = requestRoute(req);
    const status = res.statusCode;
    const configured = Number(process.env.CAIRN_SLOW_REQUEST_MS);
    const slowMs = Number.isFinite(configured) && configured >= 100 ? configured : DEFAULT_SLOW_REQUEST_MS;
    const ordinaryProductRequest = isOrdinaryProductRequest(res, route);
    if (!isEventStream(res)) {
      recordRequestMetric({ protocol: "api", method: req.method, route, status, duration_ms: duration,
        scope: ordinaryProductRequest ? "product" : "internal" });
    }
    // Auth failures are intentionally excluded from durable HTTP-error telemetry.
    // They still receive X-Request-ID and remain visible to the caller.
    if (status >= 400 && status !== 401 && status !== 403 && !unexpectedErrorRequests.has(req)) {
      // A 404 that matched no router carries no route template at all, so the event
      // would read as a bare "/api/unknown". Name the path instead — the ONLY place a
      // caller-supplied path enters telemetry, hence sanitized: query string dropped,
      // ids collapsed, characters allowlisted, length capped.
      const unmatched = status === 404 && !req.route;
      recordDiagnosticEvent({
        source: "api",
        kind: "http_error",
        // A conflict (409) and an unmatched path are EXPECTED outcomes a caller
        // resolves, not defects — visible in the list without counting as errors.
        level: status >= 500 ? "error" : status === 409 || unmatched ? "info" : "warning",
        operation: req.method,
        route,
        status,
        duration_ms: duration,
        request_id: id,
        fingerprint: `api:http_error:${req.method}:${route || "unknown"}:${status}`,
        message: unmatched ? `HTTP 404 ${telemetryRequestPathLabel(req.originalUrl)}` : `HTTP ${status}`,
        release: getBuildStamp(),
        trusted_route_template: true,
      });
    }
    if (ordinaryProductRequest && duration >= slowMs) {
      recordDiagnosticEvent({
        source: "api",
        kind: "slow_request",
        level: "warning",
        operation: req.method,
        route,
        status,
        duration_ms: duration,
        request_id: id,
        fingerprint: `api:slow_request:${req.method}:${route || "unknown"}`,
        message: `Request exceeded ${slowMs} ms`,
        release: getBuildStamp(),
        trusted_route_template: true,
      });
    }
  });
  next();
}

export function recordUnexpectedApiError(error: unknown, req: Request): void {
  unexpectedErrorRequests.add(req);
  const errorName = diagnosticErrorName(error);
  recordDiagnosticEvent({
    source: "api",
    kind: "server_exception",
    level: "error",
    operation: req.method,
    route: requestRoute(req),
    status: 500,
    request_id: requestId(req),
    fingerprint: `api:server_exception:${req.method}:${requestRoute(req) || "unknown"}:${errorName}`,
    message: `${errorName}: server operation failed`,
    stack: diagnosticStackFrames(error),
    release: getBuildStamp(),
    trusted_route_template: true,
  });
}

/** Shared privacy-safe sink for every background scheduler boundary. */
export function recordSchedulerFailure(
  operation: string,
  error: unknown,
  sink: typeof recordDiagnosticEvent = recordDiagnosticEvent
): void {
  const safeOperation = telemetryIdentifier(operation, 80, "scheduler_task");
  const errorName = diagnosticErrorName(error);
  sink({
    source: "scheduler",
    kind: "task_failure",
    level: "error",
    operation: safeOperation,
    fingerprint: `scheduler:task_failure:${safeOperation}:${errorName}`,
    message: `${errorName}: scheduled operation failed`,
    stack: diagnosticStackFrames(error),
    release: getBuildStamp(),
  });
}

/**
 * The typed carrier for a boundary-apply ending that could not be applied. Its NAME is
 * what `telemetryErrorName` keeps, so a fingerprint reads
 * `worker:final_failure:apply:announced_boundary:<class>:BoundaryApplyError` instead of
 * the bare "Error" every ending used to collapse into.
 */
export class BoundaryApplyError extends Error {
  override readonly name = "BoundaryApplyError";
  constructor(outcomeClass: string) {
    // Taxonomy only — never the per-decision apply_error, which is free text.
    super(`announced change did not apply: ${telemetryIdentifier(outcomeClass, 40, "unknown_outcome")}`);
  }
}

/**
 * Provider exhaustion, recorded as AVAILABILITY rather than as a code defect: its own
 * kind and a `warning` level, so /api/diagnostics can count "nothing could run tonight"
 * separately from "something is broken". The fingerprint carries the availability class,
 * so a weekly-limit night and an auth-expiry night are different rows.
 */
export function recordProviderUnavailable(
  operation: string,
  error: ProviderUnavailableError,
  sink: typeof recordDiagnosticEvent = recordDiagnosticEvent
): void {
  const safeOperation = telemetryIdentifier(operation, 80, "scheduler_task");
  const state = telemetryIdentifier(error.dominantState, 40, "unknown_state");
  sink({
    source: "scheduler",
    kind: "provider_unavailable",
    level: "warning",
    operation: safeOperation,
    fingerprint: `scheduler:provider_unavailable:${safeOperation}:${state}`,
    message: `every configured agent was unavailable: ${state}`,
    release: getBuildStamp(),
  });
}

/** Terminal async-worker failure, coalesced by component/kind/error class. */
export function recordAsyncFailure(component: string, operation: string, error: unknown): void {
  const safeComponent = telemetryIdentifier(component, 50, "worker");
  const safeOperation = telemetryIdentifier(operation, 80, "operation");
  const errorName = diagnosticErrorName(error);
  recordDiagnosticEvent({
    source: "worker",
    kind: "final_failure",
    level: "error",
    operation: `${safeComponent}:${safeOperation}`,
    fingerprint: `worker:final_failure:${safeComponent}:${safeOperation}:${errorName}`,
    message: genericFailureMessage(`${safeComponent}_${safeOperation}`, error),
    stack: diagnosticStackFrames(error),
    release: getBuildStamp(),
  });
}

/**
 * A background operation that COMPLETED, but on its deterministic path only —
 * the agent step yielded nothing usable. Not a failure (the user has real data,
 * and the surface says so honestly), so it lands at warning level under its own
 * kind, coalesced by the taxonomy reason rather than by an error string.
 */
export function recordDegradedOperation(component: string, operation: string, reason: string): void {
  const safeComponent = telemetryIdentifier(component, 50, "worker");
  const safeOperation = telemetryIdentifier(operation, 80, "operation");
  const safeReason = telemetryIdentifier(reason, 60, "unknown");
  recordDiagnosticEvent({
    source: "worker",
    kind: "degraded",
    level: "warning",
    operation: `${safeComponent}:${safeOperation}`,
    fingerprint: `worker:degraded:${safeComponent}:${safeOperation}:${safeReason}`,
    message: `${safeComponent}_${safeOperation} completed without the agent step: ${safeReason}`,
    release: getBuildStamp(),
  });
}

type ProcessLike = Pick<NodeJS.Process, "on" | "off">;

export interface ProcessDiagnosticOptions {
  process?: ProcessLike;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  sink?: typeof recordDiagnosticEvent;
}

/**
 * Install the process safety net. Unhandled rejections are recorded and logged;
 * uncaught exceptions are recorded synchronously, then terminate so the durable
 * single-process service can be restarted in a known state.
 */
export function registerProcessDiagnosticHandlers(options: ProcessDiagnosticOptions = {}): () => void {
  const target = options.process ?? process;
  const exit = options.exit ?? ((code) => process.exit(code));
  const log = options.log ?? ((message) => console.error(message));
  const sink = options.sink ?? recordDiagnosticEvent;

  const capture = (kind: "unhandled_rejection" | "uncaught_exception", reason: unknown) => {
    const errorName = diagnosticErrorName(reason);
    const message = `${errorName}: process failure`;
    try {
      sink({
        source: "process",
        kind,
        level: "error",
        operation: "node_process",
        fingerprint: `process:${kind}:${errorName}`,
        message,
        stack: diagnosticStackFrames(reason),
        release: getBuildStamp(),
      });
    } catch {
      /* injected sinks may throw; process handling must still be decisive */
    }
    log(`[server] ${kind}: ${errorName}`);
  };

  const onRejection = (reason: unknown) => capture("unhandled_rejection", reason);
  const onException = (error: Error) => {
    capture("uncaught_exception", error);
    exit(1);
  };
  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);
  return () => {
    target.off("unhandledRejection", onRejection);
    target.off("uncaughtException", onException);
  };
}
