import { AUTONOMY_TIERS, type AutonomyTier, type BrainDecisionKind, type BrainRiskClass } from "./decision-contract.js";

export type CairnLeadMode = "lead" | "announce_first" | "review_everything";

// Forgotten call sites used to inherit review_everything (maximum-ask). The
// product default is lead — the same value the settings row and DB column use.
export const DEFAULT_LEAD_MODE: CairnLeadMode = "lead";

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
  /**
   * A STANDING refresh whose diff against what is already in force is bounded — the
   * weekly meal plan rebuilt with the same targets and the same shape of week, with
   * different food in the slots. Deterministic and caller-supplied (repo's
   * `mealPlanRefreshShape`), never a model's own assessment of itself.
   *
   * It lowers the DEFAULT tier for `meal_plan` only. Everything else still applies on
   * top: announce_first announces it, review_everything asks, a demoted domain
   * announces, and a lock or a refused safety clamp still asks.
   */
  routine?: boolean;
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
  input: Pick<AutonomyPolicyInput, "kind" | "risk_class" | "reversible" | "magnitude" | "lead_mode" | "routine">
): AutonomyTier {
  const headsUp = headsUpAutonomy(input.lead_mode ?? DEFAULT_LEAD_MODE);
  if (input.risk_class === "clinical") return "clinician";
  // Irreversibility is checked BEFORE risk: a high-risk change may now announce, but
  // one that cannot be taken back still has to be asked about at every lead mode.
  if (!input.reversible) return "ask";
  if (input.risk_class === "high") return headsUp ? "announce" : "ask";
  if (["day_read", "session_suggestion", "health_directive"].includes(input.kind)) return "observe";
  if (["goal_change"].includes(input.kind)) return headsUp ? "announce" : "ask";
  // A ROUTINE meal refresh is the plan staying fresh, not a change to it: same
  // targets, same shape of week, different food in the slots. Announcing that every
  // week made the standing refresh feel like a decision the athlete had to make, and
  // the ritual is what the drafts kept waiting on. It still lands at the next food
  // boundary, still carries the one-tap undo, and any refresh that moves the targets
  // or the structure of the week is not routine and announces exactly as before.
  if (input.kind === "meal_plan" && input.routine === true) return "quiet_apply";
  if (["training_structure", "meal_plan", "case_conference"].includes(input.kind)) return "announce";
  if (input.kind === "nutrition_target" && Math.abs(Number(input.magnitude) || 0) > 250) return "announce";
  return "quiet_apply";
}

export function decideAutonomyTier(input: AutonomyPolicyInput): AutonomyPolicyDecision {
  const reasons: string[] = [];
  const leadMode = input.lead_mode ?? DEFAULT_LEAD_MODE;
  const headsUp = headsUpAutonomy(leadMode);
  let tier = defaultAutonomyTier({ ...input, lead_mode: leadMode });
  if (input.kind === "meal_plan" && input.routine === true && tier === "quiet_apply")
    reasons.push("a routine refresh keeps the plan fresh without asking");
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

// The natural boundary a scheduled change lands at: a structural change (the shape of
// the training week) waits for the next Monday so no half-lived week is rewritten
// underneath the athlete; every other bounded change lands tomorrow. Pure date policy —
// `today` is a local YYYY-MM-DD and so is the answer. The autonomy service schedules
// against this and the chat structure hand-off names the same day in its receipt.
// THE CLINICIAN FLOOR IS DETERMINISTIC — IN BOTH DIRECTIONS. A conductor cannot
// self-attest it away (Amendment 1), and it cannot self-attest INTO it either: a
// specialist opinion whose `autonomy_ceiling` says "clinician" over a hill-repeat
// stand-down, or a conductor writing `risk_class:'clinical'` on a kcal hold, is model
// discretion deciding the tier, which is exactly what server-owned autonomy exists to
// prevent. Live, that produced rows held for a clinician who does not exist in the
// loop — never thawed, never applied, never askable — that sat in "Waiting on you" for
// weeks with no door. What DOES hold the floor: the server-detected `clinical_autonomy`
// conflict, or action text that names a diagnosis, a medication, a dose or a
// prescription. Anything else at the clinician tier is re-read by ordinary policy.
export const CLINICAL_ACTION_PATTERN = /diagnos|medication|dosage|\bdose\b|prescri/i;

export function clinicalActionText(text: string): boolean {
  return CLINICAL_ACTION_PATTERN.test(String(text ?? ""));
}

// Whether a RECORDED decision stands on the deterministic floor. Reads the server's own
// marks first (`context.clinical`, `policy_inputs.clinical`, the `clinical_ceiling`
// reason code) and, for legacy rows with no marks at all, the same text rule the
// conductor is held to — never the bare tier or risk_class the model wrote.
export function clinicianFloorHolds(decision: {
  autonomy_tier?: unknown;
  risk_class?: unknown;
  summary?: unknown;
  rationale?: unknown;
  context?: unknown;
  action?: unknown;
}): boolean {
  const context = (decision.context ?? {}) as Record<string, any>;
  if (context.clinical === true || context.deterministic_clinical === true || context.policy_inputs?.clinical === true)
    return true;
  if (String(context.review_reason_code ?? "") === "clinical_ceiling") return true;
  if (context.deterministic_clinical === false) return false;
  const held = decision.autonomy_tier === "clinician" || decision.risk_class === "clinical";
  if (!held) return false;
  // Athlete-facing prose only — machine keys such as `dose_context` are not clinical words.
  const spoken = String((decision.action as any)?.user_explanation ?? "");
  return clinicalActionText(`${String(decision.summary ?? "")}\n${String(decision.rationale ?? "")}\n${spoken}`);
}

export function nextNaturalBoundary(kind: BrainDecisionKind | string, today: string): string {
  const base = new Date(`${today}T12:00:00Z`);
  if (Number.isNaN(base.getTime())) return today;
  const days = kind === "training_structure" ? (8 - base.getUTCDay()) % 7 || 7 : 1;
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
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
