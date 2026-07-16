import { db } from "../../db.js";
import { decideAutonomyTier, domainShouldDemote, surpriseBudgetAllows } from "../../brain/autonomy.js";
import type { AutonomyTier, BrainDomain } from "../../brain/decision-contract.js";
import {
  hasRecentDecisionVeto,
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
  getNutritionTarget,
  restoreMealPlanAfterUndo,
  setMealPlanStatus,
  setNutritionTarget,
  validateMealPlanForPersistence,
} from "../../repo/nutrition.js";
import { getPlan, replacePlan } from "../../repo/plan.js";
import {
  applyProposal,
  getProposal,
  listProposals,
  type NormalizedProposalApplyPayload,
  type OrphanSiblingCleanup,
  RECOVERY_WEEK_INSTRUCTION_PREFIX,
  revertRecoveryWeekIfOwned,
} from "../../repo/profile.js";
import { MEAL_REFRESH_REQUEST_KEY } from "../../repo/meal-refresh-retry.js";
import { automaticOrphanIntent, chatOrphanIntent } from "../../repo/proposal-intent.js";
import { buildProgressionProposal } from "../../repo/progression.js";
import { buildRunPlanProposal } from "../../repo/run-progression.js";
import { getSettings } from "../../repo/settings.js";
import { setAppStateStrict } from "../../repo/app-state.js";
import { addDaysISO, localDateISO, parseDbTime } from "../../repo/shared.js";
import { getSessionByDate } from "../../repo/sessions.js";
import { withSqliteSavepoint } from "../../repo/sqlite-savepoint.js";

// Ruling A: the two deterministic progression builders — buildProgressionProposal
// (createProposal agent "auto-progression", src/repo/progression.ts) and
// buildRunPlanProposal (agent "auto-run-plan", src/repo/run-progression.ts) — emit
// bounded, guardrail-clamped, reversible, ledgered target nudges: the coach's standing
// job, not a surprise. A routine progression neither consumes the weekly surprise budget
// nor is blocked by it. decideAutonomyTier's clamps (domain demotion / review posture /
// clinical) and the boundary + freshness gates still apply unchanged. These agent
// literals are stable contract values written by createProposal, not free text.
const ROUTINE_CHANGE_SOURCES = new Set(["auto-progression", "auto-run-plan"]);

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

type ProposalReviewReasonCode =
  | "stale_snapshot"
  | "safety_floor"
  | "user_lock"
  | "review_posture"
  | "requested_review"
  | "domain_policy"
  | "budget_review";

