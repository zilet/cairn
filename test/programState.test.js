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

test("hybrid runner endurance ignores bike and walk distance, spikes, and quality", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  for (const wk of [4, 3, 2, 1, 0]) {
    repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: back(wk * 7 + 1) });
  }
  const hardBike = repo.addActivity({ type: "ride", duration_min: 160, distance_km: 80, date: back(2) });
  repo.addActivity({ type: "walking", duration_min: 150, distance_km: 12, date: back(3) });
  const source = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'program-state-test')`).run();
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, te_label, anaerobic_te)
     VALUES (?, 'bike-quality-1', ?, ?, 'cycling', 'VO2MAX', 3)`
  ).run(source.lastInsertRowid, hardBike.id, hardBike.date);

  const e = repo.getProgramState(REF).endurance;
  assert.ok(e, "endurance block present for a hybrid runner");
  assert.equal(e.last_week_km, 10, "bike/walk distance does not inflate run mileage");
  assert.equal(e.longest_km_4wk, 10, "bike/walk distance does not become the longest run");
  assert.equal(e.acute_chronic_ratio, 1, "bike/walk distance does not create a run ACWR spike");
  assert.equal(e.has_quality, false, "a hard bike does not count as run quality");
  assert.equal(e.pace_trend, "stable", "pace trend is based on the running rows");
});

test("hybrid cycling endurance matching is token-aware, not substring-only", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "cycling" });
  for (const wk of [4, 3, 2, 1, 0]) {
    repo.addActivity({ type: "bike", duration_min: 45, distance_km: 15, date: back(wk * 7 + 1) });
  }
  repo.addActivity({ type: "bikram yoga", duration_min: 90, distance_km: 50, date: back(0) });

  const e = repo.getProgramState(REF).endurance;
  assert.ok(e, "endurance block present for a hybrid cyclist");
  assert.equal(e.last_week_km, 15, "bikram does not match the bike token");
  assert.equal(e.longest_km_4wk, 15, "substring-only matching would have promoted the yoga row");
  assert.equal(e.acute_chronic_ratio, 1);
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

// ===========================================================================
// Elite-strength build: ACWR low-base guard + canonical-group volume.
// ===========================================================================

test("ACWR low-base guard: a first big week off ~0 chronic tonnage is NOT 'spiking'", () => {
  repo.setProfile({ primary_discipline: "strength" });
  // ONLY the current week carries tonnage; the four prior weeks are empty — a
  // returning athlete's first real week, which read as a scary spike before.
  for (const d of [0, 1, 2]) {
    for (let s = 1; s <= 5; s++) repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: back(d) });
  }
  const meso = repo.getProgramState(REF).mesocycle;
  assert.equal(meso.acute_chronic_ratio, null, "ACWR suppressed below the chronic-base floor, not an absurd ratio");
  assert.notEqual(meso.phase, "intensification", "a thin-base first week never reads as a load spike");
  assert.match(meso.note.toLowerCase(), /base/, "the read is plainly 'building base'");
});

test("tonnage ACWR is computed normally once a real chronic base exists", () => {
  repo.setProfile({ primary_discipline: "strength" });
  // Four solid prior weeks (real chronic base) + a comparable current week.
  for (const wk of [0, 1, 2, 3, 4]) {
    for (const off of [0, 2, 4]) {
      for (let s = 1; s <= 5; s++) repo.logSetByName({ exercise: "Back Squat", weight: 315, reps: 5, rir: 2, date: back(wk * 7 + off) });
    }
  }
  const meso = repo.getProgramState(REF).mesocycle;
  assert.ok(meso.acute_chronic_ratio != null, "ACWR is computed once the chronic base clears the floor");
});

test("endurance ACWR low-base guard: a returning runner's first week reads 'building', not 'spiking'", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  // One real run this week; nothing in the prior four weeks (rebuilding base).
  repo.addActivity({ type: "run", duration_min: 70, distance_km: 12, date: back(1) });
  const e = repo.getProgramState(REF).endurance;
  assert.ok(e, "endurance block present for a hybrid athlete");
  assert.equal(e.acute_chronic_ratio, null, "weekly-km ACWR suppressed below the base floor");
  assert.notEqual(e.status, "spiking", "a returning runner's first week is base-building, not spiking");
  assert.equal(e.status, "building");
  assert.equal(e.suggested_action, "build");
});

test("muscleVolume buckets by the canonical taxonomy (legacy 'legs' folds to 'quads')", () => {
  repo.setProfile({ primary_discipline: "strength" });
  // Stored with the LEGACY group 'legs' (written RAW to bypass the canonicalizing
  // upsert, mimicking a DB migrated up from the old schema) — muscleVolume must
  // fold it onto the canonical 'quads' on read.
  db.prepare(`INSERT INTO exercises (name, muscle_group, mode) VALUES ('Leg Press', 'legs', 'reps')`).run();
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  for (const d of [10, 7, 3]) {
    for (let s = 1; s <= 4; s++) repo.logSetByName({ exercise: "Leg Press", weight: 360, reps: 10, rir: 2, date: back(d) });
  }
  repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 8, rir: 2, date: back(4) });

  const groups = repo.getProgramState(REF).volume.map((v) => v.muscle_group);
  assert.ok(groups.includes("quads"), "'legs' folded onto the canonical 'quads'");
  assert.ok(!groups.includes("legs"), "the legacy label never surfaces");
  assert.ok(groups.includes("chest"));
});

test("muscleVolume EXCLUDES mobility from the landmark / set-count math", () => {
  repo.setProfile({ primary_discipline: "strength" });
  repo.upsertExercise({ name: "90/90 Hip Switch", muscle_group: "mobility" });
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads" });
  // Lots of mobility "sets" — they must never appear as a volume group.
  for (const d of [9, 6, 3, 1]) {
    for (let s = 1; s <= 6; s++) repo.logSetByName({ exercise: "90/90 Hip Switch", reps: 8, rir: 9, date: back(d) });
  }
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: back(2) });

  const vol = repo.getProgramState(REF).volume;
  assert.ok(!vol.some((v) => v.muscle_group === "mobility"), "mobility never inflates the working-set bands");
  assert.ok(vol.some((v) => v.muscle_group === "quads"), "loaded groups are still counted");
});
