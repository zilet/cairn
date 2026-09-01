// Batched Cairn → Garmin history backfill. Offline end to end: the Garmin write
// surface is the same recording fake the incremental export uses, so an APPLY is
// observed by what the serial queue actually sent, in what order.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { garminExportBackfill } from "../dist/garminExportBackfill.js";
import { exportSessionToGarmin, setGarminStrengthApiForTests } from "../dist/garminExport.js";
import { db, repo } from "./_seed.js";

let nextActivityId = 9000;

function install() {
  const calls = { get: [], put: [], create: [], delete: [] };
  const api = {
    async getExerciseSets(activityId) {
      calls.get.push(String(activityId));
      return null;
    },
    async putExerciseSets(activityId, payload) {
      calls.put.push({ activityId: String(activityId), payload });
    },
    async createManualActivity(input) {
      calls.create.push(input);
      return { activityId: ++nextActivityId };
    },
    async deleteActivity(activityId) {
      calls.delete.push(String(activityId));
    },
  };
  setGarminStrengthApiForTests(() => api);
  return calls;
}

// A finished session on `date` with N sets of a lift the FIT catalog knows, so the
// mapping is never what's under test.
function seedFinishedSession(date, sets = 2, exercise = "Back Squat") {
  for (let i = 0; i < sets; i++) {
    repo.logSetByName({ exercise, weight: 185 + i * 10, reps: 5, date });
  }
  const session = repo.getSessionByDate(date);
  repo.finishSession(session.id);
  return session.id;
}

// The queue drains on its own; give it turns until it settles.
async function drainQueue() {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

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
      /* table may not exist in an older migration fixture */
    }
  }
  repo.setSettings({ enrich_enabled: false, garmin_username: "athlete@example.com", garmin_password: "secret" });
});

afterEach(async () => {
  // finishSession enqueues write-back onto a serial queue that can drain after the
  // fake is gone; flipping the toggle off makes leftovers skip instead of reaching a
  // live account.
  try {
    repo.setSettings({ garmin_export_strength: false });
  } catch {
    /* settings table may already be gone */
  }
  await drainQueue();
  setGarminStrengthApiForTests(null);
});

test("a dry run reports every eligible session and sends nothing", async () => {
  const calls = install();
  const older = seedFinishedSession("2026-04-01", 2);
  const newer = seedFinishedSession("2026-04-08", 3);
  await drainQueue();
  const before = calls.put.length;

  const result = await garminExportBackfill();

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.total_eligible, 2);
  assert.equal(result.enqueued, 0);
  assert.equal(result.remaining, 0);
  assert.equal(calls.put.length, before, "a dry run touches no network");
  // Oldest first, so Garmin's history builds forward.
  assert.deepEqual(
    result.batch.map((row) => row.session_id),
    [older, newer]
  );
  assert.deepEqual(
    result.batch.map((row) => row.date),
    ["2026-04-01", "2026-04-08"]
  );
  assert.deepEqual(
    result.batch.map((row) => row.sets),
    [2, 3]
  );
});

test("an already-exported session is predicted unchanged; an edited one is not", async () => {
  install();
  const sessionId = seedFinishedSession("2026-04-01", 2);
  await exportSessionToGarmin(sessionId);

  const first = await garminExportBackfill();
  assert.equal(first.batch[0].planned, "unchanged");
  assert.equal(first.batch[0].prior_export.activity_id, String(nextActivityId));
  assert.equal(first.batch[0].predicted_fingerprint, repo.getSessionGarminExport(sessionId).fingerprint);

  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 3, date: "2026-04-01" });
  const second = await garminExportBackfill();
  assert.equal(second.batch[0].planned, "fill_or_replace", "the prior manual activity is written onto, not re-created");
});

