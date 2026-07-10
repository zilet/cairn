import { db } from "../db.js";
import { telemetryIdentifier } from "../telemetry-privacy.js";

const BUCKETS = [25, 50, 100, 250, 500, 1_000, 2_000, 5_000, 15_000, 60_000, 3_600_001];
const RETENTION_DAYS = 30;
const ROW_CAP = 50_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
let nextPruneAt = 0;

function latencyBucket(duration: number): number {
  return BUCKETS.find((bucket) => duration <= bucket) ?? BUCKETS[BUCKETS.length - 1];
}

export function normalizeServerMetricRoute(protocol: "api" | "mcp", route: unknown): string {
  if (protocol === "mcp") {
    const tool = telemetryIdentifier(route, 100, "request");
    return tool === "request" || tool === "/mcp" ? "/mcp" : `/mcp/${tool.replace(/^\/+/, "")}`;
  }
  const raw = typeof route === "string" ? route.split("?", 1)[0] : "/api/unknown";
  const normalized = raw
    .replace(/\/{2,}/g, "/")
    .replace(/\/[0-9]+(?=\/|$)/g, "/:id")
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, "/:id")
    .replace(/\/[A-Za-z0-9_-]{32,}(?=\/|$)/g, "/:id");
  return normalized.startsWith("/api") ? normalized.slice(0, 180) : "/api/unknown";
}

export function pruneRequestMetrics(now = Date.now()): void {
  if (now < nextPruneAt) return;
  try {
    db.prepare(`DELETE FROM request_metric_buckets WHERE hour < datetime('now', ?)`).run(`-${RETENTION_DAYS} days`);
    db.prepare(
      `DELETE FROM request_metric_buckets WHERE rowid NOT IN
       (SELECT rowid FROM request_metric_buckets ORDER BY hour DESC, rowid DESC LIMIT ?)`
    ).run(ROW_CAP);
  } catch {
    /* metrics never break requests */
  } finally {
    nextPruneAt = now + PRUNE_INTERVAL_MS;
  }
}

export function recordRequestMetric(input: {
  protocol: "api" | "mcp";
  method: unknown;
  route: unknown;
  status: unknown;
  duration_ms: unknown;
}): void {
  try {
    const duration = Math.max(0, Math.min(3_600_000, Math.round(Number(input.duration_ms) || 0)));
    const status = Math.max(0, Math.min(999, Math.round(Number(input.status) || 0)));
    db.prepare(
      `INSERT INTO request_metric_buckets
        (hour, protocol, method, route, status_class, latency_bucket_ms, count, total_duration_ms, max_duration_ms)
       VALUES (strftime('%Y-%m-%d %H:00:00','now'), ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(hour, protocol, method, route, status_class, latency_bucket_ms)
       DO UPDATE SET count=count+1, total_duration_ms=total_duration_ms+excluded.total_duration_ms,
                     max_duration_ms=MAX(max_duration_ms, excluded.max_duration_ms)`
    ).run(
      input.protocol,
      telemetryIdentifier(input.method, 20, "UNKNOWN").toUpperCase(),
      normalizeServerMetricRoute(input.protocol, input.route),
      status ? `${Math.floor(status / 100)}xx` : "unknown",
      latencyBucket(duration),
      duration,
      duration
    );
  } catch {
    /* metrics never break requests */
  } finally {
    pruneRequestMetrics();
  }
}

function percentile(rows: Array<{ latency_bucket_ms: number; count: number }>, fraction: number): number | null {
  const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
  if (!total) return null;
  const target = Math.ceil(total * fraction);
  let seen = 0;
  for (const row of rows.sort((a, b) => Number(a.latency_bucket_ms) - Number(b.latency_bucket_ms))) {
    seen += Number(row.count);
    if (seen >= target) return Number(row.latency_bucket_ms) > 3_600_000 ? 3_600_000 : Number(row.latency_bucket_ms);
  }
  return null;
}

export function getRequestPerformance(days = 7) {
  const windowDays = Math.min(Math.max(Math.trunc(Number(days) || 7), 1), RETENTION_DAYS);
  const since = `-${windowDays} days`;
  const rows = db
    .prepare(
      `SELECT protocol,method,route,status_class,latency_bucket_ms,SUM(count) AS count,
              SUM(total_duration_ms) AS total_duration_ms,MAX(max_duration_ms) AS max_duration_ms
         FROM request_metric_buckets WHERE hour >= datetime('now', ?)
        GROUP BY protocol,method,route,status_class,latency_bucket_ms`
    )
    .all(since) as any[];
  const requests = rows.reduce((sum, row) => sum + Number(row.count), 0);
  const duration = rows.reduce((sum, row) => sum + Number(row.total_duration_ms), 0);
  const grouped = new Map<string, any[]>();
  for (const row of rows) {
    const key = `${row.protocol}|${row.method}|${row.route}`;
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }
  const top_routes = [...grouped.entries()]
    .map(([key, routeRows]) => {
      const [protocol, method, route] = key.split("|");
      const count = routeRows.reduce((sum, row) => sum + Number(row.count), 0);
      const total = routeRows.reduce((sum, row) => sum + Number(row.total_duration_ms), 0);
      return {
        protocol,
        method,
        route,
        requests: count,
        errors: routeRows
          .filter((row) => /^[45]xx$/.test(row.status_class))
          .reduce((sum, row) => sum + Number(row.count), 0),
        avg_ms: count ? Math.round(total / count) : null,
        p50_ms: percentile(routeRows, 0.5),
        p95_ms: percentile(routeRows, 0.95),
        max_ms: Math.max(...routeRows.map((row) => Number(row.max_duration_ms))),
      };
    })
    .sort((a, b) => b.requests - a.requests || b.max_ms - a.max_ms)
    .slice(0, 25);
  return {
    window_days: windowDays,
    requests,
    avg_ms: requests ? Math.round(duration / requests) : null,
    p50_ms: percentile(rows, 0.5),
    p95_ms: percentile(rows, 0.95),
    max_ms: rows.length ? Math.max(...rows.map((row) => Number(row.max_duration_ms))) : null,
    throughput_per_hour: Number((requests / (windowDays * 24)).toFixed(2)),
    by_protocol: Object.fromEntries(
      ["api", "mcp"].map((protocol) => [
        protocol,
        rows.filter((row) => row.protocol === protocol).reduce((sum, row) => sum + Number(row.count), 0),
      ])
    ),
    top_routes,
  };
}

export const REQUEST_METRIC_LIMITS = { retention_days: RETENTION_DAYS, row_cap: ROW_CAP };
