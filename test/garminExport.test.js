// Cairn → Garmin strength write-back. Offline end to end: the Garmin write surface is
// a recording fake, so every branch of the decision tree (create / fill / replace /
// retarget / the five skips) is asserted without a single network call.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { processGarminStrengthJob } from "../dist/enrich.js";
import {
  cairnShellActivityName,
  createLiveGarminStrengthApi,
  exportSessionToGarmin,
  sessionBoundStartMs,
  setGarminStrengthApiForTests,
} from "../dist/garminExport.js";
import { runWithTimeZone } from "../dist/tz.js";
import { db, repo, isoDaysAgo } from "./_seed.js";

const TODAY = isoDaysAgo(0);

function fakeApi(options = {}) {
  const calls = { get: [], put: [], create: [], delete: [] };
  const api = {
    async getExerciseSets(activityId) {
      calls.get.push(String(activityId));
      return options.existing ?? null;
    },
    async putExerciseSets(activityId, payload) {
      calls.put.push({ activityId: String(activityId), payload });
      if (options.putThrows) {
        const error = options.putThrows;
        options.putThrows = null; // one failure only, so a retry can be observed
        throw error;
      }
    },
    async createManualActivity(input) {
      calls.create.push(input);
      return { activityId: options.createdId ?? 9001 };
    },
    async deleteActivity(activityId) {
      calls.delete.push(String(activityId));
      if (options.deleteThrows) throw options.deleteThrows;
    },
  };
  return { api, calls };
}

function install(options) {
  const { api, calls } = fakeApi(options);
  setGarminStrengthApiForTests(() => api);
  return calls;
}

function activeSlot(index, seconds = 40) {
  return {
    setType: "ACTIVE",
    messageIndex: index,
    startTime: `${TODAY}T07:${String(30 + index).padStart(2, "0")}:00.0`,
    duration: seconds,
    repetitionCount: null,
    weight: null,
    exercises: [{ category: "UNKNOWN", name: null, probability: 100 }],
  };
}

function restSlot(index) {
  return { setType: "REST", messageIndex: index, duration: 90, exercises: null };
}

// A finished session with N sets of a lift the catalog knows, so the mapping is never
// the thing under test in the write-back cases.
function seedFinishedSession(sets = 3) {
  for (let i = 0; i < sets; i++) {
    repo.logSetByName({ exercise: "Back Squat", weight: 185 + i * 10, reps: 5, date: TODAY });
  }
  const session = repo.getSessionByDate(TODAY);
  repo.finishSession(session.id);
  return session.id;
}

function seedWatchActivity(externalId, extra = {}) {
  return repo.upsertGarminActivity({
    external_id: externalId,
    date: TODAY,
    start_time: `${TODAY}T07:30:00`,
    type: "strength_training",
    name: "Strength",
    duration_min: 32,
    ...extra,
  });
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
  // Enrichment off: nothing agentic may run. Credentials present so the connector
  // reads as configured — the fake API is what actually answers.
  repo.setSettings({ enrich_enabled: false, garmin_username: "athlete@example.com", garmin_password: "secret" });
});

afterEach(() => {
  setGarminStrengthApiForTests(null);
  // finishSession enqueues onto a serial queue that can drain after the fake is
  // gone; flipping the toggle off makes those leftovers skip instead of hitting
  // a live account.
  try {
    repo.setSettings({ garmin_export_strength: false });
  } catch {
    /* settings table may already be gone */
  }
});

test("a Cairn-only strength day gets a manual Garmin activity, then its sets", async () => {
  const calls = install();
  const sessionId = seedFinishedSession(3);

  const result = await exportSessionToGarmin(sessionId);

  assert.equal(result.ok, true);
  assert.equal(result.mode, "create");
  assert.equal(calls.create.length, 1);
  // The shell says who made it, so it stays identifiable even if our record is lost.
  assert.equal(calls.create[0].name.endsWith(" · Cairn"), true);
  assert.equal(calls.create[0].name.length <= 80, true);
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0].payload.exerciseSets.length, 3);
  assert.equal(calls.put[0].payload.exerciseSets[0].exercises[0].category, "SQUAT");
  // Load is grams on the wire, pounds in Cairn.
  assert.equal(calls.put[0].payload.exerciseSets[0].weight, 83915);

  const stored = repo.getSessionGarminExport(sessionId);
  assert.equal(stored.source, "manual");
  assert.equal(stored.activity_id, "9001");
  assert.equal(stored.mode, "create");
  // The activity we authored is mirrored into the read side, so the day shows ONE
  // strength activity and a later real sync of the same id updates that row.
  const linked = repo.listSessionGarminStrengthActivities(sessionId);
  assert.deepEqual(
    linked.map((row) => row.external_id),
    ["9001"]
  );
});

test("a day the watch also recorded is written in place — never a second activity", async () => {
  const calls = install({ existing: { exerciseSets: [activeSlot(0)] } });
  const sessionId = seedFinishedSession(3);
  const activity = seedWatchActivity("watch-1", { avg_hr: 128, calories: 290 });
  repo.reconcileGarminStrength(activity.id);

  const result = await exportSessionToGarmin(sessionId);

  assert.equal(result.ok, true);
  assert.equal(calls.create.length, 0, "the watch already has the activity");
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0].activityId, "watch-1");
  assert.equal(repo.getSessionGarminExport(sessionId).source, "watch");
});

