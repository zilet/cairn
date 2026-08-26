// Comparability is a per-LIFT question, and the athlete's standing "push me"
// declaration has bounded mechanical authority.
//
// The bug this file pins: a session-wide comparability verdict made progression
// mathematically unreachable for a hybrid athlete. Every day carried SOME
// confounder — a run, a rest-day override, one short accessory — and a single
// flag held the WHOLE day's evidence out of the comparable set, so no lift could
// ever earn a load step. The confounders are real; their SCOPE was wrong.
//
// Deterministic, offline, temp DB (see test/run.mjs).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { db, localDaysAgo, repo, resetTables, seedIntake, seedWeight } from "./_seed.js";
import {
  doseComparability,
  evaluatePerformedAtFullLoad,
  harderLoad,
  repairOutcomeComparability,
} from "../dist/repo/daily-reconciliation.js";
import { countComparableDoseShortfallSessions } from "../dist/repo/session-dose-log.js";
import { nextPrescription, planDayProgression } from "../dist/repo/progression.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { MIGRATIONS, runMigrations } from "../dist/migrate.js";
import * as blocks from "../dist/repo/program-blocks.js";

const DATE = "2031-09-12";

beforeEach(() => {
  resetTables(
    "daily_session_outcomes",
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "training_symptom_events",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "activities",
    "context_events",
    "plan_items",
    "plan_days",
    "exercises",
    "plan_proposals",
    "program_blocks",
    "recovery_cycles",
    "bodyweight_log",
    "food_notes",
    "fueling_feedback",
    "checkins",
    "nutrition_targets",
    "profile",
    "journey_phases",
    "daily_metrics",
    "brain_decisions",
    "brain_expectations",
    "brain_evaluations",
    "app_state"
  );
  repo.setSettings({ training_drive: "steady" });
});

const isoDaysAgo = (n) => localDateISO(new Date(Date.now() - n * 864e5));

function makeExercise(name, muscleGroup) {
  repo.upsertExercise({ name, muscle_group: muscleGroup, mode: "reps" });
  return repo.findExercise(name);
}

