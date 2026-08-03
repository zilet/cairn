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
  // Whether the MORNING READ was followed. The only same-day metric in the set:
  // every other expectation here waits one to four weeks, which is exactly why
  // this one matters — it is the loop's daily heartbeat, not a person-score.
  "day_read_adherence",
  "run_volume_adherence",
  "vo2max_trend",
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

// `superseded` is a live window that a NEWER change took ownership of. It is
// terminal and never evaluated: the change it was asking about is no longer the
// most recent thing that happened to its metric, so no verdict it could reach
// would be about the right intervention. Distinct from `canceled`, which means
// the decision itself was undone. The rule lives in
// src/repo/brain/expectation-arbitration.ts (retireSupersededExpectations).
export const EXPECTATION_STATUSES = ["pending", "mature", "evaluated", "canceled", "superseded"] as const;
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
  "day_read_adherence",
  "run_volume_adherence",
  "vo2max_trend",
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
    day_read_adherence: ["day_read_adherence"],
    run_volume_adherence: ["run_volume_adherence"],
    vo2max_trend: ["vo2max_trend"],
    recovery_hrv_delta: ["recovery_delta"],
    recovery_rhr_delta: ["recovery_delta"],
    sleep_duration_delta: ["recovery_delta"],
    marker_direction: ["marker_direction"],
    body_measurement_direction: ["body_measurement_direction"],
  });

// Metrics whose EVIDENCE is closed the moment their window ends, so a second look
// can only ever produce the answer the first one did.
//
// The nightly pass deliberately re-probes matured expectations that came back
// inconclusive, because most windows here are one to four weeks long and evidence
// genuinely does arrive late: a lab draw lands, a wearable backfills a week of
// sleep, an intake day finally gets logged. Re-asking those every night earns its
// keep. A SAME-DAY metric is the opposite — its window is one closed calendar day,
// and re-asking whether that day was a rest day is work that can only repeat
// itself. Left alone, one row per day accumulates forever and competes with
// genuinely new maturations for the bounded nightly candidate budget.
//
// So these are terminal ONCE EVALUATED (see candidateExpectationIds). Add a metric
// here only when its window closes over evidence that cannot change — never merely
// because it is cheap to re-evaluate.
export const TERMINAL_ONCE_EVALUATED_METRICS = ["day_read_adherence"] as const satisfies readonly BrainMetricKey[];

export function isTerminalOnceEvaluated(metricKey: string): boolean {
  return (TERMINAL_ONCE_EVALUATED_METRICS as readonly string[]).includes(metricKey);
}

// ---------- minimum_data: the keys an evaluator can actually count ----------
//
// `minimum_data` is the expectation's own evidence floor — "don't conclude until at
// least N of these exist" — and every evaluator answers it from the `counts` it
// publishes on its observation. An agent-authored expectation arrives with free-form
// keys, and a key no evaluator counts used to be recorded as a CONFOUNDER, which
// forces `inconclusive` on a window that may have had perfectly good evidence in it.
// A live audit found 21 of 146 expectations permanently silenced this way, on names
// like `credible_days` and `rated_strength_sessions` that simply do not exist.
//
// A rule nobody can check is not a reason to distrust the data; it is a rule that was
// never applied. So the vocabulary is closed HERE, at the write, where a near-miss can
// still be renamed to the key that was meant and an unrecognizable one dropped in the
// open (normalizeMinimumData records the drop on `baseline.dropped_minimum_data`), and
// the evaluator downgrades anything that slips past to an ignored note.
//
// Add a key here only when an evaluator in src/brain/evaluators.ts genuinely emits a
// count under that name.
export const SUPPORTED_MINIMUM_DATA_KEYS = [
  "closed_days",
  "data_points",
  "draws",
  "exposures",
  "feedback_entries",
  "intake_days",
  "measurements",
  "nights",
  "outings",
  "planned_days",
  "readings",
  "sessions",
  "span_days",
  "weigh_ins",
] as const;
export type SupportedMinimumDataKey = (typeof SUPPORTED_MINIMUM_DATA_KEYS)[number];

const SUPPORTED_MINIMUM_DATA_KEY_SET: ReadonlySet<string> = new Set(SUPPORTED_MINIMUM_DATA_KEYS);

// Near-misses that mean a supported key. Kept small and literal on purpose — this is
// spelling tolerance, not inference.
export const MINIMUM_DATA_ALIASES: Readonly<Record<string, SupportedMinimumDataKey>> = Object.freeze({
  weigh_in_days: "weigh_ins",
  intake_logged_days: "intake_days",
  credible_intake_days: "intake_days",
  exposure_count: "exposures",
  session_count: "sessions",
  measurement_count: "measurements",
  nights_logged: "nights",
  marker_draws: "draws",
});

export function canonicalMinimumDataKey(key: string): SupportedMinimumDataKey | null {
  const alias = MINIMUM_DATA_ALIASES[key];
  if (alias) return alias;
  return SUPPORTED_MINIMUM_DATA_KEY_SET.has(key) ? (key as SupportedMinimumDataKey) : null;
}

export interface NormalizedMinimumData {
  minimum_data: JsonObject | null;
  dropped: string[];
}

/**
 * Canonicalize a minimum_data object: known aliases renamed, non-numeric and
 * unrecognized rules dropped, and the dropped names returned so the caller can record
 * them somewhere an operator can see.
 */
export function normalizeMinimumData(value: unknown): NormalizedMinimumData {
  const input = value == null ? null : normalizeJsonObject(value);
  if (!input) return { minimum_data: null, dropped: [] };
  const kept: JsonObject = {};
  const dropped: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = canonicalMinimumDataKey(rawKey);
    const required = Number(rawValue);
    if (!key || !Number.isFinite(required)) {
      dropped.push(rawKey.slice(0, 60));
      continue;
    }
    // A later duplicate spelling of the same rule takes the STRICTER of the two.
    const existing = Number(kept[key]);
    kept[key] = Number.isFinite(existing) ? Math.max(existing, required) : required;
  }
  return { minimum_data: Object.keys(kept).length ? kept : null, dropped: [...new Set(dropped)].slice(0, 12) };
}

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

  const minimum = normalizeMinimumData(input.minimum_data);
  let baseline = input.baseline == null ? null : normalizeJsonObject(input.baseline);
  // The drop has to be VISIBLE. `baseline` is the expectation's own free-form record
  // of what it was written against, and it is what the ledger and the diagnostics
  // read back, so a rule that was thrown away leaves its name there rather than
  // disappearing between the agent and the row.
  if (minimum.dropped.length) baseline = { ...(baseline ?? {}), dropped_minimum_data: minimum.dropped };

  return {
    metric_key: metricKey,
    subject_key: cleanOptionalText(input.subject_key, 160),
    direction,
    baseline,
    target,
    window_start: windowStart,
    window_end: windowEnd,
    minimum_data: minimum.minimum_data,
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
