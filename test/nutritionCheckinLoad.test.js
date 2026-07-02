// The adaptive-nutrition check-in sees acute training load (Wave B / B6). The meal-plan
// prompt already folds in fatigue/soreness; the retarget used to be blind to it, so a
// mileage/volume ramp never reached it. This pins that the acute-load note appears.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedTrainingDay, localDaysAgo } from "./_seed.js";
import { buildNutritionCheckinPrompt } from "../dist/prompt.js";

beforeEach(() => resetTables("sessions", "logged_sets", "exercises", "profile", "food_notes", "bodyweight_log", "daily_metrics"));

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
