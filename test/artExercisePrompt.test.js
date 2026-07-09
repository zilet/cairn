// Exercise-aware art prompt (Track C, src/art.ts). The background 'exercise'
// enrichment job generates a clay-figurine image under the BARE-NAME cache key but
// with a muscle-group/equipment-enriched PROMPT, so the tile shows a clearer image
// while the PWA's plain `?q=<name>` request still resolves to it. These assert the
// pure prompt builder: context sharpens the exercise prompt, and the no-context
// path is byte-for-byte the original (so existing cached art never drifts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stylePrompt, exerciseContextClause } from "../dist/art.js";

test("exerciseContextClause folds muscle group + equipment into a compact clause", () => {
  assert.equal(
    exerciseContextClause({ muscle_group: "back", equipment: "a cable machine" }),
    " — a back exercise using a cable machine",
  );
  assert.equal(exerciseContextClause({ muscle_group: "quads" }), " — a quads exercise");
  assert.equal(exerciseContextClause({ equipment: "a barbell" }), " — using a barbell");
});

test("exerciseContextClause is empty (no drift) when there's nothing useful to say", () => {
  assert.equal(exerciseContextClause(undefined), "");
  assert.equal(exerciseContextClause(null), "");
  assert.equal(exerciseContextClause({}), "");
  assert.equal(exerciseContextClause({ muscle_group: "", equipment: "" }), "");
  // "other" carries no signal — it's dropped so the prompt isn't muddied.
  assert.equal(exerciseContextClause({ muscle_group: "other" }), "");
});

test("stylePrompt('exercise') embeds the context clause after the movement name", () => {
  const p = stylePrompt("exercise", "Single-Arm Lat Pulldown", { muscle_group: "back", equipment: "a cable machine" });
  assert.match(p, /performing Single-Arm Lat Pulldown — a back exercise using a cable machine,/);
  assert.match(p, /clay figurine/, "still the same clay-figurine studio style");
});

test("stylePrompt('exercise') without context is unchanged (existing cache keys/prompts intact)", () => {
  const bare = stylePrompt("exercise", "Bench Press");
  const explicitlyEmpty = stylePrompt("exercise", "Bench Press", null);
  assert.equal(bare, explicitlyEmpty);
  assert.match(bare, /performing Bench Press, terracotta and warm earthen tones/);
  assert.doesNotMatch(bare, /exercise using/, "no context clause leaks into the name-only prompt");
});

test("stylePrompt for food/activity ignores context (exercise-only feature)", () => {
  const food = stylePrompt("food", "oatmeal with blueberries", { muscle_group: "back" });
  assert.match(food, /studio food photography of oatmeal with blueberries/);
  assert.doesNotMatch(food, /exercise using|back exercise/);
  const activity = stylePrompt("activity", "running", { equipment: "a treadmill" });
  assert.match(activity, /doing running, terracotta/);
  assert.doesNotMatch(activity, /using a treadmill/);
});
