// Day intelligence — the Brief's deterministic core: dayRead() (the calm train/
// easy/rest/done read), the forward look + week-ahead floor, the persisted
// day-read cache, and the effortless-capture frequents list. The agentic sentence
// layer wraps this in src/dayread.ts; this is the floor + the structured truth.
//
// Split out of the former intelligence.ts monolith (K4). Plan-day selection lives
// in plan-selection.ts; adaptive nutrition in expenditure.ts.
import { createHash } from "node:crypto";
import { db } from "../db.js";
import { brainSignal } from "../brain/snapshot.js";
import {
  pickDayVariant,
  resolveDayReadRule,
  UNPROGRAMMED_EASY_DAY,
  type DayReadRule,
  type DayReadRuleOutcome,
} from "./brain/day-read-rules.js";
import {
  type EasyOutcomeFeedbackSignal,
  easyOverrideSoftening,
  type EasyOverrideSoftening,
  type FreshStatementField,
  LEARNED_TRAIN_WINDOW_DAYS,
  learnedQuietStep,
  OUTCOME_SOFTENING_WINDOW_DAYS,
  type OutcomeFeedbackSignal,
  readAdherenceModel,
  restOverrideSoftening,
  type RestOverrideSoftening,
  trainsAnywayWithoutHarm,
  withMorningReadiness,
} from "./brain/read-adherence.js";
import { getCheckinByDate, getRecoverySummary, latestSleep, trainingSignals } from "./coach.js";
import { RECOVERY_SAMPLE_FLOOR, recoveryTrendBars } from "./recovery-trend.js";
import { activeContextEffect, contextEventIsRestTrade, REST_TRADE_META_KEY } from "./context-effect.js";
import { listActiveDirectives } from "./directives-read.js";
import { RUN_SPORT_PATTERNS } from "./endurance-sports.js";
import { estimateExpenditure } from "./expenditure.js";
import { flexibleTrainingAgenda } from "./flexible-training-agenda.js";
import type { RunDayIntensity } from "./run-day-intensity.js";
import { runDaySteerKey } from "./run-day-steer.js";
import { planningContextEvents } from "./health.js";
import { plainGroupWords } from "./exercise-canon.js";
import { acuteGates, suppressSaturatedDue } from "./hybrid-load.js";
import {
  LAST_NIGHT_MAX_AGE_DAYS,
  SENSOR_MAX_AGE_DAYS,
  isLastNight,
  isReadDayReadiness,
  sensorIsCurrent,
} from "./sensor-freshness.js";
import { getRecentSessions } from "./sessions.js";
import { getSettings } from "./settings.js";
import { getPlan } from "./plan.js";
import { planItemsOutOfOrder } from "../domain/training/plan-item-order.js";
import { getActiveBlock } from "./program-blocks.js";
import { activeRecoveryWeekLedger, RECOVERY_WEEK_ACTIVE_DAYS } from "./recovery-week-ledger.js";
import {
  nextCandidateAfter,
  planDayCandidates,
  planDayFocus,
  planDayLabel,
  resolveSessionPlanDay,
  selectAdaptivePlanDay,
  calendarDayRead,
} from "./plan-selection.js";
import { liftDows } from "./strength-schedule.js";
import { getEnduranceGoal, getEnduranceSchedule, getPrimaryDiscipline, WEEKDAY_NAMES } from "./profile.js";
import { RUN_KIND_LABELS } from "./run-edit.js";
import { activeRecoveryWeek } from "./recovery-week.js";
import { getProgramState, runVolumeSpikeRead, type MesocycleState } from "./program-state.js";
import { runIntensityDiscipline } from "./run-progression.js";
import { programBalance } from "./progression.js";
import { addDaysISO, daysBetweenISO, localDateISO, nowContext } from "./shared.js";
import { coachContextBackstopSignature, registerTrainingCacheClear } from "./training-cache.js";
import { getTrainingIntent, isStrengthLedIntent } from "./training-intent.js";
import { listTrainingSymptoms } from "./training-symptoms.js";
import {
  dimensionIsAdviceOnly,
  hasFreshBrake,
  hasFreshDecidingBrake,
  freshDecidingBrakeFields,
  lifeCapacityIsCommitment,
  planningSignalState,
  signalVoice,
  spokenSignalVoice,
  thinSignalCoverage,
  SIGNAL_VOICE_KEYS,
  todayHolds,
  tomorrowHolds,
  type SignalDimension,
  type TodayHold,
  type TomorrowHold,
  type UnifiedSignalState,
} from "./signal-state.js";
import {
  dominantSensorCadenceEntry,
  isWorkingEpisodicPattern,
  wearAbsenceRowState,
  wearAbsenceView,
  wearAbsenceWhy,
} from "./wear-pattern-voice.js";
import {
  type LongestRunNovelty,
  type TrainingLoad,
  dayLoad,
  hardCardioDay,
  hybridDayContext,
  longestRunNovelty,
  planDayIsCardioOnly,
  planDayStrengthGroups,
  recentCardioLoadMedian,
  recoverySessionDose,
} from "./training-read.js";
import { readsLowReadiness, readsRestGradeReadiness, SUPPORTIVE_READINESS } from "./readiness-bands.js";
import { withFlexibleRunLookahead } from "./hybrid-run-lookahead.js";
import { dayFuelState } from "./fuel-state.js";
import { currentUnderfuelingRead } from "./underfueling-snapshot.js";
import { tripCoversDay, type UnderfuelingRead } from "./underfueling.js";
// The split-out halves of this module, re-exported so every existing importer of
// "./day-read.js" (and of the repo barrel through intelligence.ts) keeps working:
//   day-read-grammar.ts  the reading grammar predicate
//   day-read-prose.ts    the athlete-facing variant sets + the prose identity
// The engine below imports the words it speaks; neither half imports the engine.
export * from "./day-read-grammar.js";
export * from "./day-read-prose.js";
import {
  ACUTE_SLEEP_WHY,
  ANTICIPATE_DELOAD_CAVEAT,
  CHRONIC_SLEEP_WHY,
  COMMITMENT_PRESSURE_CAVEAT,
  DAY_CLAIMED_WHY,
  DAY_READ_OUTCOMES,
  DAY_TRADED_WHY,
  DONE_WHY,
  DOSE_OVERRUN_WHY,
  EASE_AROUND_CAVEAT,
  FUEL_AROUND_TRAINING_CAVEAT,
  HOLD_AGGRESSION_CAVEAT,
  INJURY_CAVEAT,
  JOINT_PAIN_CAVEAT,
  LAB_DRAW_WHY,
  LEARNED_TRAIN_WHY,
  LIFE_PRESSURE_CAVEAT,
  LIGHT_WORK_WHY,
  LOOKAHEAD_RETIME_WHY,
  LOW_READINESS_WHY,
  LOW_SLEEP_CAVEAT,
  NOTHING_MOVED_CLAUSES,
  OUTCOME_FEEDBACK_HELD_SYMPTOM_WHY,
  OUTCOME_FEEDBACK_HELD_WHY,
  OUTCOME_FEEDBACK_OPEN_WHY,
  OUTCOME_FEEDBACK_SOFTEN_WHY,
  PUSH_DRIVE_WHY,
  QUIET_STREAK_GUARDED_WHY,
  QUIET_STREAK_WHY,
  RECOVERY_WEEK_CAVEAT,
  REST_GRADE_READINESS_WHY,
  RUN_DOWN_WHY,
  SLEEP_EXPOSURE_CAVEAT,
  STACKED_DAYS_CAVEAT,
  STACKED_LOAD_CEILING_WHY,
  STACKED_LOAD_WHY,
  STATED_RUN_DAY_WHY,
  TEMPLATE_REST_DAY_WHY,
  TRAIN_CAVEAT_LEAD,
  TRAIN_CLEAR_WHY,
  TRAIN_HOLD_LEAD,
  TRAIN_NOTED_LEAD,
  TRAIN_PUSH_CAVEAT_LEAD,
  TRAIN_PUSH_WHY,
  UNPROGRAMMED_WHY,
  VOLUME_SPIKE_CAVEAT,
  VOLUME_SPIKE_WHY,
  earnPathClause,
  quietOrdinal,
  weekAheadDayNote,
} from "./day-read-prose.js";

// ---------- T1: day intelligence ----------
export interface DayRead {
  kind: "train" | "easy" | "rest" | "done"; // 'done' = a real, loading session is already logged today
  focus: string | null; // e.g. "Lower body" on a train day
  why: string; // one plain-language sentence
  est_minutes: number | null;
  signals: Record<string, any>; // the deterministic inputs behind the call
  decision?: DayReadDecision;
  input_fingerprint?: string;
  computed_at?: string;
}

export interface DayReadDecisionEvidence {
  label: string;
  value: string;
  date?: string;
}

export interface DayReadDecision {
  rule_code: string;
  basis: "deterministic" | "agent" | "server_policy";
  baseline_kind: DayRead["kind"];
  reason: string;
  evidence: DayReadDecisionEvidence[];
  computed_at: string;
}


// ---------- THE REST TRADE ----------
// One key, written by the trade use case (src/domain/brain/rest-trade.ts) onto the
// `claims_day` context event it inserts for tomorrow, and read back here on the day
// it names. It LIVES in `context-effect.ts` beside the illness and lab-draw probes,
// because the signal state needs the same answer to keep the trade's own row out of
// its schedule-pressure filter — one key, one predicate, three readers. Re-exported
// here so the callers that already import it from this module keep working.
// The CALENDAR carries a trade — nothing about the plan's rotation moves.
export { REST_TRADE_META_KEY };

/** Was the event behind this hold the athlete's own traded rest day? */
function eventIsRestTrade(contextEvents: unknown, holdId: number | null): boolean {
  if (holdId == null || !Array.isArray(contextEvents)) return false;
  const event = (contextEvents as any[]).find((row) => row && Number(row.id) === Number(holdId));
  return contextEventIsRestTrade(event);
}


// ---------- cross-day memory (what we already told them) ----------
// Nothing in the Brief used to read YESTERDAY's Brief. Any input that is stable
// day over day — a chronic short sleeper, a persistently low readiness baseline,
// a multi-week injury — therefore fired the same rule, printed the same sentence,
// and did so indefinitely: taking the suggested rest never changes the input, so
// the read never changes. "Rest after rest after rest", verbatim.
//
// The day_reads cache already keeps a rolling three weeks of what was actually
// SAID; these read it back so both layers can use it — the deterministic floor to
// vary its own words and escalate a long quiet stretch, and the agentic layer to
// know what it told the athlete yesterday.
export interface PriorDayRead {
  date: string;
  kind: string;
  rule_code: string | null;
  headline: string | null;
  why: string | null;
  source: string | null;
}

// The most recent cached reads STRICTLY BEFORE `date`, newest first. Never throws.
export function recentDayReads(date: string, limit = 3): PriorDayRead[] {
  const want = Math.max(1, Math.min(14, Math.trunc(Number(limit) || 3)));
  try {
    const rows = db
      .prepare(
        `SELECT date, kind, headline, why, source, signals FROM day_reads
          WHERE date < ? ORDER BY date DESC LIMIT ?`
      )
      .all(date, want) as any[];
    return rows.map((row) => {
      let ruleCode: string | null = null;
      try {
        const meta = row.signals ? JSON.parse(row.signals)?._day_read_meta : null;
        const code = meta?.decision?.rule_code;
        ruleCode = typeof code === "string" && code ? code : null;
      } catch {
        ruleCode = null;
      }
      return {
        date: String(row.date),
        kind: String(row.kind ?? ""),
        rule_code: ruleCode,
        headline: row.headline ?? null,
        why: row.why ?? null,
        source: row.source ?? null,
      };
    });
  } catch {
    return [];
  }
}

export interface DayReadContinuity {
  // Consecutive CALENDAR days immediately before `date` whose read was easy/rest.
  // A missing day breaks the run: an unknown day is not a quiet day.
  quiet_streak: number;
  // Yesterday's read, when there is one (the day immediately before `date`).
  yesterday: { kind: string; rule_code: string | null; why: string | null } | null;
  // Filled in once the rule resolves: yesterday reached the same conclusion by the
  // same route, so today genuinely has nothing new to report.
  repeat_of_yesterday: boolean;
}

const QUIET_KINDS = new Set(["easy", "rest"]);

// A quiet day inside a trip window was the trip's quiet day, not Cairn's. The
// escalation voice ("this makes the third quiet day — if the rest still feels right,
// take it") exists so a read that keeps counselling rest stops re-arguing itself; on
// the first morning home from three days away it told a rested athlete to keep
// resting, counting days the calendar had already claimed. A trip day breaks the
// streak the way an unknown day does. `tripCoversDay` is the fuel read's own window
// predicate, so the two surfaces cannot disagree about what a trip covered.
export function dayReadContinuity(date: string, priorReads?: PriorDayRead[]): DayReadContinuity {
  const prior = priorReads ?? recentDayReads(date, 7);
  const dayBefore = (iso: string, back: number) =>
    new Date(new Date(`${iso}T00:00:00Z`).getTime() - back * 864e5).toISOString().slice(0, 10);
  let quiet = 0;
  for (let back = 1; back <= prior.length; back++) {
    const iso = dayBefore(date, back);
    const row = prior.find((r) => r.date === iso);
    if (!row || !QUIET_KINDS.has(row.kind) || tripCoversDay(iso)) break;
    quiet++;
  }
  const yesterdayRow = prior.find((r) => r.date === dayBefore(date, 1)) ?? null;
  return {
    quiet_streak: quiet,
    yesterday: yesterdayRow
      ? { kind: yesterdayRow.kind, rule_code: yesterdayRow.rule_code, why: yesterdayRow.why }
      : null,
    repeat_of_yesterday: false,
  };
}

// Voice the read against what was already said. Only the WORDS change here — the
// kind, focus and duration are the safety posture and stay exactly as the rules
// decided them.
function applyContinuityVoice(
  date: string,
  outcome: DayReadRuleOutcome,
  read: Omit<DayRead, "decision" | "input_fingerprint" | "computed_at">,
  continuity: DayReadContinuity
): Omit<DayRead, "decision" | "input_fingerprint" | "computed_at"> {
  if (!QUIET_KINDS.has(read.kind)) return read;
  // A day they have ALREADY moved on is not a day to talk about the stretch of quiet
  // days — the read is about the thing they just did, and "here's the smallest thing
  // worth doing" would ignore it.
  const signals = read.signals as any;
  const movedToday =
    signals?.trained_today === true ||
    Number(signals?.logged_today?.sets ?? 0) > 0 ||
    (Array.isArray(signals?.logged_today?.activities) && signals.logged_today.activities.length > 0);
  if (movedToday) return read;
  if (continuity.quiet_streak >= 2) {
    // A movement work-around (any fresh health constraint — an injury, an illness, a
    // painful joint) is safety guidance that lives only in the `why` — keep it and let
    // the escalation follow, rather than replacing it. And
    // the escalation that follows it must not undo it: the general set offers the
    // smallest thing worth doing as time on your feet, which is precisely what the
    // caveat just warned against. The guarded set says the same thing without naming
    // a weight-bearing option, so the read closes without contradicting itself.
    const guarded = !!signals?.health_workaround;
    const escalation = pickDayVariant(
      guarded ? QUIET_STREAK_GUARDED_WHY : QUIET_STREAK_WHY,
      date,
      `${outcome.code}:quiet-streak`
    )(quietOrdinal(continuity.quiet_streak + 1));
    return { ...read, why: guarded ? `${read.why} ${escalation}` : escalation };
  }
  if (continuity.repeat_of_yesterday) {
    const clause = pickDayVariant(NOTHING_MOVED_CLAUSES, date, `${outcome.code}:unchanged`);
    return { ...read, why: `${read.why} ${clause}` };
  }
  return read;
}

// ---------- periodization context (shared by the Brief response AND the prompt) ----------
// Where today sits in the program: the active block's week counter and, when a
// recovery overlay is running, which day of it this is. The agentic layer needs
// this to stop proposing rest as though it were novel on day 3 of 7 of a deload.
export interface DayReadPeriodizationContext {
  program_block: {
    goal: string;
    focus: string;
    stored_phase: string;
    effective_phase: string;
    week_index: number;
    total_weeks: number;
    started_at: string;
    counter_basis: "calendar_program_block";
  } | null;
  recovery_overlay: {
    applied_on: string;
    until: string;
    day_index: number;
    total_days: 7;
    proposal_id: number | null;
    cycle_id?: number;
    label: "reduced volume";
  } | null;
}

export function dayReadPeriodizationContext(date: string): DayReadPeriodizationContext {
  try {
    const block = getActiveBlock();
    // The same new-record-first, legacy-fallback authority used by dayRead() and
    // the daily-session decision. The legacy ledger is consulted only to retain
    // its proposal identifier in the compatibility payload.
    const recovery = activeRecoveryWeek(date);
    const legacy = recovery && recovery.cycle_id == null ? activeRecoveryWeekLedger(date) : null;
    const dayOffset = recovery ? daysBetweenISO(date, recovery.applied_on) : null;
    return {
      program_block: block
        ? {
            goal: String(block.goal).slice(0, 200),
            focus: block.focus,
            stored_phase: block.phase,
            effective_phase: recovery ? "deload" : block.phase,
            week_index: block.week_index,
            total_weeks: block.total_weeks,
            started_at: String(block.started_at).slice(0, 32),
            counter_basis: "calendar_program_block",
          }
        : null,
      recovery_overlay:
        recovery && dayOffset != null
          ? {
              applied_on: recovery.applied_on,
              until: recovery.until,
              day_index: Math.min(RECOVERY_WEEK_ACTIVE_DAYS, Math.max(1, dayOffset + 1)),
              total_days: RECOVERY_WEEK_ACTIVE_DAYS,
              proposal_id: legacy?.proposal_id ?? null,
              ...(recovery.cycle_id != null ? { cycle_id: recovery.cycle_id } : {}),
              label: "reduced volume",
            }
          : null,
    };
  } catch {
    return { program_block: null, recovery_overlay: null };
  }
}

// Minutes read as a metric wall the moment anything renders them (VISION.md
// Amendment 2). Sleep evidence therefore speaks in hours and minutes the way a
// person says them, never a raw "412 min".
function humanDuration(totalMinutes: unknown): string | null {
  const minutes = Math.round(Number(totalMinutes));
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// Evidence summaries are written as labels, not prose, so they may arrive with no end
// stop. Anything spliced into a `why` needs one, or the sentence after it runs on.
function endStopped(text: string): string {
  const trimmed = String(text ?? "").trim();
  return !trimmed || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function boundedEvidence(signals: Record<string, any>, date: string): DayReadDecisionEvidence[] {
  const evidence: DayReadDecisionEvidence[] = [];
  const push = (label: string, value: unknown, when?: unknown) => {
    if (value == null || evidence.length >= 5) return;
    const text = String(value).replace(/\s+/g, " ").trim().slice(0, 120);
    if (!text) return;
    const item: DayReadDecisionEvidence = { label: label.slice(0, 48), value: text };
    if (typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when)) item.date = when;
    evidence.push(item);
  };
  const yesterday = Array.isArray(signals.recent_load) ? signals.recent_load[0] : null;
  push("Yesterday's load", yesterday?.load, yesterday?.date);
  if (signals.recovery_week?.state === "applied") {
    push(
      "Recovery overlay",
      "reduced volume",
      typeof signals.recovery_week.applied_on === "string" ? signals.recovery_week.applied_on : date
    );
  }
  if (signals.last_night?.total_min != null) {
    push("Last night's sleep", humanDuration(signals.last_night.total_min), signals.last_night.date);
  } else if (signals.avg_sleep_min != null) {
    const rolling = humanDuration(signals.avg_sleep_min);
    push("Rolling sleep", rolling ? `${rolling} a night on average` : null);
  }
  if (signals.checkin) push("Morning check-in", "athlete-reported recovery", date);
  const readiness = signals.fatigue?.readiness;
  if (readiness?.current_date) push("Readiness", readiness.freshness ?? "current", readiness.current_date);
  if (signals.context?.active?.[0]?.title) push("Life context", signals.context.active[0].title, date);
  if (signals.plan_selection?.reason) push("Plan selection", signals.plan_selection.reason, date);
  return evidence;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.startsWith("_"))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stableValue(child)])
  );
}

export interface DayReadFingerprintContext {
  program_block: {
    goal: unknown;
    focus: unknown;
    phase: unknown;
    week_index: unknown;
    total_weeks: unknown;
    started_at: unknown;
  } | null;
  flexible_training_agenda?: {
    available: boolean;
    intents: Array<{
      kind: "easy" | "quality" | "long" | null;
      status: "open" | "completed" | null;
      suggested_date: string | null;
      window_start: string | null;
      window_end: string | null;
      target_distance_km: number | null;
      target_duration_min: number | null;
      target_zone: string | null;
      // A completed intent's duration/distance are the SAME provider telemetry
      // `logged_today` carries, so they are stored BANDED here (see
      // fingerprintDurationBucket / fingerprintDistanceBucket) rather than raw —
      // otherwise a re-sync nudging 8.02 → 8.03 km moved the hash through the
      // agenda after it had been banded out of `logged_today`. Banding is
      // idempotent, which matters: this shape is compacted twice (once into the
      // context, once inside dayReadInputFingerprint).
      completion: {
        date: string | null;
        duration_min: number | null;
        distance_km: number | null;
        intensity: "easy" | "quality" | null;
      } | null;
    }>;
  } | null;
}

function fingerprintNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Effort telemetry, BANDED. A provider re-sync rewrites the same effort with a
// slightly different number many times a day (8.02 → 8.03 km, 44 → 45 min), and a
// raw hash turned each rewrite into "the decision moved" — discarding a warm
// agentic read for an effort the athlete already did. Nothing branches on the
// exact number; only on roughly how big the effort was. So it is hashed in bands:
// ~5-minute buckets and ~0.5 km buckets. A genuinely different effort still lands
// in a different band; the same one re-synced does not.
function fingerprintDurationBucket(value: unknown): number | null {
  const minutes = fingerprintNumber(value);
  return minutes == null ? null : Math.round(minutes / 5) * 5;
}

function fingerprintDistanceBucket(value: unknown): number | null {
  const km = fingerprintNumber(value);
  return km == null ? null : Math.round(km * 2) / 2;
}

// `logged_today` is `{ sets: <count>, activities: [{type, duration_min, distance_km}] }`,
// and it is rewritten by EVERY logged set and every watch re-sync. The raw set
// count was the single biggest churn source in this hash: on a `done` day — whose
// decision enforceCompletionContract has already made terminal — set 12 → 13 → 14
// moved the fingerprint and cost the athlete a fresh agent run per set.
//
// That granularity is not a decision. The volume those sets represent already
// reaches this hash GRADED, as `today_load` (dayLoad ranks the day none/easy/
// moderate/hard, so a session crossing into real load still moves it) and as
// `trained_today`. What only `logged_today` can add is WHETHER any set exists at
// all and WHICH efforts are on the board — so the evening run appearing still
// retires the morning read, while another set of the lift already in progress does
// not. The activity list is sorted (its source query orders by id, which is not a
// decision) but never deduplicated: a second effort of the same shape is a second
// effort.
function compactLoggedTodayFingerprint(value: unknown): {
  any_sets: boolean;
  activities: Array<{ type: string | null; duration_bucket: number | null; distance_bucket: number | null }>;
} | null {
  if (!value || typeof value !== "object") return null;
  const logged = value as Record<string, any>;
  const activities = (Array.isArray(logged.activities) ? logged.activities : [])
    .map((activity: any) => ({
      type: typeof activity?.type === "string" ? activity.type.trim() || null : null,
      duration_bucket: fingerprintDurationBucket(activity?.duration_min),
      distance_bucket: fingerprintDistanceBucket(activity?.distance_km),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { any_sets: (fingerprintNumber(logged.sets) ?? 0) > 0, activities };
}

// `recent_load` is the last five days' graded load, each day optionally carrying
// the FULL recovery-dose read for every session on it — per-set ids, weights, reps,
// RIR, a float volume ratio and a prose reason. Exactly two things in there can move
// TODAY's decision: each day's grade (the consecutive-loading-days rule) and whether
// YESTERDAY's recovery session was an overdose (the recovery_dose_overrun rule).
// Hashing the rest meant a late correction to one set three days ago, or a re-derived
// ratio, retired today's read.
function compactRecentLoadFingerprint(
  value: unknown
): Array<{ date: string | null; load: string | null; dose_overrun: boolean }> | null {
  if (!Array.isArray(value)) return null;
  return value.map((day: any) => ({
    date: typeof day?.date === "string" ? day.date : null,
    load: typeof day?.load === "string" ? day.load : null,
    dose_overrun: (Array.isArray(day?.recovery_dose) ? day.recovery_dose : []).some(
      (dose: any) => dose?.classification === "overdose"
    ),
  }));
}

function compactTodayHoldsFingerprint(
  value: unknown
): Array<{ kind: string | null; claims_day: boolean; lab_draw: boolean }> | null {
  if (!Array.isArray(value) || !value.length) return null;
  return value
    .map((hold: any) => ({
      kind: typeof hold?.kind === "string" ? hold.kind : null,
      claims_day: !!hold?.claims_day,
      lab_draw: !!hold?.lab_draw,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function compactTomorrowHoldsFingerprint(
  value: unknown
): Array<{ kind: string | null; blocks_training: boolean }> | null {
  if (!Array.isArray(value) || !value.length) return null;
  return value
    .map((hold: any) => ({
      kind: typeof hold?.kind === "string" ? hold.kind : null,
      blocks_training: !!hold?.blocks_training,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function compactHealthWorkaroundFingerprint(value: unknown): { field: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as { field?: unknown }).field;
  return { field: typeof field === "string" ? field : null };
}

function compactOutcomeAppliedFingerprint(value: unknown): boolean | null {
  if (!value || typeof value !== "object") return null;
  return !!(value as { applied?: unknown }).applied;
}

function compactFlexibleAgendaFingerprint(
  value: unknown
): NonNullable<DayReadFingerprintContext["flexible_training_agenda"]> | null {
  if (!value || typeof value !== "object") return null;
  const agenda = value as Record<string, any>;
  const available = agenda.available === true;
  const intents = (Array.isArray(agenda.intents) ? agenda.intents : [])
    .map((intent: any) => {
      const kind =
        intent?.kind === "easy" || intent?.kind === "quality" || intent?.kind === "long" ? intent.kind : null;
      const status = intent?.status === "open" || intent?.status === "completed" ? intent.status : null;
      const completion =
        status === "completed" && intent?.completion && typeof intent.completion === "object"
          ? {
              date: typeof intent.completion.date === "string" ? intent.completion.date : null,
              duration_min: fingerprintDurationBucket(intent.completion.duration_min),
              distance_km: fingerprintDistanceBucket(intent.completion.distance_km),
              intensity:
                intent.completion.intensity === "easy" || intent.completion.intensity === "quality"
                  ? intent.completion.intensity
                  : null,
            }
          : null;
      return {
        kind,
        status,
        suggested_date: typeof intent?.suggested_date === "string" ? intent.suggested_date : null,
        window_start: typeof intent?.window_start === "string" ? intent.window_start : null,
        window_end: typeof intent?.window_end === "string" ? intent.window_end : null,
        target_distance_km: fingerprintNumber(intent?.target_distance_km),
        target_duration_min: fingerprintNumber(intent?.target_duration_min),
        target_zone: typeof intent?.target_zone === "string" ? intent.target_zone.trim() || null : null,
        completion,
      };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { available, intents };
}

// dayRead()'s contract is that it never throws on missing data, and this runs
// inside it — either contextual read may fail independently without taking the
// Brief down. Only compact agenda facts rendered into the prompt participate;
// rationale/why/guidance narration never enters this identity.
export function currentDayReadFingerprintContext(date: string): DayReadFingerprintContext {
  let programBlock: DayReadFingerprintContext["program_block"] = null;
  try {
    programBlock =
      (db
        .prepare(
          `SELECT goal, focus, phase, week_index, total_weeks, started_at
           FROM program_blocks WHERE status = 'active' ORDER BY id DESC LIMIT 1`
        )
        .get() as DayReadFingerprintContext["program_block"]) ?? null;
  } catch {
    programBlock = null;
  }
  let flexibleAgenda: DayReadFingerprintContext["flexible_training_agenda"] = null;
  try {
    flexibleAgenda = compactFlexibleAgendaFingerprint(flexibleTrainingAgenda(date));
  } catch {
    flexibleAgenda = null;
  }
  return { program_block: programBlock, flexible_training_agenda: flexibleAgenda };
}

// The fingerprint answers exactly one question: could the DECISION have changed?
// It is the trigger that throws away a warm agentic read for the deterministic
// floor, so anything hashed here that cannot move the decision is pure churn —
// a mid-day watch sync used to flip it (raw `avg_sleep_min`, the whole `fatigue`
// blob with its acute_load / hrv_vs_norm / readiness window average) and cost the
// athlete their coach's sentence plus a fresh brain_decisions row, for a read that
// never changed. Continuous measurements are therefore reduced to the PREDICATES
// the rules above actually branch on (short sleep, low readiness, an anticipated
// deload, a volume spike); athlete-entered context (check-ins, life events, plan
// selection) is kept whole because it only moves when the athlete acts.
//
// The same reduction applies to the TRAINING LOG, and for the same reason. The log
// moves far more often than the watch does: one evening produced ten-plus day_read
// recomputes between 20:30 and 23:45 — one agent call every two or three minutes,
// on a day whose read was already terminal ("done") — because `logged_today` was
// hashed whole and its raw set COUNT moved on every single logged set. What a
// logged set can genuinely change about today's decision already arrives here in
// banded form: `today_load` is the day's grade (none/easy/moderate/hard) and
// `trained_today` is the fact. So `logged_today` keeps only "is there any set" plus
// the day's efforts by type and banded size, and `recent_load` keeps only each
// day's grade plus yesterday's overdose flag (see the compact* helpers above).
// The documented intent is preserved exactly: a NEW activity — the evening run
// appearing — still moves this hash; another set of the lift already underway, and
// a watch re-sync rewriting the same effort, do not.
//
// Pure over the supplied read and explicit block context. Fuel deliberately stays
// out: it has its own both-present serve-time comparator, which preserves cached
// rows written before the visible fuel signal existed.
export function dayReadInputFingerprint(
  date: string,
  read: Pick<DayRead, "kind" | "focus" | "signals">,
  context: DayReadFingerprintContext = { program_block: null, flexible_training_agenda: null }
): string {
  const signals = read.signals ?? {};
  const shortNight = (minutes: unknown): boolean => {
    const value = Number(minutes);
    return Number.isFinite(value) && value > 0 && value < 360;
  };
  // The drive read's `focus` is not a decision, it is the RENDERED due list — and the
  // due list moves every time a set is logged, which is precisely what a partially
  // completed session does. Hashing it discarded the warm Brief and queued a fresh
  // agent call mid-session on a decision that had not changed (log two rows of curls
  // and "Back and biceps" becomes "Back and rear shoulders"). So this read hashes a
  // stable token in the focus slot instead. Scoped to the drive read alone: every
  // other read still hashes its focus exactly as before, because for them the focus
  // IS part of the decision (which body region the day is about) rather than a
  // read-time rendering of a list that is being consumed as the day goes on. The
  // due list itself is out of the hash for the same reason (see `training_drive`).
  const driveRead = !!(read.signals as any)?.training_drive_push;
  const input = {
    date,
    baseline_kind: read.kind,
    focus: driveRead ? "training_drive_push" : (read.focus ?? null),
    program_block: context.program_block,
    flexible_training_agenda: compactFlexibleAgendaFingerprint(context.flexible_training_agenda),
    recovery_week: signals.recovery_week ?? null,
    recent_load: compactRecentLoadFingerprint(signals.recent_load),
    // Today's load GRADE — already the banded form of today's volume, and what the
    // rules branch on directly. A session crossing from easy into moderate/hard
    // moves it; the sets inside one grade do not. Kept whole.
    today_load: signals.today_load ?? null,
    trained_today: signals.trained_today ?? null,
    logged_today: compactLoggedTodayFingerprint(signals.logged_today),
    // The chronic-sleep watch branches on the <6h average, not the average itself.
    low_sleep: !!signals.low_sleep,
    // Likewise the acute branch: a fresh night is short, or it isn't.
    short_last_night: shortNight(signals.last_night?.total_min),
    checkin: signals.checkin ?? null,
    fatigue: {
      anticipate_deload: !!signals.fatigue?.anticipate_deload,
      low_readiness: !!signals.fatigue?.low_readiness,
    },
    volume_spike: !!signals.endurance_volume?.volume_spike,
    // The athlete's standing posture. It is a decision INPUT — it selects which rules
    // are available on a stacked-days morning — so flipping it must throw away the warm
    // read rather than leave a rest on screen the floor would no longer produce. The
    // DUE-group list deliberately stays out: it moves every time a set is logged, and
    // hashing it would churn a read that has not changed.
    //
    // The key is OMITTED, not nulled, on the default `steady` posture, which serves the
    // same end as the `fuel` comparator in day-read-use-case.ts: a row cached before
    // this signal existed carries no posture at all, and the mere APPEARANCE of a new
    // key must not invalidate every warm read on the estate once, on deploy day. Every
    // pre-deploy read was a steady read by definition, so omitting the key there makes
    // the two hashes identical — while a genuine steady→push flip (or push→steady)
    // still adds or removes the key and still throws the warm read away. Unlike a
    // serve-time both-present comparator, this also catches the athlete who flips to
    // push on deploy day, whose cached row has no key to compare against.
    ...(signals.training_drive && signals.training_drive !== "steady"
      ? { training_drive: signals.training_drive }
      : {}),
    context: signals.context ?? null,
    // The unified signal state's DECISION, not its narration: `reason`/`reasons`/
    // `confidence` restate the same posture in different words as evidence lines
    // come and go (an HRV field arriving mid-day rewrites the sentence and lifts
    // confidence without changing what to do), which is churn, not a new decision.
    //
    // `directives` is therefore selected FIELD BY FIELD rather than spread whole, so
    // that `directives.training_source` stays out. The source names WHICH dimension
    // produced the directive — it selects the athlete-facing lead, but it is not
    // itself a decision, and the inputs that MOVE it (recent_load, checkin, fatigue,
    // logged_today, today_load) are already hashed above. So a genuine change of
    // brake already moves this hash through its own cause; hashing the source on top
    // adds no signal and discards a warm agentic read on the one case it uniquely
    // catches — the same `hold_aggression` changing hands between two dimensions,
    // which is not a new decision. A new directive field must be added here
    // deliberately; that is the point of listing them.
    signal_action: signals.signal_state?.action
      ? {
          posture: signals.signal_state.action.posture ?? null,
          directives: signals.signal_state.action.directives
            ? {
                training: signals.signal_state.action.directives.training ?? null,
                fueling: signals.signal_state.action.directives.fueling ?? null,
                schedule: signals.signal_state.action.directives.schedule ?? null,
              }
            : null,
        }
      : null,
    underfueling: signals.underfueling
      ? {
          state: signals.underfueling.state ?? null,
          action: signals.underfueling.action ?? null,
        }
      : null,
    // Hybrid sequencing can change the athlete-facing agent sentence even when
    // the day posture stays the same. Keep only the three boolean decisions:
    // moved/completed flexible-agenda intentions then reconcile a stale warm
    // read without hashing the agenda's narration or raw plan.
    hybrid: signals.hybrid
      ? {
          cardio_today: !!signals.hybrid.cardio_today,
          hard_cardio_yesterday: !!signals.hybrid.hard_cardio_yesterday,
          protect_run_next: !!signals.hybrid.protect_run_next,
        }
      : null,
    plan_selection: signals.plan_selection ?? null,
    // Calendar holds and the health work-around are decision inputs (day_claimed_rest,
    // lab_draw_morning, lookahead_retimed_training, guarded quiet-streak prose). They
    // used to ride on the writers calling invalidateDayRead() unconditionally; a future
    // hold writer that forgets would serve a warm stale read that serve-time
    // reconciliation cannot detect. Compacted to the predicates the rules branch on,
    // not titles or summaries (those are narration).
    today_holds: compactTodayHoldsFingerprint(signals.today_holds),
    tomorrow_holds: compactTomorrowHoldsFingerprint(signals.tomorrow_holds),
    health_workaround: compactHealthWorkaroundFingerprint(signals.health_workaround),
    // `applied` is the fact the outcome loop acted; `active` is only the argument
    // for it. The easy-ladder sibling is the same hole one rung up.
    outcome_feedback_applied: compactOutcomeAppliedFingerprint(signals.outcome_feedback),
    easy_outcome_feedback_applied: compactOutcomeAppliedFingerprint(signals.easy_outcome_feedback),
  };
  return createHash("sha256")
    .update(JSON.stringify(stableValue(input)))
    .digest("hex")
    .slice(0, 24);
}

function finalizeDeterministicRead(
  date: string,
  outcome: DayReadRuleOutcome,
  read: Omit<DayRead, "decision" | "input_fingerprint" | "computed_at">
): DayRead {
  const computedAt = new Date().toISOString();
  const decision: DayReadDecision = {
    rule_code: outcome.code,
    basis: "deterministic",
    baseline_kind: read.kind,
    // Rotated by calendar day so a stable input does not print one identical
    // sentence for a week (see DayReadRuleOutcome.reasons).
    reason: pickDayVariant(outcome.reasons, date, outcome.code),
    evidence: boundedEvidence(read.signals, date),
    computed_at: computedAt,
  };
  return {
    ...read,
    decision,
    computed_at: computedAt,
    input_fingerprint: dayReadInputFingerprint(
      date,
      read as Pick<DayRead, "kind" | "focus" | "signals">,
      currentDayReadFingerprintContext(date)
    ),
  };
}

// ---------- the ONE planning signal state ----------
// `planningSignalState` takes nine OPTIONAL inputs, and three of them carry
// safety_override CONSTRAINTS the athlete-facing read must never be blind to:
// joint pain and the low-performance flag arrive through `trainingSignals`, an
// anticipated reset through `programState.mesocycle`. "Optional" means a caller
// that omits them silently builds a WEAKER state — no error, no warning — which
// is exactly how the Brief came to say "train" on a day getCoachContext was told
// to protect (thin: posture=train/proceed; rich: posture=rest/recover, with
// health_constraints and load_tolerance both constrained).
//
// So there is exactly ONE builder, it is always rich, and it is memoized per
// (date, request) under the same brain-snapshot key getCoachContext already used.
// Within one request the Brief's deterministic baseline, the prompt's baseline,
// the server-policy clamps, the persisted `signals`/`input_fingerprint` and the
// coach context therefore describe the SAME state — the rich/thin seam cannot
// reopen. Outside a request scope (the scheduler's warm) `brainSignal` is a
// pass-through, so callers that must agree thread the baseline explicitly
// instead; see computeDayRead → buildDayReadPrompt.
//
// Every producer is probed INDIVIDUALLY behind try/catch: dayRead() is on the
// morning-open path and must ALWAYS return, so a thrower degrades that one input
// rather than failing the whole read. A caller may pass a value it already holds
// (all of these are expensive); the memo makes the first caller in a request
// authoritative, and every caller derives them from the same producers for the
// same date, so which one lands first does not change the decision.
export interface DayPlanningSignalInputs {
  recovery?: any;
  checkin?: any;
  trainingSignals?: any;
  programState?: any;
  expenditure?: any;
  underfueling?: any;
  context?: any;
  contextEvents?: any[];
  completedToday?: boolean;
  runIntensity?: any;
  directives?: any[];
}

function signalInput<T>(compute: () => T, fallback: T): T {
  try {
    return compute();
  } catch {
    return fallback;
  }
}

export function dayPlanningSignalState(date: string, provided: DayPlanningSignalInputs = {}): UnifiedSignalState {
  return brainSignal(`signal_state:${date}`, () => {
    // Recovery is NOT memoized under getCoachContext's `recovery:14` key: that key
    // holds a summary built over an explicitly-passed Garmin window, and silently
    // seeding it from here would let a differently-scoped fetch win the race.
    const recovery =
      provided.recovery ??
      signalInput(() => withMorningReadiness(getRecoverySummary(14, undefined, date), date), null);
    // Today keeps the BARE memo keys below — they ARE getCoachContext's, and sharing
    // them is what keeps one Brief request from building these expensive producers
    // twice no matter which consumer asks first. A read of an EARLIER date gets its
    // own keys and its own date-bounded inputs, because "the twenty newest sessions"
    // and "the last 21 completed days" are both measured from NOW: unscoped, a read
    // of last Tuesday was derived from work logged after it, and called every lift
    // stale by today's calendar. Same class of bug as the program-state one below.
    const isLiveDate = date === localDateISO();
    const trainingSignalsView =
      provided.trainingSignals ??
      signalInput(
        () =>
          brainSignal(isLiveDate ? "training_signals" : `training_signals:${date}`, () =>
            trainingSignals(
              brainSignal(isLiveDate ? "recent_sessions:20" : `recent_sessions:20:${date}`, () =>
                getRecentSessions(20, isLiveDate ? {} : { through: date })
              ) as any[],
              date
            )
          ),
        null
      );
    // Keyed to the date being READ, not to "now". getCoachContext only ever asks
    // for today, so today keeps its bare `program_state` key and stays shared; a
    // read of an earlier date gets that date's mesocycle instead of one measured
    // from today (which would tell a day inside an applied recovery week that a
    // reset was months overdue). getProgramState defaults to today for `undefined`,
    // so passing the date through is equivalent for the common case.
    const programState =
      provided.programState ??
      signalInput(
        () =>
          brainSignal(isLiveDate ? "program_state" : `program_state:${date}`, () => getProgramState(date, recovery)),
        null
      );
    const expenditure =
      provided.expenditure ??
      signalInput(
        () =>
          brainSignal(isLiveDate ? "expenditure:21" : `expenditure:21:${date}`, () =>
            estimateExpenditure(21, isLiveDate ? {} : { asOf: date })
          ),
        null
      );
    return planningSignalState({
      date,
      recovery,
      checkin: provided.checkin ?? signalInput(() => getCheckinByDate(date), null),
      trainingSignals: trainingSignalsView,
      programState,
      expenditure,
      underfueling: provided.underfueling ?? signalInput(() => currentUnderfuelingRead(date), null),
      // Keyed to the date being read for the same reason program state is: the window
      // is measured backwards from THAT day, and a read of last Tuesday must not be
      // handed the fortnight that ends today. Memoized so the signal state and
      // `run_variety` (which carries the same read's compact form) build it once.
      runIntensity:
        provided.runIntensity ??
        signalInput(() => brainSignal(`run_intensity:${date}`, () => runIntensityDiscipline(date)), null),
      // The active directive set, so the morning read brakes on the same finding the
      // run builder caps the week with. Memoized under a bare key: it is a whole-table
      // read of what the athlete is acting on RIGHT NOW, with no date window of its own,
      // so a read of an earlier date sees the same rows (the alternative — reconstructing
      // which directives were active last Tuesday — is not something the table records).
      directives: provided.directives ?? signalInput(() => brainSignal("active_directives", listActiveDirectives), []),
      context: provided.context ?? signalInput(() => activeContextEffect(date), null),
      contextEvents: provided.contextEvents ?? signalInput(() => planningContextEvents(date), []),
      completedToday: provided.completedToday ?? false,
    });
  });
}

// ---------- which rests the outcome loop may soften ----------
// The rest reads whose case is an ACCUMULATION argument — enough loading days have
// stacked up, the watch read low, the athlete said they felt flat. Those are exactly
// the reads the athlete has been overruling successfully, and they are reversible: a
// softened one still asks for an easy day, and tomorrow's read sees today's log.
//
// Everything else is excluded ON PURPOSE and the exclusions are the safety contract:
//   • `acute_sleep_corroborated` — a short night on top of a short stretch is FRESH
//     evidence about today, not a standing judgement. History cannot argue with it.
//   • `recovery_dose_overrun` — yesterday measurably exceeded a reduced week's dose.
//     Also a fact about the last 24 hours.
//   • anything clinical — see clinicallyDriven() below. That floor is absolute.
//
// WHICH OF THESE ACTUALLY KEYS A READ, verified rather than assumed (the earned-rest
// rule below carries the matching note, and the two used to disagree). On the
// PRODUCTION path — `dayRead(date)`, where the signal state is built rich from the
// same DB the rule reads — `low_readiness_rest` and `felt_run_down_rest` never key
// anything: a low check-in becomes a safety_override constraint and a subdued
// readiness reading a recovery constraint, so the unified protect rule ABOVE the
// earned-rest rule wins the posture first and the read ships as
// `acute_signal_protection` (rest and easy respectively).
//
// They are listed here anyway because they are not dead — they are reachable through
// the one documented seam that can separate the two, a caller that SCOPES the whole
// state via `dayRead`'s `unifiedState` argument while the athlete's check-in or
// readiness reading still sits in the DB. That path still produces a genuine rest
// under those codes, and an accumulation rest is exactly what softening is for, so
// dropping them would silently make one shape of rest unsoftenable. Membership is
// pinned by test/dayReadPushLadder.test.js in both directions.
const SOFTENABLE_REST_CODES: ReadonlySet<string> = new Set([
  DAY_READ_OUTCOMES.accumulated_load_rest.code,
  DAY_READ_OUTCOMES.low_readiness_rest.code,
  // The deep readiness band. Softenable — but read the ladder before assuming that
  // makes it weak: rest may only ever be eased to EASY, the softened read carries no
  // focus and a 20-minute clock, `outcome_feedback_soften` is excluded from the easy
  // ladder so it can never chain on to train, and composition refuses to make that
  // easy day a run (see daily-composition's endurance hold).
  DAY_READ_OUTCOMES.rest_grade_readiness.code,
  DAY_READ_OUTCOMES.felt_run_down_rest.code,
  DAY_READ_OUTCOMES.acute_signal_protection.code,
]);

// ---------- …and which EASY reads it may open (owner ruling, 2026-08-17) ----------
// The mirror of the set above, one rung up. Same shape of argument: these are the easy
// reads whose case is an ACCUMULATION — a sleep trend, a week's running that ramped, a
// board of soft signals — never a fact about the last 24 hours and never anything
// clinical. Those are exactly the reads an experienced athlete has been outrunning
// successfully, and opening one is reversible: a train read is still a suggestion, and
// tomorrow's model sees how today actually went.
//
// EVERY easy-producing rule code, and where each landed:
//   • acute_signal_protection  — SOFTENABLE. The dominant soft-signal easy read. Its
//     clinical shapes are already excluded by clinicallyDriven() at the call site, so
//     what is left here is the accumulation case this rule is for.
//   • chronic_sleep_watch      — SOFTENABLE. A trend, explicitly "nothing acute this
//     morning". (Its acute sibling, acute_sleep_corroborated, produces a REST and is
//     excluded from the rest ladder for the same reason: fresh evidence about today.)
//   • endurance_volume_spike   — SOFTENABLE. A week-shaped mileage argument, and the
//     kind of week an athlete who is absorbing it demonstrably trains through.
//   • logged_light_work_today  — EXCLUDED. Not a brake at all: it acknowledges movement
//     ALREADY logged today. Opening it would ask for a second session on the strength
//     of evidence about other mornings.
//   • unprogrammed_easy_day    — EXCLUDED, as unreachable rather than as policy: it
//     is the floor that fires only when NO rule resolved, and a due plan day makes
//     planned_training resolve — so "unprogrammed with a session to open" cannot
//     occur, and softenEasy already refuses to invent a session when none is due.
//   • accumulated_load_rest    — SOFTENABLE on the EASY arm. At the hard-day ceiling
//     with recovery still reading well, that code now produces easy rather than rest
//     (see the ladder on PUSH_DRIVE_CONSEC_CEILING). The rest arm stays in
//     SOFTENABLE_REST_CODES. Same code, two kinds; membership in both sets is what
//     lets overridden_and_fine evidence open the ceiling-easy morning — which is
//     exactly the ladder's purpose. The drive preference cannot answer the ceiling.
//   • outcome_feedback_soften  — EXCLUDED, and this one is a safety rule rather than a
//     taste: it is a rest this loop ALREADY softened once. Allowing it would chain the
//     two ladders into rest → easy → train inside one window, and each ladder moves
//     exactly one step by design.
// Recovery-week and symptom/illness reads reach neither set: `recoveryWeek` and
// clinicallyDriven() are checked at the call site, whichever code produced the day.
const SOFTENABLE_EASY_CODES: ReadonlySet<string> = new Set([
  DAY_READ_OUTCOMES.acute_signal_protection.code,
  DAY_READ_OUTCOMES.chronic_sleep_watch.code,
  DAY_READ_OUTCOMES.endurance_volume_spike.code,
  DAY_READ_OUTCOMES.accumulated_load_rest.code,
]);

// The hard ceiling on consecutive LOADING days. A day counts as loading when it
// is `hard`, or moderate strength work (a logged lifting session), or hard cardio
// (`hardCardioDay`). For a strength-led athlete a moderate/easy cardio-only day
// does not extend the streak; endurance-led athletes still count hard OR moderate
// as dayLoad always has. Calendar counts are a CAVEAT, never a brake of their
// own. The ladder, greppable from test/dayRead.test.js which pins both sides:
//
//   1. Below the ceiling, stacked days with no corroborating signal ride as a
//      caveat on the train/easy read (STACKED_DAYS_CAVEAT). The day stays open.
//   2. Stacked days corroborated by a current signal (low readiness, a run-down
//      check-in, a recovery-week dose overrun, a fresh brake, recovery_capacity
//      watch/constrained with fresh data, anything clinical today, or a clinical
//      shape starting tomorrow) may still fire accumulated_load_rest as REST.
//   3. At five loading days with recovery still supportive and nothing else
//      pulling the other way, the read is EASY under the same code — not rest,
//      and not another train day the preference can keep opening. The easy
//      ladder may still open it, but only via overridden_and_fine evidence,
//      which is exactly the ladder's purpose.
//   4. The training-drive preference may answer (1) with a targeted session;
//      it cannot answer (3). Five is the bound on the preference, not on the
//      easy ladder.
const PUSH_DRIVE_CONSEC_CEILING = 5;
// Readiness that positively CORROBORATES the day, as opposed to merely failing to
// object. `lowReadiness` (the rest trigger) sits at <35; this is a long way clear of
// it, because the wearable path is the one that can earn the read without a single
// rated session behind it and so has to clear a higher bar than "not alarming".
// The number lives in readiness-bands.ts because read-adherence now asks the same
// vouching question about the morning AFTER a hard day, and the two modules may not
// import each other — a second literal is exactly how a band drifts.
const PUSH_DRIVE_READINESS_FLOOR = SUPPORTIVE_READINESS;

// Does LAST NIGHT's HRV positively support the day? Only a reading dated the read day
// (isLastNight — sleep and HRV are wake-dated), then Garmin's own personal band when it
// sent one for that night, else the value against the athlete's own median and the
// same smallest-worthwhile-change bar recoveryDrift uses. No night, no norm → false.
function lastNightHrvSupports(rec: any, d: string, hrvBar: number): boolean {
  const hrv = Number(rec?.recovery?.hrv_ms);
  if (!isLastNight(rec?.quality?.hrv_ms?.latest_date ?? null, d) || !Number.isFinite(hrv)) return false;
  const status = rec?.recovery?.hrv_status;
  if (status != null && isLastNight(rec?.quality?.hrv_status?.latest_date ?? null, d)) {
    return String(status).toLowerCase() === "balanced";
  }
  const norm = Number(rec?.baseline?.hrv);
  return Number.isFinite(norm) && norm > 0 && hrv >= norm - hrvBar;
}

// Shared corroboration path: recovery_capacity already supportive at high
// confidence, with fresh HRV / resting HR / sleep on the board, last night
// present and long enough, nothing fresh braking, and training still `proceed`.
// Absence of any of those is absence — silence is never corroboration. The
// envelope's reach resolver uses this same helper so the two answers cannot
// drift (a hand-built `backed: true` on the snapshot is not this path).
export function supportiveCapacityBacksDay(input: {
  status?: string | null;
  confidence?: string | null;
  freshHrv?: boolean;
  freshRestingHr?: boolean;
  freshSleep?: boolean;
  sleptEnough?: boolean;
  freshBrake?: boolean;
  trainingDirective?: string | null;
}): boolean {
  return (
    input.status === "supportive" &&
    input.confidence === "high" &&
    input.freshHrv === true &&
    input.freshRestingHr === true &&
    input.freshSleep === true &&
    input.sleptEnough === true &&
    input.freshBrake !== true &&
    input.trainingDirective === "proceed"
  );
}

// Is anything clinical in play today? Probed three ways because the same constraint
// can reach the read by three routes, and a single check would miss two of them:
// a fresh constraint item (an injury, an illness, a painful joint — the same probe
// the work-around sentence uses), the DRIVING evidence behind today's posture
// (`source_dimensions`, which is where a health item that only contributed to the
// arbitration shows up), and the dimension's own standing status. Any of them and
// the day is not softenable, whichever rule produced the rest.
//
// The standing-status arm reads the RAW status on purpose, and that is only safe
// while no advisory brake lands on health_constraints (today every advisory item
// sits on recovery_capacity or training_load_tolerance). An informational finding
// must never decide that a day cannot be softened — if a health-dimension advisory
// brake is ever added, this arm has to read `deciding.status` instead.
function clinicallyDriven(signalState: UnifiedSignalState, healthWorkaround: unknown): boolean {
  const health = signalState.dimensions.health_constraints;
  return (
    !!healthWorkaround ||
    signalState.action.source_dimensions.includes("health_constraints") ||
    health.status === "constrained" ||
    health.status === "watch"
  );
}

// ---------- which quiet reads the LONG loop may open (owner ruling, 2026-09-22) ----------
// Accumulation reads only — a readiness below the subdued band, stacked loading, a soft
// board, a sleep trend, a mileage week. NEVER the floors: rest-grade readiness, a fresh
// short night, a measured dose overrun, the athlete's own run-down word, and anything the
// calendar or a clinician owns. health_constraints/injury (clinicallyDriven), a fresh
// safety_override and acute-gate saturation are checked at the call site.
const LEARNED_TRAIN_CODES: ReadonlySet<string> = new Set([
  DAY_READ_OUTCOMES.accumulated_load_rest.code,
  DAY_READ_OUTCOMES.low_readiness_rest.code,
  DAY_READ_OUTCOMES.acute_signal_protection.code,
  DAY_READ_OUTCOMES.chronic_sleep_watch.code,
  DAY_READ_OUTCOMES.endurance_volume_spike.code,
]);

// ---------- which brakes the day-read AGENT may cite to read a train day quieter ----------
// (2026-09-23; enforced in src/dayread.ts, listed to the agent by src/prompt/day.ts.)
// A fresh DECIDING brake on the day's own signal state (freshDecidingBrakeFields) — the
// set the posture ladder itself treats as able to decide a day; advisory and advice-only
// cautions never qualify. And none at all on a day the athlete's OWN RECORD opened
// (the long loop, or the easy ladder): those loops run only with no floor, no clinical
// constraint and no fresh safety override live, so every brake still on that board is
// one the record has already outweighed — citing it would hand the agent back the
// quiet read the calibration just retired.
const RECORD_OPENED_CODES: ReadonlySet<string> = new Set([
  DAY_READ_OUTCOMES.learned_train_anyway.code,
  DAY_READ_OUTCOMES.outcome_feedback_open.code,
]);

export function dayReadCitableBrakes(
  baseline: { kind?: unknown; decision?: { rule_code?: unknown } | null; signals?: Record<string, any> } | null | undefined
): string[] {
  if (baseline?.kind !== "train") return [];
  if (RECORD_OPENED_CODES.has(String(baseline.decision?.rule_code ?? ""))) return [];
  const dimensions = baseline.signals?.signal_state?.dimensions;
  if (!dimensions || typeof dimensions !== "object") return [];
  try {
    return freshDecidingBrakeFields(dimensions);
  } catch {
    return [];
  }
}

function freshSafetyOverride(signalState: UnifiedSignalState): boolean {
  return Object.values(signalState.dimensions).some((dimension) =>
    dimension.evidence.some(
      (item) => item.safety_override === true && item.direction === "constraint" && item.freshness !== "stale"
    )
  );
}

// Is any strength group of this plan day still DEEPLY carrying work? The one acute
// question, asked through acuteGates — never a re-derived window. Only a deep residual
// keeps a quiet read shut: a group just over its own bar holds its load on the card
// (saturated-substitution / the envelope's shallow hold), it does not cancel the day.
function planDayAcutelySaturated(dayNumber: number, date: string): boolean {
  const groups = planDayStrengthGroups().find((day) => day.day_number === dayNumber)?.groups ?? [];
  if (!groups.length) return false;
  const gates = acuteGates(date) as Map<string, { deep: boolean }>;
  return groups.some((group) => gates.get(group)?.deep === true);
}

// ---------- the athlete's own morning outranks a fortnight of history ----------
// `clinicallyDriven` above is the ONLY floor the outcome-softening ladders used to
// consult, and it probes `health_constraints` — which is not where a morning check-in
// lands. A run-down or sore check-in filed for the day being read sits in
// `recovery_capacity` / `training_load_tolerance`, so the athlete who said they felt
// wrecked could have their easy read opened into a full session by a twelve-day
// override pattern, with a `why` that never mentioned what they had just told us. That
// inverts the constitution's own rule: check-ins INFORM, and they are never the thing
// that gets overruled.
//
// So a FRESH statement about the day being read vetoes the softening. Strictly scoped:
//   • SAME DAY ONLY. A check-in row for `date`, or a symptom whose last STATED day is
//     `date`. `stated_freshness` is the ladder that means "how current is their own
//     account" — quiet training refreshes `freshness` and deliberately never this, so
//     an inferred exposure can no longer read as the athlete speaking (see
//     src/repo/training-symptoms.ts).
//   • The SEVERE end of each scale, matching the thresholds the signal state already
//     treats as a constraint (energy/sleep_feel <= 2, soreness >= 4) rather than a new
//     bar of this rule's own.
//   • Absence changes nothing. No check-in, no symptom, no veto — absence of a
//     statement is not a statement.
// It can only ever HOLD a read where the rules put it. It never brakes a day, never
// creates a read, and never turns anything into rest.
function freshStatementHold(date: string, checkin: any): FreshStatementField | null {
  if (checkin && checkin.energy != null && Number(checkin.energy) <= 2) return "felt_energy";
  if (checkin && checkin.sleep_feel != null && Number(checkin.sleep_feel) <= 2) return "sleep_feel";
  if (checkin && checkin.soreness != null && Number(checkin.soreness) >= 4) return "felt_soreness";
  // `seed_legacy: false` on purpose: this is the morning-open path and it must not
  // write. The legacy import runs from the surfaces that own the symptom lifecycle;
  // a row it has not reached yet simply does not veto, which is the safe direction.
  const spokeToday = signalInput(
    () =>
      listTrainingSymptoms({ on: date, seed_legacy: false }).some(
        (event) => event.status === "active" && event.last_stated_on === date
      ),
    false
  );
  return spokeToday ? "symptom_report" : null;
}

// Deterministic baseline (T1 layers the agentic sentence + buildDayReadPrompt on
// top). Rules: rest if >=3 consecutive training days OR recovery clearly low;
// else train the suggested plan day; else easy. Never throws on missing data.
//
// PARAMETER CONTRACT: every optional argument overrides exactly its OWN input and
// nothing else. Supplying one never suppresses the others, and never narrows what
// the read may look at — `dayRead` reads the training log, plan, activities,
// check-ins, context events and fuel state straight from the DB regardless of what
// any caller passes. So `dayRead(d, {has_data:false, recovery:{}})` says "this
// athlete has no wearable recovery signal", NOT "read nothing else"; their logged
// sessions are still real history the read is supposed to see. `recovery` exists
// only to spare a caller that already holds the 14-day summary a redundant fetch.
// `unifiedState` is the ONE parameter that scopes the whole signal state — pass it
// to take full control; omit it and the state is built rich (see
// dayPlanningSignalState). Anything else would be exactly the failure mode this
// function was just fixed for: an optional argument silently changing what the
// athlete-facing read is allowed to know.
//
// MEMOIZED at this export boundary only, and only for the BARE form. One Today open
// asks for the same day's read three or four times — the cached fast path's fingerprint
// comparison, the daily-decision snapshot, the next-step candidates, the coach context —
// at ~800 statements each. The key is the date, the local hour and the coach-context
// backstop signature (counts, high-water marks and the update odometer over every table
// this read touches, plus profile and settings by value), so a write lands a new key:
// the writer at invalidateDayReadIfDecisionChanged, which reads before it writes and
// must see its own post-write read, is safe here where a plain TTL would not be.
//
// Every call that OVERRIDES an input — recovery, unifiedState, underfuelingSnapshot —
// bypasses the memo entirely and recomputes. Those callers hold views assembled
// elsewhere, and the parameter contract above is that each overrides exactly its own
// input; nothing about a caller-supplied view belongs in a shared cache.
//
// The cached read is handed out AS IS, not cloned — the same convention getCoachContext
// follows for the same reason: it is a read MODEL, every consumer spreads it
// (`{...read, headline}`) or reads fields off it, and the request-scoped signal state
// inside it is meant to be the one object the Brief and the coach both hold (see
// test/dayReadUseCase "one signal state per date per request"). Treat what comes back as
// read-only; a consumer that needs to change a field copies it first.
// EIGHT SLOTS, the same budget programAdjustments uses, rather than one. A single slot
// makes two interleaved dates evict each other on every call — the look-ahead asks for
// tomorrow between two of today's reads, and a one-slot memo then recomputes both from
// scratch, forever. The distinct keys in one request are few and fixed (a date or two,
// one hour), so a handful of slots turns that thrash into hits; the map is cleared with
// every other training memo, and the oldest insertion is dropped once past the budget.
const DAY_READ_MEMO_SLOTS = 8;
const dayReadCache = new Map<string, DayRead>();
registerTrainingCacheClear(() => {
  dayReadCache.clear();
});

export function dayRead(
  date?: string,
  recovery?: any,
  unifiedState?: UnifiedSignalState,
  underfuelingSnapshot?: UnderfuelingRead
): DayRead {
  if (recovery !== undefined || unifiedState !== undefined || underfuelingSnapshot !== undefined) {
    return computeDayRead(date, recovery, unifiedState, underfuelingSnapshot);
  }
  const d = date || localDateISO();
  const now = nowContext();
  const key = `${d}|${now.hour}|${now.tz ?? ""}|${coachContextBackstopSignature()}|${runDaySteerKey()}`;
  const hit = dayReadCache.get(key);
  if (hit) return hit;
  const value = computeDayRead(d);
  if (dayReadCache.size >= DAY_READ_MEMO_SLOTS) {
    const oldest = dayReadCache.keys().next().value;
    if (oldest !== undefined) dayReadCache.delete(oldest);
  }
  dayReadCache.set(key, value);
  return value;
}

function computeDayRead(
  date?: string,
  recovery?: any,
  unifiedState?: UnifiedSignalState,
  underfuelingSnapshot?: UnderfuelingRead
): DayRead {
  const d = date || localDateISO();
  const recoveryWeek = activeRecoveryWeek(d);
  // The athlete's standing posture toward an accumulated-load rest. A PREFERENCE, and
  // read like one: it can only ever select among reads the evidence already permits
  // (see the drive rule below), never produce one on its own. Fail-soft to the floor's
  // own rhythm — dayRead never throws, and a settings read that fails must not be able
  // to hand out a training day.
  const trainingDrive = (() => {
    try {
      return getSettings().training_drive;
    } catch {
      return "steady" as const;
    }
  })();

  // Discipline shapes what "a training day" means for the consecutive-days +
  // earned-rest rules. For a strength athlete a logged lifting session counts;
  // for an endurance/hybrid athlete a real cardio effort (a run/ride) is also a
  // training day — otherwise a runner's whole week is invisible and the Brief
  // keeps suggesting fresh sessions on top of hard mileage. Default 'strength'
  // keeps the existing behavior byte-for-byte.
  const discipline = getPrimaryDiscipline();
  // Explicit ordered intent is authoritative. Legacy profiles still resolve to
  // their former discipline behavior through getTrainingIntent()'s derived
  // fallback, while a strength-labelled athlete with supporting endurance no
  // longer has their real rides/runs disappear from the recovery rhythm.
  const countsCardio = getTrainingIntent().endurance_role !== "none";

  // Lifting-session days (a logged set) — still used for "did they train today".
  const sessionDates = new Set(
    (
      db
        .prepare(`SELECT DISTINCT s.date AS dt FROM sessions s JOIN logged_sets l ON l.session_id = s.id`)
        .all() as any[]
    ).map((r) => r.dt)
  );

  // Intensity-aware earned-rest count. The old rule treated ANY logged day as a
  // hard "training day", so a 20-min mobility session (RIR 8-10, no load) or a
  // short easy run stacked toward a forced rest exactly like a heavy lift. Now we
  // grade each day's actual LOAD (hard/moderate/easy — see training-read.dayLoad)
  // and count only genuinely LOADING days: a real recovery day BREAKS the streak,
  // which is how a coach reads it. The per-day grades ride along in `signals` so
  // the agentic layer understands the rhythm too, not just the bare count.
  // Classify each historical day against ITS calendar state. Using only today's
  // active window made the first build day retroactively grade the preceding
  // compliant deload sessions as ordinary loading.
  const recoveryByDate = new Map<string, ReturnType<typeof activeRecoveryWeek>>();
  const recoveryForDate = (iso: string) => {
    if (!recoveryByDate.has(iso)) recoveryByDate.set(iso, activeRecoveryWeek(iso));
    return recoveryByDate.get(iso) ?? null;
  };
  // A genuinely HARD cardio day loads recovery for EVERY athlete, so it counts as a
  // loading day even for a strength-primary lifter (whose discipline otherwise makes
  // dayLoad ignore cardio). Easy strolls clear none of hardCardioDay's bars, so they
  // never count. The GRADE stays what the effort was — the bump is capped at moderate,
  // because `today_load` and the reads that quote it describe the SESSION, not the
  // streak, and a 22-minute tempo is not a hard day. Whether hard cardio EXTENDS the
  // streak is a separate question, asked directly by the loading predicate below: a
  // strength-led hybrid already counts cardio in dayLoad, so a 60-min ride can grade
  // moderate there while still clearing hardCardioDay's bars, and reading the grade
  // alone would drop it from a streak it should extend. The recent cardio-load median
  // is computed once and threaded, avoiding a per-day re-query.
  const cardioLoadMedian = recentCardioLoadMedian(d);
  const gradeDay = (iso: string, recoveryWeekActive: boolean): TrainingLoad | "none" => {
    const base = dayLoad(iso, { countsCardio, recoveryWeekActive });
    if (base === "hard") return base;
    if (!countsCardio && hardCardioDay(iso, cardioLoadMedian)) return "moderate";
    return base;
  };
  const loadAt = (iso: string): TrainingLoad | "none" => gradeDay(iso, !!recoveryForDate(iso));
  // Strength work only — dayLoad with cardio off. A moderate lifting session
  // still extends a strength-led streak; a moderate/easy cardio-only day does
  // not. Endurance-led athletes never consult this (they count hard OR moderate).
  const liftLoadAt = (iso: string): TrainingLoad | "none" =>
    dayLoad(iso, { countsCardio: false, recoveryWeekActive: !!recoveryForDate(iso) });
  // Strength-led (explicit muscle/strength hierarchy, or an active hypertrophy/
  // strength block): hard days, moderate lifting, and hard cardio extend the
  // streak. An easy or moderate run does not. Endurance-led athletes still
  // count hard OR moderate, as dayLoad always has. Fail-soft to the broader
  // count — dayRead never throws.
  const strengthLedStreak = (() => {
    try {
      if (isStrengthLedIntent(getTrainingIntent())) return true;
    } catch {
      /* settings/intent read is fail-soft */
    }
    try {
      const focus = getActiveBlock()?.focus;
      if (focus === "hypertrophy" || focus === "strength") return true;
    } catch {
      /* no block is not an error */
    }
    return false;
  })();
  const recentLoads: { date: string; load: TrainingLoad | "none"; recovery_dose?: any[] }[] = [];
  let consec = 0; // consecutive LOADING days ending yesterday (see the predicate below)
  let streakOpen = true;
  for (let back = 1; back <= 10; back++) {
    const iso = new Date(new Date(d + "T00:00:00Z").getTime() - back * 864e5).toISOString().slice(0, 10);
    const load = loadAt(iso);
    if (back <= 5) {
      const dose = recoveryForDate(iso)
        ? (db.prepare(`SELECT id FROM sessions WHERE date = ? ORDER BY id`).all(iso) as any[]).map((row) =>
            recoverySessionDose(Number(row.id))
          )
        : [];
      recentLoads.push({ date: iso, load, ...(dose.length ? { recovery_dose: dose } : {}) });
    }
    // A day is LOADING when it is hard, or moderate STRENGTH work, or genuinely hard
    // cardio. For a strength-led athlete an easy or moderate cardio-only day does not
    // extend the streak (a 30-minute jog between lifting days is not a fourth hard
    // day); for everyone else the count is what dayLoad has always said. hardCardioDay
    // is asked directly rather than read off the grade, because a strength-led hybrid
    // counts cardio in dayLoad and a hard ride can still grade moderate there.
    const liftLoad = strengthLedStreak ? liftLoadAt(iso) : "none";
    const loading = strengthLedStreak
      ? load === "hard" ||
        liftLoad === "hard" ||
        liftLoad === "moderate" ||
        hardCardioDay(iso, cardioLoadMedian)
      : load === "hard" || load === "moderate";
    if (streakOpen && loading) consec++;
    else streakOpen = false;
    if (!streakOpen && back > 5) break;
  }
  const yesterdayRecoveryOverdose = !!recentLoads[0]?.recovery_dose?.some(
    (dose: any) => dose?.classification === "overdose"
  );

  // Endurance volume spike: a weekly-mileage jump well above the prior weeks'
  // average is its own earned-rest signal (consecutive-day counting can miss a
  // single very-long effort). Deterministic + null-safe; only for endurance/hybrid.
  let volumeSpike = false;
  let lastWeekKm: number | null = null;
  if (countsCardio) {
    // ONE definition of a running week, shared with the reaction model and the next-
    // step engines: `weeklyKm(anchor, weekBack, patterns)` sums the seven days ending
    // `weekBack * 7` days before the anchor. This file used to carry a byte-identical
    // private copy of that query, which is how two windows drift apart in the first
    // place. The anchor is YESTERDAY for the acute week (today is still being lived,
    // and a run logged this morning is not a week's worth of evidence) and TODAY for
    // the three prior weeks, exactly as the inline version computed them.
    // (runVolumeSpikeRead holds that definition, and the run morning read uses the same
    // one, so the Brief and the run engine can never disagree about a spiking week.)
    const spike = runVolumeSpikeRead(d);
    lastWeekKm = spike.last_week_km;
    volumeSpike = spike.volume_spike;
  }

  // Recovery signal (unified). "clearly low" = short sleep or a low subjective
  // check-in for the day. All optional — absent signals never force rest. The
  // window is the 14 days ending on the day being read — a past-dated read must
  // not see wearables that arrived after it. A caller that already has the
  // matching summary (getCoachContext, for today) can pass it in to avoid a
  // redundant fetch.
  // Once today has training on it, readiness is the MORNING's (withMorningReadiness).
  const rec = recovery ?? withMorningReadiness(getRecoverySummary(14, undefined, d), d);
  const checkin = getCheckinByDate(d) as any;
  // "Last night" is the night that ENDED on `d`, and nothing else. Sleep is dated by
  // its WAKE day, so a row dated d-1 is the night BEFORE last: at the window's
  // two-day tolerance the Brief once said "you had a solid night of sleep" on a
  // morning the watch had not been worn at all. The one-night bound is therefore
  // exact (LAST_NIGHT_MAX_AGE_DAYS = 0), and the CHECK lives inside latestSleep(),
  // which takes the bound as a required argument, so a caller cannot forget it the
  // way an outside gate invited. An older night reads as ABSENT here, which is
  // neutral — the read never claims how they slept from data it does not have.
  const lastNight = latestSleep(LAST_NIGHT_MAX_AGE_DAYS, d);
  // The night that ANCHORS THE WINDOW, at the window's own tolerance. Its only job
  // is to say the rolling average still describes recent sleep rather than being a
  // stale leftover; it is never spoken of as last night.
  const recentNight = latestSleep(SENSOR_MAX_AGE_DAYS.sleep, d);
  const avgSleepMin = rec?.recovery?.avg_sleep_min ?? null;
  const sleepQuality = rec?.quality?.sleep_min ?? rec?.recovery?.quality?.sleep_min ?? null;
  const sleepSamples = Number(sleepQuality?.sample_count);
  // A 14-day mean with n=1 is not a chronic pattern — the neighbouring delta
  // block already refuses to compare below this floor. Missing a genuine chronic
  // case is acceptable; absence reads neutral.
  const sleepMeanReady = Number.isFinite(sleepSamples) && sleepSamples >= RECOVERY_SAMPLE_FLOOR;
  const lowSleep = avgSleepMin != null && avgSleepMin > 0 && avgSleepMin < 360 && sleepMeanReady;
  const freshShortSleep =
    lastNight?.total_min != null && Number(lastNight.total_min) > 0 && Number(lastNight.total_min) < 360;
  const corroboratedLowSleep = lowSleep && freshShortSleep;
  // Chronic watch / train-day caveat: the mean is real AND a recent night exists
  // so the window is not a stale leftover. That anchor is a WINDOW question, so it
  // reads `recentNight` (two-day tolerance) rather than last night — a chronic
  // pattern does not evaporate because this particular morning went unsynced. Last
  // night being SHORT as well is the REST path (`corroboratedLowSleep` /
  // acute_sleep_corroborated) and would make these two rules unreachable if they
  // shared that predicate.
  const chronicLowSleep = lowSleep && recentNight != null;
  const lowSubjective =
    checkin &&
    ((checkin.energy != null && checkin.energy <= 2) || (checkin.sleep_feel != null && checkin.sleep_feel <= 2));

  // ---- predictive deload anticipation ----
  // Don't wait for 3 hard days to already be logged: read the acute-vs-chronic
  // recovery DRIFT (HRV below their norm, resting HR above it) plus rising acute
  // training load, and ANTICIPATE the reset a day or two early. This NEVER forces
  // rest — it's a soft heads-up the agent can voice ("two more hard days and
  // you'll likely want a reset"). Null-safe: no baseline → no anticipation.
  const dl = rec?.delta ?? null;
  let recoveryDrift = 0; // count of signals pointing the wrong way vs the athlete's own norm
  // Judged against the athlete's OWN dispersion where the baseline window carried
  // enough of it (round W3.4, rule 1) — the same call the signal state makes with the
  // same two arguments, so the two layers keep agreeing about what "meaningfully off
  // the norm" means. Absent dispersion, these are the bars they always were.
  const trendBars = recoveryTrendBars(rec?.baseline, rec?.dispersion);
  // HRV running meaningfully below baseline is a fatigue tell.
  if (dl?.hrv != null && rec?.baseline?.hrv != null && rec.baseline.hrv > 0 && dl.hrv < -trendBars.hrv)
    recoveryDrift++;
  // Resting HR running above the athlete's own norm the same way.
  if (dl?.rhr != null && dl.rhr > trendBars.rhr) recoveryDrift++;
  // Sleep running short vs their norm.
  if (dl?.sleep != null && dl.sleep < -trendBars.sleep) recoveryDrift++;
  // Acute training load is a CURRENT number the coach reasons and speaks from, but
  // `getRecoverySummary` resolves it as "the newest non-null row in the last 14 days"
  // — so a watch that stopped syncing kept handing the prompt a fortnight-old load as
  // though it were today's. Past its bound it reads as absent, like every other
  // sensor datum here.
  const acuteLoadQuality = rec?.quality?.acute_load ?? rec?.recovery?.quality?.acute_load ?? null;
  const acuteLoad = sensorIsCurrent("training_load", acuteLoadQuality?.latest_date ?? null, d)
    ? (rec?.recovery?.acute_load ?? null)
    : null;
  // Readiness is a CURRENT decision signal only when its reading is dated the day
  // being read (isReadDayReadiness): a `d-1` row is that day's LAST sync — post-workout
  // on a training day — so at 04:00 it would speak yesterday's session as "this
  // morning". The multi-day average remains useful context, but can never force a
  // current recommendation (and a reading not dated today cannot either).
  const readinessQuality = rec?.quality?.training_readiness ?? rec?.recovery?.quality?.training_readiness ?? null;
  const readinessCurrent = rec?.recovery?.training_readiness ?? null;
  const readinessDate = readinessQuality?.latest_date ?? null;
  const readinessFresh = isReadDayReadiness(readinessDate, d);
  const lowReadiness = readinessFresh && readsLowReadiness(readinessCurrent);
  // The deeper band (owner ruling, 2026-08-28). Same reading, same freshness gate,
  // a different answer: `lowReadiness` earns the protective EASY read the signal
  // state already produces, this one earns REST. Both bands live in
  // readiness-bands.ts so read-adherence can ask the mirror question about
  // yesterday's divergence against the same numbers.
  const restGradeReadiness = readinessFresh && readsRestGradeReadiness(readinessCurrent);
  const readinessAverage = rec?.recovery?.avg_training_readiness ?? null;
  // Mounting fatigue: at least 2 straight training days AND recovery drifting the
  // wrong way (or readiness low) — i.e. heading toward a reset but not there yet.
  const buildingFatigue = consec >= 2 && (recoveryDrift >= 1 || lowReadiness);
  // A soft, plain-language anticipation note (never a verdict). Only when we're
  // building toward the rest trigger but the floor hasn't tripped it yet.
  const daysToLikelyReset = consec >= 3 ? 0 : Math.max(0, 3 - consec);
  const anticipateDeload = buildingFatigue && consec < 3;

  // What's already been logged for `d` — a lifting session (sets) or a real
  // activity (a run/ride/class). The Brief must reflect this: once you've moved
  // today it should acknowledge it, not keep suggesting a fresh session as if the
  // day were blank. A "real" activity clears a light bar (≥20 min or any logged
  // distance) so an incidental short walk doesn't suppress a genuinely-due day.
  const todaysActivities = db
    .prepare(`SELECT type, duration_min, distance_km FROM activities WHERE date = ? ORDER BY id DESC`)
    .all(d) as any[];
  const todaysSetCount = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM logged_sets l JOIN sessions s ON s.id = l.session_id WHERE s.date = ?`)
        .get(d) as any
    )?.n ?? 0
  );
  const bigActivity =
    todaysActivities.find((a) => (a.duration_min != null && Number(a.duration_min) >= 20) || a.distance_km != null) ||
    null;

  // Active lifestyle/context (injury, illness, travel, a late night) as of `d`. The
  // deterministic floor now READS it — an active injury isn't just prompt prose, it
  // biases the read (a caveat on the train branch, never a forced rest — you can
  // usually train around it). Null-safe; absent context changes nothing.
  const contextEvents = (() => {
    try {
      return planningContextEvents(d);
    } catch {
      return [];
    }
  })();
  const ctx = (() => {
    try {
      return activeContextEffect(d, contextEvents);
    } catch {
      return null;
    }
  })();
  const reduceItem = ctx?.active?.find((a) => a.reduce_load) ?? null;

  // HOW the athlete wears the sensor, and therefore what today's silence means.
  // Derived from the cadence Track C hangs off each recovery quality entry, so no
  // extra query and no second opinion about the same series. Null when the
  // recovery snapshot predates that field (a caller passing a hand-built
  // `recovery`), which leaves every downstream surface exactly where it is today.
  // The FIELD rides along because the words depend on it: the densest series is
  // routinely resting HR, and only the sleep series may be spoken of as a night.
  const recoveryCadenceEntry = dominantSensorCadenceEntry(rec?.quality ?? rec?.recovery?.quality ?? {});
  const recoveryAbsence = recoveryCadenceEntry
    ? wearAbsenceView(recoveryCadenceEntry.cadence, d, recoveryCadenceEntry.field)
    : null;
  // Absence prose describes a day with NOTHING to lean on, and was being written on
  // every day regardless — including days whose wearable data was driving the read,
  // where it contradicted the read beside it. Consumers all gate on
  // `has_recovery_data === false`, so it stayed off the screen; it is persisted into
  // the decision ledger either way, and nothing gates it there.
  const lacksBearingReading = !rec?.has_data;

  const signals = {
    // Active context the brain is accounting for (injury/illness/travel), or null.
    context: ctx?.any
      ? {
          reduce_load: !!ctx.reduce_load,
          expect_worse_sleep: !!ctx.expect_worse_sleep,
          transient_inflammation: !!ctx.transient_inflammation,
          active: ctx.active.map((a) => ({ title: a.title, kind: a.kind, reason: a.reason })).slice(0, 3),
        }
      : null,
    // Consecutive genuinely-LOADING (hard/moderate) days ending yesterday — a
    // recovery/easy day breaks the streak (it's earned rest, not stacked fatigue).
    consecutive_training_days: consec,
    // The athlete's standing posture, carried so the read's provenance says which
    // rules were even available this morning — and hashed into the input fingerprint,
    // so flipping the control regenerates the Brief instead of leaving yesterday's
    // rest warm on a morning it can no longer produce.
    training_drive: trainingDrive,
    // The last few days' actual load grade (hard/moderate/easy/none), so the read
    // reflects intensity, not just "did something get logged".
    recent_load: recentLoads,
    recovery_week: recoveryWeek,
    // Discipline-aware context (v35): what "training day" counts as, and the
    // endurance volume read when it applies. Strength athletes see discipline
    // 'strength' + a null volume block (today's behavior).
    discipline,
    endurance_volume: countsCardio ? { last_week_km: lastWeekKm, volume_spike: volumeSpike } : null,
    avg_sleep_min: avgSleepMin,
    low_sleep: lowSleep,
    checkin: checkin
      ? { energy: checkin.energy, sleep_feel: checkin.sleep_feel, soreness: checkin.soreness, mood: checkin.mood }
      : null,
    has_recovery_data: !!rec?.has_data,
    // The wear pattern behind that boolean, plus the ONE athlete-facing line each
    // surface says when today carries no reading. The WORDS are computed here
    // rather than in the PWA on purpose: they are a rotating variant set drawn
    // from the same vocabulary the rest of the read speaks (wear-pattern-voice.ts),
    // and a second copy in the client is precisely how "none synced yet" survived
    // in front of an athlete whose watch was working exactly as they use it.
    // Null when the recovery snapshot carries no cadence — every consumer falls
    // back to what it says today.
    recovery_cadence: recoveryAbsence
      ? {
          pattern: recoveryAbsence.pattern,
          shape: recoveryAbsence.shape,
          readings: recoveryAbsence.readings,
          window_days: recoveryAbsence.window_days,
          last_reading_date: recoveryAbsence.last_reading_date,
          last_reading_age_days: recoveryAbsence.age_days,
          median_gap_days: recoveryAbsence.median_gap_days,
          // A real, current habit rather than two readings left over from last
          // spring — the predicate a surface uses before deciding to stay quiet.
          working_episodic: isWorkingEpisodicPattern(recoveryAbsence),
          // Null on a day that HAS a bearing reading — there is no absence to word.
          absence_state: lacksBearingReading ? wearAbsenceRowState(recoveryAbsence, d) : null,
          absence_why: lacksBearingReading ? wearAbsenceWhy(recoveryAbsence, d) : null,
        }
      : null,
    // Last night's single-night sleep architecture + HRV (plain numbers + a calm
    // one-line `text`), so the Brief can speak to LAST NIGHT, not just the window.
    // null when the most recent night is too old to be "last night" (see above).
    last_night: lastNight,
    logged_today: {
      sets: todaysSetCount,
      activities: todaysActivities.map((a) => ({
        type: a.type,
        duration_min: a.duration_min,
        distance_km: a.distance_km,
      })),
    },
    // Predictive deload anticipation — a soft, forward-looking fatigue read.
    // anticipate_deload true ⇒ heading toward a reset (recovery drifting below the
    // athlete's own norm while training days stack up), but the rest floor hasn't
    // tripped yet. days_to_likely_reset is a gentle countdown, never a deadline.
    fatigue: {
      anticipate_deload: anticipateDeload,
      days_to_likely_reset: anticipateDeload ? daysToLikelyReset : null,
      recovery_drift_signals: recoveryDrift,
      acute_load: acuteLoad,
      low_readiness: lowReadiness,
      hrv_vs_norm: dl?.hrv ?? null,
      rhr_vs_norm: dl?.rhr ?? null,
      sleep_vs_norm: dl?.sleep ?? null,
      readiness: {
        current: readinessCurrent,
        current_date: readinessDate,
        // Only a read-day reading is "fresh" here: read-adherence trusts this snapshot
        // as the morning's readiness exactly when it says so.
        freshness: readinessFresh ? "fresh" : readinessDate ? "stale" : "missing",
        window_average: readinessAverage,
        sample_count: readinessQuality?.sample_count ?? null,
        window_days: readinessQuality?.window_days ?? null,
      },
    },
  };

  // Already trained today (a logged lifting session)? Then today reads as covered.
  const trainedToday = sessionDates.has(d);
  // …but a run is not the lifting. On a weekday the athlete lifts (stated, or observed
  // from the log), endurance alone leaves the plan day open, so it must not read as
  // "today's work is in" — a 25-minute easy run closed a stated Pull day that way.
  const liftDayStillOpen =
    !trainedToday &&
    !!bigActivity &&
    signalInput(() => liftDows(d).includes(new Date(`${d}T00:00:00Z`).getUTCDay()), false);
  if (liftDayStillOpen) (signals as any).lift_day_open_after = { activity: String(bigActivity.type || "activity") };

  // Pick a suggested plan day for the "train" case. This now starts with the
  // historical rotation but lets logged content, volume balance, and acute load
  // adapt the pick when another programmed day is clearly smarter.
  // Memoized, and DELIBERATELY SIDE-EFFECT-FREE: several rules ask, the selector
  // re-reads the plan, the recent anchors and the acute gate on every call — and,
  // critically, publishing `plan_selection` from here would put the selector's
  // churning provenance (last_session, scores) into the signals of reads that never
  // used to carry it, which is a fingerprint that moves on every logged set.
  let adaptivePick: ReturnType<typeof selectAdaptivePlanDay> | undefined;
  function adaptivePlanDay() {
    if (adaptivePick === undefined) adaptivePick = selectAdaptivePlanDay(d);
    return adaptivePick;
  }

  // Is today a RUN day with no lifting? Runs are never plan rows, so this is read off
  // the calendar and the rolling agenda, never the plan. The AGENDA is the truth for
  // which day actually carries the run: a stated "Saturday or Sunday" long run is
  // placed on one of the two, and the other is simply free. So a non-lifting weekday is
  // a run day when the agenda has an open run suggested for it (with no run days stated,
  // that is the only way in), or — with no agenda to ask — when it is a stated run
  // weekday. A pure question; memoized like the pick.
  // The intent carries this morning's call on a quality or long run (runDayIntensity,
  // via the agenda) — its kind and label are already the answer, `adjustment` the why.
  let runDayMemo: { kind: string; label: string; adjustment?: RunDayIntensity | null } | null | undefined;
  function calendarRunToday(): { kind: string; label: string; adjustment?: RunDayIntensity | null } | null {
    if (runDayMemo !== undefined) return runDayMemo;
    runDayMemo = null;
    const pick = adaptivePlanDay();
    if (!pick || pick.day_number != null || pick.day_type === "training") return runDayMemo;
    const agenda = signalInput(() => flexibleTrainingAgenda(d), null);
    if (agenda?.available) {
      const intent = agenda.intents.find((i) => i.status === "open" && i.suggested_date === d) ?? null;
      if (intent)
        runDayMemo = {
          kind: intent.kind,
          label: intent.label || RUN_KIND_LABELS[intent.kind] || "Run",
          adjustment: intent.adjustment ?? null,
        };
      return runDayMemo;
    }
    if (pick.day_type === "run") {
      const kind = String(pick.selection?.calendar?.run_kind ?? "any");
      runDayMemo = { kind, label: RUN_KIND_LABELS[kind] ?? "Run" };
    }
    return runDayMemo;
  }

  // Is today the week's REST day — a weekday that carries neither a lift nor a run
  // (plan days hold strength only, so the calendar and the agenda answer)? A pure
  // QUESTION — asked by rules that only need to step aside, so it publishes nothing.
  function templateRestDay(): boolean {
    const type = adaptivePlanDay()?.day_type;
    return (type === "rest" || type === "run") && !calendarRunToday();
  }

  // On a non-lifting weekday, WHICH calendar day it is — published whatever rule ends up
  // speaking, so the envelope's card and the today strength line agree with the agenda
  // even on a morning a protective floor wins the read (a stated "Saturday or Sunday"
  // long-run weekday the run did not land on is rest, not a run day). Asked only when the
  // (cheap) calendar read says today is not a lifting day.
  if (signalInput(() => calendarDayRead(d)?.kind ?? "lift", "lift") !== "lift") {
    (signals as any).calendar_day = calendarRunToday() ? "run" : "rest";
  }

  // The plan day there is a SESSION on. A rest day is deliberately not one: every
  // caller here treats null as "nothing is due today", which is precisely what a
  // programmed rest day means, and routing it through this one accessor is what
  // stops the read from opening the seam by accident — the look-ahead offers easy
  // movement instead of an invented session, and the easy→train outcome ladder,
  // which requires a real plan day to open, cannot open a rest day at all.
  function suggestedPlanDay(): {
    day_number: number;
    focus: string | null;
    selection?: Record<string, any>;
  } | null {
    const selected = adaptivePlanDay();
    // A calendar rest or run day has no plan day — nothing is due to lift.
    if (!selected || selected.day_number == null || selected.day_type !== "training") return null;
    // Published HERE and only here: the provenance belongs on the reads that are
    // actually pointing at a session.
    if (selected.selection) (signals as any).plan_selection = selected.selection;
    return { day_number: selected.day_number, focus: selected.focus, selection: selected.selection };
  }

  // Already trained today is a FACT, not a suggestion — and it takes PRECEDENCE over
  // the earned-rest rule. If today's logged work genuinely LOADED something (a hard/
  // moderate session OR a real run/ride — see dayLoad), the day is DONE: acknowledge the
  // work and frame the rest as recovery. Checking this FIRST is what stops two bugs:
  // (1) a hard push session mislabeled "EASY DAY", and (2) this morning's run being
  // shadowed by a "3 hard days → REST" call while a full session still sits below (the
  // "Rest today" vs planned-Pull contradiction). A light/none-load log (a short mobility
  // flush, or an easy spin a lifter doesn't count) stays soft and is handled lower down.
  // The grade + fact ride in `signals` for the agent regardless of which branch wins.
  const todayLoad = gradeDay(d, !!recoveryWeek);
  (signals as any).trained_today = trainedToday || !!bigActivity;
  (signals as any).today_load = todayLoad;
  const fuelProtection = underfuelingSnapshot ?? currentUnderfuelingRead(d);
  (signals as any).underfueling = fuelProtection;
  // Pace-aware protein state for `d` (behind / on_pace / met), so the Brief's FUEL
  // line speaks to where you'd EXPECT to be at this point in the day, not a raw
  // "grams remaining" that reads as a gap all morning. Rides in `signals` so the
  // cached row carries it AND the serve-time recheck can detect a stale bucket
  // (e.g. a lunch that moved behind→on_pace) and heal the prose. Null-safe: no
  // derivable target → no fuel key, exactly as before.
  try {
    const fuel = dayFuelState(d);
    if (fuel) {
      (signals as any).fuel = {
        bucket: fuel.bucket,
        protein_so_far_g: fuel.protein_so_far_g,
        target_g: fuel.target_g,
      };
    }
  } catch {
    /* fuel state is additive context only — never block the read */
  }
  // The fallback builds the SAME rich state getCoachContext does — see
  // dayPlanningSignalState. It used to pass only the handful of inputs already in
  // scope here, which left the athlete-facing read blind to joint pain, the
  // low-performance flag and a due deload while the coach prompt saw all three.
  const signalState =
    unifiedState ??
    dayPlanningSignalState(d, {
      recovery: rec,
      checkin,
      context: ctx,
      contextEvents,
      underfueling: fuelProtection,
      completedToday: (trainedToday || !!bigActivity) && (todayLoad === "hard" || todayLoad === "moderate"),
    });
  (signals as any).signal_state = signalState;
  // What tomorrow already holds, published whichever rule ends up winning today. It is
  // a FACT about the calendar, not a property of the read, so — like the health
  // work-around probe below — it is derived once here rather than inside the one rule
  // that acts on it: the cached row, the coach prompt and the decision ledger all carry
  // it even on a morning where a short night or a logged session decides the day.
  const holdsTomorrow: TomorrowHold[] = signalInput(() => tomorrowHolds(d, contextEvents), []);
  if (holdsTomorrow.length) (signals as any).tomorrow_holds = holdsTomorrow;
  // …and what already holds TODAY (the athlete's claims_day, or a lab draw whose
  // morning belongs to the needle) — published on the same terms, whichever rule wins.
  const holdsToday: TodayHold[] = signalInput(() => todayHolds(d, contextEvents), []);
  if (holdsToday.length) (signals as any).today_holds = holdsToday;
  // A movement work-around is a fact about the ATHLETE, not a property of whichever
  // rule wins the morning, so it is probed once here rather than inside a rule. It
  // used to live inside the protect rule below — so the day a corroborated short
  // night preempted that rule (the two co-occur constantly, since health constraints
  // are what drive the protect posture in the first place) the injury went unnamed,
  // and `applyContinuityVoice`, which branches on this signal, then SUBSTITUTED its
  // escalation for the read: an injured athlete on their third quiet day was told
  // ten easy minutes on their feet was plenty, with no guardrail at all.
  //
  // The probe is on the DIMENSION, not one field name. It used to match
  // `field === "active_injury"` alone, so an illness or any other health constraint —
  // an equal safety_override, and the very thing driving the rest posture — never set
  // this signal at all: the guarded continuity escalation below was withheld, and on
  // the third quiet day of a head cold the Brief REPLACED the illness guidance with
  // "a gentle walk today would do more for you than another full stop". Every
  // constraint in this dimension is by definition something to work around, so the
  // guard follows the dimension and the next field added there is covered on arrival.
  // The item's own `field`/`voice` still ride along, so the sentence names the right
  // thing; an injury keeps precedence when several are live because it is the most
  // specific movement work-around.
  const freshHealthConstraints = signalState.dimensions.health_constraints.evidence.filter(
    (item) => item.direction === "constraint" && item.freshness !== "stale"
  );
  const healthWorkaround =
    freshHealthConstraints.find((item) => item.field === "active_injury") ?? freshHealthConstraints[0] ?? null;
  if (healthWorkaround) {
    (signals as any).health_workaround = { field: healthWorkaround.field, reason: healthWorkaround.summary };
  }
  // Hybrid runner+lifter sequencing (one additive signal entry). Purely informational —
  // it NEVER changes the kind decision or adds an interruption; the agentic layer voices
  // it warmly when it fits. Omitted entirely when nothing sequences, so existing reads are
  // byte-for-byte unchanged. Null-safe: any failure leaves it off.
  try {
    // Template projection first; flexible agenda overrides planned_run_next so protect_run_next
    // tracks movable key runs (quality/long) instead of fixed day_number weekdays.
    const hc = withFlexibleRunLookahead(hybridDayContext(d), d);
    const tomorrow = new Date(new Date(`${d}T00:00:00Z`).getTime() + 864e5).toISOString().slice(0, 10);
    const protectRunNext = !!(
      hc.planned_run_next &&
      hc.planned_run_next.kind !== "easy" &&
      hc.planned_run_next.date === tomorrow
    );
    if (hc.cardio_today || hc.hard_cardio_yesterday || protectRunNext) {
      (signals as any).hybrid = {
        cardio_today: !!hc.cardio_today,
        hard_cardio_yesterday: !!hc.hard_cardio_yesterday,
        protect_run_next: protectRunNext,
      };
    }
  } catch {
    /* hybrid sequencing is additive context only — never block the read */
  }
  // What the Brief has already been telling them. Rides in `signals` (so the cached
  // row carries it and the agentic layer can see its own recent output) and drives
  // the continuity voice below. Deliberately NOT part of the decision fingerprint:
  // it changes the words, never the posture, so it must not churn a warm read.
  const continuity = dayReadContinuity(d);
  (signals as any).continuity = continuity;
  // …and how those reads actually WENT. The continuity above is what the Brief said;
  // this is what the athlete did with it and whether it cost them. Nothing else in the
  // deterministic floor looks past today's inputs, which is how a stable picture came
  // to suggest rest for eleven mornings running while the athlete trained through six
  // of them and rated those sessions well — every one of those disagreements was
  // already recorded, reconciled and then never read back.
  //
  // Bounded on purpose: a 12-day model rather than the coach context's 42, because the
  // softening window is ten closed days and the model costs two queries per day it
  // covers. Memoized per (date, request) like the other expensive producers, and
  // fail-soft — an audit-table outage degrades to "no softening", never to no Brief.
  const outcomeFeedback: RestOverrideSoftening | null = signalInput(
    () =>
      brainSignal(`rest_override_softening:${d}`, () =>
        restOverrideSoftening(readAdherenceModel(d, OUTCOME_SOFTENING_WINDOW_DAYS + 2), d)
      ),
    null
  );
  // Published here so the rules below can see the evidence, and REPUBLISHED once the
  // rules have resolved with `applied` — whether the softening actually fired — added.
  if (outcomeFeedback) (signals as any).outcome_feedback = { ...outcomeFeedback, applied: false };
  // The same evidence one rung up: easy mornings that became real sessions. Derived
  // from the SAME model instance rather than a second read of the ledger — two windows
  // over the same days that could disagree about which days they cover is the drift
  // this file keeps paying for elsewhere. Same memo, same fail-soft contract.
  const easyFeedback: EasyOverrideSoftening | null = signalInput(
    () =>
      brainSignal(`easy_override_softening:${d}`, () =>
        easyOverrideSoftening(readAdherenceModel(d, OUTCOME_SOFTENING_WINDOW_DAYS + 2), d)
      ),
    null
  );
  if (easyFeedback) (signals as any).easy_outcome_feedback = { ...easyFeedback, applied: false };
  // ---- what YESTERDAY's endurance says about today (owner ruling, 2026-08-28) ----
  // Two facts, both about the day before, both deliberately narrow:
  //   • hard cardio yesterday — asked through `hardCardioDay`, the one source of truth
  //     for that grade, with the cardio-load median this read already computed.
  //   • a FIRST — the longest run in ninety days (`longestRunNovelty`). Neither
  //     `hardCardioDay` (which ignores distance on purpose) nor the weekly-mileage
  //     spike (a week-shaped argument) can see one very long single effort.
  // They never brake a day by themselves. They corroborate a run of loading days, they
  // ride in `signals` so the agent prompt sees them, and they keep the outcome ladder
  // from opening ANOTHER run tomorrow (see the softening guard below).
  const yesterdayIso = addDaysISO(d, -1);
  const hardCardioYesterday = !!yesterdayIso && signalInput(() => hardCardioDay(yesterdayIso, cardioLoadMedian), false);
  const runNoveltyYesterday: LongestRunNovelty | null = yesterdayIso
    ? signalInput(() => longestRunNovelty(yesterdayIso), null)
    : null;
  if (hardCardioYesterday || runNoveltyYesterday) {
    (signals as any).endurance_yesterday = {
      hard_cardio: hardCardioYesterday,
      ...(runNoveltyYesterday
        ? {
            longest_run: {
              distance_km: runNoveltyYesterday.distance_km,
              previous_longest_km: runNoveltyYesterday.previous_longest_km,
              lookback_days: runNoveltyYesterday.lookback_days,
            },
          }
        : {}),
    };
  }
  // The rhythm-driven rest: genuinely-loading days stacking up outside a reduced week.
  // Hoisted out of the earned-rest rule because the training-drive rule directly above
  // it answers THIS trigger and no other, and two copies of the condition is how the
  // two would eventually come to disagree about which day they are talking about.
  //
  // The count itself is a CAVEAT. `accumulated_load_rest` as REST may fire only when
  // this rhythm is corroborated by a current signal — never from the calendar alone.
  const stackedLoadingRest = consec >= 3 && !recoveryWeek;
  const atHardCeiling = stackedLoadingRest && consec >= PUSH_DRIVE_CONSEC_CEILING;
  const recoveryCapacity = signalState.dimensions.recovery_capacity;
  // The brake is a CURRENT caution, not a watch status beside some fresh support: a
  // wearable caution kept only as context (a reading older than last night) never counts.
  const recoveryCapacityFreshBrake =
    (recoveryCapacity.status === "constrained" || recoveryCapacity.status === "watch") &&
    recoveryCapacity.evidence.some(
      (item) =>
        (item.freshness === "fresh" || item.freshness === "recent") &&
        (item.direction === "caution" || item.direction === "constraint") &&
        item.advice_only !== true
    );
  const tomorrowClinical = holdsTomorrow.some((hold) => hold.clinical === true);
  const stackedLoadCorroborated =
    lowReadiness ||
    // A first — the longest run in months, done yesterday — is a CURRENT fact about
    // the last twenty-four hours, which is exactly what the caveat law asks for
    // before a run of days may read as rest. Hard cardio alone is not enough: that
    // already counts toward the run of days, and counting it twice would turn the
    // calendar back into a brake of its own.
    !!runNoveltyYesterday ||
    lowSubjective ||
    yesterdayRecoveryOverdose ||
    // A rest is a DECISION, so only a brake that may decide corroborates one — fueling
    // advice after a long run (an advisory brake) does not.
    hasFreshDecidingBrake(signalState.dimensions) ||
    recoveryCapacityFreshBrake ||
    clinicallyDriven(signalState, healthWorkaround) ||
    tomorrowClinical;
  // Push-drive / reach corroboration: recovery_capacity already supportive at
  // high confidence, with fresh HRV / resting HR / sleep on the board. Absence
  // of any of those three is absence, and silence is never corroboration.
  const freshHrvRhrSleep = ["hrv", "resting_hr", "sleep"].every((field) =>
    recoveryCapacity.evidence.some((item) => item.field === field && item.freshness !== "stale")
  );
  // A commitment on the calendar compresses the training window (see the planned-
  // training rule below for the split between a commitment and a thin stretch, and
  // for the caveat each one pushes). Hoisted because BOTH train-shaped rules answer
  // to it: the drive read is a shorter, narrower day, not an exemption from the
  // athlete's actual afternoon.
  const schedulePressure =
    signalState.action.posture === "train" && signalState.action.directives.schedule === "compress";
  const commitmentPressure = schedulePressure && lifeCapacityIsCommitment(signalState);
  const rules: DayReadRule[] = [
    {
      resolve: () => {
        if (!((trainedToday || (bigActivity && !liftDayStillOpen)) && (todayLoad === "hard" || todayLoad === "moderate")))
          return null;
        // Name the work for the deterministic `why` (the floor when the agent's offline).
        // A logged lifting session reads as "session"; otherwise name the activity (run/
        // ride). When BOTH happened, "session" wins so the lift isn't erased by the run.
        const label = trainedToday
          ? "session"
          : bigActivity && bigActivity.type && bigActivity.type !== "other"
            ? String(bigActivity.type)
            : "session";
        return {
          outcome: DAY_READ_OUTCOMES.logged_loading_work_today,
          read: {
            kind: "done",
            focus: null,
            why: pickDayVariant(DONE_WHY, d, "logged_loading_work_today")(label),
            est_minutes: null,
            signals,
          },
        };
      },
    },
    {
      resolve: () => {
        if (!corroboratedLowSleep) return null;
        return {
          outcome: DAY_READ_OUTCOMES.acute_sleep_corroborated,
          read: {
            kind: "rest",
            focus: null,
            why: pickDayVariant(ACUTE_SLEEP_WHY, d, "acute_sleep_corroborated"),
            est_minutes: null,
            signals,
          },
        };
      },
    },
    {
      // ---- a rest-grade reading IS rest (owner ruling, 2026-08-28) ----
      // Above the protect rule ON PURPOSE, and this ordering is the whole rule. Below
      // it, a reading in the deep band reaches the athlete as the protect rule's EASY
      // day: the signal state rates anything under LOW_READINESS as a recovery
      // constraint and the posture resolves to easy, so a reading of 1/100 and a
      // reading of 34/100 produced the identical morning. They are not the identical
      // morning. Above the protect rule the deep band gets its own read, its own code
      // and its own words — and the shallow band keeps the easy day it always had.
      //
      // Freshness is the same gate as everywhere else: a reading too old to speak for
      // today behaves as absent (sensor-freshness), so a watch left in a drawer never
      // manufactures a rest day.
      resolve: () => {
        if (!restGradeReadiness) return null;
        return {
          outcome: DAY_READ_OUTCOMES.rest_grade_readiness,
          read: {
            kind: "rest",
            focus: null,
            why: pickDayVariant(REST_GRADE_READINESS_WHY, d, "rest_grade_readiness"),
            est_minutes: null,
            signals,
          },
        };
      },
    },
    {
      resolve: () => {
        if (signalState.action.posture !== "rest" && signalState.action.posture !== "easy") return null;
        // The injury caveat is NOT appended here: it belongs to every protective read,
        // not just this one (see the probe above and the guardrail below).
        //
        // The `why` comes from the winning evidence's ATHLETE voice, never its
        // `summary`. The summary is an observer's note written about the athlete in
        // the third person ("The athlete feels poorly recovered…") and it was being
        // printed to them as the Brief's headline — one fixed sentence per signal, so
        // the most common rest path repeated itself verbatim every morning a stable
        // check-in fired the same branch. The set rotates by calendar day like every
        // other rule; `summary` stays exactly as it is for coaches and machines.
        return {
          outcome: DAY_READ_OUTCOMES.acute_signal_protection,
          read: {
            kind: signalState.action.posture,
            focus: null,
            why: spokenSignalVoice(signalState.action.voice, d, SIGNAL_VOICE_KEYS.protect),
            est_minutes: signalState.action.posture === "easy" ? 20 : null,
            signals,
          },
        };
      },
    },
    {
      // ---- the training drive, answering the accumulated-load rest ----
      // The ONE rest the athlete's standing preference may answer, and it sits here —
      // directly above the rule that would otherwise produce it, and BELOW the done,
      // corroborated-short-night and protect rules — so the ordering itself is the
      // guarantee: a fact, a fresh short night and a protective posture all reach the
      // athlete before the preference is ever consulted.
      //
      // The preference sets the POSTURE; the evidence still decides the day. Six
      // conditions, and the read is withheld unless every one of them holds:
      //   1. the athlete asked for it,
      //   2. the rest in question is the RHYTHM one (stacked days) and nothing else in
      //      the earned-rest branch is also true — a dose overrun, a run-down check-in
      //      or a low readiness reading each keeps its rest, because those are signals
      //      about today rather than a pattern about the week,
      //   3. the run of days is under the hard ceiling,
      //   4. nothing clinical is in play, by the same three-way probe the outcome
      //      softening uses,
      //   5. the evidence is positively green — the backed tier (earned from the
      //      athlete's own rated sessions), a fresh readiness reading at or above
      //      PUSH_DRIVE_READINESS_FLOOR over last night's own sleep (or, while today's
      //      readiness has not synced, last night's supportive HRV), OR recovery_capacity
      //      already `supportive` at `confidence: "high"` with fresh HRV, resting HR
      //      and sleep on the board. Absence of those three is absence; silence is
      //      never corroboration. Every path still requires nothing fresh pulling
      //      the other way anywhere in the state (the same brake question the
      //      backed tier asks itself, asked through the same predicate),
      //   6. and there is actually something DUE, after the acute gate has removed the
      //      groups still carrying yesterday's work.
      // Miss any of them and this returns null. Uncorroborated stacked days then
      // fall through to the train/easy read with a stacked-days caveat; corroborated
      // ones still rest; the ceiling with supportive recovery reads easy.
      resolve: () => {
        if (trainingDrive !== "push") return null;
        if (!stackedLoadingRest) return null;
        // …and it may never answer the week's OWN rest day (2026-08-28). The stacked-
        // days rest and the programmed rest day are different objects: the first is a
        // read arguing from a pattern, which a standing preference plus green evidence
        // may fairly answer, and the second is structure the athlete built on purpose.
        // A preference that can delete the template's one seam is how a seven-day week
        // ends up with no rest in it again. They can still train anyway; nothing here
        // blocks a thing.
        if (templateRestDay()) return null;
        if (yesterdayRecoveryOverdose || lowSubjective || lowReadiness) return null;
        if (consec >= PUSH_DRIVE_CONSEC_CEILING) return null;
        if (clinicallyDriven(signalState, healthWorkaround)) return null;
        const backed = signalState.action.support?.level === "backed";
        const solidReadiness =
          readinessFresh && readinessCurrent != null && Number(readinessCurrent) >= PUSH_DRIVE_READINESS_FLOOR;
        // Last night has to be PRESENT, be LAST NIGHT, and not be short. `lastNight`
        // already carries the one-night bound, and this path restates it through the
        // same constant: the wearable path is the one that can open a training day
        // with no rated session behind it, so an absent or older night reads as
        // absent and the path simply does not open — silence is never corroboration.
        const sleptEnough =
          isLastNight(lastNight?.date ?? null, d) &&
          lastNight?.total_min != null &&
          Number(lastNight.total_min) >= 360;
        // The wearable path has no brake check of its own to inherit — the `backed`
        // tier refuses to exist while any fresh caution or constraint is on the board,
        // but readiness-plus-sleep is only two fields and knows nothing about the other
        // seven dimensions. Without this, a morning carrying a fresh routine disruption
        // AND fresh schedule pressure still handed out the training day. Same predicate
        // the tier uses, so the two answers cannot drift.
        // The 04:00 floor reads before the watch has synced THIS morning's readiness, and
        // a `d-1` row is yesterday's post-workout number that never speaks for today
        // (isReadDayReadiness). While today's reading is still pending — and only then;
        // a synced reading below the floor still says no — last night's own HRV may
        // stand in for it beside last night's sleep: a night dated the read day,
        // Garmin's own status `balanced`, or no status and the value inside the
        // athlete's norm band. Absent either, nothing vouches.
        const overnightPath = !readinessFresh && lastNightHrvSupports(rec, d, trendBars.hrv);
        const wearablePath =
          (solidReadiness || overnightPath) && sleptEnough && !hasFreshBrake(signalState.dimensions);
        // Same helper the envelope's reach resolver uses, so a morning that
        // corroborates the drive read also backs a reach, and a morning that
        // does not cannot back one either. Last night still has to be present
        // and not short — the HRV/RHR/sleep trio can be recent-but-not-last-
        // night, and a short night of their own is a signal about today.
        const capacityPath = supportiveCapacityBacksDay({
          status: recoveryCapacity.status,
          confidence: recoveryCapacity.confidence,
          freshHrv: freshHrvRhrSleep,
          freshRestingHr: freshHrvRhrSleep,
          freshSleep: freshHrvRhrSleep,
          sleptEnough,
          freshBrake: hasFreshBrake(signalState.dimensions),
          trainingDirective: signalState.action.directives.training,
        });
        if (!(backed || wearablePath || capacityPath)) return null;
        // The same acute gate every other "what's due" surface reads, so this day can
        // never open by naming a group that is still flattened from yesterday. Wrapped
        // like its sibling call sites: no balance ⇒ no due groups ⇒ no drive read.
        let due: string[] = [];
        try {
          const bal: any = programBalance(2, d);
          due = suppressSaturatedDue(Array.isArray(bal?.due) ? bal.due : [], d).slice(0, 2);
        } catch {
          due = [];
        }
        if (!due.length) return null;
        // EVERY rendering of the groups goes through the canon folding, with no raw
        // fallback behind it: `plainGroupWords` returns null only when nothing in the
        // list folds to athlete-facing words, and a due list we cannot say out loud is
        // the same absence as no due list at all. Joining the raw keys instead would
        // put "rear_delts" in the headline, the why and the focus at once.
        const groups = plainGroupWords(due, 2);
        if (!groups) return null;
        (signals as any).training_drive_push = {
          due,
          backed_by: backed ? "logged_sessions" : !solidReadiness && overnightPath ? "overnight_reading" : "recovery_reading",
        };
        return {
          outcome: DAY_READ_OUTCOMES.push_drive_targeted_training,
          read: {
            kind: "train" as const,
            focus: groups.charAt(0).toUpperCase() + groups.slice(1),
            why: pickDayVariant(PUSH_DRIVE_WHY, d, "push_drive_targeted_training")(groups),
            // The same clock the ordinary train rule keeps: a commitment on the
            // calendar compresses the window there, and a targeted day is no less
            // subject to the athlete's actual afternoon than a planned one is.
            est_minutes: commitmentPressure ? 40 : 60,
            signals,
          },
        };
      },
    },
    {
      // ---- the same-day hold: the calendar already owns TODAY ----
      // The companion to the look-ahead below, born of the same incident's second act:
      // the appointment that was invisible one day out was still only half-visible on
      // its own morning. A today-active event raised schedule pressure (a directive
      // about the WINDOW) but nothing about the day's KIND or its SEQUENCE, so a
      // morning lab draw read as an ordinary training day with no word about the draw
      // — and the athlete's own `claims_day`, honored one day out by the look-ahead,
      // went unread on the very day it named.
      //
      // Two arms, in order of the athlete's word:
      //   • CLAIMED: they said outright this day is taken. The read accepts it as the
      //     rest it is — their word is itself a signal about the athlete, so it yields
      //     only to reality (work already logged today; the done/light rules own a
      //     moved day). Rest is the floor's safest read; there is nothing to gate.
      //   • LAB DRAW: not a claim on the day but on its SEQUENCE — movement belongs
      //     after the needle, so the day leans easy around it. This arm OPENS a day
      //     shape rather than closing one, so like the look-ahead it steps aside for
      //     every rest grounded in a signal about the athlete: a dose overrun, a
      //     run-down check-in, a low reading and anything clinical each keep their own
      //     rest and their own why (all compatible with a draw morning anyway). It
      //     deliberately does NOT step aside for the discretionary rhythm rest — an
      //     easy day placed after the draw is that same break with the appointment
      //     named, which is the correlation this rule exists to say out loud.
      // It does not gate on hasFreshBrake: the hold's own schedule-pressure caution
      // IS a fresh brake, and a rule vetoed by the very event it answers to would
      // never fire at all. The explicit gates above are the brake checks it keeps.
      resolve: () => {
        if (!holdsToday.length) return null;
        if (trainedToday || bigActivity) return null;
        const claimed = holdsToday.find((hold) => hold.claims_day);
        if (claimed) {
          // A claim the athlete wrote about THEMSELVES — the rest they traded forward
          // when they trained through a quiet morning — is the same hold with a
          // different author, and it gets its own words rather than being told an
          // appointment owns their day.
          const traded = eventIsRestTrade(contextEvents, claimed.id);
          (signals as any).same_day_hold = { hold: claimed, shape: traded ? "traded" : "claimed" };
          return {
            outcome: traded ? DAY_READ_OUTCOMES.day_traded_rest : DAY_READ_OUTCOMES.day_claimed_rest,
            read: {
              kind: "rest" as const,
              focus: null,
              why: traded
                ? pickDayVariant(DAY_TRADED_WHY, d, "day_traded_rest")
                : pickDayVariant(DAY_CLAIMED_WHY, d, "day_claimed_rest"),
              est_minutes: null,
              signals,
            },
          };
        }
        if (yesterdayRecoveryOverdose || lowSubjective || lowReadiness) return null;
        if (clinicallyDriven(signalState, healthWorkaround)) return null;
        const lab = holdsToday.find((hold) => hold.lab_draw);
        if (!lab) return null;
        (signals as any).same_day_hold = { hold: lab, shape: "lab_draw" };
        return {
          outcome: DAY_READ_OUTCOMES.lab_draw_morning,
          read: {
            kind: "easy" as const,
            focus: null,
            why: pickDayVariant(LAB_DRAW_WHY, d, "lab_draw_morning"),
            // The look-ahead's bare-day clock: the offer is an easy turn after the
            // draw, never a session the appointment then has to fit around.
            est_minutes: 25,
            signals,
          },
        };
      },
    },
    {
      // ---- the look-ahead, RE-TIMING the accumulated-load rest ----
      // The only rule in this file that looks past today, and it looks exactly one day.
      //
      // The incident: a bloodwork appointment tomorrow, an athlete who wanted to train
      // today and rest tomorrow, and a Brief that suggested rest today because it could
      // not see the appointment at all. The agent prompt has always had the row —
      // getCoachContext lists active events with no date filter — but the deterministic
      // floor read context events through two filters that both drop anything starting
      // in the future, so the layer that decides the KIND was the one layer blind to it.
      //
      // What this rule may do is deliberately small: it re-times a rest the athlete was
      // going to get anyway, and it hands back an EASY day in exchange. What it may
      // never do is manufacture capacity. So it sits BELOW every rule that answers to a
      // signal about the athlete — the logged session, the corroborated short night, the
      // protective posture, the training drive — and its gate is the rhythm rest and
      // nothing else:
      //   1. tomorrow holds something that plausibly claims the day (`blocks_training`,
      //      resolved once in `tomorrowHolds` — never an injury row or anything that
      //      reads as an illness, both clinical shapes carried for visibility only),
      //   2. today is still OPEN. The done rule above only claims a day whose work
      //      graded hard or moderate, so a mobility session or a short shakeout logged
      //      this morning fell straight through it and landed here — and this rule
      //      would then offer a second session on top of the one already done. It may
      //      re-time a rest; it may never add work to a day that has already had some,
      //   3. the rest today would be the RHYTHM one (stacked loading days) — the same
      //      one shape of rest the push drive above may answer,
      //   4. and nothing else in the earned-rest branch is also true: a dose overrun, a
      //      run-down check-in and a low readiness reading each keep their rest, because
      //      those are signals about today that a calendar cannot re-time,
      //   5. under the same hard ceiling on consecutive days the drive read respects,
      //   6. with nothing clinical in play, by the same three-way probe,
      //   7. and no fresh brake anywhere in the state — this path opens a day on the
      //      strength of an absence rather than on positive evidence, so it inherits
      //      the strictest of the brake checks rather than the loosest.
      // A rest grounded in safety — symptoms, illness, a short night, a low reading —
      // never reaches this rule at all: (2) and (3) exclude it, and the protective rules
      // above have already won the day before it is consulted.
      resolve: () => {
        const blocking = holdsTomorrow.filter((hold) => hold.blocks_training);
        if (!blocking.length) return null;
        if (trainedToday || bigActivity) return null;
        // There is nothing to RE-TIME on the week's programmed rest day: the session
        // this rule reaches forward for is not due today in the first place. Stepping
        // aside leaves the rest read to say what today actually is.
        if (templateRestDay()) return null;
        if (!stackedLoadingRest) return null;
        if (yesterdayRecoveryOverdose || lowSubjective || lowReadiness) return null;
        if (consec >= PUSH_DRIVE_CONSEC_CEILING) return null;
        if (clinicallyDriven(signalState, healthWorkaround)) return null;
        if (hasFreshBrake(signalState.dimensions)) return null;
        // A due plan day gives the read a focus and a compressed clock; with nothing
        // programmed the day still opens, as easy movement rather than a session that
        // does not exist. Either way the words are the same — the calendar is the
        // reason in both branches — and either way the effort offered is easy.
        const planDay = suggestedPlanDay();
        (signals as any).lookahead_retimed = {
          holds: blocking,
          consecutive_days: consec,
          opened: planDay ? "plan_day" : "easy_movement",
        };
        return {
          outcome: DAY_READ_OUTCOMES.lookahead_retimed_training,
          read: {
            kind: (planDay ? "train" : "easy") as "train" | "easy",
            focus: planDay?.focus ?? null,
            why: pickDayVariant(LOOKAHEAD_RETIME_WHY, d, "lookahead_retimed_training"),
            // Shorter than the ordinary train day's 60 on purpose: this is a day
            // reached for inside a run of loading days, so the offer is a comfortable
            // session, not a full one. It carries no further clamp for a commitment
            // squeezing today — schedule_pressure is brake evidence, and a fresh brake
            // anywhere in the state has already turned this rule away above.
            est_minutes: planDay ? 40 : 25,
            signals,
          },
        };
      },
    },
    {
      resolve: () => {
        // Earned rest comes from an acute recovery signal (short sleep / a run-down
        // check-in / a recovery-week dose overrun), or from stacked loading days that
        // a CURRENT signal corroborates. A consecutive-day count is never a brake of
        // its own — uncorroborated stacked days fall through and ride as a caveat on
        // the train/easy read below (STACKED_DAYS_CAVEAT), the same pattern as a
        // weekly-mileage spike. A recovery week is already the periodized answer to
        // accumulated load. Pre-deload hard days cannot turn every reduced session
        // into another rest day; acute safety signals and actual dose overruns
        // retain full authority.
        //
        // At the hard-day ceiling with nothing corroborating, the read is easy under
        // the same accumulated_load_rest code — not rest, and not another train day
        // the drive preference can keep opening.
        const stackedRest = stackedLoadingRest && stackedLoadCorroborated;
        const stackedCeilingEasy = stackedLoadingRest && atHardCeiling && !stackedLoadCorroborated;
        if (!(yesterdayRecoveryOverdose || stackedRest || stackedCeilingEasy || lowSubjective || lowReadiness))
          return null;
        // Each branch reports the outcome that matches its own words. Before the
        // reason moved onto the rule, a low check-in or a low readiness reading was
        // filed under "accumulated load" and explained as stacked training days the
        // athlete may not have done.
        //
        // The two subjective branches are SHADOWED on the production path and live
        // off it, which is the same fact SOFTENABLE_REST_CODES above is written
        // against: when the signal state is built from the same DB this rule reads,
        // a low check-in and a subdued readiness reading both reach the unified
        // protect rule first and ship as `acute_signal_protection`. They still fire
        // for a caller that SCOPES the state through `dayRead`'s `unifiedState`
        // argument — the one documented way the two inputs can diverge — so the
        // labels here are live code, not a hedge against a future reorder.
        if (yesterdayRecoveryOverdose) {
          return {
            outcome: DAY_READ_OUTCOMES.recovery_dose_overrun,
            read: {
              kind: "rest",
              focus: null,
              why: pickDayVariant(DOSE_OVERRUN_WHY, d, "recovery_dose_overrun"),
              est_minutes: null,
              signals,
            },
          };
        }
        if (stackedRest) {
          return {
            outcome: DAY_READ_OUTCOMES.accumulated_load_rest,
            read: {
              kind: "rest",
              focus: null,
              why: pickDayVariant(STACKED_LOAD_WHY, d, "accumulated_load_rest"),
              est_minutes: null,
              signals,
            },
          };
        }
        if (stackedCeilingEasy) {
          return {
            outcome: DAY_READ_OUTCOMES.accumulated_load_rest,
            read: {
              kind: "easy",
              focus: null,
              why: pickDayVariant(STACKED_LOAD_CEILING_WHY, d, "accumulated_load_rest"),
              est_minutes: 25,
              signals,
            },
          };
        }
        if (lowReadiness) {
          return {
            outcome: DAY_READ_OUTCOMES.low_readiness_rest,
            read: {
              kind: "rest",
              focus: null,
              why: pickDayVariant(LOW_READINESS_WHY, d, "low_readiness_rest"),
              est_minutes: null,
              signals,
            },
          };
        }
        return {
          outcome: DAY_READ_OUTCOMES.felt_run_down_rest,
          read: {
            kind: "rest",
            focus: null,
            why: pickDayVariant(RUN_DOWN_WHY, d, "felt_run_down_rest"),
            est_minutes: null,
            signals,
          },
        };
      },
    },
    {
      resolve: () => {
        // An easy/light effort already done today (a short walk, a recovery spin a lifter
        // doesn't count as their real work) — acknowledge it without telling them to rest.
        if (!(trainedToday || bigActivity)) return null;
        return {
          outcome: DAY_READ_OUTCOMES.logged_light_work_today,
          read: {
            kind: "easy",
            focus: null,
            why: pickDayVariant(LIGHT_WORK_WHY, d, "logged_light_work_today"),
            est_minutes: 20,
            signals,
          },
        };
      },
    },
    {
      // ---- the week's own rest day ----
      // Placed HERE, and the position is the whole ruling. Above it sit every floor
      // that has a reason of its own to rest — a fact already logged today, a short
      // night, a protective posture, a dose overrun, a low reading, a run-down check-in
      // — and each keeps its own words, because "you slept four hours" is a truer
      // sentence than "it's your rest day" even when both are true and the answer is
      // the same. Below it sits the planned-training rule, which is exactly what this
      // one exists to stand in front of.
      //
      // Nothing here gates anything. It is the calmest read in the file: the athlete
      // wrote a rest day into their own week, and today is that day.
      resolve: () => {
        if (!templateRestDay()) return null;
        const pick = adaptivePlanDay();
        (signals as any).template_rest_day = {
          day_number: pick?.day_number ?? null,
          focus: pick?.focus ?? null,
          calendar: true,
        };
        return {
          outcome: DAY_READ_OUTCOMES.template_rest_day,
          read: {
            kind: "rest" as const,
            // No focus: there is no session to name, and putting the rest day's own
            // label ("Rest") in the focus slot would render as a thing to go and do.
            focus: null,
            why: pickDayVariant(TEMPLATE_REST_DAY_WHY, d, "template_rest_day"),
            est_minutes: null,
            signals,
          },
        };
      },
    },
    {
      resolve: () => {
        // A genuine mileage spike WHILE actively stacking loading days earns an easier
        // day (not a forced rest) so the running absorbs. Gated on consec>=1: if
        // yesterday was already a recovery/easy day, the spike has been answered — don't
        // stack easy on easy, let them train (the spike still rides as a caveat below).
        if (!(volumeSpike && consec >= 1)) return null;
        return {
          outcome: DAY_READ_OUTCOMES.endurance_volume_spike,
          read: {
            kind: "easy",
            focus: null,
            why: pickDayVariant(VOLUME_SPIKE_WHY, d, "endurance_volume_spike"),
            est_minutes: 25,
            signals,
          },
        };
      },
    },
    {
      // ---- the week's own run day ----
      // A stated run weekday with no lifting on it. Placed just above the planned-
      // training rule for the same reason the rest day is: every floor with a reason of
      // its own speaks first, and keeps its own words — a short night still reads as a
      // short night. The run itself (distance, effort) is the Endurance plan's; the read
      // names the day. An easy run day reads easy; a quality, long or unkinded one reads
      // as the day's training. Still a suggestion — the athlete drives.
      resolve: () => {
        const runDay = calendarRunToday();
        if (!runDay) return null;
        // A quality or long run is re-decided THIS morning (runDayIntensity): the kind
        // and label are already the answer, and its own sentence says why. A long run a
        // floor shortened reads easy — it is still the day's run, taken gently. The
        // decision rides in `signals` (machine register) and the focus label, so a
        // changed call is a new prose identity and an unchanged one never churns.
        const adj = runDay.adjustment ?? null;
        (signals as any).stated_run_day = {
          run_kind: runDay.kind,
          ...(adj
            ? {
                planned_kind: adj.planned_kind,
                dose: adj.dose,
                reason_code: adj.reason_code,
                changed: adj.changed,
              }
            : {}),
        };
        const floorShortened = adj?.kind === "long" && adj.dose === "shortened" && adj.floors.length > 0;
        // A hard floor (rest-grade readiness, illness, pain the run loads) leaves no run
        // on the card at all: the read is rest, with no session named in the focus slot
        // — the same answer the Today run line and Endurance print that morning.
        const floorRest = adj?.dose === "rest";
        return {
          outcome: DAY_READ_OUTCOMES.stated_run_day,
          read: {
            kind: (floorRest ? "rest" : runDay.kind === "easy" || floorShortened ? "easy" : "train") as
              | "rest"
              | "easy"
              | "train",
            focus: floorRest ? null : runDay.label,
            why: adj?.why ? adj.why : pickDayVariant(STATED_RUN_DAY_WHY, d, "stated_run_day"),
            est_minutes: null,
            signals,
          },
        };
      },
    },
    {
      resolve: () => {
        const sd = suggestedPlanDay();
        if (!sd) return null;
        // Still a green-light to train (a suggestion, never a gate), but voice the soft
        // caveats so it's coach-level, not a blunt "go": fatigue quietly building toward
        // a reset, and/or running ramped this week (keep today's miles easy).
        // Each caveat is a rotating variant set, never a literal (see the sets above):
        // this rule fires on most mornings, so a fixed fragment reads as a stuck app.
        const caveats: string[] = [];
        // ---- SAFETY vs BOOKKEEPING (owner ruling, 2026-08-17) ----
        //
        // A caveat used to withdraw the push simply by EXISTING: `!caveats.length` was
        // the gate, so the read's one positive direction was switched off by any note
        // at all, including notes that are not about whether the athlete can carry load
        // today. On a real training block something is essentially always worth
        // mentioning, so the push was unreachable in practice — the read could get
        // quieter but never louder, which is the pessimism this ruling is about.
        //
        // So each caveat is now classified where it is raised, and only the SAFETY ones
        // veto. The test is not severity, it is subject: does this caveat say something
        // about the athlete's capacity to take load today?
        //
        //   SAFETY (vetoes the push)
        //     recovery_week      a deliberately reduced week; reaching inside it is
        //                        reaching against the structure, not within it
        //     injury             an active injury being worked around
        //     ease_around        a dated load-reducing constraint, same family
        //     joint_pain         a fresh health constraint off session feedback
        //     life_pressure      thinner RECOVERY (a late night / a stressful stretch);
        //                        the caveat's own job is to hold intensity down
        //
        //   BOOKKEEPING (no longer vetoes)
        //     adapted plan pick  which day was chosen, not how much can be carried
        //     anticipate_deload  a reset on the HORIZON; the deload itself, when it
        //                        arrives, is a recovery week and vetoes as one
        //     volume_spike       running-specific, and it already has its own dedicated
        //                        brake (the endurance_volume_spike easy read above, plus
        //                        the spike factor in weeklyRunPlan) — vetoing the lifting
        //                        push as well was the same finding charged twice
        //     stacked_days       a consecutive-hard-day COUNT, never a brake of its own.
        //                        Corroborated stacked days rest above this rule; at the
        //                        ceiling they read easy. What reaches here is the
        //                        uncorroborated run, which is named and left open.
        //     low_sleep          a chronic sleep TREND, which already brakes in its own
        //                        right (the recovery dimension, the chronic-sleep easy
        //                        read, and the run-volume factor) — charged twice again
        //     commitment_pressure a squeezed CLOCK; the day is already clamped 60 → 40,
        //                        and a short session is a fine session to reach inside
        //
        // `backed` and `!holdAggression` are unchanged and still required, and between
        // them they already exclude every fresh caution and constraint in the signal
        // state — so most of the SAFETY list is belt-and-braces on top of a bar those
        // two already clear. It is enumerated anyway: a veto that depends on a
        // coincidence of two other layers is a veto nobody can find later.
        const pushVetoes: string[] = [];
        if (recoveryWeek) {
          caveats.push(pickDayVariant(RECOVERY_WEEK_CAVEAT, d, "planned_training:recovery_week"));
          pushVetoes.push("recovery_week");
        }
        if (reduceItem) {
          caveats.push(
            reduceItem.kind === "injury"
              ? pickDayVariant(
                  INJURY_CAVEAT,
                  d,
                  "planned_training:injury"
                )(String(reduceItem.title || "an injury").toLowerCase())
              : pickDayVariant(EASE_AROUND_CAVEAT, d, "planned_training:ease_around")
          );
          pushVetoes.push(reduceItem.kind === "injury" ? "injury" : "ease_around");
        }
        // A health constraint the CONTEXT path cannot see. `reduceItem` is derived from
        // context EVENTS, so an injury, an illness or a dated constraint is already
        // voiced just above — but joint pain arrives from session feedback
        // (trainingSignals.autoregulation), and once the read learned to see it, it
        // reached this rule having ALREADY changed the day (directives.training ==
        // "modify", health_constraints constrained) with nothing to say about it. The
        // athlete was handed a modified session under "Recovery looks fine and the
        // session is due. Good day for it." — silent would have been bad; contradicting
        // itself is worse. Keyed on the DIMENSION like the work-around probe, so the
        // next constraint that arrives by a non-context route is covered on arrival;
        // the evidence's own voice supplies the subject, and anything that carries
        // none falls back to the generic ease-around fragment rather than inventing one.
        if (!reduceItem && healthWorkaround) {
          const sore = String(healthWorkaround.voice?.subject ?? "").trim();
          caveats.push(
            sore
              ? pickDayVariant(JOINT_PAIN_CAVEAT, d, "planned_training:joint_pain")(sore)
              : pickDayVariant(EASE_AROUND_CAVEAT, d, "planned_training:ease_around")
          );
          pushVetoes.push("joint_pain");
        }
        // BOOKKEEPING from here down — these push a caveat and no veto. See the table
        // where `pushVetoes` is declared for why each one landed on that side.
        if (sd.selection?.adapted && sd.selection?.reason) caveats.push(String(sd.selection.reason));
        if (anticipateDeload)
          caveats.push(pickDayVariant(ANTICIPATE_DELOAD_CAVEAT, d, "planned_training:anticipate_deload"));
        if (volumeSpike) caveats.push(pickDayVariant(VOLUME_SPIKE_CAVEAT, d, "planned_training:volume_spike"));
        if (stackedLoadingRest && !stackedLoadCorroborated && !atHardCeiling)
          caveats.push(pickDayVariant(STACKED_DAYS_CAVEAT, d, "planned_training:stacked_days"));
        // A CHRONICALLY short sleeper is a caveat on the session, not a reason to
        // withhold it. This used to be its own rule ABOVE this one, so anyone whose
        // rolling average sat under six hours was never offered a due plan day at all
        // — permanent rest traded for permanent easy. The watch still gets voiced (and
        // the rule survives below, for a day with nothing programmed to soften).
        if (chronicLowSleep) caveats.push(pickDayVariant(LOW_SLEEP_CAVEAT, d, "planned_training:low_sleep"));
        // ...and the ACUTE short night, which had nothing to say here at all. A short
        // night ON TOP of a short window is the rest path (`corroboratedLowSleep`) and
        // never reaches this rule; a short night on an otherwise-normal window reached
        // it and passed through silently, because the existing sleep caveat speaks only
        // for the chronic trend. That silence is what rule 4 names: one bad night never
        // forces rest, and it must not vanish either — what it costs is injury
        // EXPOSURE, which is the same thing the coach prompt is being told through
        // `training_constraints`. Bookkeeping, not a veto: the `backed` tier is already
        // withdrawn by the same night's own recovery caution in the signal state, so a
        // second veto here would be the one finding charged twice.
        else if (freshShortSleep)
          caveats.push(pickDayVariant(SLEEP_EXPOSURE_CAVEAT, d, "planned_training:sleep_exposure"));
        const holdAggression = signalState.action.directives.training === "hold_aggression";
        // Same rule as the protect read above: the athlete hears the athlete voice,
        // never the machine-facing summary. This is the second (and only other) path by
        // which the signal state's own words reach a `why` — it LEADS the read here
        // rather than sitting mid-sentence after the dash, because these are whole
        // sentences (several of them carry their own dash) and the caveat list is a
        // run of lowercase fragments.
        //
        // It leads with the BRAKE's voice, not the day's posture voice. `action.voice`
        // speaks the posture, and a hold day is still readiness:"ready" / posture:"train"
        // — whose evidence is the SUPPORT items — so voicing the hold through it printed
        // "you slept fine" and then asked the athlete to hold, with "until that settles"
        // pointing at nothing. `directives.training_source` names the dimension whose
        // status actually produced the hold, and on a watch dimension its `voice` is the
        // caution item's: the brake, in the athlete's register, with the pronoun in the
        // caveat finally resolving to it.
        const holdVoice = signalState.action.directives.training_source
          ? signalState.dimensions[signalState.action.directives.training_source].voice
          : signalState.action.voice;
        const holdLead = holdAggression ? spokenSignalVoice(holdVoice, d, "planned_training:hold") : "";
        if (holdAggression) caveats.push(pickDayVariant(HOLD_AGGRESSION_CAVEAT, d, "planned_training:hold_aggression"));
        // `schedule: "compress"` has TWO unrelated causes and only one is about the
        // clock. life_capacity reaches `watch` either from a real dated commitment
        // (voice `commitment_pressure`) or from `context.expect_worse_sleep` — a late
        // night or a stressful stretch (voice `schedule_pressure`), which is not a
        // commitment at all. Both write the same `field`, so the winning evidence's
        // VOICE is the only discriminator — shared with the conductor's compress card
        // as lifeCapacityIsCommitment, because two copies of it drifted apart once
        // already. Reading them as one printed "you've got a
        // commitment today that shortens the training window" over a life_event titled
        // "Brutal week at work" — a false claim about the athlete's calendar — and
        // answered a RECOVERY signal by shortening the clock. Split: a commitment
        // compresses the window; a thin stretch asks for less intensity at full length.
        // Anything unrecognized falls to the life-pressure branch, which claims less
        // and clamps nothing.
        // `schedulePressure` / `commitmentPressure` are derived once above the rule
        // list, so the drive read compresses on exactly the same condition.
        // MACHINE register, and now named as such. `life_capacity.reason` is
        // third-person evidence prose written for the model and the provenance trail
        // ("A current commitment or stressful stretch is likely to compress recovery
        // capacity."), and it sat on a field called plain `reason` inside the read's
        // own signals — one plausible client render away from printing observer prose
        // at the athlete. The athlete-facing counterpart is the dimension's `voice`,
        // carried beside it: a surface that shows this must speak it through
        // spokenSignalVoice, never render the evidence string.
        const scheduleReason = signalState.dimensions.life_capacity.reason;
        const scheduleVoice = signalState.dimensions.life_capacity.voice;
        if (commitmentPressure) {
          caveats.push(pickDayVariant(COMMITMENT_PRESSURE_CAVEAT, d, "planned_training:commitment_pressure"));
          (signals as any).schedule = {
            directive: "compress",
            compressed: true,
            original_est_minutes: 60,
            est_minutes: 40,
            evidence_reason: scheduleReason,
            voice: scheduleVoice,
          };
        } else if (schedulePressure) {
          caveats.push(pickDayVariant(LIFE_PRESSURE_CAVEAT, d, "planned_training:life_pressure"));
          // SAFETY — this branch is the RECOVERY one of the two compress causes (see the
          // split above); its whole content is "hold the intensity", which is the exact
          // opposite of what the push offers.
          pushVetoes.push("life_pressure");
          // Recovery pressure is a reason to hold intensity, not to shorten the day —
          // so the clock is left alone. The directive is still recorded so the machine
          // surface stays honest about what the signal state said AND what the read
          // chose to do with it.
          (signals as any).schedule = {
            directive: "compress",
            compressed: false,
            original_est_minutes: 60,
            est_minutes: 60,
            evidence_reason: scheduleReason,
            voice: scheduleVoice,
          };
        }
        // A recovery week ALWAYS pushes its own caveat above, so the caveat arm is the
        // one a reduced week takes — there is no separate recovery-week arm (the one
        // that used to sit between these two was unreachable for exactly that reason;
        // see the retired RECOVERY_WEEK_TRAIN_WHY note at the top of this file).
        // The brain's other direction. Every arm above this one either holds the day
        // back or leaves it alone; this is the only one that offers MORE, and it fires
        // when the unified state says the evidence positively backs the day
        // (support === "backed") AND nothing SAFETY-class is on the board. `backed`
        // already requires no fresh caution or constraint anywhere; `pushVetoes` is what
        // rules out the day's non-signal brakes too — a recovery week, an injury being
        // worked around, a stretch that is eating recovery.
        //
        // The gate used to read `!caveats.length`, i.e. any note at all. That is the
        // clause this ruling replaces: see the SAFETY/BOOKKEEPING table above for which
        // notes still veto and why. Suggestion, never a gate; `est_minutes` is
        // deliberately untouched, because a backed day is a reason to reach WITHIN the
        // session, not a reason to make it longer.
        // ---- the caution that is real but UNSECONDED (owner ruling, 2026-08-17) ----
        //
        // Raising the hold bar to a second opinion left a gap the athlete would have
        // felt as the read going deaf: one dimension genuinely at `watch`, no hold, and
        // therefore nothing at all in the read about it — the Brief would have said
        // "nothing's holding you back today" on a morning where something was
        // demonstrably worth saying. Silence would have been a worse bug than the
        // over-holding, because the finding is real; only the counsel was too firm.
        //
        // So the caution still SPEAKS, in its own voice, and the day stays open. Read in
        // the same precedence order planningDirectives uses, off the same four
        // dimensions it counts, so the sentence names the dimension the hold WOULD have
        // named had a second one joined it.
        //
        // Held out entirely when anything SAFETY-class is already on the board: those
        // days already lead with the thing that matters (an injury, a reduced week, a
        // stretch eating recovery), and handing the lead to a soft caution instead would
        // demote the constraint to a fragment after the dash. This branch is for the
        // otherwise-clean board, which is exactly the case the ruling is about.
        const HOLD_DIMENSIONS: readonly SignalDimension[] = [
          "recovery_capacity",
          "training_load_tolerance",
          "health_constraints",
          "energy_fueling",
        ];
        // Raw status, deliberately: an advisory brake (an endurance hold, a chronic
        // intensity drift, an HRV saturation read) is allowed to SPEAK here — leading
        // the day's why is exactly what a brake that cannot take the day is for. It
        // decides nothing on this path; the kind was already settled above.
        // Advice-only watch (fueling around a long run) is not a caution to lead with:
        // it rides the caveat run, so a push day keeps its reach and the advice is heard.
        const fuelAdvice = dimensionIsAdviceOnly(signalState.dimensions.energy_fueling);
        if (fuelAdvice) caveats.push(pickDayVariant(FUEL_AROUND_TRAINING_CAVEAT, d, "planned_training:fuel_around"));
        const notedWatch =
          holdAggression || pushVetoes.length
            ? null
            : (HOLD_DIMENSIONS.find(
                (dimension) =>
                  signalState.dimensions[dimension].status === "watch" &&
                  !dimensionIsAdviceOnly(signalState.dimensions[dimension])
              ) ?? null);
        const notedVoice = notedWatch ? signalState.dimensions[notedWatch].voice : null;
        const notedLead = notedWatch ? spokenSignalVoice(notedVoice, d, "planned_training:noted") : "";
        const pushBias = signalState.action.support?.level === "backed" && !holdAggression && !pushVetoes.length;
        if (pushBias) (signals as any).push_bias = { backed_by: signalState.action.support?.fields ?? [] };
        // Whatever holds the day back also says what opens it again — the earn path.
        // Only the two branches that actually hold something carry one; a clear day and
        // a push day have nothing to unlock.
        const earnPath = holdAggression
          ? ` ${earnPathClause(holdVoice, d)}`
          : notedWatch
            ? ` ${earnPathClause(notedVoice, d)}`
            : "";
        const caveatRun = caveats.length ? ` — ${caveats.join("; and ")}` : "";
        const why = holdAggression
          ? `${holdLead} ${pickDayVariant(TRAIN_HOLD_LEAD, d, "planned_training:hold_lead")}${caveatRun}.${earnPath}`
          : notedWatch
            ? // The caution speaks, the day stays open, and the earn path closes it out.
              `${notedLead} ${pickDayVariant(TRAIN_NOTED_LEAD, d, "planned_training:noted_lead")}${caveatRun}.${earnPath}`
            : caveats.length
              ? // A backed day carrying only bookkeeping notes keeps the reach in the
                // lead rather than losing it: the caveats are still said, in full, but
                // the sentence no longer opens as though something were wrong.
                `${pickDayVariant(
                  pushBias ? TRAIN_PUSH_CAVEAT_LEAD : TRAIN_CAVEAT_LEAD,
                  d,
                  pushBias ? "planned_training:push_caveats" : "planned_training:caveats"
                )}${caveatRun}.`
              : pushBias
                ? pickDayVariant(TRAIN_PUSH_WHY, d, "planned_training_push")
                : pickDayVariant(TRAIN_CLEAR_WHY, d, "planned_training");
        return {
          outcome: recoveryWeek ? DAY_READ_OUTCOMES.planned_reduced_training : DAY_READ_OUTCOMES.planned_training,
          read: { kind: "train", focus: sd.focus, why, est_minutes: commitmentPressure ? 40 : 60, signals },
        };
      },
    },
    {
      resolve: () => {
        // The chronic-sleep watch, DEMOTED below the plan day it used to preempt: it
        // now only speaks when there is no session to caveat, where it still beats the
        // bare unprogrammed floor at explaining why today reads easy.
        if (!chronicLowSleep) return null;
        return {
          outcome: DAY_READ_OUTCOMES.chronic_sleep_watch,
          read: {
            kind: "easy",
            focus: null,
            why: pickDayVariant(CHRONIC_SLEEP_WHY, d, "chronic_sleep_watch"),
            est_minutes: 25,
            signals,
          },
        };
      },
    },
  ];

  const resolved = resolveDayReadRule(rules);
  const ruleOutcome = resolved?.outcome ?? UNPROGRAMMED_EASY_DAY;
  const unprogrammedCaveat =
    stackedLoadingRest && !stackedLoadCorroborated && !atHardCeiling
      ? pickDayVariant(STACKED_DAYS_CAVEAT, d, "planned_training:stacked_days")
      : null;
  const unprogrammedWhy = pickDayVariant(UNPROGRAMMED_WHY, d, "unprogrammed_easy_day");
  const ruleRead = resolved?.read ?? {
    kind: "easy" as const,
    focus: null,
    why: unprogrammedCaveat ? `${unprogrammedWhy.replace(/[.!?]$/, "")} — ${unprogrammedCaveat}.` : unprogrammedWhy,
    est_minutes: 20,
    signals,
  };
  // ---- the outcome loop, closed ----
  // A rest the athlete has repeatedly overruled without paying for it becomes an easy
  // day. ONE step, and only ever this one: rest → easy. It cannot reach train, it
  // cannot fire against a fresh short night or a measured dose overrun, and it cannot
  // fire while anything clinical is live (see SOFTENABLE_REST_CODES + clinicallyDriven
  // above). The result carries its own rule code, so the ledger, the repeat-of-
  // yesterday check and the Brief's reason all key on the softening rather than on the
  // rule it replaced — and tomorrow's model sees how THIS day went, so the loop is
  // self-correcting in both directions.
  // ---- the long loop: a WEIGHTED learning moves the quiet read in proportion ----
  // Asked only of a non-floor quiet read, and only the day's due session may open — the
  // same run-stacking hold as the easy ladder below. It outranks both short ladders.
  // The weight picks the rung (learnedQuietStep): an easy read opens to "train, with
  // the caveat"; a rest read eases to easy first and opens only on heavier evidence.
  // A rest read whose open is held (nothing due, the due legs saturated, a second run)
  // still takes the one-rung ease — the evidence is about the quiet read, and easy
  // movement asks nothing of the held session.
  const learnedEligible =
    (ruleRead.kind === "rest" || ruleRead.kind === "easy") &&
    LEARNED_TRAIN_CODES.has(ruleOutcome.code) &&
    !recoveryWeek &&
    !clinicallyDriven(signalState, healthWorkaround) &&
    !freshSafetyOverride(signalState);
  const trainAnyway = learnedEligible
    ? signalInput(
        () =>
          brainSignal(`train_anyway:${d}`, () =>
            trainsAnywayWithoutHarm(
              readAdherenceModel(d, LEARNED_TRAIN_WINDOW_DAYS + 2, LEARNED_TRAIN_WINDOW_DAYS + 2),
              d
            )
          ),
        null
      )
    : null;
  const learnedStep =
    trainAnyway && !freshStatementHold(d, checkin) ? learnedQuietStep(ruleRead.kind, trainAnyway.weight) : null;
  const learnedDay = learnedStep === "train" ? suggestedPlanDay() : null;
  const learnedOpen =
    learnedDay != null &&
    !signalInput(() => planDayAcutelySaturated(learnedDay.day_number, d), true) &&
    !((hardCardioYesterday || !!runNoveltyYesterday) && planDayIsCardioOnly(learnedDay.day_number));
  const learnedEase = !learnedOpen && learnedStep != null && ruleRead.kind === "rest";
  if (trainAnyway) {
    (signals as any).learned_train_anyway = {
      ...trainAnyway,
      applied: learnedOpen || learnedEase,
      step: learnedOpen ? "train" : learnedEase ? "easy" : null,
    };
  }
  const softenRest =
    !learnedOpen &&
    !learnedEase &&
    outcomeFeedback?.active === true &&
    ruleRead.kind === "rest" &&
    SOFTENABLE_REST_CODES.has(ruleOutcome.code) &&
    !clinicallyDriven(signalState, healthWorkaround);
  // Republish the evidence with the ANSWER attached. `active` says only that the
  // pattern is there; it stays true on a morning that reads train, and on one where a
  // clinical constraint or a fresh short night holds the rest in place. Anything
  // downstream that claims the day has already been eased — the day-read prompt, and
  // tomorrow's evidence window reading this row back off the ledger — must key on
  // `applied`, which is the fact rather than the argument for it.
  if (outcomeFeedback) {
    (signals as any).outcome_feedback = { ...outcomeFeedback, applied: softenRest } satisfies OutcomeFeedbackSignal;
  }
  // ---- …and the same loop one rung up ----
  // An EASY read the athlete has repeatedly taken above easy without paying for it
  // becomes a training day. ONE step, exactly as above: easy → train and no further.
  // Same evidence bar, same clinical floor, and additionally never inside a reduced
  // week — a recovery week is a deliberate structure the athlete signed up for, not a
  // read arguing with them, so their own overruns are not evidence against it.
  //
  // `!softenRest` is belt-and-braces rather than arithmetic: a rest read cannot be in
  // SOFTENABLE_EASY_CODES anyway, but stating it here makes it impossible for the two
  // ladders to compose into rest → train by way of a future code appearing in both.
  //
  // …and a fresh word from the athlete about THIS morning is the last condition. It is
  // written as a separate `heldByStatement` rather than folded into the conjunction
  // because the read has to be able to SAY it held: the sentence below is appended only
  // on the mornings where the pattern was live and their own account is what kept the
  // day. See freshStatementHold() for the scope — same day, severe end, absence inert.
  const softenEasyEarned =
    !learnedOpen &&
    !learnedEase &&
    !softenRest &&
    easyFeedback?.active === true &&
    ruleRead.kind === "easy" &&
    SOFTENABLE_EASY_CODES.has(ruleOutcome.code) &&
    !recoveryWeek &&
    !clinicallyDriven(signalState, healthWorkaround);
  const heldByStatement = softenEasyEarned ? freshStatementHold(d, checkin) : null;
  // The opened day gets the focus and the clock of the session that was actually due,
  // when one is: the easy reads this rule may open sit ABOVE the planned-training rule
  // and preempt it, so without this an athlete who has been outrunning the quiet reads
  // for a fortnight would be handed a training day with nothing in it. No plan day due
  // → easy movement with the easy clock, never an invented session.
  //
  // And the week's programmed REST day is "no plan day due" (suggestedPlanDay returns
  // null for it): a fortnight of overrun mornings is evidence about how the athlete
  // absorbs the QUIET READS, never a mandate to delete the rest day out of their own
  // template. `softenEasy` requires openedPlanDay, so the ladder simply stops here.
  const openedPlanDay = softenEasyEarned && !heldByStatement ? suggestedPlanDay() : null;
  // ---- and it may never open a SECOND run (owner ruling, 2026-08-28) ----
  // The ladder opens the day that is due. When the day that is due is nothing but
  // cardio — the week template here is five lift days and two consecutive "Run" days
  // — opening it the morning after a hard run is how the read comes to stack runs by
  // default, which is a thing no coach would ever program and the ladder was never
  // meant to decide. A day with any strength work in it is untouched: its strength
  // half is already gated by the muscle model, and the athlete gets their session.
  //
  // The hold is on the MODALITY, not on the ladder. The pattern stays live, the
  // evidence stays published, and the read simply keeps whatever the rules gave it.
  const runStackingHold =
    (hardCardioYesterday || !!runNoveltyYesterday) && planDayIsCardioOnly(openedPlanDay?.day_number ?? null);
  const softenEasy = softenEasyEarned && !heldByStatement && openedPlanDay != null && !runStackingHold;
  if (runStackingHold) {
    (signals as any).run_stacking_hold = {
      plan_day: openedPlanDay?.day_number ?? null,
      hard_cardio_yesterday: hardCardioYesterday,
      longest_run_yesterday: !!runNoveltyYesterday,
    };
  }
  if (easyFeedback) {
    (signals as any).easy_outcome_feedback = {
      ...easyFeedback,
      applied: softenEasy,
      ...(heldByStatement ? { held_by_statement: heldByStatement } : {}),
    } satisfies EasyOutcomeFeedbackSignal;
  }
  // The learned one-rung ease speaks through the short ladder's own soften outcome: the
  // same move (rest → easy, no focus, the easy clock) on the same kind of evidence —
  // they trained through reads like this and it went fine — so it takes the same
  // registered reasons and wording rather than a second vocabulary for one sentence.
  const outcome = learnedOpen
    ? DAY_READ_OUTCOMES.learned_train_anyway
    : softenRest || learnedEase
      ? DAY_READ_OUTCOMES.outcome_feedback_soften
      : softenEasy
        ? DAY_READ_OUTCOMES.outcome_feedback_open
        : ruleOutcome;
  const resolvedRead = learnedOpen
    ? {
        ...ruleRead,
        kind: "train" as const,
        focus: learnedDay?.focus ?? null,
        why: pickDayVariant(LEARNED_TRAIN_WHY, d, "learned_train_anyway"),
        est_minutes: 60,
      }
    : softenRest || learnedEase
    ? {
        ...ruleRead,
        kind: "easy" as const,
        focus: null,
        why: pickDayVariant(OUTCOME_FEEDBACK_SOFTEN_WHY, d, "outcome_feedback_soften"),
        est_minutes: 20,
      }
    : softenEasy
      ? {
          ...ruleRead,
          kind: "train" as const,
          focus: openedPlanDay?.focus ?? null,
          why: pickDayVariant(OUTCOME_FEEDBACK_OPEN_WHY, d, "outcome_feedback_open"),
          est_minutes: 60,
        }
      : heldByStatement
        ? {
            // The read is the rule's, untouched — same kind, same focus, same clock.
            // Only the sentence grows: the rule still says what today is about, and the
            // held phrasing says why a fortnight of history did not open it. Appended
            // rather than substituted so the rule's own registered meaning survives
            // (DAY_READ_REQUIRED_CONCEPT is checked per rule code, and this sentence is
            // registered under its own key beside it).
            //
            // The set follows the door the veto came through: only a check-in arm may
            // say "check-in", since a symptom report is not one and the athlete may
            // never have opened one.
            ...ruleRead,
            why: `${endStopped(ruleRead.why)} ${
              heldByStatement === "symptom_report"
                ? pickDayVariant(OUTCOME_FEEDBACK_HELD_SYMPTOM_WHY, d, "outcome_feedback_held_symptom")
                : pickDayVariant(OUTCOME_FEEDBACK_HELD_WHY, d, "outcome_feedback_held")
            }`,
          }
        : ruleRead;
  // The health work-around closes EVERY protective read, whichever rule produced it
  // — a short night, stacked load, a light walk already logged, or the bare floor. It
  // used to be spoken by one rule only, so the athlete's constraint guidance disappeared
  // the moment a different rule won the posture. A train day is excluded on purpose:
  // that read voices the same constraint in its own caveat list ("train around it and
  // skip anything that aggravates it"), and a `done` day is a fact about work already
  // finished, not a suggestion to work around.
  //
  // …unless the winning rule ALREADY spoke that same voice. Widening the probe from
  // `active_injury` to every health constraint made that reachable: an illness both
  // drives the protect posture AND is the winning evidence behind it, so the rule's
  // own `why` IS the illness voice — and appending a second phrasing of it printed the
  // same idea twice in one read. Membership is checked across the whole voice, not the
  // one sentence today rolled, because the two paths rotate on different keys.
  const workaroundVoice = healthWorkaround?.voice ?? {
    key:
      healthWorkaround?.field === "illness"
        ? ("illness" as const)
        : healthWorkaround?.field === "active_injury"
          ? ("active_injury" as const)
          : ("health_constraint" as const),
  };
  const workaroundAlreadySpoken =
    !!healthWorkaround && signalVoice(workaroundVoice).some((variant) => resolvedRead.why.includes(variant));
  const base =
    healthWorkaround && QUIET_KINDS.has(resolvedRead.kind) && !workaroundAlreadySpoken
      ? {
          ...resolvedRead,
          // Named in the athlete's own register and rotated by day like everything
          // else. It used to splice the evidence `summary` behind a fixed lead-in —
          // one sentence printed verbatim for as long as the injury lasted, carrying
          // context-effect's generic classifier line along with the injury's name
          // ("…around the active injury: Achilles tendinopathy: an active injury is
          // worth easing or working around."). endStopped stays: everything the
          // continuity voice adds lands AFTER this, so the sentence must close.
          why: `${resolvedRead.why} ${endStopped(spokenSignalVoice(workaroundVoice, d, SIGNAL_VOICE_KEYS.injury))}`,
        }
      : resolvedRead;
  // Honest about the evidence itself, not just the posture: when visibly less of
  // the board is currently backing today's read than usual (a wearable gap, an
  // unlogged stretch), say so instead of letting the read project a confidence the
  // evidence doesn't have. `done` is excluded — that read is a fact about work
  // already logged, not a forward confidence call. Never about the athlete's
  // LOGGING itself (VISION.md: absent data is never "low"/"behind") — the sentence
  // is about the READ leaning on how the athlete feels, not a rebuke.
  //
  // Gated to the genuinely bare call (no recovery/unifiedState/underfueling
  // override) — the real Brief-serving path (dayread.ts's cache layer calls
  // dayRead(date) with nothing else), where `signalState` is the true DB-scanned
  // RICH state. A caller that hands in its own recovery/signal-state snapshot
  // (prompt building, an earlier-computed baseline) is by definition supplying
  // its OWN evidence, often in a narrower shape than the full scan produces —
  // reading thinness off THAT would describe the shape of the override, not the
  // athlete's actual week.
  const thin =
    base.kind !== "done" &&
    recovery === undefined &&
    unifiedState === undefined &&
    underfuelingSnapshot === undefined &&
    thinSignalCoverage(signalState.dimensions);
  const withThinness = thin
    ? { ...base, why: `${base.why} ${pickDayVariant(THIN_SIGNAL_COVERAGE_WHY, d, "thin_signal_coverage")}` }
    : base;
  // Cross-day memory: yesterday reached this same conclusion by this same route,
  // so today has nothing new to report and should say so rather than re-deriving
  // the sentence as though it were news.
  continuity.repeat_of_yesterday =
    !!continuity.yesterday &&
    continuity.yesterday.kind === withThinness.kind &&
    continuity.yesterday.rule_code === outcome.code;
  return finalizeDeterministicRead(d, outcome, applyContinuityVoice(d, outcome, withThinness, continuity));
}

// A thin week for signals: less current evidence backing today's read than usual
// (see thinSignalCoverage). Acknowledges the read's own CONFIDENCE — never the
// athlete's logging — and leans on how they feel over what's tracked. Rotated like
// every other athlete-facing sentence in this file.
export const THIN_SIGNAL_COVERAGE_WHY: readonly string[] = [
  "It's a thin week for signals, so today leans more on how you feel than what's on the record.",
  "There's not much on the record lately, so today's read leans on your own sense of things over the numbers.",
  "Signals have been quiet this week — today trusts how you feel more than what's logged.",
];

// ---------- the forward look (day-ahead heads-up) ----------
// The Program-tab intelligence, woven onto the Brief so the athlete never has to
// visit a separate tab to know their focus: what the NEXT session leans toward (the
// plan day AFTER the one anchoring today) + which muscle groups are DUE this week
// (under their productive range). Deterministic + null-safe — the agent voices it
// warmly when available, this is the floor (and the structured truth the PWA renders).
export interface ForwardLook {
  next_focus: string | null; // the next session's character ("Lower body")
  next_name: string | null; // the next plan day's NAME ("Pull") — what the line says
  due: string[]; // groups under their productive range this week
  loaded_soon: { when: "tomorrow" | "soon"; run_kind: "quality" | "long" } | null;
  text: string | null; // a single plain-words line, or null when there's nothing to say
}
// The shape of a loaded near-future — a forecast-shaped SUGGESTION, never a red day
// or a gate. Rule-based over the SAME flexible-agenda lookahead the hybrid sequencing
// signal already computes (day-read.ts's `hc.planned_run_next`); no new prediction
// machinery. Each variant is rendered with the run's plain word ("long"/"quality"),
// same precedent as EARN_PATH_INTENSITY above. Every phrasing holds the reading
// grammar (violatesReadingGrammar): no gate language, no score.
export const FORWARD_LOADED_TOMORROW: ReadonlyArray<(runKind: string) => string> = [
  (runKind) => `Tomorrow leans ${runKind} — today's a good day to stay easy and bank it.`,
  (runKind) => `Tomorrow's the ${runKind} one — worth keeping today light for it.`,
  (runKind) => `The ${runKind} work lands tomorrow, so today's the natural day to ease up.`,
];
export const FORWARD_LOADED_SOON: ReadonlyArray<(runKind: string) => string> = [
  (runKind) => `A ${runKind} run is coming up this week — worth staying easy in the days before it.`,
  (runKind) => `The week's ${runKind} run is on the horizon — a good stretch to bank some ease.`,
];
export function forwardLook(date?: string): ForwardLook {
  const d = date || localDateISO();
  let next_focus: string | null = null;
  let next_name: string | null = null;
  // True once today already holds logged lifting — only then is the pick the day AFTER.
  let afterToday = false;
  try {
    const days = planDayCandidates();
    if (days.length) {
      // If today already has work, "Next" means the day after that work. Otherwise
      // it means the same adaptive next-session pick the Brief points at.
      const todaySess = db
        .prepare(
          `SELECT s.id AS id, s.plan_day_id AS plan_day_id
           FROM sessions s
          WHERE s.date = ? AND EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id)
          ORDER BY s.id DESC LIMIT 1`
        )
        .get(d) as any;
      const todayResolved = todaySess
        ? resolveSessionPlanDay(
            Number(todaySess.id),
            todaySess.plan_day_id == null ? null : Number(todaySess.plan_day_id),
            days
          )
        : null;
      afterToday = !!todayResolved;
      const selected = todayResolved ? null : selectAdaptivePlanDay(d);
      const nd = todayResolved
        ? nextCandidateAfter(days, todayResolved.day_number)
        : days.find((day) => day.day_number === selected?.day_number);
      next_focus = nd ? planDayFocus(nd) : null;
      next_name = nd ? planDayLabel(nd) : null;
    }
  } catch {
    /* no plan → no next focus */
  }
  let due: string[] = [];
  try {
    const bal: any = programBalance(2, d);
    // A saturated group is NOT something to put in front of the athlete as "due"
    // — the Brief must never say "quads & calves due" the morning after the long
    // run that flattened them. This surface never asked the acute question at
    // all; it does now, through the same gate every other consumer reads.
    due = suppressSaturatedDue(Array.isArray(bal?.due) ? bal.due : [], d, true).slice(0, 2);
  } catch {
    /* no balance → no due groups */
  }
  // The shape of coming days: does the near future already hold a loaded run (a
  // quality or long session) tomorrow, or in the next couple of days? Reuses the
  // SAME flexible-agenda lookahead the hybrid sequencing signal computes elsewhere
  // in this file (`hc.planned_run_next`) — no new prediction machinery, just prose
  // over existing look-ahead state.
  let loaded_soon: ForwardLook["loaded_soon"] = null;
  try {
    const hc = withFlexibleRunLookahead(hybridDayContext(d), d);
    const next = hc.planned_run_next;
    if (next && (next.kind === "quality" || next.kind === "long")) {
      const tomorrow = addDaysISO(d, 1);
      const dayAfter = addDaysISO(d, 2);
      if (next.date === tomorrow) loaded_soon = { when: "tomorrow", run_kind: next.kind };
      else if (next.date === dayAfter) loaded_soon = { when: "soon", run_kind: next.kind };
    }
  } catch {
    /* no agenda → no forecast */
  }
  const parts: string[] = [];
  // The plan day's NAME, the same label the week strip and the Session header use.
  // Before anything is lifted the pick IS today's lift, which the today strength line
  // already names — "Next: Pull" under "Pull still open" said it twice.
  if (afterToday && (next_name || next_focus)) parts.push(`Next: ${next_name || next_focus}`);
  if (due.length) parts.push(`${plainGroupWords(due, 2) ?? due.join(" & ")} due this week`);
  if (loaded_soon) {
    const runWord = loaded_soon.run_kind === "long" ? "long" : "quality";
    const render =
      loaded_soon.when === "tomorrow"
        ? pickDayVariant(FORWARD_LOADED_TOMORROW, d, "forward_loaded_near_future:tomorrow")
        : pickDayVariant(FORWARD_LOADED_SOON, d, "forward_loaded_near_future:soon");
    parts.push(render(runWord));
  }
  return { next_focus, next_name, due, loaded_soon, text: parts.length ? parts.join(" · ") : null };
}

// ---------- the week ahead (deterministic floor) ----------
// The forward-look's safety net (coachOps.weekAheadRead layers the agentic day-by-
// day shape on top). Honest + simple: the lifting split as the week's sessions, in
// plan order, plus a base-building note — NO fabricated calendar (the agent owns the
// real day-by-day). Always available, never throws.
export interface WeekAheadDay {
  day: string | null; // weekday label when the agent placed it; null for the floor's plan list
  kind: "lift" | "run" | "mixed" | "rest";
  label: string; // e.g. "Lower body" / "Easy 5k" / "Rest"
  note?: string | null;
}

export function weekAheadPlan(date = localDateISO()): { days: WeekAheadDay[]; summary: string } {
  const d = String(date).slice(0, 10);
  // Plan days hold STRENGTH only (migration 110): every plan day is a lifting day. The
  // runs come from the RUN ENGINE's week as the rolling agenda dates it (the same
  // intents the Endurance tab and the week strip read), falling back to the athlete's
  // stated run weekdays when the agenda has nothing to say — so a runner still sees
  // their runs in the floor without any run living on the plan. A rest day is simply
  // a weekday with neither.
  const planDays = db
    .prepare(
      `SELECT pd.id, pd.day_number, pd.name, pd.focus FROM plan_days pd
        WHERE COALESCE(pd.day_type, 'training') != 'rest'
          AND EXISTS (SELECT 1 FROM plan_items pi
                       WHERE pi.plan_day_id = pd.id AND COALESCE(pi.kind, 'strength') != 'cardio')
        ORDER BY pd.day_number`
    )
    .all() as any[];
  let statedRuns: { dow: number; kind: string; label: string | null }[] = [];
  try {
    const agenda = flexibleTrainingAgenda(d);
    if (agenda.available) {
      statedRuns = agenda.intents
        .map((intent) => {
          const on = intent.completion?.date ?? intent.suggested_date;
          return on
            ? { dow: new Date(`${on}T00:00:00Z`).getUTCDay(), kind: String(intent.kind), label: intent.label || null }
            : null;
        })
        .filter((run): run is { dow: number; kind: string; label: string | null } => !!run);
    }
  } catch {
    statedRuns = [];
  }
  if (!statedRuns.length) {
    try {
      statedRuns = (getEnduranceSchedule()?.days ?? []).map((day) => ({
        dow: Number(day.dow),
        kind: String(day.kind),
        label: null,
      }));
    } catch {
      statedRuns = [];
    }
  }
  statedRuns.sort((a, b) => ((a.dow + 6) % 7) - ((b.dow + 6) % 7));
  if (!planDays.length && !statedRuns.length) return { days: [], summary: "" };
  // Grounded once, defensively: a purpose-line failure must never break the
  // deterministic week-ahead floor (same posture as the `notes` block below).
  let meso: MesocycleState | null = null;
  try {
    meso = getProgramState(d)?.mesocycle ?? null;
  } catch {
    meso = null;
  }
  let goal: ReturnType<typeof getEnduranceGoal> = null;
  try {
    goal = getEnduranceGoal(d);
  } catch {
    goal = null;
  }
  const days: WeekAheadDay[] = [
    ...planDays.map(
      (pd): WeekAheadDay => ({
        day: null,
        kind: "lift",
        label: String(pd.focus || pd.name || `Day ${pd.day_number}`)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60),
        note: weekAheadDayNote("lift", d, meso, goal),
      })
    ),
    ...statedRuns.map(
      (run): WeekAheadDay => ({
        day: WEEKDAY_NAMES[run.dow] ?? null,
        kind: "run",
        label: String(run.label || RUN_KIND_LABELS[run.kind] || "Run").slice(0, 60),
        note: weekAheadDayNote("run", d, meso, goal),
      })
    ),
  ];
  // Reflect PROGRAM STATE in the floor's summary (plain words, never a fabricated
  // calendar): if a deload is about due, or muscle groups are DUE, or a lift needs
  // a deload, say so as a forward-looking note so the look-ahead is honest about
  // what the week could use. Defensive: program-state is a heavier read — a failure
  // here must never break the deterministic week-ahead floor.
  const notes: string[] = [];
  try {
    const st = getProgramState();
    if (st?.mesocycle?.phase === "deload-due") notes.push("a deload week is about due — pencil in one lighter day");
    // Same acute gate as the forward-look: the week ahead never opens by naming a
    // group that is still carrying yesterday's work as something to go add.
    const bal = programBalance(2, d);
    const dueFresh = suppressSaturatedDue(Array.isArray(bal?.due) ? bal.due : [], d).slice(0, 3);
    if (dueFresh.length)
      notes.push(
        `${plainGroupWords(dueFresh, 3) ?? dueFresh.join(", ")} ${dueFresh.length === 1 ? "is" : "are"} due — work ${dueFresh.length === 1 ? "it" : "them"} in`
      );
    const deload = (Array.isArray(st?.lifts) ? st.lifts : [])
      .filter((l: any) => l.suggested_action === "deload")
      .map((l: any) => l.exercise);
    if (deload.length) notes.push(`${deload.slice(0, 2).join(", ")} could use a light deload`);
  } catch {
    /* program-state unavailable — fall back to the plain summary */
  }

  const base =
    "Your training week in order — weave easy, conversational runs between sessions for your aerobic base, and take a rest day when you need one.";
  return {
    days,
    summary: notes.length ? `${base} This week: ${notes.join("; ")}.` : base,
  };
}

// The SAME grounded purpose line (weekAheadDayNote), for a single plan day —
// so today's session surface can carry the same "why this session" sentence
// the week-ahead card does, not a second drifted implementation. Never throws;
// null on any failure or when the program state can't ground a purpose.
export function planDayPurpose(planDayId: number, date = localDateISO()): string | null {
  try {
    const d = String(date).slice(0, 10);
    // Plan days hold strength only, so a day with items is a lifting day.
    const row = db
      .prepare(`SELECT COUNT(*) AS strength FROM plan_items WHERE plan_day_id = ? AND COALESCE(kind, 'strength') != 'cardio'`)
      .get(planDayId) as any;
    if (!(Number(row?.strength) > 0)) return null;
    const kind: WeekAheadDay["kind"] = "lift";
    const meso = getProgramState(d)?.mesocycle ?? null;
    const goal = getEnduranceGoal(d);
    return weekAheadDayNote(kind, d, meso, goal);
  } catch {
    return null;
  }
}

// getPlan(), with the SAME purpose line attached per day — the one source both
// GET /plan and the /today aggregate read, so the sentence never appears from
// one endpoint and vanishes when the client's background /plan revalidation
// lands (see today-data-loader.ts, which overwrites the cached "plan" key).
// `out_of_order` flags a day whose stored item order differs from effect order
// so the Plan gallery can offer a quiet "Order for effect" without a second fetch.
export function getPlanWithPurpose(date = localDateISO()): Array<Record<string, unknown>> {
  return getPlan().map((day: any) => ({
    ...day,
    purpose: day?.id != null ? planDayPurpose(Number(day.id), date) : null,
    out_of_order: planItemsOutOfOrder(Array.isArray(day?.items) ? day.items : []),
  }));
}



