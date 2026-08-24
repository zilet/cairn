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
  supersedeReviewDecisionsForProposal,
  transitionBrainDecision,
} from "../../repo/brain-decisions.js";
import { insertBrainEvaluation } from "../../repo/brain-evaluations.js";
import {
  acceptMealPlan,
  currentMealPlan,
  deleteNutritionTarget,
  getActiveNutritionTarget,
  getLatestNutritionTarget,
  getMealPlan,
  getNutritionTarget,
  restoreMealPlanAfterUndo,
  setMealPlanStatus,
  setNutritionTarget,
  validateMealPlanForPersistence,
} from "../../repo/nutrition.js";
import { getPlan, replacePlan } from "../../repo/plan.js";
import { cancelRecoveryCycle, getRecoveryCycle } from "../../repo/recovery-cycles.js";
import {
  applyProposal,
  computeGoalCheck,
  getProfile,
  getProposal,
  listProposals,
  setProfile,
  type NormalizedProposalApplyPayload,
  type OrphanSiblingCleanup,
  RECOVERY_WEEK_INSTRUCTION_PREFIX,
  revertRecoveryWeekIfOwned,
  setProposalStatus,
} from "../../repo/profile.js";
import { MEAL_REFRESH_REQUEST_KEY } from "../../repo/meal-refresh-retry.js";
import { automaticOrphanIntent, chatOrphanIntent } from "../../repo/proposal-intent.js";
import { buildProgressionProposal } from "../../repo/progression.js";
import { buildRunPlanProposal } from "../../repo/run-progression.js";
import { capProtectiveRaise, cutReaffirmation, deriveCutTarget } from "../../repo/cut-target.js";
import { getSettings } from "../../repo/settings.js";
import { setAppStateStrict } from "../../repo/app-state.js";
import { addDaysISO, localDateISO, parseDbTime } from "../../repo/shared.js";
import { getSessionByDate } from "../../repo/sessions.js";
import { withSqliteSavepoint } from "../../repo/sqlite-savepoint.js";
import {
  captureNutritionProposalEvidence,
  captureProposalEvidence,
  proposalEvidenceSnapshot,
  type ProposalFreshness,
  verifyProposalEvidenceSnapshot,
  verifyProposalEvidenceFreshness,
} from "../../repo/proposal-truth.js";

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

function proposalNeedsEvidenceFreshness(shape: ProposalShape): boolean {
  return shape.domain === "training" || shape.domain === "recovery" || shape.kind === "nutrition_target";
}

function captureEvidenceForShape(shape: ProposalShape, asOf: string) {
  return shape.kind === "nutrition_target" ? captureNutritionProposalEvidence(asOf) : captureProposalEvidence(asOf);
}

function proposalShape(proposal: any): ProposalShape {
  if (proposal?.parsed?.kind === "nutrition_target")
    return { kind: "nutrition_target", domain: "nutrition", risk: "low" };
  const recoveryWeek = String(proposal?.instruction ?? "").startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX);
  if (
    recoveryWeek &&
    (Array.isArray(proposal?.parsed?.days) || Array.isArray(proposal?.parsed?.changes))
  ) {
    return { kind: "training_structure", domain: "recovery", risk: "moderate" };
  }
  if (Array.isArray(proposal?.parsed?.days)) {
    // The canonical recovery-week draft is stamped domain 'recovery' at WRITE time —
    // the conductor's "a lighter recovery week lands <weekday>" claim keys off this
    // structural marker, never off substring-matching the agent's free-text summary
    // (an unrelated restructure whose prose says "lighter" must not qualify).
    return { kind: "training_structure", domain: "training", risk: "moderate" };
  }
  // A changes[] payload carrying a swap is an exercise rotation, not a bare target
  // tweak — classify it as such for the ledger. It stays low-risk/quiet_apply and
  // shares training_target's next-boundary + freshness handling (kind !== structure).
  if (Array.isArray(proposal?.parsed?.changes) && proposal.parsed.changes.some((change: any) => change?.swap))
    return { kind: "exercise_rotation", domain: "training", risk: "low" };
  return { kind: "training_target", domain: "training", risk: "low" };
}

function proposalReasonProvenance(proposal: any): any[] {
  const parsed = proposal?.parsed ?? {};
  const owners = [
    ...(Array.isArray(parsed.changes) ? parsed.changes : []),
    ...(Array.isArray(parsed.cardio) ? parsed.cardio : []),
    ...(Array.isArray(parsed.days)
      ? parsed.days.flatMap((day: any) => (Array.isArray(day?.items) ? day.items : []))
      : []),
  ];
  return owners
    .filter((owner: any) => owner?.reason)
    .slice(0, 24)
    .map((owner: any) => ({
      day_number: owner?.day_number ?? null,
      subject: owner?.exercise ?? owner?.label ?? owner?.swap?.to ?? null,
      reason: owner.reason,
      reason_provenance: owner?.reason_provenance ?? null,
    }));
}

type ProposalReviewReasonCode =
  | "stale_snapshot"
  | "clinical_ceiling"
  | "safety_floor"
  | "user_lock"
  | "review_posture"
  | "requested_review"
  | "domain_policy";
// NOTE: "budget_review" is deliberately gone. A spent surprise budget no longer parks a
// change for review at all (2026-08-17 ruling) — it delays to the next natural boundary —
// so the code that produced this reason code has no remaining caller. Keeping the member
// would invite a future writer to re-create the demotion the ruling removed.

