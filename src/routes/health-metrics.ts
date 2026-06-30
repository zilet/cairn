import { Router } from "express";
import { getDailyMetrics, getRecoverySummary, recordDailyMetrics } from "../domain/health/index.js";

export const healthMetricsRouter = Router();

// ---- source-agnostic daily metrics (T5D: Apple Health via Shortcuts) ----
// The documented Apple Shortcuts automation POSTs here. The body is EITHER one
// row OR an array of rows (a Shortcut can batch a backfill of several days), so
// we normalize to a list and upsert each via UNIQUE(source,date) — fully
// idempotent: re-posting a day overwrites it. Each row carries an optional
// `source` (default 'apple') and a `date` (YYYY-MM-DD, required per row), plus
// any of steps/sleep_min/sleep_score/resting_hr/hrv_ms/active_calories and a
// free-form `raw` blob preserved verbatim for later.
healthMetricsRouter.post("/health-metrics", (req, res) => {
  const body = req.body ?? {};
  // Cap the batch — a year of daily rows is a sane ceiling for a Shortcuts
  // backfill; the 25mb body limit + no auth means an unbounded loop of
  // synchronous sqlite upserts is otherwise possible. Per-row values are
  // coerced/clamped in repo.recordDailyMetrics (the trust boundary shared by
  // REST + MCP).
  const rows: any[] = (Array.isArray(body) ? body : Array.isArray(body.rows) ? body.rows : [body]).slice(0, 366);
  const saved: any[] = [];
  const errors: { date?: string; error: string }[] = [];
  for (const r of rows) {
    const row = r ?? {};
    if (!row.date) {
      errors.push({ error: "date required" });
      continue;
    }
    try {
      saved.push(recordDailyMetrics(row.source ?? "apple", String(row.date), {
        steps: row.steps,
        sleep_min: row.sleep_min,
        sleep_score: row.sleep_score,
        resting_hr: row.resting_hr,
        hrv_ms: row.hrv_ms,
        active_calories: row.active_calories,
        raw: row.raw,
      }));
    } catch (e: any) {
      errors.push({ date: row.date, error: e?.message ?? "write failed" });
    }
  }
  res.json({ ok: errors.length === 0, saved: saved.length, rows: saved, errors });
});

// Recent metrics for a source (default all sources) over the last N days.
healthMetricsRouter.get("/health-metrics", (req, res) => {
  const source = req.query.source ? String(req.query.source) : null;
  const days = req.query.days ? Number(req.query.days) : 30;
  res.json(getDailyMetrics(source, Number.isFinite(days) ? days : 30));
});

// Unified recovery view (Garmin + Apple/other merged) — graceful when empty.
healthMetricsRouter.get("/recovery", (req, res) =>
  res.json(getRecoverySummary(req.query.days ? Number(req.query.days) : 14))
);
