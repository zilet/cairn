// Bundled, offline "trusted guidelines pack" — the OFFLINE FLOOR for citations.
//
// The connected brain's propagation + prioritization are always-on, but the
// CITED-evidence layer (src/research.ts → evidence_cache) ships OFF by default and
// needs a web-capable agent, so most users never see a citation. This module fixes
// the floor: a small, CONSERVATIVE, curated KB of trusted guideline statements for
// exactly the markers/topics the connected brain already reasons about (aligned to
// OPTIMAL_ZONES / MARKER_MAPPINGS / marker-canon keys). With this pack a directive
// note can carry a real, recognized-body citation with NO network and research
// disabled. Live web research (settings.research_enabled) stays the opt-in that
// ADDS fresh grounding on top — it does not replace this floor.
//
// CONSTITUTION: every statement is plain-language, NON-prescriptive, generic, and
// INFORMATIONAL — never individualized medical advice, never a score/grade. Each
// names a recognized guideline body and links its real public URL. Quality over
// quantity: a few high-confidence entries beat a long, shaky list.
//
// Matching mirrors matchOptimalZone / marker-canon: a lowercased substring lookup
// over each entry's keys, longest-key-wins, so "non-hdl" never reads as "hdl" and
// "ApoB" / "Apolipoprotein B" resolve to the same entry. null when nothing matches.

import { isPlausibleSourceUrl } from "./repo/evidence.js";

export interface GuidelineEntry {
  // canonical short key (stable; aligns to an OPTIMAL_ZONES label / marker-canon key)
  key: string;
  // lowercased substring keys for the deterministic matcher (longest-match wins)
  keys: string[];
  // ONE plain-language, non-prescriptive sentence — informational, never advice
  body: string;
  // a recognized guideline / evidence body (AHA/ACC, USPSTF, Endocrine Society, …)
  source: string;
  // the guideline's real, public http(s) URL
  url: string;
  // publication / latest-revision year, when known
  year?: number;
}

