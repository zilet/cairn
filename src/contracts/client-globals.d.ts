import type {
  ClientActivity,
  ClientDayRead,
  ClientChatMessage,
  ClientChatSearchHit,
  ClientChatSessionSummary,
  ClientApiResponse,
  ClientDayIntake,
  ClientGoalCheck,
  ClientPlanDay,
  ClientPrescription,
  ClientTrainingSession,
  ClientTodayAgenda,
  ClientTodayAgendaCandidate,
} from "./client.js";

declare global {
  type ClientTabName = "today" | "plan" | "progress" | "chat" | "me" | "settings";
  type ClientPlanSection = "edit" | "food" | "meals" | "coach" | "endurance";
  type ClientProgressSection = "sessions" | "trend" | "volume" | "endurance" | "weight" | "calendar" | "program";
  type ClientMeSection = "standing" | "profile" | "memory" | "health" | "life" | "family";
  type ClientHealthSection = "read" | "markers" | "records" | "share" | "learned";
  type ClientSettingsSection = "agents" | "sources" | "automation" | "data";

  type ClientBriefCache = {
    date: string;
    override: string;
    read: ClientDayRead;
  };

  type ClientAppState = {
    tab: ClientTabName;
    day: number | null;
    dayPicked: boolean;
    plan: ClientPlanDay[];
    today: Record<string, unknown>;
    logDate: string;
    planSeg?: ClientPlanSection;
    planJump?: ClientPlanSection | null;
    progressSeg?: ClientProgressSection;
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
    focus?: { date: string; on: boolean };
    planReveal?: { date: string; on: boolean; blank?: boolean };
    suggestedSession?: ClientTrainingSession | null;
    exModes?: Record<string, string>;
    pendingOffPlan?: Record<string, Array<Record<string, unknown>>>;
    _dayFuel?: ClientDayIntake | null;
    _goal?: ClientGoalCheck | null;
    _lifeById?: Record<string, unknown>;
    _famById?: Record<string, unknown>;
    _notesById?: Record<string, unknown>;
    healthReview?: unknown;
    healthStandingRef?: number;
  };

  type ClientAgentOpHandlers = {
    path?: string;
    anchor?: string;
    guard?: () => boolean;
    isFail?: (result: unknown) => boolean;
    render?: (result: unknown) => void;
    onFail?: (error: unknown) => void;
    onDone?: (result: unknown) => void;
    onError?: (error?: unknown) => void;
    onCanceled?: () => void;
  };

  declare function $<T extends Element = Element>(selector: string): T | null;
  declare const state: ClientAppState;

  declare let pollToken: unknown;
  declare const view: HTMLElement;
  declare const headerTitle: HTMLElement;

  declare function skelSwap(fn: () => void): void;
  declare function escHtml(value: unknown): string;
  declare function escAttr(value: unknown): string;
  declare function foodNum(value: unknown): number | null;
  declare function formatFoodNum(value: unknown): string;
  declare function fmtWeight(weight: unknown): string;
  declare function parseDur(text: unknown): number | null;
  declare function fmtDur(sec: unknown): string;
  declare function fmtPaceKm(minPerKm: unknown): string;
  declare function fmtKm(km: unknown): string;
  declare function fmtSpeedKmh(kmh: unknown): string;
  declare function prDistLabel(km: unknown): string;
  declare function authToken(): string;
  declare function withToken(url: string): string;
  declare function deviceTimeZone(): string;
  declare function localISO(date?: Date): string;
  declare function api<Path extends string>(
    p: Path,
    opts?: RequestInit & { headers?: Record<string, string> },
  ): Promise<ClientApiResponse<Path>>;
  declare function setOffline(on: unknown): void;
  type SwrPeek<T> = { data: T; fresh: boolean };
  type SwrUpgradeMeta = { changed: boolean };
  type CachedApiOptions<T> = { key?: string; freshFor?: number; onUpgrade?: (data: T, meta: SwrUpgradeMeta) => void };
  type PaintSwrOptions<T> = {
    key?: string;
    path?: string;
    peek?: SwrPeek<T> | null;
    render?: (data: T, meta: { warm: boolean }) => void;
    token?: unknown;
    freshFor?: number;
    tab?: string | null;
  };
  declare function peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
  declare function cachedApi<Path extends string>(
    path: Path,
    options?: CachedApiOptions<ClientApiResponse<Path>>,
  ): Promise<ClientApiResponse<Path>>;
  declare function paintSWR<Path extends string>(
    options?: PaintSwrOptions<ClientApiResponse<Path>> & { path?: Path },
  ): Promise<ClientApiResponse<Path> | undefined>;
  declare function markRefreshing(on: unknown): void;
  declare function swrInvalidate(keyOrPrefix: string): void;
  declare function swrSweep(): void;
  declare function stagger(index?: number | null): string;
  declare function activateTab(name: string, opts?: Record<string, unknown>): void;
  declare function toast(message: string): void;
  declare function reshapeToday(): Promise<void>;
  declare function reducedMotion(): boolean;
  declare function art(kind: string, text: string): string;
  declare function pollEnrichment(
    path: "/activities" | "/food-notes" | string,
    id: number,
    options?: {
      tab?: string;
      token?: unknown;
      onUpdate?: (row: ClientActivity & Record<string, unknown>) => void;
    },
  ): void;
  declare function enrichmentActive(status: unknown): boolean;
  declare function actEntryHtml(activity: ClientActivity & Record<string, unknown>): string;
  declare function updateActEntry(el: Element, row: ClientActivity & Record<string, unknown>): void;
  declare function runOp(kind: string, body: Record<string, unknown>, options?: ClientAgentOpHandlers): unknown;
  declare function collapseEl(el: Element, done?: () => void): void;
  declare function registerJobReconnector(kind: string, factory: (job?: unknown) => unknown): void;
  declare function reconnectSessionSuggest(job?: unknown): unknown;
  declare function reconnectMealPlan(job?: unknown): unknown;
  declare function reconnectMealSwap(job?: unknown): unknown;
  declare function reconnectRecipe(job?: unknown): unknown;
  declare function reconnectDayReadOverride(job?: unknown): unknown;
  declare function reconnectNutritionCheckin(job?: unknown): unknown;
  declare function reconnectInsight(job?: unknown): unknown;
  declare function reconnectProposal(job?: unknown): unknown;

  interface Window {
    registerAppJobReconnectors(): void;

    CairnChatClient: {
      CHAT_IMAGE_MAX_BYTES: number;
      CHAT_IMAGE_EDGE_STEPS: number[];
      CHAT_IMAGE_QUALITY_STEPS: number[];
      base64DecodedBytes(base64: unknown): number;
      imagePayload(dataUrl: unknown): { dataUrl: string; base64: string; mime: "image/jpeg"; bytes: number };
      dayISO(timestamp: unknown, localISO: (date?: Date) => string): string;
      messageHasFoodAction(message: Partial<ClientChatMessage> | null | undefined): boolean;
      userMessageSuggestsFood(message: Partial<ClientChatMessage> | null | undefined): boolean;
      wantsFuelSurface(
        messages: Partial<ClientChatMessage>[] | null | undefined,
        options: { todayISO: string; dayISO(timestamp: unknown): string },
      ): boolean;
      fuelHtml(day: ClientDayIntake | null | undefined): string;
      highlightTerm(text: unknown, query: unknown): string;
      historySessionRow(session: Partial<ClientChatSessionSummary>, whenLabel: string): string;
      historyHitRow(hit: Partial<ClientChatSearchHit>, query: unknown, whenLabel: string): string;
    };

    CairnUi: {
      attrsHtml(attrs: Record<string, unknown> | null | undefined): string;
      actionButtonHtml(action: {
        id?: string;
        label: unknown;
        className?: string;
        attrs?: Record<string, unknown>;
      } | null | undefined): string;
      textChipHtml(options: {
        label: unknown;
        className?: string;
        title?: unknown;
        attrs?: Record<string, unknown>;
      }): string;
      loadingStateHtml(options: {
        label: unknown;
        className?: string;
        live?: boolean;
      }): string;
      segmentedNavHtml(options: {
        active: unknown;
        items: ReadonlyArray<readonly [unknown, unknown]>;
      }): string;
      jobCaptionHtml(options?: {
        text?: unknown;
        className?: string;
        tag?: "span" | "div";
        attrs?: Record<string, unknown>;
      }): string;
      sheetChipHtml(options: {
        label?: unknown;
        value?: unknown;
        className?: string;
        valueClassName?: string;
        labelClassName?: string;
        attrs?: Record<string, unknown>;
      }): string;
      emptyStateHtml(options: {
        title: unknown;
        body?: unknown;
        artHtml?: string;
        action?: {
          id?: string;
          label: unknown;
          className?: string;
          attrs?: Record<string, unknown>;
        } | null;
        className?: string;
        style?: string;
        bodyClassName?: string;
      }): string;
    };

    CairnHealthClient: {
      evidenceSafeUrl(value: unknown): string | null;
      truncateEvidenceBody(text: unknown): string;
      evidenceListHtml(evidence: unknown): string;
      evidenceCountMap(summary: { by_marker?: Array<{ marker?: unknown; count?: unknown }> } | null | undefined): Map<string, number>;
      markersEmptyHtml(heroArt?: string): string;
      formatMarkerNumber(value: unknown): string;
      sparkDateLabel(value: unknown): string;
      markerSpanWord(days: unknown): string;
      markerTrendWord(marker: {
        trend?: { dir?: unknown; span_days?: unknown } | null;
        points?: Array<{ value?: unknown; date?: unknown }> | null;
      } | null | undefined): string;
      isDirectLdlMarker(name: unknown): boolean;
      isStandardLdlMarker(name: unknown): boolean;
      markerRank(groupKey: unknown, name: unknown): number;
      lipidRank(name: unknown): number;
      lipidSubgroup(name: unknown): string | null;
      markerSubgroup(groupKey: unknown, name: unknown): string | null;
      orderMarkersForDisplay<T extends { name?: unknown; key?: unknown }>(groupKey: unknown, list: T[] | null | undefined): T[];
      lipidGroupNoteHtml(
        list: Array<{ name?: unknown; key?: unknown; latest?: { date?: unknown } }> | null | undefined,
        options?: { relAge?: (date: string) => string },
      ): string;
    };

    CairnSettingsClient: {
      AGENT_OP_LABELS: Record<string, string>;
      garminStatusLine(settings: unknown, syncing: boolean, options?: { relTime?: (value: string) => string }): string;
      agentHealthCard(stats: unknown): string;
      agentOpLabel(op: unknown): string;
      agentActivityCard(stats: unknown, options?: { relTime?: (value: string) => string; absDate?: (value: string) => string }): string;
      noticedCard(data: unknown, options?: { relTime?: (value: string) => string; absDate?: (value: string) => string }): string;
      agentChipState(agent: Record<string, unknown>): { cls: string; label: string };
      updateCardHtml(status: unknown, options: { updateCheckEnabled: boolean }): string;
    };

    CairnTodayAgenda: {
      TODAY_RAIL_SLOTS: Record<string, string>;
      TODAY_PRIMARY_CLIENT_MAX: number;
      canRenderCard(candidate: ClientTodayAgendaCandidate | null | undefined): boolean;
      renderableBuckets(agenda: Partial<ClientTodayAgenda> | null | undefined): {
        primary: ClientTodayAgendaCandidate[];
        more: ClientTodayAgendaCandidate[];
      };
      genericCardHtml(candidate: ClientTodayAgendaCandidate, revealIdx: number): string;
      railHtml(agenda: Partial<ClientTodayAgenda> | null | undefined, genericPending: ClientTodayAgendaCandidate[]): string;
      fuelCardHtml(day: ClientDayIntake | null | undefined): string;
    };

    CairnTodayTraining: {
      RX_ACTION: Record<string, { word: string; cls: string }>;
      rxTargetText(rx: Partial<ClientPrescription> | null | undefined): string;
      exRxVaryMenuHtml(rx: Partial<ClientPrescription> | null | undefined): string;
      exRxLineHtml(rx: Partial<ClientPrescription> | null | undefined): string;
      rxMoveCount(rxByExercise: Record<string, Partial<ClientPrescription> | null | undefined> | null | undefined): number;
      cardioDominantZone(zones: unknown): string;
      cardioVerb(label: unknown): string;
      cardioLogPhrase(item: Record<string, unknown>): string;
    };
  }

  declare const CairnChatClient: Window["CairnChatClient"];
  declare const CairnUi: Window["CairnUi"];
  declare const CairnHealthClient: Window["CairnHealthClient"];
  declare const CairnSettingsClient: Window["CairnSettingsClient"];
  declare const CairnTodayAgenda: Window["CairnTodayAgenda"];
  declare const CairnTodayTraining: Window["CairnTodayTraining"];
}
