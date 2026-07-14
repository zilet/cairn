import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { processGarminStrengthJob } from "../dist/enrich.js";
import { db, repo, isoDaysAgo } from "./_seed.js";

const TODAY = isoDaysAgo(0);

beforeEach(() => {
  for (const table of [
    "logged_sets",
    "session_skips",
    "sessions",
    "activities",
    "garmin_activities",
    "garmin_sources",
    "exercises",
    "settings",
  ]) {
    try {
      db.prepare(`DELETE FROM ${table}`).run();
    } catch {
      // Table may not exist in an older migration fixture.
    }
  }
  repo.setSettings({ enrich_enabled: false });
});

function seedStrengthActivity(externalId, exerciseSets) {
  return repo.upsertGarminActivity({
    external_id: externalId,
    date: TODAY,
    start_time: `${TODAY}T07:30:00`,
    type: "strength_training",
    name: "Strength",
    duration_min: 31,
    avg_hr: 126,
    max_hr: 158,
    calories: 284,
    training_effect: 2.4,
    hr_zones: [
      { zone: 2, secs: 720 },
      { zone: 3, secs: 540 },
    ],
    exercise_sets: exerciseSets,
  });
}

function setSnapshot(session) {
  return session.sets.map((set) => ({
    id: set.id,
    exercise: set.exercise,
    set_number: set.set_number,
    weight: set.weight,
    reps: set.reps,
  }));
}

function tonnage(sets) {
  return sets.reduce((sum, set) => sum + (set.weight > 0 && set.reps ? set.weight * set.reps : 0), 0);
}

test("Cairn sets remain authoritative while Garmin physiology is merged", async () => {
  repo.logSetByName({ exercise: "Back Squat", weight: 155, reps: 10, date: TODAY });
  repo.logSetByName({ exercise: "Back Squat", weight: 165, reps: 10, date: TODAY });
  repo.logSetByName({ exercise: "Single-Arm DB Row", weight: 50, reps: 12, date: TODAY });
  repo.logSetByName({ exercise: "Single-Arm DB Row", weight: 50, reps: 12, date: TODAY });

  const before = repo.getSessionByDate(TODAY);
  const expectedSets = setSnapshot(before);
  const expectedTonnage = tonnage(before.sets);
  const activity = seedStrengthActivity("manual-overlap", [
    { category: "SQUAT", name: "Squat", reps: 10, weight_kg: 70.3 },
    { category: "ROW", name: "Row", reps: 12, weight_kg: 22.7 },
    { category: "UNKNOWN", name: "Unknown", reps: 20, weight_kg: 0 },
  ]);

  repo.reconcileGarminStrength(activity.id);
  await processGarminStrengthJob(activity.id);

  const after = repo.getSessionByDate(TODAY);
  assert.deepEqual(setSnapshot(after), expectedSets, "manual set ids, names, loads, reps, and count are untouched");
  assert.equal(tonnage(after.sets), expectedTonnage, "manual tonnage is untouched");
  assert.equal(after.garmin.cairn_sets_authoritative, true);
  assert.equal(after.garmin.extrapolated, false, "ignored watch sets do not mark the session extrapolated");
  assert.equal(after.garmin.duration_min, 31);
  assert.equal(after.garmin.avg_hr, 126);
  assert.equal(after.garmin.max_hr, 158);
  assert.equal(after.garmin.calories, 284);
  assert.deepEqual(after.garmin.hr_zones, [
    { zone: 2, secs: 720, low_hr: null },
    { zone: 3, secs: 540, low_hr: null },
  ]);

  repo.reconcileGarminStrength(activity.id);
  const repeated = repo.getSessionByDate(TODAY);
  assert.equal(repeated.garmin.cairn_sets_authoritative, true, "re-reconcile preserves Cairn authority");
  assert.deepEqual(setSnapshot(repeated), expectedSets);
});

