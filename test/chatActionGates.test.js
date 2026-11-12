// The coach/deep prompt offers an action only when the server would accept it THIS turn.
// Eight action types are refused after the reply unless the athlete's own message
// authorizes them; seven of those gates read nothing but the turn's message, photo and
// the chat log before it, so chatActionGates computes them ONCE and both the prompt
// (chatPromptActionTypes) and applyChatActions read the result. revert_decision's gate
// also reads the id the reply names, so it is always rendered.
//
// The safety property pinned here: an omitted shape can never cost a write the server
// would have taken. For every type a message's prompt leaves out, applying that action
// with that message writes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { buildChatPrompt } from "../dist/prompt.js";
import { CHAT_ACTION_TYPES, CHAT_PROMPT_ACTION_TYPES, renderOmittedGatedActions } from "../dist/chatActions.js";
import { coachOfferedNutritionTarget, coachOfferedPush } from "../dist/chat-intent.js";
import {
  applyChatActions,
  CHAT_ACTION_GATE_FOR,
  chatActionGateOpen,
  chatActionGates,
  chatPromptActionTypes,
} from "../dist/chatTurns.js";

const shapeOf = (type) => new RegExp(`"type": "${type}"`);
const promptFor = (message, extra = {}) =>
  buildChatPrompt([], message, undefined, {
    lane: "coach",
    actionTypes: chatPromptActionTypes(chatActionGates({ message, priorAssistant: { message: "" } })),
    ...extra,
  });

// One message that opens each gate, and one that does not (the predicates' own examples).
const CASES = {
  set_training_drive: ["Push me harder until the block ends", "Should I push harder?"],
  set_nutrition_target: ["Set my calories to 2,100", "What should my calories be?"],
  set_strength_objective: ["I want to get my Barbell Bench Press back to my personal best.", "What should my bench target be while I get back into lifting?"],
  report_training_symptom: ["Could you log my left knee pain?", "My left knee hurts during squats."],
  resolve_training_symptom: ["Close the knee note, it's fine now.", "Is my knee note resolved?"],
  flag_training_structure: ["Track all six of my anchor lifts in parallel.", "Should I train all six lifts?"],
  plan_restructure: ["Move me to a two-day upper/lower split.", "What should I change about my squat?"],
  today_session: [
    "Make it a full upper body session today, I have time for a longer one.",
    "Should I train upper body today?",
  ],
  start_session: ["Let's start today's session", "How did today's session go?"],
};

test("the gate map names exactly the server-gated types, and set_run is never offered", () => {
  assert.deepEqual(Object.keys(CHAT_ACTION_GATE_FOR).sort(), Object.keys(CASES).sort());
  assert.ok(!CHAT_PROMPT_ACTION_TYPES.includes("set_run"));
  assert.ok(CHAT_ACTION_TYPES.includes("set_run"), "an old reply still parses");
  const prompt = promptFor("How did my week go?");
  assert.doesNotMatch(prompt, shapeOf("set_run"));
  assert.doesNotMatch(prompt, /\bset_run\b/, "neither its shape nor its guidance");
  // Ungated types — the injury path and revert_decision among them — always render.
  for (const type of ["add_context_event", "revert_decision", "plan_update", "log_food", "set_profile"]) {
    assert.match(prompt, shapeOf(type), type);
  }
});

test("each gated shape renders for a message that opens its gate and not for one that does not", () => {
  for (const [type, [opens, closes]] of Object.entries(CASES)) {
    const gateOpen = (message) =>
      chatActionGateOpen(type, chatActionGates({ message, priorAssistant: { message: "" } }));
    assert.ok(CHAT_ACTION_GATE_FOR[type].length > 0, type);
    assert.equal(gateOpen(opens), true, `${type}: "${opens}"`);
    assert.equal(gateOpen(closes), false, `${type}: "${closes}"`);
    assert.match(promptFor(opens), shapeOf(type), `${type} renders for "${opens}"`);
    assert.doesNotMatch(promptFor(closes), shapeOf(type), `${type} is omitted for "${closes}"`);
  }
});

test("a yes to the coach's own offer opens the drive and the calorie gates, as the server does", () => {
  const offer = { message: "Your log says you're carrying this with room to spare — want me to open the throttle and push through the block?" };
  const gates = chatActionGates({ message: "yes", priorAssistant: offer });
  assert.equal(gates.trainingDrive, true);
  assert.equal(chatActionGates({ message: "yes", priorAssistant: { message: "Nice session." } }).trainingDrive, false);
  const kcal = chatActionGates({
    message: "yes, do it",
    priorAssistant: { message: "Want me to set your daily target to 2,100 kcal?" },
  });
  assert.equal(kcal.nutritionTarget, true);
});

