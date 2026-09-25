import { db } from "../../db.js";
import {
  clinicianFloorHolds,
  clinicianNoteText,
  decideAutonomyTier,
  domainShouldDemote,
  leadModelCeiling,
  nextNaturalBoundary,
  surpriseBudgetAllows,
} from "../../brain/autonomy.js";
import {
  conferenceConflictInputs,
  conflictIsSafetyFloor,
  revisionFromProposalPayload,
  revisionHoldsClinicalFloor,
  type ConferenceConflictInputs,
} from "./conference-conflicts.js";
import { getCoachContext } from "../../repo/coach.js";
import { listTrainingSymptoms } from "../../repo/training-symptoms.js";
import {
  athleteRestructureLandingDate,
  enqueueStructureRebuild,
  isAthleteRequestedRestructure,
  liveStructureBuild,
  retireAnsweredStructureRequests,
} from "./structure-request.js";
import type { AutonomyTier, BrainDomain } from "../../brain/decision-contract.js";
import {
  appliedDecisionForNewerSource,
  hasRecentDecisionVeto,
  listBrainDecisions,
  listBrainExpectations,
  listDraftBackedReviewDecisions,
  listReviewDecisionsForProposal,
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
  mealPlanStatus,
  restoreMealPlanAfterUndo,
  setMealPlanStatus,
  setNutritionTarget,
  validateMealPlanForPersistence,
} from "../../repo/nutrition.js";
import { mealPlanDraftUnseen, mealPlanRefreshShape } from "../../repo/meal-plan-refresh.js";
import { getPlan, replacePlan } from "../../repo/plan.js";
import { stampsByPlanKey } from "../../repo/prescription-authorship.js";
import { movementKey, normalizeExerciseName, normalizedExerciseKey } from "../../repo/exercise-canon.js";
import { cancelRecoveryCycle, getRecoveryCycle } from "../../repo/recovery-cycles.js";
import { computeGoalCheck, getProfile, setProfile } from "../../repo/profile.js";
import { applyProposal, getProposal, listProposals, listReviewHeldProposals, proposalStatus, setProposalStatus, type NormalizedProposalApplyPayload, type OrphanSiblingCleanup } from "../../repo/proposals.js";
import { RECOVERY_WEEK_INSTRUCTION_PREFIX, revertRecoveryWeekIfOwned } from "../../repo/recovery-week.js";
import { MEAL_REFRESH_REQUEST_KEY } from "../../repo/meal-refresh-retry.js";
import { automaticOrphanIntent, chatOrphanIntent } from "../../repo/proposal-intent.js";
import { buildProgressionProposal } from "../../repo/progression.js";
import { buildRunPlanProposal } from "../../repo/run-progression.js";
import { capProtectiveRaise, cutReaffirmation, deriveCutTarget } from "../../repo/cut-target.js";
import { getSettings } from "../../repo/settings.js";
import { registerTrainingCacheClear, trainingBackstopSignature } from "../../repo/training-cache.js";
import {
  draftIsRegenerationProduct,
  regenerableProducer,
  regenerationEmptyRationale,
  regenerationRebaseRationale,
  regenerationReceiptRationale,
} from "./draft-regeneration.js";
import { setAppStateStrict } from "../../repo/app-state.js";
import { addChatMessage } from "../../repo/chat.js";
import { recordAsyncFailure } from "../../diagnostics.js";
import { addDaysISO, localDateISO, parseDbTime } from "../../repo/shared.js";
import { getSessionByDate } from "../../repo/sessions.js";
import { refreshPreparedDayForPlanChange } from "../../repo/adaptive-session.js";
import {
  isPersonSuperseded,
  mismatchedChangeKeys,
  personSupersededMarker,
  planChangeKey,
} from "../../repo/plan-annotation-release.js";
import { revertGarminReconcile } from "../../repo/activities.js";
import { withSqliteSavepoint } from "../../repo/sqlite-savepoint.js";
import {
  captureNutritionProposalEvidence,
  captureProposalEvidence,
  proposalEvidenceSnapshot,
  type ProposalFreshness,
  verifyProposalEvidenceSnapshot,
  verifyProposalEvidenceFreshness,
} from "../../repo/proposal-truth.js";
import { log } from "../../log.js";

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

// ---- A DEAD PREMISE IS RETIRED, NEVER RE-ASKED --------------------------------
//
// A held draft that rotates one movement out ("swap Decline Bench Press for Chest
// Dips") is a question ABOUT something on the plan. Restructure the plan so that
// movement is gone, and the question has no subject left: applying it can only skip
// the change, and asking it makes the athlete adjudicate an exercise they no longer
// train. Live, that left a week-old swap sitting in "Waiting on you" behind a lift
// the plan had already dropped.
//
// WHICH changes count as a premise: only the ones that REQUIRE an existing
// prescription — a swap's `from`, and a removal's `exercise` (`remove:true`, or the
// `sets:0` spelling applyPlanChange treats as a removal). An ordinary target tweak is
// an UPSERT that ADDS the movement when the day does not carry it, so it is never
// premise-gone; a `days` restructure replaces the plan wholesale and names nothing
// that has to already exist.
//
// WHERE we look: the WHOLE plan, not the day the change references. A restructure
// renumbers days, and a movement that merely moved from day 2 to day 3 still has its
// premise. That is the retire-LESS of the two readings on purpose — a draft is set
// aside only once its subject has left the plan entirely.
type PremiseTarget = { exercise: string; day_number: number | null };

// The two spellings of "take this prescription off the day" that applyPlanChange
// honours; both throw when the movement is not there to remove.
function removesPrescription(change: any): boolean {
  return change?.remove === true || Number(change?.sets) === 0;
}

// `exclusive` is true only when EVERY entry in the payload is a premise change. A
// mixed draft — one dead removal beside a live "add a back movement" — keeps a half
// that would still do something, and retiring it would throw the athlete's intent
// away along with the dead half.
function proposalPremiseTargets(proposal: any): { targets: PremiseTarget[]; exclusive: boolean } {
  const parsed = proposal?.parsed ?? {};
  if (Array.isArray(parsed.days)) return { targets: [], exclusive: false };
  const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
  if (!changes.length) return { targets: [], exclusive: false };
  const targets: PremiseTarget[] = [];
  let exclusive = !(Array.isArray(parsed.cardio) && parsed.cardio.length > 0);
  for (const change of changes) {
    if (String(change?.kind ?? "").toLowerCase() === "cardio") {
      exclusive = false;
      continue;
    }
    const dayNumber = Number.isFinite(Number(change?.day_number)) ? Number(change.day_number) : null;
    const from = String(change?.swap?.from ?? "").trim();
    if (from) {
      targets.push({ exercise: from, day_number: dayNumber });
      continue;
    }
    const exercise = String(change?.exercise ?? "").trim();
    if (exercise && removesPrescription(change)) {
      targets.push({ exercise, day_number: dayNumber });
      continue;
    }
    exclusive = false;
  }
  return { targets, exclusive };
}

function planStrengthExerciseNames(): string[] {
  const names: string[] = [];
  for (const day of getPlan() as any[]) {
    for (const item of Array.isArray(day?.items) ? day.items : []) {
      if (String(item?.kind ?? "strength").toLowerCase() === "cardio") continue;
      const name = String(item?.exercise ?? "").trim();
      if (name) names.push(name);
    }
  }
  return names;
}

// The SAME three tiers applyPlanSwap resolves a swap target with — exact normalized
// name, then the canonical key, then the implement-agnostic movement key — so "is this
// still on the plan" is answered by the matcher that would actually find it.
function planCarriesMovement(planNames: string[], exercise: string): boolean {
  const norm = normalizeExerciseName(exercise);
  const key = normalizedExerciseKey(exercise);
  const move = movementKey(exercise);
  return planNames.some(
    (name) =>
      (!!norm && normalizeExerciseName(name) === norm) ||
      (!!key && normalizedExerciseKey(name) === key) ||
      (!!move && movementKey(name) === move)
  );
}

/** The movements this draft needs and the plan no longer has, or null when it still has a premise. */
function proposalPremiseGone(proposal: any): string[] | null {
  const { targets, exclusive } = proposalPremiseTargets(proposal);
  if (!targets.length || !exclusive) return null;
  const planNames = planStrengthExerciseNames();
  // An EMPTY plan says nothing about whether a movement was dropped — a fresh install
  // and a plan mid-rewrite look exactly like a plan the lift was removed from. Silence
  // is never the evidence that retires a draft.
  if (!planNames.length) return null;
  const gone = targets.filter((target) => !planCarriesMovement(planNames, target.exercise));
  if (gone.length !== targets.length) return null;
  return [...new Set(gone.map((target) => target.exercise))];
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

// Every live `review` row holding this draft, OLDEST FIRST. The oldest is the ask the
// athlete has actually been looking at, so it is the one that keeps its place in the
// queue. Asked of the ledger BY PROPOSAL ID (listReviewDecisionsForProposal) rather
// than filtered out of the newest hundred review rows — structure requests and every
// other hold share that status, so an older hold on this draft fell off the page and
// both callers below silently missed it.
function liveReviewHoldsForProposal(proposalId: number): ParkedDecision[] {
  return listReviewDecisionsForProposal(proposalId).filter((decision) => decision.id != null);
}

// The athlete-facing reason a volume-floor hold carries: the groups the draft would
// leave under their weekly set floor (verify-floors.ts writes one message per group,
// each leading with the group), in plain words — never the set arithmetic. Null when
// the draft carries no unresolved volume finding.
function volumeFloorHoldReason(proposal: any): string | null {
  const unresolved = Array.isArray(proposal?.parsed?.volume_floor_unresolved)
    ? proposal.parsed.volume_floor_unresolved.map(String)
    : [];
  if (!unresolved.length) return null;
  const groups = [
    ...new Set(
      unresolved
        .map((line: string) => /^([a-z][a-z ]*?) would\b/i.exec(line.trim())?.[1]?.trim())
        .filter((group: string | undefined): group is string => !!group)
    ),
  ] as string[];
  const named =
    groups.length === 0
      ? "some muscle groups"
      : groups.length === 1
        ? groups[0]
        : `${groups.slice(0, -1).join(", ")} and ${groups[groups.length - 1]}`;
  return `This week would leave ${named} under ${groups.length === 1 ? "its" : "their"} weekly set floor, so it waits for your yes before it lands.`;
}

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
  // ONE OPEN ASK PER DRAFT. Every held adoption pass re-derives the refusal and records
  // it, and recordDecision's fingerprint covers `action` — which carries the reason code
  // and the reason provenance. So a pass whose refusal MOVED (a clinical ceiling one
  // week, a stale snapshot the next) hashed differently and inserted a SECOND review row
  // for the same draft, and "Waiting on you" showed the athlete the same swap twice. The
  // fingerprint cannot see that the subject is identical; the proposal id can.
  const held = liveReviewHoldsForProposal(Number(proposal.id));
  const keep = held[0] ?? null;
  // Never LOOSEN the floor on a refresh. `clinicianFloorHolds` is the deterministic read
  // (the server's own marks, or clinical action text) — not the bare tier a model wrote —
  // so a draft the server marked clinical stays clinician-directed even when today's
  // refusal reads as an ordinary stale snapshot.
  const floorHeld = keep ? clinicianFloorHolds(keep) : false;
  const clinical = input.clinical === true || floorHeld;
  const tier = input.tier === "clinician" || floorHeld ? "clinician" : "ask";
  const fields = {
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
    risk_class: clinical ? "clinical" : shape.risk,
    reversible: false,
    input_fingerprint: null,
    context: {
      review_required: true,
      review_reason_code: input.code,
      review_reasons: reasons,
      policy_inputs: input.policy_inputs ?? {},
      clinical,
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
      // The waiting surface speaks a hold's own sentence; a volume-floor hold has one.
      ...(input.code === "safety_floor" && volumeFloorHoldReason(proposal)
        ? { user_explanation: volumeFloorHoldReason(proposal) }
        : {}),
    },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  };
  let recorded: any;
  if (keep) {
    // Any duplicate that already exists is folded into the surviving ask, so a ledger
    // that acquired two rows before this rule landed heals on the next held pass.
    for (const duplicate of held.slice(1)) {
      transitionBrainDecision(Number(duplicate.id), "superseded", { supersededBy: keep.id ?? null });
    }
    // The prior context is carried, not replaced: the once-only stamps written by the
    // sweeps that walk this row (`thaw_attempted`, the adoption refusal signature) are
    // their guards against re-deriving the same answer every tick, and dropping them
    // here would turn one refreshed hold into a per-tick loop.
    recorded =
      patchBrainDecision(Number(keep.id), {
        ...(fields as any),
        input_fingerprint: keep.input_fingerprint ?? null,
        context: { ...((keep.context ?? {}) as Record<string, any>), ...fields.context },
      }) ?? keep;
  } else {
    recorded = recordDecision(fields as any).decision;
  }
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

// The date policy lives in brain/autonomy.ts (nextNaturalBoundary) so the chat structure
// hand-off can name the same landing day in its receipt without importing this module.
function nextBoundary(kind: ProposalShape["kind"], today = localDateISO()): string {
  return nextNaturalBoundary(kind, today);
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
    // Carried through because replacePlan reads an omitted day_type as 'training':
    // a snapshot that dropped it would turn every Undo into a quiet deletion of the
    // week's rest day.
    day_type: String(day.day_type ?? "training") === "rest" ? "rest" : "training",
    items: (Array.isArray(day.items) ? day.items : []).map((item: any) => {
      const clean: Record<string, any> = {};
      for (const field of PLAN_ITEM_FIELDS) {
        if (item[field] !== undefined) clean[field] = item[field];
      }
      return clean;
    }),
  }));
}

