import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import {
  CHAT_ROUTING_POLICY_VERSION,
  CHAT_ROUTING_REASON_CODES,
  chatMessageNeedsCurrentInfo,
  chatMessageWantsCurrentResearch,
  decideChatRouting,
  escalateChatRouting,
  normalizeChatProfileBindings,
  normalizeChatRoutingDecision,
  resolveChatProfile,
} from "../dist/chatRouting.js";

beforeEach(() => {
  db.prepare("DELETE FROM chat_turns").run();
});

test("the strict capture whitelist recognizes concrete food, activity, weight, supplement, and correction logs", () => {
  const cases = [
    ["Log lunch: chicken, rice, and broccoli", "explicit_food_log"],
    ["I ran 5 km", "explicit_activity_log"],
    ["I weighed in at 181.4 lb", "explicit_weight_log"],
    ["I took 5 g creatine", "explicit_supplement_log"],
    ["Correct my lunch calories to 650", "capture_correction"],
  ];
  for (const [message, reason] of cases) {
    const decision = decideChatRouting({ message });
    assert.equal(decision.lane, "capture", message);
    assert.ok(decision.reason_codes.includes(reason), message);
  }

  const conversation = decideChatRouting({ message: "How does protein affect recovery?" });
  assert.equal(conversation.lane, "coach", "a food/training question is not mistaken for a log");
  assert.ok(conversation.reason_codes.includes("routine_coaching"));
});

test("food photos capture by default while clearly non-food or clinical images do not", () => {
  assert.deepEqual(decideChatRouting({ message: "", has_image: true }), {
    policy_version: CHAT_ROUTING_POLICY_VERSION,
    lane: "capture",
    reason_codes: ["photo_food_default"],
  });
  const nonFood = decideChatRouting({ message: "What do you see here?", has_image: true });
  assert.equal(nonFood.lane, "coach");
  assert.ok(nonFood.reason_codes.includes("non_food_image"));

  const imaging = decideChatRouting({ message: "Explain this MRI", has_image: true });
  assert.equal(imaging.lane, "deep");
  assert.ok(imaging.reason_codes.includes("lab_or_imaging"));
});

test("risk signals monotonically raise routing and always outrank an explicit fast request", () => {
  const riskyCapture = decideChatRouting({
    message: "Quickly log my lunch, but check whether it interacts with my medication",
  });
  assert.equal(riskyCapture.lane, "deep");
  assert.ok(riskyCapture.reason_codes.includes("explicit_food_log"));
  assert.ok(riskyCapture.reason_codes.includes("explicit_fast_request"));
  assert.ok(riskyCapture.reason_codes.includes("medication_interaction"));
  assert.ok(riskyCapture.reason_codes.includes("mixed_risk"));

  const base = decideChatRouting({ message: "Log lunch: salmon and rice" });
  const raised = escalateChatRouting(base, "deep", ["clinical_or_injury"]);
  const refusedDowngrade = escalateChatRouting(raised, "capture", ["capture_correction"]);
  assert.equal(refusedDowngrade.lane, "deep");
  assert.ok(refusedDowngrade.reason_codes.includes("clinical_or_injury"));
  assert.ok(refusedDowngrade.reason_codes.includes("capture_correction"));
});

test("deep policy covers clinical, labs, goal identity, restructuring, current research, constraints, and explicit depth", () => {
  const messages = [
    ["My knee injury hurts during squats", "clinical_or_injury"],
    ["Review my latest bloodwork", "lab_or_imaging"],
    ["Change my goal to gaining muscle", "goal_identity"],
    ["Restructure my training plan", "plan_restructure"],
    ["Compare the latest evidence for zone 2 versus intervals", "current_research"],
    ["Build it under 30 minutes, without equipment, while traveling", "multi_constraint"],
    ["Do a deep dive on my progress", "explicit_deep_request"],
  ];
  for (const [message, reason] of messages) {
    const decision = decideChatRouting({ message });
    assert.equal(decision.lane, "deep", message);
    assert.ok(decision.reason_codes.includes(reason), message);
  }
});

test("local dinner and nearby restaurant discovery always require current research", () => {
  for (const message of [
    "Where should we go for dinner tonight?",
    "Where should I eat nearby?",
    "Find a good restaurant near me.",
  ]) {
    const decision = decideChatRouting({ message });
    assert.equal(decision.lane, "deep", message);
    assert.ok(decision.reason_codes.includes("current_research"), message);
  }
});

test("a pasted http(s) URL on a coaching question is current research; a capture log is not", () => {
  const study = decideChatRouting({
    message:
      "And I am curious about this study? https://www.sciencedaily.com/releases/2015/07/150716180913.htm?hl=en-US",
  });
  assert.equal(study.lane, "deep");
  assert.ok(study.reason_codes.includes("current_research"));

  const food = decideChatRouting({ message: "Log lunch: chicken and rice https://menu.example.org/today" });
  assert.equal(food.lane, "capture");
  assert.ok(food.reason_codes.includes("explicit_food_log"));
  assert.ok(!food.reason_codes.includes("current_research"));
});

