// Exercise-aware art prompt (Track C, src/art.ts). The background 'exercise'
// enrichment job generates a clay-figurine image under the BARE-NAME cache key but
// with a muscle-group/equipment-enriched PROMPT, so the tile shows a clearer image
// while the PWA's plain `?q=<name>` request still resolves to it. These assert the
// pure prompt builder: context sharpens the exercise prompt, and the no-context
// path is byte-for-byte the original (so existing cached art never drifts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stylePrompt, exerciseContextClause, exercisePoseClause, cacheKey } from "../dist/art.js";
import { exercisePoseFromExplanation } from "../dist/coachOps.js";

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

// ---- pose ----------------------------------------------------------------
// The name alone under-specifies a movement, so the image model leaned on the
// style references and rendered "Cable Lateral Raise" as a plank. The how-to
// guide's setup + move sentences now describe the pose in the prompt.

test("exercisePoseClause sanitizes the movement description into one plain run", () => {
  assert.equal(
    exercisePoseClause({ pose: "Stand side-on to a low cable\npulley.  Raise the arm out to shoulder height." }),
    " — the pose: Stand side-on to a low cable pulley. Raise the arm out to shoulder height",
  );
  assert.equal(exercisePoseClause({ pose: "   " }), "");
  assert.equal(exercisePoseClause({}), "");
  assert.equal(exercisePoseClause(null), "");
  assert.equal(exercisePoseClause(undefined), "");
});

test("exercisePoseClause caps the description so it can't drown the styling text", () => {
  const clause = exercisePoseClause({ pose: "word ".repeat(200) });
  assert.ok(clause.length <= " — the pose: ".length + 220, `clause was ${clause.length} chars`);
  assert.doesNotMatch(clause, /\s$/, "trimmed at a word boundary");
});

test("stylePrompt('exercise') describes the pose after the context clause", () => {
  const p = stylePrompt("exercise", "Cable Lateral Raise", {
    muscle_group: "shoulders",
    equipment: "a cable machine",
    pose: "Stand side-on to a low pulley holding the handle in the outside hand. Raise the straight arm out to the side to shoulder height.",
  });
  assert.match(
    p,
    /performing Cable Lateral Raise — a shoulders exercise using a cable machine — the pose: Stand side-on to a low pulley holding the handle in the outside hand\. Raise the straight arm out to the side to shoulder height, terracotta/,
  );
  assert.match(p, /clay figurine/, "still the same clay-figurine studio style");
});

test("the pose never touches the cache key (a bare ?q= request still hits it)", () => {
  assert.equal(cacheKey("exercise", "Cable Lateral Raise"), cacheKey("exercise", "Cable Lateral Raise"));
  const withPose = stylePrompt("exercise", "Cable Lateral Raise", { pose: "Raise the arm to the side" });
  const without = stylePrompt("exercise", "Cable Lateral Raise");
  assert.notEqual(withPose, without, "the prompt does change");
  // cacheKey takes only (kind, text) — there is no context argument to leak into it.
  assert.equal(cacheKey.length, 2);
});

test("no pose → the prompt is byte-for-byte what it is today", () => {
  const bare = stylePrompt("exercise", "Bench Press", { muscle_group: "chest" });
  assert.equal(bare, stylePrompt("exercise", "Bench Press", { muscle_group: "chest", pose: null }));
  assert.equal(bare, stylePrompt("exercise", "Bench Press", { muscle_group: "chest", pose: "" }));
  assert.doesNotMatch(bare, /the pose:/);
});

test("exercisePoseFromExplanation takes the first sentence of setup and move", () => {
  assert.equal(
    exercisePoseFromExplanation({
      setup: "Stand side-on to a low pulley. Feet hip width.",
      move: "Raise the arm out to shoulder height. Lower slowly.",
      feel: "Side delt.",
    }),
    "Stand side-on to a low pulley. Raise the arm out to shoulder height",
  );
  assert.equal(exercisePoseFromExplanation(null), null);
  assert.equal(exercisePoseFromExplanation(undefined), null);
  assert.equal(exercisePoseFromExplanation({ setup: "", move: "" }), null);
  assert.equal(exercisePoseFromExplanation({ move: "Press overhead" }), "Press overhead");
});

test("stylePrompt for food/activity ignores context (exercise-only feature)", () => {
  const food = stylePrompt("food", "oatmeal with blueberries", { muscle_group: "back" });
  assert.match(food, /studio food photography of oatmeal with blueberries/);
  assert.doesNotMatch(food, /exercise using|back exercise/);
  const activity = stylePrompt("activity", "running", { equipment: "a treadmill" });
  assert.match(activity, /doing running, terracotta/);
  assert.doesNotMatch(activity, /using a treadmill/);
});
