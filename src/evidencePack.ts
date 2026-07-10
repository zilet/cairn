// Bundled, offline evidence pack.
//
// The connected brain and the health-review agent CITE clinical guidelines (ACC/AHA
// cholesterol, ESC/EAS dyslipidaemia, WHO ferritin, ADA glycemia, …) so a flagged
// finding carries a real source. But that grounding used to depend on the agent
// already knowing the guideline or having web access — offline, a directive lost its
// citation and got downgraded to a softer "uncertain" nudge (see verifyCitation in
// repo/evidence.ts).
//
// This is a SMALL curated DATA MODULE — not a knowledge base — mapping the guidelines
// the brain uses to a ONE-LINE summary of the relevant target/threshold, so cited
// grounding is REACHABLE by default. It's threaded into buildHealthReviewPrompt so the
// review can ground (and cite) a lipid / ferritin / A1c directive with no web access.
//
// Three invariants keep it honest and maintainable:
//   1. Each entry carries a concrete URL, source revision, and bounded pack-review
//      window; an organization name by itself never verifies a claim.
//   2. Its summary is the claim-level support verifyCitation checks against.
//   3. Each `markers` entry is an OPTIMAL_ZONES label (repo/propagation-data.ts) so the
//      pack stays anchored to the same analytes the brain actually reasons about.
// Keep it short: one line per entry, extend only when the brain starts citing a new body.

import { evidenceFreshness, type EvidenceFreshness, type EvidenceSourceScope } from "./evidenceGovernance.js";

export const EVIDENCE_PACK_VERSION = "2026.07.1";
export const EVIDENCE_PACK_REVIEWED_AT = "2026-07-09";
export const EVIDENCE_PACK_EXPIRES_AT = "2027-01-09";

export interface EvidenceEntry {
  /** stable slug (test/debug anchor) */
  id: string;
  /** the human-readable citation string; verification also requires URL + claim */
  source: string;
  /** inspectable source URL, validated before the pack is consumed */
  source_url: string;
  /** source publication/guideline revision */
  source_version: string | null;
  source_scope: EvidenceSourceScope;
  published_at: string | null;
  reviewed_at: string;
  expires_at: string;
  pack_version: string;
  freshness: EvidenceFreshness;
  /** OPTIMAL_ZONES labels this entry grounds */
  markers: string[];
  /** ONE plain-clinical line: the relevant target / threshold */
  summary: string;
}

type RawEvidenceEntry = Omit<
  EvidenceEntry,
  "source_scope" | "reviewed_at" | "expires_at" | "pack_version" | "freshness"
>;

