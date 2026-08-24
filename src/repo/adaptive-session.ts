import crypto from "node:crypto";
import { truncateAtWord } from "../brain/contract-utils.js";
import { normalizePrescriptionItem, SESSION_PRESCRIPTION_LIMITS } from "../contracts/session-prescription.js";
import { deterministicComposedSession, normalizeComposedSession } from "./daily-composition.js";
import {
  decideDailySession,
  isTrainIntentOverride,
  recordDailySessionDecision,
  type DailyDecisionEnvelope,
} from "./daily-decision.js";
import { db } from "../db.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { getAgentJob } from "./chat.js";
import { findExercise, recentWorkingSeconds, recentWorkingWeight } from "./exercises.js";
import { getPlanDay } from "./plan.js";
import { selectedPlanDayForDate } from "./plan-selection.js";
import { getOrCreateSessionRow } from "./session-core.js";
import { localDateISO } from "./shared.js";
import { withSqliteSavepoint } from "./sqlite-savepoint.js";

// planSnapshot's session-header "why", athlete-voice and rotating (VISION.md:
// suggestion voice, never engineering vocabulary). Index 0 of each set is also
// the fixed replacement migration v82 uses to repair historical
// daily_session_compositions.why rows still holding the old machine literals
// ("Explicit plan-day override: Day N." / "Adaptive plan selection for
// {date}.") — keep that migration's literals in sync with these if the wording
// here ever changes.
const SESSION_WHY_OVERRIDE = [
  "Your call today.",
  "You picked this one yourself.",
  "Switched by you, not the usual order.",
] as const;
// The calm default when the plan simply held its normal rotation slot with
// nothing materially different to explain — selectAdaptivePlanDay() (in
// plan-selection.ts) returns a null `reason` in exactly that case, which used
// to fall through to a bare "Adaptive plan selection for {date}." literal.
const SESSION_WHY_ROTATION = [
  "Today's regular spot in the rotation.",
  "Right on track with your usual order.",
  "Following the plan the way it normally runs.",
] as const;

export const DAILY_SESSION_SOURCES = ["adaptive_plan", "agent_suggest", "manual_plan", "athlete_override"] as const;
export const DAILY_SESSION_SUGGESTION_NORMALIZATION = "daily_session_v1";

export type DailySessionSource = (typeof DAILY_SESSION_SOURCES)[number];

export interface PrepareDailySessionInput {
  date?: string;
  expected_active_id?: number | null;
  expected_input_fingerprint?: string | null;
  day_number?: number | null;
  source?: DailySessionSource | string;
  agent_job_id?: number | null;
  session?: unknown;
  constraints?: unknown;
  provenance?: unknown;
  train_anyway?: boolean;
  replace?: boolean;
}

export interface AdaptiveDailySessionPreview {
  date: string;
  source: "adaptive_plan";
  kind: DailyDecisionEnvelope["kind"];
  policy_version: string;
  input_fingerprint: string;
  title: string | null;
  focus: string | null;
  item_count: number;
  est_minutes: number | null;
  shortened: boolean;
  constraints: string[];
  primary_rationale: string;
}

export class DailySessionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly preview?: AdaptiveDailySessionPreview
  ) {
    super(message);
    this.name = "DailySessionError";
  }
}

