import { db } from "../db.js";

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
  // ---- common long-tail, conservative marker links (only well-established ones) ----
  { keys: ["folate", "folic acid", "methylfolate", "l-methylfolate"], name: "Folate", dose: "400–800 mcg", frequency: "daily",
    category: "vitamin", markers: ["Folate", "Homocysteine"], note: "Red-cell formation and methylation; check B12 alongside it." },
  { keys: ["vitamin k2", "vit k2", "vitamin-k2", "mk-7", "mk7", "menaquinone", "vitamin k"], name: "Vitamin K2 (MK-7)",
    dose: "90–180 mcg", frequency: "daily", category: "vitamin", markers: [],
    note: "Directs calcium to bone; commonly paired with vitamin D3." },
  { keys: ["red yeast rice", "monacolin"], name: "Red yeast rice", dose: null, frequency: "daily", category: "cardiovascular",
    markers: ["LDL-C", "ApoB"], note: "Contains a natural statin (monacolin K) — treat like a lipid medication and tell your doctor." },
  { keys: ["plant sterol", "phytosterol", "stanol", "beta-sitosterol", "beta sitosterol"], name: "Plant sterols/stanols",
    dose: "2 g", frequency: "daily", category: "cardiovascular", markers: ["LDL-C"], note: "Blunt cholesterol absorption; modest LDL lever." },
  { keys: ["selenium"], name: "Selenium", dose: "100–200 mcg", frequency: "daily", category: "mineral", markers: [],
    note: "Thyroid and antioxidant cofactor; narrow safe range — don't megadose." },
  { keys: ["l-theanine", "l theanine", "theanine"], name: "L-theanine", dose: "100–200 mg", frequency: "as needed",
    category: "calm", markers: [], note: "Calm focus; smooths caffeine and can aid sleep." },
  { keys: ["glucosamine", "chondroitin"], name: "Glucosamine / chondroitin", dose: null, frequency: "daily", category: "joint",
    markers: [], note: "Joint comfort; evidence is mixed but it's well tolerated." },
  { keys: ["vitamin a", "retinol", "beta-carotene", "beta carotene"], name: "Vitamin A", dose: null, frequency: "daily",
    category: "vitamin", markers: [], note: "Vision and immune; fat-soluble, so don't stack high doses." },
  { keys: ["vitamin e", "tocopherol"], name: "Vitamin E", dose: null, frequency: "daily", category: "vitamin", markers: [],
    note: "Antioxidant; food-first, avoid high-dose isolated supplements." },
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
