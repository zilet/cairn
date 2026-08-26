// The deterministic program-state engine (src/repo/program-state.ts) — the floor
// under adaptive program intelligence. These lock the coach-level reads it must
// get right: a climbing lift reads 'progressing' (→ overload), a stuck-and-grinding
// lift reads 'plateaued' (→ deload/vary), a deload week is found in the mesocycle
// position, and the endurance block flags a one-pace base as needing quality work.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import {
  BUILDING_BASE_NOTE_VARIANTS,
  COMBINED_LOAD_RUN_YIELDS_QUIET_VARIANTS,
  COMBINED_LOAD_RUN_YIELDS_VARIANTS,
  COMBINED_LOAD_STRENGTH_YIELDS_VARIANTS,
  FATIGUE_DELOAD_NOTE_VARIANTS,
  FRESH_BLOCK_MAX_AGE_DAYS,
  INTENSIFICATION_NOTE_VARIANTS,
  LOADED_WEEK_FRACTION,
  MESO_FEEL_SUPPORT_VARIANTS,
  NO_DELOAD_ACCUMULATION_NOTE_VARIANTS,
  RECOVERY_WEEK_JUST_COMPLETED_NOTE_VARIANTS,
  SINCE_DELOAD_NOTE_VARIANTS,
  SINCE_RECOVERY_NOTE_VARIANTS,
  STREAK_DELOAD_NOTE_VARIANTS,
  STREAK_DELOAD_NONTONNAGE_NOTE_VARIANTS,
  classifyLoadedWeeks,
  classifyWeekLoad,
  familyLabelFromKey,
  lastMesocycleWeekLoadMisses,
} from "../dist/repo/program-state.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";

const REF = "2026-04-20";
const back = (n) => new Date(new Date(REF + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

beforeEach(() => {
  resetTables(
    "logged_sets",
    "session_skips",
    "sessions",
    "activities",
    "garmin_activities",
    "garmin_sources",
    "plan_items",
    "plan_days",
    "program_blocks",
    "plan_proposals",
    "daily_metrics",
    "checkins",
    "app_state",
    "daily_session_outcomes",
    "daily_session_compositions"
  );
});

test("a lift whose est-1RM is climbing reads 'progressing' → overload", () => {
  const w = [135, 140, 145, 152, 160];
  [28, 21, 14, 7, 0].forEach((d, i) =>
    repo.logSetByName({ exercise: "Bench Press", weight: w[i], reps: 5, rir: 2, date: back(d) })
  );
  const st = repo.getProgramState(REF);
  const bench = st.lifts.find((l) => l.exercise === "Bench Press");
  assert.ok(bench, "bench is analyzed");
  assert.equal(bench.status, "progressing");
  assert.equal(bench.suggested_action, "overload");
  assert.ok(bench.trend_per_wk > 0, "positive weekly trend");
});

test("a stuck-and-grinding lift reads 'plateaued' with a stall signal", () => {
  [28, 21, 14, 7, 0].forEach((d) =>
    repo.logSetByName({ exercise: "Overhead Press", weight: 115, reps: 5, rir: 1, date: back(d) })
  );
  const st = repo.getProgramState(REF);
  const ohp = st.lifts.find((l) => l.exercise === "Overhead Press");
  assert.equal(ohp.status, "plateaued");
  assert.ok(["deload", "vary", "technique"].includes(ohp.suggested_action));
  assert.ok(
    ohp.stall_signals.some((s) => /same top load/.test(s)),
    "flags the static load"
  );
  assert.ok(
    ohp.stall_signals.some((s) => /grind/.test(s)),
    "flags grinding at RIR 0–1"
  );
  assert.ok(
    st.adaptations_due.some((a) => /Overhead Press/.test(a)),
    "shows up in what to evolve next"
  );
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
  for (const wk of [2, 3, 4])
    for (const off of [0, 2])
      repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, date: back(wk * 7 + off) });
  repo.logSetByName({ exercise: "Back Squat", weight: 135, reps: 5, date: back(7) }); // light completed week (w=1)
  const meso = repo.getProgramState(REF).mesocycle;
  assert.equal(meso.weeks_since_deload, 1, "the light completed week one back is the deload");
});

test("a timed lift progresses on hold duration, not load", () => {
  const secs = [20, 25, 30, 35, 45];
  [28, 21, 14, 7, 0].forEach((d, i) =>
    repo.logSetByName({ exercise: "Plank", duration_sec: secs[i], exercise_mode: "timed", date: back(d) })
  );
  const plank = repo.getProgramState(REF).lifts.find((l) => l.exercise === "Plank");
  assert.equal(plank.mode, "timed");
  assert.equal(plank.status, "progressing");
  assert.equal(plank.best_seconds, 45);
  assert.equal(plank.est_1rm, null, "timed lifts carry no est-1RM");
});