function logSet(name, date, { weight = null, reps = null, rir = null, setNum = 1 } = {}) {
  const ex = repo.findExercise(name);
  const session = repo.getOrCreateSession(date, null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(session.id, ex.id, setNum, weight, reps, rir);
}

function doseFor(outcome, exercise) {
  return outcome.facts.dose_evidence.find((entry) => entry.exercise === exercise);
}

function stampTrainAnywayRestEnvelope(sessionId, { recoveryCycle = null } = {}) {
  const row = db
    .prepare(
      `SELECT constraints_json, provenance_json FROM daily_session_compositions
        WHERE session_id = ? AND status = 'active'`
    )
    .get(sessionId);
  const constraints = JSON.parse(row.constraints_json || "{}");
  const provenance = JSON.parse(row.provenance_json || "{}");
  const daily_decision = {
    kind: "train",
    baseline_kind: "rest",
    train_anyway: true,
    caps: { intensity: "deload", volume: "reduced" },
    recovery_cycle: recoveryCycle,
    template: { focus: "recovery" },
    rationale: [
      { code: "low_recovery_rest", text: "Today reads as a rest day — recovery earns tomorrow's work." },
    ],
  };
  constraints.train_anyway = true;
  constraints.daily_decision = { ...(constraints.daily_decision || {}), ...daily_decision };
  provenance.daily_decision = { ...(provenance.daily_decision || {}), ...daily_decision };
  provenance.choice = "training_by_choice";
  db.prepare(
    `UPDATE daily_session_compositions
        SET source = 'athlete_override', constraints_json = ?, provenance_json = ?
      WHERE session_id = ? AND status = 'active'`
  ).run(JSON.stringify(constraints), JSON.stringify(provenance), sessionId);
}

function liveShapedFacts() {
  return {
    schema_version: 3,
    dose_context: {
      recovery: true,
      athlete_override: true,
      travel: false,
      illness: false,
      symptom: false,
      endurance: true,
      partial: false,
      comparable: false,
      non_comparable_reasons: [
        "recovery_dose",
        "athlete_override",
        "loaded_endurance",
        "endurance_quality_unverified",
      ],
    },
    dose_evidence: [
      {
        exercise: "Pendlay Row",
        prescribed: { sets: 2, target_weight: 121.5 },
        achieved: { sets: 3, top_weight: 145 },
        comparable: false,
        non_comparable_reasons: ["recovery_dose"],
      },
    ],
  };
}

// ===========================================================================
// THE RULE ITSELF — each reason scoped to what it actually touches
// ===========================================================================

test("training on a rest-suggested day is the athlete driving, not corrupted evidence", () => {
  const verdict = doseComparability({
    session_reasons: ["athlete_override"],
    own_dose_shortfall: false,
    endurance_overlap: false,
  });
  assert.equal(verdict.comparable, true);
  assert.deepEqual(verdict.non_comparable_reasons, []);
});

test("a shortfall blocks the lift that fell short, and only that lift", () => {
  const shortLift = doseComparability({
    session_reasons: ["partial"],
    own_dose_shortfall: true,
    endurance_overlap: false,
  });
  const otherLift = doseComparability({
    session_reasons: ["partial"],
    own_dose_shortfall: false,
    endurance_overlap: false,
  });
  assert.equal(shortLift.comparable, false);
  assert.deepEqual(shortLift.non_comparable_reasons, ["partial"]);
  assert.equal(otherLift.comparable, true, "another movement's shortfall says nothing about this one");
});

test("endurance blocks only the muscle it actually loaded", () => {
  const overlapping = doseComparability({
    session_reasons: ["loaded_endurance"],
    own_dose_shortfall: false,
    endurance_overlap: true,
  });
  const unrelated = doseComparability({
    session_reasons: ["loaded_endurance"],
    own_dose_shortfall: false,
    endurance_overlap: false,
  });
  assert.equal(overlapping.comparable, false);
  assert.equal(unrelated.comparable, true, "a run does not invalidate the overhead press");
});

test("an endurance-side quality verdict makes no claim about a lift", () => {
  for (const reason of ["endurance_quality_not_observed", "endurance_quality_unverified"]) {
    const verdict = doseComparability({
      session_reasons: [reason],
      own_dose_shortfall: false,
      endurance_overlap: true,
    });
    assert.equal(verdict.comparable, true, reason);
  }
});

test("a day-wide reason still holds the whole day, including one this table has never seen", () => {
  for (const reason of ["recovery_dose", "travel", "illness", "relevant_symptom", "some_future_reason"]) {
    const verdict = doseComparability({
      session_reasons: [reason],
      own_dose_shortfall: false,
      endurance_overlap: false,
    });
    assert.equal(verdict.comparable, false, reason);
    assert.deepEqual(verdict.non_comparable_reasons, [reason]);
  }
});

function fullLoadRef(partial = {}) {
  return {
    sets: null,
    target_weight: null,
    target_seconds: null,
    rep_low: null,
    recent_working_weight: null,
    recent_working_seconds: null,
    ...partial,
  };
}

test("a lift with no plan-row sets never reads as performed at full load", () => {
  // Probe: substitute, 1 set at recent working weight. Unknown sets is not met.
  assert.equal(
    evaluatePerformedAtFullLoad(
      "reps",
      { sets: 1, top_weight: 145, top_reps: 8, top_seconds: null },
      fullLoadRef({ recent_working_weight: 145 })
    ),
    false
  );
});

test("a timed lift with no seconds reference never reads full-load on sets alone", () => {
  // Probe: 5-second hold at the prescribed set count, no seconds reference.
  assert.equal(
    evaluatePerformedAtFullLoad(
      "timed",
      { sets: 3, top_weight: null, top_reps: null, top_seconds: 5 },
      fullLoadRef({ sets: 3 })
    ),
    false
  );
  assert.equal(
    evaluatePerformedAtFullLoad(
      "timed",
      { sets: 3, top_weight: null, top_reps: null, top_seconds: 30 },
      fullLoadRef({ sets: 3, target_seconds: 30 })
    ),
    true
  );
});

test("a bodyweight lift with no rep reference never reads full-load on sets alone", () => {
  // Probe: 1 rep at the prescribed set count, rep_low null.
  assert.equal(
    evaluatePerformedAtFullLoad(
      "reps",
      { sets: 3, top_weight: null, top_reps: 1, top_seconds: null },
      fullLoadRef({ sets: 3 })
    ),
    false
  );
  assert.equal(
    evaluatePerformedAtFullLoad(
      "reps",
      { sets: 3, top_weight: null, top_reps: 8, top_seconds: null },
      fullLoadRef({ sets: 3, rep_low: 8 })
    ),
    true
  );
});

test("recentWorkingWeight is the PRIMARY full-load reference; the plan target is only a fallback with no history", () => {
  // Probe: plan +100 (a forward prescription) / recent −30 (still assisted in
  // the log) / achieved +100. Comparing against the plan target would silently
  // mean "hit your NEXT target" — the log still says assisted, so the achieved
  // positive weight is not confirmed full-load evidence yet.
  assert.equal(harderLoad(100, -30), -30);
  assert.equal(
    evaluatePerformedAtFullLoad(
      "reps",
      { sets: 3, top_weight: 100, top_reps: 5, top_seconds: null },
      fullLoadRef({ sets: 3, target_weight: 100, recent_working_weight: -30 })
    ),
    false,
    "an achieved positive weight against a still-assisted recent reference is the mixed-sign guard, not full-load"
  );
  // No history at all: the plan target is the only reference there is.
  assert.equal(harderLoad(100, null), 100);
  assert.equal(harderLoad(-30, 50), 50, "a positive recent always wins over an assisted plan target");
});

test("the live-shaped Pendlay Row: a reduced composition performed above recent working weight reads full-load even below the plan's forward target", () => {
  // Live example: composition 2x121.5 (reduced), plan_items 3 sets / target
  // 150 (a forward prescription progression already wrote), recent working
  // weight 135, achieved 3x145. Comparing against the plan target (150) would
  // read false; recent (135) is the primary reference and 145 clears it.
  assert.equal(harderLoad(150, 135), 135);
  assert.equal(
    evaluatePerformedAtFullLoad(
      "reps",
      { sets: 3, top_weight: 145, top_reps: 8, top_seconds: null },
      fullLoadRef({ sets: 3, target_weight: 150, recent_working_weight: 135 })
    ),
    true
  );
});

test("recent working weight 135, achieved only 130, does not read full-load even though the plan target is higher", () => {
  assert.equal(
    evaluatePerformedAtFullLoad(
      "reps",
      { sets: 3, top_weight: 130, top_reps: 8, top_seconds: null },
      fullLoadRef({ sets: 3, target_weight: 150, recent_working_weight: 135 })
    ),
    false
  );
});

test("assisted: recent -30, plan -40, achieved -25 clears the assist band; -35 does not", () => {
  assert.equal(harderLoad(-40, -30), -30);
  assert.equal(
    evaluatePerformedAtFullLoad(
      "reps",
      { sets: 3, top_weight: -25, top_reps: 8, top_seconds: null },
      fullLoadRef({ sets: 3, target_weight: -40, recent_working_weight: -30 })
    ),
    true,
    "less assist (-25) than the recent working band (-30) is harder"
  );
  assert.equal(
    evaluatePerformedAtFullLoad(
      "reps",
      { sets: 3, top_weight: -35, top_reps: 8, top_seconds: null },
      fullLoadRef({ sets: 3, target_weight: -40, recent_working_weight: -30 })
    ),
    false,
    "more assist (-35) than the recent working band (-30) is not full-load"
  );
});

test("full-load work drops recovery_dose and travel, and never illness or a relevant symptom", () => {
  const dropped = doseComparability({
    session_reasons: ["recovery_dose", "travel", "athlete_override"],
    own_dose_shortfall: false,
    endurance_overlap: false,
    performed_at_full_load: true,
  });
  assert.equal(dropped.comparable, true);
  assert.deepEqual(dropped.non_comparable_reasons, []);

  const illness = doseComparability({
    session_reasons: ["illness", "recovery_dose"],
    own_dose_shortfall: false,
    endurance_overlap: false,
    performed_at_full_load: true,
  });
  assert.equal(illness.comparable, false);
  assert.deepEqual(illness.non_comparable_reasons, ["illness"]);

  const symptom = doseComparability({
    session_reasons: ["relevant_symptom", "travel"],
    own_dose_shortfall: false,
    endurance_overlap: false,
    performed_at_full_load: true,
  });
  assert.equal(symptom.comparable, false);
  assert.deepEqual(symptom.non_comparable_reasons, ["relevant_symptom"]);
});

// ===========================================================================
// THE RECONCILER — per-dose flags on a real session
// ===========================================================================

function finishDay(items, date = DATE) {
  repo.savePlanDay(1, "Mixed", "Mixed", items);
  const prepared = repo.prepareDailySession({ date, source: "manual_plan", day_number: 1 });
  return prepared;
}

test("one lift's shortfall does not hold the lift that completed its own dose", () => {
  makeExercise("Back Squat", "quads");
  makeExercise("Barbell Bench Press", "chest");
  const prepared = finishDay([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 },
  ]);
  for (let s = 1; s <= 3; s++) {
    repo.logSetByName({ date: DATE, exercise: "Barbell Bench Press", weight: 185, reps: 5, day_number: null });
  }
  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  repo.finishSession(prepared.session_id, null);

  const outcome = repo.getDailySessionOutcome(DATE);
  assert.equal(outcome.facts.schema_version, 4);
  assert.equal(outcome.facts.dose_context.comparable, false, "the session verdict is kept for telemetry");
  assert.equal(doseFor(outcome, "Barbell Bench Press").comparable, true);
  assert.equal(doseFor(outcome, "Back Squat").comparable, false);
  assert.deepEqual(doseFor(outcome, "Back Squat").non_comparable_reasons, ["partial"]);
});

test("choosing to train on a rest-suggested day leaves every lift comparable", () => {
  makeExercise("Barbell Bench Press", "chest");
  const prepared = finishDay([{ exercise: "Barbell Bench Press", sets: 2, rep_low: 5, rep_high: 5, target_weight: 185 }]);
  db.prepare(`UPDATE daily_session_compositions SET source = 'athlete_override' WHERE session_id = ?`).run(
    prepared.session_id
  );
  for (let s = 1; s <= 2; s++) {
    repo.logSetByName({ date: DATE, exercise: "Barbell Bench Press", weight: 185, reps: 5, day_number: null });
  }
  repo.finishSession(prepared.session_id, null);

  const outcome = repo.getDailySessionOutcome(DATE);
  assert.ok(outcome.facts.dose_context.non_comparable_reasons.includes("athlete_override"));
  assert.equal(doseFor(outcome, "Barbell Bench Press").comparable, true);
});