test("an initially empty watch-only session imports detected sets and stays importable", async () => {
  const activity = seedStrengthActivity("watch-only", [
    { category: "SQUAT", name: "Squat", reps: 10, weight_kg: 50 },
    { category: "SQUAT", name: "Squat", reps: 8, weight_kg: 55 },
    { category: "SQUAT", name: "Squat", reps: 6, weight_kg: 60 },
  ]);

  repo.reconcileGarminStrength(activity.id);
  let session = repo.getSessionByDate(TODAY);
  assert.equal(session.garmin.cairn_sets_authoritative, undefined, "set authority stays pending until the job runs");
  assert.equal(session.sets.length, 0);

  await processGarminStrengthJob(activity.id);
  session = repo.getSessionByDate(TODAY);
  assert.equal(session.garmin.cairn_sets_authoritative, false, "an empty session resolves to watch-only before import");
  assert.equal(session.sets.length, 3, "every detected set for the new exercise is imported");
  assert.equal(session.sets[0].exercise, "Squat");
  assert.equal(session.sets[0].reps, 10);
  assert.equal(session.sets[0].weight, 110, "50 kg is converted and plate-rounded to 110 lb");
  assert.deepEqual(
    session.sets.map((set) => set.set_number),
    [1, 2, 3]
  );
  assert.equal(session.garmin.extrapolated, true);

  await processGarminStrengthJob(activity.id);
  session = repo.getSessionByDate(TODAY);
  assert.equal(session.sets.length, 3, "rerunning the job does not duplicate imported sets");

  repo.reconcileGarminStrength(activity.id);
  session = repo.getSessionByDate(TODAY);
  assert.equal(session.garmin.cairn_sets_authoritative, false, "re-reconcile preserves watch-only fallback policy");
});

test("Cairn sets logged after reconcile win the pending-authority race", async () => {
  const activity = seedStrengthActivity("pending-race", [
    { category: "SQUAT", name: "Squat", reps: 10, weight_kg: 70.3 },
    { category: "UNKNOWN", name: "Unknown", reps: 20, weight_kg: 0 },
  ]);

  repo.reconcileGarminStrength(activity.id);
  let session = repo.getSessionByDate(TODAY);
  assert.equal(session.garmin.cairn_sets_authoritative, undefined);

  repo.logSetByName({ exercise: "Back Squat", weight: 155, reps: 10, date: TODAY });
  repo.logSetByName({ exercise: "Single-Arm DB Row", weight: 50, reps: 12, date: TODAY });
  const expectedSets = setSnapshot(repo.getSessionByDate(TODAY));

  await processGarminStrengthJob(activity.id);
  session = repo.getSessionByDate(TODAY);
  assert.equal(session.garmin.cairn_sets_authoritative, true);
  assert.deepEqual(setSnapshot(session), expectedSets, "no Garmin Squat or Unknown set is appended");
});

test("legacy markerless linked sessions with Cairn sets resolve conservatively", async () => {
  repo.logSetByName({ exercise: "Back Squat", weight: 155, reps: 10, date: TODAY });
  const activity = seedStrengthActivity("legacy-markerless", [
    { category: "SQUAT", name: "Squat", reps: 10, weight_kg: 70.3 },
  ]);
  repo.reconcileGarminStrength(activity.id);

  const before = repo.getSessionByDate(TODAY);
  const legacyGarmin = { ...before.garmin };
  delete legacyGarmin.cairn_sets_authoritative;
  db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(JSON.stringify(legacyGarmin), before.id);
  const expectedSets = setSnapshot(before);

  await processGarminStrengthJob(activity.id);
  const after = repo.getSessionByDate(TODAY);
  assert.equal(after.garmin.cairn_sets_authoritative, true);
  assert.deepEqual(setSnapshot(after), expectedSets, "legacy Cairn sets remain authoritative");
});

test("two same-day watch activities both import sets and each stays idempotent", async () => {
  const first = seedStrengthActivity("watch-double-a", [
    { category: "SQUAT", name: "Squat", reps: 10, weight_kg: 50 },
    { category: "SQUAT", name: "Squat", reps: 8, weight_kg: 55 },
  ]);
  const second = seedStrengthActivity("watch-double-b", [
    { category: "SQUAT", name: "Squat", reps: 6, weight_kg: 60 },
    { category: "SQUAT", name: "Squat", reps: 5, weight_kg: 65 },
  ]);

  repo.reconcileGarminStrength(first.id);
  repo.reconcileGarminStrength(second.id);
  await processGarminStrengthJob(first.id);
  await processGarminStrengthJob(second.id);

  let session = repo.getSessionByDate(TODAY);
  assert.equal(session.garmin.activity_count, 2);
  assert.deepEqual(session.sets.map((set) => set.reps), [10, 8, 6, 5]);
  assert.deepEqual(session.garmin.imported_set_activity_ids, ["watch-double-a", "watch-double-b"]);

  await processGarminStrengthJob(first.id);
  await processGarminStrengthJob(second.id);
  session = repo.getSessionByDate(TODAY);
  assert.equal(session.sets.length, 4, "rerunning either activity does not duplicate its sets");
});

