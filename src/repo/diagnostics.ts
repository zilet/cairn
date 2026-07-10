import { db } from "../db.js";

export type DiagnosticSource = "client" | "api" | "process" | "scheduler";
export type DiagnosticLevel = "warning" | "error";

export interface DiagnosticEventInput {
  source: DiagnosticSource;
  kind: string;
  level: DiagnosticLevel;
  operation?: string | null;
  route?: string | null;
  status?: number | null;
  duration_ms?: number | null;
  request_id?: string | null;
  fingerprint?: string | null;
  message?: string | null;
  stack?: string | null;
  metadata?: Record<string, unknown> | null;
  release?: string | null;
}

export interface ClientDiagnosticEvent {
  source: "client";
  kind: "api_failure" | "render_error" | "unhandled_error" | "unhandled_rejection";
  level: DiagnosticLevel;
  message: string;
  stack?: string | null;
  route?: string | null;
  method?: string | null;
  status?: number | null;
  duration_ms?: number | null;
  request_id?: string | null;
  tab?: string | null;
  online?: boolean | null;
  release?: string | null;
  fingerprint: string;
}

const SOURCES = new Set<DiagnosticSource>(["client", "api", "process", "scheduler"]);
const LEVELS = new Set<DiagnosticLevel>(["warning", "error"]);
const CLIENT_KINDS = new Set<ClientDiagnosticEvent["kind"]>([
  "api_failure",
  "render_error",
  "unhandled_error",
  "unhandled_rejection",
]);
const DIAGNOSTIC_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|prompt|chat|health|request[_-]?body|response[_-]?body|raw[_-]?output|input[_-]?tokens?|output[_-]?tokens?)/i;

function scalarText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value;
}

/** Conservative best-effort scrubber. Callers must still never pass bodies. */
export function sanitizeDiagnosticText(value: unknown, max = 320): string | null {
  const raw = scalarText(value);
  if (raw == null) return null;
  const withoutControls = Array.from(raw, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
      ? " "
      : char;
  }).join("");
  const text = withoutControls
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[credential redacted]")
    .replace(
      /\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)[\w-]*)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[redacted]"
    )
    .replace(
      /\b(prompt|chat|health|request[_-]?body|response[_-]?body|raw[_-]?output|input[_-]?tokens?|output[_-]?tokens?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,;]+)/gi,
      "$1=[redacted]"
    )
    .replace(
      /\b(weight|body\s*fat|blood\s*pressure|systolic|diastolic|glucose|hba1c|a1c|ldl|hdl|apob|ferritin|vitamin\s*d|heart\s*rate|hrv)\b\s*(?:[:=]|is\s+)?-?\d+(?:\.\d+)?(?:\s*(?:mg\/dl|mmhg|bpm|lb|kg|%))?/gi,
      "$1=[health value redacted]"
    )
    .replace(/(https?:\/\/[^\s?]+)\?[^\s)]+/gi, "$1?[redacted]")
    .replace(/((?:\/api)?\/[A-Za-z0-9_./:-]+)\?[^\s)]+/g, "$1?[redacted]")
    .replace(/\b[A-Z]:\\(?:[^\\\s]+\\)+[^\s)]+/gi, "[path redacted]")
    .replace(/\/(?:Users|home|private|var|tmp)\/(?:[^\s():]+\/)*[^\s():]+/g, "[path redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.slice(0, Math.max(1, max));
}

function boundedIdentifier(value: unknown, max: number): string | null {
  const text = scalarText(value)?.trim();
  if (!text) return null;
  const safe = text.replace(/[^A-Za-z0-9_.:/-]/g, "_").slice(0, max);
  return safe || null;
}