test("a Garmin-owned day is never overwritten", async () => {
  const calls = install();
  // The athlete lifted with the watch and nothing else: no Cairn sets exist when the
  // activity reconciles, so Garmin's own detected sets are the truth for that day.
  const activity = seedWatchActivity("watch-owned", {
    avg_hr: 130,
    exercise_sets: [
      { category: "SQUAT", name: "SQUAT", reps: 5, weight_kg: 84 },
      { category: "SQUAT", name: "SQUAT", reps: 5, weight_kg: 84 },
    ],
  });
  repo.reconcileGarminStrength(activity.id);
  await processGarminStrengthJob(activity.id);
  const session = repo.getSessionByDate(TODAY);
  repo.finishSession(session.id);
  assert.equal(repo.getSessionDetail(session.id).garmin.cairn_sets_authoritative, false);
  assert.ok(session.sets.length > 0, "Garmin's sets were imported");

  const result = await exportSessionToGarmin(session.id);

  assert.equal(result.skipped, "garmin_owns_sets");
  assert.equal(calls.put.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(
    repo.sessionsEligibleForGarminExport("2020-01-01").includes(session.id),
    false,
    "sync must not even enqueue a Garmin-owned day"
  );
});

test("an unchanged session is not re-written", async () => {
  const calls = install();
  const sessionId = seedFinishedSession(3);

  await exportSessionToGarmin(sessionId);
  assert.equal(calls.put.length, 1);

  const second = await exportSessionToGarmin(sessionId);
  assert.equal(second.skipped, "unchanged");
  assert.equal(calls.put.length, 1, "the fingerprint matched, so nothing was sent");

  // Editing the work re-exports: the log is the truth and Garmin has to follow it.
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 3, date: TODAY });
  const third = await exportSessionToGarmin(sessionId);
  assert.equal(third.ok, true);
  assert.equal(third.skipped, undefined);
  assert.equal(calls.put.length, 2);
  assert.equal(calls.put[1].payload.exerciseSets.length, 4);
});

test("the watch's own set slots are FILLED when the ACTIVE count matches", async () => {
  // Three ACTIVE slots with rest between them: the watch knows WHEN each set happened,
  // which is evidence Cairn does not have, so its segmentation is preserved.
  const existing = {
    exerciseSets: [activeSlot(0), restSlot(1), activeSlot(2), restSlot(3), activeSlot(4)],
  };
  const calls = install({ existing });
  const sessionId = seedFinishedSession(3);
  const activity = seedWatchActivity("watch-fill", { avg_hr: 126 });
  repo.reconcileGarminStrength(activity.id);

  const result = await exportSessionToGarmin(sessionId);

  assert.equal(result.mode, "fill");
  const written = calls.put[0].payload.exerciseSets;
  assert.equal(written.length, existing.exerciseSets.length, "slots are preserved, not replaced");
  const active = written.filter((slot) => slot.setType === "ACTIVE");
  assert.equal(active.length, 3);
  for (const slot of active) {
    assert.equal(slot.exercises[0].category, "SQUAT");
    assert.equal(slot.repetitionCount, 5);
  }
  // Rest periods survive untouched.
  assert.equal(written.filter((slot) => slot.setType === "REST").length, 2);
  // Original timing is kept.
  assert.equal(active[0].startTime, existing.exerciseSets[0].startTime);
});

test("extra watch slots are REPLACE, not a positional fill of the first N", async () => {
  // Four ACTIVE slots vs three logged sets: filling the first three would relabel the
  // watch's fourth lift. REPLACE is the honest shape.
  const existing = {
    exerciseSets: [activeSlot(0), restSlot(1), activeSlot(2), restSlot(3), activeSlot(4), restSlot(5), activeSlot(6)],
  };
  const calls = install({ existing });
  const sessionId = seedFinishedSession(3);
  const activity = seedWatchActivity("watch-mismatch", { avg_hr: 126 });
  repo.reconcileGarminStrength(activity.id);

  const result = await exportSessionToGarmin(sessionId);

  assert.equal(result.mode, "replace");
  const written = calls.put[0].payload.exerciseSets;
  assert.equal(written.length, 3);
  for (const slot of written) {
    assert.equal(slot.setType, "ACTIVE");
    assert.equal(slot.exercises[0].category, "SQUAT");
  }
});

test("when the watch recorded fewer slots than Cairn logged, the sets REPLACE them", async () => {
  const calls = install({ existing: { exerciseSets: [activeSlot(0), restSlot(1)] } });
  const sessionId = seedFinishedSession(3);
  const activity = seedWatchActivity("watch-replace", { avg_hr: 126 });
  repo.reconcileGarminStrength(activity.id);

  const result = await exportSessionToGarmin(sessionId);

  assert.equal(result.mode, "replace");
  const written = calls.put[0].payload.exerciseSets;
  assert.equal(written.length, 3);
  for (const slot of written) {
    assert.equal(slot.setType, "ACTIVE");
    assert.equal(slot.exercises[0].category, "SQUAT");
  }
  // Spread across the session, not stacked at one instant.
  assert.notEqual(written[0].startTime, written[1].startTime);
});

