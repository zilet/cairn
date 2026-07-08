import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, marker, repo, resetTables, seedHealthDoc } from "./_seed.js";

beforeEach(() => {
  resetTables("profile", "health_documents", "body_measurements", "garmin_daily_metrics", "garmin_sources");
});

test("cardiovascular risk read collects inputs, enhancers, and lever projections without inventing a score", () => {
  repo.setProfile({
    sex: "male",
    age: 44,
    height_in: 66,
    weight_lb: 190,
    about_me: "Father had a heart attack young.",
  });
  db.prepare(
    `INSERT INTO body_measurements (date, waist_in, neck_in, hip_in, source)
     VALUES ('2026-07-01', 42, 16, 40, 'manual')`
  ).run();
  seedHealthDoc("2026-06-15", [
    marker("Total Cholesterol", 238, { unit: "mg/dL" }),
    marker("HDL Cholesterol", 54, { unit: "mg/dL" }),
    marker("LDL Cholesterol", 173, { unit: "mg/dL", flag: "high" }),
    marker("Non-HDL Cholesterol", 184, { unit: "mg/dL", flag: "high" }),
    marker("ApoB", 125, { unit: "mg/dL", flag: "high" }),
    marker("Lp(a)", 120, { unit: "nmol/L", flag: "high" }),
    marker("hs-CRP", 1.8, { unit: "mg/L", flag: "high" }),
    marker("HbA1c", 5.3, { unit: "%" }),
    marker("eGFR", 98, { unit: "mL/min" }),
    marker("Systolic BP", 120, { unit: "mmHg" }),
    marker("VO2max", 35, { unit: "mL/kg/min" }),
  ]);

  const risk = repo.cardiovascularRiskRead();
  assert.equal(risk.model_status.prevent, "computed_provisional");
  assert.equal(risk.inputs.age, 44);
  assert.equal(risk.inputs.sex, "male");
  assert.equal(risk.inputs.markers.apob.value, 125);
  assert.equal(risk.inputs.diabetes_by_a1c, false);
  assert.ok(risk.inputs.missing_inputs.includes("smoking status"));
  assert.ok(risk.inputs.body_fat_pct > 25);

  // The AHA PREVENT (2023) base-model estimate: real numbers now that
  // coefficients are vendored, but provisional because smoking/BP-treatment/
  // statin status aren't captured anywhere yet, so PREVENT assumes the
  // lower-risk value for each.
  assert.ok(risk.prevent.provisional);
  assert.equal(risk.prevent.confidence, "provisional");
  const tenYear = risk.prevent.estimates.total_cvd.ten_year;
  assert.ok(typeof tenYear === "number" && tenYear > 0 && tenYear < 1);
  assert.ok(typeof risk.prevent.vascular_age === "number");
  assert.ok(risk.prevent.assumptions.some((a) => a.input === "smoking"));

  const keys = risk.enhancers.map((e) => e.key);
  assert.ok(keys.includes("apob"));
  assert.ok(keys.includes("lpa"));
  assert.ok(keys.includes("hs_crp"));
  assert.ok(keys.includes("body_fat"));
  assert.ok(keys.includes("vo2max"));
  assert.ok(keys.includes("family_history"));
  assert.ok(risk.projections.some((p) => p.key === "apob" && p.target === 80));
});

test("captured smoking/BP-treatment/statin status removes the provisional assumptions", () => {
  const baseProfile = {
    sex: "male",
    age: 44,
    height_in: 66,
    weight_lb: 190,
  };
  const markers = () =>
    seedHealthDoc("2026-06-15", [
      marker("Total Cholesterol", 238, { unit: "mg/dL" }),
      marker("HDL Cholesterol", 54, { unit: "mg/dL" }),
      marker("HbA1c", 5.3, { unit: "%" }),
      marker("eGFR", 98, { unit: "mL/min" }),
      marker("Systolic BP", 120, { unit: "mmHg" }),
    ]);

  repo.setProfile({ ...baseProfile, smoking: 0, bp_treated: 0, statin: 0 });
  markers();
  const computed = repo.cardiovascularRiskRead();
  assert.equal(computed.model_status.prevent, "computed");
  assert.equal(computed.prevent.provisional, false);
  assert.equal(computed.prevent.confidence, "high");
  assert.deepEqual(computed.prevent.assumptions, []);
  assert.ok(!computed.inputs.missing_inputs.includes("smoking status"));
  assert.ok(!computed.inputs.missing_inputs.includes("blood-pressure treatment status"));
  assert.ok(!computed.inputs.missing_inputs.includes("statin treatment status"));
  const nonSmokerTenYear = computed.prevent.estimates.total_cvd.ten_year;

  resetTables("profile", "health_documents");
  repo.setProfile({ ...baseProfile, smoking: 1, bp_treated: 0, statin: 0 });
  markers();
  const smoker = repo.cardiovascularRiskRead();
  assert.equal(smoker.model_status.prevent, "computed");
  assert.equal(smoker.prevent.provisional, false);
  const smokerTenYear = smoker.prevent.estimates.total_cvd.ten_year;
  assert.ok(typeof smokerTenYear === "number" && smokerTenYear > nonSmokerTenYear);
});

