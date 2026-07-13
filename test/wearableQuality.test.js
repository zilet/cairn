import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, localDaysAgo } from "./_seed.js";
import { emitMaterialGarminRecoveryTransition, materialGarminRecoveryTransition } from "../dist/garmin.js";
import { flushBrainEventsForTest, resetBrainEventsForTest } from "../dist/brainEvents.js";
import { registerPersonTools } from "../dist/surfaces/mcp/person.js";
import { ingestHealthMetrics } from "../dist/routes/health-metrics.js";

test("Garmin current signals use the latest dated non-null row while averages stay separate", () => {
  repo.upsertGarminDailyMetric({
    date: localDaysAgo(2),
    training_readiness: 86,
    training_status: "ZZZ_RECOVERY_2",
    hrv_status: "ZZZ_OLD",
  });
  repo.upsertGarminDailyMetric({ date: localDaysAgo(1), training_readiness: 55.7 });
  repo.upsertGarminDailyMetric({
    date: localDaysAgo(0),
    training_readiness: 26,
    training_status: "PRODUCTIVE_9",
    hrv_status: "BALANCED",
  });

  const recovery = repo.getGarminCoachSummary(14).recovery;
  assert.equal(recovery.training_readiness, 26);
  assert.equal(recovery.avg_training_readiness, 55.9);
  assert.equal(recovery.training_status, "PRODUCTIVE_9");
  assert.equal(recovery.hrv_status, "BALANCED");
  assert.deepEqual(
    {
      value: recovery.quality.training_readiness.latest_value,
      date: recovery.quality.training_readiness.latest_date,
      source: recovery.quality.training_readiness.source,
      samples: recovery.quality.training_readiness.sample_count,
      freshness: recovery.quality.training_readiness.freshness,
    },
    { value: 26, date: localDaysAgo(0), source: "garmin", samples: 3, freshness: "fresh" }
  );
});

test("unified recovery resolves generic sources per field and preserves partial reposts", () => {
  const date = localDaysAgo(0);
  repo.recordDailyMetrics("apple", date, {
    steps: 9000,
    sleep_min: 430,
    spo2_avg: 97,
    vo2max: 49.2,
    raw: { original: true },
  });
  repo.recordDailyMetrics("apple", date, {
    steps: null,
    sleep_min: undefined,
    active_calories: 540,
    spo2_avg: null,
    vo2max: null,
  });
  repo.recordDailyMetrics("oura", date, { hrv_ms: 62 });

  const apple = repo.getDailyMetrics("apple", 14)[0];
  assert.equal(apple.steps, 9000);
  assert.equal(apple.sleep_min, 430);
  assert.equal(apple.spo2_avg, 97);
  assert.equal(apple.vo2max, 49.2);
  assert.deepEqual(apple.raw, { original: true });

  const summary = repo.getRecoverySummary(14, { source: null, activities: [], hard_sessions: [] });
  assert.equal(summary.recovery.avg_steps, 9000);
  assert.equal(summary.recovery.avg_sleep_min, 430);
  assert.equal(summary.recovery.avg_hrv_ms, 62);
  assert.equal(summary.quality.steps.source, "apple");
  assert.equal(summary.quality.hrv_ms.source, "oura");
  assert.deepEqual(summary.sources.sort(), ["apple", "oura"]);
});

test("blank REST-shaped metrics remain absent and MCP nullable fields preserve prior values", async () => {
  const date = localDaysAgo(0);
  const blank = repo.recordDailyMetrics("shortcut", date, { steps: " ", spo2_avg: "", vo2max: null });
  assert.equal(blank.steps, null);
  assert.equal(blank.spo2_avg, null);
  assert.equal(blank.vo2max, null);

  repo.recordDailyMetrics("apple", date, { spo2_avg: 96, vo2max: 48 });
  const tools = new Map();
  registerPersonTools({
    tool(name, _description, _schema, handler) {
      tools.set(name, handler);
    },
  });
  const result = await tools.get("record_daily_metrics")({
    date,
    source: "apple",
    spo2_avg: null,
    vo2max: null,
  });
  const saved = JSON.parse(result.content[0].text);
  assert.equal(saved.spo2_avg, 96);
  assert.equal(saved.vo2max, 48);
});