test("a steady (flat) timed hold reads 'maintaining' → overload, NOT a false plateau/vary", () => {
  // A plank held at a consistent 45s for 5 sessions is healthy maintenance, not a
  // stall that needs a harder variation (the dead-branch bug classified it plateaued).
  [28, 21, 14, 7, 0].forEach((d) =>
    repo.logSetByName({ exercise: "Plank", duration_sec: 45, exercise_mode: "timed", date: back(d) })
  );
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
  const ex =
    repo.findExercise("Recovery Trajectory Press") ??
    repo.upsertExercise({
      name: "Recovery Trajectory Press",
      muscle_group: "chest",
    });
  const session = repo.getOrCreateSession(date, planDayId);
  if (performance != null) db.prepare(`UPDATE sessions SET performance = ? WHERE id = ?`).run(performance, session.id);
  for (let set = 1; set <= sets; set++) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir)
       VALUES (?, ?, ?, ?, 5, ?)`
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
    const session = logRecoveryTrajectoryExposure(
      REF,
      planDay.id,
      mode === "overdose" ? { sets: 4, weight: 100, rir: 5 } : { sets: 2, weight: 100, rir: 5, performance: 1 }
    );
    assert.equal(repo.recoverySessionDose(session.id).classification, mode === "overdose" ? "overdose" : "above-plan");
    const lift = repo.getProgramState(REF).lifts.find((row) => row.exercise === "Recovery Trajectory Press");
    assert.equal(lift.status, "regressing", `${mode} remains eligible trajectory evidence`);
  }
});

test("hybrid endurance: a one-pace base flags 'add-quality'", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  // ~12 km/wk of easy running over 4 weeks, no quality session.
  for (const wk of [3, 2, 1, 0]) {
    repo.addActivity({ type: "run", duration_min: 40, distance_km: 7, date: back(wk * 7 + 1) });
    repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: back(wk * 7 + 4) });
  }
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
  const source = db
    .prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'program-state-test')`)
    .run();
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
  assert.ok(
    st.adaptations_due.some((a) => /lower-body|legs|quads/i.test(a)),
    "hybrid conflict appears in adaptations due"
  );
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
  assert.ok(
    !st.adaptations_due.some((a) => /upper\/core|lower-body session/i.test(a)),
    "easy aerobic work should not force a leg-day swap"
  );
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
  assert.ok(
    st.adaptations_due.some((a) => /protect protein|lean-safe|carbs/i.test(a)),
    "fuel protection is an adaptation"
  );
});

test("a strength athlete gets no endurance block; the aggregate has a headline", () => {
  repo.setProfile({ primary_discipline: "strength" });
  [21, 14, 7, 0].forEach((d, i) =>
    repo.logSetByName({ exercise: "Deadlift", weight: 300 + i * 10, reps: 3, rir: 2, date: back(d) })
  );
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
    for (let s = 1; s <= 5; s++)
      repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: back(d) });
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
      for (let s = 1; s <= 5; s++)
        repo.logSetByName({ exercise: "Back Squat", weight: 315, reps: 5, rir: 2, date: back(wk * 7 + off) });
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

test("two 2-ratings plus one hard run with a complete log do not mint deload-due", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  // Four loaded weeks, every prescribed set at the prescribed load, plus two low
  // felt ratings and a heavy run. Felt ratings are supporting copy at most — they
  // never trigger deload-due on their own (the athlete wants to be sore).
  for (const wk of [1, 2, 3, 4]) {
    for (const off of [1, 3]) {
      for (let s = 1; s <= 4; s++) {
        repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: back(wk * 7 + off) });
      }
    }
  }
  repo.addActivity({ type: "run", duration_min: 70, distance_km: 12, date: REF });
  repo.setSessionFeedback(back(3), { performance: 2, soreness: 4 });
  repo.setSessionFeedback(back(1), { performance: 2, soreness: 4 });

  const meso = repo.getProgramState(REF).mesocycle;
  assert.notEqual(meso.phase, "deload-due", "a complete log outranks felt ratings");
  assert.equal(meso.phase, "accumulation");
});

