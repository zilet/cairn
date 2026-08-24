import type { CoachingFocus } from "../repo/coaching-focus.js";
import type { MemoryKind, MemoryRow, RecentLearning } from "../repo/memory.js";
import type { UnifiedSignalState } from "../repo/signal-state.js";
import type { EnduranceCapacityRead } from "../repo/endurance-capacity.js";
import type { ResolvedTrainingIntent } from "../repo/training-intent.js";
import type { EffectiveLocationContext } from "../repo/location-context.js";
import type { FuelDemandWeek } from "../repo/fuel-demand.js";

export type CoachRecord = Record<string, any>;
export type CoachGoalMode = "lose" | "maintain" | "gain";

export interface CoachNowContext {
  date?: string;
  weekday?: string;
  time?: string;
  part_of_day?: string;
  [key: string]: unknown;
}

export type CoachMemory = MemoryRow;
export type CoachLearning = RecentLearning;

export interface CoachDiscipline {
  primary: string;
  endurance_sport: string | null;
}

export interface CoachEnduranceGoal extends CoachRecord {
  mode?: "race" | "standing" | string | null;
  event?: string | null;
  date?: string | null;
  label?: string | null;
  distance_km?: number | null;
  weekly_km?: number | null;
  weekly_sessions?: number | null;
  target?: string | null;
}

export interface CoachGoalCheck extends CoachRecord {
  goal_mode?: CoachGoalMode | null;
  tdee?: number | null;
  message?: string;
  recommended?: CoachRecord | null;
  requested?: CoachRecord | null;
}

export interface CoachDayIntakeEntry {
  id: number;
  meal: string | null;
  summary: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  nutrition_pattern?: CoachRecord | null;
  eaten_at: string | null; // local "HH:MM" the athlete said they ate it; null whenever nobody remembered, which is ordinary
  logged_at: string | null;
  enrichment_status: string | null;
}

export interface CoachDayIntake {
  date: string;
  count: number;
  totals: CoachRecord;
  target: CoachRecord | null;
  remaining: CoachRecord | null;
  entries: CoachDayIntakeEntry[];
}

export type CoachContextEventKind = "trip" | "injury" | "life_event" | "family_event" | (string & {});

export interface CoachContextEvent extends CoachRecord {
  id?: number;
  kind: CoachContextEventKind;
  title?: string | null;
  detail?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  meta?: CoachRecord | null;
}

export type CoachDirectiveStatus = "active" | "done" | "dismissed" | "stale" | (string & {});

export interface CoachDirective extends CoachRecord {
  id?: number;
  marker?: string | null;
  domain?: string | null;
  directive?: string | null;
  rationale?: string | null;
  status?: CoachDirectiveStatus | null;
  source?: string | null;
  trigger_date?: string | null;
  freshness?: "fresh" | "stale" | "transient" | "acute" | string | null;
}

export interface CoachRecoverySignal extends CoachRecord {
  sleep?: number | null;
  hrv?: number | null;
  rhr?: number | null;
}

export interface CoachRecoveryContext extends CoachRecord {
  days?: number;
  since?: string;
  sources?: string[];
  has_data?: boolean;
  recovery?: CoachRecord;
  recent?: CoachRecoverySignal;
  baseline?: CoachRecoverySignal;
  delta?: CoachRecoverySignal;
  activities?: CoachRecord[];
  hard_sessions?: CoachRecord[];
}

export interface CoachProgramState {
  headline?: string;
  discipline?: string;
  lifts: CoachRecord[];
  volume: unknown[];
  mesocycle?: unknown;
  recovery_week?: unknown;
  endurance?: unknown;
  hybrid?: unknown;
  adaptations_due: unknown[];
}

export interface CoachAdjustment extends CoachRecord {
  kind?: string;
  title?: string;
  why?: string;
  exercise?: string;
}

export interface CoachSymptomLink extends CoachRecord {
  note?: string;
  markers?: CoachRecord[];
}

export interface CoachFamilyMember extends CoachRecord {
  id?: number;
  name?: string;
  relation?: string | null;
}

export interface CoachSupplement extends CoachRecord {
  id?: number;
  name?: string;
  dose?: string | null;
  frequency?: string | null;
}

