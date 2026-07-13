import { db } from "../db.js";
import { LB_PER_KG, localDateISO } from "./shared.js";

export type CanonicalBodyweightSource = "manual" | "garmin";

export interface CanonicalBodyweightPoint {
  date: string;
  weight_lb: number;
  source: CanonicalBodyweightSource;
  source_id: number;
  provenance: "bodyweight_log.weight_lb" | "garmin_daily_metrics.weight_kg";
}

export interface ResolvedCurrentBodyweight {
  date: string | null;
  weight_lb: number;
  source: CanonicalBodyweightSource | "profile";
  source_id: number | null;
  provenance: CanonicalBodyweightPoint["provenance"] | "profile.weight_lb";
}

function dateRange(column: string, since?: string | null, through?: string | null) {
  const clauses: string[] = [];
  const values: string[] = [];
  if (since) {
    clauses.push(`${column} >= ?`);
    values.push(since);
  }
  if (through) {
    clauses.push(`${column} <= ?`);
    values.push(through);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", values };
}

// Internal calculation series: one lb-valued point per calendar date. Garmin
// fills dates that have no explicit weigh-in; the latest explicit manual row for
// a date wins every same-date collision. Public listWeight remains manual-only.
export function canonicalBodyweightSeries(
  opts: { since?: string | null; through?: string | null } = {}
): CanonicalBodyweightPoint[] {
  const garminRange = dateRange("date", opts.since, opts.through);
  const manualRange = dateRange("date", opts.since, opts.through);
  const garminRows = db
    .prepare(
      `SELECT id, date, weight_kg
         FROM garmin_daily_metrics
        WHERE weight_kg IS NOT NULL${garminRange.sql}
        ORDER BY date, id`
    )
    .all(...garminRange.values) as any[];
  const manualRows = db
    .prepare(
      `SELECT id, date, weight_lb
         FROM bodyweight_log
        WHERE weight_lb IS NOT NULL${manualRange.sql}
        ORDER BY date, id`
    )
    .all(...manualRange.values) as any[];

  const byDate = new Map<string, CanonicalBodyweightPoint>();
  for (const row of garminRows) {
    const date = String(row.date ?? "").slice(0, 10);
    const kg = Number(row.weight_kg);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(kg) || kg <= 0) continue;
    byDate.set(date, {
      date,
      weight_lb: Math.round(kg * LB_PER_KG * 100) / 100,
      source: "garmin",
      source_id: Number(row.id),
      provenance: "garmin_daily_metrics.weight_kg",
    });
  }
  // Manual rows are applied second, so an explicit entry always owns its date.
  // ORDER BY id means the latest manual correction wins among manual duplicates.
  for (const row of manualRows) {
    const date = String(row.date ?? "").slice(0, 10);
    const lb = Number(row.weight_lb);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(lb) || lb <= 0) continue;
    byDate.set(date, {
      date,
      weight_lb: lb,
      source: "manual",
      source_id: Number(row.id),
      provenance: "bodyweight_log.weight_lb",
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Calculations prefer the latest canonical scale point through the requested
// day. The profile is a cold-start fallback only; resolving never writes back.
export function resolvedCurrentBodyweight(profile?: any, through = localDateISO()): ResolvedCurrentBodyweight | null {
  const canonical = canonicalBodyweightSeries({ through });
  const latest = canonical.at(-1);
  if (latest) return latest;
  const profileLb = Number(profile?.weight_lb);
  if (!Number.isFinite(profileLb) || profileLb <= 0) return null;
  return {
    date: null,
    weight_lb: profileLb,
    source: "profile",
    source_id: null,
    provenance: "profile.weight_lb",
  };
}