function holdProposalForReview(
  proposal: any,
  shape: ProposalShape,
  input: {
    code: ProposalReviewReasonCode;
    reasons: string[];
    tier?: AutonomyTier;
    policy_inputs?: Record<string, unknown>;
    coordination_key?: string | null;
    coordinated_update?: boolean;
  }
): any {
  const reasons = input.reasons.map((reason) => String(reason).trim().slice(0, 300)).filter(Boolean);
  const tier = input.tier === "clinician" ? "clinician" : "ask";
  const recorded = recordDecision({
    effective_date: null,
    kind: shape.kind,
    domain: shape.domain,
    summary: String(proposal.parsed?.summary ?? "A coaching change needs your decision.").slice(0, 300),
    rationale: String(proposal.parsed?.rationale ?? proposal.instruction ?? "").slice(0, 1_500) || null,
    source: proposal.agent || "autonomy",
    source_ref_type: "plan_proposal",
    source_ref_key: String(proposal.id),
    status: "review",
    autonomy_tier: tier,
    risk_class: shape.risk,
    reversible: false,
    input_fingerprint: null,
    context: {
      review_required: true,
      review_reason_code: input.code,
      review_reasons: reasons,
      policy_inputs: input.policy_inputs ?? {},
      coordination_key: input.coordination_key ?? null,
      coordinated_update: input.coordinated_update === true,
      evidence_keys: [`plan_proposal:${proposal.id}`, `current_plan:${shape.domain}`],
      evidence_observed_at: new Date().toISOString(),
    },
    action: { proposal_id: proposal.id, review_reason_code: input.code },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;
  return {
    ok: true,
    applied: false,
    review_required: true,
    tier,
    proposal: getProposal(Number(proposal.id)),
    reasons,
    decision: recorded,
    review_reason_code: input.code,
  };
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

function planItemIdentityBase(item: any): string {
  const kind = item?.kind === "cardio" ? "cardio" : "strength";
  const label = String(
    kind === "cardio" ? (item?.exercise ?? item?.note ?? item?.target_zone ?? "cardio") : (item?.exercise ?? "")
  )
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return `${kind}|${label || "unknown"}`;
}

function indexedPlanItems(items: any[]): Array<{ key: string; base: string; item: any }> {
  const counts = new Map<string, number>();
  return (Array.isArray(items) ? items : []).map((item) => {
    const base = planItemIdentityBase(item);
    const occurrence = (counts.get(base) ?? 0) + 1;
    counts.set(base, occurrence);
    return { key: `${base}#${occurrence}`, base, item };
  });
}

// Undo only the fields still owned by this decision. A later manual edit or a newer
// coaching decision wins: reverting an old bench target must never restore a stale
// whole-plan snapshot over a newly added run day, exercise, note, or target.
function mergeTrainingRollback(before: any[], after: any[], current: any[], swaps: any[] = []): any[] {
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
    const beforeItems = indexedPlanItems(b.items);
    const afterItems = indexedPlanItems(a.items);
    const currentItems = indexedPlanItems(c.items);
    const beforeByKey = new Map(beforeItems.map((entry) => [entry.key, entry]));
    const afterByKey = new Map(afterItems.map((entry) => [entry.key, entry]));
    const rotations = new Map<string, { beforeKey: string; afterKey: string }>();
    const usedBefore = new Set<string>();
    const usedAfter = new Set<string>();
    for (const swap of (Array.isArray(swaps) ? swaps : []).filter(
      (entry: any) => Number(entry?.day_number) === dayNumber
    )) {
      const fromBase = planItemIdentityBase({ kind: "strength", exercise: swap?.from });
      const toBase = planItemIdentityBase({ kind: "strength", exercise: swap?.to });
      const from = beforeItems.find((entry) => entry.base === fromBase && !usedBefore.has(entry.key));
      const to = afterItems.find((entry) => entry.base === toBase && !usedAfter.has(entry.key));
      if (!from || !to) continue;
      usedBefore.add(from.key);
      usedAfter.add(to.key);
      rotations.set(to.key, { beforeKey: from.key, afterKey: to.key });
    }
    const items: any[] = [];
    const handledBefore = new Set<string>();
    for (const currentEntry of currentItems) {
      const rotation = rotations.get(currentEntry.key);
      const rotatedFrom = rotation ? beforeByKey.get(rotation.beforeKey) : null;
      const rotatedTo = rotation ? afterByKey.get(rotation.afterKey) : null;
      if (rotatedFrom && rotatedTo && sameValue(currentEntry.item, rotatedTo.item)) {
        items.push(rotatedFrom.item);
        handledBefore.add(rotatedFrom.key);
        continue;
      }
      const beforeEntry = beforeByKey.get(currentEntry.key);
      const afterEntry = afterByKey.get(currentEntry.key);
      const item = rollbackItem(beforeEntry?.item, afterEntry?.item, currentEntry.item);
      if (item != null) items.push(item);
      if (beforeEntry) handledBefore.add(beforeEntry.key);
    }
    // A decision-owned removal (including the `from` side of a rotation) is the
    // only missing item restored. Current-only insertions and user removals remain.
    for (const beforeEntry of beforeItems) {
      if (handledBefore.has(beforeEntry.key)) continue;
      const item = rollbackItem(beforeEntry.item, afterByKey.get(beforeEntry.key)?.item, null);
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
  return shape.domain !== "nutrition"
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
//
// An optional `kind` narrows the count to one change-kind. Nutrition budgets PER KIND: the
// standing weekly meal-plan refresh (announced, boundary-applied every week) and a bounded
// ±kcal target nudge are one coordinated story, not two independent surprises. Counting them
// together let the recurring meal refresh spend the whole nutrition budget, so every bounded
// target nudge demoted to 'ask' — neutering lead mode for the number that matters most.
// Training stays domain-wide (its per-domain churn cap is a real, intended limit). Two
// changes of the SAME kind in one week still hold: the budget is one, per kind.
//
// Ruling A: routine deterministic progressions (ROUTINE_CHANGE_SOURCES) are excluded — a
// standing, guardrail-clamped nudge is not a material surprise, so it neither consumes the
// budget nor counts against another change trying to land the same week.
function materialChangesThisWeek(
  domain: BrainDomain,
  statuses: readonly string[] = ["applied", "announced", "pending"],
  kind?: string | null
): number {
  const placeholders = statuses.map(() => "?").join(",");
  const kindClause = kind ? " AND kind = ?" : "";
  const routinePlaceholders = [...ROUTINE_CHANGE_SOURCES].map(() => "?").join(",");
  const params: any[] = [domain, ...statuses];
  if (kind) params.push(kind);
  params.push(...ROUTINE_CHANGE_SOURCES);
  const row = db
    .prepare(
      // NULL-safe: `source NOT IN (...)` alone is SQL three-valued logic — a material-tier
      // writer that left source NULL would evaluate NULL and be silently excluded,
      // undercounting the budget. A NULL source is not a routine progression, so keep it.
      `SELECT COUNT(*) AS n FROM brain_decisions
      WHERE domain = ? AND status IN (${placeholders}) AND autonomy_tier IN ('quiet_apply','announce')${kindClause}
        AND (source IS NULL OR source NOT IN (${routinePlaceholders}))
        AND date(created_at) >= date('now','-6 days')`
    )
    .get(...params) as any;
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
  const safety = validateMealPlanForPersistence(plan.parsed);
  if (!safety.ok) {
    return {
      ok: false,
      applied: false,
      tier: "ask",
      plan,
      error: safety.error,
      reasons: ["meal totals do not match the canonical daily nutrition target"],
    };
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
  if (
    !input.coordinated_update &&
    !surpriseBudgetAllows(materialChangesThisWeek("nutrition", undefined, "meal_plan"))
  ) {
    return {
      ok: true,
      applied: false,
      review_required: true,
      tier: "ask",
      plan,
      reasons: ["weekly nutrition change budget already used; this plan stays available for an explicit review"],
    };
  }

  const effectiveDate = nextMealBoundary();
  const recorded = withSqliteSavepoint(`schedule_meal_plan_${planId}`, () => {
    // The freshest scheduled meal week wins. Retire its older queued alternatives
    // in the same commit as the new owner so a ledger failure cannot strand both.
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
    return recordDecision({
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
      reversible: false,
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

// A later successful routing of the SAME proposal (announce / pending quiet-apply /
// immediate apply) makes any earlier HOLD on that proposal moot — the hold said "wait",
// and the system has now landed or scheduled it. Retire the stale live `review` rows to
// 'superseded' so a freed budget hold never leaves a dangling open review decision in the
// ledger (which listReviewHeldProposals / planDraftCandidate would otherwise keep reading).
function supersedePriorReviewHolds(proposalId: number): void {
  for (const decision of listBrainDecisions({ status: "review", limit: 100 })) {
    if (
      decision.source_ref_type === "plan_proposal" &&
      decision.source_ref_key === String(proposalId) &&
      decision.id != null
    ) {
      transitionBrainDecision(decision.id, "superseded");
    }
  }
}

export function applyProposalWithAutonomy(
  proposalId: number,
  input: {
    requested_tier?: AutonomyTier;
    safety_response?: boolean;
    user_locked?: boolean;
    clamp_refused?: boolean;
    // A direct, current-turn request to edit the active plan is not a surprise and
    // has already named its boundary. This does not loosen lead_mode or safety tiers.
    explicit_user_request?: boolean;
    // Internal scheduler repair metadata. Only explicit-provenance orphan adoption
    // supplies this; ordinary chat/manual/public callers cannot request sibling cleanup.
    orphan_sibling_cleanup?: OrphanSiblingCleanup;
    // A history-preserving compatibility payload used only by the exact legacy
    // background-chat repair. The source proposal row remains byte-for-byte intact.
    normalized_apply_payload?: NormalizedProposalApplyPayload;
    // Several bounded decisions may form one protective package (for example a
    // recovery week plus fuel moving toward maintenance). The key links their
    // ledger rows; `coordinated_update` lets that package cross a natural boundary
    // together without each half consuming the other's surprise budget.
    coordination_key?: string;
    coordinated_update?: boolean;
  } = {}
): any {
  const proposal = getProposal(proposalId);
  if (!proposal) return { ok: false, error: "proposal not found" };
  const shape = proposalShape(proposal);
  const createdAt = Date.parse(String(proposal.created_at ?? ""));
  const ageDays = Number.isFinite(createdAt) ? Math.max(0, (Date.now() - createdAt) / 86_400_000) : Infinity;
  const freshnessDays = shape.kind === "training_structure" ? 14 : 7;
  if (ageDays > freshnessDays) {
    return holdProposalForReview(proposal, shape, {
      code: "stale_snapshot",
      reasons: [`proposal snapshot is older than ${freshnessDays} days; refresh it against the current plan first`],
      coordination_key: input.coordination_key,
      coordinated_update: input.coordinated_update,
    });
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
  const domainDemoted = domainIsDemoted(shape.domain);
  const leadMode = getSettings().lead_mode;
  const policy = decideAutonomyTier({
    kind: shape.kind,
    risk_class: shape.risk,
    reversible: true,
    requested_tier: input.requested_tier,
    lead_mode: leadMode,
    magnitude: nutritionDelta,
    user_locked: input.user_locked,
    clamp_refused: input.clamp_refused,
    domain_demoted: domainDemoted,
  });
  if (policy.tier === "ask" || policy.tier === "clinician" || policy.tier === "observe") {
    const code: ProposalReviewReasonCode = input.clamp_refused
      ? "safety_floor"
      : input.user_locked
        ? "user_lock"
        : leadMode === "review_everything"
          ? "review_posture"
          : input.requested_tier === "ask"
            ? "requested_review"
            : domainDemoted
              ? "domain_policy"
              : "requested_review";
    return holdProposalForReview(proposal, shape, {
      code,
      reasons: policy.reasons.length ? policy.reasons : ["This change was explicitly routed for review."],
      tier: policy.tier,
      policy_inputs: {
        requested_tier: input.requested_tier ?? null,
        lead_mode: leadMode,
        user_locked: !!input.user_locked,
        clamp_refused: !!input.clamp_refused,
        domain_demoted: domainDemoted,
      },
      coordination_key: input.coordination_key,
      coordinated_update: input.coordinated_update,
    });
  }
  // Nutrition budgets per change-kind (a bounded target nudge must not be blocked by the
  // standing weekly meal refresh); training stays domain-wide.
  const budgetKind = shape.domain === "nutrition" ? shape.kind : undefined;
  // Ruling A: a routine deterministic progression bypasses the surprise-budget gate
  // (materialChangesThisWeek also excludes it from the count, so it never spends the
  // budget for other changes either).
  const routineChange = ROUTINE_CHANGE_SOURCES.has(String(proposal.agent ?? ""));
  if (
    !surpriseBudgetAllows(
      materialChangesThisWeek(shape.domain, undefined, budgetKind),
      !!input.safety_response || !!input.explicit_user_request || routineChange
    )
  ) {
    return holdProposalForReview(proposal, shape, {
      code: "budget_review",
      reasons: ["weekly surprise budget already used; review this change before applying"],
      policy_inputs: { lead_mode: leadMode, safety_response: !!input.safety_response },
      coordination_key: input.coordination_key,
      coordinated_update: input.coordinated_update,
    });
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
      reversible: false,
      input_fingerprint: null,
      context: {
        natural_boundary: true,
        coordination_key: input.coordination_key ?? null,
        coordinated_update: input.coordinated_update === true,
        orphan_sibling_cleanup: input.orphan_sibling_cleanup ?? null,
        normalized_apply_payload: input.normalized_apply_payload ?? null,
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
    supersedePriorReviewHolds(Number(proposal.id));
    return {
      ok: true,
      applied: false,
      announced: true,
      tier: "announce",
      effective_date: effectiveDate,
      decision: recorded.decision,
    };
  }

  if (quietApplyMustWait(shape) && !input.explicit_user_request) {
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
      reversible: false,
      input_fingerprint: null,
      context: {
        natural_boundary: true,
        quiet: true,
        coordination_key: input.coordination_key ?? null,
        coordinated_update: input.coordinated_update === true,
        orphan_sibling_cleanup: input.orphan_sibling_cleanup ?? null,
        normalized_apply_payload: input.normalized_apply_payload ?? null,
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
    supersedePriorReviewHolds(Number(proposal.id));
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
  try {
    return withSqliteSavepoint(`autonomy_apply_${proposalId}`, () => {
      const result = applyProposal(proposalId, {
        orphanSiblingCleanup: input.orphan_sibling_cleanup,
        normalizedApplyPayload: input.normalized_apply_payload,
        requireDecisionLedger: true,
      }) as any;
      if (!result?.ok) return { ...result, tier: policy.tier };
      const decision = decisionForAppliedProposal(proposalId, result);
      if (!decision?.id) throw new Error("the autonomous apply decision was not stored");
      if (
        !saveBrainRollback(
          decision.id,
          rollback.kind,
          rollback.kind === "training_plan" ? trainingRollbackPayload(rollback.plan) : rollback.previous
        )
      ) {
        throw new Error("the autonomous rollback snapshot was not stored");
      }
      const updated = patchBrainDecision(decision.id, {
        autonomy_tier: "quiet_apply",
        reversible: true,
        context: {
          ...(decision.context ?? {}),
          rollback_available: true,
          coordination_key: input.coordination_key ?? null,
          coordinated_update: input.coordinated_update === true,
          ...(input.normalized_apply_payload ? { legacy_migration: input.normalized_apply_payload.migration } : {}),
        },
      });
      if (!updated) throw new Error("the autonomous apply decision could not be finalized");
      supersedePriorReviewHolds(proposalId);
      return { ...result, tier: "quiet_apply", decision: updated };
    });
  } catch (error) {
    return {
      ok: false,
      applied: false,
      tier: policy.tier,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Build the deterministic per-day auto-progression draft, then route it through the
// autonomy layer — THE shared REST+MCP entry so the two surfaces can't drift (MCP ⊆
// REST). Under lead_mode='lead' a bounded, reversible target nudge (buildProgression
// only ever emits `changes`, i.e. kind 'training_target') quiet-applies at its natural
// boundary with the decision + Undo bookkeeping applyProposalWithAutonomy already owns;
// under 'announce_first' it announces first; under 'review_everything' the layer records
// an explicit review decision so Today can distinguish a genuine ask from automatic
// orphan noise. `requested_tier:'quiet_apply'` mirrors the brain-review boundary path
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

// A grace window before a bare draft is eligible for adoption. A just-created draft
// may be mid-conversation in chat — the athlete could be looking at it right now — so
// we never yank it into the autonomy ledger the instant it appears.
const ORPHAN_ADOPTION_GRACE_MS = 2 * 60 * 60 * 1000;

function legacyBackgroundNormalizedPayload(
  proposal: any,
  sourceBurstProposalIds: number[]
): NormalizedProposalApplyPayload | undefined {
  const changes = Array.isArray(proposal?.parsed?.changes) ? proposal.parsed.changes : null;
  if (!changes) return undefined;
  const normalizedChanges: NormalizedProposalApplyPayload["migration"]["normalized_changes"] = [];
  const normalized = changes.map((change: any) => {
    const sets = change?.sets;
    const isLegacyZero =
      sets != null &&
      !(typeof sets === "string" && sets.trim() === "") &&
      Number.isFinite(Number(sets)) &&
      Number(sets) === 0 &&
      change?.remove !== true;
    if (!isLegacyZero) return { ...change };
    const { sets: _legacySets, ...rest } = change;
    normalizedChanges.push({
      day_number: Number.isFinite(Number(change?.day_number)) ? Math.trunc(Number(change.day_number)) : null,
      exercise: change?.exercise == null ? null : String(change.exercise),
      from: "sets:0",
      to: "remove:true",
    });
    return { ...rest, remove: true };
  });
  if (!normalizedChanges.length) return undefined;
  return {
    parsed: { ...proposal.parsed, changes: normalized },
    migration: {
      code: "legacy_background_sets_zero_to_remove",
      reason:
        "Historical background-chat plan actions encoded an intended skip as sets:0; repair translates only that retired encoding to explicit remove:true before current quality validation.",
      source_ref_type: "plan_proposal",
      source_proposal_id: Number(proposal.id),
      source_burst_proposal_ids: [...new Set(sourceBurstProposalIds.map(Number).filter(Number.isFinite))].sort(
        (a, b) => a - b
      ),
      normalized_changes: normalizedChanges,
    },
  };
}

// Self-healing for orphaned drafts. A bounded, reversible change can end up parked as
// a bare `draft` with no autonomy decision behind it — e.g. an older policy demoted it
// to a review-only draft, or it was proposed in a week whose surprise budget was already
// spent. Nothing re-evaluated it when conditions changed, so it sat forever showing
// "NEEDS YOUR DECISION" while the product promises changes arrive automatically. This
// pass re-offers each such draft to the autonomy layer so the system adapts without the
// athlete: when the budget week rolls over, a veto ages out, or the posture is loosened,
// a later pass adopts it (deterministic, no agent calls).
export function adoptOrphanedDrafts(): { adopted: number; skipped: number } {
  let adopted = 0;
  let skipped = 0;
  const now = Date.now();
  const leadMode = getSettings().lead_mode;
  // Newest first (listProposals orders id DESC): at most one orphan per explicit
  // provenance + SEMANTIC intent is adopted. Legacy chat drafts qualify only in
  // coach-led postures and only through an explicit persisted chat provenance.
  // The historical `background: chat signal` path additionally clusters iterative
  // same-day retries into bounded 30-minute bursts; a later/earlier burst remains
  // independently evaluable instead of being blocked forever by one owned retry.
  const handledIntents = new Set<string>();
  const backgroundBurstAnchors = new Map<string, number[]>();
  const eligibleBefore = new Date(now - ORPHAN_ADOPTION_GRACE_MS).toISOString();
  const proposals = listProposals(50) as any[];
  for (const proposal of proposals) {
    try {
      if (proposal?.status !== "draft") continue;
      const shape = proposalShape(proposal);
      const automaticIntent = automaticOrphanIntent(proposal);
      const chatIntent = leadMode === "review_everything" ? null : chatOrphanIntent(proposal);
      const orphanIntent = automaticIntent ?? chatIntent;
      const provenance = automaticIntent ? ("automatic" as const) : chatIntent?.provenance;
      if (!orphanIntent) {
        skipped += 1;
        continue;
      }
      // Never adopt what we can't age: an unparseable created_at is treated as
      // ineligible rather than guessed too-old. parseDbTime, NOT a raw Date.parse:
      // created_at is SQLite UTC text with no zone marker.
      const createdAt = parseDbTime(proposal.created_at)?.getTime() ?? Number.NaN;
      if (!Number.isFinite(createdAt)) {
        skipped += 1;
        continue;
      }
      let handlingKey = orphanIntent.key;
      let burstAfter: string | undefined;
      let burstBefore: string | undefined;
      if (provenance === "background_chat") {
        const windowMs = Math.max(1, Number(chatIntent?.burst_window_ms) || 30 * 60 * 1000);
        const anchors = backgroundBurstAnchors.get(orphanIntent.key) ?? [];
        let anchor = anchors.find((candidate) => candidate >= createdAt && candidate - createdAt <= windowMs);
        if (anchor == null) {
          anchor = createdAt;
          anchors.push(anchor);
          backgroundBurstAnchors.set(orphanIntent.key, anchors);
        }
        handlingKey = `${orphanIntent.key}:burst:${new Date(anchor).toISOString()}`;
        burstAfter = new Date(anchor - windowMs).toISOString();
        burstBefore = new Date(anchor).toISOString();
      }
      if (handledIntents.has(handlingKey)) continue;
      // Already scheduled/applied? A review decision is intentionally re-evaluated when
      // posture changes; a pending/announced/applied decision already owns its boundary.
      if (["pending", "announced", "applied"].includes(String(proposal.autonomy?.status ?? ""))) {
        handledIntents.add(handlingKey);
        skipped += 1;
        continue;
      }
      // A draft still inside the grace window waits for a later pass (not a failure —
      // just not yet). Its burst anchor remains useful for keeping adjacent retries
      // together, but it is never adopted or swept while fresh.
      if (now - createdAt < ORPHAN_ADOPTION_GRACE_MS) {
        skipped += 1;
        continue;
      }
      if (provenance !== "background_chat") handledIntents.add(handlingKey);
      // After a recent same-kind veto the system does NOT silently re-apply similar
      // substance: it ANNOUNCES (lands at the natural boundary with a Coach discussion
      // path, no decision demanded). With no veto, normal quiet-apply policy applies. Either way
      // decideAutonomyTier only ever clamps to a MORE restrictive tier, so an ask-tier
      // situation (review_everything posture, freshness expiry, a true same-kind budget,
      // goal/clinical) records an explicit review hold and leaves the draft unchanged;
      // a later pass can re-evaluate it when posture or policy inputs change.
      const requested_tier: AutonomyTier =
        provenance !== "automatic" && shape.kind === "training_structure"
          ? "announce"
          : hasRecentDecisionVeto(shape.kind, 5)
            ? "announce"
            : "quiet_apply";
      const burstSourceProposalIds =
        provenance === "background_chat"
          ? proposals
              .filter((candidate) => {
                if (candidate?.status !== "draft") return false;
                const intent = chatOrphanIntent(candidate);
                if (intent?.provenance !== "background_chat" || intent.key !== orphanIntent.key) return false;
                const candidateTime = parseDbTime(candidate.created_at)?.getTime() ?? Number.NaN;
                const after = burstAfter ? Date.parse(burstAfter) : Number.NaN;
                const before = burstBefore ? Date.parse(burstBefore) : Number.NaN;
                return Number.isFinite(candidateTime) && candidateTime >= after && candidateTime <= before;
              })
              .map((candidate) => Number(candidate.id))
          : [];
      const normalizedApplyPayload =
        provenance === "background_chat"
          ? legacyBackgroundNormalizedPayload(proposal, burstSourceProposalIds)
          : undefined;
      const result = applyProposalWithAutonomy(Number(proposal.id), {
        requested_tier,
        explicit_user_request: provenance !== "automatic",
        orphan_sibling_cleanup: {
          intent_key: orphanIntent.key,
          eligible_before: eligibleBefore,
          provenance,
          burst_after: burstAfter,
          burst_before: burstBefore,
        },
        normalized_apply_payload: normalizedApplyPayload,
      });
      // Pending / announced / quiet-applied are true adoption signals. A persisted
      // review decision is still a hold, not an automatic adoption.
      if (["pending", "announced", "applied"].includes(String(result?.decision?.status ?? ""))) {
        handledIntents.add(handlingKey);
        adopted += 1;
      } else {
        // A legacy retry may be invalid under today's structural quality contract.
        // Its savepoint already rolled back atomically; keep walking newest→oldest
        // inside the same burst until one candidate genuinely owns the repair.
        skipped += 1;
      }
    } catch {
      // Per-draft error isolation: a throwing adoption must never break the pass.
      skipped += 1;
    }
  }
  return { adopted, skipped };
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
        if (!coordinated && !surpriseBudgetAllows(materialChangesThisWeek("nutrition", ["applied"], "meal_plan"))) {
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
        withSqliteSavepoint(`due_meal_plan_${announced.id}`, () => {
          const accepted = acceptMealPlan(mealPlanId, { recordDecision: false });
          if (!accepted) throw new Error("the meal plan could not become current");
          const transitioned = transitionBrainDecision(announced.id!, "applied");
          if (!transitioned) throw new Error("the meal-plan decision could not reach applied status");
          if (
            !saveBrainRollback(announced.id!, "meal_plan", {
              version: 1,
              previous_meal_plan_id: previousId,
              applied_meal_plan_id: mealPlanId,
            })
          ) {
            throw new Error("the meal-plan rollback snapshot was not stored");
          }
          const updated = patchBrainDecision(announced.id!, {
            context: { ...(transitioned.context ?? {}), rollback_available: true },
            reversible: true,
          });
          if (!updated) throw new Error("the meal-plan decision could not be finalized");
        });
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
      // and then blocks the rest. Nutrition budgets per kind here too, so a landed meal
      // refresh cannot block a bounded target nudge at its boundary (and vice versa).
      const boundaryBudgetKind = shape.domain === "nutrition" ? shape.kind : undefined;
      const coordinated = (announced.context as any)?.coordinated_update === true;
      // Ruling A: a routine deterministic progression is exempt from the surprise budget
      // at the boundary too. recordDecision stored source = proposal.agent, so the routine
      // literals identify it here as at decision time.
      const routineChange = ROUTINE_CHANGE_SOURCES.has(String(announced.source ?? ""));
      if (
        !routineChange &&
        !surpriseBudgetAllows(materialChangesThisWeek(shape.domain, ["applied"], boundaryBudgetKind), coordinated)
      ) {
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
      const orphanCleanup = (announced.context as any)?.orphan_sibling_cleanup;
      const rollback = rollbackSnapshot(shape);
      withSqliteSavepoint(`due_proposal_${announced.id}`, () => {
        const result = applyProposal(proposalId, {
          // Only the orphan-repair path carries a semantic intent + grace cutoff.
          // Ordinary parallel, chat, and user-authored decisions pass no cleanup.
          orphanSiblingCleanup:
            orphanCleanup &&
            typeof orphanCleanup.intent_key === "string" &&
            typeof orphanCleanup.eligible_before === "string"
              ? {
                  intent_key: orphanCleanup.intent_key,
                  eligible_before: orphanCleanup.eligible_before,
                  provenance:
                    orphanCleanup.provenance === "background_chat"
                      ? "background_chat"
                      : orphanCleanup.provenance === "chat"
                        ? "chat"
                        : "automatic",
                  burst_after: typeof orphanCleanup.burst_after === "string" ? orphanCleanup.burst_after : undefined,
                  burst_before: typeof orphanCleanup.burst_before === "string" ? orphanCleanup.burst_before : undefined,
                }
              : undefined,
          normalizedApplyPayload:
            (announced.context as any)?.normalized_apply_payload?.parsed &&
            (announced.context as any)?.normalized_apply_payload?.migration
              ? (announced.context as any).normalized_apply_payload
              : undefined,
          decisionId: announced.id!,
          requireDecisionLedger: true,
        }) as any;
        if (!result?.ok) throw new Error(String(result?.error ?? "the change could not be applied"));
        const updated = getBrainDecision(announced.id!);
        if (!updated || updated.status !== "applied") throw new Error("the decision did not reach applied status");
        if (
          !saveBrainRollback(
            announced.id!,
            rollback.kind,
            rollback.kind === "training_plan" ? trainingRollbackPayload(rollback.plan) : rollback.previous
          )
        ) {
          throw new Error("the autonomous rollback snapshot was not stored");
        }
        const reversible = patchBrainDecision(announced.id!, {
          context: { ...(updated.context ?? {}), rollback_available: true },
          reversible: true,
        });
        if (!reversible) throw new Error("the decision could not be finalized as reversible");
        if (shape.kind === "nutrition_target") {
          // This handoff is part of the nutrition-target commit: a target cannot
          // land while silently losing the required meal realignment request.
          setAppStateStrict(MEAL_REFRESH_REQUEST_KEY, asOf);
        }
      });
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
    try {
      return withSqliteSavepoint(`cancel_announced_${id}`, () => {
        const mealPlanId = Number((decision.action as any)?.meal_plan_id);
        if (mealPlanId > 0 && (getMealPlan(mealPlanId) as any)?.status === "draft")
          setMealPlanStatus(mealPlanId, "superseded", { recordDecision: false });
        const canceled = transitionBrainDecision(id, "canceled");
        if (!canceled) throw new Error("the announced decision could not be canceled");
        return { ok: true, decision: canceled };
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!decision || decision.status !== "applied" || !decision.reversible)
    return { ok: false, error: "decision is not reversible" };
  const rollback = getBrainRollback(id);
  try {
    return withSqliteSavepoint(`revert_decision_${id}`, () => {
      if (rollback?.kind === "training_plan" && Array.isArray(rollback.payload)) {
        // Legacy snapshots remain reversible. New writes use a three-way snapshot below.
        replacePlan(rollback.payload);
      } else if (
        rollback?.kind === "training_plan" &&
        rollback.payload?.version === 2 &&
        Array.isArray(rollback.payload.before) &&
        Array.isArray(rollback.payload.after)
      ) {
        replacePlan(
          mergeTrainingRollback(
            rollback.payload.before,
            rollback.payload.after,
            trainingPlanSnapshot(),
            Array.isArray((decision.action as any)?.swaps) ? (decision.action as any).swaps : []
          )
        );
      } else if (rollback?.kind === "nutrition_target") {
        const appliedTargetId = Number(decision.source_ref_type === "nutrition_target" ? decision.source_ref_key : 0);
        const activeBeforeUndo = getActiveNutritionTarget();
        const stillOwnsActiveSlot = appliedTargetId > 0 && Number(activeBeforeUndo?.id) === appliedTargetId;
        if (appliedTargetId > 0) deleteNutritionTarget(appliedTargetId);
        if (stillOwnsActiveSlot && rollback.payload) {
          const previousId = Number(rollback.payload?.id);
          if (!(previousId > 0 && getNutritionTarget(previousId))) {
            setNutritionTarget({ ...rollback.payload, source: "undo", note: `Restored after ${reason}` });
          }
        }
      } else if (rollback?.kind === "meal_plan" && rollback.payload?.version === 1) {
        const appliedId = Number(rollback.payload.applied_meal_plan_id);
        const previousId = Number(rollback.payload.previous_meal_plan_id);
        const current = currentMealPlan() as any;
        // A later accepted meal plan wins. Undo only changes the meal plan when this
        // decision still owns the current one.
        if (appliedId > 0 && Number(current?.id) === appliedId) {
          restoreMealPlanAfterUndo(appliedId, previousId > 0 ? previousId : null);
        }
      } else {
        throw new Error("rollback snapshot unavailable");
      }
      if (rollback.kind === "training_plan") {
        const proposalId = Number((decision.action as any)?.plan_proposal_id ?? (decision.action as any)?.proposal_id);
        if (proposalId > 0) revertRecoveryWeekIfOwned(proposalId, { strict: true });
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
      if (!reverted) throw new Error("the decision could not transition to reverted");
      return { ok: true, decision: reverted };
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
