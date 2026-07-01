// @ts-check
// Today runtime dependency assembly. The screen runtime owns the public facade;
// this module owns the large global-adapter map required by Today controllers.

{
type TodayScreenRuntimeDepsApiResponse<Path extends string> = import("../contracts/client.js").ClientApiResponse<Path>;
type TodayScreenRuntimeDepsCachedApiOptions<T> = { key?: string; freshFor?: number; onUpgrade?: (data: T, meta: { changed: boolean }) => void };
type TodayScreenRuntimeDepsSwrPeek<T> = { data: T; fresh: boolean };
type TodayScreenRuntimeDepsState = ClientTodayScreenRuntimeState;
type TodayScreenRuntimeDepsInput = {
  root: HTMLElement;
  state: TodayScreenRuntimeDepsState;
  api<Path extends string>(
    path: Path,
    opts?: RequestInit & { headers?: Record<string, string> },
  ): Promise<TodayScreenRuntimeDepsApiResponse<Path>>;
  cachedApi<Path extends string>(
    path: Path,
    opts?: TodayScreenRuntimeDepsCachedApiOptions<TodayScreenRuntimeDepsApiResponse<Path>>,
  ): Promise<TodayScreenRuntimeDepsApiResponse<Path>>;
  peekCached<T = unknown>(key: string, freshFor?: number): TodayScreenRuntimeDepsSwrPeek<T> | null;
  renderToday(): Promise<unknown> | unknown;
  micGlyph(): string;
  bridge(): ClientTodayCompatibilityBridgesContext;
  exRxLineHtml(rx: Partial<ClientPrescription> | null | undefined): string;
  rxMoveCount(rxByEx: Record<string, Partial<ClientPrescription> | null | undefined>): number;
  applyDayProgression(button: Element | null | undefined, day: number | null | undefined): Promise<void>;
  exerciseCard(item: any, logged: any[], prefill: Record<string, unknown>, revealIdx: any, rx: any): string;
  cardioPlanCard(item: any, revealIdx: any, done: any, syncLine: string): string;
  cardioEffortMatches(item: any, effort: any): boolean;
  suggestedPlanDayNumber(session: any, isToday: boolean): Promise<number>;
  upgradeBriefInPlace(date: string, isToday: boolean): Promise<void>;
  setFocus(date: string, on: boolean): void;
  revealPlanThen(after: (() => unknown) | null | undefined, opts?: { blank?: boolean }): void;
  postExerciseMode(name: string, mode: string): Promise<unknown>;
};
type TodayScreenRuntimeDepsApi = {
  create(input: TodayScreenRuntimeDepsInput): ClientTodayDependenciesContext;
};

function createTodayScreenRuntimeDependencies(input: TodayScreenRuntimeDepsInput): ClientTodayDependenciesContext {
  const bridge = input.bridge;
  return CairnTodayDependencies.context({
    root: input.root,
    state: input.state,
    api: input.api,
    cachedApi: input.cachedApi as (path: string, opts?: TodayScreenRuntimeDepsCachedApiOptions<unknown>) => Promise<unknown>,
    peekCached: input.peekCached,
    invalidate: swrInvalidate,
    renderToday: input.renderToday,
    withViewTransition,
    runOp,
    runCountUps,
    reducedMotion,
    collapseEl,
    expandEl,
    activateTab,
    toast,
    localISO,
    escapeHtml: escHtml,
    escapeAttr: escAttr,
    stagger,
    micGlyph: input.micGlyph,
    cardioLabel,
    cardioPrescription,
    isCardioItem,
    cardioPlanCard: input.cardioPlanCard,
    cardioEffortMatches: input.cardioEffortMatches,
    exCard: input.exerciseCard,
    garminSessionCard: (value) => bridge().garminSessionCard(value),
    sessionDoneCard: (session, day, options) => bridge().sessionDoneCard(session, day, options),
    setsTonnage,
    rxMoveCount: input.rxMoveCount,
    exRxLineHtml: input.exRxLineHtml,
    loadTrainingProvenance,
    revealPlanThen: input.revealPlanThen,
    revealSessionComposer: () => bridge().revealSessionComposer(),
    askForSession: (opts) => bridge().askForSession(opts),
    thinkingCaption,
    appendOffPlanCard: (name, mode) => bridge().appendOffPlanCard(name, mode),
    gotoChatWith,
    loadTodayReads,
    todaySkeleton,
    setTodayHeaderTitle,
    nextPollToken: () => ++pollToken,
    isCurrentPoll: (token) => token === pollToken,
    suggestedPlanDayNumber: input.suggestedPlanDayNumber,
    updateHeaderCondense,
    quickLog,
    wireCardioSync,
    applyDayProgression: input.applyDayProgression,
    wireBrief: (read, options) => bridge().wireBrief(read, options),
    upgradeBriefInPlace: input.upgradeBriefInPlace,
    loadTableHint: () => bridge().loadTableHint(),
    setupWeightChip,
    setupVoiceCapture,
    loadFrequentFoods,
    loadContextBanner: () => bridge().loadContextBanner(),
    loadHealthFocusBanner: () => bridge().loadHealthFocusBanner(),
    loadWearable: (isToday) => bridge().loadWearable(isToday),
    loadCheckin,
    loadDraftProposals: () => bridge().loadDraftProposals(),
    setFocus: input.setFocus,
    viewEnter,
    invalidateTodayProgression: () => bridge().invalidateTodayProgression(),
    scheduleRxRefresh: () => bridge().scheduleRxRefresh(),
    startRest,
    stopRest,
    parseDur,
    fmtDur,
    postExerciseMode: input.postExerciseMode,
    wireGuides,
    wireLogRow: (row) => bridge().wireLogRow(row),
    wireSkips: () => bridge().wireSkips(),
  });
}

const CAIRN_TODAY_SCREEN_RUNTIME_DEPS: TodayScreenRuntimeDepsApi = {
  create: createTodayScreenRuntimeDependencies,
};

Object.assign(globalThis, { CairnTodayScreenRuntimeDeps: CAIRN_TODAY_SCREEN_RUNTIME_DEPS });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnTodayScreenRuntimeDeps: CAIRN_TODAY_SCREEN_RUNTIME_DEPS });
}
}
