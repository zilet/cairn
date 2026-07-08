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
  // null/undefined/"" must read as absent, NOT 0 — `Number(null)` is 0, which
  // would (a) silently short-circuit the height_cm→BMI fallback when height_in
  // is null and (b) let a null age slip past the `age == null` missing-input
  // guard. Treat empties as null so "not on file" stays "not on file".
  if (v == null || v === "") return null;
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

// Lp(a) is reported in two units that DON'T convert cleanly (particle count vs
// mass), so "elevated" is a different number in each: ≈75 nmol/L vs ≈30 mg/dL.
// A single >75 threshold silently misses every mg/dL lab (an elevated 30–50
// mg/dL reads <75 and never flags). Branch on the unit, case-insensitively;
// an unknown/blank unit keeps the historical nmol/L threshold.
function lpaElevated(marker: RiskMarker): boolean {
  if (marker.value == null) return false;
  const unit = String(marker.unit ?? "").toLowerCase();
  const threshold = unit.includes("mg") ? 30 : 75;
  return marker.value > threshold;
}

type RiskCategory = "low" | "borderline" | "intermediate" | "high";

// ACC/AHA 10-year ASCVD risk bands (a clinical category, NOT a 0-100 wellness
// grade): <5% low · 5-<7.5% borderline · 7.5-<20% intermediate · ≥20% high.
function ascvdCategory(tenYear: number | null): RiskCategory | null {
  if (tenYear == null || !Number.isFinite(tenYear)) return null;
  const pct = tenYear * 100;
  if (pct < 5) return "low";
  if (pct < 7.5) return "borderline";
  if (pct < 20) return "intermediate";
  return "high";
}

const CATEGORY_ARTICLE: Record<RiskCategory, string> = {
  low: "a low",
  borderline: "a borderline",
  intermediate: "an intermediate",
  high: "a high",
};

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function nIn100Phrase(fraction: number): string {
  const n = Math.round(fraction * 100);
  return n <= 0 ? "Fewer than 1 in 100 people with your profile" : `About ${n} in 100 people with your profile`;
}

