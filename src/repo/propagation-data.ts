// ============================================================================
// CONNECTED-BRAIN DATA TABLES — the pure, DB-free evidence tables + matchers.
// Marker optimal zones, the marker→directive mapping table, and the clinical
// marker-group taxonomy, plus the pure functions that only read them. NO DB
// access lives here (kept offline-testable); the engine that consumes these
// tables lives in ./propagation.js, which re-exports everything below.
// ============================================================================

// A meaningful, clinical grouping for blood/health markers, so a long panel reads
// as a handful of health stories rather than an alphabet soup. Matching mirrors
// matchOptimalZone: lowercased substring against the marker name, LONGEST-MATCH-WINS
// (so "non-hdl" beats "hdl"; on the rare exact-length tie the earlier-listed group
// wins). The key sets are disjoint enough that a real analyte resolves to one group
// regardless of array order, so the array ORDER is effectively just the sequence the
// panels are DISPLAYED in.
//
// That display sequence is the CONVENTIONAL CLINICAL LAB-REVIEW ORDER a physician
// expects to scan, NOT a longevity-impact ranking: CBC (red line + iron studies,
// then white cells/platelets) → CMP (metabolic/glucose, electrolytes, kidney,
// liver) → lipids → inflammation → endocrine (thyroid, hormones) → vitamins →
// the less-common specialty panels (cardiac, autoimmune, cancer screening, heavy
// metals) → urinalysis → the non-blood functional reads (vitals, fitness/metabolic
// rate, body composition) → the "other" catch-all (empty keys, claims only what
// nothing else does — always LAST). Doctors are bad at finding a value that sits
// where they don't expect it, so both the doctor export (report.ts) and the
// internal Markers catalog render panels in THIS order. The motivational
// impact/priority ranking is a SEPARATE concern — it lives in prioritizeMarkers's
// per-marker sort and healthFocus(), and is unaffected by this group sequence.
interface MarkerGroup { key: string; label: string; keys: string[]; }
const MARKER_GROUPS: MarkerGroup[] = [
  { key: "iron", label: "Iron & Red Blood", keys: ["ferritin", "transferrin", "tibc", "iron", "hemoglobin", "hgb", "hematocrit", "hct", "rbc", "red blood cell", "red cell distribution", "mcv", "mch", "rdw", "abo group", "rhesus", "rh factor", "blood type"] },
  { key: "blood", label: "White Cells & Platelets", keys: ["wbc", "white blood", "platelet", "neutrophil", "absolute neut", "lymphocyte", "absolute lymph", "monocyte", "absolute mono", "eosinophil", "absolute eos", "basophil", "absolute baso", "granulocyte", "immature gran", "imm gran"] },
  { key: "metabolic", label: "Metabolic & Glucose", keys: ["hemoglobin a1c", "hb a1c", "hba1c", "a1c", "glucose", "insulin", "homa", "c-peptide", "fructosamine"] },
  { key: "electrolytes", label: "Electrolytes", keys: ["sodium", "potassium", "chloride", "carbon dioxide", "bicarbonate", "anion gap"] },
  { key: "kidney", label: "Kidney", keys: ["albumin, random urine", "albumin random urine", "microalbumin", "urine albumin", "albumin/creatinine", "albumin creatinine", "egfr", "creatinine", "bun", "urea", "uric acid", "cystatin"] },
  { key: "liver", label: "Liver & Pancreas", keys: ["alt", "sgpt", "ast", "sgot", "ggt", "alp", "alkaline phosphatase", "bilirubin", "albumin", "total protein", "globulin", "amylase", "lipase"] },
  { key: "lipids", label: "Lipids & Cardiovascular", keys: ["apob", "apolipoprotein", "apo b", "non-hdl", "non hdl", "ldl", "hdl", "cholesterol", "triglyceride", "lp(a)", "lipoprotein"] },
  { key: "inflammation", label: "Inflammation", keys: ["crp", "c-reactive", "c reactive", "homocysteine", "esr", "sed rate", "fibrinogen"] },
  { key: "thyroid", label: "Thyroid", keys: ["tsh", "free t3", "free t4", "thyroxine", "triiodo", "thyroid", "thyroglobulin", "thyroid peroxidase", "tpo antibod", "thyroid antibod", "thyroxine binding globulin"] },
  { key: "hormones", label: "Hormones", keys: ["testosterone", "estradiol", "estrogen", "cortisol", "dhea", "shbg", "sex hormone binding globulin", "progesterone", "prolactin", "igf", "lh", "fsh", "leptin"] },
  { key: "vitamins", label: "Vitamins & Minerals", keys: ["vitamin d", "25-oh", "25 hydroxy", "25(oh)", "b12", "cobalamin", "folate", "vitamin b", "methylmalonic", "magnesium", "zinc", "calcium", "selenium", "copper", "omega", "arachidonic"] },
  { key: "cardiac", label: "Cardiac", keys: ["troponin", "nt-probnp", "nt probnp", "pro-bnp", "probnp", "bnp"] },
  { key: "autoimmune", label: "Autoimmune & Antibodies", keys: ["antinuclear", "ana screen", "rheumatoid", "anti-ccp", "ccp antibod", "anti-dsdna", "dsdna"] },
  { key: "screening", label: "Cancer Screening", keys: ["prostate specific antigen", "psa", "cea", "alpha-fetoprotein", "ca-125", "ca 125", "ca 19-9", "ca19-9"] },
  { key: "metals", label: "Heavy Metals", keys: ["lead", "mercury", "arsenic", "cadmium", "aluminum", "aluminium"] },
  { key: "urinalysis", label: "Urinalysis", keys: ["urinalysis", "urine", "specific gravity", "leukocyte esterase", "urobilinogen", "epithelial cells", "hyaline cast", "urine cast"] },
  { key: "vitals", label: "Blood Pressure & Vitals", keys: ["systolic", "diastolic", "blood pressure", "resting heart", "resting hr", "heart rate", "pulse", "respiratory rate", "respiration", "oxygen saturation", "spo2", "o2 sat", "temperature", "body temp"] },
  { key: "fitness", label: "Fitness & Metabolic Rate", keys: ["vo2max", "vo2 max", "vo₂max", "resting metabolic rate", "predicted rmr", "rmr", "respiratory exchange", "fat utilization", "carbohydrate utilization", "fuel utilization", "metabolic age", "fitness age", "hrv", "heart rate variability"] },
  { key: "body", label: "Body Composition", keys: ["body fat", "fat mass", "fat-free mass", "fat free mass", "lean mass", "appendicular", "almi", "ffmi", "android/gynoid", "android gynoid", "gynoid", "bone density", "bone mineral content", "bmd", "t-score", "z-score", "visceral", "total mass", "bmi"] },
  { key: "other", label: "Other Markers", keys: [] },
];
const OTHER_GROUP: MarkerGroup = MARKER_GROUPS[MARKER_GROUPS.length - 1];

