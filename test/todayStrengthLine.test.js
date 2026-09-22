// todayStrengthLine.test.js — the ONE server line every strength surface prints
// (Brief, Session header, Plan week strip, Train overview).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";
import { todayStrengthLine } from "../dist/repo/today-strength-line.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { forwardLook } from "../dist/repo/day-read.js";
import { deriveSessionTitle } from "../dist/repo/training-read.js";

const MON = "2026-04-20";
const TUE = "2026-04-21";

beforeEach(() => {
  resetTables(
    "logged_sets",
    "sessions",
    "activities",
    "plan_items",
    "plan_days",
    "app_state",
    "profile",
    "day_reads",
    "daily_session_compositions"
  );
  repo.savePlanDay(1, "Push", "Shoulders, chest & triceps", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 },
  ]);
  repo.savePlanDay(2, "Pull", "Back, biceps & rear delts", [
    { exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8 },
    { exercise: "Pull-Up", sets: 3, rep_low: 6, rep_high: 8 },
  ]);
  repo.setProfile({ strength_schedule: { days: [{ dow: 1 }, { dow: 2 }], source: "athlete", updated_at: MON } });
});

function read(kind) {
  return {
    kind,
    headline: "x",
    why: "y",
    focus: null,
    est_minutes: null,
    signals: {},
    source: "deterministic",
    override: null,
  };
}

test("a run on a lifting day leaves the lift open, named by the plan day's NAME", () => {
  repo.addActivity({ type: "run", date: TUE, duration_min: 25, distance_km: 4.1 });
  const line = todayStrengthLine(TUE);
  assert.equal(line.title, "Pull");
  assert.equal(line.focus, "Back, biceps & rear delts");
  assert.equal(line.state, "not_started");
  assert.deepEqual(line.run_in, { km: 4.1 });
  assert.equal(line.text, "Run in · Pull still open");
});

test("a rest/easy read is a caveat on the plan day, never a replacement title", () => {
  // The read cache keeps only a rolling few weeks, so this one speaks for a live date.
  const today = localDaysAgo(0);
  repo.setProfile({
    strength_schedule: { days: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow })), source: "athlete", updated_at: today },
  });
  repo.saveDayRead(today, read("rest"));
  const line = todayStrengthLine(today);
  assert.ok(line.title === "Push" || line.title === "Pull", JSON.stringify(line));
  assert.equal(line.text, `${line.title} · not started`);
  assert.equal(line.suggestion, "rest");
  assert.match(line.caveat, /suggests rest/);
  assert.ok(line.caveat.includes(line.title));
  assert.doesNotMatch(line.caveat, /\bmust\b|\d+\s*\/\s*100/);
  repo.saveDayRead(today, read("train"));
  assert.equal(todayStrengthLine(today).caveat, null);
});

test("the state is read off the log: in progress, then logged", () => {
  repo.logSetByName({ date: TUE, exercise: "Barbell Row", weight: 135, reps: 8, day_number: 2 });
  const open = todayStrengthLine(TUE);
  assert.equal(open.state, "in_progress");
  assert.equal(open.text, "Pull · in progress");
  const session = db.prepare(`SELECT id FROM sessions WHERE date = ?`).get(TUE);
  repo.finishSession(Number(session.id));
  const done = todayStrengthLine(TUE);
  assert.equal(done.state, "logged");
  assert.equal(done.text, "Pull · logged");
  assert.equal(done.caveat, null);
});

test("most slots substituted → '<name>, reshaped' with the plan's own list kept", () => {
  const session = repo.getOrCreateSession(TUE);
  const planDayId = db.prepare(`SELECT id FROM plan_days WHERE day_number = 2`).get().id;
  db.prepare(
    `INSERT INTO daily_session_compositions
       (version, session_id, date, source, status, plan_day_id, title, focus, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'adaptive_plan', 'active', ?, 'Back, biceps & rear delts', 'Back, biceps & rear delts', ?, 'fp')`
  ).run(
    Number(session.id),
    TUE,
    planDayId,
    JSON.stringify([
      { kind: "strength", exercise: "Bench Press", substitution_for: "Barbell Row" },
      { kind: "strength", exercise: "Curl", substitution_for: "Pull-Up" },
    ])
  );
  const line = todayStrengthLine(TUE);
  assert.equal(line.reshaped, true);
  assert.equal(line.title, "Pull, reshaped");
  assert.deepEqual(line.original, ["Barbell Row", "Pull-Up"]);
});

test("the week strip carries the same line, today's run on its cell, and the lift stays open", () => {
  repo.addActivity({ type: "run", date: TUE, duration_min: 25, distance_km: 4.1 });
  const week = planWeek(TUE);
  assert.equal(week.strength_line.text, todayStrengthLine(TUE).text);
  const tue = week.days.find((d) => d.date === TUE);
  assert.equal(tue.plan_day.name, "Pull");
  assert.equal(tue.status, "today", "a run does not mark a lifting day done");
  assert.equal(tue.run?.status, "completed");
  assert.equal(tue.run?.km, 4.1);
});

test("a composition-backed session goes by its plan day's NAME, not the stored focus title", () => {
  repo.logSetByName({ date: MON, exercise: "Bench Press", weight: 135, reps: 5, day_number: 1 });
  const session = db.prepare(`SELECT id, plan_day_id FROM sessions WHERE date = ?`).get(MON);
  db.prepare(
    `INSERT INTO daily_session_compositions
       (version, session_id, date, source, status, plan_day_id, title, focus, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'adaptive_plan', 'active', ?, 'Shoulders, chest & triceps', 'Shoulders, chest & triceps', ?, 'fp')`
  ).run(
    Number(session.id),
    MON,
    Number(session.plan_day_id),
    JSON.stringify([{ kind: "strength", exercise: "Bench Press" }])
  );
  assert.equal(deriveSessionTitle(Number(session.id), Number(session.plan_day_id), "Push"), "Push");
});

test("the forward line names the next plan day, and only once today's lift is in", () => {
  assert.doesNotMatch(String(forwardLook(TUE).text ?? ""), /Next:/, "before a lift, the pick IS today's");
  repo.logSetByName({ date: MON, exercise: "Bench Press", weight: 135, reps: 5, day_number: 1 });
  const fl = forwardLook(MON);
  assert.equal(fl.next_name, "Pull");
  assert.match(String(fl.text), /^Next: Pull\b/);
  assert.equal(fl.next_focus, "Back, biceps & rear delts", "the prompt still reads the focus");
});
