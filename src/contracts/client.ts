import type {
  ClientHealthSection,
  ClientMeSection,
  ClientPlanSection,
  ClientProgressSection,
  ClientRouteDefinitions,
  ClientRouteSection,
  ClientSettingsSection,
  ClientStandSection,
  ClientTabName,
} from "./client-routes.js";

export type ISODateString = string;

export interface ClientRoute {
  tab: ClientTabName;
  section: ClientRouteSection | null;
  healthSection: ClientHealthSection | null;
  date: ISODateString | null;
  id: string | null;
  session: string | null;
  jump: string | null;
}

export interface ClientRoutesApi {
  parseRoute(input: string | URL): ClientRoute;
  routeToUrl(route: Partial<ClientRoute> | null | undefined): string;
  routeDefinitions: ClientRouteDefinitions;
  validTabs: readonly ClientTabName[];
  planSections: readonly ClientPlanSection[];
  progressSections: readonly ClientProgressSection[];
  standSections: readonly ClientStandSection[];
  meSections: readonly ClientMeSection[];
  healthSections: readonly ClientHealthSection[];
  settingsSections: readonly ClientSettingsSection[];
}

export interface ClientDayRead {
  kind: "train" | "easy" | "rest" | "done";
  focus: string | null;
  why: string;
  est_minutes: number | null;
  signals: Record<string, unknown>;
  headline?: string;
  source?: string;
  cached?: boolean;
  forward?: string | null;
  arc?: string | null;
  agent_status?: unknown;
}

export interface ClientTodayAgendaAction {
  label: string;
  kind: string;
  payload?: unknown;
}

export type ClientTodayAgendaTier = "hero" | "primary" | "more";

export interface ClientTodayAgendaCandidate {
  id: string;
  kind: string;
  tier: ClientTodayAgendaTier;
  priority: number;
  kicker?: string;
  title?: string;
  body?: string;
  action?: ClientTodayAgendaAction;
  client_card?: string;
  dismissible?: boolean;
  revision?: string;
  // A genuinely-new attention item waiting behind the "more" disclosure — the
  // client may whisper "· one new" on the collapsed summary (pull, never push).
  waiting?: boolean;
}

export interface ClientTodayAgenda {
  hero: ClientTodayAgendaCandidate;
  primary: ClientTodayAgendaCandidate[];
  more: ClientTodayAgendaCandidate[];
  total: number;
}

export type ClientCoachingFocusDomain = "training" | "running" | "nutrition" | "health" | "recovery" | "body";

export interface ClientCoachingFocusItem {
  domain: ClientCoachingFocusDomain;
  title: string;
  why: string;
  move?: string;
  based_on?: string[];
  // One-tap rotation for a stalled lead lift: rotate `from` out for one of the
  // `to` variations (same movement pattern). Rendered as action buttons only
  // where the swap is wired (Program); other surfaces just navigate.
  swap?: { from: string; to: string[] };
  // A recovery lead whose one-tap draft already landed in Coach: the Program card
  // renders a "Review your recovery week →" link instead of the draft button.
  draft_pending?: boolean;
  // The applied recovery week is running — the lead is a confirmation, no action.
  recovery_active?: boolean;
}

// The recovery-week story for the Plan surface (GET /api/plan/recovery-status):
// a waiting draft, the applied lighter week in flight, or null. The Plan tab's
// banner announces a reshaped week instead of letting it arrive silently.
export type ClientRecoveryWeekStatus =
  | { state: "drafted"; proposal_id: number; summary: string | null }
  | { state: "applied"; applied_on: string; until: string; summary: string | null }
  | null;

// The calm forward look for the Plan surface (GET /api/plan/upcoming): the
// training/recovery changes the brain will land soon, each with a summary and
// the day it takes effect. Deduped against the recovery banner's draft; null
// when nothing is waiting. Pull-never-push — a heads-up, never a retrospective feed.
export interface ClientPlanUpcomingItem {
  summary: string;
  effective_date: string;
  kind: string;
  domain: string;
}
export type ClientPlanUpcomingNote = { items: ClientPlanUpcomingItem[] } | null;

export interface ClientCoachingRetest {
  in_weeks: number | null;
  focus: string[];
  why: string;
}

