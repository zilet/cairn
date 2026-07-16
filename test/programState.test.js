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
  resetTables("logged_sets", "session_skips", "sessions", "activities", "garmin_activities", "garmin_sources", "plan_items", "plan_days", "program_blocks", "plan_proposals", "daily_metrics", "checkins", "app_state");
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

function startReducedRecoveryWeek(appliedOn) {
  repo.savePlanDay(1, "Recovery Push", "Push", [
    { exercise: "Recovery Trajectory Press", sets: 2, rep_low: 5, rep_high: 8, target_weight: 100 },
  ]);
  const proposal = repo.createProposal("stub", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Reduced recovery prescription.",
    days: repo.getPlan(),
  });
  repo.setProposalStatus(proposal.id, "applied");
  repo.setAppState("recovery_week_applied", JSON.stringify({ applied_on: appliedOn, proposal_id: proposal.id }));
  db.prepare(`UPDATE app_state SET updated_at = ? WHERE key = 'recovery_week_applied'`).run(`${appliedOn} 00:00:00`);
  return repo.getPlanDay(1);
}

function logRecoveryTrajectoryExposure(date, planDayId, { sets = 2, weight = 100, rir = 5, performance = null } = {}) {
  const ex = repo.findExercise("Recovery Trajectory Press") ?? repo.upsertExercise({
    name: "Recovery Trajectory Press",
    muscle_group: "chest",
  });
  const session = repo.getOrCreateSession(date, planDayId);
  if (performance != null) db.prepare(`UPDATE sessions SET performance = ? WHERE id = ?`).run(performance, session.id);
  for (let set = 1; set <= sets; set++) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir)
       VALUES (?, ?, ?, ?, 5, ?)`,
    ).run(session.id, ex.id, set, weight, rir);
  }
  return session;
}

function seedStableRecoveryTrajectory() {
  for (const daysAgo of [28, 21, 14, 7]) {
    repo.logSetByName({ exercise: "Recovery Trajectory Press", weight: 200, reps: 5, rir: 2, date: back(daysAgo) });
  }
}

test("a compliant reduced recovery exposure is not manufactured lift regression", () => {
  seedStableRecoveryTrajectory();
  const planDay = startReducedRecoveryWeek(back(1));
  const session = logRecoveryTrajectoryExposure(REF, planDay.id);
  assert.equal(repo.recoverySessionDose(session.id).classification, "compliant");

  const program = repo.getProgramState(REF);
  const lift = program.lifts.find((row) => row.exercise === "Recovery Trajectory Press");
  assert.notEqual(lift.status, "regressing");
  assert.equal(lift.est_1rm, 233, "the deliberately reduced exposure is not treated as lost capacity");

  const whole = repo.wholePersonTrajectory({ end: REF, days: 56 });
  assert.notEqual(whole.domains.find((domain) => domain.domain === "strength").verdict, "worse");
  const fuel = repo.underfuelingRead(REF, { programState: program, wholePerson: whole });
  assert.notEqual(fuel.channels.find((channel) => channel.key === "performance").direction, "strain");
});

test("an overdosed or poor-feedback recovery exposure remains comparable evidence", () => {
  for (const mode of ["overdose", "poor-feedback"]) {
    resetTables("logged_sets", "sessions", "plan_items", "plan_days", "plan_proposals", "app_state");
    seedStableRecoveryTrajectory();
    const planDay = startReducedRecoveryWeek(back(1));
    const session = logRecoveryTrajectoryExposure(REF, planDay.id, mode === "overdose"
      ? { sets: 4, weight: 100, rir: 5 }
      : { sets: 2, weight: 100, rir: 5, performance: 1 });
    assert.equal(repo.recoverySessionDose(session.id).classification, mode === "overdose" ? "overdose" : "above-plan");
    const lift = repo.getProgramState(REF).lifts.find((row) => row.exercise === "Recovery Trajectory Press");
    assert.equal(lift.status, "regressing", `${mode} remains eligible trajectory evidence`);
  }
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

test("hybrid read shifts heavy lower-body lifting after a hard run", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  repo.savePlanDay(2, "Lower", "Lower body", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  repo.addActivity({ type: "run", duration_min: 55, distance_km: 9, date: REF });

  const st = repo.getProgramState(REF);
  assert.equal(st.hybrid.status, "shift-legs");
  assert.equal(st.hybrid.recent_endurance.label, "run");
  assert.ok(st.hybrid.affected_groups.includes("quads"));
  assert.equal(st.hybrid.next_strength.day_number, 2);
  assert.equal(st.hybrid.next_strength.advice, "swap-or-upper");
  assert.ok(/upper|easy|lower/i.test(st.hybrid.next_strength.why));
  assert.ok(st.adaptations_due.some((a) => /lower-body|legs|quads/i.test(a)), "hybrid conflict appears in adaptations due");
});

test("hybrid read does not overreact to a short easy run before legs", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  repo.savePlanDay(2, "Lower", "Lower body", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: REF });

  const st = repo.getProgramState(REF);
  assert.equal(st.hybrid.status, "clear");
  assert.equal(st.hybrid.recent_endurance.load, "light");
  assert.equal(st.hybrid.next_strength.advice, "ok");
  assert.ok(!st.adaptations_due.some((a) => /upper\/core|lower-body session/i.test(a)), "easy aerobic work should not force a leg-day swap");
});

test("hybrid read protects fuel when hard endurance lands during fat loss", () => {
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    goal_mode: "lose",
    weight_lb: 180,
    goal_weight_lb: 170,
  });
  repo.addActivity({ type: "run", duration_min: 70, distance_km: 12, date: REF });

  const st = repo.getProgramState(REF);
  assert.equal(st.hybrid.status, "fuel-protect");
  assert.equal(st.hybrid.fuel.risk, "high");
  assert.match(st.hybrid.fuel.why, /protein|carbs|lean-safe|recovery/i);
  assert.ok(st.adaptations_due.some((a) => /protect protein|lean-safe|carbs/i.test(a)), "fuel protection is an adaptation");
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

test("mesocycle deload due counts timed/bodyweight work, not tonnage only", () => {
  repo.setProfile({ primary_discipline: "strength" });
  // Six completed weeks of hard timed work with zero tonnage. This used to read as
  // "No recent deload on record — keep building" forever because tonnage was 0.
  for (const wk of [1, 2, 3, 4, 5, 6]) {
    for (let s = 0; s < 4; s++) {
      repo.logSetByName({ exercise: "Plank", duration_sec: 60, exercise_mode: "timed", date: back(wk * 7 + 1) });
    }
  }

  const meso = repo.getProgramState(REF).mesocycle;
  assert.equal(meso.phase, "deload-due");
  assert.match(meso.note, /timed\/bodyweight\/endurance work counts/i);
});

test("mesocycle brings a reset forward when feedback fatigue stacks with hard endurance", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  // Four completed loaded weeks is not enough by itself for the default 6-week
  // deload trigger, but recent joint feedback plus a heavy run is a real fatigue cue.
  for (const wk of [1, 2, 3, 4]) {
    for (const off of [1, 3]) {
      for (let s = 1; s <= 4; s++) {
        repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: back(wk * 7 + off) });
      }
    }
  }
  repo.addActivity({ type: "run", duration_min: 70, distance_km: 12, date: REF });
  repo.setSessionFeedback(REF, { joint_pain: "left knee", soreness: 4, performance: 2 });

  const meso = repo.getProgramState(REF).mesocycle;
  assert.equal(meso.phase, "deload-due");
  assert.match(meso.note, /joint feedback|soreness|flat/i);
  assert.match(meso.note, /hard endurance|timed\/bodyweight/i);
});

test("a free-text rapid-fade note participates in the same fatigue read", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  for (const wk of [1, 2, 3, 4]) {
    for (const off of [1, 3]) {
      for (let s = 1; s <= 4; s++) {
        repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: back(wk * 7 + off) });
      }
    }
  }
  repo.addActivity({ type: "run", duration_min: 70, distance_km: 12, date: REF });
  const session = repo.getOrCreateSession(REF);
  repo.finishSession(session.id, "I started strong but by the end of every set I almost could not lift the same weight.");

  const meso = repo.getProgramState(REF).mesocycle;
  assert.equal(meso.phase, "deload-due");
  assert.match(meso.note, /strength-endurance fading/i);
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

// ===========================================================================
// Wave E2: the curated exercise surface — movement-family fields, the junk-name
// filter, and last-trained recency the read groups and dates lifts by.
// ===========================================================================

test("lift states carry a movement family: re-implemented siblings share it, distinct movements don't", () => {
  repo.setProfile({ primary_discipline: "strength" });
  const seed = (name) => [21, 14, 7, 0].forEach((d, i) => repo.logSetByName({ exercise: name, weight: 135 + i * 5, reps: 5, rir: 2, date: back(d) }));
  seed("Barbell Bench Press");
  seed("DB Bench Press");
  seed("Back Squat");
  seed("Bulgarian Split Squat");

  const lifts = repo.getProgramState(REF).lifts;
  const byName = new Map(lifts.map((l) => [l.exercise, l]));

  // Barbell and DB bench are one family (implement tokens stripped).
  const bb = byName.get("Barbell Bench Press");
  const db = byName.get("DB Bench Press");
  assert.ok(bb && db, "both bench variants are analyzed");
  assert.equal(bb.family_key, "bench press");
  assert.equal(bb.family_label, "Bench Press");
  assert.equal(bb.family_key, db.family_key, "barbell and DB bench share a family");

  // Back Squat and Bulgarian Split Squat are NOT the same family.
  const backSquat = byName.get("Back Squat");
  const bulgarian = byName.get("Bulgarian Split Squat");
  assert.ok(backSquat && bulgarian, "both squat patterns are analyzed");
  assert.equal(backSquat.family_key, "back squat");
  assert.equal(bulgarian.family_key, "bulgarian split squat");
  assert.notEqual(backSquat.family_key, bulgarian.family_key, "squat patterns stay distinct families");

  // last_trained is the most recent loaded session date.
  assert.equal(bb.last_trained, back(0));
});

test("a junk exercise name (an 'Unknown' Garmin block) never pollutes the curated read", () => {
  repo.setProfile({ primary_discipline: "strength" });
  // An importer wrote real sets under a placeholder name — the data stays in the DB.
  for (let s = 1; s <= 5; s++) repo.logSetByName({ exercise: "Unknown", weight: 100, reps: 5, rir: 2, date: back(s) });
  repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 5, rir: 2, date: back(0) });

  const lifts = repo.getProgramState(REF).lifts;
  assert.ok(!lifts.some((l) => l.exercise.toLowerCase() === "unknown"), "the placeholder row is skipped by the read");
  assert.ok(lifts.some((l) => l.exercise === "Bench Press"), "real lifts still surface");
  // The underlying data is untouched — the row is still in the DB.
  const stillThere = db.prepare(`SELECT 1 FROM exercises WHERE name = 'Unknown'`).get();
  assert.ok(stillThere, "the exercise row is NOT deleted — the filter is read-only");
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

test("programBalance includes programmed groups with zero recent logged rows", () => {
  repo.setProfile({ primary_discipline: "strength" });
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 10 },
    { exercise: "Triceps Pushdown", sets: 3, rep_low: 10, rep_high: 15 },
  ]);

  const bal = repo.programBalance(2, REF);
  const groups = new Map(bal.groups.map((g) => [g.group, g]));
  assert.equal(groups.get("chest")?.sets, 0);
  assert.equal(groups.get("shoulders")?.status, "due");
  assert.ok(bal.due.includes("triceps"), "a programmed but unlogged group is due, not invisible");
});

test("an applied recovery window coherently overrides deload-due and accumulation state", () => {
  const proposal = repo.createProposal("stub", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Reduced recovery prescription.",
    days: [],
  });
  repo.setProposalStatus(proposal.id, "applied");
  repo.setAppState("recovery_week_applied", JSON.stringify({ applied_on: back(2), proposal_id: proposal.id }));
  repo.createBlock({ goal: "Build strength", focus: "strength", phase: "accumulation", week_index: 2, total_weeks: 6 });
  // Build enough completed load that the ordinary detector would call a deload due.
  for (let week = 1; week <= 6; week++) {
    repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: back(week * 7) });
  }

  const state = repo.getProgramState(REF);
  assert.equal(state.recovery_week?.state, "applied");
  assert.equal(state.mesocycle.phase, "deload");
  assert.match(state.mesocycle.note, /recovery week is active/i);
  assert.doesNotMatch(state.headline, /due|building/i);
  assert.equal(repo.blockForCoach(REF)?.phase, "deload");
});

test("the first post-recovery date resumes accumulation from the completed applied ledger", () => {
  const proposal = repo.createProposal("stub", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Reduced recovery prescription.",
    days: [],
  });
  repo.setProposalStatus(proposal.id, "applied");
  repo.setAppState("recovery_week_applied", JSON.stringify({ applied_on: back(7), proposal_id: proposal.id }));
  // Without the completed-ledger reset, this history immediately calls another
  // deload due on the first date outside the exclusive active window.
  for (let week = 1; week <= 6; week++) {
    repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: back(week * 7) });
  }

  const state = repo.getProgramState(REF);
  assert.equal(state.recovery_week, null, "the active [applied_on, until) window remains exclusive");
  assert.equal(state.mesocycle.weeks_since_deload, 0);
  assert.equal(state.mesocycle.phase, "accumulation");
  assert.match(state.mesocycle.note, /recovery week completed/i);
  assert.doesNotMatch(state.headline, /deload|due/i);
});
