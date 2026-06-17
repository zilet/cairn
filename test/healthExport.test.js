// FHIR-inspired structured health export (src/repo.ts buildHealthExport, F4).
// A read-only serialization of the athlete's markers/observations over time. The
// shape must be self-describing (versioned meta header), carry the full per-marker
// history with the optimal-zone band + an optimal-zone STATUS (never a numeric
// grade), and — the constitution invariant — leak no 0-100 score anywhere.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "supplements");
});

test("buildHealthExport has a versioned, self-describing meta header", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 90, { unit: "mg/dL", flag: "normal" })]);
  const exp = repo.buildHealthExport();
  assert.equal(exp.meta.exportVersion, repo.HEALTH_EXPORT_VERSION);
  assert.equal(exp.meta.resourceType, "CairnHealthSummary");
  assert.equal(exp.meta.format, "fhir-inspired");
  assert.equal(exp.meta.generatedFrom, "cairn");
  assert.ok(typeof exp.meta.generated === "string" && exp.meta.generated.includes("T"), "generated is an ISO timestamp");
  assert.ok("subject" in exp.meta, "subject block present");
});

test("buildHealthExport builds one Observation per marker with full dated history", () => {
  seedHealthDoc("2025-01-01", [marker("ApoB", 80, { unit: "mg/dL" })]);
  seedHealthDoc("2025-06-01", [marker("ApoB", 95, { unit: "mg/dL" })]);
  seedHealthDoc("2025-12-01", [marker("ApoB", 110, { unit: "mg/dL", flag: "high" })]);
  const exp = repo.buildHealthExport();
  assert.equal(exp.observations.length, 1, "one Observation for the single distinct marker");
  const o = exp.observations[0];
  assert.equal(o.name, "ApoB");
  assert.equal(o.value, 110, "latest reading is the value");
  assert.equal(o.unit, "mg/dL");
  assert.equal(o.effectiveDate, "2025-12-01");
  assert.equal(o.labFlag, "high");
  assert.equal(o.category, "lipids");
  // Full history, ascending by date.
  assert.equal(o.history.length, 3);
  assert.deepEqual(o.history.map((h) => h.value), [80, 95, 110]);
  assert.deepEqual(o.history.map((h) => h.effectiveDate), ["2025-01-01", "2025-06-01", "2025-12-01"]);
  // Deterministic rising trend carried through.
  assert.equal(o.trend.direction, "rising");
  assert.equal(o.trend.change, 30);
  assert.equal(o.trend.readings, 3);
  assert.equal(exp.summary.markerCount, 1);
});

test("buildHealthExport carries the optimal band + optimal-zone status, no numeric grade", () => {
  // 130 sits above the optimal LDL band (≤100) → out of optimal, above.
  seedHealthDoc("2025-12-01", [marker("LDL Cholesterol", 130, { unit: "mg/dL", flag: "high" })]);
  const exp = repo.buildHealthExport();
  const ldl = exp.observations.find((o) => o.key.includes("ldl"));
  assert.ok(ldl, "ldl observation present");
  assert.ok(ldl.optimalRange, "optimalRange present");
  assert.equal(ldl.optimalRange.worseDirection, "high");
  assert.equal(ldl.inOptimal, false);
  assert.equal(ldl.status, "above-optimal");
  assert.equal(exp.summary.flaggedCount, 1);
});

test("buildHealthExport marks within-optimal and no-optimal-reference cleanly", () => {
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 70, { unit: "mg/dL", flag: "normal" }),       // inside [40,80]
    marker("Some Obscure Marker", 12, { unit: "x", flag: "normal" }), // no optimal zone
  ]);
  const exp = repo.buildHealthExport();
  const apob = exp.observations.find((o) => o.key === "apob");
  assert.equal(apob.inOptimal, true);
  assert.equal(apob.status, "within-optimal");
  const obscure = exp.observations.find((o) => o.key.includes("obscure"));
  assert.equal(obscure.inOptimal, null);
  assert.equal(obscure.status, "no-optimal-reference");
  assert.equal(obscure.optimalRange, null);
});

test("buildHealthExport surfaces a body-composition convenience slice", () => {
  seedHealthDoc("2025-12-01", [
    marker("Body Fat", 18, { unit: "%" }),
    marker("ApoB", 80, { unit: "mg/dL" }),
  ], "dexa");
  const exp = repo.buildHealthExport();
  assert.equal(exp.bodyComposition.length, 1, "only the body-group marker in the slice");
  assert.equal(exp.bodyComposition[0].name, "Body Fat");
  // The same row still appears in the full observations list.
  assert.ok(exp.observations.some((o) => o.name === "Body Fat" && o.category === "body"));
});

test("buildHealthExport includes the active supplement regimen + active directives", () => {
  // Out-of-optimal marker → the deterministic engine derives active directives.
  seedHealthDoc("2025-12-01", [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  repo.addSupplement({ name: "Creatine monohydrate", dose: "5 g", frequency: "daily", category: "performance", related_markers: ["eGFR"] });
  const exp = repo.buildHealthExport();
  assert.ok(exp.supplements.length >= 1, "supplement present");
  const creatine = exp.supplements.find((s) => s.name.includes("Creatine"));
  assert.ok(creatine && creatine.frequency === "daily" && Array.isArray(creatine.relatedMarkers));
  assert.ok(exp.directives.length >= 1, "at least one derived directive");
  for (const d of exp.directives) {
    assert.ok(["nutrition", "training", "watch"].includes(d.domain));
    assert.equal(typeof d.uncertain, "boolean");
  }
});

test("buildHealthExport is empty-safe with no markers", () => {
  const exp = repo.buildHealthExport();
  assert.deepEqual(exp.observations, []);
  assert.deepEqual(exp.bodyComposition, []);
  assert.equal(exp.summary.markerCount, 0);
  assert.equal(exp.summary.flaggedCount, 0);
  assert.ok(exp.meta && exp.meta.exportVersion === repo.HEALTH_EXPORT_VERSION);
});

// ---- CONSTITUTION GUARD: no 0-100 grade leaks into the export ----------------
// The export carries plenty of numbers (marker values, ranges, change deltas) but
// NONE may be a user-facing grade/score/rating. The internal impact_score must
// never cross this boundary, and no field may masquerade as a percentage grade.
test("GOLDEN: buildHealthExport leaks no impact_score / 0-100 grade field", () => {
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 400, { unit: "mg/dL", flag: "high" }),
    marker("Vitamin D 25-OH", 18, { unit: "ng/mL", flag: "low" }),
  ]);
  const exp = repo.buildHealthExport();
  const seen = JSON.stringify(exp);
  assert.ok(!/impact_score/i.test(seen), "impact_score must never be serialized into the export");
  // Walk every observation: no grade/rating/score field shape.
  const badKey = /grade|rating|score|pct|out_of/i;
  for (const o of exp.observations) {
    for (const k of Object.keys(o)) {
      assert.ok(!badKey.test(k), `unexpected grade-shaped field "${k}" in an observation`);
    }
    for (const k of Object.keys(o.trend)) {
      assert.ok(!badKey.test(k), `unexpected grade-shaped field "${k}" in a trend`);
    }
  }
});
