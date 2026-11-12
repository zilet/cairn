// Storage housekeeping the nightly maintenance pass runs: old Garmin day payloads lose
// the per-minute series nothing reads back (src/repo/garmin-raw-compaction.ts), and
// finished agent-job rows past retention are pruned (they used to go only at boot).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { db, repo, localDaysAgo } from "./_seed.js";
import {
  GARMIN_RAW_TIME_SERIES_PATHS,
  compactOldGarminRawPayloads,
  reclaimDatabaseSpace,
} from "../dist/repo/garmin-raw-compaction.js";

const OLD_STAMP = "2000-01-01 00:00:00";

// A day shaped like the real export: summaries next to big per-minute arrays.
function fatPayload() {
  const series = (n) => Array.from({ length: n }, (_, i) => ({ startGMT: `t${i}`, value: i % 7 }));
  return {
    sleep: {
      dailySleepDTO: { sleepTimeSeconds: 26880, sleepScores: { overall: { value: 81 } } },
      sleepMovement: series(400),
      wellnessEpochSPO2DataDTOList: series(400),
      wellnessEpochRespirationDataDTOList: series(400),
      sleepHeartRate: series(400),
      sleepStress: series(400),
      sleepBodyBattery: series(400),
      hrvData: series(100),
      restingHeartRate: 49,
    },
    hrv: {
      hrvSummary: { lastNightAvg: 61, baseline: { balancedLow: 55, balancedUpper: 70 } },
      hrvReadings: series(100),
    },
    // The wellness-service read the sync falls back to: the same sleep DTO shape.
    fullSleep: {
      dailySleepDTO: { sleepTimeSeconds: 26880, avgSleepStress: 14 },
      sleepMovement: series(400),
      sleepHeartRate: series(400),
      sleepStress: series(400),
      hrvData: series(100),
      restlessMomentsCount: 22,
    },
    trainingReadiness: [{ score: 72, level: "HIGH" }],
    summary: { totalSteps: 9000, restingHeartRate: 49 },
  };
}

function seedDay(date, raw = fatPayload()) {
  repo.upsertGarminDailyMetrics([{ date, steps: 9000, resting_hr: 49, raw }]);
  db.prepare(`UPDATE garmin_daily_metrics SET updated_at = ? WHERE date = ?`).run(OLD_STAMP, date);
}

const rawOf = (date) =>
  JSON.parse(db.prepare(`SELECT raw_json FROM garmin_daily_metrics WHERE date = ?`).get(date).raw_json);

test("an old day loses only the time series; summaries, readiness and updated_at stay", () => {
  const old = localDaysAgo(45);
  const recent = localDaysAgo(10);
  seedDay(old);
  seedDay(recent);
  const before = db.prepare(`SELECT length(raw_json) AS n FROM garmin_daily_metrics WHERE date = ?`).get(old).n;

  const out = compactOldGarminRawPayloads({ today: localDaysAgo(0) });
  assert.equal(out.compacted, 1, "only the day past 30 days");

  const raw = rawOf(old);
  for (const path of GARMIN_RAW_TIME_SERIES_PATHS) {
    const [, top, key] = path.split(".");
    assert.equal(raw[top]?.[key], undefined, `${path} is gone`);
  }
  assert.equal(raw.sleep.dailySleepDTO.sleepTimeSeconds, 26880, "the sleep summary stays");
  assert.equal(raw.sleep.restingHeartRate, 49, "scalar sleep fields stay");
  assert.deepEqual(raw.fullSleep.dailySleepDTO, { sleepTimeSeconds: 26880, avgSleepStress: 14 }, "fullSleep's summary stays");
  assert.equal(raw.fullSleep.restlessMomentsCount, 22, "fullSleep's scalars stay");
  assert.deepEqual(raw.hrv.hrvSummary.baseline, { balancedLow: 55, balancedUpper: 70 }, "the HRV baseline stays");
  assert.deepEqual(raw.trainingReadiness, [{ score: 72, level: "HIGH" }], "training readiness stays");
  assert.equal(raw.summary.totalSteps, 9000, "the daily summary stays");

  const after = db
    .prepare(`SELECT length(raw_json) AS n, updated_at FROM garmin_daily_metrics WHERE date = ?`)
    .get(old);
  assert.ok(after.n < before / 5, `the payload shrank (${before} → ${after.n} bytes)`);
  assert.equal(after.updated_at, OLD_STAMP, "the day's facts did not change, so neither does updated_at");
  assert.ok(Array.isArray(rawOf(recent).sleep.sleepMovement), "a recent day is untouched");
});

test("compaction is idempotent and skips rows that are already compact", () => {
  const old = localDaysAgo(40);
  seedDay(old);
  seedDay(localDaysAgo(60), { summary: { totalSteps: 1 } }); // never had series
  assert.equal(compactOldGarminRawPayloads().compacted, 1);
  const once = db.prepare(`SELECT raw_json FROM garmin_daily_metrics WHERE date = ?`).get(old).raw_json;
  assert.equal(compactOldGarminRawPayloads().compacted, 0, "nothing left to do");
  assert.equal(db.prepare(`SELECT raw_json FROM garmin_daily_metrics WHERE date = ?`).get(old).raw_json, once);
});

test("a large backlog drains in batches", () => {
  for (let i = 0; i < 120; i++) seedDay(localDaysAgo(31 + i));
  assert.equal(compactOldGarminRawPayloads().compacted, 120);
  assert.equal(compactOldGarminRawPayloads().compacted, 0);
});

test("reclaiming space reports instead of throwing, and leaves no WAL behind", () => {
  for (let i = 0; i < 20; i++) seedDay(localDaysAgo(31 + i));
  compactOldGarminRawPayloads();
  const ok = reclaimDatabaseSpace();
  assert.equal(ok.ok, true, ok.error);
  // VACUUM in WAL mode writes the rebuilt file into the WAL; the closing TRUNCATE
  // checkpoint is what hands that space back.
  const wal = `${process.env.DB_PATH}-wal`;
  if (db.prepare("PRAGMA journal_mode").get().journal_mode === "wal" && fs.existsSync(wal)) {
    assert.equal(fs.statSync(wal).size, 0, "the WAL was truncated after the VACUUM");
  }
  // Inside an open transaction VACUUM cannot run: the failure comes back as a value.
  db.exec("BEGIN");
  try {
    const refused = reclaimDatabaseSpace();
    assert.equal(refused.ok, false);
    assert.ok(refused.error);
  } finally {
    db.exec("ROLLBACK");
  }
});

test("finished agent jobs past retention are pruned; live and recent ones stay", () => {
  const insert = db.prepare(
    `INSERT INTO agent_jobs (kind, status, phase, input_json, finished_at) VALUES ('test', ?, ?, '{}', ?)`
  );
  insert.run("done", "done", "2000-01-01 00:00:00");
  insert.run("error", "error", "2000-01-01 00:00:00");
  insert.run("done", "done", new Date().toISOString().replace("T", " ").slice(0, 19));
  insert.run("queued", "queued", null);
  assert.equal(repo.pruneFinishedAgentJobs(), 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM agent_jobs`).get().n, 2);
  assert.equal(repo.pruneFinishedAgentJobs(), 0);
});
