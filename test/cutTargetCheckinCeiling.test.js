// The grounded ceiling on the adaptive-nutrition check-in (src/coachOps.ts,
// personalizeNutritionCheckinTarget).
//
// The failure this exists to prevent, verbatim from the live system: mid-cut, the
// accepted target was RAISED toward maintenance on the model's judgement of the
// week rather than on anything the athlete's own record said. The derivation in
// repo/cut-target.ts is the record's answer, and a suggested raise above it is a
// suggestion the evidence does not support.
//
// The three escapes are pinned as hard as the rule: a clamp can never manufacture
// a CUT, protective under-fuelling evidence passes straight through, and the
// lean-safe kcal floor still wins over the ceiling.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetTables } from "./_seed.js";
import { personalizeNutritionCheckinTarget } from "../dist/coachOps.js";

// A goal read shaped the way computeGoalCheck returns one: the server-owned
// effective target is what the boundary measures the model's delta from.
function goal(effectiveKcal, { floorKcal = 1_500, proteinG = 175 } = {}) {
  return {
    ok: true,
    recommended: { target_intake_kcal: floorKcal, protein_g: proteinG },
    effective_target: { target_kcal: effectiveKcal },
  };
}

function anchor(targetKcal, extra = {}) {
  return {
    target_kcal: targetKcal,
    tdee_kcal: targetKcal + 450,
    tdee_basis: "logged_reality",
    confidence: "high",
    deficit_kcal: 450,
    ...extra,
  };
}

beforeEach(() => {
  resetTables("profile", "nutrition_targets", "brain_decisions");
});

test("a raise above what the record supports is pulled back to the grounded anchor", () => {
  // The live shape: eating to 2250, the model wants 2600, the record says 2350.
  const out = personalizeNutritionCheckinTarget({ target_kcal: 2_600, delta_kcal: 350 }, goal(2_250), {
    cutAnchor: anchor(2_350),
  });
  assert.equal(out.target_kcal, 2_350, "the anchor, not the suggestion");
  assert.equal(out.cut_anchor.clamped, true);
  assert.equal(out.delta_kcal, 100, "and the reported delta is restated from the surviving number");
});

test("a raise the record DOES support passes through untouched", () => {
  const out = personalizeNutritionCheckinTarget({ target_kcal: 2_400 }, goal(2_250), { cutAnchor: anchor(2_600) });
  assert.equal(out.target_kcal, 2_400, "still inside what the evidence allows");
  assert.equal(out.cut_anchor.clamped, false);
});

test("the ceiling never manufactures a cut — it can only hold the target where it is", () => {
  // The anchor sits BELOW the number currently in force. A requested raise is
  // refused, but the athlete must not silently be dropped to the anchor either.
  const out = personalizeNutritionCheckinTarget({ target_kcal: 2_400, delta_kcal: 150 }, goal(2_250), {
    cutAnchor: anchor(2_050),
  });
  assert.equal(out.target_kcal, 2_250, "held at the target already in force");
  assert.equal(out.cut_anchor.clamped, true);
  assert.equal(out.delta_kcal, 0, "a refused raise is a hold, never a cut");
});

test("a LOWER suggestion is never touched by the ceiling", () => {
  const out = personalizeNutritionCheckinTarget({ target_kcal: 2_100 }, goal(2_250), { cutAnchor: anchor(2_350) });
  assert.equal(out.target_kcal, 2_100, "the ordinary bounded step, unchanged by the anchor");
  assert.equal(out.cut_anchor.clamped, false);
});

test("protective under-fuelling evidence is grounded evidence — it passes straight through", () => {
  const out = personalizeNutritionCheckinTarget({ target_kcal: 2_600 }, goal(2_250), {
    cutAnchor: anchor(2_350),
    protective: true,
  });
  assert.equal(out.target_kcal, 2_500, "the ordinary +250 ceiling still applies, the grounded one does not");
  assert.equal(out.cut_anchor.clamped, false);
});

test("the lean-safe kcal floor still wins over the ceiling", () => {
  // An anchor below the recommended floor may not drag the target under it.
  const out = personalizeNutritionCheckinTarget({ target_kcal: 2_400 }, goal(2_250, { floorKcal: 2_300 }), {
    cutAnchor: anchor(1_800),
  });
  assert.ok(out.target_kcal >= 2_300, `a safety floor is never subordinate to a ceiling; got ${out.target_kcal}`);
});

test("no anchor at all leaves the existing boundary exactly as it was", () => {
  const withAnchor = personalizeNutritionCheckinTarget({ target_kcal: 2_600 }, goal(2_250), {});
  const legacy = personalizeNutritionCheckinTarget({ target_kcal: 2_600 }, goal(2_250));
  assert.equal(withAnchor.target_kcal, 2_500, "the pre-existing +250 step boundary");
  assert.equal(legacy.target_kcal, 2_500);
  assert.equal(legacy.cut_anchor, undefined, "nothing is stamped when there is no cut to anchor to");
});

test("the anchor's provenance rides along so a surface can say where the number came from", () => {
  const out = personalizeNutritionCheckinTarget({ target_kcal: 2_600 }, goal(2_250), { cutAnchor: anchor(2_350) });
  assert.equal(out.cut_anchor.tdee_basis, "logged_reality");
  assert.equal(out.cut_anchor.confidence, "high");
  assert.equal(out.cut_anchor.tdee_kcal, 2_800);
  assert.equal(out.cut_anchor.deficit_kcal, 450);
});
