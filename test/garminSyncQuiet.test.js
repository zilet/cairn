// A Garmin sync that brings nothing new writes nothing.
//
// Every pass re-reads 14 days of daily metrics and a 30-day activity window, and every
// row used to be re-UPSERTed — `updated_at`/`synced_at` stamped, the coach-context
// update odometer fired, the training version bumped — even when Garmin answered with
// exactly what was stored. Those are the inputs to the response-freshness key, so a
// no-change sync threw away the memoized Today and the coach context every time.
//
// These pin both directions: an identical pass leaves the stamps and the key alone, and
// a real change (including Garmin revising a recent day after the fact) still writes
// and still invalidates. Also here: the strength re-offer gate, the light arrival
// check, and the full-pass retry ladder.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, localDaysAgo } from "./_seed.js";
import { responseFreshnessKey } from "../dist/repo/response-freshness.js";
import { currentTrainingDataVersion } from "../dist/repo/training-cache.js";
import {
  GARMIN_LIGHT_BACKOFF_MS,
  garminLightCheckNews,
  requestGarminLightCheck,
  resetGarminLightCheckForTests,
  setGarminClientForTests,
  syncGarmin,
} from "../dist/garmin.js";
import { garminStrengthIdsToEnqueue } from "../dist/enrich.js";
import { garminFailureRetryMs, garminLightCheckHour, GARMIN_RETRY_BASE_MS } from "../dist/scheduler.js";

const TODAY = () => localDaysAgo(0);
const OLD_STAMP = "2000-01-01 00:00:00";

afterEach(() => {
  setGarminClientForTests(null);
  resetGarminLightCheckForTests();
});

// The freshness key minus its wall-clock tail (date, ten-minute slot, zone), so a test
// that straddles a slot boundary cannot read as a moved key.
function freshness() {
  const key = responseFreshnessKey();
  assert.ok(key, "the freshness odometer is readable");
  return key.split("|").slice(0, -3).join("|");
}

function day(date, extra = {}) {
  return {
    date,
    steps: 8000,
    resting_hr: 52,
    hrv_ms: 61,
    sleep_min: 448,
    raw: { sleep: { dailySleepDTO: { sleepTimeSeconds: 26880 } }, hrv: { hrvSummary: { lastNightAvg: 61 } } },
    ...extra,
  };
}

function stampDailyOld() {
  db.prepare(`UPDATE garmin_daily_metrics SET updated_at = ?`).run(OLD_STAMP);
}

function dailyStamps() {
  return db.prepare(`SELECT date, updated_at FROM garmin_daily_metrics ORDER BY date`).all();
}

// ---- daily metrics ---------------------------------------------------------------

test("an identical daily pass writes nothing: updated_at, training version and freshness key stay put", () => {
  const rows = [day(localDaysAgo(2)), day(localDaysAgo(1)), day(TODAY())];
  repo.upsertGarminDailyMetrics(rows);
  stampDailyOld();
  const version = currentTrainingDataVersion();
  const key = freshness();

  const out = repo.upsertGarminDailyMetrics(rows.map((r) => ({ ...r, raw: structuredClone(r.raw) })));
  assert.equal(out.length, rows.length, "one note per input row");
  assert.ok(
    out.every((r) => r.wrote === false),
    "no row was written"
  );
  assert.ok(
    dailyStamps().every((r) => r.updated_at === OLD_STAMP),
    "updated_at untouched"
  );
  assert.equal(currentTrainingDataVersion(), version, "no training-version bump");
  assert.equal(freshness(), key, "the response freshness key did not move");
});

test("a sparse re-sync whose nulls the COALESCE would keep is unchanged too", () => {
  repo.upsertGarminDailyMetrics([day(TODAY())]);
  stampDailyOld();
  const key = freshness();
  // Garmin answered without HRV and without a raw payload this time: the stored values stand.
  repo.upsertGarminDailyMetrics([{ date: TODAY(), steps: 8000, hrv_ms: null, raw: null }]);
  assert.equal(dailyStamps()[0].updated_at, OLD_STAMP);
  assert.equal(freshness(), key);
  const stored = db.prepare(`SELECT hrv_ms, raw_json FROM garmin_daily_metrics`).get();
  assert.equal(Number(stored.hrv_ms), 61, "the stored reading survives");
  assert.ok(stored.raw_json, "the stored payload survives");
});

