// dayRead (src/repo.ts) is the deterministic floor under the Brief. The
// constitution says it SUGGESTS, never gates — these cases pin the three reads
// and the two protect-recovery triggers (earned rest, clearly-low recovery).
// dayRead(date, recovery) takes an explicit recovery object, letting us drive the
// low-sleep branch without coupling to wall-clock "now".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedTrainingDay, seedRecoveryDay, isoDaysAgo } from "./_seed.js";

// A reference date well clear of the recovery window so an empty recovery fetch
// can't accidentally flip the read.
const REF = "2026-03-15";
const dayBefore = (base, n) =>
  new Date(new Date(base + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

beforeEach(() => {
  resetTables("logged_sets", "sessions", "session_skips", "plan_items", "plan_days", "checkins", "daily_metrics", "activities");
});

test("REST on >=3 consecutive training days ending the day before", () => {
  for (let i = 1; i <= 3; i++) seedTrainingDay(dayBefore(REF, i));
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 3);
  assert.match(r.why, /several days running/i);
});

test("does NOT force rest on only 2 consecutive training days", () => {
  for (let i = 1; i <= 2; i++) seedTrainingDay(dayBefore(REF, i));
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.notEqual(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 2);
});

test("REST on clearly-low recovery (short average sleep) even when due", () => {
  // A plan day exists and there's no consecutive-training streak — but low sleep
  // overrides into rest. Pass recovery explicitly so the branch is deterministic.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: true, recovery: { avg_sleep_min: 300 } }); // 5h
  assert.equal(r.kind, "rest");
  assert.equal(r.signals.low_sleep, true);
  assert.match(r.why, /sleep/i);
});

test("low subjective check-in (low energy) forces REST", () => {
  // checkin is read by date inside dayRead (getCheckinByDate(d)); seed it on REF.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3 }]);
  repo.addCheckin(REF, { energy: 1, sleep_feel: 2, mood: 2, soreness: 4 });
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest");
  assert.match(r.why, /run-down|rest is the smart call/i);
});

test("TRAIN when recovered, due, and a plan day exists", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "train");
  assert.equal(r.focus, "Lower body");
  assert.equal(typeof r.est_minutes, "number");
});

test("EASY when nothing is programmed and recovery is unremarkable", () => {
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
  assert.match(r.why, /nothing programmed/i);
});

test("EASY after a real activity is already logged today", () => {
  // A logged ride of >=20 min should read as 'covered', not push a fresh session.
  db.prepare(
    `INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'ride', 45, 20)`
  ).run(REF);
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
  assert.match(r.why, /already/i);
});

test("DONE (not EASY) when a real loading session is already logged today", () => {
  // A hard session today is a FACT — the read must acknowledge it as DONE, never
  // mislabel it "easy". (This is the bug: a hard push session read "EASY DAY".)
  seedTrainingDay(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "done");
  assert.match(r.why, /recovery/i);
  assert.equal(r.signals.trained_today, true);
});

test("DONE preempts REST: a hard session today wins over 3 prior hard days", () => {
  // The user's exact case — trained hard for days AND already trained again today. A
  // "Rest today" read would contradict the work already in (and the session sitting
  // below it). The day must read DONE (debrief), never tell them to rest after they've
  // already loaded. This is the done-before-earned-rest ordering.
  for (let i = 1; i <= 3; i++) seedTrainingDay(dayBefore(REF, i));
  seedTrainingDay(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.consecutive_training_days, 3);
  assert.equal(r.kind, "done");
  assert.equal(r.signals.trained_today, true);
});

test("DONE 'why' names the session (not the run) when both land today", () => {
  // A lift + a run on the same day must not let the run's label erase the strength work
  // in the deterministic floor's why-line.
  seedTrainingDay(REF);
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 40, 6)`).run(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "done");
  assert.match(r.why, /solid session/i);
});

test("stale sleep is NOT treated as last night (no fabricated sleep read)", () => {
  // A wearable can stop syncing sleep for weeks; a ~month-old night is NOT last night.
  // dayRead must surface it as ABSENT so the Brief never asserts "you slept fine".
  resetTables("daily_metrics", "garmin_daily_metrics");
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 440)`).run(dayBefore(REF, 25));
  const stale = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(stale.signals.last_night, null);
  // A recent night (yesterday) IS surfaced as last night.
  resetTables("daily_metrics", "garmin_daily_metrics");
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 440)`).run(dayBefore(REF, 1));
  const fresh = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.ok(fresh.signals.last_night && fresh.signals.last_night.total_min === 440);
});

test("EASY (not DONE) when today's logged work was only light", () => {
  // A short mobility/recovery session graded 'easy' is NOT a completed training
  // day — keep it 'easy' (they may still want their real work), never 'done'.
  seedRecoveryDay(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
});

test("forwardLook points to the NEXT session's focus (the day-ahead heads-up)", () => {
  repo.savePlanDay(1, "Push", "Chest & shoulders", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 }]);
  repo.savePlanDay(2, "Lower", "Lower body", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 225 }]);
  // Trained Push (plan day 1) the day before REF → the forward look is plan day 2.
  const ex = repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  const day1Id = repo.getPlanDay(1).id; // the real plan_days row id (autoincrement varies in the shared DB)
  const sess = repo.getOrCreateSession(dayBefore(REF, 1), day1Id);
  db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, 135, 6, 2)`).run(sess.id, ex.id);
  const fl = repo.forwardLook(REF);
  assert.equal(fl.next_focus, "Lower body");
  assert.match(fl.text, /Lower body/);
});

test("forwardLook is null-safe with no plan (degrades, never throws)", () => {
  const fl = repo.forwardLook(REF);
  assert.equal(fl.next_focus, null);
  assert.equal(fl.text, null);
});

test("absent signals never throw and never force rest (graceful degradation)", () => {
  // No recovery, no check-in, no sessions, no plan — must return a calm 'easy'.
  const r = repo.dayRead(isoDaysAgo(0));
  assert.equal(r.kind, "easy");
  assert.equal(r.signals.consecutive_training_days, 0);
});
