// Approximate logging is corrected by talking. The athlete logs a meal in chat and
// then says "oh and I had 40 g of avocado on the plate", or "actually it was two
// slices", or "there was no cheese". That follow-up must amend THE SAME logged meal
// (same food note, rows and totals rebuilt by the food-capture arithmetic), never
// log a disconnected duplicate, and the compact summary on the original chat message
// must read the amended meal. The agent never runs here (offline, deterministic): the
// chain is pinned link by link — routing keeps the follow-up off the no-agent
// instant lane, the prompt hands the agent the meal's rows and the amendment
// contract, applyChatActions lands the action on the note, and the chat read path
// reprints the original message from the note as it now stands.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { applyChatActions, isInstantFoodCaptureDecision } from "../dist/chatTurns.js";
import { classifyChatRoute } from "../dist/chatRouting.js";
import { buildChatPrompt } from "../dist/prompt.js";
import { amendFoodIngredients } from "../dist/foodCapture.js";

beforeEach(() => {
  resetTables("food_notes", "chat_turns", "chat_messages", "day_reads");
  repo.setSettings({ enrich_enabled: false, chat_routing_mode: "adaptive" });
});

const plain = (value) => JSON.parse(JSON.stringify(value));

// A five-item plate as chat's log_food lands it: rows with their own estimates, a
// meal total that is exactly their sum.
function logPlate() {
  const { applied } = applyChatActions(
    {
      actions: [
        {
          type: "log_food",
          meal: "lunch",
          summary: "Chicken plate",
          ingredients: [
            { item: "Chicken breast", amount: "150 g", kcal: 248, protein_g: 46, carbs_g: 0, fat_g: 5, fiber_g: 0 },
            { item: "Sourdough toast", amount: "1 slice", kcal: 80, protein_g: 3, carbs_g: 15, fat_g: 1, fiber_g: 1 },
            { item: "Cheddar", amount: "20 g", kcal: 80, protein_g: 5, carbs_g: 0, fat_g: 7, fiber_g: 0 },
            { item: "Mixed greens", amount: "1 handful (~30 g)", kcal: 6, protein_g: 0, carbs_g: 1, fat_g: 0, fiber_g: 1 },
            { item: "Olive oil", amount: "1 tsp", kcal: 40, protein_g: 0, carbs_g: 0, fat_g: 4.5, fiber_g: 0 },
          ],
          kcal: 454,
          protein_g: 54,
          carbs_g: 16,
          fat_g: 17.5,
          fiber_g: 3,
          basis: "estimated_from_foods",
          confidence: "medium",
        },
      ],
    },
    { agent: "stub", message: "lunch was a chicken plate with toast, cheddar, greens and olive oil" }
  );
  return applied[0].result;
}

function rowsOf(id) {
  return repo.getFoodNote(id).parsed.ingredients.map((row) => [row.item, row.amount, row.kcal]);
}

// ---------- the pure amendment ----------

test("amendFoodIngredients: only named rows change, new ones join, removals go, the rest stay as stored", () => {
  const stored = {
    ingredients: [
      { item: "Sourdough toast", amount: "1 slice", kcal: 80, protein_g: 3 },
      { item: "Cheddar", amount: "20 g", kcal: 80, protein_g: 5, confidence: "low" },
      { item: "Olive oil", amount: "1 tsp", kcal: 40 },
    ],
  };
  const out = amendFoodIngredients(
    stored,
    [
      { item: "sourdough  TOAST", amount: "2 slices" }, // same row, any casing: amount-only
      { item: "Avocado", amount: "40 g", kcal: 64, protein_g: 1 }, // a new row with its estimate
    ],
    ["olive oil"]
  );
  assert.deepEqual(plain(out), [
    // The stored macros ride along so the recompute SCALES them — never read as typed.
    { item: "Sourdough toast", amount: "2 slices", kcal: 80, protein_g: 3 },
    { item: "Cheddar", amount: "20 g", kcal: 80, protein_g: 5, confidence: "low" },
    { item: "Avocado", amount: "40 g", kcal: 64, protein_g: 1 },
  ]);
  // A row restated with its own numbers takes them.
  const restated = amendFoodIngredients(stored, [{ item: "Cheddar", amount: "30 g", kcal: 120 }]);
  assert.deepEqual(plain(restated[1]), { item: "Cheddar", amount: "30 g", kcal: 120 });
  // Nothing named is nothing changed.
  assert.deepEqual(plain(amendFoodIngredients(stored, [], [])), plain(stored.ingredients));
});

// ---------- routing: the follow-up reaches an agent that can amend ----------

