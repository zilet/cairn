import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getVersion } from "./version.js";
import { normalizeDiagnosticRoute, recordDiagnosticEvent, sanitizeDiagnosticText } from "./repo/diagnostics.js";

const DEFAULT_SLOW_REQUEST_MS = 2_000;

export function requestId(req: Request): string {
  return String((req as any).cairnRequestId || "");
}

function requestRoute(req: Request): string | null {
  return normalizeDiagnosticRoute(req.originalUrl || req.url);
}

/** Mounted before auth so every /api response, including a 401, is correlated. */
export function apiDiagnosticMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = randomUUID();
  (req as any).cairnRequestId = id;
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
    // Auth failures are intentionally excluded from durable HTTP-error telemetry.
    // They still receive X-Request-ID and remain visible to the caller.
    if (status >= 400 && status !== 401 && status !== 403) {
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
        release: getVersion(),
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
        release: getVersion(),
      });
    }
  });
  next();
}

export function recordUnexpectedApiError(error: unknown, req: Request): void {
  const err = error instanceof Error ? error : null;
  recordDiagnosticEvent({
    source: "api",
    kind: "server_exception",
    level: "error",
    operation: req.method,
    route: requestRoute(req),
    status: 500,
    request_id: requestId(req),
    fingerprint: `api:server_exception:${req.method}:${requestRoute(req) || "unknown"}:${err?.name || "Error"}`,
    message: err ? `${err.name}: ${err.message}` : "Non-Error exception",
    stack: err?.stack,
    release: getVersion(),
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
    const error = reason instanceof Error ? reason : null;
    const message = error ? `${error.name}: ${error.message}` : `Non-Error ${kind}`;
    try {
      sink({
        source: "process",
        kind,
        level: "error",
        operation: "node_process",
        fingerprint: `process:${kind}:${error?.name || "non_error"}`,
        message,
        stack: error?.stack,
        release: getVersion(),
      });
    } catch {
      /* injected sinks may throw; process handling must still be decisive */
    }
    log(`[server] ${kind}: ${sanitizeDiagnosticText(message, 320) || "unknown error"}`);
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
