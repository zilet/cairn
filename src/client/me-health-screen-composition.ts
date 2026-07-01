// @ts-check
// Me + Health screen composition: section routing, dependency assembly, and
// controller delegation for the classic-script PWA surface.

type ClientMeHealthScreenHealthStandingRead = import("../contracts/client-api.js").ClientHealthStanding;

type ClientMeHealthScreenCompositionInput = Omit<
  ClientMeHealthDependenciesContextInput,
  | "segments"
  | "handlers"
  | "renderMe"
  | "renderProfile"
  | "switchHealthSeg"
  | "onHealthReadView"
  | "loadHealthPicture"
  | "paintHealthPicture"
  | "healthDocsKnownEmpty"
  | "paintRead"
  | "paintMarkers"
  | "paintRecords"
  | "paintShare"
  | "paintLearned"
  | "syncRouteFromState"
  | "loadDexaTargeting"
  | "storage"
> & {
  activityEntryHtml(activity: ClientMeHealthLogActivity): string;
  loadCoachingFocus(selector: string, root: HTMLElement): unknown;
  loadDexaTargeting(): ClientMeHealthDependenciesContext["loadDexaTargeting"];
  paintHealthLearnedTab(): void;
  paintHealthMarkersTab(): void;
  paintHealthRecordsTab(): void;
  paintHealthShareTab(): void;
  renderFamily(): unknown;
  renderLife(): unknown;
  storage(): Pick<Storage, "getItem" | "setItem"> | null;
  syncRouteFromState(): ClientMeHealthDependenciesContext["syncRouteFromState"];
};

type ClientMeHealthScreenComposition = {
  readonly HEALTH_SEG: typeof CairnMeHealthTabsController.HEALTH_SEG;
  readonly handlers: Record<ClientMeSection, () => unknown>;
  readonly segments: readonly ClientSegment[];
  buildPictureHtml(err: unknown, docCount: unknown): string;
  context(): ClientMeHealthDependenciesContext;
  getHealthPictureCache(): ClientHealthPictureCache | null;
  healthDotClass(flag: unknown): string;
  healthDocsKnownEmpty(): boolean;
  healthHeroHtml(err: unknown): string;
  healthMarkersDeps(): ClientHealthMarkersControllerDeps;
  healthPictureDeps(): ClientHealthPictureControllerDeps;
  healthReadDeps(): ClientHealthReadControllerDeps;
  healthStandingDeps(): ClientHealthStandingControllerDeps;
  loadHealthMarkers(token: number): void;
  loadHealthPicture(token: number, docsPromise: Promise<unknown>): Promise<void>;
  loadHealthStanding(token: number, refAge: unknown): void;
  loadHealthSynthesis(token: number): void;
  loadPriorityMarkers(token: number): void;
  loadRecoverySummary(token: number, sel: string): void;
  loadSupplements(token: number): void;
  loadSymptomLinks(token: number): Promise<void>;
  meHealthLogDeps(): ClientMeHealthLogRendererDeps;
  meHealthLogRenderer(): ClientMeHealthLogRendererApi;
  meHealthTabsDeps(): ClientMeHealthTabsControllerDeps;
  meMemoryDeps(): ClientMeMemoryControllerDeps;
  meProfileDeps(): MeProfileControllerDeps;
  normalizeHealthSeg(seg: unknown): ClientHealthSection;
  onHealthReadView(): boolean;
  openBpSheet(): void;
  openHealthRead(opts?: { scroll?: string }): void;
  paintHealthPicture(): void;
  paintHealthReadTab(): void;
  paintHealthTab(): void;
  paintStandingReview(): void;
  parsedReview(r: { parsed?: unknown; error?: unknown } | null | undefined): Record<string, unknown> | null;
  renderActs(acts: unknown): void;
  renderHealth(): Promise<void>;
  renderHealthStanding(data: ClientMeHealthScreenHealthStandingRead | null | undefined): void;
  renderHealthSynthesis(data: unknown, token?: number | null): void;
  renderMe(): unknown;
  renderMeProfile(): Promise<unknown>;
  renderMeStanding(): Promise<void>;
  renderMemory(): Promise<unknown>;
  renderNotes(notes: unknown): void;
  renderSupplements(list: unknown, token?: number | null): void;
  reviewBusyHtml(): string;
  reviewHtml(review: Record<string, unknown> & { created_at?: string; error?: unknown }, stale: unknown, err: unknown): string;
  runHealthReview(): Promise<void>;
  scrollHealthRailIntoView(sel: string): void;
  setHealthPictureCache(cache: ClientHealthPictureCache | null): ClientHealthPictureCache | null;
  setHealthSegActive(seg: ClientHealthSection): void;
  switchHealthSeg(seg: ClientHealthSection, opts?: { openPicker?: boolean }): void;
  triggerHealthSynthesis(): void;
  understandSupplementsFromInput(): Promise<void>;
  removeSupplement(id: number): Promise<void>;
  wireNoteCard(el: Element): void;
};

