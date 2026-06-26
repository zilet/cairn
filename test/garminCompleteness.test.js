// Garmin parsing-completeness fixes (the displayName/instrumentation/labeling/
// richer-metrics build). These lock in the parts that are deterministic + offline
// (no Garmin network): the strength-label preservation through the REAL upsert path
// and the new per-activity + daily runner columns round-tripping through the repo.
//
// The displayName fallback, rawGet instrumentation, fitness-age endpoint, and the
// runner-metric FETCHES can only be confirmed against a live Garmin sync — these
// tests cover the storage + surfacing seams those fetches feed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, isoDaysAgo } from "./_seed.js";

const TODAY = isoDaysAgo(0);

beforeEach(() => {
  for (const t of ["logged_sets", "session_skips", "sessions", "activities", "garmin_activities", "garmin_daily_metrics", "garmin_sources"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
});

test("a synced strength activity keeps a strength label so reconciliation finds it", () => {
  // normalizeGarminType folds strength_training → "other"; the old upsert stored
  // that, so every later isStrengthGarminType(stored.type) check missed it and the
  // real-path reconcile bailed. The stored type must still read as strength.
  const saved = repo.upsertGarminActivity({
    external_id: "ext-strength-real",
    date: TODAY,
    start_time: `${TODAY}T07:30:00`,
    type: "strength_training",
    name: "Push day",
    duration_min: 52,
  });
  assert.ok(saved && saved.id, "the activity persisted");
  assert.ok(repo.isStrengthGarminType(saved.type), `stored type "${saved.type}" still reads as strength`);

  // It therefore surfaces as an unreconciled lift (the real-sync path now works)...
  const unreconciled = repo.listUnreconciledGarminStrength(30);
  assert.equal(unreconciled.length, 1, "the synced lift surfaces as reconcilable");

  // ...and reconcileGarminStrength links it to a session (was a no-op on "other").
  const out = repo.reconcileGarminStrength(saved.id);
  assert.ok(out && out.session, "reconcile linked a Cairn session");
  assert.equal(repo.listUnreconciledGarminStrength(30).length, 0, "cleared once linked");
});

test("a cardio activity still folds to its coarse modality (unchanged)", () => {
  const saved = repo.upsertGarminActivity({
    external_id: "ext-run-real",
    date: TODAY,
    type: "treadmill_running",
    name: "Easy run",
    duration_min: 40,
    distance_km: 7,
  });
  assert.equal(saved.type, "run", "treadmill_running folds to run");
  assert.equal(repo.isStrengthGarminType(saved.type), false);
});

test("per-activity richness columns round-trip through the upsert (migration v46)", () => {
  const saved = repo.upsertGarminActivity({
    external_id: "ext-run-rich",
    date: TODAY,
    type: "running",
    name: "Tempo",
    duration_min: 45,
    distance_km: 9,
    steps: 8200,
    avg_stride_len: 1.18,
    min_elevation_m: 12,
    max_elevation_m: 48,
    lap_count: 6,
    avg_ground_contact_ms: 244,
    avg_vertical_osc_cm: 8.1,
    avg_vertical_ratio: 6.9,
  });
  const row = repo.getGarminActivity(saved.id);
  assert.equal(row.steps, 8200);
  assert.equal(row.avg_stride_len, 1.18);
  assert.equal(row.min_elevation_m, 12);
  assert.equal(row.max_elevation_m, 48);
  assert.equal(row.lap_count, 6);
  assert.equal(row.avg_ground_contact_ms, 244);
  assert.equal(row.avg_vertical_osc_cm, 8.1);
  assert.equal(row.avg_vertical_ratio, 6.9);
});

test("re-syncing a sparse activity never nulls richer per-activity values", () => {
  repo.upsertGarminActivity({
    external_id: "ext-resync", date: TODAY, type: "running", duration_min: 45,
    steps: 8200, avg_ground_contact_ms: 244,
  });
  // A later sparse sync of the SAME activity (no running dynamics) must COALESCE.
  const saved = repo.upsertGarminActivity({
    external_id: "ext-resync", date: TODAY, type: "running", duration_min: 45,
  });
  const row = repo.getGarminActivity(saved.id);
  assert.equal(row.steps, 8200, "steps preserved across a sparse re-sync");
  assert.equal(row.avg_ground_contact_ms, 244, "running dynamics preserved");
});

test("daily runner metrics surface through the coach + recovery summaries (migration v45)", () => {
  repo.upsertGarminDailyMetric({
    date: TODAY,
    vo2max: 52,
    endurance_score: 7100,
    hill_score: 62,
    race_predict_5k_sec: 1200,
    race_predict_10k_sec: 2520,
    race_predict_half_sec: 5400,
    race_predict_marathon_sec: 11400,
    training_load_balance: "BALANCED",
  });

  const coach = repo.getGarminCoachSummary(14).recovery;
  assert.equal(coach.endurance_score, 7100);
  assert.equal(coach.hill_score, 62);
  assert.equal(coach.race_predict_5k_sec, 1200);
  assert.equal(coach.race_predict_half_sec, 5400);
  assert.equal(coach.race_predict_marathon_sec, 11400);
  assert.equal(coach.training_load_balance, "BALANCED");

  const recovery = repo.getRecoverySummary(14).recovery;
  assert.equal(recovery.endurance_score, 7100);
  assert.equal(recovery.hill_score, 62);
  assert.equal(recovery.race_predict_5k_sec, 1200);
  assert.equal(recovery.race_predict_10k_sec, 2520);
  assert.equal(recovery.race_predict_half_sec, 5400);
  assert.equal(recovery.race_predict_marathon_sec, 11400);
  assert.equal(recovery.training_load_balance, "BALANCED");
});