// The curated pack. Conservative and few — only well-established, broadly-cited
// positions, phrased generically. Keys are aligned to the connected brain's own
// marker vocabulary so guidelineFor() resolves the names directives already use.
const GUIDELINES: GuidelineEntry[] = [
  {
    key: "apob",
    keys: ["apob", "apolipoprotein b", "apo b"],
    body: "ApoB reflects the number of atherogenic lipoprotein particles and is recognized as a useful marker of cardiovascular risk, often tracking risk more closely than LDL cholesterol alone.",
    source: "AHA/ACC Multisociety Cholesterol Guideline",
    url: "https://www.ahajournals.org/doi/10.1161/CIR.0000000000000625",
    year: 2018,
  },
  {
    key: "ldl",
    keys: ["ldl", "ldl-c", "ldl cholesterol", "low-density lipoprotein"],
    body: "Lowering LDL cholesterol is associated with lower cardiovascular risk across the population, and lifestyle measures such as dietary pattern and physical activity are first-line considerations.",
    source: "AHA/ACC Multisociety Cholesterol Guideline",
    url: "https://www.ahajournals.org/doi/10.1161/CIR.0000000000000625",
    year: 2018,
  },
  {
    key: "non-hdl",
    keys: ["non-hdl", "non hdl", "non-hdl cholesterol"],
    body: "Non-HDL cholesterol captures all atherogenic particles in one number and is a recognized secondary target alongside LDL cholesterol in cardiovascular risk assessment.",
    source: "AHA/ACC Multisociety Cholesterol Guideline",
    url: "https://www.ahajournals.org/doi/10.1161/CIR.0000000000000625",
    year: 2018,
  },
  {
    key: "triglycerides",
    keys: ["triglyceride", "triglycerides", "tg"],
    body: "Elevated triglycerides are commonly responsive to lifestyle factors such as added sugar and alcohol intake, weight, and physical activity, and very high levels are also relevant to pancreatitis risk.",
    source: "AHA Scientific Statement on Triglycerides",
    url: "https://www.ahajournals.org/doi/10.1161/CIR.0b013e3182160726",
    year: 2011,
  },
  {
    key: "lpa",
    keys: ["lp(a)", "lipoprotein(a)", "lipoprotein (a)", "lipoprotein a", "lp a", "lpa"],
    body: "Lipoprotein(a) is largely genetically determined and is recognized as an independent cardiovascular risk factor; measuring it at least once helps clarify overall risk.",
    source: "European Atherosclerosis Society Consensus Statement",
    url: "https://academic.oup.com/eurheartj/article/43/39/3925/6670882",
    year: 2022,
  },
  {
    key: "hscrp",
    keys: ["hs-crp", "hscrp", "high-sensitivity c-reactive protein", "c-reactive", "c reactive", "crp"],
    body: "High-sensitivity C-reactive protein is a marker of low-grade inflammation and can add context to cardiovascular risk estimation, though it is non-specific and can rise transiently with illness.",
    source: "AHA/CDC Scientific Statement on Inflammation Markers",
    url: "https://www.ahajournals.org/doi/10.1161/01.CIR.0000052939.59093.45",
    year: 2003,
  },
  {
    key: "hba1c",
    keys: ["hba1c", "a1c", "hemoglobin a1c", "glycated hemoglobin"],
    body: "Hemoglobin A1c reflects average blood glucose over roughly the prior three months and is one of the recognized measures used to characterize glucose regulation.",
    source: "American Diabetes Association Standards of Care",
    url: "https://diabetesjournals.org/care/issue/47/Supplement_1",
    year: 2024,
  },
  {
    key: "glucose",
    keys: ["fasting glucose", "glucose", "blood sugar"],
    body: "Fasting glucose is a recognized measure of glucose regulation, and physical activity, dietary pattern, sleep, and body composition are all relevant lifestyle factors.",
    source: "American Diabetes Association Standards of Care",
    url: "https://diabetesjournals.org/care/issue/47/Supplement_1",
    year: 2024,
  },
  {
    key: "ferritin",
    keys: ["ferritin"],
    body: "Ferritin reflects the body's iron stores; it can be low with iron deficiency and is also an acute-phase reactant that can rise with inflammation, so it is best interpreted alongside other iron studies.",
    source: "WHO Guidance on Ferritin Concentrations",
    url: "https://www.who.int/publications/i/item/9789240000124",
    year: 2020,
  },
  {
    key: "vitamin d",
    keys: ["vitamin d", "25-oh", "25 hydroxy", "25(oh)d", "25-hydroxy", "calcidiol"],
    body: "Vitamin D status is most commonly assessed with 25-hydroxyvitamin D, and guidance generally favors meeting needs through reasonable intake rather than routine high-dose supplementation.",
    source: "Endocrine Society Clinical Practice Guideline",
    url: "https://academic.oup.com/jcem/article/109/8/1907/7685305",
    year: 2024,
  },
  {
    key: "egfr",
    keys: ["egfr", "estimated glomerular filtration rate", "glomerular filtration"],
    body: "Estimated GFR is a recognized measure of kidney function, and a single value is best interpreted in trend and alongside markers such as urine albumin rather than in isolation.",
    source: "KDIGO Clinical Practice Guideline (CKD)",
    url: "https://kdigo.org/guidelines/ckd-evaluation-and-management/",
    year: 2024,
  },
  {
    key: "blood pressure",
    keys: ["blood pressure", "systolic", "diastolic", "hypertension"],
    body: "Blood pressure is best characterized by repeated, properly measured readings, and lifestyle measures such as dietary sodium, physical activity, weight, and alcohol are recognized first-line considerations.",
    source: "AHA/ACC Blood Pressure Guideline",
    url: "https://www.ahajournals.org/doi/10.1161/HYP.0000000000000065",
    year: 2017,
  },
];

// normalized substring matcher (mirrors matchOptimalZone): lowercase the query and
// pick the entry whose longest matching key wins. Deterministic, offline, null when
// nothing matches. A key match is a plain `includes` against the lowercased query,
// so an aliased/expanded name ("Apolipoprotein B (ApoB)", "25-OH Vitamin D") still
// resolves to its entry.
export function guidelineFor(markerOrTopic: string): GuidelineEntry | null {
  const n = String(markerOrTopic ?? "").toLowerCase();
  if (!n.trim()) return null;
  let best: GuidelineEntry | null = null;
  let bestLen = 0;
  for (const e of GUIDELINES) {
    for (const k of e.keys) {
      if (n.includes(k) && k.length > bestLen) { best = e; bestLen = k.length; }
    }
  }
  return best;
}

// All curated entries (a defensive copy). Only entries whose URL passes the shared
// http(s) scheme guard are surfaced — a bad/unsafe URL would never reach a consumer
// even if a future edit introduced one (defense-in-depth, mirrors evidence.addEvidence).
export function allGuidelines(): GuidelineEntry[] {
  return GUIDELINES.filter((e) => isPlausibleSourceUrl(e.url)).map((e) => ({ ...e, keys: [...e.keys] }));
}
