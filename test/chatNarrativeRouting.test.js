// The routing decision matrix for the failure of 2026-10-16: a training narrative that
// mentions food ("the big steak that I had") was filed as a snack with no reply.
// Each row is a real or realistic athlete message; the matrix pins the lane, whether
// the receipt-only instant lane may take it, and the effort the lane asks for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyChatRoute, resolveChatProfile } from "../dist/chatRouting.js";
import { isInstantFoodCaptureDecision } from "../dist/chat-intent.js";

const MATRIX = [
  // [message, lane, instant, reasoning]
  [
    "no tomorrow is rest day.. today it was pretty conversational. just did it in the afternoon 2 hours after the big steak that I had and I felt the staek and was loosing some energy at the pace below 8 per mile .. but overall felt good, conversational at all times.",
    "coach", false, "medium",
  ],
  ["why did my pace drop after the steak I ate?", "coach", false, "medium"],
  ["I felt tired after the run I did yesterday", "coach", false, "medium"],
  ["Had a big dinner and felt sluggish on the bike after", "coach", false, "medium"],
  ["I ate a huge lunch, is that why my legs felt heavy?", "coach", false, "medium"],
  // Genuine logs keep the cheap path.
  ["I had a big steak at lunch", "capture", true, "low"],
  ["I ate chicken, rice, and broccoli", "capture", true, "low"],
  ["Add a protein shake: 30g protein", "capture", true, "low"],
  ["Log: oatmeal, berries, yogurt for breakfast", "capture", true, "low"],
  ["Log food: flat white and a banana", "capture", true, "low"],
  ["Log food: oats 60 g, whole milk 250 ml, banana 1 medium, almonds 20 g, honey 1 tbsp, whey 30 g, blueberries 80 g, chia 10 g, cinnamon, coffee black, water", "capture", true, "low"],
  // Cheap logs that share a word with the narrative cues stay cheap (grok review).
  ["Log food: had a flat white", "capture", true, "low"],
  ["I had an energy gel", "capture", true, "low"],
  ["Log food: feel-good smoothie", "capture", true, "low"],
  ["I ate 3 eggs and toast", "capture", true, "low"],
  // Placed in time: a remembering, so the agent reads it (capture lane, not instant).
  ["I had a steak today around 2", "capture", false, "low"],
  ["had a banana 2 hours after the run", "capture", false, "low"],
  // Quick request is honored.
  ["quickly: how much protein is left today?", "coach", false, "low"],
];

for (const [message, lane, instant, reasoning] of MATRIX) {
  test(`routes "${message.slice(0, 48)}…" → ${lane}${instant ? " (instant)" : ""} @ ${reasoning}`, () => {
    const decision = classifyChatRoute({ message });
    assert.equal(decision.lane, lane, JSON.stringify(decision));
    assert.equal(isInstantFoodCaptureDecision(decision, message), instant);
    assert.equal(resolveChatProfile(decision.lane, "claude", {}, null, decision.reason_codes).reasoning, reasoning);
  });
}

test("a narrative keeps its capture reason so the coach lane can still log a meal it names", () => {
  const decision = classifyChatRoute({ message: "I had a steak and felt flat on the run" });
  assert.equal(decision.lane, "coach");
  assert.ok(decision.reason_codes.includes("explicit_food_log"));
  assert.ok(decision.reason_codes.includes("routine_coaching"));
});

test("effort ladder: capture < coach < deep, a person's binding still wins", () => {
  const rank = { low: 0, medium: 1, high: 2 };
  const at = (lane) => resolveChatProfile(lane, "claude", {}).reasoning;
  assert.ok(rank[at("capture")] < rank[at("coach")] && rank[at("coach")] < rank[at("deep")]);
  assert.equal(resolveChatProfile("coach", "claude", { claude: { coach: { reasoning: "high" } } }).reasoning, "high");
});

test("deep lane: high effort only for clinical/lab/medication turns, medium for structural asks", () => {
  const effort = (message) => {
    const d = classifyChatRoute({ message });
    return [d.lane, resolveChatProfile(d.lane, "claude", {}, null, d.reason_codes).reasoning];
  };
  assert.deepEqual(effort("my knee pain is worse and I think I need a doctor"), ["deep", "high"]);
  assert.deepEqual(effort("my ldl is 168 and apob 122, what does that mean"), ["deep", "high"]);
  assert.deepEqual(effort("restructure my whole training plan around the race"), ["deep", "medium"]);
  assert.deepEqual(effort("let's switch to a new goal: lose fat and keep strength"), ["deep", "medium"]);
});