test("Apple Health REST contract is idempotent and resolves one signal per date", () => {
  const date = localDaysAgo(0);
  const first = ingestHealthMetrics({
    source: "apple_health",
    date,
    steps: 8123,
    resting_hr: 52,
  });
  assert.equal(first.ok, true);
  assert.equal(first.saved, 1);
  const repost = ingestHealthMetrics({ source: "apple_health", date, hrv_ms: 61 });
  assert.equal(repost.ok, true);
  assert.equal(repost.rows[0].steps, 8123);
  assert.equal(repost.rows[0].hrv_ms, 61);
  assert.equal(repo.getDailyMetrics("apple_health", 14).length, 1);

  // A legacy `apple` row can coexist during upgrade, but recovery resolves each
  // date/signal once instead of averaging two copies of the same Health data.
  ingestHealthMetrics({ source: "apple", date, steps: 9000 });
  const summary = repo.getRecoverySummary(14, { source: null, activities: [], hard_sessions: [] });
  assert.equal(summary.quality.steps.sample_count, 1);
  assert.ok([8123, 9000].includes(summary.recovery.avg_steps));

  const invalid = ingestHealthMetrics({ source: "apple_health", steps: 1 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.saved, 0);
  assert.deepEqual(invalid.errors, [{ error: "date required" }]);
});

test("rich-only recovery counts as data and sparse SpO2 reports honest coverage", () => {
  repo.upsertGarminDailyMetric({ date: localDaysAgo(0), training_status: "PRODUCTIVE", spo2_avg: 92 });
  const summary = repo.getRecoverySummary(14);
  assert.equal(summary.has_data, true);
  assert.equal(summary.recovery.training_status, "PRODUCTIVE");
  assert.equal(summary.recovery.spo2_avg, 92);
  assert.equal(summary.recovery.avg_spo2, 92);
  assert.equal(summary.quality.spo2_avg.sample_count, 1);
  assert.equal(summary.quality.spo2_avg.expected_days, 14);
});

test("generic daily metrics validate boundaries and accept extended Apple fields", () => {
  const date = localDaysAgo(0);
  const saved = repo.recordDailyMetrics("apple", date, {
    total_calories: 2410,
    distance_km: 8.4,
    exercise_min: 51,
    stand_hours: 13,
    spo2_avg: 97,
    vo2max: 49.2,
  });
  assert.equal(saved.total_calories, 2410);
  assert.equal(saved.distance_km, 8.4);
  assert.equal(saved.exercise_min, 51);
  assert.equal(saved.stand_hours, 13);
  assert.equal(saved.spo2_avg, 97);
  assert.equal(saved.vo2max, 49.2);
  assert.throws(() => repo.recordDailyMetrics("apple", "2026-02-30", { steps: 1 }), /real YYYY-MM-DD/);
  assert.throws(() => repo.recordDailyMetrics("x".repeat(65), date, { steps: 1 }), /64 characters/);
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  assert.throws(() => repo.recordDailyMetrics("apple", tomorrow, { steps: 1 }), /future/);

  db.prepare(`INSERT INTO daily_metrics (source, date, steps) VALUES ('manual', ?, 12345)`).run(tomorrow);
  assert.equal(
    repo.getDailyMetrics(null, 30).some((row) => row.date === tomorrow),
    false
  );
  assert.equal(repo.getRecoverySummary(30).recovery.avg_steps, null);
});

test("spo2_avg normalizes a HealthKit 0.0-1.0 fraction to percent and rejects implausible values", () => {
  const fraction = repo.recordDailyMetrics("apple", localDaysAgo(3), { spo2_avg: 0.98 });
  assert.equal(fraction.spo2_avg, 98);

  const implausible = repo.recordDailyMetrics("apple", localDaysAgo(2), { spo2_avg: 45 });
  assert.equal(implausible.spo2_avg, null);

  const genuinePercent = repo.recordDailyMetrics("apple", localDaysAgo(1), { spo2_avg: 98 });
  assert.equal(genuinePercent.spo2_avg, 98);
});

test("Garmin re-sync refreshes the activity mirror without sparse erasure", () => {
  const first = repo.upsertGarminActivity({
    external_id: "mirror-1",
    date: localDaysAgo(2),
    type: "running",
    name: "Morning run",
    duration_min: 40,
    distance_km: 7,
    avg_hr: 145,
  });
  db.prepare(
    `UPDATE activities SET date = '2020-01-01', type = 'other', duration_min = 1, distance_km = 0.1 WHERE id = ?`
  ).run(first.activity_id);
  repo.upsertGarminActivity({
    external_id: "mirror-1",
    date: localDaysAgo(1),
    type: "treadmill_running",
    duration_min: 44,
    distance_km: 7.5,
  });
  let mirror = db.prepare(`SELECT * FROM activities WHERE id = ?`).get(first.activity_id);
  assert.equal(mirror.date, localDaysAgo(1));
  assert.equal(mirror.type, "run");
  assert.equal(mirror.duration_min, 44);
  assert.equal(mirror.distance_km, 7.5);

  repo.upsertGarminActivity({ external_id: "mirror-1" });
  mirror = db.prepare(`SELECT * FROM activities WHERE id = ?`).get(first.activity_id);
  assert.equal(mirror.date, localDaysAgo(1));
  assert.equal(mirror.duration_min, 44);
  assert.equal(mirror.distance_km, 7.5);
});

test("generic daily metrics are included in the JSON export with raw preserved", () => {
  repo.recordDailyMetrics("apple", localDaysAgo(0), { steps: 7777, raw: { source: "shortcut" } });
  const exported = repo.exportAll();
  assert.equal(exported.daily_metrics.length, 1);
  assert.equal(exported.daily_metrics[0].steps, 7777);
  assert.deepEqual(exported.daily_metrics[0].raw, { source: "shortcut" });
  assert.equal("raw_json" in exported.daily_metrics[0], false);
});

test("DayRead uses only fresh current readiness for a current decision", () => {
  const today = localDaysAgo(0);
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3 }]);
  const stale = repo.dayRead(today, {
    has_data: true,
    recovery: { training_readiness: 20, avg_training_readiness: 20 },
    quality: {
      training_readiness: { latest_date: localDaysAgo(5), freshness: "stale", sample_count: 1, window_days: 14 },
    },
  });
  assert.notEqual(stale.kind, "rest");
  assert.equal(stale.signals.fatigue.low_readiness, false);

  const fresh = repo.dayRead(today, {
    has_data: true,
    recovery: { training_readiness: 20, avg_training_readiness: 56 },
    quality: { training_readiness: { latest_date: today, freshness: "fresh", sample_count: 5, window_days: 14 } },
  });
  // A lone wearable recovery constraint is deliberately conservative: it owns an
  // easier day, but without corroborating fatigue/health evidence it does not
  // manufacture a hard rest verdict.
  assert.equal(fresh.kind, "easy");
  assert.equal(fresh.signals.fatigue.low_readiness, true);
  assert.equal(fresh.signals.fatigue.readiness.window_average, 56);
});

