import type {
  ClientActivity,
  ClientDayRead,
  ClientChatMessage,
  ClientChatSearchHit,
  ClientChatSessionSummary,
  ClientHealthSection as ContractClientHealthSection,
  ClientMeSection as ContractClientMeSection,
  ClientPlanSection as ContractClientPlanSection,
  ClientProgressSection as ContractClientProgressSection,
  ClientApiResponse,
  ClientCoachingFocus,
  ClientRoute,
  ClientRoutesApi,
  ClientSettingsSection as ContractClientSettingsSection,
  ClientTabName as ContractClientTabName,
  ClientDayIntake,
  ClientGoalCheck,
  ClientPlanDay,
  ClientPrescription,
  ClientSessionSuggestion,
  ClientTodayAgenda,
  ClientTodayAgendaCandidate,
} from "./client.js";

declare global {
  type ClientTabName = ContractClientTabName;
  type ClientPlanSection = ContractClientPlanSection;
  type ClientProgressSection = ContractClientProgressSection;
  type ClientMeSection = ContractClientMeSection;
  type ClientHealthSection = ContractClientHealthSection;
  type ClientSettingsSection = ContractClientSettingsSection;
  type ClientSegment = readonly [string, string];
  type ClientSettingsRouteTask = readonly [string, string];
  type ClientSaveBar = { markDirty(): void; save(): Promise<void> };

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
    progressEx?: string;
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
    suggestedSession?: ClientSessionSuggestion | null;
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
    caption?: string | readonly string[];
    guard?: () => boolean;
    isFail?: (result: unknown) => boolean;
    render?: (result: unknown) => void;
    onFail?: (error: unknown) => void;
    onDone?: (result: unknown) => void;
    onError?: (error?: unknown) => void;
    onCanceled?: () => void;
  };

  type ClientAppRouterApi = {
    ROUTE_TABS: ClientTabName[];
    routeKey(key: unknown, items: ReadonlyArray<string | readonly [string, unknown]>, fallback?: string | null): string | null;
    applyRouteState(
      route: ClientRoute | null | undefined,
      options: {
        state: ClientAppState;
        routeApi?: ClientRoutesApi | null;
        planSections: ReadonlyArray<string | readonly [string, unknown]>;
        progressSections: ReadonlyArray<string | readonly [string, unknown]>;
        meSections: ReadonlyArray<string | readonly [string, unknown]>;
        healthSections: ReadonlyArray<string | readonly [string, unknown]>;
        settingsSections: ReadonlyArray<string | readonly [string, unknown]>;
      },
    ): ClientTabName;
    currentRouteState(options: {
      state: ClientAppState;
      planSections: ReadonlyArray<string | readonly [string, unknown]>;
      progressSections: ReadonlyArray<string | readonly [string, unknown]>;
      meSections: ReadonlyArray<string | readonly [string, unknown]>;
      healthSections: ReadonlyArray<string | readonly [string, unknown]>;
      settingsSections: ReadonlyArray<string | readonly [string, unknown]>;
      defaultProgressSection: string | null;
    }): Partial<ClientRoute>;
    syncRouteFromState(options: {
      mode?: "push" | "replace";
      routes?: ClientRoutesApi | null;
      route: Partial<ClientRoute>;
      location: Pick<Location, "pathname" | "search">;
      history?: Pick<History, "pushState" | "replaceState"> | null;
    }): string | null;
  };

  declare function $<T extends Element = Element>(selector: string): T | null;
  declare const state: ClientAppState;

  declare const view: HTMLElement;
  declare const headerTitle: HTMLElement;
  declare const ME_SEG: readonly ClientSegment[];
  declare const ME_HANDLERS: Record<string, () => unknown>;
  declare const HEALTH_SEG: readonly ClientSegment[];
  declare const SET_SEG: readonly ClientSegment[];
  declare var MEALS_KEY: string;
  declare const MEAL_LABEL: Record<string, string>;
  declare var _progFocusCard: string | undefined;

  declare function skelSwap(fn: () => void): void;
  declare function escHtml(value: unknown): string;
  declare function escAttr(value: unknown): string;
  declare function relTime(iso: string): string;
  declare function relAge(iso: string): string;
  declare function absDate(iso: string): string;
  declare function humanDate(iso: string): string;
  declare function humanizeReviewText(text: string, latestISO: string | null | undefined): string;
  declare function latestReviewDate(parsed: unknown): string | null;
  declare function learnedTimelineHtml(data: unknown): string;
  declare function foodNum(value: unknown): number | null;
  declare function formatFoodNum(value: unknown): string;
  declare function fmtWeight(weight: unknown): string;
  declare function parseDur(text: unknown): number | null;
  declare function fmtDur(sec: unknown): string;
  declare function fmtPaceKm(minPerKm: unknown): string;
  declare function fmtKm(km: unknown): string;
  declare function sparklineSvg(vals: unknown, w?: number, h?: number): string;
  declare function fmtSpeedKmh(kmh: unknown): string;
  declare function prDistLabel(km: unknown): string;
  declare function authToken(): string;
  declare function withToken(url: string): string;
  declare function downloadFile(href: string): void;
  declare function deviceTimeZone(): string;
  declare function localISO(date?: Date): string;
  declare function dateLabel(iso: string): string;
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
  declare function routeApi(): ClientRoutesApi | null;
  declare function routeKey(key: unknown, items: ReadonlyArray<string | readonly [string, unknown]>, fallback?: string | null): string | null;
  declare function applyRouteState(route: ClientRoute | null | undefined): ClientTabName;
  declare function currentRouteState(): Partial<ClientRoute>;
  declare function activateTab(name: unknown, opts?: { replace?: boolean; syncRoute?: boolean }): void;
  declare function toast(message: string): void;
  declare function armDelete(
    btn: Element,
    onConfirm: () => unknown,
    options?: { label?: string },
  ): void;
  declare function mountSaveBar(options: {
    sentinel: Element | null;
    fields: Element;
    onSave: () => boolean | Promise<boolean>;
    onDiscard: () => unknown;
  }): ClientSaveBar;
  declare function segBar(active: string, items: readonly ClientSegment[]): string;
  declare function wireSeg(handlers: Record<string, () => unknown>): void;
  declare function fitSeg(seg: Element): void;
  declare function loadingState(label: string): string;
  declare function isStandalonePWA(): boolean;
  declare function getInstallGuidance(): { mode: string } | null;
  declare function phoneCoachContent(mode: string): string;
  declare function renderPhoneCoachBanner(container: Element | null | undefined): void;
  declare function refreshPhoneCoach(): void;
  declare function fmtShortDate(iso: unknown): string;
  declare function progressHero(
    title: unknown,
    stats: Array<readonly [unknown, unknown] | readonly [unknown, unknown, { text?: boolean; k?: boolean }] | null | undefined | false>,
  ): string;
  declare function emptyStateHtml(svg: string | null | undefined, line: unknown): string;
  declare function withAlpha(hex: unknown, alpha: number): string;
  declare function drawLineChart(canvas: HTMLCanvasElement | null | undefined, pts: Array<{ date: string; v: number }>, opts?: {
    goal?: number | null;
    fmt?: (value: number) => string;
    peak?: boolean;
  }): void;
  declare function runCountUps(scope?: ParentNode | null, options?: { snap?: boolean }): void;
  declare function chartColors(): {
    accent: string;
    sage: string;
    gold: string;
    ink: string;
    paper: string;
    card: string;
    line2: string;
    label: string;
  };
  declare function runKindClass(kind: unknown): string;
  declare function runKindLabel(kind: unknown): string;
  declare function sessionCardHtml(session: unknown, index: number): string;
  declare function numOrNull(value: unknown): number | null;
  declare function weeklyRunPlanCard(plan: unknown): string;
  declare function enduranceGoalCard(goal: unknown): string;
  declare function runComplianceLine(compliance: unknown): string;
  declare function enduranceCoachLine(plan: unknown): string;
  declare function capWord(input: unknown): string;
  declare function volBalanceHtml(balance: unknown): string;
  declare const CONF_WORD: Record<string, string>;
  declare function kcalFmt(value: unknown): string;
  declare function energyRead(exp: unknown): { lead: string; body: string; tone: string; dir?: string | null };
  declare function calMonthHtml(ym: string, byDate: Map<string, unknown>, todayIso: string, idx: number): string;
  declare function loadMuscleTrajectory(): Promise<void>;
  declare function muscleVerdictTone(verdict: unknown): string;
  declare function muscleVerdictWord(verdict: unknown): string;
  declare function muscleTrendGlyph(trend: unknown): string;
  declare function muscleGroupRowHtml(group: unknown): string;
  declare function muscleTrajectoryHtml(trajectory: unknown): string;
  declare function loadDexaTargeting(slotId: string): Promise<void>;
  declare function dexaTargetToneCls(target: unknown): string;
  declare function dexaTargetHtml(target: unknown): string;
  declare function dexaTargetingHtml(targeting: unknown): string;
  declare function loadPerformance(): Promise<void>;
  declare function pctClamp(value: unknown): number;
  declare function capacityRowHtml(capacity: unknown, sexWord: unknown): string;
  declare function performanceHtml(performance: unknown, options?: { suppressLever?: boolean }): string;
  declare const PADJ_KIND: Record<string, { glyph: string; cls: string }>;
  declare function loadProgramAdjustments(): Promise<void>;
  declare function programAdjustmentsHtml(rows: unknown): string;
  declare function loadTestWeek(): Promise<void>;
  declare function testWeekBannerHtml(testWeek: unknown): string;
  declare function liftStatusWord(lift: unknown): string;
  declare function liftTrendFig(lift: unknown): string;
  declare function liftBestFig(lift: unknown): string;
  declare function sortLifts(lifts: unknown): unknown[];
  declare function volBandWord(band: unknown): string;
  declare function volTrendGlyph(trend: unknown): string;
  declare function phaseWord(phase: unknown): string;
  declare function liftRowHtml(lift: unknown, index: number): string;
  declare function volumeBlockHtml(volume: unknown, startIdx: number): string;
  declare function mesoBlockHtml(meso: unknown, index: number): string;
  declare function adaptationsHtml(adaptations: unknown, index: number): string;
  declare function blockFocusWord(focus: unknown): string;
  declare function activeBlockHtml(block: unknown): string;
  declare function startBlockHtml(): string;
  declare function loadProgramBlock(): Promise<void>;
  declare function wireProgramBlock(slot: Element): void;
  declare function cfocusDomainTag(domain: unknown): string;
  declare function coachingFocusCardHtml(focus: ClientCoachingFocus | null | undefined): string;
  declare function loadCoachingFocus(slotSelector: string, root?: ParentNode | null): Promise<void>;
  declare function coachingFocusThreadHtml(focus: ClientCoachingFocus | null | undefined): string;
  declare function cfocusRoute(go: unknown): void;
  declare function openAgentLoginModal(agentName: string): unknown;
  declare function mdSafeUrl(url: unknown): string | null;
  declare function mdInline(source: string): string;
  declare function mdToHtml(source: unknown): string;
  declare function settingsRouteTasks(data: unknown): ClientSettingsRouteTask[];
  declare function settingsPruneRoutes(
    routes: Record<string, string>,
    routeTasks: readonly ClientSettingsRouteTask[],
    enabledAgents: readonly { name: string }[],
  ): Record<string, string>;
  declare function settingsRouteRowsHtml(
    routeTasks: readonly ClientSettingsRouteTask[],
    enabledAgents: readonly { name: string }[],
    routes: Record<string, string>,
  ): string;
  declare function isCardioItem(item: unknown): boolean;
  declare function cardioIntervalNote(interval: unknown): string;
  declare function cardioIntervalStructure(interval: unknown, targetZone: unknown): string;
  declare function cardioArtPhrase(item: Record<string, unknown> | null | undefined): string;
  declare function cardioNoteIsDescriptive(note: unknown): boolean;
  declare function cardioSport(item: Record<string, unknown> | null | undefined): string;
  declare function derivedCardioLabel(item: Record<string, unknown> | null | undefined): string;
  declare function cardioLabel(item: Record<string, unknown> | null | undefined): string;
  declare function cardioDescription(item: Record<string, unknown> | null | undefined): string;
  declare function cardioPrescription(item: Record<string, unknown> | null | undefined): string;
  declare function garminConfigured(settings: Record<string, unknown> | null | undefined): boolean;
  declare function cardioSyncLine(
    settings: Record<string, unknown> | null | undefined,
    opts?: { expectingRun?: unknown },
  ): string;
  declare function enduranceStatusWord(status: unknown): string;
  declare function enduranceBlockHtml(
    end: { status?: unknown; last_week_km?: unknown; longest_km_4wk?: unknown; why?: unknown } | null | undefined,
    idx: number,
  ): string;
  declare function paceTrendWord(trend: unknown): string;
  declare function zoneBarHtml(zones: unknown): string;
  declare function enduranceBestRows(group: unknown): unknown[];
  declare function enduranceSportCardHtml(group: unknown, idx: number): string;
  declare const HR_ZONE_COLORS: string[] | undefined;
  declare function reshapeToday(): Promise<void>;
  declare function setDiscipline(discipline: unknown): string;
  declare function setEnduranceGoalSet(present: unknown): boolean;
  declare function defaultProgressSeg(): string;
  declare function renderTab(tab: string): unknown;
  declare function renderToday(): unknown;
  declare function renderFoodJournal(): unknown;
  declare function renderMeals(): unknown;
  declare function renderCoach(): unknown;
  declare function rerenderFoodSurface(): void;
  declare function loadMealProvenance(): unknown;
  declare function paintEnergyBody(exp: unknown): void;
  declare function applyProposalById(id: string | number | undefined, btn?: Element | null): Promise<unknown>;
  declare function renderPlanEndurance(): unknown;
  declare function paintPlanEndurance(goalValue: unknown, compliance: unknown, plan: unknown, settings: Record<string, unknown> | null): void;
  declare function gotoChatWith(text: string): void;
  declare function enduranceComposerLock(): void;
  declare function enduranceComposerRestore(): void;
  declare function draftEnduranceRuns(instruction: unknown): void;
  declare function enduranceProposalOpOpts(): ClientAgentOpHandlers;
  declare function renderEnduranceDraftResult(proposal: unknown): void;
  declare function runTargetText(run: Record<string, unknown>): string;
  declare function statusBadge(status: unknown): string;
  declare function applyResultMessage(result: unknown): { failed: boolean; message: string };
  declare function clampNoteHtml(clamped: unknown): string;
  declare function verifiedBadgeHtml(verified: unknown): string;
  declare function strengthChangeHtml(change: unknown): string;
  declare function isOpenProposal(proposal: unknown): boolean;
  declare function dayFuelHtml(day: Record<string, unknown> | null | undefined): string;
  declare function renderPlanEditor(): unknown;
  declare function renderHistory(): unknown;
  declare function renderProgress(): unknown;
  declare function renderWeight(): unknown;
  declare function renderVolume(): unknown;
  declare function renderEndurance(): unknown;
  declare function renderCalendar(): unknown;
  declare function renderEnergy(): unknown;
  declare function renderProgram(): unknown;
  declare function renderChat(): unknown;
  declare function autosizeChatInput(input: HTMLTextAreaElement | HTMLInputElement): void;
  declare function renderMe(): unknown;
  declare function renderMemory(): Promise<void>;
  declare function renderLife(): Promise<void>;
  declare function renderFamily(): Promise<void>;
  declare function renderSettings(): unknown;
  declare function switchHealthSeg(seg: ClientHealthSection, opts?: { openPicker?: boolean }): void;
  declare function loadHealthMarkers(token: number): void;
  declare function paintHealthMarkersTab(): void;
  declare function paintHealthRecordsTab(): void;
  declare function paintHealthShareTab(): void;
  declare function paintHealthLearnedTab(): void;
  declare function paintHealthPicture(): void;
  declare var _hPic: { review?: unknown; docCount?: number; newestDocAt?: string | null } | null;
  declare function postExerciseMode(name: string, mode: string): Promise<unknown>;
  declare function updateHeaderCondense(): void;
  declare function switchTab(tab: unknown, opts?: { replace?: boolean; syncRoute?: boolean }): void;
  declare function registerTabBarHandlers(): void;
  declare function syncRouteFromState(mode?: "push" | "replace"): void;
  declare function planSeg(): readonly ClientSegment[];
  declare function todaySkeleton(): string;
  declare function segSkeleton(active: string, seg: readonly ClientSegment[], cards?: number): string;
  declare function skelLines(count?: number): string;
  declare function viewEnter(): void;
  declare function tabErrorState(tab: string): void;
  declare function chatTeardownMonitor(): void;
  declare function teardownJobs(pred?: unknown): void;
  declare function closeDetail(instant?: boolean): void;
  declare function closeMealSheet(instant?: boolean): void;
  declare function hideSaveBar(): void;
  declare function thinkingCaption(el: Element, op?: string | readonly string[]): () => void;
  declare function btnBusy(btn: Element | null | undefined, text: string, options?: { ghost?: boolean }): () => void;
  declare function openDetailFrom(fromEl: Element | null | undefined, build: () => unknown): void;
  declare function mountDetail(html: string): HTMLElement;
  declare function wireDetailCommon(): void;
  declare function openFoodDetail(note: unknown, fromTile?: Element | null): Promise<void>;
  declare function wireCardioSync(root: ParentNode, onDone?: () => unknown): void;
  declare function measureChatTop(): void;
  declare function ensureRestBar(): HTMLElement;
  declare function paintRest(): void;
  declare function startRest(seconds?: number): void;
  declare function stopRest(): void;
  declare function artImg(kind: string, text: string, className?: string, svg?: string | null): string;
  declare function setsTonnage(sets: unknown): number;
  declare function enrichBadge(status: unknown): string;
  declare function activityLine(activity: ClientActivity & Record<string, unknown>): string;
  declare function pollEnrichment(
    path: "/activities" | "/food-notes" | string,
    id: number,
    options?: {
      tab?: string;
      token?: unknown;
      tries?: number;
      interval?: number;
      onUpdate?: (row: ClientActivity & Record<string, unknown>) => void;
    },
  ): void;
  declare function enrichmentActive(status: unknown): boolean;
  declare function healthKindLabel(kind: unknown): string;
  declare function parsedDoc(doc: unknown): { markers?: Array<Record<string, unknown>>; type?: unknown } | null;
  declare function markerFlagClass(flag: unknown): string;
  declare function markersTable(parsed: unknown): string;
  declare function docCollapsible(doc: unknown): boolean;
  declare function healthDocInner(doc: unknown): string;
  declare function healthDocHtml(doc: unknown, index?: number): string;
  declare function actArtText(activity: ClientActivity & Record<string, unknown>): string;
  declare function actEntryHtml(activity: ClientActivity & Record<string, unknown>): string;
  declare function updateActEntry(el: Element, row: ClientActivity & Record<string, unknown>): void;
  declare function runOp(kind: string, body: Record<string, unknown>, options?: ClientAgentOpHandlers): Promise<unknown>;
  declare function collapseEl(el: Element, done?: () => void): void;
  declare function registerJobReconnector(kind: string, factory: (job?: unknown) => unknown): void;
  declare function registerAppJobReconnectors(): void;
  declare function installMobileViewportGuards(): void;
  declare function reconnectSessionSuggest(job?: unknown): unknown;
  declare function reconnectMealPlan(job?: unknown): unknown;
  declare function reconnectMealSwap(job?: unknown): unknown;
  declare function reconnectRecipe(job?: unknown): unknown;
  declare function reconnectDayReadOverride(job?: unknown): unknown;
  declare function reconnectNutritionCheckin(job?: unknown): unknown;
  declare function reconnectInsight(job?: unknown): unknown;
  declare function reconnectProposal(job?: unknown): unknown;
  declare function registerServiceWorkerLifecycle(): void;
  declare function primeDiscipline(): void;
  declare function maybeOnboard(): Promise<void>;
  declare function openOnboarding(): void;
  declare function primeArtManifest(): Promise<void>;
  declare function jobReconnect(): Promise<void>;
  declare function startAppShell(): void;

  interface Window {
    activateTab(name: unknown, opts?: { replace?: boolean; syncRoute?: boolean }): void;
    applyRouteState(route: ClientRoute | null | undefined): ClientTabName;
    currentRouteState(): Partial<ClientRoute>;
    defaultProgressSeg(): string;
    registerTabBarHandlers(): void;
    routeApi(): ClientRoutesApi | null;
    routeKey(key: unknown, items: ReadonlyArray<string | readonly [string, unknown]>, fallback?: string | null): string | null;
    syncRouteFromState(mode?: "push" | "replace"): void;
    switchTab(tab: unknown, opts?: { replace?: boolean; syncRoute?: boolean }): void;
    renderTab(tab: string): unknown;
    downloadFile(href: string): void;
    CairnRoutes?: ClientRoutesApi;
    registerAppJobReconnectors(): void;
    installMobileViewportGuards(): void;
    registerServiceWorkerLifecycle(): void;
    primeDiscipline(): void;
    maybeOnboard(): Promise<void>;
    openOnboarding(): void;
    startAppShell(): void;
    CairnAppRouter: ClientAppRouterApi;

    CairnChatClient: {
      CHAT_IMAGE_MAX_BYTES: number;
      CHAT_IMAGE_EDGE_STEPS: number[];
      CHAT_IMAGE_QUALITY_STEPS: number[];
      CHAT_STARTERS: string[];
      base64DecodedBytes(base64: unknown): number;
      imagePayload(dataUrl: unknown): { dataUrl: string; base64: string; mime: "image/jpeg"; bytes: number };
      shellHtml(): string;
      headerActionsHtml(): string;
      freshPillHtml(distilled: unknown): string;
      emptyHtml(): string;
      starterChipsHtml(starters?: readonly unknown[]): string;
      dividerHtml(iso: unknown, label: unknown): string;
      earlierBarHtml(): string;
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

    CairnExerciseDetail: {
      explanation(exercise: { name?: unknown; muscle_group?: unknown } | null | undefined): {
        setup?: unknown;
        move?: unknown;
        feel?: unknown;
        avoid?: unknown;
      };
      explanationHtml(
        exercise: { name?: unknown; muscle_group?: unknown } | null | undefined,
        explanation?: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null,
      ): string;
      validExplanationPayload(payload: {
        ok?: unknown;
        explanation?: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null;
      } | null | undefined): boolean;
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
      MAX_DOC_BYTES: number;
      MAX_DOC_TEXT: number;
      H_FILE_PROMPT: string;
      HEALTH_HERO_ART: string;
      DIRECTIVE_DOMAINS: readonly (readonly [string, string, string])[];
      guessUploadMime(file: { type?: unknown; name?: unknown } | null | undefined): string;
      evidenceSafeUrl(value: unknown): string | null;
      truncateEvidenceBody(text: unknown): string;
      evidenceListHtml(evidence: unknown): string;
      evidenceCountMap(summary: { by_marker?: Array<{ marker?: unknown; count?: unknown }> } | null | undefined): Map<string, number>;
      directiveHtml(
        directive: {
          id?: unknown;
          marker?: unknown;
          uncertain?: unknown;
          citation?: unknown;
          directive?: unknown;
          rationale?: unknown;
        },
        index?: number,
        evidenceMap?: Map<string, number> | null,
      ): string;
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

    CairnHealthPicture: {
      parsedReview(review: { parsed?: unknown; error?: unknown } | null | undefined): Record<string, unknown> | null;
      healthDotClass(flag: unknown): string;
      reviewBusyHtml(): string;
      healthHeroHtml(errorHtml: unknown): string;
      buildPictureHtml(errorHtml: unknown, docCount: unknown): string;
      reviewHtml(
        review: { parsed?: unknown; error?: unknown; created_at?: unknown; agent?: unknown },
        stale: unknown,
        errorHtml: unknown,
      ): string;
    };

    CairnHealthMarkers: {
      formatMarkerNumber(value: unknown): string;
      sparkDateLabel(value: unknown): string;
      markerTrendWord(marker: {
        trend?: { dir?: unknown; span_days?: unknown } | null;
        points?: Array<{ value?: unknown; date?: unknown }> | null;
      } | null | undefined): string;
      markerSpanWord(days: unknown): string;
      markerChartSvg(marker: Record<string, unknown> | null | undefined): string;
      wireMarkerChart(svg: SVGElement | null | undefined): void;
      markerPanelHtml(marker: Record<string, unknown> | null | undefined): string;
      hmkRowHtml(marker: Record<string, unknown> | null | undefined, index?: number): string;
    };

    CairnHealthDirectives: {
      activeDirectives(rows: unknown): Array<Record<string, unknown>>;
      evidenceCountMap(summary: { by_marker?: Array<{ marker?: unknown; count?: unknown }> } | null | undefined): Map<string, number>;
      directiveResearchNudgeHtml(
        active: Array<Record<string, unknown>>,
        evidenceMap: Map<string, number>,
        summary: { research_enabled?: unknown } | null | undefined,
      ): string;
      directivesEmptyHtml(): string;
      directivesSectionHtml(rows: unknown, evSummary: { research_enabled?: unknown; by_marker?: Array<{ marker?: unknown; count?: unknown }> } | null | undefined): string;
    };

    CairnHealthDirectiveLoader: {
      load(token: number): Promise<void>;
    };

    CairnHealthStanding: {
      hstandDecade(age: unknown): number;
      hstandPct(value: unknown): number | null;
      localDateTimeInputValue(date?: Date): string;
      hstandTone(tone: unknown): string;
      hstandBandTone(percentile: unknown): string;
      hstandMeasureHtml(measure: Record<string, unknown> | null | undefined): string;
      hstandCompHtml(comparison: Record<string, unknown>, sexWord: string, calendarAge: unknown): string;
      hstandRefSummaryHtml(comparisons: Array<Record<string, unknown>> | null | undefined, referenceAge: unknown, actualDecade: number | null, sexWord: string): string;
      hstandDimensionHtml(dimension: Record<string, unknown>, index: number): string;
      hstandBpRows(rows: Array<Record<string, unknown>> | null | undefined): string;
      hstandBodyCompHtml(bodyComp: Record<string, unknown> | null | undefined): string;
      hstandBpCardHtml(bp: Record<string, unknown> | null | undefined): string;
      renderHealthStandingHtml(data: Record<string, unknown> | null | undefined, options?: { referenceAge?: unknown }): string;
    };

    CairnHealthRead: {
      recoveryNoDataHtml(message?: string): string;
      recoveryLineHtml(text: unknown, sub: unknown): string;
      recoveryHtml(summary: Record<string, unknown> | null | undefined): string;
      optimalPhrase(marker: Record<string, unknown> | null | undefined): { word: string; tone: "ok" | "warn" | "watch" };
      priorityMarkerHtml(marker: Record<string, unknown> | null | undefined, index: number): string;
      priorityMarkersSectionHtml(markers: unknown): string;
    };

    CairnFoodNote: {
      foodIngredients(value: unknown): Array<Record<string, unknown>>;
      ingredientLabel(ingredient: Record<string, unknown> | null | undefined): string;
      foodItemsText(value: unknown): string;
      foodTitleFromIngredients(value: unknown): string;
      foodMacroText(value: unknown, opts?: { kcal?: boolean; short?: boolean }): string;
      parsedNote(note: Record<string, unknown> | null | undefined): Record<string, unknown> | null;
      noteEntryInner(note: Record<string, unknown>): string;
      noteEntryHtml(note: Record<string, unknown>, index?: number): string;
    };

    CairnPlanEndurance: {
      ENDURANCE_PHASES: readonly Record<string, string>[];
      rampHtml(goal: Record<string, unknown> | null | undefined): string;
      presets(goal: Record<string, unknown> | null | undefined): Array<{ t: string; i: string }>;
      draftCardHtml(proposal: Record<string, unknown>): string;
    };

    CairnPlanEditor: {
      blankStrength(): Record<string, unknown>;
      blankCardio(): Record<string, unknown>;
      dayModelFromPlan(day: Record<string, unknown>): Record<string, unknown>;
      calendarFooterHtml(plan: unknown, host: unknown, icsUrl: unknown): string;
      progDayHtml(day: Record<string, unknown>, dayIndex: number): string;
      pitemHtml(item: Record<string, unknown>, dayIndex: number, itemIndex: number, lastIndex: number): string;
      pdayHtml(day: Record<string, unknown>, dayIndex: number): string;
    };

    CairnDayFuel: {
      MEAL_LABEL: Record<string, string>;
      mealLabelHtml(meal: unknown): string;
      dayFuelHtml(day: Record<string, unknown> | null | undefined): string;
    };

    CairnMealPlan: {
      MEAL_HINT_CHIPS: string[];
      MEAL_PREFS_PLACEHOLDER: string;
      MEAL_PREF_CHIPS: string[];
      mealSlotFor(name: unknown, index: unknown): string;
      currentMealPlan(plans: unknown): Record<string, unknown> | null;
      mealsCtxFor(plan: unknown, now?: unknown): { weekOf: string; targetKcal: number; todayName: string };
      mealRowHtml(meal: unknown, mealIndex?: number, options?: { di?: number; count?: number }): string;
      mealPlanCardHtml(plan: unknown, index: number): string;
      mealPlanListHtml(plans: unknown): string;
      mealPrefsHtml(prefs: unknown, index: number): string;
      mealPlanEmptyHtml(mealPrefs: unknown): string;
      mealPlanHeroHtml(plan: unknown, verified?: unknown): string;
      mealShoppingHtml(shopping: unknown, checkedShopping: unknown, revealIndex: number): string;
      mealPlannerBodyHtml(current: unknown, mealPrefs: unknown, options?: { checkedShopping?: unknown; verified?: unknown; now?: unknown }): {
        html: string;
        context: { weekOf: string; targetKcal: number; todayName: string } | null;
      };
      mealDayHtml(day: unknown, dayIndex: number, context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown }): string;
    };

    CairnMealRecipe: {
      ctaHtml(): string;
      recipeHtml(recipe: unknown): string;
      loadingHtml(): string;
    };

    CairnProposal: {
      statusBadge(status: unknown): string;
      applyResultMessage(result: unknown): { failed: boolean; message: string };
      clampNoteHtml(clamped: unknown): string;
      verifiedBadgeHtml(verified: unknown): string;
      strengthChangeHtml(change: unknown): string;
      runTargetText(run: Record<string, unknown>): string;
      isOpenProposal(proposal: unknown): boolean;
      coachProposalCardHtml(proposal: unknown, index: number, lastApplyClamp?: unknown): string;
      coachProposalListHtml(proposals: unknown, lastApplyClamp?: unknown): string;
    };

    CairnHealthLearned: {
      LEARNED_GROUPS: readonly (readonly [string, string, string])[];
      learnedItemHtml(item: unknown, index: number): string;
      learnedTimelineHtml(data: unknown): string;
    };

    CairnMemory: {
      MEM_KINDS: readonly string[];
      memoryKindOptionsHtml(selected?: unknown): string;
      memoryRowHtml(row: Record<string, unknown>, index?: number): string;
    };

    CairnFamily: {
      FAMILY_COLORS: readonly { v: string; l: string }[];
      FAMILY_DEFAULT_COLOR: string;
      familyColor(color: unknown): string;
      ageFromBirthdate(birthdate: unknown): string;
      familyInitials(name: unknown): string;
      familyCardInner(row: Record<string, unknown>): string;
      familyCardHtml(row: Record<string, unknown>, index?: number): string;
      familySwatches(selected: unknown): string;
    };

    CairnLife: {
      LIFE_KINDS: readonly (readonly [string, string])[];
      LIFE_ICONS: Record<string, string>;
      lifeKindLabel(kind: unknown): string;
      lifeKindOptionsHtml(): string;
      parsedMeta(event: Record<string, unknown> | null | undefined): Record<string, unknown>;
      fmtDateRange(start: unknown, end: unknown): string;
      daysUntil(iso: unknown, todayIso?: string): number | null;
      eventActive(event: Record<string, unknown> | null | undefined, todayIso?: string): boolean;
      lifeFieldsHtml(kind: unknown): string;
      lifeImpactsHtml(impact: Record<string, unknown> | null | undefined): string;
      lifeEventInner(event: Record<string, unknown>, impact?: Record<string, unknown> | null): string;
      lifeEventHtml(
        event: Record<string, unknown>,
        index: number | undefined,
        impactsById?: Record<string, Record<string, unknown>>,
      ): string;
    };

    CairnHealthDocs: {
      healthKindLabel(kind: unknown): string;
      parsedDoc(doc: unknown): { markers?: Array<Record<string, unknown>>; type?: unknown } | null;
      markerFlagClass(flag: unknown): string;
      markersTable(parsed: unknown): string;
      docCollapsible(doc: unknown): boolean;
      healthDocInner(doc: unknown): string;
      healthDocHtml(doc: unknown, index?: number): string;
    };

    CairnHealthRecords: {
      recordsUploadHtml(filePrompt?: string): string;
      recordsEmptyHtml(message?: string): string;
      recordsTabHtml(filePrompt?: string): string;
      normalizeDocuments(docs: unknown): unknown[];
      recordsListHtml(docs: unknown): string;
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

    CairnSettingsData: {
      phoneAccessCardHtml(options?: { inStandaloneApp?: boolean }): string;
      wirePhoneAccessCard(options?: {
        api?: (path: string, opts?: RequestInit & { headers?: Record<string, string> }) => Promise<unknown>;
        crypto?: Pick<Crypto, "getRandomValues"> | null;
        document?: Document | null;
        navigator?: Pick<Navigator, "clipboard"> | null;
        now?: () => number;
        random?: () => number;
        toast?: (message: string) => unknown;
      }): void;
    };

    CairnMarkdown: {
      mdSafeUrl(url: unknown): string | null;
      mdInline(source: string): string;
      mdToHtml(source: unknown): string;
    };

    CairnPwaInstall: {
      isStandalonePWA(): boolean;
      getInstallGuidance(): { mode: string } | null;
      phoneCoachContent(mode: string): string;
      renderPhoneCoachBanner(container: Element | null | undefined): void;
      refreshPhoneCoach(): void;
    };

    CairnRestTimer: {
      ensureRestBar(): HTMLElement;
      paintRest(): void;
      startRest(seconds?: number): void;
      stopRest(): void;
    };

    CairnProgressComponents: {
      fmtShortDate(iso: unknown): string;
      progressHero(
        title: unknown,
        stats: Array<readonly [unknown, unknown] | readonly [unknown, unknown, { text?: boolean; k?: boolean }] | null | undefined | false>,
      ): string;
      emptyStateHtml(svg: string | null | undefined, line: unknown): string;
    };

    CairnProgressChart: {
      withAlpha(hex: unknown, alpha: number): string;
      drawLineChart(canvas: HTMLCanvasElement | null | undefined, pts: Array<{ date: string; v: number }>, opts?: {
        goal?: number | null;
        fmt?: (value: number) => string;
        peak?: boolean;
      }): void;
      chartColors(): {
        accent: string;
        sage: string;
        gold: string;
        ink: string;
        paper: string;
        card: string;
        line2: string;
        label: string;
      };
    };

    CairnProgressHistory: {
      sessionCardHtml(session: unknown, index: number): string;
      numOrNull(value: unknown): number | null;
    };

    CairnProgressRunPlan: {
      runKindClass(kind: unknown): string;
      runKindLabel(kind: unknown): string;
      weeklyRunPlanCard(plan: unknown): string;
      enduranceGoalCard(goal: unknown): string;
      runComplianceLine(compliance: unknown): string;
      enduranceCoachLine(plan: unknown): string;
    };

    CairnProgressVolume: {
      capWord(input: unknown): string;
      volBalanceHtml(balance: unknown): string;
    };

    CairnProgressEnergy: {
      CONF_WORD: Record<string, string>;
      kcalFmt(value: unknown): string;
      energyRead(exp: unknown): { lead: string; body: string; tone: string; dir?: string | null };
      energyHeroHtml(exp: unknown): string;
      energyCardHtml(exp: unknown): string;
      energyBodyHtml(exp: unknown): { heroHtml: string; cardHtml: string };
      nutritionCheckinLoadingHtml(): string;
      nutritionCheckinOkHtml(result: unknown): string;
      nutritionCheckinFailHtml(): string;
      nutritionCheckinProposalHtml(result: unknown): string;
    };

    CairnProgressCalendar: {
      calMonthHtml(ym: string, byDate: Map<string, unknown>, todayIso: string, idx: number): string;
    };

    CairnProgressMuscleTrajectory: {
      loadMuscleTrajectory(): Promise<void>;
      muscleVerdictTone(verdict: unknown): string;
      muscleVerdictWord(verdict: unknown): string;
      muscleTrendGlyph(trend: unknown): string;
      muscleGroupRowHtml(group: unknown): string;
      muscleTrajectoryHtml(trajectory: unknown): string;
    };

    CairnProgressDexaTargeting: {
      loadDexaTargeting(slotId: string): Promise<void>;
      dexaTargetToneCls(target: unknown): string;
      dexaTargetHtml(target: unknown): string;
      dexaTargetingHtml(targeting: unknown): string;
    };

    CairnProgressPerformance: {
      loadPerformance(): Promise<void>;
      pctClamp(value: unknown): number;
      capacityRowHtml(capacity: unknown, sexWord: unknown): string;
      performanceHtml(performance: unknown, options?: { suppressLever?: boolean }): string;
    };

    CairnProgressProgramAdjustments: {
      PADJ_KIND: Record<string, { glyph: string; cls: string }>;
      loadProgramAdjustments(): Promise<void>;
      programAdjustmentsHtml(rows: unknown): string;
    };

    CairnProgressTestWeek: {
      loadTestWeek(): Promise<void>;
      testWeekBannerHtml(testWeek: unknown): string;
    };

    CairnProgressProgramSummary: {
      liftStatusWord(lift: unknown): string;
      liftTrendFig(lift: unknown): string;
      liftBestFig(lift: unknown): string;
      sortLifts(lifts: unknown): unknown[];
      volBandWord(band: unknown): string;
      volTrendGlyph(trend: unknown): string;
      phaseWord(phase: unknown): string;
      liftRowHtml(lift: unknown, index: number): string;
      volumeBlockHtml(volume: unknown, startIdx: number): string;
      mesoBlockHtml(meso: unknown, index: number): string;
      adaptationsHtml(adaptations: unknown, index: number): string;
    };

    CairnProgressProgramBlock: {
      blockFocusWord(focus: unknown): string;
      activeBlockHtml(block: unknown): string;
      startBlockHtml(): string;
      loadProgramBlock(): Promise<void>;
      wireProgramBlock(slot: Element): void;
    };

    CairnCoachingFocus: {
      CFOCUS_DOMAIN_LABEL: Record<string, string>;
      cfocusDomainTag(domain: unknown): string;
      coachingFocusCardHtml(focus: ClientCoachingFocus | null | undefined): string;
      loadCoachingFocus(slotSelector: string, root?: ParentNode | null): Promise<void>;
      coachingFocusThreadHtml(focus: ClientCoachingFocus | null | undefined): string;
      cfocusRoute(go: unknown): void;
    };

    CairnCardioPlan: {
      isCardioItem(item: unknown): boolean;
      cardioIntervalNote(interval: unknown): string;
      cardioIntervalStructure(interval: unknown, targetZone: unknown): string;
      cardioArtPhrase(item: Record<string, unknown> | null | undefined): string;
      cardioNoteIsDescriptive(note: unknown): boolean;
      cardioSport(item: Record<string, unknown> | null | undefined): string;
      derivedCardioLabel(item: Record<string, unknown> | null | undefined): string;
      cardioLabel(item: Record<string, unknown> | null | undefined): string;
      cardioDescription(item: Record<string, unknown> | null | undefined): string;
      cardioPrescription(item: Record<string, unknown> | null | undefined): string;
    };

    CairnCardioSync: {
      configured(settings: Record<string, unknown> | null | undefined): boolean;
      lineHtml(settings: Record<string, unknown> | null | undefined, opts?: { expectingRun?: unknown }): string;
      wire(root?: ParentNode | null, onDone?: () => unknown): void;
      zoneColors: readonly string[];
    };

    CairnProgressEndurance: {
      enduranceStatusWord(status: unknown): string;
      enduranceBlockHtml(
        end: { status?: unknown; last_week_km?: unknown; longest_km_4wk?: unknown; why?: unknown } | null | undefined,
        idx: number,
      ): string;
      paceTrendWord(trend: unknown): string;
      zoneBarHtml(zones: unknown): string;
      enduranceBestRows(group: unknown): unknown[];
      enduranceSportCardHtml(group: unknown, idx: number): string;
    };

    CairnTodayActivity: {
      ACT_ART_PHRASE: Record<string, string>;
      actArtText(activity: ClientActivity & Record<string, unknown>): string;
      actEntryHtml(activity: ClientActivity & Record<string, unknown>): string;
      updateActEntry(el: Element, row: ClientActivity & Record<string, unknown>): void;
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

    CairnTodayCards: {
      exTimed(item: Record<string, unknown>, logged: unknown, exModes?: Record<string, unknown> | null): boolean;
      exerciseCardHtml(
        item: Record<string, unknown>,
        loggedSets: Array<Record<string, unknown>>,
        prefill: Record<string, unknown>,
        revealIdx: unknown,
        rx: Partial<ClientPrescription> | null | undefined,
        options?: { day?: unknown; exModes?: Record<string, unknown> | null },
      ): string;
      cardioPlanCardHtml(item: Record<string, unknown>, revealIdx: unknown, done: Record<string, unknown> | null | undefined, syncLine: string): string;
      cardioDoneCardHtml(item: Record<string, unknown>, effort: Record<string, unknown>, revealIdx: unknown): string;
      cardioEffortMatches(item: Record<string, unknown>, effort: Record<string, unknown> | null | undefined): boolean;
    };

    CairnTodayLately: {
      garminSessionCard(card: unknown): string;
      when(row: unknown): string;
      detailHtml(detail: unknown): string;
      movementsHtml(movements: unknown): string;
      rowHtml(row: unknown): string;
    };

    CairnTodayBrief: {
      BRIEF_KIND: Record<string, { word: string; glyph: string; lead: string; kicker?: string }>;
      BRIEF_OVERRIDES: Array<{ intent: string; label: string }>;
      kind(read: Partial<ClientDayRead> | null | undefined): string;
      meta(read: Partial<ClientDayRead> | null | undefined): { word: string; glyph: string; lead: string; kicker?: string };
      provisionalRead(): ClientDayRead & { _provisional: boolean };
      redirectHtml(action: unknown, label: unknown, primary?: boolean): string;
      visibleOverrides(args: { kind?: unknown; estMinutes?: unknown; activeOverride?: unknown }): Array<{ intent: string; label: string }>;
      agentOffline(status: unknown): boolean;
      agentOfflineNoticeHtml(status: unknown, dismissed?: boolean): string;
      briefHtml(read: (Partial<ClientDayRead> & { _provisional?: unknown; override?: unknown }) | null | undefined, options?: {
        showPlan?: boolean;
        isToday?: boolean;
        activeOverride?: unknown;
        morph?: boolean;
        reducedMotion?: boolean;
        offlineDismissed?: boolean;
      }): string;
      focusBarHtml(read: Partial<ClientDayRead> | null | undefined, day: { name?: unknown } | null | undefined, options?: { exDone?: unknown; exTotal?: unknown; isToday?: boolean }): string;
      signalsText(read: Partial<ClientDayRead> | null | undefined): string;
    };

    CairnTodaySessionSuggest: {
      SESSION_VIBES: string[];
      itemHtml(item: Partial<ClientSessionSuggestion["items"][number]> | null | undefined, index?: number): string;
      cardHtml(session: Partial<ClientSessionSuggestion> | null | undefined, verified?: unknown): string;
      loadingHtml(): string;
      failureHtml(result?: unknown): string;
      composerHtml(vibes?: readonly string[]): string;
    };

    CairnTodaySessionStatus: {
      FEEL_FACES: readonly string[];
      setChipHtml(set: Record<string, unknown> | null | undefined, index?: number): string;
      setsTonnage(sets: unknown): number;
      sessionDoneCardHtml(session: Record<string, unknown> | null | undefined, day: { name?: unknown } | null | undefined, options?: { isToday?: boolean }): string;
      hasFeedback(session: Record<string, unknown> | null | undefined): boolean;
      feedbackOpenHtml(): string;
      feedbackScaleHtml(kind: "soreness" | "performance", label: string): string;
      feedbackFormHtml(session: Record<string, unknown> | null | undefined): string;
      feedbackDoneHtml(session: Record<string, unknown> | null | undefined): string;
      skipNameHtml(name: unknown): string;
      skipLineHtml(names: unknown): string;
    };

    CairnTodayProgramAdjustments: {
      ADJUST_GLYPH: Record<string, string>;
      COLLAPSE_AFTER: number;
      extraCount(rows: unknown): number;
      planRequest(adjustment: unknown): string;
      rowHtml(adjustment: unknown, index: number): string;
      bannerHtml(rows: unknown): string;
    };
  }

  declare const CairnChatClient: Window["CairnChatClient"];
  declare const CairnExerciseDetail: Window["CairnExerciseDetail"];
  declare const CairnUi: Window["CairnUi"];
  declare const CairnHealthClient: Window["CairnHealthClient"];
  declare const CairnHealthPicture: Window["CairnHealthPicture"];
  declare const CairnHealthMarkers: Window["CairnHealthMarkers"];
  declare const CairnHealthDirectives: Window["CairnHealthDirectives"];
  declare const CairnHealthDirectiveLoader: Window["CairnHealthDirectiveLoader"];
  declare const CairnHealthStanding: Window["CairnHealthStanding"];
  declare const CairnHealthRead: Window["CairnHealthRead"];
  declare const CairnFoodNote: Window["CairnFoodNote"];
  declare const CairnPlanEndurance: Window["CairnPlanEndurance"];
  declare const CairnPlanEditor: Window["CairnPlanEditor"];
  declare const CairnDayFuel: Window["CairnDayFuel"];
  declare const CairnMealPlan: Window["CairnMealPlan"];
  declare const CairnMealRecipe: Window["CairnMealRecipe"];
  declare const CairnProposal: Window["CairnProposal"];
  declare const CairnHealthLearned: Window["CairnHealthLearned"];
  declare const CairnMemory: Window["CairnMemory"];
  declare const CairnFamily: Window["CairnFamily"];
  declare const CairnLife: Window["CairnLife"];
  declare const CairnHealthDocs: Window["CairnHealthDocs"];
  declare const CairnHealthRecords: Window["CairnHealthRecords"];
  declare const CairnSettingsClient: Window["CairnSettingsClient"];
  declare const CairnSettingsData: Window["CairnSettingsData"];
  declare const CairnMarkdown: Window["CairnMarkdown"];
  declare const CairnPwaInstall: Window["CairnPwaInstall"];
  declare const CairnRestTimer: Window["CairnRestTimer"];
  declare const CairnTodayBrief: Window["CairnTodayBrief"];
  declare const CairnTodaySessionSuggest: Window["CairnTodaySessionSuggest"];
  declare const CairnProgressComponents: Window["CairnProgressComponents"];
  declare const CairnProgressChart: Window["CairnProgressChart"];
  declare const CairnProgressHistory: Window["CairnProgressHistory"];
  declare const CairnProgressRunPlan: Window["CairnProgressRunPlan"];
  declare const CairnProgressVolume: Window["CairnProgressVolume"];
  declare const CairnProgressEnergy: Window["CairnProgressEnergy"];
  declare const CairnProgressCalendar: Window["CairnProgressCalendar"];
  declare const CairnProgressMuscleTrajectory: Window["CairnProgressMuscleTrajectory"];
  declare const CairnProgressDexaTargeting: Window["CairnProgressDexaTargeting"];
  declare const CairnProgressPerformance: Window["CairnProgressPerformance"];
  declare const CairnProgressProgramAdjustments: Window["CairnProgressProgramAdjustments"];
  declare const CairnProgressTestWeek: Window["CairnProgressTestWeek"];
  declare const CairnProgressProgramSummary: Window["CairnProgressProgramSummary"];
  declare const CairnProgressProgramBlock: Window["CairnProgressProgramBlock"];
  declare const CairnCoachingFocus: Window["CairnCoachingFocus"];
  declare const CairnCardioPlan: Window["CairnCardioPlan"];
  declare const CairnCardioSync: Window["CairnCardioSync"];
  declare const CairnProgressEndurance: Window["CairnProgressEndurance"];
  declare const CairnTodayActivity: Window["CairnTodayActivity"];
  declare const CairnTodayAgenda: Window["CairnTodayAgenda"];
  declare const CairnTodayTraining: Window["CairnTodayTraining"];
  declare const CairnTodayCards: Window["CairnTodayCards"];
  declare const CairnTodayLately: Window["CairnTodayLately"];
  declare const CairnTodaySessionStatus: Window["CairnTodaySessionStatus"];
  declare const CairnTodayProgramAdjustments: Window["CairnTodayProgramAdjustments"];
}