test("unsupported historical activity, weight, and supplement corrections stay out of capture", () => {
  for (const message of [
    "Correction: yesterday's weight was 179.0, not 178.0",
    "Actually my run yesterday was 5k, not 10k",
    "Don't log magnesium tonight; I did not take it",
  ]) {
    const decision = decideChatRouting({ message });
    assert.notEqual(decision.lane, "capture", message);
    assert.equal(decision.reason_codes.includes("capture_correction"), false, message);
  }
});

test("routing output is taxonomy-only, deterministically ordered, and normalizes away extra private fields", () => {
  const privateMessage = "Log my secret lunch and review my medication";
  const decision = decideChatRouting({ message: privateMessage, has_image: true });
  const serialized = JSON.stringify(decision);
  assert.deepEqual(Object.keys(decision), ["policy_version", "lane", "reason_codes"]);
  assert.doesNotMatch(serialized, /secret lunch|image_path|message/i);
  assert.deepEqual(
    decision.reason_codes,
    CHAT_ROUTING_REASON_CODES.filter((reason) => decision.reason_codes.includes(reason))
  );

  const normalized = normalizeChatRoutingDecision({
    ...decision,
    message: privateMessage,
    image_path: "/private/photo.jpg",
  });
  assert.deepEqual(normalized, decision);
  assert.equal(normalizeChatRoutingDecision({ ...decision, reason_codes: ["made_up_reason"] }), null);
});

test("provider bindings normalize shape and resolve lane defaults without provider syntax knowledge", () => {
  const bindings = normalizeChatProfileBindings({
    claude: {
      capture: { model: "  haiku  ", reasoning: "low", ignored: "x" },
      coach: { reasoning: "xhigh" },
      deep: { model: "opus", reasoning: "turbo" },
      unknown: { model: "drop" },
    },
    codex: { capture: { model: 7, reasoning: "medium" } },
    broken: "not-an-object",
  });
  assert.deepEqual(bindings, {
    claude: {
      capture: { model: "haiku", reasoning: "low" },
      coach: { reasoning: "xhigh" },
      deep: { model: "opus" },
    },
    codex: { capture: { reasoning: "medium" } },
  });
  assert.deepEqual(resolveChatProfile("capture", "claude", bindings), { model: "haiku", reasoning: "low" });
  assert.deepEqual(resolveChatProfile("deep", "claude", bindings), { model: "opus", reasoning: "high" });
  assert.deepEqual(resolveChatProfile("capture", "unbound", bindings), { reasoning: "low" });
  assert.deepEqual(resolveChatProfile("coach", "unbound", bindings), { reasoning: "medium" });
  assert.deepEqual(resolveChatProfile("deep", "unbound", bindings), { reasoning: "high" });
});

test("chat-turn routing is validated, first-write-wins, recovery-readable, and contains no raw telemetry", () => {
  const message = "Log my private lunch";
  const imagePath = "/private/tmp/private-lunch.jpg";
  const initial = decideChatRouting({ message, has_image: true });
  const turn = repo.createChatTurn({ message, image_path: imagePath, routing: initial });
  assert.deepEqual(turn.routing, initial);
  assert.equal(turn.capture_food_note_id, null);

  const raw = db.prepare("SELECT routing_json FROM chat_turns WHERE id = ?").get(turn.id).routing_json;
  assert.deepEqual(Object.keys(JSON.parse(raw)), ["policy_version", "lane", "reason_codes"]);
  assert.doesNotMatch(raw, /private lunch|private-lunch|image_path|message/i);
  assert.deepEqual(repo.getChatTurnRouting(turn.id), initial);

  repo.setChatTurnRouting(turn.id, decideChatRouting({ message: "Review my MRI" }));
  assert.deepEqual(repo.getChatTurnRouting(turn.id), initial, "a recovery pass reuses the persisted decision");
  assert.throws(
    () =>
      repo.createChatTurn({
        message: "x",
        routing: { policy_version: "v0", lane: "coach", reason_codes: ["ordinary_chat"] },
      }),
    /invalid chat routing decision/
  );
});

test("capture food-note linking validates identifiers and writes at most once", () => {
  const turn = repo.createChatTurn({ message: "", image_path: "/private/tmp/photo.jpg" });
  assert.throws(() => repo.setChatTurnCaptureFoodNoteId(turn.id, 0), /invalid capture food note id/);
  assert.equal(repo.setChatTurnCaptureFoodNoteId(turn.id, 41).capture_food_note_id, 41);
  assert.equal(repo.setChatTurnCaptureFoodNoteId(turn.id, 99).capture_food_note_id, 41);
});

