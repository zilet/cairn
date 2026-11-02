// Chat can set the athlete's OWN calorie target (`set_nutrition_target`), through the same
// door as the Fuel card's edit and MCP set_nutrition_target (`userSetNutritionTarget`).
// Before this action existed the coach answered "adjust my calories to 2,100" with
// "I can't do that from chat — tap the target card", and saved a memory note instead.
import assert from "node:assert/strict";
import { test } from "node:test";
import { repo } from "./_seed.js";
import { applyChatActions } from "../dist/chatTurns.js";
import { reconcileNutritionTargetReply } from "../dist/chat-reconcile.js";
import { CHAT_ACTION_TYPES, normalizeChatAction, renderChatActionPromptProse } from "../dist/chatActions.js";
import {
  coachOfferedNutritionTarget,
  hasExplicitNutritionTargetIntent,
  hasExplicitNutritionTargetIntentInContext,
} from "../dist/chat-intent.js";

const turn = (message, priorAssistant = "") => ({
  agent: "stub",
  message,
  recentAthleteMessages: [],
  priorAssistant: { message: priorAssistant, drafted: false },
});

test("the action is in the chat vocabulary, and the prompt says it can be done from chat", () => {
  assert.ok(CHAT_ACTION_TYPES.includes("set_nutrition_target"));
  const prose = renderChatActionPromptProse();
  assert.match(prose, /set_nutrition_target/);
  assert.match(prose, /never send them to the app/);
});

test("normalize keeps a target inside the band and drops one outside it", () => {
  assert.deepEqual(normalizeChatAction({ type: "set_nutrition_target", target_kcal: "2100", protein_g: 175 }), {
    type: "set_nutrition_target",
    target_kcal: 2100,
    protein_g: 175,
  });
  assert.equal(normalizeChatAction({ type: "set_nutrition_target", target_kcal: 800 }), null);
  assert.equal(normalizeChatAction({ type: "set_nutrition_target", target_kcal: 9000 }), null);
  assert.equal(normalizeChatAction({ type: "set_nutrition_target" }), null);
});

test("the athlete's own ask is intent; a question or a food log is not", () => {
  for (const yes of [
    "can you adjust my caloric goals here accordingly",
    "set my calories to 2100",
    "Can you set my calorie target to 2,100?",
    "my calorie target is 2,100 kcal",
    "lower my daily calorie goal to 2000 please",
  ]) {
    assert.equal(hasExplicitNutritionTargetIntent(yes), true, yes);
  }
  for (const no of [
    "what should my calories be?",
    "is 2,100 kcal too low?",
    "should I eat more calories on lift days",
    "I had 2,100 calories today",
    "how many calories are in skyr",
    "move my run to Thursday",
  ]) {
    assert.equal(hasExplicitNutritionTargetIntent(no), false, no);
  }
});

test("a plain yes counts only after the coach offered a calorie number", () => {
  const offer = "Want me to set your daily target to 2,100 kcal?";
  assert.equal(coachOfferedNutritionTarget(offer), true);
  assert.equal(hasExplicitNutritionTargetIntentInContext("yes, do it", { priorCoachMessage: offer }), true);
  assert.equal(
    hasExplicitNutritionTargetIntentInContext("yes, do it", { priorCoachMessage: "Want to move Push to Friday?" }),
    false
  );
});

test("transcript: 'adjust my caloric goals accordingly' lands the number as THEIR target, protein kept", () => {
  repo.setNutritionTarget({ target_kcal: 2447, protein_g: 175, source: "checkin" });
  const { applied } = applyChatActions(
    { actions: [{ type: "set_nutrition_target", target_kcal: 2100 }] },
    turn("can you adjust my caloric goals here accordingly")
  );
  const entry = applied.find((a) => a.type === "set_nutrition_target");
  assert.ok(entry?.result, JSON.stringify(entry));
  const active = repo.getActiveNutritionTarget();
  assert.equal(active.source, "user");
  assert.equal(active.protein_g, 175, "changing the calories keeps the protein they already hold");
  assert.equal(entry.result.previous_kcal, 2447);
  assert.equal(active.target_kcal, entry.result.target_kcal);

  const reply = reconcileNutritionTargetReply("Done — 2,100 it is.", applied);
  assert.match(reply, /Done — 2,100 it is\./);
  assert.match(reply, new RegExp(`target is now ${active.target_kcal.toLocaleString("en-US")} kcal with 175 g protein`));
});

test("a question never sets the target, and a reply claiming it did is replaced", () => {
  repo.setNutritionTarget({ target_kcal: 2447, protein_g: 175, source: "checkin" });
  const { applied } = applyChatActions(
    { actions: [{ type: "set_nutrition_target", target_kcal: 2100 }] },
    turn("is 2,100 kcal too low for me?")
  );
  assert.match(applied[0].error, /your own words/);
  assert.equal(repo.getActiveNutritionTarget().target_kcal, 2447);
  const reply = reconcileNutritionTargetReply("I've set your calorie target to 2,100 kcal.", applied);
  assert.doesNotMatch(reply, /I've set/);
  assert.match(reply, /did not change|unchanged/);
});

test("the receipt says so when the lean-safe floor raised the number", () => {
  const reply = reconcileNutritionTargetReply("Set.", [
    { type: "set_nutrition_target", result: { target_kcal: 1800, requested_kcal: 1300, protein_g: null } },
  ]);
  assert.match(reply, /You asked for 1,300 kcal; the lean-safe floor for your goal holds it at 1,800 kcal\./);
});
