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

// The Today LEAD arbitration (server-owned, additive, optional). One decision
// says which single surface earns the position of prominence today and gives a
// coarse ordering for the rest, so Today stops competing with itself when the
// Brief is repeating yesterday. SEMANTIC LABELS ONLY — the server's internal
// ranking never crosses the wire, exactly like marker `impact_score`. Absent
// (older server, cached payload) → the client renders as it always has.
// These MIRROR the server types in src/domain/brain/today-attention.ts rather
// than importing them: this module is the client-facing contract and by design
// imports nothing outside src/contracts/ (src/client/** cannot reach server code).
export type ClientTodayAttentionSurface = "brief" | "feedback" | "insight" | "weekly" | "fuel";
// Emphasis bands, not list positions: `lead` is the position of prominence,
// `supporting` sits beside it, `quiet` is present and reachable but recedes.
export type ClientTodayAttentionTier = "lead" | "supporting" | "quiet";
// Whether the Brief still has something new to say today.
export type ClientTodayAttentionBriefState = "new_read" | "repeat_of_yesterday" | "settled_quiet";

export interface ClientTodayAttentionItem {
  surface: ClientTodayAttentionSurface;
  tier: ClientTodayAttentionTier;
}

export interface ClientTodayAttention {
  primary: ClientTodayAttentionSurface;
  brief_state: ClientTodayAttentionBriefState;
  // Most-deserving first; `items[0].surface` is always `primary`.
  items: ClientTodayAttentionItem[];
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
  agent_issue?: "invalid_response" | "unreachable";
  decision?: {
    rule_code: string;
    basis: "deterministic" | "agent" | "server_policy";
    baseline_kind: "train" | "easy" | "rest" | "done";
    reason: string;
    evidence: Array<{ label: string; value: string; date?: ISODateString }>;
    computed_at: string;
  };
  input_fingerprint?: string;
  computed_at?: string;
  // A hand-authored read (the demo seed's Brief) pinned against recompute.
  curated?: boolean;
  // Which Today surface leads today. Optional: absent on any non-live date and
  // whenever the arbitration can't be made.
  attention?: ClientTodayAttention;
  // The optional guided recovery menu on a rest/easy day (VISION: "rest" must
  // never feel like "do nothing"). Absent/null on train/done reads and whenever
  // the server has nothing to suggest. Never persisted — derived fresh per
  // response, same as forward/arc.
  recovery?: {
    line: string;
    options: Array<{ label: string; detail: string; minutes: number | null }>;
  } | null;
  periodization_context?: {
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
      applied_on: ISODateString;
      until: ISODateString;
      day_index: number;
      total_days: 7;
      proposal_id: number | null;
      cycle_id?: number;
      label: "reduced volume";
    } | null;
  };
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
  // A quieter second action rendered beside the primary one (e.g. the announced
  // change card's deterministic "Hold this" alongside "Discuss with coach").
  secondary_action?: ClientTodayAgendaAction;
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
  // Daily recovery/complete posture from the unified planning state. Unlike a
  // program deload, this must never render the "Draft recovery week" action.
  day_posture?: "rest" | "easy" | "done";
}

// The recovery-week story for the Plan surface (GET /api/plan/recovery-status):
// a waiting draft, the applied lighter week in flight, or null. The Plan tab's
// banner announces a reshaped week instead of letting it arrive silently.
export type ClientRecoveryWeekStatus =
  | { state: "drafted"; proposal_id: number; summary: string | null }
  | { state: "upcoming"; proposal_id: number; decision_id: number; effective_date: string; summary: string | null }
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
  // The conductor's own sentence to the athlete, where a case conference wrote one.
  explanation?: string | null;
}
// `landed` carries changes that already took effect in the last week — the "why does
// my week look different" half. `awaiting` carries decisions still waiting on the
// athlete, which are never aged out: a hold is an open question, not history.
export type ClientPlanUpcomingNote = {
  items: ClientPlanUpcomingItem[];
  landed?: ClientPlanUpcomingItem[];
  awaiting?: ClientPlanUpcomingItem[];
} | null;

export interface ClientCoachingRetest {
  in_weeks: number | null;
  focus: string[];
  why: string;
}

