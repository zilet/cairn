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
  ClientNutritionProgress,
  ClientPrescription,
  ClientSessionSuggestion,
  ClientSessionSuggestionItem,
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

export interface ClientTodayAgendaAckResponse extends ClientOkResponse {
  id: string;
  revision?: string;
  stale?: boolean;
}

// One failed agent attempt recorded by the propose→apply loop (`runAgentWithFallback`
// → `runChosen`): every agentic op that can fall through a rotation carries this as
// its `tried` list so a surface can say which CLIs were attempted before giving up.
export interface ClientAgentAttempt {
  agent: string;
  error: string;
}

// The optional post-draft guardrail check (`runVerify`): present when an agentic
// draft was re-run against the non-negotiable floors, `null`/absent when verification
// was unavailable and the draft shipped as-is. `adjustments` is empty when nothing
// needed fixing.
export interface ClientAgentVerification {
  checked: boolean;
  adjustments: string[];
}

export interface ClientAgentJobEnvelope {
  ok: true;
  job: ClientAgentJob;
}

export interface ClientBuildInfo {
  version: string;
  build_sha: string | null;
  build_source: "environment" | "git" | "fallback";
  build_id: string;
}

export interface ClientHealthResponse {
  ok: true;
  auth_required: boolean;
  version: string;
  build: ClientBuildInfo;
}

export interface ClientReadinessResponse {
  ok: boolean;
  database: "ok" | "unavailable";
  queues?: {
    agent_jobs: { queued: number; running: number; oldest_age_sec: number | null; failed_24h: number };
    chat_turns: { queued: number; running: number; oldest_age_sec: number | null; failed_24h: number };
  };
  build?: ClientBuildInfo;
  scheduler?: { status: "starting" | "fresh" | "stale"; last_at: string | null; age_sec: number | null };
}

export interface ClientDiagnosticEvent {
  id: number;
  source: string;
  kind: string;
  level: string;
  operation: string | null;
  route: string | null;
  status: number | null;
  duration_ms: number | null;
  request_id: string | null;
  fingerprint: string;
  message: string | null;
  stack: string | null;
  metadata: Record<string, unknown> | null;
  release: string | null;
  occurrence_count: number;
  first_seen: string;
  created_at: string;
}

export interface ClientDiagnosticIssue {
  fingerprint: string;
  source: string;
  kind: string;
  level: string;
  route: string | null;
  operation: string | null;
  status: number | null;
  count: number;
  first_seen: string;
  last_seen: string;
  message: string | null;
  release: string | null;
}

export interface ClientDiagnosticsResponse {
  build: ClientBuildInfo;
  window_days: number;
  total: number;
  by_source: Record<string, number>;
  by_kind: Record<string, number>;
  by_route: Array<{ route: string; count: number }>;
  issues: ClientDiagnosticIssue[];
  recent: ClientDiagnosticEvent[];
  slow: ClientDiagnosticEvent[];
  current_build: {
    scope: "current_build";
    build_id: string;
    release: string;
    total: number;
    prior_build_total: number;
    issues: ClientDiagnosticIssue[];
    recent: ClientDiagnosticEvent[];
    slow: ClientDiagnosticEvent[];
  };
  performance: {
    build_id: string;
    window_days: number;
    requests: number;
    avg_ms: number | null;
    p50_ms: number | null;
    p95_ms: number | null;
    max_ms: number | null;
    observed_hours: number;
    throughput_per_hour: number;
    traffic: { product: number; internal: number };
    by_protocol: Record<string, number>;
    top_routes: Array<{
      protocol: string;
      method: string;
      route: string;
      requests: number;
      errors: number;
      avg_ms: number | null;
      p50_ms: number | null;
      p95_ms: number | null;
      max_ms: number;
    }>;
  };
  storage: {
    diagnostic_events: { rows: number; retention_days: number; row_cap: number };
    request_metric_buckets: { rows: number; retention_days: number; row_cap: number };
  };
}

