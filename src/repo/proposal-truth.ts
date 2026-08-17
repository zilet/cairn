import { createHash } from "node:crypto";
import { db } from "../db.js";
import { clampEvidenceDate, clampProposalProvenanceDates } from "./proposal-provenance-clamp.js";
import { addDaysISO, localDateISO } from "./shared.js";

// Re-exported so `src/repo.ts` and its callers keep one import site for proposal
// truth; the clamp itself lives in a db-free module because migration 92 needs it.
export { clampEvidenceDate, clampProposalProvenanceDates };

export interface ReasonProvenance {
  reason_code: string;
  evidence_date: string;
  as_of_date: string;
  source_ref_type?: string | null;
  source_ref_key?: string | null;
}

export interface ProposalEvidenceSnapshot {
  version: 1;
  as_of_date: string;
  window_start: string;
  observed_through_date: string;
  latest_training_date: string | null;
  fingerprint: string;
  plan_fingerprint: string;
  training_fingerprint: string;
  context_fingerprint?: string;
}

export interface ProposalFreshness {
  status: "current" | "changed" | "unverified";
  expected_fingerprint: string | null;
  actual_fingerprint: string | null;
  changed_components: Array<"plan" | "training" | "context">;
  as_of_date: string | null;
  checked_at: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DATE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/i;
const HISTORICAL =
  /\b(?:yesterday|today|(?:last|previous|prior) (?:sessions?|workouts?|week)|(?:the )?(?:last|previous|prior) (?:two|three|\d+|few|several) comparable (?:exposures?|holds?|sessions?|sets?)|(?:recent|last|previous|prior) comparable (?:exposures?|holds?|sessions?|sets?)|this week|(?:recent|last|previous|prior) (?:exposures?|holds?|sets?|soreness|recovery|performance)|recent (?:sessions?|training|workouts?)|earlier this week)\b/i;

function object(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function isoDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!ISO_DATE.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}

function datePart(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const direct = isoDate(text.slice(0, 10));
  return direct;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

const NON_AUTHORITATIVE_KEYS = new Set([
  "created_at",
  "updated_at",
  "synced_at",
  "computed_at",
  "summary",
  "headline",
  "narrative",
  "explanation",
  "display",
]);

function boundedAuthoritativeJson(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    if ((text.startsWith("{") || text.startsWith("[")) && depth < 5) {
      try {
        return boundedAuthoritativeJson(JSON.parse(text), depth + 1);
      } catch {
        return text.slice(0, 4_000);
      }
    }
    return text.slice(0, 4_000);
  }
  if (depth >= 5) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => boundedAuthoritativeJson(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !NON_AUTHORITATIVE_KEYS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 100)) {
    out[key] = boundedAuthoritativeJson(entry, depth + 1);
  }
  return out;
}

function humanDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function startOfWeek(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  const offset = (parsed.getUTCDay() + 6) % 7;
  return addDaysISO(date, -offset) ?? date;
}

