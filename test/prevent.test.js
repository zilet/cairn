// Golden-vector tests for estimatePreventRisk (src/repo/prevent.ts), the pure
// AHA PREVENT (2023) base-model engine. No DB — this is math, not a repo test.
//
// Personas are copied VERBATIM from data/cv-risk-artifacts/vectors.json (an
// independently-generated oracle: preventr testthat fixtures + ClinCalc, see
// that artifact's vectors-README.md), not read from the artifact at test time
// so the suite stays self-contained/offline. Only the "base" model personas are
// used here (p01, p02, e01-e03); the hba1c/uacr/full personas (p03-p08, e04)
// exercise variant models that are out of scope for v1 — coeffs.json already
// carries their coefficients for whenever that work happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatePreventRisk } from "../dist/repo/prevent.js";

const TOL = 0.001;
const TOL_E01 = 0.0005; // e01 was printed to 1-decimal % by its ClinCalc oracle

const BASE_PERSONAS = [
  {
    id: "p01_f50_base",
    inputs: {
      age: 50,
      sex: "female",
      total_chol: 200,
      hdl: 45,
      sbp: 160,
      bp_treated: true,
      diabetes: true,
      smoker: false,
      bmi: 35,
      egfr: 90,
      statin: false,
    },
    expected: {
      total_cvd_10yr: 0.147,
      ascvd_10yr: 0.092,
      hf_10yr: 0.081,
      total_cvd_30yr: 0.53,
      ascvd_30yr: 0.354,
      hf_30yr: 0.39,
    },
    tol: TOL,
  },
  {
    id: "p02_m50_base",
    inputs: {
      age: 50,
      sex: "male",
      total_chol: 200,
      hdl: 45,
      sbp: 160,
      bp_treated: true,
      diabetes: true,
      smoker: false,
      bmi: 35,
      egfr: 90,
      statin: false,
    },
    expected: {
      total_cvd_10yr: 0.163,
      ascvd_10yr: 0.102,
      hf_10yr: 0.106,
      total_cvd_30yr: 0.514,
      ascvd_30yr: 0.349,
      hf_30yr: 0.424,
    },
    tol: TOL,
  },
  {
    id: "e01_m30_lowrisk_edge",
    inputs: {
      age: 30,
      sex: "male",
      total_chol: 170,
      hdl: 55,
      sbp: 115,
      bp_treated: false,
      diabetes: false,
      smoker: false,
      bmi: 24,
      egfr: 100,
      statin: false,
    },
    expected: { total_cvd_10yr: 0.004, ascvd_10yr: 0.003, hf_10yr: 0.001 },
    tol: TOL_E01,
  },
  {
    id: "e02_f79_highrisk_edge",
    inputs: {
      age: 79,
      sex: "female",
      total_chol: 240,
      hdl: 35,
      sbp: 155,
      bp_treated: true,
      diabetes: true,
      smoker: true,
      bmi: 32,
      egfr: 55,
      statin: false,
    },
    expected: { total_cvd_10yr: 0.385, ascvd_10yr: 0.258, hf_10yr: 0.278 },
    tol: TOL,
  },
  {
    id: "e03_m45_smoker",
    inputs: {
      age: 45,
      sex: "male",
      total_chol: 220,
      hdl: 42,
      sbp: 138,
      bp_treated: false,
      diabetes: false,
      smoker: true,
      bmi: 29,
      egfr: 78,
      statin: false,
    },
    expected: { total_cvd_10yr: 0.054, ascvd_10yr: 0.038, hf_10yr: 0.018 },
    tol: TOL,
  },
];

