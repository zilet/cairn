import type {
  ClientChatMessage,
  ClientChatResetResponse,
  ClientChatSearchHit,
  ClientChatSessionSummary,
  ClientCoachingFocus,
  ClientDayIntake,
  ClientDayRead,
  ClientExpenditureEstimate,
  ClientNextStep,
  ClientPrescription,
  ClientSessionSuggestion,
  ClientTodayAgenda,
  ClientTodayAgendaCandidate,
  ISODateString,
} from "./client.js";

export type ClientJsonObject = Record<string, unknown>;
export type ClientJsonArray = ClientJsonObject[];

export interface ClientOkResponse {
  ok: boolean;
  error?: string;
}

export interface ClientAgentJobEnvelope {
  ok: true;
  job: ClientAgentJob;
}

export interface ClientHealthResponse {
  ok: true;
  auth_required: boolean;
  version: string;
}

export interface ClientVersionResponse {
  version: string;
}

export interface ClientUpdateStatus {
  current: string;
  latest?: string | null;
  update_available?: boolean;
  html_url?: string | null;
  notes?: string | null;
  checked_at?: string | null;
  error?: string | null;
  enabled?: boolean;
}

export interface ClientRouteTask {
  key: string;
  label: string;
}

export interface ClientAgentInfo {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  env_ok?: boolean;
  usable?: boolean;
  present?: boolean;
  configured?: boolean | null;
  auth_state?: string | null;
  default_model?: string | null;
  models?: string[];
  error?: string | null;
  [key: string]: unknown;
}

export type ClientAgentConfig = ClientAgentInfo[];

export interface ClientSettings {
  onboarded?: boolean;
  enrich_enabled?: boolean;
  art_enabled?: boolean;
  proactive_enabled?: boolean;
  research_enabled?: boolean;
  bg_ops_enabled?: boolean;
  update_check_enabled?: boolean;
  garmin_last_sync_at?: string | null;
  garmin_last_sync_status?: string | null;
  agent_strategy?: string;
  agent_order?: string[];
  disabled_agents?: string[];
  agent_routes?: Record<string, string>;
  meal_prefs?: string | null;
}

export interface ClientSettingsResponse {
  settings: ClientSettings;
  agents: ClientAgentConfig;
  route_tasks: ClientRouteTask[];
  research_auto_eligible?: boolean;
}

