import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { runUnderfuelingControlLoop } from "../dist/domain/brain/underfueling-service.js";

const today = () => localDateISO();
const day = (delta) => addDaysISO(today(), delta);

function seedCoherentPrescriptionStrain() {
  repo.setSettings({ lead_mode: "lead", proactive_enabled: true });
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
     VALUES (?, 2200, 175, 240, 70, 'test')`,
  ).run(day(-30));
  for (let delta = -10; delta <= -1; delta++) {
    db.prepare(
      `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status)
       VALUES (?, 'meal', '', ?, NULL)`,
    ).run(day(delta), JSON.stringify({ kcal: 2175, protein_g: 175 }));
  }
  for (const [delta, weight] of [[-10, 203], [-8, 202.4], [-6, 201.8], [-4, 201.2], [-1, 200.3]]) {
    repo.logWeight(weight, day(delta));
  }
  const source = db.prepare(
    `INSERT INTO garmin_sources (provider, mode, label) VALUES ('garmin', 'manual', 'coherence-test')`,
  ).run();
  db.prepare(
    `INSERT INTO garmin_daily_metrics (source_id, date, body_fat_pct) VALUES (?, ?, 18)`,
  ).run(source.lastInsertRowid, day(-1));
  repo.addCheckin(day(-1), { mood: 3, energy: 1, sleep_feel: 1 });
  repo.addCheckin(day(-2), { mood: 3, energy: 1, sleep_feel: 1 });

  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  const ex = repo.findExercise("Barbell Bench Press");
  for (const [delta, weight] of [[-28, 175], [-21, 180], [-10, 185]]) {
    const session = repo.getOrCreateSession(day(delta), null);
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir)
       VALUES (?, ?, 1, ?, 8, 2)`,
    ).run(session.id, ex.id, weight);
  }
}

test("Brief, controller, progression, and Journey share one hydrated protective fuel read", () => {
  seedCoherentPrescriptionStrain();
  const current = repo.currentUnderfuelingRead(today());
  assert.equal(current.state, "prescription_strain");
  assert.equal(current.action.training, "hold_aggression");

  const controlled = runUnderfuelingControlLoop(today(), { read: current });
  assert.equal(controlled.read.signature, current.signature);
  assert.equal(controlled.action, "nutrition_correction_scheduled");

  const brief = repo.dayRead(today());
  assert.equal(brief.signals.underfueling.state, "prescription_strain");
  assert.equal(brief.signals.signal_state.action.directives.training, "hold_aggression");
  assert.doesNotMatch(brief.why, /good to go|good to train/i);

  const progression = repo.planDayProgression(1).find((item) => item.exercise === "Barbell Bench Press");
  assert.equal(progression.action, "hold", "earned overload cannot contradict the protective fuel read");
  assert.match(progression.why, /fuel|hold this progression/i);

  const journey = repo.journeyRead(today());
  assert.equal(journey.underfueling.state, "prescription_strain");
  assert.equal(journey.underfueling.action.training, "hold_aggression");
});

test("explicit null snapshot dependencies are terminal unknowns and never trigger hidden retries", () => {
  seedCoherentPrescriptionStrain();
  const read = repo.currentUnderfuelingRead(today(), {
    expenditure: null,
    goal: null,
    programState: null,
    wholePerson: null,
  });
  assert.equal(read.channels.find((channel) => channel.key === "weight_trend").direction, "unknown");
  assert.equal(read.channels.find((channel) => channel.key === "performance").direction, "unknown");
  assert.notEqual(read.state, "prescription_strain", "the provider did not silently recompute the unavailable dependencies");
});

test("a same-sum fueling upsert refreshes every surface without erasing independent recovery strain", () => {
  seedCoherentPrescriptionStrain();
  db.prepare(`UPDATE checkins SET energy = NULL`).run();
  repo.setFuelingFeedback(day(-1), { energy: 1, hunger: 3 });
  repo.setFuelingFeedback(day(-2), { energy: 1, hunger: 3 });

  const before = repo.currentUnderfuelingRead(today());
  assert.equal(before.state, "prescription_strain");
  assert.equal(before.channels.find((channel) => channel.key === "felt_energy").direction, "strain");
  assert.equal(repo.dayRead(today()).signals.underfueling.signature, before.signature);
  assert.equal(repo.journeyRead(today()).underfueling.signature, before.signature);
  assert.equal(repo.planDayProgression(1).find((item) => item.exercise === "Barbell Bench Press").action, "hold");
  assert.equal(runUnderfuelingControlLoop(today()).read.signature, before.signature);
  repo.saveDayRead(today(), { kind: "train", headline: "Cached before flip", focus: "Push", signals: { underfueling: before } });
  assert.ok(repo.getCachedDayRead(today()));

  // The row id, count, and energy+hunger SUM all remain unchanged. Only a real
  // write-version invalidation can distinguish this correction.
  repo.setFuelingFeedback(day(-1), { energy: 3, hunger: 1 });
  assert.equal(repo.getCachedDayRead(today()), null, "today's persisted Brief is invalidated by a recent feedback correction");
  const after = repo.currentUnderfuelingRead(today());
  assert.notEqual(after.signature, before.signature);
  assert.equal(after.state, "prescription_strain", "weight plus fresh recovery response still corroborate protection");
  assert.equal(after.channels.find((channel) => channel.key === "felt_energy").direction, "unknown");
  assert.equal(repo.dayRead(today()).signals.underfueling.signature, after.signature);
  assert.equal(repo.journeyRead(today()).underfueling.signature, after.signature);
  assert.equal(repo.planDayProgression(1).find((item) => item.exercise === "Barbell Bench Press").action, "hold");
  assert.equal(runUnderfuelingControlLoop(today()).read.signature, after.signature);
});