const RAW_EVIDENCE_PACK: RawEvidenceEntry[] = [
  {
    id: "apob-ldl",
    source: "ACC/AHA 2018 Cholesterol Guideline; ESC/EAS 2019 Dyslipidaemia",
    source_url: "https://www.ahajournals.org/doi/10.1161/CIR.0000000000000625",
    source_version: "2018/2019",
    published_at: "2019-01-01",
    markers: ["ApoB", "LDL-C", "Non-HDL-C"],
    summary:
      "Lower is better for atherogenic lipids: primary-prevention LDL-C well under 100 mg/dL (nearer 70 at higher risk); ApoB (~<80 mg/dL) tracks particle number and is the more precise target.",
  },
  {
    id: "triglycerides",
    source: "ESC/EAS 2019 Dyslipidaemia",
    source_url: "https://academic.oup.com/eurheartj/article/41/1/111/5556353",
    source_version: "2019",
    published_at: "2019-01-01",
    markers: ["Triglycerides"],
    summary:
      "Fasting triglycerides <150 mg/dL is desirable and <100 optimal; higher values track insulin resistance and add cardiovascular risk.",
  },
  {
    id: "hdl",
    source: "ACC/AHA 2018 Cholesterol Guideline",
    source_url: "https://www.ahajournals.org/doi/10.1161/CIR.0000000000000625",
    source_version: "2018",
    published_at: "2018-01-01",
    markers: ["HDL-C"],
    summary:
      "Low HDL-C (<40 mg/dL men, <50 women) marks higher risk; it responds to aerobic activity and weight loss but is not itself a drug target.",
  },
  {
    id: "lipoprotein-a",
    source: "EAS 2022 Lp(a) Consensus; NLA guidance",
    source_url: "https://academic.oup.com/eurheartj/article/43/39/3925/6670882",
    source_version: "2022",
    published_at: "2022-01-01",
    markers: ["Lp(a)"],
    summary:
      "Lp(a) is largely genetic; <75 nmol/L (~<30 mg/dL) is desirable — it doesn't move with diet, so manage overall atherogenic risk (ApoB/LDL) harder when it's high.",
  },
  {
    id: "hs-crp",
    source: "AHA/CDC inflammation guidance",
    source_url: "https://www.ahajournals.org/doi/10.1161/01.CIR.0000052939.59093.45",
    source_version: "2003",
    published_at: "2003-01-01",
    markers: ["hs-CRP"],
    summary:
      "Non-acute hs-CRP <1 mg/L is low cardiovascular risk, 1–3 average, >3 high; recheck when acutely ill or recently trained hard.",
  },
  {
    id: "hba1c-glucose",
    source: "ADA Standards of Care",
    source_url: "https://diabetesjournals.org/care/issue/47/Supplement_1",
    source_version: "2024",
    published_at: "2024-01-01",
    markers: ["HbA1c", "Fasting glucose"],
    summary:
      "HbA1c <5.7% is normal, 5.7–6.4% prediabetes, ≥6.5% diabetes; fasting glucose 70–99 mg/dL normal, 100–125 prediabetes.",
  },
  {
    id: "ferritin",
    source: "WHO 2020 Ferritin Guideline",
    source_url: "https://www.who.int/publications/i/item/9789240000124",
    source_version: "2020",
    published_at: "2020-01-01",
    markers: ["Ferritin"],
    summary:
      "Ferritin <15 ng/mL indicates iron deficiency; ferritin is also affected by inflammation, so it is interpreted alongside other iron studies.",
  },
  {
    id: "vitamin-d",
    source: "Endocrine Society Vitamin D Guideline",
    source_url: "https://academic.oup.com/jcem/article/109/8/1907/7685305",
    source_version: "2024",
    published_at: "2024-01-01",
    markers: ["Vitamin D"],
    summary:
      "25-OH vitamin D <20 ng/mL is deficient and 20–30 insufficient; ~30–50 ng/mL is a common sufficiency target.",
  },
  {
    id: "blood-pressure",
    source: "ACC/AHA 2017 Hypertension Guideline",
    source_url: "https://www.ahajournals.org/doi/10.1161/HYP.0000000000000065",
    source_version: "2017",
    published_at: "2017-01-01",
    markers: ["Systolic BP", "Diastolic BP"],
    summary:
      "Normal BP <120/80 mmHg; elevated 120–129/<80; stage-1 hypertension ≥130/80 — confirm with repeated resting readings.",
  },
  {
    id: "egfr-kidney",
    source: "KDIGO 2024 CKD Guideline",
    source_url: "https://kdigo.org/guidelines/ckd-evaluation-and-management/",
    source_version: "2024",
    published_at: "2024-01-01",
    markers: ["eGFR", "Creatinine"],
    summary:
      "eGFR ≥90 is normal; a sustained <60 for ≥3 months defines CKD — pair with a urine albumin-creatinine ratio to stage kidney health.",
  },
  {
    id: "homocysteine",
    source: "AHA homocysteine advisory",
    source_url: "https://www.ahajournals.org/doi/10.1161/01.CIR.0000049367.35564.EA",
    source_version: "2003",
    published_at: "2003-01-01",
    markers: ["Homocysteine"],
    summary:
      "Homocysteine >15 µmol/L is elevated and associates with cardiovascular risk; adequate B12, folate and B6 lower it.",
  },
  {
    id: "thyroid",
    source: "ATA Thyroid Guideline",
    source_url: "https://www.liebertpub.com/doi/10.1089/thy.2014.0028",
    source_version: "2014",
    published_at: "2014-01-01",
    markers: ["TSH", "Free T4", "Free T3"],
    summary:
      "TSH ~0.4–4.0 mIU/L is the usual reference; interpret alongside free T4 and symptoms rather than treating a number alone.",
  },
  {
    id: "uric-acid",
    source: "ACR Gout Guideline",
    source_url: "https://rheumatology.org/gout-guideline",
    source_version: "2020",
    published_at: "2020-01-01",
    markers: ["Uric acid"],
    summary:
      "When managing gout, a serum urate target <6 mg/dL reduces flares; an isolated high value without symptoms is watched, not treated.",
  },
  {
    id: "testosterone",
    source: "Endocrine Society Testosterone Guideline",
    source_url: "https://www.endocrine.org/clinical-practice-guidelines/testosterone-therapy",
    source_version: "2018",
    published_at: "2018-01-01",
    markers: ["Testosterone"],
    summary:
      "Diagnose low testosterone only on consistently low morning total testosterone WITH symptoms — a single low draw is repeated, not acted on.",
  },
];

export const EVIDENCE_PACK: EvidenceEntry[] = RAW_EVIDENCE_PACK.map((entry) => {
  const governance = {
    source_scope: "general" as const,
    reviewed_at: EVIDENCE_PACK_REVIEWED_AT,
    expires_at: EVIDENCE_PACK_EXPIRES_AT,
    pack_version: EVIDENCE_PACK_VERSION,
  };
  return { ...entry, ...governance, freshness: evidenceFreshness(governance) };
});

// Render the pack as a compact plain-text reference block for a prompt. When
// `markerNames` is given, filter to entries touching those analytes (so the block
// stays relevant to THIS person's panel); if nothing matches, fall back to the full
// pack so grounding is never empty. Names are matched case-insensitively against each
// entry's OPTIMAL_ZONES labels. Returns "" only when the pack itself is empty.
export function renderEvidencePack(markerNames?: string[]): string {
  if (!EVIDENCE_PACK.length) return "";
  const want = new Set((markerNames ?? []).map((n) => String(n ?? "").trim().toLowerCase()).filter(Boolean));
  let entries = EVIDENCE_PACK;
  if (want.size) {
    const filtered = EVIDENCE_PACK.filter((e) => e.markers.some((m) => want.has(m.toLowerCase())));
    if (filtered.length) entries = filtered;
  }
  return entries.map((e) => `- ${e.markers.join(", ")} — ${e.summary} [${e.source}]`).join("\n");
}