for (const persona of BASE_PERSONAS) {
  test(`PREVENT base model golden vector: ${persona.id}`, () => {
    const est = estimatePreventRisk(persona.inputs);
    const checks = [
      ["total_cvd_10yr", est.total_cvd.ten_year],
      ["ascvd_10yr", est.ascvd.ten_year],
      ["hf_10yr", est.heart_failure.ten_year],
    ];
    if (persona.expected.total_cvd_30yr != null) {
      checks.push(
        ["total_cvd_30yr", est.total_cvd.thirty_year],
        ["ascvd_30yr", est.ascvd.thirty_year],
        ["hf_30yr", est.heart_failure.thirty_year]
      );
    }
    for (const [key, actual] of checks) {
      const expected = persona.expected[key];
      assert.ok(
        Math.abs(actual - expected) <= persona.tol,
        `${persona.id} ${key}: expected ${expected}, got ${actual}`
      );
    }
  });
}

test("30-year risk is null past the validated age-59 ceiling (age still valid for 10yr)", () => {
  // e02's own persona (age 79) has no 30yr oracle value at all (out of range);
  // this pins the actual null-return behavior the vectors-README calls out.
  const est = estimatePreventRisk({
    age: 79,
    sex: "female",
    total_chol: 240,
    hdl: 35,
    sbp: 155,
    bp_treated: true,
    diabetes: true,
    smoker: true,
    bmi: 32,
    egfr: 55,
    statin: false,
  });
  assert.equal(est.total_cvd.thirty_year, null);
  assert.equal(est.ascvd.thirty_year, null);
  assert.equal(est.heart_failure.thirty_year, null);
  // 10yr still computes fine at age 79 (within the 30-79 range).
  assert.ok(est.total_cvd.ten_year != null);
});

test("10-year and 30-year risk are both null outside PREVENT's overall validated age range", () => {
  const tooYoung = estimatePreventRisk({
    age: 25,
    sex: "male",
    total_chol: 180,
    hdl: 50,
    sbp: 120,
    bp_treated: false,
    diabetes: false,
    smoker: false,
    bmi: 24,
    egfr: 100,
    statin: false,
  });
  assert.equal(tooYoung.total_cvd.ten_year, null);
  assert.equal(tooYoung.total_cvd.thirty_year, null);
  assert.equal(tooYoung.vascular_age, null);

  const tooOld = estimatePreventRisk({
    age: 85,
    sex: "male",
    total_chol: 180,
    hdl: 50,
    sbp: 120,
    bp_treated: false,
    diabetes: false,
    smoker: false,
    bmi: 24,
    egfr: 30,
    statin: false,
  });
  assert.equal(tooOld.total_cvd.ten_year, null);
  assert.equal(tooOld.total_cvd.thirty_year, null);
});

test("vascular age is monotonic with risk (a higher-risk persona reads an older vascular age) and finite", () => {
  const lowRisk = estimatePreventRisk({
    age: 30,
    sex: "male",
    total_chol: 170,
    hdl: 55,
    sbp: 115,
    bp_treated: false,
    diabetes: false,
    smoker: false,
    bmi: 24,
    egfr: 100,
    statin: false,
  });
  const highRisk = estimatePreventRisk({
    age: 45,
    sex: "male",
    total_chol: 220,
    hdl: 42,
    sbp: 138,
    bp_treated: false,
    diabetes: false,
    smoker: true,
    bmi: 29,
    egfr: 78,
    statin: false,
  });
  assert.ok(Number.isFinite(lowRisk.vascular_age));
  assert.ok(Number.isFinite(highRisk.vascular_age));
  assert.ok(lowRisk.vascular_age >= 30 && lowRisk.vascular_age <= 79);
  assert.ok(highRisk.vascular_age >= 30 && highRisk.vascular_age <= 79);
  assert.ok(highRisk.vascular_age > lowRisk.vascular_age);
});

// --- Variant models (hba1c/uacr/sdi/full) are future work ---
// coeffs.json already carries the coefficient blocks for base+hba1c, base+uacr,
// base+sdi, and the full model, and vectors.json carries golden personas for
// each (p03-p08, e04) — but estimatePreventRisk only implements the base model
// in v1 (see the CLAUDE.md wave-2 scope note). Wiring a variant in means
// swapping in that variant's own separately-fit coefficient block wholesale,
// not appending its extra terms onto the base betas.
