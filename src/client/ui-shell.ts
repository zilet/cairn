// @ts-check
// ==== 02-ui.js ====

function uiRecord(value: unknown): UiRecord {
  return value && typeof value === "object" ? value as UiRecord : {};
}

function uiString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function todayHeaderDeps() {
  return {
    headerTitle,
    state,
    dateLabel,
    escapeHtml: escHtml,
    localISO,
    syncRouteFromState: () => { if (typeof syncRouteFromState === "function") syncRouteFromState(); },
    renderToday: () => renderToday(),
  };
}

function setTodayHeaderTitle() {
  CairnUiHeader.setTodayHeaderTitle(todayHeaderDeps());
}

function updateHeaderCondense() {
  CairnUiHeader.updateHeaderCondense(todayHeaderDeps());
}
CairnUiHeader.installHeaderCondenseScroll(todayHeaderDeps);

function toast(msg: unknown, opts: ToastOptions = {}): void {
  CairnUiActions.toast(msg, opts);
}

function armDelete(btn: Element | null | undefined, onConfirm: () => unknown, { label = "remove?" }: { label?: string } = {}): void {
  CairnUiActions.armDelete(btn, onConfirm, { label });
}

// ---------- detail controllers (exercise + food full-screen overlays) ----------
function exerciseDetailDeps(): ExerciseDetailControllerDeps {
  return {
    root: view,
    state,
    api,
    art,
    artImg,
    closeDetail,
    escapeHtml: escHtml,
    exerciseDetail: CairnExerciseDetail,
    fmtDur,
    fmtWeight,
    gotoChatWith,
    mountDetail,
    openDetailFrom,
    postExerciseMode,
    renderToday,
    runCountUps,
    sparklineSvg: CairnUiChart.sparkSvg,
    toast,
    wireDetailCommon,
  };
}

function wireGuides(scope?: ParentNode | null): void {
  CairnExerciseDetailController.wireGuides(scope, exerciseDetailDeps());
}

function exerciseExplanation(d: ExerciseDetailRow | null | undefined): UiExerciseExplanationPayload {
  return CairnExerciseDetailController.exerciseExplanation(d, exerciseDetailDeps());
}

function exerciseExplanationHtml(d: ExerciseDetailRow | null | undefined, explanation?: UiExerciseExplanationPayload | null): string {
  return CairnExerciseDetailController.exerciseExplanationHtml(d, explanation, exerciseDetailDeps());
}

function replaceExerciseExplanation(el: ParentNode, d: ExerciseDetailRow, explanation: UiExerciseExplanationPayload | null | undefined): void {
  CairnExerciseDetailController.replaceExerciseExplanation(el, d, explanation, exerciseDetailDeps());
}

function foodDetailDeps(): FoodDetailControllerDeps {
  return {
    state,
    api,
    art,
    artEnabled: () => artEnabled,
    artImg,
    closeDetail,
    escapeHtml: escHtml,
    foodNote: CairnFoodNote,
    foodNum,
    formatFoodNum,
    mountDetail,
    openDetailFrom,
    runCountUps,
    toast,
    wireDetailCommon,
    withToken,
  };
}

// The detail sheet (and the meal card it mounts) are the lazy fuel bundle's: a tap on a
// food from Today waits for it only when the idle warm-up has not already fetched it.
async function openFoodDetail(note: unknown, fromTile?: Element | null): Promise<void> {
  return withBundle("fuel", () => CairnFoodDetailController.openFoodDetail(note, fromTile, foodDetailDeps()));
}
function gotoChatWith(text: string): void {
  state.tab = "chat";
  // The shell owns which tab-bar home is lit (chat lives under Ask); it is
  // defined by a later bundle, so it is reached lazily at call time.
  if (typeof highlightHome === "function") highlightHome("chat");
  document.body.dataset.tab = "chat"; // keep the header's Today-scoped styling off
  if (typeof syncRouteFromState === "function") syncRouteFromState();
  // The thread lives in the lazy ask bundle; a cold tap awaits it, and a newer
  // paint of #view in the meantime (the athlete moved on) wins.
  void withLatestRender("ask", () =>
    Promise.resolve(renderChat()).then(() => {
      const i = $<HTMLTextAreaElement>("#chatInput");
      if (i) { i.value = text; autosizeChatInput(i); i.focus(); }
    })
  );
}

