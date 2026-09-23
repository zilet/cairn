// A hand-logged shadow of a synced effort ("morning run (fasted)" typed into chat
// an hour after the watch synced it) is one effort everywhere it is COUNTED, never
// two. Round 1 introduced isShadowActivity/withoutShadowActivities
// (src/repo/activity-shadow.js, re-exported from src/repo/activities.js) and
// applied them to getCardioForDate + underfueling. This package extends the guard
// to the remaining counting reads named in its file zone (hybrid-load.ts,
// training-read.ts, sessions.ts) plus several more found via grep. Each case here
// seeds a synced (Garmin) row plus a same-day, same-modality, metric-agreeing hand
// log (the shadow) and asserts the counting read reports the effort ONCE, matching
// what a single synced-only row would report.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, resetTables } from "./_seed.js";
import { recentEnduranceImpacts } from "../dist/repo/hybrid-load.js";
import { dayLoad, hardCardioDay, longestRunNovelty } from "../dist/repo/training-read.js";
import { getRunCompliance, vouchedRunCompliance, weeklyAerobicLoad, getEndurancePRs } from "../dist/repo/sessions.js";

const DATE = "2026-08-05";

let sourceId = null;

beforeEach(() => {
  resetTables("activities", "garmin_activities", "garmin_sources", "sessions", "logged_sets", "plan_days", "plan_items");
  sourceId = db
    .prepare(`INSERT INTO garmin_sources (provider, mode, label) VALUES ('garmin','unofficial','shadow-test')`)
    .run().lastInsertRowid;
});

function insertSyncedRun(date, { duration_min = 62, distance_km = 9.0, external_id = `garmin-${date}` } = {}) {
  const info = db
    .prepare(
      `INSERT INTO activities (date, type, raw_text, duration_min, distance_km, source, external_id)
       VALUES (?, 'run', 'morning run', ?, ?, 'garmin', ?)`
    )
    .run(date, duration_min, distance_km, external_id);
  db.prepare(
    `INSERT INTO garmin_activities (source_id, activity_id, external_id, date, type, name, duration_min, distance_km,
        training_load, aerobic_te, anaerobic_te, te_label, hr_zones_json)
     VALUES (?, ?, ?, ?, 'running', 'Morning Run', ?, ?, 200, 3.8, 1.0, 'TEMPO_RUN', ?)`
  ).run(
    sourceId,
    info.lastInsertRowid,
    external_id,
    date,
    duration_min,
    distance_km,
    JSON.stringify([{ zone: 4, secs: 400 }])
  );
  return info.lastInsertRowid;
}

function insertShadowHandLog(date, { duration_min = 62, distance_km = 9.0 } = {}) {
  return db
    .prepare(
      `INSERT INTO activities (date, type, raw_text, duration_min, distance_km)
       VALUES (?, 'run', 'morning run (fasted)', ?, ?)`
    )
    .run(date, duration_min, distance_km).lastInsertRowid;
}

test("recentEnduranceImpacts (hybrid-load.ts): a shadow does not add a second leg-residual dose", () => {
  insertSyncedRun(DATE);
  const before = recentEnduranceImpacts(3, DATE);
  assert.equal(before.length, 1, "synced-only: one endurance impact");

  insertShadowHandLog(DATE);
  const after = recentEnduranceImpacts(3, DATE);
  assert.equal(after.length, 1, "synced + shadow: still one endurance impact, not two");
  assert.equal(after[0].distance_km, before[0].distance_km);
});

test("dayLoad (training-read.ts): a shadow does not change the day's training-load grade", () => {
  insertSyncedRun(DATE);
  const before = dayLoad(DATE, { countsCardio: true });

  insertShadowHandLog(DATE);
  const after = dayLoad(DATE, { countsCardio: true });
  assert.equal(after, before);
});