test("the watch's later recording takes the sets over, and the manual shell is deleted", async () => {
  const calls = install();
  const sessionId = seedFinishedSession(3);
  await exportSessionToGarmin(sessionId);
  assert.equal(repo.getSessionGarminExport(sessionId).source, "manual");
  assert.equal(calls.create.length, 1);

  // The watch's own recording of the same workout syncs afterwards, carrying real
  // physiology. It is the better home for the sets.
  const watch = seedWatchActivity("watch-late", { avg_hr: 131, calories: 305 });
  repo.reconcileGarminStrength(watch.id);

  const result = await exportSessionToGarmin(sessionId);

  assert.equal(result.ok, true);
  assert.equal(result.mode, "retarget");
  assert.equal(result.activity_id, "watch-late");
  assert.deepEqual(calls.delete, ["9001"], "the shell we invented is removed");
  assert.equal(calls.put.at(-1).activityId, "watch-late");
  const stored = repo.getSessionGarminExport(sessionId);
  assert.equal(stored.source, "watch");
  assert.equal(stored.activity_id, "watch-late");
  // The day is left with one strength activity.
  assert.deepEqual(
    repo.listSessionGarminStrengthActivities(sessionId).map((row) => row.external_id),
    ["watch-late"]
  );
});

test("a session Garmin cannot place any lift from is skipped whole", async () => {
  const calls = install();
  repo.logSetByName({ exercise: "ZTest Knee Wibble", weight: 20, reps: 10, date: TODAY });
  const session = repo.getSessionByDate(TODAY);
  repo.finishSession(session.id);
  // Nothing was mapped at insert, and the mapper still cannot place it.
  const exercise = repo.findExercise("ZTest Knee Wibble");
  assert.equal(exercise.garmin_category, null);

  const result = await exportSessionToGarmin(session.id);

  assert.equal(result.skipped, "no_mapped_exercises");
  assert.equal(calls.put.length, 0);
  assert.equal(calls.create.length, 0);
});

test("turning the toggle off stops the write-back entirely", async () => {
  const calls = install();
  const sessionId = seedFinishedSession(2);
  repo.setSettings({ garmin_export_strength: false });

  const result = await exportSessionToGarmin(sessionId);

  assert.equal(result.skipped, "export_disabled");
  assert.equal(calls.put.length, 0);
  assert.equal(calls.create.length, 0);
});

test("no Garmin account means no write-back, and no error either", async () => {
  const calls = install();
  const sessionId = seedFinishedSession(2);
  repo.setSettings({ garmin_username: "", clear_garmin_password: true });

  const result = await exportSessionToGarmin(sessionId);

  assert.equal(result.ok, true);
  assert.equal(result.skipped, "garmin_not_configured");
  assert.equal(calls.put.length, 0);
});

test("a rejected sub-exercise falls back to the category rather than losing the session", async () => {
  // Garmin 400s a sub-exercise its firmware does not accept under that category. The
  // category is always legal, so the retry drops the sub-names.
  const error = Object.assign(new Error("Request failed with status code 400"), { status: 400 });
  const calls = install({ putThrows: error });
  const sessionId = seedFinishedSession(2);

  const result = await exportSessionToGarmin(sessionId);

  assert.equal(result.ok, true);
  assert.equal(calls.put.length, 2);
  for (const slot of calls.put[1].payload.exerciseSets) assert.equal(slot.exercises[0].name, null);
  assert.equal(calls.put[1].payload.exerciseSets[0].exercises[0].category, "SQUAT");
});

test("finishing a session enqueues the write-back without throwing when Garmin is unconfigured", async () => {
  repo.setSettings({ garmin_username: "", clear_garmin_password: true });
  setGarminStrengthApiForTests(() => {
    throw new Error("the live client must never be built for an unconfigured account");
  });
  repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, date: TODAY });
  const session = repo.getSessionByDate(TODAY);

  assert.doesNotThrow(() => repo.finishSession(session.id));
  // The queued job resolves to a skip; give the microtask queue a turn so a rejection
  // inside the lazy import would surface here rather than as an unhandled rejection.
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(repo.getSessionGarminExport(session.id), null);
});

test("a failed PUT after create retries onto the same activity, not a second one", async () => {
  const error = Object.assign(new Error("Garmin 500"), { status: 500 });
  const calls = install({ putThrows: error });
  const sessionId = seedFinishedSession(2);

  const first = await exportSessionToGarmin(sessionId);
  assert.equal(first.ok, false);
  assert.equal(calls.create.length, 1);
  assert.equal(repo.getSessionGarminExport(sessionId).activity_id, "9001");
  assert.equal(repo.getSessionGarminExport(sessionId).fingerprint, "", "empty so the retry is not skipped as unchanged");

  const second = await exportSessionToGarmin(sessionId);
  assert.equal(second.ok, true);
  assert.equal(calls.create.length, 1, "retry must not invent a second Garmin activity");
  assert.equal(calls.put.length, 2);
  assert.equal(calls.put[1].activityId, "9001");
  assert.ok(repo.getSessionGarminExport(sessionId).fingerprint);
});

