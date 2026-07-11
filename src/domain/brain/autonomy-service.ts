import { db } from "../../db.js";
import { decideAutonomyTier, domainShouldDemote, surpriseBudgetAllows } from "../../brain/autonomy.js";
import type { AutonomyTier, BrainDomain } from "../../brain/decision-contract.js";
import {
  listBrainDecisions,
  listBrainExpectations,
  getBrainDecision,
  getBrainRollback,
  patchBrainDecision,
  recordDecision,
  saveBrainRollback,
  transitionBrainDecision,
} from "../../repo/brain-decisions.js";
import { insertBrainEvaluation } from "../../repo/brain-evaluations.js";
import {
  acceptMealPlan,
  currentMealPlan,
  deleteNutritionTarget,
  getActiveNutritionTarget,
  getMealPlan,
  setMealPlanStatus,
  setNutritionTarget,
} from "../../repo/nutrition.js";
import { getPlan, replacePlan } from "../../repo/plan.js";
import { applyProposal, getProposal, RECOVERY_WEEK_INSTRUCTION_PREFIX } from "../../repo/profile.js";
import { buildProgressionProposal } from "../../repo/progression.js";
import { buildRunPlanProposal } from "../../repo/run-progression.js";
import { getSettings } from "../../repo/settings.js";
import { setAppState } from "../../repo/app-state.js";
import { addDaysISO, localDateISO } from "../../repo/shared.js";
import { getSessionByDate } from "../../repo/sessions.js";

type ProposalShape = {
  kind: "nutrition_target" | "training_structure" | "training_target" | "exercise_rotation";
  domain: "nutrition" | "training" | "recovery";
  risk: "low" | "moderate";
};

function proposalShape(proposal: any): ProposalShape {
  if (proposal?.parsed?.kind === "nutrition_target")
    return { kind: "nutrition_target", domain: "nutrition", risk: "low" };
  if (Array.isArray(proposal?.parsed?.days)) {
    // The canonical recovery-week draft is stamped domain 'recovery' at WRITE time —
    // the conductor's "a lighter recovery week lands <weekday>" claim keys off this
    // structural marker, never off substring-matching the agent's free-text summary
    // (an unrelated restructure whose prose says "lighter" must not qualify).
    const recoveryWeek = String(proposal?.instruction ?? "").startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX);
    return { kind: "training_structure", domain: recoveryWeek ? "recovery" : "training", risk: "moderate" };
  }
  // A changes[] payload carrying a swap is an exercise rotation, not a bare target
  // tweak — classify it as such for the ledger. It stays low-risk/quiet_apply and
  // shares training_target's next-boundary + freshness handling (kind !== structure).
  if (Array.isArray(proposal?.parsed?.changes) && proposal.parsed.changes.some((change: any) => change?.swap))
    return { kind: "exercise_rotation", domain: "training", risk: "low" };
  return { kind: "training_target", domain: "training", risk: "low" };
}

function nextBoundary(kind: ProposalShape["kind"], today = localDateISO()): string {
  if (kind !== "training_structure") return addDaysISO(today, 1) ?? today;
  const date = new Date(`${today}T12:00:00Z`);
  const days = (8 - date.getUTCDay()) % 7 || 7;
  return addDaysISO(today, days) ?? today;
}

const PLAN_ITEM_FIELDS = [
  "exercise",
  "sets",
  "rep_low",
  "rep_high",
  "target_weight",
  "note",
  "warmup_sets",
  "target_seconds",
  "kind",
  "target_distance_km",
  "target_duration_min",
  "target_zone",
  "interval",
  "superset_group",
  "mode",
] as const;