// A LEGACY (v1, array-shaped) training-plan rollback payload was captured before
// `day_type` existed, so every day in it is silent about the field — and replacePlan
// reads an omitted day_type as 'training'. Undoing an old decision would therefore
// flatten a rest day the athlete has added since, which is a deletion nobody asked
// for hiding inside an Undo. Carry the LIVE type forward wherever the payload does
// not declare one. A day absent from the payload is still deleted, exactly as this
// path has always behaved. The one exception is coherence: a payload day carrying
// work cannot be restored as a rest day, so items win and it comes back as training.
// (The v2 three-way path already reverts day_type explicitly and is untouched.)
function withCurrentDayTypes(payload: any[]): any[] {
  let current: Map<number, string>;
  try {
    current = new Map(trainingPlanSnapshot().map((day: any) => [Number(day.day_number), String(day.day_type)]));
  } catch {
    return payload;
  }
  return payload.map((day: any) => {
    if (day == null || typeof day !== "object") return day;
    const declared = String(day.day_type ?? "").toLowerCase();
    if (declared === "rest" || declared === "training") return day;
    const live = current.get(Number(day.day_number));
    if (live !== "rest") return day;
    const itemCount = Array.isArray(day.items) ? day.items.length : 0;
    return itemCount > 0 ? day : { ...day, day_type: "rest" };
  });
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
//
// `released` names what a person's own plan save took over since
// (plan-annotation-release.ts): that item is theirs outright, so Undo keeps it exactly
// as it stands even where a value happens to equal the decision's `after`.
function mergeTrainingRollback(
  before: any[],
  after: any[],
  current: any[],
  swaps: any[] = [],
  released: (dayNumber: number, item: any) => boolean = () => false
): any[] {
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
      if (released(dayNumber, currentEntry.item)) {
        items.push(currentEntry.item);
        if (rotation) handledBefore.add(rotation.beforeKey);
        if (beforeByKey.has(currentEntry.key)) handledBefore.add(currentEntry.key);
        continue;
      }
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
      if (released(dayNumber, beforeEntry.item)) continue;
      const item = rollbackItem(beforeEntry.item, afterByKey.get(beforeEntry.key)?.item, null);
      if (item != null) items.push(item);
    }
    merged.push({
      day_number: dayNumber,
      name: rollbackScalar(b.name, a.name, c.name),
      focus: rollbackScalar(b.focus, a.focus, c.focus),
      // Same three-way rule as the other day-level scalars: the decision's own change
      // to the day's type reverts, an edit the athlete made since it does not.
      day_type: rollbackScalar(b.day_type ?? "training", a.day_type ?? "training", c.day_type ?? "training"),
      items,
    });
  }
  return merged;
}

function rollbackSnapshot(shape: ProposalShape): any {
  if (shape.domain === "recovery") return { kind: "recovery_cycle" };
  return shape.domain !== "nutrition"
    ? { kind: "training_plan", plan: trainingPlanSnapshot(), stamps: stampsByPlanKey() }
    : { kind: "nutrition_target", previous: getActiveNutritionTarget() };
}

// `before_stamps` carries each slot's prescribed_at from before the decision, so an Undo
// that restores a slot restores when it was written too (prescription-authorship.ts).
// `after_stamps` is what the decision itself left: an Undo only restores a slot's old
// date while the slot still carries that stamp (nothing has re-stamped it since).
function trainingRollbackPayload(before: any[], beforeStamps?: Record<string, string | null>): any {
  return {
    version: 2,
    before,
    after: trainingPlanSnapshot(),
    ...(beforeStamps ? { before_stamps: beforeStamps, after_stamps: stampsByPlanKey() } : {}),
  };
}

// A merged Undo plan, with the pre-decision stamp put back on every slot that comes
// back EXACTLY as it stood before the decision, while its live stamp is still the one
// the decision wrote. A slot re-stamped since (a later edit, a later decision) keeps
// its current stamp; anything else is stamped by the ordinary rule against the live row.
function withRestoredStamps(merged: any[], before: any[], stamps: unknown, afterStamps: unknown): any[] {
  if (!stamps || typeof stamps !== "object" || !afterStamps || typeof afterStamps !== "object") return merged;
  const live = stampsByPlanKey();
  const beforeByKey = new Map<string, any>();
  for (const day of before)
    for (const item of Array.isArray(day?.items) ? day.items : []) {
      const key = planChangeKey(day.day_number, item?.exercise);
      if (key && !beforeByKey.has(key)) beforeByKey.set(key, item);
    }
  return merged.map((day) => ({
    ...day,
    items: (Array.isArray(day?.items) ? day.items : []).map((item: any) => {
      const key = planChangeKey(day.day_number, item?.exercise);
      if (!key || !Object.hasOwn(stamps, key) || !sameValue(item, beforeByKey.get(key))) return item;
      const current = live[key] ?? null;
      const own = (afterStamps as Record<string, string | null>)[key] ?? null;
      return { ...item, prescribed_at: current === own ? (stamps as Record<string, string | null>)[key] : current };
    }),
  }));
}