// Some "markers" extracted from uploaded documents aren't clinical lab analytes
// at all — an eyeglass prescription (sphere/cylinder/lens type) ingested from an
// eye-exam doc is the canonical example. They carry no optimal zone, generate no
// directive, and only clutter the marker list, so they're dropped at read time
// (non-destructively — the source doc + its parsed_json are left intact). Matched
// like markerGroup: lowercased substring against the marker name.
const NON_CLINICAL_MARKER_KEYS = ["sphere", "cylinder", "lens type", "pupillary distance", "visual acuity"];
export function isNonClinicalMarker(name: string): boolean {
  const n = String(name ?? "").toLowerCase();
  return NON_CLINICAL_MARKER_KEYS.some((k) => n.includes(k));
}

// Best group for a marker name — longest-match-wins over substrings (so
// "non-hdl" outranks "hdl", "alkaline phosphatase" outranks "alp"). Falls back
// to the "other" group when nothing matches.
export function markerGroup(name: string): { key: string; label: string } {
  const n = String(name ?? "").toLowerCase();
  // A "<analyte> - Urine" name is a urinalysis dipstick/microscopy component
  // (urine glucose / bilirubin / RBC / WBC), NOT the serum analyte — but the
  // serum key ("glucose", "bilirubin", "red blood cell") is longer than "urine"
  // and would win the substring race. The dash-suffix is the definitive signal:
  // quantitative urine labs read "Random Urine" / "24-Hour Urine" (no dash), so
  // this only claims the dipstick panel. Checked before longest-match-wins.
  if (/[-–]\s*urine\b/.test(n)) return { key: "urinalysis", label: "Urinalysis" };
  let best: MarkerGroup | null = null;
  let bestLen = 0;
  for (const g of MARKER_GROUPS) {
    for (const k of g.keys) {
      if (k && n.includes(k) && k.length > bestLen) { best = g; bestLen = k.length; }
    }
  }
  const g = best ?? OTHER_GROUP;
  return { key: g.key, label: g.label };
}

// Canonical-ordered list of {key,label} for the groups actually present in a
// set of enriched markers (each carrying a .group key). Shared by
// getMarkerHistory and prioritizeMarkers so both surface the same taxonomy.
export function presentGroups(markers: { group?: string }[]): { key: string; label: string }[] {
  const present = new Set(markers.map((m) => m.group).filter(Boolean) as string[]);
  return MARKER_GROUPS.filter((g) => present.has(g.key)).map((g) => ({ key: g.key, label: g.label }));
}

// A marker's clinical normal range often hides what matters: a value can sit
// "in range" yet far from where the longevity literature wants it (LDL/ApoB
// "normal" but well above optimal). OPTIMAL_ZONES are evidence-anchored target
// bands (longevity / preventive-cardiology framing — AHA/ACC, Endocrine
// Society, ADA), distinct from the lab's population reference interval. `dir`
// says which way is worse: 'high' = higher is worse (LDL), 'low' = lower is
// worse (vitamin D), 'band' = either side of the band is worse. Everything is
// INFORMATIONAL, not medical advice.
export interface OptimalZone {
  keys: string[];            // normalized marker-name matches (substring, lowercased)
  unit?: string;             // expected unit hint (informational; not enforced)
  optimal: [number, number]; // the optimal band
  dir: "high" | "low" | "band";
  actionable: boolean;       // we have a well-established lever (drives the score + derivation)
  label: string;             // canonical display label / marker key
}

