// @ts-check
// Today compatibility bridges: small adapters that preserve legacy globals while
// the focused controllers own the behavior.
{
type TodayCompatibilityBridgesInput = {
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  dependencies(): ClientTodayDependenciesContext;
};

type TodayCompatibilityBriefRead = { _provisional?: boolean } | null | undefined;
type TodayCompatibilityBriefOptions = Parameters<Window["CairnTodayBriefController"]["wireBrief"]>[1];
type TodayCompatibilitySessionSuggestOptions = Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[0];

type TodayCompatibilityBridgesContext = {
  briefDeps(): ClientTodayBriefControllerDeps;
  sessionSuggestDeps(): Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[1];
  sessionDeps(): ClientTodaySessionControllerDeps;
  postExerciseMode(name: string, mode: string): Promise<unknown>;
  reconnectSessionSuggest(job?: unknown): unknown;
  revealSessionComposer(): void;
  askForSession(opts?: TodayCompatibilitySessionSuggestOptions): Promise<void>;
  sessionDoneCard(session: unknown, day: unknown, options: { isToday: boolean }): string;
  wireLogRow(row: Element | null | undefined): void;
  wireSkips(): void;
  wireBrief(read: TodayCompatibilityBriefRead, options: TodayCompatibilityBriefOptions): void;
  reconnectDayReadOverride(job: unknown): unknown;
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
};

function makeTodayCompatibilityBridges(input: TodayCompatibilityBridgesInput): TodayCompatibilityBridgesContext {
  const deps = () => input.dependencies();
  const briefDeps = () => deps().brief();
  const sessionSuggestDeps = () => deps().sessionSuggest();
  const sessionDeps = () => deps().session();
  const progressionDeps = () => deps().progression();
  const addExerciseDeps = () => deps().addExercise();
  const sideLoaderDeps = () => deps().sideLoaders();

  return {
    briefDeps,
    sessionSuggestDeps,
    sessionDeps,

    postExerciseMode(name: string, mode: string) {
      return input.api("/exercises", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mode }),
      });
    },

    reconnectSessionSuggest(job?: unknown) {
      return CairnTodaySessionSuggestController.reconnectSessionSuggest(job, sessionSuggestDeps());
    },

    revealSessionComposer() {
      CairnTodaySessionSuggestController.revealSessionComposer(sessionSuggestDeps());
    },

    async askForSession(opts: TodayCompatibilitySessionSuggestOptions = {}) {
      await CairnTodaySessionSuggestController.askForSession(opts, sessionSuggestDeps());
    },

    sessionDoneCard(session: unknown, day: unknown, { isToday }: { isToday: boolean }) {
      return CairnTodaySessionStatus.sessionDoneCardHtml(
        session as Record<string, unknown> | null | undefined,
        day as { name?: unknown } | null | undefined,
        { isToday },
      );
    },

    wireLogRow(row: Element | null | undefined) {
      CairnTodaySessionController.wireLogRow(row, sessionDeps());
    },

    wireSkips() {
      CairnTodaySessionController.wireSkips(sessionDeps());
    },

    wireBrief(read: TodayCompatibilityBriefRead, options: TodayCompatibilityBriefOptions) {
      CairnTodayBriefController.wireBrief(read as Parameters<Window["CairnTodayBriefController"]["wireBrief"]>[0], options, briefDeps());
    },

    reconnectDayReadOverride(job: unknown) {
      return CairnTodayBriefController.reconnectDayReadOverride(job, briefDeps());
    },

    scheduleRxRefresh() {
      CairnTodayProgressionController.scheduleRxRefresh(progressionDeps());
    },

    invalidateTodayProgression() {
      CairnTodayProgressionController.invalidateTodayProgression(progressionDeps());
    },

    async refreshAdaptedRx() {
      await CairnTodayProgressionController.refreshAdaptedRx(progressionDeps());
    },

    async setupAddExercise() {
      await CairnTodayAddExerciseController.setupAddExercise(addExerciseDeps());
    },

    async appendOffPlanCard(name: any, mode: any) {
      await CairnTodayAddExerciseController.appendOffPlanCard(name, mode, addExerciseDeps());
    },

    garminSessionCard(value: unknown) {
      return CairnTodaySideLoaders.garminSessionCard(value);
    },

    async loadWearable(isToday: unknown) {
      await CairnTodaySideLoaders.loadWearable(isToday, sideLoaderDeps());
    },

    async loadTableHint() {
      await CairnTodaySideLoaders.loadTableHint(sideLoaderDeps());
    },

    async loadContextBanner() {
      await CairnTodaySideLoaders.loadContextBanner(sideLoaderDeps());
    },

    async loadDraftProposals() {
      await CairnTodaySideLoaders.loadDraftProposals(sideLoaderDeps());
    },

    async loadHealthFocusBanner() {
      await CairnTodaySideLoaders.loadHealthFocusBanner(sideLoaderDeps());
    },
  };
}

const CAIRN_TODAY_COMPATIBILITY_BRIDGES = {
  create: makeTodayCompatibilityBridges,
};

Object.assign(globalThis, { CairnTodayCompatibilityBridges: CAIRN_TODAY_COMPATIBILITY_BRIDGES });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnTodayCompatibilityBridges: CAIRN_TODAY_COMPATIBILITY_BRIDGES });
}
}