function holdProposalForReview(
  proposal: any,
  shape: ProposalShape,
  input: {
    code: ProposalReviewReasonCode;
    reasons: string[];
    tier?: AutonomyTier;
    policy_inputs?: Record<string, unknown>;
    clinical?: boolean;
    clinical_provenance?: Record<string, unknown> | null;
    coordination_key?: string | null;
    coordinated_update?: boolean;
    freshness?: ProposalFreshness | null;
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
    risk_class: input.clinical ? "clinical" : shape.risk,
    reversible: false,
    input_fingerprint: null,
    context: {
      review_required: true,
      review_reason_code: input.code,
      review_reasons: reasons,
      policy_inputs: input.policy_inputs ?? {},
      clinical: input.clinical === true,
      clinical_provenance: input.clinical_provenance ?? null,
      coordination_key: input.coordination_key ?? null,
      coordinated_update: input.coordinated_update === true,
      evidence_keys: [`plan_proposal:${proposal.id}`, `current_plan:${shape.domain}`],
      evidence_observed_at: new Date().toISOString(),
      proposal_evidence: proposalEvidenceSnapshot(proposal.parsed),
      proposal_freshness: input.freshness ?? null,
    },
    action: {
      proposal_id: proposal.id,
      review_reason_code: input.code,
      reason_provenance: proposalReasonProvenance(proposal),
    },
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

function serverClinicalProvenance(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const provenance = value as Record<string, unknown>;
  return provenance.server_owned === true &&
    (provenance.source === "chat_clinical_detection" || provenance.source === "chat_clinical_lineage")
    ? provenance
    : null;
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
  if (shape.domain === "recovery") return { kind: "recovery_cycle" };
  return shape.domain !== "nutrition"
    ? { kind: "training_plan", plan: trainingPlanSnapshot() }
    : { kind: "nutrition_target", previous: getActiveNutritionTarget() };
}

function trainingRollbackPayload(before: any[]): any {
  return { version: 2, before, after: trainingPlanSnapshot() };
}

function proposalRollbackPayload(rollback: any, result: any): any {
  if (rollback.kind === "training_plan") return trainingRollbackPayload(rollback.plan);
  if (rollback.kind === "recovery_cycle") {
    return {
      version: 1,
      cycle_id: Number(result?.recovery_cycle?.id),
      proposal_id: Number(result?.id),
    };
  }
  return rollback.previous;
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

// Has this domain earned a demotion — enough of its recent led changes reverted that
// it should stop leading and start asking?
//
// COUNTED IN SQL, the way materialChangesThisWeek does, and that is the whole point.
// This used to pull the last 100 decisions in the domain and filter tier and date in
// JS: every ask-tier row, every rejected one, every row older than the window still
// consumed one of the 100 slots. A busy domain — the exact domain a reversal
// safeguard exists for — filled the fetch with rows that all failed the filter, and
// the guard read an empty set and quietly stopped firing. A safeguard that switches
// itself off under load is worse than none, because nothing says it did.
export function domainIsDemoted(domain: BrainDomain): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'reverted' THEN 1 ELSE 0 END) AS reverted
         FROM brain_decisions
        WHERE domain = ? AND autonomy_tier IN ('quiet_apply','announce')
          AND status IN ('applied','reverted')
          AND date(created_at) >= date('now','-90 days')`
    )
    .get(domain) as any;
  return domainShouldDemote(Number(row?.reverted ?? 0), Number(row?.n ?? 0));
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
  // A spent budget delays this plan to its natural boundary and lets the boundary pass
  // re-check the week; it never converts the plan into an ask (2026-08-17 ruling).
  const surpriseBudgetSpent =
    !input.coordinated_update && !surpriseBudgetAllows(materialChangesThisWeek("nutrition", undefined, "meal_plan"));

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
        surprise_budget_deferred: surpriseBudgetSpent,
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
    ...(surpriseBudgetSpent ? { budget_deferred: true } : {}),
  };
}

// A later successful routing of the SAME proposal (announce / pending quiet-apply /
// immediate apply) makes any earlier HOLD on that proposal moot — the hold said "wait",
// and the system has now landed or scheduled it. Retire the stale live `review` rows to
// 'superseded' so a freed budget hold never leaves a dangling open review decision in the
// ledger (which listReviewHeldProposals / planDraftCandidate would otherwise keep reading).
// Delegates to the shared repo-level implementation so the two never drift; setProposalStatus
// applies the identical retirement on every terminal proposal transition.
function supersedePriorReviewHolds(proposalId: number): void {
  supersedeReviewDecisionsForProposal(proposalId);
}

export function applyProposalWithAutonomy(
  proposalId: number,
  input: {
    requested_tier?: AutonomyTier;
    // Clinical provenance is derived by a server-owned caller (chat inspects the
    // athlete message, action rationale/constraints, study refs, and attachment).
    // It is persisted on the proposal so later routing cannot lose the ceiling.
    clinical?: boolean;
    clinical_provenance?: Record<string, unknown>;
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
  const clinicalProvenance =
    serverClinicalProvenance(input.clinical_provenance) ??
    serverClinicalProvenance(proposal.parsed?.clinical_provenance);
  const clinical = input.clinical === true || clinicalProvenance !== null;
  const proposalFreshness = proposalNeedsEvidenceFreshness(shape)
    ? verifyProposalEvidenceFreshness(proposal.parsed, localDateISO())
    : null;
  const storedProposalEvidence = proposalEvidenceSnapshot(proposal.parsed);
  const scheduledProposalEvidence =
    storedProposalEvidence ??
    (proposalFreshness?.status === "unverified" &&
    input.explicit_user_request &&
    proposalNeedsEvidenceFreshness(shape)
      ? captureEvidenceForShape(shape, localDateISO())
      : null);
  // Compare-and-set is the primary autonomous freshness gate. A proposal whose
  // source plan or training evidence moved is preserved for review; it is never
  // silently regenerated or applied. Legacy drafts have no fingerprint and may
  // still be applied by an explicit current-turn request, but autonomous ownership
  // cannot claim their inputs are current.
  if (
    proposalFreshness &&
    !input.explicit_user_request &&
    (proposalFreshness.status === "changed" || proposalFreshness.status === "unverified")
  ) {
    const changed = proposalFreshness.changed_components.join(" and ");
    return holdProposalForReview(proposal, shape, {
      code: "stale_snapshot",
      reasons: [
        proposalFreshness.status === "changed"
          ? `${changed || "plan or training"} evidence changed after this proposal was created; review it against the current picture`
          : "this older proposal has no compare-and-set evidence snapshot; review it against the current picture",
        ...(clinical ? ["clinical decisions remain clinician-directed"] : []),
      ],
      tier: clinical ? "clinician" : undefined,
      clinical,
      clinical_provenance: clinicalProvenance,
      coordination_key: input.coordination_key,
      coordinated_update: input.coordinated_update,
      freshness: proposalFreshness,
    });
  }
  const createdAt = Date.parse(String(proposal.created_at ?? ""));
  const ageDays = Number.isFinite(createdAt) ? Math.max(0, (Date.now() - createdAt) / 86_400_000) : Infinity;
  const freshnessDays = shape.kind === "training_structure" ? 14 : 7;
  if (ageDays > freshnessDays) {
    return holdProposalForReview(proposal, shape, {
      code: "stale_snapshot",
      reasons: [
        `proposal snapshot is older than ${freshnessDays} days; refresh it against the current plan first`,
        ...(clinical ? ["clinical decisions remain clinician-directed"] : []),
      ],
      tier: clinical ? "clinician" : undefined,
      clinical,
      clinical_provenance: clinicalProvenance,
      coordination_key: input.coordination_key,
      coordinated_update: input.coordinated_update,
      freshness: proposalFreshness,
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
    risk_class: clinical ? "clinical" : shape.risk,
    reversible: true,
    requested_tier: input.requested_tier,
    lead_mode: leadMode,
    magnitude: nutritionDelta,
    user_locked: input.user_locked,
    clamp_refused: input.clamp_refused,
    domain_demoted: domainDemoted,
    clinical,
  });
  if (policy.tier === "ask" || policy.tier === "clinician" || policy.tier === "observe") {
    const code: ProposalReviewReasonCode = clinical
      ? "clinical_ceiling"
      : input.clamp_refused
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
        clinical,
        clinical_provenance: clinicalProvenance,
      },
      clinical,
      clinical_provenance: clinicalProvenance,
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
  // A spent surprise budget is a WAIT, not a refusal (2026-08-17 ruling). The change
  // keeps its ledger row, its expectation and its one-tap undo; it simply announces and
  // lands at the next natural boundary, where the boundary pass re-checks the budget and
  // delays again if the week is still full. It is never demoted to a bare draft, and
  // never turned into an ask the athlete has to answer — being told "later" is the
  // system's job, not theirs. Age and evidence freshness remain the real ceilings.
  const surpriseBudgetSpent = !surpriseBudgetAllows(
    materialChangesThisWeek(shape.domain, undefined, budgetKind),
    !!input.safety_response || !!input.explicit_user_request || routineChange
  );
  if (policy.tier === "announce" || surpriseBudgetSpent) {
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
        surprise_budget_deferred: surpriseBudgetSpent,
        coordination_key: input.coordination_key ?? null,
        coordinated_update: input.coordinated_update === true,
        orphan_sibling_cleanup: input.orphan_sibling_cleanup ?? null,
        normalized_apply_payload: input.normalized_apply_payload ?? null,
        evidence_keys: [`plan_proposal:${proposal.id}`, `current_plan:${shape.domain}`],
        evidence_observed_at: new Date().toISOString(),
        proposal_evidence: scheduledProposalEvidence,
        proposal_freshness: proposalFreshness,
      },
      action: {
        proposal_id: proposal.id,
        evidence_fingerprint: scheduledProposalEvidence?.fingerprint ?? null,
        reason_provenance: proposalReasonProvenance(proposal),
      },
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
      ...(surpriseBudgetSpent ? { budget_deferred: true } : {}),
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
        proposal_evidence: scheduledProposalEvidence,
        proposal_freshness: proposalFreshness,
      },
      action: {
        proposal_id: proposal.id,
        evidence_fingerprint: scheduledProposalEvidence?.fingerprint ?? null,
        reason_provenance: proposalReasonProvenance(proposal),
      },
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
          proposalRollbackPayload(rollback, result)
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
// ---------- goal-date adaptation ----------

// The shape a derivation hands over. `from`/`to` are ISO dates (`from` may be null when
// the profile carried no goal date yet), `weeks_added` is the signed change in weeks, and
// `reason` is the athlete-facing sentence explaining why the date moved.
export interface GoalDateAdaptation {
  from: string | null;
  to: string;
  weeks_added: number;
  reason: string;
}

function isoDateOnly(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

// A goal date that adapts from the signals, with a heads-up and a one-tap undo.
//
// This is the seam a cut-target derivation calls: it owns the POLICY and the ledger, and
// deliberately does not own the arithmetic — the caller decides that the date should move
// and to where, this decides whether the athlete gets told first and guarantees they can
// put it back. Under lead it announces (goal_change + goal_identity, 2026-08-17 ruling);
// under announce_first and review_everything it still asks, and a user lock or a clinical
// flag still outranks everything.
//
// Nothing is written here. The date lands at its natural boundary through
// applyDueAnnouncedDecisions, which is also where the rollback snapshot is taken, so an
// announced goal date is never a promise the boundary pass cannot keep.
export function applyGoalDateAdaptationWithAutonomy(
  adaptation: GoalDateAdaptation,
  input: { requested_tier?: AutonomyTier; user_locked?: boolean; clinical?: boolean; coordination_key?: string } = {}
): any {
  const to = isoDateOnly(adaptation?.to);
  if (!to) return { ok: false, error: "goal date adaptation needs a YYYY-MM-DD target date" };
  // The PROFILE decides what "from" is, not the caller's claim about it. A derivation
  // reasons from the goal date it read; if the athlete has moved it since, the arithmetic
  // behind `to` was done against a date that no longer exists, so the whole adaptation is
  // refused rather than half-trusted (the same law as a stale prescription: absent, not
  // approximate). Nothing about a live goal date is ever inferred from the payload.
  const currentGoalDate = isoDateOnly((getProfile() as any)?.goal_date);
  if (currentGoalDate === to) {
    return { ok: true, applied: false, changed: false, reasons: ["the goal date is already there"] };
  }
  const from = isoDateOnly(adaptation?.from);
  if (from !== currentGoalDate) {
    return {
      ok: false,
      error: "goal date adaptation was derived from a goal date the profile no longer holds",
      derived_from: from,
      current_goal_date: currentGoalDate,
    };
  }
  const weeksAdded = Number.isFinite(Number(adaptation?.weeks_added)) ? Number(adaptation.weeks_added) : 0;
  const reason = String(adaptation?.reason ?? "").trim();

  const policy = decideAutonomyTier({
    kind: "goal_change",
    risk_class: input.clinical ? "clinical" : "moderate",
    reversible: true,
    requested_tier: input.requested_tier,
    lead_mode: getSettings().lead_mode,
    goal_identity: true,
    user_locked: input.user_locked,
    clinical: input.clinical,
    domain_demoted: domainIsDemoted("nutrition"),
  });
  const parks = policy.tier === "ask" || policy.tier === "clinician" || policy.tier === "observe";

  const effectiveDate = parks ? null : nextMealBoundary();
  const recorded = recordDecision({
    effective_date: effectiveDate,
    kind: "goal_change",
    domain: "nutrition",
    summary: `Your goal date moves ${weeksAdded === 0 ? "" : weeksAdded > 0 ? "out " : "in "}to ${to}.`
      .replace(/\s+/g, " ")
      .slice(0, 300),
    rationale: (reason || "The current trend puts the goal on a different date than the one on file.").slice(0, 1_500),
    source: "goal_date_adaptation",
    source_ref_type: null,
    source_ref_key: null,
    status: parks ? "review" : "announced",
    autonomy_tier: parks ? policy.tier : "announce",
    risk_class: input.clinical ? "clinical" : "moderate",
    reversible: false,
    input_fingerprint: null,
    context: {
      natural_boundary: !parks,
      review_required: parks,
      ...(parks ? { review_reason_code: input.clinical ? "clinical" : input.user_locked ? "user_lock" : "review_posture" } : {}),
      policy_reasons: policy.reasons,
      coordination_key: input.coordination_key ?? null,
      evidence_keys: ["profile:goal", "coach_context:nutrition"],
      evidence_observed_at: new Date().toISOString(),
    },
    action: { goal_date_adaptation: { from, to, weeks_added: weeksAdded, reason } },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
  return {
    ok: true,
    applied: false,
    changed: true,
    ...(parks ? { review_required: true } : { announced: true }),
    tier: parks ? policy.tier : "announce",
    effective_date: effectiveDate,
    decision: recorded.decision,
    reasons: policy.reasons,
  };
}

function goalDateAdaptationAction(action: unknown): GoalDateAdaptation | null {
  const adaptation = action && typeof action === "object" ? (action as any).goal_date_adaptation : null;
  if (!adaptation || typeof adaptation !== "object") return null;
  const to = isoDateOnly(adaptation.to);
  return to ? { from: isoDateOnly(adaptation.from), to, weeks_added: Number(adaptation.weeks_added) || 0, reason: String(adaptation.reason ?? "") } : null;
}

type ParkedDecision = ReturnType<typeof listBrainDecisions>[number];

// A parked decision behind one of these reason codes is not a posture artefact — it is
// a deliberate refusal by a safety, lock, or clinical rule. The thaw never touches it.
// The clinician floor is deterministic and cannot be attested away (docs/VISION.md
// Amendment 1), and a user lock is the athlete's own word on the matter.
const THAW_FLOOR_REASON_CODES = new Set(["clinical", "clinical_ceiling", "safety_floor", "user_lock"]);

// A decision parked by applyDueAnnouncedDecisions' own failure path carries the
// PENDING CHANGE in `action` rather than behind a plan_proposal row — a meal plan
// that could not become current, a goal date that never reached the profile. The
// draft lookup in the thaw cannot see either of those, so without this they read as
// "a reading with nothing behind it" and the advisory re-offer would observe the
// change away and take its recorded apply_error with it. A pending change is never
// advisory: it stays parked until the athlete answers it.
function carriesPendingChange(action: unknown): boolean {
  if (!action || typeof action !== "object") return false;
  return Number((action as any).meal_plan_id) > 0 || !!goalDateAdaptationAction(action);
}

// An advisory record — a conference reading with no draft behind it — asks nothing and
// changes nothing, so a stored `reversible: false` on it means "no rollback snapshot was
// taken", not "this cannot be undone". Re-offering it through the irreversibility floor
// would pin every such record at 'ask' forever, which is the state this sweep exists to
// clear. Its executable siblings still route through applyProposalWithAutonomy, which
// derives reversibility from the real change.
function reofferParkedAdvisory(decision: ParkedDecision, context: Record<string, any>): boolean {
  const policy = decideAutonomyTier({
    kind: decision.kind,
    risk_class: decision.risk_class,
    reversible: true,
    lead_mode: getSettings().lead_mode,
    clinical: decision.risk_class === "clinical",
  });
  if (policy.tier === "ask" || policy.tier === "clinician") return false;
  return !!patchBrainDecision(decision.id!, {
    status: "observed",
    autonomy_tier: policy.tier,
    context: {
      ...context,
      review_required: false,
      thaw_outcome: "observed",
      thaw_reasons: policy.reasons,
    },
  });
}

// A held draft whose evidence has moved is SET ASIDE with a receipt, never adopted. The
// live case for this: diet-break drafts written before the cut was reaffirmed. Adopting
// one on thaw would apply a plan the athlete's own picture has already contradicted, so
// the sweep supersedes it and records why in the ledger, where the athlete can read it.
function supersedeStaleDraftOnThaw(proposal: any, decision: ParkedDecision, freshness: ProposalFreshness): void {
  const shape = proposalShape(proposal);
  const changed = freshness.changed_components.join(" and ");
  const why =
    freshness.status === "changed"
      ? `The ${changed || "training"} picture moved after this was drafted, so it no longer describes where you are.`
      : "This draft carries no record of what it was written against, so there is no way to tell whether it still fits.";
  recordDecision({
    effective_date: localDateISO(),
    kind: shape.kind,
    domain: shape.domain,
    summary: "A held draft was set aside instead of applied.",
    rationale: `${why} Nothing changed; a fresh read can pick this up from where you are now.`.slice(0, 1_500),
    source: proposal.agent || "autonomy",
    source_ref_type: "plan_proposal",
    source_ref_key: String(proposal.id),
    status: "superseded",
    autonomy_tier: "ask",
    risk_class: shape.risk,
    reversible: false,
    input_fingerprint: null,
    context: {
      thaw_receipt: true,
      review_reason_code: "stale_snapshot",
      proposal_freshness: freshness,
      superseded_review_decision_id: decision.id ?? null,
    },
    action: {
      proposal_id: proposal.id,
      outcome: "superseded_stale_evidence",
      reason_provenance: proposalReasonProvenance(proposal),
    },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
  // Retires the draft AND every live review hold pointing at it, in one authoritative
  // call, so the sweep cannot leave the decision open behind a dead draft.
  setProposalStatus(Number(proposal.id), "superseded");
}

// Thaw for decisions frozen at `status: 'review'`. A decision parked under an older,
// stricter policy — or by a surprise budget that has since rolled over — used to sit in
// the queue forever showing "NEEDS YOUR DECISION", because nothing re-read it when the
// conditions that parked it changed. This re-offers each one through TODAY's policy.
//
// Deterministic and agent-free. Once per decision: the attempt is stamped into the
// decision's own context BEFORE the re-offer runs, so a throwing re-offer cannot make
// the sweep retry it on the next tick. Floors above are never re-offered, and under
// 'review_everything' the sweep does nothing at all — the athlete has asked to see
// everything, so nothing may be adopted or set aside on their behalf.
export function thawParkedReviewDecisions(): { thawed: number; superseded: number; skipped: number } {
  let thawed = 0;
  let superseded = 0;
  let skipped = 0;
  if (getSettings().lead_mode === "review_everything") return { thawed, superseded, skipped };
  for (const decision of listBrainDecisions({ status: "review", limit: 100 })) {
    try {
      const context = (decision.context ?? {}) as Record<string, any>;
      if (context.thaw_attempted === true) {
        skipped += 1;
        continue;
      }
      if (
        decision.autonomy_tier === "clinician" ||
        decision.risk_class === "clinical" ||
        context.clinical === true ||
        context.user_locked === true ||
        THAW_FLOOR_REASON_CODES.has(String(context.review_reason_code ?? ""))
      ) {
        skipped += 1;
        continue;
      }
      // Left untouched entirely — not even stamped — so the change and the
      // apply_error that parked it stay exactly as the athlete will read them.
      if (carriesPendingChange(decision.action)) {
        skipped += 1;
        continue;
      }
      const stamped =
        patchBrainDecision(decision.id!, {
          context: { ...context, thaw_attempted: true, thaw_attempted_at: new Date().toISOString() },
        }) ?? decision;
      const stampedContext = (stamped.context ?? {}) as Record<string, any>;
      const proposalId =
        Number((decision.action as any)?.proposal_id) ||
        (decision.source_ref_type === "plan_proposal" ? Number(decision.source_ref_key) : 0);
      const proposal = proposalId > 0 ? getProposal(proposalId) : null;
      if (!proposal || proposal.status !== "draft") {
        // No live draft behind it: this is a reading, not a pending change.
        if (reofferParkedAdvisory(stamped, stampedContext)) thawed += 1;
        else skipped += 1;
        continue;
      }
      const freshness = verifyProposalEvidenceFreshness(proposal.parsed, localDateISO());
      if (freshness.status === "changed" || freshness.status === "unverified") {
        supersedeStaleDraftOnThaw(proposal, stamped, freshness);
        superseded += 1;
        continue;
      }
      const result = applyProposalWithAutonomy(proposalId, {});
      if (["pending", "announced", "applied"].includes(String(result?.decision?.status ?? ""))) thawed += 1;
      else skipped += 1;
    } catch {
      // Per-decision isolation: one bad row must never break the sweep.
      skipped += 1;
    }
  }
  return { thawed, superseded, skipped };
}

export function adoptOrphanedDrafts(): {
  adopted: number;
  skipped: number;
  thawed: number;
  superseded: number;
} {
  // Parked decisions thaw on the same deterministic tick as orphaned drafts, ahead of
  // adoption: a decision re-offered here may retire the very draft the loop below would
  // otherwise walk. Deliberately called from inside this sweep rather than wired into
  // the scheduler separately, so the two can never drift apart in ordering.
  const thaw = thawParkedReviewDecisions();
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
  return { adopted, skipped, thawed: thaw.thawed, superseded: thaw.superseded };
}

// A PENDING CHANGE IS JUDGED AGAINST THE EVIDENCE IN FORCE ON THE DAY IT APPLIES.
//
// A nutrition target never lands the moment it is decided — it waits for a natural
// food-day boundary so a partly-lived day is never changed underneath the athlete.
// That wait is the gap this closes: the raise was measured against the target and the
// maintenance estimate of the day it was WRITTEN, and by the boundary both may have
// moved. A queue of such waits is how a target ratchets — each step bounded, each step
// judged against the step before it, and nothing re-asking whether the destination is
// still somewhere the record supports.
//
// So the same law the check-in boundary applies (capProtectiveRaise: protection buys
// maintenance, never a surplus) is applied again HERE, against a freshly derived anchor.
// Deliberately NOT conditioned on whether the original change was protective: the
// grounded ceiling is stricter than maintenance, so this cap can only ever bind on a
// raise that reached the boundary through the protective escape.
//
// Read-only and fail-SOFT: no cut anchor (no reaffirmed cut, an unreadable derivation)
// means no measured maintenance to cap against, and the change applies as decided.
type BoundaryTargetRevalidation =
  | { outcome: "unchanged" }
  | { outcome: "reduced"; target_kcal: number; from_kcal: number; ceiling_kcal: number }
  | { outcome: "set_aside"; from_kcal: number; ceiling_kcal: number; active_kcal: number };

// The smallest calorie move that is worth calling a change — the floor of the same
// canonical 100-250 kcal step this module's own bounded controller uses. Anything
// under it costs a nutrition_targets row, the week's nutrition budget and a
// follow-through window in exchange for a number nobody could feel.
const MIN_MEANINGFUL_TARGET_STEP_KCAL = 100;

// The calorie target the boundary must measure a queued raise against: THE SAME
// NUMBER THE CHECK-IN SEAM DERIVES ITS `previous` FROM (coachOps.ts,
// personalizeNutritionCheckinTarget). Not merely similar — identical, and in the
// same precedence order, because the whole point of re-applying the law here is that
// the two seams agree about what is currently in force.
//
// `getActiveNutritionTarget` is not that number and cannot lead the ladder. It
// returns NULL once a target's adaptive review window elapses, and `effective_target`
// answers that same case by falling back to the FORMULA — so on a review-due row the
// stale accepted kcal is no longer what the athlete eats to. Reading it as `previous`
// puts the clamp's floor BELOW the number in force, and "the raise isn't supported"
// stops being a hold: a stale 1,500 row under a formula target of 1,988 let a queued
// raise land at 1,850 and take 138 kcal off the athlete through a proposal that only
// ever asked to add. A cut nobody asked for is the one outcome this clamp exists to
// make impossible.
//
// So the goal's effective target leads, exactly as it does at the check-in. The two
// accepted-row reads sit behind it for the case it cannot answer — no goal read at
// all — with the stale row last, since by then any number in force beats none.
function activeTargetKcalAtBoundary(asOf: string): number {
  const ladder: Array<() => unknown> = [
    () => (computeGoalCheck() as any)?.effective_target?.target_kcal,
    () => (getActiveNutritionTarget(asOf) as any)?.target_kcal,
    () => (getLatestNutritionTarget(asOf) as any)?.target_kcal,
  ];
  for (const read of ladder) {
    try {
      // `Number(null)` is 0, and a macro-only target row stores a null kcal — coerce
      // absence to NaN so the ladder falls through instead of reading "0 kcal in force".
      const value = Number(read() ?? Number.NaN);
      if (Number.isFinite(value)) return value;
    } catch {
      // Each rung is independently fail-soft; a broken read falls to the next.
    }
  }
  return Number.NaN;
}

function revalidateNutritionTargetAtBoundary(proposal: any, asOf: string): BoundaryTargetRevalidation {
  const proposed = Number(proposal?.parsed?.nutrition?.target_kcal);
  if (!Number.isFinite(proposed)) return { outcome: "unchanged" };
  let anchor: ReturnType<typeof deriveCutTarget> = null;
  try {
    anchor = cutReaffirmation(asOf).reaffirmed ? deriveCutTarget(asOf) : null;
  } catch {
    anchor = null;
  }
  if (!anchor) return { outcome: "unchanged" };
  const active = activeTargetKcalAtBoundary(asOf);
  if (!Number.isFinite(active)) return { outcome: "unchanged" };
  const capped = capProtectiveRaise(proposed, active, anchor.tdee_kcal, anchor.tdee_basis);
  if (!capped.capped) return { outcome: "unchanged" };
  const ceiling = capped.target_kcal;
  // The cap took the raise, or all but a rounding remnant of it: there is no change
  // left worth making. Applying a target a handful of calories from the one in force
  // would write a fresh row, spend the week's nutrition budget and open a
  // follow-through window, all for a number that did not really move.
  if (ceiling - active < MIN_MEANINGFUL_TARGET_STEP_KCAL)
    return { outcome: "set_aside", from_kcal: proposed, ceiling_kcal: ceiling, active_kcal: active };
  return { outcome: "reduced", target_kcal: ceiling, from_kcal: proposed, ceiling_kcal: ceiling };
}

// The set-aside receipt, in the same idiom the thaw uses for a draft whose evidence
// moved: a superseded ledger row saying what was set aside and why, and the draft
// retired — which also cancels the pending decision that was waiting on it.
function setAsideOutrunTargetRaise(
  proposal: any,
  decision: { id?: number | null; context?: any },
  revalidation: Extract<BoundaryTargetRevalidation, { outcome: "set_aside" }>,
  asOf: string
): void {
  const shape = proposalShape(proposal);
  try {
    patchBrainDecision(Number(decision.id), {
      context: {
        ...(decision.context ?? {}),
        boundary_revalidation: {
          outcome: "set_aside",
          from_kcal: Math.round(revalidation.from_kcal),
          ceiling_kcal: Math.round(revalidation.ceiling_kcal),
          active_kcal: Math.round(revalidation.active_kcal),
        },
      },
    });
  } catch {
    /* the receipt below is the authoritative record; a failed stamp must not block it */
  }
  recordDecision({
    // The day the pass is judging, not the wall clock: a receipt for a boundary the
    // caller placed on another date must not file itself under today.
    effective_date: asOf,
    kind: shape.kind,
    domain: shape.domain,
    summary: "A scheduled fuel raise was set aside instead of applied.",
    rationale:
      `By the day this was due to land, ${Math.round(revalidation.from_kcal)} kcal sat above what your own record puts maintenance at, and your target is already there. ` +
      "Protecting your fuel can carry you up to maintenance, never past it, so nothing changed.",
    source: proposal.agent || "autonomy",
    source_ref_type: "plan_proposal",
    source_ref_key: String(proposal.id),
    status: "superseded",
    autonomy_tier: "observe",
    risk_class: shape.risk,
    reversible: false,
    input_fingerprint: null,
    context: {
      boundary_revalidation_receipt: true,
      protective_capped: true,
      proposed_kcal: Math.round(revalidation.from_kcal),
      ceiling_kcal: Math.round(revalidation.ceiling_kcal),
      active_kcal: Math.round(revalidation.active_kcal),
      superseded_pending_decision_id: decision.id ?? null,
    },
    action: {
      proposal_id: proposal.id,
      outcome: "superseded_outrun_evidence",
      reason_provenance: proposalReasonProvenance(proposal),
    },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
  // Retires the draft AND cancels every announced/pending decision pointing at it, so
  // the boundary pass cannot re-offer a raise the evidence has already outrun. The
  // receipt above IS this transition's ledger row — `recordDecision:false` stops the
  // generic supersede audit writing a second, vaguer row over the top of it.
  setProposalStatus(Number(proposal.id), "superseded", { recordDecision: false });
}

// ---- the athlete outranks the machine ----------------------------------------
//
// AN EXPLICIT USER TARGET SET SUPERSEDES EVERY QUEUED AUTOMATED CHANGE TO THE SAME
// METRIC. The athlete drives (VISION.md), and the newest change owns the metric.
//
// The gap this closes is the wait itself. A nutrition target never lands when it is
// decided — it waits for a natural food-day boundary. So an athlete who states their
// own number today can still have a change queued behind it, and tomorrow the boundary
// re-judges that queued raise against the number THEY just set and applies it. The
// re-clamp makes this worse rather than better: it trims the raise to something
// defensible first, so what overrules the athlete arrives looking like a considered
// decision instead of a stale one. Set 1,800 by hand, and a protective raise queued
// last week lands at measured maintenance the next morning.
//
// "Supersedes", not "outranks in a comparison": the queued change is RETIRED, with a
// receipt, so there is nothing left to re-offer on any later pass.
//
// Deliberately NOT inside `setNutritionTarget`. That seam is shared by the check-in
// apply, the boundary apply and Undo — an apply that superseded the queue would retire
// the very decision it is in the middle of landing, and an Undo restoring an earlier
// row would silently cancel unrelated queued work. This belongs to the USER'S DOOR
// alone, which is why it sits one layer above the repo write.
function supersedeQueuedNutritionTargetChanges(asOf: string): number {
  // Both statuses a change can be waiting in. Neither has touched the athlete's intake
  // yet, which is exactly why retiring them costs nothing and leaves nothing to undo.
  const queued = [
    ...listBrainDecisions({ status: "pending", kind: "nutrition_target", limit: 100 }),
    ...listBrainDecisions({ status: "announced", kind: "nutrition_target", limit: 100 }),
  ];
  let superseded = 0;
  for (const decision of queued) {
    try {
      const proposalId = Number((decision.action as any)?.proposal_id);
      const proposal = proposalId > 0 ? getProposal(proposalId) : null;
      recordDecision({
        effective_date: asOf,
        // The queue was filtered on this kind, so the shape is known without re-reading
        // it off a draft that may not exist for every queued decision.
        kind: "nutrition_target",
        domain: "nutrition",
        summary: "A queued fuel change was set aside because you set your own target.",
        rationale:
          "You said what your target is, so the change Cairn had waiting for the next food-day boundary was retired rather than applied on top of it. " +
          "Your number stands until you or a later check-in moves it.",
        source: proposal?.agent || "autonomy",
        source_ref_type: proposal ? "plan_proposal" : (decision.source_ref_type ?? "brain_decision"),
        source_ref_key: proposal ? String(proposalId) : (decision.source_ref_key ?? String(decision.id)),
        status: "superseded",
        autonomy_tier: "observe",
        risk_class: "low",
        reversible: false,
        input_fingerprint: null,
        context: {
          user_target_supersede_receipt: true,
          superseded_pending_decision_id: decision.id ?? null,
          superseded_decision_status: decision.status,
        },
        action: {
          ...(proposal ? { proposal_id: proposalId, reason_provenance: proposalReasonProvenance(proposal) } : {}),
          outcome: "superseded_by_user_target",
        },
        specialist: null,
        applied_at: null,
        reverted_at: null,
        superseded_by: null,
        evaluator_version: null,
      });
      if (proposal) {
        // Retires the draft AND cancels every announced/pending decision pointing at it,
        // this one included. `recordDecision:false` because the receipt above already IS
        // this transition's ledger row.
        setProposalStatus(proposalId, "superseded", { recordDecision: false });
      } else {
        transitionBrainDecision(decision.id!, "canceled");
      }
      superseded += 1;
    } catch {
      // Fail-soft, per this module's rule that bookkeeping never blocks an authoritative
      // write — and here the write is the ATHLETE'S. Refusing their number because a
      // stale queue entry would not retire would be a worse answer than the rare case
      // where one survives, which the boundary's own re-clamp still has to judge.
    }
  }
  return superseded;
}

/**
 * THE USER'S DOOR to their own calorie target.
 *
 * Clears the queue, then writes. Both surfaces (`POST /api/nutrition/target`,
 * MCP `set_nutrition_target`) call this and stay thin; the band check that turns a
 * wild number into a 400 stays at the trust boundary where it belongs.
 *
 * The order is the safe one and not an accident. Reversed — write first, then
 * supersede — a write that landed followed by a supersede that threw would leave
 * precisely the situation this exists to prevent: the athlete's number in force with an
 * automated change still queued to overrule it in the morning. Clearing first fails the
 * other way, toward nothing happening at all.
 */
export function userSetNutritionTarget(
  input: {
    target_kcal: number;
    protein_g?: number | null;
    carbs_g?: number | null;
    fat_g?: number | null;
    note?: string | null;
  },
  asOf: string = localDateISO()
): ReturnType<typeof setNutritionTarget> {
  const optional = (value: unknown): number | null => {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  supersedeQueuedNutritionTargetChanges(asOf);
  return setNutritionTarget({
    target_kcal: Math.round(Number(input.target_kcal)),
    protein_g: optional(input.protein_g),
    carbs_g: optional(input.carbs_g),
    fat_g: optional(input.fat_g),
    source: "user",
    note: typeof input.note === "string" && input.note.trim() ? input.note.trim() : null,
    // effective_date omitted on purpose: setNutritionTarget defaults it to the athlete's
    // local today, which is the only day a hand-set target belongs on.
  });
}

export function applyDueAnnouncedDecisions(asOf = localDateISO()): {
  applied: number[];
  failed: number[];
  delayed: number[];
  // A REFUSAL is not an error. `failed` means the pass tried and could not — a
  // payload that threw, a plan that had moved, a decision that would not transition
  // — and a caller reading it as "something went wrong" is reading it correctly.
  // A raise the evidence outran was judged and declined, on purpose, with a receipt
  // the athlete can read; folding it into `failed` made a working refusal look like
  // a breakage in every count that watches this pass.
  set_aside: number[];
} {
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
        (Number((decision.action as any)?.proposal_id) > 0 ||
          Number((decision.action as any)?.meal_plan_id) > 0 ||
          !!goalDateAdaptationAction(decision.action))
    )
    // OLDEST first (listBrainDecisions returns id DESC): when several decisions share a
    // boundary the newest read must land LAST and win — otherwise a stale restructure
    // could overwrite a fresher one that happened to sort earlier.
    .sort((a, b) => Number(a.id) - Number(b.id));
  const applied: number[] = [];
  const failed: number[] = [];
  const delayed: number[] = [];
  const setAside: number[] = [];
  // A sibling that lands earlier in THIS pass changes the plan and therefore makes
  // later siblings look CAS-stale. Track only those pass-local budget consumers so
  // their policy reason can win that expected collision. A budget spent before this
  // call never enters this set, leaving genuine pre-existing staleness authoritative.
  const budgetLandedInPass = new Set<string>();
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
  // A spent surprise budget DELAYS a due change by a day and leaves it announced/pending
  // (2026-08-17 ruling): the next pass re-offers it, and it lands as soon as the rolling
  // domain-week has room. Parking it at 'review' used to turn "not this week" into a
  // question the athlete had to answer. Termination is owned by the ceilings that should
  // own it — the age gate below rejects a proposal that waited too long, and evidence
  // freshness holds one whose picture moved.
  const delayForSurpriseBudget = (decision: (typeof due)[number], reason: string) => {
    const from = String(decision.effective_date ?? asOf);
    const next = addDaysISO(from > asOf ? from : asOf, 1) ?? asOf;
    try {
      patchBrainDecision(decision.id!, {
        effective_date: next,
        context: {
          ...(decision.context ?? {}),
          surprise_budget_deferred: true,
          surprise_budget_deferred_to: next,
          surprise_budget_reason: reason.slice(0, 300),
        },
      });
      delayed.push(decision.id!);
    } catch {
      /* the pass must survive even when the delay write fails */
    }
  };
  for (const announced of due) {
    try {
      const goalDate = goalDateAdaptationAction(announced.action);
      if (goalDate) {
        // The goal date is read straight off the profile at apply time, not trusted from
        // the announcement: if the athlete moved it themselves while this waited, their
        // hand wins and the stale adaptation is canceled rather than overwriting them.
        const currentGoalDate = isoDateOnly((getProfile() as any)?.goal_date);
        if (currentGoalDate !== goalDate.from) {
          transitionBrainDecision(announced.id!, "canceled");
          failed.push(announced.id!);
          continue;
        }
        withSqliteSavepoint(`due_goal_date_${announced.id}`, () => {
          setProfile({ goal_date: goalDate.to });
          const landed = isoDateOnly((getProfile() as any)?.goal_date);
          if (landed !== goalDate.to) throw new Error("the goal date did not reach the profile");
          const transitioned = transitionBrainDecision(announced.id!, "applied");
          if (!transitioned) throw new Error("the goal-date decision could not reach applied status");
          if (
            !saveBrainRollback(announced.id!, "goal_date", {
              version: 1,
              previous_goal_date: goalDate.from,
              applied_goal_date: goalDate.to,
            })
          ) {
            throw new Error("the goal-date rollback snapshot was not stored");
          }
          const updated = patchBrainDecision(announced.id!, {
            context: { ...(transitioned.context ?? {}), rollback_available: true },
            reversible: true,
          });
          if (!updated) throw new Error("the goal-date decision could not be finalized");
        });
        applied.push(announced.id!);
        continue;
      }
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
          delayForSurpriseBudget(
            announced,
            "this week's nutrition changes are already in; the plan waits for the next boundary"
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
      const boundaryBudgetKind = shape.domain === "nutrition" ? shape.kind : undefined;
      const boundaryBudgetKey = `${shape.domain}:${boundaryBudgetKind ?? "*"}`;
      const coordinated = (announced.context as any)?.coordinated_update === true;
      const routineChange = ROUTINE_CHANGE_SOURCES.has(String(announced.source ?? ""));
      const budgetBlocks = () =>
        !routineChange &&
        !surpriseBudgetAllows(materialChangesThisWeek(shape.domain, ["applied"], boundaryBudgetKind), coordinated);
      // Only a budget consumer that landed earlier in THIS pass gets to precede
      // freshness: its own expected plan mutation caused the sibling's CAS delta.
      if (budgetLandedInPass.has(boundaryBudgetKey) && budgetBlocks()) {
        delayForSurpriseBudget(
          announced,
          "a sibling change landed first this pass; this one waits for the next boundary"
        );
        continue;
      }
      const decisionEvidence =
        announced.context?.proposal_evidence &&
        typeof announced.context.proposal_evidence === "object" &&
        !Array.isArray(announced.context.proposal_evidence) &&
        announced.context.proposal_evidence.version === 1
          ? announced.context.proposal_evidence
          : null;
      const boundaryFreshness = proposalNeedsEvidenceFreshness(shape)
        ? decisionEvidence
          ? verifyProposalEvidenceSnapshot(decisionEvidence as any, asOf)
          : verifyProposalEvidenceFreshness(proposal.parsed, asOf)
        : null;
      if (
        boundaryFreshness &&
        (boundaryFreshness.status === "changed" || boundaryFreshness.status === "unverified")
      ) {
        const changed = boundaryFreshness.changed_components.join(" and ");
        patchBrainDecision(announced.id!, {
          status: "review",
          autonomy_tier: "ask",
          reversible: false,
          context: {
            ...(announced.context ?? {}),
            review_required: true,
            review_reason_code: "stale_snapshot",
            review_reasons: [
              boundaryFreshness.status === "changed"
                ? `${changed || "plan or training"} evidence changed before the apply boundary`
                : "the proposal has no compare-and-set evidence snapshot",
            ],
            proposal_freshness: boundaryFreshness as any,
          },
        });
        failed.push(announced.id!);
        continue;
      }
      // Age is a secondary ceiling after the evidence compare-and-set above. A
      // young proposal can still be stale when the plan changed; an unchanged
      // snapshot can still age out and require a fresh review.
      //
      // It is checked BEFORE the weekly budget on purpose: the budget now DELAYS rather
      // than parks, so age is what terminates a change that keeps waiting. Checking the
      // budget first would let a full domain-week push a decision forward day after day
      // and never let it reach the ceiling that should retire it.
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
      // A pending change is judged against the evidence in force on the day it applies.
      // Placed BEFORE the weekly budget on purpose: a raise the record has already
      // outrun must be set aside now, not delayed a day at a time until the age ceiling
      // eventually retires it without ever saying why.
      let revalidatedTargetKcal: number | undefined;
      if (shape.kind === "nutrition_target") {
        const revalidation = revalidateNutritionTargetAtBoundary(proposal, asOf);
        if (revalidation.outcome === "set_aside") {
          setAsideOutrunTargetRaise(proposal, announced, revalidation, asOf);
          setAside.push(announced.id!);
          continue;
        }
        if (revalidation.outcome === "reduced") {
          revalidatedTargetKcal = revalidation.target_kcal;
          patchBrainDecision(announced.id!, {
            context: {
              ...(announced.context ?? {}),
              boundary_revalidation: {
                outcome: "reduced",
                from_kcal: Math.round(revalidation.from_kcal),
                to_kcal: Math.round(revalidation.target_kcal),
                ceiling_kcal: Math.round(revalidation.ceiling_kcal),
                reason: "protection carries the target to maintenance, never past it",
              },
            },
          });
        }
      }
      // With no pass-local collision, freshness and age have had first refusal. Now the
      // ordinary weekly budget, including changes that landed before this pass began —
      // and it delays rather than parks.
      if (budgetBlocks()) {
        delayForSurpriseBudget(
          announced,
          "this week's changes for this domain are already in; this one waits for the next boundary"
        );
        continue;
      }
      const orphanCleanup = (announced.context as any)?.orphan_sibling_cleanup;
      const rollback = rollbackSnapshot(shape);
      const materialChangesBeforeApply = routineChange
        ? 0
        : materialChangesThisWeek(shape.domain, ["applied"], boundaryBudgetKind);
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
          freshnessCheckedAt: asOf,
          revalidatedTargetKcal,
        }) as any;
        if (!result?.ok) throw new Error(String(result?.error ?? "the change could not be applied"));
        const updated = getBrainDecision(announced.id!);
        if (!updated || updated.status !== "applied") throw new Error("the decision did not reach applied status");
        if (
          !saveBrainRollback(
            announced.id!,
            rollback.kind,
            proposalRollbackPayload(rollback, result)
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
      // The marker means exactly "THIS pass's landing is what closed the budget", so it
      // is asked through surpriseBudgetAllows rather than a literal count — the previous
      // `< 1 … >= 1` form silently encoded a budget of one and stopped firing the moment
      // the pace moved to three.
      if (
        !routineChange &&
        surpriseBudgetAllows(materialChangesBeforeApply) &&
        !surpriseBudgetAllows(materialChangesThisWeek(shape.domain, ["applied"], boundaryBudgetKind))
      ) {
        budgetLandedInPass.add(boundaryBudgetKey);
      }
    } catch (error: any) {
      parkForReview(announced, String(error?.message ?? error ?? "unexpected apply error"));
    }
  }
  return { applied, failed, delayed, set_aside: setAside };
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
        // A user "Hold this" on an announced plan-proposal change is a deliberate
        // veto, not a system supersede. (1) Retire the underlying draft so orphan
        // adoption can never silently re-adopt it — through setProposalStatus, which
        // also retires any live review holds (FIX 1) and cancels sibling
        // announcements. (2) Stamp the canceled decision with a user-hold marker so
        // hasRecentDecisionVeto counts it as a recent "no" for the bounded window
        // (system cancels carry no marker, so a weekly supersede never registers as a
        // veto, and `canceled` never touches the demotion counters).
        if (decision.source_ref_type === "plan_proposal") {
          const proposalId = Number(decision.source_ref_key);
          if (Number.isFinite(proposalId) && proposalId > 0) {
            const draft = getProposal(proposalId);
            if (draft?.status === "draft") setProposalStatus(proposalId, "superseded");
          }
          const held = patchBrainDecision(id, {
            context: { ...((canceled.context as Record<string, unknown>) ?? {}), held_by_user: true },
          });
          return { ok: true, decision: held ?? canceled };
        }
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
      } else if (rollback?.kind === "goal_date" && rollback.payload?.version === 1) {
        // Undo only moves the date when this decision still owns what the profile holds.
        // If the athlete set it themselves after this landed, theirs stands.
        const appliedGoalDate = isoDateOnly(rollback.payload.applied_goal_date);
        if (isoDateOnly((getProfile() as any)?.goal_date) === appliedGoalDate) {
          setProfile({ goal_date: isoDateOnly(rollback.payload.previous_goal_date) ?? "" });
        }
      } else if (rollback?.kind === "recovery_cycle" && rollback.payload?.version === 1) {
        const cycleId = Number(rollback.payload.cycle_id);
        const proposalId = Number(rollback.payload.proposal_id);
        const cycle = getRecoveryCycle(cycleId, localDateISO());
        const action = decision.action as any;
        const ownsCycle =
          cycleId > 0 &&
          proposalId > 0 &&
          Number(action?.recovery_cycle_id) === cycleId &&
          Number(action?.plan_proposal_id) === proposalId &&
          Number(cycle?.overlay?.source_proposal_id) === proposalId &&
          Number(cycle?.overlay?.source_decision_id) === id;
        if (!ownsCycle) throw new Error("recovery-cycle rollback ownership no longer matches");
        cancelRecoveryCycle(cycleId, localDateISO());
      } else {
        throw new Error("rollback snapshot unavailable");
      }
      if (rollback.kind === "training_plan" || rollback.kind === "recovery_cycle") {
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
