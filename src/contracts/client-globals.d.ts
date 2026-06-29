import type {
  ClientChatMessage,
  ClientChatSearchHit,
  ClientChatSessionSummary,
  ClientApiResponse,
  ClientDayIntake,
  ClientPrescription,
  ClientTodayAgenda,
  ClientTodayAgendaCandidate,
} from "./client.js";

declare global {
  declare const state: {
    tab?: string;
  };

  declare let pollToken: unknown;

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

  interface Window {
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