test("a train-anyway rest envelope with deload caps and recovery prose is not a recovery window", () => {
  makeExercise("Barbell Bench Press", "chest");
  const prepared = finishDay([{ exercise: "Barbell Bench Press", sets: 2, rep_low: 5, rep_high: 5, target_weight: 185 }]);
  stampTrainAnywayRestEnvelope(prepared.session_id);
  for (let s = 1; s <= 2; s++) {
    repo.logSetByName({ date: DATE, exercise: "Barbell Bench Press", weight: 185, reps: 5, day_number: null });
  }
  repo.finishSession(prepared.session_id, null);

  const outcome = repo.getDailySessionOutcome(DATE);
  assert.equal(outcome.facts.dose_context.recovery, false);
  assert.ok(!outcome.facts.dose_context.non_comparable_reasons.includes("recovery_dose"));
  assert.equal(doseFor(outcome, "Barbell Bench Press").comparable, true);
  assert.ok(!doseFor(outcome, "Barbell Bench Press").non_comparable_reasons.includes("recovery_dose"));
});

test("an active recovery cycle still marks the day as a recovery window", () => {
  makeExercise("Barbell Bench Press", "chest");
  const cycle = repo.scheduleRecoveryCycle({
    effective_on: DATE,
    exit_on: addDaysISO(DATE, 7),
  });
  repo.activateRecoveryCycle(cycle.id, DATE);
  const prepared = finishDay([{ exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 }]);
  for (let s = 1; s <= 2; s++) {
    repo.logSetByName({ date: DATE, exercise: "Barbell Bench Press", weight: 185, reps: 5, day_number: null });
  }
  repo.finishSession(prepared.session_id, null);

  const outcome = repo.getDailySessionOutcome(DATE);
  assert.equal(outcome.facts.dose_context.recovery, true);
  assert.ok(outcome.facts.dose_context.non_comparable_reasons.includes("recovery_dose"));
  const dose = doseFor(outcome, "Barbell Bench Press");
  assert.equal(dose.performed_at_full_load, false, "two of three plan sets is not the full working load");
  assert.equal(dose.comparable, false);
  assert.ok(dose.non_comparable_reasons.includes("recovery_dose"));
});

test("a reduced prescription performed at full working load is comparable; its sibling that only met the reduced dose is not", () => {
  makeExercise("Pendlay Row", "back");
  makeExercise("Barbell Bench Press", "chest");
  const cycle = repo.scheduleRecoveryCycle({
    effective_on: DATE,
    exit_on: addDaysISO(DATE, 7),
  });
  repo.activateRecoveryCycle(cycle.id, DATE);
  repo.savePlanDay(1, "Mixed", "Mixed", [
    { exercise: "Pendlay Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 145 },
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 145 },
  ]);
  const prepared = repo.prepareDailySession({ date: DATE, source: "manual_plan", day_number: 1 });
  const row = db
    .prepare(`SELECT items_json FROM daily_session_compositions WHERE session_id = ? AND status = 'active'`)
    .get(prepared.session_id);
  const reduced = JSON.parse(row.items_json).map((item) => ({ ...item, sets: 2, target_weight: 121.5 }));
  db.prepare(`UPDATE daily_session_compositions SET items_json = ? WHERE session_id = ? AND status = 'active'`).run(
    JSON.stringify(reduced),
    prepared.session_id
  );
  for (let s = 1; s <= 3; s++) {
    repo.logSetByName({ date: DATE, exercise: "Pendlay Row", weight: 145, reps: 10, day_number: null });
  }
  for (let s = 1; s <= 2; s++) {
    repo.logSetByName({ date: DATE, exercise: "Barbell Bench Press", weight: 121.5, reps: 10, day_number: null });
  }
  repo.finishSession(prepared.session_id, null);

  const outcome = repo.getDailySessionOutcome(DATE);
  assert.equal(outcome.facts.dose_context.recovery, true, "a real recovery cycle still flags the day");
  const rowDose = doseFor(outcome, "Pendlay Row");
  const benchDose = doseFor(outcome, "Barbell Bench Press");
  assert.equal(rowDose.performed_at_full_load, true);
  assert.equal(rowDose.comparable, true, "full working load drops recovery_dose on this lift");
  assert.deepEqual(rowDose.non_comparable_reasons, []);
  assert.equal(benchDose.performed_at_full_load, false);
  assert.equal(benchDose.comparable, false, "meeting only the reduced dose is not full-load evidence");
  assert.ok(benchDose.non_comparable_reasons.includes("recovery_dose"));
});

test("a substitute with no plan-row sets does not grant full-load, even at recent working weight", () => {
  makeExercise("Barbell Bench Press", "chest");
  makeExercise("Dumbbell Bench Press", "chest");
  const history = addDaysISO(DATE, -7);
  for (let s = 1; s <= 3; s++) {
    repo.logSetByName({ date: history, exercise: "Dumbbell Bench Press", weight: 70, reps: 8, day_number: null });
  }
  // Another day's prescription must not become this session's full working load.
  repo.savePlanDay(2, "Push", "Accessories", [
    { exercise: "Dumbbell Bench Press", sets: 4, rep_low: 8, rep_high: 10, target_weight: 70 },
  ]);
  const cycle = repo.scheduleRecoveryCycle({
    effective_on: DATE,
    exit_on: addDaysISO(DATE, 7),
  });
  repo.activateRecoveryCycle(cycle.id, DATE);
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
  ]);
  const prepared = repo.prepareDailySession({ date: DATE, source: "manual_plan", day_number: 1 });
  const row = db
    .prepare(`SELECT items_json FROM daily_session_compositions WHERE session_id = ? AND status = 'active'`)
    .get(prepared.session_id);
  const swapped = JSON.parse(row.items_json).map((item) => ({
    ...item,
    exercise: "Dumbbell Bench Press",
    sets: 2,
    target_weight: 70,
  }));
  db.prepare(`UPDATE daily_session_compositions SET items_json = ? WHERE session_id = ? AND status = 'active'`).run(
    JSON.stringify(swapped),
    prepared.session_id
  );
  repo.logSetByName({ date: DATE, exercise: "Dumbbell Bench Press", weight: 70, reps: 8, day_number: null });
  repo.finishSession(prepared.session_id, null);

  const outcome = repo.getDailySessionOutcome(DATE);
  const dose = doseFor(outcome, "Dumbbell Bench Press");
  assert.equal(dose.full_load_reference.sets, null, "another day's prescription is not the full working load");
  assert.equal(dose.performed_at_full_load, false);
  assert.ok(
    dose.non_comparable_reasons.includes("recovery_dose"),
    "reduced-set substitute inside recovery stays recovery_dose"
  );
});