function proposalRollbackPayload(rollback: any, result: any): any {
  if (rollback.kind === "training_plan") return trainingRollbackPayload(rollback.plan, rollback.stamps);
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
// budget nor counts against another change trying to land the same week. Neither is the
// athlete's OWN ask (an explicit request, a restructure they asked for): it is not a
// surprise to them, and counting it let two Sunday asks defer that week's evolution.
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
        AND COALESCE(json_extract(context_json, '$.explicit_user_request'), 0) != 1
        AND COALESCE(json_extract(context_json, '$.athlete_requested_restructure'), 0) != 1
        AND date(created_at) >= date('now','-6 days')`
    )
    .get(...params) as any;
  return Number(row?.n ?? 0);
}

// The plan days a proposal's payload touches. A `changes[]` edit names them; a `days`
// restructure replaces the whole template, so every day it declares counts. Used only
// to ask whether TODAY's prepared session is one of them.
function proposalPlanDayNumbers(proposal: any): number[] {
  const days = new Set<number>();
  const rows = [
    ...(Array.isArray(proposal?.parsed?.changes) ? proposal.parsed.changes : []),
    ...(Array.isArray(proposal?.parsed?.days) ? proposal.parsed.days : []),
    ...(Array.isArray(proposal?.parsed?.cardio) ? proposal.parsed.cardio : []),
  ];
  for (const row of rows) {
    const day = Number(row?.day_number);
    if (Number.isInteger(day) && day > 0) days.add(day);
  }
  return [...days];
}

// Today's prepared session is a SNAPSHOT of its plan day. A change that lands today has
// to be re-taken into it, or the athlete opens Today and trains the movements the change
// just replaced. Fail-soft: the plan write already succeeded and must not be undone by a
// redraw, and every refusal (`session_started` above all) is an ordinary answer.
function refreshTodayAfterPlanLanding(proposal: any, effectiveDate: unknown): void {
  const today = localDateISO();
  if (String(effectiveDate ?? "") !== today) return;
  try {
    refreshPreparedDayForPlanChange({ date: today, day_numbers: proposalPlanDayNumbers(proposal) });
  } catch (err) {
    recordAsyncFailure("apply", "refresh_prepared_day", err);
  }
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
  // Is this week's draft a rotation of the plan in force, or a change to it? The
  // classifier is deterministic and conservative (repo/meal-plan-refresh.ts): an
  // unreadable or absent predecessor is never "bounded".
  const refreshShape = mealPlanRefreshShape(plan.parsed, (liveAcceptedMealPlan(planId) as any)?.parsed ?? null);
  const policy = decideAutonomyTier({
    kind: "meal_plan",
    risk_class: "low",
    reversible: true,
    requested_tier: input.requested_tier,
    lead_mode: getSettings().lead_mode,
    user_locked: input.user_locked,
    domain_demoted: domainIsDemoted("nutrition"),
    routine: refreshShape.bounded,
  });
  if (policy.tier === "ask" || policy.tier === "clinician" || policy.tier === "observe") {
    return { ok: true, applied: false, tier: policy.tier, plan, reasons: policy.reasons };
  }
  // Both live tiers wait for the same natural boundary — a meal plan never changes
  // the food day already under way. The tier decides how loudly it arrives, and
  // which status the boundary pass reads it under (a quiet apply is 'pending', an
  // announcement is 'announced'); it never decides whether the athlete can undo it.
  const quiet = policy.tier === "quiet_apply";
  // A spent budget delays this plan to its natural boundary and lets the boundary pass
  // re-check the week; it never converts the plan into an ask (2026-08-17 ruling).
  const surpriseBudgetSpent =
    !input.coordinated_update && !surpriseBudgetAllows(materialChangesThisWeek("nutrition", undefined, "meal_plan"));

  const effectiveDate = nextMealBoundary();
  const decision = withSqliteSavepoint(`schedule_meal_plan_${planId}`, () => {
    // The freshest scheduled meal week wins. Retire its older queued alternatives
    // in the same commit as the new owner so a ledger failure cannot strand both.
    //
    // A DRAFT THE ATHLETE NEVER SAW IS REPLACED, NOT SUPERSEDED. The refresh runs on
    // a standing cadence, so a week nobody opened the app during used to leave a
    // retired plan AND a retired ledger row behind, every week — a history of
    // decisions about food that was never in front of anyone. When the queued draft
    // has not been seen, its ledger row is re-pointed at the new plan instead: one
    // standing "your next week of meals" entry that stays current, rather than a
    // stack of them. A draft that HAS been seen keeps the ordinary supersede, because
    // by then the athlete has a memory of it that the ledger has to match.
    const queued = [
      ...listBrainDecisions({ status: "announced", kind: "meal_plan", limit: 50 }),
      ...listBrainDecisions({ status: "pending", kind: "meal_plan", limit: 50 }),
    ].sort((a, b) => Number(b.id) - Number(a.id));
    let reusable: (typeof queued)[number] | null = null;
    for (const queuedDecision of queued) {
      const olderPlanId = Number((queuedDecision.action as any)?.meal_plan_id);
      if (!(olderPlanId > 0) || olderPlanId === planId) continue;
      const older = getMealPlan(olderPlanId) as any;
      const isDraft = older?.status === "draft";
      if (isDraft) setMealPlanStatus(olderPlanId, "superseded", { recordDecision: false });
      if (!reusable && isDraft && mealPlanDraftUnseen(older)) {
        reusable = queuedDecision;
        continue;
      }
      transitionBrainDecision(queuedDecision.id!, "superseded");
    }
    const previous = liveAcceptedMealPlan(planId);
    const fields = {
      effective_date: effectiveDate,
      kind: "meal_plan" as const,
      domain: "nutrition" as const,
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
      status: quiet ? ("pending" as const) : ("announced" as const),
      autonomy_tier: policy.tier,
      risk_class: "low" as const,
      reversible: false,
      input_fingerprint: null,
      context: {
        natural_boundary: true,
        ...(quiet ? { quiet: true } : {}),
        refresh_bounded: refreshShape.bounded,
        ...(refreshShape.reasons.length ? { refresh_reasons: refreshShape.reasons } : {}),
        surprise_budget_deferred: surpriseBudgetSpent,
        coordinated_update: input.coordinated_update === true,
        ...(reusable ? { replaced_unseen_draft_decision_id: reusable.id ?? null } : {}),
        evidence_keys: [`meal_plan:${plan.id}`, "coach_context:nutrition"],
        evidence_observed_at: new Date().toISOString(),
      },
      action: { meal_plan_id: plan.id, previous_meal_plan_id: previous?.id ?? null },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    };
    if (reusable?.id) {
      const patched = patchBrainDecision(Number(reusable.id), fields as any);
      if (patched) return patched;
      // The re-point failed: retire the stale row and fall through to a fresh one
      // rather than leaving two live decisions pointing at different weeks.
      transitionBrainDecision(Number(reusable.id), "superseded");
    }
    return recordDecision(fields as any).decision;
  });
  return {
    ok: true,
    applied: false,
    ...(quiet ? { pending: true } : { announced: true }),
    tier: policy.tier,
    effective_date: effectiveDate,
    decision,
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

// ---- REGENERATE, DON'T ASK ----------------------------------------------------
//
// A draft held because its evidence snapshot moved — or because it simply waited past
// its freshness horizon — is asking the athlete to adjudicate a diff only the producer
// can act on. Both holds already KNOW what changed; what they do with that knowledge is
// hand it to the one person who cannot use it. So when the producing op can be re-run
// mechanically (src/domain/brain/draft-regeneration.ts owns that question), it IS re-run
// against current evidence, the stale draft is retired with a receipt naming why, and the
// replacement earns its own tier through this same pipeline.
//
// The bound is absolute: ONE regeneration per draft. The receipt carries the lineage, so
// a replacement that goes stale in ITS turn falls back to the ordinary hold. Nothing here
// touches an ask that is genuinely the athlete's — clinical, user-locked, and the
// review_everything posture all return unregenerated, and every floor below still runs.
type RegenerationAttempt =
  | { regenerated: false }
  | { regenerated: true; result: any };

function attemptStaleDraftRegeneration(
  proposal: any,
  shape: ProposalShape,
  input: {
    freshness: ProposalFreshness | null;
    aged: boolean;
    clinical: boolean;
    user_locked?: boolean;
    asOf: string;
    parked?: { id?: number | null } | null;
    // The boundary and the thaw — where a stale draft would otherwise be set aside — may
    // also rebase a bounded agent draft. The first apply gate keeps its hold.
    allowRebase?: boolean;
  }
): RegenerationAttempt {
  // The athlete's own asks are untouched: a clinical ceiling stays clinician-directed, a
  // locked target stays theirs, and under 'review_everything' nothing may be set aside on
  // their behalf (the same floor thawParkedReviewDecisions honours).
  if (input.clinical || input.user_locked === true) return { regenerated: false };
  if (getSettings().lead_mode === "review_everything") return { regenerated: false };
  const staleId = Number(proposal?.id);
  if (!(staleId > 0)) return { regenerated: false };
  const producer = regenerableProducer(proposal, input.allowRebase ? input.freshness : null);
  if (!producer) return { regenerated: false };
  if (draftIsRegenerationProduct(staleId)) return { regenerated: false };
  const changed = input.freshness?.changed_components ?? [];
  try {
    return withSqliteSavepoint(`regenerate_stale_draft_${staleId}`, () => {
      // Retire the stale draft FIRST: every deterministic producer retires its own prior
      // drafts on the way in, and `recordDecision:false` keeps the receipt below the one
      // ledger row for this transition rather than filing a vaguer second one beside it.
      setProposalStatus(staleId, "superseded", { recordDecision: false });
      const rebuilt = producer.rerun();
      const replacement = rebuilt.ok ? rebuilt.proposal : null;
      // A replacement that is already stale the moment it is written means the evidence
      // is churning, or that this producer's payload cannot carry a compare-and-set
      // snapshot at all. Throwing unwinds the retirement and the caller's ordinary hold
      // stands — regeneration never gets a second swing at the same draft.
      if (replacement && verifyProposalEvidenceFreshness(replacement.parsed, localDateISO()).status !== "current") {
        throw new Error("the regenerated draft is not current");
      }
      // A regenerated draft earns its tier FRESH. No requested_tier, no inherited
      // coordination: it goes through the whole pipeline as if it had just been written,
      // which is exactly what it is.
      const autonomy = replacement
        ? applyProposalWithAutonomy(Number(replacement.id), { skip_regeneration: true })
        : null;
      const replacementDecisionId = Number(autonomy?.decision?.id) || null;
      const receipt = recordDecision({
        effective_date: input.asOf,
        kind: shape.kind,
        domain: shape.domain,
        summary: replacement
          ? "A stale draft was rewritten against your current picture."
          : "A stale draft was set aside; reading it again found nothing to change.",
        rationale: (replacement
          ? producer.rebase
            ? regenerationRebaseRationale(changed, input.asOf)
            : regenerationReceiptRationale(changed, input.aged, input.asOf)
          : regenerationEmptyRationale(changed, input.aged, input.asOf)
        ).slice(0, 1_500),
        source: proposal.agent || "autonomy",
        source_ref_type: "plan_proposal",
        source_ref_key: String(staleId),
        status: "superseded",
        autonomy_tier: "observe",
        risk_class: shape.risk,
        reversible: false,
        input_fingerprint: null,
        context: {
          regeneration_receipt: true,
          review_reason_code: "stale_snapshot",
          regenerated_reason: input.aged ? "aged_out" : "evidence_moved",
          changed_components: changed,
          producer_key: producer.key,
          proposal_freshness: input.freshness ?? null,
          superseded_review_decision_id: input.parked?.id ?? null,
        },
        action: {
          proposal_id: staleId,
          regenerated_proposal_id: replacement ? Number(replacement.id) : null,
          regenerated_decision_id: replacementDecisionId,
          outcome: replacement ? "regenerated_from_current_evidence" : "superseded_stale_evidence",
          reason_provenance: proposalReasonProvenance(proposal),
        },
        specialist: null,
        applied_at: null,
        reverted_at: null,
        // The superseded draft's row points at what replaced it, through the same
        // mechanism every other supersede in this module uses.
        superseded_by: replacementDecisionId,
        evaluator_version: null,
      }).decision;
      // A decision that was already waiting on the stale draft (the boundary case) is
      // retired against the replacement rather than left canceled by the retirement above.
      if (input.parked?.id) {
        try {
          transitionBrainDecision(Number(input.parked.id), "superseded", {
            supersededBy: replacementDecisionId ?? (Number(receipt?.id) || null),
          });
        } catch {
          /* the receipt is the authoritative record; a failed relink must not undo it */
        }
      }
      const provenance = {
        regenerated: true,
        regenerated_from_proposal_id: staleId,
        regenerated_proposal_id: replacement ? Number(replacement.id) : null,
        regeneration_receipt_decision_id: Number(receipt?.id) || null,
      };
      return {
        regenerated: true as const,
        result: replacement
          ? { ...(autonomy ?? {}), ...provenance }
          : { ok: true, applied: false, superseded: true, decision: receipt, ...provenance },
      };
    });
  } catch {
    // Fail-soft by design: anything that goes wrong here unwinds to the state the
    // ordinary hold expects, and the caller holds the draft exactly as it used to.
    return { regenerated: false };
  }
}

/**
 * A change the athlete scoped to TODAY, which cannot land today, STOPS.
 *
 * The alternative is what shipped: the ask is announced for the next natural boundary
 * and mutates the weekly template days later, carrying a premise ("legs are saturated
 * from this morning's run") that expired the moment the day did. That is a different
 * change from the one they asked for, made without them.
 *
 * So nothing is scheduled. The draft is retired the same way a dead-premise draft is —
 * `superseded`, which also keeps the orphan-adoption sweep from picking it back up days
 * later — and an `observed` row records that the ask was heard and answered with
 * nothing. The receipt the athlete reads is composed by the chat reconciler.
 */
function holdTodayScopedProposal(proposal: any, shape: ProposalShape, wouldHaveLanded: string): any {
  const today = localDateISO();
  let decision: any = null;
  try {
    decision = recordDecision({
      effective_date: today,
      kind: shape.kind,
      domain: shape.domain,
      summary: String(proposal.parsed?.summary ?? "A change asked for today was not made.").slice(0, 300),
      rationale:
        "You asked for this to happen today, and it could not. Nothing was scheduled for another day — the day it was about is the only day it was for.",
      source: proposal.agent || "autonomy",
      source_ref_type: "plan_proposal",
      source_ref_key: String(proposal.id),
      status: "observed",
      autonomy_tier: "observe",
      risk_class: shape.risk,
      reversible: false,
      input_fingerprint: null,
      context: {
        today_scoped: true,
        held_reason: "today_scoped",
        would_have_landed: wouldHaveLanded,
        evidence_keys: [`plan_proposal:${proposal.id}`, `current_plan:${shape.domain}`],
        evidence_observed_at: new Date().toISOString(),
      },
      action: {
        proposal_id: proposal.id,
        outcome: "not_applied_today_scoped",
        reason_provenance: proposalReasonProvenance(proposal),
      },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    }).decision;
  } catch (err) {
    // The ledger row is the receipt's evidence trail, not its gate: losing it must not
    // turn a refusal to reschedule back into a schedule.
    recordAsyncFailure("apply", "today_scoped_observation", err);
  }
  supersedePriorReviewHolds(Number(proposal.id));
  setProposalStatus(Number(proposal.id), "superseded", { recordDecision: false });
  return {
    ok: true,
    applied: false,
    scheduled: false,
    held_reason: "today_scoped",
    tier: "observe",
    requested_date: today,
    would_have_landed: wouldHaveLanded,
    decision,
  };
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
    // INTERNAL. Set only on the routing of a draft this layer has just regenerated, so
    // the regeneration bound holds inside the pass that created it (the receipt carrying
    // the lineage is not written until that routing returns). No surface passes this.
    skip_regeneration?: boolean;
    // The athlete scoped this change to TODAY in their own words ("apply it to my
    // program for today", "heading to the gym now"). A today-scoped ask is answered
    // today or not at all: it may never be quietly re-aimed at a later boundary, where
    // the premise that produced it ("my legs are saturated from this morning's run")
    // no longer holds. Set by the chat plan_update path; no public surface passes it.
    today_scoped?: boolean;
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
    // Regenerate rather than ask: the athlete cannot adjudicate a fingerprint diff, and
    // the producer can simply read the question again from where they are now.
    if (!input.skip_regeneration) {
      const regenerated = attemptStaleDraftRegeneration(proposal, shape, {
        freshness: proposalFreshness,
        aged: false,
        clinical,
        user_locked: input.user_locked,
        asOf: localDateISO(),
      });
      if (regenerated.regenerated) return regenerated.result;
    }
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
    // Same ruling as the compare-and-set gate above: "this waited too long" is the
    // system's own observation about its own draft, so the answer is a fresh read, not
    // a question. An explicit current-turn request is left alone — the athlete is
    // looking at THIS draft, and swapping it underneath them would be the surprise.
    if (!input.skip_regeneration && !input.explicit_user_request) {
      const regenerated = attemptStaleDraftRegeneration(proposal, shape, {
        freshness: proposalFreshness,
        aged: true,
        clinical,
        user_locked: input.user_locked,
        asOf: localDateISO(),
      });
      if (regenerated.regenerated) return regenerated.result;
    }
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
  // A restructure the athlete asked for in their own words (the chat hand-off, or the
  // same instruction typed into the evolve field). Their ask is an explicit request
  // whichever caller routed it — the producer that drafted it (evolveProgram) passes no
  // input here, so the provenance is read off the proposal itself.
  const athleteAsked = shape.kind === "training_structure" && isAthleteRequestedRestructure(proposal);
  const explicitRequest = !!input.explicit_user_request || athleteAsked;
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
    // The athlete's own request is their decision, not a coach surprise: the veto-rate
    // demotion never turns it into a heads-up. Live, a chat "rebuild today's session"
    // was announced for the next boundary on a demoted domain, went stale there, and
    // was set aside without the athlete ever hearing why.
    explicit_user_request: explicitRequest,
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
    // A plan draft the volume check could not repair says WHICH groups it would leave
    // under their weekly floor, instead of the generic refused-floor line.
    const volumeReason = code === "safety_floor" ? volumeFloorHoldReason(proposal) : null;
    return holdProposalForReview(proposal, shape, {
      code,
      reasons: volumeReason
        ? [volumeReason]
        : policy.reasons.length
          ? policy.reasons
          : ["This change was explicitly routed for review."],
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
    !!input.safety_response || explicitRequest || routineChange
  );
  if (policy.tier === "announce" || surpriseBudgetSpent) {
    // The week boundary protects a week the athlete did not ask to have rewritten. A
    // change they DID ask for in their own words lands at THEIR boundary — today, or
    // tomorrow if training is already logged today (athleteRestructureLandingDate).
    // That used to read `athleteAsked`, which is the restructure-only flag, so a direct
    // same-day chat instruction that reached this branch for any other reason was
    // pushed to the next Monday: a change the athlete asked for, on a day they did not.
    const effectiveDate = explicitRequest ? athleteRestructureLandingDate() : nextBoundary(shape.kind);
    // Scoped to today and unable to land today: stop, rather than re-aim it at a day
    // whose premise nobody has agreed to.
    if (input.today_scoped && effectiveDate !== localDateISO()) {
      return holdTodayScopedProposal(proposal, shape, effectiveDate);
    }
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
        // Carried to the boundary pass, which has no caller input of its own: an
        // athlete's request is exempt from the budget there too, and its evidence
        // drift is answered by a rebuild rather than a hold.
        explicit_user_request: explicitRequest,
        athlete_requested_restructure: athleteAsked,
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
    if (input.today_scoped && effectiveDate !== localDateISO()) {
      return holdTodayScopedProposal(proposal, shape, effectiveDate);
    }
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
    const applied = withSqliteSavepoint(`autonomy_apply_${proposalId}`, () => {
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
    // This is the IMMEDIATE apply path (Plan tab, MCP `apply_proposal`, the orphan
    // sweep) — unlike the scheduled/announced path above, there is no later boundary
    // to land at: the change lands right now, so "today" is unconditionally the
    // landing date. Today's prepared session is a snapshot; without this it can keep
    // showing a plan day this apply just replaced. Fail-soft and after the savepoint
    // commits, same as the scheduled path: the plan write already succeeded and must
    // never be undone by a refresh, and `refreshTodayAfterPlanLanding` itself already
    // swallows its own failures.
    if ((applied as any)?.ok && shape.domain === "training") {
      refreshTodayAfterPlanLanding(proposal, localDateISO());
    }
    return applied;
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

// Retired with the plan's run rows (migration 110): the week's runs are computed live
// by weeklyRunPlan from the stated run days, so there is no proposal to route.
// buildRunPlanProposal answers the designed {ok:false}; the shape stays for the REST
// route and MCP tool that still call it.
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

// ---- THE SWEEP'S INPUT SIGNATURE ----
//
// `adoptOrphanedDrafts` is polled every minute forever, and on an idle Pi it re-reads a
// hundred rows and can re-run a 42-day evidence capture to reach the same answer it
// reached a minute ago. This is the cheap "could the answer have moved?" question, in the
// exact shape `training-cache.ts` established for the read memos: COUNT + MAX(rowid) of
// the two tables the sweep reads (catches inserts and deletes), a TEMP AFTER-UPDATE
// odometer over the same two (catches an in-place status flip — a draft applied, a
// decision canceled, which counts and maxima are blind to), and `lead_mode`, the one
// setting that changes what the sweep is allowed to do.
//
// Used in two places: the scheduler gates the whole sweep on it, and a draft whose
// adoption was REFUSED records it, so the refusal is not re-derived until an input moves.
// A failure yields a never-matching key — sweep rather than risk skipping real work.
const ORPHAN_SWEEP_TABLES = ["plan_proposals", "brain_decisions"] as const;
const ORPHAN_SWEEP_UPDATE_TABLE = "_cairn_orphan_sweep_updates";
let orphanSweepStatements: { counts: ReturnType<typeof db.prepare>; updates: ReturnType<typeof db.prepare> } | null =
  null;

// Prepared LAZILY, like the training-cache backstop: db.ts creates these tables on import,
// so a statement naming them must not compile before they exist.
function orphanSweepPrepared(): { counts: ReturnType<typeof db.prepare>; updates: ReturnType<typeof db.prepare> } {
  if (!orphanSweepStatements) {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${ORPHAN_SWEEP_UPDATE_TABLE} (n INTEGER NOT NULL)`);
    const seeded = db.prepare(`SELECT COUNT(*) AS c FROM ${ORPHAN_SWEEP_UPDATE_TABLE}`).get() as any;
    if (!seeded?.c) db.exec(`INSERT INTO ${ORPHAN_SWEEP_UPDATE_TABLE} (n) VALUES (0)`);
    for (const t of ORPHAN_SWEEP_TABLES) {
      db.exec(
        // STATUS transitions only. The sweep itself writes a receipt into a decision's
        // context (below), and a blanket AFTER UPDATE would count that write — the
        // signature would move every time the sweep ran, so a stamped refusal could never
        // match and the whole gate would be self-defeating. A status flip is the in-place
        // change the sweep actually cares about (a draft applied or superseded, a decision
        // canceled or observed); the 10-minute cadence in the scheduler is the backstop
        // for anything neither counts nor status can see.
        `CREATE TEMP TRIGGER IF NOT EXISTS _cairn_orphan_sweep_u_${t} AFTER UPDATE ON ${t}
         WHEN OLD.status IS NOT NEW.status
         BEGIN UPDATE ${ORPHAN_SWEEP_UPDATE_TABLE} SET n = n + 1; END`
      );
    }
    orphanSweepStatements = {
      counts: db.prepare(
        `SELECT ${ORPHAN_SWEEP_TABLES.map(
          (t, i) => `(SELECT COUNT(*) FROM ${t}) AS c${i}, (SELECT COALESCE(MAX(rowid),0) FROM ${t}) AS m${i}`
        ).join(", ")}`
      ),
      updates: db.prepare(`SELECT n FROM ${ORPHAN_SWEEP_UPDATE_TABLE}`),
    };
  }
  return orphanSweepStatements;
}

