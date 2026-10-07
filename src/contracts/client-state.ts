import type {
  ClientDayIntake,
  ClientDayRead,
  ClientGoalCheck,
  ClientHealthSection,
  ClientHomeName,
  ClientHorizonSection,
  ClientMeSection,
  ClientPlanDay,
  ClientPlanSection,
  ClientProgressSection,
  ClientSessionSuggestion,
  ClientSettingsSection,
  ClientStandSection,
  ClientTabName,
  ClientYouSection,
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
  // The calendar day measured WHEN logDate was picked. A pick made on the day it
  // names was "today" then and merely goes stale at midnight, so it rolls forward;
  // a pick made while looking at another day is deliberate and is left alone.
  dayPickedOn?: string | null;
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
  // The marker domain open behind /app/stand/domain?id=<key>. Set alongside
  // standSeg="domain" so a reload/deep link reopens the same drill-in, and
  // cleared whenever Stand steps back to the overview.
  standDomain?: string | null;
  // Horizon's sub-view (null = the one timeline) and You's (null = the landing;
  // "stone" = one stone's detail, keyed by youStone, which rides in ?id=).
  horizonSeg?: ClientHorizonSection | null;
  // The day the day page shows (/app/day/<date>): any day that is not today,
  // read-only. Today itself never rides here; Today always renders today.
  dayDate?: string | null;
  // The home that opened the page (drill-controller.ts, CairnDrill.open): the tab bar
  // keeps it lit and the back link names it and returns to it. Null = Today.
  drillFrom?: ClientHomeName | null;
  // An in-app opener sits behind the page's history entry, so Back is history.back();
  // false on a cold deep link, where Back lands on drillFrom's root instead.
  drillBack?: boolean;
  youSeg?: ClientYouSection | null;
  youStone?: string | null;
  pendingHealthScroll?: "hbDirectives" | string | null;
  chatPrefill?: string | null;
  capturePrefill?: string | null;
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
