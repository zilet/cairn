import { getMarkerHistory } from "./health.js";
import { matchOptimalZone } from "./propagation-data.js";
import { currentBodyFatEstimate, getProfile } from "./profile.js";

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
    try { return getMarkerHistory().markers as any[]; } catch { return []; }
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
  return /family history|father|mother|parent|brother|sister/.test(text) && /heart|cardiac|stroke|attack|cvd|cholesterol/.test(text);
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
    try { return getProfile() as any; } catch { return null; }
  })();
  const age = asNumber(profile?.age);
  const sex = profile?.sex ? String(profile.sex).toLowerCase() : null;
  const weightLb = asNumber(profile?.weight_lb);
  const heightIn = asNumber(profile?.height_in) ?? (asNumber(profile?.height_cm) != null ? asNumber(profile.height_cm)! / 2.54 : null);
  const bmi = weightLb != null && heightIn != null && heightIn > 0
    ? round1((weightLb / (heightIn * heightIn)) * 703)
    : null;
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

  const missing_inputs: string[] = [];
  if (age == null) missing_inputs.push("age");
  if (!sex) missing_inputs.push("sex");
  if (markers.total_cholesterol.value == null) missing_inputs.push("total cholesterol");
  if (markers.hdl_c.value == null) missing_inputs.push("HDL-C");
  if (markers.systolic_bp.value == null) missing_inputs.push("systolic blood pressure");
  if (markers.egfr.value == null) missing_inputs.push("eGFR");
  if (bmi == null) missing_inputs.push("height/weight for BMI");
  missing_inputs.push("smoking status");
  missing_inputs.push("blood-pressure treatment status");
  missing_inputs.push("statin treatment status");

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
    lever: "Recheck when recovered and pair lipid work with sleep, body-composition, and anti-inflammatory nutrition basics.",
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

  return {
    model_status: {
      prevent: "coefficients_unavailable",
      ascvd_pce: "not_computed",
      reason: "Exact PREVENT/PCE coefficients are not vendored in this repo, so Cairn does not invent a clinical risk percentage.",
      next: "Add a sourced coefficient table before emitting 10-year, 30-year, or vascular-age numbers.",
    },
    inputs: {
      age,
      sex,
      bmi,
      body_fat_pct: bodyFat?.body_fat_pct ?? null,
      body_fat_source: bodyFat?.source ?? null,
      diabetes_by_a1c: markers.hba1c.value != null ? markers.hba1c.value >= 6.5 : null,
      markers,
      missing_inputs,
    },
    enhancers,
    projections,
    frame: "Informational, not medical advice. This names the levers that would feed a clinical risk equation once sourced coefficients and missing inputs are available.",
  };
}
