// Marker-name canonicalization (src/repo/marker-canon.ts) — the connected brain's
// analyte de-duplication. Different labs name the same analyte differently, which
// would otherwise split one analyte's history into parallel series. Invariants:
//   - a deterministic normalizer folds typographic variants ("Glucose (random)" =
//     "Glucose Random") and a curated clinical KB folds well-established synonyms
//     ("Vitamin D" = "25-OH Vitamin D"; "eGFR" = the long form)
//   - it NEVER merges clinically-distinct measures (calc vs direct LDL; random vs
//     fasting vs estimated-average glucose; free vs total)
//   - getMarkerHistory keys on the canonical, so variant readings merge into ONE
//     dated series with one clean internal display name, while raw source labels
//     remain available for verification
//   - a persisted alias (what the agentic reconciler writes) merges on read too
//   - planMarkerMerges (the reconciler's pure validator) enforces the safety guards
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildMarkerReconcilePrompt } from "../dist/prompt/health.js";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "marker_aliases");
});

test("normalizer folds typographic variants but keeps distinct words distinct", () => {
  const { normalizeMarkerName } = repo;
  assert.equal(normalizeMarkerName("Glucose (random)"), "glucose random");
  assert.equal(normalizeMarkerName("Glucose Random"), "glucose random"); // same → merges
  assert.equal(normalizeMarkerName("Lp(a)"), "lp a");
  assert.notEqual(normalizeMarkerName("Glucose, Fasting"), normalizeMarkerName("Glucose (random)"));
});

test("curated KB folds clinical synonyms onto a stable short key", () => {
  assert.equal(repo.canonicalMarker("Vitamin D").key, "vitamin d");
  assert.equal(repo.canonicalMarker("25-OH Vitamin D").key, "vitamin d");
  assert.equal(repo.canonicalMarker("Vitamin D, 25-Hydroxy").key, "vitamin d");
  assert.equal(repo.canonicalMarker("eGFR").key, "egfr");
  assert.equal(repo.canonicalMarker("Creatinine-Based Estimated Glomerular Filtration Rate (eGFR)").key, "egfr");
  assert.equal(repo.canonicalMarker("SGPT").key, "alt");
  assert.equal(repo.canonicalMarker("Apolipoprotein B").key, "apob"); // preserves the existing short key
  assert.equal(repo.canonicalMarker("Cholesterol, Total").key, repo.canonicalMarker("Total Cholesterol").key);
  assert.equal(repo.canonicalMarker("HDL-C").key, repo.canonicalMarker("HDL Cholesterol").key);
  assert.equal(repo.canonicalMarker("VLDL Cholesterol Cal").key, repo.canonicalMarker("VLDL-C").key);
  assert.equal(repo.canonicalMarker("LDL-C (direct)").name, "LDL-C (Direct)");
  assert.equal(repo.canonicalMarker("BUN (Urea Nitrogen)").key, repo.canonicalMarker("Blood Urea Nitrogen (BUN)").key);
  assert.equal(repo.canonicalMarker("Alkaline Phosphatase (ALP)").key, repo.canonicalMarker("Alkaline Phosphatase").key);
  assert.equal(repo.canonicalMarker("Mean Corpuscular Volume (MCV)").key, repo.canonicalMarker("MCV").key);
  assert.equal(repo.canonicalMarker("Mean Platelet Volume (MPV)").key, repo.canonicalMarker("MPV").key);
  assert.equal(repo.canonicalMarker("RBC").key, repo.canonicalMarker("Red Blood Cell (RBC) Count").key);
  assert.equal(repo.canonicalMarker("Hemoglobin").key, repo.canonicalMarker("Hgb").key);
  assert.equal(repo.canonicalMarker("Hematocrit").key, repo.canonicalMarker("Hct").key);
  assert.equal(repo.canonicalMarker("Iron % Saturation").key, repo.canonicalMarker("Transferrin Saturation").key);
  assert.equal(repo.canonicalMarker("Iron Binding Capacity").key, repo.canonicalMarker("TIBC").key);
  assert.equal(repo.canonicalMarker("Neutrophils %").key, repo.canonicalMarker("Neutrophil %").key);
  assert.equal(repo.canonicalMarker("Omega-3 Total / OmegaCheck").key, repo.canonicalMarker("Omega-3 Total").key);
  assert.equal(repo.canonicalMarker("White Blood Cell (WBC) Count").key, repo.canonicalMarker("WBC").key);
  assert.equal(repo.canonicalMarker("Absolute Neutrophil Count").key, repo.canonicalMarker("ANC").key);
  assert.equal(repo.canonicalMarker("Absolute NRBC Count").name, "Absolute NRBC Count");
  assert.equal(repo.canonicalMarker("Weight").key, repo.canonicalMarker("Total Mass").key);
  assert.equal(repo.canonicalMarker("Weight").name, "Body Weight");
  assert.equal(repo.canonicalMarker("Stature").key, repo.canonicalMarker("Height").key);
});

