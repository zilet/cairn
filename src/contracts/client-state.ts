import type {
  ClientDayIntake,
  ClientDayRead,
  ClientGoalCheck,
  ClientHealthSection,
  ClientMeSection,
  ClientPlanDay,
  ClientPlanSection,
  ClientProgressSection,
  ClientSessionSuggestion,
  ClientSettingsSection,
  ClientStandSection,
  ClientTabName,
} from "./client.js";

export type ClientBriefCache = {
  date: string;
  override: string;
  read: ClientDayRead;
};

export type ClientAppState = {
  tab: ClientTabName;
  day: number | null;
  dayPicked: boolean;
  plan: ClientPlanDay[];
  today: Record<string, unknown>;
  logDate: string;
  planSeg?: ClientPlanSection;
  planJump?: ClientPlanSection | null;
  progressSeg?: ClientProgressSection;
  progressEx?: string;
  standSeg?: ClientStandSection | null;
  meSeg?: ClientMeSection;
  healthSeg?: ClientHealthSection;
  healthSegPicked?: boolean;
  setSeg?: ClientSettingsSection;
  pendingChatSession?: string | null;
  pendingHealthDocId?: string | null;
  pendingHealthScroll?: "hbDirectives" | string | null;
  chatPrefill?: string | null;
  brief?: ClientBriefCache | null;
  _briefInflight?: { date: string; override: string; promise: Promise<ClientDayRead> } | null;
  _briefMorph?: boolean;
  planReveal?: { date: string; on: boolean; blank?: boolean };
  suggestedSession?: ClientSessionSuggestion | null;
  exModes?: Record<string, string>;
  pendingOffPlan?: Record<string, Array<{ name: string; mode?: string | null }>>;
  _dayFuel?: ClientDayIntake | null;
  _goal?: ClientGoalCheck | null;
  _lifeById?: Record<string, unknown>;
  _famById?: Record<string, unknown>;
  _notesById?: Record<string, unknown>;
  healthReview?: unknown;
  healthStandingRef?: number;
};
