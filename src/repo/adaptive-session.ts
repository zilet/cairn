import crypto from "node:crypto";
import { truncateAtWord } from "../brain/contract-utils.js";
import { normalizePrescriptionItem, SESSION_PRESCRIPTION_LIMITS } from "../contracts/session-prescription.js";
import { enforceSupersetRules, validSupersetGroup } from "./composition-pairing.js";
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
import { isKnownBodyweightMovement, normalizedExerciseKey } from "./exercise-canon.js";
import { exerciseInputFor } from "./exercise-input.js";
import { findExercise, recentWorkingSeconds, recentWorkingWeight } from "./exercises.js";
import { getPlanDay } from "./plan.js";
import { selectedPlanDayForDate } from "./plan-selection.js";
import { getOrCreateSessionRow } from "./session-core.js";
import { meaningfulSessionReasons, SESSION_STARTED_COUNTS } from "./session-started.js";
import {
  unstartedChosenCard,
  dailySessionOwner,
  dailySessionOwnerOf,
  type DailySessionOwner,
} from "./open-session.js";
import { localDateISO } from "./shared.js";
import { withSqliteSavepoint } from "./sqlite-savepoint.js";
import { stableJson, finite } from "../lib/numbers.js";

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
export const SESSION_LOAD_BASES = ["bodyweight", "assisted", "loaded", "open"] as const;
export type SessionLoadBasis = (typeof SESSION_LOAD_BASES)[number];

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
  /**
   * INTERNAL. Re-author the snapshot even when this request is byte-identical to the
   * active one (`exactPlanRetry`). That retry guard compares the REQUEST — constraints
   * and provenance — never the plan day it snapshots, so an unchanged request over a
   * CHANGED plan day short-circuits to the stale composition. The same-day recompose
   * (`refreshPreparedDayForPlanChange`) is exactly that request, so it says so here.
   * The request-fingerprint guard still returns the existing row when the composed
   * payload really is identical, so this never churns a version for nothing. No public
   * surface passes it.
   */
  force_recompose?: boolean;
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
  constraints: string[];
  primary_rationale: string;
}

export class DailySessionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly preview?: AdaptiveDailySessionPreview,
    /** The session that owns the date, on a conflict a client resolves by opening it. */
    public readonly owner?: DailySessionOwner | null
  ) {
    super(message);
    this.name = "DailySessionError";
  }
}

function fail(
  code: string,
  message: string,
  preview?: AdaptiveDailySessionPreview,
  owner?: DailySessionOwner | null
): never {
  throw new DailySessionError(code, message, preview, owner ?? undefined);
}

// The ownership conflicts' athlete-facing words. A conflict's `error` is printed to a
// person as it stands, so it names no ids and no engineering ("session 12 already has
// logged sets"); the machine detail rides on `code` and `owner`. Every one of these
// conflicts carries the owner the client opens, or — `daily_session_missing` with no
// owner — says plainly that the day is free.
const OWNER_HOLDS_DAY_MESSAGE = "Another session already holds this day. Open it to carry on.";
const OWNER_CHANGED_MESSAGE = "Your session changed since this screen loaded. Open the current one to carry on.";
const DAY_FREE_MESSAGE = "That session was cleared, so the day is free. Start a new one whenever you like.";
const STARTED_LOCK_MESSAGE = "You've already logged work on this session, so it stays as it is. Open it to carry on.";
const STARTED_DISCARD_MESSAGE = "This session has logged work, so it stays. Open it to carry on.";

// The PWA's own empty "Open session" door (today-screen.ts). The server reaches for it
// in exactly one place: an OPEN request on a date whose session row already exists
// (logged outside any composition) but which has no adaptive candidate to bind — the
// row is adopted as the athlete's open session rather than refused.
const OPEN_SESSION_PAYLOAD = {
  name: "Open session",
  focus: "Choose as you go",
  why: "A blank session for whatever feels useful today.",
  est_minutes: null,
  items: [],
} as const;

// "This date has no weekly template day to build an adaptive candidate from." A routine
// ABSENCE, not malformed input: the PWA asks for a preview on EVERY Today render, so the
// read surfaces answer it with `200 + null` — the same absence contract the other
// single-row reads use — rather than a 400 that reads as a defect in operator telemetry.
export const DAILY_SESSION_NO_TEMPLATE = "daily_session_no_template";

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

function trustedReach(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const note = durableSnapshotText(rec.note, 500);
  const weight = boundedNumber(rec.weight, -1000, 5000);
  const reps = boundedNumber(rec.reps, 1, 50, true);
  const amrap = rec.amrap === true;
  if (note == null && weight == null && reps == null && !amrap) return null;
  return {
    ...(weight != null ? { weight } : {}),
    ...(reps != null ? { reps } : {}),
    ...(note != null ? { note } : {}),
    ...(amrap ? { amrap: true } : {}),
  };
}

