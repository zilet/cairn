import { db } from "../db.js";
import type { ProposedExpectation } from "../brain/expectation-contract.js";
import {
  getBrainDecision,
  insertBrainExpectation,
  listBrainDecisions,
  listBrainExpectations,
  patchBrainDecision,
  recordDecision,
  supersedeReviewDecisionsForProposal,
  transitionBrainDecision,
} from "./brain-decisions.js";
import {
  buildLiftProgressionExpectations,
  buildTrainingFeedbackExpectations,
  liftProgressionSubjects,
  rebaseDeferredExpectations,
} from "./brain/change-expectations.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { estimateExpenditure } from "./expenditure.js";
import { invalidateDayRead } from "./intelligence.js";
import { setNutritionTarget } from "./nutrition.js";
import {
  type AccountablePlanChangeRecord,
  type ClampAdjustment,
  type PlanPrescription,
  applyPlanChange,
  getPlan,
  planPrescriptionDiff,
  planPrescriptionKey,
  planPrescriptionSnapshot,
  planRestructureReasons,
  replacePlan,
} from "./plan.js";
import { PlanQualityError, type PlanQualityReport, qualityIssueKey, validateTrainingPlan } from "./plan-quality.js";
import { readVolumeFloorContext } from "./volume-floor-context.js";
import { orderPlanDaysForEffect } from "../domain/training/plan-item-order.js";
import { computeGoalCheck, KCAL_ABSOLUTE_FLOOR, KCAL_PER_LB, recompositionStageAt } from "./profile.js";
import { volumeRestoreLedger } from "./volume-guard.js";
import { localDateISO, parseDbTime } from "./shared.js";
import { bumpTrainingDataVersion } from "./training-cache.js";
import { automaticOrphanIntent, chatOrphanIntent } from "./proposal-intent.js";
import { PROTECTIVE_FUEL_ASK_SQL } from "./protective-fuel-draft.js";
import { type MarkerInterventionRecording, markerInterventionRecording } from "./marker-response.js";
import {
  RECOVERY_WEEK_INSTRUCTION_PREFIX,
  stampRecoveryWeekApplied,
  stampRecoveryWeekAppliedStrict,
} from "./recovery-week-ledger.js";
import { activateRecoveryCycle, scheduleRecoveryCycle } from "./recovery-cycles.js";
import { afterSqliteCommit, withSqliteSavepoint } from "./sqlite-savepoint.js";
import {
  normalizeStoredProposalPayload,
  prepareProposalPayload,
  proposalEvidenceSnapshot,
  verifyProposalEvidenceFreshness,
} from "./proposal-truth.js";

// ---------- proposals ----------
export function createProposal(agent: string, instruction: string, raw: string, parsed: any) {
  const storedParsed = parsed ? prepareProposalPayload(parsed) : null;
  const info = db
    .prepare(`INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json) VALUES (?, ?, ?, ?)`)
    .run(agent, instruction || "", raw || "", storedParsed ? JSON.stringify(storedParsed) : null);
  // Proposal state feeds the conductor (a pending recovery draft flips its button
  // into a review link) — invalidate the version-keyed memos on every write.
  afterSqliteCommit(bumpTrainingDataVersion);
  return getProposal(Number(info.lastInsertRowid));
}

export function listProposals(limit = 20) {
  const rows = db.prepare(`SELECT * FROM plan_proposals ORDER BY id DESC LIMIT ?`).all(limit) as any[];
  return rows.map(hydrateProposal);
}

// Review posture needs the complete review queue, including generic requested
// reviews. Coach-led Today uses the attention-filtered variant below instead.
export function listReviewHeldProposals(limit = 20) {
  const rows = db
    .prepare(
      `SELECT p.*
         FROM plan_proposals p
        WHERE p.status = 'draft'
          AND EXISTS (
            SELECT 1
              FROM brain_decisions d
             WHERE d.source_ref_type = 'plan_proposal'
               AND d.source_ref_key = CAST(p.id AS TEXT)
               AND d.status = 'review'
          )
        ORDER BY (
          SELECT MAX(d.id)
            FROM brain_decisions d
           WHERE d.source_ref_type = 'plan_proposal'
             AND d.source_ref_key = CAST(p.id AS TEXT)
             AND d.status = 'review'
        ) DESC
        LIMIT ?`
    )
    .all(limit) as any[];
  return rows.map(hydrateProposal);
}

// Coach-led Today only interrupts for independent-review boundaries. A budget hold is a
// WAIT, not an ask: it lands automatically when the surprise-budget week rolls over (orphan
// adoption re-offers it), so it never belongs on Today and is intentionally NOT in this list.
// Filter the interrupting reason codes in SQL BEFORE the bounded limit so a stream of generic
// requested-review bookkeeping cannot crowd an older safety/user-lock/policy hold out.
//
// ONE further shape is admitted, and it is not a reason code: the standing protective-fuel
// ask (PROTECTIVE_FUEL_ASK_SQL). It lands as an ordinary `requested_review` under a coach-led
// posture, but it is a QUESTION that changes nothing until the athlete answers it — and an ask
// they never see is indistinguishable from no ask. The gate stays shut for every OTHER
// requested_review row; see protective-fuel-draft.ts for why this one is different.
export function listAttentionReviewHeldProposals(limit = 20) {
  const rows = db
    .prepare(
      `SELECT p.*
         FROM plan_proposals p
        WHERE p.status = 'draft'
          AND EXISTS (
            SELECT 1
              FROM brain_decisions d
             WHERE d.source_ref_type = 'plan_proposal'
               AND d.source_ref_key = CAST(p.id AS TEXT)
               AND d.status = 'review'
               AND (
                 json_extract(d.context_json, '$.review_reason_code') IN
                   ('safety_floor','user_lock','domain_policy','clinical')
                 OR ${PROTECTIVE_FUEL_ASK_SQL}
               )
          )
        ORDER BY (
          SELECT MAX(d.id)
            FROM brain_decisions d
           WHERE d.source_ref_type = 'plan_proposal'
             AND d.source_ref_key = CAST(p.id AS TEXT)
             AND d.status = 'review'
             AND (
               json_extract(d.context_json, '$.review_reason_code') IN
                 ('safety_floor','user_lock','domain_policy','clinical')
               OR ${PROTECTIVE_FUEL_ASK_SQL}
             )
        ) DESC
        LIMIT ?`
    )
    .all(limit) as any[];
  return rows.map(hydrateProposal);
}

// The BARE status of one draft — the sibling of mealPlanStatus, and for the same reason:
// hydrateProposal normalizes the whole stored payload and reads the ledger for the
// draft's autonomy row, which is a great deal of work when the caller only needs to know
// whether the draft is still live. Null means no such row.
export function proposalStatus(id: number): string | null {
  const row = db.prepare(`SELECT status FROM plan_proposals WHERE id = ?`).get(Math.trunc(Number(id))) as any;
  return row ? String(row.status ?? "") : null;
}

export function getProposal(id: number) {
  const row = db.prepare(`SELECT * FROM plan_proposals WHERE id = ?`).get(id) as any;
  return row ? hydrateProposal(row) : null;
}

function hydrateProposal(row: any) {
  let parsed: any = null;
  try {
    parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null;
  } catch {
    parsed = null;
  }
  // Quarantine per ROW, never per list. Normalization is the read path's last defence
  // and it clamps rather than throws, but a payload can still be malformed in a way it
  // cannot repair — and a list that throws on one such row takes every healthy row with
  // it (that is how draft adoption stopped for days). A quarantined row comes back with
  // its raw stored payload and a marker, so callers can show it and diagnose it.
  let hydrationError: string | null = null;
  try {
    parsed = normalizeStoredProposalPayload(parsed, row.created_at);
  } catch (error) {
    hydrationError = String(error instanceof Error ? error.message : error).slice(0, 300);
  }
  const autonomy = db
    .prepare(
      `SELECT id, status, autonomy_tier, effective_date, summary, context_json
       FROM brain_decisions
       WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ?
         -- 'rejected' is here so a draft a ceiling has already refused (the boundary
         -- pass's age gate) carries that verdict on its face: the orphan-adoption sweep
         -- reads this status to decide whether a draft is still free to be re-offered,
         -- and a refused draft that looked unowned was re-announced and refused again
         -- every day. Every consumer tests for an explicit status, so a rejected row
         -- reads as "not owned, not a review hold" without changing any other branch.
         AND status IN ('review','announced','pending','applied','rejected')
       ORDER BY id DESC LIMIT 1`
    )
    .get(String(row.id)) as any;
  let autonomyContext: any = null;
  try {
    autonomyContext = autonomy?.context_json ? JSON.parse(String(autonomy.context_json)) : null;
  } catch {
    autonomyContext = null;
  }
  return {
    ...row,
    parsed,
    ...(hydrationError ? { hydration_error: hydrationError } : {}),
    autonomy: autonomy
      ? {
          id: Number(autonomy.id),
          status: String(autonomy.status),
          tier: String(autonomy.autonomy_tier),
          effective_date: autonomy.effective_date == null ? null : String(autonomy.effective_date),
          summary: autonomy.summary == null ? null : String(autonomy.summary),
          review_required: autonomy.status === "review" || autonomyContext?.review_required === true,
          review_reason_code: autonomyContext?.review_reason_code ?? null,
          reasons: Array.isArray(autonomyContext?.review_reasons) ? autonomyContext.review_reasons : [],
        }
      : null,
  };
}

