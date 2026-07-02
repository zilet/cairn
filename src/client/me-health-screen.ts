// ==== 07-me-health.js ====
{
type HealthScreenRecord = Record<string, unknown>;
type HealthStandingRead = import("../contracts/client-api.js").ClientHealthStanding;
type HealthReviewRecord = HealthScreenRecord & { created_at?: string; error?: unknown };

// ---------- Me (segmented: Profile / Memory / Health / Life) ----------
// Standing leads — Me opens to the REVIEW (where you stand + where to focus), not a
// data-entry form. The lab DATA (Health), identity (Profile), life, family and the
// curated Memory follow it: review first, entering/updating second.
const ME_HEALTH_SCREEN = CairnMeHealthScreenComposition.create({
  root: view,
  state,
  document,
  headerTitle,
  api,
  cachedApi,
  peekCached,
  markRefreshing,
  swrInvalidate,
  runOp,
  toast,
  armDelete,
  activateTab: (tab) => activateTab(tab),
  escapeAttr: escAttr,
  escapeHtml: escHtml,
  invalidatePoll: () => { pollToken++; },
  mountSaveBar,
  primaryDiscipline: () => primaryDiscipline,
  segBar,
  segSkeleton,
  setDiscipline,
  setEnduranceGoalSet,
  skeletonSwap: skelSwap,
  wireSeg,
  fitSeg,
  syncRouteFromState: () => typeof syncRouteFromState === "function" ? syncRouteFromState : undefined,
  withViewTransition,
  select: $,
  relTime,
  relAge,
  stagger,
  reducedMotion,
  pollToken: () => pollToken,
  activityEntryHtml: (activity) => actEntryHtml(activity),
  openFoodDetail,
  loadDexaTargeting: () => typeof loadDexaTargeting === "function" ? loadDexaTargeting : undefined,
  loadCoachingFocus: (selector, root) => loadCoachingFocus(selector, root),
  paintHealthMarkersTab: () => paintHealthMarkersTab(),
  paintHealthRecordsTab: () => paintHealthRecordsTab(),
  paintHealthShareTab: () => paintHealthShareTab(),
  paintHealthLearnedTab: () => paintHealthLearnedTab(),
  renderLife: () => renderLife(),
  renderFamily: () => renderFamily(),
  storage: () => typeof localStorage !== "undefined" ? localStorage : null,
});

const ME_SEG = ME_HEALTH_SCREEN.segments;
const ME_HANDLERS = ME_HEALTH_SCREEN.handlers;

function renderMe() {
  return ME_HEALTH_SCREEN.renderMe();
}

// True when the Health → Read depth view is live — the whole-picture loaders
// (picture/synthesis/recovery/directives/markers/supplements) gate on this so a
// late async response never paints into a sibling tab.
function onHealthReadView() {
  return ME_HEALTH_SCREEN.onHealthReadView();
}

// The Standing review — the FIRST thing Me opens to. It leads with the conductor's
// whole-picture "Where to focus" card (the cross-domain lead, tapping through to the
// plan), then the detailed where-you-stand health read below.
async function renderMeStanding() {
  await ME_HEALTH_SCREEN.renderMeStanding();
}

async function renderMeProfile() {
  return ME_HEALTH_SCREEN.renderMeProfile();
}

// tap a note card → full-screen food detail (zooming from its art tile)
function wireNoteCard(el: Element): void {
  ME_HEALTH_SCREEN.wireNoteCard(el);
}

function renderNotes(notes: unknown): void {
  ME_HEALTH_SCREEN.renderNotes(notes);
}

function renderActs(acts: unknown): void {
  ME_HEALTH_SCREEN.renderActs(acts);
}

async function renderMemory() {
  return ME_HEALTH_SCREEN.renderMemory();
}

// ---------- Me: Health — the whole picture (review · markers · records) ----------
function getHealthPictureCache(): ClientHealthPictureCache | null {
  return ME_HEALTH_SCREEN.getHealthPictureCache();
}

function setHealthPictureCache(cache: ClientHealthPictureCache | null): ClientHealthPictureCache | null {
  return ME_HEALTH_SCREEN.setHealthPictureCache(cache);
}

function parsedReview(r: { parsed?: unknown; error?: unknown } | null | undefined): Record<string, unknown> | null {
  return ME_HEALTH_SCREEN.parsedReview(r);
}

function healthDotClass(flag: unknown): string {
  return ME_HEALTH_SCREEN.healthDotClass(flag);
}

function reviewBusyHtml(): string {
  return ME_HEALTH_SCREEN.reviewBusyHtml();
}

function healthHeroHtml(err: unknown): string {
  return ME_HEALTH_SCREEN.healthHeroHtml(err);
}

function buildPictureHtml(err: unknown, docCount: unknown): string {
  return ME_HEALTH_SCREEN.buildPictureHtml(err, docCount);
}

function reviewHtml(review: HealthReviewRecord, stale: unknown, err: unknown): string {
  return ME_HEALTH_SCREEN.reviewHtml(review, stale, err);
}

function paintHealthPicture(): void {
  ME_HEALTH_SCREEN.paintHealthPicture();
}

async function runHealthReview(): Promise<void> {
  await ME_HEALTH_SCREEN.runHealthReview();
}

async function loadHealthPicture(token: number, docsP: Promise<unknown>): Promise<void> {
  await ME_HEALTH_SCREEN.loadHealthPicture(token, docsP);
}

function loadHealthMarkers(token: number): void {
  ME_HEALTH_SCREEN.loadHealthMarkers(token);
}

const HEALTH_SEG = ME_HEALTH_SCREEN.HEALTH_SEG;

// Health is the lab-DATA + whole-picture-read home. Fold every legacy analysis/brain/
// standing key onto Read (where that content now lives) so a returning client never
// lands on a dead inner tab.
function normalizeHealthSeg(seg: unknown): ClientHealthSection {
  return ME_HEALTH_SCREEN.normalizeHealthSeg(seg);
}

// True when we positively know there are zero health documents — from this session's
// last load (cache.docCount) or this device's last visit (persisted). Used to open a
// brand-new user on Records (where they upload) instead of an empty Standing read.
// Returns false when the count is unknown, so we only override on a confident zero.
function healthDocsKnownEmpty(): boolean {
  return ME_HEALTH_SCREEN.healthDocsKnownEmpty();
}

// Health is a one-level inner view: the Me seg picks "Health", then a single inner
// seg picks Read / Markers / Records / Share. Splitting these bounds each view's scroll and
// keeps it focused — and the connected brain now lives on the default Read view, so
// it's reachable in one nav step (Me → Health) instead of buried behind a second seg.
async function renderHealth(): Promise<void> {
  await ME_HEALTH_SCREEN.renderHealth();
}

// Slide the inner seg thumb + flip the active button to `seg` (no repaint).
function setHealthSegActive(seg: ClientHealthSection): void {
  ME_HEALTH_SCREEN.setHealthSegActive(seg);
}

// Programmatic inner-tab switch from a CTA. openPicker keeps the .click() in the
// same user gesture (so the file dialog isn't blocked) — hence no view transition.
function switchHealthSeg(seg: ClientHealthSection, opts: { openPicker?: boolean } = {}): void {
  ME_HEALTH_SCREEN.switchHealthSeg(seg, opts);
}

// Repaint #hContent for the active inner tab. Bumps pollToken so any enrichment
// poll from the tab we're leaving stops cleanly (Records resumes on return).
function paintHealthTab(): void {
  ME_HEALTH_SCREEN.paintHealthTab();
}

// ME → Health → Read: the whole-picture depth that used to balloon the Standing tab.
// A STICKY jump-chip nav heads it (pinned under the Health seg) so you can land on the
// connections, recovery, markers or supplements from anywhere in the long read; below
// it the same id-keyed slots the loaders fill. Single editorial column (no broken
// two-column gutter), capped width on desktop. The targets carry scroll-margin-top so a
// jump lands below the sticky chrome, and a scroll-spy highlights the section you're in.
function paintHealthReadTab(): void {
  ME_HEALTH_SCREEN.paintHealthReadTab();
}

function renderHealthStanding(data: HealthStandingRead | null | undefined): void {
  ME_HEALTH_SCREEN.renderHealthStanding(data);
}

function openBpSheet(): void {
  ME_HEALTH_SCREEN.openBpSheet();
}

function loadHealthStanding(token: number, refAge: unknown): void {
  ME_HEALTH_SCREEN.loadHealthStanding(token, refAge);
}

function paintStandingReview(): void {
  ME_HEALTH_SCREEN.paintStandingReview();
}

function openHealthRead(opts: { scroll?: string } = {}): void {
  ME_HEALTH_SCREEN.openHealthRead(opts);
}

function scrollHealthRailIntoView(sel: string): void {
  ME_HEALTH_SCREEN.scrollHealthRailIntoView(sel);
}

function loadHealthSynthesis(token: number): void {
  ME_HEALTH_SCREEN.loadHealthSynthesis(token);
}

function triggerHealthSynthesis(): void {
  ME_HEALTH_SCREEN.triggerHealthSynthesis();
}

function renderHealthSynthesis(data: unknown, token?: number | null): void {
  ME_HEALTH_SCREEN.renderHealthSynthesis(data, token);
}

async function loadSymptomLinks(token: number): Promise<void> {
  await ME_HEALTH_SCREEN.loadSymptomLinks(token);
}

function loadSupplements(token: number): void {
  ME_HEALTH_SCREEN.loadSupplements(token);
}

function renderSupplements(list: unknown, token?: number | null): void {
  ME_HEALTH_SCREEN.renderSupplements(list, token);
}

async function understandSupplementsFromInput(): Promise<void> {
  await ME_HEALTH_SCREEN.understandSupplementsFromInput();
}

async function removeSupplement(id: number): Promise<void> {
  await ME_HEALTH_SCREEN.removeSupplement(id);
}

function loadRecoverySummary(token: number, sel: string): void {
  ME_HEALTH_SCREEN.loadRecoverySummary(token, sel);
}

function loadPriorityMarkers(token: number): void {
  ME_HEALTH_SCREEN.loadPriorityMarkers(token);
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
  removeSupplement,
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
