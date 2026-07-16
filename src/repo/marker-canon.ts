// Marker-name canonicalization — the connected brain's analyte de-duplication.
//
// Different labs (and different panels from the same lab) name the same analyte
// differently: "Glucose (random)" vs "Glucose Random"; "Vitamin D" vs "25-OH
// Vitamin D"; "eGFR" vs "Creatinine-Based Estimated Glomerular Filtration Rate
// (eGFR)". getMarkerHistory keys a marker's time-series by its name, so without
// canonicalization these split one analyte's progress into parallel series — which
// is exactly the duplication a clinician (and the doctor report) sees.
//
// This mirrors src/art.ts's semantic-cache pattern (resolveConcept + art_aliases):
//   1. a deterministic NORMALIZER folds typographic variants — case, punctuation,
//      "(random)" vs "random" — that are unambiguously the same string of words.
//   2. a curated clinical KB folds well-established synonyms (Vitamin D ⇄ 25-OH,
//      eGFR ⇄ the long form, ALT ⇄ SGPT) — conservative on purpose: it NEVER
//      merges clinically-distinct measures (direct vs calculated LDL, random vs
//      fasting vs estimated-average glucose, free vs total testosterone).
//   3. the agentic reconciler (coachOps.reconcileMarkers) learns the harder
//      synonyms a new lab introduces and persists them in `marker_aliases`, so
//      each variant is resolved once and future labs self-align.
//
// canonicalMarker() resolves in that order (persisted alias → KB → normalized
// self) and is the single point getMarkerHistory keys on.

import { db } from "../db.js";
import { createAliasStore } from "./canon-aliases.js";
import { seriesUnitsCompatible } from "./lab-units.js";
import { bumpMarkerDataVersion } from "./marker-cache.js";

