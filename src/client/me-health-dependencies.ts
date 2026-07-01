// @ts-check
// Me Health dependency factories: keep the screen focused on route/public
// compatibility while this module assembles controller dependencies.

type ClientMeHealthDependenciesContext = {
  root: HTMLElement;
  state: ClientAppState;
  segments: readonly ClientSegment[];
  handlers: Record<string, () => unknown>;
  headerTitle: HTMLElement;
  document: Document;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  cachedApi(path: string, options?: CachedApiOptions<unknown>): Promise<unknown>;
  peekCached<T = unknown>(key: string, freshFor?: number): SwrPeek<T> | null;
  markRefreshing(on: unknown): void;
  swrInvalidate(keyOrPrefix: string): void;
  runOp(kind: string, body: Record<string, unknown>, options?: ClientAgentOpHandlers): Promise<unknown>;
  toast(message: string): void;
  armDelete(btn: Element, onConfirm: () => unknown, options?: { label?: string }): void;
  activateTab(tab: string): unknown;
  escapeAttr(value: unknown): string;
  escapeHtml(value: unknown): string;
  mountSaveBar(options: {
    sentinel: HTMLElement;
    fields: HTMLElement;
    onSave(): Promise<boolean>;
    onDiscard(): unknown;
  }): MeProfileSaveBar;
  primaryDiscipline(): string;
  renderMe(): unknown;
  renderProfile(): unknown;
  segBar(active: string, items: readonly ClientSegment[]): string;
  segSkeleton(active: string, seg: readonly ClientSegment[], cards?: number): string;
  setDiscipline(discipline: unknown): string;
  setEnduranceGoalSet(value: boolean): void;
  skeletonSwap(update: () => unknown): Promise<unknown> | unknown;
  wireSeg(handlers: Record<string, () => unknown>): void;
  fitSeg(el: HTMLElement): void;
  syncRouteFromState?(): void;
  withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
  select<T extends Element = Element>(selector: string): T | null;
  relTime(iso: string): string;
  relAge(iso: string | null | undefined): string;
  stagger(index?: number | null): string;
  reducedMotion(): boolean;
  pollToken(): number;
  invalidatePoll(): void;
  switchHealthSeg(seg: ClientHealthSection, opts?: { openPicker?: boolean }): void;
  onHealthReadView(): boolean;
  loadHealthPicture(token: number, docsPromise: Promise<unknown>): Promise<void>;
  paintHealthPicture(): void;
  healthDocsKnownEmpty(): boolean;
  paintRead(): void;
  paintMarkers(): void;
  paintRecords(): void;
  paintShare(): void;
  paintLearned(): void;
  activityEntryHtml(activity: ClientMeHealthLogActivity): string;
  openFoodDetail(note: unknown, fromTile?: Element | null): unknown;
  loadDexaTargeting?(slotId: string): Promise<void> | void;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
};

type ClientMeHealthDependenciesApi = {
  inputValue(selector: string, root?: ParentNode): string;
  numberValue(selector: string, root?: ParentNode): number | null;
  textAreaValue(selector: string, root?: ParentNode): string;
  profile(ctx: ClientMeHealthDependenciesContext): MeProfileControllerDeps;
  log(ctx: ClientMeHealthDependenciesContext): ClientMeHealthLogRendererDeps;
  memory(ctx: ClientMeHealthDependenciesContext): ClientMeMemoryControllerDeps;
  read(ctx: ClientMeHealthDependenciesContext): ClientHealthReadControllerDeps;
  picture(ctx: ClientMeHealthDependenciesContext): ClientHealthPictureControllerDeps;
  markers(ctx: ClientMeHealthDependenciesContext): ClientHealthMarkersControllerDeps;
  tabs(ctx: ClientMeHealthDependenciesContext): ClientMeHealthTabsControllerDeps;
  standing(ctx: ClientMeHealthDependenciesContext): ClientHealthStandingControllerDeps;
};

function healthInput(selector: string, root: ParentNode = document): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(selector);
}

function healthInputValue(selector: string, root: ParentNode = document): string {
  return healthInput(selector, root)?.value ?? "";
}

