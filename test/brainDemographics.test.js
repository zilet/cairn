// Sex/age-aware optimal zones (src/repo/propagation-data.ts personalizeZone +
// propagation.ts zoneProfile threading). The static OPTIMAL_ZONES are MALE/generic
// bands; holding a woman or an older adult to them fires clinically WRONG directives
// ("low testosterone" on a normal premenopausal woman, "reduced eGFR" on a healthy
// 70-year-old). These golden tests pin BOTH sexes and the age-banding so a regression
// re-introducing the male-default bug is caught.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "profile", "blood_pressure_readings");
});

const activeFor = (label) => repo.listActiveDirectives().filter((d) => (d.marker || "") === label);
const anyMarkerMatch = (re) => repo.listActiveDirectives().filter((d) => re.test(String(d.marker || "")));

test("a premenopausal woman's normal testosterone does NOT fire 'low testosterone'", () => {
  repo.setProfile({ sex: "female", age: 34 });
  seedHealthDoc("2025-12-01", [marker("Testosterone", 42, { unit: "ng/dL" })]); // normal female T
  repo.deriveDirectives();
  assert.equal(activeFor("Testosterone").length, 0, "female band keeps a normal female T in range");
});

test("the SAME testosterone value on a man DOES fire the low-testosterone read (control)", () => {
  repo.setProfile({ sex: "male", age: 34 });
  seedHealthDoc("2025-12-01", [marker("Testosterone", 42, { unit: "ng/dL" })]); // far below the male band
  repo.deriveDirectives();
  assert.ok(activeFor("Testosterone").length >= 1, "male band flags a genuinely low male T");
});

test("a woman's mid-cycle estradiol does NOT fire 'high estradiol'", () => {
  repo.setProfile({ sex: "female", age: 30 });
  seedHealthDoc("2025-12-01", [marker("Estradiol", 150, { unit: "pg/mL" })]); // normal premenopausal
  repo.deriveDirectives();
  assert.equal(activeFor("Estradiol").length, 0, "the female estradiol band is wide, so 150 is in range");
});

test("a fit woman at 28% body fat is NOT flagged 'above optimal'", () => {
  repo.setProfile({ sex: "female", age: 38 });
  seedHealthDoc("2025-12-01", [marker("Total Body Fat", 28, { unit: "%" })]);
  repo.deriveDirectives();
  assert.equal(anyMarkerMatch(/body fat/i).length, 0, "female body-fat band [18,33] keeps 28% in range");
});

test("a man at 28% body fat still gets the body-fat lever (control)", () => {
  repo.setProfile({ sex: "male", age: 38 });
  seedHealthDoc("2025-12-01", [marker("Total Body Fat", 28, { unit: "%" })]);
  repo.deriveDirectives();
  assert.ok(anyMarkerMatch(/body fat/i).length >= 1, "male band [10,25] flags 28%");
});

test("a premenopausal woman's ferritin of 40 is NOT read as depleted", () => {
  repo.setProfile({ sex: "female", age: 33 });
  seedHealthDoc("2025-12-01", [marker("Ferritin", 40, { unit: "ng/mL" })]);
  repo.deriveDirectives();
  assert.equal(activeFor("Ferritin").length, 0, "the female ferritin floor (30) keeps 40 in range");
});

test("a man's ferritin of 40 fires the low-iron story (control)", () => {
  repo.setProfile({ sex: "male", age: 33 });
  seedHealthDoc("2025-12-01", [marker("Ferritin", 40, { unit: "ng/mL" })]);
  repo.deriveDirectives();
  assert.ok(activeFor("Ferritin").length >= 1, "male floor (50) flags 40");
});

test("eGFR is age-banded: a healthy 70-year-old's 72 is NOT flagged", () => {
  repo.setProfile({ sex: "male", age: 70 });
  seedHealthDoc("2025-12-01", [marker("eGFR", 72)]);
  repo.deriveDirectives();
  assert.equal(activeFor("eGFR").length, 0, "age-appropriate eGFR at 70 stays in range");
  // egfrLowBound moves with age.
  assert.equal(repo.egfrLowBound(70), 60);
  assert.equal(repo.egfrLowBound(30), 90);
});

test("the SAME eGFR of 72 on a 30-year-old DOES flag reduced kidney function (control)", () => {
  repo.setProfile({ sex: "male", age: 30 });
  seedHealthDoc("2025-12-01", [marker("eGFR", 72)]);
  repo.deriveDirectives();
  assert.ok(activeFor("eGFR").length >= 1, "72 is below the young-adult 90 floor");
});

test("the anemia Hgb threshold is sex-specific (WHO): a woman at 12.5 is NOT anemic", () => {
  repo.setProfile({ sex: "female", age: 32 });
  seedHealthDoc("2025-12-01", [
    marker("Ferritin", 20, { unit: "ng/mL", flag: "low" }),
    marker("Hemoglobin", 12.5, { unit: "g/dL" }),
  ]);
  repo.deriveDirectives();
  const anemia = repo.listActiveDirectives().filter((d) => /anemia/i.test(String(d.directive || "")));
  assert.equal(anemia.length, 0, "12.5 g/dL is above the female 12.0 anemia threshold");
  // Low ferritin still speaks for itself.
  assert.ok(activeFor("Ferritin").length >= 1, "genuinely low ferritin (20) still fires");
});

test("the SAME Hgb 12.5 with low ferritin reads as anemia in a man (control)", () => {
  repo.setProfile({ sex: "male", age: 32 });
  seedHealthDoc("2025-12-01", [
    marker("Ferritin", 20, { unit: "ng/mL", flag: "low" }),
    marker("Hemoglobin", 12.5, { unit: "g/dL" }),
  ]);
  repo.deriveDirectives();
  const anemia = repo.listActiveDirectives().filter((d) => /anemia/i.test(String(d.directive || "")));
  assert.ok(anemia.length >= 1, "12.5 g/dL is below the male 13.0 anemia threshold");
});
