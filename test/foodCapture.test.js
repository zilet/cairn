// The ONE food-capture contract (src/foodCapture.ts).
//
// Three surfaces ask an agent to describe a meal — free-text enrichment, chat's
// `log_food` action, and the plate-photo vision read — and they had drifted apart:
// chat never asked for nutrition_pattern at all (0% of chat-logged meals carried
// one, and chat is ~two thirds of all logging), the photo path asked for quantities
// folded into display prose instead of ingredient rows, no path asked for
// ingredient-level fiber (1% coverage against 99% at meal level), and only photos
// carried any provenance.
//
// These tests pin the contract itself — that all three declare the same shape, that
// a payload from any of them lands through the same coercion, and above all that an
// ESTIMATE NEVER BECOMES INDISTINGUISHABLE FROM A MEASUREMENT. The agent never runs
// in the harness (offline, deterministic), so every path is exercised with a
// hand-built payload.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { applyFoodPhoto } from "../dist/enrich.js";
import { applyChatActions } from "../dist/chatTurns.js";
import {
  FOOD_BASIS_VALUES,
  FOOD_CONFIDENCE_BANDS,
  coerceFoodIngredients,
  coerceFoodProvenance,
  coerceNutritionPattern,
  foodMacroTotalsFrom,
  normalizeFoodCaptureParsed,
} from "../dist/foodCapture.js";
import { buildEnrichPrompt, buildFoodPhotoPrompt } from "../dist/prompt.js";
import { CHAT_ACTION_PROMPT_SPECS, renderChatActionSchema } from "../dist/chatActions.js";

beforeEach(() => {
  for (const t of ["food_notes", "chat_turns", "chat_messages", "memory"]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist */
    }
  }
});

function seedPhotoNote(parsed = { summary: "lunch" }) {
  return repo.addFoodNote("lunch", "", parsed, "/abs/uploads/plate.jpg");
}

// ---- the three contracts stay in agreement -------------------------------------

