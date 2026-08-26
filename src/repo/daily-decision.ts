import crypto from "node:crypto";
import { truncateAtWord } from "../brain/contract-utils.js";
import { db } from "../db.js";
import { getCheckinByDate, getRecoverySummary, latestSleep } from "./coach.js";
import { cardioPlanIdentity } from "./cardio-plan-identity.js";
import { dayPlanningSignalState, dayRead, supportiveCapacityBacksDay } from "./day-read.js";
import {
  equipmentCompatibility,
  inferExerciseEquipment,
  parseEquipmentCapability,
} from "./equipment-capability.js";
import { findExercise } from "./exercises.js";
import { flexibleTrainingAgenda } from "./flexible-training-agenda.js";
import { getInjuryImpacts, listContextEvents } from "./health.js";
import { type AcuteGateReading, acuteGates, recentEnduranceImpacts } from "./hybrid-load.js";
import { getPlanDay } from "./plan.js";
import { selectAdaptivePlanDay, selectedPlanDayForDate } from "./plan-selection.js";
import { getProgramState } from "./program-state.js";
import { muscleGroupsForPainArea, painAreaLoadsExercise } from "./pain-relevance.js";
import { planDayProgression, recentAutoregulation } from "./progression.js";
import { personalResponseModifierFor } from "./reaction-model.js";
import { adaptBasePlanDayForRecovery, recoveryCycleAt } from "./recovery-cycles.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { getSettings } from "./settings.js";
import { SENSOR_MAX_AGE_DAYS, sensorAgeDays, sensorIsCurrent } from "./sensor-freshness.js";
import { sessionLogContradictsLowRating } from "./session-dose-log.js";
import { addDaysISO, localDateISO } from "./shared.js";
import { hasFreshBrake, type SignalConfidence, type SignalDimensionState } from "./signal-state.js";
import {
  getTrainingIntent,
  type EnduranceRole,
  type TrainingPriority,
} from "./training-intent.js";
import { listTrainingSymptoms } from "./training-symptoms.js";

// The deterministic daily-decision envelope (Stage 2 of the adaptive daily
// training plan). This is the
// explainable, reproducible default the athlete sees BEFORE any agent is
// involved: a bounded snapshot of the day's signals in, a versioned decision
// envelope out. The same snapshot always yields the same envelope and
// `input_fingerprint`. It never fabricates certainty — missing signals degrade
// to the existing adaptive plan selection rather than failing.
//
// Design note: the train/easy/rest KIND is delegated to the already-tested
// deterministic `dayRead()` (which folds recovery, soreness, consecutive
// training days, illness/travel and endurance volume into that read) rather
// than re-derived here — duplicating that logic would risk it drifting out of
// sync with the Brief. Stage 2 layers the movement/muscle/caps ENVELOPE and the
// reason-coded rationale on top of that kind. See the wave report for this
// intentional deviation from the doc's "re-derive precedence 3" wording.
//
// Soft training-intent bias (v5): ordered priorities and endurance_role shape
// soft preferences and rationale only — never gates, scores, or KIND. Athlete
// override / train_anyway / dayRead kind still win.
//
// Reach (v6): the envelope's UP direction, carried BESIDE the five-value safety
// ladder (`caps.intensity` stays easy/deload/hold/normal). A backed train day
// under `training_drive = "push"` with no fresh brake and unsaturated main lifts
// may reach inside the session; `hold_aggression` keeps the reach flag and trims
// only the challenge item.
//
// Caps (v7): train-anyway duration comes from the plan day's own estimate (capped
// at 40 only when a brake is present); soreness routes instead of softening only
// on an actually-open day; `recovery.readiness` stays raw and the capacity
// deferral happens at read time; reach can also be backed by the same supportive-
// capacity path dayRead uses for the drive rule. Snapshot gained recovery_capacity
// corroboration fields, so identity moves.

export const DAILY_DECISION_POLICY_VERSION = "daily_decision_v7";

export const DAILY_DECISION_REASONS = [
  "injury_exclusion",
  "injury_recheck",
  "joint_pain_reduce",
  "equipment_limited",
  "low_recovery_rest",
  "low_recovery_easy",
  "high_soreness",
  "recent_underperformance",
  "repeated_underperformance",
  "illness_window",
  "travel_window",
  "consecutive_training_days",
  "endurance_lower_conflict",
  "muscle_saturated",
  "muscle_due",
  "progression_overload",
  "progression_hold",
  "progression_deload",
  "progression_vary",
  "progression_introduce",
  "time_constrained",
  "athlete_override",
  "template_rotation",
  "training_intent",
  "personal_response_ease",
  "backed_day_reach",
  "reach_trimmed_by_fueling",
  "reach_no_room",
] as const;

export type DailyDecisionReason = (typeof DAILY_DECISION_REASONS)[number];

export type DailyDecisionKind = "train" | "easy" | "rest";

export interface DailyDecisionSnapshot {
  date: string;
  request: {
    override: string | null;
    train_anyway: boolean;
    equipment: string | null;
    minutes: number | null;
    goal: string | null;
  };
  plan: {
    day_number: number | null;
    focus: string | null;
    plan_day_id: number | null;
    source: string | null;
    reason: string | null;
    due: string[];
    over: string[];
  };
  day_read: {
    kind: "train" | "easy" | "rest" | "done" | null;
    focus: string | null;
    est_minutes: number | null;
    consecutive_training_days: number | null;
    recovery_week: boolean;
    trained_today: boolean;
  };
  recovery: {
    has_data: boolean;
    readiness: "low" | "moderate" | "high" | null;
    hrv_drift: "down" | "flat" | "up" | null;
    rhr_drift: "down" | "flat" | "up" | null;
    sleep_drift: "down" | "flat" | "up" | null;
  };
  // Compact view of the unified signal state's recovery_capacity. Omit-when-idle
  // so a snapshot with nothing to say serializes as it did before the field
  // existed. `snapshot.recovery.readiness` stays RAW; `effectiveRecoveryReadiness`
  // is the one place the capacity deferral is applied (supportive never reads
  // "low"; constrained reads "low"). Fresh-field flags back a reach the same way
  // they back dayRead's drive rule.
  recovery_capacity?: {
    status: SignalDimensionState["status"];
    confidence: SignalConfidence;
    fresh_hrv?: boolean;
    fresh_resting_hr?: boolean;
    fresh_sleep?: boolean;
    slept_enough?: boolean;
  };
  recovery_cycle: {
    id: number;
    effective_status: "active" | "recheck";
    effective_on: string;
    recheck_on: string;
    exit_on: string;
    working_set_fraction: number;
  } | null;
  // The acute-recovery gate per group, read once from the temporal muscle model
  // (hybrid-load.acuteGates) so the decision is a pure function of the snapshot.
  // `saturated` IS the gate — it already accounts for how long ago the work was
  // done and how fast that group forgets, so no consumer re-applies a days_ago
  // cliff on top of it.
  muscle_load: Array<{ group: string; days_ago: number; saturated: boolean; source: string }>;
  endurance: Array<{ type: string; days_ago: number; intensity: string; load: string; regions: string[] }>;
  checkin: { soreness: number | null; energy: number | null; sleep_feel: number | null } | null;
  feedback: {
    soreness: number | null;
    performance: number | null;
    joint_pain: string | null;
    low_performance_count?: number;
    // A completed log outranks a felt low rating. Omit-when-false so a snapshot
    // that never asked the question serializes as it did before the key existed.
    log_contradicts_low_rating?: boolean;
  } | null;
  constraints: {
    injuries: Array<{
      title: string;
      constraint_level: "protective" | "soft_recheck";
      areas: string[];
      exercises: string[];
    }>;
    illness: boolean;
    travel: boolean;
  };
  program: {
    mesocycle_phase: string | null;
    adaptations_due: string[];
    volume_low_groups: string[];
    volume_high_groups: string[];
  };
  progression: Array<{
    exercise: string;
    muscle_group: string | null;
    action: string;
    why: string;
    vary_to: string | null;
    current_target?: DailyDecisionTarget | null;
    suggested_target?: DailyDecisionTarget | null;
    // A peak week's heavy single, when this lift has one. Absent on every ordinary
    // day, and spread in rather than written as null so a non-peak snapshot
    // serializes byte-for-byte as it did before this field existed (see the note
    // on personal_response — stableJson walks Object.keys).
    top_set?: DailyDecisionTopSet;
    evidence?: DailyDecisionProgressionEvidence | null;
  }>;
  plan_items: Array<{
    exercise: string;
    muscle_group: string | null;
    equipment: string | null;
    mode: string;
    kind: string;
    sets?: number | null;
    rep_low?: number | null;
    rep_high?: number | null;
    target_weight?: number | null;
    target_seconds?: number | null;
    target_distance_km?: number | null;
    target_duration_min?: number | null;
    target_zone?: string | null;
    brain_decision_id?: number | null;
    brain_change_summary?: string | null;
    brain_change_reason?: string | null;
    brain_change_reason_provenance?: Record<string, unknown> | null;
    brain_change_reversible?: boolean | null;
  }>;
  // Compact, fingerprint-stable view of durable training direction. Role +
  // ordered priorities only — no free-text scores or capacity prose. Live
  // gather always stamps this; pure unit fixtures may omit it (no soft bias).
  training_intent?: {
    endurance_role: EnduranceRole;
    priorities: TrainingPriority[];
    source: "explicit" | "derived";
  };
  // The soonest actually open, dated key-run intention from the flexible
  // agenda. Completed and undated intentions deliberately collapse to null.
  open_key_run?: {
    intent_id: string;
    kind: "quality" | "long";
    suggested_date: string;
  } | null;
  // The LEARNED plan-complexity default, carried on the snapshot rather than read
  // inside the decision so `buildDailySessionDecision` stays a pure function of its
  // input — and so the fingerprint moves when the learning does instead of two
  // different days silently hashing the same. `gatherDailyDecisionSnapshot` stamps
  // the key ONLY when an easing modifier actually exists, so a snapshot with
  // nothing learned serializes byte-for-byte as it did before this field existed
  // and every historical envelope stays readable.
  personal_response?: { plan_complexity: number };
  // Compact reach inputs. The envelope is a pure function of the snapshot and had
  // neither `settings.training_drive` nor the signal state's `support` / brake /
  // training directive, so gather stamps this slice (omit-when-idle, same as
  // personal_response) rather than reading those stores inside the decision.
  signal_support?: DailyDecisionSignalSupport;
}