// A sub-view reached from inside a home (Fuel from Today, Changes from Ask, the race
// view from Horizon, Health from You) steps back to the home's landing with one
// quiet link, never a seg bar. `home` is a tab-bar home key; activateTab opens its
// landing view, and the shell keeps the home lit.
function homeBackHtml(home: ClientHomeName, label: string): string {
  return `<button class="home-back linkbtn linkbtn-plain" type="button" data-home-back="${escAttr(home)}">‹ ${escHtml(label)}</button>`;
}
function wireHomeBack(root: ParentNode): void {
  root.querySelector<HTMLElement>("[data-home-back]")?.addEventListener("click", (e) => {
    activateTab((e.currentTarget as HTMLElement | null)?.dataset.homeBack || "today");
  });
}

function uiSegmentsApi(): UiSegmentsApi {
  return (globalThis as unknown as { CairnUiSegments: UiSegmentsApi }).CairnUiSegments;
}

function uiSegmentsDeps(): UiSegmentsDeps {
  return {
    root: view,
    state,
    // activateTab is defined by a later bundle (app/tabs.ts); reached at call time.
    activateTab: (name) => activateTab(name),
    segmentedNavHtml: (options) => CairnUi.segmentedNavHtml(options),
    withViewTransition,
    viewEnter,
    syncRouteFromState: () => { if (typeof syncRouteFromState === "function") return syncRouteFromState(); },
    requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
    addResizeListener: (listener) => window.addEventListener("resize", listener),
    // Train's views and the plan editor ride the lazy train bundle, the race view
    // the lazy horizon bundle (app/lazy-bundles.ts, defined by a later bundle and
    // reached at call time). Warm, they call straight through; cold, a segment tap
    // paints only if no newer paint of #view (a tab switch) has claimed it since
    // (withLatestRender, app/render-dispatch.ts).
    renderTrainOverview: () => withLatestRender("train", () => renderTrainOverview()),
    renderProgress: () => withLatestRender("train", () => renderProgress()),
    renderVolume: () => withLatestRender("train", () => renderVolume()),
    renderEndurance: () => withLatestRender("train", () => renderEndurance()),
    renderWeight: () => withLatestRender("train", () => renderWeight()),
    renderMeasurements: () => withLatestRender("train", () => renderMeasurements()),
    renderCalendar: () => withLatestRender("train", () => renderCalendar()),
    renderHistory: () => withLatestRender("train", () => renderHistory()),
    renderProgram: () => withLatestRender("train", () => renderProgram()),
    renderIntake: () => withLatestRender("train", () => renderIntake()),
    renderEnergy: () => withLatestRender("train", () => renderEnergy()),
    renderPlanEditor: () => withLatestRender("train", () => renderPlanEditor()),
    renderPlanEndurance: () => withLatestRender("horizon", () => renderPlanEndurance()),
    renderFoodJournal: () => withLatestRender("fuel", () => renderFoodJournal()),
    renderMeals: () => renderMeals(),
    renderCoach: () => withLatestRender("ask", () => renderCoach()),
  };
}

let _uiSegments: UiSegmentsController | null = null;
function uiSegments(): UiSegmentsController {
  _uiSegments ??= uiSegmentsApi().create(uiSegmentsDeps());
  return _uiSegments;
}