test("a free-text rapid-fade note is supporting copy, never a deload-due trigger", () => {
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
  repo.finishSession(
    session.id,
    "I started strong but by the end of every set I almost could not lift the same weight."
  );

  const meso = repo.getProgramState(REF).mesocycle;
  assert.notEqual(meso.phase, "deload-due", "session notes never mint deload-due on their own");
  assert.equal(meso.phase, "accumulation");
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
  const seed = (name) =>
    [21, 14, 7, 0].forEach((d, i) =>
      repo.logSetByName({ exercise: name, weight: 135 + i * 5, reps: 5, rir: 2, date: back(d) })
    );
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
  assert.ok(
    lifts.some((l) => l.exercise === "Bench Press"),
    "real lifts still surface"
  );
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
    for (let s = 1; s <= 4; s++)
      repo.logSetByName({ exercise: "Leg Press", weight: 360, reps: 10, rir: 2, date: back(d) });
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
  assert.ok(
    vol.some((v) => v.muscle_group === "quads"),
    "loaded groups are still counted"
  );
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

test("classifyWeekLoad treats a travel-sized week as light against a loaded median", () => {
  const loaded = [
    { tonnage: 10000, units: 0 },
    { tonnage: 10200, units: 0 },
    { tonnage: 9800, units: 0 },
    { tonnage: 10100, units: 0 },
  ];
  assert.equal(LOADED_WEEK_FRACTION, 0.75);
  assert.equal(classifyWeekLoad({ tonnage: 10000, units: 0 }, loaded), "loaded");
  assert.equal(classifyWeekLoad({ tonnage: 3700, units: 0 }, loaded), "light");
  assert.equal(
    classifyWeekLoad({ tonnage: 5000, units: 0 }, [{ tonnage: 10000, units: 0 }]),
    "loaded",
    "fewer than 2 prior loaded weeks falls back to the existing floor (any tonnage)"
  );
  assert.equal(classifyWeekLoad({ tonnage: 0, units: 1 }, []), "light");
  assert.equal(classifyWeekLoad({ tonnage: 0, units: 4 }, []), "loaded");
  assert.equal(
    classifyWeekLoad({ tonnage: 0, units: 2 }, [
      { tonnage: 0, units: 8 },
      { tonnage: 0, units: 8 },
    ]),
    "light",
    "non-tonnage weeks compare units to the units median"
  );
  // The live defect: median of ALL prior weeks with data (three 3700s + one
  // 10000) is 3700, so a travel week classified loaded against itself. Peers
  // are already-classified LOADED weeks — the 3700s must not be in that set.
  assert.equal(
    classifyWeekLoad({ tonnage: 3700, units: 0 }, [3700, 3700, 3700, 10000].map((t) => ({ tonnage: t, units: 0 }))),
    "loaded",
    "passing mixed weeks as 'loaded' still pulls the median down — callers must not"
  );
  assert.equal(
    classifyWeekLoad(
      { tonnage: 3700, units: 0 },
      [],
      { priorWeeksWithData: [3700, 3700, 3700, 10000].map((t) => ({ tonnage: t, units: 0 })) }
    ),
    "light",
    "with no loaded peer, the heaviest prior week with data is the reference"
  );
  assert.equal(
    classifyWeekLoad(
      { tonnage: 3700, units: 0 },
      [],
      { priorWeeksWithData: [3700, 3700, 3700, 3700].map((t) => ({ tonnage: t, units: 0 })) }
    ),
    "loaded",
    "with no loaded peer, a 3700 stretch that IS the athlete's base still loads"
  );
});

test("classifyLoadedWeeks: travel after a loaded base stays light; a 3700 base then a jump resets later 3700s", () => {
  const t = (n) => ({ tonnage: n, units: 0 });
  // Oldest→newest: two loaded 10000s, then four travel 3700s.
  assert.deepEqual(
    classifyLoadedWeeks([t(10000), t(10000), t(3700), t(3700), t(3700), t(3700)]),
    ["loaded", "loaded", "light", "light", "light", "light"]
  );
  // Reverse: four 3700s ARE the base (no loaded peer yet, they meet the floor
  // and 0.75× max of themselves), then two 10000s load against that base.
  assert.deepEqual(
    classifyLoadedWeeks([t(3700), t(3700), t(3700), t(3700), t(10000), t(10000)]),
    ["loaded", "loaded", "loaded", "loaded", "loaded", "loaded"]
  );
  // The 10000s reset the reference: a later 3700 is light against them.
  assert.deepEqual(
    classifyLoadedWeeks([t(3700), t(3700), t(3700), t(3700), t(10000), t(10000), t(3700)]),
    ["loaded", "loaded", "loaded", "loaded", "loaded", "loaded", "light"]
  );
});

test("two loaded weeks then four travel weeks stay light — they do not mint deload-due", () => {
  repo.setProfile({ primary_discipline: "strength" });
  // Oldest: weekBack 5-6 at ~10000. Newest: weekBack 1-4 at ~3700.
  // The old median-of-all-with-data walk classified the 3700s loaded against
  // themselves, so the streak reached 6.
  for (const wk of [5, 6]) {
    for (const off of [1, 3]) {
      for (let s = 1; s <= 4; s++) {
        repo.logSetByName({ exercise: "Back Squat", weight: 250, reps: 5, rir: 2, date: back(wk * 7 + off) });
      }
    }
  }
  for (const wk of [1, 2, 3, 4]) {
    for (let s = 1; s <= 4; s++) {
      repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, rir: 2, date: back(wk * 7 + 1) });
    }
  }
  const meso = repo.getProgramState(REF).mesocycle;
  assert.notEqual(meso.phase, "deload-due");
  assert.equal(meso.phase, "accumulation");
});