test("illness stays non-comparable even when the lift was performed at full load", () => {
  makeExercise("Barbell Bench Press", "chest");
  db.prepare(
    `INSERT INTO context_events (kind, title, start_date, end_date) VALUES ('illness', 'Cold', ?, ?)`
  ).run(DATE, DATE);
  const prepared = finishDay([{ exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 }]);
  for (let s = 1; s <= 3; s++) {
    repo.logSetByName({ date: DATE, exercise: "Barbell Bench Press", weight: 185, reps: 5, day_number: null });
  }
  repo.finishSession(prepared.session_id, null);

  const outcome = repo.getDailySessionOutcome(DATE);
  const dose = doseFor(outcome, "Barbell Bench Press");
  assert.equal(dose.performed_at_full_load, true);
  assert.equal(dose.comparable, false);
  assert.ok(dose.non_comparable_reasons.includes("illness"));
});

test("a run holds the squat and leaves the press alone", () => {
  makeExercise("Back Squat", "quads");
  makeExercise("Overhead Press", "shoulders");
  const prepared = finishDay([
    { exercise: "Back Squat", sets: 2, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Overhead Press", sets: 2, rep_low: 5, rep_high: 5, target_weight: 95 },
  ]);
  repo.addActivity({ date: DATE, type: "run", duration_min: 60, distance_km: 10 });
  for (let s = 1; s <= 2; s++) {
    repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
    repo.logSetByName({ date: DATE, exercise: "Overhead Press", weight: 95, reps: 5, day_number: null });
  }
  repo.finishSession(prepared.session_id, null);

  const outcome = repo.getDailySessionOutcome(DATE);
  assert.ok(outcome.facts.dose_context.non_comparable_reasons.includes("loaded_endurance"));
  assert.equal(doseFor(outcome, "Back Squat").comparable, false, "the run loaded the same legs");
  assert.deepEqual(doseFor(outcome, "Back Squat").non_comparable_reasons, ["loaded_endurance"]);
  assert.equal(doseFor(outcome, "Overhead Press").comparable, true, "a run does not invalidate the overhead press");
  assert.equal(outcome.facts.dose_context.endurance, true, "the day-level flag agrees with the scope it produced");
});

// The FLAG and the SCOPE come from one test. A prescribed shakeout the athlete
// completed is endurance that really happened, but it is not a dose on any muscle
// — so it must not raise a reason that then blocks nothing. Flag and scope
// disagreeing is how a confounder gets claimed and never honoured.
test("a completed light shakeout raises no endurance reason at all", () => {
  makeExercise("Back Squat", "quads");
  makeExercise("Overhead Press", "shoulders");
  const prepared = finishDay([
    { kind: "cardio", exercise: "Easy shakeout", target_duration_min: 22, target_distance_km: 3 },
    { exercise: "Back Squat", sets: 2, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Overhead Press", sets: 2, rep_low: 5, rep_high: 5, target_weight: 95 },
  ]);
  repo.addActivity({ date: DATE, type: "run", duration_min: 22, distance_km: 3 });
  for (let s = 1; s <= 2; s++) {
    repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
    repo.logSetByName({ date: DATE, exercise: "Overhead Press", weight: 95, reps: 5, day_number: null });
  }
  repo.finishSession(prepared.session_id, null);

  const outcome = repo.getDailySessionOutcome(DATE);
  assert.equal(outcome.facts.dose_context.endurance, false, "a shakeout loaded nothing worth guarding");
  assert.ok(
    !outcome.facts.dose_context.non_comparable_reasons.includes("loaded_endurance"),
    "a reason that can block no lift is not a reason"
  );
  assert.equal(doseFor(outcome, "Back Squat").comparable, true);
  assert.equal(doseFor(outcome, "Overhead Press").comparable, true);
});

// ===========================================================================
// BACKWARD COMPATIBILITY — a facts row written before the per-dose flag existed
// ===========================================================================

// A schema_version 2 outcome: session-level reasons only, per-dose achieved and
// prescribed sets, no per-dose comparability. This is what every live row looks
// like, and the engine has to derive the same verdict from it.
function linkLegacyOutcome(
  name,
  date,
  { reasons = [], prescribedSets = 3, achievedSets = 3, omitDoseContext = false } = {}
) {
  const exercise = repo.findExercise(name);
  const session = repo.getSessionByDate(date);
  db.prepare(`UPDATE sessions SET finished_at = datetime('now') WHERE id = ?`).run(session.id);
  const planDay = repo.getPlan().find((day) => day.items.some((item) => item.exercise === name));
  const item = planDay.items.find((entry) => entry.exercise === name);
  const composition = db
    .prepare(
      `INSERT INTO daily_session_compositions
        (version, session_id, date, source, status, plan_day_id, title, items_json, request_fingerprint)
       VALUES (1, ?, ?, 'adaptive_plan', 'active', ?, 'Legacy fixture', ?, ?)`
    )
    .run(
      session.id,
      date,
      planDay.id,
      JSON.stringify([
        {
          exercise: name,
          sets: prescribedSets,
          rep_low: item.rep_low,
          rep_high: item.rep_high,
          target_weight: item.target_weight,
        },
      ]),
      `legacy-${exercise.id}-${date}`
    );
  const facts = {
    schema_version: 2,
    confidence: "high",
    // A row from before dose_context existed at all carries none — the engine has
    // to read that as "no evidence of comparability", not as "comparable".
    ...(omitDoseContext
      ? {}
      : {
          dose_context: {
            partial: reasons.includes("partial"),
            comparable: reasons.length === 0,
            non_comparable_reasons: reasons,
          },
        }),
    dose_evidence: [
      {
        movement_key: `exercise:${exercise.id}`,
        intent_key: `strength:reps:${item.rep_low}-${item.rep_high}`,
        exercise: name,
        prescribed: { sets: prescribedSets },
        achieved: { sets: achievedSets },
        challenge_verdict:
          prescribedSets == null || achievedSets >= prescribedSets ? "met" : "under_prescribed",
      },
    ],
  };
  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'completed', ?)`
  ).run(composition.lastInsertRowid, session.id, date, JSON.stringify(facts));
}

test("an old facts row whose only marks are an override and an unrelated run still earns the step", () => {
  makeExercise("Overhead Press", "shoulders");
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Overhead Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 95 },
  ]);
  const date = isoDaysAgo(5);
  for (let s = 1; s <= 3; s++) logSet("Overhead Press", date, { weight: 95, reps: 5, rir: 2, setNum: s });
  repo.addActivity({ date, type: "run", duration_min: 60, distance_km: 10 });
  linkLegacyOutcome("Overhead Press", date, { reasons: ["athlete_override", "loaded_endurance"] });

  const p = nextPrescription("Overhead Press");
  assert.equal(p.dose_eligibility.reason, "full_comparable");
  assert.equal(p.action, "overload");
});

test("the same old row still holds a lift the run actually loaded", () => {
  makeExercise("Back Squat", "quads");
  repo.savePlanDay(1, "Legs", "Legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  const date = isoDaysAgo(5);
  for (let s = 1; s <= 3; s++) logSet("Back Squat", date, { weight: 225, reps: 5, rir: 2, setNum: s });
  repo.addActivity({ date, type: "run", duration_min: 60, distance_km: 10 });
  linkLegacyOutcome("Back Squat", date, { reasons: ["athlete_override", "loaded_endurance"] });

  const p = nextPrescription("Back Squat");
  assert.equal(p.dose_eligibility.reason, "non_comparable");
  assert.equal(p.action, "hold");
});

test("a plan-behind re-ground does not launder an endurance-overlap dose into comparable", () => {
  makeExercise("Back Squat", "quads");
  const prepared = finishDay(
    [{ exercise: "Back Squat", sets: 3, rep_low: 8, rep_high: 12, target_weight: 50 }],
    DATE
  );
  repo.addActivity({ date: DATE, type: "run", duration_min: 60, distance_km: 10 });
  for (let s = 1; s <= 3; s++) {
    repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 50, reps: 12, rir: 2, day_number: null });
  }
  repo.finishSession(prepared.session_id, null);

  const outcome = repo.getDailySessionOutcome(DATE);
  assert.equal(doseFor(outcome, "Back Squat").comparable, false, "the run loaded the same legs");
  assert.ok(doseFor(outcome, "Back Squat").non_comparable_reasons.includes("loaded_endurance"));
  assert.ok(
    doseFor(outcome, "Back Squat").challenge_verdict === "met" ||
      doseFor(outcome, "Back Squat").challenge_verdict === "exceeded",
    "the dose met its own snapshot — the carve-out would have fired on that alone"
  );

  db.prepare(`UPDATE plan_items SET target_weight = 27 WHERE exercise_id = ?`).run(repo.findExercise("Back Squat").id);

  const p = nextPrescription("Back Squat");
  assert.equal(p.reground, true, "the rewritten plan sits under the logged 50");
  assert.equal(p.dose_eligibility.eligible, false, "endurance overlap is not laundered into full comparable");
  assert.equal(p.dose_eligibility.reason, "non_comparable");
});

test("an old row whose own dose came in short is still held", () => {
  makeExercise("Barbell Row", "back");
  repo.savePlanDay(1, "Pull", "Pull", [
    { exercise: "Barbell Row", sets: 3, rep_low: 5, rep_high: 5, target_weight: 135 },
  ]);
  const date = isoDaysAgo(5);
  logSet("Barbell Row", date, { weight: 135, reps: 5, rir: 2 });
  linkLegacyOutcome("Barbell Row", date, { reasons: ["partial"], achievedSets: 1 });

  const p = nextPrescription("Barbell Row");
  assert.equal(p.dose_eligibility.reason, "partial");
  assert.equal(p.action, "hold");
});

// THE LIVE SHAPE. Every strength outcome on the Pi looks like this: an override
// (the athlete trained on a rest-suggested day) plus a session-wide `partial`
// earned by some OTHER movement on the day. Under the old session-wide gate this
// single row shape held a whole month of evidence out of the comparable set, and
// unblocking exactly it is why this change exists.
test("the live row shape — an override plus somebody else's shortfall — no longer blocks a completed lift", () => {
  makeExercise("Overhead Press", "shoulders");
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Overhead Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 95 },
  ]);
  const date = isoDaysAgo(5);
  for (let s = 1; s <= 3; s++) logSet("Overhead Press", date, { weight: 95, reps: 5, rir: 2, setNum: s });
  linkLegacyOutcome("Overhead Press", date, { reasons: ["athlete_override", "partial"] });

  const p = nextPrescription("Overhead Press");
  assert.equal(p.dose_eligibility.reason, "full_comparable", "this lift's own dose completed");
  assert.equal(p.action, "overload");
});

test("a legacy day-wide reason still holds every lift on the day", () => {
  const cases = [
    ["travel", "Barbell Row"],
    ["recovery_dose", "Barbell Curl"],
    ["some_reason_this_table_has_never_seen", "Lat Pulldown"],
  ];
  for (const [reason, name] of cases) {
    resetTables(
      "daily_session_outcomes",
      "daily_session_compositions",
      "logged_sets",
      "sessions",
      "plan_items",
      "plan_days",
      "exercises"
    );
    makeExercise(name, "back");
    repo.savePlanDay(1, "Pull", "Pull", [{ exercise: name, sets: 3, rep_low: 5, rep_high: 5, target_weight: 135 }]);
    const date = isoDaysAgo(5);
    for (let s = 1; s <= 3; s++) logSet(name, date, { weight: 135, reps: 5, rir: 2, setNum: s });
    linkLegacyOutcome(name, date, { reasons: [reason] });

    const p = nextPrescription(name);
    assert.equal(p.dose_eligibility.reason, "non_comparable", reason);
    assert.equal(p.action, "hold", reason);
  }
});

test("a legacy facts row with no dose_context at all is not evidence of comparability", () => {
  makeExercise("Barbell Row", "back");
  repo.savePlanDay(1, "Pull", "Pull", [
    { exercise: "Barbell Row", sets: 3, rep_low: 5, rep_high: 5, target_weight: 135 },
  ]);
  const date = isoDaysAgo(5);
  for (let s = 1; s <= 3; s++) logSet("Barbell Row", date, { weight: 135, reps: 5, rir: 2, setNum: s });
  linkLegacyOutcome("Barbell Row", date, { omitDoseContext: true });

  const p = nextPrescription("Barbell Row");
  assert.equal(p.dose_eligibility.reason, "non_comparable");
  assert.equal(p.action, "hold");
});

// Read time cannot see the session's skipped list — the write path consults it
// too — so a dose carrying no prescribed set count cannot PROVE it completed. It
// keeps the session's `partial` rather than dropping it.
test("a dose with no prescribed set count keeps the session's partial", () => {
  makeExercise("Barbell Row", "back");
  repo.savePlanDay(1, "Pull", "Pull", [
    { exercise: "Barbell Row", sets: 3, rep_low: 5, rep_high: 5, target_weight: 135 },
  ]);
  const date = isoDaysAgo(5);
  for (let s = 1; s <= 3; s++) logSet("Barbell Row", date, { weight: 135, reps: 5, rir: 2, setNum: s });
  linkLegacyOutcome("Barbell Row", date, { reasons: ["partial"], prescribedSets: null });

  const p = nextPrescription("Barbell Row");
  assert.equal(p.dose_eligibility.reason, "non_comparable");
  assert.equal(p.action, "hold");
});

// …and it never MANUFACTURES one: with nothing on the session saying the day came
// in short, an unprovable dose is simply an unprovable dose.
test("a dose with no prescribed set count on a clean day still earns the step", () => {
  makeExercise("Barbell Row", "back");
  repo.savePlanDay(1, "Pull", "Pull", [
    { exercise: "Barbell Row", sets: 3, rep_low: 5, rep_high: 5, target_weight: 135 },
  ]);
  const date = isoDaysAgo(5);
  for (let s = 1; s <= 3; s++) logSet("Barbell Row", date, { weight: 135, reps: 5, rir: 2, setNum: s });
  linkLegacyOutcome("Barbell Row", date, { reasons: ["athlete_override"], prescribedSets: null });

  const p = nextPrescription("Barbell Row");
  assert.equal(p.dose_eligibility.reason, "full_comparable");
  assert.equal(p.action, "overload");
});

// ===========================================================================
// THE ATHLETE'S STANDING DECLARATION — bounded authority, never over a floor
// ===========================================================================

function seedTopSetOnlyBench() {
  makeExercise("Barbell Bench Press", "chest");
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  const date = isoDaysAgo(4);
  logSet("Barbell Bench Press", date, { weight: 185, reps: 8, rir: 2, setNum: 1 });
  logSet("Barbell Bench Press", date, { weight: 185, reps: 7, rir: 2, setNum: 2 });
  logSet("Barbell Bench Press", date, { weight: 185, reps: 6, rir: 2, setNum: 3 });
}

test("a top set at the ceiling buys the step when the athlete has asked to be pushed", () => {
  seedTopSetOnlyBench();

  const steady = nextPrescription("Barbell Bench Press");
  assert.equal(steady.action, "hold", "ordinarily every set has to cap the range");
  assert.equal(steady.suggested.weight, 185);

  repo.setSettings({ training_drive: "push" });
  const push = nextPrescription("Barbell Bench Press");
  assert.equal(push.action, "overload");
  assert.equal(push.suggested.weight, 190);
  // Every phrasing in the set names the athlete's own ask ("asked to push" / "asked
  // for the harder read"); the word "push" itself is not in all of them.
  assert.match(push.why, /you asked/i, "the sentence owns why the step came early");
  assert.doesNotMatch(push.why, /every set/i, "…and never claims every set capped, because they did not");
  assert.equal(violatesReadingGrammar(push.why), null);
});

// A volume stretch still SPEAKS first. The declaration bought the step early, but
// what the athlete most needs to hear on an accumulation card is that the step is
// deliberately small and the volume is the point.
test("a volume stretch owns the sentence even when the declaration bought the step", () => {
  makeExercise("Barbell Bench Press", "chest");
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  const date = isoDaysAgo(4);
  // A clean rep ON TOP of the 6–8 range on the top set only — the saturated
  // ceiling a build stretch asks for, but nowhere near every set.
  logSet("Barbell Bench Press", date, { weight: 185, reps: 9, rir: 2, setNum: 1 });
  logSet("Barbell Bench Press", date, { weight: 185, reps: 7, rir: 2, setNum: 2 });
  logSet("Barbell Bench Press", date, { weight: 185, reps: 6, rir: 2, setNum: 3 });
  repo.setSettings({ training_drive: "push" });
  blocks.createBlock({ goal: "Build", focus: "strength", total_weeks: 6, week_index: 1 });

  const p = nextPrescription("Barbell Bench Press");
  assert.equal(p.block_phase, "accumulation");
  assert.equal(p.action, "overload", "the top set at the saturated ceiling bought the step");
  assert.equal(p.suggested.weight, 187.5, "…and the build stretch still paces it");
  assert.match(p.why, /volume|banks work|build stretch/i, "the phase speaks before the declaration does");
  assert.equal(violatesReadingGrammar(p.why), null);
});

test("the easy week is not something a declaration talks its way out of", () => {
  seedTopSetOnlyBench();
  repo.setSettings({ training_drive: "push" });
  blocks.createBlock({ goal: "Ease", focus: "strength", total_weeks: 6, week_index: 6 });

  const p = nextPrescription("Barbell Bench Press");
  assert.equal(p.block_phase, "deload");
  assert.equal(p.action, "hold");
  assert.equal(p.suggested.weight, 185, "an easy week adds nothing, however hard you asked");
});

test("push never reaches a safety floor — a smoked muscle still holds the step", () => {
  seedTopSetOnlyBench();
  repo.setSettings({ training_drive: "push" });
  const acute = new Map([
    [
      "chest",
      {
        group: "chest",
        band: "saturated",
        residual: 1.2,
        saturated: true,
        last_date: isoDaysAgo(1),
        days_ago: 1,
        source: "strength",
        activity: null,
        detail: "chest",
      },
    ],
  ]);

  const p = nextPrescription("Barbell Bench Press", undefined, { acute });
  assert.notEqual(p.action, "overload", "the acute gate is blind to what the athlete asked for");
  assert.equal(p.suggested.weight <= 185, true);
});

// ---- the day-wide fuel read, on a per-lift card -----------------------------

// A protective read that asks training to hold its aggression: enough logged
// intake at target, weight coming down, felt energy and performance both low.
function seedHoldAggressionFuel() {
  const day = (delta) => localDaysAgo(-delta);
  repo.setProfile({
    name: "Athlete",
    sex: "male",
    age: 36,
    height_cm: 183,
    weight_lb: 200,
    start_weight_lb: 210,
    start_date: day(-60),
    goal_weight_lb: 180,
    goal_mode: "lose",
    activity_factor: 1.5,
  });
  db.prepare(
    `INSERT INTO nutrition_targets (effective_date, target_kcal, protein_g, carbs_g, fat_g, source)
     VALUES (?, 2200, 175, 240, 70, 'test')`
  ).run(day(-30));
  for (let delta = -10; delta <= -1; delta++) {
    db.prepare(
      `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status) VALUES (?, 'meal', '', ?, NULL)`
    ).run(day(delta), JSON.stringify({ kcal: 2175, protein_g: 175 }));
  }
  for (const [delta, weight] of [[-10, 203], [-8, 202.4], [-6, 201.8], [-4, 201.2], [-1, 200.3]]) {
    repo.logWeight(weight, day(delta));
  }
  const source = db
    .prepare(`INSERT INTO garmin_sources (provider, mode, label) VALUES ('garmin', 'manual', 'drive-test')`)
    .run();
  db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, body_fat_pct) VALUES (?, ?, 18)`).run(
    source.lastInsertRowid,
    day(-1)
  );
  repo.addCheckin(day(-1), { mood: 3, energy: 1, sleep_feel: 1 });
  repo.addCheckin(day(-2), { mood: 3, energy: 1, sleep_feel: 1 });

  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  const ex = repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest" });
  for (const [delta, weight] of [[-28, 175], [-21, 180], [-10, 185]]) {
    const session = repo.getOrCreateSession(day(delta), null);
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, ?, 8, 2)`
    ).run(session.id, ex.id, weight);
  }
}

test("a soft fueling read no longer erases an earned step from someone who asked to be pushed", () => {
  seedHoldAggressionFuel();
  assert.equal(repo.currentUnderfuelingRead(localDateISO()).action.training, "hold_aggression");

  const steady = planDayProgression(1).find((item) => item.exercise === "Barbell Bench Press");
  assert.equal(steady.action, "hold", "ordinarily the protective read takes the step");
  // The fuel read is what changed THIS lift, so the card says so in the training
  // register — a whole fuel sentence of its own, never a clause glued onto
  // somebody else's explanation.
  assert.match(steady.why, /fuel/i, "a fuel-held lift names fueling as the reason");
  assert.equal(violatesReadingGrammar(steady.why), null);

  repo.setSettings({ training_drive: "push" });
  const push = planDayProgression(1).find((item) => item.exercise === "Barbell Bench Press");
  assert.equal(push.action, "overload", "the step the work earned stands");
  assert.equal(push.suggested.weight, 190);
  assert.equal(push.top_set, undefined, "…while the near-maximal single still waits");
});

test("a fueling read that only trims the near-maximal single still marks the lift as braked", () => {
  seedHoldAggressionFuel();
  repo.setSettings({ training_drive: "push" });
  // A peak week is where a near-maximal single actually gets prescribed, so it is
  // the case where the trim has something to take.
  blocks.createBlock({ goal: "Peak", focus: "peak", total_weeks: 3, week_index: 3 });

  const push = planDayProgression(1).find((item) => item.exercise === "Barbell Bench Press");
  assert.equal(push.action, "overload", "the step the work earned stands");
  assert.equal(push.top_set, undefined, "the near-maximal single is the piece that waits");
  assert.equal(push.autoregulated, true, "a surface asking 'did anything brake this?' has to see that it did");
  assert.equal(push.fuel_protected, undefined, "no volume came off, so the restore ledger is owed nothing");
  assert.match(push.why, /fuel/i);
  assert.equal(violatesReadingGrammar(push.why), null);
});

test("the day's fueling sentence stays off a lift the fueling read never touched", () => {
  seedHoldAggressionFuel();
  // A second lift with nothing logged holds for its OWN reason, so the day-wide
  // fueling clause has no business on its card.
  repo.savePlanDay(2, "Pull", "Back", [
    { exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
  ]);
  repo.upsertExercise({ name: "Barbell Row", muscle_group: "back" });

  const row = planDayProgression(2).find((item) => item.exercise === "Barbell Row");
  assert.equal(row.action, "hold");
  assert.doesNotMatch(row.why, /fuel/i, "the day's fueling state is not this lift's explanation");
});

// A stronger fuel signal: the correction has had its settling week and several
// channels still agree. That one reduces the dose whatever the athlete asked for.
function seedReduceFuel() {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.55,
    weight_lb: 196,
    start_weight_lb: 205,
    start_date: localDaysAgo(42),
    goal_mode: "lose",
    goal_weight_lb: 180,
  });
  repo.setNutritionTarget(
    { target_kcal: 2_200, protein_g: 175, effective_date: localDaysAgo(30), source: "test" },
    { preserveReviewedKcal: true }
  );
  // An upward correction that has had its full settling week and still has not
  // been answered — that is what makes the read a reduce rather than a hold.
  repo.setNutritionTarget(
    { target_kcal: 2_350, protein_g: 175, effective_date: localDaysAgo(7), source: "test" },
    { preserveReviewedKcal: true }
  );
  for (let daysAgo = 20; daysAgo >= 1; daysAgo--) {
    seedIntake(daysAgo, 2_100, { protein_g: 175 });
    if (daysAgo % 3 === 1 || daysAgo === 20 || daysAgo === 1) {
      seedWeight(localDaysAgo(daysAgo), 200 + (-2.6 / 7) * (20 - daysAgo));
    }
  }
  for (const [name, weights] of [
    ["Z Drive Press", [160, 155, 150, 145, 140, 135]],
    ["Z Drive Row", [180, 175, 170, 165, 160, 155]],
  ]) {
    const exercise = repo.upsertExercise({ name, muscle_group: "chest" });
    const days = [42, 32, 22, 12, 6, 2];
    for (let i = 0; i < days.length; i++) {
      const session = repo.getOrCreateSession(localDaysAgo(days[i]), null);
      db.prepare(
        `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, ?, 5, 2)`
      ).run(session.id, exercise.id, weights[i]);
    }
  }
  repo.addCheckin(localDaysAgo(3), { energy: 2 });
  repo.addCheckin(localDaysAgo(1), { energy: 2 });
}

test("the live-shaped outcome row drops a false recovery_dose under the repair transform", () => {
  const repaired = repairOutcomeComparability(liveShapedFacts(), { recovery: false });
  assert.equal(repaired.dose_context.recovery, false);
  assert.ok(!repaired.dose_context.non_comparable_reasons.includes("recovery_dose"));
  assert.equal(repaired.dose_evidence[0].comparable, true);
  assert.deepEqual(repaired.dose_evidence[0].non_comparable_reasons, []);
});

test("repair leaves schema-2 dose_evidence byte-identical and only clears a false recovery_dose on the session", () => {
  const facts = {
    schema_version: 2,
    skipped: ["Back Squat"],
    dose_context: {
      recovery: true,
      comparable: false,
      non_comparable_reasons: ["recovery_dose", "loaded_endurance", "partial"],
    },
    dose_evidence: [
      {
        exercise: "Back Squat",
        prescribed: { sets: 3 },
        achieved: { sets: 3 },
        challenge_verdict: "under_prescribed",
      },
    ],
  };
  const originalDoses = JSON.stringify(facts.dose_evidence);
  const repaired = repairOutcomeComparability(facts, { recovery: false });
  assert.equal(JSON.stringify(repaired.dose_evidence), originalDoses);
  assert.equal(repaired.schema_version, 2);
  assert.equal(repaired.dose_context.recovery, false);
  assert.ok(!repaired.dose_context.non_comparable_reasons.includes("recovery_dose"));
  assert.ok(repaired.dose_context.non_comparable_reasons.includes("loaded_endurance"));
  assert.equal(repaired.dose_evidence[0].comparable, undefined);
});

test("repair honors skipped on schema-3+ rows the same way the live write does", () => {
  const facts = {
    schema_version: 3,
    skipped: ["Back Squat"],
    dose_context: {
      recovery: false,
      partial: true,
      comparable: false,
      non_comparable_reasons: ["recovery_dose", "partial"],
    },
    dose_evidence: [
      {
        exercise: "Back Squat",
        prescribed: { sets: 3 },
        achieved: { sets: 3 },
        comparable: false,
        non_comparable_reasons: ["recovery_dose"],
      },
      {
        exercise: "Barbell Bench Press",
        prescribed: { sets: 3 },
        achieved: { sets: 3 },
        comparable: false,
        non_comparable_reasons: ["recovery_dose"],
      },
    ],
  };
  const repaired = repairOutcomeComparability(facts, { recovery: false });
  assert.equal(
    repaired.dose_evidence[0].comparable,
    false,
    "skipped is an own-dose shortfall even when sets look complete"
  );
  assert.ok(repaired.dose_evidence[0].non_comparable_reasons.includes("partial"));
  assert.equal(repaired.dose_evidence[1].comparable, true);
  assert.deepEqual(repaired.dose_evidence[1].non_comparable_reasons, []);
});

test("repair leaves travel in place when the row cannot prove the prescription was reduced", () => {
  const facts = {
    schema_version: 3,
    dose_context: {
      recovery: false,
      travel: true,
      comparable: false,
      non_comparable_reasons: ["travel"],
    },
    dose_evidence: [
      {
        exercise: "Pendlay Row",
        prescribed: { sets: 2, target_weight: 121.5 },
        achieved: { sets: 3, top_weight: 145 },
        comparable: false,
        non_comparable_reasons: ["travel"],
      },
    ],
  };
  const repaired = repairOutcomeComparability(facts, { recovery: false });
  assert.ok(repaired.dose_context.non_comparable_reasons.includes("travel"));
  assert.equal(repaired.dose_evidence[0].comparable, false);
  assert.deepEqual(repaired.dose_evidence[0].non_comparable_reasons, ["travel"]);
});

test("migration 97 repairs a live-shaped outcome and is idempotent", () => {
  const today = new Date().toISOString().slice(0, 10);
  const old = "2020-01-01";
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE daily_session_outcomes (
    id INTEGER PRIMARY KEY,
    composition_id INTEGER,
    session_id INTEGER,
    date TEXT,
    status TEXT,
    facts_json TEXT
  );`);
  d.exec(`CREATE TABLE recovery_cycles (
    id INTEGER PRIMARY KEY,
    status TEXT,
    effective_on TEXT,
    recheck_on TEXT,
    exit_on TEXT,
    overlay_json TEXT,
    completed_at TEXT,
    canceled_at TEXT
  );`);
  d.prepare(`INSERT INTO daily_session_outcomes (id, composition_id, session_id, date, status, facts_json)
             VALUES (1, 1, 1, ?, 'completed', ?)`).run(today, JSON.stringify(liveShapedFacts()));
  const keptDate = addDaysISO(today, -7);
  const keptExit = today;
  const kept = {
    schema_version: 3,
    dose_context: {
      recovery: true,
      comparable: false,
      non_comparable_reasons: ["recovery_dose"],
    },
    dose_evidence: [
      {
        exercise: "Back Squat",
        prescribed: { sets: 2, target_weight: 100 },
        achieved: { sets: 2, top_weight: 100 },
        comparable: false,
        non_comparable_reasons: ["recovery_dose"],
      },
    ],
  };
  d.prepare(`INSERT INTO daily_session_outcomes (id, composition_id, session_id, date, status, facts_json)
             VALUES (2, 2, 2, ?, 'completed', ?)`).run(keptDate, JSON.stringify(kept));
  d.prepare(
    `INSERT INTO recovery_cycles (id, status, effective_on, recheck_on, exit_on, overlay_json)
     VALUES (1, 'active', ?, ?, ?, '{}')`
  ).run(keptDate, keptDate, keptExit);
  d.prepare(`INSERT INTO daily_session_outcomes (id, composition_id, session_id, date, status, facts_json)
             VALUES (3, 3, 3, ?, 'completed', ?)`).run(old, JSON.stringify(liveShapedFacts()));
  d.exec("PRAGMA user_version = 96;");

  const first = runMigrations(d);
  assert.equal(first.from, 96);
  assert.ok(first.applied >= 1);
  assert.equal(
    Number(d.prepare("PRAGMA user_version").get().user_version),
    MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0)
  );

  const repaired = JSON.parse(d.prepare(`SELECT facts_json FROM daily_session_outcomes WHERE id = 1`).get().facts_json);
  assert.equal(repaired.dose_context.recovery, false);
  assert.equal(repaired.dose_evidence[0].comparable, true);
  assert.deepEqual(repaired.dose_evidence[0].non_comparable_reasons, []);

  const stillRecovery = JSON.parse(
    d.prepare(`SELECT facts_json FROM daily_session_outcomes WHERE id = 2`).get().facts_json
  );
  assert.equal(stillRecovery.dose_context.recovery, true);
  assert.ok(stillRecovery.dose_evidence[0].non_comparable_reasons.includes("recovery_dose"));

  const untouched = JSON.parse(d.prepare(`SELECT facts_json FROM daily_session_outcomes WHERE id = 3`).get().facts_json);
  assert.equal(untouched.dose_context.recovery, true, "rows older than 60 days are left alone");
  assert.ok(untouched.dose_evidence[0].non_comparable_reasons.includes("recovery_dose"));

  const m97 = MIGRATIONS.find((m) => m.version === 97);
  assert.ok(m97, "version 97 is the outcome-comparability repair");
  m97.up(d);
  m97.up(d);
  const again = JSON.parse(d.prepare(`SELECT facts_json FROM daily_session_outcomes WHERE id = 1`).get().facts_json);
  assert.equal(again.dose_evidence[0].comparable, true);
  d.close();
});

