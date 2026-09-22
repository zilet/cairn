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
  carriesPlanApplyAffirmation,
  draftsSessionPrescription,
  hasExplicitGoalIntent,
  hasExplicitGoalIntentInContext,
  hasExplicitPlanEditIntent,
  hasExplicitPlanEditIntentInContext,
  hasExplicitRunEditIntent,
  hasExplicitStrengthObjectiveIntent,
  hasExplicitSymptomReportIntent,
  hasExplicitSymptomResolveIntent,
  hasSelfContainedPlanEditIntent,
  isFoodOnlyTurn,
  isInstantFoodCaptureDecision,
  isLeadingQuestion,
  mentionsWhen,
  readsAsSessionProposal,
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
    ["Let's get down to 170 lbs by October 20.", true],
    ["I'd like to drop to 170 lb before the trip", true],
    ["Locking in 170 lb by October 20th", true],
    ["My goal is 170 lb", true],
    ["Should I get down to 170 lbs?", false],
    ["170 by October 20th, then", false, "a refinement alone fails the per-message gate"],
  ]);
});

test("hasExplicitGoalIntentInContext carries the athlete's own earlier statement forward", () => {
  const negotiated = ["I want to get down to 170 lbs by end of September.", "Fair — what timeline is safe?"];
  assert.equal(hasExplicitGoalIntentInContext("170 by October 20th, then", negotiated), true);
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

// 2026-09-17, live: the athlete designed today's session with the coach over several
// turns and then wrote the sentence below. None of "apply", "go with", "lock in" or
// "do it" were verbs here, so the ask read as a background signal, the change was
// scheduled onto the NEXT day's template, and today's session never moved.
test("hasExplicitPlanEditIntent hears the athlete's apply words", () => {
  table(hasExplicitPlanEditIntent, [
    ["Ok apply it to my program for today. .I am heading to the gym now", true, "the live 2026-09-17 instruction"],
    ["apply it", true],
    ["go with that", true],
    ["lock it in", true],
    ["do it", true],
    ["go ahead", true],
    ["let's do it", true],
    ["implement that session", true],
    ["use 135 on today's bench", true],
    ["use this for today's session", true],
    ["Should I apply it today?", false, "a leading question is still a conversation"],
    ["what sets should I do", false],
    ["my set felt heavy", false, "reporting a set is not an instruction"],
    ["that load was brutal today", false],
  ]);
});

// 2026-09-17 review. The apply verbs are also the ordinary English of talking ABOUT a
// session that already happened: "use" took the bare pronoun that put/set/load were
// deliberately denied, and nothing disqualified a clause in the past tense, so a report
// read as an instruction.
test("hasExplicitPlanEditIntent never reads a session report as an instruction", () => {
  table(hasExplicitPlanEditIntent, [
    ["I use that machine a lot, it feels better than the barbell", false, "a preference is not an edit"],
    ["That was brutal. I had to use it with less weight.", false, "past tense is narration"],
    ["I used the machine for today's session", false, "a plan noun does not rescue a past-tense clause"],
    ["Can you use it today?", false, "a leading question authorizes nothing"],
    ["use this for today", true, "imperative, plan object, present tense"],
    ["let's use it today", true],
    ["put that in my plan", true],
  ]);
});

test("hasSelfContainedPlanEditIntent separates a named instruction from a bare go-ahead", () => {
  table(hasSelfContainedPlanEditIntent, [
    ["Ok apply it to my program for today. .I am heading to the gym now", true],
    ["remove Incline Bench", true],
    ["implement that session", true],
    ["apply it", false, "what it applies to lives in the coach's message"],
    ["go ahead", false],
    ["ok", false],
  ]);
});

test("carriesPlanApplyAffirmation needs an apply phrase, never sentiment alone", () => {
  table(carriesPlanApplyAffirmation, [
    ["ok apply it", true],
    ["apply it", true],
    ["go ahead", true],
    ["do it", true],
    ["let's do it", true],
    ["lock it in", true],
    ["yes, go with that", true],
    ["sounds good, apply", true],
    ["that works, set it up", true],
    ["ok", false, "a bare affirmative agrees with nothing in particular"],
    ["great", false],
    ["ok thanks", false],
    ["sounds good", false],
    ["yeah that was rough", false, "sentiment about a finished session is not consent"],
    ["great, I felt strong on it", false],
    ["ok but not the deadlift", false, "a reversal is not a go-ahead"],
    ["apply it?", false, "a question is never consent"],
    ["apply it later", false],
    ["the bench felt heavy", false],
  ]);
});

test("draftsSessionPrescription needs two prescription lines, not one number in prose", () => {
  table(draftsSessionPrescription, [
    ["Deadlift 3×5 @ 165\nSplit squat 2x10–12", true],
    ["Deadlift 3 × 8–10\nCalf raise 3x12\nPlank 3x30", true],
    ["Deadlift 3×5 @ 165", false, "one line is a mention, not a session"],
    ["Your bench went 3x5 last week and it felt fine.", false],
    ["", false],
  ]);
});

// Prescription lines alone are how the coach describes ANY day, including the one just
// finished — so a read-back plus "ok, thanks" used to satisfy the go-ahead path. A
// proposal also has to FRAME the lines as something not yet done.
test("readsAsSessionProposal separates a proposal from a read-back", () => {
  const proposal = "Here's today's Lower B:\n- Deadlift 3×5 @ 165\n- Split squat 2x10–12\n- Calf raise 3 × 12";
  const readBack = "Here's what you did today:\n- Deadlift 3×5 @ 165\n- Split squat 2x10–12\nYou logged all of it.";
  const plainLines = "Deadlift 3×5 @ 165\nSplit squat 2x10–12\nCalf raise 3 × 12";
  const question = "Want me to apply this?\n- Deadlift 3×5 @ 165\n- Split squat 2x10–12";
  table(readsAsSessionProposal, [
    [proposal, true],
    [question, true],
    [readBack, false, "a session already logged is nothing to agree to"],
    [plainLines, false, "lines with no frame describe a day, they do not offer one"],
    ["Here's today's Lower B: Deadlift 3×5 @ 165", false, "one line is a mention, not a session"],
    ["", false],
  ]);
});

test("hasExplicitPlanEditIntentInContext needs BOTH an apply phrase and a proposal", () => {
  const proposal = "Here's today's Lower B:\n- Deadlift 3×5 @ 165\n- Split squat 2x10–12\n- Calf raise 3 × 12";
  const readBack = "Here's what you did today:\n- Deadlift 3×5 @ 165\n- Split squat 2x10–12\nYou logged all of it.";
  const chat = "Nice work today — how did the run feel?";
  assert.equal(hasExplicitPlanEditIntentInContext("ok apply it", proposal), true);
  assert.equal(hasExplicitPlanEditIntentInContext("go ahead", proposal), true);
  assert.equal(hasExplicitPlanEditIntentInContext("ok thanks", proposal), false, "sentiment is not a go-ahead");
  assert.equal(hasExplicitPlanEditIntentInContext("ok", proposal), false);
  assert.equal(
    hasExplicitPlanEditIntentInContext("ok apply it", readBack),
    false,
    "there is nothing to apply in a session already logged"
  );
  assert.equal(
    hasExplicitPlanEditIntentInContext("ok apply it", chat),
    false,
    "a go-ahead needs something to go ahead with"
  );
  assert.equal(
    hasExplicitPlanEditIntentInContext("ok apply it", null, true),
    true,
    "the prior turn stored a plan draft"
  );
  assert.equal(hasExplicitPlanEditIntentInContext("ok", null, true), false, "a stored draft is still not consent");
  assert.equal(hasExplicitPlanEditIntentInContext("what about tomorrow?", proposal), false);
  assert.equal(
    hasExplicitPlanEditIntentInContext("Ok apply it to my program for today. .I am heading to the gym now", chat),
    true,
    "a sentence that names its own instruction needs no context at all"
  );
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
