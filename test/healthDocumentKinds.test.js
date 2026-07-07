import { test } from "node:test";
import assert from "node:assert/strict";
import { healthDocumentKindLabel, inferHealthDocumentKind, normalizeHealthDocumentKind } from "../dist/healthDocumentKinds.js";

test("health document kind aliases normalize to richer categories", () => {
  assert.equal(normalizeHealthDocumentKind("progress note"), "visit_note");
  assert.equal(normalizeHealthDocumentKind("after visit summary"), "after_visit_summary");
  assert.equal(normalizeHealthDocumentKind("home bp"), "vitals");
  assert.equal(normalizeHealthDocumentKind("ccda_vitals"), "vitals");
  assert.equal(normalizeHealthDocumentKind("ccda_labs"), "bloodwork");
  assert.equal(normalizeHealthDocumentKind("resting metabolic rate"), "metabolic_test");
  assert.equal(normalizeHealthDocumentKind("radiology"), "imaging");
  assert.equal(normalizeHealthDocumentKind("eyeglasses"), "vision");
  assert.equal(healthDocumentKindLabel("immunization_record"), "Immunization Record");
});

test("health document kind inference uses content when the agent says other", () => {
  assert.equal(inferHealthDocumentKind({
    kind: "other",
    summary: "Televisit Adult Patient Visit documented elevated LDL and follow-up labs.",
    clinical_facts: [
      { kind: "encounter", name: "Televisit Adult Patient Visit", source: "Assessment/Plan" },
      { kind: "other", name: "LIPID PANEL", status: "ordered" },
    ],
  }), "visit_note");

  assert.equal(inferHealthDocumentKind({
    kind: "other",
    summary: "After Visit Summary with instructions and labs ordered today.",
    clinical_facts: [
      { kind: "encounter", name: "Office visit" },
      { kind: "other", name: "APOLIPOPROTEIN B", source: "Instructions - Labs ordered today" },
    ],
  }), "after_visit_summary");

  assert.equal(inferHealthDocumentKind({
    kind: "other",
    markers: [
      { name: "Systolic BP", value: 120 },
      { name: "Diastolic BP", value: 77 },
      { name: "Pulse", value: 61 },
      { name: "Pain Score", value: 2 },
    ],
  }), "vitals");

  assert.equal(inferHealthDocumentKind({
    type: "ccda_vitals",
    original_name: "health_summary_milos_mychart.zip",
    summary: "MyChart vitals recorded 2026-03-11 09:39",
    markers: [{ name: "BMI", value: 30.1 }],
  }), "vitals");

  assert.equal(inferHealthDocumentKind({
    kind: "other",
    original_name: "Dexafit-RMR.pdf",
    summary: "DexaFit indirect-calorimetry metabolic assessment: measured resting metabolic rate 2,078 kcal/day.",
  }), "metabolic_test");

  assert.equal(inferHealthDocumentKind({
    kind: "other",
    original_name: "DXAReport.pdf",
    summary: "DexaFit whole-body DEXA: total mass 184.3 lb at 35.6% body fat.",
    markers: [
      { name: "Body Score", value: "C" },
      { name: "Body Fat %", value: 35.6 },
      { name: "Lean Mass (Total)", value: 112.6 },
    ],
  }), "dexa");

  assert.equal(inferHealthDocumentKind({
    kind: "other",
    summary: "Source is a reading-glasses prescription: Right +1.00, Left +0.50, single vision.",
  }), "vision");

  assert.equal(inferHealthDocumentKind({
    kind: "other",
    original_name: "1 of 1 - My Health Summary.PDF",
    markers: [
      { name: "LDL-C", value: 173 },
      { name: "Apolipoprotein B", value: 125 },
      { name: "Height", value: 167.6 },
    ],
  }), "bloodwork");

  assert.equal(inferHealthDocumentKind({
    kind: "other",
    summary: "ED chest-pain workup: CBC, basic metabolic panel, serial troponins, and EKG read as normal sinus rhythm.",
    markers: [
      { name: "White Blood Cell Count", value: 8.1 },
      { name: "Creatinine", value: 0.9 },
      { name: "High-Sensitivity Troponin T", value: 6 },
      { name: "EKG Rhythm", value: "normal sinus rhythm" },
    ],
  }), "bloodwork");

  assert.equal(inferHealthDocumentKind({
    kind: "other",
    original_name: "1 of 1 - My Health Summary.PDF",
    summary: "Cambridge Health Alliance record spanning Jan 2022 through Mar 2026.",
    markers: [
      { name: "Systolic Blood Pressure", value: 144 },
      { name: "Pulse", value: 62 },
    ],
    clinical_facts: [
      { kind: "condition", name: "Chest pain, unspecified type" },
      { kind: "procedure", name: "XR Chest 2 Views" },
      { kind: "procedure", name: "XR Knee Right 3 Views" },
      { kind: "social_history", name: "Smoking tobacco: Never" },
    ],
  }), "clinical_summary");
});