export interface DailyDecisionSignalSupport {
  training_drive: "push" | "steady";
  backed: boolean;
  backed_by: string[];
  training_directive: "proceed" | "hold_aggression" | "modify" | "recover";
  fresh_brake: boolean;
}

export interface DailyDecisionTarget {
  mode: "reps" | "timed";
  sets: number | null;
  rep_low: number | null;
  rep_high: number | null;
  target_weight: number | null;
  target_seconds: number | null;
}

/**
 * A peak week's TOP TIER: the heavy single the athlete works up to before the
 * back-off block.
 *
 * A peak session is two-tier work, and `DailyDecisionTarget` describes exactly one
 * tier. Progression resolves that by putting the back-off block in `suggested` —
 * which is the right default, because a consumer that knows nothing about peak
 * weeks must land on a real, lighter session rather than on one near-maximal
 * single with the rest of the work missing. The cost was that the heavy set
 * survived only as prose inside `why`, so the envelope described a session the
 * athlete was not actually being asked to do.
 *
 * This carries it as data instead. It is a SESSION protocol, never a plan edit:
 * `buildProgressionProposal` deliberately skips a top set (progression.ts), so
 * nothing here reaches `plan_items` and the plan never carries a near-maximal
 * single forward as a target.
 */
export interface DailyDecisionTopSet {
  weight: number;
  reps: number;
}

export interface DailyDecisionProgressionEvidence {
  delta_text: string | null;
  why: string | null;
  reground: boolean;
  autoregulated: boolean;
  movement_response: string | null;
  rep_step: boolean;
  dose_eligibility: {
    linked_outcome: boolean;
    eligible: boolean;
    reason: string;
  } | null;
}

export interface DailyDecisionCandidate {
  exercise: string;
  muscle_group: string | null;
  action: "overload" | "hold" | "deload" | "vary" | "introduce" | "carry" | "exclude";
  reason_code: DailyDecisionReason | null;
  substitution_for: string | null;
  note: string | null;
  current_target?: DailyDecisionTarget | null;
  authorized_target?: DailyDecisionTarget | null;
  // The heavy single that comes FIRST on a peak day, with `authorized_target`
  // carrying the back-off block that follows it. Present only when the day is
  // still taking the progression's own action — a day that stepped back to a hold
  // or a deload has withdrawn the peak protocol along with the load, and a
  // near-maximal single must never outlive the decision that authorized it.
  top_set?: DailyDecisionTopSet;
  progression_evidence?: DailyDecisionProgressionEvidence | null;
  brain_decision_id?: number | null;
  brain_change_summary?: string | null;
  brain_change_reason?: string | null;
  brain_change_reason_provenance?: Record<string, unknown> | null;
  brain_change_reversible?: boolean | null;
}

export interface DailyDecisionEnvelope {
  policy_version: string;
  input_fingerprint: string;
  generated_at: string;
  date: string;
  kind: DailyDecisionKind;
  baseline_kind: DailyDecisionKind;
  request: {
    override: string | null;
    train_anyway: boolean;
    equipment: string | null;
    minutes: number | null;
    goal: string | null;
  };
  template: {
    day_number: number | null;
    plan_day_id: number | null;
    focus: string | null;
    intent: "template" | "custom";
  };
  muscles: {
    required: string[];
    allowed: string[];
    reduced: string[];
    excluded: string[];
    // Groups the acute gate (or volume-high) marked saturated. Optional so
    // historical envelope_json remains readable; composition treats missing as [].
    saturated?: string[];
  };
  caps: {
    volume: "minimal" | "reduced" | "normal";
    intensity: "easy" | "deload" | "hold" | "normal";
    duration_min: number | null;
  };
  recovery_cycle: DailyDecisionSnapshot["recovery_cycle"];
  candidates: DailyDecisionCandidate[];
  hard_constraints: Array<{ code: DailyDecisionReason; detail: string }>;
  soft_preferences: Array<{ code: DailyDecisionReason; detail: string }>;
  rationale: Array<{ code: DailyDecisionReason; text: string }>;
  precedence: DailyDecisionReason[];
  // Compact provenance for the soft intent bias (role + source; no scores).
  // Optional so historical envelope_json rows remain readable.
  training_intent?: DailyDecisionSnapshot["training_intent"];
  // Structured safety provenance lets Stage 3 certify cardio against the
  // actual protective areas instead of guessing from prose or muscle groups.
  // Optional so historical envelope_json remains readable; an old envelope
  // with injury_exclusion but no structure is treated as uncertifiable.
  protective_exclusions?: Array<{ areas: string[]; exercises: string[] }>;
  // Recent athlete-reported pain is softer than an active injury, but known
  // relevant cardio still must not slip past the movement-level reduction.
  reported_joint_pain?: string | null;
  // The envelope's UP direction. Not a sixth posture/intensity value — the
  // SignalPosture / caps.intensity ladders stay safety ladders. `level: "push"`
  // licenses a within-session reach; `null` is the ordinary train day.
  reach: DailyDecisionReach;
}

export interface DailyDecisionReach {
  level: "push" | null;
  backed_by: string[];
  why: string;
}

const KNEE_GROUPS = ["quads", "hamstrings", "calves", "glutes"];

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown, max = 200): string | null {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

// The narration variant of `text`. A label can be clipped anywhere; a sentence the
// athlete reads cannot — a bare slice halved the last word and ran the fragment into
// the next line as though they were one sentence.
function prose(value: unknown, max: number): string | null {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s ? truncateAtWord(s, max) : null;
}

function boundedRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 16)) {
    if (!key || key.length > 80) continue;
    if (entry == null || typeof entry === "boolean" || typeof entry === "number") out[key] = entry;
    else if (typeof entry === "string") out[key] = text(entry, 240);
  }
  return Object.keys(out).length ? out : null;
}

function prescriptionTarget(value: any, mode: unknown): DailyDecisionTarget | null {
  if (!value || typeof value !== "object") return null;
  const timed = mode === "timed";
  const target: DailyDecisionTarget = {
    mode: timed ? "timed" : "reps",
    sets: finite(value.sets),
    rep_low: timed ? null : finite(value.rep_low),
    rep_high: timed ? null : finite(value.rep_high),
    target_weight: timed ? null : finite(value.weight),
    target_seconds: timed ? finite(value.seconds) : null,
  };
  return target;
}

// The heavy single off a progression entry, when it carries one and the numbers
// are real. Reps are the SET's reps (a single, a double, a triple), so a zero or a
// missing load means there is no protocol to describe and the day is an ordinary
// one — the back-off block in `suggested` already stands on its own.
function topSetOf(value: any): DailyDecisionTopSet | null {
  const weight = finite(value?.weight);
  const reps = finite(value?.reps);
  if (weight == null || reps == null || reps <= 0) return null;
  return { weight, reps };
}

function dedupe(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const v = raw == null ? "" : String(raw).trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// A stable, key-sorted serialization so two evaluations of an equivalent snapshot
// hash identically regardless of object key insertion order.
function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`;
}

export function dailyDecisionFingerprint(snapshot: DailyDecisionSnapshot): string {
  return crypto
    .createHash("sha256")
    .update(stableJson({ policy_version: DAILY_DECISION_POLICY_VERSION, snapshot }))
    .digest("hex");
}

function driftOf(value: unknown): "down" | "flat" | "up" | null {
  const n = finite(value);
  if (n == null) return null;
  if (n <= -0.5) return "down";
  if (n >= 0.5) return "up";
  return "flat";
}

// Readiness is a CURRENT decision signal only when its dated reading is within
// the sensor's freshness horizon of the day being read (see sensor-freshness.ts
// — matches day-read.ts's own readiness gate). A stale reading behaves exactly
// as absent: it must not silently fall through to the 14-day average, which
// would let an old datum keep driving the volume clamp under a different name.
function recoveryReadiness(recovery: any, asOf: string): "low" | "moderate" | "high" | null {
  const r = recovery?.recovery ?? recovery ?? {};
  const readinessDate = recovery?.quality?.training_readiness?.latest_date ?? null;
  if (!sensorIsCurrent("training_readiness", readinessDate, asOf)) return null;
  const n = finite(r.training_readiness);
  if (n == null) return null;
  if (n >= 66) return "high";
  if (n >= 40) return "moderate";
  return "low";
}

function effectiveRecoveryReadiness(
  snapshot: DailyDecisionSnapshot
): "low" | "moderate" | "high" | null {
  const capacity = snapshot.recovery_capacity;
  const raw = snapshot.recovery.readiness;
  if (capacity?.status === "constrained") return "low";
  if (capacity?.status === "supportive") return raw === "low" ? "moderate" : raw;
  return raw;
}

const ILLNESS_RE = /\b(ill|sick|flu|cold|fever|covid|infection|unwell)\b/i;
const TRAIN_INTENT_RE =
  /^(?:(?:i|we)\s+(?:still\s+)?(?:(?:want|choose|plan|intend)\s+to|(?:am|are)\s+going\s+to|will|can)\s+)?(?:train anyway|train|lift|push|do (?:the )?full (?:session|workout)|full (?:session|workout))(?:\s+(?:today|now|anyway))?[.!]?$/i;
const NEGATED_TRAIN_INTENT_RE =
  /\b(?:do not|don't|cannot|can't|won't|shouldn't|mustn't|not going to|unable to|skip|avoid|no)\b[\s\S]{0,40}\b(?:train|lift|push|session|workout)\b/i;

export function isTrainIntentOverride(value: unknown): boolean {
  const input = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return !!input && !NEGATED_TRAIN_INTENT_RE.test(input) && TRAIN_INTENT_RE.test(input);
}

function recentLowPerformanceCount(date: string): number {
  const since = addDaysISO(date, -42) ?? date;
  try {
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.date AS date
           FROM sessions s
           LEFT JOIN daily_session_compositions d
             ON d.session_id = s.id AND d.status = 'active'
          WHERE s.date >= ? AND s.date <= ?
            AND COALESCE(s.kind, 'strength') = 'strength'
            AND s.performance <= 2
            AND (
              d.id IS NULL
              OR json_extract(d.provenance_json, '$.daily_decision.caps.intensity') IS NULL
              OR json_extract(d.provenance_json, '$.daily_decision.caps.intensity') = 'normal'
            )
          ORDER BY s.date DESC`
      )
      .all(since, date) as any[];
    const dates = new Set<string>();
    for (const row of rows) {
      if (sessionLogContradictsLowRating(Number(row.id))) continue;
      dates.add(String(row.date));
      if (dates.size >= 2) break;
    }
    return dates.size;
  } catch {
    return 0;
  }
}