export function setProposalStatus(
  id: number,
  status: string,
  opts: {
    deferTrainingVersionBump?: boolean;
    // Whether this transition should write its own generic audit row. Default true —
    // a discard or a supersede that nothing else explained needs SOME ledger entry.
    // A caller that has ALREADY written the specific receipt for this transition
    // passes false, so the athlete reads one row saying what happened rather than a
    // vague second one filed beside it.
    recordDecision?: boolean;
  } = {}
) {
  db.prepare(`UPDATE plan_proposals SET status = ? WHERE id = ?`).run(status, id);
  // applyProposal batches the plan mutation and its proposal-state transition into
  // one logical cache invalidation after the SQL unit commits. Other callers keep
  // the immediate invalidation contract.
  if (!opts.deferTrainingVersionBump) afterSqliteCommit(bumpTrainingDataVersion); // proposal state feeds the conductor's memoized read
  // A retired draft (the user's explicit discard, or a fresher draft superseding it)
  // makes any standing announced/pending brain decision pointing at it MOOT — cancel
  // those decisions NOW so the boundary pass can never apply a proposal that is no
  // longer live (re-applying a vetoed replacePlan would be the worst surprise).
  // 'applied' is deliberately NOT handled here: the authoritative apply flow
  // (applyProposal) already cancels around its own decision, passing the applying
  // decision as the exception.
  if (status === "discarded" || status === "superseded") cancelAnnouncementsForProposal(id);
  // A terminal transition of the underlying draft also retires any live `review`
  // hold on it (a freed budget hold, a lead-mode review posture). Without this, a
  // held draft that is later applied/discarded/superseded through a path OTHER than
  // applyProposalWithAutonomy's own supersedePriorReviewHolds (a manual apply, a
  // weekly supersede, the user's discard) leaves a dangling open review decision the
  // ledger keeps reading as an active hold. Idempotent — a no-op when the autonomy
  // layer already superseded the rows.
  if (status === "applied" || status === "discarded" || status === "superseded")
    supersedeReviewDecisionsForProposal(id);
  const proposal = getProposal(id);
  if (proposal && status !== "applied" && opts.recordDecision !== false) recordProposalStatusDecision(proposal, status);
  return proposal;
}

export interface OrphanSiblingCleanup {
  intent_key: string;
  eligible_before: string;
  provenance?: "automatic" | "chat" | "background_chat";
  burst_after?: string;
  burst_before?: string;
}

export interface NormalizedProposalApplyPayload {
  parsed: any;
  migration: {
    code: string;
    reason: string;
    source_ref_type: "plan_proposal";
    source_proposal_id: number;
    source_burst_proposal_ids: number[];
    normalized_changes: Array<{ day_number: number | null; exercise: string | null; from: string; to: string }>;
  };
}

// Scheduler orphan repair may converge OLDER alternatives, but only when they
// carry the same explicit provenance + semantic intent, were already outside the
// adoption grace window, and have never acquired autonomy/review ownership. The
// historical background-chat path is additionally bounded by one short retry burst.
// Ordinary apply/manual paths never call this helper.
function supersedeMatchingOrphanDrafts(
  appliedId: number,
  cleanup: OrphanSiblingCleanup,
  opts: { deferTrainingVersionBump?: boolean } = {}
) {
  const cutoff = Date.parse(String(cleanup.eligible_before));
  const burstAfter = cleanup.burst_after ? Date.parse(String(cleanup.burst_after)) : Number.NaN;
  const burstBefore = cleanup.burst_before ? Date.parse(String(cleanup.burst_before)) : Number.NaN;
  if (!cleanup.intent_key || !Number.isFinite(cutoff)) return;
  const drafts = db
    .prepare(
      `SELECT id, agent, instruction, parsed_json, created_at
         FROM plan_proposals
        WHERE status = 'draft' AND id != ?`
    )
    .all(appliedId) as any[];
  for (const d of drafts) {
    if (cleanup.provenance !== "background_chat" && Number(d.id) > appliedId) continue;
    const createdAt = parseDbTime(d.created_at)?.getTime() ?? Number.NaN;
    if (!Number.isFinite(createdAt) || createdAt > cutoff) continue;
    if (
      cleanup.provenance === "background_chat" &&
      (!Number.isFinite(burstAfter) ||
        !Number.isFinite(burstBefore) ||
        createdAt < burstAfter ||
        createdAt > burstBefore)
    )
      continue;
    const siblingIntent =
      cleanup.provenance === "chat" || cleanup.provenance === "background_chat"
        ? chatOrphanIntent(d)
        : automaticOrphanIntent(d);
    if (siblingIntent?.key !== cleanup.intent_key) continue;
    if (
      cleanup.provenance === "background_chat" &&
      (!siblingIntent || !("provenance" in siblingIntent) || siblingIntent.provenance !== "background_chat")
    )
      continue;
    const owned = db
      .prepare(`SELECT 1 FROM brain_decisions WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ? LIMIT 1`)
      .get(String(d.id));
    if (owned) continue;
    // Through setProposalStatus so any standing announced/pending decision on the
    // retired draft is canceled too (the boundary pass must never apply it).
    setProposalStatus(Number(d.id), "superseded", opts);
  }
}

// The scheduler's weekly plan-evolution draft is tagged with this instruction so the
// continuous cadence never PILES UP unreviewed drafts: a fresh weekly draft retires the
// prior auto-evolution one (system 'superseded', not a user 'discarded'). Manual
// "Evolve my plan" drafts use a different instruction and are never touched here.
export const AUTO_EVOLUTION_INSTRUCTION = "weekly auto-evolution";
export function supersedeAutoEvolutionDrafts(exceptId?: number) {
  const drafts = db
    .prepare(`SELECT id FROM plan_proposals WHERE status = 'draft' AND instruction = ?`)
    .all(AUTO_EVOLUTION_INSTRUCTION) as any[];
  let retired = 0;
  for (const d of drafts) {
    if (exceptId != null && Number(d.id) === Number(exceptId)) continue;
    // Through setProposalStatus so a standing announced/pending decision is canceled too.
    setProposalStatus(Number(d.id), "superseded");
    retired++;
  }
  return retired;
}

export function proposalSummary(p: any): string | null {
  const s = String(p?.parsed?.summary ?? "").trim();
  return s ? s.slice(0, 300) : null;
}

// Applying a recovery-week draft stamps its exact owner so Undo can restore only
// the recovery week this decision owns. Autonomous applies use the strict path so
// the stamp commits with the plan; manual applies keep legacy fail-soft telemetry.
function stampRecoveryWeekIfApplies(p: any, strict = false): void {
  if (strict) {
    if (String(p?.instruction ?? "").startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX)) {
      stampRecoveryWeekAppliedStrict(Number(p.id), localDateISO());
    }
    return;
  }
  try {
    if (String(p?.instruction ?? "").startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX)) {
      stampRecoveryWeekApplied(Number(p.id), localDateISO());
    }
  } catch {
    /* never blocks the apply */
  }
}


// Why a run-only proposal lands nothing. Athlete-facing (the apply receipt renders it).
export const RUNS_ARE_NOT_PLAN_ITEMS =
  "Runs aren't part of the lifting plan any more — they follow your stated run days, and each week's runs update on their own.";

