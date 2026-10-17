// A pasted multi-line meal comes back as that many rows even when no agent ever reads it.
//
// src/foodCapture.ts `foodRowsFromWords` splits the athlete's own words deterministically
// (one row per line / bullet / comma-list item, the written quantity as `amount`, NO
// invented macros, confidence low, basis user_report), and every text capture that
// carries no estimate yet stores those rows. A later agent estimate replaces them and
// fills the numbers — unless a person edited the meal first. The chat receipt promises a
// background estimate only when one will actually run.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { mealWindowsAhead } from "../dist/repo/shared.js";
import { foodRowsFromWords, withWordRows } from "../dist/foodCapture.js";
import { completeInstantFoodCapture, instantCaptureReply } from "../dist/chatTurns.js";
import { classifyChatRoute } from "../dist/chatRouting.js";
import { frameFoodCaptureMessage } from "../dist/chat-intent.js";
import { applyFoodEstimate } from "../dist/enrich.js";
import { FOOD_MACRO_KEYS } from "../dist/foodCapture.js";

beforeEach(() => {
  resetTables("chat_turns", "chat_messages", "food_notes", "memory");
  repo.setSettings({ enrich_enabled: false, chat_routing_mode: "adaptive", disabled_agents: ["stub"] });
});

const SIX_LINES = [
  "oats 60 g",
  "- milk 250 ml",
  "• 1 banana",
  "* 2 eggs",
  "1. toast x2",
  "chicken breast (205 g)",
].join("\n");

test("the athlete's lines split into rows with their own quantities, and no numbers are invented", () => {
  assert.deepEqual(foodRowsFromWords(SIX_LINES), [
    { item: "oats", amount: "60 g" },
    { item: "milk", amount: "250 ml" },
    { item: "banana", amount: "1" },
    { item: "eggs", amount: "2" },
    { item: "toast", amount: "2" },
    { item: "chicken breast", amount: "205 g" },
  ]);
  // One line is a comma list — but never split inside a number.
  assert.deepEqual(foodRowsFromWords("oats 60g, milk 250 ml; a banana, 1,5 kg potatoes"), [
    { item: "oats", amount: "60g" },
    { item: "milk", amount: "250 ml" },
    { item: "a banana" },
    { item: "potatoes", amount: "1,5 kg" },
  ]);
  // A heading and a lead-in are not things eaten.
  assert.deepEqual(foodRowsFromWords("Log lunch: rice - 150 g\n\nDinner:\ncoffee with milk"), [
    { item: "rice", amount: "150 g" },
    { item: "coffee with milk" },
  ]);
  assert.deepEqual(foodRowsFromWords("I had 2 slices toast"), [{ item: "toast", amount: "2 slices" }]);
  assert.deepEqual(foodRowsFromWords("   \n  "), []);
  for (const row of foodRowsFromWords(SIX_LINES)) {
    for (const key of FOOD_MACRO_KEYS) assert.equal(row[key], undefined, "no macro is invented");
  }
});

test("rows are added only where there is no estimate yet", () => {
  const words = withWordRows({ summary: "Breakfast" }, "oats 60 g\nmilk 250 ml");
  assert.equal(words.ingredients.length, 2);
  assert.equal(words.confidence, "low");
  assert.equal(words.basis, "user_report");
  assert.equal(words.summary, "Breakfast", "what was already there is kept");
  const estimated = { summary: "Bowl", kcal: 500 };
  assert.equal(withWordRows(estimated, "oats 60 g\nmilk 250 ml"), estimated, "an estimate is never overwritten");
});

function instantFoodCapture(words) {
  const message = frameFoodCaptureMessage(words, false);
  const routing = classifyChatRoute({ message, has_image: false });
  const user = repo.addChatMessage("user", words);
  const turn = repo.createChatTurn({ message, routing, user_message_id: user.id });
  const finished = completeInstantFoodCapture(turn.id, message);
  assert.ok(finished?.note, "a strict food log completes instantly");
  return finished;
}

test("a six-line paste with no agent stores six rows at once, and the receipt promises nothing it can't do", () => {
  const finished = instantFoodCapture(SIX_LINES);
  const note = repo.getFoodNote(finished.note.id);
  assert.equal(note.enrichment_status, "skipped", "no estimate will run");
  assert.equal(note.parsed.ingredients.length, 6, "six lines, six rows");
  assert.deepEqual(
    note.parsed.ingredients.map((r) => r.item),
    ["oats", "milk", "banana", "eggs", "toast", "chicken breast"]
  );
  assert.equal(note.parsed.confidence, "low");
  assert.equal(note.parsed.basis, "user_report");
  for (const key of FOOD_MACRO_KEYS) assert.equal(note.parsed[key] ?? null, null, `${key} stays unknown`);
  const reply = finished.message.content;
  assert.doesNotMatch(reply, /in the background/);
  assert.match(
    reply,
    /as 6 items, in your words\. Nutrition estimates are switched off in Settings, so the numbers stay blank until you add them\.$/
  );

  // The day reads the meal with its rows — and never counts a zero for it.
  const day = repo.getDayIntake();
  assert.equal(day.entries[0].ingredients.length, 6);
  assert.equal(day.known.kcal, false);
});

