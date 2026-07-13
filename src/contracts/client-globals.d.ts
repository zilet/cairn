import type {
  ClientActivity,
  ClientDayRead,
  ClientDirective,
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
  ClientStandSection as ContractClientStandSection,
  ClientTabName as ContractClientTabName,
  ClientPrescription,
  ClientTodayAgenda,
  ClientTodayAgendaCandidate,
  ClientLearnedItem,
  ClientLearnedKind,
  ClientLearnedTimeline,
  ClientMemory,
  ClientMemoryKind,
} from "./client.js";
import type {
  ClientBloodPressureReading,
  ClientCardiovascularRisk,
  ClientEnduranceGoal,
  ClientHealthStanding,
  ClientHealthStandingBloodPressure,
  ClientHealthStandingBodyComp,
  ClientHealthStandingComparison,
  ClientHealthStandingDimension,
  ClientHealthStandingMeasure,
  ClientHealthDocument,
  ClientJourneyMilestone,
  ClientJourneyRead,
  ClientMealPlan,
  ClientPerformanceStanding,
  ClientProgramBlock,
  ClientProgramState,
  ClientRunCompliance,
  ClientSportBests,
  ClientWeekAheadDay,
  ClientWeekAheadDayKind,
  ClientWeeklyRunPlan,
} from "./client-api.js";
import type {
  ClientAppState as ContractClientAppState,
  ClientBriefCache as ContractClientBriefCache,
} from "./client-state.js";

