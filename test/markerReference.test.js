// Reference ranges: source-lab printed intervals are captured at ingest
// (ref_low/ref_high) and surfaced as `reference`; source-backed curated intervals
// fill only standard markers where the upload omitted a range.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc } from "./_seed.js";

const find = (markers, re) => markers.find((m) => re.test(m.name));

test("getMarkerHistory carries the lab reference range alongside orientation zones", () => {
  resetTables("health_documents", "blood_pressure_readings");
  // Reference ranges remain available even when an optimal/orientation zone exists.
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

test("curated clinical reference intervals fill standard markers only when the upload omitted a range", () => {
  resetTables("health_documents", "blood_pressure_readings", "profile");
  seedHealthDoc("2026-06-01", [
    { name: "Amylase", value: 51, unit: "U/L", flag: "normal" },
    { name: "Lipase", value: 28, unit: "U/L", flag: "normal", ref_low: 8, ref_high: 78 },
    { name: "Mystery Enzyme", value: 12, unit: "U/L", flag: "normal" },
  ]);

  const { markers } = repo.getMarkerHistory();
  const amylase = find(markers, /^Amylase$/);
  assert.deepEqual(amylase.reference, { low: 40, high: 140 });
  assert.equal(amylase.reference_source, "MedlinePlus Amylase - blood");
  assert.match(amylase.reference_source_url, /medlineplus/);

  const lipase = find(markers, /^Lipase$/);
  assert.deepEqual(lipase.reference, { low: 8, high: 78 }, "the lab's own printed interval wins");
  assert.equal(lipase.reference_source, "source_lab");

  const mystery = find(markers, /Mystery/);
  assert.equal(mystery.reference, null, "unknown markers do not get invented ranges");
  assert.equal(mystery.reference_source, null);
});

test("curated intervals are unit-aware and sex/age aware", () => {
  resetTables("health_documents", "blood_pressure_readings", "profile");
  repo.setProfile({ sex: "male", age: 44 });
  seedHealthDoc("2026-06-01", [
    { name: "Luteinizing Hormone (LH)", value: 4.4, unit: "mIU/mL", flag: "normal" },
    { name: "Sex Hormone Binding Globulin (SHBG)", value: 25, unit: "nmol/L", flag: "normal" },
    { name: "Amylase", value: 0.8, unit: "ukat/L", flag: "normal" },
  ]);

  const { markers } = repo.getMarkerHistory();
  const lh = find(markers, /Luteinizing/);
  assert.deepEqual(lh.reference, { low: 1.8, high: 8.6 });
  assert.equal(lh.reference_source, "MedlinePlus LH blood test");

  const shbg = find(markers, /Sex Hormone/);
  assert.deepEqual(shbg.reference, { low: 16.5, high: 55.9 });
  assert.equal(shbg.reference_source, "Labcorp Sex Hormone-binding Globulin");

  const amylase = find(markers, /^Amylase$/);
  assert.equal(amylase.reference, null, "an unsupported unit conversion does not attach a U/L interval");
  assert.equal(amylase.reference_source, null);
});
