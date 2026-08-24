import {
  asRecord,
  cleanOptionalText,
  cleanText,
  enumValue,
  hasOwnProperties,
  isoDate,
  isoDateTime,
  normalizeJsonObject,
  positiveInteger,
  type JsonObject,
} from "./contract-utils.js";

export const BRAIN_DOMAINS = ["training", "nutrition", "health", "recovery", "lifestyle", "cross_domain"] as const;
export type BrainDomain = (typeof BRAIN_DOMAINS)[number];

export const BRAIN_DECISION_KINDS = [
  "day_read",
  "session_suggestion",
  "training_target",
  "training_structure",
  "exercise_rotation",
  "nutrition_target",
  "meal_plan",
  "recovery_adjustment",
  "health_directive",
  "lifestyle_adjustment",
  "goal_change",
  "case_conference",
  "garmin_reconcile",
] as const;
export type BrainDecisionKind = (typeof BRAIN_DECISION_KINDS)[number];

export const BRAIN_DECISION_STATUSES = [
  "observed",
  "pending",
  "announced",
  "review",
  "applied",
  "rejected",
  "reverted",
  "superseded",
  "canceled",
] as const;
export type BrainDecisionStatus = (typeof BRAIN_DECISION_STATUSES)[number];

export const AUTONOMY_TIERS = ["observe", "quiet_apply", "announce", "ask", "clinician"] as const;
export type AutonomyTier = (typeof AUTONOMY_TIERS)[number];

export const BRAIN_RISK_CLASSES = ["low", "moderate", "high", "clinical"] as const;
export type BrainRiskClass = (typeof BRAIN_RISK_CLASSES)[number];

export const BRAIN_SOURCE_REF_TYPES = [
  "plan_proposal",
  "nutrition_target",
  "directive",
  "meal_plan",
  "suggestion",
  "day_read",
] as const;
export type BrainSourceRefType = (typeof BRAIN_SOURCE_REF_TYPES)[number];

export interface BrainDecision {
  id?: number;
  created_at?: string;
  effective_date: string | null;
  kind: BrainDecisionKind;
  domain: BrainDomain;
  summary: string;
  rationale: string | null;
  source: string | null;
  source_ref_type: BrainSourceRefType | null;
  source_ref_key: string | null;
  status: BrainDecisionStatus;
  autonomy_tier: AutonomyTier;
  risk_class: BrainRiskClass;
  reversible: boolean;
  input_fingerprint: string | null;
  context: JsonObject | null;
  action: JsonObject | null;
  specialist: JsonObject | null;
  applied_at: string | null;
  reverted_at: string | null;
  superseded_by: number | null;
  evaluator_version: string | null;
}

export type NewBrainDecision = Omit<BrainDecision, "id" | "created_at">;

export function normalizeBrainDecision(value: unknown): BrainDecision | null {
  const input = asRecord(value);
  if (!input) return null;

  const kind = enumValue(input.kind, BRAIN_DECISION_KINDS);
  const domain = enumValue(input.domain, BRAIN_DOMAINS);
  const summary = cleanText(input.summary, 300);
  const autonomyTier = enumValue(input.autonomy_tier, AUTONOMY_TIERS);
  const riskClass = enumValue(input.risk_class, BRAIN_RISK_CLASSES);
  if (!kind || !domain || !summary || !autonomyTier || !riskClass || typeof input.reversible !== "boolean") {
    return null;
  }

  const sourceRefType = enumValue(input.source_ref_type, BRAIN_SOURCE_REF_TYPES);
  const sourceRefKey = cleanOptionalText(input.source_ref_key, 120);
  if ((sourceRefType && !sourceRefKey) || (!sourceRefType && sourceRefKey)) return null;

  const effectiveDate = input.effective_date == null ? null : isoDate(input.effective_date);
  if (input.effective_date != null && !effectiveDate) return null;
  const appliedAt = input.applied_at == null ? null : isoDateTime(input.applied_at);
  const revertedAt = input.reverted_at == null ? null : isoDateTime(input.reverted_at);
  if ((input.applied_at != null && !appliedAt) || (input.reverted_at != null && !revertedAt)) return null;

  const id = input.id == null ? undefined : positiveInteger(input.id);
  const supersededBy = input.superseded_by == null ? null : positiveInteger(input.superseded_by);
  if ((input.id != null && !id) || (input.superseded_by != null && !supersededBy)) return null;
  const createdAt = input.created_at == null ? undefined : isoDateTime(input.created_at);
  if (input.created_at != null && !createdAt) return null;
  const context = input.context == null ? null : normalizeJsonObject(input.context);
  const action = input.action == null ? null : normalizeJsonObject(input.action);
  const specialist = input.specialist == null ? null : normalizeJsonObject(input.specialist);
  if (
    (input.context != null && !context) ||
    (input.action != null && !action) ||
    (input.specialist != null && !specialist)
  ) {
    return null;
  }

  return {
    ...(id ? { id } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    effective_date: effectiveDate,
    kind,
    domain,
    summary,
    rationale: cleanOptionalText(input.rationale, 1_500),
    source: cleanOptionalText(input.source, 100),
    source_ref_type: sourceRefType,
    source_ref_key: sourceRefKey,
    status: enumValue(input.status, BRAIN_DECISION_STATUSES) ?? "pending",
    autonomy_tier: autonomyTier,
    risk_class: riskClass,
    reversible: input.reversible,
    input_fingerprint: cleanOptionalText(input.input_fingerprint, 160),
    context,
    action,
    specialist,
    applied_at: appliedAt,
    reverted_at: revertedAt,
    superseded_by: supersededBy,
    evaluator_version: cleanOptionalText(input.evaluator_version, 80),
  };
}

export function isBrainDecision(value: unknown): value is BrainDecision {
  const input = asRecord(value);
  return (
    !!input &&
    normalizeBrainDecision(value) !== null &&
    hasOwnProperties(input, [
      "effective_date",
      "kind",
      "domain",
      "summary",
      "rationale",
      "source",
      "source_ref_type",
      "source_ref_key",
      "status",
      "autonomy_tier",
      "risk_class",
      "reversible",
      "input_fingerprint",
      "context",
      "action",
      "specialist",
      "applied_at",
      "reverted_at",
      "superseded_by",
      "evaluator_version",
    ])
  );
}