test("the receipt promises a background estimate only when one will run", () => {
  const pending = { enrichment_status: "pending", parsed: { ingredients: [{ item: "a" }, { item: "b" }] } };
  repo.setSettings({ enrich_enabled: true, disabled_agents: ["stub"] });
  // Enrichment on, but no agent can run (the harness has none but the disabled stub).
  assert.equal(
    instantCaptureReply("lunch", false, pending),
    "Logged your lunch as 2 items, in your words. No agent is available to estimate it right now, so the numbers stay blank until you add them."
  );
  assert.equal(
    instantCaptureReply("lunch", true, pending),
    "Logged your lunch with the photo. No agent is available to estimate it right now, so its numbers stay blank until you add them."
  );
  repo.setSettings({ disabled_agents: [] }); // the offline stub is usable
  assert.equal(
    instantCaptureReply("lunch", false, pending),
    "Logged your lunch. I’ll fill in the nutrition details in the background."
  );
  assert.equal(
    instantCaptureReply("lunch", true, pending),
    "Logged your lunch. I’ll refine the photo estimate in the background."
  );
  repo.setSettings({ enrich_enabled: false });
  assert.equal(
    instantCaptureReply("dinner", false, { enrichment_status: "skipped", parsed: { ingredients: [{ item: "soup" }] } }),
    "Logged your dinner, in your words. Nutrition estimates are switched off in Settings, so the numbers stay blank until you add them."
  );
});

test("a later estimate fills the numbers over the word rows — unless a person edited the meal first", () => {
  const first = repo.addFoodNote("breakfast", "oats 60 g\nmilk 250 ml", null);
  assert.equal(first.parsed.ingredients.length, 2, "REST/MCP text capture keeps the rows too");
  const estimate = {
    summary: "Oats with milk",
    ingredients: [
      { item: "oats", amount: "60 g", kcal: 230, protein_g: 8 },
      { item: "milk", amount: "250 ml", kcal: 160, protein_g: 8 },
    ],
    confidence: "high",
    basis: "user_report",
  };
  assert.equal(applyFoodEstimate(first.id, estimate), true);
  const filled = repo.getFoodNote(first.id);
  assert.equal(filled.parsed.kcal, 390);
  assert.equal(filled.parsed.protein_g, 16);
  assert.equal(filled.parsed.ingredients[0].kcal, 230);

  const second = repo.addFoodNote("breakfast", "oats 60 g\nmilk 250 ml", null);
  repo.updateFoodNote(second.id, {
    ingredients: [
      { item: "oats", amount: "80 g" },
      { item: "milk", amount: "250 ml" },
    ],
  });
  assert.equal(applyFoodEstimate(second.id, estimate), false, "the person's edit wins");
  const kept = repo.getFoodNote(second.id);
  assert.equal(kept.parsed.ingredients[0].amount, "80 g");
  assert.equal(kept.parsed.kcal ?? null, null);
});

test("a capture that already carries an estimate never gets word rows", () => {
  const withEstimate = repo.addFoodNote("lunch", "chicken 200 g\nrice 150 g", {
    summary: "Bowl",
    kcal: 520,
    protein_g: 45,
  });
  assert.equal(withEstimate.parsed.ingredients, undefined);
  assert.equal(withEstimate.parsed.kcal, 520);
});

test("a square/block of dark chocolate and pour-over coffee at 5:48 AM is logged as a snack, not breakfast, and splits cleanly into two word rows", () => {
  const raw = "I had a block of Lindt excellenece dark chocolate with raspberry\n\nand pour over coffee.";
  assert.deepEqual(foodRowsFromWords(raw), [
    { item: "Lindt excellenece dark chocolate with raspberry", amount: "1 block" },
    { item: "pour over coffee" },
  ]);
  const finished = instantFoodCapture(raw);
  const note = repo.getFoodNote(finished.note.id);
  assert.equal(note.meal, "snack", "coffee + a square of dark chocolate at 5:48 AM is a snack, never breakfast");
  assert.match(finished.message.content, /^Logged your snack\b/);
  assert.deepEqual(mealWindowsAhead(6, [{ meal: note.meal, eaten_at: "05:48" }]), ["breakfast", "lunch", "dinner"]);
});