function latestPerformanceContradictedByLog(date: string): boolean {
  const today = String(date).slice(0, 10);
  const since = addDaysISO(today, -2) ?? today;
  try {
    const row = db
      .prepare(
        `SELECT id, performance FROM sessions
          WHERE date >= ? AND date <= ? AND performance IS NOT NULL
          ORDER BY date DESC, id DESC LIMIT 1`
      )
      .get(since, today) as any;
    if (!row || Number(row.performance) > 2) return false;
    return sessionLogContradictsLowRating(Number(row.id));
  } catch {
    return false;
  }
}

// Gather the bounded, serializable decision snapshot for a date. Every source is
// read defensively: an absent optional signal degrades to null/empty rather than
// throwing, so the policy always has SOMETHING to decide from (at minimum the
// adaptive plan selection). No raw health payloads are captured — only bounded,
// render-safe derived facts (per docs §4 / §11 observability).
export function gatherDailyDecisionSnapshot(
  date?: string,
  opts: {
    override?: string | null;
    train_anyway?: boolean;
    equipment?: string | null;
    minutes?: number | null;
    goal?: string | null;
  } = {}
): DailyDecisionSnapshot {
  const d = String(date || localDateISO()).slice(0, 10);

  let selected = safe(() => selectedPlanDayForDate(d), null);
  // Preparing an adaptive session creates and links an otherwise-empty session
  // row. That row is persistence plumbing, not new coaching evidence. Re-run the
  // original adaptive selector while the composition is unstarted so an exact
  // lost-response retry does not refresh solely because its own row now says
  // source=existing-session.
  if (selected?.source === "existing-session" && hasUnstartedAdaptiveComposition(d)) {
    const adaptive = safe(() => selectAdaptivePlanDay(d), null);
    const adaptiveDay = adaptive?.day_number != null ? safe(() => getPlanDay(adaptive.day_number), null) : null;
    if (adaptive && adaptiveDay) {
      selected = {
        date: d,
        plan_day_id: Number(adaptiveDay.id),
        day_number: adaptive.day_number,
        focus: adaptive.focus,
        selection: adaptive.selection,
        source: "adaptive" as const,
      };
    }
  }
  const basePlanDay = selected?.day_number != null ? safe(() => getPlanDay(selected.day_number), null) : null;
  const recoveryCycle = safe(() => recoveryCycleAt(d), null);
  const activeCycle =
    recoveryCycle &&
    recoveryCycle.id != null &&
    (recoveryCycle.effective_status === "active" || recoveryCycle.effective_status === "recheck")
      ? recoveryCycle
      : null;
  const planDay =
    basePlanDay && activeCycle ? adaptBasePlanDayForRecovery(basePlanDay, activeCycle.overlay) : basePlanDay;
  const selection = (selected?.selection ?? {}) as Record<string, any>;

  const recoverySummary = safe(() => getRecoverySummary(14, undefined, d), null);
  const supportSlice = compactSignalSupport(d, recoverySummary);
  const read = safe(() => dayRead(d, recoverySummary), null);
  const signals = (read?.signals ?? {}) as Record<string, any>;

  const injuryImpacts = safe(() => getInjuryImpacts(d), { injuries: [], count: 0 }) as any;
  const contextEvents = safe(() => listContextEvents({ activeOnly: true, on: d }), []) as any[];
  const symptomEvents = (
    safe(() => listTrainingSymptoms({ on: d, seed_legacy: false }), []) as any[]
  ).filter((event) => event.legacy_unconfirmed !== true);

  const autoreg = safe(() => recentAutoregulation(undefined, d), {
    soreness: null,
    performance: null,
    joint_pain: null,
    date: null,
    soreness_groups: [],
    performance_groups: [],
  });
  const checkinRow = safe(() => getCheckinByDate(d), null) as any;

  // The gate reads the decaying residual over its own lookback, NOT a 2-day
  // window: a big hamstring day three mornings back is still a gate, and
  // yesterday's rear-delt work is not. Clipping to 2 days here would have hidden
  // the first case from the envelope entirely.
  const muscleLoad = safe(() => acuteGates(d), new Map()) as Map<string, AcuteGateReading>;
  const endurance = safe(() => recentEnduranceImpacts(3, d), []) as any[];

  const programState = safe(() => getProgramState(d, recoverySummary), null) as any;
  const progression =
    selected?.day_number != null ? (safe(() => planDayProgression(selected.day_number), []) as any[]) : [];

  // One intent read for the whole snapshot — fingerprint-stable role + priorities.
  const resolvedIntent = safe(() => getTrainingIntent(), {
    priorities: ["strength", "muscle", "longevity"] as TrainingPriority[],
    endurance_role: "none" as EnduranceRole,
    endurance_capacity: null,
    source: "derived" as const,
  });

  const override = prose(opts.override, 200);
  const contextInjuries = (Array.isArray(injuryImpacts?.injuries) ? injuryImpacts.injuries : []).map((inj: any) => ({
    title: text(inj?.title ?? inj?.text, 120) ?? "injury",
    constraint_level: inj?.constraint_level === "soft_recheck" ? ("soft_recheck" as const) : ("protective" as const),
    areas: dedupe([...(Array.isArray(inj?.areas) ? inj.areas : []), inj?.area]),
    exercises: dedupe((Array.isArray(inj?.affected) ? inj.affected : []).map((a: any) => a?.exercise)).slice(0, 12),
  }));
  const symptomInjuries = symptomEvents.slice(0, 8).map((event) => {
    const area = text(event.area_text, 300) ?? "reported discomfort";
    const affected = (Array.isArray(planDay?.items) ? planDay.items : [])
      .filter((item: any) =>
        painAreaLoadsExercise(area, {
          name: planItemLabel(item),
          muscle_group: item?.muscle_group,
        })
      )
      .map((item: any) => planItemLabel(item));
    return {
      title: `Reported ${area}`.slice(0, 120),
      // Acuity is a claim about the athlete's own account, so it reads STATED
      // freshness. A watch kept live by quiet training stays visible as a
      // soft recheck rather than hardening into a protective constraint that
      // nobody has restated in weeks.
      constraint_level:
        event.stated_freshness === "acute_movement_brake" ? ("protective" as const) : ("soft_recheck" as const),
      areas: [area.toLowerCase()],
      exercises: dedupe(affected).slice(0, 12),
    };
  });
  const agenda = safe(() => flexibleTrainingAgenda(d), null);
  const openKeyRun =
    agenda?.available === true && Array.isArray(agenda.intents)
      ? agenda.intents
          .filter(
            (intent: any) =>
              intent?.status === "open" &&
              (intent?.kind === "quality" || intent?.kind === "long") &&
              /^\d{4}-\d{2}-\d{2}$/.test(String(intent?.suggested_date ?? ""))
          )
          .sort(
            (a: any, b: any) =>
              String(a.suggested_date).localeCompare(String(b.suggested_date)) ||
              String(a.intent_id ?? a.id ?? "").localeCompare(String(b.intent_id ?? b.id ?? ""))
          )[0] ?? null
      : null;
  // The learned plan-complexity default, read fail-soft (a problem in the learning
  // layer must never cost the athlete their day's decision) and stamped ONLY in the
  // easing direction. `plan_complexity` is declared with `max: 1`, so the producer
  // can hold at 1 or ease below it and never push above — this narrows that to the
  // one case the snapshot has any use for, which is also what keeps an unlearned
  // snapshot hashing exactly as it did before the field existed. The floor rejects
  // an implausible scale outright rather than passing it on.
  const planComplexityScale = safe(() => {
    const scale = Number(personalResponseModifierFor("plan_complexity")?.scale);
    return Number.isFinite(scale) && scale >= 0.5 && scale < 1 ? scale : null;
  }, null);
  return {
    date: d,
    request: {
      override,
      // `train_anyway` is a first-class request bit. Recognizing the legacy
      // phrase keeps cached/offline requests from older clients replayable
      // without letting arbitrary "train" prose silently become an override.
      train_anyway: opts.train_anyway === true || isTrainIntentOverride(override),
      equipment: text(opts.equipment, 200),
      minutes: opts.minutes != null ? finite(opts.minutes) : null,
      goal: text(opts.goal, 120),
    },
    plan: {
      day_number: selected?.day_number ?? null,
      focus: text(selected?.focus ?? planDay?.focus ?? null, 160),
      plan_day_id: selected?.plan_day_id ?? planDay?.id ?? null,
      source: text(selected?.source ?? null, 40),
      reason: prose(selection?.reason ?? null, 300),
      due: dedupe(Array.isArray(selection?.due) ? selection.due : []),
      over: dedupe(Array.isArray(selection?.over) ? selection.over : []),
    },
    day_read: {
      kind: (read?.kind as any) ?? null,
      focus: text(read?.focus ?? null, 160),
      est_minutes: finite(read?.est_minutes),
      consecutive_training_days: finite(signals?.consecutive_training_days),
      recovery_week: signals?.recovery_week != null && signals.recovery_week !== false,
      trained_today: signals?.trained_today === true || signals?.logged_today === true,
    },
    recovery: {
      has_data: recoverySummary?.has_data === true,
      readiness: recoveryReadiness(recoverySummary, d),
      hrv_drift: driftOf(recoverySummary?.delta?.hrv),
      rhr_drift: driftOf(recoverySummary?.delta?.rhr),
      sleep_drift: driftOf(recoverySummary?.delta?.sleep),
    },
    recovery_cycle: activeCycle
      ? {
          id: Number(activeCycle.id),
          effective_status: activeCycle.effective_status as "active" | "recheck",
          effective_on: activeCycle.effective_on,
          recheck_on: activeCycle.recheck_on,
          exit_on: activeCycle.exit_on,
          working_set_fraction: Number(activeCycle.overlay?.working_set_fraction ?? 0.5),
        }
      : null,
    muscle_load: [...muscleLoad.values()]
      .map((rl: any) => ({
        group: String(rl?.group ?? "").toLowerCase(),
        days_ago: finite(rl?.days_ago) ?? 0,
        saturated: rl?.saturated === true,
        source: text(rl?.source, 20) ?? "strength",
      }))
      .filter((rl) => rl.group)
      .sort((a, b) => a.group.localeCompare(b.group)),
    endurance: endurance
      .map((e: any) => ({
        type: text(e?.type, 40) ?? "cardio",
        days_ago: finite(e?.days_ago) ?? 0,
        intensity: text(e?.intensity, 20) ?? "moderate",
        load: text(e?.load, 20) ?? "moderate",
        regions: dedupe(Array.isArray(e?.regions) ? e.regions : []),
      }))
      .sort((a, b) => a.days_ago - b.days_ago || a.type.localeCompare(b.type)),
    checkin: checkinRow
      ? {
          soreness: finite(checkinRow.soreness),
          energy: finite(checkinRow.energy),
          sleep_feel: finite(checkinRow.sleep_feel),
        }
      : null,
    feedback:
      autoreg.soreness != null || autoreg.performance != null || autoreg.joint_pain
        ? {
            soreness: finite(autoreg.soreness),
            performance: finite(autoreg.performance),
            joint_pain: prose(autoreg.joint_pain, 300),
            low_performance_count: recentLowPerformanceCount(d),
            ...(latestPerformanceContradictedByLog(d) ? { log_contradicts_low_rating: true } : {}),
          }
        : null,
    constraints: {
      injuries: [...contextInjuries, ...symptomInjuries].slice(0, 16),
      illness: contextEvents.some((e) => ILLNESS_RE.test(`${e?.title ?? ""} ${e?.detail ?? ""}`)),
      travel: contextEvents.some((e) => e?.kind === "trip"),
    },
    program: {
      mesocycle_phase: text(programState?.mesocycle?.phase, 40),
      adaptations_due: dedupe(Array.isArray(programState?.adaptations_due) ? programState.adaptations_due : []).slice(
        0,
        12
      ),
      volume_low_groups: dedupe(
        (Array.isArray(programState?.volume) ? programState.volume : [])
          .filter((v: any) => v?.band === "low")
          .map((v: any) => v?.muscle_group)
      ),
      volume_high_groups: dedupe(
        (Array.isArray(programState?.volume) ? programState.volume : [])
          .filter((v: any) => v?.band === "high")
          .map((v: any) => v?.muscle_group)
      ),
    },
    progression: progression
      .map((p: any) => ({
        exercise: text(p?.exercise, 120) ?? "",
        muscle_group: null as string | null,
        action: text(p?.action, 20) ?? "hold",
        why: prose(p?.why, 240) ?? "",
        vary_to: text(p?.vary_to ?? p?.vary_options?.[0]?.name, 120),
        current_target: prescriptionTarget(p?.current, p?.mode),
        suggested_target: prescriptionTarget(p?.suggested, p?.mode),
        // Spread, not a null field: `stableJson` walks Object.keys, so writing the
        // key on every ordinary day would move every fingerprint in existence.
        ...(topSetOf(p?.top_set) ? { top_set: topSetOf(p?.top_set) as DailyDecisionTopSet } : {}),
        evidence: {
          delta_text: text(p?.delta_text, 80),
          why: prose(p?.why, 240),
          reground: p?.reground === true,
          autoregulated: p?.autoregulated === true,
          movement_response: text(p?.movement_response, 40),
          rep_step: p?.rep_step === true,
          dose_eligibility:
            p?.dose_eligibility && typeof p.dose_eligibility === "object"
              ? {
                  linked_outcome: p.dose_eligibility.linked_outcome === true,
                  eligible: p.dose_eligibility.eligible === true,
                  reason: text(p.dose_eligibility.reason, 80) ?? "unknown",
                }
              : null,
        },
      }))
      .filter((p) => p.exercise)
      .slice(0, 24),
    plan_items: (Array.isArray(planDay?.items) ? planDay.items : [])
      .map((it: any) => {
        const isCardio = String(it?.kind ?? "").toLowerCase() === "cardio";
        // Cardio plan rows store the athlete-facing label in `note` (no exercise_id).
        const exercise = planItemLabel(it);
        return {
          exercise,
          muscle_group: text(it?.muscle_group, 40),
          equipment: isCardio ? null : text(findExercise(String(it?.exercise ?? ""))?.equipment, 40),
          mode: text(it?.mode, 20) ?? "reps",
          kind: isCardio ? "cardio" : (text(it?.kind, 20) ?? "strength"),
          sets: finite(it?.sets),
          rep_low: finite(it?.rep_low),
          rep_high: finite(it?.rep_high),
          target_weight: finite(it?.target_weight),
          target_seconds: finite(it?.target_seconds),
          target_distance_km: finite(it?.target_distance_km),
          target_duration_min: finite(it?.target_duration_min),
          target_zone: text(it?.target_zone, 40),
          brain_decision_id: finite(it?.brain_decision_id),
          brain_change_summary: prose(it?.brain_change_summary, 500),
          brain_change_reason: prose(it?.brain_change_reason, 600),
          brain_change_reason_provenance: boundedRecord(it?.brain_change_reason_provenance),
          brain_change_reversible:
            it?.brain_change_reversible == null ? null : it.brain_change_reversible === true,
        };
      })
      .filter((it: any) => it.exercise)
      .slice(0, 24),
    training_intent: {
      endurance_role: resolvedIntent.endurance_role,
      priorities: Array.isArray(resolvedIntent.priorities)
        ? (resolvedIntent.priorities.slice(0, 5) as TrainingPriority[])
        : (["strength", "muscle", "longevity"] as TrainingPriority[]),
      source: resolvedIntent.source === "explicit" ? "explicit" : "derived",
    },
    open_key_run: openKeyRun
      ? {
          intent_id: text(openKeyRun.id, 160) ?? `${d}:${openKeyRun.kind}`,
          kind: openKeyRun.kind as "quality" | "long",
          suggested_date: String(openKeyRun.suggested_date),
        }
      : null,
    // Spread rather than a `null` field on purpose: stableJson walks Object.keys,
    // so writing the key with a null value would change every fingerprint on the
    // planet the day this shipped. Absent means absent.
    ...(planComplexityScale == null ? {} : { personal_response: { plan_complexity: planComplexityScale } }),
    ...(supportSlice.signal_support ? { signal_support: supportSlice.signal_support } : {}),
    ...(supportSlice.recovery_capacity ? { recovery_capacity: supportSlice.recovery_capacity } : {}),
  };
}