test("a real change writes and invalidates exactly as before", () => {
  repo.upsertGarminDailyMetrics([day(localDaysAgo(1)), day(TODAY())]);
  stampDailyOld();
  const version = currentTrainingDataVersion();
  const key = freshness();
  repo.upsertGarminDailyMetrics([day(localDaysAgo(1)), day(TODAY(), { steps: 9100 })]);
  const stamps = Object.fromEntries(dailyStamps().map((r) => [r.date, r.updated_at]));
  assert.notEqual(stamps[TODAY()], OLD_STAMP, "the moved day is stamped");
  assert.equal(stamps[localDaysAgo(1)], OLD_STAMP, "the unmoved day is not");
  assert.ok(currentTrainingDataVersion() > version, "the training version moved");
  assert.notEqual(freshness(), key, "the freshness key moved");
});

test("a retroactive Garmin revision of a recent day (raw payload only) still writes", () => {
  const yesterday = localDaysAgo(1);
  repo.upsertGarminDailyMetrics([day(yesterday)]);
  stampDailyOld();
  const key = freshness();
  const revised = day(yesterday);
  revised.raw.sleep.dailySleepDTO.sleepTimeSeconds = 27000; // Garmin re-scored the night
  repo.upsertGarminDailyMetrics([revised]);
  assert.notEqual(dailyStamps()[0].updated_at, OLD_STAMP);
  assert.notEqual(freshness(), key);
  const raw = JSON.parse(db.prepare(`SELECT raw_json FROM garmin_daily_metrics`).get().raw_json);
  assert.equal(raw.sleep.dailySleepDTO.sleepTimeSeconds, 27000);
});

test("the single-row upsert keeps its row answer, and skips the bump when nothing moved", () => {
  const first = repo.upsertGarminDailyMetric(day(TODAY()));
  assert.equal(first.date, TODAY());
  stampDailyOld();
  const version = currentTrainingDataVersion();
  const again = repo.upsertGarminDailyMetric(day(TODAY()));
  assert.equal(again.date, TODAY(), "the stored row is still returned");
  assert.equal(again.updated_at, OLD_STAMP);
  assert.equal(currentTrainingDataVersion(), version);
});

// ---- activities --------------------------------------------------------------------

function run(externalId, extra = {}) {
  return {
    external_id: externalId,
    date: TODAY(),
    start_time: `${TODAY()} 07:00:00`,
    type: "running",
    name: "Morning Run",
    duration_min: 42,
    distance_km: 8.1,
    avg_hr: 148,
    training_load: 120,
    raw: { activityId: externalId, distance: 8100 },
    ...extra,
  };
}

test("an identical activity re-sync writes neither table and bumps nothing", () => {
  const first = repo.upsertGarminActivity(run("a-1"));
  db.prepare(`UPDATE garmin_activities SET synced_at = ?`).run(OLD_STAMP);
  const mirrorBefore = db.prepare(`SELECT * FROM activities WHERE id = ?`).get(first.activity_id);
  const version = currentTrainingDataVersion();
  const key = freshness();

  const defer = repo.newGarminSyncDeferral();
  const again = repo.upsertGarminActivity(run("a-1"), first.source_id, { defer });
  assert.equal(again.id, first.id, "the stored row is the answer");
  assert.equal(again.synced_at, OLD_STAMP, "synced_at untouched");
  assert.equal(defer.bump, false, "nothing asked for a bump");
  assert.equal(defer.readDates.size + defer.sessionDates.size, 0, "nothing deferred");
  assert.equal(defer.written.size, 0, "not counted as written");
  repo.flushGarminSyncDeferral(defer);
  assert.deepEqual(db.prepare(`SELECT * FROM activities WHERE id = ?`).get(first.activity_id), mirrorBefore);
  assert.equal(currentTrainingDataVersion(), version);
  assert.equal(freshness(), key);
});

test("a changed activity writes, stamps, and says so", () => {
  const first = repo.upsertGarminActivity(run("a-2"));
  db.prepare(`UPDATE garmin_activities SET synced_at = ?`).run(OLD_STAMP);
  const key = freshness();
  const defer = repo.newGarminSyncDeferral();
  const again = repo.upsertGarminActivity(run("a-2", { duration_min: 44.5, distance_km: 8.6 }), first.source_id, {
    defer,
  });
  repo.flushGarminSyncDeferral(defer);
  assert.notEqual(again.synced_at, OLD_STAMP);
  assert.ok(defer.written.has(Number(first.id)), "the write is visible to the sync");
  assert.equal(
    Number(db.prepare(`SELECT duration_min FROM activities WHERE id = ?`).get(first.activity_id).duration_min),
    44.5
  );
  assert.notEqual(freshness(), key);
});

