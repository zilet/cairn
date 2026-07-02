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
// Two invariants keep it honest and maintainable:
//   1. Each `source` string names a recognized guideline body so it PASSES verifyCitation
//      (repo/evidence.ts GUIDELINE_ALLOWLIST) — the agent can cite it and the directive
//      keeps its citation instead of being stripped to uncertain.
//   2. Each `markers` entry is an OPTIMAL_ZONES label (repo/propagation-data.ts) so the
//      pack stays anchored to the same analytes the brain actually reasons about.
// Keep it short: one line per entry, extend only when the brain starts citing a new body.

export interface EvidenceEntry {
  /** stable slug (test/debug anchor) */
  id: string;
  /** the citation string — MUST name a body in evidence.ts GUIDELINE_ALLOWLIST */
  source: string;
  /** OPTIMAL_ZONES labels this entry grounds */
  markers: string[];
  /** ONE plain-clinical line: the relevant target / threshold */
  summary: string;
}

export const EVIDENCE_PACK: EvidenceEntry[] = [
  {
    id: "apob-ldl",
    source: "ACC/AHA 2018 Cholesterol Guideline; ESC/EAS 2019 Dyslipidaemia",
    markers: ["ApoB", "LDL-C", "Non-HDL-C"],
    summary:
      "Lower is better for atherogenic lipids: primary-prevention LDL-C well under 100 mg/dL (nearer 70 at higher risk); ApoB (~<80 mg/dL) tracks particle number and is the more precise target.",
  },
  {
    id: "triglycerides",
    source: "ESC/EAS 2019 Dyslipidaemia",
    markers: ["Triglycerides"],
    summary:
      "Fasting triglycerides <150 mg/dL is desirable and <100 optimal; higher values track insulin resistance and add cardiovascular risk.",
  },
  {
    id: "hdl",
    source: "ACC/AHA 2018 Cholesterol Guideline",
    markers: ["HDL-C"],
    summary:
      "Low HDL-C (<40 mg/dL men, <50 women) marks higher risk; it responds to aerobic activity and weight loss but is not itself a drug target.",
  },
  {
    id: "lipoprotein-a",
    source: "EAS 2022 Lp(a) Consensus; NLA guidance",
    markers: ["Lp(a)"],
    summary:
      "Lp(a) is largely genetic; <75 nmol/L (~<30 mg/dL) is desirable — it doesn't move with diet, so manage overall atherogenic risk (ApoB/LDL) harder when it's high.",
  },
  {
    id: "hs-crp",
    source: "AHA/CDC inflammation guidance",
    markers: ["hs-CRP"],
    summary:
      "Non-acute hs-CRP <1 mg/L is low cardiovascular risk, 1–3 average, >3 high; recheck when acutely ill or recently trained hard.",
  },
  {
    id: "hba1c-glucose",
    source: "ADA Standards of Care",
    markers: ["HbA1c", "Fasting glucose"],
    summary:
      "HbA1c <5.7% is normal, 5.7–6.4% prediabetes, ≥6.5% diabetes; fasting glucose 70–99 mg/dL normal, 100–125 prediabetes.",
  },
  {
    id: "ferritin",
    source: "WHO 2020 Ferritin Guideline",
    markers: ["Ferritin"],
    summary:
      "Ferritin <15 ng/mL indicates iron deficiency and <30 depleted stores; endurance athletes often aim >50 ng/mL for training capacity.",
  },
  {
    id: "vitamin-d",
    source: "Endocrine Society Vitamin D Guideline",
    markers: ["Vitamin D"],
    summary:
      "25-OH vitamin D <20 ng/mL is deficient and 20–30 insufficient; ~30–50 ng/mL is a common sufficiency target.",
  },
  {
    id: "blood-pressure",
    source: "ACC/AHA 2017 Hypertension Guideline",
    markers: ["Systolic BP", "Diastolic BP"],
    summary:
      "Normal BP <120/80 mmHg; elevated 120–129/<80; stage-1 hypertension ≥130/80 — confirm with repeated resting readings.",
  },
  {
    id: "egfr-kidney",
    source: "KDIGO 2024 CKD Guideline",
    markers: ["eGFR", "Creatinine"],
    summary:
      "eGFR ≥90 is normal; a sustained <60 for ≥3 months defines CKD — pair with a urine albumin-creatinine ratio to stage kidney health.",
  },
  {
    id: "homocysteine",
    source: "AHA homocysteine advisory",
    markers: ["Homocysteine"],
    summary:
      "Homocysteine >15 µmol/L is elevated and associates with cardiovascular risk; adequate B12, folate and B6 lower it.",
  },
  {
    id: "thyroid",
    source: "ATA Thyroid Guideline",
    markers: ["TSH", "Free T4", "Free T3"],
    summary:
      "TSH ~0.4–4.0 mIU/L is the usual reference; interpret alongside free T4 and symptoms rather than treating a number alone.",
  },
  {
    id: "uric-acid",
    source: "ACR Gout Guideline",
    markers: ["Uric acid"],
    summary:
      "When managing gout, a serum urate target <6 mg/dL reduces flares; an isolated high value without symptoms is watched, not treated.",
  },
  {
    id: "testosterone",
    source: "Endocrine Society Testosterone Guideline",
    markers: ["Testosterone"],
    summary:
      "Diagnose low testosterone only on consistently low morning total testosterone WITH symptoms — a single low draw is repeated, not acted on.",
  },
];

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