function lastNightSleepsEnough(date: string): boolean {
  const lastNight = safe(() => latestSleep(SENSOR_MAX_AGE_DAYS.sleep, date), null);
  const lastNightAge = sensorAgeDays(lastNight?.date ?? null, date);
  return (
    lastNightAge != null &&
    lastNightAge >= 0 &&
    lastNightAge <= 1 &&
    lastNight?.total_min != null &&
    Number(lastNight.total_min) >= 360
  );
}

function compactRecoveryCapacity(
  state: ReturnType<typeof dayPlanningSignalState> | null,
  date: string
): DailyDecisionSnapshot["recovery_capacity"] | null {
  const dim = state?.dimensions.recovery_capacity;
  if (!dim) return null;
  if (dim.status === "unknown" && dim.confidence === "none") return null;
  const fresh = (field: string) =>
    dim.evidence.some((item) => item.field === field && item.freshness !== "stale");
  return {
    status: dim.status,
    confidence: dim.confidence,
    fresh_hrv: fresh("hrv"),
    fresh_resting_hr: fresh("resting_hr"),
    fresh_sleep: fresh("sleep"),
    slept_enough: lastNightSleepsEnough(date),
  };
}

function compactSignalSupport(
  date: string,
  recovery: unknown
): {
  signal_support?: DailyDecisionSignalSupport;
  recovery_capacity?: DailyDecisionSnapshot["recovery_capacity"];
} {
  const drive = safe(() => (getSettings().training_drive === "push" ? "push" : "steady"), "steady") as
    | "push"
    | "steady";
  const state = safe(() => dayPlanningSignalState(date, { recovery }), null);
  const recovery_capacity = compactRecoveryCapacity(state, date) ?? undefined;
  if (!state) {
    if (drive === "steady") return { recovery_capacity };
    return {
      recovery_capacity,
      signal_support: {
        training_drive: drive,
        backed: false,
        backed_by: [],
        training_directive: "proceed",
        fresh_brake: false,
      },
    };
  }
  const backed = state.action.support?.level === "backed";
  const backed_by = backed
    ? (Array.isArray(state.action.support?.fields) ? state.action.support.fields : [])
        .map((field) => text(field, 40))
        .filter((field): field is string => !!field)
        .slice(0, 8)
    : [];
  const rawDirective = state.action.directives?.training;
  const training_directive: DailyDecisionSignalSupport["training_directive"] =
    rawDirective === "hold_aggression" || rawDirective === "modify" || rawDirective === "recover"
      ? rawDirective
      : "proceed";
  const fresh_brake = hasFreshBrake(state.dimensions);
  if (drive === "steady" && !backed && training_directive === "proceed" && !fresh_brake) {
    return { recovery_capacity };
  }
  return {
    recovery_capacity,
    signal_support: {
      training_drive: drive,
      backed,
      backed_by,
      training_directive,
      fresh_brake,
    },
  };
}

