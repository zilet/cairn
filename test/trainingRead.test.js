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
import { DAY_READ_CAVEAT_VARIANTS } from "../dist/repo/day-read.js";

const REF = "2026-04-15";
// The recovery-week note is a caveat FRAGMENT spliced into the train read's sentence,
// and it rotates by calendar day like every other athlete-facing string — so pin the
// registered set rather than a regex that happened to fit one phrasing.
const saysRecoveryWeekCaveat = (why) =>
  assert.ok(
    DAY_READ_CAVEAT_VARIANTS["planned_training:recovery_week"].some((variant) => why.includes(variant)),
    `expected the recovery-week caveat, got ${JSON.stringify(why)}`
  );
const dayBefore = (base, n) => new Date(new Date(base + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

beforeEach(() => {
  resetTables(
    "logged_sets",
    "session_skips",
    "sessions",
    "plan_items",
    "plan_days",
    "activities",
    "garmin_activities",
    "garmin_sources",
    "exercise_aliases",
    "plan_proposals",
    "checkins",
    "daily_metrics",
    "context_events",
    "app_state"
  );
});

function startRecoveryWeek(appliedOn) {
  const proposal = repo.createProposal("stub", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Reduced recovery prescription.",
    days: repo.getPlan(),
  });
  repo.setProposalStatus(proposal.id, "applied");
  repo.setAppState("recovery_week_applied", JSON.stringify({ applied_on: appliedOn, proposal_id: proposal.id }));
  db.prepare(`UPDATE app_state SET updated_at = ? WHERE key = 'recovery_week_applied'`).run(`${appliedOn} 00:00:00`);
  return proposal;
}

function logPlannedSets(date, { count = 4, rir = 4, weight = 135 } = {}) {
  const day = repo.getPlanDay(1);
  const ex = repo.findExercise("Bench Press") ?? repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  const session = repo.getOrCreateSession(date, day.id);
  for (let set = 1; set <= count; set++) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir)
       VALUES (?, ?, ?, ?, 6, ?)`
    ).run(session.id, ex.id, set, weight, rir);
  }
  return session;
}

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
  const uncorroborated = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(uncorroborated.signals.consecutive_training_days, 3);
  assert.equal(uncorroborated.kind, "easy", "uncorroborated stacked days stay open as easy movement");
  assert.ok(
    DAY_READ_CAVEAT_VARIANTS["planned_training:stacked_days"].some((variant) =>
      uncorroborated.why.includes(variant)
    ),
    `expected the stacked-days caveat, got ${JSON.stringify(uncorroborated.why)}`
  );

  // A current signal that corroborates the streak without the protect rule
  // above earned-rest taking the day first (a low check-in / readiness reading
  // would ship as acute_signal_protection on the production path).
  repo.addContextEvent({
    kind: "travel",
    title: "Overnight trip, short sleep likely",
    start_date: REF,
    end_date: REF,
  });
  const corroborated = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(corroborated.signals.consecutive_training_days, 3);
  assert.equal(corroborated.kind, "rest");
  assert.equal(corroborated.decision.rule_code, "accumulated_load_rest");
});

test("an active recovery week keeps compliant reduced sessions easy and continues the plan", () => {
  repo.setProfile({ primary_discipline: "strength" });
  repo.savePlanDay(1, "Recovery Push", "Push", [
    { exercise: "Bench Press", sets: 4, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  startRecoveryWeek(dayBefore(REF, 4));
  for (const back of [3, 2, 1]) logPlannedSets(dayBefore(REF, back));

  const read = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(read.signals.recovery_week?.state, "applied");
  assert.equal(read.signals.consecutive_training_days, 0, "reduced sessions do not extend a loading streak");
  assert.equal(read.signals.recent_load[0].load, "easy");
  assert.equal(read.signals.recent_load[0].recovery_dose[0].classification, "compliant");
  assert.equal(read.kind, "train");
  saysRecoveryWeekCaveat(read.why);
});

test("a recovery session that materially exceeds its dose still protects the rest of that day", () => {
  repo.setProfile({ primary_discipline: "strength" });
  repo.savePlanDay(1, "Recovery Push", "Push", [
    { exercise: "Bench Press", sets: 4, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  startRecoveryWeek(dayBefore(REF, 2));
  const session = logPlannedSets(REF, { count: 8, rir: 2, weight: 155 });

  const dose = repo.recoverySessionDose(session.id);
  const read = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(dose.classification, "overdose");
  assert.equal(read.signals.today_load === "moderate" || read.signals.today_load === "hard", true);
  assert.equal(read.kind, "done");
  // The wording rotates per calendar day now (see dayRead.test.js); pin the RULE.
  assert.equal(read.decision.rule_code, "logged_loading_work_today");
});

test("a true recovery-dose overdose protects the following day before continuation resumes", () => {
  repo.setProfile({ primary_discipline: "strength" });
  repo.savePlanDay(1, "Recovery Push", "Push", [
    { exercise: "Bench Press", sets: 4, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  startRecoveryWeek(dayBefore(REF, 3));
  logPlannedSets(dayBefore(REF, 1), { count: 8, rir: 2, weight: 155 });

  const read = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(read.signals.recent_load[0].recovery_dose[0].classification, "overdose");
  assert.equal(read.kind, "rest");
  assert.equal(read.decision.rule_code, "recovery_dose_overrun");
});

test("the first post-recovery day keeps historical compliant sessions easy and resumes building", () => {
  repo.setProfile({ primary_discipline: "strength" });
  repo.savePlanDay(1, "Recovery Push", "Push", [
    { exercise: "Bench Press", sets: 4, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  const appliedOn = dayBefore(REF, 7);
  startRecoveryWeek(appliedOn);
  for (const back of [3, 2, 1]) logPlannedSets(dayBefore(REF, back));

  const read = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(read.signals.recovery_week, null, "the requested day is outside the exclusive window");
  assert.equal(read.signals.consecutive_training_days, 0, "prior reduced work is not retroactively ordinary load");
  assert.ok(read.signals.recent_load.slice(0, 3).every((row) => row.load === "easy"));
  assert.equal(read.kind, "train");
  assert.doesNotMatch(read.why, /trained hard several days/i);
});

test("recovery dose uses the immutable applied proposal after the live plan is edited", () => {
  repo.savePlanDay(1, "Recovery Push", "Push", [
    { exercise: "Bench Press", sets: 4, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  startRecoveryWeek(dayBefore(REF, 1));
  const session = logPlannedSets(REF, { count: 7, rir: 4, weight: 135 });
  assert.equal(repo.recoverySessionDose(session.id).classification, "overdose");

  repo.savePlanDay(1, "Edited Push", "Push", [
    { exercise: "Bench Press", sets: 8, rep_low: 5, rep_high: 8, target_weight: 155 },
  ]);
  const dose = repo.recoverySessionDose(session.id);
  assert.equal(dose.planned_working_sets, 4, "the applied recovery snapshot remains the authority");
  assert.equal(dose.classification, "overdose", "later plan edits do not rewrite historical coaching truth");
});

test("a same-day session that predates the recovery snapshot remains unknown", () => {
  repo.savePlanDay(1, "Recovery Push", "Push", [
    { exercise: "Bench Press", sets: 4, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  const session = logPlannedSets(REF);
  startRecoveryWeek(REF);
  db.prepare(`UPDATE sessions SET created_at = ? WHERE id = ?`).run(`${REF} 08:00:00`, session.id);
  db.prepare(`UPDATE app_state SET updated_at = ? WHERE key = 'recovery_week_applied'`).run(`${REF} 12:00:00`);

  const dose = repo.recoverySessionDose(session.id);
  assert.equal(dose.planned_working_sets, null);
  assert.equal(dose.classification, "unknown");
});

test("strong cross-alias duplicate evidence does not inflate a recovery dose", () => {
  repo.savePlanDay(1, "Recovery Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  startRecoveryWeek(dayBefore(REF, 1));
  const day = repo.getPlanDay(1);
  const canonical = repo.findExercise("Bench Press");
  db.prepare(`INSERT INTO exercises (name, muscle_group, mode) VALUES ('Garmin Chest Press', 'chest', 'reps')`).run();
  const alias = repo.findExercise("Garmin Chest Press");
  repo.setExerciseAlias("Garmin Chest Press", "Bench Press", "garmin-import");
  const session = repo.getOrCreateSession(REF, day.id);
  db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(
    JSON.stringify({ cairn_sets_authoritative: false, imported_set_activity_ids: ["garmin-strength-1"] }),
    session.id
  );
  for (const exercise of [canonical, alias]) {
    for (let set = 1; set <= 3; set++) {
      db.prepare(
        `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir)
         VALUES (?, ?, ?, 135, 6, 4)`
      ).run(session.id, exercise.id, set);
    }
  }

  const dose = repo.recoverySessionDose(session.id);
  assert.equal(dose.raw_logged_sets, 6);
  assert.equal(dose.canonical_working_sets, 3);
  assert.equal(dose.duplicate_alias_sets, 3);
  assert.equal(dose.classification, "compliant");
  assert.equal(repo.sessionLoad(session.id, { recoveryWeekActive: true }), "easy");
});

test("ordinary aliased exercise variants are not collapsed without provider provenance", () => {
  repo.savePlanDay(1, "Recovery Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  startRecoveryWeek(dayBefore(REF, 1));
  const day = repo.getPlanDay(1);
  const canonical = repo.findExercise("Bench Press");
  db.prepare(
    `INSERT INTO exercises (name, muscle_group, mode) VALUES ('Bench Press Variation', 'chest', 'reps')`
  ).run();
  const variation = repo.findExercise("Bench Press Variation");
  repo.setExerciseAlias("Bench Press Variation", "Bench Press", "manual");
  const session = repo.getOrCreateSession(REF, day.id);
  for (const exercise of [canonical, variation]) {
    for (let set = 1; set <= 3; set++) {
      db.prepare(
        `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir)
         VALUES (?, ?, ?, 135, 6, 4)`
      ).run(session.id, exercise.id, set);
    }
  }

  const dose = repo.recoverySessionDose(session.id);
  assert.equal(dose.raw_logged_sets, 6);
  assert.equal(dose.canonical_working_sets, 6, "legitimate two-exercise work is retained");
  assert.equal(dose.duplicate_alias_sets, 0);
});

test("Garmin VO2 label variants are hard efforts", () => {
  for (const te_label of ["VO2MAX", "vo2_max", "VO2 max"]) {
    assert.equal(repo.cardioEffort({ type: "run", duration_min: 15, te_label }), "hard", te_label);
  }
});

test("live recovery acceptance: Jul 15 tempo completes the day, Jul 16 continues Pull, Jul 17 resumes build", () => {
  const appliedOn = "2026-07-10";
  const tempoDate = "2026-07-15";
  const continuationDate = "2026-07-16";
  const buildDate = "2026-07-17";
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  repo.savePlanDay(1, "Recovery Pull", "Pull", [
    { exercise: "Seated Cable Row", sets: 4, rep_low: 8, rep_high: 12, target_weight: 100 },
  ]);
  startRecoveryWeek(appliedOn);
  const activity = db
    .prepare(
      `INSERT INTO activities (date, type, duration_min, distance_km, source) VALUES (?, 'run', 22, 4, 'garmin')`
    )
    .run(tempoDate);
  const source = db
    .prepare(`INSERT INTO garmin_sources (provider, mode, label) VALUES ('garmin', 'unofficial', 'recovery-test')`)
    .run();
  db.prepare(
    `INSERT INTO garmin_activities
       (source_id, external_id, activity_id, date, type, duration_min, distance_km, aerobic_te, te_label)
     VALUES (?, 'tempo-1', ?, ?, 'run', 22, 4, 3.3, 'tempo')`
  ).run(source.lastInsertRowid, activity.lastInsertRowid, tempoDate);

  const onTempoDay = repo.dayRead(tempoDate, { has_data: false, recovery: {} });
  assert.equal(onTempoDay.signals.today_load, "moderate");
  assert.equal(onTempoDay.kind, "done");

  const next = repo.dayRead(continuationDate, { has_data: false, recovery: {} });
  assert.equal(next.kind, "train");
  assert.equal(next.focus, "Pull");
  saysRecoveryWeekCaveat(next.why);

  const postWindow = repo.dayRead(buildDate, { has_data: false, recovery: {} });
  assert.equal(postWindow.signals.recovery_week, null);
  assert.equal(postWindow.kind, "train");
  assert.doesNotMatch(postWindow.why, /recovery-week|trained hard several days/i);
});

test("dayRead maps an ad-hoc pull session by movement group and advances the split", () => {
  repo.setProfile({ primary_discipline: "strength" });
  repo.savePlanDay(1, "Pull", "Pull", [
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12 },
    { exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 12 },
    { exercise: "EZ Bar Curl", sets: 3, rep_low: 10, rep_high: 15 },
  ]);
  repo.savePlanDay(2, "Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 10 },
    { exercise: "Triceps Pushdown", sets: 3, rep_low: 10, rep_high: 15 },
  ]);

  const pullDate = dayBefore(REF, 2);
  repo.logSetByName({ exercise: "Pull-Up", reps: 8, rir: 2, date: pullDate });
  repo.logSetByName({ exercise: "One-Arm DB Row", weight: 75, reps: 10, rir: 2, date: pullDate });
  repo.logSetByName({ exercise: "Hammer Curl", weight: 35, reps: 12, rir: 2, date: pullDate });

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "train");
  assert.equal(r.focus, "Push");
  assert.equal(r.signals.plan_selection.anchor.method, "group-overlap");
  assert.equal(r.signals.plan_selection.selected.day_number, 2);
});

test("dayRead shifts away from a recovering pull rotation toward fresher due push work", () => {
  repo.setProfile({ primary_discipline: "strength" });
  repo.savePlanDay(1, "Pull", "Pull", [
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12 },
    { exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 12 },
    { exercise: "EZ Bar Curl", sets: 3, rep_low: 10, rep_high: 15 },
  ]);
  repo.savePlanDay(2, "Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 10 },
    { exercise: "Triceps Pushdown", sets: 3, rep_low: 10, rep_high: 15 },
  ]);
  repo.savePlanDay(3, "Lower", "Lower", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 }]);

  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date: dayBefore(REF, 3), day_number: 3 });
  repo.addActivity({ type: "row", duration_min: 60, distance_km: 10, date: dayBefore(REF, 1) });

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "train");
  assert.equal(r.focus, "Push");
  assert.equal(r.signals.plan_selection.rotation.focus, "Pull");
  assert.equal(r.signals.plan_selection.adapted, true);
  assert.match(r.why, /due|recover/i);
});

// ── PART 2 fix round: the sport-aware hard-cardio bar (walk/hike must clear a much
// longer / intensity bar than a run, so a ~43-min easy hike never grades as loading).
function seedHcActivity(date, { type = "run", duration_min = null, distance_km = null } = {}) {
  return db
    .prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, ?, ?, ?)`)
    .run(date, type, duration_min, distance_km);
}
function seedHcGarmin(
  activityId,
  date,
  { type = "run", aerobic_te = null, te_label = null, hr_zones_json = null, training_load = null } = {}
) {
  const src = db
    .prepare(`INSERT INTO garmin_sources (provider, mode, label) VALUES ('garmin','unofficial','hc-test')`)
    .run();
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, aerobic_te, te_label, hr_zones_json, training_load)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    src.lastInsertRowid,
    `hc-${activityId}-${date}`,
    activityId,
    date,
    type,
    aerobic_te,
    te_label,
    hr_zones_json,
    training_load
  );
}