export const OPTIMAL_ZONES: OptimalZone[] = [
  { keys: ["apob", "apolipoprotein b", "apo b"], unit: "mg/dL", optimal: [40, 80], dir: "high", actionable: true, label: "ApoB" },
  { keys: ["ldl"], unit: "mg/dL", optimal: [40, 100], dir: "high", actionable: true, label: "LDL-C" },
  { keys: ["non-hdl", "non hdl"], unit: "mg/dL", optimal: [50, 130], dir: "high", actionable: true, label: "Non-HDL-C" },
  { keys: ["triglyceride"], unit: "mg/dL", optimal: [40, 100], dir: "high", actionable: true, label: "Triglycerides" },
  { keys: ["hdl"], unit: "mg/dL", optimal: [50, 90], dir: "low", actionable: true, label: "HDL-C" },
  { keys: ["total cholesterol"], unit: "mg/dL", optimal: [125, 200], dir: "high", actionable: true, label: "Total cholesterol" },
  { keys: ["omega-3 index", "omega 3 index", "omegacheck"], unit: "%", optimal: [8, 12], dir: "low", actionable: true, label: "Omega-3 index" },
  { keys: ["hs-crp", "hscrp", "c-reactive", "c reactive", "crp"], unit: "mg/L", optimal: [0, 1], dir: "high", actionable: true, label: "hs-CRP" },
  { keys: ["homocysteine"], unit: "umol/L", optimal: [4, 9], dir: "high", actionable: true, label: "Homocysteine" },
  { keys: ["hba1c", "a1c", "hemoglobin a1c"], unit: "%", optimal: [4.5, 5.4], dir: "high", actionable: true, label: "HbA1c" },
  { keys: ["fasting glucose", "glucose"], unit: "mg/dL", optimal: [70, 90], dir: "band", actionable: true, label: "Fasting glucose" },
  { keys: ["fasting insulin", "insulin"], unit: "uIU/mL", optimal: [2, 6], dir: "high", actionable: true, label: "Fasting insulin" },
  { keys: ["ferritin"], unit: "ng/mL", optimal: [50, 150], dir: "band", actionable: true, label: "Ferritin" },
  { keys: ["vitamin d", "25-oh", "25 hydroxy", "25(oh)d", "25-hydroxy"], unit: "ng/mL", optimal: [40, 60], dir: "low", actionable: true, label: "Vitamin D" },
  // eGFR: keyed on the full analyte phrase so the common lab name
  // "Creatinine-Based Estimated Glomerular Filtration Rate" matches HERE (longest key
  // wins) instead of being mis-routed to the serum Creatinine band by its "creatinine" token.
  { keys: ["egfr", "glomerular filtration", "estimated gfr", "gfr"], unit: "mL/min", optimal: [90, 130], dir: "low", actionable: true, label: "eGFR" },
  { keys: ["creatinine"], unit: "mg/dL", optimal: [0.7, 1.1], dir: "band", actionable: false, label: "Creatinine" },
  { keys: ["alt", "sgpt"], unit: "U/L", optimal: [0, 30], dir: "high", actionable: true, label: "ALT" },
  { keys: ["ast", "sgot"], unit: "U/L", optimal: [0, 30], dir: "high", actionable: true, label: "AST" },
  { keys: ["ggt"], unit: "U/L", optimal: [0, 30], dir: "high", actionable: true, label: "GGT" },
  { keys: ["tsh"], unit: "uIU/mL", optimal: [0.5, 2.5], dir: "band", actionable: false, label: "TSH" },
  { keys: ["free t3", "free triiodothyronine", "ft3"], unit: "pg/mL", optimal: [3.0, 4.2], dir: "band", actionable: false, label: "Free T3" },
  { keys: ["free t4", "free thyroxine", "ft4"], unit: "ng/dL", optimal: [1.0, 1.5], dir: "band", actionable: false, label: "Free T4" },
  { keys: ["vitamin b12", "b12", "cobalamin"], unit: "pg/mL", optimal: [400, 900], dir: "low", actionable: true, label: "Vitamin B12" },
  { keys: ["folate", "folic acid"], unit: "ng/mL", optimal: [5, 20], dir: "low", actionable: true, label: "Folate" },
  { keys: ["magnesium, rbc", "rbc magnesium", "magnesium"], unit: "mg/dL", optimal: [2.0, 2.6], dir: "low", actionable: true, label: "Magnesium" },
  { keys: ["total testosterone", "testosterone, total", "testosterone"], unit: "ng/dL", optimal: [500, 900], dir: "low", actionable: true, label: "Testosterone" },
  { keys: ["estradiol", "e2"], unit: "pg/mL", optimal: [10, 40], dir: "band", actionable: false, label: "Estradiol" },
  { keys: ["lp(a)", "lipoprotein(a)", "lipoprotein (a)"], unit: "nmol/L", optimal: [0, 75], dir: "high", actionable: false, label: "Lp(a)" },
  { keys: ["uric acid"], unit: "mg/dL", optimal: [3, 6], dir: "high", actionable: true, label: "Uric acid" },
  // Body composition — a broad population "elevated body fat" band (NOT sex-specific; the
  // Standing tab carries the precise sex/age percentile read). Keyed to the TOTAL body-fat
  // marker only, so the regional DEXA rows ("Body Fat - Trunk") don't each fire a directive.
  { keys: ["body fat %", "body fat percent", "percent body fat", "total body fat"], unit: "%", optimal: [10, 25], dir: "high", actionable: true, label: "Body fat" },
  { keys: ["mercury"], unit: "ug/L", optimal: [0, 10], dir: "high", actionable: true, label: "Mercury" },
  { keys: ["rheumatoid factor"], unit: "IU/mL", optimal: [0, 14], dir: "high", actionable: false, label: "Rheumatoid factor" },
  { keys: ["systolic", "blood pressure", "bp systolic"], unit: "mmHg", optimal: [105, 120], dir: "high", actionable: true, label: "Systolic BP" },
  { keys: ["diastolic", "bp diastolic"], unit: "mmHg", optimal: [60, 80], dir: "high", actionable: true, label: "Diastolic BP" },
  // Endurance / cardiorespiratory fitness markers (v35). These come from wearables
  // (injected into prioritizeMarkers from the recovery summary) but also match a lab
  // VO2max test. Optimal-ZONE framing only — higher VO2max is better, lower resting
  // HR is better, higher HRV is better — NEVER a 0-100 score. The bands are broad,
  // population-level orienting ranges (an athletic adult), not a personal verdict.
  { keys: ["vo2max", "vo2 max", "vo₂max"], unit: "mL/kg/min", optimal: [42, 60], dir: "low", actionable: true, label: "VO2max" },
  { keys: ["resting heart rate", "resting hr", "rhr"], unit: "bpm", optimal: [40, 60], dir: "high", actionable: true, label: "Resting HR" },
  { keys: ["hrv", "heart rate variability", "rmssd"], unit: "ms", optimal: [50, 120], dir: "low", actionable: true, label: "HRV" },
];

// A random / post-prandial / non-fasting glucose must NOT be held to the FASTING
// glucose optimal band (70–90 mg/dL) — that band only applies to a fasting draw,
// so a perfectly normal post-meal 130 would read "out of optimal" against a
// target it was never measured against (and on a doctor-facing report that's a
// visible error). This mirrors report.ts's `optimalTrustworthy` name-based
// suppression. Deliberately narrow: only the "glucose" key (the bare Fasting
// glucose zone) is suppressed, and ONLY for an explicitly non-fasting context —
// HbA1c, fasting glucose, and eAG / estimated-average-glucose are untouched.
// Word-bounded so "pp" never matches inside another word (e.g. "supplement").
const NON_FASTING_GLUCOSE = /\b(random|non[-\s]?fasting|post[-\s]?prandial|pp|2\s?-?\s?hr|2\s?-?\s?hour)\b/;
function suppressFastingGlucoseZone(name: string, z: OptimalZone | null): boolean {
  if (!z || z.label !== "Fasting glucose") return false;
  const n = String(name ?? "").toLowerCase();
  if (!n.includes("glucose")) return false;          // only the bare-glucose match
  if (n.includes("fasting") && !n.includes("non")) return false; // genuinely fasting
  if (n.includes("estimated average") || n.includes("eag")) return false; // eAG kept
  return NON_FASTING_GLUCOSE.test(n);
}

// Specimen/analyte-type guard — mirrors report.ts's `optimalTrustworthy`, but ported
// into the brain's chokepoint so a serum concentration band is NEVER claimed by a name
// that isn't that serum analyte. Without it, naive substring matching emits clinically
// BACKWARDS directives on real data: "Total Cholesterol / HDL Ratio" (5.2) matches the
// HDL-C band → "raise your low HDL" (a high ratio is high risk, not low HDL); "Albumin,
// Random Urine without Creatinine" (0.2) matches the serum Creatinine band → a spurious
// "low creatinine"; "Testosterone, Free" matches the total-T band → a false "low
// testosterone". Suppresses ratios, qualitative patterns, urine specimens, free-T, and
// advanced lipoprotein subfractions (particle count/size — different units than the band).
function zoneNameTrustworthy(name: string): boolean {
  const n = String(name ?? "").toLowerCase();
  if (/\bratio\b|\bpattern\b|\burine\b/.test(n)) return false;
  if (n.includes("/")) return false;                                  // composite "x / y" names
  if (n.includes("free") && n.includes("testosterone")) return false; // no free-T optimal band
  if (/\b(ldl|hdl)\b/.test(n) && /\b(particle|small|medium|large|peak|number|size)\b/.test(n)) return false;
  return true;
}