test("'oh and I had 40g of avocado on the plate' right after a capture is a correction, not a new instant log", () => {
  const message = "oh and I had 40g of avocado on the plate";
  const afterCapture = classifyChatRoute({ message, recent_food_capture: true });
  assert.equal(afterCapture.lane, "capture");
  assert.ok(afterCapture.reason_codes.includes("capture_correction"));
  assert.equal(
    isInstantFoodCaptureDecision(afterCapture, message),
    false,
    "the no-agent instant lane can only create a NEW note — a duplicate here"
  );

  for (const followUp of ["and a coffee with it", "had some hot sauce on top", "a spoon of honey in the bowl too"]) {
    const decision = classifyChatRoute({ message: followUp, recent_food_capture: true });
    assert.ok(decision.reason_codes.includes("capture_correction"), followUp);
  }

  // A genuinely new meal keeps its instant receipt, recent capture or not.
  const newMeal = classifyChatRoute({ message: "I had pizza for dinner", recent_food_capture: true });
  assert.equal(newMeal.reason_codes.includes("capture_correction"), false);
  assert.equal(isInstantFoodCaptureDecision(newMeal, "I had pizza for dinner"), true);
  // And with no recent capture there is nothing to amend.
  const cold = classifyChatRoute({ message, recent_food_capture: false });
  assert.equal(cold.reason_codes.includes("capture_correction"), false);
});

// ---------- the prompt: the agent sees the meal's rows and the contract ----------

test("both chat lanes hand the agent the latest meal's rows and the amend-in-rows contract", () => {
  const note = logPlate();
  const capture = buildChatPrompt([], "oh and I had 40g of avocado on the plate", undefined, { lane: "capture" });
  const data = JSON.parse(capture.slice(capture.lastIndexOf("CAPTURE DATA (bounded")).split("\n")[1]);
  const entry = data.today_food.entries.find((e) => e.id === note.id);
  assert.equal(entry.summary, "Chicken plate", "the capture lane can tell which meal is which");
  assert.deepEqual(entry.rows[1], { item: "Sourdough toast", amount: "1 slice", kcal: 80 });
  assert.equal(entry.rows.length, 5);
  assert.match(capture, /AMENDS that entry with update_food_note/);
  assert.match(capture, /"remove_items"/);
  assert.match(capture, /OMIT kcal\/protein_g\/carbs_g\/fat_g\/fiber_g/);

  const coach = buildChatPrompt([], "actually it was two slices of toast");
  assert.match(coach, new RegExp(`LOGGED MEAL ROWS[^\\n]*\\n  - id ${note.id}: Chicken breast \\(150 g\\); Sourdough toast \\(1 slice\\)`));
  assert.match(coach, /AMENDS that entry with update_food_note/);
});

// ---------- the action: the SAME note, rows and totals rebuilt ----------

test("'oh and 40 g of avocado' amends the same meal: one note, the row joins, the total follows", () => {
  const note = logPlate();
  const { applied } = applyChatActions(
    {
      actions: [
        {
          type: "update_food_note",
          id: note.id,
          ingredients: [
            { item: "Avocado", amount: "40 g", kcal: 64, protein_g: 1, carbs_g: 3.4, fat_g: 5.9, fiber_g: 2.7 },
          ],
          // A model's own re-summed total never overrides the row arithmetic.
          kcal: 999,
        },
      ],
    },
    { agent: "stub", message: "oh and I had 40g of avocado on the plate" }
  );

  assert.equal(applied[0].type, "update_food_note");
  assert.equal(applied[0].result.id, note.id);
  assert.equal(repo.listFoodNotes(10).length, 1, "no duplicate meal");
  const parsed = repo.getFoodNote(note.id).parsed;
  assert.equal(parsed.kcal, 454 + 64);
  assert.equal(parsed.protein_g, 55);
  assert.equal(parsed.fiber_g, 6, "3 + 2.7, stored whole");
  assert.deepEqual(rowsOf(note.id).at(-1), ["Avocado", "40 g", 64]);
  assert.equal(rowsOf(note.id).length, 6, "every other row stays as logged");
  assert.equal(repo.getDayIntake(repo.getFoodNote(note.id).date).totals.kcal, 518);
});

test("'actually it was two slices' scales that row from its stored estimate", () => {
  const note = logPlate();
  applyChatActions(
    { actions: [{ type: "update_food_note", id: note.id, ingredients: [{ item: "Sourdough toast", amount: "2 slices" }] }] },
    { agent: "stub", message: "actually it was two slices" }
  );
  const row = repo.getFoodNote(note.id).parsed.ingredients[1];
  assert.equal(row.amount, "2 slices");
  assert.equal(row.kcal, 160);
  assert.equal(row.basis, "user_report", "the quantity is now the athlete's own");
  assert.equal(repo.getFoodNote(note.id).parsed.kcal, 454 + 80);
});

test("'there was no cheddar' drops the row and its share of the total", () => {
  const note = logPlate();
  applyChatActions(
    { actions: [{ type: "update_food_note", id: note.id, remove_items: ["cheddar"] }] },
    { agent: "stub", message: "there was no cheese actually" }
  );
  assert.deepEqual(
    rowsOf(note.id).map(([item]) => item),
    ["Chicken breast", "Sourdough toast", "Mixed greens", "Olive oil"]
  );
  assert.equal(repo.getFoodNote(note.id).parsed.kcal, 454 - 80);
});