test("a watch recording with no heart rate still takes over the manual shell", async () => {
  const calls = install();
  const sessionId = seedFinishedSession(3);
  await exportSessionToGarmin(sessionId);

  const watch = seedWatchActivity("watch-no-hr");
  repo.reconcileGarminStrength(watch.id);

  const result = await exportSessionToGarmin(sessionId);

  assert.equal(result.ok, true);
  assert.equal(result.mode, "retarget");
  assert.equal(result.activity_id, "watch-no-hr");
  assert.deepEqual(calls.delete, ["9001"]);
  assert.deepEqual(
    repo.listSessionGarminStrengthActivities(sessionId).map((row) => row.external_id),
    ["watch-no-hr"]
  );
});

test("a 410 on delete treats the shell as already gone", async () => {
  const error = Object.assign(new Error("410 gone"), { status: 410 });
  const calls = install({ deleteThrows: error });
  const sessionId = seedFinishedSession(3);
  await exportSessionToGarmin(sessionId);
  const watch = seedWatchActivity("watch-late", { avg_hr: 131, calories: 305 });
  repo.reconcileGarminStrength(watch.id);

  const result = await exportSessionToGarmin(sessionId);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "retarget");
  assert.deepEqual(calls.delete, ["9001"]);
  assert.deepEqual(repo.getSessionGarminExport(sessionId).pending_deletes, undefined);
  assert.deepEqual(
    repo.listSessionGarminStrengthActivities(sessionId).map((row) => row.external_id),
    ["watch-late"]
  );
});

test("a failed Garmin delete leaves the local activity row and retries the drop", async () => {
  const failCalls = install({ deleteThrows: Object.assign(new Error("502"), { status: 502 }) });
  const sessionId = seedFinishedSession(3);
  await exportSessionToGarmin(sessionId);
  const watch = seedWatchActivity("watch-late", { avg_hr: 131, calories: 305 });
  repo.reconcileGarminStrength(watch.id);

  const first = await exportSessionToGarmin(sessionId);
  assert.equal(first.ok, true);
  assert.equal(first.mode, "retarget");
  assert.deepEqual(failCalls.delete, ["9001"]);
  const afterFail = repo.listSessionGarminStrengthActivities(sessionId).map((row) => row.external_id);
  assert.ok(afterFail.includes("9001"), "local row stays until Garmin actually dropped it");
  assert.ok(afterFail.includes("watch-late"));
  assert.deepEqual(repo.getSessionGarminExport(sessionId).pending_deletes, ["9001"]);
  assert.deepEqual(repo.getSessionGarminExport(sessionId).created_ids, ["9001"], "provenance outlives the retarget");

  const retryCalls = install();
  const second = await exportSessionToGarmin(sessionId);
  assert.equal(second.ok, true);
  assert.equal(retryCalls.create.length, 0, "retry must not invent a second activity");
  assert.equal(retryCalls.put.length, 0, "the sets already landed — only the shell drop was outstanding");
  assert.ok(retryCalls.delete.includes("9001"), "the shell drop is retried once Garmin answers");
  assert.deepEqual(repo.getSessionGarminExport(sessionId).pending_deletes, undefined);
  assert.equal(repo.getSessionGarminExport(sessionId).created_ids, undefined, "the dropped shell leaves the ledger");
  assert.deepEqual(
    repo.listSessionGarminStrengthActivities(sessionId).map((row) => row.external_id),
    ["watch-late"]
  );
});

test("every shell in the ledger is dropped when the real recording arrives", async () => {
  // Two shells Cairn authored (a create whose response was lost, then its retry) and
  // the athlete's own watch recording of the same workout. Provenance comes from the
  // ledger, so BOTH shells are ours to remove — `source` alone forgets, because a
  // retarget rewrites it to "watch".
  const calls = install();
  const sessionId = seedFinishedSession(3);
  repo.reconcileGarminStrength(seedWatchActivity("shell-1").id);
  repo.reconcileGarminStrength(seedWatchActivity("shell-2").id);
  repo.reconcileGarminStrength(seedWatchActivity("watch-real", { avg_hr: 133, calories: 310 }).id);
  repo.recordSessionGarminExport(sessionId, {
    activity_id: "shell-1",
    source: "manual",
    fingerprint: "",
    exported_at: "2026-09-01T12:00:00.000Z",
    mode: "create",
    created_ids: ["shell-1", "shell-2"],
  });

  const result = await exportSessionToGarmin(sessionId);

  assert.equal(result.ok, true);
  assert.equal(result.mode, "retarget");
  assert.equal(result.activity_id, "watch-real");
  assert.deepEqual(
    calls.put.map((call) => call.activityId),
    ["watch-real"]
  );
  assert.deepEqual([...calls.delete].sort(), ["shell-1", "shell-2"]);
  assert.deepEqual(
    repo.listSessionGarminStrengthActivities(sessionId).map((row) => row.external_id),
    ["watch-real"],
    "the day is left with the athlete's own recording"
  );
  const stored = repo.getSessionGarminExport(sessionId);
  assert.equal(stored.activity_id, "watch-real");
  assert.equal(stored.created_ids, undefined, "the ledger is pruned once the shells are gone");

  // And it settles rather than moving again.
  const settled = await exportSessionToGarmin(sessionId);
  assert.equal(settled.skipped, "unchanged");
  assert.equal(settled.activity_id, "watch-real");
  assert.equal(calls.put.length, 1);
});

