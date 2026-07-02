// @ts-check
// Today screen runtime adapters: typed wrappers around globals and controller
// namespaces so 03-today.js can stay focused on render orchestration.

{
type TodayScreenRuntimeApiResponse<Path extends string> = import("../contracts/client.js").ClientApiResponse<Path>;
type TodayScreenRuntimeCachedApiOptions<T> = { key?: string; freshFor?: number; onUpgrade?: (data: T, meta: { changed: boolean }) => void };
type TodayScreenRuntimeSwrPeek<T> = { data: T; fresh: boolean };
type TodayScreenRuntimeDayRead = import("../contracts/client.js").ClientDayRead & { _provisional?: boolean; override?: string | null };
type TodayScreenRuntimePlanItem = import("../contracts/client.js").ClientPlanItem & {
  fromPlan?: boolean;
  muscle_group?: string | null;
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_zone?: string | null;
};
type TodayScreenRuntimeLoggedSet = import("../contracts/client.js").ClientLoggedSet;
type TodayScreenRuntimeTrainingSession = import("../contracts/client.js").ClientTrainingSession & {
  plan_day_id?: number | null;
  skips?: unknown[];
};
type TodayScreenRuntimeCardioEffort = import("../contracts/client.js").ClientCardioEffort;
type TodayScreenRuntimePrescription = import("../contracts/client.js").ClientPrescription;
type TodayScreenRuntimePrescriptionByExercise = Record<string, TodayScreenRuntimePrescription | null | undefined>;
type TodayScreenRuntimeSessionSuggestOptions = Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[0];
type TodayScreenRuntimeState = ClientAppState & Record<string, unknown> & {
  day: number | null;
  exModes: Record<string, string>;
  logDate: string;
  planJump?: string;
  planReveal?: { date: string; on: boolean; blank?: boolean };
};
type TodayScreenRuntimeInput = {
  state: TodayScreenRuntimeState;
  root: HTMLElement;
  renderToday(): Promise<unknown> | unknown;
};
type TodayScreenRuntimeContext = {
  api<Path extends string>(
    path: Path,
    opts?: RequestInit & { headers?: Record<string, string> },
  ): Promise<TodayScreenRuntimeApiResponse<Path>>;
  cachedApi<Path extends string>(
    path: Path,
    opts?: TodayScreenRuntimeCachedApiOptions<TodayScreenRuntimeApiResponse<Path>>,
  ): Promise<TodayScreenRuntimeApiResponse<Path>>;
  peekCached<T = unknown>(key: string, freshFor?: number): TodayScreenRuntimeSwrPeek<T> | null;
  deps(): ClientTodayDependenciesContext;
  planSurfaceRendererDeps(): ReturnType<ClientTodayDependenciesContext["planSurfaceRenderer"]>;
  mainShellDeps(): ReturnType<ClientTodayDependenciesContext["mainShell"]>;
  briefDeps(): ClientTodayBriefControllerDeps;
  sessionDeps(): ClientTodaySessionControllerDeps;
  postExerciseMode(name: string, mode: string): Promise<unknown>;
  reconnectSessionSuggest(job?: unknown): unknown;
  revealSessionComposer(): void;
  askForSession(opts?: TodayScreenRuntimeSessionSuggestOptions): Promise<void>;
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
  loadDraftProposals(): Promise<void>;
  loadHealthFocusBanner(): Promise<void>;
  exRxLineHtml(rx: TodayScreenRuntimePrescription | null | undefined): string;
  rxMoveCount(rxByEx: TodayScreenRuntimePrescriptionByExercise): number;
  applyDayProgression(button: Element | null | undefined, day: number | null | undefined): Promise<void>;
  exerciseCard(
    item: TodayScreenRuntimePlanItem,
    logged: TodayScreenRuntimeLoggedSet[],
    prefill: Record<string, unknown>,
    revealIdx: number | null | undefined,
    rx: TodayScreenRuntimePrescription | null | undefined,
  ): string;
  cardioPlanCard(
    item: TodayScreenRuntimePlanItem,
    revealIdx: number | null | undefined,
    done: TodayScreenRuntimeCardioEffort | null | undefined,
    syncLine: string,
  ): string;
  cardioEffortMatches(item: TodayScreenRuntimePlanItem, effort: TodayScreenRuntimeCardioEffort | null | undefined): boolean;
  suggestedPlanDayNumber(session: TodayScreenRuntimeTrainingSession | null | undefined, isToday: boolean): Promise<number>;
  loadBrief(date: string, override: string, opts?: { fast?: boolean }): Promise<TodayScreenRuntimeDayRead>;
  upgradeBriefInPlace(date: string, isToday: boolean): Promise<void>;
  reshapeToday(): Promise<void>;
  briefHtml(
    read: (Partial<TodayScreenRuntimeDayRead> & { _provisional?: unknown; override?: unknown }) | null | undefined,
    options: { showPlan?: unknown; hasPlanDay?: unknown; isToday?: unknown },
  ): string;
  briefSignalsText(read: Partial<TodayScreenRuntimeDayRead> | null | undefined): string;
  revealPlanThen(after: (() => unknown) | null | undefined, opts?: { blank?: boolean }): void;
};
type TodayScreenRuntimeApi = {
  micGlyph(): string;
  create(input: TodayScreenRuntimeInput): TodayScreenRuntimeContext;
};

function todayScreenRuntimeApi<Path extends string>(
  path: Path,
  opts?: RequestInit & { headers?: Record<string, string> },
): Promise<TodayScreenRuntimeApiResponse<Path>> {
  return api(path, opts);
}

function todayScreenRuntimeCachedApi<Path extends string>(
  path: Path,
  opts?: TodayScreenRuntimeCachedApiOptions<TodayScreenRuntimeApiResponse<Path>>,
): Promise<TodayScreenRuntimeApiResponse<Path>> {
  return cachedApi(path, opts);
}

function todayScreenRuntimePeekCached<T = unknown>(key: string, freshFor?: number): TodayScreenRuntimeSwrPeek<T> | null {
  return peekCached<T>(key, freshFor);
}

function todayScreenRuntimeMicGlyph(): string {
  const globals = globalThis as unknown as {
    MIC_GLYPH?: unknown;
    CairnCaptureVoice?: { micGlyph?: unknown };
  };
  return String(globals.MIC_GLYPH || globals.CairnCaptureVoice?.micGlyph || "");
}

function createTodayScreenRuntime(input: TodayScreenRuntimeInput): TodayScreenRuntimeContext {
  let depsCache: ClientTodayDependenciesContext | null = null;
  let compatibilityBridge: ReturnType<Window["CairnTodayCompatibilityBridges"]["create"]> | null = null;
  const bridge = () => {
    if (!compatibilityBridge) {
      compatibilityBridge = CairnTodayCompatibilityBridges.create({
        api: todayScreenRuntimeApi,
        dependencies: deps,
      });
    }
    return compatibilityBridge;
  };

  function deps(): ClientTodayDependenciesContext {
    if (!depsCache) {
      depsCache = CairnTodayScreenRuntimeDeps.create({
        root: input.root,
        state: input.state,
        api: todayScreenRuntimeApi,
        cachedApi: todayScreenRuntimeCachedApi,
        peekCached: todayScreenRuntimePeekCached,
        renderToday: input.renderToday,
        micGlyph: todayScreenRuntimeMicGlyph,
        bridge,
        exRxLineHtml,
        rxMoveCount,
        applyDayProgression,
        exerciseCard,
        cardioPlanCard,
        cardioEffortMatches,
        suggestedPlanDayNumber,
        upgradeBriefInPlace,
        postExerciseMode,
        revealPlanThen,
      });
    }
    return depsCache;
  }

  function postExerciseMode(name: string, mode: string) {
    return bridge().postExerciseMode(name, mode);
  }

  function reconnectSessionSuggest(job?: unknown) {
    return bridge().reconnectSessionSuggest(job);
  }

  function reconnectDayReadOverride(job?: unknown) {
    return bridge().reconnectDayReadOverride(job);
  }

  function exRxLineHtml(rx: TodayScreenRuntimePrescription | null | undefined) {
    return CairnTodayTraining.exRxLineHtml(rx);
  }

  function rxMoveCount(rxByEx: TodayScreenRuntimePrescriptionByExercise) {
    return CairnTodayTraining.rxMoveCount(rxByEx);
  }

  async function applyDayProgression(button: Element | null | undefined, day: number | null | undefined) {
    if (day == null) return;
    const restore = btnBusy(button, "Drafting…");
    let response = null;
    try {
      response = await todayScreenRuntimeApi("/program/progression/apply", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ day }),
      });
    } catch { restore(); toast("Couldn't draft that — check your connection."); return; }
    if (!response || response.ok === false) { restore(); toast("Couldn't draft that just now — try again in a bit."); return; }
    swrInvalidate("plan:coach");
    swrInvalidate("plan:proposals");
    toast("Drafted — review it in your Plan");
    input.state.planJump = "coach";
    activateTab("plan");
  }

  function exerciseCard(
    item: TodayScreenRuntimePlanItem,
    logged: TodayScreenRuntimeLoggedSet[],
    prefill: Record<string, unknown>,
    revealIdx: number | null | undefined,
    rx: TodayScreenRuntimePrescription | null | undefined,
  ) {
    return CairnTodayCards.exerciseCardHtml(item, logged, prefill, revealIdx, rx, {
      day: input.state.day,
      exModes: input.state.exModes,
    });
  }

  function cardioPlanCard(
    item: TodayScreenRuntimePlanItem,
    revealIdx: number | null | undefined,
    done: TodayScreenRuntimeCardioEffort | null | undefined,
    syncLine: string,
  ) {
    return CairnTodayCards.cardioPlanCardHtml(item, revealIdx, done as Record<string, unknown> | null | undefined, syncLine);
  }

  function cardioEffortMatches(item: TodayScreenRuntimePlanItem, effort: TodayScreenRuntimeCardioEffort | null | undefined) {
    return CairnTodayCards.cardioEffortMatches(item, effort as Record<string, unknown> | null | undefined);
  }

  function suggestedPlanDayNumber(session: TodayScreenRuntimeTrainingSession | null | undefined, isToday: boolean): Promise<number> {
    return CairnTodayPlanSelection.suggestedPlanDayNumber(session, isToday, {
      state: input.state,
      api: todayScreenRuntimeApi,
    });
  }

  function loadBrief(date: string, override: string, opts: { fast?: boolean } = {}): Promise<TodayScreenRuntimeDayRead> {
    return CairnTodayBriefController.loadBrief(date, override, bridge().briefDeps(), opts) as Promise<TodayScreenRuntimeDayRead>;
  }

  async function upgradeBriefInPlace(date: string, isToday: boolean) {
    await CairnTodayBriefController.upgradeBriefInPlace(date, isToday, bridge().briefDeps());
  }

  async function reshapeToday() {
    await CairnTodayBriefController.reshapeToday(bridge().briefDeps());
  }

  function briefHtml(
    read: (Partial<TodayScreenRuntimeDayRead> & { _provisional?: unknown; override?: unknown }) | null | undefined,
    options: { showPlan?: unknown; hasPlanDay?: unknown; isToday?: unknown },
  ): string {
    return CairnTodayBriefController.briefHtml(read, options, bridge().briefDeps());
  }

  function briefSignalsText(read: Partial<TodayScreenRuntimeDayRead> | null | undefined): string {
    return CairnTodayBriefController.briefSignalsText(read);
  }

  function revealPlanThen(after: (() => unknown) | null | undefined, opts: { blank?: boolean } = {}) {
    if (input.root.querySelector(".addex")) { after && after(); return; }
    input.state.planReveal = { date: input.state.logDate, on: true, blank: !!opts.blank };
    Promise.resolve(input.renderToday()).then(() => { after && after(); });
  }

  return {
    api: todayScreenRuntimeApi,
    cachedApi: todayScreenRuntimeCachedApi,
    peekCached: todayScreenRuntimePeekCached,
    deps,
    planSurfaceRendererDeps: () => deps().planSurfaceRenderer(),
    mainShellDeps: () => deps().mainShell(),
    briefDeps: () => bridge().briefDeps(),
    sessionDeps: () => bridge().sessionDeps(),
    postExerciseMode,
    reconnectSessionSuggest,
    revealSessionComposer: () => bridge().revealSessionComposer(),
    askForSession: (opts) => bridge().askForSession(opts),
    sessionDoneCard: (session, day, options) => bridge().sessionDoneCard(session, day, options),
    wireLogRow: (row) => bridge().wireLogRow(row),
    wireSkips: () => bridge().wireSkips(),
    wireBrief: (read, options) => bridge().wireBrief(read, options),
    reconnectDayReadOverride,
    scheduleRxRefresh: () => bridge().scheduleRxRefresh(),
    invalidateTodayProgression: () => bridge().invalidateTodayProgression(),
    refreshAdaptedRx: () => bridge().refreshAdaptedRx(),
    setupAddExercise: () => bridge().setupAddExercise(),
    appendOffPlanCard: (name, mode) => bridge().appendOffPlanCard(name, mode),
    garminSessionCard: (value) => bridge().garminSessionCard(value),
    loadWearable: (isToday) => bridge().loadWearable(isToday),
    loadTableHint: () => bridge().loadTableHint(),
    loadContextBanner: () => bridge().loadContextBanner(),
    loadDraftProposals: () => bridge().loadDraftProposals(),
    loadHealthFocusBanner: () => bridge().loadHealthFocusBanner(),
    exRxLineHtml,
    rxMoveCount,
    applyDayProgression,
    exerciseCard,
    cardioPlanCard,
    cardioEffortMatches,
    suggestedPlanDayNumber,
    loadBrief,
    upgradeBriefInPlace,
    reshapeToday,
    briefHtml,
    briefSignalsText,
    revealPlanThen,
  };
}

const CAIRN_TODAY_SCREEN_RUNTIME: TodayScreenRuntimeApi = {
  micGlyph: todayScreenRuntimeMicGlyph,
  create: createTodayScreenRuntime,
};

Object.assign(globalThis, { CairnTodayScreenRuntime: CAIRN_TODAY_SCREEN_RUNTIME });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnTodayScreenRuntime: CAIRN_TODAY_SCREEN_RUNTIME });
}
}