test("a meal stored with only a flat items list keeps those names when a row joins", () => {
  const note = repo.addFoodNote("dinner", "", { summary: "Curry", kcal: 700, items: ["chicken curry", "rice"] });
  applyChatActions(
    { actions: [{ type: "update_food_note", id: note.id, ingredients: [{ item: "Naan", amount: "1 piece", kcal: 260 }] }] },
    { agent: "stub", message: "and a naan with it" }
  );
  const parsed = repo.getFoodNote(note.id).parsed;
  assert.deepEqual(
    parsed.ingredients.map((row) => row.item),
    ["chicken curry", "rice", "Naan"]
  );
  assert.equal(parsed.kcal, 960);
});

test("a correction with no rows keeps the old totals-only path", () => {
  const note = logPlate();
  applyChatActions(
    { actions: [{ type: "update_food_note", id: note.id, kcal: 500 }] },
    { agent: "stub", message: "that was more like 500 calories" }
  );
  assert.equal(repo.getFoodNote(note.id).parsed.kcal, 500);
  assert.equal(rowsOf(note.id).length, 5);
});

// ---------- the thread: the original message reads the amended meal ----------

test("the original chat message's compact summary reads the amended meal", () => {
  const note = logPlate();
  const message = repo.addChatMessage("assistant", "Logged your lunch.", "stub", {
    applied: [{ type: "log_food", result: { id: note.id, meal: "lunch" } }],
  });
  applyChatActions(
    { actions: [{ type: "update_food_note", id: note.id, ingredients: [{ item: "Avocado", amount: "40 g", kcal: 64, protein_g: 1 }] }] },
    { agent: "stub", message: "oh and 40 g of avocado" }
  );
  const food = repo.getChatMessage(message.id).meta.applied[0].result.food;
  assert.equal(food.kcal, 518);
  assert.equal(food.ingredient_count, 6);
  assert.deepEqual(
    food.ingredients.map((row) => row.item),
    ["Chicken breast", "Sourdough toast", "Cheddar", "Mixed greens", "Olive oil", "Avocado"]
  );
});

test("'no no not the whole bar ... one piece' scales a 530 kcal chocolate bar row down to one square (~53 kcal) and refines a clock-slotted breakfast to snack", () => {
  const note = repo.addFoodNote(
    "breakfast",
    "I had a block of Lindt excellenece dark chocolate with raspberry\n\nand pour over coffee.",
    {
      summary: "Lindt dark chocolate with raspberry and pour over coffee",
      meal_inferred: true, // chat capture stamps the slot the clock chose
      ingredients: [
        {
          item: "Lindt Excellence dark chocolate with raspberry",
          amount: "1 bar (100 g)",
          kcal: 530,
          protein_g: 7,
          carbs_g: 48,
          fat_g: 31,
          fiber_g: 6,
        },
        { item: "Pour over coffee", amount: "1 cup", kcal: 2, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
      ],
      kcal: 532,
      protein_g: 7,
      carbs_g: 48,
      fat_g: 31,
      fiber_g: 6,
      basis: "estimated_from_foods",
      confidence: "medium",
    }
  );
  const message = repo.addChatMessage("assistant", "Logged your breakfast.", "stub", {
    applied: [{ type: "log_food", result: { id: note.id, meal: "breakfast" } }],
  });

  // Even when the model omits row-level macros on the amended row (or slightly varies the item name),
  // the server scales the 100 g bar down to 1 square (10 g) and refines the slot from breakfast to snack.
  const { applied } = applyChatActions(
    {
      actions: [
        {
          type: "update_food_note",
          id: note.id,
          ingredients: [{ item: "Lindt excellenece dark chocolate with raspberry", amount: "1 square" }],
        },
      ],
    },
    { agent: "stub", message: "no no not the whole bar ... one piece, one small cut out block of the bar." }
  );

  assert.equal(applied[0].result.meal, "snack");
  assert.equal(applied[0].result.parsed.kcal, 55);
  assert.equal(applied[0].result.parsed.protein_g, 1);

  const updated = repo.getFoodNote(note.id);
  assert.equal(updated.meal, "snack");
  assert.equal(updated.parsed.kcal, 55);
  assert.equal(updated.parsed.ingredients[0].amount, "1 square");
  assert.equal(updated.parsed.ingredients[0].kcal, 53);

  const hydrated = repo.getChatMessage(message.id).meta.applied[0].result;
  assert.equal(hydrated.meal, "snack");
  assert.equal(hydrated.food.meal, "snack");
  assert.equal(hydrated.food.kcal, 55);
  assert.equal(hydrated.food.protein_g, 1);
});


test("enrichment never re-slots a meal the person picked (no meal_inferred stamp)", async () => {
  const { applyFoodEstimate } = await import("../dist/enrich.js");
  const note = repo.addFoodNote("breakfast", "black coffee", { summary: "black coffee" });
  applyFoodEstimate(note.id, { kcal: 5, protein_g: 0, carbs_g: 0, fat_g: 0, summary: "black coffee" });
  assert.equal(repo.getFoodNote(note.id).meal, "breakfast");
});
