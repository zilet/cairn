// dayPlanningSignalState() takes the date it is reading FOR, but two of its inputs
// used to resolve for "now" regardless: `trainingSignals` fetched the twenty newest
// sessions and measured staleness off the wall clock, and `estimateExpenditure`
// always looked at the 21 days before TODAY. So a read of a fixed historical date
// was built partly from work that had not happened yet — the same class of bug as
// the program-state one that told a day inside an applied recovery week that a reset
// was fourteen weeks overdue.
import assert from "node:assert/strict";
import test from "node:test";
import { db, repo, resetTables, seedTrainingDay } from "./_seed.js";
import { trainingSignals } from "../dist/repo/coach.js";
import { getRecentSessions } from "../dist/repo/sessions.js";
import { estimateExpenditure } from "../dist/repo/expenditure.js";
import { dayPlanningSignalState } from "../dist/repo/day-read.js";

// Far enough in the past that no wall-clock window can reach it.
const REF = "2026-03-15";
const shift = (base, n) => new Date(new Date(base + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);

function reset() {
  resetTables(
    "sessions",
    "logged_sets",
    "activities",
    "plan_days",
    "plan_items",
    "bodyweight_log",
    "day_reads",
    "brain_decisions",
    "brain_expectations"
  );
}

test("a historical read is not built from sessions logged after it", () => {
  reset();
  seedTrainingDay(shift(REF, -3));
  seedTrainingDay(shift(REF, 4));

  const bounded = getRecentSessions(20, { through: REF }).map((s) => s.date);
  const unbounded = getRecentSessions(20).map((s) => s.date);
  assert.ok(bounded.includes(shift(REF, -3)));
  assert.ok(!bounded.includes(shift(REF, 4)), "a session logged after the read date is not evidence for it");
  assert.ok(unbounded.includes(shift(REF, 4)), "the default read is unchanged");
});

test("joint pain reported after the read date does not reach that day's signal state", () => {
  reset();
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  seedTrainingDay(shift(REF, -3));
  // Reported four days LATER — real, but not something the athlete's read on REF
  // could possibly have known.
  seedTrainingDay(shift(REF, 4));
  repo.setSessionFeedback(shift(REF, 4), { joint_pain: "left knee" });

  const past = dayPlanningSignalState(REF);
  const evidence = past.dimensions.health_constraints.evidence ?? [];
  assert.ok(
    !evidence.some((item) => item.field === "joint_pain"),
    "a constraint logged after the read date must not appear in it"
  );

  // The same fact DOES reach a read for the day it was reported on.
  const later = dayPlanningSignalState(shift(REF, 4));
  assert.ok((later.dimensions.health_constraints.evidence ?? []).some((item) => item.field === "joint_pain"));
});

test("trainingSignals measures staleness from the day being read, not from now", () => {
  reset();
  // seedTrainingDay logs "Test Squat"; the plan must name the same lift for the
  // progression signal to attach to it.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Test Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  seedTrainingDay(shift(REF, -2));

  const asOfRef = trainingSignals(undefined, REF).progression.find((item) => item.exercise === "Test Squat");
  assert.equal(asOfRef.last_logged, shift(REF, -2));
  assert.equal(asOfRef.days_since, 2, "two days before the read, not months before today");

  // Unanchored, the same lift reads as months stale because `now` is the wall clock.
  const asOfNow = trainingSignals(undefined).progression.find((item) => item.exercise === "Test Squat");
  assert.ok(asOfNow.days_since > 14);
});

// The est-1RM trend is read off the LAST TWO points of an all-time history, so an
// unbounded lookup let a historical read learn which way a lift was moving from sets
// logged after it — the one sub-signal the first date-scoping pass left open.
test("the est-1RM trend cannot be read from sets logged after the day being read", () => {
  reset();
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Test Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const ex = repo.upsertExercise({ name: "Test Squat", muscle_group: "legs" });
  const logSet = (date, weight) => {
    const session = repo.getOrCreateSession(date, null);
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, ?, 5, 2)`
    ).run(session.id, ex.id, weight);
  };
  // Trending DOWN as of REF...
  logSet(shift(REF, -6), 200);
  logSet(shift(REF, -2), 180);
  // ...then a big PR four days LATER, which flips the all-time trend to up.
  logSet(shift(REF, 4), 260);

  const asOfRef = trainingSignals(undefined, REF).progression.find((item) => item.exercise === "Test Squat");
  assert.equal(asOfRef.est_1rm_trend, "down", "the read for REF may only see what REF could see");

  const asOfNow = trainingSignals(undefined).progression.find((item) => item.exercise === "Test Squat");
  assert.equal(asOfNow.est_1rm_trend, "up", "the live read still sees the whole history");
});

test("expenditure is anchored to the day being read, not to today", () => {
  reset();
  const insert = db.prepare(`INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)`);
  for (let back = 1; back <= 12; back++) insert.run(shift(REF, -back), 180 - back * 0.1);

  const anchored = estimateExpenditure(21, { asOf: REF });
  const unanchored = estimateExpenditure(21);
  assert.ok(anchored.coverage.weigh_in_days >= 10, JSON.stringify(anchored.coverage));
  assert.equal(unanchored.coverage.weigh_in_days, 0, "today's window cannot see months-old weigh-ins");
});