test("a 3700 base then two 10000 weeks loads the old weeks; a later 3700 would be light", () => {
  repo.setProfile({ primary_discipline: "strength" });
  // Oldest four weeks ARE the athlete's base (3700); the two newest jump to 10000.
  // Six consecutive loaded weeks → deload-due. (Later 3700s against the new
  // reference are covered by classifyLoadedWeeks above.)
  for (const wk of [3, 4, 5, 6]) {
    for (let s = 1; s <= 4; s++) {
      repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, rir: 2, date: back(wk * 7 + 1) });
    }
  }
  for (const wk of [1, 2]) {
    for (const off of [1, 3]) {
      for (let s = 1; s <= 4; s++) {
        repo.logSetByName({ exercise: "Back Squat", weight: 250, reps: 5, rir: 2, date: back(wk * 7 + off) });
      }
    }
  }
  const meso = repo.getProgramState(REF).mesocycle;
  assert.equal(meso.phase, "deload-due");
});

test("travel-light weeks break the loaded streak without earning deload-due", () => {
  repo.setProfile({ primary_discipline: "strength" });
  // Weeks 3-6: ~full load. Weeks 1-2: ~one third of that (travel). The old
  // detector counted any tonnage>0 as loaded, so two travel weeks kept the streak
  // alive. They must now break it, and they must not mint deload-due on their own.
  for (const wk of [3, 4, 5, 6]) {
    for (const off of [0, 2, 4]) {
      for (let s = 1; s <= 5; s++) {
        repo.logSetByName({ exercise: "Back Squat", weight: 315, reps: 5, rir: 2, date: back(wk * 7 + off) });
      }
    }
  }
  for (const wk of [1, 2]) {
    for (let s = 1; s <= 5; s++) {
      repo.logSetByName({ exercise: "Back Squat", weight: 315, reps: 5, rir: 2, date: back(wk * 7) });
    }
  }
  const meso = repo.getProgramState(REF).mesocycle;
  assert.notEqual(meso.phase, "deload-due");
  assert.equal(meso.phase, "accumulation");
});

test("two regressing lifts plus drifting recovery after 4 loaded weeks reads deload-due", () => {
  repo.setProfile({ primary_discipline: "strength" });
  // wk=1 is the most recent completed week, so it carries the lowest load.
  const squat = [225, 235, 245, 255];
  const bench = [155, 165, 175, 185];
  [1, 2, 3, 4].forEach((wk, i) => {
    for (const off of [1, 3]) {
      for (let s = 1; s <= 4; s++) {
        repo.logSetByName({ exercise: "Back Squat", weight: squat[i], reps: 5, rir: 2, date: back(wk * 7 + off) });
        repo.logSetByName({ exercise: "Bench Press", weight: bench[i], reps: 5, rir: 2, date: back(wk * 7 + off) });
      }
    }
  });
  const drifting = {
    delta: { hrv: -6, rhr: 4 },
    quality: {
      hrv_ms: { latest_date: REF, freshness: "fresh", sample_count: 8, expected_days: 14 },
      resting_hr: { latest_date: REF, freshness: "fresh", sample_count: 8, expected_days: 14 },
    },
  };
  const st = repo.getProgramState(REF, drifting);
  const squatLift = st.lifts.find((l) => l.exercise === "Back Squat");
  const benchLift = st.lifts.find((l) => l.exercise === "Bench Press");
  assert.equal(squatLift.status, "regressing");
  assert.equal(benchLift.status, "regressing");
  assert.equal(st.mesocycle.phase, "deload-due");
  assert.match(st.mesocycle.note, /drifting|reset|lighter/i);
});