export interface ClientCoachingFocus {
  available: boolean;
  headline: string;
  // Whether the surface should offer one-tap ACTIONS (swap / draft-recovery buttons).
  // False under lead mode — the coach applies bounded changes itself, so the card
  // speaks state, not an ask. Absent is treated as true (the legacy behavior).
  acts?: boolean;
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
  // Ingredient rows/strings as captured (foodCapture.ts shape) — the same
  // context the read-only food-detail sheet shows, threaded through for the
  // edit sheet's twin. Null when nothing was captured.
  items: unknown;
  // The verbatim "as logged" capture text, or null.
  raw: string | null;
  enrichment_status: string | null;
  created_at: string;
  // The clock to SHOW, already localized ("7:30 PM"): the stated eating time when
  // there is one, else the write-time label. Render it as-is and never derive a
  // display time from created_at, which for a backdated entry is when the meal was
  // remembered rather than when it was eaten.
  logged_at: string;
  // The raw local "HH:MM" (24-hour) the athlete said they ate, or null when they
  // never said. Null is the ordinary case — show nothing, never midnight. It is
  // also how you tell which of the two clocks `logged_at` is showing.
  eaten_at: string | null;
}

export interface ClientNutritionTarget {
  kcal: number;
  protein_g: number;
  mode: string;
  source?: string;
}

/**
 * How much work this day carries, from the training plan and the week's run
 * intentions. `drivers` is the machine register (what makes a day big); the card
 * speaks its own rotating sentence and never prints these strings.
 */
export interface ClientDayFuelDemand {
  date: ISODateString;
  demand: "light" | "standard" | "big";
  drivers: string[];
  evidence: string[];
}

export interface ClientDayIntake {
  date: ISODateString;
  totals: ClientMacroTotals;
  known: Record<keyof ClientMacroTotals, boolean>;
  entries: ClientFoodEntry[];
  count: number;
  target: ClientNutritionTarget | null;
  remaining: Pick<ClientMacroTotals, "kcal" | "protein_g"> | null;
  // Present on GET /nutrition/day; never on an optimistically patched local copy's
  // recompute path, which only touches entries/totals. Additive and always optional.
  fuel_demand?: ClientDayFuelDemand | null;
}

export interface ClientNutritionTargetProvenance {
  source: string;
  effective_date: ISODateString | null;
  freshness: "fresh" | "explicit";
}

export type ClientNutritionProgressNutrient = "kcal" | "protein_g" | "carbs_g" | "fat_g" | "fiber_g";

export interface ClientNutritionProgressDay {
  date: ISODateString;
  logged: boolean;
  entry_count: number;
  pending_entries: number;
  capture: "unlogged" | "partial" | "macro_known" | "open";
  nutrients: Record<ClientNutritionProgressNutrient, number | null>;
  known: Record<ClientNutritionProgressNutrient, boolean>;
  target: {
    kcal: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    source: string;
    effective_date: ISODateString | null;
    provenance: Record<"kcal" | "protein_g" | "carbs_g" | "fat_g", ClientNutritionTargetProvenance | null>;
  } | null;
}

export interface ClientNutritionPatternEstimate {
  sampled_entries: number;
  sampled_days: number;
  total_entries: number;
  total_logged_days: number;
  note: string;
  food_quality: Record<"mostly_whole" | "mixed" | "mostly_ultra_processed" | "unknown", number>;
  saturated_fat: Record<"low" | "moderate" | "high" | "unknown", number>;
  added_sugar: Record<"low" | "moderate" | "high" | "unknown", number>;
  sodium: Record<"low" | "moderate" | "high" | "unknown", number>;
  potassium: Record<"low" | "moderate" | "high" | "unknown", number>;
  calcium: Record<"low" | "moderate" | "high" | "unknown", number>;
  iron: Record<"low" | "moderate" | "high" | "unknown", number>;
  omega_3_source: { yes: number; no: number; unknown: number };
  confidence: Record<"low" | "medium" | "high" | "unknown", number>;
  basis: Record<"label" | "user_report" | "estimated_from_foods" | "photo" | "unknown", number>;
  fat_grams: {
    sampled_entries: number;
    average_saturated_fat_g: number | null;
    average_unsaturated_fat_g: number | null;
  };
}