test("cardiovascular risk read degrades on sparse data", () => {
  const risk = repo.cardiovascularRiskRead();
  assert.equal(risk.model_status.prevent, "insufficient_inputs");
  assert.equal(risk.inputs.age, null);
  assert.ok(risk.inputs.missing_inputs.includes("age"));
  assert.equal(risk.prevent, null);
  assert.deepEqual(risk.enhancers, []);
  assert.ok(risk.projections.length >= 1);
});

test("Lp(a) flags on the correct per-unit threshold (mg/dL ~30, not nmol/L ~75)", () => {
  // 45 mg/dL is elevated — but reads BELOW the 75 nmol/L threshold, so a single
  // >75 gate silently misses it. Branching on the unit must flag it.
  repo.setProfile({ sex: "male", age: 50, height_in: 70, weight_lb: 200 });
  seedHealthDoc("2026-06-01", [
    marker("Total Cholesterol", 190, { unit: "mg/dL" }),
    marker("HDL Cholesterol", 45, { unit: "mg/dL" }),
    marker("Lp(a)", 45, { unit: "mg/dL", flag: "high" }),
    marker("eGFR", 90, { unit: "mL/min" }),
    marker("Systolic BP", 124, { unit: "mmHg" }),
  ]);
  assert.ok(
    repo.cardiovascularRiskRead().enhancers.some((e) => e.key === "lpa"),
    "45 mg/dL Lp(a) must flag"
  );

  // The same numeric value in nmol/L (45 < 75) must NOT flag.
  resetTables("profile", "health_documents");
  repo.setProfile({ sex: "male", age: 50, height_in: 70, weight_lb: 200 });
  seedHealthDoc("2026-06-01", [
    marker("Total Cholesterol", 190, { unit: "mg/dL" }),
    marker("HDL Cholesterol", 45, { unit: "mg/dL" }),
    marker("Lp(a)", 45, { unit: "nmol/L", flag: "normal" }),
    marker("eGFR", 90, { unit: "mL/min" }),
    marker("Systolic BP", 124, { unit: "mmHg" }),
  ]);
  assert.ok(!repo.cardiovascularRiskRead().enhancers.some((e) => e.key === "lpa"), "45 nmol/L Lp(a) must not flag");
});

test("total cholesterol is derived from LDL + HDL + triglycerides when absent (Friedewald-consistent)", () => {
  repo.setProfile({ sex: "male", age: 50, height_in: 70, weight_lb: 200, smoking: 0, bp_treated: 0, statin: 0 });
  seedHealthDoc("2026-06-01", [
    marker("LDL-C", 150, { unit: "mg/dL", flag: "high" }),
    marker("HDL Cholesterol", 45, { unit: "mg/dL" }),
    marker("Triglycerides", 150, { unit: "mg/dL" }),
    marker("eGFR", 90, { unit: "mL/min" }),
    marker("Systolic BP", 128, { unit: "mmHg" }),
  ]);
  const risk = repo.cardiovascularRiskRead();
  // 150 + 45 + 150/5 = 225
  assert.equal(risk.inputs.markers.total_cholesterol.value, 225);
  assert.equal(risk.model_status.prevent, "computed_provisional");
  assert.ok(risk.prevent.assumptions.some((a) => a.input === "total cholesterol"));
  const ten = risk.prevent.estimates.total_cvd.ten_year;
  assert.ok(typeof ten === "number" && ten > 0 && ten < 1);
});

