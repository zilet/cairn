// todayStrengthLine.test.js — the ONE server line every strength surface prints
// (Brief, Session header, Plan week strip, Train overview).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";
import { todayStrengthLine } from "../dist/repo/today-strength-line.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
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
  // One calm sentence (a variant set rotated by date), never "Run in · Pull still open".
  assert.match(line.text, /^(?:Your run's in\. |Run done\. |The run's in; )Pull is still (?:there|on for today)/);
  assert.doesNotMatch(line.text, /·|still open/);
  assert.ok(!violatesReadingGrammar(line.text), line.text);
});

test("the run-in line is a sentence on every morning it is said", () => {
  const seen = new Set();
  for (const day of ["2026-04-20", "2026-04-21", "2026-04-22", "2026-04-23", "2026-04-24", "2026-04-27", "2026-04-28"]) {
    repo.addActivity({ type: "run", date: day, duration_min: 25, distance_km: 4.1 });
    const line = todayStrengthLine(day);
    if (line.state !== "not_started" || !line.run_in) continue;
    assert.match(line.text, /^[A-Z].*[.]$/, line.text);
    assert.doesNotMatch(line.text, /·/, line.text);
    seen.add(line.text.split(/[.;]/)[0]);
  }
  assert.ok(seen.size >= 1, "the run-in mornings each read as a sentence");
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
  // The caveat rotates through a small set (reading-grammar variant law) rather than
  // printing one literal every quiet morning — assert the shared meaning, not one string.
  assert.match(line.caveat, /\brest\b/i);
  assert.ok(line.caveat.includes(line.title));
  assert.match(line.caveat, /still (yours|there)/);
  assert.doesNotMatch(line.caveat, /\bmust\b|\d+\s*\/\s*100/);
  repo.saveDayRead(today, read("train"));
  assert.equal(todayStrengthLine(today).caveat, null);
});

test("the rest/easy caveat rotates through a registered variant set, never one literal", () => {
  const today = localDaysAgo(0);
  repo.setProfile({
    strength_schedule: { days: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow })), source: "athlete", updated_at: today },
  });
  repo.saveDayRead(today, read("rest"));
  const restLine = todayStrengthLine(today);
  assert.ok(restLine.caveat, "precondition: a rest read carries a caveat");
  assert.ok(restLine.caveat.includes(restLine.title));

  repo.saveDayRead(today, read("easy"));
  const easyLine = todayStrengthLine(today);
  assert.match(easyLine.caveat, /\beasy\b/i);
  assert.doesNotMatch(easyLine.caveat, /\bmust\b|\byou must\b|\d+\s*\/\s*100/);
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

test("a run in beside the lift reads as one calm sentence, in progress and logged", () => {
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'running', 38, 6.6)`).run(TUE);
  repo.logSetByName({ date: TUE, exercise: "Barbell Row", weight: 135, reps: 8, day_number: 2 });
  const open = todayStrengthLine(TUE);
  assert.equal(open.state, "in_progress");
  assert.ok(open.run_in);
  const session = db.prepare(`SELECT id FROM sessions WHERE date = ?`).get(TUE);
  repo.finishSession(Number(session.id));
  const done = todayStrengthLine(TUE);
  assert.equal(done.state, "logged");
  for (const [line, word] of [
    [open, /under way|in progress/],
    [done, /done|logged/],
  ]) {
    assert.ok(line.text.includes("Pull"), line.text);
    assert.match(line.text, /\brun\b/i, line.text);
    assert.match(line.text, word, line.text);
    assert.doesNotMatch(line.text, / · /, `never the clipped form: ${line.text}`);
    assert.match(line.text, /\.$/, line.text);
    assert.ok(!violatesReadingGrammar(line.text), line.text);
  }
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

function chooseSession(date, source, sessionId) {
  db.prepare(
    `INSERT INTO daily_session_compositions
       (version, session_id, date, source, status, plan_day_id, title, focus, items_json, request_fingerprint)
     VALUES (1, ?, ?, ?, 'active', NULL, 'Upper Body & Core', 'Upper back, triceps & core', ?, 'fp')`
  ).run(sessionId, date, source, JSON.stringify([{ kind: "strength", exercise: "Chest-Supported Row" }]));
}

test("a session the athlete chose owns the line instead of the plan day", () => {
  repo.addActivity({ type: "run", date: TUE, duration_min: 40, distance_km: 6.6 });
  chooseSession(TUE, "agent_suggest", Number(repo.getOrCreateSession(TUE).id));
  const line = todayStrengthLine(TUE);
  assert.equal(line.title, "Upper Body & Core");
  assert.equal(line.focus, "Upper back, triceps & core");
  assert.equal(line.day_number, null, "no plan day to offer or start over the choice");
  assert.equal(line.state, "not_started");
  assert.match(line.text, /^(?:Your run's in\. |Run done\. |The run's in; )Upper Body & Core is still (?:there|on for today)/);
});

test("a chosen session logged reads as that session, not the plan day the ring lands on", () => {
  repo.logSetByName({ date: TUE, exercise: "Chest-Supported Row", weight: 37.5, reps: 10 });
  const session = db.prepare(`SELECT id FROM sessions WHERE date = ?`).get(TUE);
  db.prepare(`UPDATE sessions SET finished_at = datetime('now') WHERE id = ?`).run(Number(session.id));
  chooseSession(TUE, "athlete_override", Number(session.id));
  const line = todayStrengthLine(TUE);
  assert.equal(line.state, "logged");
  assert.equal(line.text, "Upper Body & Core · logged");
});

test("a plan-sourced composition still goes by the plan day's name", () => {
  const planDayId = db.prepare(`SELECT id FROM plan_days WHERE day_number = 2`).get().id;
  db.prepare(
    `INSERT INTO daily_session_compositions
       (version, session_id, date, source, status, plan_day_id, title, focus, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'adaptive_plan', 'active', ?, 'Back, biceps & rear delts', NULL, '[]', 'fp')`
  ).run(Number(repo.getOrCreateSession(TUE).id), TUE, planDayId);
  assert.equal(todayStrengthLine(TUE).title, "Pull");
});
