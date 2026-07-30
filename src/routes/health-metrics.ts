import { Router } from "express";
import {
  getDailyMetrics,
  getRecoveryBaselineRead,
  getRecoverySummary,
  recordDailyMetrics,
} from "../domain/health/index.js";
import { appleHealthConnectionForRequest } from "../auth.js";
import { markAppleHealthConnectionUsed } from "../repo/apple-health.js";
import type { Request } from "express";

export const healthMetricsRouter = Router();

// ---- source-agnostic daily metrics (T5D: Apple Health via Shortcuts) ----
// The documented Apple Shortcuts automation POSTs here. The body is EITHER one
// row OR an array of rows (a Shortcut can batch a backfill of several days), so
// we normalize to a list and upsert each via UNIQUE(source,date) — fully
// idempotent: re-posting a day overwrites it. Each row carries an optional
// `source` (default 'apple') and a `date` (YYYY-MM-DD, required per row), plus
// any of steps/sleep/recovery plus best-effort Apple activity/cardio fields and a
// free-form `raw` blob preserved verbatim for later.
export function healthMetricSource(rowSource: unknown, forcedSource?: string): string {
  const source = forcedSource ?? rowSource;
  return String(source || "apple");
}

export function healthMetricSourceForRequest(req: Request): string | undefined {
  return appleHealthConnectionForRequest(req) == null ? undefined : "apple_health";
}

export function ingestHealthMetrics(body: any = {}, forcedSource?: string) {
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
      saved.push(
        recordDailyMetrics(healthMetricSource(row.source, forcedSource), String(row.date), {
          steps: row.steps,
          sleep_min: row.sleep_min,
          sleep_score: row.sleep_score,
          resting_hr: row.resting_hr,
          hrv_ms: row.hrv_ms,
          active_calories: row.active_calories,
          total_calories: row.total_calories,
          distance_km: row.distance_km,
          exercise_min: row.exercise_min,
          stand_hours: row.stand_hours,
          spo2_avg: row.spo2_avg,
          vo2max: row.vo2max,
          raw: row.raw,
        })
      );
    } catch (e: any) {
      errors.push({ date: row.date, error: e?.message ?? "write failed" });
    }
  }
  return { ok: errors.length === 0, saved: saved.length, rows: saved, errors };
}

export function shouldMarkAppleHealthUsed(result: { ok?: unknown; saved?: unknown }): boolean {
  return Number(result.saved) > 0;
}

// Ingest one row or a batch of source-agnostic daily metrics (Apple Health via Shortcuts).
healthMetricsRouter.post("/health-metrics", (req, res) => {
  const connectionId = appleHealthConnectionForRequest(req);
  // A scoped Shortcut credential owns its provenance: caller-supplied source
  // values are ignored for every body shape. Owner-authenticated/manual writes
  // retain the existing source behavior.
  const result = ingestHealthMetrics(req.body ?? {}, healthMetricSourceForRequest(req));
  if (connectionId != null && shouldMarkAppleHealthUsed(result)) {
    markAppleHealthConnectionUsed(connectionId);
  }
  res.json(result);
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

// Personal-baseline recovery bands: today's HRV / resting HR / sleep vs the
// athlete's own range — their newest 28 readings from within the last 180 days,
// so an episodic wearer has one too — each a plain-language phrase (no score). A
// dimension without enough readings is simply absent; `{ dimensions: [] }` when
// there's nothing to say. When the newest reading is too old to speak for today,
// `position`/`current` are null: the band still renders, dotless, with its
// provenance (`readings`, `span_days`, `last_reading_date`) so the client can date
// it honestly. Drives the quiet band rows under the Today wearable card.
healthMetricsRouter.get("/recovery/baseline", (_req, res) => res.json(getRecoveryBaselineRead()));