test("block week 1 never reads deload-due even after a long loaded streak", () => {
  repo.setProfile({ primary_discipline: "strength" });
  for (const wk of [1, 2, 3, 4, 5, 6]) {
    for (const off of [1, 3]) {
      for (let s = 1; s <= 4; s++) {
        repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: back(wk * 7 + off) });
      }
    }
  }
  repo.createBlock({
    goal: "Build strength",
    focus: "strength",
    phase: "accumulation",
    week_index: 1,
    total_weeks: 6,
    started_at: `${REF}T12:00:00.000Z`,
  });
  const meso = repo.getProgramState(REF).mesocycle;
  assert.notEqual(meso.phase, "deload-due");
  assert.equal(meso.phase, "accumulation");
});

test("a week_index-1 block started 30 days ago is not fresh and does not suppress deload-due", () => {
  assert.equal(FRESH_BLOCK_MAX_AGE_DAYS, 14);
  repo.setProfile({ primary_discipline: "strength" });
  for (const wk of [1, 2, 3, 4, 5, 6]) {
    for (const off of [1, 3]) {
      for (let s = 1; s <= 4; s++) {
        repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: back(wk * 7 + off) });
      }
    }
  }
  repo.createBlock({
    goal: "Build strength",
    focus: "strength",
    phase: "accumulation",
    week_index: 1,
    total_weeks: 6,
    started_at: `${back(30)}T12:00:00.000Z`,
  });
  const meso = repo.getProgramState(REF).mesocycle;
  assert.equal(meso.phase, "deload-due", "stuck week_index 1 on a month-old block must not silence the reset");
});

test("a fresh block with ACWR 1.6 still reads intensification", () => {
  repo.setProfile({ primary_discipline: "strength" });
  // Weeks 1-4 (completed): 2 days × 4 sets × 200 × 5 = 8000. Acute week: 320 × 5
  // × 4 × 2 = 12800 → ACWR 1.6 once the chronic floor is met.
  for (const wk of [1, 2, 3, 4]) {
    for (const off of [1, 3]) {
      for (let s = 1; s <= 4; s++) {
        repo.logSetByName({ exercise: "Back Squat", weight: 200, reps: 5, rir: 2, date: back(wk * 7 + off) });
      }
    }
  }
  for (const off of [1, 3]) {
    for (let s = 1; s <= 4; s++) {
      repo.logSetByName({ exercise: "Back Squat", weight: 320, reps: 5, rir: 2, date: back(off) });
    }
  }
  repo.createBlock({
    goal: "Build strength",
    focus: "strength",
    phase: "accumulation",
    week_index: 1,
    total_weeks: 6,
    started_at: `${REF}T12:00:00.000Z`,
  });
  const meso = repo.getProgramState(REF).mesocycle;
  assert.equal(meso.phase, "intensification");
  assert.ok(meso.acute_chronic_ratio >= 1.4);
});

test("mesocycle classifies each week once — a Map, not five re-queries per week", () => {
  repo.setProfile({ primary_discipline: "strength" });
  for (const wk of [1, 2, 3, 4]) {
    repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: back(wk * 7) });
  }
  repo.getProgramState(REF);
  const misses = lastMesocycleWeekLoadMisses();
  assert.ok(misses >= 12, `expected the 12 completed weeks to be read, got ${misses}`);
  assert.ok(misses <= 24, `week-load walk should be one Map per call (~20 unique weeks), got ${misses}`);
});

function stampAppliedRecoveryWeek(appliedOn) {
  const proposal = repo.createProposal("stub", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Reduced recovery prescription.",
    days: [],
  });
  repo.setProposalStatus(proposal.id, "applied");
  repo.setAppState("recovery_week_applied", JSON.stringify({ applied_on: appliedOn, proposal_id: proposal.id }));
}

function logLoadedWeeks(weeks, weight = 225) {
  for (const wk of weeks) {
    for (const off of [1, 3]) {
      for (let s = 1; s <= 4; s++) {
        repo.logSetByName({
          exercise: "Back Squat",
          weight,
          reps: 5,
          rir: 2,
          date: back(wk * 7 + off),
        });
      }
    }
  }
}

test("an applied recovery week whose tonnage never dipped still resets weeks-since from the ledger", () => {
  // Active window is 7 days. applied_on 28 days back → completed 21 days ago →
  // weeks_since_completion = 3. Same tonnage every week, so the 0.6× detector
  // never fires; the ledger is the only reset source.
  stampAppliedRecoveryWeek(back(28));
  logLoadedWeeks([1, 2, 3, 4, 5, 6, 7, 8]);
  const meso = repo.getProgramState(REF).mesocycle;
  assert.equal(meso.weeks_since_deload, 3, "ledger supplies weeks-since when tonnage never dipped");
  assert.equal(meso.phase, "accumulation");
  assert.ok(
    SINCE_RECOVERY_NOTE_VARIANTS.map((line) => line(3)).includes(meso.note),
    `note should be from the since-recovery set, got: ${meso.note}`
  );
});

