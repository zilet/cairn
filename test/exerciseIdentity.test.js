// Exercise IDENTITY layer (Wave E1): the same lift logged under two names must
// become ONE row everywhere — one progress line, correct per-muscle volume — and the
// old name must keep resolving. Covers:
//   - mergeExercises hardening: FK repoints (logged_sets/plan_items) + the non-FK
//     references (strength_objectives, exercise_aliases.canonical, session_skips,
//     the attention re-test cadence) + a recorded alias + mode-incompatible refusal;
//   - getProgramState reflects a merge immediately (cache invalidation);
//   - reconcileExercises' deterministic pass (exact-key auto-merge + group correction)
//     runs with no usable agent (the offline "stub" fails the reconciliation contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileExercises } from "../dist/coachOps.js";
import { db, repo, isoDaysAgo } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";

// Local frame, NOT UTC — isoDaysAgo and the repo's day keys are local, so a UTC
// TODAY here would land sets on a different day every evening.
const TODAY = localDateISO();

function logReps(exercise, weight, reps, date) {
  repo.logSetByName({ exercise, weight, reps, date });
}

test("mergeExercises repoints sets + plan items, records an alias, and deletes the from-row", () => {
  const from = repo.findOrCreateExercise("Squat", "quads");
  repo.findOrCreateExercise("Back Squat", "quads");
  logReps("Squat", 135, 5, isoDaysAgo(6));
  logReps("Back Squat", 185, 5, TODAY);
  // a plan item referencing the from-lift
  const planDay = db.prepare("INSERT INTO plan_days (day_number, name) VALUES (1, 'Day 1')").run();
  db.prepare("INSERT INTO plan_items (plan_day_id, position, exercise_id, sets, rep_low, rep_high) VALUES (?, 0, ?, 3, 5, 8)")
    .run(planDay.lastInsertRowid, from.id);

  const res = repo.mergeExercises("Squat", "Back Squat");
  assert.equal(res.ok, true);
  assert.ok(res.moved_sets >= 1, "logged sets repointed");
  assert.ok(res.moved_plan_items >= 1, "plan items repointed");

  // the from-row is gone; exactly one Back Squat remains carrying both sets
  assert.equal(repo.findExercise("Squat"), undefined);
  const survivor = repo.findExercise("Back Squat");
  const setCount = db.prepare("SELECT COUNT(*) AS n FROM logged_sets WHERE exercise_id = ?").get(survivor.id).n;
  assert.equal(setCount, 2, "both lifts' sets now belong to the survivor");

  // the old name resolves to the survivor forever (alias recorded)
  assert.equal(repo.findOrCreateExercise("Squat").id, survivor.id, "the old name self-aligns via alias");
});

test("mergeExercises carries the anchor-lift objective, session skips, and re-test cadence", () => {
  repo.findOrCreateExercise("Squat", "quads");
  repo.findOrCreateExercise("Back Squat", "quads");
  logReps("Squat", 135, 5, isoDaysAgo(3));
  logReps("Back Squat", 185, 5, TODAY);

  // an active anchor-lift objective keyed on the from-lift
  db.prepare(
    "INSERT INTO strength_objectives (exercise, exercise_key, target_kind, target_est_1rm, status) VALUES (?, ?, 'explicit_est_1rm', 250, 'active')"
  ).run("Squat", repo.normalizedExerciseKey("Squat"));
  // a one-session skip referencing the from-lift by name
  const sess = repo.getOrCreateSession(TODAY);
  db.prepare("INSERT INTO session_skips (session_id, exercise) VALUES (?, 'Squat')").run(sess.id);
  // a strength re-test cadence row keyed on the from-lift's slug
  db.prepare(
    "INSERT INTO attention_schedule (signal_key, domain, tier, next_due, reason, release_condition) VALUES ('training:strength:squat', 'training', 'surveillance', ?, 'x', 'y')"
  ).run(TODAY);

  const res = repo.mergeExercises("Squat", "Back Squat");
  assert.equal(res.ok, true);
  assert.ok(res.objectives >= 1, "objective repointed");

  const obj = db.prepare("SELECT exercise, exercise_key FROM strength_objectives WHERE status='active'").get();
  assert.equal(obj.exercise, "Back Squat");
  assert.equal(obj.exercise_key, repo.normalizedExerciseKey("Back Squat"));

  assert.equal(db.prepare("SELECT exercise FROM session_skips WHERE session_id=?").get(sess.id).exercise, "Back Squat");

  // the cadence followed the survivor (old slug gone, survivor slug present)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attention_schedule WHERE signal_key='training:strength:squat'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attention_schedule WHERE signal_key='training:strength:back-squat'").get().n, 1);
});

