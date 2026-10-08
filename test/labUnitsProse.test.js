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

test("renderLabQuantities: the nearest analyte named is the subject, whatever its unit — Lp(a) never converts", () => {
  // Lp(a) is named last: its mg/dL is a mass reading with no fixed factor, never LDL's.
  assert.equal(render("LDL-C 130 mg/dL; Lp(a) 75 mg/dL is genetic.", "LDL-C"), "LDL-C 3.36 mmol/L; Lp(a) 75 mg/dL is genetic.");
  assert.equal(render("Lp(a) 75 mg/dL is genetic.", "LDL-C"), "Lp(a) 75 mg/dL is genetic.");
  assert.equal(render("Above 75 mg/dL, Lp(a) adds risk.", "LDL-C"), "Above 75 mg/dL, Lp(a) adds risk.");
  // Testosterone in ng/mL is not its canonical unit: never vitamin D's factor (13 nmol/L).
  assert.equal(render("Vitamin D is fine; testosterone 5.2 ng/mL is low.", null), "Vitamin D is fine; testosterone 5.2 ng/mL is low.");
  // A non-converting analyte in between ends the earlier one's reach.
  assert.equal(render("LDL is high and sodium near 140 mg/dL", "LDL-C"), "LDL is high and sodium near 140 mg/dL");
});

test("renderLabQuantities: a parenthetical aside is not the subject", () => {
  assert.equal(render("ApoB (the particle count behind LDL) is 120 mg/dL.", "LDL-C"), "ApoB (the particle count behind LDL) is 1.2 g/L.");
  assert.equal(render("ApoB (the particle count behind LDL) is 120 mg/dL.", null), "ApoB (the particle count behind LDL) is 1.2 g/L.");
  // A quantity INSIDE the parenthesis still reads the analyte before it.
  assert.equal(render("LDL (130 mg/dL) and ApoB (120 mg/dL)", null), "LDL (3.36 mmol/L) and ApoB (1.2 g/L)");
});

test("renderLabQuantities: an analyte named right after the quantity is its subject", () => {
  const stored =
    "correct for albumin (add ~0.8 mg/dL to the calcium for every 1 g/dL your albumin sits below 4.0 g/dL), since";
  assert.equal(
    render(stored, "Calcium"),
    "correct for albumin (add ~0.2 mmol/L to the calcium for every 10 g/L your albumin sits below 40 g/L), since"
  );
});

test("renderLabQuantities: a bare number joined to the quantity converts with it, or nothing does", () => {
  assert.equal(render("LDL 160 → 130 mg/dL.", "LDL-C"), "LDL 4.14 → 3.36 mmol/L.");
  assert.equal(render("LDL 160 -> 130 mg/dL.", "LDL-C"), "LDL 4.14 -> 3.36 mmol/L.");
  assert.equal(render("LDL fell from 160 to 130 mg/dL.", "LDL-C"), "LDL fell from 4.14 to 3.36 mmol/L.");
  assert.equal(render("keep glucose between 70 and 100 mg/dL", null), "keep glucose between 3.89 and 5.55 mmol/L");
  // Joined in a way the pair does not cover: the quantity stays as written, never "160 → 3.36".
  assert.equal(render("LDL fell from 160 down to 130 mg/dL.", "LDL-C"), "LDL fell from 160 down to 130 mg/dL.");
  assert.equal(render("LDL at 130 mg/dL, down from 160.", "LDL-C"), "LDL at 130 mg/dL, down from 160.");
  assert.equal(render("LDL 130 and 50 mg/dL", "LDL-C"), "LDL 130 and 50 mg/dL");
  // Two quantities that each carry a unit convert one by one.
  assert.equal(render("LDL from 160 mg/dL to 130 mg/dL", "LDL-C"), "LDL from 4.14 mmol/L to 3.36 mmol/L");
});

test("renderLabQuantities: SI prose reads in canonical units for a US reader, by the same rules", () => {
  assert.equal(
    render("Your LDL of 3.4 mmol/L and ApoB of 1.1 g/L sit high; sodium 140 mmol/L is fine.", "LDL-C", "us"),
    "Your LDL of 131 mg/dL and ApoB of 110 mg/dL sit high; sodium 140 mmol/L is fine."
  );
  assert.equal(
    render("Lp(a) 120 nmol/L is genetic; vitamin D at 75 nmol/L is fine.", null, "us"),
    "Lp(a) 120 nmol/L is genetic; vitamin D at 30 ng/mL is fine."
  );
  assert.equal(render("Creatinine 88 μmol/L", null, "us"), "Creatinine 0.995 mg/dL");
  assert.equal(render("glucose 3.9-5.6 mmol/L", null, "us"), "glucose 70.3-101 mg/dL");
  // Already in the reader's unit, or an affine HbA1c: as written.
  assert.equal(render("Your LDL of 3.4 mmol/L", "LDL-C", "si"), "Your LDL of 3.4 mmol/L");
  assert.equal(render("LDL 130 mg/dL", "LDL-C", "us"), "LDL 130 mg/dL");
  assert.equal(render("HbA1c 39 mmol/mol", "HbA1c", "us"), "HbA1c 39 mmol/mol");
  // Ambiguity is the same both ways.
  assert.equal(render("LDL or triglycerides above 1.7 mmol/L", null, "us"), "LDL or triglycerides above 1.7 mmol/L");
});