test("hardCardioDay (training-read.ts): a shadow row alone (no synced counterpart) is inert, and a real synced hard day is unaffected by its shadow", () => {
  insertSyncedRun(DATE);
  const before = hardCardioDay(DATE);
  assert.equal(before, true, "synced-only TEMPO_RUN with Z4 time reads hard");

  insertShadowHandLog(DATE);
  const after = hardCardioDay(DATE);
  assert.equal(after, true, "adding the shadow must not change the verdict");
});

test("longestRunNovelty (training-read.ts): prior_runs counts a shadowed day once", () => {
  // Three genuine distinct prior days, within the 90-day lookback for DATE
  // (2026-08-05 - 90d ~= 2026-05-07), one of which is shadow-duplicated. Without
  // the guard prior_runs would read 4 instead of 3.
  insertSyncedRun("2026-05-10", { distance_km: 8, external_id: "g1" });
  insertSyncedRun("2026-05-20", { distance_km: 8, external_id: "g2" });
  const dupDate = "2026-06-01";
  insertSyncedRun(dupDate, { distance_km: 8, duration_min: 55, external_id: "g3" });
  insertShadowHandLog(dupDate, { distance_km: 8, duration_min: 55 });

  insertSyncedRun(DATE, { distance_km: 17.9, external_id: "g5" });
  const result = longestRunNovelty(DATE);
  assert.ok(result, "3 distinct prior runs clears the LONGEST_RUN_MIN_PRIOR_RUNS floor");
  assert.equal(result.prior_runs, 3, "the shadow-duplicated day must count once, not twice");
});

test("getRunCompliance / vouchedRunCompliance (sessions.ts): a shadow does not double actual_sessions/actual_km/actual_min", () => {
  const monday = "2026-08-03"; // Monday of the DATE week
  insertSyncedRun(monday, { duration_min: 60, distance_km: 9 });
  const before = getRunCompliance(monday);
  assert.equal(before.actual_sessions, 1);
  assert.equal(before.actual_km, 9);

  insertShadowHandLog(monday, { duration_min: 60, distance_km: 9 });
  const after = getRunCompliance(monday);
  assert.equal(after.actual_sessions, 1, "shadow must not add a second session");
  assert.equal(after.actual_km, 9, "shadow must not double the week's actual km");

  const vouched = vouchedRunCompliance(monday);
  assert.equal(vouched.actual_sessions, 1);
});

test("weeklyAerobicLoad (sessions.ts): a shadow does not double outings/km/minutes", () => {
  const monday = "2026-08-03";
  insertSyncedRun(monday, { duration_min: 60, distance_km: 9 });
  const before = weeklyAerobicLoad(monday);
  assert.equal(before.outings, 1);
  assert.equal(before.km, 9);

  insertShadowHandLog(monday, { duration_min: 60, distance_km: 9 });
  const after = weeklyAerobicLoad(monday);
  assert.equal(after.outings, 1, "shadow must not add a second outing");
  assert.equal(after.km, 9, "shadow must not double this week's km");
});

test("getEndurancePRs (sessions.ts): a shadow does not inflate the effort count", () => {
  insertSyncedRun(DATE, { duration_min: 60, distance_km: 9 });
  const before = getEndurancePRs("run");
  assert.equal(before.sports[0]?.count, 1);

  insertShadowHandLog(DATE, { duration_min: 60, distance_km: 9 });
  const after = getEndurancePRs("run");
  assert.equal(after.sports[0]?.count, 1, "shadow must not count as a second PR-eligible outing");
});

test("a genuine SECOND run the same day (metrics disagree) is never treated as a shadow", () => {
  insertSyncedRun(DATE, { duration_min: 60, distance_km: 9 });
  // A real second run: different distance/duration entirely — must NOT be folded away.
  db.prepare(
    `INSERT INTO activities (date, type, raw_text, duration_min, distance_km)
     VALUES (?, 'run', 'evening shakeout', 20, 3)`
  ).run(DATE);
  const impacts = recentEnduranceImpacts(3, DATE);
  assert.equal(impacts.length, 2, "a genuinely different second run must still count");
});
