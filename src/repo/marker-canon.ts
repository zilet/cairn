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
import { seriesUnitsCompatible } from "./lab-units.js";

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
  canonical: string; // a clean canonical name (a hint only; display stays the lab's own name)
  aliases: string[];
}

// Curated, CONSERVATIVE clinical synonym KB. `key` is the merge key all variants
// collapse onto (kept short + token-stable so existing key-based lookups still
// resolve); `aliases` are alternate names that mean the SAME analyte. Only
// well-established equivalences belong here — and NEVER clinically-distinct
// measures (direct vs calculated LDL, random vs fasting vs estimated-average
// glucose, free vs total testosterone). When in doubt, leave it out and let the
// agentic reconciler (which can read units + context) make the call. Display names
// are never rewritten by canonicalization — only the series merge.
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
      "creatinine-based estimated glomerular filtration rate (egfr)",
      "creatinine based estimated glomerular filtration rate egfr",
      "egfr (creatinine)",
      "egfr non-african american",
    ],
  },
  {
    key: "hba1c",
    canonical: "Hemoglobin A1c",
    aliases: ["hba1c", "hemoglobin a1c", "a1c", "glycohemoglobin", "glycated hemoglobin", "hgb a1c"],
  },
  {
    key: "alt",
    canonical: "ALT",
    aliases: ["alt", "sgpt", "alanine aminotransferase", "alt (sgpt)", "alanine transaminase"],
  },
  {
    key: "ast",
    canonical: "AST",
    aliases: ["ast", "sgot", "aspartate aminotransferase", "ast (sgot)", "aspartate transaminase"],
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
    key: "hscrp",
    canonical: "hs-CRP",
    aliases: ["hs-crp", "hscrp", "high-sensitivity c-reactive protein", "high sensitivity c reactive protein", "c-reactive protein, high sensitivity", "high-sensitivity c-reactive protein (hs-crp)"],
  },
];

// normalized alias → { key, canonical }.
const KB = new Map<string, { key: string; canonical: string }>();
for (const e of MARKER_ALIASES) {
  KB.set(normalizeMarkerName(e.canonical), { key: e.key, canonical: e.canonical });
  for (const a of e.aliases) KB.set(normalizeMarkerName(a), { key: e.key, canonical: e.canonical });
}

export function getMarkerAlias(rawNorm: string): { canonical_key: string; canonical_name: string } | null {
  if (!rawNorm) return null;
  const r = db
    .prepare("SELECT canonical_key, canonical_name FROM marker_aliases WHERE raw_norm = ?")
    .get(rawNorm) as any;
  return r ? { canonical_key: r.canonical_key, canonical_name: r.canonical_name } : null;
}

export function setMarkerAlias(rawNorm: string, canonicalKey: string, canonicalName: string, source = "agent") {
  if (!rawNorm || !canonicalKey || !canonicalName) return;
  db.prepare(
    `INSERT INTO marker_aliases (raw_norm, canonical_key, canonical_name, source, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(raw_norm) DO UPDATE SET
       canonical_key = excluded.canonical_key,
       canonical_name = excluded.canonical_name,
       source = excluded.source`
  ).run(rawNorm, canonicalKey, canonicalName, source);
}

export function listMarkerAliases(): Array<{ raw_norm: string; canonical_key: string; canonical_name: string; source: string }> {
  return db.prepare("SELECT raw_norm, canonical_key, canonical_name, source FROM marker_aliases ORDER BY canonical_name, raw_norm").all() as any[];
}

export function clearMarkerAlias(rawNorm: string) {
  db.prepare("DELETE FROM marker_aliases WHERE raw_norm = ?").run(normalizeMarkerName(rawNorm));
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
// keys by its own normalized form). `key` is the merge key getMarkerHistory groups on.
export function canonicalMarker(raw: string): { key: string; name: string } {
  const display = String(raw ?? "").replace(/\s+/g, " ").trim();
  const norm = normalizeMarkerName(raw);
  if (!norm) return { key: "", name: display };
  const kbHit = KB.get(norm);
  if (kbHit) return { key: kbHit.key, name: kbHit.canonical };
  const alias = getMarkerAlias(norm);
  if (alias) return { key: alias.canonical_key, name: alias.canonical_name };
  return { key: norm, name: display };
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
export function planMarkerMerges(
  items: Array<{ name: string; unit: string | null }>,
  groups: Array<{ canonical?: unknown; members?: unknown }>
): Array<{ rawNorm: string; canonicalKey: string; canonicalName: string }> {
  const byName = new Map(items.map((i) => [i.name, i]));
  const out: Array<{ rawNorm: string; canonicalKey: string; canonicalName: string }> = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const canonical = String((g as any)?.canonical ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const rawMembers = Array.isArray((g as any)?.members) ? (g as any).members.map((x: any) => String(x ?? "").replace(/\s+/g, " ").trim()) : [];
    const members = rawMembers.filter((m: string) => byName.has(m));
    if (!canonical || members.length < 2) continue;
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
    const currentKeys = new Set(members.map((m: string) => canonicalMarker(m).key));
    if (currentKeys.size < 2) continue; // already merged — nothing to do
    for (const m of members) out.push({ rawNorm: normalizeMarkerName(m), canonicalKey, canonicalName: canonical });
  }
  return out;
}