function healthNumberValue(selector: string, root: ParentNode = document): number | null {
  const raw = healthInputValue(selector, root);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function healthTextAreaValue(selector: string, root: ParentNode = document): string {
  return root.querySelector<HTMLTextAreaElement>(selector)?.value ?? "";
}

let healthReadSpy: IntersectionObserver | null = null;

function makeMeProfileDeps(ctx: ClientMeHealthDependenciesContext): MeProfileControllerDeps {
  return {
    root: ctx.root,
    state: ctx.state,
    segments: ctx.segments,
    handlers: ctx.handlers,
    headerTitle: ctx.headerTitle,
    api: ctx.api,
    activateTab: ctx.activateTab,
    escapeAttr: ctx.escapeAttr,
    escapeHtml: ctx.escapeHtml,
    inputValue: healthInputValue,
    invalidatePoll: ctx.invalidatePoll,
    mountSaveBar: ctx.mountSaveBar,
    numberValue: healthNumberValue,
    primaryDiscipline: ctx.primaryDiscipline,
    renderMe: ctx.renderMe,
    renderProfile: ctx.renderProfile,
    segBar: ctx.segBar,
    segSkeleton: ctx.segSkeleton,
    setDiscipline: ctx.setDiscipline,
    setEnduranceGoalSet: ctx.setEnduranceGoalSet,
    skeletonSwap: ctx.skeletonSwap,
    swrInvalidate: ctx.swrInvalidate,
    textAreaValue: healthTextAreaValue,
    toast: ctx.toast,
    wireSeg: ctx.wireSeg,
    select: ctx.select,
  };
}

function makeMeHealthLogDeps(ctx: ClientMeHealthDependenciesContext): ClientMeHealthLogRendererDeps {
  return {
    state: ctx.state,
    select: ctx.select,
    noteEntryHtml: (note, index) => CairnFoodNote.noteEntryHtml(note, index),
    activityEntryHtml: ctx.activityEntryHtml,
    openFoodDetail: ctx.openFoodDetail,
  };
}

function makeMeMemoryDeps(ctx: ClientMeHealthDependenciesContext): ClientMeMemoryControllerDeps {
  return {
    view: ctx.root,
    state: ctx.state,
    segments: ctx.segments,
    handlers: ctx.handlers,
    headerTitle: ctx.headerTitle,
    api: ctx.api,
    armDelete: ctx.armDelete,
    escapeAttr: ctx.escapeAttr,
    invalidatePoll: ctx.invalidatePoll,
    segBar: ctx.segBar,
    toast: ctx.toast,
    wireSeg: ctx.wireSeg,
  };
}

function makeHealthReadDeps(ctx: ClientMeHealthDependenciesContext): ClientHealthReadControllerDeps {
  return {
    root: ctx.root,
    state: ctx.state,
    api: ctx.api,
    cachedApi: ctx.cachedApi,
    peekCached: ctx.peekCached,
    markRefreshing: ctx.markRefreshing,
    swrInvalidate: ctx.swrInvalidate,
    runOp: ctx.runOp,
    toast: ctx.toast,
    pollToken: ctx.pollToken,
    select: ctx.select,
    escapeAttr: ctx.escapeAttr,
    escapeHtml: ctx.escapeHtml,
    relTime: ctx.relTime,
    stagger: ctx.stagger,
    reducedMotion: ctx.reducedMotion,
    switchHealthSeg: ctx.switchHealthSeg,
    isHealthReviewRunning: () => CairnHealthPictureController.isHealthReviewRunning(),
    loadHealthPicture: ctx.loadHealthPicture,
    paintHealthPicture: ctx.paintHealthPicture,
    setReadSpy: (spy) => { healthReadSpy = spy; },
    teardownReadSpy: () => {
      if (healthReadSpy) {
        healthReadSpy.disconnect();
        healthReadSpy = null;
      }
    },
  };
}

function makeHealthPictureDeps(ctx: ClientMeHealthDependenciesContext): ClientHealthPictureControllerDeps {
  return {
    root: ctx.root,
    state: ctx.state,
    api: ctx.api,
    toast: ctx.toast,
    switchHealthSeg: ctx.switchHealthSeg,
    onHealthReadView: ctx.onHealthReadView,
    pollToken: ctx.pollToken,
    escapeHtml: ctx.escapeHtml,
    storage: ctx.storage,
  };
}

function makeHealthMarkersDeps(ctx: ClientMeHealthDependenciesContext): ClientHealthMarkersControllerDeps {
  return {
    root: ctx.root,
    cachedApi: ctx.cachedApi,
    peekCached: ctx.peekCached,
    markRefreshing: ctx.markRefreshing,
    pollToken: ctx.pollToken,
    relAge: ctx.relAge,
    select: ctx.select,
    stagger: ctx.stagger,
    switchHealthSeg: ctx.switchHealthSeg,
    escapeHtml: ctx.escapeHtml,
  };
}

function makeMeHealthTabsDeps(ctx: ClientMeHealthDependenciesContext): ClientMeHealthTabsControllerDeps {
  return {
    root: ctx.root,
    state: ctx.state,
    segments: ctx.segments,
    handlers: ctx.handlers,
    headerTitle: ctx.headerTitle,
    segBar: ctx.segBar,
    wireSeg: ctx.wireSeg,
    fitSeg: ctx.fitSeg,
    syncRouteFromState: ctx.syncRouteFromState,
    withViewTransition: ctx.withViewTransition,
    select: ctx.select,
    healthDocsKnownEmpty: ctx.healthDocsKnownEmpty,
    invalidatePoll: ctx.invalidatePoll,
    paintRead: ctx.paintRead,
    paintMarkers: ctx.paintMarkers,
    paintRecords: ctx.paintRecords,
    paintShare: ctx.paintShare,
    paintLearned: ctx.paintLearned,
  };
}

function makeHealthStandingDeps(ctx: ClientMeHealthDependenciesContext): ClientHealthStandingControllerDeps {
  return {
    root: ctx.root,
    document: ctx.document,
    state: ctx.state,
    api: ctx.api,
    swrInvalidate: ctx.swrInvalidate,
    toast: ctx.toast,
    activateTab: ctx.activateTab,
    pollToken: ctx.pollToken,
    select: ctx.select,
    escapeAttr: ctx.escapeAttr,
    loadDexaTargeting: ctx.loadDexaTargeting,
  };
}

const CAIRN_ME_HEALTH_DEPENDENCIES: ClientMeHealthDependenciesApi = {
  inputValue: healthInputValue,
  numberValue: healthNumberValue,
  textAreaValue: healthTextAreaValue,
  profile: makeMeProfileDeps,
  log: makeMeHealthLogDeps,
  memory: makeMeMemoryDeps,
  read: makeHealthReadDeps,
  picture: makeHealthPictureDeps,
  markers: makeHealthMarkersDeps,
  tabs: makeMeHealthTabsDeps,
  standing: makeHealthStandingDeps,
};

Object.assign(globalThis, { CairnMeHealthDependencies: CAIRN_ME_HEALTH_DEPENDENCIES });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnMeHealthDependencies: CAIRN_ME_HEALTH_DEPENDENCIES });
}