test("a drifted calendar copy is still put back by an otherwise identical re-sync", () => {
  const first = repo.upsertGarminActivity(run("a-3"));
  db.prepare(`UPDATE activities SET duration_min = 5 WHERE id = ?`).run(first.activity_id);
  repo.upsertGarminActivity(run("a-3"));
  assert.equal(
    Number(db.prepare(`SELECT duration_min FROM activities WHERE id = ?`).get(first.activity_id).duration_min),
    42
  );
});

// ---- strength: reconcile and the narrative re-offer --------------------------------

function strength(externalId, extra = {}) {
  return {
    external_id: externalId,
    date: TODAY(),
    start_time: `${TODAY()} 18:00:00`,
    type: "strength_training",
    name: "Strength",
    duration_min: 50,
    avg_hr: 120,
    calories: 300,
    ...extra,
  };
}

test("re-reconciling an unchanged strength activity rewrites nothing", () => {
  const ga = repo.upsertGarminActivity(strength("s-1"));
  repo.reconcileGarminStrength(ga.id);
  const before = db.prepare(`SELECT garmin_json FROM sessions WHERE date = ?`).get(TODAY()).garmin_json;
  const version = currentTrainingDataVersion();
  const key = freshness();
  repo.reconcileGarminStrength(ga.id);
  const after = db.prepare(`SELECT garmin_json FROM sessions WHERE date = ?`).get(TODAY()).garmin_json;
  assert.equal(after, before, "the blob — reconciled_at included — is not rewritten");
  assert.equal(currentTrainingDataVersion(), version);
  assert.equal(freshness(), key);
});

test("a narrated, unchanged strength activity is not re-offered; new, changed or owed ones are", () => {
  const narrated = repo.upsertGarminActivity(strength("s-2"));
  repo.reconcileGarminStrength(narrated.id);
  const session = db.prepare(`SELECT id, garmin_json FROM sessions WHERE date = ?`).get(TODAY());
  const blob = JSON.parse(session.garmin_json);
  db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(
    JSON.stringify({ ...blob, summary: "Steady session." }),
    session.id
  );
  const owed = repo.upsertGarminActivity(
    strength("s-3", { date: localDaysAgo(1), start_time: `${localDaysAgo(1)} 18:00:00` })
  );
  repo.reconcileGarminStrength(owed.id); // linked, but no narrative yet
  const unlinked = repo.upsertGarminActivity(
    strength("s-4", { date: localDaysAgo(3), start_time: `${localDaysAgo(3)} 18:00:00` })
  );

  assert.deepEqual(garminStrengthIdsToEnqueue([narrated.id, owed.id, unlinked.id], new Set()), [owed.id, unlinked.id]);
  assert.deepEqual(
    garminStrengthIdsToEnqueue([narrated.id, owed.id], new Set([Number(narrated.id)])),
    [narrated.id, owed.id],
    "a narrated activity whose row moved this pass is offered again"
  );
});

// ---- the whole pass, against a fake Garmin -----------------------------------------

function fakeGarmin(activities, counters = {}) {
  counters.lists = 0;
  return {
    async getActivities() {
      counters.lists++;
      return activities;
    },
    async getSteps() {
      return 8000;
    },
    async getSleepData() {
      return null;
    },
    async getDailyWeightData() {
      return null;
    },
    async getUserProfile() {
      return null;
    },
    async get() {
      return null;
    },
  };
}

function garminRun(id, date = TODAY(), extra = {}) {
  return {
    activityId: id,
    activityName: "Morning Run",
    startTimeLocal: `${date} 07:00:00`,
    activityType: { typeKey: "running" },
    duration: 2520,
    movingDuration: 2520,
    distance: 8100,
    averageHR: 148,
    ...extra,
  };
}

test("a second identical full pass leaves every Garmin row stamp alone", async () => {
  const list = [garminRun(101), garminRun(102, localDaysAgo(1))];
  setGarminClientForTests(() => fakeGarmin(list));
  const first = await syncGarmin({ days: 3, limit: 10 });
  assert.equal(first.ok, true, first.error);
  db.prepare(`UPDATE garmin_activities SET synced_at = ?`).run(OLD_STAMP);
  stampDailyOld();
  const second = await syncGarmin({ days: 3, limit: 10 });
  assert.equal(second.ok, true, second.error);
  assert.ok(
    db
      .prepare(`SELECT synced_at FROM garmin_activities`)
      .all()
      .every((r) => r.synced_at === OLD_STAMP),
    "no activity row re-stamped"
  );
  assert.ok(
    dailyStamps().every((r) => r.updated_at === OLD_STAMP),
    "no daily row re-stamped"
  );
});