test("the full context and an escalation rebuild read the same action types", () => {
  const types = chatPromptActionTypes(chatActionGates({ message: "Should I push harder?", priorAssistant: { message: "" } }));
  for (const context of ["lean", "full"]) {
    for (const lane of ["coach", "deep"]) {
      const prompt = buildChatPrompt([], "Should I push harder?", undefined, { lane, context, actionTypes: types });
      assert.doesNotMatch(prompt, shapeOf("set_training_drive"), `${context}/${lane}`);
      assert.match(prompt, shapeOf("add_context_event"), `${context}/${lane}`);
    }
  }
});

// A minimal action per gated type that the server WOULD apply were its gate open.
const SAMPLE = {
  set_training_drive: { type: "set_training_drive", drive: "push", scope: "block" },
  set_nutrition_target: { type: "set_nutrition_target", target_kcal: 2100 },
  set_strength_objective: { type: "set_strength_objective", exercise: "Barbell Bench Press", target_kind: "return_to_personal_best" },
  report_training_symptom: { type: "report_training_symptom", area_text: "left knee" },
  resolve_training_symptom: { type: "resolve_training_symptom", area_text: "left knee" },
  flag_training_structure: { type: "flag_training_structure", request: "Track all six lifts", summary: "Six anchors" },
  plan_restructure: {
    type: "plan_restructure",
    summary: "Two-day split",
    days: [{ day_number: 1, name: "Upper", focus: "Upper", items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }] }],
  },
  today_session: {
    type: "today_session",
    title: "Upper",
    items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }],
  },
  start_session: { type: "start_session" },
};

const CORPUS = [
  ...Object.values(CASES).flat(),
  "How did my week go?",
  "I ate a bagel and eggs",
  "my knee's been bugging me",
  "Restructure my week to 5 days",
  "undo that",
  "",
  "yes",
  "Should I take a rest day?",
  "Can you log my shoulder pain?",
  "I had chicken and rice for dinner, push me harder",
];

const landed = (out, type) =>
  out.applied.some((entry) => entry.type === type && !entry.error && entry.result != null && entry.result?.ok !== false);

// The coach's message before the athlete's: no context, each offer the recognizers read,
// a spelled-out session proposal, and a turn that stored a plan draft.
const PRIORS = [
  { message: "", drafted: false },
  { message: "Nice session today.", drafted: false },
  {
    message:
      "Your log says you're carrying this with room to spare — want me to open the throttle for the next few weeks?",
    drafted: false,
  },
  { message: "Want me to set your daily target to 2,100 kcal?", drafted: false },
  {
    message: "Here's what I'd run tomorrow:\n- Squat 3x5 @ 100\n- Bench 3x8 @ 70\nWant me to set it up?",
    drafted: false,
  },
  { message: "Want me to flag that for you?", drafted: false },
  { message: "I've drafted the change for you to review.", drafted: true },
];

