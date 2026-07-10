import { db } from "../db.js";
import { getBuildInfo } from "../build-info.js";
import { getRequestPerformance, normalizeServerApiRouteTemplate, REQUEST_METRIC_LIMITS } from "./request-metrics.js";

export type DiagnosticSource = "client" | "api" | "mcp" | "process" | "scheduler" | "worker";
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
  /** Internal-only: route came from Express's matched route template. */
  trusted_route_template?: boolean;
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

const SOURCES = new Set<DiagnosticSource>(["client", "api", "mcp", "process", "scheduler", "worker"]);
const LEVELS = new Set<DiagnosticLevel>(["warning", "error"]);
const CLIENT_KINDS = new Set<ClientDiagnosticEvent["kind"]>([
  "api_failure",
  "render_error",
  "unhandled_error",
  "unhandled_rejection",
]);
const CLIENT_TABS = new Set(["today", "progress", "stand", "plan", "chat", "settings", "session", "me"]);
const CLIENT_API_CATEGORIES = new Set([
  "activities", "agent", "agent-clis", "agent-jobs", "agent-stats", "agents", "art", "blood-pressure",
  "body-metrics", "bodyweight", "brain", "brain-diagnostics", "calendar", "cardio", "chat", "chat-images",
  "checkins", "coach", "coaching-focus", "context-effect", "context-events", "dexa-targeting", "diagnostics",
  "directives", "endurance-goal", "endurance-prs", "evidence", "exercise", "exercises", "export", "family",
  "food-notes", "frequent-foods", "garmin", "goal", "goal-checkin", "guidelines", "health", "health-docs",
  "health-export", "health-metrics", "health-report", "injury-impacts", "insights", "journey", "last-set",
  "learned-timeline", "learnings", "markers", "meal-plans", "mealplans", "memory", "muscle-load",
  "muscle-trajectory", "next-step", "nutrition", "onboard", "performance", "plan", "profile", "program",
  "program-state", "progress", "proposals", "reaction-model", "ready", "recent-training", "recovery", "research",
  "reset", "run-compliance", "run-plan", "run-zones", "search", "session-suggest", "sessions", "sets", "settings",
  "since-last", "stats", "suggestions", "supplements", "symptom-links", "telemetry", "test-week", "today",
  "today-agenda", "today-read", "trajectory", "turns", "update-check", "update-status", "version", "volume",
  "week-ahead", "whole-person-trajectory",
]);
const DIAGNOSTIC_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DIAGNOSTIC_RETENTION_DAYS = 30;
const DIAGNOSTIC_ROW_CAP = 20_000;
const COALESCE_MINUTES = 5;
const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|prompt|chat|health|request[_-]?body|response[_-]?body|raw[_-]?output|input[_-]?tokens?|output[_-]?tokens?)/i;

function scalarText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value;
}

function clientDiagnosticMessage(kind: ClientDiagnosticEvent["kind"]): string {
  if (kind === "api_failure") return "Client API request failed";
  if (kind === "render_error") return "Client render failed";
  if (kind === "unhandled_rejection") return "Unhandled client rejection";
  return "Unhandled client error";
}

function clientStackFrames(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const frames = value
    .split(/\r?\n/)
    .filter((line) => /^\s*at\s+/.test(line))
    .slice(0, 20)
    .join("\n");
  return sanitizeDiagnosticText(frames, 1_800);
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

function boundedRelease(value: unknown): string | null {
  const text = scalarText(value)?.trim();
  if (!text) return null;
  const safe = text.replace(/[^A-Za-z0-9_.:@/-]/g, "_").slice(0, 80);
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
  pathname = pathname.replace(/\/{2,}/g, "/");
  if (pathname === "/api" || pathname === "/api/") return "/api";
  const [root, category] = pathname.split("/").slice(1);
  if (root !== "api" || !category || !CLIENT_API_CATEGORIES.has(category)) return null;
  return `/api/${category}`;
}

function normalizedClientTab(value: unknown): string | null {
  if (value == null) return null;
  const tab = scalarText(value)?.trim().toLowerCase();
  return tab && CLIENT_TABS.has(tab) ? tab : "unknown";
}

function normalizedClientRequestId(value: unknown): string | null {
  const requestId = scalarText(value)?.trim();
  if (!requestId) return null;
  return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|req-[0-9]{1,12})$/i.test(requestId)
    ? requestId : null;
}