test("clinically-distinct measures are NOT merged", () => {
  // calc vs direct LDL, random vs estimated-average glucose, free vs total T — all
  // fall through to their own normalized self-keys (no KB entry conflates them).
  assert.notEqual(repo.canonicalMarker("LDL-Cholesterol").key, repo.canonicalMarker("LDL-C (direct)").key);
  assert.notEqual(repo.canonicalMarker("Glucose (random)").key, repo.canonicalMarker("Estimated Average Glucose").key);
  assert.notEqual(repo.canonicalMarker("Testosterone, Free").key, repo.canonicalMarker("Testosterone, Total").key);
  assert.notEqual(repo.canonicalMarker("Absolute Neutrophil Count").key, repo.canonicalMarker("Neutrophil %").key);
  assert.notEqual(repo.canonicalMarker("Neutrophil").key, repo.canonicalMarker("Neutrophil %").key);
});

test("getMarkerHistory merges KB-synonym readings into ONE dated series", () => {
  seedHealthDoc("2022-01-01", [marker("25-OH Vitamin D", 23, { unit: "ng/mL", flag: "low" })]);
  seedHealthDoc("2023-02-01", [marker("25-OH Vitamin D", 18, { unit: "ng/mL", flag: "low" })]);
  seedHealthDoc("2026-06-01", [marker("Vitamin D", 27, { unit: "ng/mL", flag: "low" })]);
  const vd = repo.getMarkerHistory().markers.filter((m) => m.key === "vitamin d");
  assert.equal(vd.length, 1, "the three variant readings collapse to one series");
  assert.equal(vd[0].name, "25-OH Vitamin D", "the merged series uses the internal canonical label");
  assert.deepEqual(vd[0].source_names, ["Vitamin D"], "raw variant labels stay available as provenance");
  assert.equal(vd[0].points.length, 3, "all three readings are in one dated history");
  assert.deepEqual(vd[0].points.map((p) => p.value), [23, 18, 27]);
  assert.equal(vd[0].latest.value, 27, "most-recent reading is the latest");
});

test("getMarkerHistory merges common CBC label variants and compatible count units", () => {
  seedHealthDoc("2022-01-20", [marker("RBC", 4.55, { unit: "M/uL" })]);
  seedHealthDoc("2026-03-10", [marker("Red Blood Cell Count", 4.65, { unit: "M/uL" })]);
  seedHealthDoc("2026-06-11", [marker("Red Blood Cell (RBC) Count", 4.67, { unit: "Million/uL" })]);

  const rbc = repo.getMarkerHistory().markers.find((m) => m.key === "red blood cell count");
  assert.ok(rbc, "merged RBC series present");
  assert.equal(rbc.name, "Red Blood Cell Count");
  assert.equal(rbc.unit, "M/uL", "compatible count units normalize to the target display unit");
  assert.deepEqual(rbc.points.map((p) => p.value), [4.55, 4.65, 4.67]);
  assert.equal(rbc.points.length, 3, "RBC variants collapse into one history");
});

