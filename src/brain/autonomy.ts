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

// HEADS-UP AUTONOMY (owner ruling, 2026-08-17) — deliberate, and pinned by
// test/headsUpAutonomy.test.js. Under effective lead_mode 'lead' ONLY, two situations
// that used to stop and ask now land with a heads-up and the server-owned one-tap undo
// instead: a REVERSIBLE high-risk change, and a goal change (goal_change kind or the
// goal_identity flag). Goals are supposed to adapt from the signals; making every one
// of them an interrupt is what made the coach feel like a form to fill in.
//
// What did NOT move, and must not: clinical stays clinician (the deterministic floor a
// conductor cannot self-attest away), an IRREVERSIBLE action stays ask, a user_locked
// decision stays ask, and a refused safety clamp stays ask. 'announce_first' and
// 'review_everything' keep exactly their previous answers in every case.
function headsUpAutonomy(leadMode: CairnLeadMode): boolean {
  return leadMode === "lead";
}

export function defaultAutonomyTier(
  input: Pick<AutonomyPolicyInput, "kind" | "risk_class" | "reversible" | "magnitude" | "lead_mode">
): AutonomyTier {
  const headsUp = headsUpAutonomy(input.lead_mode ?? "review_everything");
  if (input.risk_class === "clinical") return "clinician";
  // Irreversibility is checked BEFORE risk: a high-risk change may now announce, but
  // one that cannot be taken back still has to be asked about at every lead mode.
  if (!input.reversible) return "ask";
  if (input.risk_class === "high") return headsUp ? "announce" : "ask";
  if (["day_read", "session_suggestion", "health_directive"].includes(input.kind)) return "observe";
  if (["goal_change"].includes(input.kind)) return headsUp ? "announce" : "ask";
  if (["training_structure", "meal_plan", "case_conference"].includes(input.kind)) return "announce";
  if (input.kind === "nutrition_target" && Math.abs(Number(input.magnitude) || 0) > 250) return "announce";
  return "quiet_apply";
}

export function decideAutonomyTier(input: AutonomyPolicyInput): AutonomyPolicyDecision {
  const reasons: string[] = [];
  const leadMode = input.lead_mode ?? "review_everything";
  const headsUp = headsUpAutonomy(leadMode);
  let tier = defaultAutonomyTier({ ...input, lead_mode: leadMode });
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
  } else if (input.user_locked) {
    tier = moreRestrictive(tier, "ask");
    reasons.push("the user locked this decision");
  } else if (input.goal_identity) {
    tier = moreRestrictive(tier, headsUp ? "announce" : "ask");
    reasons.push(
      headsUp ? "a goal change arrives with a heads-up and a one-tap undo" : "goal identity changes ask first"
    );
  } else if (!input.reversible) {
    tier = moreRestrictive(tier, "ask");
    reasons.push("an irreversible action cannot apply autonomously");
  } else if (input.risk_class === "high") {
    tier = moreRestrictive(tier, headsUp ? "announce" : "ask");
    reasons.push(
      headsUp ? "a change this size arrives with a heads-up and a one-tap undo" : "high-risk coaching changes ask first"
    );
  }

  if (input.domain_demoted && tier === "quiet_apply") {
    tier = "announce";
    reasons.push("recent reversals moved this domain to announce-first");
  }

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

// The pace of material change per domain-week. Raised from one to three by the same
// 2026-08-17 ruling: one change a week meant a coach that noticed something on Tuesday
// had to sit on it until the following Monday, and in practice every second read
// bounced off the budget. Three still keeps a week from being rewritten under the
// athlete. A safety response is never rationed.
//
// A budget MISS is a WAIT, not a refusal: callers delay to the next natural boundary
// (see delayForSurpriseBudget in domain/brain/autonomy-service.ts) and must never
// demote the change to a bare draft or to 'ask'.
export const SURPRISE_BUDGET_PER_DOMAIN_WEEK = 3;

export function surpriseBudgetAllows(materialChangesThisWeek: number, safetyResponse = false): boolean {
  return safetyResponse || Math.max(0, Math.trunc(materialChangesThisWeek)) < SURPRISE_BUDGET_PER_DOMAIN_WEEK;
}