test("all three food contracts declare the same ingredient rows, pattern block and provenance", () => {
  const contracts = {
    text: buildEnrichPrompt("food", "chicken and rice"),
    photo: buildFoodPhotoPrompt("/private/tmp/plate.jpg"),
    chat: renderChatActionSchema(["log_food"]),
  };
  for (const [name, contract] of Object.entries(contracts)) {
    // Ingredient rows with the quantity as its OWN field — never folded into prose.
    assert.match(contract, /"ingredients":/, `${name} asks for ingredient rows`);
    assert.match(contract, /"amount": "<quantity as its own field/, `${name} keeps the quantity a field`);
    // Fiber is built up like every other macro rather than guessed from the top down.
    for (const key of ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"]) {
      assert.match(contract, new RegExp(`"${key}": <number\\|null>`), `${name} asks each row for ${key}`);
    }
    // The bands that correlate with a blood panel.
    assert.match(contract, /"nutrition_pattern":/, `${name} asks for nutrition_pattern`);
    for (const band of ["sodium", "potassium", "calcium", "iron", "saturated_fat", "added_sugar"]) {
      assert.match(contract, new RegExp(`"${band}": "low\\|moderate\\|high\\|unknown"`), `${name} asks for ${band}`);
    }
    assert.match(contract, /"omega_3_source"/, `${name} asks for omega-3`);
    // Provenance on the entry itself, one vocabulary everywhere.
    assert.match(
      contract,
      new RegExp(`"confidence": "${FOOD_CONFIDENCE_BANDS.join("\\|")}", "basis": "${FOOD_BASIS_VALUES.join("\\|")}"`),
      `${name} carries entry-level confidence + basis`
    );
  }
});

test("the chat log_food contract explains that a band is honest and an estimate is not a measurement", () => {
  const guidance = CHAT_ACTION_PROMPT_SPECS.log_food.guidance.join("\n");
  assert.match(guidance, /never be made to look like a measurement/i);
  assert.match(guidance, /bloodwork/i, "chat is told WHY the pattern block matters");
  // The calm log: never a moral register, never a score.
  for (const word of ["treat", "cheat", "indulgent", "guilty"]) {
    assert.doesNotMatch(guidance, new RegExp(`\\b${word}\\b`, "i"), `no moralizing (${word})`);
  }
  assert.doesNotMatch(guidance, /\b\d{1,3}\s*%/, "no percentage score anywhere in the contract");
});

// ---- 1. chat log_food now produces a nutrition_pattern --------------------------

test("a chat-logged meal carries a nutrition_pattern through the shared coercion", () => {
  const { applied } = applyChatActions(
    {
      actions: [
        {
          type: "log_food",
          meal: "dinner",
          summary: "Salmon, rice and greens",
          kcal: 640,
          protein_g: 48,
          carbs_g: 55,
          fat_g: 24,
          fiber_g: 7,
          nutrition_pattern: {
            sodium: "MODERATE",
            potassium: "high",
            iron: "low",
            saturated_fat: "low",
            added_sugar: "low",
            saturated_fat_g: 4.44,
            unsaturated_fat_g: 18,
            omega_3_source: true,
            caffeine_mg: 0,
            food_quality: "mostly_whole",
            sodium_mg: 1843.27,
            confidence: "medium",
            basis: "estimated_from_foods",
          },
        },
      ],
    },
    { agent: "stub", message: "salmon, rice and greens for dinner" }
  );
  assert.equal(applied.length, 1);
  const stored = repo.getFoodNote(applied[0].result.id).parsed;
  const pattern = stored.nutrition_pattern;
  assert.ok(pattern, "chat is ~two thirds of all logging — this is the path that was emitting none");
  assert.equal(pattern.sodium, "moderate", "bands are normalized, not stored as typed");
  assert.equal(pattern.potassium, "high");
  assert.equal(pattern.iron, "low");
  assert.equal(pattern.omega_3_source, true);
  assert.equal(pattern.food_quality, "mostly_whole");
  assert.equal(pattern.saturated_fat_g, 4.4, "one decimal, not false precision");
  assert.equal("sodium_mg" in pattern, false, "an invented micronutrient milligram is refused");
  assert.equal(pattern.confidence, "medium");
  assert.equal(pattern.basis, "estimated_from_foods");
});

test("a chat-logged meal with junk macros stores nulls, never the raw model text", () => {
  const { applied } = applyChatActions(
    {
      actions: [
        { type: "log_food", meal: "snack", summary: "A banana", kcal: "105", protein_g: "about one", fat_g: -4 },
      ],
    },
    { agent: "stub", message: "had a banana" }
  );
  const stored = repo.getFoodNote(applied[0].result.id).parsed;
  assert.equal(stored.kcal, 105, "a string number is coerced, not stored as a string");
  assert.equal(stored.protein_g, null, "unparseable prose becomes null, never a fabricated number");
  assert.equal(stored.fat_g, 0, "a negative macro floors at 0");
});

// ---- 2. the photo path emits structured ingredients -----------------------------

test("a photo-logged meal stores ingredient rows with amounts as fields, not prose", () => {
  const note = seedPhotoNote({ summary: "breakfast" });
  const wrote = applyFoodPhoto(note.id, {
    summary: "Eggs, salmon and greens",
    items: ["scrambled eggs (~2 eggs)", "smoked salmon (~70 g)"],
    ingredients: [
      { item: "Scrambled eggs", amount: "~2 eggs", kcal: 160, protein_g: 13, carbs_g: 1, fat_g: 11, fiber_g: 0 },
      { item: "Smoked salmon", amount: "~70 g", kcal: 120, protein_g: 15, carbs_g: 0, fat_g: 6, fiber_g: 0 },
      { item: "Spinach and peppers", amount: "~2 cups", kcal: 45, protein_g: 2, carbs_g: 9, fat_g: 0, fiber_g: 4 },
    ],
    confidence: "medium",
  });
  assert.equal(wrote, true);
  const p = repo.getFoodNote(note.id).parsed;
  assert.equal(p.ingredients.length, 3);
  assert.deepEqual(p.ingredients[1], {
    item: "Smoked salmon",
    amount: "~70 g",
    kcal: 120,
    protein_g: 15,
    carbs_g: 0,
    fat_g: 6,
    fiber_g: 0,
  });
  assert.deepEqual(p.items, ["scrambled eggs (~2 eggs)", "smoked salmon (~70 g)"], "display items are kept as-is");
  // Totals are built up from the rows the vision read gave, not guessed separately.
  assert.equal(p.kcal, 325);
  assert.equal(p.protein_g, 30);
  assert.equal(p.fiber_g, 4);
});

// ---- 3. fiber is built up from ingredients in all three paths --------------------

test("fiber is built up from ingredient rows on the chat path", () => {
  const { applied } = applyChatActions(
    {
      actions: [
        {
          type: "log_food",
          meal: "lunch",
          summary: "Lentil bowl",
          kcal: 520,
          ingredients: [
            { item: "Lentils", amount: "1 cup", kcal: 230, protein_g: 18, carbs_g: 40, fat_g: 1, fiber_g: 15.6 },
            { item: "Brown rice", amount: "3/4 cup", kcal: 165, protein_g: 4, carbs_g: 35, fat_g: 1, fiber_g: 2.9 },
            { item: "Olive oil", amount: "1 tbsp", kcal: 120, protein_g: 0, carbs_g: 0, fat_g: 14, fiber_g: 0 },
          ],
        },
      ],
    },
    { agent: "stub", message: "lentil bowl for lunch" }
  );
  const stored = repo.getFoodNote(applied[0].result.id).parsed;
  assert.equal(stored.fiber_g, 19, "19 g of fiber summed from the rows, not a top-down guess");
  assert.equal(stored.protein_g, 22, "every macro builds up the same way");
  assert.equal(stored.kcal, 520, "a STATED meal total still wins over the sum");
  assert.equal(stored.ingredients.length, 3);
});

test("fiber is built up from ingredient rows on the photo path", () => {
  const note = seedPhotoNote({ summary: "dinner" });
  applyFoodPhoto(note.id, {
    summary: "Chili and cornbread",
    ingredients: [
      { item: "Bean chili", amount: "~2 cups", kcal: 380, protein_g: 22, carbs_g: 52, fat_g: 9, fiber_g: 14 },
      { item: "Cornbread", amount: "1 slice", kcal: 190, protein_g: 4, carbs_g: 28, fat_g: 6, fiber_g: 1.5 },
    ],
  });
  const p = repo.getFoodNote(note.id).parsed;
  assert.equal(p.fiber_g, 16, "15.5 rounds to 16 at the meal level");
  assert.equal(p.kcal, 570);
});

test("foodMacroTotalsFrom is the one summation, and null when there is nothing to sum", () => {
  assert.equal(foodMacroTotalsFrom(null), null);
  assert.equal(foodMacroTotalsFrom([{ item: "Water" }]), null, "rows with no macros sum to nothing");
  assert.deepEqual(foodMacroTotalsFrom([{ fiber_g: 3 }, { fiber_g: "2" }]), { fiber_g: 5 });
});

// ---- 4. every entry carries confidence and a basis that reflects how it came ----

test("a stated weight and a photo guess are never stored the same way", () => {
  // The athlete weighed it and said so.
  const { applied } = applyChatActions(
    {
      actions: [
        {
          type: "log_food",
          meal: "lunch",
          summary: "Chicken breast and rice",
          kcal: 610,
          protein_g: 62,
          confidence: "high",
          basis: "user_report",
          ingredients: [
            { item: "Chicken breast", amount: "205 g", kcal: 340, protein_g: 62, basis: "user_report" },
            { item: "Jasmine rice", amount: "~1 cup", kcal: 270, protein_g: 4, basis: "estimated_from_foods" },
          ],
        },
      ],
    },
    { agent: "stub", message: "205 g of chicken breast, weighed, with about a cup of rice" }
  );
  const measured = repo.getFoodNote(applied[0].result.id).parsed;
  assert.equal(measured.confidence, "high");
  assert.equal(measured.basis, "user_report", "a stated weight is a report, not an inference");
  assert.equal(measured.ingredients[0].basis, "user_report", "the weighed row keeps its own basis");
  assert.equal(measured.ingredients[1].basis, "estimated_from_foods", "the eyeballed row stays an estimate");

  // The same numbers read off a picture.
  const note = seedPhotoNote({ summary: "lunch" });
  applyFoodPhoto(note.id, { summary: "Chicken and rice", kcal: 610, protein_g: 62 });
  const guessed = repo.getFoodNote(note.id).parsed;
  assert.equal(guessed.basis, "photo", "an inference off a plate photo says so");
  assert.equal(guessed.confidence, "low");
  assert.notEqual(guessed.basis, measured.basis, "the fuel maths can tell these two apart");
});

test("a chat estimate never claims user_report by default", () => {
  const { applied } = applyChatActions(
    { actions: [{ type: "log_food", meal: "snack", summary: "Handful of almonds", kcal: 170 }] },
    { agent: "stub", message: "had some almonds" }
  );
  const stored = repo.getFoodNote(applied[0].result.id).parsed;
  assert.equal(stored.basis, "estimated_from_foods", "silence means inferred, never measured");
  assert.equal(stored.confidence, "low");
});

test("an off-contract basis falls back to how the path actually obtained the numbers", () => {
  assert.deepEqual(coerceFoodProvenance({ confidence: "high", basis: "vibes" }, "photo"), {
    confidence: "high",
    basis: "photo",
  });
  assert.deepEqual(coerceFoodProvenance(null, "estimated_from_foods"), {
    confidence: "low",
    basis: "estimated_from_foods",
  });
  assert.deepEqual(coerceFoodProvenance({ confidence: 0.92 }, "label"), { confidence: "low", basis: "label" });
});

// ---- the coercion refuses invented precision ------------------------------------

test("ingredient rows are coerced: junk dropped, negatives floored, nameless rows refused", () => {
  const rows = coerceFoodIngredients([
    { item: "Oats", amount: "80 g", kcal: "300", protein_g: 10.44, fiber_g: 8, basis: "label" },
    { amount: "1 cup", kcal: 200 },
    { item: "Butter", fat_g: -5, kcal: 99999 },
    "Black coffee",
    null,
  ]);
  assert.equal(rows.length, 3, "the nameless row and the null are dropped");
  assert.equal(rows[0].kcal, 300, "a string number is coerced");
  assert.equal(rows[0].protein_g, 10.4, "one decimal on a row, no false precision");
  assert.equal(rows[0].basis, "label");
  assert.equal(rows[1].fat_g, 0, "a negative macro floors at 0");
  assert.equal(rows[1].kcal, 5000, "an absurd row clamps to the shared ceiling");
  assert.deepEqual(rows[2], { item: "Black coffee" }, "a bare string is a valid row with no numbers");
  assert.equal(coerceFoodIngredients("not an array"), null, "no ingredients field at all is distinguishable");
});

test("normalizeFoodCaptureParsed nulls what it cannot estimate rather than fabricating it", () => {
  const parsed = normalizeFoodCaptureParsed(
    { summary: "ignored", items: [{ item: "Toast", amount: "1 slice" }], notes: "  " },
    { summary: "Toast", fallbackBasis: "estimated_from_foods" }
  );
  assert.equal(parsed.summary, "Toast", "the caller's resolved summary wins");
  assert.deepEqual(parsed.items, ["Toast (1 slice)"]);
  for (const key of ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"]) {
    assert.equal(parsed[key], null, `${key} is null, never invented`);
  }
  assert.equal(parsed.notes, null);
  assert.equal(parsed.nutrition_pattern, undefined, "no pattern block is honest when there is nothing to say");
  assert.equal(parsed.basis, "estimated_from_foods");
});

test("a pattern block carrying nothing but provenance is not stored", () => {
  assert.equal(coerceNutritionPattern({ confidence: "high", basis: "label" }, "estimated_from_foods"), null);
  assert.equal(coerceNutritionPattern(null, "photo"), null);
});