export interface ClientCoachingFocus {
  available: boolean;
  headline: string;
  lead: ClientCoachingFocusItem | null;
  parallel: ClientCoachingFocusItem[];
  later: Array<{ domain: ClientCoachingFocusDomain; title: string }>;
  connections: string[];
  retest: ClientCoachingRetest | null;
  horizon_weeks: number | null;
  // Temporal placement inside the active program block, plain words
  // ("Week 3 of 5 — building volume."). Absent/null when no block is active.
  block_line?: string | null;
}

export interface ClientMacroTotals {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
}

export interface ClientFoodEntry {
  id: number;
  meal: string;
  summary: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  enrichment_status: string | null;
  created_at: string;
  logged_at: string;
}

export interface ClientNutritionTarget {
  kcal: number;
  protein_g: number;
  mode: string;
}

export interface ClientDayIntake {
  date: ISODateString;
  totals: ClientMacroTotals;
  entries: ClientFoodEntry[];
  count: number;
  target: ClientNutritionTarget | null;
  remaining: Pick<ClientMacroTotals, "kcal" | "protein_g"> | null;
}

export interface ClientNextStep {
  domain: "train" | "fuel" | "recover" | "recheck" | "life";
  step_key: string;
  title: string;
  why: string;
  based_on?: string[];
  action?: {
    kind: "open_plan" | "open_food" | "open_health" | "open_recovery" | "open_life";
    label: string;
  };
  leverage: number;
}

export interface ClientExpenditureEstimate {
  tdee: number | null;
  confidence: "none" | "low" | "medium" | "high";
  points: number;
  window_days: number;
  intake_avg_kcal: number | null;
  trend_lb_wk: number | null;
  projected_goal_date?: string | null;
  projection_text?: string | null;
}

export type ClientProgressionAction = "overload" | "hold" | "deload" | "vary" | "introduce";

export interface ClientPrescriptionTarget {
  sets: number;
  rep_low?: number;
  rep_high?: number;
  weight?: number | null;
  seconds?: number;
}

export interface ClientPrescriptionVariation {
  name: string;
  why: string;
}

export interface ClientPrescription {
  exercise: string;
  mode: "reps" | "timed";
  action: ClientProgressionAction;
  suggested: ClientPrescriptionTarget;
  current: ClientPrescriptionTarget | null;
  delta_text: string;
  why: string;
  reground?: boolean;
  vary_to?: string;
  vary_options?: ClientPrescriptionVariation[];
  plan_item_id?: number;
  day_number?: number; // the plan day this lift sits on (for the swap apply path)
  autoregulated?: boolean; // recovery braked this step (informational)
  rep_step?: boolean; // double-progression rep advance (load held, reps climb in-range)
}

export interface ClientSessionSuggestionItem {
  exercise: string;
  sets?: number | null;
  rep_low?: number | null;
  rep_high?: number | null;
  target_weight?: number | null;
  target_seconds?: number | null;
  mode?: "reps" | "timed" | string | null;
  note?: string | null;
  [key: string]: unknown;
}

export interface ClientSessionSuggestion {
  name?: string | null;
  focus?: string | null;
  why?: string | null;
  est_minutes?: number | null;
  notes?: string | null;
  items: ClientSessionSuggestionItem[];
  [key: string]: unknown;
}

export interface ClientChatSessionSummary {
  session_id: string;
  archived_at: string;
  count: number;
  started_at: string;
  ended_at: string;
  preview: string;
}

export interface ClientChatMessage {
  id: number;
  created_at: string;
  role: string;
  content: string;
  agent?: string | null;
  meta?: unknown;
  session_id?: string | null;
  archived_at?: string | null;
}

export interface ClientChatSearchHit {
  id: number;
  role: string;
  created_at: string;
  session_id: string | null;
  archived_at: string | null;
  snippet: string;
}

export interface ClientChatResetResponse {
  ok: true;
  archived: number;
  session_id?: string | null;
  distilled?: number;
  distilling?: number;
  farewell?: string;
  note?: string;
}

export * from "./client-api.js";
export * from "./client-api-coverage.js";
export * from "./client-routes.js";
