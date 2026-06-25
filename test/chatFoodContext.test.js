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
  repo.addFoodNote("breakfast", "", { summary: "Turkey sourdough plate", kcal: 400, protein_g: 52 });
  repo.addChatMessage("user", "Breakfast was logged in this thread");
  repo.archiveChat();

  const ctx = repo.getCoachContext();
  assert.equal(ctx.day_intake.count, 1);
  assert.equal(ctx.day_intake.entries[0].summary, "Turkey sourdough plate");

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
