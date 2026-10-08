// Lab quantities inside stored prose follow the analyte the sentence names (nearest preceding),
// ranges convert at both ends; unit spellings, decimal commas and the insulin factor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";

const render = (text, marker, system = "si") => repo.renderLabQuantities(text, marker, system);

test("renderLabQuantities: a quantity belongs to the nearest PRECEDING analyte, not the row's marker", () => {
  // An LDL directive that quotes ApoB: the ApoB number converts by ApoB (g/L), not by LDL.
  assert.equal(render("Your LDL sits above 100 mg/dL; an ApoB of 120 mg/dL says the same.", "LDL-C"),
    "Your LDL sits above 2.59 mmol/L; an ApoB of 1.2 g/L says the same.");
  // Triglycerides in an LDL row: ×0.01129, not ×0.02586.
  assert.equal(render("LDL is high, and triglycerides below 150 mg/dL would help.", "LDL-C"),
    "LDL is high, and triglycerides below 1.69 mmol/L would help.");
  assert.doesNotMatch(render("triglycerides below 150 mg/dL", "LDL-C"), /3\.88/);
  // A vitamin D / ferritin sentence: same canonical unit (ng/mL), different SI maps.
  assert.equal(render("Vitamin D at 40 ng/mL and ferritin at 50 ng/mL", "Vitamin D"),
    "Vitamin D at 99.8 nmol/L and ferritin at 50 µg/L");
  assert.equal(render("Ferritin near 50 ng/mL, vitamin D near 40 ng/mL", "Ferritin"),
    "Ferritin near 50 µg/L, vitamin D near 99.8 nmol/L");
});

test("renderLabQuantities: a quantity with no analyte before it never borrows the row's marker over a named one", () => {
  // Nothing named before; the sentence names ApoB (same unit) -> two candidates with the row's LDL.
  assert.equal(render("120 mg/dL is where ApoB tends to land.", "LDL-C"), "120 mg/dL is where ApoB tends to land.");
  // Only the row's own analyte is in play -> it converts.
  assert.equal(render("Aim below 100 mg/dL.", "LDL-C"), "Aim below 2.59 mmol/L.");
  // Two analytes joined by a conjunction before the number: ambiguous, left as written.
  assert.equal(render("LDL or triglycerides above 150 mg/dL", "LDL-C"), "LDL or triglycerides above 150 mg/dL");
  assert.equal(render("calcium and creatinine near 9 mg/dL", null), "calcium and creatinine near 9 mg/dL");
});

test("renderLabQuantities: BOTH ends of a range convert, in the text's own dash", () => {
  assert.equal(render("keep glucose between 70-100 mg/dL", "Fasting glucose"), "keep glucose between 3.89-5.55 mmol/L");
  assert.equal(render("keep glucose between 70–100 mg/dL", "Fasting glucose"), "keep glucose between 3.89–5.55 mmol/L");
  assert.equal(render("glucose of 70 to 100 mg/dL", null), "glucose of 3.89 to 5.55 mmol/L");
  // Unknown analyte: the whole range stays exactly as written, never half-converted.
  assert.equal(render("a target of 70-100 mg/dL", null), "a target of 70-100 mg/dL");
  // US prose is untouched, and the neutral form hashes a range the same in either system.
  assert.equal(render("glucose 70-100 mg/dL", null, "us"), "glucose 70-100 mg/dL");
  assert.equal(repo.labQuantityNeutral("glucose 70-100 mg/dL"), repo.labQuantityNeutral("glucose 3.89-5.55 mmol/L"));
});
