import { applyProposalWithAutonomy } from "./autonomy-service.js";
import { getAppState, setAppStateStrict } from "../../repo/app-state.js";
import {
  getBrainDecision,
  getBrainRollback,
  listBrainDecisions,
  recordDecision,
  transitionBrainDecision,
} from "../../repo/brain-decisions.js";
import { MEAL_REFRESH_INSTRUCTION_KEY, MEAL_REFRESH_REQUEST_KEY } from "../../repo/meal-refresh-retry.js";
import { getActiveNutritionTarget } from "../../repo/nutrition.js";
import { getPlan } from "../../repo/plan.js";
import {
  createProposal,
  getProposal,
  recompositionStageAt,
  RECOVERY_WEEK_INSTRUCTION,
  RECOVERY_WEEK_INSTRUCTION_PREFIX,
  recoveryWeekStatus,
  setProposalStatus,
} from "../../repo/profile.js";
import { buildVolumeRestoreProposal } from "../../repo/progression.js";
import { activeRecoveryWeekLedger } from "../../repo/recovery-week-ledger.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "../../repo/shared.js";
import { currentUnderfuelingRead } from "../../repo/underfueling-snapshot.js";
import type { UnderfuelingRead } from "../../repo/underfueling.js";
import { applyPersonalResponseModifier, personalResponseModifierFor } from "../../repo/reaction-model.js";
import { withSqliteSavepoint } from "../../repo/sqlite-savepoint.js";

export { currentUnderfuelingRead } from "../../repo/underfueling-snapshot.js";

const EXECUTION_ACTION_KEY = "underfuel_execution_last_action";
const PRESCRIPTION_ACTION_KEY = "underfuel_prescription_last_action";
const ACTION_COOLDOWN_DAYS = 7;
// The single-source identity of an auto protective-fuel correction draft. Both the
// createProposal write and the stale-draft supersession matcher key off these, so a
// rename can never silently break the dedup (they must stay in lock-step).
const UNDERFUEL_BRAIN_AGENT = "underfuel-brain";
const PROTECTIVE_FUEL_INSTRUCTION = "auto: protective fuel correction";

export interface UnderfuelingControlResult {
  ok: true;
  read: UnderfuelingRead;
  action: "none" | "meal_reshape_queued" | "nutrition_correction_scheduled" | "recovery_package_scheduled";
  coordination_key: string | null;
  nutrition: any | null;
  recovery: any | null;
  reason: string;
  // The one-set-per-boundary climb back out of a protective volume cut, present
  // only on the passes where the fuel read has cleared and something is owed.
  volume_restore?: any | null;
}

function parsedStamp(value: string | null): { date: string; key: string } | null {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    const date = String(parsed?.date ?? "").slice(0, 10);
    const key = String(parsed?.key ?? "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && key ? { date, key } : null;
  } catch {
    return null;
  }
}

function recentlyHandled(stateKey: string, today: string): boolean {
  const stamp = parsedStamp(getAppState(stateKey));
  const age = stamp ? daysBetweenISO(today, stamp.date) : null;
  return age != null && age >= 0 && age < ACTION_COOLDOWN_DAYS;
}

function stampHandled(stateKey: string, today: string, key: string): void {
  setAppStateStrict(stateKey, JSON.stringify({ date: today, key }));
}

function packageAlreadyOwned(coordinationKey: string): boolean {
  const link = listBrainDecisions({ limit: 100 }).find((decision) => {
    if (decision.kind !== "recovery_adjustment" || decision.domain !== "cross_domain" || decision.status !== "observed")
      return false;
    return (
      String((decision.context as any)?.coordination_key ?? "") === coordinationKey &&
      Number((decision.action as any)?.recovery_decision_id) > 0
    );
  });
  if (!link) return false;
  const recovery = getBrainDecision(Number((link.action as any)?.recovery_decision_id));
  const nutritionId = Number((link.action as any)?.nutrition_decision_id);
  const nutrition = nutritionId > 0 ? getBrainDecision(nutritionId) : null;
  return decisionIsOwned(recovery) && (nutritionId <= 0 || decisionIsOwned(nutrition));
}

function decisionIsOwned(decision: any): boolean {
  return !!decision && ["pending", "announced", "applied"].includes(String(decision.status));
}

function resultDecision(result: any): any | null {
  return result?.decision ?? null;
}

