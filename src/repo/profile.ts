import { db } from "../db.js";
import { emitBrainEvent } from "../brainEvents.js";
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
import { findExercise } from "./exercises.js";
import { estimateExpenditure, type ExpenditureEstimate } from "./expenditure.js";
import { lsqSlopePerDay } from "./health.js";
import { invalidateDayRead } from "./intelligence.js";
import { getLatestNutritionTarget, setNutritionTarget } from "./nutrition.js";
import {
  type ClampAdjustment,
  type RunPrescription,
  applyPlanChange,
  getPlan,
  replacePlan,
  setWeeklyRuns,
} from "./plan.js";
import { PlanQualityError, type PlanQualityReport, qualityIssueKey, validateTrainingPlan } from "./plan-quality.js";
import { latestMeasuredRmr, measuredRmrAssessment } from "./metabolism.js";
import { getProgress, getRunCompliance } from "./sessions.js";
import { addDaysISO, LB_PER_KG, localDateISO, parseDbTime } from "./shared.js";
import { bumpTrainingDataVersion } from "./training-cache.js";
import { canonicalBodyweightSeries, resolvedCurrentBodyweight } from "./bodyweight.js";
import { automaticOrphanIntent, chatOrphanIntent } from "./proposal-intent.js";
import { classifyRecompositionStage } from "./recomposition-stage.js";
import {
  activeRecoveryWeekLedger,
  clearRecoveryWeekStampIfOwned,
  clearRecoveryWeekStampIfOwnedStrict,
  RECOVERY_WEEK_ACTIVE_DAYS,
  RECOVERY_WEEK_INSTRUCTION_PREFIX,
  stampRecoveryWeekApplied,
  stampRecoveryWeekAppliedStrict,
} from "./recovery-week-ledger.js";
import { afterSqliteCommit, withSqliteSavepoint } from "./sqlite-savepoint.js";

// Keep these public through profile/repo without duplicating the ledger's source
// of truth. The explicit local export is also legible to source-contract checks.
export { RECOVERY_WEEK_ACTIVE_DAYS, RECOVERY_WEEK_INSTRUCTION_PREFIX };

// ---------- exercise guide ----------
export function getExerciseDetail(name: string) {
  const ex = findExercise(name);
  if (!ex) return { found: false, name };
  const recent = db
    .prepare(
      `SELECT s.date AS date, ls.weight, ls.reps, ls.rir, ls.duration_sec FROM logged_sets ls
       JOIN sessions s ON s.id = ls.session_id
       WHERE ls.exercise_id = ? ORDER BY s.date DESC, ls.id DESC LIMIT 8`
    )
    .all(ex.id);
  const appears = db
    .prepare(
      `SELECT pd.day_number, pd.name AS day_name, pi.sets, pi.rep_low, pi.rep_high, pi.target_weight, pi.note, pi.warmup_sets, pi.target_seconds
       FROM plan_items pi JOIN plan_days pd ON pd.id = pi.plan_day_id
       WHERE pi.exercise_id = ? ORDER BY pd.day_number`
    )
    .all(ex.id);
  return { found: true, ...ex, progress: getProgress(ex.name), recent, appears };
}

// ---------- proposals ----------
export function createProposal(agent: string, instruction: string, raw: string, parsed: any) {
  const info = db
    .prepare(`INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json) VALUES (?, ?, ?, ?)`)
    .run(agent, instruction || "", raw || "", parsed ? JSON.stringify(parsed) : null);
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
               AND json_extract(d.context_json, '$.review_reason_code') IN
                   ('safety_floor','user_lock','domain_policy','clinical')
          )
        ORDER BY (
          SELECT MAX(d.id)
            FROM brain_decisions d
           WHERE d.source_ref_type = 'plan_proposal'
             AND d.source_ref_key = CAST(p.id AS TEXT)
             AND d.status = 'review'
             AND json_extract(d.context_json, '$.review_reason_code') IN
                 ('safety_floor','user_lock','domain_policy','clinical')
        ) DESC
        LIMIT ?`
    )
    .all(limit) as any[];
  return rows.map(hydrateProposal);
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
  const autonomy = db
    .prepare(
      `SELECT id, status, autonomy_tier, effective_date, summary, context_json
       FROM brain_decisions
       WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ?
         AND status IN ('review','announced','pending','applied')
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