function fail(code: string, message: string, preview?: AdaptiveDailySessionPreview): never {
  throw new DailySessionError(code, message, preview);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_SOURCES = new Set<DailySessionSource>(["adaptive_plan", "manual_plan"]);

function boundedText(value: unknown, max: number): string | null {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

// The narration variant of `boundedText`, for the fields the ATHLETE reads. A label
// or an identifier can be clipped anywhere; a sentence cannot — a bare slice halves
// the last word, and the fragment then runs into whatever follows it as if the two
// were one sentence.
function boundedProse(value: unknown, max: number): string | null {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? truncateAtWord(text, max) : null;
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boundedNumber(value: unknown, min: number, max: number, integer = false): number | null {
  const n = finite(value);
  if (n == null) return null;
  const bounded = Math.max(min, Math.min(max, n));
  return integer ? Math.round(bounded) : Math.round(bounded * 100) / 100;
}

// Athlete-facing narration rather than a label, so the clamp cuts at a word boundary
// — a bare slice left the last word halved and the fragment then ran into whatever
// the card printed next as if the two were one sentence.
function durableSnapshotText(value: unknown, max: number): string | null {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  const rewritten = text
    .replace(/\byesterday's\b/gi, "a prior session's")
    .replace(/\byesterday\b/gi, "a prior session")
    .replace(/\s+/g, " ")
    .trim();
  return truncateAtWord(rewritten, max) || null;
}

function dedupeStartLight(value: unknown): string | null {
  const bounded = durableSnapshotText(value, 500);
  if (!bounded) return null;
  if ((bounded.match(/\bstart light\b/gi) ?? []).length <= 1) return bounded;
  const clauses = bounded
    .split(/(?<=[.;])\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  let sawStartLight = false;
  const kept = clauses.filter((clause) => {
    const baseline = /\bstart light\b/i.test(clause);
    if (!baseline) return true;
    if (sawStartLight) return false;
    sawStartLight = true;
    return true;
  });
  return truncateAtWord(kept.join(" "), 500) || null;
}

function trustedItemMetadata(
  item: Record<string, unknown>,
  trusted: boolean
): Record<string, unknown> {
  if (!trusted) return {};
  const provenance = normalizeJsonValue(item.brain_change_reason_provenance);
  return {
    brain_decision_id: boundedNumber(item.brain_decision_id, 1, Number.MAX_SAFE_INTEGER, true),
    brain_change_summary: durableSnapshotText(item.brain_change_summary, 500),
    brain_change_reason: durableSnapshotText(item.brain_change_reason, 600),
    brain_change_reason_provenance:
      provenance && typeof provenance === "object" && !Array.isArray(provenance) ? provenance : null,
    brain_change_reversible:
      item.brain_change_reversible == null ? null : item.brain_change_reversible === true,
  };
}

function normalizeJsonValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, 500);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 30).map((entry) => normalizeJsonValue(entry, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null);
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    for (const [rawKey, entry] of entries.slice(0, 40)) {
      const key = rawKey.trim().slice(0, 80);
      if (["__proto__", "prototype", "constructor"].includes(key)) continue;
      if (key) out[key] = normalizeJsonValue(entry, depth + 1);
    }
    return out;
  }
  return null;
}

function normalizeOptionalJson(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const json = JSON.stringify(normalizeJsonValue(value));
  if (json.length > 12_000) throw new Error("constraints/provenance is too large");
  return json;
}

function normalizedRecord(value: unknown): Record<string, unknown> {
  const normalized = normalizeJsonValue(value);
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? (normalized as Record<string, unknown>)
    : Object.create(null);
}

function dailyDecisionContext(envelope: DailyDecisionEnvelope) {
  const request = (envelope as DailyDecisionEnvelope & { request?: DailyDecisionEnvelope["request"] }).request;
  const intent = envelope.training_intent;
  return {
    policy_version: envelope.policy_version,
    input_fingerprint: envelope.input_fingerprint,
    kind: envelope.kind,
    baseline_kind: envelope.baseline_kind ?? envelope.kind,
    train_anyway: request?.train_anyway === true,
    template: envelope.template,
    caps: envelope.caps,
    recovery_cycle: envelope.recovery_cycle,
    hard_constraints: envelope.hard_constraints,
    rationale: envelope.rationale,
    // Compact soft-bias provenance only — ordered priorities + role + source,
    // no scores or free-text capacity.
    training_intent: intent
      ? {
          priorities: Array.isArray(intent.priorities) ? intent.priorities.slice(0, 5) : [],
          endurance_role: intent.endurance_role,
          source: intent.source,
        }
      : null,
  };
}

function decisionOpts(input: PrepareDailySessionInput) {
  const constraints = normalizedRecord(input.constraints);
  const legacyOverride =
    typeof constraints.day_read_override === "string" ? String(constraints.day_read_override) : null;
  return {
    override: legacyOverride,
    train_anyway: input.train_anyway === true || isTrainIntentOverride(legacyOverride),
    equipment: typeof constraints.equipment === "string" ? String(constraints.equipment) : null,
    minutes: finite(constraints.minutes),
    goal: typeof constraints.goal === "string" ? String(constraints.goal) : null,
  };
}

function agentDecisionOpts(jobInput: Record<string, unknown>) {
  const explicitOverride =
    typeof jobInput.override === "string"
      ? jobInput.override
      : typeof jobInput.constraints === "string" && /\btrain anyway\b/i.test(jobInput.constraints)
        ? jobInput.constraints
        : null;
  return {
    override: explicitOverride,
    train_anyway: jobInput.train_anyway === true || isTrainIntentOverride(explicitOverride),
    equipment: typeof jobInput.equipment === "string" ? jobInput.equipment : null,
    minutes: finite(jobInput.minutes),
    goal: typeof jobInput.goal === "string" ? jobInput.goal : null,
  };
}

function decisionBoundMetadata(
  input: PrepareDailySessionInput,
  envelope: DailyDecisionEnvelope,
  source: DailySessionSource
) {
  const trainAnyway =
    (envelope as DailyDecisionEnvelope & { request?: DailyDecisionEnvelope["request"] }).request?.train_anyway === true;
  const choice =
    trainAnyway || (source === "manual_plan" && (envelope.baseline_kind ?? envelope.kind) !== "train")
      ? "training_by_choice"
      : "adapted_for_today";
  return {
    constraints: {
      ...normalizedRecord(input.constraints),
      train_anyway: trainAnyway,
      daily_decision: dailyDecisionContext(envelope),
    },
    provenance: {
      ...normalizedRecord(input.provenance),
      label: choice === "training_by_choice" ? "Training by choice" : "Adapted for today",
      choice,
      daily_decision: dailyDecisionContext(envelope),
    },
  };
}

function withoutServerDecisionFields(
  value: unknown,
  keys: string[]
): Record<string, unknown> {
  const out = { ...normalizedRecord(value) };
  for (const key of keys) delete out[key];
  return out;
}

function exactPlanRetry(existing: any, input: PrepareDailySessionInput, source: DailySessionSource): boolean {
  if (!existing || String(existing.source) !== source || !PLAN_SOURCES.has(source)) return false;
  if (source === "manual_plan" && input.day_number != null) {
    const day = getPlanDay(Number(input.day_number));
    if (!day || Number(day.id) !== Number(existing.plan_day_id)) return false;
  }
  const constraints = parseJson(existing.constraints_json);
  const provenance = parseJson(existing.provenance_json);
  const existingTrainAnyway =
    constraints && typeof constraints === "object" && !Array.isArray(constraints)
      ? (constraints as Record<string, unknown>).train_anyway === true
      : false;
  if (existingTrainAnyway !== decisionOpts(input).train_anyway) return false;
  return (
    stableJson(withoutServerDecisionFields(constraints, ["train_anyway", "daily_decision"])) ===
      stableJson(normalizedRecord(input.constraints)) &&
    stableJson(withoutServerDecisionFields(provenance, ["label", "choice", "daily_decision"])) ===
      stableJson(normalizedRecord(input.provenance))
  );
}

function exactAgentJobRetry(existing: any, input: PrepareDailySessionInput, source: DailySessionSource): boolean {
  if (!existing || source !== "agent_suggest" || String(existing.source) !== source) return false;
  const provenance = parseJson(existing.provenance_json);
  const existingJobId =
    provenance && typeof provenance === "object" && !Array.isArray(provenance)
      ? Number((provenance as Record<string, unknown>).agent_job_id)
      : Number.NaN;
  return Number.isInteger(existingJobId) && existingJobId === Number(input.agent_job_id);
}

function envelopePlanDayId(envelope: DailyDecisionEnvelope): number | null {
  const direct = Number(
    (envelope.template as DailyDecisionEnvelope["template"] & { plan_day_id?: number | null }).plan_day_id
  );
  if (Number.isInteger(direct) && direct > 0) return direct;
  if (envelope.template.day_number == null) return null;
  const day = getPlanDay(envelope.template.day_number);
  return day?.id != null ? Number(day.id) : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function requestFingerprint(input: {
  date: string;
  source: DailySessionSource;
  plan_day_id: number | null;
  payload: ReturnType<typeof normalizeSessionPayload>;
  constraints_json: string | null;
  canonical_agent_job_id: number | null;
}): string {
  const planSource = PLAN_SOURCES.has(input.source);
  return crypto
    .createHash("sha256")
    .update(
      stableJson({
        date: input.date,
        source: input.source,
        plan_day_id: input.plan_day_id,
        title: input.payload.title,
        focus: input.payload.focus,
        // Plan-selection rationale is contextual and can change after the session
        // row is linked; the actual plan snapshot defines plan-source identity.
        why: planSource ? null : input.payload.why,
        est_minutes: input.payload.est_minutes,
        items: input.payload.items,
        constraints: parseJson(input.constraints_json),
        // Only server-verified agent identity belongs in request identity.
        // Athlete/client provenance stays metadata and cannot force versions.
        canonical_agent_job_id: input.source === "agent_suggest" ? input.canonical_agent_job_id : null,
      })
    )
    .digest("hex");
}

function validateDate(value: unknown): string {
  const date = String(value || localDateISO()).trim();
  if (!DATE_RE.test(date)) throw new Error("date must be YYYY-MM-DD");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("date must be a valid calendar date");
  }
  return date;
}

function sourceOf(value: unknown): DailySessionSource {
  const source = String(value || "adaptive_plan") as DailySessionSource;
  if (!DAILY_SESSION_SOURCES.includes(source)) throw new Error("unsupported daily-session source");
  return source;
}

function plannedTarget(exercise: string, field: "target_weight" | "target_seconds"): number | null {
  const row = db
    .prepare(
      `SELECT pi.${field} AS value
         FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
        WHERE e.name = ? COLLATE NOCASE AND pi.${field} IS NOT NULL
        ORDER BY pi.id DESC LIMIT 1`
    )
    .get(exercise) as any;
  return finite(row?.value);
}

function safeAgentWeight(exercise: string, requested: unknown): number | null {
  const value = boundedNumber(requested, -1000, 5000);
  if (value == null || value === 0) return null;
  if (boundedText(findExercise(exercise)?.constraint_note, 500)) return null;
  const recent = recentWorkingWeight(exercise);
  const baseline = recent ?? plannedTarget(exercise, "target_weight");
  // A new/thin lift has no trustworthy load anchor. Keep the prescription useful
  // (sets/reps/cues) but let the athlete choose the first load in the logger.
  if (baseline == null || baseline === 0) return null;
  const maxStep = Math.max(10, Math.abs(baseline) * 0.1);
  return Math.min(value, baseline + maxStep);
}

function safeAgentSeconds(exercise: string, requested: unknown): number | null {
  const value = boundedNumber(requested, 1, 3600, true);
  if (value == null) return null;
  const recent = recentWorkingSeconds(exercise);
  const baseline = recent ?? plannedTarget(exercise, "target_seconds");
  if (baseline == null || baseline <= 0) return value;
  if (boundedText(findExercise(exercise)?.constraint_note, 500)) return Math.min(value, Math.round(baseline));
  return Math.min(value, Math.round(baseline + Math.max(10, baseline * 0.1)));
}

function normalizeInterval(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return normalizeJsonValue(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return normalizeJsonValue(value);
}

function normalizeItem(
  raw: unknown,
  position: number,
  agentSource: boolean,
  athleteSource: boolean,
  trustedAgentNormalized = false
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`item ${position + 1} must be an object`);
  const item = raw as Record<string, unknown>;
  const exerciseInput = boundedText(item.exercise ?? (item.kind === "cardio" ? item.note : null), 120);
  const storedMode = exerciseInput ? findExercise(exerciseInput)?.mode : null;
  const core = normalizePrescriptionItem(raw, position, {
    storedMode,
    clampBounds: true,
    strictShape: agentSource,
  });
  const { exercise, kind } = core;
  // Only server-derived plan items or an already verified agent normalization may
  // carry accountability metadata. Athlete-authored payloads must never be able
  // to forge an Undo control for an unrelated brain decision.
  const trustedMetadata = trustedItemMetadata(
    item,
    !athleteSource && (!agentSource || trustedAgentNormalized)
  );
  if (kind === "cardio") {
    return {
      position,
      kind,
      exercise,
      sets: null,
      rep_low: null,
      rep_high: null,
      target_weight: null,
      target_seconds: null,
      warmup_sets: null,
      mode: null,
      note: boundedProse(item.note, 500),
      target_distance_km: core.target_distance_km,
      target_duration_min: core.target_duration_min,
      target_zone: boundedText(item.target_zone, 80),
      interval: normalizeInterval(item.interval ?? item.interval_json),
      superset_group: null,
      ...trustedMetadata,
    };
  }

  const mode = core.mode as "reps" | "timed";
  const targetSeconds =
    mode === "timed" && core.target_seconds != null
      ? agentSource
        ? trustedAgentNormalized
          ? core.target_seconds
          : safeAgentSeconds(exercise, core.target_seconds)
        : core.target_seconds
      : null;
  return {
    position,
    kind,
    exercise,
    sets: core.sets,
    rep_low: core.rep_low,
    rep_high: core.rep_high,
    target_weight:
      mode === "timed"
        ? null
        : agentSource
          ? trustedAgentNormalized
            ? boundedNumber(item.target_weight, -1000, 5000)
            : safeAgentWeight(exercise, item.target_weight)
          : athleteSource
            ? boundedNumber(item.target_weight, -1000, 5000)
            : finite(item.target_weight),
    target_seconds: targetSeconds,
    warmup_sets: boundedNumber(item.warmup_sets, 0, 10, true),
    mode,
    note: dedupeStartLight(item.note),
    target_distance_km: null,
    target_duration_min: null,
    target_zone: null,
    interval: null,
    superset_group: boundedNumber(item.superset_group, 1, 50, true),
    ...trustedMetadata,
  };
}

function normalizeSessionPayload(
  raw: unknown,
  agentSource: boolean,
  requireSummary = false,
  allowEmpty = false,
  athleteSource = false,
  trustedAgentNormalized = false
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("session payload is required");
  const session = raw as Record<string, unknown>;
  if (!Array.isArray(session.items) || (!allowEmpty && !session.items.length)) {
    throw new Error("session items are required");
  }
  if (session.items.length > 24) throw new Error("session may contain at most 24 items");
  const items = session.items.map((item, index) =>
    normalizeItem(item, index, agentSource, athleteSource, trustedAgentNormalized)
  );
  const title = boundedText(session.title ?? session.name, 120) ?? (allowEmpty ? "Open session" : null);
  const why = boundedProse(session.why, 600);
  if (requireSummary && (!title || !why)) throw new Error("agent session name and why are required");
  return {
    title,
    focus: boundedProse(session.focus, 160),
    why,
    est_minutes: (() => {
      if (session.est_minutes != null) {
        const value = finite(session.est_minutes);
        if (value == null || value <= 0) throw new Error("est_minutes must be positive");
      }
      return boundedNumber(session.est_minutes, 1, SESSION_PRESCRIPTION_LIMITS.minutes, true);
    })(),
    items,
  };
}

// Canonical suggestion boundary used before a result is rendered, cached, or
// written to an agent job. This is intentionally the same agent-source path that
// prepareDailySession re-runs later, making normalization idempotent: the preview
// items are byte-for-byte the items that durable preparation will snapshot.
export function normalizeSessionSuggestionResult(raw: unknown) {
  try {
    const payload = normalizeSessionPayload(raw, true, true);
    return {
      name: payload.title,
      focus: payload.focus,
      why: payload.why,
      est_minutes: payload.est_minutes,
      items: payload.items,
    };
  } catch {
    return null;
  }
}

function planSnapshot(date: string, dayNumber?: number | null) {
  const selected = dayNumber != null ? null : selectedPlanDayForDate(date);
  const requested = dayNumber != null ? Number(dayNumber) : selected?.day_number;
  if (!Number.isInteger(requested) || Number(requested) <= 0) throw new Error("no plan day is available");
  const day = getPlanDay(Number(requested));
  if (!day) throw new Error(`plan day ${requested} not found`);
  return {
    plan_day_id: Number(day.id),
    payload: normalizeSessionPayload(
      {
        title: day.name,
        focus: day.focus,
        why:
          dayNumber != null
            ? pickDayVariant(SESSION_WHY_OVERRIDE, date, "adaptive-session:why:override")
            : boundedProse(selected?.selection?.reason, 600) ||
              pickDayVariant(SESSION_WHY_ROTATION, date, "adaptive-session:why:rotation"),
        items: day.items,
      },
      false
    ),
  };
}

function adaptiveSnapshotFromDecision(envelope: DailyDecisionEnvelope) {
  if (envelope.kind !== "rest" && envelope.template.intent !== "template") {
    // Preserve the existing adaptive-plan contract: without a weekly template,
    // callers use athlete_override for an open session. Rest is the one useful
    // exception because its recovery composition is intentionally plan-free.
    throw new Error("session items are required");
  }
  const session = deterministicComposedSession(envelope);
  return {
    // A true rest decision intentionally severs the weekly-template link: the
    // accepted prescription is the deterministic recovery composition, not a
    // relabeled full lifting day. Train-anyway returns kind=train and keeps it.
    plan_day_id: envelope.kind === "rest" ? null : envelopePlanDayId(envelope),
    payload: normalizeSessionPayload(
      {
        title: session.name,
        focus: session.focus,
        why: session.why,
        est_minutes: session.est_minutes,
        items: session.items,
      },
      false,
      false,
      envelope.kind === "rest"
    ),
  };
}

type AdaptiveDailySessionCandidate = {
  date: string;
  source: "adaptive_plan";
  decision: { envelope: DailyDecisionEnvelope };
  prepared: ReturnType<typeof adaptiveSnapshotFromDecision>;
  constraints_json: string | null;
  provenance_json: string | null;
  request_fingerprint: string;
  preview: AdaptiveDailySessionPreview;
};

function athleteFacingPreviewConstraints(envelope: DailyDecisionEnvelope): string[] {
  const values = [...envelope.hard_constraints, ...envelope.soft_preferences]
    .map((entry) => boundedText(entry.detail, 180))
    .filter((entry): entry is string => entry != null);
  return Array.from(new Set(values)).slice(0, 8);
}

// One read-only adaptive candidate seam shared by preview and prepare. Nothing
// in this builder records a decision, opens a workout session, or writes a
// composition; the returned object is the exact candidate prepare persists.
export function buildAdaptiveDailySessionCandidate(
  input: Pick<PrepareDailySessionInput, "date" | "constraints" | "provenance" | "train_anyway"> = {}
): AdaptiveDailySessionCandidate {
  const date = validateDate(input.date);
  const source = "adaptive_plan" as const;
  const decision = decideDailySession(date, decisionOpts(input));
  const prepared = adaptiveSnapshotFromDecision(decision.envelope);
  const bound = decisionBoundMetadata(input, decision.envelope, source);
  const constraintsJson = normalizeOptionalJson(bound.constraints);
  const provenanceJson = normalizeOptionalJson({
    ...bound.provenance,
    daily_decision: dailyDecisionContext(decision.envelope),
  });
  const requestFingerprintValue = requestFingerprint({
    date,
    source,
    plan_day_id: prepared.plan_day_id,
    payload: prepared.payload,
    constraints_json: constraintsJson,
    canonical_agent_job_id: null,
  });
  return {
    date,
    source,
    decision,
    prepared,
    constraints_json: constraintsJson,
    provenance_json: provenanceJson,
    request_fingerprint: requestFingerprintValue,
    preview: {
      date,
      source,
      kind: decision.envelope.kind,
      policy_version: decision.envelope.policy_version,
      input_fingerprint: decision.envelope.input_fingerprint,
      title: prepared.payload.title,
      focus: prepared.payload.focus,
      item_count: prepared.payload.items.length,
      est_minutes: prepared.payload.est_minutes,
      shortened:
        decision.envelope.kind === "train" && decision.envelope.caps.volume === "reduced",
      constraints: athleteFacingPreviewConstraints(decision.envelope),
      primary_rationale:
        boundedProse(decision.envelope.rationale[0]?.text, 300) ??
        boundedProse(prepared.payload.why, 300) ??
        "Built from today's training and recovery picture.",
    },
  };
}

export function previewAdaptiveDailySession(
  input: Pick<PrepareDailySessionInput, "date" | "constraints" | "provenance" | "train_anyway"> = {}
): AdaptiveDailySessionPreview {
  return buildAdaptiveDailySessionCandidate(input).preview;
}

function canonicalAgentSuggestion(jobIdRaw: unknown, date: string) {
  const jobId = Number(jobIdRaw);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    fail(
      "agent_job_required",
      "agent_suggest requires a completed session-suggest agent_job_id; use athlete_override for a user-authored session"
    );
  }
  const job = getAgentJob(jobId) as any;
  // A Stage-3 bounded composition (session_compose) accepts the same way as a
  // session_suggest — both produce a normalized `result.session` the athlete can
  // durably accept without mutating the weekly plan.
  if (!job || (job.kind !== "session_suggest" && job.kind !== "session_compose")) {
    fail("agent_job_invalid", "agent_job_id must reference a session-suggest or session-compose job");
  }
  if (job.status !== "done" || job.result?.ok !== true || !job.result?.session) {
    fail("agent_job_not_ready", "agent_job_id must reference a completed, successful session suggestion");
  }
  const jobDate = String(job.input?.date ?? "").trim();
  if (jobDate !== date) {
    fail("agent_job_date_mismatch", "agent_job_id does not belong to the requested daily-session date");
  }
  const canonicalConstraints: Record<string, unknown> = {};
  for (const key of ["minutes", "equipment", "focus", "constraints"] as const) {
    if (job.input?.[key] != null && job.input[key] !== "") canonicalConstraints[key] = job.input[key];
  }
  return {
    kind: job.kind as "session_suggest" | "session_compose",
    session: job.result.session,
    normalized: job.result.session_normalization === DAILY_SESSION_SUGGESTION_NORMALIZATION,
    envelope:
      job.kind === "session_compose" &&
      job.result.envelope &&
      typeof job.result.envelope === "object" &&
      typeof job.result.envelope.input_fingerprint === "string"
        ? (job.result.envelope as DailyDecisionEnvelope)
        : null,
    constraints: canonicalConstraints,
    decision_opts: agentDecisionOpts((job.input ?? {}) as Record<string, unknown>),
    provenance: {
      verification: "verified_agent_job",
      operation: job.kind,
      agent_job_id: jobId,
      agent: job.chosen_agent ?? job.result.agent ?? null,
      verified: job.result.verified ?? null,
      tried: Array.isArray(job.result.tried) ? job.result.tried : [],
    },
  };
}

function sessionRowsForDate(date: string): any[] {
  return db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM logged_sets ls WHERE ls.session_id = s.id) AS set_count,
              (SELECT COUNT(*) FROM session_skips ss WHERE ss.session_id = s.id) AS skip_count
         FROM sessions s WHERE s.date = ? ORDER BY s.id`
    )
    .all(date) as any[];
}

function meaningfulSessionReasons(session: any): string[] {
  const reasons: string[] = [];
  if (Number(session?.set_count ?? 0) > 0) reasons.push("logged sets");
  if (Number(session?.skip_count ?? 0) > 0) reasons.push("session skips");
  if (session?.finished_at) reasons.push("finished session");
  if (session?.duration_min != null) reasons.push("recorded duration");
  if (boundedText(session?.notes, 1000)) reasons.push("session notes");
  if (session?.soreness != null || session?.performance != null || boundedText(session?.joint_pain, 300)) {
    reasons.push("session feedback");
  }
  if (boundedText(session?.garmin_json, 12_000)) reasons.push("linked strength activity");
  return reasons;
}

function sportKey(value: unknown): string | null {
  const text = String(value ?? "").toLowerCase();
  if (/\b(run|running|jog|jogging)\b/.test(text)) return "run";
  if (/\b(ride|riding|bike|biking|cycle|cycling)\b/.test(text)) return "ride";
  if (/\b(row|rowing|erg)\b/.test(text)) return "row";
  if (/\b(swim|swimming)\b/.test(text)) return "swim";
  if (/\b(hike|hiking)\b/.test(text)) return "hike";
  if (/\b(walk|walking)\b/.test(text)) return "walk";
  return null;
}

function matchingCardioEvidence(date: string, items: unknown): boolean {
  const cardioItems = (Array.isArray(items) ? items : []).filter((item: any) => item?.kind === "cardio");
  if (!cardioItems.length) return false;
  const activities = db
    .prepare(`SELECT type, raw_text, duration_min, distance_km FROM activities WHERE date = ? ORDER BY id`)
    .all(date) as any[];
  return cardioItems.some((item: any) => {
    const plannedSport = sportKey(item.exercise);
    if (!plannedSport) return false;
    return activities.some((activity) => {
      const actualSport = sportKey(`${activity.type ?? ""} ${activity.raw_text ?? ""}`);
      if (actualSport !== plannedSport) return false;
      const comparisons: boolean[] = [];
      const plannedDuration = finite(item.target_duration_min);
      const actualDuration = finite(activity.duration_min);
      if (plannedDuration && actualDuration)
        comparisons.push(Math.abs(actualDuration - plannedDuration) / plannedDuration <= 0.35);
      const plannedDistance = finite(item.target_distance_km);
      const actualDistance = finite(activity.distance_km);
      if (plannedDistance && actualDistance)
        comparisons.push(Math.abs(actualDistance - plannedDistance) / plannedDistance <= 0.35);
      // Date + sport alone is intentionally insufficient: an unrelated earlier
      // run must not lock a strength/mixed session unless its prescription agrees.
      return comparisons.some(Boolean);
    });
  });
}

function assertSessionsUnstarted(date: string, sessions: any[], compositionItems: unknown): void {
  for (const session of sessions) {
    const reasons = meaningfulSessionReasons(session);
    if (reasons.length) {
      fail(
        "daily_session_locked",
        `daily session cannot be changed because session ${session.id} already has ${reasons.join(", ")}`
      );
    }
  }
  if (matchingCardioEvidence(date, compositionItems)) {
    fail("daily_session_locked", "daily session cannot be changed because its matching cardio work is already logged");
  }
}

function activeCompositionRow(date: string): any {
  return db
    .prepare(
      `SELECT * FROM daily_session_compositions
        WHERE date = ? AND status = 'active' ORDER BY version DESC LIMIT 1`
    )
    .get(date);
}

function hydrate(row: any) {
  if (!row) return null;
  const { items_json, constraints_json, provenance_json, request_fingerprint: _requestFingerprint, ...rest } = row;
  const provenance = parseJson(provenance_json);
  const rawItems = parseJson(items_json);
  const decisionIds = Array.isArray(rawItems)
    ? Array.from(
        new Set(
          rawItems
            .map((item: any) => boundedNumber(item?.brain_decision_id, 1, Number.MAX_SAFE_INTEGER, true))
            .filter((id: number | null): id is number => id != null)
        )
      )
    : [];
  const appliedDecisionIds = new Set<number>(
    decisionIds.length
      ? (
          db
            .prepare(
              `SELECT id FROM brain_decisions
                WHERE status = 'applied' AND id IN (${decisionIds.map(() => "?").join(",")})`
            )
            .all(...decisionIds) as Array<{ id: number }>
        ).map((decision) => Number(decision.id))
      : []
  );
  const items = Array.isArray(rawItems)
    ? rawItems.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? (() => {
              const record = item as Record<string, unknown>;
              const decisionId = boundedNumber(record.brain_decision_id, 1, Number.MAX_SAFE_INTEGER, true);
              const decisionStillApplied = decisionId == null || appliedDecisionIds.has(decisionId);
              return {
                ...record,
                note: dedupeStartLight(record.note),
                brain_decision_id: decisionStillApplied ? decisionId : null,
                brain_change_summary: decisionStillApplied
                  ? durableSnapshotText(record.brain_change_summary, 500)
                  : null,
                brain_change_reason: decisionStillApplied
                  ? durableSnapshotText(record.brain_change_reason, 600)
                  : null,
                brain_change_reason_provenance: decisionStillApplied
                  ? record.brain_change_reason_provenance ?? null
                  : null,
                brain_change_reversible: decisionStillApplied
                  ? record.brain_change_reversible == null
                    ? null
                    : record.brain_change_reversible === true
                  : null,
              };
            })()
          : item
      )
    : [];
  return {
    ...rest,
    why: durableSnapshotText(rest.why, 600),
    items,
    constraints: parseJson(constraints_json),
    provenance,
    decision:
      provenance && typeof provenance === "object" && !Array.isArray(provenance)
        ? ((provenance as Record<string, unknown>).daily_decision ?? null)
        : null,
  };
}

export function getActiveDailySession(date?: string) {
  const validDate = validateDate(date);
  return hydrate(
    db
      .prepare(
        `SELECT * FROM daily_session_compositions WHERE date = ? AND status = 'active' ORDER BY version DESC LIMIT 1`
      )
      .get(validDate)
  );
}

export function getActiveDailySessionForSession(sessionId: number) {
  if (!Number.isInteger(Number(sessionId)) || Number(sessionId) <= 0) return null;
  return hydrate(
    db
      .prepare(`SELECT * FROM daily_session_compositions WHERE session_id = ? AND status = 'active' LIMIT 1`)
      .get(Number(sessionId))
  );
}

export function prepareDailySession(input: PrepareDailySessionInput = {}) {
  const date = validateDate(input.date);
  if (input.expected_active_id !== undefined) {
    const expectedId = Number(input.expected_active_id);
    if (!Number.isInteger(expectedId) || expectedId <= 0) {
      fail("daily_session_changed", "expected_active_id must identify the cached active daily session");
    }
    const active = activeCompositionRow(date);
    if (!active) fail("daily_session_missing", "no active daily session exists for the requested date");
    if (Number(active.id) !== expectedId) {
      fail("daily_session_changed", "the active daily session changed after the cached copy was read");
    }
    return { ok: true as const, daily_session: hydrate(active), session_id: active.session_id, reused: true };
  }
  const source = sourceOf(input.source);
  const adaptiveCandidate = source === "adaptive_plan" ? buildAdaptiveDailySessionCandidate(input) : null;
  if (input.expected_input_fingerprint != null) {
    const expected = String(input.expected_input_fingerprint).trim();
    if (!adaptiveCandidate || !/^[a-f0-9]{64}$/.test(expected)) {
      fail(
        "daily_session_preview_invalid",
        "expected_input_fingerprint requires a valid adaptive-session preview"
      );
    }
    if (adaptiveCandidate.preview.input_fingerprint !== expected) {
      fail(
        "daily_session_preview_stale",
        "Today’s session changed with your latest training picture. Review the updated preview before starting.",
        adaptiveCandidate.preview
      );
    }
  }
  const existingRow = activeCompositionRow(date);
  const canRefreshAdaptive =
    !!existingRow && source === "adaptive_plan" && exactPlanRetry(existingRow, input, source);
  if (existingRow && input.expected_input_fingerprint != null && !canRefreshAdaptive) {
    fail(
      "daily_session_active_changed",
      "Another accepted session now owns this date. Review that session before continuing."
    );
  }
  if (existingRow && !input.replace && !canRefreshAdaptive) {
    return { ok: true as const, daily_session: hydrate(existingRow), session_id: existingRow.session_id, reused: true };
  }
  if (existingRow && input.replace && source === "manual_plan" && exactPlanRetry(existingRow, input, source)) {
    return { ok: true as const, daily_session: hydrate(existingRow), session_id: existingRow.session_id, reused: true };
  }

  const canonicalAgent = source === "agent_suggest" ? canonicalAgentSuggestion(input.agent_job_id, date) : null;
  // Decide before snapshotting. Adaptive preparation is authored from this one
  // envelope, not from an independent weekly-plan read. Manual plan pulls remain
  // athlete-owned snapshots but still carry the same visible safety context.
  let decision =
    source === "adaptive_plan"
      ? adaptiveCandidate!.decision
      : source === "manual_plan"
        ? decideDailySession(date, decisionOpts(input))
      : canonicalAgent
        ? decideDailySession(date, canonicalAgent.decision_opts)
        : null;
  // Choosing a weekly plan day is explicit training intent. On a baseline rest
  // read, persist that consent as train_anyway and author the snapshot inside the
  // same conservative caps as every other train-intent override.
  if (
    source === "manual_plan" &&
    decision &&
    decision.envelope.baseline_kind === "rest" &&
    decision.envelope.request.train_anyway !== true
  ) {
    decision = decideDailySession(date, { ...decisionOpts(input), train_anyway: true });
  }
  // There is deliberately NO equivalent branch for agent_suggest. Acceptance must
  // keep revalidating a suggestion against the CURRENT envelope, because a job
  // drafted before the athlete's recovery turned may be days old — reading that
  // stale draft as consent is exactly what the rest-envelope revalidation exists to
  // prevent. Train intent for an agent suggestion is recorded where it is actually
  // given: on the job, at the moment the athlete asks (see /session-suggest's
  // train_anyway and agentDecisionOpts).
  const manualPlan = source === "manual_plan" ? planSnapshot(date, input.day_number) : null;
  const boundedManual =
    manualPlan && decision
      ? normalizeComposedSession(
          {
            name: manualPlan.payload.title,
            focus: manualPlan.payload.focus,
            why: manualPlan.payload.why,
            est_minutes: manualPlan.payload.est_minutes,
            items: manualPlan.payload.items,
          },
          decision.envelope
        ).session ??
        deterministicComposedSession({
          ...decision.envelope,
          template: {
            ...decision.envelope.template,
            day_number:
              input.day_number != null ? Number(input.day_number) : decision.envelope.template.day_number,
            plan_day_id: manualPlan.plan_day_id,
            intent: "template",
          },
        })
      : null;
  const boundedAgent =
    canonicalAgent && decision
      ? normalizeComposedSession(canonicalAgent.session, decision.envelope).session ??
        deterministicComposedSession(decision.envelope)
      : null;
  const prepared =
    source === "adaptive_plan" && decision
      ? adaptiveCandidate!.prepared
      : source === "manual_plan"
        ? {
            plan_day_id: manualPlan!.plan_day_id,
            payload: normalizeSessionPayload(
              boundedManual ?? {
                name: manualPlan!.payload.title,
                focus: manualPlan!.payload.focus,
                why: manualPlan!.payload.why,
                est_minutes: manualPlan!.payload.est_minutes,
                items: manualPlan!.payload.items,
              },
              false
            ),
          }
        : {
            plan_day_id:
              canonicalAgent?.kind === "session_compose" &&
              decision?.envelope &&
              decision.envelope.kind !== "rest"
                ? envelopePlanDayId(decision.envelope)
                : null,
            payload: normalizeSessionPayload(
              boundedAgent ?? input.session,
              source === "agent_suggest",
              source === "agent_suggest",
              source === "athlete_override" || decision?.envelope.kind === "rest",
              source === "athlete_override",
              canonicalAgent != null
            ),
          };
  const bound = decision ? decisionBoundMetadata(input, decision.envelope, source) : null;
  const constraintsJson =
    adaptiveCandidate?.constraints_json ??
    normalizeOptionalJson(
      bound
        ? { ...bound.constraints, ...normalizedRecord(canonicalAgent?.constraints) }
        : canonicalAgent?.constraints ?? input.constraints
    );
  const provenanceJson =
    adaptiveCandidate?.provenance_json ??
    normalizeOptionalJson(
      bound
        ? {
            ...bound.provenance,
            ...(canonicalAgent?.provenance ?? {}),
            daily_decision: dailyDecisionContext(decision!.envelope),
          }
        : canonicalAgent?.provenance ?? input.provenance
    );
  const fingerprint =
    adaptiveCandidate?.request_fingerprint ??
    requestFingerprint({
      date,
      source,
      plan_day_id: prepared.plan_day_id,
      payload: prepared.payload,
      constraints_json: constraintsJson,
      canonical_agent_job_id: canonicalAgent ? Number(canonicalAgent.provenance.agent_job_id) : null,
    });
  if (existingRow?.request_fingerprint === fingerprint) {
    return { ok: true as const, daily_session: hydrate(existingRow), session_id: existingRow.session_id, reused: true };
  }

  return withSqliteSavepoint("prepare_daily_session", () => {
    const current = activeCompositionRow(date);
    if (current?.request_fingerprint === fingerprint) {
      return { ok: true as const, daily_session: hydrate(current), session_id: current.session_id, reused: true };
    }
    if (current && !input.replace) {
      const currentCanRefresh =
        source === "adaptive_plan" && exactPlanRetry(current, input, source);
      if (!currentCanRefresh) {
        return { ok: true as const, daily_session: hydrate(current), session_id: current.session_id, reused: true };
      }
    }
    const sameDateSessions = sessionRowsForDate(date);
    const lockItems = current ? parseJson(current.items_json) : prepared.payload.items;
    if (
      current &&
      (exactPlanRetry(current, input, source) || exactAgentJobRetry(current, input, source)) &&
      (sameDateSessions.some((session) => meaningfulSessionReasons(session).length > 0) ||
        matchingCardioEvidence(date, lockItems))
    ) {
      return { ok: true as const, daily_session: hydrate(current), session_id: current.session_id, reused: true };
    }
    assertSessionsUnstarted(date, sameDateSessions, lockItems);
    let session: any;
    if (current) {
      session = sameDateSessions.find((candidate) => Number(candidate.id) === Number(current.session_id));
      if (!session) fail("daily_session_session_missing", "the active daily session is missing its workout session");
    } else {
      session = sameDateSessions[0] ?? getOrCreateSessionRow(date, null);
    }

    if (current) {
      db.prepare(
        `UPDATE daily_session_compositions
            SET status = 'superseded', superseded_at = datetime('now')
          WHERE id = ? AND status = 'active'`
      ).run(current.id);
    }
    // A plan snapshot binds the existing session to that plan day. A custom
    // suggestion owns no weekly-template provenance, so clear any stale link.
    db.prepare(`UPDATE sessions SET plan_day_id = ? WHERE id = ?`).run(prepared.plan_day_id, session.id);
    const nextVersion = Number(
      (
        db
          .prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM daily_session_compositions WHERE date = ?`)
          .get(date) as any
      )?.v ?? 1
    );
    const info = db
      .prepare(
        `INSERT INTO daily_session_compositions
          (version, session_id, date, source, status, plan_day_id, title, focus, why, est_minutes,
           items_json, constraints_json, provenance_json, request_fingerprint)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nextVersion,
        session.id,
        date,
        source,
        prepared.plan_day_id,
        prepared.payload.title,
        prepared.payload.focus,
        prepared.payload.why,
        prepared.payload.est_minutes,
        JSON.stringify(prepared.payload.items),
        constraintsJson,
        provenanceJson,
        fingerprint
      );
    const dailySession = hydrate(
      db.prepare(`SELECT * FROM daily_session_compositions WHERE id = ?`).get(info.lastInsertRowid)
    );
    // Persist the exact envelope that authored this composition. Best-effort:
    // observability must never make a usable session fail.
    if (decision) {
      try {
        recordDailySessionDecision(decision.envelope, { composition_id: Number(info.lastInsertRowid) });
      } catch {
        /* observability write never blocks preparation */
      }
    }
    return { ok: true as const, daily_session: dailySession, session_id: session.id, reused: false };
  });
}

export function listDailySessionCompositions() {
  return (db.prepare(`SELECT * FROM daily_session_compositions ORDER BY date DESC, version DESC`).all() as any[]).map(
    hydrate
  );
}
