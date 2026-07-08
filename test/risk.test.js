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

test("cardiovascular risk read degrades on sparse data", () => {
  const risk = repo.cardiovascularRiskRead();
  assert.equal(risk.model_status.prevent, "insufficient_inputs");
  assert.equal(risk.inputs.age, null);
  assert.ok(risk.inputs.missing_inputs.includes("age"));
  assert.equal(risk.prevent, null);
  assert.deepEqual(risk.enhancers, []);
  assert.ok(risk.projections.length >= 1);
});
