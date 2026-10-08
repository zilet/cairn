// A sub-analyte whose name CONTAINS a band's key (prealbumin ⊃ albumin, direct bilirubin ⊃
// bilirubin, gamma globulin ⊃ globulin, mean cell hemoglobin ⊃ hemoglobin) measures
// something else. It must never be judged against — or unit-converted through — the
// parent's optimal band, whichever unit system the lab printed it in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo, seedHealthDoc, marker } from "./_seed.js";
import { matchOptimalZone, unitAnalyteZone } from "../dist/repo/propagation-data.js";

// [name, a US print, an SI print]
const CASES = [
  ["Prealbumin", [22, "mg/dL"], [0.22, "g/L"]],
  ["Pre-albumin", [22, "mg/dL"], [0.22, "g/L"]],
  ["Direct Bilirubin", [0.2, "mg/dL"], [3.4, "µmol/L"]],
  ["Bilirubin, Direct", [0.2, "mg/dL"], [3.4, "µmol/L"]],
  ["Indirect Bilirubin", [0.5, "mg/dL"], [8.6, "µmol/L"]],
  ["Conjugated Bilirubin", [0.2, "mg/dL"], [3.4, "µmol/L"]],
  ["Alpha-1 Globulin", [0.3, "g/dL"], [3, "g/L"]],
  ["Alpha-2 Globulin", [0.7, "g/dL"], [7, "g/L"]],
  ["Beta Globulin", [0.9, "g/dL"], [9, "g/L"]],
  ["Gamma Globulin", [1.1, "g/dL"], [11, "g/L"]],
  ["Mean Cell Hemoglobin", [30, "pg"], [1.86, "fmol"]],
  ["Mean Cell Hemoglobin Concentration", [33, "g/dL"], [330, "g/L"]],
  ["Mean Cell Haemoglobin Concentration", [33, "g/dL"], [330, "g/L"]],
];

test("sub-analyte names match no optimal band and no unit row", () => {
  for (const [name] of CASES) {
    assert.equal(matchOptimalZone(name), null, `${name} band`);
    assert.equal(unitAnalyteZone(name), null, `${name} unit row`);
  }
  // The parents still match their own bands.
  assert.equal(matchOptimalZone("Albumin").label, "Albumin");
  assert.equal(matchOptimalZone("Total Bilirubin").label, "Total bilirubin");
  assert.equal(matchOptimalZone("Globulin").label, "Globulin");
  assert.equal(matchOptimalZone("Hemoglobin").label, "Hemoglobin");
});

for (const [label, idx] of [["US", 1], ["SI", 2]]) {
  test(`sub-analytes printed in ${label} units stay as printed, unjudged`, () => {
    seedHealthDoc("2025-05-01", CASES.map((c) => marker(c[0], c[idx][0], { unit: c[idx][1] })));
    repo.resetMarkerHistoryCache();
    const markers = repo.getMarkerHistory().markers;
    const prioritized = repo.prioritizeMarkers().markers;
    for (const [name, ...prints] of CASES) {
      const [value, unit] = prints[idx - 1];
      const m = markers.find((x) => x.name.toLowerCase() === name.toLowerCase());
      assert.ok(m, `${name} has a series`);
      assert.equal(m.latest.value, value, `${name} value kept`);
      assert.equal(m.unit, unit, `${name} unit kept`);
      assert.notEqual(m.latest.unit_converted, true, `${name} never converted`);
      const p = prioritized.find((x) => x.key === m.key);
      assert.ok(p == null || p.in_optimal == null, `${name} is not judged against a parent band`);
    }
  });
}
