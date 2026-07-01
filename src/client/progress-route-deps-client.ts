// @ts-check
// Shared dependency builders for Progress route controllers.

type ProgressRouteRenderSelf = () => unknown;

type ProgressRouteDepsApi = {
  endurance(renderSelf: ProgressRouteRenderSelf): ClientProgressEnduranceControllerDeps;
  program(renderSelf: ProgressRouteRenderSelf): ClientProgressProgramControllerDeps;
};

function progressRouteNextToken(): number {
  return ++pollToken;
}

function progressRouteIsCurrent(token: number): boolean {
  return token === pollToken;
}

function progressRouteSegmentHtml(active: ClientProgressSection): string {
  return segBar(active, PROGRESS_SEG);
}

function progressRouteSkeletonHtml(active: ClientProgressSection, cards?: number): string {
  return segSkeleton(active, PROGRESS_SEG, cards);
}

function progressRouteWireSegments(): void {
  wireSeg(PROGRESS_HANDLERS);
}

function progressEnduranceRouteDeps(renderSelf: ProgressRouteRenderSelf): ClientProgressEnduranceControllerDeps {
  return {
    view,
    headerTitle,
    state,
    api,
    nextToken: progressRouteNextToken,
    isCurrent: progressRouteIsCurrent,
    segmentHtml: progressRouteSegmentHtml,
    wireSegments: progressRouteWireSegments,
    loading: loadingState,
    empty: emptyStateHtml,
    hero: progressHero,
    art,
    runCountUps,
    renderSelf,
  };
}

function progressProgramRouteDeps(renderSelf: ProgressRouteRenderSelf): ClientProgressProgramControllerDeps {
  return {
    view,
    headerTitle,
    state,
    api,
    runOp,
    nextToken: progressRouteNextToken,
    isCurrent: progressRouteIsCurrent,
    peekCached,
    paintSWR: paintSWR as ClientProgressProgramControllerDeps["paintSWR"],
    segmentHtml: progressRouteSegmentHtml,
    skeletonHtml: progressRouteSkeletonHtml,
    wireSegments: progressRouteWireSegments,
    hero: progressHero,
    empty: emptyStateHtml,
    art,
    busy: btnBusy,
    toast,
    invalidate: swrInvalidate,
    runCountUps,
    renderSelf,
  };
}

const CAIRN_PROGRESS_ROUTE_DEPS: ProgressRouteDepsApi = {
  endurance: progressEnduranceRouteDeps,
  program: progressProgramRouteDeps,
};

Object.assign(globalThis, { CairnProgressRouteDeps: CAIRN_PROGRESS_ROUTE_DEPS });

if (typeof window !== "undefined") {
  window.CairnProgressRouteDeps = CAIRN_PROGRESS_ROUTE_DEPS;
}