test("calendar-only weeks since an applied recovery week with a progressing log stay accumulation", () => {
  // Active window is 7 days. applied_on 42 days back → completed 35 days ago →
  // weeks_since_completion = 5. Only two loaded weeks since: calendar alone
  // never mints deload-due (the old ≥4 ladder would have).
  stampAppliedRecoveryWeek(back(42));
  logLoadedWeeks([1, 2]);
  const meso = repo.getProgramState(REF).mesocycle;
  assert.equal(meso.weeks_since_deload, 5, "the completed ledger still resets weeks-since");
  assert.notEqual(meso.phase, "deload-due", "calendar gap after a recovery week is not itself deload-due");
  assert.equal(meso.phase, "accumulation");
});

// ===========================================================================
// familyLabelFromKey: display-only possessive fix. family_key strips punctuation
// ("Farmer's Carry" keys as "farmer s carry"), so a bare title-case pass reads
// "Farmer S Carry" — a stranded "S" token needs to fold back onto the previous
// word as a possessive. movementKey/normalizeExerciseName and the key itself are
// untouched; this only affects the display label built from that key.
// ===========================================================================
test("familyLabelFromKey collapses a stranded 's' token into a possessive", () => {
  assert.equal(familyLabelFromKey("farmer s carry"), "Farmer's Carry");
});

test("familyLabelFromKey leaves a normal key untouched", () => {
  assert.equal(familyLabelFromKey("bench press"), "Bench Press");
});

test("familyLabelFromKey handles a leading 's' token without crashing", () => {
  assert.equal(familyLabelFromKey("s carry"), "S Carry");
});

// liftStates(date) scopes which lifts EXIST as of the day being read, but every
// grade underneath it was computed from the FULL history — getProgress unbounded,
// comparableLiftDates unbounded, gradeTimedLift unbounded. So a historical read's
// est-1RM, trend and push/hold/deload verdict came from work that had not happened
// yet on the day it claims to describe.
test("a historical program state cannot grade a lift from sets logged after it", () => {
  const readDate = "2026-03-15";
  repo.logSetByName({ exercise: "Back Squat", weight: 200, reps: 5, rir: 2, date: "2026-03-08" });
  repo.logSetByName({ exercise: "Back Squat", weight: 205, reps: 5, rir: 2, date: "2026-03-12" });
  // A big jump logged FOUR DAYS AFTER the day being read.
  repo.logSetByName({ exercise: "Back Squat", weight: 320, reps: 5, rir: 2, date: "2026-03-19" });

  const asOfRead = repo.getProgramState(readDate);
  const lift = asOfRead.lifts.find((l) => /back squat/i.test(String(l.exercise)));
  assert.ok(lift, "the lift is present as of the read date");
  // Epley on 205x5 is ~239; on 320x5 it is ~373. The later set must be invisible.
  assert.ok(lift.est_1rm < 300, `graded ${lift.est_1rm} — a set logged after the read date leaked in`);

  // The live read still sees everything.
  const asOfLater = repo.getProgramState("2026-03-20");
  const laterLift = asOfLater.lifts.find((l) => /back squat/i.test(String(l.exercise)));
  assert.ok(laterLift.est_1rm > 300, "the later read still sees the whole history");
});

test("a historical timed-lift grade is bounded to the day being read too", () => {
  const readDate = "2026-03-15";
  repo.logSetByName({ exercise: "Side Plank", duration_sec: 30, exercise_mode: "timed", date: "2026-03-08" });
  repo.logSetByName({ exercise: "Side Plank", duration_sec: 40, exercise_mode: "timed", date: "2026-03-12" });
  repo.logSetByName({ exercise: "Side Plank", duration_sec: 200, exercise_mode: "timed", date: "2026-03-19" });

  const lift = repo.getProgramState(readDate).lifts.find((l) => /side plank/i.test(String(l.exercise)));
  assert.ok(lift, "the timed lift is present as of the read date");
  assert.ok(lift.best_seconds < 200, `held ${lift.best_seconds}s — a hold logged after the read date leaked in`);
});

// ── the COMBINED weekly stress budget ────────────────────────────────────────
// The two ACWR guards are per-lane and blind to each other, each with its own alarm
// bar (tonnage 1.4 → "intensification"; weekly km 1.5 → "spiking"). Both lanes can
// therefore ramp hard in the same week, each stay under its own bar, and nothing
// notice. These pin the cross-modality read that does.

