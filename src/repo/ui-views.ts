// Anonymous per-day screen counts. The closed key set is derived from the PWA
// route contract (homes, views, and each view's sections) so a client cannot
// invent a row. The day is the server's local date; a client's own day is taken
// only when it is within one calendar day of that (see `resolveUiViewDay`).
import { CLIENT_ROUTE_DEFINITIONS } from "../contracts/client-routes.js";
import { db } from "../db.js";
import { localDateISO } from "./shared.js";

const MAX_BATCH = 20;
const MAX_N = 50;
const SUMMARY_DAYS = 30;
const SUMMARY_LIMIT = 25;
const RETENTION_DAYS = 90;

type RouteDefs = typeof CLIENT_ROUTE_DEFINITIONS;

/** Every key the counter may store, sorted. Homes, views, `view/section`, and the home a view lives under. */
export function uiViewKeys(defs: RouteDefs = CLIENT_ROUTE_DEFINITIONS): string[] {
  const keys = new Set<string>();
  for (const home of defs.homes) keys.add(home);
  const homesByView = defs.viewHomes as Record<string, string>;
  for (const view of Object.keys(homesByView)) keys.add(view);
  for (const [group, sections] of Object.entries(defs.sections)) {
    const home = homesByView[group];
    for (const section of sections) {
      keys.add(`${group}/${section}`);
      if (home) keys.add(`${home}/${section}`);
    }
  }
  for (const [section, home] of Object.entries(defs.planHomes)) {
    keys.add(`plan/${section}`);
    keys.add(`${home}/${section}`);
  }
  return [...keys].sort();
}

const UI_VIEW_KEY_SET: ReadonlySet<string> = new Set(uiViewKeys());

export function isUiViewKey(value: unknown): value is string {
  return typeof value === "string" && UI_VIEW_KEY_SET.has(value);
}

export type UiViewCountInput = { view: string; n: number };

/**
 * A batch is all-or-nothing: one unknown key or one out-of-range count rejects
 * the whole body. Unknown-but-shaped keys are rejected, not dropped.
 */
export function parseUiViewBatch(body: unknown): UiViewCountInput[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const views = (body as { views?: unknown }).views;
  if (!Array.isArray(views) || views.length < 1 || views.length > MAX_BATCH) return null;
  const parsed: UiViewCountInput[] = [];
  for (const value of views) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as { view?: unknown; n?: unknown };
    if (!isUiViewKey(row.view)) return null;
    if (typeof row.n !== "number" || !Number.isInteger(row.n) || row.n < 1 || row.n > MAX_N) return null;
    parsed.push({ view: row.view, n: row.n });
  }
  return parsed;
}

/** Calendar arithmetic on a YYYY-MM-DD string; never a millisecond offset in a local zone. */
function shiftIsoDay(iso: string, daysBack: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - daysBack)).toISOString().slice(0, 10);
}

function localDayShift(daysBack: number, now: number): string {
  return shiftIsoDay(localDateISO(new Date(now)), daysBack);
}

/**
 * The day a batch is stamped with. A beacon cannot carry the device zone, so the
 * client sends its own calendar day; it is honoured only when it is a real
 * YYYY-MM-DD within one day of the server's own date, else the server date wins.
 */
export function resolveUiViewDay(raw: unknown, serverDay: string = localDateISO()): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return serverDay;
  if (shiftIsoDay(raw, 0) !== raw) return serverDay;
  if (raw === serverDay || raw === shiftIsoDay(serverDay, 1) || raw === shiftIsoDay(serverDay, -1)) return raw;
  return serverDay;
}

/** Add opens for today's local date. Duplicate views in one batch sum, clamped to the per-key cap. */
export function recordUiViewCounts(entries: readonly UiViewCountInput[], day = localDateISO()): void {
  const merged = new Map<string, number>();
  for (const entry of entries) {
    if (!isUiViewKey(entry.view)) continue;
    if (!Number.isInteger(entry.n) || entry.n < 1 || entry.n > MAX_N) continue;
    merged.set(entry.view, Math.min(MAX_N, (merged.get(entry.view) ?? 0) + entry.n));
  }
  if (!merged.size) return;
  const stmt = db.prepare(
    `INSERT INTO ui_view_counts (day, view, opens) VALUES (?, ?, ?)
     ON CONFLICT(day, view) DO UPDATE SET opens = opens + excluded.opens`
  );
  db.exec("BEGIN");
  try {
    for (const [view, n] of merged) stmt.run(day, view, n);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the failed statement already rolled the transaction back */
    }
    throw err;
  }
}

export type UiViewSummaryRow = { view: string; opens: number };

/** Last 30 local days, highest first, at most 25 views. Ties break by view name. */
export function uiViewSummary(now = Date.now()): UiViewSummaryRow[] {
  const since = localDayShift(SUMMARY_DAYS - 1, now);
  const rows = db
    .prepare(
      `SELECT view, SUM(opens) AS opens FROM ui_view_counts
        WHERE day >= ? GROUP BY view ORDER BY opens DESC, view ASC LIMIT ?`
    )
    .all(since, SUMMARY_LIMIT) as { view: string; opens: number }[];
  return rows.map((row) => ({ view: String(row.view), opens: Number(row.opens) }));
}

/** Drop days strictly older than 90. Called from the diagnostics prune. */
export function pruneUiViewCounts(now = Date.now()): void {
  const cutoff = localDayShift(RETENTION_DAYS, now);
  db.prepare(`DELETE FROM ui_view_counts WHERE day < ?`).run(cutoff);
}