export function normalizeDiagnosticRoute(value: unknown): string | null {
  const raw = scalarText(value)?.trim();
  if (!raw) return null;
  let pathname = raw;
  try {
    pathname = new URL(raw, "http://cairn.local").pathname;
  } catch {
    pathname = raw.split("?", 1)[0] || "";
  }
  pathname = pathname
    .replace(/\/{2,}/g, "/")
    .replace(/\/[0-9]+(?=\/|$)/g, "/:id")
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, "/:id")
    .replace(/\/[A-Za-z0-9_-]{32,}(?=\/|$)/g, "/:id");
  if (!pathname.startsWith("/api")) return null;
  return pathname.slice(0, 180);
}

function finiteInteger(value: unknown, min: number, max: number): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n);
}

function sanitizeMetadata(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 12)) {
    const key = boundedIdentifier(rawKey, 48);
    if (!key || SENSITIVE_KEY.test(key)) continue;
    if (typeof rawValue === "string") clean[key] = sanitizeDiagnosticText(rawValue, 120);
    else if (typeof rawValue === "number" && Number.isFinite(rawValue)) clean[key] = rawValue;
    else if (typeof rawValue === "boolean" || rawValue === null) clean[key] = rawValue;
  }
  const encoded = Object.keys(clean).length ? JSON.stringify(clean) : null;
  return encoded?.slice(0, 1000) ?? null;
}

function defaultFingerprint(event: DiagnosticEventInput): string {
  return [event.source, event.kind, event.operation || event.route || "unknown", event.status ?? "none"]
    .join(":")
    .replace(/[^A-Za-z0-9_.:/-]/g, "_")
    .slice(0, 120);
}

type NormalizedDiagnosticEvent = [
  source: DiagnosticSource,
  kind: string,
  level: DiagnosticLevel,
  operation: string | null,
  route: string | null,
  status: number | null,
  duration: number | null,
  requestId: string | null,
  fingerprint: string,
  message: string | null,
  stack: string | null,
  metadata: string | null,
  release: string | null,
];