test("merging two lifts that BOTH hold an active anchor supersedes the older one instead of throwing", () => {
  // Schema v98 allows one ACTIVE objective per exercise_key. Repointing a second active
  // row onto the survivor's key would hit that unique index mid-merge and 500 the merge.
  repo.findOrCreateExercise("Squat", "quads");
  repo.findOrCreateExercise("Back Squat", "quads");
  logReps("Squat", 135, 5, isoDaysAgo(3));
  logReps("Back Squat", 185, 5, TODAY);

  const insert = db.prepare(
    "INSERT INTO strength_objectives (exercise, exercise_key, target_kind, target_est_1rm, status) VALUES (?, ?, 'explicit_est_1rm', ?, 'active')"
  );
  const older = insert.run("Squat", repo.normalizedExerciseKey("Squat"), 250).lastInsertRowid;
  const newer = insert.run("Back Squat", repo.normalizedExerciseKey("Back Squat"), 300).lastInsertRowid;

  const res = repo.mergeExercises("Squat", "Back Squat");
  assert.equal(res.ok, true, "the merge succeeds rather than hitting the unique index");
  assert.equal(res.error, undefined);

  const active = db.prepare("SELECT * FROM strength_objectives WHERE status='active'").all();
  assert.equal(active.length, 1, "exactly one active anchor survives on the merged key");
  assert.equal(Number(active[0].id), Number(newer), "the NEWEST anchor is the one left standing");
  assert.equal(active[0].exercise, "Back Squat");
  assert.equal(active[0].exercise_key, repo.normalizedExerciseKey("Back Squat"));

  // The older one is superseded history, not deleted or rewritten — and it followed the
  // survivor so its lift identity stays coherent.
  const retired = db.prepare("SELECT * FROM strength_objectives WHERE id=?").get(older);
  assert.equal(retired.status, "superseded");
  assert.ok(retired.superseded_at, "the supersede is stamped");
  assert.equal(retired.target_est_1rm, 250, "history is immutable");
  assert.equal(retired.exercise_key, repo.normalizedExerciseKey("Back Squat"), "and it repoints to the survivor");
});

test("mergeExercises refuses a timed↔reps merge (incompatible logging shapes)", () => {
  const timed = repo.findOrCreateExercise("Plank"); // detects timed
  const reps = repo.findOrCreateExercise("Crunch"); // reps
  assert.equal(timed.mode, "timed");
  assert.equal(reps.mode, "reps");
  const res = repo.mergeExercises("Plank", "Crunch");
  assert.equal(res.ok, false);
  assert.match(res.error, /timed/);
  // both rows survive — nothing was merged
  assert.ok(repo.findExercise("Plank"));
  assert.ok(repo.findExercise("Crunch"));
});

test("getProgramState reflects a merge immediately (cache is invalidated)", () => {
  repo.findOrCreateExercise("Squat", "quads");
  repo.findOrCreateExercise("Back Squat", "quads");
  for (let i = 0; i < 3; i++) {
    logReps("Squat", 135 + i * 5, 5, isoDaysAgo(9 - i));
    logReps("Back Squat", 185 + i * 5, 5, isoDaysAgo(6 - i));
  }

  const before = repo.getProgramState(TODAY).lifts.map((l) => l.exercise);
  assert.ok(before.includes("Squat"), "the from-lift is present before the merge");
  assert.ok(before.includes("Back Squat"), "the survivor is present before the merge");

  repo.mergeExercises("Squat", "Back Squat");

  const after = repo.getProgramState(TODAY).lifts.map((l) => l.exercise);
  assert.ok(!after.includes("Squat"), "the merged-away lift disappears from program-state at once");
  assert.ok(after.includes("Back Squat"), "the survivor remains");
});

