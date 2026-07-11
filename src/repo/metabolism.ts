import { db } from "../db.js";
import { extractMeasuredRmr, type MeasuredRmrReading } from "./metabolism-core.js";

export function latestMeasuredRmr(): MeasuredRmrReading | null {
  const profile = db
    .prepare(`SELECT measured_rmr_kcal, measured_rmr_date, measured_rmr_source FROM profile WHERE id = 1`)
    .get() as any;
  const stored = Number(profile?.measured_rmr_kcal);
  if (Number.isFinite(stored) && stored >= 700 && stored <= 5_000) {
    return {
      kcal: Math.round(stored),
      date: profile?.measured_rmr_date || null,
      source: profile?.measured_rmr_source || "metabolic_test",
    };
  }
  return syncMeasuredRmrFromHealthDocs();
}

export function syncMeasuredRmrFromHealthDocs(): MeasuredRmrReading | null {
  const rows = db
    .prepare(
      `SELECT id, kind, doc_date, parsed_json, summary
         FROM health_documents
        WHERE lower(COALESCE(kind,'')) = 'metabolic_test'
        ORDER BY COALESCE(doc_date, substr(created_at,1,10)) DESC, id DESC`
    )
    .all() as any[];
  const reading = rows.map(extractMeasuredRmr).find((row): row is MeasuredRmrReading => row != null) ?? null;
  if (!reading) {
    // A deleted/reclassified source must not leave a ghost measurement behind.
    // Only clear values owned by this importer; a future explicit/manual source
    // remains authoritative.
    db.prepare(
      `UPDATE profile
          SET measured_rmr_kcal = NULL, measured_rmr_date = NULL, measured_rmr_source = NULL,
              updated_at = datetime('now')
        WHERE id = 1 AND measured_rmr_source = 'metabolic_test'`
    ).run();
    return null;
  }
  db.prepare(
    `UPDATE profile
        SET measured_rmr_kcal = ?, measured_rmr_date = ?, measured_rmr_source = ?, updated_at = datetime('now')
      WHERE id = 1`
  ).run(reading.kcal, reading.date, reading.source);
  return reading;
}

export function measuredRmrActivityTdee(days = 21): { tdee: number; active_calories: number; days: number } | null {
  const rmr = latestMeasuredRmr();
  if (!rmr) return null;
  const rows = db
    .prepare(
      `SELECT active_calories FROM garmin_daily_metrics
        WHERE date >= date('now', ?) AND active_calories IS NOT NULL AND active_calories >= 0`
    )
    .all(`-${Math.max(1, Math.trunc(days) - 1)} day`) as any[];
  const values = rows.map((row) => Number(row.active_calories)).filter(Number.isFinite);
  if (values.length < 7) return null;
  const active = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  return { tdee: rmr.kcal + active, active_calories: active, days: values.length };
}
