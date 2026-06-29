export type ISODateString = string;

export interface ClientRoute {
  tab: string;
  section: string | null;
  healthSection: string | null;
  date: ISODateString | null;
  id: string | null;
  session: string | null;
  jump: string | null;
}

export interface ClientRoutesApi {
  parseRoute(input: string | URL): ClientRoute;
  routeToUrl(route: Partial<ClientRoute> | null | undefined): string;
  validTabs: string[];
  planSections: string[];
  progressSections: string[];
  meSections: string[];
  healthSections: string[];
  settingsSections: string[];
}

export interface ClientDayRead {
  kind: "train" | "easy" | "rest" | "done";
  focus: string | null;
  why: string;
  est_minutes: number | null;
  signals: Record<string, unknown>;
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
}

export interface ClientTodayAgenda {
  hero: ClientTodayAgendaCandidate;
  primary: ClientTodayAgendaCandidate[];
  more: ClientTodayAgendaCandidate[];
  total: number;
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

export interface ClientApiResponses {
  "/api/today-agenda": ClientTodayAgenda;
  "/api/nutrition/day": ClientDayIntake;
  "/api/next-step": ClientNextStep | null;
  "/api/nutrition/expenditure": ClientExpenditureEstimate;
  "/api/program/progression": ClientPrescription[];
  "/api/chat/sessions": ClientChatSessionSummary[];
  "/api/chat/sessions/:sessionId": ClientChatMessage[];
  "/api/chat/search": ClientChatSearchHit[];
  "/api/chat/reset": ClientChatResetResponse;
}

export type ClientApiCanonicalPath = keyof ClientApiResponses;

export type ClientApiPath = ClientApiCanonicalPath extends `/api${infer Path}` ? Path : never;

export type ClientApiResponse<Path extends string> =
  Path extends `/api${infer Rest}` ? ClientApiResponse<Rest>
    : Path extends `${infer Base}?${string}` ? ClientApiResponse<Base>
      : `/api${Path}` extends keyof ClientApiResponses ? ClientApiResponses[`/api${Path}`]
        : Path extends `/chat/sessions/${string}` ? ClientChatMessage[]
          : unknown;