export function matchOptimalZone(name: string): OptimalZone | null {
  const n = String(name ?? "").toLowerCase();
  // A ratio / urine / pattern / free-T / lipoprotein-subfraction name must not be held
  // to a serum concentration band it was never measured against (the clinically-wrong
  // directive guard). Checked first so nothing downstream sees a mis-routed zone.
  if (!zoneNameTrustworthy(n)) return null;
  // Prefer the most specific (longest key) match so "non-hdl" doesn't read as "hdl".
  let best: OptimalZone | null = null;
  let bestLen = 0;
  for (const z of OPTIMAL_ZONES) {
    for (const k of z.keys) {
      if (n.includes(k) && k.length > bestLen) { best = z; bestLen = k.length; }
    }
  }
  // A non-fasting glucose substring-matched the FASTING band — don't hold it to a
  // fasting target it shouldn't be judged against (protects the physician report).
  if (suppressFastingGlucoseZone(n, best)) return null;
  return best;
}

// Distance from the optimal band, normalized 0..1 by the band's own width
// (capped). 0 = inside optimal; grows as the value drifts the "worse" way.
export function optimalDistance(value: number, z: OptimalZone): number {
  const [lo, hi] = z.optimal;
  const width = Math.max(hi - lo, 1);
  let over = 0;
  if (z.dir === "high") over = value - hi;             // only the high side is "worse"
  else if (z.dir === "low") over = lo - value;         // only the low side is "worse"
  else over = Math.max(lo - value, value - hi);        // either side
  if (over <= 0) return 0;
  return Math.min(over / width, 3) / 3;                 // 0..1 (clamped at 3 band-widths out)
}

// A single mapping from a flagged/sub-optimal marker to the domains it touches.
// `when(value, flag)` decides whether this marker currently warrants directives;
// `derive` returns the per-domain rows. citation is filled where the lever is a
// well-established guideline; left null (with uncertain:true) where the mapping
// is real but not settled, so the user/coach sees it flagged research-recommended.
export interface MappingDirective { key?: string; domain: "nutrition" | "training" | "watch"; directive: string; rationale: string; citation?: string | null; uncertain?: boolean; }
export interface MarkerContext { value: number; flag: string | null; zone: OptimalZone; side: "low" | "high" | "unknown"; marker: any; }
export interface MarkerMapping {
  zone: string;            // OPTIMAL_ZONES label this keys off
  derive: (ctx: MarkerContext) => MappingDirective[];
}

export function markerSide(value: number, zone: OptimalZone, flag: string | null): MarkerContext["side"] {
  if (flag === "low" || flag === "high") return flag;
  if (!Number.isFinite(value)) return "unknown";
  if (value < zone.optimal[0]) return "low";
  if (value > zone.optimal[1]) return "high";
  return "unknown";
}