// A fresh weekly run-plan draft retires any prior un-applied one (agent
// 'auto-run-plan'), so re-running the run-plan apply never stacks duplicates in the
// Coach list — system 'superseded', not a user 'discarded'. Returns how many retired.
export function supersedeAutoRunPlanDrafts() {
  const drafts = db
    .prepare(`SELECT id FROM plan_proposals WHERE status = 'draft' AND agent = 'auto-run-plan'`)
    .all() as any[];
  let retired = 0;
  for (const d of drafts) {
    // Through setProposalStatus so a standing announced/pending decision is canceled too.
    setProposalStatus(Number(d.id), "superseded");
    retired++;
  }
  return retired;
}

// A fresh auto-progression draft for a day RETIRES any prior un-applied one for the
// SAME day, so tapping "apply to my plan" on Today repeatedly never piles up duplicate
// drafts in the Coach list (each new draft reflects the latest logged sets; the stale
// one is system-retired as 'superseded', not a user 'discarded'). Other days' drafts —
// and any other agent's drafts — are untouched. Returns how many were retired.
export function supersedeAutoProgressionDrafts(dayNumber: number) {
  const drafts = db
    .prepare(`SELECT id, parsed_json FROM plan_proposals WHERE status = 'draft' AND agent = 'auto-progression'`)
    .all() as any[];
  let retired = 0;
  for (const d of drafts) {
    let dn = Number.NaN;
    try {
      const parsed = d.parsed_json ? JSON.parse(d.parsed_json) : null;
      const first = parsed && Array.isArray(parsed.changes) ? parsed.changes[0] : null;
      dn = first ? Number(first.day_number) : Number.NaN;
    } catch {
      /* keep NaN — an unparseable draft is left alone */
    }
    if (dn === Number(dayNumber)) {
      // Through setProposalStatus so a standing announced/pending decision is canceled too.
      setProposalStatus(Number(d.id), "superseded");
      retired++;
    }
  }
  return retired;
}

// Clamp an advisory nutrition target to the lean-safe kcal/protein floors before
// it's acknowledged. The nutrition check-in already proposes only conservative
// ±100-250 kcal nudges, but this is the code-enforced backstop: a deficit target
// can never land below the lean-safe recommended intake (or ~1500 kcal absolute,
// whichever is higher), and protein is never dropped below the recommended floor.
// Returns the (possibly-adjusted) nutrition object plus transparent clamp records.
function clampNutritionTarget(
  nutrition: any,
  opts: { preserveReviewedKcal?: boolean } = {}
): { nutrition: any; clamped: ClampAdjustment[] } {
  const clamped: ClampAdjustment[] = [];
  if (!nutrition || typeof nutrition !== "object") return { nutrition, clamped };
  const out = { ...nutrition };
  let goal: any = null;
  try {
    goal = computeGoalCheck();
  } catch {
    /* profile incomplete → only the absolute floors apply */
  }
  const recIntake = goal?.ok ? Number(goal.recommended?.target_intake_kcal) : NaN;
  const recProtein = goal?.ok ? Number(goal.recommended?.protein_g) : NaN;
  // Mode-aware wording: the same floor protects against a crash deficit (lose),
  // an accidental shortfall below maintenance, or eating below the lean-gain anchor.
  const goalMode: string | null = goal?.ok ? goal.goal_mode : null;
  const floorLabel = opts.preserveReviewedKcal
    ? "absolute safety floor"
    : goalMode === "gain"
      ? "lean-gain anchor"
      : goalMode === "maintain"
        ? "maintenance anchor"
        : "lean-safe floor";
  // kcal floor: the mode's recommended intake, never below the absolute floor.
  const kcalFloor = opts.preserveReviewedKcal
    ? KCAL_ABSOLUTE_FLOOR
    : Math.max(KCAL_ABSOLUTE_FLOOR, Number.isFinite(recIntake) ? recIntake : 0);
  const reqKcal = Number(out.target_kcal);
  if (Number.isFinite(reqKcal) && reqKcal < kcalFloor) {
    clamped.push({
      exercise: "nutrition target",
      field: "target_kcal",
      requested: Math.round(reqKcal),
      applied: Math.round(kcalFloor),
      reason: `kcal raised to your ${floorLabel} (≥${Math.round(kcalFloor)} kcal)${goalMode === "lose" || goalMode == null ? " — never a crash deficit" : ""}`,
    });
    out.target_kcal = Math.round(kcalFloor);
  }
  // protein floor: hold/raise, never below the recommended protein target.
  const reqProtein = Number(out.protein_g);
  if (Number.isFinite(recProtein) && recProtein > 0 && Number.isFinite(reqProtein) && reqProtein < recProtein) {
    clamped.push({
      exercise: "nutrition target",
      field: "protein_g",
      requested: Math.round(reqProtein),
      applied: Math.round(recProtein),
      reason: `protein held at the recommended floor (≥${Math.round(recProtein)} g) — protein stays protected`,
    });
    out.protein_g = Math.round(recProtein);
  }
  return { nutrition: out, clamped };
}

function reviewedNutritionTargetIncompatibility(nutrition: any): string | null {
  const reviewed = Number(nutrition?.target_kcal);
  if (!Number.isFinite(reviewed))
    return "Nutrition target needs review: the proposed calorie target is missing or invalid.";
  let goal: any = null;
  try {
    goal = computeGoalCheck();
  } catch {
    goal = null;
  }
  const mode = goal?.ok ? String(goal.goal_mode || "") : "";
  const modeFloor = Number(goal?.recommended?.target_intake_kcal);
  const floor =
    mode === "maintain" || mode === "gain"
      ? Math.max(KCAL_ABSOLUTE_FLOOR, Number.isFinite(modeFloor) ? Math.round(modeFloor) : 0)
      : KCAL_ABSOLUTE_FLOOR;
  if (reviewed >= floor) return null;
  if (mode === "maintain" || mode === "gain") {
    return `Nutrition target needs review: ${Math.round(reviewed)} kcal is below the current ${mode === "gain" ? "lean-gain" : "maintenance"} requirement of ${Math.round(floor)} kcal. The goal mode changed or the proposal is stale, so Cairn did not apply or alter it.`;
  }
  return `Nutrition target needs review: ${Math.round(reviewed)} kcal is below the universal ${KCAL_ABSOLUTE_FLOOR} kcal safety floor, so Cairn did not apply or alter it.`;
}

function datePlusDays(date: string, days: number): string {
  return localDateISO(new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5));
}

function proposalDecisionShape(p: any): {
  kind: "nutrition_target" | "training_structure" | "training_target" | "exercise_rotation";
  domain: "nutrition" | "training" | "recovery";
  summary: string;
  rationale: string | null;
} {
  const nutrition = p?.parsed?.kind === "nutrition_target";
  const restructure = Array.isArray(p?.parsed?.days);
  // The canonical recovery-week draft is stamped domain 'recovery' (same structural
  // marker autonomy-service's proposalShape uses) so the ledger reads consistently
  // whichever path applied it.
  const recoveryWeek = restructure && String(p?.instruction ?? "").startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX);
  const rotation =
    p?.agent === "exercise-swap" ||
    (Array.isArray(p?.parsed?.changes) && p.parsed.changes.some((item: any) => item?.swap));
  const changeReasons = Array.isArray(p?.parsed?.changes)
    ? p.parsed.changes
        .map((item: any) => item?.reason)
        .filter(Boolean)
        .slice(0, 4)
        .join("; ")
    : null;
  const reason = nutrition
    ? (p?.parsed?.nutrition?.reason ?? p?.instruction ?? null)
    : (p?.parsed?.rationale ?? (changeReasons || p?.instruction || null));
  return {
    kind: nutrition
      ? "nutrition_target"
      : restructure
        ? "training_structure"
        : rotation
          ? "exercise_rotation"
          : "training_target",
    domain: nutrition ? "nutrition" : recoveryWeek ? "recovery" : "training",
    summary: String(
      p?.parsed?.summary ??
        (nutrition
          ? "Nutrition target proposal."
          : restructure
            ? "Training structure proposal."
            : "Training target proposal.")
    ),
    rationale: reason || null,
  };
}