function trainingPlanSnapshot(): any[] {
  return getPlan().map((day: any) => ({
    day_number: Number(day.day_number),
    name: String(day.name ?? ""),
    focus: day.focus == null ? null : String(day.focus),
    items: (Array.isArray(day.items) ? day.items : []).map((item: any) => {
      const clean: Record<string, any> = {};
      for (const field of PLAN_ITEM_FIELDS) {
        if (item[field] !== undefined) clean[field] = item[field];
      }
      return clean;
    }),
  }));
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function rollbackScalar(before: any, after: any, current: any): any {
  if (sameValue(before, after)) return current;
  return sameValue(current, after) ? before : current;
}

function rollbackItem(before: any, after: any, current: any): any {
  if (before == null && after != null) return sameValue(current, after) ? null : current;
  if (before != null && after == null) return current == null ? before : current;
  if (before == null || after == null || current == null) return current;
  const merged: Record<string, any> = {};
  for (const field of PLAN_ITEM_FIELDS) {
    const value = rollbackScalar(before[field], after[field], current[field]);
    if (value !== undefined) merged[field] = value;
  }
  return merged;
}

// Undo only the fields still owned by this decision. A later manual edit or a newer
// coaching decision wins: reverting an old bench target must never restore a stale
// whole-plan snapshot over a newly added run day, exercise, note, or target.
function mergeTrainingRollback(before: any[], after: any[], current: any[]): any[] {
  const byDay = (days: any[]) => new Map(days.map((day) => [Number(day.day_number), day]));
  const beforeDays = byDay(before);
  const afterDays = byDay(after);
  const currentDays = byDay(current);
  const dayNumbers = [...new Set([...beforeDays.keys(), ...afterDays.keys(), ...currentDays.keys()])].sort(
    (a, b) => a - b
  );
  const merged: any[] = [];
  for (const dayNumber of dayNumbers) {
    const b = beforeDays.get(dayNumber);
    const a = afterDays.get(dayNumber);
    const c = currentDays.get(dayNumber);
    if (b == null && a != null) {
      if (c != null && !sameValue(c, a)) merged.push(c);
      continue;
    }
    if (b != null && a == null) {
      merged.push(c ?? b);
      continue;
    }
    if (b == null || a == null || c == null) {
      if (c != null) merged.push(c);
      continue;
    }
    const itemCount = Math.max(b.items?.length ?? 0, a.items?.length ?? 0, c.items?.length ?? 0);
    const items: any[] = [];
    for (let position = 0; position < itemCount; position += 1) {
      const item = rollbackItem(b.items?.[position], a.items?.[position], c.items?.[position]);
      if (item != null) items.push(item);
    }
    merged.push({
      day_number: dayNumber,
      name: rollbackScalar(b.name, a.name, c.name),
      focus: rollbackScalar(b.focus, a.focus, c.focus),
      items,
    });
  }
  return merged;
}

function rollbackSnapshot(shape: ProposalShape): any {
  return shape.domain === "training"
    ? { kind: "training_plan", plan: trainingPlanSnapshot() }
    : { kind: "nutrition_target", previous: getActiveNutritionTarget() };
}

function trainingRollbackPayload(before: any[]): any {
  return { version: 2, before, after: trainingPlanSnapshot() };
}

function quietApplyMustWait(shape: ProposalShape): boolean {
  if (shape.domain === "nutrition") return true; // never change a partly-lived food day underneath the athlete
  try {
    const session = getSessionByDate(localDateISO()) as any;
    return !!session && !session.finished_at && Array.isArray(session.sets) && session.sets.length > 0;
  } catch {
    return false;
  }
}

function decisionForAppliedProposal(proposalId: number, result: any) {
  const targetId = Number(result?.accepted?.id);
  return (
    listBrainDecisions({ limit: 100 }).find((decision) => {
      const action = decision.action as any;
      if (Number(action?.plan_proposal_id) !== proposalId) return false;
      return targetId > 0 ? decision.source_ref_key === String(targetId) : true;
    }) ?? null
  );
}

function domainIsDemoted(domain: BrainDomain): boolean {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const recent = listBrainDecisions({ domain, limit: 100 }).filter(
    (decision) =>
      (decision.autonomy_tier === "quiet_apply" || decision.autonomy_tier === "announce") &&
      String(decision.created_at ?? "") >= cutoff
  );
  return domainShouldDemote(
    recent.filter((decision) => decision.status === "reverted").length,
    recent.filter((decision) => ["applied", "reverted"].includes(decision.status)).length
  );
}

// Material changes in this domain this week, by status set. The default counts every
// COMMITMENT — applied, announced, AND pending: a quiet-apply waiting for its boundary is
// already a committed material change, and leaving 'pending' out let a pending progression
// AND a same-week evolution both get scheduled (a budget of one means one). The boundary
// pass instead counts only what has LANDED (['applied']): due-but-unlanded siblings must
// not mutually block the pass — the oldest lands first, flips to 'applied', and THEN
// blocks the rest of the week's queue.
function materialChangesThisWeek(
  domain: BrainDomain,
  statuses: readonly string[] = ["applied", "announced", "pending"]
): number {
  const placeholders = statuses.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM brain_decisions
      WHERE domain = ? AND status IN (${placeholders}) AND autonomy_tier IN ('quiet_apply','announce')
        AND date(created_at) >= date('now','-6 days')`
    )
    .get(domain, ...statuses) as any;
  return Number(row?.n ?? 0);
}

function nextMealBoundary(today = localDateISO()): string {
  // A meal plan changes the next un-lived food day, never the day already under
  // way. That makes tomorrow the useful natural boundary regardless of which day
  // the weekly coach happened to run.
  return addDaysISO(today, 1) ?? today;
}

function liveAcceptedMealPlan(exceptId?: number): any | null {
  const plan = currentMealPlan() as any;
  return plan && ["accepted", "applied", "kept"].includes(String(plan.status)) && Number(plan.id) !== exceptId
    ? plan
    : null;
}

// Meal plans are structural enough to announce, but safe enough to land without an
// Apply ritual in lead mode: the verified plan becomes current tomorrow, the previous
// accepted week is retained as an exact rollback snapshot, and Hold/Undo always wins.
export function applyMealPlanWithAutonomy(
  planId: number,
  input: {
    requested_tier?: AutonomyTier;
    user_locked?: boolean;
    coordinated_update?: boolean;
  } = {}
): any {
  const plan = getMealPlan(planId) as any;
  if (!plan) return { ok: false, error: "meal plan not found" };
  if (plan.status !== "draft" || !Array.isArray(plan.parsed?.days)) {
    return { ok: true, applied: false, tier: "ask", plan, reasons: ["meal plan is not a live structured draft"] };
  }
  const createdAt = Date.parse(String(plan.created_at ?? ""));
  const ageDays = Number.isFinite(createdAt) ? Math.max(0, (Date.now() - createdAt) / 86_400_000) : Infinity;
  if (ageDays > 14) {
    return {
      ok: true,
      applied: false,
      review_required: true,
      tier: "ask",
      plan,
      reasons: ["meal-plan snapshot is older than 14 days; refresh it against the current picture first"],
    };
  }
  const policy = decideAutonomyTier({
    kind: "meal_plan",
    risk_class: "low",
    reversible: true,
    requested_tier: input.requested_tier,
    lead_mode: getSettings().lead_mode,
    user_locked: input.user_locked,
    domain_demoted: domainIsDemoted("nutrition"),
  });
  if (policy.tier === "ask" || policy.tier === "clinician" || policy.tier === "observe") {
    return { ok: true, applied: false, tier: policy.tier, plan, reasons: policy.reasons };
  }
  if (!input.coordinated_update && !surpriseBudgetAllows(materialChangesThisWeek("nutrition"))) {
    return {
      ok: true,
      applied: false,
      review_required: true,
      tier: "ask",
      plan,
      reasons: ["weekly nutrition change budget already used; this plan stays available for an explicit review"],
    };
  }

  // The freshest scheduled meal week wins. Retire its older queued alternatives so
  // no second plan can surprise-land at a later boundary.
  const queued = [
    ...listBrainDecisions({ status: "announced", kind: "meal_plan", limit: 50 }),
    ...listBrainDecisions({ status: "pending", kind: "meal_plan", limit: 50 }),
  ];
  for (const decision of queued) {
    const olderPlanId = Number((decision.action as any)?.meal_plan_id);
    if (olderPlanId > 0 && olderPlanId !== planId) {
      if ((getMealPlan(olderPlanId) as any)?.status === "draft")
        setMealPlanStatus(olderPlanId, "superseded", { recordDecision: false });
      transitionBrainDecision(decision.id!, "superseded");
    }
  }

  const previous = liveAcceptedMealPlan(planId);
  const effectiveDate = nextMealBoundary();
  const recorded = recordDecision({
    effective_date: effectiveDate,
    kind: "meal_plan",
    domain: "nutrition",
    summary: String(plan.parsed?.summary ?? "Your next meal plan is ready and will become current tomorrow.").slice(
      0,
      300
    ),
    rationale: String(
      plan.parsed?.rationale ??
        plan.parsed?.notes ??
        "Refreshed against your current training, nutrition target, health directives, and preferences."
    ).slice(0, 1_500),
    source: plan.agent || "autonomy",
    source_ref_type: "meal_plan",
    source_ref_key: String(plan.id),
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {
      natural_boundary: true,
      coordinated_update: input.coordinated_update === true,
      evidence_keys: [`meal_plan:${plan.id}`, "coach_context:nutrition"],
      evidence_observed_at: new Date().toISOString(),
    },
    action: { meal_plan_id: plan.id, previous_meal_plan_id: previous?.id ?? null },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
  return {
    ok: true,
    applied: false,
    announced: true,
    tier: "announce",
    effective_date: effectiveDate,
    decision: recorded.decision,
    plan: getMealPlan(planId),
  };
}

export function applyProposalWithAutonomy(
  proposalId: number,
  input: {
    requested_tier?: AutonomyTier;
    safety_response?: boolean;
    user_locked?: boolean;
    clamp_refused?: boolean;
  } = {}
): any {
  const proposal = getProposal(proposalId);
  if (!proposal) return { ok: false, error: "proposal not found" };
  const shape = proposalShape(proposal);
  const createdAt = Date.parse(String(proposal.created_at ?? ""));
  const ageDays = Number.isFinite(createdAt) ? Math.max(0, (Date.now() - createdAt) / 86_400_000) : Infinity;
  const freshnessDays = shape.kind === "training_structure" ? 14 : 7;
  if (ageDays > freshnessDays) {
    return {
      ok: true,
      applied: false,
      review_required: true,
      tier: "ask",
      proposal,
      reasons: [`proposal snapshot is older than ${freshnessDays} days; refresh it against the current plan first`],
    };
  }
  // The magnitude gate must not trust an agent-declared delta (the payload rarely
  // carries one): derive it from the proposed target against the active target so
  // a large calorie swing always announces instead of quiet-applying.
  let nutritionDelta = 0;
  if (shape.kind === "nutrition_target") {
    const proposedKcal = Number(proposal.parsed?.nutrition?.target_kcal);
    const activeKcal = Number((getActiveNutritionTarget() as any)?.target_kcal);
    nutritionDelta =
      Number.isFinite(proposedKcal) && Number.isFinite(activeKcal)
        ? proposedKcal - activeKcal
        : Number(proposal.parsed?.nutrition?.delta_kcal ?? proposal.parsed?.nutrition?.change_kcal ?? 0);
  }
  const policy = decideAutonomyTier({
    kind: shape.kind,
    risk_class: shape.risk,
    reversible: true,
    requested_tier: input.requested_tier,
    lead_mode: getSettings().lead_mode,
    magnitude: nutritionDelta,
    user_locked: input.user_locked,
    clamp_refused: input.clamp_refused,
    domain_demoted: domainIsDemoted(shape.domain),
  });
  if (policy.tier === "ask" || policy.tier === "clinician" || policy.tier === "observe") {
    return { ok: true, applied: false, tier: policy.tier, proposal, reasons: policy.reasons };
  }
  if (!surpriseBudgetAllows(materialChangesThisWeek(shape.domain), !!input.safety_response)) {
    return {
      ok: true,
      applied: false,
      review_required: true,
      tier: "ask",
      proposal,
      reasons: ["weekly surprise budget already used; review this change before applying"],
    };
  }
  if (policy.tier === "announce") {
    const effectiveDate = nextBoundary(shape.kind);
    const recorded = recordDecision({
      effective_date: effectiveDate,
      kind: shape.kind,
      domain: shape.domain,
      summary: String(proposal.parsed?.summary ?? "A coaching change is ready for the next natural boundary.").slice(
        0,
        300
      ),
      rationale: String(proposal.parsed?.rationale ?? proposal.instruction ?? "").slice(0, 1_500) || null,
      source: proposal.agent || "autonomy",
      source_ref_type: "plan_proposal",
      source_ref_key: String(proposal.id),
      status: "announced",
      autonomy_tier: "announce",
      risk_class: shape.risk,
      reversible: true,
      input_fingerprint: null,
      context: {
        natural_boundary: true,
        evidence_keys: [`plan_proposal:${proposal.id}`, `current_plan:${shape.domain}`],
        evidence_observed_at: new Date().toISOString(),
      },
      action: { proposal_id: proposal.id },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
    return {
      ok: true,
      applied: false,
      announced: true,
      tier: "announce",
      effective_date: effectiveDate,
      decision: recorded.decision,
    };
  }

  if (quietApplyMustWait(shape)) {
    const effectiveDate = nextBoundary(shape.kind);
    const recorded = recordDecision({
      effective_date: effectiveDate,
      kind: shape.kind,
      domain: shape.domain,
      summary: String(
        proposal.parsed?.summary ?? "A bounded coaching change is ready for the next natural boundary."
      ).slice(0, 300),
      rationale: String(proposal.parsed?.rationale ?? proposal.instruction ?? "").slice(0, 1_500) || null,
      source: proposal.agent || "autonomy",
      source_ref_type: "plan_proposal",
      source_ref_key: String(proposal.id),
      status: "pending",
      autonomy_tier: "quiet_apply",
      risk_class: shape.risk,
      reversible: true,
      input_fingerprint: null,
      context: {
        natural_boundary: true,
        quiet: true,
        evidence_keys: [`plan_proposal:${proposal.id}`, `current_plan:${shape.domain}`],
        evidence_observed_at: new Date().toISOString(),
      },
      action: { proposal_id: proposal.id },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
    return {
      ok: true,
      applied: false,
      pending: true,
      tier: "quiet_apply",
      effective_date: effectiveDate,
      decision: recorded.decision,
    };
  }

  const rollback = rollbackSnapshot(shape);
  const result = applyProposal(proposalId, { supersedeSiblings: false }) as any;
  if (!result?.ok) return { ...result, tier: policy.tier };
  const decision = decisionForAppliedProposal(proposalId, result);
  if (!decision) return { ...result, tier: policy.tier, decision: null };
  const updated = patchBrainDecision(decision.id!, {
    autonomy_tier: "quiet_apply",
    reversible: true,
    context: { ...(decision.context ?? {}), rollback_available: true },
  });
  saveBrainRollback(
    decision.id!,
    rollback.kind,
    rollback.kind === "training_plan" ? trainingRollbackPayload(rollback.plan) : rollback.previous
  );
  return { ...result, tier: "quiet_apply", decision: updated };
}

// Build the deterministic per-day auto-progression draft, then route it through the
// autonomy layer — THE shared REST+MCP entry so the two surfaces can't drift (MCP ⊆
// REST). Under lead_mode='lead' a bounded, reversible target nudge (buildProgression
// only ever emits `changes`, i.e. kind 'training_target') quiet-applies at its natural
// boundary with the decision + Undo bookkeeping applyProposalWithAutonomy already owns;
// under 'announce_first' it announces first; under 'review_everything' the layer returns
// tier 'ask' and the draft stays a plain reviewable draft (no decision recorded), exactly
// as before. `requested_tier:'quiet_apply'` mirrors the brain-review boundary path
// (executeBrainReviewAction) and never LOOSENS policy — decideAutonomyTier only ever
// clamps to a MORE restrictive tier. A designed ok:false (nothing to propose) passes
// straight through unchanged.
export function buildProgressionWithAutonomy(
  day: number
): { ok: false; error: string } | { ok: true; proposal: any; autonomy: any } {
  const built = buildProgressionProposal(day);
  if (!built.ok) return built;
  const autonomy = applyProposalWithAutonomy(Number(built.proposal.id), { requested_tier: "quiet_apply" });
  return { ok: true, proposal: built.proposal, autonomy };
}

// Endurance is a first-class programmed modality. Its deterministic weekly run
// mix follows the same lead/review policy as strength progression instead of
// stopping at a separate draft-and-Apply ritual.
export function buildRunPlanWithAutonomy(
  date?: string
): { ok: false; error: string } | { ok: true; proposal: any; autonomy: any } {
  const built = buildRunPlanProposal(date);
  if (!built.ok) return built;
  const autonomy = applyProposalWithAutonomy(Number(built.proposal.id), { requested_tier: "quiet_apply" });
  return { ok: true, proposal: built.proposal, autonomy };
}

export function applyDueAnnouncedDecisions(asOf = localDateISO()): { applied: number[]; failed: number[] } {
  const due = [
    ...listBrainDecisions({ status: "announced", limit: 100 }),
    ...listBrainDecisions({ status: "pending", limit: 100 }).filter(
      (decision) => decision.autonomy_tier === "quiet_apply"
    ),
  ]
    .filter(
      (decision) =>
        !!decision.effective_date &&
        decision.effective_date <= asOf &&
        (Number((decision.action as any)?.proposal_id) > 0 || Number((decision.action as any)?.meal_plan_id) > 0)
    )
    // OLDEST first (listBrainDecisions returns id DESC): when several decisions share a
    // boundary the newest read must land LAST and win — otherwise a stale restructure
    // could overwrite a fresher one that happened to sort earlier.
    .sort((a, b) => Number(a.id) - Number(b.id));
  const applied: number[] = [];
  const failed: number[] = [];
  // A decision that cannot apply must reach a terminal/reviewable status here.
  // Leaving it announced/pending would re-select it on every future pass, and a
  // throwing payload would otherwise wedge the boundary applier for every
  // later decision in the queue.
  const parkForReview = (decision: (typeof due)[number], reason: string) => {
    try {
      patchBrainDecision(decision.id!, {
        status: "review",
        reversible: false,
        context: { ...(decision.context ?? {}), review_required: true, apply_error: reason.slice(0, 300) },
      });
    } catch {
      /* the pass must survive even when the parking write fails */
    }
    failed.push(decision.id!);
  };
  for (const announced of due) {
    try {
      const mealPlanId = Number((announced.action as any)?.meal_plan_id);
      if (mealPlanId > 0) {
        const plan = getMealPlan(mealPlanId) as any;
        if (!plan || plan.status !== "draft" || !Array.isArray(plan.parsed?.days)) {
          transitionBrainDecision(announced.id!, "canceled");
          failed.push(announced.id!);
          continue;
        }
        const coordinated = (announced.context as any)?.coordinated_update === true;
        if (!coordinated && !surpriseBudgetAllows(materialChangesThisWeek("nutrition", ["applied"]))) {
          parkForReview(
            announced,
            "weekly nutrition change budget already used; review this meal plan before applying"
          );
          continue;
        }
        const createdAt = Date.parse(String(plan.created_at ?? ""));
        const ageDays = Number.isFinite(createdAt) ? Math.max(0, (Date.now() - createdAt) / 86_400_000) : Infinity;
        if (ageDays > 14) {
          patchBrainDecision(announced.id!, {
            status: "rejected",
            autonomy_tier: "ask",
            reversible: false,
            context: { ...(announced.context ?? {}), review_required: true, stale_plan: true },
          });
          failed.push(announced.id!);
          continue;
        }
        const previousId = Number((announced.action as any)?.previous_meal_plan_id) || null;
        const accepted = acceptMealPlan(mealPlanId, { recordDecision: false });
        if (!accepted) {
          parkForReview(announced, "the meal plan could not become current");
          continue;
        }
        transitionBrainDecision(announced.id!, "applied");
        const updated = patchBrainDecision(announced.id!, {
          context: { ...(announced.context ?? {}), rollback_available: true },
          reversible: true,
        });
        saveBrainRollback(announced.id!, "meal_plan", {
          version: 1,
          previous_meal_plan_id: previousId,
          applied_meal_plan_id: mealPlanId,
        });
        if (!updated) {
          parkForReview(announced, "the meal-plan decision could not be finalized");
          continue;
        }
        applied.push(announced.id!);
        continue;
      }
      const proposalId = Number((announced.action as any)?.proposal_id);
      const proposal = getProposal(proposalId);
      if (!proposal) {
        parkForReview(announced, "the linked proposal no longer exists");
        continue;
      }
      if (proposal.status !== "draft") {
        // The proposal is no longer live: applied elsewhere (a manual apply), discarded
        // (the user's explicit veto), or superseded by a fresher draft. The announcement
        // is moot and must NEVER apply at the boundary — a boundary pass re-applying a
        // vetoed replacePlan would be the worst possible surprise.
        transitionBrainDecision(announced.id!, "canceled");
        failed.push(announced.id!);
        continue;
      }
      const shape = proposalShape(proposal);
      // Re-check the surprise budget at the boundary against what has LANDED this week:
      // the world may have moved since the decision was recorded — an earlier decision in
      // this same pass, or a mid-week quiet apply, already used this domain's budget.
      // Counting 'applied' only (not other pending/announced siblings) keeps two due
      // decisions from mutually blocking each other: the oldest lands, becomes 'applied',
      // and then blocks the rest.
      if (!surpriseBudgetAllows(materialChangesThisWeek(shape.domain, ["applied"]))) {
        parkForReview(announced, "weekly surprise budget already used; review this change before applying");
        continue;
      }
      const createdAt = Date.parse(String(proposal.created_at ?? ""));
      const freshnessDays = shape.kind === "training_structure" ? 14 : 7;
      const ageDays = Number.isFinite(createdAt) ? Math.max(0, (Date.now() - createdAt) / 86_400_000) : Infinity;
      if (ageDays > freshnessDays) {
        patchBrainDecision(announced.id!, {
          status: "rejected",
          autonomy_tier: "ask",
          reversible: false,
          context: {
            ...(announced.context ?? {}),
            review_required: true,
            stale_proposal: true,
            stale_after_days: freshnessDays,
          },
        });
        failed.push(announced.id!);
        continue;
      }
      const rollback = rollbackSnapshot(shape);
      const result = applyProposal(proposalId, {
        supersedeSiblings: false,
        decisionId: announced.id!,
      }) as any;
      if (!result?.ok) {
        parkForReview(announced, String(result?.error ?? "the change could not be applied"));
        continue;
      }
      const updated = getBrainDecision(announced.id!);
      if (!updated || updated.status !== "applied") {
        parkForReview(announced, "the decision did not reach applied status");
        continue;
      }
      patchBrainDecision(announced.id!, {
        context: { ...(updated.context ?? {}), rollback_available: true },
        reversible: true,
      });
      saveBrainRollback(
        announced.id!,
        rollback.kind,
        rollback.kind === "training_plan" ? trainingRollbackPayload(rollback.plan) : rollback.previous
      );
      if (shape.kind === "nutrition_target") {
        // Meals are a downstream expression of the fuel target. Ask the background
        // team to rebuild them from the newly active number; the scheduler owns the
        // agent call and retry cadence, keeping this boundary pass deterministic.
        setAppState("meal_plan_refresh_requested", asOf);
      }
      applied.push(announced.id!);
    } catch (error: any) {
      parkForReview(announced, String(error?.message ?? error ?? "unexpected apply error"));
    }
  }
  return { applied, failed };
}

// A veto teaches the brain DETERMINISTICALLY, not anecdotally: the reverted
// status feeds domainIsDemoted's 90-day revert-rate (repeated vetoes drop the
// domain to announce-first) and the expectation closes as 'canceled'. One veto
// deliberately does NOT become a reaction-model "personality fact" — the plan's
// causal-hygiene rule (learn policies, not anecdotes) wins over single events.
export function revertDecision(id: number, reason = "user veto"): { ok: boolean; decision?: any; error?: string } {
  const decision = getBrainDecision(id);
  if (decision?.status === "announced") {
    const mealPlanId = Number((decision.action as any)?.meal_plan_id);
    if (mealPlanId > 0 && (getMealPlan(mealPlanId) as any)?.status === "draft")
      setMealPlanStatus(mealPlanId, "superseded", { recordDecision: false });
    const canceled = transitionBrainDecision(id, "canceled");
    return { ok: true, decision: canceled };
  }
  if (!decision || decision.status !== "applied" || !decision.reversible)
    return { ok: false, error: "decision is not reversible" };
  const rollback = getBrainRollback(id);
  try {
    if (rollback?.kind === "training_plan" && Array.isArray(rollback.payload)) {
      // Legacy snapshots remain reversible. New writes use a three-way snapshot below.
      replacePlan(rollback.payload);
    } else if (
      rollback?.kind === "training_plan" &&
      rollback.payload?.version === 2 &&
      Array.isArray(rollback.payload.before) &&
      Array.isArray(rollback.payload.after)
    ) {
      replacePlan(mergeTrainingRollback(rollback.payload.before, rollback.payload.after, trainingPlanSnapshot()));
    } else if (rollback?.kind === "nutrition_target") {
      const appliedTargetId = Number(decision.source_ref_type === "nutrition_target" ? decision.source_ref_key : 0);
      if (appliedTargetId > 0) deleteNutritionTarget(appliedTargetId);
      if (rollback.payload)
        setNutritionTarget({ ...rollback.payload, source: "undo", note: `Restored after ${reason}` });
    } else if (rollback?.kind === "meal_plan" && rollback.payload?.version === 1) {
      const appliedId = Number(rollback.payload.applied_meal_plan_id);
      const previousId = Number(rollback.payload.previous_meal_plan_id);
      const current = currentMealPlan() as any;
      // A later accepted meal plan wins. Undo only changes the meal plan when this
      // decision still owns the current one.
      if (appliedId > 0 && Number(current?.id) === appliedId) {
        setMealPlanStatus(appliedId, "superseded", { recordDecision: false });
        if (previousId > 0 && getMealPlan(previousId)) acceptMealPlan(previousId, { recordDecision: false });
      }
    } else {
      return { ok: false, error: "rollback snapshot unavailable" };
    }
    for (const expectation of listBrainExpectations({ decisionId: id })) {
      try {
        insertBrainEvaluation({
          expectation_id: expectation.id!,
          verdict: "canceled",
          actual: null,
          evidence_keys: [],
          confounders: [reason],
          explanation: "This was stopped before we could tell because the user asked to put it back.",
          evaluator_version: `${expectation.evaluator_version}/user-veto`,
        });
      } catch {}
    }
    const reverted = transitionBrainDecision(id, "reverted");
    return { ok: true, decision: reverted };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