function clientFingerprint(event: { kind: ClientDiagnosticEvent["kind"]; method?: string | null; route?: string | null; status?: number | null }): string {
  return `client:${event.kind}:${event.method || "none"}:${event.route || "none"}:${event.status ?? "none"}`.slice(0, 120);
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
const coalesceDiagnosticEvent = db.prepare(
  `UPDATE diagnostic_events
      SET occurrence_count=COALESCE(occurrence_count,1)+1, created_at=datetime('now'),
          duration_ms=COALESCE(?,duration_ms), status=COALESCE(?,status),
          request_id=COALESCE(?,request_id)
    WHERE id=(SELECT id FROM diagnostic_events
               WHERE source=? AND kind=? AND fingerprint=?
                 AND release IS ?
                 AND created_at >= datetime('now', ?)
               ORDER BY id DESC LIMIT 1)`
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
    input.trusted_route_template ? normalizeServerApiRouteTemplate(input.route) : normalizeDiagnosticRoute(input.route),
    finiteInteger(input.status, 100, 599),
    finiteInteger(input.duration_ms, 0, 3_600_000),
    boundedIdentifier(input.request_id, 80),
    boundedIdentifier(input.fingerprint, 120) || defaultFingerprint({ ...input, source, kind }),
    sanitizeDiagnosticText(input.message, 320),
    sanitizeDiagnosticText(input.stack, 1800),
    sanitizeMetadata(input.metadata),
    boundedRelease(input.release),
  ];
}

function maybePruneDiagnosticEvents(now = Date.now()): void {
  if (now < nextDiagnosticPruneAt) return;
  pruneDiagnosticEvents(now);
}

/** Best-effort retention; exposed separately for deterministic maintenance/tests. */
export function pruneDiagnosticEvents(now = Date.now()): void {
  try {
    db.prepare(`DELETE FROM diagnostic_events WHERE created_at < datetime('now', ?)`).run(`-${DIAGNOSTIC_RETENTION_DAYS} days`);
    db.prepare(
      `DELETE FROM diagnostic_events WHERE id NOT IN
       (SELECT id FROM diagnostic_events ORDER BY created_at DESC,id DESC LIMIT ?)`
    ).run(DIAGNOSTIC_ROW_CAP);
  } catch {
    /* diagnostics must never break product paths */
  } finally {
    // Retention is maintenance, not part of every request's write cost. Advance
    // even after a failure so a broken telemetry table cannot become a hot loop.
    nextDiagnosticPruneAt = now + DIAGNOSTIC_PRUNE_INTERVAL_MS;
  }
}

function writeDiagnosticEvent(input: DiagnosticEventInput): void {
  const normalized = normalizeDiagnosticEvent(input);
  const [source, kind, , , , status, duration, requestId, fingerprint, , , , release] = normalized;
  const updated = coalesceDiagnosticEvent.run(
    duration,
    status,
    requestId,
    source,
    kind,
    fingerprint,
    release,
    `-${COALESCE_MINUTES} minutes`
  );
  if (Number(updated.changes) === 0) insertDiagnosticEvent.run(...normalized);
}