test("menu language counts as food: an appetizer amendment routes to capture without a hardcoded item match", () => {
  const message = "Add half of Brussel sprouts from their appetizer list.";
  const decision = decideChatRouting({ message });
  assert.equal(decision.lane, "capture");
  assert.ok(decision.reason_codes.includes("explicit_food_log"));

  const amendment = decideChatRouting({ message, recent_food_capture: true });
  assert.ok(
    amendment.reason_codes.includes("capture_correction"),
    "with a fresh food note the same message is an amendment to it, never an instant duplicate note"
  );
});

test("an amendment-verbed follow-up after a recent food capture corrects the meal even with no food noun", () => {
  const message = "Also add half of that portion for me";
  const withContext = decideChatRouting({ message, recent_food_capture: true });
  assert.equal(withContext.lane, "capture", "recent capture context makes the bare amendment a food capture");
  assert.ok(withContext.reason_codes.includes("explicit_food_log"));
  assert.ok(
    withContext.reason_codes.includes("capture_correction"),
    "the correction reason keeps the amendment off the instant path, which can only create a duplicate note"
  );

  const withoutContext = decideChatRouting({ message });
  assert.equal(withoutContext.lane, "coach", "the same message with no recent capture stays conversational");
  assert.ok(!withoutContext.reason_codes.includes("explicit_food_log"));
});

test("a plain new log keeps its instant receipt even while a food note is fresh", () => {
  const decision = decideChatRouting({ message: "Log lunch: chicken, rice, and broccoli", recent_food_capture: true });
  assert.equal(decision.lane, "capture");
  assert.ok(decision.reason_codes.includes("explicit_food_log"));
  assert.ok(
    !decision.reason_codes.includes("capture_correction"),
    "log-verbed entries are new notes, so they must stay eligible for the instant path"
  );
});

test("other logging domains keep priority over the recent-capture amendment branch", () => {
  const activity = decideChatRouting({ message: "Add a bike ride for tomorrow", recent_food_capture: true });
  assert.ok(!activity.reason_codes.includes("explicit_food_log"), "an activity-shaped add never becomes a food log");
  assert.ok(activity.reason_codes.includes("explicit_activity_log"));

  const supplement = decideChatRouting({ message: "Add 400mg magnesium tonight", recent_food_capture: true });
  assert.ok(!supplement.reason_codes.includes("explicit_food_log"));
  assert.ok(supplement.reason_codes.includes("explicit_supplement_log"));
});

// ---- current outside-world information (2026-11-22) ----------------------------------
// The two real messages from the live chat log, as the brief quotes them ("…" marks
// text the log elided). Both rode beside a fresh food note and were read as a food-log
// capture correction; neither carried current_research, so both ran with web search off.
const REAL_SPRING_HALF =
  "…maybe I can add some spring half marathon race to my goals? Is there something cool happening around Boston area?";
const REAL_DO_THE_SEARCH =
  "Do the actual search and find what is happening. I am not looking to do a 5k race…Races I apply for half marathons.";

test("the two real 2026-11-22 messages are current research, never a food-log capture correction", () => {
  for (const message of [REAL_SPRING_HALF, REAL_DO_THE_SEARCH]) {
    for (const recent_food_capture of [true, false]) {
      const decision = decideChatRouting({ message, recent_food_capture });
      assert.ok(decision.reason_codes.includes("current_research"), `${message} (recent=${recent_food_capture})`);
      assert.equal(decision.lane, "deep", message);
      assert.equal(decision.reason_codes.includes("explicit_food_log"), false, message);
      assert.equal(decision.reason_codes.includes("capture_correction"), false, message);
    }
  }
});

test("explicit asks to search, and questions about dated real-world things, need the web", () => {
  for (const message of [
    "Do the actual search",
    "Can you google when registration opens for the Boston half?",
    "Look it up please",
    "check online if the Rome marathon is sold out",
    "Search for 10k races in April 2027",
    "Are there any half marathons in the spring near me?",
    "What's on in Cambridge this weekend?",
    "Is the weather going to be hot tomorrow for my long run?",
    "What are the latest qualifying times for Boston?",
    "Any cool trail races around Denver area next summer?",
    "What races are happening in Chicago in May?",
    "When does registration close for the NYC half 2027?",
    "Find me a good climbing gym near me",
  ]) {
    assert.ok(chatMessageNeedsCurrentInfo(message), message);
    assert.ok(decideChatRouting({ message }).reason_codes.includes("current_research"), message);
  }
});

