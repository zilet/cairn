// Marker grouping taxonomy (markerGroup) + the non-clinical filter
// (isNonClinicalMarker). A comprehensive panel (Function-Health-style) used to
// dump a third of its markers into the "Other Markers" catch-all because the
// grouping table matched on full names and missed the abbreviated / extra ones
// (CBC differential absolute counts, electrolytes, the urinalysis dipstick, the
// DEXA body-comp metrics, the metabolic-cart fields, heavy metals, PSA, …). These
// lock that each clinical story lands in a meaningful group, that longest-match
// still wins, and that an eyeglass Rx pulled from an eye-exam doc is dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";
import { buildClinicalReportData } from "../dist/report.js";

const g = (name) => repo.markerGroup(name).key;
const label = (name) => repo.markerGroup(name).label;

test("the clinically-distinct stories each land in their own group (not Other)", () => {
  const cases = [
    // Lipids & cardiac
    ["Total Cholesterol", "lipids"],
    ["Troponin T HS Baseline", "cardiac"],
    // Metabolic & the metabolic-cart fitness fields
    ["Hemoglobin A1c", "metabolic"],
    ["VO2max", "fitness"],
    ["Resting Metabolic Rate (RMR)", "fitness"],
    ["Predicted RMR", "fitness"],
    ["Respiratory Exchange Ratio (RER)", "fitness"],
    ["Carbohydrate Utilization", "fitness"],
    ["Fat Utilization", "fitness"],
    // CBC — the full differential, abbreviated the way a lab prints it
    ["Red Blood Cell Count", "iron"],
    ["Absolute Lymph Count", "blood"],
    ["Absolute Mono Count", "blood"],
    ["Absolute Baso Count", "blood"],
    ["Immature Granulocyte %", "blood"],
    ["ABO Group", "iron"],
    ["Rhesus (Rh) Factor", "iron"],
    // Liver & pancreas
    ["Globulin", "liver"],
    ["Amylase", "liver"],
    ["Lipase", "liver"],
    // Electrolytes
    ["Chloride", "electrolytes"],
    ["Carbon Dioxide", "electrolytes"],
    ["Anion Gap", "electrolytes"],
    ["Sodium", "electrolytes"],
    ["Potassium", "electrolytes"],
    // Thyroid antibodies + hormones
    ["Thyroglobulin Antibodies (TgAb)", "thyroid"],
    ["Leptin", "hormones"],
    // Autoimmune + cancer screening
    ["Antinuclear Antibodies (ANA) Screen", "autoimmune"],
    ["Rheumatoid Factor (RF)", "autoimmune"],
    ["Prostate Specific Antigen (PSA), Total", "screening"],
    ["Prostate Specific Antigen (PSA), Free", "screening"],
    // Vitamins / fatty acids
    ["Methylmalonic Acid (MMA)", "vitamins"],
    ["Arachidonic Acid/EPA Ratio", "vitamins"],
    // Heavy metals
    ["Lead", "metals"],
    ["Mercury", "metals"],
    // Urinalysis dipstick + microscopy
    ["pH - Urine", "urinalysis"],
    ["Specific Gravity - Urine", "urinalysis"],
    ["Protein - Urine", "urinalysis"],
    ["Occult Blood - Urine", "urinalysis"],
    ["Leukocyte Esterase - Urine", "urinalysis"],
    ["Squamous Epithelial Cells - Urine", "urinalysis"],
    // Vitals (MyChart import)
    ["Resting HR", "vitals"],
    ["Respiratory Rate", "vitals"],
    ["Oxygen Saturation", "vitals"],
    ["Temperature", "vitals"],
    // DEXA body composition
    ["ALMI", "body"],
    ["FFMI", "body"],
    ["Android/Gynoid (A/G) Ratio", "body"],
    ["Bone Mineral Content (BMC)", "body"],
    ["Total Mass", "body"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(g(name), expected, `${name} should group to ${expected}, got ${g(name)}`);
  }
});

test("longest-match-wins survives the new keys (no clinically-wrong bucket)", () => {
  // Specific compound names must still beat their shorter substrings.
  assert.equal(g("Non-HDL Cholesterol"), "lipids", "non-hdl is lipids, not grabbed elsewhere");
  assert.equal(g("Alkaline Phosphatase"), "liver", "alkaline phosphatase beats bare 'alp'");
  // Kidney's long urine phrases must beat the new short urinalysis 'urine' key.
  assert.equal(g("Albumin, Random Urine"), "kidney", "urine albumin stays kidney, not urinalysis");
  assert.equal(g("Urine Creatinine"), "kidney", "urine creatinine stays kidney");
  // The DexaFit 'Respiratory Exchange Ratio' must not be mistaken for a vital sign.
  assert.equal(g("Respiratory Exchange Ratio (RER)"), "fitness");
  assert.equal(g("Respiratory Rate"), "vitals");
});

test("a '<analyte> - Urine' dipstick marker is urinalysis, not the serum analyte", () => {
  // The serum key (glucose/bilirubin/red blood cell/white blood) is longer than
  // "urine" and would win the substring race without the dash-suffix override.
  assert.equal(g("Glucose - Urine"), "urinalysis");
  assert.equal(g("Bilirubin - Urine"), "urinalysis");
  assert.equal(g("Red Blood Cell (RBC) - Urine"), "urinalysis");
  assert.equal(g("White Blood Cell (WBC) - Urine"), "urinalysis");
  // But a quantitative random-urine albumin (ACR) is genuinely kidney — no dash.
  assert.equal(g("Albumin, Random Urine without Creatinine"), "kidney");
  // And the serum versions are unaffected.
  assert.equal(g("Glucose"), "metabolic");
  assert.equal(g("Total Bilirubin"), "liver");
});

test("Liver group relabels to 'Liver & Pancreas' but still reads as Liver", () => {
  assert.equal(label("ALT"), "Liver & Pancreas");
  assert.match(label("ALT"), /Liver/i, "still matches a /Liver/ assertion");
});

test("a genuinely-composite read with no clinical home stays in Other", () => {
  assert.equal(g("Biological Age"), "other");
  assert.equal(g("Body Score"), "other");
});

test("isNonClinicalMarker drops an eyeglass Rx but never a real lab analyte", () => {
  assert.equal(repo.isNonClinicalMarker("Left Sphere (OS)"), true);
  assert.equal(repo.isNonClinicalMarker("Right Sphere (OD)"), true);
  assert.equal(repo.isNonClinicalMarker("Cylinder"), true);
  assert.equal(repo.isNonClinicalMarker("Lens Type"), true);
  // Clinical markers must pass straight through.
  for (const ok of ["Total Cholesterol", "Spherocytes", "ApoB", "Vitamin D", "Ferritin", "Globulin"]) {
    assert.equal(repo.isNonClinicalMarker(ok), false, `${ok} must not be filtered`);
  }
});

test("panels render in conventional clinical lab-review order, not longevity-impact order", () => {
  // A doctor scans in a familiar sequence (CBC → CMP → lipids → inflammation →
  // endocrine → vitamins → specialty → urinalysis → functional). One representative
  // marker per group, seeded in a deliberately-scrambled order; the present-groups
  // sequence must come back in the canonical clinical order regardless.
  resetTables("health_documents", "blood_pressure_readings");
  seedHealthDoc("2026-06-01", [
    marker("Biological Age", 41), // → other (always last)
    marker("Body Fat %", 14, { unit: "%" }),
    marker("VO2max", 48, { unit: "mL/kg/min" }),
    marker("Resting Heart Rate", 52, { unit: "bpm" }),
    marker("pH - Urine", 6.0),
    marker("Lead", 1.2, { unit: "mcg/dL" }),
    marker("PSA, Total", 0.8, { unit: "ng/mL" }),
    marker("ANA Screen", "Negative"),
    marker("Troponin T", 0.01, { unit: "ng/mL" }),
    marker("Vitamin D", 44, { unit: "ng/mL" }),
    marker("Total Testosterone", 620, { unit: "ng/dL" }),
    marker("TSH", 1.8, { unit: "mIU/L" }),
    marker("hs-CRP", 0.5, { unit: "mg/L" }),
    marker("LDL Cholesterol", 95, { unit: "mg/dL" }),
    marker("ALT", 22, { unit: "U/L" }),
    marker("BUN", 14, { unit: "mg/dL" }),
    marker("Sodium", 140, { unit: "mmol/L" }),
    marker("Glucose", 88, { unit: "mg/dL" }),
    marker("WBC", 5.5, { unit: "10*3/uL" }),
    marker("Hemoglobin", 15, { unit: "g/dL" }),
  ]);
  const { groups } = repo.getMarkerHistory();
  assert.deepEqual(
    groups.map((x) => x.key),
    [
      "iron", "blood", "metabolic", "electrolytes", "kidney", "liver", "lipids",
      "inflammation", "thyroid", "hormones", "vitamins", "cardiac", "autoimmune",
      "screening", "metals", "urinalysis", "vitals", "fitness", "body", "other",
    ],
    "groups come back in conventional clinical lab-review order",
  );
});

test("the doctor report scans electrolytes in CMP order (Na, K, Cl, CO2, anion gap)", () => {
  // Seeded deliberately out of order — the clinician report must re-sort the
  // electrolyte panel into the order a physician reads a basic metabolic panel.
  resetTables("health_documents", "blood_pressure_readings");
  seedHealthDoc("2026-06-01", [
    marker("Anion Gap", 8, { unit: "mmol/L" }),
    marker("Chloride", 101, { unit: "mmol/L" }),
    marker("Potassium", 4.2, { unit: "mmol/L" }),
    marker("Carbon Dioxide", 25, { unit: "mmol/L" }),
    marker("Sodium", 140, { unit: "mmol/L" }),
  ]);
  const data = buildClinicalReportData();
  const electro = data.groups.find((x) => x.key === "electrolytes");
  assert.ok(electro, "the report has an Electrolytes panel");
  assert.deepEqual(
    electro.markers.map((m) => m.name),
    ["Sodium", "Potassium", "Chloride", "Carbon Dioxide", "Anion Gap"],
    "electrolytes are ordered the way a CMP prints",
  );
});

test("getMarkerHistory excludes the eyewear Rx and groups the rest (no Other soup)", () => {
  resetTables("health_documents", "blood_pressure_readings");
  seedHealthDoc("2026-06-01", [
    marker("Total Cholesterol", 290, { unit: "mg/dL", flag: "high" }),
    marker("Chloride", 101, { unit: "mmol/L" }),
    marker("VO2max", 48, { unit: "mL/kg/min" }),
    marker("pH - Urine", 6.0),
    marker("Lead", 1.2, { unit: "mcg/dL" }),
    marker("Left Sphere (OS)", -1.25, { unit: "D" }),
    marker("Lens Type", "single-vision"),
  ]);
  const { markers, groups } = repo.getMarkerHistory();
  const names = markers.map((m) => m.name);
  assert.ok(!names.includes("Left Sphere (OS)"), "eyewear sphere filtered out");
  assert.ok(!names.includes("Lens Type"), "lens type filtered out");
  assert.ok(names.includes("Total Cholesterol"), "clinical markers retained");
  // None of the retained clinical markers fell into the catch-all.
  const groupKeys = new Set(markers.map((m) => m.group));
  assert.ok(!groupKeys.has("other"), "no clinical marker landed in Other");
  const present = new Set(groups.map((x) => x.key));
  for (const k of ["lipids", "electrolytes", "fitness", "urinalysis", "metals"]) {
    assert.ok(present.has(k), `present groups include ${k}`);
  }
});
