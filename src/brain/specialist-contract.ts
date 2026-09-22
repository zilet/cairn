import { asRecord, cleanText, enumValue, hasOwnProperties, normalizeStringList } from "./contract-utils.js";
import { AUTONOMY_TIERS, BRAIN_DOMAINS, type AutonomyTier, type BrainDomain } from "./decision-contract.js";
import { normalizeProposedExpectation, type ProposedExpectation } from "./expectation-contract.js";

// The specialists are the brain's domains plus ONE voice that is not a ledger domain of
// its own: the ENDURANCE coach. A race build is training, so its decisions stay filed
// under `training`, but inside the conference the run build needs its own advocate —
// a strength coach speaking for both sides of a hybrid week is no conference at all.
export type SpecialistDomain = Exclude<BrainDomain, "cross_domain"> | "endurance";
export const SPECIALIST_DOMAINS = [
  ...BRAIN_DOMAINS.filter((domain) => domain !== "cross_domain"),
  "endurance",
] as SpecialistDomain[];

export interface SpecialistOpinion {
  domain: SpecialistDomain;
  recommendation: string;
  rationale: string;
  evidence_keys: string[];
  risks: string[];
  contraindications: string[];
  uncertainties: string[];
  expected_outcomes: ProposedExpectation[];
  autonomy_ceiling: AutonomyTier;
}

export function normalizeSpecialistOpinion(value: unknown): SpecialistOpinion | null {
  const input = asRecord(value);
  if (!input) return null;
  const domain = enumValue(input.domain, SPECIALIST_DOMAINS);
  const recommendation = cleanText(input.recommendation, 600);
  const rationale = cleanText(input.rationale, 1_500);
  const autonomyCeiling = enumValue(input.autonomy_ceiling, AUTONOMY_TIERS);
  const evidenceKeys = normalizeStringList(input.evidence_keys, { maxItems: 30, maxLength: 160 });
  if (!domain || !recommendation || !rationale || !autonomyCeiling || evidenceKeys.length === 0) return null;

  const rawOutcomes = Array.isArray(input.expected_outcomes) ? input.expected_outcomes.slice(0, 10) : [];
  const expectedOutcomes: ProposedExpectation[] = [];
  for (const outcome of rawOutcomes) {
    const normalized = normalizeProposedExpectation(outcome);
    if (!normalized) return null;
    expectedOutcomes.push(normalized);
  }

  return {
    domain,
    recommendation,
    rationale,
    evidence_keys: evidenceKeys,
    risks: normalizeStringList(input.risks, { maxItems: 20, maxLength: 300 }),
    contraindications: normalizeStringList(input.contraindications, { maxItems: 20, maxLength: 300 }),
    uncertainties: normalizeStringList(input.uncertainties, { maxItems: 20, maxLength: 300 }),
    expected_outcomes: expectedOutcomes,
    autonomy_ceiling: autonomyCeiling,
  };
}

export function isSpecialistOpinion(value: unknown): value is SpecialistOpinion {
  const input = asRecord(value);
  return (
    !!input &&
    normalizeSpecialistOpinion(value) !== null &&
    hasOwnProperties(input, [
      "domain",
      "recommendation",
      "rationale",
      "evidence_keys",
      "risks",
      "contraindications",
      "uncertainties",
      "expected_outcomes",
      "autonomy_ceiling",
    ])
  );
}
