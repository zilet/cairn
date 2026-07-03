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
    sparklineSvg,
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

async function openFoodDetail(note: unknown, fromTile?: Element | null): Promise<void> {
  return CairnFoodDetailController.openFoodDetail(note, fromTile, foodDetailDeps());
}
function gotoChatWith(text: string): void {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  const t = document.querySelector('.tab[data-tab="chat"]');
  if (t) t.classList.add("active");
  state.tab = "chat";
  document.body.dataset.tab = "chat"; // keep the header's Today-scoped styling off
  if (typeof syncRouteFromState === "function") syncRouteFromState();
  Promise.resolve(renderChat()).then(() => {
    const i = $<HTMLTextAreaElement>("#chatInput");
    if (i) { i.value = text; autosizeChatInput(i); i.focus(); }
  });
}

function uiSegmentsApi(): UiSegmentsApi {
  return (globalThis as unknown as { CairnUiSegments: UiSegmentsApi }).CairnUiSegments;
}

function uiSegmentsDeps(): UiSegmentsDeps {
  return {
    root: view,
    state,
    segmentedNavHtml: (options) => CairnUi.segmentedNavHtml(options),
    withViewTransition,
    viewEnter,
    syncRouteFromState: () => { if (typeof syncRouteFromState === "function") return syncRouteFromState(); },
    requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
    addResizeListener: (listener) => window.addEventListener("resize", listener),
    renderTrainOverview: () => renderTrainOverview(),
    renderProgress: () => renderProgress(),
    renderVolume: () => renderVolume(),
    renderEndurance: () => renderEndurance(),
    renderWeight: () => renderWeight(),
    renderMeasurements: () => renderMeasurements(),
    renderCalendar: () => renderCalendar(),
    renderHistory: () => renderHistory(),
    renderProgram: () => renderProgram(),
    renderEnergy: () => renderEnergy(),
    renderPlanEditor: () => renderPlanEditor(),
    renderPlanEndurance: () => renderPlanEndurance(),
    renderFoodJournal: () => renderFoodJournal(),
    renderMeals: () => renderMeals(),
    renderCoach: () => renderCoach(),
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
function fitSeg(seg: Element | null | undefined): void {
  uiSegments().fitSeg(seg);
}
const PROGRESS_SEG: readonly UiSegment[] = uiSegmentsApi().PROGRESS_SEG;
const PROGRESS_HANDLERS: Record<string, () => unknown> = uiSegments().progressHandlers;
function planSeg(): readonly UiSegment[] {
  return uiSegments().planSeg();
}
const PLAN_HANDLERS: Record<string, () => unknown> = uiSegments().planHandlers;

// ---------- view transition utilities ----------
const uiViewTransitions = CairnUiViewTransitions.create({ view, reducedMotion });
function viewEnter(): void { uiViewTransitions.viewEnter(); }
function withViewTransition(fn: () => unknown): Promise<unknown> { return uiViewTransitions.withViewTransition(fn); }
function skelSwap(fn: () => unknown): Promise<unknown> { return uiViewTransitions.skelSwap(fn); }

function setDiscipline(d: unknown): string {
  return uiSegmentsApi().setDiscipline(d);
}
const isEndurance = (): boolean => uiSegmentsApi().isEndurance();
const isHybrid = (): boolean => uiSegmentsApi().isHybrid();
function setEnduranceGoalSet(present: unknown): boolean { return uiSegmentsApi().setEnduranceGoalSet(present); }
const showEnduranceTab = (): boolean => uiSegmentsApi().showEnduranceTab();

// tiny inline sparkline (numbers only — safe for innerHTML)
function sparklineSvg(vals: unknown, w = 132, h = 30): string {
  const v = (Array.isArray(vals) ? vals : []).map(Number).filter((x: number) => !Number.isNaN(x));
  if (v.length < 2) return "";
  const min = Math.min(...v), max = Math.max(...v);
  const x = (i: number) => 2 + (i * (w - 4)) / (v.length - 1);
  const y = (n: number) => max === min ? h / 2 : h - 3 - ((n - min) / (max - min)) * (h - 6);
  const pts = v.map((n: number, i: number) => `${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(" ");
  const last = v[v.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${x(v.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3" fill="currentColor"/>
    </svg>`;
}

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
// Poll GET path/:id every ~1.5s up to ~10 tries. onUpdate(row) runs per fetch while the tab
// is still current; resolves once status leaves the active states (or the cap is hit). Returns the last row.
async function pollEnrichment<T extends UiRecord = UiRecord>(path: string, id: string | number, { tab, token, onUpdate, tries = 10, interval = 1500 }: PollEnrichmentOptions<T> = {}): Promise<T | null> {
  let row: T | null = null;
  for (let i = 0; i < tries; i++) {
    await sleep(interval);
    if (token !== pollToken || state.tab !== tab) return null; // navigated away / re-rendered
    try { row = uiRecord(await api(`${path}/${id}`)) as T; } catch { continue; }
    if (!row || row.error) continue;
    if (token !== pollToken || state.tab !== tab) return null;
    onUpdate && onUpdate(row);
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
  openFoodDetail,
  segBar,
  wireSeg,
  fitSeg,
  PROGRESS_SEG,
  PROGRESS_HANDLERS,
  planSeg,
  PLAN_HANDLERS,
  viewEnter,
  withViewTransition,
  skelSwap,
  setDiscipline,
  isEndurance,
  isHybrid,
  setEnduranceGoalSet,
  showEnduranceTab,
  sparklineSvg,
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
