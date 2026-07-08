// AHA PREVENT (2023) cardiovascular-risk engine — the BASE model only (no
// hba1c/uacr/sdi variants). Pure math: no I/O, no DB. Coefficients come from
// the generated src/repo/prevent-coefficients.ts (see that file's header for
// provenance + scripts/gen-prevent-coefficients.mjs to regenerate). Transforms,
// centering, and the zeroing rules (heart_failure drops lipids and is the only
// outcome using BMI) all live in the coefficients themselves — this file just
// does a keyed dot product, so it never special-cases an outcome.
import { PREVENT_BASE_MODELS, PREVENT_META, type PreventModelBlock } from "./prevent-coefficients.js";

export type PreventInputs = {
  age: number; // years
  sex: "male" | "female";
  total_chol: number; // mg/dL
  hdl: number; // mg/dL
  sbp: number; // mmHg
  bp_treated: boolean;
  diabetes: boolean;
  smoker: boolean;
  bmi: number; // kg/m^2
  egfr: number; // mL/min/1.73m^2 (CKD-EPI 2021)
  statin: boolean;
};

export type PreventOutcomeEstimate = { ten_year: number | null; thirty_year: number | null };

export type PreventEstimate = {
  total_cvd: PreventOutcomeEstimate;
  ascvd: PreventOutcomeEstimate;
  heart_failure: PreventOutcomeEstimate;
  vascular_age: number | null;
};

const CHOL = PREVENT_META.chol_mgdl_to_mmol; // mg/dL -> mmol/L, 0.02586

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// The transformed base-model predictor vector, mirroring
// data/cv-risk-artifacts/README.md's transform spec verbatim. SBP/BMI/eGFR are
// clamped to PREVENT's validated input ranges before the spline knot math (the
// knot itself already caps one side; this caps the other so an extreme input
// doesn't extrapolate past where the model was fit). Age is NOT clamped here —
// callers only reach this after checking the horizon's age range.
function buildBaseTerms(inputs: PreventInputs): Record<string, number> {
  const sbp = clamp(inputs.sbp, 90, 180);
  const bmi = clamp(inputs.bmi, 18.5, 39.9);
  const egfr = clamp(inputs.egfr, 15, 140);

  const a = (inputs.age - 55) / 10;
  const nonHdlC = CHOL * (inputs.total_chol - inputs.hdl) - 3.5;
  const hdlC = (CHOL * inputs.hdl - 1.3) / 0.3;
  const sbpLt110 = (Math.min(sbp, 110) - 110) / 20;
  const sbpGte110 = (Math.max(sbp, 110) - 130) / 20;
  const bmiLt30 = (Math.min(bmi, 30) - 25) / 5;
  const bmiGte30 = (Math.max(bmi, 30) - 30) / 5;
  const egfrLt60 = (Math.min(egfr, 60) - 60) / -15;
  const egfrGte60 = (Math.max(egfr, 60) - 90) / -15;
  const dm = inputs.diabetes ? 1 : 0;
  const smoking = inputs.smoker ? 1 : 0;
  const bpTx = inputs.bp_treated ? 1 : 0;
  const statin = inputs.statin ? 1 : 0;

  return {
    age: a,
    age_squared: a * a,
    non_hdl_c: nonHdlC,
    hdl_c: hdlC,
    sbp_lt_110: sbpLt110,
    sbp_gte_110: sbpGte110,
    diabetes: dm,
    smoking,
    bmi_lt_30: bmiLt30,
    bmi_gte_30: bmiGte30,
    egfr_lt_60: egfrLt60,
    egfr_gte_60: egfrGte60,
    bp_tx: bpTx,
    statin,
    treated_sbp_gte_110: bpTx * sbpGte110,
    treated_non_hdl_c: statin * nonHdlC,
    age_non_hdl_c: a * nonHdlC,
    age_hdl_c: a * hdlC,
    age_sbp_gte_110: a * sbpGte110,
    age_diabetes: a * dm,
    age_smoking: a * smoking,
    age_bmi_gte_30: a * bmiGte30,
    age_egfr_lt_60: a * egfrLt60,
  };
}

