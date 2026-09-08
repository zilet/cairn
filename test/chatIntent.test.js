// The chat intent gates, tested directly against src/chat-intent.ts.
//
// These classifiers decide what ONE athlete sentence authorizes: whether a food line
// takes the agent-free receipt lane, whether a training edit carries the athlete's own
// word, whether a pain note may be opened or closed. They used to be buried in
// chatTurns.ts and were only ever reached through applyChatActions, so a change to a
// regex was verified through a database, a plan and a full action apply.
//
// Nothing here touches SQLite: the module imports no repo and no db, so every case is
// the pure input/output contract. The inputs are the ones the surrounding suites
// already assert (test/chatTurns.test.js, test/foodEatenAt.test.js,
// test/strengthJourney.test.js, test/trainingSymptomSurfaces.test.js,
// test/chatRunPrescription.test.js) — this file states them once, at the seam.
import test from "node:test";
import assert from "node:assert/strict";
import {
  hasExplicitGoalIntent,
  hasExplicitGoalIntentInContext,
  hasExplicitPlanEditIntent,
  hasExplicitRunEditIntent,
  hasExplicitStrengthObjectiveIntent,
  hasExplicitSymptomReportIntent,
  hasExplicitSymptomResolveIntent,
  isFoodOnlyTurn,
  isInstantFoodCaptureDecision,
  isLeadingQuestion,
  mentionsWhen,
  shouldCreatePhotoFoodPlaceholder,
} from "../dist/chat-intent.js";
import { classifyChatRoute } from "../dist/chatRouting.js";

// Table-driven: [input, expected, note?]
function table(fn, cases) {
  for (const [input, expected, note] of cases) {
    assert.equal(fn(input), expected, note ?? JSON.stringify(input));
  }
}

test("mentionsWhen finds a time reference without parsing it", () => {
  table(mentionsWhen, [
    ["I had a late dinner last night around 9", true],
    ["ate a burrito yesterday at 8", true],
    ["had eggs this morning", true],
    ["ate 2 eggs and toast", false, "a food quantity places nothing in time"],
    ["had a protein shake", false],
    ["log 200g chicken", false],
  ]);
});

test("isInstantFoodCaptureDecision keeps a timed meal out of the agent-free lane", () => {
  const decide = (message) => isInstantFoodCaptureDecision(classifyChatRoute({ message, has_image: false }), message);
  table(decide, [
    ["log a protein shake", true, "a bare receipt needs no model"],
    ["I had a late dinner last night around 9", false, "a meal placed in time must reach the agent"],
    ["had lunch yesterday", false],
  ]);
});

test("shouldCreatePhotoFoodPlaceholder waits for vision unless the words say food", () => {
  table(shouldCreatePhotoFoodPlaceholder, [
    ["", false, "photo-only waits for a vision log_food decision"],
    ["Lunch plate for today", true],
    ["look at the physique check-in", false],
  ]);
});

test("isFoodOnlyTurn releases the turn to coaching when a training signal rides along", () => {
  assert.equal(isFoodOnlyTurn("chicken and rice for lunch"), true);
  assert.equal(isFoodOnlyTurn("", "/uploads/plate.jpg"), true, "a photo alone is a food turn");
  assert.equal(isFoodOnlyTurn("chicken and rice, but my knee is sore"), false);
  assert.equal(isFoodOnlyTurn("bench felt heavy today"), false);
});

test("hasExplicitGoalIntent reads a stated destination, never a question", () => {
  table(hasExplicitGoalIntent, [
    ["Let's get down to 154 lbs by October 20.", true],
    ["I'd like to drop to 154 lb before the trip", true],
    ["Locking in 154 lb by October 20th", true],
    ["My goal is 154 lb", true],
    ["Should I get down to 154 lbs?", false],
    ["154 by October 20th, then", false, "a refinement alone fails the per-message gate"],
  ]);
});

test("hasExplicitGoalIntentInContext carries the athlete's own earlier statement forward", () => {
  const negotiated = ["I want to get down to 154 lbs by end of September.", "Fair — what timeline is safe?"];
  assert.equal(hasExplicitGoalIntentInContext("154 by October 20th, then", negotiated), true);
  assert.equal(hasExplicitGoalIntentInContext("okay, let's lock that in", negotiated), true);
  assert.equal(hasExplicitGoalIntentInContext("ok sounds good", ["how was the run?"]), false);
  assert.equal(hasExplicitGoalIntentInContext("should I really change my goal?", negotiated), false);
});

test("hasExplicitStrengthObjectiveIntent needs a named lift and a chosen destination", () => {
  table(hasExplicitStrengthObjectiveIntent, [
    ["I want to get my Barbell Bench Press back to my personal best.", true],
    ["What should my bench target be while I get back into lifting?", false],
  ]);
});

test("isLeadingQuestion is the one question guard the training-edit gates share", () => {
  table(isLeadingQuestion, [
    ["Can you make tomorrow's run 8k?", true],
    ["Will you make tomorrow's session easier?", true],
    ["Make tomorrow's run 8k.", false],
    ["Change my plan, ok?", false, "a trailing question mark is not a leading interrogative"],
  ]);
});

test("hasExplicitPlanEditIntent separates a command from a question", () => {
  table(hasExplicitPlanEditIntent, [
    ["remove Incline Bench", true],
    ["skip the run", true],
    ["make today optimal", true],
    ["Change my plan, ok?", true],
    ["My bench felt easy today", false, "a training signal alone still obeys surprise policy"],
    ["What should I change about my squat?", false],
    ["Will you make tomorrow's session easier?", false],
  ]);
});

test("hasExplicitRunEditIntent keeps its own vocabulary behind the shared question guard", () => {
  table(hasExplicitRunEditIntent, [
    ["Drop Thursday's tempo to 6k", true],
    ["Make tomorrow's run 8k.", true],
    ["Should I make tomorrow's run 8k?", false],
    ["Would you make tomorrow's run 8k?", false],
    ["My knee hurt on today's run.", false],
  ]);
});

test("hasExplicitSymptomReportIntent opens a pain note only when asked to record one", () => {
  table(hasExplicitSymptomReportIntent, [
    ["Could you log my left knee pain?", true],
    ["Please record that my knee still hurts.", true],
    ["My left knee hurts during squats.", false, "mentioning pain is not mutation authority"],
  ]);
});

test("hasExplicitSymptomResolveIntent closes a note only on the athlete's word", () => {
  table(hasExplicitSymptomResolveIntent, [
    ["Close the knee note, it's fine now.", true],
    ["My left knee is healed, mark it resolved.", true],
    ["The shoulder pain is gone.", true],
    ["My knee feels alright lately.", false],
    ["Is my knee note resolved?", false],
    ["Don't close the knee note yet.", false],
  ]);
});