export interface CoachCheckin extends CoachRecord {
  id?: number;
  date?: string;
}

export interface CoachFuelingFeedback extends CoachRecord {
  id?: number;
  date?: string;
  energy?: number | null;
  hunger?: number | null;
  note?: string | null;
  decision_id?: number | null;
}

export type CoachPersonalResponseConfidence = "tentative" | "observed" | "strong";

// Every target here MUST name a live consumer. A modifier the nightly model
// computes and nothing reads is a learning loop that only looks closed, so the
// consumer is part of the declaration rather than something to go looking for:
//
//   nutrition_step             -> personalizedNutritionStep()  (domain/brain/underfueling-service.ts)
//   training_progression_step  -> trainingModifierFor()/clampedOverload()/timedStep() (repo/progression.ts)
//   run_volume_step            -> weekly build factor          (repo/run-progression.ts)
//   recovery_adjustment        -> buildRecoveryMenu()          (repo/recovery-menu.ts)
//   plan_complexity            -> softenVolume / caps.volume   (repo/daily-decision.ts)
//
// Direction is NOT uniform across targets and is set by the producer in
// reaction-model.ts `modifierFor`, so read it there before wiring a new consumer:
// a step-size target eases BELOW 1 on a disappointing outcome, while
// `recovery_adjustment` sizes the recovery response itself and therefore rises
// ABOVE 1 on one. Both mean "be more careful"; they say it in opposite directions.
export type CoachPersonalModifierTarget =
  | "nutrition_step"
  | "training_progression_step"
  | "run_volume_step"
  | "recovery_adjustment"
  | "plan_complexity";

export type CoachPersonalSafetyGuardrail = "injury" | "allergy" | "clinical" | "lean_safe";

export interface CoachPersonalModifier {
  key: string;
  target: CoachPersonalModifierTarget;
  stage: string | null;
  // WHAT the modifier was learned about, when the target carries per-item readings:
  // the exercise name for a lift-level training learning, null for a whole-athlete
  // one. Carried as a field rather than left parsed out of `key`, because the consumer
  // has to be able to ask "is this MY lift's earned default, or everyone's?" — handing
  // the squat's learned response to a bench press is worse than handing it nothing.
  subject_key: string | null;
  scale: number;
  bounds: { min: number; max: number };
  confidence: CoachPersonalResponseConfidence;
  evidence_n: number;
  rationale: string;
  never_overrides: CoachPersonalSafetyGuardrail[];
}

export interface CoachOutcomeLearning {
  key: string;
  domain: string;
  metric_key: string;
  subject_key: string | null;
  stage: string | null;
  statement: string;
  expected: string;
  observed: string;
  change: string;
  confidence: CoachPersonalResponseConfidence;
  evidence_n: number;
  aligned_n: number;
  missed_n: number;
  contradictions: number;
  superseded_evidence_n: number;
  last_observed: string;
}

export interface CoachWhatWorksForYou {
  version: 2;
  learnings: CoachOutcomeLearning[];
  modifiers: CoachPersonalModifier[];
}