export function setProposalStatus(id: number, status: string, opts: { deferTrainingVersionBump?: boolean } = {}) {
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
  if (proposal && status !== "applied") recordProposalStatusDecision(proposal, status);
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

// The conductor's one-tap "Draft my recovery week" is tagged by this instruction
// PREFIX (the client sends the full instruction; the prefix is the stable contract —
// test/engineeringContracts.test.js pins the client text to it). Two consumers:
// pendingRecoveryDraft() flips the Program button into a "Review your recovery
// week →" link while a draft waits, and supersedeRecoveryWeekDrafts() retires the
// prior draft when a fresh one lands so repeated taps never pile up drafts.
// The canonical full recovery-week instruction — shared by the lead-mode auto-draft
// (scheduler) and kept prefix-compatible with the PWA's one-tap draft so the
// drafted/active state machine (pendingRecoveryDraft, supersedeRecoveryWeekDrafts)
// treats both sources as the same thing.
export const RECOVERY_WEEK_INSTRUCTION =
  "Reshape next week into a RECOVERY (deload) week: cut working-set volume roughly in half, " +
  "keep every movement pattern, keep efforts easy and crisp (3-4 reps in reserve), no new " +
  "exercises and no load PRs — an earned reset after sustained loading, so the athlete comes back stronger.";

// Whether the lead-mode coach should draft the recovery week ITSELF right now: the
// conductor is asking for one (a recovery lead that is neither running nor already
// drafted) and the athlete has chosen the lead posture. Pure — the scheduler owns
// the ≤1×/day cadence stamp. This is what keeps the conductor's "your coach sets
// this up automatically" copy honest: the same read that makes the promise is the
// read that triggers the draft.
export function shouldAutoDraftRecoveryWeek(opts: {
  lead_mode?: unknown;
  focus_lead_domain?: unknown;
  recovery_active?: unknown;
  status: unknown;
}): boolean {
  return (
    String(opts.lead_mode) === "lead" &&
    String(opts.focus_lead_domain) === "recovery" &&
    opts.recovery_active !== true &&
    opts.status == null
  );
}

export function pendingRecoveryDraft(): { id: number } | null {
  // parsed_json IS NOT NULL: a failed agent run persists an unparseable draft row —
  // that is a retry case, not a reviewable recovery week.
  const row = db
    .prepare(
      `SELECT id FROM plan_proposals
        WHERE status = 'draft' AND parsed_json IS NOT NULL AND instruction LIKE ?
        ORDER BY id DESC LIMIT 1`
    )
    .get(`${RECOVERY_WEEK_INSTRUCTION_PREFIX}%`) as any;
  return row ? { id: Number(row.id) } : null;
}

export function supersedeRecoveryWeekDrafts(exceptId?: number) {
  const drafts = db
    .prepare(`SELECT id FROM plan_proposals WHERE status = 'draft' AND instruction LIKE ?`)
    .all(`${RECOVERY_WEEK_INSTRUCTION_PREFIX}%`) as any[];
  let retired = 0;
  for (const d of drafts) {
    if (exceptId != null && Number(d.id) === Number(exceptId)) continue;
    // Through setProposalStatus so a standing announced/pending decision is canceled too.
    setProposalStatus(Number(d.id), "superseded");
    retired++;
  }
  return retired;
}

// The recovery-week story as ONE state the surfaces read — an elite coach doesn't
// hand you a silently-halved week. Three states: a draft is waiting ('drafted' —
// actionable, wins over informational), the applied week is running ('applied',
// active for RECOVERY_WEEK_ACTIVE_DAYS from the apply stamp), or null. The Plan
// banner, the conductor's recovery lead, and the Program button all speak from this.
export type RecoveryWeekStatus =
  | { state: "drafted"; proposal_id: number; summary: string | null }
  | { state: "upcoming"; proposal_id: number; decision_id: number; effective_date: string; summary: string | null }
  | { state: "applied"; applied_on: string; until: string; summary: string | null }
  | null;

export type ActiveRecoveryWeek = Extract<RecoveryWeekStatus, { state: "applied" }>;

// The authoritative date-bound answer to "is the reduced recovery plan running?".
// It is ledger state, never inferred from a proposal summary or agent prose. The
// optional date keeps historical reads and deterministic tests independent of the
// wall clock; the interval is [applied_on, until), matching the seven plan dates.
export function activeRecoveryWeek(date = localDateISO()): ActiveRecoveryWeek | null {
  const ledger = activeRecoveryWeekLedger(date);
  if (!ledger) return null;
  return {
    state: "applied",
    applied_on: ledger.applied_on,
    until: ledger.until,
    summary: proposalSummary({ parsed: ledger.parsed }),
  };
}

export function recoveryWeekStatus(date = localDateISO()): RecoveryWeekStatus {
  // A running week is the primary truth even if a later draft exists. Surfaces may
  // still show that future draft after this window closes, but never at the cost of
  // making the active deload disappear from the daily/program brain.
  const active = activeRecoveryWeek(date);
  if (active) return active;
  const draft = pendingRecoveryDraft();
  if (draft) {
    const p = getProposal(draft.id);
    if ((p?.autonomy?.status === "announced" || p?.autonomy?.status === "pending") && p.autonomy.effective_date) {
      return {
        state: "upcoming",
        proposal_id: draft.id,
        decision_id: Number(p.autonomy.id),
        effective_date: String(p.autonomy.effective_date),
        summary: proposalSummary(p),
      };
    }
    return { state: "drafted", proposal_id: draft.id, summary: proposalSummary(p) };
  }
  return null;
}

function proposalSummary(p: any): string | null {
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

// Autonomy Undo restores the plan and retires only the recovery proposal that
// owned that decision. A newer recovery window keeps its stamp and plan intact.
export function revertRecoveryWeekIfOwned(proposalId: number, opts: { strict?: boolean } = {}): boolean {
  const p = getProposal(Number(proposalId));
  if (!p || !String(p.instruction ?? "").startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX)) return false;
  if (opts.strict) clearRecoveryWeekStampIfOwnedStrict(Number(proposalId));
  else clearRecoveryWeekStampIfOwned(Number(proposalId));
  if (p.status === "applied") setProposalStatus(Number(proposalId), "reverted");
  return true;
}

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
const KCAL_ABSOLUTE_FLOOR = 1500; // never advise a target below this for this user (mirrors buildMealPlanPrompt)
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
function recordAppliedProposalDecision(p: any, result: any, existingDecisionId?: number, required = false): void {
  try {
    const today = localDateISO();
    const nutrition = p.parsed?.kind === "nutrition_target";
    const restructure = Array.isArray(p.parsed?.days);
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
    // Run-plan apply: a week of run prescriptions (result.runs — the auto-run-plan
    // proposal, or a chat/manual cardio update). Emit falsifiable, windowed run
    // expectations mirroring the exercise/nutrition branches, so run-plan decisions
    // earn real evaluations instead of only the generic plan-adherence proxy below:
    //   (a) run_volume_adherence — did the prescribed weekly km actually get run?
    //   (b) a recovery guard (recovery_rhr_delta) — ONLY when this plan RAISES weekly
    //       km vs the prior prescription: expect resting-HR recovery not materially
    //       worse. Distances read from the applied plan (getRunCompliance, post-
    //       mutation), never the ledger-less result.runs shape.
    const appliedRuns = Array.isArray(result?.runs) ? result.runs : [];
    if (!nutrition && appliedRuns.length) {
      let newWeeklyKm = 0;
      try {
        newWeeklyKm = Number(getRunCompliance().prescribed_km) || 0;
      } catch {
        newWeeklyKm = 0;
      }
      if (newWeeklyKm > 0) {
        const runWindowDays = 28;
        const expectedWindowKm = Math.round(newWeeklyKm * (runWindowDays / 7) * 10) / 10;
        expectations.push({
          metric_key: "run_volume_adherence",
          subject_key: null,
          direction: "complete",
          baseline: { weekly_prescribed_km: newWeeklyKm },
          target: { rate: 0.8, expected_km: expectedWindowKm },
          window_start: today,
          window_end: datePlusDays(today, runWindowDays),
          minimum_data: { outings: 2 },
          confounder_policy: "exclude_context_events",
          confidence: "tentative",
          evaluator: "run_volume_adherence",
          evaluator_version: "run-volume-adherence-v1",
        });
        const priorWeeklyKm = Number(result?.prior_run_km);
        if (Number.isFinite(priorWeeklyKm) && priorWeeklyKm > 0 && newWeeklyKm > priorWeeklyKm * 1.05) {
          expectations.push({
            metric_key: "recovery_rhr_delta",
            subject_key: null,
            direction: "at_most",
            baseline: { prior_weekly_km: Math.round(priorWeeklyKm * 10) / 10, new_weekly_km: newWeeklyKm },
            target: { max: 3 },
            window_start: today,
            window_end: datePlusDays(today, runWindowDays),
            minimum_data: { nights: 6 },
            confounder_policy: "exclude_context_events",
            confidence: "tentative",
            evaluator: "recovery_delta",
            evaluator_version: "run-recovery-guard-v1",
          });
        }
      }
    }
    const accepted = result?.accepted ?? null;
    let nutritionBaseline: ReturnType<typeof estimateExpenditure> | null = null;
    let nutritionExpectationBasis: string | null = null;
    const nutritionEffectiveDate = accepted?.effective_date || today;
    const nutritionStage =
      nutrition && accepted?.target_kcal != null ? recompositionStageAt(nutritionEffectiveDate).kind : null;
    const nutritionTargetDelta = Number(p.parsed?.nutrition?.delta_kcal);
    const storedTargetDelta = Number.isFinite(nutritionTargetDelta)
      ? Math.round(nutritionTargetDelta)
      : Number.isFinite(Number(p.parsed?.nutrition?.prev_target_kcal))
        ? Math.round(Number(accepted?.target_kcal) - Number(p.parsed.nutrition.prev_target_kcal))
        : null;
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
            metric_key: "intake_to_weight_response",
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
            minimum_data: { weigh_ins: 6, intake_days: 10 },
            confounder_policy: "exclude_context_events",
            confidence: "tentative",
            evaluator: "intake_response",
            evaluator_version: "nutrition-intake-response-v2",
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
        metric_key: "intake_to_weight_response",
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
        minimum_data: { weigh_ins: 6, intake_days: 10 },
        confounder_policy: "exclude_context_events",
        confidence: "tentative",
        evaluator: "intake_response",
        evaluator_version: "nutrition-intake-response-v2",
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
    const sourceRefType = nutrition && accepted?.id ? "nutrition_target" : "plan_proposal";
    const sourceRefKey = String(nutrition && accepted?.id ? accepted.id : p.id);
    const shape = proposalDecisionShape(p);
    const rationale = shape.rationale;
    const evidenceKeys: string[] = [
      `plan_proposal:${p.id}`,
      ...(nutrition
        ? [`nutrition_target:${accepted?.id ?? p.id}`, `expenditure:${nutritionExpectationBasis ?? "thin"}`]
        : exercises.map((exercise) => `exercise:${exercise}:plan-and-history`).slice(0, 12)),
    ];
    const baseAction = nutrition
      ? {
          target_kcal: result?.nutrition?.target_kcal ?? null,
          protein_g: result?.nutrition?.protein_g ?? null,
          carbs_g: result?.nutrition?.carbs_g ?? null,
          fat_g: result?.nutrition?.fat_g ?? null,
          plan_proposal_id: p.id,
        }
      : restructure
        ? {
            plan_proposal_id: p.id,
            day_count: Number(result?.days) || p.parsed.days.length,
            days: p.parsed.days.slice(0, 14).map((day: any) => ({
              day_number: day?.day_number ?? null,
              name: day?.name ?? null,
              focus: day?.focus ?? null,
            })),
          }
        : {
            plan_proposal_id: p.id,
            changes: affected.slice(0, 24).map((item: any) => ({
              day_number: item?.day_number ?? null,
              exercise: item?.exercise ?? null,
              target_weight: item?.target_weight ?? null,
              sets: item?.sets ?? null,
              rep_low: item?.rep_low ?? null,
              rep_high: item?.rep_high ?? null,
              target_seconds: item?.target_seconds ?? null,
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
            runs: Array.isArray(result?.runs) ? result.runs.slice(0, 14) : [],
          };
    const action = result?.legacy_migration ? { ...baseAction, legacy_migration: result.legacy_migration } : baseAction;
    const decisionInput = {
      effective_date: nutrition && accepted?.effective_date ? accepted.effective_date : today,
      kind: shape.kind,
      domain: shape.domain,
      summary: shape.summary,
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
        ...(result?.legacy_migration ? { legacy_migration: result.legacy_migration } : {}),
        ...(nutrition
          ? {
              expectation_basis: nutritionExpectationBasis,
              baseline_confidence: nutritionBaseline?.confidence ?? null,
              recomposition_stage: nutritionStage,
            }
          : {}),
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

export interface ProposalApplyOptions {
  orphanSiblingCleanup?: OrphanSiblingCleanup;
  decisionId?: number;
  normalizedApplyPayload?: NormalizedProposalApplyPayload;
  requireDecisionLedger?: boolean;
}

function applyProposalUnit(id: number, opts: ProposalApplyOptions = {}) {
  const p = getProposal(id);
  if (!p) throw new Error(`No proposal ${id}`);
  const parsed = opts.normalizedApplyPayload?.parsed ?? p.parsed;
  if (!parsed) throw new Error("Proposal has no parsed payload");
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
    const incompatibility = reviewedNutritionTargetIncompatibility(parsed.nutrition);
    if (incompatibility) throw new Error(incompatibility);
    const { nutrition, clamped } = clampNutritionTarget(parsed.nutrition, { preserveReviewedKcal: true });
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
          note: nutrition.reason ?? null,
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
    recordAppliedProposalDecision(p, result, opts.decisionId, opts.requireDecisionLedger === true);
    return result;
  }
  // Restructure proposal: full plan replacement (changed frequency / split).
  if (Array.isArray(parsed.days)) {
    const quality = validateTrainingPlan(parsed.days);
    if (!quality.ok)
      throw new Error(`Plan quality check failed: ${quality.errors.map((entry) => entry.message).join(" ")}`);
    replacePlan(parsed.days);
    cancelAnnouncementsForProposal(id, opts.decisionId, opts.requireDecisionLedger === true);
    setProposalStatus(id, "applied");
    stampRecoveryWeekIfApplies(p, opts.requireDecisionLedger === true);
    if (opts.orphanSiblingCleanup) supersedeMatchingOrphanDrafts(id, opts.orphanSiblingCleanup);
    const result = {
      ok: true,
      id,
      restructured: true,
      days: parsed.days.length,
      quality,
      ...(opts.normalizedApplyPayload ? { legacy_migration: opts.normalizedApplyPayload.migration } : {}),
    };
    recordAppliedProposalDecision(p, result, opts.decisionId, opts.requireDecisionLedger === true);
    return result;
  }
  // A proposal may carry strength `changes`, a week of run prescriptions (`cardio`),
  // or both. (A full split/frequency rewrite uses `days` → replacePlan above.)
  const hasChanges = Array.isArray(parsed.changes);
  const hasCardio = Array.isArray(parsed.cardio) && parsed.cardio.length;
  if (!hasChanges && !hasCardio) {
    throw new Error("Proposal has no valid changes, cardio, or days");
  }
  const applied: any[] = []; // target tweaks to existing prescriptions
  const added: any[] = []; // movements ADDED to a day (the "add a back movement" intent)
  const skipped: any[] = [];
  const clamped: ClampAdjustment[] = [];
  const cardioRuns: any[] = [];
  let caughtQuality: PlanQualityReport | null = null;
  const savepoint = `apply_plan_proposal_${Math.trunc(Number(id))}`;
  const beforeQuality = validateTrainingPlan(getPlan());
  db.exec(`SAVEPOINT ${savepoint}`);
  for (const c of hasChanges ? parsed.changes : []) {
    try {
      // A cardio entry inside `changes` has no loaded exercise to tweak — route it to
      // the weekly-runs applier instead of skipping it (so mixed proposals apply runs).
      if (String(c?.kind ?? "").toLowerCase() === "cardio") {
        cardioRuns.push(c);
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
  if (hasCardio) cardioRuns.push(...parsed.cardio);
  let runs: { applied: any[] } | undefined;
  // The plan's run km BEFORE this apply — the "prior prescription" the run-plan
  // recovery guard compares against (read now while the plan is still pre-mutation).
  let priorRunKm: number | null = null;
  if (cardioRuns.length) {
    try {
      priorRunKm = getRunCompliance().prescribed_km;
    } catch {
      priorRunKm = null;
    }
    try {
      runs = setWeeklyRuns(
        cardioRuns.map(toRunPrescription).filter((r): r is RunPrescription => r != null),
        { deferTrainingVersionBump: true, deferDayReadInvalidation: true }
      );
    } catch (e: any) {
      skipped.push({ kind: "cardio", error: e.message });
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
    [
      ...(hasChanges ? parsed.changes : []).map((change: any) => Number(change?.day_number)),
      ...cardioRuns.map((run: any) => Number(run?.day_number)),
    ].filter(Number.isFinite)
  );
  const priorIssues = new Set(beforeQuality.errors.map(qualityIssueKey));
  const quality = validateTrainingPlan(getPlan());
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
  const changedAny = applied.some((a) => Number(a.updated) > 0) || added.length > 0 || (runs?.applied.length ?? 0) > 0;
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
    ...(runs ? { runs: runs.applied } : {}),
    ...(cardioRuns.length ? { prior_run_km: priorRunKm } : {}),
    ...(clamped.length ? { clamped } : {}),
    quality,
    ...(opts.normalizedApplyPayload ? { legacy_migration: opts.normalizedApplyPayload.migration } : {}),
  };
  recordAppliedProposalDecision(p, result, opts.decisionId, opts.requireDecisionLedger === true);
  // Exactly one in-process invalidation for the committed plan + proposal-state
  // unit. Failed savepoints return above without touching the counter.
  afterSqliteCommit(bumpTrainingDataVersion);
  return result;
}

export function applyProposal(id: number, opts: ProposalApplyOptions = {}) {
  return withSqliteSavepoint(`apply_proposal_${Math.trunc(Number(id))}`, () => applyProposalUnit(id, opts));
}

// Map a coach-emitted cardio entry (from parsed.cardio, or a kind:'cardio' change)
// onto a RunPrescription. Returns null when there's no usable day to attach it to.
function toRunPrescription(c: any): RunPrescription | null {
  const day_number = Math.trunc(Number(c?.day_number));
  if (!Number.isFinite(day_number) || day_number < 1) return null;
  return {
    day_number,
    label: c?.label ?? c?.exercise ?? null,
    target_distance_km: c?.target_distance_km ?? null,
    target_duration_min: c?.target_duration_min ?? null,
    target_zone: c?.target_zone ?? null,
    note: c?.note ?? null,
    day_name: c?.day_name ?? null,
    focus: c?.focus ?? null,
    interval: c?.interval ?? null,
  };
}

// ---------- profile ----------
export function getProfile(): any {
  return db.prepare(`SELECT * FROM profile WHERE id = 1`).get() || null;
}

// The athlete's primary training discipline, normalized (default 'strength').
// Deterministic, null-safe — the keystone of the endurance-aware reads/stats.
export function getPrimaryDiscipline(): "strength" | "endurance" | "hybrid" {
  const p = getProfile();
  return normalizeDiscipline(p?.primary_discipline, p?.primary_discipline);
}

function clampProfileNumber(v: any, min: number, max: number): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(min, n)) * 10) / 10;
}

function cleanISODate(v: any): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Coerce a PREVENT capture flag (smoking / bp_treated / statin) at the trust
// boundary. Accepts a boolean or 0/1 (as number or string); null/'' clears it
// back to "not captured"; anything else is treated as unset. Callers apply the
// same undefined-leaves-intact contract as about_me before calling this.
function coerceFlag(v: any): number | null {
  if (v == null || v === "") return null;
  if (v === true || v === 1 || v === "1" || v === "true") return 1;
  if (v === false || v === 0 || v === "0" || v === "false") return 0;
  return null;
}

export function setProfile(p: any) {
  const cur = getProfile() || {};
  // Height in inches (v59) — mirrors the app's lb/in convention. Same nullable
  // contract as the other optional fields: '' / null clears, undefined leaves
  // intact, a value is clamped to a plausible human range. NaN → null.
  const heightIn: number | null =
    p.height_in !== undefined
      ? p.height_in == null || p.height_in === ""
        ? null
        : Math.round(Math.min(108, Math.max(24, Number(p.height_in))) * 10) / 10 || null
      : (cur.height_in ?? null);
  const merged = {
    // The athlete's name (optional). Same contract as the free-text fields: an
    // explicit '' clears it, undefined leaves the existing value intact, capped.
    name:
      p.name !== undefined ? (p.name == null ? null : String(p.name).trim().slice(0, 120) || null) : (cur.name ?? null),
    // A genuinely blank profile must remain unknown until the athlete supplies
    // sex; silently defaulting to male can select the wrong health ranges.
    sex: p.sex !== undefined ? p.sex : (cur.sex ?? null),
    age: p.age ?? cur.age ?? null,
    // When only inches were ever provided, derive cm so the existing TDEE /
    // doctor-report paths (which read height_cm) light up too. An explicit cm
    // always wins.
    height_cm: p.height_cm ?? cur.height_cm ?? (heightIn != null ? Math.round(heightIn * 2.54 * 10) / 10 : null),
    height_in: heightIn,
    weight_lb: p.weight_lb ?? cur.weight_lb ?? null,
    start_weight_lb:
      p.start_weight_lb !== undefined ? clampProfileNumber(p.start_weight_lb, 50, 700) : (cur.start_weight_lb ?? null),
    start_date: p.start_date !== undefined ? cleanISODate(p.start_date) : (cur.start_date ?? null),
    goal_weight_lb: p.goal_weight_lb ?? cur.goal_weight_lb ?? null,
    goal_bodyfat_pct:
      p.goal_bodyfat_pct !== undefined ? clampProfileNumber(p.goal_bodyfat_pct, 3, 70) : (cur.goal_bodyfat_pct ?? null),
    goal_date: p.goal_date ?? cur.goal_date ?? null,
    // The journey's shape (v41). Same nullable contract as the free-text fields:
    // explicit null/'' clears it (→ derived), undefined leaves intact, a valid
    // value sets it, an unrecognized value keeps the current one.
    goal_mode: p.goal_mode !== undefined ? normalizeGoalMode(p.goal_mode, cur.goal_mode) : (cur.goal_mode ?? null),
    activity_factor: p.activity_factor ?? cur.activity_factor ?? 1.5,
    notes: p.notes ?? cur.notes ?? null,
    // Rich free-text understanding (Phase 2A). Trimmed/capped; explicit empty
    // string clears it, undefined leaves the existing value intact.
    about_me:
      p.about_me !== undefined
        ? p.about_me == null
          ? null
          : String(p.about_me).slice(0, 8000)
        : (cur.about_me ?? null),
    // Allergies (HARD safety exclusion for meals) + dietary restrictions. Same
    // contract as about_me: '' clears, undefined leaves intact, capped at 1000.
    allergies:
      p.allergies !== undefined
        ? p.allergies == null
          ? null
          : String(p.allergies).slice(0, 1000)
        : (cur.allergies ?? null),
    dietary_restrictions:
      p.dietary_restrictions !== undefined
        ? p.dietary_restrictions == null
          ? null
          : String(p.dietary_restrictions).slice(0, 1000)
        : (cur.dietary_restrictions ?? null),
    // Primary training discipline (v35) — drives coach framing, the day-read, and
    // weekly stats. Only 'strength' | 'endurance' | 'hybrid' are accepted; anything
    // else falls back to the existing value (default 'strength'). endurance_sport is
    // optional free text ('' clears, undefined leaves intact, capped at 60).
    primary_discipline: normalizeDiscipline(p.primary_discipline, cur.primary_discipline),
    endurance_sport:
      p.endurance_sport !== undefined
        ? p.endurance_sport == null
          ? null
          : String(p.endurance_sport).trim().slice(0, 60) || null
        : (cur.endurance_sport ?? null),
    // The endurance OBJECTIVE (v37). undefined leaves intact, null clears, else it's
    // normalized (race | standing) and re-serialized; an unusable shape clears it.
    endurance_goal_json:
      p.endurance_goal !== undefined ? serializeEnduranceGoal(p.endurance_goal) : (cur.endurance_goal_json ?? null),
    // AHA PREVENT capture flags (v57). Same nullable contract as the other
    // optional fields: undefined leaves intact, null/'' clears back to "not
    // captured", a boolean/0/1 sets it. Removes risk.ts's provisional assumption
    // for whichever of the three is on file.
    smoking: p.smoking !== undefined ? coerceFlag(p.smoking) : (cur.smoking ?? null),
    bp_treated: p.bp_treated !== undefined ? coerceFlag(p.bp_treated) : (cur.bp_treated ?? null),
    statin: p.statin !== undefined ? coerceFlag(p.statin) : (cur.statin ?? null),
  };
  db.prepare(
    `INSERT INTO profile (id, name, sex, age, height_cm, height_in, weight_lb, start_weight_lb, start_date, goal_weight_lb, goal_bodyfat_pct, goal_date, goal_mode, activity_factor, notes, about_me, allergies, dietary_restrictions, primary_discipline, endurance_sport, endurance_goal_json, smoking, bp_treated, statin, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       sex=excluded.sex, age=excluded.age, height_cm=excluded.height_cm, height_in=excluded.height_in, weight_lb=excluded.weight_lb,
       start_weight_lb=excluded.start_weight_lb, start_date=excluded.start_date,
       goal_weight_lb=excluded.goal_weight_lb, goal_bodyfat_pct=excluded.goal_bodyfat_pct, goal_date=excluded.goal_date, goal_mode=excluded.goal_mode,
       activity_factor=excluded.activity_factor, notes=excluded.notes, about_me=excluded.about_me,
       allergies=excluded.allergies, dietary_restrictions=excluded.dietary_restrictions,
       primary_discipline=excluded.primary_discipline, endurance_sport=excluded.endurance_sport,
       endurance_goal_json=excluded.endurance_goal_json,
       smoking=excluded.smoking, bp_treated=excluded.bp_treated, statin=excluded.statin, updated_at=datetime('now')`
  ).run(
    merged.name,
    merged.sex,
    merged.age,
    merged.height_cm,
    merged.height_in,
    merged.weight_lb,
    merged.start_weight_lb,
    merged.start_date,
    merged.goal_weight_lb,
    merged.goal_bodyfat_pct,
    merged.goal_date,
    merged.goal_mode,
    merged.activity_factor,
    merged.notes,
    merged.about_me,
    merged.allergies,
    merged.dietary_restrictions,
    merged.primary_discipline,
    merged.endurance_sport,
    merged.endurance_goal_json,
    merged.smoking,
    merged.bp_treated,
    merged.statin
  );
  // Profile is UPDATEd in place (single row), so the SQL backstop's count/max can't
  // see a sex/age/goal/weight change — bump so program/weekly/expenditure reads refresh.
  bumpTrainingDataVersion();
  // Change-detected brain signals. weight_lb is excluded (logWeight emits its own
  // weight_logged); name/notes/about_me are soft context, not a review trigger.
  const changed = (fields: string[]) =>
    fields.filter((field) => JSON.stringify((merged as any)[field] ?? null) !== JSON.stringify(cur[field] ?? null));
  const goalChanges = changed([
    "goal_weight_lb",
    "goal_bodyfat_pct",
    "goal_date",
    "goal_mode",
    "endurance_goal_json",
    "start_weight_lb",
    "start_date",
  ]);
  const profileChanges = changed([
    "sex",
    "age",
    "height_cm",
    "height_in",
    "activity_factor",
    "allergies",
    "dietary_restrictions",
    "primary_discipline",
    "endurance_sport",
    "smoking",
    "bp_treated",
    "statin",
  ]);
  if (goalChanges.length)
    emitBrainEvent({
      kind: "goal_changed",
      domain: "person",
      date: localDateISO(),
      subject_key: "profile:goal",
      reason: `changed: ${goalChanges.join(", ")}`,
      material: true,
    });
  if (profileChanges.length)
    emitBrainEvent({
      kind: "profile_changed",
      domain: "person",
      date: localDateISO(),
      subject_key: "profile:identity",
      reason: `changed: ${profileChanges.join(", ")}`,
      // User-declared allergies and hard dietary identities both change what a
      // current meal plan may safely remain authoritative for.
      material: profileChanges.includes("allergies") || profileChanges.includes("dietary_restrictions"),
    });
  return getProfile();
}

// Coerce a primary_discipline value: 'strength' | 'endurance' | 'hybrid' only;
// anything else (including undefined) leaves the existing value intact, defaulting
// to 'strength' on a brand-new profile.
const DISCIPLINES = new Set(["strength", "endurance", "hybrid"]);
export function normalizeDiscipline(v: any, current?: any): "strength" | "endurance" | "hybrid" {
  if (v !== undefined && v !== null) {
    const s = String(v).trim().toLowerCase();
    if (DISCIPLINES.has(s)) return s as "strength" | "endurance" | "hybrid";
  }
  const cur = current != null ? String(current).trim().toLowerCase() : "";
  return (DISCIPLINES.has(cur) ? cur : "strength") as "strength" | "endurance" | "hybrid";
}

// ---------- goal mode (v41) ----------
// The journey's SHAPE, orthogonal to the goal weight number:
//   lose     → today's lean-safe deficit toward a lower weight
//   maintain → anchor to real expenditure; hold steady, no deficit pressure
//   gain     → a conservative lean-gain surplus (never a dirty bulk)
// The stored column is nullable: NULL means "derive it" for back-compat.
export type GoalMode = "lose" | "maintain" | "gain";
const GOAL_MODES = new Set<GoalMode>(["lose", "maintain", "gain"]);

// Coerce an incoming goal_mode at the trust boundary. An explicit null/'' CLEARS
// it (→ derived); a recognized value sets it; an unrecognized non-empty value
// leaves the current value intact (mirrors normalizeDiscipline, but nullable).
export function normalizeGoalMode(v: any, current?: any): GoalMode | null {
  if (v === null || v === "") return null; // explicit clear → derive from goal weight
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  if (GOAL_MODES.has(s as GoalMode)) return s as GoalMode;
  const cur = current != null ? String(current).trim().toLowerCase() : "";
  return GOAL_MODES.has(cur as GoalMode) ? (cur as GoalMode) : null;
}

// The EFFECTIVE goal mode used by the math/prompts/UI. An explicit profile
// goal_mode wins; otherwise derive for back-compat — 'lose' when a goal weight
// meaningfully below current is set, else 'maintain'. Never returns null.
export function effectiveGoalMode(p?: any): GoalMode {
  const prof = p ?? getProfile();
  const explicit =
    prof?.goal_mode && GOAL_MODES.has(String(prof.goal_mode).toLowerCase() as GoalMode)
      ? (String(prof.goal_mode).toLowerCase() as GoalMode)
      : null;
  if (explicit) return explicit;
  const w = Number(prof?.weight_lb);
  const gw = Number(prof?.goal_weight_lb);
  if (Number.isFinite(w) && Number.isFinite(gw) && gw > 0 && gw < w - 0.5) return "lose";
  return "maintain";
}

// Conservative lean-gain pace: ~0.25% bodyweight/week, capped at 0.5 lb/wk — slow
// enough to bias muscle over fat (never a dirty bulk). Single source of truth for
// both the goal math (computeGoalCheck) and the weekly pace verdict (getWeeklyStats).
export function leanGainRate(weightLb: number): number {
  return Math.min(0.5, +(0.0025 * (weightLb || 0)).toFixed(2));
}

// ---------- endurance goal (v37) ----------
// The endurance OBJECTIVE, orthogonal to primary_discipline. Two modes:
//   race     → a dated event the coach periodizes a ramp + taper toward
//   standing → an ongoing readiness target (no date): maintain + gently build
// Normalized/clamped at the trust boundary; an unusable shape returns null (= clear).
export type EnduranceGoal = {
  mode: "race" | "standing";
  event?: string | null; // race name (race mode)
  date?: string | null; // race date YYYY-MM-DD (race mode)
  label?: string | null; // readiness label, e.g. "10k-ready" (standing mode)
  distance_km?: number | null; // target/readiness distance
  target?: string | null; // qualitative target, e.g. "sub-1:45"
  weekly_km?: number | null; // optional volume anchor
  weekly_sessions?: number | null;
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function clampPos(v: any, max: number): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : null;
}
function capStr(v: any, max: number): string | null {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
}
export function normalizeEnduranceGoal(input: any): EnduranceGoal | null {
  let g: any = input;
  if (typeof g === "string") {
    try {
      g = JSON.parse(g);
    } catch {
      return null;
    }
  }
  if (!g || typeof g !== "object") return null;
  const mode = String(g.mode || "")
    .trim()
    .toLowerCase();
  const distance_km = clampPos(g.distance_km, 500);
  const weekly_km = clampPos(g.weekly_km, 400);
  const weekly_sessions = clampPos(g.weekly_sessions, 14);
  if (mode === "race") {
    const date = ISO_DATE.test(String(g.date || "")) ? String(g.date) : null;
    if (!date) return null; // a race without a date can't be periodized — reject
    return {
      mode: "race",
      event: capStr(g.event, 120),
      date,
      distance_km,
      target: capStr(g.target, 60),
      weekly_km,
      weekly_sessions,
    };
  }
  if (mode === "standing") {
    return {
      mode: "standing",
      label: capStr(g.label, 80),
      distance_km,
      target: capStr(g.target, 60),
      weekly_km,
      weekly_sessions,
    };
  }
  return null;
}
function serializeEnduranceGoal(input: any): string | null {
  if (input == null) return null;
  const g = normalizeEnduranceGoal(input);
  return g ? JSON.stringify(g) : null;
}

// Inclusive whole-day difference toISO − fromISO (UTC midnight, day granularity).
function daysBetweenISO(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((b - a) / 86400000);
}

// Deterministic read of the active endurance goal, with race timing derived for the
// coach (weeks/days out + a coarse periodization PHASE hint). Standing goals have no
// date, so no phase — the coach maintains rather than ramps. Returns null when unset.
export function getEnduranceGoal(today?: string):
  | (EnduranceGoal & {
      is_race: boolean;
      days_to_race?: number | null;
      weeks_to_race?: number | null;
      phase?: "base" | "build" | "sharpen" | "taper" | "past" | null;
    })
  | null {
  const p = getProfile();
  const g = normalizeEnduranceGoal(p?.endurance_goal_json);
  if (!g) return null;
  if (g.mode !== "race" || !g.date) return { ...g, is_race: false };
  const days = daysBetweenISO(today || localDateISO(), g.date);
  if (!Number.isFinite(days)) return { ...g, is_race: true, days_to_race: null, weeks_to_race: null, phase: null };
  const weeks = Math.ceil(days / 7);
  // Coarse phase hint from time-to-race (the coach refines against actual base):
  // past → done; ≤2wk taper; ≤4wk sharpen; ≤10wk build; else base.
  const phase = days < 0 ? "past" : weeks <= 2 ? "taper" : weeks <= 4 ? "sharpen" : weeks <= 10 ? "build" : "base";
  return { ...g, is_race: true, days_to_race: days, weeks_to_race: Math.max(0, weeks), phase };
}

// ---------- bodyweight log ----------
const MIN_LOGGED_WEIGHT_LB = 50;
const MAX_LOGGED_WEIGHT_LB = 700;

function canonicalWeightLogDate(value: unknown): string {
  if (value === undefined) return localDateISO();
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError("weight date must be YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError("weight date must be a real calendar date");
  }
  if (value > localDateISO()) throw new RangeError("weight date cannot be in the future");
  return value;
}

// Shared trust boundary for REST, MCP, chat, and direct callers. A rejected
// reading does not write a row or promote an invalid date into profile.weight_lb.
export function logWeight(weight_lb: number, date?: string, note?: string) {
  const weight = Number(weight_lb);
  if (!Number.isFinite(weight) || weight < MIN_LOGGED_WEIGHT_LB || weight > MAX_LOGGED_WEIGHT_LB) {
    throw new RangeError(`weight_lb must be between ${MIN_LOGGED_WEIGHT_LB} and ${MAX_LOGGED_WEIGHT_LB}`);
  }
  const d = canonicalWeightLogDate(date);
  const info = db
    .prepare(`INSERT INTO bodyweight_log (date, weight_lb, note) VALUES (?, ?, ?)`)
    .run(d, weight, note ?? null);
  bumpTrainingDataVersion(); // a weigh-in moves the weekly trend + expenditure reads
  // Keep the profile's current weight in sync with the most recent entry.
  const latest = db.prepare(`SELECT weight_lb FROM bodyweight_log ORDER BY date DESC, id DESC LIMIT 1`).get() as any;
  if (latest) setProfile({ weight_lb: latest.weight_lb });
  // A fresh weigh-in is a brain signal (it moves the weight trend the day-read +
  // energy-balance read speak to) — refresh the Brief like its sibling signals do.
  invalidateDayRead(d);
  emitBrainEvent({
    kind: "weight_logged",
    domain: "body",
    date: d,
    entity_id: Number(info.lastInsertRowid),
    subject_key: "bodyweight",
    ...(() => {
      try {
        const goal: any = computeGoalCheck();
        const trend = Number(goal?.trend_lb_wk);
        const ideal = Number(goal?.leanness_rate?.lean_ideal_rate_lb);
        const material =
          goal?.goal_mode === "lose" && Number.isFinite(trend) && Number.isFinite(ideal) && trend < -(ideal * 1.1);
        return material ? { material: true, reason: "weight trend is faster than the lean-mass-preserving pace" } : {};
      } catch {
        return {};
      }
    })(),
  });
  return db.prepare(`SELECT * FROM bodyweight_log WHERE id = ?`).get(info.lastInsertRowid);
}

export function listWeight(limit = 60) {
  // chronological for charting
  const rows = db.prepare(`SELECT * FROM bodyweight_log ORDER BY date DESC, id DESC LIMIT ?`).all(limit) as any[];
  return rows.reverse();
}

// ---------- goal feasibility check ----------
export const KCAL_PER_LB = 3500;

export interface BodyFatEstimate {
  body_fat_pct: number;
  source: "tape" | "garmin" | "profile";
  date: string | null;
  estimated: boolean;
}

function heightInFor(p: any): number | null {
  const hin = Number(p?.height_in);
  if (Number.isFinite(hin) && hin >= 24 && hin <= 108) return hin;
  const hcm = Number(p?.height_cm);
  if (Number.isFinite(hcm) && hcm >= 60 && hcm <= 275) return hcm / 2.54;
  return null;
}

function navyTapeBodyFat(p: any): BodyFatEstimate | null {
  const heightIn = heightInFor(p);
  if (heightIn == null) return null;
  const row = db
    .prepare(`SELECT date, waist_in, hip_in, neck_in FROM body_measurements ORDER BY date DESC, id DESC LIMIT 1`)
    .get() as any;
  if (!row) return null;
  const waist = Number(row.waist_in);
  const neck = Number(row.neck_in);
  const hip = Number(row.hip_in);
  const female = String(p?.sex || "male").toLowerCase() === "female";
  let value: number | null = null;
  if (!female && Number.isFinite(waist) && Number.isFinite(neck) && waist > neck && heightIn > 0) {
    value = 86.01 * Math.log10(waist - neck) - 70.041 * Math.log10(heightIn) + 36.76;
  } else if (
    female &&
    Number.isFinite(waist) &&
    Number.isFinite(hip) &&
    Number.isFinite(neck) &&
    waist + hip > neck &&
    heightIn > 0
  ) {
    value = 163.205 * Math.log10(waist + hip - neck) - 97.684 * Math.log10(heightIn) - 78.387;
  }
  if (value == null || !Number.isFinite(value)) return null;
  value = Math.max(3, Math.min(70, Math.round(value * 10) / 10));
  return { body_fat_pct: value, source: "tape", date: row.date ?? null, estimated: true };
}

function latestGarminBodyFat(): BodyFatEstimate | null {
  const row = db
    .prepare(
      `SELECT date, body_fat_pct FROM garmin_daily_metrics WHERE body_fat_pct IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get() as any;
  const value = Number(row?.body_fat_pct);
  if (!Number.isFinite(value) || value < 3 || value > 70) return null;
  return { body_fat_pct: Math.round(value * 10) / 10, source: "garmin", date: row.date ?? null, estimated: false };
}

export function currentBodyFatEstimate(prof?: any): BodyFatEstimate | null {
  const p = prof ?? getProfile();
  if (!p) return null;
  return navyTapeBodyFat(p) ?? latestGarminBodyFat();
}

// Decision-time phase snapshot. The classifier itself is pure/cycle-free; this
// adapter only gathers current canonical profile/bodyweight/phase inputs so an
// intervention can retain the phase it actually belonged to.
export function recompositionStageAt(today = localDateISO()) {
  const profile = getProfile() as any;
  const resolved = resolvedCurrentBodyweight(profile, today);
  const current = Number(resolved?.weight_lb ?? profile?.weight_lb);
  const start = Number(profile?.start_weight_lb);
  const goal = Number(profile?.goal_weight_lb);
  const validCurrent = Number.isFinite(current) && current > 0 ? current : null;
  const validStart = Number.isFinite(start) && start > 0 ? start : null;
  const validGoal = Number.isFinite(goal) && goal > 0 ? goal : null;
  const lost = validStart != null && validCurrent != null ? Math.max(0, validStart - validCurrent) : null;
  const total = validStart != null && validGoal != null && validStart > validGoal ? validStart - validGoal : null;
  const progress = total != null && lost != null ? Math.max(0, Math.min(1, lost / total)) : null;
  const remaining = validCurrent != null && validGoal != null ? Math.max(0, validCurrent - validGoal) : null;
  const phase = db
    .prepare(
      `SELECT kind FROM journey_phases WHERE status = 'active'
       ORDER BY COALESCE(start_date, created_at) DESC, id DESC LIMIT 1`
    )
    .get() as any;
  const bodyFat = currentBodyFatEstimate(profile);
  return classifyRecompositionStage({
    mode: effectiveGoalMode(profile),
    phaseKind: phase?.kind ?? null,
    progress,
    remaining,
    current: validCurrent,
    bodyFatPct: bodyFat?.body_fat_pct ?? null,
    bodyFatDate: bodyFat?.date ?? null,
    goalBodyFat: Number.isFinite(Number(profile?.goal_bodyfat_pct)) ? Number(profile.goal_bodyfat_pct) : null,
    today,
  });
}

export function leannessAwareLossRates(weightLb: number, bodyFatPct?: number | null) {
  const w = Number(weightLb);
  const baseMax = Number.isFinite(w) ? 0.01 * w : 0;
  const baseIdeal = Number.isFinite(w) ? 0.0075 * w : 0;
  const bf = bodyFatPct == null ? Number.NaN : Number(bodyFatPct);
  let maxPct = 0.01;
  let idealPct = 0.0075;
  let reason = "standard lean-safe cut";
  if (Number.isFinite(bf)) {
    if (bf < 15) {
      maxPct = 0.0035;
      idealPct = 0.0025;
      reason = "very lean — taper the deficit hard to protect lean mass";
    } else if (bf < 20) {
      maxPct = 0.006;
      idealPct = 0.0045;
      reason = "leaner phase — slower loss protects training and lean mass";
    } else if (bf < 25) {
      maxPct = 0.008;
      idealPct = 0.006;
      reason = "mid-cut — slightly slower than the early phase";
    }
  }
  return {
    safe_max_rate_lb: +Math.min(baseMax, Math.max(0, w * maxPct)).toFixed(2),
    lean_ideal_rate_lb: +Math.min(baseIdeal, Math.max(0, w * idealPct)).toFixed(2),
    reason,
    body_fat_pct: Number.isFinite(bf) ? Math.round(bf * 10) / 10 : null,
  };
}

export function computeGoalCheck(
  prof?: any,
  opts: { expenditure?: ExpenditureEstimate | null; syncMeasuredRmr?: boolean } = {}
) {
  const storedProfile = prof ?? getProfile();
  const currentWeight = resolvedCurrentBodyweight(storedProfile);
  const p = currentWeight ? { ...storedProfile, weight_lb: currentWeight.weight_lb } : storedProfile;
  if (!p || !p.weight_lb || !p.height_cm || !p.age) {
    return { ok: false, message: "Profile incomplete (need age, height, weight)." };
  }
  const kg = p.weight_lb / LB_PER_KG;
  const sexAdj = (p.sex || "male") === "female" ? -161 : 5;
  const formulaBmr = 10 * kg + 6.25 * p.height_cm - 5 * p.age + sexAdj;
  const measuredRmrOpts = { syncHealthDocs: opts.syncMeasuredRmr !== false };
  const measuredRmr = latestMeasuredRmr(measuredRmrOpts);
  const measuredRmrQuality = measuredRmr ? measuredRmrAssessment(localDateISO(), measuredRmrOpts) : null;
  const measuredWeight = measuredRmrQuality?.freshness_weight ?? 0;
  const bmr = measuredRmrQuality ? formulaBmr + (measuredRmrQuality.kcal - formulaBmr) * measuredWeight : formulaBmr;
  // The manual activity factor is the cold-start seed. estimateExpenditure owns
  // the complete prior hierarchy + outcome fusion so the Goal and Energy
  // surfaces cannot disagree about which maintenance estimate is active.
  const factorTdee = Math.round(formulaBmr * (p.activity_factor || 1.5));
  let tdee = factorTdee;
  let tdee_source: "activity_factor" | "measured_rmr_plus_activity" | "garmin_total_calories" | "adaptive" | "blended" =
    "activity_factor";
  let tdee_basis = "profile_seed";
  let tdee_confidence: "none" | "low" | "medium" | "high" = "none";
  let expenditure: ExpenditureEstimate | null = null;
  if (opts.expenditure !== undefined) {
    expenditure = opts.expenditure;
  } else {
    try {
      expenditure = estimateExpenditure(21, { syncMeasuredRmr: opts.syncMeasuredRmr });
    } catch {
      expenditure = null;
    }
  }
  try {
    if (expenditure && expenditure.tdee != null && expenditure.tdee > 0) {
      tdee = expenditure.tdee;
      tdee_basis = expenditure.tdee_basis;
      tdee_confidence = expenditure.confidence;
      if (expenditure.tdee_basis === "measured_rmr_active") tdee_source = "measured_rmr_plus_activity";
      else if (expenditure.tdee_basis === "garmin_total_calories") tdee_source = "garmin_total_calories";
      else if (expenditure.tdee_basis === "profile_seed") tdee_source = "activity_factor";
      else if (expenditure.tdee_basis === "blended_outcome_prior") tdee_source = "blended";
      else tdee_source = "adaptive";
    }
  } catch {
    /* malformed optional estimate → retain the deterministic profile seed */
  }

  const mode = effectiveGoalMode(p);
  const lbsToLose = p.goal_weight_lb != null ? Math.max(0, p.weight_lb - p.goal_weight_lb) : 0;

  // lean-safe loss: early cuts can run near ~0.5-1% BW/week, but the ceiling
  // tapers as body fat falls. A tape/Garmin body-fat estimate is an estimate, so
  // it only narrows the ceiling; absent BF keeps the old conservative default.
  const bodyFat = currentBodyFatEstimate(p);
  const lossRates = leannessAwareLossRates(p.weight_lb, bodyFat?.body_fat_pct ?? null);
  const safeMaxRate = lossRates.safe_max_rate_lb; // upper bound (lb/wk)
  const leanIdealRate = lossRates.lean_ideal_rate_lb; // recommended (lb/wk)

  let requested: any = null;
  let recommended: {
    weekly_rate_lb: number;
    daily_deficit_kcal: number;
    target_intake_kcal: number;
    weeks_to_goal: number;
    protein_g: number;
  };
  let message: string;

  if (mode === "maintain") {
    // Anchor to real expenditure. No deficit, no surplus — hold steady. We only
    // ever nudge later if the measured weight trend genuinely drifts.
    recommended = {
      weekly_rate_lb: 0,
      daily_deficit_kcal: 0,
      target_intake_kcal: Math.max(KCAL_ABSOLUTE_FLOOR, tdee),
      weeks_to_goal: 0,
      protein_g: Math.round((p.weight_lb || 0) * 0.9),
    };
    message = `Maintaining — anchor to ~${tdee} kcal with ~${recommended.protein_g} g protein. Hold steady; we only nudge if your weight genuinely drifts.`;
  } else if (mode === "gain") {
    // Conservative lean gain: ~0.25% bodyweight/week (capped at 0.5 lb/wk) — slow
    // enough to bias muscle over fat. NEVER a dirty bulk; lab quality (e.g. ApoB)
    // still gates WHAT the surplus is made of via the connected brain.
    const gainRate = leanGainRate(p.weight_lb);
    const dailySurplus = Math.round((gainRate * KCAL_PER_LB) / 7);
    recommended = {
      weekly_rate_lb: gainRate,
      daily_deficit_kcal: -dailySurplus, // negative = a surplus (field name kept for back-compat)
      target_intake_kcal: Math.max(KCAL_ABSOLUTE_FLOOR, tdee + dailySurplus),
      weeks_to_goal: 0,
      protein_g: Math.round((p.weight_lb || 0) * 1.0),
    };
    message = `Lean gain — eat ~${recommended.target_intake_kcal} kcal (about +${dailySurplus}/day over maintenance) with ~${recommended.protein_g} g protein. Slow and steady builds muscle, not fat.`;
  } else {
    // lose (explicit, or derived from a goal weight below current).
    if (p.goal_date && lbsToLose > 0) {
      const weeks = Math.max(0.1, (new Date(p.goal_date).getTime() - Date.now()) / (7 * 864e5));
      const rate = +(lbsToLose / weeks).toFixed(2);
      const dailyDeficit = Math.round((rate * KCAL_PER_LB) / 7);
      requested = {
        weeks: +weeks.toFixed(1),
        weekly_rate_lb: rate,
        daily_deficit_kcal: dailyDeficit,
        target_intake_kcal: Math.max(KCAL_ABSOLUTE_FLOOR, tdee - dailyDeficit),
        aggressive: rate > safeMaxRate,
      };
    }
    const recDailyDeficit = Math.round((leanIdealRate * KCAL_PER_LB) / 7);
    recommended = {
      weekly_rate_lb: leanIdealRate,
      daily_deficit_kcal: recDailyDeficit,
      target_intake_kcal: Math.max(KCAL_ABSOLUTE_FLOOR, tdee - recDailyDeficit),
      weeks_to_goal: lbsToLose > 0 ? Math.ceil(lbsToLose / leanIdealRate) : 0,
      protein_g: Math.round((p.weight_lb || 0) * 1.0),
    };
    if (lbsToLose <= 0) {
      message = "At or below goal weight — maintain and keep training for lean mass.";
    } else if (requested?.aggressive) {
      message = `Goal of ${lbsToLose} lb by ${p.goal_date} needs ~${requested.weekly_rate_lb} lb/wk (~${requested.daily_deficit_kcal} kcal/day deficit). That's above the lean-safe ceiling of ~${safeMaxRate} lb/wk and will likely cost muscle. Recommended: ~${recommended.weekly_rate_lb} lb/wk → about ${recommended.weeks_to_goal} weeks, eating ~${recommended.target_intake_kcal} kcal with ~${recommended.protein_g} g protein.`;
    } else if (requested) {
      message = `On track: ~${requested.weekly_rate_lb} lb/wk is within the lean-safe range. Eat ~${requested.target_intake_kcal} kcal, ~${recommended.protein_g} g protein.`;
    } else {
      message = `No target date set. Lean-safe pace ~${recommended.weekly_rate_lb} lb/wk → ${recommended.weeks_to_goal} weeks to lose ${lbsToLose} lb, eating ~${recommended.target_intake_kcal} kcal, ~${recommended.protein_g} g protein.`;
    }
  }

  // ---- goal-pace projection (from the ACTUAL weigh-in trend, not the plan) ----
  // The static math above asks "what rate would HIT the date"; this projects
  // where the CURRENT measured trend actually lands. Plain language + a date —
  // never a score. Null/silent when there isn't enough scale data or no goal.
  const goalPace = projectGoalPace(p, lbsToLose);

  // ---- the EFFECTIVE target the surfaces read (accepted > formula) ----------
  // If the athlete has ACCEPTED an adaptive-nutrition target, that number wins over
  // the re-derived formula (closing the loop — the accepted target is persisted, not
  // recomputed each time). The formula stays the fallback AND the lean-safe floor:
  // protein never drops below the recommended protein floor. `accepted` is null-safe.
  let accepted: any = null;
  try {
    accepted = getLatestNutritionTarget();
  } catch {
    accepted = null;
  }
  const effective_target =
    accepted && accepted.target_kcal != null && !accepted.review_due
      ? {
          target_kcal: Math.max(KCAL_ABSOLUTE_FLOOR, Math.round(accepted.target_kcal)),
          protein_g: Math.max(Math.round(accepted.protein_g ?? 0), Math.round(recommended.protein_g || 0)),
          carbs_g: accepted.carbs_g != null ? Math.round(accepted.carbs_g) : null,
          fat_g: accepted.fat_g != null ? Math.round(accepted.fat_g) : null,
          source: "accepted" as const,
          effective_date: accepted.effective_date,
          age_days: accepted.age_days ?? 0,
          freshness: accepted.freshness ?? "fresh",
          review_due: !!accepted.review_due,
          divergence_from_formula_kcal: Math.round(
            Math.max(KCAL_ABSOLUTE_FLOOR, Number(accepted.target_kcal)) - Number(recommended.target_intake_kcal)
          ),
        }
      : {
          target_kcal: Math.round(recommended.target_intake_kcal),
          protein_g: Math.round(recommended.protein_g || 0),
          carbs_g: null,
          fat_g: null,
          source: "formula" as const,
          effective_date: null,
          age_days: null,
          freshness: null,
          review_due: !!accepted?.review_due,
          divergence_from_formula_kcal: 0,
          expired_target:
            accepted?.review_due && accepted.target_kcal != null
              ? {
                  target_kcal: accepted.target_kcal,
                  protein_g: accepted.protein_g,
                  effective_date: accepted.effective_date,
                  age_days: accepted.age_days,
                  freshness: accepted.freshness,
                  source: accepted.source,
                }
              : null,
        };
  const effectiveMessage =
    accepted && accepted.target_kcal != null && !accepted.review_due
      ? `Active target: ~${effective_target.target_kcal} kcal with ~${effective_target.protein_g} g protein${effective_target.carbs_g != null ? `, ${effective_target.carbs_g} g carbs` : ""}${effective_target.fat_g != null ? `, and ${effective_target.fat_g} g fat` : ""}. Cairn will recheck it against your weight trend and training performance.`
      : accepted?.review_due
        ? `${message} The prior adaptive target is review-due, so it remains visible in history but no longer overrides this current read.`
        : message;

  return {
    ok: true,
    bmr: Math.round(bmr),
    bmr_source: measuredRmrQuality?.freshness === "fresh" ? "measured" : measuredWeight > 0 ? "blended" : "formula",
    bmr_formula: Math.round(formulaBmr),
    measured_rmr: measuredRmrQuality,
    tdee,
    tdee_source,
    tdee_basis,
    tdee_confidence,
    expenditure,
    lbs_to_lose: lbsToLose,
    // The effective journey shape (v41) — drives the day-intake target framing,
    // the pace verdict, and every nutrition prompt. Additive; older consumers ignore.
    goal_mode: mode,
    safe_max_rate_lb: safeMaxRate,
    leanness_rate: {
      body_fat_pct: lossRates.body_fat_pct,
      body_fat_source: bodyFat?.source ?? null,
      reason: lossRates.reason,
      safe_max_rate_lb: safeMaxRate,
      lean_ideal_rate_lb: leanIdealRate,
    },
    requested,
    recommended,
    message: effectiveMessage,
    formula_message: message,
    // The persisted accepted target (or null) + the EFFECTIVE target every surface
    // should read (accepted wins, formula is the fallback/floor). Additive.
    accepted_target: accepted,
    effective_target,
    // Additive (older consumers ignore): the measured-trend forecast.
    trend_lb_wk: goalPace.trend_lb_wk,
    projected_goal_date: goalPace.projected_goal_date,
    projection_text: goalPace.projection_text,
  };
}

// Project where the athlete's CURRENT measured weight trend lands their goal —
// a real forecast off the scale, not the plan's required pace. Returns the
// measured weekly trend, a projected goal date (or null), and a plain-language
// line ("at this trend, ~Aug 20 — about 3 weeks past your date"). Words + a
// date, never a number-as-score. Null-safe: too little scale data / no goal →
// quiet (trend or date null, no false precision).
export function projectGoalPace(
  p: any,
  lbsToLose: number
): {
  trend_lb_wk: number | null;
  projected_goal_date: string | null;
  projection_text: string | null;
} {
  // Measured weekly trend over the last 28 days of weigh-ins (a bit longer than
  // the 21-day weekly-stats window so a goal forecast is steadier).
  const today = localDateISO();
  const since = addDaysISO(today, -28) ?? today;
  const wpts = canonicalBodyweightSeries({ since, through: today });
  let trend: number | null = null; // lb/week (negative = losing)
  if (wpts.length >= 2) {
    const pts = wpts
      .map((w) => ({ date: String(w.date), value: Number(w.weight_lb) }))
      .filter((x) => Number.isFinite(x.value));
    const xs = pts.map((x) => Date.parse(x.date + "T00:00:00Z") / 864e5);
    if (pts.length >= 2 && xs[xs.length - 1] - xs[0] >= 4) {
      const slope = lsqSlopePerDay(pts);
      if (slope != null) trend = Math.round(slope * 7 * 100) / 100;
    }
  }
  const curW = resolvedCurrentBodyweight(p, today)?.weight_lb ?? null;
  const goalW = p?.goal_weight_lb;
  const remainingLb = goalW != null && curW != null ? Math.max(0, curW - Number(goalW)) : lbsToLose;
  if (remainingLb <= 0 || curW == null) return { trend_lb_wk: trend, projected_goal_date: null, projection_text: null };
  if (trend == null)
    return {
      trend_lb_wk: null,
      projected_goal_date: null,
      projection_text: "Not enough recent weigh-ins to project a date yet — a few more and the forecast sharpens.",
    };

  if (goalW == null) return { trend_lb_wk: trend, projected_goal_date: null, projection_text: null };

  // Not actually losing (trend flat or gaining) while there's still weight to
  // lose → no honest date; say so plainly rather than inventing one.
  if (trend >= -0.05) {
    return {
      trend_lb_wk: trend,
      projected_goal_date: null,
      projection_text:
        trend > 0.05
          ? "At your current trend you're drifting up, not down — no date to project until the trend turns."
          : "Your weight's holding steady right now — a small deficit would start moving it toward your goal.",
    };
  }

  const weeksToGoal = (curW - goalW) / Math.abs(trend);
  if (!Number.isFinite(weeksToGoal) || weeksToGoal <= 0 || weeksToGoal > 520) {
    return {
      trend_lb_wk: trend,
      projected_goal_date: null,
      projection_text: "At this trend the goal is a long way out — worth revisiting the pace.",
    };
  }
  const projDate = new Date(Date.now() + weeksToGoal * 7 * 864e5);
  const projected_goal_date = projDate.toISOString().slice(0, 10);
  const niceDate = projDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  let projection_text: string;
  if (p?.goal_date) {
    const goalDateMs = Date.parse(p.goal_date);
    if (Number.isFinite(goalDateMs)) {
      const diffWeeks = Math.round((projDate.getTime() - goalDateMs) / (7 * 864e5));
      if (diffWeeks <= -1)
        projection_text = `At your current trend, ~${niceDate} — about ${Math.abs(diffWeeks)} week${Math.abs(diffWeeks) === 1 ? "" : "s"} ahead of your date.`;
      else if (diffWeeks >= 1)
        projection_text = `At your current trend, ~${niceDate} — about ${diffWeeks} week${diffWeeks === 1 ? "" : "s"} past your date.`;
      else projection_text = `At your current trend, ~${niceDate} — right around your target date.`;
    } else {
      projection_text = `At your current trend, you'd reach your goal around ${niceDate}.`;
    }
  } else {
    projection_text = `At your current trend, you'd reach your goal around ${niceDate} — no target date set, so this is just where the scale's heading.`;
  }
  return { trend_lb_wk: trend, projected_goal_date, projection_text };
}
