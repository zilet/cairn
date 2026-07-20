import assert from "node:assert/strict";
import test from "node:test";
import {
  hasPlanProposalActions,
  isExerciseExplanationResult,
  isHealthReviewResult,
  isHealthSynthesisResult,
  isInsightResult,
  isMealPlanResult,
  isMealPlanStructureResult,
  isMealSwapResult,
  isNutritionCheckinResult,
  isPlanProposalResult,
  isReactionNarrativeResult,
  isRecipeResult,
  isReconciliationResult,
  isSessionSuggestionResult,
  isVerifyResult,
  isWeekAheadResult,
  normalizeSessionSuggestionResult,
} from "../dist/agent-contracts.js";
import { repo } from "./_seed.js";

test("agent contracts reject parseable wrong-operation objects", () => {
  const wrong = { summary: "Looks fine" };
  for (const accept of [
    isSessionSuggestionResult,
    isPlanProposalResult,
    isExerciseExplanationResult,
    isWeekAheadResult,
    isMealPlanResult,
    isNutritionCheckinResult,
    isMealSwapResult,
    isRecipeResult,
    isHealthReviewResult,
    isHealthSynthesisResult,
    isInsightResult,
    isReconciliationResult,
    isReactionNarrativeResult,
  ]) assert.equal(accept(wrong), false, accept.name);
});

test("training contracts require useful prescriptions before rotation stops", () => {
  const session = (item) => ({ name: "Lower body", why: "Recovered and due.", items: [item] });
  assert.equal(isSessionSuggestionResult(session({ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 })), true);
  assert.equal(
    isSessionSuggestionResult(session({ exercise: "Back Squat", kind: "mobility", sets: 3, rep_low: 8 })),
    false
  );
  assert.equal(isSessionSuggestionResult(session({ exercise: "Back Squat", sets: 3 })), false);
  assert.equal(isSessionSuggestionResult(session({ exercise: "Plank", mode: "timed", sets: 3 })), false);
  assert.equal(
    isSessionSuggestionResult(session({ exercise: "Plank", sets: 3, target_seconds: 45 })),
    true,
    "positive seconds infer timed mode"
  );
  repo.upsertExercise({ name: "Contract Timer", mode: "timed" });
  assert.equal(
    isSessionSuggestionResult(session({ exercise: "Contract Timer", sets: 3, rep_low: 8 })),
    false,
    "DB-backed timed mode cannot accept a reps prescription"
  );
  assert.equal(
    isSessionSuggestionResult(session({ exercise: "Contract Timer", sets: 3, target_seconds: 45 })),
    true,
    "DB-backed timed mode and positive seconds agree"
  );
  assert.equal(
    isSessionSuggestionResult({ name: "Run", why: "Easy aerobic work.", items: [{ kind: "cardio", exercise: "Run" }] }),
    false
  );
  const longCardio = normalizeSessionSuggestionResult(
    session({ kind: "cardio", exercise: "Run", target_duration_min: 361 })
  );
  assert.equal(longCardio.items[0].target_duration_min, 360);

  assert.equal(isPlanProposalResult({ summary: "Hold steady.", changes: [] }), true);
  assert.equal(hasPlanProposalActions({ summary: "Hold steady.", changes: [] }), false);
  assert.equal(isPlanProposalResult({ summary: "Progress squat.", changes: [{ day_number: 2, exercise: "Back Squat", target_weight: 225 }] }), true);
  assert.equal(hasPlanProposalActions({ summary: "Progress squat.", changes: [{ day_number: 2, exercise: "Back Squat" }] }), true);
  assert.equal(isPlanProposalResult({ summary: "Restructure.", days: [] }), false);

  assert.equal(isExerciseExplanationResult({ setup: "Brace", move: "Drive", feel: "Quads" }), true);
  assert.equal(isReactionNarrativeResult({ narrative: "You respond best to small load steps." }), true);
});

test("nutrition contracts do not turn malformed changes into calm no-change answers", () => {
  assert.equal(isNutritionCheckinResult({ change: false, summary: "Stay here this week." }), true);
  assert.equal(isNutritionCheckinResult({ change: true, summary: "Add fuel.", nutrition: { target_kcal: 2200 } }), false);
  assert.equal(isNutritionCheckinResult({
    change: true,
    summary: "Add a little fuel.",
    nutrition: { target_kcal: 2200, protein_g: 175 },
  }), true);

  const days = Array.from({ length: 7 }, (_, i) => ({
    day: `D${i + 1}`,
    meals: [
      { name: "Protein bowl", kcal: 1050, protein_g: 85, fiber_g: 15 },
      { name: "Salmon plate", kcal: 1050, protein_g: 90, fiber_g: 15 },
    ],
  }));
  assert.equal(isMealPlanResult({ daily_kcal: 2100, daily_protein_g: 175, daily_fiber_g: 30, days }), true);
  assert.equal(
    isMealPlanResult({ daily_kcal: 2100, daily_protein_g: 175, daily_fiber_g: 30, days: days.slice(0, 2) }),
    false
  );
  const underfed = days.map((day) => ({
    ...day,
    meals: [{ name: "Small bowl", kcal: 900, protein_g: 60, fiber_g: 30 }],
  }));
  assert.equal(
    isMealPlanStructureResult({ daily_kcal: 2300, daily_protein_g: 175, daily_fiber_g: 30, days: underfed }),
    true
  );
  assert.equal(
    isMealPlanResult({ daily_kcal: 2300, daily_protein_g: 175, daily_fiber_g: 30, days: underfed }),
    false,
    "a valid headline cannot launder materially inadequate daily meals"
  );
  assert.equal(isMealSwapResult({ name: "Salmon bowl", kcal: 620, protein_g: 48, fiber_g: 8 }), true);
  assert.equal(isMealSwapResult({ name: "Fiber-unknown bowl", kcal: 620, protein_g: 48 }), false);
  assert.equal(isRecipeResult({ ingredients: [{ item: "salmon", qty: "200 g" }], steps: [] }), true);
});

test("read contracts preserve legitimate silence but reject empty claimed insights", () => {
  assert.equal(isInsightResult({ found: false }), true);
  assert.equal(isInsightResult({ found: true, text: "" }), false);
  assert.equal(isInsightResult({ found: true, text: "Your recovery improves when the run stays easy." }), true);
  assert.equal(isHealthSynthesisResult({ found: true, headline: "Lipids lead." }), true);
  assert.equal(isHealthReviewResult({ headline: "Your current picture" }), true);
  assert.equal(isReconciliationResult({ groups: [] }), true);

  const days = ["lift", "run", "rest"].map((kind, i) => ({ day: `D${i}`, kind, label: kind }));
  assert.equal(isWeekAheadResult({ days, summary: "Lift, easy run, then recover." }), true);
  assert.equal(isWeekAheadResult({ days: [{ day: "D1", kind: "hard", label: "Go" }], summary: "Push." }), false);
});

test("verify contracts only mark explicit clean passes or valid repaired drafts as checked", () => {
  const validDraft = (draft) => draft?.kind === "valid";
  assert.equal(isVerifyResult({ ok: true, violations: [], fixed_draft: null }, validDraft), true);
  assert.equal(isVerifyResult({ ok: true, violations: ["problem"], fixed_draft: null }, validDraft), false);
  assert.equal(isVerifyResult({ ok: false, violations: ["protein floor"], fixed_draft: { kind: "valid" } }, validDraft), true);
  assert.equal(isVerifyResult({ ok: false, violations: ["protein floor"], fixed_draft: { kind: "wrong" } }, validDraft), false);
  assert.equal(isVerifyResult({ message: "looks good" }, validDraft), false);
});