test("total cholesterol is NOT derived when triglycerides are >= 400 (Friedewald breaks down)", () => {
  repo.setProfile({ sex: "male", age: 50, height_in: 70, weight_lb: 200 });
  seedHealthDoc("2026-06-01", [
    marker("LDL-C", 150, { unit: "mg/dL" }),
    marker("HDL Cholesterol", 45, { unit: "mg/dL" }),
    marker("Triglycerides", 450, { unit: "mg/dL", flag: "high" }),
    marker("eGFR", 90, { unit: "mL/min" }),
    marker("Systolic BP", 128, { unit: "mmHg" }),
  ]);
  const risk = repo.cardiovascularRiskRead();
  assert.equal(risk.inputs.markers.total_cholesterol.value, null);
  assert.equal(risk.model_status.prevent, "insufficient_inputs");
  assert.ok(risk.inputs.missing_inputs.includes("total cholesterol"));
});

test("GOLDEN: the risk projection is a REAL recompute — targets-met CVD is below current when levers cut lipids/BMI/smoking", () => {
  repo.setProfile({ sex: "male", age: 55, height_in: 69, weight_lb: 210, smoking: 1, bp_treated: 0, statin: 0 });
  seedHealthDoc("2026-06-01", [
    marker("Total Cholesterol", 240, { unit: "mg/dL", flag: "high" }),
    marker("HDL Cholesterol", 40, { unit: "mg/dL" }),
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("Lp(a)", 200, { unit: "nmol/L", flag: "high" }),
    marker("eGFR", 85, { unit: "mL/min" }),
    marker("Systolic BP", 135, { unit: "mmHg", flag: "high" }),
  ]);
  const proj = repo.cardiovascularRiskRead().prevent.projection;
  assert.ok(proj, "projection block present");
  assert.ok(proj.levers_applied.length >= 1);
  // The whole point: a genuine second PREVENT pass, strictly lower at both horizons.
  assert.ok(proj.targets_met.ten_year < proj.current.ten_year);
  assert.ok(proj.targets_met.thirty_year < proj.current.thirty_year);
  assert.ok(proj.targets_met.vascular_age <= proj.current.vascular_age);
  const keys = proj.levers_applied.map((l) => l.key);
  assert.ok(keys.includes("lipids")); // routed through non-HDL, NOT ApoB directly
  assert.ok(keys.includes("body_fat")); // BMI 31 > 25
  assert.ok(keys.includes("smoking"));
  assert.ok(!keys.includes("lpa"), "Lp(a) is genetic and never a lever");
});

test("the risk projection applies no lever (no fabricated gap) when every PREVENT input is already optimal", () => {
  repo.setProfile({ sex: "female", age: 45, height_in: 66, weight_lb: 135, smoking: 0, bp_treated: 0, statin: 0 });
  seedHealthDoc("2026-06-01", [
    marker("Total Cholesterol", 160, { unit: "mg/dL" }),
    marker("HDL Cholesterol", 70, { unit: "mg/dL" }),
    marker("ApoB", 70, { unit: "mg/dL" }),
    marker("eGFR", 100, { unit: "mL/min" }),
    marker("Systolic BP", 110, { unit: "mmHg" }),
  ]);
  const proj = repo.cardiovascularRiskRead().prevent.projection;
  assert.deepEqual(proj.levers_applied, []);
  assert.equal(proj.targets_met.ten_year, proj.current.ten_year);
  assert.equal(proj.targets_met.thirty_year, proj.current.thirty_year);
});

test("null height_in falls through to height_cm for BMI (asNumber treats null as absent, not 0)", () => {
  // Regression: asNumber(null) used to return 0, which short-circuited the
  // height_cm → BMI fallback and left BMI null (and the whole read insufficient).
  repo.setProfile({ sex: "female", age: 41, height_cm: 167, weight_lb: 149, smoking: 0, bp_treated: 0, statin: 0 });
  seedHealthDoc("2026-06-01", [
    marker("Total Cholesterol", 185, { unit: "mg/dL" }),
    marker("HDL Cholesterol", 58, { unit: "mg/dL" }),
    marker("eGFR", 100, { unit: "mL/min" }),
    marker("Systolic BP", 116, { unit: "mmHg" }),
  ]);
  const risk = repo.cardiovascularRiskRead();
  assert.ok(risk.inputs.bmi != null && risk.inputs.bmi > 20 && risk.inputs.bmi < 30);
  assert.notEqual(risk.model_status.prevent, "insufficient_inputs");
  assert.ok(!risk.inputs.missing_inputs.includes("height/weight for BMI"));
});
