import { db } from "../db.js";
import { DIRECTIVE_DOMAINS, addDirective, clearDirectivesForSource, defaultDirectiveKey, hydrateDirective, listActiveDirectives, normalizeDirectiveKey } from "./coach.js";
import { buildSafetyMarkerContext, safetyGate, verifyCitation } from "./evidence.js";
import { forecastMarker, getMarkerHistory, lsqSlopePerDay } from "./health.js";
import { getProfile } from "./profile.js";
import { getAppState, setAppState } from "./app-state.js";

// ============================================================================
// SUPPLEMENT UNDERSTANDING — say it once in plain words, the system approximates.
// NOT a daily log. The deterministic KB below covers the common supplements so it
// works offline; the chat agent can also hand us already-structured items for the
// long tail. Each understood supplement carries the markers/domains it touches so
// the connected brain can reason about it (D3 ↔ vitamin-D, omega-3 ↔ triglycerides,
// whey ↔ protein floor, creatine ↔ eGFR).
// ============================================================================

export interface SupplementItem {
  name: string;
  raw: string;
  dose: string | null;
  frequency: string;
  category: string;
  related_markers: string[];
  note: string | null;
}

// Knowledge base: keys are lowercased match substrings (longest match wins, like
// matchOptimalZone). dose/frequency are TYPICAL approximations — never presented as
// prescription. related_markers are canonical marker keys the connected brain knows.
const SUPPLEMENT_KB: Array<{
  keys: string[]; name: string; dose: string | null; frequency: string;
  category: string; markers: string[]; note: string;
}> = [
  { keys: ["creatine"], name: "Creatine monohydrate", dose: "5 g", frequency: "daily", category: "performance",
    markers: ["eGFR", "creatinine"], note: "Strength, power and cognition; well-studied and safe at 3–5 g/day." },
  { keys: ["omega 3", "omega-3", "omega3", "fish oil", "fish-oil", "epa", "dha", "cod liver"], name: "Omega-3 (EPA/DHA)",
    dose: "1–2 g EPA+DHA", frequency: "daily", category: "omega-3", markers: ["Triglycerides", "hs-CRP", "Omega-3 Index"],
    note: "Cardiovascular and anti-inflammatory; supports triglycerides." },
  { keys: ["vitamin d", "vit d", "vitamin-d", "d3", "d supp"], name: "Vitamin D3", dose: "1000–4000 IU", frequency: "daily",
    category: "vitamin", markers: ["Vitamin D", "25-OH Vitamin D"], note: "Bone and immune; dose to your 25-OH level." },
  { keys: ["whey", "protein powder", "protein shake", "casein", "protein isolate"], name: "Whey protein",
    dose: "20–30 g/serving", frequency: "occasional", category: "protein", markers: [],
    note: "Counts toward your daily protein floor; a convenient source, not a requirement." },
  { keys: ["magnesium", "mag glycinate", "mag citrate"], name: "Magnesium (glycinate)", dose: "200–400 mg", frequency: "daily",
    category: "mineral", markers: ["Magnesium"], note: "Sleep, muscle and nerve; glycinate is gentle on the gut." },
  { keys: ["zinc"], name: "Zinc", dose: "15–30 mg", frequency: "daily", category: "mineral", markers: ["Zinc"],
    note: "Immune and hormonal; avoid megadosing (copper balance)." },
  { keys: ["multivitamin", "multi-vitamin", "multi vitamin"], name: "Multivitamin", dose: "1/day", frequency: "daily",
    category: "vitamin", markers: [], note: "Broad micronutrient insurance." },
  { keys: ["b12", "b-12", "b complex", "b-complex", "methylcobalamin"], name: "Vitamin B12 / B-complex", dose: null,
    frequency: "daily", category: "vitamin", markers: ["B12", "Folate"], note: "Energy and methylation; relevant on a plant-forward diet." },
  { keys: ["iron", "ferrous"], name: "Iron", dose: null, frequency: "as directed", category: "mineral",
    markers: ["Ferritin", "Hemoglobin"], note: "Best only with low ferritin — easy to overshoot; pair with labs." },
  { keys: ["vitamin c", "vit c", "ascorbic"], name: "Vitamin C", dose: "500–1000 mg", frequency: "daily", category: "vitamin",
    markers: [], note: "Antioxidant; aids iron absorption and collagen synthesis." },
  { keys: ["ashwagandha", "ksm-66", "ksm 66"], name: "Ashwagandha", dose: "300–600 mg", frequency: "daily", category: "adaptogen",
    markers: ["Cortisol", "Testosterone"], note: "Stress and sleep; consider cycling it." },
  { keys: ["collagen"], name: "Collagen peptides", dose: "10–15 g", frequency: "daily", category: "protein", markers: [],
    note: "Joint and skin; take with vitamin C." },
  { keys: ["turmeric", "curcumin"], name: "Curcumin", dose: "500 mg", frequency: "daily", category: "anti-inflammatory",
    markers: ["hs-CRP"], note: "Anti-inflammatory; absorption improves with black pepper/fat." },
  { keys: ["coq10", "co-q10", "co q10", "ubiquinol"], name: "CoQ10", dose: "100–200 mg", frequency: "daily", category: "cardiovascular",
    markers: ["LDL-C"], note: "Mitochondrial support; commonly paired with a statin." },
  { keys: ["berberine"], name: "Berberine", dose: "500 mg", frequency: "most days", category: "metabolic",
    markers: ["HbA1c", "Fasting Glucose", "Glucose"], note: "Glucose and lipid support." },
  { keys: ["probiotic"], name: "Probiotic", dose: null, frequency: "daily", category: "gut", markers: [], note: "Gut microbiome support." },
  { keys: ["melatonin"], name: "Melatonin", dose: "0.5–3 mg", frequency: "as needed", category: "sleep", markers: [],
    note: "Sleep onset; lowest effective dose, away from bright light." },
  { keys: ["psyllium", "metamucil", "fiber supplement", "fibre supplement"], name: "Fiber (psyllium)", dose: "5–10 g",
    frequency: "daily", category: "gut", markers: ["LDL-C"], note: "Gut and cholesterol; ramp up with water." },
  { keys: ["electrolyte", "lmnt", "element"], name: "Electrolytes", dose: null, frequency: "as needed", category: "hydration",
    markers: [], note: "Hydration around training/heat." },
  { keys: ["pre-workout", "preworkout", "pre workout", "caffeine"], name: "Pre-workout / caffeine", dose: null, frequency: "as needed",
    category: "performance", markers: [], note: "Performance/alertness; keep it away from sleep." },
  { keys: ["nmn", "nicotinamide riboside", "nr "], name: "NAD+ precursor (NMN/NR)", dose: null, frequency: "daily",
    category: "longevity", markers: [], note: "NAD+ support; evidence still emerging." },
];

function matchSupplementKB(low: string) {
  let best: (typeof SUPPLEMENT_KB)[number] | null = null;
  let bestLen = 0;
  for (const e of SUPPLEMENT_KB) {
    for (const k of e.keys) {
      if (low.includes(k) && k.length > bestLen) { best = e; bestLen = k.length; }
    }
  }
  // Vitamin D often shows up as a bare token the substring keys miss ("some d",
  // "just D"): catch it, but never override a longer explicit match.
  if (bestLen < 4 && (/\b(vitamin\s*d|vit\.?\s*d|d3)\b/.test(low) || (/\bd\b/.test(low) && /suppl|tab|drop|iu|daily|some/.test(low)))) {
    const vd = SUPPLEMENT_KB.find((e) => e.name === "Vitamin D3");
    if (vd) return vd;
  }
  return best;
}

function extractSupplementFrequency(low: string): string | null {
  if (/twice|2x|two times/.test(low)) return "twice daily";
  if (/most days|weekday/.test(low)) return "most days";
  if (/occasional|sometimes|now and then|here and there|every so often|once in a while|on and off/.test(low)) return "occasional";
  if (/weekly|once a week|per week/.test(low)) return "weekly";
  if (/as needed|when needed|prn|pre[- ]?work/.test(low)) return "as needed";
  if (/daily|every ?day|each day|a day/.test(low)) return "daily";
  return null;
}

