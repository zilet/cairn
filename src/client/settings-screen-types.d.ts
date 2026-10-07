// Erased declarations for Settings shell/controllers. Keep execution code in src/client/settings-*.ts.

type SettingsScreenAgent = {
  name: string;
  description?: string;
  enabled?: boolean;
  configured?: boolean;
  present?: boolean;
  can_login?: boolean;
  models_list?: boolean;
  installable?: boolean;
} & Record<string, unknown>;

type SettingsScreenData = {
  settings: Record<string, unknown>;
  agents: SettingsScreenAgent[];
  research_auto_eligible?: boolean | { eligible?: boolean; reason?: string };
  /** UTC ISO of the last strength write-back that landed; null/absent = nothing sent yet. */
  garmin_last_export_at?: string | null;
};

type SettingsScreenWorkingModel = {
  agent_strategy: string;
  order: string[];
  disabled: Set<string>;
  routes: Record<string, string>;
  chat_routing_mode: "adaptive" | "single";
  chat_profile_bindings: Record<string, Record<string, Record<string, unknown>>>;
  enrich_enabled: boolean;
  art_enabled: boolean;
  research_enabled: boolean;
  meal_plan_auto_draft: boolean;
  gemini_api_key: string;
  garmin_username: string;
  garmin_password: string;
  garmin_export_strength: boolean;
  coach_day: number;
  coach_hour: number;
  time_zone: string;
  update_check_enabled: boolean;
  usage_ping_enabled: boolean;
  lead_mode: "lead" | "announce_first" | "review_everything";
  run_units: "km" | "mi";
  weight_units: "lb" | "kg";
};

type SettingsScreenPersistBody = {
  agent_strategy: string;
  agent_order: string[];
  disabled_agents: string[];
  enrich_enabled: boolean;
  art_enabled: boolean;
  research_enabled: boolean;
  meal_plan_auto_draft: boolean;
  garmin_username: string;
  garmin_export_strength: boolean;
  coach_day: number;
  coach_hour: number;
  agent_routes: Record<string, string>;
  chat_routing_mode: "adaptive" | "single";
  chat_profile_bindings: Record<string, Record<string, Record<string, unknown>>>;
  update_check_enabled: boolean;
  usage_ping_enabled: boolean;
  lead_mode: "lead" | "announce_first" | "review_everything";
  run_units: "km" | "mi";
  weight_units: "lb" | "kg";
  gemini_api_key?: string;
  garmin_password?: string;
};

type SettingsScreenAgentInfo = {
  version: unknown;
  model_current: unknown;
  update_available: boolean;
};

type SettingsScreenCliUpdateStatus = {
  status?: string;
  /** install (default) or remove. */
  action?: string;
  agents?: string[];
  /** The installer's own classified failure: a reason code and a plain headline. */
  failure?: { reason?: string; message?: string } | null;
  started_at?: string;
  finished_at?: string;
  error?: string;
  stdout_tail?: string;
  stderr_tail?: string;
};

type SettingsScreenAgentInfoResponse = import("../contracts/client-api.js").ClientAgentProbeResponse;
type SettingsScreenAgentModelsResponse = import("../contracts/client-api.js").ClientAgentModelsResponse;
type SettingsScreenArtStats = import("../contracts/client-api.js").ClientArtStatsResponse;
type SettingsScreenGarminSyncResponse = import("../contracts/client-api.js").ClientGarminSyncResponse;

type SettingsScreenSliceKey = ClientSettingsSection;

type SettingsScreenBundle = {
  rawData: unknown;
  rawArtStats: unknown;
  agentStats: unknown;
  learnings: unknown;
  brainDiagnostics: unknown;
};

type SettingsDiagnosticsUiState = {
  status: "idle" | "loading" | "ready" | "unavailable";
  data: import("../contracts/client-api.js").ClientDiagnosticsResponse | null;
  readinessStatus: "idle" | "loading" | "ready" | "unavailable";
  readiness: import("../contracts/client-api.js").ClientReadinessResponse | null;
  days: 1 | 7 | 30;
  source: string;
  severity: string;
  issuePage: number;
  recentPage: number;
  requestToken: number;
  foldOpen: boolean;
};

// ---- the training drive card (settings-drive-client.ts / settings-drive-controller.ts) ----

type SettingsDriveUntilChoice = "block" | "two_weeks" | "four_weeks" | "date";

/** The drive's honest state: steady, an active dated push, an undated standing push, or a push that ran out. */
type SettingsDriveView = "steady" | "active" | "open" | "lapsed" | "unknown";

type SettingsDriveUi = {
  status: "loading" | "ready" | "unavailable";
  /** The "Push until when?" chooser is open. */
  composing: boolean;
  choice: SettingsDriveUntilChoice | null;
  /** The picked last day (YYYY-MM-DD) when `choice` is "date". */
  date: string;
  /** The athlete's own sentence, optional; it becomes the Changes feed's "You said". */
  words: string;
  /** "Back to steady from today?" is showing. */
  confirmingEnd: boolean;
  busy: boolean;
  error: string | null;
  /** The server's plain-words note after a write ("This block ends Sunday…"). */
  note: string | null;
};

type ClientSettingsDriveControllerDeps = {
  /** The card element; the controller owns its innerHTML. */
  root: HTMLElement;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  toast(message: string): void;
  /** The card's last-known read (SWR), painted before the fetch lands. */
  cache?: { peek(key: string): unknown; set(key: string, value: unknown): void };
  /** Drop every cache a drive write makes stale (write-invalidation `training_drive`). */
  onWrite?(): void;
};

type ClientSettingsDriveHandle = {
  ready: Promise<void>;
  refresh(): Promise<void>;
  snapshot(): { read: import("../contracts/training-drive.js").ClientTrainingDriveRead | null; ui: SettingsDriveUi };
};