function resultOwnsDecision(result: any): boolean {
  return result?.ok === true && decisionIsOwned(resultDecision(result));
}

function decisionReversibility(decision: any): {
  reversible: boolean;
  undo_available_now: boolean;
  mode: "cancel" | "rollback" | "after_apply" | "none";
} {
  if (!decisionIsOwned(decision)) return { reversible: false, undo_available_now: false, mode: "none" };
  // Before apply, cancelability is the truthful protection; the durable ledger
  // does not claim `reversible=true` until an actual rollback snapshot exists.
  if (decision.status === "announced") {
    return { reversible: true, undo_available_now: true, mode: "cancel" };
  }
  if (decision.status === "pending") {
    return { reversible: true, undo_available_now: false, mode: "after_apply" };
  }
  if (decision.reversible !== true) return { reversible: false, undo_available_now: false, mode: "none" };
  const rollback = getBrainRollback(Number(decision.id));
  return rollback
    ? { reversible: true, undo_available_now: true, mode: "rollback" }
    : { reversible: false, undo_available_now: false, mode: "none" };
}

function coordinatedDecision(coordinationKey: string, domain: "nutrition" | "recovery"): any | null {
  return (
    listBrainDecisions({ domain, limit: 100 }).find(
      (decision) =>
        decisionIsOwned(decision) && String((decision.context as any)?.coordination_key ?? "") === coordinationKey
    ) ?? null
  );
}

function recoveryDecisionForStatus(status: ReturnType<typeof recoveryWeekStatus>, today: string): any | null {
  if (status?.state === "upcoming") {
    const decision = getBrainDecision(Number(status.decision_id));
    return decisionIsOwned(decision) ? decision : null;
  }
  if (status?.state === "applied") {
    if (status.cycle_id != null) {
      const cycleDecision = listBrainDecisions({ status: "applied", domain: "recovery", limit: 100 }).find(
        (decision) => Number((decision.action as any)?.recovery_cycle_id) === Number(status.cycle_id)
      );
      if (cycleDecision) return cycleDecision;
    }
    const ledger = activeRecoveryWeekLedger(today);
    if (!ledger) return null;
    return (
      listBrainDecisions({ status: "applied", domain: "recovery", limit: 100 }).find(
        (decision) =>
          String(decision.source_ref_type ?? "") === "plan_proposal" &&
          String(decision.source_ref_key ?? "") === String(ledger.proposal_id)
      ) ?? null
    );
  }
  return null;
}

function linkedExistingRecovery(decision: any, state: "upcoming" | "applied"): any {
  return {
    ok: true,
    reused: true,
    applied: state === "applied",
    announced: state === "upcoming" && decision.status === "announced",
    pending: state === "upcoming" && decision.status === "pending",
    effective_date: decision.effective_date,
    decision,
    reversibility: decisionReversibility(decision),
  };
}

function routeRecoveryProposal(proposalId: number, coordinationKey: string): any {
  return applyProposalWithAutonomy(proposalId, {
    requested_tier: "announce",
    safety_response: true,
    coordinated_update: true,
    coordination_key: coordinationKey,
  });
}

