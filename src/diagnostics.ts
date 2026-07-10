import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getBuildStamp } from "./build-info.js";
import { normalizeDiagnosticRoute, recordDiagnosticEvent } from "./repo/diagnostics.js";
import { recordRequestMetric } from "./repo/request-metrics.js";
import {
  genericFailureMessage,
  telemetryErrorName,
  telemetryIdentifier,
  telemetryStackFrames,
} from "./telemetry-privacy.js";

const DEFAULT_SLOW_REQUEST_MS = 2_000;
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

function requestRoute(req: Request): string | null {
  return normalizeDiagnosticRoute(req.originalUrl || req.url);
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
    recordRequestMetric({ protocol: "api", method: req.method, route, status, duration_ms: duration });
    // Auth failures are intentionally excluded from durable HTTP-error telemetry.
    // They still receive X-Request-ID and remain visible to the caller.
    if (status >= 400 && status !== 401 && status !== 403 && !unexpectedErrorRequests.has(req)) {
      recordDiagnosticEvent({
        source: "api",
        kind: "http_error",
        level: status >= 500 ? "error" : "warning",
        operation: req.method,
        route,
        status,
        duration_ms: duration,
        request_id: id,
        fingerprint: `api:http_error:${req.method}:${route || "unknown"}:${status}`,
        message: `HTTP ${status}`,
        release: getBuildStamp(),
      });
    }
    if (duration >= slowMs) {
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