const fwd = (n) => new Date(new Date(REF + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);

// Four chronic weeks in each lane, then an acute week ~1.35x in BOTH — comfortably
// inside each lane's own caution band and under each lane's own alarm.
function seedBothLanesRamped() {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  for (const wk of [1, 2, 3, 4]) {
    for (let i = 0; i < 5; i++)
      repo.logSetByName({ exercise: "Back Squat", weight: 250, reps: 5, rir: 2, date: back(wk * 7 + 2) });
    repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: back(wk * 7 + 2) });
  }
  for (let i = 0; i < 6; i++) repo.logSetByName({ exercise: "Back Squat", weight: 250, reps: 5, rir: 2, date: back(3) });
  repo.logSetByName({ exercise: "Back Squat", weight: 250, reps: 3, rir: 2, date: back(3) });
  repo.addActivity({ type: "run", duration_min: 80, distance_km: 13.5, date: back(2) });
}

test("both lanes ramping in the same week surfaces a combined read neither lane's own guard would", () => {
  seedBothLanesRamped();
  const st = repo.getProgramState(REF);
  // Neither lane is loud on its own — that is the whole point.
  assert.ok(st.mesocycle.acute_chronic_ratio < 1.4, "tonnage is under its own alarm bar");
  assert.ok(st.endurance.acute_chronic_ratio < 1.5, "weekly km is under its own alarm bar");
  assert.notEqual(st.endurance.status, "spiking");

  const combined = st.hybrid?.combined_load;
  assert.ok(combined, "the cross-modality read fires");
  assert.ok(typeof combined.why === "string" && combined.why.length > 20, "it speaks in plain sentences");
  assert.doesNotMatch(combined.why, /\d/, "no ratio, no number, ever");
  assert.doesNotMatch(combined.why, /acwr|ratio|chronic|acute/i, "and no engineering vocabulary");
  // It reaches the athlete through the same channel the per-lane guards use.
  assert.ok(st.adaptations_due.includes(combined.why), "the read is carried on the existing rationale channel");
});

test("the combined read stays quiet unless BOTH lanes are ramped", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  // Strength ramps; running holds completely steady.
  for (const wk of [1, 2, 3, 4]) {
    for (let i = 0; i < 5; i++)
      repo.logSetByName({ exercise: "Back Squat", weight: 250, reps: 5, rir: 2, date: back(wk * 7 + 2) });
    repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: back(wk * 7 + 2) });
  }
  for (let i = 0; i < 7; i++) repo.logSetByName({ exercise: "Back Squat", weight: 250, reps: 5, rir: 2, date: back(3) });
  repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: back(2) });
  const st = repo.getProgramState(REF);
  assert.ok(st.mesocycle.acute_chronic_ratio >= 1.3, "the strength lane really did ramp");
  assert.equal(st.hybrid?.combined_load ?? null, null, "one lane alone is not a combined budget");
});

test("a thin base never produces a combined read (each lane's low-base guard still stands)", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  // A returning athlete: one prior week in each lane, then a real week. Both raw
  // ratios would be enormous; both lanes suppress them, so there is nothing to combine.
  for (let i = 0; i < 2; i++) repo.logSetByName({ exercise: "Back Squat", weight: 200, reps: 5, date: back(9) });
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 4, date: back(9) });
  for (let i = 0; i < 8; i++) repo.logSetByName({ exercise: "Back Squat", weight: 250, reps: 5, date: back(3) });
  repo.addActivity({ type: "run", duration_min: 90, distance_km: 15, date: back(2) });
  const st = repo.getProgramState(REF);
  assert.equal(st.hybrid?.combined_load ?? null, null, "building a base is not two spikes");
});

test("with a dated race in the picture the STRENGTH lane yields its spike first", () => {
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Combined Half", date: fwd(70), distance_km: 21.1, weekly_km: 35 },
  });
  seedBothLanesRamped();
  const combined = repo.getProgramState(REF).hybrid?.combined_load;
  assert.ok(combined, "the combined read fires");
  assert.equal(combined.yields, "strength", "the race has the deadline; the weights can wait a week");
  assert.equal(combined.basis, "race-build");
  assert.match(combined.why, /lifting|strength|weights/i, "and the sentence says which lane holds");
});

