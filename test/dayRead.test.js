// dayRead (src/repo.ts) is the deterministic floor under the Brief. The
// constitution says it SUGGESTS, never gates — these cases pin the three reads
// and the two protect-recovery triggers (earned rest, clearly-low recovery).
// dayRead(date, recovery) takes an explicit recovery object, letting us drive the
// low-sleep branch without coupling to wall-clock "now".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedTrainingDay, isoDaysAgo } from "./_seed.js";

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
  assert.match(r.why, /trained several days/i);
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

test("absent signals never throw and never force rest (graceful degradation)", () => {
  // No recovery, no check-in, no sessions, no plan — must return a calm 'easy'.
  const r = repo.dayRead(isoDaysAgo(0));
  assert.equal(r.kind, "easy");
  assert.equal(r.signals.consecutive_training_days, 0);
});