function clone<T>(value: T): T {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function reasonHasHistoricalReference(value: unknown): boolean {
  const text = String(value ?? "");
  return HISTORICAL.test(text) || /\b\d{4}-\d{2}-\d{2}\b/.test(text) || MONTH_DATE.test(text);
}

export function validReasonProvenance(value: unknown): value is ReasonProvenance {
  const provenance = object(value);
  return (
    !!provenance &&
    String(provenance.reason_code ?? "").trim().length > 0 &&
    !!isoDate(provenance.evidence_date) &&
    !!isoDate(provenance.as_of_date) &&
    (provenance.source_ref_type == null || typeof provenance.source_ref_type === "string") &&
    (provenance.source_ref_key == null || typeof provenance.source_ref_key === "string")
  );
}

// A reason is free prose, and prose names FUTURE dates all the time ("suspend Z4 for
// 2026-08-09→2026-08-22"). Matching the first ISO date in it is a heuristic, so its
// result is clamped here rather than trusted: an unclamped future date used to be
// written straight into reason_provenance, and every later rehydration then threw on
// its own stored row.
function inferredEvidenceDate(reason: string, asOf: string, latestTrainingDate: string | null): string {
  const inferred = (() => {
    if (/\byesterday\b/i.test(reason)) return addDaysISO(asOf, -1) ?? asOf;
    if (/\blast week\b/i.test(reason)) return addDaysISO(startOfWeek(asOf), -7) ?? asOf;
    if (/\b(?:this week|earlier this week)\b/i.test(reason)) return startOfWeek(asOf);
    const explicitIso = reason.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
    return explicitIso ?? latestTrainingDate ?? asOf;
  })();
  return clampEvidenceDate(inferred, asOf);
}

export function normalizeHistoricalReason(
  value: unknown,
  provenance?: Partial<ReasonProvenance> | null,
  fallbackAsOf = localDateISO()
): string {
  let reason = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!reason) return "";
  const asOf = isoDate(provenance?.as_of_date) ?? isoDate(fallbackAsOf) ?? localDateISO();
  const evidenceDate = isoDate(provenance?.evidence_date) ?? inferredEvidenceDate(reason, asOf, null);
  const evidenceLabel = humanDate(evidenceDate);
  const asOfLabel = humanDate(asOf);
  const thisWeek = humanDate(startOfWeek(asOf));
  const lastWeek = humanDate(addDaysISO(startOfWeek(asOf), -7) ?? asOf);

  reason = reason
    .replace(
      /\bthe last (two|three|\d+|few|several) comparable (exposures?|holds?|sessions?|sets?)\b/gi,
      (_match, count, noun) => `the ${count} comparable ${noun} through ${evidenceLabel}`
    )
    .replace(
      /\blast (two|three|\d+|few|several) comparable (exposures?|holds?|sessions?|sets?)\b/gi,
      (_match, count, noun) => `${count} comparable ${noun} through ${evidenceLabel}`
    )
    .replace(
      /\brecent comparable (exposures?|holds?|sessions?|sets?)\b/gi,
      (_match, noun) => `comparable ${noun} through ${evidenceLabel}`
    )
    .replace(/\byesterday(?:'s)?\b/gi, `on ${evidenceLabel}`)
    .replace(/\btoday(?:'s)?\b/gi, `on ${asOfLabel}`)
    .replace(/\bthe last session\b/gi, `the ${evidenceLabel} session`)
    .replace(/\blast session\b/gi, `the ${evidenceLabel} session`)
    .replace(/\bthe (?:previous|prior) session\b/gi, `the ${evidenceLabel} session`)
    .replace(/\b(?:previous|prior) session\b/gi, `the ${evidenceLabel} session`)
    .replace(/\bthe last workout\b/gi, `the ${evidenceLabel} workout`)
    .replace(/\blast workout\b/gi, `the ${evidenceLabel} workout`)
    .replace(/\bthe (?:previous|prior) workout\b/gi, `the ${evidenceLabel} workout`)
    .replace(/\b(?:previous|prior) workout\b/gi, `the ${evidenceLabel} workout`)
    .replace(/\b(?:previous|prior) sessions\b/gi, `sessions through ${evidenceLabel}`)
    .replace(/\b(?:previous|prior) workouts\b/gi, `workouts through ${evidenceLabel}`)
    .replace(
      /\b(?:recent|last|previous|prior) comparable (exposures?|holds?|sessions?|sets?)\b/gi,
      (_match, noun) => `comparable ${noun} through ${evidenceLabel}`
    )
    .replace(
      /\b(?:recent|last|previous|prior) (exposures?|holds?|sets?)\b/gi,
      (_match, noun) => `${noun} through ${evidenceLabel}`
    )
    .replace(
      /\b(?:recent|last|previous|prior) (soreness|recovery|performance)\b/gi,
      (_match, signal) => `${signal} recorded through ${evidenceLabel}`
    )
    .replace(/\brecent sessions\b/gi, `sessions through ${evidenceLabel}`)
    .replace(/\brecent session\b/gi, `the ${evidenceLabel} session`)
    .replace(/\brecent workouts\b/gi, `workouts through ${evidenceLabel}`)
    .replace(/\brecent training\b/gi, `training through ${evidenceLabel}`)
    .replace(/\bearlier this week\b/gi, `earlier in the week of ${thisWeek}`)
    .replace(/\bthis week\b/gi, `the week of ${thisWeek}`)
    .replace(/\blast week\b/gi, `the week of ${lastWeek}`);
  return reason.slice(0, 1_500);
}

function planFacts(): any[] {
  const days = db.prepare(`SELECT id, day_number, name, focus FROM plan_days ORDER BY day_number, id`).all() as any[];
  const items = db
    .prepare(
      `SELECT pi.plan_day_id, pi.position, pi.sets, pi.rep_low, pi.rep_high, pi.target_weight,
              pi.warmup_sets, pi.target_seconds, pi.kind, pi.target_distance_km,
              pi.target_duration_min, pi.target_zone, pi.interval_json, pi.superset_group,
              pi.note, e.id AS exercise_id, e.name AS exercise, e.muscle_group,
              e.mode, e.equipment, e.constraint_note
         FROM plan_items pi LEFT JOIN exercises e ON e.id = pi.exercise_id
        ORDER BY pi.plan_day_id, pi.position, pi.id`
    )
    .all() as any[];
  const byDay = new Map<number, any[]>();
  for (const item of items) {
    const dayId = Number(item.plan_day_id);
    const { plan_day_id: _planDayId, ...fact } = item;
    byDay.set(dayId, [...(byDay.get(dayId) ?? []), fact]);
  }
  return days.map((day) => ({
    day_number: Number(day.day_number),
    name: day.name ?? null,
    focus: day.focus ?? null,
    items: byDay.get(Number(day.id)) ?? [],
  }));
}

function trainingFacts(
  windowStart: string,
  throughDate: string
): {
  facts: Record<string, unknown>;
  latestDate: string | null;
} {
  const sessions = db
    .prepare(
      `SELECT s.id, s.date, s.plan_day_id, s.duration_min, s.soreness, s.performance, s.joint_pain,
              s.finished_at, s.kind, s.notes, s.garmin_json
         FROM sessions s
        WHERE s.date >= ? AND s.date <= ?
        ORDER BY s.date, s.id`
    )
    .all(windowStart, throughDate) as any[];
  const sets = db
    .prepare(
      `SELECT s.date, ls.session_id, ls.exercise_id, e.name AS exercise, ls.set_number,
              ls.weight, ls.reps, ls.rir, ls.duration_sec
         FROM logged_sets ls
         JOIN sessions s ON s.id = ls.session_id
         JOIN exercises e ON e.id = ls.exercise_id
        WHERE s.date >= ? AND s.date <= ?
        ORDER BY s.date, ls.session_id, ls.id`
    )
    .all(windowStart, throughDate) as any[];
  const activities = db
    .prepare(
      `SELECT id, date, type, duration_min, distance_km, pace, rpe, source, external_id
         FROM activities
        WHERE date >= ? AND date <= ?
        ORDER BY date, id`
    )
    .all(windowStart, throughDate) as any[];
  const symptomEvents = db
    .prepare(
      `SELECT id, source_session_id, source_kind, area_text, status, scope, onset_on,
              last_reported_on, resolved_on, recurrence_count, evidence_epoch,
              legacy_unconfirmed
         FROM training_symptom_events
        WHERE onset_on <= ? AND (resolved_on IS NULL OR resolved_on >= ?)
        ORDER BY onset_on DESC, id DESC LIMIT 256`
    )
    .all(throughDate, windowStart) as any[];
  const movementTolerance = db
    .prepare(
      `SELECT symptom_event_id, session_id, exercise_id, movement_key, movement_name,
              observed_on, outcome, evidence, relevant, evidence_epoch
         FROM movement_tolerance_observations
        WHERE observed_on >= ? AND observed_on <= ?
        ORDER BY observed_on DESC, id DESC LIMIT 512`
    )
    .all(windowStart, throughDate) as any[];
  const recoveryCycles = db
    .prepare(
      `SELECT id, status, effective_on, recheck_on, exit_on, overlay_json, reason,
              legacy_flag, completed_at, canceled_at
         FROM recovery_cycles
        WHERE effective_on <= ? AND exit_on >= ?
        ORDER BY effective_on DESC, id DESC LIMIT 64`
    )
    .all(throughDate, windowStart) as any[];
  const dailyOutcomes = db
    .prepare(
      `SELECT id, composition_id, session_id, date, status, facts_json
         FROM daily_session_outcomes
        WHERE date >= ? AND date <= ?
        ORDER BY date DESC, id DESC LIMIT 128`
    )
    .all(windowStart, throughDate) as any[];
  const latestDate =
    [...sessions, ...activities]
      .map((row) => isoDate(row.date))
      .filter((date): date is string => !!date)
      .sort()
      .at(-1) ?? null;
  return {
    facts: {
      sessions: sessions.map((session) => ({
        id: Number(session.id),
        date: session.date,
        plan_day_id: session.plan_day_id == null ? null : Number(session.plan_day_id),
        duration_min: session.duration_min,
        soreness: session.soreness,
        performance: session.performance,
        joint_pain: String(session.joint_pain ?? "").slice(0, 300) || null,
        finished_at: session.finished_at,
        kind: session.kind,
        notes: String(session.notes ?? "").slice(0, 1_500) || null,
        garmin_json: boundedAuthoritativeJson(session.garmin_json),
      })),
      sets,
      activities,
      symptom_events: symptomEvents.map((event) => ({
        id: Number(event.id),
        source_session_id: event.source_session_id == null ? null : Number(event.source_session_id),
        source_kind: String(event.source_kind).slice(0, 80),
        area_text: String(event.area_text).slice(0, 300),
        status: event.status,
        // A systemic watch is in the snapshot but must never be read as loading a
        // movement; carrying the scope is what lets a reader tell them apart.
        scope: event.scope === "systemic" ? "systemic" : "area",
        onset_on: event.onset_on,
        last_reported_on: event.last_reported_on,
        resolved_on: event.resolved_on,
        recurrence_count: Number(event.recurrence_count ?? 0),
        evidence_epoch: Number(event.evidence_epoch ?? 1),
        legacy_unconfirmed: Number(event.legacy_unconfirmed) === 1,
      })),
      movement_tolerance: movementTolerance.map((observation) => ({
        symptom_event_id: Number(observation.symptom_event_id),
        session_id: observation.session_id == null ? null : Number(observation.session_id),
        exercise_id: observation.exercise_id == null ? null : Number(observation.exercise_id),
        movement_key: String(observation.movement_key).slice(0, 160),
        movement_name: String(observation.movement_name).slice(0, 120),
        observed_on: observation.observed_on,
        outcome: observation.outcome,
        // 'inferred' = read off a logged set, not spoken. The snapshot has to keep
        // the two apart or a reader would treat silence as a confirmation.
        evidence: observation.evidence === "inferred" ? "inferred" : "stated",
        relevant: Number(observation.relevant) === 1,
        evidence_epoch: Number(observation.evidence_epoch ?? 1),
      })),
      recovery_cycles: recoveryCycles.map((cycle) => ({
        id: Number(cycle.id),
        status: cycle.status,
        effective_on: cycle.effective_on,
        recheck_on: cycle.recheck_on,
        exit_on: cycle.exit_on,
        overlay: recoveryOverlayFacts(cycle.overlay_json),
        reason: String(cycle.reason ?? "").slice(0, 500) || null,
        legacy: Number(cycle.legacy_flag) === 1,
        completed_at: datePart(cycle.completed_at),
        canceled_at: datePart(cycle.canceled_at),
      })),
      daily_outcomes: dailyOutcomes.map((outcome) => ({
        id: Number(outcome.id),
        composition_id: Number(outcome.composition_id),
        session_id: Number(outcome.session_id),
        date: outcome.date,
        status: outcome.status,
        facts: dailyOutcomeFacts(outcome.facts_json),
      })),
    },
    latestDate,
  };
}

function parsedRecord(value: unknown): Record<string, any> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  try {
    return object(JSON.parse(String(value ?? "")));
  } catch {
    return null;
  }
}

function invalidJsonFact(value: unknown): Record<string, unknown> {
  const text = String(value ?? "");
  return { invalid: true, bytes: Buffer.byteLength(text), digest: hash(text) };
}

function recoveryOverlayFacts(value: unknown): Record<string, unknown> {
  const overlay = parsedRecord(value);
  if (!overlay) return invalidJsonFact(value);
  return {
    version: overlay.version ?? null,
    base_plan_day_id: overlay.base_plan_day_id ?? null,
    base_day_number: overlay.base_day_number ?? null,
    source_proposal_id: overlay.source_proposal_id ?? null,
    source_decision_id: overlay.source_decision_id ?? null,
    working_set_fraction: overlay.working_set_fraction ?? null,
    effort: String(overlay.effort ?? "").slice(0, 80) || null,
    preserves_movements: overlay.preserves_movements ?? null,
    mutates_plan: overlay.mutates_plan ?? null,
  };
}

function boundedStrings(value: unknown, limit = 64): string[] {
  return Array.isArray(value) ? value.slice(0, limit).map((entry) => String(entry).slice(0, 160)) : [];
}

function dailyOutcomeFacts(value: unknown): Record<string, unknown> {
  const facts = parsedRecord(value);
  if (!facts) return invalidJsonFact(value);
  const doses = Array.isArray(facts.dose_evidence) ? facts.dose_evidence : [];
  return {
    schema_version: facts.schema_version ?? null,
    confidence: facts.confidence ?? null,
    reason_codes: boundedStrings(facts.reason_codes),
    confounders: boundedStrings(facts.confounders),
    completed: boundedStrings(facts.completed),
    substituted: boundedStrings(facts.substituted),
    skipped: boundedStrings(facts.skipped),
    reordered: facts.reordered === true,
    dose_context: boundedAuthoritativeJson({
      recovery: facts.dose_context?.recovery ?? null,
      athlete_override: facts.dose_context?.athlete_override ?? null,
      travel: facts.dose_context?.travel ?? null,
      illness: facts.dose_context?.illness ?? null,
      symptom: facts.dose_context?.symptom ?? null,
      endurance: facts.dose_context?.endurance ?? null,
      partial: facts.dose_context?.partial ?? null,
      comparable: facts.dose_context?.comparable ?? null,
      non_comparable_reasons: boundedStrings(facts.dose_context?.non_comparable_reasons),
    }),
    feedback: boundedAuthoritativeJson({
      soreness: facts.feedback?.soreness ?? null,
      performance: facts.feedback?.performance ?? null,
      joint_pain: String(facts.feedback?.joint_pain ?? "").slice(0, 300) || null,
    }),
    dose_evidence: doses.slice(0, 64).map((dose: any) => ({
      composition_item_key: String(dose?.composition_item_key ?? "").slice(0, 160),
      movement_key: String(dose?.movement_key ?? "").slice(0, 160),
      intent_key: String(dose?.intent_key ?? "").slice(0, 160),
      challenge_verdict: dose?.challenge_verdict ?? null,
      prescribed: boundedAuthoritativeJson(dose?.prescribed),
      achieved: boundedAuthoritativeJson(dose?.achieved),
    })),
  };
}

function contextFacts(windowStart: string, throughDate: string): Record<string, unknown> {
  const profile = db
    .prepare(
      `SELECT name, sex, age, height_cm, height_in, weight_lb, start_weight_lb, start_date,
              goal_weight_lb, goal_bodyfat_pct, goal_date, goal_mode, activity_factor,
              notes, about_me, primary_discipline, endurance_sport, endurance_goal_json,
              equipment
         FROM profile WHERE id = 1`
    )
    .get() as any;
  const settings =
    (db
      .prepare(`SELECT coach_enabled, proactive_enabled, lead_mode FROM settings WHERE id = 1`)
      .get() as any) ?? { coach_enabled: 0, proactive_enabled: 1, lead_mode: "lead" };
  const contexts = db
    .prepare(
      `SELECT id, kind, title, detail, start_date, end_date, meta_json, archived,
              expected_recovery_days, resolved_at
         FROM context_events
        WHERE COALESCE(start_date, ?) <= ?
        ORDER BY id`
    )
    .all(throughDate, throughDate) as any[];
  const checkins = db
    .prepare(
      `SELECT date, mood, energy, sleep_feel, soreness, note
         FROM checkins WHERE date >= ? AND date <= ? ORDER BY date, id`
    )
    .all(windowStart, throughDate) as any[];
  const directives = db
    .prepare(
      `SELECT source, domain, marker, directive_key, intent_key, directive, rationale,
              uncertain, status, trigger_value, trigger_side, trigger_date
         FROM health_directives
        WHERE status = 'active'
        ORDER BY domain, directive_key, id`
    )
    .all() as any[];
  const healthDocuments = db
    .prepare(
      `SELECT id, kind, doc_date, parsed_json, enrichment_status, source_doc_id
         FROM health_documents
        WHERE COALESCE(doc_date, substr(created_at, 1, 10)) <= ?
        ORDER BY COALESCE(doc_date, substr(created_at, 1, 10)), id`
    )
    .all(throughDate) as any[];
  const recovery = db
    .prepare(
      `SELECT date, sleep_min, sleep_score, resting_hr, hrv_ms, stress_avg,
              body_battery_avg, training_readiness, training_status, acute_load,
              intensity_min_moderate, intensity_min_vigorous, vo2max, vo2max_cycling
         FROM garmin_daily_metrics
        WHERE date >= ? AND date <= ? ORDER BY date, id`
    )
    .all(windowStart, throughDate) as any[];
  const otherRecovery = db
    .prepare(
      `SELECT source, date, sleep_min, sleep_score, resting_hr, hrv_ms, active_calories,
              distance_km, exercise_min, spo2_avg, vo2max
         FROM daily_metrics
        WHERE date >= ? AND date <= ? ORDER BY date, source, id`
    )
    .all(windowStart, throughDate) as any[];
  const memories = db
    .prepare(
      `SELECT id, kind, content, source, superseded_by, confidence
         FROM memory
        WHERE superseded_by IS NULL
        ORDER BY id`
    )
    .all() as any[];
  const blocks = db
    .prepare(
      `SELECT id, goal, focus, phase, week_index, total_weeks, started_at, status
         FROM program_blocks
        ORDER BY id`
    )
    .all() as any[];
  const strengthObjectives = db
    .prepare(
      `SELECT id, exercise, exercise_key, target_kind, target_est_1rm,
              baseline_est_1rm, baseline_date, source, status
         FROM strength_objectives
        WHERE status = 'active' AND source = 'user'
        ORDER BY id DESC LIMIT 1`
    )
    .all() as any[];
  return boundedAuthoritativeJson({
    profile,
    settings,
    contexts,
    checkins,
    directives,
    health_documents: healthDocuments,
    recovery,
    other_recovery: otherRecovery,
    memories,
    program_blocks: blocks,
    strength_objectives: strengthObjectives,
  }) as Record<string, unknown>;
}

export function captureProposalEvidence(
  asOf = localDateISO(),
  windowStart = addDaysISO(asOf, -42) ?? asOf
): ProposalEvidenceSnapshot {
  const plan = planFacts();
  const training = trainingFacts(windowStart, asOf);
  const context = contextFacts(windowStart, asOf);
  const planFingerprint = hash(plan);
  const trainingFingerprint = hash(training.facts);
  const contextFingerprint = hash(context);
  return {
    version: 1,
    as_of_date: asOf,
    window_start: windowStart,
    observed_through_date: asOf,
    latest_training_date: training.latestDate,
    fingerprint: hash({
      plan: planFingerprint,
      training: trainingFingerprint,
      context: contextFingerprint,
    }),
    plan_fingerprint: planFingerprint,
    training_fingerprint: trainingFingerprint,
    context_fingerprint: contextFingerprint,
  };
}

// "write" is the gate on the way IN: a payload that contradicts itself is refused
// before it can be stored. "stored" is the way back OUT, and it may not throw — a row
// that is already in the table cannot be un-stored, and one poison payload used to
// take down every caller that hydrated it (listProposals, the whole scheduler sweep).
// On the read path an inconsistency CLAMPS: evidence_date falls back to its own
// as_of_date, and a stored as_of that disagrees with the payload's is kept as stored.
type ProvenanceMode = "write" | "stored";

function provenanceFor(
  raw: unknown,
  reason: string,
  asOf: string,
  evidence: ProposalEvidenceSnapshot,
  mode: ProvenanceMode
): ReasonProvenance {
  const supplied = object(raw);
  const suppliedAsOf = isoDate(supplied?.as_of_date);
  if (mode === "write" && supplied?.as_of_date != null && suppliedAsOf !== asOf) {
    throw new Error("reason provenance as_of_date must match the server date");
  }
  const effectiveAsOf = mode === "stored" ? (suppliedAsOf ?? asOf) : asOf;
  const suppliedEvidenceDate = isoDate(supplied?.evidence_date);
  if (mode === "write" && supplied?.evidence_date != null && !suppliedEvidenceDate) {
    throw new Error("reason provenance evidence_date must be YYYY-MM-DD");
  }
  if (mode === "write" && suppliedEvidenceDate && suppliedEvidenceDate > effectiveAsOf) {
    throw new Error("reason provenance evidence_date cannot be after as_of_date");
  }
  const evidenceDate = clampEvidenceDate(
    suppliedEvidenceDate ?? inferredEvidenceDate(reason, effectiveAsOf, evidence.latest_training_date),
    effectiveAsOf
  );
  return {
    reason_code: String(supplied?.reason_code ?? "training_evidence")
      .trim()
      .slice(0, 80),
    evidence_date: evidenceDate,
    as_of_date: effectiveAsOf,
    source_ref_type:
      supplied?.source_ref_type == null ? "training_evidence_snapshot" : String(supplied.source_ref_type).slice(0, 80),
    source_ref_key:
      supplied?.source_ref_key == null ? evidence.fingerprint : String(supplied.source_ref_key).slice(0, 160),
  };
}

function normalizeReasonOwner(
  owner: Record<string, any>,
  field: "reason" | "rationale",
  provenanceField: "reason_provenance" | "rationale_provenance",
  asOf: string,
  evidence: ProposalEvidenceSnapshot,
  mode: ProvenanceMode
): void {
  if (typeof owner[field] !== "string" || !owner[field].trim()) return;
  const provenance = provenanceFor(owner[provenanceField], owner[field], asOf, evidence, mode);
  owner[field] = normalizeHistoricalReason(owner[field], provenance, asOf);
  owner[provenanceField] = provenance;
}

function normalizePayloadReasons(
  payload: Record<string, any>,
  asOf: string,
  evidence: ProposalEvidenceSnapshot,
  mode: ProvenanceMode
): void {
  if (typeof payload.summary === "string")
    payload.summary = normalizeHistoricalReason(payload.summary, payload.rationale_provenance, asOf);
  if (typeof payload.notes === "string")
    payload.notes = normalizeHistoricalReason(payload.notes, payload.rationale_provenance, asOf);
  normalizeReasonOwner(payload, "rationale", "rationale_provenance", asOf, evidence, mode);
  for (const change of Array.isArray(payload.changes) ? payload.changes : []) {
    if (object(change)) {
      normalizeReasonOwner(change, "reason", "reason_provenance", asOf, evidence, mode);
      if (typeof change.note === "string")
        change.note = normalizeHistoricalReason(change.note, change.reason_provenance, asOf);
    }
  }
  for (const cardio of Array.isArray(payload.cardio) ? payload.cardio : []) {
    if (object(cardio)) {
      normalizeReasonOwner(cardio, "reason", "reason_provenance", asOf, evidence, mode);
      if (typeof cardio.note === "string")
        cardio.note = normalizeHistoricalReason(cardio.note, cardio.reason_provenance, asOf);
    }
  }
  for (const day of Array.isArray(payload.days) ? payload.days : []) {
    for (const item of Array.isArray(day?.items) ? day.items : []) {
      if (object(item)) {
        normalizeReasonOwner(item, "reason", "reason_provenance", asOf, evidence, mode);
        if (typeof item.note === "string")
          item.note = normalizeHistoricalReason(item.note, item.reason_provenance, asOf);
      }
    }
  }
}

function trainingProposal(payload: Record<string, any>): boolean {
  return (
    Array.isArray(payload.changes) ||
    Array.isArray(payload.cardio) ||
    (Array.isArray(payload.days) && payload.kind !== "nutrition_target")
  );
}

export function prepareProposalPayload(parsed: unknown): unknown {
  const source = object(parsed);
  if (!source) return parsed;
  const payload = clone(source);
  if (!trainingProposal(payload)) return payload;
  const asOf = localDateISO();
  if (payload.as_of_date != null && isoDate(payload.as_of_date) !== asOf) {
    throw new Error("proposal as_of_date must match the server date");
  }
  const evidence = captureProposalEvidence(asOf);
  payload.as_of_date = asOf;
  payload.proposal_truth = { version: 1, evidence };
  normalizePayloadReasons(payload, asOf, evidence, "write");
  return payload;
}

export function normalizeStoredProposalPayload(parsed: unknown, createdAt?: unknown): unknown {
  const source = object(parsed);
  if (!source || !trainingProposal(source)) return parsed;
  const payload = clone(source);
  const stored = object(payload.proposal_truth)?.evidence as ProposalEvidenceSnapshot | undefined;
  const asOf = isoDate(payload.as_of_date) ?? isoDate(stored?.as_of_date) ?? datePart(createdAt) ?? localDateISO();
  const evidence =
    stored && stored.version === 1
      ? stored
      : {
          version: 1 as const,
          as_of_date: asOf,
          window_start: addDaysISO(asOf, -42) ?? asOf,
          observed_through_date: asOf,
          latest_training_date: null,
          fingerprint: "",
          plan_fingerprint: "",
          training_fingerprint: "",
        };
  payload.as_of_date = asOf;
  // Repair what is on disk before reading it back. A payload written before the
  // inference clamp existed can hold an evidence_date in its own future; clamping it
  // here (rather than throwing) is what keeps one poison row from taking a whole
  // listProposals — and therefore the scheduler's draft-adoption sweep — down with it.
  clampProposalProvenanceDates(payload);
  normalizePayloadReasons(payload, asOf, evidence, "stored");
  return payload;
}

export function proposalEvidenceSnapshot(parsed: unknown): ProposalEvidenceSnapshot | null {
  const evidence = object(object(parsed)?.proposal_truth)?.evidence;
  if (!object(evidence) || evidence.version !== 1) return null;
  if (
    !isoDate(evidence.as_of_date) ||
    !isoDate(evidence.window_start) ||
    typeof evidence.fingerprint !== "string" ||
    !evidence.fingerprint ||
    typeof evidence.plan_fingerprint !== "string" ||
    typeof evidence.training_fingerprint !== "string"
  )
    return null;
  return evidence as ProposalEvidenceSnapshot;
}

export function verifyProposalEvidenceFreshness(parsed: unknown, checkedAt = localDateISO()): ProposalFreshness {
  const expected = proposalEvidenceSnapshot(parsed);
  if (!expected) {
    return {
      status: "unverified",
      expected_fingerprint: null,
      actual_fingerprint: null,
      changed_components: [],
      as_of_date: null,
      checked_at: checkedAt,
    };
  }
  return verifyProposalEvidenceSnapshot(expected, checkedAt);
}

export function verifyProposalEvidenceSnapshot(
  expected: ProposalEvidenceSnapshot,
  checkedAt = localDateISO()
): ProposalFreshness {
  const current = captureProposalEvidence(checkedAt, expected.window_start);
  const changedComponents: Array<"plan" | "training" | "context"> = [];
  if (current.plan_fingerprint !== expected.plan_fingerprint) changedComponents.push("plan");
  if (current.training_fingerprint !== expected.training_fingerprint) changedComponents.push("training");
  if (expected.context_fingerprint && current.context_fingerprint !== expected.context_fingerprint) {
    changedComponents.push("context");
  }
  return {
    status: changedComponents.length ? "changed" : "current",
    expected_fingerprint: expected.fingerprint,
    actual_fingerprint: current.fingerprint,
    changed_components: changedComponents,
    as_of_date: expected.as_of_date,
    checked_at: checkedAt,
  };
}
