export type CoachRecord = Record<string, unknown>;

export interface CoachNowContext {
  date?: string;
  weekday?: string;
  time?: string;
  part_of_day?: string;
  [key: string]: unknown;
}

export interface CoachMemory {
  id?: number;
  kind?: string;
  content?: string;
  source?: string | null;
  created_at?: string;
  updated_at?: string | null;
  last_referenced_at?: string | null;
  [key: string]: unknown;
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

export interface CoachProgramState {
  headline?: string;
  discipline?: string;
  lifts: CoachRecord[];
  volume: unknown[];
  mesocycle?: unknown;
  endurance?: unknown;
  adaptations_due: unknown[];
}

export interface CoachAdjustment {
  kind?: string;
  title?: string;
  why?: string;
  exercise?: string;
}

export interface CoachContextEnvelope {
  now: CoachNowContext;
  profile: CoachRecord | null;
  discipline: { primary: string; endurance_sport: string | null };
  endurance_goal: unknown;
  goal: unknown;
  goal_mode: "lose" | "maintain" | "gain";
  day_intake: CoachDayIntake;
  plan: unknown[];
  recent_sessions: unknown[];
  recent_activities: unknown[];
  training_signals: unknown;
  garmin: unknown;
  memory: CoachMemory[];
  learnings: CoachMemory[];
  health: unknown[];
  health_review: unknown;
  context_events: unknown[];
  directives: unknown[];
  health_focus: unknown;
  coaching_focus: unknown;
  symptom_links: unknown[];
  health_synthesis: unknown;
  directive_feedback: unknown[];
  recovery: unknown;
  checkins: unknown[];
  family: unknown[];
  supplements: unknown[];
  run_compliance: unknown;
  program_block: unknown;
  program_state: CoachProgramState;
  performance: unknown;
  program_balance: unknown;
  recent_load: unknown[];
  progression: unknown[];
  program_adjustments: CoachAdjustment[];
  run_zones: unknown;
  run_plan: unknown;
  run_variety: unknown;
  endurance_tests: unknown[];
  groups_trajectory: unknown;
  test_week: unknown;
  dexa_targeting: unknown;
  day_read: unknown;
  insights: CoachRecord[];
  reaction_model: unknown;
  trajectory: unknown;
  context_today: unknown;
  next_step: unknown;
}

export type CoachContext = CoachContextEnvelope;
export type PartialCoachContext = Partial<CoachContextEnvelope>;