export interface ClientAgentStats {
  runs?: number;
  ok_rate?: number | null;
  by_agent?: Array<Record<string, unknown>>;
  recent?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ClientAgentCliUpdateStatus {
  running?: boolean;
  status?: string;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  result?: unknown;
  [key: string]: unknown;
}

export interface ClientAgentProbeResponse extends ClientOkResponse {
  ok: boolean;
  version?: string | null;
  model_current?: string | null;
  update_available?: boolean | null;
  [key: string]: unknown;
}

export interface ClientAgentModelsResponse extends ClientOkResponse {
  ok: boolean;
  models: string[];
}

export interface ClientArtManifestResponse {
  ready: string[];
  enabled: boolean;
}

export interface ClientArtUsageTotals {
  images_generated: number;
  canonicalize_calls: number;
  reused: number;
  failed: number;
  est_cost_usd: number;
  est_saved_usd: number;
}

export interface ClientArtStatsResponse {
  art_enabled: boolean;
  gemini_configured: boolean;
  enabled_at: string | null;
  since_enabled: ClientArtUsageTotals;
  all_time: ClientArtUsageTotals;
  cached_assets: number;
  aliases: number;
}

export interface ClientProfile {
  id?: number;
  name?: string | null;
  sex?: string | null;
  birthdate?: string | null;
  height_in?: number | null;
  weight_lb?: number | null;
  goal_weight_lb?: number | null;
  goal_date?: string | null;
  goal_mode?: "lose" | "maintain" | "gain" | null;
  primary_discipline?: "strength" | "endurance" | "hybrid" | string | null;
  endurance_goal?: unknown;
  about_me?: string | null;
  family_prefs?: string | null;
  [key: string]: unknown;
}

export interface ClientGoalCheck {
  target_kcal?: number | null;
  target_protein_g?: number | null;
  message?: string | null;
  goal_mode?: string | null;
  expenditure?: ClientExpenditureEstimate | null;
  [key: string]: unknown;
}

export interface ClientPlanItem {
  id?: number;
  kind?: "strength" | "cardio" | string | null;
  exercise?: string | null;
  sets?: number | null;
  rep_low?: number | null;
  rep_high?: number | null;
  target_weight?: number | null;
  target_seconds?: number | null;
  notes?: string | null;
  interval_json?: unknown;
  [key: string]: unknown;
}

export interface ClientPlanDay {
  id?: number;
  day_number: number;
  name: string;
  focus?: string | null;
  items: ClientPlanItem[];
  [key: string]: unknown;
}

export interface ClientExercise {
  id?: number;
  name: string;
  muscle_group?: string | null;
  mode?: "reps" | "timed" | string | null;
  cues?: string | null;
  constraint_note?: string | null;
}

export interface ClientExerciseDetail extends ClientExercise {
  history?: unknown[];
  progress?: unknown;
}

export interface ClientExerciseExplanation {
  ok?: boolean;
  cached?: boolean;
  explanation?: string | null;
  text?: string | null;
  error?: string | null;
  [key: string]: unknown;
}

export interface ClientLoggedSet {
  id: number;
  exercise: string;
  weight?: number | null;
  reps?: number | null;
  rir?: number | null;
  duration_sec?: number | null;
  est_1rm?: number | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface ClientTrainingSession {
  id: number;
  date?: ISODateString;
  name?: string | null;
  notes?: string | null;
  finished_at?: string | null;
  sets?: ClientLoggedSet[];
  skipped?: unknown[];
  [key: string]: unknown;
}

export interface ClientActivity {
  id: number;
  type?: string | null;
  text?: string | null;
  date?: ISODateString | null;
  created_at?: string;
  enrichment_status?: string | null;
  parsed_json?: unknown;
  [key: string]: unknown;
}

export interface ClientGarminActivity {
  id: number;
  source_id?: number | null;
  activity_id?: string | null;
  date?: ISODateString | string | null;
  type?: string | null;
  name?: string | null;
  duration_min?: number | null;
  distance_km?: number | null;
  avg_hr?: number | null;
  max_hr?: number | null;
  calories?: number | null;
  training_load?: number | null;
  training_effect?: number | null;
  aerobic_te?: number | null;
  anaerobic_te?: number | null;
  te_label?: string | null;
  avg_power?: number | null;
  vo2max?: number | null;
  session_id?: number | null;
  hr_zones?: unknown;
  exercise_sets?: unknown;
  [key: string]: unknown;
}

export interface ClientGarminDailyMetric {
  id: number;
  source_id?: number | null;
  date?: ISODateString | string | null;
  resting_hr?: number | null;
  hrv_ms?: number | null;
  body_battery?: number | null;
  stress_avg?: number | null;
  sleep_score?: number | null;
  sleep_hours?: number | null;
  calories_active?: number | null;
  calories_total?: number | null;
  vo2max?: number | null;
  training_readiness?: number | null;
  [key: string]: unknown;
}

export interface ClientGarminReconcileResponse extends ClientOkResponse {
  reconciled: number;
  sessions: ClientTrainingSession[];
}

export interface ClientGarminSyncResponse extends ClientOkResponse {
  ok: boolean;
  source_id?: number | null;
  days?: number;
  activities?: number;
  daily_metrics?: number;
  error?: string;
}

export interface ClientVolumeByMuscleRow {
  muscle_group: string;
  tonnage: number;
  sets: number;
  pct: number;
}

export interface ClientVolumeByMuscleResponse {
  days: number;
  total_tonnage: number;
  by_muscle: ClientVolumeByMuscleRow[];
}

export interface ClientTrainingCalendarCell {
  date: ISODateString | string;
  lifted: boolean;
  tonnage: number;
  sets: number;
  activity: boolean;
  level: number;
}

export interface ClientTrainingCalendarResponse {
  days: number;
  cells: ClientTrainingCalendarCell[];
}

export type ClientRunZoneKey = "Z1" | "Z2" | "Z3" | "Z4" | "Z5";

export interface ClientRunZone {
  zone: ClientRunZoneKey;
  label: string;
  low_bpm: number;
  high_bpm: number;
  feel: string;
}

export interface ClientRunZones {
  available: boolean;
  max_hr: number | null;
  rest_hr: number | null;
  method: "explicit" | "age" | "garmin-observed" | "garmin-zones" | null;
  reserve: boolean;
  zones: ClientRunZone[];
  note: string;
}

export interface ClientIntervalRep {
  reps: number;
  on: string;
  off: string;
  zone: ClientRunZoneKey;
}

export interface ClientRunPlanPrescription {
  day_number: number;
  label?: string | null;
  kind_label: "easy" | "long" | "quality";
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_zone?: string | null;
  note?: string | null;
  day_name?: string | null;
  focus?: string | null;
  interval?: ClientIntervalRep[] | null;
}

export interface ClientWeeklyRunPlan {
  available: boolean;
  week_start: ISODateString | string;
  runs: ClientRunPlanPrescription[];
  rationale: string[];
  quality_focus: string | null;
  mix_summary: string;
  why: string;
}

export type ClientGroupVerdict = "advancing" | "stalling" | "building" | "maintaining";
export type ClientMuscleVolumeBand = "low" | "productive" | "high";
export type ClientMuscleTrend = "rising" | "falling" | "stable" | null;

export interface ClientGroupVaryOption {
  name: string;
  why: string;
}

export interface ClientMuscleGroupRead {
  group: string;
  label: string;
  verdict: ClientGroupVerdict;
  lead_lift: string | null;
  stalled_signal: string | null;
  vary_options: ClientGroupVaryOption[];
  volume_band: ClientMuscleVolumeBand | null;
  trend: ClientMuscleTrend;
  note: string;
}

export interface ClientMuscleGroupTrajectory {
  available: boolean;
  headline: string;
  groups: ClientMuscleGroupRead[];
}

export interface ClientTestWeekDue {
  due: boolean;
  why: string;
  key_lifts: string[];
  cadence_weeks: number;
  last_test_week: ISODateString | string | null;
}

export interface ClientDexaTarget {
  area: string;
  signal: string;
  bias: string;
  moves: string[];
  domain: "training" | "nutrition";
  path: string;
  groups: string[];
  informational: boolean;
}

export interface ClientDexaTargeting {
  available: boolean;
  targets: ClientDexaTarget[];
  lead: ClientDexaTarget | null;
  next_dexa_focus: string | null;
}

export interface ClientProgramGroupBalance {
  group: string;
  sets: number;
  band: ClientMuscleVolumeBand;
  last_trained: ISODateString | string | null;
  status: "due" | "ok" | "high";
}

export interface ClientProgramBalance {
  groups: ClientProgramGroupBalance[];
  due: string[];
  over: string[];
  summary: string;
  broad_low: boolean;
}

export interface ClientProgramAdjustment {
  kind: "progression" | "balance" | "deload" | "gap" | "cardio" | "dexa" | "test";
  title: string;
  why: string;
  exercise?: string;
  group?: string;
  suggestions?: string[];
  recovering?: boolean;
  programmed?: boolean;
}

export type ClientProgramBlockFocus = "strength" | "hypertrophy" | "endurance-base" | "peak";
export type ClientProgramBlockPhase = "accumulation" | "intensification" | "deload" | "realization";
export type ClientProgramBlockStatus = "active" | "completed" | "abandoned";

export interface ClientProgramBlock {
  id: number;
  goal: string;
  focus: ClientProgramBlockFocus;
  phase: ClientProgramBlockPhase;
  week_index: number;
  total_weeks: number;
  started_at: string;
  status: ClientProgramBlockStatus;
  created_at: string;
}

export interface ClientGuidelineEntry {
  key: string;
  keys: string[];
  body: string;
  source: string;
  url: string;
  year?: number;
}

export type ClientGuidelinesResponse =
  | { guidelines: ClientGuidelineEntry[] }
  | { marker: string; guideline: ClientGuidelineEntry | null };

export interface ClientInjuryImpactDay {
  day_number: number;
  day_name: string;
}

export interface ClientInjuryImpactSwap {
  name: string;
  muscle_group: string | null;
  mode: "reps" | "timed";
  why: string;
}

export interface ClientInjuryImpactAffected {
  exercise: string;
  muscle_group: string | null;
  mode: "reps" | "timed";
  constraint_note: string | null;
  days: ClientInjuryImpactDay[];
  swaps: ClientInjuryImpactSwap[];
}

export interface ClientInjuryImpact {
  id: number;
  title: string;
  area: string | null;
  severity: string | null;
  since: ISODateString | string | null;
  areas: string[];
  affected: ClientInjuryImpactAffected[];
}

export interface ClientInjuryImpactsResponse {
  injuries: ClientInjuryImpact[];
  count: number;
}

export type ClientExerciseNameReconcileResponse =
  | {
    ok: true;
    aligned: number;
    applied: number;
    candidates: number;
    agent?: string | null;
    tried?: unknown;
    agent_status?: string | null;
  }
  | {
    ok: false;
    error?: string;
    agent?: string | null;
    tried?: unknown;
    agent_status?: string | null;
  };

export type ClientWeekAheadDayKind = "lift" | "run" | "mixed" | "rest";

export interface ClientWeekAheadDay {
  day: string | null;
  kind: ClientWeekAheadDayKind;
  label: string;
  note?: string | null;
}

export type ClientWeekAheadResponse =
  | {
    ok: true;
    days: ClientWeekAheadDay[];
    summary: string;
    source: "deterministic";
    cached: false;
  }
  | {
    ok: true;
    days: ClientWeekAheadDay[];
    summary: string;
    source: "agent";
    cached: boolean;
    stale?: boolean;
    agent?: string | null;
  }
  | {
    ok: false;
    error?: string;
  };

export interface ClientRecentTrainingMovement {
  name: string;
  sets: number;
  best: string;
}

export interface ClientRecentTrainingFeedRow {
  kind: "strength" | "activity";
  id: number;
  date: ISODateString | string;
  at: string | null;
  title: string;
  stats: string;
  note: string | null;
  source: string | null;
  meta: Record<string, unknown>;
  detail: Record<string, unknown> | null;
  movements?: ClientRecentTrainingMovement[];
}

export interface ClientEnduranceBestValue {
  value: number;
  date: ISODateString | string;
  type: string;
}

export interface ClientEnduranceBestPace {
  distance_km: number;
  min_per_km: number;
  date: ISODateString | string;
  type: string;
}

export interface ClientSportBests {
  sport: string;
  label: string;
  count: number;
  paced: boolean;
  longest_km: ClientEnduranceBestValue | null;
  longest_min: ClientEnduranceBestValue | null;
  best_pace: ClientEnduranceBestPace[];
  best_speed_kmh: ClientEnduranceBestValue | null;
}

export interface ClientEndurancePRs {
  type: string | null;
  primary_sport: string | null;
  sports: ClientSportBests[];
  longest_km: ClientEnduranceBestValue | null;
  longest_min: ClientEnduranceBestValue | null;
  best_pace: ClientEnduranceBestPace[];
}

export interface ClientRunCompliance {
  prescribed_sessions: number;
  prescribed_km: number;
  prescribed_min: number;
  actual_sessions: number;
  actual_km: number;
  actual_min: number;
  pct_km: number | null;
  in_words: string;
}

export interface ClientCardioEffort {
  type: string;
  name: string;
  distance_km: number | null;
  duration_min: number | null;
  pace: string | null;
  avg_hr: number | null;
  source: string | null;
  zones: unknown[] | null;
}

export interface ClientEnduranceGoal {
  mode: "race" | "standing";
  event?: string | null;
  date?: ISODateString | string | null;
  label?: string | null;
  distance_km?: number | null;
  target?: string | null;
  weekly_km?: number | null;
  weekly_sessions?: number | null;
  is_race: boolean;
  days_to_race?: number | null;
  weeks_to_race?: number | null;
  phase?: "base" | "build" | "sharpen" | "taper" | "past" | null;
}

export type ClientProgramLiftStatus = "progressing" | "plateaued" | "regressing" | "maintaining" | "new";
export type ClientProgramLiftAction = "overload" | "hold" | "deload" | "vary" | "technique" | "introduce" | null;
export type ClientProgramMesoPhase = "accumulation" | "intensification" | "deload-due" | "deload" | null;

export interface ClientProgramLiftState {
  exercise: string;
  muscle_group: string | null;
  mode: "reps" | "timed";
  sessions: number;
  est_1rm: number | null;
  best_seconds: number | null;
  trend_per_wk: number | null;
  status: ClientProgramLiftStatus;
  stall_signals: string[];
  weeks_static: number | null;
  suggested_action: ClientProgramLiftAction;
  why: string;
}

export interface ClientProgramVolumeState {
  muscle_group: string;
  weekly_sets: number;
  band: "low" | "productive" | "high";
  trend: "rising" | "falling" | "stable" | null;
}

export interface ClientProgramMesocycleState {
  weeks_since_deload: number | null;
  phase: ClientProgramMesoPhase;
  acute_chronic_ratio: number | null;
  note: string;
}

export interface ClientProgramEnduranceState {
  last_week_km: number | null;
  acute_chronic_ratio: number | null;
  longest_km_4wk: number | null;
  has_quality: boolean;
  pace_trend: "improving" | "declining" | "stable" | null;
  status: "building" | "maintaining" | "detraining" | "spiking" | null;
  suggested_action: "build" | "hold" | "add-quality" | "ease" | null;
  why: string;
}

export interface ClientProgramState {
  generated_for: ISODateString | string;
  discipline: string;
  lifts: ClientProgramLiftState[];
  volume: ClientProgramVolumeState[];
  mesocycle: ClientProgramMesocycleState;
  endurance: ClientProgramEnduranceState | null;
  headline: string;
  adaptations_due: string[];
}

export type ClientPerformanceSex = "male" | "female";
export type ClientPerformanceTone = "strong" | "steady" | "watch" | "missing";
export type ClientStrengthLevel = "beginner" | "novice" | "intermediate" | "advanced" | "elite";

export interface ClientPerformanceCapacity {
  key: string;
  label: string;
  exercise: string;
  est_1rm: number;
  ratio: number;
  percentile: number;
  reference_percentile: number;
  level: ClientStrengthLevel;
  tone: ClientPerformanceTone;
  equivalent_age: number;
  age_band: string;
  to_next: { level: ClientStrengthLevel; lb: number } | null;
}

export interface ClientPerformanceImbalance {
  title: string;
  why: string;
  severity: "note" | "watch";
}

export interface ClientPerformanceTestDue {
  exercise: string;
  kind: "strength" | "core" | "grip" | "benchmark" | "endurance" | "test";
  why: string;
}

export interface ClientPerformanceLever {
  headline: string;
  why: string;
  target?: string;
}

export interface ClientPerformanceMomentumChip {
  kind: string;
  text: string;
  dir: "good" | "neutral";
}

export interface ClientPerformanceEndurance {
  vo2max: number | null;
  percentile: number | null;
  reference_percentile: number | null;
  equivalent_age: number | null;
  age_band: string | null;
  tone: ClientPerformanceTone;
  trend: string | null;
  headline: string;
}

export interface ClientPerformanceStanding {
  generated_for: ISODateString | string;
  discipline: string;
  sex: ClientPerformanceSex;
  age: number | null;
  bodyweight_lb: number | null;
  hero: { headline: string; sub: string };
  capacities: ClientPerformanceCapacity[];
  endurance: ClientPerformanceEndurance | null;
  imbalances: ClientPerformanceImbalance[];
  lever: ClientPerformanceLever | null;
  tests_due: ClientPerformanceTestDue[];
  variety: { note: string; suggestions: string[] } | null;
  momentum: { chips: ClientPerformanceMomentumChip[] };
  balance_note: string;
}

export interface ClientWeeklyStats {
  week_sets?: number;
  week_cardio?: number;
  week_cardio_km?: number;
  bodyweight?: unknown;
  goal?: unknown;
  [key: string]: unknown;
}

export interface ClientWeightRow {
  id: number;
  date?: ISODateString;
  weight_lb: number;
  note?: string | null;
  created_at?: string;
}

export interface ClientCheckin {
  id?: number;
  date?: ISODateString;
  mood?: number | null;
  energy?: number | null;
  sleep_feel?: number | null;
  soreness?: number | null;
  note?: string | null;
  [key: string]: unknown;
}

export interface ClientBloodPressureReading {
  id: number;
  measured_at?: string;
  systolic: number;
  diastolic: number;
  pulse?: number | null;
  source?: string | null;
  position?: string | null;
  note?: string | null;
  [key: string]: unknown;
}

export type ClientHealthStandingTone = "strong" | "steady" | "watch" | "missing";
export type ClientHealthStandingDirection = "younger" | "older" | "aligned" | "unknown";

export interface ClientHealthStandingMeasure {
  label: string;
  value: number | string | null;
  unit: string;
}

export interface ClientHealthStandingNextTarget {
  direction: "up" | "down";
  delta: number;
  label: string;
  equivalent_age: number;
  target_pct?: number;
  target_value?: number;
}

export interface ClientHealthStandingComparison {
  key: string;
  label: string;
  value: number;
  unit: string;
  percentile: number;
  reference_percentile: number;
  actual_age_band: string;
  reference_age_band: string;
  median?: number;
  reference_median?: number;
  equivalent_age: number;
  direction?: "higher" | "lower";
  verb?: string;
  source?: string;
  next: ClientHealthStandingNextTarget | null;
  reading?: { source?: string | null; date?: ISODateString | string | null } | null;
  estimated?: boolean;
  measured_value?: number | null;
  as_of?: string | null;
}

export interface ClientHealthStandingDimension {
  id: string;
  tone: ClientHealthStandingTone | string;
  label: string;
  headline: string;
  body: string;
  measures: Array<ClientHealthStandingMeasure | null>;
}

export interface ClientHealthStandingRegionalNote {
  kind?: string;
  tone?: ClientHealthStandingTone | string;
  text: string;
}

export interface ClientHealthStandingBodyComp {
  measured: { value: number; date: ISODateString | string | null };
  estimated: { value: number; as_of: string } | null;
  fat_mass: { dexa: number | null; est_now: number | null; delta_lbs: number | null } | null;
  trunk_fat_pct: number | null;
  weight?: { current: number | null; at_scan: number | null };
  trend?: string | null;
  note: string;
  regional: {
    visceral_fat_lbs?: number | null;
    almi?: number | null;
    ffmi?: number | null;
    bmd_total?: number | null;
    t_score?: number | null;
    z_score?: number | null;
    android_gynoid?: number | null;
    fat?: Record<string, number | null>;
    lean?: Record<string, number | null>;
    notes?: ClientHealthStandingRegionalNote[];
    [key: string]: unknown;
  } | null;
  effective?: number;
}

export interface ClientHealthStandingBloodPressurePoint {
  systolic: number;
  diastolic: number;
  at?: string | null;
}

export interface ClientHealthStandingBloodPressure {
  latest: ClientBloodPressureReading | null;
  recent: ClientBloodPressureReading[];
  category: "optimal" | "elevated" | "high" | "low" | null;
  label: string;
  tone: "strong" | "steady" | "watch";
  trajectory: {
    from: ClientHealthStandingBloodPressurePoint;
    to: ClientHealthStandingBloodPressurePoint;
    dir: "improving" | "rising" | "holding";
  } | null;
  read: string;
  note: string;
}

export interface ClientHealthStandingBiologicalAge {
  value: number;
  delta: number | null;
  source: string;
  date: ISODateString | string | null;
}

export interface ClientHealthStandingLeadLever {
  headline: string;
  group: string;
  why: string;
  move: string | null;
  markers: unknown[];
  marker: unknown | null;
  tier?: unknown;
  uncertain: boolean;
}

export interface ClientHealthStandingMomentum {
  has_momentum: boolean;
  chips: Array<{ kind: string; text: string; dir: string }>;
  summary: string;
}

export interface ClientHealthStanding {
  generated_at: string;
  subject: {
    age: number | null;
    sex: "male" | "female";
    reference_age: number;
    reference_age_band: string;
  };
  headline: string;
  hero: {
    calendar_age: number | null;
    biological_age: number | null;
    biological_age_source: string;
    biological_age_delta: number | null;
    direction: ClientHealthStandingDirection | string;
    headline: string;
  };
  biological_age: ClientHealthStandingBiologicalAge | null;
  momentum: ClientHealthStandingMomentum;
  lead_lever: ClientHealthStandingLeadLever | null;
  body_comp: ClientHealthStandingBodyComp | null;
  balance: string;
  signal_age: number | null;
  signal_age_label: string | null;
  confidence: string;
  comparisons: ClientHealthStandingComparison[];
  dimensions: ClientHealthStandingDimension[];
  blood_pressure: ClientHealthStandingBloodPressure;
  sources: string[];
}

export interface ClientFoodNote {
  id: number;
  meal?: string | null;
  raw?: string | null;
  summary?: string | null;
  parsed?: unknown;
  kcal?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  fiber_g?: number | null;
  enrichment_status?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface ClientFrequentFood {
  meal?: string | null;
  summary: string;
  count: number;
  parsed?: unknown;
  [key: string]: unknown;
}

export interface ClientMealPlan {
  id: number;
  status?: string;
  title?: string | null;
  parsed?: unknown;
  parsed_json?: unknown;
  created_at?: string;
  [key: string]: unknown;
}

export interface ClientProposal {
  id: number;
  kind?: string;
  title?: string;
  status?: string;
  parsed?: unknown;
  parsed_json?: unknown;
  created_at?: string;
  [key: string]: unknown;
}

export interface ClientProposalResult {
  ok?: boolean;
  proposal?: ClientProposal;
  applied?: unknown;
  error?: string;
  [key: string]: unknown;
}

export interface ClientMealPlanDraftResponse extends ClientOkResponse {
  ok: boolean;
  plan?: ClientMealPlan;
  verified?: unknown;
  agent_status?: string;
  [key: string]: unknown;
}

export interface ClientMealSwapResponse extends ClientOkResponse {
  ok: boolean;
  plan?: ClientMealPlan;
  meal?: unknown;
  agent_status?: string;
  [key: string]: unknown;
}

export interface ClientMealRecipeResponse extends ClientOkResponse {
  ok: boolean;
  recipe?: unknown;
  cached?: boolean;
  agent_status?: string;
  [key: string]: unknown;
}

export interface ClientHealthDocument {
  id: number;
  kind?: string | null;
  doc_date?: ISODateString | null;
  original_name?: string | null;
  mime?: string | null;
  enrichment_status?: string | null;
  created_at?: string;
  parsed_json?: unknown;
  [key: string]: unknown;
}

export interface ClientHealthMarker {
  name: string;
  canonical_name?: string;
  value?: number | string | null;
  unit?: string | null;
  flag?: string | null;
  date?: ISODateString | null;
  history?: unknown[];
  [key: string]: unknown;
}

export interface ClientDirective {
  id: number;
  domain?: string;
  marker?: string | null;
  title?: string;
  status?: "active" | "resolved" | "dismissed" | string;
  stale?: boolean;
  acute?: boolean;
  age_days?: number | null;
  [key: string]: unknown;
}

export interface ClientPriorityMarkersResponse {
  flagged_count?: number;
  markers: ClientHealthMarker[];
  groups?: unknown[];
}

export interface ClientRecoverySummary {
  has_data?: boolean;
  sources?: string[];
  recovery?: {
    avg_sleep_min?: number | null;
    avg_deep_sleep_min?: number | null;
    avg_rem_sleep_min?: number | null;
    avg_resting_hr?: number | null;
    avg_hrv_ms?: number | null;
    hrv_status?: string | null;
    avg_stress?: number | null;
    avg_body_battery?: number | null;
    avg_respiration?: number | null;
    avg_spo2?: number | null;
    skin_temp_dev_c?: number | null;
    avg_training_readiness?: number | null;
    vo2max?: number | null;
    training_status?: string | null;
    avg_steps?: number | null;
    weight_kg?: number | null;
    body_fat_pct?: number | null;
    muscle_mass_kg?: number | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface ClientDirectivesResponse {
  directives: ClientDirective[];
}

export interface ClientEvidenceRow {
  claim?: string;
  source_title?: string;
  source_url?: string;
  body?: string;
  confidence?: string | number | null;
  retrieved_at?: string | null;
  marker?: string | null;
  [key: string]: unknown;
}

export interface ClientEvidenceSummary {
  enabled?: boolean;
  total: number;
  markers: Array<{ marker: string; count: number }>;
  [key: string]: unknown;
}

export interface ClientHealthSynthesisResponse {
  synthesis: ClientJsonObject | null;
  focus: ClientJsonObject;
  stale: boolean;
}

export interface ClientHealthReview {
  id?: number;
  status?: string;
  parsed?: unknown;
  created_at?: string;
  [key: string]: unknown;
}

export interface ClientContextEvent {
  id: number;
  kind: string;
  title?: string | null;
  detail?: string | null;
  start_date?: ISODateString | null;
  end_date?: ISODateString | null;
  archived?: boolean | number;
  meta?: unknown;
  [key: string]: unknown;
}

export interface ClientFamilyMember {
  id: number;
  name: string;
  color?: string | null;
  relationship?: string | null;
  birthdate?: string | null;
  notes?: string | null;
  allergies?: string | null;
  dietary_restrictions?: string | null;
  [key: string]: unknown;
}

export interface ClientSupplement {
  id: number;
  name: string;
  dose?: string | null;
  active?: boolean | number;
  [key: string]: unknown;
}

export type ClientMemoryKind =
  | "note"
  | "preference"
  | "constraint"
  | "goal"
  | "fact"
  | "observation"
  | "injury"
  | "decision"
  | "milestone"
  | "learning"
  | "reaction"
  | string;

export interface ClientMemory {
  id: number;
  content: string;
  kind?: ClientMemoryKind | null;
  source?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  superseded_by?: number | null;
  confidence?: number | null;
  last_referenced_at?: string | null;
}

export interface ClientMemorySupersedeResponse {
  superseded: ClientMemory;
  replacement: ClientMemory | null;
}

export interface ClientOutcomeLearning {
  id: number;
  content: string;
  noticed_at: string | null;
}

export interface ClientOutcomeLearningsResponse {
  learnings: ClientOutcomeLearning[];
}

export type ClientLearnedKind = "memory" | "learning" | "directive" | "applied" | "about_me" | "outcome";

export interface ClientLearnedItem {
  when: string;
  kind: ClientLearnedKind;
  title: string;
  detail?: string;
  source?: string;
}

export interface ClientLearnedTimeline {
  items: ClientLearnedItem[];
}

export interface ClientInsight {
  id: number;
  title?: string | null;
  text?: string | null;
  status?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface ClientInsightGenerateResponse extends ClientOkResponse {
  ok: boolean;
  found?: boolean;
  insight?: ClientInsight;
  agent_status?: string;
  [key: string]: unknown;
}

export interface ClientAgentJob {
  id: number;
  kind: string;
  status: "queued" | "running" | "done" | "error" | "canceled" | string;
  phase?: string | null;
  progress?: number | null;
  result?: unknown;
  error?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export type ClientSessionSuggestResponse =
  | {
    ok: true;
    session: ClientSessionSuggestion;
    verified?: unknown;
    agent?: string | null;
    tried?: unknown;
    agent_status?: unknown;
  }
  | {
    ok: false;
    error?: string;
    agent?: string | null;
    tried?: unknown;
    agent_status?: unknown;
  }
  | ClientAgentJobEnvelope;

export interface ClientAgentJobsResponse {
  ok: boolean;
  jobs: ClientAgentJob[];
}

export interface ClientAgentJobResponse {
  ok: boolean;
  job: ClientAgentJob | null;
  error?: string;
}

export interface ClientChatTurn {
  id: number;
  status: "queued" | "running" | "done" | "error" | "canceled" | string;
  phase?: string | null;
  progress?: number | null;
  user_message_id?: number | null;
  assistant_message_id?: number | null;
  error?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface ClientChatPostResponse {
  ok: true;
  turn: ClientChatTurn;
  user_message: ClientChatMessage;
}

export interface ClientChatTurnCancelResponse {
  ok: boolean;
  turn: ClientChatTurn | null;
}

export interface ClientDeleteResponse {
  ok?: boolean;
  deleted?: number;
  removed?: number;
  error?: string;
  [key: string]: unknown;
}

export interface ClientApiResponses {
  "/api/health": ClientHealthResponse;
  "/api/version": ClientVersionResponse;
  "/api/update-status": ClientUpdateStatus;
  "/api/update-check": ClientUpdateStatus;
  "/api/settings": ClientSettingsResponse;
  "/api/agents": ClientAgentConfig;
  "/api/agent-stats": ClientAgentStats;
  "/api/agent-clis/update": ClientAgentCliUpdateStatus;
  "/api/art/manifest": ClientArtManifestResponse;
  "/api/art/stats": ClientArtStatsResponse;
  "/api/profile": ClientProfile;
  "/api/goal": ClientGoalCheck;
  "/api/bodyweight": ClientWeightRow[];
  "/api/blood-pressure": ClientBloodPressureReading[];
  "/api/checkins": ClientCheckin[] | ClientCheckin | null;
  "/api/plan": ClientPlanDay[];
  "/api/exercises": ClientExercise[];
  "/api/exercises/reconcile-names": ClientExerciseNameReconcileResponse;
  "/api/sessions": ClientTrainingSession[] | ClientTrainingSession | null;
  "/api/sessions/skip": ClientOkResponse;
  "/api/sets": ClientLoggedSet;
  "/api/last-set": ClientLoggedSet | null;
  "/api/activities": ClientActivity[];
  "/api/agent/run": ClientProposalResult | ClientAgentJobEnvelope;
  "/api/garmin/daily": ClientGarminDailyMetric[];
  "/api/garmin/unreconciled": ClientGarminActivity[];
  "/api/garmin/reconcile": ClientGarminReconcileResponse;
  "/api/garmin/sync": ClientGarminSyncResponse;
  "/api/recent-training": ClientRecentTrainingFeedRow[];
  "/api/stats": ClientWeeklyStats;
  "/api/endurance-prs": ClientEndurancePRs;
  "/api/run-compliance": ClientRunCompliance;
  "/api/cardio": ClientCardioEffort[];
  "/api/endurance-goal": ClientEnduranceGoal | null;
  "/api/volume": ClientVolumeByMuscleResponse;
  "/api/calendar": ClientTrainingCalendarResponse;
  "/api/today-read": ClientDayRead;
  "/api/today-read/reshape": ClientDayRead | { ok: true; job: ClientAgentJob };
  "/api/session-suggest": ClientSessionSuggestResponse;
  "/api/week-ahead": ClientWeekAheadResponse;
  "/api/today-agenda": ClientTodayAgenda;
  "/api/learned-timeline": ClientLearnedTimeline;
  "/api/since-last": ClientTodayAgendaCandidate | null;
  "/api/guidelines": ClientGuidelinesResponse;
  "/api/nutrition/day": ClientDayIntake;
  "/api/next-step": ClientNextStep | null;
  "/api/nutrition/expenditure": ClientExpenditureEstimate;
  "/api/nutrition/checkin": ClientProposalResult;
  "/api/coach/mealplan": ClientMealPlanDraftResponse | ClientAgentJobEnvelope;
  "/api/mealplans": ClientMealPlan[];
  "/api/food-notes": ClientFoodNote[] | ClientFoodNote;
  "/api/frequent-foods": ClientFrequentFood[];
  "/api/proposals": ClientProposal[];
  "/api/program/evolve": ClientProposalResult | ClientAgentJobEnvelope;
  "/api/program/progression": ClientPrescription[];
  "/api/program/progression/apply": ClientProposalResult;
  "/api/program/balance": ClientProgramBalance;
  "/api/program/adjustments": ClientProgramAdjustment[];
  "/api/program/blocks": ClientProgramBlock[] | ClientProgramBlock;
  "/api/program/blocks/active": ClientProgramBlock | null;
  "/api/program-state": ClientProgramState;
  "/api/performance": ClientPerformanceStanding;
  "/api/run-plan": ClientWeeklyRunPlan;
  "/api/run-zones": ClientRunZones;
  "/api/muscle-trajectory": ClientMuscleGroupTrajectory;
  "/api/test-week": ClientTestWeekDue;
  "/api/dexa-targeting": ClientDexaTargeting;
  "/api/program/run-plan/apply": ClientProposalResult;
  "/api/coaching-focus": ClientCoachingFocus;
  "/api/health/markers": ClientHealthMarker[];
  "/api/markers/priority": ClientPriorityMarkersResponse;
  "/api/health/standing": ClientHealthStanding;
  "/api/health/review": ClientHealthReview | null;
  "/api/health/synthesis": ClientHealthSynthesisResponse;
  "/api/directives": ClientDirectivesResponse;
  "/api/directives/derive": ClientDirectivesResponse & { ok: true; derived: number };
  "/api/markers/reconcile": ClientOkResponse & { merges?: unknown[] };
  "/api/recovery": ClientRecoverySummary;
  "/api/symptom-links": { links: unknown[] };
  "/api/evidence": ClientEvidenceRow[];
  "/api/evidence/summary": ClientEvidenceSummary;
  "/api/insights": ClientInsight[];
  "/api/insights/generate": ClientInsightGenerateResponse | ClientAgentJobEnvelope;
  "/api/health-docs": ClientHealthDocument[];
  "/api/context-events": ClientContextEvent[];
  "/api/injury-impacts": ClientInjuryImpactsResponse;
  "/api/family": ClientFamilyMember[];
  "/api/learnings": ClientOutcomeLearningsResponse;
  "/api/memory": ClientMemory[] | ClientMemory;
  "/api/supplements": ClientSupplement[];
  "/api/supplements/understand": { ok: true; supplements: ClientSupplement[] };
  "/api/onboard": ClientOkResponse;
  "/api/chat": ClientChatMessage[] | ClientChatPostResponse;
  "/api/chat/sessions": ClientChatSessionSummary[];
  "/api/chat/sessions/:sessionId": ClientChatMessage[];
  "/api/chat/search": ClientChatSearchHit[];
  "/api/chat/turns": ClientChatTurn[];
  "/api/chat/reset": ClientChatResetResponse;
  "/api/agent-jobs": ClientAgentJobsResponse;
}

export type ClientApiCanonicalPath = keyof ClientApiResponses;

export type ClientApiPath = ClientApiCanonicalPath extends `/api${infer Path}` ? Path : never;

type ClientApiResponseForCleanPath<Path extends string> =
  `/api${Path}` extends keyof ClientApiResponses ? ClientApiResponses[`/api${Path}`]
    : Path extends `/plan/${string}/target` ? ClientPlanItem
      : Path extends `/plan/${string}` ? ClientPlanDay | ClientDeleteResponse
        : Path extends `/exercises/${string}` ? ClientExercise | ClientDeleteResponse
          : Path extends `/exercise/${string}/explanation` ? ClientExerciseExplanation
            : Path extends `/exercise/${string}` ? ClientExerciseDetail
              : Path extends `/sessions/${string}/finish` ? ClientTrainingSession
                : Path extends `/sessions/${string}/reopen` ? ClientTrainingSession
                  : Path extends `/sessions/${string}/notes` ? ClientTrainingSession
                    : Path extends `/sessions/${string}/feedback` ? ClientJsonObject | null
                      : Path extends `/sessions/${string}` ? ClientTrainingSession
                        : Path extends `/sets/${string}` ? ClientLoggedSet | ClientDeleteResponse
                          : Path extends `/progress/${string}` ? ClientJsonObject
                            : Path extends `/activities/${string}` ? ClientActivity
                              : Path extends `/mealplans/${string}/accept` ? ClientMealPlan
                                : Path extends `/mealplans/${string}/discard` ? ClientMealPlan
                                  : Path extends `/meal-plans/${string}/swap` ? ClientMealSwapResponse | ClientAgentJobEnvelope
                                    : Path extends `/meal-plans/${string}/recipe` ? ClientMealRecipeResponse | ClientAgentJobEnvelope
                                      : Path extends `/meal-plans/${string}/days` ? ClientMealPlan
                                        : Path extends `/food-notes/${string}` ? ClientFoodNote | ClientDeleteResponse
                                          : Path extends `/proposals/${string}/apply` ? ClientProposalResult
                                            : Path extends `/proposals/${string}/discard` ? ClientProposal
                                              : Path extends `/program/blocks/${string}` ? ClientProgramBlock
                                                : Path extends `/directives/${string}` ? { ok: true; directive: ClientDirective }
                                                  : Path extends `/insights/${string}` ? ClientInsight
                                                    : Path extends `/health-docs/${string}/reanalyze` ? ClientHealthDocument
                                                      : Path extends `/health-docs/${string}` ? ClientHealthDocument | ClientDeleteResponse
                                                        : Path extends `/context-events/${string}` ? ClientContextEvent | ClientDeleteResponse
                                                          : Path extends `/family/${string}` ? ClientFamilyMember | ClientDeleteResponse
                                                            : Path extends `/memory/${string}/supersede` ? ClientMemorySupersedeResponse
                                                              : Path extends `/memory/${string}` ? ClientMemory | ClientDeleteResponse
                                                                : Path extends `/supplements/${string}` ? ClientSupplement | ClientDeleteResponse
                                                                  : Path extends `/chat/sessions/${string}` ? ClientChatMessage[]
                                                                    : Path extends `/chat/turns/${string}/cancel` ? ClientChatTurnCancelResponse
                                                                      : Path extends `/chat/turns/${string}` ? ClientChatTurn | null
                                                                        : Path extends `/agent-jobs/${string}/cancel` ? ClientAgentJobResponse
                                                                          : Path extends `/agent-jobs/${string}` ? ClientAgentJobResponse
                                                                            : Path extends `/agents/${string}/info` ? ClientAgentProbeResponse
                                                                              : Path extends `/agents/${string}/models` ? ClientAgentModelsResponse
                                                                                : unknown;

export type ClientApiResponse<Path extends string> =
  Path extends `/api${infer Rest}` ? ClientApiResponse<Rest>
    : Path extends `${infer Base}?${string}` ? ClientApiResponseForCleanPath<Base>
      : ClientApiResponseForCleanPath<Path>;