declare global {
  type ClientTabName = ContractClientTabName;
  type ClientPlanSection = ContractClientPlanSection;
  type ClientProgressSection = ContractClientProgressSection;
  type ClientStandSection = ContractClientStandSection;
  type ClientMeSection = ContractClientMeSection;
  type ClientHealthSection = ContractClientHealthSection;
  type ClientSettingsSection = ContractClientSettingsSection;
  type ClientSegment = readonly [string, string];
  type ClientSettingsRouteTask = readonly [string, string];
  type ClientSaveBar = { markDirty(): void; save(): Promise<void> };

  // The vendored elite body figure (public/cairn-body-figure.js -> window.CairnBodyFigure).
  // One authored drawing (viewBox 0 0 260 640, centerline x=130) serves Train muscle
  // balance and the Stand tape figure; male/female share paths via a per-zone x-warp.
  // Reached through file-local guarded accessors (mirroring art()); never user text, so
  // its SVG output is inserted raw.
  type CairnBodyFigureSide = "front" | "back";
  type CairnBodyFigureCallout = { side: "L" | "R"; y: number; pt: [number, number]; site: string; label: string };
  type CairnBodyFigureOpts = {
    sex?: string;
    className?: string;
    anatomyInk?: number;
    pulseDue?: boolean;
    dataAttrs?: boolean;
    stand?: boolean;
  };
  type CairnBodyFigureApi = {
    VIEWBOX: string;
    CENTER_X: number;
    COLORS: Record<string, string>;
    TONES: Record<string, { fill: string; op: number }>;
    CALLOUTS: CairnBodyFigureCallout[];
    GLOWS: Record<string, Array<[number, number, number, number, string]>>;
    ARM_SITES: Set<string>;
    SITES: readonly string[];
    WAIST_OF_HEIGHT: Record<string, number>;
    REF_MULT: Record<string, Record<string, number>>;
    MEAS_LIMITS: Record<string, [number, number]>;
    WIDTH_EXP: Record<string, number>;
    silhouette(sex: string): { torso: string; armR: string; armL: string };
    muscles(sex: string, side: CairnBodyFigureSide): Array<{ group: string; d: string }>;
    detailStrokes(sex: string, side: CairnBodyFigureSide): string[];
    warpPoint(pt: [number, number], sex: string): [number, number];
    waistTrace(sex: string, sign: 1 | -1, guideScale?: number): string;
    figureSvg(side: CairnBodyFigureSide, tones: Record<string, string>, opts?: CairnBodyFigureOpts): string;
    referenceTape(sex: string, heightIn: number): Record<string, number>;
    widthScales(tape: Record<string, number>, ref: Record<string, number>): Record<string, number>;
    measuredSilhouette(sex: string, tape: Partial<Record<string, number | null>> | null, heightIn: number): {
      torso: string; armR: string; armL: string; scales: Record<string, number>; ref: Record<string, number>;
    };
    measuredPoint(pt: [number, number], sex: string, scales: Record<string, number>, clip?: string): [number, number];
    loopD(pts: Array<[number, number]>): string;
    openD(pts: Array<[number, number]>): string;
    mirrorPts(pts: Array<[number, number]>): Array<[number, number]>;
    warp(pts: Array<[number, number]>, sex: string): Array<[number, number]>;
    kOf(y: number): number;
    shrink(pts: Array<[number, number]>, f: number): Array<[number, number]>;
  };

  type ProgressRecord = Record<string, unknown>;
  type ProgressExercise = ProgressRecord & { name: string };
  type ProgressWeightRow = ProgressRecord & { date?: string; weight_lb?: number | null };
  type ProgressChartPoint = { date: string; v: number };
  type ProgressLineChartOptions = {
    goal?: number | null;
    fmt?: (value: number) => string;
    peak?: boolean;
  };
  type ProgressChartPalette = {
    accent: string;
    sage: string;
    gold: string;
    ink: string;
    paper: string;
    card: string;
    line2: string;
    label: string;
  };
  type ProgressLineChartModel = {
    points: ProgressChartPoint[];
    values: number[];
    min: number;
    max: number;
    xs: number[];
    ys: number[];
    slopes: number[];
    padding: { left: number; right: number; top: number; bottom: number };
    peakIndex: number;
    x(index: number): number;
    y(value: number): number;
  };
  type ProgressChartHighlightOptions = {
    hx: number;
    hy: number;
    index: number;
    pop: number;
    withDate: boolean;
    model: ProgressLineChartModel;
    points: ProgressChartPoint[];
    options: ProgressLineChartOptions;
    colors: ProgressChartPalette;
    width: number;
    height: number;
    formatValue(value: number): string;
  };
  type ProgressHistoryRecord = Record<string, unknown>;
  type ProgressHistoryStat = readonly [unknown, unknown] | readonly [unknown, unknown, { text?: boolean; k?: boolean }];
  type ProgressHistorySet = ProgressHistoryRecord & {
    id?: number | string;
    exercise?: unknown;
    mode?: unknown;
    duration_sec?: unknown;
    weight?: unknown;
    reps?: unknown;
    rir?: unknown;
  };
  type HistorySession = ProgressHistoryRecord & {
    id?: unknown;
    date?: unknown;
    title?: unknown;
    day_name?: unknown;
    duration_min?: unknown;
    notes?: unknown;
    sets?: ProgressHistorySet[] | null;
  };
  type ProgressHistoryExerciseGroup = {
    exercise: string;
    sets: ProgressHistorySet[];
    bestIndex: number;
  };
  type ProgressHistoryEditGroup = {
    exercise: string;
    sets: ProgressHistorySet[];
  };
  type ProgressHistorySessionCardModel = {
    row: HistorySession;
    weekday: string;
    groups: ProgressHistoryExerciseGroup[];
    tonnage: number;
    setCount: number;
  };
  type ProgressHistorySummary = {
    monthSessions: number;
    tonnage30: number;
    sets30: number;
    stats: ProgressHistoryStat[];
  };
  type ProgressVolumeGroup = ProgressRecord & { muscle_group?: string; sets?: number | null; tonnage?: number | null };
  type ProgressCalendarCell = ProgressRecord & { date?: string; lifted?: unknown; activity?: unknown };
  type ChatLayoutApi = {
    wireJump(log: HTMLElement | null, jump: HTMLElement | null): void;
    autosizeInput(input: HTMLTextAreaElement | HTMLInputElement | null): void;
    measureTop(): void;
  };

  type ClientMealSwapRecord = Record<string, unknown>;
  type ClientMealSwapPlan = ClientMealPlan & {
    id: number | string;
    parsed?: ClientMealSwapParsed;
  };
  type ClientMealSwapParsed = ClientMealSwapRecord & {
    days?: ClientMealSwapDay[];
  };
  type ClientMealSwapDay = ClientMealSwapRecord & {
    day?: unknown;
    meals?: ClientMealSwapMeal[];
  };
  type ClientMealSwapMeal = ClientMealSwapRecord & {
    name?: unknown;
    meal?: unknown;
    items?: unknown;
    kcal?: unknown;
    protein_g?: unknown;
    carbs_g?: unknown;
    fat_g?: unknown;
    recipe?: unknown;
  };
  type ClientMealSwapData = {
    record(value: unknown): ClientMealSwapRecord;
    rows<T extends ClientMealSwapRecord = ClientMealSwapRecord>(value: unknown): T[];
    plan(value: unknown): ClientMealSwapPlan;
    plans(value: unknown): ClientMealSwapPlan[];
    parsed(value: unknown): ClientMealSwapParsed;
    days(plan: { parsed?: unknown }): ClientMealSwapDay[];
    errorMessage(value: unknown): string | undefined;
    cacheKey(): string;
  };
  type ClientMealRowsContext = { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown };
  type ClientMealRowsPlannerContext = { weekOf: string; targetKcal: number; todayName: string };
  type ClientMealRowsApi = {
    MEAL_HINT_CHIPS: string[];
    record(value: unknown): Record<string, unknown>;
    itemsText(value: unknown): string;
    mealSlotFor(name: unknown, index: unknown): string;
    todayNameFor(now?: unknown): string;
    mealsCtxFor(plan: unknown, now?: unknown): ClientMealRowsPlannerContext;
    mealRowHtml(meal: unknown, mealIndex?: number, options?: { di?: number; count?: number }): string;
    mealDayHtml(day: unknown, dayIndex: number, context: ClientMealRowsContext): string;
  };

  type ClientFamilyControllerDeps = {
    view: HTMLElement;
    state: {
      tab?: string;
      meSeg?: string;
      _famById?: Record<string, unknown>;
      [key: string]: unknown;
    };
    segments: readonly ClientSegment[];
    handlers: Record<string, () => unknown>;
    headerTitle: HTMLElement;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    armDelete(btn: Element, action: () => unknown): void;
    escapeAttr(value: unknown): string;
    invalidatePoll(): void;
    localISO(date?: Date): string;
    segBar(active: string, segments: readonly ClientSegment[]): string;
    toast(message: string): void;
    viewEnter(): void;
    wireSeg(handlers: Record<string, () => unknown>): void;
    withViewTransition(fn: () => unknown): unknown;
    renderLife(): Promise<void>;
  };

  type ClientBriefCache = ContractClientBriefCache;
  type ClientAppState = ContractClientAppState;

  type ClientTodaySessionControllerDeps = {
    root: HTMLElement;
    state: {
      tab?: string;
      logDate: string;
      brief?: unknown;
      planReveal?: { date: string; on: boolean; blank?: boolean } | null;
      pendingOffPlan?: Record<string, Array<{ name: string; mode?: string | null }>>;
    };
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    storeCached(key: string, data: unknown): void;
    invalidate(key: string): void;
    invalidateTodayProgression(): void;
    scheduleRxRefresh(): void;
    renderToday(opts?: Record<string, unknown>): unknown;
    activateTab(tab: string): void;
    withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
    viewEnter(): void;
    reducedMotion(): boolean;
    startRest(): void;
    stopRest(): void;
    toast(message: string, options?: { action?: string; onAction?: () => void }): void;
    parseDur(value: string): number | null;
    fmtDur(seconds: number): string;
    collapseEl(el: Element, done?: () => void): void;
    expandEl(el: Element): void;
    localISO(): string;
    sessionStatus: {
      feedbackDoneHtml(session: Record<string, unknown> | null | undefined): string;
      feedbackFormHtml(session: Record<string, unknown> | null | undefined): string;
      feedbackOpenHtml(): string;
      hasFeedback(session: Record<string, unknown> | null | undefined): boolean;
      setChipHtml(set: Record<string, unknown>, index?: number | null | undefined): string;
      skipLineHtml(names: unknown): string;
      skipNameHtml(name: unknown): string;
    };
  };

  type ClientTodaySessionSurfaceOptions = {
    session: Record<string, unknown>;
    hasLoggedSets: boolean;
    // Per-exercise raw GET /last-set rows (undefined for an already-logged-today
    // exercise, matching loadLastSets' own scoping) — feeds the live "beat this"
    // affirmation wiring alongside each .logrow.
    lastSets?: Record<string, unknown>;
  };

  type ClientHealthStandingPrimitivesApi = {
    hstandDecade(age: unknown): number;
    hstandPct(value: unknown): number | null;
    localDateTimeInputValue(date?: Date): string;
    hstandTone(tone: unknown): string;
    hstandBandTone(percentile: unknown): string;
    hstandMeasureHtml(measure: ClientHealthStandingMeasure | null | undefined): string;
    hstandCompHtml(comparison: ClientHealthStandingComparison, sexWord: string, calendarAge: unknown): string;
    hstandRefSummaryHtml(
      comparisons: ClientHealthStandingComparison[] | null | undefined,
      referenceAge: unknown,
      actualDecade: number | null,
      sexWord: string,
    ): string;
    hstandDimensionHtml(dimension: ClientHealthStandingDimension, index: number): string;
    hstandBpRows(rows: ClientBloodPressureReading[] | null | undefined): string;
    hstandBodyCompHtml(bodyComp: ClientHealthStandingBodyComp | null | undefined): string;
    hstandBpCardHtml(bp: ClientHealthStandingBloodPressure | null | undefined): string;
  };

  type ClientTodaySessionFeedbackDeps = Pick<ClientTodaySessionControllerDeps, "api" | "sessionStatus" | "state" | "toast">;
  type ClientTodaySessionSkipDeps = Pick<ClientTodaySessionControllerDeps, "api" | "collapseEl" | "expandEl" | "invalidate" | "renderToday" | "root" | "sessionStatus" | "state" | "toast">;
  type ClientTodaySessionSetPayloadResult =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; message: string; focus?: () => void };
  type ClientTodaySessionSetModelApi = {
    responseRecord(value: unknown): Record<string, unknown>;
    sessionPathId(session: Record<string, unknown>): string;
    cacheSessionTruth(deps: ClientTodaySessionControllerDeps, value: unknown): void;
    invalidateSessionTruth(deps: ClientTodaySessionControllerDeps): void;
    invalidateSetTruth(deps: ClientTodaySessionControllerDeps): void;
    logPayloadFromRow(row: HTMLElement, deps: ClientTodaySessionControllerDeps): ClientTodaySessionSetPayloadResult;
    lastSetScore(weight: unknown, reps: unknown, durationSec: unknown): number;
    lastSetLineText(lastSet: unknown, deps: { fmtDur(seconds: number): string }): string;
    currentSetScoreFromRow(row: HTMLElement, deps: Pick<ClientTodaySessionControllerDeps, "parseDur">): number | null;
    wireLastSetLine(
      row: Element | null | undefined,
      lastSet: unknown,
      deps: Pick<ClientTodaySessionControllerDeps, "parseDur">,
    ): void;
  };
  type ClientTodaySessionSetActionsApi = {
    wireDeletes(deps: ClientTodaySessionControllerDeps): void;
    wireLogRow(row: Element | null | undefined, deps: ClientTodaySessionControllerDeps): void;
    refreshFinishStat(deps: ClientTodaySessionControllerDeps): boolean;
  };

  type ClientTodayBriefControllerDeps = {
    root: HTMLElement;
    state: Pick<ClientAppState, "tab" | "logDate" | "brief" | "_briefInflight" | "_briefMorph" | "plan" | "planReveal" | "progressSeg"> & {
      day?: number | null;
      dayPicked?: boolean;
    };
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    invalidate(key: string): void;
    renderToday(opts?: Record<string, unknown>): unknown;
    withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
    runOp(kind: "day_read_override", body: Record<string, unknown>, options: ClientAgentOpHandlers): Promise<unknown>;
    runCountUps(root?: ParentNode | null, options?: { snap?: boolean }): void;
    reducedMotion(): boolean;
    collapseEl(el: Element, done?: () => void): void;
    activateTab(tab: string): unknown;
    toast(message: string): void;
    localISO(date?: Date): string;
    escapeHtml(value: unknown): string;
    loadTrainingProvenance(isToday?: boolean): unknown;
    revealPlanThen(after: () => unknown, opts?: { blank?: boolean }): unknown;
    revealSessionComposer(): unknown;
    askForSession(opts?: { minutes?: unknown; focus?: unknown }): unknown;
  };

  type ClientTodayBriefOverrideRunOptions = ClientAgentOpHandlers & {
    path: "/today-read/reshape";
    anchor: ".brief";
    guard: () => boolean;
    isFail: (result: unknown) => boolean;
    render: (result: unknown) => void;
    onFail: (error: unknown) => void;
  };

  type ClientTodayBriefOverrideDeps = {
    root: HTMLElement;
    state: {
      tab?: string;
      logDate: string;
      brief?: unknown;
      _briefMorph?: boolean;
    };
    renderToday(opts?: Record<string, unknown>): unknown;
    withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
    reducedMotion(): boolean;
    escapeHtml(value: unknown): string;
    askForSession(opts?: { minutes?: unknown; focus?: unknown }): unknown;
  };

  type ClientTodayBriefActionsDeps = {
    root: HTMLElement;
    state: {
      tab?: string;
      logDate: string;
      brief?: unknown;
      _briefMorph?: boolean;
      planReveal?: { date: string; on: boolean; blank?: boolean } | null;
      progressSeg?: string;
      dayPicked?: boolean;
    };
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    renderToday(opts?: Record<string, unknown>): unknown;
    withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
    runOp(kind: "day_read_override", body: Record<string, unknown>, options: ClientAgentOpHandlers): Promise<unknown>;
    reducedMotion(): boolean;
    collapseEl(el: Element, done?: () => void): void;
    activateTab(tab: string): unknown;
    escapeHtml(value: unknown): string;
    revealPlanThen(after: () => unknown, opts?: { blank?: boolean }): unknown;
    revealSessionComposer(): unknown;
    askForSession(opts?: { minutes?: unknown; focus?: unknown }): unknown;
  };

  type ClientTodayRailControllerDeps = {
    root: ParentNode;
    state: {
      tab?: string;
      logDate: string;
      planJump?: string | null;
      chatPrefill?: string | null;
      meSeg?: string | null;
      healthSeg?: string | null;
      healthSegPicked?: boolean;
    };
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    activateTab(tab: string): unknown;
    gotoChatWith(text: string): unknown;
    collapseEl(el: Element, done?: () => void): void;
    loadTodayReads(): unknown;
    runCountUps(root?: ParentNode | null, options?: { snap?: boolean }): void;
    escapeHtml(value: unknown): string;
    toast(message: string): void;
    invalidate(key: string): void;
    refreshToday(options: { soft: boolean }): unknown;
  };

  type ClientTodaySideLoaderDeps = {
    root: ParentNode;
    state: ClientAppState & Record<string, unknown>;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    activateTab(tab: string): unknown;
    runCountUps(root?: ParentNode | null, options?: { snap?: boolean }): void;
    escapeHtml(value: unknown): string;
    localISO(date?: Date): string;
    stagger(index?: number | null): string;
  };

  type ClientTodaySideLoaders = {
    garminSessionCard(value: unknown): string;
    loadWearable(isToday: unknown, deps: ClientTodaySideLoaderDeps): Promise<void>;
    loadTableHint(deps: ClientTodaySideLoaderDeps): Promise<void>;
    loadContextBanner(deps: ClientTodaySideLoaderDeps): Promise<void>;
    loadHealthFocusBanner(deps: ClientTodaySideLoaderDeps): Promise<void>;
  };

  type ClientTodayDependenciesPostRenderInput = {
    read: { _provisional?: boolean } | null | undefined;
    isToday: boolean;
    showPlan: boolean;
    soft: boolean;
    conductorLeads: boolean;
    deferRail?: boolean;
    agenda: Partial<ClientTodayAgenda> | null | undefined;
    agendaGeneric: ClientTodayAgendaCandidate[];
    todayCompass: { paceOffer?: { ask?: string | null } | null };
  };

  type ClientTodayDependenciesContextInput = {
    root: HTMLElement;
    state: ClientTodayScreenRuntimeState;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    cachedApi(path: string, options?: CachedApiOptions<unknown>): Promise<unknown>;
    peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
    storeCached(key: string, data: unknown): void;
    invalidate(keyOrPrefix: string): void;
    renderToday(opts?: Record<string, unknown>): unknown;
    withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
    runOp(kind: "day_read_override" | "session_suggest" | string, body: Record<string, unknown>, options: ClientAgentOpHandlers): Promise<unknown>;
    runCountUps(root?: ParentNode | null, options?: { snap?: boolean }): void;
    reducedMotion(): boolean;
    collapseEl(el: Element, done?: () => void): void;
    expandEl(el: Element): void;
    activateTab(tab: string): unknown;
    toast(message: string): void;
    localISO(date?: Date): string;
    escapeHtml(value: unknown): string;
    escapeAttr(value: unknown): string;
    stagger(index?: number | null): string;
    micGlyph: string | (() => string);
    cardioLabel(item: Record<string, unknown> | null | undefined): string;
    cardioPrescription(item: Record<string, unknown> | null | undefined): string;
    isCardioItem(item: unknown): boolean;
    cardioPlanCard(item: any, index: any, matched?: any, syncLine?: string): string;
    cardioEffortMatches(item: any, effort: any): boolean;
    exCard(item: any, logged: any[], prefill: Record<string, unknown>, index: any, rx: any): string;
    garminSessionCard(value: unknown): string;
    sessionDoneCard(session: unknown, day: unknown, options: { isToday: boolean }): string;
    setsTonnage(sets: unknown): number;
    rxMoveCount(rxByEx: Record<string, unknown>): number;
    exRxLineHtml(rx: unknown): string;
    loadTrainingProvenance(isToday?: boolean): unknown;
    revealPlanThen(after: () => unknown, opts?: { blank?: boolean }): unknown;
    revealSessionComposer(): unknown;
    askForSession(opts?: { minutes?: unknown; focus?: unknown; equipment?: unknown; constraints?: unknown }): unknown;
    thinkingCaption(el: Element | null | undefined, op: unknown): () => void;
    appendOffPlanCard(name: any, mode: any): unknown;
    gotoChatWith(text: string): unknown;
    loadTodayReads(): unknown;
    todaySkeleton(): string;
    setTodayHeaderTitle(): void;
    nextPollToken(): number;
    isCurrentPoll(token: number): boolean;
    suggestedPlanDayNumber(session: any, isToday: boolean): Promise<number>;
    updateHeaderCondense(): void;
    quickLog(): unknown;
    wireCardioSync(root: ParentNode, onSync: () => unknown): unknown;
    applyDayProgression(button: Element | null | undefined, day: number | null | undefined): unknown;
    wireBrief(read: { _provisional?: boolean } | null | undefined, options: { isToday: boolean }): unknown;
    upgradeBriefInPlace(date: string, isToday: boolean): unknown;
    loadTableHint(): unknown;
    setupWeightChip(): unknown;
    setupVoiceCapture(): unknown;
    loadFrequentFoods(): unknown;
    loadContextBanner(): unknown;
    loadHealthFocusBanner(): unknown;
    loadWearable(isToday: boolean): unknown;
    loadCheckin(): unknown;
    viewEnter(): void;
    invalidateTodayProgression(): void;
    scheduleRxRefresh(): void;
    startRest(): void;
    stopRest(): void;
    parseDur(value: string): number | null;
    fmtDur(seconds: number): string;
    postExerciseMode(name: string, mode: string): Promise<unknown>;
    wireGuides(card: Element): void;
    wireLogRow(row: Element | null): void;
    wireSkips(): void;
  };

  type ClientTodayDependenciesContext = {
    sideLoaders(): ClientTodaySideLoaderDeps;
    planSurface(): Parameters<Window["CairnTodayPlanSurface"]["sessionHeadHtml"]>[1];
    planSurfaceRenderer(): Parameters<Window["CairnTodayPlanSurfaceRenderer"]["buildHtml"]>[1];
    mainShell(): Parameters<Window["CairnTodayMainShell"]["leadHtml"]>[1];
    brief(): ClientTodayBriefControllerDeps;
    sessionSuggest(): Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[1];
    rail(): ClientTodayRailControllerDeps;
    dataLoad(): Parameters<Window["CairnTodayDataLoader"]["load"]>[1];
    dataRefresh(): Parameters<Window["CairnTodayDataLoader"]["scheduleSoftRepaint"]>[1];
    planSession(session: unknown, isToday: boolean): any;
    postRender(input: ClientTodayDependenciesPostRenderInput): Parameters<Window["CairnTodayPostRenderWiring"]["wirePostRender"]>[0];
    session(): ClientTodaySessionControllerDeps;
    progression(): Parameters<Window["CairnTodayProgressionController"]["scheduleRxRefresh"]>[0];
    addExercise(): Parameters<Window["CairnTodayAddExerciseController"]["setupAddExercise"]>[0];
  };

  type ClientTodayDependenciesApi = {
    context(input: ClientTodayDependenciesContextInput): ClientTodayDependenciesContext;
  };
  type ClientTodayCompatibilityBridgesContext = {
    briefDeps(): ClientTodayBriefControllerDeps;
    sessionDeps(): ClientTodaySessionControllerDeps;
    postExerciseMode(name: string, mode: string): Promise<unknown>;
    reconnectSessionSuggest(job?: unknown): unknown;
    revealSessionComposer(): void;
    askForSession(opts?: Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[0]): Promise<void>;
    sessionDoneCard(session: unknown, day: unknown, options: { isToday: boolean }): string;
    wireLogRow(row: Element | null | undefined): void;
    wireSkips(): void;
    wireBrief(read: { _provisional?: boolean } | null | undefined, options: { isToday: boolean }): void;
    reconnectDayReadOverride(job?: unknown): unknown;
    scheduleRxRefresh(): void;
    invalidateTodayProgression(): void;
    refreshAdaptedRx(): Promise<void>;
    setupAddExercise(): Promise<void>;
    appendOffPlanCard(name: any, mode: any): Promise<void>;
    garminSessionCard(value: unknown): string;
    loadWearable(isToday: unknown): Promise<void>;
    loadTableHint(): Promise<void>;
    loadContextBanner(): Promise<void>;
    loadHealthFocusBanner(): Promise<void>;
  };
  type ClientTodayCompatibilityBridgesApi = {
    create(input: {
      api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
      dependencies(): ClientTodayDependenciesContext;
    }): ClientTodayCompatibilityBridgesContext;
  };
  type ClientTodayScreenRuntimeState = ClientAppState & Record<string, unknown> & {
    day: number | null;
    exModes: Record<string, string>;
    logDate: string;
    planJump?: string;
    planReveal?: { date: string; on: boolean; blank?: boolean };
  };
  type ClientTodayScreenRuntimeContext = ClientTodayCompatibilityBridgesContext & {
    api<Path extends string>(path: Path, opts?: RequestInit & { headers?: Record<string, string> }): Promise<ClientApiResponse<Path>>;
    cachedApi<Path extends string>(path: Path, opts?: CachedApiOptions<ClientApiResponse<Path>>): Promise<ClientApiResponse<Path>>;
    peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
    deps(): ClientTodayDependenciesContext;
    planSurfaceRendererDeps(): ReturnType<ClientTodayDependenciesContext["planSurfaceRenderer"]>;
    mainShellDeps(): ReturnType<ClientTodayDependenciesContext["mainShell"]>;
    exRxLineHtml(rx: Partial<ClientPrescription> | null | undefined): string;
    rxMoveCount(rxByEx: Record<string, Partial<ClientPrescription> | null | undefined>): number;
    applyDayProgression(button: Element | null | undefined, day: number | null | undefined): Promise<void>;
    exerciseCard(item: any, logged: any[], prefill: Record<string, unknown>, index: any, rx: any): string;
    cardioPlanCard(item: any, index: any, matched?: any, syncLine?: string): string;
    cardioEffortMatches(item: any, effort: any): boolean;
    suggestedPlanDayNumber(session: any, isToday: boolean): Promise<number>;
    loadBrief(date: string, override: string, opts?: { fast?: boolean }): Promise<ClientDayRead & { _provisional?: boolean; _failed?: boolean; override?: string | null }>;
    upgradeBriefInPlace(date: string, isToday: boolean): Promise<void>;
    reshapeToday(): Promise<void>;
    briefHtml(
      read: (Partial<ClientDayRead> & { _provisional?: unknown; _failed?: unknown; override?: unknown }) | null | undefined,
      options: { showPlan?: unknown; showDone?: unknown; isToday?: unknown },
    ): string;
    briefSignalsText(read: Partial<ClientDayRead> | null | undefined): string;
    revealPlanThen(after: (() => unknown) | null | undefined, opts?: { blank?: boolean }): void;
  };
  type ClientTodayScreenRuntimeDepsApi = {
    create(input: {
      root: HTMLElement;
      state: ClientTodayScreenRuntimeState;
      api<Path extends string>(path: Path, opts?: RequestInit & { headers?: Record<string, string> }): Promise<ClientApiResponse<Path>>;
      cachedApi<Path extends string>(path: Path, opts?: CachedApiOptions<ClientApiResponse<Path>>): Promise<ClientApiResponse<Path>>;
      peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
      renderToday(): Promise<unknown> | unknown;
      micGlyph(): string;
      bridge(): ClientTodayCompatibilityBridgesContext;
      exRxLineHtml(rx: Partial<ClientPrescription> | null | undefined): string;
      rxMoveCount(rxByEx: Record<string, Partial<ClientPrescription> | null | undefined>): number;
      applyDayProgression(button: Element | null | undefined, day: number | null | undefined): Promise<void>;
      exerciseCard(item: any, logged: any[], prefill: Record<string, unknown>, index: any, rx: any): string;
      cardioPlanCard(item: any, index: any, matched?: any, syncLine?: string): string;
      cardioEffortMatches(item: any, effort: any): boolean;
      suggestedPlanDayNumber(session: any, isToday: boolean): Promise<number>;
      upgradeBriefInPlace(date: string, isToday: boolean): Promise<void>;
      revealPlanThen(after: (() => unknown) | null | undefined, opts?: { blank?: boolean }): void;
      postExerciseMode(name: string, mode: string): Promise<unknown>;
    }): ClientTodayDependenciesContext;
  };
  type ClientTodayScreenRuntimeApi = {
    micGlyph(): string;
    create(input: {
      state: ClientTodayScreenRuntimeState;
      root: HTMLElement;
      renderToday(): Promise<unknown> | unknown;
    }): ClientTodayScreenRuntimeContext;
  };

  type ClientTodayPlanSelectionDay = {
    id?: number | string | null;
    day_number: number;
    items?: Array<{ exercise?: string | null }> | null;
  };

  type ClientTodayPlanSelectionSession = {
    date?: string | null;
    plan_day_id?: number | string | null;
    sets?: Array<{ exercise?: string | null }> | null;
  };

  type ClientTodayPlanSelectionDeps = {
    state: {
      logDate: string;
      plan: ClientTodayPlanSelectionDay[];
    };
    api(path: string): Promise<unknown>;
    cachedApi?(path: string, options?: { key?: string; freshFor?: number }): Promise<unknown>;
  };

  type ClientHealthPictureCache = { review?: Record<string, unknown> | null; docCount?: number; newestDocAt?: string | null };

  type ClientSettingsDataControllerDeps = {
    root: ParentNode;
    workingModel: { update_check_enabled: boolean };
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    markDirty(): void;
    updateCardHtml(status: unknown): string;
    withToken(path: string): string;
    downloadFile(path: string): void;
    reload(): void;
    inStandaloneApp?: boolean;
  };

  type ClientSettingsSourcesAutomationControllerDeps = {
    root: HTMLElement;
    workingModel: Pick<
      SettingsScreenWorkingModel,
      | "garmin_username"
      | "garmin_password"
      | "enrich_enabled"
      | "art_enabled"
      | "research_enabled"
      | "gemini_api_key"
      | "lead_mode"
    >;
    settings: Record<string, unknown>;
    data: SettingsScreenData;
    artSpendHtml: string;
    garminStatusLine(settings: unknown, syncing: boolean): string;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    authToken?: () => string;
    locationOrigin?: string;
    clipboard?: Pick<Clipboard, "writeText"> | null;
    setTimeout?: typeof setTimeout;
  };

  type ClientSettingsAgentsControllerWorkingModel = {
    agent_strategy: string;
    order: string[];
    disabled: Set<string>;
    routes: Record<string, string>;
    coach_day: number;
    coach_hour: number;
    time_zone: string;
  };

  type ClientSettingsAgentsControllerAgent = Record<string, unknown> & { name: string };

  type ClientSettingsAgentsControllerInfo = {
    version: unknown;
    model_current: unknown;
    update_available: boolean;
  };

  type ClientSettingsAgentsControllerDeps = {
    root: HTMLElement;
    workingModel: ClientSettingsAgentsControllerWorkingModel;
    meta: Record<string, ClientSettingsAgentsControllerAgent | undefined>;
    routeTasks: readonly ClientSettingsRouteTask[];
    agentInfo: Record<string, ClientSettingsAgentsControllerInfo | undefined>;
    agentModels: Record<string, unknown[] | undefined>;
    agentHealthHtml: string;
    agentActivityHtml: string;
    noticedHtml: string;
    dayNames: string[];
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    sleep(ms: number): Promise<void>;
    stagger?(index: number): string;
    markDirty(): void;
    pruneRoutes?(
      routes: Record<string, string>,
      routeTasks: readonly ClientSettingsRouteTask[],
      enabledAgents: readonly ClientSettingsAgentsControllerAgent[],
    ): Record<string, string>;
    routeRowsHtml?(
      routeTasks: readonly ClientSettingsRouteTask[],
      enabledAgents: readonly ClientSettingsAgentsControllerAgent[],
      routes: Record<string, string>,
    ): string;
    openAgentLoginModal?(): ((agentName: string) => unknown) | undefined;
  };

  type ClientProgressEnduranceControllerDeps = {
    view: HTMLElement;
    headerTitle: HTMLElement;
    state: Pick<ClientAppState, "tab" | "progressSeg">;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    nextToken(): number;
    isCurrent(token: number): boolean;
    segmentHtml(active: ClientProgressSection): string;
    wireSegments(): void;
    loading(message: string): string;
    empty(image: string, message: string): string;
    hero(title: string, stats: Array<readonly [unknown, unknown] | readonly [unknown, unknown, { text?: boolean; k?: boolean }]>): string;
    art(kind: string, label: string): string;
    runCountUps(root: ParentNode): void;
    renderSelf(): unknown;
  };

  type ClientProgressProgramControllerDeps = {
    view: HTMLElement;
    headerTitle: HTMLElement;
    state: Pick<ClientAppState, "tab" | "progressSeg">;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    runOp(kind: string, body: Record<string, unknown>, options?: ClientAgentOpHandlers): Promise<unknown>;
    nextToken(): number;
    isCurrent(token: number): boolean;
    peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
    paintSWR<Path extends string>(
      options?: PaintSwrOptions<ClientApiResponse<Path>> & { path?: Path },
    ): Promise<ClientApiResponse<Path> | undefined>;
    segmentHtml(active: ClientProgressSection): string;
    skeletonHtml(active: ClientProgressSection, cards?: number): string;
    wireSegments(): void;
    hero(title: string, stats: Array<readonly [unknown, unknown] | readonly [unknown, unknown, { text?: boolean; k?: boolean }]>): string;
    empty(image: string, message: string): string;
    art(kind: string, label: string): string;
    busy(btn: Element | null | undefined, text: string, options?: { ghost?: boolean }): () => void;
    toast(message: string): void;
    invalidate(keyOrPrefix: string): void;
    runCountUps(root: ParentNode): void;
    renderSelf(): unknown;
  };

  type ClientProgressRouteDeps = {
    endurance(renderSelf: () => unknown): ClientProgressEnduranceControllerDeps;
    program(renderSelf: () => unknown): ClientProgressProgramControllerDeps;
  };

  type ClientProgressJourneyApi = {
    hasRead(read: ClientJourneyRead | null | undefined, milestones?: unknown): boolean;
    journeyCardHtml(
      read: ClientJourneyRead | null | undefined,
      milestones: ClientJourneyMilestone[] | unknown,
      deps?: { stagger?(index?: number | null): string },
    ): string;
    wire(root?: ParentNode): void;
  };

  type ClientHealthPictureControllerDeps = {
    root: ParentNode;
    state: Pick<ClientAppState, "healthReview">;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    runOp(kind: string, body: Record<string, unknown>, options?: ClientAgentOpHandlers): Promise<unknown>;
    toast(message: string): void;
    switchHealthSeg(seg: ClientHealthSection, opts?: { openPicker?: boolean }): void;
    onHealthReadView(): boolean;
    pollToken(): number;
    escapeHtml(value: unknown): string;
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
  };

  type ClientHealthReadControllerDeps = {
    root: ParentNode;
    state: Pick<ClientAppState, "tab" | "meSeg" | "healthSeg" | "pendingHealthScroll">;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    cachedApi(path: string, options?: CachedApiOptions<unknown>): Promise<unknown>;
    peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
    markRefreshing(on: unknown): void;
    swrInvalidate(keyOrPrefix: string): void;
    runOp(kind: string, body: Record<string, unknown>, options?: ClientAgentOpHandlers): Promise<unknown>;
    toast(message: string): void;
    pollToken(): number;
    select<T extends Element = Element>(selector: string): T | null;
    escapeAttr(value: unknown): string;
    escapeHtml(value: unknown): string;
    relTime(iso: string): string;
    stagger(index?: number | null): string;
    reducedMotion(): boolean;
    switchHealthSeg(seg: ClientHealthSection): void;
    isHealthReviewRunning(): boolean;
    loadHealthPicture(token: number, docsPromise: Promise<unknown>): Promise<void>;
    paintHealthPicture(): void;
    setReadSpy(spy: IntersectionObserver): void;
    teardownReadSpy(): void;
  };

  type ClientHealthMarkersControllerDeps = {
    root: ParentNode;
    cachedApi(path: string, options?: CachedApiOptions<unknown>): Promise<unknown>;
    peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
    markRefreshing(on: unknown): void;
    pollToken(): number;
    relAge(iso: string | null | undefined): string;
    select<T extends Element = Element>(selector: string): T | null;
    stagger(index?: number | null): string;
    switchHealthSeg(seg: ClientHealthSection, opts?: { openPicker?: boolean }): void;
    escapeHtml(value: unknown): string;
  };

  type ClientHealthShareControllerDeps = {
    root: ParentNode;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    cachedApi(path: string, options?: CachedApiOptions<unknown>): Promise<unknown>;
    peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
    swrInvalidate(keyOrPrefix: string): void;
    toast(message: string): void;
    btnBusy(btn: Element | null | undefined, label?: unknown, options?: { ghost?: boolean }): () => void;
    downloadFile(href: string): void;
    select<T extends Element = Element>(selector: string): T | null;
    stagger(index?: number | null): string;
    switchHealthSeg(seg: ClientHealthSection, opts?: { openPicker?: boolean }): void;
    withToken(url: string): string;
  };

  type ClientHealthStandingControllerDeps = {
    root: ParentNode;
    document: Document;
    state: Pick<ClientAppState, "healthStandingRef" | "standSeg" | "pendingHealthScroll" | "meSeg">;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    swrInvalidate(keyOrPrefix: string): void;
    toast(message: string): void;
    activateTab(tab: string): unknown;
    pollToken(): number;
    select<T extends Element = Element>(selector: string): T | null;
    escapeAttr(value: unknown): string;
    loadDexaTargeting?(slotId: string): Promise<void> | void;
  };

  type ClientHealthRiskControllerDeps = {
    root: ParentNode;
    state: Pick<ClientAppState, "meSeg">;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    activateTab(tab: string): unknown;
    pollToken(): number;
    select<T extends Element = Element>(selector: string): T | null;
    // When present, the "sharpen this read" nudge calls this instead of jumping to
    // Me → Profile — used by Stand → Age to scroll to the in-place clinical inputs.
    onSharpen?(): void;
  };

  type ClientHealthRecordsControllerDeps = {
    state: Pick<ClientAppState, "tab" | "standSeg" | "pendingHealthDocId">;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    armDelete(btn: Element, onConfirm: () => unknown, options?: { label?: string }): void;
    pollEnrichment(
      path: string,
      id: number,
      options?: {
        tab?: string;
        token?: unknown;
        tries?: number;
        interval?: number;
        onUpdate?: (row: Record<string, unknown>) => void;
      },
    ): unknown;
    enrichmentActive(status: unknown): boolean;
    pollToken(): number;
    loadHealthMarkers(token: number): void;
    paintHealthPicture(): void;
    getHealthPictureCache(): ClientHealthPictureCache | null;
    setHealthPictureCache(cache: ClientHealthPictureCache | null): ClientHealthPictureCache | null;
  };

  type ClientHealthDocUploadControllerDeps = {
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    enrichmentActive(status: unknown): boolean;
    pollDoc(id: string | number): void;
    wireDoc(el: HTMLElement | null): void;
    getHealthPictureCache(): ClientHealthPictureCache | null;
    setHealthPictureCache(cache: ClientHealthPictureCache | null): ClientHealthPictureCache | null;
    paintHealthPicture(): void;
  };

  type ClientHealthDocActionsControllerDeps = {
    state: {
      tab?: string;
      standSeg?: string | null;
    };
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    armDelete(btn: Element, onConfirm: () => unknown, options?: { label?: string }): void;
    pollEnrichment(
      path: string,
      id: number,
      options?: {
        tab?: string;
        token?: unknown;
        tries?: number;
        interval?: number;
        onUpdate?: (row: Record<string, unknown>) => void;
      },
    ): unknown;
    pollToken(): number;
    loadHealthMarkers(token: number): void;
    paintHealthPicture(): void;
    loadHealthDocs(): Promise<ClientHealthDocument[]>;
    wireHealthDoc(el: HTMLElement | null): void;
    getHealthPictureCache(): ClientHealthPictureCache | null;
    setHealthPictureCache(cache: ClientHealthPictureCache | null): ClientHealthPictureCache | null;
  };

  type ClientMeMemoryControllerDeps = {
    view: HTMLElement;
    state: Pick<ClientAppState, "tab" | "meSeg">;
    segments: readonly ClientSegment[];
    handlers: Record<string, () => unknown>;
    headerTitle: HTMLElement;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    armDelete(btn: Element, onConfirm: () => unknown, options?: { label?: string }): void;
    escapeAttr(value: unknown): string;
    invalidatePoll(): void;
    segBar(active: string, items: readonly ClientSegment[]): string;
    toast(message: string): void;
    wireSeg(handlers: Record<string, () => unknown>): void;
  };

  type ClientMeHealthTabsControllerDeps = {
    root: HTMLElement;
    state: Pick<ClientAppState, "tab" | "meSeg" | "healthSeg" | "healthSegPicked">;
    segments: readonly ClientSegment[];
    handlers: Record<string, () => unknown>;
    headerTitle: HTMLElement;
    segBar(active: string, items: readonly ClientSegment[]): string;
    wireSeg(handlers: Record<string, () => unknown>): void;
    fitSeg(el: HTMLElement): void;
    syncRouteFromState?(): void;
    withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
    select<T extends Element = Element>(selector: string): T | null;
    healthDocsKnownEmpty(): boolean;
    invalidatePoll(): void;
    paintRead(): void;
    paintMarkers(): void;
    paintRecords(): void;
    paintShare(): void;
    paintLearned(): void;
  };

  type ClientLifeControllerForm = {
    kind: string;
    title: string | null;
    detail: string | null;
    start_date: string | null;
    end_date: string | null;
    meta: Record<string, unknown>;
  };

  type ClientLifeControllerDeps = {
    view: HTMLElement;
    state: Pick<ClientAppState, "tab" | "meSeg" | "_lifeById">;
    segments: readonly ClientSegment[];
    handlers: Record<string, () => unknown>;
    headerTitle: HTMLElement;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    armDelete(btn: Element, onConfirm: () => unknown, options?: { label?: string }): void;
    escapeAttr(value: unknown): string;
    invalidatePoll(): void;
    segBar(active: string, items: readonly ClientSegment[]): string;
    toast(message: string): void;
    wireSeg(handlers: Record<string, () => unknown>): void;
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
    // Prose-bearing ops stream their reading into the anchor card: `stream: true` uses
    // the built-in painter; a custom `onDelta` takes full control of the live chunk.
    stream?: boolean;
    onDelta?: (delta: string, accumulated: string, host: Element | null) => unknown;
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
        standSections: ReadonlyArray<string | readonly [string, unknown]>;
        meSections: ReadonlyArray<string | readonly [string, unknown]>;
        healthSections: ReadonlyArray<string | readonly [string, unknown]>;
        settingsSections: ReadonlyArray<string | readonly [string, unknown]>;
      },
    ): ClientTabName;
    currentRouteState(options: {
      state: ClientAppState;
      planSections: ReadonlyArray<string | readonly [string, unknown]>;
      progressSections: ReadonlyArray<string | readonly [string, unknown]>;
      standSections: ReadonlyArray<string | readonly [string, unknown]>;
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
  declare var MEALS_SETTINGS_KEY: string;
  declare const MEAL_LABEL: Record<string, string>;

  declare function skelSwap(fn: () => void): void;
  declare function escHtml(value: unknown): string;
  declare function escAttr(value: unknown): string;
  declare function relTime(iso: string): string;
  declare function relAge(iso: string): string;
  declare function absDate(iso: string): string;
  declare function humanDate(iso: string): string;
  declare function humanizeReviewText(text: string, latestISO: string | null | undefined): string;
  declare function latestReviewDate(parsed: unknown): string | null;
  declare function learnedTimelineHtml(data: ClientLearnedTimeline | null | undefined): string;
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
    opts?: RequestInit & { headers?: Record<string, string>; acceptErrorBody?: boolean },
  ): Promise<ClientApiResponse<Path>>;
  declare function setOffline(on: unknown): void;

  // Offline outbox — a durable localStorage queue that replays failed capture /
  // set-log POSTs when Cairn is reachable again (see api-client.ts).
  type ClientOutboxItem = { id: string; ts: number; kind: string; path: string; body: unknown };
  type ClientOutboxController = {
    enqueue(entry: { kind: string; path: string; body: unknown }): ClientOutboxItem;
    list(): ClientOutboxItem[];
    count(): number;
    remove(id: string): void;
    clear(): void;
    drain(send: (item: ClientOutboxItem) => Promise<unknown>): Promise<{ sent: number; remaining: number }>;
  };
  type ClientOutboxApi = {
    createOutbox(opts: {
      storage: Pick<Storage, "getItem" | "setItem">;
      now?: () => number;
      key?: string;
      max?: number;
    }): ClientOutboxController;
    enqueue(kind: string, path: string, body: unknown): ClientOutboxItem;
    flush(): Promise<void>;
    count(): number;
    renderBar(): void;
  };
  declare const CairnOutbox: ClientOutboxApi;
  declare function outboxEnqueue(kind: string, path: string, body: unknown): ClientOutboxItem;
  declare function flushOutbox(): Promise<void>;
  declare function outboxCount(): number;

  // api() in-flight dedupe + micro-TTL cache — the pure core exposed for tests
  // (see api-client.ts).
  type ClientApiCoalescer = {
    isMicroCachePath(path: string): boolean;
    peekFresh<T = unknown>(path: string): T | undefined;
    store<T = unknown>(path: string, data: T): void;
    invalidateAll(): void;
    share<T>(path: string, start: () => Promise<T>): Promise<T>;
    inFlightCount(): number;
    cacheSize(): number;
  };
  type ClientApiCacheApi = {
    createApiCoalescer(opts?: { now?: () => number; ttlMs?: number; ttlPaths?: readonly string[] }): ClientApiCoalescer;
    shouldBypassApiCache(opts: RequestInit & { headers?: Record<string, string> }): boolean;
    shouldArmGetTimeout(method: string, opts: RequestInit & { headers?: Record<string, string> }): boolean;
    MICRO_TTL_MS: number;
    MICRO_CACHE_PATHS: readonly string[];
    GET_TIMEOUT_MS: number;
  };
  declare const CairnApiCache: ClientApiCacheApi;

  type SwrPeek<T> = { data: T; fresh: boolean };
  type SwrUpgradeMeta = { changed: boolean };
  type CachedApiOptions<T> = { key?: string; freshFor?: number; onUpgrade?: (data: T, meta: SwrUpgradeMeta) => void };
  type OptimisticMutationOptions<T, R = unknown> = {
    key: string;
    apply: (current: T | null) => T;
    request: () => Promise<R>;
    commit?: (current: T, result: R) => T | null | undefined;
    fallback?: (error: unknown, optimistic: T, previous: T | null) => unknown;
    rollback?: T;
    onChange?: (data: T, meta: { phase: "optimistic" | "commit" | "rollback" }) => void;
  };
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
  declare function swrSet<T = unknown>(key: string, data: T): void;
  declare function optimisticMutation<T = unknown, R = unknown>(options: OptimisticMutationOptions<T, R>): Promise<R | undefined>;
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
  declare function stagger(index?: number | null): string;
  declare function reducedMotion(): boolean;
  declare function loadingState(label: unknown): string;
  declare function countUp(
    element: Element | null | undefined,
    target: unknown,
    options?: { dur?: number; fmt?: (value: number) => string },
  ): void;
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
  declare function fmtK(value: unknown): string;
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
  declare function weeklyRunPlanCard(plan: ClientWeeklyRunPlan | null | undefined): string;
  declare function enduranceGoalCard(goal: ClientEnduranceGoal | null | undefined): string;
  declare function runComplianceLine(compliance: ClientRunCompliance | null | undefined): string;
  declare function enduranceCoachLine(plan: ClientWeeklyRunPlan | null | undefined): string;
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
  declare function capacityRowHtml(capacity: ClientPerformanceStanding["capacities"][number], sexWord: string): string;
  declare function performanceHtml(performance: ClientPerformanceStanding | null | undefined, options?: { suppressLever?: boolean }): string;
  declare const PADJ_KIND: Record<string, { glyph: string; cls: string }>;
  declare function loadProgramAdjustments(): Promise<void>;
  declare function programAdjustmentsHtml(rows: unknown): string;
  declare function loadTestWeek(): Promise<void>;
  declare function testWeekBannerHtml(testWeek: unknown): string;
  declare function liftStatusWord(lift: ClientProgramState["lifts"][number] | null | undefined): string;
  declare function liftTrendFig(lift: ClientProgramState["lifts"][number] | null | undefined): string;
  declare function liftBestFig(lift: ClientProgramState["lifts"][number] | null | undefined): string;
  declare function sortLifts(lifts: ClientProgramState["lifts"] | null | undefined): ClientProgramState["lifts"];
  declare function volBandWord(band: unknown): string;
  declare function volTrendGlyph(trend: unknown): string;
  declare function phaseWord(phase: unknown): string;
  declare function liftRowHtml(lift: ClientProgramState["lifts"][number] | null | undefined, index: number): string;
  declare function volumeBlockHtml(volume: ClientProgramState["volume"] | null | undefined, startIdx: number): string;
  declare function mesoBlockHtml(meso: ClientProgramState["mesocycle"] | null | undefined, index: number): string;
  declare function adaptationsHtml(adaptations: string[] | null | undefined, index: number): string;
  declare function blockFocusWord(focus: unknown): string;
  declare function activeBlockHtml(block: ClientProgramBlock | null | undefined): string;
  declare function startBlockHtml(): string;
  declare function loadProgramBlock(): Promise<void>;
  declare function wireProgramBlock(slot: Element): void;
  declare function cfocusDomainTag(domain: unknown): string;
  declare function coachingFocusCardHtml(
    focus: ClientCoachingFocus | null | undefined,
    options?: { blockLine?: boolean; actions?: boolean }
  ): string;
  declare function coachingFocusCompactHtml(focus: ClientCoachingFocus | null | undefined): string;
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
  declare function enduranceBlockHtml(end: ClientProgramState["endurance"], idx: number): string;
  declare function paceTrendWord(trend: unknown): string;
  declare function zoneBarHtml(zones: unknown): string;
  declare function enduranceBestRows(group: ClientSportBests | null | undefined): Array<{ label: string; val: string; date: string; type: string }>;
  declare function enduranceSportCardHtml(group: ClientSportBests | null | undefined, idx: number): string;
  declare function hybridLoadCardHtml(hybrid: ClientProgramState["hybrid"], idx?: number): string;
  declare const HR_ZONE_COLORS: string[] | undefined;
  declare function reshapeToday(): Promise<void>;
  declare function setDiscipline(discipline: unknown): string;
  declare function setEnduranceGoalSet(present: unknown): boolean;
  declare function defaultProgressSeg(): string;
  declare function renderTab(tab: string): unknown;
  declare function renderToday(): unknown;
  declare function renderSession(opts?: Record<string, unknown>): unknown;
  declare function openSession(date?: string | null): void;
  declare function renderFoodJournal(): unknown;
  declare function renderMeals(): unknown;
  declare function renderCoach(): unknown;
  declare function rerenderFoodSurface(): void;
  declare function loadTrainingProvenance(isToday?: boolean): unknown;
  declare function loadMealProvenance(): unknown;
  declare function paintEnergyBody(exp: unknown): void;
  declare function applyProposalById(id: string | number | undefined, btn?: Element | null): Promise<unknown>;
  declare function renderPlanEndurance(): unknown;
  declare function paintPlanEndurance(
    goalValue: ClientEnduranceGoal | null,
    compliance: ClientRunCompliance | null,
    plan: unknown,
    settings: Record<string, unknown> | null,
  ): void;
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
  declare function loadPlanUpcomingNote(token: number, slotSel?: string): void;
  declare function renderHistory(): unknown;
  declare function renderProgress(): unknown;
  declare function renderWeight(): unknown;
  declare function renderMeasurements(): unknown;
  declare function renderBodyMetrics(mount: HTMLElement | null): void;
  declare const CairnStand: { renderStand(): Promise<void> };
  declare function renderStand(): Promise<void>;
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
  declare function getHealthPictureCache(): { review?: Record<string, unknown> | null; docCount?: number; newestDocAt?: string | null } | null;
  declare function setHealthPictureCache(
    cache: { review?: Record<string, unknown> | null; docCount?: number; newestDocAt?: string | null } | null,
  ): { review?: Record<string, unknown> | null; docCount?: number; newestDocAt?: string | null } | null;
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
  declare function thinkingCaption(el: Element | null | undefined, op?: unknown): () => void;
  declare function btnBusy(btn: Element | null | undefined, text?: unknown, options?: { ghost?: boolean }): () => void;
  declare function openDetailFrom(fromEl: Element | null | undefined, build: () => unknown): void;
  declare function mountDetail(html: string, photoSrc?: string | null): HTMLElement;
  declare function wireDetailCommon(): void;
  declare function wireArtZoom(artEl: Element | null | undefined): void;
  declare function wireGuides(scope?: ParentNode | null): void;
  declare function exerciseExplanation(exercise: { name?: unknown; muscle_group?: unknown } | null | undefined): {
    setup?: unknown;
    move?: unknown;
    feel?: unknown;
    avoid?: unknown;
  };
  declare function exerciseExplanationHtml(
    exercise: { name?: unknown; muscle_group?: unknown } | null | undefined,
    explanation?: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null,
  ): string;
  declare function replaceExerciseExplanation(
    el: ParentNode,
    exercise: { name?: unknown; muscle_group?: unknown } & Record<string, unknown>,
    explanation?: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null,
  ): void;
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
    path: "/activities" | "/food-notes" | "/health-docs" | string,
    id: number,
    options?: {
      tab?: string;
      token?: unknown;
      tries?: number;
      interval?: number;
      onUpdate?: (row: ClientActivity & Record<string, unknown>) => void;
    },
  ): Promise<(ClientActivity & Record<string, unknown>) | null>;
  declare function enrichmentActive(status: unknown): boolean;
  declare function healthKindLabel(kind: unknown): string;
  declare function parsedDoc(doc: unknown): { markers?: Array<Record<string, unknown>>; clinical_facts?: unknown[]; type?: unknown } | null;
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
  declare function expandEl(el: Element): void;
  declare function registerJobReconnector(kind: string, factory: (job?: unknown) => unknown): void;
  declare function registerAppJobReconnectors(): void;
  declare function installMobileViewportGuards(): void;
  declare function installDayRolloverWatcher(): void;
  declare function dayRolloverTarget(current: string, measured: string, dayPicked: boolean): string | null;
  declare function reconnectSessionSuggest(job?: unknown): unknown;
  declare function reconnectMealPlan(job?: unknown): unknown;
  declare function reconnectMealSwap(job?: unknown): unknown;
  declare function reconnectRecipe(job?: unknown): unknown;
  declare function reconnectDayReadOverride(job?: unknown): unknown;
  declare function reconnectNutritionCheckin(job?: unknown): unknown;
  declare function reconnectInsight(job?: unknown): unknown;
  declare function reconnectProposal(job?: unknown): unknown;
  declare function reconnectHealthReview(job?: unknown): ClientAgentOpHandlers | null;
  declare function registerServiceWorkerLifecycle(): void;
  declare function primeDiscipline(): void;
  declare function maybeOnboard(): Promise<void>;
  declare function openOnboarding(): void;
  declare function primeArtManifest(): Promise<void>;
  declare function jobReconnect(): Promise<void>;
  declare function startAppShell(): void;

  type ChatComposerControllerMessage = Partial<ClientChatMessage> &
    Record<string, unknown> & {
      pending?: boolean;
      meta?: unknown;
    };
  type ChatComposerControllerHandle = {
    send(): Promise<void>;
    clearAttachment(): void;
  };
  type ChatComposerControllerDeps = {
    token: number;
    state: Pick<ClientAppState, "tab" | "chatPrefill">;
    input: HTMLTextAreaElement;
    sendBtn: HTMLButtonElement;
    fileInput: HTMLInputElement;
    attachBtn: HTMLButtonElement;
    preview: HTMLElement;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    appendMsg(message: Partial<ChatComposerControllerMessage>): HTMLElement | null;
    rememberFuelContext(...messages: Array<Partial<ChatComposerControllerMessage> | null | undefined>): ChatComposerControllerMessage[];
    loadFuel(token: number, messages?: Partial<ChatComposerControllerMessage>[]): Promise<void>;
    saveDraft(value: string): void;
    loadDraft(): string;
    autosizeInput(input: HTMLTextAreaElement | HTMLInputElement): void;
    measure(): void;
    spawnPendingBubble(turnValue: unknown): Element | null;
    ensureMonitor(): void;
  };

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
    installDayRolloverWatcher(): void;
    registerServiceWorkerLifecycle(): void;
    primeDiscipline(): void;
    maybeOnboard(): Promise<void>;
    openOnboarding(): void;
    startAppShell(): void;
    CairnAppRouter: ClientAppRouterApi;
    CairnOutbox: ClientOutboxApi;
    outboxEnqueue(kind: string, path: string, body: unknown): ClientOutboxItem;
    flushOutbox(): Promise<void>;
    outboxCount(): number;
    CairnApiCache: ClientApiCacheApi;

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

    CairnChatHeaderController: {
      ensureChatHeaderBtns(deps: ChatHeaderControllerDeps): ChatScreenHeaderButtons;
      chatFreshStart(deps: ChatHeaderControllerDeps): Promise<void>;
      settleFreshPill(distilled: unknown, token: number, deps: ChatHeaderControllerDeps): void;
    };

    CairnChatAttachment: {
      compressImage(file: File): Promise<{ dataUrl: string; base64: string; mime: "image/jpeg"; bytes: number }>;
      previewImage(value: Element | null | undefined): HTMLImageElement | null;
      resetFocusAfterNativePicker(options: {
        input: HTMLTextAreaElement;
        fileInput: HTMLInputElement;
        isSoftKeyboard(): boolean;
      }): void;
      settleAfterNativePicker(options: {
        isActive(): boolean;
        measure(): void;
        graceMs?: number;
      }): void;
    };

    CairnChatComposerFocus: {
      focusInput(input: HTMLTextAreaElement | HTMLInputElement): void;
      releaseStaleInputFocus(options: {
        input: HTMLTextAreaElement | HTMLInputElement;
        isSoftKeyboard(): boolean;
        isKeyboardGeometryOpen(): boolean;
        measure(): void;
      }): void;
      recoverInputFocusFromTap(options: {
        input: HTMLTextAreaElement | HTMLInputElement;
        isActive(): boolean;
        isSoftKeyboard(): boolean;
        measure(): void;
      }): void;
      settleViewport(options: {
        isActive(): boolean;
        measure(): void;
      }): void;
      wireFocus(options: {
        input: HTMLTextAreaElement | HTMLInputElement;
        isActive(): boolean;
        isSoftKeyboard(): boolean;
        isKeyboardGeometryOpen(): boolean;
        measure(): void;
      }): {
        releaseStaleInputFocus(): void;
        recoverInputFocusFromTap(): void;
        settleViewport(): void;
      };
    };

    CairnChatComposerController: {
      wire(deps: ChatComposerControllerDeps): ChatComposerControllerHandle;
      clearPasteHandler(): void;
    };

    CairnChatLayout: ChatLayoutApi;

    CairnChatTurnRecords: {
      event(event: Event): Record<string, unknown> | null;
      id(value: unknown): number | null;
      loadDraft(): string;
      phaseCaption(turn: (Record<string, unknown> & {
        status?: string;
        phase?: string | null;
        image_url?: string | null;
      }) | null | undefined): string;
      record(value: unknown): Record<string, unknown>;
      rows(value: unknown): Array<Record<string, unknown> & { id: number }>;
      saveDraft(value: string): void;
    };

    CairnChatTurnStreamState: {
      create(deps: {
        getBubble(id: number): HTMLElement | null;
        ensureStreamingBubble(id: number): HTMLElement | null;
        markdownToHtml(text: string): string;
        getLog(): HTMLElement | null;
        requestFrame?: typeof requestAnimationFrame;
        document?: Document;
      }): {
        appendDelta(id: number, text: unknown): void;
        clear(): void;
        deleteTurn(id: number): void;
        reset(id: number): void;
      };
    };

    CairnChatStarterChips: {
      draw(log: Element): void;
    };

    CairnChatFuelContext: {
      clear(): void;
      current(): ChatScreenMessage[];
      seed(messages: Partial<ChatScreenMessage>[]): ChatScreenMessage[];
      remember(...msgs: Array<Partial<ChatScreenMessage> | null | undefined>): ChatScreenMessage[];
      messageHasFoodAction(message: Partial<ChatScreenMessage> | null | undefined): boolean;
      userMessageSuggestsFood(message: Partial<ChatScreenMessage> | null | undefined): boolean;
      wants(messages?: Partial<ChatScreenMessage>[]): boolean;
      html(day: ClientDayIntake | null | undefined): string;
      load(
        token: number,
        messages: Partial<ChatScreenMessage>[] | undefined,
        deps: {
          currentToken(): number;
          currentTab(): string | undefined;
          openFoodReview(): void;
        },
      ): Promise<void>;
    };

    CairnChatEarlierHistory: {
      expand(log: HTMLElement, bar: Element, block: HTMLElement): void;
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

    CairnExerciseDetailData: {
      number(value: unknown, fallback?: number): number;
      record(value: unknown): Record<string, unknown>;
      rows<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown): T[];
      view(row: Record<string, unknown>, deps: {
        escapeHtml(value: unknown): string;
        fmtDur(seconds: unknown): string;
        fmtWeight(weight: unknown): string;
      }): {
        timed: boolean;
        heroVal: number;
        heroLbl: string;
        heroTxt: string;
        sparkVals: unknown[];
        hasPR: boolean;
        appears: string;
        recentLines: string;
      };
    };

    CairnExerciseDetailExplanation: {
      exerciseExplanation(
        exercise: { name?: unknown; muscle_group?: unknown } | null | undefined,
        deps: ExerciseDetailControllerDeps,
      ): { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown };
      exerciseExplanationHtml(
        exercise: { name?: unknown; muscle_group?: unknown } | null | undefined,
        explanation: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null | undefined,
        deps: ExerciseDetailControllerDeps,
      ): string;
      hydrateExerciseExplanation(
        el: ParentNode,
        exercise: { name?: unknown; muscle_group?: unknown } & Record<string, unknown>,
        deps: ExerciseDetailControllerDeps,
      ): Promise<void>;
      replaceExerciseExplanation(
        el: ParentNode,
        exercise: { name?: unknown; muscle_group?: unknown } & Record<string, unknown>,
        explanation: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null | undefined,
        deps: ExerciseDetailControllerDeps,
      ): void;
      validExerciseExplanationPayload(value: unknown, deps: ExerciseDetailControllerDeps): boolean;
    };

    CairnExerciseDetailRender: {
      missingHtml(name: string, svg: string, deps: {
        artImg(kind: string, query: unknown, className?: string, svg?: string | null): string;
        escapeHtml(value: unknown): string;
        sparklineSvg(values: unknown, width?: number, height?: number): string;
      }): string;
      modalHtml(
        row: Record<string, unknown>,
        fallbackName: string,
        svg: string,
        view: {
          timed: boolean;
          heroVal: number;
          heroLbl: string;
          heroTxt: string;
          sparkVals: unknown[];
          hasPR: boolean;
          appears: string;
          recentLines: string;
        },
        explanationHtml: string,
        deps: {
          artImg(kind: string, query: unknown, className?: string, svg?: string | null): string;
          escapeHtml(value: unknown): string;
          sparklineSvg(values: unknown, width?: number, height?: number): string;
        },
      ): string;
    };

    CairnExerciseDetailActions: {
      wireActions(
        el: ParentNode,
        row: { name?: string } & Record<string, unknown>,
        fallbackName: string,
        timed: boolean,
        deps: ExerciseDetailControllerDeps,
      ): void;
    };

    CairnExerciseDetailController: {
      exerciseExplanation(
        exercise: { name?: unknown; muscle_group?: unknown } | null | undefined,
        deps: ExerciseDetailControllerDeps,
      ): { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown };
      exerciseExplanationHtml(
        exercise: { name?: unknown; muscle_group?: unknown } | null | undefined,
        explanation: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null | undefined,
        deps: ExerciseDetailControllerDeps,
      ): string;
      hydrateExerciseExplanation(
        el: ParentNode,
        exercise: { name?: unknown; muscle_group?: unknown } & Record<string, unknown>,
        deps: ExerciseDetailControllerDeps,
      ): Promise<void>;
      openExerciseModal(nameInput: unknown, fromTile: Element | null | undefined, deps: ExerciseDetailControllerDeps): Promise<void>;
      replaceExerciseExplanation(
        el: ParentNode,
        exercise: { name?: unknown; muscle_group?: unknown } & Record<string, unknown>,
        explanation: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null | undefined,
        deps: ExerciseDetailControllerDeps,
      ): void;
      wireGuides(scope: ParentNode | null | undefined, deps: ExerciseDetailControllerDeps): void;
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

    CairnUiReads: {
      baselineBandHtml(options?: {
        label?: unknown;
        position?: unknown;
        rangeStart?: unknown;
        rangeEnd?: unknown;
        phrase?: unknown;
        hot?: boolean;
      }): string;
      contributorRowsHtml(rows: unknown): string;
      levelChipHtml(options?: { label?: unknown; detail?: unknown }): string;
      trendLeadHtml(options?: { name?: unknown; phrase?: unknown; tone?: unknown }): string;
    };

    CairnUiFeedback: {
      stagger(index?: number | null): string;
      reducedMotion(): boolean;
      btnBusy(
        btn: Element | null | undefined,
        label?: unknown,
        options?: { ghost?: boolean },
      ): () => void;
      countUp(
        element: Element | null | undefined,
        target: unknown,
        options?: { dur?: number; fmt?: (value: number) => string },
      ): void;
      fmtK(value: unknown): string;
      runCountUps(scope?: ParentNode | null, options?: { snap?: boolean }): void;
      loadingState(label: unknown): string;
      thinkingCaption(el: Element | null | undefined, op?: unknown): () => void;
      tabErrorState(tab: unknown): void;
      skelLines(count?: number): string;
      todaySkeleton(): string;
      segSkeleton(active: string, seg: readonly ClientSegment[], cards?: number): string;
    };

    CairnUiActions: {
      toast(message: unknown, options?: { action?: string; onAction?: () => void }): void;
      armDelete(
        btn: Element | null | undefined,
        onConfirm: () => unknown,
        options?: { label?: string },
      ): void;
    };

    CairnUiHeader: {
      setTodayHeaderTitle(deps: {
        headerTitle: HTMLElement;
        state: { tab?: unknown; logDate?: string; day?: unknown; dayPicked?: boolean };
        escapeHtml(value: unknown): string;
        dateLabel(iso: string): string;
        localISO(date?: Date): string;
        syncRouteFromState(): unknown;
        renderToday(): unknown;
      }): void;
      updateHeaderCondense(deps: { state: { tab?: unknown } }): void;
      installHeaderCondenseScroll(depsFor: () => { state: { tab?: unknown } }): void;
    };

    CairnUiViewTransitions: {
      create(deps: {
        view: HTMLElement;
        reducedMotion(): boolean;
      }): {
        viewEnter(): void;
        withViewTransition(fn: () => unknown): Promise<unknown>;
        skelSwap(fn: () => unknown): Promise<unknown>;
      };
      isViewTransitionAbort(error: unknown): boolean;
    };

    CairnDetailOverlay: {
      closeDetail(instant?: boolean): void;
      openDetailFrom(fromEl: Element | null | undefined, build: () => unknown): void;
      mountDetail(html: string, photoSrc?: string | null): HTMLElement;
      wireDetailCommon(): void;
      wireArtZoom(artEl: Element | null | undefined): void;
    };

    CairnUiMotion: {
      collapseEl(el: Element | null | undefined, done?: () => void): void;
      expandEl(el: Element | null | undefined): void;
    };

    CairnHealthEvidence: {
      DIRECTIVE_DOMAINS: readonly (readonly [string, string, string])[];
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
    };

    CairnHealthMarkerOrder: {
      isDirectLdlMarker(name: unknown): boolean;
      isStandardLdlMarker(name: unknown): boolean;
      markerRank(groupKey: unknown, name: unknown): number;
      lipidRank(name: unknown): number;
      lipidSubgroup(name: unknown): string | null;
      markerSubgroup(groupKey: unknown, name: unknown): string | null;
      orderMarkersForDisplay<T extends { name?: unknown; key?: unknown }>(groupKey: unknown, list: T[] | null | undefined): T[];
      lipidGroupNoteHtml(
        list: Array<{ name?: unknown; key?: unknown; latest?: { date?: unknown } | null }> | null | undefined,
        options?: { relAge?: (date: string) => string },
      ): string;
    };

    CairnHealthClient: Window["CairnHealthEvidence"] & Window["CairnHealthMarkerOrder"] & {
      MAX_DOC_BYTES: number;
      MAX_DOC_TEXT: number;
      H_FILE_PROMPT: string;
      HEALTH_HERO_ART: string;
      askCoach(question: unknown): void;
      guessUploadMime(file: { type?: unknown; name?: unknown } | null | undefined): string;
      markersEmptyHtml(heroArt?: string): string;
      formatMarkerNumber(value: unknown): string;
      sparkDateLabel(value: unknown): string;
      markerSpanWord(days: unknown): string;
      markerTrendWord(marker: {
        trend?: { dir?: unknown; span_days?: unknown } | null;
        points?: Array<{ value?: unknown; date?: unknown }> | null;
      } | null | undefined): string;
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

    CairnHealthPictureController: {
      getHealthPictureCache(): ClientHealthPictureCache | null;
      setHealthPictureCache(cache: ClientHealthPictureCache | null): ClientHealthPictureCache | null;
      healthDocsKnownEmpty(deps?: Partial<ClientHealthPictureControllerDeps>): boolean;
      isHealthReviewRunning(): boolean;
      paintHealthPicture(deps: ClientHealthPictureControllerDeps): void;
      runHealthReview(deps: ClientHealthPictureControllerDeps): Promise<void>;
      reconnectHealthReview(deps: ClientHealthPictureControllerDeps): ClientAgentOpHandlers | null;
      loadHealthPicture(token: number, docsPromise: Promise<unknown>, deps: ClientHealthPictureControllerDeps): Promise<void>;
    };

    CairnHealthMarkers: {
      formatMarkerNumber(value: unknown): string;
      sparkDateLabel(value: unknown): string;
      markerTrendWord(marker: {
        trend?: { dir?: unknown; span_days?: unknown } | null;
        points?: Array<{ value?: unknown; date?: unknown }> | null;
      } | null | undefined): string;
      markerSpanWord(days: unknown): string;
      optimalPhrase(marker: Record<string, unknown> | null | undefined): string;
      optimalSideWord(marker: Record<string, unknown> | null | undefined): string;
      referenceRangePhrase(marker: Record<string, unknown> | null | undefined): string;
      markerReferenceSub(marker: Record<string, unknown> | null | undefined): string;
      markerStatus(marker: Record<string, unknown> | null | undefined): "ok" | "watch" | "warn" | "mute";
      markerOutOfRange(marker: Record<string, unknown> | null | undefined): boolean;
      markerAskQuestion(marker: Record<string, unknown> | null | undefined): string;
      markerChartSvg(marker: Record<string, unknown> | null | undefined): string;
      markerBandSvg(marker: Record<string, unknown> | null | undefined): string;
      wireMarkerChart(svg: SVGElement | null | undefined): void;
      markerPanelHtml(marker: Record<string, unknown> | null | undefined): string;
      hmkRowHtml(marker: Record<string, unknown> | null | undefined, index?: number): string;
    };

    CairnHealthMarkersController: {
      load(deps: ClientHealthMarkersControllerDeps, token: number): void;
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

    CairnHealthStandingPrimitives: ClientHealthStandingPrimitivesApi;

    CairnHealthStanding: ClientHealthStandingPrimitivesApi & {
      renderHealthStandingHtml(data: ClientHealthStanding | null | undefined, options?: { referenceAge?: unknown }): string;
    };

    CairnHealthStandingController: {
      load(deps: ClientHealthStandingControllerDeps, token: number, refAge?: unknown): void;
      openBpSheet(deps: ClientHealthStandingControllerDeps): void;
      openRead(deps: ClientHealthStandingControllerDeps, opts?: { scroll?: string }): void;
      paintReview(deps: ClientHealthStandingControllerDeps): void;
      render(data: ClientHealthStanding | null | undefined, deps: ClientHealthStandingControllerDeps): void;
    };

    CairnHealthRisk: {
      renderCardiovascularRiskHtml(data: ClientCardiovascularRisk | null | undefined): string;
    };

    CairnHealthRiskController: {
      load(deps: ClientHealthRiskControllerDeps, token: number): void;
      render(data: ClientCardiovascularRisk | null | undefined, deps: ClientHealthRiskControllerDeps): void;
    };

    CairnHealthRead: {
      recoveryNoDataHtml(message?: string): string;
      recoveryLineHtml(text: unknown, sub: unknown): string;
      recoveryHtml(summary: Record<string, unknown> | null | undefined): string;
      optimalPhrase(marker: Record<string, unknown> | null | undefined): { word: string; tone: "ok" | "warn" | "watch" };
      priorityMarkerHtml(marker: Record<string, unknown> | null | undefined, index: number): string;
      priorityMarkersSectionHtml(markers: unknown): string;
    };

    CairnHealthReadSynthesis: {
      load(deps: ClientHealthReadControllerDeps, token: number): void;
      render(data: unknown, deps: ClientHealthReadControllerDeps, token?: number | null): void;
      trigger(deps: ClientHealthReadControllerDeps): void;
    };

    CairnHealthReadSupplements: {
      load(deps: ClientHealthReadControllerDeps, token: number): void;
      render(list: unknown, deps: ClientHealthReadControllerDeps, token?: number | null): void;
      understandFromInput(deps: ClientHealthReadControllerDeps): Promise<void>;
      remove(id: number, deps: ClientHealthReadControllerDeps): Promise<void>;
    };

    CairnHealthReadController: {
      paintTab(deps: ClientHealthReadControllerDeps): void;
      loadSynthesis(deps: ClientHealthReadControllerDeps, token: number): void;
      renderSynthesis(data: unknown, deps: ClientHealthReadControllerDeps, token?: number | null): void;
      triggerSynthesis(deps: ClientHealthReadControllerDeps): void;
      loadSymptomLinks(deps: ClientHealthReadControllerDeps, token: number): Promise<void>;
      loadSupplements(deps: ClientHealthReadControllerDeps, token: number): void;
      renderSupplements(list: unknown, deps: ClientHealthReadControllerDeps, token?: number | null): void;
      understandSupplementsFromInput(deps: ClientHealthReadControllerDeps): Promise<void>;
      removeSupplement(id: number, deps: ClientHealthReadControllerDeps): Promise<void>;
      loadRecoverySummary(deps: ClientHealthReadControllerDeps, token: number, selector: string): void;
      loadPriorityMarkers(deps: ClientHealthReadControllerDeps, token: number): void;
      scrollHealthRailIntoView(deps: ClientHealthReadControllerDeps, selector: string): void;
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

    CairnMeHealthLogRenderer: {
      healthLogRows<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown): T[];
      wireNoteCard(el: Element, deps: {
        state: Pick<ClientAppState, "_notesById">;
        select<T extends Element = Element>(selector: string): T | null;
        noteEntryHtml(note: Record<string, unknown>, index?: number): string;
        activityEntryHtml(activity: ClientActivity & Record<string, unknown>): string;
        openFoodDetail(note: unknown, fromTile?: Element | null): unknown;
      }): void;
      renderNotes(notes: unknown, deps: Parameters<Window["CairnMeHealthLogRenderer"]["wireNoteCard"]>[1]): void;
      renderActs(activities: unknown, deps: Parameters<Window["CairnMeHealthLogRenderer"]["wireNoteCard"]>[1]): void;
    };

    CairnMeHealthDependencies: ClientMeHealthDependenciesApi;

    CairnMeHealthTabsController: {
      HEALTH_SEG: readonly (readonly [ClientHealthSection, string])[];
      normalizeHealthSeg(seg: unknown): ClientHealthSection;
      renderHealth(deps: ClientMeHealthTabsControllerDeps): Promise<void>;
      setHealthSegActive(seg: ClientHealthSection, deps: ClientMeHealthTabsControllerDeps): void;
      switchHealthSeg(seg: ClientHealthSection, deps: ClientMeHealthTabsControllerDeps, opts?: { openPicker?: boolean }): void;
      paintHealthTab(deps: ClientMeHealthTabsControllerDeps): void;
    };

    CairnFoodDetailController: {
      openFoodDetail(note: unknown, fromTile: Element | null | undefined, deps: FoodDetailControllerDeps): Promise<void>;
    };

    CairnMeProfileForm: {
      record(value: unknown): Record<string, unknown>;
      goalMode(profile: MeProfileProfile, goal: MeProfileGoalCheck): string;
      enduranceGoal(profile: MeProfileProfile): MeProfileEnduranceGoalDraft;
      html(
        deps: MeProfileControllerDeps,
        profile: MeProfileProfile,
        goal: MeProfileGoalCheck,
        context: MeProfileFormContext,
      ): string;
      unitPref(): "in" | "cm";
      setUnitPref(unit: "in" | "cm"): void;
    };

    CairnMeProfileController: {
      renderProfile(deps: MeProfileControllerDeps): Promise<void>;
    };

    CairnPlanEnduranceModel: {
      ENDURANCE_PHASES: readonly Record<string, string>[];
      rampHtml(goal: ClientEnduranceGoal | null | undefined): string;
      presets(goal: ClientEnduranceGoal | null | undefined): Array<{ t: string; i: string }>;
      draftCardHtml(proposal: Record<string, unknown>): string;
      record(value: unknown): Record<string, unknown>;
      runs(plan: unknown): Array<{ it: Record<string, unknown>; day_number: unknown }>;
    };

    CairnPlanEndurance: Window["CairnPlanEnduranceModel"];

    CairnPlanEditor: {
      blankStrength(): Record<string, unknown>;
      blankCardio(): Record<string, unknown>;
      dayModelFromPlan(day: Record<string, unknown>): Record<string, unknown>;
      calendarFooterHtml(plan: unknown, host: unknown, icsUrl: unknown): string;
      progDayHtml(day: Record<string, unknown>, dayIndex: number): string;
      pitemHtml(item: Record<string, unknown>, dayIndex: number, itemIndex: number, lastIndex: number): string;
      pdayHtml(day: Record<string, unknown>, dayIndex: number): string;
    };

    CairnPlanEditorForm: {
      dayNumber(day: Record<string, unknown>): number;
      datasetNumber(el: HTMLElement, key: string): number;
      datasetPair(value: string | undefined): [number, number];
      syncModel(model: Array<Record<string, unknown> & { items: Array<Record<string, unknown>> }>, root: ParentNode): void;
      serializeDays(model: Array<Record<string, unknown> & { items: Array<Record<string, unknown>> }>): Array<Record<string, unknown>>;
    };

    CairnPlanEditorController: {
      render(): Promise<void>;
      serializeDays(model: Array<{ day_number?: unknown; name?: unknown; focus?: unknown; items: Array<Record<string, unknown>> }>): Array<Record<string, unknown>>;
    };

    CairnDayFuel: {
      MEAL_LABEL: Record<string, string>;
      mealLabelHtml(meal: unknown): string;
      dayFuelHtml(day: Record<string, unknown> | null | undefined): string;
    };

    CairnDayFuelController: {
      loadDayFuel(
        token: number,
        options?: {
          root?: ParentNode | null | undefined;
          isCurrent?: (token: number) => boolean;
          onRerender?: () => unknown;
          onAsk?: () => unknown;
        },
      ): Promise<void>;
      openFoodEdit(
        id: number,
        fromEl: Element,
        options?: {
          root?: ParentNode | null | undefined;
          isCurrent?: (token: number) => boolean;
          onRerender?: () => unknown;
          onAsk?: () => unknown;
        },
      ): void;
    };

    CairnMealRows: ClientMealRowsApi;
    mealSlotFor: ClientMealRowsApi["mealSlotFor"];
    mealRowHtml: ClientMealRowsApi["mealRowHtml"];
    mealDayHtml: ClientMealRowsApi["mealDayHtml"];

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
      mealPlannerBodyHtml(current: unknown, mealPrefs: unknown, options?: { checkedShopping?: unknown; verified?: unknown; now?: unknown; upcoming?: unknown }): {
        html: string;
        context: { weekOf: string; targetKcal: number; todayName: string } | null;
      };
      mealDayHtml(day: unknown, dayIndex: number, context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown }): string;
    };

    CairnMealPlannerController: {
      draftWeeklyMeals(): void;
      reconnectMealPlan(job?: unknown): ClientAgentOpHandlers | null;
      reconnectStatusHost(
        options: ClientAgentOpHandlers & {
          path: string;
          anchor: string;
          caption: string;
          guard: () => boolean;
          isFail: (result: unknown) => boolean;
          render: (result: unknown) => unknown;
          onFail: (error?: unknown) => unknown;
        },
        statusSelector: string,
        buttonSelector: string | null,
        ghost: boolean,
      ): ClientAgentOpHandlers | null;
      renderMealPlans(plans: unknown, selector?: string, refresh?: (() => unknown) | null): void;
      runCoachMealPlan(agent: string, instruction: string): void;
      verifiedForPlan(id: unknown): unknown;
      wireMealPlannerBody(
        currentPlan: (Record<string, unknown> & { id: string | number }) | null,
        context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null,
      ): void;
    };

    CairnMealPlannerJobs: {
      cacheKey(): string;
      settingsCacheKey(): string;
      errorMessage(value: unknown): string | undefined;
      draftFailLine(error?: unknown): string;
      restoreBusy(value: Element | null | undefined): void;
      rememberVerified(result: unknown): void;
      verifiedForPlan(id: unknown): unknown;
      runCoachMealPlan(agent: string, instruction: string): void;
      coachMealPlanOpOpts(): ClientAgentOpHandlers & {
        path: string;
        anchor: string;
        caption: string;
        guard: () => boolean;
        isFail: (result: unknown) => boolean;
        render: (result: unknown) => unknown;
        onFail: (error?: unknown) => unknown;
      };
      draftWeeklyMeals(): void;
      mealPlanDraftOpOpts(): ClientAgentOpHandlers & {
        path: string;
        anchor: string;
        caption: string;
        guard: () => boolean;
        isFail: (result: unknown) => boolean;
        render: (result: unknown) => unknown;
        onFail: (error?: unknown) => unknown;
      };
      reconnectStatusHost(
        options: ClientAgentOpHandlers & {
          path: string;
          anchor: string;
          caption: string;
          guard: () => boolean;
          isFail: (result: unknown) => boolean;
          render: (result: unknown) => unknown;
          onFail: (error?: unknown) => unknown;
        },
        statusSelector: string,
        buttonSelector: string | null,
        ghost: boolean,
      ): ClientAgentOpHandlers | null;
      reconnectMealPlan(job?: unknown): ClientAgentOpHandlers | null;
    };

    CairnMealPlannerActions: {
      renderMealPlans(plans: unknown, selector?: string, refresh?: (() => unknown) | null): void;
      wireMealPrefs(): void;
      wireShoppingChips(currentPlan: Record<string, unknown> & { id: string | number }): void;
      wireMealPlannerBody(
        currentPlan: (Record<string, unknown> & { id: string | number }) | null,
        context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null,
      ): void;
    };

    CairnCoachProposalController: {
      applyProposalById(id: string | number | undefined, btn?: Element | null): Promise<unknown>;
      coachProposalOpOpts(): ClientAgentOpHandlers & {
        path: string;
        anchor: string;
        caption: string;
        guard: () => boolean;
        isFail: (result: unknown) => boolean;
        render: (result: unknown) => unknown;
        onFail: (error?: unknown) => unknown;
      };
      reconnectProposal(job?: unknown): ClientAgentOpHandlers | null;
      refreshProposals(): Promise<void>;
      renderProposals(proposals: unknown): void;
      runCoachProposal(agent: string, instruction: string): void;
    };

    CairnMealSwapController: {
      mealSwapOpOpts(
        current: Record<string, unknown> & { id: string | number },
        context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null,
        dayIndex: number,
        mealIndex: number,
      ): ClientAgentOpHandlers & {
        path: string;
        anchor: string;
        caption: string;
        guard: () => boolean;
        isFail: (result: unknown) => boolean;
        render: (result: unknown) => void;
        onFail: (error?: unknown) => void;
      };
      moveMealRow(
        current: Record<string, unknown> & { id: string | number },
        context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null,
        dayIndex: number,
        mealIndex: number,
        direction: number,
      ): Promise<void>;
      reconnectMealSwap(job?: unknown): ClientAgentOpHandlers | null;
      submitMealSwap(
        current: Record<string, unknown> & { id: string | number },
        context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null,
        dayIndex: number,
        mealIndex: number,
        panel: HTMLElement,
      ): Promise<void>;
      wireMealRows(
        scope: ParentNode,
        current: Record<string, unknown> & { id: string | number },
        context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null,
      ): void;
    };

    CairnMealSwapData: ClientMealSwapData;

    CairnMealRecipe: {
      ctaHtml(): string;
      recipeHtml(recipe: unknown): string;
      loadingHtml(): string;
    };

    CairnMealRecipeController: {
      closeMealSheet(instant?: boolean): void;
      openMealSheet(current: Record<string, unknown> & { id: string | number }, dayIndex: number, mealIndex: number): void;
      recipeOpOpts(
        current: Record<string, unknown> & { id: string | number },
        dayLabel: string,
        dayIndex: number,
        mealIndex: number,
        key: string | undefined,
      ): ClientAgentOpHandlers;
      reconnectRecipe(job?: unknown): ClientAgentOpHandlers | null;
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
      LEARNED_GROUPS: readonly (readonly [ClientLearnedKind, string, string])[];
      learnedItemHtml(item: Partial<ClientLearnedItem> | null | undefined, index: number): string;
      learnedTimelineHtml(data: ClientLearnedTimeline | null | undefined): string;
    };

    CairnMemory: {
      MEM_KINDS: readonly ClientMemoryKind[];
      memoryKindOptionsHtml(selected?: ClientMemoryKind | null): string;
      memoryRowHtml(row: ClientMemory, index?: number): string;
    };

    CairnMeMemoryController: {
      render(deps: ClientMeMemoryControllerDeps): Promise<void>;
      load(deps: ClientMeMemoryControllerDeps): Promise<void>;
      startEdit(row: HTMLElement | null, deps: ClientMeMemoryControllerDeps): void;
      startDelete(button: Element, deps: ClientMeMemoryControllerDeps): void;
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

    CairnFamilyController: {
      render(deps: ClientFamilyControllerDeps): Promise<void>;
      load(deps: ClientFamilyControllerDeps): Promise<void>;
      startEdit(card: HTMLElement | null, deps: ClientFamilyControllerDeps): void;
      rewireCard(card: HTMLElement, deps: ClientFamilyControllerDeps): void;
      startDelete(btn: Element, deps: ClientFamilyControllerDeps): void;
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

    CairnLifeFormHelpers: {
      record(value: unknown): Record<string, unknown>;
      rows<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown): T[];
      inputValue(id: string): string;
      trimmedInputValue(id: string): string | null;
      drawFields(kind: unknown): void;
      collectForm(): ClientLifeControllerForm;
      submit(deps: ClientLifeControllerDeps): Promise<void>;
    };

    CairnLifeTimelineActions: {
      load(deps: ClientLifeControllerDeps): Promise<void>;
      rewireCard(card: HTMLElement, deps: ClientLifeControllerDeps): void;
      startDelete(button: Element, deps: ClientLifeControllerDeps): void;
      startEdit(card: HTMLElement | null, deps: ClientLifeControllerDeps): void;
    };

    CairnLifeController: {
      collectForm(): ClientLifeControllerForm;
      drawFields(kind: unknown): void;
      load(deps: ClientLifeControllerDeps): Promise<void>;
      render(deps: ClientLifeControllerDeps): Promise<void>;
      rewireCard(card: HTMLElement, deps: ClientLifeControllerDeps): void;
      startDelete(button: Element, deps: ClientLifeControllerDeps): void;
      startEdit(card: HTMLElement | null, deps: ClientLifeControllerDeps): void;
      submit(deps: ClientLifeControllerDeps): Promise<void>;
    };

    CairnHealthDocs: {
      healthKindLabel(kind: unknown): string;
      parsedDoc(doc: unknown): { markers?: Array<Record<string, unknown>>; clinical_facts?: unknown[]; type?: unknown } | null;
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

    CairnHealthDocUploadController: {
      wireUpload(deps: ClientHealthDocUploadControllerDeps): void;
      refreshPictureAfterUpload(doc: ClientHealthDocument, deps: ClientHealthDocUploadControllerDeps): void;
    };

    CairnHealthDocDateActions: {
      cancelEditor(row: HTMLElement, editBtn: HTMLElement | null): void;
      openEditor(row: HTMLElement, editBtn: HTMLElement): void;
      saveDate(id: string | number, deps: ClientHealthDocActionsControllerDeps): Promise<void>;
    };

    CairnHealthDocLifecycleActions: {
      pollDoc(id: string | number, deps: ClientHealthDocActionsControllerDeps): void;
      reanalyze(id: string | number, deps: ClientHealthDocActionsControllerDeps): Promise<void>;
      refreshPictureAfterDelete(deps: ClientHealthDocActionsControllerDeps): void;
      startDelete(btn: Element, deps: ClientHealthDocActionsControllerDeps): void;
    };

    CairnHealthDocActionsController: {
      pollDoc(id: string | number, deps: ClientHealthDocActionsControllerDeps): void;
      refreshPictureAfterDelete(deps: ClientHealthDocActionsControllerDeps): void;
      wireDoc(el: HTMLElement | null, deps: ClientHealthDocActionsControllerDeps): void;
    };

    CairnHealthRecordsController: {
      render(deps: ClientHealthRecordsControllerDeps): Promise<ClientHealthDocument[]>;
      loadDocs(deps: ClientHealthRecordsControllerDeps): Promise<ClientHealthDocument[]>;
      wireDoc(el: HTMLElement | null, deps: ClientHealthRecordsControllerDeps): void;
      wireUpload(deps: ClientHealthRecordsControllerDeps): void;
    };

    CairnHealthShareController: {
      render(deps: ClientHealthShareControllerDeps): void;
    };

    CairnSettingsClient: {
      AGENT_OP_LABELS: Record<string, string>;
      garminStatusLine(settings: unknown, syncing: boolean, options?: { relTime?: (value: string) => string }): string;
      agentHealthCard(stats: unknown): string;
      agentOpLabel(op: unknown): string;
      agentActivityCard(
        stats: unknown,
        options?: { relTime?: (value: string) => string; absDate?: (value: string) => string }
      ): string;
      noticedCard(
        data: unknown,
        options?: { relTime?: (value: string) => string; absDate?: (value: string) => string }
      ): string;
      brainDiagnosticsCard(data: unknown): string;
      diagnosticsCard(
        data: unknown,
        options?: {
          relTime?: (value: string) => string;
          absDate?: (value: string) => string;
          status?: "loading" | "ready" | "unavailable";
          readinessStatus?: "loading" | "ready" | "unavailable";
          readiness?: unknown;
          days?: 1 | 7 | 30;
          source?: string;
          severity?: string;
          issuePage?: number;
          recentPage?: number;
        }
      ): string;
      agentChipState(agent: Record<string, unknown>): { cls: string; label: string };
      updateCardHtml(status: unknown, options: { updateCheckEnabled: boolean }): string;
    };

    CairnClientDiagnostics: {
      report(input: Record<string, unknown>): boolean;
      reportError(kind: string, error: unknown, extra?: Record<string, unknown>): boolean;
      flush(): Promise<void>;
      pending(): Array<Record<string, unknown>>;
      installGlobalHandlers(target?: Window): void;
    };

    CairnClientDiagnosticsCore: {
      createClientDiagnosticReporter(options?: Record<string, unknown>): unknown;
      normalizeRoute(value: unknown): string;
      sanitize(value: unknown, max?: number): string;
      hash(value: string): string;
    };

    CairnSettingsSurface: {
      SET_SEG: readonly ClientSegment[];
      record(value: unknown): Record<string, unknown>;
      string(value: unknown, fallback?: string): string;
      number(value: unknown, fallback?: number): number;
      bool(value: unknown, fallback?: boolean): boolean;
      settingsData(value: unknown): SettingsScreenData;
      workingModel(data: SettingsScreenData): SettingsScreenWorkingModel;
      routeEligible(data: SettingsScreenData): { eligible?: boolean; reason?: string } | null;
      statusHelpers(options?: {
        relTime?: (value: string) => string;
        absDate?: (value: string) => string;
      }): {
        garminStatusLine(settings: unknown, syncing: boolean): string;
        agentHealthCard(stats: unknown): string;
        agentOpLabel(op: unknown): string;
        agentActivityCard(stats: unknown): string;
        noticedCard(data: unknown): string;
        agentChipState(agent: Record<string, unknown> | null | undefined): { cls: string; label: string };
      };
      artSpendCardHtml(stats: unknown): string;
      sourcesSliceHtml(options: {
        workingModel: Pick<SettingsScreenWorkingModel, "garmin_username">;
        settings: Record<string, unknown>;
        garminStatusHtml: string;
      }): string;
      automationSliceHtml(options: {
        workingModel: Pick<
          SettingsScreenWorkingModel,
          "enrich_enabled" | "art_enabled" | "research_enabled" | "lead_mode"
        >;
        settings: Record<string, unknown>;
        artSpendHtml: string;
        researchEligible: { eligible?: boolean; reason?: string } | null;
      }): string;
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

    CairnSettingsDataController: {
      render(deps: ClientSettingsDataControllerDeps): void;
    };

    CairnSettingsSourcesAutomationController: {
      renderSources(deps: ClientSettingsSourcesAutomationControllerDeps): void;
      renderAutomation(deps: ClientSettingsSourcesAutomationControllerDeps): void;
    };

    CairnSettingsAgents: {
      agentsSliceHtml(options: {
        agentStrategy: string;
        routeSummary: string;
        routeRowsHtml: string;
        agentHealthHtml: string;
        agentActivityHtml: string;
        noticedHtml: string;
        coachDay: number;
        coachHour: number;
        timeZone: string;
        dayNames: string[];
      }): string;
      agentListHtml(options: {
        order: string[];
        disabled: ReadonlySet<string>;
        meta: Record<string, (Record<string, unknown> & { name: string }) | undefined>;
        agentInfo: Record<string, { version: unknown; model_current: unknown; update_available?: boolean } | undefined>;
        agentModels: Record<string, unknown[] | undefined>;
        stagger?: (index: number) => string;
      }): string;
    };

    CairnSettingsAgentsController: {
      render(deps: ClientSettingsAgentsControllerDeps): void;
      renderList(deps: ClientSettingsAgentsControllerDeps): void;
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

    CairnProgressData: {
      isRecord(value: unknown): value is ProgressRecord;
      record(value: unknown): ProgressRecord;
      rows<T extends ProgressRecord = ProgressRecord>(value: unknown): T[];
      string(value: unknown): string;
      number(value: unknown, fallback?: number): number;
    };

    CairnProgressComponents: {
      fmtShortDate(iso: unknown): string;
      progressHero(
        title: unknown,
        stats: Array<readonly [unknown, unknown] | readonly [unknown, unknown, { text?: boolean; k?: boolean }] | null | undefined | false>,
      ): string;
      emptyStateHtml(svg: string | null | undefined, line: unknown): string;
    };

    CairnProgressLineChartModel: {
      buildModel(pts: ProgressChartPoint[] | null | undefined, options: {
        width: number;
        height: number;
        goal?: number | null;
        padding?: Partial<{ left: number; right: number; top: number; bottom: number }> | null;
      }): ProgressLineChartModel | null;
      nearestIndex(axis: readonly number[] | null | undefined, pixelX: number): number | null;
    };

    CairnProgressChartScrub: {
      wire(canvas: HTMLCanvasElement & {
        _chartXs?: number[];
        _setTarget?: (idx: number | null, scrubbing: boolean) => void;
        _scrubWired?: boolean;
      }): void;
    };

    CairnProgressChartDrawing: {
      withAlpha(hex: unknown, alpha: number): string;
      chartColors(): ProgressChartPalette;
      tracePath(ctx: CanvasRenderingContext2D, xs: number[], ys: number[], slopes: number[], count: number): void;
      drawBase(
        ctx: CanvasRenderingContext2D,
        model: ProgressLineChartModel,
        points: ProgressChartPoint[],
        options: ProgressLineChartOptions,
        colors: ProgressChartPalette,
        width: number,
        height: number,
      ): void;
      drawHighlight(ctx: CanvasRenderingContext2D, args: ProgressChartHighlightOptions): void;
    };

    CairnProgressChart: {
      withAlpha(hex: unknown, alpha: number): string;
      drawLineChart(canvas: HTMLCanvasElement | null | undefined, pts: ProgressChartPoint[], opts?: ProgressLineChartOptions): void;
      chartColors(): ProgressChartPalette;
    };

    CairnProgressTrendWeight: {
      paintProgressBody(exercises: ProgressExercise[]): void;
      paintWeightBody(rows: ProgressWeightRow[], profile: ProgressRecord): void;
      drawProgress(name: string): Promise<void>;
    };

    CairnProgressHistory: {
      sessionCardHtml(session: unknown, index: number): string;
      numOrNull(value: unknown): number | null;
    };

    CairnProgressHistoryModel: {
      rows<T extends ProgressHistoryRecord = ProgressHistoryRecord>(value: unknown): T[];
      string(value: unknown): string;
      number(value: unknown, fallback?: number): number;
      numOrNull(value: unknown): number | null;
      sessionSetScore(set: ProgressHistorySet): number;
      weekday(date: unknown): string;
      exerciseGroups(sets: ProgressHistorySet[] | null | undefined): ProgressHistoryExerciseGroup[];
      sessionCardModel(session: unknown): ProgressHistorySessionCardModel;
      editGroups(session: HistorySession): ProgressHistoryEditGroup[];
      summary(sessions: HistorySession[], now?: Date): ProgressHistorySummary;
    };

    CairnProgressHistoryRender: {
      setFigure(set: ProgressHistorySet): string;
      sessionCardHtml(session: unknown, index: number): string;
      editSetHtml(set: ProgressHistorySet): string;
      editGroupHtml(group: ProgressHistoryEditGroup): string;
      sessionEditHtml(session: HistorySession): string;
    };

    CairnProgressRunPlan: {
      runKindClass(kind: unknown): string;
      runKindLabel(kind: unknown): string;
      weeklyRunPlanCard(plan: ClientWeeklyRunPlan | null | undefined): string;
      enduranceGoalCard(goal: ClientEnduranceGoal | null | undefined): string;
      runComplianceLine(compliance: ClientRunCompliance | null | undefined): string;
      enduranceCoachLine(plan: ClientWeeklyRunPlan | null | undefined): string;
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

    CairnProgressEnergySurface: {
      paintEnergyBody(exp: unknown): void;
      reconnectNutritionCheckin(): ClientAgentOpHandlers | null;
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
      capacityRowHtml(capacity: ClientPerformanceStanding["capacities"][number], sexWord: string): string;
      performanceHtml(performance: ClientPerformanceStanding | null | undefined, options?: { suppressLever?: boolean }): string;
    };

    CairnProgressFocus: {
      cardHtml(): string;
      hasFocusCard(): boolean;
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
      liftStatusWord(lift: ClientProgramState["lifts"][number] | null | undefined): string;
      liftTrendFig(lift: ClientProgramState["lifts"][number] | null | undefined): string;
      liftBestFig(lift: ClientProgramState["lifts"][number] | null | undefined): string;
      sortLifts(lifts: ClientProgramState["lifts"] | null | undefined): ClientProgramState["lifts"];
      volBandWord(band: unknown): string;
      volTrendGlyph(trend: unknown): string;
      phaseWord(phase: unknown): string;
      liftRowHtml(lift: ClientProgramState["lifts"][number] | null | undefined, index: number): string;
      volumeBlockHtml(volume: ClientProgramState["volume"] | null | undefined, startIdx: number): string;
      mesoBlockHtml(meso: ClientProgramState["mesocycle"] | null | undefined, index: number): string;
      adaptationsHtml(adaptations: string[] | null | undefined, index: number): string;
    };

    CairnProgressProgramBlock: {
      blockFocusWord(focus: unknown): string;
      activeBlockHtml(block: ClientProgramBlock | null | undefined): string;
      startBlockHtml(): string;
      loadProgramBlock(): Promise<void>;
      wireProgramBlock(slot: Element): void;
    };

    CairnProgressProgramController: {
      focus: Window["CairnProgressFocus"];
      render(deps: ClientProgressProgramControllerDeps): Promise<unknown>;
      paint(data: ClientProgramState, deps: ClientProgressProgramControllerDeps): void;
      triggerProgramEvolve(btn: Element, deps: ClientProgressProgramControllerDeps): Promise<void>;
      tidyExerciseNames(btn: Element, deps: ClientProgressProgramControllerDeps): Promise<void>;
    };

    CairnProgressJourney: ClientProgressJourneyApi;

    CairnProgressRouteDeps: ClientProgressRouteDeps;

    CairnCoachingFocus: {
      CFOCUS_DOMAIN_LABEL: Record<string, string>;
      cfocusDomainTag(domain: unknown): string;
      coachingFocusCardHtml(focus: ClientCoachingFocus | null | undefined, options?: { blockLine?: boolean; actions?: boolean }): string;
      coachingFocusCompactHtml(focus: ClientCoachingFocus | null | undefined): string;
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
      enduranceBlockHtml(end: ClientProgramState["endurance"], idx: number): string;
      paceTrendWord(trend: unknown): string;
      zoneBarHtml(zones: unknown): string;
      enduranceBestRows(group: ClientSportBests | null | undefined): Array<{ label: string; val: string; date: string; type: string }>;
      enduranceSportCardHtml(group: ClientSportBests | null | undefined, idx: number): string;
      hybridLoadCardHtml(hybrid: ClientProgramState["hybrid"], idx?: number): string;
    };

    CairnProgressEnduranceController: {
      render(deps: ClientProgressEnduranceControllerDeps): Promise<void>;
      paint(
        end: unknown,
        prs: ClientEndurancePRs | null,
        goal: ClientEnduranceGoal | null,
        compliance: ClientRunCompliance | null,
        settings: unknown,
        runPlan: ClientWeeklyRunPlan | null,
        programState: ClientProgramState | null,
        deps: ClientProgressEnduranceControllerDeps,
      ): void;
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

    CairnTodayRailController: {
      fetchTodayAgenda(
        date: string,
        deps: ClientTodayRailControllerDeps,
      ): Promise<ClientTodayAgenda | null>;
      railHtml(agenda: Partial<ClientTodayAgenda> | null | undefined, genericPending: ClientTodayAgendaCandidate[]): string;
      fallbackRailHtml(isToday: boolean): string;
      runAgendaRail(
        agenda: Partial<ClientTodayAgenda> | null | undefined,
        genericPending: ClientTodayAgendaCandidate[],
        deps: ClientTodayRailControllerDeps,
      ): void;
      runFallbackRail(isToday: boolean, deps: ClientTodayRailControllerDeps): void;
      loadFuelToday(date: string, deps: ClientTodayRailControllerDeps): Promise<void>;
      loadWeekAhead(deps: ClientTodayRailControllerDeps): Promise<void>;
      loadProgramAdjustmentsBanner(deps: ClientTodayRailControllerDeps): Promise<void>;
      loadRecentActivities(deps: ClientTodayRailControllerDeps): Promise<void>;
      loadGarminReconcile(deps: ClientTodayRailControllerDeps): Promise<void>;
      wireGenericAgendaCards(
        pending: ClientTodayAgendaCandidate[],
        deps: ClientTodayRailControllerDeps,
      ): void;
    };

    CairnTodayRailLoaders: {
      loadFuelToday(date: string, deps: ClientTodayRailControllerDeps): Promise<void>;
      loadWeekAhead(deps: ClientTodayRailControllerDeps): Promise<void>;
      loadProgramAdjustmentsBanner(deps: ClientTodayRailControllerDeps): Promise<void>;
      loadRecentActivities(deps: ClientTodayRailControllerDeps): Promise<void>;
      loadGarminReconcile(deps: ClientTodayRailControllerDeps): Promise<void>;
    };

    CairnTodaySideLoaders: ClientTodaySideLoaders;

    CairnTodayPlanSelection: {
      planDayNumberForSession(
        session: ClientTodayPlanSelectionSession | null | undefined,
        plan: ClientTodayPlanSelectionDay[] | null | undefined,
      ): number | null;
      nextPlanDayNumber(
        dayNumber: number | null | undefined,
        plan: ClientTodayPlanSelectionDay[] | null | undefined,
      ): number | null;
      suggestedPlanDayNumber(
        session: ClientTodayPlanSelectionSession | null | undefined,
        isToday: boolean,
        deps: ClientTodayPlanSelectionDeps,
      ): Promise<number>;
    };

    CairnTodayPlanSessionModel: {
      planItems(day: (Record<string, unknown> & { items?: Array<Record<string, unknown>> | null }) | null | undefined): Array<Record<string, unknown>>;
      groupLoggedSets(session: { sets?: Array<Record<string, unknown> & { exercise?: string; set_number?: number | null }> | null } | null | undefined): Record<string, Array<Record<string, unknown>>>;
      selectedPlanDay(
        state: {
          day: number | null;
          plan: Array<Record<string, unknown> & { day_number: number; items?: Array<Record<string, unknown>> | null }>;
        },
        revealBlank: boolean,
      ): Record<string, unknown> & { day_number: number; items?: Array<Record<string, unknown>> | null };
      matchCardioEfforts(
        items: Array<Record<string, unknown>>,
        efforts: Array<Record<string, unknown>>,
        matches: (item: Record<string, unknown>, effort: Record<string, unknown> | null | undefined) => boolean,
      ): Map<Record<string, unknown>, Record<string, unknown>>;
      itemGroups(params: {
        items: Array<Record<string, unknown>>;
        loggedByEx: Record<string, Array<Record<string, unknown>>>;
        matchedCardio: Map<Record<string, unknown>, Record<string, unknown>>;
        skips: unknown[];
        isCardioItem(item: Record<string, unknown>): boolean;
        cardioLabel(item: Record<string, unknown>): string;
      }): {
        planNames: Set<string>;
        activeItems: Array<Record<string, unknown>>;
        skippedItems: Array<Record<string, unknown>>;
        cardioItems: Array<Record<string, unknown>>;
        strengthItems: Array<Record<string, unknown>>;
        planEx: string[];
        offPlanEx: string[];
      };
      prunePendingOffPlan(
        state: {
          logDate: string;
          pendingOffPlan?: Record<string, Array<{ name: string; mode?: string | null }>>;
        },
        planNames: Set<string>,
        loggedByEx: Record<string, Array<Record<string, unknown>>>,
      ): Array<{ name: string; mode?: string | null }>;
      prefillFor(
        item: Record<string, unknown>,
        loggedByEx: Record<string, Array<Record<string, unknown>>>,
        lastSets: Record<string, Record<string, unknown> | null>,
      ): Record<string, unknown>;
    };

    CairnTodayPlanSessionData: {
      loadLastSets(
        names: string[],
        loggedByEx: Record<string, Array<Record<string, unknown> & { exercise?: string; set_number?: number | null }>>,
        deps: {
          state: { logDate: string };
          cachedApi<T = unknown>(path: string, options?: { key?: string; freshFor?: number }): Promise<T>;
          peekCached<T = unknown>(key: string, freshFor?: number): { data: T; fresh: boolean } | null;
        },
      ): Promise<Record<string, Record<string, unknown> | null>>;
      loadPrescriptions(
        day: number | null,
        planEx: string[],
        deps: { cachedApi<T = unknown>(path: string, options?: { key?: string; freshFor?: number }): Promise<T> },
      ): Promise<Record<string, unknown>>;
      loadCardioContext(
        dayItems: Array<Record<string, unknown>>,
        isToday: boolean,
        deps: {
          state: { logDate: string };
          api(path: string): Promise<unknown>;
          isCardioItem(item: Record<string, unknown>): boolean;
        },
      ): Promise<{
        allCardio: Array<Record<string, unknown>>;
        cardioEfforts: Array<Record<string, unknown>>;
        todaySettings: unknown;
      }>;
    };

    CairnTodayPlanSessionPreparation: {
      groupLoggedSets(session: { sets?: Array<Record<string, unknown> & { exercise?: string; set_number?: number | null }> | null } | null | undefined): Record<string, Array<Record<string, unknown>>>;
      matchCardioEfforts(
        items: Array<Record<string, unknown>>,
        efforts: Array<Record<string, unknown>>,
        matches: (item: Record<string, unknown>, effort: Record<string, unknown> | null | undefined) => boolean,
      ): Map<Record<string, unknown>, Record<string, unknown>>;
      preparePlanSession(deps: {
        state: {
          logDate: string;
          day: number | null;
          dayPicked?: boolean;
          plan: Array<Record<string, unknown> & { day_number: number; items?: Array<Record<string, unknown>> | null }>;
          planReveal?: { date: string; on: boolean; blank?: boolean } | null;
          pendingOffPlan?: Record<string, Array<{ name: string; mode?: string | null }>>;
        };
        session: Record<string, unknown> | null | undefined;
        isToday: boolean;
        api(path: string): Promise<unknown>;
        cachedApi<T = unknown>(path: string, options?: { key?: string; freshFor?: number }): Promise<T>;
        peekCached<T = unknown>(key: string, freshFor?: number): { data: T; fresh: boolean } | null;
        suggestedPlanDayNumber(session: Record<string, unknown> | null | undefined, isToday: boolean): Promise<number>;
        isCardioItem(item: Record<string, unknown>): boolean;
        cardioLabel(item: Record<string, unknown>): string;
        cardioEffortMatches(item: Record<string, unknown>, effort: Record<string, unknown> | null | undefined): boolean;
      }): Promise<Record<string, unknown> & {
        day: Record<string, unknown>;
        loggedByEx: Record<string, Array<Record<string, unknown>>>;
        cardioEfforts: Array<Record<string, unknown>>;
        matchedCardio: Map<Record<string, unknown>, Record<string, unknown>>;
        activeItems: Array<Record<string, unknown>>;
        skippedItems: Array<Record<string, unknown>>;
        cardioItems: Array<Record<string, unknown>>;
        strengthItems: Array<Record<string, unknown>>;
        planEx: string[];
        offPlanEx: string[];
        pendingOffPlan: Array<{ name: string; mode?: string | null }>;
        lastSets: Record<string, Record<string, unknown> | null>;
        rxByEx: Record<string, unknown>;
        rxFor(name: unknown): unknown;
        prefillFor(item: Record<string, unknown>): Record<string, unknown>;
        exDone: number;
        exTotal: number;
        hasSyncedCardioToday: boolean;
        isRunDay: boolean;
        expectingRun: boolean;
      }>;
    };

    CairnTodayDataLoader: {
      load(
        opts: { soft?: unknown } | null | undefined,
        deps: {
          root: HTMLElement;
          state: { logDate: string; plan: unknown[]; tab?: string };
          api(path: string): Promise<unknown>;
          cachedApi(path: string, options?: { key?: string; freshFor?: number; onUpgrade?: (data: unknown, meta: { changed: boolean }) => void }): Promise<unknown>;
          peekCached<T = unknown>(key: string, freshFor?: number): { data: T; fresh: boolean } | null;
          storeCached(key: string, data: unknown): void;
          localISO(date?: Date): string;
          todaySkeleton(): string;
          setTodayHeaderTitle(): void;
          nextPollToken(): number;
        },
      ): Promise<{
        soft: boolean;
        token: number;
        isToday: boolean;
        session: unknown;
        stats: unknown;
        profile: unknown;
        exercises: unknown;
        revalidations: Array<Promise<unknown>>;
        changed(): boolean;
      }>;
      scheduleSoftRepaint(
        result: {
          token: number;
          revalidations: Array<Promise<unknown>>;
          changed(): boolean;
        },
        deps: {
          root: HTMLElement;
          state: { tab?: string };
          isCurrentPoll(token: number): boolean;
          renderToday(opts?: { soft?: boolean }): unknown;
        },
      ): void;
    };

    CairnTodayMainShell: {
      leadHtml(
        options: {
          isToday: boolean;
          briefHtml: string;
          conductorHtml: string;
          conductorLeads: boolean;
          goalLineHtml: string;
          currentWeight: unknown;
        },
        deps: {
          escapeHtml(value: unknown): string;
          micGlyph: string;
        },
      ): string;
      weekFoldHtml(
        compass: { paceOfferHtml?: string; weekRecap?: string | null; cellsHtml?: string },
        deps: { escapeHtml(value: unknown): string },
      ): string;
      wrapHtml(content: string, options: { railHtml: string }): string;
    };

    CairnTodayPlanSurface: {
      sessionHeadHtml(
        options: {
          isRunDay: boolean;
          isToday: boolean;
          cardioItems: Array<Record<string, unknown>>;
          day: Record<string, unknown> | null | undefined;
          exDone: number;
          exTotal: number;
          hasSyncedCardioToday: boolean;
        },
        deps: {
          escapeHtml(value: unknown): string;
          escapeAttr(value: unknown): string;
          stagger(index?: number | null): string;
          cardioLabel(item: Record<string, unknown>): string;
          cardioPrescription(item: Record<string, unknown>): string;
          rxMoveCount(rxByEx: Record<string, unknown>): number;
          setsTonnage(sets: unknown): number;
          lastSetLineText?(lastSet: unknown): string;
        },
      ): string;
      daySwitchHtml(
        plan: Array<Record<string, unknown>>,
        activeDay: unknown,
        deps: { escapeHtml(value: unknown): string },
      ): string;
      rxBannerHtml(
        rxByEx: Record<string, unknown>,
        day: unknown,
        deps: {
          escapeAttr(value: unknown): string;
          escapeHtml(value: unknown): string;
          rxMoveCount(rxByEx: Record<string, unknown>): number;
          stagger(index?: number | null): string;
        },
      ): string;
      addExerciseFormHtml(): string;
      finishHtml(
        session: { sets?: unknown[] | null; notes?: unknown },
        options: { isToday: boolean; logDate: string },
        deps: { escapeAttr(value: unknown): string; setsTonnage(sets: unknown): number },
      ): string;
      lastSetLineHtml(
        lastSet: unknown,
        deps: { escapeHtml(value: unknown): string; lastSetLineText?(lastSet: unknown): string },
      ): string;
    };

    CairnTodayPlanSurfaceRenderer: {
      buildHtml(
        options: {
          showDone: boolean;
          showPlan: boolean;
          focus: boolean;
          session: Record<string, unknown> | null | undefined;
          day: Record<string, unknown>;
          isToday: boolean;
          plan: Array<Record<string, unknown>>;
          activeDay: unknown;
          logDate: string;
          cardioItems: Array<Record<string, unknown>>;
          strengthItems: Array<Record<string, unknown>>;
          activeItems: Array<Record<string, unknown>>;
          skippedItems: Array<Record<string, unknown>>;
          matchedCardio: Map<Record<string, unknown>, unknown>;
          syncedLine: string;
          loggedByEx: Record<string, unknown[]>;
          offPlanEx: string[];
          pendingOffPlan: Array<{ name: string; mode?: string | null }>;
          lastSets: Record<string, Record<string, unknown> | null | undefined>;
          rxByEx: Record<string, unknown>;
          exDone: number;
          exTotal: number;
          hasSyncedCardioToday: boolean;
          hasLoggedSets: boolean;
          hasGarmin: boolean;
          isRunDay: boolean;
          prefillFor(item: Record<string, unknown>): { weight?: unknown; reps?: unknown; rir?: unknown; duration_sec?: unknown };
          rxFor(name: unknown): unknown;
        },
        deps: {
          planSurface: Window["CairnTodayPlanSurface"];
          planSurfaceDeps(): Parameters<Window["CairnTodayPlanSurface"]["sessionHeadHtml"]>[1];
          isCardioItem(item: Record<string, unknown>): boolean;
          cardioLabel(item: Record<string, unknown>): string;
          cardioPlanCard(item: Record<string, unknown>, index: number, matched?: unknown, syncLine?: string): string;
          exCard(item: Record<string, unknown>, logged: unknown[], prefill: Record<string, unknown>, index: number, rx: unknown): string;
          garminSessionCard(value: unknown): string;
          sessionDoneCard(session: unknown, day: unknown, options: { isToday: boolean }): string;
          skipLineHtml(labels: string[]): string;
        },
      ): string;
    };

    CairnTodayPostRenderWiring: {
      wirePostRender(deps: {
        root: HTMLElement;
        state: {
          logDate: string;
          day: number | null;
          dayPicked?: boolean;
          chatPrefill?: string | null;
        };
        read: { _provisional?: boolean } | null | undefined;
        isToday: boolean;
        showPlan: boolean;
        soft: boolean;
        conductorLeads: boolean;
        agenda: Partial<ClientTodayAgenda> | null | undefined;
        agendaGeneric: ClientTodayAgendaCandidate[];
        todayCompass: { paceOffer?: { ask?: string | null } | null };
        updateHeaderCondense(): void;
        runCountUps(root?: ParentNode | null, options?: { snap?: boolean }): void;
        quickLog(): unknown;
        reducedMotion(): boolean;
        wireCardioSync(root: ParentNode, onSync: () => unknown): unknown;
        renderToday(opts?: Record<string, unknown>): unknown;
        applyDayProgression(button: Element | null | undefined, day: number | null | undefined): unknown;
        wireBrief(read: { _provisional?: boolean } | null | undefined, options: { isToday: boolean }): unknown;
        upgradeBriefInPlace(date: string, isToday: boolean): unknown;
        loadTrainingProvenance(isToday: boolean): unknown;
        loadTableHint(): unknown;
        setupWeightChip(): unknown;
        setupVoiceCapture(): unknown;
        loadFrequentFoods(): unknown;
        loadContextBanner(): unknown;
        loadHealthFocusBanner(): unknown;
        loadWearable(isToday: boolean): unknown;
        loadCheckin(): unknown;
        runAgendaRail(
          agenda: Partial<ClientTodayAgenda> | null | undefined,
          genericPending: ClientTodayAgendaCandidate[],
          deps: ClientTodayRailControllerDeps,
        ): void;
        runFallbackRail(isToday: boolean, deps: ClientTodayRailControllerDeps): void;
        todayRailDeps(): ClientTodayRailControllerDeps;
        activateTab(tab: string): unknown;
        withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
        viewEnter(): void;
        localISO(): string;
      }): void;
    };

    CairnTodayDependencies: ClientTodayDependenciesApi;
    CairnTodayCompatibilityBridges: ClientTodayCompatibilityBridgesApi;
    CairnTodayScreenRuntimeDeps: ClientTodayScreenRuntimeDepsApi;
    CairnTodayScreenRuntime: ClientTodayScreenRuntimeApi;

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

    CairnTodayProgressionController: {
      scheduleRxRefresh(deps: {
        state: { tab?: string; day?: string | number | null; logDate?: string };
        root: ParentNode;
        cachedApi(path: string, options?: { key?: string; freshFor?: number }): Promise<unknown>;
        invalidate(keyOrPrefix: string): void;
        exRxLineHtml(rx: unknown): string;
        moveCount(rxByEx: Record<string, unknown>): number;
        loadProgramAdjustmentsBanner(): unknown;
      }): void;
      invalidateTodayProgression(deps: Parameters<Window["CairnTodayProgressionController"]["scheduleRxRefresh"]>[0]): void;
      refreshAdaptedRx(deps: Parameters<Window["CairnTodayProgressionController"]["scheduleRxRefresh"]>[0]): Promise<void>;
    };

    CairnTodayAddExerciseController: {
      setupAddExercise(deps: {
        root: Element;
        state: {
          logDate: string;
          exModes?: Record<string, string>;
          pendingOffPlan?: Record<string, Array<{ name: string; mode?: string | null }>>;
        };
        api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
        postExerciseMode(name: string, mode: string): Promise<unknown>;
        exCard(item: Record<string, unknown>, logged: Array<Record<string, unknown>>, prefill: Record<string, unknown>, revealIdx: unknown, rx: unknown, lastSet?: unknown): string;
        wireGuides(card: Element): void;
        wireLogRow(row: Element | null): void;
        wireSkips(): void;
        toast(message: string): void;
        escapeHtml(value: unknown): string;
        escapeAttr(value: unknown): string;
        parseDur(value: string): number | null;
      }): Promise<void>;
      appendOffPlanCard(name: string, mode: string | null | undefined, deps: Parameters<Window["CairnTodayAddExerciseController"]["setupAddExercise"]>[0]): Promise<void>;
    };

    CairnTodaySessionFeedback: {
      renderFeedback(
        slot: Element | null | undefined,
        session: Record<string, unknown>,
        deps: ClientTodaySessionFeedbackDeps,
      ): void;
    };

    CairnTodaySessionSkip: {
      wireSkips(deps: ClientTodaySessionSkipDeps): void;
    };

    CairnTodaySessionSetModel: ClientTodaySessionSetModelApi;
    CairnTodaySessionSetActions: ClientTodaySessionSetActionsApi;

    CairnTodaySessionController: {
      renderFeedback(
        slot: Element | null | undefined,
        session: Record<string, unknown>,
        deps: ClientTodaySessionControllerDeps,
      ): void;
      wireDeletes(deps: ClientTodaySessionControllerDeps): void;
      wireLogRow(row: Element | null | undefined, deps: ClientTodaySessionControllerDeps): void;
      wireSessionSurface(options: ClientTodaySessionSurfaceOptions, deps: ClientTodaySessionControllerDeps): void;
      wireSkips(deps: ClientTodaySessionControllerDeps): void;
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
        lastSet?: unknown,
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
      briefHtml(read: (Partial<ClientDayRead> & { _provisional?: unknown; _failed?: unknown; override?: unknown }) | null | undefined, options?: {
        showPlan?: boolean;
        showDone?: boolean;
        isToday?: boolean;
        activeOverride?: unknown;
        morph?: boolean;
        reducedMotion?: boolean;
        offlineDismissed?: boolean;
      }): string;
      materiallyDiffers(
        a: (Partial<ClientDayRead> & { _provisional?: unknown }) | null | undefined,
        b: (Partial<ClientDayRead> & { _provisional?: unknown }) | null | undefined,
      ): boolean;
      signalsText(read: Partial<ClientDayRead> | null | undefined): string;
    };

    CairnTodayBriefOverrideClient: {
      paintBriefReshaping(brief: Element, chip: HTMLElement | null, deps: ClientTodayBriefOverrideDeps): void;
      dayReadOverrideOpOpts(args: { intent?: string; prevFocus?: unknown } | undefined, deps: ClientTodayBriefOverrideDeps): ClientTodayBriefOverrideRunOptions;
      reconnectDayReadOverride(job: unknown, deps: ClientTodayBriefOverrideDeps): ClientAgentOpHandlers | null;
    };

    CairnTodayBriefActionsClient: {
      offlineDismissed(): boolean;
      wireBriefActions(
        read: Partial<ClientDayRead> & { _provisional?: unknown; override?: unknown },
        options: { isToday?: boolean },
        deps: ClientTodayBriefActionsDeps,
      ): void;
    };

    CairnTodayBriefController: {
      provisionalRead(date: string): ClientDayRead & { _provisional: boolean };
      loadBrief(
        date: string,
        override: string,
        deps: ClientTodayBriefControllerDeps,
        opts?: { fast?: boolean },
      ): Promise<ClientDayRead & { _provisional?: boolean; _failed?: boolean; override?: string | null }>;
      upgradeBriefInPlace(date: string, isToday: boolean, deps: ClientTodayBriefControllerDeps): Promise<void>;
      reshapeToday(deps: ClientTodayBriefControllerDeps): Promise<void>;
      briefHtml(
        read: (Partial<ClientDayRead> & { _provisional?: unknown; _failed?: unknown; override?: unknown }) | null | undefined,
        options: { showPlan?: unknown; showDone?: unknown; isToday?: unknown },
        deps: ClientTodayBriefControllerDeps,
      ): string;
      briefSignalsText(read: Partial<ClientDayRead> | null | undefined): string;
      wireBrief(
        read: Partial<ClientDayRead> & { _provisional?: unknown; override?: unknown },
        options: { isToday?: boolean },
        deps: ClientTodayBriefControllerDeps,
      ): void;
      paintBriefReshaping(brief: Element, chip: HTMLElement | null, deps: ClientTodayBriefControllerDeps): void;
      dayReadOverrideOpOpts(args: { intent?: string; prevFocus?: unknown } | undefined, deps: ClientTodayBriefControllerDeps): ClientAgentOpHandlers;
      reconnectDayReadOverride(job: unknown, deps: ClientTodayBriefControllerDeps): ClientAgentOpHandlers | null;
    };

    CairnCaptureProvenance: {
      activeDirectives(): Promise<ClientDirective[]>;
      provenanceLineHtml(directive: (ClientDirective & { citation?: unknown; directive?: unknown; uncertain?: unknown }) | null | undefined, label: string): string | null;
      wireProvenance(scope?: ParentNode | null): void;
      loadTrainingProvenance(isToday?: boolean): Promise<void>;
      loadMealProvenance(): Promise<void>;
    };

    CairnCaptureReadDate: CaptureReadDateApi;
    CairnCaptureReadCards: CaptureReadCardsApi;
    CairnCaptureReadJobs: CaptureReadJobsApi;
    CairnCaptureReads: CaptureReadsRuntime;

    CairnCaptureVoice: {
      micGlyph: string;
      setup(deps: { root: ParentNode; quickLog(): Promise<void> }): void;
    };

    CairnTodaySessionSuggest: {
      SESSION_VIBES: string[];
      itemHtml(item: Partial<ClientSessionSuggestion["items"][number]> | null | undefined, index?: number): string;
      cardHtml(session: Partial<ClientSessionSuggestion> | null | undefined, verified?: unknown): string;
      loadingHtml(): string;
      failureHtml(result?: unknown): string;
      composerHtml(vibes?: readonly string[]): string;
    };

    CairnTodaySessionSuggestController: {
      askForSession(
        opts: { minutes?: unknown; focus?: unknown; equipment?: unknown; constraints?: unknown } | undefined,
        deps: {
          root: ParentNode;
          state: { logDate?: string; suggestedSession?: ClientSessionSuggestion | null };
          runOp(kind: "session_suggest", body: Record<string, unknown>, options: ClientAgentOpHandlers): Promise<unknown>;
          thinkingCaption(el: Element, op?: string | readonly string[]): () => void;
          runCountUps(scope?: ParentNode | null, options?: { snap?: boolean }): void;
          collapseEl(el: Element, done?: () => void): void;
          reducedMotion(): boolean;
          toast(message: string): void;
          revealPlanThen(after: () => unknown, opts?: { blank?: boolean }): unknown;
          appendOffPlanCard(name: unknown, mode: "timed" | "reps"): unknown;
        },
      ): Promise<void>;
      reconnectSessionSuggest(job: unknown, deps: Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[1]): unknown;
      revealSessionComposer(deps: Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[1]): void;
      sessionSuggestOpOpts(deps: Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[1]): ClientAgentOpHandlers;
      wireSuggestCard(slot: Element, deps: Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[1]): void;
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

    CairnTodayWeekAhead: {
      WEEK_AHEAD_GLYPH: Record<ClientWeekAheadDayKind, string>;
      kind(value: unknown): ClientWeekAheadDayKind;
      days(value: unknown): ClientWeekAheadDay[];
      rowHtml(day: unknown): string;
      cardHtml(read: unknown): string;
    };

    CairnTodayContext: {
      CONTEXT_ICONS: Record<string, string>;
      CONTEXT_NEAR_DAYS: number;
      daysUntil(startISO: unknown, todayISO?: string): number | null;
      eventCountdown(days: unknown): string;
      isNearTermContext(event: unknown, todayISO?: string): boolean;
      contextBannerLine(event: unknown, todayISO?: string): string;
      contextBannerHtml(events: unknown, todayISO?: string): string;
      goalLineHtml(stats: unknown, currentWeight: unknown, isToday: unknown, todayISO?: string): string;
      healthFocusLine(data: unknown): string;
      healthFocusBannerHtml(data: unknown): string;
    };

    CairnTodayCompass: {
      fmtPace(value: unknown): string;
      paceWord(stats: unknown): string;
      paceTileHtml(stats: unknown, deps: {
        escapeHtml(value: unknown): string;
        escapeAttr(value: unknown): string;
        formatKm(value: unknown): string;
      }): string;
      paceOffer(stats: unknown, currentWeight: unknown): { status: string; line: string; ask: string } | null;
      paceOfferHtml(offer: { status: string; line: string; ask: string } | null, deps: {
        escapeHtml(value: unknown): string;
        escapeAttr(value: unknown): string;
        formatKm(value: unknown): string;
      }): string;
      build(stats: unknown, deps: {
        escapeHtml(value: unknown): string;
        escapeAttr(value: unknown): string;
        formatKm(value: unknown): string;
      }, options?: {
        currentWeight?: unknown;
        isToday?: unknown;
        isEndurance?: unknown;
        isHybrid?: unknown;
      }): {
        planned: number;
        done: number;
        weekKm: number;
        cellsHtml: string;
        paceOfferHtml: string;
        paceOffer: { status: string; line: string; ask: string } | null;
        weekRecap: string;
      };
    };

    CairnTodayGarminReconciliation: {
      load(options: {
        root: ParentNode | null | undefined;
        date: string;
        isCurrentToday: () => boolean;
        api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
        escapeHtml(value: unknown): string;
        toast(message: string): void;
        invalidate(key: string): void;
        refreshToday(options: { soft: boolean }): unknown;
      }): Promise<void>;
    };
  }

  declare const CairnChatClient: Window["CairnChatClient"];
  declare const CairnChatHeaderController: Window["CairnChatHeaderController"];
  declare const CairnChatAttachment: Window["CairnChatAttachment"];
  declare const CairnChatComposerFocus: Window["CairnChatComposerFocus"];
  declare const CairnChatComposerController: Window["CairnChatComposerController"];
  declare const CairnChatTurnRecords: Window["CairnChatTurnRecords"];
  declare const CairnChatTurnStreamState: Window["CairnChatTurnStreamState"];
  declare const CairnChatLayout: Window["CairnChatLayout"];
  declare const CairnChatStarterChips: Window["CairnChatStarterChips"];
  declare const CairnChatFuelContext: Window["CairnChatFuelContext"];
  declare const CairnChatEarlierHistory: Window["CairnChatEarlierHistory"];
  declare const CairnExerciseDetail: Window["CairnExerciseDetail"];
  declare const CairnExerciseDetailData: Window["CairnExerciseDetailData"];
  declare const CairnExerciseDetailExplanation: Window["CairnExerciseDetailExplanation"];
  declare const CairnExerciseDetailRender: Window["CairnExerciseDetailRender"];
  declare const CairnExerciseDetailActions: Window["CairnExerciseDetailActions"];
  declare const CairnExerciseDetailController: Window["CairnExerciseDetailController"];
  declare const CairnUi: Window["CairnUi"];
  declare const CairnUiReads: Window["CairnUiReads"];
  declare const CairnUiFeedback: Window["CairnUiFeedback"];
  declare const CairnUiActions: Window["CairnUiActions"];
  declare const CairnUiHeader: Window["CairnUiHeader"];
  declare const CairnUiViewTransitions: Window["CairnUiViewTransitions"];
  declare const CairnDetailOverlay: Window["CairnDetailOverlay"];
  declare const CairnUiMotion: Window["CairnUiMotion"];
  declare const CairnHealthEvidence: Window["CairnHealthEvidence"];
  declare const CairnHealthMarkerOrder: Window["CairnHealthMarkerOrder"];
  declare const CairnHealthClient: Window["CairnHealthClient"];
  declare const CairnHealthPicture: Window["CairnHealthPicture"];
  declare const CairnHealthPictureController: Window["CairnHealthPictureController"];
  declare const CairnHealthMarkers: Window["CairnHealthMarkers"];
  declare const CairnHealthMarkersController: Window["CairnHealthMarkersController"];
  declare const CairnHealthDirectives: Window["CairnHealthDirectives"];
  declare const CairnHealthDirectiveLoader: Window["CairnHealthDirectiveLoader"];
  declare const CairnHealthStanding: Window["CairnHealthStanding"];
  declare const CairnHealthStandingPrimitives: Window["CairnHealthStandingPrimitives"];
  declare const CairnHealthStandingController: Window["CairnHealthStandingController"];
  declare const CairnHealthRisk: Window["CairnHealthRisk"];
  declare const CairnHealthRiskController: Window["CairnHealthRiskController"];
  declare const CairnHealthRead: Window["CairnHealthRead"];
  declare const CairnHealthReadSynthesis: Window["CairnHealthReadSynthesis"];
  declare const CairnHealthReadSupplements: Window["CairnHealthReadSupplements"];
  declare const CairnHealthReadController: Window["CairnHealthReadController"];
  declare const CairnFoodNote: Window["CairnFoodNote"];
  declare const CairnMeHealthLogRenderer: Window["CairnMeHealthLogRenderer"];
  declare const CairnMeHealthDependencies: Window["CairnMeHealthDependencies"];
  declare const CairnMeHealthTabsController: Window["CairnMeHealthTabsController"];
  declare const CairnFoodDetailController: Window["CairnFoodDetailController"];
  declare const CairnMeProfileForm: Window["CairnMeProfileForm"];
  declare const CairnMeProfileController: Window["CairnMeProfileController"];
  declare const CairnPlanEnduranceModel: Window["CairnPlanEnduranceModel"];
  declare const CairnPlanEndurance: Window["CairnPlanEndurance"];
  declare const CairnPlanEditor: Window["CairnPlanEditor"];
  declare const CairnPlanEditorForm: Window["CairnPlanEditorForm"];
  declare const CairnPlanEditorController: Window["CairnPlanEditorController"];
  declare const CairnDayFuel: Window["CairnDayFuel"];
  declare const CairnDayFuelController: Window["CairnDayFuelController"];
  declare const CairnMealRows: Window["CairnMealRows"];
  declare const mealSlotFor: Window["mealSlotFor"];
  declare const mealRowHtml: Window["mealRowHtml"];
  declare const mealDayHtml: Window["mealDayHtml"];
  declare const CairnMealPlan: Window["CairnMealPlan"];
  declare const CairnMealPlannerJobs: Window["CairnMealPlannerJobs"];
  declare const CairnMealPlannerActions: Window["CairnMealPlannerActions"];
  declare const CairnMealPlannerController: Window["CairnMealPlannerController"];
  declare const CairnCoachProposalController: Window["CairnCoachProposalController"];
  declare const CairnMealSwapData: Window["CairnMealSwapData"];
  declare const CairnMealSwapController: Window["CairnMealSwapController"];
  declare const CairnMealRecipe: Window["CairnMealRecipe"];
  declare const CairnMealRecipeController: Window["CairnMealRecipeController"];
  declare const CairnProposal: Window["CairnProposal"];
  declare const CairnHealthLearned: Window["CairnHealthLearned"];
  declare const CairnMemory: Window["CairnMemory"];
  declare const CairnMeMemoryController: Window["CairnMeMemoryController"];
  declare const CairnFamily: Window["CairnFamily"];
  declare const CairnFamilyController: Window["CairnFamilyController"];
  declare const CairnLife: Window["CairnLife"];
  declare const CairnLifeFormHelpers: Window["CairnLifeFormHelpers"];
  declare const CairnLifeTimelineActions: Window["CairnLifeTimelineActions"];
  declare const CairnLifeController: Window["CairnLifeController"];
  declare const CairnHealthDocs: Window["CairnHealthDocs"];
  declare const CairnHealthRecords: Window["CairnHealthRecords"];
  declare const CairnHealthRecordsController: Window["CairnHealthRecordsController"];
  declare const CairnHealthDocUploadController: Window["CairnHealthDocUploadController"];
  declare const CairnHealthDocDateActions: Window["CairnHealthDocDateActions"];
  declare const CairnHealthDocLifecycleActions: Window["CairnHealthDocLifecycleActions"];
  declare const CairnHealthDocActionsController: Window["CairnHealthDocActionsController"];
  declare const CairnHealthShareController: Window["CairnHealthShareController"];
  declare const CairnSettingsClient: Window["CairnSettingsClient"];
  declare const CairnSettingsSurface: Window["CairnSettingsSurface"];
  declare const CairnSettingsData: Window["CairnSettingsData"];
  declare const CairnSettingsDataController: Window["CairnSettingsDataController"];
  declare const CairnSettingsSourcesAutomationController: Window["CairnSettingsSourcesAutomationController"];
  declare const CairnSettingsAgents: Window["CairnSettingsAgents"];
  declare const CairnSettingsAgentsController: Window["CairnSettingsAgentsController"];
  declare const CairnMarkdown: Window["CairnMarkdown"];
  declare const CairnPwaInstall: Window["CairnPwaInstall"];
  declare const CairnRestTimer: Window["CairnRestTimer"];
  declare const CairnTodayBrief: Window["CairnTodayBrief"];
  declare const CairnTodayBriefOverrideClient: Window["CairnTodayBriefOverrideClient"];
  declare const CairnTodayBriefActionsClient: Window["CairnTodayBriefActionsClient"];
  declare const CairnTodayBriefController: Window["CairnTodayBriefController"];
  declare const CairnCaptureProvenance: Window["CairnCaptureProvenance"];
  declare const CairnCaptureReadDate: Window["CairnCaptureReadDate"];
  declare const CairnCaptureReadCards: Window["CairnCaptureReadCards"];
  declare const CairnCaptureReadJobs: Window["CairnCaptureReadJobs"];
  declare const CairnCaptureReads: Window["CairnCaptureReads"];
  declare const CairnCaptureVoice: Window["CairnCaptureVoice"];
  declare const CairnTodaySessionSuggest: Window["CairnTodaySessionSuggest"];
  declare const CairnTodaySessionSuggestController: Window["CairnTodaySessionSuggestController"];
  declare const CairnProgressData: Window["CairnProgressData"];
  declare const CairnProgressComponents: Window["CairnProgressComponents"];
  declare const CairnProgressLineChartModel: Window["CairnProgressLineChartModel"];
  declare const CairnProgressChartScrub: Window["CairnProgressChartScrub"];
  declare const CairnProgressChartDrawing: Window["CairnProgressChartDrawing"];
  declare const CairnProgressChart: Window["CairnProgressChart"];
  declare const CairnProgressTrendWeight: Window["CairnProgressTrendWeight"];
  declare const CairnProgressHistoryModel: Window["CairnProgressHistoryModel"];
  declare const CairnProgressHistoryRender: Window["CairnProgressHistoryRender"];
  declare const CairnProgressHistory: Window["CairnProgressHistory"];
  declare const CairnProgressRunPlan: Window["CairnProgressRunPlan"];
  declare const CairnProgressVolume: Window["CairnProgressVolume"];
  declare const CairnProgressEnergy: Window["CairnProgressEnergy"];
  declare const CairnProgressEnergySurface: Window["CairnProgressEnergySurface"];
  declare const CairnProgressCalendar: Window["CairnProgressCalendar"];
  declare const CairnProgressMuscleTrajectory: Window["CairnProgressMuscleTrajectory"];
  declare const CairnProgressDexaTargeting: Window["CairnProgressDexaTargeting"];
  declare const CairnProgressPerformance: Window["CairnProgressPerformance"];
  declare const CairnProgressFocus: Window["CairnProgressFocus"];
  declare const CairnProgressProgramAdjustments: Window["CairnProgressProgramAdjustments"];
  declare const CairnProgressTestWeek: Window["CairnProgressTestWeek"];
  declare const CairnProgressProgramSummary: Window["CairnProgressProgramSummary"];
  declare const CairnProgressProgramBlock: Window["CairnProgressProgramBlock"];
  declare const CairnProgressProgramController: Window["CairnProgressProgramController"];
  declare const CairnProgressJourney: Window["CairnProgressJourney"];
  declare const CairnProgressRouteDeps: Window["CairnProgressRouteDeps"];
  declare const CairnCoachingFocus: Window["CairnCoachingFocus"];
  declare const CairnCardioPlan: Window["CairnCardioPlan"];
  declare const CairnCardioSync: Window["CairnCardioSync"];
  declare const CairnProgressEndurance: Window["CairnProgressEndurance"];
  declare const CairnProgressEnduranceController: Window["CairnProgressEnduranceController"];
  declare const CairnTodayActivity: Window["CairnTodayActivity"];
  declare const CairnTodayAgenda: Window["CairnTodayAgenda"];
  declare const CairnTodayRailController: Window["CairnTodayRailController"];
  declare const CairnTodayRailLoaders: Window["CairnTodayRailLoaders"];
  declare const CairnTodaySideLoaders: Window["CairnTodaySideLoaders"];
  declare const CairnTodayPlanSelection: Window["CairnTodayPlanSelection"];
  declare const CairnTodayPlanSessionModel: Window["CairnTodayPlanSessionModel"];
  declare const CairnTodayPlanSessionData: Window["CairnTodayPlanSessionData"];
  declare const CairnTodayPlanSessionPreparation: Window["CairnTodayPlanSessionPreparation"];
  declare const CairnTodayDataLoader: Window["CairnTodayDataLoader"];
  declare const CairnTodayMainShell: Window["CairnTodayMainShell"];
  declare const CairnTodayPlanSurface: Window["CairnTodayPlanSurface"];
  declare const CairnTodayPlanSurfaceRenderer: Window["CairnTodayPlanSurfaceRenderer"];
  declare const CairnTodayPostRenderWiring: Window["CairnTodayPostRenderWiring"];
  declare const CairnTodayDependencies: Window["CairnTodayDependencies"];
  declare const CairnTodayCompatibilityBridges: Window["CairnTodayCompatibilityBridges"];
  declare const CairnTodayScreenRuntimeDeps: Window["CairnTodayScreenRuntimeDeps"];
  declare const CairnTodayScreenRuntime: Window["CairnTodayScreenRuntime"];
  declare const CairnTodayTraining: Window["CairnTodayTraining"];
  declare const CairnTodayProgressionController: Window["CairnTodayProgressionController"];
  declare const CairnTodayAddExerciseController: Window["CairnTodayAddExerciseController"];
  declare const CairnTodaySessionFeedback: Window["CairnTodaySessionFeedback"];
  declare const CairnTodaySessionSkip: Window["CairnTodaySessionSkip"];
  declare const CairnTodaySessionSetModel: Window["CairnTodaySessionSetModel"];
  declare const CairnTodaySessionSetActions: Window["CairnTodaySessionSetActions"];
  declare const CairnTodaySessionController: Window["CairnTodaySessionController"];
  declare const CairnTodayCards: Window["CairnTodayCards"];
  declare const CairnTodayLately: Window["CairnTodayLately"];
  declare const CairnTodaySessionStatus: Window["CairnTodaySessionStatus"];
  declare const CairnTodayProgramAdjustments: Window["CairnTodayProgramAdjustments"];
  declare const CairnTodayWeekAhead: Window["CairnTodayWeekAhead"];
  declare const CairnTodayContext: Window["CairnTodayContext"];
  declare const CairnTodayCompass: Window["CairnTodayCompass"];
  declare const CairnTodayGarminReconciliation: Window["CairnTodayGarminReconciliation"];
}