function recordProposalStatusDecision(p: any, proposalStatus: string): void {
  if (!p?.id || !["discarded", "rejected", "superseded"].includes(proposalStatus)) return;
  try {
    const shape = proposalDecisionShape(p);
    recordDecision({
      effective_date: localDateISO(),
      kind: shape.kind,
      domain: shape.domain,
      summary: shape.summary,
      rationale: shape.rationale,
      source: p.agent || "plan_proposal",
      source_ref_type: "plan_proposal",
      source_ref_key: String(p.id),
      status: proposalStatus === "superseded" ? "superseded" : "rejected",
      autonomy_tier: "ask",
      risk_class: shape.kind === "training_structure" ? "moderate" : "low",
      reversible: false,
      input_fingerprint: null,
      context: { instruction: p.instruction || null },
      action: { proposal_status: proposalStatus },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
  } catch {
    // Proposal status is authoritative; audit recording is best effort.
  }
}

// Manual apply telemetry remains fail-soft. Autonomy-owned apply passes `required`
// because its decision + expectations are part of the authoritative mutation and
// must commit in the same savepoint as the proposal and rollback snapshot.
function recordAppliedProposalDecision(
  p: any,
  result: any,
  existingDecisionId?: number,
  required = false,
  prescriptionsBefore?: Map<string, PlanPrescription>,
  // `boundaryTrimmed`: the apply-time re-clamp lowered the reviewed kcal, so the
  // draft's own summary and its `delta_kcal` both describe a move that did not
  // happen. Everything derived from them is re-derived from what actually landed.
  applyContext: { boundaryTrimmed?: boolean } = {}
): void {
  try {
    const today = localDateISO();
    const nutrition = p.parsed?.kind === "nutrition_target";
    const recoveryCycle = result?.recovery_cycle ?? null;
    const restructure = Array.isArray(p.parsed?.days) && !recoveryCycle;
    const affected = [
      ...(Array.isArray(result?.applied) ? result.applied : []),
      ...(Array.isArray(result?.added) ? result.added : []),
    ];
    const exercises: string[] = [
      ...new Set<string>(affected.map((item: any) => String(item?.exercise || "").trim()).filter(Boolean)),
    ];
    const expectations: ProposedExpectation[] = exercises.slice(0, 12).map((exercise) => ({
      metric_key: "exercise_target_completion",
      subject_key: exercise,
      direction: "complete",
      baseline: null,
      target: { exposures: 2 },
      window_start: today,
      window_end: datePlusDays(today, 28),
      minimum_data: { exposures: 2 },
      confounder_policy: "require_exposure",
      confidence: "tentative",
      evaluator: "exercise_completion",
      evaluator_version: "exercise-completion-v1",
    }));
    if (restructure) {
      const plannedDays = Math.max(1, Math.min(14, p.parsed.days.length));
      expectations.push({
        metric_key: "plan_day_adherence",
        subject_key: null,
        direction: "complete",
        baseline: null,
        target: { rate: 0.75, planned_sessions: plannedDays * 4 },
        window_start: today,
        window_end: datePlusDays(today, 28),
        minimum_data: { sessions: Math.min(2, plannedDays) },
        confounder_policy: "exclude_context_events",
        confidence: "tentative",
        evaluator: "plan_adherence",
        evaluator_version: "plan-adherence-v1",
      });
    }
    const accepted = result?.accepted ?? null;
    let nutritionBaseline: ReturnType<typeof estimateExpenditure> | null = null;
    let nutritionExpectationBasis: string | null = null;
    const nutritionEffectiveDate = accepted?.effective_date || today;
    const nutritionStage =
      nutrition && accepted?.target_kcal != null ? recompositionStageAt(nutritionEffectiveDate).kind : null;
    const nutritionTargetDelta = Number(p.parsed?.nutrition?.delta_kcal);
    const nutritionPrevTarget = Number(p.parsed?.nutrition?.prev_target_kcal);
    // The delta the expectation baseline is built on, and the one every evaluator
    // later measures the outcome against (brain/evaluators.ts, predictionFields).
    // A boundary re-clamp makes the draft's own `delta_kcal` a claim about a step
    // that was never taken, so a trimmed apply always recomputes it from the number
    // that actually landed — otherwise the ledger predicts the weight response of a
    // +200 kcal move and then judges the athlete against a +50 one.
    const storedTargetDelta =
      Number.isFinite(nutritionTargetDelta) && !applyContext.boundaryTrimmed
        ? Math.round(nutritionTargetDelta)
        : Number.isFinite(nutritionPrevTarget)
          ? Math.round(Number(accepted?.target_kcal) - nutritionPrevTarget)
          : null;
    // WHICH nutrition lever this decision is accountable to — the same rule the direct
    // target writer applies (repo/nutrition.ts recordNutritionTargetDecision), because
    // this is the same EVENT arriving through the proposal-apply path. Left hardcoded
    // to `intake_to_weight_response` here, one athlete's target changes would split
    // across two comparableKeys depending on which door the change came through, and
    // neither half would reach the two-outcome floor on its own.
    //
    //   a delta ≠ 0  → weight_trend_lb_wk: we MOVED the target, so the trend should
    //                  move with it, and the scale alone can falsify that;
    //   no delta     → intake_to_weight_response: nothing moved, so the honest question
    //                  is how this athlete's weight responds to the intake they log.
    const nutritionMetricKey =
      storedTargetDelta != null && storedTargetDelta !== 0 ? "weight_trend_lb_wk" : "intake_to_weight_response";
    const nutritionIsTrendLever = nutritionMetricKey === "weight_trend_lb_wk";
    // A trend claim needs weigh-ins only; a response claim also needs the intake days
    // that show what was actually eaten against the target.
    const nutritionMinimumData: Record<string, number> = nutritionIsTrendLever
      ? { weigh_ins: 6 }
      : { weigh_ins: 6, intake_days: 10 };
    const nutritionEvaluator = nutritionIsTrendLever ? "weight_trend" : "intake_response";
    const nutritionEvaluatorVersion = nutritionIsTrendLever ? "nutrition-weight-v2" : "nutrition-intake-response-v2";
    if (nutrition && accepted?.target_kcal != null) {
      try {
        const estimate = estimateExpenditure(21);
        if (
          (estimate.confidence === "medium" || estimate.confidence === "high") &&
          estimate.tdee != null &&
          estimate.trend_lb_wk != null
        ) {
          nutritionBaseline = estimate;
          nutritionExpectationBasis = "measured_expenditure";
          const expectedTrend = ((Number(accepted.target_kcal) - estimate.tdee) * 7) / KCAL_PER_LB;
          expectations.push({
            metric_key: nutritionMetricKey,
            subject_key: null,
            direction: "within_band",
            baseline: {
              trend_lb_wk: estimate.trend_lb_wk,
              tdee: estimate.tdee,
              intake_avg_kcal: estimate.intake_avg_kcal,
              confidence: estimate.confidence,
              target_kcal: Number(accepted.target_kcal),
              target_delta_kcal: storedTargetDelta,
              predicted_trend_lb_wk: Math.round(expectedTrend * 100) / 100,
              recomposition_stage: nutritionStage,
            },
            target: {
              min: Math.round((expectedTrend - 0.35) * 100) / 100,
              max: Math.round((expectedTrend + 0.35) * 100) / 100,
            },
            window_start: nutritionEffectiveDate,
            window_end: datePlusDays(nutritionEffectiveDate, 28),
            minimum_data: nutritionMinimumData,
            confounder_policy: "exclude_context_events",
            confidence: "tentative",
            evaluator: nutritionEvaluator,
            evaluator_version: nutritionEvaluatorVersion,
          });
        }
      } catch {
        nutritionBaseline = null;
      }
    }
    if (nutrition && accepted?.target_kcal != null && !expectations.length) {
      let expectedTrend = 0;
      let tolerance = 0.75;
      nutritionExpectationBasis = "cold_start_broad_band";
      try {
        const goal = computeGoalCheck();
        if (goal?.ok) {
          const rate = Number(goal.recommended?.weekly_rate_lb) || 0;
          expectedTrend = goal.goal_mode === "lose" ? -rate : goal.goal_mode === "gain" ? rate : 0;
          tolerance = 0.5;
          nutritionExpectationBasis = "goal_formula";
        }
      } catch {
        // Thin data remains a broad, tentative prediction. The minimum-data
        // requirement will yield inconclusive rather than a fabricated verdict.
      }
      expectations.push({
        metric_key: nutritionMetricKey,
        subject_key: null,
        direction: "within_band",
        baseline: {
          target_kcal: Number(accepted.target_kcal),
          target_delta_kcal: storedTargetDelta,
          predicted_trend_lb_wk: Math.round(expectedTrend * 100) / 100,
          recomposition_stage: nutritionStage,
          basis: nutritionExpectationBasis,
        },
        target: {
          min: Math.round((expectedTrend - tolerance) * 100) / 100,
          max: Math.round((expectedTrend + tolerance) * 100) / 100,
        },
        window_start: nutritionEffectiveDate,
        window_end: datePlusDays(nutritionEffectiveDate, 28),
        minimum_data: nutritionMinimumData,
        confounder_policy: "exclude_context_events",
        confidence: "tentative",
        evaluator: nutritionEvaluator,
        evaluator_version: nutritionEvaluatorVersion,
      });
    }
    if (!nutrition && !expectations.length) {
      const plannedDays = Math.max(
        1,
        new Set((Array.isArray(result?.runs) ? result.runs : []).map((item: any) => Number(item?.day_number))).size
      );
      expectations.push({
        metric_key: "plan_day_adherence",
        subject_key: null,
        direction: "complete",
        baseline: null,
        target: { rate: 0.75, planned_sessions: plannedDays * 4 },
        window_start: today,
        window_end: datePlusDays(today, 28),
        minimum_data: { sessions: Math.min(2, plannedDays) },
        confounder_policy: "exclude_context_events",
        confidence: "tentative",
        evaluator: "plan_adherence",
        evaluator_version: "plan-adherence-v1",
      });
    }
    // "Did this change actually help the athlete?" — the checks the whole ledger
    // exists for. A training change predicts that how sessions FEEL does not
    // slide and that joint pain does not become more frequent than it already
    // was; a load step on a named lift predicts that the lift's own est-1RM
    // holds. Each is written only when the athlete is ALREADY logging the
    // evidence that could falsify it (src/repo/brain/change-expectations.ts), so
    // a quiet logger collects no predictions rather than a drawer of permanently
    // inconclusive ones. Placed AFTER the adherence fallback above so it keeps
    // owning the "nothing else to say" case exactly as before.
    if (!nutrition) {
      try {
        expectations.push(...buildTrainingFeedbackExpectations(today));
        expectations.push(...buildLiftProgressionExpectations(liftProgressionSubjects(exercises, today), today));
      } catch {
        // Learning telemetry is never allowed to sink an authoritative apply.
      }
    }
    // A conference recommendation that was HELD parked its predictions on the
    // held decision rather than asserting them about a change that had not
    // happened. It has happened now, so they thaw onto THIS decision with their
    // windows re-based to today.
    //
    // Deliberately status-agnostic. This apply has ALREADY retired the park
    // record (every terminal proposal transition supersedes its outstanding
    // review holds), so filtering on 'review' would look right and find nothing.
    // The proposal id plus a parked payload is the identity that matters.
    try {
      const parkRows = db
        .prepare(
          `SELECT id, action_json FROM brain_decisions
            WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ?
              AND json_extract(action_json, '$.deferred_expectations') IS NOT NULL
            ORDER BY id LIMIT 10`
        )
        .all(String(p.id)) as Array<{ id: number; action_json: string | null }>;
      // Cold storage is consumed EXACTLY ONCE. Two things enforce that, because either
      // alone leaves a hole: the payload is cleared off each park row as it is thawed
      // (so a proposal that was held, released, held again and re-applied cannot thaw
      // the same predictions a second time), and the thawed set is deduped by
      // metric+subject (so two park rows for one proposal produce one prediction per
      // thing predicted, not two windows racing to judge the same change).
      const seen = new Set<string>();
      for (const row of parkRows) {
        const parked = JSON.parse(String(row.action_json ?? "{}"))?.deferred_expectations;
        for (const thawed of rebaseDeferredExpectations(parked, today)) {
          const key = `${thawed.metric_key}::${thawed.subject_key ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          expectations.push(thawed);
        }
        try {
          db.prepare(
            `UPDATE brain_decisions SET action_json = json_remove(action_json, '$.deferred_expectations') WHERE id = ?`
          ).run(row.id);
        } catch {
          // Clearing the payload is bookkeeping; the dedupe above already stops a
          // double-thaw within this apply, and a failed clear must not sink it.
        }
      }
    } catch {
      // Same rule: a malformed parked payload must never block the apply.
    }
    const sourceRefType = nutrition && accepted?.id ? "nutrition_target" : "plan_proposal";
    const sourceRefKey = String(nutrition && accepted?.id ? accepted.id : p.id);
    const shape = proposalDecisionShape(p);
    // The draft wrote BOTH its summary and its reason about the kcal it asked for
    // ("Raising you to 2,338 kcal to protect training"). When the boundary trimmed that
    // number, every PROSE field of the applied row has to describe what landed instead:
    // a row whose headline says 2,150 and whose reason underneath still says 2,338 is
    // worse than either alone, because it reads as two different changes. So the two
    // are replaced together, in their own registers — the summary in the athlete's
    // voice, the rationale in the machine one. The draft's original wording is not
    // lost: it stays on the `plan_proposals` row, which is where the un-applied
    // suggestion belongs. `context.boundary_revalidation` keeps the asked-for kcal as a
    // STRUCTURED provenance field, which is an audit trail rather than a claim.
    const trimmedTargetKcal =
      nutrition && applyContext.boundaryTrimmed && Number.isFinite(Number(accepted?.target_kcal))
        ? Number(accepted.target_kcal)
        : null;
    const summary =
      trimmedTargetKcal == null ? shape.summary : revalidatedTargetSummary(trimmedTargetKcal, nutritionEffectiveDate);
    const rationale = trimmedTargetKcal == null ? shape.rationale : revalidatedTargetNote(trimmedTargetKcal);
    // Close the lab loop: when this plan/nutrition change is applied while a marker-sourced
    // directive is active in its domain, anchor a falsifiable "<marker> should move toward
    // optimal at the next reading" expectation to THIS intervention (the primary driver; the
    // rest ride along in meta). Zero-evidence -> inconclusive keeps it honest until a new lab
    // lands. Nothing to anchor -> null, and the apply behaves exactly as before.
    let markerAnchorMeta: MarkerInterventionRecording["meta"] | null = null;
    if (shape.domain === "nutrition" || shape.domain === "training") {
      try {
        const recording = markerInterventionRecording(
          shape.domain,
          nutrition ? nutritionEffectiveDate : today,
          shape.kind
        );
        if (recording) {
          markerAnchorMeta = recording.meta;
          // A same-draw repeat rides in meta only (expectation null) — no duplicate anchor.
          if (recording.expectation) expectations.push(recording.expectation);
        }
      } catch {
        // Marker anchoring is best-effort telemetry; a direct apply is authoritative.
      }
    }
    const evidenceKeys: string[] = [
      `plan_proposal:${p.id}`,
      ...(nutrition
        ? [`nutrition_target:${accepted?.id ?? p.id}`, `expenditure:${nutritionExpectationBasis ?? "thin"}`]
        : exercises.map((exercise) => `exercise:${exercise}:plan-and-history`).slice(0, 12)),
    ];
    const proposalEvidence = proposalEvidenceSnapshot(p.parsed);
    // The prescription this change overwrote, for the entries below. Absent for a
    // legacy/manual caller that had no snapshot to hand — the entry then records its
    // after-value alone, exactly as it always did.
    const beforeFor = (dayNumber: unknown, exercise: unknown): AccountablePlanChangeRecord["before"] => {
      const key = prescriptionsBefore ? planPrescriptionKey(dayNumber, exercise) : null;
      const prior = key ? prescriptionsBefore!.get(key) : undefined;
      return prior
        ? {
            sets: prior.sets,
            rep_low: prior.rep_low,
            rep_high: prior.rep_high,
            target_weight: prior.target_weight,
            target_seconds: prior.target_seconds,
          }
        : null;
    };
    const baseAction = nutrition
      ? {
          target_kcal: result?.nutrition?.target_kcal ?? null,
          protein_g: result?.nutrition?.protein_g ?? null,
          carbs_g: result?.nutrition?.carbs_g ?? null,
          fat_g: result?.nutrition?.fat_g ?? null,
          plan_proposal_id: p.id,
        }
      : recoveryCycle
        ? {
            plan_proposal_id: p.id,
            recovery_cycle_id: recoveryCycle.id,
            effective_status: recoveryCycle.effective_status,
            effective_on: recoveryCycle.effective_on,
            recheck_on: recoveryCycle.recheck_on,
            exit_on: recoveryCycle.exit_on,
            overlay: recoveryCycle.overlay,
            base_plan_mutated: false,
          }
      : restructure
        ? {
            plan_proposal_id: p.id,
            day_count: Number(result?.days) || p.parsed.days.length,
            // The same per-movement shape a targeted apply writes, derived from the
            // before/after diff of the rewrite. Without it a restructure that halves
            // your sets reaches the plan surface with no provenance at all.
            changes: (Array.isArray(result?.item_changes) ? result.item_changes : []) as AccountablePlanChangeRecord[],
            days: p.parsed.days.slice(0, 14).map((day: any) => ({
              day_number: day?.day_number ?? null,
              name: day?.name ?? null,
              focus: day?.focus ?? null,
              reasons: (Array.isArray(day?.items) ? day.items : [])
                .filter((item: any) => item?.reason)
                .slice(0, 12)
                .map((item: any) => ({
                  exercise: item?.exercise ?? item?.label ?? null,
                  reason: item.reason,
                  reason_provenance: item?.reason_provenance ?? null,
                })),
            })),
          }
        : {
            plan_proposal_id: p.id,
            changes: affected.slice(0, 24).map((item: any) => ({
              day_number: item?.day_number ?? null,
              exercise: item?.exercise ?? null,
              target_weight: item?.target_weight ?? null,
              sets: item?.sets ?? null,
              prior_sets: item?.prior_sets ?? null,
              rep_low: item?.rep_low ?? null,
              rep_high: item?.rep_high ?? null,
              target_seconds: item?.target_seconds ?? null,
              before: beforeFor(item?.day_number, item?.exercise),
              change: item?.action === "added" ? "added" : "updated",
              reason: item?.reason ?? null,
              reason_provenance: item?.reason_provenance ?? null,
            })),
            // Rotations keep their from/to shape (changes[] flattens it away) so the
            // ledger can answer "was lift X recently rotated out" without string-parsing.
            swaps: (Array.isArray(p.parsed?.changes) ? p.parsed.changes : [])
              .filter((item: any) => item?.swap?.from && item?.swap?.to)
              .slice(0, 12)
              .map((item: any) => ({
                day_number: item?.day_number ?? null,
                from: String(item.swap.from),
                to: String(item.swap.to),
              })),
            proposal_evidence: proposalEvidence,
          };
    // Volume is the one prescription field nothing downstream can raise, so a
    // change that lowered `sets` has to leave behind the value it owes back. The
    // record lives here, on the decision that made the cut — the same row that
    // owns its Undo (src/repo/volume-guard.ts).
    const volumeRestore = nutrition || recoveryCycle || restructure ? [] : volumeRestoreLedger(affected, p.parsed);
    const action = {
      ...baseAction,
      ...(volumeRestore.length ? { volume_restore: volumeRestore } : {}),
      proposal_evidence: proposalEvidence,
      rationale_provenance: p.parsed?.rationale_provenance ?? null,
      ...(result?.legacy_migration ? { legacy_migration: result.legacy_migration } : {}),
    };
    const decisionInput = {
      effective_date:
        nutrition && accepted?.effective_date
          ? accepted.effective_date
          : recoveryCycle?.effective_on ?? today,
      kind: shape.kind,
      domain: shape.domain,
      summary,
      rationale,
      source: p.agent || "plan_proposal",
      source_ref_type: sourceRefType,
      source_ref_key: sourceRefKey,
      status: "applied",
      autonomy_tier: "ask",
      risk_class: restructure ? "moderate" : "low",
      // A direct/manual apply has no rollback snapshot. Autonomy-owned applies
      // patch this true only after their rollback has been durably stored.
      reversible: false,
      input_fingerprint: null,
      context: {
        instruction: p.instruction || null,
        evidence_keys: evidenceKeys,
        evidence_observed_at: new Date().toISOString(),
        proposal_as_of_date: p.parsed?.as_of_date ?? proposalEvidence?.as_of_date ?? null,
        proposal_evidence: proposalEvidence as any,
        proposal_freshness: (result?.proposal_freshness ?? null) as any,
        // A step-back carries the change it reverses in its own payload, so the
        // provenance survives EVERY apply path — including the one where the draft
        // waited for review and the athlete applied it days later, long after the
        // autonomy layer that would otherwise have stamped it had returned.
        ...(Number.isFinite(Number(p.parsed?.revises_decision_id))
          ? {
              revises_decision_id: Number(p.parsed.revises_decision_id),
              ...(Number.isFinite(Number(p.parsed?.revises_expectation_id))
                ? { revises_expectation_id: Number(p.parsed.revises_expectation_id) }
                : {}),
              revision_step_back: true,
            }
          : {}),
        ...(recoveryCycle
          ? {
              recovery_cycle: {
                id: recoveryCycle.id,
                effective_status: recoveryCycle.effective_status,
                effective_on: recoveryCycle.effective_on,
                recheck_on: recoveryCycle.recheck_on,
                exit_on: recoveryCycle.exit_on,
              },
              base_plan_mutated: false,
            }
          : {}),
        ...(result?.legacy_migration ? { legacy_migration: result.legacy_migration } : {}),
        ...(nutrition
          ? {
              expectation_basis: nutritionExpectationBasis,
              baseline_confidence: nutritionBaseline?.confidence ?? null,
              recomposition_stage: nutritionStage,
            }
          : {}),
        ...(markerAnchorMeta ? { marker_anchor: markerAnchorMeta } : {}),
      },
      action,
      specialist: null,
      applied_at: new Date().toISOString(),
      reverted_at: null,
      superseded_by: null,
      evaluator_version: expectations[0]?.evaluator_version ?? null,
    } as const;
    if (existingDecisionId) {
      const existing = getBrainDecision(existingDecisionId);
      if (!existing) throw new Error(`No brain decision ${existingDecisionId}`);
      const patched = patchBrainDecision(existingDecisionId, {
        effective_date: decisionInput.effective_date,
        kind: decisionInput.kind,
        domain: decisionInput.domain,
        summary: decisionInput.summary,
        rationale: decisionInput.rationale,
        source: decisionInput.source,
        source_ref_type: decisionInput.source_ref_type,
        source_ref_key: decisionInput.source_ref_key,
        status: "applied",
        risk_class: decisionInput.risk_class,
        context: { ...(existing.context ?? {}), ...(decisionInput.context ?? {}) },
        action: decisionInput.action as any,
        applied_at: decisionInput.applied_at,
        evaluator_version: decisionInput.evaluator_version,
      });
      if (!patched) throw new Error(`Brain decision ${existingDecisionId} could not be updated`);
      const stored = new Set(
        listBrainExpectations({ decisionId: existingDecisionId }).map(
          (item) => `${item.metric_key}|${item.subject_key}|${item.window_end}`
        )
      );
      for (const expectation of expectations) {
        const key = `${expectation.metric_key}|${expectation.subject_key}|${expectation.window_end}`;
        if (!stored.has(key)) insertBrainExpectation(existingDecisionId, expectation);
      }
    } else {
      recordDecision(decisionInput, expectations);
    }
  } catch (error) {
    if (required) throw error;
    // A direct/manual apply is authoritative even when optional learning telemetry
    // is unavailable. Autonomous apply never takes this branch.
  }
}

// An apply outside the announced decision's own boundary pass (a manual tap, chat,
// MCP) makes the standing announcement moot: cancel it so the boundary never
// re-applies the same proposal on top of the user's action.
function cancelAnnouncementsForProposal(proposalId: number, exceptDecisionId?: number, strict = false) {
  try {
    const standing = [
      ...listBrainDecisions({ status: "announced", limit: 100 }),
      ...listBrainDecisions({ status: "pending", limit: 100 }),
    ].filter(
      (decision) => decision.id !== exceptDecisionId && Number((decision.action as any)?.proposal_id) === proposalId
    );
    for (const decision of standing) transitionBrainDecision(decision.id!, "canceled");
  } catch (error) {
    if (strict) throw error;
    // Bookkeeping must never block the authoritative apply.
  }
}

// ---- when the boundary trimmed the raise -------------------------------------
//
// A nutrition target that waited for a natural food-day boundary is judged AGAIN on
// the day it lands (`revalidateNutritionTargetAtBoundary`, domain/brain/autonomy-
// service.ts) and may land lower than the draft asked for. The draft's own summary
// and reason were written about the number it asked for; left in place they make the
// ledger row and the stored target note describe a raise that did not happen — the
// athlete reads "a step to 2,800 kcal" on the row that actually wrote 2,350.
//
// So a trimmed apply gets its own sentence, naming the kcal that landed. Variant set
// rather than one literal (VISION.md Amendment 2), rotated on the day it took effect
// so a run of trimmed raises never prints one sentence for weeks.
const REVALIDATED_TARGET_SUMMARIES: readonly string[] = [
  "Fuel target moved to {kcal} kcal — the step was trimmed to what your own record puts maintenance at.",
  "Your target is {kcal} kcal now; the raise came back to the maintenance your record measures.",
  "The raise landed at {kcal} kcal, held to the maintenance your logged record actually shows.",
];

function revalidatedTargetSummary(kcal: number, date: string): string {
  return pickDayVariant(REVALIDATED_TARGET_SUMMARIES, date, "nutrition_target_revalidated").replace(
    "{kcal}",
    String(Math.round(kcal))
  );
}

// The same fact in the MACHINE register, for the nutrition_targets note — third-person
// provenance prose that the coach context and the next check-in read.
function revalidatedTargetNote(kcal: number): string {
  return `Applied at ${Math.round(kcal)} kcal: the reviewed raise was trimmed to the maintenance the athlete's own record measures, since protection carries a target to maintenance and no further.`;
}

export interface ProposalApplyOptions {
  orphanSiblingCleanup?: OrphanSiblingCleanup;
  decisionId?: number;
  normalizedApplyPayload?: NormalizedProposalApplyPayload;
  requireDecisionLedger?: boolean;
  freshnessCheckedAt?: string;
  // The boundary re-clamp (applyDueAnnouncedDecisions, domain/brain/autonomy-service.ts):
  // a nutrition target scheduled for a natural boundary is judged AGAIN against the
  // evidence in force on the day it lands, and this is the kcal that survived. Only ever
  // narrower than the reviewed number the draft carries — the caller has already refused
  // the change outright when the re-clamp would have taken it to a no-op.
  revalidatedTargetKcal?: number;
}

function applyProposalUnit(id: number, opts: ProposalApplyOptions = {}) {
  const p = getProposal(id);
  if (!p) throw new Error(`No proposal ${id}`);
  const parsed = opts.normalizedApplyPayload?.parsed ?? p.parsed;
  if (!parsed) throw new Error("Proposal has no parsed payload");
  // Manual/explicit apply remains authoritative, but it does not pretend an old
  // proposal had compare-and-set evidence. Autonomous callers gate on this same
  // read before reaching apply; direct callers receive the honest status in the
  // receipt and decision ledger.
  const proposalFreshness =
    parsed?.kind === "nutrition_target"
      ? null
      : verifyProposalEvidenceFreshness(parsed, opts.freshnessCheckedAt ?? localDateISO());
  if (p.status === "applied") {
    // Re-running an applied proposal would duplicate its side effects (a second
    // nutrition_targets row, a re-run replacePlan over newer edits).
    return { ok: false, id, error: "proposal already applied" };
  }
  // Adaptive nutrition-target drafts (from the nutrition check-in) are advisory —
  // there is no plan to mutate. Recognize the shape so "applying" one is a clean
  // acknowledgement on every surface (REST + MCP) instead of throwing
  // "no valid changes or days". The PWA surfaces these via the Energy Balance
  // check-in card, not the plan-proposals apply button. Even advisory, the target
  // keeps its already-reviewed kcal (with the absolute kcal floor) while the
  // current protein safety floor and any adjustment remain transparent.
  if (parsed.kind === "nutrition_target") {
    // A boundary re-clamp replaces the reviewed kcal BEFORE every floor and safety
    // read below, so the number that reaches the safety layer is the one this apply
    // actually intends to write — never the draft's original alongside it.
    const revalidatedKcal = Number(opts.revalidatedTargetKcal);
    const boundaryTrimmed = Number.isFinite(revalidatedKcal);
    const reviewedNutrition = boundaryTrimmed
      ? { ...parsed.nutrition, target_kcal: Math.round(revalidatedKcal) }
      : parsed.nutrition;
    const incompatibility = reviewedNutritionTargetIncompatibility(reviewedNutrition);
    if (incompatibility) throw new Error(incompatibility);
    const { nutrition, clamped } = clampNutritionTarget(reviewedNutrition, { preserveReviewedKcal: true });
    // Close the loop: PERSIST the accepted (clamped, lean-safe) target so the fuel
    // card, goal math and next check-in read THIS number instead of re-deriving the
    // formula. Effective from today. Persistence is the authoritative mutation: if
    // it fails, the proposal stays a reviewable draft and no applied decision is recorded.
    let accepted: any = null;
    try {
      accepted = setNutritionTarget(
        {
          target_kcal: nutrition.target_kcal,
          protein_g: nutrition.protein_g,
          carbs_g: nutrition.carbs_g,
          fat_g: nutrition.fat_g,
          source: "checkin",
          // The draft's reason was written about the number it asked for. When the
          // boundary trimmed that number, quoting it here would leave the stored
          // target explaining a raise nobody applied.
          note: boundaryTrimmed ? revalidatedTargetNote(nutrition.target_kcal) : (nutrition.reason ?? null),
        },
        { recordDecision: false, preserveReviewedKcal: true }
      );
    } catch (error) {
      const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
      throw new Error(`Nutrition target could not be saved; the proposal remains reviewable${detail}.`);
    }
    if (!accepted) throw new Error("Nutrition target could not be saved; the proposal remains reviewable.");
    cancelAnnouncementsForProposal(id, opts.decisionId, opts.requireDecisionLedger === true);
    setProposalStatus(id, "applied");
    const result = {
      ok: true,
      id,
      applied: [],
      nutrition,
      note: "advisory nutrition target — saved as your active target",
      ...(accepted ? { accepted } : {}),
      ...(clamped.length ? { clamped } : {}),
    };
    recordAppliedProposalDecision(p, result, opts.decisionId, opts.requireDecisionLedger === true, undefined, {
      boundaryTrimmed,
    });
    return result;
  }
  const recoveryProposal =
    (Array.isArray(parsed.days) || Array.isArray(parsed.changes)) &&
    String(p.instruction ?? "").startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX);
  if (recoveryProposal) {
    const quality = Array.isArray(parsed.days) ? validateTrainingPlan(parsed.days) : null;
    if (quality && !quality.ok)
      throw new Error(`Plan quality check failed: ${quality.errors.map((entry) => entry.message).join(" ")}`);
    const decision = opts.decisionId != null ? getBrainDecision(Number(opts.decisionId)) : null;
    const effectiveOn = String(
      decision?.effective_date ?? opts.freshnessCheckedAt ?? localDateISO()
    ).slice(0, 10);
    const cycle = scheduleRecoveryCycle({
      effective_on: effectiveOn,
      overlay: {
        source_proposal_id: Number(p.id),
        source_decision_id: decision?.id == null ? null : Number(decision.id),
      },
      reason: proposalSummary(p) ?? "An earned recovery week",
    });
    const appliedCycle =
      (opts.freshnessCheckedAt ?? localDateISO()) >= effectiveOn
        ? activateRecoveryCycle(Number(cycle.id), effectiveOn)
        : cycle;
    cancelAnnouncementsForProposal(id, opts.decisionId, opts.requireDecisionLedger === true);
    setProposalStatus(id, "applied");
    if (opts.orphanSiblingCleanup) supersedeMatchingOrphanDrafts(id, opts.orphanSiblingCleanup);
    const result = {
      ok: true,
      id,
      restructured: false,
      recovery_overlay: true,
      recovery_cycle: appliedCycle,
      days: Array.isArray(parsed.days) ? parsed.days.length : getPlan().length,
      quality,
      proposal_freshness: proposalFreshness,
      ...(opts.normalizedApplyPayload ? { legacy_migration: opts.normalizedApplyPayload.migration } : {}),
    };
    recordAppliedProposalDecision(p, result, opts.decisionId, opts.requireDecisionLedger === true);
    return result;
  }
  // Restructure proposal: full plan replacement (changed frequency / split).
  if (Array.isArray(parsed.days)) {
    // Agent-authored weeks land in effect order (compounds → accessories →
    // finishers → cardio). The editor's manual ↑↓ path does not go through here,
    // so athlete peer-order stays until the next compose or an explicit Order-for-effect.
    const orderedDays = orderPlanDaysForEffect(parsed.days as Parameters<typeof replacePlan>[0]);
    const quality = validateTrainingPlan(orderedDays, { volumeFloor: readVolumeFloorContext() });
    if (!quality.ok)
      throw new Error(`Plan quality check failed: ${quality.errors.map((entry) => entry.message).join(" ")}`);
    // A restructure rewrites every prescription at once. Snapshot first, diff after,
    // so the ledger can say what moved per movement instead of only "the plan changed".
    const prescriptionsBefore = planPrescriptionSnapshot();
    replacePlan(orderedDays);
    const itemChanges = planPrescriptionDiff(
      prescriptionsBefore,
      planPrescriptionSnapshot(),
      planRestructureReasons(orderedDays)
    );
    cancelAnnouncementsForProposal(id, opts.decisionId, opts.requireDecisionLedger === true);
    setProposalStatus(id, "applied");
    stampRecoveryWeekIfApplies(p, opts.requireDecisionLedger === true);
    if (opts.orphanSiblingCleanup) supersedeMatchingOrphanDrafts(id, opts.orphanSiblingCleanup);
    const result = {
      ok: true,
      id,
      restructured: true,
      item_changes: itemChanges,
      days: parsed.days.length,
      quality,
      proposal_freshness: proposalFreshness,
      ...(opts.normalizedApplyPayload ? { legacy_migration: opts.normalizedApplyPayload.migration } : {}),
    };
    recordAppliedProposalDecision(p, result, opts.decisionId, opts.requireDecisionLedger === true);
    return result;
  }
  // A proposal carries strength `changes`. (A full split/frequency rewrite uses `days`
  // → replacePlan above.) Runs are NOT plan items (migration 110): a legacy `cardio[]`
  // week or a kind:'cardio' change has nothing to write — the week's runs follow the
  // stated run days and the run engine, live — so it is set aside, never an error that
  // would roll back the strength half beside it.
  const hasChanges = Array.isArray(parsed.changes);
  const hasCardio = Array.isArray(parsed.cardio) && parsed.cardio.length;
  if (!hasChanges && !hasCardio) {
    throw new Error("Proposal has no valid changes, cardio, or days");
  }
  if (!hasChanges) {
    return { ok: false, id, applied: [], added: [], skipped: [], error: RUNS_ARE_NOT_PLAN_ITEMS };
  }
  const applied: any[] = []; // target tweaks to existing prescriptions
  const added: any[] = []; // movements ADDED to a day (the "add a back movement" intent)
  const skipped: any[] = [];
  const clamped: ClampAdjustment[] = [];
  const runsSetAside: any[] = [];
  let caughtQuality: PlanQualityReport | null = null;
  const savepoint = `apply_plan_proposal_${Math.trunc(Number(id))}`;
  // Read once, BEFORE any mutation: the pre-change prescription each targeted change
  // is about to overwrite. applyPlanChange reports only the value it wrote.
  const prescriptionsBefore = planPrescriptionSnapshot();
  const beforeQuality = validateTrainingPlan(getPlan());
  db.exec(`SAVEPOINT ${savepoint}`);
  for (const c of hasChanges ? parsed.changes : []) {
    try {
      // A run inside `changes` has no plan row to land on — set it aside (see above).
      if (String(c?.kind ?? "").toLowerCase() === "cardio") {
        runsSetAside.push(c);
        continue;
      }
      // clamp:true — this is the auto/reviewed APPLY path, so the deterministic
      // safety clamp applies to a target tweak (a manual edit stays unclamped).
      // applyPlanChange UPSERTS: it updates the matching prescription, or ADDS the
      // movement when it isn't on that day yet (an UPDATE that matched zero rows used
      // to be silently reported as "applied" — that lie is fixed here + below).
      const r = applyPlanChange(c, {
        clamp: true,
        defer_cache_bump: true,
        defer_day_read_invalidation: true,
        // The set-reduction step is bounded across the WHOLE revision. Without a
        // baseline, a payload repeating one day+exercise would take a fresh step
        // per entry and strip an item several sets inside one apply.
        revision_baseline: prescriptionsBefore,
      });
      if (Array.isArray(r.clamped)) clamped.push(...r.clamped);
      if (r.action === "added") added.push({ ...c, ...r });
      else applied.push({ ...c, ...r });
    } catch (e: any) {
      if (e instanceof PlanQualityError || (e?.name === "PlanQualityError" && e?.report)) {
        caughtQuality = e.report as PlanQualityReport;
      }
      skipped.push({ ...c, error: e.message });
    }
  }
  // A multi-change session correction is one intent. If removal, addition, or a
  // prescription edit fails, roll the whole unit back so Today never shows a
  // half-fixed session with the accidental extra still present.
  if (skipped.length) {
    db.exec(`ROLLBACK TO ${savepoint}`);
    db.exec(`RELEASE ${savepoint}`);
    return {
      ok: false,
      id,
      applied: [],
      added: [],
      skipped,
      ...(caughtQuality ? { quality: caughtQuality } : {}),
      error: caughtQuality
        ? "No changes were saved because the resulting plan failed its structural quality check."
        : "No changes were saved because one part of this plan update could not be applied.",
      ...(clamped.length ? { clamped } : {}),
    };
  }
  const touchedDays = new Set<number>(
    (hasChanges ? parsed.changes : [])
      .filter((change: any) => String(change?.kind ?? "").toLowerCase() !== "cardio")
      .map((change: any) => Number(change?.day_number))
      .filter(Number.isFinite)
  );
  const priorIssues = new Set(beforeQuality.errors.map(qualityIssueKey));
  const quality = validateTrainingPlan(getPlan(), { volumeFloor: readVolumeFloorContext() });
  const blockingQuality = quality.errors.filter(
    (entry) =>
      !priorIssues.has(qualityIssueKey(entry)) || (entry.day_number != null && touchedDays.has(entry.day_number))
  );
  if (blockingQuality.length) {
    db.exec(`ROLLBACK TO ${savepoint}`);
    db.exec(`RELEASE ${savepoint}`);
    return {
      ok: false,
      id,
      applied: [],
      added: [],
      skipped: blockingQuality.map((entry) => ({ error: entry.message, quality_code: entry.code })),
      quality,
      error: "No changes were saved because the resulting plan failed its structural quality check.",
    };
  }
  // Truthful apply: did anything CONCRETELY change? A target tweak that matched zero
  // rows (updated:0) is not a change — it used to flip the proposal to "applied" and
  // the UI claimed "✓ Applied" over a no-op. Only commit when something really
  // changed; otherwise leave the proposal a live draft and report ok:false so the
  // surface says so honestly instead of lying.
  const changedAny = applied.some((a) => Number(a.updated) > 0) || added.length > 0;
  if (!changedAny) {
    db.exec(`ROLLBACK TO ${savepoint}`);
    db.exec(`RELEASE ${savepoint}`);
    return {
      ok: false,
      id,
      applied,
      added,
      skipped,
      error: skipped.length
        ? "Couldn't apply these changes — the movement may need to be added through a plan restructure."
        : runsSetAside.length && !applied.length && !added.length
          ? RUNS_ARE_NOT_PLAN_ITEMS
          : "Nothing to change — your plan already matches this.",
      ...(clamped.length ? { clamped } : {}),
    };
  }
  db.exec(`RELEASE ${savepoint}`);
  cancelAnnouncementsForProposal(id, opts.decisionId, opts.requireDecisionLedger === true);
  setProposalStatus(id, "applied", { deferTrainingVersionBump: true });
  stampRecoveryWeekIfApplies(p, opts.requireDecisionLedger === true);
  if (opts.orphanSiblingCleanup) {
    supersedeMatchingOrphanDrafts(id, opts.orphanSiblingCleanup, { deferTrainingVersionBump: true });
  }
  // An applied target tweak / added movement / week of runs can change today's read —
  // bust the cached Brief so the next open reflects the change, not the stale plan.
  invalidateDayRead();
  const result = {
    ok: true,
    id,
    applied,
    added,
    skipped,
    ...(runsSetAside.length || hasCardio ? { runs_set_aside: runsSetAside.length + (hasCardio ? parsed.cardio.length : 0) } : {}),
    ...(clamped.length ? { clamped } : {}),
    quality,
    proposal_freshness: proposalFreshness,
    ...(opts.normalizedApplyPayload ? { legacy_migration: opts.normalizedApplyPayload.migration } : {}),
  };
  recordAppliedProposalDecision(p, result, opts.decisionId, opts.requireDecisionLedger === true, prescriptionsBefore);
  // Exactly one in-process invalidation for the committed plan + proposal-state
  // unit. Failed savepoints return above without touching the counter.
  afterSqliteCommit(bumpTrainingDataVersion);
  return result;
}

export function applyProposal(id: number, opts: ProposalApplyOptions = {}) {
  return withSqliteSavepoint(`apply_proposal_${Math.trunc(Number(id))}`, () => applyProposalUnit(id, opts));
}