test("getMarkerHistory uses units to disambiguate bare white-cell differentials", () => {
  seedHealthDoc("2026-03-10", [
    marker("WBC", 6.9, { unit: "TH/uL" }),
    marker("Absolute Neutrophil Count", 3.8, { unit: "TH/uL" }),
  ]);
  seedHealthDoc("2026-06-11", [
    marker("White Blood Cell (WBC) Count", 4.9, { unit: "K/uL" }),
    marker("Neutrophils", 1891, { unit: "cells/uL" }),
    marker("Neutrophils %", 38.6, { unit: "%" }),
  ]);

  const rows = repo.getMarkerHistory().markers;
  const wbc = rows.find((m) => m.key === "white blood cell count");
  const neutAbs = rows.find((m) => m.key === "absolute neutrophil count");
  const neutPct = rows.find((m) => m.key === "neutrophil percentage");
  assert.ok(wbc, "WBC merged series present");
  assert.deepEqual(wbc.points.map((p) => p.value), [6.9, 4.9]);
  assert.equal(wbc.unit, "K/uL");
  assert.ok(neutAbs, "absolute neutrophil merged series present");
  assert.deepEqual(neutAbs.points.map((p) => p.value), [3.8, 1.891]);
  assert.equal(neutAbs.unit, "K/uL");
  assert.ok(neutPct, "percentage differential stays separate");
  assert.deepEqual(neutPct.points.map((p) => p.value), [38.6]);
});

test("a persisted alias (what the agent writes) merges on the next read", () => {
  seedHealthDoc("2025-01-01", [marker("eGFR", 98, { unit: "mL/min" })]);
  seedHealthDoc("2025-06-01", [marker("Kidney Filtration Estimate", 60, { unit: "mL/min" })]);
  // Before: the abbreviation the KB never saw keys separately.
  let series = repo.getMarkerHistory().markers.filter((m) => m.key === "egfr");
  assert.equal(series[0].points.length, 1, "abbreviation not merged by the KB alone");
  // The agentic reconciler persists the learned alias → both now key as egfr.
  repo.setMarkerAlias(repo.normalizeMarkerName("Kidney Filtration Estimate"), "egfr", "eGFR", "agent");
  series = repo.getMarkerHistory().markers.filter((m) => m.key === "egfr");
  assert.equal(series.length, 1);
  assert.equal(series[0].name, "eGFR", "learned aliases display as the internal canonical label");
  assert.deepEqual(series[0].source_names, ["Kidney Filtration Estimate"]);
  assert.equal(series[0].points.length, 2, "the learned alias merges the second reading");
});

test("planMarkerMerges enforces the safety guards", () => {
  const items = [
    { name: "eGFR", unit: "mL/min" },
    { name: "Kidney Filtration Estimate", unit: "mL/min" },
    { name: "Testosterone, Free", unit: "pg/mL" },
    { name: "Testosterone, Total", unit: "ng/dL" },
    { name: "ApoB", unit: "mg/dL" },
  ];
  // A real, same-unit merge is accepted.
  let merges = repo.planMarkerMerges(items, [{ canonical: "eGFR", members: ["eGFR", "Kidney Filtration Estimate"] }]);
  assert.equal(merges.length, 2);
  assert.ok(merges.every((m) => m.canonicalKey === "egfr"));
  assert.ok(merges.every((m) => m.canonicalName === "eGFR"), "KB-covered groups store the internal canonical display name");

  // Incompatible units (pg/mL vs ng/dL) are rejected even if the agent grouped them.
  merges = repo.planMarkerMerges(items, [{ canonical: "Testosterone", members: ["Testosterone, Free", "Testosterone, Total"] }]);
  assert.equal(merges.length, 0, "cross-dimension unit merge rejected");

  // A non-verbatim member can't smuggle in; a singleton group is skipped.
  merges = repo.planMarkerMerges(items, [{ canonical: "eGFR", members: ["eGFR", "made up name"] }]);
  assert.equal(merges.length, 0, "unknown member → group drops below 2 → skipped");

  // An already-merged group (members already share a key) is a no-op.
  merges = repo.planMarkerMerges(items, [{ canonical: "ApoB", members: ["ApoB"] }]);
  assert.equal(merges.length, 0);
});

test("planMarkerMerges refuses ambiguous bare white-cell differential aliases", () => {
  const items = [
    { name: "Neutrophil", unit: "%" },
    { name: "Neutrophils %", unit: "%" },
  ];
  const merges = repo.planMarkerMerges(items, [{ canonical: "Neutrophil Percentage", members: ["Neutrophil", "Neutrophils %"] }]);
  assert.equal(merges.length, 0, "bare differential label is too ambiguous to persist as a percent alias");
});