test("a strength block at its peak flips the yielder — the RUN lane holds instead", () => {
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Combined Half", date: fwd(70), distance_km: 21.1, weekly_km: 35 },
  });
  repo.createBlock({ goal: "Peak strength", focus: "peak", phase: "realization", week_index: 4, total_weeks: 4 });
  seedBothLanesRamped();
  const combined = repo.getProgramState(REF).hybrid?.combined_load;
  assert.ok(combined, "the combined read fires");
  assert.equal(combined.yields, "run", "the block's peak week is the week's fixed point");
  assert.equal(combined.basis, "block-peak");
  assert.doesNotMatch(combined.why, /\d/, "still no numbers");
});

test("with nothing peaking and nothing dated, the running is the lane that holds", () => {
  seedBothLanesRamped();
  const combined = repo.getProgramState(REF).hybrid?.combined_load;
  assert.ok(combined);
  assert.equal(combined.yields, "run");
  assert.equal(combined.basis, "no-deadline");
});

// ── the reading grammar, over the combined-load vocabulary ────────────────────
// Both lanes ramped at once is a WEEK-long state, so this fires on every read for
// days. One literal would print verbatim the whole time, and every phrasing has to
// hold the same line as the rest of the athlete-facing surface.

test("every combined-load phrasing is a variant set that holds the reading grammar", () => {
  const render = (line) => {
    if (typeof line !== "function") return line;
    return line.length >= 3
      ? line(6, "a couple of lifts are drifting down", "with recovery drifting")
      : line(6);
  };
  const sets = [
    ["COMBINED_LOAD_STRENGTH_YIELDS", COMBINED_LOAD_STRENGTH_YIELDS_VARIANTS],
    ["COMBINED_LOAD_RUN_YIELDS", COMBINED_LOAD_RUN_YIELDS_VARIANTS],
    ["COMBINED_LOAD_RUN_YIELDS_QUIET", COMBINED_LOAD_RUN_YIELDS_QUIET_VARIANTS],
    ["BUILDING_BASE_NOTE", BUILDING_BASE_NOTE_VARIANTS],
    ["INTENSIFICATION_NOTE", INTENSIFICATION_NOTE_VARIANTS],
    ["NO_DELOAD_ACCUMULATION_NOTE", NO_DELOAD_ACCUMULATION_NOTE_VARIANTS],
    ["RECOVERY_WEEK_JUST_COMPLETED_NOTE", RECOVERY_WEEK_JUST_COMPLETED_NOTE_VARIANTS],
    ["FATIGUE_DELOAD_NOTE", FATIGUE_DELOAD_NOTE_VARIANTS],
    ["STREAK_DELOAD_NOTE", STREAK_DELOAD_NOTE_VARIANTS],
    ["STREAK_DELOAD_NONTONNAGE_NOTE", STREAK_DELOAD_NONTONNAGE_NOTE_VARIANTS],
    ["MESO_FEEL_SUPPORT", MESO_FEEL_SUPPORT_VARIANTS],
    ["SINCE_RECOVERY_NOTE", SINCE_RECOVERY_NOTE_VARIANTS],
    ["SINCE_DELOAD_NOTE", SINCE_DELOAD_NOTE_VARIANTS],
  ];
  for (const [label, set] of sets) {
    const lines = [...set].map(render);
    assert.ok(lines.length >= 3, `${label}: a set, never one literal printed for weeks`);
    assert.equal(new Set(lines).size, lines.length, `${label}: no duplicate phrasings`);
    for (const line of lines) {
      assert.equal(violatesReadingGrammar(line), null, `${label}: "${line}"`);
      assert.doesNotMatch(line, /acwr|ratio|residual|\bload score\b/i, `${label}: no engineering register — "${line}"`);
    }
  }
  // The three combined-load sets say different things and must not be interchangeable.
  const combined = sets
    .filter(([label]) => label.startsWith("COMBINED_LOAD"))
    .flatMap(([, set]) => [...set].map(render));
  assert.equal(new Set(combined).size, combined.length, "no phrasing is shared between the three answers");
});

test("with a supporting endurance role a race build yields the run, not strength", () => {
  seedBothLanesRamped();
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Spring Half", date: fwd(70), distance_km: 21.1, weekly_km: 35 },
    training_intent: {
      priorities: ["longevity", "muscle", "strength", "leanness", "endurance"],
      endurance_role: "supporting",
    },
  });
  const combined = repo.getProgramState(REF).hybrid?.combined_load;
  assert.ok(combined, "the combined read fires");
  assert.equal(combined.yields, "run", "strength is the main work; the mileage holds");
  assert.equal(combined.basis, "strength-led");
  assert.match(combined.why, /lift|strength|weight/i);
  assert.doesNotMatch(combined.why, /\d/, "no ratio, no number, ever");
  assert.equal(violatesReadingGrammar(combined.why), null);
});
