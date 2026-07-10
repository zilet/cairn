import { AUTONOMY_TIERS, type AutonomyTier, type BrainDecisionKind, type BrainRiskClass } from "./decision-contract.js";

export type CairnLeadMode = "lead" | "announce_first" | "review_everything";

export interface AutonomyPolicyInput {
  kind: BrainDecisionKind;
  risk_class: BrainRiskClass;
  reversible: boolean;
  requested_tier?: AutonomyTier | null;
  lead_mode?: CairnLeadMode | null;
  magnitude?: number | null;
  clinical?: boolean;
  goal_identity?: boolean;
  user_locked?: boolean;
  clamp_refused?: boolean;
  domain_demoted?: boolean;
}

export interface AutonomyPolicyDecision {
  tier: AutonomyTier;
  reasons: string[];
  natural_boundary_required: boolean;
}

const RESTRICTION = new Map(AUTONOMY_TIERS.map((tier, index) => [tier, index]));

function moreRestrictive(a: AutonomyTier, b: AutonomyTier): AutonomyTier {
  return (RESTRICTION.get(a) ?? 0) >= (RESTRICTION.get(b) ?? 0) ? a : b;
}

export function defaultAutonomyTier(
  input: Pick<AutonomyPolicyInput, "kind" | "risk_class" | "reversible" | "magnitude">
): AutonomyTier {
  if (input.risk_class === "clinical") return "clinician";
  if (input.risk_class === "high" || !input.reversible) return "ask";
  if (["day_read", "session_suggestion", "health_directive"].includes(input.kind)) return "observe";
  if (["goal_change"].includes(input.kind)) return "ask";
  if (["training_structure", "meal_plan", "case_conference"].includes(input.kind)) return "announce";
  if (input.kind === "nutrition_target" && Math.abs(Number(input.magnitude) || 0) > 250) return "announce";
  return "quiet_apply";
}

export function decideAutonomyTier(input: AutonomyPolicyInput): AutonomyPolicyDecision {
  const reasons: string[] = [];
  let tier = defaultAutonomyTier(input);
  if (input.requested_tier) {
    const clamped = moreRestrictive(tier, input.requested_tier);
    if (clamped !== input.requested_tier)
      reasons.push("server policy required a more restrictive tier than the model requested");
    tier = clamped;
  }

  if (input.clinical || input.risk_class === "clinical") {
    tier = "clinician";
    reasons.push("clinical decisions remain clinician-directed");
  } else if (input.clamp_refused) {
    tier = moreRestrictive(tier, "ask");
    reasons.push("a safety floor refused the automatic action");
  } else if (input.goal_identity || input.user_locked) {
    tier = moreRestrictive(tier, "ask");
    reasons.push(input.user_locked ? "the user locked this decision" : "goal identity changes ask first");
  } else if (!input.reversible) {
    tier = moreRestrictive(tier, "ask");
    reasons.push("an irreversible action cannot apply autonomously");
  } else if (input.risk_class === "high") {
    tier = moreRestrictive(tier, "ask");
    reasons.push("high-risk coaching changes ask first");
  }

  if (input.domain_demoted && tier === "quiet_apply") {
    tier = "announce";
    reasons.push("recent reversals moved this domain to announce-first");
  }

  const leadMode = input.lead_mode ?? "review_everything";
  if (leadMode === "announce_first" && tier === "quiet_apply") {
    tier = "announce";
    reasons.push("Cairn is set to announce changes first");
  } else if (leadMode === "review_everything" && ["quiet_apply", "announce"].includes(tier)) {
    tier = "ask";
    reasons.push("Cairn is set to review everything");
  }

  return {
    tier,
    reasons: [...new Set(reasons)],
    natural_boundary_required: tier === "quiet_apply" || tier === "announce",
  };
}

export function domainShouldDemote(reverted: number, applied: number): boolean {
  const total = Math.max(0, Math.trunc(applied));
  const vetoes = Math.max(0, Math.trunc(reverted));
  return total >= 3 && vetoes >= 2 && vetoes / total >= 0.5;
}

export function surpriseBudgetAllows(materialChangesThisWeek: number, safetyResponse = false): boolean {
  return safetyResponse || Math.max(0, Math.trunc(materialChangesThisWeek)) < 1;
}