// Compose a plain-language, whole-picture interpretation of the clinical risk.
// The category + "N in 100" are anchored to the 10-year ASCVD estimate (the
// atherosclerotic event — heart attack/stroke — the ACC/AHA bands describe).
// For a YOUNG athlete with a low 10-year read but a meaningful 30-year outlook
// and elevated enhancers (ApoB / Lp(a) / hs-CRP), it names where the lever
// actually is instead of letting the reassuring 10-year number stand alone.
function composePreventInterpretation(args: {
  ascvdTen: number | null;
  totalThirty: number | null;
  age: number | null;
  category: RiskCategory | null;
  apob: number | null;
  lpaElevated: boolean;
  hsCrp: number | null;
}): string {
  const { ascvdTen, totalThirty, age, category } = args;
  if (ascvdTen == null || category == null) return "";

  const lead = `${nIn100Phrase(ascvdTen)} would be expected to have a heart attack or stroke in the next 10 years — ${CATEGORY_ARTICLE[category]} 10-year risk.`;

  const levers: string[] = [];
  if (args.apob != null && args.apob > 80) levers.push("ApoB");
  if (args.lpaElevated) levers.push("Lp(a)");
  if (args.hsCrp != null && args.hsCrp > 1) levers.push("hs-CRP");

  const thirtyPct = totalThirty != null ? Math.round(totalThirty * 100) : null;
  const thirtyMeaningful = thirtyPct != null && thirtyPct >= 10;
  const young = age != null && age < 55;

  if ((category === "low" || category === "borderline") && young && (thirtyMeaningful || levers.length > 0)) {
    const thirtyClause = thirtyMeaningful ? `your 30-year outlook (~${thirtyPct}%)` : "your long-run risk";
    const both = levers.length ? `${thirtyClause} and your elevated ${joinList(levers)}` : thirtyClause;
    const verb = levers.length > 0 || thirtyMeaningful ? "are" : "is";
    // "your 30-year outlook ... and your elevated ApoB, Lp(a) and hs-CRP" reads
    // plural even with a single lever named, so `are` is correct once the "and"
    // clause is present; a bare long-run clause with no lever uses `is`.
    const conj = levers.length ? "are" : verb;
    return `${lead} But ${both} ${conj} where the lever is — acting now, while you're young, pays off most.`;
  }

  if (category === "intermediate" || category === "high") {
    const leverClause = levers.length
      ? ` Your elevated ${joinList(levers)} ${levers.length === 1 ? "is" : "are"} the most actionable lever${levers.length === 1 ? "" : "s"} to discuss with a clinician.`
      : "";
    return `${lead}${leverClause}`;
  }

  // Low/borderline but not young (or no long-game story to tell).
  if (levers.length) {
    return `${lead} Your elevated ${joinList(levers)} ${levers.length === 1 ? "is" : "are"} still worth acting on to protect the long run.`;
  }
  return lead;
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
    triglycerides: markerByZone("Triglycerides"),
    apob: markerByZone("ApoB"),
    lpa: markerByZone("Lp(a)"),
    hs_crp: markerByZone("hs-CRP"),
    hba1c: markerByZone("HbA1c"),
    egfr: markerByZone("eGFR"),
    systolic_bp: markerByZone("Systolic BP"),
    vo2max: markerByZone("VO2max"),
  };

  // Total cholesterol is a required PREVENT input. When it isn't on file directly
  // but LDL + HDL + triglycerides are, derive it via the Friedewald-consistent
  // sum (TC = LDL + HDL + TG/5, mg/dL) rather than failing the whole read. Only
  // valid when TG < 400 mg/dL (Friedewald breaks down above that). The derivation
  // is surfaced as a PREVENT assumption below so the read stays honest.
  let tcDerived = false;
  if (
    markers.total_cholesterol.value == null &&
    markers.ldl_c.value != null &&
    markers.hdl_c.value != null &&
    markers.triglycerides.value != null &&
    markers.triglycerides.value < 400
  ) {
    markers.total_cholesterol = {
      label: "Total cholesterol",
      value: round1(markers.ldl_c.value + markers.hdl_c.value + markers.triglycerides.value / 5),
      unit: "mg/dL",
      date: markers.ldl_c.date ?? markers.hdl_c.date ?? markers.triglycerides.date ?? null,
    };
    tcDerived = true;
  }

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
    category: RiskCategory | null;
    interpretation: string;
    estimates: {
      total_cvd: { ten_year: number | null; thirty_year: number | null };
      ascvd: { ten_year: number | null; thirty_year: number | null };
      heart_failure: { ten_year: number | null; thirty_year: number | null };
    };
    vascular_age: number | null;
    projection: {
      current: { ten_year: number | null; thirty_year: number | null; vascular_age: number | null };
      targets_met: { ten_year: number | null; thirty_year: number | null; vascular_age: number | null };
      levers_applied: Array<{ key: string; label: string; from: number; to: number; unit: string; detail: string }>;
    } | null;
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
    if (tcDerived) {
      assumptions.push({
        input: "total cholesterol",
        assumed: `derived (${markers.total_cholesterol.value} mg/dL)`,
        reason:
          "No direct total cholesterol on file; PREVENT uses the Friedewald-consistent sum of LDL + HDL + triglycerides/5 (valid while triglycerides are under 400 mg/dL). Add a direct total cholesterol to remove this estimate.",
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

      // ---- REAL counterfactual: recompute PREVENT with the modifiable levers at
      // target. NOT invented geometry — a genuine second pass through the same
      // vendored equations. Only inputs PREVENT actually reads move: total
      // cholesterol / non-HDL (the lipid lever), BMI (the body-composition lever),
      // and smoking. ApoB/Lp(a)/hs-CRP are NOT PREVENT inputs, so they never move
      // the number directly — instead the ApoB optimal target MOTIVATES the lipid
      // lever (ApoB and non-HDL reflect the same atherogenic particle burden and
      // fall together). Lp(a) is genetic and never moves.
      const targetInputs: PreventInputs = { ...preventInputs };
      const leversApplied: Array<{
        key: string;
        label: string;
        from: number;
        to: number;
        unit: string;
        detail: string;
      }> = [];

      const curHdl = preventInputs.hdl;
      const curNonHdl = preventInputs.total_chol - curHdl;
      const apob = markers.apob.value;
      const NON_HDL_OPTIMAL_MAX = 130; // OPTIMAL_ZONES Non-HDL-C ceiling
      let targetNonHdl = curNonHdl;
      if (apob != null && apob > 80 && curNonHdl > 0) {
        // Lowering ApoB toward its ~80 mg/dL optimal scales non-HDL down with it.
        targetNonHdl = Math.min(targetNonHdl, curNonHdl * (80 / apob));
      }
      if (curNonHdl > NON_HDL_OPTIMAL_MAX) {
        targetNonHdl = Math.min(targetNonHdl, NON_HDL_OPTIMAL_MAX);
      }
      if (curNonHdl > 0 && targetNonHdl < curNonHdl - 0.5) {
        targetInputs.total_chol = round1(curHdl + targetNonHdl);
        leversApplied.push({
          key: "lipids",
          label: "Lipid-lowering to target",
          from: round1(curNonHdl),
          to: round1(targetNonHdl),
          unit: "mg/dL non-HDL",
          detail:
            apob != null && apob > 80
              ? `Bringing ApoB toward ~80 mg/dL lowers non-HDL cholesterol with it, from ${round1(curNonHdl)} to ${round1(targetNonHdl)} mg/dL.`
              : `Bringing non-HDL cholesterol into the optimal range (≤${NON_HDL_OPTIMAL_MAX} mg/dL), from ${round1(curNonHdl)} to ${round1(targetNonHdl)} mg/dL.`,
        });
      }

      // Body-composition lever — PREVENT only sees body fat through BMI, so an
      // above-range BMI is pulled toward the top of the healthy band. A normal
      // BMI has no PREVENT lever to pull (truthfully), even if body fat is high.
      const BMI_OPTIMAL_MAX = 24.9;
      if (preventInputs.bmi > 25) {
        targetInputs.bmi = BMI_OPTIMAL_MAX;
        leversApplied.push({
          key: "body_fat",
          label: "Body composition to healthy BMI",
          from: round1(preventInputs.bmi),
          to: BMI_OPTIMAL_MAX,
          unit: "kg/m²",
          detail: `Moving BMI into the healthy range (${round1(preventInputs.bmi)} → ${BMI_OPTIMAL_MAX} kg/m²).`,
        });
      }

      // Smoking lever — only present if the athlete is actually a smoker.
      if (preventInputs.smoker) {
        targetInputs.smoker = false;
        leversApplied.push({
          key: "smoking",
          label: "Quit smoking",
          from: 1,
          to: 0,
          unit: "",
          detail: "Removing smoking as a risk factor.",
        });
      }

      const targetsMetEstimate = leversApplied.length ? estimatePreventRisk(targetInputs) : estimate;
      const projection = {
        current: {
          ten_year: estimate.total_cvd.ten_year,
          thirty_year: estimate.total_cvd.thirty_year,
          vascular_age: estimate.vascular_age,
        },
        targets_met: {
          ten_year: targetsMetEstimate.total_cvd.ten_year,
          thirty_year: targetsMetEstimate.total_cvd.thirty_year,
          vascular_age: targetsMetEstimate.vascular_age,
        },
        levers_applied: leversApplied,
      };

      const category = ascvdCategory(estimate.ascvd.ten_year);
      const interpretation = composePreventInterpretation({
        ascvdTen: estimate.ascvd.ten_year,
        totalThirty: estimate.total_cvd.thirty_year,
        age,
        category,
        apob: markers.apob.value,
        lpaElevated: lpaElevated(markers.lpa),
        hsCrp: markers.hs_crp.value,
      });

      prevent = {
        provisional,
        assumptions,
        confidence: provisional ? "provisional" : "high",
        category,
        interpretation,
        estimates: {
          total_cvd: estimate.total_cvd,
          ascvd: estimate.ascvd,
          heart_failure: estimate.heart_failure,
        },
        vascular_age: estimate.vascular_age,
        projection,
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
  addEnhancer(enhancers, lpaElevated(markers.lpa), {
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