test("hardCardioDay: a ~43-min EASY hike with no wearable data is NOT hard", () => {
  seedHcActivity(REF, { type: "hike", duration_min: 43, distance_km: 4 });
  assert.equal(repo.hardCardioDay(REF), false);
});

test("hardCardioDay: a long ~95-min hike with no Garmin data IS hard", () => {
  seedHcActivity(REF, { type: "hike", duration_min: 95, distance_km: 7 });
  assert.equal(repo.hardCardioDay(REF), true);
});

test("hardCardioDay: a 45-min hike with a hard training-effect IS hard (intensity qualifies any type)", () => {
  const a = seedHcActivity(REF, { type: "hike", duration_min: 45, distance_km: 5 });
  seedHcGarmin(a.lastInsertRowid, REF, { type: "hiking", aerobic_te: 4.2 });
  assert.equal(repo.hardCardioDay(REF), true);
});

test("hardCardioDay: a 42-min run (endurance sport) IS hard on duration alone", () => {
  seedHcActivity(REF, { type: "run", duration_min: 42, distance_km: 8 });
  assert.equal(repo.hardCardioDay(REF), true);
});

test("hardCardioDay: a 25-min run stays easy (below the endurance duration bar)", () => {
  seedHcActivity(REF, { type: "run", duration_min: 25, distance_km: 5 });
  assert.equal(repo.hardCardioDay(REF), false);
});