function segBar(active: unknown, items: ReadonlyArray<UiSegment>): string {
  return uiSegments().segBar(active, items);
}
function wireSeg(handlers: Record<string, () => unknown>): void {
  uiSegments().wireSeg(handlers);
}
// About you (Profile, Life, Family, Memory) lives under the You home: its bar is led
// by one quiet step back there. A bar that is not the About-you set passes through.
function aboutYouSegBar(active: unknown, items: ReadonlyArray<UiSegment>): string {
  const aboutYou = items.some(([key]) => key === "profile");
  return (aboutYou ? homeBackHtml("you", "You") : "") + segBar(active, items);
}
function aboutYouWireSeg(handlers: Record<string, () => unknown>): void {
  wireSeg(handlers);
  wireHomeBack(view);
}
function fitSeg(seg: Element | null | undefined): void {
  uiSegments().fitSeg(seg);
}
const PROGRESS_SEG: readonly UiSegment[] = uiSegmentsApi().PROGRESS_SEG;
const PROGRESS_HANDLERS: Record<string, () => unknown> = uiSegments().progressHandlers;
// Train's nav as painted by the plan editor: every Progress leaf navigates there.
const PROGRESS_LINK_HANDLERS: Record<string, () => unknown> = uiSegments().progressLinkHandlers;

// ---------- view transition utilities ----------
const uiViewTransitions = CairnUiViewTransitions.create({ view, reducedMotion });
function viewEnter(): void { uiViewTransitions.viewEnter(); }
function withViewTransition(fn: () => unknown): Promise<unknown> { return uiViewTransitions.withViewTransition(fn); }
function skelSwap(fn: () => unknown): Promise<unknown> { return uiViewTransitions.skelSwap(fn); }
function tabSwap(fn: () => unknown): Promise<unknown> { return uiViewTransitions.tabSwap(fn); }
function viewHydrate(): void { uiViewTransitions.viewHydrate(); }

function setDiscipline(d: unknown): string {
  return uiSegmentsApi().setDiscipline(d);
}
const isEndurance = (): boolean => uiSegmentsApi().isEndurance();
const isHybrid = (): boolean => uiSegmentsApi().isHybrid();
function setEnduranceGoalSet(present: unknown): boolean { return uiSegmentsApi().setEnduranceGoalSet(present); }
const showEnduranceTab = (): boolean => uiSegmentsApi().showEnduranceTab();

// ---------- background enrichment (poll a row until its status settles) ----------
// pollToken is bumped on every full re-render so in-flight polls can detect a stale tab and bail.
let pollToken: number = 0;
function setPollTokenForClassicScripts(value: number): number {
  pollToken = value;
  return pollToken;
}
Object.defineProperty(globalThis, "pollToken", {
  configurable: true,
  get: () => pollToken,
  set: (value) => { pollToken = Number(value) || 0; },
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function enrichmentActive(status: unknown): boolean {
  return status === "pending" || status === "in_progress";
}
// Watch a just-logged row's background enrichment until it settles. SSE-FIRST:
// subscribe to GET path/:id/stream (an EventSource, reached with ?token= via
// withToken since it can't set a header) and forward each transition to onUpdate;
// resolve once status leaves the active states. On ANY EventSource problem
// (unavailable, connect error, auth/transport failure, or a server "not found"
// event) fall back to the unchanged polling loop, so behaviour is never worse than
// before. The stale-tab guard is identical on both paths: once the surface
// re-renders (pollToken bump) or the tab changes, updates stop and it resolves null.
async function pollEnrichment<T extends UiRecord = UiRecord>(path: string, id: string | number, opts: PollEnrichmentOptions<T> = {}): Promise<T | null> {
  const sse = watchEnrichmentSse<T>(path, id, opts);
  return sse ? sse : pollEnrichmentLoop<T>(path, id, opts);
}

// The stale-tab guard shared by both watchers: a re-render bumps pollToken and a
// tab change moves state.tab, so a watcher armed against the old surface stops.
function enrichWatchStale<T extends UiRecord>({ tab, token }: PollEnrichmentOptions<T>): boolean {
  return token !== pollToken || state.tab !== tab;
}

// SSE path. Returns a Promise when EventSource is usable, or null so the caller
// falls straight through to polling (older browsers / no EventSource).
function watchEnrichmentSse<T extends UiRecord = UiRecord>(path: string, id: string | number, opts: PollEnrichmentOptions<T>): Promise<T | null> | null {
  if (typeof EventSource === "undefined") return null;
  let es: EventSource;
  try { es = new EventSource(withToken(`/api${path}/${id}/stream`)); } catch { return null; }
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const finish = (val: T | null) => { if (settled) return; settled = true; try { es.close(); } catch {} resolve(val); };
    // A connect/transport error, or the server's "not found" event, before we've
    // settled → poll instead (never leave the caller hanging on a dead stream).
    const fallback = () => { if (settled) return; settled = true; try { es.close(); } catch {} resolve(pollEnrichmentLoop<T>(path, id, opts)); };
    const onRow = (ev: MessageEvent) => {
      let row: T | null = null;
      try { row = uiRecord(JSON.parse(ev.data).row) as T; } catch { return; }
      if (!row || row.error) return; // wait for the next event / terminal close
      if (enrichWatchStale(opts)) return finish(null); // navigated away / re-rendered
      opts.onUpdate?.(row);
      if (!enrichmentActive(row.enrichment_status)) finish(row);
    };
    es.addEventListener("snapshot", onRow as EventListener);
    es.addEventListener("update", onRow as EventListener);
    es.addEventListener("error", fallback); // a terminal close after finish() is ignored (already settled)
  });
}