/** Failure-safe write. The real operation always wins over telemetry. */
export function recordDiagnosticEvent(input: DiagnosticEventInput): void {
  try {
    writeDiagnosticEvent(input);
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
    for (const input of inputs) writeDiagnosticEvent(input);
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
    if (!event.message.trim()) return null;
    if (event.stack != null && typeof event.stack !== "string") return null;
    if (event.route != null && (typeof event.route !== "string" || !normalizeDiagnosticRoute(event.route))) return null;
    if (event.method != null && (typeof event.method !== "string" || !/^[A-Za-z]{3,10}$/.test(event.method)))
      return null;
    if (event.status != null && finiteInteger(event.status, 100, 599) == null) return null;
    if (event.duration_ms != null && finiteInteger(event.duration_ms, 0, 3_600_000) == null) return null;
    if (event.request_id != null && typeof event.request_id !== "string") return null;
    if (event.tab != null && typeof event.tab !== "string") return null;
    if (event.online != null && typeof event.online !== "boolean") return null;
    if (event.release != null && (typeof event.release !== "string" || !boundedRelease(event.release)))
      return null;
    const route = event.route == null ? null : normalizeDiagnosticRoute(event.route);
    const method = event.method == null ? null : String(event.method).toUpperCase();
    const status = event.status == null ? null : finiteInteger(event.status, 100, 599);
    parsed.push({
      source: "client",
      kind: event.kind as ClientDiagnosticEvent["kind"],
      level: event.level as DiagnosticLevel,
      message: clientDiagnosticMessage(event.kind as ClientDiagnosticEvent["kind"]),
      fingerprint: clientFingerprint({ kind: event.kind as ClientDiagnosticEvent["kind"], route, method, status }),
      stack: event.stack == null ? null : clientStackFrames(event.stack),
      route,
      method,
      status,
      duration_ms: event.duration_ms == null ? null : finiteInteger(event.duration_ms, 0, 3_600_000),
      request_id: normalizedClientRequestId(event.request_id),
      tab: normalizedClientTab(event.tab),
      online: event.online == null ? null : event.online === true,
      release: event.release == null ? null : boundedRelease(event.release),
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
      message: clientDiagnosticMessage(event.kind),
      stack: clientStackFrames(event.stack),
      metadata: { tab: event.tab, online: event.online },
      release: releaseFallback,
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
    occurrence_count: Number(row.occurrence_count ?? 1),
    first_seen: row.first_seen ?? row.created_at,
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
    (db.prepare(`SELECT COALESCE(SUM(occurrence_count),0) AS n FROM diagnostic_events WHERE created_at >= datetime('now', ?)`).get(since) as any)
      ?.n ?? 0
  );
  const recordMap = (rows: any[], key: string) =>
    Object.fromEntries(rows.map((row) => [String(row[key]), Number(row.count)]));
  const bySource = db
    .prepare(
      `SELECT source, COALESCE(SUM(occurrence_count),0) AS count FROM diagnostic_events WHERE created_at >= datetime('now', ?) GROUP BY source ORDER BY source`
    )
    .all(since) as any[];
  const byKind = db
    .prepare(
      `SELECT kind, COALESCE(SUM(occurrence_count),0) AS count FROM diagnostic_events WHERE created_at >= datetime('now', ?) GROUP BY kind ORDER BY kind`
    )
    .all(since) as any[];
  const byRoute = db
    .prepare(
      `SELECT route, COALESCE(SUM(occurrence_count),0) AS count FROM diagnostic_events
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
         SELECT fingerprint, release, SUM(occurrence_count) AS count, MIN(COALESCE(first_seen,created_at)) AS first_seen,
                MAX(created_at) AS last_seen, MAX(id) AS latest_id
           FROM scoped GROUP BY fingerprint, release
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
    build: getBuildInfo(),
    window_days: days,
    total,
    by_source: recordMap(bySource, "source"),
    by_kind: recordMap(byKind, "kind"),
    by_route: byRoute,
    issues,
    recent: recentEvents,
    slow,
    performance: getRequestPerformance(days),
    storage: {
      diagnostic_events: {
        rows: Number((db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_events`).get() as any)?.n ?? 0),
        retention_days: DIAGNOSTIC_RETENTION_DAYS,
        row_cap: DIAGNOSTIC_ROW_CAP,
      },
      request_metric_buckets: {
        rows: Number((db.prepare(`SELECT COUNT(*) AS n FROM request_metric_buckets`).get() as any)?.n ?? 0),
        ...REQUEST_METRIC_LIMITS,
      },
    },
  };
}

export const DIAGNOSTIC_LIMITS = {
  retention_days: DIAGNOSTIC_RETENTION_DAYS,
  row_cap: DIAGNOSTIC_ROW_CAP,
  coalesce_minutes: COALESCE_MINUTES,
};
