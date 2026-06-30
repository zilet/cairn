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
  present?: boolean;
  configured?: boolean | null;
  auth_state?: string | null;
  default_model?: string | null;
  models?: string[];
  error?: string | null;
  [key: string]: unknown;
}

export interface ClientAgentConfig {
  agents?: ClientAgentInfo[];
  order?: string[];
  disabled?: string[];
  [agent: string]: unknown;
}

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
  "/api/profile": ClientProfile;
  "/api/goal": ClientGoalCheck;
  "/api/bodyweight": ClientWeightRow[];
  "/api/blood-pressure": ClientBloodPressureReading[];
  "/api/checkins": ClientCheckin[] | ClientCheckin | null;
  "/api/plan": ClientPlanDay[];
  "/api/exercises": ClientExercise[];
  "/api/exercises/reconcile-names": ClientOkResponse & ClientJsonObject;
  "/api/sessions": ClientTrainingSession[] | ClientTrainingSession | null;
  "/api/sessions/skip": ClientOkResponse;
  "/api/sets": ClientLoggedSet;
  "/api/last-set": ClientLoggedSet | null;
  "/api/activities": ClientActivity[];
  "/api/recent-training": ClientJsonArray;
  "/api/stats": ClientWeeklyStats;
  "/api/endurance-prs": ClientJsonObject;
  "/api/run-compliance": ClientJsonObject;
  "/api/cardio": ClientJsonArray;
  "/api/endurance-goal": ClientJsonObject | null;
  "/api/today-read": ClientDayRead;
  "/api/today-read/reshape": ClientDayRead | { ok: true; job: ClientAgentJob };
  "/api/session-suggest": ClientJsonObject;
  "/api/week-ahead": ClientJsonObject;
  "/api/today-agenda": ClientTodayAgenda;
  "/api/learned-timeline": ClientLearnedTimeline;
  "/api/since-last": ClientTodayAgendaCandidate | null;
  "/api/guidelines": ClientJsonObject;
  "/api/nutrition/day": ClientDayIntake;
  "/api/next-step": ClientNextStep | null;
  "/api/nutrition/expenditure": ClientExpenditureEstimate;
  "/api/nutrition/checkin": ClientProposalResult;
  "/api/mealplans": ClientMealPlan[];
  "/api/food-notes": ClientFoodNote[] | ClientFoodNote;
  "/api/frequent-foods": ClientFrequentFood[];
  "/api/proposals": ClientProposal[];
  "/api/program/progression": ClientPrescription[];
  "/api/program/progression/apply": ClientProposalResult;
  "/api/program/balance": ClientJsonObject;
  "/api/program/adjustments": ClientJsonObject | ClientJsonArray;
  "/api/program/blocks": ClientJsonArray;
  "/api/program/blocks/active": ClientJsonObject | null;
  "/api/program-state": ClientJsonObject;
  "/api/performance": ClientJsonObject;
  "/api/run-plan": ClientJsonObject;
  "/api/run-zones": ClientJsonObject;
  "/api/muscle-trajectory": ClientJsonObject;
  "/api/test-week": ClientJsonObject;
  "/api/dexa-targeting": ClientJsonObject;
  "/api/program/run-plan/apply": ClientProposalResult;
  "/api/coaching-focus": ClientCoachingFocus;
  "/api/health/markers": ClientHealthMarker[];
  "/api/health/standing": ClientJsonObject;
  "/api/health/review": ClientHealthReview | null;
  "/api/health/synthesis": ClientHealthSynthesisResponse;
  "/api/directives": ClientDirectivesResponse;
  "/api/directives/derive": ClientDirectivesResponse & { ok: true; derived: number };
  "/api/markers/reconcile": ClientOkResponse & { merges?: unknown[] };
  "/api/symptom-links": { links: unknown[] };
  "/api/evidence": ClientEvidenceRow[];
  "/api/evidence/summary": ClientEvidenceSummary;
  "/api/insights": ClientInsight[];
  "/api/health-docs": ClientHealthDocument[];
  "/api/context-events": ClientContextEvent[];
  "/api/injury-impacts": ClientJsonObject;
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
                                  : Path extends `/meal-plans/${string}/days` ? ClientMealPlan
                                    : Path extends `/food-notes/${string}` ? ClientFoodNote | ClientDeleteResponse
                                      : Path extends `/proposals/${string}/apply` ? ClientProposalResult
                                        : Path extends `/proposals/${string}/discard` ? ClientProposal
                                          : Path extends `/program/blocks/${string}` ? ClientJsonObject
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
                                                                        : unknown;

export type ClientApiResponse<Path extends string> =
  Path extends `/api${infer Rest}` ? ClientApiResponse<Rest>
    : Path extends `${infer Base}?${string}` ? ClientApiResponseForCleanPath<Base>
      : ClientApiResponseForCleanPath<Path>;