test("reconcileExercises deterministically folds exact-key duplicates + fixes a wrong group (no agent)", async () => {
  // Genuinely PRE-SPLIT rows — the legacy / Garmin-reconcile case (created before the
  // fold, or via a path that bypassed findOrCreateExercise's self-alignment). Insert
  // them directly so both rows exist for the deterministic merge pass to fold.
  const insertEx = (name, group, mode = "reps") =>
    Number(db.prepare("INSERT INTO exercises (name, muscle_group, mode) VALUES (?,?,?)").run(name, group, mode).lastInsertRowid);
  const insertSet = (exId, { weight = null, reps = null, duration_sec = null }, date) => {
    const sess = repo.getOrCreateSession(date);
    db.prepare("INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, duration_sec) VALUES (?,?,1,?,?,?)")
      .run(sess.id, exId, weight, reps, duration_sec);
  };

  // plural duplicate: "Leg Extensions" (1 day) vs "Leg Extension" (2 days)
  const le1 = insertEx("Leg Extensions", "quads");
  const le2 = insertEx("Leg Extension", "quads");
  insertSet(le1, { weight: 90, reps: 12 }, isoDaysAgo(5));
  insertSet(le2, { weight: 95, reps: 10 }, isoDaysAgo(3));
  insertSet(le2, { weight: 100, reps: 10 }, TODAY);
  // mode-variant duplicate: "Dead hang timed" (1 day) vs "Dead hang" (2 days), both timed
  const dh1 = insertEx("Dead hang timed", "forearms", "timed");
  const dh2 = insertEx("Dead hang", "forearms", "timed");
  insertSet(dh1, { duration_sec: 40 }, isoDaysAgo(4));
  insertSet(dh2, { duration_sec: 45 }, isoDaysAgo(2));
  insertSet(dh2, { duration_sec: 50 }, TODAY);
  // a clearly-wrong stored group: a pulldown imported as forearms.
  const pdId = insertEx("Wide-Grip Pulldown", "forearms");
  insertSet(pdId, { weight: 120, reps: 10 }, TODAY);
  const pd = { id: pdId };
  assert.equal(db.prepare("SELECT muscle_group FROM exercises WHERE id=?").get(pd.id).muscle_group, "forearms");

  // The offline stub returns a plan-proposal, which fails the reconciliation contract,
  // so the AGENTIC pass no-ops — but the DETERMINISTIC pass has already done its work.
  // authoritativeGroups:true = the user-initiated "Tidy", which may override a wrong group.
  const res = await reconcileExercises("stub", undefined, { authoritativeGroups: true });

  // Each duplicate cluster collapsed to exactly one surviving row.
  const names = repo.listExercises().map((e) => e.name);
  assert.equal(names.filter((n) => repo.normalizedExerciseKey(n) === "leg extension").length, 1, "leg extension folded to one row");
  assert.equal(names.filter((n) => repo.normalizedExerciseKey(n) === "dead hang").length, 1, "dead hang folded to one row");

  // The wrong group was corrected deterministically to back (override mode).
  assert.equal(db.prepare("SELECT muscle_group FROM exercises WHERE id=?").get(pd.id).muscle_group, "back");
  assert.ok(res.groups_fixed >= 1, "reports the deterministic group correction");

  // The deterministic merges are reported regardless of the agent outcome.
  const mergedFroms = new Set(res.merged.map((m) => repo.normalizedExerciseKey(m.from)));
  assert.ok(mergedFroms.has("leg extension"), "leg-extension duplicate reported as merged");
  assert.ok(mergedFroms.has("dead hang"), "dead-hang duplicate reported as merged");
});

test("reconcileExercises group policy: nightly (authoritativeGroups:false) fills empties but never overrides", async () => {
  const insertEx = (name, group) =>
    Number(db.prepare("INSERT INTO exercises (name, muscle_group, mode) VALUES (?,?, 'reps')").run(name, group).lastInsertRowid);
  const logAt = (exId, date) => {
    const sess = repo.getOrCreateSession(date);
    db.prepare("INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?,?,1,100,8)").run(sess.id, exId);
  };
  // a clearly-wrong non-null group (should be preserved in nightly mode)
  const pdId = insertEx("Wide-Grip Pulldown", "forearms");
  logAt(pdId, TODAY);
  // an empty group (should be FILLED deterministically in either mode)
  const bpId = insertEx("Barbell Bench Press", null);
  logAt(bpId, TODAY);

  // Nightly / background pass: fill-only, no override.
  await reconcileExercises("stub", undefined, { authoritativeGroups: false });
  assert.equal(
    db.prepare("SELECT muscle_group FROM exercises WHERE id=?").get(pdId).muscle_group,
    "forearms",
    "a wrong non-null group is left alone in nightly mode (no tug-of-war)"
  );
  assert.equal(
    db.prepare("SELECT muscle_group FROM exercises WHERE id=?").get(bpId).muscle_group,
    "chest",
    "an empty group is still filled deterministically in nightly mode"
  );

  // The user-initiated Tidy then corrects the wrong group on demand.
  await reconcileExercises("stub", undefined, { authoritativeGroups: true });
  assert.equal(
    db.prepare("SELECT muscle_group FROM exercises WHERE id=?").get(pdId).muscle_group,
    "back",
    "the user-initiated Tidy overrides the wrong group"
  );
});