test("the light check with nothing new makes one list call and writes nothing", async () => {
  const counters = {};
  const list = [garminRun(201)];
  setGarminClientForTests(() => fakeGarmin(list, counters));
  assert.equal((await syncGarmin({ days: 2, limit: 10 })).ok, true);
  const key = freshness();
  const status = repo.getSettings().garmin_last_sync_at;

  const out = await requestGarminLightCheck({ minIntervalMs: 0 });
  assert.equal(out.checked, true);
  assert.equal(out.news, null);
  assert.equal(out.result, undefined, "no pass ran");
  assert.equal(counters.lists, 1, "one list call, nothing else");
  assert.equal(freshness(), key, "nothing written");
  assert.equal(repo.getSettings().garmin_last_sync_at, status, "not even the sync status line");
});

test("the light check runs a two-day pass when the list names an activity Cairn lacks", async () => {
  const list = [garminRun(301)];
  setGarminClientForTests(() => fakeGarmin(list));
  const out = await requestGarminLightCheck({ minIntervalMs: 0 });
  assert.match(String(out.news), /new activity 301/);
  assert.equal(out.result?.ok, true);
  assert.equal(out.result.days, 2, "the small window");
  assert.ok(db.prepare(`SELECT 1 FROM garmin_activities WHERE external_id = '301'`).get(), "the run landed");
  assert.ok(
    db.prepare(`SELECT COUNT(*) AS n FROM garmin_daily_metrics`).get().n <= 2,
    "daily metrics for those two days only"
  );
});

test("what counts as news: unseen, or today's recording revised — never an old late upload", () => {
  repo.upsertGarminActivity(
    { external_id: "401", date: TODAY(), type: "running", duration_min: 42, distance_km: 8.1 },
    repo.upsertGarminSource({ label: "default" }).id
  );
  assert.equal(garminLightCheckNews([garminRun(401)]), null, "stored and unchanged");
  assert.match(String(garminLightCheckNews([garminRun(401, TODAY(), { distance: 9300 })])), /changed/);
  assert.match(String(garminLightCheckNews([garminRun(402)])), /new activity 402/);
  assert.equal(
    garminLightCheckNews([garminRun(403, localDaysAgo(6))]),
    null,
    "outside the two-day pass: left to the full pass, or every check would re-run"
  );
});

test("the light check honours its floor, and rests an hour after it throws", async () => {
  let calls = 0;
  setGarminClientForTests(() => ({
    async getActivities() {
      calls++;
      throw new Error("429 Too Many Requests");
    },
  }));
  const failed = await requestGarminLightCheck({ minIntervalMs: 0 });
  assert.equal(failed.checked, true);
  assert.match(String(failed.error), /429/);
  const resting = await requestGarminLightCheck({ minIntervalMs: 0 });
  assert.equal(resting.skipped, "backoff");
  assert.equal(calls, 1, "the backoff costs no call");
  assert.equal(GARMIN_LIGHT_BACKOFF_MS, 60 * 60_000);

  resetGarminLightCheckForTests();
  setGarminClientForTests(() => fakeGarmin([]));
  assert.equal((await requestGarminLightCheck({ minIntervalMs: 5 * 60_000 })).checked, true);
  assert.equal((await requestGarminLightCheck({ minIntervalMs: 5 * 60_000 })).skipped, "recent");
});

// ---- scheduler cadence -------------------------------------------------------------

test("a failed full pass retries in 30 minutes, doubling to the six-hour cap", () => {
  const SIX_H = 6 * 60 * 60_000;
  assert.equal(GARMIN_RETRY_BASE_MS, 30 * 60_000);
  assert.equal(garminFailureRetryMs(1, SIX_H), 30 * 60_000);
  assert.equal(garminFailureRetryMs(2, SIX_H), 60 * 60_000);
  assert.equal(garminFailureRetryMs(4, SIX_H), 4 * 60 * 60_000);
  assert.equal(garminFailureRetryMs(5, SIX_H), SIX_H);
  assert.equal(garminFailureRetryMs(500, SIX_H), SIX_H);
  assert.equal(garminFailureRetryMs(0, SIX_H), 30 * 60_000, "never sooner than the base");
});

test("the light check asks only in waking hours", () => {
  assert.equal(garminLightCheckHour(5, 6, 22), false);
  assert.equal(garminLightCheckHour(6, 6, 22), true);
  assert.equal(garminLightCheckHour(22, 6, 22), true, "through 22:59");
  assert.equal(garminLightCheckHour(23, 6, 22), false);
  assert.equal(garminLightCheckHour(1, 22, 2), true, "a window may wrap midnight");
});