function hasUnstartedAdaptiveComposition(date: string): boolean {
  try {
    return !!db
      .prepare(
        `SELECT d.id
           FROM daily_session_compositions d
           JOIN sessions s ON s.id = d.session_id
          WHERE d.date = ? AND d.status = 'active' AND d.source = 'adaptive_plan'
            AND NOT EXISTS (SELECT 1 FROM logged_sets ls WHERE ls.session_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM session_skips ss WHERE ss.session_id = s.id)
            AND s.finished_at IS NULL
            AND s.duration_min IS NULL
            AND NULLIF(TRIM(COALESCE(s.notes, '')), '') IS NULL
            AND s.soreness IS NULL
            AND s.performance IS NULL
            AND NULLIF(TRIM(COALESCE(s.joint_pain, '')), '') IS NULL
            AND NULLIF(TRIM(COALESCE(s.garmin_json, '')), '') IS NULL
          LIMIT 1`
      )
      .get(date);
  } catch {
    return false;
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

const CARDIO_LOAD_GROUPS: Array<{ re: RegExp; groups: string[] }> = [
  {
    re: /\b(?:run|running|jog|jogging|sprint|treadmill|trail run)\b/i,
    groups: ["quads", "hamstrings", "glutes", "calves"],
  },
  {
    re: /\b(?:ride|riding|bike|biking|cycle|cycling|spin)\b/i,
    groups: ["quads", "hamstrings", "glutes", "calves"],
  },
  { re: /\b(?:walk|walking|hike|hiking|ruck|rucking)\b/i, groups: ["quads", "hamstrings", "glutes", "calves"] },
  { re: /\b(?:elliptical|stair|stepper)\b/i, groups: ["quads", "hamstrings", "glutes", "calves"] },
  { re: /\b(?:row|rowing|erg)\b/i, groups: ["back", "hamstrings", "glutes"] },
  { re: /\b(?:swim|swimming)\b/i, groups: ["shoulders", "back", "chest"] },
];

// `true` means the named cardio mode loads a protected area, `false` means its
// canonical load groups certify it clear, and `null` means the label or area is
// too vague to certify. Stage 2 and Stage 3 share this exact conservative seam.
export function cardioPainRelevance(
  exercise: string | null | undefined,
  painAreas: Array<string | null | undefined>
): boolean | null {
  const label = String(exercise ?? "").trim();
  const areas = painAreas.map((area) => String(area ?? "").trim()).filter(Boolean);
  if (!label || !areas.length) return null;
  const load = CARDIO_LOAD_GROUPS.find((entry) => entry.re.test(label));
  if (!load) return null;
  for (const area of areas) {
    // An unclassified protective area makes certification impossible. Known
    // upper-body areas can still certify lower-body cardio safe (and vice versa).
    if (!muscleGroupsForPainArea(area).length) return null;
    if (
      load.groups.some((group) =>
        painAreaLoadsExercise(area, {
          name: label,
          muscle_group: group,
        })
      )
    ) {
      return true;
    }
  }
  return false;
}

function planItemLabel(item: any): string {
  const isCardio = String(item?.kind ?? "").toLowerCase() === "cardio";
  if (isCardio) return text(cardioPlanIdentity(item).movement_label, 120) ?? "Run";
  return text(item?.exercise, 120) ?? "";
}

// Groups an active/joint-pain injury excludes from loaded work today. Injury
// `areas` are body areas; joint pain maps through the shared JOINT_GROUP_MAP so
// "left knee" reduces quads/hams/calves the same way every other consumer sees.
function excludedGroups(snapshot: DailyDecisionSnapshot): { groups: string[]; jointGroups: string[] } {
  const injuryGroups: string[] = [];
  for (const inj of snapshot.constraints.injuries) {
    if ((inj.constraint_level ?? "protective") !== "protective") continue;
    for (const area of inj.areas) injuryGroups.push(...muscleGroupsForPainArea(area));
  }
  const jointText = snapshot.feedback?.joint_pain ?? null;
  const jointGroups: string[] = [];
  if (jointText) {
    // Reuse the movement-level relevance test on the plan items to find groups the
    // sore joint loads. Deterministic and conservative (unmapped text → nothing).
    for (const it of snapshot.plan_items) {
      if (it.muscle_group && painAreaLoadsExercise(jointText, { name: it.exercise, muscle_group: it.muscle_group })) {
        jointGroups.push(it.muscle_group);
      }
    }
    if (/knee/i.test(jointText)) jointGroups.push(...KNEE_GROUPS);
  }
  return { groups: dedupe(injuryGroups), jointGroups: dedupe(jointGroups) };
}

const PROGRESSION_REASON: Record<string, DailyDecisionReason> = {
  overload: "progression_overload",
  hold: "progression_hold",
  deload: "progression_deload",
  vary: "progression_vary",
  introduce: "progression_introduce",
};

const LOWER_BODY_GROUPS = new Set(["quads", "hamstrings", "glutes", "calves"]);

// Below this, the learned plan-complexity default prefers the simpler shape. The
// producer emits only 1 (hold) or 0.9 (ease) for this target and declares `max: 1`,
// so the threshold sits between those two rather than inventing a third position.
const PLAN_COMPLEXITY_SIMPLER_BELOW = 0.95;

// What a below-1 plan-complexity modifier MEANS: plan days kept going unfinished,
// and the athlete's own record is the evidence that the standard ask is more than
// the day holds. It joins `softenVolume` below, which is a cap on what Stage 3
// OFFERS (movements, working sets, sets per movement) — never a limit on what the
// athlete may then do. Nothing else about the day changes: not the kind, not the
// intensity cap, not a single hard constraint.
// Deliberately un-coerced: `Number.isFinite` on the raw value, so a stored envelope
// carrying a string where a number belongs reads as "nothing learned" rather than
// quietly steering the day.
function earnedSimplerDay(snapshot: DailyDecisionSnapshot): boolean {
  const scale = snapshot.personal_response?.plan_complexity;
  return Number.isFinite(scale) && (scale as number) < PLAN_COMPLEXITY_SIMPLER_BELOW;
}

// Athlete-facing (soft preferences surface in the session preview), so a set rather
// than one literal — a stable learning would otherwise print the same sentence every
// morning for weeks. Worded about the DAY rather than the person: adherence evidence
// lowers the ask, it never blames.
const PLAN_COMPLEXITY_EASE_DETAILS: readonly string[] = [
  "Recent fuller days haven't been fitting — keeping today simpler",
  "Keeping today's list short, the way recent weeks have actually run",
  "A simpler shape today; the longer days haven't been fitting lately",
];

// Train-anyway on a rest morning: keep the working load, leave the extra top set
// off, keep the clock shorter. Several phrasings because a stable input used to
// print one sentence every time they chose to train.
export const TRAIN_ANYWAY_REST_RATIONALE: readonly string[] = [
  "Training by choice — keep the working load, leave the extra top set off, and keep the session shorter.",
  "Training by choice — same working sets, no extra top set, and a shorter window.",
  "Training by choice — hold the working load, skip the extra top set, and keep it compact.",
  "Training by choice — keep what you usually lift, leave the extra top set off, and keep it shorter.",
];

// Athlete-facing reach lines. A backed push morning is a reason to go after a
// little more inside the session, never a gate and never a score. Rotated so a
// stable input does not print one sentence for weeks.
export const REACH_PUSH_WHY: readonly [string, ...string[]] = [
  "You've earned a heavier look at this one today",
  "Recovery's backing you — take the top set if the bar moves fast",
  "Recent sessions have come back clean — today's a good day to reach a little",
  "You're carrying the work well — a heavier look fits today",
];
export const REACH_TRIMMED_WHY: readonly [string, ...string[]] = [
  "Fueling keeps today's reach to the working sets",
  "Eat a bit more and the heavier look can wait — the working sets still stand",
  "Today's reach stays with the working sets while fueling catches up",
  "The working sets are the reach today — fueling is still settling",
];

// Composition could not seat a distinct top set (the day is already at its
// item cap, the heavier look does not exceed the working weight, or no
// eligible host remains). The day is still a reach day — the working sets
// carry it. Athlete-facing, so a set rather than one literal.
export const REACH_NO_ROOM_WHY: readonly [string, ...string[]] = [
  "Today's reach lives in the working sets",
  "The working sets are the reach today",
  "Reach stays with the working sets today",
  "No extra top set today — the working sets still stand",
];

const EMPTY_REACH: DailyDecisionReach = { level: null, backed_by: [], why: "" };

const TRAIN_DAY_DEFAULT_MINUTES = 60;

function planDayDurationEstimate(snapshot: DailyDecisionSnapshot): number {
  const cardioMins = snapshot.plan_items
    .map((it) => (String(it.kind ?? "").toLowerCase() === "cardio" ? finite(it.target_duration_min) : null))
    .filter((n): n is number => n != null && n > 0);
  const hasStrength = snapshot.plan_items.some((it) => String(it.kind ?? "").toLowerCase() !== "cardio");
  if (hasStrength) return TRAIN_DAY_DEFAULT_MINUTES;
  if (cardioMins.length) return Math.round(cardioMins.reduce((a, b) => a + b, 0));
  return TRAIN_DAY_DEFAULT_MINUTES;
}

// Early-out only: if the first plan item's group is already saturated, do not
// license a reach. Composition re-checks the ACTUAL surviving host (the first
// plan item may have been excluded) and refuses a host with no group.
function mainLiftGroup(snapshot: DailyDecisionSnapshot): string | null {
  for (const item of snapshot.plan_items) {
    if (String(item.kind ?? "").toLowerCase() === "cardio") continue;
    if (String(item.mode ?? "").toLowerCase() === "timed") continue;
    const group = item.muscle_group ? String(item.muscle_group).toLowerCase() : "";
    if (group) return group;
  }
  return null;
}

function resolveReach(
  snapshot: DailyDecisionSnapshot,
  kind: DailyDecisionKind,
  saturated: string[]
): { reach: DailyDecisionReach; trimmed: boolean } {
  const support = snapshot.signal_support;
  if (!support || kind !== "train") return { reach: EMPTY_REACH, trimmed: false };
  if (support.training_drive !== "push") return { reach: EMPTY_REACH, trimmed: false };
  if (support.fresh_brake) return { reach: EMPTY_REACH, trimmed: false };
  const capacity = snapshot.recovery_capacity;
  const capacityBacked = supportiveCapacityBacksDay({
    status: capacity?.status,
    confidence: capacity?.confidence,
    freshHrv: capacity?.fresh_hrv === true,
    freshRestingHr: capacity?.fresh_resting_hr === true,
    freshSleep: capacity?.fresh_sleep === true,
    sleptEnough: capacity?.slept_enough === true,
    freshBrake: support.fresh_brake,
    trainingDirective: support.training_directive,
  });
  if (!support.backed && !capacityBacked) return { reach: EMPTY_REACH, trimmed: false };
  const directive = support.training_directive;
  if (support.backed) {
    if (directive !== "proceed" && directive !== "hold_aggression") return { reach: EMPTY_REACH, trimmed: false };
  } else if (directive !== "proceed") {
    return { reach: EMPTY_REACH, trimmed: false };
  }
  const mainGroup = mainLiftGroup(snapshot);
  if (mainGroup && saturated.includes(mainGroup)) return { reach: EMPTY_REACH, trimmed: false };
  const backed_by = support.backed
    ? Array.isArray(support.backed_by)
      ? support.backed_by.filter((field) => typeof field === "string" && field.trim()).slice(0, 8)
      : []
    : ["recovery_capacity"];
  const trimmed = support.backed && directive === "hold_aggression";
  return {
    reach: {
      level: "push",
      backed_by,
      why: trimmed
        ? pickDayVariant(REACH_TRIMMED_WHY, snapshot.date, "daily_decision:reach_trimmed")
        : pickDayVariant(REACH_PUSH_WHY, snapshot.date, "daily_decision:reach"),
    },
    trimmed,
  };
}

type CompactTrainingIntent = {
  endurance_role: EnduranceRole;
  priorities: TrainingPriority[];
  source: "explicit" | "derived";
};

function compactTrainingIntent(
  value: DailyDecisionSnapshot["training_intent"] | null | undefined
): CompactTrainingIntent {
  // Absent field (pure unit fixtures): no soft intent bias. Live gather always
  // stamps a full view via getTrainingIntent().
  if (!value || typeof value !== "object") {
    return { endurance_role: "none", priorities: [], source: "derived" };
  }
  const role = String(value.endurance_role ?? "none").toLowerCase() as EnduranceRole;
  const endurance_role: EnduranceRole =
    role === "supporting" || role === "co_primary" || role === "primary" || role === "none" ? role : "none";
  const priorities: TrainingPriority[] = [];
  for (const raw of Array.isArray(value.priorities) ? value.priorities : []) {
    const p = String(raw ?? "")
      .trim()
      .toLowerCase() as TrainingPriority;
    if (
      (p === "longevity" || p === "muscle" || p === "leanness" || p === "strength" || p === "endurance") &&
      !priorities.includes(p)
    ) {
      priorities.push(p);
    }
    if (priorities.length >= 5) break;
  }
  return {
    endurance_role,
    priorities,
    source: value.source === "explicit" ? "explicit" : "derived",
  };
}

// The pure decision. A bounded snapshot in, a versioned reason-coded envelope
// out. Deterministic apart from `generated_at` (which is excluded from the
// fingerprint), so the same snapshot always produces the same fingerprint AND
// the same decision content.
export function buildDailySessionDecision(
  snapshot: DailyDecisionSnapshot,
  opts: { now?: string } = {}
): DailyDecisionEnvelope {
  const fingerprint = dailyDecisionFingerprint(snapshot);
  const precedence: DailyDecisionReason[] = [];
  const hard: Array<{ code: DailyDecisionReason; detail: string }> = [];
  const soft: Array<{ code: DailyDecisionReason; detail: string }> = [];
  const rationale: Array<{ code: DailyDecisionReason; text: string }> = [];
  const fire = (list: DailyDecisionReason[], code: DailyDecisionReason) => {
    if (!list.includes(code)) list.push(code);
  };

  // ---- Precedence 2: injury / joint pain / equipment (hard exclusions) ----
  const { groups: injuryGroups, jointGroups } = excludedGroups(snapshot);
  const protectiveExclusions = snapshot.constraints.injuries
    .filter((injury) => (injury.constraint_level ?? "protective") === "protective")
    .map((injury) => ({
      areas: dedupe(injury.areas).slice(0, 12),
      exercises: dedupe(injury.exercises).slice(0, 12),
    }));
  for (const inj of snapshot.constraints.injuries) {
    if ((inj.constraint_level ?? "protective") === "protective") {
      hard.push({ code: "injury_exclusion", detail: `Working around ${inj.title}` });
      fire(precedence, "injury_exclusion");
    } else {
      soft.push({ code: "injury_recheck", detail: `Recheck ${inj.title} on the affected movement` });
      fire(precedence, "injury_recheck");
    }
  }
  if (snapshot.feedback?.joint_pain) {
    soft.push({ code: "joint_pain_reduce", detail: `Reported ${snapshot.feedback.joint_pain}` });
    fire(precedence, "joint_pain_reduce");
  }
  if (snapshot.request.equipment) {
    const capability = parseEquipmentCapability(snapshot.request.equipment);
    if (capability.recognized) {
      hard.push({ code: "equipment_limited", detail: `Only what ${snapshot.request.equipment} allows` });
      fire(precedence, "equipment_limited");
    }
  }

  // ---- Precedence 3: recovery / soreness / illness / travel / consecutive ----
  // KIND itself comes from the already-tested dayRead; here we record WHY and set
  // caps. An explicit "train anyway" override still wins the kind below.
  const baseKind: DailyDecisionKind = (() => {
    const k = snapshot.day_read.kind;
    if (k === "rest") return "rest";
    if (k === "easy") return "easy";
    if (k === "done") return "rest";
    return "train";
  })();
  const highSoreness =
    (snapshot.feedback?.soreness != null && snapshot.feedback.soreness >= 4) ||
    (snapshot.checkin?.soreness != null && snapshot.checkin.soreness >= 4);
  const readiness = effectiveRecoveryReadiness(snapshot);
  // Caps may open (soreness routes rather than softens; train-anyway volume
  // stays normal) only on a day that is actually open: no fresh brake, training
  // still `proceed`, and — for soreness — recovery_capacity already supportive.
  // A missing signal_support is treated as open so pure unit fixtures that
  // never stamped one keep their existing answers.
  const capsMayOpen =
    snapshot.signal_support?.fresh_brake !== true &&
    (snapshot.signal_support?.training_directive == null ||
      snapshot.signal_support.training_directive === "proceed");
  // Soreness is a ROUTING signal: the muscle envelope already rotates away from
  // the sore groups. It only skips the whole-day ease when the morning is
  // actually open AND recovery_capacity is supportive. A fresh brake or a
  // non-proceed directive keeps volume reduced even if capacity reads well.
  const sorenessRoutes =
    highSoreness && capsMayOpen && snapshot.recovery_capacity?.status === "supportive";
  const sorenessSoftensDay = highSoreness && !sorenessRoutes;
  const lowPerformance =
    snapshot.feedback?.performance != null &&
    snapshot.feedback.performance <= 2 &&
    snapshot.feedback.log_contradicts_low_rating !== true;
  const repeatedUnder = lowPerformance && Number(snapshot.feedback?.low_performance_count ?? 1) >= 2;
  if (readiness === "low") {
    fire(precedence, baseKind === "rest" ? "low_recovery_rest" : "low_recovery_easy");
    soft.push({
      code: baseKind === "rest" ? "low_recovery_rest" : "low_recovery_easy",
      detail: "Recovery is running low",
    });
  }
  if (highSoreness) {
    fire(precedence, "high_soreness");
    soft.push({ code: "high_soreness", detail: "Elevated soreness reported" });
  }
  if (repeatedUnder) {
    fire(precedence, "repeated_underperformance");
    soft.push({ code: "repeated_underperformance", detail: "Recent sessions felt underpowered" });
  } else if (lowPerformance) {
    fire(precedence, "recent_underperformance");
    soft.push({ code: "recent_underperformance", detail: "The latest session felt underpowered" });
  }
  if (snapshot.constraints.illness) {
    fire(precedence, "illness_window");
    soft.push({ code: "illness_window", detail: "Feeling-under-the-weather window" });
  }
  if (snapshot.constraints.travel) {
    fire(precedence, "travel_window");
    soft.push({ code: "travel_window", detail: "Traveling — keep it portable" });
  }
  const consecutive = snapshot.day_read.consecutive_training_days ?? 0;
  if (consecutive >= 3) {
    fire(precedence, "consecutive_training_days");
    soft.push({ code: "consecutive_training_days", detail: `${consecutive} training days in a row` });
  }

  // ---- Athlete override (docs §7: wins unless a hard safety bound) ----
  let kind = baseKind;
  const override = (snapshot.request.override ?? "").toLowerCase();
  const trainAnyway = snapshot.request.train_anyway === true || isTrainIntentOverride(override);
  let durationOverrideOnly = false;
  if (trainAnyway) {
    kind = "train";
    fire(precedence, "athlete_override");
    soft.push({ code: "athlete_override", detail: "You chose to train — recovery bounds still apply" });
    rationale.push({
      code: "athlete_override",
      text:
        baseKind === "rest"
          ? pickDayVariant(TRAIN_ANYWAY_REST_RATIONALE, snapshot.date, "daily_decision:train_anyway_rest")
          : "Training by choice — today's safety context still shapes the session.",
    });
  } else if (override) {
    if (isTrainIntentOverride(override)) {
      kind = "train";
      fire(precedence, "athlete_override");
      soft.push({ code: "athlete_override", detail: "You asked to train — kept it conservative" });
    } else if (/\b(rest|off|skip|recover)\b/.test(override)) {
      kind = "rest";
      fire(precedence, "athlete_override");
      soft.push({ code: "athlete_override", detail: "You asked to rest today" });
    } else if (/\b(easy|light|tired|rough|short|quick|busy)\b/.test(override)) {
      if (/\b(short|quick|busy|time)\b/.test(override) && !/\b(easy|light|tired|rough)\b/.test(override)) {
        durationOverrideOnly = true;
      } else if (kind === "train") {
        kind = "easy";
      }
      fire(precedence, "athlete_override");
      soft.push({ code: "athlete_override", detail: "You flagged less capacity today" });
    }
  }

  // ---- Soft training-intent view (never overrides hard recovery / injury / rest) ----
  const trainingIntent = compactTrainingIntent(snapshot.training_intent);
  const priorities = trainingIntent.priorities;
  const earlyPriorities = priorities.slice(0, 2);
  const strengthHighPriority =
    earlyPriorities.includes("muscle") ||
    earlyPriorities.includes("strength") ||
    priorities[0] === "muscle" ||
    priorities[0] === "strength";
  const longevityLeads = priorities[0] === "longevity";
  const enduranceLeads =
    trainingIntent.endurance_role === "primary" || trainingIntent.endurance_role === "co_primary";
  const enduranceSupporting = trainingIntent.endurance_role === "supporting";
  const enduranceNone = trainingIntent.endurance_role === "none";
  const openKeyRun =
    snapshot.open_key_run &&
    (snapshot.open_key_run.kind === "quality" || snapshot.open_key_run.kind === "long") &&
    /^\d{4}-\d{2}-\d{2}$/.test(snapshot.open_key_run.suggested_date)
      ? snapshot.open_key_run
      : null;
  const tomorrow = addDaysISO(snapshot.date, 1);
  const hasRelevantOpenKeyRun =
    openKeyRun != null &&
    (openKeyRun.suggested_date === snapshot.date ||
      (tomorrow != null && openKeyRun.suggested_date === tomorrow));
  const hardLowerOnPlan = snapshot.plan_items.some(
    (it) =>
      String(it.kind ?? "").toLowerCase() !== "cardio" &&
      !!it.muscle_group &&
      LOWER_BODY_GROUPS.has(String(it.muscle_group).toLowerCase())
  );

  // ---- Precedence 4: recent endurance load vs conflicting lower-body work ----
  // Physiological soft reduction always applies when recent heavy cardio loaded
  // the legs. Role only changes narrative and whether an open quality-run
  // opening soft-protects legs (primary/co_primary) vs yielding to strength
  // (supporting). Role "none" never invents co-primary quality-run obligations.
  const enduranceReduced: string[] = [];
  const heavyEndurance = snapshot.endurance.filter((e) => e.load === "heavy" || e.intensity === "hard");
  for (const e of heavyEndurance) {
    for (const region of e.regions) {
      if (LOWER_BODY_GROUPS.has(region.toLowerCase())) enduranceReduced.push(region.toLowerCase());
    }
  }
  // Soft key-run protect: primary/co_primary with an open quality cardio opening
  // and hard lower on the same template — prefer protecting the key-run slot.
  let keyRunProtect = false;
  if (enduranceLeads && hasRelevantOpenKeyRun && hardLowerOnPlan && kind !== "rest") {
    keyRunProtect = true;
    for (const it of snapshot.plan_items) {
      const group = it.muscle_group ? String(it.muscle_group).toLowerCase() : "";
      if (String(it.kind ?? "").toLowerCase() !== "cardio" && group && LOWER_BODY_GROUPS.has(group)) {
        enduranceReduced.push(group);
      }
    }
  }
  // Intent athlete-facing lines are buffered so primary_rationale (rationale[0])
  // stays the template / kind read — soft bias must not steal the headline.
  const intentRationale: Array<{ code: DailyDecisionReason; text: string }> = [];

  if (enduranceReduced.length) {
    fire(precedence, "endurance_lower_conflict");
    let detail = `Recent ${heavyEndurance[0]?.type ?? "endurance"} already loaded the legs`;
    if (keyRunProtect) {
      detail =
        openKeyRun?.suggested_date === snapshot.date
          ? "Keeping today's key-run opening clear — lower-body loading stays light"
          : "Keeping the next key-run opening clear — lower-body loading stays light today";
    } else if (enduranceSupporting) {
      detail = "Recent cardio already loaded the legs — strength recovery comes first";
    } else if (enduranceNone) {
      detail = "Recent cardio already loaded the legs";
    }
    soft.push({ code: "endurance_lower_conflict", detail });
    if (keyRunProtect) {
      intentRationale.push({
        code: "endurance_lower_conflict",
        text:
          openKeyRun?.suggested_date === snapshot.date
            ? "A key endurance session has today's opening — legs stay lighter so it can land well."
            : "A key endurance session has the next opening — legs stay lighter today so it can land well.",
      });
    } else if (enduranceSupporting && heavyEndurance.length) {
      intentRationale.push({
        code: "endurance_lower_conflict",
        text: "Supporting cardio already worked the legs — today's strength work stays a little kinder there.",
      });
    }
  }

  // Supporting endurance + open key work on a hard-lower template: the run is
  // optional context, not a plan failure. Name quality and long work accurately.
  if (enduranceSupporting && hasRelevantOpenKeyRun && hardLowerOnPlan && kind === "train") {
    const supportingKeyDetail =
      openKeyRun?.kind === "long"
        ? "Supporting cardio context — the long run is optional after strength"
        : "Supporting cardio context — quality is optional after strength";
    const supportingKeyRationale =
      openKeyRun?.kind === "long"
        ? "Cardio supports the higher goals today — the long run stays optional so the strength session can land cleanly."
        : "Cardio supports the higher goals today — any quality work stays optional so the strength session can land cleanly.";
    fire(precedence, "training_intent");
    soft.push({
      code: "training_intent",
      detail: supportingKeyDetail,
    });
    intentRationale.push({
      code: "training_intent",
      text: supportingKeyRationale,
    });
  }

  // ---- Precedence 5: balance due vs saturated muscle exposures ----
  // No days_ago cliff here: `saturated` is already the time-aware gate, and the
  // old `<= 1` re-imposed a flat one-day window on top of it — which is how a
  // group could read recovering to the plan-day picker (2 days) and fresh here
  // (1 day) on the very same morning.
  const saturated = dedupe([
    ...snapshot.muscle_load.filter((m) => m.saturated).map((m) => m.group),
    ...snapshot.program.volume_high_groups,
  ]);
  if (saturated.length) {
    fire(precedence, "muscle_saturated");
    soft.push({ code: "muscle_saturated", detail: `Recently saturated: ${saturated.join(", ")}` });
  }
  const due = dedupe([...snapshot.plan.due, ...snapshot.program.volume_low_groups]);
  if (due.length) {
    fire(precedence, "muscle_due");
    soft.push({
      code: "muscle_due",
      detail: strengthHighPriority
        ? `Due for strength/muscle work: ${due.join(", ")}`
        : `Due for work: ${due.join(", ")}`,
    });
  }
  // Strength/muscle high priorities: when recovery already allows train, bias
  // soft rationale toward due groups / template strength exposure (no invented work).
  // Soft narrative fires when due groups exist, or when intent is explicit so a
  // derived strength label does not narrate on every quiet template day.
  if (strengthHighPriority && kind === "train") {
    if (due.length) {
      fire(precedence, "training_intent");
      intentRationale.push({
        code: "muscle_due",
        text: "Strength and muscle sit high on your list — the due work fits that direction today.",
      });
    } else if (
      trainingIntent.source === "explicit" &&
      snapshot.plan_items.some((it) => String(it.kind ?? "").toLowerCase() !== "cardio")
    ) {
      fire(precedence, "training_intent");
      soft.push({
        code: "training_intent",
        detail: "Strength/muscle priority — template strength exposure preferred",
      });
      intentRationale.push({
        code: "training_intent",
        text: "Strength and muscle sit high on your list — today's session keeps that exposure in view.",
      });
    }
  }

  // ---- Muscle envelope ----
  const excluded = dedupe([...injuryGroups, ...jointGroups]);
  const injuredExercises = new Set(
    snapshot.constraints.injuries
      .filter((injury) => (injury.constraint_level ?? "protective") === "protective")
      .flatMap((injury) => injury.exercises)
      .map((exercise) => exercise.toLowerCase())
  );
  const recheckExercises = new Set(
    snapshot.constraints.injuries
      .filter((injury) => injury.constraint_level === "soft_recheck")
      .flatMap((injury) => injury.exercises)
      .map((exercise) => exercise.toLowerCase())
  );
  const reduced = dedupe([...enduranceReduced, ...saturated, ...snapshot.plan.over]).filter(
    (g) => !excluded.includes(g)
  );
  const required = dedupe(snapshot.plan_items.map((it) => it.muscle_group).filter((g): g is string => !!g)).filter(
    (g) => !excluded.includes(g)
  );
  const allowed = dedupe([...required, ...due]).filter((g) => !excluded.includes(g) && !reduced.includes(g));

  // ---- Precedence 6: progression only where recent performance supports it ----
  const progByExercise = new Map<
    string,
    {
      action: string;
      why: string;
      vary_to: string | null;
      current_target: DailyDecisionTarget | null;
      suggested_target: DailyDecisionTarget | null;
      top_set: DailyDecisionTopSet | null;
      evidence: DailyDecisionProgressionEvidence | null;
    }
  >();
  for (const p of snapshot.progression) {
    progByExercise.set(p.exercise.toLowerCase(), {
      action: p.action,
      why: p.why,
      vary_to: p.vary_to ?? null,
      current_target: p.current_target ?? null,
      suggested_target: p.suggested_target ?? null,
      // Normalized again here, not just at gather time: a snapshot can also arrive
      // hand-built or replayed off a stored row, and the ENVELOPE is the contract
      // every consumer reads. Whatever shape came in, what leaves is a heavy single
      // or nothing.
      top_set: topSetOf(p.top_set),
      evidence: p.evidence ?? null,
    });
  }

  // ---- Precedence 7: time / life fit ----
  const requestMinutes = snapshot.request.minutes;
  if (requestMinutes != null && requestMinutes > 0) {
    fire(precedence, "time_constrained");
    hard.push({ code: "time_constrained", detail: `About ${Math.round(requestMinutes)} minutes` });
  }

  // ---- Precedence 8: template rotation as the stable fallback ----
  const planIntent: "template" | "custom" =
    snapshot.plan.day_number != null && snapshot.plan_items.length ? "template" : "custom";
  const intent: "template" | "custom" = kind === "rest" ? "custom" : planIntent;
  if (intent === "template") {
    fire(precedence, "template_rotation");
    rationale.push({
      code: "template_rotation",
      text:
        snapshot.plan.reason ??
        `Day ${snapshot.plan.day_number}${snapshot.plan.focus ? ` · ${snapshot.plan.focus}` : ""}`,
    });
  }

  // ---- Caps ----
  const deloadPhase =
    snapshot.program.mesocycle_phase === "deload" || snapshot.program.mesocycle_phase === "recovery";
  // Longevity-leading soft ease under double-day pressure — never forces rest
  // when dayRead already says train; only prefers reduced volume / hold intensity.
  const doubleDayPressure =
    kind === "train" &&
    ((heavyEndurance.length > 0 && hardLowerOnPlan) ||
      keyRunProtect ||
      (enduranceReduced.length > 0 && hardLowerOnPlan) ||
      (hasRelevantOpenKeyRun && hardLowerOnPlan) ||
      consecutive >= 2);
  const longevityEase = longevityLeads && doubleDayPressure && kind === "train";
  if (longevityEase) {
    fire(precedence, "training_intent");
    soft.push({
      code: "training_intent",
      detail: "Longevity-leading intent — prefer a calmer double-day dose",
    });
    intentRationale.push({
      code: "training_intent",
      text: "Longevity leads your priorities — today's work stays a little easier rather than stacking hard on hard.",
    });
  }
  // A learned ease is the softest input in this list and behaves like it: it can
  // only ever join the others in preferring the reduced shape, and on a rest day —
  // where volume is already `minimal` — it has nothing to say and stays silent.
  const planComplexityEase = earnedSimplerDay(snapshot) && kind !== "rest";
  if (planComplexityEase) {
    fire(precedence, "personal_response_ease");
    soft.push({
      code: "personal_response_ease",
      detail: pickDayVariant(PLAN_COMPLEXITY_EASE_DETAILS, snapshot.date, "plan_complexity_ease"),
    });
  }
  const trainAnywayFromRest = trainAnyway && baseKind === "rest";
  const trainAnywayLiftsQuiet = trainAnyway && (baseKind === "rest" || baseKind === "easy");
  const trainAnywayKeepsReduced = trainAnywayFromRest && !capsMayOpen;
  const softenVolume =
    kind === "easy" ||
    readiness === "low" ||
    sorenessSoftensDay ||
    trainAnywayKeepsReduced ||
    snapshot.day_read.recovery_week ||
    longevityEase ||
    planComplexityEase;
  const volume: DailyDecisionEnvelope["caps"]["volume"] =
    kind === "rest" ? "minimal" : softenVolume ? "reduced" : "normal";
  const intensity: DailyDecisionEnvelope["caps"]["intensity"] =
    kind === "rest" || kind === "easy"
      ? "easy"
      : deloadPhase || repeatedUnder
        ? "deload"
        : trainAnywayFromRest || readiness === "low" || sorenessSoftensDay || lowPerformance || longevityEase
          ? "hold"
          : "normal";
  let duration: number | null;
  if (trainAnywayLiftsQuiet) {
    // When train-anyway lifts a rest/easy read, duration comes from the plan
    // day's own estimate (or the ordinary train-day default) — never from the
    // quiet read's 20-minute clock. Capped at 40 only when a brake is present.
    const lifted = requestMinutes ?? planDayDurationEstimate(snapshot) ?? TRAIN_DAY_DEFAULT_MINUTES;
    duration = Math.round(capsMayOpen ? lifted : Math.min(lifted, 40));
  } else {
    duration = requestMinutes ?? snapshot.day_read.est_minutes ?? null;
    if (duration != null) {
      if (kind === "rest") duration = Math.min(duration, 20);
      else if (kind === "easy") duration = Math.min(duration, 40);
      duration = Math.round(duration);
    }
  }
  if (durationOverrideOnly && duration != null) duration = Math.min(duration, 35);

  // ---- Candidates (template intent only; custom leaves composition to Stage 3) ----
  const candidates: DailyDecisionCandidate[] = [];
  if (intent === "template" && kind !== "rest") {
    for (const it of snapshot.plan_items) {
      const group = it.muscle_group ? it.muscle_group.toLowerCase() : null;
      const isCardio = String(it.kind ?? "").toLowerCase() === "cardio";
      const cardioProtectiveRelevance = isCardio
        ? cardioPainRelevance(
            it.exercise,
            protectiveExclusions.flatMap((exclusion) => exclusion.areas)
          )
        : false;
      const cardioJointPainRelevance =
        isCardio && snapshot.feedback?.joint_pain
          ? cardioPainRelevance(it.exercise, [snapshot.feedback.joint_pain])
          : false;
      if (
        injuredExercises.has(it.exercise.toLowerCase()) ||
        (group && excluded.includes(group)) ||
        (isCardio && protectiveExclusions.length > 0 && cardioProtectiveRelevance !== false) ||
        cardioJointPainRelevance === true
      ) {
        candidates.push({
          exercise: it.exercise,
          muscle_group: it.muscle_group,
          action: "exclude",
          reason_code:
            injuredExercises.has(it.exercise.toLowerCase()) ||
            (group != null && injuryGroups.includes(group)) ||
            (isCardio && protectiveExclusions.length > 0 && cardioProtectiveRelevance !== false)
              ? "injury_exclusion"
              : "joint_pain_reduce",
          substitution_for: null,
          note: "Swap for a pattern that spares the flagged area",
          current_target: null,
          authorized_target: null,
          progression_evidence: null,
        });
        continue;
      }
      const prog = progByExercise.get(it.exercise.toLowerCase());
      let action: DailyDecisionCandidate["action"] = "carry";
      let reason: DailyDecisionReason | null = null;
      if (prog && PROGRESSION_REASON[prog.action]) {
        action = prog.action as DailyDecisionCandidate["action"];
        reason = PROGRESSION_REASON[prog.action];
      }
      if (recheckExercises.has(it.exercise.toLowerCase())) {
        action = "hold";
        reason = "injury_recheck";
      }
      // A saturated/reduced group holds load rather than advancing today.
      if (group && reduced.includes(group) && (action === "overload" || action === "carry")) {
        action = "hold";
        reason = saturated.includes(group) ? "muscle_saturated" : "endurance_lower_conflict";
      }
      if (lowPerformance && !repeatedUnder && (action === "overload" || action === "carry")) {
        action = "hold";
        reason = "recent_underperformance";
      }
      if (intensity === "deload" && (action === "overload" || action === "carry")) {
        action = "deload";
        reason = reason ?? "progression_deload";
      }
      const substitution =
        prog?.vary_to && (action === "vary" || action === "introduce") ? prog.vary_to : null;
      candidates.push({
        exercise: substitution ?? it.exercise,
        muscle_group: it.muscle_group,
        action,
        reason_code: reason,
        substitution_for: substitution ? it.exercise : null,
        note: prog?.why ?? null,
        current_target: prog?.current_target ?? null,
        authorized_target:
          !substitution && prog
            ? action === prog.action
              ? prog.suggested_target
              : action === "hold"
                ? prog.current_target
                : null
            : null,
        // The peak protocol rides ONLY with its own authorized back-off block.
        // Every branch above that hands back something other than
        // `prog.suggested_target` — a recheck, a saturated group, an underperforming
        // week, a deload day — has stepped the day back on purpose, and a
        // near-maximal single is the last thing that should survive that.
        ...(!substitution && prog && action === prog.action && prog.top_set ? { top_set: prog.top_set } : {}),
        progression_evidence: prog?.evidence ?? null,
        brain_decision_id: it.brain_decision_id ?? null,
        brain_change_summary: it.brain_change_summary ?? null,
        brain_change_reason: it.brain_change_reason ?? null,
        brain_change_reason_provenance: it.brain_change_reason_provenance ?? null,
        brain_change_reversible: it.brain_change_reversible ?? null,
      });
      if (recheckExercises.has(it.exercise.toLowerCase())) {
        candidates[candidates.length - 1]!.note = "Recheck the affected movement before loading";
      }
    }
  }

  const equipmentCapability = parseEquipmentCapability(snapshot.request.equipment);
  if (equipmentCapability.recognized && equipmentCapability.restricted) {
    for (const candidate of candidates) {
      const stored = findExercise(candidate.exercise);
      const compatibility = equipmentCompatibility(
        equipmentCapability,
        inferExerciseEquipment(candidate.exercise, stored?.equipment)
      );
      if (compatibility !== "compatible") {
        candidate.action = "exclude";
        candidate.reason_code = "equipment_limited";
        candidate.note = "Unavailable with today's equipment";
      }
    }
  }

  // ---- Reach (up direction, beside the safety ladder) ----
  // Reason codes fire here; the athlete-facing line trails the kind/template
  // headline so primary_rationale stays the day's read, same as intent bias.
  const { reach, trimmed: reachTrimmed } = resolveReach(snapshot, kind, saturated);
  if (reach.level === "push") {
    const reachCode: DailyDecisionReason = reachTrimmed ? "reach_trimmed_by_fueling" : "backed_day_reach";
    fire(precedence, reachCode);
    soft.push({ code: reachCode, detail: reach.why });
  }

  // ---- Render-safe rationale ----
  rationale.push({
    code:
      kind === "rest"
        ? snapshot.constraints.illness
          ? "illness_window"
          : "low_recovery_rest"
        : kind === "easy"
          ? "low_recovery_easy"
          : "template_rotation",
    text:
      kind === "rest"
        ? "Today reads as a rest day — recovery earns tomorrow's work."
        : kind === "easy"
          ? "Today reads as an easy day — keep it light and short."
          : `Today reads as a training day${snapshot.plan.focus ? ` · ${snapshot.plan.focus}` : ""}.`,
  });
  // Soft intent lines trail the kind/template headline so primary_rationale stays calm.
  for (const line of intentRationale) rationale.push(line);
  if (reach.level === "push") {
    rationale.push({
      code: reachTrimmed ? "reach_trimmed_by_fueling" : "backed_day_reach",
      text: reach.why,
    });
  }

  return {
    policy_version: DAILY_DECISION_POLICY_VERSION,
    input_fingerprint: fingerprint,
    generated_at: opts.now ?? new Date().toISOString(),
    date: snapshot.date,
    kind,
    baseline_kind: baseKind,
    request: { ...snapshot.request, train_anyway: trainAnyway },
    template: {
      day_number: kind === "rest" ? null : snapshot.plan.day_number,
      plan_day_id: kind === "rest" ? null : snapshot.plan.plan_day_id,
      focus: kind === "rest" ? "Recovery" : snapshot.plan.focus,
      intent,
    },
    muscles: { required, allowed, reduced, excluded, saturated },
    caps: { volume, intensity, duration_min: duration },
    recovery_cycle: snapshot.recovery_cycle,
    candidates,
    hard_constraints: hard,
    soft_preferences: soft,
    rationale,
    precedence,
    training_intent: trainingIntent,
    protective_exclusions: protectiveExclusions,
    reported_joint_pain: snapshot.feedback?.joint_pain ?? null,
    reach,
  };
}

// Convenience: gather + decide in one call for the surfaces. Pure-per-DB-state:
// two calls against the same database and date return equivalent envelopes (bar
// `generated_at`).
export function decideDailySession(
  date?: string,
  opts: {
    override?: string | null;
    train_anyway?: boolean;
    equipment?: string | null;
    minutes?: number | null;
    goal?: string | null;
  } = {},
  buildOpts: { now?: string } = {}
): { envelope: DailyDecisionEnvelope; snapshot: DailyDecisionSnapshot } {
  const snapshot = gatherDailyDecisionSnapshot(date, opts);
  return { envelope: buildDailySessionDecision(snapshot, buildOpts), snapshot };
}

// Persist the decision envelope (docs §4: "Stage 2 preparation persists enough
// decision metadata to explain why it was chosen"). Idempotent by fingerprint:
// re-recording the same decision for a date is a no-op, so a repeated prepare or
// diagnostic read never floods the table. Best-effort at the call site — a write
// failure must never break a prepare. Only render-safe envelope facts are stored.
export function recordDailySessionDecision(
  envelope: DailyDecisionEnvelope,
  opts: { composition_id?: number | null } = {}
): void {
  const existing = db
    .prepare(`SELECT id FROM daily_session_decisions WHERE date = ? AND input_fingerprint = ? LIMIT 1`)
    .get(envelope.date, envelope.input_fingerprint) as any;
  if (existing?.id) {
    if (opts.composition_id != null) {
      db.prepare(`UPDATE daily_session_decisions SET composition_id = ? WHERE id = ?`).run(
        Number(opts.composition_id),
        existing.id
      );
    }
    return;
  }
  db.prepare(
    `INSERT INTO daily_session_decisions (date, composition_id, policy_version, input_fingerprint, kind, envelope_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    envelope.date,
    opts.composition_id != null ? Number(opts.composition_id) : null,
    envelope.policy_version,
    envelope.input_fingerprint,
    envelope.kind,
    JSON.stringify(envelope)
  );
}

export function getLatestDailySessionDecision(date?: string): DailyDecisionEnvelope | null {
  const d = String(date || localDateISO()).slice(0, 10);
  const row = db
    .prepare(
      `SELECT envelope_json
         FROM daily_session_decisions
        WHERE date = ? AND policy_version = ?
        ORDER BY id DESC LIMIT 1`
    )
    .get(d, DAILY_DECISION_POLICY_VERSION) as any;
  if (!row?.envelope_json) return null;
  try {
    return JSON.parse(row.envelope_json) as DailyDecisionEnvelope;
  } catch {
    return null;
  }
}