export interface ClientNutritionProgress {
  window_days: number;
  since: ISODateString;
  through: ISODateString;
  read: string;
  next_move: string;
  coverage: {
    logged_days: number;
    closed_logged_days: number;
    unlogged_days: number;
    macro_known_days: number;
    partial_days: number;
    open_day_logged: boolean;
    pending_entries: number;
    pending_entry_ids: number[];
    logged_fraction: number;
    macro_known_fraction: number;
    observation_density: "none" | "sparse" | "moderate" | "dense";
    confidence: "none" | "tentative" | "observed" | "strong";
    completeness_signal: null;
    note: string;
  };
  current_reference: {
    kcal: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number;
    source: string;
    effective_date: ISODateString | null;
    provenance: Record<ClientNutritionProgressNutrient, ClientNutritionTargetProvenance | null>;
  };
  nutrients: Array<{
    nutrient: ClientNutritionProgressNutrient;
    label: string;
    unit: "kcal" | "g";
    average: number | null;
    known_days: number;
    trend: "rising" | "falling" | "steady" | "unknown";
    change: number | null;
    reference: number | null;
    reference_label: string | null;
  }>;
  target_alignment: Record<
    Exclude<ClientNutritionProgressNutrient, "fiber_g">,
    {
      comparable_days: number;
      recorded_average: number | null;
      target_average: number | null;
      recorded_to_target: number | null;
    }
  >;
  energy_split: {
    known_days: number;
    protein_pct: number;
    carbs_pct: number;
    fat_pct: number;
  } | null;
  food_quality_estimates: ClientNutritionPatternEstimate;
  series: ClientNutritionProgressDay[];
  health_context: Array<{
    id: number;
    domain: "nutrition" | "watch";
    marker: string | null;
    directive: string | null;
    rationale: string | null;
    citation: string | null;
    uncertain: boolean;
    trigger_date: string | null;
    acute: boolean;
    age_days: number | null;
    stale: boolean;
    transient: boolean;
    transient_reason: string | null;
    stale_measurement: boolean;
    rescan_reason: string | null;
  }>;
  frame: string;
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

// Cut-quality read (goal-aware): during an active weight-loss phase, is strength
// holding as the weight drops? `{ active: false }` off a cut. Calm, banded, no score.
export type ClientCutQuality =
  | { active: false }
  | {
      active: true;
      verdict: "preserving" | "mixed" | "sliding" | "insufficient";
      words: string;
      weight: { trend_lb_wk: number | null; window_days: number };
      strength: {
        considered: number;
        holding: number;
        regressing: number;
        anchors: Array<{ name: string; status: string }>;
      };
      endurance: { note: string } | null;
      rate: { vs_lean_safe: "within" | "above" | null };
    };

export interface ClientExpenditureEstimate {
  tdee: number | null;
  confidence: "none" | "low" | "medium" | "high";
  points: number;
  window_days: number;
  intake_avg_kcal: number | null;
  trend_lb_wk: number | null;
  projected_goal_date?: string | null;
  projection_text?: string | null;
  outcome_tdee?: number | null;
  prior_tdee?: number | null;
  prior_basis?: "measured_rmr_active" | "garmin_total_calories" | "profile_seed" | null;
  tdee_basis?:
    | "outcome_trend"
    | "blended_outcome_prior"
    | "measured_rmr_active"
    | "garmin_total_calories"
    | "profile_seed"
    | "unavailable";
  basis?: string;
  anchors?: unknown[];
  coverage?: {
    intake_days: number;
    credible_intake_days: number;
    partial_intake_days: number;
    weigh_in_days: number;
    weigh_in_span_days: number;
    prior_days: number;
    required_prior_days: number;
  };
  provenance?: string[];
  fusion?: { outcome_weight: number; prior_weight: number };
  typical_tdee?: number | null;
  maintenance_range?: { low: number | null; high: number | null };
  exceptional_activity?: {
    window_days: number;
    observed_days: number;
    coverage_ratio: number;
    typical_active_kcal: number | null;
    exceptional_days: number;
    frequency_per_week: number;
    allowance_kcal_per_day: number;
  };
  quality?: {
    intake: "none" | "partial" | "plausible" | "complete";
    outcome: "unavailable" | "plausible" | "implausible_low" | "implausible_high";
    explanation: string;
    plausible_tdee_min: number;
    plausible_tdee_max: number;
    terminal_weight_shock: boolean;
    terminal_weight_shock_date: string | null;
    outcome_overlap_days: number;
    outcome_calendar_coverage: number;
  };
  // Additive (older consumers ignore): the goal-aware cut-quality read the Energy
  // Balance view renders as a quality line in the loss branch.
  cut_quality?: ClientCutQuality | null;
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
  kind?: "strength" | "cardio" | string | null;
  sets?: number | null;
  rep_low?: number | null;
  rep_high?: number | null;
  target_weight?: number | null;
  target_seconds?: number | null;
  mode?: "reps" | "timed" | string | null;
  note?: string | null;
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_zone?: string | null;
  interval?: unknown;
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
