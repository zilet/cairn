// signals.wearable_last_night: the one boolean the Brief uses to stop pushing the
// morning check-in once the watch has already measured last night. Judged by the
// server's own isLastNight rule — a night before last is ABSENT, never "fresh".
import assert from "node:assert/strict";
import test from "node:test";
import { repo, resetTables, seedSleep } from "./_seed.js";

const REF = "2026-03-15";
const shift = (base, n) => new Date(new Date(base + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);

test("wearable_last_night is true only when last night's own reading exists", () => {
  resetTables("daily_metrics", "garmin_daily_metrics", "day_reads");
  assert.equal(repo.dayRead(REF).signals.wearable_last_night, false, "no wearable data: today's behavior");

  seedSleep(shift(REF, -1), 450);
  assert.equal(repo.dayRead(REF).signals.wearable_last_night, false, "the night before last is not last night");

  seedSleep(REF, 450);
  assert.equal(repo.dayRead(REF).signals.wearable_last_night, true);
});

test("an HRV reading on last night alone counts; a night with no HRV value never does", () => {
  resetTables("daily_metrics", "garmin_daily_metrics", "day_reads");
  repo.recordDailyMetrics("apple", REF, { resting_hr: 55 });
  assert.equal(repo.dayRead(REF).signals.wearable_last_night, false, "an absent HRV is no reading (never Number(null))");
  resetTables("daily_metrics", "garmin_daily_metrics", "day_reads");
  repo.recordDailyMetrics("apple", REF, { hrv_ms: 48 });
  assert.equal(repo.dayRead(REF).signals.wearable_last_night, true, "HRV-only last night");
});
