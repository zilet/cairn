import { getMarkerHistory } from "./health.js";
import { estimatePreventRisk, type PreventInputs } from "./prevent.js";
import { matchOptimalZone } from "./propagation-data.js";
import { currentBodyFatEstimate, getProfile } from "./profile.js";

type PreventAssumption = { input: string; assumed: string; reason: string };

type RiskMarker = {
  label: string;
  value: number | null;
  unit: string | null;
  date: string | null;
};

type RiskEnhancer = {
  key: string;
  label: string;
  finding: string;
  why: string;
  lever: string | null;
};

type RiskProjection = {
  key: string;
  label: string;
  current: number | null;
  target: number;
  unit: string;
  expected_direction: "lower" | "higher";
  why: string;
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function asNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function markerByZone(label: string): RiskMarker {
  const markers = (() => {
    try {
      return getMarkerHistory().markers as any[];
    } catch {
      return [];
    }
  })();
  for (const marker of markers) {
    const zone = matchOptimalZone(marker?.name);
    const markerLabel = zone?.label ?? marker?.name;
    if (String(markerLabel || "").toLowerCase() !== label.toLowerCase()) continue;
    const value = asNumber(marker?.latest?.value);
    return {
      label,
      value,
      unit: marker?.unit ?? marker?.latest?.unit ?? null,
      date: marker?.latest?.date ?? null,
    };
  }
  return { label, value: null, unit: null, date: null };
}

function hasFamilyHistory(profile: any): boolean {
  const text = `${profile?.notes ?? ""} ${profile?.about_me ?? ""}`.toLowerCase();
  return (
    /family history|father|mother|parent|brother|sister/.test(text) &&
    /heart|cardiac|stroke|attack|cvd|cholesterol/.test(text)
  );
}

function markerFinding(marker: RiskMarker): string {
  return marker.value == null
    ? `${marker.label} not on file`
    : `${marker.label} ${marker.value}${marker.unit ? ` ${marker.unit}` : ""}${marker.date ? ` (${marker.date})` : ""}`;
}

function addEnhancer(out: RiskEnhancer[], condition: boolean, item: RiskEnhancer): void {
  if (condition) out.push(item);
}

export function cardiovascularRiskRead() {
  const profile = (() => {
    try {
      return getProfile() as any;
    } catch {
      return null;
    }
  })();
  const age = asNumber(profile?.age);
  const sex = profile?.sex ? String(profile.sex).toLowerCase() : null;
  const weightLb = asNumber(profile?.weight_lb);
  const heightIn =
    asNumber(profile?.height_in) ?? (asNumber(profile?.height_cm) != null ? asNumber(profile.height_cm)! / 2.54 : null);
  const bmi =
    weightLb != null && heightIn != null && heightIn > 0 ? round1((weightLb / (heightIn * heightIn)) * 703) : null;
  const bodyFat = currentBodyFatEstimate(profile);

  const markers = {
    total_cholesterol: markerByZone("Total cholesterol"),
    hdl_c: markerByZone("HDL-C"),
    ldl_c: markerByZone("LDL-C"),
    non_hdl_c: markerByZone("Non-HDL-C"),
    apob: markerByZone("ApoB"),
    lpa: markerByZone("Lp(a)"),
    hs_crp: markerByZone("hs-CRP"),
    hba1c: markerByZone("HbA1c"),
    egfr: markerByZone("eGFR"),
    systolic_bp: markerByZone("Systolic BP"),
    vo2max: markerByZone("VO2max"),
  };

  // profile.smoking/bp_treated/statin are 0/1/NULL (NULL = not captured). Real
  // status wins whenever it's on file; a still-unset input falls back to
  // PREVENT's population-typical LOWER-RISK default and keeps the read provisional.
  const smokingFlag = profile?.smoking != null ? !!Number(profile.smoking) : null;
  const bpTreatedFlag = profile?.bp_treated != null ? !!Number(profile.bp_treated) : null;
  const statinFlag = profile?.statin != null ? !!Number(profile.statin) : null;

  const missing_inputs: string[] = [];
  if (age == null) missing_inputs.push("age");
  if (!sex) missing_inputs.push("sex");
  if (markers.total_cholesterol.value == null) missing_inputs.push("total cholesterol");
  if (markers.hdl_c.value == null) missing_inputs.push("HDL-C");
  if (markers.systolic_bp.value == null) missing_inputs.push("systolic blood pressure");
  if (markers.egfr.value == null) missing_inputs.push("eGFR");
  if (bmi == null) missing_inputs.push("height/weight for BMI");
  if (smokingFlag == null) missing_inputs.push("smoking status");
  if (bpTreatedFlag == null) missing_inputs.push("blood-pressure treatment status");
  if (statinFlag == null) missing_inputs.push("statin treatment status");

  const diabetesByA1c = markers.hba1c.value != null ? markers.hba1c.value >= 6.5 : null;

  // AHA PREVENT (2023) base-model risk. Smoking/BP-treatment/statin use the real
  // captured value when the athlete has recorded it; any still-unset one defaults
  // to the population-typical LOWER-RISK value and keeps the read provisional.
  // Diabetes uses the same HbA1c-derived flag as `inputs.diabetes_by_a1c` above,
  // assuming non-diabetic when HbA1c is missing.
  const preventSex: "male" | "female" | null = sex === "male" || sex === "female" ? sex : null;
  const preventReady =
    age != null &&
    preventSex != null &&
    markers.total_cholesterol.value != null &&
    markers.hdl_c.value != null &&
    markers.systolic_bp.value != null &&
    markers.egfr.value != null &&
    bmi != null;

  let preventStatus: "computed" | "computed_provisional" | "insufficient_inputs" = "insufficient_inputs";
  let prevent: {
    provisional: boolean;
    assumptions: PreventAssumption[];
    confidence: "provisional" | "high";
    estimates: {
      total_cvd: { ten_year: number | null; thirty_year: number | null };
      ascvd: { ten_year: number | null; thirty_year: number | null };
      heart_failure: { ten_year: number | null; thirty_year: number | null };
    };
    vascular_age: number | null;
    horizons_note: string;
    frame: string;
  } | null = null;

  if (preventReady) {
    const assumptions: PreventAssumption[] = [];
    if (smokingFlag == null) {
      assumptions.push({
        input: "smoking",
        assumed: "non-smoker",
        reason: "Smoking status isn't captured yet; PREVENT assumes the lower-risk value until it is.",
      });
    }
    if (bpTreatedFlag == null) {
      assumptions.push({
        input: "blood-pressure treatment",
        assumed: "not on antihypertensive medication",
        reason: "BP-treatment status isn't captured yet; PREVENT assumes the lower-risk value until it is.",
      });
    }
    if (statinFlag == null) {
      assumptions.push({
        input: "statin use",
        assumed: "not on a statin",
        reason: "Statin status isn't captured yet; PREVENT assumes the lower-risk value until it is.",
      });
    }
    if (diabetesByA1c == null) {
      assumptions.push({
        input: "diabetes",
        assumed: "non-diabetic",
        reason: "No HbA1c on file to derive diabetes status from; PREVENT assumes the lower-risk value until one is.",
      });
    }

    const preventInputs: PreventInputs = {
      age: age!,
      sex: preventSex!,
      total_chol: markers.total_cholesterol.value!,
      hdl: markers.hdl_c.value!,
      sbp: markers.systolic_bp.value!,
      bp_treated: bpTreatedFlag ?? false,
      diabetes: diabetesByA1c ?? false,
      smoker: smokingFlag ?? false,
      bmi: bmi!,
      egfr: markers.egfr.value!,
      statin: statinFlag ?? false,
    };
    const estimate = estimatePreventRisk(preventInputs);
    const hasAnyEstimate = [estimate.total_cvd, estimate.ascvd, estimate.heart_failure].some(
      (o) => o.ten_year != null || o.thirty_year != null
    );

    if (hasAnyEstimate) {
      const provisional = assumptions.length > 0;
      preventStatus = provisional ? "computed_provisional" : "computed";
      prevent = {
        provisional,
        assumptions,
        confidence: provisional ? "provisional" : "high",
        estimates: {
          total_cvd: estimate.total_cvd,
          ascvd: estimate.ascvd,
          heart_failure: estimate.heart_failure,
        },
        vascular_age: estimate.vascular_age,
        horizons_note: "30-year estimates are validated only for ages 30–59.",
        frame:
          "Informational, not medical advice. A validated estimate from the AHA PREVENT (2023) equations; provisional inputs are assumed and shown above.",
      };
    } else {
      // Every required input is present but age falls outside PREVENT's
      // validated 30-79 range, so no horizon can be computed.
      missing_inputs.push("age within PREVENT's validated 30-79 range");
    }
  }

  const enhancers: RiskEnhancer[] = [];
  addEnhancer(enhancers, (markers.apob.value ?? 0) > 80, {
    key: "apob",
    label: "ApoB above optimal",
    finding: markerFinding(markers.apob),
    why: "ApoB is the atherogenic particle count and is the most direct modifiable lipid target.",
    lever: "Bring ApoB toward ~80 mg/dL or lower with clinician-guided lipid work plus diet/fiber support.",
  });
  addEnhancer(enhancers, (markers.lpa.value ?? 0) > 75, {
    key: "lpa",
    label: "Elevated Lp(a)",
    finding: markerFinding(markers.lpa),
    why: "Lp(a) is largely genetic; it raises lifetime risk floor and makes the modifiable ApoB/LDL target more aggressive.",
    lever: "Treat it as a reason to be stricter on ApoB/LDL rather than as a lifestyle target by itself.",
  });
  addEnhancer(enhancers, (markers.hs_crp.value ?? 0) > 1, {
    key: "hs_crp",
    label: "Residual inflammation",
    finding: markerFinding(markers.hs_crp),
    why: "Persistent hs-CRP above ~1 mg/L can add inflammatory risk, though a single value may be training or illness noise.",
    lever:
      "Recheck when recovered and pair lipid work with sleep, body-composition, and anti-inflammatory nutrition basics.",
  });
  addEnhancer(enhancers, bodyFat?.body_fat_pct != null && bodyFat.body_fat_pct > 25, {
    key: "body_fat",
    label: "Adiposity lever",
    finding: `Body fat ${bodyFat?.body_fat_pct}%${bodyFat?.date ? ` (${bodyFat.date})` : ""}`,
    why: "Body composition is a shared lever for blood pressure, inflammation, insulin sensitivity, and long-run cardiovascular risk.",
    lever: "Continue the lean-safe cut while preserving training performance and protein.",
  });
  addEnhancer(enhancers, markers.vo2max.value != null && markers.vo2max.value < 42, {
    key: "vo2max",
    label: "Cardiorespiratory fitness below target",
    finding: markerFinding(markers.vo2max),
    why: "Higher cardiorespiratory fitness is one of the strongest protective longevity signals.",
    lever: "Keep easy aerobic volume consistent and add one quality session when recovery supports it.",
  });
  addEnhancer(enhancers, hasFamilyHistory(profile), {
    key: "family_history",
    label: "Family history signal",
    finding: "Family cardiovascular history appears in profile notes",
    why: "Family history does not move directly, but it changes how aggressively the modifiable levers should be interpreted.",
    lever: "Use it to justify earlier clinician discussion and tighter ApoB/BP targets.",
  });

  const projections: RiskProjection[] = [
    {
      key: "apob",
      label: "ApoB particle reduction",
      current: markers.apob.value,
      target: 80,
      unit: markers.apob.unit ?? "mg/dL",
      expected_direction: "lower",
      why: "The main modifiable lipid lever; high Lp(a), when present, makes this target more important.",
    },
    {
      key: "hs_crp",
      label: "Inflammation confirmation",
      current: markers.hs_crp.value,
      target: 1,
      unit: markers.hs_crp.unit ?? "mg/L",
      expected_direction: "lower",
      why: "Persistent hs-CRP below ~1 is a cleaner background for interpreting lipid risk.",
    },
    {
      key: "body_fat",
      label: "Body-composition phase",
      current: bodyFat?.body_fat_pct ?? null,
      target: 20,
      unit: "%",
      expected_direction: "lower",
      why: "Fat loss is the shared lever across BP, inflammation, insulin sensitivity, and fitness.",
    },
    {
      key: "vo2max",
      label: "Aerobic capacity",
      current: markers.vo2max.value,
      target: 42,
      unit: markers.vo2max.unit ?? "mL/kg/min",
      expected_direction: "higher",
      why: "A higher VO2max improves the protective fitness side of the risk picture.",
    },
  ];

  const remainingAssumptions = prevent?.assumptions.map((a) => a.input).join(", ") ?? "";
  return {
    model_status: {
      prevent: preventStatus,
      ascvd_pce: "not_computed",
      reason:
        preventStatus === "insufficient_inputs"
          ? "Missing one of the required PREVENT inputs (age, sex, total cholesterol, HDL, systolic BP, eGFR, BMI), or age falls outside the equations' validated 30-79 range."
          : preventStatus === "computed_provisional"
            ? `AHA PREVENT (2023) base-model equations, computed from vendored coefficients. Still assumed: ${remainingAssumptions}.`
            : "AHA PREVENT (2023) base-model equations, computed from vendored coefficients using your captured status for every input.",
      next:
        preventStatus === "insufficient_inputs"
          ? "Add the missing labs/vitals above before a risk percentage can be computed."
          : preventStatus === "computed_provisional"
            ? `Capture ${remainingAssumptions} to remove today's provisional assumptions.`
            : "Nothing further needed for these inputs.",
    },
    inputs: {
      age,
      sex,
      bmi,
      body_fat_pct: bodyFat?.body_fat_pct ?? null,
      body_fat_source: bodyFat?.source ?? null,
      diabetes_by_a1c: diabetesByA1c,
      markers,
      missing_inputs,
    },
    prevent,
    enhancers,
    projections,
    frame:
      "Informational, not medical advice. The `prevent` block is the clinical risk read (AHA PREVENT 2023); these enhancers and projections name the cross-domain levers — ApoB, Lp(a), inflammation, body composition, fitness — that shape it beyond what the base equation captures.",
  };
}
