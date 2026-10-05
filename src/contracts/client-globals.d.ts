import type {
  ClientActivity,
  ClientDayRead,
  ClientDirective,
  ClientChatMessage,
  ClientChatSearchHit,
  ClientChatSessionSummary,
  ClientHealthSection as ContractClientHealthSection,
  ClientHomeName as ContractClientHomeName,
  ClientHorizonSection as ContractClientHorizonSection,
  ClientYouSection as ContractClientYouSection,
  ClientMeSection as ContractClientMeSection,
  ClientPlanSection as ContractClientPlanSection,
  ClientProgressSection as ContractClientProgressSection,
  ClientApiResponse,
  ClientCoachingFocus,
  ClientCoachingFocusItem,
  ClientRoute,
  ClientRoutesApi,
  ClientSettingsSection as ContractClientSettingsSection,
  ClientStandSection as ContractClientStandSection,
  ClientTabName as ContractClientTabName,
  ClientPrescription,
  ClientTodayAgenda,
  ClientTodayAgendaCandidate,
  ClientTodayAttention,
  ClientLearnedItem,
  ClientLearnedKind,
  ClientLearnedTimeline,
  ClientBeliefsView,
  ClientNextCheckup,
  ClientMemory,
  ClientMemoryKind,
} from "./client.js";
import type {
  ClientBloodPressureReading,
  ClientCardiovascularRisk,
  ClientEnduranceGoal,
  ClientFlexibleTrainingAgenda,
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
  ClientRaceBuild,
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
  type ClientHomeName = ContractClientHomeName;
  type ClientHorizonSection = ContractClientHorizonSection;
  type ClientYouSection = ContractClientYouSection;
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
    measuredSilhouette(
      sex: string,
      tape: Partial<Record<string, number | null>> | null,
      heightIn: number
    ): {
      torso: string;
      armR: string;
      armL: string;
      scales: Record<string, number>;
      ref: Record<string, number>;
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
    sets30: number;
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
    /** A meal-plan week's state in the athlete's words ("to look over", "kept"…). */
    planBadge(status: unknown): string;
    planWeekLabel(plan: unknown): string;
    IDEAS_ASK: string;
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
    api(
      path: string,
      opts?: RequestInit & { headers?: Record<string, string>; acceptErrorBody?: boolean }
    ): Promise<unknown>;
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
      sessionIdsByDate?: Record<string, string>;
      pendingOffPlan?: Record<string, Array<{ name: string; mode?: string | null }>>;
    };
    api(
      path: string,
      opts?: RequestInit & { headers?: Record<string, string>; acceptErrorBody?: boolean }
    ): Promise<unknown>;
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
    hstandLevelWord(percentile: unknown): string;
    hstandMeasureHtml(measure: ClientHealthStandingMeasure | null | undefined): string;
    hstandCompHtml(comparison: ClientHealthStandingComparison, sexWord: string, calendarAge: unknown): string;
    hstandRefSummaryHtml(
      comparisons: ClientHealthStandingComparison[] | null | undefined,
      referenceAge: unknown,
      actualDecade: number | null,
      sexWord: string
    ): string;
    hstandDimensionHtml(dimension: ClientHealthStandingDimension, index: number): string;
    hstandBpRows(rows: ClientBloodPressureReading[] | null | undefined): string;
    hstandBodyCompHtml(bodyComp: ClientHealthStandingBodyComp | null | undefined): string;
    hstandBpCardHtml(bp: ClientHealthStandingBloodPressure | null | undefined): string;
  };

  type ClientTodaySessionFeedbackDeps = Pick<
    ClientTodaySessionControllerDeps,
    "api" | "sessionStatus" | "state" | "toast"
  >;
  type ClientTodaySessionSkipDeps = Pick<
    ClientTodaySessionControllerDeps,
    "api" | "collapseEl" | "expandEl" | "invalidate" | "renderToday" | "root" | "sessionStatus" | "state" | "toast"
  >;
  type ClientTodaySessionSetPayloadResult =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; message: string; focus?: () => void };
  type ClientTodaySessionSetModelApi = {
    responseRecord(value: unknown): Record<string, unknown>;
    rememberMutationSessionId(
      deps: Pick<ClientTodaySessionControllerDeps, "state">,
      date: string,
      value: unknown
    ): string | null;
    rememberFullSessionId(
      deps: Pick<ClientTodaySessionControllerDeps, "state">,
      date: string,
      value: unknown
    ): string | null;
    sessionPathId(
      session: Record<string, unknown>,
      deps: Pick<ClientTodaySessionControllerDeps, "state">,
      date: string
    ): string | null;
    cacheSessionTruth(deps: ClientTodaySessionControllerDeps, date: string, value: unknown): boolean;
    invalidateSessionTruth(deps: ClientTodaySessionControllerDeps): void;
    invalidateSetTruth(deps: ClientTodaySessionControllerDeps): void;
    logPayloadFromRow(row: HTMLElement, deps: ClientTodaySessionControllerDeps): ClientTodaySessionSetPayloadResult;
    lastSetScore(weight: unknown, reps: unknown, durationSec: unknown): number;
    lastSetLineText(
      lastSet: unknown,
      deps: { fmtDur(seconds: number): string },
      opts?: { perSide?: boolean }
    ): string;
    currentSetScoreFromRow(row: HTMLElement, deps: Pick<ClientTodaySessionControllerDeps, "parseDur">): number | null;
    wireLastSetLine(
      row: Element | null | undefined,
      lastSet: unknown,
      deps: Pick<ClientTodaySessionControllerDeps, "parseDur">
    ): void;
  };
  // What one repaint of a logging surface must NOT cost the athlete: the values
  // typed into each card's log row, and the caret sitting in one of them.
  // Untouched prefills are stored as null so a later adapted Rx is not overwritten.
  type ClientTodayExDraftSnapshot = {
    drafts: Map<string, Array<string | null>>;
    focus: { key: string; index: number; start: number | null; end: number | null } | null;
  };

  type ClientTodaySessionSetActionsApi = {
    wireDeletes(deps: ClientTodaySessionControllerDeps): void;
    wireLogRow(row: Element | null | undefined, deps: ClientTodaySessionControllerDeps): void;
    refreshFinishStat(deps: ClientTodaySessionControllerDeps, options?: { repaint?: boolean }): boolean;
    captureExDrafts(root: ParentNode | null | undefined): ClientTodayExDraftSnapshot | null;
    restoreExDrafts(root: ParentNode | null | undefined, snapshot: ClientTodayExDraftSnapshot | null): void;
    reprojectPendingSets(deps: ClientTodaySessionControllerDeps): void;
  };

  type ClientTodayBriefControllerDeps = {
    root: HTMLElement;
    state: Pick<
      ClientAppState,
      "tab" | "logDate" | "brief" | "_briefInflight" | "_briefMorph" | "plan" | "planReveal" | "progressSeg"
    > & {
      day?: number | null;
      dayPicked?: boolean;
      // Set by today-screen.ts's renderToday alongside its own briefHtml call, so
      // a later same-kind repaint (upgradeBriefInPlace) can reuse the exact
      // launch-card witness instead of re-deriving it from the DOM.
      nothingToStart?: boolean;
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
    askForSession(opts?: { minutes?: unknown; focus?: unknown; constraints?: unknown; autoUse?: boolean }): unknown;
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
    askForSession(opts?: { minutes?: unknown; focus?: unknown; constraints?: unknown; autoUse?: boolean }): unknown;
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
      planJump?: string | null;
      dayPicked?: boolean;
    };
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    renderToday(opts?: Record<string, unknown>): unknown;
    withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
    runOp(kind: "day_read_override", body: Record<string, unknown>, options: ClientAgentOpHandlers): Promise<unknown>;
    reducedMotion(): boolean;
    collapseEl(el: Element, done?: () => void): void;
    activateTab(tab: string): unknown;
    toast(message: string): void;
    escapeHtml(value: unknown): string;
    revealPlanThen(after: () => unknown, opts?: { blank?: boolean }): unknown;
    revealSessionComposer(): unknown;
    askForSession(opts?: { minutes?: unknown; focus?: unknown; constraints?: unknown; autoUse?: boolean }): unknown;
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
      standSeg?: string | null;
      progressSeg?: string | null;
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
  };

  type ClientTodayDependenciesContextInput = {
    root: HTMLElement;
    state: ClientTodayScreenRuntimeState;
    api(
      path: string,
      opts?: RequestInit & { headers?: Record<string, string>; acceptErrorBody?: boolean }
    ): Promise<unknown>;
    cachedApi(path: string, options?: CachedApiOptions<unknown>): Promise<unknown>;
    peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
    storeCached(key: string, data: unknown): void;
    invalidate(keyOrPrefix: string): void;
    renderToday(opts?: Record<string, unknown>): unknown;
    withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
    runOp(
      kind: "day_read_override" | "session_suggest" | string,
      body: Record<string, unknown>,
      options: ClientAgentOpHandlers
    ): Promise<unknown>;
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
    exCard(item: any, logged: any[], prefill: Record<string, unknown>, index: any, rx: any): string;
    garminSessionCard(value: unknown): string;
    sessionDoneCard(session: unknown, day: unknown, options: { isToday: boolean }): string;
    setsTonnage(sets: unknown): number;
    rxMoveCount(rxByEx: Record<string, unknown>): number;
    exRxLineHtml(rx: unknown, options?: { supporting?: boolean }): string;
    loadTrainingProvenance(isToday?: boolean): unknown;
    revealPlanThen(after: () => unknown, opts?: { blank?: boolean }): unknown;
    revealSessionComposer(): unknown;
    askForSession(opts?: { minutes?: unknown; focus?: unknown; equipment?: unknown; constraints?: unknown; autoUse?: boolean }): unknown;
    thinkingCaption(el: Element | null | undefined, op: unknown): () => void;
    appendOffPlanCard(name: any, mode: any): unknown;
    gotoChatWith(text: string): unknown;
    loadTodayReads(): unknown;
    todaySkeleton(): string;
    setTodayHeaderTitle(): void;
    nextPollToken(): number;
    isCurrentPoll(token: number): boolean;
    suggestedPlanDayNumber(session: any, isToday: boolean): Promise<number | null>;
    updateHeaderCondense(): void;
    wireCardioSync(root: ParentNode, onSync: () => unknown): unknown;
    applyDayProgression(button: Element | null | undefined, day: number | null | undefined): unknown;
    wireBrief(read: { _provisional?: boolean } | null | undefined, options: { isToday: boolean }): unknown;
    upgradeBriefInPlace(date: string, isToday: boolean): unknown;
    loadTableHint(): unknown;
    setupWeightChip(): unknown;
    loadContextBanner(): unknown;
    loadHealthFocusBanner(): unknown;
    loadWearable(isToday: boolean): unknown;
    loadCheckin(): unknown;
    loadTagChips(): unknown;
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
    planSession(
      session: unknown,
      isToday: boolean,
      primed?: { primedLastSets?: string[]; primedProgressionDay?: number | null; strengthJourney?: unknown }
    ): any;
    postRender(
      input: ClientTodayDependenciesPostRenderInput
    ): Parameters<Window["CairnTodayPostRenderWiring"]["wirePostRender"]>[0];
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
      api(
        path: string,
        opts?: RequestInit & { headers?: Record<string, string>; acceptErrorBody?: boolean }
      ): Promise<unknown>;
      dependencies(): ClientTodayDependenciesContext;
    }): ClientTodayCompatibilityBridgesContext;
  };
  type ClientTodayScreenRuntimeState = ClientAppState &
    Record<string, unknown> & {
      day: number | null;
      exModes: Record<string, string>;
      logDate: string;
      planJump?: string;
      planReveal?: { date: string; on: boolean; blank?: boolean };
    };
  type ClientTodayScreenRuntimeContext = ClientTodayCompatibilityBridgesContext & {
    api<Path extends string>(
      path: Path,
      opts?: RequestInit & { headers?: Record<string, string>; acceptErrorBody?: boolean }
    ): Promise<ClientApiResponse<Path>>;
    cachedApi<Path extends string>(
      path: Path,
      opts?: CachedApiOptions<ClientApiResponse<Path>>
    ): Promise<ClientApiResponse<Path>>;
    peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
    deps(): ClientTodayDependenciesContext;
    planSurfaceRendererDeps(): ReturnType<ClientTodayDependenciesContext["planSurfaceRenderer"]>;
    mainShellDeps(): ReturnType<ClientTodayDependenciesContext["mainShell"]>;
    exRxLineHtml(rx: Partial<ClientPrescription> | null | undefined, options?: { supporting?: boolean }): string;
    rxMoveCount(rxByEx: Record<string, Partial<ClientPrescription> | null | undefined>): number;
    applyDayProgression(button: Element | null | undefined, day: number | null | undefined): Promise<void>;
    exerciseCard(item: any, logged: any[], prefill: Record<string, unknown>, index: any, rx: any): string;
    suggestedPlanDayNumber(session: any, isToday: boolean): Promise<number | null>;
    loadBrief(
      date: string,
      override: string,
      opts?: { fast?: boolean }
    ): Promise<ClientDayRead & { _provisional?: boolean; _failed?: boolean; override?: string | null }>;
    upgradeBriefInPlace(date: string, isToday: boolean): Promise<void>;
    reshapeToday(): Promise<void>;
    refreshBriefInPlace(): Promise<void>;
    briefHtml(
      read:
        | (Partial<ClientDayRead> & { _provisional?: unknown; _failed?: unknown; override?: unknown })
        | null
        | undefined,
      options: { showPlan?: unknown; showDone?: unknown; isToday?: unknown; nothingToStart?: unknown }
    ): string;
    briefSignalsText(read: Partial<ClientDayRead> | null | undefined): string;
    revealPlanThen(after: (() => unknown) | null | undefined, opts?: { blank?: boolean }): void;
  };
  type ClientTodayScreenRuntimeDepsApi = {
    create(input: {
      root: HTMLElement;
      state: ClientTodayScreenRuntimeState;
      api<Path extends string>(
        path: Path,
        opts?: RequestInit & { headers?: Record<string, string>; acceptErrorBody?: boolean }
      ): Promise<ClientApiResponse<Path>>;
      cachedApi<Path extends string>(
        path: Path,
        opts?: CachedApiOptions<ClientApiResponse<Path>>
      ): Promise<ClientApiResponse<Path>>;
      peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
      renderToday(): Promise<unknown> | unknown;
      micGlyph(): string;
      bridge(): ClientTodayCompatibilityBridgesContext;
      exRxLineHtml(rx: Partial<ClientPrescription> | null | undefined, options?: { supporting?: boolean }): string;
      rxMoveCount(rxByEx: Record<string, Partial<ClientPrescription> | null | undefined>): number;
      applyDayProgression(button: Element | null | undefined, day: number | null | undefined): Promise<void>;
      exerciseCard(item: any, logged: any[], prefill: Record<string, unknown>, index: any, rx: any): string;
      suggestedPlanDayNumber(session: any, isToday: boolean): Promise<number | null>;
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

  // What the day pills know about each programmed day before it is tapped: the
  // areas still working through recent training, and whether that is most of what
  // the day trains. Server-owned; the pill only reads it, and never disables.
  type ClientTodayPlanDayRecovery = {
    recovering_groups: string[];
    mostly_recovering: boolean;
  };
  type ClientTodayPlanDayRecoveryMap = Record<number, ClientTodayPlanDayRecovery>;

  type ClientHealthPictureCache = {
    review?: Record<string, unknown> | null;
    docCount?: number;
    newestDocAt?: string | null;
  };

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
      | "garmin_export_strength"
      | "enrich_enabled"
      | "art_enabled"
      | "research_enabled"
      | "meal_plan_auto_draft"
      | "gemini_api_key"
      | "lead_mode"
      | "training_drive"
    >;
    settings: Record<string, unknown>;
    data: SettingsScreenData;
    artSpendHtml: string;
    garminStatusLine(settings: unknown, syncing: boolean): string;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    authToken?: () => string;
    locationOrigin?: string;
    setTimeout?: typeof setTimeout;
    openUrl?: (url: string) => void;
  };

  type ClientSettingsAgentsControllerWorkingModel = {
    agent_strategy: string;
    order: string[];
    disabled: Set<string>;
    routes: Record<string, string>;
    chat_routing_mode: "adaptive" | "single";
    chat_profile_bindings: Record<string, Record<string, Record<string, unknown>>>;
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
    /** Settings > Agents: one quiet line for where the agent layer stands NOW. */
    agentStateHtml?: string;
    dayNames: string[];
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    sleep(ms: number): Promise<void>;
    stagger?(index: number): string;
    markDirty(): void;
    pruneRoutes?(
      routes: Record<string, string>,
      routeTasks: readonly ClientSettingsRouteTask[],
      enabledAgents: readonly ClientSettingsAgentsControllerAgent[]
    ): Record<string, string>;
    routeRowsHtml?(
      routeTasks: readonly ClientSettingsRouteTask[],
      enabledAgents: readonly ClientSettingsAgentsControllerAgent[],
      routes: Record<string, string>
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
    hero(
      title: string,
      stats: Array<readonly [unknown, unknown] | readonly [unknown, unknown, { text?: boolean; k?: boolean }]>,
      voice?: { line?: unknown; fact?: unknown; meta?: unknown } | null
    ): string;
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
      options?: PaintSwrOptions<ClientApiResponse<Path>> & { path?: Path }
    ): Promise<ClientApiResponse<Path> | undefined>;
    segmentHtml(active: ClientProgressSection): string;
    skeletonHtml(active: ClientProgressSection, cards?: number): string;
    wireSegments(): void;
    hero(
      title: string,
      stats: Array<readonly [unknown, unknown] | readonly [unknown, unknown, { text?: boolean; k?: boolean }]>,
      voice?: { line?: unknown; fact?: unknown; meta?: unknown } | null
    ): string;
    /** A count as a voice line speaks it ("Fifteen"). */
    countWord(n: unknown, lead?: boolean): string;
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
      deps?: { stagger?(index?: number | null): string }
    ): string;
    phaseSummary(read: ClientJourneyRead | null | undefined, milestones?: unknown): string;
    wire(root?: ParentNode): void;
  };

  type ClientJourneyTimelineApi = {
    timelineCardHtml(
      entries: ClientForwardTimelineEntry[] | unknown,
      deps?: { stagger?(index?: number | null): string }
    ): string;
    nextLabel(entries: ClientForwardTimelineEntry[] | unknown): string;
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
      }
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
      }
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
    // A KEY into THINKING_SCRIPTS, never the lines themselves (see AgentRunOptions).
    caption?: string;
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
    routeKey(
      key: unknown,
      items: ReadonlyArray<string | readonly [string, unknown]>,
      fallback?: string | null
    ): string | null;
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
      }
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

  declare function skelSwap(fn: () => void): void;
  declare function escHtml(value: unknown): string;
  declare function escAttr(value: unknown): string;
  declare function relTime(iso: string): string;
  declare function relAge(iso: string): string;
  declare function absDate(iso: string): string;
  declare function shortDate(iso: string): string;
  declare function humanDate(iso: string): string;
  declare function humanizeReviewText(text: string, latestISO: string | null | undefined): string;
  declare function latestReviewDate(parsed: unknown): string | null;
  declare function learnedTimelineHtml(data: ClientLearnedTimeline | null | undefined): string;
  declare function checkupHtml(data: ClientNextCheckup | null | undefined): string;
  declare function foodNum(value: unknown): number | null;
  declare function formatFoodNum(value: unknown): string;
  declare function fmtWeight(weight: unknown): string;
  declare function parseDur(text: unknown): number | null;
  declare function fmtDur(sec: unknown): string;
  declare function fmtPaceKm(minPerKm: unknown): string;
  declare function fmtKm(km: unknown): string;
  declare function runUnits(value: unknown): "km" | "mi";
  declare function fmtRunUnitSuffix(units?: unknown): string;
  declare function fmtDist(km: unknown, units?: unknown): string;
  declare function fmtPaceFromSecPerKm(secPerKm: unknown, units?: unknown): string;
  declare function fmtPaceBand(
    band: { slow_sec_per_km?: unknown; fast_sec_per_km?: unknown; text?: unknown } | null | undefined,
    units?: unknown
  ): string;
  declare function fmtSpeedKmh(kmh: unknown): string;
  declare function prDistLabel(km: unknown): string;
  declare function joinList(items: string[]): string;
  declare function authToken(): string;
  declare function withToken(url: string): string;
  declare function downloadFile(href: string): void;
  declare function deviceTimeZone(): string;
  declare function localISO(date?: Date): string;
  declare function dateLabel(iso: string): string;
  declare function pickDayVariant<T>(variants: readonly T[], date?: string, key?: string): T;
  // `swr` opts an idempotent GET into stale-while-revalidate (api-core.ts): a
  // remembered body (≤ maxStaleMs, no write since) resolves immediately and the
  // background refresh is handed to `onStale`.
  type ClientApiSwrOptions = {
    maxStaleMs?: number;
    freshMs?: number;
    onStale?: (refresh: Promise<unknown>) => void;
  };
  declare function api<Path extends string>(
    p: Path,
    opts?: RequestInit & {
      headers?: Record<string, string>;
      acceptErrorBody?: boolean;
      swr?: boolean | ClientApiSwrOptions;
    }
  ): Promise<ClientApiResponse<Path>>;
  // Binary reads (DICOM frames): the same token/time-zone headers as api(), no cache.
  declare function apiBinary(p: string, opts?: RequestInit): Promise<{ body: ArrayBuffer; headers: Headers }>;
  declare function setOffline(on: unknown): void;
  // Prime the request layer from a fan-in whose body maps path -> that path's body.
  declare function apiPrime(paths: readonly string[], source: Promise<unknown>, ttlMs?: number): void;
  // Forget every remembered API body on this device (a 401, a new token).
  declare function clearRememberedApiBodies(): void;
  // Drop api()'s own micro/stale tier (api-core.ts) — a write that landed elsewhere.
  declare function apiInvalidate(): void;
  // Moves on every write (local or apiInvalidate): a fan-in reuse guard keys on it, so
  // a repaint after a write primes afresh instead of riding primes the write cleared.
  declare function apiWriteGeneration(): number;

  // Offline outbox — a durable localStorage queue that replays failed capture /
  // set-log POSTs when Cairn is reachable again (see outbox-queue.ts / outbox.ts).
  type ClientOutboxItem = {
    id: string;
    ts: number;
    kind: string;
    path: string;
    method?: "POST" | "DELETE";
    body: unknown;
    session_date?: string;
    state?: "pending" | "sending" | "prepared" | "needs_attention";
    in_flight_until?: number;
    claim_token?: string;
    failure_status?: number;
    depends_on?: string;
    group_id?: string;
    prepare_intent?: Record<string, unknown>;
    retry_body?: Record<string, unknown>;
    retry_intent?: Record<string, unknown>;
  };
  type ClientOutboxEnqueueOptions = {
    dependsOn?: string | null;
    groupId?: string | null;
    sessionDate?: string | null;
    method?: "POST" | "DELETE";
    prepareIntent?: Record<string, unknown> | null;
    retryBody?: Record<string, unknown> | null;
    retryIntent?: Record<string, unknown> | null;
  };
  type ClientOutboxReviewEntry = { item: ClientOutboxItem; role: "attention" | "blocked_dependent" };
  type ClientOutboxController = {
    enqueue(entry: {
      kind: string;
      path: string;
      method?: "POST" | "DELETE";
      body: unknown;
      session_date?: string;
      depends_on?: string;
      group_id?: string;
      prepare_intent?: Record<string, unknown>;
      retry_body?: Record<string, unknown>;
      retry_intent?: Record<string, unknown>;
    }): ClientOutboxItem | null;
    list(): ClientOutboxItem[];
    review(): ClientOutboxReviewEntry[];
    count(): number;
    retry(id: string): boolean;
    remove(id: string): boolean;
    hasDependents(id: string): boolean;
    clear(): void;
    drain(send: (item: ClientOutboxItem) => Promise<unknown>): Promise<{
      sent: number;
      remaining: number;
      needsAttention: number;
    }>;
  };
  type ClientOutboxApi = {
    createOutbox(opts: {
      storage: Pick<Storage, "getItem" | "setItem">;
      now?: () => number;
      key?: string;
      max?: number;
    }): ClientOutboxController;
    enqueue(
      kind: string,
      path: string,
      body: unknown,
      options?: ClientOutboxEnqueueOptions,
    ): Promise<ClientOutboxItem | null>;
    flush(): Promise<void>;
    count(): number;
    list(): ClientOutboxItem[];
    reviewItems(): ClientOutboxReviewEntry[];
    renderBar(): void;
    openReview(): void;
    closeReview(): void;
    itemSummary(item: ClientOutboxItem): string;
    retry(id: string): Promise<boolean>;
    discard(id: string): Promise<boolean>;
    sessionDependency(date: string): string | null;
    sessionGroupId(
      date: string,
      identity?: { dailySessionId?: unknown; sessionId?: unknown },
    ): string;
    runSessionMutation(
      input: ClientOutboxSessionMutationInput,
      send: (idempotencyKey: string) => Promise<unknown>,
    ): Promise<ClientOutboxSessionMutationResult>;
    sessionPrerequisite(date: string): {
      status: "none" | "ready" | "blocked";
      id: string | null;
      reason?: "attention" | "other_tab" | "phantom";
    };
    resolveSessionPrerequisite(date: string): void;
  };
  declare const CairnOutbox: ClientOutboxApi;
  declare function outboxEnqueue(
    kind: string,
    path: string,
    body: unknown,
    options?: ClientOutboxEnqueueOptions,
  ): Promise<ClientOutboxItem | null>;
  declare function outboxSessionDependency(date: string): string | null;
  declare function outboxSessionGroupId(
    date: string,
    identity?: { dailySessionId?: unknown; sessionId?: unknown },
  ): string;
  declare function outboxSessionPrerequisite(
    date: string,
  ): {
    status: "none" | "ready" | "blocked";
    id: string | null;
    reason?: "attention" | "other_tab" | "phantom";
  };
  declare function outboxResolveSessionPrerequisite(date: string): void;
  declare function outboxBlockSessionPrerequisite(date: string): void;
  type ClientOutboxSessionMutationInput = {
    date: string;
    kind: string;
    path: string;
    body: unknown;
    method?: "POST" | "DELETE";
    identity?: { dailySessionId?: unknown; sessionId?: unknown };
  };
  type ClientOutboxSessionMutationResult =
    | { status: "sent"; value: unknown; groupId: string }
    | { status: "queued"; item: ClientOutboxItem; groupId: string }
    | {
        status: "blocked";
        reason: "attention" | "other_tab" | "phantom";
        prerequisiteId: string | null;
        groupId: string;
      }
    | { status: "storage_error"; groupId: string }
    | { status: "failed"; error: unknown; groupId: string };
  declare function runSessionMutation(
    input: ClientOutboxSessionMutationInput,
    send: (idempotencyKey: string) => Promise<unknown>,
  ): Promise<ClientOutboxSessionMutationResult>;
  declare function flushOutbox(): Promise<void>;
  declare function outboxCount(): number;

  // api() in-flight dedupe + micro-TTL cache + stale-while-revalidate tier — the
  // pure core api-core.ts builds on, also exercised directly by tests (see
  // api-cache.ts).
  type ClientApiCoalescer = {
    isMicroCachePath(path: string): boolean;
    peekFresh<T = unknown>(path: string): T | undefined;
    store<T = unknown>(path: string, data: T, writeGen?: number): void;
    invalidateAll(): void;
    markStaleable(path: string): void;
    peekStale<T = unknown>(path: string, maxAgeMs: number): { data: T; age: number } | undefined;
    writeGeneration(): number;
    staleSize(): number;
    share<T>(path: string, start: () => Promise<T>): Promise<T>;
    inFlightCount(): number;
    cacheSize(): number;
    prime(paths: readonly string[], source: Promise<unknown>, ttlMs?: number): void;
    primed(path: string): Promise<{ hit: true; data: unknown } | { hit: false; error?: unknown }> | undefined;
    primedSize(): number;
  };
  type ClientApiCallOptions = RequestInit & {
    headers?: Record<string, string>;
    acceptErrorBody?: boolean;
    swr?: boolean | ClientApiSwrOptions;
  };
  type ClientApiCacheApi = {
    createApiCoalescer(opts?: {
      now?: () => number;
      ttlMs?: number;
      ttlPaths?: readonly string[];
      maxStaleEntries?: number;
    }): ClientApiCoalescer;
    shouldBypassApiCache(opts: ClientApiCallOptions): boolean;
    shouldArmGetTimeout(method: string, opts: ClientApiCallOptions): boolean;
    MICRO_TTL_MS: number;
    MICRO_CACHE_PATHS: readonly string[];
    PRIME_TTL_MS: number;
    GET_TIMEOUT_MS: number;
    ApiError: typeof CairnApiError;
    isTransientApiFailure(error: unknown): boolean;
    normalizeRoute(path: string): string;
    diagnosticRoute(path: string): string;
    resolveSwr(
      option: ClientApiCallOptions["swr"],
    ): { maxStaleMs: number; freshMs: number; onStale?: (refresh: Promise<unknown>) => void } | null;
    untilAborted<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T>;
  };
  declare const CairnApiCache: ClientApiCacheApi;
  // Reachability the request layer remembers across requests (api-reach.ts).
  type ClientApiReachApi = {
    createReachMemo(opts?: { now?: () => number; windowMs?: number }): {
      remember(path: string): void;
      recent(path: string): boolean;
      clear(): void;
    };
    isFetchFailure(error: unknown): boolean;
    takeEarlyResponse(path: string): Promise<Response> | undefined;
  };
  declare const CairnApiReach: ClientApiReachApi;
  // You -> Health's screen fan-in (health-fan-in-client.ts): one GET /you-health primes a leaf's reads.
  declare const CairnHealthFanIn: { prime(seg: unknown): void; leafOf(seg: unknown): string };
  // Train's screen fan-in (train-fan-in-client.ts): one GET /train-home primes a view's reads.
  declare const CairnTrainFanIn: {
    prime(view: "overview" | "program" | "endurance" | "goal", paths?: readonly string[]): void;
    pathsFor(view: "overview" | "program" | "endurance" | "goal", date: string): string[];
  };
  // Every api() failure: `kind` says whether Cairn answered (http, invalid_json)
  // or could not be reached (network, timeout). See api-cache.ts.
  class CairnApiError extends Error {
    kind: "http" | "invalid_json" | "network" | "timeout";
    method: string;
    route: string;
    status: number | null;
    durationMs: number;
    requestId: string | null;
    constructor(options: {
      kind: "http" | "invalid_json" | "network" | "timeout";
      method: string;
      route: string;
      status?: number | null;
      durationMs?: number;
      requestId?: string | null;
      cause?: unknown;
    });
  }

  type SwrPeek<T> = { data: T; fresh: boolean };
  type SwrUpgradeMeta = { changed: boolean };
  type CachedApiOptions<T> = {
    key?: string;
    freshFor?: number;
    serveFreshFor?: number;
    onUpgrade?: (data: T, meta: SwrUpgradeMeta) => void;
    project?: (data: T) => T;
  };
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
    serveFreshFor?: number;
    tab?: string | null;
  };
  declare function peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
  declare function cachedApi<Path extends string>(
    path: Path,
    options?: CachedApiOptions<ClientApiResponse<Path>>
  ): Promise<ClientApiResponse<Path>>;
  declare function paintSWR<Path extends string>(
    options?: PaintSwrOptions<ClientApiResponse<Path>> & { path?: Path }
  ): Promise<ClientApiResponse<Path> | undefined>;
  declare function swrSet<T = unknown>(key: string, data: T): void;
  declare function optimisticMutation<T = unknown, R = unknown>(
    options: OptimisticMutationOptions<T, R>
  ): Promise<R | undefined>;
  declare function markRefreshing(on: unknown): void;
  declare function swrInvalidate(keyOrPrefix: string): void;
  declare function swrClearAll(): void;
  declare function swrSweep(): void;
  declare function settledWithin(reads: Promise<unknown>[], ms: number): Promise<void>;
  declare const CairnPlanHead: {
    WAIT_MS: number;
    WARM_WAIT_MS: number;
    headRead(path: string): Promise<unknown>;
    headReads(): { week: Promise<unknown>; recovery: Promise<unknown>; upcoming: Promise<unknown> };
    recoveryBannerHtml(rs: import("./client-api.js").ClientRecoveryWeekStatus): string;
    loadRecoveryBanner(token: number, pending?: Promise<unknown>): void;
  };
  declare const CairnSessionSnapshot: {
    KEY: string;
    stamp(date: string, peek: (key: string) => { data: unknown } | null): string | null;
    save(
      store: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
      date: string,
      html: string,
      peek: (key: string) => { data: unknown } | null
    ): void;
    load(
      store: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
      date: string,
      peek: (key: string) => { data: unknown } | null
    ): string | null;
    storage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
    PRIMER_WAIT_MS: number;
    primerPath(date: string, dayNumber: number | null): string;
    markPainted(date: string): void;
    primerCarry(root: ParentNode, date: string): string;
    painted(root: ParentNode, date: string, carried: string): void;
    shellHtml(
      inner: string,
      meta: {
        fresh: boolean;
        kicker: string;
        dayName: string;
        dayFocus: string;
        why?: string;
        estimate?: number | null;
        exDone: number;
        exTotal: number;
        original?: string[];
        startDay?: { dayNumber: number; label: string } | null;
      }
    ): string;
  };
  declare function routeApi(): ClientRoutesApi | null;
  declare function routeKey(
    key: unknown,
    items: ReadonlyArray<string | readonly [string, unknown]>,
    fallback?: string | null
  ): string | null;
  declare function applyRouteState(route: ClientRoute | null | undefined): ClientTabName;
  declare function currentRouteState(): Partial<ClientRoute>;
  declare function activateTab(name: unknown, opts?: { replace?: boolean; syncRoute?: boolean }): void;
  declare function toast(message: string): void;
  declare function setupVoiceCapture(): void;
  declare function armDelete(btn: Element, onConfirm: () => unknown, options?: { label?: string }): void;
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
    options?: { dur?: number; fmt?: (value: number) => string }
  ): void;
  declare function isStandalonePWA(): boolean;
  declare function getInstallGuidance(): { mode: string } | null;
  declare function phoneCoachContent(mode: string): string;
  declare function renderPhoneCoachBanner(container: Element | null | undefined): void;
  declare function refreshPhoneCoach(): void;
  declare function fmtShortDate(iso: unknown): string;
  declare function progressHero(
    title: unknown,
    stats: Array<
      | readonly [unknown, unknown]
      | readonly [unknown, unknown, { text?: boolean; k?: boolean; unit?: string }]
      | null
      | undefined
      | false
    >,
    voice?: { line?: unknown; fact?: unknown; meta?: unknown } | null
  ): string;
  declare function progressCountWord(n: unknown, lead?: boolean): string;
  declare function emptyStateHtml(svg: string | null | undefined, line: unknown): string;
  declare function withAlpha(hex: unknown, alpha: number): string;
  declare function drawLineChart(
    canvas: HTMLCanvasElement | null | undefined,
    pts: Array<{ date: string; v: number }>,
    opts?: {
      goal?: number | null;
      fmt?: (value: number) => string;
      peak?: boolean;
    }
  ): void;
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
  declare function raceBuildCard(build: ClientRaceBuild | null | undefined, opts?: { underGoal?: boolean; legMap?: boolean; compact?: boolean; units?: unknown }): string;
  declare function trainingAgendaCard(agenda: ClientFlexibleTrainingAgenda | null | undefined): string;
  declare function enduranceGoalCard(goal: ClientEnduranceGoal | null | undefined, opts?: { units?: unknown }): string;
  declare function runComplianceLine(compliance: ClientRunCompliance | null | undefined): string;
  declare function enduranceCoachLine(
    plan: ClientWeeklyRunPlan | null | undefined,
    agenda?: ClientFlexibleTrainingAgenda | null
  ): string;
  declare function enduranceCalibrationLine(
    status: ClientCalibrationStatus | null | undefined,
    dateISO?: string
  ): string;
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
  declare function performanceHtml(
    performance: ClientPerformanceStanding | null | undefined,
    options?: { suppressLever?: boolean }
  ): string;
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
  declare function needsLookLifts(lifts: ClientProgramState["lifts"] | null | undefined): ClientProgramState["lifts"];
  declare function climbingLifts(lifts: ClientProgramState["lifts"] | null | undefined): ClientProgramState["lifts"];
  declare function familyGroups(
    lifts: ClientProgramState["lifts"] | null | undefined
  ): Array<{ key: string; label: string; lifts: ClientProgramState["lifts"] }>;
  declare function recencyLabel(iso: unknown): string;
  declare function compactLiftRowHtml(
    lift: ClientProgramState["lifts"][number] | null | undefined,
    index: number
  ): string;
  declare function variantRowHtml(lift: ClientProgramState["lifts"][number] | null | undefined, index: number): string;
  declare function familyGroupHtml(
    group: { key: string; label: string; lifts: ClientProgramState["lifts"] } | null | undefined,
    index: number
  ): string;
  declare function curatedLiftsHtml(lifts: ClientProgramState["lifts"] | null | undefined, startIndex?: number): string;
  declare function volumeBlockHtml(volume: ClientProgramState["volume"] | null | undefined, startIdx: number): string;
  declare function mesoBlockHtml(meso: ClientProgramState["mesocycle"] | null | undefined, index: number): string;
  declare function adaptationsHtml(adaptations: string[] | null | undefined, index: number): string;
  declare function blockFocusWord(focus: unknown): string;
  declare function activeBlockHtml(block: ClientProgramBlock | null | undefined): string;
  declare function startBlockHtml(): string;
  declare function loadProgramBlock(): Promise<void>;
  type ClientCoachingFocusVariant = "full" | "compact" | "hero" | "overview";
  type CoachingFocusRenderOptions = {
    variant?: ClientCoachingFocusVariant;
    // `full` only: false omits the block calendar line — the Program view already
    // owns block truth via its own "Current block · week N of M" card.
    blockLine?: boolean;
    // `full` only: render the [data-cfocus-act] buttons. Only Program wires them;
    // every navigate-only surface keeps the default so a button never renders dead.
    actions?: boolean;
    headline?: boolean; // `full` only: false = Train says the headline; this card is the plan beneath it
    // Inline style for the wrapper (the Progress overview's reveal stagger).
    style?: string;
  };
  type CfocusVariantSpec = {
    wrap: string;
    mastClass: string;
    // The masthead's own element. Block-level where the surface's label is a row
    // of its own (the Progress-overview well), inline where the class supplies it.
    mastTag: "span" | "div";
    headlineClass: string;
    headlineTag: "p" | "h2";
    // "option" honours options.blockLine; "domain" gates on the training family
    // (a lifting calendar under a lab lever would imply the lab work is
    // block-scoped volume work); "never" omits it.
    blockLine: "option" | "domain" | "never";
    // "route" = the navigable lead block with domain tag + arrow;
    // "flat" = title/why/move with no route chrome (the surface links out itself);
    // "line" = headline + one line only, no lead block at all.
    lead: "route" | "flat" | "line";
    leadWrap: string;
    leadTitleClass: string;
    leadWhyClass: string;
    // "" omits the Move line.
    moveClass: string;
    // The lead's title is required for this variant to render at all.
    requireTitle: boolean;
    fold?: boolean; // the flat lead's why, move and retest fold under one tap (Train overview)
    // Renders even when the server says the focus is not available (hero only).
    allowUnavailable: boolean;
    parallel: boolean;
    later: boolean;
    connections: boolean;
    retest: "card" | "line" | "never";
    footer: string;
  };
  type ExerciseMergeSuggestion = { from: string; into: string; why: string; confidence: string };
  type ExerciseRenameSuggestion = { id: number; from: string; into: string };
  declare function cfocusSwapButtonsHtml(item: ClientCoachingFocusItem): string;
  declare function cfocusText(value: unknown): string;
  declare function cfocusHeadlineWithoutLead(headline: string, title: string): string;
  declare function cfocusRouteLeadHtml(
    lead: ClientCoachingFocusItem,
    spec: CfocusVariantSpec,
    options: CoachingFocusRenderOptions,
    acts: boolean
  ): string;
  declare function cfocusFlatLeadHtml(
    lead: ClientCoachingFocusItem,
    spec: CfocusVariantSpec,
    after?: string
  ): string;
  declare function cfocusRetestHtml(focus: ClientCoachingFocus, spec: CfocusVariantSpec): string;
  declare function scheduledMealPlan(plan: unknown): Record<string, unknown> | null;
  declare function mealBoundaryLabel(value: unknown): string;
  declare function mealPlanUpcomingHtml(plan: unknown, current?: unknown): string;
  declare function mergeSuggestionsInnerHtml(
    pairs: ExerciseMergeSuggestion[],
    renames?: ExerciseRenameSuggestion[]
  ): string;
  declare function wireMergeSuggestions(
    slot: Element,
    pairs: ExerciseMergeSuggestion[],
    deps: ClientProgressProgramControllerDeps
  ): void;
  declare function wireRenameSuggestions(
    slot: Element,
    pairs: ExerciseRenameSuggestion[],
    deps: ClientProgressProgramControllerDeps
  ): void;
  declare function cfocusDomainTag(domain: unknown): string;
  declare function coachingFocusCardHtml(
    focus: ClientCoachingFocus | null | undefined,
    options?: { blockLine?: boolean; actions?: boolean; headline?: boolean }
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
    enabledAgents: readonly { name: string }[]
  ): Record<string, string>;
  declare function settingsRouteRowsHtml(
    routeTasks: readonly ClientSettingsRouteTask[],
    enabledAgents: readonly { name: string }[],
    routes: Record<string, string>
  ): string;
  declare function isCardioItem(item: unknown): boolean;
  declare function strengthPlanItems<T>(items: readonly T[] | null | undefined): T[];
  declare function isStrengthPlanDay(day: unknown): boolean;
  declare function strengthPlanDays<T extends { items?: unknown }>(plan: readonly T[] | null | undefined): T[];
  declare function cardioIntervalNote(interval: unknown): string;
  declare function cardioIntervalStructure(interval: unknown, targetZone: unknown): string;
  declare function cardioPrescription(item: Record<string, unknown> | null | undefined): string;
  declare function garminConfigured(settings: Record<string, unknown> | null | undefined): boolean;
  declare function cardioSyncLine(
    settings: Record<string, unknown> | null | undefined,
    opts?: { expectingRun?: unknown }
  ): string;
  declare function enduranceStatusWord(status: unknown): string;
  declare function enduranceBlockHtml(end: ClientProgramState["endurance"], idx: number): string;
  declare function paceTrendWord(trend: unknown): string;
  declare function zoneBarHtml(zones: unknown): string;
  declare function enduranceBestRows(
    group: ClientSportBests | null | undefined
  ): Array<{ label: string; val: string; date: string; type: string }>;
  declare function enduranceSportCardHtml(group: ClientSportBests | null | undefined, idx: number): string;
  declare function hybridLoadCardHtml(hybrid: ClientProgramState["hybrid"], idx?: number): string;
  declare const HR_ZONE_COLORS: string[] | undefined;
  declare function reshapeToday(): Promise<void>;
  declare function refreshTodayBrief(): Promise<void>;
  declare function setDiscipline(discipline: unknown): string;
  declare function setEnduranceGoalSet(present: unknown): boolean;
  declare function defaultProgressSeg(): string;
  declare function renderTab(tab: string): unknown;
  declare function renderToday(): unknown;
  /** Today is Home (v2 wave 7): open any day — today opens Today, another day its record or preview. */
  declare function openDay(date: unknown): void;
  /** Eager (day-open-client.ts): opening a day, and where it was opened from. */
  declare const CairnDayOpen: {
    openDay(date: unknown): void;
    origin(): { tab: ClientTabName; label: string } | null;
    takeOrigin(): { tab: ClientTabName; label: string } | null;
    /** "Train" — a home as its tab-bar button names it. */
    homeLabel(home: unknown): string;
  };
  /** LAZY "day" bundle (day-record-client.ts): reach only through withBundle("day"). */
  declare function renderDay(): Promise<void>;
  declare const CairnDayRecord: {
    dayHtml(record: import("./day-record.js").DayRecord, opts: { backLabel: string }): string;
    relativeWords(iso: string, today: string): string;
    shortDate(iso: string): string;
    renderDay(): Promise<void>;
  };
  declare function renderSession(opts?: Record<string, unknown>): unknown;
  declare function openSession(
    date?: string | null,
    options?: {
      source?: "adaptive_plan" | "agent_suggest" | "manual_plan" | "athlete_override";
      dayNumber?: number | null;
      replace?: boolean;
      agentJobId?: number | null;
      session?: ClientSessionSuggestion | null;
      constraints?: Record<string, unknown>;
      trigger?: HTMLElement | null;
      provenance?: Record<string, unknown>;
    }
  ): Promise<boolean>;
  declare function renderFoodJournal(options?: { history?: boolean }): unknown;
  declare function renderMeals(): unknown;
  declare function renderCoach(): unknown;
  declare function rerenderFoodSurface(): void;
  declare function repaintMealHistory(): Promise<unknown>;
  declare function loadTrainingProvenance(isToday?: boolean): unknown;
  declare function loadMealProvenance(): unknown;
  declare function paintEnergyBody(exp: unknown): void;
  declare function applyProposalById(id: string | number | undefined, btn?: Element | null): Promise<unknown>;
  declare function renderPlanEndurance(): unknown;
  declare function paintPlanEndurance(
    goalValue: ClientEnduranceGoal | null,
    compliance: ClientRunCompliance | null,
    agenda: ClientFlexibleTrainingAgenda | null,
    settings: Record<string, unknown> | null,
    raceBuild?: ClientRaceBuild | null,
    extra?: {
      runPlan?: ClientWeeklyRunPlan | null;
      nextAgenda?: ClientFlexibleTrainingAgenda | null;
      nextRunPlan?: ClientWeeklyRunPlan | null;
      nextRaceBuild?: ClientRaceBuild | null;
      today?: string;
    } | null
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
  declare function renderPlanEditor(): unknown;
  declare function loadPlanUpcomingNote(token: number, slotSel?: string, pending?: Promise<unknown>): void;
  declare function loadPlanWeekStrip(
    token: number,
    slotSel?: string,
    onWeek?: (week: import("./client-api.js").ClientPlanWeek) => void,
    pending?: Promise<unknown>
  ): void;
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
  declare function renderIntake(): unknown;
  declare const CairnProgressIntake: {
    intakeVoiceLine(progress: import("./client.js").ClientNutritionProgress): string;
    intakeBodyHtml(
      progress: import("./client.js").ClientNutritionProgress,
      selected?: import("./client.js").ClientNutritionProgressNutrient
    ): string;
    intakeChartHtml(
      progress: import("./client.js").ClientNutritionProgress,
      selected: import("./client.js").ClientNutritionProgressNutrient
    ): string;
    intakeFoodQualityHtml(progress: import("./client.js").ClientNutritionProgress): string;
    unavailableHtml(): string;
    render(
      root: Element,
      progress: import("./client.js").ClientNutritionProgress,
      selected?: import("./client.js").ClientNutritionProgressNutrient
    ): void;
  };
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
  declare function getHealthPictureCache(): {
    review?: Record<string, unknown> | null;
    docCount?: number;
    newestDocAt?: string | null;
  } | null;
  declare function setHealthPictureCache(
    cache: { review?: Record<string, unknown> | null; docCount?: number; newestDocAt?: string | null } | null
  ): { review?: Record<string, unknown> | null; docCount?: number; newestDocAt?: string | null } | null;
  declare function postExerciseMode(name: string, mode: string): Promise<unknown>;
  declare function updateHeaderCondense(): void;
  declare function switchTab(tab: unknown, opts?: { replace?: boolean; syncRoute?: boolean }): void;
  declare function registerTabBarHandlers(): void;
  declare function highlightHome(tab?: unknown): ClientHomeName;
  // The You and Horizon homes' landing renderers (you-screen.ts, horizon-screen.ts).
  declare function renderYou(): unknown;
  declare function renderHorizon(): unknown;
  declare function syncRouteFromState(mode?: "push" | "replace"): void;
  declare function todaySkeleton(): string;
  declare function segSkeleton(active: string, seg: readonly ClientSegment[], cards?: number): string;
  declare function skelLines(count?: number): string;
  declare function viewEnter(): void;
  declare function viewHydrate(): void;
  declare function tabSwap(fn: () => unknown): Promise<unknown>;
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
    explanation?: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null
  ): string;
  declare function replaceExerciseExplanation(
    el: ParentNode,
    exercise: { name?: unknown; muscle_group?: unknown } & Record<string, unknown>,
    explanation?: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null
  ): void;
  declare function openFoodDetail(note: unknown, fromTile?: Element | null): Promise<void>;
  declare function wireCardioSync(root: ParentNode, onDone?: () => unknown): void;
  declare function measureChatTop(): void;
  declare function ensureRestBar(): HTMLElement;
  declare function paintRest(): void;
  declare function startRest(seconds?: number): void;
  declare function stopRest(): void;
  declare function hideRestBar(): void;
  declare function surfaceRestBar(): void;
  declare function reconcileRest(): void;
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
    }
  ): Promise<(ClientActivity & Record<string, unknown>) | null>;
  declare function enrichmentActive(status: unknown): boolean;
  declare function healthKindLabel(kind: unknown): string;
  declare function parsedDoc(
    doc: unknown
  ): { markers?: Array<Record<string, unknown>>; clinical_facts?: unknown[]; type?: unknown } | null;
  declare function markerFlagClass(flag: unknown): string;
  declare function markersTable(parsed: unknown): string;
  declare function docCollapsible(doc: unknown): boolean;
  declare function healthDocInner(doc: unknown): string;
  declare function healthDocHtml(doc: unknown, index?: number): string;
  declare function actArtText(activity: ClientActivity & Record<string, unknown>): string;
  declare function actEntryHtml(activity: ClientActivity & Record<string, unknown>): string;
  declare function updateActEntry(el: Element, row: ClientActivity & Record<string, unknown>): void;
  declare function runOp(
    kind: string,
    body: Record<string, unknown>,
    options?: ClientAgentOpHandlers
  ): Promise<unknown>;
  declare function collapseEl(el: Element, done?: () => void): void;
  declare function expandEl(el: Element): void;
  declare function registerJobReconnector(kind: string, factory: (job?: unknown) => unknown): void;
  declare function registerAppJobReconnectors(): number;
  declare function installMobileViewportGuards(): void;
  declare function installDayRolloverWatcher(): void;
  declare function installWakeLockWatcher(): void;
  declare function acquireWakeLock(): Promise<void>;
  declare function releaseWakeLock(): Promise<void>;
  declare function wakeLockSupported(): boolean;
  declare function wakeLockEnabled(): boolean;
  declare function setWakeLockEnabled(on: boolean): void;
  declare function dayRolloverTarget(
    current: string,
    measured: string,
    dayPicked: boolean,
    dayPickedOn?: string | null
  ): string | null;
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
  declare function jobReconnect(opts?: { reuseWithinMs?: number }): Promise<void>;
  /** Names of the bundles index.html does NOT load eagerly (see build-client's BUNDLES). */
  declare type ClientLazyBundleName = "me-health" | "train" | "horizon" | "ask" | "settings" | "day" | "meals" | "today-ahead";
  /** Inject a lazily-loaded app-shell bundle (and its dependencies) once; resolves after they have executed. */
  declare function ensureBundle(name: ClientLazyBundleName): Promise<void>;
  declare function bundleLoaded(name: ClientLazyBundleName): boolean;
  /** Run `fn` synchronously when the bundle is ready, else after ensureBundle resolves. */
  declare function withBundle<T>(name: ClientLazyBundleName, fn: () => T): T | Promise<Awaited<T>>;
  declare function withLatestRender<T>(name: ClientLazyBundleName, render: () => T): T | undefined | Promise<Awaited<T> | undefined>;
  /** Warm every lazy bundle on idle after the first paint (once per page). */
  declare function prefetchLazyBundles(options?: { delayMs?: number }): void;
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
    // The composer's mount host (the shell's `.chatdock`); the input stands in when absent.
    host?: Element | null;
    input: HTMLTextAreaElement;
    sendBtn: HTMLButtonElement;
    fileInput: HTMLInputElement;
    attachBtn: HTMLButtonElement;
    preview: HTMLElement;
    mic?: HTMLElement | null;
    freqSlot?: HTMLElement | null;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    appendMsg(message: Partial<ChatComposerControllerMessage>): HTMLElement | null;
    rememberFuelContext(
      ...messages: Array<Partial<ChatComposerControllerMessage> | null | undefined>
    ): ChatComposerControllerMessage[];
    loadFuel(token: number, messages?: Partial<ChatComposerControllerMessage>[]): Promise<void>;
    saveDraft(value: string): void;
    loadDraft(): string;
    autosizeInput(input: HTMLTextAreaElement | HTMLInputElement): void;
    measure(): void;
    spawnPendingBubble(turnValue: unknown): Element | null;
    ensureMonitor(): void;
  };

  interface Window {
    CairnDicomViewerModel: {
      dicomWindowPixels(
        pixels: Float32Array,
        meta: { rows: number; columns: number; windowCenter: number; windowWidth: number; inverted: boolean },
        center?: number,
        width?: number
      ): Uint8ClampedArray;
      dicomManifestFallback(value: unknown): { series: any[]; reason: string | null };
      dicomOrientationCosines(value: unknown): number[] | null;
      dicomPreviewReason(value: unknown): string;
      dicomResponseIsCurrent(
        activeToken: number,
        responseToken: number,
        responseSelection: string,
        currentSelection: string,
        connected: boolean
      ): boolean;
    };
    CairnDicomViewer: {
      openDicomViewer(
        studyId: number,
        origin: Element,
        api: (path: string, opts?: RequestInit & { headers?: Record<string, string> }) => Promise<unknown>,
        toast: (message: string) => void
      ): void;
      dicomViewerHtml(): string;
    };
    CairnImagingUploadModel: {
      DICOM_IMPORT_MAX_BYTES: number;
      DICOM_IMPORT_SESSION_KEY: string;
      imagingUploadRoute(file: { name?: unknown; type?: unknown; size?: unknown }): {
        role: "report" | "image" | "mychart" | "dicom";
        mime: string;
        maxBytes: number;
        accepted: boolean;
        maxLabel: string;
      };
      uniqueDicomStudyIds(values: unknown): number[];
      readActiveDicomJobIds(storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">): number[];
      writeActiveDicomJobIds(ids: unknown, storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">): number[];
      rememberActiveDicomJob(id: number, storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">): number[];
      forgetActiveDicomJob(id: number, storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">): number[];
      dicomStudyChoiceLabel(doc: unknown): string;
      imagingAssociationTarget(
        studyIds: unknown,
        hasOrdinaryFiles: boolean,
        selectedStudyId: unknown
      ): { state: "none" | "ready" | "choose"; studyId: number | null };
      imagingAnalysisTargets(studyIds: unknown, hasOrdinaryFiles: boolean, associatedStudyId: unknown): number[];
      processDicomImportBatch(
        items: Array<{
          file: File;
          mime: string;
          jobId?: number;
          state?: "queued" | "importing" | "failed" | "status_unknown";
        }>,
        deps: {
          start(item: {
            file: File;
            mime: string;
            jobId?: number;
            state?: string;
          }): Promise<import("./client-api.js").ClientDicomImportJob>;
          wait(id: number): Promise<import("./client-api.js").ClientDicomImportJob>;
          remember(id: number): void;
          forget(id: number): void;
          onState(item: { file: File; mime: string; jobId?: number; state?: string }): void;
          onDone(item: { file: File; mime: string; jobId?: number; state?: string }): void;
        }
      ): Promise<{ ok: boolean; reason: "done" | "failed" | "status_unknown" | "start_failed"; studyIds: number[] }>;
    };
    activateTab(name: unknown, opts?: { replace?: boolean; syncRoute?: boolean }): void;
    applyRouteState(route: ClientRoute | null | undefined): ClientTabName;
    currentRouteState(): Partial<ClientRoute>;
    defaultProgressSeg(): string;
    registerTabBarHandlers(): void;
    highlightHome(tab?: unknown): ClientHomeName;
    routeApi(): ClientRoutesApi | null;
    routeKey(
      key: unknown,
      items: ReadonlyArray<string | readonly [string, unknown]>,
      fallback?: string | null
    ): string | null;
    syncRouteFromState(mode?: "push" | "replace"): void;
    switchTab(tab: unknown, opts?: { replace?: boolean; syncRoute?: boolean }): void;
    renderTab(tab: string): unknown;
    downloadFile(href: string): void;
    CairnRoutes?: ClientRoutesApi;
    registerAppJobReconnectors(): number;
    ensureBundle(name: ClientLazyBundleName): Promise<void>;
    bundleLoaded(name: ClientLazyBundleName): boolean;
    withBundle<T>(name: ClientLazyBundleName, fn: () => T): T | Promise<Awaited<T>>;
    withLatestRender<T>(name: ClientLazyBundleName, render: () => T): T | undefined | Promise<Awaited<T> | undefined>;
    prefetchLazyBundles(options?: { delayMs?: number }): void;
    installMobileViewportGuards(): void;
    installDayRolloverWatcher(): void;
    installWakeLockWatcher(): void;
    acquireWakeLock(): Promise<void>;
    releaseWakeLock(): Promise<void>;
    wakeLockSupported(): boolean;
    wakeLockEnabled(): boolean;
    setWakeLockEnabled(on: boolean): void;
    hideRestBar(): void;
    surfaceRestBar(): void;
    registerServiceWorkerLifecycle(): void;
    primeDiscipline(): void;
    maybeOnboard(): Promise<void>;
    openOnboarding(): void;
    startAppShell(): void;
    CairnAppRouter: ClientAppRouterApi;
    CairnOutbox: ClientOutboxApi;
    outboxEnqueue(
      kind: string,
      path: string,
      body: unknown,
      options?: ClientOutboxEnqueueOptions,
    ): Promise<ClientOutboxItem | null>;
    outboxSessionDependency(date: string): string | null;
    outboxSessionGroupId(
      date: string,
      identity?: { dailySessionId?: unknown; sessionId?: unknown },
    ): string;
    outboxSessionPrerequisite(date: string): {
      status: "none" | "ready" | "blocked";
      id: string | null;
      reason?: "attention" | "other_tab" | "phantom";
    };
    outboxResolveSessionPrerequisite(date: string): void;
    outboxBlockSessionPrerequisite(date: string): void;
    runSessionMutation(
      input: ClientOutboxSessionMutationInput,
      send: (idempotencyKey: string) => Promise<unknown>,
    ): Promise<ClientOutboxSessionMutationResult>;
    flushOutbox(): Promise<void>;
    outboxCount(): number;
    CairnApiCache: ClientApiCacheApi;
    CairnApiError: typeof CairnApiError;

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
      frequentChipsHtml(foods: unknown): string;
      dividerHtml(iso: unknown, label: unknown): string;
      earlierBarHtml(): string;
      dayISO(timestamp: unknown, localISO: (date?: Date) => string): string;
      messageHasFoodAction(message: Partial<ClientChatMessage> | null | undefined): boolean;
      userMessageSuggestsFood(message: Partial<ClientChatMessage> | null | undefined): boolean;
      wantsFuelSurface(
        messages: Partial<ClientChatMessage>[] | null | undefined,
        options: { todayISO: string; dayISO(timestamp: unknown): string }
      ): boolean;
      fuelHtml(day: ClientDayIntake | null | undefined): string;
      highlightTerm(text: unknown, query: unknown): string;
      historySessionRow(session: Partial<ClientChatSessionSummary>, whenLabel: string): string;
      historyHitRow(hit: Partial<ClientChatSearchHit>, query: unknown, whenLabel: string): string;
      captureFoodActive(status: unknown): boolean;
      captureFoodInfo(action: unknown):
        | { id: number; status: string; food: Record<string, unknown>; missing: boolean }
        | null;
      captureFoodFromRow(row: unknown): { status: string; food: Record<string, unknown> };
      captureFoodTagInner(status: unknown, food: unknown): string;
      captureFoodReviewInner(status: unknown, food: unknown): string;
      amendedFoodRow(action: unknown): { id: number; row: Record<string, unknown> } | null;
      amendedFoodTag(action: unknown): string | null;
      planLandingTag(action: unknown): { text: string; scheduled: boolean } | null;
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
      settleAfterNativePicker(options: { isActive(): boolean; measure(): void; graceMs?: number }): void;
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
      settleViewport(options: { isActive(): boolean; measure(): void }): void;
      wireFocus(options: {
        input: HTMLTextAreaElement | HTMLInputElement;
        isActive(): boolean;
        isSoftKeyboard(): boolean;
        isKeyboardGeometryOpen(): boolean;
        measure(): void;
        signal?: AbortSignal;
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
      clearRetry(): void;
      loadRetry(): { requestId: string; text: string; hasImage: boolean; expiresAt: number } | null;
      phaseCaption(
        turn:
          | (Record<string, unknown> & {
              status?: string;
              phase?: string | null;
              image_url?: string | null;
            })
          | null
          | undefined
      ): string;
      record(value: unknown): Record<string, unknown>;
      rows(value: unknown): Array<Record<string, unknown> & { id: number }>;
      saveDraft(value: string): void;
      saveRetry(value: { requestId: string; text: string; hasImage: boolean; expiresAt: number }): void;
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

    CairnMealFuelContext: {
      remainingFuelKcal(): Promise<number | null>;
      mealFuelFitLine(itemKcal: unknown, remaining: number | null): string;
      loadMealFuelLine(scope: ParentNode | null | undefined, itemKcal?: unknown): Promise<void>;
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
        }
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
        explanation?: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null
      ): string;
      validExplanationPayload(
        payload:
          | {
              ok?: unknown;
              explanation?: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null;
            }
          | null
          | undefined
      ): boolean;
    };

    CairnExerciseDetailData: {
      number(value: unknown, fallback?: number): number;
      record(value: unknown): Record<string, unknown>;
      rows<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown): T[];
      view(
        row: Record<string, unknown>,
        deps: {
          escapeHtml(value: unknown): string;
          fmtDur(seconds: unknown): string;
          fmtWeight(weight: unknown): string;
        }
      ): {
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
        deps: ExerciseDetailControllerDeps
      ): { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown };
      exerciseExplanationHtml(
        exercise: { name?: unknown; muscle_group?: unknown } | null | undefined,
        explanation: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null | undefined,
        deps: ExerciseDetailControllerDeps
      ): string;
      hydrateExerciseExplanation(
        el: ParentNode,
        exercise: { name?: unknown; muscle_group?: unknown } & Record<string, unknown>,
        deps: ExerciseDetailControllerDeps
      ): Promise<void>;
      initialExerciseExplanation(
        exercise: { name?: unknown; muscle_group?: unknown } & Record<string, unknown>,
        deps: ExerciseDetailControllerDeps
      ): { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null;
      replaceExerciseExplanation(
        el: ParentNode,
        exercise: { name?: unknown; muscle_group?: unknown } & Record<string, unknown>,
        explanation: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null | undefined,
        deps: ExerciseDetailControllerDeps
      ): void;
      validExerciseExplanationPayload(value: unknown, deps: ExerciseDetailControllerDeps): boolean;
    };

    // The optional imported "How to" layer inside the exercise detail overlay.
    // sectionHtml returns "" whenever there is no confidently-matched guide, and
    // suggestionHtml "" whenever no candidate is waiting on a yes/no.
    CairnExerciseGuide: {
      sectionHtml(guide: unknown): string;
      suggestionHtml(suggestion: unknown): string;
      wire(
        scope: ParentNode | null | undefined,
        options?: {
          api?: (path: string, opts?: RequestInit & { headers?: Record<string, string> }) => Promise<unknown>;
        },
      ): void;
    };

    CairnExerciseDetailRender: {
      missingHtml(
        name: string,
        svg: string,
        deps: {
          artImg(kind: string, query: unknown, className?: string, svg?: string | null): string;
          escapeHtml(value: unknown): string;
          sparklineSvg(values: unknown, width?: number, height?: number): string;
        }
      ): string;
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
        }
      ): string;
    };

    CairnExerciseDetailActions: {
      wireActions(
        el: ParentNode,
        row: { name?: string } & Record<string, unknown>,
        fallbackName: string,
        timed: boolean,
        deps: ExerciseDetailControllerDeps
      ): void;
    };

    CairnExerciseDetailController: {
      exerciseExplanation(
        exercise: { name?: unknown; muscle_group?: unknown } | null | undefined,
        deps: ExerciseDetailControllerDeps
      ): { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown };
      exerciseExplanationHtml(
        exercise: { name?: unknown; muscle_group?: unknown } | null | undefined,
        explanation: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null | undefined,
        deps: ExerciseDetailControllerDeps
      ): string;
      hydrateExerciseExplanation(
        el: ParentNode,
        exercise: { name?: unknown; muscle_group?: unknown } & Record<string, unknown>,
        deps: ExerciseDetailControllerDeps
      ): Promise<void>;
      openExerciseModal(
        nameInput: unknown,
        fromTile: Element | null | undefined,
        deps: ExerciseDetailControllerDeps
      ): Promise<void>;
      replaceExerciseExplanation(
        el: ParentNode,
        exercise: { name?: unknown; muscle_group?: unknown } & Record<string, unknown>,
        explanation: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null | undefined,
        deps: ExerciseDetailControllerDeps
      ): void;
      wireGuides(scope: ParentNode | null | undefined, deps: ExerciseDetailControllerDeps): void;
    };

    CairnUi: {
      attrsHtml(attrs: Record<string, unknown> | null | undefined): string;
      actionButtonHtml(
        action:
          | {
              id?: string;
              label: unknown;
              className?: string;
              attrs?: Record<string, unknown>;
            }
          | null
          | undefined
      ): string;
      textChipHtml(options: {
        label: unknown;
        className?: string;
        title?: unknown;
        attrs?: Record<string, unknown>;
      }): string;
      loadingStateHtml(options: { label: unknown; className?: string; live?: boolean }): string;
      segmentedNavHtml(options: { active: unknown; items: ReadonlyArray<readonly [unknown, unknown]> }): string;
      segmentedHtml(options: {
        items: ReadonlyArray<readonly [unknown, unknown]>;
        active: unknown;
        label: unknown;
        variant?: "sliding" | "plain" | "leaf";
        attr?: string;
        className?: string;
        wrapClass?: string;
        id?: string;
        attrs?: Record<string, unknown>;
        pressed?: boolean;
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
      strengthLineHtml(line: unknown, options?: { kicker?: unknown; compact?: boolean }): string;
    };

    CairnUiFeedback: {
      stagger(index?: number | null): string;
      reducedMotion(): boolean;
      btnBusy(btn: Element | null | undefined, label?: unknown, options?: { ghost?: boolean }): () => void;
      countUp(
        element: Element | null | undefined,
        target: unknown,
        options?: { dur?: number; fmt?: (value: number) => string }
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
      armDelete(btn: Element | null | undefined, onConfirm: () => unknown, options?: { label?: string }): void;
      delegate(
        host: Element,
        type: string,
        actions: Record<string, (el: HTMLElement, event: Event) => unknown>,
        options?: { signal?: AbortSignal },
      ): () => void;
      mount(
        host: Element,
        name: string,
        wire: (ctx: {
          host: Element;
          signal: AbortSignal;
          delegate(type: string, actions: Record<string, (el: HTMLElement, event: Event) => unknown>): void;
        }) => unknown,
      ): () => void;
    };

    CairnUiSheet: {
      open(options: {
        html: string;
        label?: unknown;
        labelledBy?: string;
        describedBy?: string;
        overlayClass?: string;
        sheetClass?: string;
        sheetTag?: "div" | "section";
        id?: string;
        attrs?: Record<string, unknown>;
        dismissible?: boolean;
        closeSelector?: string;
        initialFocus?: string;
        focusDelayMs?: number;
        openClass?: string;
        exitMs?: number;
        bodyClass?: string;
        onClose?(reason: "escape" | "backdrop" | "button" | "api"): void;
      }): ClientUiSheetHandle;
      sheetFor(el: Element | null | undefined): ClientUiSheetHandle | null;
      top(): ClientUiSheetHandle | null;
    };

    CairnUiChart: {
      linearScale(d0: number, d1: number, r0: number, r1: number): (value: number) => number;
      domain(values: ReadonlyArray<number>, pad: number, include?: ReadonlyArray<number>): { min: number; max: number };
      dateLabel(value: unknown, options?: { year?: boolean }): string;
      sparkSvg(values: unknown, width?: number, height?: number): string;
      lineChartSvg(options: {
        points: ReadonlyArray<{ value: number; label?: unknown; tip?: unknown; tone?: "ok" | "watch" }>;
        band?: { low: number; high: number } | null;
      }): string;
      gaugeSvg(options: {
        value: number;
        low: number;
        high: number;
        tone?: "ok" | "watch";
        lowLabel?: unknown;
        highLabel?: unknown;
      }): string;
      zoneBarSvg(options: {
        min: number;
        max: number;
        bands: ReadonlyArray<{ from: number; to: number; tone: string }>;
        optimal: { from: number; to: number };
        value: number | null;
        projected: number | null;
        label: unknown;
      }): string;
    };

    CairnDecisionUndo: {
      buttonHtml(options: { id: unknown; label?: unknown; attr?: string; className?: string }): string;
    };

    CairnDecisionUndoController: {
      revert(button: HTMLElement | null, id: unknown, deps: ClientDecisionUndoDeps, copy: ClientDecisionUndoCopy): Promise<boolean>;
      mount(host: Element, deps: ClientDecisionUndoDeps, actions: Record<string, ClientDecisionUndoCopy>, name?: string): () => void;
      offer(message: string, id: unknown, label: unknown, deps: ClientDecisionUndoDeps, copy: ClientDecisionUndoCopy): void;
    };

    CairnUiHeader: {
      setTodayHeaderTitle(deps: {
        headerTitle: HTMLElement;
        state: { tab?: unknown; logDate?: string; day?: unknown; dayPicked?: boolean; dayPickedOn?: string | null };
        escapeHtml(value: unknown): string;
        dateLabel(iso: string): string;
        localISO(date?: Date): string;
        syncRouteFromState(): unknown;
        renderToday(): unknown;
      }): void;
      /** The Today home's mono eyebrow on a sub-view header ("Fuel · Tue 29 Sep"). */
      setEyebrowTitle(el: HTMLElement, text: string): void;
      /** "Tue 29 Sep" for a YYYY-MM-DD. */
      shortDate(iso: string): string;
      updateHeaderCondense(deps: { state: { tab?: unknown } }): void;
      installHeaderCondenseScroll(depsFor: () => { state: { tab?: unknown } }): void;
    };

    CairnUiViewTransitions: {
      create(deps: { view: HTMLElement; reducedMotion(): boolean }): {
        viewEnter(): void;
        withViewTransition(fn: () => unknown, options?: { kind?: string }): Promise<unknown>;
        skelSwap(fn: () => unknown): Promise<unknown>;
        tabSwap(fn: () => unknown): Promise<unknown>;
        viewHydrate(): void;
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
      isAcknowledgedDirective(directive: { acknowledged?: unknown } | null | undefined): boolean;
      evidenceSafeUrl(value: unknown): string | null;
      truncateEvidenceBody(text: unknown): string;
      evidenceListHtml(evidence: unknown): string;
      evidenceCountMap(
        summary: { by_marker?: Array<{ marker?: unknown; count?: unknown }> } | null | undefined
      ): Map<string, number>;
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
        evidenceMap?: Map<string, number> | null
      ): string;
    };

    CairnHealthMarkerOrder: {
      isDirectLdlMarker(name: unknown): boolean;
      isStandardLdlMarker(name: unknown): boolean;
      markerRank(groupKey: unknown, name: unknown): number;
      lipidRank(name: unknown): number;
      lipidSubgroup(name: unknown): string | null;
      markerSubgroup(groupKey: unknown, name: unknown): string | null;
      orderMarkersForDisplay<T extends { name?: unknown; key?: unknown }>(
        groupKey: unknown,
        list: T[] | null | undefined
      ): T[];
      lipidGroupNoteHtml(
        list: Array<{ name?: unknown; key?: unknown; latest?: { date?: unknown } | null }> | null | undefined,
        options?: { relAge?: (date: string) => string }
      ): string;
    };

    CairnHealthClient: Window["CairnHealthEvidence"] &
      Window["CairnHealthMarkerOrder"] & {
        MAX_DOC_BYTES: number;
        MAX_DICOM_BYTES: number;
        MAX_DOC_TEXT: number;
        H_FILE_PROMPT: string;
        HEALTH_HERO_ART: string;
        askCoach(question: unknown): void;
        guessUploadMime(file: { type?: unknown; name?: unknown } | null | undefined): string;
        markersEmptyHtml(heroArt?: string): string;
        formatMarkerNumber(value: unknown): string;
        sparkDateLabel(value: unknown): string;
        markerSpanWord(days: unknown): string;
        markerTrendWord(
          marker:
            | {
                trend?: { dir?: unknown; span_days?: unknown } | null;
                points?: Array<{ value?: unknown; date?: unknown }> | null;
              }
            | null
            | undefined
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
        errorHtml: unknown
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
      loadHealthPicture(
        token: number,
        docsPromise: Promise<unknown>,
        deps: ClientHealthPictureControllerDeps
      ): Promise<void>;
    };

    CairnHealthMarkers: {
      formatMarkerNumber(value: unknown): string;
      sparkDateLabel(value: unknown): string;
      markerTrendWord(
        marker:
          | {
              trend?: { dir?: unknown; span_days?: unknown } | null;
              points?: Array<{ value?: unknown; date?: unknown }> | null;
            }
          | null
          | undefined
      ): string;
      markerSpanWord(days: unknown): string;
      optimalPhrase(marker: Record<string, unknown> | null | undefined): string;
      optimalSideWord(marker: Record<string, unknown> | null | undefined): string;
      markerTrendTone(marker: Record<string, unknown> | null | undefined): "toward" | "away" | "stable";
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
      labFlagWord(marker: Record<string, unknown> | null | undefined): string;
      offOptimalWord(marker: Record<string, unknown> | null | undefined): string;
    };

    CairnHealthMarkersController: {
      load(deps: ClientHealthMarkersControllerDeps, token: number): void;
    };

    CairnHealthDirectives: {
      activeDirectives(rows: unknown): Array<Record<string, unknown>>;
      evidenceCountMap(
        summary: { by_marker?: Array<{ marker?: unknown; count?: unknown }> } | null | undefined
      ): Map<string, number>;
      directiveResearchNudgeHtml(
        active: Array<Record<string, unknown>>,
        evidenceMap: Map<string, number>,
        summary: { research_enabled?: unknown } | null | undefined
      ): string;
      directivesEmptyHtml(): string;
      directivesSectionHtml(
        rows: unknown,
        evSummary:
          | { research_enabled?: unknown; by_marker?: Array<{ marker?: unknown; count?: unknown }> }
          | null
          | undefined
      ): string;
    };

    CairnHealthDirectiveLoader: {
      load(token: number): Promise<void>;
    };

    CairnHealthStandingPrimitives: ClientHealthStandingPrimitivesApi;

    CairnHealthStanding: ClientHealthStandingPrimitivesApi & {
      renderHealthStandingHtml(
        data: ClientHealthStanding | null | undefined,
        options?: { referenceAge?: unknown }
      ): string;
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
      sleepDurationPhrase(avgSleepMin: unknown): string;
      sleepDurationTone(avgSleepMin: unknown): "ok" | "watch" | "warn" | "mute";
      optimalPhrase(marker: Record<string, unknown> | null | undefined): {
        word: string;
        tone: "ok" | "warn" | "watch";
      };
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
      wireNoteCard(
        el: Element,
        deps: {
          state: Pick<ClientAppState, "_notesById">;
          select<T extends Element = Element>(selector: string): T | null;
          noteEntryHtml(note: Record<string, unknown>, index?: number): string;
          activityEntryHtml(activity: ClientActivity & Record<string, unknown>): string;
          openFoodDetail(note: unknown, fromTile?: Element | null): unknown;
        }
      ): void;
      renderNotes(notes: unknown, deps: Parameters<Window["CairnMeHealthLogRenderer"]["wireNoteCard"]>[1]): void;
      renderActs(activities: unknown, deps: Parameters<Window["CairnMeHealthLogRenderer"]["wireNoteCard"]>[1]): void;
    };

    CairnMeHealthDependencies: ClientMeHealthDependenciesApi;

    CairnMeHealthTabsController: {
      HEALTH_SEG: readonly (readonly [ClientHealthSection, string])[];
      normalizeHealthSeg(seg: unknown): ClientHealthSection;
      renderHealth(deps: ClientMeHealthTabsControllerDeps): Promise<void>;
      setHealthSegActive(seg: ClientHealthSection, deps: ClientMeHealthTabsControllerDeps): void;
      switchHealthSeg(
        seg: ClientHealthSection,
        deps: ClientMeHealthTabsControllerDeps,
        opts?: { openPicker?: boolean }
      ): void;
      paintHealthTab(deps: ClientMeHealthTabsControllerDeps): void;
    };

    CairnFoodDetailController: {
      openFoodDetail(
        note: unknown,
        fromTile: Element | null | undefined,
        deps: FoodDetailControllerDeps
      ): Promise<void>;
    };

    CairnMeProfileForm: {
      record(value: unknown): Record<string, unknown>;
      goalMode(profile: MeProfileProfile, goal: MeProfileGoalCheck): string;
      enduranceGoal(profile: MeProfileProfile): MeProfileEnduranceGoalDraft;
      html(
        deps: MeProfileControllerDeps,
        profile: MeProfileProfile,
        goal: MeProfileGoalCheck,
        context: MeProfileFormContext
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
      mondayOf(iso: string): string;
      nextMonday(iso: string): string;
      weekBanked(agenda: ClientFlexibleTrainingAgenda | null | undefined): boolean;
      buildBriefing(input: {
        today: string;
        units?: unknown;
        agenda?: ClientFlexibleTrainingAgenda | null;
        runPlan?: ClientWeeklyRunPlan | null;
        raceBuild?: ClientRaceBuild | null;
        nextAgenda?: ClientFlexibleTrainingAgenda | null;
        nextRunPlan?: ClientWeeklyRunPlan | null;
        nextRaceBuild?: ClientRaceBuild | null;
        laterAgenda?: ClientFlexibleTrainingAgenda | null;
        laterRunPlan?: ClientWeeklyRunPlan | null;
        laterRaceBuild?: ClientRaceBuild | null;
      }): {
        horizon: "this_week" | "next_week" | "later";
        kicker: string;
        headline: string;
        units: "km" | "mi";
        next: {
          kind: ClientFlexibleRunKind;
          label: string;
          when: string;
          date: string | null;
          day_number: number | null;
          prescription: string;
          setup: string;
          expect: string;
          sitsBy: string;
          status: "open" | "completed";
        } | null;
        remaining: Array<{
          kind: ClientFlexibleRunKind;
          label: string;
          when: string;
          date: string | null;
          day_number: number | null;
          prescription: string;
          setup: string;
          expect: string;
          sitsBy: string;
          status: "open" | "completed";
        }>;
        later: Array<{
          kind: ClientFlexibleRunKind;
          label: string;
          when: string;
          date: string | null;
          day_number: number | null;
          prescription: string;
          setup: string;
          expect: string;
          sitsBy: string;
          status: "open" | "completed";
        }>;
      };
      showsRaceView(goal: ClientEnduranceGoal | null | undefined, build: ClientRaceBuild | null | undefined): boolean;
    };

    CairnPlanEndurance: Window["CairnPlanEnduranceModel"];

    CairnPlanEditor: {
      blankStrength(): Record<string, unknown>;
      runsElsewhereHtml(): string;
      dayModelFromPlan(day: Record<string, unknown>): Record<string, unknown>;
      calendarFooterHtml(plan: unknown, host: unknown, icsUrl: unknown): string;
      progDayHtml(
        day: Record<string, unknown>,
        dayIndex: number,
        ann?: { weekday?: string | null; status?: string | null; label?: string | null },
        opts?: { sharedPurpose?: string | null }
      ): string;
      pitemHtml(item: Record<string, unknown>, dayIndex: number, itemIndex: number, lastIndex: number): string;
      pdayHtml(day: Record<string, unknown>, dayIndex: number): string;
    };

    CairnPlanEditorForm: {
      dayNumber(day: Record<string, unknown>): number;
      datasetNumber(el: HTMLElement, key: string): number;
      datasetPair(value: string | undefined): [number, number];
      syncModel(
        model: Array<Record<string, unknown> & { items: Array<Record<string, unknown>> }>,
        root: ParentNode
      ): void;
      serializeDays(
        model: Array<Record<string, unknown> & { items: Array<Record<string, unknown>> }>
      ): Array<Record<string, unknown>>;
    };

    CairnPlanEditorController: {
      render(): Promise<void>;
      serializeDays(
        model: Array<{ day_number?: unknown; name?: unknown; focus?: unknown; items: Array<Record<string, unknown>> }>
      ): Array<Record<string, unknown>>;
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
      /** The planner's own adequacy rule (a parsed 5–7 day week on its daily targets). */
      mealPlanIsAdequate(plan: unknown): boolean;
      /** The week's saved food constraints changed under it: none of its meals read as current. */
      needsRefresh(plan: unknown): boolean;
      mealsCtxFor(plan: unknown, now?: unknown): { weekOf: string; targetKcal: number; todayName: string };
      mealRowHtml(meal: unknown, mealIndex?: number, options?: { di?: number; count?: number }): string;
      mealPlanCardHtml(plan: unknown, index: number): string;
      mealPlanListHtml(plans: unknown): string;
      mealPrefsHtml(prefs: unknown, index: number): string;
      mealPlanEmptyHtml(mealPrefs: unknown): string;
      mealPlanHeroHtml(plan: unknown, verified?: unknown): string;
      mealShoppingHtml(shopping: unknown, checkedShopping: unknown, revealIndex: number): string;
      mealPlannerBodyHtml(
        current: unknown,
        mealPrefs: unknown,
        options?: { checkedShopping?: unknown; verified?: unknown; now?: unknown; upcoming?: unknown }
      ): {
        html: string;
        context: { weekOf: string; targetKcal: number; todayName: string } | null;
      };
      mealDayHtml(
        day: unknown,
        dayIndex: number,
        context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown }
      ): string;
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
        ghost: boolean
      ): ClientAgentOpHandlers | null;
      renderMealPlans(plans: unknown, selector?: string, refresh?: (() => unknown) | null): void;
      runCoachMealPlan(agent: string, instruction: string): void;
      verifiedForPlan(id: unknown): unknown;
      wireMealPlannerBody(
        currentPlan: (Record<string, unknown> & { id: string | number }) | null,
        context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null
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
        ghost: boolean
      ): ClientAgentOpHandlers | null;
      reconnectMealPlan(job?: unknown): ClientAgentOpHandlers | null;
    };

    CairnMealPlannerActions: {
      renderMealPlans(plans: unknown, selector?: string, refresh?: (() => unknown) | null): void;
      wireMealPrefs(): void;
      wireShoppingChips(currentPlan: Record<string, unknown> & { id: string | number }): void;
      wireMealPlannerBody(
        currentPlan: (Record<string, unknown> & { id: string | number }) | null,
        context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null
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
      refreshProposals(): Promise<void>;
      renderProposals(proposals: unknown): void;
      runCoachProposal(agent: string, instruction: string): void;
    };

    CairnMealSwapController: {
      mealSwapOpOpts(
        current: Record<string, unknown> & { id: string | number },
        context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null,
        dayIndex: number,
        mealIndex: number
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
        direction: number
      ): Promise<void>;
      reconnectMealSwap(job?: unknown): ClientAgentOpHandlers | null;
      submitMealSwap(
        current: Record<string, unknown> & { id: string | number },
        context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null,
        dayIndex: number,
        mealIndex: number,
        panel: HTMLElement
      ): Promise<void>;
      wireMealRows(
        scope: ParentNode,
        current: Record<string, unknown> & { id: string | number },
        context: { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null
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
      openMealSheet(
        current: Record<string, unknown> & { id: string | number },
        dayIndex: number,
        mealIndex: number
      ): void;
      recipeOpOpts(
        current: Record<string, unknown> & { id: string | number },
        dayLabel: string,
        dayIndex: number,
        mealIndex: number,
        key: string | undefined
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

    CairnHealthBeliefs: {
      beliefsViewHtml(data: ClientBeliefsView | null | undefined): string;
    };

    CairnHealthBeliefsLoader: {
      load(token: number): Promise<void>;
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
      eventResolved(event: Record<string, unknown> | null | undefined, todayIso?: string): boolean;
      lifeFieldsHtml(kind: unknown): string;
      lifeImpactsHtml(impact: Record<string, unknown> | null | undefined): string;
      lifeEventInner(event: Record<string, unknown>, impact?: Record<string, unknown> | null): string;
      lifeEventHtml(
        event: Record<string, unknown>,
        index: number | undefined,
        impactsById?: Record<string, Record<string, unknown>>
      ): string;
      movementConsiderationsHtml(read: unknown): string;
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
      startResolve(button: Element, deps: ClientLifeControllerDeps): void;
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
      parsedDoc(
        doc: unknown
      ): { markers?: Array<Record<string, unknown>>; clinical_facts?: unknown[]; type?: unknown } | null;
      markerFlagClass(flag: unknown): string;
      markersTable(parsed: unknown): string;
      docCollapsible(doc: unknown): boolean;
      healthDocInner(doc: unknown): string;
      healthDocHtml(doc: unknown, index?: number): string;
    };

    CairnImaging: {
      imagingStudy(doc: ClientHealthDocument): import("./client-api.js").ClientImagingStudy | null;
      imagingHasDicomSeries(study: import("./client-api.js").ClientImagingStudy | null): boolean;
      imagingLabel(value: unknown): string;
      imagingGroups(study: import("./client-api.js").ClientImagingStudy): unknown[];
      imagingStudyGrouping(study: import("./client-api.js").ClientImagingStudy | null): {
        system: string;
        region: string;
        laterality: string | null;
      };
      imagingCorrectionPayload(
        study: import("./client-api.js").ClientImagingStudy,
        values: Record<string, unknown>
      ): import("./client-api.js").ClientImagingStudy;
      imagingInner(doc: ClientHealthDocument): string;
      imagingCard(doc: ClientHealthDocument, index?: number): string;
      wireImaging(
        doc: ClientHealthDocument,
        el: HTMLElement,
        deps: {
          api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
          toast(message: string): void;
          refresh(): void;
        }
      ): void;
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
      mountPacket(host: Element, deps: ClientRecordsPacketDeps): () => void;
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
      agentChipState(agent: Record<string, unknown>, now?: Date): { cls: string; label: string };
      agentAvailabilityNote(agent: Record<string, unknown>, now?: Date): string;
      agentQuotaNote(agent: Record<string, unknown>): string;
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
      statusHelpers(options?: { relTime?: (value: string) => string; absDate?: (value: string) => string }): {
        garminStatusLine(settings: unknown, syncing: boolean): string;
        agentHealthCard(stats: unknown): string;
        agentOpLabel(op: unknown): string;
        agentActivityCard(stats: unknown): string;
        noticedCard(data: unknown): string;
        agentChipState(agent: Record<string, unknown> | null | undefined): { cls: string; label: string };
      };
      artSpendCardHtml(stats: unknown): string;
      sourcesSliceHtml(options: {
        workingModel: Pick<SettingsScreenWorkingModel, "garmin_username" | "garmin_export_strength">;
        settings: Record<string, unknown>;
        garminStatusHtml: string;
        lastExportAt?: string | null;
        dates?: { relTime?: (value: string) => string; absDate?: (value: string) => string };
        appleHealth?: {
          loading?: boolean;
          error?: string | null;
          config?: Record<string, unknown> | null;
          connections?: Array<Record<string, unknown>>;
        };
      }): string;
      appleHealthCardHtml(state: {
        loading?: boolean;
        error?: string | null;
        config?: Record<string, unknown> | null;
        connections?: Array<Record<string, unknown>>;
        dates?: { relTime?: (value: string) => string; absDate?: (value: string) => string };
      }): string;
      automationSliceHtml(options: {
        workingModel: Pick<
          SettingsScreenWorkingModel,
          | "enrich_enabled"
          | "art_enabled"
          | "research_enabled"
          | "meal_plan_auto_draft"
          | "lead_mode"
          | "training_drive"
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
      exerciseGuideStatusLine(status: Record<string, unknown> | null): string;
      wireExerciseGuideCard(options?: {
        root?: ParentNode | null;
        api?: (path: string, opts?: RequestInit & { headers?: Record<string, string> }) => Promise<unknown>;
        toast?: (message: string) => unknown;
      }): void;
    };

    CairnSettingsDataController: {
      render(deps: ClientSettingsDataControllerDeps): void;
    };

    CairnSettingsSourcesAutomationController: {
      appleHealthRunLink(shortcutName: string, origin: string, pairingCode: string): string;
      renderSources(deps: ClientSettingsSourcesAutomationControllerDeps): Promise<void>;
      renderAutomation(deps: ClientSettingsSourcesAutomationControllerDeps): void;
    };

    CairnSettingsAgents: {
      /** Settings > Agents: where the agent layer stands NOW, one quiet line. */
      agentStateLine(stats: unknown, agents: ReadonlyArray<Record<string, unknown>>, now?: Date): string;
      agentsSliceHtml(options: {
        agentStrategy: string;
        routeSummary: string;
        routeRowsHtml: string;
        agentHealthHtml: string;
        agentActivityHtml: string;
        noticedHtml: string;
        agentStateHtml?: string;
        coachDay: number;
        coachHour: number;
        timeZone: string;
        dayNames: string[];
        chatRoutingMode: "adaptive" | "single";
        chatProfileBindings: Record<string, Record<string, Record<string, unknown>>>;
        chatProfileAgents: Array<Record<string, unknown> & { name: string }>;
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
      isActive(): boolean;
      ensureRestBar(): HTMLElement;
      paintRest(): void;
      startRest(seconds?: number): void;
      stopRest(): void;
      hideRestBar(): void;
      surfaceRestBar(): void;
      reconcileRest(): void;
      restoreRest(): void;
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
        stats: Array<
          | readonly [unknown, unknown]
          | readonly [unknown, unknown, { text?: boolean; k?: boolean }]
          | null
          | undefined
          | false
        >
      ): string;
      emptyStateHtml(svg: string | null | undefined, line: unknown): string;
    };

    CairnProgressLineChartModel: {
      buildModel(
        pts: ProgressChartPoint[] | null | undefined,
        options: {
          width: number;
          height: number;
          goal?: number | null;
          padding?: Partial<{ left: number; right: number; top: number; bottom: number }> | null;
        }
      ): ProgressLineChartModel | null;
      nearestIndex(axis: readonly number[] | null | undefined, pixelX: number): number | null;
    };

    CairnProgressChartScrub: {
      wire(
        canvas: HTMLCanvasElement & {
          _chartXs?: number[];
          _setTarget?: (idx: number | null, scrubbing: boolean) => void;
          _scrubWired?: boolean;
        }
      ): void;
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
        height: number
      ): void;
      drawHighlight(ctx: CanvasRenderingContext2D, args: ProgressChartHighlightOptions): void;
    };

    CairnProgressChart: {
      withAlpha(hex: unknown, alpha: number): string;
      drawLineChart(
        canvas: HTMLCanvasElement | null | undefined,
        pts: ProgressChartPoint[],
        opts?: ProgressLineChartOptions
      ): void;
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
      listed(sessions: HistorySession[]): HistorySession[];
      hasSets(session: HistorySession): boolean;
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
      raceBuildCard(build: ClientRaceBuild | null | undefined, opts?: { underGoal?: boolean; legMap?: boolean; compact?: boolean; units?: unknown }): string;
      trainingAgendaCard(agenda: ClientFlexibleTrainingAgenda | null | undefined): string;
      enduranceGoalCard(goal: ClientEnduranceGoal | null | undefined, opts?: { units?: unknown }): string;
      runComplianceLine(compliance: ClientRunCompliance | null | undefined): string;
      enduranceCoachLine(
        plan: ClientWeeklyRunPlan | null | undefined,
        agenda?: ClientFlexibleTrainingAgenda | null
      ): string;
      enduranceCalibrationLine(
        status: ClientCalibrationStatus | null | undefined,
        dateISO?: string
      ): string;
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
      performanceHtml(
        performance: ClientPerformanceStanding | null | undefined,
        options?: { suppressLever?: boolean }
      ): string;
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
      needsLookLifts(lifts: ClientProgramState["lifts"] | null | undefined): ClientProgramState["lifts"];
      climbingLifts(lifts: ClientProgramState["lifts"] | null | undefined): ClientProgramState["lifts"];
      familyGroups(
        lifts: ClientProgramState["lifts"] | null | undefined
      ): Array<{ key: string; label: string; lifts: ClientProgramState["lifts"] }>;
      recencyLabel(iso: unknown): string;
      compactLiftRowHtml(lift: ClientProgramState["lifts"][number] | null | undefined, index: number): string;
      variantRowHtml(lift: ClientProgramState["lifts"][number] | null | undefined, index: number): string;
      familyGroupHtml(
        group: { key: string; label: string; lifts: ClientProgramState["lifts"] } | null | undefined,
        index: number
      ): string;
      curatedLiftsHtml(lifts: ClientProgramState["lifts"] | null | undefined, startIndex?: number): string;
      volumeBlockHtml(volume: ClientProgramState["volume"] | null | undefined, startIdx: number): string;
      mesoBlockHtml(meso: ClientProgramState["mesocycle"] | null | undefined, index: number): string;
      adaptationsHtml(adaptations: string[] | null | undefined, index: number): string;
    };

    CairnProgressProgramBlock: {
      blockFocusWord(focus: unknown): string;
      activeBlockHtml(block: ClientProgramBlock | null | undefined): string;
      startBlockHtml(): string;
      loadProgramBlock(): Promise<void>;
      mountProgramBlock(
        slot: Element,
        deps: {
          api(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
          toast(message: string): void;
          armDelete(btn: Element, onConfirm: () => unknown): void;
          refresh(): void;
        },
      ): () => void;
    };

    CairnProgressProgramController: {
      focus: Window["CairnProgressFocus"];
      render(deps: ClientProgressProgramControllerDeps): Promise<unknown>;
      paint(data: ClientProgramState, deps: ClientProgressProgramControllerDeps): void;
      triggerProgramEvolve(btn: Element, deps: ClientProgressProgramControllerDeps): Promise<void>;
      tidyExerciseNames(btn: Element, deps: ClientProgressProgramControllerDeps): Promise<void>;
      strengthJourneyCardHtml(value: unknown): string;
    };

    CairnProgressJourney: ClientProgressJourneyApi;

    CairnJourneyTimeline: ClientJourneyTimelineApi;

    CairnProgressRouteDeps: ClientProgressRouteDeps;

    CairnCoachingFocus: {
      CFOCUS_DOMAIN_LABEL: Record<string, string>;
      cfocusDomainTag(domain: unknown): string;
      coachingFocusCardHtml(
        focus: ClientCoachingFocus | null | undefined,
        options?: { blockLine?: boolean; actions?: boolean; headline?: boolean }
      ): string;
      coachingFocusCompactHtml(focus: ClientCoachingFocus | null | undefined): string;
      loadCoachingFocus(slotSelector: string, root?: ParentNode | null): Promise<void>;
      coachingFocusThreadHtml(focus: ClientCoachingFocus | null | undefined): string;
      cfocusRoute(go: unknown): void;
    };

    CairnCardioPlan: {
      isCardioItem(item: unknown): boolean;
      strengthPlanItems<T>(items: readonly T[] | null | undefined): T[];
      isStrengthPlanDay(day: unknown): boolean;
      strengthPlanDays<T extends { items?: unknown }>(plan: readonly T[] | null | undefined): T[];
      cardioIntervalNote(interval: unknown): string;
      cardioIntervalStructure(interval: unknown, targetZone: unknown): string;
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
      enduranceBestRows(
        group: ClientSportBests | null | undefined
      ): Array<{ label: string; val: string; date: string; type: string }>;
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
        raceBuild: ClientRaceBuild | null,
        agenda: ClientFlexibleTrainingAgenda | null,
        programState: ClientProgramState | null,
        calibration: ClientCalibrationStatusResponse | null,
        deps: ClientProgressEnduranceControllerDeps
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
      renderableBuckets(agenda: Partial<ClientTodayAgenda> | null | undefined): {
        primary: ClientTodayAgendaCandidate[];
        more: ClientTodayAgendaCandidate[];
      };
      withoutCards<T extends Partial<ClientTodayAgenda> | null | undefined>(
        agenda: T,
        cards: readonly string[],
        ids?: readonly string[]
      ): T;
      /** Generic health cards whose subject the block thread already names. */
      threadEchoIds(agenda: Partial<ClientTodayAgenda> | null | undefined, threadText: string): string[];
      genericCardHtml(candidate: ClientTodayAgendaCandidate, revealIdx: number): string;
      railHtml(
        agenda: Partial<ClientTodayAgenda> | null | undefined,
        genericPending: ClientTodayAgendaCandidate[]
      ): string;
      fuelCardHtml(day: ClientDayIntake | null | undefined): string;
      /** The "Worth a look" group key that heads Today's rail. */
      mastHtml(): string;
    };

    CairnTodayRailController: {
      fetchTodayAgenda(date: string, deps: ClientTodayRailControllerDeps): Promise<ClientTodayAgenda | null>;
      railHtml(
        agenda: Partial<ClientTodayAgenda> | null | undefined,
        genericPending: ClientTodayAgendaCandidate[]
      ): string;
      fallbackRailHtml(isToday: boolean): string;
      runAgendaRail(
        agenda: Partial<ClientTodayAgenda> | null | undefined,
        genericPending: ClientTodayAgendaCandidate[],
        deps: ClientTodayRailControllerDeps
      ): void;
      runFallbackRail(isToday: boolean, deps: ClientTodayRailControllerDeps): void;
      promoteAttentionLead(root: ParentNode, attention: ClientTodayAttention | null | undefined): void;
      mountChangesLine(root: ParentNode, deps: ClientTodayRailControllerDeps): () => void;
      loadFuelToday(date: string, deps: ClientTodayRailControllerDeps): Promise<void>;
      loadWeekAhead(deps: ClientTodayRailControllerDeps): Promise<void>;
      loadProgramAdjustmentsBanner(deps: ClientTodayRailControllerDeps): Promise<void>;
      loadRecentActivities(deps: ClientTodayRailControllerDeps): Promise<void>;
      loadGarminReconcile(deps: ClientTodayRailControllerDeps): Promise<void>;
      wireGenericAgendaCards(pending: ClientTodayAgendaCandidate[], deps: ClientTodayRailControllerDeps): void;
    };

    CairnTodayRailLoaders: {
      loadFuelToday(date: string, deps: ClientTodayRailControllerDeps): Promise<void>;
      loadFuelingFollowup(deps: ClientTodayRailControllerDeps): Promise<void>;
      loadWeekAhead(deps: ClientTodayRailControllerDeps): Promise<void>;
      loadProgramAdjustmentsBanner(deps: ClientTodayRailControllerDeps): Promise<void>;
      loadRecentActivities(deps: ClientTodayRailControllerDeps): Promise<void>;
      loadGarminReconcile(deps: ClientTodayRailControllerDeps): Promise<void>;
    };

    /** The Brief's v2 voice pieces (today-brief-voice-client.ts); absent under a partial boot. */
    CairnTodayBriefVoice?: TodayBriefVoiceApi;
    CairnTodayBriefRunLeg?: { html(read: unknown, isToday: boolean): string };
    CairnTodaySessionAskSheet?: { open(reveal: () => void): boolean };

    CairnChangesLine: {
      model(read: Partial<import("./brain-changes.js").ClientBrainChanges> | null | undefined): ClientChangesLineModel | null;
      html(model: ClientChangesLineModel | null, opts?: { enter?: boolean }): string;
    };

    CairnChangesLineController: {
      key: string;
      path: "/brain/changes";
      mount(host: Element, deps: ClientChangesLineDeps): () => void;
    };

    CairnTodaySideLoaders: ClientTodaySideLoaders;

    CairnTodayPlanSelection: {
      planDayNumberForSession(
        session: ClientTodayPlanSelectionSession | null | undefined,
        plan: ClientTodayPlanSelectionDay[] | null | undefined
      ): number | null;
      nextPlanDayNumber(
        dayNumber: number | null | undefined,
        plan: ClientTodayPlanSelectionDay[] | null | undefined
      ): number | null;
      suggestedPlanDayNumber(
        session: ClientTodayPlanSelectionSession | null | undefined,
        isToday: boolean,
        deps: ClientTodayPlanSelectionDeps
      ): Promise<number | null>;
      planDayRecoveryFromSelection(payload: unknown): ClientTodayPlanDayRecoveryMap;
      loadPlanDayRecovery(
        date: string,
        deps: Pick<ClientTodayPlanSelectionDeps, "api">
      ): Promise<ClientTodayPlanDayRecoveryMap>;
    };

    CairnTodayPlanSessionModel: {
      planItems(
        day: (Record<string, unknown> & { items?: Array<Record<string, unknown>> | null }) | null | undefined
      ): Array<Record<string, unknown>>;
      groupLoggedSets(
        session:
          | { sets?: Array<Record<string, unknown> & { exercise?: string; set_number?: number | null }> | null }
          | null
          | undefined
      ): Record<string, Array<Record<string, unknown>>>;
      selectedPlanDay(
        state: {
          day: number | null;
          plan: Array<Record<string, unknown> & { day_number: number; items?: Array<Record<string, unknown>> | null }>;
        },
        revealBlank: boolean
      ): Record<string, unknown> & { day_number: number; items?: Array<Record<string, unknown>> | null };
      itemGroups(params: {
        items: Array<Record<string, unknown>>;
        loggedByEx: Record<string, Array<Record<string, unknown>>>;
        skips: unknown[];
      }): {
        planNames: Set<string>;
        activeItems: Array<Record<string, unknown>>;
        skippedItems: Array<Record<string, unknown>>;
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
        loggedByEx: Record<string, Array<Record<string, unknown>>>
      ): Array<{ name: string; mode?: string | null }>;
      cardAttribution(params: {
        items: Array<Record<string, unknown>>;
        loggedByEx: Record<string, Array<Record<string, unknown>>>;
      }): Map<
        Record<string, unknown>,
        { key: string; exercise: string; sets: Array<Record<string, unknown>>; siblings: number }
      >;
      prefillFor(
        item: Record<string, unknown>,
        loggedByEx: Record<string, Array<Record<string, unknown>>>,
        lastSets: Record<string, Record<string, unknown> | null>,
        rx?: Partial<ClientPrescription> | null,
        attributed?: {
          key: string;
          exercise: string;
          sets: Array<Record<string, unknown>>;
          siblings: number;
        } | null
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
        }
      ): Promise<Record<string, Record<string, unknown> | null>>;
      loadPrescriptions(
        day: number | null,
        planEx: string[],
        deps: { cachedApi<T = unknown>(path: string, options?: { key?: string; freshFor?: number }): Promise<T> }
      ): Promise<Record<string, unknown>>;
      loadCardioContext(
        dayItems: Array<Record<string, unknown>>,
        isToday: boolean,
        deps: {
          state: { logDate: string };
          api(path: string): Promise<unknown>;
        }
      ): Promise<{
        cardioEfforts: Array<Record<string, unknown>>;
      }>;
    };

    CairnTodayPlanSessionPreparation: {
      groupLoggedSets(
        session:
          | { sets?: Array<Record<string, unknown> & { exercise?: string; set_number?: number | null }> | null }
          | null
          | undefined
      ): Record<string, Array<Record<string, unknown>>>;
      preparePlanSession(deps: {
        state: {
          logDate: string;
          day: number | null;
          dayPicked?: boolean;
          dayPickedOn?: string | null;
          plan: Array<Record<string, unknown> & { day_number: number; items?: Array<Record<string, unknown>> | null }>;
          planReveal?: { date: string; on: boolean; blank?: boolean } | null;
          pendingOffPlan?: Record<string, Array<{ name: string; mode?: string | null }>>;
        };
        session: Record<string, unknown> | null | undefined;
        isToday: boolean;
        api(path: string): Promise<unknown>;
        cachedApi<T = unknown>(path: string, options?: { key?: string; freshFor?: number }): Promise<T>;
        peekCached<T = unknown>(key: string, freshFor?: number): { data: T; fresh: boolean } | null;
        suggestedPlanDayNumber(session: Record<string, unknown> | null | undefined, isToday: boolean): Promise<number | null>;
      }): Promise<
        Record<string, unknown> & {
          day: Record<string, unknown>;
          loggedByEx: Record<string, Array<Record<string, unknown>>>;
          cardioEfforts: Array<Record<string, unknown>>;
          activeItems: Array<Record<string, unknown>>;
          skippedItems: Array<Record<string, unknown>>;
          strengthItems: Array<Record<string, unknown>>;
          planEx: string[];
          offPlanEx: string[];
          pendingOffPlan: Array<{ name: string; mode?: string | null }>;
          lastSets: Record<string, Record<string, unknown> | null>;
          rxByEx: Record<string, unknown>;
          strengthJourney: ClientStrengthJourney | null;
          rxFor(name: unknown): unknown;
          prefillFor(item: Record<string, unknown>): Record<string, unknown>;
          attributionFor(item: Record<string, unknown>): {
            key: string;
            exercise: string;
            sets: Array<Record<string, unknown>>;
            siblings: number;
          } | null;
          exDone: number;
          exTotal: number;
          hasSyncedCardioToday: boolean;
          isRunDay: boolean;
        }
      >;
    };

    CairnTodayDataLoader: {
      load(
        opts: { soft?: unknown } | null | undefined,
        deps: {
          root: HTMLElement;
          state: { logDate: string; plan: unknown[]; tab?: string };
          api(path: string): Promise<unknown>;
          cachedApi(
            path: string,
            options?: {
              key?: string;
              freshFor?: number;
              onUpgrade?: (data: unknown, meta: { changed: boolean }) => void;
              project?: (data: unknown) => unknown;
            }
          ): Promise<unknown>;
          peekCached<T = unknown>(key: string, freshFor?: number): { data: T; fresh: boolean } | null;
          storeCached(key: string, data: unknown): void;
          localISO(date?: Date): string;
          todaySkeleton(): string;
          setTodayHeaderTitle(): void;
          nextPollToken(): number;
        }
      ): Promise<{
        soft: boolean;
        token: number;
        isToday: boolean;
        session: unknown;
        stats: unknown;
        profile: unknown;
        exercises: unknown;
        aggregateFresh: boolean;
        agenda: unknown;
        coachingFocus: unknown;
        primedLastSets: string[];
        primedProgressionDay: number | null;
        strengthJourney?: unknown;
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
        }
      ): void;
      /** The aggregate path a tab asks for (`surface=today` widens it with `responses`). */
      aggregatePath(date: string, tab: string | undefined): string;
    };

    CairnTodayWorth: {
      railAgenda<T extends Partial<ClientTodayAgenda> | null | undefined>(
        agenda: T,
        opts: { fuelGlance: boolean; thread?: { title?: unknown; summary?: unknown } | null }
      ): T;
      askCandidate(agenda: Partial<ClientTodayAgenda> | null | undefined): ClientTodayAgendaCandidate | null;
      mountInstallRow(root: ParentNode): void;
    };

    CairnTodayPath: {
      cardHtml(path: import("./today-path.js").TodayPath | null | undefined): string;
      trailSvg(path: import("./today-path.js").TodayPath): string;
      shortDate(iso: unknown): string;
      clock(sec: unknown): string;
      signed(n: number, digits?: number): string;
      /** Where the card's "All goals" link lands (Horizon's goal line). */
      goalsHref(): string;
    };

    CairnTodayPathController: {
      key(date: string): string;
      path(date: string): string;
      mount(
        host: Element,
        deps: {
          date: string;
          peek(key: string): { data: import("./today-path.js").TodayPath; fresh: boolean } | null;
          load(path: string, options: { key: string }): Promise<import("./today-path.js").TodayPath>;
          /** Open Horizon's goal line (the card's "All goals" link). */
          openGoals?(): void;
        }
      ): () => void;
    };

    CairnTodayAheadMount: {
      mount(
        view: Element,
        opts: {
          date: string;
          read: unknown;
          agenda: Promise<unknown>;
          isCurrent(): boolean;
          rail: {
            state: { planJump?: string | null; standSeg?: string | null };
            api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
            activateTab(tab: string): unknown;
            gotoChatWith(text: string): unknown;
            toast(message: string): void;
            invalidate(key: string): void;
            refreshToday(options: { soft: boolean }): unknown;
          };
        }
      ): void;
    };

    /** Lazy (today-ahead bundle): reached only through withBundle("today-ahead", …). */
    CairnTodayDigest: {
      html(digest: import("./today-digest.js").TodayDigest | null | undefined, ask?: ClientTodayAgendaCandidate | null): string;
      askHtml(ask: ClientTodayAgendaCandidate | null | undefined): string;
      changeHtml(
        change: import("./today-digest.js").TodayDigestChange,
        opts?: { limit?: number; explain?: boolean }
      ): string;
      ARROW: Record<string, { glyph: string; cls: string; word: string }>;
      /** The most lift rows Today shows; the rest are counted on the "All changes" link. */
      MAX_ROWS: number;
    };

    /** Lazy (today-ahead bundle). */
    CairnTodayWeek: {
      stripHtml(week: import("./client-api.js").ClientPlanWeek | null | undefined, today: string): string;
      gaugesHtml(baseline: import("./client-api.js").ClientRecoveryBaselineRead | null | undefined, today: string): string;
      sparkSvg(points: Array<{ date: string; weight_lb: number }> | null | undefined, goal: number | null | undefined): string;
      kmNote(planned: number | null | undefined, longDate: string | null | undefined): string;
      blockLine(phase: string | null | undefined, block: { week_index?: unknown; total_weeks?: unknown } | null | undefined): string;
      nightWord(band: import("./client-api.js").ClientRecoveryBaselineDimension, today: string): string;
    };

    /** Lazy (today-ahead bundle). */
    CairnTodayHorizon: {
      horizonHtml(path: import("./today-path.js").TodayPath | null | undefined): string;
      /** The one new-connection line at Today's foot; "" without a new insight. */
      connectionHtml(insight?: { id?: unknown; text?: unknown; kind?: unknown; status?: unknown } | null): string;
      insightSentence(insight: { id?: unknown; text?: unknown; kind?: unknown; status?: unknown } | null | undefined): string;
    };

    /** Lazy (today-ahead bundle). */
    CairnTodayAhead: {
      slots: Record<string, string>;
      mount(
        root: Element,
        deps: {
          date: string;
          read: {
      periodization_context?: {
        program_block?: { week_index?: unknown; total_weeks?: unknown } | null;
        recovery_overlay?: { day_index?: unknown; total_days?: unknown } | null;
      } | null;
    } | null;
          agenda(): Promise<unknown>;
          peek(key: string): { data: unknown; fresh: boolean } | null;
          load(path: string, options: { key: string }): Promise<unknown>;
          api(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
          toast(message: string, options?: { action?: string; onAction?: () => void }): void;
          gotoChatWith(text: string): void;
          openChanges(): void;
          openCheckup(): void;
          openRace(): void;
          openPlanCoach(): void;
          refreshToday(): unknown;
          invalidate(key: string): void;
        }
      ): () => void;
    };

    CairnTodayFuelGlance: {
      model(day: unknown, ideas: unknown): unknown;
      html(model: unknown): string;
      skeletonHtml(): string;
      /** Stand the glance's slot under the Brief's NOW card (after its steer line). */
      place(brief: Element, slot: Element): void;
      mountToday(
        root: ParentNode,
        deps: { date: string; activateTab(tab: string): unknown; state: { planJump?: string | null } }
      ): () => void;
    };

    CairnTodayMainShell: {
      /** Take the Brief's mounted slots (stones, fuel) out of `from`; the returned call stands them in the new Brief. */
      carryBriefSlots(from: Element): (into: Element) => void;
      leadHtml(
        options: {
          isToday: boolean;
          briefHtml: string;
          conductorHtml: string;
          currentWeight: unknown;
        },
        deps: {
          escapeHtml(value: unknown): string;
        }
      ): string;
      weekFoldHtml(
        compass: { weekRecap?: string | null; cellsHtml?: string; planned?: number; done?: number; weekKm?: number },
        deps: { escapeHtml(value: unknown): string },
        options?: {
          currentWeight?: unknown;
          trendLbWk?: unknown;
          liftOpen?: unknown;
          runs?: boolean;
          weekCardio?: unknown;
        }
      ): string;
      digestSlotHtml(): string;
      aheadSlotsHtml(): string;
      wrapHtml(content: string, options: { railHtml: string }): string;
    };

    CairnTodayPlanSurface: {
      sessionHeadHtml(
        options: {
          isRunDay: boolean;
          isToday: boolean;
          day: Record<string, unknown> | null | undefined;
          exDone: number;
          exTotal: number;
          hasSyncedCardioToday: boolean;
        },
        deps: {
          escapeHtml(value: unknown): string;
          escapeAttr(value: unknown): string;
          stagger(index?: number | null): string;
          rxMoveCount(rxByEx: Record<string, unknown>): number;
          setsTonnage(sets: unknown): number;
          lastSetLineText?(lastSet: unknown): string;
        }
      ): string;
      daySwitchHtml(
        plan: Array<Record<string, unknown>>,
        activeDay: unknown,
        deps: { escapeHtml(value: unknown): string },
        recovery?: Record<number, { recovering_groups?: string[]; mostly_recovering?: boolean }> | null,
        pick?: boolean
      ): string;
      rxBannerHtml(
        rxByEx: Record<string, unknown>,
        day: unknown,
        deps: {
          escapeAttr(value: unknown): string;
          escapeHtml(value: unknown): string;
          rxMoveCount(rxByEx: Record<string, unknown>): number;
          stagger(index?: number | null): string;
        }
      ): string;
      addExerciseFormHtml(): string;
      finishHtml(
        session: { sets?: unknown[] | null; notes?: unknown },
        options: { isToday: boolean; logDate: string },
        deps: { escapeAttr(value: unknown): string; setsTonnage(sets: unknown): number }
      ): string;
      lastSetLineHtml(
        lastSet: unknown,
        deps: { escapeHtml(value: unknown): string; lastSetLineText?(lastSet: unknown): string }
      ): string;
      runLineHtml(
        agenda: unknown,
        options: { date: string; units?: "km" | "mi"; syncLine?: string },
        deps: { escapeHtml(value: unknown): string; formatDistance?(km: unknown, units?: unknown): string }
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
          strengthItems: Array<Record<string, unknown>>;
          activeItems: Array<Record<string, unknown>>;
          skippedItems: Array<Record<string, unknown>>;
          loggedByEx: Record<string, unknown[]>;
          offPlanEx: string[];
          pendingOffPlan: Array<{ name: string; mode?: string | null }>;
          lastSets: Record<string, Record<string, unknown> | null | undefined>;
          rxByEx: Record<string, unknown>;
          strengthJourney: ClientStrengthJourney | null;
          exDone: number;
          exTotal: number;
          hasSyncedCardioToday: boolean;
          hasLoggedSets: boolean;
          hasGarmin: boolean;
          isRunDay: boolean;
          planDayRecovery?: Record<number, { recovering_groups?: string[]; mostly_recovering?: boolean }> | null;
          prefillFor(item: Record<string, unknown>): {
            weight?: unknown;
            reps?: unknown;
            rir?: unknown;
            duration_sec?: unknown;
          };
          attributionFor?(item: Record<string, unknown>): {
            key: string;
            exercise: string;
            sets: unknown[];
            siblings: number;
          } | null;
          rxFor(name: unknown): unknown;
        },
        deps: {
          planSurface: Window["CairnTodayPlanSurface"];
          planSurfaceDeps(): Parameters<Window["CairnTodayPlanSurface"]["sessionHeadHtml"]>[1];
          exCard(
            item: Record<string, unknown>,
            logged: unknown[],
            prefill: Record<string, unknown>,
            index: number,
            rx: unknown
          ): string;
          garminSessionCard(value: unknown): string;
          sessionDoneCard(session: unknown, day: unknown, options: { isToday: boolean }): string;
          skipLineHtml(labels: string[]): string;
        }
      ): string;
    };

    CairnTodayPostRenderWiring: {
      wirePostRender(deps: {
        root: HTMLElement;
        state: {
          logDate: string;
          day: number | null;
          dayPicked?: boolean;
          dayPickedOn?: string | null;
          chatPrefill?: string | null;
          capturePrefill?: string | null;
        };
        read: { _provisional?: boolean } | null | undefined;
        isToday: boolean;
        showPlan: boolean;
        soft: boolean;
        conductorLeads: boolean;
        agenda: Partial<ClientTodayAgenda> | null | undefined;
        agendaGeneric: ClientTodayAgendaCandidate[];
        updateHeaderCondense(): void;
        runCountUps(root?: ParentNode | null, options?: { snap?: boolean }): void;
        reducedMotion(): boolean;
        wireCardioSync(root: ParentNode, onSync: () => unknown): unknown;
        renderToday(opts?: Record<string, unknown>): unknown;
        applyDayProgression(button: Element | null | undefined, day: number | null | undefined): unknown;
        wireBrief(read: { _provisional?: boolean } | null | undefined, options: { isToday: boolean }): unknown;
        upgradeBriefInPlace(date: string, isToday: boolean): unknown;
        loadTrainingProvenance(isToday: boolean): unknown;
        loadTableHint(): unknown;
        setupWeightChip(): unknown;
        loadContextBanner(): unknown;
        loadHealthFocusBanner(): unknown;
        loadWearable(isToday: boolean): unknown;
        loadCheckin(): unknown;
        loadTagChips(): unknown;
        runAgendaRail(
          agenda: Partial<ClientTodayAgenda> | null | undefined,
          genericPending: ClientTodayAgendaCandidate[],
          deps: ClientTodayRailControllerDeps
        ): void;
        runFallbackRail(isToday: boolean, deps: ClientTodayRailControllerDeps): void;
        todayRailDeps(): ClientTodayRailControllerDeps;
        activateTab(tab: string): unknown;
        withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
        viewEnter(): void;
        localISO(): string;
        toast(message: string): void;
      }): void;
      applyPendingCapture(deps: Parameters<Window["CairnTodayPostRenderWiring"]["wirePostRender"]>[0]): boolean;
    };

    CairnTodayDependencies: ClientTodayDependenciesApi;
    CairnTodayCompatibilityBridges: ClientTodayCompatibilityBridgesApi;
    CairnTodayScreenRuntimeDeps: ClientTodayScreenRuntimeDepsApi;
    CairnTodayScreenRuntime: ClientTodayScreenRuntimeApi;

    CairnTodayTraining: {
      RX_ACTION: Record<string, { word: string; cls: string }>;
      rxTargetText(rx: Partial<ClientPrescription> | null | undefined): string;
      exRxVaryMenuHtml(rx: Partial<ClientPrescription> | null | undefined): string;
      exRxLineHtml(rx: Partial<ClientPrescription> | null | undefined, options?: { supporting?: boolean }): string;
      rxMoveCount(
        rxByExercise: Record<string, Partial<ClientPrescription> | null | undefined> | null | undefined
      ): number;
    };

    CairnTodayProgressionController: {
      scheduleRxRefresh(deps: {
        state: { tab?: string; day?: string | number | null; logDate?: string };
        root: ParentNode;
        cachedApi(path: string, options?: { key?: string; freshFor?: number }): Promise<unknown>;
        invalidate(keyOrPrefix: string): void;
        exRxLineHtml(rx: unknown, options?: { supporting?: boolean }): string;
        moveCount(rxByEx: Record<string, unknown>): number;
        loadProgramAdjustmentsBanner(): unknown;
      }): void;
      invalidateTodayProgression(
        deps: Parameters<Window["CairnTodayProgressionController"]["scheduleRxRefresh"]>[0]
      ): void;
      refreshAdaptedRx(
        deps: Parameters<Window["CairnTodayProgressionController"]["scheduleRxRefresh"]>[0]
      ): Promise<void>;
    };

    CairnTodayAddExerciseController: {
      exerciseNameKey(raw: string): string;
      applyCanonicalExerciseName(
        cardEl: HTMLElement | null,
        typedName: string,
        row: { name: string; mode?: string; muscle_group?: string },
        deps: Parameters<Window["CairnTodayAddExerciseController"]["setupAddExercise"]>[0]
      ): HTMLElement | null;
      setupAddExercise(deps: {
        root: Element;
        state: {
          logDate: string;
          exModes?: Record<string, string>;
          pendingOffPlan?: Record<string, Array<{ name: string; mode?: string | null }>>;
        };
        api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
        postExerciseMode(name: string, mode: string): Promise<unknown>;
        exCard(
          item: Record<string, unknown>,
          logged: Array<Record<string, unknown>>,
          prefill: Record<string, unknown>,
          revealIdx: unknown,
          rx: unknown,
          lastSet?: unknown
        ): string;
        wireGuides(card: Element): void;
        wireLogRow(row: Element | null): void;
        wireSkips(): void;
        toast(message: string): void;
        escapeHtml(value: unknown): string;
        escapeAttr(value: unknown): string;
        parseDur(value: string): number | null;
      }): Promise<void>;
      appendOffPlanCard(
        name: string,
        mode: string | null | undefined,
        deps: Parameters<Window["CairnTodayAddExerciseController"]["setupAddExercise"]>[0]
      ): Promise<void>;
    };

    CairnTodaySessionFeedback: {
      renderFeedback(
        slot: Element | null | undefined,
        session: Record<string, unknown>,
        deps: ClientTodaySessionFeedbackDeps,
        options?: { hasLoggedSets?: boolean }
      ): void;
    };

    CairnSessionPrimer: {
      cardHtml(primer: unknown, opts?: { collapsed?: boolean }): string;
      freshChipHtml(why: unknown, label?: unknown): string;
      hydrate(opts: {
        root?: unknown;
        date?: string | null;
        dayNumber?: number | null;
        hasLoggedSets?: boolean;
        api?: (path: string) => Promise<unknown>;
        guard?: () => boolean;
        pending?: Promise<unknown>;
      }): Promise<void>;
      mountToggle(slot: Element): () => void;
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
        options?: { hasLoggedSets?: boolean }
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
        options?: {
          day?: unknown;
          exModes?: Record<string, unknown> | null;
          exInputs?: Record<string, unknown> | null;
        },
        lastSet?: unknown
      ): string;
      revealLoad(scope: Element | null | undefined, opts?: { focus?: boolean }): void;
      revealLoadForLastSet(scope: Element | null | undefined, lastSet: Record<string, unknown>): void;
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
      meta(read: Partial<ClientDayRead> | null | undefined): {
        word: string;
        glyph: string;
        lead: string;
        kicker?: string;
      };
      provisionalRead(): ClientDayRead & { _provisional: boolean };
      redirectHtml(action: unknown, label: unknown, primary?: boolean): string;
      visibleOverrides(args: {
        kind?: unknown;
        estMinutes?: unknown;
        activeOverride?: unknown;
      }): Array<{ intent: string; label: string }>;
      attentionPrimary(read: Partial<ClientDayRead> | null | undefined): string;
      yieldsLead(read: Partial<ClientDayRead> | null | undefined): boolean;
      briefHtml(
        read:
          | (Partial<ClientDayRead> & { _provisional?: unknown; _failed?: unknown; override?: unknown })
          | null
          | undefined,
        options?: {
          showPlan?: boolean;
          showDone?: boolean;
          isToday?: boolean;
          nothingToStart?: boolean;
          activeOverride?: unknown;
          morph?: boolean;
          reducedMotion?: boolean;
          tradeRefused?: boolean;
          planDayName?: unknown;
          session?: {
            date: string;
            started: boolean;
            progress: string;
            minutes: number | null;
            lines: string[];
            preview?: unknown;
          } | null;
        }
      ): string;
      distinctLine(candidate: unknown, ...shown: unknown[]): string;
      updatedHtml(read: Partial<ClientDayRead> | null | undefined, kind: string, isToday?: boolean): string;
      updatedInnerHtml(read: Partial<ClientDayRead> | null | undefined, kind: string, isToday?: boolean): string;
      checkinSlotHtml(kind: string, isToday: boolean): string;
      overriddenMornings(read: Partial<ClientDayRead> | null | undefined): number;
      planDayLabel(name: unknown): string;
      materiallyDiffers(
        a: (Partial<ClientDayRead> & { _provisional?: unknown }) | null | undefined,
        b: (Partial<ClientDayRead> & { _provisional?: unknown }) | null | undefined
      ): boolean;
      signalsText(read: Partial<ClientDayRead> | null | undefined): string;
      signalsRows(
        read: Partial<ClientDayRead> | null | undefined
      ): Array<{ label: string; state: string; tone: "ok" | "watch" | "quiet" }>;
    };

    CairnTodayBriefOverrideClient: {
      paintBriefReshaping(brief: Element, chip: HTMLElement | null, deps: ClientTodayBriefOverrideDeps): void;
      dayReadOverrideOpOpts(
        args: { intent?: string; prevFocus?: unknown } | undefined,
        deps: ClientTodayBriefOverrideDeps
      ): ClientTodayBriefOverrideRunOptions;
      reconnectDayReadOverride(job: unknown, deps: ClientTodayBriefOverrideDeps): ClientAgentOpHandlers | null;
    };

    CairnTodayBriefActionsClient: {
      // True once the server has refused a rest-trade on that date, so the Brief
      // stops re-offering it on every repaint.
      tradeRefusedOn(date: unknown): boolean;
      wireBriefActions(
        read: Partial<ClientDayRead> & { _provisional?: unknown; override?: unknown },
        options: { isToday?: boolean },
        deps: ClientTodayBriefActionsDeps
      ): void;
    };

    CairnTodayBriefController: {
      provisionalRead(date: string): ClientDayRead & { _provisional: boolean };
      loadBrief(
        date: string,
        override: string,
        deps: ClientTodayBriefControllerDeps,
        opts?: { fast?: boolean }
      ): Promise<ClientDayRead & { _provisional?: boolean; _failed?: boolean; override?: string | null }>;
      upgradeBriefInPlace(date: string, isToday: boolean, deps: ClientTodayBriefControllerDeps): Promise<void>;
      reshapeToday(deps: ClientTodayBriefControllerDeps): Promise<void>;
      /** Reconcile the Brief in place after a small signal (a check-in tap). */
      refreshBriefInPlace(deps: ClientTodayBriefControllerDeps): Promise<void>;
      briefHtml(
        read:
          | (Partial<ClientDayRead> & { _provisional?: unknown; _failed?: unknown; override?: unknown })
          | null
          | undefined,
        options: { showPlan?: unknown; showDone?: unknown; isToday?: unknown; nothingToStart?: unknown },
        deps: ClientTodayBriefControllerDeps
      ): string;
      briefSignalsText(read: Partial<ClientDayRead> | null | undefined): string;
      wireBrief(
        read: Partial<ClientDayRead> & { _provisional?: unknown; override?: unknown },
        options: { isToday?: boolean },
        deps: ClientTodayBriefControllerDeps
      ): void;
      paintBriefReshaping(brief: Element, chip: HTMLElement | null, deps: ClientTodayBriefControllerDeps): void;
      dayReadOverrideOpOpts(
        args: { intent?: string; prevFocus?: unknown } | undefined,
        deps: ClientTodayBriefControllerDeps
      ): ClientAgentOpHandlers;
      reconnectDayReadOverride(job: unknown, deps: ClientTodayBriefControllerDeps): ClientAgentOpHandlers | null;
    };

    CairnCaptureProvenance: {
      activeDirectives(): Promise<ClientDirective[]>;
      provenanceLineHtml(
        directive:
          | (ClientDirective & { citation?: unknown; directive?: unknown; uncertain?: unknown })
          | null
          | undefined,
        label: string
      ): string | null;
      wireProvenance(scope?: ParentNode | null): void;
      loadTrainingProvenance(isToday?: boolean): Promise<void>;
      loadMealProvenance(): Promise<void>;
    };

    CairnCaptureReadDate: CaptureReadDateApi;
    CairnCaptureReadCards: CaptureReadCardsApi;
    CairnCaptureReadJobs: CaptureReadJobsApi;
    CairnCaptureReads: CaptureReadsRuntime;

    CairnTodayBriefCache: {
      read(date: string): TodayBriefControllerDayRead | null;
      persist(date: string, override: string, read: TodayBriefControllerDayRead | null | undefined): void;
    };

    CairnTodaySessionLaunch: {
      facts(opts: SessionLaunchOptions): SessionLaunchFacts;
      cardHtml(opts: SessionLaunchOptions, decisionLabel: string | null): string;
    };

    CairnMealJournal: {
      /** The week menu's page frame: back link, lede, the menu slot, the history link. */
      menuPageHtml(): string;
      /** The week menu (/app/today/menu) into its slot; "today" scrolls to today's day once. */
      paintMenu(
        token: number,
        slot: HTMLElement,
        peek: SwrPeek<import("./client-api.js").ClientMealPlan[]> | null,
        focus?: "today" | "week",
      ): Promise<unknown>;
      /** Past weeks (every week but the current menu, the scheduled one and the fresh draft it offers) into Fuel's fold. */
      paintHistory(
        token: number,
        slot: HTMLElement,
        peek: SwrPeek<import("./client-api.js").ClientMealPlan[]> | null,
      ): Promise<unknown>;
      /** One reading of the plan list: the current week, the scheduled one, fresh drafts the menu offers, the past. */
      weeks(plans: unknown): {
        current: Record<string, unknown> | null;
        upcoming: Record<string, unknown> | null;
        drafts: Record<string, unknown>[];
        past: Record<string, unknown>[];
      };
    };

    CairnMealMenuCard: {
      model(
        plans: unknown,
        now?: unknown,
      ):
        | { kind: "empty" }
        | {
            kind: "week";
            status: "review" | "coming" | "kept";
            needsRefresh: boolean;
            dayName: string;
            meals: Array<{ slot: string; name: string; items: string; kcal: number | null; query: string }>;
          };
      cardHtml(model: ReturnType<Window["CairnMealMenuCard"]["model"]>): string;
      skeletonHtml(): string;
    };

    CairnMealMenuCardController: {
      mount(
        host: HTMLElement,
        deps: { isCurrent(): boolean; openMenu(focus: "today" | "week"): void },
      ): (() => void) & { refresh(): Promise<void>; ready: Promise<void> };
    };

    CairnCaptureCheckin: {
      loadCheckin(): Promise<void>;
    };

    CairnCaptureVoice: {
      micGlyph: string;
      setup(deps: {
        mic: HTMLElement;
        input: HTMLInputElement | HTMLTextAreaElement;
        onDictated?(): void;
        signal?: AbortSignal;
      }): void;
    };

    CairnTodaySessionSuggest: {
      SESSION_VIBES: string[];
      itemHtml(item: Partial<ClientSessionSuggestion["items"][number]> | null | undefined, index?: number): string;
      cardHtml(session: Partial<ClientSessionSuggestion> | null | undefined, verified?: unknown): string;
      loadingHtml(): string;
      failureHtml(result?: unknown): string;
      composerHtml(vibes?: readonly string[]): string;
      fillSlot(slot: Element, html: string, reducedMotion: boolean, block: ScrollLogicalPosition | null): void;
    };

    CairnTodaySessionSuggestController: {
      askForSession(
        opts: { minutes?: unknown; focus?: unknown; equipment?: unknown; constraints?: unknown } | undefined,
        deps: {
          root: ParentNode;
          state: {
            logDate?: string;
            suggestedSession?: ClientSessionSuggestion | null;
            suggestedSessionContext?: {
              agentJobId?: number | null;
              constraints?: Record<string, unknown>;
              provenance?: Record<string, unknown>;
            } | null;
          };
          api(
            path: string,
            opts?: RequestInit & { headers?: Record<string, string>; acceptErrorBody?: boolean }
          ): Promise<unknown>;
          storeCached(key: string, data: unknown): void;
          invalidate(key: string): void;
          openSession(date?: string | null, options?: Record<string, unknown>): unknown;
          runOp(
            kind: "session_suggest",
            body: Record<string, unknown>,
            options: ClientAgentOpHandlers
          ): Promise<unknown>;
          thinkingCaption(el: Element, op?: string): () => void;
          runCountUps(scope?: ParentNode | null, options?: { snap?: boolean }): void;
          collapseEl(el: Element, done?: () => void): void;
          reducedMotion(): boolean;
          toast(message: string): void;
        }
      ): Promise<void>;
      cachedContinuation(
        cachedSession: unknown,
        cachedDailySession: unknown,
        explicitReplacement: boolean,
        hasPreparePrerequisite?: (id: string) => boolean
      ): {
        ok: true;
        reused: true;
        staged: boolean;
        session: Record<string, unknown>;
        daily_session: Record<string, unknown>;
      } | null;
      stageCachedContinuation(
        continuation: { session: Record<string, unknown>; daily_session: Record<string, unknown> },
        localPrepareId: string
      ): {
        ok: true;
        reused: true;
        staged: true;
        session: Record<string, unknown>;
        daily_session: Record<string, unknown>;
      } | null;
      snapshotRecovery(
        dailySession: unknown,
        originalRequest: unknown
      ): { body: Record<string, unknown>; intent: Record<string, unknown> } | null;
      createPrepareCoordinator(): {
        run<T>(
          date: string,
          task: () => Promise<T>
        ): Promise<{ current: boolean; ok: true; value: T } | { current: boolean; ok: false; error: unknown }>;
      };
      reconnectSessionSuggest(
        job: unknown,
        deps: Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[1]
      ): unknown;
      revealSessionComposer(deps: Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[1]): void;
      sessionSuggestOpOpts(
        deps: Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[1],
        request?: Record<string, unknown>
      ): ClientAgentOpHandlers;
      wireSuggestCard(
        slot: Element,
        deps: Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[1]
      ): void;
    };

    CairnTodaySessionStatus: {
      FEEL_FACES: readonly string[];
      setChipHtml(set: Record<string, unknown> | null | undefined, index?: number): string;
      setsTonnage(sets: unknown): number;
      sessionDoneCardHtml(
        session: Record<string, unknown> | null | undefined,
        day: { name?: unknown } | null | undefined,
        options?: { isToday?: boolean }
      ): string;
      outcomeReadHtml(
        read:
          | {
              athlete_read?: { learning?: unknown; next_exposure?: unknown } | null;
            }
          | null
          | undefined,
        idAttr: string
      ): string;
      hydrateOutcome(sessionId: string, renderSequence: number, attempt?: number): Promise<void>;
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

    CairnPlanWeek: {
      stripHtml(week: unknown): string;
      annotationsByDayNumber(week: unknown): Map<number, { weekday: string | null; status: import("./client-api.js").ClientPlanWeekStatus; label?: string | null }>;
      days(week: unknown): import("./client-api.js").ClientPlanWeekDay[];
      statusLine(day: import("./client-api.js").ClientPlanWeekDay): string;
      pickDay(root: Element, index: number): void;
    };

    CairnTodayContext: {
      CONTEXT_ICONS: Record<string, string>;
      CONTEXT_NEAR_DAYS: number;
      daysUntil(startISO: unknown, todayISO?: string): number | null;
      eventCountdown(days: unknown): string;
      isNearTermContext(event: unknown, todayISO?: string): boolean;
      contextBannerLine(event: unknown, todayISO?: string): string;
      contextBannerHtml(events: unknown, todayISO?: string, spoken?: string): string;
      goalLineHtml(stats: unknown, currentWeight: unknown, isToday: unknown, todayISO?: string): string;
      healthFocusLine(data: unknown): string;
      healthFocusBannerHtml(data: unknown): string;
    };

    CairnTodayCompass: {
      fmtPace(value: unknown): string;
      paceWord(stats: unknown): string;
      paceTileHtml(
        stats: unknown,
        deps: {
          escapeHtml(value: unknown): string;
          escapeAttr(value: unknown): string;
          formatKm(value: unknown): string;
        }
      ): string;
      build(
        stats: unknown,
        deps: {
          escapeHtml(value: unknown): string;
          escapeAttr(value: unknown): string;
          formatKm(value: unknown): string;
        },
        options?: {
          currentWeight?: unknown;
          isToday?: unknown;
          isEndurance?: unknown;
          isHybrid?: unknown;
          /** false when the weigh-in chip already rides the week row (Today). */
          weightTile?: boolean;
        }
      ): {
        planned: number;
        done: number;
        weekKm: number;
        cellsHtml: string;
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

    CairnChangesFeed: {
      feedHtml(
        data: import("./brain-changes.js").ClientBrainChanges | null | undefined,
        options?: { reveal?: boolean; enter?: boolean }
      ): string;
      /** The quiet "Set aside" lines under the changes; "" with none. */
      setAsideHtml(data: import("./brain-changes.js").ClientBrainChanges | null | undefined): string;
      rowHtml(
        change: import("./brain-changes.js").ClientBrainChange,
        options?: { index?: number | null; enter?: boolean; settled?: boolean }
      ): string;
      dayShellHtml(day: import("./brain-changes.js").ClientBrainChangeDay, rows?: string): string;
      dayLabel(day: import("./brain-changes.js").ClientBrainChangeDay): string;
      errorHtml(): string;
      undoAttr(change: import("./brain-changes.js").ClientBrainChange): string;
    };

    CairnChangesFeedController: {
      KEY: string;
      PATH: string;
      mount(host: Element, deps: ClientChangesFeedDeps): () => void;
    };

    CairnAskCard: {
      asksHtml(rows: unknown): string;
      askCardHtml(ask: { id: number; summary: string; explanation: string; forClinician: boolean }): string;
      askModels(rows: unknown): Array<{ id: number; summary: string; explanation: string; forClinician: boolean }>;
      talkPrefill(rows: unknown, id: unknown): string;
    };

    CairnAskCardController: {
      KEY: string;
      PATH: string;
      mount(
        host: Element,
        deps: {
          peekCached<T = unknown>(key: string): { data: T; fresh: boolean } | null;
          cachedApi(
            path: string,
            options?: { key?: string; onUpgrade?(data: unknown, meta: { changed: boolean }): void }
          ): Promise<unknown>;
          gotoChatWith(text: string): unknown;
        }
      ): () => void;
    };

    CairnFoodComposerModel: {
      message(text: unknown): string;
      requestBody(
        message: string,
        options: { mode?: unknown; requestId: string; image?: FoodComposerImage | null }
      ): FoodComposerRequestBody;
      chipText(summary: unknown, mode: unknown): string;
      mode(value: unknown): FoodComposerMode;
      turnId(turn: unknown): number | null;
      turnTerminal(turn: unknown): boolean;
      loggedNotes(turn: unknown): FoodComposerLoggedNote[];
      outcome(turn: unknown): FoodComposerOutcome | null;
    };

    CairnFoodComposerClient: {
      html(options?: { idPrefix?: string; mode?: FoodComposerMode; placeholder?: string }): string;
      frequentChipsHtml(foods: unknown): string;
      idPrefix(value: unknown): string;
    };

    CairnFoodComposerTurn: {
      follow(
        turn: unknown,
        deps: Pick<FoodComposerDeps, "api" | "toast" | "onLogged" | "wait">,
        ctx: { signal: AbortSignal; setStatus(text: string): void },
      ): Promise<void>;
    };

    CairnFoodComposerChips: {
      wire(slot: HTMLElement, input: HTMLTextAreaElement, deps: FoodComposerDeps, signal: AbortSignal): { hide(): void };
    };

    CairnFoodComposer: {
      mount(host: Element, deps: FoodComposerDeps): FoodComposerHandle;
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
  declare const CairnMealFuelContext: Window["CairnMealFuelContext"];
  declare const CairnChatEarlierHistory: Window["CairnChatEarlierHistory"];
  declare const CairnExerciseDetail: Window["CairnExerciseDetail"];
  declare const CairnExerciseDetailData: Window["CairnExerciseDetailData"];
  declare const CairnExerciseDetailExplanation: Window["CairnExerciseDetailExplanation"];
  declare const CairnExerciseDetailRender: Window["CairnExerciseDetailRender"];
  declare const CairnExerciseDetailActions: Window["CairnExerciseDetailActions"];
  declare const CairnExerciseGuide: Window["CairnExerciseGuide"];
  declare const CairnExerciseDetailController: Window["CairnExerciseDetailController"];
  declare const CairnUi: Window["CairnUi"];
  declare const CairnUiReads: Window["CairnUiReads"];
  declare const CairnUiFeedback: Window["CairnUiFeedback"];
  declare const CairnUiActions: Window["CairnUiActions"];
  declare const CairnUiSheet: Window["CairnUiSheet"];
  declare const CairnUiChart: Window["CairnUiChart"];
  declare const CairnDecisionUndo: Window["CairnDecisionUndo"];
  declare const CairnDecisionUndoController: Window["CairnDecisionUndoController"];
  type ClientDecisionUndoDeps = {
    api(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string, options?: { action?: string; onAction?: () => void }): void;
  };
  type ClientDecisionUndoCopy = {
    reason: string;
    success: string;
    stale: string;
    failed: string;
    after?(): unknown;
  };
  type ClientUiSheetHandle = {
    overlay: HTMLElement;
    sheet: HTMLElement;
    close(options?: { instant?: boolean; reason?: "escape" | "backdrop" | "button" | "api" }): void;
    isOpen(): boolean;
  };
  declare const CairnUiHeader: Window["CairnUiHeader"];
  declare const CairnUiViewTransitions: Window["CairnUiViewTransitions"];
  declare const CairnDetailOverlay: Window["CairnDetailOverlay"];
  declare const CairnDicomViewerModel: Window["CairnDicomViewerModel"];
  declare const CairnDicomViewer: Window["CairnDicomViewer"];
  declare const CairnImagingUploadModel: Window["CairnImagingUploadModel"];
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
  declare const CairnHealthBeliefs: Window["CairnHealthBeliefs"];
  declare const CairnHealthBeliefsLoader: Window["CairnHealthBeliefsLoader"];
  declare const CairnMemory: Window["CairnMemory"];
  declare const CairnMeMemoryController: Window["CairnMeMemoryController"];
  declare const CairnFamily: Window["CairnFamily"];
  declare const CairnFamilyController: Window["CairnFamilyController"];
  declare const CairnLife: Window["CairnLife"];
  declare const CairnLifeFormHelpers: Window["CairnLifeFormHelpers"];
  declare const CairnLifeTimelineActions: Window["CairnLifeTimelineActions"];
  declare const CairnLifeController: Window["CairnLifeController"];
  declare const CairnHealthDocs: Window["CairnHealthDocs"];
  declare const CairnImaging: Window["CairnImaging"];
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
  declare const CairnMealJournal: Window["CairnMealJournal"];
  declare const CairnMealMenuCard: Window["CairnMealMenuCard"];
  declare const CairnMealMenuCardController: Window["CairnMealMenuCardController"];
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
  declare const CairnJourneyTimeline: Window["CairnJourneyTimeline"];
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
  declare const CairnChangesLine: Window["CairnChangesLine"];
  declare const CairnChangesLineController: Window["CairnChangesLineController"];
  type ClientChangesLineModel = { count: number; line: string; ids: number[] };
  type ClientChangesLineDeps = {
    peek(key: string): { data: import("./brain-changes.js").ClientBrainChanges; fresh: boolean } | null;
    load(path: "/brain/changes", options: { key: string }): Promise<import("./brain-changes.js").ClientBrainChanges>;
    open(): void;
    reducedMotion(): boolean;
  };
  declare const CairnTodaySideLoaders: Window["CairnTodaySideLoaders"];
  declare const CairnTodayPlanSelection: Window["CairnTodayPlanSelection"];
  declare const CairnTodayPlanSessionModel: Window["CairnTodayPlanSessionModel"];
  declare const CairnTodayPlanSessionData: Window["CairnTodayPlanSessionData"];
  declare const CairnTodayPlanSessionPreparation: Window["CairnTodayPlanSessionPreparation"];
  declare const CairnTodayDataLoader: Window["CairnTodayDataLoader"];
  declare const CairnTodayMainShell: Window["CairnTodayMainShell"];
  declare const CairnTodayFuelGlance: Window["CairnTodayFuelGlance"];
  declare const CairnTodayWorth: Window["CairnTodayWorth"];
  declare const CairnTodayPath: Window["CairnTodayPath"];
  declare const CairnTodayPathController: Window["CairnTodayPathController"];
  declare const CairnTodayAheadMount: Window["CairnTodayAheadMount"];
  declare const CairnTodayDigest: Window["CairnTodayDigest"];
  declare const CairnTodayWeek: Window["CairnTodayWeek"];
  declare const CairnTodayHorizon: Window["CairnTodayHorizon"];
  declare const CairnTodayAhead: Window["CairnTodayAhead"];
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
  declare const CairnSessionPrimer: Window["CairnSessionPrimer"];
  declare const CairnTodaySessionSkip: Window["CairnTodaySessionSkip"];
  declare const CairnTodaySessionSetModel: Window["CairnTodaySessionSetModel"];
  declare const CairnTodaySessionSetActions: Window["CairnTodaySessionSetActions"];
  declare const CairnTodaySessionController: Window["CairnTodaySessionController"];
  declare const CairnTodayCards: Window["CairnTodayCards"];
  declare const CairnTodayLately: Window["CairnTodayLately"];
  declare const CairnTodaySessionStatus: Window["CairnTodaySessionStatus"];
  declare const CairnTodayProgramAdjustments: Window["CairnTodayProgramAdjustments"];
  declare const CairnTodayWeekAhead: Window["CairnTodayWeekAhead"];
  declare const CairnPlanWeek: Window["CairnPlanWeek"];
  declare const CairnTodayContext: Window["CairnTodayContext"];
  declare const CairnTodayCompass: Window["CairnTodayCompass"];
  declare const CairnTodayGarminReconciliation: Window["CairnTodayGarminReconciliation"];
  declare const CairnChangesFeed: Window["CairnChangesFeed"];
  declare const CairnChangesFeedController: Window["CairnChangesFeedController"];
  declare const CairnAskCard: Window["CairnAskCard"];
  declare const CairnAskCardController: Window["CairnAskCardController"];
  type ClientChangesFeedDeps = {
    api(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string, options?: { action?: string; onAction?: () => void }): void;
    peekCached<T = unknown>(key: string): { data: T; fresh: boolean } | null;
    cachedApi(
      path: string,
      options?: { key?: string; onUpgrade?(data: unknown, meta: { changed: boolean }): void }
    ): Promise<unknown>;
    swrInvalidate(key: string): void;
    reducedMotion(): boolean;
    markRefreshing?(on: boolean): void;
    collapse?(el: Element, done: () => void): void;
    skeleton?(): string;
    onReverted?(change: import("./brain-changes.js").ClientBrainChange | null): unknown;
    /** "Talk it through": hand the change to chat, pre-filled. */
    talk?(text: string): void;
  };

  // ---- v2 wave 2 · meal card (meal-card-model.ts, meal-card-client.ts, meal-card-controller.ts) ----
  type ClientMealCardMacroKey = "kcal" | "protein_g" | "carbs_g" | "fat_g" | "fiber_g";
  type ClientMealCardTotals = Record<ClientMealCardMacroKey, number | null>;
  /** One editable row, in the src/foodCapture.ts ingredient shape plus its edit state. */
  type ClientMealCardRow = {
    key: string;
    item: string;
    /** The logged quantity as its own field ("205 g", "2 eggs"). */
    amount: string;
    /** Grams the stored row stated, or null when its amount carries no weight. */
    baseGrams: number | null;
    /** Grams now (what the field holds). */
    grams: number | null;
    /** The stored row's macros, at baseGrams. */
    base: Record<ClientMealCardMacroKey, number | null>;
    basis: string | null;
    /** "low" only when the server marked the row a rough estimate after an edit. */
    confidence: "low" | null;
    added: boolean;
    edited: boolean;
  };
  type ClientMealCardModel = {
    id: number | null;
    rows: ClientMealCardRow[];
    totals: ClientMealCardTotals;
    basis: string | null;
    provenance: string;
  };
  type ClientMealCardDeps = {
    /** The food note (GET /api/food-notes/:id row) the card edits. */
    note: unknown;
    api(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast?(message: string): void;
    expandEl?(el: Element): void;
    collapseEl?(el: Element, done: () => void): void;
    reducedMotion?(): boolean;
    /** false: the host prints the totals itself (from onTotals). */
    totals?: boolean;
    /** Live totals: optimistic while editing, the server's once saved. */
    onTotals?(totals: ClientMealCardTotals, meta: { saved: boolean; unsaved: boolean }): void;
    /** The updated note the PUT returned. */
    onSaved?(note: unknown): void;
  };
  type CairnMealCardModelApi = {
    MACRO_KEYS: readonly ClientMealCardMacroKey[];
    gramsFromAmount(amount: unknown): number | null;
    /** parseFoodQuantity (src/foodCapture.ts) on this side of the PUT. */
    quantityOf(amount: unknown): { value: number; unit: string } | null;
    parseGramsInput(value: unknown): number | null;
    formatGrams(grams: number | null): string;
    portionWords(amount: unknown): string;
    mealCardModel(note: unknown): ClientMealCardModel;
    mealCardRows(note: unknown): ClientMealCardRow[];
    storedTotals(note: unknown): ClientMealCardTotals;
    rowMacros(row: ClientMealCardRow): Record<ClientMealCardMacroKey, number | null>;
    optimisticTotals(
      stored: ClientMealCardTotals,
      original: readonly ClientMealCardRow[],
      current: readonly ClientMealCardRow[]
    ): ClientMealCardTotals;
    rowBody(row: ClientMealCardRow): Record<string, unknown>;
    rowsChanged(original: readonly ClientMealCardRow[], rows: readonly ClientMealCardRow[]): boolean;
    savableRows(rows: readonly ClientMealCardRow[]): ClientMealCardRow[];
    rowBasisLine(row: ClientMealCardRow, mealBasis: unknown): string;
    rowNoteLine(row: ClientMealCardRow, mealBasis: unknown): string;
    basisWords(basis: unknown): string;
    confidenceWords(confidence: unknown): string;
  };
  interface Window {
    CairnMealCardModel: CairnMealCardModelApi;
    CairnMealCard: {
      mealCardHtml(model: ClientMealCardModel, opts?: { totals?: boolean; editing?: boolean }): string;
      readRowHtml(row: ClientMealCardRow): string;
      rowKcalText(row: ClientMealCardRow): string;
      rowMacroText(row: ClientMealCardRow): string;
      macroSplitHtml(totals: ClientMealCardTotals): string;
      rowHtml(row: ClientMealCardRow, opts?: { mealBasis?: unknown }): string;
      rowMainHtml(row: ClientMealCardRow, opts?: { mealBasis?: unknown }): string;
      rowNutriText(row: ClientMealCardRow): string;
      totalsText(totals: ClientMealCardTotals): string;
    };
    CairnMealCardController: {
      mount(host: Element, deps: ClientMealCardDeps): () => void;
    };
  }
  declare const CairnMealCardModel: Window["CairnMealCardModel"];
  declare const CairnMealCard: Window["CairnMealCard"];
  declare const CairnMealCardController: Window["CairnMealCardController"];
  declare const CairnFoodComposerModel: Window["CairnFoodComposerModel"];
  declare const CairnFoodComposerClient: Window["CairnFoodComposerClient"];
  declare const CairnFoodComposerTurn: Window["CairnFoodComposerTurn"];
  declare const CairnFoodComposerChips: Window["CairnFoodComposerChips"];
  declare const CairnFoodComposer: Window["CairnFoodComposer"];
  type FoodComposerMode = "chat" | "food";
  type FoodComposerImage = { dataUrl: string; base64: string; mime: "image/jpeg"; bytes: number };
  type FoodComposerLoggedNote = {
    id: number;
    type: "log_food" | "update_food_note";
    meal: string | null;
    enrichment_status: string | null;
  };
  // What a food-mode send wrote: the chat turn and the food rows it logged.
  type FoodComposerLogged = { turnId: number; notes: FoodComposerLoggedNote[]; reply: string | null };
  type FoodComposerOutcome =
    | { kind: "logged"; logged: FoodComposerLogged }
    | { kind: "replied" | "failed"; reply: string | null };
  type FoodComposerParts = {
    input: HTMLTextAreaElement;
    sendBtn: HTMLButtonElement;
    fileInput: HTMLInputElement;
    attachBtn: HTMLButtonElement;
    preview: HTMLElement;
    mic?: HTMLElement | null;
    freqSlot?: HTMLElement | null;
    status?: HTMLElement | null;
  };
  // POST /api/chat body. `capture: "food"` marks a send from a surface opened to log
  // food; the server frames the turn, the athlete's words are stored as typed.
  type FoodComposerRequestBody = {
    message: string;
    request_id: string;
    capture?: "food";
    image_base64?: string;
    image_mime?: string;
  };
  type FoodComposerRetryEnvelope = { requestId: string; text: string; hasImage: boolean; expiresAt: number };
  type FoodComposerDeps = {
    // Both send the words as typed; "food" marks the send `capture: "food"` and follows
    // the turn to its logged rows. Default "chat".
    mode?: FoodComposerMode;
    // Element ids are `<idPrefix>Input`, `<idPrefix>Send`, …; default "fcomp".
    idPrefix?: string;
    placeholder?: string;
    // Adopt markup the host already holds instead of painting foodComposerHtml.
    parts?: FoodComposerParts | null;
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    // Whether the surface is showing; paste and keyboard settling bail otherwise.
    isActive?(): boolean;
    measure?(): void;
    autosizeInput?(input: HTMLTextAreaElement | HTMLInputElement): void;
    // Pre-written text, left editable and never auto-sent.
    prefill?: string | null;
    draft?: { load(): string; save(value: string): void };
    retryStore?: {
      loadRetry(): FoodComposerRetryEnvelope | null;
      saveRetry(value: FoodComposerRetryEnvelope): void;
      clearRetry(): void;
    } | null;
    retryTtlMs?: number;
    autofocus?: boolean;
    // "Usual around now" prefill chips; on unless false.
    frequents?: boolean;
    hour?(): number;
    // Host echo of a send (Chat's optimistic bubble); `rollback` runs if it never enqueued.
    onSubmit?(sent: { message: string; image: FoodComposerImage | null }): { rollback?(): void } | null | undefined;
    // The host follows the enqueued turn itself (Chat's monitor).
    onEnqueued?(turn: unknown): void;
    // The composer follows the turn and reports the food rows it logged (Fuel).
    onLogged?(logged: FoodComposerLogged): void;
    wait?(ms: number): Promise<void>;
  };
  type FoodComposerControls = {
    send(): Promise<void>;
    clearAttachment(): void;
    // Fill the composer for editing ("Start from this"); never sends.
    fill(text: string): void;
  };
  // The mount's teardown, carrying the composer's controls.
  type FoodComposerHandle = (() => void) & FoodComposerControls;

  // ---- v2 wave 2 · the Fuel surface (fuel-today-*, fuel-meals-*, fuel-log-*, idea-card-*) ----
  type ClientFuelSwrDeps = {
    peekCached<T = unknown>(key: string): { data: T; fresh: boolean } | null;
    cachedApi(
      path: string,
      options?: { key?: string; onUpgrade?(data: unknown, meta: { changed: boolean }): void }
    ): Promise<unknown>;
    swrInvalidate(key: string): void;
    reducedMotion(): boolean;
    markRefreshing?(on: boolean): void;
    skeleton?(): string;
  };
  /** "in progress" (today, food logged), "nothing logged", or no word (a past day with food). */
  type ClientFuelDayState = "in progress" | "nothing logged" | null;
  type ClientFuelMacro = { value: number | null; known: boolean };
  type ClientFuelTodayModel = {
    date: string;
    isToday: boolean;
    count: number;
    pending: number;
    state: ClientFuelDayState;
    protein: ClientFuelMacro & { anchor: number | null; toGo: number | null; aboutThere: boolean };
    energy: ClientFuelMacro;
    carbs: ClientFuelMacro;
    fat: ClientFuelMacro;
    fiber: ClientFuelMacro;
    bandWords: string | null;
    demand: import("./client.js").ClientDayFuelDemand | null;
  };
  type ClientFuelMealNote = { id: number; parsed: Record<string, unknown> };
  type ClientFuelMeal = {
    id: number;
    title: string;
    meta: string;
    kcal: number | null;
    protein_g: number | null;
    pending: boolean;
    /** The estimate ran and did not finish: the athlete can enter the numbers. */
    failed: boolean;
    /** The meal card can mount: settled, with ingredient rows to correct. */
    editable: boolean;
    /** The stored meal slot as written ("lunch", an own label; "" for none), for the totals correction. */
    slot: string;
    raw: string;
    note: ClientFuelMealNote;
    sig: string;
  };
  type ClientFuelTodayDeps = ClientFuelSwrDeps & {
    /** The day shown (YYYY-MM-DD) and the device's today. */
    date: string;
    today: string;
    runCountUps?(scope: ParentNode): void;
  };
  type ClientFuelMealsDeps = ClientFuelSwrDeps & {
    date: string;
    today: string;
    api(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    expandEl?(el: Element): void;
    collapseEl?(el: Element, done: () => void): void;
    armDelete?(btn: Element, onConfirm: () => unknown, options?: { label?: string }): void;
    /** Follows a still-estimating note; resolves when it settles (or gives up). */
    watchEnrichment?(id: number, onSettled: () => void): void;
    /** A meal was corrected or removed: the host refreshes what reads the day. */
    onChanged?(): void;
  };
  type ClientFuelLogDeps = {
    /** CairnFoodComposer.mount, injected so the host (and a test) owns the composer. */
    mountComposer(host: Element, deps: FoodComposerDeps): FoodComposerHandle;
    api(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    reducedMotion(): boolean;
    expandEl?(el: Element): void;
    collapseEl?(el: Element, done: () => void): void;
    hour?(): number;
    draft?: { load(): string; save(value: string): void };
    /** The composer's idempotency envelope, so a send lost to a reload replays once. */
    retryStore?: FoodComposerDeps["retryStore"];
    /** The composer followed a send to the food rows it logged. */
    onLogged(logged: FoodComposerLogged): void;
  };
  type ClientFuelLogHandle = (() => void) & { open(prefill?: string | null): void; close(): void };
  type ClientIdeaCardDeps = ClientFuelSwrDeps & {
    date: string;
    api(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    hour(): number;
    /** "Start from this": fill the composer. Never logs. */
    onStart(prefill: string, idea: import("./fuel.js").ClientFuelIdea): void;
  };
  type ClientFuelRefreshHandle = (() => void) & { refresh(): Promise<void> };
  interface Window {
    CairnFuelTodayModel: {
      MEAL_LABEL: Record<string, string>;
      mealLabel(meal: unknown): string;
      mealMeta(entry: Record<string, unknown>): string;
      dayState(count: number, isToday: boolean): ClientFuelDayState;
      todayModel(day: unknown, band: unknown, opts: { today: string }): ClientFuelTodayModel;
      entryNote(entry: unknown): ClientFuelMealNote;
      mealModel(entry: unknown): ClientFuelMeal | null;
      mealModels(day: unknown): ClientFuelMeal[];
      mealNumsText(totals: { kcal?: unknown; protein_g?: unknown }): string;
    };
    CairnFuelToday: {
      todayHtml(model: ClientFuelTodayModel, opts?: { countUp?: boolean }): string;
      demandHtml(model: ClientFuelTodayModel): string;
      carbsHtml(model: ClientFuelTodayModel): string;
      skeletonHtml(): string;
      errorHtml(): string;
    };
    CairnFuelTodayController: {
      dayKey(date: string): string;
      bandKey(date: string): string;
      dayPath(date: string): string;
      bandPath(date: string): string;
      mount(host: Element, deps: ClientFuelTodayDeps): ClientFuelRefreshHandle;
    };
    CairnFuelMeals: {
      listHtml(meals: readonly ClientFuelMeal[], opts?: { isToday?: boolean }): string;
      mealHtml(meal: ClientFuelMeal, opts?: { enter?: boolean }): string;
      headMainHtml(meal: ClientFuelMeal): string;
      numsHtml(meal: ClientFuelMeal): string;
      fixFormHtml(meal: ClientFuelMeal): string;
      fixFormValues(meal: ClientFuelMeal): Record<string, string>;
      FIX_FIELDS: ReadonlyArray<readonly ["protein_g" | "kcal" | "carbs_g" | "fat_g" | "fiber_g", string]>;
      emptyHtml(isToday: boolean): string;
      errorHtml(): string;
    };
    CairnFuelMealsController: {
      mount(host: Element, deps: ClientFuelMealsDeps): ClientFuelRefreshHandle;
    };
    CairnFuelLog: {
      html(): string;
    };
    CairnFuelLogController: {
      mount(host: Element, deps: ClientFuelLogDeps): ClientFuelLogHandle;
    };
    CairnIdeaCard: {
      ideasHtml(data: import("./fuel.js").ClientFuelIdeas, opts?: { reveal?: boolean }): string;
      ideaCardHtml(idea: import("./fuel.js").ClientFuelIdea, opts?: { index?: number; enter?: boolean }): string;
      numsText(idea: import("./fuel.js").ClientFuelIdea): string;
      errorHtml(): string;
    };
    CairnFuelDeps: {
      draft(): { load(): string; save(value: string): void };
      retryStore(): NonNullable<FoodComposerDeps["retryStore"]>;
      today(date: string, today: string): ClientFuelTodayDeps;
      meals(date: string, today: string, token: number, onChanged: () => void): ClientFuelMealsDeps;
      log(onLogged: (logged: FoodComposerLogged) => void): ClientFuelLogDeps;
      ideas(date: string, onStart: ClientIdeaCardDeps["onStart"]): ClientIdeaCardDeps;
      firstPaint(date: string, isToday: boolean): Promise<void> | null;
    };
    CairnIdeaCardController: {
      key(date: string): string;
      path(date: string, hour: number, exclude?: readonly string[]): string;
      mount(host: Element, deps: ClientIdeaCardDeps): ClientFuelRefreshHandle;
    };
  }
  declare const CairnFuelTodayModel: Window["CairnFuelTodayModel"];
  declare const CairnFuelToday: Window["CairnFuelToday"];
  declare const CairnFuelTodayController: Window["CairnFuelTodayController"];
  declare const CairnFuelMeals: Window["CairnFuelMeals"];
  declare const CairnFuelMealsController: Window["CairnFuelMealsController"];
  declare const CairnFuelLog: Window["CairnFuelLog"];
  declare const CairnFuelLogController: Window["CairnFuelLogController"];
  declare const CairnIdeaCard: Window["CairnIdeaCard"];
  declare const CairnIdeaCardController: Window["CairnIdeaCardController"];
  declare const CairnFuelDeps: Window["CairnFuelDeps"];
  // ---- Wave 3 stream B: records-search, marker-row, evidence-wanted, records slot ----
  type ClientRecordsMode = "outrange" | "panel" | "newest";
  type ClientRecordsMarker = Record<string, unknown> & {
    key?: unknown;
    name?: unknown;
    group?: unknown;
    group_label?: unknown;
    latest?: { value?: unknown; date?: unknown; flag?: unknown } | null;
    in_optimal?: unknown;
    /** "Out of range" per the LAB, finished by the server (src/repo/lab-range.ts). */
    lab_range?: unknown;
    lab_out_of_range?: unknown;
    lab_out_of_range_side?: unknown;
  };
  type ClientRecordsSection = {
    key: string;
    /** Panel label, a lead-section label, or (kind "date") the ISO draw date ("" undated). */
    label: string;
    kind: "flagged" | "optimal" | "panel" | "date";
    /** The MARKER_GROUPS key for a panel section, else null. */
    group: string | null;
    markers: ClientRecordsMarker[];
    /** How many of `markers` sit outside the lab's range (the server's `lab_out_of_range`). */
    flagged: number;
  };
  type ClientRecordsModel = { sections: ClientRecordsSection[]; total: number; shown: number };
  type ClientRecordsOtherItem = { kind: "document" | "note" | "body"; id: string; title: string; date: string; detail: string };
  type ClientRecordsOtherState = { status: "idle" | "loading" | "error" | "done"; items: ClientRecordsOtherItem[] };
  type ClientRecordsSearchDeps = {
    api(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    cachedApi(path: string, options?: CachedApiOptions<unknown>): Promise<unknown>;
    peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
    /** Per-viewer grouping preference; every access is try/caught. */
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
    /** A warm catalog the screen already holds ({markers, groups}), painted first. */
    seed?: { markers: unknown; groups: unknown } | null;
    /** MARKER_GROUPS keys to keep (a Stand domain); null/absent = every marker. */
    scope?: readonly string[] | null;
    mode?: ClientRecordsMode;
    searchable?: boolean;
    /** Also ask GET /api/records/search for documents, visit notes and body readings. */
    searchRecords?: boolean;
    placeholder?: string;
    timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
    askCoach(question: string): void;
    onDirective?(): void;
    onOpenRecord?(item: { kind: string; id: string }): void;
    onAdd?(): void;
  };
  /** The server's one evidence-wanted line (GET /api/health/evidence-wanted), as painted. */
  type ClientEvidenceWantedLine = {
    /** The ask's identity: the server's key + the date of the reading it would refresh. */
    key: string;
    /** The server's finished sentence — printed as is, never composed here. */
    line: string;
    kind: "recheck" | "rescan";
  };
  type ClientEvidenceWantedDeps = {
    cachedApi(path: string, options?: CachedApiOptions<unknown>): Promise<unknown>;
    peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
    onOpen?(): void;
  };
  type ClientRecordsSlotName = "packet";
  /** What the Share view hands the packet slot: the share deps plus two hand-offs. */
  type ClientRecordsPacketDeps = ClientHealthShareControllerDeps & {
    reducedMotion(): boolean;
    openCheckup(): void;
  };
  type ClientRecordsSlotMount = (host: Element, deps: ClientRecordsPacketDeps) => (() => void) | undefined;
  interface Window {
    CairnMarkerRow: {
      rowHtml(marker: Record<string, unknown> | null | undefined, index?: number): string;
      labFlagHtml(marker: Record<string, unknown> | null | undefined): string;
      optimalHtml(marker: Record<string, unknown> | null | undefined): string;
      marksHtml(marker: Record<string, unknown> | null | undefined): string;
    };
    CairnRecordsSearchModel: {
      MODES: ReadonlyArray<readonly [ClientRecordsMode, string]>;
      SERVER_GROUP: Record<ClientRecordsMode, string>;
      isMode(value: unknown): value is ClientRecordsMode;
      normalizeQuery(value: unknown): string;
      matchesQuery(marker: ClientRecordsMarker, q: string): boolean;
      groupsFor(groups: unknown, markers: readonly ClientRecordsMarker[]): Array<{ key: string; label: string }>;
      sectionsModel(input: {
        markers: unknown;
        groups: unknown;
        mode: ClientRecordsMode;
        q?: string;
        scope?: readonly string[] | null;
      }): ClientRecordsModel;
      searchPath(q: string, mode: ClientRecordsMode): string;
      otherItems(response: unknown): ClientRecordsOtherItem[] | null;
    };
    CairnRecordsSearch: {
      shellHtml(opts: { mode: ClientRecordsMode; searchable: boolean; placeholder?: string }): string;
      skeletonHtml(): string;
      resultsHtml(model: ClientRecordsModel, opts?: { q?: string; canAdd?: boolean }): string;
      sectionHtml(section: ClientRecordsSection, index: number, rowIndex: { value: number }): string;
      otherHtml(state: ClientRecordsOtherState): string;
      errorHtml(): string;
      statusText(model: ClientRecordsModel, q: string): string;
    };
    CairnRecordsSearchController: {
      KEY: string;
      MODE_KEY: string;
      DEBOUNCE_MS: number;
      mount(host: Element, deps: ClientRecordsSearchDeps): () => void;
    };
    CairnEvidenceWanted: {
      model(read: unknown): ClientEvidenceWantedLine | null;
      lineHtml(model: ClientEvidenceWantedLine | null, opts?: { canOpen?: boolean }): string;
    };
    CairnEvidenceWantedController: {
      DISMISS_KEY: string;
      KEY: string;
      PATH: string;
      mount(host: Element, deps: ClientEvidenceWantedDeps): () => void;
    };
    CairnRecordsSlot: {
      register(name: ClientRecordsSlotName, mount: ClientRecordsSlotMount): void;
      has(name: ClientRecordsSlotName): boolean;
      mount(name: ClientRecordsSlotName, host: Element | null, deps: ClientRecordsPacketDeps): () => void;
    };
  }
  declare const CairnMarkerRow: Window["CairnMarkerRow"];
  declare const CairnRecordsSearchModel: Window["CairnRecordsSearchModel"];
  declare const CairnRecordsSearch: Window["CairnRecordsSearch"];
  declare const CairnRecordsSearchController: Window["CairnRecordsSearchController"];
  declare const CairnEvidenceWanted: Window["CairnEvidenceWanted"];
  declare const CairnEvidenceWantedController: Window["CairnEvidenceWantedController"];
  declare const CairnRecordsSlot: Window["CairnRecordsSlot"];
  // ---- Wave 3 stream C: packet-builder, visit-questions ----
  /** The packet's two hand-overs: open the HTML packet, or download the text twin. */
  type ClientPacketShareKind = "open" | "text";
  type ClientPacketSectionOption = { id: string; label: string; included: boolean };
  /** null = the server's default (every section but the opt-in sources / the proposals). */
  type ClientPacketSelection = { sections: readonly string[] | null; questions: readonly string[] | null };
  type ClientPacketPreviewRow = {
    title: string;
    detail: string;
    date: string | null;
    /** The lab's own HIGH/LOW flag — a mark of its own. */
    flag: "high" | "low" | null;
    /** Outside the range the lab printed without the lab flagging it — worded apart from `flag`. */
    rangeSide?: "high" | "low" | null;
    /** Outside the optimal band — a separate mark, never merged with `flag`. */
    outsideOptimal: boolean;
  };
  type ClientPacketPreviewSection = {
    id: string;
    label: string;
    ordered: boolean;
    rows: ClientPacketPreviewRow[];
    more: number;
    /** The calm line for a section that is included but has nothing in it. */
    empty: string | null;
  };
  type ClientPacketPreview = {
    generated: string | null;
    range: { from: string; to: string } | null;
    sections: ClientPacketPreviewSection[];
    disclaimer: string;
  };
  type ClientPacketBuilderDeps = {
    api(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    cachedApi(path: string, options?: CachedApiOptions<unknown>): Promise<unknown>;
    peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
    /** Share with the current `?sections=…&questions=…` query ("" = the defaults). */
    onShare(kind: ClientPacketShareKind, query: string): void;
    /** The empty state's "Add a document". */
    onAdd?(): void;
    /** Mount the visit-questions editor into the builder's sub-slot. */
    mountQuestions?(host: Element, onChange: (list: string[] | null) => void): () => void;
  };
  type ClientVisitQuestionItem = { id: string; text: string; source: string; basis: string | null };
  type ClientVisitQuestionsView = {
    status: "loading" | "ready" | "error";
    items: ClientVisitQuestionItem[];
    edited: boolean;
    full: boolean;
    newId?: string | null;
  };
  type ClientVisitQuestionsDeps = {
    cachedApi(path: string, options?: CachedApiOptions<unknown>): Promise<unknown>;
    peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
    /** The list the packet sends after each edit; null = the server's proposals. */
    onChange(list: string[] | null): void;
  };
  interface Window {
    CairnPacketBuilderModel: {
      LIST_CAP: number;
      DISCLAIMER: string;
      catalog(report: unknown): ClientPacketSectionOption[];
      sectionsOf(report: unknown): string[];
      toggle(options: readonly ClientPacketSectionOption[], current: readonly string[], id: string, on: boolean): string[];
      query(selection: ClientPacketSelection): string;
      hasRecords(report: unknown): boolean | null;
      previewModel(report: unknown): ClientPacketPreview;
    };
    CairnPacketBuilder: {
      shellHtml(opts?: { disclaimer?: string }): string;
      togglesHtml(options: readonly ClientPacketSectionOption[], selected: readonly string[]): string;
      togglesSkeletonHtml(): string;
      previewHtml(preview: ClientPacketPreview, opts?: { enter?: boolean }): string;
      previewSkeletonHtml(): string;
      previewErrorHtml(unreachable?: boolean): string;
      emptyHtml(opts?: { disclaimer?: string }): string;
      statusText(preview: ClientPacketPreview): string;
    };
    CairnPacketBuilderController: {
      KEY: string;
      PATH: string;
      mount(host: Element, deps: ClientPacketBuilderDeps): () => void;
    };
    CairnVisitQuestions: {
      SOURCE_LABEL: Record<string, string>;
      shellHtml(opts: { maxChars: number }): string;
      listHtml(view: ClientVisitQuestionsView): string;
    };
    CairnVisitQuestionsController: {
      KEY: string;
      PATH: string;
      QUESTION_CAP: number;
      QUESTION_MAX_CHARS: number;
      cleanQuestion(raw: unknown): string;
      mount(host: Element, deps: ClientVisitQuestionsDeps): () => void;
    };
  }
  declare const CairnPacketBuilderModel: Window["CairnPacketBuilderModel"];
  declare const CairnPacketBuilder: Window["CairnPacketBuilder"];
  declare const CairnPacketBuilderController: Window["CairnPacketBuilderController"];
  declare const CairnVisitQuestions: Window["CairnVisitQuestions"];
  declare const CairnVisitQuestionsController: Window["CairnVisitQuestionsController"];
  // ---- Wave 4 stream B: race view (race-ladder, race-estimate), Plan → Endurance ----
  type ClientRaceLadderRow = {
    week_start: string;
    weeks_to_race: number;
    kind: "build" | "down" | "peak" | "taper" | "race";
    /** "Build", "Down week", "Peak", "Taper", "Race". */
    kind_word: string;
    /** "7 wk out", or "Race week". */
    out_word: string;
    /** The week's Monday as the one date label ("Sep 14"). */
    date_word: string;
    km: number;
    /** The week's distance in the athlete's run units ("32 km", "19.9 mi"). */
    km_text: string;
    /** The week's stage in one word: "Base", "Build", "Sharpen", "Peak", "Down week", "Taper", "Race". */
    stage_word: string;
    /** The long run in kilometres (null in race week or with none). */
    long_km: number | null;
    long_text: string;
    /** The bar: this week's km against the ladder's longest week, 0..1. */
    frac: number;
    current: boolean;
    logged_km: number | null;
    logged_frac: number | null;
    race_day_text: string;
    /** The server's one coaching sentence for the week. */
    focus_text: string;
    /** The same focus in a few words, for the row. */
    focus_short: string;
    /** How lifting and running fit this week, in the server's words ("" with no lifting). */
    lifting_text: string;
    /** This week, once the server closes it: the row's figure is the actual alone. */
    closed?: boolean;
    /** A closed week's recap in place of its plan focus ("35.8 km over 4 runs"); "". */
    recap_text?: string;
    /** The bar in words, for its aria-label ("Week of Sep 28: 35.8 km run of 19.5 km planned"). */
    bar_label?: string;
  };
  /** A closed week above this one on the ladder: an actual, drawn solid. */
  type ClientRaceLadderPastRow = {
    week_start: string;
    date_word: string;
    km: number;
    km_text: string;
    /** "3 runs"; "" with no count. */
    runs_text: string;
    frac: number;
    bar_label: string;
  };
  /** This week at a glance: stage, logged against the week's volume, long run, the focus. */
  type ClientRaceThisWeek = {
    stage_word: string;
    done_km: number;
    target_km: number;
    /** What the log holds, the number alone ("9.7") in the run units; "" when nothing is run yet. */
    done_text: string;
    /** The week's volume in the run units ("19.5 km"); "" with none. */
    target_text: string;
    /** Logged against the week's volume, 0..1 (a quiet bar, never a grade); null with no volume. */
    frac: number | null;
    banked: boolean;
    long_text: string;
    focus: string;
    /** "This week · Sharpen · 4 wk out". */
    kicker?: string;
    /** The server's sentence for the week (`this_week.headline`), else the stage word. */
    headline?: string;
    /** One detail line: the server's (`this_week.detail`), else the rung's focus while the week is open. */
    detail?: string;
    /** The server says the week is behind the athlete (`this_week.closed`). */
    closed?: boolean;
    /** "35.8 km" once something is run; "" before. */
    logged_text?: string;
    /** "plan 19.5" beside a logged figure, or "19.5 km planned" alone; "" with no plan. */
    plan_text?: string;
    /** The week's runs as logged, oldest first. */
    runs?: ClientRaceWeekRun[];
    /** One bar segment per run, scaled to max(plan, logged). */
    segments?: ClientRaceWeekSegment[];
    /** Where the plan's tick sits on that bar, 0..1; null with no plan. */
    plan_frac?: number | null;
    /** The log is past the plan: the bar shows the overflow beyond the tick. */
    over?: boolean;
  };
  /** One run of this week as the THIS WEEK card prints it: what was run first, the plan second. */
  type ClientRaceWeekRun = {
    date: string;
    /** "Tue". */
    when: string;
    km: number | null;
    km_text: string;
    /** The run's own pace ("5:34/km"); "" when the read has none. */
    pace_text: string;
    /** The server's grade of the run in words (easy / steady / hard); "" when it sent none. */
    effort_word: string;
    /** What was run, in one line: the server's `actual_line`, else "13.5 km · 6:11/km · easy". */
    actual_text: string;
    /** The activity's own title ("Hill Sprints"); "" with none. */
    title: string;
    /** The bar's tone: the intent it closed, or an extra's own grade. */
    tone: "easy" | "quality" | "long";
    /** A run no intent took: shown as "Extra", never dropped. */
    extra: boolean;
    /** The server's `plan_line`, else "planned: easy 4.8 km"; "" for an extra. */
    planned_text: string;
    /** What the day's call did to the plan ("shortened to 8 km this morning"); "". */
    adjust_text: string;
  };
  type ClientRaceWeekSegment = { tone: "easy" | "quality" | "long"; extra: boolean; frac: number; label: string };
  /** One "With your lifting" row: a week, or a run of weeks that say the same thing. */
  type ClientRaceLiftingLine = { when: string; stage: string; text: string; current: boolean };
  type ClientRaceLadderModel = {
    rows: ClientRaceLadderRow[];
    max_km: number;
    taper_text: string;
    /**
     * Why the build climbs from the week it does when a bigger recent week is set aside,
     * in the run units; "" when nothing is set aside.
     */
    capacity_text?: string;
    /** The last few closed weeks, oldest first, above this week ([] with none). */
    past?: ClientRaceLadderPastRow[];
    /** The server's sentence on how the ladder moved with what was run; "" with none. */
    adapted_text?: string;
    /** The run units the row words are written in; the numbers (`km`, `max_km`) stay kilometres. */
    units?: "km" | "mi";
  };
  type ClientRaceEstimateModel = {
    fit: import("./client-api.js").ClientRaceFit | null;
    /** "Fits", "Stretch" or "Beyond horizon" — the whole vocabulary; "" without a target. */
    fit_word: string;
    fit_line: string;
    basis_text: string;
    empty: boolean;
  };
  /** One finish milestone on the race page: the goal, today's shape, or the stretch. */
  type ClientRaceFinish = {
    key: "goal" | "now" | "stretch";
    label: string;
    /** "sub-2:00", "1:54", "1:50" — to the minute, the target as set. */
    clock: string;
    /** "5:41 /km" in the run units; "" when unknown. */
    pace: string;
    /** Where today's estimate sits against it ("Within reach"); "" for today's shape. */
    note: string;
  };
  type ClientRaceViewModel = {
    event: string;
    countdown: string;
    race_day: string;
    phase_word: string;
    /** The head's estimate line ("Reads about 1:54 · inside sub-2:00 · …"); "" with none. */
    fit_text?: string;
    estimate: ClientRaceEstimateModel;
    this_week: ClientRaceThisWeek | null;
    lifting: ClientRaceLiftingLine[];
    ladder: ClientRaceLadderModel;
    /** The whole build as terrain for the km chart; null with fewer than two weeks. */
    terrain: ClientHorizonTerrain | null;
    /** The finish milestones (goal, today's shape, stretch); [] with none. */
    finishes: ClientRaceFinish[];
    paces: Array<{ label: string; text: string }>;
    notes: string[];
  };
  type ClientRaceViewDeps = {
    /** GET /api/race-build. */
    load(): Promise<unknown>;
    /** A build the screen already holds; painted at once, no second read. */
    initial?: unknown;
    /** Run units for distance and pace (settings.run_units); the engine stays in km. */
    units?: "km" | "mi";
    /** This week's runs, by weekday (the page's briefing rows), for the THIS WEEK card. */
    sessionsHtml?: string;
    /** Next week's runs, its own section after the card (the briefing's). */
    nextWeekHtml?: string;
    /** This week's training agenda: the runs behind the bar when the build carries none. */
    agenda?: import("./client-api.js").ClientFlexibleTrainingAgenda | null;
    reducedMotion?(): boolean;
  };
  interface Window {
    CairnPlanEnduranceBriefing: {
      /** This week's runs by weekday: done ticked, the next in full, the rest as rows. */
      sessionsHtml(briefing: unknown, opts?: { runs?: ClientRaceWeekRun[] | null; today?: string }): string;
      /** Next week's runs as their own section; detail only on the first upcoming run. */
      nextWeekHtml(briefing: unknown, opts?: { figure?: string; today?: string }): string;
    };
    CairnRaceWeekModel: {
      STAGE_WORD: Record<string, string>;
      stageWord(week: Pick<import("./client-api.js").ClientRaceBuildWeek, "kind" | "phase">): string;
      unitsOf(value: unknown): "km" | "mi";
      kmText(km: unknown, units?: unknown): string;
      distNum(km: unknown, units?: unknown): string;
      runWords(value: unknown, units?: unknown): string;
      liftingModel(ladder: ClientRaceLadderModel): ClientRaceLiftingLine[];
      volumeWeeks(build: ClientRaceBuild | null | undefined, units?: unknown): ClientHorizonVolumeWeek[];
    };
    CairnRaceWeekRuns: {
      thisWeekModel(
        build: ClientRaceBuild | null | undefined,
        units?: unknown,
        opts?: { agenda?: ClientFlexibleTrainingAgenda | null; countdownShown?: boolean }
      ): ClientRaceThisWeek | null;
      /** This week's runs as logged, actual first: the build's own reads, else the agenda's. */
      weekRuns(
        build: ClientRaceBuild | null | undefined,
        agenda?: ClientFlexibleTrainingAgenda | null,
        units?: unknown
      ): ClientRaceWeekRun[];
      /** Next week's planned volume from the ladder ("32.1 km planned"); "". */
      nextWeekText(build: ClientRaceBuild | null | undefined, units?: unknown): string;
      /** A run's own pace ("5:34/km"); "". */
      paceText(secPerKm: unknown, units?: unknown): string;
    };
    CairnRaceLadderModel: {
      KIND_WORD: Record<ClientRaceLadderRow["kind"], string>;
      WEEKDAYS: readonly string[];
      dayKey(iso: unknown): string;
      /** "Nov 1". */
      shortDate(iso: unknown): string;
      /** "Sunday, Nov 1". */
      longDate(iso: unknown): string;
      ladderModel(build: ClientRaceBuild | null | undefined, units?: unknown): ClientRaceLadderModel;
    };
    CairnRaceViewModel: {
      FIT_WORD: Record<import("./client-api.js").ClientRaceFit, string>;
      KIND_WORD: Record<ClientRaceLadderRow["kind"], string>;
      STAGE_WORD: Record<string, string>;
      stageWord(week: Pick<import("./client-api.js").ClientRaceBuildWeek, "kind" | "phase">): string;
      thisWeekModel(
        build: ClientRaceBuild | null | undefined,
        units?: unknown,
        opts?: { agenda?: ClientFlexibleTrainingAgenda | null; countdownShown?: boolean }
      ): ClientRaceThisWeek | null;
      liftingModel(ladder: ClientRaceLadderModel): ClientRaceLiftingLine[];
      /** The distance's number alone in the run units ("12.5"). */
      distNum(km: unknown, units?: unknown): string;
      /** Kilometres from the engine, written in the athlete's run units. */
      kmText(km: unknown, units?: unknown): string;
      /** A server run sentence with its km figures and /km paces restated in the run units. */
      runWords(value: unknown, units?: unknown): string;
      clock(sec: unknown): string;
      longDate(iso: unknown): string;
      isShowable(value: unknown): value is ClientRaceBuild;
      ladderModel(build: ClientRaceBuild | null | undefined, units?: unknown): ClientRaceLadderModel;
      terrainModel(
        build: ClientRaceBuild | null | undefined,
        ladder: ClientRaceLadderModel,
        units?: unknown
      ): ClientHorizonTerrain | null;
      raceShortName(distanceKm: unknown): string;
      /** The race build's one serif line ("Five weeks of build, then the half."). */
      buildVoice(ladder: ClientRaceLadderModel, race: ClientRaceBuild["race"] | null | undefined): string;
      estimateModel(build: ClientRaceBuild | null | undefined, units?: unknown): ClientRaceEstimateModel;
      /** The head's estimate line ("Reads about 1:54 · inside sub-2:00 · …"); "". */
      fitHeadText(build: ClientRaceBuild | null | undefined): string;
      viewModel(
        value: unknown,
        opts?: { units?: unknown; agenda?: ClientFlexibleTrainingAgenda | null }
      ): ClientRaceViewModel | null;
    };
    CairnRaceLadder: {
      ladderHtml(model: ClientRaceLadderModel, opts?: { reveal?: boolean }): string;
      rowHtml(row: ClientRaceLadderRow, index: number, opts: { reveal?: boolean }): string;
    };
    CairnRaceEstimate: {
      estimateHtml(
        model: ClientRaceEstimateModel,
        opts?: { paces?: Array<{ label: string; text: string }>; finishes?: ClientRaceFinish[] }
      ): string;
    };
    CairnRaceView: {
      viewHtml(
        model: ClientRaceViewModel,
        opts?: { enter?: boolean; sessionsHtml?: string; nextWeekHtml?: string; units?: "km" | "mi" }
      ): string;
      thisWeekHtml(week: ClientRaceThisWeek | null, opts?: { sessionsHtml?: string; focus?: string; units?: "km" | "mi" }): string;
      /** "9.7 of 19.5 km", or the week's volume alone before anything is run; never a zero. */
      volumeFigureHtml(week: ClientRaceThisWeek | null | undefined, cls: string): string;
      liftingHtml(lines: ClientRaceLiftingLine[]): string;
      unitsHtml(units: "km" | "mi"): string;
      skeletonHtml(): string;
      emptyHtml(reason?: unknown): string;
      errorHtml(): string;
    };
    CairnRaceViewController: {
      mount(host: Element, deps: ClientRaceViewDeps): () => void;
    };
  }
  declare const CairnPlanEnduranceBriefing: Window["CairnPlanEnduranceBriefing"];
  declare const CairnRaceWeekModel: Window["CairnRaceWeekModel"];
  declare const CairnRaceWeekRuns: Window["CairnRaceWeekRuns"];
  declare const CairnRaceLadderModel: Window["CairnRaceLadderModel"];
  declare const CairnRaceViewModel: Window["CairnRaceViewModel"];
  declare const CairnRaceLadder: Window["CairnRaceLadder"];
  declare const CairnRaceEstimate: Window["CairnRaceEstimate"];
  declare const CairnRaceView: Window["CairnRaceView"];
  declare const CairnRaceViewController: Window["CairnRaceViewController"];
  // ---- Wave 5 stream C: the Horizon timeline (horizon-*) ----
  /** Where a Horizon row or link goes: a view-keyed route the app's router applies. */
  type ClientHorizonTarget = { tab: ClientTabName; section: string | null; id?: string | null };
  type ClientHorizonRow = {
    /** Behind today (a past draw) or ahead of it (a recheck, a goal date). */
    side: "behind" | "ahead";
    /** The server's own when words, or a date label ("Sep 14"). */
    when: string;
    label: string;
    detail: string;
    /** The source kind ("bloodwork", "recheck", "goal", ...), a class hook only. */
    kind: string;
    target: ClientHorizonTarget | null;
  };
  /** One closed week of running, for a runner with no race set. */
  type ClientHorizonVolumeWeek = { week_start: string; date_word: string; km_text: string; frac: number };
  type ClientHorizonLane = {
    key: "race" | "goal" | "labs";
    /** "Race", "Running", "Goal line", "Labs and scans". */
    title: string;
    /**
     * "unread" is a failed read, "none" nothing to show yet (neither is ever empty), and
     * "absent" a lane that does not belong to this athlete at all (no running: no race lane).
     */
    state: "set" | "none" | "unread" | "absent";
    headline: string;
    /** The race view's serif line ("Five weeks of build, then the half."), race lane only. */
    voice?: string;
    when: string;
    lede: string;
    fit: import("./client-api.js").ClientRaceFit | null;
    fit_word: string;
    fit_line: string;
    /** The whole build as a terrain: every week's km to race day (race lane only). */
    terrain?: ClientHorizonTerrain | null;
    /** This week at a glance (race lane only; with or without a race). */
    this_week?: ClientRaceThisWeek | null;
    /** The closed weeks' running, for a runner with no race (race lane only). */
    volume?: ClientHorizonVolumeWeek[];
    /** The run units the lane is written in (race lane only). */
    units?: "km" | "mi";
    rows: ClientHorizonRow[];
    links: Array<{ label: string; target: ClientHorizonTarget }>;
  };
  /** Horizon's three views: this week, the race build, and the season line. */
  type ClientHorizonView = "week" | "race" | "season";
  type ClientHorizonWeekPill = {
    /** The stone whose hue the pill wears. */
    stone: "strength" | "endurance";
    text: string;
    /** done (ticked), live (today's open session), open (a run still to place), planned. */
    state: "done" | "live" | "open" | "planned";
  };
  type ClientHorizonWeekDay = {
    date: string;
    weekday: string;
    day: string;
    today: boolean;
    pills: ClientHorizonWeekPill[];
    /**
     * Today only: the server's one today line (the Brief's, the Session's, the plan
     * strip's), printed verbatim in place of a lift pill so one morning reads as one answer.
     */
    line: import("./client-api.js").ClientTodayStrengthLine | null;
  };
  type ClientHorizonWeek = { line: string; days: ClientHorizonWeekDay[] };
  /** One week of the terrain; `logged` weeks are closed weeks read off the log, before the ladder. */
  type ClientHorizonTerrainWeek = {
    week_start: string;
    km: number;
    kind: string;
    current: boolean;
    logged?: boolean;
    /** The ladder week's stage word ("Build", "Taper"); absent on a logged week. */
    stage?: string;
    /** The ladder week's long run, km (null when none). */
    long_km?: number | null;
    /** This week only: what the log already holds, km. */
    logged_km?: number | null;
  };
  type ClientHorizonTerrain = {
    weeks: ClientHorizonTerrainWeek[];
    /** Race day (YYYY-MM-DD) and its short marker label ("Race · Nov 8"). */
    race_date: string;
    race_label: string;
    /** The build read's own "as of" day: where the now line stands. */
    as_of: string;
    /** The units the chart writes; the weeks' `km` stays kilometres. */
    units?: "km" | "mi";
  };
  /** One calendar week's column in the terrain (terrainLayout), in viewBox units and run units. */
  type ClientHorizonTerrainColumn = {
    week_start: string;
    logged: boolean;
    current: boolean;
    /** The ribbon's stage word ("Logged" on a logged week). */
    stage: string;
    /** The week's slot on the time axis (Monday to the next, or to race day). */
    slot_x: number;
    slot_w: number;
    /** The column inside its slot. */
    x: number;
    width: number;
    /** The week's figure (run units) and the y its top stands at. */
    value: number;
    top: number;
    /** This week only: what the log holds (run units) and the fill's top. */
    done: number | null;
    done_top: number | null;
    /** A ladder week's long run (run units) and its tick's y. */
    long: number | null;
    long_y: number | null;
  };
  type ClientHorizonTerrainLabel = { kind: "week" | "peak"; text: string; x: number; y: number; week_start: string };
  type ClientHorizonTerrainLayout = {
    units: "km" | "mi";
    L: number;
    R: number;
    base: number;
    ceil: number;
    /** The axis top and its gridline step (run units); `max` the largest figure drawn. */
    top: number;
    step: number;
    max: number;
    grid: Array<{ value: number; y: number }>;
    columns: ClientHorizonTerrainColumn[];
    labels: ClientHorizonTerrainLabel[];
    /** The week the wash stands on (this week unless another is picked; null for none). */
    selected: string | null;
    race_x: number;
    race_day: string;
    end_x: number;
  };
  type ClientHorizonSeasonMark = { date: string; label: string; kind: string; side: "behind" | "ahead" };
  type ClientHorizonSeason = {
    points: Array<{ date: string; lb: number }>;
    goal_lb: number | null;
    goal_date: string | null;
    /** The server's projection window toward the goal weight: the fan. */
    fan: { start: string; end: string } | null;
    race: { date: string; label: string } | null;
    marks: ClientHorizonSeasonMark[];
    today: string;
  };
  type ClientHorizonDeps = {
    /** Today's date, the line between behind and ahead. */
    today: string;
    load(path: string): Promise<unknown>;
    navigate(target: ClientHorizonTarget): void;
    hrefFor?(target: ClientHorizonTarget): string | null;
    reducedMotion?(): boolean;
    /** Save the athlete's run units (settings.run_units); the controller repaints on its own. */
    saveUnits?(units: "km" | "mi"): Promise<unknown>;
  };
  interface Window {
    CairnHorizonModel: {
      LAB_KINDS: Readonly<Record<string, string>>;
      TARGETS: Readonly<Record<string, ClientHorizonTarget>>;
      raceLane(build: unknown, units?: unknown): ClientHorizonLane;
      goalLane(journey: unknown, timeline: unknown, today: string): ClientHorizonLane;
      labsLane(docs: unknown, checkup: unknown, timeline: unknown, today: string): ClientHorizonLane;
      weightLine(read: import("./client-api.js").ClientJourneyRead | null): string;
      season(
        pace: unknown,
        timeline: unknown,
        docs: unknown,
        checkup: unknown,
        today: string
      ): ClientHorizonSeason | null;
    };
    CairnHorizonWeekModel: {
      weekView(planWeek: unknown, today: string, units?: unknown): ClientHorizonWeek | null;
      /**
       * One plan-week day's run as the week and a day preview print it ("Long run ·
       * 8.4 mi"), in the athlete's run units; "" when the day holds no run.
       */
      dayRunText(day: unknown, today: string, units?: unknown): string;
    };
    CairnHorizonTerrain: {
      TERRAIN: { readonly W: number; readonly H: number };
      terrainLayout(
        terrain: ClientHorizonTerrain,
        opts?: { selected?: string | null }
      ): ClientHorizonTerrainLayout | null;
      terrainSvg(terrain: ClientHorizonTerrain, opts?: { selected?: string | null }): string;
      terrainKeyHtml(terrain: ClientHorizonTerrain | null | undefined): string;
      fx(n: number): string;
      dayNum(iso: string): number;
      isoOf(n: number): string;
      monoDate(iso: string): string;
      kmWord(km: number): string;
    };
    CairnHorizonChart: {
      BODY_MARK_KINDS: ReadonlySet<string>;
      FAN_ANCHOR_DAYS: number;
      TERRAIN: { readonly W: number; readonly H: number };
      terrainSvg(terrain: ClientHorizonTerrain, opts?: { selected?: string | null }): string;
      terrainKeyHtml(terrain: ClientHorizonTerrain | null | undefined): string;
      seasonSvg(season: ClientHorizonSeason): string;
    };
    CairnHorizon: {
      KEYS: ReadonlyArray<ClientHorizonLane["key"]>;
      laneHtml(
        lane: ClientHorizonLane,
        opts?: {
          enter?: boolean;
          hrefFor?: (target: ClientHorizonTarget) => string | null;
        }
      ): string;
      PANEL: Readonly<Record<ClientHorizonLane["key"], ClientHorizonView>>;
      laneSkeletonHtml(key: ClientHorizonLane["key"]): string;
      seasonHtml(season: ClientHorizonSeason | null): string;
      weekHtml(week: ClientHorizonWeek | null, opts?: { enter?: boolean }): string;
      weekSkeletonHtml(): string;
      /** `race: false` leaves the race view out (a lifting-only athlete). */
      shellHtml(active?: ClientHorizonView, opts?: { race?: boolean; raceLabel?: string }): string;
      /** All goals (the goal line's depth view): every progress-board thread; "" with none. */
      goalsBoardHtml(path: import("./today-path.js").TodayPath | null | undefined): string;
    };
    CairnHorizonController: {
      mount(host: Element, deps: ClientHorizonDeps): () => void;
      /** The shell's frame for this app session: the view to open on and whether the race view belongs. */
      shellOptions(): { view: ClientHorizonView; race: boolean; raceLabel: string };
    };
  }
  declare const CairnHorizonModel: Window["CairnHorizonModel"];
  declare const CairnHorizonWeekModel: Window["CairnHorizonWeekModel"];
  declare const CairnHorizon: Window["CairnHorizon"];
  declare const CairnHorizonTerrain: Window["CairnHorizonTerrain"];
  declare const CairnHorizonChart: Window["CairnHorizonChart"];
  declare const CairnHorizonController: Window["CairnHorizonController"];
  // Client cache freshness + offline honesty (write-invalidation-client.ts,
  // offline-state-client.ts, app/update-gate.ts).
  interface Window {
    CairnWriteInvalidation: {
      CHAT_ACTION_TARGETS: Readonly<Record<string, readonly string[]>>;
      WRITE_TARGETS: Readonly<Record<string, readonly string[]>>;
      targetsForChatAction(type: unknown): readonly string[];
      targetsForWrite(name: string): readonly string[];
      invalidate(targets: readonly string[], opts?: { keep?: readonly string[] }): string[];
      invalidateChatApplied(applied: unknown): string[];
      invalidateWrite(name: string, opts?: { keep?: readonly string[] }): string[];
      register(name: string, clear: () => void): void;
      trackTurn(turn: unknown, opts?: { owned?: boolean }): void;
      releaseTurn(turn: unknown): void;
      settleTurn(turn: unknown): string[];
      resumeTurns(): void;
      watchedTurns(): number[];
    };
    CairnArtInflight: {
      find(token: string, src: string): HTMLImageElement | null;
      watch(img: HTMLImageElement, token: string): void;
    };
    CairnArtMemory: {
      version(token: string): number;
      setVersion(token: string, version: number): void;
      mergeVersions(versions: Record<string, unknown> | null | undefined): void;
      missedRecently(token: string): boolean;
      recordMiss(token: string): void;
      forgetMiss(token: string): void;
    };
    CairnTrainSnapshot: {
      KEY: string;
      load(): unknown;
      save(data: unknown): void;
      clear(): void;
    };
    CairnOffline: {
      isUnreachable(error: unknown): boolean;
      read<T = unknown>(
        path: string,
        key: string
      ): Promise<{ data: T | null; source: "network" | "last-known" | "none"; unreachable: boolean }>;
      unreachableHtml(opts?: { title?: string; body?: string; retry?: boolean }): string;
      lastKnownHtml(): string;
      wireRetry(root: ParentNode | null | undefined, retry: () => unknown): void;
    };
    CairnUpdateGate: {
      isSafe(input: {
        hidden: boolean;
        sessionActive: boolean;
        sheetOpen: boolean;
        editing: boolean;
        typing: boolean;
        restActive: boolean;
        draftUnsent: boolean;
        outboxPending: boolean;
      }): boolean;
      onControllerChange(reload: () => void): "reloaded" | "deferred";
      reloadIfPending(): boolean;
      hasPending(): boolean;
      whenLoadedAndIdle(run: () => void): void;
      controllerChangeListener(hadController: boolean, reload: () => void): () => void;
      LINE_TEXT: string;
      DRAFT_KEYS: readonly string[];
    };
  }
  declare const CairnWriteInvalidation: Window["CairnWriteInvalidation"];
  declare const CairnOffline: Window["CairnOffline"];
  declare const CairnTrainSnapshot: Window["CairnTrainSnapshot"];
  declare const CairnArtMemory: Window["CairnArtMemory"];
  declare const CairnArtInflight: Window["CairnArtInflight"];
  declare const CairnUpdateGate: Window["CairnUpdateGate"];
  // ---- The Program look-ahead (program-week-{model,client,controller}.ts) ----
  type ClientProgramWeekRow = {
    date: string;
    /** "MON" */
    weekday: string;
    /** Day of the month ("6"). */
    day: string;
    today: boolean;
    hard: boolean;
    /** Today only: the server's one strength line, printed verbatim in place of the plan day's name. */
    line: import("./client-api.js").ClientTodayStrengthLine | null;
    lift: { title: string; lifts: string; done: boolean } | null;
    run: { text: string; done: boolean; kind: string } | null;
    rest: boolean;
  };
  type ClientProgramWeekGroup = {
    label: string;
    markers: Array<{ kind: string; word: string; note: string }>;
    rows: ClientProgramWeekRow[];
  };
  type ClientProgramWeekView = {
    mode: "calendar" | "order" | "empty";
    groups: ClientProgramWeekGroup[];
    order: Array<{ title: string; lifts: string }>;
  };
  type ClientProgramWeekDeps = {
    peekCached<T = unknown>(key: string): { data: T; fresh: boolean } | null;
    cachedApi(
      path: string,
      options?: { key?: string; onUpgrade?(data: unknown, meta: { changed: boolean }): void }
    ): Promise<unknown>;
    /** Open the plan editor. */
    editPlan(): unknown;
    /** Open Ask, with `text` in the composer when the door carries words. */
    ask(text?: string): unknown;
  };
  interface Window {
    CairnProgramWeekModel: {
      programWeekModel(read: unknown): ClientProgramWeekView | null;
      liftsText(lift: import("./client-api.js").ClientPlanLookAheadLift | null | undefined): string;
      runText(run: import("./client-api.js").ClientPlanLookAheadRun | null | undefined, units: unknown): string;
    };
    CairnProgramWeek: {
      sectionHtml(body: string): string;
      skeletonHtml(): string;
      bodyHtml(view: ClientProgramWeekView | null): string;
    };
    CairnProgramWeekController: {
      KEY: string;
      PATH: string;
      mount(host: Element, deps: ClientProgramWeekDeps): () => void;
    };
  }
  declare const CairnProgramWeekModel: Window["CairnProgramWeekModel"];
  declare const CairnProgramWeek: Window["CairnProgramWeek"];
  declare const CairnProgramWeekController: Window["CairnProgramWeekController"];
}
