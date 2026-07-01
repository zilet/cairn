// ==== 07-me-health.js ====
{
type HealthScreenRecord = Record<string, unknown>;
type HealthStandingRead = import("../contracts/client-api.js").ClientHealthStanding;
type HealthReviewRecord = HealthScreenRecord & { created_at?: string; error?: unknown };

function healthInput(selector: string, root: ParentNode = document): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(selector);
}

function healthInputValue(selector: string, root: ParentNode = document): string {
  return healthInput(selector, root)?.value ?? "";
}

// ---------- Me (segmented: Profile / Memory / Health / Life) ----------
// Standing leads — Me opens to the REVIEW (where you stand + where to focus), not a
// data-entry form. The lab DATA (Health), identity (Profile), life, family and the
// curated Memory follow it: review first, entering/updating second.
const ME_SEG: readonly ClientSegment[] = [["standing", "Standing"], ["profile", "Profile"], ["health", "Health"], ["life", "Life"], ["family", "Family"], ["memory", "Memory"]];
// Lazy handler refs (arrow-wrapped like PROGRESS_HANDLERS/PLAN_HANDLERS): renderLife and
// renderFamily live in a later-loaded module, so bare references would resolve at parse
// time — before that script runs — and throw. Arrows defer resolution to call time, by
// which point every module is loaded. wireSeg/renderMe call handlers with no args.
const ME_HANDLERS: Record<ClientMeSection, () => unknown> = { standing: () => renderMeStanding(), profile: () => renderMeProfile(), memory: () => renderMemory(), health: () => renderHealth(), life: () => renderLife(), family: () => renderFamily() };
function renderMe() {
  headerTitle.textContent = "Me";
  pollToken++; // invalidate in-flight enrichment polls
  if (!state.meSeg) state.meSeg = "standing";
  return (ME_HANDLERS[state.meSeg] || renderMeStanding)();
}

// True when the Health → Read depth view is live — the whole-picture loaders
// (picture/synthesis/recovery/directives/markers/supplements) gate on this so a
// late async response never paints into a sibling tab.
function onHealthReadView() {
  return state.tab === "me" && state.meSeg === "health" && state.healthSeg === "read";
}

