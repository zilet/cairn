// The deterministic program-state engine (src/repo/program-state.ts) — the floor
// under adaptive program intelligence. These lock the coach-level reads it must
// get right: a climbing lift reads 'progressing' (→ overload), a stuck-and-grinding
// lift reads 'plateaued' (→ deload/vary), a deload week is found in the mesocycle
// position, and the endurance block flags a one-pace base as needing quality work.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";

const REF = "2026-04-20";
const back = (n) => new Date(new Date(REF + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

beforeEach(() => {
  resetTables("logged_sets", "session_skips", "sessions", "activities", "garmin_activities", "garmin_sources", "plan_items", "plan_days", "daily_metrics", "checkins");
});

test("a lift whose est-1RM is climbing reads 'progressing' → overload", () => {
  const w = [135, 140, 145, 152, 160];
  [28, 21, 14, 7, 0].forEach((d, i) => repo.logSetByName({ exercise: "Bench Press", weight: w[i], reps: 5, rir: 2, date: back(d) }));
  const st = repo.getProgramState(REF);
  const bench = st.lifts.find((l) => l.exercise === "Bench Press");
  assert.ok(bench, "bench is analyzed");
  assert.equal(bench.status, "progressing");
  assert.equal(bench.suggested_action, "overload");
  assert.ok(bench.trend_per_wk > 0, "positive weekly trend");
});

test("a stuck-and-grinding lift reads 'plateaued' with a stall signal", () => {
  [28, 21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Overhead Press", weight: 115, reps: 5, rir: 1, date: back(d) }));
  const st = repo.getProgramState(REF);
  const ohp = st.lifts.find((l) => l.exercise === "Overhead Press");
  assert.equal(ohp.status, "plateaued");
  assert.ok(["deload", "vary", "technique"].includes(ohp.suggested_action));
  assert.ok(ohp.stall_signals.some((s) => /same top load/.test(s)), "flags the static load");
  assert.ok(ohp.stall_signals.some((s) => /grind/.test(s)), "flags grinding at RIR 0–1");
  assert.ok(st.adaptations_due.some((a) => /Overhead Press/.test(a)), "shows up in what to evolve next");
});

test("a lift with only a couple of sessions reads 'new', never a false plateau", () => {
  repo.logSetByName({ exercise: "Front Squat", weight: 185, reps: 5, date: back(7) });
  repo.logSetByName({ exercise: "Front Squat", weight: 185, reps: 5, date: back(0) });
  const fs = repo.getProgramState(REF).lifts.find((l) => l.exercise === "Front Squat");
  assert.equal(fs.status, "new");
});

test("a completed low-tonnage week is detected as a deload (the in-progress week is NOT judged)", () => {
  // Solid weeks 2-4 back, then a clearly lighter COMPLETED week 1 back. A partial
  // current week must never be mistaken for a deliberate deload (the bug fix).
  for (const wk of [2, 3, 4]) for (const off of [0, 2]) repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, date: back(wk * 7 + off) });
  repo.logSetByName({ exercise: "Back Squat", weight: 135, reps: 5, date: back(7) }); // light completed week (w=1)
  const meso = repo.getProgramState(REF).mesocycle;
  assert.equal(meso.weeks_since_deload, 1, "the light completed week one back is the deload");
});

test("a timed lift progresses on hold duration, not load", () => {
  const secs = [20, 25, 30, 35, 45];
  [28, 21, 14, 7, 0].forEach((d, i) => repo.logSetByName({ exercise: "Plank", duration_sec: secs[i], exercise_mode: "timed", date: back(d) }));
  const plank = repo.getProgramState(REF).lifts.find((l) => l.exercise === "Plank");
  assert.equal(plank.mode, "timed");
  assert.equal(plank.status, "progressing");
  assert.equal(plank.best_seconds, 45);
  assert.equal(plank.est_1rm, null, "timed lifts carry no est-1RM");
});

test("a steady (flat) timed hold reads 'maintaining' → overload, NOT a false plateau/vary", () => {
  // A plank held at a consistent 45s for 5 sessions is healthy maintenance, not a
  // stall that needs a harder variation (the dead-branch bug classified it plateaued).
  [28, 21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Plank", duration_sec: 45, exercise_mode: "timed", date: back(d) }));
  const plank = repo.getProgramState(REF).lifts.find((l) => l.exercise === "Plank");
  assert.equal(plank.mode, "timed");
  assert.equal(plank.status, "maintaining");
  assert.equal(plank.suggested_action, "overload");
});

test("hybrid endurance: a one-pace base flags 'add-quality'", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  // ~12 km/wk of easy running over 4 weeks, no quality session.
  for (const wk of [3, 2, 1, 0]) { repo.addActivity({ type: "run", duration_min: 40, distance_km: 7, date: back(wk * 7 + 1) }); repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: back(wk * 7 + 4) }); }
  const e = repo.getProgramState(REF).endurance;
  assert.ok(e, "endurance block present for a hybrid athlete");
  assert.equal(e.has_quality, false);
  assert.equal(e.suggested_action, "add-quality");
});

test("a strength athlete gets no endurance block; the aggregate has a headline", () => {
  repo.setProfile({ primary_discipline: "strength" });
  [21, 14, 7, 0].forEach((d, i) => repo.logSetByName({ exercise: "Deadlift", weight: 300 + i * 10, reps: 3, rir: 2, date: back(d) }));
  const st = repo.getProgramState(REF);
  assert.equal(st.endurance, null);
  assert.equal(typeof st.headline, "string");
  assert.ok(st.headline.length > 0);
  assert.ok(!/\b\d{1,3}\/100\b/.test(st.headline), "no 0-100 score in the headline (constitution)");
});