function trustedItemMetadata(
  item: Record<string, unknown>,
  trusted: boolean
): Record<string, unknown> {
  if (!trusted) return {};
  const provenance = normalizeJsonValue(item.brain_change_reason_provenance);
  const reach = trustedReach(item.reach);
  // Server-derived, like the brain metadata beside it: the movement this slot used
  // to hold before the envelope moved the work off a still-recovering group. Kept
  // omit-when-absent so an ordinary item's snapshot (and therefore its request
  // fingerprint) is unchanged by the field existing at all.
  const substitutionFor = boundedText(item.substitution_for, 120);
  // Server-marked: the block this one-set agent single leads, so the card list can
  // fold the two into one card. Omit-when-absent like substitution_for.
  const topSetOf = boundedText(item.top_set_of, 120);
  return {
    brain_decision_id: boundedNumber(item.brain_decision_id, 1, Number.MAX_SAFE_INTEGER, true),
    brain_change_summary: durableSnapshotText(item.brain_change_summary, 500),
    brain_change_reason: durableSnapshotText(item.brain_change_reason, 600),
    brain_change_reason_provenance:
      provenance && typeof provenance === "object" && !Array.isArray(provenance) ? provenance : null,
    brain_change_reversible:
      item.brain_change_reversible == null ? null : item.brain_change_reversible === true,
    ...(reach ? { reach } : {}),
    ...(substitutionFor ? { substitution_for: substitutionFor } : {}),
    ...(topSetOf ? { top_set_of: topSetOf } : {}),
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
    // The athlete's own same-day request (daily-decision.ts), omit-when-idle so an
    // ordinary row's constraints/provenance serialize exactly as before.
    ...(request?.same_day_request ? { same_day_request: request.same_day_request } : {}),
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

// The plan day an athlete's own session is still OF. An override is the athlete
// reshaping today, not abandoning the week: re-authoring the day that was already
// "Upper Body & Arms" must not turn it into an anonymous "Session" and cost the ring
// its anchor. An explicit day_number names the day when it is on the plan; otherwise
// the link the day already holds — the active composition's, else the session row's —
// is kept.
// Nothing links a day that never had one (an open "just start" on an empty plan).
// The content resolvers still drop a link the logged work no longer resembles
// (resolveSessionPlanDay), so a kept link never forces a wrong name.
function athleteOverridePlanDayId(date: string, dayNumber: unknown, existingRow: any): number | null {
  if (dayNumber != null) {
    // A day that is not on the plan (renumbered, removed) names nothing: fall back to
    // the link the day already holds rather than refusing the athlete's own session.
    const day = getPlanDay(Number(dayNumber));
    if (day?.id != null) return Number(day.id);
  }
  const sessionId = existingRow ? Number(existingRow.session_id) : null;
  const session =
    sessionId != null
      ? sessionRowsForDate(date).find((row) => Number(row.id) === sessionId)
      : sessionRowsForDate(date)[0];
  const linked = Number(existingRow?.plan_day_id ?? session?.plan_day_id);
  if (!Number.isInteger(linked) || linked <= 0) return null;
  const live = db
    .prepare(`SELECT id FROM plan_days WHERE id = ? AND COALESCE(day_type, 'training') != 'rest'`)
    .get(linked) as any;
  return live ? Number(live.id) : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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

export function safeAgentWeight(exercise: string, requested: unknown): number | null {
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

function resolveAgentWeight(
  exercise: string,
  requested: unknown,
  agentSource: boolean,
  athleteSource: boolean,
  trustedAgentNormalized: boolean
): number | null {
  if (agentSource) {
    return trustedAgentNormalized
      ? boundedNumber(requested, -1000, 5000)
      : safeAgentWeight(exercise, requested);
  }
  return athleteSource ? boundedNumber(requested, -1000, 5000) : finite(requested);
}

function resolveAgentSeconds(
  exercise: string,
  requested: unknown,
  agentSource: boolean,
  trustedAgentNormalized: boolean
): number | null {
  if (agentSource) {
    return trustedAgentNormalized
      ? boundedNumber(requested, 1, SESSION_PRESCRIPTION_LIMITS.targetSeconds, true)
      : safeAgentSeconds(exercise, requested);
  }
  return boundedNumber(requested, 1, SESSION_PRESCRIPTION_LIMITS.targetSeconds, true);
}

function itemLoadBasis(exercise: string, weight: number | null): SessionLoadBasis {
  if (weight != null && weight < 0) return "assisted";
  if (weight != null && weight > 0) return "loaded";
  const row = findExercise(exercise);
  if (isKnownBodyweightMovement(exercise, row?.equipment)) return "bodyweight";
  return "open";
}

function prefixNotes(head: unknown, rest: unknown): string | null {
  const a = boundedProse(head, 500);
  const b = boundedProse(rest, 500);
  if (!a) return b;
  if (!b || b === a || b.startsWith(a)) return a;
  return boundedProse(`${a} ${b}`, 500);
}

function itemReps(item: Record<string, unknown>): number | null {
  if (item.kind === "cardio" || item.mode === "timed") return null;
  const lo = finite(item.rep_low);
  const hi = finite(item.rep_high);
  if (lo == null && hi == null) return null;
  return lo != null && hi != null && lo === hi ? lo : (lo ?? hi);
}

function normalizeTopSet(
  raw: unknown,
  exercise: string,
  agentSource: boolean,
  athleteSource: boolean,
  trustedAgentNormalized: boolean
): Record<string, unknown> | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const top = raw as Record<string, unknown>;
  const sets = boundedNumber(top.sets, 1, SESSION_PRESCRIPTION_LIMITS.sets, true);
  const reps = boundedNumber(top.reps, 1, SESSION_PRESCRIPTION_LIMITS.reps, true);
  if (sets == null || reps == null) return null;
  return {
    sets,
    reps,
    target_weight: resolveAgentWeight(
      exercise,
      top.target_weight,
      agentSource,
      athleteSource,
      trustedAgentNormalized
    ),
    target_seconds: resolveAgentSeconds(
      exercise,
      top.target_seconds,
      agentSource,
      trustedAgentNormalized
    ),
    rir: boundedNumber(top.rir, 0, 5),
    note: boundedProse(top.note, 500),
  };
}

function sameLoadSign(a: number, b: number): boolean {
  return (a < 0 && b < 0) || (a > 0 && b > 0);
}

function canFoldTopIntoBackoff(
  first: Record<string, unknown>,
  second: Record<string, unknown>
): boolean {
  if (first.kind === "cardio" || second.kind === "cardio") return false;
  if (first.mode === "timed" || second.mode === "timed") return false;
  if (first.mode !== second.mode) return false;
  if (first.top_set || second.top_set) return false;
  const key1 = normalizedExerciseKey(String(first.exercise ?? ""));
  const key2 = normalizedExerciseKey(String(second.exercise ?? ""));
  if (!key1 || key1 !== key2) return false;
  const sets = finite(first.sets);
  if (sets == null || sets < 1 || sets > 2) return false;
  const r1 = itemReps(first);
  const r2 = itemReps(second);
  if (r1 == null || r2 == null || r1 >= r2) return false;
  const w1 = finite(first.target_weight);
  const w2 = finite(second.target_weight);
  if (w1 == null && w2 == null) {
    const hi = finite(first.rep_high);
    return hi != null && hi <= 5;
  }
  // A null-load "top set" over a numbered backoff is meaningless; mixed
  // null/number is not a heavier-first pair.
  if (w1 == null || w2 == null) return false;
  if (!sameLoadSign(w1, w2)) return false;
  return Math.abs(w1) > Math.abs(w2);
}

function foldConsecutiveTopSets(items: Record<string, unknown>[]): Record<string, unknown>[] {
  if (items.length < 2) return items;
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    const next = items[i + 1];
    if (next && canFoldTopIntoBackoff(cur, next)) {
      const existing = next.top_set && typeof next.top_set === "object" ? (next.top_set as Record<string, unknown>) : null;
      const fromCur = cur.top_set && typeof cur.top_set === "object" ? (cur.top_set as Record<string, unknown>) : null;
      out.push({
        ...next,
        position: out.length,
        top_set: {
          sets: finite(cur.sets) ?? 1,
          reps: itemReps(cur),
          target_weight: cur.target_weight ?? null,
          target_seconds: cur.target_seconds ?? null,
          rir: fromCur?.rir ?? null,
          note: prefixNotes(cur.note, fromCur?.note ?? existing?.note),
        },
      });
      i += 1;
      continue;
    }
    out.push({ ...cur, position: out.length });
  }
  return out;
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
  // A mobility drill or stretch is prescribed as reps or a hold, never against a load
  // (repo/exercise-input.ts). An agent's load target or heavier top set on one is
  // dropped here; the athlete can still log a weight through the card's "+ Load".
  const agentMobility = agentSource && exerciseInputFor(exercise, mode).profile === "mobility";
  const targetSeconds =
    mode === "timed" && core.target_seconds != null
      ? resolveAgentSeconds(exercise, core.target_seconds, agentSource, trustedAgentNormalized)
      : null;
  // Timed work may carry a load (lb × time); it resolves through the same load trust boundary.
  const targetWeight = agentMobility
    ? null
    : resolveAgentWeight(exercise, item.target_weight, agentSource, athleteSource, trustedAgentNormalized);
  const topSet = agentMobility
    ? null
    : normalizeTopSet(item.top_set, exercise, agentSource, athleteSource, trustedAgentNormalized);
  return {
    position,
    kind,
    exercise,
    sets: core.sets,
    rep_low: core.rep_low,
    rep_high: core.rep_high,
    target_weight: targetWeight,
    target_seconds: targetSeconds,
    warmup_sets: boundedNumber(item.warmup_sets, 0, 10, true),
    mode,
    note: dedupeStartLight(item.note),
    target_distance_km: null,
    target_duration_min: null,
    target_zone: null,
    interval: null,
    // A group id is an identity, not a magnitude: clamping one onto the range would fold
    // two out-of-range groups into one superset, so an id the card cannot hold is none.
    superset_group: validSupersetGroup(item.superset_group),
    ...(topSet ? { top_set: topSet } : {}),
    load_basis: itemLoadBasis(exercise, targetWeight),
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
  // Every source's supersets meet the same three rules (composition-pairing.ts): two lifts
  // a group, one fixed station a pair, three pairs a session. What a rule took apart rides
  // out with the payload so the prepare result can say it; server-composed cards already
  // passed the same rules, so for them this finds nothing.
  const unpaired = enforceSupersetRules(items);
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
    ...(unpaired.length ? { unpaired } : {}),
  };
}

export interface NormalizeSessionSuggestionOpts {
  // Consecutive same-lift rows fold into `top_set` only on the suggest boundary.
  // Composition must keep two agent rows as two rows and apply its per-item clamp;
  // folding there would expand a heavy single the envelope never authorized.
  foldTopSets?: boolean;
}

// Canonical suggestion boundary used before a result is rendered, cached, or
// written to an agent job. This is intentionally the same agent-source path that
// prepareDailySession re-runs later, making normalization idempotent: the preview
// items are byte-for-byte the items that durable preparation will snapshot.
export function normalizeSessionSuggestionResult(raw: unknown, opts?: NormalizeSessionSuggestionOpts) {
  try {
    const payload = normalizeSessionPayload(raw, true, true);
    return {
      name: payload.title,
      focus: payload.focus,
      why: payload.why,
      est_minutes: payload.est_minutes,
      items: opts?.foldTopSets ? foldConsecutiveTopSets(payload.items) : payload.items,
      // The supersets the rules took apart (normalizeSessionPayload). Omit-when-empty.
      ...(payload.unpaired ? { unpaired: payload.unpaired } : {}),
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
    // exception because its recovery composition is intentionally plan-free. This is a
    // routine ABSENCE, so it carries the code the preview surfaces answer with null.
    fail(DAILY_SESSION_NO_TEMPLATE, "no weekly template day is available for this date");
  }
  const session = deterministicComposedSession(envelope);
  // The same absence one step later: a template day that composes to nothing has no
  // candidate to preview either, and normalizeSessionPayload would report it as
  // "session items are required" — a malformed-input message for what is in fact an
  // empty day. Rest keeps its intentionally item-free composition.
  if (envelope.kind !== "rest" && !(Array.isArray(session.items) && session.items.length)) {
    fail(DAILY_SESSION_NO_TEMPLATE, "no weekly template day is available for this date");
  }
  return {
    // The plan-day lifts the day's budget deferred off this card, for the provenance below
    // (daily-composition.ts ComposedSession.deferred; second review, item 9).
    deferred: Array.isArray(session.deferred) ? session.deferred : [],
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
    // Omit-when-empty: a card that left plan lifts behind never vouches for the plan's
    // volume (session-dose-log.ts sessionCarriedPlannedVolume).
    ...(prepared.deferred.length ? { plan_day_deferred: prepared.deferred } : {}),
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
      `SELECT s.*, ${SESSION_STARTED_COUNTS}
         FROM sessions s WHERE s.date = ? ORDER BY s.id`
    )
    .all(date) as any[];
}

// What locks a day's composition against replacement: work the athlete actually
// did, or words they wrote about it — the one test, session-started.ts. Skips and a
// finish stamp on a session with no logged sets are bookkeeping of the prescription
// being replaced (they are cleared on replace, see prepareDailySession).
function assertSessionsUnstarted(sessions: any[], date: string): void {
  for (const session of sessions) {
    if (meaningfulSessionReasons(session).length) {
      fail("daily_session_locked", STARTED_LOCK_MESSAGE, undefined, dailySessionOwner(date, Number(session.id)));
    }
  }
}

// The session row a date with NO active composition is held by: the one the athlete
// lived on (logged sets, notes, a watch activity — session-started.ts), else the first
// row. Null when the date has no session at all.
function sessionWithoutComposition(sessions: any[]): any | null {
  return sessions.find((session) => meaningfulSessionReasons(session).length > 0) ?? sessions[0] ?? null;
}

function reusedResult(row: any) {
  return { ok: true as const, daily_session: hydrate(row), session_id: row.session_id, reused: true };
}

function isNoTemplate(error: unknown): boolean {
  return error instanceof DailySessionError && error.code === DAILY_SESSION_NO_TEMPLATE;
}

/**
 * The assertion-only path: `expected_active_id` names the composition the caller cached.
 * It matches → that composition, untouched. It does not → the conflict carries the
 * CURRENT owner so the client can open it instead: `daily_session_changed` when another
 * composition holds the date, `daily_session_missing` when none does — with the owner
 * when a session row still holds the date (opened by a plain prepare, which adopts it),
 * and without one when the date is simply free.
 */
function assertActiveDailySession(date: string, expected: unknown) {
  const expectedId = Number(expected);
  if (!Number.isInteger(expectedId) || expectedId <= 0) {
    fail("daily_session_invalid", "expected_active_id must identify the cached active daily session");
  }
  const active = activeCompositionRow(date);
  if (!active) {
    const owner = dailySessionOwnerOf(null, sessionWithoutComposition(sessionRowsForDate(date)));
    fail("daily_session_missing", owner ? OWNER_CHANGED_MESSAGE : DAY_FREE_MESSAGE, undefined, owner);
  }
  if (Number(active.id) !== expectedId) {
    fail("daily_session_changed", OWNER_CHANGED_MESSAGE, undefined, compositionOwner(date, active));
  }
  return reusedResult(active);
}

// An OPEN request (no replace, no reviewed preview) over a plain adaptive composition
// re-takes it from today's picture when the request is the same adaptive one — the
// unstarted-adaptive refresh (a plan edit or a new injury lands before the athlete
// begins). Only while nobody has lived on it and it is not finished: past that, an open
// request hands the owner back exactly as it stands.
function openRefreshesAdaptive(row: any, input: PrepareDailySessionInput, source: DailySessionSource, date: string) {
  if (source !== "adaptive_plan" || !exactPlanRetry(row, input, source)) return false;
  const session = sessionRowsForDate(date).find((candidate) => Number(candidate.id) === Number(row.session_id));
  return !!session && !session.finished_at && meaningfulSessionReasons(session).length === 0;
}

// The owner a conflict carries: the composition row and its session (with set_count).
function compositionOwner(date: string, row: any): DailySessionOwner | null {
  const session = sessionRowsForDate(date).find((candidate) => Number(candidate.id) === Number(row?.session_id));
  return dailySessionOwnerOf(row, session ?? null);
}

// A card ADOPTED onto a session the athlete already lived on (sets logged from chat, MCP or
// the watch before any card existed) was never served for that earlier work. Its
// provenance says so — when, and the last set / skip already on the row — so the
// reconciliation (daily-reconciliation.ts) and every outcome reader treat the earlier
// work as not comparable to this card: no skip, substitution, shortfall or overrun lesson.
function adoptionProvenance(provenanceJson: string | null, sessionId: number): string | null {
  // The stored provenance was already normalized; it is extended, never re-normalized
  // (that would re-apply the key cap to a record the adoption keys just grew).
  const parsed = parseJson(provenanceJson);
  const base = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const lastSet = db.prepare(`SELECT MAX(id) AS id FROM logged_sets WHERE session_id = ?`).get(sessionId) as any;
  const lastSkip = db.prepare(`SELECT MAX(id) AS id FROM session_skips WHERE session_id = ?`).get(sessionId) as any;
  const finished = db.prepare(`SELECT finished_at, date FROM sessions WHERE id = ?`).get(sessionId) as any;
  // The endurance side of the same cut. An activity row's id says when it ENTERED
  // Cairn (AUTOINCREMENT, never reused); its `created_at` is second-grained and a
  // watch row's start time is when it happened, not when Cairn learned of it. So every
  // activity at or below this id was known when the card was bound. A watch run synced
  // after the adoption is above it and is graded like any run under a served card,
  // except one that merely replaced a hand log of the same run made before the
  // adoption (the soft-dedup deletes that log): the hand logs of the date are kept here
  // so the reconciliation can tell.
  const lastActivity = db.prepare(`SELECT MAX(id) AS id FROM activities`).get() as any;
  const handLogs = db
    .prepare(
      `SELECT id, type, duration_min, distance_km FROM activities
        WHERE date = ? AND source IS NULL AND external_id IS NULL ORDER BY id LIMIT 16`
    )
    .all(String(finished?.date ?? "").slice(0, 10)) as any[];
  return JSON.stringify({
    ...base,
    adopted_after_log: true,
    adopted_at: new Date().toISOString(),
    adopted_after_set_id: Number(lastSet?.id) > 0 ? Number(lastSet.id) : 0,
    adopted_after_skip_id: Number(lastSkip?.id) > 0 ? Number(lastSkip.id) : 0,
    adopted_after_activity_id: Number(lastActivity?.id) > 0 ? Number(lastActivity.id) : 0,
    ...(handLogs.length
      ? {
          adopted_activity_logs: handLogs.map((row) => ({
            id: Number(row.id),
            type: row.type == null ? null : String(row.type),
            duration_min: row.duration_min == null ? null : Number(row.duration_min),
            distance_km: row.distance_km == null ? null : Number(row.distance_km),
          })),
        }
      : {}),
    adopted_finished: finished?.finished_at != null,
  });
}

// A replace that authors nothing of the athlete's own: the plan's adaptive day, or an
// EMPTY athlete_override (the "Open session" door, and the client's outbox retry that
// forces replace:true on it). Neither may silently supersede the athlete's chosen card
// (for the empty override that includes a train-by-choice adaptive card; chosenCardOwner).
// An ITEMFUL athlete_override is the athlete writing a new session (Today's editor, chat
// today_session) and still replaces their own card.
function replaceYieldsToChosenCard(input: PrepareDailySessionInput, source: DailySessionSource): boolean {
  if (source === "adaptive_plan") return true;
  if (source !== "athlete_override") return false;
  const items = (input.session as { items?: unknown } | null | undefined)?.items;
  return !Array.isArray(items) || items.length === 0;
}

// The owner of `row` when it is the athlete's unstarted chosen card that holds work
// (open-session.ts unstartedChosenCard — the one predicate), else null. Which cards count
// depends on who replaces: an adaptive replace re-takes its own train-by-choice card, an
// empty override (authoring nothing) yields to it as to any other chosen card.
function chosenCardOwner(date: string, row: any, source: DailySessionSource): DailySessionOwner | null {
  const session =
    sessionRowsForDate(date).find((candidate) => Number(candidate.id) === Number(row?.session_id)) ?? null;
  const replacer = source === "adaptive_plan" ? "adaptive" : "empty_override";
  return unstartedChosenCard(row, session, replacer) ? dailySessionOwnerOf(row, session) : null;
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
              // What the card's log row asks for, read live (a stated override made
              // after the composition was written still lands). Strength items only.
              const input =
                record.kind !== "cardio" && typeof record.exercise === "string" && record.exercise.trim()
                  ? exerciseInputFor(record.exercise, typeof record.mode === "string" ? record.mode : null)
                  : null;
              return {
                ...record,
                ...(input ? { input } : {}),
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

/**
 * Prepare (or open) a date's durable session. Every answer is one of: `ok:true` with the
 * session to open (new, superseding, or `reused`); a conflict carrying the `owner` the
 * client opens instead (or, `daily_session_missing` without one, a free date);
 * `daily_session_preview_stale` with a fresh preview; or a validation refusal.
 *
 * An OPEN request — no `replace`, no `expected_input_fingerprint`, no
 * `expected_active_id` — never conflicts: a date that already has a session answers
 * with it, whatever the request's source (finished included: "Log more" reopens a
 * finished session, and opening never mints a second one). A session row logged outside
 * any composition is adopted, its record left as the athlete wrote it.
 */
export function prepareDailySession(input: PrepareDailySessionInput = {}) {
  const date = validateDate(input.date);
  // Assertion-only: null is the same as absent (the input type admits it).
  if (input.expected_active_id != null) return assertActiveDailySession(date, input.expected_active_id);
  const source = sourceOf(input.source);
  const openIntent = input.replace !== true && input.expected_input_fingerprint == null;
  const openRow = openIntent ? activeCompositionRow(date) : null;
  if (openRow && !openRefreshesAdaptive(openRow, input, source, date)) return reusedResult(openRow);
  let adaptiveCandidate: AdaptiveDailySessionCandidate | null = null;
  if (source === "adaptive_plan") {
    try {
      adaptiveCandidate = buildAdaptiveDailySessionCandidate(input);
    } catch (error) {
      // No adaptive candidate (no weekly template day). An open request still opens what
      // the date has: its composition, or a session row logged outside one, adopted as
      // the athlete's open session. A date with nothing keeps the honest absence.
      if (openIntent && isNoTemplate(error)) {
        if (openRow) return reusedResult(openRow);
        if (sessionRowsForDate(date).length) {
          return prepareDailySession({
            ...input,
            source: "athlete_override",
            session: OPEN_SESSION_PAYLOAD,
            train_anyway: false,
          });
        }
      }
      throw error;
    }
  }
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
    // An EMPTY owner never blocks: a session nobody has lived on (opened on another
    // device, or an accidental "Open session") is superseded by an explicit replace.
    // Two answers still come back as the conflict, carrying the owner so the client
    // can open it instead: a session already lived on, and the athlete's own chosen
    // card that holds work, which an adaptive request must never silently replace.
    const owner = compositionOwner(date, existingRow);
    const replaceable =
      input.replace === true &&
      owner != null &&
      !owner.started &&
      !(replaceYieldsToChosenCard(input, source) && chosenCardOwner(date, existingRow, source));
    if (!replaceable) fail("daily_session_active_changed", OWNER_HOLDS_DAY_MESSAGE, undefined, owner);
  }
  // The same rule without a preview token: a replace that authors nothing of the
  // athlete's (adaptive, or an empty override) never silently takes their own chosen
  // card that holds work. Once that card is lived on, the ordinary lock
  // (assertSessionsUnstarted) answers instead.
  if (existingRow && input.replace && replaceYieldsToChosenCard(input, source)) {
    const owner = chosenCardOwner(date, existingRow, source);
    if (owner) fail("daily_session_active_changed", OWNER_HOLDS_DAY_MESSAGE, undefined, owner);
  }
  if (existingRow && !input.replace && !canRefreshAdaptive) {
    return { ok: true as const, daily_session: hydrate(existingRow), session_id: existingRow.session_id, reused: true };
  }
  if (
    existingRow &&
    input.replace &&
    !input.force_recompose &&
    source === "manual_plan" &&
    exactPlanRetry(existingRow, input, source)
  ) {
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
          decision.envelope,
          // The athlete picked a day of their OWN plan, so the saturated-group
          // substitution law applies: a slot whose group is still recovering is
          // re-pointed at other work from their own week rather than served
          // lighter. The day they chose is still the day they get — and it is a
          // snapshot: nothing is added or raised on top of it (no reach, no earned
          // floor, no progression step above what they wrote).
          { substituteSaturated: true, planSnapshot: true }
        ).session ??
        // Pass the live envelope so reconcile and persist share one object.
        deterministicComposedSession(
          Object.assign(decision.envelope, {
            template: {
              ...decision.envelope.template,
              day_number:
                input.day_number != null ? Number(input.day_number) : decision.envelope.template.day_number,
              plan_day_id: manualPlan.plan_day_id,
              intent: "template",
            },
          }),
          { planSnapshot: true }
        )
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
              source === "athlete_override"
                ? athleteOverridePlanDayId(date, input.day_number, existingRow)
                : canonicalAgent?.kind === "session_compose" &&
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
  // What the superset rules took apart in an authored session (normalizeSessionPayload),
  // carried on every answer below so the caller (the chat reply, an MCP client) can say it.
  const unpairedExtra = prepared.payload.unpaired ? { unpaired: prepared.payload.unpaired } : {};
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
    return {
      ok: true as const,
      daily_session: hydrate(existingRow),
      session_id: existingRow.session_id,
      reused: true,
      ...unpairedExtra,
    };
  }

  return withSqliteSavepoint("prepare_daily_session", () => {
    const current = activeCompositionRow(date);
    if (current?.request_fingerprint === fingerprint) {
      return {
        ok: true as const,
        daily_session: hydrate(current),
        session_id: current.session_id,
        reused: true,
        ...unpairedExtra,
      };
    }
    if (current && !input.replace) {
      const currentCanRefresh =
        source === "adaptive_plan" && exactPlanRetry(current, input, source);
      if (!currentCanRefresh) {
        return { ok: true as const, daily_session: hydrate(current), session_id: current.session_id, reused: true };
      }
    }
    const sameDateSessions = sessionRowsForDate(date);
    if (
      current &&
      (exactPlanRetry(current, input, source) || exactAgentJobRetry(current, input, source)) &&
      sameDateSessions.some((session) => meaningfulSessionReasons(session).length > 0)
    ) {
      return { ok: true as const, daily_session: hydrate(current), session_id: current.session_id, reused: true };
    }
    let session: any;
    // A session the athlete lived on before any composition existed (sets logged from
    // chat, MCP or the watch, or a day from before compositions): there is no prescription
    // to protect, so a prepare that is not a replace ADOPTS it — the composition binds to
    // that row and the row stays exactly as the athlete left it (its plan-day link, skips
    // and finish stamp untouched). A replace is refused with the row as the owner; the
    // plain prepare is how a client opens it.
    let adoptLived = false;
    if (current) {
      assertSessionsUnstarted(sameDateSessions, date);
      session = sameDateSessions.find((candidate) => Number(candidate.id) === Number(current.session_id));
      if (!session) fail("daily_session_session_missing", "the active daily session is missing its workout session");
    } else {
      const held = sessionWithoutComposition(sameDateSessions);
      adoptLived = held != null && meaningfulSessionReasons(held).length > 0;
      if (adoptLived && input.replace) {
        fail("daily_session_locked", STARTED_LOCK_MESSAGE, undefined, dailySessionOwnerOf(null, held));
      }
      session = held ?? getOrCreateSessionRow(date, null);
    }

    if (current) {
      db.prepare(
        `UPDATE daily_session_compositions
            SET status = 'superseded', superseded_at = datetime('now')
          WHERE id = ? AND status = 'active'`
      ).run(current.id);
    }
    if (!adoptLived) {
      // A plan snapshot binds the existing session to that plan day. A custom
      // suggestion owns no weekly-template provenance, so clear any stale link; an
      // athlete override keeps the day it was already of (athleteOverridePlanDayId).
      db.prepare(`UPDATE sessions SET plan_day_id = ? WHERE id = ?`).run(prepared.plan_day_id, session.id);
      // The session has no logged sets (assertSessionsUnstarted just proved it), so
      // any skips and finish stamp belong to the prescription being replaced: an
      // athlete who skipped every lift of a day they then abandoned is starting
      // over, not continuing. Clear them so the new composition opens clean.
      db.prepare(`DELETE FROM session_skips WHERE session_id = ?`).run(session.id);
      db.prepare(`UPDATE sessions SET finished_at = NULL WHERE id = ?`).run(session.id);
    }
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
        adoptLived ? adoptionProvenance(provenanceJson, Number(session.id)) : provenanceJson,
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
    return { ok: true as const, daily_session: dailySession, session_id: session.id, reused: false, ...unpairedExtra };
  });
}

export interface DiscardDailySessionInput {
  date?: string;
  /** The active composition the caller read; a different one is a conflict, never discarded blind. */
  expected_active_id?: unknown;
}

export interface DiscardDailySessionResult {
  ok: true;
  date: string;
  discarded: true;
  daily_session_id: number;
  session_id: number;
}

/**
 * Discard an accidental, EMPTY session: the date's active composition is superseded
 * and its zero-set session row deleted in one unit, so the date is free again and
 * `getOrCreateSessionRow` cannot hand the shell back to the next read or write.
 *
 * Only a session nobody has lived on (session-started.ts) may go. A started one is
 * refused with the `daily_session_locked` conflict and its owner — deleting logged
 * work is not this door. A stale `expected_active_id` is `daily_session_changed` with
 * the owner as it now stands.
 *
 * Deleting the session row cascades what hangs off it by foreign key — its skips and
 * every composition version bound to it (`daily_session_decisions.composition_id` is
 * set null). An offline-outbox key already stored for this session (a prepare, a
 * skip) keeps replaying its original answer and mints nothing; the client's next
 * `expected_active_id` assertion then reads `daily_session_missing`.
 */
export function discardDailySession(input: DiscardDailySessionInput = {}): DiscardDailySessionResult {
  const date = validateDate(input.date);
  const expectedId = Number(input.expected_active_id);
  if (input.expected_active_id == null || !Number.isInteger(expectedId) || expectedId <= 0) {
    fail("daily_session_invalid", "expected_active_id must identify the active daily session to discard");
  }
  return withSqliteSavepoint("discard_daily_session", () => {
    const active = activeCompositionRow(date);
    if (!active) {
      const owner = dailySessionOwnerOf(null, sessionWithoutComposition(sessionRowsForDate(date)));
      fail("daily_session_missing", owner ? OWNER_CHANGED_MESSAGE : DAY_FREE_MESSAGE, undefined, owner);
    }
    const session = sessionRowsForDate(date).find((row) => Number(row.id) === Number(active.session_id)) ?? null;
    if (Number(active.id) !== expectedId) {
      fail("daily_session_changed", OWNER_CHANGED_MESSAGE, undefined, dailySessionOwnerOf(active, session));
    }
    if (session && meaningfulSessionReasons(session).length) {
      fail("daily_session_locked", STARTED_DISCARD_MESSAGE, undefined, dailySessionOwnerOf(active, session));
    }
    db.prepare(
      `UPDATE daily_session_compositions
          SET status = 'superseded', superseded_at = datetime('now')
        WHERE id = ? AND status = 'active'`
    ).run(active.id);
    if (session) {
      db.prepare(`DELETE FROM session_skips WHERE session_id = ?`).run(session.id);
      // What is left bound to an unstarted session is only INFERRED exposure (a stated
      // pain answer made it started, above) — inferred from sets that no longer exist.
      // Deleting the row would null its session_id (ON DELETE SET NULL), and the same
      // exposure already on record with no session collides on the null-session unique
      // index; the evidence it stood for is gone, so it goes with the session.
      db.prepare(`DELETE FROM movement_tolerance_observations WHERE session_id = ? AND evidence <> 'stated'`).run(
        session.id
      );
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(session.id);
    }
    return {
      ok: true as const,
      date,
      discarded: true as const,
      daily_session_id: Number(active.id),
      session_id: Number(active.session_id),
    };
  });
}

export interface RefreshPreparedDayInput {
  date?: string;
  /** Plan days the change touched. Empty/omitted means "whichever day this date holds". */
  day_numbers?: readonly number[];
  /**
   * A person's own plan save that REMOVED the day this snapshot was taken from (the
   * caller read it before the save — see activeCompositionPlanDayNumber): retire the
   * unstarted snapshot instead of leaving it standing, so the next Today read composes
   * from the plan as it is now. Off for every other caller.
   */
  retire_when_day_gone?: boolean;
}

export type RefreshPreparedDayReason =
  | "no_active_composition"
  | "not_plan_sourced"
  | "plan_day_missing"
  | "day_not_changed"
  | "session_started"
  | "session_finished"
  | "unchanged"
  | "retired_day_gone";

export interface RefreshPreparedDayResult {
  refreshed: boolean;
  date: string;
  reason?: RefreshPreparedDayReason;
  day_number?: number;
  composition_id?: number;
}

/**
 * Re-author an already-prepared, unstarted day after its plan day changed underneath it.
 *
 * A composition is a SNAPSHOT of the plan day taken when the athlete opened the session.
 * Nothing re-took it, so a plan change applied afterwards — from chat, from the boundary
 * pass — landed on the template while Today kept showing the movements the athlete had
 * already been handed. They read a confirmation and then trained the old session.
 *
 * The rules are the ones preparation already lives by, not new ones: only a plan-sourced
 * snapshot (`adaptive_plan` / `manual_plan`) is re-taken, only for a day the change
 * actually touched, and only while the session is untouched — one logged set, note or
 * rating and the day belongs to the athlete, who is told nothing changed rather than
 * having the card rewritten mid-session. The persisted `train_anyway` consent rides
 * along, because a day the athlete chose to train on a rest read stays that choice.
 */
export function refreshPreparedDayForPlanChange(input: RefreshPreparedDayInput = {}): RefreshPreparedDayResult {
  const date = validateDate(input.date);
  const row = activeCompositionRow(date);
  if (!row) return { refreshed: false, date, reason: "no_active_composition" };
  const source = sourceOf(row.source);
  if (!PLAN_SOURCES.has(source)) return { refreshed: false, date, reason: "not_plan_sourced" };
  const planDay = db.prepare(`SELECT day_number FROM plan_days WHERE id = ?`).get(Number(row.plan_day_id)) as any;
  const dayNumber = boundedNumber(planDay?.day_number, 1, 60, true);
  const sameDateSessions = sessionRowsForDate(date);
  const started = sameDateSessions.some((session) => meaningfulSessionReasons(session).length > 0);
  const finished = sameDateSessions.some((session) => session?.finished_at != null);
  if (dayNumber == null) {
    // The day the snapshot came from left the plan. Only a person's save retires it,
    // and only while nothing was lived on it — the same locks as the re-take below. A
    // snapshot that never held a lift (a rest read's empty day) was never a plan day's.
    const heldWork = (() => {
      const items = parseJson(row.items_json);
      return Array.isArray(items) && items.length > 0;
    })();
    if (input.retire_when_day_gone && heldWork && !started && !finished) {
      db.prepare(
        `UPDATE daily_session_compositions
            SET status = 'superseded', superseded_at = datetime('now')
          WHERE id = ? AND status = 'active'`
      ).run(row.id);
      return { refreshed: true, date, reason: "retired_day_gone" };
    }
    return { refreshed: false, date, reason: "plan_day_missing" };
  }
  const wanted = (input.day_numbers ?? []).map((day) => Number(day)).filter((day) => Number.isFinite(day));
  if (wanted.length && !wanted.includes(dayNumber)) {
    return { refreshed: false, date, reason: "day_not_changed", day_number: dayNumber };
  }
  if (started) {
    return { refreshed: false, date, reason: "session_started", day_number: dayNumber };
  }
  // `finished_at` alone carries no logged-set evidence, so `meaningfulSessionReasons`
  // deliberately leaves it out — `prepareDailySession`'s own explicit replace path is
  // allowed to clear it, because THAT caller is the athlete asking to redo a day they
  // never lifted on. This caller is not the athlete; it is a plan edit landing
  // underneath a day they already finished. A finish stamp is lived, full stop — the
  // refresh must never reopen it (never clear skips or the finish stamp underneath an
  // athlete who has already closed the day out).
  if (finished) {
    return { refreshed: false, date, reason: "session_finished", day_number: dayNumber };
  }
  const constraints = normalizedRecord(parseJson(row.constraints_json));
  const provenance = normalizedRecord(parseJson(row.provenance_json));
  const prepared = prepareDailySession({
    date,
    source,
    day_number: dayNumber,
    replace: true,
    force_recompose: true,
    train_anyway: constraints.train_anyway === true,
    constraints: withoutServerDecisionFields(constraints, ["train_anyway", "daily_decision"]),
    provenance: withoutServerDecisionFields(provenance, ["label", "choice", "daily_decision"]),
  });
  const compositionId = boundedNumber((prepared.daily_session as any)?.id, 1, Number.MAX_SAFE_INTEGER, true);
  return {
    refreshed: prepared.reused !== true,
    date,
    day_number: dayNumber,
    ...(prepared.reused === true ? { reason: "unchanged" as const } : {}),
    ...(compositionId == null ? {} : { composition_id: compositionId }),
  };
}

/** The plan day number today's active composition was taken from, if it still has one. */
export function activeCompositionPlanDayNumber(date?: string): number | null {
  const row = db
    .prepare(
      `SELECT pd.day_number AS day_number
         FROM daily_session_compositions dsc JOIN plan_days pd ON pd.id = dsc.plan_day_id
        WHERE dsc.date = ? AND dsc.status = 'active' LIMIT 1`
    )
    .get(validateDate(date)) as any;
  return boundedNumber(row?.day_number, 1, 60, true);
}

export function listDailySessionCompositions() {
  return (db.prepare(`SELECT * FROM daily_session_compositions ORDER BY date DESC, version DESC`).all() as any[]).map(
    hydrate
  );
}
