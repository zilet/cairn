// @ts-check
// Me Health public dependency namespace and input/context helpers.

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
  context(input: ClientMeHealthDependenciesContextInput): ClientMeHealthDependenciesContext;
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

type ClientMeHealthDependenciesContextInput = {
  root: HTMLElement;
  state: ClientAppState;
  segments: readonly ClientSegment[];
  handlers: Record<string, () => unknown>;
  document: Document;
  headerTitle: HTMLElement;
  api: ClientMeHealthDependenciesContext["api"];
  cachedApi: ClientMeHealthDependenciesContext["cachedApi"];
  peekCached: ClientMeHealthDependenciesContext["peekCached"];
  markRefreshing: ClientMeHealthDependenciesContext["markRefreshing"];
  swrInvalidate: ClientMeHealthDependenciesContext["swrInvalidate"];
  runOp: ClientMeHealthDependenciesContext["runOp"];
  toast: ClientMeHealthDependenciesContext["toast"];
  armDelete: ClientMeHealthDependenciesContext["armDelete"];
  activateTab: ClientMeHealthDependenciesContext["activateTab"];
  escapeAttr: ClientMeHealthDependenciesContext["escapeAttr"];
  escapeHtml: ClientMeHealthDependenciesContext["escapeHtml"];
  invalidatePoll: ClientMeHealthDependenciesContext["invalidatePoll"];
  mountSaveBar: ClientMeHealthDependenciesContext["mountSaveBar"];
  primaryDiscipline: ClientMeHealthDependenciesContext["primaryDiscipline"];
  renderMe: ClientMeHealthDependenciesContext["renderMe"];
  renderProfile: ClientMeHealthDependenciesContext["renderProfile"];
  segBar: ClientMeHealthDependenciesContext["segBar"];
  segSkeleton: ClientMeHealthDependenciesContext["segSkeleton"];
  setDiscipline: ClientMeHealthDependenciesContext["setDiscipline"];
  setEnduranceGoalSet: ClientMeHealthDependenciesContext["setEnduranceGoalSet"];
  skeletonSwap: ClientMeHealthDependenciesContext["skeletonSwap"];
  wireSeg: ClientMeHealthDependenciesContext["wireSeg"];
  fitSeg: ClientMeHealthDependenciesContext["fitSeg"];
  syncRouteFromState?: ClientMeHealthDependenciesContext["syncRouteFromState"];
  withViewTransition: ClientMeHealthDependenciesContext["withViewTransition"];
  select: ClientMeHealthDependenciesContext["select"];
  relTime: ClientMeHealthDependenciesContext["relTime"];
  relAge: ClientMeHealthDependenciesContext["relAge"];
  stagger: ClientMeHealthDependenciesContext["stagger"];
  reducedMotion: ClientMeHealthDependenciesContext["reducedMotion"];
  pollToken: ClientMeHealthDependenciesContext["pollToken"];
  switchHealthSeg: ClientMeHealthDependenciesContext["switchHealthSeg"];
  onHealthReadView: ClientMeHealthDependenciesContext["onHealthReadView"];
  loadHealthPicture: ClientMeHealthDependenciesContext["loadHealthPicture"];
  paintHealthPicture: ClientMeHealthDependenciesContext["paintHealthPicture"];
  healthDocsKnownEmpty: ClientMeHealthDependenciesContext["healthDocsKnownEmpty"];
  paintRead: ClientMeHealthDependenciesContext["paintRead"];
  paintMarkers: ClientMeHealthDependenciesContext["paintMarkers"];
  paintRecords: ClientMeHealthDependenciesContext["paintRecords"];
  paintShare: ClientMeHealthDependenciesContext["paintShare"];
  paintLearned: ClientMeHealthDependenciesContext["paintLearned"];
  activityEntryHtml: ClientMeHealthDependenciesContext["activityEntryHtml"];
  openFoodDetail: ClientMeHealthDependenciesContext["openFoodDetail"];
  loadDexaTargeting?: ClientMeHealthDependenciesContext["loadDexaTargeting"];
  storage?: ClientMeHealthDependenciesContext["storage"];
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

function makeMeHealthDependenciesContext(input: ClientMeHealthDependenciesContextInput): ClientMeHealthDependenciesContext {
  return {
    root: input.root,
    state: input.state,
    segments: input.segments,
    handlers: input.handlers,
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
    renderMe: input.renderMe,
    renderProfile: input.renderProfile,
    segBar: input.segBar,
    segSkeleton: input.segSkeleton,
    setDiscipline: input.setDiscipline,
    setEnduranceGoalSet: input.setEnduranceGoalSet,
    skeletonSwap: input.skeletonSwap,
    wireSeg: input.wireSeg,
    fitSeg: input.fitSeg,
    syncRouteFromState: input.syncRouteFromState,
    withViewTransition: input.withViewTransition,
    select: input.select,
    relTime: input.relTime,
    relAge: input.relAge,
    stagger: input.stagger,
    reducedMotion: input.reducedMotion,
    pollToken: input.pollToken,
    switchHealthSeg: input.switchHealthSeg,
    onHealthReadView: input.onHealthReadView,
    loadHealthPicture: input.loadHealthPicture,
    paintHealthPicture: input.paintHealthPicture,
    healthDocsKnownEmpty: input.healthDocsKnownEmpty,
    paintRead: input.paintRead,
    paintMarkers: input.paintMarkers,
    paintRecords: input.paintRecords,
    paintShare: input.paintShare,
    paintLearned: input.paintLearned,
    activityEntryHtml: input.activityEntryHtml,
    openFoodDetail: input.openFoodDetail,
    loadDexaTargeting: input.loadDexaTargeting,
    storage: input.storage,
  };
}

const CAIRN_ME_HEALTH_DEPENDENCIES: ClientMeHealthDependenciesApi = {
  context: makeMeHealthDependenciesContext,
  inputValue: healthInputValue,
  numberValue: healthNumberValue,
  textAreaValue: healthTextAreaValue,
  profile: (ctx) => CairnMeHealthControllerDeps.profile(ctx, {
    inputValue: healthInputValue,
    numberValue: healthNumberValue,
    textAreaValue: healthTextAreaValue,
  }),
  log: (ctx) => CairnMeHealthControllerDeps.log(ctx),
  memory: (ctx) => CairnMeHealthControllerDeps.memory(ctx),
  read: (ctx) => CairnMeHealthControllerDeps.read(ctx),
  picture: (ctx) => CairnMeHealthControllerDeps.picture(ctx),
  markers: (ctx) => CairnMeHealthControllerDeps.markers(ctx),
  tabs: (ctx) => CairnMeHealthControllerDeps.tabs(ctx),
  standing: (ctx) => CairnMeHealthControllerDeps.standing(ctx),
};

Object.assign(globalThis, { CairnMeHealthDependencies: CAIRN_ME_HEALTH_DEPENDENCIES });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnMeHealthDependencies: CAIRN_ME_HEALTH_DEPENDENCIES });
}