test("a marked orphan shell is adopted, then dropped when the real recording arrives", async () => {
  // The lost-create case. shell-1's create landed on Garmin but the response never came
  // back, so it never reached the ledger — its NAME is the only evidence it is ours.
  // shell-2 is the retry, on record. The day must still converge to one activity.
  const calls = install();
  const sessionId = seedFinishedSession(3);
  repo.reconcileGarminStrength(seedWatchActivity("shell-1", { name: "Push · Cairn" }).id);
  repo.reconcileGarminStrength(seedWatchActivity("shell-2", { name: "Push · Cairn" }).id);
  repo.recordSessionGarminExport(sessionId, {
    activity_id: "shell-2",
    source: "manual",
    fingerprint: "",
    exported_at: "2026-09-01T12:00:00.000Z",
    mode: "create",
    created_ids: ["shell-2"],
  });

  // No foreign activity yet: the sets stay on the recorded shell and the surplus one
  // goes, rather than a second shell living on as a duplicate forever.
  const collapsed = await exportSessionToGarmin(sessionId);
  assert.equal(collapsed.ok, true);
  assert.equal(collapsed.activity_id, "shell-2");
  assert.deepEqual(calls.delete, ["shell-1"]);
  assert.deepEqual(
    repo.listSessionGarminStrengthActivities(sessionId).map((row) => row.external_id),
    ["shell-2"]
  );

  // The athlete's own recording of the workout syncs: it wins, and our shell goes too.
  repo.reconcileGarminStrength(seedWatchActivity("watch-real", { avg_hr: 133, calories: 310 }).id);
  const moved = await exportSessionToGarmin(sessionId);

  assert.equal(moved.mode, "retarget");
  assert.equal(moved.activity_id, "watch-real");
  assert.deepEqual(calls.delete, ["shell-1", "shell-2"]);
  assert.deepEqual(
    repo.listSessionGarminStrengthActivities(sessionId).map((row) => row.external_id),
    ["watch-real"],
    "one day, one activity"
  );
  assert.equal(repo.getSessionGarminExport(sessionId).created_ids, undefined);
  assert.equal((await exportSessionToGarmin(sessionId)).skipped, "unchanged");
});

test("an UNMARKED activity is never deleted on a physiology guess", async () => {
  // The marker is the only extra-ledger evidence accepted. An activity carrying neither
  // a ledger entry nor the mark may be the athlete's own no-HR watch recording, and
  // deleting one of those is the single unrecoverable mistake here. Cairn holds the
  // sets where they are; what must not happen is a SECOND copy of them.
  const calls = install();
  const sessionId = seedFinishedSession(3);
  repo.reconcileGarminStrength(seedWatchActivity("shell-1").id);
  repo.reconcileGarminStrength(seedWatchActivity("shell-2").id);
  repo.recordSessionGarminExport(sessionId, {
    activity_id: "shell-2",
    source: "manual",
    fingerprint: "",
    exported_at: "2026-09-01T12:00:00.000Z",
    mode: "create",
    created_ids: ["shell-2"],
  });
  await exportSessionToGarmin(sessionId);
  assert.deepEqual(calls.delete, ["shell-2"]);

  repo.reconcileGarminStrength(seedWatchActivity("watch-real", { avg_hr: 133, calories: 310 }).id);
  const after = await exportSessionToGarmin(sessionId);

  assert.equal(after.skipped, "unchanged");
  assert.equal(after.activity_id, "shell-1");
  assert.equal(
    calls.put.some((call) => call.activityId === "watch-real"),
    false,
    "the sets are never written twice"
  );
  assert.deepEqual(calls.delete, ["shell-2"], "nothing is deleted on a guess");
});

test("the activity holding the sets is pinned — a richer recording never gets a second copy", async () => {
  const calls = install();
  const sessionId = seedFinishedSession(3);
  await exportSessionToGarmin(sessionId);

  // The watch's recording syncs with no physiology yet and takes the sets over.
  const first = seedWatchActivity("watch-a");
  repo.reconcileGarminStrength(first.id);
  assert.equal((await exportSessionToGarmin(sessionId)).activity_id, "watch-a");

  // A second recording of the same day arrives carrying HR. It ranks higher, but the
  // sets already have a home: moving them would leave BOTH activities holding the day.
  const second = seedWatchActivity("watch-b", { avg_hr: 140, calories: 310 });
  repo.reconcileGarminStrength(second.id);

  const unchanged = await exportSessionToGarmin(sessionId);
  assert.equal(unchanged.skipped, "unchanged");
  assert.equal(unchanged.activity_id, "watch-a");

  // And an edit still follows the pin rather than re-ranking.
  repo.logSetByName({ exercise: "Back Squat", weight: 245, reps: 2, date: TODAY });
  const edited = await exportSessionToGarmin(sessionId);
  assert.equal(edited.ok, true);
  assert.equal(edited.activity_id, "watch-a");
  assert.equal(repo.getSessionGarminExport(sessionId).activity_id, "watch-a");
  assert.equal(
    calls.put.some((call) => call.activityId === "watch-b"),
    false,
    "the day is never written twice"
  );
});