type ClientMeHealthScreenCompositionApi = {
  create(input: ClientMeHealthScreenCompositionInput): ClientMeHealthScreenComposition;
};

const ME_HEALTH_SCREEN_SEGMENTS: readonly ClientSegment[] = [["standing", "Standing"], ["profile", "Profile"], ["health", "Health"], ["life", "Life"], ["family", "Family"], ["memory", "Memory"]];

function createMeHealthScreenComposition(input: ClientMeHealthScreenCompositionInput): ClientMeHealthScreenComposition {
  const handlers: Record<ClientMeSection, () => unknown> = {
    standing: () => screen.renderMeStanding(),
    profile: () => screen.renderMeProfile(),
    memory: () => screen.renderMemory(),
    health: () => screen.renderHealth(),
    life: () => input.renderLife(),
    family: () => input.renderFamily(),
  };

  function context(): ClientMeHealthDependenciesContext {
    return CairnMeHealthDependencies.context({
      root: input.root,
      state: input.state,
      segments: ME_HEALTH_SCREEN_SEGMENTS,
      handlers,
      document: input.document,
      headerTitle: input.headerTitle,
      api: input.api,
      cachedApi: input.cachedApi,
      peekCached: input.peekCached,
      markRefreshing: input.markRefreshing,
      swrInvalidate: input.swrInvalidate,
      runOp: input.runOp,
      toast: input.toast,
      armDelete: input.armDelete,
      activateTab: input.activateTab,
      escapeAttr: input.escapeAttr,
      escapeHtml: input.escapeHtml,
      invalidatePoll: input.invalidatePoll,
      mountSaveBar: input.mountSaveBar,
      primaryDiscipline: input.primaryDiscipline,
      renderMe: () => screen.renderMe(),
      renderProfile: () => screen.renderMeProfile(),
      segBar: input.segBar,
      segSkeleton: input.segSkeleton,
      setDiscipline: input.setDiscipline,
      setEnduranceGoalSet: input.setEnduranceGoalSet,
      skeletonSwap: input.skeletonSwap,
      wireSeg: input.wireSeg,
      fitSeg: input.fitSeg,
      syncRouteFromState: input.syncRouteFromState(),
      withViewTransition: input.withViewTransition,
      select: input.select,
      relTime: input.relTime,
      relAge: input.relAge,
      stagger: input.stagger,
      reducedMotion: input.reducedMotion,
      pollToken: input.pollToken,
      switchHealthSeg: (seg, opts) => screen.switchHealthSeg(seg, opts),
      onHealthReadView: () => screen.onHealthReadView(),
      loadHealthPicture: (token, docsPromise) => screen.loadHealthPicture(token, docsPromise),
      paintHealthPicture: () => screen.paintHealthPicture(),
      healthDocsKnownEmpty: () => screen.healthDocsKnownEmpty(),
      paintRead: () => screen.paintHealthReadTab(),
      paintMarkers: () => input.paintHealthMarkersTab(),
      paintRecords: () => input.paintHealthRecordsTab(),
      paintShare: () => input.paintHealthShareTab(),
      paintLearned: () => input.paintHealthLearnedTab(),
      activityEntryHtml: input.activityEntryHtml,
      openFoodDetail: input.openFoodDetail,
      loadDexaTargeting: input.loadDexaTargeting(),
      storage: input.storage(),
    });
  }

  function healthReadDeps(): ClientHealthReadControllerDeps {
    return CairnMeHealthDependencies.read(context());
  }

  function healthPictureDeps(): ClientHealthPictureControllerDeps {
    return CairnMeHealthDependencies.picture(context());
  }

  function healthStandingDeps(): ClientHealthStandingControllerDeps {
    return CairnMeHealthDependencies.standing(context());
  }

  const screen: ClientMeHealthScreenComposition = {
    get HEALTH_SEG() {
      return CairnMeHealthTabsController.HEALTH_SEG;
    },
    handlers,
    segments: ME_HEALTH_SCREEN_SEGMENTS,
    buildPictureHtml: (err, docCount) => CairnHealthPicture.buildPictureHtml(err, docCount),
    context,
    getHealthPictureCache: () => CairnHealthPictureController.getHealthPictureCache(),
    healthDotClass: (flag) => CairnHealthPicture.healthDotClass(flag),
    healthDocsKnownEmpty: () => CairnHealthPictureController.healthDocsKnownEmpty(healthPictureDeps()),
    healthHeroHtml: (err) => CairnHealthPicture.healthHeroHtml(err),
    healthMarkersDeps: () => CairnMeHealthDependencies.markers(context()),
    healthPictureDeps,
    healthReadDeps,
    healthStandingDeps,
    loadHealthMarkers: (token) => {
      CairnHealthMarkersController.load(screen.healthMarkersDeps(), token);
    },
    loadHealthPicture: async (token, docsPromise) => {
      await CairnHealthPictureController.loadHealthPicture(token, docsPromise, healthPictureDeps());
    },
    loadHealthStanding: (token, refAge) => {
      CairnHealthStandingController.load(healthStandingDeps(), token, refAge);
    },
    loadHealthSynthesis: (token) => {
      CairnHealthReadController.loadSynthesis(healthReadDeps(), token);
    },
    loadPriorityMarkers: (token) => {
      CairnHealthReadController.loadPriorityMarkers(healthReadDeps(), token);
    },
    loadRecoverySummary: (token, sel) => {
      CairnHealthReadController.loadRecoverySummary(healthReadDeps(), token, sel);
    },
    loadSupplements: (token) => {
      CairnHealthReadController.loadSupplements(healthReadDeps(), token);
    },
    loadSymptomLinks: async (token) => {
      await CairnHealthReadController.loadSymptomLinks(healthReadDeps(), token);
    },
    meHealthLogDeps: () => CairnMeHealthDependencies.log(context()),
    meHealthLogRenderer: () => (globalThis as typeof globalThis & { CairnMeHealthLogRenderer: ClientMeHealthLogRendererApi }).CairnMeHealthLogRenderer,
    meHealthTabsDeps: () => CairnMeHealthDependencies.tabs(context()),
    meMemoryDeps: () => CairnMeHealthDependencies.memory(context()),
    meProfileDeps: () => CairnMeHealthDependencies.profile(context()),
    normalizeHealthSeg: (seg) => CairnMeHealthTabsController.normalizeHealthSeg(seg),
    onHealthReadView: () => input.state.tab === "me" && input.state.meSeg === "health" && input.state.healthSeg === "read",
    openBpSheet: () => {
      CairnHealthStandingController.openBpSheet(healthStandingDeps());
    },
    openHealthRead: (opts = {}) => {
      CairnHealthStandingController.openRead(healthStandingDeps(), opts);
    },
    paintHealthPicture: () => {
      CairnHealthPictureController.paintHealthPicture(healthPictureDeps());
    },
    paintHealthReadTab: () => {
      CairnHealthReadController.paintTab(healthReadDeps());
    },
    paintHealthTab: () => {
      CairnMeHealthTabsController.paintHealthTab(screen.meHealthTabsDeps());
    },
    paintStandingReview: () => {
      CairnHealthStandingController.paintReview(healthStandingDeps());
    },
    parsedReview: (r) => CairnHealthPicture.parsedReview(r),
    renderActs: (acts) => {
      screen.meHealthLogRenderer().renderActs(acts, screen.meHealthLogDeps());
    },
    renderHealth: async () => {
      await CairnMeHealthTabsController.renderHealth(screen.meHealthTabsDeps());
    },
    renderHealthStanding: (data) => {
      CairnHealthStandingController.render(data, healthStandingDeps());
    },
    renderHealthSynthesis: (data, token) => {
      CairnHealthReadController.renderSynthesis(data, healthReadDeps(), token);
    },
    renderMe: () => {
      input.headerTitle.textContent = "Me";
      input.invalidatePoll();
      if (!input.state.meSeg) input.state.meSeg = "standing";
      return (handlers[input.state.meSeg] || screen.renderMeStanding)();
    },
    renderMeProfile: async () => {
      await CairnMeProfileController.renderProfile(screen.meProfileDeps());
    },
    renderMeStanding: async () => {
      input.headerTitle.textContent = "Me";
      input.state.meSeg = "standing";
      input.invalidatePoll();
      input.root.innerHTML = input.segBar("standing", ME_HEALTH_SCREEN_SEGMENTS)
        + `<div class="cfocus-slot cfocus-standing-slot" id="cfocusStandingSlot"></div>`
        + `<div id="hContent"></div>`;
      input.wireSeg(handlers);
      input.loadCoachingFocus("#cfocusStandingSlot", input.root);
      screen.paintStandingReview();
    },
    renderMemory: async () => {
      await CairnMeMemoryController.render(screen.meMemoryDeps());
    },
    renderNotes: (notes) => {
      screen.meHealthLogRenderer().renderNotes(notes, screen.meHealthLogDeps());
    },
    renderSupplements: (list, token) => {
      CairnHealthReadController.renderSupplements(list, healthReadDeps(), token);
    },
    reviewBusyHtml: () => CairnHealthPicture.reviewBusyHtml(),
    reviewHtml: (review, stale, err) => CairnHealthPicture.reviewHtml(review, stale, err),
    runHealthReview: async () => {
      await CairnHealthPictureController.runHealthReview(healthPictureDeps());
    },
    scrollHealthRailIntoView: (sel) => {
      CairnHealthReadController.scrollHealthRailIntoView(healthReadDeps(), sel);
    },
    setHealthPictureCache: (cache) => CairnHealthPictureController.setHealthPictureCache(cache),
    setHealthSegActive: (seg) => {
      CairnMeHealthTabsController.setHealthSegActive(seg, screen.meHealthTabsDeps());
    },
    switchHealthSeg: (seg, opts = {}) => {
      CairnMeHealthTabsController.switchHealthSeg(seg, screen.meHealthTabsDeps(), opts);
    },
    triggerHealthSynthesis: () => {
      CairnHealthReadController.triggerSynthesis(healthReadDeps());
    },
    understandSupplementsFromInput: async () => {
      await CairnHealthReadController.understandSupplementsFromInput(healthReadDeps());
    },
    removeSupplement: async (id) => {
      await CairnHealthReadController.removeSupplement(id, healthReadDeps());
    },
    wireNoteCard: (el) => {
      screen.meHealthLogRenderer().wireNoteCard(el, screen.meHealthLogDeps());
    },
  };

  return screen;
}

const CairnMeHealthScreenComposition: ClientMeHealthScreenCompositionApi = {
  create: createMeHealthScreenComposition,
};

Object.assign(globalThis, { CairnMeHealthScreenComposition });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnMeHealthScreenComposition });
}