export interface CoachContextEnvelope {
  now: CoachNowContext;
  profile: CoachRecord | null;
  location: EffectiveLocationContext;
  discipline: CoachDiscipline;
  training_intent: ResolvedTrainingIntent;
  endurance_capacity: EnduranceCapacityRead | null;
  endurance_goal: CoachEnduranceGoal | null;
  goal: CoachGoalCheck | null;
  goal_mode: CoachGoalMode;
  journey: CoachRecord | null;
  day_intake: CoachDayIntake;
  meal_plan: CoachRecord | null;
  plan: CoachRecord[];
  recent_sessions: CoachRecord[];
  recent_activities: CoachRecord[];
  training_signals: CoachRecord;
  garmin: CoachRecord | null;
  memory: CoachMemory[];
  learnings: CoachLearning[];
  health: CoachRecord[];
  imaging: {
    total: number;
    truncated: boolean;
    index: CoachRecord[];
    details: CoachRecord[];
    measurement_trends: CoachRecord[];
  };
  health_review: CoachRecord | null;
  context_events: CoachContextEvent[];
  directives: CoachDirective[];
  health_focus: CoachRecord | null;
  coaching_focus: CoachingFocus;
  signal_state: UnifiedSignalState;
  symptom_links: CoachSymptomLink[];
  health_synthesis: CoachRecord | null;
  directive_feedback: CoachRecord[];
  recovery: CoachRecoveryContext;
  checkins: CoachCheckin[];
  fueling: CoachFuelingFeedback[];
  underfueling: CoachRecord | null;
  cut_quality: CoachRecord | null;
  // Which of the coming days carry the week's biggest work (a long run, a quality
  // session, a heavy lower day, a strength+run double) — so carbohydrate can be
  // biased toward them instead of one flat number being spread across seven very
  // different days. It never carries a target: the accepted nutrition target stays
  // authoritative, and this read only says which days are asking for more. Additive +
  // optional, so partial context builders and imported DBs never synthesize it.
  fuel_demand?: FuelDemandWeek | null;
  family: CoachFamilyMember[];
  body_composition: CoachRecord | null;
  body_metrics: CoachRecord | null;
  supplements: CoachSupplement[];
  run_compliance: CoachRecord | null;
  program_block: CoachRecord | null;
  program_state: CoachProgramState;
  performance: CoachRecord | null;
  program_balance: CoachRecord | null;
  recent_load: CoachRecord[];
  // Saturated groups from acuteGates() — the decision input the "do NOT program
  // these" prompt block reads. `recent_load` stays the descriptive recency list
  // (groups touched in the last two days); this is the gate, looking back over
  // the residual's own window. Additive so a partial context builder never has
  // to synthesize it.
  acute_gates?: CoachRecord[];
  progression: CoachRecord[];
  strength_journey: CoachRecord | null;
  program_adjustments: CoachAdjustment[];
  run_zones: CoachRecord | null;
  // The PERSONAL heart-rate model: observed max, threshold, the zone bands in
  // bpm, and the basis + confidence each rests on. Never an age formula — an
  // athlete whose conversational pace sits at 160 bpm is a baseline, not an
  // anomaly, and a prompt handed a population band would prescribe against a
  // pulse this athlete does not have. Optional so partial context builders and
  // imported DBs never need to synthesize it.
  hr_model?: CoachRecord | null;
  // The calibration ladder: which tests are worth an opening right now (already
  // filtered to stale AND decision-relevant), and what has recently been
  // anchored — so the coach never asks for a test the athlete just ran.
  // Suggestions only; nothing here gates anything. Optional, same reason.
  calibration?: CoachRecord | null;
  run_plan: CoachRecord | null;
  // Does the lifting week compose with the running week — the heaviest lower day
  // against the long/quality run, plus any 3-hard-days-in-a-row stretch. The
  // structured counterpart to the evolution prompt's placement rule, so a proposed
  // restructure can be checked against the real week instead of against prose.
  // Optional so partial context builders and imported DBs never synthesize it.
  week_layout?: CoachRecord | null;
  flexible_training_agenda: CoachRecord | null;
  run_variety: CoachRecord | null;
  endurance_tests: CoachRecord[];
  groups_trajectory: CoachRecord | null;
  test_week: CoachRecord | null;
  dexa_targeting: CoachRecord | null;
  day_read: CoachRecord | null;
  insights: CoachRecord[];
  reaction_model: CoachRecord | null;
  // Learned from the athlete's OWN subjective signals (Brief overrides / morning
  // check-ins / post-target fueling reads). Additive + null-safe; a bounded few
  // humble patterns, params stripped. Optional so partial context builders and
  // imported DBs never need to synthesize it.
  felt_signals?: CoachRecord | null;
  // Learned CROSS-DOMAIN coincidences (endurance→strength interference, short-sleep→
  // fueling). Additive + null-safe; a bounded couple of humble patterns, params
  // stripped. Optional so partial context builders and imported DBs never synthesize it.
  learned_models?: CoachRecord | null;
  what_works_for_you: CoachWhatWorksForYou | null;
  // How often each kind of morning read is actually FOLLOWED, over a rolling window
  // of closed days. COUNTS ONLY — never a rate, never a grade, and never rendered to
  // the athlete: VISION.md bans graded numbers about the person, and adherence is the
  // most tempting thing in this system to turn into one. Deliberately NOT wired into
  // any promptData site either, so no prompt can quote it back; it exists so the
  // disagreement between what the Brief suggests and what the athlete does becomes
  // MEASURABLE (operator diagnostics, MCP/REST readers, the bounded coach-read loop)
  // before anyone retunes a rest/easy/train threshold off a hunch. Additive +
  // optional, so partial context builders and imported DBs never synthesize it.
  read_adherence?: CoachRecord | null;
  recent_decisions: CoachRecord[];
  trajectory: CoachRecord | null;
  whole_person_trajectory: CoachRecord | null;
  context_today: CoachRecord | null;
  // What the NEXT day already holds — the context events whose `start_date` is
  // tomorrow, with the one judgement the look-ahead makes (`blocks_training`, by kind)
  // already applied. `context_events` carries the same rows and always has, which is
  // why the agent could see the appointment while the deterministic floor could not;
  // this key is the resolved question rather than the raw list, so the prompt and the
  // day-read rule that re-times a discretionary rest are looking at ONE answer.
  //
  // Additive + optional, like `read_adherence`: a partial context builder or an
  // imported DB never synthesizes it, and it stays out of the required/array key lists.
  tomorrow_holds?: CoachRecord | null;
  next_step: CoachRecord | null;
}