test("every omitted type is one the server refuses for that same message", () => {
  for (const message of [...CORPUS, "yes, do it", "sounds good, go ahead", "yes please"]) {
    for (const prior of PRIORS) {
      const offered = new Set(chatPromptActionTypes(chatActionGates({ message, priorAssistant: prior })));
      for (const type of Object.keys(SAMPLE)) {
        if (offered.has(type)) continue;
        repo.savePlanDay(1, "Full Body", "strength", [
          { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
        ]);
        const out = applyChatActions(
          { actions: [SAMPLE[type]] },
          { agent: "stub", message, priorAssistant: prior, recentAthleteMessages: [], enqueueJob: () => {} }
        );
        assert.equal(
          landed(out, type),
          false,
          `"${message}" after "${prior.message.slice(0, 40)}" omits ${type}, so the server must refuse it`
        );
      }
    }
  }
});

test("…and an offered gated type is one the server accepts (the gate is not merely closed everywhere)", () => {
  for (const [type, [opens]] of Object.entries(CASES)) {
    if (type === "set_strength_objective" || type === "resolve_training_symptom") continue; // need history to land
    repo.savePlanDay(1, "Full Body", "strength", [
      { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
    ]);
    const prior = { message: "", drafted: false };
    assert.ok(chatPromptActionTypes(chatActionGates({ message: opens, priorAssistant: prior })).includes(type), type);
    const out = applyChatActions({ actions: [SAMPLE[type]] }, { agent: "stub", message: opens, priorAssistant: prior, recentAthleteMessages: [], enqueueJob: () => {} });
    assert.ok(
      out.applied.some((entry) => entry.type === type && !entry.error),
      `${type} with "${opens}" reaches its writer: ${JSON.stringify(out.applied)}`
    );
  }
});

// ── the rule every OUTPUT CONTRACT states, and the line an omitted shape leaves ───────
const ASKED_ONLY =
  /Write actions ONLY when the athlete asked to log or change something; a question \("should I move my long run to Saturday\?"\) gets prose only, no actions block\./g;

test("every lane and mode says actions only when asked, once", () => {
  const prompts = {
    capture: buildChatPrompt([], "had eggs", undefined, { lane: "capture" }),
    "lean coach": buildChatPrompt([], "How did my week go?", undefined, { lane: "coach" }),
    "lean deep": buildChatPrompt([], "How did my week go?", undefined, { lane: "deep" }),
    "full coach": buildChatPrompt([], "How did my week go?", undefined, { lane: "coach", context: "full" }),
    "full deep": buildChatPrompt([], "How did my week go?", undefined, { lane: "deep", context: "full" }),
  };
  for (const [name, prompt] of Object.entries(prompts)) {
    assert.equal((prompt.match(ASKED_ONLY) ?? []).length, 1, name);
    assert.ok(prompt.search(ASKED_ONLY) > prompt.indexOf("OUTPUT CONTRACT"), `${name}: inside the OUTPUT CONTRACT`);
  }
});

const omittedLine = (prompt, type) => {
  const block = prompt.slice(prompt.indexOf("NOT ON OFFER THIS TURN"));
  return block.split("\n").find((line) => line.startsWith(`- ${type}:`)) ?? null;
};

test("an omitted gated action leaves one short NOT ON OFFER line, and an offered one leaves none", () => {
  const closed = promptFor("How did my week go?");
  assert.match(closed, /NOT ON OFFER THIS TURN \(the athlete's own words are needed: never emit these now/);
  for (const type of Object.keys(CASES)) {
    const line = omittedLine(closed, type);
    assert.ok(line, `${type} has its line`);
    assert.ok(Buffer.byteLength(line, "utf8") <= 160, `${type}: ${Buffer.byteLength(line)} bytes`);
    assert.doesNotMatch(closed, shapeOf(type), `${type}: no shape`);
  }
  for (const [type, [opens]] of Object.entries(CASES)) {
    assert.equal(omittedLine(promptFor(opens), type), null, `${type} is on offer for "${opens}"`);
  }
  // Nothing omitted, no block at all.
  assert.equal(renderOmittedGatedActions([]), "");
  assert.doesNotMatch(buildChatPrompt([], "How did my week go?", undefined, { lane: "coach" }), /NOT ON OFFER/);
});

test("each NOT ON OFFER line's suggested wording is one the server's gate actually accepts", () => {
  const quoted = (type) => {
    const line = renderOmittedGatedActions([type]);
    return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  // The coach's offer, then the athlete's plain yes, opens the gate.
  const yesAfter = (offer, gate, yes = "yes") =>
    chatActionGates({ message: yes, priorAssistant: { message: offer } })[gate];
  const [push] = quoted("set_training_drive");
  assert.ok(coachOfferedPush(push), push);
  assert.equal(yesAfter(push, "trainingDrive"), true);
  const [kcal] = quoted("set_nutrition_target");
  assert.ok(coachOfferedNutritionTarget(kcal), kcal);
  assert.equal(yesAfter(kcal, "nutritionTarget", "yes, do it"), true);
  const [flag] = quoted("flag_training_structure");
  assert.equal(yesAfter(flag, "flagTrainingStructure", "yes please"), true);
  const restructure = quoted("plan_restructure");
  assert.equal(
    chatActionGates({ message: restructure[1], priorAssistant: { message: restructure[0] } }).planRestructure,
    true
  );
  // Today's session: the offer to set one up opens the build gate; the offer to open it
  // opens only the start gate.
  const [setUp] = quoted("today_session");
  assert.equal(yesAfter(setUp, "todaySession", "yes, set it up"), true);
  const [openIt] = quoted("start_session");
  assert.equal(yesAfter(openIt, "startSession"), true);
  assert.equal(yesAfter(openIt, "todaySession", "go ahead"), false);
  // The self-stated gates: the sentence the coach suggests the athlete say opens its gate.
  const said = (type) =>
    quoted(type)
      .at(-1)
      .replace(/^Say '([^']+)'.*$/, "$1");
  assert.equal(
    chatActionGates({ message: said("report_training_symptom"), priorAssistant: { message: "" } }).symptomReport,
    true
  );
  assert.equal(
    chatActionGates({ message: said("resolve_training_symptom"), priorAssistant: { message: "" } }).symptomResolve,
    true
  );
  assert.equal(
    chatActionGates({ message: said("set_strength_objective"), priorAssistant: { message: "" } }).strengthObjective,
    true
  );
});