test("a never-exported session plans a create, and a watch day plans a write in place", async () => {
  install();
  // Seed with the toggle off so nothing is exported at finish time — these two days
  // are exactly the history a backfill exists for.
  repo.setSettings({ garmin_export_strength: false });
  seedFinishedSession("2026-04-01", 2);
  const withWatch = seedFinishedSession("2026-04-08", 2);
  await drainQueue(); // the finish-time jobs run — and skip, because the toggle is off
  repo.setSettings({ garmin_export_strength: true });
  const activity = repo.upsertGarminActivity({
    external_id: "watch-1",
    date: "2026-04-08",
    start_time: "2026-04-08T07:30:00",
    type: "strength_training",
    name: "Strength",
    duration_min: 30,
    avg_hr: 128,
  });
  repo.reconcileGarminStrength(activity.id);
  await drainQueue();

  const result = await garminExportBackfill();

  assert.equal(result.batch[0].planned, "create");
  assert.equal(result.batch[0].watch_activity_id, null);
  const watchRow = result.batch.find((row) => row.session_id === withWatch);
  assert.equal(watchRow.watch_activity_id, "watch-1");
  assert.equal(watchRow.planned !== "create", true, "the watch already has the activity");
});

// The preview is a prediction, and the only way it stays honest is by asking the
// exporter's own planner. These three cases are ones the preview's old hand-written
// copy of the decision got wrong — it knew nothing about the pin, the provenance
// ledger or the Cairn name marker.
function seedLinkedActivity(sessionId, externalId, date, extra = {}) {
  const activity = repo.upsertGarminActivity({
    external_id: externalId,
    date,
    start_time: `${date}T07:30:00`,
    type: "strength_training",
    name: "Strength",
    duration_min: 30,
    ...extra,
  });
  repo.reconcileGarminStrength(activity.id);
  db.prepare(`UPDATE garmin_activities SET session_id = ? WHERE id = ?`).run(sessionId, activity.id);
  return activity;
}

test("a day already written to one recording is predicted unchanged, not rewritten", async () => {
  // A second recording syncs carrying heart rate. It ranks higher, but the sets have a
  // home and the exporter will not move them — the preview has to say the same, or an
  // apply looks like it will rewrite a day it silently skips.
  install();
  const sessionId = seedFinishedSession("2026-04-01", 2);
  seedLinkedActivity(sessionId, "watch-a", "2026-04-01");
  await exportSessionToGarmin(sessionId);
  assert.equal(repo.getSessionGarminExport(sessionId).activity_id, "watch-a");
  seedLinkedActivity(sessionId, "watch-b", "2026-04-01", { avg_hr: 140, calories: 310 });

  const preview = (await garminExportBackfill()).batch[0];

  assert.equal(preview.planned, "unchanged");
  assert.equal(preview.target_activity_id, "watch-a");
  assert.equal((await exportSessionToGarmin(sessionId)).skipped, "unchanged", "the exporter agrees");
});

test("a watch recording beside our shell is predicted retarget, and names the shell", async () => {
  install();
  const sessionId = seedFinishedSession("2026-04-01", 2);
  await exportSessionToGarmin(sessionId);
  const shellId = repo.getSessionGarminExport(sessionId).activity_id;
  seedLinkedActivity(sessionId, "watch-1", "2026-04-01", { avg_hr: 131, calories: 300 });

  const preview = (await garminExportBackfill()).batch[0];

  assert.equal(preview.planned, "retarget");
  assert.equal(preview.target_activity_id, "watch-1");
  assert.deepEqual(preview.surplus_activity_ids, [shellId], "the shell it would withdraw is named up front");

  const done = await exportSessionToGarmin(sessionId);
  assert.equal(done.mode, "retarget");
  assert.equal(done.activity_id, preview.target_activity_id);
});