test("planMarkerMerges refuses glucose context merges", () => {
  const items = [
    { name: "Glucose", unit: "mg/dL" },
    { name: "Glucose Random", unit: "mg/dL" },
    { name: "Fasting Glucose", unit: "mg/dL" },
    { name: "Estimated Average Glucose", unit: "mg/dL" },
  ];
  assert.equal(
    repo.planMarkerMerges(items, [{ canonical: "Random Glucose", members: ["Glucose", "Glucose Random"] }]).length,
    0,
    "bare glucose is not assumed to be random glucose"
  );
  assert.equal(
    repo.planMarkerMerges(items, [{ canonical: "Glucose", members: ["Fasting Glucose", "Glucose Random"] }]).length,
    0,
    "fasting and random glucose are clinically different contexts"
  );
  assert.equal(
    repo.planMarkerMerges(items, [{ canonical: "Glucose", members: ["Glucose", "Estimated Average Glucose"] }]).length,
    0,
    "estimated-average glucose is not the same measurement as a serum glucose"
  );
});

test("canonicalMarker ignores stale unsafe glucose aliases", () => {
  repo.setMarkerAlias(repo.normalizeMarkerName("Glucose"), "random glucose", "Random Glucose", "agent");
  assert.equal(repo.canonicalMarker("Glucose").key, "glucose");
  assert.equal(repo.canonicalMarker("Glucose").name, "Glucose");
  assert.equal(repo.canonicalMarker("Glucose Random").key, "glucose random");
});

test("distinctMarkerNames dedupes typo-variants and surfaces unit + sample", () => {
  seedHealthDoc("2025-01-01", [marker("Glucose (random)", 96, { unit: "mg/dL" })]);
  seedHealthDoc("2025-06-01", [marker("Glucose Random", 92, { unit: "mg/dL" })]);
  seedHealthDoc("2025-06-01", [marker("ApoB", 120, { unit: "mg/dL" })]);
  const names = repo.distinctMarkerNames();
  const glucose = names.filter((n) => repo.normalizeMarkerName(n.name) === "glucose random");
  assert.equal(glucose.length, 1, "the two glucose-random spellings arrive as one row");
  assert.equal(glucose[0].unit, "mg/dL");
});

test("marker reconciler prompt shows raw label plus internal display hint", () => {
  const prompt = buildMarkerReconcilePrompt([
    { name: "LDL Chol Calc (NIH)", canonical: "LDL-C", unit: "mg/dL", sample: 173 },
  ]);
  assert.match(prompt, /"LDL Chol Calc \(NIH\)" -> internal "LDL-C" \[mg\/dL\] e\.g\. 173/);
});

test("blood-pressure component spellings canonicalize onto one stable key", () => {
  assert.equal(repo.canonicalMarker("Systolic Blood Pressure").key, "systolic bp");
  assert.equal(repo.canonicalMarker("Systolic BP").key, "systolic bp");
  assert.equal(repo.canonicalMarker("Blood Pressure Systolic").key, "systolic bp");
  assert.equal(repo.canonicalMarker("Diastolic Blood Pressure").key, "diastolic bp");
  assert.equal(repo.canonicalMarker("Diastolic BP").key, "diastolic bp");
  // The clean display label wins over the long spelling.
  assert.equal(repo.canonicalMarker("Systolic Blood Pressure").name, "Systolic BP");
  assert.equal(repo.canonicalMarker("Diastolic Blood Pressure").name, "Diastolic BP");
});

test("split BP spellings unify into one marker history series", () => {
  seedHealthDoc("2026-01-01", [marker("Systolic Blood Pressure", 128, { unit: "mmHg" })]);
  seedHealthDoc("2026-04-01", [marker("Systolic BP", 122, { unit: "mmHg" })]);
  const { markers } = repo.getMarkerHistory();
  const sys = markers.filter((m) => m.key === "systolic bp");
  assert.equal(sys.length, 1, "the two spellings collapse into ONE series");
  assert.equal(sys[0].points.length, 2, "both readings land on the unified series");
  assert.equal(sys[0].name, "Systolic BP", "the clean canonical label is used");
});