function recordPackageLink(coordinationKey: string, nutrition: any | null, recovery: any, today: string): any {
  const nutritionDecision = resultDecision(nutrition);
  const recoveryDecision = resultDecision(recovery);
  if (!decisionIsOwned(recoveryDecision)) return null;
  const recoveryReversibility = decisionReversibility(recoveryDecision);
  const nutritionReversibility = nutritionDecision
    ? decisionReversibility(nutritionDecision)
    : { reversible: false, undo_available_now: false, mode: "none" as const };
  const bothReversible = recoveryReversibility.reversible && (!nutritionDecision || nutritionReversibility.reversible);
  return recordDecision({
    effective_date: today,
    kind: "recovery_adjustment",
    domain: "cross_domain",
    summary: bothReversible
      ? "The protective fuel correction and recovery plan are linked as one reversible expert-team response."
      : "The protective fuel correction is linked to a recovery plan that was already live; Undo availability remains separate and explicit.",
    rationale: recoveryReversibility.reversible
      ? "This immutable link records coordination without rewriting either original decision or its Undo history."
      : "The existing recovery plan is retained as accountability evidence, not relabeled as reversible; only decisions with a real rollback or cancel path claim Undo.",
    source: "underfuel-brain",
    source_ref_type: null,
    source_ref_key: null,
    status: "observed",
    autonomy_tier: "observe",
    risk_class: "low",
    reversible: false,
    input_fingerprint: null,
    context: {
      coordination_key: coordinationKey,
      evidence_keys: [
        `brain_decision:${recoveryDecision.id}`,
        ...(nutritionDecision?.id ? [`brain_decision:${nutritionDecision.id}`] : []),
      ],
      evidence_observed_at: new Date().toISOString(),
    },
    action: {
      recovery_decision_id: recoveryDecision.id,
      recovery_proposal_id: Number(recoveryDecision.source_ref_key) || null,
      nutrition_decision_id: nutritionDecision?.id ?? null,
      recovery_reversible: recoveryReversibility.reversible,
      recovery_undo_available_now: recoveryReversibility.undo_available_now,
      recovery_undo_mode: recoveryReversibility.mode,
      nutrition_reversible: nutritionReversibility.reversible,
      nutrition_undo_available_now: nutritionReversibility.undo_available_now,
      nutrition_undo_mode: nutritionReversibility.mode,
      undo_decision_ids: [
        ...(recoveryReversibility.undo_available_now ? [recoveryDecision.id] : []),
        ...(nutritionDecision?.id && nutritionReversibility.undo_available_now ? [nutritionDecision.id] : []),
      ],
      undo_is_owned_by_original_decisions: recoveryReversibility.reversible || nutritionReversibility.reversible,
    },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;
}

function mealReshapeInstruction(read: UnderfuelingRead): string {
  return [
    "Refresh the upcoming week so the accepted calorie and protein targets are easier to complete in real life.",
    "Keep calories unchanged. Use simpler portions, practical timing, and carb-forward fuel around training without eating back literal exercise calories.",
    "Preserve the athlete's dietary constraints, preferences, health directives, schedule, and protein floor.",
    `Ground the refresh in this uncertainty-aware read: ${read.rationale} ${read.action.line}`,
  ].join(" ");
}

export function personalizedNutritionStep(base: number, today = localDateISO(), ceiling = 250): number {
  const stage = recompositionStageAt(today).kind;
  const modifier = personalResponseModifierFor("nutrition_step", { stage });
  const safeCeiling = Math.max(100, Math.min(250, Number.isFinite(ceiling) ? ceiling : 250));
  const adjusted = applyPersonalResponseModifier({
    base,
    modifier,
    min: 100,
    max: safeCeiling,
    safety_floor: 100,
    safety_ceiling: safeCeiling,
  });
  return Math.max(100, Math.min(safeCeiling, Math.round(adjusted / 25) * 25));
}

function nutritionProposal(
  read: UnderfuelingRead,
  today: string,
  coordinationKey: string | null,
  delta: number
): any | null {
  const active = getActiveNutritionTarget(today) as any;
  const current = Number(active?.target_kcal);
  if (!Number.isFinite(current) || current <= 0) return null;
  const boundedDelta = Math.max(100, Math.min(250, Math.round(delta / 25) * 25));
  const nextKcal = Math.round(current + boundedDelta);
  const macro = (value: unknown): number | null => {
    if (value == null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const protein = macro(active?.protein_g);
  const carbs = macro(active?.carbs_g);
  const fat = macro(active?.fat_g);
  const nutrition = {
    target_kcal: nextKcal,
    prev_target_kcal: Math.round(current),
    protein_g: protein == null ? null : Math.round(protein),
    carbs_g: carbs == null ? null : Math.round(carbs + boundedDelta / 4),
    fat_g: fat == null ? null : Math.round(fat),
    delta_kcal: boundedDelta,
    reason:
      read.state === "persistent_strain"
        ? "Independent outcome channels still show strain after the prior correction settled, so fuel moves one bounded step toward maintenance while training recovers."
        : "Completed-day intake is near target while robust outcome channels agree that the current prescription is too aggressive; add one bounded carb-forward step.",
    underfueling_signature: read.signature,
    coordination_key: coordinationKey,
  };
  return createProposal(UNDERFUEL_BRAIN_AGENT, PROTECTIVE_FUEL_INSTRUCTION, "", {
    kind: "nutrition_target",
    summary:
      read.state === "persistent_strain"
        ? `Move fuel ${boundedDelta} kcal toward maintenance for the coordinated recovery block.`
        : `Add ${boundedDelta} kcal of training-supportive fuel at the next food-day boundary.`,
    rationale: read.rationale,
    nutrition,
  });
}

function recoveryItems(items: any[]): any[] {
  return (Array.isArray(items) ? items : []).map((item: any) => {
    if (item?.kind === "cardio") {
      return {
        ...item,
        target_duration_min: Number.isFinite(Number(item.target_duration_min))
          ? Math.max(10, Math.round(Number(item.target_duration_min) * 0.7))
          : item.target_duration_min,
        target_distance_km: Number.isFinite(Number(item.target_distance_km))
          ? Math.max(1, Math.round(Number(item.target_distance_km) * 0.7 * 10) / 10)
          : item.target_distance_km,
        target_zone: "Z1-Z2",
        note: [item.note, "Recovery week: easy conversational work; no hard intervals."].filter(Boolean).join(" "),
      };
    }
    const targetWeight = Number(item?.target_weight);
    const targetSeconds = Number(item?.target_seconds);
    return {
      ...item,
      sets: Number.isFinite(Number(item?.sets)) ? Math.max(1, Math.ceil(Number(item.sets) / 2)) : item?.sets,
      target_weight:
        Number.isFinite(targetWeight) && targetWeight > 0
          ? Math.round(targetWeight * 0.9 * 2) / 2
          : item?.target_weight,
      target_seconds:
        Number.isFinite(targetSeconds) && targetSeconds > 0
          ? Math.max(10, Math.round(targetSeconds * 0.8))
          : item?.target_seconds,
      note: [item?.note, "Recovery week: easy, crisp work with 3-4 reps in reserve; no PR attempts."]
        .filter(Boolean)
        .join(" "),
    };
  });
}

function recoveryProposal(read: UnderfuelingRead, coordinationKey: string): any | null {
  const days = (getPlan() as any[])
    .filter((day) => Array.isArray(day?.items) && day.items.length)
    .map((day) => ({
      day_number: Number(day.day_number),
      name: String(day.name ?? "Recovery"),
      focus: day.focus == null ? null : String(day.focus),
      items: recoveryItems(day.items),
    }));
  if (!days.length) return null;
  return createProposal(UNDERFUEL_BRAIN_AGENT, `${RECOVERY_WEEK_INSTRUCTION} Coordinated key: ${coordinationKey}.`, "", {
    summary: "A coordinated recovery week is scheduled so strength and recovery can absorb the current block.",
    rationale: read.rationale,
    coordination_key: coordinationKey,
    // The same-read match key for the recovery pile-up guard (mirrors nutrition's
    // parsed.nutrition.underfueling_signature), so a fresh held recovery draft/review can
    // retire its stale same-signature predecessor instead of stacking daily.
    underfueling_signature: read.signature,
    days,
  });
}

// A held protective-fuel correction (review posture, a spent nutrition budget, or a
// veto-demoted domain) is deliberately NOT stamped with the seven-day cooldown so it
// stays retry-able — but that means a daily scheduler pass would create one fresh held
// draft per day for the SAME unchanged read, stacking identical "needs your decision"
// cards (createProposal has no dedup). Retire the older still-open review draft(s) for
// this exact read the moment a fresher one is held, so at most one protective-fuel
// review draft is ever open. The retirement is two-sided (mirroring
// applyMealPlanWithAutonomy): every open review decision on the stale draft is
// superseded AND the draft itself is retired, so no dangling review row is left behind
// and the boundary/orphan passes can never resurrect it.
function supersedeStaleProtectiveFuelReviewDrafts(signature: string, exceptProposalId?: number): void {
  const sig = String(signature ?? "");
  if (!sig) return;
  const held = listBrainDecisions({ status: "review", kind: "nutrition_target", domain: "nutrition", limit: 100 });
  const staleProposalIds = new Set<number>();
  for (const decision of held) {
    if (String(decision.source_ref_type) !== "plan_proposal") continue;
    const proposalId = Number(decision.source_ref_key);
    if (!(proposalId > 0) || proposalId === exceptProposalId) continue;
    const proposal = getProposal(proposalId) as any;
    if (
      !proposal ||
      proposal.status !== "draft" ||
      String(proposal.agent) !== UNDERFUEL_BRAIN_AGENT ||
      String(proposal.instruction) !== PROTECTIVE_FUEL_INSTRUCTION ||
      String(proposal.parsed?.nutrition?.underfueling_signature ?? "") !== sig
    )
      continue;
    staleProposalIds.add(proposalId);
  }
  for (const proposalId of staleProposalIds) {
    // Cancel EVERY open review decision on the draft (a later orphan-adoption pass can
    // add a second) before retiring the draft, so the ledger keeps no live review row.
    for (const decision of held) {
      if (Number(decision.source_ref_key) === proposalId) transitionBrainDecision(Number(decision.id), "superseded");
    }
    setProposalStatus(proposalId, "superseded");
  }
}

// The recovery half of the same pile-up guard. Unlike the nutrition draft (a FRESH
// proposal is minted per pass), the recovery-week draft is REUSED across daily passes —
// recoveryWeekStatus finds it as 'drafted' and re-routes it — so what stacks under review
// posture is a fresh review DECISION on the same draft every day. Keep only the freshest
// same-signature protective recovery review decision, superseding the rest, and retire any
// recovery draft the kept decision no longer owns. Matches the underfueling recovery draft
// by agent + RECOVERY_WEEK_INSTRUCTION_PREFIX + parsed.underfueling_signature.
function supersedeStaleProtectiveFuelRecoveryDrafts(signature: string, keepDecisionId?: number): void {
  const sig = String(signature ?? "");
  if (!sig) return;
  const held = listBrainDecisions({ status: "review", kind: "training_structure", domain: "recovery", limit: 100 });
  const ours = held.filter((decision) => {
    if (String(decision.source_ref_type) !== "plan_proposal") return false;
    const proposalId = Number(decision.source_ref_key);
    if (!(proposalId > 0)) return false;
    const proposal = getProposal(proposalId) as any;
    return (
      !!proposal &&
      proposal.status === "draft" &&
      String(proposal.agent) === UNDERFUEL_BRAIN_AGENT &&
      String(proposal.instruction ?? "").startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX) &&
      String(proposal.parsed?.underfueling_signature ?? "") === sig
    );
  });
  const keptProposalId =
    keepDecisionId != null ? Number(ours.find((d) => Number(d.id) === keepDecisionId)?.source_ref_key) || null : null;
  const orphaned = new Set<number>();
  for (const decision of ours) {
    if (keepDecisionId != null && Number(decision.id) === keepDecisionId) continue;
    transitionBrainDecision(Number(decision.id), "superseded");
    const proposalId = Number(decision.source_ref_key);
    // Only retire the draft itself if the kept decision does not still own it (in the
    // common reuse case every stale decision shares the one kept draft, so nothing is retired).
    if (keptProposalId == null || proposalId !== keptProposalId) orphaned.add(proposalId);
  }
  for (const proposalId of orphaned) setProposalStatus(proposalId, "superseded");
}

function scheduleNutrition(
  read: UnderfuelingRead,
  today: string,
  coordinationKey: string | null,
  delta: number,
  ceiling = 250
): any | null {
  const proposal = nutritionProposal(read, today, coordinationKey, personalizedNutritionStep(delta, today, ceiling));
  if (!proposal) return null;
  return applyProposalWithAutonomy(Number(proposal.id), {
    requested_tier: "quiet_apply",
    safety_response: true,
    coordinated_update: coordinationKey != null,
    coordination_key: coordinationKey ?? undefined,
  });
}

/**
 * The road back up from a protective volume cut. A fuel-protection hold takes sets
 * OFF the plan, and nothing in the progression ladder can put them back — so once
 * the read that asked for less has cleared, each cut lift takes one set back per
 * boundary until it reaches the value the reduction recorded.
 *
 * It goes through the ordinary propose→apply path at ANNOUNCE, never quietly: the
 * athlete sees their volume coming back and can stop it. Returns null when nothing
 * is owed, which is the common answer.
 *
 * Scoped to volume the FUEL path itself took off. A cut that pain or a deload block
 * asked for keeps its recorded debt, but this trigger is not the one that cleared it
 * — climbing it back here would tell the athlete a fuelling story about a decision
 * fuelling never made.
 */
function runVolumeRestorePass(): any | null {
  try {
    return withSqliteSavepoint("volume_restore_pass", () => {
      const built = buildVolumeRestoreProposal({ cause: "fuel" });
      if (!built.ok) return null;
      return applyProposalWithAutonomy(Number(built.proposal.id), { requested_tier: "announce" });
    });
  } catch {
    // The climb back is re-derived from the plan on every pass, so a failed one
    // costs nothing but a day — it must never sink the fuel loop around it.
    return null;
  }
}

/**
 * Deterministic under-fuelling control loop. Most calls are a no-op: no agent is
 * invoked, one noisy day never acts, and the seven-day settling window prevents
 * calorie ping-pong. Material actions use the existing autonomy/Undo ledger.
 */
export function runUnderfuelingControlLoop(
  today = localDateISO(),
  opts: { read?: UnderfuelingRead } = {}
): UnderfuelingControlResult {
  const read = opts.read ?? currentUnderfuelingRead(today);
  // The trigger that took volume away is this same read's training action. Once it
  // says proceed, the hold has cleared and what it held back is owed at this
  // boundary — checked before the branches below, all of which return early.
  const volumeRestore = read.action.training === "proceed" ? runVolumeRestorePass() : null;
  const none = (reason = read.action.line): UnderfuelingControlResult => ({
    ok: true,
    read,
    action: "none",
    coordination_key: null,
    nutrition: null,
    recovery: null,
    reason,
    ...(volumeRestore ? { volume_restore: volumeRestore } : {}),
  });

  if (read.state === "execution_gap") {
    if (recentlyHandled(EXECUTION_ACTION_KEY, today))
      return none("The easier meal pattern is already in flight; hold calories steady.");
    const boundary = addDaysISO(today, 1) ?? today;
    try {
      withSqliteSavepoint("underfuel_execution_gap", () => {
        setAppStateStrict(MEAL_REFRESH_REQUEST_KEY, boundary);
        setAppStateStrict(MEAL_REFRESH_INSTRUCTION_KEY, mealReshapeInstruction(read));
        stampHandled(EXECUTION_ACTION_KEY, today, read.signature);
      });
    } catch {
      return none("The easier meal pattern could not be queued yet; no cooldown was recorded, so Cairn can retry.");
    }
    return {
      ok: true,
      read,
      action: "meal_reshape_queued",
      coordination_key: null,
      nutrition: null,
      recovery: null,
      reason: "The target stays fixed; the next meal boundary gets a simpler, carb-forward execution pattern.",
      ...(volumeRestore ? { volume_restore: volumeRestore } : {}),
    };
  }

  if (read.state === "prescription_strain") {
    if (recentlyHandled(PRESCRIPTION_ACTION_KEY, today))
      return none("A bounded fuel correction is already scheduled inside the seven-day no-double-adjust window.");
    let nutrition: any | null = null;
    try {
      nutrition = withSqliteSavepoint("underfuel_prescription", () => {
        const scheduled = scheduleNutrition(read, today, null, Number(read.action.kcal_delta) || 150);
        // A held correction leaves the cooldown unstamped (retry-able); retire the older
        // still-open review draft for this same read so held drafts don't pile up daily.
        if (scheduled?.review_required)
          supersedeStaleProtectiveFuelReviewDrafts(read.signature, Number(scheduled.proposal?.id));
        if (!resultOwnsDecision(scheduled)) return scheduled;
        stampHandled(PRESCRIPTION_ACTION_KEY, today, read.signature);
        setAppStateStrict(MEAL_REFRESH_INSTRUCTION_KEY, mealReshapeInstruction(read));
        return scheduled;
      });
    } catch {
      return none(
        "The bounded correction could not be scheduled atomically; no cooldown was recorded, so Cairn can retry."
      );
    }
    if (!resultOwnsDecision(nutrition)) {
      return none(
        nutrition?.review_required
          ? "The bounded correction is available for review under the configured posture; no automatic cooldown was recorded."
          : "No active accepted target is available for a bounded correction."
      );
    }
    return {
      ok: true,
      read,
      action: "nutrition_correction_scheduled",
      coordination_key: null,
      nutrition,
      recovery: null,
      reason: "One bounded carb-forward correction is scheduled; the seven-day settling window blocks a second move.",
    };
  }

  if (read.state !== "persistent_strain") return none();

  const coordinationKey = `underfuel-recovery:${read.correction.target_id ?? "target"}:${read.correction.effective_date ?? today}`;
  if (packageAlreadyOwned(coordinationKey))
    return none("The coordinated recovery package is already owned by the autonomy ledger.");

  try {
    return withSqliteSavepoint("underfuel_recovery_package", () => {
      const activeTarget = getActiveNutritionTarget(today) as any;
      const currentKcal = Number(activeTarget?.target_kcal);
      const tdee = read.intake.maintenance_estimate_kcal;
      // The outcome estimate is deliberately not treated as an exercise-calorie bill.
      // With no direct TDEE on the read, a conservative 150 kcal step is safer than
      // guessing maintenance; the shared proposal clamp still owns the 100-250 range.
      const towardMaintenance = tdee != null && Number.isFinite(currentKcal) ? Math.min(250, tdee - currentKcal) : 150;
      const priorNutrition = coordinatedDecision(coordinationKey, "nutrition");
      const nutrition = priorNutrition
        ? { ok: true, reused: true, decision: priorNutrition }
        : towardMaintenance >= 100
          ? scheduleNutrition(read, today, coordinationKey, towardMaintenance, Math.min(250, towardMaintenance))
          : null;
      // A held (review-posture) fuel correction leaves the cooldown unstamped so it stays
      // retry-able; retire the older same-signature review draft so held nutrition drafts
      // don't pile up daily, exactly like prescription_strain.
      if (nutrition?.review_required)
        supersedeStaleProtectiveFuelReviewDrafts(read.signature, Number(nutrition.proposal?.id));
      const existingRecovery = recoveryWeekStatus(today);
      let recovery: any | null = null;
      const existingRecoveryDecision = recoveryDecisionForStatus(existingRecovery, today);
      if (existingRecoveryDecision && existingRecovery && existingRecovery.state !== "drafted") {
        recovery = linkedExistingRecovery(existingRecoveryDecision, existingRecovery.state);
      } else if (existingRecovery?.state === "drafted") {
        // A bare draft is not scheduled. Route that exact proposal through autonomy
        // now, preserving its immutable history and avoiding a duplicate reshape.
        const draft = getProposal(existingRecovery.proposal_id);
        if (draft) recovery = routeRecoveryProposal(Number(draft.id), coordinationKey);
      } else if (!existingRecovery) {
        const proposal = recoveryProposal(read, coordinationKey);
        if (proposal) recovery = routeRecoveryProposal(Number(proposal.id), coordinationKey);
      }
      // Same guard for the recovery half: a held recovery review keeps at most one live
      // same-signature review decision instead of minting a fresh one every daily pass.
      if (recovery?.review_required)
        supersedeStaleProtectiveFuelRecoveryDrafts(read.signature, Number(recovery.decision?.id));
      if (!nutrition && !recovery && !existingRecovery)
        return none("No active nutrition target or training plan is available to coordinate.");
      const nutritionOwned = towardMaintenance < 100 || resultOwnsDecision(nutrition);
      const recoveryOwned = resultOwnsDecision(recovery);
      if (!recoveryOwned || !nutritionOwned) {
        return {
          ok: true,
          read,
          action: resultOwnsDecision(nutrition) ? "nutrition_correction_scheduled" : "none",
          coordination_key: coordinationKey,
          nutrition,
          recovery,
          reason: recoveryOwned
            ? "The recovery half is owned, but the bounded fuel half is not yet scheduled; the package remains open."
            : "The recovery draft is not scheduled under the configured posture, so Cairn is not reporting a coordinated recovery package yet.",
        };
      }
      const link = recordPackageLink(coordinationKey, nutrition, recovery, today);
      if (!link) {
        return {
          ok: true,
          read,
          action: resultOwnsDecision(nutrition) ? "nutrition_correction_scheduled" : "none",
          coordination_key: coordinationKey,
          nutrition,
          recovery,
          reason:
            "The recovery decision could not be linked immutably, so Cairn is not reporting the package as scheduled.",
        };
      }
      recovery = { ...recovery, package_link: link };
      setAppStateStrict(MEAL_REFRESH_INSTRUCTION_KEY, mealReshapeInstruction(read));
      return {
        ok: true,
        read,
        action: "recovery_package_scheduled",
        coordination_key: coordinationKey,
        nutrition,
        recovery,
        reason: existingRecoveryDecision
          ? decisionReversibility(existingRecoveryDecision).reversible
            ? "The existing owned recovery week is retained and immutably linked to the bounded fuel step; each reversible half keeps its original Undo."
            : "The recovery week was already live without a rollback snapshot, so it is linked as non-reversible accountability evidence; only the bounded nutrition decision claims Undo."
          : "A reversible recovery week and bounded move toward maintenance are linked for their natural boundaries.",
      };
    });
  } catch {
    return none("The coordinated recovery package could not be scheduled atomically; no cooldown was recorded.");
  }
}