export interface ClientVersionResponse {
  version: string;
  build: ClientBuildInfo;
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

export interface ClientAppleHealthConfig {
  available: boolean;
  install_url: string | null;
  shortcut_name: string | null;
  help_url: string;
  pairing_available: boolean;
}

export interface ClientAppleHealthConnection {
  id: number;
  label: string;
  shortcut_version: string | null;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  status: "connected" | "expired" | "revoked";
}

export interface ClientAppleHealthConnectionsResponse {
  connections: ClientAppleHealthConnection[];
}

export interface ClientAppleHealthPairingResponse {
  id: number;
  code: string;
  label: string;
  shortcut_version: string | null;
  created_at: string;
  expires_at: string;
}

export interface ClientAppleHealthConnectionRevokeResponse {
  ok: true;
  id: number;
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
  coach_day?: number;
  coach_hour?: number;
  time_zone?: string | null;
}

export interface ClientSettingsResponse {
  settings: ClientSettings;
  agents: ClientAgentConfig;
  route_tasks: ClientRouteTask[];
  research_auto_eligible?: boolean;
}

export interface ClientAgentStats {
  build_id?: string;
  runs?: number;
  ok_rate?: number | null;
  by_agent?: Array<Record<string, unknown>>;
  recent?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ClientBrainDecisionSummary {
  id: number;
  created_at?: string;
  effective_date?: string | null;
  kind: string;
  domain: string;
  summary: string;
  rationale?: string | null;
  status: string;
  autonomy_tier: string;
  reversible: boolean;
  latest_verdict?: string | null;
}

export interface ClientBrainToolCall {
  id: number;
  run_id: string;
  op: string;
  tool: string;
  args_summary?: string | null;
  rows_returned?: number | null;
  latency_ms?: number | null;
  status?: string | null;
  created_at: string;
}

export interface ClientBrainConferenceDiagnostics {
  jobs?: number;
  /** Compatibility aggregate: complete plus useful degraded/incomplete results. */
  successful?: number;
  complete_successful?: number;
  useful_degraded_or_incomplete?: number;
  degraded?: number;
  incomplete?: number;
  [key: string]: unknown;
}

export interface ClientBrainDiagnosticsMetrics {
  conferences?: ClientBrainConferenceDiagnostics;
  [key: string]: unknown;
}

export interface ClientBrainDiagnostics {
  metrics?: ClientBrainDiagnosticsMetrics;
  decisions: ClientBrainDecisionSummary[];
  tool_calls: ClientBrainToolCall[];
}

export interface ClientAgentCliUpdateStatus {
  running?: boolean;
  status?: string;
  agents?: string[];
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  stdout_tail?: string;
  stderr_tail?: string;
  result?: unknown;
}

export interface ClientAgentProbeResponse extends ClientOkResponse {
  ok: boolean;
  version?: string | null;
  model_current?: string | null;
  update_available?: boolean | null;
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
  age?: number | null;
  sex?: string | null;
  birthdate?: string | null;
  height_in?: number | null;
  weight_lb?: number | null;
  goal_weight_lb?: number | null;
  goal_date?: string | null;
  goal_mode?: "lose" | "maintain" | "gain" | null;
  start_weight_lb?: number | null;
  start_date?: string | null;
  goal_bodyfat_pct?: number | null;
  primary_discipline?: "strength" | "endurance" | "hybrid" | string | null;
  endurance_sport?: string | null;
  endurance_goal?: ClientEnduranceGoal | null;
  training_intent_json?: string | null;
  about_me?: string | null;
  home_location?: string | null;
  family_prefs?: string | null;
  smoking?: number | null;
  bp_treated?: number | null;
  statin?: number | null;
  [key: string]: unknown;
}

export type ClientJourneyPhaseKind = "cut" | "maintenance" | "diet_break" | "reverse" | "gain" | string;
export type ClientJourneyPhaseStatus = "proposed" | "active" | "completed" | "discarded" | string;
export type ClientJourneyMilestoneKind =
  | "weight_loss"
  | "goal_progress"
  | "goal_reached"
  | "bodyfat_band"
  | "bodyfat_goal"
  | string;

export interface ClientJourneyPhase {
  id?: number;
  kind: ClientJourneyPhaseKind;
  start_date?: string | null;
  end_date?: string | null;
  start_weight_lb?: number | null;
  target_weight_lb?: number | null;
  start_bodyfat_pct?: number | null;
  target_bodyfat_pct?: number | null;
  planned_rate_lb_wk?: number | null;
  status?: ClientJourneyPhaseStatus;
  reason?: string | null;
  source?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface ClientJourneyTransitionSuggestion {
  kind: ClientJourneyPhaseKind;
  reason: string;
  start_date: string;
  target_weight_lb: number | null;
  target_bodyfat_pct: number | null;
  planned_rate_lb_wk: number | null;
}

export interface ClientJourneyMilestone {
  id: string;
  kind: ClientJourneyMilestoneKind;
  label: string;
  detail: string | null;
  achieved_date: string | null;
  achieved_at: string | null;
  value: number | null;
  priority: number;
}

export interface ClientRecompositionRead {
  as_of: string;
  stage: {
    kind: "early_cut" | "mid_cut" | "leaning_out" | "stabilizing" | "maintenance" | "lean_gain" | "uncertain" | string;
    label: string;
    confidence: "low" | "medium" | "high" | string;
    basis: string[];
  };
  progress: {
    start_weight_lb: number | null;
    current_weight_lb: number | null;
    goal_weight_lb: number | null;
    lost_lb: number | null;
    remaining_lb: number | null;
    progress_fraction: number | null;
    robust_trend_lb_wk: number | null;
    target_rate: { low: number; ideal: number; high: number } | null;
    timeline: {
      earliest_weeks: number;
      likely_weeks: number;
      latest_weeks: number;
      confidence: "low" | "medium" | "high" | string;
      includes_stabilization: boolean;
    } | null;
  };
  scale: { state: string; line: string };
  muscle: { state: string; evidence: string[] };
  fuel: { state: string; evidence: string[] };
  action: {
    kind: string;
    status: "active" | "settling" | "recommended" | "holding" | string;
    label: string;
    kcal_delta: number | null;
    carb_forward: boolean;
    training_directive: string;
    autonomy: string;
    effective_boundary: string | null;
    line: string;
  };
  line: string;
  reassurance: string | null;
  evidence_keys: string[];
}

export type ClientForwardTimelineKind =
  | "goal"
  | "phase"
  | "recheck"
  | "retest"
  | "rescan"
  | "milestone"
  | "block";

export interface ClientForwardTimelineWhen {
  date?: string | null;
  window?: { start: string; end: string } | null;
}

export interface ClientForwardTimelineEntry {
  id: string;
  kind: ClientForwardTimelineKind;
  when: ClientForwardTimelineWhen;
  label: string;
  detail: string | null;
  basis: string;
}

export interface ClientJourneyRead {
  profile: {
    start_weight_lb: number | null;
    start_date: string | null;
    goal_weight_lb: number | null;
    goal_bodyfat_pct: number | null;
    goal_mode: string | null;
  } | null;
  body_fat: {
    body_fat_pct?: number | null;
    source?: string | null;
    date?: string | null;
    [key: string]: unknown;
  } | null;
  active_phase: ClientJourneyPhase | null;
  proposed_phases: ClientJourneyPhase[];
  transition_suggestion: ClientJourneyTransitionSuggestion | null;
  milestones: ClientJourneyMilestone[];
  leanness_rate?: unknown;
  recomposition: ClientRecompositionRead;
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
}

export interface ClientLoggedSet {
  id: number;
  exercise_id?: number;
  exercise: string;
  weight?: number | null;
  reps?: number | null;
  rir?: number | null;
  duration_sec?: number | null;
  est_1rm?: number | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface ClientExerciseVariation {
  name: string;
  pattern: string;
  equipment: string;
  why: string;
}

export interface ClientMovementToleranceReadiness {
  movement_key: string;
  movement_name: string;
  pain_free_exposures: number;
  /** How many of those the athlete actually spoke for (the rest were inferred). */
  stated_pain_free_exposures: number;
  /**
   * Every pain-free exposure came from training the movement quietly. Real evidence,
   * but not a confirmation — surfaces must word it as "tolerated in training … no
   * word from you yet", never as a clearance.
   */
  inferred_only: boolean;
  trial_ready: boolean;
  last_observed_on: ISODateString | string;
}

export interface ClientTrainingSymptom {
  id: number;
  source_session_id: number | null;
  source_kind: string;
  /** The SHORT derived grouping label. */
  area_text: string;
  /** The athlete's own latest words, verbatim. Null for rows predating capture. */
  report_text: string | null;
  status: "active" | "resolved";
  onset_on: ISODateString | string;
  last_reported_on: ISODateString | string;
  resolved_on: ISODateString | string | null;
  recurrence_count: number;
  legacy_unconfirmed: boolean;
  /** How live the watch is — refreshed by their words OR by quiet training. */
  freshness: "acute_movement_brake" | "hold_easy_recheck" | "stale_needs_recheck";
  /** The last day the athlete themselves said something about it. */
  last_stated_on: ISODateString | string;
  /** How current their own account is. Silence never makes this fresher. */
  stated_freshness: "acute_movement_brake" | "hold_easy_recheck" | "stale_needs_recheck";
  /** 'systemic' names no place and never gates a movement. */
  scope: "area" | "systemic";
  relevant_pain_free_exposures: number;
  trial_ready: boolean;
  trial_ready_scope: "movement";
  movement_readiness: ClientMovementToleranceReadiness[];
  // Only the batched `?movements=` relevance read fills this: which of the
  // requested movement names this symptom plausibly loads.
  relevant_movements?: string[];
}

export type ClientExerciseSymptomObservationOutcome = "pain_present" | "pain_free";

export interface ClientExerciseSymptomObservationResponse {
  ok: true;
  date: ISODateString | string;
  session_id: number;
  exercise: {
    id: number;
    name: string;
    muscle_group: string | null;
  };
  outcome: ClientExerciseSymptomObservationOutcome;
  symptom: ClientTrainingSymptom;
}

export interface ClientTrainingSession {
  id: number;
  date?: ISODateString;
  name?: string | null;
  notes?: string | null;
  finished_at?: string | null;
  sets?: ClientLoggedSet[];
  daily_session?: ClientDailySessionComposition | null;
  skipped?: unknown[];
  strength_journey_movement?: {
    exercise: string;
    current_est_1rm: number;
    current_date: ISODateString | string;
    capacity_delta_lb: number;
    gap_closed_lb: number;
  } | null;
  [key: string]: unknown;
}

export interface ClientDailySessionItem extends ClientSessionSuggestionItem {
  position: number;
  warmup_sets?: number | null;
  superset_group?: number | null;
}

export interface ClientDailySessionComposition {
  id: number;
  version: number;
  session_id: number;
  date: ISODateString | string;
  source: "adaptive_plan" | "agent_suggest" | "manual_plan" | "athlete_override";
  status: "active" | "superseded";
  plan_day_id: number | null;
  title: string | null;
  focus: string | null;
  why: string | null;
  est_minutes: number | null;
  items: ClientDailySessionItem[];
  constraints: unknown;
  provenance: unknown;
  /** The normalized daily-decision context that authored this accepted composition, when available. */
  decision?: {
    policy_version: string;
    input_fingerprint: string;
    kind: "train" | "easy" | "rest";
    baseline_kind: "train" | "easy" | "rest";
    train_anyway: boolean;
  } | null;
  created_at: string;
  superseded_at: string | null;
}

export interface ClientDailySessionPrepareRequest {
  date: ISODateString | string;
  /** Assertion-only cached composition check; when present, no source/session payload is required and no write occurs. */
  expected_active_id?: number;
  /** Compare-and-set token from the exact adaptive preview shown before Start. */
  expected_input_fingerprint?: string;
  source?: "adaptive_plan" | "agent_suggest" | "manual_plan" | "athlete_override";
  day_number?: number;
  agent_job_id?: number;
  session?: ClientSessionSuggestion;
  constraints?: unknown;
  provenance?: unknown;
  /** Explicit athlete choice to train despite the baseline read; recovery and pain caps still apply. */
  train_anyway?: boolean;
  replace?: boolean;
}

export interface ClientDailySessionPreview {
  date: ISODateString | string;
  source: "adaptive_plan";
  kind: "train" | "easy" | "rest";
  policy_version: string;
  input_fingerprint: string;
  title: string | null;
  focus: string | null;
  item_count: number;
  est_minutes: number | null;
  constraints: string[];
  primary_rationale: string;
}

export interface ClientDailySessionAthleteRead {
  learning: string;
  next_exposure: string | null;
}

export interface ClientDailySessionOutcomeRead {
  composition_id: number;
  session_id: number;
  date: ISODateString | string;
  status: "not_started" | "in_progress" | "completed";
  facts: unknown;
  athlete_read: ClientDailySessionAthleteRead | null;
}

export type ClientDailySessionPrepareResponse =
  | {
      ok: true;
      daily_session: ClientDailySessionComposition;
      session: ClientTrainingSession;
      reused: boolean;
    }
  | { ok: false; code: string; error: string; preview?: ClientDailySessionPreview };

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

// One time-in-HR-zone bucket parsed from Garmin's `hr_zones_json`
// (`[{zone,secs,low_hr}]`) — the shape summed by `mergeHrZones` and rendered by the
// Today cardio/lately zone bars.
export interface ClientHrZone {
  zone: string;
  secs: number;
  low_hr?: number | null;
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
  hr_zones?: ClientHrZone[] | null;
  exercise_sets?: Array<Record<string, unknown>> | null;
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

export interface ClientGoalPacePoint {
  date: string;
  weight_lb: number;
}

export interface ClientGoalPaceLine {
  lb_wk: number | null;
  line: [ClientGoalPacePoint, ClientGoalPacePoint] | null;
}

export interface ClientGoalPaceResponse {
  points: ClientGoalPacePoint[];
  trend: ClientGoalPaceLine;
  needed: ClientGoalPaceLine;
  goal: { weight_lb: number | null; date: string | null };
  window_days: number;
}

export interface ClientWeekWinsPr {
  exercise: string;
  label: string;
}

export interface ClientWeekWinsVolumeFilled {
  muscle: string;
  label: string;
}

export interface ClientWeekWinsResponse {
  prs: ClientWeekWinsPr[];
  trained_days_7: number;
  week_sets: number;
  volume_filled: ClientWeekWinsVolumeFilled[];
  pace: { status: "on" | "behind" | "fast" | null; label: string | null };
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

export type ClientFlexibleRunKind = "easy" | "quality" | "long";
export type ClientFlexibleRunStatus = "open" | "completed";

export interface ClientRunCompletionEvidence {
  activity_id: number;
  date: ISODateString | string;
  duration_min: number | null;
  distance_km: number | null;
  intensity: "easy" | "quality";
  signals: string[];
}

export interface ClientFlexibleRunIntent {
  id: string;
  kind: ClientFlexibleRunKind;
  label: string;
  status: ClientFlexibleRunStatus;
  provisional_day_number: number;
  provisional_date: ISODateString | string;
  window_start: ISODateString | string;
  window_end: ISODateString | string;
  suggested_date: ISODateString | string | null;
  target_distance_km: number | null;
  target_duration_min: number | null;
  target_zone: string | null;
  completion: ClientRunCompletionEvidence | null;
  rationale: string;
}

export interface ClientFlexibleTrainingAgenda {
  available: boolean;
  week_start: ISODateString | string;
  week_end: ISODateString | string;
  as_of: ISODateString | string;
  intents: ClientFlexibleRunIntent[];
  next: {
    intent_id: string;
    kind: ClientFlexibleRunKind;
    suggested_date: ISODateString | string;
    guidance: string;
  } | null;
  today_guidance: "open" | "easy_only" | "not_first_choice" | "complete";
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
      // Additive detail from the exercise-identity merge (all optional so older
      // servers and standalone branches stay valid): the duplicate rows folded
      // into one tracked movement, softer suggestions, rows deliberately left
      // alone, and how many muscle groups the tidy corrected.
      merged?: { from: string; into: string }[];
      suggested?: { from: string; into: string; why?: string; confidence?: string }[];
      skipped?: { from: string; into: string; reason: string }[];
      groups_fixed?: number;
      agent?: string | null;
      tried?: ClientAgentAttempt[] | null;
      agent_status?: string | null;
    }
  | {
      ok: false;
      error?: string;
      agent?: string | null;
      tried?: ClientAgentAttempt[] | null;
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
  zones: ClientHrZone[] | null;
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

export type ClientTrainingPriority = "longevity" | "muscle" | "leanness" | "strength" | "endurance";
export type ClientEnduranceRole = "none" | "supporting" | "co_primary" | "primary";

export interface ClientTrainingIntent {
  priorities: ClientTrainingPriority[];
  endurance_role: ClientEnduranceRole;
  endurance_capacity?: {
    sport: string;
    target_duration_min: number;
    context?: string | null;
  } | null;
  source: "explicit" | "derived";
}

export interface ClientEnduranceCapacityRead {
  status: "ready" | "building" | "rebuilding" | "no_data";
  sport: string;
  target_duration_min: number;
  as_of_date: string;
  evidence: { date: string; duration_min: number } | null;
  summary: string;
  next_step: string;
}

export interface ClientTrainingIntentResponse {
  intent: ClientTrainingIntent;
  endurance_capacity: ClientEnduranceCapacityRead | null;
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
  family_key: string;
  family_label: string;
  last_trained: string | null;
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

export interface ClientActiveRecoveryWeek {
  state: "applied";
  applied_on: ISODateString | string;
  until: ISODateString | string;
  summary: string | null;
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

export interface ClientHybridEnduranceImpact {
  date: ISODateString | string;
  days_ago: number;
  type: string;
  label: string;
  duration_min: number | null;
  distance_km: number | null;
  intensity: "easy" | "moderate" | "hard";
  load: "light" | "moderate" | "heavy";
  regions: string[];
  detail: string;
  why: string;
}

export interface ClientHybridStrengthConflict {
  day_number: number;
  day_name: string;
  focus: string | null;
  days_until: number;
  groups: string[];
  impacted_groups: string[];
  heavy_leg_day: boolean;
  advice: "ok" | "hold-load" | "swap-or-upper" | "easy-only";
  why: string;
}

export interface ClientHybridFuelRead {
  risk: "low" | "watch" | "high";
  why: string;
}

export interface ClientHybridState {
  status: "clear" | "watch" | "shift-legs" | "fuel-protect";
  headline: string;
  affected_groups: string[];
  recent_endurance: ClientHybridEnduranceImpact | null;
  next_strength: ClientHybridStrengthConflict | null;
  fuel: ClientHybridFuelRead | null;
}

export interface ClientProgramState {
  generated_for: ISODateString | string;
  discipline: string;
  lifts: ClientProgramLiftState[];
  volume: ClientProgramVolumeState[];
  mesocycle: ClientProgramMesocycleState;
  recovery_week: ClientActiveRecoveryWeek | null;
  endurance: ClientProgramEnduranceState | null;
  hybrid: ClientHybridState | null;
  headline: string;
  adaptations_due: string[];
}

export type ClientStrengthObjectiveTargetKind = "return_to_personal_best" | "explicit_est_1rm";
export type ClientStrengthJourneyPhase =
  | "establishing"
  | "rebuilding"
  | "building"
  | "consolidating"
  | "protecting"
  | "reached";

export interface ClientStrengthObjective {
  id: number;
  exercise: string;
  exercise_key: string;
  target_kind: ClientStrengthObjectiveTargetKind;
  target_est_1rm: number;
  baseline_est_1rm: number | null;
  baseline_date: ISODateString | string | null;
  source: "user";
  status: "active" | "superseded" | "completed" | "archived";
  created_at: string;
  updated_at: string;
  superseded_at: string | null;
  completed_at: string | null;
  achieved_est_1rm: number | null;
  achieved_date: ISODateString | string | null;
}

export interface ClientAnchorObjectiveSuggestion {
  exercise: string;
  target_kind: ClientStrengthObjectiveTargetKind;
  target_est_1rm: number;
  current_est_1rm: number | null;
  gap_lb: number | null;
  title: string;
  detail: string;
  basis: string;
}

export interface ClientStrengthJourney {
  available: boolean;
  objective: ClientStrengthObjective | null;
  latest: { est_1rm: number; date: ISODateString | string } | null;
  current: { est_1rm: number; date: ISODateString | string } | null;
  best: { est_1rm: number; date: ISODateString | string } | null;
  baseline: { est_1rm: number; date: ISODateString | string | null } | null;
  gap_lb: number | null;
  trend: {
    direction: "rising" | "stable" | "falling" | null;
    est_1rm_lb_per_week: number | null;
    exposures: number;
    span_days: number;
  };
  phase: ClientStrengthJourneyPhase | null;
  next_prescription: {
    exercise: string;
    action: "overload" | "hold" | "deload" | "vary" | "introduce";
    delta_text: string;
    why: string;
    suggested: {
      sets: number;
      rep_low?: number;
      rep_high?: number;
      weight?: number | null;
      seconds?: number;
    };
  } | null;
  planned_support: Array<{
    role: string;
    exercise: string;
    why: string;
    plan_day_number: number;
    plan_day_name: string;
  }>;
  support_suggestions: Array<{
    role: string;
    exercise: string;
    why: string;
    plan_day_number: number;
    plan_day_name: string;
  }>;
  projection: {
    earliest_weeks: number;
    latest_weeks: number;
    basis: string;
    caveat: string;
  } | null;
  projection_withheld_reason: string | null;
  safety: {
    load_constraint: boolean;
    recent_joint_pain: string | null;
    relevant_joint_pain: string | null;
    relevant_active_injuries: string[];
    stalled_or_regressing: boolean;
  };
  capacity_basis: string | null;
  // A reachable anchor-lift suggestion, present only when no objective exists yet.
  suggestion?: ClientAnchorObjectiveSuggestion | null;
}

// The pre-session primer (GET /api/session-primer) — a calm "a coach was already
// here" read the /app/session surface shows on open. why_today reuses the Brief's
// judgment; the three quiet sections carry what changed, what to watch, and what's
// deliberately fresh. Plain words only, never a score. `null` when there's nothing
// worth saying beyond the Brief (a bare plan day with no signals).
export interface ClientSessionPrimerChange {
  exercise: string;
  kind: "target" | "recovery_cap" | "rotation";
  text: string;
}
export interface ClientSessionPrimerWatch {
  text: string;
  soft?: boolean;
}
export interface ClientSessionPrimerFresh {
  exercise: string;
  label: "New this week" | "Fresh on your plan";
  why: string;
}
export interface ClientSessionPrimer {
  date: ISODateString | string;
  day_number: number | null;
  focus: string | null;
  why_today: string;
  changed: ClientSessionPrimerChange[];
  watch: ClientSessionPrimerWatch[];
  fresh: ClientSessionPrimerFresh[];
  approach: string | null;
  decision_fingerprint: string | null;
  decision_policy_version: string | null;
  decision_kind: "train" | "easy" | "rest" | null;
  decision_kind_label: "Training session" | "Easy session" | "Rest-day movement" | null;
  decision_bounds: string[];
  provenance_label: "Adapted for today" | "Training by choice" | null;
}

export interface ClientStrengthJourneySetResponse {
  objective: ClientStrengthObjective;
  journey: ClientStrengthJourney;
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

export interface ClientTodayAggregate {
  date: ISODateString | string;
  plan: ClientPlanDay[];
  session: ClientTrainingSession | null;
  stats: ClientWeeklyStats;
  profile: ClientProfile | null;
  exercises: ClientExercise[];
}

export interface ClientTodayPlanDaySelection {
  day_number: number;
  focus: string | null;
  source: "existing-session" | "cached-day-read" | "adaptive";
  reason: string | null;
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

// One-tap fueling read (the follow-through after a nutrition-target change). energy/hunger
// are a calm 1-3 running-low/steady/plenty scale; no scores.
export interface ClientFuelingFeedback {
  id?: number;
  date?: ISODateString;
  energy?: number | null;
  hunger?: number | null;
  note?: string | null;
  decision_id?: number | null;
  created_at?: string;
  [key: string]: unknown;
}

// The fueling follow-up due-check for today plus recent reads. `due` is the calm gate;
// most days it is false and the card stays hidden.
export interface ClientFuelingFollowup {
  due: boolean;
  decision_id: number | null;
  applied_on: string | null;
  summary: string | null;
  recent: ClientFuelingFeedback[];
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
    // Plain-language biological-age read (a direction sentence, no number) — the hero
    // renders THIS, never the raw figure (constitution: no scores on the athlete).
    bio_read?: string | null;
  };
  biological_age: ClientHealthStandingBiologicalAge | null;
  // Deterministic Levine PhenoAge from the panel (plain-language surfaces only), else null.
  pheno_age?: { value: number; delta: number; direction: string; note: string } | null;
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

// AHA PREVENT (2023) cardiovascular-risk read — see src/repo/risk.ts for the source shape.
export type ClientPreventStatus = "computed" | "computed_provisional" | "insufficient_inputs";

export interface ClientPreventAssumption {
  input: string;
  assumed: string;
  reason: string;
}

export interface ClientRiskHorizon {
  ten_year: number | null;
  thirty_year: number | null;
}

export interface ClientRiskProjectionOutcome {
  ten_year: number | null;
  thirty_year: number | null;
  vascular_age: number | null;
}

export interface ClientRiskLeverApplied {
  key: string;
  label: string;
  from: number;
  to: number;
  unit: string;
  detail: string;
}

export interface ClientPreventProjection {
  current: ClientRiskProjectionOutcome;
  targets_met: ClientRiskProjectionOutcome;
  levers_applied: ClientRiskLeverApplied[];
}

export type ClientRiskCategory = "low" | "borderline" | "intermediate" | "high";

export interface ClientPreventEstimate {
  provisional: boolean;
  assumptions: ClientPreventAssumption[];
  confidence: "provisional" | "high";
  // ACC/AHA 10-year ASCVD band (low/borderline/intermediate/high) + a plain-
  // language, whole-picture interpretation. A clinical category, NOT a 0-100
  // wellness grade. Null/empty on older payloads.
  category?: ClientRiskCategory | null;
  interpretation?: string;
  estimates: {
    total_cvd: ClientRiskHorizon;
    ascvd: ClientRiskHorizon;
    heart_failure: ClientRiskHorizon;
  };
  vascular_age: number | null;
  // A REAL recompute of PREVENT with the modifiable levers at target — genuine
  // current-vs-targets-met risk, not invented ribbon geometry. Null-safe for
  // older payloads.
  projection?: ClientPreventProjection | null;
  horizons_note: string;
  frame: string;
}

export interface ClientRiskEnhancer {
  key: string;
  label: string;
  finding: string;
  why: string;
  lever: string | null;
}

export interface ClientRiskProjection {
  key: string;
  label: string;
  current: number | null;
  target: number;
  unit: string;
  expected_direction: "lower" | "higher";
  why: string;
}

export interface ClientRiskMarker {
  label: string;
  value: number | null;
  unit: string | null;
  date: string | null;
}

export interface ClientCardiovascularRisk {
  model_status: {
    prevent: ClientPreventStatus;
    ascvd_pce: string;
    reason: string;
    next: string;
  };
  inputs: {
    age: number | null;
    sex: string | null;
    bmi: number | null;
    body_fat_pct: number | null;
    body_fat_source: string | null;
    diabetes_by_a1c: boolean | null;
    markers: Record<string, ClientRiskMarker>;
    missing_inputs: string[];
  };
  prevent: ClientPreventEstimate | null;
  enhancers: ClientRiskEnhancer[];
  projections: ClientRiskProjection[];
  frame: string;
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
  // LOCAL calendar day the meal belongs to (YYYY-MM-DD). May be earlier than the
  // day the row was written, when the entry was backdated.
  date?: string | null;
  // LOCAL wall-clock "HH:MM" (24-hour) the athlete said they ate. Null/absent
  // means unstated — the ordinary case. Never render an absent time as midnight.
  eaten_at?: string | null;
  [key: string]: unknown;
}

export interface ClientFrequentFood {
  meal?: string | null;
  summary: string;
  count: number;
  parsed?: unknown;
  [key: string]: unknown;
}

export interface ClientMealPlanConstraintState {
  status: "current" | "refresh_needed";
  fingerprint: string;
  planned_for_fingerprint: string | null;
  changed_since_planned: boolean;
  legacy_unstamped: boolean;
  reason: string | null;
  conflicts: Array<{ kind: "allergy" | "dietary"; detail: string }>;
  warnings: string[];
}

export interface ClientMealPlan {
  id: number;
  status?: string;
  title?: string | null;
  parsed?: unknown;
  parsed_json?: unknown;
  created_at?: string;
  autonomy?: ClientProposalAutonomy | null;
  constraint_state?: ClientMealPlanConstraintState | null;
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
  autonomy?: ClientProposalAutonomy | null;
  [key: string]: unknown;
}

// The autonomy layer's outcome riding on a proposal-creating response (lead round):
// applied now (lead mode, `applied` is the change list), waiting for its natural
// boundary (`pending`/`announced` with `applied:false`), or left a reviewable draft
// (tier 'ask' / review_required). Loose on purpose — the server shape is the truth.
export interface ClientProposalAutonomy {
  ok?: boolean;
  status?: "review" | "pending" | "announced" | "applied" | string;
  tier?: string;
  applied?: unknown; // false when held; the applied-change list when it landed now
  pending?: boolean;
  announced?: boolean;
  review_required?: boolean;
  review_reason_code?: string | null;
  effective_date?: string;
  reasons?: string[];
  [key: string]: unknown;
}

export interface ClientProposalResult {
  ok?: boolean;
  proposal?: ClientProposal;
  applied?: unknown;
  swapped?: unknown;
  autonomy?: ClientProposalAutonomy | null;
  error?: string;
}

export interface ClientMealPlanDraftResponse extends ClientOkResponse {
  ok: boolean;
  plan?: ClientMealPlan;
  verified?: ClientAgentVerification | null;
  autonomy?: ClientProposalAutonomy | null;
  agent_status?: string;
}

export interface ClientMealSwapResponse extends ClientOkResponse {
  ok: boolean;
  plan?: ClientMealPlan;
  meal?: unknown;
  agent_status?: string;
}

export interface ClientMealRecipeResponse extends ClientOkResponse {
  ok: boolean;
  recipe?: unknown;
  cached?: boolean;
  agent_status?: string;
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
  parsed?: ClientHealthDocumentParsed | null;
  study_files?: ClientImagingStudyFile[];
  [key: string]: unknown;
}

export interface ClientHealthDocumentParsed {
  imaging_study?: ClientImagingStudy;
  markers?: ClientHealthMarker[];
  [key: string]: unknown;
}
export interface ClientDicomImportJob {
  id: number;
  status: "queued" | "running" | "done" | "failed";
  progress?: { entries_seen?: number; instances_indexed?: number; studies_created?: number };
  warnings?: string[];
  result?: { study_ids?: number[]; instances_indexed?: number; studies_created?: number };
  error?: { code?: string };
}
export interface ClientDicomManifest {
  study_id: number;
  series: Array<{
    id: number;
    modality?: string;
    description?: string;
    previewable?: boolean;
    preview_support_reason?: string | null;
    instances: Array<{
      id: number;
      instance_number?: number;
      number_of_frames?: number;
      rows?: number;
      columns?: number;
      previewable?: boolean;
      preview_support_reason?: string | null;
      photometric_interpretation?: string | null;
      pixel_spacing?: string | null;
      image_orientation?: string | null;
      laterality?: string | null;
      [key: string]: unknown;
    }>;
  }>;
}
export interface ClientImagingStudyFile {
  id: number;
  sequence?: number;
  original_name: string;
  mime: string;
  size_bytes?: number;
  source_kind: "report" | "image" | "mychart";
  has_file?: boolean;
}
export interface ClientImagingFinding {
  id?: string;
  source?: "report" | "image_ai" | "mychart" | "patient";
  clinical_system?: string;
  body_region?: string;
  verbatim_site?: string | null;
  laterality?: string;
  finding_text?: string;
  quarantined?: boolean;
  quarantine_reason?: "image_ai_free_text_not_published" | null;
  severity?: string;
  certainty?: string;
  measurements?: Array<{
    name?: string;
    label?: string;
    value?: number | null;
    value_text?: string | null;
    unit?: string | null;
    qualifier?: string | null;
    method?: string | null;
  }>;
  source_spans?: unknown[];
}
export type ClientImagingRecommendationStatus =
  | "recommended"
  | "scheduled"
  | "completed"
  | "declined"
  | "not_needed"
  | "unknown";
export interface ClientImagingRecommendation {
  id?: string;
  source?: string;
  recommendation_text?: string;
  timeframe?: string;
  action?: string;
  status?: ClientImagingRecommendationStatus;
  source_spans?: unknown[];
}
export interface ClientImagingStudy {
  report_status?: string;
  study?: {
    modality?: string;
    raw_modality?: string;
    procedure?: string;
    accession?: string;
    study_date?: string;
    facility?: string;
    ordering_clinician?: string;
    interpreting_clinician?: string;
    [key: string]: unknown;
  };
  anatomy?: {
    clinical_system?: string;
    body_region?: string;
    verbatim_site?: string;
    laterality?: string;
    code?: string;
    [key: string]: unknown;
  };
  report?: {
    history?: string;
    technique?: string;
    comparison?: string;
    findings?: string;
    impression?: string;
    addendum?: string;
    [key: string]: unknown;
  };
  findings?: ClientImagingFinding[];
  recommendations?: ClientImagingRecommendation[];
  provenance?: unknown;
  verification?: {
    needs_confirmation?: boolean;
    user_confirmed?: boolean;
    clinician_confirmed?: boolean;
    [key: string]: unknown;
  };
  dicom?: { series?: unknown[]; [key: string]: unknown } | null;
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
  trigger_date?: string | null;
  resurfaced_from_id?: number | null;
  [key: string]: unknown;
}

// One present marker group (`presentGroups`): the canonical health-group key + its
// display label, in the conventional clinical-review order the catalog renders.
export interface ClientMarkerGroupSummary {
  key: string;
  label: string;
}

export interface ClientPriorityMarkersResponse {
  flagged_count?: number;
  markers: ClientHealthMarker[];
  groups?: ClientMarkerGroupSummary[];
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

// Personal-baseline reading bands (VISION Amendment 2). Each dimension carries a
// plain-language `phrase` and the [0,1] band geometry the client hands straight to
// `baselineBandHtml`; the raw numbers ride along for depth but never surface on
// the band row. `hot` (terracotta) marks a lever, never punishment.
//
// `position`/`current` are null when the newest reading is too old to speak for
// today: the band still draws, WITHOUT a dot (a stale reading is never placed as
// if it were current). The provenance trio then lets the client say how old the
// picture is — all three are optional so an older cached client just ignores them.
export interface ClientRecoveryBaselineDimension {
  key: "hrv" | "rhr" | "sleep";
  label: string;
  phrase: string;
  hot: boolean;
  position: number | null;
  range_start: number;
  range_end: number;
  current: number | null;
  p25: number;
  p75: number;
  n: number;
  readings?: number;
  span_days?: number | null;
  last_reading_date?: string | null;
}

export interface ClientRecoveryBaselineRead {
  dimensions: ClientRecoveryBaselineDimension[];
}

export interface ClientTrainingLoadBand {
  label: string;
  phrase: string;
  hot: boolean;
  position: number;
  range_start: number;
  range_end: number;
  current: number;
  p25: number;
  p75: number;
  n: number;
}

export interface ClientTrainingLoadBandResponse {
  band: ClientTrainingLoadBand | null;
}

export interface ClientDirectivesResponse {
  directives: ClientDirective[];
}

// One co-occurring off-marker a symptom link points at (`SymptomLinkMarker`) — the
// lab's own reading, never invented.
export interface ClientSymptomLinkMarker {
  name: string;
  value: number | string | null;
  side: string;
  unit: string | null;
  flag: string | null;
}

// A plausible, non-alarmist symptom → off-marker connection (`symptomMarkerLinks`).
export interface ClientSymptomMarkerLink {
  symptom: string;
  symptom_text: string;
  symptom_source: "context_event" | "checkin" | string;
  symptom_source_date: string | null;
  markers: ClientSymptomLinkMarker[];
  note: string;
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
  /** YYYY-MM-DD the athlete explicitly closed it (healed / over); null = still open. */
  resolved_at?: ISODateString | null;
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
  // An attributed case-conference specialist line when one is durably stored on
  // the decision ("Lab reader: ApoB is the one to move"). Optional + null-safe.
  voice?: string;
}

export interface ClientLearnedTimeline {
  items: ClientLearnedItem[];
}

// ---- the team's-week digest (GET /api/team-week) ----------------------------
export interface ClientTeamWeekChange {
  text: string;
  specialist: string | null;
  when: string;
}
export interface ClientTeamWeekDomainGroup {
  domain: string;
  label: string;
  changes: ClientTeamWeekChange[];
}
export interface ClientTeamWeekFlag {
  kind: "directive" | "review" | string;
  text: string;
  domain: string;
  when: string;
}
export interface ClientTeamWeekWatch {
  text: string;
  through: string | null;
  source: "attention" | "expectation" | string;
}
export interface ClientTeamWeekLanded {
  text: string;
  verdict: string;
  when: string;
}
export interface ClientTeamWeekInsight {
  id: number;
  text: string;
  when: string;
  backlog: boolean;
}
export interface ClientTeamWeek {
  lead: string;
  did: ClientTeamWeekDomainGroup[];
  flagged: ClientTeamWeekFlag[];
  watching: ClientTeamWeekWatch[];
  landed: ClientTeamWeekLanded[];
  insights: ClientTeamWeekInsight[];
}

// ---- Next checkup (the doctor-loop, surfaced) --------------------------------
export type ClientCheckupItemKind = "lab" | "dexa" | "review" | "add";
export interface ClientCheckupItem {
  signal_key: string;
  label: string;
  kind: ClientCheckupItemKind;
  next_due: string | null;
  when_text: string | null;
  why: string;
}
export type ClientFollowThroughStatus = "moving_your_way" | "not_yet" | "awaiting_recheck";
export type ClientFollowThroughRecheck = "due" | "upcoming" | "none";
export interface ClientFollowThroughItem {
  marker: string;
  marker_key: string;
  via: string[];
  status: ClientFollowThroughStatus;
  status_text: string;
  latest_value: string | null;
  latest_date: string | null;
  trend_dir: "rising" | "falling" | "stable" | null;
  trend_text: string | null;
  recheck: ClientFollowThroughRecheck;
  recheck_next_due: string | null;
  recheck_text: string;
}
export interface ClientCheckupOrderedLab {
  label: string;
  detail: string | null;
  source: "review" | "visit_note";
}
export interface ClientCheckupPrep {
  ordered_labs: ClientCheckupOrderedLab[];
  bring: string[];
  questions: string[];
}
export interface ClientNextCheckup {
  lede: string;
  due_now: ClientCheckupItem[];
  upcoming: ClientCheckupItem[];
  follow_through: ClientFollowThroughItem[];
  prep: ClientCheckupPrep;
  has_content: boolean;
  frame: string;
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
      verified?: ClientAgentVerification;
      agent?: string | null;
      tried?: ClientAgentAttempt[] | null;
      agent_status?: string;
    }
  | {
      ok: false;
      error?: string;
      agent?: string | null;
      tried?: ClientAgentAttempt[] | null;
      agent_status?: string;
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
}

export interface ClientBodyMeasurement {
  id: number;
  date: string;
  waist_in: number | null;
  hip_in: number | null;
  chest_in: number | null;
  shoulder_in: number | null;
  neck_in: number | null;
  thigh_in: number | null;
  upper_arm_in: number | null;
  calf_in: number | null;
  forearm_in: number | null;
  note: string | null;
  source: string | null;
  created_at?: string;
}
export interface ClientBodyIndicator {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  zone: string | null;
  tone: "ok" | "watch" | "warn" | "info";
  read: string;
  estimate?: boolean;
  needs?: string[];
}
export interface ClientBodySiteTrend {
  key: string;
  label: string;
  unit: string;
  latest: number | null;
  n: number;
  points: number[];
  slope_per_week: number | null;
  change: number | null;
  span_days: number | null;
  direction: "up" | "down" | "steady" | null;
  text: string;
}
export interface ClientBodyMetricTrends {
  window_days: number | null;
  sites: ClientBodySiteTrend[];
  weight: ClientBodySiteTrend;
}
export interface ClientBodyCompBand {
  from: number;
  to: number;
  label: string;
  tone: "ok" | "watch" | "warn" | "info";
}
export interface ClientBodyCompScale {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  bands: ClientBodyCompBand[];
  optimal: { from: number; to: number };
  value: number | null;
  projected: number | null;
  horizon_weeks: number;
  estimate: boolean;
  read: string;
}
export interface ClientBodyCompFocus {
  scales: ClientBodyCompScale[];
  focus: { key: string; label: string; line: string } | null;
  heading: string | null;
}
export interface ClientBodyMetricsSummary {
  latest: ClientBodyMeasurement | null;
  measurements: ClientBodyMeasurement[];
  indicators: ClientBodyIndicator[];
  trends: ClientBodyMetricTrends;
  profile: { height_in: number | null; sex: string; weight_lb: number | null; goal_weight_lb: number | null };
  needs_height: boolean;
  unit: "in" | "cm";
  sites: {
    key: string;
    label: string;
    hint: string;
    range: { min: number; max: number; typical_min: number | null; typical_max: number | null };
  }[];
  measurement_issues: Array<{ site: string; severity: "error" | "warning"; message: string }>;
  comp: ClientBodyCompFocus;
}

export interface ClientApiResponses {
  "/api/health": ClientHealthResponse;
  "/api/ready": ClientReadinessResponse;
  "/api/version": ClientVersionResponse;
  "/api/update-status": ClientUpdateStatus;
  "/api/update-check": ClientUpdateStatus;
  "/api/settings": ClientSettingsResponse;
  "/api/agents": ClientAgentConfig;
  "/api/agent-stats": ClientAgentStats;
  "/api/brain-diagnostics": ClientBrainDiagnostics;
  "/api/diagnostics": ClientDiagnosticsResponse;
  "/api/telemetry/client": undefined;
  "/api/brain/decisions": ClientBrainDecisionSummary[];
  "/api/agent-clis/update": ClientAgentCliUpdateStatus;
  "/api/art/manifest": ClientArtManifestResponse;
  "/api/art/stats": ClientArtStatsResponse;
  "/api/apple-health/config": ClientAppleHealthConfig;
  "/api/apple-health/connections": ClientAppleHealthConnectionsResponse;
  "/api/apple-health/connections/:id": ClientAppleHealthConnectionRevokeResponse;
  "/api/apple-health/pairings": ClientAppleHealthPairingResponse;
  "/api/profile": ClientProfile;
  "/api/goal": ClientGoalCheck;
  "/api/training-intent": ClientTrainingIntentResponse;
  "/api/bodyweight": ClientWeightRow[];
  "/api/body-metrics": ClientBodyMetricsSummary;
  "/api/body-metrics/trends": ClientBodyMetricTrends;
  "/api/blood-pressure": ClientBloodPressureReading[];
  "/api/checkins": ClientCheckin[] | ClientCheckin | null;
  "/api/plan": ClientPlanDay[];
  "/api/exercises": ClientExercise[];
  "/api/exercises/reconcile-names": ClientExerciseNameReconcileResponse;
  "/api/sessions": ClientTrainingSession[] | ClientTrainingSession | null;
  "/api/sessions/skip": ClientOkResponse;
  "/api/sets": ClientLoggedSet;
  "/api/last-set": ClientLoggedSet | null;
  "/api/strength-journey": ClientStrengthJourney | ClientStrengthJourneySetResponse;
  "/api/strength-journey/suggestion/dismiss": { dismissed_at: string };
  "/api/activities": ClientActivity[];
  "/api/agent/run": ClientProposalResult | ClientAgentJobEnvelope;
  "/api/garmin/daily": ClientGarminDailyMetric[];
  "/api/garmin/unreconciled": ClientGarminActivity[];
  "/api/garmin/reconcile": ClientGarminReconcileResponse;
  "/api/garmin/sync": ClientGarminSyncResponse;
  "/api/recent-training": ClientRecentTrainingFeedRow[];
  "/api/stats": ClientWeeklyStats;
  "/api/training-load": ClientTrainingLoadBandResponse;
  "/api/endurance-prs": ClientEndurancePRs;
  "/api/run-compliance": ClientRunCompliance;
  "/api/cardio": ClientCardioEffort[];
  "/api/endurance-goal": ClientEnduranceGoal | null;
  "/api/volume": ClientVolumeByMuscleResponse;
  "/api/calendar": ClientTrainingCalendarResponse;
  "/api/week-wins": ClientWeekWinsResponse;
  "/api/today": ClientTodayAggregate;
  "/api/today-plan-day": ClientTodayPlanDaySelection | null;
  "/api/today-read": ClientDayRead;
  "/api/today-read/reshape": ClientDayRead | { ok: true; job: ClientAgentJob };
  "/api/session-suggest": ClientSessionSuggestResponse;
  "/api/daily-session": ClientDailySessionComposition | null;
  "/api/daily-session/preview": ClientDailySessionPreview;
  "/api/daily-session/prepare": ClientDailySessionPrepareResponse;
  "/api/daily-session/outcome": ClientDailySessionOutcomeRead | null;
  "/api/session-primer": ClientSessionPrimer | null;
  "/api/week-ahead": ClientWeekAheadResponse;
  "/api/today-agenda": ClientTodayAgenda;
  "/api/today-agenda/ack": ClientTodayAgendaAckResponse;
  "/api/learned-timeline": ClientLearnedTimeline;
  "/api/team-week": ClientTeamWeek;
  "/api/health/next-checkup": ClientNextCheckup;
  "/api/since-last": ClientTodayAgendaCandidate | null;
  "/api/guidelines": ClientGuidelinesResponse;
  "/api/nutrition/day": ClientDayIntake;
  "/api/nutrition/progress": ClientNutritionProgress;
  "/api/next-step": ClientNextStep | null;
  "/api/nutrition/expenditure": ClientExpenditureEstimate;
  "/api/nutrition/checkin": ClientProposalResult;
  "/api/nutrition/goal-pace": ClientGoalPaceResponse;
  "/api/nutrition/fueling-followup": ClientFuelingFollowup;
  "/api/nutrition/fueling-feedback": ClientFuelingFeedback;
  "/api/coach/mealplan": ClientMealPlanDraftResponse | ClientAgentJobEnvelope;
  "/api/mealplans": ClientMealPlan[];
  "/api/food-notes": ClientFoodNote[] | ClientFoodNote;
  "/api/frequent-foods": ClientFrequentFood[];
  "/api/proposals": ClientProposal[];
  "/api/program/evolve": ClientProposalResult | ClientAgentJobEnvelope;
  "/api/program/progression": ClientPrescription[];
  "/api/program/progression/apply": ClientProposalResult;
  "/api/program/swap": ClientProposalResult;
  "/api/program/swap/apply": ClientProposalResult;
  "/api/program/variations": ClientExerciseVariation[];
  "/api/program/balance": ClientProgramBalance;
  "/api/program/adjustments": ClientProgramAdjustment[];
  "/api/program/blocks": ClientProgramBlock[] | ClientProgramBlock;
  "/api/program/blocks/active": ClientProgramBlock | null;
  "/api/program-state": ClientProgramState;
  "/api/performance": ClientPerformanceStanding;
  "/api/run-plan": ClientWeeklyRunPlan;
  "/api/training-agenda": ClientFlexibleTrainingAgenda;
  "/api/run-zones": ClientRunZones;
  "/api/muscle-trajectory": ClientMuscleGroupTrajectory;
  "/api/test-week": ClientTestWeekDue;
  "/api/dexa-targeting": ClientDexaTargeting;
  "/api/journey": ClientJourneyRead;
  "/api/journey/milestones": ClientJourneyMilestone[];
  "/api/journey/timeline": ClientForwardTimelineEntry[];
  "/api/journey/transition-suggestion": ClientJourneyTransitionSuggestion | null;
  "/api/program/run-plan/apply": ClientProposalResult;
  "/api/coaching-focus": ClientCoachingFocus;
  "/api/health/markers": ClientHealthMarker[];
  "/api/markers/priority": ClientPriorityMarkersResponse;
  "/api/health/standing": ClientHealthStanding;
  "/api/health/risk": ClientCardiovascularRisk;
  "/api/health/review": ClientHealthReview | null;
  "/api/health/synthesis": ClientHealthSynthesisResponse;
  "/api/directives": ClientDirectivesResponse;
  "/api/directives/derive": ClientDirectivesResponse & { ok: true; derived: number };
  "/api/markers/reconcile": ClientOkResponse & { merges?: unknown[] };
  "/api/recovery": ClientRecoverySummary;
  "/api/recovery/baseline": ClientRecoveryBaselineRead;
  "/api/symptom-links": { links: ClientSymptomMarkerLink[] };
  "/api/training-symptoms": ClientTrainingSymptom[] | ClientTrainingSymptom;
  "/api/training-symptoms/observation": ClientExerciseSymptomObservationResponse;
  "/api/evidence": ClientEvidenceRow[];
  "/api/evidence/summary": ClientEvidenceSummary;
  "/api/insights": ClientInsight[];
  "/api/insights/generate": ClientInsightGenerateResponse | ClientAgentJobEnvelope;
  "/api/health-docs": ClientHealthDocument[];
  "/api/health-docs/imaging": ClientHealthDocument;
  "/api/health-docs/imaging/dicom-imports": ClientDicomImportJob;
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

type ClientApiResponseForCleanPath<Path extends string> = `/api${Path}` extends keyof ClientApiResponses
  ? ClientApiResponses[`/api${Path}`]
  : Path extends `/apple-health/connections/${string}`
    ? ClientAppleHealthConnectionRevokeResponse
    : Path extends `/plan/${string}/target`
      ? ClientPlanItem
      : Path extends `/plan/${string}`
        ? ClientPlanDay | ClientDeleteResponse
        : Path extends `/exercises/${string}`
          ? ClientExercise | ClientDeleteResponse
          : Path extends `/exercise/${string}/explanation`
            ? ClientExerciseExplanation
            : Path extends `/exercise/${string}`
              ? ClientExerciseDetail
              : Path extends `/sessions/${string}/finish`
                ? ClientTrainingSession
                : Path extends `/training-symptoms/${string}/resolve`
                  ? ClientTrainingSymptom
                  : Path extends `/training-symptoms/${string}/recur`
                    ? ClientTrainingSymptom
                    : Path extends `/training-symptoms/${string}/tolerance`
                      ? ClientTrainingSymptom
                : Path extends `/sessions/${string}/reopen`
                  ? ClientTrainingSession
                  : Path extends `/sessions/${string}/notes`
                    ? ClientTrainingSession
                    : Path extends `/sessions/${string}/feedback`
                      ? ClientJsonObject | null
                      : Path extends `/sessions/${string}`
                        ? ClientTrainingSession
                        : Path extends `/sets/${string}`
                          ? ClientLoggedSet | ClientDeleteResponse
                          : Path extends `/progress/${string}`
                            ? ClientJsonObject
                            : Path extends `/activities/${string}`
                              ? ClientActivity
                              : Path extends `/mealplans/${string}/accept`
                                ? ClientMealPlan
                                : Path extends `/mealplans/${string}/discard`
                                  ? ClientMealPlan
                                  : Path extends `/meal-plans/${string}/swap`
                                    ? ClientMealSwapResponse | ClientAgentJobEnvelope
                                    : Path extends `/meal-plans/${string}/recipe`
                                      ? ClientMealRecipeResponse | ClientAgentJobEnvelope
                                      : Path extends `/meal-plans/${string}/days`
                                        ? ClientMealPlan
                                        : Path extends `/food-notes/${string}`
                                          ? ClientFoodNote | ClientDeleteResponse
                                          : Path extends `/proposals/${string}/apply`
                                            ? ClientProposalResult
                                            : Path extends `/proposals/${string}/lead`
                                              ? ClientProposalResult
                                              : Path extends `/proposals/${string}/discard`
                                                ? ClientProposal
                                                : Path extends `/program/blocks/${string}`
                                                  ? ClientProgramBlock
                                                  : Path extends `/directives/${string}`
                                                    ? { ok: true; directive: ClientDirective }
                                                    : Path extends `/insights/${string}`
                                                      ? ClientInsight
                                                      : Path extends `/health-docs/${string}/reanalyze`
                                                        ? ClientHealthDocument
                                                        : Path extends `/health-docs/imaging/dicom-imports/${string}`
                                                          ? ClientDicomImportJob
                                                          : Path extends `/health-docs/${string}/dicom/manifest`
                                                            ? ClientDicomManifest
                                                            : Path extends `/health-docs/${string}/imaging-files/${string}`
                                                              ? Blob
                                                              : Path extends `/health-docs/${string}/imaging-files`
                                                                ? ClientImagingStudyFile
                                                                : Path extends `/health-docs/${string}/imaging-analyze`
                                                                  ? ClientHealthDocument
                                                                  : Path extends `/health-docs/${string}/imaging-details`
                                                                    ? ClientHealthDocument
                                                                    : Path extends `/health-docs/${string}/imaging-confirm`
                                                                      ? ClientHealthDocument
                                                                      : Path extends `/health-docs/${string}/imaging-recommendations/${string}/status`
                                                                        ? ClientHealthDocument
                                                                        : Path extends `/health-docs/${string}`
                                                                          ? ClientHealthDocument | ClientDeleteResponse
                                                                          : Path extends `/context-events/${string}`
                                                                            ? ClientContextEvent | ClientDeleteResponse
                                                                            : Path extends `/family/${string}`
                                                                              ?
                                                                                  | ClientFamilyMember
                                                                                  | ClientDeleteResponse
                                                                              : Path extends `/memory/${string}/supersede` ? ClientMemorySupersedeResponse
                                                                                : Path extends `/memory/${string}`
                                                                                  ? ClientMemory | ClientDeleteResponse
                                                                                  : Path extends `/supplements/${string}`
                                                                                    ?
                                                                                        | ClientSupplement
                                                                                        | ClientDeleteResponse
                                                                                    : Path extends `/chat/sessions/${string}`
                                                                                      ? ClientChatMessage[]
                                                                                      : Path extends `/chat/turns/${string}/cancel`
                                                                                        ? ClientChatTurnCancelResponse
                                                                                        : Path extends `/chat/turns/${string}`
                                                                                          ? ClientChatTurn | null
                                                                                          : Path extends `/agent-jobs/${string}/cancel`
                                                                                            ? ClientAgentJobResponse
                                                                                            : Path extends `/agent-jobs/${string}`
                                                                                              ? ClientAgentJobResponse
                                                                                              : Path extends `/agents/${string}/info`
                                                                                                ? ClientAgentProbeResponse
                                                                                                : Path extends `/agents/${string}/models`
                                                                                                  ? ClientAgentModelsResponse
                                                                                                  : Path extends `/agent-clis/${string}/install`
                                                                                                    ? ClientAgentCliUpdateStatus
                                                                                                    : Path extends `/brain/decisions/${string}/revert`
                                                                                                      ? ClientOkResponse & {
                                                                                                          decision?: ClientJsonObject;
                                                                                                          error?: string;
                                                                                                        }
                                                                                                      : unknown;

export type ClientApiResponse<Path extends string> = Path extends `/api${infer Rest}`
  ? ClientApiResponse<Rest>
  : Path extends `${infer Base}?${string}`
    ? ClientApiResponseForCleanPath<Base>
    : ClientApiResponseForCleanPath<Path>;
