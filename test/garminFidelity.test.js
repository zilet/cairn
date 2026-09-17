// Reading Garmin back honestly — including Cairn's own echo.
//
// Cairn pushes finished strength sessions TO Garmin as a manual "shell" activity, and
// then syncs Garmin back. For a while it read that shell the way it reads a run, and
// two fields do not survive that:
//
//   • `movingDuration` on a shell is the summed length of the 45-second ACTIVE slots
//     Cairn itself wrote, so a 34-minute session came back as 6 minutes.
//   • `calories` on a shell is Garmin auto-calculating for an activity with no heart
//     rate — a constant 65.534 flagged `isAutoCalcCalories` — which then SUMMED into
//     the day as energy nobody spent.
//
// Plus two adjacent absences that were reading as values: an HRV status of `NONE`
// (the watch saying it has none yet), and nights the watch simply did not report.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, localDaysAgo } from "./_seed.js";
import {
  cairnShellActivityName,
  garminActivityCalories,
  garminActivityDurationSec,
  isCairnAuthoredName,
} from "../dist/repo/garmin-authorship.js";
import {
  flushGarminSyncDeferral,
  newGarminSyncDeferral,
  normalizeGarminHrvStatus,
  sleepNightsMissing,
} from "../dist/repo/activities.js";

const TODAY = localDaysAgo(0);

beforeEach(() => {
  for (const t of [
    "logged_sets",
    "sessions",
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "daily_metrics",
    "garmin_sources",
    "exercises",
  ]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist */
    }
  }
});

// ---- (F1) duration: elapsed for strength, moving for a run ---------------------

test("a strength activity is timed by its elapsed span, never by moving time", () => {
  // The live shape: 34 minutes of lifting, whose "moving" time is eight 45-second slots.
  const activity = { duration: 2040, movingDuration: 360 };
  assert.equal(garminActivityDurationSec(activity, { strength: true }), 2040);
  assert.equal(garminActivityDurationSec(activity, { cairnAuthored: true }), 2040);
  // A run still drops the time spent standing at a crossing.
  assert.equal(garminActivityDurationSec(activity, {}), 360);
});

test("an activity Cairn authored says so in its own name", () => {
  assert.equal(isCairnAuthoredName(cairnShellActivityName("Pull")), true);
  assert.equal(isCairnAuthoredName("Morning Run"), false);
});

// ---- (F2) the auto-calc calorie placeholder is absence, not a measurement -------

test("Garmin's auto-calculated calories on a Cairn shell read as absent", () => {
  assert.equal(garminActivityCalories({ calories: 65.534, isAutoCalcCalories: true }, { cairnAuthored: true }), null);
  // The sentinel is an encoding artifact wherever it appears.
  assert.equal(garminActivityCalories({ calories: 65.534 }, {}), null);
  // An athlete's own manual entry keeps Garmin's estimate: it is still theirs.
  assert.equal(garminActivityCalories({ calories: 310, isAutoCalcCalories: true }, {}), 310);
  // A watch recording is untouched.
  assert.equal(garminActivityCalories({ calories: 412 }, {}), 412);
});

// ---- (F1b) a shell of ours may lengthen the session's blob, never shorten it ----

test("reconciling a Cairn-authored shell never shortens the session's own duration", () => {
  repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, date: TODAY });
  const session = repo.getSessionByDate(TODAY);
  repo.finishSession(session.id);
  // The session's own measured span — one set's created_at range is a few ms wide.
  db.prepare(`UPDATE sessions SET duration_min = 34 WHERE id = ?`).run(session.id);
  const saved = repo.upsertGarminActivity({
    external_id: "24386427797",
    date: TODAY,
    start_time: `${TODAY}T07:30:00`,
    type: "strength_training",
    name: cairnShellActivityName("Pull"),
    duration_min: 6, // what the old read stored
  });
  repo.reconcileGarminStrength(saved.id);
  const after = repo.getSessionByDate(TODAY);
  assert.equal(after.garmin.duration_min, 34);
});

test("a watch recording's own duration still fronts the session, short or long", () => {
  repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, date: TODAY });
  const session = repo.getSessionByDate(TODAY);
  repo.finishSession(session.id);
  db.prepare(`UPDATE sessions SET duration_min = 34 WHERE id = ?`).run(session.id);
  const saved = repo.upsertGarminActivity({
    external_id: "99001",
    date: TODAY,
    start_time: `${TODAY}T07:30:00`,
    type: "strength_training",
    name: "Strength", // the watch's own recording — not ours to correct
    duration_min: 21,
  });
  repo.reconcileGarminStrength(saved.id);
  assert.equal(repo.getSessionByDate(TODAY).garmin.duration_min, 21);
});

// ---- (F6) an HRV status of NONE is no status --------------------------------

test("only the documented HRV statuses are stored; NONE is absence", () => {
  assert.equal(normalizeGarminHrvStatus("BALANCED"), "BALANCED");
  assert.equal(normalizeGarminHrvStatus("unbalanced"), "unbalanced");
  assert.equal(normalizeGarminHrvStatus("NONE"), null);
  assert.equal(normalizeGarminHrvStatus("NO_STATUS"), null);
  assert.equal(normalizeGarminHrvStatus(""), null);
  assert.equal(normalizeGarminHrvStatus(null), null);
});

// ---- (F5) nights the watch did not report ------------------------------------

test("missing sleep nights are counted across every source, not just Garmin", () => {
  const source = repo.upsertGarminSource({ label: "default" });
  repo.upsertGarminDailyMetric({ date: TODAY, sleep_min: 430 }, source.id);
  repo.upsertGarminDailyMetric({ date: localDaysAgo(1), sleep_min: 401 }, source.id);
  // Five of the last seven nights have nothing from Garmin.
  assert.equal(sleepNightsMissing(7, TODAY), 5);
  // A night Apple Health supplied is a night that is not missing.
  repo.recordDailyMetrics("apple", localDaysAgo(2), { sleep_min: 388 });
  assert.equal(sleepNightsMissing(7, TODAY), 4);
});

// ---- (F7) one pass, one invalidation per touched date -------------------------

test("a sync pass defers its per-date work and pays it once per date", () => {
  const source = repo.upsertGarminSource({ label: "default" });
  const defer = newGarminSyncDeferral();
  for (let i = 0; i < 5; i++) {
    repo.upsertGarminActivity(
      {
        external_id: `run-${i}`,
        date: TODAY,
        start_time: `${TODAY}T0${i}:30:00`,
        type: "running",
        name: `Run ${i}`,
        duration_min: 30 + i,
        distance_km: 5,
      },
      source.id,
      { defer }
    );
  }
  // Five activities, one day: one day-read compare and one daily reconcile are owed.
  assert.equal(defer.sessionDates.size, 1);
  assert.equal(defer.readDates.size, 1);
  assert.equal(defer.bump, true);

  repo.upsertGarminActivity(
    {
      external_id: "run-yesterday",
      date: localDaysAgo(1),
      start_time: `${localDaysAgo(1)}T07:30:00`,
      type: "running",
      name: "Run",
      duration_min: 40,
      distance_km: 7,
    },
    source.id,
    { defer }
  );
  assert.equal(defer.sessionDates.size, 2);

  flushGarminSyncDeferral(defer);
  assert.equal(defer.sessionDates.size, 0);
  assert.equal(defer.readDates.size, 0);
  assert.equal(defer.bump, false);
});
