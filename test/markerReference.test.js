// The lab's printed reference range is captured at ingest (ref_low/ref_high) and
// surfaced on every marker as `reference`, so a marker with no evidence-anchored
// OPTIMAL_ZONE still shows the number it's being measured against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc } from "./_seed.js";

const find = (markers, re) => markers.find((m) => re.test(m.name));

test("getMarkerHistory carries the lab reference range for a marker with no optimal zone", () => {
  resetTables("health_documents", "blood_pressure_readings");
  // Iron studies have no OPTIMAL_ZONE — previously they showed a bare number.
  seedHealthDoc("2026-06-01", [
    { name: "Iron", value: 76, unit: "mcg/dL", flag: "normal", ref_low: 65, ref_high: 175 },
    { name: "Iron Binding Capacity", value: 314, unit: "mcg/dL", flag: "normal", ref_low: 250, ref_high: 450 },
  ]);
  const { markers } = repo.getMarkerHistory();
  const iron = find(markers, /^Iron$/);
  assert.ok(iron, "Iron marker present");
  assert.deepEqual(iron.reference, { low: 65, high: 175 });
  const tibc = find(markers, /Binding/);
  assert.deepEqual(tibc.reference, { low: 250, high: 450 });
});

test("a one-sided reference keeps the opposite bound null; no range → no reference", () => {
  resetTables("health_documents", "blood_pressure_readings");
  seedHealthDoc("2026-06-01", [
    { name: "hs-CRP", value: 0.6, unit: "mg/L", flag: "normal", ref_high: 3, ref_low: null },
    { name: "ABO Group", value: "O", unit: null, flag: null }, // qualitative, no range
  ]);
  const { markers } = repo.getMarkerHistory();
  const crp = find(markers, /crp/i);
  assert.equal(crp.reference.low, null);
  assert.equal(crp.reference.high, 3);
  const abo = find(markers, /ABO/);
  assert.equal(abo.reference, null, "a qualitative row with no printed range carries no reference");
});

test("the reference range scales with a recognized-marker unit conversion", () => {
  resetTables("health_documents", "blood_pressure_readings");
  // Fasting glucose printed in SI (mmol/L) is normalized to mg/dL (×18.0182); its
  // reference bounds must ride the SAME factor so range and value still agree.
  seedHealthDoc("2026-06-01", [
    { name: "Fasting Glucose", value: 5.0, unit: "mmol/L", flag: "normal", ref_low: 3.9, ref_high: 5.5 },
  ]);
  const { markers } = repo.getMarkerHistory();
  const glu = find(markers, /Glucose/);
  assert.ok(/mg\/dL/i.test(String(glu.unit)), `converted to mg/dL, got unit ${glu.unit}`);
  assert.ok(Math.abs(Number(glu.latest.value) - 90.1) < 1, `value ~90 mg/dL, got ${glu.latest.value}`);
  assert.ok(Math.abs(glu.reference.low - 70.3) < 1.5, `ref_low ~70 mg/dL, got ${glu.reference.low}`);
  assert.ok(Math.abs(glu.reference.high - 99.1) < 1.5, `ref_high ~99 mg/dL, got ${glu.reference.high}`);
});