export function orphanSweepSignature(leadMode?: string): string {
  try {
    const prepared = orphanSweepPrepared();
    const updates = (prepared.updates.get() as any)?.n;
    if (updates == null) return `nosweep:${Math.random()}`;
    const counts = Object.values(prepared.counts.get() as Record<string, number>).join(",");
    return `${counts}|${updates}|${leadMode ?? getSettings().lead_mode}`;
  } catch {
    // A TEMP odometer is transactional: one created inside a transaction that later rolled
    // back is gone, and the prepared statements cached above then point at nothing. Drop
    // them so the next call reinstalls the odometer instead of sweeping forever.
    orphanSweepStatements = null;
    return `nosweep:${Math.random()}`; // never-matching: sweep rather than skip real work
  }
}

/**
 * FNV-1a over a signature string, so a long backstop key can ride inside a persisted
 * ledger receipt without bloating it. Compared for equality only — never decoded, and
 * never a security boundary.
 */
function hashSignature(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// The temp odometer and the prepared statements survive `test/_isolate.mjs`'s out-of-band
// table wipe, but the counts do not — and two wiped tests could otherwise land on the same
// signature. Dropping the prepared handles on the same reset the read memos use keeps a
// stamped refusal from one test invisible to the next.
registerTrainingCacheClear(() => {
  orphanSweepStatements = null;
});

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
type CairnLeadModeValue = ReturnType<typeof getSettings>["lead_mode"];

function reofferParkedAdvisory(
  decision: ParkedDecision,
  context: Record<string, any>,
  leadMode: CairnLeadModeValue
): boolean {
  // The same deterministic floor the sweep gates on: a conductor's bare
  // `risk_class:'clinical'` with nothing clinical in the text reads as moderate here,
  // or the advisory would pin at clinician forever and never re-file.
  const onFloor = clinicianFloorHolds(decision);
  const policy = decideAutonomyTier({
    kind: decision.kind,
    risk_class: onFloor ? "clinical" : decision.risk_class === "clinical" ? "moderate" : decision.risk_class,
    reversible: true,
    lead_mode: leadMode,
    clinical: onFloor,
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
  if (decisionWasTheAthletesRequest(decision)) {
    tellAthleteTheirRequestDidNotLand(
      decision,
      freshness.status === "changed"
        ? `Your ${changed || "training"} picture moved after you asked, so it no longer fit the plan as it stands.`
        : "It was drafted without a record of the plan it was written against, so I couldn't safely lay it on the plan you have now."
    );
  }
}

/**
 * The SAME receipt the thaw writes, for the boundary's own terminal retire endings.
 *
 * The age ceiling leaves its decision at `rejected`, and no athlete-facing list reads
 * that status (the ledger reads announced|pending|review|observed|applied) — so a draft
 * the athlete had been told about simply stopped existing, with nothing anywhere saying
 * why. The rejection stays put as the machine record; this superseded row is the part a
 * person can read.
 */
function recordRetiredDraftReceipt(args: {
  shape: { kind: string; domain: BrainDomain; risk: any };
  outcome: "stale_proposal" | "stale_plan" | "premise_gone" | "source_superseded" | "apply_refused";
  why: string;
  source: string;
  sourceRefType: "plan_proposal" | "meal_plan";
  sourceRefKey: string | number;
  reviewDecisionId: number | null;
  action: Record<string, any>;
}): void {
  try {
    recordDecision({
      effective_date: localDateISO(),
      kind: args.shape.kind as any,
      domain: args.shape.domain,
      summary: "A held draft was set aside instead of applied.",
      rationale: `${args.why} Nothing changed; a fresh read can pick this up from where you are now.`.slice(0, 1_500),
      source: args.source || "autonomy",
      source_ref_type: args.sourceRefType,
      source_ref_key: String(args.sourceRefKey),
      status: "superseded",
      autonomy_tier: "ask",
      risk_class: args.shape.risk,
      reversible: false,
      input_fingerprint: null,
      context: {
        thaw_receipt: true,
        review_reason_code: args.outcome,
        superseded_review_decision_id: args.reviewDecisionId,
      },
      action: args.action,
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
  } catch (err) {
    // The receipt is the athlete-facing half; losing it must not abort the sweep.
    recordAsyncFailure("apply", "retire_draft_receipt", err);
  }
}

// ---- THE ATHLETE'S OWN REQUEST IS ANSWERED, NEVER SILENTLY SET ASIDE --------------
//
// A change the athlete asked for in their own words (a chat plan edit, their own
// restructure) is THEIR decision. When one cannot land — the plan moved under it past
// what a rebuild can answer, an apply refused it, it waited past its ceiling — the
// ending used to be a `superseded` ledger row no athlete surface reads: live, a chat
// "rebuild today's session" was held, then set aside at the next 04:00 sweep, and nobody
// told the person who asked. So every such ending also answers them, in chat, once, in
// plain words — pull-only (it waits in the conversation, never a notification).
function decisionWasTheAthletesRequest(decision: { context?: unknown } | null | undefined): boolean {
  const context = (decision?.context ?? {}) as Record<string, any>;
  // A legacy background-chat draft the orphan sweep adopted is routed with the explicit
  // flag for its boundary, but it was the coach reading a chat signal — not the athlete's
  // own words — so its endings are ledger receipts, not chat replies.
  if (context.orphan_sibling_cleanup?.provenance === "background_chat") return false;
  return context.explicit_user_request === true || context.athlete_requested_restructure === true;
}

function tellAthleteTheirRequestDidNotLand(
  decision: { id?: number | null; summary?: unknown; action?: unknown } | null | undefined,
  why: string
): void {
  try {
    const id = Number(decision?.id);
    if (!(id > 0)) return;
    const fresh = getBrainDecision(id) ?? decision;
    const context = ((fresh as any)?.context ?? {}) as Record<string, any>;
    // Once per request: every later sweep that walks the same row stays quiet.
    if (context.athlete_told_at) return;
    const asked = String((fresh as any)?.summary ?? "")
      .trim()
      .replace(/[.!\s]+$/, "")
      .slice(0, 200);
    const text = `${asked ? `The change you asked for — ${asked} — didn't land.` : "A change you asked for didn't land."} ${why.trim()} Nothing on your plan changed from it; ask again and I'll build it from where you are now.`;
    addChatMessage("assistant", text, null, {
      kind: "request_outcome",
      decision_id: id,
      proposal_id: Number(((fresh as any)?.action as any)?.proposal_id) || null,
    });
    patchBrainDecision(id, {
      context: { ...context, athlete_told_at: new Date().toISOString(), athlete_told: text.slice(0, 700) },
    });
  } catch (err) {
    // The chat line is the athlete-facing half; losing it must never abort a sweep.
    recordAsyncFailure("apply", "tell_athlete_request_outcome", err);
  }
}

// The plan refused a held or scheduled change. Retire the draft (so no sweep re-offers
// the same refusal), close the decision with the reason on it, file the readable receipt
// and — when the change was the athlete's own request — answer them in chat. False when
// the retirement itself failed; the caller then parks the decision exactly as before, so
// nothing is lost.
function retireRefusedDraft(decision: ParkedDecision, proposalId: number, reason: string): boolean {
  try {
    const proposal = getProposal(proposalId);
    if (proposal?.status === "draft") setProposalStatus(proposalId, "superseded", { recordDecision: false });
    patchBrainDecision(Number(decision.id), {
      status: "rejected",
      reversible: false,
      context: {
        ...((decision.context ?? {}) as Record<string, any>),
        review_required: false,
        apply_error: reason.slice(0, 300),
        boundary_outcome: "apply_threw",
        athlete_request_refused: decisionWasTheAthletesRequest(decision),
      },
    });
    const shape = proposal
      ? proposalShape(proposal)
      : { kind: decision.kind, domain: decision.domain, risk: decision.risk_class };
    recordRetiredDraftReceipt({
      shape: shape as any,
      outcome: "apply_refused",
      why: `The plan refused this change: ${plainApplyRefusal(reason)}`,
      source: proposal?.agent || decision.source || "autonomy",
      sourceRefType: "plan_proposal",
      sourceRefKey: proposalId,
      reviewDecisionId: decision.id ?? null,
      action: { proposal_id: proposalId, outcome: "refused_by_plan", apply_error: reason.slice(0, 300) },
    });
    if (decisionWasTheAthletesRequest(decision))
      tellAthleteTheirRequestDidNotLand(decision, `The plan refused it: ${plainApplyRefusal(reason)}`);
    return true;
  } catch (err) {
    recordAsyncFailure("apply", "retire_refused_athlete_request", err);
    return false;
  }
}

// An apply error in words a person can read: the plan-quality prefix is dropped (the
// messages behind it are already sentences), and a bare machine error is not repeated.
function plainApplyRefusal(reason: string): string {
  const text = String(reason ?? "")
    .replace(/^Plan quality check failed:\s*/i, "")
    .trim();
  if (!text || /^(?:Error|TypeError|SqliteError)\b|\bproposal \d+\b/i.test(text))
    return "it no longer fit the plan as it stands.";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * Retire ONE draft whose premise has left the plan, with the receipt a person can read.
 *
 * The receipt is written first, then `setProposalStatus(…, 'superseded')` retires the
 * draft AND every live `review` hold pointing at it in the same authoritative call
 * (`recordDecision:false` — the specific receipt is already filed, so the generic status
 * row would be a vaguer second one beside it). The holds are stamped BEFORE that
 * transition, so each retired row carries why it stopped asking.
 */
function retireDraftWithDeadPremise(proposal: any, missing: string[]): void {
  const shape = proposalShape(proposal);
  const movements = missing.join(" and ");
  const why =
    missing.length === 1
      ? `${movements} is no longer in your plan, so this change has nothing left to act on.`
      : `${movements} are no longer in your plan, so this change has nothing left to act on.`;
  const holds = liveReviewHoldsForProposal(Number(proposal.id));
  for (const hold of holds) {
    patchBrainDecision(Number(hold.id), {
      context: {
        ...((hold.context ?? {}) as Record<string, any>),
        review_required: false,
        retire_reason: "premise_gone",
        retired_movements: missing,
        retired_explanation: why,
      },
    });
  }
  recordRetiredDraftReceipt({
    shape,
    outcome: "premise_gone",
    why,
    source: proposal.agent || "autonomy",
    sourceRefType: "plan_proposal",
    sourceRefKey: Number(proposal.id),
    reviewDecisionId: holds[0]?.id ?? null,
    action: {
      proposal_id: proposal.id,
      outcome: "superseded_premise_gone",
      missing_movements: missing,
      reason_provenance: proposalReasonProvenance(proposal),
    },
  });
  setProposalStatus(Number(proposal.id), "superseded", { recordDecision: false });
}

/**
 * The premise pass, run ahead of the thaw and the adoption loop on the same sweep.
 *
 * Deliberately NOT gated on lead_mode. Retiring a dead premise adopts nothing and sets
 * no live question aside — it closes one that no longer has a subject — so the
 * review_everything floor the thaw honours does not apply: an athlete who asked to see
 * everything is owed a queue of real questions, not a lift their plan no longer carries.
 *
 * Gated on the SAME grace window adoption honours: a draft written minutes ago is still
 * in the conversation that produced it, and pulling it out from under the athlete would
 * be the surprise this whole layer exists to avoid.
 */
function retireDraftsWithDeadPremise(now = Date.now()): number {
  let retired = 0;
  // The newest drafts (the same window adoption walks) PLUS every draft currently behind
  // an open review row, whatever its age. The two are not the same set: a hold parked
  // months ago sits behind a proposal long since pushed out of the newest-50 window, and
  // that is exactly the row a person is still being asked about.
  const seen = new Set<number>();
  const candidates = [...(listProposals(50) as any[]), ...(listReviewHeldProposals(50) as any[])];
  for (const proposal of candidates) {
    try {
      if (proposal?.status !== "draft") continue;
      if (seen.has(Number(proposal.id))) continue;
      seen.add(Number(proposal.id));
      const createdAt = parseDbTime(proposal.created_at)?.getTime() ?? Number.NaN;
      if (!Number.isFinite(createdAt) || now - createdAt < ORPHAN_ADOPTION_GRACE_MS) continue;
      const missing = proposalPremiseGone(proposal);
      if (!missing) continue;
      retireDraftWithDeadPremise(proposal, missing);
      retired += 1;
    } catch (err) {
      // Per-draft isolation: one unreadable payload must never break the sweep.
      recordAsyncFailure("apply", "retire_dead_premise_draft", err);
    }
  }
  return retired;
}

// ---- A QUESTION OUTLIVES THE DRAFT IT ASKED ABOUT BY ONE SWEEP -----------------
//
// A review hold is a question about ONE stored draft: apply this meal-plan week, or land
// this plan change. Retire that draft and the question has no subject left — answering it
// either way does nothing. Example: brain_decisions 4088 asked about meal_plans 20 for four
// weeks after `acceptMealPlan` had superseded it in favour of a newer week, because every
// pass that walks review rows had a reason to leave it alone: the thaw skips a row
// carrying a pending change (`carriesPendingChange`, so a parked apply_error is never
// observed away), and the premise pass above reads plan_proposals exercise targets only.
//
// So this pass asks the one question none of them ask — is the draft behind this hold
// still live? — and closes the hold when it is not. It NEVER touches a source row: the
// source has already ended, which is the whole trigger. It only stops asking.
//
// The live statuses are `draft` and nothing else, for BOTH tables. That is the same
// reading the boundary applier takes when a due decision finds its meal plan
// (`plan.status !== "draft"` → `canceled_moot`) and the same one the thaw takes for a
// proposal: a week that has been accepted, applied, kept, discarded or superseded is a
// week that is no longer waiting on an answer.
const LIVE_DRAFT_SOURCE_STATUSES = new Set(["draft"]);

type RetiredHoldSource = { ref_type: "meal_plan" | "plan_proposal"; id: number; status: string };

// BOTH ways a hold names its draft, the same pair the thaw resolves a proposal id from:
// the source ref, and the action payload the boundary applier writes.
function holdDraftSource(decision: ParkedDecision): RetiredHoldSource | null {
  const action = (decision.action ?? {}) as Record<string, any>;
  // A structure request carries no source ref and names no draft — it is the athlete's
  // own standing ask, owned by retireAnsweredStructureRequests, and never touched here.
  if (decision.source_ref_type !== "meal_plan" && decision.source_ref_type !== "plan_proposal") return null;
  const refType = decision.source_ref_type;
  const id =
    Number(decision.source_ref_key) || Number(refType === "meal_plan" ? action.meal_plan_id : action.proposal_id) || 0;
  if (!(id > 0)) return null;
  const status = refType === "meal_plan" ? mealPlanStatus(id) : proposalStatus(id);
  // A source row that is not there says nothing about what happened to it. Absence is
  // never the evidence that closes a question — the same rule the premise pass applies
  // to an empty plan.
  if (status == null || !status) return null;
  return { ref_type: refType, id, status };
}

// What a person reads on the closed row, off the status the source actually reached.
// Calm and past-tense: this reports something that already happened elsewhere, and asks
// for nothing.
function retiredSourceReading(source: RetiredHoldSource): string {
  if (source.ref_type === "meal_plan") {
    if (source.status === "superseded")
      return "A newer meal plan has since been accepted, so this one has nothing left to decide.";
    if (source.status === "discarded" || source.status === "rejected")
      return "This meal plan was set aside, so there is nothing left to decide.";
    return "This meal plan is already the week you are on, so there is nothing left to decide.";
  }
  if (source.status === "applied") return "This change has already landed, so there is nothing left to decide.";
  if (source.status === "superseded")
    return "A newer draft has since taken this one's place, so there is nothing left to decide.";
  return "This draft was set aside, so there is nothing left to decide.";
}

/**
 * Close ONE hold whose draft has ended, with the receipt a person can read.
 *
 * Same order as the premise-gone path: the hold is stamped with why it stopped asking
 * FIRST (while it is still a `review` row), then the receipt is filed, then the hold is
 * transitioned. `superseded_by` points at the decision that applied a LATER row of the
 * same source table when there is one — for the live case, the decision that accepted the
 * newer meal-plan week — so the closed row says what took its place, not merely that it
 * closed.
 */
function retireHoldWithEndedSource(decision: ParkedDecision, source: RetiredHoldSource): void {
  const why = retiredSourceReading(source);
  const successor = appliedDecisionForNewerSource(source.ref_type, source.id);
  patchBrainDecision(Number(decision.id), {
    context: {
      ...((decision.context ?? {}) as Record<string, any>),
      review_required: false,
      retire_reason: "source_superseded",
      retired_source_status: source.status,
      retired_explanation: why,
    },
  });
  recordRetiredDraftReceipt({
    shape: { kind: decision.kind, domain: decision.domain, risk: decision.risk_class },
    outcome: "source_superseded",
    why,
    source: decision.source || "autonomy",
    sourceRefType: source.ref_type,
    sourceRefKey: source.id,
    reviewDecisionId: decision.id ?? null,
    action: {
      ...(source.ref_type === "meal_plan" ? { meal_plan_id: source.id } : { proposal_id: source.id }),
      outcome: "closed_source_superseded",
      source_status: source.status,
      superseded_by_decision_id: successor?.id ?? null,
    },
  });
  transitionBrainDecision(Number(decision.id), "superseded", { supersededBy: successor?.id ?? null });
}

/**
 * The ended-source pass, run ahead of the thaw on the same sweep.
 *
 * Deliberately NOT gated on lead_mode, and deliberately NOT gated on the thaw's floors,
 * for the same reason the premise pass is not: closing a question whose subject has ended
 * decides nothing on the athlete's behalf. An athlete who asked to see everything is owed
 * a queue of real questions, and a clinician floor exists to keep a clinical CHANGE from
 * landing without a person — there is no change here left to land.
 *
 * No grace window either: unlike a fresh draft, the trigger is a transition that has
 * already happened to the source row, so there is nothing still in flight to surprise.
 */
function retireHoldsWithEndedSource(): number {
  let retired = 0;
  for (const decision of listDraftBackedReviewDecisions()) {
    try {
      if (decision.id == null) continue;
      const source = holdDraftSource(decision);
      if (!source || LIVE_DRAFT_SOURCE_STATUSES.has(source.status)) continue;
      retireHoldWithEndedSource(decision, source);
      retired += 1;
    } catch (err) {
      // Per-row isolation: one unreadable hold must never break the sweep.
      recordAsyncFailure("apply", "retire_hold_ended_source", err);
    }
  }
  return retired;
}

// ---- THE CLINICAL HALF OF A CONFERENCE BUNDLE --------------------------------------
//
// A conference is routed action by action (2026-09-25 ruling): the clinician floor is
// judged on its executable revision alone, and a clinical sentence elsewhere in the
// bundle — a medication, a referral, a clinical test — is filed for the athlete AND THEIR
// DOCTOR as its own `observed` row at the clinician tier: information to take to a visit,
// nothing to approve, nothing held behind it (awaitingBrainDecisions lists it as
// `for_clinician`). The ledger fingerprint covers the notes, so the same sentence from
// next week's conference folds into the existing row instead of stacking a second one.
export function conferenceClinicianNotes(lines: readonly unknown[]): string[] {
  return [
    ...new Set(lines.map((line) => String(line ?? "").trim()).filter((line) => line && clinicianNoteText(line))),
  ].slice(0, 6);
}

export function recordConferenceClinicianNotes(
  notes: readonly string[],
  input: { rationale?: string | null; conference_decision_id?: number | null; snapshot_id?: string | null }
): void {
  if (!notes.length) return;
  try {
    recordDecision({
      effective_date: null,
      kind: "case_conference",
      domain: "health",
      summary: notes[0].slice(0, 300),
      rationale: input.rationale ?? null,
      source: "case_conference",
      source_ref_type: null,
      source_ref_key: null,
      status: "observed",
      autonomy_tier: "clinician",
      risk_class: "clinical",
      reversible: true,
      input_fingerprint: null,
      context: {
        snapshot_id: input.snapshot_id ?? null,
        for_clinician: true,
        deterministic_clinical: true,
        advisory_only: true,
        conference_decision_id: input.conference_decision_id ?? null,
      },
      action: { user_explanation: notes.join(" ").slice(0, 700), clinician_notes: [...notes] },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
  } catch (err) {
    // The note is the informational half; losing it must never undo the decision beside it.
    recordAsyncFailure("apply", "conference_clinician_note", err);
  }
}

// The thaw's own version: a row stamped by an older pass gets one read by this one.
const THAW_PASS_VERSION = 2;

// The one-off re-read of a conference-marked clinician floor (see the thaw). Versioned so
// a later rule change can re-read again without a migration.
const CONFERENCE_FLOOR_REREAD_VERSION = 1;

function conferenceFloorNeedsReread(decision: ParkedDecision, context: Record<string, any>, proposal: any): boolean {
  if (String(decision.source ?? "") !== "case_conference") return false;
  if (context.user_locked === true) return false;
  if (Number(context.floor_reread?.version) >= CONFERENCE_FLOOR_REREAD_VERSION) return false;
  // A clinical mark the CHAT detector put on the athlete's own words is not the
  // conference's to re-read.
  if (serverClinicalProvenance(proposal?.parsed?.clinical_provenance) !== null) return false;
  return clinicianFloorHolds(decision);
}

function defaultConflictInputsToday(): ConferenceConflictInputs {
  const on = localDateISO();
  let symptomAreas: string[] | null = null;
  try {
    symptomAreas = listTrainingSymptoms({ on, include_resolved: false, seed_legacy: false })
      .filter((event) => event.status === "active" && event.scope !== "systemic" && !event.legacy_unconfirmed)
      .map((event) => event.area_text);
  } catch {
    symptomAreas = null;
  }
  return conferenceConflictInputs(getCoachContext(), { activeSymptomAreas: symptomAreas });
}

// A parked conference reading with no live change behind it, re-filed as what it is: an
// observation. Its clinical sentences (if any) become the athlete-and-doctor note; the
// rest is the ordinary reading. Returns false only when the write failed.
function refileParkedConferenceAdvice(
  decision: ParkedDecision,
  context: Record<string, any>,
  leadMode: CairnLeadModeValue
): boolean {
  const action = (decision.action ?? {}) as Record<string, any>;
  const notes = conferenceClinicianNotes([
    decision.summary,
    ...(Array.isArray(action.parallel_actions) ? action.parallel_actions : []),
  ]);
  const policy = decideAutonomyTier({
    kind: decision.kind,
    risk_class: decision.risk_class === "clinical" ? "moderate" : decision.risk_class,
    reversible: true,
    lead_mode: leadMode,
  });
  const refiled = patchBrainDecision(decision.id!, {
    status: "observed",
    autonomy_tier: leadModelCeiling(policy.tier, leadMode),
    risk_class: decision.risk_class === "clinical" ? "moderate" : decision.risk_class,
    context: {
      ...context,
      review_required: false,
      thaw_outcome: "observed",
      thaw_reasons: ["advice changes nothing, so it never waits on the athlete"],
      deterministic_clinical: false,
      floor_reread: {
        version: CONFERENCE_FLOOR_REREAD_VERSION,
        at: new Date().toISOString(),
        clinical: false,
        advisory: true,
        was_tier: decision.autonomy_tier ?? null,
        was_deterministic_clinical: context.deterministic_clinical ?? null,
      },
    },
  });
  if (!refiled) return false;
  recordConferenceClinicianNotes(notes, {
    rationale: decision.rationale ?? null,
    conference_decision_id: decision.id ?? null,
  });
  return true;
}

// A held draft past its age ceiling, set aside with the receipt a person can read — and,
// when it was the athlete's own request, an answer in chat.
function setAsideAgedDraftOnThaw(proposal: any, decision: ParkedDecision, ceilingDays: number): void {
  const shape = proposalShape(proposal);
  recordRetiredDraftReceipt({
    shape,
    outcome: "stale_proposal",
    why: `This draft waited more than ${ceilingDays} days, so it no longer describes where you are.`,
    source: proposal.agent || "autonomy",
    sourceRefType: "plan_proposal",
    sourceRefKey: Number(proposal.id),
    reviewDecisionId: decision.id ?? null,
    action: {
      proposal_id: proposal.id,
      outcome: "superseded_stale_proposal",
      reason_provenance: proposalReasonProvenance(proposal),
    },
  });
  // Retires the draft AND every live review hold pointing at it.
  setProposalStatus(Number(proposal.id), "superseded");
  if (decisionWasTheAthletesRequest(decision)) {
    tellAthleteTheirRequestDidNotLand(
      decision,
      `It waited more than ${ceilingDays} days for its day, so it no longer described your week.`
    );
  }
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
export interface ThawDeps {
  /** Today's conflict question sheet, for re-reading a conference-marked clinician floor.
   * Defaults to the full coach context; injectable for tests. Read at most once a sweep. */
  conflictInputs?: () => ConferenceConflictInputs | null;
}

export function thawParkedReviewDecisions(
  // Read ONCE per sweep by the caller and threaded down, not re-read per decision: this
  // walks up to 100 rows a tick and `reofferParkedAdvisory` asked for the same row each time.
  leadMode: CairnLeadModeValue = getSettings().lead_mode,
  deps: ThawDeps = {}
): { thawed: number; superseded: number; skipped: number } {
  let thawed = 0;
  let superseded = 0;
  let skipped = 0;
  if (leadMode === "review_everything") return { thawed, superseded, skipped };
  // Built lazily and once: only a conference-marked floor row ever needs it.
  let todaysInputs: ConferenceConflictInputs | null | undefined;
  const conflictInputsToday = (): ConferenceConflictInputs | null => {
    if (todaysInputs === undefined) {
      try {
        todaysInputs = (deps.conflictInputs ?? defaultConflictInputsToday)();
      } catch {
        todaysInputs = null;
      }
    }
    return todaysInputs;
  };
  for (const listed of listBrainDecisions({ status: "review", limit: 100 })) {
    let decision = listed;
    try {
      let context = (decision.context ?? {}) as Record<string, any>;
      const proposalId =
        Number((decision.action as any)?.proposal_id) ||
        (decision.source_ref_type === "plan_proposal" ? Number(decision.source_ref_key) : 0);
      const proposal = proposalId > 0 ? getProposal(proposalId) : null;
      // ADVICE NEVER WAITS ON THE ATHLETE (lead, 2026-09-25 ruling). A case conference
      // parked with no live draft behind it changes nothing, so there is nothing on it
      // to approve — yet live, a whole bundle of ordinary coaching (a calorie hold, a
      // protein target, a run ceiling) sat at the clinician tier for days because an
      // older rule read the act-now lipid finding as a floor over advice. It is re-filed
      // as `observed`; any clinical sentence in it goes to the athlete and their doctor as
      // its own note. Ahead of the thaw_attempted and floor skips on purpose: those are
      // exactly what kept it parked.
      if (
        leadMode === "lead" &&
        decision.kind === "case_conference" &&
        proposal?.status !== "draft" &&
        !carriesPendingChange(decision.action) &&
        !liveStructureBuild(decision) &&
        context.user_locked !== true
      ) {
        if (refileParkedConferenceAdvice(decision, context, leadMode)) thawed += 1;
        else skipped += 1;
        continue;
      }
      // A CONFERENCE-MARKED FLOOR IS RE-READ BY TODAY'S RULE, once. A held revision the
      // conference put on the clinician floor under an older rule (co-occurrence, or a
      // clinical sentence elsewhere in the bundle) is judged again by
      // revisionHoldsClinicalFloor against today's findings. Still clinical: it stays,
      // stamped. Not clinical: the older rule's marks are lifted and the hold is re-offered
      // below like any other. A chat-detected clinical request is never re-read here.
      if (proposal?.status === "draft" && conferenceFloorNeedsReread(decision, context, proposal)) {
        const revision = revisionFromProposalPayload(proposal.parsed);
        const inputs = revision ? conflictInputsToday() : null;
        if (!inputs || !revision) {
          skipped += 1;
          continue;
        }
        const reread = { version: CONFERENCE_FLOOR_REREAD_VERSION, at: new Date().toISOString() };
        if (revisionHoldsClinicalFloor(inputs, revision)) {
          patchBrainDecision(decision.id!, { context: { ...context, floor_reread: { ...reread, clinical: true } } });
          skipped += 1;
          continue;
        }
        decision =
          patchBrainDecision(decision.id!, {
            autonomy_tier: "ask",
            risk_class: "moderate",
            context: {
              ...context,
              clinical: false,
              deterministic_clinical: false,
              policy_inputs: { ...((context.policy_inputs ?? {}) as Record<string, any>), clinical: false },
              review_reason_code: "floor_reread",
              // A stamp an older pass carried onto this row must not stop the one
              // re-offer the lifted floor is owed.
              thaw_attempted: false,
              floor_reread: { ...reread, clinical: false, lifted_reason_code: context.review_reason_code ?? null },
            },
          }) ?? decision;
        context = (decision.context ?? {}) as Record<string, any>;
      }
      // Once per decision PER THAW PASS VERSION. A row an older pass stamped was re-offered
      // into endings that could re-hold it under its own stamp (an aged draft re-held as a
      // stale ask) and so never be read again; this pass has terminal endings for those
      // (the age set-aside, the refused-draft retirement), so every such row is owed ONE
      // more read by it — the built-in re-evaluation of what older passes left parked.
      if (context.thaw_attempted === true && Number(context.thaw_pass ?? 1) >= THAW_PASS_VERSION) {
        skipped += 1;
        continue;
      }
      // The clinician floor is DETERMINISTIC (clinicianFloorHolds): a row the server
      // itself marked clinical stays untouched. A row at the clinician tier only because
      // a specialist opinion or the conductor's own risk_class said so is not on the
      // floor — it is re-read by policy below like any other hold, which is how a
      // hill-repeat stand-down stops waiting for a clinician who is not in the loop.
      if (
        clinicianFloorHolds(decision) ||
        context.user_locked === true ||
        THAW_FLOOR_REASON_CODES.has(String(context.review_reason_code ?? "")) ||
        // A conference hold over a SAFETY conflict it could not close (a hurt part under
        // load, an allergy, a medication meeting a supplement) is a floor, whatever code an
        // older writer stamped on it — re-offering it would land exactly that change.
        (Array.isArray(context.unresolved_conflicts) &&
          context.unresolved_conflicts.some((key: unknown) => conflictIsSafetyFloor(String(key) as any)))
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
      // A chat structure REQUEST whose build job is still queued or running is not an
      // advisory to re-file: the coach is mid-way through drafting the change, and the
      // request row is superseded by that change the moment the job settles. Re-offering
      // it here used to turn the athlete's ask into an `observed` reading before the
      // build had a chance to finish. Untouched, not stamped — the next tick re-reads it.
      if (liveStructureBuild(decision)) {
        skipped += 1;
        continue;
      }
      // THE CONFERENCE DOOR. A case_conference revision held with a LIVE DRAFT behind it
      // is a question the conductor put to the athlete and is waiting on
      // (docs/ELITE-BRAIN-IMPLEMENTATION.md). The sweep may not answer it for them — not
      // by re-offering the draft into the autonomy ledger, not by setting it aside, not
      // even by stamping the decision, which would be churn on a row the athlete has not
      // touched. An ADVISORY conference (no draft behind it) is untouched by this and
      // still thaws to `observed`, per the 2026-08-17 no-parking-above-ask ruling.
      //
      // Under LEAD the door is closed (2026-09-25 ruling): a hold that reached this point
      // is on no floor (the floor skip above already took those), so it is exactly the
      // parked idea Amendment 3 retired, and it is re-offered like any other hold.
      if (leadMode !== "lead" && decision.kind === "case_conference" && proposal?.status === "draft") {
        skipped += 1;
        continue;
      }
      const stamped =
        patchBrainDecision(decision.id!, {
          context: {
            ...context,
            thaw_attempted: true,
            thaw_pass: THAW_PASS_VERSION,
            thaw_attempted_at: new Date().toISOString(),
          },
        }) ?? decision;
      const stampedContext = (stamped.context ?? {}) as Record<string, any>;
      if (!proposal || proposal.status !== "draft") {
        // No live draft behind it: this is a reading, not a pending change.
        if (reofferParkedAdvisory(stamped, stampedContext, leadMode)) thawed += 1;
        else skipped += 1;
        continue;
      }
      const freshness = verifyProposalEvidenceFreshness(proposal.parsed, localDateISO());
      if (freshness.status === "changed" || freshness.status === "unverified") {
        // A producer that can read it again (or a bounded draft only training/context
        // drift made stale) is regenerated once rather than set aside.
        const regenerated = attemptStaleDraftRegeneration(proposal, proposalShape(proposal), {
          freshness,
          aged: false,
          clinical: serverClinicalProvenance(proposal.parsed?.clinical_provenance) !== null,
          asOf: localDateISO(),
          parked: stamped,
          allowRebase: true,
        });
        if (regenerated.regenerated) {
          thawed += 1;
          continue;
        }
        supersedeStaleDraftOnThaw(proposal, stamped, freshness);
        superseded += 1;
        continue;
      }
      // The age ceiling, read HERE rather than left to the re-offer: routed through
      // applyProposalWithAutonomy an aged draft is re-held as a stale ask that carries
      // this very thaw stamp, so no later sweep would ever read it again — a permanent
      // question about a draft too old to apply. A producer that can read it again is
      // regenerated once; anything else is set aside with the receipt.
      const shape = proposalShape(proposal);
      const ceilingDays = shape.kind === "training_structure" ? 14 : 7;
      const createdAt = parseDbTime(proposal.created_at)?.getTime() ?? Number.NaN;
      if (Number.isFinite(createdAt) && (Date.now() - createdAt) / 86_400_000 > ceilingDays) {
        const regenerated = attemptStaleDraftRegeneration(proposal, shape, {
          freshness,
          aged: true,
          clinical: serverClinicalProvenance(proposal.parsed?.clinical_provenance) !== null,
          asOf: localDateISO(),
          parked: stamped,
        });
        if (regenerated.regenerated) {
          thawed += 1;
          continue;
        }
        setAsideAgedDraftOnThaw(proposal, stamped, ceilingDays);
        superseded += 1;
        continue;
      }
      const result = applyProposalWithAutonomy(proposalId, {
        ...(decisionWasTheAthletesRequest(stamped) ? { explicit_user_request: true } : {}),
      });
      if (["pending", "announced", "applied"].includes(String(result?.decision?.status ?? ""))) thawed += 1;
      else if (
        result?.ok === false &&
        !result?.decision &&
        retireRefusedDraft(stamped, proposalId, String(result?.error ?? ""))
      )
        // The plan refused the change outright (the quality check, a movement that is
        // gone). A second identical refusal on every later sweep asks nobody anything;
        // the draft is retired with the reason on its receipt.
        superseded += 1;
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
  /** Drafts retired because the movement they act on has left the plan. */
  retired: number;
  /** Review holds closed because the draft they asked about is no longer live. */
  closed: number;
} {
  // Parked decisions thaw on the same deterministic tick as orphaned drafts, ahead of
  // adoption: a decision re-offered here may retire the very draft the loop below would
  // otherwise walk. Deliberately called from inside this sweep rather than wired into
  // the scheduler separately, so the two can never drift apart in ordering.
  // ONE settings read for the whole sweep — the thaw pass and the adoption loop below
  // both need lead_mode, and it cannot change underneath a synchronous pass.
  const leadMode = getSettings().lead_mode;
  // FIRST of the three, because a draft whose premise has left the plan must not be
  // re-offered by the thaw or re-held by the loop below: both would spend a full
  // evidence capture to reach the same answer, and the loop would record the ask again.
  // Retiring it here leaves its proposal 'superseded' and its holds already closed, so
  // neither pass can see it.
  const retired = retireDraftsWithDeadPremise();
  // SECOND, and before the thaw for the same reason: a hold whose draft has already ended
  // must not be re-offered or re-derived. This one also reaches rows the thaw deliberately
  // leaves alone — a parked apply_error carries a pending change, so the thaw never touches
  // it, and nothing else ever asked whether the change it carries still exists.
  const closed = retireHoldsWithEndedSource();
  const thaw = thawParkedReviewDecisions(leadMode);
  let adopted = 0;
  let skipped = 0;
  const now = Date.now();
  // The receipt stamped onto a REFUSED adoption below (see `adopt_attempted_signature`).
  //
  // orphanSweepSignature covers the DRAFTS and the LEDGER (plan_proposals /
  // brain_decisions counts, status transitions, lead_mode) — but a refusal is a reading
  // of the athlete, not of those two tables. The evidence that most often lifts one lives
  // elsewhere entirely: a logged set that clears a fuel hold, a finished session, a new
  // bodyweight, a plan edit, a goal change. None of that moves the sweep signature, and
  // an hour bucket alone would leave a stale refusal standing for up to an hour after the
  // very evidence that overturns it landed.
  //
  // So the training backstop rides along: the same COUNT + MAX(id) + profile signature the
  // read memos key on, over logged_sets / sessions / activities / bodyweight / daily
  // metrics / the plan, plus the in-process training write counter. A training write
  // therefore RE-OPENS every refused draft on the next sweep. It is hashed only to keep the
  // ledger receipt short — it is compared, never read.
  //
  // Deliberately NOT the coach-context backstop, wide as it is: its odometer counts every
  // UPDATE to brain_decisions, and this sweep's own receipt is such an update — the stamp
  // would move each time it was written and could never match itself.
  //
  // The hour bucket stays as the self-healing floor for what neither signature can see (a
  // decision's context edited in place, a clock-driven input), costing at most one
  // re-derivation an hour rather than one a minute.
  const refusalStamp = `${orphanSweepSignature(leadMode)}|train:${hashSignature(
    trainingBackstopSignature()
  )}|hour:${new Date().toISOString().slice(0, 13)}`;
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
      // `rejected` is terminal in the other direction: a ceiling (the boundary pass's age
      // gate) has already refused this draft once. Re-adopting it would re-announce a
      // change whose next boundary can only refuse it again — the daily-failure loop.
      if (["pending", "announced", "applied", "rejected"].includes(String(proposal.autonomy?.status ?? ""))) {
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
      // A REVIEW hold is deliberately NOT terminal — it is re-offered when posture or
      // policy inputs move. But "re-offered when they move" is not "re-derived every
      // minute": re-deriving it costs a 42-day evidence capture plus a full
      // applyProposalWithAutonomy to reach the same refusal it reached a minute ago. So a
      // refusal records the sweep signature it was made under (below), and while that
      // signature still stands the answer is already known. Any real move — a new proposal
      // or decision row, a status flip, a lead_mode change — changes the signature and the
      // draft is re-offered on the very next sweep, exactly as before. Placed AFTER the
      // intent is claimed above so an older sibling never inherits a shot this draft owns.
      if (String(proposal.autonomy?.status ?? "") === "review") {
        const heldId = Number(proposal.autonomy?.id);
        const heldContext = (heldId > 0 ? (getBrainDecision(heldId)?.context ?? {}) : {}) as Record<string, any>;
        if (heldContext.adopt_attempted_signature === refusalStamp) {
          skipped += 1;
          continue;
        }
      }
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
        // STAMP THE REFUSAL, so the next sweep does not re-derive it from scratch. The
        // signature is the receipt's whole point: it says WHICH picture this answer was
        // given under, so the skip above lifts itself the moment that picture moves.
        // Written into the decision the refusal just recorded — an UPDATE that touches no
        // status, no count and no MAX(rowid), and no table the training backstop watches,
        // so stamping cannot invalidate either half of the signature it stores.
        const heldId = Number((result as any)?.decision?.id);
        if (heldId > 0) {
          const heldContext = (getBrainDecision(heldId)?.context ?? {}) as Record<string, any>;
          patchBrainDecision(heldId, {
            context: {
              ...heldContext,
              adopt_attempted_at: new Date().toISOString(),
              adopt_attempted_signature: refusalStamp,
            },
          });
        }
      }
    } catch {
      // Per-draft error isolation: a throwing adoption must never break the pass.
      skipped += 1;
    }
  }
  return { adopted, skipped, thawed: thaw.thawed, superseded: thaw.superseded, retired, closed };
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

// Which of the two floors regeneration must never cross, read off a decision that is
// already in the queue (the apply-time path knows them from its own inputs). A clinical
// ceiling and a user lock are the athlete's ask, not the system's bookkeeping.
//
// The clinical half is `clinicianFloorHolds` — THE deterministic read, the same one the
// thaw and the parked-advisory re-offer gate on. The loose test it replaces (a bare
// `risk_class:'clinical'` or a bare clinician tier) let a conductor self-attest a
// non-clinical hold onto the floor and so out of regeneration, which is exactly the
// model discretion server-owned autonomy exists to prevent.
function decisionIsTheAthletes(decision: {
  risk_class?: unknown;
  context?: any;
  autonomy_tier?: unknown;
  summary?: unknown;
  rationale?: unknown;
  action?: unknown;
}): {
  clinical: boolean;
  user_locked: boolean;
} {
  const context = (decision.context ?? {}) as Record<string, any>;
  return {
    clinical: clinicianFloorHolds(decision),
    user_locked: context.user_locked === true || context.policy_inputs?.user_locked === true,
  };
}

// WHY A DECISION DID NOT APPLY, AS A TAXONOMY RATHER THAN ONE WORD.
//
// `failed[]` is a single bucket holding six different endings, and the boundary tick
// used to report all of them as one generic `Error`. FOUR of those endings are the
// system working exactly as designed (the athlete moved the goal date themselves; the
// draft was applied or vetoed elsewhere; an age ceiling retired it; the evidence moved
// before the boundary), and reporting them as breakage produced one operator error
// event every single day that nothing could ever act on.
//
// So every non-applying ending names itself. `calm: true` means "this is the designed
// answer, not a defect" — a caller that reports failures records those at most as
// information, and keeps `error` for the endings that really are anomalies (a payload
// that threw, a ledger row pointing at a proposal that no longer exists).
export type BoundaryOutcomeClass =
  /** The change became moot before its boundary: the athlete moved the goal date by hand,
   *  the meal plan is no longer a draft, the proposal was applied/vetoed elsewhere. */
  | "canceled_moot"
  /** A meal plan that waited past its 14-day ceiling. */
  | "stale_plan"
  /** The compare-and-set evidence snapshot moved (or was never taken) before the boundary. */
  | "stale_snapshot"
  /** The proposal waited past its 7/14-day age ceiling. */
  | "stale_proposal"
  /** The decision points at a proposal that no longer exists — a broken reference. */
  | "missing_proposal"
  /** The apply itself threw: the one ending that means something is actually wrong. */
  | "apply_threw";

export interface BoundaryOutcome {
  id: number;
  class: BoundaryOutcomeClass;
  /** True when this ending is a designed outcome rather than a defect. */
  calm: boolean;
}

const CALM_BOUNDARY_OUTCOMES = new Set<BoundaryOutcomeClass>([
  "canceled_moot",
  "stale_plan",
  "stale_snapshot",
  "stale_proposal",
]);

export function applyDueAnnouncedDecisions(asOf = localDateISO()): {
  applied: number[];
  failed: number[];
  /** One entry per id in `failed`, in the same order, saying WHICH ending it was. */
  failed_outcomes: BoundaryOutcome[];
  delayed: number[];
  // A stale draft the system rewrote against current evidence instead of asking about.
  // Not a failure and not a refusal: the decision is retired against its replacement,
  // which is in the ledger under its own freshly earned tier.
  regenerated: number[];
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
  const failedOutcomes: BoundaryOutcome[] = [];
  const delayed: number[] = [];
  const setAside: number[] = [];
  const regeneratedIds: number[] = [];
  // The one seam that writes `failed`, so an id can never land there without saying why.
  const recordFailure = (id: number, cls: BoundaryOutcomeClass) => {
    failed.push(id);
    failedOutcomes.push({ id, class: cls, calm: CALM_BOUNDARY_OUTCOMES.has(cls) });
  };
  // A sibling that lands earlier in THIS pass changes the plan and therefore makes
  // later siblings look CAS-stale. Track only those pass-local budget consumers so
  // their policy reason can win that expected collision. A budget spent before this
  // call never enters this set, leaving genuine pre-existing staleness authoritative.
  const budgetLandedInPass = new Set<string>();
  // A decision that cannot apply must reach a terminal/reviewable status here.
  // Leaving it announced/pending would re-select it on every future pass, and a
  // throwing payload would otherwise wedge the boundary applier for every
  // later decision in the queue.
  const parkForReview = (decision: (typeof due)[number], reason: string, cls: BoundaryOutcomeClass) => {
    try {
      patchBrainDecision(decision.id!, {
        status: "review",
        reversible: false,
        context: {
          ...(decision.context ?? {}),
          review_required: true,
          apply_error: reason.slice(0, 300),
          boundary_outcome: cls,
        },
      });
    } catch {
      /* the pass must survive even when the parking write fails */
    }
    recordFailure(decision.id!, cls);
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
          recordFailure(announced.id!, "canceled_moot");
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
          recordFailure(announced.id!, "canceled_moot");
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
          // The age ceiling is TERMINAL, so the draft it rejected must be retired with
          // it. Left at `draft`, a plan this pass has already refused stays eligible to
          // be re-offered and re-announced, and every later boundary refuses it again —
          // one identical refusal a day, forever, over a plan nothing can ever apply.
          // Retire FIRST, for the same reason as the proposal path above.
          try {
            setMealPlanStatus(mealPlanId, "superseded", { recordDecision: false });
          } catch (err) {
            recordAsyncFailure("apply", "retire_draft", err);
            patchBrainDecision(announced.id!, {
              status: "review",
              autonomy_tier: "ask",
              reversible: false,
              context: {
                ...(announced.context ?? {}),
                review_required: true,
                stale_plan: true,
                boundary_outcome: "stale_plan",
                retire_failed: true,
              },
            });
            recordFailure(announced.id!, "stale_plan");
            continue;
          }
          patchBrainDecision(announced.id!, {
            status: "rejected",
            autonomy_tier: "ask",
            reversible: false,
            context: {
              ...(announced.context ?? {}),
              review_required: true,
              stale_plan: true,
              boundary_outcome: "stale_plan",
            },
          });
          recordRetiredDraftReceipt({
            shape: { kind: announced.kind, domain: "nutrition", risk: announced.risk_class },
            outcome: "stale_plan",
            why: "This meal-plan draft sat unapplied for more than 14 days, so it no longer describes where you are.",
            source: plan.agent || "autonomy",
            sourceRefType: "meal_plan",
            sourceRefKey: mealPlanId,
            reviewDecisionId: announced.id ?? null,
            action: { meal_plan_id: mealPlanId, outcome: "superseded_stale_plan" },
          });
          recordFailure(announced.id!, "stale_plan");
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
        parkForReview(announced, "the linked proposal no longer exists", "missing_proposal");
        continue;
      }
      if (proposal.status !== "draft") {
        // The proposal is no longer live: applied elsewhere (a manual apply), discarded
        // (the user's explicit veto), or superseded by a fresher draft. The announcement
        // is moot and must NEVER apply at the boundary — a boundary pass re-applying a
        // vetoed replacePlan would be the worst possible surprise.
        transitionBrainDecision(announced.id!, "canceled");
        recordFailure(announced.id!, "canceled_moot");
        continue;
      }
      const shape = proposalShape(proposal);
      const boundaryBudgetKind = shape.domain === "nutrition" ? shape.kind : undefined;
      const boundaryBudgetKey = `${shape.domain}:${boundaryBudgetKind ?? "*"}`;
      const coordinated = (announced.context as any)?.coordinated_update === true;
      const routineChange = ROUTINE_CHANGE_SOURCES.has(String(announced.source ?? ""));
      // The athlete's own restructure request. An ask is never a surprise, so it is
      // exempt from the weekly budget here exactly as it was at announce time — the
      // live failure this closes was a requested week deferred behind the automatic
      // weekly evolution's budget consumption.
      const athleteAsked = shape.kind === "training_structure" && isAthleteRequestedRestructure(proposal);
      // Any OTHER change the athlete asked for in their own words (a chat target edit, a
      // swap, a session rebuild). The restructure above has its own rebuild path.
      const athleteRequest = !athleteAsked && decisionWasTheAthletesRequest(announced);
      const budgetBlocks = () =>
        !routineChange &&
        !athleteAsked &&
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
      // AN ATHLETE'S REQUEST IS HONOURED, NOT HELD. The compare-and-set gate below exists
      // so an AUTOMATIC change is never applied over a picture it was not drafted
      // against. A restructure the athlete asked for is different in kind:
      //   - drift in the `context` component alone (a check-in, a memory, a weigh-in,
      //     a profile note — anything but the plan or the training log) does not change
      //     where the days of the week go, so the change applies and the drift is
      //     recorded on the decision rather than used to park it;
      //   - drift in the PLAN or the TRAINING LOG is real, but the answer is to build
      //     the same request again against today's picture — an agent-built draft has
      //     no deterministic producer, so the rewrite is handed to the job runner and
      //     the fresh draft lands through this very pass the moment it exists. Setting
      //     the request aside "because the picture moved" was how a Sunday-night ask
      //     silently died at Monday's boundary.
      const contextOnlyDrift =
        !!boundaryFreshness &&
        boundaryFreshness.status === "changed" &&
        boundaryFreshness.changed_components.length > 0 &&
        boundaryFreshness.changed_components.every((component) => component === "context");
      if (athleteAsked && contextOnlyDrift) {
        patchBrainDecision(announced.id!, {
          context: {
            ...(announced.context ?? {}),
            boundary_drift_tolerated: boundaryFreshness!.changed_components,
            boundary_drift_reason: "the athlete asked for this restructure; a context change does not move the days",
          },
        });
      } else if (
        athleteAsked &&
        boundaryFreshness &&
        (boundaryFreshness.status === "changed" || boundaryFreshness.status === "unverified") &&
        getSettings().lead_mode !== "review_everything"
      ) {
        const changed = boundaryFreshness.changed_components.join(" and ");
        const reason =
          boundaryFreshness.status === "changed"
            ? `${changed || "plan or training"} evidence changed before the apply boundary`
            : "the proposal has no compare-and-set evidence snapshot";
        const rebuild = enqueueStructureRebuild({ proposal, decision_id: announced.id!, reason });
        if (rebuild) {
          withSqliteSavepoint(`rebuild_athlete_restructure_${announced.id}`, () => {
            setProposalStatus(proposalId, "superseded", { recordDecision: false });
            const retired = patchBrainDecision(announced.id!, {
              status: "superseded",
              context: {
                ...(announced.context ?? {}),
                review_required: false,
                review_reason_code: "stale_snapshot",
                regenerated_reason: "evidence_moved",
                changed_components: boundaryFreshness.changed_components,
                proposal_freshness: boundaryFreshness as any,
                boundary_outcome: "stale_snapshot",
                structure_rebuild_job_id: rebuild.job_id,
              },
            });
            if (!retired) throw new Error("the stale restructure decision could not be retired");
          });
          regeneratedIds.push(announced.id!);
          continue;
        }
        // No rebuild could be queued: fall through to the ordinary hold below.
      }
      // THE SAME LAW FOR EVERY OTHER REQUEST OF THEIRS. A target or a swap the athlete
      // asked for is laid on the plan as it stands at the boundary: drift since they asked
      // does not retire it, because their word is the decision and the compare-and-set
      // gate exists to protect them from the COACH's stale drafts, not from their own
      // request. applyProposal still refuses what no longer fits (the movement a swap
      // takes out is gone, the plan-quality check fails) — and that refusal is answered in
      // chat below, never parked. The floors stay: a clinical or locked request, or the
      // review_everything posture, keeps the ordinary hold.
      const requestFloors = decisionIsTheAthletes(announced);
      const requestDriftTolerated =
        athleteRequest &&
        !!boundaryFreshness &&
        (boundaryFreshness.status === "changed" || boundaryFreshness.status === "unverified") &&
        !requestFloors.clinical &&
        !requestFloors.user_locked &&
        getSettings().lead_mode !== "review_everything";
      if (requestDriftTolerated) {
        patchBrainDecision(announced.id!, {
          context: {
            ...(announced.context ?? {}),
            boundary_drift_tolerated: boundaryFreshness!.changed_components,
            boundary_drift_reason: "the athlete asked for this change; drift since they asked does not retire it",
          },
        });
      }
      if (
        boundaryFreshness &&
        !(athleteAsked && contextOnlyDrift) &&
        !requestDriftTolerated &&
        (boundaryFreshness.status === "changed" || boundaryFreshness.status === "unverified")
      ) {
        const regenerated = attemptStaleDraftRegeneration(proposal, shape, {
          freshness: boundaryFreshness,
          aged: false,
          clinical: decisionIsTheAthletes(announced).clinical,
          user_locked: decisionIsTheAthletes(announced).user_locked,
          asOf,
          parked: announced,
          allowRebase: true,
        });
        if (regenerated.regenerated) {
          regeneratedIds.push(announced.id!);
          continue;
        }
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
            boundary_outcome: "stale_snapshot",
          },
        });
        // The draft is deliberately LEFT LIVE here. The thaw owns this ending: on the
        // next deterministic sweep it re-reads the same evidence and either re-offers
        // the draft under today's policy or sets it aside with the receipt the athlete
        // reads. Retiring it here would also retire this very review hold
        // (setProposalStatus supersedes review decisions pointing at the draft).
        recordFailure(announced.id!, "stale_snapshot");
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
        const regenerated = attemptStaleDraftRegeneration(proposal, shape, {
          freshness: boundaryFreshness,
          aged: true,
          clinical: decisionIsTheAthletes(announced).clinical,
          user_locked: decisionIsTheAthletes(announced).user_locked,
          asOf,
          parked: announced,
        });
        if (regenerated.regenerated) {
          regeneratedIds.push(announced.id!);
          continue;
        }
        // TERMINAL, so the draft goes with the decision. This is the loop that produced
        // one boundary failure a day on the live deployment: an age-rejected decision is
        // never re-read by the thaw (it only walks `review`), while the draft behind it
        // stayed at `draft` — so the very next orphan-adoption tick re-adopted it, the
        // autonomy layer announced it again, and the next boundary rejected it again for
        // exactly the same reason. Retiring the draft ends the cycle at its source.
        //
        // Retire FIRST: if it throws, the draft is still live, so rejecting the decision
        // would strand exactly the pair this ending exists to break. The decision stays
        // at `review` instead — still adoptable, still visible — and the failure is
        // recorded rather than swallowed.
        try {
          setProposalStatus(proposalId, "superseded", { recordDecision: false });
        } catch (err) {
          recordAsyncFailure("apply", "retire_draft", err);
          patchBrainDecision(announced.id!, {
            status: "review",
            autonomy_tier: "ask",
            reversible: false,
            context: {
              ...(announced.context ?? {}),
              review_required: true,
              stale_proposal: true,
              stale_after_days: freshnessDays,
              boundary_outcome: "stale_proposal",
              retire_failed: true,
            },
          });
          recordFailure(announced.id!, "stale_proposal");
          continue;
        }
        patchBrainDecision(announced.id!, {
          status: "rejected",
          autonomy_tier: "ask",
          reversible: false,
          context: {
            ...(announced.context ?? {}),
            review_required: true,
            stale_proposal: true,
            stale_after_days: freshnessDays,
            boundary_outcome: "stale_proposal",
          },
        });
        // `rejected` is invisible to every athlete-facing list, so the ending gets the
        // same receipt the thaw writes for a stale snapshot.
        recordRetiredDraftReceipt({
          shape,
          outcome: "stale_proposal",
          why: `This draft sat unapplied for more than ${freshnessDays} days, so it no longer describes where you are.`,
          source: proposal.agent || "autonomy",
          sourceRefType: "plan_proposal",
          sourceRefKey: proposalId,
          reviewDecisionId: announced.id ?? null,
          action: {
            proposal_id: proposalId,
            outcome: "superseded_stale_proposal",
            reason_provenance: proposalReasonProvenance(proposal),
          },
        });
        if (athleteRequest || athleteAsked) {
          tellAthleteTheirRequestDidNotLand(
            announced,
            `It waited more than ${freshnessDays} days for its day, so it no longer described your week.`
          );
        }
        recordFailure(announced.id!, "stale_proposal");
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
      if (shape.domain === "training") refreshTodayAfterPlanLanding(proposal, announced.effective_date);
      // The landed week answers every standing request about the shape of the week —
      // none may linger as an open question over a plan that already changed.
      if (athleteAsked) {
        try {
          retireAnsweredStructureRequests(announced.id!);
        } catch (err) {
          recordAsyncFailure("apply", "retire_answered_structure_requests", err);
        }
      }
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
      const reason = String(error?.message ?? error ?? "unexpected apply error");
      const requestProposalId = Number((announced.action as any)?.proposal_id);
      // The athlete's own request that the plan refused (the plan-quality check, a swap
      // whose movement is gone) is ANSWERED, not parked: a review row they cannot act on
      // is the silence this closes. Its draft is retired so no sweep re-offers the same
      // refusal, and they are told in chat what happened and why.
      if (requestProposalId > 0 && decisionWasTheAthletesRequest(announced) && retireRefusedDraft(announced, requestProposalId, reason)) {
        recordFailure(announced.id!, "apply_threw");
        continue;
      }
      parkForReview(announced, reason, "apply_threw");
    }
  }
  return {
    applied,
    failed,
    failed_outcomes: failedOutcomes,
    delayed,
    regenerated: regeneratedIds,
    set_aside: setAside,
  };
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
            context: {
              ...((canceled.context as Record<string, unknown>) ?? {}),
              held_by_user: true,
              // WHEN they said no. `brain_decisions` has no updated_at, and
              // `created_at` is when the change was PROPOSED — a durable refusal
              // (a declined recovery week holds for the rest of the block) has to
              // be dated from the refusal, not from the offer.
              held_by_user_on: localDateISO(),
            },
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
  const personSuperseded = personSupersededMarker(decision.context);
  try {
    return withSqliteSavepoint(`revert_decision_${id}`, () => {
      if (rollback?.kind === "training_plan" && Array.isArray(rollback.payload)) {
        // A legacy whole-plan snapshot cannot leave part of the plan alone, so it never
        // runs over an item the athlete has saved themselves since.
        if (personSuperseded) throw new Error("the athlete has since saved this plan themselves");
        // Legacy snapshots remain reversible. New writes use a three-way snapshot below.
        replacePlan(withCurrentDayTypes(rollback.payload));
      } else if (
        rollback?.kind === "training_plan" &&
        rollback.payload?.version === 2 &&
        Array.isArray(rollback.payload.before) &&
        Array.isArray(rollback.payload.after)
      ) {
        const currentPlan = trainingPlanSnapshot();
        // A lift that no longer holds what this decision set is not the decision's to
        // walk back, whether or not a person's save marked it (older rows never were).
        const mismatched = mismatchedChangeKeys(decision.action, currentPlan);
        const merged = mergeTrainingRollback(
          rollback.payload.before,
          rollback.payload.after,
          currentPlan,
          Array.isArray((decision.action as any)?.swaps) ? (decision.action as any).swaps : [],
          (dayNumber, item) =>
            item?.kind !== "cardio" &&
            (() => {
              const key = planChangeKey(dayNumber, item?.exercise);
              return isPersonSuperseded(personSuperseded, key) || (key != null && mismatched.has(key));
            })()
        );
        const restored = withRestoredStamps(
          merged,
          rollback.payload.before,
          rollback.payload.before_stamps,
          rollback.payload.after_stamps
        );
        replacePlan(restored, {
          restoreStamps: true,
        });
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
      } else if (rollback?.kind === "garmin_strength" && rollback.payload?.version === 1) {
        // Ownership-guarded per session inside revertGarminReconcile itself — a
        // session touched again since the merge (re-sync, second reconcile) wins
        // over the undo and is silently left alone rather than erroring the whole
        // batch, since a partial undo across several days is still useful.
        revertGarminReconcile(rollback.payload);
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
        } catch (err) { log.debug("[brain] could not close the expectation on a user veto", { error: err }); }
      }
      const reverted = transitionBrainDecision(id, "reverted");
      if (!reverted) throw new Error("the decision could not transition to reverted");
      return { ok: true, decision: reverted };
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
