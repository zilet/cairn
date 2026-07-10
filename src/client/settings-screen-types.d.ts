// Erased declarations for Settings shell/controllers. Keep execution code in src/client/settings-*.ts.

type SettingsScreenAgent = {
  name: string;
  description?: string;
  enabled?: boolean;
  configured?: boolean;
  can_login?: boolean;
  models_list?: boolean;
} & Record<string, unknown>;

type SettingsScreenData = {
  settings: Record<string, unknown>;
  agents: SettingsScreenAgent[];
  research_auto_eligible?: boolean | { eligible?: boolean; reason?: string };
};

type SettingsScreenWorkingModel = {
  agent_strategy: string;
  order: string[];
  disabled: Set<string>;
  routes: Record<string, string>;
  enrich_enabled: boolean;
  art_enabled: boolean;
  research_enabled: boolean;
  gemini_api_key: string;
  garmin_username: string;
  garmin_password: string;
  coach_enabled: boolean;
  coach_day: number;
  coach_hour: number;
  update_check_enabled: boolean;
  lead_mode: "lead" | "announce_first" | "review_everything";
};

type SettingsScreenPersistBody = {
  agent_strategy: string;
  agent_order: string[];
  disabled_agents: string[];
  enrich_enabled: boolean;
  art_enabled: boolean;
  research_enabled: boolean;
  garmin_username: string;
  coach_enabled: boolean;
  coach_day: number;
  coach_hour: number;
  agent_routes: Record<string, string>;
  update_check_enabled: boolean;
  lead_mode: "lead" | "announce_first" | "review_everything";
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
  started_at?: string;
  finished_at?: string;
  error?: string;
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
};
