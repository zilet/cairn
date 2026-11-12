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
import { CHAT_ACTION_TYPES, CHAT_PROMPT_ACTION_TYPES } from "../dist/chatActions.js";
import {
  applyChatActions,
  CHAT_ACTION_GATE_FOR,
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
    const gate = CHAT_ACTION_GATE_FOR[type];
    assert.equal(chatActionGates({ message: opens, priorAssistant: { message: "" } })[gate], true, `${type}: "${opens}"`);
    assert.equal(chatActionGates({ message: closes, priorAssistant: { message: "" } })[gate], false, `${type}: "${closes}"`);
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

test("every omitted type is one the server refuses for that same message", () => {
  for (const message of CORPUS) {
    const prior = { message: "", drafted: false };
    const offered = new Set(chatPromptActionTypes(chatActionGates({ message, priorAssistant: prior })));
    for (const type of Object.keys(SAMPLE)) {
      if (offered.has(type)) continue;
      repo.savePlanDay(1, "Full Body", "strength", [
        { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
      ]);
      const out = applyChatActions({ actions: [SAMPLE[type]] }, { agent: "stub", message, priorAssistant: prior, recentAthleteMessages: [], enqueueJob: () => {} });
      assert.equal(landed(out, type), false, `"${message}" omits ${type}, so the server must refuse it`);
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