// Poll GET path/:id every ~1.5s up to ~10 tries — the fallback when SSE is
// unavailable/failed. onUpdate(row) runs per fetch while the tab is still current;
// resolves once status leaves the active states (or the cap is hit). Returns the last row.
async function pollEnrichmentLoop<T extends UiRecord = UiRecord>(path: string, id: string | number, opts: PollEnrichmentOptions<T> = {}): Promise<T | null> {
  const { tries = 10, interval = 1500 } = opts;
  let row: T | null = null;
  for (let i = 0; i < tries; i++) {
    await sleep(interval);
    if (enrichWatchStale(opts)) return null; // navigated away / re-rendered
    try { row = uiRecord(await api(`${path}/${id}`)) as T; } catch { continue; }
    if (!row || row.error) continue;
    if (enrichWatchStale(opts)) return null;
    opts.onUpdate?.(row);
    if (!enrichmentActive(row.enrichment_status)) return row;
  }
  return row;
}

// Status badge: a quiet spinner ONLY while the coach is still refining a just-logged
// entry. Once it settles there's NO permanent tag — the refined entry itself is the
// result, and the capture toast already confirmed the log at the moment of action.
// (A persistent "✦ noted" used to sit on every entry forever; that was pure noise.)
function enrichBadge(status: unknown): string {
  if (enrichmentActive(status)) return `<span class="enr enr-pending">enriching...</span>`;
  return ""; // done / skipped / failed / undefined -> no lingering tag
}

// One-line description of an activity row from its (possibly refined) fields.
function activityLine(a: UiRecord): string {
  const bits = [
    a.type,
    a.duration_min ? `${a.duration_min} min` : null,
    a.distance_km ? `${a.distance_km} km` : null,
    a.pace || null,
    a.rpe != null ? `RPE ${a.rpe}` : null,
  ].filter(Boolean).join(" · ");
  return bits || uiString(a.raw_text) || uiString(a.notes);
}

const CAIRN_UI_SHELL_GLOBALS = {
  setTodayHeaderTitle,
  updateHeaderCondense,
  toast,
  armDelete,
  wireGuides,
  exerciseExplanation,
  exerciseExplanationHtml,
  replaceExerciseExplanation,
  gotoChatWith,
  homeBackHtml,
  wireHomeBack,
  openFoodDetail,
  segBar,
  wireSeg,
  aboutYouSegBar,
  aboutYouWireSeg,
  fitSeg,
  PROGRESS_SEG,
  PROGRESS_HANDLERS,
  PROGRESS_LINK_HANDLERS,
  viewEnter,
  withViewTransition,
  skelSwap,
  tabSwap,
  viewHydrate,
  setDiscipline,
  isEndurance,
  isHybrid,
  setEnduranceGoalSet,
  showEnduranceTab,
  setPollTokenForClassicScripts,
  enrichmentActive,
  pollEnrichment,
  enrichBadge,
  activityLine,
};

Object.assign(globalThis, CAIRN_UI_SHELL_GLOBALS);

if (typeof window !== "undefined") {
  Object.assign(window, CAIRN_UI_SHELL_GLOBALS);
}