export type CoachContext = CoachContextEnvelope;
export type PartialCoachContext = Partial<CoachContextEnvelope>;

export const COACH_CONTEXT_REQUIRED_KEYS = [
  "now",
  "profile",
  "location",
  "discipline",
  "training_intent",
  "endurance_capacity",
  "goal_mode",
  "day_intake",
  "memory",
  "learnings",
  "context_events",
  "directives",
  "recovery",
  "coaching_focus",
  "whole_person_trajectory",
  "what_works_for_you",
  "recent_decisions",
  "program_state",
  "program_adjustments",
  "day_read",
  "context_today",
  "next_step",
] as const satisfies readonly (keyof CoachContextEnvelope)[];

export const COACH_CONTEXT_ARRAY_KEYS = [
  "plan",
  "recent_sessions",
  "recent_activities",
  "memory",
  "learnings",
  "health",
  "context_events",
  "directives",
  "symptom_links",
  "directive_feedback",
  "checkins",
  "fueling",
  "family",
  "supplements",
  "recent_load",
  "acute_gates",
  "progression",
  "program_adjustments",
  "endurance_tests",
  "insights",
  "recent_decisions",
] as const satisfies readonly (keyof CoachContextEnvelope)[];

export function isCoachRecord(value: unknown): value is CoachRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isCoachMemory(value: unknown): value is CoachMemory {
  return isCoachRecord(value) && typeof value.id === "number" && typeof value.content === "string";
}

export function isCoachLearning(value: unknown): value is CoachLearning {
  return isCoachMemory(value) && value.kind === "learning";
}

export function isCoachContextEnvelope(value: unknown): value is CoachContextEnvelope {
  if (!isCoachRecord(value)) return false;
  for (const key of COACH_CONTEXT_REQUIRED_KEYS) {
    if (!Object.hasOwn(value, key)) return false;
  }
  for (const key of COACH_CONTEXT_ARRAY_KEYS) {
    if (!Array.isArray(value[key])) return false;
  }
  return (
    isCoachRecord(value.now) &&
    isCoachRecord(value.location) &&
    isCoachRecord(value.discipline) &&
    isCoachRecord(value.training_intent) &&
    (value.endurance_capacity == null || isCoachRecord(value.endurance_capacity)) &&
    typeof value.goal_mode === "string" &&
    isCoachRecord(value.day_intake) &&
    Array.isArray((value.day_intake as CoachRecord).entries) &&
    isCoachRecord(value.program_state) &&
    Array.isArray((value.program_state as CoachRecord).lifts) &&
    isCoachRecord(value.coaching_focus)
  );
}

export function normalizeMemoryKind(value: unknown, fallback: MemoryKind = "observation"): MemoryKind {
  return typeof value === "string" && value.trim() ? (value.trim() as MemoryKind) : fallback;
}