test("two shells from a timed-out create converge onto one activity", async () => {
  // createManualActivity timed out but landed on Garmin; the retry made a second
  // shell, and a later sync linked both. The next export has to collapse them.
  const calls = install();
  const sessionId = seedFinishedSession(3);
  const firstShell = seedWatchActivity("shell-1");
  const secondShell = seedWatchActivity("shell-2");
  repo.reconcileGarminStrength(firstShell.id);
  repo.reconcileGarminStrength(secondShell.id);
  repo.recordSessionGarminExport(sessionId, {
    activity_id: "shell-2",
    source: "manual",
    fingerprint: "",
    exported_at: "2026-09-01T12:00:00.000Z",
    mode: "create",
  });

  const result = await exportSessionToGarmin(sessionId);

  assert.equal(result.ok, true);
  assert.equal(result.mode, "retarget");
  assert.equal(result.activity_id, "shell-1");
  assert.deepEqual(calls.delete, ["shell-2"]);
  assert.equal(calls.create.length, 0);
  assert.deepEqual(
    repo.listSessionGarminStrengthActivities(sessionId).map((row) => row.external_id),
    ["shell-1"]
  );

  // And it settles: the next pass is a no-op, not another move.
  const settled = await exportSessionToGarmin(sessionId);
  assert.equal(settled.skipped, "unchanged");
  assert.equal(settled.activity_id, "shell-1");
  assert.equal(calls.put.length, 1);
});

test("a coincidental slot count never positionally fills a partly-mapped log", async () => {
  // Five sets logged, two of them a lift Garmin has no enum for. The three that map
  // happen to equal the watch's three ACTIVE slots — filling would put squat labels
  // on slots that were something else.
  const existing = { exerciseSets: [activeSlot(0), restSlot(1), activeSlot(2), restSlot(3), activeSlot(4)] };
  const calls = install({ existing });
  for (let i = 0; i < 3; i++) repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, date: TODAY });
  for (let i = 0; i < 2; i++) repo.logSetByName({ exercise: "ZTest Knee Wibble", weight: 20, reps: 10, date: TODAY });
  const session = repo.getSessionByDate(TODAY);
  repo.finishSession(session.id);
  const activity = seedWatchActivity("watch-partial", { avg_hr: 126 });
  repo.reconcileGarminStrength(activity.id);

  const result = await exportSessionToGarmin(session.id);

  assert.equal(result.mode, "replace");
  const written = calls.put[0].payload.exerciseSets;
  assert.equal(written.length, 3, "only the mapped lifts are written");
  for (const slot of written) assert.equal(slot.setType, "ACTIVE");
});

test("deleting every set retracts the manual activity Cairn created", async () => {
  const calls = install();
  const sessionId = seedFinishedSession(2);
  await exportSessionToGarmin(sessionId);
  assert.equal(repo.getSessionGarminExport(sessionId).activity_id, "9001");

  db.prepare(`DELETE FROM logged_sets WHERE session_id = ?`).run(sessionId);
  const result = await exportSessionToGarmin(sessionId);

  assert.equal(result.ok, true);
  assert.equal(result.skipped, "no_logged_sets_retracted");
  assert.deepEqual(calls.delete, ["9001"]);
  assert.equal(repo.getSessionGarminExport(sessionId), null, "we no longer claim Garmin holds anything");
  assert.deepEqual(repo.listSessionGarminStrengthActivities(sessionId), []);

  // Nothing left to retract, so the next pass is a plain skip.
  const again = await exportSessionToGarmin(sessionId);
  assert.equal(again.skipped, "no_logged_sets");
  assert.equal(calls.delete.length, 1);
});

test("deleting every set leaves the watch's own recording untouched", async () => {
  const calls = install();
  const sessionId = seedFinishedSession(2);
  const watch = seedWatchActivity("watch-keep", { avg_hr: 128, calories: 260 });
  repo.reconcileGarminStrength(watch.id);
  await exportSessionToGarmin(sessionId);
  assert.equal(repo.getSessionGarminExport(sessionId).source, "watch");

  db.prepare(`DELETE FROM logged_sets WHERE session_id = ?`).run(sessionId);
  const result = await exportSessionToGarmin(sessionId);

  // The watch's original slot labels cannot be restored, so the recording stays.
  assert.equal(result.ok, true);
  assert.equal(result.skipped, "no_logged_sets_watch_kept");
  assert.equal(calls.delete.length, 0);
  assert.equal(repo.getSessionGarminExport(sessionId).activity_id, "watch-keep");
});