const insertDiagnosticEvent = db.prepare(
  `INSERT INTO diagnostic_events
    (source, kind, level, operation, route, status, duration_ms, request_id,
     fingerprint, message, stack, metadata_json, release)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

let nextDiagnosticPruneAt = 0;

function normalizeDiagnosticEvent(input: DiagnosticEventInput): NormalizedDiagnosticEvent {
  const source = SOURCES.has(input.source) ? input.source : "process";
  const kind = boundedIdentifier(input.kind, 64) || "unknown_error";
  const level = LEVELS.has(input.level) ? input.level : "error";
  return [
    source,
    kind,
    level,
    sanitizeDiagnosticText(input.operation, 100),
    normalizeDiagnosticRoute(input.route),
    finiteInteger(input.status, 100, 599),
    finiteInteger(input.duration_ms, 0, 3_600_000),
    boundedIdentifier(input.request_id, 80),
    boundedIdentifier(input.fingerprint, 120) || defaultFingerprint({ ...input, source, kind }),
    sanitizeDiagnosticText(input.message, 320),
    sanitizeDiagnosticText(input.stack, 1800),
    sanitizeMetadata(input.metadata),
    boundedIdentifier(input.release, 80),
  ];
}

function maybePruneDiagnosticEvents(now = Date.now()): void {
  if (now < nextDiagnosticPruneAt) return;
  pruneDiagnosticEvents(now);
}

/** Best-effort retention; exposed separately for deterministic maintenance/tests. */
export function pruneDiagnosticEvents(now = Date.now()): void {
  try {
    db.prepare(`DELETE FROM diagnostic_events WHERE created_at < datetime('now', '-30 days')`).run();
  } catch {
    /* diagnostics must never break product paths */
  } finally {
    // Retention is maintenance, not part of every request's write cost. Advance
    // even after a failure so a broken telemetry table cannot become a hot loop.
    nextDiagnosticPruneAt = now + DIAGNOSTIC_PRUNE_INTERVAL_MS;
  }
}

/** Failure-safe write. The real operation always wins over telemetry. */
export function recordDiagnosticEvent(input: DiagnosticEventInput): void {
  try {
    insertDiagnosticEvent.run(...normalizeDiagnosticEvent(input));
  } catch {
    /* diagnostics must never break product paths */
  } finally {
    maybePruneDiagnosticEvents();
  }
}

/** One atomic SQLite transaction for a browser batch; never leaks failure to callers. */
export function recordDiagnosticEvents(inputs: DiagnosticEventInput[]): void {
  if (!inputs.length) return;
  let transactionStarted = false;
  try {
    db.exec("BEGIN");
    transactionStarted = true;
    for (const input of inputs) insertDiagnosticEvent.run(...normalizeDiagnosticEvent(input));
    db.exec("COMMIT");
    transactionStarted = false;
  } catch {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
    /* diagnostics must never break product paths */
  } finally {
    maybePruneDiagnosticEvents();
  }
}

export function parseClientDiagnosticBatch(body: unknown): ClientDiagnosticEvent[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length < 1 || events.length > 20) return null;
  const parsed: ClientDiagnosticEvent[] = [];
  for (const value of events) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const event = value as Record<string, unknown>;
    if (!CLIENT_KINDS.has(event.kind as ClientDiagnosticEvent["kind"])) return null;
    if (!LEVELS.has(event.level as DiagnosticLevel)) return null;
    if (typeof event.message !== "string" || typeof event.fingerprint !== "string") return null;
    const fingerprint = boundedIdentifier(event.fingerprint, 120);
    const message = sanitizeDiagnosticText(event.message, 320);
    if (!fingerprint || !message) return null;
    if (event.stack != null && typeof event.stack !== "string") return null;
    if (event.route != null && (typeof event.route !== "string" || !normalizeDiagnosticRoute(event.route))) return null;
    if (event.method != null && (typeof event.method !== "string" || !/^[A-Za-z]{3,10}$/.test(event.method)))
      return null;
    if (event.status != null && finiteInteger(event.status, 100, 599) == null) return null;
    if (event.duration_ms != null && finiteInteger(event.duration_ms, 0, 3_600_000) == null) return null;
    if (event.request_id != null && (typeof event.request_id !== "string" || !boundedIdentifier(event.request_id, 80)))
      return null;
    if (event.tab != null && (typeof event.tab !== "string" || !boundedIdentifier(event.tab, 60))) return null;
    if (event.online != null && typeof event.online !== "boolean") return null;
    if (event.release != null && (typeof event.release !== "string" || !boundedIdentifier(event.release, 80)))
      return null;
    parsed.push({
      source: "client",
      kind: event.kind as ClientDiagnosticEvent["kind"],
      level: event.level as DiagnosticLevel,
      message,
      fingerprint,
      stack: event.stack == null ? null : sanitizeDiagnosticText(event.stack, 1800),
      route: event.route == null ? null : normalizeDiagnosticRoute(event.route),
      method: event.method == null ? null : String(event.method).toUpperCase(),
      status: event.status == null ? null : finiteInteger(event.status, 100, 599),
      duration_ms: event.duration_ms == null ? null : finiteInteger(event.duration_ms, 0, 3_600_000),
      request_id: event.request_id == null ? null : boundedIdentifier(event.request_id, 80),
      tab: event.tab == null ? null : boundedIdentifier(event.tab, 60),
      online: event.online == null ? null : event.online === true,
      release: event.release == null ? null : boundedIdentifier(event.release, 80),
    });
  }
  return parsed;
}

export function ingestClientDiagnosticEvents(events: ClientDiagnosticEvent[], releaseFallback?: string): void {
  recordDiagnosticEvents(
    events.map((event) => ({
      source: "client",
      kind: event.kind,
      level: event.level,
      operation: event.method ? `${event.method} ${event.route || "client"}` : event.tab,
      route: event.route,
      status: event.status,
      duration_ms: event.duration_ms,
      request_id: event.request_id,
      fingerprint: event.fingerprint,
      message: event.message,
      stack: event.stack,
      metadata: { tab: event.tab, online: event.online },
      release: event.release || releaseFallback,
    }))
  );
}

function parseDiagnosticMetadata(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rowToEvent(row: any) {
  return {
    id: Number(row.id),
    source: row.source,
    kind: row.kind,
    level: row.level,
    operation: row.operation ?? null,
    route: row.route ?? null,
    status: row.status == null ? null : Number(row.status),
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    request_id: row.request_id ?? null,
    fingerprint: row.fingerprint,
    message: row.message ?? null,
    stack: row.stack ?? null,
    metadata: parseDiagnosticMetadata(row.metadata_json),
    release: row.release ?? null,
    created_at: row.created_at,
  };
}

export function getDiagnostics(opts: { recent?: number; days?: number } = {}) {
  const clamp = (value: unknown, fallback: number, min: number, max: number) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(Math.max(Math.trunc(number), min), max) : fallback;
  };
  const recent = clamp(opts.recent, 25, 1, 200);
  const days = clamp(opts.days, 7, 1, 365);
  const since = `-${days} days`;
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_events WHERE created_at >= datetime('now', ?)`).get(since) as any)
      ?.n ?? 0
  );
  const recordMap = (rows: any[], key: string) =>
    Object.fromEntries(rows.map((row) => [String(row[key]), Number(row.count)]));
  const bySource = db
    .prepare(
      `SELECT source, COUNT(*) AS count FROM diagnostic_events WHERE created_at >= datetime('now', ?) GROUP BY source ORDER BY source`
    )
    .all(since) as any[];
  const byKind = db
    .prepare(
      `SELECT kind, COUNT(*) AS count FROM diagnostic_events WHERE created_at >= datetime('now', ?) GROUP BY kind ORDER BY kind`
    )
    .all(since) as any[];
  const byRoute = db
    .prepare(
      `SELECT route, COUNT(*) AS count FROM diagnostic_events
        WHERE created_at >= datetime('now', ?) AND route IS NOT NULL
        GROUP BY route ORDER BY count DESC, route LIMIT 50`
    )
    .all(since)
    .map((row: any) => ({ route: row.route, count: Number(row.count) }));
  const issues = db
    .prepare(
      `WITH scoped AS (
         SELECT * FROM diagnostic_events WHERE created_at >= datetime('now', ?)
       ), grouped AS (
         SELECT fingerprint, COUNT(*) AS count, MIN(created_at) AS first_seen,
                MAX(created_at) AS last_seen, MAX(id) AS latest_id
           FROM scoped GROUP BY fingerprint
       )
       SELECT grouped.fingerprint, latest.source, latest.kind, latest.level,
              latest.route, latest.operation, latest.status, grouped.count,
              grouped.first_seen, grouped.last_seen, latest.message, latest.release
         FROM grouped JOIN scoped latest ON latest.id = grouped.latest_id
        ORDER BY CASE latest.level WHEN 'error' THEN 0 ELSE 1 END,
                 grouped.last_seen DESC, grouped.count DESC
        LIMIT 100`
    )
    .all(since)
    .map((row: any) => ({
      fingerprint: row.fingerprint,
      source: row.source,
      kind: row.kind,
      level: row.level,
      route: row.route ?? null,
      operation: row.operation ?? null,
      status: row.status == null ? null : Number(row.status),
      count: Number(row.count),
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      message: row.message ?? null,
      release: row.release ?? null,
    }));
  const recentEvents = (
    db
      .prepare(`SELECT * FROM diagnostic_events WHERE created_at >= datetime('now', ?) ORDER BY id DESC LIMIT ?`)
      .all(since, recent) as any[]
  ).map(rowToEvent);
  const slow = (
    db
      .prepare(
        `SELECT * FROM diagnostic_events
        WHERE created_at >= datetime('now', ?) AND kind = 'slow_request'
        ORDER BY duration_ms DESC, id DESC LIMIT ?`
      )
      .all(since, recent) as any[]
  ).map(rowToEvent);
  return {
    window_days: days,
    total,
    by_source: recordMap(bySource, "source"),
    by_kind: recordMap(byKind, "kind"),
    by_route: byRoute,
    issues,
    recent: recentEvents,
    slow,
  };
}
