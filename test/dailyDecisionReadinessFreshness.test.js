import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { gatherDailyDecisionSnapshot } from "../dist/repo/daily-decision.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { repo, resetTables } from "./_seed.js";

// A stale wearable reading behaves as ABSENT, never as current (CLAUDE.md /
// sensor-freshness.ts). training_readiness's freshness horizon is 1 day, so a
// reading dated yesterday still drives the volume clamp, but anything older
// must degrade to null exactly like a missing reading — never fall through to
// the 14-day average as a workaround.

const DATE = "2031-07-20";

beforeEach(() => {
  resetTables("daily_metrics", "garmin_daily_metrics", "plan_days", "plan_items");
});

test("a reading dated today drives readiness", () => {
  repo.upsertGarminDailyMetric({ date: DATE, training_readiness: 80, hrv: 55 });
  const snap = gatherDailyDecisionSnapshot(DATE);
  assert.equal(snap.recovery.readiness, "high");
});

test("a reading dated yesterday (the freshness horizon) still drives readiness", () => {
  const yesterday = addDaysISO(DATE, -1);
  repo.upsertGarminDailyMetric({ date: yesterday, training_readiness: 20, hrv: 55 });
  const snap = gatherDailyDecisionSnapshot(DATE);
  assert.equal(snap.recovery.readiness, "low");
});

test("a reading older than the freshness horizon is treated as absent, not as a stale current value", () => {
  const stale = addDaysISO(DATE, -2);
  repo.upsertGarminDailyMetric({ date: stale, training_readiness: 10, hrv: 55 });
  const snap = gatherDailyDecisionSnapshot(DATE);
  assert.equal(snap.recovery.readiness, null);
});

test("a stale current reading does not fall through to the 14-day average", () => {
  // A 3-day-old reading is itself stale, but readings from earlier in the same
  // 14-day window would otherwise let avg_training_readiness quietly stand in
  // for it. The gate must reject that fallback, not just the raw value.
  repo.upsertGarminDailyMetric({ date: addDaysISO(DATE, -3), training_readiness: 10, hrv: 55 });
  repo.upsertGarminDailyMetric({ date: addDaysISO(DATE, -10), training_readiness: 90, hrv: 55 });
  const snap = gatherDailyDecisionSnapshot(DATE);
  assert.equal(snap.recovery.readiness, null);
});
