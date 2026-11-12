// Old Garmin daily payloads, kept lean.
//
// `garmin_daily_metrics.raw_json` stores the provider's whole day — around 180 KB of
// it, and roughly 165 KB of that is per-minute time series (sleep movement, the SpO₂ /
// respiration / heart-rate / stress / body-battery epochs, every HRV reading) that
// nothing reads back from the database. The normalized columns carry what the sync
// derived from them, and the only DB readers of the blob want summaries:
// `trainingReadiness[]` (repo/read-adherence.ts) and `hrv.hrvSummary.baseline`
// (repo/propagation.ts).
//
// The sync only ever rewrites the last 14 days, so a row older than 30 days is
// settled. The nightly maintenance pass strips ONLY the time-series keys below from
// those rows: every summary object (`sleep.dailySleepDTO`, `hrv.hrvSummary`,
// `trainingReadiness`, `summary`, `weight`, …) stays, `updated_at` is not touched (the
// day's facts did not change), and a row already compact is not rewritten. A manual
// re-sync of an old day restores the full payload; the next night compacts it again.

import { db } from "../db.js";
import { addDaysISO, localDateISO } from "./shared.js";

/** Rows older than this many days are compacted. The sync rewrites at most 14. */
export const GARMIN_RAW_COMPACT_AFTER_DAYS = 30;

/** The per-minute series stripped from an old day's payload — nothing else. */
export const GARMIN_RAW_TIME_SERIES_PATHS = [
  "$.sleep.sleepMovement",
  "$.sleep.wellnessEpochSPO2DataDTOList",
  "$.sleep.wellnessEpochRespirationDataDTOList",
  "$.sleep.sleepHeartRate",
  "$.sleep.sleepStress",
  "$.sleep.sleepBodyBattery",
  "$.sleep.hrvData",
  "$.hrv.hrvReadings",
] as const;

/** Rows rewritten per statement, so one night's first pass never holds a huge write. */
const COMPACT_BATCH = 50;

/** A compaction that rewrote more rows than this is worth giving the space back. */
export const GARMIN_RAW_RECLAIM_MIN_ROWS = 5;

const HAS_SERIES = GARMIN_RAW_TIME_SERIES_PATHS.map((p) => `json_type(raw_json, '${p}') IS NOT NULL`).join(" OR ");

/**
 * Strip the time series from every daily payload older than the cutoff. Idempotent:
 * a compact row matches nothing and is never rewritten. Returns how many rows changed.
 */
export function compactOldGarminRawPayloads(opts: { today?: string; olderThanDays?: number } = {}): {
  compacted: number;
  cutoff: string;
} {
  const today = opts.today ?? localDateISO();
  const cutoff = addDaysISO(today, -Math.max(1, Math.trunc(opts.olderThanDays ?? GARMIN_RAW_COMPACT_AFTER_DAYS)));
  if (!cutoff) return { compacted: 0, cutoff: "" }; // an unreadable "today" compacts nothing
  const pick = db.prepare(
    `SELECT id FROM garmin_daily_metrics
      WHERE date < ? AND raw_json IS NOT NULL AND json_valid(raw_json) AND (${HAS_SERIES})
      ORDER BY id LIMIT ${COMPACT_BATCH}`
  );
  const strip = db.prepare(
    `UPDATE garmin_daily_metrics SET raw_json = json_remove(raw_json, ${GARMIN_RAW_TIME_SERIES_PATHS.map((p) => `'${p}'`).join(", ")})
      WHERE id = ?`
  );
  let compacted = 0;
  // Bounded: each round rewrites at most COMPACT_BATCH rows, and a rewritten row no
  // longer matches, so the loop ends once the backlog is drained.
  for (let round = 0; round < 10_000; round++) {
    const ids = (pick.all(cutoff) as Array<{ id: number }>).map((r) => Number(r.id));
    if (!ids.length) break;
    db.exec("BEGIN");
    try {
      for (const id of ids) compacted += Number(strip.run(id).changes);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return { compacted, cutoff };
}

/**
 * Give the freed pages back to the filesystem: checkpoint the WAL down to nothing, then
 * VACUUM. Never throws — a failure (a reader holding the WAL, a transaction open on the
 * connection, a full disk) is reported and the next night simply tries again.
 */
export function reclaimDatabaseSpace(): { ok: boolean; error?: string } {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