test("questions about the athlete's own data are never sent to the web", () => {
  for (const message of [
    "What is my latest run?",
    "How was my last race?",
    "Show my current weight trend",
    "What's on my plan this week?",
    "How should I taper for my race next month?",
    "Is my half marathon pace realistic for spring?",
    "Plan my runs for next week",
    "What did I eat yesterday?",
    "Compare my current squat to last month",
    "What's my upcoming schedule?",
    "How many races have I done this year?",
    "Find me a workout I can do in 30 minutes",
    "How does hot weather affect recovery?",
    "What's the latest you'd recommend I eat before a race?",
    "Is a 5k in April too soon after my marathon?",
    "What race pace should I target for my half?",
    "Good news, I PR'd my deadlift today!",
    "What's happening with my knee?",
    "My race in Chicago is in 3 weeks, how should I taper?",
    "Should I add 5ks to my plan before the marathon?",
    "What is my weekly volume in Zone 2?",
  ]) {
    assert.equal(chatMessageNeedsCurrentInfo(message), false, message);
    assert.equal(decideChatRouting({ message }).reason_codes.includes("current_research"), false, message);
  }
});

// Review of the detector (2026-11-22): each of these returned current_research. A false
// positive drops the athlete's own data reads (a web turn has no coach_read) and puts a
// coaching question on the 240 s web leash, so precision beats recall: what the detector
// misses, the model can still escalate.
test("ordinary coaching messages that mention a place, a race, the weather or news stay coaching", () => {
  for (const message of [
    "The weather in Austin was brutal on my run today, legs felt dead",
    "I'm at the hotel gym in Denver, what should I do today?",
    "My knee hurt during the race in Boston, should I rest?",
    "Good news: next month I start a new job, how should I adjust training?",
    "The forecast says rain tomorrow, swap my long run?",
    "How should I taper for the upcoming race?",
    "The local race was rough, legs felt heavy",
    "Should I race the Boston one?",
  ]) {
    assert.equal(chatMessageNeedsCurrentInfo(message), false, message);
    for (const recent_food_capture of [true, false]) {
      assert.equal(
        decideChatRouting({ message, recent_food_capture }).reason_codes.includes("current_research"),
        false,
        `${message} (recent=${recent_food_capture})`
      );
    }
    assert.equal(chatMessageWantsCurrentResearch(message), false, message);
  }
});

test("asks about the world still reach the web after the precision pass", () => {
  for (const message of [
    "any half marathons around Boston in spring?",
    "Do the actual search",
    "search the web for 10k races near me in April",
    "what's the weather in Boston on Saturday?",
    "when does registration open for the Boston Half?",
    "is there a 5k in Cambridge next month?",
    "are there any pools in Denver?",
    "I'm in Boston in April, any half marathons?",
  ]) {
    assert.ok(chatMessageNeedsCurrentInfo(message), message);
    assert.ok(decideChatRouting({ message }).reason_codes.includes("current_research"), message);
  }
});

test("a food log at a named place stays a food log; the single-profile path asks the same detector", () => {
  const log = decideChatRouting({ message: "Log my dinner at a restaurant in Boston: steak and fries" });
  assert.ok(log.reason_codes.includes("explicit_food_log"));
  assert.equal(log.reason_codes.includes("current_research"), false);
  // An explicit search ask is research even beside a capture.
  assert.ok(chatMessageWantsCurrentResearch("Log lunch and search for the cafe's menu online", { captured: true }));
  assert.equal(chatMessageWantsCurrentResearch("Log my dinner at a restaurant in Boston", { captured: true }), false);
  assert.ok(chatMessageWantsCurrentResearch(REAL_SPRING_HALF));
});

test("default chat lane reasoning never requests xhigh or max, and non-clinical deep turns stay at medium", () => {
  for (const lane of ["capture", "coach", "deep"]) {
    const bare = resolveChatProfile(lane, "claude", {});
    assert.ok(!["xhigh", "max"].includes(bare.reasoning), `${lane} default must not request xhigh/max`);
    for (const reason of CHAT_ROUTING_REASON_CODES) {
      const resolved = resolveChatProfile(lane, "claude", {}, {}, [reason]);
      assert.ok(!["xhigh", "max"].includes(resolved.reasoning), `${lane}/${reason} must not request xhigh/max`);
    }
  }
  // Non-clinical deep turns stay snappy at medium; clinical/lab/medication deep turns keep high.
  for (const reason of ["goal_identity", "plan_restructure", "current_research", "multi_constraint", "explicit_deep_request"]) {
    assert.equal(resolveChatProfile("deep", "claude", {}, {}, [reason]).reasoning, "medium", `deep/${reason}`);
  }
  for (const reason of ["clinical_or_injury", "lab_or_imaging", "medication_interaction"]) {
    assert.equal(resolveChatProfile("deep", "claude", {}, {}, [reason]).reasoning, "high", `deep/${reason}`);
  }
});
