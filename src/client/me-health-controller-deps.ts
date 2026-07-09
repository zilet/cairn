// @ts-check
// Controller-specific Me Health dependency factories.

type ClientMeHealthInputHelpers = {
  inputValue(selector: string, root?: ParentNode): string;
  numberValue(selector: string, root?: ParentNode): number | null;
  textAreaValue(selector: string, root?: ParentNode): string;
};

type ClientMeHealthControllerDepsApi = {
  profile(ctx: ClientMeHealthDependenciesContext, helpers: ClientMeHealthInputHelpers): MeProfileControllerDeps;
  log(ctx: ClientMeHealthDependenciesContext): ClientMeHealthLogRendererDeps;
  memory(ctx: ClientMeHealthDependenciesContext): ClientMeMemoryControllerDeps;
  read(ctx: ClientMeHealthDependenciesContext): ClientHealthReadControllerDeps;
  picture(ctx: ClientMeHealthDependenciesContext): ClientHealthPictureControllerDeps;
  markers(ctx: ClientMeHealthDependenciesContext): ClientHealthMarkersControllerDeps;
  tabs(ctx: ClientMeHealthDependenciesContext): ClientMeHealthTabsControllerDeps;
  standing(ctx: ClientMeHealthDependenciesContext): ClientHealthStandingControllerDeps;
};

let meHealthReadSpy: IntersectionObserver | null = null;

function makeMeProfileDeps(
  ctx: ClientMeHealthDependenciesContext,
  helpers: ClientMeHealthInputHelpers,
): MeProfileControllerDeps {
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
    inputValue: helpers.inputValue,
    invalidatePoll: ctx.invalidatePoll,
    mountSaveBar: ctx.mountSaveBar,
    numberValue: helpers.numberValue,
    primaryDiscipline: ctx.primaryDiscipline,
    renderMe: ctx.renderMe,
    renderProfile: ctx.renderProfile,
    segBar: ctx.segBar,
    segSkeleton: ctx.segSkeleton,
    setDiscipline: ctx.setDiscipline,
    setEnduranceGoalSet: ctx.setEnduranceGoalSet,
    skeletonSwap: ctx.skeletonSwap,
    swrInvalidate: ctx.swrInvalidate,
    textAreaValue: helpers.textAreaValue,
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
    setReadSpy: (spy) => { meHealthReadSpy = spy; },
    teardownReadSpy: () => {
      if (meHealthReadSpy) {
        meHealthReadSpy.disconnect();
        meHealthReadSpy = null;
      }
    },
  };
}

function makeHealthPictureDeps(ctx: ClientMeHealthDependenciesContext): ClientHealthPictureControllerDeps {
  return {
    root: ctx.root,
    state: ctx.state,
    api: ctx.api,
    runOp: ctx.runOp,
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

const CairnMeHealthControllerDeps: ClientMeHealthControllerDepsApi = {
  profile: makeMeProfileDeps,
  log: makeMeHealthLogDeps,
  memory: makeMeMemoryDeps,
  read: makeHealthReadDeps,
  picture: makeHealthPictureDeps,
  markers: makeHealthMarkersDeps,
  tabs: makeMeHealthTabsDeps,
  standing: makeHealthStandingDeps,
};

Object.assign(globalThis, { CairnMeHealthControllerDeps });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnMeHealthControllerDeps });
}
