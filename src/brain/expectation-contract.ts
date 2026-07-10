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

export const BRAIN_METRIC_KEYS = [
  "weight_trend_lb_wk",
  "intake_to_weight_response",
  "exercise_target_completion",
  "exercise_est_1rm_trend",
  "session_performance_feedback",
  "joint_pain_or_soreness",
  "plan_day_adherence",
  "recovery_hrv_delta",
  "recovery_rhr_delta",
  "sleep_duration_delta",
  "marker_direction",
  "body_measurement_direction",
] as const;
export type BrainMetricKey = (typeof BRAIN_METRIC_KEYS)[number];

export const EXPECTATION_DIRECTIONS = [
  "increase",
  "decrease",
  "maintain",
  "within_band",
  "at_least",
  "at_most",
  "complete",
  "avoid",
] as const;
export type ExpectationDirection = (typeof EXPECTATION_DIRECTIONS)[number];

export const EXPECTATION_CONFIDENCE = ["tentative", "observed", "strong"] as const;
export type ExpectationConfidence = (typeof EXPECTATION_CONFIDENCE)[number];

export const EXPECTATION_STATUSES = ["pending", "mature", "evaluated", "canceled"] as const;
export type ExpectationStatus = (typeof EXPECTATION_STATUSES)[number];

export const EXPECTATION_CONFOUNDER_POLICIES = [
  "standard",
  "exclude_context_events",
  "require_exposure",
  "next_draw",
  "none",
] as const;
export type ExpectationConfounderPolicy = (typeof EXPECTATION_CONFOUNDER_POLICIES)[number];

export const EXPECTATION_EVALUATORS = [
  "weight_trend",
  "intake_response",
  "exercise_completion",
  "exercise_est_1rm",
  "session_feedback",
  "symptom_load",
  "plan_adherence",
  "recovery_delta",
  "marker_direction",
  "body_measurement_direction",
] as const;
export type ExpectationEvaluator = (typeof EXPECTATION_EVALUATORS)[number];

export const EXPECTATION_EVALUATORS_BY_METRIC: Readonly<Record<BrainMetricKey, readonly ExpectationEvaluator[]>> =
  Object.freeze({
    weight_trend_lb_wk: ["weight_trend"],
    intake_to_weight_response: ["intake_response"],
    exercise_target_completion: ["exercise_completion"],
    exercise_est_1rm_trend: ["exercise_est_1rm"],
    session_performance_feedback: ["session_feedback"],
    joint_pain_or_soreness: ["symptom_load"],
    plan_day_adherence: ["plan_adherence"],
    recovery_hrv_delta: ["recovery_delta"],
    recovery_rhr_delta: ["recovery_delta"],
    sleep_duration_delta: ["recovery_delta"],
    marker_direction: ["marker_direction"],
    body_measurement_direction: ["body_measurement_direction"],
  });

export interface ProposedExpectation {
  metric_key: BrainMetricKey;
  subject_key: string | null;
  direction: ExpectationDirection;
  baseline: JsonObject | null;
  target: JsonObject;
  window_start: string;
  window_end: string;
  minimum_data: JsonObject | null;
  confounder_policy: ExpectationConfounderPolicy;
  confidence: ExpectationConfidence;
  evaluator: ExpectationEvaluator;
  evaluator_version: string;
}

export interface BrainExpectation extends ProposedExpectation {
  id?: number;
  decision_id: number;
  status: ExpectationStatus;
  created_at?: string;
}

export function normalizeProposedExpectation(value: unknown): ProposedExpectation | null {
  const input = asRecord(value);
  if (!input) return null;
  const metricKey = enumValue(input.metric_key, BRAIN_METRIC_KEYS);
  const direction = enumValue(input.direction, EXPECTATION_DIRECTIONS);
  const windowStart = isoDate(input.window_start);
  const windowEnd = isoDate(input.window_end);
  const confidence = enumValue(input.confidence, EXPECTATION_CONFIDENCE);
  const evaluator = enumValue(input.evaluator, EXPECTATION_EVALUATORS);
  const evaluatorVersion = cleanText(input.evaluator_version, 80);
  const target = normalizeJsonObject(input.target);
  if (
    !metricKey ||
    !direction ||
    !windowStart ||
    !windowEnd ||
    windowStart > windowEnd ||
    !confidence ||
    !evaluator ||
    !EXPECTATION_EVALUATORS_BY_METRIC[metricKey].includes(evaluator) ||
    !evaluatorVersion ||
    !target
  ) {
    return null;
  }

  return {
    metric_key: metricKey,
    subject_key: cleanOptionalText(input.subject_key, 160),
    direction,
    baseline: input.baseline == null ? null : normalizeJsonObject(input.baseline),
    target,
    window_start: windowStart,
    window_end: windowEnd,
    minimum_data: input.minimum_data == null ? null : normalizeJsonObject(input.minimum_data),
    confounder_policy: enumValue(input.confounder_policy, EXPECTATION_CONFOUNDER_POLICIES) ?? "standard",
    confidence,
    evaluator,
    evaluator_version: evaluatorVersion,
  };
}

export function normalizeBrainExpectation(value: unknown): BrainExpectation | null {
  const input = asRecord(value);
  const proposed = normalizeProposedExpectation(value);
  if (!input || !proposed) return null;
  const decisionId = positiveInteger(input.decision_id);
  if (!decisionId) return null;
  const id = input.id == null ? undefined : positiveInteger(input.id);
  const createdAt = input.created_at == null ? undefined : isoDateTime(input.created_at);
  if ((input.id != null && !id) || (input.created_at != null && !createdAt)) return null;
  return {
    ...(id ? { id } : {}),
    ...proposed,
    decision_id: decisionId,
    status: enumValue(input.status, EXPECTATION_STATUSES) ?? "pending",
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

export function isProposedExpectation(value: unknown): value is ProposedExpectation {
  const input = asRecord(value);
  return (
    !!input &&
    normalizeProposedExpectation(value) !== null &&
    hasOwnProperties(input, [
      "metric_key",
      "subject_key",
      "direction",
      "baseline",
      "target",
      "window_start",
      "window_end",
      "minimum_data",
      "confounder_policy",
      "confidence",
      "evaluator",
      "evaluator_version",
    ])
  );
}

export function isBrainExpectation(value: unknown): value is BrainExpectation {
  const input = asRecord(value);
  return (
    !!input &&
    isProposedExpectation(value) &&
    normalizeBrainExpectation(value) !== null &&
    hasOwnProperties(input, ["decision_id", "status"])
  );
}
