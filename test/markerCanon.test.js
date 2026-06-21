// Marker-name canonicalization (src/repo/marker-canon.ts) — the connected brain's
// analyte de-duplication. Different labs name the same analyte differently, which
// would otherwise split one analyte's history into parallel series. Invariants:
//   - a deterministic normalizer folds typographic variants ("Glucose (random)" =
//     "Glucose Random") and a curated clinical KB folds well-established synonyms
//     ("Vitamin D" = "25-OH Vitamin D"; "eGFR" = the long form)
//   - it NEVER merges clinically-distinct measures (calc vs direct LDL; random vs
//     fasting vs estimated-average glucose; free vs total)
//   - getMarkerHistory keys on the canonical, so variant readings merge into ONE
//     dated series — while the DISPLAY name stays the lab's own (no relabeling)
//   - a persisted alias (what the agentic reconciler writes) merges on read too
//   - planMarkerMerges (the reconciler's pure validator) enforces the safety guards
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
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
});

test("clinically-distinct measures are NOT merged", () => {
  // calc vs direct LDL, random vs estimated-average glucose, free vs total T — all
  // fall through to their own normalized self-keys (no KB entry conflates them).
  assert.notEqual(repo.canonicalMarker("LDL-Cholesterol").key, repo.canonicalMarker("LDL-C (direct)").key);
  assert.notEqual(repo.canonicalMarker("Glucose (random)").key, repo.canonicalMarker("Estimated Average Glucose").key);
  assert.notEqual(repo.canonicalMarker("Testosterone, Free").key, repo.canonicalMarker("Testosterone, Total").key);
});

test("getMarkerHistory merges KB-synonym readings into ONE dated series", () => {
  seedHealthDoc("2022-01-01", [marker("25-OH Vitamin D", 23, { unit: "ng/mL", flag: "low" })]);
  seedHealthDoc("2023-02-01", [marker("25-OH Vitamin D", 18, { unit: "ng/mL", flag: "low" })]);
  seedHealthDoc("2026-06-01", [marker("Vitamin D", 27, { unit: "ng/mL", flag: "low" })]);
  const vd = repo.getMarkerHistory().markers.filter((m) => m.key === "vitamin d");
  assert.equal(vd.length, 1, "the three variant readings collapse to one series");
  assert.equal(vd[0].points.length, 3, "all three readings are in one dated history");
  assert.deepEqual(vd[0].points.map((p) => p.value), [23, 18, 27]);
  assert.equal(vd[0].latest.value, 27, "most-recent reading is the latest");
});

test("a persisted alias (what the agent writes) merges on the next read", () => {
  seedHealthDoc("2025-01-01", [marker("eGFR", 98, { unit: "mL/min" })]);
  seedHealthDoc("2025-06-01", [marker("Estimated Glomerular Filt Rate", 60, { unit: "mL/min" })]);
  // Before: the abbreviation the KB never saw keys separately.
  let series = repo.getMarkerHistory().markers.filter((m) => m.key === "egfr");
  assert.equal(series[0].points.length, 1, "abbreviation not merged by the KB alone");
  // The agentic reconciler persists the learned alias → both now key as egfr.
  repo.setMarkerAlias(repo.normalizeMarkerName("Estimated Glomerular Filt Rate"), "egfr", "eGFR", "agent");
  series = repo.getMarkerHistory().markers.filter((m) => m.key === "egfr");
  assert.equal(series.length, 1);
  assert.equal(series[0].points.length, 2, "the learned alias merges the second reading");
});

test("planMarkerMerges enforces the safety guards", () => {
  const items = [
    { name: "eGFR", unit: "mL/min" },
    { name: "Estimated Glomerular Filt Rate", unit: "mL/min" },
    { name: "Testosterone, Free", unit: "pg/mL" },
    { name: "Testosterone, Total", unit: "ng/dL" },
    { name: "ApoB", unit: "mg/dL" },
  ];
  // A real, same-unit merge is accepted.
  let merges = repo.planMarkerMerges(items, [{ canonical: "eGFR", members: ["eGFR", "Estimated Glomerular Filt Rate"] }]);
  assert.equal(merges.length, 2);
  assert.ok(merges.every((m) => m.canonicalKey === "egfr"));

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

test("distinctMarkerNames dedupes typo-variants and surfaces unit + sample", () => {
  seedHealthDoc("2025-01-01", [marker("Glucose (random)", 96, { unit: "mg/dL" })]);
  seedHealthDoc("2025-06-01", [marker("Glucose Random", 92, { unit: "mg/dL" })]);
  seedHealthDoc("2025-06-01", [marker("ApoB", 120, { unit: "mg/dL" })]);
  const names = repo.distinctMarkerNames();
  const glucose = names.filter((n) => repo.normalizeMarkerName(n.name) === "glucose random");
  assert.equal(glucose.length, 1, "the two glucose-random spellings arrive as one row");
  assert.equal(glucose[0].unit, "mg/dL");
});
