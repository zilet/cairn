import { db } from "../db.js";
import { getBuildInfo } from "../build-info.js";
import { telemetryIdentifier } from "../telemetry-privacy.js";

const BUCKETS = [25, 50, 100, 250, 500, 1_000, 2_000, 5_000, 15_000, 60_000, 3_600_001];
const RETENTION_DAYS = 30;
const ROW_CAP = 50_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
let nextPruneAt = 0;
let writesUntilForcedPrune = 250;
const knownMcpMetricOperations = new Set(["initialize", "initialized", "tools_list", "ping"]);
const INTERNAL_MCP_OPERATIONS = new Set([
  "initialize", "initialized", "tools_list", "ping",
  "get_diagnostics", "get_agent_stats", "get_brain_diagnostics", "get_art_stats",
]);

export function registerMcpMetricOperation(value: unknown): void {
  const name = telemetryIdentifier(value, 100, "unknown");
  if (name !== "unknown") knownMcpMetricOperations.add(name);
}

export function normalizeMcpMetricOperation(value: unknown): string {
  const name = telemetryIdentifier(value, 100, "unknown");
  return knownMcpMetricOperations.has(name) ? name : "unknown";
}

export function isInternalMcpMetricOperation(value: unknown): boolean {
  return INTERNAL_MCP_OPERATIONS.has(normalizeMcpMetricOperation(value));
}

const insertRequestMetric = db.prepare(
  `INSERT INTO request_metric_buckets
    (hour, build_id, scope, protocol, method, route, status_class, latency_bucket_ms, count, total_duration_ms, max_duration_ms)
   VALUES (strftime('%Y-%m-%d %H:00:00','now'), ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
   ON CONFLICT(hour, build_id, scope, protocol, method, route, status_class, latency_bucket_ms)
   DO UPDATE SET count=count+1, total_duration_ms=total_duration_ms+excluded.total_duration_ms,
                 max_duration_ms=MAX(max_duration_ms, excluded.max_duration_ms)`
);

function latencyBucket(duration: number): number {
  return BUCKETS.find((bucket) => duration <= bucket) ?? BUCKETS[BUCKETS.length - 1];
}

/** Validate a route template originating from Express's matched req.route.path. */
export function normalizeServerApiRouteTemplate(route: unknown): string {
  if (typeof route !== "string") return "/api/unknown";
  const pathname = route.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/api";
  if (!pathname.startsWith("/api") || pathname.length > 180 || /[?#]/.test(pathname)) return "/api/unknown";
  const segments = pathname.split("/").slice(1);
  if (segments[0] !== "api" || segments.some((segment) => !/^(?:[A-Za-z][A-Za-z0-9_-]*|:[A-Za-z][A-Za-z0-9_]*)$/.test(segment)))
    return "/api/unknown";
  return pathname;
}

export function normalizeServerMetricRoute(protocol: "api" | "mcp", route: unknown): string {
  if (protocol === "mcp") {
    const tool = normalizeMcpMetricOperation(route);
    return tool === "unknown" ? "/mcp/unknown" : `/mcp/${tool}`;
  }
  return normalizeServerApiRouteTemplate(route);
}

export function pruneRequestMetrics(now = Date.now(), force = false): void {
  if (!force && now < nextPruneAt) return;
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
  scope?: "product" | "internal";
}): void {
  try {
    const duration = Math.max(0, Math.min(3_600_000, Math.round(Number(input.duration_ms) || 0)));
    const status = Math.max(0, Math.min(999, Math.round(Number(input.status) || 0)));
    insertRequestMetric.run(
      getBuildInfo().build_id,
      input.scope === "internal" ? "internal" : "product",
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
    writesUntilForcedPrune--;
    if (writesUntilForcedPrune <= 0) {
      writesUntilForcedPrune = 250;
      pruneRequestMetrics(Date.now(), true);
    } else pruneRequestMetrics();
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
  const buildId = getBuildInfo().build_id;
  const rows = db
    .prepare(
      `SELECT scope,protocol,method,route,status_class,latency_bucket_ms,SUM(count) AS count,
              SUM(total_duration_ms) AS total_duration_ms,MAX(max_duration_ms) AS max_duration_ms
         FROM request_metric_buckets WHERE hour >= datetime('now', ?) AND build_id = ?
        GROUP BY scope,protocol,method,route,status_class,latency_bucket_ms`
    )
    .all(since, buildId) as any[];
  const productRows = rows.filter((row) => row.scope === "product");
  const requests = productRows.reduce((sum, row) => sum + Number(row.count), 0);
  const internalRequests = rows.filter((row) => row.scope === "internal").reduce((sum, row) => sum + Number(row.count), 0);
  const duration = productRows.reduce((sum, row) => sum + Number(row.total_duration_ms), 0);
  const grouped = new Map<string, any[]>();
  for (const row of productRows) {
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
  const observedHours = Number(
    (db.prepare(`SELECT COUNT(DISTINCT hour) AS n FROM request_metric_buckets
                  WHERE hour >= datetime('now', ?) AND build_id = ? AND scope = 'product'`).get(since, buildId) as any)?.n ?? 0
  );
  return {
    build_id: buildId,
    window_days: windowDays,
    requests,
    avg_ms: requests ? Math.round(duration / requests) : null,
    p50_ms: percentile(productRows, 0.5),
    p95_ms: percentile(productRows, 0.95),
    max_ms: productRows.length ? Math.max(...productRows.map((row) => Number(row.max_duration_ms))) : null,
    observed_hours: observedHours,
    throughput_per_hour: observedHours ? Number((requests / observedHours).toFixed(2)) : 0,
    traffic: { product: requests, internal: internalRequests },
    by_protocol: Object.fromEntries(
      ["api", "mcp"].map((protocol) => [
        protocol,
        productRows.filter((row) => row.protocol === protocol).reduce((sum, row) => sum + Number(row.count), 0),
      ])
    ),
    top_routes,
  };
}

export const REQUEST_METRIC_LIMITS = { retention_days: RETENTION_DAYS, row_cap: ROW_CAP };