test("migration 97 leaves a schema-2 row's dose_evidence byte-identical", () => {
  const today = new Date().toISOString().slice(0, 10);
  const sv2 = {
    schema_version: 2,
    dose_context: {
      recovery: true,
      comparable: false,
      non_comparable_reasons: ["recovery_dose", "loaded_endurance"],
    },
    dose_evidence: [
      {
        exercise: "Pendlay Row",
        prescribed: { sets: 3 },
        achieved: { sets: 3 },
        challenge_verdict: "under_prescribed",
      },
    ],
  };
  const originalDoses = JSON.stringify(sv2.dose_evidence);
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE daily_session_outcomes (
    id INTEGER PRIMARY KEY,
    composition_id INTEGER,
    session_id INTEGER,
    date TEXT,
    status TEXT,
    facts_json TEXT
  );`);
  d.exec(`CREATE TABLE recovery_cycles (
    id INTEGER PRIMARY KEY,
    status TEXT,
    effective_on TEXT,
    recheck_on TEXT,
    exit_on TEXT,
    overlay_json TEXT,
    completed_at TEXT,
    canceled_at TEXT
  );`);
  d.prepare(`INSERT INTO daily_session_outcomes (id, composition_id, session_id, date, status, facts_json)
             VALUES (1, 1, 1, ?, 'completed', ?)`).run(today, JSON.stringify(sv2));
  d.exec("PRAGMA user_version = 96;");
  runMigrations(d);
  const repaired = JSON.parse(d.prepare(`SELECT facts_json FROM daily_session_outcomes WHERE id = 1`).get().facts_json);
  assert.equal(JSON.stringify(repaired.dose_evidence), originalDoses);
  assert.equal(repaired.schema_version, 2);
  assert.equal(repaired.dose_context.recovery, false);
  assert.ok(!repaired.dose_context.non_comparable_reasons.includes("recovery_dose"));
  assert.ok(repaired.dose_context.non_comparable_reasons.includes("loaded_endurance"));
  d.close();
});

function linkDoseFacts(date, facts) {
  const session = repo.getOrCreateSession(date, null);
  const composition = db
    .prepare(
      `INSERT INTO daily_session_compositions
        (version, session_id, date, source, status, title, items_json, request_fingerprint)
       VALUES (1, ?, ?, 'adaptive_plan', 'active', 'Schema fixture', '[]', ?)`
    )
    .run(session.id, date, `schema-${session.id}-${date}`);
  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'completed', ?)`
  ).run(composition.lastInsertRowid, session.id, date, JSON.stringify(facts));
  return session;
}