test("a surplus marked shell is predicted as a drop, with nothing rewritten", async () => {
  install();
  const sessionId = seedFinishedSession("2026-04-01", 2);
  await exportSessionToGarmin(sessionId);
  const shellId = repo.getSessionGarminExport(sessionId).activity_id;
  // A second shell Cairn authored — a create whose response was lost. It never reached
  // the export record, so only its NAME says it is ours.
  seedLinkedActivity(sessionId, "shell-orphan", "2026-04-01", { name: "Push · Cairn" });

  const preview = (await garminExportBackfill()).batch[0];

  assert.equal(preview.planned, "drop_surplus");
  assert.equal(preview.target_activity_id, shellId, "the sets stay where they already are");
  assert.deepEqual(preview.surplus_activity_ids, ["shell-orphan"]);

  const calls = install();
  await exportSessionToGarmin(sessionId);
  assert.deepEqual(calls.delete, ["shell-orphan"]);
  assert.equal(calls.put.length, 0, "nothing is rewritten — the prediction said so");
});

test("a session no lift maps on is reported as a whole-session skip", async () => {
  install();
  repo.logSetByName({ exercise: "ZTest Knee Wibble", weight: 20, reps: 10, date: "2026-04-01" });
  const session = repo.getSessionByDate("2026-04-01");
  repo.finishSession(session.id);
  await drainQueue();

  const result = await garminExportBackfill();

  const row = result.batch.find((entry) => entry.session_id === session.id);
  assert.equal(row.planned, "skip_no_mapped_sets");
  assert.equal(row.mapped_sets, 0);
  assert.deepEqual(row.unmapped_exercises, ["ZTest Knee Wibble"]);
  assert.deepEqual(result.unmapped_exercises, ["ZTest Knee Wibble"]);
});

test("limit caps the batch and remaining counts what is left", async () => {
  install();
  for (const date of ["2026-04-01", "2026-04-08", "2026-04-15"]) seedFinishedSession(date, 1);
  await drainQueue();

  const result = await garminExportBackfill({ limit: 2 });

  assert.equal(result.total_eligible, 3);
  assert.equal(result.batch.length, 2);
  assert.equal(result.remaining, 1);
  assert.deepEqual(
    result.batch.map((row) => row.date),
    ["2026-04-01", "2026-04-08"],
    "a batch takes the OLDEST sessions first"
  );
  // Out-of-range limits clamp rather than throw.
  assert.equal((await garminExportBackfill({ limit: 0 })).batch.length, 3);
  assert.equal((await garminExportBackfill({ limit: 9999 })).batch.length, 3);
});

test("since/until scope the window", async () => {
  install();
  for (const date of ["2026-04-01", "2026-04-08", "2026-04-15"]) seedFinishedSession(date, 1);
  await drainQueue();

  const scoped = await garminExportBackfill({ since: "2026-04-05", until: "2026-04-10" });

  assert.equal(scoped.total_eligible, 1);
  assert.deepEqual(
    scoped.batch.map((row) => row.date),
    ["2026-04-08"]
  );
});

test("apply enqueues the exports oldest first, and skips the unchanged ones", async () => {
  const calls = install();
  const older = seedFinishedSession("2026-04-01", 2);
  const middle = seedFinishedSession("2026-04-08", 2);
  const newer = seedFinishedSession("2026-04-15", 2);
  await drainQueue();
  // The middle session is already on Garmin and unchanged; the other two are not.
  for (const id of [older, newer]) db.prepare(`UPDATE sessions SET garmin_json = NULL WHERE id = ?`).run(id);
  assert.ok(repo.getSessionGarminExport(middle), "the middle session kept its export record");
  const putsBefore = calls.put.length;

  const result = await garminExportBackfill({ apply: true });

  assert.equal(result.dry_run, false);
  assert.equal(result.enqueued, 2, "the unchanged session is not re-sent");
  await drainQueue();

  const sent = calls.put.slice(putsBefore).map((call) => call.activityId);
  assert.equal(sent.length, 2);
  assert.deepEqual(
    [older, newer].map((id) => repo.getSessionGarminExport(id).activity_id),
    sent,
    "the oldest session was written first"
  );
});

