// The deterministic "understand what was logged" layer (src/repo/training-read.ts)
// and the intensity-aware day-read it feeds. Two coach-level behaviors:
//   1. A session whose logged work diverged from its plan day is NAMED from what
//      was actually trained (an off-plan "Full Body" that was really mobility/core
//      reads as "Mobility & Core"), while a session that still matches keeps the
//      plan-day name.
//   2. A light recovery day grades 'easy' and BREAKS the earned-rest streak — it
//      is no longer counted as a stacked hard day (the reported bug: a 20-min
//      mobility session forced a rest read the next morning).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedTrainingDay, seedRecoveryDay } from "./_seed.js";

const REF = "2026-04-15";
const dayBefore = (base, n) =>
  new Date(new Date(base + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

beforeEach(() => {
  resetTables("logged_sets", "session_skips", "sessions", "plan_items", "plan_days", "activities", "checkins", "daily_metrics");
});

// ---------- 1. content-true session title ----------
test("an off-plan session is named from its content, not the stale plan-day label", () => {
  repo.savePlanDay(5, "Full Body", "Lighter, quality reps", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 },
    { exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 12 },
    { exercise: "Lateral Raise", sets: 3, rep_low: 12, rep_high: 15 },
  ]);
  const planDayId = db.prepare(`SELECT id FROM plan_days WHERE day_number = 5`).get().id;
  const DATE = dayBefore(REF, 1);
  repo.getOrCreateSession(DATE, planDayId); // linked to "Full Body"...
  // ...but the actual work is all mobility / core (the off-plan session-suggest case)
  repo.logSetByName({ exercise: "90/90 Hip Switch", reps: 8, date: DATE });
  repo.logSetByName({ exercise: "Side Plank", duration_sec: 20, exercise_mode: "timed", date: DATE });
  repo.logSetByName({ exercise: "Standing Calf Raise", reps: 15, date: DATE });
  repo.logSetByName({ exercise: "Dead Bug", reps: 10, date: DATE });

  const sess = repo.getSessionByDate(DATE);
  assert.equal(sess.title, "Mobility & Core", "named from what was trained");
  assert.equal(sess.day_name, "Full Body", "the raw plan-day label is preserved alongside");
  assert.equal(repo.deriveSessionTitle(sess.id, planDayId, "Full Body"), "Mobility & Core");
});

test("a session that still matches its plan day keeps the plan-day name", () => {
  repo.savePlanDay(5, "Full Body", "Lighter, quality reps", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 },
    { exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 12 },
  ]);
  const planDayId = db.prepare(`SELECT id FROM plan_days WHERE day_number = 5`).get().id;
  const DATE = dayBefore(REF, 1);
  repo.getOrCreateSession(DATE, planDayId);
  repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, date: DATE });
  repo.logSetByName({ exercise: "Seated Cable Row", weight: 120, reps: 10, date: DATE });

  assert.equal(repo.getSessionByDate(DATE).title, "Full Body");
});

test("a same-character session keeps its plan-day name even when exercise names differ", () => {
  repo.savePlanDay(4, "Lower B", "Hinge / posterior chain", [
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 10 },
    { exercise: "Bulgarian Split Squat", sets: 3, rep_low: 8, rep_high: 12 },
  ]);
  const planDayId = db.prepare(`SELECT id FROM plan_days WHERE day_number = 4`).get().id;
  const DATE = dayBefore(REF, 1);
  repo.getOrCreateSession(DATE, planDayId);
  // Logged with DIFFERENT names but the same lower-body character (the brittle
  // exact-name overlap would falsely rename this; the character check keeps it).
  repo.logSetByName({ exercise: "Trap Bar Deadlift", weight: 225, reps: 5, date: DATE });
  repo.logSetByName({ exercise: "Leg Press", weight: 300, reps: 10, date: DATE });
  assert.equal(repo.getSessionByDate(DATE).title, "Lower B");
});

// ---------- 2. intensity grading ----------
test("sessionLoad: a heavy session is 'hard'/'moderate', a recovery session is 'easy'", () => {
  const hard = dayBefore(REF, 1);
  seedTrainingDay(hard); // 4×185×5 @ RIR 2
  assert.notEqual(repo.sessionLoad(repo.getSessionByDate(hard).id), "easy", "real loaded volume isn't easy");

  const recover = dayBefore(REF, 2);
  seedRecoveryDay(recover); // bodyweight + a timed hold @ RIR 9
  assert.equal(repo.sessionLoad(repo.getSessionByDate(recover).id), "easy", "mobility/recovery grades easy");
});

// ---------- 3. a recovery day breaks the earned-rest streak (the reported bug) ----------
test("a recovery day BREAKS the loading streak — no forced rest the next morning", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  // Three genuinely-hard days, then a deliberate recovery day yesterday.
  seedTrainingDay(dayBefore(REF, 4));
  seedTrainingDay(dayBefore(REF, 3));
  seedTrainingDay(dayBefore(REF, 2));
  seedRecoveryDay(dayBefore(REF, 1)); // the light mobility/core day

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.consecutive_training_days, 0, "yesterday's easy day breaks the streak");
  assert.notEqual(r.kind, "rest", "after an earned recovery day, today is not force-rested");
  assert.equal(r.signals.recent_load[0].load, "easy", "yesterday is graded easy in the signals");
});

test("three genuinely-hard days in a row still earns rest (the streak is intact)", () => {
  repo.setProfile({ primary_discipline: "strength" });
  seedTrainingDay(dayBefore(REF, 3));
  seedTrainingDay(dayBefore(REF, 2));
  seedTrainingDay(dayBefore(REF, 1));
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.consecutive_training_days, 3);
  assert.equal(r.kind, "rest");
});