test("material Garmin recovery transition is bounded and unchanged state emits none", () => {
  const before = {
    recovery: {
      training_readiness: 42,
      training_status: "MAINTAINING",
      quality: { training_readiness: { freshness: "fresh" } },
    },
  };
  const after = {
    recovery: {
      training_readiness: 26,
      training_status: "PRODUCTIVE",
      quality: { training_readiness: { freshness: "fresh" } },
    },
  };
  assert.match(materialGarminRecoveryTransition(before, after), /crossed low/);
  assert.equal(materialGarminRecoveryTransition(after, after), null);
});

test("first Garmin sync emits one material event only for low readiness or an adverse status", () => {
  resetBrainEventsForTest();
  const missing = {
    recovery: {
      training_readiness: null,
      training_status: null,
      quality: { training_readiness: { freshness: "missing" } },
    },
  };
  const low = {
    recovery: {
      training_readiness: 24,
      training_status: "STRAINED_2",
      quality: { training_readiness: { freshness: "fresh" } },
    },
  };
  assert.match(emitMaterialGarminRecoveryTransition(missing, low, 7, localDaysAgo(0)), /readiness is low/);
  assert.equal(emitMaterialGarminRecoveryTransition(low, low, 7, localDaysAgo(0)), null);
  const events = flushBrainEventsForTest(10_000, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].material, true);
  assert.equal(events[0].review, true);

  assert.match(
    materialGarminRecoveryTransition(missing, {
      recovery: {
        training_readiness: 60,
        training_status: "UNPRODUCTIVE_3",
        quality: { training_readiness: { freshness: "fresh" } },
      },
    }),
    /training status is UNPRODUCTIVE_3/
  );
  assert.equal(
    materialGarminRecoveryTransition(missing, {
      recovery: {
        training_readiness: 60,
        training_status: "PRODUCTIVE_9",
        quality: { training_readiness: { freshness: "fresh" } },
      },
    }),
    null
  );
});