// ---------- marker → cross-domain directive mapping table (T4 static data) ----------
export const MARKER_MAPPINGS: MarkerMapping[] = [
  { zone: "ApoB", derive: () => [
    { domain: "nutrition", directive: "Lower saturated fat (swap toward olive oil, nuts, oily fish) and add ~10g/day soluble fiber (oats, legumes, psyllium) to bring ApoB toward optimal.", rationale: "ApoB counts atherogenic particles; lowering it is the most direct dietary lever for cardiovascular risk.", citation: "AHA/ACC 2018 Cholesterol Guideline; ESC/EAS 2019 Dyslipidaemia" },
    { domain: "watch", directive: "Recheck ApoB (and a full lipid panel) in ~12 weeks after dietary changes; discuss with your doctor if it stays elevated.", rationale: "ApoB is the preferred residual-risk marker; a 12-week retest captures dietary response.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
  ] },
  { zone: "LDL-C", derive: () => [
    { domain: "nutrition", directive: "Reduce saturated fat and add soluble fiber + plant sterols to nudge LDL-C toward optimal; favor unsaturated fats.", rationale: "Dietary saturated-fat reduction is a first-line, evidence-backed LDL lever.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
    { domain: "watch", directive: "Retest lipids in ~12 weeks; if LDL-C remains high despite diet, raise it with your doctor.", rationale: "Elevated LDL-C is a well-established atherosclerosis driver worth tracking and discussing clinically.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
  ] },
  { zone: "Non-HDL-C", derive: () => [
    { domain: "nutrition", directive: "Cut saturated fat and refined carbs and raise fiber — non-HDL captures all atherogenic cholesterol, so the lipid-lowering diet applies.", rationale: "Non-HDL-C sums LDL + other atherogenic particles; the same dietary levers move it.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
    { domain: "watch", directive: "Retest a full lipid panel in ~12 weeks and discuss persistent elevation with your doctor.", rationale: "Non-HDL-C is a strong residual-risk marker worth confirming.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
  ] },
  { zone: "Triglycerides", derive: () => [
    { domain: "nutrition", directive: "Cut added sugar, refined carbs and alcohol; add oily fish 2-3×/week — the strongest dietary levers for high triglycerides.", rationale: "Triglycerides respond sharply to carbohydrate/alcohol load and omega-3 intake.", citation: "AHA 2021 Scientific Statement on Triglycerides; Endocrine Society 2012" },
    { domain: "training", directive: "Keep regular aerobic work in the week — endurance volume meaningfully lowers fasting triglycerides.", rationale: "Aerobic exercise is an established, dose-responsive triglyceride-lowering lever.", citation: "AHA 2021 Scientific Statement on Triglycerides" },
  ] },
  { zone: "HDL-C", derive: () => [
    { domain: "training", directive: "Prioritize regular aerobic exercise — it's the most reliable lever for raising low HDL-C.", rationale: "Aerobic training modestly but reliably raises HDL-C; pharmacologic HDL-raising has not shown benefit.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
    { domain: "nutrition", directive: "Favor unsaturated fats (olive oil, nuts, fish) over refined carbs; this can help low HDL alongside training.", rationale: "Fat-quality and carbohydrate-quality shifts support HDL; diet is a softer lever than exercise here.", citation: "AHA/ACC 2018 Cholesterol Guideline", uncertain: true },
  ] },
  { zone: "hs-CRP", derive: () => [
    { domain: "watch", directive: "Elevated hs-CRP is non-specific inflammation — recheck when not fighting an acute illness/injury, and discuss persistent elevation with your doctor.", rationale: "hs-CRP spikes with any acute inflammation; a single high reading needs context before it means cardiovascular risk.", citation: "AHA/CDC 2003 Markers of Inflammation Statement" },
    { domain: "nutrition", directive: "Lean toward an anti-inflammatory pattern (oily fish, olive oil, plenty of vegetables, fewer ultra-processed foods) while hs-CRP is up.", rationale: "Dietary pattern is associated with lower hs-CRP, though the effect size is modest.", citation: "AHA/CDC 2003 Markers of Inflammation Statement", uncertain: true },
  ] },
  { zone: "Homocysteine", derive: () => [
    { domain: "nutrition", directive: "Ensure adequate folate, B12 and B6 (leafy greens, legumes, eggs, fish); a B-complex can lower elevated homocysteine — confirm B12 status with your doctor.", rationale: "Homocysteine is lowered by B-vitamin status; whether that lowers cardiovascular events is unproven, so this is informational.", citation: "Endocrine Society / AHA — B-vitamin homocysteine literature", uncertain: true },
    { domain: "watch", directive: "Recheck homocysteine after a few months of B-vitamin sufficiency; discuss persistent elevation with your doctor.", rationale: "Confirms response and flags the small subset where elevation reflects another issue.", citation: null, uncertain: true },
  ] },
  { zone: "HbA1c", derive: () => [
    { domain: "nutrition", directive: "Reduce refined carbs and added sugar, anchor meals on protein and fiber, and avoid large glucose spikes to bring HbA1c toward optimal.", rationale: "HbA1c reflects 3-month average glucose; carbohydrate quality is the primary dietary lever.", citation: "ADA Standards of Care 2024; Endocrine Society" },
    { domain: "training", directive: "Keep both resistance training and aerobic work in the week — each independently improves glucose handling.", rationale: "Exercise improves insulin sensitivity; combined modalities outperform either alone.", citation: "ADA/ACSM 2010 Joint Position Statement" },
    { domain: "watch", directive: "Recheck HbA1c in ~3 months; if it stays in the pre-diabetic range, discuss with your doctor.", rationale: "A1c moves on a ~3-month cycle; pre-diabetic trends warrant clinical follow-up.", citation: "ADA Standards of Care 2024" },
  ] },
  { zone: "Fasting glucose", derive: (ctx) => ctx.side === "high" ? [
    { domain: "nutrition", directive: "Watch evening refined-carb load and prioritize protein/fiber at meals to steady fasting glucose.", rationale: "Fasting glucose responds to overall carbohydrate load and insulin sensitivity.", citation: "ADA Standards of Care 2024" },
    { domain: "watch", directive: "Confirm with HbA1c and recheck fasting glucose; a single high reading can be stress/illness-driven — raise a persistent trend with your doctor.", rationale: "Fasting glucose is noisy day-to-day; A1c contextualizes it.", citation: "ADA Standards of Care 2024" },
  ] : [
    { domain: "watch", directive: "Low fasting glucose is not a carb-cutting signal; confirm the reading and discuss repeated lows or symptoms with your doctor.", rationale: "Fasting glucose can run low from timing, illness, medications, or measurement noise; repeated lows need context.", citation: "ADA Standards of Care 2024" },
  ] },
  { zone: "Fasting insulin", derive: () => [
    { domain: "training", directive: "Add or maintain resistance training plus aerobic work — both improve insulin sensitivity and lower fasting insulin.", rationale: "Elevated fasting insulin signals insulin resistance, which exercise directly improves.", citation: "ADA/ACSM 2010 Joint Position Statement", uncertain: true },
    { domain: "nutrition", directive: "Reduce refined carbs and overall energy excess; fat loss is a strong lever on fasting insulin.", rationale: "Insulin resistance tracks with adiposity and carbohydrate load.", citation: null, uncertain: true },
  ] },
  { zone: "Ferritin", derive: (ctx) => ctx.side === "low" ? [
    { domain: "nutrition", directive: "Add iron-rich foods (red meat, lentils, spinach) with vitamin C, and avoid tea/coffee around iron-rich meals while ferritin is low.", rationale: "Ferritin reflects iron stores; low stores often respond to dietary or supplemental iron when clinically appropriate.", citation: "WHO 2020 Ferritin Guideline" },
    { domain: "training", directive: "While ferritin runs low, be cautious adding endurance volume and keep easy sessions easy.", rationale: "Iron is rate-limiting for oxygen transport; training hard on low stores can impair recovery.", citation: "IOC consensus on iron in athletes" },
    { domain: "watch", directive: "Recheck ferritin with iron studies / CBC after ~8-12 weeks; discuss supplementation with your doctor.", rationale: "Iron repletion takes weeks; a retest confirms direction and rules out other causes.", citation: "WHO 2020 Ferritin Guideline" },
  ] : [
    { domain: "nutrition", directive: "Do not add iron to chase ferritin down; high ferritin needs clinical context rather than a diet lever.", rationale: "Ferritin can rise with inflammation, liver stress, iron overload, or recent illness, so the cause matters.", citation: "WHO 2020 Ferritin Guideline" },
    { domain: "watch", directive: "Discuss elevated ferritin with your doctor and consider iron studies / CBC to understand why it is high.", rationale: "A high ferritin result is a context marker, not a standalone nutrition target.", citation: "WHO 2020 Ferritin Guideline" },
  ] },
  { zone: "Vitamin D", derive: (ctx) => ctx.side === "low" ? [
    { domain: "nutrition", directive: "Vitamin D is low — get sensible sun exposure and consider a D3 supplement with a fat-containing meal — confirm the dose with your doctor.", rationale: "Low 25-OH vitamin D is common and corrects reliably with D3; dosing should be clinically guided.", citation: "Endocrine Society 2011 Vitamin D Guideline" },
    { domain: "watch", directive: "Recheck vitamin D in ~3 months after supplementing to confirm you've reached an adequate level.", rationale: "Vitamin D corrects over weeks-months; a retest confirms repletion and avoids over-supplementation.", citation: "Endocrine Society 2011 Vitamin D Guideline" },
  ] : [
    // A HIGH vitamin D must NEVER trigger "supplement D3" — that was the bug. A
    // high level needs the opposite: stop supplementing and check with a doctor.
    { domain: "nutrition", directive: "Vitamin D is on the high side — do NOT add more D3; pause any supplement and confirm the dose with your doctor.", rationale: "Excess vitamin D can raise calcium and cause harm; a high level calls for backing off, not adding.", citation: "Endocrine Society 2011 Vitamin D Guideline" },
    { domain: "watch", directive: "Discuss a high vitamin D with your doctor and recheck — it usually reflects over-supplementation.", rationale: "High 25-OH vitamin D is almost always supplement-driven and worth a recheck.", citation: "Endocrine Society 2011 Vitamin D Guideline" },
  ] },
  { zone: "Systolic BP", derive: () => [
    { domain: "nutrition", directive: "Lean toward a DASH-style pattern: more vegetables, fruit and potassium, less sodium and alcohol, to support a healthier blood pressure.", rationale: "DASH and sodium reduction are first-line, evidence-backed dietary levers for blood pressure.", citation: "ACC/AHA 2017 Hypertension Guideline" },
    { domain: "training", directive: "Keep regular aerobic exercise in the week — it reliably lowers resting blood pressure.", rationale: "Aerobic training produces a consistent, dose-responsive reduction in resting BP.", citation: "ACC/AHA 2017 Hypertension Guideline" },
    { domain: "watch", directive: "Confirm with repeated home readings (a single clinic value can be elevated); discuss a sustained high reading with your doctor.", rationale: "Single BP readings overstate risk; home averaging is the standard for confirmation.", citation: "ACC/AHA 2017 Hypertension Guideline" },
  ] },
  { zone: "Diastolic BP", derive: () => [
    { domain: "nutrition", directive: "Lean toward a DASH-style pattern: more vegetables, fruit and potassium, less sodium and alcohol, to support a healthier blood pressure.", rationale: "DASH and sodium reduction are first-line, evidence-backed dietary levers for blood pressure.", citation: "ACC/AHA 2017 Hypertension Guideline" },
    { domain: "training", directive: "Keep regular aerobic exercise in the week — it reliably lowers resting blood pressure.", rationale: "Aerobic training produces a consistent, dose-responsive reduction in resting BP.", citation: "ACC/AHA 2017 Hypertension Guideline" },
    { domain: "watch", directive: "Confirm with repeated home readings (a single clinic value can be elevated); discuss a sustained high reading with your doctor.", rationale: "Single BP readings overstate risk; home averaging is the standard for confirmation.", citation: "ACC/AHA 2017 Hypertension Guideline" },
  ] },
  { zone: "Uric acid", derive: () => [
    { domain: "nutrition", directive: "Cut back on alcohol (especially beer), sugary drinks and very high-purine foods to lower elevated uric acid.", rationale: "Uric acid responds to fructose, alcohol and purine intake; reduction lowers gout risk.", citation: "ACR 2020 Gout Management Guideline", uncertain: true },
    { domain: "watch", directive: "Discuss persistently high uric acid with your doctor, especially with any joint pain history.", rationale: "Hyperuricemia is clinically actionable when symptomatic; otherwise it's a watch item.", citation: "ACR 2020 Gout Management Guideline" },
  ] },
  { zone: "ALT", derive: () => [
    { domain: "watch", directive: "Mildly elevated ALT is often fatty-liver-related; reducing alcohol, added sugar and excess body fat tends to help — discuss a persistent elevation with your doctor.", rationale: "ALT elevation commonly reflects metabolic/fatty liver, which lifestyle change improves; persistent elevation needs evaluation.", citation: "AASLD 2023 NAFLD/MASLD Guidance", uncertain: true },
  ] },
  { zone: "GGT", derive: () => [
    { domain: "watch", directive: "Elevated GGT often tracks with alcohol intake and fatty liver; cutting alcohol is the clearest lever — discuss a persistent elevation with your doctor.", rationale: "GGT is sensitive to alcohol and hepatic stress; reduction is the first dietary lever.", citation: "AASLD 2023 NAFLD/MASLD Guidance", uncertain: true },
  ] },
  { zone: "AST", derive: () => [
    { domain: "watch", directive: "Mildly elevated AST, especially alongside ALT, often reflects fatty liver or recent hard training; cut alcohol and added sugar, and discuss a persistent elevation with your doctor.", rationale: "AST rises with hepatic stress and also transiently after intense exercise, so context (and the AST:ALT ratio) matters before it means liver disease.", citation: "AASLD 2023 NAFLD/MASLD Guidance", uncertain: true },
  ] },
  { zone: "Lp(a)", derive: () => [
    { domain: "watch", directive: "Lp(a) is largely genetic and set for life — measure it ONCE; an elevated result is a reason to be stricter on every modifiable risk (especially ApoB/LDL) and to discuss it with your doctor, not a diet you can change.", rationale: "Lp(a) barely responds to lifestyle, but a high level raises lifetime cardiovascular risk, so it lowers the target you want for ApoB/LDL.", citation: "EAS 2022 Lp(a) Consensus Statement; ACC/AHA" },
    { domain: "nutrition", directive: "Because Lp(a) is elevated, be especially diligent on the ApoB/LDL levers you CAN move — lower saturated fat, raise soluble fiber, favor oily fish — to compound risk down where Lp(a) won't budge.", rationale: "You can't lower Lp(a) much by diet, so the payoff is in pushing the modifiable atherogenic markers further toward optimal.", citation: "EAS 2022 Lp(a) Consensus Statement", uncertain: true },
  ] },
  { zone: "eGFR", derive: () => [
    { domain: "watch", directive: "A reduced eGFR is a kidney-function signal worth confirming (it can dip transiently with dehydration or after heavy training) — recheck and discuss a persistent reading with your doctor before acting on it.", rationale: "eGFR is estimated from creatinine and varies with hydration and muscle mass, so a single low value needs confirmation.", citation: "KDIGO 2024 CKD Guideline" },
    { domain: "nutrition", directive: "While eGFR is reduced, be cautious with high-dose creatine and very high protein loads, and avoid NSAIDs around hard training — discuss supplement choices with your doctor.", rationale: "Some supplements and very high protein intakes add filtration load; caution is sensible until kidney function is confirmed.", citation: "KDIGO 2024 CKD Guideline", uncertain: true },
  ] },
  { zone: "Creatinine", derive: (ctx) => ctx.side === "high" ? [
    { domain: "watch", directive: "A high creatinine often just reflects muscle mass, recent hard training or dehydration rather than kidney trouble — confirm with eGFR/cystatin C and your hydration before worrying, and discuss a persistent rise with your doctor.", rationale: "Creatinine is produced by muscle and rises with training and dehydration, so it's a poor standalone kidney marker.", citation: "KDIGO 2024 CKD Guideline" },
    { domain: "nutrition", directive: "If creatinine is up, ease off high-dose creatine for a recheck and stay well hydrated — both move the number without meaning kidney disease.", rationale: "Creatine supplementation and dehydration both raise serum creatinine independent of kidney function.", citation: "KDIGO 2024 CKD Guideline", uncertain: true },
  ] : [
    { domain: "watch", directive: "A low creatinine usually just reflects lower muscle mass and is rarely a problem on its own — no action needed beyond your normal labs.", rationale: "Low creatinine tracks with low muscle mass and is generally benign.", citation: "KDIGO 2024 CKD Guideline", uncertain: true },
  ] },
  { zone: "TSH", derive: (ctx) => ctx.side === "high" ? [
    { domain: "watch", directive: "A raised TSH can point to an underactive thyroid (and explains stubborn fatigue, cold, or weight that won't move) — confirm with free T4 (and free T3) and discuss with your doctor; this is clinical, not a diet fix.", rationale: "TSH above the optimal band suggests hypothyroidism, which needs free-hormone confirmation and clinical management.", citation: "American Thyroid Association 2014 Hypothyroidism Guideline" },
    { domain: "training", directive: "If thyroid is underactive, expect recovery and energy to lag until it's addressed — keep volume conservative and don't read the fatigue as poor effort.", rationale: "Untreated hypothyroidism blunts recovery and exercise tolerance.", citation: "American Thyroid Association 2014 Hypothyroidism Guideline", uncertain: true },
  ] : [
    { domain: "watch", directive: "A low TSH can reflect an overactive thyroid — confirm with free T4/T3 and discuss with your doctor; this is clinical, not a lifestyle lever.", rationale: "Suppressed TSH suggests hyperthyroidism, which needs clinical evaluation.", citation: "American Thyroid Association 2016 Hyperthyroidism Guideline" },
  ] },
  { zone: "Free T4", derive: () => [
    { domain: "watch", directive: "An out-of-optimal free T4 belongs with its TSH and free T3 for a full thyroid picture — discuss the pattern with your doctor; thyroid is a clinical, not dietary, lever.", rationale: "Free T4 is interpreted alongside TSH/free T3, not in isolation.", citation: "American Thyroid Association 2014 Hypothyroidism Guideline" },
  ] },
  { zone: "Free T3", derive: () => [
    { domain: "watch", directive: "Free T3 can run low with very aggressive dieting or overtraining as well as thyroid issues — read it with TSH/free T4 and your recent deficit, and discuss a persistent abnormality with your doctor.", rationale: "Low free T3 (low-T3 syndrome) commonly accompanies large energy deficits and heavy training, separate from primary thyroid disease.", citation: "American Thyroid Association 2014 Hypothyroidism Guideline", uncertain: true },
    { domain: "nutrition", directive: "If free T3 is low during a long deficit, a diet break / refeed toward maintenance often helps — this is a sign to ease the deficit, not push it.", rationale: "Energy availability strongly influences T3; restoring intake can normalize it.", citation: "Endocrine Society / sports-nutrition literature on low energy availability", uncertain: true },
  ] },
  { zone: "Vitamin B12", derive: (ctx) => ctx.side === "low" ? [
    { domain: "nutrition", directive: "B12 is low — prioritize animal foods (meat, fish, eggs, dairy) or a B12 supplement if you eat little animal protein; confirm the cause with your doctor.", rationale: "Low B12 impairs red-cell formation and nerve function and corrects with dietary or supplemental B12.", citation: "BSH 2014 Cobalamin & Folate Guideline" },
    { domain: "watch", directive: "Recheck B12 (and consider methylmalonic acid) after repleting; persistent low B12 despite intake needs a doctor to rule out absorption issues.", rationale: "Ongoing low B12 despite intake can signal malabsorption (e.g. pernicious anemia) worth investigating.", citation: "BSH 2014 Cobalamin & Folate Guideline" },
  ] : [
    { domain: "watch", directive: "A high B12 is usually just supplementation; if you aren't supplementing, mention a markedly high B12 to your doctor.", rationale: "High B12 is typically benign and supplement-driven, but an unexplained high level occasionally warrants review.", citation: "BSH 2014 Cobalamin & Folate Guideline", uncertain: true },
  ] },
  { zone: "Folate", derive: (ctx) => ctx.side === "low" ? [
    { domain: "nutrition", directive: "Folate is low — load up on leafy greens, legumes and other folate-rich foods (or a folate/B-complex), and check B12 at the same time so you don't mask it.", rationale: "Folate deficiency impairs red-cell formation; it should be repleted alongside B12 to avoid masking a B12 deficiency.", citation: "BSH 2014 Cobalamin & Folate Guideline" },
  ] : [
    { domain: "watch", directive: "A high folate is generally harmless and usually reflects supplementation; no action beyond noting it.", rationale: "Elevated folate is typically benign.", citation: "BSH 2014 Cobalamin & Folate Guideline", uncertain: true },
  ] },
  { zone: "Magnesium", derive: (ctx) => ctx.side === "low" ? [
    { domain: "nutrition", directive: "Magnesium is on the low side — lean on nuts, seeds, legumes, leafy greens and whole grains; a glycinate/citrate supplement can help, especially if cramping or sleep is off. Confirm dose with your doctor if you have kidney concerns.", rationale: "Low magnesium is common and supports muscle, sleep and glucose handling; food first, then a well-tolerated supplement.", citation: "Magnesium status literature (serum underestimates body stores)", uncertain: true },
  ] : [
    { domain: "watch", directive: "A high magnesium is unusual outside supplementation or reduced kidney clearance — if you aren't supplementing heavily, mention it to your doctor.", rationale: "Elevated magnesium can reflect over-supplementation or impaired renal clearance.", citation: "Magnesium status literature", uncertain: true },
  ] },
  { zone: "Testosterone", derive: (ctx) => ctx.side === "low" ? [
    { domain: "training", directive: "Low testosterone (alongside fatigue or stalled progress) is often downstream of under-recovery — protect sleep, avoid chronic over-reaching, and keep resistance training in the week; don't read it as a reason to train harder.", rationale: "Low total testosterone in active men frequently reflects low energy availability and under-recovery, which lifestyle addresses before any clinical step.", citation: "Endocrine Society 2018 Testosterone Therapy Guideline", uncertain: true },
    { domain: "nutrition", directive: "Make sure you're eating enough (not stuck in a deep deficit), getting adequate fat and zinc, and recovering — chronic under-fueling suppresses testosterone. Discuss a confirmed low level with your doctor.", rationale: "Energy and fat availability influence endogenous testosterone; a deep, prolonged deficit can suppress it.", citation: "Endocrine Society 2018 Testosterone Therapy Guideline", uncertain: true },
    { domain: "watch", directive: "Confirm a low testosterone with a morning repeat (and LH/SHBG) before drawing conclusions, and discuss it with your doctor — diurnal variation is large.", rationale: "Testosterone peaks in the morning and varies day to day, so a single low value needs confirmation.", citation: "Endocrine Society 2018 Testosterone Therapy Guideline" },
  ] : [
    { domain: "watch", directive: "A high testosterone in a man not on therapy is worth mentioning to your doctor; if you're using exogenous hormones, that's the likely cause.", rationale: "Unexplained high testosterone warrants clinical context.", citation: "Endocrine Society 2018 Testosterone Therapy Guideline", uncertain: true },
  ] },
  { zone: "Estradiol", derive: () => [
    { domain: "watch", directive: "An out-of-band estradiol is best read alongside testosterone (and with your doctor) — in men it often tracks with body fat and aromatization; chasing it in isolation isn't useful.", rationale: "Estradiol is interpreted in the context of testosterone and body composition, not as a standalone target.", citation: "Endocrine Society 2018 Testosterone Therapy Guideline", uncertain: true },
  ] },
  // ---- endurance / cardiorespiratory fitness (v35) ----
  // Device-derived markers — INFORMATIONAL, optimal-zone framing only, never a score.
  // The levers are lifestyle (training + recovery), so these are softer nudges
  // (uncertain) anchored to the consensus that cardiorespiratory fitness is one of
  // the strongest longevity signals.
  { zone: "VO2max", derive: () => [
    { domain: "training", directive: "Your estimated VO2max is below optimal — keep a steady aerobic base and add ONE weekly higher-intensity session (intervals or a tempo effort) to nudge it up; cardiorespiratory fitness is one of the strongest longevity levers.", rationale: "VO2max responds to a polarized mix of easy volume plus targeted high-intensity work, and higher fitness tracks with lower all-cause mortality.", citation: "ACSM / AHA cardiorespiratory fitness consensus", uncertain: true },
  ] },
  { zone: "Resting HR", derive: (ctx) => ctx.side === "high" ? [
    { domain: "training", directive: "Your resting heart rate is running higher than optimal — build easy aerobic volume and protect recovery; a single high reading can also just mean a poor night or building fatigue, so read the trend, not one day.", rationale: "A lower resting HR generally reflects better aerobic fitness and parasympathetic tone; a persistently elevated one can flag accumulated fatigue.", citation: "Cardiorespiratory fitness literature", uncertain: true },
    { domain: "watch", directive: "If resting HR stays elevated alongside poor sleep or stalled training, treat it as a fatigue signal (ease off) — and mention a sustained unexplained rise to your doctor.", rationale: "A sustained resting-HR rise that isn't training-explained is worth clinical context.", citation: null, uncertain: true },
  ] : [] },
  { zone: "HRV", derive: (ctx) => ctx.side === "low" ? [
    { domain: "training", directive: "Your HRV is running below your optimal range — favor easy aerobic work, protect sleep, and don't stack hard days while it's suppressed; HRV is a recovery/readiness signal, read it as a trend, not a single night.", rationale: "Low HRV often reflects accumulated training or life stress and under-recovery; backing off intensity tends to restore it.", citation: "Heart-rate-variability training-readiness literature", uncertain: true },
  ] : [] },
  // ---- body composition: the connected lever that moves lipids, glucose, BP & hormones together ----
  { zone: "Body fat", derive: () => [
    { domain: "nutrition", directive: "Body fat is above optimal — the highest-leverage move is a modest, LEAN-SAFE deficit (~300-500 kcal) with high protein (~0.7-1 g/lb), not a crash diet; losing fat while holding lean improves lipids, glucose, BP and testosterone at once.", rationale: "Excess adiposity (especially visceral) raises hepatic VLDL, blood pressure, insulin resistance and aromatization — so fat loss is the single change that moves the most markers together.", citation: "AHA/ACC obesity & cardiovascular-risk literature" },
    { domain: "training", directive: "Keep resistance training central while leaning out — it's what protects the lean mass that keeps the loss healthy and the metabolism up; pair it with your aerobic base.", rationale: "Resistance training during a deficit preserves fat-free mass, so the weight that comes off is fat rather than muscle.", citation: "ACSM resistance-training-during-weight-loss literature" },
    { domain: "watch", directive: "Re-measure body composition (DEXA or a consistent method) every ~8-12 weeks rather than chasing the scale daily — body recomposition shows up in the trend, not day to day.", rationale: "Body-fat change is slow and noisy day to day; periodic composition measurement reads the real trajectory.", citation: null, uncertain: true },
  ] },
  { zone: "Total cholesterol", derive: () => [
    { domain: "nutrition", directive: "Total cholesterol is above optimal — the same lipid levers apply: cut saturated fat, add ~10g/day soluble fiber, favor unsaturated fats and oily fish. Read it alongside ApoB/LDL, which matter more for risk.", rationale: "Total cholesterol responds to the standard lipid-lowering diet, though ApoB/LDL are the better risk targets.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
    { domain: "watch", directive: "Retest a full lipid panel (with ApoB) in ~12 weeks and discuss a persistently high total cholesterol with your doctor.", rationale: "A 12-week retest captures dietary response and frames total cholesterol within the fuller lipid picture.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
  ] },
  { zone: "Omega-3 index", derive: (ctx) => ctx.side === "low" ? [
    { domain: "nutrition", directive: "Your omega-3 index is below the protective range — eat oily fish 2-3×/week (favor smaller, lower-mercury species: salmon, sardines, trout, herring) or add an EPA+DHA supplement; it supports triglycerides, inflammation and heart rhythm.", rationale: "A low omega-3 index tracks with higher cardiovascular risk and responds reliably to EPA/DHA intake.", citation: "AHA 2017 Omega-3 Science Advisory" },
    { domain: "watch", directive: "Recheck the omega-3 index in ~3-4 months after raising intake — red-cell omega-3 turns over slowly.", rationale: "The omega-3 index reflects months of intake, so a retest is meaningful only after a sustained change.", citation: "AHA 2017 Omega-3 Science Advisory", uncertain: true },
  ] : [] },
  { zone: "Mercury", derive: () => [
    { domain: "nutrition", directive: "Blood mercury is on the high side — keep getting your omega-3s, but shift away from large predatory fish (tuna, swordfish, king mackerel) toward smaller species (salmon, sardines, trout); this lowers mercury while protecting omega-3 intake.", rationale: "Mercury accumulates from large, long-lived predatory fish; smaller oily fish deliver omega-3 with far less mercury.", citation: "EPA/FDA fish-consumption advice" },
    { domain: "watch", directive: "Recheck mercury after a few months of lower-mercury fish choices; discuss a persistently elevated level with your doctor.", rationale: "Blood mercury falls over months once high-mercury intake drops.", citation: "EPA/FDA fish-consumption advice", uncertain: true },
  ] },
];
