// The instant-capture lane's precision/recall, pinned. The lane writes a food note and
// answers "Logged your <meal>" with NO agent reading the sentence, so it must take only a
// sentence that stands alone and is plainly one food log. Rows are real-shaped messages from
// four months of production chat; each names the lane and whether the receipt-only lane
// may take it. `recent` = a food note was captured in the last few hours.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyChatRoute } from "../dist/chatRouting.js";
import { isInstantFoodCaptureDecision } from "../dist/chat-intent.js";

const TABLE = [
  // [message, lane, instant, { recent?, reason? }]
  // ---- hard positives: unambiguous logs stay on the cheap, outage-proof lane
  ["Log 100g watermelon", "capture", true],
  ["Log lunch 180g salmon, 150g rice and broccoli", "capture", true],
  ["I had a block of Lindt and a pour over coffee", "capture", true],
  ["ok log my dinner 204 g shrimp with rice", "capture", true],
  ["I had pizza for dinner", "capture", true],
  ["I had pizza for dinner", "capture", true, { recent: true }],
  ["I ate chicken, rice, and broccoli", "capture", true],
  ["I ate 3 eggs and toast", "capture", true],
  ["Log food: flat white and a banana", "capture", true],
  ["Log food: oats 60 g, whole milk 250 ml, banana 1 medium, almonds 20 g", "capture", true],
  ["Add a protein shake: 30g protein", "capture", true],
  ["Log: oatmeal, berries, yogurt for breakfast", "capture", true],
  ["had a protein shake", "capture", true],
  ["I had an energy gel", "capture", true],
  ["Add banana and 3 strawberries", "capture", true], // nothing recent: a new note is right
  ["had a banana", "capture", true],
  ["Log lunch: chicken, rice, and broccoli", "capture", true, { recent: true }],
  // ---- continuations right after a capture amend that meal, never a new note
  ["Add banana and 3 strawberries", "capture", false, { recent: true, reason: "capture_correction" }],
  ["And add like 30g more pasta", "capture", false, { recent: true, reason: "capture_correction" }],
  ["add 1/4 pear and 1/4 peach to snack", "capture", false, { recent: true, reason: "capture_correction" }],
  [
    "oh and I had 40g of avocado on the plate as well",
    "capture",
    false,
    { recent: true, reason: "capture_correction" },
  ],
  ["diiner - I added about 30g more chicken wings", "capture", false, { recent: true, reason: "capture_correction" }],
  ["I had 75g of it", "capture", false, { recent: true, reason: "capture_correction" }],
  ["No not the snack. This is lunch", "capture", false, { recent: true, reason: "capture_correction" }],
  [
    "This is more a treat. I moved out most of the sauce",
    "capture",
    false,
    { recent: true, reason: "capture_correction" },
  ],
  // ---- needs the previous turn: never instant, with or without a recent capture
  ["I had 75g of it", "capture", false],
  ["I had my usual", "capture", false],
  ["I had the same as yesterday", "capture", false],
  ["No not the snack. This is lunch, chicken and rice", "coach", false], // nothing recent to amend,
  // ---- two meals in one message go to the agent (it can emit two log_food)
  ["morning snack: apple and almonds\nbreakfast: 2 eggs and toast", "capture", false],
  ["Breakfast - oats and banana. Snack - yogurt", "capture", false],
  // ---- the eaten time is the agent's to read
  ["I had a late dinner last night around 9", "capture", false],
  ["had eggs this morning at 6:30", "capture", false],
  ["ate a sandwich 2 hours ago", "capture", false],
  ["had a banana at 7", "capture", false],
  ["I had oats around 9pm", "capture", false],
  ["had a sandwich half an hour ago", "capture", false],
  // ---- a "had" with no food: the coach lane, not a logged lunch
  ["I had a great run", "coach", false],
  ["had a rough night, only slept 5 hours", "coach", false],
  ["I had a good session today", "coach", false],
  ["I had a call with my doctor about my knee", "deep", false],
  // ---- eating nothing is not eating
  ["I had no lunch, was in meetings", "coach", false],
  ["I had nothing for breakfast", "coach", false],
  ["I didn't have breakfast", "coach", false],
  ["skipped lunch today", "coach", false],
  // ---- negation is per clause: one skipped meal does not hide the one that was eaten
  ["Skipped breakfast but had eggs and toast", "capture", false],
  ["skipped lunch, had a banana", "capture", false],
  ["I skipped lunch and was in meetings", "coach", false],
  // ---- a count of events is not a meal; a count of food is
  ["I had two meetings", "coach", false],
  ["had three meetings today", "coach", false],
  ["I had a couple of calls this morning", "coach", false],
  ["had two eggs", "capture", true],
  ["ate two slices", "capture", true],
  ["I had 3 eggs", "capture", true],
  // ---- questions and narratives keep the coach
  ["what did I eat for lunch?", "coach", false],
  ["I had a steak and felt flat on the run", "coach", false],
  ["why did my pace drop after the steak I ate?", "coach", false],
  // ---- other domains
  ["I ran 5 miles this morning", "capture", false],
  ["I weighed 172.4 this morning", "capture", false],
  ["I took 5g creatine", "capture", false],
];

for (const [message, lane, instant, opts = {}] of TABLE) {
  test(`${JSON.stringify(message.slice(0, 60))}${opts.recent ? " (recent capture)" : ""} -> ${lane}${instant ? " instant" : ""}`, () => {
    const decision = classifyChatRoute({ message, recent_food_capture: opts.recent === true });
    assert.equal(decision.lane, lane, JSON.stringify(decision));
    assert.equal(isInstantFoodCaptureDecision(decision, message), instant, JSON.stringify(decision));
    if (opts.reason) assert.ok(decision.reason_codes.includes(opts.reason), JSON.stringify(decision));
  });
}

test("the table is wide enough to pin precision and recall", () => {
  assert.ok(TABLE.length >= 40);
  assert.ok(TABLE.filter((r) => r[2]).length >= 10, "enough hard positives");
  assert.ok(TABLE.filter((r) => !r[2]).length >= 25, "enough hard negatives");
});