test("sync eligibility survives any garmin_json shape and honours both window ends", () => {
  install();
  const sessionId = seedFinishedSession(1);

  db.prepare(`UPDATE sessions SET garmin_json = NULL WHERE id = ?`).run(sessionId);
  assert.ok(repo.sessionsEligibleForGarminExport("2020-01-01").includes(sessionId), "a null blob is not authoritative");

  const record = { activity_id: "9001", source: "manual", fingerprint: "x", exported_at: "", mode: "create" };
  const exportOnly = { export: record };
  db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(JSON.stringify(exportOnly), sessionId);
  assert.ok(repo.sessionsEligibleForGarminExport("2020-01-01").includes(sessionId), "a blob with only an export row");

  assert.ok(repo.sessionsEligibleForGarminExport(TODAY, TODAY).includes(sessionId), "both bounds are inclusive");
  assert.equal(repo.sessionsEligibleForGarminExport(isoDaysAgo(-1)).includes(sessionId), false, "starts after the day");
  const endedYesterday = repo.sessionsEligibleForGarminExport("2020-01-01", isoDaysAgo(1));
  assert.equal(endedYesterday.includes(sessionId), false, "a window ending before the day excludes it");

  // With the sets gone but an export still on record, the day stays a candidate —
  // that is the pass that retracts it.
  db.prepare(`DELETE FROM logged_sets WHERE session_id = ?`).run(sessionId);
  assert.ok(repo.sessionsEligibleForGarminExport("2020-01-01").includes(sessionId));
});

test("a refused Garmin credential drops the memoized login; a server error keeps it", async () => {
  const build = (error) => {
    let logins = 0;
    const api = createLiveGarminStrengthApi(async () => {
      logins++;
      return {
        url: { GC_API: "https://garmin.invalid" },
        async put() {
          throw error;
        },
      };
    });
    return { api, logins: () => logins };
  };

  const expired = build(Object.assign(new Error("401 unauthorized"), { status: 401 }));
  await assert.rejects(() => expired.api.putExerciseSets("1", { exerciseSets: [] }));
  await assert.rejects(() => expired.api.putExerciseSets("1", { exerciseSets: [] }));
  assert.equal(expired.logins(), 2, "an expired session must not be reused until a restart");

  const flaky = build(Object.assign(new Error("502 bad gateway"), { status: 502 }));
  await assert.rejects(() => flaky.api.putExerciseSets("1", { exerciseSets: [] }));
  await assert.rejects(() => flaky.api.putExerciseSets("1", { exerciseSets: [] }));
  assert.equal(flaky.logins(), 1, "a transient failure is not an auth problem");
});

test("a backfilled session's Garmin start stays on the session's date", async () => {
  const calls = install();
  const date = "2026-04-01";
  for (let i = 0; i < 2; i++) {
    repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, date });
  }
  const session = repo.getSessionByDate(date);
  repo.finishSession(session.id);

  await exportSessionToGarmin(session.id);

  assert.equal(String(calls.create[0].startTimeGmt).slice(0, 10), date);
  const bound = sessionBoundStartMs(date, "2026-09-01T14:00:00Z");
  assert.equal(new Date(bound).toISOString().slice(0, 10), date);
  assert.equal(sessionBoundStartMs("2026-09-01", "2026-09-01T07:30:00Z"), Date.parse("2026-09-01T07:30:00Z"));
});

test("a long session title is trimmed so the Cairn marker always survives", () => {
  const long = cairnShellActivityName("x".repeat(200));
  assert.equal(long.length, 80, "Garmin's cap is 80 characters");
  assert.equal(long.endsWith(" \u00b7 Cairn"), true, "the title is what gets cut, never the marker");
  assert.equal(cairnShellActivityName("   "), "Strength \u00b7 Cairn");
});

test("an evening session west of UTC keeps the real start, not noon", () => {
  // 20:30 America/New_York on Sep 1 is already Sep 2 00:30 UTC. Comparing UTC
  // dates would reject the stamp and file the activity at 12:00 UTC (8am local).
  runWithTimeZone("America/New_York", () => {
    const ms = sessionBoundStartMs("2026-09-01", "2026-09-02 00:30:00");
    assert.equal(new Date(ms).toISOString(), "2026-09-02T00:30:00.000Z");
  });
});

test("Undo of a Garmin merge keeps an export that landed after the snapshot", () => {
  install(); // finishSession enqueues a write; never hit a live account from the suite
  const sessionId = seedFinishedSession(1);
  repo.recordSessionGarminExport(sessionId, {
    activity_id: "9001",
    source: "manual",
    fingerprint: "abc",
    exported_at: "2026-09-01T12:00:00.000Z",
    mode: "create",
  });
  const activity = seedWatchActivity("watch-1", { avg_hr: 120 });
  db.prepare(`UPDATE garmin_activities SET session_id = ? WHERE id = ?`).run(sessionId, activity.id);

  repo.revertGarminReconcile({
    sessions: [
      {
        session_id: sessionId,
        prior_garmin_json: JSON.stringify({ linked: true }),
        activity_ids: [activity.id],
      },
    ],
  });

  const blob = JSON.parse(db.prepare(`SELECT garmin_json FROM sessions WHERE id = ?`).get(sessionId).garmin_json);
  assert.equal(blob.linked, true);
  assert.equal(blob.export.activity_id, "9001");
  assert.equal(blob.export.fingerprint, "abc");
});