test("a schema-2 under-prescribed dose does not feed the comparable-shortfall arm", () => {
  const qualityShort = {
    exercise: "Back Squat",
    comparable: true,
    prescribed: { sets: 3 },
    achieved: { sets: 3 },
    challenge_verdict: "under_prescribed",
  };
  linkDoseFacts(addDaysISO(DATE, -3), {
    schema_version: 2,
    skipped: [],
    dose_context: { partial: false, comparable: true, non_comparable_reasons: [] },
    dose_evidence: [qualityShort],
  });
  assert.equal(
    countComparableDoseShortfallSessions(DATE, 14),
    0,
    "schema 2 never carried per-dose comparable — even a materialized flag is not this arm"
  );

  linkDoseFacts(addDaysISO(DATE, -2), {
    schema_version: 3,
    skipped: [],
    dose_context: { partial: false, comparable: true, non_comparable_reasons: [] },
    dose_evidence: [qualityShort],
  });
  assert.equal(
    countComparableDoseShortfallSessions(DATE, 14),
    1,
    "schema 3+ comparable under_prescribed still counts toward log-confirmed fatigue"
  );
});

test("the stronger fueling signal keeps its full effect however hard the athlete asked", () => {
  seedReduceFuel();
  assert.equal(repo.currentUnderfuelingRead(localDateISO()).action.training, "reduce");

  makeExercise("Barbell Bench Press", "chest");
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  for (let s = 1; s <= 3; s++) logSet("Barbell Bench Press", localDaysAgo(4), { weight: 185, reps: 8, rir: 2, setNum: s });

  repo.setSettings({ training_drive: "push" });
  const push = planDayProgression(1).find((item) => item.exercise === "Barbell Bench Press");
  assert.equal(push.action, "deload", "a reduce read is a lighter dose, not a step");
  assert.ok(push.suggested.weight < 185);
});
