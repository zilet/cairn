import { test } from "node:test";
import assert from "node:assert/strict";
import { unresolvedConflictCeiling } from "../dist/domain/brain/conference-conflicts.js";
import { draftAgeCeilingDays, draftAgeDays, plainApplyRefusal } from "../dist/domain/brain/athlete-request-outcome.js";
import { nonClinicalRisk, thawRequestedTier } from "../dist/domain/brain/thaw-rereads.js";

// The pure halves of the autonomy routing, pinned on their own so a refactor of the
// services around them cannot quietly move a tier or an age ceiling.

test("an unresolved conflict holds by its kind: clinical floor, safety ask, trade-off heads-up under lead", () => {
  assert.equal(unresolvedConflictCeiling([], "lead"), null);
  assert.equal(unresolvedConflictCeiling(["clinical_autonomy", "injury_load"], "lead"), "clinician");
  for (const safety of ["injury_load", "allergy_meal", "medication_supplement"]) {
    assert.equal(unresolvedConflictCeiling([safety], "lead"), "ask");
    assert.equal(unresolvedConflictCeiling(["deficit_recovery", safety], "lead"), "ask");
  }
  assert.equal(unresolvedConflictCeiling(["deficit_recovery"], "lead"), "announce");
  assert.equal(unresolvedConflictCeiling(["race_strength"], "announce_first"), "ask");
  assert.equal(unresolvedConflictCeiling(["race_strength"], "review_everything"), "ask");
});

test("a held draft's age ceiling is two weeks for a restructure, one for anything else", () => {
  assert.equal(draftAgeCeilingDays({ kind: "training_structure" }), 14);
  assert.equal(draftAgeCeilingDays({ kind: "training_target" }), 7);
  assert.equal(draftAgeCeilingDays({ kind: "nutrition_target" }), 7);
  const now = Date.parse("2026-09-25T12:00:00Z");
  assert.equal(draftAgeDays({ created_at: "2026-09-20 12:00:00" }, now), 5);
  // Unreadable stamp: neither aged nor current.
  const unknown = draftAgeDays({ created_at: null }, now);
  assert.ok(Number.isNaN(unknown));
  assert.equal(unknown > 7, false);
  assert.equal(unknown <= 9, false);
});

test("an apply refusal reads as a sentence, and a machine error is never repeated", () => {
  assert.equal(plainApplyRefusal("Plan quality check failed: Day 2 has no main lift."), "Day 2 has no main lift.");
  assert.equal(plainApplyRefusal("the movement is gone"), "the movement is gone.");
  assert.equal(plainApplyRefusal("TypeError: x is undefined"), "it no longer fit the plan as it stands.");
  assert.equal(plainApplyRefusal("proposal 12 not found"), "it no longer fit the plan as it stands.");
  assert.equal(plainApplyRefusal(""), "it no longer fit the plan as it stands.");
});

test("a thaw re-offer carries the tier it was asked at, a clinician request reading as an ask", () => {
  const at = (requested_tier) => ({ policy_inputs: { requested_tier } });
  assert.equal(thawRequestedTier({}, "lead"), undefined);
  assert.equal(thawRequestedTier(at("observe"), "lead"), undefined);
  assert.equal(thawRequestedTier(at("quiet_apply"), "lead"), "quiet_apply");
  assert.equal(thawRequestedTier(at("ask"), "lead"), "announce");
  assert.equal(thawRequestedTier(at("clinician"), "lead"), "announce");
  assert.equal(thawRequestedTier(at("clinician"), "announce_first"), "ask");
  assert.equal(nonClinicalRisk("clinical"), "moderate");
  assert.equal(nonClinicalRisk("low"), "low");
});