// Lowercase, fold every non-alphanumeric run to a single space, collapse + trim.
// "Glucose (random)" and "Glucose Random" → "glucose random" (a real merge);
// "Lp(a)" → "lp a"; "25-OH Vitamin D" → "25 oh vitamin d"; "LDL-C (direct)" →
// "ldl c direct" (stays distinct from "LDL-Cholesterol" — different method).
export function normalizeMarkerName(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface AliasEntry {
  key: string; // the merge key (short, stable) — chosen to preserve existing key tokens
  canonical: string; // the clean internal display name used after variants merge
  aliases: string[];
}

// Curated, CONSERVATIVE clinical synonym KB. `key` is the merge key all variants
// collapse onto (kept short + token-stable so existing key-based lookups still
// resolve); `aliases` are alternate names that mean the SAME analyte. Only
// well-established equivalences belong here — and NEVER clinically-distinct
// measures (direct vs calculated LDL, random vs fasting vs estimated-average
// glucose, free vs total testosterone). When in doubt, leave it out and let the
// agentic reconciler (which can read units + context) make the call.
const MARKER_ALIASES: AliasEntry[] = [
  {
    key: "vitamin d",
    canonical: "25-OH Vitamin D",
    aliases: [
      "vitamin d",
      "vitamin d total",
      "vitamin d 25 hydroxy",
      "vitamin d 25-hydroxy",
      "vitamin d, 25-hydroxy",
      "vitamin d 25-oh",
      "vitamin d 25 oh",
      "25 oh vitamin d",
      "25-oh vitamin d",
      "25-hydroxyvitamin d",
      "25 hydroxyvitamin d",
      "calcidiol",
    ],
  },
  {
    key: "egfr",
    canonical: "eGFR",
    aliases: [
      "egfr",
      "estimated gfr",
      "gfr estimated",
      "estimated glomerular filtration rate",
      "estimated glomerular filt rate",
      "creatinine-based estimated glomerular filtration rate (egfr)",
      "creatinine based estimated glomerular filtration rate egfr",
      "egfr (creatinine)",
      "egfr non-african american",
    ],
  },
  {
    key: "hba1c",
    canonical: "Hemoglobin A1c",
    aliases: ["hba1c", "hemoglobin a1c", "hemoglobin a1c (hba1c)", "a1c", "glycohemoglobin", "glycated hemoglobin", "hgb a1c"],
  },
  {
    key: "alt",
    canonical: "ALT",
    aliases: ["alt", "sgpt", "alanine aminotransferase", "alanine aminotransferase (alt)", "alt (sgpt)", "alanine transaminase"],
  },
  {
    key: "ast",
    canonical: "AST",
    aliases: ["ast", "sgot", "aspartate aminotransferase", "aspartate aminotransferase (ast)", "ast (sgot)", "aspartate transaminase"],
  },
  {
    key: "blood urea nitrogen bun",
    canonical: "Blood Urea Nitrogen (BUN)",
    aliases: ["bun", "bun urea nitrogen", "bun (urea nitrogen)", "blood urea nitrogen", "blood urea nitrogen (bun)", "urea nitrogen"],
  },
  {
    key: "alkaline phosphatase",
    canonical: "Alkaline Phosphatase",
    aliases: ["alkaline phosphatase", "alkaline phosphatase (alp)", "alp"],
  },
  {
    key: "mean corpuscular volume",
    canonical: "Mean Corpuscular Volume",
    aliases: ["mcv", "mean corpuscular volume", "mean corpuscular volume (mcv)"],
  },
  {
    key: "mean corpuscular hemoglobin",
    canonical: "Mean Corpuscular Hemoglobin",
    aliases: ["mch", "mean corpuscular hemoglobin", "mean corpuscular hemoglobin (mch)", "mean corpuscular hgb"],
  },
  {
    key: "mean corpuscular hemoglobin concentration",
    canonical: "Mean Corpuscular Hemoglobin Concentration",
    aliases: ["mchc", "mean corpuscular hemoglobin concentration", "mean corpuscular hemoglobin concentration (mchc)", "mean corp hgb conc"],
  },
  {
    key: "mean platelet volume",
    canonical: "Mean Platelet Volume",
    aliases: ["mpv", "mean platelet volume", "mean platelet volume (mpv)"],
  },
  {
    key: "red blood cell count",
    canonical: "Red Blood Cell Count",
    aliases: ["rbc", "rbc count", "red blood cell", "red blood cells", "red blood cell count", "red blood cell (rbc) count"],
  },
  {
    key: "hemoglobin",
    canonical: "Hemoglobin",
    aliases: ["hemoglobin", "hgb", "hb"],
  },
  {
    key: "hematocrit",
    canonical: "Hematocrit",
    aliases: ["hematocrit", "hct"],
  },
  {
    key: "red cell distribution width",
    canonical: "Red Cell Distribution Width (RDW)",
    aliases: ["rdw", "rdw cv", "rdw-cv", "red cell distribution width", "red cell distribution width (rdw)", "rbc distribution width"],
  },
  {
    key: "red cell distribution width standard deviation",
    canonical: "Red Cell Distribution Width, Standard Deviation",
    aliases: ["rdw-sd", "rdw sd", "rbc distribution width std dev", "red cell distribution width standard deviation"],
  },
  {
    key: "white blood cell count",
    canonical: "WBC",
    aliases: ["wbc", "white blood cell count", "white blood cell (wbc) count", "leukocyte count", "leukocytes"],
  },
  {
    key: "absolute neutrophil count",
    canonical: "Absolute Neutrophil Count",
    aliases: ["absolute neutrophil count", "absolute neutrophils", "abs neutrophils", "neutrophil absolute", "neutrophils absolute", "anc"],
  },
  {
    key: "absolute lymphocyte count",
    canonical: "Absolute Lymphocyte Count",
    aliases: ["absolute lymphocyte count", "absolute lymph count", "absolute lymphocytes", "abs lymphocytes", "lymphocyte absolute", "lymphocytes absolute"],
  },
  {
    key: "absolute monocyte count",
    canonical: "Absolute Monocyte Count",
    aliases: ["absolute monocyte count", "absolute mono count", "absolute monocytes", "abs monocytes", "monocyte absolute", "monocytes absolute"],
  },
  {
    key: "absolute eosinophil count",
    canonical: "Absolute Eosinophil Count",
    aliases: ["absolute eosinophil count", "absolute eosinophils", "abs eosinophils", "eosinophil absolute", "eosinophils absolute"],
  },
  {
    key: "absolute basophil count",
    canonical: "Absolute Basophil Count",
    aliases: ["absolute basophil count", "absolute baso count", "absolute basophils", "abs basophils", "basophil absolute", "basophils absolute"],
  },
  {
    key: "absolute immature granulocyte count",
    canonical: "Absolute Immature Granulocyte Count",
    aliases: ["absolute immature granulocyte count", "absolute imm gran count", "abs immature granulocytes", "immature granulocyte absolute", "imm gran absolute"],
  },
  {
    key: "immature granulocyte percentage",
    canonical: "Immature Granulocyte Percentage",
    aliases: ["immature granulocyte percentage", "immature granulocyte percent", "immature granulocyte %", "immature granulocytes %", "imm gran %", "immature grans %"],
  },
  {
    key: "absolute nrbc count",
    canonical: "Absolute NRBC Count",
    aliases: ["absolute nrbc count", "nrbc absolute", "absolute nucleated red blood cell count"],
  },
  {
    key: "nrbc percentage",
    canonical: "NRBC %",
    aliases: ["nrbc %", "nrbc percent", "nrbc percentage", "nucleated red blood cells %"],
  },
  {
    key: "body weight",
    canonical: "Body Weight",
    aliases: ["body weight", "weight", "total mass", "total body mass"],
  },
  {
    key: "height",
    canonical: "Height",
    aliases: ["height", "stature"],
  },
  {
    key: "neutrophil percentage",
    canonical: "Neutrophil Percentage",
    aliases: ["neutrophil percent", "neutrophils percent", "neutrophil percentage", "neutrophils percentage"],
  },
  {
    key: "lymphocyte percentage",
    canonical: "Lymphocyte Percentage",
    aliases: ["lymphocyte percent", "lymphocytes percent", "lymphocyte percentage", "lymphocytes percentage"],
  },
  {
    key: "monocyte percentage",
    canonical: "Monocyte Percentage",
    aliases: ["monocyte percent", "monocytes percent", "monocyte percentage", "monocytes percentage"],
  },
  {
    key: "eosinophil percentage",
    canonical: "Eosinophil Percentage",
    aliases: ["eosinophil percent", "eosinophils percent", "eosinophil percentage", "eosinophils percentage"],
  },
  {
    key: "basophil percentage",
    canonical: "Basophil Percentage",
    aliases: ["basophil percent", "basophils percent", "basophil percentage", "basophils percentage"],
  },
  {
    key: "apob",
    canonical: "Apolipoprotein B (ApoB)",
    aliases: ["apob", "apo b", "apolipoprotein b", "apolipoprotein b (apob)", "apolipoprotein b-100"],
  },
  {
    key: "lpa",
    canonical: "Lipoprotein (a)",
    aliases: ["lp(a)", "lp a", "lipoprotein a", "lipoprotein (a)", "lipoprotein little a"],
  },
  {
    key: "serum iron",
    canonical: "Iron",
    aliases: ["iron", "serum iron", "iron serum", "iron, serum", "total iron"],
  },
  {
    key: "transferrin saturation",
    canonical: "Iron % Saturation",
    aliases: ["iron % saturation", "iron saturation", "iron sat", "% saturation", "transferrin saturation", "transferrin saturation %", "transferrin saturation percent"],
  },
  {
    key: "total iron binding capacity",
    canonical: "Iron Binding Capacity",
    aliases: ["tibc", "total iron binding capacity", "iron binding capacity", "iron binding capacity, total", "total iron-binding capacity"],
  },
  {
    key: "transferrin",
    canonical: "Transferrin",
    aliases: ["transferrin"],
  },
  {
    // Basic lipid panel synonyms that major labs print differently. These are
    // the same analytes across MyChart / Function-style panels / LabCorp-style
    // PDFs, so they should merge before the agentic reconciler ever runs.
    key: "total cholesterol",
    canonical: "Total Cholesterol",
    aliases: ["total cholesterol", "cholesterol total", "cholesterol, total", "cholesterol"],
  },
  {
    key: "hdl cholesterol",
    canonical: "HDL Cholesterol",
    aliases: ["hdl c", "hdl-c", "hdl cholesterol", "hdl-cholesterol", "hdl chol", "high density lipoprotein cholesterol"],
  },
  {
    key: "triglycerides",
    canonical: "Triglycerides",
    aliases: ["triglycerides", "triglyceride", "trigs"],
  },
  {
    key: "vldl cholesterol",
    canonical: "VLDL Cholesterol",
    aliases: ["vldl cholesterol", "vldl cholesterol cal", "vldl cholesterol calc", "vldl cholesterol calculated", "vldl-c", "vldl c"],
  },
  {
    key: "hscrp",
    canonical: "hs-CRP",
    aliases: ["hs-crp", "hscrp", "high-sensitivity c-reactive protein", "high sensitivity c reactive protein", "c-reactive protein, high sensitivity", "high-sensitivity c-reactive protein (hs-crp)"],
  },
  {
    // Calculated / generically-named LDL cholesterol. Different labs print it as
    // "LDL-C", "LDL Cholesterol", or "LDL Chol Calc (NIH)"/"LDL Cholesterol Calc" —
    // all the SAME analyte, so they fold to one series (and one lipid directive)
    // instead of a duplicate LDL story per lab name. Deliberately EXCLUDES the
    // distinct DIRECT-measured LDL ("LDL-C (direct)" → "ldl c direct", left unmerged).
    key: "ldl c",
    canonical: "LDL-C",
    aliases: ["ldl c", "ldl cholesterol", "ldl chol", "ldl chol calc nih", "ldl cholesterol calc", "ldl cholesterol calc nih", "ldl calculated", "ldl chol calc", "ldl cholesterol calculated", "ldl cholesterol (calc)"],
  },
  {
    // Direct-measured LDL is clinically distinct from calculated LDL-C, so it
    // gets its own key and display label. It must never fold into "LDL-C".
    key: "ldl c direct",
    canonical: "LDL-C (Direct)",
    aliases: ["ldl c direct", "ldl-c direct", "ldl-c (direct)", "direct ldl", "direct ldl c", "direct ldl-c", "ldl cholesterol direct"],
  },
  {
    // Non-HDL cholesterol under its several printed names ("Non-HDL-C",
    // "Non-HDL Cholesterol", "Non HDL Chol"). One residual-risk marker, one series.
    key: "non hdl c",
    canonical: "Non-HDL-C",
    aliases: ["non hdl c", "non hdl", "non hdl cholesterol", "non hdl chol", "non hdl cholesterol calc", "cholesterol non hdl"],
  },
  {
    key: "omega 3 total",
    canonical: "Omega-3 Total",
    aliases: ["omega-3 total", "omega 3 total", "omega-3 total / omegacheck", "omega 3 total omegacheck", "omegacheck"],
  },
  {
    // Blood-pressure components. Labs/MyChart imports and the in-app BP capture print
    // the same vital under different names ("Systolic BP" vs "Systolic Blood Pressure"),
    // which otherwise splits one history into parallel series. `key` matches the label
    // expandBloodPressureMarker + the blood_pressure_readings path already file under,
    // so the vitals series stays unified. Bare "systolic"/"diastolic" are intentionally
    // NOT aliased (too ambiguous outside a BP context to merge safely).
    key: "systolic bp",
    canonical: "Systolic BP",
    aliases: ["systolic bp", "systolic blood pressure", "blood pressure systolic", "bp systolic", "systolic pressure"],
  },
  {
    key: "diastolic bp",
    canonical: "Diastolic BP",
    aliases: ["diastolic bp", "diastolic blood pressure", "blood pressure diastolic", "bp diastolic", "diastolic pressure"],
  },
];

// normalized alias → { key, canonical }.
const KB = new Map<string, { key: string; canonical: string }>();
for (const e of MARKER_ALIASES) {
  KB.set(normalizeMarkerName(e.canonical), { key: e.key, canonical: e.canonical });
  for (const a of e.aliases) KB.set(normalizeMarkerName(a), { key: e.key, canonical: e.canonical });
}

// The persisted alias table, on the shared canon-alias store (a learned alias re-keys
// / merges getMarkerHistory series, so every mutation bumps the marker data version).
const aliasStore = createAliasStore({
  table: "marker_aliases",
  keyColumn: "raw_norm",
  valueColumns: ["canonical_key", "canonical_name"],
  listOrderBy: "canonical_name, raw_norm",
  stampCreatedAt: true,
  onMutate: bumpMarkerDataVersion,
});

export function getMarkerAlias(rawNorm: string): { canonical_key: string; canonical_name: string } | null {
  if (!rawNorm) return null;
  return aliasStore.get(rawNorm) as { canonical_key: string; canonical_name: string } | null;
}

export function setMarkerAlias(rawNorm: string, canonicalKey: string, canonicalName: string, source = "agent") {
  if (!rawNorm || !canonicalKey || !canonicalName) return;
  aliasStore.set(rawNorm, [canonicalKey, canonicalName], source);
}

export function listMarkerAliases(): Array<{ raw_norm: string; canonical_key: string; canonical_name: string; source: string }> {
  return aliasStore.list();
}

export function clearMarkerAlias(rawNorm: string) {
  aliasStore.clear(normalizeMarkerName(rawNorm));
}

const BARE_DIFFERENTIAL_NAMES = new Set([
  "neutrophil",
  "neutrophils",
  "lymphocyte",
  "lymphocytes",
  "monocyte",
  "monocytes",
  "eosinophil",
  "eosinophils",
  "basophil",
  "basophils",
]);

function isUnsafeBareDifferentialAlias(name: string): boolean {
  const raw = String(name ?? "").toLowerCase();
  if (/%|\bpercent(?:age)?\b|\babs(?:olute)?\b|\bcount\b/.test(raw)) return false;
  return BARE_DIFFERENTIAL_NAMES.has(normalizeMarkerName(name));
}

function differentialPercentMarker(raw: string): { key: string; name: string } | null {
  const s = String(raw ?? "").toLowerCase();
  if (!/%|\bpercent(?:age)?\b/.test(s)) return null;
  if (/\babs(?:olute)?\b|\bcount\b/.test(s)) return null;
  if (/\bneutrophils?\b/.test(s)) return { key: "neutrophil percentage", name: "Neutrophil Percentage" };
  if (/\blymphocytes?\b/.test(s)) return { key: "lymphocyte percentage", name: "Lymphocyte Percentage" };
  if (/\bmonocytes?\b/.test(s)) return { key: "monocyte percentage", name: "Monocyte Percentage" };
  if (/\beosinophils?\b/.test(s)) return { key: "eosinophil percentage", name: "Eosinophil Percentage" };
  if (/\bbasophils?\b/.test(s)) return { key: "basophil percentage", name: "Basophil Percentage" };
  return null;
}

function normalizedUnitLooksAbsoluteCount(unit: unknown): boolean {
  const u = String(unit ?? "")
    .trim()
    .toLowerCase()
    .replace(/[μµ]/g, "u")
    .replace(/\s+/g, "");
  return /^(cells?|\/|k|th|thou|thousand|10\^3|10e3|x10\^3|x10e3)\/ul$/.test(u);
}

function bareDifferentialMarker(raw: string, unit?: string | null): { key: string; name: string } | null {
  const norm = normalizeMarkerName(raw);
  if (!BARE_DIFFERENTIAL_NAMES.has(norm)) return null;
  if (String(unit ?? "").trim() === "%") return differentialPercentMarker(`${raw} %`);
  if (!normalizedUnitLooksAbsoluteCount(unit)) return null;
  if (/^neutrophils?$/.test(norm)) return { key: "absolute neutrophil count", name: "Absolute Neutrophil Count" };
  if (/^lymphocytes?$/.test(norm)) return { key: "absolute lymphocyte count", name: "Absolute Lymphocyte Count" };
  if (/^monocytes?$/.test(norm)) return { key: "absolute monocyte count", name: "Absolute Monocyte Count" };
  if (/^eosinophils?$/.test(norm)) return { key: "absolute eosinophil count", name: "Absolute Eosinophil Count" };
  if (/^basophils?$/.test(norm)) return { key: "absolute basophil count", name: "Absolute Basophil Count" };
  return null;
}

type GlucoseContext = "bare" | "random" | "fasting" | "estimated_average";

function glucoseContext(raw: string): GlucoseContext | null {
  const norm = normalizeMarkerName(raw);
  if (!/\bglucose\b/.test(norm)) return null;
  if (/\bestimated average glucose\b|\beag\b/.test(norm)) return "estimated_average";
  if (/\bfasting\b/.test(norm)) return "fasting";
  if (/\brandom\b|\bnonfasting\b|\bnon fasting\b/.test(norm)) return "random";
  return "bare";
}

function hasUnsafeGlucoseContextMerge(names: string[]): boolean {
  const contexts = new Set(names.map(glucoseContext).filter(Boolean) as GlucoseContext[]);
  return contexts.size > 1;
}

function isUnsafePersistedAlias(rawNorm: string, canonicalKey: string): boolean {
  const rawContext = glucoseContext(rawNorm);
  const canonicalContext = glucoseContext(canonicalKey);
  return !!rawContext && !!canonicalContext && rawContext !== canonicalContext;
}

// KB-only lookup (exact normalized match): the curated merge key for a name, or
// null. Exposed so the reconciler can SNAP an agent group onto the curated key
// when the analyte is KB-covered (keeping the KB authoritative + keys stable).
export function kbKey(name: string): string | null {
  const hit = KB.get(normalizeMarkerName(name));
  return hit ? hit.key : null;
}

// Resolve a raw lab marker name to its canonical { key, name }. Order: the curated
// KB (authoritative + exact-match, so a KB-covered analyte ALWAYS gets its stable
// key) → a persisted alias decision (what the agent learned for the long tail) →
// the normalized name itself (typographic variants still merge; an unknown marker
// keys by its own normalized form). `key` is the merge key getMarkerHistory groups on;
// `name` is the clean internal display label agents/reports should use.
export function canonicalMarker(raw: string): { key: string; name: string } {
  const display = String(raw ?? "").replace(/\s+/g, " ").trim();
  const diffPct = differentialPercentMarker(display);
  if (diffPct) return diffPct;
  const norm = normalizeMarkerName(raw);
  if (!norm) return { key: "", name: display };
  const kbHit = KB.get(norm);
  if (kbHit) return { key: kbHit.key, name: kbHit.canonical };
  const alias = getMarkerAlias(norm);
  if (alias && !isUnsafePersistedAlias(norm, alias.canonical_key)) return { key: alias.canonical_key, name: alias.canonical_name };
  return { key: norm, name: display };
}

// Unit-aware wrapper for ambiguous bare differential labels. Labs often print
// "Neutrophils" as an absolute count when the unit is cells/uL, and "Neutrophils %"
// as a differential percentage. Keep `canonicalMarker()` conservative for alias
// planning, but use this at ingest where the source unit disambiguates the row.
export function canonicalMarkerForReading(raw: string, unit?: string | null): { key: string; name: string } {
  return bareDifferentialMarker(raw, unit) || canonicalMarker(raw);
}

// Distinct raw marker names across all health documents, with the most recent
// unit + a sample value + occurrence count — the input the agentic reconciler
// clusters. Deduped by normalized name (so "Glucose (random)"/"Glucose Random"
// arrive as one row already), most-recent doc wins for the display casing/unit.
export function distinctMarkerNames(): Array<{ name: string; unit: string | null; sample: unknown; n: number; canonical: string }> {
  const docs = db
    .prepare(
      `SELECT parsed_json FROM health_documents
       ORDER BY COALESCE(doc_date, substr(created_at,1,10)) ASC, id ASC`
    )
    .all() as any[];
  const map = new Map<string, { name: string; unit: string | null; sample: unknown; n: number }>();
  for (const d of docs) {
    let parsed: any = null;
    try { parsed = d.parsed_json ? JSON.parse(d.parsed_json) : null; } catch { parsed = null; }
    const markers = Array.isArray(parsed?.markers) ? parsed.markers : [];
    for (const m of markers) {
      if (!m || typeof m !== "object") continue;
      const name = String(m.name ?? "").replace(/\s+/g, " ").trim();
      if (!name) continue;
      const norm = normalizeMarkerName(name);
      if (!norm) continue;
      const unit = m.unit != null && String(m.unit).trim() ? String(m.unit).trim() : null;
      const prev = map.get(norm);
      if (prev) {
        prev.n++;
        if (unit) prev.unit = unit; // most-recent doc wins (ascending order)
        if (m.value != null && m.value !== "") prev.sample = m.value;
        prev.name = name;
      } else {
        map.set(norm, { name, unit, sample: m.value ?? null, n: 1 });
      }
    }
  }
  return [...map.values()].map((v) => ({ ...v, canonical: canonicalMarker(v.name).name }));
}

// Validate an agent's proposed same-analyte groups into the concrete alias rows to
// persist. PURE (no DB writes) so the safety guards are unit-testable without an
// agent. Guards, in order: a member must be a VERBATIM input name; a group needs
// ≥2 valid members; members with clearly-incompatible units are rejected (no
// cross-dimension merge); the canonical must normalize to a non-empty key; and it
// must be a REAL merge (the members currently key ≥2 different ways — so a group
// that's already merged is a no-op). Returns the alias rows {rawNorm→canonical}.
// When a group snaps to a curated KB key, the alias display name also snaps to the
// KB's internal label, not the model's arbitrary wording.
export function planMarkerMerges(
  items: Array<{ name: string; unit: string | null }>,
  groups: Array<{ canonical?: unknown; members?: unknown }>
): Array<{ rawNorm: string; canonicalKey: string; canonicalName: string }> {
  const byName = new Map(items.map((i) => [i.name, i]));
  const out: Array<{ rawNorm: string; canonicalKey: string; canonicalName: string }> = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const canonical = String((g as any)?.canonical ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const rawMembers = Array.isArray((g as any)?.members) ? (g as any).members.map((x: any) => String(x ?? "").replace(/\s+/g, " ").trim()) : [];
    const members = rawMembers.filter((m: string) => byName.has(m) && !isUnsafeBareDifferentialAlias(m));
    if (!canonical || members.length < 2) continue;
    if (hasUnsafeGlucoseContextMerge([canonical, ...members])) continue;
    const units = [...new Set(members.map((m: string) => byName.get(m)!.unit).filter(Boolean))] as string[];
    if (units.length > 1 && !units.every((u) => seriesUnitsCompatible(u, units[0]))) continue;
    // Snap to the curated KB key when this analyte is KB-covered (by the agent's
    // canonical name OR any member) — so the agent's grouping converges on the
    // stable curated key instead of inventing a parallel one, and a KB-covered
    // member that the agent left out of the group still merges in on read.
    const canonicalKey =
      kbKey(canonical) ||
      members.map((m: string) => kbKey(m)).find(Boolean) ||
      normalizeMarkerName(canonical) ||
      normalizeMarkerName(members[0]);
    if (!canonicalKey) continue;
    const resolvedCanonical = canonicalMarker(canonical);
    const resolvedMembers = members.map((m: string) => canonicalMarker(m));
    const canonicalName =
      (resolvedCanonical.key === canonicalKey && resolvedCanonical.name) ||
      resolvedMembers.find((m: { key: string; name: string }) => m.key === canonicalKey && m.name)?.name ||
      canonical;
    const currentKeys = new Set(members.map((m: string) => canonicalMarker(m).key));
    if (currentKeys.size < 2) continue; // already merged — nothing to do
    for (const m of members) out.push({ rawNorm: normalizeMarkerName(m), canonicalKey, canonicalName });
  }
  return out;
}