test("an activity with no usable sets can import a richer later sync", async () => {
  const initial = seedStrengthActivity("watch-richer-later", [
    { category: "UNKNOWN", name: "Unknown", reps: null, weight_kg: null },
  ]);
  repo.reconcileGarminStrength(initial.id);
  await processGarminStrengthJob(initial.id);

  let session = repo.getSessionByDate(TODAY);
  assert.equal(session.sets.length, 0);
  assert.equal(session.garmin.cairn_sets_authoritative, undefined, "unusable data leaves authority pending");
  assert.deepEqual(session.garmin.imported_set_activity_ids, []);

  const richer = seedStrengthActivity("watch-richer-later", [
    { category: "SQUAT", name: "Squat", reps: 10, weight_kg: 50 },
  ]);
  repo.reconcileGarminStrength(richer.id);
  await processGarminStrengthJob(richer.id);

  session = repo.getSessionByDate(TODAY);
  assert.equal(session.sets.length, 1);
  assert.equal(session.sets[0].exercise, "Squat");
  assert.deepEqual(session.garmin.imported_set_activity_ids, ["watch-richer-later"]);
});

test("a mid-import failure rolls back the full set batch and activity ledger", async () => {
  const activity = seedStrengthActivity("watch-atomic-failure", [
    { category: "SQUAT", name: "Squat", reps: 10, weight_kg: 50 },
    { category: "SQUAT", name: "Squat", reps: 8, weight_kg: 55 },
  ]);
  repo.reconcileGarminStrength(activity.id);
  db.exec(`CREATE TRIGGER fail_second_garmin_set BEFORE INSERT ON logged_sets
    WHEN (SELECT COUNT(*) FROM logged_sets WHERE session_id = NEW.session_id) = 1
    BEGIN SELECT RAISE(ABORT, 'forced mid-import failure'); END`);
  try {
    await assert.rejects(processGarminStrengthJob(activity.id), /forced mid-import failure/);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_second_garmin_set");
  }

  let session = repo.getSessionByDate(TODAY);
  assert.equal(session.sets.length, 0, "the first set is rolled back with the failing second set");
  assert.equal(session.garmin.cairn_sets_authoritative, undefined, "failed import does not claim watch authority");
  assert.deepEqual(session.garmin.imported_set_activity_ids, [], "failed import does not advance the ledger");

  await processGarminStrengthJob(activity.id);
  session = repo.getSessionByDate(TODAY);
  assert.deepEqual(session.sets.map((set) => set.reps), [10, 8], "the complete batch remains retryable");
  assert.deepEqual(session.garmin.imported_set_activity_ids, ["watch-atomic-failure"]);
});

test("manual Cairn sets win after an unusable job and before a richer resync", async () => {
  const initial = seedStrengthActivity("watch-pending-manual", [
    { category: "UNKNOWN", name: "Unknown", reps: null, weight_kg: null },
  ]);
  repo.reconcileGarminStrength(initial.id);
  await processGarminStrengthJob(initial.id);

  let session = repo.getSessionByDate(TODAY);
  assert.equal(session.garmin.cairn_sets_authoritative, undefined);
  assert.equal(session.sets.length, 0);

  repo.logSetByName({ exercise: "Back Squat", weight: 155, reps: 10, date: TODAY });
  const expectedSets = setSnapshot(repo.getSessionByDate(TODAY));
  const richer = seedStrengthActivity("watch-pending-manual", [
    { category: "SQUAT", name: "Squat", reps: 10, weight_kg: 50 },
  ]);
  repo.reconcileGarminStrength(richer.id);
  await processGarminStrengthJob(richer.id);

  session = repo.getSessionByDate(TODAY);
  assert.equal(session.garmin.cairn_sets_authoritative, true);
  assert.deepEqual(setSnapshot(session), expectedSets, "the later watch payload cannot overwrite pending Cairn authority");
  assert.deepEqual(session.garmin.imported_set_activity_ids, []);
});