// ---- the write-back's own echo coming back in -------------------------------------
//
// Every strength activity a sync sees is queued for the narrative agent. Once Cairn
// writes sessions OUT, the shells it authored sync back IN — so a workout the athlete
// logged by hand paid for an agent call, on every sync, forever, to have a model read
// Cairn's own numbers back to it as "the body's reaction". The deterministic reconcile
// must still run (that is what links the row); only the agentic layer stops.
function enableStubNarrative() {
  repo.setSettings({
    enrich_enabled: true,
    // Only the offline stub is eligible, so "did this reach an agent?" is observable
    // without a network call: the stub always answers, so a narrative appearing means
    // the agent ran and its absence means it was never asked.
    disabled_agents: ["claude", "codex", "antigravity", "grok"],
  });
}

test("a watch's own strength recording still gets the narrative agent", async () => {
  install();
  enableStubNarrative();
  const activity = seedWatchActivity("777001", {
    exercise_sets: [{ category: "BENCH_PRESS", name: "BARBELL_BENCH_PRESS", reps: 5, weight_kg: 60 }],
  });
  repo.reconcileGarminStrength(activity.id);

  await processGarminStrengthJob(activity.id);

  const linked = repo.getGarminActivity(activity.id);
  const session = repo.getSessionDetail(linked.session_id);
  assert.equal(session.garmin.agent, "stub", "an activity the watch recorded is read by the agent");
});

test("an activity Cairn authored is reconciled but never reaches the agent", async () => {
  install();
  enableStubNarrative();
  // The marker Cairn writes into the name is the provenance that survives our own
  // bookkeeping being lost, so it alone is enough to recognise the echo.
  const activity = seedWatchActivity("777002", { name: cairnShellActivityName("Push") });

  await processGarminStrengthJob(activity.id);

  const linked = repo.getGarminActivity(activity.id);
  assert.ok(linked.session_id, "the deterministic reconcile still ran and linked the day");
  const session = repo.getSessionDetail(linked.session_id);
  assert.equal(session.garmin?.agent ?? null, null, "no narrative was requested for our own shell");
});

test("an activity named in the session's export ledger never reaches the agent", async () => {
  install();
  enableStubNarrative();
  // Name unmarked on purpose: an athlete may rename the activity on Garmin, so the
  // ledger has to answer provenance on its own.
  const activity = seedWatchActivity("777003", { name: "Renamed By Athlete" });
  repo.reconcileGarminStrength(activity.id);
  const linked = repo.getGarminActivity(activity.id);
  repo.recordSessionGarminExport(linked.session_id, {
    activity_id: "777003",
    source: "manual",
    fingerprint: "abc",
    exported_at: new Date().toISOString(),
    mode: "create",
    created_ids: ["777003"],
  });

  await processGarminStrengthJob(activity.id);

  const session = repo.getSessionDetail(linked.session_id);
  assert.equal(session.garmin?.agent ?? null, null, "the ledger recognises the echo without the name marker");
});

// `garmin_activities` is UNIQUE on (source_id, external_id). The exporter used to
// resolve its own source, always "default", while the sync resolves
// process.env.GARMIN_SOURCE_LABEL — so on an install that sets the label, the shell
// Cairn created and the same activity coming back from the next sync landed as TWO
// rows, and the day then read as two merged activities.
test("the exporter writes under the same Garmin source the sync uses", async () => {
  const previous = process.env.GARMIN_SOURCE_LABEL;
  process.env.GARMIN_SOURCE_LABEL = "watch-primary";
  try {
    install();
    const sessionId = seedFinishedSession(3);
    const result = await exportSessionToGarmin(sessionId);
    assert.equal(result.ok, true);
    assert.equal(result.activity_id, "9001");

    // Exactly what a following sync does with Garmin's own copy of that activity.
    const source = repo.upsertGarminSource({ label: repo.garminSourceLabel() });
    repo.upsertGarminActivity(
      {
        external_id: "9001",
        date: TODAY,
        start_time: `${TODAY}T07:30:00`,
        type: "strength_training",
        name: cairnShellActivityName("Push"),
        duration_min: 32,
      },
      source.id
    );

    const rows = db.prepare(`SELECT source_id FROM garmin_activities WHERE external_id = '9001'`).all();
    assert.equal(rows.length, 1, "one activity, one row — the sync updates the shell instead of duplicating it");
    assert.equal(rows[0].source_id, source.id, "and it lives under the labelled source, not 'default'");
  } finally {
    if (previous === undefined) delete process.env.GARMIN_SOURCE_LABEL;
    else process.env.GARMIN_SOURCE_LABEL = previous;
  }
});

// The Settings line's data source. Derived from the sessions themselves rather than a
// settings column, so it cannot drift from what actually went out.
test("the last write-back stamp reads the most recent export across sessions", async () => {
  install();
  assert.equal(repo.lastGarminStrengthExportAt(), null, "nothing sent yet reads as nothing, not as a date");

  const sessionId = seedFinishedSession(3);
  await exportSessionToGarmin(sessionId);
  const first = repo.lastGarminStrengthExportAt();
  assert.ok(first, "an export that landed is visible");

  // An older session exporting afterwards must not move the answer backwards.
  const older = repo.getOrCreateSession(isoDaysAgo(9));
  repo.recordSessionGarminExport(older.id, {
    activity_id: "8800",
    source: "manual",
    fingerprint: "old",
    exported_at: "2020-01-01T00:00:00.000Z",
    mode: "create",
  });
  assert.equal(repo.lastGarminStrengthExportAt(), first, "the MOST RECENT export is the answer");
});
