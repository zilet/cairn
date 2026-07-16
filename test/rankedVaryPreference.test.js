// Wave 2 — preference-aware novelty (pure layer). The same-pattern variation menu
// gains a gentle, DETERMINISTIC re-rank from the athlete's 'preference' memories:
//   - a liked movement/equipment is boosted; a "dislikes X"/"hates X" one is demoted
//   - matching is exact/substring on distinctive tokens only (no NLP)
//   - it NEVER overrides injury/pattern constraints: it reorders the passing
//     candidate list, it never adds a candidate the upstream filter excluded
// Pure — no DB, no agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePreferenceMemories,
  preferenceSignal,
  preferenceRerank,
} from "../dist/repo/progression.js";
import { suggestAlternatives } from "../dist/repo/exercise-variations.js";

test("parsePreferenceMemories reads polarity (like vs dislike) and drops empties", () => {
  const parsed = parsePreferenceMemories([
    "loves front squats",
    "hates bulgarian split squats",
    "avoid overhead pressing, cranky shoulder",
    "not a fan of the leg press",
    "   ",
    null,
    "the and or to", // all stopwords → tokenless → dropped
  ]);
  assert.equal(parsed.length, 4, "empty + tokenless rows are dropped");
  assert.equal(parsed[0].polarity, 1, "a bare preference is a like");
  assert.equal(parsed[1].polarity, -1, "'hates X' is a dislike");
  assert.equal(parsed[2].polarity, -1, "'avoid X' is a dislike");
  assert.equal(parsed[3].polarity, -1, "'not a fan of X' is a dislike");
  assert.ok(parsed[0].tokens.has("front"), "the load-bearing token is kept");
  assert.ok(!parsed[0].tokens.has("loves"), "the polarity/generic word is dropped");
});

test("preferenceSignal boosts a liked movement's distinctive token, ignores the shared pattern noun", () => {
  const prefs = parsePreferenceMemories(["loves front squats"]);
  // Distinctive vs the original "Back Squat": "front" matches, the shared "squat" never counts.
  const front = preferenceSignal({ name: "Front Squat", equipment: "barbell" }, "Back Squat", prefs);
  const hack = preferenceSignal({ name: "Hack Squat", equipment: "machine" }, "Back Squat", prefs);
  assert.ok(front > 0, "the liked front squat scores positive");
  assert.equal(hack, 0, "an unrelated same-pattern squat is neutral (not lifted by 'squat')");
});

test("preferenceSignal demotes a disliked movement and honors an equipment preference", () => {
  const dislike = parsePreferenceMemories(["hates the bulgarian split squat"]);
  const bulg = preferenceSignal({ name: "Bulgarian Split Squat", equipment: "dumbbell" }, "Back Squat", dislike);
  assert.ok(bulg < 0, "the disliked movement scores negative");

  const equip = parsePreferenceMemories(["prefers dumbbell movements"]);
  const db = preferenceSignal({ name: "DB Goblet Squat", equipment: "dumbbell" }, "Back Squat", equip);
  const bar = preferenceSignal({ name: "Front Squat", equipment: "barbell" }, "Back Squat", equip);
  assert.ok(db > 0, "a dumbbell candidate is boosted by a dumbbell preference");
  assert.equal(bar, 0, "a barbell candidate isn't touched by a dumbbell preference");
});

test("preferenceRerank floats liked candidates up and sinks disliked ones, preserving order on ties", () => {
  const candidates = suggestAlternatives("Back Squat", { preferCompound: true, limit: 8 });
  assert.ok(candidates.length >= 3);

  const liked = preferenceRerank(candidates, "Back Squat", parsePreferenceMemories(["loves goblet squats"]));
  const gobletIdx = liked.findIndex((c) => /goblet/i.test(c.name));
  assert.ok(gobletIdx === 0, "a liked goblet squat is re-ranked to the front");

  const disliked = preferenceRerank(candidates, "Back Squat", parsePreferenceMemories(["hates front squats"]));
  assert.equal(disliked[disliked.length - 1].name.toLowerCase().includes("front"), true, "a disliked front squat sinks last");
  // Every candidate is still present — a demote reorders, never removes.
  assert.equal(disliked.length, candidates.length, "reranking never drops a candidate");

  // No preferences → identical order (stable no-op).
  const same = preferenceRerank(candidates, "Back Squat", []);
  assert.deepEqual(same.map((c) => c.name), candidates.map((c) => c.name));
});

test("injury constraints still win: a strong 'like' can never reintroduce an injury-excluded candidate", () => {
  // suggestAlternatives already drops every shoulder-risk press for a shoulder injury.
  const safe = suggestAlternatives("Barbell Bench Press", { injuryAreas: ["shoulder"], limit: 12 });
  assert.ok(!safe.some((c) => /incline db press/i.test(c.name)), "the shoulder-risk incline DB press is excluded upstream");

  // Even a strong preference for that exact excluded movement can't bring it back —
  // the re-rank only reorders the passing list.
  const reranked = preferenceRerank(safe, "Barbell Bench Press", parsePreferenceMemories(["loves the incline db press"]));
  assert.ok(!reranked.some((c) => /incline db press/i.test(c.name)), "preference never overrides the injury exclusion");
  assert.equal(reranked.length, safe.length, "the passing set is unchanged in size");
});
