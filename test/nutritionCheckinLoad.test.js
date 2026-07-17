// The adaptive-nutrition check-in sees acute training load (Wave B / B6). The meal-plan
// prompt already folds in fatigue/soreness; the retarget used to be blind to it, so a
// mileage/volume ramp never reached it. This pins that the acute-load note appears.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedTrainingDay, localDaysAgo } from "./_seed.js";
import { buildNutritionCheckinPrompt } from "../dist/prompt.js";

beforeEach(() => resetTables("sessions", "logged_sets", "exercises", "profile", "food_notes", "bodyweight_log", "daily_metrics", "activities", "garmin_activities"));

test("a high-soreness / fatigue signal reaches the nutrition check-in prompt", () => {
  // A logged session with high-soreness 1-tap feedback → an autoregulation note.
  const date = localDaysAgo(1);
  seedTrainingDay(date);
  repo.setSessionFeedback(date, { soreness: 5, joint_pain: "knee" });

  const prompt = buildNutritionCheckinPrompt();
  assert.match(prompt, /ACUTE TRAINING LOAD & FATIGUE/, "the check-in now carries the acute-load note");
  assert.match(prompt, /FUEL the work/i, "and frames a ramp as fuel-the-work, not a cut");
});

test("a clean athlete with no load signal gets no acute-load note", () => {
  const prompt = buildNutritionCheckinPrompt();
  assert.doesNotMatch(prompt, /ACUTE TRAINING LOAD & FATIGUE/, "quiet by default when there's nothing load-bearing");
});

// ── PART 4b: this week's whole aerobic load reaches the check-in ─────────────────
test("weeklyAerobicLoad aggregates runs + hikes across the current week", () => {
  const today = localDaysAgo(0);
  repo.addActivity({ type: "run", distance_km: 10, duration_min: 55, date: today });
  repo.addActivity({ type: "hike", distance_km: 8, duration_min: 95, date: today });
  const aero = repo.weeklyAerobicLoad();
  assert.equal(aero.outings, 2);
  assert.equal(aero.runs, 1);
  assert.equal(aero.hikes, 1);
  assert.equal(aero.km, 18);
  assert.equal(aero.longest_km, 10);
  assert.match(aero.in_words, /18 km over 2 outings/i);
});

test("a big aerobic week (runs + hikes) reaches the nutrition check-in prompt", () => {
  const today = localDaysAgo(0);
  repo.addActivity({ type: "run", distance_km: 10, duration_min: 55, date: today });
  repo.addActivity({ type: "hike", distance_km: 8, duration_min: 95, date: today });
  const prompt = buildNutritionCheckinPrompt();
  assert.match(prompt, /ACUTE TRAINING LOAD & FATIGUE/, "the whole aerobic week is load-bearing");
  assert.match(prompt, /aerobic load this week/i, "the aerobic-load line is present");
  assert.match(prompt, /FUEL the work/i, "and frames a big aerobic week as fuel-the-work, not a cut");
});

test("weeklyAerobicLoad is zeros / no line when there was no aerobic activity", () => {
  const aero = repo.weeklyAerobicLoad();
  assert.equal(aero.outings, 0);
  assert.equal(aero.longest_km, null);
  const prompt = buildNutritionCheckinPrompt();
  assert.doesNotMatch(prompt, /aerobic load this week/i, "quiet by default with no outings");
});

// ── PART 4b fix round: the aerobic line has a load-bearing FLOOR (a daily short stroll
// must not fire the FUEL-the-work section on every check-in).
test("a single short aerobic outing does NOT trigger the FUEL-the-work section", () => {
  const today = localDaysAgo(0);
  repo.addActivity({ type: "hike", duration_min: 40, distance_km: 4, date: today });
  const prompt = buildNutritionCheckinPrompt();
  assert.doesNotMatch(prompt, /aerobic load this week/i, "one short hike is below the load-bearing floor");
  assert.doesNotMatch(prompt, /ACUTE TRAINING LOAD & FATIGUE/, "and raises no acute-load section on its own");
});

test("a 3-outing aerobic week clears the load-bearing floor", () => {
  const today = localDaysAgo(0);
  for (let i = 0; i < 3; i++) repo.addActivity({ type: "hike", duration_min: 30, distance_km: 3, date: today });
  const prompt = buildNutritionCheckinPrompt();
  assert.match(prompt, /aerobic load this week/i, "≥3 outings is load-bearing");
});