// The Standing review — the FIRST thing Me opens to. It leads with the conductor's
// whole-athlete "Where to focus" card (the cross-domain lead, tapping through to the
// plan), then the detailed where-you-stand health read below.
async function renderMeStanding() {
  headerTitle.textContent = "Me";
  state.meSeg = "standing";
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  view.innerHTML = segBar("standing", ME_SEG)
    + `<div class="cfocus-slot cfocus-standing-slot" id="cfocusStandingSlot"></div>`
    + `<div id="hContent"></div>`;
  wireSeg(ME_HANDLERS);
  loadCoachingFocus("#cfocusStandingSlot", view); // the whole-athlete lead → planning
  paintStandingReview(); // the detailed where-you-stand health read
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

function meProfileDeps(): MeProfileControllerDeps {
  return {
    root: view,
    state,
    segments: ME_SEG,
    handlers: ME_HANDLERS as Record<string, () => unknown>,
    headerTitle,
    api,
    activateTab,
    escapeAttr: escAttr,
    escapeHtml: escHtml,
    inputValue: healthInputValue,
    invalidatePoll: () => { pollToken++; },
    mountSaveBar,
    numberValue: healthNumberValue,
    primaryDiscipline: () => primaryDiscipline,
    renderMe,
    renderProfile: () => renderMeProfile(),
    segBar,
    segSkeleton,
    setDiscipline,
    setEnduranceGoalSet,
    skeletonSwap: skelSwap,
    swrInvalidate,
    textAreaValue: healthTextAreaValue,
    toast,
    wireSeg,
    select: $,
  };
}

async function renderMeProfile() {
  return CairnMeProfileController.renderProfile(meProfileDeps());
}

// Pure food-note parsing/rendering lives in food-note-client.js; the food detail
// modal is owned by food-detail-controller.js.
function meHealthLogRenderer(): ClientMeHealthLogRendererApi {
  return (globalThis as typeof globalThis & { CairnMeHealthLogRenderer: ClientMeHealthLogRendererApi }).CairnMeHealthLogRenderer;
}

function meHealthLogDeps(): ClientMeHealthLogRendererDeps {
  return {
    state,
    select: $,
    noteEntryHtml: (note, index) => CairnFoodNote.noteEntryHtml(note, index),
    activityEntryHtml: (activity) => actEntryHtml(activity),
    openFoodDetail,
  };
}

// tap a note card → full-screen food detail (zooming from its art tile)
function wireNoteCard(el: Element): void {
  meHealthLogRenderer().wireNoteCard(el, meHealthLogDeps());
}

function renderNotes(notes: unknown): void {
  meHealthLogRenderer().renderNotes(notes, meHealthLogDeps());
}

function renderActs(acts: unknown): void {
  meHealthLogRenderer().renderActs(acts, meHealthLogDeps());
}

function meMemoryDeps(): ClientMeMemoryControllerDeps {
  return {
    view,
    state,
    segments: ME_SEG,
    handlers: ME_HANDLERS as Record<string, () => unknown>,
    headerTitle,
    api,
    armDelete,
    escapeAttr: escAttr,
    invalidatePoll: () => { pollToken++; },
    segBar,
    toast,
    wireSeg,
  };
}

async function renderMemory() {
  return CairnMeMemoryController.render(meMemoryDeps());
}

// ---------- Me: Health — the whole picture (review · markers · records) ----------
let _hReadSpy: IntersectionObserver | null = null;    // scroll-spy IntersectionObserver for the Read tab's sticky nav

function healthReadDeps(): ClientHealthReadControllerDeps {
  return {
    root: view,
    state,
    api,
    cachedApi,
    peekCached,
    markRefreshing,
    swrInvalidate,
    runOp,
    toast,
    pollToken: () => pollToken,
    select: $,
    escapeAttr: escAttr,
    escapeHtml: escHtml,
    relTime,
    stagger,
    reducedMotion,
    switchHealthSeg,
    isHealthReviewRunning: () => CairnHealthPictureController.isHealthReviewRunning(),
    loadHealthPicture: (token, docsPromise) => loadHealthPicture(token, docsPromise),
    paintHealthPicture,
    setReadSpy: (spy) => { _hReadSpy = spy; },
    teardownReadSpy: () => {
      if (_hReadSpy) {
        _hReadSpy.disconnect();
        _hReadSpy = null;
      }
    },
  };
}

function healthPictureDeps(): ClientHealthPictureControllerDeps {
  return {
    root: view,
    state,
    api,
    toast,
    switchHealthSeg,
    onHealthReadView,
    pollToken: () => pollToken,
    escapeHtml: escHtml,
    storage: typeof localStorage !== "undefined" ? localStorage : null,
  };
}

function getHealthPictureCache(): ClientHealthPictureCache | null {
  return CairnHealthPictureController.getHealthPictureCache();
}

function setHealthPictureCache(cache: ClientHealthPictureCache | null): ClientHealthPictureCache | null {
  return CairnHealthPictureController.setHealthPictureCache(cache);
}

function parsedReview(r: { parsed?: unknown; error?: unknown } | null | undefined): Record<string, unknown> | null {
  return CairnHealthPicture.parsedReview(r);
}

function healthDotClass(flag: unknown): string {
  return CairnHealthPicture.healthDotClass(flag);
}

function reviewBusyHtml(): string {
  return CairnHealthPicture.reviewBusyHtml();
}

function healthHeroHtml(err: unknown): string {
  return CairnHealthPicture.healthHeroHtml(err);
}

function buildPictureHtml(err: unknown, docCount: unknown): string {
  return CairnHealthPicture.buildPictureHtml(err, docCount);
}

function reviewHtml(review: HealthReviewRecord, stale: unknown, err: unknown): string {
  return CairnHealthPicture.reviewHtml(review, stale, err);
}

function paintHealthPicture(): void {
  CairnHealthPictureController.paintHealthPicture(healthPictureDeps());
}

async function runHealthReview(): Promise<void> {
  await CairnHealthPictureController.runHealthReview(healthPictureDeps());
}

async function loadHealthPicture(token: number, docsP: Promise<unknown>): Promise<void> {
  await CairnHealthPictureController.loadHealthPicture(token, docsP, healthPictureDeps());
}

function healthMarkersDeps(): ClientHealthMarkersControllerDeps {
  return {
    root: view,
    cachedApi,
    peekCached,
    markRefreshing,
    pollToken: () => pollToken,
    relAge,
    select: $,
    stagger,
    switchHealthSeg,
    escapeHtml: escHtml,
  };
}

function loadHealthMarkers(token: number): void {
  CairnHealthMarkersController.load(healthMarkersDeps(), token);
}

const HEALTH_SEG = CairnMeHealthTabsController.HEALTH_SEG;

// Health is the lab-DATA + whole-picture-read home. Fold every legacy analysis/brain/
// standing key onto Read (where that content now lives) so a returning client never
// lands on a dead inner tab.
function normalizeHealthSeg(seg: unknown): ClientHealthSection {
  return CairnMeHealthTabsController.normalizeHealthSeg(seg);
}

function meHealthTabsDeps(): ClientMeHealthTabsControllerDeps {
  return {
    root: view,
    state,
    segments: ME_SEG,
    handlers: ME_HANDLERS as Record<string, () => unknown>,
    headerTitle,
    segBar,
    wireSeg,
    fitSeg,
    syncRouteFromState: typeof syncRouteFromState === "function" ? syncRouteFromState : undefined,
    withViewTransition,
    select: $,
    healthDocsKnownEmpty,
    invalidatePoll: () => { pollToken++; },
    paintRead: paintHealthReadTab,
    paintMarkers: paintHealthMarkersTab,
    paintRecords: paintHealthRecordsTab,
    paintShare: paintHealthShareTab,
    paintLearned: paintHealthLearnedTab,
  };
}

// True when we positively know there are zero health documents — from this session's
// last load (cache.docCount) or this device's last visit (persisted). Used to open a
// brand-new user on Records (where they upload) instead of an empty Standing read.
// Returns false when the count is unknown, so we only override on a confident zero.
function healthDocsKnownEmpty(): boolean {
  return CairnHealthPictureController.healthDocsKnownEmpty(healthPictureDeps());
}

// Health is a one-level inner view: the Me seg picks "Health", then a single inner
// seg picks Read / Markers / Records / Share. Splitting these bounds each view's scroll and
// keeps it focused — and the connected brain now lives on the default Read view, so
// it's reachable in one nav step (Me → Health) instead of buried behind a second seg.
async function renderHealth(): Promise<void> {
  await CairnMeHealthTabsController.renderHealth(meHealthTabsDeps());
}

// Slide the inner seg thumb + flip the active button to `seg` (no repaint).
function setHealthSegActive(seg: ClientHealthSection): void {
  CairnMeHealthTabsController.setHealthSegActive(seg, meHealthTabsDeps());
}

// Programmatic inner-tab switch from a CTA. openPicker keeps the .click() in the
// same user gesture (so the file dialog isn't blocked) — hence no view transition.
function switchHealthSeg(seg: ClientHealthSection, opts: { openPicker?: boolean } = {}): void {
  CairnMeHealthTabsController.switchHealthSeg(seg, meHealthTabsDeps(), opts);
}

// Repaint #hContent for the active inner tab. Bumps pollToken so any enrichment
// poll from the tab we're leaving stops cleanly (Records resumes on return).
function paintHealthTab(): void {
  CairnMeHealthTabsController.paintHealthTab(meHealthTabsDeps());
}

// ME → Health → Read: the whole-picture depth that used to balloon the Standing tab.
// A STICKY jump-chip nav heads it (pinned under the Health seg) so you can land on the
// connections, recovery, markers or supplements from anywhere in the long read; below
// it the same id-keyed slots the loaders fill. Single editorial column (no broken
// two-column gutter), capped width on desktop. The targets carry scroll-margin-top so a
// jump lands below the sticky chrome, and a scroll-spy highlights the section you're in.
function paintHealthReadTab(): void {
  CairnHealthReadController.paintTab(healthReadDeps());
}

// ---- Standing tab: percentiles, signal age, and point-in-time BP ----
function healthStandingDeps(): ClientHealthStandingControllerDeps {
  return {
    root: view,
    document,
    state,
    api,
    swrInvalidate,
    toast,
    activateTab,
    pollToken: () => pollToken,
    select: $,
    escapeAttr: escAttr,
    loadDexaTargeting: typeof loadDexaTargeting === "function" ? loadDexaTargeting : undefined,
  };
}

function renderHealthStanding(data: HealthStandingRead | null | undefined): void {
  CairnHealthStandingController.render(data, healthStandingDeps());
}

function openBpSheet(): void {
  CairnHealthStandingController.openBpSheet(healthStandingDeps());
}

function loadHealthStanding(token: number, refAge: unknown): void {
  CairnHealthStandingController.load(healthStandingDeps(), token, refAge);
}

function paintStandingReview(): void {
  CairnHealthStandingController.paintReview(healthStandingDeps());
}

function openHealthRead(opts: { scroll?: string } = {}): void {
  CairnHealthStandingController.openRead(healthStandingDeps(), opts);
}

function scrollHealthRailIntoView(sel: string): void {
  CairnHealthReadController.scrollHealthRailIntoView(healthReadDeps(), sel);
}

function loadHealthSynthesis(token: number): void {
  CairnHealthReadController.loadSynthesis(healthReadDeps(), token);
}

function triggerHealthSynthesis(): void {
  CairnHealthReadController.triggerSynthesis(healthReadDeps());
}

function renderHealthSynthesis(data: unknown, token?: number | null): void {
  CairnHealthReadController.renderSynthesis(data, healthReadDeps(), token);
}

async function loadSymptomLinks(token: number): Promise<void> {
  await CairnHealthReadController.loadSymptomLinks(healthReadDeps(), token);
}

function loadSupplements(token: number): void {
  CairnHealthReadController.loadSupplements(healthReadDeps(), token);
}

function renderSupplements(list: unknown, token?: number | null): void {
  CairnHealthReadController.renderSupplements(list, healthReadDeps(), token);
}

async function understandSupplementsFromInput(): Promise<void> {
  await CairnHealthReadController.understandSupplementsFromInput(healthReadDeps());
}

async function removeSupplement(id: number): Promise<void> {
  await CairnHealthReadController.removeSupplement(id, healthReadDeps());
}

function loadRecoverySummary(token: number, sel: string): void {
  CairnHealthReadController.loadRecoverySummary(healthReadDeps(), token, sel);
}

function loadPriorityMarkers(token: number): void {
  CairnHealthReadController.loadPriorityMarkers(healthReadDeps(), token);
}

// ---- Cross-domain directives, grouped by domain (the review side) ----
// Pure directive grouping and card rendering live in health-client.js.
Object.assign(globalThis, {
  HEALTH_SEG,
  ME_HANDLERS,
  ME_SEG,
  buildPictureHtml,
  getHealthPictureCache,
  healthDotClass,
  healthDocsKnownEmpty,
  healthHeroHtml,
  loadHealthMarkers,
  loadHealthPicture,
  loadHealthStanding,
  loadHealthSynthesis,
  loadPriorityMarkers,
  loadRecoverySummary,
  loadSupplements,
  loadSymptomLinks,
  normalizeHealthSeg,
  onHealthReadView,
  openBpSheet,
  openHealthRead,
  paintHealthPicture,
  paintHealthReadTab,
  paintHealthTab,
  paintStandingReview,
  parsedReview,
  renderActs,
  renderHealth,
  renderHealthStanding,
  renderHealthSynthesis,
  renderMe,
  renderMeProfile,
  renderMeStanding,
  renderMemory,
  renderNotes,
  renderSupplements,
  reviewBusyHtml,
  reviewHtml,
  runHealthReview,
  scrollHealthRailIntoView,
  setHealthSegActive,
  setHealthPictureCache,
  switchHealthSeg,
  triggerHealthSynthesis,
  understandSupplementsFromInput,
  wireNoteCard,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    renderMe,
    renderMemory,
    switchHealthSeg,
    loadHealthMarkers,
    paintHealthPicture,
  });
}
}
