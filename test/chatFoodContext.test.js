// Food logged in Chat must become durable coach context, not just conversation
// history. A fresh-start/archive removes old chat turns from the live thread, but
// the next chat still needs to know today's breakfast from food_notes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import {
  buildChatPrompt,
  buildDayReadPrompt,
  buildInsightPrompt,
  buildNutritionCheckinPrompt,
  buildSessionPrompt,
  buildWeeklyReadPrompt,
} from "../dist/prompt.js";

beforeEach(() => resetTables("food_notes", "chat_messages", "chat_turns", "profile"));

test("getCoachContext carries today's food even after the chat thread is archived", () => {
  repo.addFoodNote("breakfast", "", {
    summary: "Turkey sourdough plate",
    kcal: 400,
    protein_g: 52,
    nutrition_pattern: { whole_foods: "mostly", caffeine_mg: 80, confidence: "observed" },
  });
  repo.addChatMessage("user", "Breakfast was logged in this thread");
  repo.archiveChat();

  const ctx = repo.getCoachContext();
  assert.equal(ctx.day_intake.count, 1);
  assert.equal(ctx.day_intake.entries[0].summary, "Turkey sourdough plate");
  assert.deepEqual(ctx.day_intake.entries[0].nutrition_pattern, {
    whole_foods: "mostly",
    caffeine_mg: 80,
    confidence: "observed",
  });

  const prompt = buildChatPrompt([], "How am I doing today?");
  assert.match(prompt, /"day_intake"/, "fresh chat prompt includes durable day intake");
  assert.match(prompt, /TODAY'S FUEL/, "fresh chat prompt calls out persisted food explicitly");
  assert.match(prompt, /Turkey sourdough plate/, "fresh chat prompt sees the logged breakfast");
  assert.match(prompt, /update_food_note/, "fresh chat prompt gives the agent the correction path");
});

test("today's fuel is an explicit cross-surface agent fact when food exists", () => {
  repo.addFoodNote("breakfast", "", { summary: "Turkey sourdough plate", kcal: 400, protein_g: 52 });

  for (const [name, prompt] of [
    ["chat", buildChatPrompt([], "How am I doing today?")],
    ["day read", buildDayReadPrompt()],
    ["session", buildSessionPrompt()],
    ["nutrition check-in", buildNutritionCheckinPrompt()],
    ["insight", buildInsightPrompt()],
    ["weekly read", buildWeeklyReadPrompt()],
  ]) {
    assert.match(prompt, /TODAY'S FUEL/, `${name} prompt surfaces logged food`);
    assert.match(prompt, /Turkey sourdough plate/, `${name} prompt includes the actual logged meal`);
  }
});

test("empty food days stay quiet in prompts", () => {
  assert.doesNotMatch(buildChatPrompt([], "How am I doing today?"), /TODAY'S FUEL/);
  assert.doesNotMatch(buildSessionPrompt(), /TODAY'S FUEL/);
});

test("a food-only chat turn is explicitly kept to food rather than an unrelated plan pitch", () => {
  const prompt = buildChatPrompt([], "Lunch today: double chicken salad, no dressing. Estimate it.");
  assert.match(prompt, /a meal log, plate photo, or nutrition question is a food moment/i);
  assert.match(prompt, /Do NOT pivot into a lift, future\s+training change, or plan update from a food-only turn/i);
  assert.match(prompt, /Do not narrate a background plan_update/i);
});

test("a logged meal's numbers live on its receipt card, so the reply never restates them", () => {
  const prompts = {
    coach: buildChatPrompt([], "I had a turkey sandwich and an apple for lunch"),
    capture: buildChatPrompt([], "turkey sandwich for lunch", undefined, { lane: "capture" }),
    photo: buildChatPrompt([], "lunch", "/tmp/plate.jpg"),
  };
  for (const [lane, prompt] of Object.entries(prompts)) {
    assert.match(prompt, /FOOD RECEIPT card right under your reply/, `${lane}: the model knows the card exists`);
    assert.match(prompt, /must NOT restate any of it: no calories or grams, no macro list or bullets/, lane);
    assert.match(prompt, /one or two sentences of MEANING/, lane);
    // The prose-first contract is untouched.
    assert.match(prompt, /===CAIRN_REPLY===/, lane);
  }
  // Only log_food renders the full receipt; an amendment is a one-line chip, so its
  // prose may name what changed (never a macro list).
  for (const [lane, prompt] of Object.entries(prompts)) {
    assert.doesNotMatch(prompt, /When you emit log_food \(or update_food_note\)/, lane);
    assert.match(prompt, /An amended meal does NOT get the full receipt card/, lane);
    assert.match(prompt, /may briefly name what changed/, lane);
  }
  assert.doesNotMatch(prompts.photo, /dish · ~kcal · protein/, "the photo path no longer asks for a macro summary");
  // The photo block no longer repeats the receipt rule: log_food's own guidance carries it (above).
  assert.doesNotMatch(prompts.photo, /never restate kcal, grams or a macro list in the prose/);
});
