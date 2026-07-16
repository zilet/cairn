import type { CoachingFocus } from "../repo/coaching-focus.js";
import type { MemoryKind, MemoryRow, RecentLearning } from "../repo/memory.js";
import type { UnifiedSignalState } from "../repo/signal-state.js";

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

export type CoachPersonalModifierTarget =
  | "nutrition_step"
  | "training_progression_step"
  | "recovery_adjustment"
  | "plan_complexity";

export type CoachPersonalSafetyGuardrail = "injury" | "allergy" | "clinical" | "lean_safe";

export interface CoachPersonalModifier {
  key: string;
  target: CoachPersonalModifierTarget;
  stage: string | null;
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
  discipline: CoachDiscipline;
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
  progression: CoachRecord[];
  strength_journey: CoachRecord | null;
  program_adjustments: CoachAdjustment[];
  run_zones: CoachRecord | null;
  run_plan: CoachRecord | null;
  run_variety: CoachRecord | null;
  endurance_tests: CoachRecord[];
  groups_trajectory: CoachRecord | null;
  test_week: CoachRecord | null;
  dexa_targeting: CoachRecord | null;
  day_read: CoachRecord | null;
  insights: CoachRecord[];
  reaction_model: CoachRecord | null;
  what_works_for_you: CoachWhatWorksForYou | null;
  recent_decisions: CoachRecord[];
  trajectory: CoachRecord | null;
  whole_person_trajectory: CoachRecord | null;
  context_today: CoachRecord | null;
  next_step: CoachRecord | null;
}

export type CoachContext = CoachContextEnvelope;
export type PartialCoachContext = Partial<CoachContextEnvelope>;

export const COACH_CONTEXT_REQUIRED_KEYS = [
  "now",
  "profile",
  "discipline",
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
    isCoachRecord(value.discipline) &&
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