test("refine_unmapped queues the agentic exercise pass only when enrichment is on", async () => {
  install();
  repo.logSetByName({ exercise: "ZTest Knee Wibble", weight: 20, reps: 10, date: "2026-04-01" });
  const session = repo.getSessionByDate("2026-04-01");
  repo.finishSession(session.id);
  await drainQueue();
  // The lift has been through enrichment already, so 'unmapped' is the only reason
  // it qualifies here.
  const wibble = repo.findExercise("ZTest Knee Wibble");
  repo.setExerciseEnrichStatus(wibble.id, "done");

  // A dry run never queues an agent, however loudly it is asked to — but it does say
  // who would be queued.
  const dry = await garminExportBackfill({ refine_unmapped: true });
  assert.deepEqual(dry.refine_queued, []);
  assert.equal(dry.refine_skipped, "dry_run");
  assert.deepEqual(
    dry.refine_candidates.map((row) => [row.exercise, row.reason]),
    [["ZTest Knee Wibble", "unmapped"]]
  );
  assert.equal(repo.getExercise(wibble.id).enrichment_status, "done", "a dry run stamps nothing");

  const off = await garminExportBackfill({ apply: true, refine_unmapped: true });
  assert.deepEqual(off.refine_queued, []);
  assert.equal(off.refine_skipped, "enrich_disabled");

  repo.setSettings({ enrich_enabled: true });
  const on = await garminExportBackfill({ apply: true, refine_unmapped: true });
  assert.deepEqual(
    on.refine_queued.map((row) => [row.exercise, row.reason]),
    [["ZTest Knee Wibble", "unmapped"]]
  );
  assert.equal(on.refine_skipped, undefined);
  assert.equal(repo.getExercise(wibble.id).enrichment_status, "pending");
  repo.setSettings({ enrich_enabled: false });
});

test("a mapped lift that never went through enrichment is refined too", async () => {
  install();
  // An install that predates the background cleanup: the movement maps onto the FIT
  // catalog fine, but its name was never canonicalized and it carries no enrichment
  // status at all.
  const sessionId = seedFinishedSession("2026-04-01", 2, "Bench press machine");
  await drainQueue();
  const legacy = repo.findExercise("Bench press machine");
  db.prepare(`UPDATE exercises SET enrichment_status = NULL WHERE id = ?`).run(legacy.id);
  assert.ok(legacy.garmin_category, "the catalog placed it, so it is not the unmapped cohort");

  const dry = await garminExportBackfill({ refine_unmapped: true });

  assert.equal(dry.batch[0].session_id, sessionId);
  assert.deepEqual(dry.unmapped_exercises, [], "nothing was unmappable");
  assert.deepEqual(
    dry.refine_candidates.map((row) => [row.exercise, row.reason]),
    [["Bench press machine", "never_enriched"]]
  );

  repo.setSettings({ enrich_enabled: true });
  const on = await garminExportBackfill({ apply: true, refine_unmapped: true });
  assert.deepEqual(
    on.refine_queued.map((row) => [row.exercise, row.reason]),
    [["Bench press machine", "never_enriched"]]
  );
  assert.equal(repo.getExercise(legacy.id).enrichment_status, "pending");

  // Already enriched (or already queued) is not a candidate a second time.
  repo.setExerciseEnrichStatus(legacy.id, "done");
  const settled = await garminExportBackfill({ refine_unmapped: true });
  assert.deepEqual(settled.refine_candidates, []);
  repo.setSettings({ enrich_enabled: false });
});

test("the toggle and a missing Garmin account both short-circuit the whole run", async () => {
  install();
  seedFinishedSession("2026-04-01", 2);
  await drainQueue();

  repo.setSettings({ garmin_export_strength: false });
  const disabled = await garminExportBackfill({ apply: true });
  assert.deepEqual(disabled, { ok: true, skipped: "export_disabled" });

  repo.setSettings({ garmin_export_strength: true, garmin_username: "", clear_garmin_password: true });
  const unconfigured = await garminExportBackfill({ apply: true });
  assert.deepEqual(unconfigured, { ok: true, skipped: "garmin_not_configured" });
});