// The reference-individual predictor vector for a given age: non-smoker,
// non-diabetic, untreated, no statin, and every other risk factor pinned to
// PREVENT's own centering point (see coeffs.json meta.centering — SBP 130,
// BMI 25, eGFR 90, and cholesterol values that zero non_hdl_c/hdl_c). At the
// centering point every spline term evaluates to 0 by construction, so all
// interaction terms (which multiply by those zeroed terms) are 0 too — this
// is built directly rather than round-tripped through mg/dL inputs.
function referenceTerms(age: number): Record<string, number> {
  const a = (age - 55) / 10;
  return {
    age: a,
    age_squared: a * a,
    non_hdl_c: 0,
    hdl_c: 0,
    sbp_lt_110: 0,
    sbp_gte_110: 0,
    diabetes: 0,
    smoking: 0,
    bmi_lt_30: 0,
    bmi_gte_30: 0,
    egfr_lt_60: 0,
    egfr_gte_60: 0,
    bp_tx: 0,
    statin: 0,
    treated_sbp_gte_110: 0,
    treated_non_hdl_c: 0,
    age_non_hdl_c: 0,
    age_hdl_c: 0,
    age_sbp_gte_110: 0,
    age_diabetes: 0,
    age_smoking: 0,
    age_bmi_gte_30: 0,
    age_egfr_lt_60: 0,
  };
}

function dot(block: PreventModelBlock, terms: Record<string, number>): number {
  let sum = block.intercept;
  for (const key of Object.keys(block.betas)) {
    sum += block.betas[key] * (terms[key] ?? 0);
  }
  return sum;
}

function modelBlock(
  sex: "male" | "female",
  outcome: "total_cvd" | "ascvd" | "heart_failure",
  horizon: "10yr" | "30yr"
): PreventModelBlock | null {
  return PREVENT_BASE_MODELS[`base|${sex}|${outcome}|${horizon}`] ?? null;
}

function computeOutcome(
  sex: "male" | "female",
  outcome: "total_cvd" | "ascvd" | "heart_failure",
  horizon: "10yr" | "30yr",
  terms: Record<string, number>
): number | null {
  const block = modelBlock(sex, outcome, horizon);
  if (!block) return null;
  return sigmoid(dot(block, terms));
}

// The reference individual's 10-year total-CVD risk at a given age — a
// monotonically increasing function of age (positive age beta in the base
// total_cvd model for both sexes), which is what makes the vascular-age search
// below well-defined.
function referenceTotalCvd10yr(sex: "male" | "female", age: number): number | null {
  const block = modelBlock(sex, "total_cvd", "10yr");
  if (!block) return null;
  return sigmoid(dot(block, referenceTerms(age)));
}

// Vascular age: the derived (non-official) age at which a same-sex reference
// individual — non-smoker, non-diabetic, untreated, no statin, every other
// factor at PREVENT's centering point — carries the SAME 10-year total-CVD
// risk as this person. Solved by monotonic binary search over the validated
// 10-year age range [30, 79]; a target risk outside that bracket's reference
// range clamps to the nearer end rather than extrapolating.
function solveVascularAge(sex: "male" | "female", targetRisk: number): number | null {
  const LO = 30;
  const HI = 79;
  const riskLo = referenceTotalCvd10yr(sex, LO);
  const riskHi = referenceTotalCvd10yr(sex, HI);
  if (riskLo == null || riskHi == null) return null;
  if (targetRisk <= riskLo) return LO;
  if (targetRisk >= riskHi) return HI;
  let lo = LO;
  let hi = HI;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const riskMid = referenceTotalCvd10yr(sex, mid);
    if (riskMid == null) return null;
    if (riskMid < targetRisk) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

// Compute 10-year and 30-year risk for total_cvd/ascvd/heart_failure plus a
// derived vascular age. A horizon whose age is outside PREVENT's validated
// range returns null for that horizon ONLY (10yr: 30-79, 30yr: 30-59) — that
// is correct behavior, not a failure (see data/cv-risk-artifacts/vectors-README.md).
export function estimatePreventRisk(inputs: PreventInputs): PreventEstimate {
  const tenYearValid = inputs.age >= 30 && inputs.age <= 79;
  const thirtyYearValid = inputs.age >= 30 && inputs.age <= 59;

  const outcomes: Array<"total_cvd" | "ascvd" | "heart_failure"> = ["total_cvd", "ascvd", "heart_failure"];
  const terms = tenYearValid || thirtyYearValid ? buildBaseTerms(inputs) : null;

  const estimates: PreventEstimate = {
    total_cvd: { ten_year: null, thirty_year: null },
    ascvd: { ten_year: null, thirty_year: null },
    heart_failure: { ten_year: null, thirty_year: null },
    vascular_age: null,
  };

  if (terms) {
    for (const outcome of outcomes) {
      estimates[outcome] = {
        ten_year: tenYearValid ? computeOutcome(inputs.sex, outcome, "10yr", terms) : null,
        thirty_year: thirtyYearValid ? computeOutcome(inputs.sex, outcome, "30yr", terms) : null,
      };
    }
  }

  estimates.vascular_age =
    estimates.total_cvd.ten_year != null ? solveVascularAge(inputs.sex, estimates.total_cvd.ten_year) : null;

  return estimates;
}