function extractSupplementDose(frag: string): string | null {
  const m = /(\d+(?:[.,]\d+)?)\s?(g|mg|mcg|µg|iu|ml|caps?|capsules?|tabs?|scoops?)\b/i.exec(frag);
  return m ? `${m[1].replace(",", ".")} ${m[2].toLowerCase()}` : null;
}

function titleCaseWords(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Deterministic free-text → approximated supplement items. Splits on the natural
// separators ("creatine daily, omega-3 and some D, whey occasionally") and maps
// each fragment through the KB; unknown supplements are kept verbatim (cadence
// only) rather than dropped. Pure + offline-testable.
export function parseSupplements(text: string): SupplementItem[] {
  const items: SupplementItem[] = [];
  const cleaned = String(text || "").trim();
  if (!cleaned) return items;
  const frags = cleaned
    .split(/[,;\n•]+|\s+and\s+|\s*&\s*|\s+plus\s+/i)
    .map((f) => f.trim())
    .filter(Boolean);
  const stripLead = (s: string) => s.replace(/^\s*(i\s+(also\s+)?take|i'm\s+on|taking|i\s+use|some|a\s+bit\s+of|a\s+little)\b/i, "").trim();
  const seen = new Set<string>();
  for (const frag of frags) {
    // Match on the RAW fragment (the "some"/"daily" context words help disambiguate,
    // e.g. "some D" → Vitamin D); only strip lead-ins when naming an unknown one.
    const low = frag.toLowerCase();
    const kb = matchSupplementKB(low);
    const freq = extractSupplementFrequency(low) ?? kb?.frequency ?? "daily";
    const doseOverride = extractSupplementDose(frag);
    if (kb) {
      const key = kb.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ name: kb.name, raw: frag, dose: doseOverride ?? kb.dose, frequency: freq, category: kb.category, related_markers: kb.markers, note: kb.note });
    } else {
      // Unknown supplement — keep what they said (strip lead-ins + cadence words),
      // approximate nothing beyond cadence.
      const name = titleCaseWords(
        stripLead(frag)
          .replace(/\d+(?:[.,]\d+)?\s?(g|mg|mcg|µg|iu|ml|caps?|capsules?|tabs?|scoops?)\b/gi, "")
          .replace(/\b(daily|occasionally|sometimes|every ?day|most days|weekly|as needed|a day)\b/gi, "")
          .replace(/\s{2,}/g, " ").trim()
      );
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      items.push({ name, raw: frag, dose: doseOverride, frequency: freq, category: "other", related_markers: [], note: null });
    }
  }
  return items;
}

// Supplement rows store related_markers as a JSON string (and have a `raw` text
// column, NOT raw_json) — so the generic hydrateJson doesn't fit. Parse the
// markers array back and leave `raw` intact.
function hydrateSupp(row: any) {
  if (!row) return row;
  let markers: any = [];
  try { markers = row.related_markers ? JSON.parse(row.related_markers) : []; } catch { markers = []; }
  return { ...row, related_markers: Array.isArray(markers) ? markers : [] };
}

// Insert one already-structured supplement (used by the chat agent for the long
// tail). Dedup by canonical name: an existing row is UPDATED in place (re-stating
// "creatine" never duplicates it), and a previously-stopped one is reactivated.
export function addSupplement(item: Partial<SupplementItem>) {
  const name = String(item.name ?? "").trim();
  if (!name) throw new Error("supplement name required");
  const cat = String(item.category ?? "other").trim() || "other";
  const freq = String(item.frequency ?? "daily").trim() || "daily";
  const dose = item.dose == null ? null : String(item.dose).trim().slice(0, 60) || null;
  const note = item.note == null ? null : String(item.note).trim().slice(0, 300) || null;
  const markers = Array.isArray(item.related_markers) ? item.related_markers.slice(0, 8) : [];
  const raw = item.raw == null ? null : String(item.raw).trim().slice(0, 200) || null;
  const existing = db.prepare(`SELECT id FROM supplements WHERE lower(name) = lower(?)`).get(name) as any;
  if (existing) {
    db.prepare(
      `UPDATE supplements SET raw = COALESCE(?, raw), dose = ?, frequency = ?, category = ?, related_markers = ?, note = COALESCE(?, note), active = 1, updated_at = datetime('now') WHERE id = ?`
    ).run(raw, dose, freq, cat, JSON.stringify(markers), note, existing.id);
    return hydrateSupp(db.prepare(`SELECT * FROM supplements WHERE id = ?`).get(existing.id));
  }
  const info = db.prepare(
    `INSERT INTO supplements (name, raw, dose, frequency, category, related_markers, note) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(name.slice(0, 80), raw, dose, freq, cat.slice(0, 40), JSON.stringify(markers), note);
  return hydrateSupp(db.prepare(`SELECT * FROM supplements WHERE id = ?`).get(info.lastInsertRowid));
}

// The headline: free text → understood + stored supplements. Returns the items it
// recorded. Deterministic + offline (the KB does the approximating). `strict` keeps
// only KB-recognized supplements (drops unknown free-text) — used when parsing mixed
// prose (e.g. an onboarding intro) so non-supplement words never become entries.
export function understandSupplements(text: string, opts: { strict?: boolean } = {}) {
  let parsed = parseSupplements(text);
  if (opts.strict) parsed = parsed.filter((p) => p.category !== "other");
  return parsed.map((p) => addSupplement(p));
}

export function listSupplements(opts: { activeOnly?: boolean } = {}) {
  const where = opts.activeOnly === false ? "" : "WHERE active = 1";
  const rows = db.prepare(`SELECT * FROM supplements ${where} ORDER BY active DESC, id ASC`).all() as any[];
  return rows.map((r) => hydrateSupp(r));
}

export function updateSupplement(id: number, fields: Partial<SupplementItem> & { active?: number | boolean }) {
  const row = db.prepare(`SELECT * FROM supplements WHERE id = ?`).get(id) as any;
  if (!row) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  const put = (col: string, v: any) => { sets.push(`${col} = ?`); vals.push(v); };
  if (fields.name !== undefined) put("name", String(fields.name).trim().slice(0, 80));
  if (fields.dose !== undefined) put("dose", fields.dose == null ? null : String(fields.dose).trim().slice(0, 60) || null);
  if (fields.frequency !== undefined) put("frequency", String(fields.frequency).trim().slice(0, 40) || "daily");
  if (fields.category !== undefined) put("category", String(fields.category).trim().slice(0, 40) || "other");
  if (fields.note !== undefined) put("note", fields.note == null ? null : String(fields.note).trim().slice(0, 300) || null);
  if (fields.related_markers !== undefined) put("related_markers", JSON.stringify(Array.isArray(fields.related_markers) ? fields.related_markers.slice(0, 8) : []));
  if (fields.active !== undefined) put("active", fields.active ? 1 : 0);
  if (!sets.length) return hydrateSupp(row);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE supplements SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return hydrateSupp(db.prepare(`SELECT * FROM supplements WHERE id = ?`).get(id));
}

export function deleteSupplement(id: number) {
  const r = db.prepare(`DELETE FROM supplements WHERE id = ?`).run(id);
  return { deleted: r.changes, id };
}

// Condensed active set for the coaching prompts — the connected brain folds these
// into meals (protein/whey), training/watch (creatine, recovery) and marker reads.
export function supplementsForCoach() {
  return listSupplements({ activeOnly: true }).map((s: any) => ({
    name: s.name, dose: s.dose, frequency: s.frequency, category: s.category, related_markers: s.related_markers,
  }));
}

// ============================================================================
// THE CONNECTED BRAIN — marker prioritization + the propagation engine (T4).
// ============================================================================

// A meaningful, clinically-prioritized grouping for blood/health markers, so a
// long panel reads as a handful of health stories rather than an alphabet soup.
// Matching mirrors matchOptimalZone: lowercased substring against the marker
// name, LONGEST-MATCH-WINS (so "non-hdl" beats "hdl"). Order is intentional
// (most clinically prioritized first) and is the canonical display order. The
// "other" fallback has empty keys and only catches what nothing else claims.
interface MarkerGroup { key: string; label: string; keys: string[]; }
const MARKER_GROUPS: MarkerGroup[] = [
  { key: "lipids", label: "Lipids & Cardiovascular", keys: ["apob", "apolipoprotein", "apo b", "non-hdl", "non hdl", "ldl", "hdl", "cholesterol", "triglyceride", "lp(a)", "lipoprotein"] },
  { key: "metabolic", label: "Metabolic & Glucose", keys: ["hba1c", "a1c", "glucose", "insulin", "homa", "c-peptide", "fructosamine"] },
  { key: "inflammation", label: "Inflammation", keys: ["crp", "c-reactive", "c reactive", "homocysteine", "esr", "sed rate", "fibrinogen"] },
  { key: "iron", label: "Iron & Red Blood", keys: ["ferritin", "transferrin", "tibc", "iron", "hemoglobin", "hgb", "hematocrit", "hct", "rbc", "mcv", "mch", "rdw"] },
  { key: "blood", label: "White Cells & Platelets", keys: ["wbc", "white blood", "platelet", "neutrophil", "lymphocyte", "monocyte", "eosinophil", "basophil"] },
  { key: "liver", label: "Liver", keys: ["alt", "sgpt", "ast", "sgot", "ggt", "alp", "alkaline phosphatase", "bilirubin", "albumin", "total protein"] },
  { key: "kidney", label: "Kidney", keys: ["egfr", "creatinine", "bun", "urea", "uric acid", "cystatin"] },
  { key: "thyroid", label: "Thyroid", keys: ["tsh", "free t3", "free t4", "thyroxine", "triiodo", "thyroid"] },
  { key: "hormones", label: "Hormones", keys: ["testosterone", "estradiol", "estrogen", "cortisol", "dhea", "shbg", "progesterone", "prolactin", "igf", "lh", "fsh"] },
  { key: "vitamins", label: "Vitamins & Minerals", keys: ["vitamin d", "25-oh", "25 hydroxy", "25(oh)", "b12", "cobalamin", "folate", "vitamin b", "magnesium", "zinc", "calcium", "potassium", "sodium", "selenium", "omega"] },
  { key: "vitals", label: "Blood Pressure & Vitals", keys: ["systolic", "diastolic", "blood pressure", "resting heart", "heart rate"] },
  { key: "body", label: "Body Composition", keys: ["body fat", "fat mass", "lean mass", "bone density", "bmd", "t-score", "z-score", "visceral", "bmi"] },
  { key: "other", label: "Other Markers", keys: [] },
];
const OTHER_GROUP: MarkerGroup = MARKER_GROUPS[MARKER_GROUPS.length - 1];

// Best group for a marker name — longest-match-wins over substrings (so
// "non-hdl" outranks "hdl", "alkaline phosphatase" outranks "alp"). Falls back
// to the "other" group when nothing matches.
export function markerGroup(name: string): { key: string; label: string } {
  const n = String(name ?? "").toLowerCase();
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
  { keys: ["hs-crp", "hscrp", "c-reactive", "c reactive", "crp"], unit: "mg/L", optimal: [0, 1], dir: "high", actionable: true, label: "hs-CRP" },
  { keys: ["homocysteine"], unit: "umol/L", optimal: [4, 9], dir: "high", actionable: true, label: "Homocysteine" },
  { keys: ["hba1c", "a1c", "hemoglobin a1c"], unit: "%", optimal: [4.5, 5.4], dir: "high", actionable: true, label: "HbA1c" },
  { keys: ["fasting glucose", "glucose"], unit: "mg/dL", optimal: [70, 90], dir: "band", actionable: true, label: "Fasting glucose" },
  { keys: ["fasting insulin", "insulin"], unit: "uIU/mL", optimal: [2, 6], dir: "high", actionable: true, label: "Fasting insulin" },
  { keys: ["ferritin"], unit: "ng/mL", optimal: [50, 150], dir: "band", actionable: true, label: "Ferritin" },
  { keys: ["vitamin d", "25-oh", "25 hydroxy", "25(oh)d", "25-hydroxy"], unit: "ng/mL", optimal: [40, 60], dir: "low", actionable: true, label: "Vitamin D" },
  { keys: ["egfr"], unit: "mL/min", optimal: [90, 130], dir: "low", actionable: false, label: "eGFR" },
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
  { keys: ["systolic", "blood pressure", "bp systolic"], unit: "mmHg", optimal: [105, 120], dir: "high", actionable: true, label: "Systolic BP" },
  // Endurance / cardiorespiratory fitness markers (v35). These come from wearables
  // (injected into prioritizeMarkers from the recovery summary) but also match a lab
  // VO2max test. Optimal-ZONE framing only — higher VO2max is better, lower resting
  // HR is better, higher HRV is better — NEVER a 0-100 score. The bands are broad,
  // population-level orienting ranges (an athletic adult), not a personal verdict.
  { keys: ["vo2max", "vo2 max", "vo₂max"], unit: "mL/kg/min", optimal: [42, 60], dir: "low", actionable: true, label: "VO2max" },
  { keys: ["resting heart rate", "resting hr", "rhr"], unit: "bpm", optimal: [40, 60], dir: "high", actionable: true, label: "Resting HR" },
  { keys: ["hrv", "heart rate variability", "rmssd"], unit: "ms", optimal: [50, 120], dir: "low", actionable: true, label: "HRV" },
];

export function matchOptimalZone(name: string): OptimalZone | null {
  const n = String(name ?? "").toLowerCase();
  // Prefer the most specific (longest key) match so "non-hdl" doesn't read as "hdl".
  let best: OptimalZone | null = null;
  let bestLen = 0;
  for (const z of OPTIMAL_ZONES) {
    for (const k of z.keys) {
      if (n.includes(k) && k.length > bestLen) { best = z; bestLen = k.length; }
    }
  }
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

// Impact-Score ranking over the latest marker readings. Returns the same marker
// objects as getMarkerHistory plus { optimal, distance, in_optimal, actionable,
// impact_score } — most-actionable, furthest-from-optimal first. `flagged_count`
// counts markers the lab flagged low/high. Red-first stays the top-level sort
// (any low/high-flagged marker outranks an in-flag one); within each tier the
// Impact-Score orders most-actionable first.
//
// impact_score is an INTERNAL ordering signal ONLY — never surface it to the
// user as a 0-100 grade (the constitution bans those). The UI shows optimal-zone
// framing (in/out of optimal, the direction), never the number.
// Wearable-derived endurance/fitness markers (v35) as TRENDING marker series, so
// VO2max / resting HR / HRV flow into the SAME connected-brain surfaces as labs
// (priority ranking, trend, forecast, directives) — optimal-ZONE framing only,
// never a score. Built deterministically from the recovery tables: VO2max + a
// distinct daily resting-HR / HRV reading per day (most recent N days). Returns
// marker objects shaped exactly like getMarkerHistory's (key/name/unit/group/
// latest/prev/trend/forecast/points) so prioritizeMarkers can treat them uniformly.
// Empty when there's no wearable data — never throws.
function wearableFitnessMarkers(days = 120): any[] {
  const since = new Date(Date.now() - Math.max(1, days - 1) * 864e5).toISOString().slice(0, 10);
  // Each spec: the marker label + the daily-metrics column it reads (Garmin
  // preferred, daily_metrics fallback), and a sane plausibility clamp.
  const specs: { label: string; gCol: string; oCol: string | null; unit: string; lo: number; hi: number }[] = [
    { label: "VO2max", gCol: "vo2max", oCol: null, unit: "mL/kg/min", lo: 15, hi: 90 },
    { label: "Resting HR", gCol: "resting_hr", oCol: "resting_hr", unit: "bpm", lo: 25, hi: 120 },
    { label: "HRV", gCol: "hrv_ms", oCol: "hrv_ms", unit: "ms", lo: 5, hi: 300 },
  ];
  const out: any[] = [];
  for (const spec of specs) {
    // One reading per day: prefer Garmin's value, else the source-agnostic one.
    const byDate = new Map<string, number>();
    const g = db.prepare(
      `SELECT date, ${spec.gCol} AS v FROM garmin_daily_metrics WHERE date >= ? AND ${spec.gCol} IS NOT NULL ORDER BY date`
    ).all(since) as any[];
    for (const r of g) {
      const v = Number(r.v);
      if (Number.isFinite(v) && v >= spec.lo && v <= spec.hi) byDate.set(String(r.date), v);
    }
    if (spec.oCol) {
      const o = db.prepare(
        `SELECT date, ${spec.oCol} AS v FROM daily_metrics WHERE date >= ? AND ${spec.oCol} IS NOT NULL ORDER BY date`
      ).all(since) as any[];
      for (const r of o) {
        const date = String(r.date);
        if (byDate.has(date)) continue; // Garmin already supplied this day
        const v = Number(r.v);
        if (Number.isFinite(v) && v >= spec.lo && v <= spec.hi) byDate.set(date, v);
      }
    }
    if (!byDate.size) continue;
    const points = [...byDate.entries()]
      .map(([date, value]) => ({ date, value: Math.round(value * 10) / 10, flag: null as null, doc_id: null as null }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const last = points[points.length - 1];
    const before = points.length > 1 ? points[points.length - 2] : null;
    const zone = matchOptimalZone(spec.label);
    const slope = lsqSlopePerDay(points);
    const n = points.length;
    let trend: any;
    if (n < 2) {
      trend = { dir: null, change: null, span_days: null, n, slope_per_week: null, projection: null };
    } else {
      const change = Math.round((last.value - points[0].value) * 100) / 100;
      const vals = points.map((p) => p.value);
      const range = Math.max(...vals) - Math.min(...vals);
      const span_days = Math.round((Date.parse(last.date) - Date.parse(points[0].date)) / 864e5) || 0;
      const weekly = slope != null ? slope * 7 : null;
      const projectedMove = slope != null ? Math.abs(slope) * Math.max(1, span_days) : 0;
      const dir = weekly == null
        ? (range > 0 && Math.abs(change) < range * 0.05 ? "stable" : change > 0 ? "rising" : change < 0 ? "falling" : "stable")
        : projectedMove < Math.max(range * 0.05, 1e-9) ? "stable" : weekly > 0 ? "rising" : weekly < 0 ? "falling" : "stable";
      const fc = forecastMarker(points, slope, zone);
      trend = { dir, change, span_days, n, slope_per_week: weekly == null ? null : Math.round(weekly * 1000) / 1000, projection: fc.eta_text };
    }
    const grp = markerGroup(spec.label);
    out.push({
      key: spec.label.toLowerCase(),
      name: spec.label,
      unit: spec.unit,
      group: grp.key,
      group_label: grp.label,
      source: "wearable", // provenance hint — these are device-derived, not a lab draw
      latest: { value: last.value, flag: null, date: last.date, doc_id: null, kind: "wearable" },
      prev: before ? { value: before.value, date: before.date } : null,
      trend,
      forecast: forecastMarker(points, slope, zone),
      points,
    });
  }
  return out;
}

export function prioritizeMarkers() {
  const { markers: labMarkers } = getMarkerHistory();
  // Fold in wearable fitness markers (VO2max/RHR/HRV) — a LAB reading of the same
  // marker always wins (a blood/test draw supersedes a device estimate).
  const haveKey = new Set(labMarkers.map((m: any) => String(m?.key ?? "").toLowerCase()));
  const wearable = wearableFitnessMarkers().filter((m) => !haveKey.has(m.key));
  const markers = [...labMarkers, ...wearable];
  let flagged_count = 0;
  const enriched = markers.map((m: any) => {
    const flagged = m?.latest?.flag === "low" || m?.latest?.flag === "high";
    if (flagged) flagged_count++;
    const z = matchOptimalZone(m?.name);
    const numericVal = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
    const hasNum = Number.isFinite(numericVal);
    let distance = 0;
    let in_optimal: boolean | null = null;
    let optimal: { low: number; high: number; dir: string } | null = null;
    if (z) {
      optimal = { low: z.optimal[0], high: z.optimal[1], dir: z.dir };
      if (hasNum) {
        distance = optimalDistance(numericVal, z);
        in_optimal = distance === 0;
      }
    }
    const actionable = z ? z.actionable : false;
    // TRAJECTORY boost: a marker HEADING the wrong way matters more than one
    // sitting stably borderline. The forecast (from getMarkerHistory, vs the
    // OPTIMAL band) tells us direction + whether it's projected to cross an edge,
    // and eta_weeks (INTERNAL only — never surfaced) sharpens "how soon".
    const fc: any = m?.forecast ?? {};
    let trajectory = 0;
    if (fc.direction === "worsening") {
      // Worsening always counts; a near-term projected crossing (within ~12 weeks)
      // out of — or further from — optimal is the strongest pull.
      trajectory = 0.35;
      if (fc.crossing === "leaving") trajectory = 0.7; // inside now, projected to exit optimal
    } else if (fc.direction === "improving") {
      // Genuinely improving earns a small discount — it needs less attention.
      trajectory = -0.15;
    }
    // Impact-Score: distance from optimal (the real signal) weighted up when we
    // have a lever for it, a floor from the lab's own flag, and the trajectory
    // nudge so a marker drifting the wrong way outranks a stable borderline one.
    const impact_score = Math.max(0, distance * (actionable ? 1 : 0.55) + (flagged ? 0.5 : 0) + trajectory);
    return { ...m, optimal, distance, in_optimal, actionable, impact_score };
  });

  enriched.sort((a: any, b: any) => {
    const af = a?.latest?.flag === "low" || a?.latest?.flag === "high" ? 0 : 1;
    const bf = b?.latest?.flag === "low" || b?.latest?.flag === "high" ? 0 : 1;
    if (af !== bf) return af - bf;
    if (b.impact_score !== a.impact_score) return b.impact_score - a.impact_score;
    if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    return String(a?.name ?? "").localeCompare(String(b?.name ?? ""));
  });

  // enriched carries group/group_label/trend via `...m` from getMarkerHistory;
  // recompute the present-groups list in canonical order off the enriched set.
  // Strip the INTERNAL impact_score before it crosses the API/MCP boundary — it's
  // an ordering signal only, NEVER a user-facing grade (constitution: no scores).
  // Mirrors the eta_weeks→eta_text discipline used by getMarkerHistory.
  const publicMarkers = enriched.map(({ impact_score, ...rest }: any) => rest);
  return { flagged_count, markers: publicMarkers, groups: presentGroups(publicMarkers) };
}

// ---------- FHIR-inspired structured health export (F4) ----------
// A pragmatic, self-describing JSON summary of the athlete's health markers over
// time (plus the understood supplement regimen and active connected-brain
// directives) — something to hand a physician or another tool. NOT a real FHIR
// Bundle (no dependency, no full resource graph): a hand-rolled, Observation-like
// shape that's familiar to anyone who's seen FHIR, but readable on its own.
//
// Read-only / serialization: it assembles from the SAME marker history the app
// already derives (getMarkerHistory + prioritizeMarkers + OPTIMAL_ZONES). One
// Observation record per marker (the latest reading) carries every historical
// reading under `history[]`, the optimal band, an optimal-zone status (in/out +
// which direction is worse), and the deterministic trend. CONSTITUTION: no 0-100
// score anywhere — `status` is optimal-zone framing, never a grade; the internal
// impact_score never crosses this boundary (prioritizeMarkers already strips it).
export const HEALTH_EXPORT_VERSION = 1;

// Optimal-zone status for one marker, in plain FHIR-ish words. `interpretation`
// mirrors FHIR's interpretation concept loosely: "within-optimal" or, when out,
// the direction that's worse ("above-optimal"/"below-optimal"). `null` zone →
// "no-optimal-reference" (we track the trend but have no target band for it).
function exportOptimalStatus(m: any): {
  interpretation: string;
  inOptimal: boolean | null;
  worseDirection: "high" | "low" | "band" | null;
} {
  const o = m?.optimal; // {low, high, dir} from prioritizeMarkers, or null
  if (!o) return { interpretation: "no-optimal-reference", inOptimal: null, worseDirection: null };
  if (m.in_optimal === true) return { interpretation: "within-optimal", inOptimal: true, worseDirection: o.dir ?? null };
  if (m.in_optimal === false) {
    const num = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
    // Which side it fell on (only meaningful when out of optimal + numeric).
    let side: string = o.dir ?? "band";
    if (Number.isFinite(num)) {
      if (num > o.high) side = "above-optimal";
      else if (num < o.low) side = "below-optimal";
      else side = "outside-optimal";
    } else {
      side = o.dir === "high" ? "above-optimal" : o.dir === "low" ? "below-optimal" : "outside-optimal";
    }
    return { interpretation: side, inOptimal: false, worseDirection: o.dir ?? null };
  }
  // Zone exists but value wasn't numeric → can't place it.
  return { interpretation: "indeterminate", inOptimal: null, worseDirection: o.dir ?? null };
}

export function buildHealthExport() {
  const profile = getProfile() || {};
  // prioritizeMarkers is the superset: per-marker latest + full points[] history +
  // optimal band + in_optimal + group + trend + forecast (impact_score stripped).
  const { markers, groups, flagged_count } = prioritizeMarkers();

  const observations = markers.map((m: any) => {
    const status = exportOptimalStatus(m);
    // Every historical reading as a tiny Observation-component (ascending by date).
    const history = (Array.isArray(m.points) ? m.points : [])
      .map((p: any) => ({
        effectiveDate: p.date,
        value: p.value,
        flag: p.flag ?? null, // the lab's own low/normal/high flag, when present
      }));
    const t = m.trend || {};
    return {
      // Observation-like identity.
      name: m.name,
      key: m.key,
      category: m.group || "other",
      categoryLabel: m.group_label || "Other Markers",
      // The latest reading (FHIR "valueQuantity" + "effectiveDateTime").
      value: m.latest?.value ?? null,
      unit: m.unit ?? null,
      effectiveDate: m.latest?.date ?? null,
      // The lab's own reference flag (low/normal/high) for the latest reading.
      labFlag: m.latest?.flag ?? null,
      // Optimal-zone reference band (DISTINCT from the lab's population range) +
      // the optimal-zone interpretation. Informational; never a numeric grade.
      optimalRange: m.optimal ? { low: m.optimal.low, high: m.optimal.high, worseDirection: m.optimal.dir } : null,
      status: status.interpretation,
      inOptimal: status.inOptimal,
      // Deterministic trend across the whole series + the plain-language forecast.
      trend: {
        direction: t.dir ?? null,
        change: t.change ?? null,
        spanDays: t.span_days ?? null,
        readings: t.n ?? history.length,
        projection: t.projection ?? null, // words, never a score
      },
      history,
    };
  });

  // Understood supplement regimen (active only) — typical-dose approximations,
  // never a prescription; carried so a physician sees what the athlete takes.
  const supplements = listSupplements({ activeOnly: true }).map((s: any) => ({
    name: s.name,
    dose: s.dose ?? null,
    frequency: s.frequency ?? null,
    category: s.category ?? null,
    relatedMarkers: Array.isArray(s.related_markers) ? s.related_markers : [],
    note: s.note ?? null,
  }));

  // Active connected-brain directives (the cross-domain consequences of a flagged
  // marker). INFORMATIONAL; `uncertain` marks a real-but-unsettled lever.
  const directives = listActiveDirectives().map((d: any) => ({
    domain: d.domain,
    marker: d.marker ?? null,
    directive: d.directive ?? null,
    rationale: d.rationale ?? null,
    citation: d.citation ?? null,
    uncertain: !!d.uncertain,
  }));

  // A compact body-composition slice surfaced separately (it's the "body" marker
  // group — body fat %, lean mass, BMD, visceral, …). The same rows are in
  // `observations`; this is a convenience pointer, not a duplicate source.
  const bodyComposition = observations
    .filter((o: any) => o.category === "body")
    .map((o: any) => ({ name: o.name, value: o.value, unit: o.unit, effectiveDate: o.effectiveDate, trend: o.trend.direction }));

  return {
    // Self-describing metadata header (FHIR-ish Bundle-meta, hand-rolled).
    meta: {
      resourceType: "CairnHealthSummary",
      format: "fhir-inspired",
      profile: "https://cairn.health/health-export",
      exportVersion: HEALTH_EXPORT_VERSION,
      generated: new Date().toISOString(),
      generatedFrom: "cairn",
      note: "Optimal-zone bands are evidence-anchored longevity/preventive targets, DISTINCT from a lab's population reference interval. Informational, not medical advice. No 0-100 scores.",
      subject: {
        sex: profile.sex ?? null,
        age: profile.age ?? null,
        heightCm: profile.height_cm ?? null,
        weightLb: profile.weight_lb ?? null,
      },
    },
    summary: {
      markerCount: observations.length,
      flaggedCount: flagged_count, // markers the lab flagged low/high (count, not a grade)
      categories: Array.isArray(groups) ? groups : [],
    },
    observations,
    bodyComposition,
    supplements,
    directives,
  };
}

// ---------- the propagation engine: derive cross-domain directives (T4) ----------
// A single mapping from a flagged/sub-optimal marker to the domains it touches.
// `when(value, flag)` decides whether this marker currently warrants directives;
// `derive` returns the per-domain rows. citation is filled where the lever is a
// well-established guideline; left null (with uncertain:true) where the mapping
// is real but not settled, so the user/coach sees it flagged research-recommended.
interface MappingDirective { key?: string; domain: "nutrition" | "training" | "watch"; directive: string; rationale: string; citation?: string | null; uncertain?: boolean; }
interface MarkerContext { value: number; flag: string | null; zone: OptimalZone; side: "low" | "high" | "unknown"; marker: any; }
interface MarkerMapping {
  zone: string;            // OPTIMAL_ZONES label this keys off
  derive: (ctx: MarkerContext) => MappingDirective[];
}

// Helper: a value is "actionably off" when it's flagged low/high OR sits outside
// its optimal band the worse way.
function offOptimal(value: number, zoneLabel: string, flag: string | null): boolean {
  if (flag === "low" || flag === "high") return true;
  const z = OPTIMAL_ZONES.find((x) => x.label === zoneLabel);
  if (!z || !Number.isFinite(value)) return false;
  return optimalDistance(value, z) > 0;
}

export function markerSide(value: number, zone: OptimalZone, flag: string | null): MarkerContext["side"] {
  if (flag === "low" || flag === "high") return flag;
  if (!Number.isFinite(value)) return "unknown";
  if (value < zone.optimal[0]) return "low";
  if (value > zone.optimal[1]) return "high";
  return "unknown";
}

function mappingDirectiveKey(zoneLabel: string, d: MappingDirective): string | null {
  return normalizeDirectiveKey(`${zoneLabel}:${d.domain}:${d.key || d.directive}`);
}

function lastDirectiveFeedback(source: string, marker: string | null, domain: string, directiveKey: string | null) {
  if (!directiveKey) return null;
  return hydrateDirective(db.prepare(
    `SELECT * FROM health_directives
     WHERE source = ? AND (marker = ? OR (marker IS NULL AND ? IS NULL)) AND domain = ? AND directive_key = ?
       AND status IN ('resolved', 'dismissed')
       AND status_at IS NOT NULL
     ORDER BY COALESCE(status_at, created_at) DESC, id DESC
     LIMIT 1`
  ).get(source, marker, marker, domain, directiveKey) ?? null);
}

function overageForSide(value: number, zone: OptimalZone, side: MarkerContext["side"]): number {
  if (!Number.isFinite(value)) return 0;
  if (side === "low") return Math.max(0, zone.optimal[0] - value);
  if (side === "high") return Math.max(0, value - zone.optimal[1]);
  return optimalDistance(value, zone) * Math.max(zone.optimal[1] - zone.optimal[0], 1) * 3;
}

function markerMateriallyWorse(feedback: any, ctx: MarkerContext): boolean {
  if (!feedback) return false;
  const oldSide = String(feedback.trigger_side || "unknown");
  if (oldSide !== ctx.side) return true;
  const oldValue = Number(feedback.trigger_value);
  if (!Number.isFinite(oldValue)) return true;
  const width = Math.max(ctx.zone.optimal[1] - ctx.zone.optimal[0], 1);
  const oldOver = overageForSide(oldValue, ctx.zone, ctx.side);
  const newOver = overageForSide(ctx.value, ctx.zone, ctx.side);
  const threshold = Math.max(width * 0.1, Math.abs(oldValue) * 0.05, 1);
  return newOver > oldOver + threshold;
}

function shouldSuppressDirective(feedback: any, ctx: MarkerContext): boolean {
  if (!feedback) return false;
  if (feedback.status === "dismissed") return !markerMateriallyWorse(feedback, ctx);
  if (feedback.status === "resolved") {
    const oldDate = String(feedback.trigger_date || "");
    const newDate = String(ctx.marker?.latest?.date || "");
    return !newDate || oldDate === newDate;
  }
  return false;
}

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
];

// THE PROPAGATION ENGINE. A flagged/sub-optimal biomarker propagates into every
// domain it touches — nutrition, training and watch — grounded in reputable
// guideline citations where the lever is well-established, flagged uncertain
// (citation null) where the mapping is real but not settled. Idempotent: clears
// the 'markers' source then re-derives, so directives never pile up across runs.
// Leaves the 'health_review' source untouched. INFORMATIONAL, not medical advice.
// Return shape kept as { source:'markers', derived, directives } for back-compat.
export function deriveDirectives() {
  const SOURCE = "markers";
  clearDirectivesForSource(SOURCE);
  const { markers } = prioritizeMarkers();
  let saved = 0;
  // Collect every off-optimal marker as we go — the cluster layer (below) reads
  // this to make markers COMPOUND into one read instead of firing in isolation.
  const offMarkers = new Map<string, MarkerContext>();
  // Dedup within the run: the SAME zone can be reached by several marker entries
  // (name variants like "Glucose" / "Fasting Glucose", or repeat lab rows), which
  // would otherwise emit the identical directive once per entry. A directive is
  // about the zone+domain, so the first (highest-priority) one wins; the rest are
  // skipped. markers are sorted flagged-first then impact-desc, so first == most
  // significant.
  const seen = new Set<string>();
  for (const m of markers) {
    const z = matchOptimalZone(m?.name);
    if (!z) continue;
    const numericVal = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
    if (!Number.isFinite(numericVal)) continue;
    const flag: string | null = m?.latest?.flag === "low" || m?.latest?.flag === "high" ? m.latest.flag : null;
    if (!offOptimal(numericVal, z.label, flag)) continue;
    const ctx: MarkerContext = { value: numericVal, flag, zone: z, side: markerSide(numericVal, z, flag), marker: m };
    if (!offMarkers.has(z.label)) offMarkers.set(z.label, ctx);
    const mapping = MARKER_MAPPINGS.find((x) => x.zone === z.label);
    if (!mapping) continue;
    for (const d of mapping.derive(ctx)) {
      const directive_key = mappingDirectiveKey(z.label, d);
      if (directive_key && seen.has(directive_key)) continue; // already emitted this zone+domain directive this run
      const feedback = lastDirectiveFeedback(SOURCE, z.label, d.domain, directive_key);
      if (shouldSuppressDirective(feedback, ctx)) continue;
      const row = addDirective({
        source: SOURCE,
        domain: d.domain,
        marker: z.label,
        directive_key,
        directive: d.directive,
        rationale: d.rationale,
        citation: d.citation ?? null,
        uncertain: d.uncertain || !d.citation,
        trigger_value: numericVal,
        trigger_side: ctx.side,
        trigger_date: m?.latest?.date ?? null,
        resurfaced_from_id: feedback?.id ?? null,
        status: "active",
      });
      if (row) { saved++; if (directive_key) seen.add(directive_key); }
    }
  }

  // ---- cross-marker synthesis (the cluster layer) ----
  // Some findings only make sense TOGETHER: ApoB + Lp(a) + hs-CRP is one
  // elevated-cardiovascular-risk story, not three; low ferritin + low hemoglobin
  // + a low/altered MCV is an anemia PATTERN, not three loose flags. These fire
  // ONE synthesized directive when the cluster is genuinely present, so the brain
  // reasons across markers instead of repeating itself. Still INFORMATIONAL.
  saved += deriveMarkerClusters(SOURCE, offMarkers, seen);

  return { source: SOURCE, derived: saved, directives: listActiveDirectives() };
}

// Cluster definitions: each names the off-optimal zones (and required sides) that
// together tell one story, plus the synthesized directive. Fires only when the
// cluster's threshold of members is met. The directive_key is namespaced
// ("cluster:<name>:<domain>") so the feedback/suppression machinery treats it
// like any other directive (Done/Dismiss memory still works).
interface MarkerCluster {
  name: string;
  // members: zone label → the side that counts toward the cluster (null = any off side)
  members: { label: string; side?: "low" | "high" }[];
  minHits: number;
  build: (hits: { label: string; ctx: MarkerContext }[]) => MappingDirective[];
}

const MARKER_CLUSTERS: MarkerCluster[] = [
  {
    name: "elevated-cardiovascular-risk",
    members: [
      { label: "ApoB", side: "high" },
      { label: "LDL-C", side: "high" },
      { label: "Non-HDL-C", side: "high" },
      { label: "Lp(a)", side: "high" },
      { label: "hs-CRP", side: "high" },
      { label: "Triglycerides", side: "high" },
    ],
    minHits: 2,
    build: (hits) => {
      const names = hits.map((h) => h.label).join(" + ");
      const hasLpa = hits.some((h) => h.label === "Lp(a)");
      const lpaNote = hasLpa
        ? " Lp(a) is largely genetic and won't move with diet, which makes pushing the modifiable markers (ApoB/LDL) toward optimal matter even more."
        : "";
      return [
        { domain: "watch", directive: `Several cardiovascular markers are elevated together (${names}) — read as one elevated-risk picture, not separate flags. This is the highest-leverage area to address; discuss the combined picture with your doctor.${lpaNote}`, rationale: "Multiple atherogenic / inflammatory markers off-optimal at once compound cardiovascular risk beyond any single value.", citation: "ACC/AHA 2018 Cholesterol Guideline; ESC/EAS 2019 Dyslipidaemia" },
        { domain: "nutrition", directive: "Because several heart markers are elevated together, make the lipid-lowering pattern the priority: cut saturated fat, raise soluble fiber (oats, legumes, psyllium), favor oily fish and olive oil, and trim refined carbs/alcohol.", rationale: "One coherent anti-atherogenic, anti-inflammatory dietary pattern moves this whole cluster at once.", citation: "ACC/AHA 2018 Cholesterol Guideline" },
        { domain: "training", directive: "Keep regular aerobic work in the week — it helps the whole cardiovascular cluster (lipids, inflammation, blood pressure) at once.", rationale: "Aerobic exercise is a shared lever across the atherogenic/inflammatory markers in this cluster.", citation: "ACC/AHA 2018 Cholesterol Guideline", uncertain: true },
      ];
    },
  },
  // The anemia PATTERN (ferritin + hemoglobin + MCV) needs cross-marker reads
  // that aren't all in OPTIMAL_ZONES, so it's handled by buildAnemiaCluster()
  // rather than this declarative table.
];

function deriveMarkerClusters(source: string, offMarkers: Map<string, MarkerContext>, seen: Set<string> = new Set()): number {
  let saved = 0;
  // anemia pattern needs cross-marker reads (hemoglobin / MCV) that aren't all in
  // OPTIMAL_ZONES, so handle it specially off the marker history rather than the
  // off-optimal map alone.
  const anemia = buildAnemiaCluster(offMarkers);
  const clusters: { name: string; directives: MappingDirective[]; markerLabel: string; ctx: MarkerContext }[] = [];

  for (const c of MARKER_CLUSTERS) {
    const hits = c.members
      .map((mem) => {
        const ctx = offMarkers.get(mem.label);
        if (!ctx) return null;
        if (mem.side && ctx.side !== mem.side) return null;
        return { label: mem.label, ctx };
      })
      .filter(Boolean) as { label: string; ctx: MarkerContext }[];
    if (hits.length < c.minHits) continue;
    clusters.push({ name: c.name, directives: c.build(hits), markerLabel: hits.map((h) => h.label).join("+"), ctx: hits[0].ctx });
  }
  if (anemia) clusters.push(anemia);

  for (const cl of clusters) {
    for (const d of cl.directives) {
      const directive_key = normalizeDirectiveKey(`cluster:${cl.name}:${d.domain}:${d.key || d.directive}`);
      if (directive_key && seen.has(directive_key)) continue; // already emitted this cluster directive this run
      const feedback = lastDirectiveFeedback(source, cl.markerLabel, d.domain, directive_key);
      if (shouldSuppressDirective(feedback, cl.ctx)) continue;
      const row = addDirective({
        source,
        domain: d.domain,
        marker: cl.markerLabel,
        directive_key,
        directive: d.directive,
        rationale: d.rationale,
        citation: d.citation ?? null,
        uncertain: d.uncertain || !d.citation,
        trigger_value: cl.ctx.value,
        trigger_side: cl.ctx.side,
        trigger_date: cl.ctx.marker?.latest?.date ?? null,
        resurfaced_from_id: feedback?.id ?? null,
        status: "active",
      });
      if (row) { saved++; if (directive_key) seen.add(directive_key); }
    }
  }
  return saved;
}

// Anemia is a PATTERN across iron + red-cell indices, not a single zone. Low
// ferritin (depleted stores) alongside low hemoglobin and/or a small MCV reads
// as iron-deficiency anemia; ferritin alone is just low stores. Reads hemoglobin
// & MCV from the full marker history (they aren't all in OPTIMAL_ZONES). Returns
// one synthesized cluster or null.
function buildAnemiaCluster(offMarkers: Map<string, MarkerContext>): { name: string; directives: MappingDirective[]; markerLabel: string; ctx: MarkerContext } | null {
  const ferritin = offMarkers.get("Ferritin");
  if (!ferritin || ferritin.side !== "low") return null;
  const { markers } = getMarkerHistory();
  const find = (re: RegExp) => markers.find((m: any) => re.test(String(m?.name ?? "").toLowerCase()));
  const hgbM = find(/\b(hemoglobin|haemoglobin|hgb|hb)\b/);
  const mcvM = find(/\bmcv\b|mean corpuscular volume/);
  const numOf = (m: any): number | null => {
    if (!m) return null;
    const v = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
    return Number.isFinite(v) ? v : null;
  };
  const hgbLow = hgbM?.latest?.flag === "low" || (numOf(hgbM) != null && (numOf(hgbM) as number) < 13.0);
  const mcvVal = numOf(mcvM);
  const mcvLow = mcvM?.latest?.flag === "low" || (mcvVal != null && mcvVal < 80);
  // Genuine pattern: low ferritin PLUS (low hemoglobin OR a small/low MCV).
  if (!hgbLow && !mcvLow) return null;
  const bits = ["low ferritin"];
  if (hgbLow) bits.push("low hemoglobin");
  if (mcvLow) bits.push("low MCV");
  const directives: MappingDirective[] = [
    { domain: "watch", directive: `These read together as an iron-deficiency anemia pattern (${bits.join(" + ")}), not separate flags — confirm with iron studies / a full CBC and discuss iron repletion with your doctor before training hard through it.`, rationale: "Low ferritin with low hemoglobin and/or a small MCV is the classic iron-deficiency anemia signature, which needs confirmation and repletion.", citation: "WHO 2020 Ferritin Guideline; BSH iron-deficiency anemia guidance" },
    { domain: "training", directive: "While this anemia pattern is present, hold endurance volume and keep easy days genuinely easy — oxygen transport is limited until iron and hemoglobin recover.", rationale: "Iron and hemoglobin are rate-limiting for oxygen delivery; hard training on an anemia pattern impairs recovery and adaptation.", citation: "IOC consensus on iron in athletes" },
    { domain: "nutrition", directive: "Pair iron-rich foods (red meat, lentils, spinach) with vitamin C, keep tea/coffee away from iron-rich meals, and follow your doctor's guidance on supplemental iron.", rationale: "Dietary and supplemental iron, with absorption-friendly pairing, repletes stores when clinically appropriate.", citation: "WHO 2020 Ferritin Guideline" },
  ];
  return { name: "anemia-pattern", directives, markerLabel: bits.join("+"), ctx: ferritin };
}

// Persist the agent-emitted directives carried on a saved health review. Stored
// under the 'health_review' source so they coexist with the deterministic
// 'markers' directives — each review save clears & rewrites only its own source.
// Never auto-applies anything; this is the review side of propose-review-apply
// for the clinical layer.
export function applyReviewDirectives(directives: any[]) {
  // Replace the health_review directive set with this list (clear + rewrite).
  // An explicit empty array legitimately means "this review flagged nothing now"
  // and SHOULD clear stale directives. The CALLER (addHealthReview) gates this so
  // it's only invoked when the agent actually addressed directives — an ABSENT
  // field (partial / old-shape response) preserves the prior set instead.
  clearDirectivesForSource("health_review");
  const list = Array.isArray(directives) ? directives : [];
  // Loop-invariant: the safety context is a full marker snapshot (scans + parses
  // every health-doc blob). Build it ONCE, not once per directive.
  const safetyCtx = buildSafetyMarkerContext();
  let count = 0;
  for (const d of list) {
    if (!d || typeof d !== "object") continue;
    const domain = DIRECTIVE_DOMAINS.has(String(d.domain)) ? String(d.domain) : "watch";
    const marker = d.marker == null || String(d.marker).trim() === "" ? null : String(d.marker).trim().slice(0, 60);
    const directive = d.directive == null ? null : String(d.directive).trim().slice(0, 600) || null;
    const directive_key = defaultDirectiveKey(marker, domain, directive);
    const feedback = lastDirectiveFeedback("health_review", marker, domain, directive_key);
    if (feedback) continue;
    // Citation verification (Stream 4 — grounding): a medical system must not
    // surface an unverified citation. An agent-emitted citation is accepted only
    // when it matches a recognized guideline body OR a cached evidence_cache row;
    // otherwise the unverifiable string is STRIPPED and the directive downgraded
    // to uncertain (a softer nudge). The directive itself is never dropped.
    const verified = verifyCitation(d.citation ?? null, d.source_url ?? null);
    // Supplement / interaction safety gate: annotate (never block) a supplement
    // suggestion the user's markers contraindicate (e.g. iron with replete ferritin).
    const safe = safetyGate(
      { domain, marker, directive, rationale: d.rationale ?? null },
      safetyCtx
    );
    const row = addDirective({
      source: "health_review",
      domain,
      marker,
      directive_key,
      directive: safe.directive,
      rationale: safe.rationale,
      citation: verified.citation,
      uncertain: verified.uncertain || safe.uncertain,
      status: "active",
    });
    if (row) count++;
  }
  return count;
}

// Active health directives condensed for the coach: domain + plain-language
// guidance (with its marker, citation and uncertain flag). INFORMATIONAL, not
// medical advice — the coach folds nutrition/training directives into plans and
// surfaces 'watch' items, never treats them as orders. Bounded.
export function directivesForCoach() {
  return listActiveDirectives().slice(0, 24).map((d: any) => ({
    domain: d.domain,
    marker: d.marker,
    directive: d.directive,
    rationale: d.rationale,
    citation: d.citation,
    uncertain: d.uncertain,
    directive_key: d.directive_key,
    trigger_value: d.trigger_value,
    trigger_side: d.trigger_side,
    trigger_date: d.trigger_date,
  }));
}

// ============================================================================
// HEALTH FOCUS — the prioritization/synthesis substrate (elite-coach layer).
// The propagation engine emits one directive per (marker × domain); on a real
// panel that's 30+ flat items — a flood, not coaching. healthFocus() collapses
// them into a handful of TIERED, deduped, connected priorities: each health
// "story" (a marker group) with its tier (act now / track / maintain-ish), the
// markers driving it, and the LEAD move per domain. Deterministic, no scores —
// the tier is plain words, the order is the priority. This is what the Brain view
// renders and what the agentic health-story synthesis reasons over.
// ============================================================================
export type FocusTier = "act_now" | "track";
export interface FocusReading {
  name: string;
  value: number | string | null;
  unit: string | null;
  flag: string | null;            // lab flag (low/high) or null
  optimal: [number, number] | null; // evidence-based optimal band
  in_optimal: boolean | null;
  trend: string | null;           // rising/falling/stable
  projection: string | null;      // plain-language forecast vs optimal
}
export interface FocusPriority {
  group: string;                 // group label, e.g. "Lipids & Cardiovascular"
  tier: FocusTier;
  markers: string[];             // off-optimal marker names in this group, priority order
  readings: FocusReading[];      // the QUANTITATIVE detail (value/band/trend) — so the synthesis reasons on numbers, not names
  flagged: boolean;              // the lab itself flagged one low/high
  compounding: boolean;          // ≥2 markers off here (or a cross-marker cluster directive)
  worsening: boolean;            // a marker in this group is trending the wrong way
  moves: { nutrition?: string; training?: string; watch?: string }; // the LEAD directive per domain
  uncertain: boolean;            // the levers here are real-but-unsettled (softer nudge)
  why: string;                   // one plain clause
}
export interface HealthFocus {
  priorities: FocusPriority[];   // act_now first, then track; deduped to one per group
  act_now: number;
  track: number;
  headline: string;              // deterministic plain lead ("Lipids are the priority right now")
}

export function healthFocus(): HealthFocus {
  const { markers } = prioritizeMarkers(); // ordered: flagged-first then furthest-from-optimal
  // Off-optimal markers, in priority order, bucketed by health group (preserving rank).
  const groups = new Map<string, { markers: any[]; rank: number }>();
  markers.forEach((m: any, i: number) => {
    if (m?.in_optimal !== false) return; // only out-of-optimal concerns (null/true skipped)
    const label = m.group_label || markerGroup(m?.name || "").label;
    if (!groups.has(label)) groups.set(label, { markers: [], rank: i });
    groups.get(label)!.markers.push(m);
  });

  // The active directives, bucketed to the same groups, so each priority carries
  // the lead actionable move per domain (a non-uncertain one wins over uncertain).
  const dirByGroup = new Map<string, any[]>();
  for (const d of listActiveDirectives() as any[]) {
    const label = markerGroup(String(d.marker || "")).label;
    if (!dirByGroup.has(label)) dirByGroup.set(label, []);
    dirByGroup.get(label)!.push(d);
  }
  const leadMove = (dirs: any[], domain: string): { text?: string; uncertain: boolean } => {
    const inDomain = dirs.filter((d) => d.domain === domain);
    if (!inDomain.length) return { uncertain: false };
    const lead = inDomain.find((d) => !d.uncertain) || inDomain[0];
    return { text: String(lead.directive || "").trim().slice(0, 240), uncertain: !!lead.uncertain };
  };

  const priorities: FocusPriority[] = [];
  for (const [label, { markers: ms, rank }] of groups) {
    const dirs = dirByGroup.get(label) || [];
    const flagged = ms.some((m) => m?.latest?.flag === "low" || m?.latest?.flag === "high");
    const compounding = ms.length >= 2 || dirs.some((d) => String(d.marker || "").includes("+"));
    const worsening = ms.some((m) => m?.forecast?.direction === "worsening");
    const maxDistance = ms.reduce((mx, m) => Math.max(mx, Number(m?.distance) || 0), 0);
    // Tier score — flagged + compounding + how far out + worsening + near the top
    // of the panel's priority order. ≥3 ⇒ act now; else track.
    let score = 0;
    if (flagged) score += 2;
    if (compounding) score += 2;
    if (maxDistance >= 0.4) score += 2; else if (maxDistance >= 0.2) score += 1;
    if (worsening) score += 1;
    if (rank < 6) score += 1; // among the panel's most-pressing markers
    const tier: FocusTier = score >= 3 ? "act_now" : "track";

    const nut = leadMove(dirs, "nutrition");
    const trn = leadMove(dirs, "training");
    const wch = leadMove(dirs, "watch");
    const moves: FocusPriority["moves"] = {};
    if (nut.text) moves.nutrition = nut.text;
    if (trn.text) moves.training = trn.text;
    if (wch.text) moves.watch = wch.text;
    const anyActionable = !!(nut.text && !nut.uncertain) || !!(trn.text && !trn.uncertain);
    const uncertain = !anyActionable && (nut.uncertain || trn.uncertain || wch.uncertain);

    const why = compounding
      ? `${ms.length} markers off together here — read them as one picture`
      : flagged
        ? `the lab flagged ${ms[0]?.name}`
        : worsening
          ? `${ms[0]?.name} is drifting the wrong way`
          : `${ms[0]?.name} is outside its optimal band`;

    const readings: FocusReading[] = ms.slice(0, 4).map((m: any) => ({
      name: m.name,
      value: m?.latest?.value ?? null,
      unit: m.unit ?? null,
      flag: m?.latest?.flag ?? null,
      optimal: m.optimal ? [m.optimal.low, m.optimal.high] : null,
      in_optimal: m.in_optimal ?? null,
      trend: m?.trend?.dir ?? null,
      projection: m?.forecast?.eta_text ?? m?.trend?.projection ?? null,
    }));
    priorities.push({ group: label, tier, markers: ms.map((m) => m.name), readings, flagged, compounding, worsening, moves, uncertain, why });
  }

  // act_now first, then track; within a tier keep panel priority order (the Map
  // preserves first-seen rank, which is the marker order).
  priorities.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "act_now" ? -1 : 1));
  const actNow = priorities.filter((p) => p.tier === "act_now");
  const headline = actNow.length
    ? actNow.length === 1
      ? `${actNow[0].group} is the priority right now.`
      : `${actNow[0].group} and ${actNow[1].group.toLowerCase()} are the priorities right now.`
    : priorities.length
      ? "Nothing urgent — a few markers worth tracking."
      : "Your markers are reading clean.";

  return { priorities, act_now: actNow.length, track: priorities.length - actNow.length, headline };
}

// The latest agentic health-story synthesis (the elite-coach whole-picture read),
// cached in app_state so the Brain view opens instantly. coachOps.synthesizeHealth
// writes it; it's a pull artifact, refreshed on demand / when the picture changes.
const HEALTH_SYNTHESIS_KEY = "health_synthesis";
export function saveHealthSynthesis(obj: any): void {
  try { setAppState(HEALTH_SYNTHESIS_KEY, JSON.stringify(obj)); } catch { /* never block */ }
}
export function getHealthSynthesis(): any | null {
  const raw = getAppState(HEALTH_SYNTHESIS_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function directiveFeedbackForCoach(limit = 12) {
  return (db.prepare(
    `SELECT * FROM health_directives
     WHERE status IN ('resolved', 'dismissed')
       AND status_at IS NOT NULL
     ORDER BY COALESCE(status_at, created_at) DESC, id DESC
     LIMIT ?`
  ).all(limit) as any[]).map(hydrateDirective).map((d: any) => ({
    status: d.status,
    status_at: d.status_at || d.created_at,
    domain: d.domain,
    marker: d.marker,
    directive: d.directive,
    rationale: d.rationale,
    directive_key: d.directive_key,
    trigger_value: d.trigger_value,
    trigger_side: d.trigger_side,
    trigger_date: d.trigger_date,
  }));
}

// ============================================================================
// RESEARCH & GROUNDING (Stream 4). Three layers, all INFORMATIONAL not medical
// advice, all degrading to today's behavior when research is off / unavailable:
//   1. evidence_cache — a host-side store of cited claims (src/research.ts fills
//      it; the health review can inject the retrieved passages and cite them).
//   2. verifyCitation — a directive's citation is accepted only if it matches a
//      recognized guideline body OR a cached evidence row; else it's stripped and
//      the directive is downgraded to uncertain (closing the hallucination surface).
//   3. safetyGate — a curated rule set that annotates (never blocks) a supplement
//      suggestion the user's markers contraindicate.
// NOTE (clean-merge boundary): this layer is implemented as SEPARATE wrapper
// functions called from applyReviewDirectives / coachOps — it does NOT edit
// OPTIMAL_ZONES / MARKER_MAPPINGS / deriveDirectives (Stream 3's territory).
